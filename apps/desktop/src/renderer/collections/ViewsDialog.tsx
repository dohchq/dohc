import { useState } from "react";
import type {
  CollectionSchema,
  ViewDefinition,
  ViewKind,
} from "@dohc/workspace-contracts";
import { Overlay } from "../Overlay";
import { PrimaryButton, SecondaryButton, SectionLabel } from "../ui/controls";
import { addView, deleteView, renameView } from "./schemaAuthoring";
import { useSchemaRun, type SchemaApply } from "./FieldsDialog";
import { inputClass, selectClass } from "./FieldForm";

// View management for an open collection: create, rename, and delete the
// named views under the schema's `views:`. Every change is one schema
// rewrite through the host's authored write path. Which view is open stays
// the host's local state; the dialog reports renames and deletes so the
// host can follow them.

const VIEW_KIND_LABELS: Record<ViewKind, string> = {
  table: "Table",
  board: "Board",
  calendar: "Calendar",
};

export function ViewsDialog(props: {
  schema: CollectionSchema;
  apply: SchemaApply;
  onClose: () => void;
  onRenamed: (from: string, to: string) => void;
  onDeleted: (name: string) => void;
}) {
  const [editing, setEditing] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  // Deleting a view drops its configuration with no reverse path, so the
  // button arms on the first click and deletes on the second. Arming one
  // row disarms any other; closing the dialog unmounts the armed state.
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [newName, setNewName] = useState("");
  const [newKind, setNewKind] = useState<ViewKind>("table");
  const [newGroupBy, setNewGroupBy] = useState("");
  const [newDateField, setNewDateField] = useState("");
  const { pending, error, setError, run } = useSchemaRun(props.apply);

  const viewNames = props.schema.views.map((view) => view.name);
  // A board groups by stored values, and a button stores none.
  const groupFieldNames = props.schema.fields
    .filter((field) => field.type !== "button")
    .map((field) => field.name);
  const dateFieldNames = props.schema.fields
    .filter((field) => field.type === "date")
    .map((field) => field.name);

  function nameProblem(name: string, taken: readonly string[]): string | null {
    if (name === "") return "Give the view a name.";
    if (taken.includes(name)) {
      return `A view named "${name}" already exists. Choose another name.`;
    }
    return null;
  }

  async function saveRename(from: string) {
    const to = editName.trim();
    const problem =
      to === from
        ? null
        : nameProblem(to, viewNames.filter((name) => name !== from));
    await run(
      problem,
      (schema) => renameView(schema, from, to),
      () => {
        setEditing(null);
        if (to !== from) props.onRenamed(from, to);
      },
    );
  }

  async function remove(name: string) {
    await run(
      null,
      (schema) => deleteView(schema, name),
      () => {
        setConfirmDelete(null);
        props.onDeleted(name);
      },
    );
  }

  async function create() {
    const name = newName.trim();
    let problem = nameProblem(name, viewNames);
    if (problem === null && newKind === "board" && newGroupBy === "") {
      problem = "Choose a field to group by.";
    }
    if (problem === null && newKind === "calendar" && newDateField === "") {
      problem =
        dateFieldNames.length === 0
          ? "A calendar needs a date field. Add one first."
          : "Choose a date field.";
    }
    const view: ViewDefinition = {
      name,
      kind: newKind,
      groupBy: newKind === "board" ? newGroupBy : null,
      sort: [],
      visibleFields: null,
      dateField: newKind === "calendar" ? newDateField : null,
    };
    await run(
      problem,
      (schema) => addView(schema, view),
      () => {
        setNewName("");
        setNewGroupBy("");
        setNewDateField("");
      },
    );
  }

  return (
    <Overlay onClose={props.onClose}>
      <div
        data-testid="collection-views-dialog"
        className="dohc-elevated flex w-130 max-w-[85vw] flex-col gap-3 rounded-xl border border-line bg-panel p-5"
      >
        <h2 className="m-0 text-sm font-semibold text-ink">Views</h2>
        <div className="flex flex-col gap-1">
          {props.schema.views.length === 0 ? (
            <span className="text-sm text-muted">
              No saved views yet. This collection shows a table. Create a view
              below.
            </span>
          ) : null}
          {props.schema.views.map((view) =>
            editing === view.name ? (
              <div
                key={view.name}
                className="flex items-center gap-1.5 rounded-lg border border-line bg-panel-2 p-2"
              >
                <input
                  type="text"
                  aria-label="New view name"
                  disabled={pending}
                  value={editName}
                  onChange={(event) => setEditName(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") void saveRename(view.name);
                  }}
                  className={inputClass}
                />
                <SecondaryButton disabled={pending} onClick={() => setEditing(null)}>
                  Cancel
                </SecondaryButton>
                <PrimaryButton
                  className="px-3 py-1.5 text-xs"
                  disabled={pending}
                  onClick={() => void saveRename(view.name)}
                >
                  Save view
                </PrimaryButton>
              </div>
            ) : (
              <div key={view.name} className="flex h-8 items-center gap-2 rounded-md px-2">
                <span className="min-w-0 flex-1 truncate text-[13px] text-ink">
                  {view.name}
                </span>
                <span className="shrink-0 text-[11px] text-subtle">
                  {VIEW_KIND_LABELS[view.kind]}
                </span>
                <SecondaryButton
                  aria-label={`Rename view ${view.name}`}
                  disabled={pending}
                  onClick={() => {
                    setEditing(view.name);
                    setEditName(view.name);
                    setError(null);
                  }}
                >
                  Rename
                </SecondaryButton>
                <SecondaryButton
                  aria-label={`Delete view ${view.name}`}
                  className="text-danger hover:text-danger"
                  disabled={pending}
                  onClick={() => {
                    if (confirmDelete !== view.name) {
                      setConfirmDelete(view.name);
                      return;
                    }
                    void remove(view.name);
                  }}
                >
                  {confirmDelete === view.name ? "Confirm delete" : "Delete"}
                </SecondaryButton>
              </div>
            ),
          )}
        </div>
        <div className="flex flex-col gap-2 border-t border-line pt-3">
          <SectionLabel>New view</SectionLabel>
          <div className="flex items-center gap-1.5">
            <input
              type="text"
              aria-label="View name"
              placeholder="View name"
              disabled={pending}
              value={newName}
              onChange={(event) => setNewName(event.target.value)}
              className={inputClass}
            />
            <select
              aria-label="View kind"
              disabled={pending}
              value={newKind}
              onChange={(event) => setNewKind(event.target.value as ViewKind)}
              className="w-32 shrink-0 rounded-md border border-line bg-bg px-2 py-1.5 text-[13px] text-ink focus:border-ink disabled:opacity-50"
            >
              {(Object.keys(VIEW_KIND_LABELS) as ViewKind[]).map((kind) => (
                <option key={kind} value={kind}>
                  {VIEW_KIND_LABELS[kind]}
                </option>
              ))}
            </select>
          </div>
          {newKind === "board" ? (
            <select
              aria-label="Group by"
              disabled={pending}
              value={newGroupBy}
              onChange={(event) => setNewGroupBy(event.target.value)}
              className={selectClass}
            >
              <option value="">Choose a field to group by</option>
              {groupFieldNames.map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
            </select>
          ) : null}
          {newKind === "calendar" ? (
            <select
              aria-label="Date field"
              disabled={pending}
              value={newDateField}
              onChange={(event) => setNewDateField(event.target.value)}
              className={selectClass}
            >
              <option value="">Choose a date field</option>
              {dateFieldNames.map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
            </select>
          ) : null}
          <SecondaryButton
            data-testid="collection-add-view"
            className="self-start"
            disabled={pending}
            onClick={() => void create()}
          >
            Create view
          </SecondaryButton>
        </div>
        {error ? <p className="m-0 text-xs text-danger">{error}</p> : null}
      </div>
    </Overlay>
  );
}
