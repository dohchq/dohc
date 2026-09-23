import { parseAppBackendJson, type AppBackendJson } from "@dohc/security-contract/app-backend";
import type { DatasetOperation } from "@dohc/security-contract/dataset";
import type { TransactionalInvoke } from "./TransactionalCollectionPage";
import { parsePage, type TransactionalCursor, type TransactionalDatasetDescription, type TransactionalField } from "./transactionalCollectionModel";

export const CSV_IMPORT_MAX_BYTES = 4 * 1024 * 1024;
export const CSV_IMPORT_MAX_ROWS = 10_000;
const encoder = new TextEncoder();
export interface CsvTable {
  headers: string[];
  rows: string[][];
  /** Source adapters retain nulls and empty text; CSV itself has no distinction. */
  literalValues?: Array<Array<AppBackendJson | undefined>>;
  rowErrors?: string[];
  cellErrors?: string[][];
}
export interface CsvPreviewRow { row: number; values: Record<string, AppBackendJson>; errors: string[] }
export interface CsvPreview { fields: TransactionalField[]; rows: CsvPreviewRow[] }
export type CsvOutcome = "pending" | "invalid" | "accepted" | "refused" | "uncertain";
export interface CsvImportRow extends CsvPreviewRow { idempotencyKey: string; outcome: CsvOutcome; message?: string }
export interface CsvImportPlan {
  formatVersion: 1;
  scope: Omit<TransactionalInvoke, "input" | "idempotencyKey">;
  rows: CsvImportRow[];
}
export type CsvInvoke = (request: TransactionalInvoke, signal: AbortSignal) => Promise<{ result: AppBackendJson }>;

/** Strict bounded CSV parsing; malformed quoting must not silently change imported values. */
export function parseDatasetCsv(text: string): CsvTable {
  if (encoder.encode(text).byteLength > CSV_IMPORT_MAX_BYTES) throw Error("Choose a CSV file smaller than 4 MB.");
  const source = text.replace(/^\uFEFF/, "");
  const rows: string[][] = []; let row: string[] = [], value = "", quoted = false, closed = false;
  function cell() { row.push(value); value = ""; closed = false; if (row.length > 128) throw Error("Choose a CSV file with at most 128 columns."); }
  function line() { cell(); rows.push(row); row = []; if (rows.length > CSV_IMPORT_MAX_ROWS + 1) throw Error("Import at most 10,000 rows at a time."); }
  for (let index = 0; index < source.length; index++) {
    const char = source[index]!;
    if (quoted) {
      if (char === '"') { if (source[index + 1] === '"') { value += '"'; index++; } else { quoted = false; closed = true; } }
      else value += char;
    } else if (char === ",") cell();
    else if (char === "\r" || char === "\n") { line(); if (char === "\r" && source[index + 1] === "\n") index++; }
    else if (char === '"' && value === "" && !closed) quoted = true;
    else if (closed || char === '"') throw Error("The CSV contains a misplaced quote. Correct the file and try again.");
    else value += char;
  }
  if (quoted) throw Error("The CSV contains an unclosed quote. Correct the file and try again.");
  if (value || row.length || closed) line();
  if (!rows.length || rows[0]!.every(header => !header.trim())) throw Error("Add a header row to this CSV file.");
  return { headers: rows[0]!, rows: rows.slice(1) };
}

function convert(field: TransactionalField, raw: string): AppBackendJson | undefined {
  if (raw === "") {
    if (Object.hasOwn(field, "default")) return undefined;
    if (field.required) throw Error(`Enter ${field.name}.`);
    return null;
  }
  switch (field.type) {
    case "text": return raw;
    case "number": { if (!/^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(raw.trim()) || !Number.isFinite(Number(raw))) throw Error(`Enter a number for ${field.name}.`); return Number(raw); }
    case "checkbox": if (/^(true|false)$/i.test(raw)) return raw.toLowerCase() === "true"; throw Error(`Use true or false for ${field.name}.`);
    case "select": if (field.options?.includes(raw)) return raw; throw Error(`Choose a listed option for ${field.name}.`);
    case "date": { const date = new Date(`${raw}T00:00:00.000Z`); if (!/^\d{4}-\d{2}-\d{2}$/.test(raw) || !Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== raw) throw Error(`Use YYYY-MM-DD for ${field.name}.`); return raw; }
    case "url": { try { if (["http:", "https:"].includes(new URL(raw).protocol) && !/\s/.test(raw)) return raw; } catch { /* Report the field below. */ } throw Error(`Enter a web address for ${field.name}.`); }
    case "attachment": throw Error(`Upload ${field.name} through the Collection. CSV cannot upload files.`);
    case "multi-select": { let value: unknown; try { value = JSON.parse(raw); } catch { throw Error(`Use a JSON array for ${field.name}.`); }
      if (!Array.isArray(value) || value.some(entry => typeof entry !== "string" || !field.options?.includes(entry)) || new Set(value).size !== value.length) throw Error(`Use a JSON array of listed options for ${field.name}.`); return value; }
    case "relation": { let value: unknown; try { value = JSON.parse(raw); } catch { throw Error(`Use a JSON record key for ${field.name}.`); }
      const key = (entry: unknown) => typeof entry === "string" && entry.length > 0 && entry.length <= 1024 || typeof entry === "number" && Number.isSafeInteger(entry);
      if (field.relation?.many ? !Array.isArray(value) || value.length > 100 || !value.every(key) || new Set(value.map(entry => JSON.stringify(entry))).size !== value.length : !key(value)) throw Error(`Use ${field.relation?.many ? "a JSON array of record keys" : "a JSON record key"} for ${field.name}.`);
      return value as AppBackendJson;
    }
  }
}
export function previewDatasetCsv(csv: CsvTable, fields: readonly TransactionalField[], operation: DatasetOperation, mapping: readonly (string | null)[]): CsvPreview {
  if (operation.kind !== "create" || operation.readOnly) throw Error("Choose a permitted create action for this import.");
  const allowed = fields.filter(field => operation.fieldIds.includes(field.fieldId));
  const selected = mapping.filter((id): id is string => id !== null);
  if (mapping.length !== csv.headers.length || selected.some(id => !allowed.some(field => field.fieldId === id)) || selected.length !== new Set(selected).size) throw Error("Map each CSV column to a different permitted field.");
  if (!selected.length) throw Error("Map at least one CSV column to a field.");
  const missing = allowed.filter(field => field.required && !Object.hasOwn(field, "default") && !selected.includes(field.fieldId));
  return { fields: allowed, rows: csv.rows.map((cells, index) => {
    const values: Record<string, AppBackendJson> = {}, errors = missing.map(field => `Map the required field ${field.name}.`);
    if (csv.rowErrors?.[index]) errors.push(csv.rowErrors[index]!);
    if (cells.length !== csv.headers.length) errors.push(`Expected ${csv.headers.length} columns; found ${cells.length}.`);
    for (const [column, fieldId] of mapping.entries()) {
      if (fieldId === null || cells[column] === undefined) continue;
      if (csv.cellErrors?.[index]?.[column]) { errors.push(csv.cellErrors[index]![column]!); continue; }
      const field = allowed.find(field => field.fieldId === fieldId)!;
      try {
        const literal = csv.literalValues?.[index]?.[column];
        let value: AppBackendJson | undefined;
        if (csv.literalValues && literal === undefined) value = convert(field, "");
        else if (csv.literalValues && literal === null) {
          if (field.required) throw Error(`Enter ${field.name}.`);
          value = null;
        } else if (csv.literalValues && literal === "") {
          if (field.type !== "text") throw Error(`Empty source text is not a ${field.type} value for ${field.name}.`);
          value = "";
        }
        else value = convert(field, csv.literalValues && field.type === "relation" ? JSON.stringify(literal) : cells[column]!);
        if (value !== undefined) values[fieldId] = value;
      }
      catch (error) { errors.push(error instanceof Error ? error.message : "Check this field."); }
    }
    try { parseAppBackendJson({ values }); } catch { errors.push("This row is too large. Shorten its field values."); for (const fieldId of Object.keys(values)) delete values[fieldId]; }
    return { row: index + 2, values, errors };
  }) };
}
export function createCsvImportPlan(scope: CsvImportPlan["scope"], preview: CsvPreview, uuid: () => string = () => crypto.randomUUID()): CsvImportPlan {
  const plan: CsvImportPlan = { formatVersion: 1, scope: structuredClone(scope), rows: preview.rows.map(row => ({ ...structuredClone(row), idempotencyKey: uuid(), outcome: row.errors.length ? "invalid" : "pending" })) };
  if (encoder.encode(JSON.stringify(plan, null, 2)).byteLength > 16 * 1024 * 1024) throw Error("This retry report is too large. Import fewer rows at a time.");
  return plan;
}
/** A connection failure may follow a commit. Stop and retry that exact row identity before proceeding. */
export async function runCsvImport(plan: CsvImportPlan, invoke: CsvInvoke, signal: AbortSignal, checkpoint: (plan: CsvImportPlan) => void = () => {}): Promise<CsvImportPlan> {
  const next = structuredClone(plan);
  for (const row of next.rows) {
    if (signal.aborted || !["pending", "uncertain"].includes(row.outcome)) continue;
    try {
      await invoke({ ...next.scope, input: { values: row.values }, idempotencyKey: row.idempotencyKey }, signal);
      row.outcome = "accepted"; delete row.message;
    } catch (error) {
      const refusal = error !== null && typeof error === "object" && "code" in error && error.code === "operation_refused";
      row.outcome = refusal ? "refused" : "uncertain";
      row.message = error instanceof Error ? error.message : refusal ? "The create action refused this row." : "The save could not be confirmed.";
      checkpoint(structuredClone(next));
      if (!refusal) break;
      continue;
    }
    checkpoint(structuredClone(next));
  }
  return next;
}

function csvCell(value: AppBackendJson | undefined, safe: boolean): string {
  let text = value === undefined || value === null ? "" : typeof value === "object" ? JSON.stringify(value) : String(value);
  if (safe && typeof value === "string" && /^[\s\u0000-\u001f]*[=+\-@]/u.test(text)) text = "'" + text;
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}
export async function exportDatasetCsv(input: {
  scope: CsvImportPlan["scope"]; operation: DatasetOperation; fields: readonly TransactionalField[]; invoke: CsvInvoke; signal: AbortSignal; spreadsheetSafe?: boolean;
}): Promise<{ content: string; rows: number }> {
  if (input.operation.kind !== "read" || !input.operation.readOnly || input.operation.operationId !== input.scope.operationId) throw Error("Choose a permitted read action for this export.");
  const fields = input.fields.filter(field => input.operation.fieldIds.includes(field.fieldId));
  if (!fields.length) throw Error("This read action exposes no fields to export.");
  const safe = input.spreadsheetSafe !== false;
  const lines = [fields.map(field => csvCell(field.name, safe)).join(",")];
  let after: TransactionalCursor | null = null, count = 0, bytes = encoder.encode(lines[0]!).byteLength;
  const cursors = new Set<string>(), records = new Set<string>();
  do {
    input.signal.throwIfAborted();
    const response = await input.invoke({ ...input.scope, input: { limit: 50, after: after ? { ...after } : null }, idempotencyKey: crypto.randomUUID() }, input.signal);
    input.signal.throwIfAborted();
    const page = parsePage(response.result, fields.map(field => field.fieldId));
    for (const row of page.rows) {
      const key = JSON.stringify(row.id);
      if (records.has(key)) throw Error("The Collection changed during export. Start the export again.");
      records.add(key);
      const line = fields.map(field => { const value = row.values[field.fieldId]; return csvCell(field.type === "relation" && value !== undefined && value !== null ? JSON.stringify(value) : value, safe); }).join(",");
      bytes += encoder.encode(line).byteLength + 2;
      if (++count > 100_000 || bytes > 32 * 1024 * 1024) throw Error("This export exceeds 100,000 rows or 32 MB. Export a smaller view.");
      lines.push(line);
    }
    after = page.nextCursor;
    if (after !== null) { const key = JSON.stringify(after); if (!page.rows.length || cursors.has(key)) throw Error("The read action returned a repeated page. Check its pagination."); cursors.add(key); }
  } while (after !== null);
  return { content: lines.join("\r\n") + "\r\n", rows: count };
}

/** Recovery reports preserve captured inputs and retry identities, scoped to the exact approved revision. */
export function parseCsvImportReport(text: string, scope: CsvImportPlan["scope"], fields: readonly TransactionalField[], operation: DatasetOperation): CsvImportPlan {
  if (encoder.encode(text).byteLength > 16 * 1024 * 1024) throw Error("Choose an import report smaller than 16 MB.");
  const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
  const value: unknown = JSON.parse(text);
  if (!object(value) || value.formatVersion !== 1 || !object(value.scope) || !Array.isArray(value.rows) || value.rows.length > CSV_IMPORT_MAX_ROWS) throw Error("Choose an import report for this Collection revision and create action.");
  const capturedScope = value.scope;
  if (Object.keys(scope).some(key => capturedScope[key] !== scope[key as keyof typeof scope])) throw Error("Choose an import report for this Collection revision and create action.");
  const keys = new Set<string>(), numbers = new Set<number>(), allowed = new Set(fields.filter(field => operation.fieldIds.includes(field.fieldId)).map(field => field.fieldId));
  const rows = value.rows.map(item => {
    if (!object(item) || typeof item.row !== "number" || !Number.isSafeInteger(item.row) || item.row < 2 || numbers.has(item.row) || typeof item.idempotencyKey !== "string" || !/^[0-9a-f-]{36}$/.test(item.idempotencyKey) || keys.has(item.idempotencyKey) || typeof item.outcome !== "string" || !["pending", "invalid", "accepted", "refused", "uncertain"].includes(item.outcome) || !object(item.values) || Object.keys(item.values).some(id => !allowed.has(id)) || !Array.isArray(item.errors) || item.errors.some(error => typeof error !== "string") || item.message !== undefined && typeof item.message !== "string") throw Error("This import report is invalid. Choose an unchanged report.");
    keys.add(item.idempotencyKey); numbers.add(item.row);
    return { row: item.row, idempotencyKey: item.idempotencyKey, outcome: item.outcome as CsvOutcome, values: parseAppBackendJson(item.values) as Record<string, AppBackendJson>, errors: item.errors as string[], ...(typeof item.message === "string" ? { message: item.message } : {}) };
  });
  return { formatVersion: 1, scope: structuredClone(scope), rows };
}
