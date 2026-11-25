import { mkdir, mkdtemp, rm, truncate, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, it, vi } from "vitest";
import { serveFetchHandler } from "@dohc/service-http";
import { describeDatasetRevision } from "@dohc/security-contract/dataset-artifacts";
import type { DatasetDefinition } from "@dohc/security-contract/dataset";
import { fixture, limits } from "../../../../services/sync-relay/src/datasetTestFixture";
import { createSyncRelayHandler } from "../../../../services/sync-relay/src/server";
import { sourceCaptureAdapter } from "../testing/sourceCaptureAdapter";
import { createOwnerAppPublicationHandler } from "../ipc/ownerAppPublicationIpc";
import { OwnerAppPublicationResult } from "../ipc/ownerAppPublicationContract";
import { compileClosedApp } from "./closedAppCompiler";
import { createLocalAppLaunchHost } from "./localAppLaunch";
import { createNamedDatasetData } from "./namedDataset";
import { createPersonalAppPublication, createPersonalApps, personalAppEdits } from "./personalApps";
import type { CloudCredentials } from "./cloudCredentialStore";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function collection(n: number, name: string, folder: string): DatasetDefinition {
  return {
    formatVersion: 1,
    datasetId: id(n),
    name,
    schemaPath: `${folder}/schema.sql`,
    operationsPath: `${folder}/actions.js`,
    tables: [
      {
        tableId: id(n + 1),
        name,
        sqlName: "trips",
        primaryKey: "id",
        fields: [
          {
            fieldId: id(n + 2),
            name: "ID",
            sqlColumn: "id",
            type: "text",
            required: true,
            unique: true,
          },
          {
            fieldId: id(n + 3),
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
      ["read", "helper", true],
      ["edit", "helper", false],
      ["audit", "owner", true],
      ["remove", "helper", false],
    ].map(([operation, access, readOnly], index) => ({
      operationId: id(n + 4 + index),
      name: operation as string,
      label: operation as string,
      tableId: id(n + 1),
      kind: readOnly ? ("read" as const) : ("edit" as const),
      access: access as "helper" | "owner",
      readOnly: readOnly as boolean,
      fieldIds: readOnly ? [id(n + 2), id(n + 3)] : [id(n + 3)],
    })),
  };
}

async function memberWorkspace() {
  const f = fixture(),
    directory = await mkdtemp(join(tmpdir(), "personal-apps-"));
  cleanups.push(() => rm(directory, { recursive: true, force: true, maxRetries: 3 }));
  const host = await f.storage.createDatasetHost({
    publicEditRelease: undefined,
    directory: join(directory, "host"),
    limits,
    onShutdownError(error) {
      throw error;
    },
  });
  cleanups.push(() => host.close());
  const actor = { kind: "named" as const, workspaceId: "w", userId: "owner" };
  const schemaSql = `CREATE TABLE trips(id TEXT PRIMARY KEY NOT NULL,name TEXT NOT NULL);
    INSERT INTO trips VALUES('a','Kyoto');`;
  const operationSource = `globalThis.operations={read(ctx){const rows=ctx.db.query('SELECT id,name FROM trips ORDER BY id');return {rows,count:rows.length,nextCursor:null};},edit(){return null;},remove(){return null;},audit(){return {rows:[],count:0,nextCursor:null};}};`;
  const trips = collection(1, "Trips", "trips"),
    budget = collection(21, "Budget", "budget");
  const revisions = [trips, budget].map((definition) =>
    describeDatasetRevision({ definition, revision: 1, schemaSql, operationSource }),
  );
  for (const revision of revisions)
    await host.activate(actor, { workspaceId: "w", revision, schemaSql, operationSource });
  f.storage.tx(() =>
    f.storage.db
      .prepare(`INSERT INTO sync_relay_share_grants(grant_id,share_id,principal_kind,principal_user_id,principal_email,access,generation,status,created_at_ms,revoked_at_ms,parent_grant_id)
        VALUES('ana-grant','s','user','ana',NULL,'edit',1,'active',1,NULL,NULL)`)
      .run(),
  );
  host.setDataGrant(actor, {
    workspaceId: "w",
    datasetId: trips.datasetId,
    grantId: "ana-grant",
    grant: {
      revision: 1,
      revisionSha256: revisions[0]!.revisionSha256,
      operationIds: [id(5), id(6)],
      discover: true,
    },
  });
  const server = serveFetchHandler({
    handler: createSyncRelayHandler({
      storage: f.storage,
      datasetHost: host,
      nowMs: () => 10,
      resolveActor(request, workspaceId) {
        if (request.headers.get("authorization") !== "Bearer ana") throw Error("Unknown account");
        return { workspaceId, userId: "ana" };
      },
    }),
    maxBodyBytes: () => 1024 * 1024,
    oversized: () => new Response(null, { status: 413 }),
    failure: () => new Response(null, { status: 500 }),
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(
    () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  );
  const address = server.address();
  if (!address || typeof address === "string") throw Error("No server address");
  const origin = `http://127.0.0.1:${address.port}`;
  const credentials: CloudCredentials = {
    serverUrl: origin,
    relayUrl: origin,
    userId: "ana",
    token: "ana",
    email: "ana@example.test",
  };
  const shareView = {
    shareId: "s",
    recipientUserId: "ana",
    relayUrl: origin,
    grantedSelector: {
      paths: [] as string[],
      versionId: null,
      access: "edit",
      wholeWorkspace: true as boolean | undefined,
    },
    role: "member",
    reach: undefined as unknown,
  };
  const workspace = { workspaceId: "local", shareView };
  const data = () =>
    createNamedDatasetData({
      workspaceId: "local",
      shareView,
      credentials,
      signal: new AbortController().signal,
      credentialGeneration: 1,
      currentCredentialGeneration: () => 1,
      assertCurrent() {},
      async relayJson(account, path, init) {
        const response = await fetch(`${origin}${path}`, {
          ...init,
          headers: {
            ...(init.headers as Record<string, string>),
            authorization: `Bearer ${account.token}`,
          },
        });
        const body: unknown = await response.json().catch(() => null);
        if (!response.ok) throw new Error(`The relay refused: ${JSON.stringify(body)}`);
        return body;
      },
    });
  const synced: string[] = [];
  const adapter = sourceCaptureAdapter(
    new Map([
      ["trips/dataset.json", JSON.stringify(trips)],
      ["budget/dataset.json", JSON.stringify(budget)],
    ]),
    {
      workspaceId: "local",
      onRequest(_method, params) {
        if (Array.isArray(params.paths)) synced.push(...(params.paths as string[]));
      },
    },
  );
  const lifetime = new AbortController();
  cleanups.push(async () => lifetime.abort());
  const apps = createPersonalApps({
    workspaceId: "local",
    databasePath: join(directory, "local.approvals.sqlite"),
    lifetime: lifetime.signal,
    data: async () => data(),
    edits: async (datasetId) =>
      personalAppEdits(
        shareView,
        datasetId === id(1) ? "trips/dataset.json" : "budget/dataset.json",
      ),
  });
  cleanups.push(() => apps.close());
  const launcher = await createLocalAppLaunchHost({
    backend: apps.backend,
    lifetime: lifetime.signal,
  });
  const operation = {
    workspace,
    signal: lifetime.signal,
    assertCurrent() {},
  };
  const localPublication = vi.fn(async () => null);
  const openFolder = vi.fn(async () => {});
  const publish = createOwnerAppPublicationHandler<string, typeof workspace, typeof operation>({
    callerKey: (caller) => caller,
    withWorkspaceOperation: (_caller, _workspaceId, work) => work(operation),
    remoteForWorkspace: vi.fn(async () => {
      throw new Error("The owner's server is not for members.");
    }),
    currentCredentialGeneration: () => 1,
    flushCapture: async () => ({ deferredWrites: [] }),
    withAdapter: async (_workspace, work) => work(adapter),
    compile: (request) => compileClosedApp(request),
    relayJson: vi.fn(),
    relayJsonOrUnavailable: vi.fn(),
    upload: vi.fn(),
    localPublication,
    personalPublication: createPersonalAppPublication<typeof workspace, typeof operation>({
      stateDir: () => directory,
      hostFor: async () => ({ apps, launcher }),
      data: async () => data(),
      withAdapter: async (_workspace, work) => work(adapter),
      compile: (request) => compileClosedApp(request),
      openFolder,
    }),
  });
  const invoke = async (request: Record<string, unknown>) =>
    OwnerAppPublicationResult.parse(
      await publish("ana-cli", { workspaceId: "local", ...request }, null),
    );
  const writeApp = async (appRoot: string, dataset: Record<string, unknown>) => {
    const folder = await invoke({ action: "personalFolder" });
    if (folder.kind !== "personalFolder") throw new Error("No Personal app folder");
    await mkdir(join(folder.path, appRoot), { recursive: true });
    await writeFile(
      join(folder.path, appRoot, "app.publish.json"),
      JSON.stringify({
        version: 1,
        entryPath: "main.ts",
        inputs: ["main.ts"],
        packageMap: {},
        dataset: { kind: "dataset", datasetPath: "trips/dataset.json", ...dataset },
      }),
    );
    await writeFile(join(folder.path, appRoot, "main.ts"), "document.body.textContent = 'trip';");
    return folder.path;
  };
  const approve = async (appRoot: string) => {
    const prepared = await invoke({ action: "prepareLocal", appRoot });
    if (prepared.kind !== "prepared") throw new Error("Not prepared");
    const published = await invoke({
      action: "approve",
      approvalId: prepared.approvalId,
      candidateDigest: prepared.candidateDigest,
    });
    if (published.kind !== "published") throw new Error("Not approved");
    return { prepared, publicationId: published.publicationId };
  };
  return {
    f,
    directory,
    shareView,
    apps,
    synced,
    invoke,
    writeApp,
    approve,
    localPublication,
    openFolder,
  };
}

it("lets a member compile, approve, and launch a Personal app that runs a granted action as them", async () => {
  const m = await memberWorkspace();
  const folder = await m.writeApp("trip", { operations: ["read"] });
  expect(folder).toBe(join(m.directory, "personal-apps", "local"));
  expect(await m.invoke({ action: "personalFolder" })).toEqual({
    kind: "personalFolder",
    path: folder,
    apps: [{ appRoot: "trip" }],
  });
  expect(m.openFolder).not.toHaveBeenCalled();
  await m.invoke({ action: "personalFolder", open: true });
  expect(m.openFolder).toHaveBeenCalledExactlyOnceWith(folder);
  await writeFile(join(folder, "trip", "clip.mp4"), "");
  await truncate(join(folder, "trip", "clip.mp4"), 129 * 1024 * 1024);
  const { prepared, publicationId } = await m.approve("trip");
  expect(prepared.sourcePaths).toEqual(["trip/app.publish.json", "trip/main.ts"]);
  expect(prepared.capabilities).toEqual([
    expect.objectContaining({
      datasetId: id(1),
      operations: [{ operationId: id(5), name: "read", access: "helper", readOnly: true }],
    }),
  ]);
  expect(m.synced.some((path) => path.startsWith("trip/"))).toBe(false);
  expect(await m.invoke({ action: "listLocal", appRoot: "trip" })).toMatchObject({
    kind: "localListed",
    publications: [{ publicationId, active: true }],
  });
  const launched = await m.invoke({ action: "launchLocal", publicationId });
  if (launched.kind !== "localLaunched") throw new Error("Not launched");
  const url = new URL(launched.url);
  const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
    fetch(url.origin + path, {
      method: "POST",
      headers: { origin: url.origin, "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    });
  const session = (await (await post("/session", { handoff: url.hash.slice(1) })).json()) as {
    proof: string;
  };
  const read = await post(
    "/backend",
    { id: "one", op: "backend.invoke", operation: "read", idempotencyKey: "read-1", input: {} },
    { "x-dohc-app-proof": session.proof },
  );
  expect(read.status).toBe(200);
  expect(await read.json()).toMatchObject({
    result: { rows: [{ id: "a", name: "Kyoto" }], count: 1 },
  });
  expect(m.localPublication).not.toHaveBeenCalled();
}, 60_000);

it("refuses a Personal app actions the member's grant does not show, owner actions, linkReads, and hidden Collections", async () => {
  const m = await memberWorkspace();
  for (const [appRoot, dataset, refusal] of [
    ["ungranted", { operations: ["remove"] }, /remove is not an action you can use in Trips/],
    ["owner", { operations: ["audit"] }, /audit is not an action you can use in Trips/],
    [
      "links",
      { operationIds: [id(5)], linkReads: [{ operationId: id(5), fieldIds: [id(4)] }] },
      /cannot use linkReads/,
    ],
    ["hidden", { datasetPath: "budget/dataset.json", operations: ["read"] }, /not found/],
  ] as const) {
    await m.writeApp(appRoot, dataset);
    await expect(m.invoke({ action: "prepareLocal", appRoot })).rejects.toThrow(refusal);
  }
  await m.writeApp("trip", { operations: ["read"] });
  const { publicationId } = await m.approve("trip");
  const request = async (operation: string) =>
    m.apps.backend.request(publicationId, "invoke", {
      authorityRevision: 1,
      operation,
      input: {},
      idempotencyKey: operation,
    });
  await expect(request("edit")).rejects.toThrow("This action is not approved for the app.");
  await expect(request("read")).resolves.toMatchObject({ result: { count: 1 } });
  m.f.storage.tx(() =>
    m.f.storage.db
      .prepare(
        "UPDATE sync_relay_share_grants SET status='revoked',revoked_at_ms=20 WHERE grant_id='ana-grant'",
      )
      .run(),
  );
  await expect(request("read")).rejects.toThrow("The owner removed your access.");
}, 60_000);

it("runs only read-only actions in a Personal app while the member can only view the Collection's folder", async () => {
  const m = await memberWorkspace();
  const viewOnly = {
    signature: "s1",
    visibilitySignature: "v1",
    rootLevel: "edit",
    folders: [{ path: "trips", level: "view" }],
    groupDefault: "edit",
    groups: [],
  };
  m.shareView.reach = viewOnly;
  await m.writeApp("trip", { operations: ["read", "edit"] });
  await expect(m.invoke({ action: "prepareLocal", appRoot: "trip" })).rejects.toThrow(
    /edit changes records, and you can only view Trips/,
  );
  m.shareView.reach = undefined;
  const { publicationId } = await m.approve("trip");
  m.shareView.reach = viewOnly;
  const request = async (operation: string) =>
    m.apps.backend.request(publicationId, "invoke", {
      authorityRevision: 1,
      operation,
      input: {},
      idempotencyKey: operation,
    });
  await expect(request("edit")).rejects.toThrow("You can only view Trips now");
  await expect(request("read")).resolves.toMatchObject({ result: { count: 1 } });
}, 60_000);

it("keeps the owner's publishing actions refused in a joined workspace, and Personal apps to members", async () => {
  const m = await memberWorkspace();
  const hash = "a".repeat(64);
  for (const request of [
    { action: "stage", appRoot: "trip" },
    { action: "approveStaged", stageId: id(90), reviewDigest: hash },
    { action: "createLink", appRoot: "trip", operationId: id(91) },
    { action: "prepare", appRoot: "trip", shareId: "s", grantId: "ana-grant" },
    { action: "approve", approvalId: id(92), candidateDigest: hash },
    { action: "verifyFrontend", appRoot: "trip" },
    { action: "revokeCollection", publicationId: hash, expectedAuthorityRevision: 1 },
  ])
    await expect(m.invoke(request)).rejects.toThrow("Only the original workspace");
  m.shareView.grantedSelector = {
    paths: ["trips"],
    versionId: null,
    access: "edit",
    wholeWorkspace: undefined,
  };
  await expect(m.invoke({ action: "personalFolder" })).rejects.toThrow(
    "Only the original workspace",
  );
  expect(m.localPublication).not.toHaveBeenCalled();
});
