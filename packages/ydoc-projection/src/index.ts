// @dohc/ydoc-projection is the framework-only Y.Doc <-> markdown projection
// core. The engine Y.Doc driver and desktop editor share this conversion so
// each document has one projection contract.
//
// This module is deliberately engine-agnostic: it knows only Tiptap + Yjs, no
// engine.db, no sqlite, no storage. That keeps it importable from both the
// node-side engine driver and the browser-side editor.
//
// The schema definitions alone live in `@dohc/ydoc-projection/markdown-extensions`,
// so an editor can build the schema without loading the conversions.
export {
  getDohcProseMirrorSchema,
  getDohcYDocFrontmatter,
  getDohcYDocMeta,
  getDohcYDocPlainText,
  markdownToYDoc,
  parseRichdocMarkdown,
  plainTextToYDoc,
  serializeRichdocBody,
  startsWithFrontmatter,
  yDocToMarkdown,
} from "./import-export.js";
export { getDohcYDocBodyFragment } from "./body-fragment.js";
export { yDocToArtifactMarkdown } from "./artifact-markdown.js";
export {
  documentCreateUpdate,
  FRONTMATTER_REFUSAL,
  documentEditUpdate,
  settledDocumentMarkdown,
  type DocumentEditOptions,
  documentMarkdown,
  type DocumentEdit,
} from "./document-edit.js";
