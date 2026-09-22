import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { VersionedLiveAdapter } from "@dohc/workspace-engine-client";
import { DatasetMigrationPreparation, DatasetRequest, DatasetResult } from "@dohc/cli/dataset";
import type { DatasetDefinition, DatasetRevision } from "@dohc/security-contract/dataset";
import { createLocalDatasetHost, type LocalDatasetHost, type LocalDatasetHostOptions } from "./localDatasetHost";
import { createDatasetHandler } from "../ipc/datasetIpc";

vi.setConfig({ testTimeout: 20_000 });
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
  const host = await createLocalDatasetHost({ workspaceId: "w", workspaceRoot, capacityBytes: 1024 * 1024, ...extra });
  hosts.push(host); return { host, workspaceRoot };
}
function fixture() {
  const files = new Map([["items/dataset.json", JSON.stringify(definition)], [definition.schemaPath, schema], [definition.operationsPath, source]]);
  const blobs = new Map<string, Uint8Array>();
  const adapter = new VersionedLiveAdapter({ close() {}, async sendRequest(request) {
    const params = request.params as Record<string, unknown>;
    if (request.method === "versionedText.captureSources") {
      const selected = [...params.paths as string[]].sort().map(path => {
        const bytes = Buffer.from(files.get(path)!), sha256 = digest(bytes); blobs.set(sha256, bytes);
        return { path, objectId: path, contentKind: "text", sha256, byteLength: bytes.byteLength, latestMomentId: "m" };
      });
      return { id: request.id, result: { workspaceId: "w", versionId: "main", files: selected, totalBytes: selected.reduce((n, f) => n + f.byteLength, 0),
        sourceDigest: digest(JSON.stringify(["dohc-source-capture-v1", "w", "main", selected])) } };
    }
    const bytes = blobs.get(String(params.sha256))!;
    return { id: request.id, result: { bytesBase64: Buffer.from(bytes).toString("base64"), byteLength: bytes.byteLength } };
  } }, "owner", { workspaceId: "w" });
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
    expect(review.candidate.preview.tables).toEqual([{ table: "items", beforeRows: 1, afterRows: 1, changedRows: 1 }]);
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
    await expect(restarted.query(call(first, id(5)))).rejects.toThrow(/rules changed/);
    const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");
    const db = new DatabaseSync(join(workspaceRoot, ".dohc", "datasets", "state.sqlite"), { readOnly: true });
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

  it("previews every deleted record across bounded pages before approval", async () => {
    const { host } = await open(), f = fixture(), first = await activate(host, f);
    for (let index = 0; index < 3; index++) await host.action(call(first, id(6), { name: `Record ${index}` }, `record-${index}`));
    f.next();
    f.files.set("items/migration.sql", "ALTER TABLE items ADD COLUMN note TEXT; DELETE FROM items;");
    const review = await prepare(host, f);
    expect(review.candidate.preview.tables).toEqual([{ table: "items", beforeRows: 3, afterRows: 0, changedRows: 3 }]);
    const changes = [];
    let after: string | undefined;
    do {
      const page = await host.migrationPreviewPage({ workspaceId: "w", datasetId: id(1), candidateId: review.candidate.candidateId, after, limit: 1 });
      expect(page.changes).toHaveLength(1); changes.push(...page.changes); after = page.nextCursor ?? undefined;
    } while (after);
    expect(changes.map(change => change.before!.name).sort()).toEqual(["Record 0", "Record 1", "Record 2"]);
    expect(changes.every(change => change.kind === "delete" && change.after === null)).toBe(true);
    expect((await host.query(call(first, id(5)))).result).toHaveLength(3);
    const migrated = await host.approveMigration(approval(review));
    expect((await host.query(call(migrated.revision, id(5)))).result).toEqual([]);
  });

  it("commits the previewed random values without rerunning migration SQL", async () => {
    const { host } = await open(), f = fixture(), first = await activate(host, f);
    await host.action(call(first, id(6), { name: "Before" }, "random"));
    f.next(); f.files.set("items/migration.sql", "ALTER TABLE items ADD COLUMN note TEXT; UPDATE items SET name=lower(hex(randomblob(16)));");
    const review = await prepare(host, f);
    const expectedName = review.candidate.preview.firstPage.changes[0]!.after!.name;
    const migrated = await host.approveMigration(approval(review));
    expect((await host.query(call(migrated.revision, id(5)))).result).toEqual([{ id: expect.any(String), name: expectedName, note: null }]);
  });

  it("refuses a failed value conversion before producing an approvable review", async () => {
    const { host } = await open(), f = fixture(), first = await activate(host, f);
    await host.action(call(first, id(6), { name: "Must stay" }, "unchanged"));
    f.next(); f.files.set("items/migration.sql", "ALTER TABLE items ADD COLUMN note TEXT; UPDATE items SET name=NULL;");
    await expect(prepare(host, f)).rejects.toThrow();
    expect(host.describe(id(1)).revision).toBe(1);
    expect((await host.query(call(first, id(5)))).result).toEqual([{ id: expect.any(String), name: "Must stay" }]);
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

  it("rejects mismatched target schema and never publishes partial changes", async () => {
    const { host } = await open(), f = fixture(), first = await activate(host, f); f.next();
    f.files.set("items/migration.sql", "SELECT 1;");
    await expect(prepare(host, f)).rejects.toThrow(/schema/i);
    expect(host.approvedArtifacts(id(1)).revision).toEqual(first);
    expect((await host.query(call(first, id(5)))).result).toEqual([]);
  });

  it("routes owner IPC and CLI review/approval through the same actual host", async () => {
    const { host } = await open(), f = fixture(); await activate(host, f); f.next();
    const workspace = { workspaceId: "w" }, signal = new AbortController().signal;
    const handler = createDatasetHandler({ withWorkspaceOperation: async (_caller, _id, work) => {
      let active = true;
      try { return await work({ workspace, signal, assertCurrent() { if (!active) throw new Error("This workspace authority lease was released."); } }); }
      finally { active = false; }
    },
      hostForWorkspace: async () => host, withAdapter: async (_workspace, work) => work(f.adapter), createSources: async () => {} });
    const prepared = await handler("owner", DatasetRequest.parse({ workspaceId: "w", action: "prepareMigration", datasetId: id(1), descriptorPath: "items/dataset.json", migrationPath: "items/migration.sql" }));
    expect(DatasetResult.parse(prepared).kind).toBe("migration-prepared");
    if (prepared.kind !== "migration-prepared") throw new Error("Missing migration review");
    const migrated = await handler("owner", { workspaceId: "w", action: "approveMigration", ...approval(prepared) });
    expect(DatasetResult.parse(migrated).kind).toBe("migrated");
  });
});
