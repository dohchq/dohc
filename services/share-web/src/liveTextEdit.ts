import * as Y from "yjs";

/** Match one text run before mutating; unrelated CRDT nodes and marks stay intact. */
export function replaceLiveText(body: Y.XmlFragment, find: string, replacement: string): void {
  if (!find || find === replacement) throw new Error("Supply different, nonempty text to replace.");
  const matches: {text: Y.XmlText; index: number}[] = [];
  const visit = (node: Y.XmlFragment | Y.XmlElement | Y.XmlText) => {
    if (node instanceof Y.XmlText) {
      const value = node.toDelta().map((part: {insert?: unknown}) => typeof part.insert === "string" ? part.insert : "\ufffc").join("");
      for (let at = value.indexOf(find); at >= 0; at = value.indexOf(find, at + 1)) matches.push({text: node, index: at});
    } else for (const child of node.toArray()) if (child instanceof Y.XmlText || child instanceof Y.XmlElement) visit(child);
  };
  visit(body);
  if (matches.length !== 1) throw new Error("The text must occur exactly once in a single text block. Read the live document before retrying.");
  const {text, index} = matches[0]!;
  let offset = 0;
  let attributes: Record<string, unknown> | undefined;
  for (const part of text.toDelta()) {
    const length = typeof part.insert === "string" ? part.insert.length : 1;
    if (index < offset + length) {attributes = part.attributes; break;}
    offset += length;
  }
  body.doc!.transact(() => {
    text.delete(index, find.length);
    if (replacement) text.insert(index, replacement, attributes);
  });
}
