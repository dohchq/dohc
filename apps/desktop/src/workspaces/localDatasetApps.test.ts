import { createHash, randomUUID } from "node:crypto";
import { openedLocalState } from "../testing/preparedLocalState";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { sourceCaptureAdapter } from "../testing/sourceCaptureAdapter";
import { describeDatasetRevision } from "@dohc/security-contract/dataset-artifacts";
import type { DatasetDefinition } from "@dohc/security-contract/dataset";
import { createLocalDatasetHost, type LocalDatasetAgent, type LocalDatasetHost } from "./localDatasetHost";
import { generateDatasetSources } from "./datasetGenerator";
import { generateDatasetFormSources } from "./datasetFormGenerator";
import { prepareLocalAppPublication } from "./ownerAppPublication";
import { compileClosedApp } from "./closedAppCompiler";
import { createLocalAppLaunchHost, type LocalAppLaunchHost } from "./localAppLaunch";
import { createDatasetFixtureCompiler } from "../testing/datasetFixtureCompiler";
import { unguardedCollections } from "../testing/collectionsHolder";
import { recordNewCollectionsHolder, type CollectionsHolderCheck } from "./collectionsHolder";

const compileFixture = createDatasetFixtureCompiler();

const hash = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const definition: DatasetDefinition = { formatVersion: 1, datasetId: id(1), name: "Registrations", schemaPath: "data/schema.sql", operationsPath: "data/operations.js",
  tables: [{ tableId: id(2), name: "Responses", sqlName: "responses", primaryKey: "id", fields: [
    { fieldId: id(3), name: "ID", sqlColumn: "id", type: "text", required: true, unique: true },
    { fieldId: id(4), name: "Name", sqlColumn: "name", type: "text", required: true, unique: false },
    { fieldId: id(5), name: "Receipt", sqlColumn: "receipt", type: "attachment", required: false, unique: false },
  ] }], operations: [
    { operationId: id(6), name: "submit", label: "Submit", tableId: id(2), kind: "create", access: "link", readOnly: false, fieldIds: [id(4), id(5)] },
    { operationId: id(7), name: "list", label: "List", tableId: id(2), kind: "read", access: "owner", readOnly: true, fieldIds: [id(3), id(4), id(5)] },
    { operationId: id(8), name: "fileRead", label: "Read receipt", tableId: id(2), kind: "read", access: "owner", readOnly: true, fieldIds: [id(5)] },
  ] };
const roots: string[] = [], hosts: LocalDatasetHost[] = [], launchers: LocalAppLaunchHost[] = [];
afterEach(async () => {
  for (const launcher of launchers.splice(0)) await launcher.close();
  for (const host of hosts.splice(0)) await host.close();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
const sourceAdapter = (files: Map<string, string>) => sourceCaptureAdapter(files);
async function fixture(agentRun?: () => LocalDatasetAgent | null, holder: CollectionsHolderCheck = unguardedCollections) {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "dohc-dataset-app-")); roots.push(workspaceRoot);
  // Workers and exports live in .dohc/local, which an engine open prepares.
  await openedLocalState({ workspaceId: "w", rootPath: workspaceRoot });
  if (holder.required()) await recordNewCollectionsHolder(workspaceRoot, "w", holder.here());
  const host = await createLocalDatasetHost({ holder, localPersonId: () => "person-local", workspaceId: "w", workspaceRoot, capacityBytes: 1024 * 1024, compile: compileFixture, ...(agentRun ? { agentRun } : {}) }); hosts.push(host);
  const generated = generateDatasetSources(definition);
  const files = new Map(Object.entries(generated.files)); files.set("data/dataset.json", JSON.stringify(definition));
  files.set(definition.operationsPath,files.get(definition.operationsPath)+`\nglobalThis.operations.fileRead=(ctx,input)=>{
    if(input.echo)return {echo:input.fileId};
    if(input.extra)return {fileId:input.fileId,extra:true};
    if(input.guess)return {fileId:input.fileId};
    return {fileId:ctx.db.query('SELECT receipt FROM responses WHERE receipt=?',[input.fileId])[0]?.receipt||null};
  };`);
  const adapter = sourceAdapter(files);
  const prepared = await host.prepare({ descriptorPath: "data/dataset.json", adapter });
  const revision = await host.approve({ preparationId: prepared.preparationId, revisionSha256: prepared.revision.revisionSha256 });
  async function prepareApp(appRoot: string, operationIds = [id(6)], fieldIds = [id(4), id(5)]) {
    const generated = generateDatasetFormSources({ datasetPath: "data/dataset.json", approvedRevision: revision, tableId: id(2), createOperationId: id(6), appRoot, fieldIds });
    for (const [path, source] of Object.entries(generated.files)) files.set(`${appRoot}/${path}`, source);
    const manifest = JSON.parse(files.get(`${appRoot}/app.publish.json`)!); manifest.dataset.operationIds = operationIds;
    if (!operationIds.includes(id(6))) delete manifest.dataset.createFields;
    files.set(`${appRoot}/app.publish.json`, JSON.stringify(manifest));
    return prepareLocalAppPublication({ workspaceId: "w", appRoot }, { deferredWrites: [], adapter, compile: compileClosedApp, signal: new AbortController().signal,
      assertCurrent() {}, async resolveDatasetRevision(binding) { return host.approvedArtifacts(binding.datasetId).revision; } });
  }
  const app = await prepareApp("app");
  const published = await host.apps.activate(app, new AbortController().signal);
  const invocation = (name = "Alex", key = "submit-one") => ({ authorityRevision: published.authorityRevision, operation: "submit", idempotencyKey: key, input: { values: { [id(4)]: name } } });
  return { host, workspaceRoot, revision, files, prepareApp, app, published, invocation };
}

// Baseline publication/binding writes leave the later root and provenance tables alone.
function approveAsOlderBuild(db: DatabaseSync, app: Awaited<ReturnType<typeof fixture>>["app"]) {
  const candidate = app.candidate, capability = candidate.capabilities[0];
  if (capability?.kind !== "dataset") throw new Error("Expected Dataset app.");
  const previous = db.prepare("SELECT * FROM local_dataset_apps WHERE app_root=?").get(candidate.appRoot);
  const publicationId = hash(JSON.stringify(["dohc-local-dataset-app-v1", "w", candidate]));
  const authorityRevision = Number(previous?.authority_revision ?? 0) + 1;
  const json = JSON.stringify(candidate), { operations: _, name: _name, ...binding } = capability;
  db.exec("BEGIN");
  try {
    if (previous) {
      if (previous.publication_id !== publicationId) db.prepare("DELETE FROM dohc_dataset_bindings WHERE app_id=?").run(previous.publication_id);
      db.prepare("DELETE FROM local_dataset_app_artifacts WHERE publication_id=?").run(previous.publication_id);
      db.prepare("DELETE FROM local_dataset_apps WHERE publication_id=?").run(previous.publication_id);
    }
    db.prepare("INSERT INTO dohc_dataset_bindings VALUES(?,?,?,?,?) ON CONFLICT(workspace_id,dataset_id,app_id) DO UPDATE SET binding_json=excluded.binding_json,token=excluded.token")
      .run("w", capability.datasetId, publicationId, JSON.stringify(binding), randomUUID());
    const bytes = Buffer.byteLength(json) + app.files.reduce((total, file) => total + file.bytes.byteLength, 0) + 512;
    db.prepare("INSERT INTO local_dataset_apps VALUES(?,?,?,?,?,?,1)").run(publicationId, candidate.appRoot, capability.datasetId, authorityRevision, json, bytes);
    for (const file of app.files) db.prepare("INSERT INTO local_dataset_app_artifacts VALUES(?,?,?)").run(publicationId, file.path, file.bytes);
    db.exec("COMMIT");
  } catch (error) { db.exec("ROLLBACK"); throw error; }
  return { publicationId, authorityRevision };
}

describe("local approved dataset apps", () => {
  it("refuses a running app's next write once another computer keeps the Collections, with nothing else asked first", async () => {
    const f = await fixture(undefined, { here: () => ({ installId: "install-here", label: "Studio" }), required: () => true });
    expect(await f.host.apps.request(f.published.publicationId, "invoke", f.invocation())).toMatchObject({ replayed: false });
    await writeFile(join(f.workspaceRoot, ".dohc", "collections.json"),
      JSON.stringify({ version: 1, workspaceId: "w", installId: "install-laptop", label: "Laptop", storeId: null }));
    await expect(f.host.apps.request(f.published.publicationId, "invoke", f.invocation("Blake", "submit-two"))).rejects.toThrow("These Collections are on Laptop.");
    await expect(f.host.apps.request(f.published.publicationId, "invoke", f.invocation())).rejects.toThrow("These Collections are on Laptop.");
  });

  it("persists approval provenance with the captured candidate without changing app authority", async () => {
    const f = await fixture();
    await f.host.apps.withdraw(f.published.publicationId, f.published.authorityRevision);
    const agent = { kind: "agent", label: "Builder", labelSource: "agent-declared" } as const;
    const publication = await f.host.apps.activate(f.app, new AbortController().signal, agent);
    const db = new DatabaseSync(join(f.workspaceRoot, ".dohc/local/datasets/state.sqlite"));
    try {
      const row = db.prepare("SELECT provenance FROM local_app_approval_provenance WHERE publication_id=?").get(publication.publicationId)!;
      expect(db.prepare("PRAGMA table_info(local_dataset_apps)").all()).toHaveLength(7);
      expect(db.prepare("PRAGMA foreign_key_list(local_app_approval_provenance)").all()).toEqual([]);
      expect(JSON.parse(String(row.provenance))).toEqual({ agent, committedCandidateDigest: hash(JSON.stringify(f.app.candidate)), sourceRevision: f.app.candidate.sourceRevision, capabilities: f.app.candidate.capabilities });
    } finally { db.close(); }
    expect(await f.host.apps.activate(f.app, new AbortController().signal, null)).toEqual(publication);
    expect(f.host.apps.list("app")).toMatchObject([{ active: true, authorityRevision: publication.authorityRevision }]);
    await f.host.close();
    const reopened = await createLocalDatasetHost({ holder: unguardedCollections, localPersonId: () => "person-local", workspaceId: "w", workspaceRoot: f.workspaceRoot }); hosts.push(reopened);
    expect(reopened.apps.list("app")).toMatchObject([{ active: true, authorityRevision: publication.authorityRevision }]);
    const inspection = new DatabaseSync(join(f.workspaceRoot, ".dohc/local/datasets/state.sqlite"));
    try {
      const stored = inspection.prepare("SELECT provenance FROM local_app_approval_provenance WHERE publication_id=?").get(publication.publicationId)!;
      expect(JSON.parse(String(stored.provenance))).toMatchObject({ agent, committedCandidateDigest: hash(JSON.stringify(f.app.candidate)) });
    } finally { inspection.close(); }
  });
  it("upgrades the baseline app tables without losing artifacts or charging root rows", async () => {
    const f = await fixture();
    await f.host.close();
    const db = new DatabaseSync(join(f.workspaceRoot, ".dohc/local/datasets/state.sqlite"));
    db.exec("PRAGMA foreign_keys=ON; DROP TABLE IF EXISTS local_app_roots; DROP TABLE IF EXISTS local_app_approval_provenance");
    expect(db.prepare("PRAGMA table_info(local_dataset_apps)").all()).toHaveLength(7);
    const before = db.prepare("SELECT path,hex(content) AS content FROM local_dataset_app_artifacts ORDER BY path").all();
    const budget = db.prepare("SELECT bytes FROM local_dataset_budget").get()!.bytes;
    expect(before.length).toBeGreaterThan(0);
    db.close();
    const reopened = await createLocalDatasetHost({ holder: unguardedCollections, localPersonId: () => "person-local", workspaceId: "w", workspaceRoot: f.workspaceRoot }); hosts.push(reopened);
    expect(reopened.apps.browserPublication(f.published.publicationId).files.length).toBe(before.length);
    const inspection = new DatabaseSync(join(f.workspaceRoot, ".dohc/local/datasets/state.sqlite"));
    try {
      expect(inspection.prepare("SELECT path,hex(content) AS content FROM local_dataset_app_artifacts ORDER BY path").all()).toEqual(before);
      expect(inspection.prepare("SELECT revision,active_kind,active_publication_id FROM local_app_roots WHERE app_root='app'").get()).toMatchObject({ revision: f.published.authorityRevision, active_kind: "dataset", active_publication_id: f.published.publicationId });
      expect(inspection.prepare("SELECT bytes FROM local_dataset_budget").get()!.bytes).toBe(budget);
    } finally { inspection.close(); }
  });

  it("counts active apps instead of exhausting approval slots after 64 withdrawals", async () => {
    const f = await fixture();
    await f.host.apps.withdraw(f.published.publicationId, f.published.authorityRevision);
    for (let n = 0; n < 66; n++) {
      const publication = await f.host.apps.activate(await f.prepareApp('cycle-' + n), new AbortController().signal);
      await f.host.apps.withdraw(publication.publicationId, publication.authorityRevision);
      expect(f.host.apps.list('cycle-' + n)).toMatchObject([{ active: false }]);
    }
  }, 90_000);

  it("keeps Dataset A's first session refused after A to replacement to identical A", async () => {
    const f = await fixture();
    const replacement = structuredClone(f.app);
    replacement.candidate.sourceRevision = hash("replacement");
    const second = await f.host.apps.activate(replacement, new AbortController().signal);
    const third = await f.host.apps.activate(f.app, new AbortController().signal);
    expect(third.publicationId).toBe(f.published.publicationId);
    expect(third.authorityRevision).toBeGreaterThan(second.authorityRevision);
    const db = new DatabaseSync(join(f.workspaceRoot, ".dohc/local/datasets/state.sqlite"));
    try { expect(db.prepare("SELECT publication_id FROM local_app_approval_provenance").all()).toEqual([{ publication_id: third.publicationId }]); }
    finally { db.close(); }
    expect(() => f.host.apps.assertBrowserPublication(f.published.publicationId, f.published.authorityRevision)).toThrow(/approval changed/);
    expect(() => f.host.apps.assertBrowserPublication(third.publicationId, third.authorityRevision)).not.toThrow();
  });

  it("reconciles an older build's withdrawal and preserves the next revision", async () => {
    const f = await fixture(); await f.host.close();
    const db = new DatabaseSync(join(f.workspaceRoot, ".dohc/local/datasets/state.sqlite"));
    db.prepare("UPDATE local_dataset_apps SET active=0,authority_revision=authority_revision+1 WHERE publication_id=?").run(f.published.publicationId);
    db.close();
    const reopened = await createLocalDatasetHost({ holder: unguardedCollections, localPersonId: () => "person-local", workspaceId: "w", workspaceRoot: f.workspaceRoot }); hosts.push(reopened);
    expect(() => reopened.apps.assertBrowserPublication(f.published.publicationId, f.published.authorityRevision)).toThrow(/approval changed/);
    expect(reopened.apps.list("app")).toMatchObject([{ active: false, authorityRevision: 2 }]);
    const inspection = new DatabaseSync(join(f.workspaceRoot, ".dohc/local/datasets/state.sqlite"));
    try { expect(inspection.prepare("SELECT * FROM local_app_roots WHERE app_root='app'").get()).toMatchObject({ revision: 2, active_kind: null, active_publication_id: null }); }
    finally { inspection.close(); }
    expect(await reopened.apps.activate(f.app, new AbortController().signal)).toMatchObject({ authorityRevision: 3 });
  });

  it("clears an older build's deleted app from the active limit on reopen", async () => {
    const f = await fixture(); await f.host.close();
    const db = new DatabaseSync(join(f.workspaceRoot, ".dohc/local/datasets/state.sqlite"));
    db.exec("PRAGMA foreign_keys=ON");
    db.prepare("DELETE FROM local_dataset_apps WHERE dataset_id=?").run(id(1));
    expect(db.prepare("SELECT count(*) AS n FROM local_dataset_app_artifacts").get()!.n).toBe(0);
    db.close();
    const reopened = await createLocalDatasetHost({ holder: unguardedCollections, localPersonId: () => "person-local", workspaceId: "w", workspaceRoot: f.workspaceRoot }); hosts.push(reopened);
    expect(reopened.apps.list("app")).toEqual([]);
    const inspection = new DatabaseSync(join(f.workspaceRoot, ".dohc/local/datasets/state.sqlite"));
    try {
      expect(inspection.prepare("SELECT * FROM local_app_roots WHERE app_root='app'").get()).toMatchObject({ revision: 2, active_kind: null, active_publication_id: null });
      expect(inspection.prepare("SELECT count(*) AS n FROM local_app_roots WHERE active_publication_id IS NOT NULL").get()!.n).toBe(0);
      expect(inspection.prepare("SELECT count(*) AS n FROM local_app_approval_provenance").get()!.n).toBe(0);
    } finally { inspection.close(); }
    const next = await reopened.apps.activate(f.app, new AbortController().signal);
    expect(next.authorityRevision).toBeGreaterThan(f.published.authorityRevision);
    expect(() => reopened.apps.assertBrowserPublication(next.publicationId, f.published.authorityRevision)).toThrow(/approval changed/);
  });

  it("adopts a baseline-shaped approval below the saved root revision without reviving old sessions", async () => {
    const f = await fixture();
    await f.host.apps.withdraw(f.published.publicationId, f.published.authorityRevision);
    const prior = await f.host.apps.activate(f.app, new AbortController().signal);
    await f.host.close();
    const db = new DatabaseSync(join(f.workspaceRoot, ".dohc/local/datasets/state.sqlite"));
    db.exec("PRAGMA foreign_keys=ON");
    const old = db.prepare("SELECT * FROM local_dataset_apps WHERE publication_id=?").get(f.published.publicationId)!;
    try {
      db.prepare("DELETE FROM local_dataset_apps WHERE dataset_id=?").run(id(1));
      db.prepare("INSERT INTO local_dataset_apps VALUES(?,?,?,?,?,?,1)").run(old.publication_id, old.app_root, old.dataset_id, 1, old.candidate, old.storage_bytes);
      for (const file of f.app.files) db.prepare("INSERT INTO local_dataset_app_artifacts VALUES(?,?,?)").run(f.published.publicationId, file.path, file.bytes);
    } finally { db.close(); }
    const reopened = await createLocalDatasetHost({ holder: unguardedCollections, localPersonId: () => "person-local", workspaceId: "w", workspaceRoot: f.workspaceRoot }); hosts.push(reopened);
    const [adopted] = reopened.apps.list("app");
    expect(adopted.active).toBe(true);
    expect(adopted.authorityRevision).toBeGreaterThan(prior.authorityRevision);
    expect(() => reopened.apps.assertBrowserPublication(f.published.publicationId, f.published.authorityRevision)).toThrow(/approval changed/);
    expect(() => reopened.apps.assertBrowserPublication(prior.publicationId, prior.authorityRevision)).toThrow(/approval changed/);
    expect(await reopened.apps.activate(f.app, new AbortController().signal)).toEqual({ publicationId: adopted.publicationId, authorityRevision: adopted.authorityRevision });
    expect(await reopened.apps.request(adopted.publicationId, "invoke", { ...f.invocation(), authorityRevision: adopted.authorityRevision })).toMatchObject({ replayed: false });
    await reopened.close();
    const again = await createLocalDatasetHost({ holder: unguardedCollections, localPersonId: () => "person-local", workspaceId: "w", workspaceRoot: f.workspaceRoot }); hosts.push(again);
    expect(again.apps.list("app")).toMatchObject([{ active: true, authorityRevision: adopted.authorityRevision }]);
    const inspection = new DatabaseSync(join(f.workspaceRoot, ".dohc/local/datasets/state.sqlite"));
    try {
      expect(inspection.prepare("SELECT revision FROM local_app_roots WHERE app_root='app'").get()!.revision).toBe(adopted.authorityRevision);
      expect(inspection.prepare("SELECT * FROM local_app_approval_provenance WHERE publication_id=?").get(adopted.publicationId)).toBeUndefined();
    }
    finally { inspection.close(); }
  });

  it("discards stale provenance after an older build withdraws and reapproves the same app", async () => {
    const f = await fixture(); await f.host.close();
    const db = new DatabaseSync(join(f.workspaceRoot, ".dohc/local/datasets/state.sqlite"));
    let oldApproval;
    try {
      expect(db.prepare("SELECT provenance FROM local_app_approval_provenance WHERE publication_id=?").get(f.published.publicationId)).toBeDefined();
      db.prepare("UPDATE local_dataset_apps SET active=0,authority_revision=authority_revision+1 WHERE publication_id=?").run(f.published.publicationId);
      db.prepare("DELETE FROM dohc_dataset_bindings WHERE app_id=?").run(f.published.publicationId);
      oldApproval = approveAsOlderBuild(db, f.app);
      expect(oldApproval).toEqual({ publicationId: f.published.publicationId, authorityRevision: 3 });
    } finally { db.close(); }
    const reopened = await createLocalDatasetHost({ holder: unguardedCollections, localPersonId: () => "person-local", workspaceId: "w", workspaceRoot: f.workspaceRoot }); hosts.push(reopened);
    const [adopted] = reopened.apps.list("app");
    expect(adopted).toMatchObject({ active: true, publicationId: oldApproval.publicationId });
    expect(adopted.authorityRevision).toBeGreaterThan(oldApproval.authorityRevision);
    expect(() => reopened.apps.assertBrowserPublication(adopted.publicationId, f.published.authorityRevision)).toThrow(/approval changed/);
    expect(() => reopened.apps.assertBrowserPublication(adopted.publicationId, oldApproval.authorityRevision)).toThrow(/approval changed/);
    expect(await reopened.apps.request(adopted.publicationId, "invoke", { ...f.invocation(), authorityRevision: adopted.authorityRevision })).toMatchObject({ replayed: false });
    const inspection = new DatabaseSync(join(f.workspaceRoot, ".dohc/local/datasets/state.sqlite"));
    try { expect(inspection.prepare("SELECT * FROM local_app_approval_provenance WHERE publication_id=?").get(adopted.publicationId)).toBeUndefined(); }
    finally { inspection.close(); }
  });

  it("adopts an older build's replacement on the same root without a Dataset deletion", async () => {
    const f = await fixture(), replacement = structuredClone(f.app);
    replacement.candidate.sourceRevision = hash("older-build-replacement");
    await f.host.close();
    const db = new DatabaseSync(join(f.workspaceRoot, ".dohc/local/datasets/state.sqlite"));
    let oldApproval;
    try {
      oldApproval = approveAsOlderBuild(db, replacement);
      expect(oldApproval.publicationId).not.toBe(f.published.publicationId);
      expect(oldApproval.authorityRevision).toBe(2);
      expect(db.prepare("SELECT active_publication_id FROM local_app_roots WHERE app_root='app'").get()!.active_publication_id).toBe(f.published.publicationId);
    } finally { db.close(); }
    const reopened = await createLocalDatasetHost({ holder: unguardedCollections, localPersonId: () => "person-local", workspaceId: "w", workspaceRoot: f.workspaceRoot }); hosts.push(reopened);
    const [adopted] = reopened.apps.list("app");
    expect(adopted).toMatchObject({ active: true, publicationId: oldApproval.publicationId });
    expect(adopted.authorityRevision).toBeGreaterThan(oldApproval.authorityRevision);
    expect(() => reopened.apps.assertBrowserPublication(f.published.publicationId, f.published.authorityRevision)).toThrow(/approval changed/);
    expect(await reopened.apps.request(adopted.publicationId, "invoke", { ...f.invocation(), authorityRevision: adopted.authorityRevision })).toMatchObject({ replayed: false });
    expect(reopened.describe(id(1)).name).toBe("Registrations");
  });

  it("adopts an older build's new approval on a root cleared at a higher revision", async () => {
    const f = await fixture();
    const withdrawn = await f.host.apps.withdraw(f.published.publicationId, f.published.authorityRevision);
    await f.host.close();
    const db = new DatabaseSync(join(f.workspaceRoot, ".dohc/local/datasets/state.sqlite"));
    let oldApproval;
    try {
      db.exec("PRAGMA foreign_keys=ON");
      db.prepare("DELETE FROM local_dataset_apps WHERE dataset_id=?").run(id(1));
      oldApproval = approveAsOlderBuild(db, f.app);
      expect(oldApproval.authorityRevision).toBe(1);
      expect(db.prepare("SELECT * FROM local_app_roots WHERE app_root='app'").get()).toMatchObject({ revision: withdrawn.authorityRevision, active_kind: null, active_publication_id: null });
    } finally { db.close(); }
    const reopened = await createLocalDatasetHost({ holder: unguardedCollections, localPersonId: () => "person-local", workspaceId: "w", workspaceRoot: f.workspaceRoot }); hosts.push(reopened);
    const [adopted] = reopened.apps.list("app");
    expect(adopted).toMatchObject({ active: true, publicationId: oldApproval.publicationId });
    expect(adopted.authorityRevision).toBeGreaterThan(withdrawn.authorityRevision);
    expect(() => reopened.apps.assertBrowserPublication(adopted.publicationId, oldApproval.authorityRevision)).toThrow(/approval changed/);
    expect(await reopened.apps.request(adopted.publicationId, "invoke", { ...f.invocation(), authorityRevision: adopted.authorityRevision })).toMatchObject({ replayed: false });
  });

  it("withdraws an approval whose Dataset was archived, releasing the active slot it still holds", async () => {
    const f = await fixture(), path = join(f.workspaceRoot, ".dohc/local/datasets/state.sqlite");
    f.host.archive({ datasetId: id(1) });
    expect(f.host.apps.list("app")).toMatchObject([{ publicationId: f.published.publicationId, approved: true, active: false }]);
    await expect(f.host.apps.request(f.published.publicationId, "invoke", f.invocation())).rejects.toThrow(/unavailable/);
    const filler = new DatabaseSync(path);
    try { for (let n = 0; n < 63; n++) filler.prepare("INSERT INTO local_app_roots VALUES(?,1,'dataset',?)").run(`filler-${n}`, `filler-${n}`); } finally { filler.close(); }
    // The archived app still holds one of the 64 active slots.
    f.host.restore({ datasetId: id(1) });
    const next = await f.prepareApp("next");
    await expect(f.host.apps.activate(next, new AbortController().signal)).rejects.toThrow(/Remove an app/);
    f.host.archive({ datasetId: id(1) });
    const withdrawn = await f.host.apps.withdraw(f.published.publicationId, f.published.authorityRevision);
    expect(withdrawn).toEqual({ kind: "withdrawn", publicationId: f.published.publicationId, authorityRevision: f.published.authorityRevision + 1 });
    expect(f.host.apps.list("app")).toMatchObject([{ approved: false, active: false }]);
    expect(await f.host.apps.withdraw(f.published.publicationId, withdrawn.authorityRevision)).toEqual(withdrawn);
    const db = new DatabaseSync(path);
    try {
      expect(db.prepare("SELECT count(*) AS n FROM dohc_dataset_bindings WHERE app_id=?").get(f.published.publicationId)!.n).toBe(0);
      expect(db.prepare("SELECT count(*) AS n FROM local_app_roots WHERE active_publication_id IS NOT NULL").get()!.n).toBe(63);
    } finally { db.close(); }
    f.host.restore({ datasetId: id(1) });
    expect(await f.host.apps.activate(next, new AbortController().signal)).toMatchObject({ authorityRevision: 1 });
  });

  it("releases an archived Dataset's app approval when the Dataset is deleted", async () => {
    const f = await fixture();
    f.host.archive({ datasetId: id(1) });
    const preview = f.host.deletePreview({ datasetId: id(1) });
    await f.host.deleteDataset({ datasetId: id(1), expected: preview.cursor, reviewToken: preview.reviewToken, acknowledge: true });
    expect(f.host.apps.list("app")).toEqual([]);
    const db = new DatabaseSync(join(f.workspaceRoot, ".dohc/local/datasets/state.sqlite"));
    try { expect(db.prepare("SELECT revision,active_kind FROM local_app_roots WHERE app_root='app'").get()).toEqual({ revision: f.published.authorityRevision + 1, active_kind: null }); }
    finally { db.close(); }
  });

  it("opens and deletes a Dataset even when a stored app candidate no longer parses", async () => {
    const f = await fixture(); await f.host.close();
    const db = new DatabaseSync(join(f.workspaceRoot, ".dohc/local/datasets/state.sqlite"));
    db.prepare("UPDATE local_dataset_apps SET candidate='{}' WHERE publication_id=?").run(f.published.publicationId);
    db.close();
    const reopened = await createLocalDatasetHost({ holder: unguardedCollections, localPersonId: () => "person-local", workspaceId: "w", workspaceRoot: f.workspaceRoot }); hosts.push(reopened);
    expect(reopened.describe(id(1)).name).toBe("Registrations");
    const preview = reopened.deletePreview({ datasetId: id(1) });
    await reopened.deleteDataset({ datasetId: id(1), expected: preview.cursor, reviewToken: preview.reviewToken, acknowledge: true });
    const inspection = new DatabaseSync(join(f.workspaceRoot, ".dohc/local/datasets/state.sqlite"));
    try {
      for (const table of ["local_dataset_apps", "local_dataset_app_artifacts", "local_app_approval_provenance"])
        expect(inspection.prepare('SELECT count(*) AS n FROM ' + table).get()!.n).toBe(0);
      expect(inspection.prepare("SELECT * FROM local_app_roots WHERE app_root='app'").get()).toMatchObject({ revision: 2, active_kind: null, active_publication_id: null });
    } finally { inspection.close(); }
  });

  it("keeps one exact pending form submission across tabs and restart within its app authority", async () => {
    const f = await fixture(), invocation = f.invocation();
    const other = await f.host.apps.activate(await f.prepareApp("other"), new AbortController().signal);
    const envelope = { authorityRevision: invocation.authorityRevision, operation: invocation.operation };
    const first = await f.host.apps.request(f.published.publicationId, "attempt", { ...envelope, action: "save", idempotencyKey: invocation.idempotencyKey, input: invocation.input }) as { attempt: { token: string; input: unknown } };
    expect(first.attempt.input).toEqual(invocation.input);
    expect(await f.host.apps.request(f.published.publicationId, "attempt", { ...envelope, action: "save", idempotencyKey: "second-tab", input: { values: { [id(4)]: "Other" } } })).toEqual(first);
    await expect(f.host.apps.request(f.published.publicationId, "attempt", { ...envelope, action: "clear", token: "A".repeat(43) })).rejects.toThrow(/Another submission/);
    await expect(f.host.apps.activate(await f.prepareApp("replacement"), new AbortController().signal)).rejects.toThrow(/response is pending/);
    expect(await f.host.apps.request(other.publicationId, "attempt", { authorityRevision: other.authorityRevision, operation: "submit", action: "get" })).toEqual({ attempt: null });
    await f.host.close();
    const restarted = await createLocalDatasetHost({ holder: unguardedCollections, localPersonId: () => "person-local", workspaceId: "w", workspaceRoot: f.workspaceRoot }); hosts.push(restarted);
    expect(await restarted.apps.request(f.published.publicationId, "attempt", { ...envelope, action: "get" })).toEqual(first);
    expect(await restarted.apps.request(f.published.publicationId, "attempt", { ...envelope, action: "clear", token: first.attempt.token })).toEqual({ attempt: null });
    await expect(restarted.apps.request(f.published.publicationId, "attempt", { ...envelope, operation: "list", action: "get" })).rejects.toThrow(/not approved/);
    await restarted.apps.withdraw(f.published.publicationId, f.published.authorityRevision);
    await expect(restarted.apps.request(f.published.publicationId, "attempt", { ...envelope, action: "get" })).rejects.toThrow(/approval changed/);
  });
  it("refuses an uncommitted submission before fencing local writes and allows transfer after confirmation", async () => {
    const f = await fixture(), invocation = f.invocation(), envelope = {authorityRevision: invocation.authorityRevision, operation: invocation.operation};
    await f.host.apps.request(f.published.publicationId, "attempt", {...envelope, action: "save", idempotencyKey: invocation.idempotencyKey, input: invocation.input});
    let imported = false;
    const target = {async importRecovery() {imported = true; throw Error("Target is offline.");}};
    await expect(f.host.transferToShared({datasetId: id(1), targetOrigin: "https://relay.example", target})).rejects.toThrow(/submission is unconfirmed/);
    expect(imported).toBe(false); expect(f.host.transferStatus(id(1))).toBeNull();
    expect(await f.host.apps.request(f.published.publicationId, "invoke", invocation)).toMatchObject({replayed: false});
    await expect(f.host.transferToShared({datasetId: id(1), targetOrigin: "https://relay.example", target})).rejects.toThrow("Target is offline.");
    expect(imported).toBe(true); expect(f.host.transferStatus(id(1))?.state).toBe("ready");
  });
  it("runs a generated form through real loopback transport into its existing Collection", async () => {
    const f = await fixture(), lifetime = new AbortController();
    const launcher = await createLocalAppLaunchHost({ backend: f.host.apps, lifetime: lifetime.signal }); launchers.push(launcher);
    const url = new URL(await launcher.launch(f.published.publicationId, lifetime.signal));
    const post = (path: string, body: unknown, proof?: string) => fetch(url.origin + path, { method: "POST", headers: { origin: url.origin, "content-type": "application/json", ...(proof ? { "x-dohc-app-proof": proof } : {}) }, body: JSON.stringify(body) });
    const session = await (await post("/session", { handoff: url.hash.slice(1) })).json() as { html: string; proof: string };
    expect(session.html).not.toMatch(/CREATE TABLE|globalThis.operations|data\/schema/);
    const { authorityRevision: _, ...invoke } = f.invocation();
    const response = await post("/backend", { id: "one", op: "backend.invoke", ...invoke }, session.proof);
    expect(response.status).toBe(200); expect(await response.json()).toMatchObject({ result: { id: expect.any(String) }, replayed: false });
    const data = await f.host.query({ datasetId: id(1), revision: 1, revisionSha256: f.revision.revisionSha256, operationId: id(7), input: {}, idempotencyKey: "owner-read" });
    expect(data.result).toMatchObject({ rows: [{ values: { [id(4)]: "Alex" } }] });
    const forbidden = await post("/backend", { id: "two", op: "backend.invoke", operation: "list", input: {}, idempotencyKey: "read" }, session.proof);
    expect(forbidden.status).toBe(404);
  });

  it("preserves approved apps and retry results across restart without widening grants", async () => {
    const f = await fixture();
    const first = await f.host.apps.request(f.published.publicationId, "invoke", f.invocation());
    await f.host.close();
    const restarted = await createLocalDatasetHost({ holder: unguardedCollections, localPersonId: () => "person-local", workspaceId: "w", workspaceRoot: f.workspaceRoot }); hosts.push(restarted);
    expect(restarted.apps.list("app")).toMatchObject([{ active: true, datasetCapability: { operationIds: [id(6)] } }]);
    expect(await restarted.apps.request(f.published.publicationId, "invoke", f.invocation())).toEqual({ ...first as object, replayed: true });
    await expect(restarted.apps.request(f.published.publicationId, "invoke", { ...f.invocation(), operation: "list" })).rejects.toThrow(/not approved/);
  });

  it("revokes a publication independently of its Collection and permits a reviewed reactivation", async () => {
    const f = await fixture(); await f.host.apps.withdraw(f.published.publicationId, f.published.authorityRevision);
    expect(() => f.host.apps.browserPublication(f.published.publicationId)).toThrow();
    expect(f.host.describe(id(1)).name).toBe("Registrations");
    const next = await f.host.apps.activate(f.app, new AbortController().signal);
    expect(next.authorityRevision).toBeGreaterThan(f.published.authorityRevision);
    await expect(f.host.apps.request(next.publicationId, "invoke", f.invocation())).rejects.toThrow();
    expect(await f.host.apps.request(next.publicationId, "invoke", { ...f.invocation(), authorityRevision: next.authorityRevision })).toMatchObject({ replayed: false });
  });

  it("publishes a second app over the same records and requires an approved read result for files", async () => {
    const f = await fixture();
    const uploaded = await f.host.apps.request(f.published.publicationId, "upload", { authorityRevision: f.published.authorityRevision, idempotencyKey: "receipt", name: "receipt.pdf", contentType: "application/pdf", bytesBase64: "JVBERi0=" }) as { file: { fileId: string } };
    const invoke = f.invocation(); invoke.input.values[id(5)] = uploaded.file.fileId;
    await f.host.apps.request(f.published.publicationId, "invoke", invoke);
    await expect(f.host.apps.readBrowserFile(f.published.publicationId, { authorityRevision: 1, fileId: uploaded.file.fileId, operation: "list", input: {} })).rejects.toThrow(/approved read/);
    const admin = await f.host.apps.activate(await f.prepareApp("admin", [id(7),id(8)]), new AbortController().signal);
    await expect(f.host.apps.readBrowserFile(admin.publicationId, { authorityRevision: admin.authorityRevision, fileId: uploaded.file.fileId, operation: "list", input: {} })).rejects.toThrow(/does not grant/);
    const request={authorityRevision:admin.authorityRevision,fileId:uploaded.file.fileId,operation:"fileRead",input:{fileId:uploaded.file.fileId}};
    expect(await f.host.apps.readBrowserFile(admin.publicationId,request)).toMatchObject({bytesBase64:"JVBERi0="});
    await expect(f.host.apps.readBrowserFile(admin.publicationId,{...request,input:{...request.input,echo:true}})).rejects.toThrow(/does not grant/);
    await expect(f.host.apps.readBrowserFile(admin.publicationId,{...request,input:{...request.input,extra:true}})).rejects.toThrow(/does not grant/);
    const pending=await f.host.upload({datasetId:id(1),revision:1,revisionSha256:f.revision.revisionSha256,idempotencyKey:"owner-pending",name:"receipt.pdf",contentType:"application/pdf",bytesBase64:"JVBERi0="});
    await expect(f.host.apps.readBrowserFile(admin.publicationId,{...request,fileId:pending.file.fileId,input:{fileId:pending.file.fileId,guess:true}})).rejects.toThrow(/unavailable/);
    await expect(f.host.apps.request(admin.publicationId, "upload", { authorityRevision: admin.authorityRevision, idempotencyKey: "other", name: "receipt.pdf", contentType: "application/pdf", bytesBase64: "JVBERi0=" })).rejects.toThrow(/cannot upload/);
    const disclosure=f.host.apps.readBrowserFile(admin.publicationId,request);
    await f.host.apps.withdraw(admin.publicationId,admin.authorityRevision);
    await expect(disclosure).rejects.toThrow();
  });

  it("rejects altered capabilities and bundle bytes before replacing a working app", async () => {
    const f = await fixture();
    const forged = structuredClone(f.app); const cap = forged.candidate.capabilities[0]; if (cap?.kind !== "dataset") throw Error(); cap.operations[0]!.readOnly = true;
    await expect(f.host.apps.activate(forged, new AbortController().signal)).rejects.toThrow();
    const broken = structuredClone(f.app); broken.files[0]!.bytes[0] ^= 1;
    await expect(f.host.apps.activate(broken, new AbortController().signal)).rejects.toThrow(/bundle files changed/);
    expect(f.host.apps.browserPublication(f.published.publicationId).authorityRevision).toBe(f.published.authorityRevision);
  });

  it("refuses a queued operation when app approval ends before its commit", async () => {
    const f = await fixture();
    const pending = f.host.apps.request(f.published.publicationId, "invoke", f.invocation());
    await f.host.apps.withdraw(f.published.publicationId, f.published.authorityRevision);
    await expect(pending).rejects.toThrow();
    const rows = await f.host.query({ datasetId: id(1), revision: 1, revisionSha256: f.revision.revisionSha256, operationId: id(7), input: {}, idempotencyKey: "after-revoke" });
    expect(rows.result).toMatchObject({ rows: [] });
  });

  it("does not let another app attach a staged upload even when it knows its ID", async () => {
    const f = await fixture();
    const upload = { authorityRevision: f.published.authorityRevision, idempotencyKey: "same-key", name: "receipt.pdf", contentType: "application/pdf", bytesBase64: "JVBERi0=" };
    const first = await f.host.apps.request(f.published.publicationId, "upload", upload) as { file: { fileId: string } };
    const other = await f.host.apps.activate(await f.prepareApp("other"), new AbortController().signal);
    const own = await f.host.apps.request(other.publicationId, "upload", { ...upload, authorityRevision: other.authorityRevision }) as { file: { fileId: string } };
    expect(own.file.fileId).not.toBe(first.file.fileId);
    const input = f.invocation(); input.authorityRevision = other.authorityRevision; input.input.values[id(5)] = first.file.fileId;
    await expect(f.host.apps.request(other.publicationId, "invoke", input)).rejects.toThrow();
    const attach=f.invocation("First app","attach-first");attach.input.values[id(5)]=first.file.fileId;
    await f.host.apps.request(f.published.publicationId,"invoke",attach);
    await expect(f.host.apps.request(other.publicationId,"invoke",{...input,idempotencyKey:"steal-attached"})).rejects.toThrow();
    const native={datasetId:id(1),revision:1,revisionSha256:f.revision.revisionSha256};
    const ownerUpload=await f.host.upload({...native,idempotencyKey:"owner-file",name:"receipt.pdf",contentType:"application/pdf",bytesBase64:"JVBERi0="});
    await f.host.action({...native,operationId:id(6),idempotencyKey:"owner-attach",input:{values:{[id(4)]:"Owner",[id(5)]:ownerUpload.file.fileId}}});
    input.input.values[id(5)]=ownerUpload.file.fileId;
    await expect(f.host.apps.request(other.publicationId,"invoke",{...input,idempotencyKey:"steal-owner-attached"})).rejects.toThrow();
    expect(await f.host.action({...native,operationId:id(6),idempotencyKey:"owner-reuse-app",input:{values:{[id(4)]:"Owner reuse",[id(5)]:first.file.fileId}}})).toMatchObject({replayed:false});
  });

  it("enforces the generated form's field subset even when a client forges the request", async () => {
    const f = await fixture();
    const restricted = await f.host.apps.activate(await f.prepareApp("restricted", [id(6)], [id(4)]), new AbortController().signal);
    const input = f.invocation(); input.authorityRevision = restricted.authorityRevision; input.input.values[id(5)] = "not-allowed";
    await expect(f.host.apps.request(restricted.publicationId, "invoke", input)).rejects.toThrow(/cannot submit those fields/);
    delete input.input.values[id(5)];
    expect(await f.host.apps.request(restricted.publicationId, "invoke", input)).toMatchObject({ replayed: false });
  });
});


it("keeps local form uploads, submissions and selected fields working through rename and restart", async () => {
  const f = await fixture();
  const restricted=await f.host.apps.activate(await f.prepareApp("restricted",[id(6)],[id(4)]),new AbortController().signal);
  const admin=await f.host.apps.activate(await f.prepareApp("admin",[id(7),id(8)]),new AbortController().signal);
  const original=f.host.approvedArtifacts(id(1)), renamed=structuredClone(original.revision.definition);
  renamed.tables[0].fields[1].name="Full name";
  const revision=describeDatasetRevision({definition:renamed,revision:2,schemaSql:original.schemaSql,operationSource:original.operationSource});
  const preview=await f.host.prepareMigrationCandidate({workspaceId:"w",revision,schemaSql:original.schemaSql,operationSource:original.operationSource,expected:original.cursor,migrationSql:"SELECT 1;"});
  await f.host.approveMigrationCandidate({workspaceId:"w",datasetId:id(1),candidateId:preview.candidateId,checkpointSha256:preview.checkpointSha256});
  expect(f.host.apps.list("app")).toMatchObject([{active:true,datasetCapability:{revision:1}}]);
  const uploaded=await f.host.apps.request(f.published.publicationId,"upload",{authorityRevision:1,idempotencyKey:"renamed-receipt",name:"receipt.pdf",contentType:"application/pdf",bytesBase64:"JVBERi0="}) as {file:{fileId:string}};
  const invoke=f.invocation(); invoke.input.values[id(5)]=uploaded.file.fileId;
  const first=await f.host.apps.request(f.published.publicationId,"invoke",invoke);
  await f.host.close();
  const restarted=await createLocalDatasetHost({holder:unguardedCollections,localPersonId:()=>"person-local",workspaceId:"w",workspaceRoot:f.workspaceRoot}); hosts.push(restarted);
  expect(restarted.apps.browserPublication(f.published.publicationId)).toBeDefined();
  expect(await restarted.apps.request(f.published.publicationId,"invoke",invoke)).toEqual({...first as object,replayed:true});
  await expect(restarted.apps.request(restricted.publicationId,"invoke",{...invoke,authorityRevision:restricted.authorityRevision})).rejects.toThrow("cannot submit those fields");
  expect(await restarted.apps.readBrowserFile(admin.publicationId,{authorityRevision:admin.authorityRevision,fileId:uploaded.file.fileId,operation:"fileRead",input:{fileId:uploaded.file.fileId}})).toMatchObject({bytesBase64:"JVBERi0="});
  expect(await restarted.apps.request(f.published.publicationId,"invoke",f.invocation("Next","after-restart"))).toMatchObject({replayed:false});
  await restarted.apps.withdraw(f.published.publicationId,1);
  await expect(restarted.apps.request(f.published.publicationId,"invoke",invoke)).rejects.toThrow("approval changed");
});

describe("local app write attribution", () => {
  const watcher = "collection:registrations#tally";
  async function attributed() {
    let run: LocalDatasetAgent | null = null;
    const f = await fixture(() => run);
    f.host.automations.subscribe(id(1), { automationId: watcher, tableId: id(2), kinds: ["added"], fieldIds: null, definitionHash: hash(watcher) });
    const invoke = (key: string) => f.host.apps.request(f.published.publicationId, "invoke", f.invocation(key, key));
    return { ...f, invoke, setRun(value: LocalDatasetAgent | null) { run = value; } };
  }

  it("names the app, and the agent at its run's depth while a run is active", async () => {
    const f = await attributed(), appId = f.published.publicationId;
    expect(await f.invoke("no-run")).toMatchObject({ replayed: false });
    // A local app's commit is made for this computer's person, never the owner key.
    expect(f.host.automations.next()).toMatchObject({ depth: 0, actor: { kind: "owner", appId, userId: "person-local" } });
    for (const depth of [0, 1, 3]) {
      f.setRun({ depth });
      expect(await f.invoke(`depth-${depth}`)).toMatchObject({ replayed: false });
      expect(f.host.automations.next()).toMatchObject({ automationId: watcher, depth, actor: { kind: "agent", depth, appId } });
    }
    // At the cap the write commits, and the automation it would start stops before it runs.
    f.setRun({ depth: 4 });
    expect(await f.invoke("depth-4")).toMatchObject({ replayed: false });
    expect(f.host.automations.next()).toBeNull();
    expect(f.host.automations.claims(watcher).claims).toContainEqual(expect.objectContaining({
      state: "failed", error: "chain-stopped", attempts: 0, depth: 4, actor: { kind: "agent", depth: 4, appId, userId: "person-local" } }));
  });

  it("keeps the depth an invocation started with after its run ends or another replaces it", async () => {
    const f = await attributed();
    f.setRun({ depth: 1 });
    const ended = f.invoke("ended");
    f.setRun(null);
    await ended;
    expect(f.host.automations.next()).toMatchObject({ depth: 1, actor: { kind: "agent", depth: 1 } });
    f.setRun({ depth: 1 });
    const replaced = f.invoke("replaced");
    f.setRun({ depth: 3 });
    await replaced;
    expect(f.host.automations.next()).toMatchObject({ depth: 1, actor: { kind: "agent", depth: 1 } });
  });

  it("counts a person's click during a run as the run's, and leaves the owner's own edits the owner's", async () => {
    const f = await attributed();
    f.setRun({ depth: 2 });
    // The app cannot tell a click from the agent's request, so both are the run's.
    await Promise.all([f.invoke("person"), f.invoke("agent")]);
    expect([f.host.automations.next(), f.host.automations.next()]).toEqual([
      expect.objectContaining({ depth: 2, actor: expect.objectContaining({ kind: "agent" }) }),
      expect.objectContaining({ depth: 2, actor: expect.objectContaining({ kind: "agent" }) }),
    ]);
    // An edit the person makes in the Collection itself is not an app's.
    await f.host.action({ datasetId: id(1), revision: 1, revisionSha256: f.revision.revisionSha256, operationId: id(6), idempotencyKey: "owner",
      input: { values: { [id(4)]: "Owner" } } });
    expect(f.host.automations.next()).toMatchObject({ depth: 0, actor: { kind: "owner" } });
  });

  it("replays a retry under its first attribution, with one commit and one claim", async () => {
    const f = await attributed();
    const first = await f.invoke("retry");
    expect(f.host.automations.next()).toMatchObject({ depth: 0, actor: { kind: "owner" } });
    for (const run of [{ depth: 3 }, { depth: 0 }, null]) {
      f.setRun(run);
      expect(await f.invoke("retry")).toEqual({ ...first as object, replayed: true });
    }
    expect(f.host.automations.next()).toBeNull();
    expect(f.host.history({ datasetId: id(1) }).entries).toHaveLength(1);
  });

  it("grants an app nothing through a run and takes no actor or depth from its request", async () => {
    const f = await attributed();
    f.setRun({ depth: 1 });
    await expect(f.host.apps.request(f.published.publicationId, "invoke", { ...f.invocation("x", "listed"), operation: "list" })).rejects.toThrow(/not approved/);
    for (const forged of [{ agent: { depth: 0 } }, { depth: 0 }, { actor: { kind: "owner" } }]) {
      await expect(f.host.apps.request(f.published.publicationId, "invoke", { ...f.invocation("x", "forged"), ...forged })).rejects.toThrow(/Unexpected app backend fields/);
    }
    await f.host.apps.withdraw(f.published.publicationId, f.published.authorityRevision);
    await expect(f.invoke("revoked")).rejects.toThrow(/approval changed/);
    expect(f.host.automations.next()).toBeNull();
    expect(f.host.history({ datasetId: id(1) }).entries).toEqual([]);
  });

  it("refuses an invocation when main cannot read the run for this host's attachment", async () => {
    const f = await fixture(() => { throw new Error("The Collection workspace attachment changed."); });
    await expect(f.host.apps.request(f.published.publicationId, "invoke", f.invocation())).rejects.toThrow(/attachment changed/);
    expect(f.host.history({ datasetId: id(1) }).entries).toEqual([]);
  });
});
