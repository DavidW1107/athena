# Athena

A manager for Claude Code and Codex terminal instances. One window, grouped by repo,
with a colour banner per instance state and a queue of the ones blocked on you.

## How it works

Three moving parts, each owned by something that already exists:

- **tmux owns session lifetime.** Every instance is a detached tmux session named
  `athena_<id>`. Close Athena, kill Athena, log out: the sessions keep running and reattach
  on next launch.
- **`~/.athena/instances.json` owns intent.** Directory, command, group, and the Claude
  session id for each instance. Survives a reboot, so after a crash a dead instance shows
  a **restore** button that runs `claude --resume <session-id>` in a fresh tmux session.
- **Claude Code hooks own state.** `hooks/athena-state.js` is wired to `SessionStart`,
  `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `Notification`, `Stop` and `SessionEnd`,
  and writes one small JSON file per instance to `~/.athena/state/`. No output scraping.

States: `working` (green) · `needs-you` (amber, pulsing) · `idle` (grey) · `paused` (blue) ·
`dead` / `ended` (red).

## Setup

    sudo apt install -y tmux libwebkit2gtk-4.1-dev libgtk-3-dev librsvg2-dev \
                        libayatana-appindicator3-dev build-essential curl wget file libssl-dev
    npm install
    node hooks/install.js      # adds the state hook to ~/.claude/settings.json (backs it up first)
    npm run tauri dev

`node hooks/install.js --uninstall` removes just the Athena hook entries.

## Panels

- **Instances**: grouped by git repo. Click a card to attach its terminal. Pause sends
  `SIGSTOP` to the pane's foreground process group; resume sends `SIGCONT`.
- **Resume**: past Claude sessions for any directory Athena knows about, titled by their
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

## v1.2: adoption and drag

**Adopt a tmux session.** The `adopt` button lists every tmux session Athena did not create.
Adopting one renames it to `athena_<id>`, which is how it joins the fleet without a session-name
field threaded through every module. Renaming does not detach existing clients, so a terminal you
already have open on that session keeps working and Athena just becomes a second client.

An adopted agent was already running when Athena arrived, so its environment can never contain
`ATHENA_ID`. `hooks/athena-state.js` therefore falls back to asking tmux which session its pane is
in and taking the id from the session name. That is why an adopted instance reports state exactly
like a launched one.

**Import a running agent.** The common case on this machine is a dozen claudes in ordinary
terminal windows, none under tmux. Those cannot be moved without ptrace, so the adopt dialog's
first section does the other thing that reaches the same place: it reads the session id out of the
process's own argv (`claude --resume <id>`), stops the process, and starts `claude --resume <id>`
inside a tile. The conversation carries on from its transcript; only a turn in flight is lost.

Stopping happens **before** the resume, never after, because two live processes appending to one
transcript is exactly the corruption this is guarding against. A process started fresh has no id in
its argv and nothing in `/proc` reveals it, so Athena asks which transcript it is instead of
guessing: a wrong guess would resume somebody else's conversation.

**Adopt a bare process.** An agent running outside tmux can only be moved with `reptyr`, which
ptrace-attaches to the live process and relocates it onto a new pty. It needs
`kernel.yama.ptrace_scope` at 0, or `cap_sys_ptrace` granted to the reptyr binary alone, which is
the narrower of the two. **Athena never changes that setting for you.** `reptyr_check` reports what
is blocking and prints the exact command; you run it. The move can also kill the process it is
moving, so finish the turn first.

**Drag and drop.** Drag a sidebar card onto a pane in split mode to attach it there. Drag a pane's
header onto another pane to swap them. Dropping an instance that another pane already holds is a
swap rather than a steal, so no pane silently goes blank. Both panes are detached before either
re-attaches, because `pty.rs` keys one pty per instance id and attaching an id another pane still
holds would give both panes the same pty.

Dragging a real terminal *window* into Athena is not possible: reparenting a foreign window was an
X11 trick and Wayland removed it. Adoption is the substitute.

## v1.3: one screen, brighter, launchable from the desktop

**Every instance at once.** The sidebar and the single stage terminal are gone. The window is a
grid of tiles, one per repo group, and a group's instances are tabs inside its tile. Seven
instances across three repos is three tiles, not seven, so a busy repo never eats the screen.

A tile owns exactly one terminal. Switching tab re-points that terminal, so an inactive tab holds
no pty at all and tmux keeps its screen for the redraw. That is what makes an unbounded number of
instances affordable: cost scales with groups, not instances. Tiles never shrink below a readable
terminal; the grid scrolls instead. Drag a tile's header onto another tile to reorder, and the
order is remembered.

**Header, not sidebar.** Launch, adopt, the needs-you queue and the counts live in the top bar.
Resume, Codex and handoff became dialogs opened from there, so they cost screen only while open.

**Theme.** Athena runs the user's own terminal theme rather than an approximation of it: Ptyxis on
its "VS Code" profile, extracted from the palette Ptyxis ships in its gresource
(`/org/gnome/Ptyxis/palettes/Vs Code.palette`, `[Dark] Background=#1E1E1E Foreground=#CCCCCC`).
The app grounds on the same `#1E1E1E` with the VS Code Dark+ UI surfaces above it, the sixteen
ANSI colours in `src/term.js` are copied verbatim from that file, and the state colours are drawn
from the same set, so a green in a tile means what a green means in the shell next door.

Two earlier attempts used a warm brown-grey with muted pastels. That reads muddy, and a muddy
surface reads heavy, which is why "too dark" and "washed out" turned out to be one complaint: the
fix was a neutral ground with real chroma, not a lighter grey. Chrome text is lifted to `#f2f2f2`,
above the terminal's own `#CCCCCC`, so it reads in front of the output. Every state colour clears
WCAG AA on `#1E1E1E`. That palette file also carries a `[Light]` section
(`Background=#F9F9F9`), so a light variant is a `:root` swap away if it is ever wanted.

**Per-tile controls.** Each tile header carries a `+` that launches into that tile. The header's
`+ instance` does the opposite: it always gives the new instance its own tile, appending a counter
when the repo already has one, so "acmr-crm" and "acmr-crm 2" can sit side by side.

**Merge, scroll and fullscreen.** Drag an instance's tab onto another tile to move it there,
which is how two tiles that should have been one get merged. The wheel over a terminal scrolls that
pane's real history through tmux copy-mode, not the application: a wheel event that reaches Claude
Code is read as "cycle through past messages", which is not scrolling. Double click a tile header to fill the entire
window with it, header included, and again to put it back. The terminal re-measures and resizes
its pty, so the agent redraws at the new width rather than keeping the old character grid.

**Resize and zoom.** Drag a tile's bottom-right grip to resize it, snapping to whole grid cells so
the grid stays gapless: a free pixel size would take the tile out of its track and leave holes
around it. Ctrl and the wheel over a terminal changes that terminal's font size only, as do
ctrl-plus, ctrl-minus and ctrl-0 to reset. Both the span and the font size are remembered per tile
alongside the tile order, in `localStorage`.

**Desktop launcher.**

    npm run tauri build -- --no-bundle
    ./scripts/install-desktop.sh

That copies the binary to `~/.local/bin/athena`, installs the icon, and writes
`~/.local/share/applications/athena.desktop`. Nothing needs root. Athena is then searchable by
name from the desktop and pinnable to the dock. Re-run the script after each release build.

## Credits

The application icon is "Spartan helmet" by Delapouite from game-icons.net, used under CC BY 3.0,
which requires attribution. Full details, and the provenance of the colour palette, are in
[CREDITS.md](CREDITS.md).
