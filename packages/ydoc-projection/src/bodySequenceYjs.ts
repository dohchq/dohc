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

function attributesOf(element: Y.XmlElement): SequenceAttrs {
  const entries: [string, unknown][] = [];
  element._map.forEach((item, key) => {
    if (!item.deleted) entries.push([key, item.content.getContent()[item.length - 1]]);
  });
  return Object.fromEntries(entries);
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
  return readBodyLeaves(
    schema,
    leavesOfSequence(
      schema,
      piecesOfSequence(doc.getText(BODY_SEQUENCE_FIELD), new Set(Object.keys(schema.marks))),
      doc.getMap(BODY_CONTAINERS_FIELD),
    ),
  );
}
