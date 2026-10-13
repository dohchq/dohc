import type { ComponentPropsWithoutRef, ReactNode } from "react";

// One grid for a table of rows and columns: a CSV file or a database table.
// It draws the frame, the row-number gutter, the header, number alignment,
// row hover and the focused cell. Each view supplies its cells' content.

// Numbers read down a column: right-aligned, mono, tabular.
const NUMBER = "text-right font-mono text-[12px] tabular-nums";

// A grid's columns take their content's width, not the pane's.
export function DataGrid({ className, ...props }: ComponentPropsWithoutRef<"table">) {
  return (
    <table
      {...props}
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
  numeric,
  className,
  ...props
}: ComponentPropsWithoutRef<"th"> & { numeric?: boolean }) {
  return (
    <th
      {...props}
      className={`group/column h-7 bg-panel-2 px-2.5 text-[12px] font-medium text-muted has-[input:focus]:outline-2 has-[input:focus]:-outline-offset-2 has-[input:focus]:outline-accent ${
        numeric ? "text-right" : "text-left"
      } ${className ?? ""}`}
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
// so its own input can drop the focus ring without losing the mark.
export function DataGridCell({
  numeric,
  className,
  ...props
}: ComponentPropsWithoutRef<"td"> & { numeric?: boolean }) {
  return (
    <td
      {...props}
      className={`h-7 border-t border-line px-2.5 py-0 focus-within:outline-2 focus-within:-outline-offset-2 focus-within:outline-accent ${
        numeric ? NUMBER : ""
      } ${className ?? ""}`}
    />
  );
}
