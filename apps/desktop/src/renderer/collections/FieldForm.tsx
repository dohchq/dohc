import {
  RECORD_ID_FRONTMATTER_KEY,
  type CollectionFieldType,
  type FieldDefinition,
} from "@dohc/workspace-contracts/collection";

// The one text-input and select look across the collection dialogs.
export const inputClass =
  "w-full rounded-md border border-line bg-bg px-2.5 py-1.5 text-[13px] text-ink placeholder:text-subtle focus:border-ink disabled:opacity-50";
export const selectClass =
  "w-full rounded-md border border-line bg-bg px-2 py-1.5 text-[13px] text-ink focus:border-ink disabled:opacity-50";

// The one field form: a draft the user edits in collection vocabulary
// (name, type, options, related collection) that maps onto a schema
// FieldDefinition. The new-collection dialog and the fields dialog both
// compose FieldDraftRow so the two surfaces cannot drift.

export interface FieldDraft {
  name: string;
  type: CollectionFieldType;
  /** Comma-separated option labels for select and multi-select. */
  optionsText: string;
  /** A collection folder path for relation fields. */
  relationTarget: string;
  relationMany: boolean;
}

export const FIELD_TYPE_LABELS: Record<CollectionFieldType, string> = {
  text: "Text",
  number: "Number",
  checkbox: "Checkbox",
  date: "Date",
  select: "Select",
  "multi-select": "Multi-select",
  person: "Person",
  relation: "Relation",
  url: "URL",
  button: "Button",
};

/** Every field type, as an open Collection's Fields dialog offers them. */
export const FIELD_TYPES_WITH_BUTTON = Object.keys(FIELD_TYPE_LABELS) as CollectionFieldType[];
// A button does nothing until an automation uses it. A new Collection has no
// automations, so its form leaves Button out; the Fields dialog offers it.
export const FIELD_TYPES = FIELD_TYPES_WITH_BUTTON.filter((type) => type !== "button");

export function emptyFieldDraft(name = "", type: CollectionFieldType = "text"): FieldDraft {
  return { name, type, optionsText: "", relationTarget: "", relationMany: false };
}

export function parseOptionsText(text: string): string[] {
  const options: string[] = [];
  for (const raw of text.split(",")) {
    const option = raw.trim();
    if (option !== "" && !options.includes(option)) options.push(option);
  }
  return options;
}

/**
 * The refusal for a select or multi-select field with no options: a board
 * grouped on such a field would produce no groups. Shared with the fields
 * dialog's option-edit path so the two surfaces say the same sentence.
 */
export const NO_OPTIONS_PROBLEM = "Give the field at least one option.";

/**
 * The first problem with a draft as a user-facing sentence, or null when the
 * draft maps onto a valid FieldDefinition. `takenNames` holds every other
 * field name on the surface.
 */
export function fieldDraftError(
  draft: FieldDraft,
  takenNames: readonly string[],
): string | null {
  const name = draft.name.trim();
  if (name === "") return "Give the field a name.";
  if (name === RECORD_ID_FRONTMATTER_KEY) {
    return `The name "${RECORD_ID_FRONTMATTER_KEY}" is reserved. Choose another name.`;
  }
  if (takenNames.includes(name)) {
    return `A field named "${name}" already exists. Choose another name.`;
  }
  if (draft.type === "relation" && draft.relationTarget === "") {
    return "Choose a collection to relate to.";
  }
  if (
    (draft.type === "select" || draft.type === "multi-select") &&
    parseOptionsText(draft.optionsText).length === 0
  ) {
    return NO_OPTIONS_PROBLEM;
  }
  return null;
}

/** Maps a valid draft to its FieldDefinition. Validate with fieldDraftError first. */
export function draftToField(draft: FieldDraft): FieldDefinition {
  const name = draft.name.trim();
  switch (draft.type) {
    case "select":
    case "multi-select":
      return { name, type: draft.type, options: parseOptionsText(draft.optionsText) };
    case "relation":
      return {
        name,
        type: "relation",
        collection: draft.relationTarget,
        many: draft.relationMany,
      };
    default:
      return { name, type: draft.type };
  }
}

export function FieldDraftRow({
  draft,
  onChange,
  relationTargets,
  disabled,
  types = FIELD_TYPES,
}: {
  draft: FieldDraft;
  onChange: (draft: FieldDraft) => void;
  /** Collection folder paths a relation field can target. */
  relationTargets: readonly string[];
  disabled?: boolean;
  /** The field types to offer. */
  types?: readonly CollectionFieldType[];
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center gap-1.5">
        <input
          type="text"
          aria-label="Field name"
          placeholder="Field name"
          disabled={disabled}
          value={draft.name}
          onChange={(event) => onChange({ ...draft, name: event.target.value })}
          className={inputClass}
        />
        <select
          aria-label="Field type"
          disabled={disabled}
          value={draft.type}
          onChange={(event) =>
            onChange({ ...draft, type: event.target.value as CollectionFieldType })
          }
          className="w-36 shrink-0 rounded-md border border-line bg-bg px-2 py-1.5 text-[13px] text-ink focus:border-ink disabled:opacity-50"
        >
          {types.map((type) => (
            <option key={type} value={type}>
              {FIELD_TYPE_LABELS[type]}
            </option>
          ))}
        </select>
      </div>
      {draft.type === "select" || draft.type === "multi-select" ? (
        <input
          type="text"
          aria-label="Options"
          placeholder="Todo, Doing, Done"
          disabled={disabled}
          value={draft.optionsText}
          onChange={(event) =>
            onChange({ ...draft, optionsText: event.target.value })
          }
          className={inputClass}
        />
      ) : null}
      {draft.type === "relation" ? (
        <div className="flex items-center gap-1.5">
          <select
            aria-label="Related collection"
            disabled={disabled}
            value={draft.relationTarget}
            onChange={(event) =>
              onChange({ ...draft, relationTarget: event.target.value })
            }
            className={selectClass}
          >
            <option value="">Choose a collection</option>
            {relationTargets.map((target) => (
              <option key={target} value={target}>
                {target}
              </option>
            ))}
          </select>
          <label className="flex shrink-0 items-center gap-1.5 text-[12px] text-muted">
            <input
              type="checkbox"
              disabled={disabled}
              checked={draft.relationMany}
              onChange={(event) =>
                onChange({ ...draft, relationMany: event.target.checked })
              }
            />
            Link many records
          </label>
        </div>
      ) : null}
    </div>
  );
}
