# Argus

A manager for Claude Code and Codex terminal instances. One window, grouped by repo,
with a colour banner per instance state and a queue of the ones blocked on you.

## How it works

Three moving parts, each owned by something that already exists:

- **tmux owns session lifetime.** Every instance is a detached tmux session named
  `argus_<id>`. Close Argus, kill Argus, log out: the sessions keep running and reattach
  on next launch.
- **`~/.argus/instances.json` owns intent.** Directory, command, group, and the Claude
  session id for each instance. Survives a reboot, so after a crash a dead instance shows
  a **restore** button that runs `claude --resume <session-id>` in a fresh tmux session.
- **Claude Code hooks own state.** `hooks/argus-state.js` is wired to `SessionStart`,
  `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `Notification`, `Stop` and `SessionEnd`,
  and writes one small JSON file per instance to `~/.argus/state/`. No output scraping.

States: `working` (green) · `needs-you` (amber, pulsing) · `idle` (grey) · `paused` (blue) ·
`dead` / `ended` (red).

## Setup

    sudo apt install -y tmux libwebkit2gtk-4.1-dev libgtk-3-dev librsvg2-dev \
                        libayatana-appindicator3-dev build-essential curl wget file libssl-dev
    npm install
    node hooks/install.js      # adds the state hook to ~/.claude/settings.json (backs it up first)
    npm run tauri dev

`node hooks/install.js --uninstall` removes just the Argus hook entries.

## Panels

- **Instances** — grouped by git repo. Click a card to attach its terminal. Pause sends
  `SIGSTOP` to the pane's foreground process group; resume sends `SIGCONT`.
- **Resume** — past Claude sessions for any directory Argus knows about, titled by their
  first real user message, one click to `claude --resume`.
- **Codex** — the `codex-task` runs in `~/.codex/tasks`, live status from their `status` file.

The header shows the `pbuild ls` pressure line and a **resume all** button.

## Not built yet

Split terminals (one attached at a time), broadcast-to-many, per-instance cost meters,
auto-pause triggers, cross-instance handoff. Add them when the daily use asks for them.
