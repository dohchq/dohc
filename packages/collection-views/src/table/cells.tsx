import { useId, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { CircleAlert } from "lucide-react";
import type {
  CollectionIndexedValue,
  CollectionValue,
  FieldDefinition,
  FieldValueReasonCode,
} from "@dohc/workspace-contracts";
import type { CollectionQueryExecutor } from "../store";
import { useAcknowledgedSelection } from "../useAcknowledgedSelection";
import { RelationPicker } from "../relation/RelationPicker";
import { OptionPill, optionColor, PersonChip, shortDate } from "../values";

export interface FieldCellProps {
  field: FieldDefinition;
  /** The field's name as people read it. Absent, the key is the name. */
  label?: string;
  /** The record's indexed value for this field; undefined when unset. */
  indexed: CollectionIndexedValue | undefined;
  /** Maps a person field's user id to a display name. Falls back to the id. */
  personLabel?: (userId: string) => string | null;
  /**
   * Receives a checkbox toggle, the one edit a cell commits without an
   * editor. The host applies it through its own write path; this package
   * never writes. Absent means the checkbox is disabled.
   */
  onChange?: (value: CollectionValue) => void;
  /**
   * Draws the value as a button, so assistive technology hears that the
   * cell opens. The table starts the edit from a click anywhere in the cell
   * and renders one CellEditor in an overlay above the rows, so a tall
   * editor is never clipped by the fixed row height.
   */
  editable?: boolean;
}

/** Plain text for a raw collection value: board group labels, fallbacks. */
export function asText(value: CollectionValue): string {
  if (value === null) return "";
  if (Array.isArray(value)) return value.map(asText).join(", ");
  if (typeof value === "object") {
    return JSON.stringify(value, (_key, raw: unknown) =>
      typeof raw === "bigint" ? String(raw) : raw,
    );
  }
  return String(value);
}

function asTextArray(value: CollectionValue): string[] {
  if (value === null) return [];
  return Array.isArray(value) ? value.map(asText) : [asText(value)];
}

/**
 * The text a cell shows for a field value: person ids mapped through
 * `personLabel`, relations through their resolved labels. Board card titles
 * and calendar event titles reuse it so every view names a value the same
 * way.
 */
export function fieldDisplayText(
  field: FieldDefinition,
  indexed: CollectionIndexedValue | undefined,
  personLabel?: (userId: string) => string | null,
): string {
  const value = indexed?.value ?? null;
  if (value === null) return "";
  switch (field.type) {
    // A button stores no value, so a value under its name is never shown.
    case "button":
      return "";
    case "person": {
      const id = asText(value);
      return personLabel?.(id) ?? id;
    }
    case "multi-select":
      return asTextArray(value).join(", ");
    case "relation": {
      const resolved = indexed?.resolvedRelations ?? [];
      if (resolved.length > 0) {
        return resolved.map((relation) => relation.label).join(", ");
      }
      return asTextArray(value).join(", ");
    }
    default:
      return asText(value);
  }
}

// Settled 2026-08-31: a flagged value renders
// its raw text with the warning treatment, the validation reason on hover,
// and stays editable.
/**
 * The hover line for every reason the engine can flag a value with. The
 * `Record` type is the exhaustiveness check: a new contract reason without
 * copy here fails typecheck. cells.test.tsx pins the strings.
 */
export const FLAGGED_REASON_TITLES: Record<FieldValueReasonCode, string> = {
  "expected-text": "This value is not text. Edit the value to replace it.",
  "expected-number": "This value is not a number. Edit the value to replace it.",
  "number-not-finite": "This number is not finite. Edit the value to replace it.",
  "unsupported-tag":
    "This value uses a YAML tag dohc cannot index. Replace the value.",
  "value-depth-exceeded":
    "This value nests too deeply to index. Replace the value.",
  "expected-boolean":
    "This value is not true or false. Toggle the checkbox to replace it.",
  "expected-sequence": "This value is not a list. Edit the value to replace it.",
  "invalid-date": "This value is not a date. Edit the value to pick a date.",
  "unknown-option":
    "This field's options do not include this value. Edit the value to pick or add an option.",
  "duplicate-value":
    "This list repeats a value. Edit the value to remove the duplicate.",
  "empty-person-id":
    "This person id is empty. Edit the value to enter a person id.",
  "invalid-record-id":
    "This value is not a record id. Edit the value to pick a record.",
  "invalid-url": "This value is not a URL. Edit the value to replace it.",
  "expected-empty":
    "A button field stores no value. Remove this value from the record's file.",
};

function wrapFlagged(
  reason: FieldValueReasonCode | null,
  children: ReactNode,
): ReactNode {
  if (reason === null) return children;
  return (
    <span
      data-flagged="true"
      title={FLAGGED_REASON_TITLES[reason]}
      className="flex w-full text-warning"
    >
      {children}
    </span>
  );
}

// During IME composition, Enter and Escape work the candidate list. Some
// browsers mark those keys only with keyCode 229.
export function composing(event: KeyboardEvent): boolean {
  return event.nativeEvent.isComposing || event.keyCode === 229;
}

/** Where the selection goes when a key closes an editor: one row down, or one cell on or back. */
export type CellMove = "down" | "next" | "previous";

interface CellInputProps {
  defaultValue: string;
  type?: string;
  /** The value `raw` saves as. Undefined keeps the editor open and shows `invalid`. */
  parse: (raw: string) => CollectionValue | undefined;
  /** What is wrong with a value `parse` refuses, and what to do. */
  invalid?: string;
  /** The edit began with a typed character, so the caret follows it. */
  caretAtEnd?: boolean;
  emit: (value: CollectionValue) => void;
  close: (move?: CellMove) => void;
}

function CellInput({ defaultValue, type = "text", parse, invalid, caretAtEnd = false, emit, close }: CellInputProps) {
  const [refused, setRefused] = useState(false);
  const errorId = useId();
  // Enter and Tab close the editor, which can blur the input. One edit saves once.
  const done = useRef(false);
  // A date input keeps Tab for its day, month, and year.
  const moves = type !== "date";
  const save = (raw: string, move?: CellMove) => {
    if (done.current) return;
    const value = parse(raw);
    if (value === undefined) return setRefused(true);
    done.current = true;
    emit(value);
    close(move);
  };
  return (
    <>
      <input
        autoFocus
        type={type}
        defaultValue={defaultValue}
        aria-invalid={refused || undefined}
        aria-describedby={refused ? errorId : undefined}
        // The table keeps this editor open while it holds a value it cannot save.
        data-unsaved={refused || undefined}
        className="w-full rounded border border-line bg-bg px-1 text-[13px]"
        onFocus={
          caretAtEnd
            ? (event) => {
                const end = event.currentTarget.value.length;
                event.currentTarget.setSelectionRange(end, end);
              }
            : undefined
        }
        onKeyDown={(event) => {
          if (composing(event)) return;
          if (event.key === "Enter") save(event.currentTarget.value, moves ? "down" : undefined);
          else if (event.key === "Tab" && moves) {
            event.preventDefault();
            save(event.currentTarget.value, event.shiftKey ? "previous" : "next");
          } else if (event.key === "Escape") {
            done.current = true;
            close();
          }
        }}
        onBlur={(event) => save(event.currentTarget.value)}
      />
      {refused ? (
        <p id={errorId} role="alert" className="m-0 mt-1 flex items-start gap-1 text-[12px] text-danger">
          <span aria-hidden className="flex h-lh shrink-0 items-center">
            <CircleAlert size={12} />
          </span>
          {invalid}
        </p>
      ) : null}
    </>
  );
}

/**
 * The typed text of an option that does not exist yet. Enter with a known
 * option picks it instead, so typing never forks an existing option.
 */
function AddOptionInput({
  options,
  onPick,
  cancel,
}: {
  options: readonly string[];
  onPick: (option: string, isNew: boolean) => void;
  cancel: () => void;
}) {
  return (
    <input
      type="text"
      aria-label="Add option"
      placeholder="Add option"
      className="w-full rounded border border-line bg-bg px-1 text-[13px] placeholder:text-subtle"
      onKeyDown={(event) => {
        if (composing(event)) return;
        if (event.key === "Escape") return cancel();
        if (event.key !== "Enter") return;
        const option = event.currentTarget.value.trim();
        if (option === "") return;
        onPick(option, !options.includes(option));
      }}
    />
  );
}

// The indexed result acknowledges saved edits by id, including round trips
// whose final value equals the original. Later local changes still apply on
// top of that result, including any external edits it contains.
function MultiSelectEditor({
  options,
  value,
  acknowledgedWriteId,
  subscribeToDiscardedWrites,
  emit,
  close,
  onCreateOption,
}: {
  options: readonly string[];
  value: CollectionValue;
  acknowledgedWriteId: number;
  subscribeToDiscardedWrites?: (listener: (writeId: number) => void) => () => void;
  emit: (value: CollectionValue, previousValues?: readonly CollectionValue[]) => number;
  close: () => void;
  onCreateOption?: (option: string, nextValue: CollectionValue, previousValues?: readonly CollectionValue[]) => void;
}) {
  const { selected, select, previousValues } = useAcknowledgedSelection({ value, ids: asTextArray(value), acknowledgedWriteId, subscribeToDiscardedWrites, emit });
  return (
    <span className="flex w-full flex-col gap-0.5">
      <span
        role="listbox"
        aria-multiselectable="true"
        className="flex flex-col gap-0.5"
        onKeyDown={(event) => {
          if (event.key === "Escape") close();
        }}
      >
        {options.map((option) => (
          <label key={option} className="flex items-center gap-1.5 text-[13px]">
            <input
              type="checkbox"
              checked={selected.includes(option)}
              onChange={() =>
                select(
                  selected.includes(option)
                    ? selected.filter((entry) => entry !== option)
                    : [...selected, option],
                )
              }
            />
            {option}
          </label>
        ))}
      </span>
      {onCreateOption ? (
        <AddOptionInput
          options={options}
          cancel={close}
          onPick={(option, isNew) => {
            const next = selected.includes(option)
              ? selected
              : [...selected, option];
            if (isNew) {
              onCreateOption(option, next, previousValues);
              close();
            } else {
              select(next);
            }
          }}
        />
      ) : null}
    </span>
  );
}

export interface CellEditorProps {
  field: FieldDefinition;
  indexed: CollectionIndexedValue | undefined;
  /** The character that started a text, number, url, or person edit. It replaces the old value. */
  typed?: string;
  /** Highest saved edit id reflected in this indexed value; 0 before any edit. */
  acknowledgedWriteId: number;
  subscribeToDiscardedWrites?: (listener: (writeId: number) => void) => () => void;
  /**
   * Receives the edited value. The host applies it through its own write
   * path and returns a monotonically increasing edit id; this package never writes.
   */
  emit: (value: CollectionValue, previousValues?: readonly CollectionValue[]) => number;
  /** Closes the editor. A key that saves also says where the selection goes. */
  close: (move?: CellMove) => void;
  /**
   * Select and multi-select editors offer to add a typed value the field's
   * options do not have yet. The host must add `option` to the schema first
   * and only then write `nextValue` to the cell; this package never writes.
   * Absent means editors only pick existing options.
   */
  onCreateOption?: (option: string, nextValue: CollectionValue, previousValues?: readonly CollectionValue[]) => void;
  /**
   * Runs the relation picker's queries against a relation field's related
   * collection. The table never opens a relation editor without one.
   */
  relationExecutor?: CollectionQueryExecutor;
}

export function CellEditor({
  field,
  indexed,
  typed,
  acknowledgedWriteId,
  subscribeToDiscardedWrites,
  emit,
  close,
  onCreateOption,
  relationExecutor,
}: CellEditorProps) {
  const value = indexed?.value ?? null;
  const commitAndClose = (next: CollectionValue) => {
    emit(next);
    close();
  };
  const textInput = { defaultValue: typed ?? asText(value), caretAtEnd: typed !== undefined, emit, close };
  switch (field.type) {
    case "number":
      return (
        <CellInput
          {...textInput}
          parse={(raw) => {
            const trimmed = raw.trim();
            if (trimmed === "") return null;
            const parsed = Number(trimmed);
            return Number.isFinite(parsed) ? parsed : undefined;
          }}
          invalid="This value is not a number. Enter a number."
        />
      );
    case "date":
      return (
        <CellInput
          type="date"
          defaultValue={typeof value === "string" ? value : ""}
          parse={(raw) => raw || null}
          emit={emit}
          close={close}
        />
      );
    case "select": {
      const picker = (
        <select
          autoFocus
          defaultValue={typeof value === "string" ? value : ""}
          className="w-full rounded border border-line bg-bg text-[13px]"
          onChange={(event) =>
            commitAndClose(event.currentTarget.value === "" ? null : event.currentTarget.value)
          }
          onKeyDown={(event) => {
            if (event.key === "Escape") close();
          }}
          onBlur={onCreateOption ? undefined : () => close()}
        >
          <option value="" />
          {field.options.map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </select>
      );
      if (!onCreateOption) return picker;
      return (
        <span
          className="flex w-full flex-col gap-0.5"
          onBlur={(event) => {
            if (!event.currentTarget.contains(event.relatedTarget)) close();
          }}
        >
          {picker}
          <AddOptionInput
            options={field.options}
            cancel={close}
            onPick={(option, isNew) => {
              if (isNew) {
                onCreateOption(option, option);
                close();
              } else {
                commitAndClose(option);
              }
            }}
          />
        </span>
      );
    }
    case "multi-select":
      return (
        <MultiSelectEditor
          options={field.options}
          value={value}
          acknowledgedWriteId={acknowledgedWriteId}
          subscribeToDiscardedWrites={subscribeToDiscardedWrites}
          emit={emit}
          close={close}
          onCreateOption={onCreateOption}
        />
      );
    case "relation": {
      // Guarded by the caller: editing only starts with an executor.
      if (!relationExecutor) return null;
      return (
        <RelationPicker
          field={field}
          value={value}
          acknowledgedWriteId={acknowledgedWriteId}
          subscribeToDiscardedWrites={subscribeToDiscardedWrites}
          executor={relationExecutor}
          emit={emit}
          close={close}
        />
      );
    }
    // A person value is a user id. The renderer has no workspace people
    // source yet, so edits work on the raw id; the trim keeps a
    // whitespace-only entry from indexing as a flagged empty id.
    case "person":
      return <CellInput {...textInput} parse={(raw) => raw.trim() || null} />;
    // text, url: a plain text value.
    default:
      return <CellInput {...textInput} parse={(raw) => raw || null} />;
  }
}

export function FieldCell({
  field,
  label = field.name,
  indexed,
  personLabel,
  onChange,
  editable = false,
}: FieldCellProps) {
  const reason =
    indexed !== undefined && indexed.validation.status === "flagged"
      ? indexed.validation.reason.code
      : null;
  const value = indexed?.value ?? null;

  // A button field stores no value, so its cell shows the field's name.
  if (field.type === "button") {
    return wrapFlagged(
      reason,
      <span className="truncate text-[13px] text-muted">{label}</span>,
    );
  }

  if (field.type === "checkbox") {
    const checked = value === true;
    return wrapFlagged(
      reason,
      <input
        type="checkbox"
        aria-label={label}
        // The grid is the Tab stop. Enter on the selected cell toggles the box.
        tabIndex={-1}
        checked={checked}
        disabled={onChange === undefined}
        onChange={() => onChange?.(!checked)}
        className="size-3.5 cursor-pointer accent-accent disabled:cursor-default"
      />,
    );
  }

  const shown = reason === null
    ? <FieldValue field={field} indexed={indexed} personLabel={personLabel} />
    : <span className="truncate text-[13px]">{fieldDisplayText(field, indexed, personLabel)}</span>;
  if (!editable) return wrapFlagged(reason, shown);
  return wrapFlagged(
    reason,
    <button
      type="button"
      // The grid is the Tab stop. Enter on the selected cell opens the editor.
      tabIndex={-1}
      // min-h keeps an empty cell's button a target: with no text its
      // content box collapses to zero height.
      className="flex min-h-5 w-full min-w-0 items-center text-left text-[13px]"
    >
      {shown}
    </button>,
  );
}

/**
 * A valid value as every view shows it: options as colored pills, people
 * with their initial, dates as "Nov 8". Empty shows nothing.
 */
export function FieldValue({
  field,
  indexed,
  personLabel,
}: {
  field: FieldDefinition;
  indexed: CollectionIndexedValue | undefined;
  personLabel?: (userId: string) => string | null;
}) {
  const value = indexed?.value ?? null;
  if (value === null) return null;
  switch (field.type) {
    case "select": {
      const option = asText(value);
      return <OptionPill label={option} color={optionColor(field, option)} dot />;
    }
    case "multi-select":
      return (
        <span className="flex min-w-0 items-center gap-1 overflow-hidden">
          {asTextArray(value).map((option) => (
            <OptionPill key={option} label={option} color={optionColor(field, option)} />
          ))}
        </span>
      );
    case "person": {
      const id = asText(value);
      return <PersonChip id={id} label={personLabel?.(id) ?? id} />;
    }
    case "date": {
      const date = asText(value);
      return <span className="truncate text-[13px]">{shortDate(date)}</span>;
    }
    case "number":
      return <span className="ml-auto truncate text-[13px] tabular-nums">{asText(value)}</span>;
    case "relation":
    case "url":
      return (
        <span className="truncate text-[13px] underline decoration-line underline-offset-[3px]">
          {fieldDisplayText(field, indexed, personLabel)}
        </span>
      );
    default:
      return <span className="truncate text-[13px]">{fieldDisplayText(field, indexed, personLabel)}</span>;
  }
}
