import type { Schema } from "@tiptap/pm/model";
import * as Y from "yjs";
import {
  BLOCK_ELEMENT,
  BODY_CONTAINERS_FIELD,
  BODY_SEQUENCE_FIELD,
  MAX_SEQUENCE_DEPTH,
  leavesOfSequence,
  recordsOfContainer,
  type SequenceAttrs,
} from "./bodySequenceGrammar.js";

/**
 * A container as a writer holds it. Neighbouring lines in one container hold the same object, so
 * two objects with one id are one id on two containers.
 */
export type BodyContainer = {
  id: string;
  type: string;
  /** For a container the change makes: the attributes it starts with. */
  starts?: SequenceAttrs;
  /** For a container the change gives a fresh id: the id whose records it takes. */
  copies?: string;
  /** Record changes to write, by attribute name, with "" for the type. */
  changes: Map<string, unknown>;
};

/** One leaf block of a note's body, as a writer reads it. */
export type BodyLine = {
  /** Null for text that stands before the first boundary. */
  boundary: Y.XmlElement | null;
  /** Where the line's text starts in the sequence. Its boundary stands one place before. */
  start: number;
  /** How many letters and inline items the line holds. */
  length: number;
  /** The boundary's attributes as stored, `path` among them. */
  attrs: SequenceAttrs;
  /** The containers the line is in, outermost first. */
  path: BodyContainer[];
  /** The ids of those containers as the line was read. */
  ids: string[];
};

/** What one change writes. `writeBody` writes it, inside one transaction. */
export type BodyWrites = {
  records: Map<string, unknown>;
  attributes: Map<Y.XmlElement, SequenceAttrs>;
  /** Where a boundary is deleted. */
  removed?: number;
  /** A boundary to insert, and where. */
  added?: { index: number; attrs: SequenceAttrs };
};

const ITEM_OF_LIST: Record<string, string> = {
  bulletList: "listItem",
  orderedList: "listItem",
  taskList: "taskItem",
};
const isList = (type: string | undefined) =>
  type !== undefined && Object.hasOwn(ITEM_OF_LIST, type);
const isItem = (type: string | undefined) => type === "listItem" || type === "taskItem";
const same = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);

function attributesOf(element: Y.XmlElement): SequenceAttrs {
  const entries: [string, unknown][] = [];
  element._map.forEach((item, key) => {
    if (!item.deleted) entries.push([key, item.content.getContent()[item.length - 1]]);
  });
  return Object.fromEntries(entries);
}

/** The lines of a note's body, in order, for a writer to change. */
export function readBody(schema: Schema, doc: Y.Doc): BodyLine[] {
  const records = doc.getMap(BODY_CONTAINERS_FIELD);
  const lines: BodyLine[] = [];
  let at = 0;
  for (let item = doc.getText(BODY_SEQUENCE_FIELD)._start; item !== null; item = item.right) {
    if (item.deleted || !item.countable) continue;
    const element = item.content instanceof Y.ContentType ? item.content.type : null;
    if (element instanceof Y.XmlElement && element.nodeName === BLOCK_ELEMENT) {
      const attrs = attributesOf(element);
      const frames = leavesOfSequence(schema, [{ boundary: attrs }], records)[0]!.path;
      const above = lines.at(-1)?.path ?? [];
      let shared = true;
      const path = frames.map((frame, depth): BodyContainer => {
        shared &&= above[depth]?.id === frame.id;
        return shared ? above[depth]! : { id: frame.id, type: frame.type, changes: new Map() };
      });
      const ids = frames.map((frame) => frame.id);
      lines.push({ boundary: element, start: at + 1, length: 0, attrs, path, ids });
    } else if (lines.length > 0) lines.at(-1)!.length += item.length;
    else
      lines.push({ boundary: null, start: 0, length: item.length, attrs: {}, path: [], ids: [] });
    at += item.length;
  }
  return lines;
}

function writesOf(
  schema: Schema,
  doc: Y.Doc,
  lines: BodyLine[],
  freshId: () => string,
  added?: BodyLine,
): BodyWrites | null {
  const stored = doc.getMap(BODY_CONTAINERS_FIELD);
  const placed = new Set<BodyContainer>();
  let asHeld: BodyContainer[] = [];
  let asWritten: BodyContainer[] = [];
  for (const line of lines) {
    let shared = true;
    const path = line.path.map((container, depth): BodyContainer => {
      shared &&= asHeld[depth] === container;
      if (shared) return asWritten[depth]!;
      if (!placed.has(container)) {
        placed.add(container);
        return container;
      }
      const laterHalf = { ...container, id: freshId(), changes: new Map<string, unknown>() };
      if (!container.starts) laterHalf.copies = container.copies ?? container.id;
      return laterHalf;
    });
    asHeld = line.path;
    asWritten = path;
    line.path = path;
  }

  const held = [...new Set(lines.flatMap((line) => line.path))];
  for (const container of held) {
    const onTwo = held.some((other) => other !== container && other.id === container.id);
    if (onTwo && container.changes.size > 0 && !container.starts && !container.copies) {
      container.copies = container.id;
      container.id = freshId();
    }
  }

  const records = new Map<string, unknown>();
  for (const container of held) {
    const { id, type, starts, copies, changes } = container;
    if (starts || copies)
      for (const [key, value] of recordsOfContainer(schema, { id, type, attrs: starts ?? {} })) {
        const kept = copies ? stored.get(copies + key.slice(id.length)) : undefined;
        records.set(key, kept === undefined ? value : kept);
      }
    for (const [name, value] of changes) records.set(name === "" ? id : `${id}.${name}`, value);
  }

  const attributes = new Map<Y.XmlElement, SequenceAttrs>();
  for (const line of lines) {
    const ids = line.path.map((container) => container.id);
    if (line !== added && same(ids, line.ids)) continue;
    if (ids.length > MAX_SEQUENCE_DEPTH || new Set(ids).size < ids.length) return null;
    if (line.boundary) attributes.set(line.boundary, { path: ids });
    else if (line !== added && ids.length > 0) return null;
  }
  if (!added) return { records, attributes };
  const path = added.path.map((container) => container.id);
  return { records, attributes, added: { index: added.start, attrs: { ...added.attrs, path } } };
}

function blocksAround(lines: BodyLine[], at: number, depth: number) {
  const around = lines[at]!.path.slice(0, depth);
  const inside = (index: number) =>
    lines[index] !== undefined &&
    lines[index].path.length >= depth &&
    around.every((container, level) => lines[index]!.path[level] === container);
  let from = at;
  while (inside(from - 1)) from--;
  let to = at;
  while (inside(to + 1)) to++;
  const blocks: { from: number; to: number }[] = [];
  for (let index = from; index <= to; index++) {
    const last = blocks.at(-1);
    const holder = lines[index]!.path[depth];
    if (last && holder !== undefined && lines[last.to]!.path[depth] === holder) last.to = index;
    else blocks.push({ from: index, to: index });
  }
  return { blocks, own: blocks.findIndex((block) => block.from <= at && at <= block.to) };
}

/**
 * Split a line at an offset. The new line gets the line's kind and path, or a new item when the
 * line is the first block of a list item; the item's later blocks go with the text after the caret.
 * At offset 0 of a line that holds text, the new boundary goes before the line's own.
 */
export function splitLine(
  schema: Schema,
  doc: Y.Doc,
  at: number,
  offset: number,
  freshId: () => string,
): BodyWrites | null {
  const lines = readBody(schema, doc);
  const line = lines[at];
  if (!line || offset < 0 || offset > line.length) return null;
  const above = offset === 0 && line.length > 0;
  if (above && !line.boundary) return null;
  const depth = line.path.length - 1;
  const item = line.path[depth];
  const added: BodyLine = {
    boundary: null,
    start: above ? line.start - 1 : line.start + offset,
    length: 0,
    attrs: { type: "paragraph", ...line.attrs },
    path: [...line.path],
    ids: [],
  };
  if (item && isItem(item.type)) {
    const next = { id: freshId(), type: item.type, starts: {}, changes: new Map() };
    if (!above) {
      added.path[depth] = next;
      for (let later = at + 1; lines[later]?.path[depth] === item; later++)
        lines[later]!.path[depth] = next;
    } else if (lines[at - 1]?.path[depth] !== item) added.path[depth] = next;
  }
  lines.splice(above ? at : at + 1, 0, added);
  return writesOf(schema, doc, lines, freshId, added);
}

/**
 * Join a line to the one above: delete the lower line's boundary, or the upper line's when the
 * upper line is empty.
 */
export function joinLine(schema: Schema, doc: Y.Doc, at: number): BodyWrites | null {
  const lines = readBody(schema, doc);
  const lower = lines[at];
  const upper = lines[at - 1];
  if (!lower?.boundary || !upper) return null;
  const gone = upper.boundary && upper.length === 0 ? upper : lower;
  return { records: new Map(), attributes: new Map(), removed: gone.start - 1 };
}

/** Change a line's kind: its `type`, and the attributes of that kind, on the same boundary. */
export function setLineKind(
  schema: Schema,
  doc: Y.Doc,
  at: number,
  kind: SequenceAttrs,
): BodyWrites | null {
  const line = readBody(schema, doc)[at];
  if (!line?.boundary) return null;
  const changed = Object.entries(kind).filter(([key, value]) => !same(line.attrs[key], value));
  if (changed.length === 0) return null;
  return {
    records: new Map(),
    attributes: new Map([[line.boundary, Object.fromEntries(changed)]]),
  };
}

/**
 * Wrap `count` neighbouring blocks, starting with the one that holds line `at` at `depth`, in a
 * new quote, callout or list. In a list each block becomes one item.
 */
export function wrapBlocks(
  schema: Schema,
  doc: Y.Doc,
  at: number,
  depth: number,
  count: number,
  type: string,
  attrs: SequenceAttrs,
  freshId: () => string,
): BodyWrites | null {
  const lines = readBody(schema, doc);
  const line = lines[at];
  if (!line || depth > line.path.length || isList(line.path[depth - 1]?.type)) return null;
  const make = (made: string, starts: SequenceAttrs): BodyContainer => ({
    id: freshId(),
    type: made,
    starts,
    changes: new Map(),
  });
  const { blocks, own } = blocksAround(lines, at, depth);
  const wrap = make(type, attrs);
  for (const block of blocks.slice(own, own + count)) {
    const around = isList(type) ? [wrap, make(ITEM_OF_LIST[type]!, {})] : [wrap];
    for (let index = block.from; index <= block.to; index++)
      lines[index]!.path.splice(depth, 0, ...around);
  }
  return writesOf(schema, doc, lines, freshId);
}

/**
 * Lift `count` neighbouring blocks, starting with the one that holds line `at` at `depth`, out of
 * the quote or callout around them, or out of their list when the blocks are its items. What the
 * container holds after them goes to a container with a fresh id and the same records.
 */
export function liftBlocks(
  schema: Schema,
  doc: Y.Doc,
  at: number,
  depth: number,
  count: number,
  freshId: () => string,
): BodyWrites | null {
  const lines = readBody(schema, doc);
  const line = lines[at];
  const around = line?.path[depth - 1];
  if (!line || !around || isItem(around.type)) return null;
  const levels = isList(around.type) ? 2 : 1;
  if (line.path.length < depth - 1 + levels) return null;
  const { blocks, own } = blocksAround(lines, at, depth);
  for (const block of blocks.slice(own, own + count))
    for (let index = block.from; index <= block.to; index++)
      lines[index]!.path.splice(depth - 1, levels);
  return writesOf(schema, doc, lines, freshId);
}

/**
 * Indent the list item that holds line `at` at `depth`: it goes under the item above it, into
 * that item's last list, or into a new list of its own list's kind.
 */
export function indentItem(
  schema: Schema,
  doc: Y.Doc,
  at: number,
  depth: number,
  freshId: () => string,
): BodyWrites | null {
  const lines = readBody(schema, doc);
  const list = lines[at]?.path[depth - 1];
  if (!list || !isList(list.type) || !lines[at]!.path[depth]) return null;
  const { blocks, own } = blocksAround(lines, at, depth);
  const above = lines[blocks[own - 1]?.to ?? -1]?.path;
  if (!above?.[depth]) return null;
  const nested = isList(above[depth + 1]?.type)
    ? above[depth + 1]!
    : { id: freshId(), type: list.type, starts: {}, changes: new Map() };
  for (let index = blocks[own]!.from; index <= blocks[own]!.to; index++)
    lines[index]!.path.splice(depth, 0, above[depth], nested);
  return writesOf(schema, doc, lines, freshId);
}

/**
 * Outdent the list item that holds line `at` at `depth`: it becomes an item of the list its
 * parent item is in, and the items after it in its own list go under it.
 */
export function outdentItem(
  schema: Schema,
  doc: Y.Doc,
  at: number,
  depth: number,
  freshId: () => string,
): BodyWrites | null {
  const lines = readBody(schema, doc);
  const path = lines[at]?.path ?? [];
  const item = path[depth];
  if (!item || !isList(path[depth - 1]?.type) || !isList(path[depth - 3]?.type)) return null;
  const { blocks, own } = blocksAround(lines, at, depth);
  for (let index = blocks[own]!.from; index <= blocks[own]!.to; index++)
    lines[index]!.path.splice(depth - 2, 2);
  for (const block of blocks.slice(own + 1))
    for (let index = block.from; index <= block.to; index++) lines[index]!.path[depth - 2] = item;
  return writesOf(schema, doc, lines, freshId);
}

/**
 * Change the kind of the container that holds line `at` at `depth`, to a kind it can become: a
 * quote or a callout, or one of the three lists. A list's items take the new list's item kind.
 */
export function setContainerKind(
  schema: Schema,
  doc: Y.Doc,
  at: number,
  depth: number,
  type: string,
  freshId: () => string,
): BodyWrites | null {
  const lines = readBody(schema, doc);
  const stored = doc.getMap(BODY_CONTAINERS_FIELD);
  const container = lines[at]?.path[depth];
  if (!container) return null;
  const changed = [container];
  if (stored.get(container.id) !== type) container.changes.set("", type);
  if (isList(type))
    for (const block of blocksAround(lines, at, depth + 1).blocks) {
      const item = lines[block.from]!.path[depth + 1];
      if (!item || stored.get(item.id) === ITEM_OF_LIST[type]) continue;
      item.changes.set("", ITEM_OF_LIST[type]);
      changed.push(item);
    }
  if (changed.every((each) => each.changes.size === 0)) return null;
  return writesOf(schema, doc, lines, freshId);
}

/** Change attributes of the container that holds line `at` at `depth`. */
export function setContainerAttributes(
  schema: Schema,
  doc: Y.Doc,
  at: number,
  depth: number,
  attrs: SequenceAttrs,
  freshId: () => string,
): BodyWrites | null {
  const lines = readBody(schema, doc);
  const stored = doc.getMap(BODY_CONTAINERS_FIELD);
  const container = lines[at]?.path[depth];
  if (!container) return null;
  for (const [name, value] of Object.entries(attrs))
    if (!same(stored.get(`${container.id}.${name}`), value)) container.changes.set(name, value);
  if (container.changes.size === 0) return null;
  return writesOf(schema, doc, lines, freshId);
}

function formattingAt(sequence: Y.Text, index: number): Record<string, unknown> {
  const marks = new Map<string, unknown>();
  let passed = 0;
  for (let item = sequence._start; item !== null && passed < index; item = item.right) {
    if (item.deleted) continue;
    if (item.content instanceof Y.ContentFormat) {
      if (item.content.value === null) marks.delete(item.content.key);
      else marks.set(item.content.key, item.content.value);
    } else if (item.countable) passed += item.length;
  }
  return Object.fromEntries(marks);
}

/** Write one change. Call it inside one transaction that has the writer's own origin. */
export function writeBody(doc: Y.Doc, writes: BodyWrites): void {
  const sequence = doc.getText(BODY_SEQUENCE_FIELD);
  const records = doc.getMap(BODY_CONTAINERS_FIELD);
  for (const [key, value] of writes.records) records.set(key, value);
  for (const [boundary, attrs] of writes.attributes)
    for (const [key, value] of Object.entries(attrs))
      boundary.setAttribute(key, value as unknown as string);
  if (writes.removed !== undefined) sequence.delete(writes.removed, 1);
  if (!writes.added) return;
  const boundary = new Y.XmlElement(BLOCK_ELEMENT);
  for (const [key, value] of Object.entries(writes.added.attrs))
    boundary.setAttribute(key, value as unknown as string);
  const { index } = writes.added;
  sequence.insertEmbed(index, boundary, formattingAt(sequence, index));
}

/**
 * The undo history of one writer of a note's body. It follows `origin` only, puts an earlier
 * value back over someone else's later one, and never deletes a container record.
 */
export function bodyHistory(doc: Y.Doc, origin: unknown, captureTimeout?: number): Y.UndoManager {
  const records = doc.getMap(BODY_CONTAINERS_FIELD);
  return new Y.UndoManager([doc.getText(BODY_SEQUENCE_FIELD), records], {
    trackedOrigins: new Set([origin]),
    ignoreRemoteMapChanges: true,
    deleteFilter: (item) => item.parent !== records,
    ...(captureTimeout === undefined ? {} : { captureTimeout }),
  });
}
