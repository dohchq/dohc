import type { CollectionSchema, FieldDefinition } from "@dohc/workspace-contracts";

/**
 * Resolves the ordered field definitions a view shows. With `visibleFields`
 * (a view definition's list of field names) the result follows that list and
 * drops names the schema no longer defines; without it, every schema field in
 * schema order.
 */
export function deriveColumns(
  schema: CollectionSchema,
  visibleFields?: readonly string[] | null,
): FieldDefinition[] {
  if (!visibleFields) return [...schema.fields];
  const byName = new Map(schema.fields.map((field) => [field.name, field]));
  const columns: FieldDefinition[] = [];
  for (const name of visibleFields) {
    const field = byName.get(name);
    if (field) columns.push(field);
  }
  return columns;
}
