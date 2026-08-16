import type { ReactNode } from "react";

// Rendered markdown document — headings, lists, code, emphasis read as a
// document, not raw source. react-markdown renders to React nodes (no raw
// HTML execution). The incremental renderer consumes link navigation and
// routes it through the audited external or workspace path.
//
// Shared by every surface that shows read-only markdown, so the document
// voice cannot drift file by file: the file reader and the plugin README.
export const MARKDOWN_COMPONENTS = {
  h1: (p: { children?: ReactNode }) => (
    <h1 className="mb-3 mt-1 text-2xl font-semibold tracking-tight text-ink">{p.children}</h1>
  ),
  h2: (p: { children?: ReactNode }) => (
    <h2 className="mb-2 mt-4 text-xl font-semibold tracking-tight text-ink">{p.children}</h2>
  ),
  h3: (p: { children?: ReactNode }) => (
    <h3 className="mb-1.5 mt-3 text-base font-semibold text-ink">{p.children}</h3>
  ),
  p: (p: { children?: ReactNode }) => (
    <p className="mb-3 leading-relaxed text-ink">{p.children}</p>
  ),
  ul: (p: { children?: ReactNode }) => (
    <ul className="mb-3 list-disc pl-5 text-ink">{p.children}</ul>
  ),
  ol: (p: { children?: ReactNode }) => (
    <ol className="mb-3 list-decimal pl-5 text-ink">{p.children}</ol>
  ),
  code: (p: { children?: ReactNode }) => (
    <code className="rounded bg-panel-2 px-1 py-0.5 font-mono text-[13px]">{p.children}</code>
  ),
};
