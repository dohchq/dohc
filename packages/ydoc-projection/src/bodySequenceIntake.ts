import * as Y from "yjs";
import {
  BLOCK_ELEMENT,
  BODY_CONTAINERS_FIELD,
  BODY_SEQUENCE_FIELD,
  CONTAINER_ID,
} from "./bodySequenceGrammar.js";
import { holdsBodySequence } from "./bodySequenceYjs.js";
import { getDohcProseMirrorSchema } from "./import-export.js";
import {
  readLiveUpdateAsTheCutDoes,
  type LiveUpdateAsRead,
  type OrderedLiveUpdateCutPolicy,
  type OrderedLiveUpdateCutRefusalReason,
} from "./orderedLiveUpdateCut.js";

export interface BodySequenceIntakeRules {
  readonly policy: OrderedLiveUpdateCutPolicy;
  /**
   * Whether a change may write this key of the note's metadata, and for a value that shows,
   * whether the key may hold it.
   */
  readonly metadata: (key: string, shown?: { readonly value: unknown }) => boolean;
}

/** How many structs, delete ranges and index lookups one check went through. */
export interface BodySequenceIntakeWork {
  steps: number;
}

type Stored = ReturnType<Y.Doc["get"]>;
type Read = Extract<LiveUpdateAsRead, { kind: "read" }>;
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
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?:^|[^\uD800-\uDBFF])[\uDC00-\uDFFF]/;
const wellFormed = (text: string) => !LONE_SURROGATE.test(text);

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
 * int64 does not come back as it went in. It has no limit on how many values one change holds:
 * the room saves several changes as one, and a limit on the sum would refuse a save of changes
 * each of which the room took.
 */
function jsonLike(value: unknown, depth: number, asJson: boolean): boolean {
  if (depth > MAX_VALUE_DEPTH) return false;
  if (value === null || typeof value === "boolean") return true;
  if (typeof value === "string") return wellFormed(value);
  if (typeof value === "number") return Number.isFinite(value) && !(asJson && Object.is(value, -0));
  if (typeof value === "bigint") return !asJson;
  if (Array.isArray(value))
    return Array.from(value as unknown[]).every((child) => jsonLike(child, depth + 1, asJson));
  if (typeof value !== "object" || value instanceof Uint8Array) return false;
  return Object.keys(value).every(
    (key) =>
      key !== "__proto__" &&
      wellFormed(key) &&
      jsonLike((value as Record<string, unknown>)[key], depth + 1, asJson),
  );
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

/** What a change sends, by client, for lookups that halve: its items and its delete ranges. */
interface Sent {
  readonly read: Read;
  readonly items: ReadonlyMap<number, readonly ClockRange[]>;
  readonly deletes: ReadonlyMap<number, readonly ClockRange[]>;
}

function indexed(read: Read, work: BodySequenceIntakeWork): Sent {
  const items = new Map<number, ClockRange[]>();
  const deletes = new Map<number, ClockRange[]>();
  const add = (into: Map<number, ClockRange[]>, client: number, range: ClockRange) => {
    work.steps += 1;
    const held = into.get(client);
    if (held) held.push(range);
    else into.set(client, [range]);
  };
  for (const struct of read.structs)
    if (struct instanceof Y.Item)
      add(items, struct.id.client, {
        start: struct.id.clock,
        end: struct.id.clock + struct.length,
      });
    else work.steps += 1;
  for (const range of read.deletes)
    add(deletes, range.clientId, { start: range.startClock, end: range.endClock });
  return { read, items, deletes };
}

/**
 * What can be told from the change alone and the note before it. A whole state has no note
 * before it, and every pair it could cut is one it sends.
 */
function fitsAsSent(before: Y.Doc | undefined, sent: Sent, work: BodySequenceIntakeWork): boolean {
  const { read } = sent;
  const insideAPair = (client: number, clock: number) =>
    (before !== undefined && insideAPairTheNoteHolds(before, client, clock)) ||
    holdsPoint(read.insidePairs.get(client), clock, work);
  for (const struct of read.structs) {
    work.steps += 1;
    if (struct instanceof Y.Skip) return false;
    const { client, clock } = struct.id;
    if (insideAPair(client, clock) || insideAPair(client, clock + struct.length)) return false;
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
      if (!content.arr.every((value) => jsonLike(value, 0, false))) return false;
    } else if (content instanceof Y.ContentFormat) {
      if (!wellFormed(content.key) || !jsonLike(content.value, 0, true)) return false;
    } else if (content instanceof Y.ContentType) {
      const type = content.type as Stored;
      if (!plainType(type, Y.XmlElement) && !plainType(type, Y.Map) && !plainType(type, Y.Array))
        return false;
    } else if (content instanceof Y.ContentString) {
      if (!wellFormed(content.str)) return false;
    } else if (!(content instanceof Y.ContentDeleted)) return false;
  }
  for (const range of read.deletes) {
    work.steps += 1;
    if (
      insideAPair(range.clientId, range.startClock) ||
      insideAPair(range.clientId, range.endClock)
    )
      return false;
  }
  return true;
}

/**
 * Whether each struct the transaction added sits where a format-2 note can hold it. A `state` is
 * a note's first entry, which is where its format marker is written.
 */
function fitsAsPlaced(
  note: Y.Doc,
  transaction: Y.Transaction,
  sent: Sent,
  rules: BodySequenceIntakeRules,
  kind: "state" | "change",
  work: BodySequenceIntakeWork,
): boolean {
  const allowed = bodySequenceNames();
  const roots = new Map<unknown, string>();
  for (const [name, type] of note.share) roots.set(type, name);
  const under = new Map<Stored, string | undefined>();
  /** The root a nested type hangs from. Each type on the way up is looked at once. */
  const rootOf = (type: Stored): string | undefined => {
    const passed: Stored[] = [];
    let root: string | undefined;
    for (let at: Stored | null = type; at !== null;) {
      root = roots.get(at) ?? under.get(at);
      if (root !== undefined || under.has(at)) break;
      work.steps += 1;
      passed.push(at);
      at = (at._item?.parent as Stored | null | undefined) ?? null;
    }
    for (const each of passed) under.set(each, root);
    return root;
  };
  const sentAsAnItem = (client: number, from: number, to: number) => {
    const last = rangeAtOrBefore(sent.items.get(client), to - 1, work);
    return last !== undefined && last.end > from;
  };
  const deletedByTheChange = (client: number, from: number, to: number) => {
    const range = rangeAtOrBefore(sent.deletes.get(client), from, work);
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
    for (const near of [item.left, item.right])
      if (near && (near.parent !== type || near.parentSub !== item.parentSub)) return false;
    const key = item.parentSub;
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
    if (rootOf(type) !== FRONTMATTER_FIELD) return false;
    if (plainType(type, Y.Map)) return key !== null && (gone || holdsValue(content));
    if (plainType(type, Y.Array)) return key === null && (gone || holdsValue(content));
    return false;
  };
  for (const [client, to] of transaction.afterState) {
    const from = transaction.beforeState.get(client) ?? 0;
    if (from >= to) continue;
    const structs = note.store.clients.get(client)!;
    for (let index = Y.findIndexSS(structs, from); index < structs.length; index += 1) {
      work.steps += 1;
      const struct = structs[index]!;
      if (struct instanceof Y.Item) {
        if (!fits(struct)) return false;
      } else if (sentAsAnItem(client, struct.id.clock, struct.id.clock + struct.length))
        return false;
    }
  }
  for (const struct of sent.read.structs) {
    work.steps += 1;
    if (!(struct instanceof Y.Item) || struct.length < 2) continue;
    const { client, clock } = struct.id;
    const placed = structAt(note, client, clock);
    if (!(placed instanceof Y.Item) || placed.parentSub === null) continue;
    if (!deletedByTheChange(client, clock, clock + struct.length - 1)) return false;
  }
  return true;
}

const formatMarker = (note: Y.Doc) => note.share.get(META_FIELD)?._map.get(FORMAT_MARKER);
const nothingPending = (note: Y.Doc) =>
  note.store.pendingStructs === null && note.store.pendingDs === null;
const refusalOf = (reason: OrderedLiveUpdateCutRefusalReason) =>
  reason === "capacity-refused" ? reason : "invalid-schema";

/**
 * Section 5's intake for one change to a note whose body is one sequence. `apply` applies the
 * change to `note`, which is the note before it. It answers why the note cannot take the change:
 * a struct the change adds is not one such a note can hold where Yjs placed it, the note would no
 * longer say it is one, or reading the change ran past the policy's work, which is a refusal for
 * capacity. After a refusal `note` may hold part of the change. An error `apply` throws is the
 * caller's.
 */
export function bodySequenceChangeRefusal(
  note: Y.Doc,
  update: Uint8Array,
  apply: () => void,
  rules: BodySequenceIntakeRules,
  work: BodySequenceIntakeWork = { steps: 0 },
): "invalid-schema" | "capacity-refused" | undefined {
  const read = readLiveUpdateAsTheCutDoes(update, rules.policy);
  if (read.kind === "refused") return refusalOf(read.reason);
  const sent = indexed(read, work);
  if (!fitsAsSent(note, sent, work)) return "invalid-schema";
  const marker = formatMarker(note);
  let fits = true;
  const placed = (transaction: Y.Transaction) => {
    if (!fitsAsPlaced(note, transaction, sent, rules, "change", work)) fits = false;
  };
  note.on("beforeObserverCalls", placed);
  try {
    apply();
  } finally {
    note.off("beforeObserverCalls", placed);
  }
  return fits &&
    marker !== undefined &&
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
): "invalid-schema" | "capacity-refused" | undefined {
  let refusal: "invalid-schema" | "capacity-refused" | undefined;
  const placed = (transaction: Y.Transaction) => {
    if (!holdsBodySequence(note)) return;
    const read = readLiveUpdateAsTheCutDoes(state, rules.policy);
    if (read.kind === "refused") {
      refusal = refusalOf(read.reason);
      return;
    }
    const sent = indexed(read, work);
    if (
      !fitsAsSent(undefined, sent, work) ||
      !fitsAsPlaced(note, transaction, sent, rules, "state", work)
    )
      refusal = "invalid-schema";
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
