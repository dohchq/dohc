import type { Node as ProseMirrorNode, Schema } from "@tiptap/pm/model";
import * as Y from "yjs";
import {
  attrsFor,
  leavesOfSequence,
  placeLeaves,
  readLeaf,
  type ContainerRecords,
  type LeafBlock,
  type ReadLeaf,
  type SequenceBoundary,
  type SequenceInline,
} from "./bodySequenceGrammar.js";
import { boundaryOf, visitPieces } from "./bodySequenceYjs.js";
import { storedValue } from "./bodySequenceStore.js";

/**
 * A letter run or an inline item the editor shows. `index` is its sequence position counted from
 * the start of its line, and `element` the element behind an inline item.
 */
export type ShownPiece = SequenceInline & { index: number; element: SequenceElement | null };

/** An element of the sequence: a block's boundary or an inline item, with the values Yjs stores. */
export type SequenceElement = Y.XmlElement<
  Record<string, object | string | number | boolean | null>
>;

type Marks = ReadonlyMap<string, unknown>;

type SequenceLine = {
  item: Y.Item | null;
  element: SequenceElement | null;
  length: number;
  /** The formatting in force where the line starts, and where it ends. */
  marks: Marks;
  endMarks: Marks;
  read: ReadLeaf<ShownPiece> | null;
  order: number;
  touched: boolean;
};

/**
 * What the sequence reads as, and the sequence positions behind each block of it. For the block at
 * one index: `starts` has where it starts in the document, `paths` the ids of the containers it
 * sits in, `lines` its line, and `bases` the sequence position where that line starts. A line is
 * one boundary and what follows it up to the next. The line before the first boundary has no
 * element. A block the reader added has the line its boundary would stand in front of.
 */
export type BodyReading = {
  doc: ProseMirrorNode;
  blocks: LeafBlock<ShownPiece>[];
  starts: number[];
  paths: (readonly string[])[];
  lines: (SequenceLine | null)[];
  bases: number[];
  firsts: number[] | null;
};

/** One sequence item the editor shows: a block's boundary when `piece` is null, else one position of a piece. */
export type SequenceToken = { index: number; block: number; piece: ShownPiece | null };

type SequenceChange = {
  /**
   * The Yjs transactions whose changes the note's document holds and the reader has not read,
   * oldest first. Yjs applies a transaction's changes before it tells of them, so there can be
   * several. Without any, only touched lines are read again.
   */
  transactions?: readonly Y.Transaction[];
  /** Sequence positions from before those transactions, ascending, to find again after them. */
  follow?: readonly number[];
};

/** Where a followed position is after a change, and whether its item is still there. */
export type Followed = { index: number; alive: boolean };

export type BodyReader = ReturnType<typeof createBodyReader>;

const NO_MARKS: Marks = new Map();

const NO_CHANGE: SequenceChange = {};

function sameMarks(one: Marks, other: Marks): boolean {
  if (one === other) return true;
  if (one.size !== other.size) return false;
  for (const [key, value] of one) if (!other.has(key) || other.get(key) !== value) return false;
  return true;
}

/** How many of some ascending numbers are below a value. */
export function countBelow(sorted: readonly number[], value: number): number {
  let low = 0;
  let high = sorted.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (sorted[middle]! < value) low = middle + 1;
    else high = middle;
  }
  return low;
}

function replacedAt(doc: ProseMirrorNode, pos: number, node: ProseMirrorNode): ProseMirrorNode {
  const $pos = doc.resolve(pos);
  let made = node;
  for (let depth = $pos.depth; depth >= 0; depth--) {
    const parent = $pos.node(depth);
    made = parent.copy(parent.content.replaceChild($pos.index(depth), made));
  }
  return made;
}

const contentSize = (node: ProseMirrorNode) => (node.isTextblock ? node.content.size : 0);
const sizeOf = (piece: ShownPiece) => ("text" in piece ? piece.text.length : 1);

/** The sequence position of a block's boundary, or -1 for a block with no boundary of its own. */
export function boundaryAt(reading: BodyReading, block: number): number {
  const line = reading.lines[block];
  return line?.element && line.read?.own === reading.blocks[block] ? reading.bases[block]! : -1;
}

/** The element of a block's boundary, or null for a block with no boundary of its own. */
export function boundaryElement(reading: BodyReading, block: number): SequenceElement | null {
  return boundaryAt(reading, block) < 0 ? null : reading.lines[block]!.element;
}

/** Whether a block is a paragraph the reader added in front of a list item's content. */
export function isAddedParagraph(reading: BodyReading, block: number): boolean {
  const read = reading.lines[block]?.read;
  const shown = reading.blocks[block];
  return read !== null && read !== undefined && read.own !== shown && read.after !== shown;
}

/**
 * For a document position at the start of a block with no boundary of its own: the sequence
 * position of what follows it, which holds that place. That is the block's first item, or for a
 * paragraph the reader added, the boundary of the block it stands in front of. Else -1.
 */
export function whatFollowsStartOf(reading: BodyReading, pos: number): number {
  const block = blockHolding(reading, pos);
  if (block < 0 || pos !== reading.starts[block]! + 1 || boundaryAt(reading, block) >= 0) return -1;
  const first = reading.blocks[block]!.shown[0];
  if (first) return reading.bases[block]! + first.index;
  return isAddedParagraph(reading, block) ? reading.bases[block]! : -1;
}

/**
 * The document position a place held by `whatFollowsStartOf` has now: just before the item. A
 * boundary holds the place in the paragraph the reader added to its list item, which is the
 * item's first block: the place is that paragraph's end, also once someone has typed in it and
 * whatever was put between it and the boundary since. When the boundary's block has become the
 * item's first, the place is that block's start. -1 when no item is shown at that sequence
 * position.
 */
export function startBefore(reading: BodyReading, index: number): number {
  const shown = positionOf(reading, index);
  const block = shown < 0 ? -1 : blockStartingAt(reading, shown);
  if (block < 0) return shown;
  const path = reading.paths[block]!;
  const frames = reading.lines[block]?.read?.leaf.path ?? [];
  let item = path.length - 1;
  while (item >= 0 && frames[item]?.type !== "listItem" && frames[item]?.type !== "taskItem")
    item--;
  if (item < 0) return shown + 1;
  const inItem = (other: number) =>
    reading.paths[other]!.length > item &&
    reading.paths[other]!.every((id, depth) => depth > item || id === path[depth]);
  let first = block;
  while (first > 0 && inItem(first - 1)) first--;
  const node = reading.blocks[first]!.node;
  return first < block && node.type.name === "paragraph"
    ? reading.starts[first]! + 1 + node.content.size
    : shown + 1;
}

/** The index of the block that starts at a document position, or -1. */
export function blockStartingAt(reading: BodyReading, pos: number): number {
  const block = countBelow(reading.starts, pos);
  return reading.starts[block] === pos ? block : -1;
}

/** The index of the text block whose content holds a document position, or -1. */
export function blockHolding(reading: BodyReading, pos: number): number {
  const block = countBelow(reading.starts, pos) - 1;
  if (block < 0) return -1;
  const node = reading.blocks[block]!.node;
  return node.isTextblock && pos <= reading.starts[block]! + 1 + node.content.size ? block : -1;
}

/** The token at one content offset of a block. */
export function tokenIn(reading: BodyReading, block: number, offset: number): SequenceToken {
  let at = 0;
  for (const piece of reading.blocks[block]!.shown) {
    const size = sizeOf(piece);
    if (offset < at + size)
      return { index: reading.bases[block]! + piece.index + offset - at, block, piece };
    at += size;
  }
  throw new RangeError(`Block ${String(block)} shows nothing at offset ${String(offset)}.`);
}

/** The last sequence item shown before a document position, or null. */
export function tokenBefore(reading: BodyReading, pos: number): SequenceToken | null {
  for (let block = countBelow(reading.starts, pos) - 1; block >= 0; block--) {
    const within = Math.min(
      pos - reading.starts[block]! - 1,
      contentSize(reading.blocks[block]!.node),
    );
    if (within > 0) return tokenIn(reading, block, within - 1);
    const boundary = boundaryAt(reading, block);
    if (boundary >= 0) return { index: boundary, block, piece: null };
  }
  return null;
}

/** The first sequence item shown at or after a document position, or null. */
export function tokenFrom(reading: BodyReading, pos: number): SequenceToken | null {
  const first = Math.max(0, countBelow(reading.starts, pos + 1) - 1);
  for (let block = first; block < reading.blocks.length; block++) {
    const start = reading.starts[block]!;
    if (pos <= start) {
      const boundary = boundaryAt(reading, block);
      if (boundary >= 0) return { index: boundary, block, piece: null };
    }
    const offset = Math.max(0, pos - start - 1);
    if (offset < contentSize(reading.blocks[block]!.node)) return tokenIn(reading, block, offset);
  }
  return null;
}

/** The sequence position where something put at a document position goes: just after the item before it. */
export function indexAt(reading: BodyReading, pos: number): number {
  return (tokenBefore(reading, pos)?.index ?? -1) + 1;
}

function firstsOf(reading: BodyReading): number[] {
  reading.firsts ??= reading.blocks.map((block, at) => {
    const boundary = boundaryAt(reading, at);
    if (boundary >= 0) return boundary;
    return reading.bases[at]! + (block.shown[0]?.index ?? 0);
  });
  return reading.firsts;
}

/** Where the shown item at a sequence position stands in the document, or -1 when none is shown there. */
export function positionOf(reading: BodyReading, index: number): number {
  for (let block = countBelow(firstsOf(reading), index + 1) - 1; block >= 0; block--) {
    if (boundaryAt(reading, block) === index) return reading.starts[block]!;
    let at = 0;
    for (const piece of reading.blocks[block]!.shown) {
      const from = reading.bases[block]! + piece.index;
      const size = sizeOf(piece);
      if (index >= from && index < from + size)
        return reading.starts[block]! + 1 + at + index - from;
      at += size;
    }
    if (boundaryAt(reading, block) >= 0 || reading.blocks[block]!.shown.length > 0) return -1;
  }
  return -1;
}

/** The document position for a sequence position: just after the last item shown before it. */
export function positionAt(reading: BodyReading, index: number): number {
  for (let block = countBelow(firstsOf(reading), index) - 1; block >= 0; block--) {
    const base = reading.bases[block]!;
    let at = 0;
    let after = -1;
    for (const piece of reading.blocks[block]!.shown) {
      const from = base + piece.index;
      if (from >= index) break;
      const size = sizeOf(piece);
      after = at + Math.min(size, index - from);
      at += size;
    }
    if (after >= 0) return reading.starts[block]! + 1 + after;
    if (boundaryAt(reading, block) >= 0) return reading.starts[block]! + 1;
  }
  return boundaryAt(reading, 0) >= 0 ? reading.starts[0]! : reading.starts[0]! + 1;
}

const NO_PATH: readonly string[] = [];

/** The ids of the containers around a document position, outermost first. */
export function pathAt(reading: BodyReading, pos: number): readonly string[] {
  const holder = blockHolding(reading, pos);
  if (holder >= 0) return reading.paths[holder]!;
  const $pos = reading.doc.resolve(pos);
  if ($pos.depth === 0) return NO_PATH;
  const from = $pos.start();
  const to = $pos.end();
  const inside = (block: number) => reading.starts[block]! >= from && reading.starts[block]! < to;
  const before = countBelow(reading.starts, pos) - 1;
  const block = before >= 0 && inside(before) ? before : before + 1;
  return block < reading.blocks.length && inside(block)
    ? reading.paths[block]!.slice(0, $pos.depth)
    : NO_PATH;
}

/**
 * Reads a note's sequence as the editor's document, again after each change, building anew only
 * the lines the change reached. What it reads is what `readBodySequence` reads.
 */
export function createBodyReader(schema: Schema, sequence: Y.Text, containers: Y.Map<unknown>) {
  const markNames: ReadonlySet<string> = new Set(Object.keys(schema.marks));
  const known = new WeakMap<Y.XmlElement, SequenceLine>();
  const records: ContainerRecords = { get: (key) => storedValue(containers, key) };
  let lines: SequenceLine[] = [];
  let reading: BodyReading | null = null;
  let stale = true;
  const changedRecords = new Set<string>();
  let touched: SequenceLine[] = [];

  const touch = (line: SequenceLine) => {
    if (line.touched) return;
    line.touched = true;
    touched.push(line);
  };

  const lineOf = (item: Y.Item | null): SequenceLine | undefined => {
    const element = item && boundaryOf(item);
    const line = element ? known.get(element) : lines[0];
    return line && lines[line.order] === line ? line : undefined;
  };

  const touchLineHolding = (item: Y.Item) => {
    for (let at: Y.Item | null = item; at !== null; at = at.left) {
      const line = boundaryOf(at) ? lineOf(at) : undefined;
      if (line) return touch(line);
    }
    if (lines[0]) touch(lines[0]);
  };

  const build = (item: Y.Item | null, start: Marks, was: SequenceLine | undefined) => {
    const first = item ?? sequence._start;
    let end = item ? item.right : first;
    let length = item ? 1 : 0;
    let formats = 0;
    for (; end !== null && boundaryOf(end) === null; end = end.right) {
      if (end.deleted) continue;
      if (!(end.content instanceof Y.ContentFormat)) length += end.length;
      else if (markNames.has(end.content.key)) formats += 1;
    }
    const marks = new Map(start);
    const pieces: (SequenceBoundary | ShownPiece)[] = [];
    visitPieces(first, end, marks, markNames, (piece, index, from) => {
      if ("boundary" in piece) pieces.push(piece);
      else {
        const content = from.content;
        const behind =
          content instanceof Y.ContentType && content.type instanceof Y.XmlElement
            ? content.type
            : null;
        pieces.push({ ...piece, index, element: behind });
      }
    });
    const [leaf] = leavesOfSequence(schema, pieces, records);
    const read = leaf ? readLeaf(schema, leaf) : null;
    if (read && was?.read) {
      const before = was.read;
      if (read.own.node.eq(before.own.node)) read.own.node = before.own.node;
      if (read.after && before.after && read.after.node.eq(before.after.node))
        read.after.node = before.after.node;
    }
    const element = item && boundaryOf(item);
    const line: SequenceLine = {
      item,
      element,
      length,
      marks: start,
      endMarks: formats > 0 ? marks : start,
      read,
      order: 0,
      touched: false,
    };
    if (element) known.set(element, line);
    return { line, next: end };
  };

  const refit = (line: SequenceLine, ids?: ReadonlySet<string>) => {
    const leaf = line.read?.leaf;
    if (!leaf || !Object.hasOwn(leaf.attrs, "path")) return;
    if (!Array.isArray(leaf.attrs.path) || leaf.attrs.path.length === 0) return;
    if (ids && !leaf.attrs.path.some((id: unknown) => ids.has(id as string))) return;
    const [again] = leavesOfSequence<ShownPiece>(schema, [{ boundary: leaf.attrs }], records);
    line.read = { ...line.read!, leaf: { ...leaf, path: again!.path } };
  };

  const ownersOfAttributes = (keys: ReadonlySet<string>): Set<string> | null => {
    const ids = new Set<string>();
    for (const key of keys) {
      const dot = key.indexOf(".");
      if (dot < 0) return null;
      ids.add(key.slice(0, dot));
    }
    return ids;
  };

  const frameAt = (now: BodyReading, block: number, depth: number) =>
    now.lines[block]?.read?.leaf.path[depth];

  const isContainerOfBlockBefore = (now: BodyReading, block: number, depth: number) => {
    const above = now.paths[block - 1];
    const path = now.paths[block]!;
    if (!above || above.length <= depth) return false;
    for (let outer = 0; outer <= depth; outer++) if (above[outer] !== path[outer]) return false;
    return frameAt(now, block - 1, depth)?.type === frameAt(now, block, depth)?.type;
  };

  const refreshContainers = (now: BodyReading, ids: ReadonlySet<string>) => {
    let doc = now.doc;
    for (let block = 0; block < now.blocks.length; block++) {
      const path = now.paths[block]!;
      for (let depth = 0; depth < path.length; depth++) {
        if (!ids.has(path[depth]!) || isContainerOfBlockBefore(now, block, depth)) continue;
        const frame = frameAt(now, block, depth);
        const pos = doc.resolve(now.starts[block]!).before(depth + 1);
        const node = doc.nodeAt(pos)!;
        const attrs = frame ? attrsFor(node.type, frame.attrs) : node.attrs;
        if (!node.hasMarkup(node.type, attrs, node.marks))
          doc = replacedAt(doc, pos, node.type.create(attrs, node.content, node.marks));
      }
    }
    now.doc = doc;
  };

  const place = (): BodyReading => {
    const read: ReadLeaf<ShownPiece>[] = [];
    const from: SequenceLine[] = [];
    const at: number[] = [];
    let index = 0;
    for (const line of lines) {
      if (line.read) {
        read.push(line.read);
        from.push(line);
        at.push(index);
      }
      index += line.length;
    }
    const placed = placeLeaves(schema, read);
    const count = placed.leaves.length;
    const placedLines = new Array<SequenceLine | null>(count);
    const bases = new Array<number>(count);
    for (let block = 0; block < count; block++) {
      const leaf = placed.leaves[block]!;
      placedLines[block] = from[leaf] ?? null;
      bases[block] = at[leaf] ?? 0;
    }
    return {
      doc: placed.doc,
      blocks: placed.blocks,
      starts: placed.starts,
      paths: placed.paths,
      lines: placedLines,
      bases,
      firsts: null,
    };
  };

  const replaceLineInPlace = (now: BodyReading, was: SequenceLine, line: SequenceLine): boolean => {
    const before = was.read;
    const after = line.read;
    if (!before || !after) return before === after && was.length === line.length;
    if (before.own.node.type !== after.own.node.type) return false;
    if ((before.after === null) !== (after.after === null)) return false;
    const path = after.leaf.path;
    if (path.length !== before.leaf.path.length) return false;
    for (let depth = 0; depth < path.length; depth++)
      if (path[depth]!.id !== before.leaf.path[depth]!.id) return false;
    const first = now.lines.indexOf(was);
    const own = first < 0 ? -1 : now.blocks.indexOf(before.own, first);
    if (own < 0 || (before.after && now.blocks[own + 1] !== before.after)) return false;

    const moved = line.length - was.length;
    let grown = 0;
    let doc = now.doc;
    const put = (block: number, next: LeafBlock<ShownPiece>) => {
      const old = now.blocks[block]!.node;
      now.starts[block]! += grown;
      if (old !== next.node) {
        doc = replacedAt(doc, now.starts[block]!, next.node);
        grown += next.node.nodeSize - old.nodeSize;
      }
      now.blocks[block] = next;
    };
    put(own, after.own);
    if (after.after) put(own + 1, after.after);
    const last = after.after ? own + 1 : own;
    for (let block = first; block <= last; block++)
      if (now.lines[block] === was) now.lines[block] = line;
    if (grown !== 0 || moved !== 0)
      for (let block = last + 1; block < now.starts.length; block++) {
        now.starts[block]! += grown;
        now.bases[block]! += moved;
      }
    now.doc = doc;
    now.firsts = null;
    return true;
  };

  const note = (transactions: readonly Y.Transaction[]): void => {
    const first = transactions[0];
    if (!first) return;
    const seen = (struct: Y.Item | Y.GC) => {
      if (!(struct instanceof Y.Item)) return;
      const parent = struct.parent;
      if (parent === sequence) touchLineHolding(struct);
      else if (parent === containers && struct.parentSub !== null)
        changedRecords.add(struct.parentSub);
      else if (parent instanceof Y.XmlElement && parent._item?.parent === sequence)
        touchLineHolding(parent._item);
    };
    const store = sequence.doc!.store;
    const added = Y.createDeleteSet();
    for (const client of store.clients.keys()) {
      const from = first.beforeState.get(client) ?? 0;
      const to = Y.getState(store, client);
      if (to > from) added.clients.set(client, [{ clock: from, len: to - from }]);
    }
    Y.iterateDeletedStructs(first, added, seen);
    for (const transaction of transactions)
      Y.iterateDeletedStructs(transaction, transaction.deleteSet, seen);
    stale = true;
  };

  const basesOf = (all: readonly SequenceLine[]): number[] => {
    const bases: number[] = [];
    let index = 0;
    for (const line of all) {
      bases.push(index);
      index += line.length;
    }
    bases.push(index);
    return bases;
  };

  const followPositions = (follow: readonly number[], transactions: readonly Y.Transaction[]) => {
    const before = transactions[0]!.beforeState;
    const deleted = Y.mergeDeleteSets(transactions.map((transaction) => transaction.deleteSet));
    const added = (item: Y.Item) => item.id.clock >= (before.get(item.id.client) ?? 0);
    const stood = (item: Y.Item) =>
      !added(item) && (!item.deleted || Y.isDeleted(deleted, item.id));
    const bases = basesOf(lines);
    const found = follow.map((index) => {
      const order = countBelow(bases, index + 1) - 1;
      const line = lines[order];
      if (!line) return null;
      let left = index - bases[order]!;
      for (let item = line.item ?? sequence._start; item !== null; item = item.right) {
        if (item.content instanceof Y.ContentFormat || !stood(item)) continue;
        if (left < item.length) return { item, inside: left };
        left -= item.length;
      }
      return null;
    });
    return (): Followed[] => {
      const now = basesOf(lines);
      return found.map((place) => {
        if (!place) return { index: now.at(-1)!, alive: false };
        const { item, inside } = place;
        if (boundaryOf(item)) return { index: now[lineOf(item)?.order ?? 0]!, alive: true };
        const alive = !item.deleted;
        let passed = alive ? inside : 0;
        let at = item.left;
        for (; at !== null && boundaryOf(at) === null; at = at.left)
          if (!at.deleted && !(at.content instanceof Y.ContentFormat)) passed += at.length;
        return { index: now[lineOf(at)?.order ?? 0]! + (at ? 1 : 0) + passed, alive };
      });
    };
  };

  const rebuildTouched = (now: BodyReading): boolean => {
    const queue = touched
      .filter((line) => lines[line.order] === line)
      .sort((a, b) => a.order - b.order);
    const replaced: [SequenceLine, SequenceLine][] = [];
    for (let at = 0; at < queue.length; at++) {
      const was = queue[at]!;
      const start = was.order === 0 ? NO_MARKS : lines[was.order - 1]!.endMarks;
      const after = lines[was.order + 1];
      const made = build(was.item, start, was);
      if (made.next !== (after?.item ?? null)) return false;
      made.line.order = was.order;
      lines[was.order] = made.line;
      replaced.push([was, made.line]);
      if (after && queue[at + 1] !== after && !sameMarks(made.line.endMarks, after.marks))
        queue.splice(at + 1, 0, after);
    }
    for (const [was, line] of replaced) if (!replaceLineInPlace(now, was, line)) reading = null;
    return true;
  };

  const rebuildAll = (): void => {
    const old = lines;
    const next: SequenceLine[] = [];
    let item: Y.Item | null = null;
    let was: SequenceLine | undefined = old[0];
    let end: Marks = NO_MARKS;
    for (;;) {
      const after: SequenceLine | undefined = was ? old[was.order + 1] : undefined;
      const live = after === undefined || (after.item !== null && boundaryOf(after.item) !== null);
      if (was !== undefined && !was.touched && live && sameMarks(was.marks, end)) {
        next.push(was);
        end = was.endMarks;
        if (!after) break;
        item = after.item;
        was = after;
        continue;
      }
      const made = build(item, end, was);
      next.push(made.line);
      end = made.line.endMarks;
      item = made.next;
      if (item === null) break;
      was = lineOf(item);
    }
    lines = next;
    for (let order = 0; order < next.length; order++) next[order]!.order = order;
    reading = null;
  };

  const read = (change: SequenceChange = NO_CHANGE): Followed[] => {
    const transactions = change.transactions ?? [];
    const follow = transactions.length > 0 && change.follow?.length ? change.follow : null;
    const followed = follow ? followPositions(follow, transactions) : null;
    note(transactions);
    const wrote = changedRecords.size > 0;
    const ids = wrote ? ownersOfAttributes(changedRecords) : null;
    changedRecords.clear();
    if (!reading || (wrote && !ids) || !rebuildTouched(reading)) rebuildAll();
    touched = [];
    if (wrote) for (const line of lines) refit(line, ids ?? undefined);
    if (reading && ids) refreshContainers(reading, ids);
    reading ??= place();
    stale = false;
    return followed ? followed() : [];
  };

  return {
    /** Reads the sequence again. Returns where each followed position went. */
    read,
    /** What the sequence reads as now. */
    reading(): BodyReading {
      if (stale || reading === null) read();
      return reading!;
    },
    /** Says that the sequence positions from `from` to `to` are about to be written. */
    touch(from: number, to: number): void {
      stale = true;
      let at = 0;
      for (const line of lines) {
        if (at > to) break;
        const end = at + line.length;
        if (end > from) touch(line);
        at = end;
      }
    },
    /** Says that the container records under `keys` are about to be written. */
    touchRecords(keys: Iterable<string>): void {
      stale = true;
      for (const key of keys) changedRecords.add(key);
    },
    /** Takes the editor's document for the reading's own, once the two are known to be equal. */
    adopt(doc: ProseMirrorNode): void {
      if (reading) reading.doc = doc;
    },
  };
}
