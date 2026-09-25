import { describe, expect, it, vi } from "vitest";
import { collectionRecordsToCsv, databasePageToCsv, readDatabaseTableToCsv, readDocumentCollectionToCsv, type SourceImportReader } from "./datasetSourceImport";
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

  it("keeps source null and empty text distinct from defaults", () => {
    const table = databasePageToCsv({ name: "people", columns: [{ name: "Name" }, { name: "Amount" }], rows: [{ Name: "", Amount: null }], nextOffset: null });
    const preview = previewDatasetCsv(table, [{ ...fields[0]!, default: "Unknown" }, { ...fields[1]!, default: 5 }], operation, ["name", "amount"]);
    expect(preview.rows[0]).toMatchObject({ values: { name: "", amount: null }, errors: [] });
    const wrongType = databasePageToCsv({ name: "people", columns: [{ name: "Name" }, { name: "Amount" }], rows: [{ Name: "Ada", Amount: "" }], nextOffset: null });
    expect(previewDatasetCsv(wrongType, [fields[0]!, { ...fields[1]!, default: 5 }], operation, ["name", "amount"]).rows[0]?.errors).toContain("Empty source text is not a number value for Amount.");
  });

  it("refuses a bad source field only when it is mapped", () => {
    const table = databasePageToCsv({ name: "people", columns: [{ name: "Name" }, { name: "Amount" }], rows: [{ Name: "Ada", Amount: 9007199254740993n }], nextOffset: null });
    expect(previewDatasetCsv(table, fields, operation, ["name", "amount"]).rows[0]?.errors).toHaveLength(1);
    expect(previewDatasetCsv(table, fields, operation, ["name", null]).rows[0]?.errors).toEqual([]);
  });

  it("refuses document relations and flagged properties without silently changing their meaning", () => {
    const table = collectionRecordsToCsv({ ...schema, fields: [...schema.fields, { name: "Friend", type: "relation", collection: "People", many: false }] }, [
      { id: "1", path: "1.md", conflicted: false, values: [
        { field: "Name", value: "Ada", validation: { status: "valid" }, resolvedRelations: [] },
        { field: "Amount", value: "bad", validation: { status: "flagged", reason: { code: "expected-number", path: "Amount" } }, resolvedRelations: [] },
        { field: "Friend", value: "document-id", validation: { status: "valid" }, resolvedRelations: [] },
      ] },
    ]);
    expect(table.cellErrors?.[0]?.[1]).toContain("Correct Amount");
    expect(table.cellErrors?.[0]?.[2]).toContain("new target record keys");
    expect(previewDatasetCsv(table, fields, operation, ["name", null, null]).rows[0]?.values).toEqual({ name: "Ada" });
  });

  it("leaves button fields and their stray values out of a document import", () => {
    const table = collectionRecordsToCsv({ ...schema, fields: [...schema.fields, { name: "Mark paid", type: "button" }] }, [
      { id: "1", path: "1.md", conflicted: false, values: [
        { field: "Name", value: "Ada", validation: { status: "valid" }, resolvedRelations: [] },
        { field: "Mark paid", value: true, validation: { status: "flagged", reason: { code: "expected-empty", path: "" } }, resolvedRelations: [] },
      ] },
    ]);
    expect(table.headers).toEqual(["Name", "Amount"]);
    expect(table.rows).toEqual([["Ada", ""]]);
    expect(table.cellErrors?.[0]).toEqual(["", ""]);
  });

  it("rejects wide, large, and truncated sources before producing an import plan", () => {
    const base = { name: "people", columns: [{ name: "Name" }], rows: [{ Name: "x".repeat(4097) }], nextOffset: null };
    expect(databasePageToCsv(base).cellErrors?.[0]?.[0]).toContain("lossless export");
    expect(() => databasePageToCsv({ ...base, columns: Array.from({ length: 129 }, (_, index) => ({ name: String(index) })) })).toThrow("128 fields");
    expect(() => databasePageToCsv({ ...base, rows: Array.from({ length: 10001 }, () => ({ Name: "Ada" })) })).toThrow("10,000 rows");
    expect(() => databasePageToCsv({ ...base, rows: Array.from({ length: 400 }, () => ({ Name: "界".repeat(4096) })) })).toThrow("4 MB");
  });

  it("stops a document read after cancellation and never requests another page", async () => {
    const controller = new AbortController();
    const queryCollectionRecords = vi.fn(async () => { controller.abort(); return { collection: { path: "People", status: "valid" as const, reasons: [] }, records: [], groups: null, nextCursor: { sortValues: [], recordId: "1", recordPath: "1.md" } }; });
    const reader = { getCollection: async () => ({ path: "People", status: "valid" as const, reasons: [], schema, recordCount: 1 }), queryCollectionRecords } as unknown as SourceImportReader;
    await expect(readDocumentCollectionToCsv(reader, "workspace", "People", controller.signal)).rejects.toThrow();
    expect(queryCollectionRecords).toHaveBeenCalledOnce();
  });

  it("refuses repeated document records across pages", async () => {
    const cursor = { sortValues: [], recordId: "1", recordPath: "1.md" };
    const record = { id: "1", path: "1.md", conflicted: false, values: [] };
    const reader = {
      getCollection: async () => ({ path: "People", status: "valid" as const, reasons: [], schema, recordCount: 2 }),
      queryCollectionRecords: vi.fn(async () => ({ collection: { path: "People", status: "valid", reasons: [] }, records: [record], groups: null, nextCursor: cursor })),
    } as unknown as SourceImportReader;
    await expect(readDocumentCollectionToCsv(reader, "workspace", "People", new AbortController().signal)).rejects.toThrow("changed while");
  });
});
