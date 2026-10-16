import { memo, type CSSProperties, type ComponentPropsWithoutRef, type ReactNode } from "react";

// One grid for a table of rows and columns: a CSV file or a database table.
// It draws the frame, the row-number gutter, the header, number alignment,
// column widths, row hover and the focused cell. Each view supplies its
// cells' content.

// What the grid knows of a column: whether it holds numbers, and the text that
// sets its width (its header and its widest cell). A view changes a column
// only when an edit in it ends, so typing never moves or restyles the table.
export interface DataGridColumn {
  numeric: boolean;
  header: string;
  cell: string;
}

// Numbers read down a column: right-aligned, mono, tabular. The table sets
// these per number column, and each cell reads its own column's values, so a
// column that starts or stops holding numbers changes one table style and
// renders no row again. An unset value inherits the table's.
const columnVar = (name: string, column: number) => `--data-grid-${name}-${column}`;

function numberColumns(columns: readonly DataGridColumn[]): CSSProperties {
  const style: Record<string, string> = {};
  columns.forEach(({ numeric }, column) => {
    if (!numeric) return;
    style[columnVar("align", column)] = "right";
    style[columnVar("font", column)] = "var(--font-mono)";
    style[columnVar("size", column)] = "12px";
    style[columnVar("figures", column)] = "tabular-nums";
  });
  return style;
}

const headerStyles: CSSProperties[] = [];
const cellStyles: CSSProperties[] = [];
const headerStyle = (column: number) =>
  (headerStyles[column] ??= { textAlign: `var(${columnVar("align", column)})` as CSSProperties["textAlign"] });
const cellStyle = (column: number) =>
  (cellStyles[column] ??= {
    textAlign: `var(${columnVar("align", column)})` as CSSProperties["textAlign"],
    fontFamily: `var(${columnVar("font", column)})`,
    fontSize: `var(${columnVar("size", column)})`,
    fontVariantNumeric: `var(${columnVar("figures", column)})`,
  });

// A grid's columns take their text's width, not the pane's. The header stays
// in view while the rows scroll; the frame clips without scrolling itself, so
// the scroller around the grid holds the header.
export function DataGrid({
  columns,
  headerRoom,
  trailing,
  className,
  style,
  children,
  ...props
}: ComponentPropsWithoutRef<"table"> & {
  columns: readonly DataGridColumn[];
  // Room in each header beside its name, in px, for its icons and actions.
  headerRoom?: number;
  // A last column after the data's, such as Add column.
  trailing?: boolean;
}) {
  return (
    <table
      {...props}
      style={{ ...numberColumns(columns), ...style }}
      className={`border-separate border-spacing-0 overflow-clip rounded-lg border border-line text-[13px] ${className ?? ""}`}
    >
      {children}
      <ColumnWidths columns={columns} headerRoom={headerRoom ?? 0} trailing={trailing} />
    </table>
  );
}

// Every header cell stays in view while the rows scroll, with the header's
// hairline 1px below it. At rest the hairline covers the first row's top
// border exactly; scrolled, it stays under the header.
export const STICKY_HEADER = "sticky top-0 z-10 shadow-[0_1px_0_var(--dohc-line)]";

// The header's first cell, over the row numbers.
export function DataGridGutterHeader({ wide, className, ...props }: ComponentPropsWithoutRef<"th"> & { wide?: boolean }) {
  return <th {...props} className={`${STICKY_HEADER} ${wide ? "w-10" : "w-8"} bg-panel-2 p-0 ${className ?? ""}`} />;
}

// A column's header. Its actions show on hover or focus (DataGridColumnAction).
// A header that holds focus itself, or whose name is being edited, draws the
// focused cell's outline; its buttons keep their own focus ring.
export function DataGridHeaderCell({
  column,
  className,
  ...props
}: ComponentPropsWithoutRef<"th"> & { column: number }) {
  return (
    <th
      {...props}
      data-grid-cell=""
      style={headerStyle(column)}
      className={`group/column ${STICKY_HEADER} h-7 bg-panel-2 px-2.5 text-[12px] font-medium text-muted focus:outline-2 focus:-outline-offset-2 focus:outline-accent has-[input:focus]:outline-2 has-[input:focus]:-outline-offset-2 has-[input:focus]:outline-accent ${className ?? ""}`}
    />
  );
}

// A header action, such as Delete column, hidden until its column's header
// is hovered or holds focus. It stays in the tab order while hidden.
export function DataGridColumnAction(props: { children: ReactNode }) {
  return (
    <span className="flex shrink-0 opacity-0 transition-opacity duration-75 group-focus-within/column:opacity-100 group-hover/column:opacity-100">
      {props.children}
    </span>
  );
}

export function DataGridRow({ className, ...props }: ComponentPropsWithoutRef<"tr">) {
  return <tr {...props} className={`group/row transition-colors duration-75 hover:bg-panel-2 ${className ?? ""}`} />;
}

// A row's number. A row action, such as Delete row, replaces the number in
// the same box while the row is hovered or holds focus.
export function DataGridGutter({
  number,
  action,
  wide,
  className,
  ...props
}: Omit<ComponentPropsWithoutRef<"td">, "children"> & { number?: number; action?: ReactNode; wide?: boolean }) {
  return (
    <td
      {...props}
      className={`h-7 ${wide ? "w-10" : "w-8"} border-t border-line py-0 pl-0 pr-2 text-right font-mono text-[11px] text-subtle ${className ?? ""}`}
    >
      {action ? (
        <span className="inline-grid items-center justify-items-end align-middle">
          <span className="[grid-area:1/1] transition-opacity duration-75 group-focus-within/row:opacity-0 group-hover/row:opacity-0">
            {number}
          </span>
          <span className="flex [grid-area:1/1] opacity-0 transition-opacity duration-75 group-focus-within/row:opacity-100 group-hover/row:opacity-100">
            {action}
          </span>
        </span>
      ) : (
        number
      )}
    </td>
  );
}

// A cell. The cell holding focus draws the accent outline inside its edges,
// and that is its one focus mark: `data-grid-cell` exempts its input from the
// text fields' focus underline (styles.css), and the input drops its own
// ring. An input in it takes the cell's alignment with `[text-align:inherit]`.
export function DataGridCell({
  column,
  className,
  ...props
}: ComponentPropsWithoutRef<"td"> & { column: number }) {
  return (
    <td
      {...props}
      data-grid-cell=""
      style={cellStyle(column)}
      className={`h-7 border-t border-line px-2.5 py-0 focus-within:outline-2 focus-within:-outline-offset-2 focus-within:outline-accent ${className ?? ""}`}
    />
  );
}

// Measures a cell's text as the grid draws it: 12px mono for numbers, 13px
// sans otherwise. Where no canvas can measure (a test DOM), it counts
// characters.
export function cellMeasure(numeric: boolean): (text: string) => number {
  const context = typeof OffscreenCanvas === "undefined" ? null : new OffscreenCanvas(1, 1).getContext("2d");
  if (!context) return (text) => text.length;
  const root = getComputedStyle(document.documentElement);
  context.font = numeric ? `12px ${root.getPropertyValue("--font-mono")}` : `13px ${root.getPropertyValue("--font-sans")}`;
  return (text) => context.measureText(text).width;
}

// Sets each column's width from its text, at least 64px and at most 320px,
// in a row of no height after the last. It draws the text in its column's
// font, which comes from the same columns as its text. Cells fill their
// column, or draw at most its widest text, so a cell's own text never moves
// the table.
const ColumnWidths = memo(function ColumnWidths(props: {
  columns: readonly DataGridColumn[];
  headerRoom: number;
  trailing?: boolean;
}) {
  return (
    <tfoot aria-hidden data-testid="data-grid-widths">
      <tr>
        <td className="p-0" />
        {props.columns.map((text, column) => (
          <td key={column} className="p-0" style={cellStyle(column)}>
            <div
              className="box-content h-0 max-w-80 overflow-hidden whitespace-pre pl-2.5 font-sans text-[12px] font-medium"
              style={{ paddingRight: 10 + props.headerRoom }}
            >
              {text.header}
            </div>
            <div className="box-content h-0 min-w-16 max-w-80 overflow-hidden whitespace-pre px-2.5">{text.cell}</div>
          </td>
        ))}
        {props.trailing ? <td className="p-0" /> : null}
      </tr>
    </tfoot>
  );
});
