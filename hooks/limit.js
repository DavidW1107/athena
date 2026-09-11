// Usage-limit detection for athena-state.js, split out so it can be tested without stdin.
import path from 'node:path';

/** Which subscription a hook process bills to: ~/.claude is "a", ~/.claude-<x> is "x". */
export function accountOf(configDir, home) {
  if (!configDir || path.resolve(configDir) === path.join(home, '.claude')) return 'a';
  return path.basename(configDir).replace(/^\.claude-/, '').toLowerCase().replace(/[^a-z0-9]/g, '') || 'a';
}

/**
 * True for a subscription usage limit ("You've hit your session limit · resets 6pm"), false for
 * the transient 429s a retry fixes. Only the first is worth moving a session to another account.
 */
export function isUsageLimit(error, text) {
  return error === 'rate_limit' && /hit your|usage limit/i.test(text);
}

/**
 * Whether a SessionEnd leaves a `limited` instance limited. A claude stopped by a signal ends with
 * reason `other`, and Athena's own move sends that signal: a stop that lands after the move gave up
 * waiting must not strand the instance at `ended`. /exit, /clear, /logout and /resume are the
 * user's call, so those end it.
 */
export function keepsLimited(state, reason) {
  return state === 'limited' && (!reason || reason === 'other');
}

const MONTHS =['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

/**
 * Epoch seconds the limit lifts, read from "resets 6pm", "resets 6:30pm" or "resets Sep 15, 3am".
 * The time is taken as local, which is the (Europe/Dublin) Claude Code prints on this machine.
 * Unreadable text falls back to five hours, the session window.
 * ponytail: a wrong guess costs one failed resume, which re-marks the account with a fresh guess.
 */
export function resetEpoch(text, now = new Date()) {
  const m = /resets\s+(?:([a-z]{3})[a-z]*\s+(\d{1,2}),?\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)/i.exec(text);
  if (!m) return Math.floor(now / 1000) + 5 * 3600;
  const d = new Date(now);
  d.setHours((+m[3] % 12) + (m[5].toLowerCase() === 'pm' ? 12 : 0), +(m[4] || 0), 0, 0);
  const mon = m[1] ? MONTHS.indexOf(m[1].toLowerCase()) : -1;
  if (mon >= 0) {
    d.setMonth(mon, +m[2]);
    if (d <= now) d.setFullYear(d.getFullYear() + 1);
  } else if (d <= now) {
    d.setDate(d.getDate() + 1);
  }
  return Math.floor(d / 1000);
}
