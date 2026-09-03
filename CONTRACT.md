# Athena v1.1 foundation contract

Frozen interface for the v1.1 parallel build. Everything below already exists on disk and
compiles (`npm run build` and `cargo check` both pass). A feature shard writes only the files
it owns and reads this document for everything else.

## The one rule

A shard creates new files. It never edits a file it does not own.

| File | Owner | Why |
|---|---|---|
| `src-tauri/src/main.rs` | integration only | convergence point: `mod` lines + `invoke_handler` list |
| `src/main.js` | integration only | convergence point: imports + mount calls |
| `index.html` | nobody | every mount element already exists |
| `src/style.css` | nobody | a shard imports its own CSS from its own JS module |
| `src/api.js` `src/store.js` `src/term.js` `src/cards.js` `src/launcher.js` | nobody | foundation |
| `src-tauri/src/{util,tmux,registry,sessions,lanes,pty}.rs` | nobody | foundation |

A shard that needs a new Rust command puts it in its own `.rs` file. Integration adds the
`mod` line and the handler entry. A shard that needs a new UI puts it in its own `.js` file
exporting one mount function. Integration adds the import and the one-line call.

## Shard registry

| Shard | Mount element | JS module | Exported mount fn | Own CSS | Own Rust |
|---|---|---|---|---|---|
| panes | `#mount-panes` | `src/panes.js` | `mountPanes(el, opts?)` | `src/panes.css` | none |
| broadcast | `#mount-broadcast` | `src/broadcast.js` | `mountBroadcast(el, opts?)` | `src/broadcast.css` | `src-tauri/src/broadcast.rs` |
| cost | `#mount-cost` | `src/cost.js` | `mountCost(el, opts?)` | `src/cost.css` | `src-tauri/src/cost.rs` |
| handoff | `#mount-handoff` | `src/handoff.js` | `mountHandoff(el, opts?)` | `src/handoff.css` | `src-tauri/src/handoff.rs` |
| autopause | `#mount-autopause` | `src/autopause.js` | `mountAutopause(el, opts?)` | `src/autopause.css` | `src-tauri/src/autopause.rs` |

Every mount function has the same shape:

```js
// src/panes.js
import './panes.css';
import * as store from './store.js';

export function mountPanes(host, opts = {}) {
  // build DOM into `host`, subscribe to the store, return a teardown
  return { destroy() {} };
}
```

`host` is guaranteed to exist and to be empty. `.mount:empty { display: none }` is already in
`style.css`, so an unfilled mount takes no layout. Nothing else is guaranteed about the host,
so a shard sets its own display, padding and background from its own CSS file.

## Mount elements (already in `index.html`)

```
header
  #mount-cost         inline span in the header bar, right of the counts
  #mount-autopause    inline span in the header bar, left of the pressure readout
#attention            existing needs-you strip
#mount-broadcast      full-width block under the attention strip, above <main>
main > aside
  .tabs, #tab-instances, #tab-sessions, #tab-codex
  #mount-handoff      block at the foot of the left rail, under the tab panes
main > section.stage
  #stage-bar
  #mount-panes        flex:1 block above #term; filling it hides #term automatically
  #term               the single-terminal stage
```

`#mount-panes` has a companion rule: `#mount-panes:not(:empty) ~ #term { display: none }`.
The panes shard does not need to touch `#term`; filling its own mount is enough.

---

# Rust API

Six foundation modules. Every item listed is `pub`.

## `util.rs`

```rust
pub fn home() -> PathBuf;                              // $HOME, empty PathBuf if unset
pub fn athena_dir() -> PathBuf;                         // ~/.athena, creates ~/.athena/state
pub fn now() -> u64;                                   // unix seconds
pub fn proc_stat_fields(pid: i32) -> Option<Vec<String>>;
```

`proc_stat_fields` returns the whitespace fields of `/proc/<pid>/stat` **after** the comm
field, so index 0 is the process state letter and index 5 is `tpgid`.

## `tmux.rs`

```rust
pub fn tmux(args: &[&str]) -> Option<std::process::Output>;
pub fn sess_name(id: &str) -> String;                  // "athena_<id>"
pub fn tmux_alive(sess: &str) -> bool;
pub fn pane_pid(sess: &str) -> Option<i32>;            // first pane's pid
pub fn fg_pgid(sess: &str) -> Option<i32>;             // foreground pgid of the pane tty
pub fn pane_map() -> HashMap<String, i32>;             // session name -> first pane pid, one call
pub fn tpgid_of(pid: i32) -> Option<i32>;
pub fn is_stopped_pid(pane: i32) -> bool;              // pane's fg job is in state T
pub fn signal_group(pgid: i32, sig: &str) -> bool;     // kill -<sig> -<pgid>
pub fn git_group(cwd: &str) -> String;                 // repo dir name, else cwd basename
pub fn tmux_run(args: &[&str]) -> Result<(), String>;  // one call, failure named
pub fn send_block(sess: &str, tag: &str, text: &str) -> Result<(), String>;
```

`send_block` is how anything delivers a prompt: one line is typed, a multi-line block is
pasted with bracketed paste so an agent TUI reads it as one prompt, then exactly one Enter.
Never assemble that from `send-keys` in a shard. See Integration decision 2.

Anything that talks to tmux goes through `tmux()`. Do not shell out to tmux from a shard file.
`pane_map()` is the affordable fleet-wide probe; per-instance `tmux_alive` in a loop is not.

## `registry.rs`

```rust
pub struct Instance {                                  // Serialize + Deserialize + Clone + Debug
    pub id: String,
    pub name: String,
    pub cwd: String,
    pub group: String,
    pub cmd: String,
    pub session_id: Option<String>,                    // serde default
    pub created: u64,                                  // serde default
}

pub struct HookState {                                 // Serialize + Deserialize + Clone + Default
    pub session_id: Option<String>,
    pub state: Option<String>,
    pub tool: Option<String>,
    pub summary: Option<String>,
    pub ts: Option<u64>,
}

pub struct InstanceView {                              // Serialize + Clone + Debug
    pub id: String,
    pub name: String,
    pub cwd: String,
    pub group: String,
    pub cmd: String,
    pub created: u64,
    pub session_id: Option<String>,
    pub alive: bool,
    pub paused: bool,
    pub state: String,
    pub tool: Option<String>,
    pub summary: Option<String>,
    pub idle_secs: u64,
}

pub fn reg_path() -> PathBuf;                          // ~/.athena/instances.json
pub fn read_reg() -> Vec<Instance>;
pub fn write_reg(v: &[Instance]);
pub fn read_state(id: &str) -> HookState;              // ~/.athena/state/<id>.json

#[tauri::command] pub fn list_instances() -> Vec<InstanceView>;
#[tauri::command] pub fn launch(cwd: String, cmd: String, name: String) -> Result<InstanceView, String>;
#[tauri::command] pub fn restore(id: String) -> Result<(), String>;
#[tauri::command] pub fn close(id: String) -> Result<(), String>;
#[tauri::command] pub fn set_paused(id: String, paused: bool) -> Result<(), String>;
#[tauri::command] pub fn send_text(id: String, text: String) -> Result<(), String>;
#[tauri::command] pub fn send_key(id: String, key: String) -> Result<(), String>;
#[tauri::command] pub fn list_repos() -> Vec<String>;
```

`state` is one of `working` / `needs-you` / `idle` / `dead` / `ended` / `paused`. `dead` and
`paused` are computed from tmux and `/proc`; the rest come from the hook file. The hook is the
only place a Claude resume id ever appears, and `list_instances` persists it into the registry
the first time it sees one.

A shard command that needs to mutate the registry must `read_reg()`, edit, `write_reg()`. There
is no lock; keep the read-modify-write inside one command call.

## `sessions.rs`

```rust
pub struct PastSession {                               // Serialize + Clone
    pub session_id: String,
    pub title: String,
    pub mtime: u64,
    pub cwd: String,
}

pub fn project_slug(cwd: &str) -> String;              // non-alphanumerics -> '-'
pub fn first_user_text(path: &PathBuf) -> Option<String>;   // first real user prompt, 90 chars

#[tauri::command] pub fn past_sessions(cwd: String) -> Vec<PastSession>;   // newest first, max 40
#[tauri::command] pub fn resume_session(cwd: String, session_id: String, name: String) -> Result<InstanceView, String>;
```

Transcripts live at `~/.claude/projects/<project_slug(cwd)>/<session_id>.jsonl`.

## `lanes.rs`

```rust
pub struct CodexTask {                                 // Serialize + Clone
    pub name: String,
    pub dir: String,
    pub status: String,                                // "done" | "exit <n>" | "running"
    pub mtime: u64,
    pub tail: String,                                  // last 3 lines of last.txt, 160 chars
}

#[tauri::command] pub fn codex_tasks() -> Vec<CodexTask>;   // newest first, max 15
#[tauri::command] pub fn pbuild_status() -> String;         // raw stdout of `pbuild ls`
#[tauri::command] pub fn pbuild_resume_all() -> String;     // raw stdout of `pbuild resume-all`
```

## `pty.rs`

```rust
pub struct PtyHandle {
    pub master: Box<dyn MasterPty + Send>,
    pub writer: Box<dyn Write + Send>,
    pub child: Box<dyn portable_pty::Child + Send + Sync>,
}

pub struct PtyStore(pub Mutex<HashMap<String, PtyHandle>>);   // Default; registered with .manage()

#[tauri::command] pub fn attach(app: tauri::AppHandle, ptys: State<PtyStore>, id: String, cols: u16, rows: u16) -> Result<(), String>;
#[tauri::command] pub fn pty_write(ptys: State<PtyStore>, id: String, data: String) -> Result<(), String>;
#[tauri::command] pub fn pty_resize(ptys: State<PtyStore>, id: String, cols: u16, rows: u16) -> Result<(), String>;
#[tauri::command] pub fn pty_detach(ptys: State<PtyStore>, id: String) -> Result<(), String>;
```

One pty per instance id, each running `tmux attach -t athena_<id>`. Output is emitted to the
webview as event `pty:<id>` with a `String` payload. `attach` on an already-attached id is a
successful no-op, which is what makes multiple simultaneous terminals safe. `pty_detach` kills
the attach client only; the tmux session and the agent inside it survive.

## Adding a Rust command from a shard

```rust
// src-tauri/src/cost.rs
use crate::registry::read_reg;
use crate::util::home;

#[tauri::command]
pub fn cost_summary() -> Result<String, String> { /* ... */ }
```

Integration then adds `mod cost;` and `cost::cost_summary,` to `main.rs`. Do not add a Tauri
plugin: `capabilities/default.json` grants `core:default` and `notification:default` only, and
a new plugin would need a permission entry, which is a second convergence point. Application
commands need no capability entry.

---

# JS API

## `src/api.js`

One wrapper per command. Never call `invoke` with a raw command string from a feature file
except for that feature's own new commands.

```js
import { invoke, listen } from './api.js';   // re-exported escape hatch for shard commands

STATE_LABEL          // { working, 'needs-you', idle, dead, ended, paused } -> label string
STATE_COLOR          // same keys -> 'var(--working)' etc
stateLabel(state)    // label for any state, unknown passes through
stateColor(state)    // colour for any state, unknown falls back to var(--idle)

listInstances()                        // -> Promise<InstanceView[]>
launch(cwd, cmd, name)                 // -> Promise<InstanceView>, rejects with a string
restore(id)                            // -> Promise<void>
closeInstance(id)                      // -> Promise<void>   (command name is `close`)
setPaused(id, paused)                  // -> Promise<void>
sendText(id, text)                     // -> Promise<void>, types the line and presses Enter
sendKey(id, key)                       // -> Promise<void>, one tmux key name, no Enter
listRepos()                            // -> Promise<string[]>

pastSessions(cwd)                      // -> Promise<PastSession[]>
resumeSession(cwd, sessionId, name)    // -> Promise<InstanceView>

codexTasks()                           // -> Promise<CodexTask[]>
pbuildStatus()                         // -> Promise<string>
pbuildResumeAll()                      // -> Promise<string>

ptyAttach(id, cols, rows)              // -> Promise<void>
ptyWrite(id, data)                     // -> Promise<void>
ptyResize(id, cols, rows)              // -> Promise<void>
ptyDetach(id)                          // -> Promise<void>
onPty(id, fn)                          // -> Promise<unlistenFn>, fn(chunkString)
```

`InstanceView` reaches JS with snake_case keys exactly as declared in Rust: `id name cwd group
cmd created session_id alive paused state tool summary idle_secs`. Command arguments are
camelCase on the JS side (`sessionId`), which is Tauri's own convention.

## `src/store.js` (the seam)

The only 1s poll in the app. A shard never adds a poll and never edits this file.

```js
import * as store from './store.js';

store.getInstances()          // InstanceView[] from the last tick, never null
store.getInstance(id)         // InstanceView | null
store.getSelected()           // string | null, the selected instance id
store.getSelectedInstance()   // InstanceView | null
store.getPressure()           // string, raw stdout of the last `pbuild ls`

store.setSelected(id)         // set or clear (null) the selection; emits at once
store.refresh()               // -> Promise<InstanceView[]>, re-poll now and emit
store.refreshPressure()       // -> Promise<string>, re-poll pbuild now and emit
store.start({ instanceMs = 1000, pressureMs = 5000 })   // main.js calls this once
store.stop()                  // tests only
```

### subscribe contract

```js
const off = store.subscribe(({ instances, selected, changed }) => { ... });
// later
off();                    // or store.unsubscribe(fn), identical effect
```

* The callback fires **once synchronously** inside `subscribe()` with the current snapshot, so
  a mount renders its first frame without waiting for a tick. At startup that snapshot is
  `instances: []`, so render an empty state rather than assuming data.
* It then fires on every 1s poll and on every `setSelected` call.
* `instances` is the live array; treat it as read-only.
* `selected` is the selected id or `null`.
* `changed` lists this tick's state transitions as `{ id, from, to }`. `from` is `null` the
  first time an instance is seen and the entry is omitted when the state did not move. An
  instance that disappeared produces no entry; detect removal from `instances`.
* A subscriber that throws is caught and logged; it does not stop the other subscribers.
* Subscribing twice with the same function reference registers once.

Reacting to a state change without touching the poll, which is what every shard needs:

```js
store.subscribe(({ changed }) => {
  for (const c of changed) {
    if (c.to === 'needs-you' && c.from && c.from !== 'needs-you') { /* ... */ }
  }
});
```

Pressure has its own channel on a 5s cadence:

```js
const off = store.subscribePressure((rawPbuildLsText) => { ... });
store.unsubscribePressure(fn);
```

## `src/term.js`

A factory, not a singleton. Call it once per visible terminal; four live handles is a
supported configuration. Every listener, resize observer and pty subscription is closed over
per handle and keyed by the instance id it is attached to.

```js
import { createTerm } from './term.js';

const t = createTerm(mountEl, { fontSize = 12.5, scrollback = 8000, theme } = {});

await t.attach(id);   // -> Promise<boolean>. Detaches any previous id first, clears the
                      //    screen, fits, subscribes to `pty:<id>`, opens the pty, focuses.
                      //    Returns false and prints a red `athena: <err>` line on failure.
await t.detach();     // -> Promise<void>. Unlistens, pty_detach, resets the screen.
t.fit();              // re-measure; safe to call while hidden (throws are swallowed)
t.focus();
t.write(str);         // write straight to the screen, e.g. a local banner
await t.dispose();    // detach + tear the xterm down; the handle is dead afterwards.
                      //    Resolves once the pty is released: await it before attaching the
                      //    same id to another terminal.
t.attachedId          // string | null (getter)
t.term                // the raw xterm Terminal (getter), for addons
```

`createTerm` imports `@xterm/xterm/css/xterm.css` itself, so a shard that builds terminals
imports nothing extra for styling.

Deciding whether an instance can be attached is the caller's job: `attach` on a dead session
rejects inside and prints the error. Check `store.getInstance(id).alive` first if you want to
show a placeholder instead.

## `src/cards.js`

The existing fleet rendering, reusable rather than re-implemented.

```js
card(instanceView, { selected, onSelect, onClosed })   // -> HTMLElement, the full card chrome
mountCards(host, { onSelect, onClosed })               // -> { destroy() }, grouped card list
mountAttention(host, { onSelect })                     // -> { destroy() }, the needs-you strip
mountCounts(host)                                      // -> { destroy() }, "n/m live · k waiting"
mountStageBar(host)                                    // -> { destroy() }, name + cwd + state
mountSessions(host, { onResumed })                     // -> { render() }, on-demand, async
mountCodex(host)                                       // -> { render() }, on-demand, async
```

`mountCards`, `mountAttention`, `mountCounts` and `mountStageBar` subscribe to the store
themselves and re-render each tick. `mountSessions` and `mountCodex` cost a backend call per
render, so they render only when their tab is shown.

## `src/launcher.js`

```js
mountLauncher({ dialog, openBtn, fields, onLaunched })   // -> { open() }
// fields defaults to { cwd: '#l-cwd', cmd: '#l-cmd', name: '#l-name', repos: '#repos' }
// onLaunched(newInstanceId) fires after the store has already been refreshed
```

Remembers the last directory in `localStorage` under the key `lastCwd`.

## `src/main.js`

Wiring only, and a convergence point. It creates the single stage terminal, mounts the five
foundation panels, wires the tab bar and the header, registers the needs-you notification
subscriber, and calls `store.start()`. Feature mounts are appended at the marked block.

---

# CSS

## Custom properties on `:root` (in `src/style.css`)

| Token | Value | Use |
|---|---|---|
| `--bg` | `#0a0908` | page ground, warm near-black |
| `--panel` | `#131110` | header, left rail, dialog |
| `--line` | `rgba(255,255,255,0.08)` | every hairline rule and border |
| `--ink` | `#e8e4dd` | body text |
| `--dim` | `#8a847c` | secondary text, labels, mono captions |
| `--working` | `#4ea86b` | state: working |
| `--needs` | `#e0a03c` | state: needs-you (the one rationed accent) |
| `--idle` | `#6b6a66` | state: idle, and the fallback banner |
| `--dead` | `#a8564e` | state: dead and ended |
| `--paused` | `#5b7fa8` | state: paused |
| `--mono` | `ui-monospace, "SF Mono", "Cascadia Mono", Menlo, monospace` | eyebrows, labels, buttons, all numerals |

A shard uses these tokens. It does not introduce a new hex value for anything a token already
covers, and it does not add a `:root` block of its own.

## Classes a shard may reuse (already styled)

`button` (mono 11px pill), `button.primary`, `.muted`, `.group-label` (mono uppercase
eyebrow), `.card` with `.banner` / `.card-body` / `.card-top` / `.card-name` / `.card-state` /
`.card-sub` / `.card-actions`, `.row` with `.row-title` / `.row-sub`, `.tab`, `.tabs`,
`.attention`, `.stage`, `.stage-bar`, and the `dialog` / `dialog label` / `dialog input` /
`dialog select` / `dialog menu` set.

The card banner colour is driven by `.card[data-state="..."]`, so setting `dataset.state` is
all a reused card needs.

## House rules for a shard's own CSS file

* Import it from the shard's JS module: `import './cost.css';`. Vite bundles it. Never add a
  `<link>` to `index.html` and never edit `style.css`.
* Prefix every selector with the shard name (`.cost-meter`, not `.meter`) so five shards cannot
  collide in one global stylesheet.
* Keep the house voice: mono uppercase eyebrows, hairline rules at `--line`, `--needs` rationed
  as the only accent, `tabular-nums` on any animated figure, and
  `@media (prefers-reduced-motion: reduce)` collapsing any motion to its final state.
* Section rhythm in this app is tight: 7 to 10px padding inside panels, 10 to 14px in bars.

---

# Verifying a shard

```bash
cd /home/david/Documents/GitHub/tools/athena
npm run build
cargo check --manifest-path src-tauri/Cargo.toml
```

Both pass on the foundation as committed. A shard's Rust file will report `unused` warnings
until integration adds its `mod` line; that is expected and is not a failure. Wrap a heavy
build on this machine with `pbuild run --weight 6G -- <cmd>`.

# Behaviour notes from the split

The refactor is behaviour-preserving with two deliberate improvements, both in the selection
path and neither visible as a layout change:

1. The selected card highlights on click rather than after the pty finishes attaching, because
   selection now flows through the store instead of a render call at the end of `select`.
2. Closing the selected instance now issues a real `pty_detach`, which the old inline handler
   skipped; it had left the handle in `PtyStore` forever.

---

# Integration decisions (v1.1, 2026-09-03)

Five shards landed together. Every contract gap a shard raised is settled here, once, so
the next shard reads one rule rather than five precedents.

## 1. One wrapper per command, in `api.js`

The contract offered a shard two ways to call its own Rust command: a wrapper in `api.js`
or the re-exported `invoke`. Two shards took one route and two took the other, and one
imported `invoke` from `@tauri-apps/api/core` directly, so a command rename would have had
to be chased through four files.

**Settled:** every Tauri command is named exactly once, in `src/api.js`. A shard still does
not edit that file; integration adds the wrapper when the shard lands, and the re-exported
`invoke` stays only as the escape hatch for a shard written before its wrapper exists. The
eight v1.1 commands now have wrappers: `sendMany`, `sessionUsage`, `transcriptTail`,
`handoffSend`, `autopauseConfig`, `autopauseSave`, `autopauseSelect`, `autopauseTick`.

## 2. Sending prose is a foundation job: `tmux::send_block`

`registry::send_text` was `send-keys -l` plus one Enter, so any text containing a newline
submitted at the first newline and the rest landed as further prompts. Broadcast and handoff
each wrote their own tmux-paste workaround around that, independently and identically.

**Settled:** the paste lives in the foundation as `tmux::send_block(sess, tag, text)`. A
single-line block is typed literally; a multi-line block is staged in a tmux buffer and
pasted with bracketed paste (`-p`), then submitted with exactly one Enter. `send_text`,
`send_many` and `handoff_send` all call it, so a future shard that sends prose inherits the
behaviour instead of re-deriving it. `tmux::tmux_run` is the shared "one tmux call, named
failure" helper the same three call sites had each copied.

## 3. Multi-line delivery is an agent contract

Bracketed paste is honoured by Claude Code and Codex, which is why a multi-line broadcast
arrives as one prompt. A bare `bash` instance has no bracketed-paste mode and will run each
line as a command.

**Settled:** broadcast and handoff are agent-oriented features. They are not blocked for a
`bash` instance (a one-line broadcast to a shell is legitimate), but the behaviour is stated
in the `api.js` wrapper doc and in the UI copy. Anything sending a multi-line block to a
shell instance is doing so knowingly.

## 4. The stage's ptys have exactly one owner

`pty.rs` keys one pty per instance id, and `attach` on an already-attached id is a
successful no-op. The single stage terminal in `main.js` stayed attached when `#mount-panes`
was filled and CSS hid `#term`, so a card click attached the hidden stage term to an id a
pane already held. That pane's next detach then killed the pty both were using, and
`main.js`'s `attachedId === id` guard refused to bring it back.

**Settled:** `main.js` owns a stage mode. `panes` non-null means the split grid owns every
attach, `select()` becomes selection-only, and the stage terminal is detached before the
grid is ever mounted. The grid is mounted and unmounted by the `#split` header toggle rather
than at boot, and `mountPanes().destroy()` is awaited (it is async by design: it must finish
pending attaches before disposing terminals). Every attach, detach and mode change runs in
order on one promise chain in `main.js`.

**Rule for a future shard:** a shard that opens a pty declares it, and integration gives it
a mode. Two mounts must never hold the same instance id at once.

## 5. The shell is a flex column

`style.css` sized `main` at `calc(100% - 44px)` under `body { overflow: hidden }`, so any
filled block between the header and `main` pushed `main`'s bottom off-screen. The broadcast
shard worked around it from its own stylesheet by making the body a flex column while it was
mounted; a second block there would have fought that workaround.

**Settled:** fixed at source. `body` is a flex column, `main` is `flex: 1 1 auto` with
`min-height: 0`, and every block above it is `flex: none`. The shard-scoped workaround is
gone. `.attention:empty` now hides the needs-you strip, which `cards.js` empties rather than
hides.

## 6. One focus ring

Five shards shipped three different focus treatments, two of them spending the rationed
amber on focus. **Settled:** one `:focus-visible` rule in `style.css`, a 2px `--ink` ring at
2px offset. `--needs` stays the needs-you signal only. No shard defines a focus ring.

## 7. Known dependencies and their exits

* **`~/.athena/autopause-owned.json`** sits beside the contracted `autopause.json`. Pause
  ownership is persisted separately so a config save from the UI cannot clobber the record
  of which processes are currently frozen. Each entry carries the pane pid and that pid's
  kernel start time, so a recycled instance id can never make a later SIGCONT land on a
  different job.
* **pbuild's status ledger** is read directly at
  `~/.local/state/mtmn-parallel/runs/<run>/status/<shard>`, because `pbuild status` is a
  write verb and `pbuild ls` is the only read, in prose. A read-only
  `lanes::pbuild_shard_status(run, shard)` would remove that filesystem dependency and is
  the right home for it.
* **`InstanceView` carries no "transcript exists" field.** Handoff and cost both infer it
  from `session_id` being non-null, so an instance whose hook fired but whose `.jsonl` was
  deleted only fails at read time. Both handle that with an inline error.
* **The header is the tightest space in the app.** `#mount-cost` and `#mount-autopause`
  share a 44px row with the counts, the pressure readout and three buttons. Both resolved it
  with an absolutely positioned disclosure that adds no layout width. A third header shard
  needs a different slot, not a third disclosure.

## 8. What the whole-repo cold review changed

One two-turn cold review was run over the assembled repository (`~/.codex/tasks/
20260903-210902-cold-integration/`): turn 1 with no brief and no contract, turn 2 with both,
re-triaging every finding it had already committed to. It returned 28 findings, 23 of which
survived its own re-triage. It found what a per-shard review structurally cannot: no shard
author ever saw the assembled program.

Fixed here:

* **The hooks could not run at all.** `package.json` declares `"type": "module"` and both hook
  scripts used CommonJS `require`, so `hooks/athena-state.js` died with a `ReferenceError` on its
  first line at every event. Hooks are one of the three authorities, so every instance would have
  read `idle` forever: no needs-you, no resume id captured, and therefore no cost, no handoff and
  no working auto-pause. Both scripts are ES modules now, and the state file is written through a
  temporary file and renamed so a 1s poll cannot read a half-written record.
* **Auto-pause could freeze a live Codex turn.** The gate special-cased Claude and read a missing
  hook file as `idle`. Codex has no hook equivalent, so its state is permanently absent, and
  absent read as idle meant a Codex instance was not merely stoppable but ranked *ahead* of a
  parked Claude session. Absence of evidence is no longer idleness: an agent (Claude or Codex)
  must be positively reported at `idle` or `needs-you` before any signal, and `refusal()` says
  which of those two reasons stopped it.
* **A paused job could be stranded or the wrong one resumed.** `is_stopped_pid` reads
  `/proc/<pgid>/stat`, and a process group outlives its leader, so a frozen group read as running
  and the resume was skipped. SIGCONT is now always sent (it is a no-op on a running group), and
  the foreground pgid frozen at the stop is compared before signalling, so a pane that has since
  started a different job is forgotten rather than signalled. Ownership is persisted the moment a
  stop succeeds rather than at the end of the tick.
* **The registry could be destroyed by a crash.** `write_reg` truncated the live file, and
  `read_reg` turned a parse failure into an empty fleet, so a partial write erased the only
  record of user intent and the next write replaced it with nothing. Writes go through a
  temporary file and a rename; a file that does not parse is moved aside and reported.
* **`close` forgot instances it had not killed**, orphaning a live agent behind a vanished card.
* **PTY handles outlived their clients.** An inherited `$TMUX` makes a nested `tmux attach` exit
  immediately, and nothing removed the dead handle, so `attach`'s "already attached" no-op made
  the terminal permanently unrecoverable. `TMUX` is now removed from the child environment, the
  reader thread drops its own generation-matched entry on exit, and detach reaps the child.
* **Handoff sent a stale tail.** The preview key does not move when the source simply says more,
  so send re-reads the tail and delivers what it just read.
* **Notifications gated the whole app**: a rejected permission call meant `store.start()` never
  ran and nothing rendered.
* Smaller: `pbuild` failures no longer read as success with empty output; launch and restore
  report a failed `send-keys` instead of claiming success; `cwd` is canonicalized as it enters
  the registry; restore clears the previous process's hook state; cost no longer double-counts an
  API response written as several assistant records sharing one message id; session titles stream
  the first 60 lines instead of reading whole multi-megabyte transcripts and no longer discard a
  prompt for starting with `<`; one bad UTF-8 line no longer truncates a handoff tail; rapid
  auto-pause edits persist the newest configuration; and auto-pause evaluates nothing until the
  saved rules have loaded.

Known and deliberately left, with the reasoning:

* **No single-instance guard.** Two Athena processes would race the registry, the ownership file
  and each other's selections. Reviewer called this uncertain because nothing establishes whether
  a second process is supported. It is not; the guard is still owed.
* **No subprocess timeouts.** Every tmux, git and pbuild call is an unbounded `Command::output`
  on a polling or control path, so a wedged tmux server freezes the manager that exists to
  supervise it.
* **A multi-pane tmux session breaks targeting.** `pane_map` reads pane 0 while `send-keys -t
  <session>` resolves the session's *current* pane, so state, signals and prompts can address
  different jobs once a user splits a pane inside an attached instance. One pane per session is
  an unenforced invariant.
* **Transcript reads are not incremental.** Cost re-parses each live transcript from byte zero
  every 10s. Correct, and O(history) on a memory-bound machine.
* **UI actions still swallow backend errors.** Restore, pause, resume and close have no status
  surface, so a rejection is invisible.
* Auto-pause holding a `waiting` reason through an unreadable pbuild ledger, and holding
  `blocked` until selection rather than until the state leaves `needs-you`, are both deliberate;
  the reviewer withdrew them once it had the policy. Repository `group` is a display label, not
  an identity, so basename collisions are cosmetic.

## Verifying the integrated build

```bash
cd /home/david/Documents/GitHub/tools/athena
pbuild run --weight 6G --label build -- npm run build
pbuild run --weight 6G --label check -- cargo check --manifest-path src-tauri/Cargo.toml
pbuild run --weight 6G --label test  -- cargo test  --manifest-path src-tauri/Cargo.toml
```

## `adopt.rs` (v1.2)

Brings a session or process Athena did not start into the fleet.

| Command | Signature | Notes |
|---|---|---|
| `list_adoptable_sessions` | `() -> Vec<AdoptableSession>` | tmux sessions not prefixed `athena_`. Fields: `session`, `windows`, `cwd`, `command`, `attached`. |
| `adopt_session` | `(session, name) -> Result<InstanceView, String>` | Renames the session to `athena_<id>`. `session` is re-checked against the live list, never trusted from the UI. |
| `list_adoptable_processes` | `() -> Vec<AdoptableProcess>` | This user's `claude`/`codex` processes that have a tty and are not under any tmux pane. |
| `reptyr_check` | `() -> ReptyrCheck` | `ok`, `reptyr`, `ptrace_scope`, `message`, `fix`. Read-only: it never writes `ptrace_scope`. |
| `adopt_process` | `(pid, name) -> Result<InstanceView, String>` | Validates the pid and its owner BEFORE the reptyr preflight, so a bad pid reports as a bad pid. Cannot confirm the move; reptyr runs in the pane. |

Identity: adoption relies on the session name being the identity, so `hooks/athena-state.js`
resolves its id from `ATHENA_ID` when present and otherwise from `#{session_name}` via `$TMUX_PANE`.

## `src/dnd.js` (v1.2)

`MIME_INSTANCE` and `MIME_PANE` plus `dragPayload(dt)` and `isDroppable(dt)`. Acceptance during
dragenter/dragover must use `isDroppable`, because `getData` is sealed until drop. A pane swap
detaches both panes before either re-attaches; see the note on `pty.rs` keying one pty per id.

## v1.3 layout change (supersedes the sidebar and stage sections above)

`src/panes.js` and `src/panes.css` are deleted. `mountCards`, `card` and `mountStageBar` are gone
from `src/cards.js`, which now exports only `mountAttention`, `mountCounts`, `mountSessions` and
`mountCodex`.

`src/grid.js` owns every terminal. `mountGrid(host, opts) -> { destroy, focusGroup(group) }`.
One tile per `InstanceView.group`, one xterm per tile, instances as tabs. An inactive tab holds no
pty; switching tab is `term.attach(id)` on the tile's existing handle, which detaches the previous
id first. Tile order is user-draggable and persisted at `localStorage['athena.tileOrder']`.

Mount elements in `index.html`:

| Element | Holds |
|---|---|
| `#grid-host` | the tile grid, the only thing in `<main>` |
| `#counts`, `#pressure`, `#mount-cost`, `#mount-autopause` | header |
| `#attention`, `#mount-broadcast` | full-width strips under the header |
| `#mount-sessions`, `#mount-codex`, `#mount-handoff` | inside `dialog.panel`, opened from header buttons |

New tokens in `:root`: `--panel-2` (tile header), `--hover`, `--line-strong`, `--accent`.
`--needs` remains the only rationed accent. `THEME` in `src/term.js` carries the literal xterm
palette, which is the one place a hex is allowed because xterm paints to a canvas and cannot read
a CSS custom property; keep it in step with `--bg` and `--ink`.

## v1.4 per-tile state

`mountGrid(host, opts)` gains `opts.onNewInTile({ group, cwd, cmd })`, fired by a tile's `+`.
`mountLauncher(...).open({ cwd, cmd, name })` accepts a prefill; a command is only preselected
when the dropdown actually offers it, since an adopted instance's command can be anything.

Three `localStorage` keys, all keyed by group and all failing soft to an empty object:
`athena.tileOrder` (array), `athena.tileSpans` (`{group: [cols, rows]}`, capped 4 by 3) and
`athena.tileFont` (`{group: px}`, clamped 8 to 24, default 12.5).

The grid returns `zoom(group, step)` and `resetZoom(group)` alongside `focusGroup`.

## v1.5 corrections

`list_repos` skips hidden directories and `node_modules`. Previously it did not, so
`GitHub/.claude` sorted first and silently became the launcher's default directory; every
instance launched without touching the field landed there.

`registry::launch` is now `registry::launch_in(cwd, cmd, name, group: Option<String>)`.
`None` gives the instance its OWN tile: the repo name is the base and `unique_group` appends a
counter when that name is taken. `Some(g)` joins tile `g` exactly, which is what a tile's `+`
sends. `sessions::resume_session` passes `None`, since a resumed conversation is a new instance.
The JS wrapper keeps the name `launch(cwd, cmd, name, group = null)`.

`.tile-tabs` hides its scrollbar (`scrollbar-width: none` plus the WebKit pseudo-element) and
tabs are `flex: 0 1 auto` with `min-width: 0`, so they shrink and ellipsize before the strip
scrolls. A visible scrollbar in a short strip sat on top of the tabs and swallowed the click.

Chrome heights: header 26px, tile header 22px min, grid gap and padding 6px.
