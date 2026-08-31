import { useState } from "react";
import type { ReactNode } from "react";
import type {
  CollectionIndexedValue,
  CollectionValue,
  FieldDefinition,
} from "@dohc/workspace-contracts";

export interface FieldCellProps {
  field: FieldDefinition;
  /** The record's indexed value for this field; undefined when unset. */
  indexed: CollectionIndexedValue | undefined;
  /** Maps a person field's user id to a display name. Falls back to the id. */
  personLabel?: (userId: string) => string | null;
  /**
   * Receives the edited value. The host applies it through its own write
   * path; this package never writes. Absent means the cell is read-only.
   */
  onChange?: (value: CollectionValue) => void;
  /**
   * Select and multi-select cells offer to add a typed value the field's
   * options do not have yet. The host must add `option` to the schema FIRST
   * and only then write `nextValue` to the cell; this package never writes.
   * Absent means cells only pick existing options.
   */
  onCreateOption?: (option: string, nextValue: CollectionValue) => void;
}

/** Plain text for a raw collection value: board group labels, fallbacks. */
export function fieldValueText(value: CollectionValue): string {
  return asText(value);
}

function asText(value: CollectionValue): string {
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
// its raw text with the warning treatment and stays editable. The hover
// title still shows a generic label; the per-reason copy is the desktop
// lane's work.
function wrapFlagged(flagged: boolean, children: ReactNode): ReactNode {
  if (!flagged) return children;
  return (
    <span data-flagged="true" title="Invalid value" className="flex w-full text-warning">
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

interface EditorProps {
  field: FieldDefinition;
  indexed: CollectionIndexedValue | undefined;
  emit: (value: CollectionValue) => void;
  close: () => void;
  onCreateOption?: (option: string, nextValue: CollectionValue) => void;
}

function CellEditor({ field, indexed, emit, close, onCreateOption }: EditorProps) {
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
    // text, url, person: a plain text value. A person cell may display a
    // resolved name, but edits work on the raw id.
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
  onCreateOption,
}: FieldCellProps) {
  const [editing, setEditing] = useState(false);
  const flagged = indexed !== undefined && indexed.validation.status === "flagged";
  const value = indexed?.value ?? null;

  if (field.type === "checkbox") {
    const checked = value === true;
    return wrapFlagged(
      flagged,
      <input
        type="checkbox"
        checked={checked}
        disabled={onChange === undefined}
        onChange={() => onChange?.(!checked)}
      />,
    );
  }

  // Relation editing needs a record picker with query access; the desktop
  // lane owns that surface. Relation cells stay read-only here.
  const editable = onChange !== undefined && field.type !== "relation";

  if (editing && onChange && editable) {
    return wrapFlagged(
      flagged,
      <CellEditor
        field={field}
        indexed={indexed}
        emit={onChange}
        close={() => setEditing(false)}
        onCreateOption={onCreateOption}
      />,
    );
  }

  const text = fieldDisplayText(field, indexed, personLabel);
  if (!editable) {
    return wrapFlagged(flagged, <span className="truncate text-[13px]">{text}</span>);
  }
  return wrapFlagged(
    flagged,
    <button
      type="button"
      className="block w-full truncate text-left text-[13px]"
      onClick={() => setEditing(true)}
    >
      {text}
    </button>,
  );
}
