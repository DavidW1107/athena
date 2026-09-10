// The JSON registry owns intent (what the user asked to exist); Claude Code hooks own
// state (what it is doing right now). list_instances is the join of those two plus tmux.

use std::fs;
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

use crate::tmux::{
    git_group, is_frozen, pane_map, pane_pid, send_block, sess_name, set_frozen, tmux, tmux_alive,
};
use crate::util::{athena_dir, home, now};

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
    athena_dir().join("instances.json")
}

/// The registry is the only record of user intent, so a damaged file must never be mistaken
/// for an empty fleet: an empty read would let the next write replace the damage with nothing.
/// A file that exists but does not parse is moved aside and reported, and the caller carries on
/// with an empty list only when there genuinely is no registry.
pub fn read_reg() -> Vec<Instance> {
    let path = reg_path();
    let Ok(text) = fs::read_to_string(&path) else { return Vec::new() };
    match serde_json::from_str(&text) {
        Ok(v) => v,
        Err(err) => {
            let aside = path.with_extension(format!("corrupt-{}", now()));
            let _ = fs::rename(&path, &aside);
            eprintln!(
                "athena: {} did not parse ({}); moved to {} so it is not overwritten",
                path.display(),
                err,
                aside.display()
            );
            Vec::new()
        }
    }
}

/// Write through a temporary file and rename over the original. A direct write truncates the
/// live file first, so a crash or a full disk in the middle of it destroys the only copy of what
/// the user asked to exist.
pub fn write_reg(v: &[Instance]) {
    let Ok(s) = serde_json::to_string_pretty(v) else { return };
    let path = reg_path();
    let tmp = path.with_extension(format!("tmp-{}", std::process::id()));
    if fs::write(&tmp, s).is_err() {
        let _ = fs::remove_file(&tmp);
        return;
    }
    if fs::rename(&tmp, &path).is_err() {
        let _ = fs::remove_file(&tmp);
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
    fs::read_to_string(athena_dir().join("state").join(format!("{}.json", id)))
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
        let paused = pane.map(is_frozen).unwrap_or(false);
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

/// Start an instance.
///
/// Which tile this instance joins, in three cases that must stay distinct:
///
/// * `group = Some(g)`: that exact tile. A tile's own + button.
/// * `own_tile = true`: a NEW tile, repo name with a counter if taken. The header's + button.
/// * neither: the repo's tile, shared with anything else from that repo. Imports and resumes.
///
/// The third case used to be folded into the second, which is why two imported sessions from
/// one repo landed in two tiles instead of one.
#[tauri::command]
pub fn launch_in(
    cwd: String,
    cmd: String,
    name: String,
    group: Option<String>,
    own_tile: bool,
) -> Result<InstanceView, String> {
    if !PathBuf::from(&cwd).is_dir() {
        return Err(format!("no such directory: {}", cwd));
    }
    // Canonicalize on the way in. The registry owns directory intent, and every transcript
    // lookup derives Claude's project slug from this exact string, so `.`, a trailing slash or
    // a symlinked spelling would launch fine and then find no history, no usage and no handoff.
    let cwd = fs::canonicalize(&cwd)
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or(cwd);
    let id = format!("{:x}", SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0) % 0xffff_ffff);
    let sess = sess_name(&id);
    let reg_now = read_reg();
    let base = git_group(&cwd);
    let group = match group {
        Some(g) if !g.trim().is_empty() => g,
        _ if own_tile => unique_group(&base, &reg_now),
        _ => base.clone(),
    };
    let name = if name.trim().is_empty() { base.clone() } else { name };

    let ok = tmux(&[
        "new-session", "-d", "-s", &sess, "-c", &cwd,
        "-e", &format!("ATHENA_ID={}", id),
        "-e", &format!("ATHENA_NAME={}", name),
    ])
    .map(|o| o.status.success())
    .unwrap_or(false);
    if !ok {
        return Err("tmux new-session failed (is tmux installed?)".into());
    }
    // The session exists from here on, so a delivery failure is reported with the instance
    // registered rather than thrown away: the user has a tmux session either way and needs the
    // card to reach it.
    let delivered = tmux(&["send-keys", "-t", &sess, &cmd, "Enter"])
        .map(|o| o.status.success())
        .unwrap_or(false);

    let inst = Instance { id, name, cwd, group, cmd, session_id: None, created: now() };
    let mut reg = read_reg();
    reg.push(inst.clone());
    write_reg(&reg);
    let view = list_instances()
        .into_iter()
        .find(|v| v.id == inst.id)
        .ok_or("the instance was launched but could not be written to the registry")?;
    if !delivered {
        return Err(format!(
            "session {} is running but `{}` could not be sent to it; the pane is at a shell",
            sess, inst.cmd
        ));
    }
    Ok(view)
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
        "-e", &format!("ATHENA_ID={}", id),
        "-e", &format!("ATHENA_NAME={}", inst.name),
    ])
    .map(|o| o.status.success())
    .unwrap_or(false);
    if !ok {
        return Err("tmux new-session failed".into());
    }
    // The old hook file describes the process that died. Until the new one writes its first
    // event, that stale record would be read as live state: a restored session showing `working`
    // from the previous run, a false needs-you notification, and an auto-pause decision taken on
    // a state nothing is producing any more.
    let _ = fs::remove_file(athena_dir().join("state").join(format!("{}.json", id)));

    let line = match (&inst.session_id, inst.cmd.as_str()) {
        (Some(sid), c) if c.starts_with("claude") => format!("claude --resume {}", sid),
        _ => inst.cmd.clone(),
    };
    if !tmux(&["send-keys", "-t", &sess, &line, "Enter"]).map(|o| o.status.success()).unwrap_or(false) {
        return Err(format!("the session was recreated but `{}` could not be sent to it", line));
    }
    Ok(())
}

/// Kill the session and forget the instance, in that order, and only if the kill actually
/// happened. Forgetting an instance whose tmux session is still running orphans a live agent:
/// the card disappears while the process keeps holding memory and editing the repository, with
/// no route back to it through Athena.
#[tauri::command]
pub fn close(id: String) -> Result<(), String> {
    let sess = sess_name(&id);
    match tmux(&["kill-session", "-t", &sess]) {
        // tmux is not reachable at all, so nothing was killed and nothing may be forgotten.
        None => return Err("tmux is not on PATH; nothing was closed".into()),
        // A failure here is almost always "session not found", which is the desired end state.
        // Anything else is only a problem if the session is in fact still alive.
        Some(o) if !o.status.success() && tmux_alive(&sess) => {
            let e = String::from_utf8_lossy(&o.stderr).trim().to_string();
            return Err(format!(
                "{} is still running and was not closed: {}",
                sess,
                if e.is_empty() { "tmux refused kill-session".into() } else { e }
            ));
        }
        _ => {}
    }
    let _ = fs::remove_file(athena_dir().join("state").join(format!("{}.json", id)));
    let reg: Vec<Instance> = read_reg().into_iter().filter(|i| i.id != id).collect();
    write_reg(&reg);
    Ok(())
}

#[tauri::command]
pub fn set_paused(id: String, paused: bool) -> Result<(), String> {
    let pane = pane_pid(&sess_name(&id)).ok_or("no live tmux pane")?;
    set_frozen(pane, paused)
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
/// A directory worth offering in the launcher: a real directory, not hidden.
///
/// Hidden directories used to be included, and because "." sorts before every letter,
/// `GitHub/.claude` became the first entry and therefore the launcher's default. Every
/// instance launched without touching the field landed there.
fn offerable(path: &std::path::Path) -> bool {
    if !path.is_dir() {
        return false;
    }
    match path.file_name().and_then(|n| n.to_str()) {
        Some(n) => !n.starts_with('.') && n != "node_modules",
        None => false,
    }
}

#[tauri::command]
pub fn list_repos() -> Vec<String> {
    let root = home().join("Documents").join("GitHub");
    let mut out = Vec::new();
    if let Ok(rd) = fs::read_dir(&root) {
        for e in rd.flatten() {
            if !offerable(&e.path()) {
                continue;
            }
            out.push(e.path().to_string_lossy().to_string());
            if let Ok(rd2) = fs::read_dir(e.path()) {
                for e2 in rd2.flatten() {
                    if offerable(&e2.path()) {
                        out.push(e2.path().to_string_lossy().to_string());
                    }
                }
            }
        }
    }
    out.sort();
    out
}

/// A group name nothing else is using, so a launch that asked for its own tile gets one.
/// Grouping is still derived from the repo; this only disambiguates a second tile for it.
fn unique_group(base: &str, reg: &[Instance]) -> String {
    if !reg.iter().any(|i| i.group == base) {
        return base.to_string();
    }
    for n in 2..1000 {
        let candidate = format!("{} {}", base, n);
        if !reg.iter().any(|i| i.group == candidate) {
            return candidate;
        }
    }
    format!("{} {}", base, now())
}

/// Move an instance into another tile. This is how two tiles that should have been one get
/// merged: grouping is stored per instance, so a merge is a reassignment, not a move of state.
#[tauri::command]
pub fn set_group(id: String, group: String) -> Result<(), String> {
    let group = group.trim().to_string();
    if group.is_empty() {
        return Err("a tile needs a name".into());
    }
    let mut reg = read_reg();
    let inst = reg.iter_mut().find(|i| i.id == id).ok_or("unknown instance")?;
    if inst.group == group {
        return Ok(());
    }
    inst.group = group;
    write_reg(&reg);
    Ok(())
}

/// Scroll the pane's own history.
///
/// A wheel event that reaches the application is not scrollback: Claude Code reads it as "cycle
/// through past messages", which is why scrolling up walked the conversation instead of showing
/// what had scrolled off. tmux copy-mode is the only thing that can show real history while an
/// application is drawing the screen, so the wheel is translated into it. `-e` leaves copy mode
/// on its own once the user reaches the bottom again.
#[tauri::command]
pub fn tmux_scroll(id: String, lines: i32) -> Result<bool, String> {
    let sess = sess_name(&id);
    if !tmux_alive(&sess) {
        return Err("not running".into());
    }
    if lines == 0 {
        return Ok(false);
    }
    let n = lines.unsigned_abs().clamp(1, 200).to_string();
    let verb = if lines > 0 { "scroll-up" } else { "scroll-down" };
    // One tmux invocation, not two. tmux treats a bare ";" argument as a command separator,
    // and every invocation is a process spawn: at trackpad event rates the old two-spawn
    // version was firing hundreds of processes a second, which is what made scrolling lag
    // and land in the wrong place.
    // Reaching the bottom must LEAVE copy mode. A pane in copy mode is frozen: new output from
    // the agent does not appear until the mode ends, so a scroll that finishes at the bottom
    // and stays in copy mode leaves a terminal that looks dead. The `-e` flag only does this
    // for tmux's own mouse handling, not for a synthetic scroll-down, so the exit is explicit.
    // Still one invocation: tmux takes ";" as a command separator and if-shell -F tests a
    // format without spawning a shell.
    let at_bottom = format!("#{{==:#{{scroll_position}},0}}");
    let cancel = format!("send-keys -t {} -X cancel", sess);
    // The chain ends by reporting whether the pane is STILL in copy mode, so the caller knows
    // when the pane went live again without paying for another invocation to ask.
    let out = tmux(&[
        "copy-mode", "-e", "-t", &sess,
        ";",
        "send-keys", "-t", &sess, "-X", "-N", &n, verb,
        ";",
        "if-shell", "-F", "-t", &sess, &at_bottom, &cancel,
        ";",
        "display-message", "-p", "-t", &sess, "#{pane_in_mode}",
    ])
    .ok_or("tmux is not on PATH")?;
    if !out.status.success() {
        let e = String::from_utf8_lossy(&out.stderr).trim().to_string();
        return Err(if e.is_empty() { "tmux refused the scroll".into() } else { e });
    }
    Ok(String::from_utf8_lossy(&out.stdout).trim() == "1")
}

/// Called when the user types after scrolling, so keys reach the agent and not copy mode.
#[tauri::command]
pub fn end_scroll(id: String) -> Result<(), String> {
    crate::tmux::end_copy_mode(&sess_name(&id));
    Ok(())
}
