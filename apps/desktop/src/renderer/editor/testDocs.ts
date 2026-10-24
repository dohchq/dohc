// Test-only builders for real ProseMirror documents. Editor test suites
// build actual `Node` trees through the projection's dohc schema (the one the
// live editor mirrors and the Y.Doc conversions use), so position math,
// traversal order, and code-mark/code-block exclusions run against the real
// document model instead of duck-typed fakes.
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import type { EditorState, Transaction } from "@tiptap/pm/state";
import { getDohcProseMirrorSchema } from "@dohc/ydoc-projection";

export const schema = getDohcProseMirrorSchema();

/** A `doc` node. Content is validated against the schema. */
export function doc(...blocks: ProseMirrorNode[]): ProseMirrorNode {
  return schema.node("doc", null, blocks);
}

/** A paragraph. Strings become plain text nodes. */
export function paragraph(
  ...inline: Array<string | ProseMirrorNode>
): ProseMirrorNode {
  return schema.node(
    "paragraph",
    null,
    inline.map((part) => (typeof part === "string" ? schema.text(part) : part)),
  );
}

/** Text carrying the schema's inline-code mark. */
export function codeMarkText(content: string): ProseMirrorNode {
  return schema.text(content, [schema.marks.code.create()]);
}

/** Text carrying the schema's bold mark. */
export function boldText(content: string): ProseMirrorNode {
  return schema.text(content, [schema.marks.bold.create()]);
}

export function codeBlock(content: string, language = ""): ProseMirrorNode {
  return schema.node(
    "codeBlock",
    { language },
    content ? [schema.text(content)] : [],
  );
}

export function heading(level: number, content = ""): ProseMirrorNode {
  return schema.node("heading", { level }, content ? [schema.text(content)] : []);
}

export function hardBreak(): ProseMirrorNode {
  return schema.node("hardBreak");
}

/** A seeded random edit of `state`: typing a fragment, deleting a span or a
 *  whole block, splitting or joining blocks, marking text as code, or
 *  replacing the whole document as y-tiptap does. A plugin that
 *  updates only what changed can be checked against a full rebuild after a
 *  long run of these. */
export function randomEdit(
  state: EditorState,
  random: () => number,
  fragments: readonly string[],
): Transaction {
  const textblocks: Array<{ node: ProseMirrorNode; pos: number }> = [];
  state.doc.descendants((node, pos) => {
    if (!node.isTextblock) return true;
    textblocks.push({ node, pos });
    return false;
  });
  const pick = <T>(values: readonly T[]): T => values[Math.floor(random() * values.length)]!;
  const block = pick(textblocks);
  const inBlock = () => block.pos + 1 + Math.floor(random() * (block.node.content.size + 1));
  const tr = state.tr;
  const kind = random();
  if (kind < 0.45) return tr.insertText(pick(fragments), inBlock());
  if (kind < 0.65) {
    const from = inBlock();
    return tr.delete(from, Math.min(from + 1 + Math.floor(random() * 6), state.doc.content.size));
  }
  if (kind < 0.75) return tr.split(inBlock());
  if (kind < 0.85) {
    const start = block.pos + 1;
    return start > 1 ? tr.delete(start - 2, start) : tr;
  }
  if (kind < 0.9) {
    return textblocks.length > 1 ? tr.delete(block.pos, block.pos + block.node.nodeSize) : tr;
  }
  // y-tiptap applies a remote change or an undo as one replacement of the
  // whole document, reusing the nodes that did not change.
  if (kind < 0.93) {
    const typed = state.tr.insertText(pick(fragments), inBlock()).doc;
    return tr.replaceWith(0, state.doc.content.size, typed.content);
  }
  if (kind < 0.95) {
    const copy = schema.nodeFromJSON(state.doc.toJSON());
    return tr.replaceWith(0, state.doc.content.size, copy.content);
  }
  const from = inBlock();
  return tr.addMark(from, Math.min(from + 3, block.pos + block.node.nodeSize - 1), schema.marks.code.create());
}

/** A small seeded generator (mulberry32), so a failing run can be replayed. */
export function seededRandom(seed: number): () => number {
  let value = seed >>> 0;
  return () => {
    value = (value + 0x6d2b79f5) >>> 0;
    let t = value;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}
