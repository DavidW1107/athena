// tmux owns session lifetime; this module is the only place that shells out to it,
// plus the cgroup freezer used to pause a pane.
//
// Every call takes a host (see hosts.rs), because an instance may live on this machine or on the
// desktop over ssh. The `_on` functions are the real ones; the bare names are local wrappers kept
// so callers that can only ever mean this machine stay unchanged.

use std::collections::HashMap;
use std::path::PathBuf;

use crate::hosts::{self, Host};

pub fn tmux_on(host: Host, args: &[&str]) -> Option<std::process::Output> {
    hosts::run(host, "tmux", args)
}

pub fn tmux(args: &[&str]) -> Option<std::process::Output> {
    tmux_on(None, args)
}

pub fn sess_name(id: &str) -> String {
    format!("athena_{}", id)
}

pub fn tmux_alive_on(host: Host, sess: &str) -> bool {
    tmux_on(host, &["has-session", "-t", sess]).map(|o| o.status.success()).unwrap_or(false)
}


pub fn pane_pid_on(host: Host, sess: &str) -> Option<i32> {
    let o = tmux_on(host, &["list-panes", "-t", sess, "-F", "#{pane_pid}"])?;
    String::from_utf8_lossy(&o.stdout).lines().next()?.trim().parse().ok()
}


/// One tmux call per host: session name -> first pane pid.
/// The poll runs every second, so per-instance `has-session` calls are not affordable.
///
/// A pid is only meaningful on the host that reported it, so the two maps are never merged: the
/// caller keeps one per host and looks up each instance in its own.
pub fn pane_map_on(host: Host) -> HashMap<String, i32> {
    let mut m = HashMap::new();
    if let Some(o) = tmux_on(host, &["list-panes", "-a", "-F", "#{session_name} #{pane_pid}"]) {
        for line in String::from_utf8_lossy(&o.stdout).lines() {
            if let Some((sess, pid)) = line.split_once(' ') {
                if let Ok(pid) = pid.trim().parse::<i32>() {
                    m.entry(sess.to_string()).or_insert(pid);
                }
            }
        }
    }
    m
}

pub fn pane_map() -> HashMap<String, i32> {
    pane_map_on(None)
}

/// One pane map per host the fleet uses, so a lookup is always against the machine the pid is on.
pub fn pane_maps(hosts: &[Option<String>]) -> HashMap<Option<String>, HashMap<String, i32>> {
    hosts.iter().map(|h| (h.clone(), pane_map_on(h.as_deref()))).collect()
}

/// The cgroup tmux made for one pane, from the text of `/proc/<pid>/cgroup`.
///
/// tmux built with systemd puts every pane in its own `tmux-spawn-*.scope`. Nothing else is
/// accepted: any other cgroup is shared (Athena's own scope, the tmux server's), and freezing it
/// would freeze far more than one pane.
fn spawn_scope(proc_cgroup: &str) -> Option<PathBuf> {
    let rel = proc_cgroup.lines().find_map(|l| l.strip_prefix("0::"))?.trim();
    if !rel.rsplit('/').next()?.starts_with("tmux-spawn-") {
        return None;
    }
    Some(PathBuf::from("/sys/fs/cgroup").join(rel.trim_start_matches('/')))
}

fn pane_scope_on(host: Host, pane: i32) -> Option<PathBuf> {
    spawn_scope(&hosts::read_file(host, &format!("/proc/{}/cgroup", pane))?)
}

pub fn is_frozen_on(host: Host, pane: i32) -> bool {
    pane_scope_on(host, pane)
        .and_then(|d| hosts::read_file(host, &d.join("cgroup.freeze").to_string_lossy()))
        .map(|s| s.trim() == "1")
        .unwrap_or(false)
}


/// Pause or resume a pane by freezing its cgroup.
///
/// This used to SIGSTOP the pane's foreground process group, and that stranded agents for days.
/// The agent runs as a job under the pane's interactive bash, and bash's job control reacts to
/// any stopped job: it prints `[1]+ Stopped`, takes the terminal back and resets it to cooked
/// mode. The agent was then a background job no SIGCONT could return to the foreground, the
/// resume saw bash in the foreground and forgot the pause, and the pane sat at a prompt printing
/// `997;1n`, the colour-scheme reports tmux kept sending on behalf of the frozen agent.
///
/// A frozen task is not a stopped one. Neither bash nor tmux is told anything (tmux would
/// SIGCONT a stopped pane process at once), and thawing is the whole of a resume.
/// The freezer is per host: WSL on the desktop runs systemd too, so its tmux also gives every
/// pane a `tmux-spawn-*.scope` and `cgroup.freeze` there is writable by the same user. A remote
/// pause is therefore the identical operation, one ssh further away.
pub fn set_frozen_on(host: Host, pane: i32, on: bool) -> Result<(), String> {
    let dir = pane_scope_on(host, pane)
        .ok_or("that pane has no cgroup of its own, so it cannot be paused safely")?;
    hosts::write_file(host, &dir.join("cgroup.freeze").to_string_lossy(), if on { "1" } else { "0" })
        .map_err(|e| format!("could not write cgroup.freeze: {}", e))
}


pub fn git_group_on(host: Host, cwd: &str) -> String {
    let top = hosts::run(host, "git", &["-C", cwd, "rev-parse", "--show-toplevel"])
        .filter(|o| o.status.success())
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        .filter(|s| !s.is_empty());
    let path = top.unwrap_or_else(|| cwd.to_string());
    PathBuf::from(&path)
        .file_name()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or(path)
}

pub fn git_group(cwd: &str) -> String {
    git_group_on(None, cwd)
}

// ---------------------------------------------------------------- delivery

/// One tmux call, mapped to a message rather than a bool so a failure can name itself.
pub fn tmux_run_on(host: Host, args: &[&str]) -> Result<(), String> {
    match tmux_on(host, args) {
        None => Err(match host {
            None => "tmux is not on PATH".into(),
            Some(h) => format!("{} is not reachable, or tmux is not on its PATH", h),
        }),
        Some(o) if o.status.success() => Ok(()),
        Some(o) => {
            let e = String::from_utf8_lossy(&o.stderr).trim().to_string();
            Err(if e.is_empty() { "tmux refused the command".into() } else { e })
        }
    }
}

pub fn tmux_run(args: &[&str]) -> Result<(), String> {
    tmux_run_on(None, args)
}

/// Deliver `text` into a pane as ONE prompt, then submit it exactly once.
///
/// `send-keys -l` submits at every newline, so a multi-line block typed that way reaches
/// an agent as several prompts. A multi-line block therefore goes through a tmux paste
/// buffer with bracketed paste (`-p`), which a TUI in bracketed-paste mode reads as a
/// single prompt; `-d` drops the buffer once it has landed. A single-line block is typed
/// literally, which is cheaper and needs no buffer.
///
/// Bracketed paste is an agent-terminal contract: Claude Code and Codex honour it, a bare
/// `bash` prompt does not and will run each line. Callers that can target a plain shell
/// say so in their UI.
///
/// Delivery is two phases with a hard short-circuit between them, and the error text
/// distinguishes the two partial states a caller has to tell apart: nothing reached the
/// pane, versus text reached it and was never submitted.
///
/// `tag` only names the scratch buffer; it is reduced to ASCII alphanumerics.
///
/// The buffer lives in the tmux SERVER, so staging and pasting have to reach the same one: both
/// calls take the same host, and a remote paste never stages its text on this machine.
pub fn send_block_on(host: Host, sess: &str, tag: &str, text: &str) -> Result<(), String> {
    if text.contains('\n') {
        let safe: String = tag.chars().filter(|c| c.is_ascii_alphanumeric()).collect();
        let buf = format!("athena_paste_{}", safe);
        tmux_run_on(host, &["set-buffer", "-b", &buf, "--", text])
            .map_err(|e| format!("nothing sent, buffer not staged: {}", e))?;
        tmux_run_on(host, &["paste-buffer", "-d", "-p", "-b", &buf, "-t", sess]).map_err(|e| {
            let _ = tmux_on(host, &["delete-buffer", "-b", &buf]);
            format!("nothing sent, paste failed: {}", e)
        })?;
    } else {
        tmux_run_on(host, &["send-keys", "-t", sess, "-l", "--", text])
            .map_err(|e| format!("nothing sent: {}", e))?;
    }
    tmux_run_on(host, &["send-keys", "-t", sess, "Enter"])
        .map_err(|e| format!("text is in the pane but was not submitted: {}", e))
}


/// Server options Athena wants in place before it creates any session.
///
/// tmux defaults to 2000 lines of history, which is thin for reading back through an agent
/// conversation. This is a server-wide option read when a pane is CREATED, so it has to be set
/// before new-session; raising it later does not affect panes that already exist.
pub fn ensure_server_options_on(host: Host) {
    let _ = tmux_on(host, &["set-option", "-g", "history-limit", "50000"]);
    // tmux draws its own status line at the bottom of every pane: green, session name left,
    // window name and date right. Inside a tile that reads as a coloured bar under the
    // terminal, and it was also what smeared down the screen when copy mode was thrashing,
    // because it is repainted on every mode change. Athena's own header already carries the
    // session name and state, so the status line is duplicate chrome costing a row per pane.
    let _ = tmux_on(host, &["set-option", "-g", "status", "off"]);
    // The pane follows the attached client's size, which is how a tile going fullscreen turns
    // into a SIGWINCH and a redraw at the new width. Without it a pane can stay pinned to the
    // size it was created at and the text never reflows.
    let _ = tmux_on(host, &["set-option", "-g", "window-size", "latest"]);
}

pub fn ensure_server_options() {
    ensure_server_options_on(None);
}

/// Leave copy mode if the pane is in it, so typing after a scroll reaches the application.
///
/// Without this the wheel creates a new trap: scroll up, type, and the keys are eaten by
/// copy-mode bindings instead of reaching Claude. `send-keys -X` is an error outside copy mode,
/// so the mode is checked first rather than firing blind.
pub fn end_copy_mode_on(host: Host, sess: &str) {
    let in_mode = tmux_on(host, &["display-message", "-t", sess, "-p", "#{pane_in_mode}"])
        .map(|o| String::from_utf8_lossy(&o.stdout).trim() == "1")
        .unwrap_or(false);
    if in_mode {
        let _ = tmux_on(host, &["send-keys", "-t", sess, "-X", "cancel"]);
    }
}


#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_a_pane_scope_is_ever_frozen() {
        let app = "/user.slice/user-1000.slice/user@1000.service/app.slice";
        assert_eq!(
            spawn_scope(&format!("0::{}/tmux-spawn-54e4.scope\n", app)),
            Some(PathBuf::from(format!("/sys/fs/cgroup{}/tmux-spawn-54e4.scope", app)))
        );
        // Athena and the tmux server share this one; freezing it would freeze every pane.
        assert_eq!(spawn_scope(&format!("0::{}/app-gnome-athena-314532.scope\n", app)), None);
        assert_eq!(spawn_scope("12:freezer:/\n"), None);
    }
}
