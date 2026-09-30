import { afterAll, describe, expect, it } from "vitest";
import { isDeepStrictEqual } from "node:util";
import { AppBackendRuntimeError } from "@dohc/app-backend-runtime";
import type { JsonValue } from "@dohc/app-backend-runtime/automation";
import type { DatasetInvocationResult } from "@dohc/app-backend-runtime/supervisor";
import type { DatasetDefinition, DatasetRevision } from "@dohc/security-contract/dataset";
import { parseAutomationsFile, type Automation } from "@dohc/workspace-contracts/automations";
import type { CollectionRecord } from "@dohc/workspace-contracts/collection";
import { createAutomationFormulaEvaluator } from "./automationEvaluatorHost";
import { createAutomationRunStore } from "./automationRunStore";
import { type CollectionAutomationReads, type CollectionRecordWrites, RECORD_NOT_FOUND } from "./collectionAutomationRun";
import { type DatasetInvocation, type DatasetRunHost } from "./datasetAutomationRun";
import { runCollectionAutomation, type CollectionAutomationRunDependencies } from "./collectionAutomationRun";
import { runDatasetAutomation, type DatasetRunClaim, type DatasetAutomationRunDependencies } from "./datasetAutomationRun";
import type { AutomationClaim } from "@dohc/workspace-engine-client";
import { undoAutomationRuns, automationUndoReach } from "./automationUndo";
import { planDatasetUndo, type DatasetUndoHost } from "./datasetAutomationUndo";
import { createTestScratch, testMetadataDir } from "./testScratch";
import { datasetPrincipalKey } from "@dohc/security-contract/dataset-artifacts";
import type { ReachRoster } from "./automationReach";
import type { AutomationTarget } from "./automationTargets";
import { chatDirectoryOf } from "./automationChat";
import { automationInventory } from "./automationInventory";
import { definitionHash, reachStepsOf, chatReachStepsOf } from "./automationPlan";
import { reachStepId } from "./automationReach";
import { nextReachVerdict, reachVerdictKey, type StoredReachVerdict } from "./reachVerdicts";

const evaluator = createAutomationFormulaEvaluator();
afterAll(async () => { await evaluator.close(); });
const roster = { kind: "owner" as const, ownerUserId: null, grants: [] };
const signal = new AbortController().signal;
type Row = { id: string | number; version: number; values: Record<string, JsonValue> };
function definition(path: string): DatasetRevision {
  const datasetId = path + "-dataset";
  const definition: DatasetDefinition = { formatVersion: 1, datasetId, name: path, schemaPath: path + "/schema.sql", operationsPath: path + "/operations.js",
    tables: [{ tableId: "table", name: "Rows", sqlName: "rows", primaryKey: "id", fields: [
      { fieldId: "id", name: "ID", sqlColumn: "id", type: "text", required: true, unique: true },
      { fieldId: "status", name: "Status", sqlColumn: "status", type: "text", required: false, unique: false },
    ] }], operations: [
      { operationId: "read", name: "rows.read", label: "Read", tableId: "table", kind: "read", access: "owner", readOnly: true, fieldIds: ["id", "status"] },
      { operationId: "create", name: "rows.create", label: "Create", tableId: "table", kind: "create", access: "owner", readOnly: false, fieldIds: ["status"] },
      { operationId: "edit", name: "rows.edit", label: "Edit", tableId: "table", kind: "edit", access: "owner", readOnly: false, fieldIds: ["status"], reversible: true },
      { operationId: "delete", name: "rows.delete", label: "Delete", tableId: "table", kind: "delete", access: "owner", readOnly: false, fieldIds: [] },
    ] };
  return { datasetId, revision: 1, revisionSha256: "a".repeat(64), definitionSha256: "", schemaSha256: "", operationsSha256: "", definition };
}
function automation(source: string): Automation {
  const parsed = parseAutomationsFile("version: 1\nautomations:\n  - id: test\n    name: Test\n    when: record-added\n    do:\n" + source);
  if (parsed.status !== "read" || parsed.entries[0]?.status !== "valid") throw new Error(JSON.stringify(parsed));
  return parsed.entries[0].automation;
}
const find = (path: string, dataset: boolean, as = "found") => '      - find: record.Status == "Open"\n        collection: ' + path + '\n        as: ' + as + '\n' + (dataset ? '        operation: rows.read\n' : '');
const add = (path: string, dataset: boolean, as = "added") => '      - add-record:\n          Status: Open\n        collection: ' + path + '\n        as: ' + as + '\n' + (dataset ? '        operation: rows.create\n' : '');
const set = (dataset: boolean, records: string, value = "Closed") => '      - set:\n          Status: ' + value + '\n        records: ' + records + '\n' + (dataset ? '        operation: rows.edit\n' : '');

async function fixture(sourceDataset = false, targetDataset = true) {
  const scratch = await createTestScratch("static-automation-");
  const store = createAutomationRunStore(scratch, testMetadataDir);
  let currentRoster: Exclude<ReachRoster, { kind: "unknown" }> = roster;
  const targets = new Map<string, AutomationTarget>();
  const rows = new Map<string, Map<string | number, Row>>();
  const docs = new Map<string, { path: string; id: string; collection: string; status: JsonValue }>();
  const collectionIds = new Map<string, string>();
  const receipts = new Map<string, { payload: string; result: DatasetInvocationResult }>();
  const calls: DatasetInvocation[] = [];
  const keys = new Set<string>();
  const hooks: {
    hideDatasetLocations?: boolean; beforeRead?: () => void; afterEffect?: () => void;
    beforeEffect?: () => void; hostDown: boolean; crashAppend: boolean;
  } = { hostDown: false, crashAppend: false };
  for (const [path, dataset] of [["Source", sourceDataset], ["Target", targetDataset], ["Other", true]] as const) {
    collectionIds.set(path, dataset ? path + "-dataset" : path);
    if (dataset) {
      const approved = definition(path);
      targets.set(path, { kind: "dataset", collection: { path, name: path }, approved, generated: true, grants: { workspaceId: "workspace", grants: [] } });
      rows.set(approved.datasetId, new Map([["same", { id: "same", version: 1, values: { id: "same", status: "Open" } }]]));
    } else {
      targets.set(path, { kind: "document", collection: { path, name: path }, fields: new Set(["Status"]) });
      docs.set(path + "/same", { path: path + "/same.md", id: path + "-same", collection: path, status: "Open" });
    }
  }
  const record = (doc: { path: string; id: string; status: JsonValue }): CollectionRecord => ({ id: doc.id, path: doc.path, conflicted: false,
    values: [{ field: "Status", value: doc.status as string, validation: { status: "untyped" }, resolvedRelations: [] }] });
  const reads: CollectionAutomationReads = {
    async getCollectionRecord({ collectionPath, recordId }) {
      const doc = [...docs.values()].find((doc) => doc.collection === collectionPath && doc.id === recordId);
      if (!doc) throw new Error(RECORD_NOT_FOUND);
      return { collection: { objectId: collectionPath, path: collectionPath, status: "valid", reasons: [] }, record: record(doc), history: [], nextBeforeHistoryId: null };
    },
    async queryCollectionRecords({ collectionPath, filter }) {
      const found = [...docs.values()].filter((doc) => doc.collection === collectionPath && (!filter || isDeepStrictEqual(filter.value, doc.status)));
      return { collection: { objectId: collectionPath, path: collectionPath, status: "valid", reasons: [] }, records: found.map(record), groups: null, nextCursor: null };
    },
  };
  const writes: CollectionRecordWrites = {
    async create({ collectionPath, recordId, name }) {
      const key = collectionPath + "/" + recordId;
      if (!docs.has(key)) docs.set(key, { id: recordId, path: collectionPath + "/" + name + ".md", collection: collectionPath, status: null });
      return { recordId, path: docs.get(key)!.path };
    },
    async setFields({ recordPath, fields, expectedBefore, idempotencyKeyPrefix }) {
      hooks.beforeEffect?.();
      const doc = [...docs.values()].find((doc) => doc.path === recordPath)!;
      const key = idempotencyKeyPrefix + "/Status";
      if (idempotencyKeyPrefix && keys.has(key)) return { replaced: {}, kept: {} };
      if (expectedBefore && !isDeepStrictEqual(doc.status, expectedBefore.Status)) return { replaced: {}, kept: { Status: doc.status } };
      if (idempotencyKeyPrefix) keys.add(key);
      const before = doc.status;
      doc.status = fields.Status as JsonValue;
      hooks.afterEffect?.();
      return { replaced: isDeepStrictEqual(before, doc.status) ? {} : { Status: before }, kept: {} };
    },
  };
  const invoke = async (request: DatasetInvocation, caller: unknown = { kind: "owner" }): Promise<DatasetInvocationResult> => {
    calls.push(structuredClone({ ...request, signal: undefined }));
    const key = JSON.stringify([request.datasetId, caller, request.idempotencyKey]);
    const payload = JSON.stringify([request.revision, request.revisionSha256, request.operationId, request.input]);
    const saved = receipts.get(key);
    if (saved !== undefined) {
      if (saved.payload !== payload) throw new Error("A receipt key was reused with another payload.");
      return { ...saved.result, replayed: true };
    }
    const own = rows.get(request.datasetId)!;
    const input = request.input;
    if (input === null || typeof input !== "object" || Array.isArray(input)) throw new Error("input");
    if (request.operationId === "read") {
      hooks.beforeRead?.();
      const filters = Array.isArray(input.filters) ? input.filters : [];
      const found = [...own.values()].filter((row) => filters.every((filter) => filter !== null && typeof filter === "object" && !Array.isArray(filter) && isDeepStrictEqual(row.values[String(filter.fieldId)], filter.value)));
      return { result: { rows: structuredClone(found), nextCursor: null }, revision: 1, replayed: false };
    }
    hooks.beforeEffect?.();
    let result: JsonValue;
    if (request.operationId === "create") {
      const id = "new-" + own.size;
      const values = input.values as Record<string, JsonValue>;
      own.set(id, { id, version: 1, values: { id, ...values } });
      result = { id, version: 1 };
    } else {
      const row = own.get(input.id as string | number);
      if (!row) throw new AppBackendRuntimeError({ code: "not_found", message: "Gone" });
      if (row.version !== input.expectedVersion) throw new AppBackendRuntimeError({ code: "stale_record", message: "Changed" });
      if (request.operationId === "delete") { own.delete(row.id); result = { id: row.id }; }
      else {
        const priorValues = structuredClone(row.values);
        Object.assign(row.values, input.values);
        row.version += 1;
        result = { id: row.id, version: row.version, priorValues };
      }
    }
    const receipt = { result, revision: 2, replayed: false };
    receipts.set(key, { payload, result: receipt });
    hooks.afterEffect?.();
    return receipt;
  };
  const host: DatasetRunHost & DatasetUndoHost = {
    context: (input) => input, invoke: async (context, input) => invoke(input, context), invokeAsOwner: invoke,
    revision: (id) => { const target = [...targets.values()].find((target) => target.kind === "dataset" && target.approved.datasetId === id); if (target?.kind !== "dataset") throw new Error("missing"); return target.approved; },
    generated: () => true, resolves: (rules) => [...targets.values()].some((target) =>
      target.kind === "dataset" && target.approved.datasetId === rules.datasetId && target.approved.revisionSha256 === rules.revisionSha256),
    dataGrants: (id) => { const target = [...targets.values()].find((target) => target.kind === "dataset" && target.approved.datasetId === id); if (target?.kind !== "dataset") throw new Error("missing"); return target.grants; },
  };
  const dependencies: CollectionAutomationRunDependencies & DatasetAutomationRunDependencies = {
    collectionIdOf: (path) => collectionIds.get(path) ?? null,
    collectionPathOf: (id) => hooks.hideDatasetLocations && id.endsWith("-dataset") ? null : [...collectionIds].find(([, known]) => known === id)?.[0] ?? null,
    targets: { resolve: async (path) => hooks.hostDown && targets.get(path)?.kind === "dataset" ? { kind: "problem", code: "host-unavailable", problem: "Unavailable" } : targets.get(path) ?? { kind: "problem", code: "missing", problem: "Missing" } },
    withReads: async (work) => work(reads), withRecordWrites: async (_signal, work) => work(writes),
    withHost: async (work) => hooks.hostDown ? null : work(host), cachedRoster: async () => currentRoster, checkReach: async () => false,
    evaluator: evaluator.forWorkspace("workspace"), store: { ...store, appendEffect: async (run, applied) => { if (hooks.crashAppend) { hooks.crashAppend = false; throw new Error("crash before journal append"); } await store.appendEffect(run, applied); } },
    nowMs: () => 1000, personName: (id) => id, readCode: async () => null, readMessageBody: async () => null,
    chat: { directory: async () => null, write: async () => {} }, postNotice: async () => {}, recipientVerdicts: async () => [],
  };
  const claim = { automationId: sourceDataset ? "collection:Source-dataset#test" : "collection:Source#test", claimId: "claim", createdAtMs: 1000, run: 1, depth: 0 };
  const held: DatasetRunClaim | { source: "document"; claim: AutomationClaim } = sourceDataset ? { source: "dataset", claim: { ...claim, workspaceId: "workspace", datasetId: "Source-dataset", hostEpoch: "epoch", revision: 1,
    fact: { kind: "added", datasetId: "Source-dataset", tableId: "table", recordId: "same", version: 1, fields: [] }, actor: { kind: "owner" }, state: "running", attempts: 1, error: null, updatedAtMs: 1000 } }
    : { source: "document", claim: { ...claim, collectionPath: "Source", recordId: "Source-same", state: "running", attempts: 1, updatedAtMs: 1000, trigger: { historyId: 1 },
      change: { kind: "added", authorOriginId: null, actorKind: "human", onBehalfOf: null, sharedAuthor: null, liveCursor: null, fields: [], fieldsOmitted: 0 } } };
  const run = (automation: Automation) => {
    const input = { automation, collection: { path: "Source", name: "Source" }, roster: currentRoster, signal, stopped: signal };
    return held.source === "document" ? runCollectionAutomation(dependencies, { ...input, claim: held.claim })
      : runDatasetAutomation(dependencies, { ...input, held });
  };
  const runs = async () => (await store.runsOf(claim.automationId, claim.claimId)).runs;
  const undo = async () => {
    const restored = await runs();
    const planned = await planDatasetUndo(host, { roster: currentRoster, collection: { path: "Source", name: "Source" } }, claim.claimId, restored, restored, signal);
    const holder = restored.at(-1)!;
    holder.undoCalls.push(...planned.send([])!);
    return undoAutomationRuns({
      collectionPathOf: dependencies.collectionPathOf, withReads: dependencies.withReads, withRecordWrites: dependencies.withRecordWrites,
      trash: async (path) => { for (const [key, doc] of docs) if (doc.path === path) docs.delete(key); } }, host, { path: "Source", name: "Source" }, async () => currentRoster, claim.claimId, restored,
      async (request) => { const run = restored.at(-1)!; await store.recordUndoRequest(run, request); run.undoRequests.push(request); }, signal);
  };
  const move = (from: string, to: string) => {
    const target = targets.get(from)!;
    targets.delete(from);
    targets.set(to, { ...target, collection: { path: to, name: to } });
    collectionIds.set(to, collectionIds.get(from)!);
    collectionIds.delete(from);
    if (target.kind === "dataset") { target.approved.definition.schemaPath = to + "/schema.sql"; target.approved.definition.operationsPath = to + "/operations.js"; }
    for (const doc of docs.values()) if (doc.collection === from) { doc.collection = to; doc.path = to + doc.path.slice(from.length); }
  };
  return { run, runs, undo, move, targets, rows, docs, hooks, host, calls, dependencies, held, setRoster: (roster: Exclude<ReachRoster, { kind: "unknown" }>) => { currentRoster = roster; } };
}

describe("static steps across storage kinds", () => {
  it.each([1, 2])("waits before reading when the source moves as read session %s opens", async (session) => {
    const f = await fixture(false, true);
    const withReads = f.dependencies.withReads;
    let opened = 0;
    f.dependencies.withReads = async (work) => withReads(async (reads) => {
      if (++opened !== session) return work(reads);
      f.move("Source", "Moved");
      return work({
        getCollectionRecord: async () => { throw new Error("Read the old Collection after it moved."); },
        queryCollectionRecords: async () => { throw new Error("Queried the old Collection after it moved."); },
      });
    });
    expect(await f.run(automation(find("Target", true) + set(true, "found"))))
      .toEqual({ kind: "wait", reason: "moved" });
    expect(f.calls).toEqual([]);
    expect(await f.runs()).toEqual([]);
  });
  it.each([[false, false], [false, true], [true, false], [true, true]])("Find then Set from dataset=%s to dataset=%s", async (source, target) => {
    const f = await fixture(source, target);
      expect(await f.run(automation(find("Target", target) + set(target, "found")))).toEqual({ kind: "done" });
      expect(target ? f.rows.get("Target-dataset")!.get("same")!.values.status : f.docs.get("Target/same")!.status).toBe("Closed");
      expect((await f.undo()).undone.reverted).toBe(1);
      expect(target ? f.rows.get("Target-dataset")!.get("same")!.values.status : f.docs.get("Target/same")!.status).toBe("Open");
  });
  it.each([[false, false], [false, true], [true, false], [true, true]])("Add then Set and Find from dataset=%s to dataset=%s", async (source, target) => {
    const f = await fixture(source, target);
      expect(await f.run(automation(add("Target", target) + set(target, "added") + find("Target", target, "remaining") + set(target, "remaining", "Found")))).toEqual({ kind: "done" });
      const statuses = target ? [...f.rows.get("Target-dataset")!.values()].map((row) => row.values.status) : [...f.docs.values()].filter((doc) => doc.collection === "Target").map((doc) => doc.status);
      expect(statuses.sort()).toEqual(["Closed", "Found"]);
      expect((await f.undo()).undone).toMatchObject(target ? { deleted: 1 } : { removed: 1 });
  });
  it("keeps the same typed ID in two datasets separate", async () => {
    const f = await fixture();
      expect(await f.run(automation(find("Target", true) + set(true, "found", "First") + find("Other", true, "other") + set(true, "other", "Second")))).toEqual({ kind: "done" });
      expect(f.rows.get("Target-dataset")!.get("same")!.values.status).toBe("First");
      expect(f.rows.get("Other-dataset")!.get("same")!.values.status).toBe("Second");
      expect((await f.undo()).undone.reverted).toBe(2);
  });
  it.each([false, true])("Undo restores the person's edit between steps on dataset=%s", async (target) => {
    const f = await fixture(!target, target);
    let effects = 0;
    f.hooks.afterEffect = () => { if (++effects !== 1) return; if (target) { const row = f.rows.get("Target-dataset")!.get("same")!; row.values.status = "Person"; row.version += 1; } else f.docs.get("Target/same")!.status = "Person"; };
      expect(await f.run(automation(find("Target", target) + set(target, "found", "First") + set(target, "found", "Last")))).toEqual({ kind: "done" });
      f.hooks.afterEffect = undefined;
      await f.undo();
      expect(target ? f.rows.get("Target-dataset")!.get("same")!.values.status : f.docs.get("Target/same")!.status).toBe("Person");
  });
  it.each([false, true])("keeps a stale edit on dataset=%s", async (target) => {
    const f = await fixture(!target, target);
    f.hooks.beforeEffect = () => { f.hooks.beforeEffect = undefined; if (target) { const row = f.rows.get("Target-dataset")!.get("same")!; row.values.status = "Person"; row.version += 1; } else f.docs.get("Target/same")!.status = "Person"; };
      expect(await f.run(automation(find("Target", target) + set(target, "found")))).toEqual({ kind: "done" });
      expect((await f.undo()).undone.reverted).toBe(0);
      expect(target ? f.rows.get("Target-dataset")!.get("same")!.values.status : f.docs.get("Target/same")!.status).toBe("Person");
  });
  it("recovers a mixed run after commit before journal append, then undoes both kinds", async () => {
    const f = await fixture();
    const a = automation(add("Target", true) + set(true, "added") + add("Source", false, "doc") + set(false, "doc"));
      f.hooks.crashAppend = true;
      await expect(f.run(a)).rejects.toThrow("crash before journal append");
      expect(await f.run(a)).toEqual({ kind: "done" });
      expect(f.rows.get("Target-dataset")!.size).toBe(2);
      expect((await f.undo()).undone).toMatchObject({ removed: 1, deleted: 1 });
      expect(f.rows.get("Target-dataset")!.size).toBe(1);
  });
  it("Undo accounts for an unrecorded Add without creating an uncommitted one", async () => {
    const f = await fixture();
      f.hooks.crashAppend = true;
      await expect(f.run(automation(add("Target", true)))).rejects.toThrow();
      expect((await f.undo()).undone.deleted).toBe(0);
      expect(f.rows.get("Target-dataset")!.size).toBe(2);
      expect((await f.undo()).undone.deleted).toBe(0);
  });
  it("waits for a destination host and rejects changed rules on resume", async () => {
    const f = await fixture();
    const a = automation(add("Target", true));
      f.hooks.hostDown = true;
      expect(await f.run(a)).toEqual({ kind: "wait", reason: "engine" });
      f.hooks.hostDown = false;
      f.hooks.crashAppend = true;
      await expect(f.run(a)).rejects.toThrow();
      const target = f.targets.get("Target")!;
      if (target.kind !== "dataset") throw new Error("fixture");
      target.approved = { ...target.approved, revision: 2, revisionSha256: "b".repeat(64) };
      expect(await f.run(a)).toMatchObject({ kind: "failed", error: "Collection rules changed after this run started." });
  });
});

it.each([false, true])("a Find observes the committed Add on dataset=%s", async (target) => {
  const f = await fixture(!target, target);
  if (target) f.rows.get("Target-dataset")!.clear(); else f.docs.delete("Target/same");
  expect(await f.run(automation(add("Target", target) + find("Target", target) + set(target, "found")))).toEqual({ kind: "done" });
  expect(target ? [...f.rows.get("Target-dataset")!.values()].map((row) => row.values.status) : [...f.docs.values()].filter((doc) => doc.collection === "Target").map((doc) => doc.status)).toEqual(["Closed"]);
});

it("keeps numeric and text primary keys distinct through Find, Set and Undo", async () => {
  const f = await fixture();
  const rows = f.rows.get("Target-dataset")!;
  rows.clear();
  rows.set(7, { id: 7, version: 1, values: { id: 7, status: "Open" } });
  rows.set("7", { id: "7", version: 1, values: { id: "7", status: "Open" } });
  expect(await f.run(automation(find("Target", true) + set(true, "found")))).toEqual({ kind: "done" });
  expect(f.calls.filter((call) => call.operationId === "edit").map((call) => (call.input as { id: JsonValue }).id)).toEqual([7, "7"]);
  expect((await f.undo()).undone.reverted).toBe(2);
  expect(rows.get(7)!.values.status).toBe("Open");
  expect(rows.get("7")!.values.status).toBe("Open");
});

it("Undo leaves an Add that never committed absent", async () => {
  const f = await fixture();
  f.hooks.beforeEffect = () => { throw new Error("host stopped before commit"); };
  expect(await f.run(automation(add("Target", true)))).toMatchObject({ kind: "failed" });
  f.hooks.beforeEffect = undefined;
  expect((await f.undo()).undone.removed).toBe(0);
  expect(f.rows.get("Target-dataset")!.size).toBe(1);
});

it("Undo reverses a dataset edit that committed without its journal append", async () => {
  const f = await fixture();
  f.hooks.crashAppend = true;
  await expect(f.run(automation(find("Target", true) + set(true, "found")))).rejects.toThrow();
  expect((await f.undo()).undone.reverted).toBe(1);
  expect(f.rows.get("Target-dataset")!.get("same")!.values.status).toBe("Open");
});

it("runs record steps only in the selected branch", async () => {
  const f = await fixture();
  const branch = '      - if: "false"\n        do:\n          - add-record: {Status: Skipped}\n            collection: Other\n            operation: rows.create\n        otherwise:\n          - add-record: {Status: Open}\n            collection: Target\n            operation: rows.create\n';
  expect(await f.run(automation(branch))).toEqual({ kind: "done" });
  expect(f.rows.get("Other-dataset")!.size).toBe(1);
  expect(f.rows.get("Target-dataset")!.size).toBe(2);
});

it("allows an authored source to add elsewhere but rejects an authored destination", async () => {
  const f = await fixture(true, false);
  const source = f.targets.get("Source")!;
  if (source.kind !== "dataset") throw new Error("fixture");
  source.generated = false;
  expect(await f.run(automation(add("Target", false)))).toEqual({ kind: "done" });
  expect(f.calls.some((call) => call.datasetId === source.approved.datasetId)).toBe(false);
  const other = await fixture();
  const target = other.targets.get("Target")!;
  if (target.kind !== "dataset") throw new Error("fixture");
  target.generated = false;
  expect(await other.run(automation(add("Target", true)))).toMatchObject({ kind: "failed", error: expect.stringContaining("outside dohc") });
  expect(other.calls).toEqual([]);
});

it("refuses a replaced destination descriptor before replaying an unfinished effect", async () => {
  const f = await fixture();
  const a = automation(add("Target", true));
  f.hooks.crashAppend = true;
  await expect(f.run(a)).rejects.toThrow();
  const target = f.targets.get("Target")!;
  if (target.kind !== "dataset") throw new Error("fixture");
  target.approved = { ...target.approved, datasetId: "replacement" };
  expect(await f.run(a)).toMatchObject({ kind: "failed", error: "Collection rules changed after this run started." });
  expect(f.rows.get("Target-dataset")!.size).toBe(2);
});

it("does not reuse another destination's grants for matching operation and field IDs", async () => {
  const f = await fixture();
  const grant = { grantId: "editor", recipientUserId: "person", recipientEmail: "person@example.com", files: { paths: ["Source", "Target", "Other"], versionId: null, access: "edit" as const }, channel: null };
  f.setRoster({ kind: "owner", ownerUserId: "owner", grants: [grant] });
  const principalKey = datasetPrincipalKey("workspace", "editor", "person");
  for (const path of ["Target", "Other"]) {
    const target = f.targets.get(path)!;
    if (target.kind !== "dataset") throw new Error("fixture");
    target.approved.definition.operations = target.approved.definition.operations.map((operation) => ({ ...operation, access: "helper" }));
    target.grants = { workspaceId: "workspace", grants: path === "Target" ? [{ principalKey, operationIds: ["read", "edit", "create"] }] : [] };
  }
  expect(await f.run(automation(find("Target", true) + set(true, "found") + find("Other", true, "other") + set(true, "other")))).toMatchObject({ kind: "failed" });
  expect(f.calls).toEqual([]);
});

it("rechecks destination grants immediately before an effect", async () => {
  const f = await fixture();
  const target = f.targets.get("Target")!;
  if (target.kind !== "dataset") throw new Error("fixture");
  const original = f.dependencies.store.save;
  f.dependencies.store.save = async (run) => {
    await original(run);
    f.setRoster({ kind: "owner", ownerUserId: "owner", grants: [{ grantId: "editor", recipientUserId: "person", recipientEmail: "person@example.com", files: { paths: ["Source"], access: "edit", versionId: null }, channel: null }] });
  };
  expect(await f.run(automation(find("Target", true) + set(true, "found")))).toMatchObject({ kind: "failed" });
  expect(f.calls.filter((call) => call.operationId !== "read")).toEqual([]);
  expect(f.rows.get("Target-dataset")!.get("same")!.values.status).toBe("Open");
});

it("follows a saved document Find binding after its Collection moves", async () => {
  const target = false;
  const f = await fixture(!target, target);
  const a = automation(find("Target", target) + set(target, "found", "First") + set(target, "found", "Last"));
  f.hooks.crashAppend = true;
  await expect(f.run(a)).rejects.toThrow("crash before journal append");
  f.move("Target", "Moved");
  expect(await f.run(a)).toEqual({ kind: "done" });
  expect((await f.runs())[0]!.steps[0]!.destinations?.[0]?.path).toBe("Moved");
  expect((await f.undo()).undone.reverted).toBe(1);
  expect(target ? f.rows.get("Target-dataset")!.get("same")!.values.status : f.docs.get("Target/same")!.status).toBe("Open");
});

it("waits when a document destination moves between effects, then checks its new reach", async () => {
  const f = await fixture(true, false);
  let moved = false;
  f.hooks.afterEffect = () => { if (!moved) { moved = true; f.move("Target", "Moved"); } };
  const a = automation(find("Target", false) + set(false, "found", "First") + set(false, "found", "Last"));
  expect(await f.run(a)).toEqual({ kind: "wait", reason: "moved" });
  expect(await f.run(a)).toEqual({ kind: "done" });
  expect((await f.undo()).undone.reverted).toBe(1);
});

it.each([false, true])("mixed Undo restores an intervening edit when the final write lacks a journal entry on dataset=%s", async (target) => {
  const f = await fixture(!target, target);
  let effects = 0;
  f.hooks.afterEffect = () => {
    effects += 1;
    if (effects === 2) {
      if (target) { const row = f.rows.get("Target-dataset")!.get("same")!; row.values.status = "Person"; row.version += 1; }
      else f.docs.get("Target/same")!.status = "Person";
    }
    if (effects === 3) f.hooks.crashAppend = true;
  };
  await expect(f.run(automation(add("Other", true, "other") + find("Target", target) + set(target, "found", "First") + set(target, "found", "Last")))).rejects.toThrow("crash before journal append");
  f.hooks.afterEffect = undefined;
  expect((await f.undo()).undone).toMatchObject({ reverted: 1, deleted: 1 });
  expect(target ? f.rows.get("Target-dataset")!.get("same")!.values.status : f.docs.get("Target/same")!.status).toBe("Person");
});

it("retries a mixed Undo after one destination was reversed and the next failed", async () => {
  const f = await fixture();
  const a = automation(find("Source", false, "docs") + set(false, "docs") + find("Target", true) + set(true, "found"));
  expect(await f.run(a)).toEqual({ kind: "done" });
  const writes = f.dependencies.withRecordWrites;
  f.dependencies.withRecordWrites = async () => { throw new Error("document engine unavailable"); };
  await expect(f.undo()).rejects.toThrow("document engine unavailable");
  expect(f.rows.get("Target-dataset")!.get("same")!.values.status).toBe("Open");
  expect(f.docs.get("Source/same")!.status).toBe("Closed");
  f.dependencies.withRecordWrites = writes;
  await f.undo();
  expect(f.rows.get("Target-dataset")!.get("same")!.values.status).toBe("Open");
  expect(f.docs.get("Source/same")!.status).toBe("Open");
});

it("waits before rebasing a saved mixed run when the host and its indexed identities disappear", async () => {
  const f = await fixture();
  const a = automation(add("Target", true) + set(true, "added"));
  f.hooks.crashAppend = true;
  await expect(f.run(a)).rejects.toThrow("crash before journal append");
  f.hooks.hostDown = true;
  f.hooks.hideDatasetLocations = true;
  expect(await f.run(a)).toEqual({ kind: "wait", reason: "engine" });
  f.hooks.hostDown = false;
  f.hooks.hideDatasetLocations = false;
  expect(await f.run(a)).toEqual({ kind: "done" });
});

it("keeps code steps on the source backend between cross-Collection record steps", async () => {
  const f = await fixture();
  const a = automation(add("Target", true) +
    `      - run: "return { set: { Status: 'Code' } };"\n` + set(true, "added", "After code"));
  expect(await f.run(a)).toEqual({ kind: "done" });
  expect(f.docs.get("Source/same")!.status).toBe("Code");
  expect([...f.rows.get("Target-dataset")!.values()].map((row) => row.values.status)).toContain("After code");
});

it("replays a replan after commit-before-append with the same caller and payload", async () => {
  const f = await fixture();
  const a = automation(find("Target", true) + set(true, "found"));
  f.hooks.beforeEffect = () => {
    f.hooks.beforeEffect = undefined;
    // A different field changed: the planned field still qualifies for the replan.
    f.rows.get("Target-dataset")!.get("same")!.version += 1;
  };
  f.hooks.crashAppend = true;
  await expect(f.run(a)).rejects.toThrow("crash before journal append");
  const [saved] = await f.runs();
  expect(saved!.replans).toMatchObject([{ replan: 1, version: 2 }]);
  expect(await f.run(a)).toEqual({ kind: "done" });
  const edits = f.calls.filter((call) => call.operationId === "edit");
  expect(edits).toHaveLength(3);
  expect(edits[2]).toEqual(edits[1]);
  expect(f.rows.get("Target-dataset")!.get("same")!.version).toBe(3);
});

it.each(["descriptor", "revision"])("Undo refuses changed destination %s before any reversal", async (change) => {
  const f = await fixture();
  expect(await f.run(automation(find("Target", true) + set(true, "found")))).toEqual({ kind: "done" });
  const target = f.targets.get("Target")!;
  if (target.kind !== "dataset") throw new Error("fixture");
  if (change === "descriptor") target.approved = { ...target.approved, datasetId: "replacement" };
  if (change === "revision") target.approved = { ...target.approved, revision: 2, revisionSha256: "b".repeat(64) };
  await expect(automationUndoReach(await f.runs(), f.dependencies.targets, f.dependencies.collectionPathOf, { roster, collection: { path: "Source", name: "Source" } }, f.host)).rejects.toThrow();
  expect(f.rows.get("Target-dataset")!.get("same")!.values.status).toBe("Closed");
});

it("keeps an Add binding's id and version when its dataset has no approved read", async () => {
  const f = await fixture();
  const target = f.targets.get("Target")!;
  if (target.kind !== "dataset") throw new Error("fixture");
  target.approved.definition.operations = target.approved.definition.operations.filter((operation) => operation.kind !== "read");
  expect(await f.run(automation(add("Target", true) + set(true, "added")))).toEqual({ kind: "done" });
  expect([...f.rows.get("Target-dataset")!.values()].at(-1)).toMatchObject({ version: 2, values: { status: "Closed" } });
});

it("explains a dataset Find formula refused by the approved read", async () => {
  const f = await fixture();
  f.hooks.beforeRead = () => { throw new AppBackendRuntimeError({ code: "invalid_input", message: "Invalid filter" }); };
  const steps = find("Target", true).replace('record.Status == "Open"', "record.Status == String(trigger.record.Status)");
  expect(await f.run(automation(steps))).toEqual({ kind: "failed", timedOut: false,
    error: "The Find in step 1 compares Status with a value this Collection does not accept." });
});

it("leaves literal Find values to the approved read", async () => {
  const f = await fixture();
  const target = f.targets.get("Target")!;
  if (target.kind !== "dataset") throw new Error("fixture");
  target.approved.definition.tables[0]!.fields[1]!.type = "number";
  expect(await f.run(automation(find("Target", true)))).toEqual({ kind: "done" });
  expect(f.calls.some((call) => call.operationId === "read")).toBe(true);
});

it("checks the exact read used by an added-record Undo preview", async () => {
  const f = await fixture();
  expect(await f.run(automation(add("Target", true)))).toEqual({ kind: "done" });
  const target = f.targets.get("Target")!;
  if (target.kind !== "dataset") throw new Error("fixture");
  target.approved.definition.operations.push({ ...target.approved.definition.operations[0]!, operationId: "narrow", name: "rows.narrow", fieldIds: ["id"] });
  const reach = await automationUndoReach(await f.runs(), f.dependencies.targets, f.dependencies.collectionPathOf, { roster, collection: { path: "Source", name: "Source" } }, f.host);
  expect(reach.filter((step) => step.kind === "dataset-operation").map((step) => step.operation.operationId)).toEqual(["read"]);
});

it("keeps an addition with no usable delete without requiring its preview read", async () => {
  const f = await fixture();
  const target = f.targets.get("Target")!;
  if (target.kind !== "dataset") throw new Error("fixture");
  target.approved.definition.operations = target.approved.definition.operations.filter((operation) => operation.kind !== "delete");
  expect(await f.run(automation(add("Target", true)))).toEqual({ kind: "done" });
  const reach = await automationUndoReach(await f.runs(), f.dependencies.targets, f.dependencies.collectionPathOf,
    { roster, collection: { path: "Source", name: "Source" } }, f.host);
  expect(reach.filter((step) => step.kind === "dataset-operation")).toEqual([]);
  expect((await f.undo()).undone).toMatchObject({ kept: 1, deleted: 0 });
});

it("reverses actions in commit order despite a backwards clock, without inventing read reach", async () => {
  const f = await fixture(true);
  const target = f.targets.get("Source")!;
  if (target.kind !== "dataset") throw new Error("fixture");
  const approved = target.approved;
  const rules = { datasetId: approved.datasetId, revision: approved.revision, revisionSha256: approved.revisionSha256 };
  target.approved.definition.operations.push(
    { operationId: "action", name: "rows.action", label: "Act", tableId: "table", kind: "action", access: "owner",
      readOnly: false, fieldIds: [], reversedBy: "rows.reverse" },
    { operationId: "reverse", name: "rows.reverse", label: "Reverse", tableId: "table", kind: "action", access: "helper",
      readOnly: false, fieldIds: [] },
  );
  const { newRun } = await import("./collectionAutomationRun");
  const runs = [newRun(f.held.claim, automation(add("Target", true)), "older", 200),
    newRun(f.held.claim, automation(add("Target", true)), "newer", 100)];
  runs.forEach((run, index) => {
    run.steps = [{ ordinal: 0, effects: [{ kind: "dataset-action", rules, operationId: "action", tableId: "table", input: {} }] }];
    run.applied = [{ ordinal: 0, writes: [{ kind: "dataset-action", rules, operationId: "action", tableId: "table",
      name: "Act", revision: index + 2, undo: { revision: index + 2 }, reverseOperationId: "reverse" }] }];
  });
  const plan = await planDatasetUndo(f.host, { roster, collection: { path: "Source", name: "Source" } }, "claim", runs, runs, signal);
  runs[0]!.undoCalls = plan.send([])!;
  const reach = await automationUndoReach(runs, f.dependencies.targets, f.dependencies.collectionPathOf, { roster, collection: { path: "Source", name: "Source" } }, f.host);
  expect(reach.filter((step) => step.kind === "dataset-operation").map((step) => step.operation.operationId)).toEqual(["reverse"]);
  const reversed: JsonValue[] = [];
  await undoAutomationRuns({ collectionPathOf: f.dependencies.collectionPathOf, withReads: f.dependencies.withReads,
    withRecordWrites: f.dependencies.withRecordWrites, trash: async () => {} },
    { ...f.host, invokeAsOwner: async (input) => { reversed.push(input.input); return { result: null, revision: 10, replayed: false }; } },
    { path: "Source", name: "Source" }, async () => roster, "claim", runs, async () => {}, signal);
  expect(reversed).toEqual([{ revision: 3 }, { revision: 2 }]);
});

it.each([[false, false], [false, true], [true, false], [true, true]])("keeps compatible approvals during a run and Undo, dataset=%s, resume=%s", async (sourceDataset, resume) => {
  const f = await fixture(sourceDataset);
  const resolve = f.dependencies.targets.resolve;
  f.dependencies.targets.resolve = async (path) => structuredClone(await resolve(path));
  const accepted = new Set<string>();
  for (const target of f.targets.values()) if (target.kind === "dataset") accepted.add(JSON.stringify([
    target.approved.datasetId, target.approved.revision, target.approved.revisionSha256,
  ]));
  f.host.resolves = (rules) => accepted.has(JSON.stringify([rules.datasetId, rules.revision, rules.revisionSha256]));
  const approve = () => {
    for (const target of f.targets.values()) {
      if (target.kind !== "dataset") continue;
      const approved = structuredClone(target.approved);
      approved.revision += 1;
      approved.revisionSha256 = String(approved.revision).repeat(64);
      approved.definition.tables[0]!.fields.push({ fieldId: "button-" + approved.revision, name: "Button " + approved.revision, type: "button" });
      target.approved = approved;
      accepted.add(JSON.stringify([approved.datasetId, approved.revision, approved.revisionSha256]));
    }
  };
  f.hooks.beforeRead = () => { f.hooks.beforeRead = undefined; approve(); };
  f.hooks.afterEffect = () => { f.hooks.afterEffect = undefined; approve(); };
  f.hooks.crashAppend = resume;
  const a = automation(find("Target", true) + set(true, "found", "First") + set(true, "found", "Last"));
  if (resume) await expect(f.run(a)).rejects.toThrow("crash before journal append");
  expect(await f.run(a)).toEqual({ kind: "done" });
  expect(f.rows.get("Target-dataset")!.get("same")!.values.status).toBe("Last");
  approve();
  await expect(automationUndoReach(await f.runs(), f.dependencies.targets, f.dependencies.collectionPathOf,
    { roster, collection: { path: "Source", name: "Source" } }, f.host)).resolves.toEqual([]);
  expect((await f.undo()).undone).toMatchObject({ reverted: 1 });
  expect(f.rows.get("Target-dataset")!.get("same")!.values.status).toBe("Open");
});

it.each([false, true])("keeps Group-message write authors separate from formula person, dataset=%s", async (sourceDataset) => {
  const f = await fixture(sourceDataset, false);
  const a = automation(add(sourceDataset ? "Source" : "Target", sourceDataset).replace("Status: Open", "Status: '=person.name'"));
  a.when = { kind: "group-message", group: "Team", startsWith: null };
  const claim: AutomationClaim = {
    ...f.held.claim, error: undefined, trigger: { key: "message:m1" }, recordId: null, collectionPath: "Source",
    change: { kind: "message", authorOriginId: null, actorKind: "human", onBehalfOf: "user-ana", sharedAuthor: null,
      liveCursor: null, fields: [], fieldsOmitted: 0, message: { id: "m1", threadId: "t1", groupId: "team", lane: "posts",
        authorKind: "human", authorDisplayName: "Ana", createdAtMs: 1000, body: "hello", authorUserId: "user-ana" } },
  };
  f.dependencies.chat.directory = async (roster) => chatDirectoryOf([
    { id: "team", name: "Team", slug: "team", kind: "channel", type: "posts", wireId: "team-wire", runningThreadId: null },
  ], roster);
  const authors: unknown[] = [];
  const writes = f.dependencies.withRecordWrites;
  f.dependencies.withRecordWrites = (signal, work) => writes(signal, (writer) => work({
    ...writer, create: async (input) => { authors.push(input.author); return writer.create(input); },
    setFields: async (input) => { authors.push(input.author); return writer.setFields(input); },
  }));
  const contexts: unknown[] = [];
  const invoke = f.host.invoke;
  f.host.invoke = (context, input) => { contexts.push(context); return invoke(context, input); };
  const input = { automation: a, collection: { path: "Source", name: "Source" }, roster: { ...roster, ownerUserId: "owner" }, signal, stopped: signal };
  expect(await (sourceDataset ? runDatasetAutomation(f.dependencies, { ...input, held: { source: "engine", claim, datasetId: "Source-dataset" } })
    : runCollectionAutomation(f.dependencies, { ...input, claim }))).toEqual({ kind: "done" });
  if (sourceDataset) {
    expect([...f.rows.get("Source-dataset")!.values()].at(-1)!.values.status).toBe("Ana");
    expect(contexts).toContainEqual(expect.objectContaining({ person: "user-ana" }));
  } else {
    expect([...f.docs.values()].at(-1)!.status).toBe("Ana");
    expect(authors).toContainEqual(expect.objectContaining({ kind: "automation", onBehalfOf: "user-ana" }));
  }
});

it("opens one document read session for each step regardless of its record count", async () => {
  const f = await fixture(false, false);
  for (let n = 0; n < 8; n++) f.docs.set("Target/" + n, { id: "target-" + n, path: "Target/" + n + ".md", collection: "Target", status: "Open" });
  let sessions = 0;
  let sessionsAtFirstWrite = 0;
  const read = f.dependencies.withReads;
  f.dependencies.withReads = (work) => { sessions++; return read(work); };
  f.hooks.beforeEffect = () => { f.hooks.beforeEffect = undefined; sessionsAtFirstWrite = sessions; };
  expect(await f.run(automation(find("Target", false) + set(false, "found")))).toEqual({ kind: "done" });
  expect(sessionsAtFirstWrite).toBe(4);
  expect([...f.docs.values()].filter((doc) => doc.collection === "Target").every((doc) => doc.status === "Closed")).toBe(true);
});

it.each([false, true])("retains pre-upgrade verdict keys and accounted links across a Collection move, dataset=%s", async (sourceDataset) => {
  const f = await fixture(sourceDataset, sourceDataset);
  const a = automation(find("Target", sourceDataset) + set(sourceDataset, "found") + '      - notify: Done\n        to: [user-ana]\n');
  const collection = { path: "Source", name: "Source" };
  const named = (path: string) => ({ path, name: path });
  const oldSteps = sourceDataset ? chatReachStepsOf(a, null) : reachStepsOf(a, collection, named, null);
  const automationId = f.held.claim.automationId;
  const hash = definitionHash(a);
  const old = new Map(oldSteps.map((step, index) => {
    const saved: StoredReachVerdict = { automationId, definitionHash: hash, step: reachStepId(step, index),
      verdict: "allowed", stoppedFor: null, seq: index + 1, accountedLinks: ["link#1"] };
    return [reachVerdictKey(automationId, hash, saved.step), saved];
  }));
  for (const path of ["Source", "Moved"]) {
    if (path === "Moved") f.move("Source", path);
    const reach = automationInventory(a, path, (path) => f.targets.get(path)!, null).reach;
    const staticSteps = reach.filter((step) => step.kind !== "dataset-operation" && step.kind !== "dataset-field");
    expect(staticSteps.map((step, index) => reachStepId(step, index))).toEqual(oldSteps.map((step, index) => reachStepId(step, index)));
    for (const [index, step] of staticSteps.entries()) {
      const saved = old.get(reachVerdictKey(automationId, hash, reachStepId(step, index)));
      expect(saved).toBeDefined();
      expect(nextReachVerdict(saved, { allowed: true, formerStops: [{ evidence: "link#1", name: "Former editor" }] }, true))
        .toEqual({ verdict: "allowed", stoppedFor: null, accountedLinks: ["link#1"] });
      for (const verdict of ["held", "stopped"] as const) {
        expect(nextReachVerdict({ ...saved!, verdict }, { allowed: true }, true).verdict).toBe("held");
      }
    }
  }
});
