#!/usr/bin/env node
// Argus state emitter. Wired to every Claude Code hook event; writes one small JSON
// file per instance under ~/.argus/state/. No output, never blocks, never fails loud.
//
// ES modules, because package.json declares "type": "module" for the whole project. Under
// CommonJS `require` this file dies at its first line with a ReferenceError, and since the
// hook is the sole authority for Claude state, every instance would read as idle forever.
import fs from 'node:fs';
import path from 'node:path';

const id = process.env.ARGUS_ID;
if (!id) process.exit(0); // not launched by Argus: nothing to report

let input = '';
process.stdin.on('data', (d) => (input += d));
process.stdin.on('end', () => {
  let p = {};
  try { p = JSON.parse(input || '{}'); } catch { /* keep going with an empty payload */ }

  const dir = path.join(process.env.HOME, '.argus', 'state');
  const file = path.join(dir, `${id}.json`);
  let cur = {};
  try { cur = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* first event */ }

  const ev = p.hook_event_name || '';
  const next = { ...cur, ts: Math.floor(Date.now() / 1000) };
  if (p.session_id) next.session_id = p.session_id;
  if (p.cwd) next.cwd = p.cwd;

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
      next.state = 'needs-you';
      next.summary = String(p.message || next.summary || '').slice(0, 90);
      break;
    case 'Stop':
      next.state = 'idle';
      next.tool = null;
      break;
    case 'SessionEnd':
      next.state = 'ended';
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
