import type { Node as ProseMirrorNode, Schema } from "@tiptap/pm/model";
import * as Y from "yjs";
import {
  BLOCK_ELEMENT,
  BODY_CONTAINERS_FIELD,
  BODY_SEQUENCE_FIELD,
  leavesOfSequence,
  readBodyLeaves,
  type SequenceAttrs,
  type SequencePiece,
} from "./bodySequenceGrammar.js";

/**
 * The value stored under a key of a shared type: the last value of a live item that holds plain
 * values. An item of any other kind holds none, because Yjs and yrs read such an item differently.
 */
export function storedValue(holder: { _map: Map<string, Y.Item> }, key: string): unknown {
  const item = holder._map.get(key);
  return item && !item.deleted && item.content instanceof Y.ContentAny
    ? item.content.arr.at(-1)
    : undefined;
}

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
  sequence: Y.Text,
  markNames?: ReadonlySet<string>,
): SequencePiece[] {
  const pieces: SequencePiece[] = [];
  visitPieces(sequence._start, null, new Map(), markNames, (piece) => pieces.push(piece));
  return pieces;
}

/** The document a format-2 note's Yjs document stands for. */
export function readBodySequence(schema: Schema, doc: Y.Doc): ProseMirrorNode {
  const containers = doc.getMap(BODY_CONTAINERS_FIELD);
  return readBodyLeaves(
    schema,
    leavesOfSequence(
      schema,
      piecesOfSequence(doc.getText(BODY_SEQUENCE_FIELD), new Set(Object.keys(schema.marks))),
      { get: (key) => storedValue(containers, key) },
    ),
  );
}
