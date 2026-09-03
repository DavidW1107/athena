// The list rendering that is not the tile grid: the needs-you strip, the header
// counts, and the two read-only panels behind their header buttons.
// Each mount subscribes to the store itself and returns a destroy function.

import { codexTasks, pastSessions, resumeSession } from './api.js';
import * as store from './store.js';

const el = (tag, cls) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  return n;
};

// ------------------------------------------------------------------ one card

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
        r.querySelector('.row-sub').textContent =
          `${new Date(s.mtime * 1000).toLocaleString()}${s.last_prompt ? `  |  ${s.last_prompt}` : ''}`;
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
