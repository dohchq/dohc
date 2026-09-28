import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, posix } from "node:path";
import { afterEach, expect, it } from "vitest";
import { VersionedLiveAdapter } from "@dohc/workspace-engine-client";
import { datasetRevisionsPreserveAccess, type DatasetDefinition, type DatasetRevision } from "@dohc/security-contract/dataset";
import { describeDatasetRevision } from "@dohc/security-contract/dataset-artifacts";
import type { DatasetSchemaChange } from "@dohc/cli/dataset";
import { generateDatasetSources } from "./datasetGenerator";
import { generateDatasetHistoryRestore } from "./datasetHistoryRestore";
import { createLocalDatasetHost, type LocalDatasetHost } from "./localDatasetHost";
import { createDatasetHandler } from "../ipc/datasetIpc";
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
async function fixture(initial: DatasetDefinition = definition, remote = false, sourceSuffix = "") {
  const root = await mkdtemp(join(tmpdir(), "dohc-history-restore-"));
  const host = await createLocalDatasetHost({ localPersonId: () => "person-local", workspaceId: "w", workspaceRoot: root, capacityBytes: 1024 * 1024 });
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
  if (sourceSuffix) files.set(initial.operationsPath, files.get(initial.operationsPath)! + sourceSuffix);
  const first = await host.prepare({ descriptorPath: posix.join(posix.dirname(initial.schemaPath), "dataset.json"), adapter });
  const revision = await host.approve({ preparationId: first.preparationId, revisionSha256: first.revision.revisionSha256 });
  const workspace = { workspaceId: "w" };
  let signal = new AbortController().signal, scope = "window:1", credentialGeneration = 1;
  let alterSources: ((paths: string[]) => void) | undefined;
  const local = remote ? { approvedArtifacts() { throw new Error("Local store is fenced"); }, prepareMigrationCandidate() { throw new Error("Local store is fenced"); }, approveMigrationCandidate() { throw new Error("Local store is fenced"); } } as unknown as LocalDatasetHost : host;
  const handler = createDatasetHandler({ flushSourceCapture: async () => {}, withWorkspaceOperation: async (_caller, _id, work) => {
    let active = true;
    try { return await work({ workspace, signal, scope, assertCurrent() { if (!active) throw new Error("This workspace authority lease was released."); } }); }
    finally { active = false; }
  }, currentCredentialGeneration: () => credentialGeneration,
    hostForWorkspace: async () => local, ...(remote ? { dataForWorkspace: async () => ({ approvedArtifacts: async (datasetId: string) => host.approvedArtifacts(datasetId),
      prepareMigrationCandidate: host.prepareMigrationCandidate, approveMigrationCandidate: host.approveMigrationCandidate, discardMigrationCandidate: host.discardMigrationCandidate,
      migrationPreviewPage: host.migrationPreviewPage }) as unknown as import("./remoteDataset").OwnerDatasetData } : {}), withAdapter: async (_workspace, work) => work(adapter), createSources: async (_workspace, sources) => {
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


async function restore(f: Awaited<ReturnType<typeof fixture>>, target = f.revision.revisionSha256) {
  const current = f.host.approvedArtifacts(id(1));
  const result = await f.handler("owner", { action: "prepareHistoryRestore", workspaceId: "w", datasetId: id(1),
    revision: current.revision.revision, revisionSha256: current.revision.revisionSha256, targetRevisionSha256: target, changedRevisionSha256: current.revision.revisionSha256 });
  if (result.kind !== "migration-prepared") throw new Error("Expected a reversal review"); return result;
}
it("prepares a forward reversal from History, keeps newer records, and saves the source under new paths", async () => {
  const f = await fixture();
  const changed = await f.prepare({ kind: "renameField", tableId: id(2), fieldId: id(4), name: "Full name" });
  const second = await approve(f, changed);
  const registration = await f.host.action(call(second.revision, id(6), { values: { [id(4)]: "Tuesday registration" } }, "tuesday"));
  const review = await restore(f);
  expect(review.previousRevision.revision).toBe(2); expect(review.revision.revision).toBe(3);
  expect(review.revision.definition.tables[0]!.fields[1]!.name).toBe("Name");
  expect(review.migrationSql).toBe("SELECT 1;");
  expect(review.revision.definition.operationsPath).not.toBe(f.revision.definition.operationsPath);
  expect(f.files.get(review.revision.definition.operationsPath)).toBe(f.files.get(f.revision.definition.operationsPath));
  const final = await approve(f, review);
  const rows = (await f.host.query(call(final.revision, id(5)))).result as { rows: Array<{ id: string; values: Record<string, unknown> }> };
  expect(rows.rows).toMatchObject([{ id: (registration.result as { id: string }).id, values: { [id(4)]: "Tuesday registration" } }]);
  const history = await f.handler("owner", { action: "historyRevision", workspaceId: "w", datasetId: id(1), revisionSha256: f.revision.revisionSha256 });
  expect(history.kind).toBe("history-revision");
});
it("reverses an added button without SQL, then puts it back, keeping later edits, actions, and access", async () => {
  const f = await fixture();
  const created = await f.host.action(call(f.revision, id(6), { values: { [id(4)]: "Ada" } }, "before-button"));
  const recordId = (created.result as { id: string }).id;
  const added = await approve(f, await f.prepare({ kind: "addButton", tableId: id(2), name: "Send receipt" }));
  const button = added.revision.definition.tables[0]!.fields.at(-1)!;
  await f.host.action(call(added.revision, id(7), { id: recordId, expectedVersion: 1, values: { [id(4)]: "Ada Lovelace" } }, "after-button"));
  const review = await restore(f);
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
it("reverses an earlier change across a later button, and keeps the button", async () => {
  const f = await fixture();
  const renamed = await approve(f, await f.prepare({ kind: "renameField", tableId: id(2), fieldId: id(4), name: "Full name" }));
  const added = await approve(f, await f.prepare({ kind: "addButton", tableId: id(2), name: "Send receipt" }));
  const result = await f.handler("owner", { action: "prepareHistoryRestore", workspaceId: "w", datasetId: id(1), revision: added.revision.revision,
    revisionSha256: added.revision.revisionSha256, targetRevisionSha256: f.revision.revisionSha256, changedRevisionSha256: renamed.revision.revisionSha256 });
  if (result.kind !== "migration-prepared") throw new Error("Expected a reversal review");
  expect(result.migrationSql).toBe("SELECT 1;");
  expect(result.revision.definition.tables[0]!.fields.map(field => field.name)).toEqual(["ID", "Name", "Send receipt"]);
  const final = await approve(f, result);
  expect(final.revision.definition.tables[0]!.fields.at(-1)).toEqual(added.revision.definition.tables[0]!.fields.at(-1));
});
it("refuses to reverse a button that a later source migration made into a column", () => {
  const generated = generateDatasetSources(definition), schemaSql = generated.files[definition.schemaPath]!, operationSource = generated.files[definition.operationsPath]!;
  const artifact = (d: DatasetDefinition, n: number, schema = schemaSql) => ({ schemaSql: schema, operationSource, revision: describeDatasetRevision({ definition: d, revision: n, schemaSql: schema, operationSource }) });
  const withButton = structuredClone(generated.definition); withButton.tables[0]!.fields.push({ fieldId: id(20), name: "Send receipt", type: "button" });
  const column = structuredClone(generated.definition);
  column.tables[0]!.fields.push({ fieldId: id(20), name: "Receipt sent", sqlColumn: "receipt_sent", type: "checkbox", required: false, unique: false });
  const migrated = artifact(column, 3, schemaSql + "\nALTER TABLE people ADD COLUMN receipt_sent INTEGER;\n");
  // Reversing the button's addition would drop the column's descriptor and leave its SQL column.
  expect(() => generateDatasetHistoryRestore(migrated, artifact(generated.definition, 1), artifact(withButton, 2))).toThrow("Receipt sent is no longer a button.");
  // Reversing its removal would put a button over the column.
  expect(() => generateDatasetHistoryRestore(migrated, artifact(withButton, 1), artifact(generated.definition, 2))).toThrow("Receipt sent is no longer a button.");
});
it("refuses to put a button back over a later field with its name", () => {
  const generated = generateDatasetSources(definition), schemaSql = generated.files[definition.schemaPath]!, operationSource = generated.files[definition.operationsPath]!;
  const artifact = (d: DatasetDefinition, n: number) => ({ schemaSql, operationSource, revision: describeDatasetRevision({ definition: d, revision: n, schemaSql, operationSource }) });
  const withButton = structuredClone(generated.definition); withButton.tables[0]!.fields.push({ fieldId: id(20), name: "Send receipt", type: "button" });
  const renamed = structuredClone(generated.definition); renamed.tables[0]!.fields[1]!.name = "Send receipt";
  expect(() => generateDatasetHistoryRestore(artifact(renamed, 3), artifact(withButton, 1), artifact(generated.definition, 2))).toThrow("Another field in People is now named Send receipt.");
});
it("refuses a reviewed reversal after a new registration and preserves every registration", async () => {
  const f = await fixture(); const second = await approve(f, await f.prepare({ kind: "renameField", tableId: id(2), fieldId: id(4), name: "Full name" }));
  const review = await restore(f);
  await f.host.action(call(second.revision, id(6), { values: { [id(4)]: "New submission" } }, "newer"));
  await expect(approve(f, review)).rejects.toThrow("changed after review");
  expect(f.host.describe(id(1)).revision).toBe(2);
  const final = await approve(f, await restore(f));
  const rows = (await f.host.query(call(final.revision, id(5)))).result as { rows: Array<{ values: Record<string, unknown> }> };
  expect(rows.rows[0]!.values[id(4)]).toBe("New submission");
});
it.each(["people/", ""])("keeps consecutive reversal sources beside earlier revisions under %s", async prefix => {
  const f = await fixture({ ...definition, schemaPath: `${prefix}schema.sql`, operationsPath: `${prefix}operations.js` });
  let previous = f.revision;
  let current = (await approve(f, await f.prepare({ kind: "renameField", tableId: id(2), fieldId: id(4), name: "Full name" }))).revision;
  const paths = new Set<string>([f.revision.definition.schemaPath, current.definition.schemaPath]);
  for (let attempt = 0; attempt < 4; attempt++) {
    const review = await restore(f, previous.revisionSha256);
    expect(review.revision.definition.schemaPath).toMatch(new RegExp(`^${prefix}revisions/${current.revision + 1}-[^/]+/schema\\.sql$`));
    expect(paths.has(review.revision.definition.schemaPath)).toBe(false);
    paths.add(review.revision.definition.schemaPath);
    expect(review.revision.definition.datasetId).toBe(f.revision.datasetId);
    expect(review.revision.definition.operations).toEqual(f.revision.definition.operations);
    expect(review.revision.definition.tables).toEqual(previous.definition.tables);
    const result = await approve(f, review);
    previous = current; current = result.revision;
    expect((await f.host.query(call(current, id(5)))).result).toMatchObject({ rows: [] });
  }
  expect(f.files.get(f.revision.definition.schemaPath)).toBeDefined();
  for (const path of paths) expect(f.files.get(path)).toBe(f.files.get(f.revision.definition.schemaPath));
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

it("reverses only the selected change while preserving unrelated later names and refusing subsequent edits to the same name", () => {
  const generated = generateDatasetSources(definition), schemaSql = generated.files[definition.schemaPath]!, operationSource = generated.files[definition.operationsPath]!;
  const artifact = (d: DatasetDefinition, n: number, source = operationSource) => ({ schemaSql, operationSource: source, revision: describeDatasetRevision({ definition: d, revision: n, schemaSql, operationSource: source }) });
  const saved = artifact(generated.definition, 1);
  const afterDefinition = structuredClone(generated.definition); afterDefinition.tables[0]!.fields[1]!.name = "Full name";
  const changed = artifact(afterDefinition, 2);
  const laterDefinition = structuredClone(afterDefinition); laterDefinition.name = "New fundraiser title";
  const later = artifact(laterDefinition, 3, operationSource + "\n// newer rule");
  const reversed = generateDatasetHistoryRestore(later, saved, changed);
  expect(reversed.definition.tables[0]!.fields[1]!.name).toBe("Name");
  expect(reversed.definition.name).toBe("New fundraiser title");
  expect(reversed.operationSource).toBe(later.operationSource);
  laterDefinition.tables[0]!.fields[1]!.name = "Preferred name";
  expect(() => generateDatasetHistoryRestore(artifact(laterDefinition, 3), saved, changed)).toThrow("changed again");
  const ruleChange = artifact(generated.definition, 2, operationSource + "\n// selected rule");
  expect(() => generateDatasetHistoryRestore(later, saved, ruleChange)).toThrow("rules changed again");
});

it.each([false, true])("compiles TypeScript when reversing a saved change (source change: %s)", async sourceChanged => {
  const initial = structuredClone(definition); initial.operationsPath = "people/operations.ts";
  const f = await fixture(initial, false, "\nconst authored: string = 'original';");
  const first = f.host.approvedArtifacts(id(1));
  const nextDefinition = structuredClone(first.revision.definition); nextDefinition.name = "Updated name";
  const operationSource = sourceChanged ? first.operationSource.replace("'original'", "'updated'") : first.operationSource;
  const revision = describeDatasetRevision({ definition: nextDefinition, revision: 2, schemaSql: first.schemaSql, operationSource });
  const candidate = await f.host.prepareMigrationCandidate({ workspaceId: "w", revision, schemaSql: first.schemaSql, operationSource, migrationSql: "SELECT 1;", expected: first.cursor });
  await f.host.approveMigrationCandidate({ workspaceId: "w", datasetId: id(1), candidateId: candidate.candidateId, checkpointSha256: candidate.checkpointSha256 });
  const review = await restore(f);
  expect(review.revision.definition.operationsPath).toMatch(/operations\.ts$/);
  expect(review.operationSource).toBe(first.operationSource);
  const result = await approve(f, review);
  expect(result.revision.definition.name).toBe("People");
  expect((await f.host.query(call(result.revision, id(5)))).result).toMatchObject({ rows: [] });
});
