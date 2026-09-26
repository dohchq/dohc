import { useState } from "react";
import type { CollectionSchema } from "@dohc/workspace-contracts";
import type { AutomationButtonState } from "@dohc/automation-executor/automation-buttons";
import { Overlay } from "../Overlay";
import { PrimaryButton, SecondaryButton, SectionLabel } from "../ui/controls";
import {
  draftToField,
  emptyFieldDraft,
  fieldDraftError,
  FieldDraftRow,
  FIELD_TYPE_LABELS,
  FIELD_TYPES_WITH_BUTTON,
  inputClass,
  NO_OPTIONS_PROBLEM,
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

/**
 * The dialogs' shared rewrite machinery: one pending flag, the current
 * user-facing error, and `run`, which surfaces `problem` without applying,
 * else applies one rewrite and calls `onSuccess` only when it landed.
 */
export function useSchemaRun(apply: SchemaApply) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
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
    const failure = await apply(mutate);
    setPending(false);
    if (failure !== null) {
      setError(failure);
      return;
    }
    onSuccess();
  }
  return { pending, error, setError, run };
}

export function FieldsDialog(props: {
  schema: CollectionSchema;
  /** Collection folder paths a relation field can target. */
  relationTargets: readonly string[];
  apply: SchemaApply;
  /** What each Button field does now, by field name; null while it loads. */
  buttonStates?: ReadonlyMap<string, AutomationButtonState> | null;
  /** Opens the automation builder with the trigger set to this button. */
  onChooseButtonAutomation?: (field: string) => void;
  onClose: () => void;
}) {
  const [editing, setEditing] = useState<string | null>(null);
  const [editOptions, setEditOptions] = useState("");
  const [draft, setDraft] = useState<FieldDraft>(emptyFieldDraft());
  const { pending, error, setError, run } = useSchemaRun(props.apply);

  const fieldNames = props.schema.fields.map((field) => field.name);

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
    const options = parseOptionsText(editOptions);
    await run(
      options.length === 0 ? NO_OPTIONS_PROBLEM : null,
      (schema) => setFieldOptions(schema, name, options),
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
                {field.type === "button" && props.onChooseButtonAutomation &&
                  props.buttonStates?.get(field.name)?.kind === "no-automation" ? (
                  <SecondaryButton
                    aria-label={`Choose what ${field.name} does`}
                    disabled={pending}
                    onClick={() => props.onChooseButtonAutomation?.(field.name)}
                  >
                    Choose what it does
                  </SecondaryButton>
                ) : null}
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
            types={FIELD_TYPES_WITH_BUTTON}
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
