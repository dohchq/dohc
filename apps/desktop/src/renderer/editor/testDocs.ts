// Test-only builders for real ProseMirror documents. Editor test suites
// build actual `Node` trees through the shared dohc schema (the same schema
// the live editor and the Y.Doc conversions use), so position math,
// traversal order, and code-mark/code-block exclusions run against the real
// document model instead of duck-typed fakes.
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { getDohcProseMirrorSchema } from "./import-export";

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
