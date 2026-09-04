// Turning OS paths into terminal input. Its own file, with no imports, so the self-check in
// shellquote.test.mjs can run it under plain node.

// Everything a POSIX shell reads literally. A path made only of these needs no quoting, so
// the common case stays readable; anything else gets single-quoted.
const BARE = /^[A-Za-z0-9_@%+=:,./-]+$/;

/**
 * Quote one path for a POSIX shell.
 *
 * Single quotes because they are literal all the way through, spaces and $ and backticks
 * included. The one character they cannot hold is a single quote, which ends the string, so
 * that closes, escapes one quote, and reopens: `it's` -> `'it'\''s'`.
 *
 * @param {string} p
 * @returns {string}
 */
export const shellQuote = (p) => (BARE.test(p) ? p : `'${p.replaceAll("'", "'\\''")}'`);

/**
 * The text a drop of these paths types: quoted, space separated, one trailing space so the
 * next thing typed does not run into the last path.
 *
 * @param {string[]} paths
 * @returns {string}
 */
export const dropText = (paths) => paths.map(shellQuote).join(' ') + ' ';
