import type { CSSProperties, ReactNode } from "react";

// Rendered markdown document — headings, lists, code, tables, emphasis read
// as a document, not raw source. react-markdown renders to React nodes (no raw
// HTML execution). The incremental renderer consumes link navigation and
// routes it through the audited external or workspace path.
//
// The body that holds it wears the editor's class (styles.css
// `.dohc-notion-editor`), so the editor's rules draw every block and a
// document reads the same whether it is being edited or read. Only a table
// needs the editor's shape for those rules to land: the `.tableWrapper` that
// scrolls a wide table inside itself, every row in one tbody, and a paragraph
// in each cell.
type Children = { children?: ReactNode };
type Cell = Children & { style?: CSSProperties };

export const MARKDOWN_COMPONENTS = {
  table: (p: Children) => (
    <div className="tableWrapper">
      <table>
        <tbody>{p.children}</tbody>
      </table>
    </div>
  ),
  thead: (p: Children) => <>{p.children}</>,
  tbody: (p: Children) => <>{p.children}</>,
  // GFM column alignment arrives as an inline `style` from remark-gfm. Drop it
  // and every table renders left-aligned whatever the author wrote.
  th: (p: Cell) => (
    <th style={p.style}>
      <p>{p.children}</p>
    </th>
  ),
  td: (p: Cell) => (
    <td style={p.style}>
      <p>{p.children}</p>
    </td>
  ),
};
