import { describe, expect, it } from "vitest";
import { datasetPrincipalKey } from "@dohc/security-contract/dataset-artifacts";
import type { DatasetDefinition, DatasetRevision } from "@dohc/security-contract/dataset";
import type { DatasetInvocation } from "./datasetAutomationRun";
import { AppBackendRuntimeError, type JsonValue } from "@dohc/app-backend-runtime";
import type { DatasetInvocationResult } from "@dohc/app-backend-runtime/supervisor";
import type { ReachDatasetGrants, ReachRoster } from "./automationReach";
import type { RunWrite, StoredRun } from "./automationRunStore";
import { datasetFieldKey } from "./automationReach";
import { datasetUndoDeletes } from "./datasetAutomationPlan";
import {
  datasetUndoLostRun,
  datasetUndoRulesChanged,
  planDatasetUndo,
  undoDatasetAutomationRuns,
  type DatasetUndoHost,
  type DatasetUndoPreview,
  type DatasetUndoReach,
} from "./datasetAutomationUndo";

const id = (number: number) => `00000000-0000-4000-8000-${String(number).padStart(12, "0")}`;
const TABLE = id(2), STATUS = id(4), NOTE = id(5), EDIT = id(11), LOOSE = id(12), READ = id(13), CREATE = id(14), REMOVE = id(15), ARCHIVE = id(16);
const OTHER_TABLE = id(20), OTHER_REMOVE = id(21);
const definition: DatasetDefinition = {
  formatVersion: 1, datasetId: id(1), name: "Budget", schemaPath: "Budget/schema.sql", operationsPath: "Budget/operations.js",
  tables: [{ tableId: TABLE, name: "Invoices", sqlName: "invoices", primaryKey: "id", fields: [
    { fieldId: id(3), name: "ID", sqlColumn: "id", type: "text", required: true, unique: true },
    { fieldId: STATUS, name: "Status", sqlColumn: "status", type: "text", required: true, unique: false },
    { fieldId: NOTE, name: "Note", sqlColumn: "note", type: "text", required: false, unique: false },
  ] }, { tableId: OTHER_TABLE, name: "Payments", sqlName: "payments", primaryKey: "id", fields: [
    { fieldId: id(22), name: "ID", sqlColumn: "id", type: "text", required: true, unique: true },
  ] }],
  operations: [
    { operationId: EDIT, name: "invoices.edit", label: "Edit", tableId: TABLE, kind: "edit", access: "owner", readOnly: false, fieldIds: [STATUS, NOTE], reversible: true },
    { operationId: LOOSE, name: "invoices.loose", label: "Loose", tableId: TABLE, kind: "edit", access: "owner", readOnly: false, fieldIds: [STATUS] },
    { operationId: READ, name: "invoices.list", label: "View", tableId: TABLE, kind: "read", access: "owner", readOnly: true, fieldIds: [STATUS, NOTE] },
    { operationId: CREATE, name: "invoices.create", label: "Add", tableId: TABLE, kind: "create", access: "owner", readOnly: false, fieldIds: [STATUS, NOTE] },
    { operationId: REMOVE, name: "invoices.delete", label: "Delete invoice", tableId: TABLE, kind: "delete", access: "helper", readOnly: false, fieldIds: [] },
    { operationId: OTHER_REMOVE, name: "payments.delete", label: "Delete payment", tableId: OTHER_TABLE, kind: "delete", access: "helper", readOnly: false, fieldIds: [] },
  ],
};
// The same rules with a second delete in Invoices.
const twoDeletes: DatasetDefinition = { ...definition, operations: [...definition.operations,
  { operationId: ARCHIVE, name: "invoices.archive", label: "Archive invoice", tableId: TABLE, kind: "delete", access: "helper", readOnly: false, fieldIds: [] }] };
const rules = { datasetId: definition.datasetId, revision: 2, revisionSha256: "r".repeat(64) };
const revisionOf = (rulesNow: DatasetDefinition) => ({ ...rules, definitionSha256: "", schemaSha256: "", operationsSha256: "", definition: rulesNow }) satisfies DatasetRevision;
const revision = revisionOf(definition);
const NO_GRANTS: ReachDatasetGrants = { workspaceId: "workspace", grants: [] };
const OWNER: ReachRoster = { kind: "owner", ownerUserId: "user-owner", grants: [] };
const collection = { path: "Budget", name: "Budget" };
const alone: DatasetUndoReach = { roster: OWNER, collection };
// Ana can edit the Collection, so she edits its automations too.
const ANA = { grantId: "grant-ana", recipientUserId: "user-ana", recipientEmail: "ana@example.com", files: { paths: ["Budget"], versionId: null, access: "edit" as const }, channel: null };
const withAna: DatasetUndoReach = { roster: { ...OWNER, grants: [ANA] }, collection };
const anaMayDelete: ReachDatasetGrants = { workspaceId: "workspace", grants: [{ principalKey: datasetPrincipalKey("workspace", ANA.grantId, ANA.recipientUserId), operationIds: [REMOVE] }] };

const run = (operationId: string): StoredRun => ({
  version: 8, claimId: "claim", automationId: "collection:Budget#close", definitionHash: "h", keySeed: "h-1", startedAtMs: 1, finishedAtMs: 1,
  steps: [], created: [], replans: [], undoRequests: [], undoCalls: [], undoCovers: [], readableFields: null, collections: [], rules: null, superseded: false, undo: null, undoKept: [], settled: true, outcome: { state: "done" },
  applied: [{ ordinal: 0, writes: [
    { kind: "dataset-edit", rules, operationId, tableId: TABLE, recordId: "a", expectedVersion: 1, version: 2,
      fields: [{ fieldId: STATUS, field: "Status", before: "Open", after: "Closed" }] },
    { kind: "dataset-created", rules, operationId: CREATE, tableId: TABLE, recordId: "b", version: 1, deletes: [] },
  ] }],
});

// An Undo as the executor makes it: a request sent again is saved with the claim's newest run.
// It reads who can edit before each delete, as `reach` says then.
const undo = async (host: DatasetUndoHost, runs: StoredRun[], reach: DatasetUndoReach | (() => DatasetUndoReach) = alone) =>
  (await undoDatasetAutomationRuns(host, collection, async () => (typeof reach === "function" ? reach() : reach).roster, "claim", runs, async (request) => {
    runs.at(-1)!.undoRequests.push(request);
  }, new AbortController().signal)).undone;
const preview = async (host: DatasetUndoHost, runs: StoredRun[], reach = alone) =>
  (await planDatasetUndo(host, reach, "claim", runs, runs, new AbortController().signal)).preview;
const shown = (counts: Partial<DatasetUndoPreview>) =>
  ({ deletes: 0, unchecked: 0, kept: 0, keptChanged: 0, gone: 0, reverts: 0, irreversible: 0, reverses: 0, actions: 0, choices: [], token: expect.stringMatching(/^[0-9a-f]{64}$/), ...counts });

const none = { reverted: 0, removed: 0, deleted: 0, kept: 0, keptChanged: 0, gone: 0, changedSince: 0, missing: 0, irreversible: 0, actions: 0, actionsReversed: 0 };

describe("undo of a dataset run", () => {
  it("sees when the rules an edit or an added record ran under no longer resolve", () => {
    expect(datasetUndoRulesChanged({ resolves: () => false, revision: () => revision }, [run(EDIT)])).toBe(true);
    expect(datasetUndoRulesChanged({ resolves: () => true, revision: () => revision }, [run(EDIT)])).toBe(false);
    const added = { ...run(EDIT), applied: [{ ordinal: 0, writes: [run(EDIT).applied[0]!.writes[1]!] }] };
    expect(datasetUndoRulesChanged({ resolves: () => false, revision: () => revision }, [added])).toBe(true);
  });

  it("sends a reversible edit back with the values it replaced under the same key each time, and leaves an edit the rules do not let it undo", async () => {
    const sent: DatasetInvocation[] = [];
    const host = {
      invokeAsOwner: async (input: DatasetInvocation) => { sent.push(input); return { result: { id: "a", version: 3, priorValues: { [STATUS]: "Closed" } }, revision: 9, replayed: false }; },
      revision: () => revision, resolves: () => true, dataGrants: () => NO_GRANTS,
    };
    // The added record's plan recorded no delete, so it stays.
    const undone = { ...none, reverted: 1, kept: 1 };
    expect(await undo(host, [run(EDIT)])).toEqual(undone);
    expect(sent).toEqual([expect.objectContaining({ operationId: EDIT, input: { id: "a", expectedVersion: 2, values: { [STATUS]: "Open" } }, idempotencyKey: expect.stringMatching(/^u\.[0-9a-f]{64}$/) })]);
    // An Undo that stopped part way sends the same content under the same key, so the dataset replays its receipt.
    expect(await undo(host, [run(EDIT)])).toEqual(undone);
    expect(sent[1]?.idempotencyKey).toBe(sent[0]?.idempotencyKey);
    expect(await undo(host, [run(LOOSE)]))
      .toEqual({ ...undone, reverted: 0, irreversible: 1 });
    expect(sent).toHaveLength(2);
  });

  // Records in memory behind generated edit, read, and delete operations: a
  // write at another version is refused as stale, a record that is not there
  // is not found, and a key already used replays. `sent` lists every write.
  function recordsHost(records: Record<string, { version: number; values: Record<string, JsonValue> }>, options: { rules?: DatasetDefinition; grants?: ReachDatasetGrants } = {}) {
    const receipts = new Map<string, DatasetInvocationResult>();
    const writes: Array<Record<string, JsonValue>> = [];
    const sent: DatasetInvocation[] = [];
    const invokeAsOwner = async (invocation: DatasetInvocation): Promise<DatasetInvocationResult> => {
      const { operationId, input, idempotencyKey } = invocation;
      if (operationId === READ) {
        const wanted = String((input as { after: { value: string } }).after.value);
        const found = records[wanted];
        return { result: { rows: found === undefined ? [] : [{ id: wanted, ...structuredClone(found) }], nextCursor: null }, revision: 9, replayed: false };
      }
      sent.push(invocation);
      const replay = receipts.get(idempotencyKey);
      if (replay) return { ...replay, replayed: true };
      const change = input as { id: string; expectedVersion: number; values?: Record<string, JsonValue> };
      const record = records[change.id];
      if (record === undefined) throw new AppBackendRuntimeError({ code: "not_found", message: "gone" });
      if (change.expectedVersion !== record.version) throw new AppBackendRuntimeError({ code: "stale_record", message: "stale" });
      let answer: DatasetInvocationResult;
      if (operationId === REMOVE || operationId === ARCHIVE) {
        delete records[change.id];
        answer = { result: { id: change.id, version: change.expectedVersion, deleted: true }, revision: 9, replayed: false };
      } else {
        Object.assign(record.values, change.values);
        record.version += 1;
        writes.push(change.values!);
        answer = { result: { id: change.id, version: record.version, priorValues: {} }, revision: 9, replayed: false };
      }
      receipts.set(idempotencyKey, answer);
      return answer;
    };
    const rulesNow = revisionOf(options.rules ?? definition);
    return { writes, sent, host: { invokeAsOwner, revision: () => rulesNow, resolves: () => true, dataGrants: () => options.grants ?? NO_GRANTS } };
  }
  const edit = (operationId: string, recordId: string, fieldId: string, before: string, after: string, version: number, expectedVersion = version - 1): RunWrite =>
    ({ kind: "dataset-edit", rules, operationId, tableId: TABLE, recordId, expectedVersion, version, fields: [{ fieldId, field: "Field", before, after }] });
  const created = (recordId: string, deletes: string[] = [REMOVE], tableId = TABLE): RunWrite =>
    ({ kind: "dataset-created", rules, operationId: CREATE, tableId, recordId, version: 1, deletes });
  const runOf = (keySeed: string, startedAtMs: number, writes: RunWrite[]): StoredRun => ({ ...run(EDIT), keySeed, startedAtMs, applied: [{ ordinal: 0, writes }] });
  // The executor's order: the reverses and deletes of the confirmed preview are saved with the newest run before any is sent.
  const confirm = async (host: DatasetUndoHost, runs: StoredRun[], reach = alone, chosen: Array<{ key: string; operationId: string }> = []) => {
    const calls = (await planDatasetUndo(host, reach, "claim", runs, runs, new AbortController().signal)).send(chosen);
    if (calls !== null) runs.at(-1)!.undoCalls.push(...calls);
    return calls;
  };

  it("keeps a field someone changed after the runs' last write to it, even where it matches an earlier write", async () => {
    // The runs wrote Open → Paid → Closed. Someone then set it back to Paid.
    const records = { a: { version: 4, values: { [STATUS]: "Paid" } } };
    const { writes, host } = recordsHost(records);
    const runs = [runOf("h-1", 1, [edit(EDIT, "a", STATUS, "Open", "Paid", 2)]), runOf("h-2", 2, [edit(EDIT, "a", STATUS, "Paid", "Closed", 3)])];
    const { undone, keptFields } = await undoDatasetAutomationRuns(host, collection, async () => OWNER, "claim", runs, async () => undefined, new AbortController().signal);
    expect(undone).toEqual({ ...none, changedSince: 1 });
    // Named with its dataset and table, so another dataset's field with the same ids is another field.
    expect(keptFields).toEqual([{ recordId: JSON.stringify([rules.datasetId, TABLE, "a"]), field: STATUS }]);
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

  it("deletes a record a run added through the one delete that qualifies, at the version it left, and sends it again under the same key", async () => {
    const records = { b: { version: 1, values: { [STATUS]: "Open" } } };
    const { host, sent } = recordsHost(records);
    const runs = [runOf("h-1", 1, [created("b")])];
    expect(await preview(host, runs)).toEqual(shown({ deletes: 1 }));
    const deletes = await confirm(host, runs);
    expect(deletes).toEqual([{ kind: "delete", rules, tableId: TABLE, recordId: "b", operationId: REMOVE, expectedVersion: 1, idempotencyKey: expect.stringMatching(/^u\.[0-9a-f]{64}$/) }]);
    expect(await undo(host, runs)).toEqual({ ...none, deleted: 1 });
    expect(records).toEqual({});
    expect(sent).toEqual([expect.objectContaining({ operationId: REMOVE, input: { id: "b", expectedVersion: 1 }, idempotencyKey: deletes![0]!.idempotencyKey })]);
    // dohc stopped after the delete committed and before the Undo was saved done: the same request replays its receipt.
    expect(await undo(host, runs)).toEqual({ ...none, deleted: 1 });
    const { signal: _first, ...first } = sent[0]!, { signal: _second, ...second } = sent[1]!;
    expect(second).toEqual(first);
  });

  it("deletes an added record a later step edited at the version the edit left, and puts none of its fields back", async () => {
    const records = { b: { version: 2, values: { [STATUS]: "Closed" } } };
    const { host, sent, writes } = recordsHost(records);
    const runs = [runOf("h-1", 1, [created("b")]), runOf("h-2", 2, [edit(EDIT, "b", STATUS, "Open", "Closed", 2, 1)])];
    expect(await preview(host, runs)).toMatchObject({ deletes: 1, reverts: 0 });
    await confirm(host, runs);
    expect(await undo(host, runs)).toEqual({ ...none, deleted: 1 });
    expect(sent.map((invocation) => invocation.input)).toEqual([{ id: "b", expectedVersion: 2 }]);
    expect(writes).toEqual([]);
  });

  it("keeps an added record someone changed between two of the runs' writes, and puts back the fields it still can", async () => {
    // Someone wrote the record at version 2; the run's edit then read it and wrote at version 2.
    const records = { b: { version: 3, values: { [STATUS]: "Closed" } } };
    const { host, sent } = recordsHost(records);
    const runs = [runOf("h-1", 1, [created("b"), edit(EDIT, "b", STATUS, "Open", "Closed", 3, 2)])];
    expect(await preview(host, runs)).toMatchObject({ deletes: 0, keptChanged: 1, reverts: 1 });
    expect(await confirm(host, runs)).toEqual([]);
    expect(await undo(host, runs)).toEqual({ ...none, keptChanged: 1, reverted: 1 });
    expect(records.b.values[STATUS]).toBe("Open");
    expect(sent.every((invocation) => invocation.operationId !== REMOVE)).toBe(true);
  });

  it("keeps an added record someone changed after the runs' last write, saying so before and after, and never deletes it at its new version", async () => {
    const records = { b: { version: 1, values: { [STATUS]: "Open" } } };
    const { host, sent } = recordsHost(records);
    const runs = [runOf("h-1", 1, [created("b")])];
    // Someone changes it before the preview: the preview says it stays.
    records.b = { version: 2, values: { [STATUS]: "Theirs" } };
    expect(await preview(host, runs)).toEqual(shown({ keptChanged: 1 }));
    expect(await confirm(host, runs)).toEqual([]);
    expect(await undo(host, runs)).toEqual({ ...none, keptChanged: 1 });
    // Someone changes it after the person confirmed: the saved delete is refused as stale.
    records.b = { version: 1, values: { [STATUS]: "Open" } };
    const later = [runOf("h-1", 1, [created("b")])];
    await confirm(host, later);
    records.b = { version: 2, values: { [STATUS]: "Theirs" } };
    expect(await undo(host, later)).toEqual({ ...none, keptChanged: 1 });
    expect(records.b).toEqual({ version: 2, values: { [STATUS]: "Theirs" } });
    expect(sent.filter((invocation) => invocation.operationId === REMOVE)).toHaveLength(1);
  });

  it("counts an added record already gone apart from one it deleted, before and after", async () => {
    const records: Record<string, { version: number; values: Record<string, JsonValue> }> = { b: { version: 1, values: {} } };
    const { host } = recordsHost(records);
    const runs = [runOf("h-1", 1, [created("b")])];
    await confirm(host, runs);
    delete records.b;
    expect(await undo(host, runs)).toEqual({ ...none, gone: 1 });
    expect(await preview(host, [runOf("h-1", 1, [created("b")])])).toEqual(shown({ gone: 1 }));
  });

  it("promises no delete it could not check when the table has no read, and still keeps a record someone changed", async () => {
    const records = { b: { version: 1, values: {} }, c: { version: 1, values: {} } };
    const noRead: DatasetDefinition = { ...definition, operations: definition.operations.filter((operation) => operation.kind !== "read") };
    const { host, sent } = recordsHost(records, { rules: noRead });
    const runs = [runOf("h-1", 1, [created("b"), created("c")])];
    expect(await preview(host, runs)).toEqual(shown({ unchecked: 2 }));
    expect(await confirm(host, runs)).toHaveLength(2);
    // Someone changes c after the preview: its delete is refused as stale and it stays.
    records.c.version = 2;
    expect(await undo(host, runs)).toEqual({ ...none, deleted: 1, keptChanged: 1 });
    expect(Object.keys(records)).toEqual(["c"]);
    expect(sent.map((invocation) => invocation.operationId)).toEqual([REMOVE, REMOVE]);
  });

  it("keeps an added record when its table has no delete, when its plan recorded none, or when the delete is another table's", async () => {
    const records = { b: { version: 1, values: {} }, c: { version: 1, values: {} }, d: { version: 1, values: {} } };
    const noDelete: DatasetDefinition = { ...definition, operations: definition.operations.filter((operation) => operation.kind !== "delete") };
    const bare = recordsHost(records, { rules: noDelete });
    expect(datasetUndoDeletes(OWNER, collection, noDelete, TABLE, NO_GRANTS)).toEqual([]);
    const runs = [runOf("h-1", 1, [created("b"), created("c", []), created("d", [OTHER_REMOVE])])];
    expect(await preview(bare.host, runs)).toMatchObject({ deletes: 0, kept: 3 });
    expect(await confirm(bare.host, runs)).toEqual([]);
    expect(await undo(bare.host, runs)).toEqual({ ...none, kept: 3 });
    // Rules with deletes: only the record whose plan recorded this table's delete goes.
    const { host } = recordsHost(records);
    const again = [runOf("h-1", 1, [created("b"), created("c", []), created("d", [OTHER_REMOVE])])];
    expect(await preview(host, again)).toMatchObject({ deletes: 1, kept: 2 });
    await confirm(host, again);
    expect(await undo(host, again)).toEqual({ ...none, deleted: 1, kept: 2 });
    expect(Object.keys(records)).toEqual(["c", "d"]);
  });

  it("uses a delete only while every editor of the automation can, and checks again before each saved delete it sends", async () => {
    const records = { b: { version: 1, values: {} }, c: { version: 1, values: {} } };
    // Ana edits the automation and holds no grant to delete.
    const denied = recordsHost(records);
    const runs = [runOf("h-1", 1, [created("b"), created("c")])];
    expect(await preview(denied.host, runs, withAna)).toMatchObject({ deletes: 0, kept: 2 });
    expect(await confirm(denied.host, runs, withAna)).toEqual([]);
    // With her grant, both deletes qualify and are saved. Then she gains Edit
    // on the Collection again, as someone new, while the first delete is sent.
    const granted = recordsHost(records, { grants: anaMayDelete });
    expect(await confirm(granted.host, runs, withAna)).toHaveLength(2);
    let reads = 0;
    const bob = { ...ANA, grantId: "grant-bob", recipientUserId: "user-bob", recipientEmail: "bob@example.com" };
    expect(await undo(granted.host, runs, () => (reads++ === 0 ? withAna : { roster: { ...OWNER, grants: [ANA, bob] }, collection }))).toEqual({ ...none, deleted: 1, kept: 1 });
    expect(Object.keys(records)).toEqual(["c"]);
    // No roster: every delete stops.
    const unknown: DatasetUndoReach = { roster: { kind: "unknown", problem: { kind: "unusable-listing" } }, collection };
    expect(datasetUndoDeletes(unknown.roster, collection, definition, TABLE, anaMayDelete)).toEqual([]);
  });

  it("asks the person to choose where several deletes qualify, and sends only the one they chose", async () => {
    const records = { b: { version: 1, values: {} }, c: { version: 1, values: {} } };
    const { host, sent } = recordsHost(records, { rules: twoDeletes });
    const runs = [runOf("h-1", 1, [created("b", [REMOVE, ARCHIVE]), created("c", [REMOVE, ARCHIVE])])];
    const key = JSON.stringify([definition.datasetId, TABLE, ...[REMOVE, ARCHIVE].sort()]);
    expect(await preview(host, runs)).toEqual(shown({
      deletes: 2,
      choices: [{ key, table: "Invoices", records: 2, operations: [{ operationId: REMOVE, label: "Delete invoice" }, { operationId: ARCHIVE, label: "Archive invoice" }] }],
    }));
    expect(await confirm(host, runs)).toBeNull();
    expect(await confirm(host, runs, alone, [{ key, operationId: EDIT }])).toBeNull();
    expect(await confirm(host, runs, alone, [{ key, operationId: ARCHIVE }])).toHaveLength(2);
    expect(await undo(host, runs)).toEqual({ ...none, deleted: 2 });
    expect(sent.map((invocation) => invocation.operationId)).toEqual([ARCHIVE, ARCHIVE]);
  });

  it("asks once for each set of deletes when a table's records recorded different ones", async () => {
    const records = { b: { version: 1, values: {} }, c: { version: 1, values: {} } };
    const { host } = recordsHost(records, { rules: twoDeletes });
    const runs = [runOf("h-1", 1, [created("b", [REMOVE, ARCHIVE])]), runOf("h-2", 2, [created("c", [REMOVE])])];
    const shownNow = await preview(host, runs);
    expect(shownNow.choices).toEqual([expect.objectContaining({ records: 1 })]);
    expect(await confirm(host, runs, alone, [{ key: shownNow.choices[0]!.key, operationId: ARCHIVE }])).toEqual([
      expect.objectContaining({ recordId: "b", operationId: ARCHIVE }), expect.objectContaining({ recordId: "c", operationId: REMOVE }),
    ]);
  });

  it("names what it previews, so a confirmation of an older preview can be told apart", async () => {
    const records = { b: { version: 1, values: {} } };
    const runs = [runOf("h-1", 1, [created("b")])];
    const before = await preview(recordsHost(records).host, runs, withAna);
    const after = await preview(recordsHost(records, { grants: anaMayDelete }).host, runs, withAna);
    expect(before).toMatchObject({ deletes: 0, kept: 1 });
    expect(after).toMatchObject({ deletes: 1, kept: 0 });
    expect(after.token).not.toBe(before.token);
    expect((await preview(recordsHost(records).host, runs, withAna)).token).toBe(before.token);
  });

  it("puts edits back and keeps a record no delete was recorded for, without asking who can edit", async () => {
    const records = { a: { version: 2, values: { [STATUS]: "Closed" } }, b: { version: 1, values: {} } };
    const { host } = recordsHost(records);
    const unknown = () => { throw new Error("dohc could not check who can edit Budget."); };
    expect(await undo(host, [run(EDIT)], unknown)).toEqual({ ...none, reverted: 1, kept: 1 });
    expect(records.a.values[STATUS]).toBe("Open");
  });

  it("stops on a refusal it cannot read as stale or gone, so the Undo can be tried again", async () => {
    const host = {
      invokeAsOwner: async (): Promise<DatasetInvocationResult> => { throw new AppBackendRuntimeError({ code: "not_authorized", message: "You cannot delete invoices." }); },
      revision: () => revision, resolves: () => true, dataGrants: () => NO_GRANTS,
    };
    const runs = [runOf("h-1", 1, [created("b")])];
    runs[0]!.undoCalls.push({ kind: "delete", rules, tableId: TABLE, recordId: "b", operationId: REMOVE, expectedVersion: 1, idempotencyKey: "u.1" });
    await expect(undo(host, runs)).rejects.toThrow("You cannot delete invoices.");
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
  // As the executor does it: the reverses are saved once, before any is sent, then Undo sends what was saved.
  const undoActions = async (host: DatasetUndoHost, runs: StoredRun[]) => {
    if (runs.every((stored) => stored.undoCalls.length === 0)) {
      runs.at(-1)!.undoCalls.push(...(await planDatasetUndo(host, alone, "claim", runs, runs, new AbortController().signal)).send([])!);
    }
    return await undo(host, runs);
  };

  it("reverses the newest commit first even when a later run's clock read earlier, and keeps each reverse's key", async () => {
    const sent: DatasetInvocation[] = [];
    const host: DatasetUndoHost = {
      invokeAsOwner: async (input) => { sent.push(input); return { result: { ok: true }, revision: 30, replayed: false }; },
      revision: () => ({ ...revision, definition: withActions }),
      resolves: () => true,
      dataGrants: () => NO_GRANTS,
    };
    // The start-over run began at an earlier clock reading, but committed revision 11 after the first run's 10.
    const runs = [runOf(5, [action(HOLD, "Hold", 10, { id: "a", status: "Open" })]), runOf(1, [action(HOLD, "Hold", 11, { id: "b", status: "Open" }), action(SETTLE, "Settle", 12)])];
    expect(await undoActions(host, runs)).toMatchObject({ actionsReversed: 2, actions: 1 });
    expect(sent.map((input) => input.input)).toEqual([{ id: "b", status: "Open" }, { id: "a", status: "Open" }]);
    expect(sent.every((input) => input.operationId === RELEASE)).toBe(true);
    const keys = sent.map((input) => input.idempotencyKey);
    sent.length = 0;
    await undoActions(host, runs);
    expect(sent.map((input) => input.idempotencyKey)).toEqual(keys);
  });

  it("stops at the first reverse the dataset refuses, and refuses to start once any action's rules no longer resolve", async () => {
    const sent: DatasetInvocation[] = [];
    const host: DatasetUndoHost = {
      invokeAsOwner: async (input) => { sent.push(input); throw new AppBackendRuntimeError({ code: "changed", message: "This invoice is no longer on hold." }); },
      revision: () => ({ ...revision, definition: withActions }),
      resolves: () => true,
      dataGrants: () => NO_GRANTS,
    };
    const runs = [runOf(1, [action(HOLD, "Hold", 10, { id: "a" }), action(HOLD, "Hold", 11, { id: "b" })])];
    await expect(undoActions(host, runs)).rejects.toThrow("Hold was not undone. Release refused: This invoice is no longer on hold.");
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
      dataGrants: () => NO_GRANTS,
    };
    const runs = [runOf(1, [action(HOLD, "Hold", 10, { id: "a" })])];
    expect(datasetUndoRulesChanged(host, runs)).toBe(true);
    await expect(undoActions(host, runs)).rejects.toThrow("Collection rules changed after this run, so dohc cannot undo it.");
    expect(sent).toEqual([]);
    expect(datasetUndoRulesChanged({ ...host, revision: () => ({ ...revision, definition: withActions }) }, runs)).toBe(false);
  });

  it("plans only the runs this Undo has not finished, so runs an earlier Undo finished alone keep their own calls", async () => {
    const records: Record<string, { version: number; values: Record<string, JsonValue> }> = { b: { version: 1, values: {} }, c: { version: 1, values: {} } };
    const host: DatasetUndoHost = {
      invokeAsOwner: async (input): Promise<DatasetInvocationResult> => {
        if (input.operationId === READ) {
          const wanted = String((input.input as { after: { value: string } }).after.value);
          const found = records[wanted];
          return { result: { rows: found === undefined ? [] : [{ id: wanted, ...found }], nextCursor: null }, revision: 30, replayed: false };
        }
        return { result: { ok: true }, revision: 30, replayed: false };
      },
      revision: () => ({ ...revision, definition: withActions }),
      resolves: () => true,
      dataGrants: () => NO_GRANTS,
    };
    const created = (recordId: string): RunWrite => ({ kind: "dataset-created", rules, operationId: CREATE, tableId: TABLE, recordId, version: 1, deletes: [REMOVE] });
    // Stop and restore undid the newer run alone, and saved its own calls.
    const older = runOf(1, [action(HOLD, "Hold", 10, { id: "a" }), created("b")]);
    const newer = { ...runOf(2, [action(HOLD, "Hold", 11, { id: "x" }), created("c")]), undo: "done" as const };
    const planned = await planDatasetUndo(host, alone, "claim", [older, newer], [older], new AbortController().signal);
    expect(planned.preview).toEqual(shown({ reverses: 1, deletes: 1 }));
    expect(planned.send([])).toEqual([
      expect.objectContaining({ kind: "reverse", revision: 10 }),
      expect.objectContaining({ kind: "delete", recordId: "b" }),
    ]);
  });

  it("leaves a saved reverse for a run this Undo leaves out, and sends the rest", async () => {
    const sent: DatasetInvocation[] = [];
    const host: DatasetUndoHost = {
      invokeAsOwner: async (input) => { sent.push(input); return { result: { ok: true }, revision: 30, replayed: false }; },
      revision: () => ({ ...revision, definition: withActions }),
      resolves: () => true,
      dataGrants: () => NO_GRANTS,
    };
    // A full Undo saved both runs' reverses with the newer run, then stopped.
    const older = runOf(1, [action(HOLD, "Hold", 10, { id: "a" })]);
    const newer = runOf(2, [action(HOLD, "Hold", 11, { id: "b" })]);
    newer.undoCalls.push(...(await planDatasetUndo(host, alone, "claim", [older, newer], [older, newer], new AbortController().signal)).send([])!);
    // Stop and restore undoes only the newer run: the older run's reverse waits.
    expect(await undo(host, [newer])).toEqual({ ...none, actionsReversed: 1 });
    expect(sent.map((input) => input.input)).toEqual([{ id: "b" }]);
  });

  it("names the action whose run is gone when a saved reverse has no run left", async () => {
    const host: DatasetUndoHost = {
      invokeAsOwner: async () => ({ result: { ok: true }, revision: 30, replayed: false }),
      revision: () => ({ ...revision, definition: withActions }),
      resolves: () => true,
      dataGrants: () => NO_GRANTS,
    };
    const older = runOf(1, [action(HOLD, "Hold", 10, { id: "a" })]);
    const newer = runOf(2, [action(HOLD, "Hold", 11, { id: "b" })]);
    newer.undoCalls.push(...(await planDatasetUndo(host, alone, "claim", [older, newer], [older, newer], new AbortController().signal)).send([])!);
    expect(datasetUndoLostRun(host, [older, newer])).toBeNull();
    // Run history dropped the older run.
    expect(datasetUndoLostRun(host, [newer])).toBe("dohc no longer has the run that ran Hold, so it cannot finish this Undo. Undo what Hold changed by hand.");
  });

  it("previews the actions it reverses and those that stay, saves every reverse before the first, and sends only what it saved", async () => {
    const sent: DatasetInvocation[] = [];
    const host: DatasetUndoHost = {
      invokeAsOwner: async (input) => { sent.push(input); return { result: { ok: true }, revision: 30, replayed: false }; },
      revision: () => ({ ...revision, definition: withActions }),
      resolves: () => true,
      dataGrants: () => NO_GRANTS,
    };
    const runs = [runOf(1, [action(HOLD, "Hold", 10, { id: "a" }), action(SETTLE, "Settle", 11), action(HOLD, "Hold", 12, { id: "b" })])];
    const planned = await planDatasetUndo(host, alone, "claim", runs, runs, new AbortController().signal);
    expect(planned.preview).toEqual(shown({ reverses: 2, actions: 1 }));
    const calls = planned.send([])!;
    expect(calls.map((call) => call.kind === "reverse" && call.revision)).toEqual([12, 10]);
    // Saved with a different input than the run recorded: Undo sends exactly what it saved.
    runs[0]!.undoCalls.push({ ...calls[0]!, input: { id: "saved" } } as typeof calls[number], calls[1]!);
    expect(await undo(host, runs)).toEqual({ ...none, actions: 1, actionsReversed: 2 });
    expect(sent.map((input) => [input.input, input.idempotencyKey])).toEqual([[{ id: "saved" }, calls[0]!.idempotencyKey], [{ id: "a" }, calls[1]!.idempotencyKey]]);
  });
});
