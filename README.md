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

- **Instances**: grouped by git repo. Click a card to attach its terminal. Pause sends
  `SIGSTOP` to the pane's foreground process group; resume sends `SIGCONT`.
- **Resume**: past Claude sessions for any directory Argus knows about, titled by their
  first real user message, one click to `claude --resume`.
- **Codex**: the `codex-task` runs in `~/.codex/tasks`, live status from their `status` file.

The header shows the `pbuild ls` pressure line and a **resume all** button.

## v1.1

- **Split panes.** The **split** button in the header turns the stage into a 1 / 2 / 4 grid,
  each pane attached to a different instance. One owner at a time: in split mode the grid
  holds every pty, and switching back to single re-attaches the selected instance.
- **Broadcast.** One prompt, typed once, delivered to a checked set of live instances. A
  multi-line prompt is pasted with bracketed paste, so an agent reads it as one turn; a
  plain `bash` instance has no bracketed-paste mode and runs each line.
- **Context burn.** A header readout for the hottest session and a disclosure with one row
  per live instance: input, output, cache share, current window occupancy and its
  percentage, read from the Claude transcript. Nothing is priced; the plan is a
  subscription, so the only question is which instance needs a compact.
- **Handoff.** Take the last n messages of one instance's conversation and paste them into
  another as a single prompt. An instance cannot be handed its own history, and a dead
  target is refused before anything is typed.
- **Auto-pause.** Three rules with a log of the last ten actions and the reason for each:
  memory pressure over a PSI threshold, an instance waiting on another pbuild shard, and a
  session blocked on you for too long. Nothing mid-turn is ever stopped, because a stopped
  process cannot service its own sockets and the live API call would time out.
