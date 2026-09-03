// Broadcast: one prompt typed once, delivered to a chosen set of live instances.
//
// The panel is a disclosure so it costs 30px of the stage when it is not in use. The
// target list mirrors the repo grouping in cards.js and re-renders only when the live
// fleet actually changes, so a 1s tick never steals focus from a checkbox mid-click.
//
// `send_many` is this shard's own backend command; integration added its one wrapper to
// api.js, which is where every command in this app is named exactly once.

import './broadcast.css';
import { sendMany, stateColor, stateLabel } from './api.js';
import * as store from './store.js';

const el = (tag, cls) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  return n;
};

const checkbox = () => {
  const b = el('input', 'bc-box');
  b.type = 'checkbox';
  return b;
};

let seq = 0;

/**
 * Mount the broadcast panel.
 *
 * @param {HTMLElement} host guaranteed to exist and to be empty
 * @param {{ open?: boolean, onSent?: (results: Array) => void }} [opts]
 * @returns {{ destroy: () => void }}
 */
export function mountBroadcast(host, opts = {}) {
  const chosen = new Set();
  const rows = new Map(); // id -> checkbox
  const groupBoxes = []; // { input, ids }
  let lastSig = null;
  let sending = false;
  let dead = false;

  const bodyId = `bc-body-${++seq}`;
  host.classList.add('bc');
  host.innerHTML = `
    <div class="bc-bar">
      <button type="button" class="bc-toggle" aria-expanded="false" aria-controls="${bodyId}">
        <span class="bc-caret" aria-hidden="true"></span>broadcast
      </button>
      <span class="bc-count"></span>
      <span class="bc-status" role="status" aria-live="polite"></span>
    </div>
    <div class="bc-body" id="${bodyId}" hidden>
      <div class="bc-targets"></div>
      <div class="bc-compose">
        <label class="bc-label" for="${bodyId}-text">prompt</label>
        <textarea id="${bodyId}-text" class="bc-text" rows="2"
          placeholder="Same prompt, every checked instance. Multiple lines arrive as one prompt."></textarea>
        <div class="bc-actions">
          <span class="bc-hint">ctrl + enter sends</span>
          <button type="button" class="bc-send primary" disabled>send</button>
        </div>
      </div>
      <ul class="bc-fails" hidden></ul>
    </div>`;

  const toggle = host.querySelector('.bc-toggle');
  const body = host.querySelector('.bc-body');
  const count = host.querySelector('.bc-count');
  const status = host.querySelector('.bc-status');
  const targets = host.querySelector('.bc-targets');
  const textEl = host.querySelector('.bc-text');
  const sendBtn = host.querySelector('.bc-send');
  const fails = host.querySelector('.bc-fails');

  // ---------------------------------------------------------------- disclosure

  function setOpen(open, focus = false) {
    body.hidden = !open;
    toggle.setAttribute('aria-expanded', String(open));
    if (open && focus) textEl.focus();
  }
  toggle.onclick = () => setOpen(toggle.getAttribute('aria-expanded') !== 'true', true);
  setOpen(Boolean(opts.open));

  // ---------------------------------------------------------------- target list

  function setStatus(text, tone = '') {
    status.textContent = text;
    status.dataset.tone = tone;
  }

  function marks() {
    for (const [id, box] of rows) box.checked = chosen.has(id);
    for (const g of groupBoxes) {
      const n = g.ids.filter((id) => chosen.has(id)).length;
      g.input.checked = n > 0 && n === g.ids.length;
      g.input.indeterminate = n > 0 && n < g.ids.length;
    }
    count.textContent = rows.size ? `${chosen.size} of ${rows.size} selected` : 'no live instances';
    count.dataset.armed = String(chosen.size > 0);
    sendBtn.disabled = sending || chosen.size === 0;
    sendBtn.textContent = chosen.size ? `send to ${chosen.size}` : 'send';
  }

  function build(live) {
    targets.replaceChildren();
    rows.clear();
    groupBoxes.length = 0;
    if (!live.length) {
      const p = el('p', 'bc-empty');
      p.textContent = 'Nothing is running. Launch an instance to broadcast to it.';
      targets.appendChild(p);
      return;
    }
    const groups = new Map();
    for (const i of live) {
      if (!groups.has(i.group)) groups.set(i.group, []);
      groups.get(i.group).push(i);
    }
    for (const [g, list] of [...groups].sort((a, b) => a[0].localeCompare(b[0]))) {
      const wrap = el('div', 'bc-group');
      const head = el('label', 'bc-group-head');
      const all = checkbox();
      all.onchange = () => {
        for (const i of list) {
          if (all.checked) chosen.add(i.id);
          else chosen.delete(i.id);
        }
        marks();
      };
      const gName = el('span', 'group-label');
      gName.textContent = `${g} · ${list.length}`;
      head.append(all, gName);
      groupBoxes.push({ input: all, ids: list.map((i) => i.id) });
      wrap.appendChild(head);

      for (const i of list) {
        const row = el('label', 'bc-target');
        row.title = i.cwd;
        const box = checkbox();
        box.onchange = () => {
          if (box.checked) chosen.add(i.id);
          else chosen.delete(i.id);
          marks();
        };
        const dot = el('span', 'bc-dot');
        dot.style.background = stateColor(i.state);
        dot.setAttribute('aria-hidden', 'true');
        const name = el('span', 'bc-name');
        name.textContent = i.name;
        const state = el('span', 'bc-state');
        state.textContent = stateLabel(i.state);
        row.append(box, dot, name, state);
        rows.set(i.id, box);
        wrap.appendChild(row);
      }
      targets.appendChild(wrap);
    }
    if (sending) setEnabled(false);
  }

  function render(instances) {
    const live = instances.filter((i) => i.alive);
    for (const id of [...chosen]) if (!live.some((i) => i.id === id)) chosen.delete(id);
    const sig = live.map((i) => `${i.id}:${i.group}:${i.name}:${i.state}`).join('|');
    if (sig !== lastSig) {
      lastSig = sig;
      build(live);
    }
    marks();
  }

  const off = store.subscribe(({ instances }) => render(instances));

  // ---------------------------------------------------------------- sending

  function setEnabled(on) {
    textEl.disabled = !on;
    for (const box of rows.values()) box.disabled = !on;
    for (const g of groupBoxes) g.input.disabled = !on;
  }

  async function send() {
    if (sending || dead) return;
    const ids = [...chosen];
    const text = textEl.value;
    if (!ids.length) {
      setStatus('check at least one instance', 'warn');
      return;
    }
    if (!text.trim()) {
      setStatus('type a prompt first', 'warn');
      textEl.focus();
      return;
    }

    sending = true;
    setEnabled(false); // the snapshot cannot drift while the send is in flight
    sendBtn.disabled = true;
    setStatus(`sending to ${ids.length}…`);
    fails.replaceChildren();
    fails.hidden = true;

    try {
      const results = await sendMany(ids, text);
      if (dead) return;
      const bad = results.filter((r) => !r.ok);
      const good = results.length - bad.length;
      setStatus(
        bad.length ? `${good} of ${results.length} delivered` : `sent to ${good}`,
        bad.length ? 'warn' : 'ok'
      );
      for (const r of bad) {
        const inst = store.getInstance(r.id);
        const li = el('li');
        const who = el('b');
        who.textContent = inst ? inst.name : r.id;
        const why = el('span', 'bc-why');
        why.textContent = r.error || 'failed';
        li.append(who, why);
        fails.appendChild(li);
      }
      fails.hidden = bad.length === 0;
      // Only clear what was actually sent: the field is disabled during the call, but
      // a queued keystroke could still have landed before that took effect.
      if (!bad.length && textEl.value === text) textEl.value = '';
      opts.onSent?.(results);
    } catch (err) {
      if (dead) return;
      setStatus(String(err), 'warn');
    } finally {
      if (!dead) {
        sending = false;
        setEnabled(true);
        marks();
      }
    }
  }

  sendBtn.onclick = send;
  textEl.onkeydown = (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      send();
    }
  };

  return {
    destroy() {
      dead = true; // any in-flight send resolves into a torn-down panel and stops there
      off();
      toggle.onclick = null;
      sendBtn.onclick = null;
      textEl.onkeydown = null;
      rows.clear();
      groupBoxes.length = 0;
      chosen.clear();
      host.replaceChildren();
      host.classList.remove('bc');
    },
  };
}
