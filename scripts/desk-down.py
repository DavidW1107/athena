#!/usr/bin/env python3
"""Move Athena's Claude instances between the laptop and the desktop.

    desk-down             bring every desktop instance home PARKED, then shut the desktop down
    desk-down --continue  bring them home and resume them here instead of parking
    desk-down --stay-on   either of the above, but leave the desktop running
    desk-down -n          show what would happen, touch nothing
    desk-up               send every parked instance to the desktop and resume it there
    desk-up <id>...       send these laptop instances (parked or live) to the desktop

An instance moves as its conversation plus the files it changed: claude is stopped where it runs,
the working tree and transcript are rsynced across, the registry record flips host, and the
session is resumed on the other side in the same Athena tile. A PARKED instance has come home but
runs nothing: no tmux session, so zero laptop load. Athena shows it with "continue here" (resume on
the laptop) and "to desk" (this script's desk-up). Anything that is not claude (a bare shell,
codex) has no resume id to carry, so desk-down lists it and it dies with the machine.

Paths: WSL resolves /home/david to /home/drwalsh, so desktop paths live under /home/drwalsh and
laptop paths under /home/david. Claude files a transcript under a slug of the resolved cwd, so the
transcript moves to the slug of the mapped path, which is where `claude --resume` looks for it.

Git: .git goes TO the desktop (an agent there needs status, diff, commit) but never comes back;
the laptop's history is the truth. ponytail: a commit made on the desktop therefore comes home as
uncommitted changes in the working tree, nothing lost, but the commit itself is. Push from the
desktop, or commit on the laptop, if that ever matters.
"""
import json
import os
import shlex
import subprocess
import sys

HOST = os.environ.get("DESK_HOST", "desk")
HOME = os.path.expanduser("~")
REG = os.path.join(HOME, ".athena", "instances.json")
STATE = os.path.join(HOME, ".athena", "state")
REPOS = os.path.join(HOME, "Documents", "GitHub")
PROJECTS = os.path.join(HOME, ".claude", "projects")  # every account's projects/ links here
MOVED = "This session was moved from the {src} to the {dst} mid-task. Carry on from where you stopped."
# Build output is rebuilt where it is needed. Dependencies travel TO the desktop (so tests run
# there without an install) but never come back over the laptop's own.
BUILD = ["dist/", ".next/", ".vite/", "__pycache__/", "*.swp"]
PULL_EXCLUDES = BUILD + [".git/", "node_modules/"]
PUSH_EXCLUDES = BUILD


def slug(path):
    return "".join(c if c.isalnum() else "-" for c in path)


def to_laptop(path):
    return "/home/david" + path[len("/home/drwalsh"):] if path.startswith("/home/drwalsh") else path


def to_desk(path):
    return "/home/drwalsh" + path[len("/home/david"):] if path.startswith("/home/david") else path


def sh(script, remote):
    """Run a shell script here or on the desktop, return (ok, stdout)."""
    cmd = (["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=6", HOST, script] if remote
           else ["sh", "-c", script])
    p = subprocess.run(cmd, capture_output=True, text=True)
    return p.returncode == 0, p.stdout


def run(*cmd):
    return subprocess.run(cmd, capture_output=True, text=True)


def read_reg():
    with open(REG) as f:
        return json.load(f)


def update_reg(iid, **fields):
    # ponytail: read-modify-write with an atomic rename, no lock. Athena writes this file only on
    # launch/close/account moves, so a clash needs one of those in the same few milliseconds.
    reg = read_reg()
    for inst in reg:
        if inst["id"] == iid:
            inst.update(fields)
    tmp = REG + ".desk-move"
    with open(tmp, "w") as f:
        json.dump(reg, f, indent=2)
    os.replace(tmp, REG)


def stop_claude(sess, remote):
    """Stop every claude on the pane's terminal, TERM then KILL, as accounts.rs::move_to does.
    No session, or no claude in it, is success: there is nothing left to append to the transcript."""
    ok, _ = sh(f"""tty=$(tmux display-message -p -t {shlex.quote(sess)} '#{{pane_tty}}' 2>/dev/null) || exit 0
for pid in $(pgrep -t "${{tty#/dev/}}" -x claude); do
  kill -TERM $pid; kill -CONT $pid
  for i in $(seq 30); do kill -0 $pid 2>/dev/null || continue 2; sleep 0.1; done
  kill -KILL $pid
  for i in $(seq 30); do kill -0 $pid 2>/dev/null || continue 2; sleep 0.1; done
  exit 1
done""", remote)
    return ok


def resume_line(account, sid, prompt=None):
    line = f"claude --resume {sid}" + (f" {shlex.quote(prompt)}" if prompt else "")
    if not account or account == "a":
        return f"env -u CLAUDE_CONFIG_DIR {line}"  # see accounts.rs::on_account
    return f"CLAUDE_CONFIG_DIR={HOME}/.claude-{account} {line}"


def start(inst, cwd, line, remote):
    """Create the instance's tmux session where it now lives and type the resume line into it."""
    sess, q = f"athena_{inst['id']}", shlex.quote
    prep = ("tmux start-server; tmux set -g history-limit 50000; tmux set -g status off; "
            "tmux set -g window-size latest; " if remote else "")  # tmux.rs::ensure_server_options_on
    ok, _ = sh(f"{prep}tmux new-session -d -s {q(sess)} -c {q(cwd)} -e ATHENA_ID={q(inst['id'])} "
               f"-e ATHENA_NAME={q(inst['name'])} && tmux send-keys -t {q(sess)} {q(line)} Enter", remote)
    return ok


def copy_transcript(sid, src, dst):
    p = run("rsync", "-a", "--mkpath", "--ignore-missing-args", f"{src}{sid}.jsonl", f"{src}{sid}", dst)
    return p.returncode == 0, p.stderr.strip()


def down(inst, state, dry, park):
    """Desktop -> laptop."""
    iid, sess = inst["id"], f"athena_{inst['id']}"
    sid = inst.get("session_id") or state.get("session_id")
    dcwd, lcwd = inst["cwd"], to_laptop(inst["cwd"])
    was = state.get("state") or "idle"
    sync = lcwd.startswith(REPOS + "/")
    print(f"  {inst['name']}: {dcwd} -> {lcwd} ({was})")
    if dry:
        print(f"    would stop claude, {'sync the tree, ' if sync else ''}copy transcript {sid}, "
              + ("park it here" if park else "resume it here"))
        return True

    if not stop_claude(sess, remote=True):
        print("    claude on the desktop did not exit; left there")
        return False
    if sync:
        # --update: a file only comes back if the desktop's copy is newer, so an edit made here
        # since it was pushed out is kept. Deletions on the desktop are not carried back.
        p = run("rsync", "-a", "--update", "--mkpath", "--itemize-changes",
                *[f"--exclude={e}" for e in PULL_EXCLUDES], f"{HOST}:{dcwd}/", f"{lcwd}/")
        if p.returncode:
            print(f"    file sync failed, claude stopped but NOT moved: {p.stderr.strip()}")
            return False
        changed = [l.split(" ", 1)[1] for l in p.stdout.splitlines() if l.startswith(">f")]
        print(f"    {len(changed)} file(s) back" + (": " + ", ".join(changed[:8]) if changed else ""))
    elif not os.path.isdir(lcwd):
        print(f"    {lcwd} does not exist here; claude stopped but NOT moved")
        return False
    ok, err = copy_transcript(sid, f"{HOST}:.claude/projects/{slug(dcwd)}/", f"{PROJECTS}/{slug(lcwd)}/")
    if not ok or not os.path.exists(f"{PROJECTS}/{slug(lcwd)}/{sid}.jsonl"):
        print(f"    transcript copy failed, claude stopped but NOT moved: {err}")
        return False

    # `parked` remembers whether it was mid-task, so whichever side resumes it says "carry on".
    update_reg(iid, host=None, cwd=lcwd, session_id=sid, parked=was if park else None)
    try:
        os.remove(os.path.join(STATE, f"{iid}.json"))  # stale, from an old run here
    except FileNotFoundError:
        pass
    sh(f"tmux kill-session -t {shlex.quote(sess)}", remote=True)
    if park:
        print("    parked on the laptop")
        return True
    prompt = MOVED.format(src="desktop", dst="laptop") if was == "working" else None
    if not start(inst, lcwd, resume_line(inst.get("account"), sid, prompt), remote=False):
        print("    moved, but the local tmux session failed; use continue here on the tile")
    else:
        print("    resumed on the laptop")
    return True


def up(inst, dry):
    """Laptop -> desktop. Works on a parked instance and on a live one alike."""
    iid, sess = inst["id"], f"athena_{inst['id']}"
    sid = inst.get("session_id")
    lcwd, dcwd = inst["cwd"], to_desk(inst["cwd"])
    live = run("tmux", "has-session", "-t", sess).returncode == 0
    try:
        with open(os.path.join(STATE, f"{iid}.json")) as f:
            now_state = json.load(f).get("state")
    except (OSError, ValueError):
        now_state = None
    working = (now_state == "working") if live else (inst.get("parked") == "working")
    sync = lcwd.startswith(REPOS + "/")
    print(f"  {inst['name']}: {lcwd} -> {dcwd} ({'live' if live else 'parked'}{', working' if working else ''})")
    if not inst["cmd"].startswith("claude") or not sid:
        print("    not a claude session with a resume id; left here")
        return False
    if dry:
        print(f"    would {'stop claude, ' if live else ''}{'sync the tree, ' if sync else ''}"
              f"copy transcript {sid}, resume on {HOST}")
        return True

    if live and not stop_claude(sess, remote=False):
        print("    claude here did not exit; left here")
        return False
    if sync:
        p = run("rsync", "-a", "--update", "--mkpath", "--itemize-changes",
                *[f"--exclude={e}" for e in PUSH_EXCLUDES], f"{lcwd}/", f"{HOST}:{dcwd}/")
        if p.returncode:
            print(f"    file sync failed, NOT moved: {p.stderr.strip()}")
            return False
        n = sum(1 for l in p.stdout.splitlines() if l.startswith("<f"))
        print(f"    {n} file(s) out")
    else:
        ok, _ = sh(f"test -d {shlex.quote(dcwd)}", remote=True)
        if not ok:
            print(f"    {dcwd} does not exist on {HOST}; NOT moved")
            return False
    ok, err = copy_transcript(sid, f"{PROJECTS}/{slug(lcwd)}/", f"{HOST}:.claude/projects/{slug(dcwd)}/")
    if not ok:
        print(f"    transcript copy failed, NOT moved: {err}")
        return False

    update_reg(iid, host=HOST, cwd=dcwd, session_id=sid, parked=None)
    sh(f"rm -f ~/.athena/state/{shlex.quote(iid)}.json", remote=True)
    prompt = MOVED.format(src="laptop", dst="desktop") if working else None
    if live:
        run("tmux", "kill-session", "-t", sess)
    if not start(inst, dcwd, resume_line(inst.get("account"), sid, prompt), remote=True):
        print(f"    moved, but the tmux session on {HOST} failed; use restore on the tile")
    else:
        print(f"    resumed on {HOST}")
    return True


def desk_states():
    """Every hook state on the desktop plus its live athena sessions, in one round trip."""
    _, out = sh("for f in ~/.athena/state/*.json; do [ -e \"$f\" ] && printf 'ID %s\\t%s\\n' "
                "\"$(basename \"$f\" .json)\" \"$(tr -d '\\n' < \"$f\")\"; done; "
                "tmux ls -F '#{session_name}' 2>/dev/null", remote=True)
    states, live = {}, set()
    for l in out.splitlines():
        if l.startswith("ID ") and "\t" in l:
            iid, blob = l[3:].split("\t", 1)
            try:
                states[iid] = json.loads(blob)
            except ValueError:
                pass  # a half-written hook file reads as no state, same as Athena
        elif l.startswith("athena_"):
            live.add(l)
    return states, live


def main_down(args):
    dry, stay, park = "-n" in args, "--stay-on" in args, "--continue" not in args
    states, live = desk_states()
    movable, stranded = [], []
    for inst in read_reg():
        if inst.get("host") != HOST or f"athena_{inst['id']}" not in live:
            continue  # not there, or already dead there; restore brings it back tomorrow
        st = states.get(inst["id"], {})
        claude = inst["cmd"].startswith("claude")
        (movable if claude and (inst.get("session_id") or st.get("session_id")) else stranded).append((inst, st))

    print(f"{len(movable)} to bring home {'parked' if park else 'and resume'}, {len(stranded)} that cannot move")
    for inst, _ in stranded:
        print(f"  stays and dies: {inst['name']} ({inst['cmd']}) in {inst['cwd']}")
    if stranded and not dry and not stay:
        if input("Shut down anyway? [y/N] ").strip().lower() != "y":
            stay = True
            print("Moving what can move, leaving the desktop on.")

    failed = [inst for inst, st in movable if not down(inst, st, dry, park)]
    if dry:
        print("dry run: nothing touched" + ("" if stay else f", would shut {HOST} down"))
        return
    if failed:
        sys.exit(f"desk-down: {len(failed)} did not move, so {HOST} was left on")
    if stay:
        return
    sh("sync; /mnt/c/Windows/System32/shutdown.exe /s /t 15 /c 'desk-down from the laptop'", remote=True)
    print(f"{HOST} shutting down in 15s (cancel on it with: shutdown /a)")


def main_up(args):
    dry = "-n" in args
    ids = [a for a in args if not a.startswith("-")]
    reg = [i for i in read_reg() if not i.get("host")]
    todo = [i for i in reg if i["id"] in ids] if ids else [i for i in reg if i.get("parked")]
    missing = set(ids) - {i["id"] for i in todo}
    if missing:
        sys.exit(f"desk-up: not a laptop instance: {', '.join(sorted(missing))}")
    print(f"{len(todo)} to send to {HOST}")
    failed = [i for i in todo if not up(i, dry)]
    if failed:
        sys.exit(f"desk-up: {len(failed)} did not move")


def main():
    if not sh("true", remote=True)[0]:
        sys.exit(f"{HOST} is not answering (off, signed out, or the cable)")
    args = sys.argv[1:]
    (main_up if os.path.basename(sys.argv[0]).startswith("desk-up") else main_down)(args)


if __name__ == "__main__":
    main()
