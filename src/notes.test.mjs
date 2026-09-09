// node src/notes.test.mjs
//
// The check that fails if a note stops suppressing exactly one alarm and no others. The
// downgrade rule is the whole feature: too broad and a note hides a dead session, too narrow
// and the tile still pulses amber at you.

import assert from 'node:assert/strict';

// notes.js reads localStorage at module load, so the stub has to exist before the import.
const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
};

const { countHeld, effectiveState, getNote, hasNote, prune, setNote, subscribeNotes } =
  await import('./notes.js');

const inst = (id, state) => ({ id, state });

// A note is pinned, read back trimmed, and persisted under one key.
assert.equal(setNote('a', '  waiting on the alucast backup  '), true);
assert.equal(getNote('a'), 'waiting on the alucast backup');
assert.equal(hasNote('a'), true);
assert.deepEqual(JSON.parse(store.get('athena.notes')), { a: 'waiting on the alucast backup' });

// Writing the same text again is not a change, so subscribers are not woken every poll.
assert.equal(setNote('a', 'waiting on the alucast backup'), false);

// THE RULE. A note downgrades needs-you and nothing else: the machine's own facts about
// itself still show through, so a noted instance that dies still reads dead.
assert.equal(effectiveState(inst('a', 'needs-you')), 'held');
assert.equal(effectiveState(inst('a', 'working')), 'working');
assert.equal(effectiveState(inst('a', 'dead')), 'dead');
assert.equal(effectiveState(inst('a', 'paused')), 'paused');

// An instance with no note is never held.
assert.equal(effectiveState(inst('b', 'needs-you')), 'needs-you');
assert.equal(effectiveState(null), 'empty');

// The header count separates the two, so "0 waiting" never means "nothing is waiting".
const fleet = [inst('a', 'needs-you'), inst('b', 'needs-you'), inst('a2', 'working')];
assert.equal(countHeld(fleet), 1);

// Whitespace-only clears, which is what makes select-all-delete the delete gesture.
let woken = 0;
const off = subscribeNotes(() => woken++);
assert.equal(woken, 1); // fires once with the current map
assert.equal(setNote('a', '   '), true);
assert.equal(getNote('a'), '');
assert.equal(woken, 2);
assert.equal(effectiveState(inst('a', 'needs-you')), 'needs-you');
off();

// Orphans are dropped when the fleet no longer holds them, so localStorage does not grow
// by one dead id per closed instance forever.
setNote('x', 'note x');
setNote('y', 'note y');
assert.equal(prune(['x']), true);
assert.equal(getNote('x'), 'note x');
assert.equal(getNote('y'), '');
assert.equal(prune(['x']), false); // nothing stale, no write, no wake

// A corrupt or hand-edited value must not take the app down on next launch.
store.set('athena.notes', '{ not json');
const reread = await import(`./notes.js?bust=${Date.now()}`);
assert.deepEqual(reread.getNote('x'), '');

console.log('notes ok');
