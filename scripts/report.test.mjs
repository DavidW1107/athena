// node scripts/report.test.mjs
//
// Pins the bucket rules, since the whole report is only as honest as they are: stalled must
// need a reason, a live project is never stalled, and a commit shows as done alongside either.

import assert from 'node:assert/strict';
import { bucket, isClient } from './report.mjs';

const now = 1_800_000_000;
const H = 3600;
const p = (o) => ({ lastEpoch: now - 5 * H, states: [], prompts: 6, edits: 2, commits: 0, dirty: 0, endedOnQuestion: false, ...o });

assert.deepEqual(bucket(p({ lastEpoch: now - 60 }), now).buckets, ['active']);
assert.deepEqual(bucket(p({ states: [{ state: 'working', ts: now - 60 }] }), now).buckets, ['active']);
// Quiet real work with nothing hanging is finished, not stalled.
assert.deepEqual(bucket(p({}), now).buckets, ['done']);
assert.deepEqual(bucket(p({ prompts: 2, edits: 0 }), now).buckets, ['dipped']);

const st = bucket(p({ dirty: 3, states: [{ state: 'needs-you', ts: now - 6 * H }] }), now);
assert.deepEqual(st.buckets, ['stalled']);
assert.deepEqual(st.reasons, ['waiting on you 6h', 'uncommitted edits in 3 files']);
assert.deepEqual(bucket(p({ endedOnQuestion: true }), now).reasons, ['ended on a question to you']);

// Shipped some, left some; shipped some, still going.
assert.deepEqual(bucket(p({ commits: 4, dirty: 1 }), now).buckets, ['done', 'stalled']);
assert.deepEqual(bucket(p({ commits: 4, lastEpoch: now - 60, dirty: 1 }), now).buckets, ['done', 'active']);
// A dipped-into project with a question is still just dipped: no real work to stall.
assert.deepEqual(bucket(p({ prompts: 1, edits: 0, endedOnQuestion: true }), now).buckets, ['dipped']);

assert.ok(isClient('clients/acmr/acmr-crm') && isClient('demos/rou-demo') && !isClient('internal/M.ind'));
console.log('report ok');
