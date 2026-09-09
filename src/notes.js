// The note a user pins to an instance they are deliberately waiting on.
//
// The problem it solves: `needs-you` means "the agent is blocked on a human", and Athena
// paints the whole tile perimeter amber and pulses a dot to say so. That is correct and it
// is also wrong half the time, because the human is not the bottleneck: they are waiting on
// another shard, a deploy, a call, another agent's answer. An alarm you are choosing to
// ignore trains you to ignore the alarm, which costs the one signal the app exists to give.
//
// So a note DOWNGRADES the alarm rather than dismissing it. The instance is still waiting,
// still visible, still labelled - it just reads `held` in indigo instead of `needs you` in
// amber, and stops shouting through the attention strip, the header count and the desktop
// notification. The reason is written on it, so the tile answers "why is this parked" itself.
//
// NOTHING IS SENT TO THE PROCESS. A note is not a pause. SIGSTOP would free CPU but not RAM
// (a stopped process keeps its whole resident set mapped), and it is exactly what the
// auto-pause rules refuse to do to a live turn: a stopped process cannot service its own
// sockets, so the in-flight API call times out and the turn is lost. A note has to be
// removable with the session intact, which means it never touches the session.
//
// Storage is localStorage, keyed by instance id, alongside the tile order and per-tile font.
// ponytail: no Rust, no instances.json field. Notes are UI intent about a live fleet, they
// survive a restart because the webview's storage does, and nothing outside the window has
// any use for them. Move them into ~/.athena/instances.json if a hook or the CLI ever needs
// to read one.

const KEY = 'athena.notes';

/** @type {Record<string, string>} instance id -> note text. */
let notes = read();

const subs = new Set();

function read() {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) || '{}');
    if (!v || typeof v !== 'object' || Array.isArray(v)) return {};
    // Drop anything that is not a non-empty string, so one bad write cannot make every
    // later read throw or paint an empty banner forever.
    return Object.fromEntries(
      Object.entries(v).filter(([, t]) => typeof t === 'string' && t.trim())
    );
  } catch {
    return {};
  }
}

function write() {
  try {
    localStorage.setItem(KEY, JSON.stringify(notes));
  } catch {
    // A full or blocked localStorage costs the note's persistence and nothing else; the
    // in-memory copy still drives this session.
  }
}

function emit() {
  for (const fn of [...subs]) {
    try {
      fn(notes);
    } catch (err) {
      console.error('[athena] note subscriber threw', err);
    }
  }
}

// ------------------------------------------------------------------ reads

/** @returns {string} the note on that instance, or '' when there is none. */
export function getNote(id) {
  return (id && notes[id]) || '';
}

/** @returns {boolean} whether that instance carries a note. */
export function hasNote(id) {
  return Boolean(getNote(id));
}

/** @returns {number} how many of those instances carry a note. */
export function countHeld(instances) {
  return instances.filter((i) => isHeld(i)).length;
}

// ------------------------------------------------------------------ the one rule

/**
 * Whether this instance's alarm is being held by a note.
 *
 * A note only ever suppresses `needs-you`. Every other state is the machine reporting a
 * fact about itself - working, dead, paused - and a human note has no business overwriting
 * one of those. So a noted instance that goes back to work goes green, and the note stays
 * pinned for when it comes back round to waiting.
 */
export function isHeld(inst) {
  return Boolean(inst && inst.state === 'needs-you' && hasNote(inst.id));
}

/** The state string the UI should paint for this instance. The single seam every panel uses. */
export function effectiveState(inst) {
  if (!inst) return 'empty';
  return isHeld(inst) ? 'held' : inst.state;
}

// ------------------------------------------------------------------ writes

/**
 * Pin, replace or clear a note. Empty or whitespace-only text clears it, which is what
 * makes "select all, delete, click away" the delete gesture and saves a second control.
 * @returns {boolean} whether anything actually changed.
 */
export function setNote(id, text) {
  if (!id) return false;
  const next = typeof text === 'string' ? text.trim() : '';
  const prev = notes[id] || '';
  if (next === prev) return false;
  if (next) notes[id] = next;
  else delete notes[id];
  write();
  emit();
  return true;
}

/**
 * Forget notes for instances that no longer exist. Called from the grid's store sync, which
 * already has the live id set in hand, so this costs no poll of its own.
 * @param {Iterable<string>} liveIds
 */
export function prune(liveIds) {
  const live = new Set(liveIds);
  const stale = Object.keys(notes).filter((id) => !live.has(id));
  if (!stale.length) return false;
  for (const id of stale) delete notes[id];
  write();
  emit();
  return true;
}

// ------------------------------------------------------------------ pub-sub

/**
 * Subscribe to note changes. Fires once synchronously with the current map, then on every
 * change. Returns an unsubscribe function.
 * @param {(notes: Record<string, string>) => void} fn
 */
export function subscribeNotes(fn) {
  subs.add(fn);
  try {
    fn(notes);
  } catch (err) {
    console.error('[athena] note subscriber threw on first call', err);
  }
  return () => subs.delete(fn);
}
