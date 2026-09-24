import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import type { DatasetDefinition } from "@dohc/security-contract/dataset";
import { describeDatasetRevision } from "@dohc/security-contract/dataset-artifacts";
import { createDatasetJournal, type DatasetScope, type JournalDb } from "./journal.ts";
import { createDatasetSupervisor } from "./supervisor.ts";
import { createDatasetHost } from "./dataset-host.ts";
import {
  createDatasetAutomationClaims,
  DATASET_AUTOMATION_CHAIN_STOPPED,
  DATASET_AUTOMATION_CLAIM_LIMIT,
  DATASET_AUTOMATION_CLAIMS_PER_COMMIT,
  DATASET_AUTOMATION_RECLAIM_EXHAUSTED,
  type DatasetActor,
  type DatasetAutomationClaim,
  type DatasetAutomationClaims,
  type DatasetChangeKind,
} from "./dataset-automation-claims.ts";

vi.setConfig({ testTimeout: 30_000 });
const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const digest = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const id = (number: number) => `00000000-0000-4000-8000-${String(number).padStart(12, "0")}`;
const scope = { workspaceId: "workspace", datasetId: id(1) };
const TASKS = id(2), STATUS = id(4), NOTES = id(5), TAGS = id(6);
const authorize = () => {};

function drain(claims: Pick<DatasetAutomationClaims, "next">): DatasetAutomationClaim[] {
  const started: DatasetAutomationClaim[] = [];
  for (let claim = claims.next(scope.workspaceId); claim; claim = claims.next(scope.workspaceId)) started.push(claim);
  return started;
}
function subscription(automationId: string, kinds: DatasetChangeKind[], fieldIds: string[] | null = null, tableId = TASKS) {
  return { automationId, tableId, kinds, fieldIds, definitionHash: digest(automationId) };
}
function transactions(db: DatabaseSync) {
  return <T>(run: () => T): T => {
    db.exec("BEGIN IMMEDIATE");
    try { const result = run(); db.exec("COMMIT"); return result; } catch (error) { db.exec("ROLLBACK"); throw error; }
  };
}

// The journal and ledger alone. A commit's changeset comes from a session
// over a copy of the dataset, the way the worker prepares one.
const ledgerSchema = "CREATE TABLE tasks(id TEXT PRIMARY KEY NOT NULL,status TEXT NOT NULL,notes TEXT NOT NULL); CREATE TABLE tags(id INTEGER PRIMARY KEY,name TEXT NOT NULL);";
const ledgerDefinition: DatasetDefinition = {
  formatVersion: 1, datasetId: scope.datasetId, name: "Tasks", schemaPath: "tasks/schema.sql", operationsPath: "tasks/operations.js",
  tables: [
    { tableId: TASKS, name: "Tasks", sqlName: "tasks", primaryKey: "id", fields: [
      { fieldId: id(3), name: "ID", sqlColumn: "id", type: "text", required: true, unique: true },
      { fieldId: STATUS, name: "Status", sqlColumn: "status", type: "text", required: true, unique: false },
      { fieldId: NOTES, name: "Notes", sqlColumn: "notes", type: "text", required: true, unique: false },
    ] },
    { tableId: TAGS, name: "Tags", sqlName: "tags", primaryKey: "id", fields: [
      { fieldId: id(7), name: "ID", sqlColumn: "id", type: "number", required: true, unique: true },
      { fieldId: id(8), name: "Name", sqlColumn: "name", type: "text", required: true, unique: false },
    ] },
  ],
  operations: [{ operationId: id(9), name: "read", label: "Read", tableId: TASKS, kind: "read", access: "owner", readOnly: true, fieldIds: [STATUS] }],
};
const ledgerRevision = describeDatasetRevision({ definition: ledgerDefinition, revision: 1, schemaSql: ledgerSchema, operationSource: "globalThis.operations={};" });

function ledger() {
  const directory = mkdtempSync(join(tmpdir(), "dohc-automation-claims-"));
  const seed = new DatabaseSync(join(directory, "seed.sqlite")); seed.exec(ledgerSchema); seed.close();
  const data = new DatabaseSync(":memory:"); data.exec(ledgerSchema);
  const columns = Object.fromEntries(["tasks", "tags"].map(table => [table, data.prepare(`PRAGMA table_info("${table}")`).all().map(column => String(column.name))]));
  const db = new DatabaseSync(join(directory, "host.sqlite")); db.exec("PRAGMA journal_mode=WAL;");
  cleanups.push(() => { data.close(); db.close(); rmSync(directory, { recursive: true, force: true }); });
  const transaction = transactions(db);
  // The ledger reads through this, so a test can count its statements.
  const statements: string[] = [];
  const counted: JournalDb = { exec: sql => db.exec(sql), prepare: sql => { statements.push(sql); return db.prepare(sql); } };
  const wakes: Array<{ scope: DatasetScope; inTransaction: boolean }> = [];
  let clock = 1_000;
  const open = () => createDatasetAutomationClaims({ db: counted, transaction, nowMs: () => clock,
    wake: woken => wakes.push({ scope: woken, inTransaction: db.isTransaction }) });
  let claims = open();
  const journal = createDatasetJournal({ db, transaction });
  let cursor = journal.initialize({ scope, hostEpoch: "host-1", approvedRevisionHash: ledgerRevision.revisionSha256, source: "globalThis.operations={};",
    schemaSql: ledgerSchema, definitionJson: JSON.stringify(ledgerRevision), checkpoint: readFileSync(join(directory, "seed.sqlite")), authorize });
  const recorded: number[] = [];
  function commit(sql: string, actor: DatasetActor = { kind: "owner" }, key = `change-${cursor.revision + 1}`) {
    const session = data.createSession(); data.exec(sql);
    const changeset = session.changeset(); session.close();
    const result = journal.commitOperation({ expected: cursor, proposalId: `proposal-${key}`, operation: "change", callerKey: "caller", idempotencyKey: key,
      payloadSha256: digest(key), resultJson: "{}", changeset, changesetSha256: digest(changeset), attachedFileIds: [], authorize,
      recordCommit: committed => { recorded.push(committed.cursor.revision); return claims.recordCommit({ ...committed, columns, approved: ledgerRevision, actor }); } });
    if (result.kind === "committed") cursor = result.event.cursor;
    return result;
  }
  return { db, statements, wakes, recorded, commit, get claims() { return claims; }, reopen() { claims = open(); }, tick(ms: number) { clock += ms; } };
}

it("claims each changed record once per subscribed automation, by table, change kind, and field", async () => {
  const f = ledger();
  f.claims.subscribe(scope, subscription("collection:tasks#status", ["changed"], [STATUS]));
  f.claims.subscribe(scope, subscription("collection:tasks#arrivals", ["added", "removed"]));
  f.claims.subscribe(scope, subscription("collection:tags#new", ["added"], null, TAGS));
  f.commit("INSERT INTO tasks VALUES('a','Open','first'),('b','Open','second')");
  f.commit("UPDATE tasks SET status='Done' WHERE id='a'");
  f.commit("UPDATE tasks SET notes='edited' WHERE id='a'");
  f.commit("DELETE FROM tasks WHERE id='b'");
  expect(f.recorded).toEqual([1, 2, 3, 4]);
  // Claims start in commit order; within a commit, in the changeset's order.
  const started = drain(f.claims);
  expect(started.map(claim => claim.revision)).toEqual([1, 1, 2, 4]);
  expect(started.map(claim => `${claim.revision} ${claim.fact.kind} ${claim.fact.recordId} ${claim.automationId}`).sort()).toEqual([
    "1 added a collection:tasks#arrivals",
    "1 added b collection:tasks#arrivals",
    "2 changed a collection:tasks#status",
    "4 removed b collection:tasks#arrivals",
  ]);
  expect(started[2]).toMatchObject({ state: "running", attempts: 1, run: 1, depth: 0, actor: { kind: "owner" }, hostEpoch: "host-1",
    fact: { tableId: TASKS, fields: [{ fieldId: STATUS, previous: "Open", next: "Done" }] } });
  expect(new Set(started.map(claim => claim.claimId)).size).toBe(started.length);
  expect(f.claims.next(scope.workspaceId)).toBeNull();
  // Each wake comes after its commit, and only a commit that claimed wakes.
  await Promise.resolve();
  expect(f.wakes).toEqual([1, 2, 4].map(() => ({ scope, inTransaction: false })));
});

it("costs one indexed read for a commit no automation watches", () => {
  const f = ledger();
  f.statements.length = 0;
  f.commit("INSERT INTO tasks VALUES('a','Open','')");
  expect(f.statements).toHaveLength(1);
  const plan = f.db.prepare(`EXPLAIN QUERY PLAN ${f.statements[0]}`).all(scope.workspaceId, scope.datasetId);
  expect(plan.map(step => String(step.detail))).toEqual([expect.stringMatching(/^SEARCH dohc_dataset_automation_subscriptions USING INDEX/)]);
});

it("claims nothing for a receipt replay", () => {
  const f = ledger();
  f.claims.subscribe(scope, subscription("collection:tasks#arrivals", ["added"]));
  expect(f.commit("INSERT INTO tasks VALUES('a','Open','')", { kind: "owner" }, "retry").kind).toBe("committed");
  expect(f.commit("SELECT 1", { kind: "owner" }, "retry").kind).toBe("replayed");
  expect(f.recorded).toEqual([1]);
  expect(drain(f.claims)).toHaveLength(1);
});

it("stops at the claim limit, with one failed claim that says so", () => {
  const f = ledger();
  f.claims.subscribe(scope, subscription("collection:tasks#a", ["added"]));
  f.claims.subscribe(scope, subscription("collection:tasks#b", ["added"]));
  const rows = Array.from({ length: 150 }, (_, index) => `('${String(index).padStart(3, "0")}','Open','')`);
  f.commit(`INSERT INTO tasks VALUES${rows.join(",")}`);
  expect(drain(f.claims)).toHaveLength(DATASET_AUTOMATION_CLAIMS_PER_COMMIT);
  expect(f.db.prepare("SELECT automation_id,state,attempts,error FROM dohc_dataset_automation_claims WHERE state!='running'").all())
    .toEqual([{ automation_id: "collection:tasks#a", state: "failed", attempts: 0, error: DATASET_AUTOMATION_CLAIM_LIMIT }]);
});

it("never claims an automation's own commit, records it for History, and stops the chain at depth 4", () => {
  const f = ledger();
  f.claims.subscribe(scope, subscription("collection:tasks#a", ["added"]));
  f.claims.subscribe(scope, subscription("collection:tasks#b", ["added"]));
  f.commit("INSERT INTO tasks VALUES('a','Open','')", { kind: "automation", automationId: "collection:tasks#a", depth: 1 });
  const [claim, ...rest] = drain(f.claims);
  expect(rest).toEqual([]);
  expect(claim).toMatchObject({ automationId: "collection:tasks#b", depth: 1, actor: { kind: "automation", automationId: "collection:tasks#a", depth: 1 } });
  f.commit("INSERT INTO tasks VALUES('b','Open','')", { kind: "automation", automationId: "collection:tasks#b", depth: 4 });
  expect(f.claims.next(scope.workspaceId)).toBeNull();
  const stopped = f.db.prepare("SELECT claim_id,automation_id,state,attempts,error FROM dohc_dataset_automation_claims WHERE revision=2").get()!;
  expect(stopped).toMatchObject({ automation_id: "collection:tasks#a", state: "failed", attempts: 0, error: DATASET_AUTOMATION_CHAIN_STOPPED });
  expect(() => f.claims.retry({ workspaceId: scope.workspaceId, claimId: String(stopped.claim_id) })).toThrow("cannot run again");
  expect(f.db.prepare("SELECT revision,automation_id,depth FROM dohc_dataset_automation_revisions ORDER BY revision").all()).toEqual([
    { revision: 1, automation_id: "collection:tasks#a", depth: 1 }, { revision: 2, automation_id: "collection:tasks#b", depth: 4 },
  ]);
});

it("requeues a claim a dead process left running, and fails it once it died at the attempt cap", () => {
  const f = ledger();
  f.claims.subscribe(scope, subscription("collection:tasks#a", ["added"]));
  f.commit("INSERT INTO tasks VALUES('a','Open','')");
  const first = f.claims.next(scope.workspaceId)!;
  f.reopen();
  expect(() => f.claims.settle(first, { state: "done" })).toThrow("no longer current");
  const second = f.claims.next(scope.workspaceId)!;
  expect(second).toMatchObject({ claimId: first.claimId, attempts: 2, run: 1 });
  f.reopen();
  expect(f.claims.next(scope.workspaceId)).toBeNull();
  expect(f.db.prepare("SELECT state,error FROM dohc_dataset_automation_claims").get()).toEqual({ state: "failed", error: DATASET_AUTOMATION_RECLAIM_EXHAUSTED });
  expect(f.claims.retry(second)).toMatchObject({ state: "pending", run: 2, error: null });
});

it("raises the run on Try again and keeps the claim's facts", () => {
  const f = ledger();
  f.claims.subscribe(scope, subscription("collection:tasks#status", ["changed"]));
  f.commit("INSERT INTO tasks VALUES('a','Open','')");
  f.commit("UPDATE tasks SET status='Done' WHERE id='a'");
  const started = f.claims.next(scope.workspaceId)!;
  expect(f.claims.retry(started)).toMatchObject({ state: "running", run: 1 });
  expect(f.claims.settle(started, { state: "failed", error: "Budget has no approved edit that changes Finished on." }))
    .toMatchObject({ state: "failed", error: "Budget has no approved edit that changes Finished on." });
  f.tick(5);
  expect(f.claims.retry(started)).toMatchObject({ state: "pending", run: 2, attempts: 1, error: null, updatedAtMs: 1_005 });
  const again = f.claims.next(scope.workspaceId)!;
  expect(again).toMatchObject({ claimId: started.claimId, run: 2, attempts: 2, fact: started.fact });
  expect(f.claims.settle(again, { state: "done" }).state).toBe("done");
  expect(() => f.claims.retry(again)).toThrow("already finished");
});

it("carries small values whole and names fields whose values are too large", () => {
  const f = ledger();
  f.claims.subscribe(scope, subscription("collection:tasks#arrivals", ["added"]));
  f.commit(`INSERT INTO tasks VALUES('a','Open','${"x".repeat(10_000)}')`);
  expect(f.claims.next(scope.workspaceId)!.fact.fields).toEqual([
    { fieldId: id(3), previous: null, next: "a" },
    { fieldId: STATUS, previous: null, next: "Open" },
    { fieldId: NOTES, previous: null, next: null, truncated: true },
  ]);
});

it("keeps subscriptions current, and forgets a deleted dataset", () => {
  const f = ledger();
  f.claims.subscribe(scope, subscription("collection:tasks#a", ["added"]));
  f.claims.subscribe(scope, subscription("collection:tasks#a", ["changed", "added"], [STATUS]));
  expect(f.claims.subscriptions(scope)).toEqual([subscription("collection:tasks#a", ["added", "changed"], [STATUS])]);
  expect(() => f.claims.subscribe(scope, subscription("collection:tasks#b", []))).toThrow("change kinds");
  expect(() => f.claims.subscribe(scope, { ...subscription("collection:tasks#b", ["added"]), definitionHash: "edited" })).toThrow("definition hash");
  f.commit("INSERT INTO tasks VALUES('a','Open','')", { kind: "automation", automationId: "collection:tasks#b", depth: 1 });
  f.db.exec("BEGIN IMMEDIATE"); f.claims.forget(scope); f.db.exec("COMMIT");
  for (const table of ["subscriptions", "claims", "revisions"]) {
    expect(f.db.prepare(`SELECT count(*) AS count FROM dohc_dataset_automation_${table}`).get()).toEqual({ count: 0 });
  }
});

// The whole host, with a real worker: the actor comes from the context, and
// only a new commit claims.
const hostSchema = "CREATE TABLE items(id TEXT PRIMARY KEY NOT NULL,value TEXT NOT NULL);";
const hostSource = `globalThis.operations={
  create(ctx,input){ctx.db.execute('INSERT INTO items VALUES(?,?)',[ctx.requestId,input.value]);return {id:ctx.requestId};},
  read(ctx){return ctx.db.query('SELECT id,value FROM items ORDER BY id');}
};`;
const ITEMS = id(12), CREATE = id(15), READ = id(16);
const hostDefinition: DatasetDefinition = {
  formatVersion: 1, datasetId: scope.datasetId, name: "Sign-ups", schemaPath: "signups/schema.sql", operationsPath: "signups/operations.js",
  tables: [{ tableId: ITEMS, name: "Items", sqlName: "items", primaryKey: "id", fields: [
    { fieldId: id(13), name: "ID", sqlColumn: "id", type: "text", required: true, unique: true },
    { fieldId: id(14), name: "Value", sqlColumn: "value", type: "text", required: true, unique: false },
  ] }],
  operations: [
    { operationId: CREATE, name: "create", label: "Sign up", tableId: ITEMS, kind: "create", access: "link", readOnly: false, fieldIds: [id(14)] },
    { operationId: READ, name: "read", label: "Read", tableId: ITEMS, kind: "read", access: "owner", readOnly: true, fieldIds: [id(13), id(14)] },
  ],
};
const hostRevision = describeDatasetRevision({ definition: hostDefinition, revision: 1, schemaSql: hostSchema, operationSource: hostSource });
type Context = "owner" | "visitor" | { automationId: string; depth: number; visitor?: true };

async function host() {
  const directory = mkdtempSync(join(tmpdir(), "dohc-automation-host-"));
  const db = new DatabaseSync(join(directory, "host.sqlite")); db.exec("PRAGMA journal_mode=WAL;");
  const transaction = transactions(db);
  const journal = createDatasetJournal({ db, transaction });
  let supervisor = await createDatasetSupervisor({ journal, directory: join(directory, "workers") });
  const wakes: DatasetScope[] = [];
  cleanups.push(async () => { await supervisor.close(); db.close(); rmSync(directory, { recursive: true, force: true, maxRetries: 8, retryDelay: 25 }); });
  const visitor = { kind: "link" as const, principalId: "visitor", grantId: "public-link" };
  const create = () => createDatasetHost<Context>({ db, transaction, journal, supervisor, wakeAutomations: woken => wakes.push(woken),
    resolveAuthority(context, request) {
      if (context === "owner") return { caller: { kind: "owner", userId: "owner" }, principalKey: "owner" };
      if (context === "visitor") return { caller: visitor, principalKey: "visitor", ...(request.access.kind === "app" ? { appId: request.access.appId } : {}) };
      return { caller: context.visitor ? visitor : { kind: "owner", userId: "owner" }, principalKey: `automation:${context.automationId}`,
        automation: { automationId: context.automationId, depth: context.depth } };
    } });
  let current = create();
  await current.activate("owner", { workspaceId: scope.workspaceId, revision: hostRevision, schemaSql: hostSchema, operationSource: hostSource });
  const invoke = (context: Context, operationId: string, idempotencyKey: string, appId?: string) => current.invoke(context, { ...scope, revision: 1,
    revisionSha256: hostRevision.revisionSha256, operationId, input: operationId === CREATE ? { value: idempotencyKey } : {}, idempotencyKey,
    ...(appId ? { access: { kind: "app" as const, appId } } : {}) });
  return { wakes, invoke, get host() { return current; }, get claims() { return current.automationClaims; },
    async restart() { await supervisor.close(); supervisor = await createDatasetSupervisor({ journal, directory: join(directory, "workers") }); current = create(); } };
}

it("claims a host commit once, as the actor its context names, and never on a replay or recovery", async () => {
  const f = await host();
  f.claims.subscribe(scope, subscription("collection:signups#welcome", ["added"], null, ITEMS));
  f.host.setBinding("owner", { ...scope, appId: "form", binding: { kind: "dataset", datasetId: scope.datasetId, revision: 1, revisionSha256: hostRevision.revisionSha256, operationIds: [CREATE] } });
  expect(await f.invoke("visitor", CREATE, "signup-1", "form")).toMatchObject({ replayed: false });
  expect(await f.invoke("visitor", CREATE, "signup-1", "form")).toMatchObject({ replayed: true });
  // A new worker replays the journal to recover; that claims nothing.
  await f.restart();
  expect(await f.invoke("owner", READ, "read-1")).toMatchObject({ result: [{ value: "signup-1" }] });
  await f.invoke("owner", CREATE, "owner-1");
  expect(drain(f.claims).map(claim => [claim.revision, claim.actor])).toEqual([[1, { kind: "link", appId: "form" }], [2, { kind: "owner" }]]);
  expect(f.wakes).toEqual([scope, scope]);
});

it("takes an automation's identity from its context, and grants it no owner administration", async () => {
  const f = await host();
  f.claims.subscribe(scope, subscription("collection:signups#a", ["added"], null, ITEMS));
  f.claims.subscribe(scope, subscription("collection:signups#b", ["added"], null, ITEMS));
  await f.invoke({ automationId: "collection:signups#a", depth: 2 }, CREATE, "step-1");
  expect(drain(f.claims).map(claim => [claim.automationId, claim.depth, claim.actor])).toEqual([
    ["collection:signups#b", 2, { kind: "automation", automationId: "collection:signups#a", depth: 2 }],
  ]);
  await expect(f.invoke({ automationId: "collection:signups#a", depth: 1, visitor: true }, CREATE, "step-2")).rejects.toThrow("not permitted");
  await expect(f.invoke({ automationId: "collection:signups#a", depth: 5 }, CREATE, "step-3")).rejects.toThrow("not permitted");
  expect(() => f.host.lifecycle({ automationId: "collection:signups#a", depth: 1 }, scope)).toThrow("not permitted");
});
