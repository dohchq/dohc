// @dohc/ydoc-projection — the salvaged, framework-only Y.Doc <-> markdown
// projection core. Re-homed from services/hocuspocus/src/import-export.ts +
// dohc-markdown-extensions.ts so the engine Y.Doc driver (and, at G2-C, the
// desktop editor) can share ONE proven conversion without depending on the
// hocuspocus SERVICE. Hocuspocus keeps its own copy running for live collab
// until the G2-C cutover deletes the service and its copy; this package is the
// durable home the projection converges on.
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
