// The whole stage: every instance visible at once, one tile per repo group.
//
// The rule that shapes this file: a GROUP takes one tile's footprint no matter how many
// instances it holds, the way a terminal window holds tabs. So a tile owns exactly one
// terminal, the tabs choose which instance that terminal is showing, and an inactive tab
// holds no pty at all. tmux keeps the session's screen, so switching back redraws it.
//
// That is also what makes "as many as I open" affordable: N groups means N ptys, not N
// instances. The grid never shrinks a tile below a readable width; it scrolls instead.

import { closeInstance, restore, setGroup, setPaused, stateLabel, tmuxScroll } from './api.js';
import * as store from './store.js';
import { createTerm } from './term.js';
import { MIME_INSTANCE, MIME_TILE, dragPayload, isDroppable } from './dnd.js';
import './grid.css';

const ORDER_KEY = 'athena.tileOrder';
const SPANS_KEY = 'athena.tileSpans';
const FONT_KEY = 'athena.tileFont';

const MAX_SPAN_X = 4;
const MAX_SPAN_Y = 3;
const MIN_FONT = 8;
const MAX_FONT = 24;
const DEFAULT_FONT = 12.5;

/** Small keyed maps of per-tile preferences, all failing soft to an empty object. */
function readMap(key) {
  try {
    const v = JSON.parse(localStorage.getItem(key) || '{}');
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
  } catch {
    return {};
  }
}

function writeMap(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // A full or blocked localStorage costs a remembered preference and nothing else.
  }
}

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
  let spans = readMap(SPANS_KEY);
  let fonts = readMap(FONT_KEY);
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
    // Launch straight into THIS group. Grouping is by repo, so handing the launcher this
    // tile's directory is all it takes for the new instance to land back in this tile.
    const plus = el('button', 'tile-plus', '+');
    plus.type = 'button';
    plus.title = `new instance in ${group}`;
    plus.setAttribute('aria-label', `new instance in ${group}`);
    plus.onclick = (e) => {
      e.stopPropagation();
      const any = store.getInstances().find((i) => i.group === group);
      opts.onNewInTile?.({ group, cwd: any ? any.cwd : '', cmd: any ? any.cmd : '' });
    };

    const actions = el('div', 'tile-actions');
    head.append(title, tabs, plus, actions);

    const body = el('div', 'tile-body');
    const termHost = el('div', 'tile-term');
    const msg = el('div', 'tile-msg');
    msg.hidden = true;
    body.append(termHost, msg);

    // Resize by whole grid cells. Snapping is what keeps the grid gapless: a free pixel
    // size would take the tile out of the track and leave holes around it.
    const grip = el('div', 'tile-grip');
    grip.title = 'drag to resize by whole cells';
    grip.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      grip.setPointerCapture(e.pointerId);
      const startX = e.clientX;
      const startY = e.clientY;
      const rect = root.getBoundingClientRect();
      const move = (ev) => {
        const { colW, rowH, colCount } = cellMetrics();
        const sx = clamp(Math.round((rect.width + ev.clientX - startX) / colW), 1, Math.min(MAX_SPAN_X, colCount));
        const sy = clamp(Math.round((rect.height + ev.clientY - startY) / rowH), 1, MAX_SPAN_Y);
        applySpan(group, sx, sy);
      };
      const up = () => {
        grip.removeEventListener('pointermove', move);
        grip.removeEventListener('pointerup', up);
        writeMap(SPANS_KEY, spans);
      };
      grip.addEventListener('pointermove', move);
      grip.addEventListener('pointerup', up);
    });

    // Ctrl and the wheel is the terminal zoom, scoped to THIS terminal. Without
    // preventDefault the webview zooms the entire window instead, which is not what a
    // per-terminal size control should do.
    // Capture phase, because xterm listens on its own element and would otherwise forward
    // the wheel to the application first. Claude Code reads a forwarded wheel as "cycle
    // through past messages", which is what made scrolling up walk the conversation instead
    // of showing what had scrolled off the top.
    body.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (e.ctrlKey) {
          bumpFont(group, e.deltaY < 0 ? 1 : -1);
          return;
        }
        const tile = tiles.get(group);
        if (!tile?.activeId) return;
        // deltaMode 0 is pixels, 1 is already lines. Three lines a notch matches a terminal.
        const lines = e.deltaMode === 1 ? Math.round(e.deltaY) : Math.round(e.deltaY / 40) || (e.deltaY > 0 ? 1 : -1);
        tmuxScroll(tile.activeId, -lines).catch(() => {});
      },
      { passive: false, capture: true }
    );

    // Double click the header to fill the window with this tile, again to put it back. A
    // transient view, deliberately not persisted: it is a way to read something, not a layout.
    head.addEventListener('dblclick', (e) => {
      if (e.target.closest('button')) return;
      e.preventDefault();
      toggleZoom(group);
    });

    root.append(head, body, grip);

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
      const payload = dragPayload(e.dataTransfer);
      if (!payload) return;
      e.preventDefault();
      if (payload.kind === 'instance') {
        // Merging two tiles is moving their instances: grouping lives on the instance, so
        // nothing about the terminal or its session moves, only which tile draws it.
        const inst = store.getInstance(payload.value);
        if (inst && inst.group !== group) {
          setGroup(payload.value, group).then(store.refresh).catch((err) => console.error('[athena] merge', err));
        }
      } else if (payload.value && payload.value !== group) {
        reorder(payload.value, group);
      }
    });

    // Keyboard equivalent of the ctrl-wheel zoom, so the size control is reachable without
    // a pointer. Bound on the tile so it applies to whichever terminal has focus.
    root.addEventListener('keydown', (e) => {
      if (!e.ctrlKey) return;
      if (e.key === '=' || e.key === '+') bumpFont(group, 1);
      else if (e.key === '-' || e.key === '_') bumpFont(group, -1);
      else if (e.key === '0') resetFont(group);
      else return;
      e.preventDefault();
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
      grip,
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
      if (!tile.term) {
        tile.term = createTerm(tile.termHost, { ...opts.term, fontSize: fontFor(tile.group) });
      }
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

  // ---------------------------------------------------------------- size and zoom

  const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));

  /** One grid cell plus one gap, read off the live computed grid rather than assumed. */
  function cellMetrics() {
    const cs = getComputedStyle(grid);
    const cols = cs.gridTemplateColumns.split(' ').map(parseFloat).filter((n) => n > 0);
    const rows = cs.gridTemplateRows.split(' ').map(parseFloat).filter((n) => n > 0);
    const gap = parseFloat(cs.rowGap) || 0;
    return {
      colW: (cols[0] || 460) + gap,
      rowH: (rows[0] || 300) + gap,
      colCount: Math.max(1, cols.length),
    };
  }

  function applySpan(group, sx, sy) {
    const tile = tiles.get(group);
    if (!tile) return;
    spans[group] = [sx, sy];
    tile.root.style.gridColumn = sx > 1 ? `span ${sx}` : '';
    tile.root.style.gridRow = sy > 1 ? `span ${sy}` : '';
    // term.js observes its own mount element, so the refit follows from the layout change.
  }

  function restoreSpan(group) {
    const s = spans[group];
    if (Array.isArray(s) && s.length === 2) applySpan(group, s[0], s[1]);
  }

  function fontFor(group) {
    const n = Number(fonts[group]);
    return Number.isFinite(n) ? clamp(n, MIN_FONT, MAX_FONT) : DEFAULT_FONT;
  }

  function bumpFont(group, step) {
    const tile = tiles.get(group);
    if (!tile) return;
    const next = clamp(fontFor(group) + step, MIN_FONT, MAX_FONT);
    if (next === fontFor(group)) return;
    fonts[group] = next;
    writeMap(FONT_KEY, fonts);
    if (tile.term) {
      tile.term.term.options.fontSize = next;
      tile.term.fit();
    }
  }

  function resetFont(group) {
    delete fonts[group];
    writeMap(FONT_KEY, fonts);
    const tile = tiles.get(group);
    if (tile?.term) {
      tile.term.term.options.fontSize = DEFAULT_FONT;
      tile.term.fit();
    }
  }

  /** Fill the grid with one tile, or restore the layout. Terminals refit themselves. */
  function toggleZoom(group) {
    const tile = tiles.get(group);
    if (!tile) return;
    const on = !tile.root.classList.contains('zoomed');
    for (const t of tiles.values()) t.root.classList.remove('zoomed');
    tile.root.classList.toggle('zoomed', on);
    grid.classList.toggle('has-zoom', on);
    if (on) focusTile(group);
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
      // Drag a tab onto another tile to move that instance there, which is also how two
      // tiles that should have been one get merged.
      tab.draggable = true;
      tab.addEventListener('dragstart', (ev) => {
        ev.stopPropagation();
        ev.dataTransfer.setData(MIME_INSTANCE, i.id);
        ev.dataTransfer.effectAllowed = 'move';
      });
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
      if (tile.root.classList.contains('zoomed')) grid.classList.remove('has-zoom');
      tile.gen += 1; // cancel anything still queued on this tile
      tile.root.remove();
      tile.term?.dispose();
    }

    let added = false;
    for (const g of groups) {
      if (tiles.has(g)) continue;
      tiles.set(g, buildTile(g));
      restoreSpan(g);
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
    toggleZoom,
    zoom: bumpFont,
    resetZoom: resetFont,
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
