import * as Y from "yjs";
import { getDohcProseMirrorSchema } from "./import-export.js";
import {
  LIVE_NOTE_CAPACITY,
  LIVE_NOTE_ELEMENT_WEIGHT,
  SAVE_VISITS_PER_READ,
} from "./liveValidationPolicy.js";
import {
  readLiveUpdateAsTheCutDoes,
  type LiveUpdateAsRead,
  type OrderedLiveUpdateCutPolicy,
  type OrderedLiveUpdateCutRefusalReason,
  type OrderedLiveUpdateCutUsage,
} from "./orderedLiveUpdateCut.js";
import {
  BLOCK_ELEMENT,
  BODY_CONTAINERS_FIELD,
  BODY_SEQUENCE_FIELD,
  childrenOf,
  CONTAINER_ID,
  HOLDS_BLOCKS,
  holdsBodySequence,
  INLINE_ITEMS,
  MAX_SEQUENCE_DEPTH,
  ONLY_CHILD,
} from "./bodySequenceStore.js";

export interface BodySequenceIntakeRules {
  readonly policy: OrderedLiveUpdateCutPolicy;
  /**
   * Whether a change may write this key of the note's metadata, and for a value that shows,
   * whether the key may hold it.
   */
  readonly metadata: (key: string, shown?: { readonly value: unknown }) => boolean;
}

/** What one check went through. */
export interface BodySequenceIntakeWork {
  /** One for each struct, delete range, index lookup and value, each time the check is at it. */
  steps: number;
  /** What reading the change's bytes took, in the cut's own counters. */
  read?: OrderedLiveUpdateCutUsage;
}

type Stored = ReturnType<Y.Doc["get"]>;
type Read = Extract<LiveUpdateAsRead, { kind: "read" }>;
type Refusal = "invalid-schema" | "capacity-refused";
interface ClockRange {
  readonly start: number;
  readonly end: number;
}

const FRONTMATTER_FIELD = "frontmatter";
const META_FIELD = "meta";
const FORMAT_MARKER = "schemaVersion";
const ROOTS: ReadonlySet<string> = new Set([
  BODY_SEQUENCE_FIELD,
  BODY_CONTAINERS_FIELD,
  FRONTMATTER_FIELD,
  META_FIELD,
]);
const MAX_VALUE_DEPTH = 128;
const wellFormed = (text: string) => text.isWellFormed();

interface Names {
  readonly marks: ReadonlySet<string>;
  readonly boundaryAttributes: ReadonlySet<string>;
  readonly itemAttributes: ReadonlyMap<string, ReadonlySet<string>>;
  readonly recordAttributes: ReadonlySet<string>;
}
let names: Names | undefined;

/** The names section 5 of the format allows, taken from the editor's schema. */
export function bodySequenceNames(): Names {
  if (names) return names;
  const schema = getDohcProseMirrorSchema();
  const attributesOf = (type: { spec: { attrs?: object } }) => Object.keys(type.spec.attrs ?? {});
  const blocks = Object.values(schema.nodes).filter(
    (type) => type.isBlock && type !== schema.topNodeType,
  );
  const holdsNoBlock = (type: (typeof blocks)[number]) => type.isTextblock || type.isLeaf;
  names = {
    marks: new Set(Object.keys(schema.marks)),
    boundaryAttributes: new Set([
      "type",
      "path",
      ...blocks.filter(holdsNoBlock).flatMap(attributesOf),
    ]),
    itemAttributes: new Map(
      Object.values(schema.nodes)
        .filter((type) => type.isInline && type.isLeaf && !type.isText)
        .map((type) => [type.name, new Set(attributesOf(type))]),
    ),
    recordAttributes: new Set(blocks.filter((type) => !holdsNoBlock(type)).flatMap(attributesOf)),
  };
  return names;
}

function recordKey(key: string): boolean {
  const dot = key.indexOf(".");
  return (
    CONTAINER_ID.test(dot < 0 ? key : key.slice(0, dot)) &&
    (dot < 0 || bodySequenceNames().recordAttributes.has(key.slice(dot + 1)))
  );
}

/**
 * Whether a value is one a note can hold: null, a boolean, a finite number, an int64, a string,
 * an array or a plain object of these, at most 128 levels deep, with no lone surrogate and no key
 * named `__proto__`. `asJson` is for a value Yjs stores as JSON text, where a negative zero or an
 * int64 does not come back as it went in. It is at each value once and copies none. How many
 * values one change may hold is the room's limit, not a rule here: the room saves several changes
 * as one, and a limit on the sum would refuse a save of changes each of which the room took.
 */
function jsonLike(
  value: unknown,
  depth: number,
  asJson: boolean,
  work: BodySequenceIntakeWork,
): boolean {
  work.steps += 1;
  if (depth > MAX_VALUE_DEPTH) return false;
  if (value === null || typeof value === "boolean") return true;
  if (typeof value === "string") return wellFormed(value);
  if (typeof value === "number") return Number.isFinite(value) && !(asJson && Object.is(value, -0));
  if (typeof value === "bigint") return !asJson;
  if (typeof value !== "object" || value instanceof Uint8Array) return false;
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1)
      if (!jsonLike(value[index], depth + 1, asJson, work)) return false;
    return true;
  }
  for (const key of Object.keys(value))
    if (
      key === "__proto__" ||
      !wellFormed(key) ||
      !jsonLike((value as Record<string, unknown>)[key], depth + 1, asJson, work)
    )
      return false;
  return true;
}

/** How many levels of arrays and objects a value has under it. */
function levelsUnder(value: unknown, work: BodySequenceIntakeWork): number {
  work.steps += 1;
  if (typeof value !== "object" || value === null) return 0;
  let deepest = 0;
  if (Array.isArray(value))
    for (let index = 0; index < value.length; index += 1)
      deepest = Math.max(deepest, 1 + levelsUnder(value[index], work));
  else
    for (const key in value)
      deepest = Math.max(deepest, 1 + levelsUnder((value as Record<string, unknown>)[key], work));
  return deepest;
}

const plainType = (type: Stored, constructor: unknown) => type.constructor === constructor;
const holdsValue = (content: Y.Item["content"]) =>
  content instanceof Y.ContentAny ||
  (content instanceof Y.ContentType &&
    (plainType(content.type, Y.Map) || plainType(content.type, Y.Array)));

function structAt(note: Y.Doc, client: number, clock: number): Y.Item | Y.GC | undefined {
  const structs = note.store.clients.get(client);
  const last = structs?.at(-1);
  if (!structs || !last || clock < 0 || clock >= last.id.clock + last.length) return undefined;
  return structs[Y.findIndexSS(structs, clock)];
}

function insideAPairTheNoteHolds(note: Y.Doc, client: number, clock: number): boolean {
  const struct = structAt(note, client, clock);
  if (!(struct instanceof Y.Item) || !(struct.content instanceof Y.ContentString)) return false;
  const at = clock - struct.id.clock;
  const { str } = struct.content;
  return (
    at > 0 &&
    str.charCodeAt(at - 1) >= 0xd800 &&
    str.charCodeAt(at - 1) <= 0xdbff &&
    str.charCodeAt(at) >= 0xdc00 &&
    str.charCodeAt(at) <= 0xdfff
  );
}

/** The last of one client's sorted, disjoint ranges that starts at or before `clock`. */
function rangeAtOrBefore(
  ranges: readonly ClockRange[] | undefined,
  clock: number,
  work: BodySequenceIntakeWork,
): ClockRange | undefined {
  if (!ranges) return undefined;
  let low = 0;
  let high = ranges.length;
  while (low < high) {
    work.steps += 1;
    const middle = (low + high) >>> 1;
    if (ranges[middle]!.start <= clock) low = middle + 1;
    else high = middle;
  }
  return ranges[low - 1];
}

function holdsPoint(
  points: readonly number[] | undefined,
  point: number,
  work: BodySequenceIntakeWork,
): boolean {
  if (!points) return false;
  let low = 0;
  let high = points.length - 1;
  while (low <= high) {
    work.steps += 1;
    const middle = (low + high) >>> 1;
    const held = points[middle]!;
    if (held === point) return true;
    if (held < point) low = middle + 1;
    else high = middle - 1;
  }
  return false;
}

/**
 * What a change sends, by client, for lookups that halve: its items and its delete ranges. Each is
 * built once, the first time a check asks, since most changes need neither.
 */
interface Sent {
  readonly read: Read;
  readonly items: () => ReadonlyMap<number, readonly ClockRange[]>;
  readonly deletes: () => ReadonlyMap<number, readonly ClockRange[]>;
}

function indexed(read: Read, work: BodySequenceIntakeWork): Sent {
  const add = (into: Map<number, ClockRange[]>, client: number, range: ClockRange) => {
    work.steps += 1;
    const held = into.get(client);
    if (held) held.push(range);
    else into.set(client, [range]);
  };
  let items: Map<number, ClockRange[]> | undefined;
  let deletes: Map<number, ClockRange[]> | undefined;
  return {
    read,
    items() {
      if (items) return items;
      items = new Map();
      for (const struct of read.structs)
        if (struct instanceof Y.Item)
          add(items, struct.id.client, {
            start: struct.id.clock,
            end: struct.id.clock + struct.length,
          });
        else work.steps += 1;
      return items;
    },
    deletes() {
      if (deletes) return deletes;
      deletes = new Map();
      for (const range of read.deletes)
        add(deletes, range.clientId, { start: range.startClock, end: range.endClock });
      return deletes;
    },
  };
}

/**
 * What can be told from the change alone and the note before it. A whole state has no note
 * before it, and every pair it could cut is one it sends. The read has already refused a struct
 * or a delete range that starts or ends inside a pair the change sends, so those are looked up
 * only in the note.
 */
function fitsAsSent(before: Y.Doc | undefined, sent: Sent, work: BodySequenceIntakeWork): boolean {
  const { read } = sent;
  const insideAPairOfTheNote = (client: number, clock: number) =>
    before !== undefined && insideAPairTheNoteHolds(before, client, clock);
  const insideAPair = (client: number, clock: number) =>
    insideAPairOfTheNote(client, clock) || holdsPoint(read.insidePairs.get(client), clock, work);
  for (const struct of read.structs) {
    work.steps += 1;
    if (struct instanceof Y.Skip) return false;
    const { client, clock } = struct.id;
    if (insideAPairOfTheNote(client, clock) || insideAPairOfTheNote(client, clock + struct.length))
      return false;
    if (!(struct instanceof Y.Item)) continue;
    // Yjs cuts a letter run where an item is placed inside it, and writes U+FFFD for each half of
    // a pair it cuts.
    if (struct.origin && insideAPair(struct.origin.client, struct.origin.clock + 1)) return false;
    if (struct.rightOrigin && insideAPair(struct.rightOrigin.client, struct.rightOrigin.clock))
      return false;
    if (typeof struct.parent === "string" && !ROOTS.has(struct.parent)) return false;
    if (struct.parentSub !== null && !wellFormed(struct.parentSub)) return false;
    const content = struct.content;
    if (content instanceof Y.ContentAny) {
      for (let index = 0; index < content.arr.length; index += 1)
        if (!jsonLike(content.arr[index], 0, false, work)) return false;
    } else if (content instanceof Y.ContentFormat) {
      if (!wellFormed(content.key) || !jsonLike(content.value, 0, true, work)) return false;
    } else if (content instanceof Y.ContentType) {
      const type = content.type as Stored;
      if (!plainType(type, Y.XmlElement) && !plainType(type, Y.Map) && !plainType(type, Y.Array))
        return false;
    } else if (content instanceof Y.ContentString) {
      if (!wellFormed(content.str)) return false;
    } else if (!(content instanceof Y.ContentDeleted)) return false;
  }
  // The save reads each delete range as it was written, so two that meet inside a pair are refused
  // there though the two joined are not.
  for (const [client, clocks] of read.deleteEndpoints)
    for (const clock of clocks) {
      work.steps += 1;
      if (insideAPairOfTheNote(client, clock)) return false;
    }
  return true;
}

/**
 * Why a struct the transaction added does not sit where a format-2 note can hold it: it is not
 * one such a note holds there, or it is a property deeper than the save reads. A `state` is a
 * note's first entry, which is where its format marker is written.
 */
function refusalAsPlaced(
  note: Y.Doc,
  transaction: Y.Transaction,
  sent: Sent,
  rules: BodySequenceIntakeRules,
  kind: "state" | "change",
  work: BodySequenceIntakeWork,
): Refusal | undefined {
  const allowed = bodySequenceNames();
  const roots = new Map<unknown, string>();
  for (const [name, type] of note.share) roots.set(type, name);
  interface Place {
    readonly root: string | undefined;
    /** How many types down from its root a nested type is. */
    readonly level: number;
  }
  const places = new Map<Stored, Place>();
  /** Where a nested type hangs. Each type on the way up is looked at once. */
  const placeOf = (type: Stored): Place => {
    const passed: Stored[] = [];
    let above: Place = { root: undefined, level: 0 };
    for (let at: Stored | null = type; at !== null;) {
      const root = roots.get(at);
      const known = root === undefined ? places.get(at) : { root, level: 0 };
      if (known) {
        above = known;
        break;
      }
      work.steps += 1;
      passed.push(at);
      at = (at._item?.parent as Stored | null | undefined) ?? null;
    }
    for (let index = passed.length - 1; index >= 0; index -= 1) {
      above = { root: above.root, level: above.level + 1 };
      places.set(passed[index]!, above);
    }
    return above;
  };
  /** The save reads a property 128 levels down and refuses a deeper one for capacity. */
  const tooDeep = (item: Y.Item, level: number) => {
    if (item.deleted) return false;
    if (!(item.content instanceof Y.ContentAny)) return level > MAX_VALUE_DEPTH;
    const { arr } = item.content;
    for (let index = 0; index < arr.length; index += 1)
      if (level + levelsUnder(arr[index], work) > MAX_VALUE_DEPTH) return true;
    return false;
  };
  let deep = false;
  const sentAsAnItem = (client: number, from: number, to: number) => {
    const last = rangeAtOrBefore(sent.items().get(client), to - 1, work);
    return last !== undefined && last.end > from;
  };
  const deletedByTheChange = (client: number, from: number, to: number) => {
    const range = rangeAtOrBefore(sent.deletes().get(client), from, work);
    return range !== undefined && range.end >= to;
  };
  const keyedValue = (item: Y.Item, key: (name: string) => boolean) =>
    item.parentSub !== null &&
    (item.content instanceof Y.ContentDeleted ||
      (item.content instanceof Y.ContentAny &&
        (item.deleted || (item.length === 1 && key(item.parentSub)))));
  const fits = (item: Y.Item): boolean => {
    const type = item.parent as Stored | null;
    if (!type) return false;
    const key = item.parentSub;
    const { left, right } = item;
    if (left && (left.parent !== type || left.parentSub !== key)) return false;
    if (right && (right.parent !== type || right.parentSub !== key)) return false;
    const content = item.content;
    if (key !== null && item.rightOrigin !== null) return false;
    const gone = content instanceof Y.ContentDeleted;
    const root = roots.get(type);
    if (root === BODY_SEQUENCE_FIELD) {
      if (key !== null) return false;
      if (gone || content instanceof Y.ContentString) return true;
      if (content instanceof Y.ContentFormat) return allowed.marks.has(content.key);
      if (!(content instanceof Y.ContentType) || !plainType(content.type, Y.XmlElement))
        return false;
      const name = (content.type as Y.XmlElement).nodeName;
      return name === BLOCK_ELEMENT || allowed.itemAttributes.has(name);
    }
    if (root === BODY_CONTAINERS_FIELD) return keyedValue(item, recordKey);
    if (root === FRONTMATTER_FIELD) return key !== null && (gone || holdsValue(content));
    if (root === META_FIELD) {
      if (key === null) return false;
      if (key === FORMAT_MARKER)
        return kind === "state" && (gone || content instanceof Y.ContentAny);
      if (!rules.metadata(key)) return false;
      if (gone) return true;
      if (!(content instanceof Y.ContentAny)) return false;
      return (
        item.deleted ||
        (item.length === 1 && rules.metadata(key, { value: content.arr[0] as unknown }))
      );
    }
    if (plainType(type, Y.XmlElement)) {
      if (roots.get(type._item?.parent) !== BODY_SEQUENCE_FIELD) return false;
      const name = (type as Y.XmlElement).nodeName;
      const attributes =
        name === BLOCK_ELEMENT ? allowed.boundaryAttributes : allowed.itemAttributes.get(name);
      return keyedValue(item, (attribute) => attributes?.has(attribute) === true);
    }
    const place = placeOf(type);
    if (place.root !== FRONTMATTER_FIELD) return false;
    const fitsItsHolder = plainType(type, Y.Map)
      ? key !== null
      : plainType(type, Y.Array) && key === null;
    if (!fitsItsHolder || !(gone || holdsValue(content))) return false;
    if (tooDeep(item, place.level)) deep = true;
    return true;
  };
  for (const [client, to] of transaction.afterState) {
    const from = transaction.beforeState.get(client) ?? 0;
    if (from >= to) continue;
    const structs = note.store.clients.get(client)!;
    for (let index = Y.findIndexSS(structs, from); index < structs.length; index += 1) {
      work.steps += 1;
      const struct = structs[index]!;
      if (struct instanceof Y.Item) {
        if (!fits(struct)) return "invalid-schema";
      } else if (sentAsAnItem(client, struct.id.clock, struct.id.clock + struct.length))
        return "invalid-schema";
    }
  }
  for (const struct of sent.read.structs) {
    work.steps += 1;
    if (!(struct instanceof Y.Item) || struct.length < 2) continue;
    const { client, clock } = struct.id;
    const placed = structAt(note, client, clock);
    if (!(placed instanceof Y.Item) || placed.parentSub === null) continue;
    if (!deletedByTheChange(client, clock, clock + struct.length - 1)) return "invalid-schema";
  }
  return deep ? "capacity-refused" : undefined;
}

const formatMarker = (note: Y.Doc) => note.share.get(META_FIELD)?._map.get(FORMAT_MARKER);
const nothingPending = (note: Y.Doc) =>
  note.store.pendingStructs === null && note.store.pendingDs === null;
const refusalOf = (reason: OrderedLiveUpdateCutRefusalReason): Refusal =>
  reason === "capacity-refused" ? reason : "invalid-schema";

/**
 * Section 5's intake for one change to a note whose body is one sequence. `apply` applies the
 * change to `note`, which is the note before it. It answers why the note cannot take the change:
 * a struct the change adds is not one such a note can hold where Yjs placed it, the note would no
 * longer say it is one, or the change is more than the save reads: reading it ran past the
 * policy's work, or it puts a property deeper than 128 levels. Those two are refusals for
 * capacity. After a refusal `note` may hold part of the change. An error `apply` throws is the
 * caller's.
 */
export function bodySequenceChangeRefusal(
  note: Y.Doc,
  update: Uint8Array,
  apply: () => void,
  rules: BodySequenceIntakeRules,
  work: BodySequenceIntakeWork = { steps: 0 },
): Refusal | undefined {
  const read = readLiveUpdateAsTheCutDoes(update, rules.policy);
  if (read.kind === "refused") return refusalOf(read.reason);
  work.read = read.usage;
  const sent = indexed(read, work);
  if (!fitsAsSent(note, sent, work)) return "invalid-schema";
  const marker = formatMarker(note);
  let refusal: Refusal | undefined;
  const placed = (transaction: Y.Transaction) => {
    refusal ??= refusalAsPlaced(note, transaction, sent, rules, "change", work);
  };
  note.on("beforeObserverCalls", placed);
  try {
    apply();
  } finally {
    note.off("beforeObserverCalls", placed);
  }
  if (refusal !== undefined) return refusal;
  return marker !== undefined &&
    !marker.deleted &&
    formatMarker(note) === marker &&
    nothingPending(note)
    ? undefined
    : "invalid-schema";
}

/**
 * The same rules for a note's first entry, a whole state that `apply` applies to the empty
 * `note`. A state that does not make the note a body-sequence note is not judged here.
 */
export function bodySequenceStateRefusal(
  note: Y.Doc,
  state: Uint8Array,
  apply: () => void,
  rules: BodySequenceIntakeRules,
  work: BodySequenceIntakeWork = { steps: 0 },
): Refusal | undefined {
  let refusal: Refusal | undefined;
  const placed = (transaction: Y.Transaction) => {
    if (refusal !== undefined || !holdsBodySequence(note)) return;
    const read = readLiveUpdateAsTheCutDoes(state, rules.policy);
    if (read.kind === "refused") {
      refusal = refusalOf(read.reason);
      return;
    }
    work.read = read.usage;
    const sent = indexed(read, work);
    refusal = fitsAsSent(undefined, sent, work)
      ? refusalAsPlaced(note, transaction, sent, rules, "state", work)
      : "invalid-schema";
  };
  note.on("beforeObserverCalls", placed);
  try {
    apply();
  } finally {
    note.off("beforeObserverCalls", placed);
  }
  return (
    refusal ?? (holdsBodySequence(note) && !nothingPending(note) ? "invalid-schema" : undefined)
  );
}

/**
 * The most values one change may hold for a room to take it. A value is a null, a boolean, a
 * number, a string, an array or an object, each counted once wherever it sits in an attribute, a
 * record, a property or a mark. Measured in single changes an editor sends: a pasted table of
 * 1,000 cells holds 10,201, a note of 10,000 lines seeded at once 20,000, a line 64 containers
 * deep 322, a cell with 1,000 column widths 1,001, and the densest change that fits the 2 MiB a
 * relay takes, 6,800 to-dos each with a link, 88,404. The save's check is at each value of a mark
 * seven times and counts to 5,000,000, so one change's values are at most 700,000 of that count.
 */
export const BODY_SEQUENCE_CHANGE_MAX_VALUES = 100_000;

/**
 * The policy a room reads one change under, from the save's: each count the save allows, divided
 * by how often the save is at what the read is at once. A change read under it is one whose
 * counts the save has room for.
 */
export function bodySequenceRoomPolicy(
  save: OrderedLiveUpdateCutPolicy,
): OrderedLiveUpdateCutPolicy {
  const room = {} as Record<keyof OrderedLiveUpdateCutPolicy, number>;
  for (const field of Object.keys(SAVE_VISITS_PER_READ) as (keyof OrderedLiveUpdateCutPolicy)[])
    room[field] = Math.max(1, Math.floor(save[field] / SAVE_VISITS_PER_READ[field]));
  return room;
}

/** What one change holds, counted and not checked. */
export interface BodySequenceChangeSize {
  readonly structs: number;
  readonly elements: number;
  readonly values: number;
  /** Its delete ranges, as it wrote them. */
  readonly deletes: number;
}

/**
 * Counts what a change holds from a plain decode of it, which checks nothing and copies no value.
 * The decode gives an object the prototype its `__proto__` key names, so the count goes by an
 * object's own keys and tells bytes from an object by what they are. A key written twice is one
 * key once decoded, and its copies are not counted: the strict read refuses such a change at the
 * second copy. It throws for bytes that do not decode.
 */
export function bodySequenceChangeSize(
  update: Uint8Array,
  work: BodySequenceIntakeWork = { steps: 0 },
): BodySequenceChangeSize {
  const { structs, ds } = Y.decodeUpdate(update);
  let deletes = 0;
  for (const ranges of ds.clients.values()) deletes += ranges.length;
  let elements = 0;
  let values = 0;
  const open: object[] = [];
  const count = (value: unknown) => {
    values += 1;
    if (typeof value === "object" && value !== null) open.push(value);
  };
  for (const struct of structs) {
    if (!(struct instanceof Y.Item)) continue;
    const content = struct.content;
    if (content instanceof Y.ContentType) {
      if (content.type instanceof Y.XmlElement) elements += 1;
    } else if (content instanceof Y.ContentAny || content instanceof Y.ContentJSON)
      for (let index = 0; index < content.arr.length; index += 1) count(content.arr[index]);
    else if (content instanceof Y.ContentFormat) count(content.value);
    else if (content instanceof Y.ContentEmbed) count(content.embed);
    while (open.length > 0) {
      const holder = open.pop()!;
      if (Array.isArray(holder))
        for (let index = 0; index < holder.length; index += 1) count(holder[index]);
      else if (!ArrayBuffer.isView(holder))
        for (const key of Object.keys(holder)) count((holder as Record<string, unknown>)[key]);
    }
  }
  work.steps += structs.length + values + deletes;
  return { structs: structs.length, elements, values, deletes };
}

/**
 * The limit a change is past by itself, as a sentence that names the limit, its unit and what
 * the change holds. Such a change could not be saved into an empty note, so a room refuses it
 * before it reads it. `save` is the policy of the save's check. A delete range can split the item
 * it starts in and the one it ends in, so each counts as two items the change can leave in the
 * note. A value takes at least one byte of a change, an item and a delete range two each and an
 * element five, so a change of no more bytes than the most values one may hold is past none of
 * these and is not counted. A change the count cannot decode, such as a value nested deeper than
 * the decoder's stack, is past none here either: the read says why it cannot be taken.
 */
export function bodySequenceChangeLimit(
  update: Uint8Array,
  save: OrderedLiveUpdateCutPolicy,
  work: BodySequenceIntakeWork = { steps: 0 },
): string | undefined {
  if (update.byteLength <= BODY_SEQUENCE_CHANGE_MAX_VALUES) return undefined;
  let size: BodySequenceChangeSize;
  try {
    size = bodySequenceChangeSize(update, work);
  } catch {
    return undefined;
  }
  const said = (count: number) => count.toLocaleString("en-US");
  const past = (most: number, unit: string, held: number) =>
    `One change to a note holds at most ${said(most)} ${unit}. This one holds ${said(held)}.`;
  if (size.values > BODY_SEQUENCE_CHANGE_MAX_VALUES)
    return past(BODY_SEQUENCE_CHANGE_MAX_VALUES, "values", size.values);
  const structs = bodySequenceRoomPolicy(save).maxStructVisits;
  if (size.structs > structs) return past(structs, "items", size.structs);
  const left = size.structs + 2 * size.deletes;
  if (left > structs)
    return past(
      structs,
      "items, counting two more for each range it deletes, which can split one",
      left,
    );
  const weight = left + LIVE_NOTE_ELEMENT_WEIGHT * size.elements;
  if (weight > LIVE_NOTE_CAPACITY)
    return past(
      LIVE_NOTE_CAPACITY,
      `units of weight, one for each item, two for each range it deletes and ${String(LIVE_NOTE_ELEMENT_WEIGHT)} more for each element`,
      weight,
    );
  return undefined;
}

interface Run {
  readonly marks: number;
  readonly shown: string;
}
interface Place {
  used: boolean;
  last: Run | undefined;
}
interface Leaf {
  readonly tag: string;
  readonly held: Place;
  readonly after: Place;
}
interface ReadMarks extends Run {
  readonly nodes: number;
  readonly generation: number;
}

const stored = (holder: { readonly _map: Map<string, Y.Item> } | undefined, key: string) => {
  const item = holder?._map.get(key);
  return item && !item.deleted && item.content instanceof Y.ContentAny
    ? { value: item.content.arr.at(-1) as unknown }
    : undefined;
};
const isWidth = (width: unknown) =>
  typeof width === "bigint"
    ? width >= 0n && width <= BigInt(Number.MAX_SAFE_INTEGER)
    : typeof width === "number" && Number.isFinite(width) && width >= 0;
const MAX_COLUMN_WIDTHS = 1000;

/**
 * The nodes the engine's Markdown writer spends reading the body of a note whose body is one
 * sequence, counted as `crates/dohc-engine-collab/src/ydoc/body_sequence.rs` counts them: each
 * entry it reads of each line's path, each container it opens and each list item it gives a
 * paragraph, each line, run of letters, mark of a run, inline item, attribute and column width,
 * and a paragraph for letters with no line to hold them or for a note with no line at all.
 */
export function bodySequenceEngineNodes(note: Y.Doc): number {
  const schema = getDohcProseMirrorSchema();
  const containers = note.share.get(BODY_CONTAINERS_FIELD);
  const markNames = Object.keys(schema.marks).filter((name) => name !== "code");
  const linkAttributes = Object.entries(schema.marks.link!.spec.attrs ?? {});
  let nodes = 0;
  const attributes = (kind: string, from: (name: string) => { value: unknown } | undefined) => {
    for (const name of Object.keys(schema.nodes[kind]?.spec.attrs ?? {})) {
      const held = from(name);
      if (!held) continue;
      nodes += 1;
      if (name !== "colwidth" || !Array.isArray(held.value)) continue;
      if (held.value.length > MAX_COLUMN_WIDTHS) continue;
      for (const width of held.value as unknown[]) {
        nodes += 1;
        if (!isWidth(width)) break;
      }
    }
  };
  const marks = new Map<string, Record<string, unknown>>();
  let generation = 0;
  let read: ReadMarks | undefined;
  let newestRun: number | undefined;
  const readMarks = (): ReadMarks => {
    const names = marks.has("code") ? ["code"] : markNames.filter((name) => marks.has(name));
    let spent = names.length;
    const shown = names.map((name) => {
      if (name !== "link") return [name];
      const attrs = marks.get(name)!;
      return linkAttributes.map(([key, spec]) => {
        if (!Object.hasOwn(attrs, key)) return spec.default as unknown;
        spent += 1;
        const value = attrs[key];
        return value === null || typeof value === "string" ? value : (spec.default as unknown);
      });
    });
    return { marks: names.length, shown: JSON.stringify(shown), nodes: spent, generation };
  };

  const open: { id: string; kind: string; first?: string }[] = [];
  let topHolds = false;
  let leaf: Leaf | undefined;
  const newLeaf = (tag: string): Leaf => ({
    tag,
    held: { used: false, last: undefined },
    after: { used: false, last: undefined },
  });
  const holdsLetters = (at: Leaf) =>
    !at.after.used && (at.tag === "paragraph" || at.tag === "heading" || at.tag === "codeBlock");
  const holdsInlineItems = (at: Leaf) =>
    !at.after.used && (at.tag === "paragraph" || at.tag === "heading");
  const placeFor = (holds: (at: Leaf) => boolean): Place => {
    if (!leaf) {
      nodes += 1;
      leaf = newLeaf("paragraph");
    }
    if (holds(leaf)) return leaf.held;
    if (!leaf.after.used) nodes += 1;
    return leaf.after;
  };
  const placed = (tag: string) => {
    const parent = open.at(-1);
    if (parent) parent.first ??= tag;
    else topHolds = true;
  };
  const closeLeaf = () => {
    if (!leaf) return;
    placed(leaf.tag);
    if (leaf.after.used) placed("paragraph");
    leaf = undefined;
  };
  const closeTo = (depth: number) => {
    while (open.length > depth) {
      const closed = open.pop()!;
      const item = closed.kind === "listItem" || closed.kind === "taskItem";
      if (item && closed.first !== "paragraph") nodes += 1;
      placed(closed.kind);
    }
  };
  const pathOf = (value: unknown) => {
    const path: { id: string; kind: string }[] = [];
    if (!Array.isArray(value)) return path;
    let parent: string | null = null;
    for (const id of (value as unknown[]).slice(0, MAX_SEQUENCE_DEPTH)) {
      nodes += 1;
      if (typeof id !== "string" || !CONTAINER_ID.test(id)) break;
      if (path.some((frame) => frame.id === id)) break;
      const recorded = stored(containers, id)?.value;
      if (typeof recorded !== "string") break;
      const kind: string = (parent !== null && ONLY_CHILD[parent]) || recorded;
      if (!childrenOf(parent).has(kind)) break;
      path.push({ id, kind });
      parent = kind;
    }
    while (path.length > 0 && !HOLDS_BLOCKS.has(path.at(-1)!.kind)) path.pop();
    return path;
  };
  const boundary = (element: Y.XmlElement) => {
    closeLeaf();
    const type = stored(element, "type")?.value;
    const leafType = typeof type === "string" ? schema.nodes[type] : undefined;
    const known = leafType?.isBlock && (leafType.isTextblock || leafType.isLeaf);
    const tag = known ? leafType!.name : "paragraph";
    const path = pathOf(stored(element, "path")?.value);
    let shared = 0;
    while (
      shared < Math.min(open.length, path.length) &&
      open[shared]!.id === path[shared]!.id &&
      open[shared]!.kind === path[shared]!.kind
    )
      shared += 1;
    closeTo(shared);
    for (const frame of path.slice(shared)) {
      nodes += 1;
      attributes(frame.kind, (name) => stored(containers, `${frame.id}.${name}`));
      open.push({ ...frame });
    }
    nodes += 1;
    attributes(tag, (name) => stored(element, name));
    leaf = newLeaf(tag);
  };
  const letters = (text: string) => {
    if (text === "") return;
    const unmarked = leaf !== undefined && leaf.tag === "codeBlock" && holdsLetters(leaf);
    if (!unmarked) read ??= readMarks();
    const marked = unmarked ? undefined : read;
    const place = placeFor(holdsLetters);
    place.used = true;
    const last = place.last;
    const joins =
      last !== undefined &&
      (marked === undefined
        ? last.marks === 0
        : newestRun === marked.generation ||
          (last.marks === marked.marks && last.shown === marked.shown));
    newestRun = marked?.generation;
    if (joins) return;
    nodes += 1 + (marked?.nodes ?? 0);
    place.last = marked ?? { marks: 0, shown: "[]" };
  };
  const inlineItem = (element: Y.XmlElement) => {
    nodes += 1;
    attributes(element.nodeName, (name) => stored(element, name));
    const place = placeFor(holdsInlineItems);
    place.used = true;
    place.last = undefined;
  };

  for (let item = note.share.get(BODY_SEQUENCE_FIELD)?._start ?? null; item; item = item.right) {
    if (item.deleted) continue;
    const content = item.content;
    if (content instanceof Y.ContentString) letters(content.str);
    else if (content instanceof Y.ContentFormat) {
      if (content.key !== "code" && !markNames.includes(content.key)) continue;
      const value = content.value as unknown;
      if (typeof value === "object" && value !== null && !Array.isArray(value))
        marks.set(content.key, value as Record<string, unknown>);
      else marks.delete(content.key);
      read = undefined;
      generation += 1;
    } else if (content instanceof Y.ContentType && content.type instanceof Y.XmlElement) {
      const element = content.type;
      if (element.nodeName === BLOCK_ELEMENT) boundary(element);
      else if (INLINE_ITEMS.has(element.nodeName)) inlineItem(element);
    }
  }
  closeLeaf();
  closeTo(0);
  return topHolds ? nodes : nodes + 1;
}
