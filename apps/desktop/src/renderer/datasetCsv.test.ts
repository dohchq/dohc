import { describe, expect, it, vi } from "vitest";
import type { DatasetOperation } from "@dohc/security-contract/dataset";
import type { TransactionalField } from "./transactionalCollectionModel";
import { createCsvImportPlan, exportDatasetCsv, parseCsvImportReport, parseDatasetCsv, previewDatasetCsv, runCsvImport, type CsvInvoke } from "./datasetCsv";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const fields: TransactionalField[] = [
  { fieldId: id(1), name: "Name", type: "text", required: true, unique: false },
  { fieldId: id(2), name: "Amount", type: "number", required: false, unique: false },
  { fieldId: id(3), name: "Status", type: "select", required: true, unique: false, options: ["Pending", "Approved"], default: "Pending" },
  { fieldId: id(4), name: "Private", type: "text", required: false, unique: false },
];
const create: DatasetOperation = { operationId: id(5), name: "create", label: "Create", tableId: id(6), kind: "create", readOnly: false, access: "owner", fieldIds: [id(1), id(2), id(3)] };
const scope = { workspaceId: "workspace-a", datasetId: id(7), revision: 1, revisionSha256: "a".repeat(64), operationId: create.operationId };
function plan() { let n = 100; return createCsvImportPlan(scope, previewDatasetCsv(parseDatasetCsv("Name,Amount\nAlice,1\nBob,2\nInvalid,no\nCharlie,3"), fields, create, [id(1), id(2)]), () => id(n++)); }

describe("dataset CSV transfers", () => {
  it("preserves quoted multiline cells and escaped quotes, and rejects malformed records", () => {
    expect(parseDatasetCsv('\uFEFFName,Note\r\n"Alice, Jr.","Line 1\nLine ""2"""\r\n')).toEqual({ headers: ["Name", "Note"], rows: [["Alice, Jr.", 'Line 1\nLine "2"']] });
    for (const text of ['Name\n"unclosed', 'Name\n"closed"extra', 'Name\nun"quoted', '']) expect(() => parseDatasetCsv(text)).toThrow();
    expect(() => parseDatasetCsv("Name\n" + "x\n".repeat(10_001))).toThrow("10,000");
  });
  it("maps stable identities, previews per-row errors, and leaves default fields to the create action", () => {
    const csv = parseDatasetCsv("Renamed,Amount,Status\nAlice,1,\nBob,not a number,Missing\nOnly name");
    const preview = previewDatasetCsv(csv, fields, create, [id(1), id(2), id(3)]);
    expect(preview.rows[0]).toMatchObject({ values: { [id(1)]: "Alice", [id(2)]: 1 }, errors: [] });
    expect(preview.rows[0]!.values).not.toHaveProperty(id(3));
    expect(preview.rows[1]!.errors).toHaveLength(2);
    expect(preview.rows[2]!.errors).toEqual(["Expected 3 columns; found 1."]);
    expect(() => previewDatasetCsv(csv, fields, create, [id(1), id(4), null])).toThrow("permitted field");
    expect(() => previewDatasetCsv(csv, fields, create, [id(1), id(1), null])).toThrow("different");
  });
  it("requires explicit typed relations and refuses fake file imports", () => {
    const typed: TransactionalField[] = [
      { ...fields[0]!, fieldId: id(8), name: "Team", type: "relation", relation: { datasetId: id(7), tableId: id(6), fieldId: id(1), many: false } },
      { ...fields[0]!, fieldId: id(9), name: "Receipt", type: "attachment", required: false },
      { ...fields[0]!, fieldId: id(10), name: "Options", type: "multi-select", options: ["A", "B"] },
      { ...fields[0]!, fieldId: id(11), name: "Day", type: "date" },
    ];
    const operation = { ...create, fieldIds: typed.map(field => field.fieldId) };
    const preview = previewDatasetCsv({ headers: ["Team", "Receipt", "Options", "Day"], rows: [['"team-1"', "file-id", '["A"]', "2026-02-30"], ['"team-1"', "", '["A","B"]', "2026-02-28"]] }, typed, operation, operation.fieldIds);
    expect(preview.rows[0]!.errors).toHaveLength(2);
    expect(preview.rows[1]).toMatchObject({ errors: [], values: { [id(8)]: "team-1", [id(9)]: null, [id(10)]: ["A", "B"] } });
  });
  it("separates refusal from uncertainty, stops on uncertainty, and replays exact identities", async () => {
    const captured = plan();
    const invoke = vi.fn<CsvInvoke>().mockResolvedValueOnce({ result: { id: "alice" } }).mockRejectedValueOnce(new Error("Connection lost"));
    const first = await runCsvImport(captured, invoke, new AbortController().signal);
    expect(first.rows.map(row => row.outcome)).toEqual(["accepted", "uncertain", "invalid", "pending"]);
    expect(captured.rows[0]!.outcome).toBe("pending");
    invoke.mockRejectedValueOnce(Object.assign(new Error("Capacity reached"), { code: "operation_refused" })).mockResolvedValueOnce({ result: { id: "charlie" } });
    const second = await runCsvImport(first, invoke, new AbortController().signal);
    expect(second.rows.map(row => row.outcome)).toEqual(["accepted", "refused", "invalid", "accepted"]);
    expect(invoke.mock.calls[1]![0]).toEqual(invoke.mock.calls[2]![0]);
    expect(invoke.mock.calls.filter(call => call[0].idempotencyKey === captured.rows[0]!.idempotencyKey)).toHaveLength(1);
  });
  it("restores report identities only for the captured scope and approved fields", () => {
    const captured = plan(); expect(parseCsvImportReport(JSON.stringify(captured), scope, fields, create)).toEqual(captured);
    expect(() => parseCsvImportReport(JSON.stringify(captured), { ...scope, workspaceId: "other" }, fields, create)).toThrow("revision");
    captured.rows[0]!.values[id(4)] = "private";
    expect(() => parseCsvImportReport(JSON.stringify(captured), scope, fields, create)).toThrow("invalid");
  });
  it("exports projected pages and prefixes formula-like text while retaining numeric cells", async () => {
    const read = { ...create, kind: "read" as const, readOnly: true, fieldIds: [id(1), id(2)] };
    const invoke = vi.fn<CsvInvoke>().mockResolvedValueOnce({ result: { rows: [{ id: "a", version: 1, values: { [id(1)]: "=HYPERLINK(1)", [id(2)]: -5, [id(4)]: "secret" } }], nextCursor: { id: "a", value: "a" } } }).mockResolvedValueOnce({ result: { rows: [{ id: "b", version: 1, values: { [id(1)]: "\t@SUM(1)", [id(2)]: 8 } }], nextCursor: null } });
    const result = await exportDatasetCsv({ scope, operation: read, fields, invoke, signal: new AbortController().signal });
    expect(result).toEqual({ rows: 2, content: "Name,Amount\r\n'=HYPERLINK(1),-5\r\n'\t@SUM(1),8\r\n" });
    expect(invoke.mock.calls[1]![0].input).toEqual({ limit: 50, after: { id: "a", value: "a" } });
    expect(result.content).not.toContain("secret");
  });
  it("allows explicit raw export and rejects repeated page identities", async () => {
    const read = { ...create, kind: "read" as const, readOnly: true, fieldIds: [id(1)] };
    const response = { result: { rows: [{ id: "a", version: 1, values: { [id(1)]: "=SUM(1)" } }], nextCursor: null } };
    const invoke = vi.fn<CsvInvoke>().mockResolvedValue(response);
    expect((await exportDatasetCsv({ scope, operation: read, fields, invoke, signal: new AbortController().signal, spreadsheetSafe: false })).content).toContain("\r\n=SUM(1)");
    invoke.mockResolvedValue({ result: { ...response.result, nextCursor: { id: "a", value: "a" } } });
    await expect(exportDatasetCsv({ scope, operation: read, fields, invoke, signal: new AbortController().signal })).rejects.toThrow("changed during export");
  });
});
