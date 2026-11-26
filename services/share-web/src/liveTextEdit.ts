import * as Y from "yjs";
import { getDohcProseMirrorSchema, getDohcYDocBodyFragment } from "@dohc/ydoc-projection";
import { createBodyReader, positionOf } from "@dohc/ydoc-projection/body-sequence-reading";
import {
  BODY_CONTAINERS_FIELD,
  BODY_SEQUENCE_FIELD,
  readsBodySequence,
} from "@dohc/ydoc-projection/body-sequence-yjs";
import {
  LONE_HALF,
  readBody,
  replaceLetters,
  writeBody,
} from "@dohc/ydoc-projection/body-sequence-writer";

const NOT_ONCE =
  "The text must occur exactly once in a single text block. Read the live document before retrying.";
const CROSSES = "The match crosses formatting boundaries. Replace text within one formatting run.";

/** Match one text run before mutating; unrelated CRDT nodes and marks stay intact. */
export function replaceLiveText(doc: Y.Doc, find: string, replacement: string): void {
  if (!find || find === replacement) throw new Error("Supply different, nonempty text to replace.");
  if (readsBodySequence(doc)) return replaceInSequence(doc, find, replacement);
  const matches: { text: Y.XmlText; index: number }[] = [];
  const visit = (node: Y.XmlFragment | Y.XmlElement | Y.XmlText) => {
    if (node instanceof Y.XmlText) {
      const value = node
        .toDelta()
        .map((part: { insert?: unknown }) =>
          typeof part.insert === "string" ? part.insert : "\ufffc",
        )
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
  let offset = 0;
  let attributes: Record<string, unknown> | undefined;
  for (const part of text.toDelta()) {
    const length = typeof part.insert === "string" ? part.insert.length : 1;
    if (index < offset + length) {
      if (index + find.length > offset + length || typeof part.insert !== "string")
        throw new Error(CROSSES);
      attributes = part.attributes;
      break;
    }
    offset += length;
  }
  doc.transact(() => {
    text.delete(index, find.length);
    if (replacement) text.insert(index, replacement, attributes ?? {});
  });
}

function replaceInSequence(doc: Y.Doc, find: string, replacement: string): void {
  if (LONE_HALF.test(find) || LONE_HALF.test(replacement))
    throw new Error("Neither text may hold half of a surrogate pair.");
  const schema = getDohcProseMirrorSchema();
  const items = new Set<number>();
  let next = 0;
  for (const part of doc.getText(BODY_SEQUENCE_FIELD).toDelta() as { insert: unknown }[]) {
    if (typeof part.insert !== "string") items.add(next);
    next += typeof part.insert === "string" ? part.insert.length : 1;
  }
  const holdsItem = (index: number) =>
    Array.from({ length: find.length }, (_, unit) => items.has(index + unit)).includes(true);
  const matches: { at: number; offset: number; index: number }[] = [];
  readBody(schema, doc).forEach((line, at) => {
    for (
      let offset = line.text.indexOf(find);
      offset >= 0;
      offset = line.text.indexOf(find, offset + 1)
    )
      if (!holdsItem(line.start + offset)) matches.push({ at, offset, index: line.start + offset });
  });
  if (matches.length !== 1) throw new Error(NOT_ONCE);
  const { at, offset, index } = matches[0]!;
  const reading = createBodyReader(
    schema,
    doc.getText(BODY_SEQUENCE_FIELD),
    doc.getMap(BODY_CONTAINERS_FIELD),
  ).reading();
  const pos = positionOf(reading, index);
  const shown = pos < 0 ? null : reading.doc.resolve(pos).nodeAfter;
  const last = find.length - 1;
  if (!shown?.isText || shown.nodeSize <= last || positionOf(reading, index + last) !== pos + last)
    throw new Error(CROSSES);
  const marks = Object.fromEntries(shown.marks.map((mark) => [mark.type.name, { ...mark.attrs }]));
  const change = replaceLetters(schema, doc, at, offset, find.length, replacement, marks);
  if (!change) throw new Error(NOT_ONCE);
  writeBody(doc, change, null);
}
