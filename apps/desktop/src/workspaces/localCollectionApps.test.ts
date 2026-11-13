import { createHash } from "node:crypto";
import { openedLocalState } from "../testing/preparedLocalState";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { compareAppCollectionPaths } from "@dohc/security-contract/app-collection-checks";
import { OwnerAppPublicationResult } from "@dohc/cli/app-publication";
import type { DatasetDefinition } from "@dohc/security-contract/dataset";
import type { MomentWriteAuthor } from "@dohc/workspace-contracts/engine";
import { sourceCaptureAdapter } from "../testing/sourceCaptureAdapter";
import { createDatasetFixtureCompiler } from "../testing/datasetFixtureCompiler";
import { compileClosedApp } from "./closedAppCompiler";
import { generateDatasetFormSources } from "./datasetFormGenerator";
import { generateDatasetSources } from "./datasetGenerator";
import { createLocalAppLaunchHost, LocalAppUnavailableError } from "./localAppLaunch";
import {
  MAX_LOCAL_COLLECTION_CREATES_PER_PUBLICATION,
  LocalCollectionRefusal,
  type Envelope,
  type LocalCollectionEngine,
} from "./localCollectionApps";
import { createLocalDatasetHost, type LocalDatasetHost } from "./localDatasetHost";
import { prepareLocalAppPublication } from "./ownerAppPublication";
import { unguardedCollections } from "../testing/collectionsHolder";

const compileFixture = createDatasetFixtureCompiler();
const schema =
  "version: 1\nfields:\n  name:\n    type: text\n  destination:\n    type: select\n    options: [Tokyo, Manila]\n  note:\n    type: text\n";
const person: MomentWriteAuthor = { kind: "human", humanId: "person-local" };
const roots: string[] = [],
  hosts: LocalDatasetHost[] = [];
afterEach(async () => {
  for (const host of hosts.splice(0)) await host.close();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
const signal = () => new AbortController().signal;
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

function fakeEngine() {
  const versions = new Map<string, Map<string, string>>([
    ["main", new Map([["trip/responses/collection.yaml", schema]])],
  ]);
  const moments = new Map<
    string,
    {
      workspaceId: string;
      versionId: string;
      objectId: string;
      path: string;
      operation: string;
      text: string;
    }
  >();
  // down: nothing answers. writeDown: writes fail before committing. failAfterCommit: the next write commits, then its answer is lost.
  // afterCommit: runs once a write commits, before the engine answers.
  const state = {
    active: "main",
    down: false,
    writeDown: false,
    lookupDown: false,
    hold: null as Promise<void> | null,
    readHold: null as Promise<void> | null,
    heldReads: 0,
    failAfterCommit: false,
    afterCommit: null as (() => void) | null,
    writes: [] as Envelope[],
  };
  const check = () => {
    if (state.down) throw new Error("The engine stopped.");
  };
  const api: LocalCollectionEngine = {
    async activeVersionId() {
      check();
      return state.active;
    },
    async listFiles({ versionId, folder, afterPath, limit }) {
      check();
      const paths = [...versions.get(versionId)!.keys()]
        .filter(
          (path) =>
            path.startsWith(folder + "/") &&
            (afterPath === undefined || compareAppCollectionPaths(path, afterPath) > 0),
        )
        .sort(compareAppCollectionPaths);
      return {
        files: paths.slice(0, limit).map((path) => ({
          path,
          contentKind: "text",
          byteLength: Buffer.byteLength(versions.get(versionId)!.get(path)!),
        })),
        more: paths.length > limit,
      };
    },
    async readText({ versionId, path }) {
      check();
      if (state.readHold && path.endsWith(".md")) {
        state.heldReads++;
        await state.readHold;
      }
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
      if (envelope.versionId !== state.active)
        throw new LocalCollectionRefusal("The saved version is no longer active.");
      const files = versions.get(envelope.versionId)!;
      if (files.has(envelope.path))
        throw new LocalCollectionRefusal(`File already exists: ${envelope.path}`);
      files.set(envelope.path, envelope.text);
      moments.set(envelope.momentId, {
        workspaceId: "w",
        versionId: envelope.versionId,
        objectId: `object-${moments.size}`,
        path: envelope.path,
        operation: "write",
        text: envelope.text,
      });
      state.afterCommit?.();
      if (state.failAfterCommit) {
        state.failAfterCommit = false;
        throw new Error("The engine connection closed.");
      }
      return { objectId: moments.get(envelope.momentId)!.objectId, momentId: envelope.momentId };
    },
    async moment(momentId) {
      if (state.lookupDown || state.down) throw new Error("The engine stopped.");
      return moments.get(momentId) ?? null;
    },
  };
  return {
    api,
    state,
    versions,
    moments,
    files: (versionId = state.active) => versions.get(versionId)!,
    fork(versionId: string) {
      versions.set(versionId, new Map(versions.get(state.active)));
    },
  };
}
type Engine = ReturnType<typeof fakeEngine>;

const definition: DatasetDefinition = {
  formatVersion: 1,
  datasetId: "00000000-0000-4000-8000-000000000001",
  name: "Trips",
  schemaPath: "data/schema.sql",
  operationsPath: "data/operations.js",
  tables: [
    {
      tableId: "00000000-0000-4000-8000-000000000002",
      name: "Responses",
      sqlName: "responses",
      primaryKey: "id",
      fields: [
        {
          fieldId: "00000000-0000-4000-8000-000000000003",
          name: "ID",
          sqlColumn: "id",
          type: "text",
          required: true,
          unique: true,
        },
        {
          fieldId: "00000000-0000-4000-8000-000000000004",
          name: "Name",
          sqlColumn: "name",
          type: "text",
          required: true,
          unique: false,
        },
      ],
    },
  ],
  operations: [
    {
      operationId: "00000000-0000-4000-8000-000000000006",
      name: "submit",
      label: "Submit",
      tableId: "00000000-0000-4000-8000-000000000002",
      kind: "create",
      access: "link",
      readOnly: false,
      fieldIds: ["00000000-0000-4000-8000-000000000004"],
    },
  ],
};

async function fixture(
  options: {
    workspaceRoot?: string;
    engine?: Engine;
    author?: (activated: boolean) => Promise<MomentWriteAuthor>;
    readFields?: string[];
  } = {},
) {
  const workspaceRoot =
    options.workspaceRoot ?? (await mkdtemp(join(tmpdir(), "dohc-collection-app-")));
  if (!options.workspaceRoot) roots.push(workspaceRoot);
  const engine = options.engine ?? fakeEngine();
  const open = async () => {
    // Workers and exports live in .dohc/local, which an engine open prepares.
    await openedLocalState({ workspaceId: "w", rootPath: workspaceRoot });
    const host = await createLocalDatasetHost({
      holder: unguardedCollections,
      localPersonId: () => "person-local",
      workspaceId: "w",
      workspaceRoot,
      capacityBytes: 1024 * 1024,
      compile: compileFixture,
      collectionEngine: () => {
        if (engine.state.down) throw new Error("The engine is not running.");
        return engine.api;
      },
      collectionAuthor: options.author ?? (async () => person),
    });
    hosts.push(host);
    return host;
  };
  const host = await open();
  const sources = new Map<string, string>([
    ["trip/main.ts", "document.body.textContent = 'Trip';"],
    ["trip/responses/collection.yaml", schema],
  ]);
  const collectionApp = (readFields = options.readFields ?? ["destination", "name"]) => {
    sources.set(
      "trip/app.publish.json",
      JSON.stringify({
        version: 1,
        entryPath: "main.ts",
        inputs: ["main.ts"],
        packageMap: {},
        collection: {
          kind: "collection-create",
          collectionPath: "responses",
          allowedFields: ["destination", "name"],
          requiredFields: ["destination"],
          readFields,
        },
      }),
    );
    return prepareLocalAppPublication(
      { workspaceId: "w", appRoot: "trip" },
      {
        deferredWrites: [],
        adapter: sourceCaptureAdapter(sources),
        compile: compileClosedApp,
        signal: signal(),
        assertCurrent() {},
      },
    );
  };
  const unconnectedApp = () => {
    sources.set(
      "trip/app.publish.json",
      JSON.stringify({ version: 1, entryPath: "main.ts", inputs: ["main.ts"], packageMap: {} }),
    );
    return prepareLocalAppPublication(
      { workspaceId: "w", appRoot: "trip" },
      {
        deferredWrites: [],
        adapter: sourceCaptureAdapter(sources),
        compile: compileClosedApp,
        signal: signal(),
        assertCurrent() {},
      },
    );
  };
  const prepared = await collectionApp();
  const published = await host.apps.activate(prepared, signal());
  const create = (
    fields: Record<string, unknown>,
    idempotencyKey = "response-1",
    target = host,
    revision = published.authorityRevision,
    activated?: boolean,
  ) =>
    target.apps.request(
      published.publicationId,
      "create",
      { authorityRevision: revision, idempotencyKey, fields },
      undefined,
      activated,
    ) as Promise<{
      kind: "accepted";
      acceptanceId: string;
      objectId: string;
      path: string;
      momentId: string;
      acceptedAtMs: number;
    }>;
  const list = (
    input: { limit: number; afterPath?: string } = { limit: 50 },
    target = host,
    revision = published.authorityRevision,
  ) =>
    target.apps.request(published.publicationId, "list", {
      authorityRevision: revision,
      ...input,
    }) as Promise<{
      records: Array<{ path: string; recordId: string | null; fields: Record<string, unknown> }>;
      nextPath: string | null;
    }>;
  const inspect = <T>(work: (db: DatabaseSync) => T) => {
    const db = new DatabaseSync(join(workspaceRoot, ".dohc/local/datasets/state.sqlite"));
    try {
      return work(db);
    } finally {
      db.close();
    }
  };
  let approvedDataset: Awaited<ReturnType<LocalDatasetHost["approve"]>> | undefined;
  const datasetApp = async (target: LocalDatasetHost) => {
    if (!approvedDataset) {
      for (const [path, source] of Object.entries(generateDatasetSources(definition).files))
        sources.set(path, source);
      sources.set("data/dataset.json", JSON.stringify(definition));
      const preparation = await target.prepare({
        descriptorPath: "data/dataset.json",
        adapter: sourceCaptureAdapter(sources),
      });
      approvedDataset = await target.approve({
        preparationId: preparation.preparationId,
        revisionSha256: preparation.revision.revisionSha256,
      });
    }
    const revision = approvedDataset;
    const form = generateDatasetFormSources({
      datasetPath: "data/dataset.json",
      approvedRevision: revision,
      tableId: definition.tables[0]!.tableId,
      createOperationId: definition.operations[0]!.operationId,
      appRoot: "trip",
      fieldIds: [definition.tables[0]!.fields[1]!.fieldId],
    });
    for (const [path, source] of Object.entries(form.files)) sources.set(`trip/${path}`, source);
    return prepareLocalAppPublication(
      { workspaceId: "w", appRoot: "trip" },
      {
        deferredWrites: [],
        adapter: sourceCaptureAdapter(sources),
        compile: compileClosedApp,
        signal: signal(),
        assertCurrent() {},
        async resolveDatasetRevision(binding) {
          return target.approvedArtifacts(binding.datasetId).revision;
        },
      },
    );
  };
  return {
    host,
    engine,
    workspaceRoot,
    open,
    prepared,
    published,
    collectionApp,
    unconnectedApp,
    datasetApp,
    create,
    list,
    inspect,
  };
}

describe("local document Collection apps", () => {
  it("reads approved fields from the published projection in UTF-8 byte order", async () => {
    const f = await fixture({ readFields: ["destination"] });
    const files = f.engine.files();
    const record = (fields: object) => `---\n${JSON.stringify(fields)}\n---\nbody`;
    files.set(
      "trip/responses/b.md",
      record({ destination: "Tokyo", name: "Secret", note: "hidden" }),
    );
    files.set("trip/responses/é.md", record({ destination: "Manila" }));
    files.set("trip/responses/\u{1f600}.md", record({ destination: "Tokyo" }));
    files.set("trip/responses/Ａ.md", record({ destination: "Manila" }));
    files.set("trip/responses/nested/c.md", record({ destination: "Tokyo" }));
    files.set("trip/responses/d.txt", record({ destination: "Tokyo" }));
    files.set("trip/responses/huge.md", record({ destination: "Tokyo", note: "x".repeat(17_000) }));
    files.set("trip/responses/wrong.md", record({ destination: "Paris" }));
    files.set("trip/other.md", record({ destination: "Tokyo" }));
    const all: Array<{ path: string; fields: Record<string, unknown> }> = [];
    let afterPath: string | undefined,
      pages = 0;
    do {
      const page = await f.list({ limit: 2, ...(afterPath === undefined ? {} : { afterPath }) });
      all.push(...page.records);
      afterPath = page.nextPath ?? undefined;
      pages++;
    } while (afterPath && pages < 20);
    expect(all.map((record) => record.path)).toEqual([
      "trip/responses/b.md",
      "trip/responses/é.md",
      "trip/responses/Ａ.md",
      "trip/responses/\u{1f600}.md",
    ]);
    expect(all.map((record) => record.fields)).toEqual([
      { destination: "Tokyo" },
      { destination: "Manila" },
      { destination: "Manila" },
      { destination: "Tokyo" },
    ]);
    await expect(f.list({ limit: 2, afterPath: "trip/other.md" })).rejects.toThrow(
      /Invalid collection page/,
    );
    await expect(f.list({ limit: 101 })).rejects.toThrow(/Invalid collection page/);
    files.set("trip/responses/collection.yaml", schema + "  extra:\n    type: text\n");
    await expect(f.list()).rejects.toThrow(/schema changed/);
  });

  it("refuses reads without approved read fields, foreign actions, and stale authority", async () => {
    const f = await fixture({ readFields: [] });
    await expect(f.list()).rejects.toThrow(/cannot read/);
    await expect(
      f.host.apps.request(f.published.publicationId, "invoke", {
        authorityRevision: f.published.authorityRevision,
        operation: "submit",
        idempotencyKey: "k",
        input: {},
      }),
    ).rejects.toThrow(/not approved/);
    await expect(
      f.host.apps.readBrowserFile(f.published.publicationId, {
        authorityRevision: f.published.authorityRevision,
        fileId: "f".repeat(16),
        operation: "x",
        input: {},
      }),
    ).rejects.toThrow(/cannot read/);
    await expect(f.list({ limit: 1 }, f.host, f.published.authorityRevision + 1)).rejects.toThrow(
      /approval changed/,
    );
  });

  it("validates creates against the pinned schema and approved fields", async () => {
    const f = await fixture();
    for (const [index, fields] of [
      { name: "No destination" },
      { destination: "Paris" },
      { destination: "Tokyo", note: "unapproved" },
      { destination: "Tokyo", created_by: "forged" },
      { destination: "Tokyo", name: { nested: true } },
      { destination: ["Tokyo"] },
    ].entries()) {
      await expect(f.create(fields, `invalid-${index}`)).rejects.toThrow(/collection/i);
    }
    await expect(
      f.host.apps.request(f.published.publicationId, "create", {
        authorityRevision: f.published.authorityRevision,
        idempotencyKey: "k",
        fields: { destination: "Tokyo" },
        path: "elsewhere.md",
      }),
    ).rejects.toThrow(/Invalid collection request/);
    await expect(
      f.host.apps.request(f.published.publicationId, "create", {
        authorityRevision: f.published.authorityRevision,
        idempotencyKey: "k",
        fields: { destination: "Tokyo" },
        activated: true,
      }),
    ).rejects.toThrow(/Invalid collection request/);
    expect(f.engine.state.writes).toEqual([]);
    f.inspect((db) =>
      expect(db.prepare("SELECT count(*) AS n FROM local_collection_creates").get()!.n).toBe(0),
    );
  });

  it("keeps a reservation through an engine outage and completes it on restart without a second write", async () => {
    const f = await fixture();
    f.engine.state.failAfterCommit = true;
    await expect(f.create({ destination: "Tokyo" })).rejects.toBeInstanceOf(
      LocalAppUnavailableError,
    );
    expect(f.host.apps.list("trip")[0]).toMatchObject({ pendingCreates: 1 });
    const createdAt = f.inspect((db) =>
      Number(db.prepare("SELECT created_at_ms FROM local_collection_creates").get()!.created_at_ms),
    );
    f.engine.state.down = true;
    await f.host.close();
    const restarted = await f.open();
    expect(restarted.apps.list("trip")[0]).toMatchObject({ pendingCreates: 1 });
    f.engine.state.down = false;
    f.engine.state.writes.length = 0;
    restarted.apps.reconcile();
    await expect.poll(() => restarted.apps.list("trip")[0]).toMatchObject({ pendingCreates: 0 });
    expect(f.engine.state.writes).toEqual([]);
    const receipt = await f.create({ destination: "Tokyo" }, "response-1", restarted);
    expect(receipt).toMatchObject({ acceptedAtMs: createdAt, objectId: "object-0" });
    expect([...f.engine.files().keys()].filter((path) => path.endsWith(".md"))).toEqual([
      receipt.path,
    ]);
  });

  it("keeps the lifetime response limit across withdrawal and reapproval", async () => {
    const f = await fixture();
    f.inspect((db) => {
      const insert = db.prepare("INSERT INTO local_collection_creates VALUES(?,?,?,?,NULL,?,?,1)");
      db.exec("BEGIN");
      for (let n = 0; n < MAX_LOCAL_COLLECTION_CREATES_PER_PUBLICATION - 1; n++)
        insert.run(
          f.published.publicationId,
          `seed-${n}`,
          "0".repeat(64),
          1,
          JSON.stringify({ kind: "notWritten", reason: "seed" }),
          0,
        );
      db.exec("COMMIT");
    });
    await f.create({ destination: "Tokyo" }, "last");
    await expect(f.create({ destination: "Tokyo" }, "over")).rejects.toThrow(/response limit/);
    expect(
      await f.host.apps.withdraw(f.published.publicationId, f.published.authorityRevision),
    ).toMatchObject({ kind: "withdrawn" });
    const again = await f.host.apps.activate(f.prepared, signal());
    expect(again.publicationId).toBe(f.published.publicationId);
    await expect(
      f.create({ destination: "Tokyo" }, "over", f.host, again.authorityRevision),
    ).rejects.toThrow(/response limit/);
  });

  it("reports an unconfirmed withdrawal while the engine is down and confirms it at the same revision later", async () => {
    const f = await fixture();
    f.engine.state.writeDown = true;
    await expect(f.create({ destination: "Tokyo" })).rejects.toBeInstanceOf(
      LocalAppUnavailableError,
    );
    f.engine.state.down = true;
    const unconfirmed = await f.host.apps.withdraw(
      f.published.publicationId,
      f.published.authorityRevision,
    );
    expect(unconfirmed).toEqual({
      kind: "withdrawalUnconfirmed",
      publicationId: f.published.publicationId,
      authorityRevision: f.published.authorityRevision + 1,
      unresolvedCreates: 1,
    });
    await expect(
      f.host.apps.withdraw(f.published.publicationId, f.published.authorityRevision),
    ).rejects.toThrow(/approval changed/);
    expect(
      await f.host.apps.withdraw(f.published.publicationId, unconfirmed.authorityRevision),
    ).toMatchObject({
      kind: "withdrawalUnconfirmed",
      authorityRevision: unconfirmed.authorityRevision,
    });
    expect(f.host.apps.list("trip")[0]).toMatchObject({
      approved: false,
      pendingCreates: 1,
      authorityRevision: unconfirmed.authorityRevision,
    });
    await f.host.close();
    const restarted = await f.open();
    expect(restarted.apps.list("trip")[0]).toMatchObject({ pendingCreates: 1 });
    f.engine.state.down = false;
    f.engine.state.writeDown = false;
    restarted.apps.reconcile();
    await expect.poll(() => restarted.apps.list("trip")[0]).toMatchObject({ pendingCreates: 0 });
    expect(
      await restarted.apps.withdraw(f.published.publicationId, unconfirmed.authorityRevision),
    ).toEqual({
      kind: "withdrawn",
      publicationId: f.published.publicationId,
      authorityRevision: unconfirmed.authorityRevision,
    });
    f.inspect((db) =>
      expect(
        db.prepare("SELECT revision FROM local_app_roots WHERE app_root='trip'").get()!.revision,
      ).toBe(unconfirmed.authorityRevision),
    );
  });

  it("charges Collection storage outside Dataset usage, so an older build refuses the store", async () => {
    const f = await fixture();
    await f.create({ destination: "Tokyo" });
    await f.host.close();
    f.inspect((db) => {
      const budget = Number(db.prepare("SELECT bytes FROM local_dataset_budget").get()!.bytes);
      const datasets = Number(
        db.prepare("SELECT coalesce(sum(bytes),0) AS bytes FROM local_dataset_usage").get()!.bytes,
      );
      const collections = Number(
        db.prepare("SELECT bytes FROM local_collection_app_usage").get()!.bytes,
      );
      const stored = Number(
        db
          .prepare(
            "SELECT (SELECT sum(storage_bytes) FROM local_collection_apps)+(SELECT sum(storage_bytes) FROM local_collection_creates) AS bytes",
          )
          .get()!.bytes,
      );
      expect(collections).toBe(stored);
      expect(budget).toBe(datasets + collections);
      expect(budget).not.toBe(datasets);
    });
    const reopened = await f.open();
    expect(reopened.apps.list("trip")[0]).toMatchObject({ active: true });
  });

  it("moves a root between kinds only by explicit replacement, refusing each earlier session", async () => {
    const f = await fixture();
    const sessionA = f.published;
    const datasetB = await f.host.apps.activate(await f.datasetApp(f.host), signal());
    expect(() =>
      f.host.apps.assertBrowserPublication(sessionA.publicationId, sessionA.authorityRevision),
    ).toThrow(/approval changed/);
    await expect(
      f.host.apps.request(datasetB.publicationId, "list", {
        authorityRevision: datasetB.authorityRevision,
        limit: 1,
      }),
    ).rejects.toThrow(/document Collection/);
    expect(f.host.apps.list("trip").map((row) => [row.publicationId, row.approved])).toEqual(
      expect.arrayContaining([
        [sessionA.publicationId, false],
        [datasetB.publicationId, true],
      ]),
    );
    const collectionA = await f.host.apps.activate(await f.collectionApp(), signal());
    expect(collectionA.publicationId).toBe(sessionA.publicationId);
    expect(collectionA.authorityRevision).toBeGreaterThan(datasetB.authorityRevision);
    expect(() =>
      f.host.apps.assertBrowserPublication(sessionA.publicationId, sessionA.authorityRevision),
    ).toThrow(/approval changed/);
    expect(() =>
      f.host.apps.assertBrowserPublication(datasetB.publicationId, datasetB.authorityRevision),
    ).toThrow(/approval changed/);
    f.inspect((db) =>
      expect(
        db
          .prepare("SELECT count(*) AS n FROM dohc_dataset_bindings WHERE app_id=?")
          .get(datasetB.publicationId)!.n,
      ).toBe(0),
    );
    await f.host.close();
    f.inspect((db) =>
      db
        .prepare("UPDATE local_dataset_apps SET active=1 WHERE publication_id=?")
        .run(datasetB.publicationId),
    );
    const reopened = await f.open();
    expect(() =>
      reopened.apps.assertBrowserPublication(
        collectionA.publicationId,
        collectionA.authorityRevision,
      ),
    ).not.toThrow();
    const datasetA = await reopened.apps.activate(await f.datasetApp(reopened), signal());
    const collectionB = await reopened.apps.activate(
      await f.collectionApp(["destination"]),
      signal(),
    );
    const datasetAgain = await reopened.apps.activate(await f.datasetApp(reopened), signal());
    expect(datasetAgain.publicationId).toBe(datasetA.publicationId);
    expect(() =>
      reopened.apps.assertBrowserPublication(datasetA.publicationId, datasetA.authorityRevision),
    ).toThrow(/approval changed/);
    expect(() =>
      reopened.apps.assertBrowserPublication(
        collectionB.publicationId,
        collectionB.authorityRevision,
      ),
    ).toThrow(/approval changed/);
    await reopened.close();
    const again = await f.open();
    expect(() =>
      again.apps.assertBrowserPublication(
        datasetAgain.publicationId,
        datasetAgain.authorityRevision,
      ),
    ).not.toThrow();
  });

  it("runs a Collection app through its loopback launch without a share link", async () => {
    const f = await fixture(),
      lifetime = new AbortController();
    const launcher = await createLocalAppLaunchHost({
      backend: f.host.apps,
      lifetime: lifetime.signal,
    });
    try {
      const url = new URL(await launcher.launch(f.published.publicationId, signal())),
        origin = url.origin;
      const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
        fetch(origin + path, {
          method: "POST",
          headers: { origin, "content-type": "application/json", ...headers },
          body: JSON.stringify(body),
        });
      const { proof } = (await (await post("/session", { handoff: url.hash.slice(1) })).json()) as {
        proof: string;
      };
      const backend = (body: unknown) => post("/backend", body, { "x-dohc-app-proof": proof });
      const created = await backend({
        id: "create",
        op: "collection.create",
        idempotencyKey: "trip-1",
        fields: { destination: "Manila", name: "Bo" },
      });
      expect(created.status).toBe(200);
      const receipt = (await created.json()) as { path: string };
      const page = await (await backend({ id: "list", op: "collection.list", limit: 10 })).json();
      expect(page).toEqual({
        records: [
          {
            path: receipt.path,
            recordId: expect.stringMatching(/^rec_/),
            fields: { destination: "Manila", name: "Bo" },
          },
        ],
        nextPath: null,
      });
      expect(
        (
          await backend({
            id: "invoke",
            op: "backend.invoke",
            operation: "submit",
            idempotencyKey: "k",
            input: {},
          })
        ).status,
      ).toBe(404);
      f.engine.state.down = true;
      expect((await backend({ id: "list", op: "collection.list", limit: 10 })).status).toBe(503);
      f.engine.state.down = false;
      await f.host.apps.withdraw(f.published.publicationId, f.published.authorityRevision);
      expect((await backend({ id: "list", op: "collection.list", limit: 10 })).status).toBe(404);
    } finally {
      lifetime.abort();
      await launcher.close();
    }
  });

  it("runs an app that reaches no workspace data on this device, refusing its every data request", async () => {
    const f = await fixture(),
      lifetime = new AbortController();
    const agent = { kind: "agent", label: "Builder", labelSource: "agent-declared" } as const;
    const prepared = await f.unconnectedApp();
    expect(prepared.candidate.capabilities).toEqual([]);
    const app = await f.host.apps.activate(prepared, signal(), agent);
    expect(app.authorityRevision).toBeGreaterThan(f.published.authorityRevision);
    expect(() =>
      f.host.apps.assertBrowserPublication(
        f.published.publicationId,
        f.published.authorityRevision,
      ),
    ).toThrow(/approval changed/);
    const listed = f.host.apps.list("trip");
    expect(listed).toEqual(
      expect.arrayContaining([
        {
          publicationId: app.publicationId,
          authorityRevision: app.authorityRevision,
          appRoot: "trip",
          sourceRevision: prepared.candidate.sourceRevision,
          approved: true,
          active: true,
        },
        expect.objectContaining({
          publicationId: f.published.publicationId,
          approved: false,
          active: false,
        }),
      ]),
    );
    expect(OwnerAppPublicationResult.parse({ kind: "localListed", publications: listed })).toEqual({
      kind: "localListed",
      publications: listed,
    });
    f.inspect((db) => {
      expect(
        db
          .prepare(
            "SELECT revision,active_kind,active_publication_id FROM local_app_roots WHERE app_root='trip'",
          )
          .get(),
      ).toEqual({
        revision: app.authorityRevision,
        active_kind: "unconnected",
        active_publication_id: app.publicationId,
      });
      const provenance = JSON.parse(
        String(
          db
            .prepare("SELECT provenance FROM local_app_approval_provenance WHERE publication_id=?")
            .get(app.publicationId)!.provenance,
        ),
      );
      expect(provenance).toEqual({
        agent,
        committedCandidateDigest: createHash("sha256")
          .update(JSON.stringify(prepared.candidate))
          .digest("hex"),
        sourceRevision: prepared.candidate.sourceRevision,
        capabilities: [],
      });
    });
    for (const action of ["invoke", "upload", "attempt", "list", "create"] as const)
      await expect(
        f.host.apps.request(app.publicationId, action, {
          authorityRevision: app.authorityRevision,
        }),
      ).rejects.toThrow(/not approved for workspace data/);
    await expect(
      f.host.apps.readBrowserFile(app.publicationId, {
        authorityRevision: app.authorityRevision,
        fileId: "a".repeat(16),
        operation: "read",
        input: {},
      }),
    ).rejects.toThrow(/cannot read/);
    const launcher = await createLocalAppLaunchHost({
      backend: f.host.apps,
      lifetime: lifetime.signal,
    });
    try {
      const url = new URL(await launcher.launch(app.publicationId, signal())),
        origin = url.origin;
      const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
        fetch(origin + path, {
          method: "POST",
          headers: { origin, "content-type": "application/json", ...headers },
          body: JSON.stringify(body),
        });
      const session = await post("/session", { handoff: url.hash.slice(1) });
      expect(session.status).toBe(200);
      const { proof, html } = (await session.json()) as { proof: string; html: string };
      expect(html).toContain("Trip");
      const proven = (path: string, body: unknown) =>
        post(path, body, { "x-dohc-app-proof": proof });
      expect(
        (await proven("/backend", { id: "list", op: "collection.list", limit: 10 })).status,
      ).toBe(404);
      expect(
        (
          await proven("/backend", {
            id: "create",
            op: "collection.create",
            idempotencyKey: "trip-1",
            fields: { destination: "Manila" },
          })
        ).status,
      ).toBe(404);
      expect(
        (
          await proven("/backend", {
            id: "invoke",
            op: "backend.invoke",
            operation: "submit",
            idempotencyKey: "k",
            input: {},
          })
        ).status,
      ).toBe(404);
      expect(f.engine.state.writes).toEqual([]);
      expect((await proven("/resume", {})).status).toBe(200);
      const collection = await f.host.apps.activate(await f.collectionApp(), signal());
      expect(
        await proven("/resume", {}).then(
          (response) => response.status === 200,
          () => false,
        ),
      ).toBe(false);
      expect(() =>
        f.host.apps.assertBrowserPublication(app.publicationId, app.authorityRevision),
      ).toThrow(/approval changed/);
      expect(f.host.apps.list("trip")).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            publicationId: collection.publicationId,
            approved: true,
            active: true,
            collectionCapability: expect.objectContaining({ collectionPath: "trip/responses" }),
          }),
          expect.objectContaining({
            publicationId: app.publicationId,
            approved: false,
            active: false,
          }),
        ]),
      );
    } finally {
      lifetime.abort();
      await launcher.close();
    }
    const again = await f.host.apps.activate(await f.unconnectedApp(), signal());
    expect(again.publicationId).toBe(app.publicationId);
    expect(await f.host.apps.withdraw(again.publicationId, again.authorityRevision)).toEqual({
      kind: "withdrawn",
      publicationId: again.publicationId,
      authorityRevision: again.authorityRevision + 1,
    });
    expect(() => f.host.apps.browserPublication(again.publicationId)).toThrow(/approval changed/);
    await f.host.close();
    f.inspect((db) => {
      expect(
        db
          .prepare(
            "SELECT revision,active_kind,active_publication_id FROM local_app_roots WHERE app_root='trip'",
          )
          .get(),
      ).toEqual({
        revision: again.authorityRevision + 1,
        active_kind: null,
        active_publication_id: null,
      });
      const stored = Number(
        db
          .prepare(
            "SELECT coalesce((SELECT sum(storage_bytes) FROM local_collection_apps),0)+coalesce((SELECT sum(storage_bytes) FROM local_unconnected_apps),0)+coalesce((SELECT sum(storage_bytes) FROM local_collection_creates),0) AS bytes",
          )
          .get()!.bytes,
      );
      expect(Number(db.prepare("SELECT bytes FROM local_collection_app_usage").get()!.bytes)).toBe(
        stored,
      );
      expect(db.prepare("SELECT count(*) AS n FROM local_unconnected_apps").get()!.n).toBe(1);
    });
    const reopened = await f.open();
    expect(reopened.apps.list("trip")).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          publicationId: app.publicationId,
          approved: false,
          active: false,
        }),
      ]),
    );
  });

  it("refuses to deliver a read that was queued when the approval ended", async () => {
    const f = await fixture();
    await f.create({ destination: "Tokyo" });
    const gate = deferred();
    f.engine.state.readHold = gate.promise;
    const read = f.list().catch((error: unknown) => error);
    await expect.poll(() => f.engine.state.heldReads).toBe(1);
    await f.host.apps.withdraw(f.published.publicationId, f.published.authorityRevision);
    gate.resolve();
    expect(await read).toMatchObject({ name: "AbortError" });
    // Without the abort, the read still rechecks the approval before it answers.
    const again = await f.host.apps.activate(f.prepared, signal());
    const late = deferred();
    f.engine.state.readHold = late.promise;
    const queued = f
      .list({ limit: 50 }, f.host, again.authorityRevision)
      .catch((error: unknown) => error);
    await expect.poll(() => f.engine.state.heldReads).toBe(2);
    f.inspect((db) =>
      db.prepare("UPDATE local_app_roots SET revision=revision+1 WHERE app_root='trip'").run(),
    );
    late.resolve();
    expect(String(await queued)).toMatch(/approval changed/);
  });

  it("gives no receipt to a request whose approval ended or that was aborted, even once its write committed", async () => {
    const f = await fixture();
    f.engine.state.afterCommit = () => {
      f.engine.state.afterCommit = null;
      f.inspect((db) =>
        db.prepare("UPDATE local_app_roots SET revision=revision+1 WHERE app_root='trip'").run(),
      );
    };
    await expect(f.create({ destination: "Tokyo" })).rejects.toThrow(/approval changed/);
    expect(f.engine.moments.size).toBe(1);
    f.inspect((db) =>
      expect(
        db
          .prepare("SELECT json_extract(outcome,'$.kind') AS kind FROM local_collection_creates")
          .get()!.kind,
      ).toBe("accepted"),
    );
    const again = await f.host.apps.activate(f.prepared, signal());
    const receipt = await f.create(
      { destination: "Tokyo" },
      "aborted",
      f.host,
      again.authorityRevision,
    );
    const aborted = new AbortController();
    aborted.abort();
    await expect(
      f.host.apps.request(
        f.published.publicationId,
        "create",
        {
          authorityRevision: again.authorityRevision,
          idempotencyKey: "aborted",
          fields: { destination: "Tokyo" },
        },
        aborted.signal,
      ),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(
      await f.create({ destination: "Tokyo" }, "aborted", f.host, again.authorityRevision),
    ).toEqual(receipt);
  });

  it("refuses new work as soon as close begins while an admitted response still records its outcome", async () => {
    const f = await fixture();
    const gate = deferred();
    f.engine.state.hold = gate.promise;
    void f.create({ destination: "Tokyo" }).catch(() => undefined);
    await expect.poll(() => f.engine.state.writes.length).toBe(1);
    const closing = f.host.close();
    expect(() => f.host.list()).toThrow(/session ended/);
    expect(() => f.host.apps.list("trip")).toThrow(/session ended/);
    await expect(
      f.host.apps.withdraw(f.published.publicationId, f.published.authorityRevision),
    ).rejects.toThrow(/session ended/);
    await expect(f.host.apps.activate(f.prepared, signal())).rejects.toThrow(/session ended/);
    gate.resolve();
    await closing;
    f.inspect((db) =>
      expect(
        db
          .prepare(
            "SELECT envelope IS NULL AS settled, json_extract(outcome,'$.kind') AS kind FROM local_collection_creates",
          )
          .get(),
      ).toEqual({ settled: 1, kind: "accepted" }),
    );
  });

  it("refuses a publication ID stored for both kinds and records Collection approval provenance", async () => {
    const f = await fixture();
    const agent = { kind: "agent", label: "Builder", labelSource: "agent-declared" } as const;
    await f.host.apps.withdraw(f.published.publicationId, f.published.authorityRevision);
    const again = await f.host.apps.activate(f.prepared, signal(), agent);
    f.inspect((db) => {
      const provenance = JSON.parse(
        String(
          db
            .prepare("SELECT provenance FROM local_app_approval_provenance WHERE publication_id=?")
            .get(again.publicationId)!.provenance,
        ),
      );
      expect(provenance).toEqual({
        agent,
        committedCandidateDigest: createHash("sha256")
          .update(JSON.stringify(f.prepared.candidate))
          .digest("hex"),
        sourceRevision: f.prepared.candidate.sourceRevision,
        capabilities: f.prepared.candidate.capabilities,
      });
      db.prepare(
        "INSERT INTO local_dataset_apps SELECT publication_id,'elsewhere','dataset',1,candidate,0,0 FROM local_collection_apps WHERE publication_id=?",
      ).run(again.publicationId);
    });
    expect(() => f.host.apps.has(again.publicationId)).toThrow(/Ambiguous/);
  });
});
