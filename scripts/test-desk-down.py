#!/usr/bin/env python3
"""The three bits of desk-down logic that are not obvious by reading. Run it directly:

    python3 scripts/test-desk-down.py

No framework, nothing touched outside a temp directory, no ssh: the one test that would otherwise
need a second machine fakes the far side instead.
"""
import importlib.util
import os
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location("desk_down", os.path.join(HERE, "desk-down.py"))
dd = importlib.util.module_from_spec(spec)
spec.loader.exec_module(dd)


def test_valid_sid():
    assert dd.valid_sid("7232e492-74e9-4f4f-9ea1-5b1b5f990998")
    # It is interpolated into a line typed into a pane, so everything that is not a session id goes.
    for bad in ["", "short", "../../etc/passwd", "$(rm -rf ~)", "a; tmux kill-server", "f" * 65]:
        assert not dd.valid_sid(bad), bad


def test_skipped_by_update_sees_what_rsync_hides():
    """A receiver-side file that is NEWER but DIFFERENT is what --update drops without a word."""
    with tempfile.TemporaryDirectory() as tmp:
        src, dst = os.path.join(tmp, "src"), os.path.join(tmp, "dst")
        os.makedirs(src), os.makedirs(dst)
        for d, text in ((src, "the work\n"), (dst, "the stale copy\n")):
            with open(os.path.join(d, "report.md"), "w") as f:
                f.write(text)
        os.utime(os.path.join(src, "report.md"), (0, 0))  # sender is older
        with open(os.path.join(src, "fresh.md"), "w") as f:
            f.write("only on the sender\n")

        assert dd.skipped_by_update(src + "/", dst + "/", []) == ["report.md"]
        # A file the receiver does not have is never skipped, so it must not be reported.
        assert "fresh.md" not in dd.skipped_by_update(src + "/", dst + "/", [])
        # Same content on both sides is not a skip, whatever the mtimes say. This is the case that
        # matters in practice: after one skip the two copies keep different mtimes for identical
        # bytes, and a detector that only looked at mtimes would refuse every move from then on.
        with open(os.path.join(dst, "report.md"), "w") as f:
            f.write("the work\n")
        assert dd.skipped_by_update(src + "/", dst + "/", []) == []


def test_no_terminal_never_powers_the_desktop_off():
    """With a session that cannot move and no tty to ask at, the machine must be left running."""
    calls = []
    # Everything replaced here is put back afterwards: these are module globals, and leaving a
    # stubbed `sh` behind made the next test silently pass against a shell that did nothing.
    saved = {n: getattr(dd, n) for n in ("desk_states", "read_reg", "sh", "down")}
    dd.desk_states = lambda: ({}, {"athena_live1"})
    dd.read_reg = lambda: [
        {"id": "live1", "name": "a shell", "cwd": "/home/drwalsh/x", "cmd": "bash", "host": dd.HOST},
    ]
    dd.sh = lambda script, remote: (calls.append(script), (True, ""))[1]
    dd.down = lambda *a, **k: True

    class NotATty:
        def isatty(self):
            return False

        def readline(self):  # input() would reach here; it must never be called
            raise AssertionError("asked a question with no terminal to answer it")

    real_stdin, sys.stdin = sys.stdin, NotATty()
    try:
        dd.main_down([])
    finally:
        sys.stdin = real_stdin
        for n, fn in saved.items():
            setattr(dd, n, fn)
    assert not any("shutdown.exe" in c for c in calls), calls


if __name__ == "__main__":
    for name, fn in sorted((n, f) for n, f in vars().copy().items() if n.startswith("test_")):
        fn()
        print(f"ok  {name}")
    print("all good")
