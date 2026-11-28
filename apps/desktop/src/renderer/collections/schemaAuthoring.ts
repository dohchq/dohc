import {
  chosenOptionColor,
  serializeCollectionSchema,
  type CollectionSchema,
  type FieldDefinition,
  type OptionColor,
  type ViewDefinition,
} from "@dohc/workspace-contracts";

export { serializeCollectionSchema };

export function addField(schema: CollectionSchema, field: FieldDefinition): CollectionSchema {
  return { ...schema, fields: [...schema.fields, field] };
}

// Field rename is deliberately absent: a schema-only rename disconnects
// every record's frontmatter key from the field. It ships together with the
// record-key rewrite, not before.

/** The colors of the given options, in their order, so the file reads top to bottom. */
function keptColors(
  options: readonly string[],
  colors: Readonly<Record<string, OptionColor>> | undefined,
): { colors?: Record<string, OptionColor> } {
  const kept = options.flatMap((option) => {
    const color = chosenOptionColor(colors, option);
    return color ? [[option, color] as const] : [];
  });
  return kept.length > 0 ? { colors: Object.fromEntries(kept) } : {};
}

/**
 * Replaces a select or multi-select field's options. `colors` holds the colors
 * someone chose; other options keep the colors they have. Other fields pass
 * through.
 */
export function setFieldOptions(
  schema: CollectionSchema,
  name: string,
  options: string[],
  colors?: Readonly<Record<string, OptionColor>>,
): CollectionSchema {
  return {
    ...schema,
    fields: schema.fields.map((field) => {
      if (field.name !== name || (field.type !== "select" && field.type !== "multi-select"))
        return field;
      const { colors: _previous, ...rest } = field;
      return { ...rest, options, ...keptColors(options, { ...field.colors, ...colors }) };
    }),
  };
}

/** Sets one option's color on a select or multi-select field. */
export function setOptionColor(
  schema: CollectionSchema,
  name: string,
  option: string,
  color: OptionColor,
): CollectionSchema {
  return {
    ...schema,
    fields: schema.fields.map((field) =>
      field.name === name &&
      (field.type === "select" || field.type === "multi-select") &&
      field.options.includes(option)
        ? { ...field, ...keptColors(field.options, { ...field.colors, [option]: color }) }
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

export function addView(schema: CollectionSchema, view: ViewDefinition): CollectionSchema {
  return { ...schema, views: [...schema.views, view] };
}

export function addViewPreservingTable(
  schema: CollectionSchema,
  view: ViewDefinition,
): CollectionSchema {
  const base =
    schema.views.length === 0 && view.kind !== "table"
      ? addView(schema, {
          name: view.name.trim().toLowerCase() === "table" ? "All records" : "Table",
          kind: "table",
          groupBy: null,
          sort: [],
          visibleFields: null,
          dateField: null,
        })
      : schema;
  return addView(base, view);
}

function groupFieldRank(fieldType: FieldDefinition["type"]): number {
  switch (fieldType) {
    case "select":
      return 0;
    case "multi-select":
      return 1;
    case "checkbox":
      return 2;
    case "person":
      return 3;
    default:
      return 4;
  }
}

export function orderGroupFields(fields: readonly FieldDefinition[]): FieldDefinition[] {
  return fields
    .filter((field) => field.type !== "button")
    .sort((a, b) => groupFieldRank(a.type) - groupFieldRank(b.type));
}

export function renameView(schema: CollectionSchema, from: string, to: string): CollectionSchema {
  return {
    ...schema,
    views: schema.views.map((view) => (view.name === from ? { ...view, name: to } : view)),
  };
}

export function deleteView(schema: CollectionSchema, name: string): CollectionSchema {
  return {
    ...schema,
    views: schema.views.filter((view) => view.name !== name),
  };
}
