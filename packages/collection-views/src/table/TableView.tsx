import { useMemo, useRef } from "react";
import { createColumnHelper, tableFeatures, useTable } from "@tanstack/react-table";
import { useVirtualizer } from "@tanstack/react-virtual";
import type {
  CollectionQuerySort,
  CollectionRecord,
  CollectionSchema,
  CollectionValue,
} from "@dohc/workspace-contracts";
import { deriveColumns } from "../columns";
import { FieldCell } from "./cells";

/**
 * One inline edit, surfaced for the host to apply through its own write path
 * (the frontmatter map on desktop, `collections.edit` in the SDK). The
 * package never writes.
 */
export interface CollectionCellChange {
  recordId: string;
  recordPath: string;
  field: string;
  value: CollectionValue;
}

export interface TableViewProps {
  schema: CollectionSchema;
  records: CollectionRecord[];
  /** The query's sort clauses; header clicks emit replacements. */
  sort?: CollectionQuerySort[];
  /** A view definition's visible field names; omit for every schema field. */
  visibleFields?: readonly string[] | null;
  onSortChange?: (sort: CollectionQuerySort[]) => void;
  onCellChange?: (change: CollectionCellChange) => void;
  /** Maps a person field's user id to a display name. Falls back to the id. */
  personLabel?: (userId: string) => string | null;
  rowHeight?: number;
  className?: string;
}

const TABLE_FEATURES = tableFeatures({});
const COLUMN_WIDTH = 180;
const helper = createColumnHelper<typeof TABLE_FEATURES, CollectionRecord>();

export function TableView({
  schema,
  records,
  sort,
  visibleFields,
  onSortChange,
  onCellChange,
  personLabel,
  rowHeight = 28,
  className,
}: TableViewProps) {
  const fields = useMemo(
    () => deriveColumns(schema, visibleFields),
    [schema, visibleFields],
  );

  const columns = useMemo(
    () =>
      helper.columns(
        fields.map((field) =>
          helper.accessor(
            (record) => record.values.find((entry) => entry.field === field.name),
            {
              id: field.name,
              cell: (context) => (
                <FieldCell
                  field={field}
                  indexed={context.getValue()}
                  personLabel={personLabel}
                  onChange={
                    onCellChange
                      ? (value) =>
                          onCellChange({
                            recordId: context.row.original.id,
                            recordPath: context.row.original.path,
                            field: field.name,
                            value,
                          })
                      : undefined
                  }
                />
              ),
            },
          ),
        ),
      ),
    [fields, onCellChange, personLabel],
  );

  const table = useTable({
    features: TABLE_FEATURES,
    columns,
    data: records,
    getRowId: (record) => record.id,
  });
  const rows = table.getRowModel().rows;

  const scrollRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => rowHeight,
    getItemKey: (index) => rows[index]?.id ?? index,
    overscan: 5,
  });

  const primarySort = sort?.[0];
  const toggleSort = (fieldName: string) => {
    if (!onSortChange) return;
    if (primarySort?.field !== fieldName) {
      onSortChange([{ field: fieldName, direction: "asc" }]);
    } else if (primarySort.direction === "asc") {
      onSortChange([{ field: fieldName, direction: "desc" }]);
    } else {
      onSortChange([]);
    }
  };

  return (
    <div role="grid" aria-rowcount={records.length + 1} className={`flex h-full flex-col ${className ?? ""}`}>
      <div role="row" className="flex shrink-0 border-b border-line bg-panel">
        {fields.map((field) => {
          const sorted = primarySort?.field === field.name ? primarySort.direction : null;
          return (
            <div
              key={field.name}
              role="columnheader"
              aria-sort={sorted === "asc" ? "ascending" : sorted === "desc" ? "descending" : undefined}
              style={{ width: COLUMN_WIDTH }}
            >
              <button
                type="button"
                className="flex h-7 w-full items-center gap-1 px-2 text-left text-[12px] font-medium text-muted transition-colors duration-75 hover:text-ink"
                onClick={() => toggleSort(field.name)}
              >
                <span className="truncate">{field.name}</span>
                {sorted ? (
                  <span aria-hidden="true" className="text-subtle">
                    {sorted === "asc" ? "↑" : "↓"}
                  </span>
                ) : null}
              </button>
            </div>
          );
        })}
      </div>
      {records.length === 0 ? (
        <div className="px-3 py-4 text-sm text-muted">No records in this collection yet.</div>
      ) : (
        <div ref={scrollRef} className="flex-1 overflow-auto">
          <div style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
            {virtualizer.getVirtualItems().map((item) => {
              const row = rows[item.index];
              if (!row) return null;
              return (
                <div
                  key={row.id}
                  role="row"
                  data-index={item.index}
                  className="absolute left-0 top-0 flex w-full border-b border-line"
                  style={{ height: rowHeight, transform: `translateY(${item.start}px)` }}
                >
                  {row.getAllCells().map((cell) => (
                    <div
                      key={cell.id}
                      role="gridcell"
                      className="flex items-center overflow-hidden px-2 text-ink"
                      style={{ width: COLUMN_WIDTH }}
                    >
                      <table.FlexRender cell={cell} />
                    </div>
                  ))}
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
