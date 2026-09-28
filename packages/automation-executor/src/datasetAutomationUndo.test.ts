import { describe, expect, it } from "vitest";
import type { DatasetDefinition, DatasetRevision } from "@dohc/security-contract/dataset";
import type { DatasetInvocation } from "./datasetAutomationRun";
import { AppBackendRuntimeError, type JsonValue } from "@dohc/app-backend-runtime";
import type { DatasetInvocationResult } from "@dohc/app-backend-runtime/supervisor";
import type { RunWrite, StoredRun } from "./automationRunStore";
import { datasetFieldKey } from "./automationReach";
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
  version: 6, claimId: "claim", automationId: "collection:Budget#close", definitionHash: "h", keySeed: "h-1", startedAtMs: 1, finishedAtMs: 1,
  steps: [], created: [], replans: [], undoRequests: [], readableFields: null, collections: [], rules: null, superseded: false, undo: null, settled: true, outcome: { state: "done" },
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
    expect(datasetUndoRulesChanged({ resolves: () => false, revision: () => revision }, [run(EDIT)])).toBe(true);
    expect(datasetUndoRulesChanged({ resolves: () => true, revision: () => revision }, [run(EDIT)])).toBe(false);
  });

  it("sends a reversible edit back with the values it replaced under the same key each time, and leaves an edit the rules do not let it undo", async () => {
    const sent: DatasetInvocation[] = [];
    const host = {
      invokeAsOwner: async (input: DatasetInvocation) => { sent.push(input); return { result: { id: "a", version: 3, priorValues: { [STATUS]: "Closed" } }, revision: 9, replayed: false }; },
      revision: () => revision, resolves: () => true,
    };
    const undone = { reverted: 1, removed: 0, kept: 1, changedSince: 0, missing: 0, irreversible: 0, actions: 0, actionsReversed: 0 };
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
  const none = { reverted: 0, removed: 0, kept: 0, changedSince: 0, missing: 0, irreversible: 0, actions: 0, actionsReversed: 0 };

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

  it("puts back a person's change made between two of the runs' edits, not what the field held first", async () => {
    // The run set Open → Paid; someone set Held; the run then set Held → Closed.
    const records = { a: { version: 4, values: { [STATUS]: "Closed" } } };
    const { writes, host } = recordsHost(records);
    const runs = [runOf("h-1", 1, [edit(EDIT, "a", STATUS, "Open", "Paid", 2), edit(EDIT, "a", STATUS, "Held", "Closed", 4)])];
    expect(await undo(host, runs)).toEqual({ ...none, reverted: 1 });
    expect(records.a.values[STATUS]).toBe("Held");
    expect(writes).toEqual([{ [STATUS]: "Held" }]);
  });

  it("undoes the edit a run may have landed just before it stopped, before recording it, whether or not it landed", async () => {
    const planned = { kind: "dataset-edit" as const, rules, operationId: EDIT, tableId: TABLE, target: { recordId: "a", version: 2 },
      fields: [{ fieldId: STATUS, field: "Status", before: "Paid", after: "Closed" }] };
    // The run recorded Open → Paid at version 2, saved its next step, and stopped as that edit was sent.
    const stopped = (): StoredRun => ({ ...runOf("h-1", 1, [edit(EDIT, "a", STATUS, "Open", "Paid", 2)]), outcome: null,
      steps: [{ ordinal: 0, effects: [{ kind: "dataset-edit", rules, operationId: EDIT, tableId: TABLE, target: { recordId: "a", version: 1 },
        fields: [{ fieldId: STATUS, field: "Status", before: "Open", after: "Paid" }] }] }, { ordinal: 1, effects: [planned] }] });
    for (const landed of [true, false]) {
      const records = { a: landed ? { version: 3, values: { [STATUS]: "Closed" } } : { version: 2, values: { [STATUS]: "Paid" } } };
      const { host } = recordsHost(records);
      expect(datasetUndoRulesChanged(host, [stopped()]), `landed ${landed}`).toBe(false);
      expect(await undo(host, [stopped()]), `landed ${landed}`).toEqual({ ...none, reverted: 1 });
      expect(records.a.values[STATUS], `landed ${landed}`).toBe("Open");
    }
    // Someone changed it since: it stays.
    const records = { a: { version: 5, values: { [STATUS]: "Mine" } } };
    const { writes, host } = recordsHost(records);
    expect(await undo(host, [stopped()])).toEqual({ ...none, changedSince: 1 });
    expect(writes).toEqual([]);
  });

  it("reads the record before trusting the version of an edit that may not have landed, so a person's change stays", async () => {
    // The run set Status Open → Paid at version 2. Someone set Held at version 3. The run's
    // next edit, replanned at version 3 to change only Note, never landed.
    const noteEdit = { kind: "dataset-edit" as const, rules, operationId: EDIT, tableId: TABLE, target: { recordId: "a", version: 2 },
      fields: [{ fieldId: STATUS, field: "Status", before: "Paid", after: "Paid" }, { fieldId: NOTE, field: "Note", before: "Draft", after: "Sent" }] };
    const stopped: StoredRun = { ...runOf("h-1", 1, [edit(EDIT, "a", STATUS, "Open", "Paid", 2)]), outcome: null,
      steps: [{ ordinal: 0, effects: [{ kind: "dataset-edit", rules, operationId: EDIT, tableId: TABLE, target: { recordId: "a", version: 1 },
        fields: [{ fieldId: STATUS, field: "Status", before: "Open", after: "Paid" }] }] }, { ordinal: 1, effects: [noteEdit] }],
      replans: [{ effect: 1, replan: 1, version: 3, fields: [{ fieldId: NOTE, field: "Note", before: "Draft", after: "Sent" }], kept: [] }] };
    const records = { a: { version: 3, values: { [STATUS]: "Held", [NOTE]: "Draft" } } };
    const { writes, host } = recordsHost(records);
    expect(await undo(host, [stopped])).toEqual({ ...none, changedSince: 1 });
    expect(records.a.values).toEqual({ [STATUS]: "Held", [NOTE]: "Draft" });
    expect(writes).toEqual([]);
  });

  it("reads the record before putting back a field whose last edit may not have landed, though a later edit of another field did", async () => {
    // A stopped run planned Status Open → Paid at version 2 and never landed it. Someone set Held.
    // The start-over changed only Note, at version 3.
    const statusEdit = { kind: "dataset-edit" as const, rules, operationId: EDIT, tableId: TABLE, target: { recordId: "a", version: 2 },
      fields: [{ fieldId: STATUS, field: "Status", before: "Open", after: "Paid" }] };
    const older: StoredRun = { ...runOf("h-1", 1, []), applied: [], outcome: null, steps: [{ ordinal: 0, effects: [statusEdit] }] };
    const newer = runOf("h-2", 2, [edit(EDIT, "a", NOTE, "Draft", "Sent", 4)]);
    const records = { a: { version: 4, values: { [STATUS]: "Held", [NOTE]: "Sent" } } };
    const { writes, host } = recordsHost(records);
    expect(await undo(host, [older, newer])).toEqual({ ...none, reverted: 1, changedSince: 1 });
    expect(records.a.values).toEqual({ [STATUS]: "Held", [NOTE]: "Draft" });
    expect(writes).toEqual([{ [NOTE]: "Draft" }]);
  });

  it("leaves a field of an edit that may not have landed when its run could not read it, or no approved read can check it", async () => {
    const closing = { kind: "dataset-edit" as const, rules, operationId: EDIT, tableId: TABLE, target: { recordId: "a", version: 2 },
      fields: [{ fieldId: STATUS, field: "Status", before: "Open", after: "Closed" }] };
    const readableOf = (fieldIds: string[]) => fieldIds.map((fieldId) => datasetFieldKey(rules.datasetId, TABLE, fieldId));
    const stopped = (readableFields: string[]): StoredRun => ({ ...runOf("h-1", 1, []), applied: [], outcome: null, readableFields: readableOf(readableFields), steps: [{ ordinal: 0, effects: [closing] }] });
    // The run could not read Status, so the value it planned as before is not what the record held.
    const hidden = recordsHost({ a: { version: 3, values: { [STATUS]: "Closed" } } });
    expect(await undo(hidden.host, [stopped([NOTE])])).toEqual({ ...none, irreversible: 1 });
    expect(hidden.writes).toEqual([]);
    // Nor does a chain through it: the run cleared Status, then may have written it unread, someone cleared it, and a later run set Paid.
    const statusEdit = (before: JsonValue, after: JsonValue) => ({ ...closing, fields: [{ fieldId: STATUS, field: "Status", before, after }] });
    const cleared: StoredRun = { ...runOf("h-1", 1, [edit(EDIT, "a", STATUS, "Open", null as unknown as string, 2)]), outcome: null, readableFields: readableOf([NOTE]),
      steps: [{ ordinal: 0, effects: [statusEdit("Open", null)] }, { ordinal: 1, effects: [statusEdit(null, "Closed")] }] };
    const later = runOf("h-2", 2, [edit(EDIT, "a", STATUS, null as unknown as string, "Paid", 4)]);
    const chained = recordsHost({ a: { version: 4, values: { [STATUS]: "Paid" } } });
    expect(await undo(chained.host, [cleared, later])).toEqual({ ...none, reverted: 1 });
    // Paid goes back to the cleared value the later run found, not past the edit it could not read.
    expect(chained.writes).toEqual([{ [STATUS]: null }]);
    // No approved read shows Status, so dohc cannot check whether the edit landed.
    const unread = recordsHost({ a: { version: 3, values: { [STATUS]: "Closed" } } });
    const withoutRead = { ...unread.host, revision: () => ({ ...revision, definition: { ...definition, operations: definition.operations.filter((operation) => operation.operationId !== READ) } }) };
    expect(await undo(withoutRead, [stopped([STATUS, NOTE])])).toEqual({ ...none, irreversible: 1 });
    expect(unread.writes).toEqual([]);
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

describe("undo of a dataset run's actions", () => {
  const HOLD = id(20), RELEASE = id(21), SETTLE = id(22);
  const withActions: DatasetDefinition = { ...definition, operations: [...definition.operations,
    { operationId: HOLD, name: "invoices.hold", label: "Hold", tableId: TABLE, kind: "action", access: "owner", readOnly: false, fieldIds: [STATUS], reversedBy: "invoices.release" },
    { operationId: RELEASE, name: "invoices.release", label: "Release", tableId: TABLE, kind: "action", access: "owner", readOnly: false, fieldIds: [STATUS] },
    { operationId: SETTLE, name: "invoices.settle", label: "Settle", tableId: TABLE, kind: "action", access: "owner", readOnly: false, fieldIds: [STATUS] },
  ] };
  const action = (operationId: string, name: string, forward: number, undo?: JsonValue, under = rules): RunWrite =>
    ({ kind: "dataset-action", rules: under, operationId, tableId: TABLE, name, revision: forward, ...(undo === undefined ? {} : { undo, reverseOperationId: RELEASE }) });
  const runOf = (startedAtMs: number, writes: RunWrite[]): StoredRun => ({ ...run(EDIT), startedAtMs, applied: [{ ordinal: 0, writes }] });

  it("reverses the newest commit first even when a later run's clock read earlier, and keeps each reverse's key", async () => {
    const sent: DatasetInvocation[] = [];
    const host: DatasetUndoHost = {
      invokeAsOwner: async (input) => { sent.push(input); return { result: { ok: true }, revision: 30, replayed: false }; },
      revision: () => ({ ...revision, definition: withActions }),
      resolves: () => true,
    };
    // The start-over run began at an earlier clock reading, but committed revision 11 after the first run's 10.
    const runs = [runOf(5, [action(HOLD, "Hold", 10, { id: "a", status: "Open" })]), runOf(1, [action(HOLD, "Hold", 11, { id: "b", status: "Open" }), action(SETTLE, "Settle", 12)])];
    expect(await undo(host, runs)).toMatchObject({ actionsReversed: 2, actions: 1 });
    expect(sent.map((input) => input.input)).toEqual([{ id: "b", status: "Open" }, { id: "a", status: "Open" }]);
    expect(sent.every((input) => input.operationId === RELEASE)).toBe(true);
    const keys = sent.map((input) => input.idempotencyKey);
    sent.length = 0;
    await undo(host, runs);
    expect(sent.map((input) => input.idempotencyKey)).toEqual(keys);
  });

  it("stops at the first reverse the dataset refuses, and refuses to start once any action's rules no longer resolve", async () => {
    const sent: DatasetInvocation[] = [];
    const host: DatasetUndoHost = {
      invokeAsOwner: async (input) => { sent.push(input); throw new AppBackendRuntimeError({ code: "changed", message: "This invoice is no longer on hold." }); },
      revision: () => ({ ...revision, definition: withActions }),
      resolves: () => true,
    };
    const runs = [runOf(1, [action(HOLD, "Hold", 10, { id: "a" }), action(HOLD, "Hold", 11, { id: "b" })])];
    await expect(undo(host, runs)).rejects.toThrow("Hold was not undone. Release refused: This invoice is no longer on hold.");
    expect(sent).toHaveLength(1);
    // An action with no reverse under rules that changed still stops Undo before it starts.
    const mixed = [runOf(1, [action(SETTLE, "Settle", 10)]), runOf(2, [action(HOLD, "Hold", 11, { id: "a" }, { ...rules, revision: 3 })])];
    expect(datasetUndoRulesChanged({ resolves: (reference) => reference.revision === 3, revision: () => ({ ...revision, definition: withActions }) }, mixed)).toBe(true);
  });

  it("refuses to start when the rules now name another reverse than the one an action ran with", async () => {
    const OTHER = id(23);
    const repointed: DatasetDefinition = { ...withActions, operations: withActions.operations.map((operation) =>
      operation.operationId === RELEASE ? { ...operation, operationId: OTHER } : operation) };
    const sent: DatasetInvocation[] = [];
    const host: DatasetUndoHost = {
      invokeAsOwner: async (input) => { sent.push(input); return { result: { ok: true }, revision: 30, replayed: false }; },
      revision: () => ({ ...revision, definition: repointed }),
      resolves: () => true,
    };
    const runs = [runOf(1, [action(HOLD, "Hold", 10, { id: "a" })])];
    expect(datasetUndoRulesChanged(host, runs)).toBe(true);
    await expect(undo(host, runs)).rejects.toThrow("Collection rules changed after this run, so dohc cannot undo it.");
    expect(sent).toEqual([]);
    expect(datasetUndoRulesChanged({ ...host, revision: () => ({ ...revision, definition: withActions }) }, runs)).toBe(false);
  });
});
