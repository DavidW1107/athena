// One thin wrapper per Tauri command. Nothing in the UI should call `invoke` with a
// raw command string; import the wrapper instead, so a rename is a one-line change here.
//
// A feature shard never edits this file; integration adds the wrapper for a shard's own
// command when the shard lands. That is the settled rule for all five v1.1 shards: every
// Tauri command is named exactly once, here. The re-exported `invoke` stays available for
// a shard being written before its wrapper exists.

import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';

export { invoke, listen };

// ------------------------------------------------------------------ state vocabulary

/** Every state string the backend can put on an InstanceView, mapped to its UI label. */
export const STATE_LABEL = {
  working: 'working',
  'needs-you': 'needs you',
  idle: 'idle',
  dead: 'not running',
  ended: 'ended',
  paused: 'paused',
  // Hit a usage limit. accounts.rs moves it to an account with allowance left within seconds;
  // it stays in this state only while every account is out.
  limited: 'limit hit',
  // Not a backend state. `held` is what the UI paints when the user has pinned a note on a
  // needs-you instance; see notes.js. It lives here because it has to label and colour like
  // any other state, and every state string is named exactly once in this file.
  held: 'held',
};

/** state -> CSS custom property holding that state's colour (defined in style.css). */
export const STATE_COLOR = {
  working: 'var(--working)',
  'needs-you': 'var(--needs)',
  idle: 'var(--idle)',
  dead: 'var(--dead)',
  ended: 'var(--dead)',
  paused: 'var(--paused)',
  limited: 'var(--dead)',
  held: 'var(--held)',
};

/** Label for any state, including one this build does not know about. */
export const stateLabel = (s) => STATE_LABEL[s] || s;

/** Colour for any state; unknown states fall back to the idle grey. */
export const stateColor = (s) => STATE_COLOR[s] || 'var(--idle)';

// ------------------------------------------------------------------ instances

/** @returns {Promise<Array>} InstanceView rows for every registered instance. */
export const listInstances = () => invoke('list_instances');

/** @returns {Promise<Object>} the new InstanceView. Rejects with a string on failure. */
/**
 * Start an instance. `group` null means "give it its own tile"; passing a group name puts it
 * in that exact tile, which is what a tile's own + asks for.
 */
export const launch = (cwd, cmd, name, group = null, ownTile = false) =>
  invoke('launch_in', { cwd, cmd, name, group, ownTile });

/** Move an instance into another tile. Grouping is per instance, so a merge is a reassignment. */
export const setGroup = (id, group) => invoke('set_group', { id, group });

/** Scroll a pane's real history. Positive is up. See tmux_scroll for why this is not the wheel. */
export const tmuxScroll = (id, lines) => invoke('tmux_scroll', { id, lines });

/** Leave copy mode, so a keystroke after scrolling reaches the agent instead of the scroller. */
export const endScroll = (id) => invoke('end_scroll', { id });

/** Re-create a dead tmux session, resuming its Claude conversation when one is known. */
export const restore = (id) => invoke('restore', { id });

/** Kill the tmux session, drop the hook state file, and forget the instance. */
export const closeInstance = (id) => invoke('close', { id });

/** Freeze / thaw the pane's own cgroup. Never SIGSTOP; see tmux::set_frozen. */
export const setPaused = (id, paused) => invoke('set_paused', { id, paused });

/** Type a line into the instance and press Enter. Rejects if the session is not running. */
export const sendText = (id, text) => invoke('send_text', { id, text });

/** Send one tmux key name (e.g. 'Escape', 'C-c') with no Enter. */
export const sendKey = (id, key) => invoke('send_key', { id, key });

/** Repo paths one and two levels under ~/Documents/GitHub, sorted. */
export const listRepos = () => invoke('list_repos');

// ------------------------------------------------------------------ adoption

/** tmux sessions Athena did not create, offered for adoption by rename. */
export const listAdoptableSessions = () => invoke('list_adoptable_sessions');

/** Rename an existing tmux session into the fleet. Clients stay attached. */
export const adoptSession = (session, name) => invoke('adopt_session', { session, name });

/** Agent processes of this user running outside tmux, movable only with reptyr. */
export const listAdoptableProcesses = () => invoke('list_adoptable_processes');

/** Whether a process adoption can run at all, and the exact command that unblocks it. */
export const reptyrCheck = () => invoke('reptyr_check');

/** Move a live process onto a new pty inside a fresh Athena session. */
export const adoptProcess = (pid, name) => invoke('adopt_process', { pid, name });

/** Agent processes of this user that Athena does not already own, importable by resume. */
export const listRunningAgents = () => invoke('list_running_agents');

/** Stop a running agent and resume its session inside a new tile. */
export const importAgent = (pid, sessionId, cwd, name) =>
  invoke('import_agent', { pid, sessionId, cwd, name });

// ------------------------------------------------------------------ resume browser

/** Past Claude sessions recorded for that cwd, newest first, capped at 40. */
export const pastSessions = (cwd) => invoke('past_sessions', { cwd });

/** Launch a fresh instance running `claude --resume <sessionId>`. */
export const resumeSession = (cwd, sessionId, name) =>
  invoke('resume_session', { cwd, sessionId, name });

// ------------------------------------------------------------------ lanes

/** Up to 15 codex-task runs from ~/.codex/tasks, newest first. */
export const codexTasks = () => invoke('codex_tasks');

/** @returns {Promise<string>} the work report for the last `hours` as a standalone HTML page. */
export const workReport = (hours) => invoke('work_report', { hours });

/** Save the report as HTML + PDF under ~/.athena/reports and open it. @returns {Promise<string>} the path. */
export const exportReport = (hours) => invoke('export_report', { hours });

/** Raw stdout of `pbuild ls`. */
export const pbuildStatus = () => invoke('pbuild_status');

/** Raw stdout of `pbuild resume-all`. */
export const pbuildResumeAll = () => invoke('pbuild_resume_all');

// ------------------------------------------------------------------ pty bridge

/** Open a pty running `tmux attach` for that instance; output arrives on event `pty:<id>`. */
export const ptyAttach = (id, cols, rows) => invoke('attach', { id, cols, rows });

export const ptyWrite = (id, data) => invoke('pty_write', { id, data });

export const ptyResize = (id, cols, rows) => invoke('pty_resize', { id, cols, rows });

/** Kill the attach client only; the tmux session and the agent inside it live on. */
export const ptyDetach = (id) => invoke('pty_detach', { id });

/** Ask tmux to repaint this instance's attach client in full. */
export const ptyRefresh = (id) => invoke('pty_refresh', { id });

/** Append a line to ~/.athena/ui.log, the webview's only durable log in a release build. */
export const uiLog = (line) => invoke('ui_log', { line }).catch(() => {});

/** Subscribe to one instance's pty output. Resolves to an unlisten function. */
export const onPty = (id, fn) => listen(`pty:${id}`, (e) => fn(e.payload));

// ------------------------------------------------------------------ primary selection

/**
 * The X11 / Wayland PRIMARY selection, which is what a middle click pastes and what selecting
 * text fills. Separate from the clipboard on purpose, so a selection never overwrites a copy.
 * Resolves to '' when nothing is selected anywhere on the desktop.
 */
export const primaryRead = () => invoke('primary_read');

/** Take ownership of the PRIMARY selection with this text. */
export const primaryWrite = (text) => invoke('primary_write', { text });

// ------------------------------------------------------------------ broadcast

/**
 * Deliver one prompt to many instances. Multi-line text is pasted as a single prompt
 * (bracketed paste), so an agent TUI reads it as one turn; a plain `bash` instance has no
 * bracketed-paste mode and will run each line.
 * @returns {Promise<Array<{id: string, ok: boolean, error: string|null}>>} one row per id.
 */
export const sendMany = (ids, text) => invoke('send_many', { ids, text });

// ------------------------------------------------------------------ context burn

/** Token totals plus current window occupancy for one Claude transcript. */
export const sessionUsage = (cwd, sessionId) => invoke('session_usage', { cwd, sessionId });

// ------------------------------------------------------------------ handoff

/** The last `count` real user/assistant messages of a transcript, oldest first. */
export const transcriptTail = (cwd, sessionId, count) =>
  invoke('transcript_tail', { cwd, sessionId, count });

/** Paste one block into the target instance as a single prompt and submit it once. */
export const handoffSend = (sourceId, targetId, text) =>
  invoke('handoff_send', { sourceId, targetId, text });

// ------------------------------------------------------------------ auto-pause

/** The persisted rule set, clamped to its valid ranges. */
export const autopauseConfig = () => invoke('autopause_config');

/** Persist the rules; resolves to the clamped set actually written. */
export const autopauseSave = (rules) => invoke('autopause_save', { rules });

/** Push the selected id straight to the signal gate, outside the tick. */
export const autopauseSelect = (id) => invoke('autopause_select', { id: id ?? null });

/** Evaluate the rules once and act. Resolves to a TickReport. */
export const autopauseTick = (rules) => invoke('autopause_tick', { rules });
