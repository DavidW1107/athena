// The JSON registry owns intent (what the user asked to exist); Claude Code hooks own
// state (what it is doing right now). list_instances is the join of those two plus tmux.

use std::fs;
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

use crate::tmux::{
    fg_pgid, git_group, is_stopped_pid, pane_map, send_block, sess_name, signal_group, tmux,
    tmux_alive,
};
use crate::util::{argus_dir, home, now};

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct Instance {
    pub id: String,
    pub name: String,
    pub cwd: String,
    pub group: String,
    pub cmd: String,
    #[serde(default)]
    pub session_id: Option<String>,
    #[serde(default)]
    pub created: u64,
}

pub fn reg_path() -> PathBuf {
    argus_dir().join("instances.json")
}

pub fn read_reg() -> Vec<Instance> {
    fs::read_to_string(reg_path())
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

pub fn write_reg(v: &[Instance]) {
    if let Ok(s) = serde_json::to_string_pretty(v) {
        let _ = fs::write(reg_path(), s);
    }
}

// ---------------------------------------------------------------- hook state

#[derive(Serialize, Deserialize, Clone, Default, Debug)]
pub struct HookState {
    #[serde(default)]
    pub session_id: Option<String>,
    #[serde(default)]
    pub state: Option<String>,
    #[serde(default)]
    pub tool: Option<String>,
    #[serde(default)]
    pub summary: Option<String>,
    #[serde(default)]
    pub ts: Option<u64>,
}

pub fn read_state(id: &str) -> HookState {
    fs::read_to_string(argus_dir().join("state").join(format!("{}.json", id)))
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

#[derive(Serialize, Clone, Debug)]
pub struct InstanceView {
    pub id: String,
    pub name: String,
    pub cwd: String,
    pub group: String,
    pub cmd: String,
    pub created: u64,
    pub session_id: Option<String>,
    pub alive: bool,
    pub paused: bool,
    pub state: String,
    pub tool: Option<String>,
    pub summary: Option<String>,
    pub idle_secs: u64,
}

// ---------------------------------------------------------------- commands

#[tauri::command]
pub fn list_instances() -> Vec<InstanceView> {
    let mut reg = read_reg();
    let mut dirty = false;
    let mut out = Vec::new();
    let panes = pane_map();
    for inst in reg.iter_mut() {
        let sess = sess_name(&inst.id);
        let pane = panes.get(&sess).copied();
        let alive = pane.is_some();
        let hs = read_state(&inst.id);
        // The hook is the only place a resume id ever appears; persist it once seen.
        if hs.session_id.is_some() && hs.session_id != inst.session_id {
            inst.session_id = hs.session_id.clone();
            dirty = true;
        }
        let paused = pane.map(is_stopped_pid).unwrap_or(false);
        let state = if !alive {
            "dead".to_string()
        } else if paused {
            "paused".to_string()
        } else {
            hs.state.clone().unwrap_or_else(|| "idle".to_string())
        };
        out.push(InstanceView {
            id: inst.id.clone(),
            name: inst.name.clone(),
            cwd: inst.cwd.clone(),
            group: inst.group.clone(),
            cmd: inst.cmd.clone(),
            created: inst.created,
            session_id: inst.session_id.clone(),
            alive,
            paused,
            state,
            tool: hs.tool.clone(),
            summary: hs.summary.clone(),
            idle_secs: now().saturating_sub(hs.ts.unwrap_or(now())),
        });
    }
    if dirty {
        write_reg(&reg);
    }
    out
}

#[tauri::command]
pub fn launch(cwd: String, cmd: String, name: String) -> Result<InstanceView, String> {
    if !PathBuf::from(&cwd).is_dir() {
        return Err(format!("no such directory: {}", cwd));
    }
    let id = format!("{:x}", SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0) % 0xffff_ffff);
    let sess = sess_name(&id);
    let group = git_group(&cwd);
    let name = if name.trim().is_empty() { group.clone() } else { name };

    let ok = tmux(&[
        "new-session", "-d", "-s", &sess, "-c", &cwd,
        "-e", &format!("ARGUS_ID={}", id),
        "-e", &format!("ARGUS_NAME={}", name),
    ])
    .map(|o| o.status.success())
    .unwrap_or(false);
    if !ok {
        return Err("tmux new-session failed (is tmux installed?)".into());
    }
    tmux(&["send-keys", "-t", &sess, &cmd, "Enter"]);

    let inst = Instance { id, name, cwd, group, cmd, session_id: None, created: now() };
    let mut reg = read_reg();
    reg.push(inst.clone());
    write_reg(&reg);
    Ok(list_instances().into_iter().find(|v| v.id == inst.id).unwrap())
}

/// Bring back an instance whose tmux session died (app closed, laptop rebooted).
/// If a Claude session id was ever captured, resume that conversation rather than start fresh.
#[tauri::command]
pub fn restore(id: String) -> Result<(), String> {
    let reg = read_reg();
    let inst = reg.iter().find(|i| i.id == id).ok_or("unknown instance")?;
    let sess = sess_name(&id);
    if tmux_alive(&sess) {
        return Ok(());
    }
    let ok = tmux(&[
        "new-session", "-d", "-s", &sess, "-c", &inst.cwd,
        "-e", &format!("ARGUS_ID={}", id),
        "-e", &format!("ARGUS_NAME={}", inst.name),
    ])
    .map(|o| o.status.success())
    .unwrap_or(false);
    if !ok {
        return Err("tmux new-session failed".into());
    }
    let line = match (&inst.session_id, inst.cmd.as_str()) {
        (Some(sid), c) if c.starts_with("claude") => format!("claude --resume {}", sid),
        _ => inst.cmd.clone(),
    };
    tmux(&["send-keys", "-t", &sess, &line, "Enter"]);
    Ok(())
}

#[tauri::command]
pub fn close(id: String) -> Result<(), String> {
    tmux(&["kill-session", "-t", &sess_name(&id)]);
    let _ = fs::remove_file(argus_dir().join("state").join(format!("{}.json", id)));
    let reg: Vec<Instance> = read_reg().into_iter().filter(|i| i.id != id).collect();
    write_reg(&reg);
    Ok(())
}

#[tauri::command]
pub fn set_paused(id: String, paused: bool) -> Result<(), String> {
    let sess = sess_name(&id);
    let pgid = fg_pgid(&sess).ok_or("no foreground job in that pane")?;
    if pgid <= 1 {
        return Err("refusing to signal pgid <= 1".into());
    }
    let sig = if paused { "STOP" } else { "CONT" };
    if signal_group(pgid, sig) {
        Ok(())
    } else {
        Err(format!("kill -{} failed", sig))
    }
}

/// Deliver one prompt and submit it. Multi-line text is pasted as a single prompt rather
/// than typed, because `send-keys -l` submits at every newline; tmux::send_block owns that
/// distinction so every caller that sends prose gets the same behaviour.
#[tauri::command]
pub fn send_text(id: String, text: String) -> Result<(), String> {
    let sess = sess_name(&id);
    if !tmux_alive(&sess) {
        return Err("not running".into());
    }
    send_block(&sess, &id, &text)
}

#[tauri::command]
pub fn send_key(id: String, key: String) -> Result<(), String> {
    tmux(&["send-keys", "-t", &sess_name(&id), &key]);
    Ok(())
}

/// Two levels under the GitHub root, which is exactly how the buckets are laid out
/// (clients/, internal/, tools/, demos/, personal/). Keeps the launcher a fuzzy pick.
#[tauri::command]
pub fn list_repos() -> Vec<String> {
    let root = home().join("Documents").join("GitHub");
    let mut out = Vec::new();
    if let Ok(rd) = fs::read_dir(&root) {
        for e in rd.flatten() {
            if !e.path().is_dir() {
                continue;
            }
            out.push(e.path().to_string_lossy().to_string());
            if let Ok(rd2) = fs::read_dir(e.path()) {
                for e2 in rd2.flatten() {
                    if e2.path().is_dir() {
                        out.push(e2.path().to_string_lossy().to_string());
                    }
                }
            }
        }
    }
    out.sort();
    out
}
