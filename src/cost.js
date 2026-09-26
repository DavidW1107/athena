// Context-burn meter. No money anywhere: the plan is a subscription, so the
// only question this answers is "which instance is about to need a compact".
//
// The header slot is 44px tall and shared with the pressure readout and two
// buttons, so it carries one bounded readout for the hottest session. The full
// fleet lives in a disclosure panel under it, one row per live instance.

import './cost.css';
import { sessionUsage } from './api.js';
import * as store from './store.js';

/** Each read re-parses a transcript that only grows, so keep it slow. */
const REFRESH_MS = 10_000;
const WARN = 0.75;
const HOT = 0.9;

const el = (tag, cls) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  return n;
};

/** 412K / 1.2M, never more than four glyphs of number. */
function tokens(value) {
  const n = Number(value) || 0;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 10_000) return `${Math.round(n / 1000)}K`;
  if (n >= 1_000) return `${(n / 1000).toFixed(1)}K`;
  return String(n);
}

/** Share of inbound tokens that came from cache rather than fresh input. */
function cacheShare(s) {
  const inbound = s.input_tokens + s.cache_read_tokens + s.cache_creation_tokens;
  return inbound ? Math.round((s.cache_read_tokens / inbound) * 100) : 0;
}

/** 0..1 of the window, or null when the model's limit is unknown. */
function fraction(s) {
  if (!s || !s.context_limit) return null;
  return Math.min(1, s.context_tokens / s.context_limit);
}

function level(frac) {
  if (frac === null) return 'none';
  if (frac >= HOT) return 'hot';
  if (frac >= WARN) return 'warn';
  return 'ok';
}

/** One transcript is identified by its directory and its session id together. */
const sessionKey = (i) => (i.session_id ? `${i.cwd}\n${i.session_id}` : null);

/**
 * Mount the context-burn meter.
 * @param {HTMLElement} host the empty #mount-cost span in the header
 * @param {{ refreshMs?: number }} [opts]
 * @returns {{ destroy: () => void }}
 */
export function mountCost(host, opts = {}) {
  const refreshMs = opts.refreshMs ?? REFRESH_MS;
  const records = new Map(); // instance id -> { key, summary, error, pending, at }
  let instances = [];
  let selected = null;
  let open = false;
  let sig = '';
  let destroyed = false;

  host.classList.add('cost-host');
  host.hidden = true;

  const trigger = el('button', 'cost-trigger');
  trigger.type = 'button';
  trigger.setAttribute('aria-expanded', 'false');
  trigger.setAttribute('aria-controls', 'cost-panel');

  const panel = el('div', 'cost-panel');
  panel.id = 'cost-panel';
  panel.hidden = true;

  const grid = el('div', 'cost-grid');
  const note = el('p', 'cost-note');
  note.textContent =
    'Context is the newest turn only, not a session total. Compact once the bar passes three quarters.';
  panel.append(grid, note);
  host.append(trigger, panel);

  // ---------------------------------------------------------------- reads

  function readUsage(inst) {
    const key = sessionKey(inst);
    if (!key) return;
    const prior = records.get(inst.id);
    const fresh = prior && prior.key === key;
    if (fresh && (prior.pending || Date.now() - prior.at < refreshMs)) return;

    // Carry the previous numbers across a refresh of the same transcript only.
    // A different session id under the same instance starts blank, otherwise the
    // old conversation's context would be shown under the new one.
    const rec = {
      key,
      at: Date.now(),
      pending: true,
      summary: fresh ? prior.summary : null,
      error: fresh ? prior.error : null,
    };
    records.set(inst.id, rec);
    sessionUsage(inst.cwd, inst.session_id, inst.host || null)
      .then((summary) => {
        rec.summary = summary;
        rec.error = null;
      })
      .catch((err) => {
        rec.summary = null;
        rec.error = String(err);
      })
      .finally(() => {
        rec.pending = false;
        rec.at = Date.now();
        if (!destroyed && records.get(inst.id) === rec) render();
      });
  }

  // ---------------------------------------------------------------- model

  function rows() {
    return instances
      .filter((i) => i.alive)
      .map((i) => {
        const key = sessionKey(i);
        const rec = key ? records.get(i.id) : null;
        const usable = rec && rec.key === key ? rec : null;
        const summary = usable ? usable.summary : null;
        let status = 'reading';
        if (!key) status = 'none';
        else if (summary) status = 'ok';
        else if (usable && usable.error) status = 'error';
        return { inst: i, summary, status, error: usable?.error, frac: fraction(summary) };
      });
  }

  /** The row the header speaks for: the selection if it has data, else the hottest. */
  function headline(list) {
    const withData = list.filter((r) => r.summary);
    if (!withData.length) return null;
    const sel = withData.find((r) => r.inst.id === selected);
    if (sel) return sel;
    return withData.reduce((a, b) => {
      const fa = a.frac ?? -1;
      const fb = b.frac ?? -1;
      if (fb !== fa) return fb > fa ? b : a;
      return b.summary.context_tokens > a.summary.context_tokens ? b : a;
    });
  }

  // ---------------------------------------------------------------- render

  function bar(frac) {
    const b = el('span', 'cost-bar');
    b.dataset.level = level(frac);
    b.setAttribute('aria-hidden', 'true');
    const fill = el('i');
    fill.style.width = `${Math.round((frac ?? 0) * 100)}%`;
    b.append(fill);
    return b;
  }

  function renderTrigger(list, head) {
    trigger.replaceChildren();
    const name = el('span', 'cost-name');
    const fig = el('span', 'cost-fig');
    fig.dataset.level = head ? level(head.frac) : 'none';

    if (!head) {
      name.textContent = 'ctx';
      fig.textContent = list.some((r) => r.status === 'reading') ? 'reading' : 'no transcript';
      trigger.append(name, fig);
      trigger.setAttribute('aria-label', 'Context burn, no usage yet. Show every instance.');
    } else {
      const pct = head.frac === null ? null : Math.round(head.frac * 100);
      name.textContent = head.inst.name;
      fig.textContent =
        pct === null ? tokens(head.summary.context_tokens) : `${tokens(head.summary.context_tokens)} ${pct}%`;
      trigger.append(name, fig);
      if (head.frac !== null) trigger.append(bar(head.frac));
      const others = list.length - 1;
      if (others > 0) {
        const more = el('span', 'cost-more');
        more.textContent = `+${others}`;
        trigger.append(more);
      }
      trigger.setAttribute(
        'aria-label',
        `Context burn: ${head.inst.name} at ${pct === null ? `${head.summary.context_tokens} tokens` : `${pct} percent`}. Show every instance.`
      );
    }
    trigger.title = 'Context window in use. Click for every live instance.';
  }

  function renderPanel(list) {
    grid.replaceChildren();
    for (const label of ['instance', 'in', 'out', 'cache', 'ctx', '%', '']) {
      const h = el('span', 'cost-head');
      h.textContent = label;
      grid.append(h);
    }
    for (const r of list) {
      const name = el('span', 'cost-rowname');
      name.textContent = r.inst.name;
      name.title = r.inst.cwd;
      grid.append(name);

      if (r.status !== 'ok') {
        const msg = el('span', 'cost-msg');
        msg.textContent =
          r.status === 'none'
            ? 'no Claude transcript'
            : r.status === 'error'
              ? 'usage unavailable'
              : 'reading usage';
        if (r.error) msg.title = r.error;
        grid.append(msg);
        continue;
      }

      const s = r.summary;
      const pct = r.frac === null ? null : Math.round(r.frac * 100);
      for (const text of [
        tokens(s.input_tokens),
        tokens(s.output_tokens),
        `${cacheShare(s)}%`,
        tokens(s.context_tokens),
        pct === null ? '--' : `${pct}%`,
      ]) {
        const c = el('span', 'cost-cell');
        c.textContent = text;
        grid.append(c);
      }
      const cell = el('span', 'cost-barcell');
      if (r.frac !== null) cell.append(bar(r.frac));
      grid.append(cell);
    }
  }

  function render() {
    const list = rows();
    host.hidden = list.length === 0;
    if (!list.length) {
      if (open) setOpen(false);
      sig = '';
      return;
    }
    const head = headline(list);
    const next = list
      .map((r) => {
        const s = r.summary;
        return [
          r.inst.id,
          r.inst.name,
          r.status,
          s ? `${s.input_tokens}/${s.output_tokens}/${s.cache_read_tokens}/${s.context_tokens}/${s.context_limit}` : '',
        ].join(':');
      })
      .join('|');
    const stamp = `${next}#${head ? head.inst.id : ''}#${open}`;
    if (stamp === sig) return;
    sig = stamp;
    renderTrigger(list, head);
    renderPanel(list);
  }

  // ---------------------------------------------------------------- disclosure

  function setOpen(next) {
    open = next;
    panel.hidden = !next;
    trigger.setAttribute('aria-expanded', String(next));
    if (next) {
      document.addEventListener('pointerdown', onOutside, true);
      document.addEventListener('keydown', onKey, true);
    } else {
      document.removeEventListener('pointerdown', onOutside, true);
      document.removeEventListener('keydown', onKey, true);
    }
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

  // ---------------------------------------------------------------- store seam

  // No poll of its own: reads ride the store's 1s tick and are throttled per
  // transcript to refreshMs.
  const off = store.subscribe((snap) => {
    instances = snap.instances;
    selected = snap.selected;
    const ids = new Set(instances.map((i) => i.id));
    for (const id of [...records.keys()]) if (!ids.has(id)) records.delete(id);
    for (const i of instances) if (i.alive) readUsage(i);
    render();
  });

  return {
    destroy() {
      destroyed = true;
      off();
      setOpen(false);
      host.classList.remove('cost-host');
      host.hidden = false;
      host.replaceChildren();
    },
  };
}
