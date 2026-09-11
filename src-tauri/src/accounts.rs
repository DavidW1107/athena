// More than one Claude subscription over one config.
//
// ~/.claude is account "a" (plain `claude`); a profile dir ~/.claude-<x> made by
// scripts/setup-account.sh is account "x", selected per process with CLAUDE_CONFIG_DIR. Both see
// the same projects/, so a session started on one resumes on the other.
//
// The state hook is still the only channel: on a usage limit it marks the account out in
// ~/.athena/accounts/<x>.json (until = reset time) and reports the instance as `limited`. `watch`
// turns that into a move: stop the claude in the pane, `claude --resume <id>` on an account with
// allowance left, and tell it to carry on. Instances stay where they land until that account runs
// out too; when every account is out they wait, and the first reset resumes them in place.

use std::collections::HashMap;
use std::fs;
use std::process::Command;
use std::time::Duration;

use crate::adopt::terminate_and_wait;
use crate::registry::{read_reg, read_state, write_reg};
use crate::tmux::{pane_pid, send_block, sess_name, tmux};
use crate::util::{athena_dir, home, now};

const MOVED: &str = "Your last turn was cut off by a usage limit, so Athena moved this session to \
another Claude account. Subagents and background tasks from before the move are gone. Carry on from \
where you stopped.";
const RESET: &str = "The usage limit has reset. Carry on from where you stopped.";

fn valid(name: &str) -> bool {
    !name.is_empty() && name.chars().all(|c| c.is_ascii_alphanumeric())
}

/// Every account that can run: "a", then each logged-in ~/.claude-<x>, sorted.
pub fn accounts() -> Vec<String> {
    let mut rest: Vec<String> = fs::read_dir(home())
        .map(|rd| {
            rd.flatten()
                .filter_map(|e| e.file_name().to_str()?.strip_prefix(".claude-").map(String::from))
                .filter(|n| valid(n) && n != "a")
                .filter(|n| home().join(format!(".claude-{}", n)).join(".credentials.json").is_file())
                .collect()
        })
        .unwrap_or_default();
    rest.sort();
    let mut v = vec!["a".to_string()];
    v.extend(rest);
    v
}

/// Out of usage until this epoch, per the hook's mark; None once the reset has passed.
fn limited_until(acct: &str) -> Option<u64> {
    let text = fs::read_to_string(athena_dir().join("accounts").join(format!("{}.json", acct))).ok()?;
    let until = serde_json::from_str::<serde_json::Value>(&text).ok()?.get("until")?.as_u64()?;
    (until > now()).then_some(until)
}

/// `pref` if it has allowance, else the first account that does, else None.
pub fn choose(pref: &str) -> Option<String> {
    let all = accounts();
    if all.iter().any(|a| a == pref) && limited_until(pref).is_none() {
        return Some(pref.to_string());
    }
    all.into_iter().find(|a| limited_until(a).is_none())
}

/// The shell line that runs `line` on `acct`. Only a claude line is touched.
///
/// "a" UNSETS the variable instead of pointing it at ~/.claude: with CLAUDE_CONFIG_DIR set, Claude
/// reads its login from ~/.claude/.claude.json rather than ~/.claude.json, and account A would
/// come up logged out. Unsetting also covers a tmux server that inherited a profile's variable.
pub fn on_account(acct: &str, line: &str) -> String {
    if !(line == "claude" || line.starts_with("claude ")) {
        return line.to_string();
    }
    if acct == "a" || !valid(acct) {
        format!("env -u CLAUDE_CONFIG_DIR {}", line)
    } else {
        format!("CLAUDE_CONFIG_DIR={} {}", home().join(format!(".claude-{}", acct)).display(), line)
    }
}

/// Background loop, started once from main. The hook writes `limited` the moment the turn fails,
/// so this poll is the whole wait before a move: 1s, a dozen small file reads.
pub fn watch() {
    // Earliest epoch each instance may be tried again.
    let mut next: HashMap<String, u64> = HashMap::new();
    loop {
        std::thread::sleep(Duration::from_secs(1));
        for inst in read_reg() {
            if !inst.cmd.starts_with("claude") {
                continue;
            }
            let hs = read_state(&inst.id);
            if hs.state.as_deref() != Some("limited") {
                continue;
            }
            let Some(sid) = hs.session_id.clone().or(inst.session_id.clone()) else { continue };
            if next.get(&inst.id).is_some_and(|t| now() < *t) {
                continue;
            }
            let from = hs.account.clone().or(inst.account.clone()).unwrap_or_else(|| "a".into());
            let Some(to) = choose(&from) else { continue }; // every account is out: wait for a reset
            // ponytail: 2 min after a move, so a misread reset time costs one failed resume rather
            // than a restart loop; 10s after a failed try, which is nearly always a claude still
            // shutting down. Per-account backoff if that ever proves too blunt.
            let wait = match move_to(&inst.id, &from, &to, &sid) {
                Ok(()) => 120,
                Err(e) => {
                    eprintln!("athena: could not move {} from account {} to {}: {}", inst.id, from, to, e);
                    10
                }
            };
            next.insert(inst.id.clone(), now() + wait);
        }
    }
}

/// Resume `sid` on account `to`. Same account means its limit reset: just nudge the live session.
fn move_to(id: &str, from: &str, to: &str, sid: &str) -> Result<(), String> {
    let sess = sess_name(id);
    if from == to {
        return send_block(&sess, id, RESET);
    }
    // The id becomes a shell argument, so it is checked rather than trusted.
    if sid.len() < 8 || !sid.chars().all(|c| c.is_ascii_hexdigit() || c == '-') {
        return Err(format!("not a session id: {}", sid));
    }
    let pane = pane_pid(&sess).ok_or("no live pane")?;
    // A limited instance is idle, which is exactly what auto-pause freezes, and a frozen claude
    // can act on no signal. Thaw first; the resumed session is live work again anyway.
    let _ = crate::tmux::set_frozen(pane, false);
    let kids = Command::new("pgrep")
        .args(["-P", &pane.to_string(), "-x", "claude"])
        .output()
        .map_err(|e| format!("pgrep: {}", e))?;
    let pids: Vec<i32> = String::from_utf8_lossy(&kids.stdout).lines().filter_map(|l| l.trim().parse().ok()).collect();
    // No claude left (it exited or crashed after the limit) is fine: the shell check below still
    // guards the typing, and refusing here would strand the instance at `limited` forever.
    // Stop BEFORE resuming: two processes appending to one transcript is the corruption to avoid.
    for pid in pids {
        if !terminate_and_wait(pid) {
            return Err(format!("claude {} did not exit, so it was not resumed elsewhere", pid));
        }
    }
    // The line is typed into the pane, so the pane must be back at a shell prompt, never at a TUI.
    // The shell takes the terminal back a beat after claude exits, so give it up to 2s.
    let is_shell = |c: &str| matches!(c, "bash" | "zsh" | "sh" | "fish");
    let mut fg = String::new();
    for _ in 0..20 {
        fg = tmux(&["display-message", "-p", "-t", &sess, "#{pane_current_command}"])
            .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
            .unwrap_or_default();
        if is_shell(&fg) {
            break;
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    if !is_shell(&fg) {
        return Err(format!("pane is running {} rather than a shell, so nothing was typed", fg));
    }
    // Stale `limited` would re-trigger the move; the resumed session writes its own state.
    let _ = fs::remove_file(athena_dir().join("state").join(format!("{}.json", id)));
    let mut reg = read_reg();
    if let Some(i) = reg.iter_mut().find(|i| i.id == id) {
        i.account = Some(to.to_string());
        write_reg(&reg);
    }
    let line = on_account(to, &format!("claude --resume {} '{}'", sid, MOVED));
    match tmux(&["send-keys", "-t", &sess, &line, "Enter"]) {
        Some(o) if o.status.success() => Ok(()),
        _ => Err("claude was stopped but the resume could not be typed; restore it by hand".into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_claude_lines_get_an_account() {
        assert_eq!(on_account("a", "claude --resume x"), "env -u CLAUDE_CONFIG_DIR claude --resume x");
        assert!(on_account("b", "claude").ends_with("/.claude-b claude"));
        assert!(on_account("b", "claude").starts_with("CLAUDE_CONFIG_DIR=/"));
        assert_eq!(on_account("b", "codex"), "codex");
        assert_eq!(on_account("b", "claudex"), "claudex");
        // A name from hook state is never interpolated unchecked.
        assert_eq!(on_account("b; rm -rf ~", "claude"), "env -u CLAUDE_CONFIG_DIR claude");
    }

    #[test]
    fn the_resume_prompt_survives_single_quoting() {
        assert!(!MOVED.contains('\'') && !RESET.contains('\''));
    }
}
