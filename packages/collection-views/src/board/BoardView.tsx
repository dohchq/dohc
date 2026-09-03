import { useMemo, useRef } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { DragDropProvider, useDraggable, useDroppable } from "@dnd-kit/react";
import type { DragEndEvent } from "@dnd-kit/react";
import type {
  CollectionRecord,
  CollectionRecordGroup,
  CollectionSchema,
  FieldDefinition,
} from "@dohc/workspace-contracts";
import { deriveColumns } from "../columns";
import { recordLabel } from "../recordLabel";
import { asText, FieldCell, fieldDisplayText } from "../table/cells";
import type { CollectionCellChange } from "../table/TableView";

export interface BoardViewProps {
  schema: CollectionSchema;
  /**
   * The store's grouped query result: one column per group, in query order.
   * A group whose value is null holds the records without one.
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
  /** Maps a person field's user id to a display name. Falls back to the id. */
  personLabel?: (userId: string) => string | null;
}

type PersonLabel = (userId: string) => string | null;

function groupLabel(
  group: CollectionRecordGroup,
  groupField: FieldDefinition | null,
  personLabel?: PersonLabel,
): string {
  if (group.value === null) return "No value";
  if (!groupField) return asText(group.value);
  return fieldDisplayText(
    groupField,
    {
      field: groupField.name,
      value: group.value,
      validation: { status: "valid" },
      resolvedRelations: [],
    },
    personLabel,
  );
}

function isFlagged(record: CollectionRecord): boolean {
  return record.values.some((entry) => entry.validation.status === "flagged");
}

interface BoardCardProps {
  record: CollectionRecord;
  fields: FieldDefinition[];
  onOpen?: (record: CollectionRecord) => void;
  personLabel?: PersonLabel;
}

function BoardCard({ record, fields, onOpen, personLabel }: BoardCardProps) {
  const { ref, isDragging } = useDraggable({ id: record.id });
  // Click opens the record. Enter belongs to the keyboard drag sensor (it
  // lifts the card), so it must not also open; keyboard users open through
  // the card's Open button. The ref swallows the click that can trail a
  // pointer drag: every pointer press resets it, a drag sets it before any
  // click.
  const dragged = useRef(false);
  if (isDragging) dragged.current = true;
  const [titleField, ...stripFields] = fields;
  const title = titleField
    ? fieldDisplayText(
        titleField,
        record.values.find((entry) => entry.field === titleField.name),
        personLabel,
      )
    : "";
  const strip = stripFields.filter((field) => {
    const indexed = record.values.find((entry) => entry.field === field.name);
    return indexed !== undefined && indexed.value !== null;
  });
  return (
    <div
      ref={ref}
      role="listitem"
      tabIndex={0}
      aria-label={title || record.id}
      className={`group rounded-lg border border-line bg-panel p-2 ${isDragging ? "opacity-50" : ""}`}
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
      <div className="flex items-center gap-1.5">
        {isFlagged(record) ? (
          <span
            role="img"
            aria-label="Invalid value"
            title="Invalid value"
            className="size-1.5 shrink-0 rounded-full bg-warning"
          />
        ) : null}
        <span className="truncate text-[13px] text-ink">{title}</span>
        {onOpen ? (
          <button
            type="button"
            aria-label={`Open ${recordLabel(record)}`}
            className="ml-auto shrink-0 rounded border border-line bg-panel px-1.5 text-[11px] text-muted opacity-0 transition-opacity duration-75 hover:text-ink focus-visible:opacity-100 group-hover:opacity-100"
            onClick={(event) => {
              // The card's own click handler also opens; do not open twice.
              event.stopPropagation();
              onOpen(record);
            }}
          >
            Open
          </button>
        ) : null}
      </div>
      {strip.length > 0 ? (
        <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-muted">
          {strip.map((field) => (
            <FieldCell
              key={field.name}
              field={field}
              indexed={record.values.find((entry) => entry.field === field.name)}
              personLabel={personLabel}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}

interface BoardColumnProps {
  group: CollectionRecordGroup;
  index: number;
  label: string;
  fields: FieldDefinition[];
  onOpen?: (record: CollectionRecord) => void;
  personLabel?: PersonLabel;
}

/**
 * The virtualizer's initial card-height guess: a one-line card plus the
 * wrapper's bottom gap. Mounted cards report their real height through
 * measureElement, so a card with a field strip only shifts its neighbors.
 */
const CARD_ESTIMATE = 48;

function BoardColumn({ group, index, label, fields, onOpen, personLabel }: BoardColumnProps) {
  const { ref, isDropTarget } = useDroppable({ id: index });
  // A column mounts only the cards near its viewport (TableView precedent):
  // the column scrolls its own cards, and a 10,000-record group costs the
  // DOM a screenful, not 10,000 cards.
  const scrollRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: group.records.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => CARD_ESTIMATE,
    getItemKey: (itemIndex) => group.records[itemIndex]?.id ?? itemIndex,
    overscan: 5,
  });
  return (
    <section
      ref={ref}
      aria-label={label}
      className={`flex max-h-full w-64 shrink-0 flex-col rounded-lg p-2 ${
        isDropTarget ? "bg-line/60" : "bg-panel-2"
      }`}
    >
      <div className="flex items-center gap-1.5 px-1 pb-2">
        <span className="truncate text-[12px] font-medium text-muted">{label}</span>
        <span className="font-mono text-[11px] text-subtle">{group.records.length}</span>
      </div>
      <div
        ref={scrollRef}
        role="list"
        aria-label={label}
        className="min-h-8 overflow-y-auto"
      >
        <div style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
          {virtualizer.getVirtualItems().map((item) => {
            const record = group.records[item.index];
            if (!record) return null;
            return (
              <div
                key={record.id}
                ref={virtualizer.measureElement}
                data-index={item.index}
                // The bottom padding is the gap the flex column's gap-2 gave;
                // inside the measured wrapper it rides the virtual offsets.
                className="absolute left-0 top-0 w-full pb-2"
                style={{ transform: `translateY(${item.start}px)` }}
              >
                <BoardCard
                  record={record}
                  fields={fields}
                  onOpen={onOpen}
                  personLabel={personLabel}
                />
              </div>
            );
          })}
        </div>
      </div>
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
  personLabel,
}: BoardViewProps) {
  const fields = useMemo(() => deriveColumns(schema, visibleFields), [schema, visibleFields]);
  const groupField = useMemo(
    () => schema.fields.find((field) => field.name === groupBy) ?? null,
    [schema, groupBy],
  );
  const cardIndex = useMemo(() => {
    const map = new Map<string, { record: CollectionRecord; groupIndex: number }>();
    groups.forEach((group, groupIndex) => {
      for (const record of group.records) map.set(record.id, { record, groupIndex });
    });
    return map;
  }, [groups]);

  const handleDragEnd = (event: DragEndEvent) => {
    if (!onCellChange || event.canceled) return;
    const { source, target } = event.operation;
    if (!source || !target) return;
    if (typeof source.id !== "string" || typeof target.id !== "number") return;
    const group = groups[target.id];
    const entry = cardIndex.get(source.id);
    if (!group || !entry || entry.groupIndex === target.id) return;
    onCellChange({
      recordId: entry.record.id,
      recordPath: entry.record.path,
      field: groupBy,
      value: group.value,
    });
  };

  if (cardIndex.size === 0) {
    return <div className="px-3 py-4 text-sm text-muted">No records in this collection yet.</div>;
  }

  return (
    <DragDropProvider onDragEnd={handleDragEnd}>
      <div className="flex h-full items-start gap-3 overflow-x-auto">
        {groups.map((group, index) => (
          <BoardColumn
            key={index}
            group={group}
            index={index}
            label={groupLabel(group, groupField, personLabel)}
            fields={fields}
            onOpen={onOpenRecord}
            personLabel={personLabel}
          />
        ))}
      </div>
    </DragDropProvider>
  );
}
