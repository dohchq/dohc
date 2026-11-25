import * as Y from "yjs";
import type { OrderedLiveUpdateCutPolicy } from "./orderedLiveUpdateCut.js";

/** Calibrated for the validation worker's 512 MB heap. */
export const WORKER_LIVE_VALIDATION_POLICY: OrderedLiveUpdateCutPolicy = Object.freeze({
  maxStructVisits: 400_000,
  maxValueNodeVisits: 5_000_000,
  maxDecodedPayloadByteVisits: 100_000_000,
  maxStructClientGroupVisits: 1_000_000,
  maxDeleteClientGroupVisits: 1_000_000,
  maxDeleteIntervalVisits: 1_000_000,
  maxIndexOperations: 100_000_000,
});

/**
 * The most a note may weigh for a validator in a 512 MB heap to check it, so a note too dense to
 * check is refused rather than running the heap out. A note's weight is its Yjs
 * structs plus six for each block element, which costs about seven times a struct's memory. The
 * engine's Markdown reader builds the most from a note: in its heap, notes weighing up to 301,000
 * fit and notes from 316,000 did not, whatever their shape.
 */
export const LIVE_NOTE_CAPACITY = 280_000;
export const LIVE_NOTE_ELEMENT_WEIGHT = 6;

/** A note's Yjs structs, and how many of them are block elements. */
export type LiveNoteWeight = { structs: number; elements: number };

/** The weight of what `doc` stores. */
export function liveNoteWeight(doc: Y.Doc): LiveNoteWeight {
  let structs = 0,
    elements = 0;
  for (const list of doc.store.clients.values()) {
    structs += list.length;
    for (const struct of list) {
      if (
        struct instanceof Y.Item &&
        struct.content instanceof Y.ContentType &&
        struct.content.type instanceof Y.XmlElement
      )
        elements++;
    }
  }
  return { structs, elements };
}

/** Whether a note of this weight fits the capacity above. The journal visits each struct three times, so `policy` also caps its structs. */
export function fitsLiveNoteCapacity(
  { structs, elements }: LiveNoteWeight,
  policy: OrderedLiveUpdateCutPolicy,
): boolean {
  return (
    structs <= policy.maxStructVisits / 3 &&
    structs + LIVE_NOTE_ELEMENT_WEIGHT * elements <= LIVE_NOTE_CAPACITY
  );
}

/** Whether `doc` fits the capacity above. */
export function withinLiveNoteCapacity(doc: Y.Doc, policy: OrderedLiveUpdateCutPolicy): boolean {
  return fitsLiveNoteCapacity(liveNoteWeight(doc), policy);
}
