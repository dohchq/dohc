import { useId, useLayoutEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { CircleAlert, Clock, TriangleAlert } from "lucide-react";
import type { CollectionRecord, FieldDefinition } from "@dohc/workspace-contracts";
import { deriveColumns } from "../columns";
import { Tooltip, useTooltip } from "../tooltip";
import { useCarriedSelections, type CarriedSelection } from "../useAcknowledgedSelection";
import { FieldTypeIcon } from "../values";
import { CellEditor, FieldCell } from "../table/cells";
import { composing, pickerWidth, type CellMove } from "../table/pickers";
import {
  DISCARD_HINT,
  HOST_EDITOR_WIDTH,
  NO_STATUSES,
  opensEditor,
  shownValue,
  StatusMark,
  TYPED_INTO,
  type TableCellStatus,
  type TableCellStatuses,
  type TableFieldMark,
  type TableHostCell,
  type TableViewProps,
} from "../table/TableView";

/**
 * One record's fields, one per row: the field's name, and its value drawn
 * and edited as a table cell is. A host gives it what it gives the table,
 * so a change the host has not confirmed shows the same in both.
 */
export interface RecordPropertiesProps
  extends Pick<
    TableViewProps,
    | "schema"
    | "visibleFields"
    | "onCellChange"
    | "onDraftAbandoned"
    | "editingDisabled"
    | "canEditCell"
    | "cellStatuses"
    | "hostCells"
    | "acknowledgedWriteId"
    | "subscribeToDiscardedWrites"
    | "onCreateOption"
    | "onOptionColorChange"
    | "people"
    | "onOpenLink"
    | "relationExecutor"
    | "personLabel"
    | "fieldLabel"
    | "fieldMarks"
    | "renderButton"
  > {
  record: CollectionRecord;
  /** Fields the rows leave out, such as the one a panel shows as the record's heading. */
  omitFields?: readonly string[];
  /**
   * What is wrong with a field's value, by field key, for a host that
   * checks values before it saves them, as for a record that does not
   * exist yet. The row says it under the value.
   */
  problems?: ReadonlyMap<string, string>;
}

/** The room a field's name gets before its value. */
const LABEL_WIDTH = 112;
const EMPTY = "Empty";
const NOTE_BUTTON = "h-6 rounded-md border border-line px-2 text-[12px] text-ink transition-colors duration-75 hover:bg-hover";

type Unconfirmed = Exclude<TableCellStatus, { state: "pending" }>;

/**
 * A change the host has not confirmed, in words, with what the person can
 * do about it. A property has room for the words the table shows only under
 * its selected cell. `onAct` runs before an action, which removes the note.
 */
function StatusNote({ status, onAct }: { status: Unconfirmed; onAct?: () => void }) {
  const Icon = status.state === "waiting" ? Clock : status.state === "unconfirmed" ? TriangleAlert : CircleAlert;
  const tone = status.state === "waiting" ? "text-muted" : status.state === "unconfirmed" ? "text-warning" : "text-danger";
  return (
    <div role="note" data-cell-status={status.state} className="flex flex-col items-start gap-1 px-2 pb-1 text-[12px]">
      <p className={`m-0 flex items-start gap-1 ${tone}`}>
        <span aria-hidden className="flex h-lh shrink-0 items-center">
          <Icon size={12} strokeWidth={1.9} />
        </span>
        {status.reason}
      </p>
      {status.state === "waiting" ? null : (
        <div className="flex gap-1">
          <button
            type="button"
            className={NOTE_BUTTON}
            onClick={() => {
              onAct?.();
              if (status.state === "unconfirmed") status.retry();
              else status.dismiss();
            }}
          >
            {status.state === "unconfirmed" ? "Try again" : "Dismiss"}
          </button>
          {status.state === "unconfirmed" && status.discard ? (
            <button
              type="button"
              title={DISCARD_HINT}
              className={NOTE_BUTTON}
              onClick={() => {
                onAct?.();
                status.discard?.();
              }}
            >
              Discard
            </button>
          ) : null}
        </div>
      )}
    </div>
  );
}

/**
 * One cell's unconfirmed change, for a host that draws the field outside
 * the properties, as a panel draws the record's name as its heading. It
 * shows nothing for a cell with no change.
 */
export function CellStatusNote(props: { statuses: TableCellStatuses; recordId: string; field: string; onAct?: () => void }) {
  const { statuses, recordId, field } = props;
  const status = useSyncExternalStore(statuses.subscribe, () => statuses.get(recordId, field));
  if (!status) return null;
  return status.state === "pending" ? <StatusMark status={status} /> : <StatusNote status={status} onAct={props.onAct} />;
}

function isEmpty(value: unknown): boolean {
  return value === null || value === undefined || value === "" || (Array.isArray(value) && value.length === 0);
}

interface RowProps extends Omit<RecordPropertiesProps, "schema" | "visibleFields" | "omitFields" | "hostCells" | "fieldMarks" | "cellStatuses" | "problems"> {
  field: FieldDefinition;
  label: string;
  /** What is wrong with the value, if the host says anything is. */
  problem: string | undefined;
  statuses: TableCellStatuses;
  host: TableHostCell | undefined;
  mark: TableFieldMark | undefined;
  /** The row's editor is open, with the character that opened it, if one did. */
  editing: { typed?: string } | null;
  carried: CarriedSelection | undefined;
  onStartEdit: (typed?: string) => void;
  onCloseEdit: (to?: CellMove | "away") => void;
  /** Puts focus on the row's value, as before an action that removes what has it. */
  onFocusValue: () => void;
  valueRef: (element: HTMLDivElement | null) => void;
  editorRef: (element: HTMLFieldSetElement | null) => void;
}

function PropertyRow(props: RowProps) {
  const { field, label, record, statuses, host, mark, editing, onCellChange, editingDisabled = false, relationExecutor, people } = props;
  const labelId = useId();
  const problemId = useId();
  const tooltip = useTooltip();
  const status = useSyncExternalStore(statuses.subscribe, () => statuses.get(record.id, field.name));
  const stored = record.values.find((entry) => entry.field === field.name);
  const indexed = shownValue(field.name, stored, status);
  const edits = onCellChange !== undefined && !editingDisabled && (props.canEditCell?.(record, field) ?? true);
  const editable = edits && opensEditor(field, relationExecutor, host);
  const cell = { recordId: record.id, recordPath: record.path, field: field.name };
  // A picker or a host's editor is a popover on the value. Other editors fill it.
  const popover = host ? HOST_EDITOR_WIDTH : pickerWidth(field, people !== undefined);

  let content: ReactNode;
  if (field.type === "button" && props.renderButton) content = props.renderButton(field, record);
  else if (host) {
    // The host draws the value, so the row says when there is none.
    content = (
      <>
        {isEmpty(indexed?.value) ? <span className="shrink-0 text-[13px] text-subtle">{EMPTY}</span> : null}
        {host.cell(record, true)}
      </>
    );
  } else {
    content = (
      <FieldCell
        field={field}
        label={label}
        indexed={indexed}
        personLabel={props.personLabel}
        onChange={edits ? (value) => onCellChange({ ...cell, value }) : undefined}
        editable={editable}
        onOpenLink={props.onOpenLink}
        tabStop
        alignStart
        emptyText={EMPTY}
      />
    );
  }

  return (
    <div
      role="group"
      aria-labelledby={labelId}
      aria-describedby={props.problem === undefined ? undefined : problemId}
      data-property={field.name}
      data-invalid={props.problem === undefined ? undefined : ""}
      className="grid items-start gap-x-2"
      style={{ gridTemplateColumns: `${LABEL_WIDTH}px minmax(0, 1fr)` }}
    >
      <div className="relative flex h-7 min-w-0 items-center gap-2 text-[12px] text-muted" {...(mark ? tooltip.hoverProps : {})}>
        <FieldTypeIcon type={field.type} className="shrink-0 text-subtle" />
        <span id={labelId} className="truncate">{label}</span>
        {mark && field.type !== "button" ? (
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
        {mark && field.type !== "button" ? <Tooltip {...tooltip.tooltipProps}>{mark.label}</Tooltip> : null}
      </div>
      <div className="relative min-w-0">
        <div
          ref={props.valueRef}
          data-property-value=""
          // A value that opens is one target: the control that edits it stretches over the box, which shows its focus.
          className={`flex min-h-7 min-w-0 items-center gap-1 rounded-md px-2 text-ink transition-colors duration-75${editable ? " dohc-row-open" : ""}`}
          onClick={(event) => {
            // A dialog the host's button opens is the value's child in React, not on the page.
            if (editable && event.currentTarget.contains(event.target as Node)) props.onStartEdit();
          }}
          onKeyDown={(event) => {
            // A typed character starts the edit, as on a selected cell. A host's value is changed in the host's editor.
            if (!editable || host || !(event.target instanceof HTMLButtonElement) || composing(event)) return;
            if (event.ctrlKey || event.metaKey || event.altKey || event.key.length !== 1 || event.key === " ") return;
            if (!TYPED_INTO.has(field.type)) return;
            event.preventDefault();
            props.onStartEdit(event.key);
          }}
        >
          <span className="flex min-w-0 flex-1 items-center gap-1">{content}</span>
          {status?.state === "pending" ? <StatusMark status={status} /> : null}
        </div>
        {editing && onCellChange ? (
          <fieldset
            // The table's editor, as a popover on the value. It ends at the value's right edge and
            // reaches left over the field's name when it is the wider of the two.
            key={record.id}
            ref={props.editorRef}
            data-cell-editor=""
            disabled={editingDisabled}
            onBlurCapture={(event) => {
              if (editingDisabled) event.stopPropagation();
            }}
            // One Escape closes one surface: the editor took this one.
            onKeyDown={(event) => {
              if (event.key === "Escape") event.stopPropagation();
            }}
            className={
              popover === null
                ? "dohc-popover absolute right-0 top-0 z-10 m-0 w-full min-w-0 rounded-md border border-line bg-bg p-1 font-normal"
                : "dohc-popover dohc-pop-in absolute right-0 top-0 z-10 m-0 min-w-full rounded-lg border border-line bg-bg p-0 font-normal"
            }
            style={popover === null ? { minHeight: 28 } : { width: popover, maxWidth: `calc(100% + ${LABEL_WIDTH}px)`, minHeight: 28 }}
          >
            {host ? host.editor?.(record, () => props.onCloseEdit()) : (
              <CellEditor
                field={field}
                label={label}
                typed={editing.typed}
                acknowledgedWriteId={props.acknowledgedWriteId?.(record, field.name) ?? 0}
                subscribeToDiscardedWrites={props.subscribeToDiscardedWrites}
                carried={props.carried}
                // The edit starts from what the value shows, so a refused value is not typed twice.
                indexed={indexed}
                emit={(value, previousValues) => onCellChange({ ...cell, value, ...(previousValues === undefined ? {} : { previousValues }) })}
                close={props.onCloseEdit}
                abandon={props.onDraftAbandoned ? (text, value) => props.onDraftAbandoned?.({ recordId: record.id, field: field.name, text, ...(value === undefined ? {} : { value }) }) : undefined}
                onCreateOption={
                  props.onCreateOption
                    ? (option, value, previousValues) =>
                        props.onCreateOption?.({ ...cell, option, value, ...(previousValues === undefined ? {} : { previousValues }) })
                    : undefined
                }
                onOptionColorChange={
                  props.onOptionColorChange ? (option, color) => props.onOptionColorChange?.(field.name, option, color) : undefined
                }
                people={people}
                relationExecutor={relationExecutor}
              />
            )}
          </fieldset>
        ) : null}
        {status && status.state !== "pending" ? <StatusNote status={status} onAct={props.onFocusValue} /> : null}
        {props.problem === undefined ? null : (
          <p id={problemId} role="alert" className="m-0 flex items-start gap-1 px-2 pb-1 text-[12px] text-danger">
            <span aria-hidden className="flex h-lh shrink-0 items-center">
              <CircleAlert size={12} strokeWidth={1.9} />
            </span>
            {props.problem}
          </p>
        )}
      </div>
    </div>
  );
}

export function RecordProperties(props: RecordPropertiesProps) {
  const { schema, visibleFields, omitFields, hostCells, fieldMarks, cellStatuses, problems, ...shared } = props;
  const { record, fieldLabel, subscribeToDiscardedWrites } = props;
  const fields = deriveColumns(schema, visibleFields).filter((field) => !omitFields?.includes(field.name));
  // One editor at a time: the row it is on, and the character that opened it, if one did. It belongs to
  // one record, so another record in the same place starts with no editor.
  const [opened, setEditing] = useState<{ recordId: string; field: string; typed?: string } | null>(null);
  const editing = opened?.recordId === record.id ? opened : null;
  const values = useRef(new Map<string, HTMLDivElement>());
  const editor = useRef<HTMLFieldSetElement | null>(null);
  const carried = useCarriedSelections(subscribeToDiscardedWrites);

  /** Focuses a row's own control, outside its editor. False when the row has none. */
  const focusValue = (field: string): boolean => {
    const target = values.current.get(field)?.querySelector<HTMLElement>("button:not(:disabled), input:not(:disabled), [tabindex='0']");
    target?.focus();
    return target !== undefined && target !== null;
  };

  const closeEdit = (to?: CellMove | "away") => {
    const field = editing?.field;
    setEditing(null);
    // A press away closes the editor too, and focus belongs to what was pressed.
    if (to === "away" || field === undefined || !editor.current?.contains(document.activeElement)) return;
    // Tab goes on to the next row's value, or back to the one before. Enter and Escape stay on this one.
    const step = to === "next" ? 1 : to === "previous" ? -1 : 0;
    for (let at = fields.findIndex((entry) => entry.name === field) + step; step !== 0 && at >= 0 && at < fields.length; at += step) {
      if (focusValue(fields[at]!.name)) return;
    }
    focusValue(field);
  };

  const startEdit = (field: string, typed?: string) => {
    // An editor holding a value it cannot save keeps its place and takes
    // focus, as in the table, so the value is not lost unseen.
    const held = editor.current?.querySelector<HTMLElement>("[data-unsaved]");
    if (held) return held.focus();
    setEditing({ recordId: record.id, field, typed });
  };

  // A picker that opens low in its scroller comes into view, down to its last row.
  const openField = editing?.field;
  useLayoutEffect(() => {
    if (openField !== undefined) editor.current?.scrollIntoView?.({ block: "nearest" });
  }, [openField]);

  return (
    <div className="flex flex-col">
      {fields.map((field) => (
        <PropertyRow
          {...shared}
          key={field.name}
          field={field}
          label={fieldLabel?.(field.name) ?? field.name}
          statuses={cellStatuses ?? NO_STATUSES}
          host={hostCells?.get(field.name)}
          mark={fieldMarks?.get(field.name)}
          problem={problems?.get(field.name)}
          editing={editing?.field === field.name ? editing : null}
          // By record and field, as the table keeps them, so another record in the same place starts from its own picks.
          carried={field.type === "multi-select" ? carried(JSON.stringify([record.id, field.name])) : undefined}
          onStartEdit={(typed) => startEdit(field.name, typed)}
          onCloseEdit={closeEdit}
          onFocusValue={() => focusValue(field.name)}
          valueRef={(element) => {
            if (element) values.current.set(field.name, element);
            else values.current.delete(field.name);
          }}
          editorRef={(element) => {
            if (element) editor.current = element;
            else if (editing?.field === field.name) editor.current = null;
          }}
        />
      ))}
    </div>
  );
}
