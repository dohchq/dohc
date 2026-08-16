import type { CSSProperties, ReactNode } from "react";

// Rendered markdown document — headings, lists, code, tables, emphasis read
// as a document, not raw source. react-markdown renders to React nodes (no raw
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
  // A quiet hairline grid with a tinted header band — the editor's own table
  // look (styles.css `.dohc-notion-editor table`), so one table reads the same
  // whether the reader is editing the document or reading it. A wide table
  // scrolls inside this wrapper; the page never scrolls sideways.
  table: (p: { children?: ReactNode }) => (
    <div className="mb-3 overflow-x-auto">
      <table className="w-full border-collapse border border-line text-[14px]">
        {p.children}
      </table>
    </div>
  ),
  // GFM column alignment arrives as an inline `style` from remark-gfm. Drop it
  // and every table renders left-aligned whatever the author wrote.
  th: (p: { children?: ReactNode; style?: CSSProperties }) => (
    <th
      style={p.style}
      className="border border-line bg-panel px-2.5 py-2 text-left font-semibold text-ink"
    >
      {p.children}
    </th>
  ),
  td: (p: { children?: ReactNode; style?: CSSProperties }) => (
    <td
      style={p.style}
      className="border border-line px-2.5 py-2 align-top text-ink"
    >
      {p.children}
    </td>
  ),
};
