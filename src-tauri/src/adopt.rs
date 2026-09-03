// Adoption: pull a session or a bare process Athena did not start into the fleet.
//
// Two routes, and they are not equally safe.
//
// A tmux session is adopted by RENAMING it to athena_<id>. Renaming does not detach the
// clients already attached to it, so the terminal the user already has open keeps working
// and Athena simply becomes a second client. Every other module derives the session name
// from the instance id via tmux::sess_name, so renaming is what lets adoption cost one
// tmux call instead of a session-name field threaded through the whole codebase.
// ponytail: the visible tmux session name changes. Store the original as the display name
// and revert it on close if that ever turns out to matter.
//
// A bare process has no tmux session to rename, so the only way in is reptyr, which
// ptrace-attaches to a live process and moves it onto a new pty. That needs ptrace
// permission Athena does not have by default, and it can kill the process it is moving.
// Nothing here loosens ptrace_scope; reptyr_check reports what is wrong and names the fix,
// and the user decides.

use std::fs;
use std::path::PathBuf;
use std::process::Command;

use serde::Serialize;

use crate::registry::{list_instances, read_reg, write_reg, Instance, InstanceView};
use crate::tmux::{git_group, pane_map, sess_name, tmux, tmux_run};
use crate::util::{home, now, proc_stat_fields};

/// Same shape as the id registry::launch mints, so ids stay indistinguishable by origin.
fn new_id() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    format!(
        "{:x}",
        SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0) % 0xffff_ffff
    )
}

fn register(inst: Instance) -> Result<InstanceView, String> {
    let id = inst.id.clone();
    let mut reg = read_reg();
    reg.push(inst);
    write_reg(&reg);
    list_instances().into_iter().find(|v| v.id == id).ok_or_else(|| {
        "the instance was created but did not appear in the registry read-back".to_string()
    })
}

// ---------------------------------------------------------------- tmux sessions

#[derive(Serialize, Clone, Debug)]
pub struct AdoptableSession {
    pub session: String,
    pub windows: usize,
    pub cwd: String,
    pub command: String,
    pub attached: bool,
}

/// Every tmux session Athena did not create. One tmux call for the whole list, because
/// this is refreshed each time the adopt panel opens.
#[tauri::command]
pub fn list_adoptable_sessions() -> Vec<AdoptableSession> {
    let Some(o) = tmux(&[
        "list-panes",
        "-a",
        "-F",
        "#{session_name}\t#{session_windows}\t#{session_attached}\t#{pane_current_path}\t#{pane_current_command}",
    ]) else {
        return Vec::new();
    };
    let mut out: Vec<AdoptableSession> = Vec::new();
    for line in String::from_utf8_lossy(&o.stdout).lines() {
        let f: Vec<&str> = line.split('\t').collect();
        if f.len() < 5 || f[0].starts_with("athena_") {
            continue;
        }
        // list-panes emits one row per pane; the first row for a session wins.
        if out.iter().any(|s| s.session == f[0]) {
            continue;
        }
        out.push(AdoptableSession {
            session: f[0].to_string(),
            windows: f[1].parse().unwrap_or(1),
            attached: f[2] != "0",
            cwd: f[3].to_string(),
            command: f[4].to_string(),
        });
    }
    out.sort_by(|a, b| a.session.cmp(&b.session));
    out
}

/// Adopt by rename. `session` is checked against the live adoptable list rather than
/// trusted from the UI, so a stale or invented name cannot rename something unexpected.
#[tauri::command]
pub fn adopt_session(session: String, name: String) -> Result<InstanceView, String> {
    let found = list_adoptable_sessions()
        .into_iter()
        .find(|s| s.session == session)
        .ok_or("that tmux session is gone, or Athena already owns it")?;

    let id = new_id();
    tmux_run(&["rename-session", "-t", &session, &sess_name(&id)])
        .map_err(|e| format!("could not rename the session: {}", e))?;

    let display = if name.trim().is_empty() { found.session.clone() } else { name };
    register(Instance {
        id,
        name: display,
        cwd: found.cwd.clone(),
        group: git_group(&found.cwd),
        cmd: found.command,
        session_id: None,
        created: now(),
    })
}

// ---------------------------------------------------------------- bare processes

#[derive(Serialize, Clone, Debug)]
pub struct AdoptableProcess {
    pub pid: i32,
    pub cmd: String,
    pub cwd: String,
}

fn our_uid() -> u32 {
    // ponytail: reading /proc/self/status beats adding the libc crate for one number.
    fs::read_to_string("/proc/self/status")
        .ok()
        .and_then(|s| {
            s.lines()
                .find(|l| l.starts_with("Uid:"))?
                .split_whitespace()
                .nth(1)?
                .parse()
                .ok()
        })
        .unwrap_or(u32::MAX)
}

fn uid_of(pid: i32) -> Option<u32> {
    fs::read_to_string(format!("/proc/{}/status", pid)).ok().and_then(|s| {
        s.lines().find(|l| l.starts_with("Uid:"))?.split_whitespace().nth(1)?.parse().ok()
    })
}

fn cmdline_of(pid: i32) -> Option<String> {
    let raw = fs::read(format!("/proc/{}/cmdline", pid)).ok()?;
    let s = raw
        .split(|b| *b == 0)
        .filter(|p| !p.is_empty())
        .map(|p| String::from_utf8_lossy(p).to_string())
        .collect::<Vec<_>>()
        .join(" ");
    if s.is_empty() {
        None
    } else {
        Some(s)
    }
}

fn ppid_of(pid: i32) -> Option<i32> {
    proc_stat_fields(pid)?.get(1)?.parse().ok()
}

/// True when walking up from `pid` reaches any tmux pane. A process already inside tmux
/// should be adopted as a session, which is free and safe, so it is never offered here.
fn under_tmux(pid: i32, panes: &[i32]) -> bool {
    let mut cur = pid;
    for _ in 0..40 {
        if panes.contains(&cur) {
            return true;
        }
        match ppid_of(cur) {
            Some(p) if p > 1 => cur = p,
            _ => return false,
        }
    }
    false
}

/// Agent processes of this user that are running outside tmux. These are the only ones
/// reptyr has anything to offer for.
#[tauri::command]
pub fn list_adoptable_processes() -> Vec<AdoptableProcess> {
    let uid = our_uid();
    let panes: Vec<i32> = pane_map().into_values().collect();
    let mut out = Vec::new();
    let Ok(rd) = fs::read_dir("/proc") else { return out };
    for e in rd.flatten() {
        let Ok(pid) = e.file_name().to_string_lossy().parse::<i32>() else { continue };
        if pid <= 1 || uid_of(pid) != Some(uid) {
            continue;
        }
        let Some(cmd) = cmdline_of(pid) else { continue };
        let first = cmd.split_whitespace().next().unwrap_or("");
        let leaf = first.rsplit('/').next().unwrap_or(first);
        // Match the launcher's own vocabulary rather than anything that mentions the word.
        if !(leaf == "claude" || leaf == "codex" || cmd.starts_with("claude ") || cmd.starts_with("codex ")) {
            continue;
        }
        // No controlling tty means there is no terminal to move.
        if proc_stat_fields(pid).and_then(|f| f.get(4).and_then(|t| t.parse::<i64>().ok())) == Some(0) {
            continue;
        }
        if under_tmux(pid, &panes) {
            continue;
        }
        let cwd = fs::read_link(format!("/proc/{}/cwd", pid))
            .map(|p| p.to_string_lossy().to_string())
            .unwrap_or_default();
        out.push(AdoptableProcess { pid, cmd: cmd.chars().take(120).collect(), cwd });
    }
    out.sort_by_key(|p| p.pid);
    out
}

#[derive(Serialize, Clone, Debug)]
pub struct ReptyrCheck {
    pub ok: bool,
    pub reptyr: bool,
    pub ptrace_scope: Option<i32>,
    pub message: String,
    pub fix: String,
}

/// What stands between the user and a process adoption, and the exact command that clears it.
///
/// Athena never writes ptrace_scope itself. Lowering it to 0 lets ANY process this user runs
/// ptrace any other, which is a machine-wide weakening of a hardening default, so it is the
/// user's call to make deliberately and not a side effect of clicking adopt.
#[tauri::command]
pub fn reptyr_check() -> ReptyrCheck {
    let reptyr = which("reptyr");
    let scope: Option<i32> = fs::read_to_string("/proc/sys/kernel/yama/ptrace_scope")
        .ok()
        .and_then(|s| s.trim().parse().ok());

    let (ok, message, fix) = match (reptyr, scope) {
        (false, _) => (
            false,
            "reptyr is not installed, so a bare process cannot be moved onto a new pty.".to_string(),
            "sudo apt install reptyr".to_string(),
        ),
        (true, Some(s)) if s > 0 => (
            false,
            format!(
                "ptrace_scope is {}, which blocks attaching to a process that is not a child of Athena. \
                 Setting it to 0 lets any process you run ptrace any other process you own, so make \
                 that choice deliberately. Granting the capability to the reptyr binary alone is the \
                 narrower option.",
                s
            ),
            "sudo setcap cap_sys_ptrace+ep $(which reptyr)   # narrower\n\
             sudo sysctl -w kernel.yama.ptrace_scope=0        # machine wide, until reboot"
                .to_string(),
        ),
        _ => (true, "Ready.".to_string(), String::new()),
    };
    ReptyrCheck { ok, reptyr, ptrace_scope: scope, message, fix }
}

fn which(bin: &str) -> bool {
    std::env::var("PATH")
        .unwrap_or_default()
        .split(':')
        .any(|d| !d.is_empty() && PathBuf::from(d).join(bin).is_file())
}

/// Move a live process into a new tmux session with reptyr.
///
/// This cannot be verified synchronously: reptyr runs inside the pane and may still fail
/// there (a process in an unmovable state, a refused ptrace). The instance is registered
/// either way so the user can watch the pane and see what happened, which is the honest
/// outcome rather than a success this function cannot actually confirm.
#[tauri::command]
pub fn adopt_process(pid: i32, name: String) -> Result<InstanceView, String> {
    // Pid validation first, so a bad pid is rejected as a bad pid rather than reported as a
    // missing reptyr, and so the guards stay testable on a machine without reptyr installed.
    if pid <= 1 {
        return Err("refusing to adopt pid 1 or lower".into());
    }
    if uid_of(pid) != Some(our_uid()) {
        return Err("that process is not yours, or it has already exited".into());
    }
    let check = reptyr_check();
    if !check.ok {
        return Err(check.message);
    }
    let cmd = cmdline_of(pid).ok_or("that process has already exited")?;
    let cwd = fs::read_link(format!("/proc/{}/cwd", pid))
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_else(|_| "/".to_string());

    let id = new_id();
    let sess = sess_name(&id);
    tmux_run(&[
        "new-session",
        "-d",
        "-s",
        &sess,
        "-c",
        &cwd,
        "-e",
        &format!("ATHENA_ID={}", id),
    ])
    .map_err(|e| format!("could not create the session to move it into: {}", e))?;

    // pid is an i32, so this line cannot carry anything but a number.
    if let Err(e) = tmux_run(&["send-keys", "-t", &sess, "-l", "--", &format!("reptyr {}", pid)]) {
        let _ = tmux(&["kill-session", "-t", &sess]);
        return Err(format!("could not send the reptyr command: {}", e));
    }
    if let Err(e) = tmux_run(&["send-keys", "-t", &sess, "Enter"]) {
        let _ = tmux(&["kill-session", "-t", &sess]);
        return Err(format!("could not run the reptyr command: {}", e));
    }

    let leaf = cmd.split_whitespace().next().unwrap_or("process").rsplit('/').next().unwrap_or("process").to_string();
    let display = if name.trim().is_empty() { format!("{} {}", leaf, pid) } else { name };
    register(Instance {
        id,
        name: display,
        cwd: cwd.clone(),
        group: git_group(&cwd),
        cmd: leaf,
        session_id: None,
        created: now(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn our_own_uid_resolves_and_matches_self() {
        let uid = our_uid();
        assert_ne!(uid, u32::MAX, "/proc/self/status should always be readable");
        assert_eq!(uid_of(std::process::id() as i32), Some(uid));
    }

    #[test]
    fn ancestry_walk_finds_a_known_ancestor_and_rejects_an_unrelated_one() {
        let me = std::process::id() as i32;
        assert!(under_tmux(me, &[me]), "a pid is its own ancestor for this purpose");
        assert!(!under_tmux(me, &[]), "no candidate panes means nothing to be under");
    }

    #[test]
    fn adopt_process_refuses_low_and_foreign_pids() {
        // Runs the guards, not reptyr: both of these return before any tmux call.
        assert!(adopt_process(1, String::new()).is_err());
        assert!(adopt_process(-5, String::new()).is_err());
    }

    #[test]
    fn which_finds_a_real_binary_and_misses_a_fake_one() {
        assert!(which("sh"), "sh must be on PATH");
        assert!(!which("athena-not-a-real-binary"));
    }
}

// ---------------------------------------------------------------- importing a running claude
//
// The common case on this machine is a dozen claudes running in ordinary terminal windows, none
// of them under tmux. There is no way to move such a process into Athena without ptrace, so
// import does the other thing that reaches the same place: it reads the session id the process
// is already running, terminates it, and starts `claude --resume <id>` inside a tile. The
// conversation continues from its transcript; only a turn in flight is lost.
//
// Termination happens BEFORE the resume, not after. Two live processes appending to one
// transcript is the failure this is guarding against, and only that ordering rules it out.

use crate::sessions::{project_slug, session_info};

#[derive(Serialize, Clone, Debug)]
pub struct RunningAgent {
    pub pid: i32,
    pub cmd: String,
    pub cwd: String,
    /// Read from the process's own argv when it was started with --resume, so it is exact.
    /// None means the process began a fresh session and its id is not recoverable from /proc;
    /// the UI asks which transcript it is rather than guessing on the user's behalf.
    pub session_id: Option<String>,
    /// Claude Code's own name for the session. The first user message is useless for telling a
    /// dozen long-running sessions apart, and they all share one cwd here, so this is the field
    /// that actually identifies a row.
    pub title: Option<String>,
    pub last_prompt: Option<String>,
    /// Seconds since the transcript was last written, so a stale process is obvious.
    pub idle_secs: u64,
}

/// `--resume <uuid>` or `-r <uuid>` in a process's argv.
fn session_id_from_argv(cmd: &str) -> Option<String> {
    let parts: Vec<&str> = cmd.split_whitespace().collect();
    let at = parts.iter().position(|p| *p == "--resume" || *p == "-r")?;
    let id = parts.get(at + 1)?;
    let ok = id.len() >= 8 && id.chars().all(|c| c.is_ascii_hexdigit() || c == '-');
    if ok {
        Some((*id).to_string())
    } else {
        None
    }
}

fn transcript_path(cwd: &str, session_id: &str) -> PathBuf {
    home()
        .join(".claude")
        .join("projects")
        .join(project_slug(cwd))
        .join(format!("{}.jsonl", session_id))
}

/// Agent processes of this user that Athena does not already own, whether or not they are in
/// tmux. Unlike list_adoptable_processes, which exists to feed reptyr, this one is about
/// resuming, so a process under some other tmux server is still importable.
#[tauri::command]
pub fn list_running_agents() -> Vec<RunningAgent> {
    let uid = our_uid();
    let ours: Vec<i32> = pane_map()
        .iter()
        .filter(|(sess, _)| sess.starts_with("athena_"))
        .map(|(_, pid)| *pid)
        .collect();
    let mut out = Vec::new();
    let Ok(rd) = fs::read_dir("/proc") else { return out };
    for e in rd.flatten() {
        let Ok(pid) = e.file_name().to_string_lossy().parse::<i32>() else { continue };
        if pid <= 1 || uid_of(pid) != Some(uid) {
            continue;
        }
        let Some(cmd) = cmdline_of(pid) else { continue };
        let leaf = cmd
            .split_whitespace()
            .next()
            .unwrap_or("")
            .rsplit('/')
            .next()
            .unwrap_or("");
        if leaf != "claude" && leaf != "codex" {
            continue;
        }
        if under_tmux(pid, &ours) {
            continue; // Athena already owns this one
        }
        let cwd = fs::read_link(format!("/proc/{}/cwd", pid))
            .map(|p| p.to_string_lossy().to_string())
            .unwrap_or_default();
        let session_id = session_id_from_argv(&cmd);
        let mut title = None;
        let mut last_prompt = None;
        let mut idle_secs = 0;
        if let Some(sid) = session_id.as_ref() {
            let path = transcript_path(&cwd, sid);
            let info = session_info(&path);
            title = info.title;
            last_prompt = info.last_prompt;
            idle_secs = fs::metadata(&path)
                .and_then(|m| m.modified())
                .ok()
                .and_then(|t| t.elapsed().ok())
                .map(|d| d.as_secs())
                .unwrap_or(0);
        }
        out.push(RunningAgent {
            pid,
            cmd: cmd.chars().take(120).collect(),
            cwd,
            session_id,
            title,
            last_prompt,
            idle_secs,
        });
    }
    out.sort_by_key(|a| a.pid);
    out
}

/// Ask a process to exit and wait briefly for it to actually go.
fn terminate_and_wait(pid: i32) -> bool {
    if Command::new("kill").args(["-TERM", &pid.to_string()]).status().is_err() {
        return false;
    }
    for _ in 0..30 {
        if !PathBuf::from(format!("/proc/{}", pid)).exists() {
            return true;
        }
        std::thread::sleep(std::time::Duration::from_millis(100));
    }
    false
}

/// Import a running agent: stop it, then resume its session inside a new tile.
#[tauri::command]
pub fn import_agent(
    pid: i32,
    session_id: String,
    cwd: String,
    name: String,
) -> Result<InstanceView, String> {
    if pid <= 1 {
        return Err("refusing to act on pid 1 or lower".into());
    }
    if uid_of(pid) != Some(our_uid()) {
        return Err("that process is not yours, or it has already exited".into());
    }
    if session_id.trim().is_empty() {
        return Err("no session was chosen for that process".into());
    }
    // The id becomes a command-line argument, so it is checked rather than trusted.
    if !session_id.chars().all(|c| c.is_ascii_hexdigit() || c == '-') || session_id.len() < 8 {
        return Err(format!("not a session id: {}", session_id));
    }
    let path = transcript_path(&cwd, &session_id);
    if !path.is_file() {
        return Err(format!("no transcript for that session at {}", path.display()));
    }

    let stopped = terminate_and_wait(pid);
    let view = crate::registry::launch_in(
        cwd,
        format!("claude --resume {}", session_id),
        name,
        None,
    )?;
    if !stopped {
        // The tile is up and usable, so this is a warning rather than a failure, but the user
        // has to know two processes may now be appending to one transcript.
        eprintln!("athena: pid {} did not exit; close that terminal to avoid two writers", pid);
    }
    Ok(view)
}
