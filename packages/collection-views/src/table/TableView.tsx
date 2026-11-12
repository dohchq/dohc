import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { createColumnHelper, tableFeatures, useTable } from "@tanstack/react-table";
import { defaultRangeExtractor, useVirtualizer } from "@tanstack/react-virtual";
import type { Range } from "@tanstack/react-virtual";
import { ArrowDown, ArrowUp, CircleAlert, Clock, Maximize2, Plus, RotateCw, TriangleAlert, X } from "lucide-react";
import type {
  CollectionIndexedValue,
  CollectionQuerySort,
  CollectionRecord,
  CollectionSchema,
  CollectionValue,
  FieldDefinition,
  OptionColor,
} from "@dohc/workspace-contracts";
import { deriveColumns } from "../columns";
import { recordLabel } from "../recordLabel";
import type { CollectionQueryExecutor } from "../store";
import { Tooltip, useTooltip } from "../tooltip";
import { replayedSelection, useCarriedSelections } from "../useAcknowledgedSelection";
import { FieldTypeIcon } from "../values";
import { asText, CellEditor, FieldCell } from "./cells";
import { composing, pickerWidth, type CellMove, type TablePerson } from "./pickers";

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
 * that write succeeds; the package never writes either. One edit adds one
 * option.
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

/**
 * What the person did to one cell that the host has not confirmed. `value`
 * shows in place of the stored one, and the editor opens on it. The host
 * gives the words: the table cannot know why a change waits or was refused.
 * `discard` gives the change up for good. Absent, the cell offers only Try again.
 */
export type TableCellStatus = { value: CollectionValue } & (
  | { state: "pending" }
  | { state: "waiting"; reason: string }
  | { state: "unconfirmed"; reason: string; retry(): void; discard?(): void }
  | { state: "refused"; reason: string; dismiss(): void }
);

/**
 * The host's unconfirmed cells. Each cell reads its own, so a change of
 * status draws that cell and no other.
 */
export interface TableCellStatuses {
  subscribe(listener: () => void): () => void;
  /** The same object until this cell's status changes. */
  get(recordId: string, field: string): TableCellStatus | undefined;
}

/** A cell the host draws, for a kind of value the table does not know, such as a file. */
export interface TableHostCell {
  /**
   * `tabStop`: the cell's own control is a Tab stop, as in a record's
   * properties. In the table the grid is the stop.
   */
  cell(record: CollectionRecord, tabStop?: boolean): ReactNode;
  /**
   * The cell's editor, drawn in the table's overlay. `close` ends the edit.
   * An editor that holds a value it has not saved marks a control
   * `data-unsaved`, as the table's own do. Absent, the cell does not edit.
   */
  editor?(record: CollectionRecord, close: () => void): ReactNode;
}

/** Text typed into a cell's editor that was neither saved nor cancelled when the editor left the page. */
export interface TableAbandonedDraft {
  recordId: string;
  field: string;
  text: string;
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
  /**
   * Receives what was typed into a text, number, url, or typed person cell
   * when its editor goes with its cell or with the table: the record or the
   * field left the table, or the table closed. The table never saves it.
   */
  onDraftAbandoned?: (draft: TableAbandonedDraft) => void;
  /** Pause controls while keeping the open editor and its draft mounted. */
  editingDisabled?: boolean;
  /**
   * Whether this cell takes an edit now, by click or by key. Absent, every
   * cell does. The host checks again when it saves. Built once by the host:
   * a new function rebuilds every column.
   */
  canEditCell?: (record: CollectionRecord, field: FieldDefinition) => boolean;
  /** Whether this field's header sorts. Absent, every field but a button does. */
  canSortField?: (field: FieldDefinition) => boolean;
  /** The cells whose change the host has not confirmed. One store for the table's life. */
  cellStatuses?: TableCellStatuses;
  /** Cells the host draws, by field key. Built once by the host, as the marks are. */
  hostCells?: ReadonlyMap<string, TableHostCell>;
  /** What a table with no records says. Absent, it says so only when it has no New record row. */
  emptyText?: string;
  /** Highest saved edit id reflected in this record's queried field value. */
  acknowledgedWriteId?: (record: CollectionRecord, field: string) => number;
  /** Explicitly discarded edit ids retire local input without claiming a save. */
  subscribeToDiscardedWrites?: (listener: (writeId: number) => void) => () => void;
  /**
   * A host that returns the save's edit id, as `onCellChange` does, lets a
   * second edit of the same cell start from this one.
   */
  onCreateOption?: (create: CollectionOptionCreate) => number | void;
  /**
   * Changes the color of one option of a select or multi-select field. The
   * host saves it. Absent, the pickers offer no colors.
   */
  onOptionColorChange?: (field: string, option: string, color: OptionColor) => void;
  /**
   * The people a person field can name. With it, a person cell opens a
   * picker. Absent, a person edit is a typed id. Pair it with `personLabel`,
   * so cells show the same names.
   */
  people?: readonly TablePerson[];
  /**
   * Opens a url value. With it, a click on a filled url cell's text opens
   * the link, and a click beside it edits. Built once by the host: a new
   * function rebuilds every column.
   */
  onOpenLink?: (url: string) => void;
  /** Receives the row's record when its Open control is clicked. */
  onOpenRecord?: (record: CollectionRecord) => void;
  /** The record the host shows open, as in a panel beside the table. Its row is marked. */
  openRecordId?: string | null;
  /**
   * Runs the relation picker's queries against a relation field's related
   * collection. Absent means relation cells stay read-only.
   */
  relationExecutor?: CollectionQueryExecutor;
  /** Maps a person field's user id to a display name. Falls back to the id. */
  personLabel?: (userId: string) => string | null;
  /**
   * The name people read for a field. A host that keys fields by id provides
   * it; absent, the key is the name. Built once by the host: a new function
   * rebuilds every column.
   */
  fieldLabel?: (field: string) => string;
  /** The name people read for a record. Absent, its title, name, or filename. */
  recordName?: (record: CollectionRecord) => string;
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
/** A field column's left edge, measured from the first field's. */
const columnLeft = (index: number) => (index === 0 ? 0 : TITLE_COLUMN_WIDTH + (index - 1) * COLUMN_WIDTH);

// Relation editing needs query access to the related collection; without an
// executor the cell stays read-only. Checkboxes commit through onChange and
// never open an editor. Buttons store no value. A host-drawn cell opens only
// the host's own editor.
export function opensEditor(
  field: FieldDefinition,
  relationExecutor: CollectionQueryExecutor | undefined,
  host: TableHostCell | undefined,
): boolean {
  if (host) return host.editor !== undefined;
  return (
    field.type !== "checkbox" &&
    field.type !== "button" &&
    (field.type !== "relation" || relationExecutor !== undefined)
  );
}

/**
 * The fields whose edit a typed character starts: it replaces a text,
 * number, url, or typed person value, and starts the search in a picker.
 */
export const TYPED_INTO: ReadonlySet<FieldDefinition["type"]> = new Set(["text", "number", "url", "person", "select", "multi-select"]);
/** The room a picker keeps between it and the table's right edge. */
const PICKER_EDGE = 8;
/** A host's editor holds a search or a file input, so it gets a popover's room. */
export const HOST_EDITOR_WIDTH = 320;
export const NO_STATUSES: TableCellStatuses = { subscribe: () => () => undefined, get: () => undefined };
const MARK_ICON = { size: 12, strokeWidth: 1.9, "aria-hidden": true } as const;
/** A 16px control inside a cell's line. */
const MARK_BUTTON = "grid size-4 shrink-0 place-items-center rounded text-muted transition-colors duration-75 hover:bg-hover hover:text-ink";
/** What Discard does, since nothing brings the change back. A host that lists the change elsewhere says the same there. */
export const DISCARD_HINT = "Stop trying to save this change. It may already be saved.";

/** Rows and columns each arrow key moves the selection by. */
const ARROWS: Readonly<Record<string, readonly [number, number]>> = {
  ArrowUp: [-1, 0],
  ArrowDown: [1, 0],
  ArrowLeft: [0, -1],
  ArrowRight: [0, 1],
};

const clamp = (index: number, count: number) => Math.max(0, Math.min(index, count - 1));

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
 * The mark of a change the host has not confirmed, after the cell's value.
 * A pending change is a quiet dot. One that waits, could not be confirmed,
 * or was refused shows an icon, with its words on hover and for a screen
 * reader. The selected cell shows the same words under it.
 */
export function StatusMark({ status }: { status: TableCellStatus }) {
  if (status.state === "pending") {
    return (
      <span data-cell-status="pending" className="ml-1 inline-flex shrink-0 items-center">
        <span aria-hidden className="size-1.5 rounded-full bg-subtle" />
        <span className="sr-only">Saving</span>
      </span>
    );
  }
  const Icon = status.state === "waiting" ? Clock : status.state === "unconfirmed" ? TriangleAlert : CircleAlert;
  const tone = status.state === "waiting" ? "text-muted" : status.state === "unconfirmed" ? "text-warning" : "text-danger";
  const action = status.state === "unconfirmed" ? "Try again" : status.state === "refused" ? "Dismiss" : null;
  return (
    <span data-cell-status={status.state} title={status.reason} className="ml-1 inline-flex shrink-0 items-center gap-1">
      <Icon {...MARK_ICON} className={tone} />
      <span className="sr-only">{status.reason}</span>
      {action ? (
        <button
          type="button"
          // The grid is the Tab stop. Tab on the selected cell reaches the same action under it.
          tabIndex={-1}
          aria-label={action}
          title={action}
          className={MARK_BUTTON}
          onClick={(event) => {
            // The press acts on the change. It neither selects nor edits the cell.
            event.stopPropagation();
            if (status.state === "unconfirmed") status.retry();
            else if (status.state === "refused") status.dismiss();
          }}
        >
          {status.state === "unconfirmed" ? <RotateCw {...MARK_ICON} /> : <X {...MARK_ICON} />}
        </button>
      ) : null}
      {status.state === "unconfirmed" && status.discard ? (
        <button
          type="button"
          tabIndex={-1}
          aria-label="Discard"
          title={DISCARD_HINT}
          className={MARK_BUTTON}
          onClick={(event) => {
            event.stopPropagation();
            status.discard?.();
          }}
        >
          <X {...MARK_ICON} />
        </button>
      ) : null}
    </span>
  );
}

/** A status's value in place of the stored one. */
export function shownValue(
  field: string,
  indexed: CollectionIndexedValue | undefined,
  status: TableCellStatus | undefined,
): CollectionIndexedValue | undefined {
  if (!status) return indexed;
  return { field, value: status.value, validation: { status: "valid" }, resolvedRelations: indexed?.resolvedRelations ?? [] };
}

/**
 * One field cell's content. It reads its own status, so a change the host
 * has not confirmed draws this cell alone.
 */
function CellContent(props: {
  field: FieldDefinition;
  label: string;
  record: CollectionRecord;
  indexed: CollectionIndexedValue | undefined;
  statuses: TableCellStatuses;
  host: TableHostCell | undefined;
  /** The cell opens an editor. */
  editable: boolean;
  /** Takes a checkbox's toggle. Absent, the box is disabled. */
  onToggle: ((change: CollectionCellChange) => number) | undefined;
  personLabel: ((userId: string) => string | null) | undefined;
  onOpenLink: ((url: string) => void) | undefined;
}) {
  const { field, record, statuses, host, onToggle } = props;
  const status = useSyncExternalStore(statuses.subscribe, () => statuses.get(record.id, field.name));
  const content = host ? host.cell(record) : (
    <FieldCell
      field={field}
      label={props.label}
      indexed={shownValue(field.name, props.indexed, status)}
      personLabel={props.personLabel}
      onChange={
        onToggle
          ? (value) => onToggle({ recordId: record.id, recordPath: record.path, field: field.name, value })
          : undefined
      }
      editable={props.editable}
      onOpenLink={props.onOpenLink}
    />
  );
  if (!status) return content;
  return (
    <>
      <span className="flex min-w-0 flex-1 items-center overflow-hidden">{content}</span>
      <StatusMark status={status} />
    </>
  );
}

/**
 * One cell, addressed by record id and field key so the selection and an
 * open edit survive a store refresh (a new records array), a sort-driven row
 * move, and scrolling. Row index and record object identity are both
 * unstable across refreshes; this pair is not.
 */
interface TableCell {
  recordId: string;
  field: string;
}

/** The cell whose editor is open, and the character that opened it, if one did. */
interface EditingCell extends TableCell {
  typed?: string;
  /** The editor's left edge. A picker near the table's right edge sits left of its cell's. */
  left: number;
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
  /** Absent, the header is a label: a button field, or one the host cannot sort by. */
  onSort: (() => void) | undefined;
}) {
  const { mark, sorted } = props;
  const tooltip = useTooltip();
  if (!props.onSort) {
    return (
      <div
        role="columnheader"
        className="relative flex h-8 shrink-0 items-center gap-2 border-b border-r border-line px-2 text-[12px] text-muted last:border-r-0"
        style={{ width: props.width }}
        {...(mark ? tooltip.hoverProps : {})}
      >
        <FieldTypeIcon type={props.type} className="shrink-0 text-subtle" />
        <span className="truncate">{props.name}</span>
        {mark ? (
          // With no sort control to describe, the mark takes focus for its words.
          <span
            role="img"
            tabIndex={0}
            aria-label={mark.label}
            data-testid="table-field-mark"
            className="inline-flex shrink-0 rounded"
            {...tooltip.focusProps}
          >
            {mark.icon}
          </span>
        ) : null}
        {mark ? <Tooltip {...tooltip.tooltipProps}>{mark.label}</Tooltip> : null}
      </div>
    );
  }
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
  onDraftAbandoned,
  editingDisabled = false,
  canEditCell,
  canSortField,
  cellStatuses,
  hostCells,
  emptyText,
  acknowledgedWriteId,
  subscribeToDiscardedWrites,
  onCreateOption,
  onOptionColorChange,
  people,
  onOpenLink,
  onOpenRecord,
  openRecordId,
  relationExecutor,
  personLabel,
  fieldLabel,
  recordName,
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

  const [selected, setSelected] = useState<TableCell | null>(null);
  const [editing, setEditing] = useState<EditingCell | null>(null);

  // Selection stays out of the columns: a click or an arrow key must not
  // rebuild them.
  const columns = useMemo(
    () =>
      helper.columns(
        fields.map((field) =>
          helper.accessor(
            (record) => record.values.find((entry) => entry.field === field.name),
            {
              id: field.name,
              cell: (context) => {
                const record = context.row.original;
                if (field.type === "button" && renderButton) return renderButton(field, record);
                const host = hostCells?.get(field.name);
                const edits = onCellChange !== undefined && !editingDisabled && (canEditCell?.(record, field) ?? true);
                const editable = edits && opensEditor(field, relationExecutor, host);
                const label = fieldLabel?.(field.name) ?? field.name;
                // A host with no unconfirmed changes and no cells of its own gets the plain cell, which reads no store.
                if (!cellStatuses && !host) {
                  return (
                    <FieldCell
                      field={field}
                      label={label}
                      indexed={context.getValue()}
                      personLabel={personLabel}
                      onChange={
                        edits
                          ? (value) => onCellChange({ recordId: record.id, recordPath: record.path, field: field.name, value })
                          : undefined
                      }
                      editable={editable}
                      onOpenLink={onOpenLink}
                    />
                  );
                }
                return (
                  <CellContent
                    field={field}
                    label={label}
                    record={record}
                    indexed={context.getValue()}
                    statuses={cellStatuses ?? NO_STATUSES}
                    host={host}
                    editable={editable}
                    onToggle={edits ? onCellChange : undefined}
                    personLabel={personLabel}
                    onOpenLink={onOpenLink}
                  />
                );
              },
            },
          ),
        ),
      ),
    [fields, onCellChange, editingDisabled, canEditCell, cellStatuses, hostCells, personLabel, fieldLabel, relationExecutor, renderButton, onOpenLink],
  );

  const table = useTable({
    features: TABLE_FEATURES,
    columns,
    data: records,
    getRowId: (record) => record.id,
  });
  const rows = table.getRowModel().rows;

  const selectedRowIndex = useMemo(
    () => (selected === null ? -1 : rows.findIndex((row) => row.id === selected.recordId)),
    [rows, selected],
  );
  const selectedColumnIndex =
    selected === null ? -1 : fields.findIndex((field) => field.name === selected.field);
  // Where the selected cell is, while the table shows its record and field.
  const at =
    selectedRowIndex >= 0 && selectedColumnIndex >= 0
      ? { row: selectedRowIndex, column: selectedColumnIndex }
      : null;
  const selectedCellId = useId();

  const editingRowIndex =
    editing === null ? -1 : rows.findIndex((row) => row.id === editing.recordId);
  const editingRow = editingRowIndex >= 0 ? rows[editingRowIndex] : undefined;
  const editingField =
    editing === null ? undefined : fields.find((field) => field.name === editing.field);
  const editingValue = editingRow?.original.values.find((entry) => entry.field === editingField?.name);
  const editingColumn = editingField ? fields.indexOf(editingField) : -1;
  const editingHost = editingField ? hostCells?.get(editingField.name) : undefined;
  // A picker or a host's editor is a popover on its cell, as wide as it needs. Other editors fill the cell.
  const popoverWidth = (field: FieldDefinition) =>
    hostCells?.has(field.name) ? HOST_EDITOR_WIDTH : pickerWidth(field, people !== undefined);
  const editingPickerWidth = editingField ? popoverWidth(editingField) : null;

  // The selected cell's status, read here so its words can show under it.
  const statuses = cellStatuses ?? NO_STATUSES;
  const selectedStatus = useSyncExternalStore(statuses.subscribe, () =>
    selected === null ? undefined : statuses.get(selected.recordId, selected.field),
  );
  const noteId = useId();
  const noteRef = useRef<HTMLDivElement>(null);
  const hasEditor = (field: FieldDefinition) => opensEditor(field, relationExecutor, hostCells?.get(field.name));
  /** Whether the cell takes an edit now. Every edit path asks, by click or by key. */
  const editsAt = (record: CollectionRecord, field: FieldDefinition) =>
    onCellChange !== undefined && !editingDisabled && (canEditCell?.(record, field) ?? true);

  const carriedSelections = useCarriedSelections(subscribeToDiscardedWrites);
  const carriedSelection = (cell: TableCell) => carriedSelections(JSON.stringify([cell.recordId, cell.field]));

  const scrollRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<HTMLFieldSetElement>(null);
  // Escape on the grid cancelled the open edit, so what it held is not kept.
  const cancelled = useRef(false);
  const gutter = onOpenRecord ? OPEN_COLUMN_WIDTH : 0;

  // A key that moves the selection or closes the editor sets this, always
  // with a state change. After that render the grid takes focus and scrolls
  // the selected cell clear of its edges and its sticky header.
  const reveal = useRef(false);
  useLayoutEffect(() => {
    if (!reveal.current) return;
    reveal.current = false;
    const grid = scrollRef.current;
    if (!grid) return;
    grid.focus({ preventScroll: true });
    if (!at) return;
    const top = at.row * ROW_HEIGHT;
    const bottom = top + ROW_HEIGHT + HEADER_HEIGHT;
    if (top < grid.scrollTop) grid.scrollTop = top;
    else if (bottom > grid.scrollTop + grid.clientHeight) grid.scrollTop = bottom - grid.clientHeight;
    // The first field brings the Open gutter back with it.
    const left = at.column === 0 ? 0 : gutter + columnLeft(at.column);
    const right = gutter + columnLeft(at.column + 1);
    if (left < grid.scrollLeft) grid.scrollLeft = left;
    else if (right > grid.scrollLeft + grid.clientWidth) grid.scrollLeft = right - grid.clientWidth;
  });

  const select = (row: number, column: number) => {
    const record = rows[row];
    const field = fields[column];
    if (!record || !field) return;
    setSelected({ recordId: record.id, field: field.name });
    reveal.current = true;
  };

  // One cell on or back, wrapping to the next or previous row. Null past
  // either end of the table.
  const beside = (row: number, column: number, back: boolean): [number, number] | null => {
    const next = column + (back ? -1 : 1);
    if (next >= 0 && next < fields.length) return [row, next];
    const wrapped = row + (back ? -1 : 1);
    if (wrapped < 0 || wrapped >= rows.length) return null;
    return [wrapped, back ? fields.length - 1 : 0];
  };

  const closeEditor = (to?: CellMove | "away") => {
    setEditing(null);
    // A press away closes the editor too, and focus belongs to what was pressed.
    if (to === "away" || !editorRef.current?.contains(document.activeElement)) return;
    reveal.current = true;
    if (!to || !editingField) return;
    const column = fields.indexOf(editingField);
    if (to === "down") select(clamp(editingRowIndex + 1, rows.length), column);
    else select(...(beside(editingRowIndex, column, to === "previous") ?? [editingRowIndex, column]));
  };

  const startEdit = (recordId: string, column: number, typed?: string) => {
    const field = fields[column];
    if (!field) return;
    const grid = scrollRef.current;
    const width = popoverWidth(field);
    let left = gutter + columnLeft(column);
    // A picker is wider than most cells. Near the right edge it moves left to stay in view.
    if (width !== null && grid) {
      const room = grid.scrollLeft + grid.clientWidth - Math.max(width, columnWidth(column)) - PICKER_EDGE;
      left = Math.min(left, Math.max(grid.scrollLeft, room));
    }
    cancelled.current = false;
    setEditing({ recordId, field: field.name, typed, left });
  };

  // A picker that opens low in the table scrolls into view, down to its last row.
  const editingKey = editing && editingPickerWidth !== null ? `${editing.recordId}:${editing.field}` : null;
  useLayoutEffect(() => {
    const grid = scrollRef.current;
    const editor = editorRef.current;
    if (editingKey === null || !grid || !editor) return;
    const top = editor.offsetTop;
    const needed = HEADER_HEIGHT + top + editor.offsetHeight - grid.clientHeight;
    if (needed > grid.scrollTop) grid.scrollTop = Math.min(needed, top);
  }, [editingKey]);

  const clickCell = (row: number, column: number) => {
    // An editor holding a value it cannot save keeps its place and takes
    // focus, as a dialog's field does, so the value is not lost unseen.
    const held = editorRef.current?.querySelector<HTMLElement>("[data-unsaved]");
    if (held) return held.focus();
    const record = rows[row];
    const field = fields[column];
    if (!record || !field) return;
    setSelected({ recordId: record.id, field: field.name });
    if (editsAt(record.original, field) && hasEditor(field)) startEdit(record.id, column);
    // A host-drawn button keeps the focus its press took.
    else if (field.type !== "button") scrollRef.current?.focus({ preventScroll: true });
  };

  const onGridKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    // Header buttons, row controls, and the open editor keep their own keys.
    if (event.target !== event.currentTarget || composing(event)) return;
    const { key } = event;
    // Ctrl+Enter, or ⌘ on a Mac, opens the record. Other shortcuts are the app's.
    const opens = (event.ctrlKey || event.metaKey) && key === "Enter";
    if (event.altKey || ((event.ctrlKey || event.metaKey) && !opens)) return;
    if (editorRef.current) {
      // An editor left open without focus takes the first Escape.
      if (key === "Escape" && !editingDisabled) {
        cancelled.current = true;
        setEditing(null);
      }
      return;
    }
    if (!at) {
      if (ARROWS[key]) {
        event.preventDefault();
        select(0, 0);
      }
      return;
    }
    const record = rows[at.row]?.original;
    const field = fields[at.column];
    if (!record || !field) return;
    if (opens) {
      event.preventDefault();
      return onOpenRecord?.(record);
    }
    if (key === "Tab") {
      // A cell that says what went wrong offers its action before the next cell.
      const action = event.shiftKey ? null : noteRef.current?.querySelector<HTMLElement>("button");
      if (action) {
        event.preventDefault();
        return action.focus();
      }
      const to = beside(at.row, at.column, event.shiftKey);
      // Past the first or last cell, Tab leaves the grid.
      if (!to) return;
      event.preventDefault();
      return select(...to);
    }
    if (key === "Escape") return setSelected(null);
    const arrow = ARROWS[key];
    if (arrow) {
      event.preventDefault();
      return select(clamp(at.row + arrow[0], rows.length), clamp(at.column + arrow[1], fields.length));
    }
    // Space scrolls a focused scroller. Here it only ticks a checkbox.
    if (key === " ") event.preventDefault();
    if (!onCellChange || !editsAt(record, field)) return;
    const cell = { recordId: record.id, recordPath: record.path, field: field.name };
    // The keys act on what the cell shows.
    const status = statuses.get(record.id, field.name);
    const value = status ? status.value : record.values.find((entry) => entry.field === field.name)?.value ?? null;
    if (field.type === "checkbox" && (key === "Enter" || key === " ")) {
      event.preventDefault();
      return onCellChange({ ...cell, value: value !== true });
    }
    if (key === " ") return;
    if (key === "Enter") {
      event.preventDefault();
      if (hasEditor(field)) startEdit(record.id, at.column);
      return;
    }
    // A relation's records are removed in its picker, and a host's value in the host's editor.
    if (!hasEditor(field) || field.type === "relation" || hostCells?.has(field.name)) return;
    if (key === "Delete" || key === "Backspace") {
      event.preventDefault();
      if (field.type === "multi-select") {
        // Clear what the picker would show, saved picks the index lacks
        // included, and carry the clear so the next edit starts from it.
        const carried = carriedSelection({ recordId: record.id, field: field.name });
        const acknowledged = acknowledgedWriteId?.(record, field.name) ?? 0;
        const pending = carried.pending.filter((change) => change.writeId > acknowledged);
        const observed = value === null ? [] : Array.isArray(value) ? value.map(asText) : [asText(value)];
        const { selected, previousValues } = replayedSelection(value, observed, pending);
        if (selected.length === 0) return;
        const writeId = onCellChange({ ...cell, value: [], previousValues });
        carried.pending = [...pending, { writeId, added: [], removed: selected }];
      } else if (value !== null) onCellChange({ ...cell, value: null });
    } else if (key.length === 1 && TYPED_INTO.has(field.type)) {
      event.preventDefault();
      startEdit(record.id, at.column, key);
    }
  };

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

  // The words of the selected cell's status, while no editor covers them.
  const note = at && editing === null && selectedStatus && selectedStatus.state !== "pending" ? selectedStatus : null;
  const leaveNote = () => scrollRef.current?.focus({ preventScroll: true });

  const openColumn = Boolean(onOpenRecord);
  return (
    <div
      ref={scrollRef}
      role="grid"
      aria-rowcount={records.length + (onNewRecord ? 2 : 1)}
      aria-activedescendant={at ? selectedCellId : undefined}
      // One Tab stop for every cell: arrow keys move inside the grid.
      tabIndex={rows.length > 0 && fields.length > 0 ? 0 : undefined}
      // The selected cell's ring shows where the keys act. With no cell
      // selected the grid wears the halo, inset so its scroller cannot clip it.
      // The table's layers, such as its sticky header, stack among themselves
      // and never over a menu of the page that holds the table.
      className={`isolate h-full overflow-auto ${at ? "outline-none" : "focus-visible:-outline-offset-2"}`}
      onKeyDown={onGridKeyDown}
    >
      <div className="w-max min-w-full pb-6 pr-5">
        <div role="row" className="sticky top-0 z-20 flex bg-bg" style={{ height: HEADER_HEIGHT }}>
          {openColumn ? (
            <div role="columnheader" className="shrink-0" style={{ width: OPEN_COLUMN_WIDTH }} />
          ) : null}
          {fields.map((field, index) => {
            const label = fieldLabel?.(field.name) ?? field.name;
            // A button stores no value to sort by, so its header is a label.
            const sorts = field.type !== "button" && (canSortField?.(field) ?? true);
            return (
              <FieldHeader
                key={field.name}
                name={label}
                type={field.type}
                width={columnWidth(index)}
                sorted={sorts && primarySort?.field === field.name ? primarySort.direction : null}
                mark={field.type === "button" ? undefined : fieldMarks?.get(field.name)}
                onSort={sorts ? () => toggleSort(field.name) : undefined}
              />
            );
          })}
        </div>
        {records.length === 0 && (emptyText !== undefined || !onNewRecord) ? (
          <div className="py-4 pr-2 text-sm text-muted" style={{ paddingLeft: (openColumn ? OPEN_COLUMN_WIDTH : 0) + 8 }}>
            {emptyText ?? "No records in this collection yet."}
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
                  aria-current={row.id === openRecordId ? "true" : undefined}
                  className="group absolute left-0 top-0 flex aria-[current=true]:bg-selected"
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
                        // Space on a selected cell opens its record, so the
                        // rows add no Tab stops.
                        tabIndex={-1}
                        aria-label={`Open ${recordName?.(row.original) ?? recordLabel(row.original)}`}
                        title="Open"
                        className="grid size-6 place-items-center rounded-md text-subtle opacity-0 transition-opacity duration-75 hover:bg-hover hover:text-ink focus-visible:opacity-100 group-hover:opacity-100"
                        onClick={() => onOpenRecord(row.original)}
                      >
                        <Maximize2 size={13} strokeWidth={1.9} aria-hidden />
                      </button>
                    </div>
                  ) : null}
                  {row.getAllCells().map((cell, index) => {
                    const isSelected = at?.row === item.index && at.column === index;
                    return (
                      <div
                        key={cell.id}
                        role="gridcell"
                        id={isSelected ? selectedCellId : undefined}
                        aria-selected={isSelected || undefined}
                        aria-describedby={isSelected && note ? noteId : undefined}
                        className={`flex shrink-0 items-center overflow-hidden border-b border-r border-line px-2 text-ink transition-colors duration-75 last:border-r-0 ${
                          index === 0 ? "font-medium" : ""
                        } ${isSelected ? "ring-2 ring-inset ring-accent" : ""}`}
                        style={{ width: columnWidth(index) }}
                        onClick={(event) => {
                          // A dialog the host's button opens is the cell's
                          // child in React, not on the page.
                          if (event.currentTarget.contains(event.target as Node)) clickCell(item.index, index);
                        }}
                      >
                        <table.FlexRender cell={cell} />
                      </div>
                    );
                  })}
                </div>
              );
            })}
            {editing && editingRow && editingField && onCellChange ? (
              <fieldset
                // One editor for every cell type, drawn in an overlay above
                // the rows and anchored to the cell's top edge. Growing
                // downward from there, a tall editor (a picker's option
                // list) is never clipped by the fixed row height and never
                // extends up under the column header, which would steal its
                // clicks. Remounting on cell switch resets the editor's
                // inputs to the next cell's value.
                key={`${editing.recordId}:${editing.field}`}
                ref={editorRef}
                data-cell-editor=""
                disabled={editingDisabled}
                onBlurCapture={(event) => {
                  if (editingDisabled) event.stopPropagation();
                }}
                className={
                  editingPickerWidth === null
                    ? "dohc-popover absolute z-10 m-0 min-w-0 rounded-md border border-line bg-bg p-1 font-normal"
                    : "dohc-popover dohc-pop-in absolute z-10 m-0 min-w-0 rounded-lg border border-line bg-bg p-0 font-normal"
                }
                style={{
                  top: editingRowIndex * ROW_HEIGHT,
                  left: editing.left,
                  // A picker covers its cell, so a press on the cell is a press on the picker.
                  width: Math.max(columnWidth(editingColumn), editingPickerWidth ?? 0),
                  minHeight: ROW_HEIGHT,
                }}
              >
                {editingHost ? editingHost.editor?.(editingRow.original, () => closeEditor()) : <CellEditor
                  field={editingField}
                  label={fieldLabel?.(editingField.name) ?? editingField.name}
                  typed={editing.typed}
                  acknowledgedWriteId={acknowledgedWriteId?.(editingRow.original, editingField.name) ?? 0}
                  subscribeToDiscardedWrites={subscribeToDiscardedWrites}
                  carried={editingField.type === "multi-select" ? carriedSelection(editing) : undefined}
                  // The edit starts from what the cell shows, so a refused value is not typed twice.
                  indexed={shownValue(editingField.name, editingValue, statuses.get(editing.recordId, editing.field))}
                  emit={(value, previousValues) =>
                    onCellChange({
                      recordId: editingRow.original.id,
                      recordPath: editingRow.original.path,
                      field: editingField.name,
                      value,
                      ...(previousValues === undefined ? {} : { previousValues }),
                    })
                  }
                  close={closeEditor}
                  abandon={
                    onDraftAbandoned
                      ? (text) => {
                          if (!cancelled.current) onDraftAbandoned({ recordId: editing.recordId, field: editing.field, text });
                        }
                      : undefined
                  }
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
                  onOptionColorChange={
                    onOptionColorChange
                      ? (option, color) => onOptionColorChange(editingField.name, option, color)
                      : undefined
                  }
                  people={people}
                  relationExecutor={relationExecutor}
                />}
              </fieldset>
            ) : null}
            {note && at ? (
              <div
                ref={noteRef}
                id={noteId}
                role="note"
                data-cell-note={note.state}
                className="dohc-popover absolute z-10 flex max-w-80 flex-col items-start gap-1 rounded-md border border-line bg-bg px-2 py-1 text-[12px] font-normal"
                style={{ top: (at.row + 1) * ROW_HEIGHT, left: gutter + columnLeft(at.column), minWidth: columnWidth(at.column) }}
                onKeyDown={(event) => {
                  if (event.key !== "Escape" && event.key !== "Tab") return;
                  // Tab goes on to the next cell. Shift+Tab and Escape go back to this one.
                  event.preventDefault();
                  event.stopPropagation();
                  // Tab goes through the note's actions before it leaves.
                  const actions = [...event.currentTarget.querySelectorAll<HTMLElement>("button")];
                  const action = event.key === "Tab" ? actions[actions.indexOf(event.target as HTMLElement) + (event.shiftKey ? -1 : 1)] : undefined;
                  if (action) return action.focus();
                  const to = event.key === "Tab" && !event.shiftKey ? beside(at.row, at.column, false) : null;
                  if (to) select(...to);
                  else leaveNote();
                }}
              >
                <p className={`m-0 ${note.state === "waiting" ? "text-muted" : note.state === "unconfirmed" ? "text-warning" : "text-danger"}`}>
                  {note.reason}
                </p>
                <div className="flex gap-1 empty:hidden">
                {note.state === "unconfirmed" || note.state === "refused" ? (
                  <button
                    type="button"
                    // Tab on the selected cell reaches it.
                    tabIndex={-1}
                    className="h-6 rounded-md border border-line px-2 text-[12px] text-ink transition-colors duration-75 hover:bg-hover"
                    onClick={() => {
                      // The words go once the action runs, so the grid takes the keys back first.
                      leaveNote();
                      if (note.state === "unconfirmed") note.retry();
                      else note.dismiss();
                    }}
                  >
                    {note.state === "unconfirmed" ? "Try again" : "Dismiss"}
                  </button>
                ) : null}
                {note.state === "unconfirmed" && note.discard ? (
                  <button
                    type="button"
                    tabIndex={-1}
                    title={DISCARD_HINT}
                    className="h-6 rounded-md border border-line px-2 text-[12px] text-ink transition-colors duration-75 hover:bg-hover"
                    onClick={() => {
                      leaveNote();
                      note.discard?.();
                    }}
                  >
                    Discard
                  </button>
                ) : null}
                </div>
              </div>
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
