import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";
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
  OptionColor,
} from "@dohc/workspace-contracts";
import { deriveColumns } from "../columns";
import { recordLabel } from "../recordLabel";
import type { CollectionQueryExecutor } from "../store";
import { Tooltip, useTooltip } from "../tooltip";
import { replayedSelection, withoutDiscarded, type CarriedSelection } from "../useAcknowledgedSelection";
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
// never open an editor. Buttons store no value.
function opensEditor(field: FieldDefinition, relationExecutor: CollectionQueryExecutor | undefined): boolean {
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
const TYPED_INTO: ReadonlySet<FieldDefinition["type"]> = new Set(["text", "number", "url", "person", "select", "multi-select"]);
/** The room a picker keeps between it and the table's right edge. */
const PICKER_EDGE = 8;

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
  onOptionColorChange,
  people,
  onOpenLink,
  onOpenRecord,
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
              cell: (context) => field.type === "button" && renderButton ? renderButton(field, context.row.original) : (
                <FieldCell
                  field={field}
                  label={fieldLabel?.(field.name) ?? field.name}
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
                  editable={!editingDisabled && onCellChange !== undefined && opensEditor(field, relationExecutor)}
                  onOpenLink={onOpenLink}
                />
              ),
            },
          ),
        ),
      ),
    [fields, onCellChange, editingDisabled, personLabel, fieldLabel, relationExecutor, renderButton, onOpenLink],
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
  // A picker is a popover on its cell, as wide as it needs. Other editors fill the cell.
  const editingPickerWidth = editingField ? pickerWidth(editingField, people !== undefined) : null;

  // Each multi-select cell's saved picks that the index does not show yet.
  // They outlive the picker, so a second edit starts from the first.
  const carriedSelections = useRef(new Map<string, CarriedSelection>());
  const carriedSelection = (cell: TableCell) => {
    const key = JSON.stringify([cell.recordId, cell.field]);
    let carried = carriedSelections.current.get(key);
    if (!carried) carriedSelections.current.set(key, (carried = { pending: [] }));
    return carried;
  };
  useEffect(
    () =>
      subscribeToDiscardedWrites?.((writeId) => {
        for (const carried of carriedSelections.current.values()) {
          carried.pending = withoutDiscarded(carried.pending, writeId);
        }
      }),
    [subscribeToDiscardedWrites],
  );

  const scrollRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<HTMLFieldSetElement>(null);
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
    const width = pickerWidth(field, people !== undefined);
    let left = gutter + columnLeft(column);
    // A picker is wider than most cells. Near the right edge it moves left to stay in view.
    if (width !== null && grid) {
      const room = grid.scrollLeft + grid.clientWidth - Math.max(width, columnWidth(column)) - PICKER_EDGE;
      left = Math.min(left, Math.max(grid.scrollLeft, room));
    }
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
    if (onCellChange && !editingDisabled && opensEditor(field, relationExecutor)) startEdit(record.id, column);
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
      if (key === "Escape" && !editingDisabled) setEditing(null);
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
    if (!onCellChange || editingDisabled) return;
    const cell = { recordId: record.id, recordPath: record.path, field: field.name };
    const value = record.values.find((entry) => entry.field === field.name)?.value ?? null;
    if (field.type === "checkbox" && (key === "Enter" || key === " ")) {
      event.preventDefault();
      return onCellChange({ ...cell, value: value !== true });
    }
    if (key === " ") return;
    if (key === "Enter") {
      event.preventDefault();
      if (opensEditor(field, relationExecutor)) startEdit(record.id, at.column);
      return;
    }
    // A relation's records are removed in its picker.
    if (!opensEditor(field, relationExecutor) || field.type === "relation") return;
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
      className={`h-full overflow-auto ${at ? "outline-none" : "focus-visible:-outline-offset-2"}`}
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
            if (field.type === "button") {
              return (
                <div
                  key={field.name}
                  role="columnheader"
                  className="flex h-8 shrink-0 items-center gap-2 border-b border-r border-line px-2 text-[12px] text-muted last:border-r-0"
                  style={{ width: columnWidth(index) }}
                >
                  <FieldTypeIcon type={field.type} className="shrink-0 text-subtle" />
                  <span className="truncate">{label}</span>
                </div>
              );
            }
            return (
              <FieldHeader
                key={field.name}
                name={label}
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
                <CellEditor
                  field={editingField}
                  label={fieldLabel?.(editingField.name) ?? editingField.name}
                  typed={editing.typed}
                  acknowledgedWriteId={acknowledgedWriteId?.(editingRow.original, editingField.name) ?? 0}
                  subscribeToDiscardedWrites={subscribeToDiscardedWrites}
                  carried={editingField.type === "multi-select" ? carriedSelection(editing) : undefined}
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
                  close={closeEditor}
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
