import { describe, expect, it } from "vitest";
import { describeDatasetRevision, verifyDatasetArtifacts } from "./datasetArtifacts";
import type { DatasetDefinition } from "./dataset";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
function fixture() {
  const definition: DatasetDefinition = {
    formatVersion: 1, datasetId: id(1), name: "Inventory", schemaPath: "inventory/schema.sql", operationsPath: "inventory/operations.js",
    tables: [{ tableId: id(2), name: "Items", sqlName: "items", primaryKey: "id", fields: [
      { fieldId: id(3), name: "ID", sqlColumn: "id", type: "text", required: true, unique: true },
    ] }],
    operations: [{ operationId: id(4), name: "list", label: "List", tableId: id(2), kind: "read", access: "owner", readOnly: true, fieldIds: [id(3)] }],
  };
  const schemaSql = "CREATE TABLE items(id TEXT PRIMARY KEY NOT NULL);";
  const operationSource = "globalThis.operations={list(ctx){return ctx.db.query('SELECT id FROM items');}}";
  return { definition, schemaSql, operationSource, revision: 1 };
}

describe("dataset revision artifact identity", () => {
  it("binds source and schema bytes even when their workspace paths stay the same", () => {
    const input = fixture(), revision = describeDatasetRevision(input);
    expect(verifyDatasetArtifacts({ ...input, revision })).toEqual(revision);
    expect(() => verifyDatasetArtifacts({ ...input, revision, operationSource: input.operationSource + "\n// changed" })).toThrow(/do not match/);
    expect(() => verifyDatasetArtifacts({ ...input, revision, schemaSql: input.schemaSql + "\nCREATE INDEX item_id ON items(id);" })).toThrow(/do not match/);
  });

  it("binds policy metadata and revision independently of artifact bytes", () => {
    const input = fixture(), revision = describeDatasetRevision(input);
    revision.definition.operations[0].access = "link";
    expect(() => verifyDatasetArtifacts({ ...input, revision })).toThrow(/do not match/);
    const original = describeDatasetRevision(fixture());
    expect(() => verifyDatasetArtifacts({ ...input, revision: { ...original, revision: 2 } })).toThrow(/do not match/);
  });

  it("returns detached metadata and does not mistake a digest for approval", () => {
    const input = fixture(), revision = describeDatasetRevision(input);
    input.definition.operations[0].access = "link";
    expect(revision.definition.operations[0].access).toBe("owner");
    expect(revision).not.toHaveProperty("approved");
    expect(() => describeDatasetRevision({ ...fixture(), operationSource: "x".repeat(256 * 1024 + 1) })).toThrow(/artifact/);
  });
});
