// The two drag payloads Athena moves around, named in one place so the producers (a tile
// header, an instance tab) and the consumer (a tile) never drift apart.
//
// Custom MIME types on purpose: a plain text/plain payload would let any text dragged in
// from outside the window look like a valid drop.

export const MIME_TILE = 'application/x-athena-tile';
export const MIME_INSTANCE = 'application/x-athena-instance';

/**
 * Read whichever payload a drag is carrying.
 *
 * `dataTransfer.getData` returns an empty string during dragenter and dragover (the browser
 * only unseals the data on drop), so anything deciding whether to ACCEPT a drag must read
 * `types` via `isDroppable` instead, which stays readable for the whole gesture.
 *
 * @param {DataTransfer} dt
 * @returns {{kind: 'tile'|'instance', value: string}|null}
 */
export function dragPayload(dt) {
  if (!dt) return null;
  if (dt.types.includes(MIME_INSTANCE)) {
    return { kind: 'instance', value: dt.getData(MIME_INSTANCE) };
  }
  if (dt.types.includes(MIME_TILE)) return { kind: 'tile', value: dt.getData(MIME_TILE) };
  return null;
}

/** True when a drag carries something a tile can accept, without unsealing it. */
export const isDroppable = (dt) =>
  !!dt && (dt.types.includes(MIME_TILE) || dt.types.includes(MIME_INSTANCE));
