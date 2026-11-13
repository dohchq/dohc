import { mkdtemp, rm } from "node:fs/promises";
import { openedLocalState } from "../testing/preparedLocalState";
import { tmpdir } from "node:os";
import { join, posix } from "node:path";
import { afterEach, expect, it } from "vitest";
import { sourceCaptureAdapter } from "../testing/sourceCaptureAdapter";
import { datasetRevisionsPreserveAccess, type DatasetDefinition, type DatasetRevision } from "@dohc/security-contract/dataset";
import { describeDatasetRevision } from "@dohc/security-contract/dataset-artifacts";
import type { DatasetSchemaChange } from "@dohc/cli/dataset";
import { generateDatasetSources } from "./datasetGenerator";
import { generateDatasetHistoryRestore } from "./datasetHistoryRestore";
import { invalidateDatasetAddresses } from "./datasetAddress";
import { createLocalDatasetHost } from "./localDatasetHost";
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
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "dohc-history-restore-"));
  // Workers and exports live in .dohc/local, which an engine open prepares.
  await openedLocalState({ workspaceId: "w", rootPath: root });
  const host = await createLocalDatasetHost({ holder: unguardedCollections, localPersonId: () => "person-local", workspaceId: "w", workspaceRoot: root, capacityBytes: 1024 * 1024, compile: compileFixture });
  cleanup.push(async () => { await host.close(); await rm(root, { recursive: true, force: true }); });
  const files = new Map(Object.entries(generateDatasetSources(definition).files));
  const adapter = sourceCaptureAdapter(files);
  const datasetPath = posix.join(posix.dirname(definition.schemaPath), "dataset.json");
  const first = await host.prepare({ descriptorPath: datasetPath, adapter });
  const revision = await host.approve({ preparationId: first.preparationId, revisionSha256: first.revision.revisionSha256 });
  const workspace = { workspaceId: "w" };
  const signal = new AbortController().signal, scope = "window:1";
  let alterSources: ((paths: string[]) => void) | undefined;
  const handler = createDatasetHandler({ flushSourceCapture: async () => ({ heldFiles: [], deferredWrites: [] }), withWorkspaceOperation: async (_caller, _id, work) => {
    let active = true;
    try { return await work({ workspace, signal, scope, assertCurrent() { if (!active) throw new Error("This workspace authority lease was released."); } }); }
    finally { active = false; }
  }, currentCredentialGeneration: () => 1,
    hostForWorkspace: async () => host, withAdapter: async (_workspace, work) => work(adapter), createSources: async (_workspace, sources) => {
      for (const [path, source] of Object.entries(sources)) { if (files.has(path)) throw new Error("Existing source"); files.set(path, source); }
      invalidateDatasetAddresses({ workspaceId: "w" });
      alterSources?.(Object.keys(sources));
    } });
  async function prepare(change: DatasetSchemaChange, current = host.approvedArtifacts(id(1)).revision) {
    const result = await handler("owner", { action: "prepareSchemaChange", workspaceId: "w", datasetPath, revision: current.revision, revisionSha256: current.revisionSha256, change });
    if (result.kind !== "migration-prepared") throw new Error("Expected a review"); return result;
  }
  return { host, files, datasetPath, revision, prepare, handler, tamper(fn: (paths: string[]) => void) { alterSources = fn; } };
}
const call = (revision: DatasetRevision, operationId: string, input = {}, key = "read") => ({ datasetId: id(1), revision: revision.revision,
  revisionSha256: revision.revisionSha256, operationId, input, idempotencyKey: key });
const approve = async (setup: Awaited<ReturnType<typeof fixture>>, review: Awaited<ReturnType<Awaited<ReturnType<typeof fixture>>["prepare"]>>) => {
  const result = await setup.handler("owner", { action: "approveMigration", workspaceId: "w", preparationId: review.preparationId,
    revisionSha256: review.revision.revisionSha256, approvalDigest: review.approvalDigest });
  if (result.kind !== "migrated") throw new Error("Expected migration");
  return result;
};

async function restore(f: Awaited<ReturnType<typeof fixture>>, target = f.revision.revisionSha256) {
  const current = f.host.approvedArtifacts(id(1));
  const result = await f.handler("owner", { action: "prepareHistoryRestore", workspaceId: "w", datasetPath: f.datasetPath,
    revision: current.revision.revision, revisionSha256: current.revision.revisionSha256, targetRevisionSha256: target, changedRevisionSha256: current.revision.revisionSha256 });
  if (result.kind !== "migration-prepared") throw new Error("Expected a reversal review"); return result;
}
it("reverses an added button without SQL, then puts it back, keeping later edits, actions, and access", async () => {
  const f = await fixture();
  const created = await f.host.action(call(f.revision, id(6), { values: { [id(4)]: "Ada" } }, "before-button"));
  const recordId = (created.result as { id: string }).id;
  const added = await approve(f, await f.prepare({ kind: "addButton", tableId: id(2), name: "Send receipt" }));
  const button = added.revision.definition.tables[0]!.fields.at(-1)!;
  await f.host.action(call(added.revision, id(7), { id: recordId, expectedVersion: 1, values: { [id(4)]: "Ada Lovelace" } }, "after-button"));
  const review = await restore(f);
  await expect(f.handler("owner", { action: "describe", workspaceId: "w", datasetPath: f.datasetPath })).resolves.toMatchObject({ kind: "description", dataset: { revision: 2 } });
  expect(review.migrationSql).toBe("SELECT 1;");
  expect(review.revision.definition.tables).toEqual(f.revision.definition.tables);
  expect(review.revision.definition.operations).toEqual(added.revision.definition.operations);
  expect(datasetRevisionsPreserveAccess(added.revision, review.revision)).toBe(true);
  const reversed = await approve(f, review);
  const rows = (await f.host.query(call(reversed.revision, id(5)))).result as { rows: Array<{ id: string; values: Record<string, unknown> }> };
  expect(rows.rows).toMatchObject([{ id: recordId, values: { [id(4)]: "Ada Lovelace" } }]);
  // App bindings and grants pin the first approval; a call pinned to it still runs.
  expect((await f.host.query(call(f.revision, id(5)))).result).toMatchObject({ rows: [{ values: { [id(4)]: "Ada Lovelace" } }] });
  const again = await restore(f, added.revision.revisionSha256);
  expect(again.migrationSql).toBe("SELECT 1;");
  expect(again.revision.definition.tables[0]!.fields.at(-1)).toEqual(button);
  const restored = await approve(f, again);
  expect(f.host.describe(id(1)).tables[0]!.fields.at(-1)).toEqual(button);
  expect((await f.host.query(call(restored.revision, id(5)))).result).toMatchObject({ rows: [{ values: { [id(4)]: "Ada Lovelace" } }] });
});
it("refuses a reviewed reversal after a new registration and preserves every registration", async () => {
  const f = await fixture(); const second = await approve(f, await f.prepare({ kind: "renameField", tableId: id(2), fieldId: id(4), name: "Full name" }));
  const review = await restore(f);
  await expect(f.handler("owner", { action: "describe", workspaceId: "w", datasetPath: f.datasetPath })).resolves.toMatchObject({ kind: "description", dataset: { revision: 2 } });
  await f.host.action(call(second.revision, id(6), { values: { [id(4)]: "New submission" } }, "newer"));
  await expect(approve(f, review)).rejects.toThrow("changed after review");
  expect(f.host.describe(id(1)).revision).toBe(2);
  const final = await approve(f, await restore(f));
  const rows = (await f.host.query(call(final.revision, id(5)))).result as { rows: Array<{ values: Record<string, unknown> }> };
  expect(rows.rows[0]!.values[id(4)]).toBe("New submission");
});
it("rejects changed captured reversal source before approval", async () => {
  const f = await fixture(); await approve(f, await f.prepare({ kind: "renameField", tableId: id(2), fieldId: id(4), name: "Full name" }));
  f.tamper(paths => { const path = paths.find(path => path.endsWith("operations.js"))!; f.files.set(path, f.files.get(path)! + "\n// changed after selection"); });
  await expect(restore(f)).rejects.toThrow("changed while preparing this restore");
  expect(f.host.describe(id(1)).revision).toBe(2);
});
it("keeps current access when restoring older operation source and refuses structural conflicts", async () => {
  const generated = generateDatasetSources(definition);
  const schemaSql = generated.files[definition.schemaPath]!, operationSource = generated.files[definition.operationsPath]!;
  const saved = { schemaSql, operationSource, revision: describeDatasetRevision({ definition: generated.definition, revision: 1, schemaSql, operationSource }) };
  const nextDefinition = structuredClone(saved.revision.definition); nextDefinition.operations.at(-1)!.access = "owner";
  const current = { schemaSql, operationSource: operationSource + "\n// revised rule", revision: describeDatasetRevision({ definition: nextDefinition, revision: 2, schemaSql, operationSource: operationSource + "\n// revised rule" }) };
  const result = generateDatasetHistoryRestore(current, saved, current);
  expect(result.definition.operations.at(-1)!.access).toBe("owner");
  expect(result.operationSource).toBe(operationSource);
  const changed = structuredClone(nextDefinition); changed.tables[0]!.fields[1]!.type = "number";
  const incompatible = { ...current, revision: describeDatasetRevision({ definition: changed, revision: 2, schemaSql, operationSource: current.operationSource }) };
  expect(() => generateDatasetHistoryRestore(incompatible, saved, incompatible)).toThrow("Fields and names");
  const otherSchema = { ...current, schemaSql: schemaSql + "\n", revision: describeDatasetRevision({ definition: nextDefinition, revision: 2, schemaSql: schemaSql + "\n", operationSource: current.operationSource }) };
  expect(() => generateDatasetHistoryRestore(otherSchema, saved, otherSchema)).toThrow("Fields and names");
});
