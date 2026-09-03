// The single seam every feature hangs off. One 1s poll of list_instances and one 5s
// poll of pbuild_status live here; everything else reacts through subscribe().
//
// A feature never adds a poll of its own and never edits this file: it calls
// subscribe(fn) and is handed a snapshot on every tick, including the state
// transitions since the previous tick.

import { listInstances, pbuildStatus } from './api.js';

let instances = [];
let selected = null;
let pressure = '';
let lastStates = new Map();
let timers = [];

const subs = new Set();
const pressureSubs = new Set();

// ------------------------------------------------------------------ reads

/** @returns {Array} the InstanceView rows from the most recent poll. Never null. */
export function getInstances() {
  return instances;
}

/** @returns {Object|null} one InstanceView by id, or null if it is gone. */
export function getInstance(id) {
  return instances.find((i) => i.id === id) || null;
}

/** @returns {string|null} the id of the instance the user has selected. */
export function getSelected() {
  return selected;
}

/** @returns {Object|null} the selected InstanceView, or null. */
export function getSelectedInstance() {
  return selected ? getInstance(selected) : null;
}

/** @returns {string} raw stdout of the last `pbuild ls`. */
export function getPressure() {
  return pressure;
}

/** The snapshot shape handed to every subscriber. */
function snapshot(changed = []) {
  return { instances, selected, changed };
}

// ------------------------------------------------------------------ writes

/**
 * Set the selected instance and notify every subscriber immediately.
 * Pass null to clear the selection.
 */
export function setSelected(id) {
  if (selected === id) return;
  selected = id;
  emit([]);
}

// ------------------------------------------------------------------ pub-sub

/**
 * Subscribe to instance snapshots.
 *
 *   const off = subscribe(({ instances, selected, changed }) => { ... });
 *
 * The callback fires once synchronously with the current snapshot, then on every
 * 1s poll and on every selection change. `changed` lists the state transitions
 * seen on that tick as `{ id, from, to }`; `from` is null the first time an
 * instance is seen. A subscriber that throws does not stop the other subscribers.
 *
 * @param {(snap: {instances: Array, selected: string|null, changed: Array}) => void} fn
 * @returns {() => void} an unsubscribe function (same effect as unsubscribe(fn)).
 */
export function subscribe(fn) {
  subs.add(fn);
  try {
    fn(snapshot());
  } catch (err) {
    console.error('[argus] subscriber threw on first call', err);
  }
  return () => unsubscribe(fn);
}

/** Remove a subscriber registered with subscribe(). */
export function unsubscribe(fn) {
  subs.delete(fn);
}

/** Subscribe to the raw `pbuild ls` text (5s cadence). Returns an unsubscribe function. */
export function subscribePressure(fn) {
  pressureSubs.add(fn);
  try {
    fn(pressure);
  } catch (err) {
    console.error('[argus] pressure subscriber threw on first call', err);
  }
  return () => pressureSubs.delete(fn);
}

/** Remove a subscriber registered with subscribePressure(). */
export function unsubscribePressure(fn) {
  pressureSubs.delete(fn);
}

function emit(changed) {
  const snap = snapshot(changed);
  for (const fn of [...subs]) {
    try {
      fn(snap);
    } catch (err) {
      console.error('[argus] subscriber threw', err);
    }
  }
}

// ------------------------------------------------------------------ polls

/**
 * Re-read the instance list now and notify subscribers. Call it after any command
 * that mutates the fleet so the UI does not wait up to a second for the next tick.
 * @returns {Promise<Array>} the fresh instance list.
 */
export async function refresh() {
  instances = await listInstances();
  const changed = [];
  const seen = new Set();
  for (const i of instances) {
    seen.add(i.id);
    const prev = lastStates.has(i.id) ? lastStates.get(i.id) : null;
    if (prev !== i.state) changed.push({ id: i.id, from: prev, to: i.state });
    lastStates.set(i.id, i.state);
  }
  for (const id of [...lastStates.keys()]) if (!seen.has(id)) lastStates.delete(id);
  if (selected && !seen.has(selected)) selected = null;
  emit(changed);
  return instances;
}

/** Re-read `pbuild ls` now and notify pressure subscribers. */
export async function refreshPressure() {
  pressure = await pbuildStatus();
  for (const fn of [...pressureSubs]) {
    try {
      fn(pressure);
    } catch (err) {
      console.error('[argus] pressure subscriber threw', err);
    }
  }
  return pressure;
}

/**
 * Start both polls. Safe to call once from main.js; calling twice is a no-op.
 * @param {{ instanceMs?: number, pressureMs?: number }} [opts]
 */
export async function start({ instanceMs = 1000, pressureMs = 5000 } = {}) {
  if (timers.length) return;
  await refresh();
  await refreshPressure();
  timers.push(setInterval(refresh, instanceMs));
  timers.push(setInterval(refreshPressure, pressureMs));
}

/** Stop both polls. Only useful in tests. */
export function stop() {
  for (const t of timers) clearInterval(t);
  timers = [];
}
