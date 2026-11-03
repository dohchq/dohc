import { expect, it } from "vitest";
import type { DatasetDefinition, DatasetRevision } from "@dohc/security-contract/dataset";
import { describeDatasetRevision } from "@dohc/security-contract/dataset-artifacts";
import type { DatasetMigrationCandidate } from "@dohc/cli/dataset";
import { generateDatasetSources } from "./datasetGenerator";
import { generateDatasetSchemaChange } from "./datasetSchemaChanges";
import {
  attributeCollectionChangeRows, collectionApplyLabel, collectionChangeDeletes, collectionChangeRows, CollectionChangeRow,
  describeCollectionChangeRow, historyCanUndoCollectionChange, sameCollectionChange, type CollectionChangeAuthor,
} from "./collectionChange";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const sha = (n: number) => String(n).repeat(64).slice(0, 64);
const volunteers: DatasetDefinition = { formatVersion: 1, datasetId: id(1), name: "Volunteers", schemaPath: "volunteers/schema.sql", operationsPath: "volunteers/backend.ts",
  tables: [{ tableId: id(2), name: "Volunteers", sqlName: "volunteers", primaryKey: "id", fields: [
    { fieldId: id(3), name: "ID", sqlColumn: "id", type: "text", required: true, unique: true },
    { fieldId: id(4), name: "Email", sqlColumn: "email", type: "text", required: true, unique: false },
    { fieldId: id(5), name: "Status", sqlColumn: "status", type: "text", required: false, unique: false },
    { fieldId: id(6), name: "Notes", sqlColumn: "notes", type: "text", required: false, unique: false },
  ] }], operations: [
    { operationId: id(7), name: "list", label: "List", tableId: id(2), kind: "read", access: "owner", readOnly: true, fieldIds: [id(3), id(4), id(5), id(6)] },
    { operationId: id(8), name: "signUp", label: "Sign up", tableId: id(2), kind: "create", access: "link", readOnly: false, fieldIds: [id(4)] },
  ] };
/** Ice made Email unique, then Claude Code added Due date, renamed Status and removed Notes. */
const iceEdit = structuredClone(volunteers);
const email = iceEdit.tables[0]!.fields[1]!;
if (email.type !== "button") email.unique = true;
const asked = structuredClone(iceEdit);
asked.tables[0]!.fields = asked.tables[0]!.fields.filter(field => field.name !== "Notes").map(field => field.name === "Status" ? { ...field, name: "Stage" } : field);
asked.tables[0]!.fields.push({ fieldId: id(9), name: "Due date", sqlColumn: "due", type: "date", required: false, unique: false });
asked.operations = asked.operations.map(operation => operation.name === "list" ? { ...operation, fieldIds: [id(3), id(4), id(5), id(9)] } : { ...operation, fieldIds: [id(4), id(5)] });
const revision = (definition: DatasetDefinition, n: number, code: number): DatasetRevision =>
  ({ datasetId: definition.datasetId, revision: n, revisionSha256: sha(n), definitionSha256: sha(n), schemaSha256: sha(n), operationsSha256: sha(code), definition });
const counts: DatasetMigrationCandidate["preview"]["tables"] = [{ table: "volunteers", beforeRows: 12, afterRows: 12, changedRows: 12, deletedRows: 0,
  beforeValues: { id: 12, email: 12, status: 9, notes: 12 }, afterValues: { id: 12, email: 12, status: 9, due: 0 }, clearedValues: { id: 0, email: 0, status: 0, notes: 12 } }];
const change = { previous: revision(volunteers, 3, 1), next: revision(asked, 4, 2), operationSource: "custom code", migrationSql: "ALTER TABLE volunteers ADD COLUMN due TEXT;",
  migrationPath: "volunteers/migrations/004-due-date.sql", counts };
const words = (rows: readonly CollectionChangeRow[], tense: "present" | "past") => rows.map(row => describeCollectionChangeRow(row, tense));
const ice: CollectionChangeAuthor = { name: "Ice", agent: false }, claude: CollectionChangeAuthor = { name: "Claude Code", agent: true };
const attribute = (rows: ReturnType<typeof collectionChangeRows>) => attributeCollectionChangeRows(rows, { definitionPath: "volunteers/dataset.json", operationsPath: "volunteers/backend.ts",
  steps: [{ definition: volunteers, author: null, atMs: null }, { definition: iceEdit, author: ice, atMs: 1_000 }, { definition: asked, author: claude, atMs: 2_000 }],
  files: { "volunteers/backend.ts": { author: claude, atMs: 1_900 }, "volunteers/migrations/004-due-date.sql": { author: claude, atMs: 2_100 } } });

it("lists every part of the change and what it does to the existing records", () => {
  const rows = attribute(collectionChangeRows(change));
  expect(words(rows, "present")).toEqual([
    { icon: "add", text: "Adds the field Due date", type: "(date)", effect: "12 records start with an empty Due date" },
    { icon: "rename", text: "Renames Status to Stage", effect: "Values stay the same" },
    { icon: "remove", text: "Removes the field Notes", effect: "Deletes its 12 values", danger: true },
    { icon: "code", text: "Changes the Sign up action" },
    { icon: "rule", text: "Makes Email unique", effect: "All 12 Email values are already different" },
    { icon: "data", text: "Runs a migration on the 12 existing records", effect: "004-due-date.sql", file: true },
  ]);
  expect(words(rows, "past").map(row => [row.text, row.effect])).toEqual([
    ["Added the field Due date", "12 records started with an empty Due date"], ["Renamed Status to Stage", "Values stayed the same"],
    ["Removed the field Notes", "Deleted 12 values"], ["Changed the Sign up action", undefined],
    ["Made Email unique", "All 12 Email values were already different"], ["Ran a migration on the 12 existing records", "004-due-date.sql"],
  ]);
  expect(collectionApplyLabel(collectionChangeDeletes(rows))).toBe("Apply and delete 12 values");
  expect(historyCanUndoCollectionChange(rows)).toBe(false);
  expect(rows.map(row => CollectionChangeRow.parse(row))).toEqual(rows);
});

it("shows a collaborator's unapplied edit as its own row with its author", () => {
  const rows = attribute(collectionChangeRows(change));
  const unique = rows.find(row => row.kind === "field-unique")!;
  expect(unique.source).toEqual({ path: "volunteers/dataset.json", author: ice, atMs: 1_000 });
  expect(rows.filter(row => row !== unique).map(row => row.source?.author)).toEqual(rows.slice(0, 5).map(() => claude));
  expect(rows.find(row => row.kind === "migration")!.source).toEqual({ path: "volunteers/migrations/004-due-date.sql", author: claude, atMs: 2_100 });
});

it("names a change without a source file's author as nobody's", () => {
  const rows = attributeCollectionChangeRows(collectionChangeRows(change), { definitionPath: "volunteers/dataset.json", operationsPath: "volunteers/backend.ts",
    steps: [{ definition: volunteers, author: null, atMs: null }], files: {} });
  expect(rows.every(row => row.source?.author === null && row.source.atMs === null)).toBe(true);
});

it("shows a generated field as one row and its migration, with no code or owner action rows", () => {
  const sources = generateDatasetSources({ ...volunteers, operations: volunteers.operations.filter(operation => operation.access === "owner") });
  const schemaSql = sources.files[sources.definition.schemaPath]!, operationSource = sources.files[sources.definition.operationsPath]!;
  const previous = describeDatasetRevision({ definition: sources.definition, revision: 1, schemaSql, operationSource });
  const generated = generateDatasetSchemaChange({ revision: previous, schemaSql, operationSource,
    change: { kind: "addField", tableId: id(2), field: { name: "Due date", type: "date", required: false, unique: false } } });
  const next = describeDatasetRevision({ definition: generated.definition, revision: 2, schemaSql: generated.schemaSql, operationSource: generated.operationSource });
  const rows = collectionChangeRows({ previous, next, operationSource: generated.operationSource, migrationSql: generated.migrationSql, migrationPath: generated.migrationPath });
  expect(rows.map(row => row.kind)).toEqual(["field-added", "migration"]);
  expect(describeCollectionChangeRow({ ...rows[0]!, source: undefined } as CollectionChangeRow, "present")).toEqual({ icon: "add", text: "Adds the field Due date", type: "(date)" });
});

it("offers Undo only for changes History can reverse", () => {
  const renamed = structuredClone(volunteers);
  renamed.name = "Helpers"; renamed.tables[0]!.fields[2]!.name = "Stage";
  renamed.tables[0]!.fields.push({ fieldId: id(10), name: "Approve", type: "button" });
  const rows = collectionChangeRows({ previous: revision(volunteers, 3, 1), next: revision(renamed, 4, 1), operationSource: "custom code", migrationSql: "SELECT 1;", migrationPath: "m.sql" });
  expect(words(rows as CollectionChangeRow[], "present").map(row => row.text)).toEqual(["Adds the button Approve", "Renames Volunteers to Helpers", "Renames Status to Stage"]);
  expect(historyCanUndoCollectionChange(rows as CollectionChangeRow[])).toBe(true);
  expect(collectionApplyLabel(collectionChangeDeletes(rows as CollectionChangeRow[]))).toBe("Apply");
  const migrated = collectionChangeRows({ ...change, next: revision(renamed, 4, 1), operationSource: "custom code" });
  expect(historyCanUndoCollectionChange(migrated as CollectionChangeRow[])).toBe(false);
});

it("counts records and values a migration deletes, even when no field changes", () => {
  const cleared: DatasetMigrationCandidate["preview"]["tables"] = [{ ...counts[0]!, deletedRows: 3, afterRows: 9,
    beforeValues: { id: 12, email: 12, status: 9, notes: 12 }, afterValues: { id: 9, email: 9, status: 0, notes: 9 }, clearedValues: { id: 0, email: 0, status: 6, notes: 0 } }];
  const rows = collectionChangeRows({ previous: revision(volunteers, 3, 1), next: revision(volunteers, 4, 1), operationSource: "custom code",
    migrationSql: "DELETE FROM volunteers WHERE status IS NULL; UPDATE volunteers SET status = NULL;", migrationPath: "volunteers/clear.sql", counts: cleared }) as CollectionChangeRow[];
  expect(words(rows, "present").map(row => [row.text, row.effect, row.danger])).toEqual([
    ["Removes records", "Deletes 3 records", true],
    ["Changes the field Status", "Deletes 6 of its values", true],
    ["Runs a migration on the 12 existing records", "clear.sql", undefined],
  ]);
  expect(collectionApplyLabel(collectionChangeDeletes(rows))).toBe("Apply and delete 3 records and 6 values");
  expect(attributeCollectionChangeRows(rows, { definitionPath: "volunteers/dataset.json", operationsPath: "volunteers/backend.ts", steps: [],
    files: { "volunteers/clear.sql": { author: claude, atMs: 5 } } }).map(row => row.source?.path)).toEqual(Array(3).fill("volunteers/clear.sql"));
});

it("treats the same change from different authors as the same, and new counts as different", () => {
  const rows = attribute(collectionChangeRows(change));
  expect(sameCollectionChange(rows, collectionChangeRows(change) as CollectionChangeRow[])).toBe(true);
  const more = collectionChangeRows({ ...change, counts: [{ ...counts[0]!, beforeValues: { ...counts[0]!.beforeValues, notes: 13 } }] }) as CollectionChangeRow[];
  expect(sameCollectionChange(rows, more)).toBe(false);
});

it("refuses a row with a field it does not know", () => {
  expect(() => CollectionChangeRow.parse({ kind: "code-changed", key: "code", text: "Deletes nothing" })).toThrow();
});

it("counts the records a migration runs on only when there are some", () => {
  const migration = (records: number | null) => ({ kind: "migration", key: "migration", file: "volunteers/m.sql", records }) as CollectionChangeRow;
  expect([0, null, 1, 12].map(records => describeCollectionChangeRow(migration(records), "present").text)).toEqual(
    ["Runs a migration", "Runs a migration", "Runs a migration on 1 existing record", "Runs a migration on the 12 existing records"]);
  expect(describeCollectionChangeRow(migration(1), "past").text).toBe("Ran a migration on 1 existing record");
});
