import { memo, type CSSProperties, type ComponentPropsWithoutRef, type ReactNode } from "react";

// One grid for a table of rows and columns: a CSV file or a database table.
// It draws the frame, the row-number gutter, the header, number alignment,
// column widths, row hover and the focused cell. Each view supplies its
// cells' content.

// Numbers read down a column: right-aligned, mono, tabular. The table sets
// these per number column, and each cell reads its own column's values, so a
// column that starts or stops holding numbers changes one table style and
// renders no row again. An unset value inherits the table's.
const columnVar = (name: string, column: number) => `--data-grid-${name}-${column}`;

function numberColumns(numeric: readonly boolean[]): CSSProperties {
  const style: Record<string, string> = {};
  numeric.forEach((isNumber, column) => {
    if (!isNumber) return;
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

// A grid's columns take their content's width, not the pane's.
export function DataGrid({
  numeric,
  className,
  style,
  ...props
}: ComponentPropsWithoutRef<"table"> & { numeric: readonly boolean[] }) {
  return (
    <table
      {...props}
      style={{ ...numberColumns(numeric), ...style }}
      className={`border-separate border-spacing-0 overflow-hidden rounded-lg border border-line text-[13px] ${className ?? ""}`}
    />
  );
}

// The header's first cell, over the row numbers.
export function DataGridGutterHeader({ wide, className, ...props }: ComponentPropsWithoutRef<"th"> & { wide?: boolean }) {
  return <th {...props} className={`${wide ? "w-10" : "w-8"} bg-panel-2 p-0 ${className ?? ""}`} />;
}

// A column's header. Its actions show on hover or focus (DataGridColumnAction).
// A header whose name is being edited draws the focused cell's outline; its
// buttons keep their own focus ring.
export function DataGridHeaderCell({
  column,
  className,
  ...props
}: ComponentPropsWithoutRef<"th"> & { column: number }) {
  return (
    <th
      {...props}
      style={headerStyle(column)}
      className={`group/column h-7 bg-panel-2 px-2.5 text-[12px] font-medium text-muted has-[input:focus]:outline-2 has-[input:focus]:-outline-offset-2 has-[input:focus]:outline-accent ${className ?? ""}`}
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
// so its own input can drop the focus ring without losing the mark. An input
// in it takes the cell's alignment with `[text-align:inherit]`.
export function DataGridCell({
  column,
  className,
  ...props
}: ComponentPropsWithoutRef<"td"> & { column: number }) {
  return (
    <td
      {...props}
      style={cellStyle(column)}
      className={`h-7 border-t border-line px-2.5 py-0 focus-within:outline-2 focus-within:-outline-offset-2 focus-within:outline-accent ${className ?? ""}`}
    />
  );
}

// The text that sets a column's width: its header, and its widest cell.
export interface DataGridColumnText {
  header: string;
  cell: string;
}

// Sets each column's width from its text, at least 64px and at most 320px,
// in a row of no height after the last. Cells then fill their column, so a
// cell's text never moves the table while it changes; the view hands new
// text only when an edit ends.
export const DataGridColumnWidths = memo(function DataGridColumnWidths(props: {
  columns: readonly DataGridColumnText[];
  // Room in each header for an action beside its name.
  headerAction?: boolean;
  // A last column after the data's, such as Add column.
  trailing?: boolean;
}) {
  return (
    <tfoot aria-hidden data-testid="data-grid-widths">
      <tr>
        <td className="p-0" />
        {props.columns.map((text, column) => (
          <td key={column} className="p-0" style={cellStyle(column)}>
            <div
              className={`box-content h-0 max-w-80 overflow-hidden whitespace-pre pl-2.5 font-sans text-[12px] font-medium ${
                props.headerAction ? "pr-[34px]" : "pr-2.5"
              }`}
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
