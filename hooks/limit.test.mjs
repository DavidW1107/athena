// node hooks/limit.test.mjs
import assert from 'node:assert/strict';
import { accountOf, isUsageLimit, keepsLimited, resetEpoch } from './limit.js';

const at = (s) => Math.floor(new Date(s) / 1000);
const now = new Date('2026-09-11T15:28:00'); // local time

assert.equal(resetEpoch("You've hit your session limit · resets 6pm (Europe/Dublin)", now), at('2026-09-11T18:00:00'));
assert.equal(resetEpoch('resets 6:30pm', now), at('2026-09-11T18:30:00'));
assert.equal(resetEpoch('resets 12am', now), at('2026-09-12T00:00:00'));
assert.equal(resetEpoch('resets 3pm', now), at('2026-09-12T15:00:00')); // already past today
assert.equal(resetEpoch("You've hit your weekly limit · resets Sep 15, 3am (Europe/Dublin)", now), at('2026-09-15T03:00:00'));
assert.equal(resetEpoch('resets Jan 2, 9am', now), at('2027-01-02T09:00:00'));
assert.equal(resetEpoch('no time here', now), at('2026-09-11T20:28:00'));

assert.ok(isUsageLimit('rate_limit', "You've hit your session limit · resets 6pm"));
assert.ok(!isUsageLimit('rate_limit', 'API Error: Request rejected (429) · this may be a temporary capacity issue'));
assert.ok(!isUsageLimit('server_error', "You've hit your session limit"));

assert.equal(accountOf(undefined, '/home/d'), 'a');
assert.equal(accountOf('/home/d/.claude', '/home/d'), 'a');
assert.equal(accountOf('/home/d/.claude/', '/home/d'), 'a');
assert.equal(accountOf('/home/d/.claude-b', '/home/d'), 'b');
assert.ok(keepsLimited('limited', 'other'));
assert.ok(keepsLimited('limited', undefined));
assert.ok(!keepsLimited('limited', 'prompt_input_exit'));
assert.ok(!keepsLimited('limited', 'resume'));
assert.ok(!keepsLimited('idle', 'other'));
console.log('limit ok');
