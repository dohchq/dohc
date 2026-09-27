import { datasetColumnFields, type DatasetColumnField, type DatasetDefinition, type DatasetOperation } from "@dohc/security-contract/dataset";
import type { JsonValue } from "./protocol.js";

function denied(): never { throw new Error("This read returned values outside its approved access."); }
function object(value: JsonValue | undefined): value is Record<string, JsonValue> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Validate the generated read's projection before disclosing it to the app audience. */
export function validateDatasetReadResult(result: JsonValue, input: JsonValue, definition: DatasetDefinition, operation: DatasetOperation): JsonValue {
  const table = definition.tables.find(table => table.tableId === operation.tableId)!;
  const fields = datasetColumnFields(table).filter(field => operation.fieldIds.includes(field.fieldId));
  const primary = fields.find(field => field.sqlColumn === table.primaryKey);
  if (!primary || !object(result) || !object(input)) denied();
  const valid = (field: DatasetColumnField, value: JsonValue | undefined): boolean => {
    if (value === null) return !field.required;
    switch (field.type) {
      case "text": return typeof value === "string";
      case "number": return typeof value === "number" && Number.isFinite(value) && (field !== primary || Number.isSafeInteger(value));
      case "checkbox": return typeof value === "boolean";
      case "date": {
        if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
        const date = new Date(`${value}T00:00:00.000Z`);
        return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
      }
      case "url": return typeof value === "string" && /^https?:\/\/[^\s/?#]+(?:[/?#][^\s]*)?$/i.test(value);
      case "select": return typeof value === "string" && field.options!.includes(value);
      case "multi-select": return Array.isArray(value) && value.every(item => typeof item === "string" && field.options!.includes(item)) && new Set(value).size === value.length;
      case "attachment": return typeof value === "string" && /^[A-Za-z0-9._:-]{1,128}$/.test(value);
      case "relation": {
        const targetTable = definition.tables.find(table => table.tableId === field.relation!.tableId)!;
        const target = datasetColumnFields(targetTable).find(target => target.fieldId === field.relation!.fieldId)!;
        const scalar = (item: JsonValue | undefined) => target.type === "number"
          ? typeof item === "number" && Number.isFinite(item) && (target.sqlColumn !== targetTable.primaryKey || Number.isSafeInteger(item))
          : typeof item === "string";
        return field.relation!.many ? Array.isArray(value) && value.length <= 100 && value.every(scalar) && new Set(value).size === value.length : scalar(value);
      }
    }
  };
  const field = (id: JsonValue | undefined): DatasetColumnField => fields.find(field => field.fieldId === id) ?? denied();
  const scalarField = (field: DatasetColumnField): boolean => field.type !== "attachment" && field.type !== "multi-select" && !field.relation?.many;
  const cursor = (value: JsonValue | undefined, sort: DatasetColumnField, grouped = false): JsonValue => {
    if (value === null) return null;
    if (!object(value) || !valid(sort, value.value) || !scalarField(sort) ||
        Object.keys(value).some(key => !(grouped ? ["value"] : ["id", "value"]).includes(key)) ||
        (!grouped && !valid(primary, value.id))) denied();
    return value;
  };
  if (input.groupBy !== undefined) {
    const group = field(input.groupBy);
    if (result.groupBy !== input.groupBy || !scalarField(group) || !Array.isArray(result.groups) || !result.groups.every(value => valid(group, value))) denied();
    return { groupBy: group.fieldId, groups: result.groups, nextGroupCursor: cursor(result.nextGroupCursor, group, true) };
  }
  if (!Array.isArray(result.rows)) denied();
  const rows = result.rows.map(row => {
    if (!object(row) || !object(row.values) || !valid(primary, row.id) || !Number.isSafeInteger(row.version) || Number(row.version) < 1 ||
        Object.keys(row.values).length !== fields.length || fields.some(field => !valid(field, object(row.values) ? row.values[field.fieldId] : undefined)) ||
        row.values[primary.fieldId] !== row.id) denied();
    return { id: row.id, version: row.version, values: row.values };
  });
  const metadata: Record<string, JsonValue> = {};
  for (const key of ["range", "group"] as const) {
    const value = result[key];
    if (value === undefined && input[key] === undefined) continue;
    if (!object(value) || JSON.stringify(value) !== JSON.stringify(input[key])) denied();
    const approved = field(value.fieldId);
    if (key === "group") {
      if (!valid(approved, value.value) || Object.keys(value).some(key => !["fieldId", "value"].includes(key))) denied();
    } else if (approved.type !== "date" || typeof value.start !== "string" || typeof value.end !== "string" ||
        !valid(approved, value.start) || !valid(approved, value.end) || value.start >= value.end ||
        Object.keys(value).some(key => !["fieldId", "start", "end"].includes(key))) denied();
    metadata[key] = value;
  }
  const sort = input.sort === undefined ? primary : object(input.sort) ? field(input.sort.fieldId) : denied();
  return { rows, nextCursor: cursor(result.nextCursor, sort), ...metadata };
}
