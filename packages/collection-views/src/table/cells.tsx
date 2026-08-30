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

function displayText(
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

// TODO(collections/p2): how a flagged invalid value renders in each view is
// an unsettled Phase 2 decision (docs/plans/collections.md, "Settle first").
// This warning-color wrapper is the minimal placeholder until the
// orchestrator settles the final treatment.
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

interface EditorProps {
  field: FieldDefinition;
  indexed: CollectionIndexedValue | undefined;
  emit: (value: CollectionValue) => void;
  close: () => void;
}

function CellEditor({ field, indexed, emit, close }: EditorProps) {
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
    case "select":
      return (
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
          onBlur={close}
        >
          <option value="" />
          {field.options.map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </select>
      );
    case "multi-select": {
      const selected = asTextArray(value);
      return (
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

export function FieldCell({ field, indexed, personLabel, onChange }: FieldCellProps) {
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
      <CellEditor field={field} indexed={indexed} emit={onChange} close={() => setEditing(false)} />,
    );
  }

  const text = displayText(field, indexed, personLabel);
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
