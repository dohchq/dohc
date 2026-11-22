import * as Y from "yjs";
import {
  BLOCK_ELEMENT,
  BODY_CONTAINERS_FIELD,
  BODY_SEQUENCE_FIELD,
  CONTAINER_ID,
} from "./bodySequenceGrammar.js";
import { getDohcProseMirrorSchema } from "./import-export.js";
import {
  readLiveUpdateAsTheCutDoes,
  type LiveUpdateAsRead,
  type OrderedLiveUpdateCutPolicy,
} from "./orderedLiveUpdateCut.js";

export interface BodySequenceIntakeRules {
  readonly policy: OrderedLiveUpdateCutPolicy;
  /**
   * Whether a change may write this key of the note's metadata, and for a value that shows,
   * whether the key may hold it.
   */
  readonly metadata: (key: string, shown?: { readonly value: unknown }) => boolean;
}

type Stored = ReturnType<Y.Doc["get"]>;

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
const MAX_VALUE_NODES = 262_144;
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
 * an array or a plain object of these, with no lone surrogate and no key named `__proto__`.
 * `asJson` is for a value Yjs stores as JSON text, where a negative zero or an int64 does not
 * come back as it went in.
 */
function jsonLike(
  value: unknown,
  depth: number,
  seen: { nodes: number },
  asJson: boolean,
): boolean {
  if (depth > MAX_VALUE_DEPTH || ++seen.nodes > MAX_VALUE_NODES) return false;
  if (value === null || typeof value === "boolean") return true;
  if (typeof value === "string") return wellFormed(value);
  if (typeof value === "number") return Number.isFinite(value) && !(asJson && Object.is(value, -0));
  if (typeof value === "bigint") return !asJson;
  if (Array.isArray(value))
    return Array.from(value as unknown[]).every((child) =>
      jsonLike(child, depth + 1, seen, asJson),
    );
  if (typeof value !== "object" || value instanceof Uint8Array) return false;
  return Object.keys(value).every(
    (key) =>
      key !== "__proto__" &&
      wellFormed(key) &&
      jsonLike((value as Record<string, unknown>)[key], depth + 1, seen, asJson),
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

/** What can be told from the change alone and the note before it. */
function fitsAsSent(note: Y.Doc, read: LiveUpdateAsRead): boolean {
  const seen = { nodes: 0 };
  for (const struct of read.structs) {
    if (struct instanceof Y.Skip || struct.length < 1) return false;
    if (!(struct instanceof Y.Item)) continue;
    if (typeof struct.parent === "string" && !ROOTS.has(struct.parent)) return false;
    if (struct.parentSub !== null && !wellFormed(struct.parentSub)) return false;
    const content = struct.content;
    if (content instanceof Y.ContentAny) {
      if (!content.arr.every((value) => jsonLike(value, 0, seen, false))) return false;
    } else if (content instanceof Y.ContentFormat) {
      if (!wellFormed(content.key) || !jsonLike(content.value, 0, seen, true)) return false;
    } else if (content instanceof Y.ContentType) {
      const type = content.type as Stored;
      if (!plainType(type, Y.XmlElement) && !plainType(type, Y.Map) && !plainType(type, Y.Array))
        return false;
    } else if (!(content instanceof Y.ContentString) && !(content instanceof Y.ContentDeleted))
      return false;
  }
  return read.deletes.every(
    (range) =>
      !insideAPairTheNoteHolds(note, range.clientId, range.startClock) &&
      !insideAPairTheNoteHolds(note, range.clientId, range.endClock),
  );
}

/** Whether each struct the change added sits where a format-2 note can hold it. */
function fitsAsPlaced(
  note: Y.Doc,
  transaction: Y.Transaction,
  read: LiveUpdateAsRead,
  rules: BodySequenceIntakeRules,
): boolean {
  const allowed = bodySequenceNames();
  const roots = new Map<unknown, string>();
  for (const [name, type] of note.share) roots.set(type, name);
  const sentAsAnItem = (client: number, from: number, to: number) =>
    read.structs.some(
      (struct) =>
        struct instanceof Y.Item &&
        struct.id.client === client &&
        struct.id.clock < to &&
        struct.id.clock + struct.length > from,
    );
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
      if (key === null || !rules.metadata(key)) return false;
      if (gone) return true;
      if (!(content instanceof Y.ContentAny)) return false;
      return (
        item.deleted ||
        (item.length === 1 && rules.metadata(key, { value: content.arr[0] as unknown }))
      );
    }
    if (root !== undefined) return false;
    if (plainType(type, Y.XmlElement)) {
      if (roots.get(type._item?.parent) !== BODY_SEQUENCE_FIELD) return false;
      const name = (type as Y.XmlElement).nodeName;
      const attributes =
        name === BLOCK_ELEMENT ? allowed.boundaryAttributes : allowed.itemAttributes.get(name);
      return keyedValue(item, (attribute) => attributes?.has(attribute) === true);
    }
    if (plainType(type, Y.Map)) return key !== null && (gone || holdsValue(content));
    if (plainType(type, Y.Array)) return key === null && (gone || holdsValue(content));
    return false;
  };
  for (const [client, to] of transaction.afterState) {
    const from = transaction.beforeState.get(client) ?? 0;
    if (from >= to) continue;
    const structs = note.store.clients.get(client)!;
    for (let index = Y.findIndexSS(structs, from); index < structs.length; index += 1) {
      const struct = structs[index]!;
      if (struct instanceof Y.Item) {
        if (!fits(struct)) return false;
      } else if (sentAsAnItem(client, struct.id.clock, struct.id.clock + struct.length))
        return false;
    }
  }
  return read.structs.every((struct) => {
    if (!(struct instanceof Y.Item) || struct.length < 2) return true;
    const placed = structAt(note, struct.id.client, struct.id.clock);
    if (!(placed instanceof Y.Item) || placed.parentSub === null) return true;
    const lastButOne = struct.id.clock + struct.length - 1;
    return read.deletes.some(
      (range) =>
        range.clientId === struct.id.client &&
        range.startClock <= struct.id.clock &&
        range.endClock >= lastButOne,
    );
  });
}

const formatMarker = (note: Y.Doc) => note.share.get(META_FIELD)?._map.get(FORMAT_MARKER);

/**
 * Section 5's intake for one change to a note whose body is one sequence. `apply` applies the
 * change to `note`, which is the note before it. The answer is whether every struct the change
 * adds is one such a note can hold, where Yjs placed it, and whether the note still says it is
 * one. After false, `note` may hold part of the change. An error `apply` throws is the caller's.
 */
export function bodySequenceChangeFits(
  note: Y.Doc,
  update: Uint8Array,
  apply: () => void,
  rules: BodySequenceIntakeRules,
): boolean {
  const read = readLiveUpdateAsTheCutDoes(update, rules.policy);
  if (!read || !fitsAsSent(note, read)) return false;
  const marker = formatMarker(note);
  let fits = true;
  const placed = (transaction: Y.Transaction) => {
    if (!fitsAsPlaced(note, transaction, read, rules)) fits = false;
  };
  note.on("beforeObserverCalls", placed);
  try {
    apply();
  } finally {
    note.off("beforeObserverCalls", placed);
  }
  return (
    fits &&
    marker !== undefined &&
    !marker.deleted &&
    formatMarker(note) === marker &&
    note.store.pendingStructs === null &&
    note.store.pendingDs === null
  );
}
