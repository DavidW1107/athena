#!/usr/bin/env python3
"""Move every Athena instance off the desktop, then shut the desktop down.

    desk-down            move, then shut down (asks first if anything cannot move)
    desk-down -n         show what would happen, touch nothing
    desk-down --stay-on  move, but leave the desktop running

A Claude instance moves as its conversation plus the files it changed: claude is stopped on the
desktop, the transcript and the working tree come back over rsync, the registry record flips to
this laptop and the session is resumed here in the same Athena tile. Anything else (a bare shell,
codex) has no resume id to carry, so it is listed and dies with the machine.

Paths: WSL resolves /home/david to /home/drwalsh, so the registry holds desktop paths under
/home/drwalsh. They are mapped back to /home/david here, and the transcript moves to the project
directory Claude derives from the mapped path, which is where `claude --resume` looks for it.
"""
import json
import os
import shlex
import subprocess
import sys
import time

HOST = os.environ.get("DESK_HOST", "desk")
HOME = os.path.expanduser("~")
REG = os.path.join(HOME, ".athena", "instances.json")
REPOS = os.path.join(HOME, "Documents", "GitHub")
PROJECTS = os.path.join(HOME, ".claude", "projects")  # every account's projects/ links here
MOVED = "This session was moved from the desktop to the laptop mid-task. Carry on from where you stopped."
# Build output and dependencies are rebuilt where they are needed; history stays with the laptop.
EXCLUDES = [".git/", "node_modules/", "dist/", ".next/", ".vite/", "__pycache__/", "*.swp"]


def slug(path):
    return "".join(c if c.isalnum() else "-" for c in path)


def to_laptop(path):
    return "/home/david" + path[len("/home/drwalsh"):] if path.startswith("/home/drwalsh") else path


def desk(script, check=False):
    """Run a shell script on the desktop, return (ok, stdout)."""
    p = subprocess.run(["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=6", HOST, script],
                       capture_output=True, text=True)
    if check and p.returncode:
        raise RuntimeError(p.stderr.strip() or f"exit {p.returncode}")
    return p.returncode == 0, p.stdout


def run(*cmd):
    return subprocess.run(cmd, capture_output=True, text=True)


def update_reg(iid, **fields):
    # ponytail: read-modify-write with an atomic rename, no lock. Athena writes this file only on
    # launch/close/account moves, so a clash needs one of those in the same few milliseconds.
    with open(REG) as f:
        reg = json.load(f)
    for inst in reg:
        if inst["id"] == iid:
            inst.update(fields)
    tmp = REG + ".desk-down"
    with open(tmp, "w") as f:
        json.dump(reg, f, indent=2)
    os.replace(tmp, REG)


def stop_claude(sess):
    """Stop every claude on the pane's terminal, TERM then KILL, as accounts.rs::move_to does."""
    ok, _ = desk(f"""tty=$(tmux display-message -p -t {shlex.quote(sess)} '#{{pane_tty}}') || exit 0
for pid in $(pgrep -t "${{tty#/dev/}}" -x claude); do
  kill -TERM $pid; kill -CONT $pid
  for i in $(seq 30); do kill -0 $pid 2>/dev/null || continue 2; sleep 0.1; done
  kill -KILL $pid
  for i in $(seq 30); do kill -0 $pid 2>/dev/null || continue 2; sleep 0.1; done
  exit 1
done""")
    return ok


def resume_line(account, sid, working):
    line = f"claude --resume {sid}" + (f" {shlex.quote(MOVED)}" if working else "")
    if not account or account == "a":
        return f"env -u CLAUDE_CONFIG_DIR {line}"  # see accounts.rs::on_account
    return f"CLAUDE_CONFIG_DIR={HOME}/.claude-{account} {line}"


def move(inst, state, dry):
    iid, sess = inst["id"], f"athena_{inst['id']}"
    sid = inst.get("session_id") or state.get("session_id")
    dcwd, lcwd = inst["cwd"], to_laptop(inst["cwd"])
    working = state.get("state") == "working"
    sync = lcwd.startswith(REPOS + "/")
    print(f"  {inst['name']}: {dcwd} -> {lcwd} ({state.get('state', 'no state')})")
    if dry:
        print(f"    would stop claude, {'sync the tree, ' if sync else ''}copy transcript {sid}, resume here")
        return True

    if not stop_claude(sess):
        print("    claude on the desktop did not exit; left there")
        return False
    if sync:
        # --update: a file only comes back if the desktop's copy is newer, so an edit made here
        # since it was pushed out is kept. Deletions on the desktop are not carried back.
        p = run("rsync", "-a", "--update", "--mkpath", "--itemize-changes",
                *[f"--exclude={e}" for e in EXCLUDES], f"{HOST}:{dcwd}/", f"{lcwd}/")
        if p.returncode:
            print(f"    file sync failed, claude stopped but NOT moved: {p.stderr.strip()}")
            return False
        changed = [l.split(" ", 1)[1] for l in p.stdout.splitlines() if l.startswith(">f")]
        print(f"    {len(changed)} file(s) back" + (": " + ", ".join(changed[:8]) if changed else ""))
    elif not os.path.isdir(lcwd):
        print(f"    {lcwd} does not exist here; claude stopped but NOT moved")
        return False
    src, dst = f"{HOST}:.claude/projects/{slug(dcwd)}/", f"{PROJECTS}/{slug(lcwd)}/"
    p = run("rsync", "-a", "--mkpath", "--ignore-missing-args", f"{src}{sid}.jsonl", f"{src}{sid}", dst)
    if p.returncode or not os.path.exists(f"{dst}{sid}.jsonl"):
        print(f"    transcript copy failed, claude stopped but NOT moved: {p.stderr.strip()}")
        return False

    update_reg(iid, host=None, cwd=lcwd, session_id=sid)
    try:
        os.remove(os.path.join(HOME, ".athena", "state", f"{iid}.json"))  # stale, from an old run here
    except FileNotFoundError:
        pass
    if run("tmux", "new-session", "-d", "-s", sess, "-c", lcwd,
           "-e", f"ATHENA_ID={iid}", "-e", f"ATHENA_NAME={inst['name']}").returncode:
        print("    moved, but the local tmux session failed; use Restore on the tile")
    else:
        run("tmux", "send-keys", "-t", sess, resume_line(inst.get("account"), sid, working), "Enter")
    desk(f"tmux kill-session -t {shlex.quote(sess)}")
    print("    resumed on the laptop")
    return True


def main():
    dry = "-n" in sys.argv
    stay = "--stay-on" in sys.argv
    if not desk("true")[0]:
        sys.exit(f"desk-down: {HOST} is not answering (already off, or signed out)")

    with open(REG) as f:
        mine = [i for i in json.load(f) if i.get("host") == HOST]
    _, out = desk("for f in ~/.athena/state/*.json; do [ -e \"$f\" ] && printf 'ID %s\\t%s\\n' "
                  "\"$(basename \"$f\" .json)\" \"$(tr -d '\\n' < \"$f\")\"; done; "
                  "tmux ls -F '#{session_name}' 2>/dev/null")
    lines = out.splitlines()
    states = {}
    for l in lines:
        if l.startswith("ID ") and "\t" in l:
            iid, blob = l[3:].split("\t", 1)
            try:
                states[iid] = json.loads(blob)
            except ValueError:
                pass  # a half-written hook file reads as no state, same as Athena
    live = {l for l in lines if l.startswith("athena_")}

    movable, stranded = [], []
    for inst in mine:
        st = states.get(inst["id"], {})
        if f"athena_{inst['id']}" not in live:
            continue  # already dead on the desktop; Restore brings it back there tomorrow
        claude = inst["cmd"].startswith("claude")
        (movable if claude and (inst.get("session_id") or st.get("session_id")) else stranded).append((inst, st))

    print(f"{len(movable)} to move, {len(stranded)} that cannot move")
    for inst, _ in stranded:
        print(f"  stays and dies: {inst['name']} ({inst['cmd']}) in {inst['cwd']}")
    if stranded and not dry and not stay:
        if input("Shut down anyway? [y/N] ").strip().lower() != "y":
            stay = True
            print("Moving what can move, leaving the desktop on.")

    failed = [inst for inst, st in movable if not move(inst, st, dry)]
    if dry:
        print("dry run: nothing touched" + ("" if stay else f", would shut {HOST} down"))
        return
    if failed:
        sys.exit(f"desk-down: {len(failed)} did not move, so {HOST} was left on")
    if stay:
        return
    desk("sync; /mnt/c/Windows/System32/shutdown.exe /s /t 15 /c 'desk-down from the laptop'")
    print(f"{HOST} shutting down in 15s (cancel on it with: shutdown /a)")


if __name__ == "__main__":
    main()
