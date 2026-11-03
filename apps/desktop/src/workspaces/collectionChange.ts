import { z } from "zod";
import { isDatasetColumnField, type DatasetDefinition, type DatasetField, type DatasetFieldType, type DatasetOperation, type DatasetRevision } from "@dohc/security-contract/dataset";
import { hasGeneratedDatasetOperations } from "@dohc/security-contract/dataset-operations";
import type { DatasetMigrationCandidate, DatasetMigrationPreparation } from "@dohc/cli/dataset";

/**
 * The rows a person reads before applying a change to a Collection's rules,
 * as data. A row says what one part of the change does and what it does to
 * existing records. `describeCollectionChangeRow` turns it into words.
 */
const name = z.string().min(1).max(256);
const count = z.number().int().nonnegative().nullable();
const fieldType = z.enum(["text", "number", "checkbox", "date", "select", "multi-select", "url", "relation", "attachment", "button"]);
const author = z.object({ name, agent: z.boolean() }).strict();
const source = z.object({ path: z.string().min(1).max(1024), author: author.nullable(), atMs: z.number().int().nonnegative().nullable() }).strict();
const row = <Shape extends z.ZodRawShape>(shape: Shape) => z.object({ key: z.string().min(1).max(128), source: source.optional(), ...shape }).strict();
export const CollectionChangeRow = z.discriminatedUnion("kind", [
  row({ kind: z.literal("collection-renamed"), from: name, to: name }),
  row({ kind: z.literal("table-added"), table: name }),
  row({ kind: z.literal("table-removed"), table: name, records: count }),
  row({ kind: z.literal("table-renamed"), from: name, to: name }),
  row({ kind: z.literal("field-added"), field: name, type: fieldType, records: count, empty: count }),
  row({ kind: z.literal("field-renamed"), from: name, to: name, button: z.boolean() }),
  row({ kind: z.literal("field-removed"), field: name, button: z.boolean(), values: count }),
  row({ kind: z.literal("field-type"), field: name, from: fieldType, to: fieldType, lost: count }),
  row({ kind: z.literal("field-required"), field: name, required: z.boolean() }),
  row({ kind: z.literal("field-unique"), field: name, unique: z.boolean(), values: count }),
  row({ kind: z.literal("field-choices"), field: name }),
  row({ kind: z.literal("field-default"), field: name }),
  row({ kind: z.literal("field-changed"), field: name, lost: count }),
  row({ kind: z.literal("records-deleted"), table: name, records: z.number().int().positive() }),
  row({ kind: z.literal("action-added"), action: name }),
  row({ kind: z.literal("action-removed"), action: name }),
  row({ kind: z.literal("action-changed"), action: name }),
  row({ kind: z.literal("code-changed") }),
  row({ kind: z.literal("schema-changed"), file: z.string().min(1).max(1024) }),
  row({ kind: z.literal("migration"), file: z.string().min(1).max(1024), records: count }),
]);
export type CollectionChangeRow = z.infer<typeof CollectionChangeRow>;
export type CollectionChangeAuthor = z.infer<typeof author>;
export type CollectionChangeSource = z.infer<typeof source>;
type Counts = DatasetMigrationCandidate["preview"]["tables"];
/** A row before `attributeCollectionChangeRows` names who made it. */
export type CollectionChangeDraft = CollectionChangeRow extends infer Row ? Row extends CollectionChangeRow ? Omit<Row, "source"> : never : never;
type Draft = CollectionChangeDraft;

const json = (value: unknown) => JSON.stringify(value) ?? "";
const button = (field: DatasetField) => field.type === "button";
/** People act through these. Owner operations are how the owner's own grid reads and edits. */
const visible = (operation: DatasetOperation) => operation.access !== "owner" || operation.kind === "action";
const rank: Record<CollectionChangeRow["kind"], number> = {
  "table-added": 0, "field-added": 0, "collection-renamed": 1, "table-renamed": 1, "field-renamed": 1,
  "field-removed": 2, "table-removed": 2, "records-deleted": 2, "field-type": 3, "field-changed": 3,
  "action-added": 4, "action-removed": 4, "action-changed": 4, "code-changed": 4,
  "field-unique": 5, "field-required": 5, "field-choices": 5, "field-default": 5, "schema-changed": 6, "migration": 7,
};

/** Rows for the difference between two definitions. With `counts`, rows also say what happens to existing values. */
export function collectionDefinitionRows(previous: DatasetDefinition, next: DatasetDefinition, counts?: Counts): Draft[] {
  const rows: Draft[] = [];
  const summary = (sqlName: string) => counts?.find(table => table.table === sqlName);
  if (previous.name !== next.name) rows.push({ kind: "collection-renamed", key: "collection:name", from: previous.name, to: next.name });
  const before = new Map(previous.tables.map(table => [table.tableId, table]));
  const shared = new Set<string>();
  for (const table of next.tables) {
    const old = before.get(table.tableId);
    if (!old) { rows.push({ kind: "table-added", key: `table:${table.tableId}:added`, table: table.name }); continue; }
    if (old.name !== table.name) rows.push({ kind: "table-renamed", key: `table:${table.tableId}:name`, from: old.name, to: table.name });
    const was = summary(old.sqlName), now = old.sqlName === table.sqlName ? was : summary(table.sqlName);
    if (was?.deletedRows) rows.push({ kind: "records-deleted", key: `table:${table.tableId}:records`, table: table.name, records: was.deletedRows });
    const oldFields = new Map(old.fields.map(field => [field.fieldId, field]));
    for (const field of table.fields) {
      const prior = oldFields.get(field.fieldId), key = `field:${field.fieldId}`;
      if (!prior) {
        const filled = isDatasetColumnField(field) && now ? now.afterValues[field.sqlColumn] : undefined;
        rows.push({ kind: "field-added", key: `${key}:added`, field: field.name, type: field.type,
          records: now?.afterRows ?? null, empty: filled === undefined ? null : now!.afterRows - filled });
        continue;
      }
      shared.add(field.fieldId);
      if (prior.name !== field.name) rows.push({ kind: "field-renamed", key: `${key}:name`, from: prior.name, to: field.name, button: button(field) });
      if (!isDatasetColumnField(prior) || !isDatasetColumnField(field)) {
        if (prior.type !== field.type) rows.push({ kind: "field-changed", key: `${key}:other`, field: field.name, lost: null });
        continue;
      }
      const has = now?.afterValues[field.sqlColumn];
      const lost = (old.sqlName === table.sqlName && prior.sqlColumn === field.sqlColumn ? was?.clearedValues[prior.sqlColumn] : undefined) || null;
      if (prior.type !== field.type) rows.push({ kind: "field-type", key: `${key}:type`, field: field.name, from: prior.type, to: field.type, lost });
      else if (lost) rows.push({ kind: "field-changed", key: `${key}:values`, field: field.name, lost });
      if (prior.required !== field.required) rows.push({ kind: "field-required", key: `${key}:required`, field: field.name, required: field.required });
      if (prior.unique !== field.unique) rows.push({ kind: "field-unique", key: `${key}:unique`, field: field.name, unique: field.unique, values: has ?? null });
      if (json(prior.options) !== json(field.options)) rows.push({ kind: "field-choices", key: `${key}:options`, field: field.name });
      if (Object.hasOwn(prior, "default") !== Object.hasOwn(field, "default") || json(prior.default) !== json(field.default)) rows.push({ kind: "field-default", key: `${key}:default`, field: field.name });
      if (prior.sqlColumn !== field.sqlColumn || json(prior.relation) !== json(field.relation) || prior.generated !== field.generated) rows.push({ kind: "field-changed", key: `${key}:other`, field: field.name, lost: null });
    }
    for (const prior of old.fields) if (!table.fields.some(field => field.fieldId === prior.fieldId)) {
      const values = isDatasetColumnField(prior) ? was?.beforeValues[prior.sqlColumn] : undefined;
      rows.push({ kind: "field-removed", key: `field:${prior.fieldId}:removed`, field: prior.name, button: button(prior), values: values ?? null });
    }
  }
  for (const old of previous.tables) if (!next.tables.some(table => table.tableId === old.tableId)) {
    rows.push({ kind: "table-removed", key: `table:${old.tableId}:removed`, table: old.name, records: summary(old.sqlName)?.beforeRows ?? null });
  }
  const operations = new Map(previous.operations.map(operation => [operation.operationId, operation]));
  const shape = (operation: DatasetOperation) => json({ ...operation, operationId: undefined, fieldIds: operation.fieldIds.filter(id => shared.has(id)) });
  for (const operation of next.operations) {
    const old = operations.get(operation.operationId), key = `action:${operation.operationId}`;
    if (!old) { if (visible(operation)) rows.push({ kind: "action-added", key: `${key}:added`, action: operation.label }); }
    else if ((visible(old) || visible(operation)) && shape(old) !== shape(operation)) rows.push({ kind: "action-changed", key: `${key}:changed`, action: operation.label });
  }
  for (const old of previous.operations) if (visible(old) && !next.operations.some(operation => operation.operationId === old.operationId)) {
    rows.push({ kind: "action-removed", key: `action:${old.operationId}:removed`, action: old.label });
  }
  return rows;
}

const RUNS_NOTHING = /^\s*select\s+1\s*;?\s*$/i;

/** Every row a prepared change applies, in the order a person reads them. */
export function collectionChangeRows(input: { previous: DatasetRevision; next: DatasetRevision; operationSource: string; migrationSql: string; migrationPath: string; counts?: Counts }): Draft[] {
  const rows = collectionDefinitionRows(input.previous.definition, input.next.definition, input.counts);
  const structural = rows.some(row => ["table-added", "table-removed", "field-added", "field-removed", "field-type", "field-required", "field-unique", "field-choices", "field-default", "field-changed"].includes(row.kind));
  if (input.previous.operationsSha256 !== input.next.operationsSha256 && !hasGeneratedDatasetOperations(input.operationSource, input.next.definition)
      && !rows.some(row => row.kind.startsWith("action-"))) rows.push({ kind: "code-changed", key: "code" });
  if (input.previous.schemaSha256 !== input.next.schemaSha256 && !structural) rows.push({ kind: "schema-changed", key: "schema", file: input.next.definition.schemaPath });
  if (!RUNS_NOTHING.test(input.migrationSql)) {
    const records = input.counts ? input.counts.reduce((total, table) => total + table.beforeRows, 0) : null;
    rows.push({ kind: "migration", key: "migration", file: input.migrationPath, records });
  }
  return rows.map((row, index) => ({ row, index })).sort((a, b) => rank[a.row.kind] - rank[b.row.kind] || a.index - b.index).map(({ row }) => row);
}

const sha256 = z.string().regex(/^[0-9a-f]{64}$/u);
const filePath = z.string().min(1).max(1024);
/** A change an agent asks a person to apply, as the file its chat message attaches. */
export const CollectionChangeProposal = z.object({
  kind: z.literal("dohc-collection-change"), version: z.literal(1),
  datasetId: z.string().min(1).max(128), name, datasetPath: filePath, migrationPath: filePath,
  base: z.object({ revision: z.number().int().positive(), revisionSha256: sha256 }).strict(),
  revisionSha256: sha256, changeSha256: sha256,
  files: z.array(filePath).min(1).max(4),
  rows: z.array(CollectionChangeRow).min(1).max(500),
  note: z.string().min(1).max(500).nullable(),
}).strict();
export type CollectionChangeProposal = z.infer<typeof CollectionChangeProposal>;

/** What a prepared change applies, for the person an agent asks to apply it. */
export function collectionChangeProposal(prepared: Pick<DatasetMigrationPreparation, "previousRevision" | "revision" | "operationSource" | "migrationSql" | "candidate">,
  input: { datasetPath: string; migrationPath: string; note: string | null }): CollectionChangeProposal {
  const { previousRevision: previous, revision: next } = prepared;
  const rows = collectionChangeRows({ previous, next, operationSource: prepared.operationSource, migrationSql: prepared.migrationSql, migrationPath: input.migrationPath, counts: prepared.candidate.preview.tables });
  if (rows.length === 0) throw new Error("These files match the Collection's rules. Change them, then ask again.");
  const files = [
    previous.definitionSha256 === next.definitionSha256 ? null : input.datasetPath,
    previous.schemaSha256 === next.schemaSha256 ? null : next.definition.schemaPath,
    previous.operationsSha256 === next.operationsSha256 ? null : next.definition.operationsPath,
    RUNS_NOTHING.test(prepared.migrationSql) ? null : input.migrationPath,
  ].filter(path => path !== null);
  return CollectionChangeProposal.parse({ kind: "dohc-collection-change", version: 1, datasetId: next.datasetId, name: previous.definition.name,
    datasetPath: input.datasetPath, migrationPath: input.migrationPath, base: { revision: previous.revision, revisionSha256: previous.revisionSha256 },
    revisionSha256: next.revisionSha256, changeSha256: prepared.candidate.changeSha256, files, rows, note: input.note });
}

export interface CollectionChangeStep { definition: DatasetDefinition; author: CollectionChangeAuthor | null; atMs: number | null }

/**
 * Name who made each row. `steps` are the definition file's saved versions,
 * oldest first, starting at the approved one. A row takes the author of the
 * last version that changed it. Code, schema and migration rows take their
 * file's last author.
 */
export function attributeCollectionChangeRows(rows: readonly Draft[], input: {
  definitionPath: string; steps: readonly CollectionChangeStep[];
  files: Readonly<Record<string, { author: CollectionChangeAuthor | null; atMs: number | null }>>;
  operationsPath: string;
}): CollectionChangeRow[] {
  const made = new Map<string, CollectionChangeSource>();
  for (let index = 1; index < input.steps.length; index++) {
    const step = input.steps[index]!;
    for (const changed of collectionDefinitionRows(input.steps[index - 1]!.definition, step.definition)) {
      made.set(changed.key, { path: input.definitionPath, author: step.author, atMs: step.atMs });
    }
  }
  const file = (path: string): CollectionChangeSource => ({ path, author: input.files[path]?.author ?? null, atMs: input.files[path]?.atMs ?? null });
  const migration = rows.find(row => row.kind === "migration");
  // The migration deletes records and values, so those rows come from its file.
  const migrated = migration?.kind === "migration" ? migration.file : input.definitionPath;
  return rows.map(row => {
    if (row.kind === "code-changed") return { ...row, source: file(input.operationsPath) };
    if (row.kind === "schema-changed" || row.kind === "migration") return { ...row, source: file(row.file) };
    if (row.kind === "records-deleted" || row.key.endsWith(":values")) return { ...row, source: file(migrated) };
    return { ...row, source: made.get(row.key) ?? file(input.definitionPath) };
  });
}

/** Whether two lists apply the same change, whoever made each part. */
export function sameCollectionChange(a: readonly CollectionChangeRow[], b: readonly CollectionChangeRow[]): boolean {
  const plain = (rows: readonly CollectionChangeRow[]) => json(rows.map(({ source: _source, ...row }) => row));
  return plain(a) === plain(b);
}

/** What applying the change deletes from existing records. */
export function collectionChangeDeletes(rows: readonly CollectionChangeRow[]): { records: number; values: number } {
  let records = 0, values = 0;
  for (const row of rows) {
    if (row.kind === "table-removed" || row.kind === "records-deleted") records += row.records ?? 0;
    if (row.kind === "field-removed") values += row.values ?? 0;
    if (row.kind === "field-type" || row.kind === "field-changed") values += row.lost ?? 0;
  }
  return { records, values };
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export function collectionApplyLabel(deletes: { records: number; values: number }): string {
  const parts = [deletes.records ? plural(deletes.records, "record") : "", deletes.values ? plural(deletes.values, "value") : ""].filter(Boolean);
  return parts.length ? `Apply and delete ${parts.join(" and ")}` : "Apply";
}

/** History can reverse renames and buttons, which change no stored values. */
export function historyCanUndoCollectionChange(rows: readonly CollectionChangeRow[]): boolean {
  return rows.length > 0 && rows.every(row => row.kind === "collection-renamed" || row.kind === "table-renamed" || row.kind === "field-renamed"
    || (row.kind === "field-added" && row.type === "button") || (row.kind === "field-removed" && row.button));
}

const TYPE_NAMES: Record<DatasetFieldType, string> = { text: "text", number: "number", checkbox: "checkbox", date: "date", select: "select",
  "multi-select": "multi-select", url: "URL", relation: "relation", attachment: "attachment", button: "button" };
export type CollectionChangeIcon = "add" | "rename" | "remove" | "code" | "rule" | "data";
export interface CollectionChangeWords {
  icon: CollectionChangeIcon;
  text: string;
  /** Muted, after the text, such as "(date)". */
  type?: string;
  effect?: string;
  /** The effect deletes something. */
  danger?: boolean;
  /** The effect is a file name. */
  file?: boolean;
}
const basename = (path: string) => path.slice(path.lastIndexOf("/") + 1);

/** The words for one row, while it waits (`present`) or after it was applied (`past`). */
export function describeCollectionChangeRow(row: CollectionChangeRow, tense: "present" | "past"): CollectionChangeWords {
  const now = tense === "present";
  const verb = (present: string, past: string) => now ? present : past;
  const loss = (n: number | null, all: boolean): Partial<CollectionChangeWords> => !n ? {}
    : { effect: all ? verb(`Deletes its ${plural(n, "value")}`, `Deleted ${plural(n, "value")}`) : verb(`Deletes ${n} of its values`, `Deleted ${n} of its values`), danger: true };
  switch (row.kind) {
    case "collection-renamed": case "table-renamed":
      return { icon: "rename", text: `${verb("Renames", "Renamed")} ${row.kind === "table-renamed" ? "the table " : ""}${row.from} to ${row.to}` };
    case "field-renamed":
      return { icon: "rename", text: `${verb("Renames", "Renamed")} ${row.from} to ${row.to}`, ...(row.button ? {} : { effect: verb("Values stay the same", "Values stayed the same") }) };
    case "table-added": return { icon: "add", text: `${verb("Adds", "Added")} the table ${row.table}` };
    case "table-removed": return { icon: "remove", text: `${verb("Removes", "Removed")} the table ${row.table}`,
      ...(row.records === null ? {} : row.records === 0 ? { effect: verb("It has no records", "It had no records") }
        : { effect: verb(`Deletes its ${plural(row.records, "record")}`, `Deleted ${plural(row.records, "record")}`), danger: true }) };
    case "field-added": {
      if (row.type === "button") return { icon: "add", text: `${verb("Adds", "Added")} the button ${row.field}` };
      const effect = row.records === null || row.empty === null || row.records === 0 ? undefined
        : row.empty > 0 ? `${plural(row.empty, "record")} ${verb(row.empty === 1 ? "starts" : "start", "started")} with an empty ${row.field}`
        : `${row.records === 1 ? "1 record" : `All ${row.records} records`} ${verb(row.records === 1 ? "starts" : "start", "started")} with the default`;
      return { icon: "add", text: `${verb("Adds", "Added")} the field ${row.field}`, type: `(${TYPE_NAMES[row.type]})`, ...(effect ? { effect } : {}) };
    }
    case "field-removed":
      if (row.button) return { icon: "remove", text: `${verb("Removes", "Removed")} the button ${row.field}` };
      return { icon: "remove", text: `${verb("Removes", "Removed")} the field ${row.field}`,
        ...(row.values === 0 ? { effect: verb("It has no values", "It had no values") } : loss(row.values, true)) };
    case "field-type": return { icon: "rule", text: `${verb("Changes", "Changed")} ${row.field} from ${TYPE_NAMES[row.from]} to ${TYPE_NAMES[row.to]}`, ...loss(row.lost, false) };
    case "field-changed": return { icon: "rule", text: `${verb("Changes", "Changed")} the field ${row.field}`, ...loss(row.lost, false) };
    case "field-required": return { icon: "rule", text: `${verb("Makes", "Made")} ${row.field} ${row.required ? "required" : "optional"}` };
    case "field-unique":
      if (!row.unique) return { icon: "rule", text: `${verb("Lets", "Let")} ${row.field} values repeat` };
      return { icon: "rule", text: `${verb("Makes", "Made")} ${row.field} unique`,
        ...(row.values !== null && row.values > 1 ? { effect: `All ${row.values} ${row.field} values ${verb("are", "were")} already different` } : {}) };
    case "field-choices": return { icon: "rule", text: `${verb("Changes", "Changed")} the choices for ${row.field}` };
    case "field-default": return { icon: "rule", text: `${verb("Changes", "Changed")} the default for ${row.field}` };
    case "records-deleted": return { icon: "remove", text: `${verb("Removes", "Removed")} records from ${row.table}`,
      effect: verb(`Deletes ${plural(row.records, "record")}`, `Deleted ${plural(row.records, "record")}`), danger: true };
    case "action-added": return { icon: "code", text: `${verb("Adds", "Added")} the ${row.action} action` };
    case "action-removed": return { icon: "code", text: `${verb("Removes", "Removed")} the ${row.action} action` };
    case "action-changed": return { icon: "code", text: `${verb("Changes", "Changed")} the ${row.action} action` };
    case "code-changed": return { icon: "code", text: verb("Changes the code for the actions", "Changed the code for the actions") };
    case "schema-changed": return { icon: "data", text: verb("Changes the schema", "Changed the schema"), effect: basename(row.file), file: true };
    case "migration": return { icon: "data", file: true, effect: basename(row.file),
      text: row.records ? `${verb("Runs", "Ran")} a migration on the ${row.records === 1 ? "1 existing record" : `${row.records} existing records`}` : verb("Runs a migration", "Ran a migration") };
  }
}

/** The agent's note sits under the first row that changes code. */
export function collectionChangeNoteRow(rows: readonly CollectionChangeRow[]): number {
  return rows.findIndex(row => row.kind.startsWith("action-") || row.kind === "code-changed");
}
