#!/usr/bin/env python3
"""Bring back every local instance whose tmux session is gone, then exit.

Run at login, before Athena opens, so a reboot comes back as the grid it was: the same thing
the restore button does (registry.rs `restore`), once per dead instance. A live session is never
touched, so running this at any other time is a no-op.

    restore-all.py            restore what is dead
    restore-all.py --dry-run  print what it would do
"""
import json
import os
import subprocess
import sys
import time
from pathlib import Path

HOME = Path.home()
ATHENA = HOME / ".athena"


def accounts():
    """"a", then each thin profile that shares the primary projects dir (accounts.rs)."""
    primary = (HOME / ".claude/projects").resolve()
    rest = sorted(
        p.name[len(".claude-"):]
        for p in HOME.glob(".claude-*")
        if p.name[len(".claude-"):].isalnum()
        and (p / ".credentials.json").is_file()
        and (p / "projects").resolve() == primary
    )
    return ["a"] + [a for a in rest if a != "a"]


def limited(acct):
    try:
        return json.loads((ATHENA / "accounts" / f"{acct}.json").read_text())["until"] > time.time()
    except (OSError, ValueError, KeyError, TypeError):
        return False


def choose(pref, known):
    # ponytail: hard limit marks only, no nearly-full preempt (limits.rs). Athena's own watch
    # loop moves a session that hits the wall after it is back.
    if pref not in known:
        pref = "a"
    if not limited(pref):
        return pref
    return next((a for a in known if not limited(a)), pref)


def line_for(inst, known):
    sid, cmd = inst.get("session_id"), inst.get("cmd") or ""
    if not (cmd == "claude" or cmd.startswith("claude ")):
        return cmd
    line = f"claude --resume {sid}" if sid else cmd
    acct = choose(inst.get("account") or "a", known)
    if acct == "a":
        return f"env -u CLAUDE_CONFIG_DIR {line}"
    return f"CLAUDE_CONFIG_DIR={HOME / ('.claude-' + acct)} {line}"


def tmux(*args):
    return subprocess.run(["tmux", *args], capture_output=True, text=True).returncode == 0


def main():
    dry = "--dry-run" in sys.argv
    try:
        reg = json.loads((ATHENA / "instances.json").read_text())
    except (OSError, ValueError):
        return
    known = accounts()
    for inst in reg:
        # Desktop instances and parked ones are not this machine's to start.
        if inst.get("host") or inst.get("parked"):
            continue
        sess = f"athena_{inst['id']}"
        if tmux("has-session", "-t", f"={sess}"):
            continue
        cwd = inst.get("cwd") or str(HOME)
        if not os.path.isdir(cwd):
            cwd = str(HOME)
        line = line_for(inst, known)
        print(f"{inst['id']}  {line}")
        if dry or not line:
            continue
        # After a reboot there is no server yet, and Athena may not have set its options
        # (tmux.rs `ensure_server_options`); history-limit only applies to panes made after it.
        if not tmux("start-server", ";", "set-option", "-g", "history-limit", "50000", ";",
                    "set-option", "-g", "status", "off", ";",
                    "set-option", "-g", "window-size", "latest", ";",
                    "new-session", "-d", "-s", sess, "-c", cwd,
                    "-e", f"ATHENA_ID={inst['id']}", "-e", f"ATHENA_NAME={inst.get('name', '')}"):
            print(f"{inst['id']}  tmux new-session failed", file=sys.stderr)
            continue
        # The old hook file describes the process that died; left in place it reads as live state.
        (ATHENA / "state" / f"{inst['id']}.json").unlink(missing_ok=True)
        tmux("send-keys", "-t", sess, line, "Enter")
        time.sleep(1.5)  # two dozen claudes starting in one second is a memory spike


if __name__ == "__main__":
    main()
