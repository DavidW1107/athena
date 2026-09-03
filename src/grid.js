// The whole stage: every instance visible at once, one tile per repo group.
//
// The rule that shapes this file: a GROUP takes one tile's footprint no matter how many
// instances it holds, the way a terminal window holds tabs. So a tile owns exactly one
// terminal, the tabs choose which instance that terminal is showing, and an inactive tab
// holds no pty at all. tmux keeps the session's screen, so switching back redraws it.
//
// That is also what makes "as many as I open" affordable: N groups means N ptys, not N
// instances. The grid never shrinks a tile below a readable width; it scrolls instead.

import { closeInstance, restore, setPaused, stateLabel } from './api.js';
import * as store from './store.js';
import { createTerm } from './term.js';
import { MIME_TILE, dragPayload, isDroppable } from './dnd.js';
import './grid.css';

const ORDER_KEY = 'athena.tileOrder';

const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
};

/** Tile order the user dragged into place. Unknown groups sort after it, alphabetically. */
function readOrder() {
  try {
    const v = JSON.parse(localStorage.getItem(ORDER_KEY) || '[]');
    return Array.isArray(v) ? v.filter((x) => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

function writeOrder(order) {
  try {
    localStorage.setItem(ORDER_KEY, JSON.stringify(order));
  } catch {
    // A full or blocked localStorage costs the remembered order and nothing else.
  }
}

/**
 * Mount the tiled grid.
 *
 *   const grid = mountGrid(document.querySelector('#grid'));
 *   await grid.destroy();
 *
 * @param {HTMLElement} host
 * @param {{ term?: object }} [opts]
 * @returns {{ destroy: () => Promise<void>, focusGroup: (group: string) => void }}
 */
export function mountGrid(host, opts = {}) {
  /** @type {Map<string, any>} */
  const tiles = new Map();
  let order = readOrder();
  let destroyed = false;
  let dragging = null;

  const grid = el('div', 'grid');
  const empty = el('p', 'grid-empty', 'No instances yet. Launch one, or adopt something already running.');
  host.replaceChildren(grid, empty);

  // ---------------------------------------------------------------- tile construction

  function buildTile(group) {
    const root = el('section', 'tile');
    root.dataset.group = group;

    const head = el('div', 'tile-head');
    head.draggable = true;
    const title = el('span', 'tile-group', group);
    const tabs = el('div', 'tile-tabs');
    tabs.setAttribute('role', 'tablist');
    tabs.setAttribute('aria-label', `instances in ${group}`);
    const actions = el('div', 'tile-actions');
    head.append(title, tabs, actions);

    const body = el('div', 'tile-body');
    const termHost = el('div', 'tile-term');
    const msg = el('div', 'tile-msg');
    msg.hidden = true;
    body.append(termHost, msg);

    root.append(head, body);

    head.addEventListener('dragstart', (e) => {
      dragging = group;
      e.dataTransfer.setData(MIME_TILE, group);
      e.dataTransfer.effectAllowed = 'move';
      root.classList.add('dragging');
    });
    head.addEventListener('dragend', () => {
      dragging = null;
      root.classList.remove('dragging');
      for (const n of grid.querySelectorAll('.tile.over')) n.classList.remove('over');
    });

    // dragenter and dragleave also fire for descendants, so the highlight is reference
    // counted rather than toggled; crossing a child would otherwise clear it early.
    let overDepth = 0;
    root.addEventListener('dragenter', (e) => {
      if (!isDroppable(e.dataTransfer) || dragging === group) return;
      e.preventDefault();
      overDepth += 1;
      root.classList.add('over');
    });
    root.addEventListener('dragover', (e) => {
      if (!isDroppable(e.dataTransfer) || dragging === group) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
    });
    root.addEventListener('dragleave', () => {
      overDepth = Math.max(0, overDepth - 1);
      if (overDepth === 0) root.classList.remove('over');
    });
    root.addEventListener('drop', (e) => {
      overDepth = 0;
      root.classList.remove('over');
      const from = dragPayload(e.dataTransfer);
      if (!from || from === group) return;
      e.preventDefault();
      reorder(from, group);
    });

    // Clicking anywhere that is not a control focuses this tile's terminal, which is also
    // what makes it the selected instance for auto-pause and handoff.
    root.addEventListener('click', (e) => {
      if (e.target.closest('button')) return;
      focusTile(group);
    });

    grid.appendChild(root);
    return {
      group,
      root,
      head,
      tabs,
      actions,
      termHost,
      msg,
      term: null,
      activeId: null,
      chain: Promise.resolve(),
      gen: 0,
    };
  }

  // ---------------------------------------------------------------- ordering

  function reorder(from, before) {
    const groups = [...tiles.keys()];
    const next = order.filter((g) => groups.includes(g) && g !== from);
    for (const g of groups) if (!next.includes(g) && g !== from) next.push(g);
    const at = next.indexOf(before);
    next.splice(at < 0 ? next.length : at, 0, from);
    order = next;
    writeOrder(order);
    applyOrder();
  }

  function applyOrder() {
    const sorted = [...tiles.keys()].sort((a, b) => {
      const ia = order.indexOf(a);
      const ib = order.indexOf(b);
      if (ia >= 0 && ib >= 0) return ia - ib;
      if (ia >= 0) return -1;
      if (ib >= 0) return 1;
      return a.localeCompare(b);
    });
    for (const g of sorted) grid.appendChild(tiles.get(g).root);
  }

  // ---------------------------------------------------------------- attach

  /**
   * Point a tile's single terminal at one instance.
   *
   * One terminal per tile is the whole reason a group costs one footprint, so switching
   * tab is an attach on the same handle. term.attach detaches the previous id first, and
   * pty.rs keys one pty per instance id, so nothing else can be holding what we release.
   */
  function setActive(tile, id) {
    const gen = ++tile.gen;
    tile.activeId = id;
    renderTile(tile);

    tile.chain = tile.chain.then(async () => {
      if (tile.gen !== gen || destroyed) return;
      const inst = id ? store.getInstance(id) : null;
      if (!inst || !inst.alive) {
        await tile.term?.detach();
        return;
      }
      if (!tile.term) tile.term = createTerm(tile.termHost, opts.term);
      let ok = false;
      let why = 'attach failed';
      try {
        ok = await tile.term.attach(id);
      } catch (err) {
        why = String(err);
      }
      if (tile.gen !== gen) return; // the user switched tab while this was attaching
      if (ok) {
        tile.term.fit();
      } else {
        showMessage(tile, `athena: ${why}`);
      }
    });
    tile.chain = tile.chain.catch((err) => console.error('[athena] tile', err));
    return tile.chain;
  }

  function showMessage(tile, text, action) {
    tile.msg.replaceChildren(el('span', null, text));
    if (action) {
      const b = el('button', 'ghost', action.label);
      b.type = 'button';
      b.onclick = action.run;
      tile.msg.appendChild(b);
    }
    tile.msg.hidden = false;
    tile.termHost.hidden = true;
  }

  function focusTile(group) {
    const tile = tiles.get(group);
    if (!tile) return;
    for (const [g, t] of tiles) t.root.classList.toggle('on', g === group);
    if (tile.activeId) store.setSelected(tile.activeId);
    tile.term?.focus();
  }

  // ---------------------------------------------------------------- rendering

  function renderTile(tile) {
    const members = store
      .getInstances()
      .filter((i) => i.group === tile.group)
      .sort((a, b) => a.created - b.created);

    // Tabs. Rebuilt each render because a tab is cheap and its state changes every second.
    tile.tabs.replaceChildren();
    for (const i of members) {
      const tab = el('button', 'tile-tab' + (i.id === tile.activeId ? ' on' : ''));
      tab.type = 'button';
      tab.setAttribute('role', 'tab');
      tab.setAttribute('aria-selected', String(i.id === tile.activeId));
      tab.title = `${i.name}: ${stateLabel(i.state)}`;
      const dot = el('span', 'tile-dot');
      dot.dataset.state = i.state;
      tab.append(dot, el('span', 'tile-tab-name', i.name));
      tab.onclick = (e) => {
        e.stopPropagation();
        if (i.id !== tile.activeId) setActive(tile, i.id);
        focusTile(tile.group);
      };
      tile.tabs.appendChild(tab);
    }
    // A single healthy instance needs no tab strip, but then the head is the only place
    // its name can appear, so the title carries it instead of just the group.
    const soloTabs = members.length < 2 && members.every((i) => i.alive);
    tile.tabs.hidden = soloTabs;
    const solo = soloTabs ? members[0] : null;
    tile.head.querySelector('.tile-group').textContent =
      solo && solo.name !== tile.group ? `${tile.group} / ${solo.name}` : tile.group;

    // Actions apply to the active instance only, so the row never becomes a wall of buttons.
    const active = tile.activeId ? store.getInstance(tile.activeId) : null;
    tile.actions.replaceChildren();
    if (active) {
      const state = el('span', 'tile-state', stateLabel(active.state));
      state.dataset.state = active.state;
      tile.actions.appendChild(state);
      const btn = (label, run, title) => {
        const b = el('button', 'ghost', label);
        b.type = 'button';
        if (title) b.title = title;
        b.onclick = (e) => {
          e.stopPropagation();
          run();
        };
        tile.actions.appendChild(b);
      };
      if (!active.alive) btn('restore', () => restore(active.id).then(store.refresh));
      else if (active.paused) btn('resume', () => setPaused(active.id, false).then(store.refresh));
      else btn('pause', () => setPaused(active.id, true).then(store.refresh));
      btn('close', () => {
        if (window.confirm(`Close ${active.name}?`)) closeInstance(active.id).then(store.refresh);
      }, 'kill the tmux session and forget the instance');
    }

    // Body: a live instance shows its terminal, anything else says why it does not.
    if (active && active.alive) {
      tile.msg.hidden = true;
      tile.termHost.hidden = false;
    } else if (active) {
      showMessage(tile, `${active.name} is ${stateLabel(active.state)}.`, {
        label: 'restore',
        run: () => restore(active.id).then(store.refresh),
      });
    } else {
      showMessage(tile, 'No instances in this group.');
    }
  }

  // ---------------------------------------------------------------- store sync

  function sync() {
    if (destroyed) return;
    const instances = store.getInstances();
    const groups = new Set(instances.map((i) => i.group));

    for (const [g, tile] of [...tiles]) {
      if (groups.has(g)) continue;
      tiles.delete(g);
      tile.gen += 1; // cancel anything still queued on this tile
      tile.root.remove();
      tile.term?.dispose();
    }

    let added = false;
    for (const g of groups) {
      if (tiles.has(g)) continue;
      tiles.set(g, buildTile(g));
      added = true;
    }

    for (const [g, tile] of tiles) {
      const members = instances.filter((i) => i.group === g);
      const stillThere = members.some((i) => i.id === tile.activeId);
      if (!stillThere) {
        // Prefer something alive so a tile does not open on a corpse when one exists.
        const next = members.find((i) => i.alive) || members[0];
        setActive(tile, next ? next.id : null);
      } else {
        renderTile(tile);
      }
    }

    if (added) applyOrder();
    empty.hidden = tiles.size > 0;
    grid.hidden = tiles.size === 0;
  }

  store.subscribe(sync);
  sync();

  return {
    focusGroup: focusTile,
    async destroy() {
      destroyed = true;
      store.unsubscribe(sync);
      await Promise.all([...tiles.values()].map((t) => t.chain.catch(() => {})));
      await Promise.all([...tiles.values()].map((t) => t.term?.dispose()));
      tiles.clear();
      host.replaceChildren();
    },
  };
}
