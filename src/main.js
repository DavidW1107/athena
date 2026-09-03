// CONVERGENCE POINT. Wiring only: create the store, mount each panel onto its element,
// start the polls. No feature logic lives here.
//
// v1.3 shape: the whole window is the tile grid. There is no sidebar and no single stage
// terminal, because the fleet is meant to be readable at a glance rather than clicked
// through. Everything that used to justify a permanent left rail is now a header button
// that opens a dialog, so it costs screen only while it is open.

import { isPermissionGranted, requestPermission, sendNotification } from '@tauri-apps/plugin-notification';

import { pbuildResumeAll } from './api.js';
import * as store from './store.js';
import { mountAttention, mountCodex, mountCounts, mountSessions } from './cards.js';
import { mountGrid } from './grid.js';
import { mountLauncher } from './launcher.js';
import { mountAdopt } from './adopt.js';
import { mountAutopause } from './autopause.js';
import { mountBroadcast } from './broadcast.js';
import { mountCost } from './cost.js';
import { mountHandoff } from './handoff.js';

const $ = (s) => document.querySelector(s);

// ------------------------------------------------------------------ the grid

// Declared before the grid so the tile + can reach the launcher, which is mounted below.
let launcher = null;

const grid = mountGrid($('#grid-host'), {
  onNewInTile: ({ group, cwd, cmd }) => launcher?.open({ group, cwd, cmd }),
});

/** Bring an instance into view by focusing the tile its group owns. */
function reveal(id) {
  const inst = store.getInstance(id);
  store.setSelected(id);
  if (inst) grid.focusGroup(inst.group);
}

// ------------------------------------------------------------------ dialogs

/** Wire a header button to a dialog, refreshing its contents each time it opens. */
function panel(dialogSel, openSel, render) {
  const dialog = $(dialogSel);
  dialog.querySelector('[data-close]').onclick = () => dialog.close();
  $(openSel).onclick = async () => {
    await render?.();
    dialog.showModal();
  };
  return dialog;
}

const sessions = mountSessions($('#mount-sessions'), {
  onResumed: (id) => {
    $('#panel-sessions').close();
    reveal(id);
  },
});
const codex = mountCodex($('#mount-codex'));

panel('#panel-sessions', '#open-sessions', () => sessions.render());
panel('#panel-codex', '#open-codex', () => codex.render());
panel('#panel-handoff', '#open-handoff');

launcher = mountLauncher({ dialog: $('#launcher'), openBtn: $('#new'), onLaunched: reveal });
mountAdopt({ dialog: $('#adopter'), openBtn: $('#adopt'), onAdopted: reveal });

// ------------------------------------------------------------------ header

mountAttention($('#attention'), { onSelect: reveal });
mountCounts($('#counts'));

store.subscribePressure((txt) => {
  const line = txt.split('\n').find((l) => l.startsWith('pressure:')) || txt.split('\n')[0] || '';
  $('#pressure').textContent = line.trim();
});

$('#resume-all').onclick = () => pbuildResumeAll().then(store.refreshPressure);

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

// ------------------------------------------------------------------ feature mounts

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
