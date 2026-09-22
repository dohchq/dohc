import type { CollectionRecord, CollectionSchema, FieldDefinition } from "@dohc/workspace-contracts";
import type { AppBackendJson } from "@dohc/security-contract/app-backend";
import { object, parsePage, type TransactionalField, type TransactionalRow } from "./transactionalCollectionModel";

export const BOARD_GROUP_PAGE_SIZE = 8;
export type GroupCursor = { value: AppBackendJson };
export type DateRange = { fieldId: string; start: string; end: string };
const unsupported = () => new Error("This Collection's read action does not support this view. Update its rules, then try again.");

export function calendarRange(fieldId: string, month: Date): DateRange {
  const first = new Date(month.getFullYear(), month.getMonth(), 1);
  first.setDate(first.getDate() - first.getDay());
  const end = new Date(month.getFullYear(), month.getMonth() + 1, 1);
  if (end.getDay()) end.setDate(end.getDate() + 7 - end.getDay());
  const date = (value: Date) => `${value.getFullYear()}-${String(value.getMonth()+1).padStart(2,"0")}-${String(value.getDate()).padStart(2,"0")}`;
  return { fieldId, start: date(first), end: date(end) };
}

export function parseGroups(raw: AppBackendJson, fieldId: string): { values: AppBackendJson[]; next: GroupCursor | null } {
  const result = object(raw);
  if (result.groupBy !== fieldId || !Array.isArray(result.groups) || result.groups.length > BOARD_GROUP_PAGE_SIZE || !Object.hasOwn(result,"nextGroupCursor")) throw unsupported();
  const values = result.groups;
  if (values.some(value => value !== null && !["string","number","boolean"].includes(typeof value)) || new Set(values.map(value => JSON.stringify(value))).size !== values.length) throw unsupported();
  let next: GroupCursor | null = null;
  if (result.nextGroupCursor !== null) {
    const cursor = object(result.nextGroupCursor!);
    if (!values.length || !Object.hasOwn(cursor,"value") || JSON.stringify(cursor.value) !== JSON.stringify(values.at(-1))) throw unsupported();
    next = { value: cursor.value! };
  }
  return { values, next };
}

export function parseCalendarPage(raw: AppBackendJson, fields: string[], range: DateRange) {
  const result = object(raw), acknowledged = result.range && object(result.range);
  if (!acknowledged || acknowledged.fieldId !== range.fieldId || acknowledged.start !== range.start || acknowledged.end !== range.end) throw unsupported();
  const page = parsePage(raw,fields);
  if (page.rows.some(row => typeof row.values[range.fieldId] !== "string" || row.values[range.fieldId]! < range.start || row.values[range.fieldId]! >= range.end)) throw unsupported();
  return page;
}

/** Shared view components use field keys internally; labels never replace dataset identities. */
export function visualSchema(fields: TransactionalField[]): CollectionSchema {
  return { name: null, description: null, views: [], fields: fields.map((field): FieldDefinition => {
    if (field.type === "select" || field.type === "multi-select") return { name: field.fieldId, type: field.type, options: field.options ?? [] };
    if (field.type === "attachment" || field.type === "relation") return { name: field.fieldId, type: "text" };
    return { name: field.fieldId, type: field.type };
  }) };
}

export function visualRecord(row: TransactionalRow, fields: TransactionalField[]): CollectionRecord {
  return { id: JSON.stringify(row.id), path: String(row.id), conflicted: false, values: fields.map(field => ({ field: field.fieldId,
    value: row.values[field.fieldId] ?? null, validation: { status: "valid" }, resolvedRelations: [] })) };
}
