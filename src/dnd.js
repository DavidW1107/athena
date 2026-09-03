// The two drag payloads Athena moves around, named in one place so the producer
// (a sidebar card, a pane header) and the consumer (a pane) never drift apart.
//
// Custom MIME types on purpose: a plain text/plain payload would let any dragged
// text from outside the app look like a valid drop.

export const MIME_INSTANCE = 'application/x-athena-instance';
export const MIME_PANE = 'application/x-athena-pane';

/**
 * Read whichever payload a drag is carrying.
 *
 * `dataTransfer.getData` returns an empty string during dragenter and dragover (the
 * browser only unseals the data on drop), so anything deciding whether to ACCEPT a drag
 * must read `types` instead, which stays readable for the whole gesture.
 *
 * @param {DataTransfer} dt
 * @returns {{kind: 'pane'|'instance', value: string}|null}
 */
export function dragPayload(dt) {
  if (!dt) return null;
  if (dt.types.includes(MIME_PANE)) return { kind: 'pane', value: dt.getData(MIME_PANE) };
  if (dt.types.includes(MIME_INSTANCE)) {
    return { kind: 'instance', value: dt.getData(MIME_INSTANCE) };
  }
  return null;
}

/** True when a drag carries something a pane can accept, without unsealing it. */
export const isDroppable = (dt) =>
  !!dt && (dt.types.includes(MIME_PANE) || dt.types.includes(MIME_INSTANCE));
