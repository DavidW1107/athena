// Subscription limits meter: every Claude account and Codex, 5-hour and weekly windows, with
// reset times. Same header-pill-plus-disclosure shape as the context meter, and it reuses its
// .cost-* styles so the two read as one control family.
//
// The weekly window is the one that strands work for days, so the pill shows weekly only; the
// panel carries both.

import './limits.css';
import { accountLimits } from './api.js';

/** A cache read on the Rust side; the network fetch behind it runs at most every 5 min. */
const POLL_MS = 30_000;
const WARN = 75;
const HOT = 90;

const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
};

const label = (name) => (name === 'codex' ? 'Codex' : `Claude ${name.toUpperCase()}`);
const short = (name) => (name === 'codex' ? 'cx' : name.toUpperCase());
const level = (pct) => (pct == null ? 'none' : pct >= HOT ? 'hot' : pct >= WARN ? 'warn' : 'ok');

/** "2d 4h", "3h 10m", "12m" until the epoch. */
function until(epoch) {
  if (!epoch) return '';
  const s = Math.max(0, epoch - Date.now() / 1000);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d) return `${d}d ${h}h`;
  if (h) return `${h}h ${m}m`;
  return `${m}m`;
}

const when = (epoch) =>
  new Date(epoch * 1000).toLocaleString(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' });

function bar(pct) {
  const b = el('span', 'cost-bar');
  b.dataset.level = level(pct);
  b.setAttribute('aria-hidden', 'true');
  const fill = el('i');
  fill.style.width = `${Math.min(100, Math.round(pct ?? 0))}%`;
  b.append(fill);
  return b;
}

/**
 * Mount the limits meter.
 * @param {HTMLElement} host the empty #mount-limits span in the header
 * @returns {{ destroy: () => void }}
 */
export function mountLimits(host) {
  let rows = [];
  let open = false;
  let timer = 0;

  host.classList.add('cost-host', 'limits-host');
  host.hidden = true;

  const trigger = el('button', 'cost-trigger');
  trigger.type = 'button';
  trigger.setAttribute('aria-expanded', 'false');
  trigger.setAttribute('aria-controls', 'limits-panel');

  const panel = el('div', 'cost-panel limits-panel');
  panel.id = 'limits-panel';
  panel.hidden = true;
  const grid = el('div', 'cost-grid limits-grid');
  const note = el(
    'p',
    'cost-note',
    'Read every 5 minutes. An account at 95% of either window is skipped for new launches and moves.'
  );
  panel.append(grid, note);
  host.append(trigger, panel);

  function renderTrigger() {
    trigger.replaceChildren(el('span', 'cost-name', 'week'));
    const spoken = [];
    for (const r of rows) {
      const pct = r.weekly ? Math.round(r.weekly.pct) : null;
      const fig = el('span', 'cost-fig', `${short(r.name)} ${pct ?? '--'}`);
      fig.dataset.level = level(pct);
      if (r.error) fig.classList.add('limits-stale');
      trigger.append(fig);
      spoken.push(`${label(r.name)} ${pct == null ? 'unknown' : `${pct} percent`}`);
    }
    trigger.setAttribute('aria-label', `Weekly limits: ${spoken.join(', ')}. Show both windows and reset times.`);
    trigger.title = 'Weekly usage per account. Click for 5-hour windows and reset times.';
  }

  function cell(win) {
    const pct = win ? Math.round(win.pct) : null;
    const c = el('span', 'cost-cell', pct == null ? '--' : `${pct}%`);
    const b = el('span', 'cost-barcell');
    if (pct != null) b.append(bar(pct));
    const t = el('span', 'cost-cell limits-reset', win?.resets_at ? until(win.resets_at) : '');
    if (win?.resets_at) t.title = `resets ${when(win.resets_at)}`;
    return [c, b, t];
  }

  function renderPanel() {
    grid.replaceChildren();
    for (const h of ['account', '5h', '', 'resets', 'week', '', 'resets']) grid.append(el('span', 'cost-head', h));
    for (const r of rows) {
      const name = el('span', 'cost-rowname', label(r.name));
      if (r.error) {
        name.classList.add('limits-stale');
        name.title = `${r.error}${r.at ? `; showing reading from ${when(r.at)}` : ''}`;
      }
      grid.append(name, ...cell(r.five_hour), ...cell(r.weekly));
    }
  }

  async function poll() {
    try {
      rows = await accountLimits();
    } catch {
      rows = [];
    }
    host.hidden = rows.length === 0;
    if (rows.length) {
      renderTrigger();
      renderPanel();
    }
  }

  function setOpen(next) {
    open = next;
    panel.hidden = !next;
    trigger.setAttribute('aria-expanded', String(next));
    const fn = next ? 'addEventListener' : 'removeEventListener';
    document[fn]('pointerdown', onOutside, true);
    document[fn]('keydown', onKey, true);
  }
  function onOutside(e) {
    if (!host.contains(e.target)) setOpen(false);
  }
  function onKey(e) {
    if (e.key !== 'Escape') return;
    setOpen(false);
    trigger.focus();
  }
  trigger.onclick = () => setOpen(!open);

  // The first call only starts the fetch in the background; ask again shortly for its answer.
  poll();
  setTimeout(poll, 3000);
  timer = setInterval(poll, POLL_MS);

  return {
    destroy() {
      clearInterval(timer);
      setOpen(false);
      host.replaceChildren();
    },
  };
}
