import * as Y from "yjs";

export const MAX_SEQUENCE_DEPTH = 64;
export const BODY_SEQUENCE_FIELD = "sequence";
export const BODY_CONTAINERS_FIELD = "containers";
export const BLOCK_ELEMENT = "block";
export const CONTAINER_ID = /^[A-Za-z0-9_-]{1,32}$/;
export const BODY_SEQUENCE_SCHEMA_VERSION = 2;

type StoredKeys = { readonly _map: Map<string, Y.Item> };

/**
 * The value stored under a key of a shared type: the last value of a live item that holds plain
 * values. An item of any other kind holds none, because Yjs and yrs read such an item differently.
 */
export function storedValue(holder: StoredKeys | undefined, key: string): unknown {
  const item = holder?._map.get(key);
  return item && !item.deleted && item.content instanceof Y.ContentAny
    ? item.content.arr.at(-1)
    : undefined;
}

/** Whether a note's body is one sequence. Reads the stored marker, and declares no root. */
export function holdsBodySequence(doc: Y.Doc): boolean {
  return storedValue(doc.share.get("meta"), "schemaVersion") === BODY_SEQUENCE_SCHEMA_VERSION;
}

/**
 * Whether a note is read from its sequence: it says its body is one sequence, and the sequence
 * holds any item or `body` holds none. A note marked by a change that does not know the format,
 * with its text still under `body`, is read from `body`. Declares no root.
 */
export function readsBodySequence(doc: Y.Doc): boolean {
  return (
    holdsBodySequence(doc) &&
    ((doc.share.get("body")?._start ?? null) === null ||
      (doc.share.get(BODY_SEQUENCE_FIELD)?._start ?? null) !== null)
  );
}

/**
 * Stops Yjs from deleting formatting items of a note's sequence on its own after a change from
 * elsewhere, until the returned function is called. Those deletes are in nobody's change, and
 * neither the server's checks nor the engine make them, so a page that made them would stop
 * reading as the stored note. The plugin does this for the sequence it binds. A host that holds a
 * note's document with no editor on it calls this itself.
 *
 * Yjs has no setting for this, and decides it for a whole transaction. Each text's observer call
 * sets a field of the transaction, and after the `afterTransaction` listeners Yjs cleans the
 * texts the transaction put items into or deleted items of. For a transaction from elsewhere
 * that did so to the sequence, a `beforeObserverCalls` listener makes that field read false,
 * whatever is set later: it gives the transaction a getter in the field's place. That costs
 * nothing for each event, and no listener that throws can undo it. When one throws before this
 * one runs, Yjs calls no observer and cleans nothing. Such a transaction also leaves alone the
 * formatting items of any other text it changes in the same document. Those items change nothing
 * that text reads as; they stay stored. Any other transaction is cleaned as Yjs cleans it.
 */
export function keepBodySequenceFormatting(sequence: Y.Text): () => void {
  const doc = sequence.doc;
  if (!doc) throw new Error("The body sequence must be part of a Yjs document.");
  const keep = (transaction: Y.Transaction) => {
    const changed: ReadonlyMap<unknown, unknown> = transaction.changed;
    if (transaction.local || !changed.has(sequence)) return;
    Object.defineProperty(transaction, "_needFormattingCleanup", { get: () => false, set() {} });
  };
  doc.on("beforeObserverCalls", keep);
  return () => doc.off("beforeObserverCalls", keep);
}

/**
 * Declares a note's `sequence` and `containers`, for a document no update was applied to yet, and
 * keeps the sequence's formatting for as long as the document lives. Declaring both roots is
 * harmless for a note in the first format: they stay empty.
 */
export function declareBodySequence(doc: Y.Doc): void {
  const release = keepBodySequenceFormatting(doc.getText(BODY_SEQUENCE_FIELD));
  doc.getMap(BODY_CONTAINERS_FIELD);
  doc.once("destroy", release);
}

const byKey = (entries: [string, unknown][]): Record<string, unknown> =>
  Object.fromEntries(entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));

const asText = (_key: string, value: unknown) =>
  typeof value === "bigint" ? `${value.toString()}n` : value;

/**
 * What a format-2 note's body reads as, as a string: its letters with their formatting, its
 * boundaries and inline items with their attributes, and the containers they name, each named by
 * where it first appears. Two notes whose bodies read the same give the same string, whatever ids
 * their containers have and however their items are split.
 */
export function bodySequenceReading(doc: Y.Doc): string {
  const records = doc.share.get(BODY_CONTAINERS_FIELD);
  const keysOf = new Map<string, string[]>();
  for (const key of records?._map.keys() ?? []) {
    const dot = key.indexOf(".");
    if (dot < 0) continue;
    const id = key.slice(0, dot);
    const keys = keysOf.get(id);
    if (keys) keys.push(key);
    else keysOf.set(id, [key]);
  }
  const names = new Map<string, number>();
  const containers: unknown[] = [];
  const nameOf = (id: unknown) => {
    if (typeof id !== "string") return id;
    if (!names.has(id)) {
      names.set(id, names.size);
      const attributes = (keysOf.get(id) ?? []).map((key): [string, unknown] => [
        key.slice(id.length + 1),
        storedValue(records, key),
      ]);
      containers.push([storedValue(records, id), byKey(attributes)]);
    }
    return names.get(id);
  };
  const pieces: ({ text: string; marks: string } | { item: string; attrs: object })[] = [];
  const marks = new Map<string, unknown>();
  for (let item = doc.share.get(BODY_SEQUENCE_FIELD)?._start ?? null; item; item = item.right) {
    if (item.deleted) continue;
    const content = item.content;
    if (content instanceof Y.ContentFormat) {
      if (content.value === null) marks.delete(content.key);
      else marks.set(content.key, content.value);
    } else if (content instanceof Y.ContentString) {
      const formatting = JSON.stringify(byKey([...marks]), asText);
      const last = pieces.at(-1);
      if (last && "text" in last && last.marks === formatting) last.text += content.str;
      else pieces.push({ text: content.str, marks: formatting });
    } else if (content instanceof Y.ContentType && content.type instanceof Y.XmlElement) {
      const element = content.type;
      const attributes = [...element._map.keys()].map((key): [string, unknown] => {
        const value = storedValue(element, key);
        return [key, key === "path" && Array.isArray(value) ? value.map(nameOf) : value];
      });
      pieces.push({ item: element.nodeName, attrs: byKey(attributes) });
    }
  }
  return JSON.stringify([pieces, containers], asText);
}

export const INLINE_ITEMS: ReadonlySet<string> = new Set([
  "hardBreak",
  "image",
  "escapedPunctuation",
  "wikilink",
  "inlineAtom",
  "mathInline",
  "rawInline",
]);
export const HOLDS_BLOCKS: ReadonlySet<string> = new Set([
  "blockquote",
  "callout",
  "listItem",
  "taskItem",
  "tableCell",
  "tableHeader",
]);
const BLOCK_CONTAINERS = new Set([
  "blockquote",
  "bulletList",
  "callout",
  "orderedList",
  "table",
  "taskList",
]);
export const ONLY_CHILD: Readonly<Record<string, string>> = {
  bulletList: "listItem",
  orderedList: "listItem",
  taskList: "taskItem",
  table: "tableRow",
};
const CELLS = new Set(["tableCell", "tableHeader"]);

export const childrenOf = (parent: string | null): ReadonlySet<string> =>
  parent === null || HOLDS_BLOCKS.has(parent)
    ? BLOCK_CONTAINERS
    : parent === "tableRow"
      ? CELLS
      : new Set(ONLY_CHILD[parent] ? [ONLY_CHILD[parent]] : []);

function nestsAHeading(path: unknown, containers: StoredKeys | undefined): boolean {
  if (!Array.isArray(path)) return false;
  const ids: unknown[] = [];
  for (let at = 0; at < path.length; at++) {
    const held = Object.getOwnPropertyDescriptor(path, at);
    if (!held || !("value" in held)) return false;
    ids.push(held.value);
  }
  const seen = new Set<string>();
  let parent: string | null = null;
  let nests = false;
  for (const id of ids.slice(0, MAX_SEQUENCE_DEPTH)) {
    if (typeof id !== "string" || !CONTAINER_ID.test(id) || seen.has(id)) break;
    const recorded = storedValue(containers, id);
    if (typeof recorded !== "string") break;
    const type: string = (parent !== null && ONLY_CHILD[parent]) || recorded;
    if (!childrenOf(parent).has(type)) break;
    seen.add(id);
    parent = type;
    nests ||= HOLDS_BLOCKS.has(type);
  }
  return nests;
}

const levelOf = (value: unknown): number => {
  const level = typeof value === "bigint" ? Number(value) : value;
  return typeof level === "number" && Number.isInteger(level) && level >= 1 && level <= 6
    ? level
    : 1;
};

/**
 * Whether a format-2 note reads as starting with a top-level heading of level 1, by the reader's
 * rules: nothing it reads stands before the first boundary, that boundary is a heading, and no
 * container it names keeps it out of the top level.
 */
export function bodySequenceOpensWithH1(doc: Y.Doc): boolean {
  const sequence = doc.share.get(BODY_SEQUENCE_FIELD);
  for (let item = sequence?._start ?? null; item !== null; item = item.right) {
    if (item.deleted) continue;
    const content = item.content;
    if (content instanceof Y.ContentString) {
      if (content.str !== "") return false;
      continue;
    }
    if (!(content instanceof Y.ContentType) || !(content.type instanceof Y.XmlElement)) continue;
    const element = content.type;
    if (INLINE_ITEMS.has(element.nodeName)) return false;
    if (element.nodeName !== BLOCK_ELEMENT) continue;
    return (
      storedValue(element, "type") === "heading" &&
      levelOf(storedValue(element, "level")) === 1 &&
      !nestsAHeading(storedValue(element, "path"), doc.share.get(BODY_CONTAINERS_FIELD))
    );
  }
  return false;
}
