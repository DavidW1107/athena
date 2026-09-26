// Handoff: take the tail of one instance's conversation and drop it into another as a
// single prompt. Sits at the foot of the left rail, under the tab panes.
//
// Three rules hold the panel honest:
//
//   * Nothing stale is ever sendable. The loaded messages are stamped with the exact
//     source identity that produced them (id + cwd + session id + count). A change to
//     any part of that identity clears them, bumps a generation token and reloads, and
//     a late reply from a superseded request is dropped instead of committed. None of
//     that identity moves when the source merely says more, so send re-reads the tail
//     one last time and delivers what it just read: "the last n messages" is evaluated
//     when the handoff happens, not when the preview was opened.
//   * The 1s store tick never rebuilds the two <select> lists unless the fleet actually
//     changed, so an open dropdown is not yanked out from under the pointer.
//   * The two footguns are refused in both directions: an instance cannot be handed its
//     own history, and a dead target is refused before anything is typed. handoff.rs
//     repeats both checks, so a stale panel cannot talk its way past them.
//
// Delivery uses this shard's own `handoffSend`, which refuses the two footguns in the
// backend as well as here. Both it and `sendText` now paste a multi-line block through
// tmux::send_block, so a handoff arrives as one prompt rather than one per newline.

import './handoff.css';
import { handoffSend, transcriptTail } from './api.js';
import * as store from './store.js';

const el = (tag, cls) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  return n;
};

const label = (i) => `${i.group}/${i.name}`;

/** How much of the block the preview renders before it says "and the rest". */
const PREVIEW_CHARS = 4000;

let seq = 0;

/** One plain block: a line saying where it came from, then the messages in order. */
function formatBlock(msgs, src) {
  const n = msgs.length;
  const head =
    `Handoff from another Claude Code instance: the last ${n} message${n === 1 ? '' : 's'} ` +
    `of "${src.name}" working in ${src.cwd}. Read it as background, then carry on here.`;
  const body = msgs.map((m) => `--- ${m.role} ---\n${m.text}`).join('\n\n');
  return `${head}\n\n${body}`;
}

/**
 * Mount the handoff panel.
 *
 * @param {HTMLElement} host guaranteed to exist and to be empty
 * @param {{ count?: number, onSent?: (info: { sourceId: string, targetId: string, messages: number }) => void }} [opts]
 * @returns {{ destroy: () => void }}
 */
export function mountHandoff(host, opts = {}) {
  const uid = `ho-${++seq}`;
  const startCount = Math.max(1, Math.min(40, Number(opts.count) || 6));

  let messages = []; // the tail currently previewed, and the only thing send may use
  let block = ''; // the exact text send will deliver, built once when messages land
  let loadedKey = null; // the source identity `messages` belongs to
  let gen = 0; // request generation; a reply from an older gen is discarded
  let loading = false;
  let sending = false;
  let seeded = false;
  let fleetSig = null;
  let dead = false;

  host.classList.add('handoff');
  host.innerHTML = `
    <div class="ho-head">
      <span class="group-label">handoff</span>
      <span class="ho-meta" id="${uid}-meta"></span>
    </div>
    <div class="ho-row">
      <label class="ho-label" for="${uid}-from">from</label>
      <select class="ho-from" id="${uid}-from"></select>
    </div>
    <div class="ho-row">
      <label class="ho-label" for="${uid}-to">to</label>
      <select class="ho-to" id="${uid}-to"></select>
    </div>
    <div class="ho-row ho-row-count">
      <label class="ho-label" for="${uid}-count">messages</label>
      <input class="ho-count" id="${uid}-count" type="number" min="1" max="40" step="1"
        value="${startCount}" />
    </div>
    <div class="ho-preview" id="${uid}-preview" tabindex="0" role="region"
      aria-label="handoff preview"></div>
    <div class="ho-actions">
      <span class="ho-status" role="status" aria-live="polite"></span>
      <button type="button" class="ho-send primary" aria-describedby="${uid}-meta">send</button>
    </div>`;

  const fromSel = host.querySelector('.ho-from');
  const toSel = host.querySelector('.ho-to');
  const countInput = host.querySelector('.ho-count');
  const meta = host.querySelector('.ho-meta');
  const preview = host.querySelector('.ho-preview');
  const status = host.querySelector('.ho-status');
  const sendBtn = host.querySelector('.ho-send');

  // ---------------------------------------------------------------- small helpers

  function setStatus(text, tone = '') {
    status.textContent = text;
    status.dataset.tone = tone;
  }

  function setPreview(text, placeholder) {
    preview.textContent = text;
    preview.classList.toggle('ho-placeholder', Boolean(placeholder));
  }

  const clampCount = () => Math.max(1, Math.min(40, parseInt(countInput.value, 10) || 6));

  /** Everything that decides which transcript the preview is showing. */
  function identity() {
    const src = store.getInstance(fromSel.value);
    if (!src || !src.session_id) return null;
    const count = clampCount();
    return {
      id: src.id,
      name: src.name,
      cwd: src.cwd,
      sessionId: src.session_id,
      // Which machine wrote the transcript being read; null is this laptop.
      host: src.host || null,
      count,
      key: `${src.id}|${src.cwd}|${src.session_id}|${count}`,
    };
  }

  function updateActions() {
    if (loading) {
      meta.textContent = 'reading…';
    } else if (messages.length) {
      const last = messages[messages.length - 1];
      const when = last.ts ? ` · ${new Date(last.ts * 1000).toLocaleTimeString()}` : '';
      meta.textContent = `${messages.length} msg · ${(block.length / 1000).toFixed(1)}k chars${when}`;
    } else {
      meta.textContent = '';
    }
    sendBtn.disabled = dead || loading || sending || !block;
  }

  // ---------------------------------------------------------------- pickers

  function option(value, text, disabled = false) {
    const o = el('option');
    o.value = value;
    o.textContent = text;
    o.disabled = disabled;
    return o;
  }

  /**
   * Rebuild both lists, but only when the fleet they render actually moved. A rebuild on
   * every tick would close an open dropdown and drop keyboard focus once a second.
   */
  function fillSelects(instances, selected) {
    const sig = instances
      .map((i) => `${i.id}:${i.alive ? 1 : 0}:${i.session_id ? 1 : 0}:${i.group}/${i.name}`)
      .join(',');
    if (sig === fleetSig) return;
    fleetSig = sig;

    const prevFrom = fromSel.value;
    const prevTo = toSel.value;

    // A source needs a transcript on disk, which only exists once the hook has reported
    // a Claude session id for it.
    const sources = instances.filter((i) => i.session_id);
    fromSel.replaceChildren();
    if (!sources.length) fromSel.appendChild(option('', 'no instance has a transcript yet', true));
    for (const i of sources) fromSel.appendChild(option(i.id, label(i)));

    toSel.replaceChildren();
    if (!instances.length) toSel.appendChild(option('', 'nothing running', true));
    for (const i of instances) {
      toSel.appendChild(option(i.id, label(i) + (i.alive ? '' : ' (not running)')));
    }

    if (sources.some((i) => i.id === prevFrom)) fromSel.value = prevFrom;
    else if (!seeded && sources.some((i) => i.id === selected)) fromSel.value = selected;
    if (instances.some((i) => i.id === prevTo)) toSel.value = prevTo;
    if (sources.length) seeded = true;
  }

  // ---------------------------------------------------------------- preview

  async function loadPreview(force = false) {
    const ident = identity();
    if (!force && ident && ident.key === loadedKey && messages.length) return;

    const my = ++gen; // any newer request wins; this one's reply will be dropped
    messages = [];
    block = '';
    loadedKey = ident ? ident.key : null;

    if (!ident) {
      loading = false;
      setPreview(
        fromSel.value
          ? 'that instance has no transcript yet'
          : 'Pick a source. Its last messages are pasted into the target as one prompt.',
        true
      );
      updateActions();
      return;
    }

    loading = true;
    setStatus('');
    setPreview('reading transcript…', true);
    updateActions();

    let rows;
    try {
      rows = await transcriptTail(ident.cwd, ident.sessionId, ident.count, ident.host || null);
    } catch (err) {
      if (dead || my !== gen) return;
      loading = false;
      // loadedKey stays on the failed identity: the 1s tick must not turn one unreadable
      // transcript into a request per second. Re-picking the source retries it.
      setPreview('could not read that transcript', true);
      setStatus(String(err), 'warn');
      updateActions();
      return;
    }

    // Commit only if this is still the request the panel is waiting on and the source it
    // was asked about is still the selected one.
    const now = identity();
    if (dead || my !== gen || !now || now.key !== ident.key) return;

    loading = false;
    messages = rows;
    if (!rows.length) {
      block = '';
      setPreview('no messages in that transcript yet', true);
    } else {
      block = formatBlock(rows, ident);
      setPreview(
        block.length > PREVIEW_CHARS
          ? `${block.slice(0, PREVIEW_CHARS)}\n… ${block.length - PREVIEW_CHARS} more characters, all of it is sent`
          : block,
        false
      );
    }
    updateActions();
  }

  // ---------------------------------------------------------------- sending

  async function send() {
    if (dead || sending || loading) return;
    setStatus('');
    const sourceId = fromSel.value;
    const targetId = toSel.value;
    if (!sourceId || !targetId) {
      setStatus('pick a source and a target', 'warn');
      return;
    }
    if (sourceId === targetId) {
      setStatus('source and target must be different instances', 'warn');
      return;
    }
    const target = store.getInstance(targetId);
    if (!target || !target.alive) {
      setStatus('target is not running', 'warn');
      return;
    }
    const ident = identity();
    if (!ident || ident.key !== loadedKey || !block) {
      setStatus('nothing loaded to send', 'warn');
      return;
    }

    sending = true;
    updateActions();
    setStatus(`reading the current tail…`);
    // Re-read immediately before sending. The preview's key is id + cwd + session + count, and
    // none of those move when the source simply says more, so a preview loaded a few turns ago
    // would deliver a stale tail while the UI claimed it had sent the last n messages.
    let fresh;
    try {
      fresh = await transcriptTail(ident.cwd, ident.sessionId, ident.count, ident.host || null);
    } catch (err) {
      if (dead) return;
      sending = false;
      setStatus(`could not re-read the transcript: ${err}`, 'warn');
      updateActions();
      return;
    }
    if (dead) return;
    if (!fresh.length) {
      sending = false;
      setStatus('that transcript has no messages to send', 'warn');
      updateActions();
      return;
    }
    // Show what is actually going, so the preview and the delivery can never disagree.
    messages = fresh;
    block = formatBlock(fresh, ident);
    setPreview(
      block.length > PREVIEW_CHARS
        ? `${block.slice(0, PREVIEW_CHARS)}\n… ${block.length - PREVIEW_CHARS} more characters, all of it is sent`
        : block,
      false
    );

    setStatus(`sending to ${label(target)}…`);
    try {
      await handoffSend(sourceId, targetId, block);
      if (dead) return;
      const n = messages.length;
      setStatus(`sent ${n} message${n === 1 ? '' : 's'} to ${label(target)}`, 'ok');
      opts.onSent?.({ sourceId, targetId, messages: n });
    } catch (err) {
      if (dead) return;
      setStatus(String(err), 'warn');
    } finally {
      if (!dead) {
        sending = false;
        updateActions();
      }
    }
  }

  // ---------------------------------------------------------------- wiring

  fromSel.onchange = () => loadPreview();
  countInput.onchange = () => loadPreview();
  toSel.onchange = () => setStatus('');
  sendBtn.onclick = send;

  const off = store.subscribe(({ instances, selected }) => {
    fillSelects(instances, selected);
    const ident = identity();
    const key = ident ? ident.key : null;
    // The source's session id can change under a resume, and an instance can disappear
    // entirely; either way the preview no longer describes what is selected.
    if (key !== loadedKey) loadPreview(true);
    else updateActions();
  });

  return {
    destroy() {
      dead = true; // an in-flight request resolves into a torn-down panel and stops there
      off();
      fromSel.onchange = null;
      toSel.onchange = null;
      countInput.onchange = null;
      sendBtn.onclick = null;
      messages = [];
      block = '';
      host.replaceChildren();
      host.classList.remove('handoff');
    },
  };
}
