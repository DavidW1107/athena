// Where a command runs. Athena grew up assuming "here", and a second machine on the desk turned
// that assumption into a field on every instance.
//
// A host is an ssh ALIAS from ~/.ssh/config, never a hostname or an address. Port, user, key and
// ControlMaster reuse then live in ssh's own config, which already keeps one channel open between
// calls: the fleet poll fires several tmux calls a second, and a fresh TCP and key exchange for
// each of them would cost more than everything else Athena does.

use std::process::{Command, Output};

/// `None` is this machine. `Some("desk")` is whatever alias ssh knows.
pub type Host<'a> = Option<&'a str>;

/// One argument, safe to hand to a remote login shell.
///
/// ssh has no argv to pass on: it joins its arguments with spaces and the shell on the far side
/// re-splits them. So anything carrying a space, a quote or a newline (a prompt, a path, a tmux
/// buffer holding a whole paragraph) has to arrive already quoted, or tmux there sees several
/// arguments where one was meant. Single quotes with the close-escape-reopen trick survive
/// everything except a NUL, which cannot be in an argument anyway.
pub fn sh_quote(arg: &str) -> String {
    format!("'{}'", arg.replace('\'', "'\\''"))
}

/// Build the command that runs `prog args...` on `host`.
pub fn command(host: Host, prog: &str, args: &[&str]) -> Command {
    match host {
        None => {
            let mut c = Command::new(prog);
            c.args(args);
            c
        }
        Some(h) => {
            let mut c = Command::new("ssh");
            // BatchMode: never stop to ask for a passphrase or to confirm a host key. The poll
            // runs every second and a prompt nobody can answer would wedge the whole fleet.
            // ConnectTimeout: the desktop is allowed to be off. A call to a machine that is not
            // there has to fail inside one poll and read as "not running", not hang.
            c.args(["-o", "BatchMode=yes", "-o", "ConnectTimeout=4", h]);
            let mut line = sh_quote(prog);
            for a in args {
                line.push(' ');
                line.push_str(&sh_quote(a));
            }
            c.arg(line);
            c
        }
    }
}

/// Run a command on `host`. `None` means the host was unreachable or the program is missing,
/// which callers already treat the same way they treat a missing tmux.
pub fn run(host: Host, prog: &str, args: &[&str]) -> Option<Output> {
    command(host, prog, args).output().ok()
}

/// Read a file from `host`. Local reads go straight to the filesystem so the common case pays
/// nothing; a remote read is one `cat`.
pub fn read_file(host: Host, path: &str) -> Option<String> {
    match host {
        None => std::fs::read_to_string(path).ok(),
        Some(_) => {
            let o = run(host, "cat", &[path])?;
            o.status.success().then(|| String::from_utf8_lossy(&o.stdout).to_string())
        }
    }
}

/// Write `text` to a file on `host`, with no trailing newline.
///
/// This exists for `cgroup.freeze`, where the newline a shell `echo` adds is harmless but the
/// redirect is not optional: the file cannot be created, only written, so a copy-then-move is
/// wrong and `printf` into it is the whole operation.
pub fn write_file(host: Host, path: &str, text: &str) -> Result<(), String> {
    match host {
        None => std::fs::write(path, text).map_err(|e| e.to_string()),
        Some(_) => {
            let script = format!("printf %s {} > {}", sh_quote(text), sh_quote(path));
            match run(host, "sh", &["-c", &script]) {
                None => Err(format!("could not reach {}", host.unwrap_or("this machine"))),
                Some(o) if o.status.success() => Ok(()),
                Some(o) => {
                    let e = String::from_utf8_lossy(&o.stderr).trim().to_string();
                    Err(if e.is_empty() { format!("write to {} refused", path) } else { e })
                }
            }
        }
    }
}

/// Is `host` answering right now?
///
/// Used before a launch, so a failure names the machine instead of surfacing as a tmux error
/// that reads as though tmux were missing.
pub fn reachable(host: Host) -> bool {
    match host {
        None => true,
        Some(_) => run(host, "true", &[]).map(|o| o.status.success()).unwrap_or(false),
    }
}

/// The ssh aliases this machine knows, for the launcher's host picker.
///
/// ~/.ssh/config is the only declaration of a host Athena needs: it already holds the address,
/// port, user, key and channel reuse, and a second list here would be a second thing to keep in
/// step. Patterns (`Host *`, `Host build-?`) are skipped because they are defaults applied to
/// other names rather than machines anything can be launched on.
#[tauri::command]
pub fn list_hosts() -> Vec<String> {
    let Some(text) = std::fs::read_to_string(crate::util::home().join(".ssh").join("config")).ok() else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for line in text.lines() {
        let line = line.trim();
        let Some(rest) = line.strip_prefix("Host ").or_else(|| line.strip_prefix("host ")) else { continue };
        for alias in rest.split_whitespace() {
            if !alias.contains('*') && !alias.contains('?') && !out.iter().any(|a| a == alias) {
                out.push(alias.to_string());
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn quoting_survives_what_a_prompt_contains() {
        assert_eq!(sh_quote("plain"), "'plain'");
        assert_eq!(sh_quote("two words"), "'two words'");
        // The case that matters: an apostrophe in prose, which would otherwise close the quote
        // and hand the rest of the sentence to the remote shell as commands.
        assert_eq!(sh_quote("don't; rm -rf /"), "'don'\\''t; rm -rf /'");
        assert_eq!(sh_quote("line one\nline two"), "'line one\nline two'");
    }

    #[test]
    fn a_local_command_is_not_wrapped_in_ssh() {
        let c = command(None, "tmux", &["ls"]);
        assert_eq!(c.get_program(), "tmux");
        let c = command(Some("desk"), "tmux", &["ls"]);
        assert_eq!(c.get_program(), "ssh");
        // Everything after the alias is ONE argument, already quoted, because the remote shell
        // is what splits it.
        let args: Vec<String> = c.get_args().map(|a| a.to_string_lossy().to_string()).collect();
        assert_eq!(args.last().unwrap(), "'tmux' 'ls'");
    }
}
