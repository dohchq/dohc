// @dohc/ydoc-projection is the framework-only Y.Doc <-> markdown projection
// core. The engine Y.Doc driver and desktop editor share this conversion so
// each document has one projection contract.
//
// This module is deliberately engine-agnostic: it knows only Tiptap + Yjs, no
// engine.db, no sqlite, no storage. That keeps it importable from both the
// node-side engine driver and the browser-side editor.
export {
  getDohcProseMirrorSchema,
  getDohcYDocBodyFragment,
  getDohcYDocFrontmatter,
  getDohcYDocMeta,
  getDohcYDocPlainText,
  markdownToYDoc,
  plainTextToYDoc,
  yDocToMarkdown,
} from "./import-export.js";
export { dohcMarkdownExtensions } from "./dohc-markdown-extensions.js";
export { backtickFence } from "./markdown-fence.js";
