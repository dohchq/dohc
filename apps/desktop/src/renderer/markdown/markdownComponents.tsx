import type { CSSProperties, ReactNode } from "react";
import type { ExtraProps } from "react-markdown";
import { TABLE_CELL_MIN_WIDTH } from "../editor/tableSizing";

// Rendered markdown document — headings, lists, code, tables, emphasis read
// as a document, not raw source. react-markdown renders to React nodes (no raw
// HTML execution). The incremental renderer consumes link navigation and
// routes it through the audited external or workspace path.
//
// The body that holds it wears the editor's class (styles.css
// `.dohc-notion-editor`), so the editor's rules draw every block and a
// document reads the same whether it is being edited or read. Only a table
// needs the editor's shape for those rules to land: the `.tableWrapper` that
// scrolls a wide table inside itself, the editor's column sizing (Tiptap's
// TableView), every row in one tbody, and a paragraph in each cell.
type Children = { children?: ReactNode };
type Cell = Children & { style?: CSSProperties };

// GFM cells never span, so the header row's cells are the table's columns.
function columnCount(table: ExtraProps["node"]): number {
  const row = table?.children
    .flatMap((section) => (section.type === "element" ? section.children : []))
    .find((child) => child.type === "element" && child.tagName === "tr");
  return row?.type === "element" ? row.children.filter((cell) => cell.type === "element").length : 0;
}

export const MARKDOWN_COMPONENTS = {
  table: (p: Children & ExtraProps) => {
    const columns = columnCount(p.node);
    return (
      <div className="tableWrapper">
        <table style={{ minWidth: `${columns * TABLE_CELL_MIN_WIDTH}px` }}>
          <colgroup>
            {Array.from({ length: columns }, (_, index) => (
              <col key={index} style={{ minWidth: `${TABLE_CELL_MIN_WIDTH}px` }} />
            ))}
          </colgroup>
          <tbody>{p.children}</tbody>
        </table>
      </div>
    );
  },
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
