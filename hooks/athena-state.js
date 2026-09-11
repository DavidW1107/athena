#!/usr/bin/env node
// Athena state emitter. Wired to every Claude Code hook event; writes one small JSON
// file per instance under ~/.athena/state/. No output, never blocks, never fails loud.
//
// ES modules, because package.json declares "type": "module" for the whole project. Under
// CommonJS `require` this file dies at its first line with a ReferenceError, and since the
// hook is the sole authority for Claude state, every instance would read as idle forever.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { accountOf, isUsageLimit, keepsLimited, resetEpoch } from './limit.js';

/**
 * Which instance is this hook speaking for.
 *
 * ATHENA_ID is injected into the tmux session Athena creates, so a launched instance
 * answers for free. An ADOPTED session cannot: the agent was already running when Athena
 * renamed its session, so its environment predates us and will never contain the variable.
 * The session name is the same identity though, and tmux will report it for the pane this
 * process is sitting in, so fall back to reading it. That one extra subprocess only runs
 * for adopted instances.
 */
function resolveId() {
  if (process.env.ATHENA_ID) return process.env.ATHENA_ID;
  if (!process.env.TMUX_PANE) return null;
  try {
    const sess = execFileSync(
      'tmux',
      ['display-message', '-p', '-t', process.env.TMUX_PANE, '#{session_name}'],
      { encoding: 'utf8', timeout: 2000, stdio: ['ignore', 'pipe', 'ignore'] }
    ).trim();
    return sess.startsWith('athena_') ? sess.slice('athena_'.length) : null;
  } catch {
    return null; // no tmux, or the pane went away: not an Athena instance as far as we know
  }
}

/**
 * Record, per subscription, that it is out of usage and until when. Runs for EVERY session, not
 * just Athena's, so a limit hit in a plain terminal still steers Athena's launches and switches.
 * A turn that completes proves the account works again, which also heals a misread reset time;
 * the 60s grace keeps a turn that was already finishing when the limit landed from clearing it.
 */
function markAccount(ev, p, acct) {
  const file = path.join(process.env.HOME, '.athena', 'accounts', `${acct}.json`);
  const now = Math.floor(Date.now() / 1000);
  const text = [p.last_assistant_message, p.error_details]
    .filter(Boolean)
    .map((x) => (typeof x === 'string' ? x : JSON.stringify(x)))
    .join(' ');
  try {
    if (ev === 'StopFailure' && isUsageLimit(p.error, text)) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const tmp = `${file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ until: resetEpoch(text), msg: text.slice(0, 200), ts: now }));
      fs.renameSync(tmp, file);
    } else if (ev === 'Stop' && fs.existsSync(file)) {
      if (JSON.parse(fs.readFileSync(file, 'utf8')).ts < now - 60) fs.unlinkSync(file);
    }
  } catch { /* best-effort, like the state file */ }
  return text;
}

const id = resolveId();

let input = '';
process.stdin.on('data', (d) => (input += d));
process.stdin.on('end', () => {
  let p = {};
  try { p = JSON.parse(input || '{}'); } catch { /* keep going with an empty payload */ }

  const acct = accountOf(process.env.CLAUDE_CONFIG_DIR, process.env.HOME);
  const failText = markAccount(p.hook_event_name || '', p, acct);
  if (!id) process.exit(0); // not an Athena instance: nothing more to report

  const dir = path.join(process.env.HOME, '.athena', 'state');
  const file = path.join(dir, `${id}.json`);
  let cur = {};
  try { cur = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* first event */ }

  const ev = p.hook_event_name || '';
  const next = { ...cur, ts: Math.floor(Date.now() / 1000) };
  if (p.session_id) next.session_id = p.session_id;
  if (p.cwd) next.cwd = p.cwd;
  next.account = acct;

  switch (ev) {
    case 'SessionStart':
      next.state = 'idle';
      next.tool = null;
      break;
    case 'UserPromptSubmit':
      next.state = 'working';
      next.summary = String(p.prompt || '').slice(0, 90);
      break;
    case 'PreToolUse':
      next.state = 'working';
      next.tool = p.tool_name || null;
      break;
    case 'PostToolUse':
      next.state = 'working';
      break;
    case 'Notification':
      // Fires on permission prompts and on idle-waiting. This is the "needs you" signal.
      // Except after a usage limit: the idle ping would bury `limited`, and accounts.rs would
      // then never resume the instance when a limit resets.
      if (cur.state === 'limited') break;
      next.state = 'needs-you';
      next.summary = String(p.message || next.summary || '').slice(0, 90);
      break;
    case 'Stop':
      next.state = 'idle';
      next.tool = null;
      break;
    case 'StopFailure':
      // Fires instead of Stop when an API error ended the turn. A usage limit is the one Athena
      // acts on (limits.rs moves the session to an account with allowance left); anything else
      // ended the turn and the agent is waiting like after a normal Stop.
      next.state = isUsageLimit(p.error, failText) ? 'limited' : 'idle';
      next.tool = null;
      next.summary = failText.slice(0, 90);
      break;
    case 'SessionEnd':
      // `limited` survives a signal stop, or accounts.rs never moves a claude that exited late.
      next.state = keepsLimited(cur.state, p.reason) ? 'limited' : 'ended';
      break;
    default:
      break;
  }

  try {
    fs.mkdirSync(dir, { recursive: true });
    // Write and rename: the Rust side reads this file on a 1s poll and on every auto-pause
    // signal gate, so it must never observe a half-written record and fall back to `idle`.
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(next));
    fs.renameSync(tmp, file);
  } catch { /* state is best-effort; never break the session over it */ }
  process.exit(0);
});
