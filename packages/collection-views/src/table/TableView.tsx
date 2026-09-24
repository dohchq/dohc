import { useCallback, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { createColumnHelper, tableFeatures, useTable } from "@tanstack/react-table";
import { defaultRangeExtractor, useVirtualizer } from "@tanstack/react-virtual";
import type { Range } from "@tanstack/react-virtual";
import type {
  CollectionQuerySort,
  CollectionRecord,
  CollectionSchema,
  CollectionValue,
} from "@dohc/workspace-contracts";
import { deriveColumns } from "../columns";
import { recordLabel } from "../recordLabel";
import type { CollectionQueryExecutor } from "../store";
import { CellEditor, FieldCell } from "./cells";

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
  /** Observed value and pending local predecessor values for this edit. */
  previousValues?: readonly CollectionValue[];
}

/**
 * A typed select value the field's options do not have yet. The host adds
 * `option` to the schema first and writes `value` to the cell only after
 * that write succeeds; the package never writes either.
 */
export interface CollectionOptionCreate {
  recordId: string;
  recordPath: string;
  field: string;
  option: string;
  value: CollectionValue;
  previousValues?: readonly CollectionValue[];
}

/**
 * A mark after a field's name in the header, such as the ⚡ of a field that
 * automations set. The host supplies the icon and its words; hovering the
 * header or focusing its sort control shows the words, and screen readers
 * hear them as the control's description.
 */
export interface TableFieldMark {
  icon: ReactNode;
  label: string;
}

export interface TableViewProps {
  schema: CollectionSchema;
  records: CollectionRecord[];
  /** The query's sort clauses; header clicks emit replacements. */
  sort?: CollectionQuerySort[];
  /** A view definition's visible field names; omit for every schema field. */
  visibleFields?: readonly string[] | null;
  onSortChange?: (sort: CollectionQuerySort[]) => void;
  onCellChange?: (change: CollectionCellChange) => number;
  /** Pause controls while keeping the open editor and its draft mounted. */
  editingDisabled?: boolean;
  /** Highest saved edit id reflected in this record's queried field value. */
  acknowledgedWriteId?: (record: CollectionRecord, field: string) => number;
  /** Explicitly discarded edit ids retire local input without claiming a save. */
  subscribeToDiscardedWrites?: (listener: (writeId: number) => void) => () => void;
  onCreateOption?: (create: CollectionOptionCreate) => void;
  /** Receives the row's record when its Open control is clicked. */
  onOpenRecord?: (record: CollectionRecord) => void;
  /**
   * Runs the relation picker's queries against a relation field's related
   * collection. Absent means relation cells stay read-only.
   */
  relationExecutor?: CollectionQueryExecutor;
  /** Maps a person field's user id to a display name. Falls back to the id. */
  personLabel?: (userId: string) => string | null;
  /** Marks by field name. Built once by the host, so rows never pay for them. */
  fieldMarks?: ReadonlyMap<string, TableFieldMark>;
  /**
   * Called when the virtualizer renders within NEAR_END_ROWS of the last
   * loaded record. Hosts respond by loading the next page; extra calls are
   * safe — the collection store no-ops without a cursor or while a page is
   * already in flight.
   */
  onNearEnd?: () => void;
}

const TABLE_FEATURES = tableFeatures({});
const COLUMN_WIDTH = 180;
const OPEN_COLUMN_WIDTH = 56;
const ROW_HEIGHT = 28;
/** How close to the end of the loaded rows `onNearEnd` starts firing. */
const NEAR_END_ROWS = 20;
const helper = createColumnHelper<typeof TABLE_FEATURES, CollectionRecord>();

/**
 * The one cell whose editor is open, addressed by record id and field name
 * so an active edit survives a store refresh (a new records array) and a
 * sort-driven row move. Row index and record object identity are both
 * unstable across refreshes; this pair is not.
 */
interface EditingCell {
  recordId: string;
  field: string;
}

/**
 * One field's header: its name sorts the table. A mark's words show while
 * the pointer is over the header or its words, or its sort control has
 * focus, and Escape hides them. The state lives here, so showing the words
 * renders this header alone.
 */
function FieldHeader(props: {
  name: string;
  sorted: "asc" | "desc" | null;
  mark: TableFieldMark | undefined;
  onSort: () => void;
}) {
  const { mark, sorted } = props;
  const markId = useId();
  const [open, setOpen] = useState(false);
  return (
    <div
      role="columnheader"
      aria-sort={sorted === "asc" ? "ascending" : sorted === "desc" ? "descending" : undefined}
      className="relative"
      style={{ width: COLUMN_WIDTH }}
      {...(mark ? { onMouseEnter: () => setOpen(true), onMouseLeave: () => setOpen(false) } : {})}
    >
      <button
        type="button"
        className="flex h-7 w-full items-center gap-1 px-2 text-left text-[12px] font-medium text-muted transition-colors duration-75 hover:text-ink"
        onClick={props.onSort}
        {...(mark
          ? {
              "aria-describedby": markId,
              onFocus: () => setOpen(true),
              onBlur: () => setOpen(false),
              onKeyDown: (event: KeyboardEvent<HTMLButtonElement>) => {
                if (event.key !== "Escape" || !open) return;
                event.stopPropagation();
                setOpen(false);
              },
            }
          : {})}
      >
        <span className="truncate">{props.name}</span>
        {mark ? (
          <span aria-hidden="true" data-testid="table-field-mark" className="inline-flex shrink-0">
            {mark.icon}
          </span>
        ) : null}
        {sorted ? (
          <span aria-hidden="true" className="text-subtle">
            {sorted === "asc" ? "↑" : "↓"}
          </span>
        ) : null}
      </button>
      {mark ? (
        // No gap between the header and its words, so the pointer can move onto them.
        <span id={markId} role="tooltip" hidden={!open} className="absolute left-2 top-full z-20 pt-1">
          <span className="dohc-popover block w-max max-w-64 rounded-lg border border-line bg-panel px-2 py-1 text-[12px] font-normal text-ink">
            {mark.label}
          </span>
        </span>
      ) : null}
    </div>
  );
}

export function TableView({
  schema,
  records,
  sort,
  visibleFields,
  onSortChange,
  onCellChange,
  editingDisabled = false,
  acknowledgedWriteId,
  subscribeToDiscardedWrites,
  onCreateOption,
  onOpenRecord,
  relationExecutor,
  personLabel,
  fieldMarks,
  onNearEnd,
}: TableViewProps) {
  const fields = useMemo(
    () => deriveColumns(schema, visibleFields),
    [schema, visibleFields],
  );

  const [editing, setEditing] = useState<EditingCell | null>(null);

  const columns = useMemo(
    () =>
      helper.columns(
        fields.map((field) => {
          // Relation editing needs query access to the related collection;
          // without an executor the cell stays read-only. Checkboxes commit
          // through onChange and never open an editor.
          const editable =
            !editingDisabled &&
            onCellChange !== undefined &&
            field.type !== "checkbox" &&
            (field.type !== "relation" || relationExecutor !== undefined);
          return helper.accessor(
            (record) => record.values.find((entry) => entry.field === field.name),
            {
              id: field.name,
              cell: (context) => (
                <FieldCell
                  field={field}
                  indexed={context.getValue()}
                  personLabel={personLabel}
                  onChange={
                    onCellChange && !editingDisabled
                      ? (value) =>
                          onCellChange({
                            recordId: context.row.original.id,
                            recordPath: context.row.original.path,
                            field: field.name,
                            value,
                          })
                      : undefined
                  }
                  onEditStart={
                    editable
                      ? () =>
                          setEditing({
                            recordId: context.row.original.id,
                            field: field.name,
                          })
                      : undefined
                  }
                />
              ),
            },
          );
        }),
      ),
    [fields, onCellChange, editingDisabled, personLabel, relationExecutor],
  );

  const table = useTable({
    features: TABLE_FEATURES,
    columns,
    data: records,
    getRowId: (record) => record.id,
  });
  const rows = table.getRowModel().rows;

  const editingRowIndex =
    editing === null ? -1 : rows.findIndex((row) => row.id === editing.recordId);
  const editingRow = editingRowIndex >= 0 ? rows[editingRowIndex] : undefined;
  const editingField =
    editing === null ? undefined : fields.find((field) => field.name === editing.field);
  const editingValue = editingRow?.original.values.find((entry) => entry.field === editingField?.name);

  const scrollRef = useRef<HTMLDivElement>(null);
  // Keep the edited row mounted while it is scrolled out of the virtual
  // window so its editor overlay never floats over an empty gap.
  const rangeExtractor = useCallback(
    (range: Range) => {
      const indexes = defaultRangeExtractor(range);
      if (editingRowIndex < 0 || indexes.includes(editingRowIndex)) return indexes;
      return [...indexes, editingRowIndex].sort((a, b) => a - b);
    },
    [editingRowIndex],
  );
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    getItemKey: (index) => rows[index]?.id ?? index,
    overscan: 5,
    rangeExtractor,
  });
  const virtualItems = virtualizer.getVirtualItems();

  // Paging: nearing the end of the loaded rows asks the host for the next
  // page. Driven by the last rendered index, so it also fires when a short
  // first page cannot fill the viewport.
  const lastRenderedIndex = virtualItems.at(-1)?.index ?? -1;
  useEffect(() => {
    if (!onNearEnd || lastRenderedIndex < 0) return;
    if (lastRenderedIndex >= records.length - NEAR_END_ROWS) onNearEnd();
  }, [onNearEnd, lastRenderedIndex, records.length]);

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
    <div role="grid" aria-rowcount={records.length + 1} className="flex h-full flex-col">
      <div role="row" className="flex shrink-0 border-b border-line bg-panel">
        {onOpenRecord ? (
          <div role="columnheader" style={{ width: OPEN_COLUMN_WIDTH }} />
        ) : null}
        {fields.map((field) => (
          <FieldHeader
            key={field.name}
            name={field.name}
            sorted={primarySort?.field === field.name ? primarySort.direction : null}
            mark={fieldMarks?.get(field.name)}
            onSort={() => toggleSort(field.name)}
          />
        ))}
      </div>
      {records.length === 0 ? (
        <div className="px-3 py-4 text-sm text-muted">No records in this collection yet.</div>
      ) : (
        <div ref={scrollRef} className="flex-1 overflow-auto">
          <div style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
            {virtualItems.map((item) => {
              const row = rows[item.index];
              if (!row) return null;
              return (
                <div
                  key={row.id}
                  role="row"
                  data-index={item.index}
                  className="group absolute left-0 top-0 flex w-full border-b border-line"
                  style={{ height: ROW_HEIGHT, transform: `translateY(${item.start}px)` }}
                >
                  {onOpenRecord ? (
                    <div
                      role="gridcell"
                      className="flex items-center justify-center"
                      style={{ width: OPEN_COLUMN_WIDTH }}
                    >
                      <button
                        type="button"
                        aria-label={`Open ${recordLabel(row.original)}`}
                        className="rounded border border-line bg-panel px-1.5 text-[11px] text-muted opacity-0 transition-opacity duration-75 hover:text-ink focus-visible:opacity-100 group-hover:opacity-100"
                        onClick={() => onOpenRecord(row.original)}
                      >
                        Open
                      </button>
                    </div>
                  ) : null}
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
            {editing && editingRow && editingField && onCellChange ? (
              <fieldset
                // One editor for every cell type, drawn in an overlay above
                // the rows and anchored to the cell's top edge. Growing
                // downward from there, a tall editor (a multi-select's
                // option list) is never clipped by the fixed row height and
                // never extends up under the column header, which would
                // steal its clicks. Remounting on cell switch resets the
                // editor's inputs to the next cell's value.
                key={`${editing.recordId}:${editing.field}`}
                data-cell-editor=""
                disabled={editingDisabled}
                onBlurCapture={(event) => {
                  if (editingDisabled) event.stopPropagation();
                }}
                className="absolute z-10 m-0 min-w-0 rounded border border-line bg-panel p-1 shadow-md"
                style={{
                  top: editingRowIndex * ROW_HEIGHT,
                  left:
                    (onOpenRecord ? OPEN_COLUMN_WIDTH : 0) +
                    fields.indexOf(editingField) * COLUMN_WIDTH,
                  width: COLUMN_WIDTH,
                  minHeight: ROW_HEIGHT,
                }}
              >
                <CellEditor
                  field={editingField}
                  acknowledgedWriteId={acknowledgedWriteId?.(editingRow.original, editingField.name) ?? 0}
                  subscribeToDiscardedWrites={subscribeToDiscardedWrites}
                  indexed={editingValue}
                  emit={(value, previousValues) =>
                    onCellChange({
                      recordId: editingRow.original.id,
                      recordPath: editingRow.original.path,
                      field: editingField.name,
                      value,
                      ...(previousValues === undefined ? {} : { previousValues }),
                    })
                  }
                  close={() => setEditing(null)}
                  onCreateOption={
                    onCreateOption
                      ? (option, value, previousValues) =>
                          onCreateOption({
                            recordId: editingRow.original.id,
                            recordPath: editingRow.original.path,
                            field: editingField.name,
                            option,
                            value,
                            ...(previousValues === undefined ? {} : { previousValues }),
                          })
                      : undefined
                  }
                  relationExecutor={relationExecutor}
                />
              </fieldset>
            ) : null}
          </div>
        </div>
      )}
    </div>
  );
}
