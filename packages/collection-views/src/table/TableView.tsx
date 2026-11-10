import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createColumnHelper, tableFeatures, useTable } from "@tanstack/react-table";
import { defaultRangeExtractor, useVirtualizer } from "@tanstack/react-virtual";
import type { Range } from "@tanstack/react-virtual";
import { ArrowDown, ArrowUp, Maximize2, Plus } from "lucide-react";
import type {
  CollectionQuerySort,
  CollectionRecord,
  CollectionSchema,
  CollectionValue,
  FieldDefinition,
} from "@dohc/workspace-contracts";
import { deriveColumns } from "../columns";
import { recordLabel } from "../recordLabel";
import type { CollectionQueryExecutor } from "../store";
import { Tooltip, useTooltip } from "../tooltip";
import { FieldTypeIcon } from "../values";
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
 * header or giving its sort control keyboard focus shows the words, and
 * screen readers hear them as the control's description.
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
   * Draws a Button field's cell for one record. The host owns what a press
   * does and how the button looks while it runs. Absent, the cell shows
   * the field's name.
   */
  renderButton?: (field: FieldDefinition, record: CollectionRecord) => ReactNode;
  /**
   * Called when the virtualizer renders within NEAR_END_ROWS of the last
   * loaded record. Hosts respond by loading the next page; extra calls are
   * safe — the collection store no-ops without a cursor or while a page is
   * already in flight.
   */
  onNearEnd?: () => void;
  /** Adds a record. The table then ends with a New record row, so even an empty one shows how to start. */
  onNewRecord?: () => void;
}

const TABLE_FEATURES = tableFeatures({});
const COLUMN_WIDTH = 180;
/** The first field names the record, so it gets room to read. */
const TITLE_COLUMN_WIDTH = 260;
/** The gutter left of the fields that holds each row's Open control. */
const OPEN_COLUMN_WIDTH = 36;
const ROW_HEIGHT = 32;
const HEADER_HEIGHT = 32;
/** How close to the end of the loaded rows `onNearEnd` starts firing. */
const NEAR_END_ROWS = 20;
const helper = createColumnHelper<typeof TABLE_FEATURES, CollectionRecord>();

const columnWidth = (index: number) => (index === 0 ? TITLE_COLUMN_WIDTH : COLUMN_WIDTH);

function NewRecordRow(props: { disabled: boolean; openColumn: boolean; width: number; onClick: () => void }) {
  return (
    <div role="row" className="flex shrink-0">
      {props.openColumn ? <div role="gridcell" className="shrink-0" style={{ width: OPEN_COLUMN_WIDTH }} /> : null}
      <div role="gridcell" className="shrink-0 border-b border-line" style={{ width: props.width }}>
        <button
          type="button"
          disabled={props.disabled}
          onClick={props.onClick}
          className="flex h-8 w-full items-center gap-2 px-2 text-left text-[13px] text-muted transition-colors duration-75 hover:bg-hover hover:text-ink dohc-focus-row disabled:cursor-not-allowed disabled:opacity-50"
        >
          <Plus size={14} strokeWidth={1.9} aria-hidden />
          New record
        </button>
      </div>
    </div>
  );
}

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
 * One field's header: its name sorts the table. The tooltip state for a
 * mark's words lives here, so showing them renders this header alone.
 */
function FieldHeader(props: {
  name: string;
  type: FieldDefinition["type"];
  width: number;
  sorted: "asc" | "desc" | null;
  mark: TableFieldMark | undefined;
  onSort: () => void;
}) {
  const { mark, sorted } = props;
  const tooltip = useTooltip();
  return (
    <div
      role="columnheader"
      aria-sort={sorted === "asc" ? "ascending" : sorted === "desc" ? "descending" : undefined}
      className="relative shrink-0 border-b border-r border-line last:border-r-0"
      style={{ width: props.width }}
      {...(mark ? tooltip.hoverProps : {})}
    >
      <button
        type="button"
        className="flex h-full w-full items-center gap-2 px-2 text-left text-[12px] text-muted transition-colors duration-75 hover:bg-hover hover:text-ink"
        onClick={props.onSort}
        {...(mark ? tooltip.focusProps : {})}
      >
        <FieldTypeIcon type={props.type} className="shrink-0 text-subtle" />
        <span className="truncate">{props.name}</span>
        {mark ? (
          <span aria-hidden="true" data-testid="table-field-mark" className="inline-flex shrink-0">
            {mark.icon}
          </span>
        ) : null}
        {sorted ? (
          <span aria-hidden="true" className="ml-auto inline-flex shrink-0 text-accent">
            {sorted === "asc" ? <ArrowUp size={13} strokeWidth={2} /> : <ArrowDown size={13} strokeWidth={2} />}
          </span>
        ) : null}
      </button>
      {mark ? <Tooltip {...tooltip.tooltipProps}>{mark.label}</Tooltip> : null}
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
  renderButton,
  onNearEnd,
  onNewRecord,
}: TableViewProps) {
  const fields = useMemo(
    () => deriveColumns(schema, visibleFields),
    [schema, visibleFields],
  );
  const rowWidth = fields.reduce((total, _field, index) => total + columnWidth(index), 0);

  const [editing, setEditing] = useState<EditingCell | null>(null);

  const columns = useMemo(
    () =>
      helper.columns(
        fields.map((field) => {
          // Relation editing needs query access to the related collection;
          // without an executor the cell stays read-only. Checkboxes commit
          // through onChange and never open an editor. Buttons store no value.
          const editable =
            !editingDisabled &&
            onCellChange !== undefined &&
            field.type !== "checkbox" &&
            field.type !== "button" &&
            (field.type !== "relation" || relationExecutor !== undefined);
          return helper.accessor(
            (record) => record.values.find((entry) => entry.field === field.name),
            {
              id: field.name,
              cell: (context) => field.type === "button" && renderButton ? renderButton(field, context.row.original) : (
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
    [fields, onCellChange, editingDisabled, personLabel, relationExecutor, renderButton],
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
    // The sticky header scrolls with the rows, so they start below it.
    scrollMargin: HEADER_HEIGHT,
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

  const openColumn = Boolean(onOpenRecord);
  return (
    <div
      ref={scrollRef}
      role="grid"
      aria-rowcount={records.length + (onNewRecord ? 2 : 1)}
      className="h-full overflow-auto"
    >
      <div className="w-max min-w-full pb-6 pr-5">
        <div role="row" className="sticky top-0 z-20 flex bg-bg" style={{ height: HEADER_HEIGHT }}>
          {openColumn ? (
            <div role="columnheader" className="shrink-0" style={{ width: OPEN_COLUMN_WIDTH }} />
          ) : null}
          {fields.map((field, index) => {
            // A button stores no value to sort by, so its header is a label.
            if (field.type === "button") {
              return (
                <div
                  key={field.name}
                  role="columnheader"
                  className="flex h-8 shrink-0 items-center gap-2 border-b border-r border-line px-2 text-[12px] text-muted last:border-r-0"
                  style={{ width: columnWidth(index) }}
                >
                  <FieldTypeIcon type={field.type} className="shrink-0 text-subtle" />
                  <span className="truncate">{field.name}</span>
                </div>
              );
            }
            return (
              <FieldHeader
                key={field.name}
                name={field.name}
                type={field.type}
                width={columnWidth(index)}
                sorted={primarySort?.field === field.name ? primarySort.direction : null}
                mark={fieldMarks?.get(field.name)}
                onSort={() => toggleSort(field.name)}
              />
            );
          })}
        </div>
        {records.length === 0 && !onNewRecord ? (
          <div className="py-4 pr-2 text-sm text-muted" style={{ paddingLeft: (openColumn ? OPEN_COLUMN_WIDTH : 0) + 8 }}>
            No records in this collection yet.
          </div>
        ) : null}
        {records.length > 0 ? (
          <div style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
            {virtualItems.map((item) => {
              const row = rows[item.index];
              if (!row) return null;
              return (
                <div
                  key={row.id}
                  role="row"
                  data-index={item.index}
                  className="group absolute left-0 top-0 flex"
                  style={{ height: ROW_HEIGHT, transform: `translateY(${item.start - HEADER_HEIGHT}px)` }}
                >
                  {onOpenRecord ? (
                    <div
                      role="gridcell"
                      className="flex shrink-0 items-center justify-center"
                      style={{ width: OPEN_COLUMN_WIDTH }}
                    >
                      <button
                        type="button"
                        aria-label={`Open ${recordLabel(row.original)}`}
                        title="Open"
                        className="grid size-6 place-items-center rounded-md text-subtle opacity-0 transition-opacity duration-75 hover:bg-hover hover:text-ink focus-visible:opacity-100 group-hover:opacity-100"
                        onClick={() => onOpenRecord(row.original)}
                      >
                        <Maximize2 size={13} strokeWidth={1.9} aria-hidden />
                      </button>
                    </div>
                  ) : null}
                  {row.getAllCells().map((cell, index) => (
                    <div
                      key={cell.id}
                      role="gridcell"
                      className={`flex shrink-0 items-center overflow-hidden border-b border-r border-line px-2 text-ink transition-colors duration-75 last:border-r-0 ${
                        index === 0 ? "font-medium" : ""
                      }`}
                      style={{ width: columnWidth(index) }}
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
                className="dohc-popover absolute z-10 m-0 min-w-0 rounded-md border border-line bg-bg p-1 font-normal"
                style={{
                  top: editingRowIndex * ROW_HEIGHT,
                  left:
                    (openColumn ? OPEN_COLUMN_WIDTH : 0) +
                    fields
                      .slice(0, fields.indexOf(editingField))
                      .reduce((total, _field, index) => total + columnWidth(index), 0),
                  width: columnWidth(fields.indexOf(editingField)),
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
        ) : null}
        {onNewRecord ? (
          <NewRecordRow disabled={editingDisabled} openColumn={openColumn} width={rowWidth} onClick={onNewRecord} />
        ) : null}
      </div>
    </div>
  );
}
