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
use std::time::Duration;

use crate::adopt::terminate_and_wait;
use crate::hosts::{self, Host};
use crate::registry::{instance_host, read_reg, read_state, states_for, write_reg};
use crate::tmux::sess_name;
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

/// The mark one machine wrote for one account, ignoring a reset that has already passed.
fn mark_until(host: Host, acct: &str) -> Option<u64> {
    let until = match host {
        None => {
            let text = fs::read_to_string(athena_dir().join("accounts").join(format!("{}.json", acct))).ok()?;
            serde_json::from_str::<serde_json::Value>(&text).ok()?.get("until")?.as_u64()?
        }
        Some(_) => remote_marks(host).get(acct).copied()?,
    };
    (until > now()).then_some(until)
}

/// Every account mark on a remote host, in one ssh call, memoised for a few seconds.
///
/// `choose` is called from a one-second loop, so an uncached read here would be a round trip per
/// account per second. A reset time is minutes away when it is set, so seconds of staleness cost
/// nothing.
fn remote_marks(host: Host) -> HashMap<String, u64> {
    use std::sync::{Mutex, OnceLock};
    use std::time::Instant;
    static CACHE: OnceLock<Mutex<HashMap<String, (Instant, HashMap<String, u64>)>>> = OnceLock::new();
    let Some(h) = host else { return HashMap::new() };
    let cache = CACHE.get_or_init(|| Mutex::new(HashMap::new()));
    if let Ok(c) = cache.lock() {
        if let Some((at, v)) = c.get(h) {
            if at.elapsed() < Duration::from_secs(5) {
                return v.clone();
            }
        }
    }
    let script = r#"cd "$HOME/.athena/accounts" 2>/dev/null || exit 0
for f in *.json; do
  [ -e "$f" ] || continue
  printf '%s	' "${f%.json}"
  tr -d '
' < "$f"
  printf '
'
done"#;
    let mut out = HashMap::new();
    let Some(o) = hosts::run(host, "sh", &["-c", script]).filter(|o| o.status.success()) else {
        // Unreachable or refused. Caching this as "no marks" would let the next choose() treat a
        // spent account as available, so the last known answer is kept instead: a stale mark only
        // ever delays a launch, an absent one sends it into a wall.
        return cache
            .lock()
            .ok()
            .and_then(|c| c.get(h).map(|(_, v)| v.clone()))
            .unwrap_or_default();
    };
    {
        for line in String::from_utf8_lossy(&o.stdout).lines() {
            if let Some((acct, json)) = line.split_once('\t') {
                if let Some(until) = serde_json::from_str::<serde_json::Value>(json)
                    .ok()
                    .and_then(|v| v.get("until")?.as_u64())
                {
                    out.insert(acct.to_string(), until);
                }
            }
        }
    }
    if let Ok(mut c) = cache.lock() {
        c.insert(h.to_string(), (Instant::now(), out.clone()));
    }
    out
}

/// Out of usage until this epoch, per any machine's mark; None once every reset has passed.
///
/// A usage limit belongs to the subscription, not to a computer, so a limit the desktop ran into
/// is just as true here. Marks are therefore unioned across the fleet and the LATEST reset wins:
/// trusting only this laptop's copy would have Athena launch straight into an account the desktop
/// already knows is spent.
fn limited_until(acct: &str) -> Option<u64> {
    // Every DECLARED machine, not just the ones with an instance right now: closing the last desk
    // instance must not retire a limit mark that is still in force, or the next launch walks
    // straight into a subscription the desktop already knows is spent.
    let mut hosts_seen: Vec<Option<String>> = read_reg().into_iter().map(|i| i.host).collect();
    hosts_seen.extend(hosts::list_hosts().into_iter().map(Some));
    hosts_seen.push(None);
    hosts_seen.sort();
    hosts_seen.dedup();
    hosts_seen.iter().filter_map(|h| mark_until(h.as_deref(), acct)).max()
}

/// `pref` if it has allowance, else the first account that does, else None.
///
/// An account at `limits::PREEMPT` of either window counts as spent too, so a launch or a move
/// skips it before it hits the wall. When every account is that full, the hard marks alone decide,
/// since a nearly-full account still beats waiting for a reset.
pub fn choose(pref: &str) -> Option<String> {
    let all = accounts();
    let ok = |a: &str| limited_until(a).is_none();
    let roomy = |a: &str| ok(a) && !crate::limits::nearly_out(a);
    if all.iter().any(|a| a == pref) && roomy(pref) {
        return Some(pref.to_string());
    }
    all.iter()
        .find(|a| roomy(a))
        .or_else(|| all.iter().find(|a| a.as_str() == pref && ok(a)))
        .or_else(|| all.iter().find(|a| ok(a)))
        .cloned()
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
        // Not filtered on `cmd`: a bash tile where claude was typed by hand reports `limited` just
        // the same, and only the claude hook ever writes that state.
        for inst in read_reg() {
            let hs = match &inst.host {
                None => read_state(&inst.id),
                Some(h) => states_for(h).get(&inst.id).cloned().unwrap_or_default(),
            };
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

/// Stop a process on whichever machine it runs on, TERM then KILL, exactly as the local version
/// does: CONT so a stopped process can act on the TERM it is holding, three seconds of grace, then
/// KILL, which cannot be blocked. A transcript is appended per message, so nothing written is lost.
fn terminate_on(host: Host, pid: i32) -> bool {
    match host {
        None => terminate_and_wait(pid),
        Some(_) => {
            let script = format!(
                r#"kill -TERM {pid} 2>/dev/null; kill -CONT {pid} 2>/dev/null
for i in $(seq 1 30); do kill -0 {pid} 2>/dev/null || exit 0; sleep 0.1; done
kill -KILL {pid} 2>/dev/null
for i in $(seq 1 30); do kill -0 {pid} 2>/dev/null || exit 0; sleep 0.1; done
exit 1"#,
                pid = pid
            );
            hosts::run(host, "sh", &["-c", &script]).map(|o| o.status.success()).unwrap_or(false)
        }
    }
}

/// Resume `sid` on account `to`. Same account means its limit reset: just nudge the live session.
fn move_to(id: &str, from: &str, to: &str, sid: &str) -> Result<(), String> {
    let host = instance_host(id);
    let hostref = host.as_deref();
    let sess = sess_name(id);
    if from == to {
        return crate::tmux::send_block_on(hostref, &sess, id, RESET);
    }
    // The id becomes a shell argument, so it is checked rather than trusted.
    if sid.len() < 8 || !sid.chars().all(|c| c.is_ascii_hexdigit() || c == '-') {
        return Err(format!("not a session id: {}", sid));
    }
    let pane = crate::tmux::pane_pid_on(hostref, &sess).ok_or("no live pane")?;
    // A limited instance is idle, which is exactly what auto-pause freezes, and a frozen claude
    // can act on no signal. Thaw first; the resumed session is live work again anyway.
    let _ = crate::tmux::set_frozen_on(hostref, pane, false);
    // Every claude on the pane's terminal, not just children of the pane process: one typed into a
    // nested shell (`bash` then `claude`) is a grandchild and `pgrep -P` walked straight past it.
    let tty = crate::tmux::tmux_on(hostref, &["display-message", "-p", "-t", &sess, "#{pane_tty}"])
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().trim_start_matches("/dev/").to_string())
        .filter(|t| !t.is_empty())
        .ok_or("no pane tty")?;
    let kids = hosts::run(hostref, "pgrep", &["-t", &tty, "-x", "claude"])
        .ok_or_else(|| format!("pgrep did not run on {}", hostref.unwrap_or("this machine")))?;
    let pids: Vec<i32> = String::from_utf8_lossy(&kids.stdout).lines().filter_map(|l| l.trim().parse().ok()).collect();
    // No claude left (it exited or crashed after the limit) is fine: the shell check below still
    // guards the typing, and refusing here would strand the instance at `limited` forever.
    // Stop BEFORE resuming: two processes appending to one transcript is the corruption to avoid.
    for pid in pids {
        if !terminate_on(hostref, pid) {
            return Err(format!("claude {} did not exit, so it was not resumed elsewhere", pid));
        }
    }
    // The line is typed into the pane, so the pane must be back at a shell prompt, never at a TUI.
    // The shell takes the terminal back a beat after claude exits, so give it up to 2s.
    let is_shell = |c: &str| matches!(c, "bash" | "zsh" | "sh" | "fish");
    let mut fg = String::new();
    for _ in 0..20 {
        fg = crate::tmux::tmux_on(hostref, &["display-message", "-p", "-t", &sess, "#{pane_current_command}"])
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
    crate::registry::clear_state_on(hostref, id);
    let mut reg = read_reg();
    if let Some(i) = reg.iter_mut().find(|i| i.id == id) {
        i.account = Some(to.to_string());
        write_reg(&reg);
    }
    let line = on_account(to, &format!("claude --resume {} '{}'", sid, MOVED));
    match crate::tmux::tmux_on(hostref, &["send-keys", "-t", &sess, &line, "Enter"]) {
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
