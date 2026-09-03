// All list rendering that reads the fleet: the grouped instance cards, the
// needs-you strip, the header counts, the stage bar, and the two read-only tabs.
// Each mount subscribes to the store itself and returns a destroy function.

import {
  closeInstance,
  codexTasks,
  pastSessions,
  restore,
  resumeSession,
  setPaused,
  stateLabel,
} from './api.js';
import * as store from './store.js';

const el = (tag, cls) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  return n;
};

// ------------------------------------------------------------------ one card

/**
 * Build one instance card. Exported so a feature can reuse the exact card chrome
 * in its own panel instead of re-styling one.
 * @param {Object} i InstanceView
 * @param {{ selected?: string|null, onSelect?: Function, onClosed?: Function }} h
 * @returns {HTMLElement}
 */
export function card(i, h = {}) {
  const { selected = null, onSelect, onClosed } = h;
  const node = el('div', 'card' + (i.id === selected ? ' sel' : ''));
  node.dataset.state = i.state;
  const detail = i.state === 'working' && i.tool ? i.tool : i.summary || i.cmd;
  node.innerHTML = `
    <div class="banner"></div>
    <div class="card-body">
      <div class="card-top">
        <span class="card-name"></span>
        <span class="card-state"></span>
      </div>
      <div class="card-sub"></div>
      <div class="card-actions"></div>
    </div>`;
  node.querySelector('.card-name').textContent = i.name;
  node.querySelector('.card-state').textContent = stateLabel(i.state);
  node.querySelector('.card-sub').textContent = detail || '';

  const acts = node.querySelector('.card-actions');
  const btn = (label, fn) => {
    const b = el('button');
    b.textContent = label;
    b.onclick = (e) => {
      e.stopPropagation();
      fn();
    };
    acts.appendChild(b);
  };

  if (!i.alive) btn('restore', () => restore(i.id).then(store.refresh));
  else if (i.paused) btn('resume', () => setPaused(i.id, false).then(store.refresh));
  else btn('pause', () => setPaused(i.id, true).then(store.refresh));
  btn('close', async () => {
    if (!confirm(`Close ${i.name}?`)) return;
    await closeInstance(i.id);
    onClosed?.(i.id);
    await store.refresh();
  });

  node.onclick = () => onSelect?.(i.id);
  return node;
}

// ------------------------------------------------------------------ mounts

/**
 * Grouped instance cards, one group heading per git repo.
 * @param {HTMLElement} host
 * @param {{ onSelect?: (id: string) => void, onClosed?: (id: string) => void }} h
 * @returns {{ destroy: () => void }}
 */
export function mountCards(host, h = {}) {
  const off = store.subscribe(({ instances, selected }) => {
    host.replaceChildren();
    const groups = new Map();
    for (const i of instances) {
      if (!groups.has(i.group)) groups.set(i.group, []);
      groups.get(i.group).push(i);
    }
    for (const [g, list] of [...groups].sort((a, b) => a[0].localeCompare(b[0]))) {
      const head = el('div', 'group-label');
      head.textContent = `${g} · ${list.length}`;
      host.appendChild(head);
      for (const i of list) host.appendChild(card(i, { selected, ...h }));
    }
    if (!instances.length) {
      host.innerHTML = '<p class="muted">No instances. Hit <b>+ instance</b>.</p>';
    }
  });
  return { destroy: off };
}

/**
 * The amber strip of instances whose state is 'needs-you'. Hides itself when empty.
 * @param {HTMLElement} host
 * @param {{ onSelect?: (id: string) => void }} h
 * @returns {{ destroy: () => void }}
 */
export function mountAttention(host, h = {}) {
  const off = store.subscribe(({ instances }) => {
    const needs = instances.filter((i) => i.state === 'needs-you');
    host.hidden = !needs.length;
    host.replaceChildren();
    if (!needs.length) return;
    const b = el('b');
    b.textContent = `needs you (${needs.length})`;
    host.appendChild(b);
    for (const i of needs) {
      const btn = el('button');
      btn.textContent = `${i.group}/${i.name}`;
      btn.onclick = () => h.onSelect?.(i.id);
      host.appendChild(btn);
    }
  });
  return { destroy: off };
}

/** "n/m live · k waiting" in the header. */
export function mountCounts(host) {
  const off = store.subscribe(({ instances }) => {
    const alive = instances.filter((i) => i.alive).length;
    const needs = instances.filter((i) => i.state === 'needs-you').length;
    host.textContent = `${alive}/${instances.length} live · ${needs} waiting`;
  });
  return { destroy: off };
}

/** Name, cwd and state of the selected instance, above the terminal. */
export function mountStageBar(host) {
  const off = store.subscribe(({ instances, selected }) => {
    const inst = instances.find((i) => i.id === selected);
    host.replaceChildren();
    if (!inst) {
      const s = el('span', 'muted');
      s.textContent = 'no instance selected';
      host.appendChild(s);
      return;
    }
    const name = el('span');
    name.textContent = inst.name;
    const cwd = el('span', 'muted');
    cwd.textContent = inst.cwd;
    const st = el('span', 'muted');
    st.textContent = stateLabel(inst.state);
    host.append(name, cwd, st);
  });
  return { destroy: off };
}

// ------------------------------------------------------------------ read-only tabs

/**
 * Past Claude sessions for every cwd currently in the fleet. Rendered on demand
 * (it costs one past_sessions call per directory), so call render() when shown.
 * @returns {{ render: () => Promise<void> }}
 */
export function mountSessions(host, h = {}) {
  async function render() {
    host.replaceChildren();
    const cwds = [...new Set(store.getInstances().map((i) => i.cwd))];
    if (!cwds.length) {
      host.innerHTML =
        '<p class="muted">Launch something first; this lists past sessions for those directories.</p>';
      return;
    }
    for (const cwd of cwds) {
      const head = el('div', 'group-label');
      head.textContent = cwd.split('/').pop();
      host.appendChild(head);
      const rows = await pastSessions(cwd);
      for (const s of rows) {
        const r = el('div', 'row');
        r.innerHTML = '<div class="row-title"></div><div class="row-sub"></div>';
        r.querySelector('.row-title').textContent = s.title;
        r.querySelector('.row-sub').textContent = new Date(s.mtime * 1000).toLocaleString();
        r.onclick = async () => {
          const v = await resumeSession(cwd, s.session_id, s.title.slice(0, 24));
          await store.refresh();
          h.onResumed?.(v.id);
        };
        host.appendChild(r);
      }
    }
  }
  return { render };
}

/**
 * The ~/.codex/tasks lane, newest first.
 * @returns {{ render: () => Promise<void> }}
 */
export function mountCodex(host) {
  async function render() {
    host.replaceChildren();
    const rows = await codexTasks();
    if (!rows.length) {
      host.innerHTML = '<p class="muted">No codex-task runs in ~/.codex/tasks.</p>';
      return;
    }
    for (const t of rows) {
      const r = el('div', 'row');
      r.innerHTML = '<div class="row-title"></div><div class="row-sub"></div>';
      r.querySelector('.row-title').textContent = `${t.status === 'running' ? '● ' : ''}${t.name}`;
      r.querySelector('.row-sub').textContent = `${t.status} · ${t.tail}`;
      r.title = t.dir;
      host.appendChild(r);
    }
  }
  return { render };
}
