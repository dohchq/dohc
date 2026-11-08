import type { ComponentProps, CSSProperties, ReactNode } from "react";
import type { ElementContent } from "hast";
import type { ExtraProps } from "react-markdown";
import { CODE_LANGUAGE_OPTIONS, cleanCodeLanguage } from "../editor/codeLanguages";
import { TABLE_CELL_MIN_WIDTH } from "../editor/tableSizing";
import { CopyButton } from "../ui/CopyButton";

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
// TableView), every row in one tbody, and a paragraph in each cell. A code
// block takes the editor's toolbar just before its `pre`, where the editor's
// widget sits, so the toolbar's rules place it the same way.
type Children = { children?: ReactNode };
type Cell = Children & { style?: CSSProperties };

// GFM cells never span, so the header row's cells are the table's columns.
function columnCount(table: ExtraProps["node"]): number {
  const row = table?.children
    .flatMap((section) => (section.type === "element" ? section.children : []))
    .find((child) => child.type === "element" && child.tagName === "tr");
  return row?.type === "element" ? row.children.filter((cell) => cell.type === "element").length : 0;
}

function hastText(node: ElementContent): string {
  if (node.type === "text") return node.value;
  return node.type === "element" ? node.children.map(hastText).join("") : "";
}

// The fence's language, from the `language-xxx` class remark gives its code.
function codeLanguage(code: ElementContent | undefined): string {
  if (code?.type !== "element") return "";
  const classes = code.properties.className;
  const name = Array.isArray(classes)
    ? classes.find((value) => String(value).startsWith("language-"))
    : undefined;
  return cleanCodeLanguage(name === undefined ? "" : String(name).slice("language-".length));
}

function CodeBlock({ node, ...pre }: ComponentProps<"pre"> & ExtraProps) {
  const code = node?.children.find((child) => child.type === "element");
  const language = codeLanguage(code);
  const label = CODE_LANGUAGE_OPTIONS.find((option) => option.value === language)?.label ?? language;
  return (
    <>
      <div className="dohc-code-block-toolbar">
        <div className="dohc-code-block-toolbar-left">
          {/* The picker's box: a 1px transparent border, then the 4px
              Chromium puts before a select's text. */}
          {language ? <span className="border border-transparent pl-1 text-muted">{label}</span> : null}
        </div>
        {/* remark ends a fence's text with a newline the editor's block does not hold. */}
        <CopyButton iconOnly label="Copy code" getText={() => (code ? hastText(code).replace(/\n$/u, "") : "")} />
      </div>
      <pre {...pre} />
    </>
  );
}

export const MARKDOWN_COMPONENTS = {
  pre: CodeBlock,
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
