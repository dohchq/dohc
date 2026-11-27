import { createHash, randomBytes } from "node:crypto";
import { mkdir } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import {
  foldScene,
  insertElementRevision,
  stableJson,
  type ElementSnapshot,
} from "@dohc/excalidraw-scene";
import { serveFetchHandler } from "@dohc/service-http";
import {
  UnauthorizedError,
  type ResolveAccountSession,
  type ResolveActor,
} from "@dohc/workspace-auth/session";
import {
  VersionedLiveAdapter,
  openEngineYdocProviderSession,
  type JsonValue,
} from "@dohc/workspace-engine-client";
import { createEngineClient } from "@dohc/workspace-engine-client/daemon";
import * as Y from "yjs";
import { requireEngineBinaryOrSkip } from "../../../apps/desktop/src/testing/engineBinary";
import {
  AUTOMATION_REPLICA_BEARER_PREFIX,
  authorizeAutomationReplication,
  deriveAutomationReplicaBearer,
} from "./automationReplicaCredential";
import type { AutomationReplica } from "./automationReplicas";
import { DiscussionActivityHub } from "./discussionActivity";
import { createSyncRelayHandler, streamsRequestBody } from "./server";
import { startServerCopies, type ServerCopies } from "./serverCopies";
import { createServiceHostReplication } from "./serviceHostReplication";
import {
  ServiceOrdinaryReplication,
  type ServiceOrdinaryReplicationConfig,
} from "./serviceOrdinaryReplication";
import type { StorageContext } from "./storage/context";
import { closeTestStorages, tempRoot, testStorage } from "./testing";

const engine = requireEngineBinaryOrSkip();
const WORKSPACE = "workspace-sketches";
const DEADLINE_MS = 30_000;
const RELAY_ORIGIN = "https://relay.example.test";
const PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
const PNG_BYTES = Buffer.from(PNG_BASE64, "base64");
const PNG_SHA256 = createHash("sha256").update(PNG_BYTES).digest("hex");
const PNG_DATA_URL = `data:image/png;base64,${PNG_BASE64}`;

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
  await closeTestStorages();
});

const testActor: ResolveActor = (request, workspaceId) => {
  const match = /^Bearer test:([A-Za-z0-9_.:-]+)$/u.exec(
    request.headers.get("authorization") ?? "",
  );
  if (!match) throw new UnauthorizedError();
  return { userId: match[1]!, workspaceId };
};

const resolveAccountSession: ResolveAccountSession = async (request) => {
  const match = /^Bearer session:([\w-]+)$/u.exec(request.headers.get("authorization") ?? "");
  if (!match) throw new UnauthorizedError();
  return {
    userId: match[1]!,
    sessionId: `phone-${match[1]!}`,
    expiresAtMs: Number.MAX_SAFE_INTEGER,
    clientKind: "phone",
  };
};

function rect(
  id: string,
  version: number,
  versionNonce: number,
  extra: Partial<ElementSnapshot> = {},
): ElementSnapshot {
  return {
    id,
    type: "rectangle",
    x: 10,
    y: 20,
    width: 120,
    height: 80,
    angle: 0,
    strokeColor: "#1e1e1e",
    backgroundColor: "transparent",
    fillStyle: "solid",
    strokeWidth: 2,
    strokeStyle: "solid",
    roughness: 1,
    opacity: 100,
    groupIds: [],
    frameId: null,
    index: "a0",
    roundness: null,
    seed: 101,
    version,
    versionNonce,
    isDeleted: false,
    boundElements: null,
    updated: 1_700_000_000_000 + version,
    link: null,
    locked: false,
    ...extra,
  };
}

async function computer(input: {
  root: string;
  relayUrl: string;
  bearerToken: string;
  identity: ServiceOrdinaryReplicationConfig["identity"];
}) {
  await mkdir(input.root, { recursive: true });
  const client = await createEngineClient({
    command: engine.require(),
    authToken: randomBytes(32).toString("base64url"),
    protocolVersion: 2,
    capabilities: ["blobs"],
    connectTimeoutMs: DEADLINE_MS,
  });
  let requestId = 0;
  const nextRequestId = () => ++requestId;
  const request = async (
    method: string,
    params: { [key: string]: JsonValue },
    workspace?: string,
  ) =>
    (
      await client.sendRequest({
        id: nextRequestId(),
        method,
        params,
        ...(workspace ? { workspace } : {}),
        deadlineMs: DEADLINE_MS,
      })
    ).result as { [key: string]: JsonValue };
  const opened = await request("workspace.open", {
    rootDir: input.root,
    workspaceId: WORKSPACE,
    captureMode: "none",
    reconcileCollections: true,
    relay: {
      baseUrl: input.relayUrl,
      bearerToken: input.bearerToken,
      allowInsecureLoopbackForTests: true,
    },
  });
  const workspace = opened.workspace as string;
  const main = await request("versions.ensureMain", { workspaceId: WORKSPACE }, workspace);
  const lifetime = new AbortController();
  const replication = new ServiceOrdinaryReplication(
    {
      client,
      workspace,
      workspaceId: WORKSPACE,
      nextRequestId,
      deadlineMs: DEADLINE_MS,
      signal: lifetime.signal,
      assertCurrent: () => undefined,
    },
    {
      relay: { baseUrl: RELAY_ORIGIN, bearerToken: input.bearerToken },
      identity: input.identity,
      maxPagesPerPull: 8,
    },
  );
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    lifetime.abort();
    await request("workspace.close", {}, workspace).catch(() => undefined);
    client.close();
    await client.waitForExit();
  };
  cleanup.push(close);
  return {
    client,
    workspace,
    versionId: main.id as string,
    lifetime: lifetime.signal,
    request,
    nextRequestId,
    files: new VersionedLiveAdapter(client, workspace, { workspaceId: WORKSPACE }),
    async sync(): Promise<void> {
      for (let more = true; more;) more = (await replication.push()).hasMore;
      for (let more = true; more;) more = (await replication.pull()).hasMore;
    },
  };
}

async function setupE2E() {
  const root = await tempRoot("phone-sketches-e2e");
  const storage = await testStorage();
  const key = new Uint8Array(32).fill(9);
  const namespace = "phone-sketches-e2e";
  let copies: ServerCopies | undefined;
  const relay = createSyncRelayHandler({
    storage,
    resolveActor: testActor,
    resolveAccountSession,
    resolvePhoneCapableAccountSession: resolveAccountSession,
    serverCopies: () => copies,
    relayPublicOrigin: RELAY_ORIGIN,
  });
  const replicas = createServiceHostReplication({
    activity: new DiscussionActivityHub(),
    storage,
    prefix: AUTOMATION_REPLICA_BEARER_PREFIX,
    authorize: (credential) =>
      authorizeAutomationReplication(storage, { key, namespace, ...credential }),
  });
  const http = serveFetchHandler({
    handler: (request) =>
      request.headers.get("authorization")?.startsWith(`Bearer ${AUTOMATION_REPLICA_BEARER_PREFIX}`)
        ? replicas(request)
        : relay(request),
    streamBody: streamsRequestBody,
    maxBodyBytes: () => 21 * 1024 * 1024,
    oversized: () => new Response(null, { status: 413 }),
    failure: () => new Response(null, { status: 500 }),
  });
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  cleanup.push(async () => {
    http.closeAllConnections();
    await new Promise<void>((resolve) => http.close(() => resolve()));
  });
  const relayUrl = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
  const owner = await computer({
    root: join(root, "owner"),
    relayUrl,
    bearerToken: "test:owner",
    identity: { kind: "claim" },
  });
  await owner.sync();

  let beforeCopySync: (() => Promise<void>) | null = null;
  let lane: Promise<void> = Promise.resolve();
  const row = storage.joinAutomationWorkspace({
    workspaceId: WORKSPACE,
    nowMs: Date.now(),
    reasons: ["account"],
  });
  if (!row) throw new Error("Failed to join automation workspace.");
  const copy = await computer({
    root: join(root, "server", "workspace"),
    relayUrl,
    bearerToken: deriveAutomationReplicaBearer(row, { key, namespace }),
    identity: {
      kind: "join",
      replicationEpoch: row.replicationEpoch,
      streamIdentity: row.streamIdentity,
    },
  });
  const sync = () => {
    const run = lane.then(async () => {
      if (beforeCopySync) {
        const hook = beforeCopySync;
        beforeCopySync = null;
        await hook();
      }
      await copy.sync();
    });
    lane = run.catch(() => undefined);
    return run;
  };
  const replica: AutomationReplica = {
    workspaceId: WORKSPACE,
    ownerUserId: "owner",
    incarnation: row.incarnation,
    reasons: row.reasons,
    startedAtMs: row.startedAtMs,
    pulledHead: 0,
    root: join(root, "server", "workspace"),
    metadataDir: join(root, "server", "metadata"),
    client: copy.client,
    workspace: copy.workspace,
    signal: copy.lifetime,
    nextRequestId: copy.nextRequestId,
    withRecordWork: (work) => work(),
    busy: () => false,
    sync,
    step: async () => {
      await sync();
      return true;
    },
  };
  const started = await startServerCopies({
    storage,
    root: join(root, "server"),
    engineExecutable: engine.require(),
    relayOrigin: RELAY_ORIGIN,
    key,
    namespace,
    startReplicas: async () => ({
      unavailable: false,
      replica: (id) => (id === WORKSPACE ? replica : undefined),
      reconcile: () => undefined,
      deleteWorkspaces: async () => undefined,
      failedSyncs: () => new Map(),
      settled: async () => undefined,
      close: async () => undefined,
    }),
  });
  copies = started;
  cleanup.push(() => started.close());

  const call = async (operation: string, args: unknown, user = "owner") => {
    const response = await relay(
      new Request(`${relayUrl}/sync/${WORKSPACE}/ops/${operation}`, {
        method: "POST",
        headers: {
          authorization: `Bearer session:${user}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(args),
      }),
    );
    return {
      status: response.status,
      body: (await response.json().catch(() => null)) as Record<string, unknown> | null,
    };
  };

  const op = async (operation: string, args: unknown) => {
    const res = await call(operation, args, "owner");
    expect(res.status, `${operation}: ${JSON.stringify(res.body)}`).toBe(200);
    return res.body!.result as Record<string, unknown>;
  };

  return {
    storage,
    owner,
    copy,
    call,
    op,
    onNextCopySync(hook: () => Promise<void>) {
      beforeCopySync = hook;
    },
  };
}

it.skipIf(engine.missing)(
  "creates a sketch on phone, saves drawn elements idempotently, and syncs them to desktop",
  async () => {
    const { owner, op } = await setupE2E();

    const created = await op("createSketch", {
      path: "Trip Map.excalidraw",
      requestId: "req-create-trip",
    });
    expect(created).toMatchObject({
      ok: true,
      path: "Trip Map.excalidraw",
      objectId: expect.any(String),
    });
    const objectId = created.objectId as string;

    // Retrying with the same requestId replays cleanly; a new requestId reports exists.
    expect(
      await op("createSketch", { path: "Trip Map.excalidraw", requestId: "req-create-trip" }),
    ).toEqual(created);
    expect(
      await op("createSketch", { path: "Trip Map.excalidraw", requestId: "req-create-dup" }),
    ).toMatchObject({ ok: false, refusal: "exists" });

    expect(await op("readSketch", { path: "Trip Map.excalidraw" })).toEqual({
      ok: true,
      path: "Trip Map.excalidraw",
      objectId,
      elements: [],
      appState: { gridSize: null, viewBackgroundColor: "#ffffff" },
      files: {},
      missingAssets: 0,
    });

    const box = rect("rect-1", 1, 100);
    const saved = await op("saveSketch", {
      path: "Trip Map.excalidraw",
      objectId,
      requestId: "req-save-1",
      elements: [box],
      appState: { viewBackgroundColor: "#f5f0e6" },
    });
    expect(saved).toMatchObject({
      ok: true,
      path: "Trip Map.excalidraw",
      objectId,
      lostElementIds: [],
      appState: { viewBackgroundColor: "#f5f0e6" },
      missingAssets: 0,
    });
    expect(saved.elements).toEqual([box]);

    // Retrying the same save requestId is idempotent.
    expect(
      await op("saveSketch", {
        path: "Trip Map.excalidraw",
        objectId,
        requestId: "req-save-1",
        elements: [box],
        appState: { viewBackgroundColor: "#f5f0e6" },
      }),
    ).toEqual(saved);

    await owner.sync();
    const provider = await openEngineYdocProviderSession({
      transport: owner.client,
      workspace: owner.workspace,
      versionId: owner.versionId,
      path: "Trip Map.excalidraw",
      expectedObjectId: objectId,
      contentKind: "scene",
      seedAbsentLineage: false,
      onRemoteUpdate: () => undefined,
    });
    try {
      expect(provider.lineage).toBe("existing");
      const scene = foldScene(provider.doc);
      expect(scene.elements).toEqual([box]);
      expect(scene.appState).toEqual({ gridSize: null, viewBackgroundColor: "#f5f0e6" });
    } finally {
      await provider.evict().catch(() => undefined);
    }
  },
  120_000,
);

it.skipIf(engine.missing)(
  "hydrates desktop-managed image assets on read and preserves them intact on save",
  async () => {
    const { owner, op, call } = await setupE2E();
    const fileId = "img-asset-1";
    const imageEl: ElementSnapshot = {
      ...rect("img-el-1", 1, 50),
      type: "image",
      fileId,
      status: "saved",
      scale: [1, 1],
    };
    const docJson = JSON.stringify(
      {
        type: "excalidraw",
        version: 2,
        source: "https://excalidraw.com",
        elements: [JSON.parse(stableJson(imageEl))],
        appState: { viewBackgroundColor: "#ffffff" },
        files: {
          [fileId]: {
            created: 1_700_000_000_000,
            dataURL: PNG_DATA_URL,
            id: fileId,
            mimeType: "image/png",
          },
        },
      },
      null,
      2,
    );
    const written = await owner.files.writeTextFile({
      workspaceId: WORKSPACE,
      versionId: owner.versionId,
      path: "WithPhoto.excalidraw",
      text: docJson,
      publish: true,
      createOnly: true,
      metadata: { origin: "api", summary: "Seed photo sketch" },
    });
    const objectId = written.moment.objectId;

    // Desktop opens and settles the sketch so the engine converts the embedded image into a SceneAsset + binary blob.
    const desktopSeed = await openEngineYdocProviderSession({
      transport: owner.client,
      workspace: owner.workspace,
      versionId: owner.versionId,
      path: "WithPhoto.excalidraw",
      expectedObjectId: objectId,
      contentKind: "scene",
      seedAbsentLineage: true,
      onRemoteUpdate: () => undefined,
    });
    try {
      await desktopSeed.settleNow({ summary: "Seed photo sketch" });
      expect(desktopSeed.artifactAssets).toContainEqual(
        expect.objectContaining({ id: fileId, mimeType: "image/png", sha256: PNG_SHA256 }),
      );
      await desktopSeed.close({ settle: false });
    } catch (error) {
      await desktopSeed.evict().catch(() => undefined);
      throw error;
    }
    await owner.sync();

    const read = await op("readSketch", { path: "WithPhoto.excalidraw" });
    expect(read).toMatchObject({
      ok: true,
      objectId,
      missingAssets: 0,
      files: {
        [fileId]: {
          id: fileId,
          mimeType: "image/png",
          dataURL: PNG_DATA_URL,
          created: 1_700_000_000_000,
        },
      },
    });
    expect(read.elements).toHaveLength(1);

    // Phone refuses a brand-new image element whose fileId is not in existing assets.
    const badImage = await call("saveSketch", {
      path: "WithPhoto.excalidraw",
      objectId,
      requestId: "req-bad-img",
      elements: [
        {
          ...rect("img-new", 1, 10),
          type: "image",
          fileId: "unknown-file",
          status: "saved",
          scale: [1, 1],
        },
      ],
    });
    expect(badImage.status).toBe(400);

    // Phone adds a rectangle; untouched desktop-managed SceneAsset and binary blob stay intact.
    const annotation = rect("rect-note", 1, 200, { index: "a1" });
    const saved = await op("saveSketch", {
      path: "WithPhoto.excalidraw",
      objectId,
      requestId: "req-add-note",
      elements: [annotation],
    });
    expect(saved).toMatchObject({
      ok: true,
      lostElementIds: [],
      missingAssets: 0,
      files: { [fileId]: expect.objectContaining({ dataURL: PNG_DATA_URL }) },
    });
    expect((saved.elements as ElementSnapshot[]).map((e) => e.id).sort()).toEqual([
      "img-el-1",
      "rect-note",
    ]);

    await owner.sync();
    const after = await openEngineYdocProviderSession({
      transport: owner.client,
      workspace: owner.workspace,
      versionId: owner.versionId,
      path: "WithPhoto.excalidraw",
      expectedObjectId: objectId,
      contentKind: "scene",
      seedAbsentLineage: false,
      onRemoteUpdate: () => undefined,
    });
    try {
      const scene = foldScene(after.doc);
      expect(scene.elements.map((e) => e.id).sort()).toEqual(["img-el-1", "rect-note"]);
      expect(scene.assets[fileId]).toMatchObject({ id: fileId, sha256: PNG_SHA256 });
      const blob = await owner.files.readBinaryBlob({ workspaceId: WORKSPACE, sha256: PNG_SHA256 });
      expect(blob ? Buffer.from(blob) : null).toEqual(PNG_BYTES);
    } finally {
      await after.evict().catch(() => undefined);
    }
  },
  120_000,
);

it.skipIf(engine.missing)(
  "detects concurrent desktop edits on the same element against post-publication relay state",
  async () => {
    const { owner, op, onNextCopySync } = await setupE2E();
    const created = await op("createSketch", {
      path: "Race.excalidraw",
      requestId: "req-race-create",
    });
    const objectId = created.objectId as string;

    const initial = rect("el-shared", 1, 500, { x: 10 });
    await op("saveSketch", {
      path: "Race.excalidraw",
      objectId,
      requestId: "req-race-init",
      elements: [initial],
    });
    await owner.sync();

    // Helper: desktop edits el-shared to a winning revision and pushes to relay.
    const desktopEdit = async (el: ElementSnapshot) => {
      const provider = await openEngineYdocProviderSession({
        transport: owner.client,
        workspace: owner.workspace,
        versionId: owner.versionId,
        path: "Race.excalidraw",
        expectedObjectId: objectId,
        contentKind: "scene",
        seedAbsentLineage: false,
        onRemoteUpdate: () => undefined,
      });
      try {
        const before = Y.encodeStateVector(provider.doc);
        insertElementRevision(provider.doc, el);
        await provider.applyLocalUpdate(Y.encodeStateAsUpdate(provider.doc, before), {
          idempotencyKey: `desktop-${el.version}-${el.versionNonce}`,
          attribution: { actorKind: "human" },
          armSettle: false,
        });
        await provider.settleNow({ summary: "Desktop edit" });
        await provider.close({ settle: false });
      } catch (error) {
        await provider.evict().catch(() => undefined);
        throw error;
      }
      await owner.sync();
    };

    // Mid-flight race: the pre-save sync passes first; then BEFORE the post-save sync publishes,
    // desktop pushes a higher-version revision of el-shared to the relay.
    let syncCount = 0;
    const desktopWinner = rect("el-shared", 4, 10, { x: 400 });
    const armSecondSync = () =>
      onNextCopySync(async () => {
        syncCount += 1;
        if (syncCount === 1) armSecondSync();
        else await desktopEdit(desktopWinner);
      });
    armSecondSync();

    const phoneLoser = rect("el-shared", 2, 900, { x: 99 });
    const saved = await op("saveSketch", {
      path: "Race.excalidraw",
      objectId,
      requestId: "req-race-lose",
      elements: [phoneLoser],
    });
    expect(syncCount).toBe(2);
    expect(saved).toMatchObject({
      ok: true,
      lostElementIds: ["el-shared"],
    });
    expect(saved.elements).toEqual([desktopWinner]);
  },
  120_000,
);

it.skipIf(engine.missing)(
  "reads a never-opened sketch without mutating relay state, then seeds and saves edits cleanly, while denying Members 404",
  async () => {
    const { storage, owner, op, call } = await setupE2E();
    const fileId = "raw-img-1";
    const shape = rect("raw-rect", 1, 11);
    const imgEl: ElementSnapshot = {
      ...rect("raw-img-el", 1, 12, { index: "a1" }),
      type: "image",
      fileId,
      status: "saved",
      scale: [1, 1],
    };
    const written = await owner.files.writeTextFile({
      workspaceId: WORKSPACE,
      versionId: owner.versionId,
      path: "NeverOpened.excalidraw",
      text: JSON.stringify({
        type: "excalidraw",
        version: 2,
        elements: [shape, imgEl],
        appState: { gridModeEnabled: true },
        files: {
          [fileId]: {
            id: fileId,
            mimeType: "image/png",
            dataURL: PNG_DATA_URL,
            created: 1_700_000_000_000,
          },
        },
      }),
      publish: true,
      createOnly: true,
      metadata: { origin: "api", summary: "Seed never-opened sketch" },
    });
    const objectId = written.moment.objectId;
    await owner.sync();

    const db = (storage as StorageContext).db;
    const logCount = () =>
      Number(
        db
          .prepare("SELECT COUNT(*) AS n FROM sync_relay_log WHERE workspace_id = ?")
          .get(WORKSPACE)!.n,
      );
    const beforeRead = logCount();

    const read = await op("readSketch", { path: "NeverOpened.excalidraw" });
    expect(read).toMatchObject({
      ok: true,
      objectId,
      appState: { gridModeEnabled: true },
      missingAssets: 0,
      files: { [fileId]: expect.objectContaining({ dataURL: PNG_DATA_URL }) },
    });
    expect((read.elements as ElementSnapshot[]).map((e) => e.id)).toEqual([
      "raw-rect",
      "raw-img-el",
    ]);
    expect(logCount(), "reading a never-opened sketch must not publish anything").toBe(beforeRead);

    // Saving seeds the absent lineage, preserves the embedded image asset, and syncs back to desktop.
    const added = rect("phone-added", 1, 33, { index: "a2" });
    const saved = await op("saveSketch", {
      path: "NeverOpened.excalidraw",
      objectId,
      requestId: "req-never-opened-save",
      elements: [added],
    });
    expect(saved).toMatchObject({
      ok: true,
      lostElementIds: [],
      missingAssets: 0,
      files: { [fileId]: expect.objectContaining({ dataURL: PNG_DATA_URL }) },
    });
    expect((saved.elements as ElementSnapshot[]).map((e) => e.id).sort()).toEqual([
      "phone-added",
      "raw-img-el",
      "raw-rect",
    ]);

    await owner.sync();
    const after = await openEngineYdocProviderSession({
      transport: owner.client,
      workspace: owner.workspace,
      versionId: owner.versionId,
      path: "NeverOpened.excalidraw",
      expectedObjectId: objectId,
      contentKind: "scene",
      seedAbsentLineage: false,
      onRemoteUpdate: () => undefined,
    });
    try {
      const scene = foldScene(after.doc);
      expect(scene.elements.map((e) => e.id).sort()).toEqual([
        "phone-added",
        "raw-img-el",
        "raw-rect",
      ]);
      expect(scene.assets[fileId]).toMatchObject({ id: fileId, sha256: PNG_SHA256 });
    } finally {
      await after.evict().catch(() => undefined);
    }

    // Joined Member gets 404 on every sketch op.
    expect(
      storage.inviteWorkspaceMember({
        workspaceId: WORKSPACE,
        actorUserId: "owner",
        workspaceName: "Sketches",
        email: "member@dohc.test",
        recipientUserId: "member",
        newMemberId: () => "mem-1",
        newGrantId: () => "grant-1",
        newShareId: () => "share-1",
        nowMs: Date.now(),
      }),
    ).toMatchObject({ ok: true });
    expect((await call("readSketch", { path: "NeverOpened.excalidraw" }, "member")).status).toBe(
      404,
    );
    expect(
      (await call("createSketch", { path: "X.excalidraw", requestId: "req-m" }, "member")).status,
    ).toBe(404);
    expect(
      (
        await call(
          "saveSketch",
          { path: "NeverOpened.excalidraw", objectId, requestId: "req-ms", elements: [] },
          "member",
        )
      ).status,
    ).toBe(404);
  },
  120_000,
);
