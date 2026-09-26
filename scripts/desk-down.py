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

Git: history is never rsynced, in either direction, because two copies of .git merged file by file
is how a repository gets corrupted. Instead it moves as git:

  * coming home, the desktop's commits are FETCHED over ssh into the laptop repo and the branch moves
    up to them, leaving the working tree exactly as rsync delivered it, so an agent's commit arrives
    as a commit and its later edits arrive as uncommitted changes;
  * going out, the laptop's .git is MIRRORED to the desktop (--delete), the laptop being the single
    source of truth for history, but only after checking the desktop has no commits of its own to
    lose.

Either direction refuses the move rather than mangle a repository, and any commit it cannot place is
left on refs/desk-move/<instance id> so nothing is ever only on the other machine.
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
    # ponytail: read-modify-write with an atomic rename, no lock. What makes that survivable is not
    # that Athena writes rarely (its poll writes whenever it first sees a session_id or an account):
    # it is that list_instances re-reads the file and copies only those two fields forward, so a poll
    # mid-flight cannot put host="desk" back over this. See registry.rs, commit 6559e27.
    reg = read_reg()
    for inst in reg:
        if inst["id"] == iid:
            inst.update(fields)
    tmp = REG + ".desk-move"
    with open(tmp, "w") as f:
        json.dump(reg, f, indent=2)
    os.replace(tmp, REG)


def valid_sid(sid):
    """A session id is interpolated into the resume line that gets typed into a pane, so it is
    checked rather than trusted, exactly as accounts.rs::move_to checks it."""
    return bool(sid) and 8 <= len(sid) <= 64 and all(c in "0123456789abcdefABCDEF-" for c in sid)


def digests(loc, paths):
    """md5 for each path under `loc`, which is either a local directory or `host:/dir`."""
    if not paths:
        return {}
    remote = ":" in loc.split("/", 1)[0]
    root = loc.split(":", 1)[1] if remote else loc
    listing = " ".join(shlex.quote(p) for p in paths)
    _, out = sh(f"cd {shlex.quote(root)} && md5sum -- {listing} 2>/dev/null", remote)
    got = {}
    for line in out.splitlines():
        h, _, p = line.partition("  ")
        if p:
            got[p] = h
    return got


def skipped_by_update(src, dst, excludes):
    """Paths `--update` would silently leave behind: the receiver's copy is newer AND differs.

    rsync says nothing about a file it skips, so without this a move reports "0 file(s) back", kills
    the session and shuts the machine down while the work sits on the far side.

    Two dry passes give the candidates: everything rsync would send, minus what --update would
    actually send. That set is then confirmed by content, because rsync compares size and mtime, and
    after one skip the two copies keep DIFFERENT mtimes for identical bytes for ever after: without
    the checksum this would refuse every later move over a file nobody has touched. The checksum
    only ever runs on the handful of candidates, never the whole tree.
    """
    ex = [f"--exclude={e}" for e in excludes]
    pick = lambda out: {l.split(" ", 1)[1] for l in out.splitlines() if l[:2] in (">f", "<f")}
    cands = pick(run("rsync", "-ain", *ex, src, dst).stdout) - pick(run("rsync", "-ain", "--update", *ex, src, dst).stdout)
    if not cands:
        return []
    here, there = digests(src, cands), digests(dst, cands)
    return sorted(p for p in cands if here.get(p) != there.get(p))


def git_at(path, remote, *args):
    ok, out = sh(f"git -C {shlex.quote(path)} {' '.join(args)} 2>/dev/null", remote)
    return out.strip() if ok else None


def keep_ref(iid):
    return f"refs/desk-move/{iid}"


def fetch_their_commits(iid, their_top, our_top, host_label):
    """Pull the far side's commits into a local ref. Returns (ref, error)."""
    ref = keep_ref(iid)
    p = run("git", "-C", our_top, "fetch", "--no-tags", f"ssh://{HOST}{their_top}", f"+HEAD:{ref}")
    if p.returncode:
        return None, f"could not fetch commits from {host_label}: {p.stderr.strip().splitlines()[-1:] or ''}"
    return ref, None


def commits_home_check(iid, dcwd, lcwd):
    """Can the desktop's commits land here? Returns (ok, plan, message).

    Runs BEFORE any file is copied, because a refusal has to leave both machines as they were: an
    earlier version rsynced the tree first and a git refusal then left the laptop holding desktop
    files from a move that had officially not happened. The only thing this mutates is a keep ref,
    which is how the commits stop being only on the desktop even when the move fails.
    """
    dtop, ltop = git_at(dcwd, True, "rev-parse", "--show-toplevel"), git_at(lcwd, False, "rev-parse", "--show-toplevel")
    if not dtop:
        return True, None, None  # not a repo there, nothing to carry
    if not ltop:
        return False, None, f"{dcwd} is a git repo on {HOST} but {lcwd} is not one here"
    dhead, lhead = git_at(dtop, True, "rev-parse", "HEAD"), git_at(ltop, False, "rev-parse", "HEAD")
    if not dhead or dhead == lhead:
        return True, None, None
    ref, err = fetch_their_commits(iid, dtop, ltop, HOST)
    if err:
        return False, None, err
    # The desktop can also be BEHIND, which is the normal state after a move was resolved here: its
    # commits are already in this history, so there is nothing to carry and the move is free to go on.
    if lhead and run("git", "-C", ltop, "merge-base", "--is-ancestor", ref, lhead).returncode == 0:
        run("git", "-C", ltop, "update-ref", "-d", ref)
        return True, None, None
    if lhead and run("git", "-C", ltop, "merge-base", "--is-ancestor", lhead, ref).returncode:
        return False, None, (f"{HOST} has commits this repo cannot fast-forward onto. They are safe on "
                             f"{ref} in {ltop}; merge or rebase them there, then move again")
    return True, (ltop, ref, dhead), None


def commits_home_apply(plan):
    """Move the branch onto the fetched commits, once the files are here. Returns (ok, message)."""
    if not plan:
        return True, None
    ltop, ref, dhead = plan
    # --mixed, not --ff-only: the working tree now holds what rsync brought from the desktop, and a
    # merge would refuse to overwrite it. This moves the branch and leaves the files alone, so a
    # commit arrives as a commit and anything edited after it arrives as an uncommitted change.
    if run("git", "-C", ltop, "reset", "--mixed", ref).returncode:
        return False, f"could not move {ltop} onto the desktop's commits; they are on {ref}"
    run("git", "-C", ltop, "update-ref", "-d", ref)
    return True, f"took commit {dhead[:8]} from {HOST}"


def mirror_git_check(iid, lcwd, dcwd):
    """Would mirroring this .git outwards destroy commits only the desktop has? (ok, ltop, message)"""
    ltop = git_at(lcwd, False, "rev-parse", "--show-toplevel")
    if not ltop:
        return True, None, None
    dtop = git_at(dcwd, True, "rev-parse", "--show-toplevel")
    if dtop:
        dhead, lhead = git_at(dtop, True, "rev-parse", "HEAD"), git_at(ltop, False, "rev-parse", "HEAD")
        if dhead and dhead != lhead:
            # The desktop is ahead or has diverged. Mirroring over it would destroy those commits, so
            # they are fetched here first and the move refuses either way: if they are already in this
            # history the mirror is safe, otherwise a human decides.
            ref, err = fetch_their_commits(iid, dtop, ltop, HOST)
            if err:
                return False, None, err
            if run("git", "-C", ltop, "merge-base", "--is-ancestor", ref, "HEAD").returncode:
                return False, None, (f"{HOST} already has commits this repo does not: they are on {ref} "
                                     f"in {ltop}. Take them first, then send this instance out again")
            run("git", "-C", ltop, "update-ref", "-d", ref)
    return True, ltop, None


def mirror_git_out(ltop):
    """The laptop's .git onto the desktop. One-way and exact, because a .git merged file by file is
    how a repository gets corrupted; the laptop is the single source of truth for history."""
    if not ltop:
        return True, None
    p = run("rsync", "-a", "--delete", "--mkpath", f"{ltop}/.git/", f"{HOST}:{to_desk(ltop)}/.git/")
    if p.returncode:
        return False, f"could not mirror .git to {HOST}: {p.stderr.strip()}"
    return True, None


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
    if not valid_sid(sid):
        print(f"    {sid!r} is not a session id; left there")
        return False
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
        # Anything --update would drop silently stops the move instead: this is the only chance to
        # notice, because the next steps kill the session and can power the machine off.
        ok, plan, msg = commits_home_check(iid, dcwd, lcwd)
        if not ok:
            print(f"    {msg}; claude stopped but NOT moved")
            return False
        stale = skipped_by_update(f"{HOST}:{dcwd}/", f"{lcwd}/", PULL_EXCLUDES)
        if stale:
            print(f"    {len(stale)} file(s) changed on {HOST} but are OLDER than this laptop's copy, "
                  f"so rsync would drop them; claude stopped but NOT moved:")
            for f in stale[:20]:
                print(f"      {f}")
            return False
        p = run("rsync", "-a", "--update", "--mkpath", "--itemize-changes",
                *[f"--exclude={e}" for e in PULL_EXCLUDES], f"{HOST}:{dcwd}/", f"{lcwd}/")
        if p.returncode:
            print(f"    file sync failed, claude stopped but NOT moved: {p.stderr.strip()}")
            return False
        changed = [l.split(" ", 1)[1] for l in p.stdout.splitlines() if l.startswith(">f")]
        print(f"    {len(changed)} file(s) back" + (": " + ", ".join(changed[:8]) if changed else ""))
        ok, msg = commits_home_apply(plan)
        if not ok:
            print(f"    {msg}; the files are here but the history is not")
            return False
        if msg:
            print(f"    {msg}")
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
    # The desktop's own hook file would otherwise sit there and be read as this instance's live state
    # the next time it goes back, ahead of the new session's first write. up() clears it the same way.
    sh(f"rm -f ~/.athena/state/{shlex.quote(iid)}.json", remote=True)
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
    if not inst["cmd"].startswith("claude") or not valid_sid(sid):
        print("    not a claude session with a usable resume id; left here")
        return False
    if dry:
        print(f"    would {'stop claude, ' if live else ''}{'sync the tree, ' if sync else ''}"
              f"copy transcript {sid}, resume on {HOST}")
        return True

    if live and not stop_claude(sess, remote=False):
        print("    claude here did not exit; left here")
        return False
    if sync:
        # .git is mirrored separately, below: merging two copies of it file by file is how a
        # repository gets corrupted, and --update would do exactly that.
        excl = PUSH_EXCLUDES + [".git/"]
        ok, ltop, msg = mirror_git_check(iid, lcwd, dcwd)
        if not ok:
            print(f"    {msg}; NOT moved")
            return False
        stale = skipped_by_update(f"{lcwd}/", f"{HOST}:{dcwd}/", excl)
        if stale:
            print(f"    {len(stale)} file(s) on {HOST} are NEWER than this laptop's copy but differ, "
                  f"so rsync would leave the desktop's version in place; NOT moved:")
            for f in stale[:20]:
                print(f"      {f}")
            return False
        p = run("rsync", "-a", "--update", "--mkpath", "--itemize-changes",
                *[f"--exclude={e}" for e in excl], f"{lcwd}/", f"{HOST}:{dcwd}/")
        if p.returncode:
            print(f"    file sync failed, NOT moved: {p.stderr.strip()}")
            return False
        n = sum(1 for l in p.stdout.splitlines() if l.startswith("<f"))
        print(f"    {n} file(s) out")
        ok, msg = mirror_git_out(ltop)
        if not ok:
            print(f"    {msg}; the files are out but the history is not")
            return False
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
        if inst.get("host") != HOST:
            continue
        # A session that already died on the desktop is still worth moving: its working tree is on a
        # machine about to be switched off, and leaving the record pointing at `desk` means tomorrow's
        # restore aims at a powered-down box. stop_claude is a no-op when there is no session.
        st = states.get(inst["id"], {})
        claude = inst["cmd"].startswith("claude")
        (movable if claude and (inst.get("session_id") or st.get("session_id")) else stranded).append((inst, st))

    print(f"{len(movable)} to bring home {'parked' if park else 'and resume'}, {len(stranded)} that cannot move")
    doomed = [i for i, _ in stranded if f"athena_{i['id']}" in live]
    for inst, _ in stranded:
        alive = f"athena_{inst['id']}" in live
        print(f"  {'stays and dies' if alive else 'already dead there'}: "
              f"{inst['name']} ({inst['cmd']}) in {inst['cwd']}")
    # Only a session still RUNNING there is worth asking about. One that has already exited loses
    # nothing to the power switch, and asking about it trains the answer out of you.
    if doomed and not dry and not stay:
        # No terminal means no answer, and the safe answer is not to power off over someone's work.
        # This is what lets the script run from a hook or a schedule at all.
        if not sys.stdin.isatty():
            stay = True
            print("nothing can be asked here (no terminal); moving what can move, leaving it on")
        elif input("Shut down anyway? [y/N] ").strip().lower() != "y":
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
