// CONVERGENCE POINT. Wiring only: create the store, mount each panel onto its
// element, start the polls. No feature logic lives here, and a feature shard never
// edits this file - integration adds its import and its one mount call below.

import { isPermissionGranted, requestPermission, sendNotification } from '@tauri-apps/plugin-notification';

import { pbuildResumeAll } from './api.js';
import * as store from './store.js';
import { createTerm } from './term.js';
import { mountAttention, mountCards, mountCodex, mountCounts, mountSessions, mountStageBar } from './cards.js';
import { mountLauncher } from './launcher.js';
import { mountAdopt } from './adopt.js';
import { mountAutopause } from './autopause.js';
import { mountBroadcast } from './broadcast.js';
import { mountCost } from './cost.js';
import { mountHandoff } from './handoff.js';
import { mountPanes } from './panes.js';

const $ = (s) => document.querySelector(s);

// ------------------------------------------------------------------ terminal

const term = createTerm($('#term'));

// Exactly one thing owns the ptys: either this single stage terminal or the split grid,
// never both. pty.rs keys one pty per instance id, so a hidden #term still attached to an
// id a pane also holds would make that pane's detach kill the shared pty, and this file's
// `attachedId === id` guard would then refuse to bring it back. `panes` non-null means the
// grid owns every attach, and the stage term is detached before the grid is ever mounted.
let panes = null;

// Every attach, detach and mode change runs in order on one chain, so a click during a
// mode switch cannot interleave with the detach it is waiting on.
let stage = Promise.resolve();
const onStage = (fn) => {
  stage = stage.then(fn).catch((err) => console.error('[athena] stage', err));
  return stage;
};

function select(id) {
  store.setSelected(id);
  return onStage(async () => {
    if (panes) return; // the grid owns the terminals in split mode
    if (term.attachedId === id) return;
    const inst = store.getInstance(id);
    if (!inst || !inst.alive) return term.detach();
    await term.attach(id);
  });
}

function setSplit(on) {
  return onStage(async () => {
    if (on === Boolean(panes)) return;
    if (on) {
      await term.detach(); // hand every id back before the grid claims one
      panes = mountPanes($('#mount-panes'));
    } else {
      const grid = panes;
      panes = null;
      await grid.destroy(); // async: it awaits pending attaches before disposing
      const inst = store.getSelectedInstance();
      if (inst && inst.alive) await term.attach(inst.id);
    }
    const split = Boolean(panes);
    splitBtn.textContent = split ? 'single' : 'split';
    splitBtn.setAttribute('aria-pressed', String(split));
    splitBtn.classList.toggle('primary', split);
  });
}

// ------------------------------------------------------------------ panels

mountCards($('#tab-instances'), {
  onSelect: select,
  onClosed: (id) => {
    if (store.getSelected() !== id) return;
    store.setSelected(null);
    onStage(() => (panes ? undefined : term.detach()));
  },
});
mountAttention($('#attention'), { onSelect: select });
mountCounts($('#counts'));
mountStageBar($('#stage-bar'));

const sessions = mountSessions($('#tab-sessions'), { onResumed: select });
const codex = mountCodex($('#tab-codex'));

mountLauncher({ dialog: $('#launcher'), openBtn: $('#new'), onLaunched: select });
mountAdopt({ dialog: $('#adopter'), openBtn: $('#adopt'), onAdopted: select });

// ------------------------------------------------------------------ header

store.subscribePressure((txt) => {
  const line = txt.split('\n').find((l) => l.startsWith('pressure:')) || txt.split('\n')[0] || '';
  $('#pressure').textContent = line.trim();
});

$('#resume-all').onclick = () => pbuildResumeAll().then(store.refreshPressure);

const splitBtn = $('#split');
splitBtn.onclick = () => setSplit(!panes);

// ------------------------------------------------------------------ notifications

let notifyOk = false;
store.subscribe(({ changed }) => {
  if (!notifyOk) return;
  for (const c of changed) {
    if (!c.from || c.from === 'needs-you' || c.to !== 'needs-you') continue;
    const i = store.getInstance(c.id);
    if (i) sendNotification({ title: `${i.group} · ${i.name}`, body: i.summary || 'waiting on you' });
  }
});

// ------------------------------------------------------------------ tabs

const TABS = ['instances', 'sessions', 'codex'];
for (const b of document.querySelectorAll('.tabs button')) {
  b.onclick = () => {
    document.querySelectorAll('.tabs button').forEach((x) => x.classList.toggle('on', x === b));
    for (const t of TABS) $(`#tab-${t}`).hidden = t !== b.dataset.tab;
    if (b.dataset.tab === 'sessions') sessions.render();
    if (b.dataset.tab === 'codex') codex.render();
  };
}

// ------------------------------------------------------------------ feature mounts
// One import above and one mount call here per shard. Panes is the exception: it owns the
// stage's ptys, so it is mounted and unmounted by the split toggle rather than at boot.

mountBroadcast($('#mount-broadcast'));
mountCost($('#mount-cost'));
mountHandoff($('#mount-handoff'));
mountAutopause($('#mount-autopause'));

// ------------------------------------------------------------------ boot

(async () => {
  // Notifications are presentation. If the desktop notification service is missing or the
  // permission call rejects, the fleet still has to render: gating store.start() on it left the
  // whole app empty and stale because an optional convenience was unavailable.
  try {
    notifyOk = (await isPermissionGranted()) || (await requestPermission()) === 'granted';
  } catch (err) {
    notifyOk = false;
    console.error('[athena] notifications unavailable', err);
  }
  await store.start();
})();
