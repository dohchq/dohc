import { useState } from "react";
import type { CollectionSchema } from "@dohc/workspace-contracts";
import { Overlay } from "../Overlay";
import { PrimaryButton, SecondaryButton, SectionLabel } from "../ui/controls";
import {
  draftToField,
  emptyFieldDraft,
  fieldDraftError,
  FieldDraftRow,
  FIELD_TYPE_LABELS,
  parseOptionsText,
  type FieldDraft,
} from "./FieldForm";
import { addField, setFieldOptions } from "./schemaAuthoring";

// Field management for an open collection: add a field, change a select
// field's options. Renaming is deliberately absent until the record-key
// rewrite ships with it (a schema-only rename orphans record data). Every
// change is one schema rewrite the host applies through the authored write
// path; `apply` resolves to a user-facing sentence on failure, null on
// success.

export type SchemaApply = (
  mutate: (schema: CollectionSchema) => CollectionSchema,
) => Promise<string | null>;

const inputClass =
  "w-full rounded-md border border-line bg-bg px-2.5 py-1.5 text-[13px] text-ink placeholder:text-subtle focus:border-ink disabled:opacity-50";

export function FieldsDialog(props: {
  schema: CollectionSchema;
  /** Collection folder paths a relation field can target. */
  relationTargets: readonly string[];
  apply: SchemaApply;
  onClose: () => void;
}) {
  const [editing, setEditing] = useState<string | null>(null);
  const [editOptions, setEditOptions] = useState("");
  const [draft, setDraft] = useState<FieldDraft>(emptyFieldDraft());
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const fieldNames = props.schema.fields.map((field) => field.name);

  async function run(
    problem: string | null,
    mutate: (schema: CollectionSchema) => CollectionSchema,
    onSuccess: () => void,
  ) {
    if (pending) return;
    if (problem !== null) {
      setError(problem);
      return;
    }
    setPending(true);
    setError(null);
    const failure = await props.apply(mutate);
    setPending(false);
    if (failure !== null) {
      setError(failure);
      return;
    }
    onSuccess();
  }

  function beginEdit(name: string) {
    const field = props.schema.fields.find((entry) => entry.name === name);
    if (!field || (field.type !== "select" && field.type !== "multi-select")) {
      return;
    }
    setEditing(name);
    setEditOptions(field.options.join(", "));
    setError(null);
  }

  async function saveEdit(name: string) {
    await run(
      null,
      (schema) => setFieldOptions(schema, name, parseOptionsText(editOptions)),
      () => setEditing(null),
    );
  }

  async function add() {
    await run(
      fieldDraftError(draft, fieldNames),
      (schema) => addField(schema, draftToField(draft)),
      () => setDraft(emptyFieldDraft()),
    );
  }

  return (
    <Overlay onClose={props.onClose}>
      <div
        data-testid="collection-fields-dialog"
        className="dohc-elevated flex w-130 max-w-[85vw] flex-col gap-3 rounded-xl border border-line bg-panel p-5"
      >
        <h2 className="m-0 text-sm font-semibold text-ink">Fields</h2>
        <div className="flex flex-col gap-1">
          {props.schema.fields.length === 0 ? (
            <span className="text-sm text-muted">
              No fields in this collection yet. Add one below.
            </span>
          ) : null}
          {props.schema.fields.map((field) =>
            editing === field.name ? (
              <div key={field.name} className="flex flex-col gap-1.5 rounded-lg border border-line bg-panel-2 p-2">
                {/* Read-only: renaming ships with the record-key rewrite. */}
                <input
                  type="text"
                  aria-label="Field name"
                  disabled
                  value={field.name}
                  className={inputClass}
                />
                <input
                  type="text"
                  aria-label="Options"
                  placeholder="Todo, Doing, Done"
                  disabled={pending}
                  value={editOptions}
                  onChange={(event) => setEditOptions(event.target.value)}
                  className={inputClass}
                />
                <div className="flex justify-end gap-2">
                  <SecondaryButton disabled={pending} onClick={() => setEditing(null)}>
                    Cancel
                  </SecondaryButton>
                  <PrimaryButton
                    className="px-3 py-1.5 text-xs"
                    disabled={pending}
                    onClick={() => void saveEdit(field.name)}
                  >
                    Save field
                  </PrimaryButton>
                </div>
              </div>
            ) : (
              <div key={field.name} className="flex h-8 items-center gap-2 rounded-md px-2">
                <span className="min-w-0 flex-1 truncate text-[13px] text-ink">
                  {field.name}
                </span>
                <span className="shrink-0 text-[11px] text-subtle">
                  {FIELD_TYPE_LABELS[field.type]}
                </span>
                {field.type === "select" || field.type === "multi-select" ? (
                  <SecondaryButton
                    aria-label={`Edit field ${field.name}`}
                    disabled={pending}
                    onClick={() => beginEdit(field.name)}
                  >
                    Edit
                  </SecondaryButton>
                ) : null}
              </div>
            ),
          )}
        </div>
        <div className="flex flex-col gap-2 border-t border-line pt-3">
          <SectionLabel>Add field</SectionLabel>
          <FieldDraftRow
            draft={draft}
            disabled={pending}
            relationTargets={props.relationTargets}
            onChange={setDraft}
          />
          <SecondaryButton
            data-testid="collection-add-field"
            className="self-start"
            disabled={pending}
            onClick={() => void add()}
          >
            Add field
          </SecondaryButton>
        </div>
        {error ? <p className="m-0 text-xs text-danger">{error}</p> : null}
      </div>
    </Overlay>
  );
}
