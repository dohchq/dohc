import { createHash } from "node:crypto";
import { openedLocalState } from "../testing/preparedLocalState";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { sourceCaptureAdapter } from "../testing/sourceCaptureAdapter";
import { DatasetMigrationPreparation } from "@dohc/cli/dataset";
import type { DatasetDefinition, DatasetRevision } from "@dohc/security-contract/dataset";
import { createLocalDatasetHost, type LocalDatasetHost, type LocalDatasetHostOptions } from "./localDatasetHost";
import { createDatasetFixtureCompiler } from "../testing/datasetFixtureCompiler";
import type { Request, Response } from "@dohc/workspace-engine-client";
import { EngineWorkspaceSessions, type EngineDaemonClient } from "@dohc/workspace-engine-client/daemon";
import { deferred } from "../testing/deferred";
import { readLocalStateFrom } from "./workspaceLocalState";
import { unguardedCollections } from "../testing/collectionsHolder";

const compileFixture = createDatasetFixtureCompiler();

const digest = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const definition: DatasetDefinition = { formatVersion: 1, datasetId: id(1), name: "Items", schemaPath: "items/schema.sql", operationsPath: "items/operations.ts",
  tables: [{ tableId: id(2), name: "Items", sqlName: "items", primaryKey: "id", fields: [
    { fieldId: id(3), name: "ID", sqlColumn: "id", type: "text", required: true, unique: true },
    { fieldId: id(4), name: "Name", sqlColumn: "name", type: "text", required: true, unique: false },
  ] }], operations: [
    { operationId: id(5), name: "list", label: "List", tableId: id(2), kind: "read", access: "owner", readOnly: true, fieldIds: [id(3), id(4)] },
    { operationId: id(6), name: "add", label: "Add", tableId: id(2), kind: "create", access: "owner", readOnly: false, fieldIds: [id(4)] },
  ] };
const schema = "CREATE TABLE items(id TEXT PRIMARY KEY NOT NULL,name TEXT NOT NULL);";
const source = `globalThis.operations={list(ctx:any){return ctx.db.query('SELECT * FROM items ORDER BY id');},
  add(ctx:any,input:any){ctx.db.execute('INSERT INTO items(id,name) VALUES(?,?)',[ctx.requestId,input.name]);return input.name;}};`;
const roots: string[] = [], hosts: LocalDatasetHost[] = [];
async function open(extra: Partial<LocalDatasetHostOptions> = {}) {
  const workspaceRoot = extra.workspaceRoot ?? await mkdtemp(join(tmpdir(), "dohc-migration-test-"));
  if (!extra.workspaceRoot) roots.push(workspaceRoot);
  // Workers and exports live in .dohc/local, which an engine open prepares.
  await openedLocalState({ workspaceId: "w", rootPath: workspaceRoot });
  const host = await createLocalDatasetHost({ localPersonId: () => "person-local", workspaceId: "w", workspaceRoot, capacityBytes: 1024 * 1024, compile: compileFixture, ...extra, holder: extra.holder ?? unguardedCollections });
  hosts.push(host); return { host, workspaceRoot };
}
function fixture() {
  const files = new Map([["items/dataset.json", JSON.stringify(definition)], [definition.schemaPath, schema], [definition.operationsPath, source]]);
  const adapter = sourceCaptureAdapter(files);
  const next = () => {
    const updated = structuredClone(definition);
    updated.tables[0]!.fields.push({ fieldId: id(7), name: "Note", sqlColumn: "note", type: "text", required: false, unique: false });
    updated.operations[0]!.fieldIds.push(id(7));
    files.set("items/dataset.json", JSON.stringify(updated));
    files.set(definition.schemaPath, "CREATE TABLE items(id TEXT PRIMARY KEY NOT NULL,name TEXT NOT NULL, note TEXT);");
    files.set("items/migration.sql", "ALTER TABLE items ADD COLUMN note TEXT; UPDATE items SET name=name||' migrated';");
  };
  return { files, adapter, next };
}
async function activate(host: LocalDatasetHost, f: ReturnType<typeof fixture>) {
  const preparation = await host.prepare({ descriptorPath: "items/dataset.json", adapter: f.adapter });
  return host.approve({ preparationId: preparation.preparationId, revisionSha256: preparation.revision.revisionSha256 });
}
const call = (revision: DatasetRevision, operationId: string, input = {}, key = "read") => ({ datasetId: id(1), revision: revision.revision,
  revisionSha256: revision.revisionSha256, operationId, input, idempotencyKey: key });
const prepare = (host: LocalDatasetHost, f: ReturnType<typeof fixture>) => host.prepareMigration({ datasetId: id(1), descriptorPath: "items/dataset.json", migrationPath: "items/migration.sql", adapter: f.adapter });
const approval = (review: Awaited<ReturnType<typeof prepare>>) => ({ preparationId: review.preparationId, revisionSha256: review.revision.revisionSha256, approvalDigest: review.approvalDigest });
afterEach(async () => {
  vi.restoreAllMocks();
  for (const host of hosts.splice(0)) await host.close();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe("owner Collection migration", () => {

  it("commits reviewed bytes once, retains recovery history, and restores the new schema after restart", async () => {
    const { host, workspaceRoot } = await open(), f = fixture(), first = await activate(host, f);
    await host.action(call(first, id(6), { name: "Camera" }, "add"));
    f.next();
    const review = await prepare(host, f), exact = approval(review);
    expect(DatasetMigrationPreparation.parse(review).expected.revision).toBe(1);
    expect(review.candidate.preview.tables).toEqual([{ table: "items", beforeRows: 1, afterRows: 1, changedRows: 1, deletedRows: 0, beforeValues: { id: 1, name: 1 }, afterValues: { id: 1, name: 1, note: 0 }, clearedValues: { id: 0, name: 0 } }]);
    expect(review.candidate.preview.firstPage.changes).toMatchObject([{ table: "items", kind: "update", before: { name: "Camera" }, after: { name: "Camera migrated", note: null } }]);
    expect((await host.query(call(first, id(5)))).result).toEqual([{ id: expect.any(String), name: "Camera" }]);
    f.files.set("items/migration.sql", "DROP TABLE items;");
    review.migrationSql = "DROP TABLE items;";
    review.revision.definition.name = "Tampered";
    const migrated = await host.approveMigration(exact);
    expect(migrated.revision.revision).toBe(2);
    expect(migrated.revision.definition.name).toBe("Items");
    await expect(host.approveMigration(exact)).rejects.toThrow(/expired or changed/);
    await host.close();
    const restarted = (await open({ workspaceRoot })).host;
    expect((await restarted.query(call(migrated.revision, id(5)))).result).toEqual([{ id: expect.any(String), name: "Camera migrated", note: null }]);
    await expect(restarted.query(call(first, id(5)))).rejects.toThrow(/Its owner must approve this access again/);
    const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");
    const db = new DatabaseSync(join(workspaceRoot, ".dohc", "local", "datasets", "state.sqlite"), { readOnly: true });
    try {
      expect(db.prepare("SELECT count(*) AS count FROM dohc_dataset_catalog_history").get()!.count).toBe(1);
      expect(db.prepare("SELECT count(*) AS count FROM dohc_dataset_checkpoint_history").get()!.count).toBe(1);
    } finally { db.close(); }
  });

  it("refuses a stale data cursor without applying SQL", async () => {
    const { host } = await open(), f = fixture(), first = await activate(host, f);
    f.next(); const review = await prepare(host, f);
    await host.action(call(first, id(6), { name: "After review" }, "late"));
    await expect(host.approveMigration(approval(review))).rejects.toThrow(/changed after review/);
    expect(host.describe(id(1)).revision).toBe(1);
    expect((await host.query(call(first, id(5)))).result).toEqual([{ id: expect.any(String), name: "After review" }]);
    await expect(host.approveMigration(approval(review))).rejects.toThrow(/expired or changed/);
  });

  it("rolls back a rejected migration allocation with data and schema intact", async () => {
    let reject = true;
    const { host } = await open({ resources: () => ({ accountMigration() { if (reject) throw new Error("quota refused"); } }) });
    const f = fixture(), first = await activate(host, f);
    await host.action(call(first, id(6), { name: "Camera" }, "one"));
    f.next(); const review = await prepare(host, f);
    await expect(host.approveMigration(approval(review))).rejects.toThrow("quota refused");
    expect(host.describe(id(1)).revision).toBe(1);
    expect((await host.query(call(first, id(5)))).result).toEqual([{ id: expect.any(String), name: "Camera" }]);
    reject = false;
    const second = await prepare(host, f), migrated = await host.approveMigration(approval(second));
    expect((await host.query(call(migrated.revision, id(5)))).result).toEqual([{ id: expect.any(String), name: "Camera migrated", note: null }]);
  });

  it("refuses changed approval, expired review, discarded review and foreign source identity", async () => {
    const { host } = await open(), f = fixture(); await activate(host, f); f.next();
    const review = await prepare(host, f);
    await expect(host.approveMigration({ ...approval(review), approvalDigest: "0".repeat(64) })).rejects.toThrow(/expired or changed/);
    await host.discardMigration(review.preparationId);
    await expect(host.approveMigration(approval(review))).rejects.toThrow(/expired or changed/);
    const expired = await prepare(host, f);
    vi.spyOn(Date, "now").mockReturnValue(expired.expiresAtMs);
    await expect(host.approveMigration(approval(expired))).rejects.toThrow(/expired or changed/);
    f.files.set("items/dataset.json", JSON.stringify({ ...definition, datasetId: id(99) }));
    await expect(prepare(host, f)).rejects.toThrow(/another Collection/);
  });
});

// A daemon whose opens prepare `.dohc/local` as the engine's do.
class Daemon implements EngineDaemonClient {
  async sendRequest(request: Request): Promise<Response> {
    if (request.method === "workspace.open") {
      const { rootDir } = request.params as { rootDir: string };
      await mkdir(join(rootDir, ".dohc", "local"), { recursive: true });
      return { id: request.id, result: { workspace: "handle", localStateReady: true } };
    }
    if (request.method === "workspace.close") return { id: request.id, result: { closed: true } };
    throw new Error(`Unexpected method: ${request.method}`);
  }
  close(): void {}
}

// The store opens only once an engine open prepared `.dohc/local`, and its
// host holds its worker folder from then on. A staged export still takes its
// folder each time, after the open that let the store open may have ended.
describe("a Collection export during an engine run", () => {
  // A host opened while an earlier open had prepared `.dohc/local`, in the attachment the sessions below open.
  async function reopened(workspace: { workspaceId: string; rootPath: string; attachmentId: symbol }, first: LocalDatasetHost) {
    // Windows can't take the worker folder while the first host holds it.
    await first.close();
    const host = await createLocalDatasetHost({ holder: unguardedCollections, localPersonId: () => "person-local", workspaceId: "w", workspaceRoot: workspace.rootPath,
      attachmentId: workspace.attachmentId, capacityBytes: 1024 * 1024, compile: compileFixture });
    hosts.push(host);
    return host;
  }

  it("refuses at once when a rebind closes the open before the export takes its folder", async () => {
    const first = await open(), f = fixture();
    await activate(first.host, f);
    const workspace = { workspaceId: "w", rootPath: first.workspaceRoot, attachmentId: Symbol("w") };
    const host = await reopened(workspace, first.host);
    const daemon = new Daemon(), sessions = new EngineWorkspaceSessions({ currentClient: () => daemon }, { sleep: async () => undefined });
    try {
      readLocalStateFrom(sessions);
      // The dataset IPC exports inside an engine run. A rebind's close waits for that run.
      const inRun = deferred<void>(), proceed = deferred<void>();
      const exported = sessions.run(workspace, async () => { inRun.resolve(); await proceed.promise; return host.prepareExport(id(1)); });
      await inRun.promise;
      const closing = sessions.closeWorkspaceBinding(workspace);
      proceed.resolve();
      await expect(exported).rejects.toThrow("dohc did not prepare this Collection's recovery file because the workspace has not finished opening.");
      await closing;
    } finally { await sessions.closeAll(); }
  });
});
