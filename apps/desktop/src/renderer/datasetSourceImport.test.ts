import { describe, expect, it } from "vitest";
import { collectionRecordsToCsv, databasePageToCsv, readDatabaseTableToCsv } from "./datasetSourceImport";
import { previewDatasetCsv } from "./datasetCsv";
import type { CollectionSchema } from "@dohc/workspace-contracts/collection";

const schema: CollectionSchema = { name: "People", description: null, fields: [
  { name: "Name", type: "text" }, { name: "Amount", type: "number" },
], views: [] };
const operation = { operationId: "op", name: "create", label: "Create", tableId: "table", kind: "create" as const, access: "owner" as const, readOnly: false, fieldIds: ["name", "amount"] };
const fields = [{ fieldId: "name", name: "Name", type: "text" as const, required: true, unique: false }, { fieldId: "amount", name: "Amount", type: "number" as const, required: false, unique: false }];

describe("dataset source imports", () => {
  it("keeps typed document values and refuses conflicts", () => {
    const table = collectionRecordsToCsv(schema, [
      { id: "1", path: "People/1.md", conflicted: false, values: [{ field: "Name", value: "Ada", validation: { status: "valid" }, resolvedRelations: [] }, { field: "Amount", value: 3, validation: { status: "valid" }, resolvedRelations: [] }] },
      { id: "2", path: "People/2.md", conflicted: true, values: [{ field: "Name", value: "Bob", validation: { status: "valid" }, resolvedRelations: [] }] },
    ]);
    const preview = previewDatasetCsv(table, fields, operation, ["name", "amount"]);
    expect(preview.rows[0]?.values).toEqual({ name: "Ada", amount: 3 });
    expect(preview.rows[1]?.errors).toContain("This document has a conflict. Resolve it before importing.");
  });

  it("flags the display projection for binary SQLite cells", () => {
    const table = databasePageToCsv({ name: "items", columns: [{ name: "payload" }], rows: [{ payload: "<blob 4 bytes>" }], nextOffset: null });
    expect(table.cellErrors?.[0]?.[0]).toContain("lossless export");
  });

  it("reads SQLite pages without accepting a repeated offset", async () => {
    const first = { name: "items", columns: [{ name: "id" }], rows: [{ id: 1 }], nextOffset: 1 };
    await expect(readDatabaseTableToCsv(first, async () => ({ ...first, nextOffset: 1 }), new AbortController().signal)).rejects.toThrow("repeated page");
  });
});
