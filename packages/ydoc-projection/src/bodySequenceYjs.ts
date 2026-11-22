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

type Change = { insert: unknown; attributes?: SequenceAttrs };

/** The pieces of a body sequence, in order: boundaries, letters with their marks, and inline items. */
export function piecesOfSequence(sequence: Y.Text): SequencePiece[] {
  return (sequence.toDelta() as Change[]).flatMap(({ insert, attributes }): SequencePiece[] => {
    if (typeof insert === "string") return [{ text: insert, marks: attributes ?? {} }];
    if (!(insert instanceof Y.XmlElement)) return [];
    const attrs = insert.getAttributes() as SequenceAttrs;
    return insert.nodeName === BLOCK_ELEMENT
      ? [{ boundary: attrs }]
      : [{ atom: insert.nodeName, attrs }];
  });
}

/** The document a format-2 note's Yjs document stands for. */
export function readBodySequence(schema: Schema, doc: Y.Doc): ProseMirrorNode {
  return readBodyLeaves(
    schema,
    leavesOfSequence(
      schema,
      piecesOfSequence(doc.getText(BODY_SEQUENCE_FIELD)),
      doc.getMap(BODY_CONTAINERS_FIELD),
    ),
  );
}
