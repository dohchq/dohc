import { utf8ByteLength } from "@dohc/live-session-contract/limits";
import * as Y from "yjs";
import type { OrderedLiveUpdateCutPolicy } from "./orderedLiveUpdateCut.js";

/** The most bytes one change to a note may hold for the relay to take it. */
export const LIVE_UPDATE_MAX_BYTES = 2 * 1024 * 1024;

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

/**
 * How many times the save's check is at each thing that one read of a change is at once, at
 * most. Measured on the save's own counters: four reads of each struct, and of each value and
 * byte of text outside a mark, seven of each inside one, and at most four of each delete. The
 * save's index operations are its sorting work, not a count of what a change holds, and are not
 * divided.
 */
export const SAVE_VISITS_PER_READ: OrderedLiveUpdateCutPolicy = Object.freeze({
  maxStructVisits: 4,
  maxValueNodeVisits: 7,
  maxDecodedPayloadByteVisits: 7,
  maxStructClientGroupVisits: 4,
  maxDeleteClientGroupVisits: 4,
  maxDeleteIntervalVisits: 4,
  maxIndexOperations: 1,
});

/** How many times the save's check is at each value and each byte of text outside a mark. */
export const SAVE_VISITS_OUTSIDE_A_MARK = 4;

const INDEX_OPERATIONS_PER = Object.freeze({
  note: 50_000,
  structSearch: 31,
  struct: 370,
  rootEntry: 80,
  keySortPass: 3,
  astralSearch: 5,
  boundarySearch: 4,
});

/**
 * The most nodes the engine's Markdown writer reads one note into, `MAX_PROJECTION_NODES` in
 * `crates/dohc-engine-collab/src/limits.rs`.
 */
export const MAX_PROJECTION_NODES = 262_144;

/**
 * The most bytes of text the engine's Markdown writer reads from one note, counting a value each
 * time it reads it, `MAX_PROJECTION_BYTES` in `crates/dohc-engine-collab/src/limits.rs`.
 */
export const MAX_PROJECTION_BYTES = 16 * 1024 * 1024;

/** A note's Yjs structs, and how many of them are block elements. */
export type LiveNoteWeight = { structs: number; elements: number };

/**
 * What a new note stores, counted as the save's check and the engine's Markdown writer count it.
 * Values and bytes are what one read of the note is at: values outside a mark and in one, and the
 * bytes of text, keys and names outside a mark and in one.
 */
export type NewNoteCounts = LiveNoteWeight &
  IndexCounts & {
    values: number;
    markValues: number;
    bytes: number;
    markBytes: number;
    /** The nodes and the bytes of text the engine's Markdown writer spends reading the note. */
    engineNodes: number;
    engineBytes: number;
  };

export type IndexCounts = {
  structs: number;
  rootEntries: number;
  keySorts: number;
  astral: number;
};

const log2Up = (count: number) => (count <= 1 ? 0 : 32 - Math.clz32(count - 1));

export function newNoteIndexOperations({
  structs,
  rootEntries,
  keySorts,
  astral,
}: IndexCounts): number {
  const per = INDEX_OPERATIONS_PER;
  const operations =
    per.note +
    per.structSearch * structs * log2Up(Math.max(structs, 2)) +
    per.struct * (structs - rootEntries) +
    per.rootEntry * rootEntries +
    per.keySortPass * keySorts +
    per.astralSearch * astral * log2Up(astral) +
    per.boundarySearch * (structs + 1) * log2Up(astral);
  return Math.floor((operations * 11 + 9) / 10);
}

export function keySorts(value: unknown): number {
  if (value instanceof Y.Map) return keySortsOf(value.entries());
  if (value instanceof Y.Array) return keySorts(value.toArray());
  if (Array.isArray(value)) return value.reduce((sum: number, held) => sum + keySorts(held), 0);
  if (typeof value !== "object" || value === null || value instanceof Uint8Array) return 0;
  return keySortsOf(Object.entries(value));
}

export function astralLetters(text: string): number {
  let letters = 0;
  for (let at = 0; at < text.length - 1; at++) {
    const high = text.charCodeAt(at);
    const low = text.charCodeAt(at + 1);
    if (high >= 0xd800 && high <= 0xdbff && low >= 0xdc00 && low <= 0xdfff) {
      letters++;
      at++;
    }
  }
  return letters;
}

function keySortsOf(entries: Iterable<[string, unknown]>): number {
  let keys = 0,
    longest = 0,
    held = 0;
  for (const [key, value] of entries) {
    keys++;
    longest = Math.max(longest, utf8ByteLength(key));
    held += keySorts(value);
  }
  return held + (keys < 2 ? keys : keys * log2Up(keys) * (longest + 3));
}

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

/**
 * Whether a new note of these counts fits: its weight, the save's visits and index operations
 * under `policy`, and the engine's Markdown writer's limits. A new note's update holds each
 * struct the note stores.
 */
export function fitsNewNote(counts: NewNoteCounts, policy: OrderedLiveUpdateCutPolicy): boolean {
  const visits = (outside: number, inside: number, perRead: number) =>
    SAVE_VISITS_OUTSIDE_A_MARK * outside + perRead * inside;
  return (
    fitsLiveNoteCapacity(counts, policy) &&
    SAVE_VISITS_PER_READ.maxStructVisits * counts.structs <= policy.maxStructVisits &&
    visits(counts.values, counts.markValues, SAVE_VISITS_PER_READ.maxValueNodeVisits) <=
      policy.maxValueNodeVisits &&
    visits(counts.bytes, counts.markBytes, SAVE_VISITS_PER_READ.maxDecodedPayloadByteVisits) <=
      policy.maxDecodedPayloadByteVisits &&
    counts.engineNodes <= MAX_PROJECTION_NODES &&
    counts.engineBytes <= MAX_PROJECTION_BYTES &&
    newNoteIndexOperations(counts) <= policy.maxIndexOperations
  );
}

/** Whether `doc` fits the capacity above. */
export function withinLiveNoteCapacity(doc: Y.Doc, policy: OrderedLiveUpdateCutPolicy): boolean {
  return fitsLiveNoteCapacity(liveNoteWeight(doc), policy);
}
