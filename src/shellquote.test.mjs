// node src/shellquote.test.mjs
//
// The check that fails if a dropped path stops surviving the trip through a shell. Paths with
// spaces are the common case and apostrophes are the case that is easy to get wrong, so both
// are asserted against what `sh -c` actually does with the result.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';

import { dropText, shellQuote } from './shellquote.js';

// A path the shell reads literally is left bare, so the common drop stays readable.
assert.equal(shellQuote('/home/david/Documents/GitHub/tools/athena'), '/home/david/Documents/GitHub/tools/athena');

// Anything else is quoted.
assert.equal(shellQuote('/home/david/My Folder'), "'/home/david/My Folder'");
assert.equal(shellQuote("/home/david/it's here"), "'/home/david/it'\\''s here'");

// Multiple paths are space separated with a trailing space, so the next word is its own.
assert.equal(dropText(['/a/b', '/c d']), "/a/b '/c d' ");

// The point of all of it: a real shell has to see exactly the paths that went in.
const nasty = ["/tmp/My Folder", "/tmp/it's $HOME `x`", '/tmp/plain'];
const out = execFileSync('sh', ['-c', `printf '%s\\n' ${dropText(nasty)}`], { encoding: 'utf8' });
assert.deepEqual(out.trimEnd().split('\n'), nasty);

console.log('shellquote ok');
