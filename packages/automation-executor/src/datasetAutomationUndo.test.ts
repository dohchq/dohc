import { describe, expect, it } from "vitest";
import type { DatasetDefinition, DatasetRevision } from "@dohc/security-contract/dataset";
import type { DatasetInvocation } from "./datasetAutomationRun";
import { AppBackendRuntimeError, type JsonValue } from "@dohc/app-backend-runtime";
import type { DatasetInvocationResult } from "@dohc/app-backend-runtime/supervisor";
import type { RunWrite, StoredRun } from "./automationRunStore";
import { datasetUndoRulesChanged, undoDatasetAutomationRuns, type DatasetUndoHost } from "./datasetAutomationUndo";

const id = (number: number) => `00000000-0000-4000-8000-${String(number).padStart(12, "0")}`;
const TABLE = id(2), STATUS = id(4), NOTE = id(5), EDIT = id(11), LOOSE = id(12), READ = id(13);
const definition: DatasetDefinition = {
  formatVersion: 1, datasetId: id(1), name: "Budget", schemaPath: "Budget/schema.sql", operationsPath: "Budget/operations.js",
  tables: [{ tableId: TABLE, name: "Invoices", sqlName: "invoices", primaryKey: "id", fields: [
    { fieldId: id(3), name: "ID", sqlColumn: "id", type: "text", required: true, unique: true },
    { fieldId: STATUS, name: "Status", sqlColumn: "status", type: "text", required: true, unique: false },
    { fieldId: NOTE, name: "Note", sqlColumn: "note", type: "text", required: false, unique: false },
  ] }],
  operations: [
    { operationId: EDIT, name: "invoices.edit", label: "Edit", tableId: TABLE, kind: "edit", access: "owner", readOnly: false, fieldIds: [STATUS, NOTE], reversible: true },
    { operationId: LOOSE, name: "invoices.loose", label: "Loose", tableId: TABLE, kind: "edit", access: "owner", readOnly: false, fieldIds: [STATUS] },
    { operationId: READ, name: "invoices.list", label: "View", tableId: TABLE, kind: "read", access: "owner", readOnly: true, fieldIds: [STATUS, NOTE] },
  ],
};
const rules = { datasetId: definition.datasetId, revision: 2, revisionSha256: "r".repeat(64) };
const revision = { ...rules, definitionSha256: "", schemaSha256: "", operationsSha256: "", definition } satisfies DatasetRevision;
const run = (operationId: string): StoredRun => ({
  version: 2, claimId: "claim", automationId: "collection:Budget#close", definitionHash: "h", keySeed: "h-1", startedAtMs: 1, updatedAtMs: 1,
  plan: null, created: [], replans: [], undoRequests: [], readableFields: null, superseded: false, undo: null, settled: true, compacted: false, outcome: { state: "done" },
  applied: [{ ordinal: 0, writes: [
    { kind: "dataset-edit", rules, operationId, tableId: TABLE, recordId: "a", version: 2,
      fields: [{ fieldId: STATUS, field: "Status", before: "Open", after: "Closed" }] },
    { kind: "dataset-created", rules, operationId: EDIT, tableId: TABLE, recordId: "b", version: 1 },
  ] }],
});

// An Undo as the executor makes it: a request sent again is saved with the claim's newest run.
const undo = (host: DatasetUndoHost, runs: StoredRun[]) => undoDatasetAutomationRuns(host, "claim", runs, async (request) => {
  runs.at(-1)!.undoRequests.push(request);
}, new AbortController().signal);

describe("undo of a dataset run", () => {
  it("sees when the rules an edit ran under no longer resolve", () => {
    expect(datasetUndoRulesChanged({ resolves: () => false }, [run(EDIT)])).toBe(true);
    expect(datasetUndoRulesChanged({ resolves: () => true }, [run(EDIT)])).toBe(false);
  });

  it("sends a reversible edit back with the values it replaced under the same key each time, and leaves an edit the rules do not let it undo", async () => {
    const sent: DatasetInvocation[] = [];
    const host = {
      invokeAsOwner: async (input: DatasetInvocation) => { sent.push(input); return { result: { id: "a", version: 3, priorValues: { [STATUS]: "Closed" } }, revision: 9, replayed: false }; },
      revision: () => revision, resolves: () => true,
    };
    const undone = { reverted: 1, removed: 0, kept: 1, changedSince: 0, missing: 0, irreversible: 0, actions: 0 };
    expect(await undo(host, [run(EDIT)])).toEqual(undone);
    expect(sent).toEqual([expect.objectContaining({ operationId: EDIT, input: { id: "a", expectedVersion: 2, values: { [STATUS]: "Open" } }, idempotencyKey: expect.stringMatching(/^u\.[0-9a-f]{64}$/) })]);
    // An Undo that stopped part way sends the same content under the same key, so the dataset replays its receipt.
    expect(await undo(host, [run(EDIT)])).toEqual(undone);
    expect(sent[1]?.idempotencyKey).toBe(sent[0]?.idempotencyKey);
    expect(await undo(host, [run(LOOSE)]))
      .toEqual({ ...undone, reverted: 0, irreversible: 1 });
    expect(sent).toHaveLength(2);
  });

  // Records in memory behind generated edit and read operations: an edit at
  // another version is refused as stale, and a key already used replays.
  function recordsHost(records: Record<string, { version: number; values: Record<string, JsonValue> }>) {
    const receipts = new Map<string, DatasetInvocationResult>();
    const writes: Array<Record<string, JsonValue>> = [];
    const invokeAsOwner = async ({ operationId, input, idempotencyKey }: DatasetInvocation): Promise<DatasetInvocationResult> => {
      if (operationId === READ) {
        const wanted = String((input as { after: { value: string } }).after.value);
        return { result: { rows: [{ id: wanted, ...structuredClone(records[wanted]!) }], nextCursor: null }, revision: 9, replayed: false };
      }
      const replay = receipts.get(idempotencyKey);
      if (replay) return { ...replay, replayed: true };
      const edit = input as { id: string; expectedVersion: number; values: Record<string, JsonValue> };
      const record = records[edit.id]!;
      if (edit.expectedVersion !== record.version) throw new AppBackendRuntimeError({ code: "stale_record", message: "stale" });
      Object.assign(record.values, edit.values);
      record.version += 1;
      writes.push(edit.values);
      const answer = { result: { id: edit.id, version: record.version, priorValues: {} }, revision: 9, replayed: false };
      receipts.set(idempotencyKey, answer);
      return answer;
    };
    return { writes, host: { invokeAsOwner, revision: () => revision, resolves: () => true } };
  }
  const edit = (operationId: string, recordId: string, fieldId: string, before: string, after: string, version: number): RunWrite =>
    ({ kind: "dataset-edit", rules, operationId, tableId: TABLE, recordId, version, fields: [{ fieldId, field: "Field", before, after }] });
  const runOf = (keySeed: string, startedAtMs: number, writes: RunWrite[]): StoredRun => ({ ...run(EDIT), keySeed, startedAtMs, applied: [{ ordinal: 0, writes }] });
  const none = { reverted: 0, removed: 0, kept: 0, changedSince: 0, missing: 0, irreversible: 0, actions: 0 };

  it("keeps a field someone changed after the runs' last write to it, even where it matches an earlier write", async () => {
    // The runs wrote Open → Paid → Closed. Someone then set it back to Paid.
    const records = { a: { version: 4, values: { [STATUS]: "Paid" } } };
    const { writes, host } = recordsHost(records);
    const runs = [runOf("h-1", 1, [edit(EDIT, "a", STATUS, "Open", "Paid", 2)]), runOf("h-2", 2, [edit(EDIT, "a", STATUS, "Paid", "Closed", 3)])];
    expect(await undo(host, runs)).toEqual({ ...none, changedSince: 1 });
    expect(records.a.values[STATUS]).toBe("Paid");
    expect(writes).toEqual([]);
  });

  it("leaves a field a later edit the rules do not let it undo wrote", async () => {
    const records = { a: { version: 4, values: { [STATUS]: "Paid" } } };
    const { writes, host } = recordsHost(records);
    const runs = [runOf("h-1", 1, [edit(EDIT, "a", STATUS, "Open", "Paid", 2), edit(LOOSE, "a", STATUS, "Paid", "Closed", 3)])];
    expect(await undo(host, runs)).toEqual({ ...none, irreversible: 1 });
    expect(writes).toEqual([]);
  });

  it("puts a field written twice back in one write, so it is never left between the runs' writes", async () => {
    // Someone changed Note after the runs wrote Open → Paid → Closed.
    const records = { a: { version: 4, values: { [STATUS]: "Closed", [NOTE]: "mine" } } };
    const { writes, host } = recordsHost(records);
    const runs = [runOf("h-1", 1, [edit(EDIT, "a", STATUS, "Open", "Paid", 2), edit(EDIT, "a", STATUS, "Paid", "Closed", 3)])];
    expect(await undo(host, runs)).toEqual({ ...none, reverted: 1 });
    expect(records.a.values).toEqual({ [STATUS]: "Open", [NOTE]: "mine" });
    expect(writes).toEqual([{ [STATUS]: "Open" }]);
  });

  it("replays a record's receipt when an Undo saved only some of the claim's runs done", async () => {
    const records = { a: { version: 2, values: { [STATUS]: "Closed" } }, b: { version: 2, values: { [NOTE]: "Sent" } } };
    const { writes, host } = recordsHost(records);
    const older = runOf("h-1", 1, [edit(EDIT, "a", STATUS, "Open", "Closed", 2)]);
    const newer = runOf("h-2", 2, [edit(EDIT, "b", NOTE, "Draft", "Sent", 2)]);
    expect(await undo(host, [older, newer])).toEqual({ ...none, reverted: 2 });
    // Only the older run was saved done. Someone then sets Note back to what the run wrote; the retry replays and leaves it.
    records.b.values[NOTE] = "Sent";
    records.b.version += 1;
    expect(await undo(host, [newer])).toEqual({ ...none, reverted: 1 });
    expect(records.b.values[NOTE]).toBe("Sent");
    expect(writes).toHaveLength(2);
  });

  it("sends a request it sent again at a newer version first on a retry, so a person's later change stays", async () => {
    // The run left Status Closed at version 3. Someone then changed Note.
    const records = { a: { version: 4, values: { [STATUS]: "Closed", [NOTE]: "mine" } } };
    const { writes, host } = recordsHost(records);
    const runs = [runOf("h-1", 1, [edit(EDIT, "a", STATUS, "Open", "Closed", 3)])];
    expect(await undo(host, runs)).toEqual({ ...none, reverted: 1 });
    expect(runs[0]!.undoRequests).toEqual([{ datasetId: rules.datasetId, tableId: TABLE, recordId: "a", operationId: EDIT, version: 4, values: { [STATUS]: "Open" } }]);
    // The Undo stopped before it was saved done. Someone sets Status back to Closed, then Undo runs again.
    records.a.values[STATUS] = "Closed";
    records.a.version += 1;
    expect(await undo(host, runs)).toEqual({ ...none, reverted: 1 });
    expect(records.a.values[STATUS]).toBe("Closed");
    expect(writes).toEqual([{ [STATUS]: "Open" }]);
  });
});
