import { mkdtemp, rm } from "node:fs/promises";
import { openedLocalState } from "../testing/preparedLocalState";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { sourceCaptureAdapter } from "../testing/sourceCaptureAdapter";
import { type DatasetDefinition, type DatasetRevision } from "@dohc/security-contract/dataset";
import type { DatasetSchemaChange } from "@dohc/cli/dataset";
import { DatasetSchemaChangeError, generateDatasetSchemaChange } from "./datasetSchemaChanges";
import { invalidateDatasetAddresses, resolveDatasetAddress } from "./datasetAddress";
import { generateDatasetSources } from "./datasetGenerator";
import { createLocalDatasetHost, type LocalDatasetHost } from "./localDatasetHost";
import { createDatasetHandler } from "../ipc/datasetIpc";

import { createDatasetFixtureCompiler } from "../testing/datasetFixtureCompiler";
import { unguardedCollections } from "../testing/collectionsHolder";

const compileFixture = createDatasetFixtureCompiler();

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
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
  // Workers and exports live in .dohc/local, which an engine open prepares.
  await openedLocalState({ workspaceId: "w", rootPath: root });
  const host = await createLocalDatasetHost({ holder: unguardedCollections, localPersonId: () => "person-local", workspaceId: "w", workspaceRoot: root, capacityBytes: 1024 * 1024, compile: compileFixture });
  cleanup.push(async () => { await host.close(); await rm(root, { recursive: true, force: true }); });
  const files = new Map(Object.entries(generateDatasetSources(initial).files));
  const adapter = sourceCaptureAdapter(files);
  const first = await host.prepare({ descriptorPath: "people/dataset.json", adapter });
  const revision = await host.approve({ preparationId: first.preparationId, revisionSha256: first.revision.revisionSha256 });
  const workspace = { workspaceId: "w" };
  const signal = new AbortController().signal, scope = "window:1";
  let credentialGeneration = 1;
  let alterSources: ((paths: string[]) => void) | undefined;
  const local = remote ? { approvedArtifacts() { throw new Error("Local store is fenced"); }, prepareMigrationCandidate() { throw new Error("Local store is fenced"); }, approveMigrationCandidate() { throw new Error("Local store is fenced"); } } as unknown as LocalDatasetHost : host;
  const handler = createDatasetHandler({ flushSourceCapture: async () => ({ heldFiles: [], deferredWrites: [] }), withWorkspaceOperation: async (_caller, _id, work) => {
    let active = true;
    try { return await work({ workspace, signal, scope, assertCurrent() { if (!active) throw new Error("This workspace authority lease was released."); } }); }
    finally { active = false; }
  }, currentCredentialGeneration: () => credentialGeneration,
    hostForWorkspace: async () => local, ...(remote ? { dataForWorkspace: async () => ({ approvedArtifacts: async (datasetId: string) => host.approvedArtifacts(datasetId),
      prepareMigrationCandidate: host.prepareMigrationCandidate, approveMigrationCandidate: host.approveMigrationCandidate, discardMigrationCandidate: host.discardMigrationCandidate,
      migrationPreviewPage: host.migrationPreviewPage }) as unknown as import("./remoteDataset").OwnerDatasetData } : {}), withAdapter: async (_workspace, work) => work(adapter), createSources: async (_workspace, sources) => {
      for (const [path, source] of Object.entries(sources)) { if (files.has(path)) throw new Error("Existing source"); files.set(path, source); }
      invalidateDatasetAddresses({ workspaceId: "w" });
      alterSources?.(Object.keys(sources));
    } });
  async function prepare(change: DatasetSchemaChange, current = host.approvedArtifacts(id(1)).revision) {
    const result = await handler("owner", { action: "prepareSchemaChange", workspaceId: "w", datasetPath: "people/dataset.json", revision: current.revision, revisionSha256: current.revisionSha256, change });
    if (result.kind !== "migration-prepared") throw new Error("Expected a review"); return result;
  }
  return { host, files, adapter, revision, prepare, handler, tamper(fn: (paths: string[]) => void) { alterSources = fn; },
    changeCredentials() { credentialGeneration++; } };
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
  expect(review.revision.definition.operations.find(op => op.operationId === id(8))!.fieldIds).toEqual([id(4)]);
  const next = await approve(f, review);
  const rows = (await f.host.query(call(next.revision, id(5)))).result as { rows: Array<{ id: string; version: number; values: Record<string, unknown> }> };
  expect(rows.rows[0]!.id).toBe((added.result as { id: string }).id);
  expect(rows.rows[0]!.values).toMatchObject({ [id(4)]: "Camera", [field.fieldId]: "New" });
  await f.host.action(call(next.revision, id(7), { id: rows.rows[0]!.id, expectedVersion: 1, values: { [field.fieldId]: "Done" } }, "edit"));
  expect(f.files.get("people/operations.js")).toBe(generateDatasetSources(definition).files[definition.operationsPath]);
  await expect(f.host.query(call(f.revision, id(5)))).rejects.toThrow("The Collection's rules changed. Its owner must approve this access again.");
});

it("refuses a button from a shared view before writing any source", async () => {
  const f = await fixture();
  const written: string[] = [];
  const shareView = { shareId: "share-1", granterEmail: "owner@example.com", genericChatWritable: false,
    grantedSelector: { paths: ["people"], versionId: null, access: "edit" } };
  const recipient = createDatasetHandler({ flushSourceCapture: async () => ({ heldFiles: [], deferredWrites: [] }), hostForWorkspace: async () => f.host,
    withWorkspaceOperation: async (_caller, _id, work) => work({ workspace: { workspaceId: "w", shareView }, signal: new AbortController().signal, assertCurrent() {} }),
    withAdapter: async (_workspace, work) => work(f.adapter),
    createSources: async (_workspace, sources) => { written.push(...Object.keys(sources)); } });
  await expect(recipient("editor", { action: "prepareSchemaChange", workspaceId: "w", datasetPath: "people/dataset.json", revision: f.revision.revision,
    revisionSha256: f.revision.revisionSha256, change: { kind: "addButton", tableId: id(2), name: "Send receipt" } })).rejects.toThrow("Open the original workspace to manage this Collection.");
  expect(written).toEqual([]);
  expect(f.host.describe(id(1)).revision).toBe(1);
});

it("refuses changed capture, stale revision and missing required defaults while preserving authored rules", async () => {
  const f = await fixture();
  await expect(f.prepare({ kind: "addField", tableId: id(2), field: { name: "Required", type: "text", required: true, unique: false } })).rejects.toThrow("needs a default");
  await expect(f.prepare({ kind: "renameField", tableId: id(2), fieldId: id(4), name: "Person" }, { ...f.revision, revisionSha256: "0".repeat(64) })).rejects.toThrow("rules changed");
  const artifacts = f.host.approvedArtifacts(id(1));
  const customSource = artifacts.operationSource + "\n// custom";
  const renamed = generateDatasetSchemaChange({ ...artifacts, operationSource: customSource, change: { kind: "renameCollection", name: "Guests" } });
  expect(renamed.operationSource).toBe(customSource);
  expect(renamed.schemaSql).toBe(artifacts.schemaSql);
  const addition = generateDatasetSchemaChange({ ...artifacts, operationSource: customSource, change: { kind: "addField", tableId: id(2), field: {name:"Notes",type:"text",required:false,unique:false} } });
  expect(addition.operationSource).toBe(customSource);
  expect(addition.definition.operations).toEqual(artifacts.revision.definition.operations);
  let customRulesFailure: unknown;
  try {
    generateDatasetSchemaChange({ ...artifacts, operationSource: customSource, change: { kind: "changeField", tableId:id(2), fieldId:id(4), type:"number",required:true } });
  } catch (error) { customRulesFailure = error; }
  expect(customRulesFailure).toBeInstanceOf(DatasetSchemaChangeError);
  expect(customRulesFailure).toMatchObject({ message: expect.stringMatching(/custom rules.*people\/operations.js/), workspacePaths: ["people/operations.js"] });
  f.tamper(paths => { const migration = paths.find(path => path.endsWith("migration.sql"))!; f.files.set(migration, "DELETE FROM people;"); });
  await expect(f.prepare({ kind: "renameCollection", name: "Guests" })).rejects.toThrow("differs from this review");
  expect(f.host.describe(id(1)).revision).toBe(1);
});

it("captures remote schema changes without opening the fenced local store and binds approval to the caller", async () => {
  const f = await fixture(definition, true);
  const review = await f.prepare({ kind: "renameCollection", name: "Remote people" });
  const input = { action: "approveMigration", workspaceId: "w", preparationId: review.preparationId, revisionSha256: review.revision.revisionSha256, approvalDigest: review.approvalDigest };
  const page = { action: "migrationPreviewPage", workspaceId: "w", preparationId: review.preparationId, limit: 1 };
  await expect(f.handler("another owner session", page)).rejects.toThrow(/review expired/);
  expect(await f.handler("owner", page)).toMatchObject({ kind: "migration-preview-page", changes: [], nextCursor: null });
  await expect(f.handler("another owner session", input)).rejects.toThrow(/review expired/);
  const changed = await approve(f, review);
  expect(changed.revision.definition.name).toBe("Remote people");
  await expect(f.handler("owner", input)).rejects.toThrow(/review expired/);
});

it.each(["changeCredentials"] as const)("refuses a saved review after %s", async change => {
  const f = await fixture(definition, true);
  const review = await f.prepare({ kind: "renameCollection", name: "Remote people" });
  f[change]();
  await expect(approve(f, review)).rejects.toThrow(/review expired/);
  expect(f.host.describe(id(1)).revision).toBe(1);
});

it.each([true])("reviews public relation choices on the current authority before activating them (remote=%s)", async remote => {
  const initial = structuredClone(definition);
  initial.tables[0]!.fields.push({ fieldId: id(10), name: "Referral", sqlColumn: "referral", type: "relation", required: false, unique: false,
    relation: { datasetId: id(1), tableId: id(2), fieldId: id(3), many: false } });
  const f = await fixture(initial, remote);
  const added = await f.host.action(call(f.revision, id(6), { values: { [id(4)]: "Ada" } }, "relation-choice-record"));
  const result = await f.handler("owner", { action: "prepareRelationChoices", workspaceId: "w", datasetPath: "people/dataset.json",
    revision: f.revision.revision, revisionSha256: f.revision.revisionSha256, tableId: id(2), fieldId: id(10), labelFieldId: id(4) });
  if (result.kind !== "migration-prepared") throw Error("Expected explicit choice review");
  await expect(resolveDatasetAddress(f.adapter, "w", "people/dataset.json", new AbortController().signal)).resolves.toBe(id(1));
  const choice = result.revision.definition.operations.at(-1)!;
  expect(choice).toMatchObject({ access: "link", readOnly: true, fieldIds: [id(3), id(4)] });
  expect(f.host.approvedArtifacts(id(1)).revision.revisionSha256).toBe(f.revision.revisionSha256);
  expect(result.operationSource.startsWith(generateDatasetSources(initial).files[initial.operationsPath]!)).toBe(true);
  const next = await approve(f, result);
  const response = await f.host.query(call(next.revision, choice.operationId, { limit: 10 }, "relation-choice-read"));
  expect(response.result).toEqual({ rows: [{ id: (added.result as { id: string }).id,
    values: { [id(3)]: (added.result as { id: string }).id, [id(4)]: "Ada" } }], nextCursor: null });
  expect(next.revision.definition.operations.slice(0, f.revision.definition.operations.length)).toEqual(f.revision.definition.operations);
});
