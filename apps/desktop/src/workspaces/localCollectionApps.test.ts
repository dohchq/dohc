import { createHash } from "node:crypto";
import { openedLocalState } from "../testing/preparedLocalState";
import { DatabaseSync } from "node:sqlite";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { compareAppCollectionPaths, exposesAppCollectionSubmittedFields } from "@dohc/security-contract/app-collection-checks";
import type { DatasetDefinition } from "@dohc/security-contract/dataset";
import type { MomentWriteAuthor } from "@dohc/workspace-contracts/engine";
import { sourceCaptureAdapter } from "../testing/sourceCaptureAdapter";
import { createDatasetFixtureCompiler } from "../testing/datasetFixtureCompiler";
import { compileClosedApp } from "./closedAppCompiler";
import { generateDatasetFormSources } from "./datasetFormGenerator";
import { generateDatasetSources } from "./datasetGenerator";
import { createLocalAppLaunchHost, LocalAppUnavailableError } from "./localAppLaunch";
import { LocalCollectionRefusal, LOCAL_APP_WITHDRAW_TIMEOUT_MS, MAX_LOCAL_COLLECTION_CREATES_PER_PUBLICATION, type Envelope, type LocalCollectionEngine } from "./localCollectionApps";
import { createLocalDatasetHost, reconcileExistingLocalCollectionApps, type LocalDatasetHost } from "./localDatasetHost";
import { prepareLocalAppPublication } from "./ownerAppPublication";
import { unguardedCollections } from "../testing/collectionsHolder";

const compileFixture = createDatasetFixtureCompiler();
const schema = "version: 1\nfields:\n  name:\n    type: text\n  destination:\n    type: select\n    options: [Tokyo, Manila]\n  note:\n    type: text\n";
const person: MomentWriteAuthor = { kind: "human", humanId: "person-local" };
const roots: string[] = [], hosts: LocalDatasetHost[] = [];
afterEach(async () => {
  for (const host of hosts.splice(0)) await host.close();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
const signal = () => new AbortController().signal;
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; };

/** An engine with versions, deterministic moments, and controls for outages, held writes, and refusals. */
function fakeEngine() {
  const versions = new Map<string, Map<string, string>>([["main", new Map([["trip/responses/collection.yaml", schema]])]]);
  const moments = new Map<string, { workspaceId: string; versionId: string; objectId: string; path: string; operation: string; text: string }>();
  // down: nothing answers. writeDown: writes fail before committing. failAfterCommit: the next write commits, then its answer is lost.
  // afterCommit: runs once a write commits, before the engine answers.
  const state = { active: "main", down: false, writeDown: false, lookupDown: false, hold: null as Promise<void> | null, readHold: null as Promise<void> | null, heldReads: 0,
    failAfterCommit: false, afterCommit: null as (() => void) | null, writes: [] as Envelope[] };
  const check = () => { if (state.down) throw new Error("The engine stopped."); };
  const api: LocalCollectionEngine = {
    async activeVersionId() { check(); return state.active; },
    async listFiles({ versionId, folder, afterPath, limit }) {
      check();
      const paths = [...versions.get(versionId)!.keys()].filter(path => path.startsWith(folder + "/") && (afterPath === undefined || compareAppCollectionPaths(path, afterPath) > 0)).sort(compareAppCollectionPaths);
      return { files: paths.slice(0, limit).map(path => ({ path, contentKind: "text", byteLength: Buffer.byteLength(versions.get(versionId)!.get(path)!) })), more: paths.length > limit };
    },
    async readText({ versionId, path }) {
      check();
      if (state.readHold && path.endsWith(".md")) { state.heldReads++; await state.readHold; }
      return versions.get(versionId)?.get(path) ?? null;
    },
    async create(envelope) {
      check();
      if (state.writeDown) throw new Error("The engine connection closed.");
      state.writes.push(structuredClone(envelope));
      if (state.hold) await state.hold;
      check();
      const prior = moments.get(envelope.momentId);
      if (prior) return { objectId: prior.objectId, momentId: envelope.momentId };
      if (envelope.versionId !== state.active) throw new LocalCollectionRefusal("The saved version is no longer active.");
      const files = versions.get(envelope.versionId)!;
      if (files.has(envelope.path)) throw new LocalCollectionRefusal(`File already exists: ${envelope.path}`);
      files.set(envelope.path, envelope.text);
      moments.set(envelope.momentId, { workspaceId: "w", versionId: envelope.versionId, objectId: `object-${moments.size}`, path: envelope.path, operation: "write", text: envelope.text });
      state.afterCommit?.();
      if (state.failAfterCommit) { state.failAfterCommit = false; throw new Error("The engine connection closed."); }
      return { objectId: moments.get(envelope.momentId)!.objectId, momentId: envelope.momentId };
    },
    async moment(momentId) { if (state.lookupDown || state.down) throw new Error("The engine stopped."); return moments.get(momentId) ?? null; },
  };
  return { api, state, versions, moments, files: (versionId = state.active) => versions.get(versionId)!,
    fork(versionId: string) { versions.set(versionId, new Map(versions.get(state.active))); } };
}
type Engine = ReturnType<typeof fakeEngine>;

const definition: DatasetDefinition = { formatVersion: 1, datasetId: "00000000-0000-4000-8000-000000000001", name: "Trips", schemaPath: "data/schema.sql", operationsPath: "data/operations.js",
  tables: [{ tableId: "00000000-0000-4000-8000-000000000002", name: "Responses", sqlName: "responses", primaryKey: "id", fields: [
    { fieldId: "00000000-0000-4000-8000-000000000003", name: "ID", sqlColumn: "id", type: "text", required: true, unique: true },
    { fieldId: "00000000-0000-4000-8000-000000000004", name: "Name", sqlColumn: "name", type: "text", required: true, unique: false },
  ] }], operations: [{ operationId: "00000000-0000-4000-8000-000000000006", name: "submit", label: "Submit", tableId: "00000000-0000-4000-8000-000000000002", kind: "create", access: "link", readOnly: false, fieldIds: ["00000000-0000-4000-8000-000000000004"] }] };

async function fixture(options: { workspaceRoot?: string; engine?: Engine; author?: () => Promise<MomentWriteAuthor>; readFields?: string[] } = {}) {
  const workspaceRoot = options.workspaceRoot ?? await mkdtemp(join(tmpdir(), "dohc-collection-app-"));
  if (!options.workspaceRoot) roots.push(workspaceRoot);
  const engine = options.engine ?? fakeEngine();
  const open = async () => {
    // Workers and exports live in .dohc/local, which an engine open prepares.
    await openedLocalState({ workspaceId: "w", rootPath: workspaceRoot });
    const host = await createLocalDatasetHost({ holder: unguardedCollections, localPersonId: () => "person-local", workspaceId: "w", workspaceRoot, capacityBytes: 1024 * 1024, compile: compileFixture,
      collectionEngine: () => { if (engine.state.down) throw new Error("The engine is not running."); return engine.api; },
      collectionAuthor: options.author ?? (async () => person) });
    hosts.push(host);
    return host;
  };
  const host = await open();
  const sources = new Map<string, string>([["trip/main.ts", "document.body.textContent = 'Trip';"], ["trip/responses/collection.yaml", schema]]);
  const collectionApp = (readFields = options.readFields ?? ["destination", "name"]) => {
    sources.set("trip/app.publish.json", JSON.stringify({ version: 1, entryPath: "main.ts", inputs: ["main.ts"], packageMap: {},
      collection: { kind: "collection-create", collectionPath: "responses", allowedFields: ["destination", "name"], requiredFields: ["destination"], readFields } }));
    return prepareLocalAppPublication({ workspaceId: "w", appRoot: "trip" }, { deferredWrites: [], adapter: sourceCaptureAdapter(sources), compile: compileClosedApp, signal: signal(), assertCurrent() {} });
  };
  const prepared = await collectionApp();
  const published = await host.apps.activate(prepared, signal());
  const create = (fields: Record<string, unknown>, idempotencyKey = "response-1", target = host, revision = published.authorityRevision) =>
    target.apps.request(published.publicationId, "create", { authorityRevision: revision, idempotencyKey, fields }) as Promise<{ kind: "accepted"; acceptanceId: string; objectId: string; path: string; momentId: string; acceptedAtMs: number }>;
  const list = (input: { limit: number; afterPath?: string } = { limit: 50 }, target = host, revision = published.authorityRevision) =>
    target.apps.request(published.publicationId, "list", { authorityRevision: revision, ...input }) as Promise<{ records: Array<{ path: string; recordId: string | null; fields: Record<string, unknown> }>; nextPath: string | null }>;
  const inspect = <T>(work: (db: DatabaseSync) => T) => { const db = new DatabaseSync(join(workspaceRoot, ".dohc/local/datasets/state.sqlite")); try { return work(db); } finally { db.close(); } };
  let approvedDataset: Awaited<ReturnType<LocalDatasetHost["approve"]>> | undefined;
  const datasetApp = async (target: LocalDatasetHost) => {
    if (!approvedDataset) {
      for (const [path, source] of Object.entries(generateDatasetSources(definition).files)) sources.set(path, source);
      sources.set("data/dataset.json", JSON.stringify(definition));
      const preparation = await target.prepare({ descriptorPath: "data/dataset.json", adapter: sourceCaptureAdapter(sources) });
      approvedDataset = await target.approve({ preparationId: preparation.preparationId, revisionSha256: preparation.revision.revisionSha256 });
    }
    const revision = approvedDataset;
    const form = generateDatasetFormSources({ datasetPath: "data/dataset.json", approvedRevision: revision, tableId: definition.tables[0]!.tableId,
      createOperationId: definition.operations[0]!.operationId, appRoot: "trip", fieldIds: [definition.tables[0]!.fields[1]!.fieldId] });
    for (const [path, source] of Object.entries(form.files)) sources.set(`trip/${path}`, source);
    return prepareLocalAppPublication({ workspaceId: "w", appRoot: "trip" }, { deferredWrites: [], adapter: sourceCaptureAdapter(sources), compile: compileClosedApp, signal: signal(),
      assertCurrent() {}, async resolveDatasetRevision(binding) { return target.approvedArtifacts(binding.datasetId).revision; } });
  };
  return { host, engine, workspaceRoot, open, prepared, published, collectionApp, datasetApp, create, list, inspect };
}

describe("local document Collection apps", () => {
  it("approves a Collection app into the Collection store without a Dataset binding", async () => {
    const f = await fixture();
    expect(f.host.apps.list("trip")).toEqual([expect.objectContaining({ publicationId: f.published.publicationId, approved: true, active: true, pendingCreates: 0,
      collectionCapability: expect.objectContaining({ collectionPath: "trip/responses", readFields: ["destination", "name"] }) })]);
    f.inspect(db => {
      expect(db.prepare("SELECT revision,active_kind,active_publication_id FROM local_app_roots WHERE app_root='trip'").get()).toEqual({ revision: f.published.authorityRevision, active_kind: "collection", active_publication_id: f.published.publicationId });
      expect(db.prepare("SELECT count(*) AS n FROM local_collection_apps").get()!.n).toBe(1);
      expect(db.prepare("SELECT count(*) AS n FROM local_dataset_apps").get()!.n).toBe(0);
      expect(db.prepare("SELECT count(*) AS n FROM dohc_dataset_bindings").get()!.n).toBe(0);
    });
    expect(f.host.apps.browserPublication(f.published.publicationId).files.length).toBeGreaterThan(0);
    // Reapproving the identical candidate keeps its revision.
    expect(await f.host.apps.activate(f.prepared, signal())).toMatchObject({ publicationId: f.published.publicationId, authorityRevision: f.published.authorityRevision });
  });

  it("approves write-only fields locally, which a link approval refuses", async () => {
    const f = await fixture({ readFields: ["destination"] });
    const capability = f.prepared.candidate.capabilities[0];
    expect(capability?.kind === "collection-create" && exposesAppCollectionSubmittedFields(capability)).toBe(false);
    expect(f.host.apps.list("trip")[0]).toMatchObject({ active: true });
    await f.create({ destination: "Tokyo", name: "Private" });
    expect((await f.list()).records.map(record => record.fields)).toEqual([{ destination: "Tokyo" }]);
  });

  it("reads approved fields from the published projection in UTF-8 byte order", async () => {
    const f = await fixture({ readFields: ["destination"] });
    const files = f.engine.files();
    const record = (fields: object) => `---\n${JSON.stringify(fields)}\n---\nbody`;
    files.set("trip/responses/b.md", record({ destination: "Tokyo", name: "Secret", note: "hidden" }));
    files.set("trip/responses/é.md", record({ destination: "Manila" }));
    files.set("trip/responses/\u{1f600}.md", record({ destination: "Tokyo" }));
    files.set("trip/responses/Ａ.md", record({ destination: "Manila" }));
    files.set("trip/responses/nested/c.md", record({ destination: "Tokyo" }));
    files.set("trip/responses/d.txt", record({ destination: "Tokyo" }));
    files.set("trip/responses/huge.md", record({ destination: "Tokyo", note: "x".repeat(17_000) }));
    files.set("trip/responses/wrong.md", record({ destination: "Paris" }));
    files.set("trip/other.md", record({ destination: "Tokyo" }));
    const all: Array<{ path: string; fields: Record<string, unknown> }> = [];
    let afterPath: string | undefined, pages = 0;
    do {
      const page = await f.list({ limit: 2, ...(afterPath === undefined ? {} : { afterPath }) });
      all.push(...page.records); afterPath = page.nextPath ?? undefined; pages++;
    } while (afterPath && pages < 20);
    expect(all.map(record => record.path)).toEqual(["trip/responses/b.md", "trip/responses/é.md", "trip/responses/Ａ.md", "trip/responses/\u{1f600}.md"]);
    expect(all.map(record => record.fields)).toEqual([{ destination: "Tokyo" }, { destination: "Manila" }, { destination: "Manila" }, { destination: "Tokyo" }]);
    await expect(f.list({ limit: 2, afterPath: "trip/other.md" })).rejects.toThrow(/Invalid collection page/);
    await expect(f.list({ limit: 101 })).rejects.toThrow(/Invalid collection page/);
    // A schema edit after approval stops reads until the app is prepared again.
    files.set("trip/responses/collection.yaml", schema + "  extra:\n    type: text\n");
    await expect(f.list()).rejects.toThrow(/schema changed/);
  });

  it("never names a nested or uncontained file in a page cursor", async () => {
    const f = await fixture({ readFields: ["destination"] });
    const files = f.engine.files(), record = `---\n${JSON.stringify({ destination: "Tokyo" })}\n---\n`;
    for (const path of ["trip/responses/-a.md", "trip/responses/.env.md", "trip/responses/b/jane-salary.md", "trip/responses/b/notes.md", "trip/responses/c.md"]) files.set(path, record);
    const records: string[] = [], cursors: Array<string | null> = [];
    let afterPath: string | undefined;
    do {
      const page = await f.list({ limit: 1, ...(afterPath === undefined ? {} : { afterPath }) });
      records.push(...page.records.map(row => row.path)); cursors.push(page.nextPath); afterPath = page.nextPath ?? undefined;
    } while (afterPath && cursors.length < 10);
    expect(records).toEqual(["trip/responses/-a.md", "trip/responses/c.md"]);
    // A cursor names only a record, though the first page ends beside the secret file and the nested folder.
    expect(cursors).toEqual(["trip/responses/-a.md", null]);
  });

  it("refuses reads without approved read fields, foreign actions, and stale authority", async () => {
    const f = await fixture({ readFields: [] });
    await expect(f.list()).rejects.toThrow(/cannot read/);
    await expect(f.host.apps.request(f.published.publicationId, "invoke", { authorityRevision: f.published.authorityRevision, operation: "submit", idempotencyKey: "k", input: {} })).rejects.toThrow(/not approved/);
    await expect(f.host.apps.readBrowserFile(f.published.publicationId, { authorityRevision: f.published.authorityRevision, fileId: "f".repeat(16), operation: "x", input: {} })).rejects.toThrow(/cannot read/);
    await expect(f.list({ limit: 1 }, f.host, f.published.authorityRevision + 1)).rejects.toThrow(/approval changed/);
  });

  it("validates creates against the pinned schema and approved fields", async () => {
    const f = await fixture();
    for (const [index, fields] of [{ name: "No destination" }, { destination: "Paris" }, { destination: "Tokyo", note: "unapproved" }, { destination: "Tokyo", created_by: "forged" },
      { destination: "Tokyo", name: { nested: true } }, { destination: ["Tokyo"] }].entries()) {
      await expect(f.create(fields, `invalid-${index}`)).rejects.toThrow(/collection/i);
    }
    await expect(f.host.apps.request(f.published.publicationId, "create", { authorityRevision: f.published.authorityRevision, idempotencyKey: "k", fields: { destination: "Tokyo" }, path: "elsewhere.md" })).rejects.toThrow(/Invalid collection request/);
    expect(f.engine.state.writes).toEqual([]);
    f.inspect(db => expect(db.prepare("SELECT count(*) AS n FROM local_collection_creates").get()!.n).toBe(0));
  });

  it("writes one record per key with a stable receipt, author, and creation time", async () => {
    let author: MomentWriteAuthor = { kind: "agent", agentId: "dohc-mcp", onBehalfOf: "person-local", agentRunId: "run-1", depth: 1 };
    const f = await fixture({ author: async () => author });
    const [first, racing] = await Promise.all([f.create({ name: "Ana", destination: "Tokyo" }), f.create({ destination: "Tokyo", name: "Ana" })]);
    author = person;
    expect(racing).toEqual(first);
    expect(await f.create({ destination: "Tokyo", name: "Ana" })).toEqual(first);
    expect(Object.keys(first).sort()).toEqual(["acceptanceId", "acceptedAtMs", "kind", "momentId", "objectId", "path"]);
    expect(f.engine.state.writes).toHaveLength(1);
    expect(f.engine.state.writes[0]).toMatchObject({ path: first.path, momentId: first.momentId, versionId: "main", author: { kind: "agent", agentRunId: "run-1", depth: 1 } });
    expect(first.path).toBe(`trip/responses/${first.acceptanceId}.md`);
    const text = f.engine.files().get(first.path)!;
    expect(JSON.parse(text.split("\n")[1]!)).toEqual({ destination: "Tokyo", name: "Ana", id: expect.stringMatching(/^rec_[a-z2-7]{26}$/), created_at: first.acceptedAtMs, acceptance_id: first.acceptanceId });
    await expect(f.create({ destination: "Manila" })).rejects.toThrow(/already used for another response/);
    expect((await f.list()).records).toEqual([{ path: first.path, recordId: expect.stringMatching(/^rec_/), fields: { destination: "Tokyo", name: "Ana" } }]);
  });

  it("keeps a reservation through an engine outage and completes it on restart without a second write", async () => {
    const f = await fixture();
    f.engine.state.failAfterCommit = true;
    await expect(f.create({ destination: "Tokyo" })).rejects.toBeInstanceOf(LocalAppUnavailableError);
    expect(f.host.apps.list("trip")[0]).toMatchObject({ pendingCreates: 1 });
    const createdAt = f.inspect(db => Number(db.prepare("SELECT created_at_ms FROM local_collection_creates").get()!.created_at_ms));
    f.engine.state.down = true;
    await f.host.close();
    const restarted = await f.open();
    expect(restarted.apps.list("trip")[0]).toMatchObject({ pendingCreates: 1 });
    f.engine.state.down = false; f.engine.state.writes.length = 0;
    restarted.apps.reconcile();
    await expect.poll(() => restarted.apps.list("trip")[0]).toMatchObject({ pendingCreates: 0 });
    expect(f.engine.state.writes).toEqual([]);
    const receipt = await f.create({ destination: "Tokyo" }, "response-1", restarted);
    expect(receipt).toMatchObject({ acceptedAtMs: createdAt, objectId: "object-0" });
    expect([...f.engine.files().keys()].filter(path => path.endsWith(".md"))).toEqual([receipt.path]);
  });

  it("resends a reservation the engine never committed, only after confirming its moment is absent", async () => {
    const f = await fixture();
    f.engine.state.writeDown = true;
    await expect(f.create({ destination: "Tokyo" })).rejects.toBeInstanceOf(LocalAppUnavailableError);
    f.engine.state.writeDown = false; f.engine.state.lookupDown = true;
    f.host.apps.reconcile();
    await expect(f.create({ destination: "Tokyo" })).rejects.toBeInstanceOf(LocalAppUnavailableError);
    expect(f.engine.state.writes).toEqual([]);
    f.engine.state.lookupDown = false;
    const receipt = await f.create({ destination: "Tokyo" });
    expect(f.engine.state.writes).toHaveLength(1);
    expect(f.engine.files().get(receipt.path)).toContain("Tokyo");
  });

  it("completes a saved-version moment after a version switch and never writes into the new version", async () => {
    const f = await fixture();
    f.engine.fork("draft");
    f.engine.state.failAfterCommit = true;
    await expect(f.create({ destination: "Tokyo" }, "committed")).rejects.toBeInstanceOf(LocalAppUnavailableError);
    f.engine.state.writeDown = true;
    await expect(f.create({ destination: "Manila" }, "absent")).rejects.toBeInstanceOf(LocalAppUnavailableError);
    f.engine.state.writeDown = false; f.engine.state.active = "draft";
    const committed = await f.create({ destination: "Tokyo" }, "committed");
    expect(f.engine.files("main").get(committed.path)).toBeDefined();
    expect((await f.list()).records).toEqual([]);
    await expect(f.create({ destination: "Manila" }, "absent")).rejects.toThrow(/did not save this response\. The saved version is no longer active/);
    expect([...f.engine.files("draft").keys()]).toEqual(["trip/responses/collection.yaml"]);
    f.inspect(db => {
      expect(db.prepare("SELECT count(*) AS n FROM local_collection_creates WHERE envelope IS NULL").get()!.n).toBe(2);
      expect(JSON.parse(String(db.prepare("SELECT outcome FROM local_collection_creates WHERE idempotency_key='absent'").get()!.outcome))).toMatchObject({ kind: "notWritten" });
    });
    // The stored outcome answers later retries without another write.
    const writes = f.engine.state.writes.length;
    await expect(f.create({ destination: "Manila" }, "absent")).rejects.toThrow(/did not save/);
    expect(f.engine.state.writes).toHaveLength(writes);
  });

  it("settles an occupied path and a resend outside the workspace as not written, keeping their slots", async () => {
    const f = await fixture();
    f.engine.state.writeDown = true;
    await expect(f.create({ destination: "Tokyo" }, "occupied")).rejects.toBeInstanceOf(LocalAppUnavailableError);
    await expect(f.create({ destination: "Tokyo" }, "escaped")).rejects.toBeInstanceOf(LocalAppUnavailableError);
    f.engine.state.writeDown = false;
    const envelope = (key: string) => f.inspect(db => JSON.parse(String(db.prepare("SELECT envelope FROM local_collection_creates WHERE idempotency_key=?").get(key)!.envelope)) as Envelope);
    const occupied = envelope("occupied").path;
    f.engine.files().set(occupied, "someone else's file");
    f.inspect(db => db.prepare("UPDATE local_collection_creates SET envelope=? WHERE idempotency_key='escaped'").run(JSON.stringify({ ...envelope("escaped"), path: "shared-with-me/x/response.md" })));
    await expect(f.create({ destination: "Tokyo" }, "occupied")).rejects.toThrow(/File already exists/);
    await expect(f.create({ destination: "Tokyo" }, "escaped")).rejects.toThrow(/outside your workspace/);
    expect(f.engine.files().get(occupied)).toBe("someone else's file");
    expect(f.engine.state.writes.map(write => write.path)).toEqual([occupied]);
    f.inspect(db => expect(db.prepare("SELECT count(*) AS n, sum(envelope IS NULL) AS settled FROM local_collection_creates").get()).toEqual({ n: 2, settled: 2 }));
  });

  it("keeps the lifetime response limit across withdrawal and reapproval", async () => {
    const f = await fixture();
    f.inspect(db => {
      const insert = db.prepare("INSERT INTO local_collection_creates VALUES(?,?,?,?,NULL,?,?,1)");
      db.exec("BEGIN");
      for (let n = 0; n < MAX_LOCAL_COLLECTION_CREATES_PER_PUBLICATION - 1; n++) insert.run(f.published.publicationId, `seed-${n}`, "0".repeat(64), 1, JSON.stringify({ kind: "notWritten", reason: "seed" }), 0);
      db.exec("COMMIT");
    });
    await f.create({ destination: "Tokyo" }, "last");
    await expect(f.create({ destination: "Tokyo" }, "over")).rejects.toThrow(/response limit/);
    expect(await f.host.apps.withdraw(f.published.publicationId, f.published.authorityRevision)).toMatchObject({ kind: "withdrawn" });
    const again = await f.host.apps.activate(f.prepared, signal());
    expect(again.publicationId).toBe(f.published.publicationId);
    await expect(f.create({ destination: "Tokyo" }, "over", f.host, again.authorityRevision)).rejects.toThrow(/response limit/);
  });

  it("confirms withdrawal only after an admitted write settles, and none lands afterward", async () => {
    const f = await fixture();
    const gate = deferred(); f.engine.state.hold = gate.promise;
    const pending = f.create({ destination: "Tokyo" }).catch((error: unknown) => error);
    await expect.poll(() => f.engine.state.writes.length).toBe(1);
    const withdrawal = f.host.apps.withdraw(f.published.publicationId, f.published.authorityRevision);
    await expect(f.create({ destination: "Tokyo" }, "after")).rejects.toThrow(/approval changed/);
    gate.resolve();
    expect(await withdrawal).toEqual({ kind: "withdrawn", publicationId: f.published.publicationId, authorityRevision: f.published.authorityRevision + 1 });
    expect(await pending).toBeInstanceOf(Error);
    expect(f.engine.moments.size).toBe(1);
    expect(f.host.apps.list("trip")[0]).toMatchObject({ approved: false, active: false, pendingCreates: 0 });
    expect(f.engine.state.writes).toHaveLength(1);
  });

  it("reports an unconfirmed withdrawal while the engine is down and confirms it at the same revision later", async () => {
    const f = await fixture();
    f.engine.state.writeDown = true;
    await expect(f.create({ destination: "Tokyo" })).rejects.toBeInstanceOf(LocalAppUnavailableError);
    f.engine.state.down = true;
    const unconfirmed = await f.host.apps.withdraw(f.published.publicationId, f.published.authorityRevision);
    expect(unconfirmed).toEqual({ kind: "withdrawalUnconfirmed", publicationId: f.published.publicationId, authorityRevision: f.published.authorityRevision + 1, unresolvedCreates: 1 });
    await expect(f.host.apps.withdraw(f.published.publicationId, f.published.authorityRevision)).rejects.toThrow(/approval changed/);
    expect(await f.host.apps.withdraw(f.published.publicationId, unconfirmed.authorityRevision)).toMatchObject({ kind: "withdrawalUnconfirmed", authorityRevision: unconfirmed.authorityRevision });
    expect(f.host.apps.list("trip")[0]).toMatchObject({ approved: false, pendingCreates: 1, authorityRevision: unconfirmed.authorityRevision });
    // A restart keeps the pending reservation; the engine's return settles it in the background.
    await f.host.close();
    const restarted = await f.open();
    expect(restarted.apps.list("trip")[0]).toMatchObject({ pendingCreates: 1 });
    f.engine.state.down = false; f.engine.state.writeDown = false;
    restarted.apps.reconcile();
    await expect.poll(() => restarted.apps.list("trip")[0]).toMatchObject({ pendingCreates: 0 });
    expect(await restarted.apps.withdraw(f.published.publicationId, unconfirmed.authorityRevision)).toEqual({ kind: "withdrawn", publicationId: f.published.publicationId, authorityRevision: unconfirmed.authorityRevision });
    f.inspect(db => expect(db.prepare("SELECT revision FROM local_app_roots WHERE app_root='trip'").get()!.revision).toBe(unconfirmed.authorityRevision));
  });

  it("stops waiting for a stuck write at the deadline and settles it in the background", async () => {
    const f = await fixture();
    const gate = deferred(); f.engine.state.hold = gate.promise;
    void f.create({ destination: "Tokyo" }).catch(() => undefined);
    await expect.poll(() => f.engine.state.writes.length).toBe(1);
    const started = Date.now();
    const result = await f.host.apps.withdraw(f.published.publicationId, f.published.authorityRevision);
    expect(result).toMatchObject({ kind: "withdrawalUnconfirmed", unresolvedCreates: 1 });
    expect(Date.now() - started).toBeGreaterThanOrEqual(LOCAL_APP_WITHDRAW_TIMEOUT_MS - 100);
    gate.resolve();
    await expect.poll(() => f.host.apps.list("trip")[0]).toMatchObject({ pendingCreates: 0 });
    expect(await f.host.apps.withdraw(f.published.publicationId, result.authorityRevision)).toMatchObject({ kind: "withdrawn" });
  }, LOCAL_APP_WITHDRAW_TIMEOUT_MS * 4);

  it("closes while a write is stuck, never records its late result, and settles it on the next open", async () => {
    const f = await fixture();
    const gate = deferred(); f.engine.state.hold = gate.promise;
    void f.create({ destination: "Tokyo" }).catch(() => undefined);
    await expect.poll(() => f.engine.state.writes.length).toBe(1);
    await f.host.close();
    gate.resolve();
    await expect.poll(() => f.engine.moments.size).toBe(1);
    f.inspect(db => expect(db.prepare("SELECT envelope IS NOT NULL AS pending FROM local_collection_creates").get()!.pending).toBe(1));
    f.engine.state.hold = null;
    const restarted = await f.open();
    restarted.apps.reconcile();
    await expect.poll(() => restarted.apps.list("trip")[0]).toMatchObject({ pendingCreates: 0 });
    expect(f.engine.state.writes).toHaveLength(1);
  }, LOCAL_APP_WITHDRAW_TIMEOUT_MS * 4);

  it("charges Collection storage outside Dataset usage, so an older build refuses the store", async () => {
    const f = await fixture();
    await f.create({ destination: "Tokyo" });
    await f.host.close();
    f.inspect(db => {
      const budget = Number(db.prepare("SELECT bytes FROM local_dataset_budget").get()!.bytes);
      const datasets = Number(db.prepare("SELECT coalesce(sum(bytes),0) AS bytes FROM local_dataset_usage").get()!.bytes);
      const collections = Number(db.prepare("SELECT bytes FROM local_collection_app_usage").get()!.bytes);
      const stored = Number(db.prepare("SELECT (SELECT sum(storage_bytes) FROM local_collection_apps)+(SELECT sum(storage_bytes) FROM local_collection_creates) AS bytes").get()!.bytes);
      expect(collections).toBe(stored);
      expect(budget).toBe(datasets + collections);
      // The previous build compares the budget with Dataset usage alone.
      expect(budget).not.toBe(datasets);
    });
    const reopened = await f.open();
    expect(reopened.apps.list("trip")[0]).toMatchObject({ active: true });
  });

  it("moves a root between kinds only by explicit replacement, refusing each earlier session", async () => {
    const f = await fixture();
    const sessionA = f.published;
    const datasetB = await f.host.apps.activate(await f.datasetApp(f.host), signal());
    expect(() => f.host.apps.assertBrowserPublication(sessionA.publicationId, sessionA.authorityRevision)).toThrow(/approval changed/);
    await expect(f.host.apps.request(datasetB.publicationId, "list", { authorityRevision: datasetB.authorityRevision, limit: 1 })).rejects.toThrow(/document Collection/);
    expect(f.host.apps.list("trip").map(row => [row.publicationId, row.approved])).toEqual(expect.arrayContaining([[sessionA.publicationId, false], [datasetB.publicationId, true]]));
    const collectionA = await f.host.apps.activate(await f.collectionApp(), signal());
    expect(collectionA.publicationId).toBe(sessionA.publicationId);
    expect(collectionA.authorityRevision).toBeGreaterThan(datasetB.authorityRevision);
    expect(() => f.host.apps.assertBrowserPublication(sessionA.publicationId, sessionA.authorityRevision)).toThrow(/approval changed/);
    expect(() => f.host.apps.assertBrowserPublication(datasetB.publicationId, datasetB.authorityRevision)).toThrow(/approval changed/);
    f.inspect(db => expect(db.prepare("SELECT count(*) AS n FROM dohc_dataset_bindings WHERE app_id=?").get(datasetB.publicationId)!.n).toBe(0));
    // An older build may leave the displaced Dataset row active. Reopening does not hand it the root.
    await f.host.close();
    f.inspect(db => db.prepare("UPDATE local_dataset_apps SET active=1 WHERE publication_id=?").run(datasetB.publicationId));
    const reopened = await f.open();
    expect(() => reopened.apps.assertBrowserPublication(collectionA.publicationId, collectionA.authorityRevision)).not.toThrow();
    // Dataset A, then Collection B, then the identical Dataset A.
    const datasetA = await reopened.apps.activate(await f.datasetApp(reopened), signal());
    const collectionB = await reopened.apps.activate(await f.collectionApp(["destination"]), signal());
    const datasetAgain = await reopened.apps.activate(await f.datasetApp(reopened), signal());
    expect(datasetAgain.publicationId).toBe(datasetA.publicationId);
    expect(() => reopened.apps.assertBrowserPublication(datasetA.publicationId, datasetA.authorityRevision)).toThrow(/approval changed/);
    expect(() => reopened.apps.assertBrowserPublication(collectionB.publicationId, collectionB.authorityRevision)).toThrow(/approval changed/);
    await reopened.close();
    const again = await f.open();
    expect(() => again.apps.assertBrowserPublication(datasetAgain.publicationId, datasetAgain.authorityRevision)).not.toThrow();
  });

  it("settles a replaced app's responses before its replacement commits", async () => {
    const f = await fixture();
    f.engine.state.writeDown = true;
    await expect(f.create({ destination: "Tokyo" })).rejects.toBeInstanceOf(LocalAppUnavailableError);
    await expect(f.host.apps.activate(await f.collectionApp(["destination"]), signal())).rejects.toThrow(/still saving/);
    expect(() => f.host.apps.assertBrowserPublication(f.published.publicationId, f.published.authorityRevision)).not.toThrow();
    f.engine.state.writeDown = false;
    const replacement = await f.host.apps.activate(await f.collectionApp(["destination"]), signal());
    expect(replacement.publicationId).not.toBe(f.published.publicationId);
    expect(f.engine.moments.size).toBe(1);
  });

  it("runs a Collection app through its loopback launch without a share link", async () => {
    const f = await fixture(), lifetime = new AbortController();
    const launcher = await createLocalAppLaunchHost({ backend: f.host.apps, lifetime: lifetime.signal });
    try {
      const url = new URL(await launcher.launch(f.published.publicationId, signal())), origin = url.origin;
      const post = (path: string, body: unknown, headers: Record<string, string> = {}) => fetch(origin + path, { method: "POST", headers: { origin, "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
      const { proof } = await (await post("/session", { handoff: url.hash.slice(1) })).json() as { proof: string };
      const backend = (body: unknown) => post("/backend", body, { "x-dohc-app-proof": proof });
      const created = await backend({ id: "create", op: "collection.create", idempotencyKey: "trip-1", fields: { destination: "Manila", name: "Bo" } });
      expect(created.status).toBe(200);
      const receipt = await created.json() as { path: string };
      const page = await (await backend({ id: "list", op: "collection.list", limit: 10 })).json();
      expect(page).toEqual({ records: [{ path: receipt.path, recordId: expect.stringMatching(/^rec_/), fields: { destination: "Manila", name: "Bo" } }], nextPath: null });
      expect((await backend({ id: "invoke", op: "backend.invoke", operation: "submit", idempotencyKey: "k", input: {} })).status).toBe(404);
      f.engine.state.down = true;
      expect((await backend({ id: "list", op: "collection.list", limit: 10 })).status).toBe(503);
      f.engine.state.down = false;
      await f.host.apps.withdraw(f.published.publicationId, f.published.authorityRevision);
      expect((await backend({ id: "list", op: "collection.list", limit: 10 })).status).toBe(404);
    } finally { lifetime.abort(); await launcher.close(); }
  });

  it("refuses to deliver a read that was queued when the approval ended", async () => {
    const f = await fixture();
    await f.create({ destination: "Tokyo" });
    const gate = deferred(); f.engine.state.readHold = gate.promise;
    const read = f.list().catch((error: unknown) => error);
    await expect.poll(() => f.engine.state.heldReads).toBe(1);
    await f.host.apps.withdraw(f.published.publicationId, f.published.authorityRevision);
    gate.resolve();
    expect(await read).toMatchObject({ name: "AbortError" });
    // Without the abort, the read still rechecks the approval before it answers.
    const again = await f.host.apps.activate(f.prepared, signal());
    const late = deferred(); f.engine.state.readHold = late.promise;
    const queued = f.list({ limit: 50 }, f.host, again.authorityRevision).catch((error: unknown) => error);
    await expect.poll(() => f.engine.state.heldReads).toBe(2);
    f.inspect(db => db.prepare("UPDATE local_app_roots SET revision=revision+1 WHERE app_root='trip'").run());
    late.resolve();
    expect(String(await queued)).toMatch(/approval changed/);
  });

  it("rechecks the schema for a create the engine never received until it is submitted", async () => {
    let admitted = () => {};
    const f = await fixture({ author: async () => { admitted(); return person; } });
    // The engine stops after admission, before the first submission's schema check.
    admitted = () => { f.engine.state.down = true; };
    await expect(f.create({ destination: "Tokyo" })).rejects.toBeInstanceOf(LocalAppUnavailableError);
    f.inspect(db => expect(db.prepare("SELECT submitted, envelope IS NOT NULL AS pending FROM local_collection_creates").get()).toEqual({ submitted: 0, pending: 1 }));
    admitted = () => {};
    f.engine.state.down = false;
    f.engine.files().set("trip/responses/collection.yaml", schema + "  extra:\n    type: text\n");
    f.host.apps.reconcile();
    await expect.poll(() => f.host.apps.list("trip")[0]).toMatchObject({ pendingCreates: 0 });
    await expect(f.create({ destination: "Tokyo" })).rejects.toThrow(/did not save this response\. The Collection schema changed/);
    expect(f.engine.state.writes).toEqual([]);
  });

  it("gives no receipt to a request whose approval ended or that was aborted, even once its write committed", async () => {
    const f = await fixture();
    // The approval changes after the engine commits and before it answers.
    f.engine.state.afterCommit = () => { f.engine.state.afterCommit = null; f.inspect(db => db.prepare("UPDATE local_app_roots SET revision=revision+1 WHERE app_root='trip'").run()); };
    await expect(f.create({ destination: "Tokyo" })).rejects.toThrow(/approval changed/);
    expect(f.engine.moments.size).toBe(1);
    f.inspect(db => expect(db.prepare("SELECT json_extract(outcome,'$.kind') AS kind FROM local_collection_creates").get()!.kind).toBe("accepted"));
    const again = await f.host.apps.activate(f.prepared, signal());
    const receipt = await f.create({ destination: "Tokyo" }, "aborted", f.host, again.authorityRevision);
    const aborted = new AbortController(); aborted.abort();
    await expect(f.host.apps.request(f.published.publicationId, "create", { authorityRevision: again.authorityRevision, idempotencyKey: "aborted", fields: { destination: "Tokyo" } }, aborted.signal))
      .rejects.toMatchObject({ name: "AbortError" });
    expect(await f.create({ destination: "Tokyo" }, "aborted", f.host, again.authorityRevision)).toEqual(receipt);
  });

  it("refuses new work as soon as close begins while an admitted response still records its outcome", async () => {
    const f = await fixture();
    const gate = deferred(); f.engine.state.hold = gate.promise;
    void f.create({ destination: "Tokyo" }).catch(() => undefined);
    await expect.poll(() => f.engine.state.writes.length).toBe(1);
    const closing = f.host.close();
    expect(() => f.host.list()).toThrow(/session ended/);
    expect(() => f.host.apps.list("trip")).toThrow(/session ended/);
    await expect(f.host.apps.withdraw(f.published.publicationId, f.published.authorityRevision)).rejects.toThrow(/session ended/);
    await expect(f.host.apps.activate(f.prepared, signal())).rejects.toThrow(/session ended/);
    gate.resolve();
    await closing;
    f.inspect(db => expect(db.prepare("SELECT envelope IS NULL AS settled, json_extract(outcome,'$.kind') AS kind FROM local_collection_creates").get()).toEqual({ settled: 1, kind: "accepted" }));
  });

  it("reconciles on attachment only a store that already exists", async () => {
    const empty = await mkdtemp(join(tmpdir(), "dohc-collection-app-")); roots.push(empty);
    let opened = 0;
    await reconcileExistingLocalCollectionApps(empty, async () => { opened++; throw new Error("The store must stay absent."); });
    expect(opened).toBe(0);
    expect(existsSync(join(empty, ".dohc"))).toBe(false);
    const f = await fixture();
    f.engine.state.writeDown = true;
    await expect(f.create({ destination: "Tokyo" })).rejects.toBeInstanceOf(LocalAppUnavailableError);
    await f.host.close();
    f.engine.state.writeDown = false;
    let reopened: LocalDatasetHost | undefined;
    await reconcileExistingLocalCollectionApps(f.workspaceRoot, async () => (reopened = await f.open()));
    await expect.poll(() => reopened!.apps.list("trip")[0]).toMatchObject({ pendingCreates: 0 });
    expect(f.engine.moments.size).toBe(1);
  });

  it("finishes submitted responses after a later schema edit, which refuses new ones", async () => {
    const f = await fixture();
    f.engine.state.writeDown = true;
    await expect(f.create({ destination: "Tokyo" })).rejects.toBeInstanceOf(LocalAppUnavailableError);
    f.engine.state.writeDown = false;
    f.engine.files().set("trip/responses/collection.yaml", schema + "  extra:\n    type: text\n");
    expect(await f.create({ destination: "Tokyo" })).toMatchObject({ kind: "accepted" });
    await expect(f.create({ destination: "Tokyo" }, "new")).rejects.toThrow(/schema changed/);
  });

  it("refuses a publication ID stored for both kinds and records Collection approval provenance", async () => {
    const f = await fixture();
    const agent = { kind: "agent", label: "Builder", labelSource: "agent-declared" } as const;
    await f.host.apps.withdraw(f.published.publicationId, f.published.authorityRevision);
    const again = await f.host.apps.activate(f.prepared, signal(), agent);
    f.inspect(db => {
      const provenance = JSON.parse(String(db.prepare("SELECT provenance FROM local_app_approval_provenance WHERE publication_id=?").get(again.publicationId)!.provenance));
      expect(provenance).toEqual({ agent, committedCandidateDigest: createHash("sha256").update(JSON.stringify(f.prepared.candidate)).digest("hex"),
        sourceRevision: f.prepared.candidate.sourceRevision, capabilities: f.prepared.candidate.capabilities });
      db.prepare("INSERT INTO local_dataset_apps SELECT publication_id,'elsewhere','dataset',1,candidate,0,0 FROM local_collection_apps WHERE publication_id=?").run(again.publicationId);
    });
    expect(() => f.host.apps.has(again.publicationId)).toThrow(/Ambiguous/);
  });

  it("refuses requests with an unavailable engine without changing authority", async () => {
    const f = await fixture();
    f.engine.state.down = true;
    await expect(f.list()).rejects.toBeInstanceOf(LocalAppUnavailableError);
    f.engine.state.down = false;
    expect(f.host.apps.list("trip")[0]).toMatchObject({ active: true });
    const hash = createHash("sha256").update(schema).digest("hex");
    expect(f.prepared.candidate.capabilities[0]).toMatchObject({ schemaSha256: hash });
  });
});
