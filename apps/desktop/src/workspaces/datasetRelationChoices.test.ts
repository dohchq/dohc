import { DatabaseSync } from "node:sqlite";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import { describeDatasetRevision } from "@dohc/security-contract/dataset-artifacts";
import type { DatasetDefinition } from "@dohc/security-contract/dataset";
import { generateDatasetSources } from "./datasetGenerator";
import { generateDatasetRelationChoices } from "./datasetRelationChoices";

const id = (value: number) => `00000000-0000-4000-8000-${String(value).padStart(12,"0")}`;
const definition: DatasetDefinition = { formatVersion: 1, datasetId: id(1), name: "Orders", schemaPath: "data/schema.sql", operationsPath: "data/actions.js", tables: [
  { tableId: id(2), name: "Products", sqlName: "products", primaryKey: "id", fields: [
    { fieldId: id(3), name: "Code", sqlColumn: "id", type: "text", required: true, unique: true },
    { fieldId: id(4), name: "Label", sqlColumn: "label", type: "text", required: false, unique: false },
    { fieldId: id(5), name: "Private", sqlColumn: "private", type: "text", required: false, unique: false },
  ] },
  { tableId: id(6), name: "Orders", sqlName: "orders", primaryKey: "id", fields: [
    { fieldId: id(7), name: "ID", sqlColumn: "id", type: "text", required: true, unique: true },
    { fieldId: id(8), name: "Product", sqlColumn: "product", type: "relation", required: false, unique: false,
      relation: { datasetId: id(1), tableId: id(2), fieldId: id(3), many: false } },
  ] },
], operations: [{ operationId: id(9), name: "orders.create", label: "Create order", tableId: id(6), kind: "create", access: "link", readOnly: false, fieldIds: [id(8)] }] };
const generated = generateDatasetSources(definition), schemaSql = generated.files[definition.schemaPath]!;
const operationSource = generated.files[definition.operationsPath]! + "\n// Preserve this authored trailing comment";
const revision = describeDatasetRevision({ definition, revision: 1, schemaSql, operationSource });
const generate = () => generateDatasetRelationChoices({ revision, schemaSql, operationSource, tableId: id(6), fieldId: id(8), labelFieldId: id(4) });

describe("public relation choice source", () => {
  it("preserves authored source and existing operations, adds only reviewed public key/label read", () => {
    const next = generate();
    expect(next.operationSource.startsWith(operationSource + "\n;")).toBe(true);
    expect(next.definition.operations[0]).toEqual(definition.operations[0]);
    expect(next.definition.operations[1]).toMatchObject({ access: "link", readOnly: true, kind: "read", tableId: id(2), fieldIds: [id(3), id(4)] });
    expect(next.schemaSql).toBe(schemaSql); expect(next.migrationSql).toBe("SELECT 1;");
    expect(next.definition.operationsPath).not.toBe(definition.operationsPath);
    expect(next.files[next.descriptorPath]).toBe(JSON.stringify(next.definition, null, 2) + "\n");
  });

  it("queries only explicit key/label, pages deterministically, and searches with bound parameters", () => {
    const next = generate(), db = new DatabaseSync(":memory:"); db.exec(schemaSql);
    try {
      db.prepare("INSERT INTO products(id,label,private) VALUES(?,?,?)").run("a", "Alpha", "SECRET");
      db.prepare("INSERT INTO products(id,label,private) VALUES(?,?,?)").run("b", null, "HIDDEN");
      const sandbox = { operations: {} as Record<string, (ctx: unknown, input: unknown) => unknown> };
      runInNewContext(next.operationSource, sandbox);
      const query = sandbox.operations[next.definition.operations.at(-1)!.name]!;
      const ctx = { db: { query: (sql: string, parameters: (string | number)[]) => db.prepare(sql).all(...parameters) }, refuse: (code: string) => { throw Error(code); } };
      const first = query(ctx, { limit: 1 });
      expect(first).toEqual({ rows: [{ id: "a", values: { [id(3)]: "a", [id(4)]: "Alpha" } }], nextCursor: { id: "a", value: "a" } });
      expect(query(ctx, { limit: 1, after: { id: "a", value: "a" } })).toEqual({ rows: [{ id: "b", values: { [id(3)]: "b", [id(4)]: "b" } }], nextCursor: null });
      expect(query(ctx, { search: "SECRET" })).toEqual({ rows: [], nextCursor: null });
      expect(query(ctx, { search: "' OR 1=1 --" })).toEqual({ rows: [], nextCursor: null });
      for (const input of [{ limit: 101 }, { limit: 0 }, { search: "x".repeat(201) }, { after: { id: "a", value: "b" } }, { filters: [] }, null]) {
        expect(() => query(ctx, input)).toThrow("invalid_input");
      }
    } finally { db.close(); }
  });
});
