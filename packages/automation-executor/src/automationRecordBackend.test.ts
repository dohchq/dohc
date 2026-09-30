import { afterAll, describe, expect, it, vi } from "vitest";
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
import { automationInventory, canPressInventory, irreversibleActionsOf } from "./automationInventory";
import { definitionHash, reachStepsOf, chatReachStepsOf } from "./automationPlan";
import { checkAutomationReach, reachStepId } from "./automationReach";
import { nextReachVerdict, reachVerdictKey, type StoredReachVerdict } from "./reachVerdicts";
import { AutomationRunWait } from "./automationRunWait";

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
    readPage?: (request: DatasetInvocation, found: Row[]) => DatasetInvocationResult;
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
    async queryCollectionRecords({ collectionPath, filter, limit = 500 }) {
      const found = [...docs.values()].filter((doc) => doc.collection === collectionPath && (!filter || isDeepStrictEqual(filter.value, doc.status)));
      const page = found.slice(0, limit);
      return { collection: { objectId: collectionPath, path: collectionPath, status: "valid", reasons: [] }, records: page.map(record), groups: null,
        nextCursor: found.length > limit ? { sortValues: [], recordPath: page.at(-1)!.path, recordId: page.at(-1)!.id } : null };
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
    const input = request.input;
    if (input === null || typeof input !== "object" || Array.isArray(input)) throw new Error("input");
    const destination = [...targets.values()].find((target) => target.kind === "dataset" && target.approved.datasetId === request.datasetId);
    const operation = destination?.kind === "dataset" ? destination.approved.definition.operations.find((operation) => operation.operationId === request.operationId) : undefined;
    const own = rows.get(`${request.datasetId}/${operation?.tableId}`) ?? rows.get(request.datasetId)!;
    if (operation?.kind === "read") {
      hooks.beforeRead?.();
      const filters = Array.isArray(input.filters) ? input.filters : [];
      const found = [...own.values()].filter((row) => filters.every((filter) => filter !== null && typeof filter === "object" && !Array.isArray(filter) && isDeepStrictEqual(row.values[String(filter.fieldId)], filter.value)));
      if (hooks.readPage) return hooks.readPage(request, found);
      const after = input.after;
      const start = after !== null && typeof after === "object" && !Array.isArray(after)
        ? found.findIndex((row) => row.id === after.id) + 1 : 0;
      const limit = typeof input.limit === "number" ? input.limit : 100;
      const page = found.slice(start, start + limit);
      return { result: { rows: structuredClone(page), nextCursor: start + limit < found.length
        ? { id: page.at(-1)!.id, value: page.at(-1)!.id } : null }, revision: 1, replayed: false };
    }
    hooks.beforeEffect?.();
    let result: JsonValue;
    if (operation?.kind === "create") {
      const id = "new-" + own.size;
      const values = input.values as Record<string, JsonValue>;
      own.set(id, { id, version: 1, values: { id, ...values } });
      result = { id, version: 1 };
    } else if (request.operationId === "action" || request.operationId === "reverse") {
      const row = own.get(input.id as string | number)!;
      const before = row.values.status;
      row.values.status = input.status ?? "Acted";
      row.version += 1;
      result = { undo: { id: row.id, status: before ?? null } };
    } else {
      const row = own.get(input.id as string | number);
      if (!row) throw new AppBackendRuntimeError({ code: "not_found", message: "Gone" });
      if (row.version !== input.expectedVersion) throw new AppBackendRuntimeError({ code: "stale_record", message: "Changed" });
      if (operation?.kind === "delete") { own.delete(row.id); result = { id: row.id }; }
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

function authored(f: Awaited<ReturnType<typeof fixture>>, path: string, reversible = true) {
  const target = f.targets.get(path);
  if (target?.kind !== "dataset") throw new Error("Expected a dataset");
  target.generated = false;
  target.approved.definition.operations.push(
    { operationId: "action", name: "rows.act", label: "Act", kind: "action", tableId: "table", access: "owner", readOnly: false, fieldIds: ["status"], ...(reversible ? { reversedBy: "rows.reverse" } : {}) },
    { operationId: "reverse", name: "rows.reverse", label: "Reverse", kind: "action", tableId: "table", access: "owner", readOnly: false, fieldIds: ["status"] },
  );
  return target;
}
const actionStep = (path: string) => `      - invoke: rows.act\n        collection: ${path}\n        input: {id: same}\n`;

const codeStep = (source: string) => automation(`      - run: ${JSON.stringify(source)}\n`);
const changes = (...records: Array<{ action: "add" | "change"; collection: string; table?: string; id?: string; fields: Record<string, JsonValue> }>) => codeStep(`return ${JSON.stringify({ records })};`);

describe("cross-Collection code changes", () => {
  it.each(["missing", "document", "dataset", "authored", "ambiguous", "missing-table"])("does not disclose HR's Salary field with a %s destination", async (kind) => {
    const answers: unknown[] = [];
    for (const salary of [false, true]) {
      const f = await fixture(false, kind !== "document");
      f.move("Target", "HR");
      const target = f.targets.get("HR")!;
      if (kind === "missing") f.targets.delete("HR");
      if (target.kind === "document" && salary) target.fields = new Set(["Status", "Salary"]);
      if (target.kind === "dataset") {
        if (salary) {
          target.approved.definition.tables[0]!.fields[1]!.name = "Salary";
        }
        if (kind === "authored") target.generated = false;
        if (kind === "ambiguous") target.approved.definition.tables.push({ ...target.approved.definition.tables[0]!, tableId: "other", name: "Other" });
      }
      f.setRoster({ kind: "owner", ownerUserId: "owner", grants: [{ grantId: "editor", recipientUserId: "editor", recipientEmail: "editor@example.com", files: { paths: ["Source"], versionId: null, access: "edit" }, channel: null }] });
      answers.push(await f.run(changes({ action: "add", collection: "HR", ...(kind === "missing-table" ? { table: "Missing" } : {}), fields: { Salary: "secret" } })));
      expect(f.calls).toEqual([]);
    }
    expect(answers[0]).toEqual(answers[1]);
    expect(answers[0]).toMatchObject({ kind: "failed", error: "The code in step 1 changes records. This automation cannot use the requested Collection or fields." });
  });

  it.each(["add", "change"] as const)("resumes a saved %s by field ID after a compatible rename and re-approval", async (action) => {
    const f = await fixture();
    const a = changes({ action, collection: "Target", ...(action === "change" ? { id: "same" } : {}), fields: { Status: "Closed" } });
    f.hooks.beforeEffect = () => { throw new AutomationRunWait("pause before apply"); };
    expect(await f.run(a)).toMatchObject({ kind: "wait" });
    const target = f.targets.get("Target");
    if (target?.kind !== "dataset") throw new Error("target");
    target.approved.definition.tables[0]!.fields[1]!.name = "State";
    target.approved.revision += 1;
    target.approved.revisionSha256 = "b".repeat(64);
    f.host.resolves = () => true;
    f.dependencies.evaluator = { evaluate: async () => { throw new Error("evaluated again"); }, runCode: async () => { throw new Error("evaluated again"); } };
    f.hooks.beforeEffect = () => { f.hooks.beforeEffect = undefined; if (action === "change") f.rows.get("Target-dataset")!.get("same")!.version += 1; };
    expect(await f.run(a)).toEqual({ kind: "done" });
    expect([...f.rows.get("Target-dataset")!.values()].at(-1)!.values.status).toBe("Closed");
    expect((await f.runs())[0]!.steps[0]!.effects[0]).toMatchObject(action === "add" ? { values: [{ fieldId: "status", field: "Status" }] } : { fields: [{ fieldId: "status", field: "Status" }] });
  });

  it("names a missing table after authorization", async () => {
    const f = await fixture();
    expect(await f.run(changes({ action: "add", collection: "Target", table: "Absent", fields: { Status: "Added" } })))
      .toMatchObject({ kind: "failed", error: "Target has no table named Absent. Check the table name in step 1." });
  });

  it.each([false, true])("keeps target loading errors when the path check passes, with editor: %s", async (editor) => {
    const f = await fixture();
    if (editor) f.setRoster({ kind: "owner", ownerUserId: "owner", grants: [{ grantId: "editor", recipientUserId: "editor", recipientEmail: "editor@example.com", files: { paths: ["Source", "Target"], versionId: null, access: "edit" }, channel: null }] });
    const resolve = f.dependencies.targets.resolve;
    f.dependencies.targets.resolve = async (path) => path === "Target"
      ? { kind: "problem", code: "descriptor-mismatch", problem: "Target/dataset.json does not match its approved rules. Restore the matching file, then try again." }
      : resolve(path);
    expect(await f.run(changes({ action: "add", collection: "Target", fields: { Status: "Added" } })))
      .toMatchObject({ kind: "failed", error: "The code in step 1 changes records in Target. Target/dataset.json does not match its approved rules. Restore the matching file, then try again." });
    expect(f.calls).toEqual([]);
  });

  it("waits for an offline destination host when an editor has only operation grants, then runs", async () => {
    const f = await fixture();
    const target = f.targets.get("Target");
    if (target?.kind !== "dataset") throw new Error("target");
    target.approved.definition.operations.forEach((operation) => { operation.access = "helper"; });
    target.grants.grants = [{ principalKey: datasetPrincipalKey("workspace", "editor", "editor"), operationIds: ["read", "edit"] }];
    f.setRoster({ kind: "owner", ownerUserId: "owner", grants: [{ grantId: "editor", recipientUserId: "editor", recipientEmail: "editor@example.com", files: { paths: ["Source"], versionId: null, access: "edit" }, channel: null }] });
    const a = changes({ action: "change", collection: "Target", id: "same", fields: { Status: "Closed" } });
    f.hooks.hostDown = true;
    expect(await f.run(a)).toMatchObject({ kind: "wait", reason: "engine" });
    expect(f.calls).toEqual([]);
    f.hooks.hostDown = false;
    expect(await f.run(a)).toEqual({ kind: "done" });
    expect(f.rows.get("Target-dataset")!.get("same")!.values.status).toBe("Closed");
  });

  it("checks document reach before inspecting its fields", async () => {
    const f = await fixture(false, false);
    const target = f.targets.get("Target")!;
    Object.defineProperty(target, "fields", { get() { throw new Error("schema was inspected"); } });
    f.setRoster({ kind: "owner", ownerUserId: "owner", grants: [{ grantId: "editor", recipientUserId: "editor", recipientEmail: "editor@example.com", files: { paths: ["Source"], versionId: null, access: "edit" }, channel: null }] });
    expect(await f.run(changes({ action: "add", collection: "Target", table: "Secret", fields: { Salary: "secret" } })))
      .toMatchObject({ kind: "failed", error: "The code in step 1 changes records. This automation cannot use the requested Collection or fields." });
  });

  it("keeps a document hold ahead of schema validation", async () => {
    const f = await fixture(false, false);
    f.dependencies.recipientVerdicts = async () => ["held"];
    expect(await f.run(changes({ action: "add", collection: "Target", fields: { Missing: "x" } }))).toEqual({ kind: "wait", reason: "held" });
    expect(f.docs.size).toBe(2);
  });

  it("reports a later denial before an earlier allowed target's schema error", async () => {
    const f = await fixture(false, false);
    f.setRoster({ kind: "owner", ownerUserId: "owner", grants: [{ grantId: "editor", recipientUserId: "editor", recipientEmail: "editor@example.com", files: { paths: ["Source", "Target"], versionId: null, access: "edit" }, channel: null }] });
    expect(await f.run(changes({ action: "add", collection: "Target", fields: { Missing: "x" } },
      { action: "add", collection: "Other", fields: { Status: "Secret" } })))
      .toMatchObject({ kind: "failed", error: "The code in step 1 changes records. This automation cannot use the requested Collection or fields." });
    expect(f.calls).toEqual([]);
  });

  it.each([null, "local-fallback"])("checks button caller %s independently of the owner account", async (person) => {
    const f = await fixture();
    if (f.held.source !== "document") throw new Error("claim");
    f.held.claim.change.kind = "button";
    f.held.claim.change.onBehalfOf = person;
    f.dependencies.localPersonId = () => "local-fallback";
    f.setRoster({ kind: "owner", ownerUserId: person === null ? null : "owner", grants: [] });
    const a = changes({ action: "change", collection: "Target", id: "same", fields: { Status: "Closed" } });
    a.when = { kind: "button", field: "Run", table: null };
    expect(await f.run(a)).toMatchObject({ kind: person === null ? "failed" : "done" });
    expect(f.rows.get("Target-dataset")!.get("same")!.values.status).toBe(person === null ? "Open" : "Closed");
  });

  it("labels dynamic read holds with the operation label", async () => {
    const f = await fixture();
    const recipients = vi.fn(async () => []);
    f.dependencies.recipientVerdicts = recipients;
    expect(await f.run(changes({ action: "change", collection: "Target", id: "same", fields: { Status: "Closed" } }))).toEqual({ kind: "done" });
    expect(recipients).toHaveBeenCalledWith(expect.objectContaining({ recipients: expect.arrayContaining([
      expect.objectContaining({ name: "Target: Read", action: "find" }),
      expect.objectContaining({ name: "Target: Edit", action: "change" }),
    ]) }));
  });

  it("discards code destinations from a changed-record retry", async () => {
    const f = await fixture(true);
    let reads = 0;
    f.hooks.beforeRead = () => {
      if (++reads !== 2) return;
      const row = f.rows.get("Source-dataset")!.get("same")!;
      row.version += 1;
      row.values.status = "Changed";
    };
    const a = codeStep(`return ctx.record.Status === 'Open'
      ? { records: [{ action: 'add', collection: 'Other', fields: { Status: 'Discarded' } }, { action: 'change', collection: 'Source', id: 'same', fields: { Status: 'Closed' } }] }
      : { records: [{ action: 'add', collection: 'Target', fields: { Status: 'Kept' } }] };`);
    expect(await f.run(a)).toEqual({ kind: "done" });
    expect((await f.runs())[0]!.steps[0]!.destinations?.map(({ path }) => path)).toEqual(["Target"]);
    expect(f.rows.get("Other-dataset")!.size).toBe(1);
    expect([...f.rows.get("Target-dataset")!.values()].at(-1)!.values.status).toBe("Kept");
  });

  it.each([[false, false], [false, true], [true, false], [true, true]])("routes from dataset %s to dataset %s and uses the shared Undo", async (sourceDataset, targetDataset) => {
    const f = await fixture(sourceDataset, targetDataset);
    const definition = changes({ action: "change", collection: "Target", id: targetDataset ? "same" : "Target-same", fields: { Status: "Closed" } });
    expect(await f.run(definition)).toMatchObject({ kind: "done" });
    const status = () => targetDataset ? f.rows.get("Target-dataset")!.get("same")!.values.status : f.docs.get("Target/same")!.status;
    expect(status()).toBe("Closed");
    expect((await f.runs())[0]!.steps[0]!.destinations).toMatchObject([{ path: "Target" }]);
    await f.undo();
    expect(status()).toBe("Open");
  });

  it("denies a computed destination before reading any returned record", async () => {
    const f = await fixture();
    f.setRoster({ kind: "owner", ownerUserId: "owner", grants: [{ grantId: "editor", recipientUserId: "editor", recipientEmail: "editor@example.com", files: { paths: ["Source"], versionId: null, access: "edit" }, channel: null }] });
    const definition = codeStep("const target = ['Tar', 'get'].join(''); return { records: [{ action: 'change', collection: target, id: 'same', fields: { Status: 'Closed' } }] }; ");
    expect(await f.run(definition)).toMatchObject({ kind: "failed" });
    expect(f.calls).toEqual([]);
  });

  it("checks all destinations before reading an allowed target", async () => {
    const f = await fixture();
    const target = f.targets.get("Target");
    if (target?.kind !== "dataset") throw new Error("target");
    target.approved.definition.operations.forEach((operation) => { operation.access = "helper"; });
    target.grants.grants = [{ principalKey: datasetPrincipalKey("workspace", "editor", "editor"), operationIds: ["read", "edit"] }];
    f.setRoster({ kind: "owner", ownerUserId: "owner", grants: [{ grantId: "editor", recipientUserId: "editor", recipientEmail: "editor@example.com", files: { paths: ["Source"], versionId: null, access: "edit" }, channel: null }] });
    expect(await f.run(changes(
      { action: "change", collection: "Target", id: "same", fields: { Status: "Closed" } },
      { action: "change", collection: "Other", id: "same", fields: { Status: "Closed" } },
    ))).toMatchObject({ kind: "failed" });
    expect(f.calls).toEqual([]);
  });

  it("selects operations in each destination and gives multiple additions different receipt keys", async () => {
    const f = await fixture(true);
    const target = f.targets.get("Target");
    if (target?.kind !== "dataset") throw new Error("target");
    target.approved.definition.operations.forEach((operation) => { operation.operationId = "target-" + operation.operationId; });
    expect(await f.run(changes(
      { action: "add", collection: "Target", fields: { Status: "First" } },
      { action: "add", collection: "Other", fields: { Status: "Other" } },
      { action: "add", collection: "Target", fields: { Status: "Second" } },
    ))).toMatchObject({ kind: "done" });
    const calls = f.calls.filter((call) => call.operationId.includes("create"));
    expect(calls.map((call) => [call.datasetId, call.operationId])).toEqual([["Target-dataset", "target-create"], ["Other-dataset", "create"], ["Target-dataset", "target-create"]]);
    expect(new Set(calls.map((call) => call.idempotencyKey)).size).toBe(3);
    expect(f.rows.get("Target-dataset")!.size).toBe(3);
    await f.undo();
    expect(f.rows.get("Target-dataset")!.size).toBe(1);
    expect(f.rows.get("Other-dataset")!.size).toBe(1);
  });

  it.each([false, true])("requires an explicit table in another multi-table dataset, explicit %s", async (explicit) => {
    const f = await fixture(true);
    const target = f.targets.get("Target");
    if (target?.kind !== "dataset") throw new Error("target");
    target.approved.definition.tables.push({ ...structuredClone(target.approved.definition.tables[0]!), tableId: "second", name: "Second", sqlName: "second" });
    const outcome = await f.run(changes({ action: "add", collection: "Target", ...(explicit ? { table: "Rows" } : {}), fields: { Status: "Added" } }));
    expect(outcome, JSON.stringify(outcome)).toMatchObject({ kind: explicit ? "done" : "failed" });
    expect(f.calls.filter((call) => call.datasetId === "Target-dataset").length).toBe(explicit ? 1 : 0);
  });

  it("includes the code-file editor in destination reach", async () => {
    const f = await fixture();
    f.dependencies.readCode = async () => ({ text: "return { records: [{ action: 'add', collection: 'Target', fields: { Status: 'Added' } }] };", truncated: false });
    f.setRoster({ kind: "owner", ownerUserId: "owner", grants: [
      { grantId: "code", recipientUserId: "editor", recipientEmail: "editor@example.com", files: { paths: ["Source/run.js"], versionId: null, access: "edit" }, channel: null },
      { grantId: "view", recipientUserId: "editor", recipientEmail: "editor@example.com", files: { paths: ["Source"], versionId: null, access: "view" }, channel: null },
    ] });
    expect(await f.run(automation("      - run-file: run.js\n"))).toMatchObject({ kind: "failed" });
    expect(f.calls).toEqual([]);
  });

  it("keeps equal record ids in two explicitly selected tables separate", async () => {
    const f = await fixture();
    const target = f.targets.get("Target");
    if (target?.kind !== "dataset") throw new Error("target");
    target.approved.definition.tables.push({ ...structuredClone(target.approved.definition.tables[0]!), tableId: "second", name: "Second", sqlName: "second" });
    target.approved.definition.operations.push(...target.approved.definition.operations.map((operation) => ({ ...operation, tableId: "second", operationId: "second-" + operation.operationId, name: "second." + operation.kind })));
    f.rows.set("Target-dataset/second", new Map([["same", { id: "same", version: 1, values: { id: "same", status: "Open" } }]]));
    expect(await f.run(changes(
      { action: "change", collection: "Target", table: "Rows", id: "same", fields: { Status: "First" } },
      { action: "change", collection: "Target", table: "Second", id: "same", fields: { Status: "Second" } },
    ))).toMatchObject({ kind: "done" });
    expect((await f.runs())[0]!.steps[0]!.effects).toMatchObject([{ tableId: "table", operationId: "edit" }, { tableId: "second", operationId: "second-edit" }]);
    expect(f.rows.get("Target-dataset")!.get("same")!.values.status).toBe("First");
    expect(f.rows.get("Target-dataset/second")!.get("same")!.values.status).toBe("Second");
    await f.undo();
    expect(f.rows.get("Target-dataset")!.get("same")!.values.status).toBe("Open");
    expect(f.rows.get("Target-dataset/second")!.get("same")!.values.status).toBe("Open");
  });

  it("replays a mixed saved code step after a lost receipt append without evaluating its file again", async () => {
    const f = await fixture();
    const readCode = vi.fn(async () => ({ text: "return { records: [{ action: 'add', collection: 'Target', fields: { Status: 'Added' } }, { action: 'change', collection: 'Source', id: 'Source-same', fields: { Status: 'Closed' } }] };", truncated: false }));
    f.dependencies.readCode = readCode;
    const definition = automation("      - run-file: run.js\n");
    f.hooks.crashAppend = true;
    await expect(f.run(definition)).rejects.toThrow("crash before journal append");
    f.dependencies.readCode = async () => { throw new Error("code was read again"); };
    f.dependencies.evaluator = { evaluate: async () => { throw new Error("evaluated again"); }, runCode: async () => { throw new Error("evaluated again"); } };
    expect(await f.run(definition)).toMatchObject({ kind: "done" });
    expect(readCode).toHaveBeenCalledTimes(1);
    expect(f.rows.get("Target-dataset")!.size).toBe(2);
    expect(f.docs.get("Source/same")!.status).toBe("Closed");
    const calls = f.calls.filter((call) => call.operationId === "create");
    expect(calls[1]!.idempotencyKey).toBe(calls[0]!.idempotencyKey);
  });

  it("rejects a replaced saved target without replaying code or redirecting the effect", async () => {
    const f = await fixture();
    const definition = changes({ action: "add", collection: "Target", fields: { Status: "Added" } });
    f.hooks.crashAppend = true;
    await expect(f.run(definition)).rejects.toThrow("crash before journal append");
    const target = f.targets.get("Target");
    if (target?.kind !== "dataset") throw new Error("target");
    target.approved.datasetId = "replacement";
    const before = f.calls.length;
    expect(await f.run(definition)).toMatchObject({ kind: "failed" });
    expect(f.calls).toHaveLength(before);
  });

  it("resumes a saved target after its Collection moves", async () => {
    const f = await fixture();
    const definition = changes({ action: "add", collection: "Target", fields: { Status: "Added" } });
    f.hooks.crashAppend = true;
    await expect(f.run(definition)).rejects.toThrow("crash before journal append");
    f.move("Target", "Moved");
    expect(await f.run(definition)).toMatchObject({ kind: "done" });
    expect(f.rows.get("Target-dataset")!.size).toBe(2);
  });

  it("requires the button caller's destination grants even when the caller is not an editor", async () => {
    const f = await fixture();
    if (f.held.source !== "document") throw new Error("claim");
    f.held.claim.change.kind = "button";
    f.held.claim.change.onBehalfOf = "visitor";
    f.setRoster({ kind: "owner", ownerUserId: "owner", grants: [] });
    const definition = changes({ action: "change", collection: "Target", id: "same", fields: { Status: "Closed" } });
    definition.when = { kind: "button", field: "Run", table: null };
    expect(await f.run(definition)).toMatchObject({ kind: "failed", error: expect.stringContaining("person who pressed") });
    expect(f.calls).toEqual([]);
  });

  it("lets an authored source add elsewhere without granting code access to authored records", async () => {
    const f = await fixture(true, false);
    authored(f, "Source");
    expect(await f.run(changes({ action: "add", collection: "Target", fields: { Status: "Added" } }))).toMatchObject({ kind: "done" });
    expect(f.calls).toEqual([]);
    expect([...f.docs.values()].filter((doc) => doc.collection === "Target")).toHaveLength(2);
  });

  it("keeps numeric and text ids separate across destinations", async () => {
    const f = await fixture();
    const target = f.targets.get("Target");
    if (target?.kind !== "dataset") throw new Error("target");
    const primary = target.approved.definition.tables[0]!.fields[0]!;
    if (primary.type === "button") throw new Error("primary");
    primary.type = "number";
    f.rows.set("Target-dataset", new Map([[7, { id: 7, version: 1, values: { id: 7, status: "Open" } }]]));
    f.rows.set("Other-dataset", new Map([["7", { id: "7", version: 1, values: { id: "7", status: "Open" } }]]));
    expect(await f.run(changes(
      { action: "change", collection: "Target", id: "7", fields: { Status: "Number" } },
      { action: "change", collection: "Other", id: "7", fields: { Status: "Text" } },
    ))).toMatchObject({ kind: "done" });
    expect(f.calls.filter((call) => call.operationId === "edit").map((call) => call.input)).toMatchObject([{ id: 7 }, { id: "7" }]);
    await f.undo();
    expect(f.rows.get("Target-dataset")!.get(7)!.values.status).toBe("Open");
    expect(f.rows.get("Other-dataset")!.get("7")!.values.status).toBe("Open");
  });

  it("rechecks grants before each effect and retains earlier writes", async () => {
    const f = await fixture();
    f.hooks.afterEffect = () => f.setRoster({ kind: "owner", ownerUserId: "owner", grants: [{ grantId: "editor", recipientUserId: "editor", recipientEmail: "editor@example.com", files: { paths: ["Source"], versionId: null, access: "edit" }, channel: null }] });
    expect(await f.run(changes(
      { action: "add", collection: "Target", fields: { Status: "First" } },
      { action: "add", collection: "Other", fields: { Status: "Denied" } },
    ))).toMatchObject({ kind: "failed" });
    expect(f.rows.get("Target-dataset")!.size).toBe(2);
    expect(f.rows.get("Other-dataset")!.size).toBe(1);
    expect((await f.runs())[0]!.applied).toHaveLength(1);
  });

  it("retains a computed operation's hold identity across compatible re-approval", async () => {
    const f = await fixture();
    const verdicts = new Map<string, ReturnType<typeof nextReachVerdict>>();
    f.dependencies.recipientVerdicts = async (input) => input.recipients.map((recipient) => {
      const key = JSON.stringify([recipient.step, recipient.id]);
      const next = nextReachVerdict(verdicts.get(key), recipient.reach, true);
      verdicts.set(key, next);
      return next.verdict;
    });
    f.setRoster({ kind: "owner", ownerUserId: "owner", grants: [{ grantId: "editor", recipientUserId: "editor", recipientEmail: "editor@example.com", files: { paths: ["Source"], versionId: null, access: "edit" }, channel: null }] });
    const definition = changes({ action: "add", collection: "Target", fields: { Status: "Added" } });
    expect(await f.run(definition)).toMatchObject({ kind: "failed" });
    const ids = [...verdicts.keys()];
    const target = f.targets.get("Target");
    if (target?.kind !== "dataset") throw new Error("target");
    target.approved.revision += 1;
    f.setRoster(roster);
    expect(await f.run(definition)).toEqual({ kind: "wait", reason: "held" });
    expect([...verdicts.keys()]).toEqual(ids);
    expect(f.calls).toEqual([]);
    for (const [key, verdict] of verdicts) verdicts.set(key, { ...verdict, verdict: "allowed" });
    expect(await f.run(definition)).toMatchObject({ kind: "done" });
  });

  it("replays and undoes under saved compatible rules after re-approval", async () => {
    const f = await fixture();
    const definition = changes({ action: "add", collection: "Target", fields: { Status: "Added" } });
    f.hooks.crashAppend = true;
    await expect(f.run(definition)).rejects.toThrow("crash before journal append");
    const target = f.targets.get("Target");
    if (target?.kind !== "dataset") throw new Error("target");
    target.approved.revision += 1;
    target.approved.revisionSha256 = "b".repeat(64);
    f.host.resolves = () => true;
    expect(await f.run(definition)).toMatchObject({ kind: "done" });
    const calls = f.calls.filter((call) => call.operationId === "create");
    expect(calls.map((call) => [call.revision, call.revisionSha256])).toEqual([[1, "a".repeat(64)], [1, "a".repeat(64)]]);
    await f.undo();
    expect(f.rows.get("Target-dataset")!.size).toBe(1);
  });

  it("counts code-file editors when choosing approved deletion for Undo", async () => {
    const f = await fixture();
    const target = f.targets.get("Target");
    if (target?.kind !== "dataset") throw new Error("target");
    target.approved.definition.operations.forEach((operation) => { operation.access = "helper"; });
    target.grants.grants = [{ principalKey: datasetPrincipalKey("workspace", "code", "editor"), operationIds: ["create"] }];
    f.dependencies.readCode = async () => ({ text: "return { records: [{ action: 'add', collection: 'Target', fields: { Status: 'Added' } }] };", truncated: false });
    f.setRoster({ kind: "owner", ownerUserId: "owner", grants: [
      { grantId: "code", recipientUserId: "editor", recipientEmail: "editor@example.com", files: { paths: ["Source/run.js"], versionId: null, access: "edit" }, channel: null },
      { grantId: "view", recipientUserId: "editor", recipientEmail: "editor@example.com", files: { paths: ["Source"], versionId: null, access: "view" }, channel: null },
    ] });
    expect(await f.run(automation("      - run-file: run.js\n"))).toMatchObject({ kind: "done" });
    expect((await f.runs())[0]!.steps[0]!.effects).toMatchObject([{ kind: "dataset-create", deletes: [] }]);
  });

  it("rejects a path outside the workspace before resolving it", async () => {
    const f = await fixture();
    const resolve = vi.spyOn(f.dependencies.targets, "resolve");
    expect(await f.run(changes({ action: "add", collection: "../Private", fields: { Status: "Denied" } }))).toMatchObject({ kind: "failed" });
    expect(resolve.mock.calls.every(([path]) => path === "Source")).toBe(true);
    expect(f.calls).toEqual([]);
  });
});

describe("cross-Collection authored actions", () => {
  it.each([false, true])("resolves an action only in its destination from dataset source %s", async (sourceDataset) => {
    const f = await fixture(sourceDataset);
    authored(f, "Target");
    expect(await f.run(automation(actionStep("Target")))).toMatchObject({ kind: "done" });
    expect(f.calls.filter((call) => call.operationId === "action")).toMatchObject([{ datasetId: "Target-dataset" }]);
    expect(f.rows.get("Target-dataset")!.get("same")!.values.status).toBe("Acted");
    expect((await f.runs())[0]!.steps[0]!.effects[0]).toMatchObject({ kind: "dataset-action", collectionPath: "Target", rules: { datasetId: "Target-dataset" } });
    expect(await f.undo()).toMatchObject({ undone: { actionsReversed: 1 } });
    expect(f.rows.get("Target-dataset")!.get("same")!.values.status).toBe("Open");
  });

  it("does not borrow a same-named operation from the source", async () => {
    const f = await fixture(true);
    authored(f, "Source");
    expect(await f.run(automation(actionStep("Target")))).toMatchObject({ kind: "failed", error: expect.stringContaining("no approved action") });
    expect(f.calls).toEqual([]);
  });

  it("keeps authored source fields unreadable while allowing a document add and a destination action", async () => {
    const f = await fixture(true, false);
    authored(f, "Source");
    authored(f, "Other");
    expect(await f.run(automation(add("Target", false) + actionStep("Other")))).toMatchObject({ kind: "done" });
    expect(f.calls.every((call) => call.datasetId !== "Source-dataset")).toBe(true);
    const blocked = await fixture(true);
    authored(blocked, "Source");
    authored(blocked, "Target");
    expect(await blocked.run(automation(actionStep("Target").replace("{id: same}", "{id: '=record.Status'}")))).toMatchObject({ kind: "failed" });
    expect(blocked.calls).toEqual([]);
  });

  it.each([add("Target", true), find("Target", true), '      - set: {Status: Closed}\n        operation: rows.edit\n'])("keeps generic steps generated-only: %s", async (steps) => {
    const f = await fixture(true);
    authored(f, "Source");
    authored(f, "Target");
    expect(await f.run(automation(steps))).toMatchObject({ kind: "failed", error: expect.stringContaining("written or changed") });
    expect(f.calls).toEqual([]);
  });

  it("replays a committed action after a journal failure and retains the destination after it moves", async () => {
    const f = await fixture();
    authored(f, "Target");
    const definition = automation(actionStep("Target"));
    f.hooks.crashAppend = true;
    await expect(f.run(definition)).rejects.toThrow("crash before journal append");
    f.move("Target", "Moved");
    expect(await f.run(definition)).toMatchObject({ kind: "done" });
    expect(f.rows.get("Target-dataset")!.get("same")!.version).toBe(2);
    expect((await f.runs())[0]!.steps[0]!.effects[0]).toMatchObject({ collectionPath: "Moved" });
    expect(await f.undo()).toMatchObject({ undone: { actionsReversed: 1 } });
  });

  it("does not invent a reverse action", async () => {
    const f = await fixture();
    authored(f, "Target", false);
    expect(await f.run(automation(actionStep("Target")))).toMatchObject({ kind: "done" });
    expect(await f.undo()).toMatchObject({ undone: { actions: 1, actionsReversed: 0 } });
    expect(f.calls.some((call) => call.operationId === "reverse")).toBe(false);
  });

  it.each([null, "Source"])("treats invoke destination %s as the source", async (collection) => {
    const f = await fixture(true);
    authored(f, "Source");
    const steps = actionStep("Source");
    expect(await f.run(automation(collection === null ? steps.replace("        collection: Source\n", "") : steps))).toMatchObject({ kind: "done" });
    expect(f.calls).toMatchObject([{ datasetId: "Source-dataset", operationId: "action" }]);
  });

  it("rejects document destinations for invoke", async () => {
    const f = await fixture(true, false);
    authored(f, "Source");
    expect(await f.run(automation(actionStep("Target")))).toMatchObject({ kind: "failed", error: "Only a dataset Collection has actions." });
    expect(f.calls).toEqual([]);
  });

  it.each(["descriptor", "revision"])("refuses a changed action destination %s on replay", async (change) => {
    const f = await fixture();
    const target = authored(f, "Target");
    const definition = automation(actionStep("Target"));
    f.hooks.crashAppend = true;
    await expect(f.run(definition)).rejects.toThrow();
    target.approved = { ...target.approved, ...(change === "descriptor" ? { datasetId: "replacement" } : { revision: 2, revisionSha256: "b".repeat(64) }) };
    expect(await f.run(definition)).toMatchObject({ kind: "failed", error: "Collection rules changed after this run started." });
    expect(f.calls.filter((call) => call.operationId === "action")).toHaveLength(1);
  });

  it("waits for the destination host without invoking", async () => {
    const f = await fixture();
    authored(f, "Target");
    f.hooks.hostDown = true;
    expect(await f.run(automation(actionStep("Target")))).toMatchObject({ kind: "wait" });
    expect(f.calls).toEqual([]);
    f.hooks.hostDown = false;
    expect(await f.run(automation(actionStep("Target")))).toMatchObject({ kind: "done" });
  });

  it("reverses mixed actions in journal order across datasets and selected branches", async () => {
    const f = await fixture();
    authored(f, "Target");
    authored(f, "Other");
    const branch = '      - if: "true"\n        do:\n' + actionStep("Other").replace(/^/gm, "    ").trimEnd() + '\n        otherwise:\n' + actionStep("Target").replace(/^/gm, "    ").trimEnd() + '\n';
    expect(await f.run(automation(actionStep("Target") + branch))).toMatchObject({ kind: "done" });
    expect(f.calls.filter((call) => call.operationId === "action").map((call) => call.datasetId)).toEqual(["Target-dataset", "Other-dataset"]);
    expect(await f.undo()).toMatchObject({ undone: { actionsReversed: 2 } });
    expect(f.calls.filter((call) => call.operationId === "reverse").map((call) => call.datasetId)).toEqual(["Other-dataset", "Target-dataset"]);
  });

  it("rechecks action grants immediately before invocation", async () => {
    const f = await fixture();
    authored(f, "Target");
    const save = f.dependencies.store.save;
    f.dependencies.store.save = async (run) => {
      await save(run);
      f.setRoster({ kind: "owner", ownerUserId: "owner", grants: [{ grantId: "editor", recipientUserId: "person", recipientEmail: "person@example.com", files: { paths: ["Source"], access: "edit", versionId: null }, channel: null }] });
    };
    expect(await f.run(automation(actionStep("Target")))).toMatchObject({ kind: "failed" });
    expect(f.calls).toEqual([]);
  });

  it("resumes a destination action after unused read access is removed", async () => {
    const f = await fixture();
    const target = authored(f, "Target");
    target.approved.definition.operations = target.approved.definition.operations.map((operation) => ({ ...operation, access: "helper" }));
    f.setRoster({ kind: "owner", ownerUserId: "owner", grants: [{ grantId: "editor", recipientUserId: "person", recipientEmail: "person@example.com",
      files: { paths: ["Source"], access: "edit", versionId: null }, channel: null }] });
    const principalKey = datasetPrincipalKey("workspace", "editor", "person");
    target.grants = { workspaceId: "workspace", grants: [{ principalKey, operationIds: ["action", "read"] }] };
    const definition = automation(actionStep("Target"));
    f.hooks.crashAppend = true;
    await expect(f.run(definition)).rejects.toThrow("crash before journal append");
    expect((await f.runs())[0]!.readableFields).toEqual([]);
    target.grants = { workspaceId: "workspace", grants: [{ principalKey, operationIds: ["action"] }] };
    expect(await f.run(definition)).toMatchObject({ kind: "done" });
    expect(f.calls.every((call) => call.operationId === "action")).toBe(true);
    expect(f.rows.get("Target-dataset")!.get("same")!.version).toBe(2);
  });

  it("checks destination grants against source editors before invoking", async () => {
    const f = await fixture();
    authored(f, "Target");
    f.setRoster({ kind: "owner", ownerUserId: "owner", grants: [{ grantId: "editor", recipientUserId: "editor", recipientEmail: "editor@test.local", files: { paths: ["Source"], versionId: null, access: "edit" }, channel: null }] });
    expect(await f.run(automation(actionStep("Target")))).toMatchObject({ kind: "failed" });
    expect(f.calls).toEqual([]);
  });

  it("requires destination grants for the declared reverse as well as the forward action", async () => {
    const f = await fixture();
    const target = authored(f, "Target");
    target.approved.definition.operations = target.approved.definition.operations.map((operation) => ({ ...operation, access: "helper" }));
    const editor = { grantId: "editor", recipientUserId: "person", recipientEmail: "person@example.com", files: { paths: ["Source"], versionId: null, access: "edit" as const }, channel: null };
    const roster: ReachRoster = { kind: "owner", ownerUserId: "owner", grants: [editor] };
    f.setRoster(roster);
    target.grants = { workspaceId: "workspace", grants: [{ principalKey: datasetPrincipalKey("workspace", "editor", "person"), operationIds: ["action"] }] };
    expect(await f.run(automation(actionStep("Target")))).toMatchObject({ kind: "done" });
    const reach = await automationUndoReach(await f.runs(), f.dependencies.targets, () => "Target", null, f.host);
    expect(reach).toMatchObject([{ kind: "dataset-operation", datasetId: "Target-dataset", operation: { operationId: "reverse" } }]);
    expect(checkAutomationReach(roster, { id: "test", collection: { path: "Source", name: "Source" }, codeFiles: [], steps: reach }))
      .toMatchObject([{ allowed: false }]);
    expect(f.calls.some((call) => call.operationId === "reverse")).toBe(false);
    target.grants = { ...target.grants, grants: target.grants.grants.map((grant) => ({ ...grant, operationIds: [...grant.operationIds, "reverse"] })) };
    const allowed = await automationUndoReach(await f.runs(), f.dependencies.targets, () => "Target", null, f.host);
    expect(checkAutomationReach(roster, { id: "test", collection: { path: "Source", name: "Source" }, codeFiles: [], steps: allowed }))
      .toMatchObject([{ allowed: true }]);
    expect(await f.undo()).toMatchObject({ undone: { actionsReversed: 1 } });
  });

  it("requires the presser's destination operation and distinguishes confirmations across datasets", async () => {
    const f = await fixture();
    const target = authored(f, "Target", false);
    const other = authored(f, "Other", false);
    const definition = automation(actionStep("Target") + actionStep("Other"));
    const inventory = automationInventory(definition, "Source", (path) => f.targets.get(path)!, null);
    const describe = async (id: string) => {
      const own = id === target.approved.datasetId ? target : other;
      return { ...own.approved, name: own.collection.name, tables: own.approved.definition.tables, operations: own.approved.definition.operations };
    };
    expect(await canPressInventory(inventory)).toBe(false);
    expect(await canPressInventory(inventory, describe)).toBe(true);
    expect(await canPressInventory(inventory, async (id) => ({ ...await describe(id), operations: id === other.approved.datasetId ? [] : (await describe(id)).operations }))).toBe(false);
    expect(await canPressInventory(inventory, async () => describe(target.approved.datasetId))).toBe(false);
    expect(irreversibleActionsOf(definition, "Source", inventory)).toEqual([
      { name: "Target-dataset/rows.act", label: "Target: Act" }, { name: "Other-dataset/rows.act", label: "Other: Act" },
    ]);
  });

  it("keeps caller access during approval re-indexing while requiring every operation", async () => {
    const f = await fixture();
    const target = authored(f, "Target");
    const inventory = automationInventory(automation(actionStep("Target")), "Source", (path) => f.targets.get(path)!, null);
    const description = { ...target.approved, revision: 2, revisionSha256: "b".repeat(64),
      name: target.collection.name, tables: target.approved.definition.tables, operations: target.approved.definition.operations };
    expect(await canPressInventory(inventory, async () => description)).toBe(true);
    expect(await canPressInventory(inventory, async () => ({ ...description, operations: [] }))).toBe(false);
    expect(await canPressInventory(inventory, async () => ({ ...description, datasetId: "replacement" }))).toBe(false);
  });
});

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


describe("Find limits and admission", () => {
  function populate(f: Awaited<ReturnType<typeof fixture>>, dataset: boolean, count: number) {
    if (dataset) {
      const rows = f.rows.get("Target-dataset")!;
      rows.clear();
      for (let i = 0; i < count; i += 1) rows.set(i, { id: i, version: 1, values: { id: i, status: "Open" } });
    } else {
      for (const [key, doc] of f.docs) if (doc.collection === "Target") f.docs.delete(key);
      for (let i = 0; i < count; i += 1) f.docs.set("Target/" + i, { id: "target-" + i, path: "Target/" + i + ".md", collection: "Target", status: "Open" });
    }
  }

  it.each([false, true])("rereads Find results in bounded parallel batches, preserving order and later changes, dataset=%s", async (dataset) => {
    const f = await fixture(false, dataset);
    populate(f, dataset, 17);
    let active = 0, peak = 0, reads = 0;
    const read = async <T>(index: number, work: () => Promise<T>): Promise<T> => {
      reads += 1;
      active += 1;
      peak = Math.max(peak, active);
      try {
        // Earlier records finish last without relying on timers.
        for (let turn = 0; turn < 16 - index % 8; turn += 1) await Promise.resolve();
        return await work();
      } finally { active -= 1; }
    };
    if (dataset) {
      const invoke = f.host.invoke;
      f.host.invoke = (context, request) => {
        const input = request.input as { limit?: number; filters?: { value: number }[] };
        return request.datasetId === "Target-dataset" && request.operationId === "read" && input.limit === 1
          ? read(input.filters![0]!.value, () => invoke(context, request)) : invoke(context, request);
      };
    } else {
      const withReads = f.dependencies.withReads;
      f.dependencies.withReads = (work) => withReads((reader) => work({ ...reader,
        getCollectionRecord: (request) => request.collectionPath === "Target"
          ? read(Number(request.recordId.slice("target-".length)), () => reader.getCollectionRecord(request))
          : reader.getCollectionRecord(request),
      }));
    }
    const task = automation(find("Target", dataset) + set(dataset, "found", "First") + set(dataset, "found", "=record.Status + '-Second'"));
    expect(await f.run(task)).toEqual({ kind: "done" });
    expect(reads).toBe(34);
    expect(peak).toBe(8);
    expect(active).toBe(0);
    const saved = (await f.runs())[0]!;
    for (const step of saved.steps.slice(1)) {
      expect(step.effects.map((effect) => effect.kind === "dataset-edit" || effect.kind === "set" ? effect.target.recordId
        : null)).toEqual(Array.from({ length: 17 }, (_, i) => dataset ? i : "target-" + i));
    }
    if (dataset) expect([...f.rows.get("Target-dataset")!.values()].map((row) => row.values.status)).toEqual(Array(17).fill("First-Second"));
    else expect([...f.docs.values()].filter((doc) => doc.collection === "Target").map((doc) => doc.status)).toEqual(Array(17).fill("First-Second"));
  });

  it.each([false, true])("drains failed bound-read batches before returning and starts no further batch, dataset=%s", async (dataset) => {
    const f = await fixture(false, dataset);
    populate(f, dataset, 17);
    let active = 0, reads = 0;
    const read = async <T>(index: number, work: () => Promise<T>): Promise<T> => {
      reads += 1;
      active += 1;
      try {
        if (index === 0) throw new Error("Bound read failed");
        for (let turn = 0; turn < 16; turn += 1) await Promise.resolve();
        return await work();
      } finally { active -= 1; }
    };
    if (dataset) {
      const invoke = f.host.invoke;
      f.host.invoke = (context, request) => {
        const input = request.input as { limit?: number; filters?: { value: number }[] };
        return request.datasetId === "Target-dataset" && request.operationId === "read" && input.limit === 1
          ? read(input.filters![0]!.value, () => invoke(context, request)) : invoke(context, request);
      };
    } else {
      const withReads = f.dependencies.withReads;
      f.dependencies.withReads = (work) => withReads((reader) => work({ ...reader,
        getCollectionRecord: (request) => request.collectionPath === "Target"
          ? read(Number(request.recordId.slice("target-".length)), () => reader.getCollectionRecord(request))
          : reader.getCollectionRecord(request),
      }));
    }
    const activeAtSessionClose: number[] = [];
    const withReads = f.dependencies.withReads;
    f.dependencies.withReads = (work) => withReads(async (reader) => {
      try { return await work(reader); }
      finally { activeAtSessionClose.push(active); }
    });
    expect(await f.run(automation(find("Target", dataset) + set(dataset, "found"))))
      .toEqual({ kind: "failed", error: "Bound read failed", timedOut: false });
    expect(reads).toBe(8);
    expect(active).toBe(0);
    expect(activeAtSessionClose.length).toBeGreaterThan(0);
    expect(activeAtSessionClose.every((count) => count === 0)).toBe(true);
    expect((await f.runs())[0]!.steps).toHaveLength(1);
    if (dataset) expect([...f.rows.get("Target-dataset")!.values()].map((row) => row.values.status)).toEqual(Array(17).fill("Open"));
    else expect([...f.docs.values()].filter((doc) => doc.collection === "Target").map((doc) => doc.status)).toEqual(Array(17).fill("Open"));
  });

  it.each([false, true])("accepts 500 matches and refuses 501 without partial binding, dataset=%s", async (dataset) => {
    for (const count of [500, 501]) {
      const f = await fixture(false, dataset);
      populate(f, dataset, count);
      const outcome = await f.run(automation(find("Target", dataset)));
      expect(outcome).toEqual(count === 500 ? { kind: "done" } : { kind: "failed", timedOut: false,
        error: "The Find in step 1 matched more than 500 records. Narrow its condition, then try again." });
      const saved = await f.runs();
      if (count === 500) {
        expect(saved[0]?.steps[0]?.output).toMatchObject({ kind: "find", records: Array.from({ length: 500 }, () => expect.objectContaining({ id: expect.any(String) })) });
      } else expect(saved).toEqual([]);
      if (dataset) {
        const pages = f.calls.filter((call) => call.operationId === "read");
        expect(pages).toHaveLength(5);
        expect(pages.map((call) => call.input)).toEqual(Array.from({ length: 5 }, (_, index) => ({ limit: 100,
          filters: [{ fieldId: "status", value: "Open" }], ...(index === 0 ? {} : { after: { id: index * 100 - 1, value: index * 100 - 1 } }) })));
      }
    }
  });

  it.each(["cursor", "identity"])("refuses a repeated dataset %s without any effects", async (mode) => {
    const f = await fixture();
    let pages = 0;
    f.hooks.readPage = () => {
      pages += 1;
      return { result: { rows: [{ id: mode === "identity" ? 1 : pages, version: 1, values: { status: "Open" } }],
        nextCursor: pages === 1 ? { id: 7, value: "same" } : { value: "same", id: 7 } }, revision: 1, replayed: false };
    };
    expect(await f.run(automation(find("Target", true) + set(true, "found")))).toMatchObject({ kind: "failed",
      error: expect.stringContaining(mode === "cursor" ? "repeated cursor" : "duplicate record identity") });
    expect(pages).toBe(2);
    expect(f.calls.every((call) => call.operationId === "read")).toBe(true);
    expect(await f.runs()).toEqual([]);
  });

  it("reduces the final page to remaining capacity and stops at its overflow cursor", async () => {
    const f = await fixture();
    populate(f, true, 501);
    f.hooks.readPage = (request, found) => {
      const input = request.input as { limit: number; after?: { id: number } };
      const start = input.after === undefined ? 0 : input.after.id + 1;
      const page = found.slice(start, start + Math.min(37, input.limit));
      return { result: { rows: page, nextCursor: { id: page.at(-1)!.id } }, revision: 1, replayed: false };
    };
    expect(await f.run(automation(find("Target", true)))).toMatchObject({ kind: "failed", error: expect.stringContaining("matched more than 500 records") });
    expect(f.calls).toHaveLength(14);
    expect(f.calls.at(-1)!.input).toMatchObject({ limit: 19, after: { id: 480 } });
    expect(await f.runs()).toEqual([]);
  });

  it("preserves numeric and text identities with the same printed ID", async () => {
    const f = await fixture();
    const rows = f.rows.get("Target-dataset")!;
    rows.clear();
    rows.set(1, { id: 1, version: 1, values: { id: 1, status: "Open" } });
    rows.set("1", { id: "1", version: 1, values: { id: "1", status: "Open" } });
    expect(await f.run(automation(find("Target", true)))).toEqual({ kind: "done" });
    expect((await f.runs())[0]?.steps[0]?.output).toMatchObject({ kind: "find", records: [{ key: 1 }, { key: "1" }] });
  });

  it.each([false, true])("saves a Find before a busy later step and recovers its order, dataset=%s", async (dataset) => {
    const f = await fixture(false, dataset);
    populate(f, dataset, 2);
    const evaluator = f.dependencies.evaluator;
    f.dependencies.evaluator = { ...evaluator, evaluate: async () => "busy" };
    const rule = automation(find("Target", dataset) + set(dataset, "found", "'=\"Closed\"'"));
    expect(await f.run(rule)).toEqual({ kind: "wait", reason: "busy" });
    const output = (await f.runs())[0]?.steps[0]?.output;
    expect(output).toMatchObject({ kind: "find", records: [{ id: expect.any(String) }, { id: expect.any(String) }] });
    if (dataset) f.rows.get("Target-dataset")!.set(2, { id: 2, version: 1, values: { id: 2, status: "Open" } });
    else f.docs.set("Target/2", { id: "target-2", path: "Target/2.md", collection: "Target", status: "Open" });
    f.dependencies.evaluator = evaluator;
    expect(await f.run(rule)).toEqual({ kind: "done" });
    expect((await f.runs())[0]?.steps[0]?.output).toEqual(output);
    if (dataset) expect([...f.rows.get("Target-dataset")!.values()].map((row) => row.values.status)).toEqual(["Closed", "Closed", "Open"]);
    else expect([...f.docs.values()].filter((doc) => doc.collection === "Target").map((doc) => doc.status)).toEqual(["Closed", "Closed", "Open"]);
  });

  it.each([false, true])("admits 1000 assignments across repeated fields and refuses an Add before effects, dataset=%s", async (dataset) => {
    const f = await fixture(false, dataset);
    populate(f, dataset, 500);
    if (dataset) f.hooks.beforeEffect = () => { f.hooks.beforeEffect = undefined; f.rows.get("Target-dataset")!.get(0)!.version += 1; };
    const rule = automation(find("Target", dataset) + set(dataset, "found", "First") + set(dataset, "found", "Last") + add("Target", dataset));
    f.hooks.crashAppend = true;
    await expect(f.run(rule)).rejects.toThrow("crash before journal append");
    expect(await f.run(rule)).toMatchObject({ kind: "failed", error: "Step 4 would change more than 1000 fields across this run. Narrow its Find steps, or split it into smaller automations." });
    const run = (await f.runs())[0]!;
    expect(run.steps).toHaveLength(3);
    expect(run.applied).toHaveLength(1000);
    expect(await f.undo()).toMatchObject({ undone: { reverted: 500 } });
    if (dataset) expect([...f.rows.get("Target-dataset")!.values()].map((row) => row.values.status)).toEqual(Array(500).fill("Open"));
    else expect([...f.docs.values()].filter((doc) => doc.collection === "Target").map((doc) => doc.status)).toEqual(Array(500).fill("Open"));
  }, 120_000);

  it("reserves dataset replan bytes before admitting a wide later step", async () => {
    const f = await fixture();
    populate(f, true, 500);
    const big = "x".repeat(1500);
    for (const row of f.rows.get("Target-dataset")!.values()) row.values.status = big;
    const rule = automation("      - set: {Status: Started}\n" + find("Target", true).replace('record.Status == "Open"', "'true'") + set(true, "found"));
    expect(await f.run(rule)).toMatchObject({ kind: "failed", error: "Step 3 would make this run change more data than dohc can save for it. Narrow its Find steps, or split it into smaller automations." });
    expect(f.calls.every((call) => call.operationId === "read")).toBe(true);
    expect((await f.runs())[0]?.steps).toHaveLength(2);
    expect(f.docs.get("Source/same")!.status).toBe("Started");
    expect([...f.rows.get("Target-dataset")!.values()].every((row) => row.values.status === big)).toBe(true);
    expect(await f.undo()).toMatchObject({ undone: { reverted: 1 } });
    expect(f.docs.get("Source/same")!.status).toBe("Open");
  });

  it("retires a Find-only run before another definition writes, so reverting cannot revive it", async () => {
    const f = await fixture();
    const first = automation(find("Target", true) + "      - set: {Status: '=\"A\"'}\n");
    const evaluator = f.dependencies.evaluator;
    f.dependencies.evaluator = { ...evaluator, evaluate: async () => "busy" };
    expect(await f.run(first)).toEqual({ kind: "wait", reason: "busy" });
    f.dependencies.evaluator = evaluator;
    const other = automation("      - set: {Status: B}\n      - set: {Status: '=missing()'}\n");
    expect(await f.run(other)).toMatchObject({ kind: "failed" });
    expect((await f.runs()).find((run) => run.steps[0]?.output?.kind === "find")?.superseded).toBe(true);
    expect(await f.run(first)).toMatchObject({ kind: "failed", error: expect.stringContaining("changed after this run began") });
    expect(f.docs.get("Source/same")!.status).toBe("B");
  });
});
