import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import { describeDatasetRevision } from "@dohc/security-contract/dataset-artifacts";
import type { DatasetDefinition } from "@dohc/security-contract/dataset";
import { createDatasetJournal } from "./journal.ts";
import { createDatasetSupervisor } from "./supervisor.ts";
import { createDatasetHost, type DatasetHostOptions } from "./dataset-host.ts";
import { createDatasetAttempts, assertDatasetAttemptsCommitted } from "./dataset-attempts.ts";

vi.setConfig({ testTimeout: 30_000 });
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const id = (number: number) => `00000000-0000-4000-8000-${String(number).padStart(12, "0")}`;
const schemaSql = "CREATE TABLE items(id TEXT PRIMARY KEY NOT NULL,value TEXT NOT NULL,secret TEXT NOT NULL);";
const operationSource = `globalThis.operations={
  create(ctx,input){ctx.db.execute('INSERT INTO items VALUES(?,?,?)',[ctx.requestId,input.value,'private']);return {accepted:true};},
  read(ctx){return ctx.db.query('SELECT id,value FROM items ORDER BY id');},
  edit(ctx,input){ctx.db.execute('UPDATE items SET value=? WHERE id=?',[input.value,input.id]);return {changed:true};},
  privateRead(ctx){return ctx.db.query('SELECT * FROM items');}
};`;
const definition: DatasetDefinition = {
  formatVersion: 1, datasetId: id(1), name: "Orders", schemaPath: "orders/schema.sql", operationsPath: "orders/operations.js",
  tables: [{ tableId: id(2), name: "Items", sqlName: "items", primaryKey: "id", fields: [
    { fieldId: id(3), name: "ID", sqlColumn: "id", type: "text", required: true, unique: true },
    { fieldId: id(4), name: "Value", sqlColumn: "value", type: "text", required: true, unique: false },
    { fieldId: id(5), name: "Secret", sqlColumn: "secret", type: "text", required: true, unique: false },
  ] }],
  operations: [
    { operationId: id(6), name: "create", label: "Submit", tableId: id(2), kind: "create", access: "link", readOnly: false, fieldIds: [id(4)] },
    { operationId: id(7), name: "read", label: "Read", tableId: id(2), kind: "read", access: "helper", readOnly: true, fieldIds: [id(3), id(4)] },
    { operationId: id(8), name: "edit", label: "Edit", tableId: id(2), kind: "edit", access: "helper", readOnly: false, fieldIds: [id(4)] },
    { operationId: id(9), name: "privateRead", label: "Private read", tableId: id(2), kind: "read", access: "owner", readOnly: true, fieldIds: [id(3), id(4), id(5)] },
  ],
};
const prepared = { revision: describeDatasetRevision({ definition, revision: 1, schemaSql, operationSource }), schemaSql, operationSource };
const scope = { workspaceId: "workspace", datasetId: id(1) };
type Context = "owner" | "helper" | "friend";
async function fixture(overrides: Partial<DatasetHostOptions<Context>> = {}) {
  const directory = await mkdtemp(join(tmpdir(), "dohc-dataset-host-"));
  const db = new DatabaseSync(join(directory, "host.sqlite"));
  db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE permissions(user TEXT PRIMARY KEY,active INTEGER); INSERT INTO permissions VALUES('owner',1),('helper',1),('friend',1); CREATE TABLE accounting(bytes INTEGER); INSERT INTO accounting VALUES(0);");
  function transaction<T>(run: () => T): T {
    db.exec("BEGIN IMMEDIATE");
    try { const result = run(); db.exec("COMMIT"); return result; } catch (error) { db.exec("ROLLBACK"); throw error; }
  }
  const journal = createDatasetJournal({ db, transaction });
  const supervisor = await createDatasetSupervisor({ journal, directory: join(directory, "workers") });
  cleanups.push(async () => { await supervisor.close(); db.close(); await rm(directory, { recursive: true, force: true, maxRetries: 8, retryDelay: 25 }); });
  const host = createDatasetHost<Context>({ db, transaction, journal, supervisor,
    resolveAuthority(context, request) {
      if (request.workspaceId !== "workspace" || db.prepare("SELECT active FROM permissions WHERE user=?").get(context)?.active !== 1) throw new Error("revoked");
      if (request.access.kind === "app" && request.access.appId !== "form") throw new Error("Wrong publication credential.");
      return { principalKey: context, ...(request.access.kind === "app" ? { appId: "form" } : {}),
        caller: context === "owner" ? { kind: "owner", userId: "owner" } : context === "helper"
          ? { kind: "named", userId: "helper", grantId: "member", access: "view", helper: false }
          : { kind: "link", principalId: "friend", grantId: "public-link" } };
    },
    accountCreation(_context, allocation) { db.prepare("UPDATE accounting SET bytes=bytes+?").run(allocation.bytes); },
    ...overrides,
  });
  const activate = () => host.activate("owner", { workspaceId: scope.workspaceId, ...prepared });
  const binding = (operationIds = [id(6)]) => ({ kind: "dataset" as const, datasetId: id(1), revision: 1, revisionSha256: prepared.revision.revisionSha256, operationIds });
  const invoke = (context: Context, operationId: string, input = {}, appId?: string) => host.invoke(context, { ...scope, revision: prepared.revision.revision, revisionSha256: prepared.revision.revisionSha256, operationId, input,
    idempotencyKey: "request", ...(appId ? { access: { kind: "app" as const, appId } } : {}) });
  return { host, db, journal, supervisor, activate, invoke, binding, transaction };
}

it("requires current owner review of both data and affected apps before permanent deletion", async () => {
  const f = await fixture(); await f.activate();
  const first = f.host.deletePreview("owner",scope);
  expect(() => f.host.deletePreview("helper",scope)).toThrow("not permitted");
  const request = {...scope,expected:first.cursor,reviewToken:first.reviewToken,acknowledge:true as const};
  await expect(f.host.deleteDataset("owner",{...request,acknowledge:false as true})).rejects.toThrow("Review");
  await expect(f.host.deleteDataset("helper",request)).rejects.toThrow("not permitted");
  f.host.setBinding("owner",{...scope,appId:"form",binding:f.binding()});
  await expect(f.host.deleteDataset("owner",request)).rejects.toThrow("access changed");
  const next = f.host.deletePreview("owner",{...scope,limit:1});
  expect(next.apps).toMatchObject([{appId:"form"}]);
  await f.invoke("owner",id(6),{value:"changed"});
  await expect(f.host.deleteDataset("owner",{...request,expected:next.cursor,reviewToken:next.reviewToken})).rejects.toThrow("cursor changed");
  f.host.archiveDataset("owner",scope);
  const current = f.host.deletePreview("owner",scope);
  await expect(f.host.deleteDataset("owner",{...request,expected:current.cursor,reviewToken:current.reviewToken})).resolves.toEqual({deleted:true,datasetId:scope.datasetId});
  expect(f.host.list("owner",{workspaceId:scope.workspaceId,includeArchived:true}).datasets).toEqual([]);
  for (const table of ["dohc_dataset_catalog","dohc_dataset_bindings","dohc_dataset_events","dohc_dataset_receipts","dohc_dataset_checkpoints","dohc_dataset_attempts","dohc_dataset_lifecycle"])
    expect(f.db.prepare(`SELECT count(*) n FROM ${table}`).get()!.n).toBe(0);
  expect(f.db.prepare("SELECT count(*) n FROM dohc_dataset_deletions").get()!.n).toBe(1);
  await expect(f.activate()).rejects.toThrow("deleted");
  await expect(f.invoke("owner",id(6),{value:"changed"})).rejects.toThrow();
});

it("rolls permanent deletion and its tombstone back if private-resource cleanup fails", async () => {
  const f = await fixture({deleteResources() { throw new Error("cleanup failed"); }}); await f.activate();
  const preview = f.host.deletePreview("owner",scope);
  await expect(f.host.deleteDataset("owner",{...scope,expected:preview.cursor,reviewToken:preview.reviewToken,acknowledge:true})).rejects.toThrow("cleanup failed");
  expect(f.host.deletePreview("owner",scope).cursor).toEqual(preview.cursor);
  expect(f.db.prepare("SELECT count(*) n FROM dohc_dataset_deletions").get()!.n).toBe(0);
});

it("rejects deletion at a fenced former authority", async () => {
  const f = await fixture(); await f.activate();
  const preview = f.host.deletePreview("owner",scope);
  f.journal.fence({expected:preview.cursor,authorize(){}});
  expect(() => f.host.deletePreview("owner",scope)).toThrow("current host");
  await expect(f.host.deleteDataset("owner",{...scope,expected:preview.cursor,reviewToken:preview.reviewToken,acknowledge:true})).rejects.toThrow("fenced");
});

it("pages owner-only saved-operation metadata without receipts, payloads, or private results", async () => {
  const f = await fixture(); await f.activate();
  for (const key of ["secret-retry-1", "secret-retry-2", "secret-retry-3"]) await f.host.invoke("owner", { ...scope, revision: 1, revisionSha256: prepared.revision.revisionSha256, operationId: id(6), input: { value: "private payload" }, idempotencyKey: key });
  const first = f.host.history("owner", { ...scope, limit: 2 });
  expect(first.entries.map(entry => entry.revision)).toEqual([3, 2]); expect(first.nextBeforeRevision).toBe(2);
  expect(first.entries[0]).toMatchObject({ operation: "create", attachmentCount: 0, approvedRevisionHash: prepared.revision.revisionSha256 });
  expect(first.entries[0]!.callerReference).toMatch(/^[a-f0-9]{64}$/);
  expect(JSON.stringify(first)).not.toMatch(/secret-retry|private payload|resultJson|payloadSha256|idempotencyKey|proposalId/);
  const second = f.host.history("owner", { ...scope, beforeRevision: first.nextBeforeRevision!, limit: 2 });
  expect(second.entries.map(entry => entry.revision)).toEqual([1]); expect(second.nextBeforeRevision).toBeNull();
  for (const caller of ["helper", "friend"] as const) expect(() => f.host.history(caller, scope)).toThrow("not permitted");
  expect(() => f.host.history("owner", { ...scope, limit: 101 })).toThrow("Invalid");
  expect(() => f.host.history("owner", { ...scope, datasetId: id(99) })).toThrow("not permitted");
});
it("recovers an explicitly reversible edit from durable history and refuses undo after a later edit", async () => {
  const f = await fixture();
  const reversible = structuredClone(definition);
  reversible.operations.find(operation => operation.kind === "edit")!.reversible = true;
  const sql = "CREATE TABLE items(id TEXT PRIMARY KEY NOT NULL,value TEXT NOT NULL,secret TEXT NOT NULL,version INTEGER NOT NULL);";
  const source = `globalThis.operations={
    create(ctx,input){ctx.db.execute('INSERT INTO items VALUES(?,?,?,1)',['record',input.value,'private']);return {id:'record',version:1};},
    edit(ctx,input){const row=ctx.db.query('SELECT value,version FROM items WHERE id=?',[input.id])[0];
      if(!row||row.version!==input.expectedVersion)ctx.refuse('conflict','The record changed.');
      ctx.db.execute('UPDATE items SET value=?,version=version+1 WHERE id=?',[input.values['${id(4)}'],input.id]);
      return {id:input.id,version:row.version+1,priorValues:{'${id(4)}':row.value}};}
  };`;
  const revision = describeDatasetRevision({ definition: reversible, revision: 1, schemaSql: sql, operationSource: source });
  await f.host.activate("owner", { workspaceId: scope.workspaceId, revision, schemaSql: sql, operationSource: source });
  const call = (operationId: string, input: import("./protocol.js").JsonValue, idempotencyKey: string) => f.host.invoke("owner", { ...scope, revision: 1, revisionSha256: revision.revisionSha256, operationId, input, idempotencyKey });
  await call(id(6), { value: "Alice" }, "create");
  await call(id(8), { id: "record", expectedVersion: 1, values: { [id(4)]: "Alicia" } }, "edit");
  const reopened = createDatasetHost({ db: f.db, transaction: f.transaction, journal: f.journal, supervisor: f.supervisor,
    resolveAuthority() { return { principalKey: "owner", caller: { kind: "owner", userId: "owner" } }; }, accountCreation() {} });
  const history = reopened.history("owner", scope);
  expect(history.entries[1]!.undo).toBeUndefined();
  const undo = history.entries[0]!.undo!;
  expect(undo).toMatchObject({ recordId: "record", expectedVersion: 2, fields: [{ fieldId: id(4), name: "Value", value: "Alice" }] });
  expect(JSON.stringify(undo)).not.toContain("private");
  const input = { id: undo.recordId, expectedVersion: undo.expectedVersion, values: Object.fromEntries(undo.fields.map(field => [field.fieldId, field.value])) };
  await call(undo.operationId, input, "undo");
  await expect(call(undo.operationId, input, "stale-undo")).rejects.toMatchObject({ refusal: { code: "conflict" } });
});
it("archives and restores the same records without releasing storage or reactivating a transferred host", async () => {
  const f = await fixture(); await f.activate(); await f.invoke("owner", id(6), { value: "retained" });
  f.host.setBinding("owner", { ...scope, appId: "form", binding: f.binding() });
  const bytes = f.db.prepare("SELECT bytes FROM accounting").get()!.bytes;
  const capture = f.host.replicaCapture("owner",scope);
  expect(f.host.lifecycle("owner", scope).apps).toMatchObject([{ appId: "form" }]);
  expect(() => f.host.archiveDataset("helper", scope)).toThrow();
  f.host.archiveDataset("owner", scope);
  expect(()=>f.host.replicaCapture("owner",scope)).toThrow("archived");
  expect(()=>f.host.replicaPage("owner",{...scope,through:capture.head,after:capture.checkpoint.cursor})).toThrow("archived");
  expect(()=>f.host.replicaBlob("owner",{...scope,record:capture.checkpoint,offset:0,length:100})).toThrow("archived");
  expect(f.host.list("owner", { workspaceId: scope.workspaceId }).datasets).toEqual([]);
  expect(f.host.list("owner", { workspaceId: scope.workspaceId, includeArchived: true }).datasets).toMatchObject([{ datasetId: scope.datasetId, archived: true }]);
  expect(() => f.host.list("helper", { workspaceId: scope.workspaceId, includeArchived: true })).toThrow();
  await expect(f.invoke("owner", id(7))).rejects.toThrow("archived");
  await expect(f.invoke("friend", id(6), { value: "denied" }, "form")).rejects.toThrow("archived");
  expect(f.db.prepare("SELECT bytes FROM accounting").get()!.bytes).toBe(bytes);
  f.host.restoreDataset("owner", scope);
  expect(f.host.replicaCapture("owner",scope).head).toEqual(capture.head);
  expect((await f.invoke("owner", id(7))).result).toMatchObject([{ value: "retained" }]);
  f.host.archiveDataset("owner", scope);
  f.journal.fence({ expected: f.host.approvedArtifacts("owner", scope).cursor, authorize() {} });
  expect(() => f.host.restoreDataset("owner", scope)).toThrow("fenced");
});

it("invalidates a pending operation even if the dataset is archived and restored before commit", async () => {
  const f = await fixture(); await f.activate();
  const original = f.supervisor.invoke.bind(f.supervisor);
  f.supervisor.invoke = async input => {
    f.host.archiveDataset("owner", scope); f.host.restoreDataset("owner", scope);
    return original(input);
  };
  await expect(f.invoke("owner", id(6), { value: "stale" })).rejects.toThrow();
  expect(f.journal.head(scope, () => {}).cursor.revision).toBe(0);
});

it("creates a dataset without an app and several views share its authoritative records", async () => {
  const f = await fixture(); await f.activate();
  expect(f.host.list("owner", { workspaceId: "workspace" }).datasets[0].name).toBe("Orders");
  f.host.setBinding("owner", { ...scope, appId: "form", binding: f.binding() });
  await expect(f.invoke("friend", id(6), { value: "submitted" }, "form")).resolves.toMatchObject({ result: { accepted: true }, revision: 1 });
  const rows = await f.invoke("owner", id(7));
  expect(rows.result).toMatchObject([{ value: "submitted" }]);
  f.host.setDataGrant("owner", { ...scope, principalKey: "helper", grant: { revision: 1, revisionSha256: prepared.revision.revisionSha256, operationIds: [id(7), id(8)], discover: true } });
  await f.invoke("helper", id(8), { id: (rows.result as Array<{ id: string }>)[0].id, value: "managed" });
  expect((await f.invoke("owner", id(7))).result).toMatchObject([{ value: "managed" }]);
  expect(f.host.describe("helper", scope).tables[0].fields.map(field => field.name)).toEqual(["ID", "Value"]);
  expect(JSON.stringify(f.host.describe("helper", scope))).not.toContain("Secret");
  expect(f.db.prepare("SELECT bytes FROM accounting").get()!.bytes).toBeGreaterThan(128 * 1024 * 1024);
});

it("keeps submission, data discovery, private reads, and source approval separate", async () => {
  const f = await fixture(); await f.activate();
  f.host.setBinding("owner", { ...scope, appId: "form", binding: f.binding([id(6), id(9)]) });
  await expect(f.invoke("friend", id(9), {}, "form")).rejects.toThrow("not permitted");
  await expect(f.invoke("friend", id(6), { value: "hello" }, "another-form")).rejects.toThrow("Wrong publication");
  expect(() => f.host.describe("friend", scope)).toThrow("not permitted");
  expect(f.host.list("friend", { workspaceId: "workspace" })).toEqual({ datasets: [], nextCursor: null });
  expect(() => f.host.approvedArtifacts("helper", scope)).toThrow("not permitted");
  expect(() => f.host.setBinding("helper", { ...scope, appId: "form", binding: f.binding() })).toThrow("not permitted");
  expect(() => f.host.setDataGrant("owner", { ...scope, principalKey: "helper", grant: { revision: 1, revisionSha256: prepared.revision.revisionSha256, operationIds: [id(9)], discover: true } })).toThrow("Owner-only");
  expect(() => f.host.setBinding("owner", { ...scope, appId: "form", binding: { ...f.binding(), revisionSha256: "0".repeat(64) } })).toThrow();
});

it("approving another consumer cannot replace rules and changed artifacts cannot activate", async () => {
  const f = await fixture(); await f.activate();
  await expect(f.host.activate("owner", { workspaceId: "workspace", ...prepared, operationSource: "globalThis.operations={};" })).rejects.toThrow("artifacts");
  const changedSource = operationSource.replace("'private'", "'different'");
  const changed = { revision: describeDatasetRevision({ definition, revision: 1, schemaSql, operationSource: changedSource }), schemaSql, operationSource: changedSource };
  await expect(f.host.activate("owner", { workspaceId: "workspace", ...changed })).rejects.toThrow("already approved");
  await expect(f.activate()).resolves.toEqual(prepared.revision);
  expect(f.host.approvedArtifacts("owner", scope).operationSource).toBe(operationSource);
});

it("rolls back catalog creation and quota when the final authority check fails", async () => {
  let f: Awaited<ReturnType<typeof fixture>>;
  f = await fixture({ accountCreation() { f.db.prepare("UPDATE permissions SET active=0 WHERE user='owner'").run(); } });
  await expect(f.activate()).rejects.toThrow("revoked");
  expect(f.db.prepare("SELECT COUNT(*) AS n FROM dohc_dataset_catalog").get()!.n).toBe(0);
  expect(f.db.prepare("SELECT COUNT(*) AS n FROM dohc_dataset_journals").get()!.n).toBe(0);
  expect(f.db.prepare("SELECT active FROM permissions WHERE user='owner'").get()!.active).toBe(1);
});

it("blocks queued operations and receipt disclosure after binding or data grant revocation", async () => {
  const f = await fixture(); await f.activate();
  f.host.setBinding("owner", { ...scope, appId: "form", binding: f.binding() });
  const first = f.invoke("friend", id(6), { value: "first" }, "form");
  f.host.setBinding("owner", { ...scope, appId: "form", binding: null });
  await expect(first).rejects.toThrow("not permitted");
  expect((await f.invoke("owner", id(7))).result).toEqual([]);
  f.host.setBinding("owner", { ...scope, appId: "form", binding: f.binding() });
  await f.invoke("friend", id(6), { value: "saved" }, "form");
  expect((await f.invoke("friend", id(6), { value: "saved" }, "form")).replayed).toBe(true);
  await expect(f.invoke("friend", id(6), { value: "changed retry" }, "form")).rejects.toThrow();
  f.host.setBinding("owner", { ...scope, appId: "form", binding: null });
  await expect(f.invoke("friend", id(6), { value: "saved" }, "form")).rejects.toThrow("not permitted");
  f.host.setDataGrant("owner", { ...scope, principalKey: "helper", grant: { revision: 1, revisionSha256: prepared.revision.revisionSha256, operationIds: [id(7)], discover: true } });
  const read = f.invoke("helper", id(7));
  f.host.setDataGrant("owner", { ...scope, principalKey: "helper", grant: null });
  await expect(read).rejects.toThrow("not permitted");
});

it("compiles verified TypeScript captures but preserves original artifacts", async () => {
  const typedDefinition = { ...definition, operationsPath: "orders/operations.ts" }, typedSource = "const value: string = 'ok';";
  const compiled = vi.fn(async () => operationSource);
  const f = await fixture({ compileOperations: compiled });
  const revision = describeDatasetRevision({ definition: typedDefinition, revision: 1, schemaSql, operationSource: typedSource });
  await f.host.activate("owner", { workspaceId: "workspace", revision, schemaSql, operationSource: typedSource });
  expect(compiled).toHaveBeenCalledWith(typedSource, typedDefinition.operationsPath);
  expect(f.host.approvedArtifacts("owner", scope).operationSource).toBe(typedSource);
  expect(f.journal.head(scope, () => {}).source).toBe(operationSource);
  await f.host.invoke("owner", { ...scope, revision: revision.revision, revisionSha256: revision.revisionSha256,
    operationId: id(6), input: { value: "compiled" }, idempotencyKey: "request" });
  expect((await f.host.invoke("owner", { ...scope, revision: revision.revision, revisionSha256: revision.revisionSha256,
    operationId: id(7), input: {}, idempotencyKey: "read" })).result).toMatchObject([{ value: "compiled" }]);
});

it("intersects admin app operations with the explicit data grant and refuses stale views", async () => {
  const f = await fixture(); await f.activate();
  f.host.setBinding("owner", { ...scope, appId: "form", binding: f.binding([id(6), id(7), id(8)]) });
  f.host.setDataGrant("owner", { ...scope, principalKey: "helper", grant: { revision: 1, revisionSha256: prepared.revision.revisionSha256, operationIds: [id(7)], discover: false } });
  await expect(f.invoke("helper", id(7), {}, "form")).resolves.toMatchObject({ result: [] });
  await expect(f.invoke("helper", id(8), {}, "form")).rejects.toThrow("not permitted");
  expect(() => f.host.describe("helper", scope)).toThrow("not permitted");
  await expect(f.host.invoke("owner", { ...scope, revision: 1, revisionSha256: "0".repeat(64), operationId: id(6), input: {}, idempotencyKey: "request" })).rejects.toThrow("stale");
});

it("accounts binding and grant replacements by retained size and rolls back quota failures", async () => {
  let f: Awaited<ReturnType<typeof fixture>>, refuse = false;
  f = await fixture({ accountMetadata(_context, allocation) {
    f.db.prepare("UPDATE accounting SET bytes=bytes+?").run(allocation.bytes);
    if (refuse) throw new Error("quota");
  } });
  await f.activate(); const initial = f.db.prepare("SELECT bytes FROM accounting").get()!.bytes;
  f.host.setBinding("owner", { ...scope, appId: "form", binding: f.binding() });
  f.host.setDataGrant("owner", { ...scope, principalKey: "helper", grant: { revision: 1, revisionSha256: prepared.revision.revisionSha256, operationIds: [id(7)], discover: true } });
  const populated = f.db.prepare("SELECT bytes FROM accounting").get()!.bytes;
  f.host.setDataGrant("owner", { ...scope, principalKey: "helper", grant: { revision: 1, revisionSha256: prepared.revision.revisionSha256, operationIds: [id(7)], discover: true } });
  expect(f.db.prepare("SELECT bytes FROM accounting").get()!.bytes).toBe(populated);
  refuse = true;
  expect(() => f.host.setDataGrant("owner", { ...scope, principalKey: "helper", grant: { revision: 1, revisionSha256: prepared.revision.revisionSha256, operationIds: [id(7), id(8)], discover: true } })).toThrow("quota");
  expect(f.host.describe("helper", scope).operations.map(operation => operation.operationId)).toEqual([id(7)]);
  expect(f.db.prepare("SELECT bytes FROM accounting").get()!.bytes).toBe(populated);
  refuse = false;
  f.host.setBinding("owner", { ...scope, appId: "form", binding: null });
  f.host.setDataGrant("owner", { ...scope, principalKey: "helper", grant: null });
  expect(f.db.prepare("SELECT bytes FROM accounting").get()!.bytes).toBe(initial);
});

it("exposes complete migration previews only to the current owner and commits the reviewed values",async()=>{
  const f=await fixture();await f.activate();await f.invoke("owner",id(6),{value:"saved"});
  const expected=f.host.approvedArtifacts("owner",scope).cursor;
  const revision=describeDatasetRevision({definition,revision:2,schemaSql,operationSource});
  const input={workspaceId:scope.workspaceId,revision,schemaSql,operationSource,expected,migrationSql:"UPDATE items SET value=lower(hex(randomblob(12)));"};
  await expect(f.host.prepareMigration("helper",input)).rejects.toThrow();
  const candidate=await f.host.prepareMigration("owner",input),request={...scope,candidateId:candidate.candidateId};
  expect(()=>f.host.migrationPreviewPage("helper",request)).toThrow();
  expect(f.host.migrationPreviewPage("owner",request)).toEqual(candidate.preview.firstPage);
  expect((await f.invoke("owner",id(7))).result).toMatchObject([{value:"saved"}]);
  const result=await f.host.approveMigration("owner",{...request,checkpointSha256:candidate.checkpointSha256});
  expect(result.revision).toEqual(revision);
  const rows=await f.host.invoke("owner",{...scope,revision:2,revisionSha256:revision.revisionSha256,operationId:id(9),input:{},idempotencyKey:"after"});
  expect(rows.result).toEqual([candidate.preview.firstPage.changes[0]!.after]);
});

it("invalidates prepared migration authority after archive and restore",async()=>{
  const f=await fixture();await f.activate();
  const expected=f.host.approvedArtifacts("owner",scope).cursor,revision=describeDatasetRevision({definition,revision:2,schemaSql,operationSource});
  const candidate=await f.host.prepareMigration("owner",{workspaceId:scope.workspaceId,revision,schemaSql,operationSource,expected,migrationSql:"SELECT 1;"});
  f.host.archiveDataset("owner",scope);f.host.restoreDataset("owner",scope);
  await expect(f.host.approveMigration("owner",{...scope,candidateId:candidate.candidateId,checkpointSha256:candidate.checkpointSha256})).rejects.toThrow("not permitted");
});

it("migrates records atomically and retains stale grants for explicit reapproval", async () => {
  const f = await fixture(); await f.activate(); await f.invoke("owner", id(6), { value: "saved" });
  f.host.setBinding("owner", { ...scope, appId: "form", binding: f.binding([id(6), id(7)]) });
  f.host.setDataGrant("owner", { ...scope, principalKey: "helper", grant: { revision: 1, revisionSha256: prepared.revision.revisionSha256, operationIds: [id(7)], discover: true } });
  const expected = f.host.approvedArtifacts("owner", scope).cursor;
  const nextDefinition = structuredClone(definition); nextDefinition.name = "Orders updated";
  const nextSchema = "CREATE TABLE items(id TEXT PRIMARY KEY NOT NULL,value TEXT NOT NULL,secret TEXT NOT NULL, notes TEXT NOT NULL DEFAULT '');";
  const revision = describeDatasetRevision({ definition: nextDefinition, revision: 2, schemaSql: nextSchema, operationSource });
  const migrated = await f.host.migrate("owner", { workspaceId: "workspace", revision, schemaSql: nextSchema, operationSource, expected,
    migrationSql: "ALTER TABLE items ADD COLUMN notes TEXT NOT NULL DEFAULT '';" });
  expect(migrated.cursor.revision).toBe(expected.revision + 1);
  expect(f.host.approvedArtifacts("owner", scope).schemaSql).toBe(nextSchema);
  expect(f.host.permissions("owner", scope).permissions.map(permission => permission.current)).toEqual([false, false]);
  expect(() => f.host.permissions("helper", scope)).toThrow("not permitted");
  expect(f.host.list("helper", { workspaceId: "workspace" }).datasets).toEqual([]);
  await expect(f.invoke("helper", id(7))).rejects.toThrow("needs approval");
  await expect(f.invoke("friend", id(6), { value: "another" }, "form")).rejects.toThrow();
  expect(() => f.host.setDataGrant("owner", { ...scope, principalKey: "helper", grant: { revision: 1, revisionSha256: prepared.revision.revisionSha256, operationIds: [id(7)], discover: true } })).toThrow("needs approval");
  f.host.setDataGrant("owner", { ...scope, principalKey: "helper", grant: { revision: 2, revisionSha256: revision.revisionSha256, operationIds: [id(7)], discover: true } });
  const result = await f.host.invoke("helper", { ...scope, revision: 2, revisionSha256: revision.revisionSha256, operationId: id(7), input: {}, idempotencyKey: "read-new" });
  expect(result.result).toMatchObject([{ value: "saved" }]);
  expect(f.host.permissions("owner", { ...scope, limit: 1 })).toMatchObject({ nextCursor: "app:form" });
});

it("rolls back migration approval when accounting refuses and rejects a stale preview", async () => {
  const stageDeltas: number[] = [];
  const f = await fixture({ accountCheckpointStage(_context, allocation) { stageDeltas.push(allocation.bytes); }, accountMigration() { throw new Error("final migration quota"); } }); await f.activate();
  const expected = f.host.approvedArtifacts("owner", scope).cursor;
  const nextDefinition = { ...definition, name: "Next" };
  const revision = describeDatasetRevision({ definition: nextDefinition, revision: 2, schemaSql, operationSource });
  await expect(f.host.migrate("owner", { workspaceId: "workspace", revision, schemaSql, operationSource, expected, migrationSql: "SELECT 1;" })).rejects.toThrow("final migration quota");
  expect(stageDeltas.length).toBe(2);
  expect(stageDeltas[0]).toBeGreaterThan(0);
  expect(stageDeltas[1]).toBe(-stageDeltas[0]!);
  expect(f.host.approvedArtifacts("owner", scope).revision).toEqual(prepared.revision);
  await f.invoke("owner", id(6), { value: "new record" });
  await expect(f.host.migrate("owner", { workspaceId: "workspace", revision, schemaSql, operationSource, expected, migrationSql: "SELECT 1;" })).rejects.toThrow();
  expect((await f.invoke("owner", id(7))).result).toMatchObject([{ value: "new record" }]);
});

it("commits app publication with its binding and rolls both back on failure", async () => {
  const f = await fixture(); await f.activate();
  f.db.exec("CREATE TABLE publications(id TEXT PRIMARY KEY);");
  expect(() => f.host.setBinding("owner", { ...scope, appId: "form", binding: f.binding() }, () => {
    f.db.prepare("INSERT INTO publications VALUES('form')").run(); throw new Error("publication failed");
  })).toThrow("publication failed");
  expect(f.db.prepare("SELECT COUNT(*) AS n FROM publications").get()!.n).toBe(0);
  expect(f.host.permissions("owner", scope).permissions).toEqual([]);
  expect(() => f.host.setBinding("owner", { ...scope, appId: "form", binding: f.binding() }, async () => {})).toThrow("synchronous");
  expect(f.host.permissions("owner", scope).permissions).toEqual([]);
  f.host.setBinding("owner", { ...scope, appId: "form", binding: f.binding() }, () => { f.db.prepare("INSERT INTO publications VALUES('form')").run(); });
  expect(f.db.prepare("SELECT COUNT(*) AS n FROM publications").get()!.n).toBe(1);
  expect(f.host.permissions("owner", scope).permissions).toHaveLength(1);
});

it("enforces a form's create-field subset before operation execution", async () => {
  const source = operationSource.replace("input.value,'private'",`input.values['${id(4)}'],'private'`);
  const revision = describeDatasetRevision({ definition, revision: 1, schemaSql, operationSource: source });
  const f = await fixture();await f.host.activate("owner",{workspaceId:"workspace",revision,schemaSql,operationSource:source});
  f.host.setBinding("owner",{...scope,appId:"form",binding:{...f.binding(),revisionSha256:revision.revisionSha256,createFields:[{operationId:id(6),fieldIds:[id(4)]}]}});
  const invoke=(input:any)=>f.host.invoke("friend",{...scope,revision:1,revisionSha256:revision.revisionSha256,operationId:id(6),input,idempotencyKey:"form",access:{kind:"app",appId:"form"}});
  for(const input of [{value:"bypass"},{values:{[id(4)]:"good",[id(5)]:"private"}},{values:{[id(4)]:"good"},sql:"bypass"},{values:[]}]) {
    await expect(invoke(input)).rejects.toThrow("cannot submit those fields");
  }
  expect(f.journal.head(scope,()=>{}).cursor.revision).toBe(0);
  await expect(invoke({values:{[id(4)]:"allowed"}})).resolves.toMatchObject({result:{accepted:true},revision:1});
});

it("refuses a non-replayable schema before committing dataset approval",async()=>{
  const f=await fixture(),schema="CREATE TABLE items(id INTEGER PRIMARY KEY AUTOINCREMENT,value TEXT NOT NULL,secret TEXT NOT NULL);";
  const definitionWithIntegerKey=structuredClone(definition);definitionWithIntegerKey.tables[0].fields[0].type="number";
  const revision=describeDatasetRevision({definition:definitionWithIntegerKey,revision:1,schemaSql:schema,operationSource});
  await expect(f.host.activate("owner",{workspaceId:"workspace",revision,schemaSql:schema,operationSource})).rejects.toThrow("AUTOINCREMENT");
  expect(f.db.prepare("SELECT COUNT(*) AS n FROM dohc_dataset_catalog").get()!.n).toBe(0);
  expect(f.db.prepare("SELECT COUNT(*) AS n FROM dohc_dataset_journals").get()!.n).toBe(0);
});

it("rechecks grants and data revision when a protected resource is read",async()=>{
  const f=await fixture();await f.activate();
  f.host.setDataGrant("owner",{...scope,principalKey:"helper",grant:{revision:1,revisionSha256:prepared.revision.revisionSha256,operationIds:[id(7)],discover:true}});
  const request={...scope,revision:1,revisionSha256:prepared.revision.revisionSha256,operationId:id(7),input:{},idempotencyKey:"file"};
  let read=false;
  const pending=f.host.readOperation("helper",request,()=>{read=true;return Buffer.from("file");});
  f.host.setDataGrant("owner",{...scope,principalKey:"helper",grant:null});
  await expect(pending).rejects.toThrow("not permitted");expect(read).toBe(false);
  await expect(f.host.readOperation("owner",request,()=>Buffer.from("file"))).resolves.toEqual(Buffer.from("file"));
  await expect(f.host.readOperation("owner",request,async()=>{read=true;})).rejects.toThrow("synchronous");expect(read).toBe(false);
  await expect(f.host.readOperation("owner",{...request,operationId:id(6)},()=>"file")).rejects.toThrow("read-only");
});

it("refuses file disclosure when a committed row change removes visibility after the read result",async()=>{
  const f=await fixture(),visibleSource=operationSource.replace("'SELECT id,value FROM items ORDER BY id'","'SELECT id,value FROM items WHERE value=? ORDER BY id',['visible']");
  const revision=describeDatasetRevision({definition,revision:1,schemaSql,operationSource:visibleSource});
  await f.host.activate("owner",{workspaceId:scope.workspaceId,revision,schemaSql,operationSource:visibleSource});
  const base={...scope,revision:1,revisionSha256:revision.revisionSha256};
  await f.host.invoke("owner",{...base,operationId:id(6),input:{value:"visible"},idempotencyKey:"create-visible"});
  const invoke=f.host.invoke.bind(f.host);
  f.host.invoke=async(context,input)=>{
    const result=await invoke(context,input);
    const record=(result.result as Array<{id:string}>)[0]!;
    await invoke("owner",{...base,operationId:id(8),input:{id:record.id,value:"hidden"},idempotencyKey:"hide-before-disclosure"});
    return result;
  };
  let disclosed=false;
  await expect(f.host.readOperation("owner",{...base,operationId:id(7),input:{},idempotencyKey:"read-visible"},()=>{disclosed=true;return "private receipt";})).rejects.toThrow("Dataset changed before");
  expect(disclosed).toBe(false);
  expect((await invoke("owner",{...base,operationId:id(7),input:{},idempotencyKey:"check-hidden"})).result).toEqual([]);
});


it("lets only owners acknowledge an exact committed response without exposing participant retry secrets", async () => {
  let refunded = 0;
  const f = await fixture({accountMetadata(_context, allocation) {refunded += allocation.bytes;}}); await f.activate();
  f.host.setBinding("owner", {...scope, appId: "form", binding: f.binding()});
  const attempts = createDatasetAttempts({db: f.db, transaction: f.transaction, account() {}});
  const attemptScope = {...scope, appId: "form", principalKey: "friend", operationId: id(6), revisionSha256: prepared.revision.revisionSha256};
  const pending = attempts.request(attemptScope, {action: "save", idempotencyKey: "request", input: {value: "private answer"}}, () => {});
  const unconfirmed = f.host.pendingAttempts("owner", scope).entries[0]!;
  expect(unconfirmed).toMatchObject({operation: "Submit", outcome: "unconfirmed", revision: null, recordedAtMs: null});
  expect(() => f.host.reconcileAttempt("owner", {...scope, reference: unconfirmed.reference, acknowledge: true})).toThrow("unconfirmed");
  await f.invoke("friend", id(6), {value: "private answer"}, "form");
  const review = f.host.pendingAttempts("owner", scope);
  expect(review.entries[0]).toMatchObject({reference: unconfirmed.reference, operation: "Submit", outcome: "committed", revision: 1, attachmentCount: 0});
  expect(JSON.stringify(review)).not.toMatch(/private answer|friend|idempotency|principal|token/);
  for (const caller of ["friend", "helper"] as const) {
    expect(() => f.host.pendingAttempts(caller, scope)).toThrow("not permitted");
    expect(() => f.host.reconcileAttempt(caller, {...scope, reference: unconfirmed.reference, acknowledge: true})).toThrow("not permitted");
  }
  expect(() => f.host.reconcileAttempt("owner", {...scope, reference: unconfirmed.reference, acknowledge: false as true})).toThrow("Review");
  const before = refunded;
  expect(f.host.reconcileAttempt("owner", {...scope, reference: unconfirmed.reference, acknowledge: true})).toEqual({cleared: true});
  expect(refunded).toBeLessThan(before);
  expect(attempts.request(attemptScope, {action: "get"}, () => {})).toEqual({attempt: null});
  expect((await f.invoke("friend", id(6), {value: "private answer"}, "form")).replayed).toBe(true);
  const next = attempts.request(attemptScope, {action: "save", idempotencyKey: "new", input: {value: "Next"}}, () => {});
  f.host.reconcileAttempt("owner", {...scope, reference: unconfirmed.reference, acknowledge: true});
  expect(attempts.request(attemptScope, {action: "get"}, () => {})).toEqual(next);
  expect(next.attempt!.token).not.toBe(pending.attempt!.token);
});

it("cancels an unconfirmed retry before queued execution and permanently refuses its key", async () => {
  const f = await fixture(); await f.activate(); f.host.setBinding("owner", {...scope, appId: "form", binding: f.binding()});
  const attempts = createDatasetAttempts({db: f.db, transaction: f.transaction, account() {}});
  const selected = {...scope, appId: "form", principalKey: "friend", operationId: id(6), revisionSha256: prepared.revision.revisionSha256};
  const saved = attempts.request(selected, {action: "save", idempotencyKey: "request", input: {value: "cancelled"}}, () => {});
  const reference = f.host.pendingAttempts("owner", scope).entries[0]!.reference;
  expect(() => assertDatasetAttemptsCommitted(f.db, scope)).toThrow("unconfirmed");
  for (const caller of ["helper", "friend"] as const) expect(() => f.host.cancelAttempt(caller, {...scope, reference, acknowledge: true})).toThrow("not permitted");
  expect(() => f.host.cancelAttempt("owner", {...scope, reference, acknowledge: false as true})).toThrow("Review");
  const queued = f.invoke("friend", id(6), {value: "cancelled"}, "form");
  expect(f.host.cancelAttempt("owner", {...scope, reference, acknowledge: true})).toEqual({cancelled: true});
  await expect(queued).rejects.toThrow("cancelled");
  expect(() => assertDatasetAttemptsCommitted(f.db, scope)).not.toThrow();
  expect(f.host.cancelAttempt("owner", {...scope, reference, acknowledge: true})).toEqual({cancelled: true});
  expect(attempts.request(selected, {action: "clear", token: saved.attempt!.token}, () => {})).toEqual({attempt: null});
  expect(() => attempts.request(selected, {action: "save", idempotencyKey: "request", input: {value: "changed"}}, () => {})).toThrow("cancelled");
  await expect(f.invoke("friend", id(6), {value: "changed"}, "form")).rejects.toThrow("cancelled");
  expect((await f.invoke("owner", id(7))).result).toEqual([]);
  expect(f.db.prepare("SELECT COUNT(*) n FROM dohc_dataset_receipts WHERE idempotency_key='request'").get()!.n).toBe(0);
  attempts.request(selected, {action: "save", idempotencyKey: "new-key", input: {value: "new"}}, () => {});
  await expect(f.host.invoke("friend", {...scope, access: {kind: "app", appId: "form"}, revision: 1, revisionSha256: selected.revisionSha256, operationId: id(6), input: {value: "new"}, idempotencyKey: "new-key"})).resolves.toMatchObject({replayed: false});
});

it("preserves a committed response when commit wins the owner cancellation race", async () => {
  const f = await fixture(); await f.activate(); f.host.setBinding("owner", {...scope, appId: "form", binding: f.binding()});
  const attempts = createDatasetAttempts({db: f.db, transaction: f.transaction, account() {}});
  const selected = {...scope, appId: "form", principalKey: "friend", operationId: id(6), revisionSha256: prepared.revision.revisionSha256};
  const saved = attempts.request(selected, {action: "save", idempotencyKey: "request", input: {value: "saved"}}, () => {});
  const reference = f.host.pendingAttempts("owner", scope).entries[0]!.reference;
  await f.invoke("friend", id(6), {value: "saved"}, "form");
  expect(() => f.host.cancelAttempt("owner", {...scope, reference, acknowledge: true})).toThrow("saved before cancellation");
  expect(attempts.request(selected, {action: "get"}, () => {})).toEqual(saved);
  expect(f.db.prepare("SELECT COUNT(*) n FROM dohc_dataset_cancelled_attempts").get()!.n).toBe(0);
  expect((await f.invoke("friend", id(6), {value: "saved"}, "form")).replayed).toBe(true);
});

it("rejects a worker proposal when the owner cancels immediately before journal commit", async () => {
  const f = await fixture(); await f.activate(); f.host.setBinding("owner", {...scope, appId: "form", binding: f.binding()});
  const attempts = createDatasetAttempts({db: f.db, transaction: f.transaction, account() {}});
  attempts.request({...scope, appId: "form", principalKey: "friend", operationId: id(6), revisionSha256: prepared.revision.revisionSha256}, {action: "save", idempotencyKey: "request", input: {value: "prepared"}}, () => {});
  const reference = f.host.pendingAttempts("owner", scope).entries[0]!.reference;
  const commit = f.journal.commitOperation.bind(f.journal);
  const interception = vi.spyOn(f.journal, "commitOperation").mockImplementation(input => {
    f.host.cancelAttempt("owner", {...scope, reference, acknowledge: true});
    return commit(input);
  });
  await expect(f.invoke("friend", id(6), {value: "prepared"}, "form")).rejects.toThrow("cancelled");
  expect(interception).toHaveBeenCalledOnce(); interception.mockRestore();
  expect((await f.invoke("owner", id(7))).result).toEqual([]);
  expect(f.db.prepare("SELECT COUNT(*) n FROM dohc_dataset_receipts").get()!.n).toBe(0);
});

it("refuses migration before staging until pending submissions are resolved", async () => {
  const stages = vi.fn();
  const f = await fixture({accountCheckpointStage: stages}); await f.activate();
  f.host.setBinding("owner", {...scope, appId: "form", binding: f.binding()});
  const attempts = createDatasetAttempts({db: f.db, transaction: f.transaction, account() {}});
  attempts.request({...scope, appId: "form", principalKey: "friend", operationId: id(6), revisionSha256: prepared.revision.revisionSha256}, {action: "save", idempotencyKey: "request", input: {value: "pending"}}, () => {});
  const expected = f.host.approvedArtifacts("owner", scope).cursor, revision = describeDatasetRevision({definition: {...definition, name: "Changed"}, revision: 2, schemaSql, operationSource});
  const change = {workspaceId: scope.workspaceId, revision, schemaSql, operationSource, expected, migrationSql: "SELECT 1;"};
  stages.mockClear();
  await expect(f.host.migrate("owner", change)).rejects.toThrow("unconfirmed"); expect(stages).not.toHaveBeenCalled();
  const reference = f.host.pendingAttempts("owner", scope).entries[0]!.reference;
  f.host.cancelAttempt("owner", {...scope, reference, acknowledge: true});
  await expect(f.host.migrate("owner", change)).resolves.toMatchObject({revision});
});

it("retains committed pending responses across schema migration for owner review", async () => {
  const f = await fixture(); await f.activate(); f.host.setBinding("owner", {...scope, appId: "form", binding: f.binding()});
  const attempts = createDatasetAttempts({db: f.db, transaction: f.transaction, account() {}});
  attempts.request({...scope, appId: "form", principalKey: "friend", operationId: id(6), revisionSha256: prepared.revision.revisionSha256}, {action: "save", idempotencyKey: "request", input: {value: "saved"}}, () => {});
  await f.invoke("friend", id(6), {value: "saved"}, "form");
  const reference = f.host.pendingAttempts("owner", scope).entries[0]!.reference;
  const expected = f.host.approvedArtifacts("owner", scope).cursor, revision = describeDatasetRevision({definition: {...definition, name: "Changed"}, revision: 2, schemaSql, operationSource});
  await f.host.migrate("owner", {workspaceId: scope.workspaceId, revision, schemaSql, operationSource, expected, migrationSql: "SELECT 1;"});
  expect(f.host.pendingAttempts("owner", scope).entries[0]).toMatchObject({reference, outcome: "committed"});
  expect(f.host.reconcileAttempt("owner", {...scope, reference, acknowledge: true})).toEqual({cleared: true});
});

it("rolls back a prepared migration if a submission appears before its final transaction", async () => {
  const f = await fixture(); await f.activate();
  const attempts = createDatasetAttempts({db: f.db, transaction: f.transaction, account() {}});
  const expected = f.host.approvedArtifacts("owner", scope).cursor, revision = describeDatasetRevision({definition: {...definition, name: "Changed"}, revision: 2, schemaSql, operationSource});
  const transition = f.journal.transitionCheckpoint.bind(f.journal);
  const interception = vi.spyOn(f.journal, "transitionCheckpoint").mockImplementation(input => {
    attempts.request({...scope, appId: "form", principalKey: "friend", operationId: id(6), revisionSha256: prepared.revision.revisionSha256}, {action: "save", idempotencyKey: "request", input: {value: "arrived"}}, () => {});
    return transition(input);
  });
  await expect(f.host.migrate("owner", {workspaceId: scope.workspaceId, revision, schemaSql, operationSource, expected, migrationSql: "SELECT 1;"})).rejects.toThrow("unconfirmed");
  expect(interception).toHaveBeenCalledOnce(); interception.mockRestore();
  expect(f.host.approvedArtifacts("owner", scope).revision.revision).toBe(1);
  expect(f.host.pendingAttempts("owner", scope).entries[0]!.outcome).toBe("unconfirmed");
});

it("rolls cancellation and its storage delta back together when accounting fails", async () => {
  let failAccounting = false;
  const f = await fixture({accountMetadata() { if (failAccounting) throw Error("accounting refused"); }}); await f.activate();
  f.host.setBinding("owner", {...scope, appId: "form", binding: f.binding()});
  const attempts = createDatasetAttempts({db: f.db, transaction: f.transaction, account() {}});
  const selected = {...scope, appId: "form", principalKey: "friend", operationId: id(6), revisionSha256: prepared.revision.revisionSha256};
  const saved = attempts.request(selected, {action: "save", idempotencyKey: "request", input: {value: "retained"}}, () => {});
  const reference = f.host.pendingAttempts("owner", scope).entries[0]!.reference;
  failAccounting = true;
  expect(() => f.host.cancelAttempt("owner", {...scope, reference, acknowledge: true})).toThrow("accounting refused");
  expect(f.db.prepare("SELECT COUNT(*) n FROM dohc_dataset_cancelled_attempts").get()!.n).toBe(0);
  expect(attempts.request(selected, {action: "get"}, () => {})).toEqual(saved);
});
