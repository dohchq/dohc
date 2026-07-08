// @dohc/ydoc-projection — the salvaged, framework-only Y.Doc <-> markdown
// projection core. Re-homed from services/hocuspocus/src/import-export.ts +
// dohc-markdown-extensions.ts so the engine Y.Doc driver (and, at G2-C, the
// desktop editor) can share ONE proven conversion without depending on the
// hocuspocus SERVICE. The G2-C cutover is complete: the Hocuspocus service was
// deleted (G2-C-3), so this package is now the single durable home of the
// projection.
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
