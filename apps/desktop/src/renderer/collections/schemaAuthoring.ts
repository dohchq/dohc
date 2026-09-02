import { dump } from "js-yaml";
import type {
  CollectionSchema,
  FieldDefinition,
  ViewDefinition,
} from "@dohc/workspace-contracts";

// Pure schema-model operations behind the collection authoring UI. Every
// mutation returns a new CollectionSchema; serializeCollectionSchema turns it
// into the exact YAML shape parseCollectionSchema reads (fields as a mapping
// keyed by name, views as a sequence, optional keys omitted when unset).
// Callers validate names before mutating; these functions assume valid input.

function fieldEntry(field: FieldDefinition): Record<string, unknown> {
  switch (field.type) {
    case "select":
    case "multi-select":
      return { type: field.type, options: field.options };
    case "relation":
      return { type: field.type, collection: field.collection, many: field.many };
    default:
      return { type: field.type };
  }
}

function viewEntry(view: ViewDefinition): Record<string, unknown> {
  const entry: Record<string, unknown> = { name: view.name, kind: view.kind };
  if (view.groupBy !== null) entry.groupBy = view.groupBy;
  if (view.sort.length > 0) {
    entry.sort = view.sort.map((clause) => ({
      field: clause.field,
      direction: clause.direction,
    }));
  }
  if (view.visibleFields !== null) entry.visibleFields = view.visibleFields;
  if (view.dateField !== null) entry.dateField = view.dateField;
  return entry;
}

export function serializeCollectionSchema(schema: CollectionSchema): string {
  const document: Record<string, unknown> = {};
  if (schema.name !== null) document.name = schema.name;
  if (schema.description !== null) document.description = schema.description;
  document.fields = Object.fromEntries(
    schema.fields.map((field) => [field.name, fieldEntry(field)]),
  );
  if (schema.views.length > 0) document.views = schema.views.map(viewEntry);
  return dump(document, { lineWidth: -1, sortKeys: false });
}

export function addField(
  schema: CollectionSchema,
  field: FieldDefinition,
): CollectionSchema {
  return { ...schema, fields: [...schema.fields, field] };
}

// Field RENAME is deliberately absent: a schema-only rename disconnects
// every record's frontmatter key from the field. It ships together with the
// record-key rewrite, not before.

/** Replaces a select or multi-select field's options. Other fields pass through. */
export function setFieldOptions(
  schema: CollectionSchema,
  name: string,
  options: string[],
): CollectionSchema {
  return {
    ...schema,
    fields: schema.fields.map((field) =>
      field.name === name &&
      (field.type === "select" || field.type === "multi-select")
        ? { ...field, options }
        : field,
    ),
  };
}

/** Appends one option to a select or multi-select field; no-op when present. */
export function addSelectOption(
  schema: CollectionSchema,
  name: string,
  option: string,
): CollectionSchema {
  return {
    ...schema,
    fields: schema.fields.map((field) =>
      field.name === name &&
      (field.type === "select" || field.type === "multi-select") &&
      !field.options.includes(option)
        ? { ...field, options: [...field.options, option] }
        : field,
    ),
  };
}

export function addView(
  schema: CollectionSchema,
  view: ViewDefinition,
): CollectionSchema {
  return { ...schema, views: [...schema.views, view] };
}

export function renameView(
  schema: CollectionSchema,
  from: string,
  to: string,
): CollectionSchema {
  return {
    ...schema,
    views: schema.views.map((view) =>
      view.name === from ? { ...view, name: to } : view,
    ),
  };
}

export function deleteView(
  schema: CollectionSchema,
  name: string,
): CollectionSchema {
  return {
    ...schema,
    views: schema.views.filter((view) => view.name !== name),
  };
}
