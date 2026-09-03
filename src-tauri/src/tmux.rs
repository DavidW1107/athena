// tmux owns session lifetime; this module is the only place that shells out to it,
// plus the process-group probes used to decide "paused" and to signal a job.

use std::collections::HashMap;
use std::path::PathBuf;
use std::process::Command;

use crate::util::proc_stat_fields;

pub fn tmux(args: &[&str]) -> Option<std::process::Output> {
    Command::new("tmux").args(args).output().ok()
}

pub fn sess_name(id: &str) -> String {
    format!("argus_{}", id)
}

pub fn tmux_alive(sess: &str) -> bool {
    tmux(&["has-session", "-t", sess]).map(|o| o.status.success()).unwrap_or(false)
}

pub fn pane_pid(sess: &str) -> Option<i32> {
    let o = tmux(&["list-panes", "-t", sess, "-F", "#{pane_pid}"])?;
    String::from_utf8_lossy(&o.stdout).lines().next()?.trim().parse().ok()
}

/// Foreground process group of the pane's tty: the job actually running (claude/codex),
/// not the shell. Signalling this group stops the whole tree.
pub fn fg_pgid(sess: &str) -> Option<i32> {
    // after comm: state, ppid, pgrp, session, tty_nr, tpgid
    tpgid_of(pane_pid(sess)?)
}

/// One tmux call for the whole fleet: session name -> first pane pid.
/// The poll runs every second, so per-instance `has-session` calls are not affordable.
pub fn pane_map() -> HashMap<String, i32> {
    let mut m = HashMap::new();
    if let Some(o) = tmux(&["list-panes", "-a", "-F", "#{session_name} #{pane_pid}"]) {
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

pub fn tpgid_of(pid: i32) -> Option<i32> {
    proc_stat_fields(pid)?.get(5)?.parse().ok()
}

pub fn is_stopped_pid(pane: i32) -> bool {
    match tpgid_of(pane).and_then(proc_stat_fields) {
        Some(f) => f.first().map(|s| s == "T").unwrap_or(false),
        None => false,
    }
}

pub fn signal_group(pgid: i32, sig: &str) -> bool {
    Command::new("sh")
        .arg("-c")
        .arg(format!("kill -{} -{}", sig, pgid))
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

pub fn git_group(cwd: &str) -> String {
    let top = Command::new("git")
        .args(["-C", cwd, "rev-parse", "--show-toplevel"])
        .output()
        .ok()
        .filter(|o| o.status.success())
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        .filter(|s| !s.is_empty());
    let path = top.unwrap_or_else(|| cwd.to_string());
    PathBuf::from(&path)
        .file_name()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or(path)
}

// ---------------------------------------------------------------- delivery

/// One tmux call, mapped to a message rather than a bool so a failure can name itself.
pub fn tmux_run(args: &[&str]) -> Result<(), String> {
    match tmux(args) {
        None => Err("tmux is not on PATH".into()),
        Some(o) if o.status.success() => Ok(()),
        Some(o) => {
            let e = String::from_utf8_lossy(&o.stderr).trim().to_string();
            Err(if e.is_empty() { "tmux refused the command".into() } else { e })
        }
    }
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
pub fn send_block(sess: &str, tag: &str, text: &str) -> Result<(), String> {
    if text.contains('\n') {
        let safe: String = tag.chars().filter(|c| c.is_ascii_alphanumeric()).collect();
        let buf = format!("argus_paste_{}", safe);
        tmux_run(&["set-buffer", "-b", &buf, "--", text])
            .map_err(|e| format!("nothing sent, buffer not staged: {}", e))?;
        tmux_run(&["paste-buffer", "-d", "-p", "-b", &buf, "-t", sess]).map_err(|e| {
            let _ = tmux(&["delete-buffer", "-b", &buf]);
            format!("nothing sent, paste failed: {}", e)
        })?;
    } else {
        tmux_run(&["send-keys", "-t", sess, "-l", "--", text])
            .map_err(|e| format!("nothing sent: {}", e))?;
    }
    tmux_run(&["send-keys", "-t", sess, "Enter"])
        .map_err(|e| format!("text is in the pane but was not submitted: {}", e))
}
