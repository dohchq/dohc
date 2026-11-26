import * as Y from "yjs";
import { getDohcProseMirrorSchema, getDohcYDocBodyFragment } from "@dohc/ydoc-projection";
import { BODY_SEQUENCE_FIELD, readsBodySequence } from "@dohc/ydoc-projection/body-sequence-yjs";
import {
  LONE_HALF,
  readBody,
  replaceLetters,
  writeBody,
} from "@dohc/ydoc-projection/body-sequence-writer";

const NOT_ONCE =
  "The text must occur exactly once in a single text block. Read the live document before retrying.";

type Part = { insert?: unknown; attributes?: Record<string, unknown> };

/** Match one text run before mutating; unrelated CRDT nodes and marks stay intact. */
export function replaceLiveText(doc: Y.Doc, find: string, replacement: string): void {
  if (!find || find === replacement) throw new Error("Supply different, nonempty text to replace.");
  if (readsBodySequence(doc)) return replaceInSequence(doc, find, replacement);
  const matches: { text: Y.XmlText; index: number }[] = [];
  const visit = (node: Y.XmlFragment | Y.XmlElement | Y.XmlText) => {
    if (node instanceof Y.XmlText) {
      const value = node
        .toDelta()
        .map((part: Part) => (typeof part.insert === "string" ? part.insert : "￼"))
        .join("");
      for (let at = value.indexOf(find); at >= 0; at = value.indexOf(find, at + 1))
        matches.push({ text: node, index: at });
    } else
      for (const child of node.toArray())
        if (child instanceof Y.XmlText || child instanceof Y.XmlElement) visit(child);
  };
  visit(getDohcYDocBodyFragment(doc));
  if (matches.length !== 1) throw new Error(NOT_ONCE);
  const { text, index } = matches[0]!;
  const attributes = marksOf(text.toDelta(), index, find.length);
  doc.transact(() => {
    text.delete(index, find.length);
    if (replacement) text.insert(index, replacement, attributes);
  });
}

function replaceInSequence(doc: Y.Doc, find: string, replacement: string): void {
  if (LONE_HALF.test(find) || LONE_HALF.test(replacement))
    throw new Error("Neither text may hold half of a surrogate pair.");
  const schema = getDohcProseMirrorSchema();
  const matches: { at: number; offset: number; index: number }[] = [];
  readBody(schema, doc).forEach((line, at) => {
    for (
      let offset = line.text.indexOf(find);
      offset >= 0;
      offset = line.text.indexOf(find, offset + 1)
    )
      matches.push({ at, offset, index: line.start + offset });
  });
  if (matches.length !== 1) throw new Error(NOT_ONCE);
  const { at, offset, index } = matches[0]!;
  const marks = marksOf(doc.getText(BODY_SEQUENCE_FIELD).toDelta(), index, find.length);
  const change = replaceLetters(schema, doc, at, offset, find.length, replacement, marks);
  if (!change) throw new Error(NOT_ONCE);
  writeBody(doc, change, null);
}

/** The marks of the one run of letters that holds `length` units at `index`. */
function marksOf(parts: Part[], index: number, length: number): Record<string, unknown> {
  let offset = 0;
  for (const part of parts) {
    const size = typeof part.insert === "string" ? part.insert.length : 1;
    if (index < offset + size) {
      if (index + length > offset + size || typeof part.insert !== "string") break;
      return part.attributes ?? {};
    }
    offset += size;
  }
  throw new Error(
    "The match crosses formatting boundaries. Replace text within one formatting run.",
  );
}
