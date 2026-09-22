import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { VersionedLiveAdapter } from "@dohc/workspace-engine-client";
import type { DatasetDefinition, DatasetRevision } from "@dohc/security-contract/dataset";
import type { DatasetSchemaChange } from "@dohc/cli/dataset";
import { generateDatasetSchemaChange } from "./datasetSchemaChanges";
import { generateDatasetSources } from "./datasetGenerator";
import { createLocalDatasetHost, type LocalDatasetHost } from "./localDatasetHost";
import { createDatasetHandler } from "../ipc/datasetIpc";
import { datasetDefinitionFromDrafts } from "../renderer/collections/datasetDefinitionFromDrafts";

vi.setConfig({ testTimeout: 20_000 });
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const digest = (bytes: string | Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const definition: DatasetDefinition = { formatVersion: 1, datasetId: id(1), name: "People", schemaPath: "people/schema.sql", operationsPath: "people/operations.js",
  tables: [{ tableId: id(2), name: "People", sqlName: "people", primaryKey: "id", fields: [
    { fieldId: id(3), name: "ID", sqlColumn: "id", type: "text", required: true, unique: true },
    { fieldId: id(4), name: "Name", sqlColumn: "name", type: "text", required: true, unique: false },
  ] }], operations: [
    { operationId: id(5), name: "list", label: "List", tableId: id(2), kind: "read", access: "owner", readOnly: true, fieldIds: [id(3), id(4)] },
    { operationId: id(6), name: "add", label: "Add", tableId: id(2), kind: "create", access: "owner", readOnly: false, fieldIds: [id(4)] },
    { operationId: id(7), name: "edit", label: "Edit", tableId: id(2), kind: "edit", access: "owner", readOnly: false, fieldIds: [id(4)] },
    { operationId: id(8), name: "submit", label: "Submit", tableId: id(2), kind: "create", access: "link", readOnly: false, fieldIds: [id(4)] },
  ] };
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const run of cleanup.splice(0).reverse()) await run(); });
async function fixture(initial: DatasetDefinition = definition, remote = false) {
  const root = await mkdtemp(join(tmpdir(), "dohc-schema-evolution-"));
  const host = await createLocalDatasetHost({ workspaceId: "w", workspaceRoot: root, capacityBytes: 1024 * 1024 });
  cleanup.push(async () => { await host.close(); await rm(root, { recursive: true, force: true }); });
  const files = new Map(Object.entries(generateDatasetSources(initial).files)), blobs = new Map<string, Uint8Array>();
  const adapter = new VersionedLiveAdapter({ close() {}, async sendRequest(request) {
    const input = request.params as Record<string, unknown>;
    if (request.method === "versionedText.captureSources") {
      const selected = [...input.paths as string[]].sort().map(path => { const bytes = Buffer.from(files.get(path)!); const sha256 = digest(bytes); blobs.set(sha256, bytes);
        return { path, objectId: path, contentKind: "text", sha256, byteLength: bytes.byteLength, latestMomentId: "m" }; });
      return { id: request.id, result: { workspaceId: "w", versionId: "main", files: selected, totalBytes: selected.reduce((n, f) => n + f.byteLength, 0), sourceDigest: digest(JSON.stringify(["dohc-source-capture-v1", "w", "main", selected])) } };
    }
    const bytes = blobs.get(String(input.sha256))!;
    return { id: request.id, result: { bytesBase64: Buffer.from(bytes).toString("base64"), byteLength: bytes.byteLength } };
  } }, "owner", { workspaceId: "w" });
  const first = await host.prepare({ descriptorPath: "people/dataset.json", adapter });
  const revision = await host.approve({ preparationId: first.preparationId, revisionSha256: first.revision.revisionSha256 });
  const workspace = { workspaceId: "w" };
  let signal = new AbortController().signal, scope = "window:1", credentialGeneration = 1;
  let alterSources: ((paths: string[]) => void) | undefined;
  const local = remote ? { approvedArtifacts() { throw new Error("Local store is fenced"); }, migrate() { throw new Error("Local store is fenced"); } } as unknown as LocalDatasetHost : host;
  const handler = createDatasetHandler({ withWorkspaceOperation: async (_caller, _id, work) => {
    let active = true;
    try { return await work({ workspace, signal, scope, assertCurrent() { if (!active) throw new Error("This workspace authority lease was released."); } }); }
    finally { active = false; }
  }, currentCredentialGeneration: () => credentialGeneration,
    hostForWorkspace: async () => local, ...(remote ? { dataForWorkspace: async () => ({ approvedArtifacts: async (datasetId: string) => host.approvedArtifacts(datasetId), migrate: host.migrate }) as unknown as import("./remoteDataset").OwnerDatasetData } : {}), withAdapter: async (_workspace, work) => work(adapter), createSources: async (_workspace, sources) => {
      for (const [path, source] of Object.entries(sources)) { if (files.has(path)) throw new Error("Existing source"); files.set(path, source); }
      alterSources?.(Object.keys(sources));
    } });
  async function prepare(change: DatasetSchemaChange, current = host.approvedArtifacts(id(1)).revision) {
    const result = await handler("owner", { action: "prepareSchemaChange", workspaceId: "w", datasetId: id(1), revision: current.revision, revisionSha256: current.revisionSha256, change });
    if (result.kind !== "migration-prepared") throw new Error("Expected a review"); return result;
  }
  return { host, files, revision, prepare, handler, tamper(fn: (paths: string[]) => void) { alterSources = fn; },
    changeCredentials() { credentialGeneration++; }, changeScope() { scope = "window:2"; }, changeLifetime() { signal = new AbortController().signal; } };
}
const call = (revision: DatasetRevision, operationId: string, input = {}, key = "read") => ({ datasetId: id(1), revision: revision.revision,
  revisionSha256: revision.revisionSha256, operationId, input, idempotencyKey: key });
const approve = async (setup: Awaited<ReturnType<typeof fixture>>, review: Awaited<ReturnType<Awaited<ReturnType<typeof fixture>>["prepare"]>>) => {
  const result = await setup.handler("owner", { action: "approveMigration", workspaceId: "w", preparationId: review.preparationId,
    revisionSha256: review.revision.revisionSha256, approvalDigest: review.approvalDigest });
  if (result.kind !== "migrated") throw new Error("Expected migration");
  return result;
};

it("adds a required defaulted field through captured approval and keeps row IDs, values and stable operation IDs", async () => {
  const f = await fixture();
  const added = await f.host.action(call(f.revision, id(6), { values: { [id(4)]: "Camera" } }, "first"));
  const review = await f.prepare({ kind: "addField", tableId: id(2), field: { name: "Status", type: "select", required: true, unique: false, options: ["New", "Done"], default: "New" } });
  expect(f.host.describe(id(1)).revision).toBe(1);
  const field = review.revision.definition.tables[0]!.fields.at(-1)!;
  expect(review.revision.definition.operations.find(op => op.operationId === id(8))!.fieldIds).toEqual([id(4),field.fieldId]);
  const next = await approve(f, review);
  const rows = (await f.host.query(call(next.revision, id(5)))).result as { rows: Array<{ id: string; version: number; values: Record<string, unknown> }> };
  expect(rows.rows[0]!.id).toBe((added.result as { id: string }).id);
  expect(rows.rows[0]!.values).toMatchObject({ [id(4)]: "Camera", [field.fieldId]: "New" });
  await f.host.action(call(next.revision, id(7), { id: rows.rows[0]!.id, expectedVersion: 1, values: { [field.fieldId]: "Done" } }, "edit"));
  expect(f.files.get("people/operations.js")).toBe(generateDatasetSources(definition).files[definition.operationsPath]);
  await expect(f.host.query(call(f.revision, id(5)))).rejects.toThrow("rules changed");
});

it("keeps stable field/table IDs across consecutive add and label changes", async () => {
  const f = await fixture();
  await f.host.action(call(f.revision, id(6), { values: { [id(4)]: "Ada" } }, "first"));
  const first = await approve(f, await f.prepare({ kind: "addField", tableId: id(2), field: { name: "Note", type: "text", required: false, unique: false } }));
  const second = await approve(f, await f.prepare({ kind: "addField", tableId: id(2), field: { name: "Amount", type: "number", required: false, unique: false, default: 3 } }));
  const noteId = first.revision.definition.tables[0]!.fields.at(-1)!.fieldId;
  const renamed = await approve(f, await f.prepare({ kind: "renameField", tableId: id(2), fieldId: noteId, name: "Notes" }));
  expect(renamed.revision.definition.tables[0]!.fields.find(f => f.fieldId === noteId)!.name).toBe("Notes");
  const renamedTable = await approve(f, await f.prepare({ kind: "renameTable", tableId: id(2), name: "Guests" }));
  expect(renamedTable.revision.definition.tables[0]!).toMatchObject({ tableId: id(2), sqlName: "people", name: "Guests" });
  expect(second.revision.definition.tables[0]!.fields.map(f => f.fieldId)).toEqual(renamedTable.revision.definition.tables[0]!.fields.map(f => f.fieldId));
  const result = (await f.host.query(call(renamedTable.revision, id(5)))).result as { rows: Array<{ values: Record<string, unknown> }> };
  expect(result.rows[0]!.values[id(4)]).toBe("Ada");
  expect(result.rows[0]!.values[noteId]).toBeNull();
});

it("adds a unique field as an index and rejects duplicate values through existing operations", async () => {
  const f = await fixture(), next = await approve(f, await f.prepare({ kind: "addField", tableId: id(2), field: { name: "Email", type: "text", required: false, unique: true } }));
  const field = next.revision.definition.tables[0]!.fields.at(-1)!;
  await f.host.action(call(next.revision, id(6), { values: { [id(4)]: "One", [field.fieldId]: "one@example.com" } }, "one"));
  await expect(f.host.action(call(next.revision, id(6), { values: { [id(4)]: "Two", [field.fieldId]: "one@example.com" } }, "two"))).rejects.toThrow(/already uses/);
});

it("refuses changed capture, stale revision, missing required defaults and authored rules", async () => {
  const f = await fixture();
  await expect(f.prepare({ kind: "addField", tableId: id(2), field: { name: "Required", type: "text", required: true, unique: false } })).rejects.toThrow("needs a default");
  await expect(f.prepare({ kind: "renameField", tableId: id(2), fieldId: id(4), name: "Person" }, { ...f.revision, revisionSha256: "0".repeat(64) })).rejects.toThrow("rules changed");
  const artifacts = f.host.approvedArtifacts(id(1));
  expect(() => generateDatasetSchemaChange({ ...artifacts, operationSource: artifacts.operationSource + "\n// custom", change: { kind: "renameCollection", name: "Guests" } })).toThrow("custom actions");
  f.tamper(paths => { const migration = paths.find(path => path.endsWith("migration.sql"))!; f.files.set(migration, "DELETE FROM people;"); });
  await expect(f.prepare({ kind: "renameCollection", name: "Guests" })).rejects.toThrow("differs from this review");
  expect(f.host.describe(id(1)).revision).toBe(1);
});

it("updates the default no-agent Collection actions so new fields are visible and editable", async () => {
  const initial = datasetDefinitionFromDrafts({ datasetId:id(1),tableId:id(2),name:"People",schemaPath:"people/schema.sql",operationsPath:"people/operations.js",
    fields:[{name:"Name",type:"text",required:false,unique:false}] });
  const f=await fixture(initial), next=await approve(f,await f.prepare({kind:"addField",tableId:id(2),field:{name:"Note",type:"text",required:false,unique:false}}));
  const field=next.revision.definition.tables[0]!.fields.at(-1)!;
  expect(f.host.describe(id(1)).tables[0]!.fields.some(candidate=>candidate.fieldId===field.fieldId)).toBe(true);
  const create=next.revision.definition.operations.find(operation=>operation.kind==="create")!;
  const read=next.revision.definition.operations.find(operation=>operation.kind==="read")!;
  await f.host.action(call(next.revision,create.operationId,{values:{[field.fieldId]:"Visible"}},"native"));
  const result=(await f.host.query(call(next.revision,read.operationId))).result as {rows:Array<{values:Record<string,unknown>}>};
  expect(result.rows[0]!.values[field.fieldId]).toBe("Visible");
});

it("captures remote schema changes without opening the fenced local store and binds approval to the caller", async () => {
  const f = await fixture(definition, true);
  const review = await f.prepare({ kind: "renameCollection", name: "Remote people" });
  const input = { action: "approveMigration", workspaceId: "w", preparationId: review.preparationId, revisionSha256: review.revision.revisionSha256, approvalDigest: review.approvalDigest };
  await expect(f.handler("another owner session", input)).rejects.toThrow(/review expired/);
  const changed = await approve(f, review);
  expect(changed.revision.definition.name).toBe("Remote people");
  await expect(f.handler("owner", input)).rejects.toThrow(/review expired/);
});

it.each(["changeCredentials", "changeScope", "changeLifetime"] as const)("refuses a saved review after %s", async change => {
  const f = await fixture(definition, true);
  const review = await f.prepare({ kind: "renameCollection", name: "Remote people" });
  f[change]();
  await expect(approve(f, review)).rejects.toThrow(/review expired/);
  expect(f.host.describe(id(1)).revision).toBe(1);
});

it("retains captured review bytes after the preparation operation releases its lease", async () => {
  const f = await fixture();
  const review = await f.prepare({ kind: "renameCollection", name: "Reviewed people" });
  review.revision.definition.name = "Changed after review";
  const result = await approve(f, review);
  expect(result.revision.definition.name).toBe("Reviewed people");
});

it("consumes approval before an uncertain remote migration reply", async () => {
  const f = await fixture(definition, true);
  const review = await f.prepare({ kind: "renameCollection", name: "Remote people" });
  const migrate = vi.spyOn(f.host, "migrate").mockRejectedValue(new Error("Remote reply lost"));
  await expect(approve(f, review)).rejects.toThrow("Remote reply lost");
  await expect(approve(f, review)).rejects.toThrow(/review expired/);
  expect(migrate).toHaveBeenCalledTimes(1);
});

it("refuses a credential change during approval before sending migration SQL", async () => {
  const f = await fixture(definition, true);
  const review = await f.prepare({ kind: "renameCollection", name: "Remote people" });
  const approvedArtifacts = f.host.approvedArtifacts;
  vi.spyOn(f.host, "approvedArtifacts").mockImplementationOnce(datasetId => {
    f.changeCredentials();
    return approvedArtifacts(datasetId);
  });
  const migrate = vi.spyOn(f.host, "migrate");
  await expect(approve(f, review)).rejects.toThrow(/server session changed/);
  expect(migrate).not.toHaveBeenCalled();
});
