import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { evaluateAppOperation, initializeAppDatabase, type JsonValue } from "@dohc/app-backend-runtime";
import { datasetColumnFields, type DatasetDefinition, type DatasetField, type DatasetOperation } from "@dohc/security-contract/dataset";
import { generateDatasetSources, hasGeneratedDatasetOperations } from "./datasetGenerator";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const field = (n: number, sqlColumn: string, extra: Partial<DatasetField> = {}): DatasetField => ({ fieldId: id(n), sqlColumn, name: sqlColumn, type: "text", required: false, unique: false, ...extra });
function fixture(): DatasetDefinition {
  const fields = [field(3, "id", { required: true, unique: true }), field(4, "name", { required: true, unique: true }),
    field(5, "status", { type: "select", required: true, options: ["Pending", "Approved"], default: "Pending" }),
    field(6, "tags", { type: "multi-select", options: ["One", "Two"], default: [] }), field(7, "active", { type: "checkbox", default: false }),
    field(8, "date", { type: "date" }), field(9, "url", { type: "url" }), field(10, "receipt", { type: "attachment" }), field(11, "quantity", { type: "number" })];
  const operation = (n: number, name: string, kind: DatasetOperation["kind"], fieldIds: string[], access: DatasetOperation["access"] = "helper"): DatasetOperation =>
    ({ operationId: id(n), tableId: id(2), name, label: name, kind, access, readOnly: kind === "read", fieldIds });
  return { formatVersion: 1, datasetId: id(1), name: "Registrations", schemaPath: "data/registrations/schema.sql", operationsPath: "data/registrations/operations.js",
    tables: [{ tableId: id(2), name: "Registrations", sqlName: "registrations", primaryKey: "id", fields }], operations: [
      operation(20, "submit", "create", fields.filter(field => ![id(3), id(5)].includes(field.fieldId)).map(field => field.fieldId), "link"),
      operation(21, "read", "read", fields.map(field => field.fieldId)),
      operation(22, "edit", "edit", fields.filter(field => field.fieldId !== id(3)).map(field => field.fieldId)),
      operation(23, "delete", "delete", []), operation(24, "public", "read", [id(4)], "link"),
    ] };
}
const owner = { kind: "owner", userId: "owner" };
const link = { kind: "link", principalId: "friend", grantId: "share" };
async function runtime(definition = fixture()) {
  const { files } = generateDatasetSources(definition);
  const tables = definition.tables.map(table => table.sqlName);
  let database = await initializeAppDatabase({ schemaSql: files[definition.schemaPath], tables });
  return {
    async call(operation: string, input: JsonValue, caller: JsonValue = owner, options: Partial<Parameters<typeof evaluateAppOperation>[0]> = {}) {
      const result = await evaluateAppOperation({ source: files[definition.operationsPath], operation, input, caller, database, tables,
        requestId: randomUUID(), nowMs: Date.now(), readOnly: definition.operations.find(item => item.name === operation)?.readOnly, ...options });
      database = result.database;
      return result;
    },
  };
}

// Each test drives a real app runtime through dozens of worker calls; a loaded
// gate host stretched one past 30 s while it passes alone in a few seconds.
describe("initial dataset source", { timeout: 60_000 }, () => {
  it("keeps field identity through display renames and requires authored actions", () => {
    const definition = fixture(), first = generateDatasetSources(definition);
    expect(first.definition.operations.find(operation => operation.kind === "edit")!.reversible).toBe(true);
    definition.tables[0].fields[1].name = 'Name "; DROP TABLE registrations; --';
    expect(generateDatasetSources(definition).files[definition.schemaPath]).toEqual(first.files[definition.schemaPath]);
    expect(Object.keys(first.files)).toEqual(["data/registrations/dataset.json", definition.schemaPath, definition.operationsPath]);
    definition.operations[0].kind = "action";
    expect(() => generateDatasetSources(definition)).toThrow("Custom actions need authored");
  });

  it("writes buttons only to dataset.json, so a button leaves the schema and generated actions unchanged", () => {
    const plain = fixture(), buttons = fixture(), button = { fieldId: id(30), name: "Send receipt", type: "button" as const };
    buttons.tables[0].fields.push(button);
    const before = generateDatasetSources(plain), after = generateDatasetSources(buttons);
    expect(after.files[buttons.schemaPath]).toBe(before.files[plain.schemaPath]);
    expect(after.files[buttons.operationsPath]).toBe(before.files[plain.operationsPath]);
    expect(JSON.parse(after.files["data/registrations/dataset.json"]!).tables[0].fields.at(-1)).toEqual(button);
    expect(hasGeneratedDatasetOperations(before.files[plain.operationsPath]!, after.definition)).toBe(true);
    expect(hasGeneratedDatasetOperations(before.files[plain.operationsPath]! + "\n// edited", after.definition)).toBe(false);
  });

  it("refuses a create operation that cannot fill a private required field", () => {
    const definition = fixture(); delete datasetColumnFields(definition.tables[0])[2]!.default;
    expect(() => generateDatasetSources(definition)).toThrow("cannot fill a required field");
  });

  it("submits public fields, keeps private defaults, enforces uniqueness, and edits with a stale-write check and undo", async () => {
    const app = await runtime();
    const created = (await app.call("submit", { values: { [id(4)]: "Alice", [id(6)]: ["Two"] } }, link)).result as { id: string; version: number };
    expect(created.version).toBe(1);
    await expect(app.call("submit", { values: { [id(4)]: "Alice" } }, link)).rejects.toThrow("already uses this value");
    await expect(app.call("submit", { values: { [id(4)]: "Bob", [id(5)]: "Approved" } }, link)).rejects.toThrow("Check the fields");
    expect((await app.call("read", {})).result).toMatchObject({ rows: [{ values: { [id(5)]: "Pending", [id(6)]: ["Two"], [id(7)]: false } }] });
    expect((await app.call("public", {}, link)).result).toEqual({ rows: [{ ...created, values: { [id(4)]: "Alice" } }], nextCursor: null });
    const edited = (await app.call("edit", { id: created.id, expectedVersion: 1, values: { [id(5)]: "Approved" } })).result as { version: number; priorValues: JsonValue };
    expect(edited).toMatchObject({ version: 2, priorValues: { [id(5)]: "Pending" } });
    await expect(app.call("edit", { id: created.id, expectedVersion: 1, values: { [id(5)]: "Pending" } })).rejects.toThrow("This record changed");
    await app.call("edit", { id: created.id, expectedVersion: 2, values: edited.priorValues });
    expect((await app.call("read", {})).result).toMatchObject({ rows: [{ version: 3, values: { [id(5)]: "Pending" } }] });
    await expect(app.call("delete", { id: created.id, expectedVersion: 2 })).rejects.toThrow("This record changed");
    await app.call("delete", { id: created.id, expectedVersion: 3 });
    expect((await app.call("read", {})).result).toMatchObject({ rows: [] });
  });

  it("lets an automation use generated operations under its own caller", async () => {
    const definition = fixture();
    definition.operations.find(operation => operation.name === "read")!.access = "owner";
    const app = await runtime(definition);
    const automation = { kind: "automation", automationId: "collection:registrations#approve" };
    const created = (await app.call("submit", { values: { [id(4)]: "Alice" } }, automation)).result as { id: string };
    await app.call("edit", { id: created.id, expectedVersion: 1, values: { [id(5)]: "Approved" } }, automation);
    expect((await app.call("read", {}, automation)).result).toMatchObject({ rows: [{ version: 2, values: { [id(5)]: "Approved" } }] });
    await expect(app.call("read", {}, { ...link, approvedRead: id(21) })).rejects.toThrow("do not have access");
  });

  it("derives access from the host caller and never filters or sorts hidden fields", async () => {
    const app = await runtime();
    await app.call("submit", { values: { [id(4)]: "Alice" } }, link);
    await expect(app.call("read", {}, link)).rejects.toThrow("do not have access");
    expect((await app.call("read", {}, { ...link, approvedRead: id(21) })).result).toMatchObject({ rows: [expect.objectContaining({ values: expect.objectContaining({ [id(4)]: "Alice" }) })] });
    await expect(app.call("read", {}, { kind: "named", userId: "reader", grantId: "g", access: "edit", helper: false })).rejects.toThrow("do not have access");
    expect((await app.call("read", {}, { kind: "named", userId: "helper", grantId: "g", access: "view", helper: true })).result).toMatchObject({ rows: [{ values: { [id(4)]: "Alice" } }] });
    await expect(app.call("public", { filters: [{ fieldId: id(5), value: "Pending" }] }, link)).rejects.toThrow("Check the fields");
    await expect(app.call("public", { sort: { fieldId: id(5), direction: "asc" } }, link)).rejects.toThrow("Check the fields");
    expect((await app.call("public", { search: "Pending" }, link)).result).toMatchObject({ rows: [] });
  });

  it("paginates equal and null values without duplicate rows in either direction", async () => {
    const app = await runtime();
    for (const [name, quantity] of [["First", null], ["Second", null], ["Third", 2], ["Fourth", 2], ["Fifth", 8]] as const) await app.call("submit", { values: { [id(4)]: name, [id(11)]: quantity } });
    for (const direction of ["asc", "desc"]) {
      let after: JsonValue = null;
      const collected: string[] = [];
      do {
        const page = (await app.call("read", { limit: 2, sort: { fieldId: id(11), direction }, after })).result as { rows: { id: string }[]; nextCursor: JsonValue };
        collected.push(...page.rows.map(row => row.id)); after = page.nextCursor;
      } while (after);
      expect(collected).toHaveLength(5); expect(new Set(collected).size).toBe(5);
    }
    expect((await app.call("read", { filters: [{ fieldId: id(11), value: 2 }], search: "Third" })).result).toMatchObject({ rows: [{ values: { [id(4)]: "Third" } }] });
  });

  it("validates typed inputs and checks attachment capabilities before committing", async () => {
    const app = await runtime();
    for (const values of [{ [id(8)]: "2026-02-30" }, { [id(7)]: "true" }, { [id(6)]: ["One", "One"] }, { [id(9)]: "javascript:alert(1)" }, { [id(11)]: "10" }]) {
      await expect(app.call("submit", { values: { [id(4)]: "Invalid", ...values } })).rejects.toThrow("Check the fields");
    }
    await expect(app.call("submit", { values: { [id(4)]: "Unknown", [id(10)]: "missing" } })).rejects.toThrow();
    const result = await app.call("submit", { values: { [id(4)]: "Receipt", [id(10)]: "file-1", [id(8)]: "2026-09-22" } }, link,
      { files: [{ fileId: "file-1", name: "receipt.png", contentType: "image/png", byteLength: 12, sha256: "a".repeat(64) }] });
    expect(result.attachedFileIds).toEqual(["file-1"]);
    expect((await app.call("read", {})).result).toMatchObject({ rows: [{ values: { [id(10)]: "file-1" } }] });
  });

  it("queries full board groups and date ranges independently of the table's first page", async () => {
    const app = await runtime();
    for (let n=0;n<55;n++) await app.call("submit",{values:{[id(4)]:`Person ${n}`,[id(8)]:n<52?"2026-09-01":"2026-10-01",[id(11)]:n%10}});
    const group = {fieldId:id(8),value:"2026-10-01"};
    const grouped = (await app.call("read",{limit:2,group})).result as {rows:unknown[];nextCursor:JsonValue;group:unknown};
    expect(grouped.rows).toHaveLength(2);expect(grouped.group).toEqual(group);
    expect((await app.call("read",{limit:2,group,after:grouped.nextCursor})).result).toMatchObject({rows:[{values:{[id(8)]:"2026-10-01"}}],nextCursor:null});
    const range = {fieldId:id(8),start:"2026-10-01",end:"2026-11-01"};
    expect((await app.call("read",{range})).result).toMatchObject({range,rows:Array.from({length:3},()=>({values:{[id(8)]:"2026-10-01"}})),nextCursor:null});
    const groups = (await app.call("read",{groupBy:id(11),limit:8})).result as {groups:JsonValue[];nextGroupCursor:JsonValue};
    expect(groups.groups).toEqual([0,1,2,3,4,5,6,7]);
    expect((await app.call("read",{groupBy:id(11),limit:8,groupAfter:groups.nextGroupCursor})).result).toEqual({groupBy:id(11),groups:[8,9],nextGroupCursor:null});
    for(const input of [{groupBy:id(5),limit:8},{group:{fieldId:id(5),value:"Pending"}},{range}] as JsonValue[]) await expect(app.call("public",input,link)).rejects.toThrow("Check the fields");
    await expect(app.call("read",{range:{...range,start:"2026-02-30"}})).rejects.toThrow("Check the fields");
  });

  it("enforces single and many same-dataset relations, including deletion and raw target updates", async () => {
    const definition = fixture();
    definition.tables.push({ tableId: id(30), name: "Teams", sqlName: "teams", primaryKey: "id", fields: [field(31, "id", { required: true, unique: true })] });
    for (const [n, many] of [[32, false], [33, true]] as const) {
      definition.tables[0].fields.push(field(n, many ? "teams" : "team", { type: "relation", relation: { datasetId: id(1), tableId: id(30), fieldId: id(31), many } }));
      definition.operations[0].fieldIds.push(id(n)); definition.operations[2].fieldIds.push(id(n));
    }
    definition.operations.push({ operationId: id(34), name: "createTeam", label: "Create team", tableId: id(30), kind: "create", readOnly: false, access: "owner", fieldIds: [id(31)] },
      { operationId: id(35), name: "deleteTeam", label: "Delete team", tableId: id(30), kind: "delete", readOnly: false, access: "owner", fieldIds: [] });
    const app = await runtime(definition);
    await app.call("createTeam", { values: { [id(31)]: "team-a" } });
    const registration = (await app.call("submit", { values: { [id(4)]: "Alice", [id(32)]: "team-a", [id(33)]: ["team-a"] } })).result as { id: string };
    await expect(app.call("submit", { values: { [id(4)]: "Bob", [id(33)]: ["missing"] } })).rejects.toThrow();
    await expect(app.call("deleteTeam", { id: "team-a", expectedVersion: 1 })).rejects.toThrow("Check the linked records");
    await expect(app.call("mutate", {}, owner, { readOnly: false, source: 'globalThis.operations={mutate:ctx=>ctx.db.execute("UPDATE teams SET id=? WHERE id=?",["moved","team-a"])}' })).rejects.toThrow();
    await app.call("edit", { id: registration.id, expectedVersion: 1, values: { [id(32)]: null, [id(33)]: [] } });
    await app.call("deleteTeam", { id: "team-a", expectedVersion: 1 });
  });

  it("accepts declared integer record keys without making them editable", async () => {
    const definition = fixture(); definition.tables[0].fields[0].type = "number"; definition.operations[0].fieldIds.push(id(3));
    const app = await runtime(definition);
    await expect(app.call("submit", { values: { [id(3)]: 1.5, [id(4)]: "Fraction" } })).rejects.toThrow("Check the fields");
    expect((await app.call("submit", { values: { [id(3)]: 42, [id(4)]: "Integer" } })).result).toEqual({ id: 42, version: 1 });
    await expect(app.call("edit", { id: 42, expectedVersion: 1, values: { [id(3)]: 43 } })).rejects.toThrow("Check the fields");
  });

  it("supports the full field bound when searching and editing", async () => {
    const definition = fixture();
    const fields = [definition.tables[0].fields[0], ...Array.from({ length: 127 }, (_, i) => field(100 + i, `field_${i}`))];
    definition.tables[0].fields = fields;
    for (const operation of definition.operations) operation.fieldIds = operation.kind === "delete" ? [] : fields.filter(field => field.type !== "button" && field.sqlColumn !== "id").map(field => field.fieldId);
    const app = await runtime(definition);
    const values = Object.fromEntries(fields.slice(1).map(field => [field.fieldId, "match"]));
    const row = (await app.call("submit", { values })).result as { id: string };
    await app.call("edit", { id: row.id, expectedVersion: 1, values });
    expect((await app.call("read", { search: "match", filters: [{ fieldId: fields[1].fieldId, value: "match" }] })).result).toMatchObject({ rows: [{ id: row.id, version: 2 }] });
  });
});

it("marks only keys supplied by every generated create operation", () => {
  const value = fixture();
  const generated = generateDatasetSources(value);
  expect(datasetColumnFields(generated.definition.tables[0]!)[0]!.generated).toBe("record-id");
  expect(datasetColumnFields(value.tables[0]!)[0]!.generated).toBeUndefined();
  const supplied = structuredClone(value);
  supplied.operations[0]!.fieldIds.push(id(3));
  expect(datasetColumnFields(generateDatasetSources(supplied).definition.tables[0]!)[0]!.generated).toBeUndefined();
  const mixed = structuredClone(value);
  mixed.operations.push({ ...supplied.operations[0]!, operationId: id(40), name: "import" });
  expect(datasetColumnFields(generateDatasetSources(mixed).definition.tables[0]!)[0]!.generated).toBeUndefined();
  const readOnly = { ...value, operations: value.operations.filter(operation => operation.kind === "read") };
  expect(datasetColumnFields(generateDatasetSources(readOnly).definition.tables[0]!)[0]!.generated).toBeUndefined();
});
