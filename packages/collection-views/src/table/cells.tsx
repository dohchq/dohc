import type { ReactNode } from "react";
import type {
  CollectionIndexedValue,
  CollectionValue,
  FieldDefinition,
  FieldValueReasonCode,
} from "@dohc/workspace-contracts";
import type { CollectionQueryExecutor } from "../store";
import { RelationPicker } from "../relation/RelationPicker";

export interface FieldCellProps {
  field: FieldDefinition;
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
   * Opens the cell's editor. The table owns which cell is editing and
   * renders one CellEditor in an overlay above the rows, so a tall editor
   * is never clipped by the fixed row height. Absent means the cell is
   * read-only.
   */
  onEditStart?: () => void;
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

// Settled 2026-08-31 (docs/plans/collections.md): a flagged value renders
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

interface CellInputProps {
  defaultValue: string;
  type?: string;
  commit: (raw: string) => void;
  cancel: () => void;
}

function CellInput({ defaultValue, type = "text", commit, cancel }: CellInputProps) {
  return (
    <input
      autoFocus
      type={type}
      defaultValue={defaultValue}
      className="w-full rounded border border-line bg-bg px-1 text-[13px]"
      onKeyDown={(event) => {
        if (event.key === "Enter") commit(event.currentTarget.value);
        else if (event.key === "Escape") cancel();
      }}
      onBlur={(event) => commit(event.currentTarget.value)}
    />
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
        if (event.key === "Escape") return cancel();
        if (event.key !== "Enter") return;
        const option = event.currentTarget.value.trim();
        if (option === "") return;
        onPick(option, !options.includes(option));
      }}
    />
  );
}

export interface CellEditorProps {
  field: FieldDefinition;
  indexed: CollectionIndexedValue | undefined;
  /**
   * Receives the edited value. The host applies it through its own write
   * path; this package never writes.
   */
  emit: (value: CollectionValue) => void;
  close: () => void;
  /**
   * Select and multi-select editors offer to add a typed value the field's
   * options do not have yet. The host must add `option` to the schema FIRST
   * and only then write `nextValue` to the cell; this package never writes.
   * Absent means editors only pick existing options.
   */
  onCreateOption?: (option: string, nextValue: CollectionValue) => void;
  /**
   * Runs the relation picker's queries against a relation field's related
   * collection. The table never opens a relation editor without one.
   */
  relationExecutor?: CollectionQueryExecutor;
}

export function CellEditor({
  field,
  indexed,
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
  switch (field.type) {
    case "number":
      return (
        <CellInput
          defaultValue={asText(value)}
          commit={(raw) => {
            const trimmed = raw.trim();
            if (trimmed === "") return commitAndClose(null);
            const parsed = Number(trimmed);
            if (Number.isFinite(parsed)) return commitAndClose(parsed);
            close();
          }}
          cancel={close}
        />
      );
    case "date":
      return (
        <CellInput
          type="date"
          defaultValue={typeof value === "string" ? value : ""}
          commit={(raw) => commitAndClose(raw === "" ? null : raw)}
          cancel={close}
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
          onBlur={onCreateOption ? undefined : close}
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
    case "multi-select": {
      const selected = asTextArray(value);
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
            {field.options.map((option) => (
              <label key={option} className="flex items-center gap-1.5 text-[13px]">
                <input
                  type="checkbox"
                  checked={selected.includes(option)}
                  onChange={() =>
                    emit(
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
              options={field.options}
              cancel={close}
              onPick={(option, isNew) => {
                const next = selected.includes(option)
                  ? selected
                  : [...selected, option];
                if (isNew) {
                  onCreateOption(option, next);
                  close();
                } else {
                  emit(next);
                }
              }}
            />
          ) : null}
        </span>
      );
    }
    case "relation": {
      // Guarded by the caller: editing only starts with an executor.
      if (!relationExecutor) return null;
      return (
        <RelationPicker
          field={field}
          value={value}
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
      return (
        <CellInput
          defaultValue={asText(value)}
          commit={(raw) => {
            const id = raw.trim();
            commitAndClose(id === "" ? null : id);
          }}
          cancel={close}
        />
      );
    // text, url: a plain text value.
    default:
      return (
        <CellInput
          defaultValue={asText(value)}
          commit={(raw) => commitAndClose(raw === "" ? null : raw)}
          cancel={close}
        />
      );
  }
}

export function FieldCell({
  field,
  indexed,
  personLabel,
  onChange,
  onEditStart,
}: FieldCellProps) {
  const reason =
    indexed !== undefined && indexed.validation.status === "flagged"
      ? indexed.validation.reason.code
      : null;
  const value = indexed?.value ?? null;

  if (field.type === "checkbox") {
    const checked = value === true;
    return wrapFlagged(
      reason,
      <input
        type="checkbox"
        checked={checked}
        disabled={onChange === undefined}
        onChange={() => onChange?.(!checked)}
      />,
    );
  }

  const text = fieldDisplayText(field, indexed, personLabel);
  if (!onEditStart) {
    return wrapFlagged(reason, <span className="truncate text-[13px]">{text}</span>);
  }
  return wrapFlagged(
    reason,
    <button
      type="button"
      // min-h keeps an EMPTY cell clickable: with no text the button's
      // content box collapses to zero height and the cell cannot be edited
      // by mouse at all.
      className="block min-h-5 w-full truncate text-left text-[13px]"
      onClick={onEditStart}
    >
      {text}
    </button>,
  );
}
