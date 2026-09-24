// @dohc/ydoc-projection is the framework-only Y.Doc <-> markdown projection
// core. The engine Y.Doc driver and desktop editor share this conversion so
// each document has one projection contract.
//
// This module is deliberately engine-agnostic: it knows only Tiptap + Yjs, no
// engine.db, no sqlite, no storage. That keeps it importable from both the
// node-side engine driver and the browser-side editor.
export {
  DohcMarkdownTable,
  getDohcProseMirrorSchema,
  getDohcYDocFrontmatter,
  getDohcYDocMeta,
  getDohcYDocPlainText,
  markdownToYDoc,
  plainTextToYDoc,
  serializeRichdocBody,
  yDocToMarkdown,
} from "./import-export.js";
export { getDohcYDocBodyFragment } from "./body-fragment.js";
export { dohcMarkdownExtensions } from "./dohc-markdown-extensions.js";
export { codeBlockFence } from "./markdown-fence.js";
export {
  documentCreateUpdate,
  documentEditUpdate,
  settledDocumentMarkdown,
  documentMarkdown,
  type DocumentEdit,
} from "./document-edit.js";
