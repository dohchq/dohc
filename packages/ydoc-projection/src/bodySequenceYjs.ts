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

/**
 * The pieces of a body sequence, in order: boundaries, letters with their marks, and inline items.
 * It reads the stored items, not Yjs's delta, which shows an embedded string as text and builds
 * its attributes on an object a key named `__proto__` can reshape. With `markNames`, formatting
 * under any other key is left out.
 */
export function piecesOfSequence(
  sequence: Y.Text,
  markNames?: ReadonlySet<string>,
): SequencePiece[] {
  const pieces: SequencePiece[] = [];
  const marks = new Map<string, unknown>();
  for (let item = sequence._start; item !== null; item = item.right) {
    if (item.deleted) continue;
    const content = item.content;
    if (content instanceof Y.ContentFormat) {
      if (!markNames || markNames.has(content.key)) marks.set(content.key, content.value);
    } else if (content instanceof Y.ContentString)
      pieces.push({ text: content.str, marks: Object.fromEntries(marks) });
    else if (content instanceof Y.ContentType && content.type instanceof Y.XmlElement) {
      const attrs = attributesOf(content.type);
      pieces.push(
        content.type.nodeName === BLOCK_ELEMENT
          ? { boundary: attrs }
          : { atom: content.type.nodeName, attrs },
      );
    }
  }
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
