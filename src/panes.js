// Split-terminal stage: a 1 / 2 / 4 pane grid inside #mount-panes. Each pane owns
// one createTerm() handle from term.js and attaches it to a different instance id.
// An empty pane offers a picker of live instances not already held by another pane.
//
// Mirrors term.js (one factory handle per terminal, every listener closed over) and
// cards.js (subscribe to the store, re-render on the tick, never poll the backend).
//
// The failure mode this file is written around is a leaked `tmux attach` client, so
// every slot mutation goes through setSlot(), which serialises attach and detach on a
// per-pane promise chain and stamps each operation with a generation number. A late
// attach whose pane has since been cleared, replaced or destroyed is discarded, and
// the operation that superseded it owns the teardown of what it replaced.

import './panes.css';
import { stateColor, stateLabel } from './api.js';
import * as store from './store.js';
import { createTerm } from './term.js';

const LAYOUTS = [1, 2, 4];
const MAX = 4;

const el = (tag, cls) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  return n;
};

const idleFor = (s) => (s < 3600 ? `${Math.floor(s / 60)}m` : `${Math.floor(s / 3600)}h`);

/**
 * Fill #mount-panes with the split grid. Filling it hides the single #term stage,
 * which is a rule in style.css; this module never touches #term itself.
 *
 * @param {HTMLElement} host #mount-panes, guaranteed to exist and to be empty
 * @param {{ term?: object }} [opts] `term` is passed straight to createTerm()
 * @returns {{ destroy: () => Promise<void> }}
 */
export function mountPanes(host, opts = {}) {
  let layout = 1;
  let destroyed = false;
  let raf = 0;
  const slots = new Array(MAX).fill(null);
  const panes = [];

  // ---------------------------------------------------------------- chrome

  const root = el('div', 'panes');
  const toolbar = el('div', 'panes-toolbar');
  const grid = el('div', 'panes-grid');
  grid.dataset.layout = String(layout);

  const eyebrow = el('span', 'panes-eyebrow');
  eyebrow.textContent = 'split';
  toolbar.appendChild(eyebrow);

  const layoutBtns = LAYOUTS.map((n) => {
    const b = el('button', 'panes-layout');
    b.type = 'button';
    b.textContent = String(n);
    b.title = `${n} pane${n > 1 ? 's' : ''}`;
    b.setAttribute('aria-label', `${n} pane${n > 1 ? 's' : ''}`);
    b.onclick = () => setLayout(n);
    toolbar.appendChild(b);
    return b;
  });

  root.append(toolbar, grid);
  host.appendChild(root);

  for (let i = 0; i < MAX; i++) panes.push(buildPane(i));
  syncLayout();

  // ---------------------------------------------------------------- pane DOM

  function buildPane(index) {
    const node = el('div', 'panes-pane');
    node.dataset.slot = String(index);
    node.setAttribute('role', 'group');
    node.setAttribute('aria-label', `pane ${index + 1}, empty`);

    const head = el('div', 'panes-head');
    const dot = el('span', 'panes-dot');
    const name = el('span', 'panes-name');
    const state = el('span', 'panes-state');
    const closeBtn = el('button', 'panes-close');
    closeBtn.type = 'button';
    closeBtn.textContent = 'detach';
    closeBtn.title = 'detach pane';
    closeBtn.setAttribute('aria-label', `detach pane ${index + 1}`);
    closeBtn.hidden = true;
    closeBtn.onclick = (e) => {
      e.stopPropagation();
      setSlot(index, null);
    };
    head.append(dot, name, state, closeBtn);

    const body = el('div', 'panes-body');
    const termHost = el('div', 'panes-term');
    termHost.hidden = true;

    const empty = el('div', 'panes-empty');
    const label = el('div', 'panes-empty-label');
    label.textContent = 'attach an instance';
    const err = el('p', 'panes-err');
    err.hidden = true;
    const picker = el('div', 'panes-picker');
    empty.append(label, err, picker);

    body.append(termHost, empty);
    node.append(head, body);

    // Click anywhere that is not a control focuses this pane's terminal; focusin
    // also marks it active so a Tab into the terminal highlights the same pane.
    node.addEventListener('click', (e) => {
      if (e.target.closest('button')) return;
      markActive(index);
      panes[index].term?.focus();
    });
    node.addEventListener('focusin', () => markActive(index));

    grid.appendChild(node);
    return {
      root: node,
      dot,
      name,
      state,
      closeBtn,
      termHost,
      empty,
      err,
      picker,
      term: null,
      chain: Promise.resolve(),
      gen: 0,
      pickerKey: null,
    };
  }

  // ---------------------------------------------------------------- rendering

  function renderHead(index) {
    const pane = panes[index];
    const id = slots[index];
    const inst = id ? store.getInstance(id) : null;
    pane.closeBtn.hidden = !id;
    pane.dot.dataset.state = inst ? inst.state : 'empty';
    pane.dot.style.background = inst ? stateColor(inst.state) : 'var(--idle)';
    pane.name.textContent = inst ? `${inst.group}/${inst.name}` : id || 'empty pane';
    pane.state.textContent = inst ? headDetail(inst) : '';
    pane.root.setAttribute(
      'aria-label',
      inst ? `pane ${index + 1}, ${inst.name}, ${stateLabel(inst.state)}` : `pane ${index + 1}, empty`,
    );
  }

  function headDetail(inst) {
    const label = stateLabel(inst.state);
    return inst.state === 'idle' && inst.idle_secs >= 60 ? `${label} ${idleFor(inst.idle_secs)}` : label;
  }

  function renderBody(index) {
    const pane = panes[index];
    const filled = Boolean(slots[index]);
    pane.termHost.hidden = !filled;
    pane.empty.hidden = filled;
    pane.err.hidden = !pane.err.textContent;
  }

  /**
   * Rebuild one empty pane's picker, but only when the set of candidate instances
   * actually moved. Rebuilding on every 1s tick would destroy the button under a
   * keyboard user's focus and flicker the hit targets under a mouse.
   */
  function refreshPicker(index) {
    const pane = panes[index];
    if (index >= layout || slots[index]) return;

    const candidates = store.getInstances().filter((i) => i.alive && !slots.includes(i.id));
    const key = candidates.map((i) => i.id).join(',');
    if (pane.pickerKey === key) return;
    pane.pickerKey = key;

    const active = document.activeElement;
    const keepId = active && pane.picker.contains(active) ? active.dataset.id : null;

    if (!candidates.length) {
      const p = el('p', 'muted');
      p.textContent = 'no unattached live instances';
      pane.picker.replaceChildren(p);
      return;
    }

    const buttons = candidates.map((i) => {
      const b = el('button', 'panes-pick');
      b.type = 'button';
      b.dataset.id = i.id;
      b.textContent = `${i.group}/${i.name}`;
      b.title = `${i.cwd} · ${stateLabel(i.state)}`;
      b.onclick = (e) => {
        e.stopPropagation();
        assign(index, i.id);
      };
      return b;
    });
    pane.picker.replaceChildren(...buttons);
    if (keepId) pane.picker.querySelector(`button[data-id="${CSS.escape(keepId)}"]`)?.focus();
  }

  /** Every empty pane's availability changes the moment any slot changes. */
  function refreshPickers() {
    for (let i = 0; i < layout; i++) refreshPicker(i);
  }

  function setError(index, msg) {
    const pane = panes[index];
    pane.err.textContent = msg || '';
    pane.err.hidden = !msg;
  }

  // ---------------------------------------------------------------- slots

  /**
   * Put `id` (or null) in a slot. Returns the promise for the attach or detach so a
   * caller that must order work after it, layout changes and teardown, can await it.
   */
  function setSlot(index, id) {
    const pane = panes[index];
    const gen = ++pane.gen;
    slots[index] = id;
    if (id) setError(index, '');
    renderHead(index);
    renderBody(index);
    refreshPickers();

    pane.chain = pane.chain.then(async () => {
      if (pane.gen !== gen) return; // superseded before this op ran; the later op owns the term
      if (!id) {
        await pane.term?.detach();
        return;
      }
      if (destroyed) return;
      if (!pane.term) pane.term = createTerm(pane.termHost, opts.term);
      let ok = false;
      let msg = 'attach failed';
      try {
        ok = await pane.term.attach(id);
      } catch (err) {
        msg = String(err);
      }
      if (pane.gen !== gen) return; // replaced or cleared while attaching
      if (ok) {
        pane.term.fit();
        return;
      }
      // Free the id again so the pane is retryable and no other pane is blocked.
      slots[index] = null;
      setError(index, `argus: ${msg}`);
      renderHead(index);
      renderBody(index);
      refreshPickers();
    });
    pane.chain = pane.chain.catch((err) => console.error('[argus] pane slot', err));
    return pane.chain;
  }

  /** Picker click. Re-checks availability, because the picker is a snapshot. */
  function assign(index, id) {
    if (slots.includes(id)) {
      refreshPickers();
      return Promise.resolve();
    }
    const inst = store.getInstance(id);
    if (!inst || !inst.alive) {
      refreshPickers();
      return Promise.resolve();
    }
    return setSlot(index, id);
  }

  function markActive(index) {
    panes.forEach((p, i) => p.root.classList.toggle('on', i === index));
    const id = slots[index];
    if (id) store.setSelected(id);
  }

  // ---------------------------------------------------------------- layout

  function syncLayout() {
    grid.dataset.layout = String(layout);
    layoutBtns.forEach((b, i) => {
      const on = LAYOUTS[i] === layout;
      b.classList.toggle('on', on);
      b.setAttribute('aria-pressed', String(on));
    });
    for (let i = 0; i < MAX; i++) panes[i].root.hidden = i >= layout;
  }

  /**
   * Change the grid. Only the panes being dropped are detached, and the detach is
   * awaited: kept panes keep the exact term handle and pty they already hold, so no
   * attach client is churned and no re-attach can race a pending detach.
   */
  async function setLayout(n) {
    if (!LAYOUTS.includes(n) || n === layout) return;
    layout = n;
    syncLayout();
    const dropped = [];
    for (let i = n; i < MAX; i++) if (slots[i]) dropped.push(setSlot(i, null));
    refreshPickers();
    fitAll();
    await Promise.all(dropped);
    if (!destroyed) fitAll();
  }

  function fitAll() {
    for (let i = 0; i < layout; i++) panes[i].term?.fit();
  }

  function onResize() {
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(fitAll);
  }
  window.addEventListener('resize', onResize);

  // ---------------------------------------------------------------- the tick

  const off = store.subscribe(({ instances }) => {
    for (let i = 0; i < layout; i++) {
      const id = slots[i];
      if (!id) {
        refreshPicker(i);
        continue;
      }
      const inst = instances.find((x) => x.id === id);
      if (!inst || !inst.alive) {
        setError(i, inst ? `argus: ${inst.name} is not running` : 'argus: instance closed');
        setSlot(i, null);
        continue;
      }
      renderHead(i);
    }
  });

  for (let i = 0; i < MAX; i++) {
    renderHead(i);
    renderBody(i);
  }
  refreshPickers();

  return {
    /**
     * Detach every pty this grid opened, then tear the terminals down. Awaited by the
     * caller before it re-attaches any of those ids to another terminal: dispose() resolves
     * once the pty is actually released, and a re-attach that overtook it would be a no-op
     * followed by this detach killing the pty the new terminal thought it had.
     */
    async destroy() {
      if (destroyed) return;
      destroyed = true;
      off();
      window.removeEventListener('resize', onResize);
      cancelAnimationFrame(raf);
      await Promise.all(
        panes.map((p) =>
          p.chain
            .catch(() => {})
            .then(() => p.term?.dispose())
            .catch(() => {}),
        ),
      );
      host.replaceChildren();
    },
  };
}
