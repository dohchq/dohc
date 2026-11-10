import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { defaultRangeExtractor, useVirtualizer } from "@tanstack/react-virtual";
import type { Range } from "@tanstack/react-virtual";
import { DragDropProvider, useDraggable, useDroppable } from "@dnd-kit/react";
import type { DragEndEvent, DragStartEvent } from "@dnd-kit/react";
import { CalendarDays, CheckSquare, Link, Maximize2, MoreHorizontal, Plus, Square } from "lucide-react";
import type {
  CollectionIndexedValue,
  CollectionRecord,
  CollectionRecordGroup,
  CollectionSchema,
  CollectionValue,
  FieldDefinition,
  OptionColor,
} from "@dohc/workspace-contracts";
import { deriveColumns } from "../columns";
import { OptionColorPicker } from "../colorPicker";
import { recordLabel } from "../recordLabel";
import { asText, FieldValue, fieldDisplayText } from "../table/cells";
import type { CollectionCellChange } from "../table/TableView";
import { OptionPill, optionColor, optionTone, shortDate } from "../values";

export interface BoardViewProps {
  schema: CollectionSchema;
  /**
   * The store's grouped query result, in query order. A group whose value
   * is null holds the records without one. A select field also gets a column
   * for each option no record uses yet, so a card can move there.
   */
  groups: CollectionRecordGroup[];
  /** The field the query grouped by. Dropping a card on a column writes it. */
  groupBy: string;
  /** A view definition's visible field names; omit for every schema field. */
  visibleFields?: readonly string[] | null;
  /**
   * Receives the grouped-field write when a card lands on another column.
   * The host applies it through its own write path; the package never
   * writes.
   */
  onCellChange?: (change: CollectionCellChange) => void;
  /** Receives the card's record when the card is clicked, not dragged. */
  onOpenRecord?: (record: CollectionRecord) => void;
  /** Adds a record whose grouped field holds this column's value. */
  onNewRecord?: (value: CollectionValue) => void;
  /** Saves a color for one of the grouped select field's options. */
  onOptionColorChange?: (option: string, color: OptionColor) => void;
  /** Maps a person field's user id to a display name. Falls back to the id. */
  personLabel?: (userId: string) => string | null;
  /**
   * Hosts with paged queries provide controls and a truthful page count.
   * Both receive the query's group and its index in `groups`. A paged board
   * shows only the groups it was given, not every option.
   */
  groupFooter?: (group: CollectionRecordGroup, index: number) => ReactNode;
  groupCount?: (group: CollectionRecordGroup, index: number) => string;
}

type PersonLabel = (userId: string) => string | null;

/** One board column: a query group, or an option no record uses yet. */
interface BoardColumnModel {
  value: CollectionValue;
  records: CollectionRecord[];
  /** The group's index in the host's `groups`, when the query returned one. */
  groupIndex: number | null;
}

const valueKey = (value: CollectionValue) => JSON.stringify(value, (_key, raw: unknown) =>
  typeof raw === "bigint" ? `${raw}n` : raw);

/**
 * A select field's columns follow its options, so empty ones still show.
 * The query's no-value group comes first when it returned one; values the
 * options do not have (flagged) follow the options. Paged groups are one
 * page of the query, so they stay as given.
 */
function boardColumns(
  groups: CollectionRecordGroup[],
  groupField: FieldDefinition | null,
  paged: boolean,
): BoardColumnModel[] {
  const fromQuery = groups.map((group, groupIndex) => ({ value: group.value, records: group.records, groupIndex }));
  if (paged || groupField?.type !== "select") return fromQuery;
  const byKey = new Map(fromQuery.map((column) => [valueKey(column.value), column]));
  const used = new Set<string>();
  const take = (value: CollectionValue): BoardColumnModel => {
    const key = valueKey(value);
    used.add(key);
    return byKey.get(key) ?? { value, records: [], groupIndex: null };
  };
  const columns = byKey.has(valueKey(null)) ? [take(null)] : [];
  for (const option of groupField.options) columns.push(take(option));
  for (const column of fromQuery) if (!used.has(valueKey(column.value)) && column.value !== null) columns.push(column);
  return columns;
}

function columnLabel(value: CollectionValue, groupField: FieldDefinition | null, personLabel?: PersonLabel): string {
  if (value === null) return groupField ? `No ${groupField.name}` : "No value";
  if (!groupField) return asText(value);
  return fieldDisplayText(groupField, { field: groupField.name, value, validation: { status: "valid" }, resolvedRelations: [] }, personLabel);
}

function isFlagged(record: CollectionRecord): boolean {
  return record.values.some((entry) => entry.validation.status === "flagged");
}

/** One field on a card. Text takes its own lines; the rest sit in a row. */
function CardProperty({ field, indexed, personLabel }: {
  field: FieldDefinition;
  indexed: CollectionIndexedValue | undefined;
  personLabel?: PersonLabel;
}) {
  const value = indexed?.value ?? null;
  if (field.type === "checkbox") {
    const Icon = value === true ? CheckSquare : Square;
    return (
      <span className={`inline-flex items-center gap-1 text-[12px] ${value === true ? "text-ink" : "text-subtle"}`}>
        <Icon size={13} strokeWidth={1.9} aria-hidden />
        {field.name}
      </span>
    );
  }
  if (field.type === "date" && typeof value === "string" && indexed?.validation.status !== "flagged") {
    return (
      <span className="inline-flex items-center gap-1 text-[12px] text-muted">
        <CalendarDays size={13} strokeWidth={1.9} aria-hidden />
        {shortDate(value)}
      </span>
    );
  }
  if (field.type === "number") {
    return <span className="text-[12px] text-muted">{field.name} <span className="tabular-nums text-ink">{asText(value)}</span></span>;
  }
  if (field.type === "relation" || field.type === "url") {
    return (
      <span className="inline-flex min-w-0 items-center gap-1 text-[12px] text-muted">
        <Link size={12} strokeWidth={1.9} aria-hidden className="shrink-0" />
        <span className="truncate">{fieldDisplayText(field, indexed, personLabel)}</span>
      </span>
    );
  }
  if (indexed?.validation.status === "flagged") {
    return <span className="truncate text-[12px] text-warning">{fieldDisplayText(field, indexed, personLabel)}</span>;
  }
  return <FieldValue field={field} indexed={indexed} personLabel={personLabel} />;
}

interface BoardCardProps {
  record: CollectionRecord;
  fields: FieldDefinition[];
  onOpen?: (record: CollectionRecord) => void;
  personLabel?: PersonLabel;
  canDrag: boolean;
}

function BoardCard({ record, fields, onOpen, personLabel, canDrag }: BoardCardProps) {
  const { ref, isDragging } = useDraggable({ id: record.id, disabled: !canDrag });
  // Click opens the record. Enter belongs to the keyboard drag sensor (it
  // lifts the card), so it must not also open; keyboard users open through
  // the card's Open button. The ref swallows the click that can trail a
  // pointer drag: every pointer press resets it, a drag sets it before any
  // click.
  const dragged = useRef(false);
  if (isDragging) dragged.current = true;
  const [titleField, ...rest] = fields;
  const title = titleField
    ? fieldDisplayText(titleField, record.values.find((entry) => entry.field === titleField.name), personLabel)
    : "";
  const shown = rest.flatMap((field) => {
    if (field.type === "button") return [];
    const indexed = record.values.find((entry) => entry.field === field.name);
    if (field.type !== "checkbox" && (indexed === undefined || indexed.value === null)) return [];
    if (Array.isArray(indexed?.value) && indexed.value.length === 0) return [];
    return [{ field, indexed }];
  });
  const lines = shown.filter(({ field }) => field.type === "text");
  const chips = shown.filter(({ field }) => field.type !== "text");
  const name = title || recordLabel(record);
  return (
    <div
      ref={ref}
      role="listitem"
      tabIndex={0}
      aria-label={name}
      data-dragging={isDragging ? "" : undefined}
      className={`group/card relative flex cursor-pointer flex-col gap-2 rounded-lg border border-line bg-bg p-3 transition-colors duration-75 hover:bg-panel dark:bg-panel dark:hover:bg-panel-2 ${
        isDragging ? "opacity-50" : ""
      }`}
      onPointerDown={
        onOpen
          ? () => {
              dragged.current = false;
            }
          : undefined
      }
      onClick={
        onOpen
          ? () => {
              if (!dragged.current) onOpen(record);
            }
          : undefined
      }
    >
      <div className="flex items-start gap-2 pr-6">
        {isFlagged(record) ? (
          <span className="flex h-5 shrink-0 items-center">
            <span
              role="img"
              aria-label="Invalid value"
              title="Invalid value"
              className="size-1.5 rounded-full bg-warning"
            />
          </span>
        ) : null}
        <span className={`min-w-0 break-words text-[13px] font-medium leading-5 ${title ? "text-ink" : "text-muted"}`}>
          {title || "Untitled"}
        </span>
      </div>
      {onOpen ? (
        <button
          type="button"
          aria-label={`Open ${recordLabel(record)}`}
          title="Open"
          className="absolute right-2 top-2 grid size-6 place-items-center rounded-md text-subtle opacity-0 transition-opacity duration-75 hover:bg-hover hover:text-ink focus-visible:opacity-100 group-hover/card:opacity-100"
          onClick={(event) => {
            // The card's own click handler also opens; do not open twice.
            event.stopPropagation();
            onOpen(record);
          }}
        >
          <Maximize2 size={13} strokeWidth={1.9} aria-hidden />
        </button>
      ) : null}
      {lines.map(({ field, indexed }) => (
        <p key={field.name} className="m-0 line-clamp-2 break-words text-[12px] leading-4 text-muted">
          {fieldDisplayText(field, indexed, personLabel)}
        </p>
      ))}
      {chips.length > 0 ? (
        <div className="flex flex-wrap items-center gap-2">
          {chips.map(({ field, indexed }) => (
            <CardProperty key={field.name} field={field} indexed={indexed} personLabel={personLabel} />
          ))}
        </div>
      ) : null}
    </div>
  );
}

/** The column header's menu: the option's color. Closes on a choice, Escape, or a click elsewhere. */
function ColumnMenu({ label, color, onColor }: { label: string; color: OptionColor; onColor: (color: OptionColor) => void }) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", away);
    return () => document.removeEventListener("pointerdown", away);
  }, [open]);
  return (
    <div
      ref={root}
      className="relative"
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOpen(false);
      }}
    >
      <button
        ref={trigger}
        type="button"
        aria-label={`${label} options`}
        aria-expanded={open}
        aria-haspopup="dialog"
        onClick={() => setOpen((value) => !value)}
        className="grid size-6 place-items-center rounded-md text-subtle opacity-0 transition-opacity duration-75 hover:bg-hover hover:text-ink focus-visible:opacity-100 group-hover/column:opacity-100 aria-expanded:opacity-100"
      >
        <MoreHorizontal size={14} strokeWidth={1.9} aria-hidden />
      </button>
      {open ? (
        <div
          role="dialog"
          tabIndex={-1}
          aria-label={`${label} options`}
          onKeyDown={(event) => {
            if (event.key !== "Escape") return;
            event.stopPropagation();
            setOpen(false);
            trigger.current?.focus();
          }}
          className="dohc-popover dohc-pop-in absolute right-0 top-8 z-20 flex flex-col gap-2 rounded-xl border border-line bg-bg p-3"
        >
          <span className="dohc-section-label">Color</span>
          <OptionColorPicker
            label={`Color for ${label}`}
            value={color}
            autoFocus
            onChange={(next) => {
              setOpen(false);
              trigger.current?.focus();
              if (next !== color) onColor(next);
            }}
          />
        </div>
      ) : null}
    </div>
  );
}

interface BoardColumnProps {
  footer?: ReactNode;
  count?: string;
  canDrag: boolean;
  column: BoardColumnModel;
  index: number;
  label: string;
  /** The column's option color; null for a column that is not an option. */
  color: OptionColor | null;
  fields: FieldDefinition[];
  /** The record being dragged, so its source column keeps it mounted. */
  draggingId: string | null;
  onOpen?: (record: CollectionRecord) => void;
  onNew?: () => void;
  onColor?: (color: OptionColor) => void;
  personLabel?: PersonLabel;
}

/**
 * The virtualizer's initial card-height guess: a one-line card plus the
 * wrapper's bottom gap. Mounted cards report their real height through
 * measureElement, so a card with fields only shifts its neighbors.
 */
const CARD_ESTIMATE = 54;

function BoardColumn({
  column,
  index,
  label,
  color,
  fields,
  draggingId,
  onOpen,
  onNew,
  onColor,
  personLabel,
  footer,
  count,
  canDrag,
}: BoardColumnProps) {
  const { ref, isDropTarget } = useDroppable({ id: index });
  // A column mounts only the cards near its viewport (TableView precedent):
  // the column scrolls its own cards, and a 10,000-record group costs the
  // DOM a screenful, not 10,000 cards.
  const scrollRef = useRef<HTMLDivElement>(null);
  // Keep the dragged card mounted while its column scrolls it out of the
  // virtual window (autoscroll near an edge, a keyboard drag down a long
  // column): unmounting it mid-drag would end the operation without a drop.
  // TableView pins its edited row the same way.
  const records = column.records;
  const draggingIndex =
    draggingId === null ? -1 : records.findIndex((record) => record.id === draggingId);
  const rangeExtractor = useCallback(
    (range: Range) => {
      const indexes = defaultRangeExtractor(range);
      if (draggingIndex < 0 || indexes.includes(draggingIndex)) return indexes;
      return [...indexes, draggingIndex].sort((a, b) => a - b);
    },
    [draggingIndex],
  );
  const virtualizer = useVirtualizer({
    count: records.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => CARD_ESTIMATE,
    getItemKey: (itemIndex) => records[itemIndex]?.id ?? itemIndex,
    overscan: 5,
    rangeExtractor,
  });
  const tint = color ? optionTone(color).column : "bg-panel/70";
  return (
    <section
      ref={ref}
      aria-label={label}
      className={`group/column flex max-h-full w-[272px] shrink-0 flex-col rounded-xl px-2 pb-2 ${tint} ${
        isDropTarget ? "ring-2 ring-inset ring-accent" : ""
      }`}
    >
      <div className="flex h-10 shrink-0 items-center gap-2">
        {color ? (
          <OptionPill label={label} color={color} dot />
        ) : (
          <span className="truncate text-[12px] font-medium text-muted">{label}</span>
        )}
        <span data-testid="board-column-count" className="text-[12px] tabular-nums text-subtle">{count ?? records.length}</span>
        <span className="ml-auto flex items-center">
          {color && onColor ? <ColumnMenu label={label} color={color} onColor={onColor} /> : null}
          {onNew ? (
            <button
              type="button"
              aria-label={`New record in ${label}`}
              title="New record"
              onClick={onNew}
              className="grid size-6 place-items-center rounded-md text-subtle opacity-0 transition-opacity duration-75 hover:bg-hover hover:text-ink focus-visible:opacity-100 group-hover/column:opacity-100"
            >
              <Plus size={14} strokeWidth={1.9} aria-hidden />
            </button>
          ) : null}
        </span>
      </div>
      <div
        ref={scrollRef}
        role="list"
        aria-label={label}
        className="min-h-2 overflow-y-auto"
      >
        {/* Clipped: the virtualizer rounds card heights, so at fractional
            display scaling the last card's padding can overhang by a
            fraction of a pixel and show a scrollbar. */}
        <div style={{ height: virtualizer.getTotalSize(), position: "relative", overflow: "hidden" }}>
          {virtualizer.getVirtualItems().map((item) => {
            const record = records[item.index];
            if (!record) return null;
            return (
              <div
                key={record.id}
                ref={virtualizer.measureElement}
                data-index={item.index}
                // The bottom padding is the gap between cards; inside the
                // measured wrapper it rides the virtual offsets.
                className="absolute left-0 top-0 w-full pb-2"
                style={{ transform: `translateY(${item.start}px)` }}
              >
                <BoardCard
                  record={record}
                  fields={fields}
                  onOpen={onOpen}
                  personLabel={personLabel}
                  canDrag={canDrag}
                />
              </div>
            );
          })}
        </div>
      </div>
      {onNew ? (
        <button
          type="button"
          onClick={onNew}
          tabIndex={-1}
          className="flex h-8 shrink-0 items-center gap-2 rounded-md px-3 text-left text-[13px] text-muted transition-colors duration-75 hover:bg-hover hover:text-ink"
        >
          <Plus size={14} strokeWidth={1.9} aria-hidden />
          New
        </button>
      ) : null}
      {footer}
    </section>
  );
}

export function BoardView({
  schema,
  groups,
  groupBy,
  visibleFields,
  onCellChange,
  onOpenRecord,
  onNewRecord,
  onOptionColorChange,
  personLabel,
  groupFooter,
  groupCount,
}: BoardViewProps) {
  // The grouped field names every column, so cards leave it off.
  const fields = useMemo(
    () => deriveColumns(schema, visibleFields).filter((field) => field.name !== groupBy),
    [schema, visibleFields, groupBy],
  );
  const groupField = useMemo(
    () => schema.fields.find((field) => field.name === groupBy) ?? null,
    [schema, groupBy],
  );
  const paged = groupFooter !== undefined;
  const columns = useMemo(() => boardColumns(groups, groupField, paged), [groups, groupField, paged]);
  const cardIndex = useMemo(() => {
    const map = new Map<string, { record: CollectionRecord; columnIndex: number }>();
    columns.forEach((column, columnIndex) => {
      for (const record of column.records) map.set(record.id, { record, columnIndex });
    });
    return map;
  }, [columns]);

  const [draggingId, setDraggingId] = useState<string | null>(null);
  const handleDragStart = (event: DragStartEvent) => {
    const id = event.operation.source?.id;
    setDraggingId(typeof id === "string" ? id : null);
  };
  const handleDragEnd = (event: DragEndEvent) => {
    setDraggingId(null);
    if (!onCellChange || event.canceled) return;
    const { source, target } = event.operation;
    if (!source || !target) return;
    if (typeof source.id !== "string" || typeof target.id !== "number") return;
    const column = columns[target.id];
    const entry = cardIndex.get(source.id);
    if (!column || !entry || entry.columnIndex === target.id) return;
    onCellChange({
      recordId: entry.record.id,
      recordPath: entry.record.path,
      field: groupBy,
      value: column.value,
    });
  };

  if (columns.length === 0 || (cardIndex.size === 0 && !groupFooter && groupField?.type !== "select")) {
    return <div className="px-5 py-6 text-[13px] text-muted">No records in this collection yet.</div>;
  }

  const options = groupField?.type === "select" ? new Set(groupField.options) : null;
  return (
    <DragDropProvider onDragStart={handleDragStart} onDragEnd={handleDragEnd}>
      <div className="flex h-full items-start gap-3 overflow-x-auto px-5 pb-4 pt-3">
        {columns.map((column, index) => {
          const group = column.groupIndex === null ? null : groups[column.groupIndex] ?? null;
          const option = typeof column.value === "string" && options?.has(column.value) ? column.value : null;
          const label = columnLabel(column.value, groupField, personLabel);
          return (
            <BoardColumn
              key={valueKey(column.value)}
              column={column}
              index={index}
              label={label}
              color={option !== null && groupField ? optionColor(groupField, option) : null}
              fields={fields}
              draggingId={draggingId}
              onOpen={onOpenRecord}
              onNew={onNewRecord && (option !== null || column.value === null) ? () => onNewRecord(column.value) : undefined}
              onColor={option !== null && onOptionColorChange ? (color) => onOptionColorChange(option, color) : undefined}
              personLabel={personLabel}
              footer={group && column.groupIndex !== null ? groupFooter?.(group, column.groupIndex) : undefined}
              count={group && column.groupIndex !== null ? groupCount?.(group, column.groupIndex) : undefined}
              canDrag={!!onCellChange}
            />
          );
        })}
      </div>
    </DragDropProvider>
  );
}
