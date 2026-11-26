import type { Node as ProseMirrorNode, Schema } from "@tiptap/pm/model";
import * as Y from "yjs";
import {
  fitLeaf,
  leavesOfSequence,
  readBodyLeaves,
  type SequenceAttrs,
  type SequenceBoundary,
  type SequenceFrame,
  type SequencePiece,
} from "./bodySequenceGrammar.js";
import {
  storedValue,
  BLOCK_ELEMENT,
  BODY_CONTAINERS_FIELD,
  BODY_SEQUENCE_FIELD,
} from "./bodySequenceStore.js";

type StoredList = { readonly _start: Y.Item | null };

function attributesOf(element: Y.XmlElement): SequenceAttrs {
  return Object.fromEntries(
    [...element._map.keys()].map((key): [string, unknown] => [key, storedValue(element, key)]),
  );
}

/** The block element a stored item holds, when the item is the live start of a block. */
export function boundaryOf(item: Y.Item): Y.XmlElement | null {
  const content = item.content;
  return !item.deleted &&
    content instanceof Y.ContentType &&
    content.type instanceof Y.XmlElement &&
    content.type.nodeName === BLOCK_ELEMENT
    ? content.type
    : null;
}

/**
 * Calls `visit` for each piece from the item `first` up to the item `end`, with the number of
 * sequence positions between `first` and the piece, and the item it was read from. `marks` is the
 * formatting in force at `first`; afterwards it is the formatting in force at `end`.
 *
 * It reads the stored items, not Yjs's delta, which shows an embedded string as text and builds
 * its attributes on an object a key named `__proto__` can reshape.
 */
export function visitPieces(
  first: Y.Item | null,
  end: Y.Item | null,
  marks: Map<string, unknown>,
  markNames: ReadonlySet<string> | undefined,
  visit: (piece: SequencePiece, offset: number, item: Y.Item) => void,
): void {
  let offset = 0;
  for (let item = first; item !== null && item !== end; item = item.right) {
    if (item.deleted) continue;
    const content = item.content;
    if (content instanceof Y.ContentFormat) {
      if (!markNames || markNames.has(content.key)) marks.set(content.key, content.value);
      continue;
    }
    if (content instanceof Y.ContentString)
      visit({ text: content.str, marks: Object.fromEntries(marks) }, offset, item);
    else if (content instanceof Y.ContentType && content.type instanceof Y.XmlElement) {
      const attrs = attributesOf(content.type);
      visit(
        content.type.nodeName === BLOCK_ELEMENT
          ? { boundary: attrs }
          : { atom: content.type.nodeName, attrs },
        offset,
        item,
      );
    }
    offset += item.length;
  }
}

/**
 * The pieces of a body sequence, in order: boundaries, letters with their marks, and inline items.
 * With `markNames`, formatting under any other key is left out.
 */
export function piecesOfSequence(
  sequence: StoredList,
  markNames?: ReadonlySet<string>,
): SequencePiece[] {
  const pieces: SequencePiece[] = [];
  visitPieces(sequence._start, null, new Map(), markNames, (piece) => pieces.push(piece));
  return pieces;
}

/**
 * Each live boundary of a format-2 note, in order, with the containers the reader places its line
 * in, outermost first, each with the type the reader gives it, and the type its line reads as.
 * Declares no root.
 */
export function placedBoundaries(
  schema: Schema,
  doc: Y.Doc,
): { item: Y.Item; path: SequenceFrame[]; leaf: string }[] {
  const items: Y.Item[] = [];
  const boundaries: SequenceBoundary[] = [];
  visitPieces(
    doc.share.get(BODY_SEQUENCE_FIELD)?._start ?? null,
    null,
    new Map(),
    new Set(),
    (piece, _offset, item) => {
      if (!("boundary" in piece)) return;
      items.push(item);
      boundaries.push(piece);
    },
  );
  const records = doc.share.get(BODY_CONTAINERS_FIELD);
  return leavesOfSequence(schema, boundaries, { get: (key) => storedValue(records, key) }).map(
    (leaf, at) => {
      const { path, type } = fitLeaf(schema, leaf);
      return { item: items[at]!, path: path.map(({ frame }) => frame), leaf: type.name };
    },
  );
}

/**
 * The document a format-2 note's Yjs document stands for. It declares no root: Yjs deletes
 * formatting on its own in a document where the sequence is a declared text, so a document that
 * will take more changes is read as stored.
 */
export function readBodySequence(schema: Schema, doc: Y.Doc): ProseMirrorNode {
  const sequence = doc.share.get(BODY_SEQUENCE_FIELD);
  const records = doc.share.get(BODY_CONTAINERS_FIELD);
  return readBodyLeaves(
    schema,
    leavesOfSequence(
      schema,
      sequence ? piecesOfSequence(sequence, new Set(Object.keys(schema.marks))) : [],
      { get: (key) => storedValue(records, key) },
    ),
  );
}
