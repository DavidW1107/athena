// The one drag payload Athena moves around: a tile being reordered in the grid.
//
// A custom MIME type on purpose. A plain text/plain payload would let any text dragged
// in from outside the window look like a valid drop.

export const MIME_TILE = 'application/x-athena-tile';

/**
 * Read the group name a tile drag is carrying, or null.
 *
 * `dataTransfer.getData` returns an empty string during dragenter and dragover (the browser
 * only unseals the data on drop), so anything deciding whether to ACCEPT a drag must read
 * `types` via `isDroppable` instead, which stays readable for the whole gesture.
 *
 * @param {DataTransfer} dt
 * @returns {string|null}
 */
export function dragPayload(dt) {
  if (!dt || !dt.types.includes(MIME_TILE)) return null;
  return dt.getData(MIME_TILE) || null;
}

/** True when a drag carries a tile, without unsealing it. */
export const isDroppable = (dt) => !!dt && dt.types.includes(MIME_TILE);
