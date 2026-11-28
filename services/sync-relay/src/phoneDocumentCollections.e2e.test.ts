import { createServer as createHttpsServer } from "node:https";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getCACertificates, setDefaultCACertificates } from "node:tls";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import * as Y from "yjs";
import type { LiveObjectBinding } from "@dohc/live-session-contract/live-object-binding";
import { serveFetchHandler, TokenBucketLimiter } from "@dohc/service-http";
import {
  UnauthorizedError,
  type AccountSession,
  type ResolveAccountSession,
  type ResolveActor,
  type StoredAccountSession,
} from "@dohc/workspace-auth/session";
import { isRecordId } from "@dohc/workspace-contracts/collection-values";
import { VersionedLiveAdapter } from "@dohc/workspace-engine-client";
import { documentEditUpdate } from "@dohc/ydoc-projection";
import { frontmatterMapValues, patchFrontmatter } from "@dohc/ydoc-projection/frontmatter-map";
import { admitBodySequenceNotes } from "@dohc/ydoc-projection/live-journal-validation";
import { createNamedLiveProvider } from "@dohc/ydoc-projection/named-live-provider";
import { mintLocalhostCa } from "../../share-web/src/testing/localhostCa";
import { openLiveDaemonWorkspace } from "../../../apps/desktop/e2e/helpers/daemonSeed";
import { requireEngineBinaryOrSkip } from "../../../apps/desktop/src/testing/engineBinary";
import {
  REAL_DAEMON_DEADLINE_MS,
  realDaemonReaderConfig,
} from "../../../apps/desktop/src/testing/realDaemonWorkspaceSessions";
import { probeRelayWorkspace } from "../../../apps/desktop/src/workspaces/relayWorkspaceProbe";
import { installWorkspaceDataKey } from "../../../apps/desktop/src/workspaces/workspaceDataKey";
import { createWorkspaceEngineCapture } from "../../../apps/desktop/src/workspaces/workspaceEngineCapture";
import { listInboxItems } from "../../../apps/desktop/src/workspaces/workspaceInbox";
import { bootstrapJoinedWorkspace } from "../../../apps/desktop/src/workspaces/workspaceJoinEnrollment";
import {
  AUTOMATION_REPLICA_BEARER_PREFIX,
  authorizeAutomationReplication,
} from "./automationReplicaCredential";
import { DiscussionActivityHub } from "./discussionActivity";
import { createLiveConnectionAdmission } from "./liveConnectionAdmission";
import { createNamedFrameChanges } from "./liveHostChanges";
import { createLiveRooms, LiveRoomBindingEndedError } from "./liveRoom";
import { createLiveTickets } from "./liveTickets";
import { parseNamedLiveConfig } from "./namedLiveConfig";
import { captureOwnerLiveFrameHost } from "./namedLiveFrameHost";
import { createLiveHostReports } from "./namedLiveHostReports";
import { createOwnerLiveRoutes } from "./namedLiveRoutes";
import { createPhonePages, type PhonePages } from "./phonePages";
import { initializeRelayDeployment, openRelayDeployment } from "./relayDeployment";
import { selfHostLiveProfile } from "./selfHostLiveProfile";
import { selfHostedLiveHostId, startSelfHostedLiveHost } from "./selfHostedLiveHost";
import { createSyncRelayHandler, streamsRequestBody } from "./server";
import { startServerCopies, type ServerCopies } from "./serverCopies";
import { authorizeServiceHostReplication } from "./serviceHostCredential";
import { createServiceHostReplication } from "./serviceHostReplication";
import type { StorageContext } from "./storage/context";
import { LIVE_ROOM_EDITS } from "./storage/liveRoomEdits";
import { workspaceOwner } from "./storage/workspaces";
import { closeTestStorages, tempRoot } from "./testing";

const engine = requireEngineBinaryOrSkip();
const SERVICE_HOST_PREFIX = "dohc-service-v1.";
const LINK_KEY = "doc-collections-e2e-link-key-32bytes";
const EXCHANGE_KEY = "doc-collections-e2e-exchange-32bytes";
const OWNER = "owner-1";
const WORKSPACE = "workspace-doc-cols";

let sharedCaRoot = "";
let sharedCa: Awaited<ReturnType<typeof mintLocalhostCa>>;
let previousRoots: readonly string[];
beforeAll(async () => {
  if (engine.missing) return;
  admitBodySequenceNotes(true);
  sharedCaRoot = await realpath(await mkdtemp(join(tmpdir(), "dohc-doc-cols-ca-")));
  sharedCa = await mintLocalhostCa(sharedCaRoot);
  previousRoots = getCACertificates("default");
  setDefaultCACertificates([...previousRoots, sharedCa.ca]);
});
afterAll(async () => {
  admitBodySequenceNotes(false);
  if (previousRoots) setDefaultCACertificates(previousRoots);
  if (sharedCaRoot) await rm(sharedCaRoot, { recursive: true, force: true });
});

const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  for (const close of cleanup.splice(0).reverse()) await close();
  await closeTestStorages();
});

const resolveActor: ResolveActor = (request, workspaceId) => {
  const match = /^Bearer test:([A-Za-z0-9_.:-]+)$/u.exec(
    request.headers.get("authorization") ?? "",
  );
  if (!match) throw new UnauthorizedError();
  return { userId: match[1]!, workspaceId };
};

const resolvePhoneSession: ResolveAccountSession = async (request) => {
  const match = /^Bearer session:([\w-]+):([\w-]+)$/u.exec(
    request.headers.get("authorization") ?? "",
  );
  if (!match) throw new UnauthorizedError();
  return {
    userId: match[1]!,
    sessionId: match[2]!,
    expiresAtMs: Number.MAX_SAFE_INTEGER,
    clientKind: "phone",
  } satisfies AccountSession;
};

async function startRealStack() {
  const root = await realpath(await tempRoot("doc-cols-e2e"));
  const ca = sharedCa;
  for (const [key, value] of Object.entries({
    NODE_EXTRA_CA_CERTS: ca.caPath,
    DOHC_ENGINE_TEST_RELAY_CA_MODE: "1",
    DOHC_ENGINE_TEST_RELAY_CA_FILE: ca.caPath,
    DOHC_E2E_ALLOW_INSECURE_LOOPBACK_RELAY: "0",
    DOHC_RELAY_ALLOW_UNISOLATED_PROJECTION: "1",
    DOHC_ENGINE_READER_CONFIG: realDaemonReaderConfig(),
  }))
    vi.stubEnv(key, value);

  const deploymentConfig = join(root, "deployment.json");
  const dbPath = join(root, "relay", "relay.sqlite");
  const continuityDirectory = join(root, "continuity");
  const liveHostRoot = join(root, "live-host");
  const copiesRoot = join(root, "copies");
  await mkdir(liveHostRoot, { recursive: true });
  await mkdir(copiesRoot, { recursive: true });

  const profile = selfHostLiveProfile();
  initializeRelayDeployment({
    configPath: deploymentConfig,
    relayPath: dbPath,
    continuityDirectory,
  });
  const deployment = openRelayDeployment(deploymentConfig, {
    liveTickets: { ...profile.namedLive.tickets, now: Date.now },
  });
  const storage = deployment.storage as StorageContext;
  cleanup.push(() => storage.close());

  const hostId = selfHostedLiveHostId(deployment.history.namespace);
  expect(
    storage.provisionLiveHostControl({
      mode: "service",
      hostId,
      updatedAtMs: 1,
      guard: storage.captureStanding(),
    }).ok,
  ).toBe(true);

  const key = Buffer.from(LINK_KEY);
  const activity = new DiscussionActivityHub();
  const frameChanges = createNamedFrameChanges(64);
  const sessionExpiry = Date.now() + 3_600_000;
  const storedSessions = new Map<string, StoredAccountSession>([
    ["phone-1", { userId: OWNER, expiresAtMs: sessionExpiry, clientKind: "phone" }],
    ["phone-2", { userId: OWNER, expiresAtMs: sessionExpiry, clientKind: "phone" }],
  ]);
  const accountSessions = {
    read: async (ids: readonly string[]) =>
      new Map(
        ids.flatMap((id): Array<[string, StoredAccountSession]> => {
          const found = storedSessions.get(id);
          return found ? [[id, found]] : [];
        }),
      ),
  };
  const resolvePhoneSessionLocal: ResolveAccountSession = async (req) => ({
    ...(await resolvePhoneSession(req)),
    expiresAtMs: sessionExpiry,
  });

  let copies: ServerCopies | undefined;
  let selfHost: Awaited<ReturnType<typeof startSelfHostedLiveHost>> | undefined;
  let phonePages: PhonePages | undefined;
  let rooms: ReturnType<typeof createLiveRooms> | undefined;

  const relay = createSyncRelayHandler({
    storage,
    discussionActivity: activity,
    resolveActor,
    resolvePhoneCapableAccountSession: resolvePhoneSessionLocal,
    serverCopies: () => copies,
    phonePages: () => phonePages,
    liveHost: () => selfHost,
    liveRooms: () => rooms,
    accountOperationRateLimiter: new TokenBucketLimiter(1000, 1000, 100),
    relayPublicOrigin: "https://127.0.0.1",
  });
  const serviceRepl = createServiceHostReplication({
    activity,
    storage,
    prefix: SERVICE_HOST_PREFIX,
    hostedFeed: true,
    authorize: (credential) =>
      authorizeServiceHostReplication(storage, {
        key,
        namespace: deployment.history.namespace,
        ...credential,
      }),
  });
  const automationRepl = createServiceHostReplication({
    activity,
    storage,
    prefix: AUTOMATION_REPLICA_BEARER_PREFIX,
    authorize: (credential) =>
      authorizeAutomationReplication(storage, {
        key,
        namespace: deployment.history.namespace,
        ...credential,
      }),
  });

  const server = createHttpsServer({ key: ca.key, cert: ca.certificate });
  const listener = serveFetchHandler({
    handler: (request) => {
      const auth = request.headers.get("authorization") ?? "";
      if (auth.startsWith(`Bearer ${SERVICE_HOST_PREFIX}`)) return serviceRepl(request);
      if (auth.startsWith(`Bearer ${AUTOMATION_REPLICA_BEARER_PREFIX}`))
        return automationRepl(request);
      return relay(request);
    },
    streamBody: streamsRequestBody,
    maxBodyBytes: () => 21 * 1024 * 1024,
    oversized: () => new Response(null, { status: 413 }),
    failure: () => new Response(null, { status: 500 }),
  });
  server.on("request", listener.listeners("request")[0] as never);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  const origin = `https://127.0.0.1:${port}`;
  cleanup.push(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  selfHost = await startSelfHostedLiveHost({
    trustedAccount: (accountId) => ({ accountId, name: "Owner" }),
    storage,
    history: deployment.history,
    frameChanges,
    root: liveHostRoot,
    engineExecutable: engine.require(),
    relayOrigin: origin,
    key,
    reconcileIntervalMs: 100,
    onError: (error) => console.error("[test-selfHost]", error),
  });
  cleanup.push(() => selfHost!.close());

  const captureNative = async (binding: LiveObjectBinding, signal: AbortSignal) => {
    const current = selfHost!.current();
    if (!current) throw new Error("Self-hosted live host unavailable.");
    return current.captureNative(binding, signal);
  };
  const tickets = createLiveTickets({
    storage,
    audience: origin,
    key,
    hostReports: createLiveHostReports({ storage, captureNative }),
  });
  const namedLiveConfig = parseNamedLiveConfig(profile.namedLive);
  const bounds = namedLiveConfig.host;
  rooms = createLiveRooms({
    storage,
    maxUpdateBytes: Math.min(bounds.maxSubmissionBytes, bounds.maxAppliedUpdateBytes),
    maxNoteBytes: bounds.maxAdmissionBytes,
    maxAppliedBytes: Math.min(bounds.maxSubmissionBytes, bounds.maxAppliedUpdateBytes),
    saveEveryMs: 100,
    async openSaver(document, signal) {
      const ownerUserId = workspaceOwner(storage, document.workspaceId);
      if (!ownerUserId) throw new Error("Workspace has no owner.");
      const current = storage.resolveCurrentLiveDocumentBinding({
        document,
        actor: { kind: "owner", userId: ownerUserId },
      });
      if (current.kind !== "current")
        throw current.reason === "stale-document"
          ? new LiveRoomBindingEndedError()
          : new Error("Owner binding is not current.");
      return captureOwnerLiveFrameHost({
        authenticatedUserId: ownerUserId,
        storage,
        native: await captureNative(current.binding, signal),
        bounds,
        validate: namedLiveConfig.validate,
      });
    },
  });
  cleanup.push(() => rooms!.close());

  const ownerLive = createOwnerLiveRoutes({
    rooms,
    storage,
    resolveAccountSession: resolvePhoneSessionLocal,
    accountSessions,
    tickets,
    hosts: new Set([`127.0.0.1:${port}`]),
    publicOrigin: origin,
    exchangeKey: EXCHANGE_KEY,
    limits: namedLiveConfig.transport,
    frames: namedLiveConfig.frames,
    bounds,
    validate: namedLiveConfig.validate,
    captureNative,
    admission: createLiveConnectionAdmission(),
  });
  cleanup.push(() => ownerLive.close());
  server.on("upgrade", (req, socket, head) => {
    if (/^\/sync\/workspaces\/[^/]+\/live\/owner(?:\?|$)/u.test(req.url ?? ""))
      void ownerLive.handleUpgrade(req, socket, head).catch(() => socket.destroy());
    else socket.destroy();
  });

  phonePages = createPhonePages({
    storage,
    history: deployment.history,
    host: selfHost,
    supported: () => true,
    tickets,
    sessions: accountSessions,
    nowMs: () => Date.now(),
    editorLimits: profile.editor,
  });

  copies = await startServerCopies({
    storage,
    root: copiesRoot,
    engineExecutable: engine.require(),
    relayOrigin: origin,
    key,
    namespace: deployment.history.namespace,
  });
  cleanup.push(async () => {
    await copies?.close();
  });

  expect(
    storage.claimWorkspace({ workspaceId: WORKSPACE, ownerUserId: OWNER, createdAtMs: 1 }),
  ).toBe("created");
  storage.claimWorkspaceIdentity({
    workspaceId: WORKSPACE,
    replicationEpoch: "epoch-1",
    streamIdentity: "stream-1",
  });

  const phoneOp = async <T = unknown>(
    operation: string,
    args: Record<string, unknown>,
    sessionId = "phone-1",
  ) => {
    const response = await fetch(`${origin}/sync/${WORKSPACE}/ops/${operation}`, {
      method: "POST",
      headers: {
        authorization: `Bearer session:${OWNER}:${sessionId}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(args),
    });
    const text = await response.text();
    expect(response.status, `${operation}: ${text}`).toBe(200);
    return (JSON.parse(text) as { ok: true; result: T }).result;
  };

  const openPhoneLive = async (path: string, sessionId = "phone-1") => {
    type OpenAnswer =
      | {
          status: "ready";
          objectId: string;
          lineageClaimId: string;
          ticket: string;
          editorLimits: typeof profile.editor;
        }
      | { status: "preparing" }
      | { status: "refused"; reason: string };
    let ready: Extract<OpenAnswer, { status: "ready" }> | undefined;
    await vi.waitFor(
      async () => {
        const answer = await phoneOp<OpenAnswer>("openPage", { path }, sessionId);
        if (answer.status === "refused") throw new Error(`openPage refused: ${answer.reason}`);
        expect(answer.status).toBe("ready");
        if (answer.status === "ready") ready = answer;
      },
      { timeout: REAL_DAEMON_DEADLINE_MS, interval: 100 },
    );
    const wsUrl = `${origin.replace(/^https:/, "wss:")}/sync/workspaces/${WORKSPACE}/live/owner?objectId=${encodeURIComponent(ready!.objectId)}&lineageClaimId=${encodeURIComponent(ready!.lineageClaimId)}`;
    const ws = new WebSocket(wsUrl, ["dohc-live-v1", `dohc-live-ticket.${ready!.ticket}`], {
      headers: { authorization: `Bearer session:${OWNER}:${sessionId}` },
      ca: ca.ca,
    });
    ws.binaryType = "arraybuffer";
    const earlyFrames: Uint8Array[] = [];
    let route: ReturnType<ReturnType<typeof createNamedLiveProvider>["connect"]> | null = null;
    ws.on("message", (data) => {
      const bytes =
        data instanceof ArrayBuffer
          ? new Uint8Array(data)
          : Buffer.isBuffer(data)
            ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
            : null;
      if (!bytes) return;
      if (route) route.receive(bytes);
      else earlyFrames.push(bytes.slice());
    });
    await new Promise<void>((resolve, reject) => {
      ws.once("open", () => resolve());
      ws.once("error", reject);
    });
    const provider = createNamedLiveProvider(ready!.editorLimits.provider, {
      workspaceId: WORKSPACE,
      objectId: ready!.objectId,
    });
    route = provider.connect({
      send: (bytes) =>
        new Promise<void>((resolve, reject) => {
          ws.send(bytes, (error) => (error ? reject(error) : resolve()));
        }),
      close: () => ws.close(),
    });
    for (const frame of earlyFrames.splice(0)) route.receive(frame);
    const closed = new Promise<void>((resolve) => ws.once("close", () => resolve()));
    await vi.waitFor(() => expect(provider.state().status).toBe("live"), {
      timeout: REAL_DAEMON_DEADLINE_MS,
      interval: 50,
    });
    const waitAck = async () => {
      await vi.waitFor(
        () => {
          const s = provider.state();
          if (s.status === "quarantined" || s.status === "disconnected")
            throw new Error(`provider stopped: ${JSON.stringify(s)}`);
          expect(s.pendingUpdates).toBe(0);
          expect(s.status).toBe("live");
        },
        { timeout: 10_000, interval: 50 },
      );
    };
    return {
      ready: ready!,
      provider,
      waitAck,
      async editBody(replacement: string) {
        const update = documentEditUpdate(
          Y.encodeStateAsUpdate(provider.doc),
          { replacement },
          { keepBlocks: false },
        );
        if (!(update instanceof Uint8Array)) throw new Error("documentEditUpdate failed");
        Y.applyUpdate(provider.doc, update);
        await waitAck();
      },
      async waitSettled(expectedSubstring: string) {
        await vi.waitFor(
          async () => {
            const pending = storage.db
              .prepare(
                `SELECT COUNT(*) AS count FROM ${LIVE_ROOM_EDITS} WHERE workspace_id=? AND object_id=?`,
              )
              .get(WORKSPACE, ready!.objectId) as { count: number };
            expect(pending.count).toBe(0);
            const doc = await phoneOp<{ markdown?: string }>("documentRead", { path });
            expect(doc.markdown).toContain(expectedSubstring);
          },
          { timeout: REAL_DAEMON_DEADLINE_MS, interval: 100 },
        );
      },
      async disconnect() {
        provider.close();
        await closed;
      },
    };
  };

  const connectDesktop = async (name: string) => {
    const desktopRoot = join(root, name);
    await mkdir(desktopRoot, { recursive: true });
    const desktop = await openLiveDaemonWorkspace(
      { workspaceId: WORKSPACE, rootPath: desktopRoot },
      { maxRestarts: 0, allowInsecureLoopbackForTests: false },
    );
    cleanup.push(() => desktop.close());
    const capture = createWorkspaceEngineCapture({
      ...desktop.workspace,
      rustEngineSessions: desktop.sessions,
    });
    cleanup.push(() => capture.stop());
    const relayConn = { baseUrl: origin, token: `test:${OWNER}` };
    const relayClient = desktop.relay.bind({ ...desktop.workspace, relay: relayConn });
    const probe = await probeRelayWorkspace({ workspaceId: WORKSPACE, relay: relayConn });
    await bootstrapJoinedWorkspace({
      workspaceId: WORKSPACE,
      identity: probe.identity,
      transport: relayClient,
      installDataKey: async (dataKey) => await installWorkspaceDataKey(desktopRoot, dataKey),
    });
    const pull = () => relayClient.pull((apply) => capture.runRelaySync(apply));
    const push = () => relayClient.push();
    return { root: desktopRoot, desktop, capture, pull, push };
  };

  return { root, origin, storage, phoneOp, openPhoneLive, connectDesktop };
}

describe.skipIf(engine.missing)(
  "Document Collections & Live Page Properties E2E (real relay + engine + desktop)",
  () => {
    it(
      "Proofs 1, 2, 3, 5: starter collection creation, live-seeded rec_ record, live frontmatter patch with remote observeDeep, and deleteFile + desktop History restore",
      async () => {
        const stack = await startRealStack();

        // Proof 1: starter Document Collection creation, idempotent retry, occupied-folder refusal.
        const createdCol = await stack.phoneOp<{ ok: true; path: string; objectId: string }>(
          "createDocumentCollection",
          { folder: "Tasks", name: "Tasks", requestId: "col-req-1" },
        );
        expect(createdCol).toMatchObject({ ok: true, path: "Tasks" });
        expect(
          await stack.phoneOp("createDocumentCollection", {
            folder: "Tasks",
            name: "Tasks",
            requestId: "col-req-1",
          }),
        ).toEqual(createdCol);
        expect(
          await stack.phoneOp("createDocumentCollection", {
            folder: "tasks",
            name: "tasks",
            requestId: "col-req-other",
          }),
        ).toMatchObject({ ok: false, refusal: "folder-occupied" });

        const list = await stack.phoneOp<{
          ok: true;
          collections: Array<{ path: string; name: string }>;
        }>("documentCollections", {});
        expect(list.collections.map((c) => c.path)).toEqual(["Tasks"]);

        // Proof 2: createDocumentRecord creates rec_... record immediately live-editable with zero desktop online.
        const createdRec = await stack.phoneOp<{
          ok: true;
          path: string;
          objectId: string;
          recordId: string;
        }>("createDocumentRecord", {
          collectionPath: "Tasks",
          name: "Ship Milestone",
          requestId: "rec-req-1",
        });
        expect(createdRec).toMatchObject({ ok: true, path: "Tasks/Ship Milestone.md" });
        expect(isRecordId(createdRec.recordId)).toBe(true);
        expect(
          stack.storage.mainLiveLineageExists({
            workspaceId: WORKSPACE,
            objectId: createdRec.objectId,
          }),
        ).toBe(true);

        // Proof 3: live frontmatter property edit passes liveValidation without quarantine, updates remote observer live, overlays in records read, and settles to desktop.
        const live1 = await stack.openPhoneLive("Tasks/Ship Milestone.md", "phone-1");
        const live2 = await stack.openPhoneLive("Tasks/Ship Milestone.md", "phone-2");
        const remoteObserved: Array<Record<string, unknown>> = [];
        const remoteFm = live2.provider.doc.getMap("frontmatter");
        remoteFm.observeDeep(() => remoteObserved.push(frontmatterMapValues(remoteFm)));

        patchFrontmatter(live1.provider.doc, new Map<string, unknown>([["Name", "Live Updated"]]));
        await live1.waitAck();
        await vi.waitFor(
          () => expect(remoteObserved.at(-1)).toMatchObject({ Name: "Live Updated" }),
          {
            timeout: 10_000,
          },
        );
        await live1.editBody("Body from phone live");
        await live1.waitSettled("Body from phone live");
        await live1.disconnect();
        await live2.disconnect();

        const recordsRead = await stack.phoneOp<{
          ok: true;
          records: Array<{
            path: string;
            recordId: string | null;
            values: Record<string, unknown>;
          }>;
        }>("documentCollectionRecords", { collectionPath: "Tasks" });
        expect(recordsRead.records).toEqual([
          expect.objectContaining({
            path: "Tasks/Ship Milestone.md",
            recordId: createdRec.recordId,
            values: { Name: "Live Updated" },
          }),
        ]);

        // Desktop syncs both Tasks/collection.yaml and Tasks/Ship Milestone.md cleanly.
        const desktop = await stack.connectDesktop("desktop-proof1235");
        await desktop.pull();
        expect(await readFile(join(desktop.root, "Tasks/collection.yaml"), "utf8")).toContain(
          "name: Tasks",
        );
        const syncedMd = await readFile(join(desktop.root, "Tasks/Ship Milestone.md"), "utf8");
        expect(syncedMd).toContain(`id: ${createdRec.recordId}`);
        expect(syncedMd).toContain("Name: Live Updated");
        expect(syncedMd).toContain("Body from phone live");

        // Proof 5: deleteFile works inside collection.yaml and is restorable via desktop History.
        const deleted = await stack.phoneOp<{
          ok: true;
          path: string;
          objectId: string;
          deleteMomentId: string;
        }>("deleteFile", {
          path: "Tasks/Ship Milestone.md",
          expectedObjectId: createdRec.objectId,
          requestId: "del-rec-1",
        });
        expect(deleted).toEqual({
          ok: true,
          path: "Tasks/Ship Milestone.md",
          objectId: createdRec.objectId,
          deleteMomentId: expect.any(String),
        });
        const afterDelete = await stack.phoneOp<{ ok: true; records: unknown[] }>(
          "documentCollectionRecords",
          { collectionPath: "Tasks" },
        );
        expect(afterDelete.records).toHaveLength(0);

        await desktop.pull();
        await expect(
          readFile(join(desktop.root, "Tasks/Ship Milestone.md"), "utf8"),
        ).rejects.toThrow();
        const moments = await desktop.capture.listMoments({
          objectId: createdRec.objectId,
          limit: 10,
        });
        const deleteMoment = moments.moments.find((m) => m.operation === "delete");
        expect(deleteMoment?.path).toBe("Tasks/Ship Milestone.md");
        const restored = await desktop.capture.restoreFileToBeforeMoment(deleteMoment!.id, {
          kind: "human",
          humanId: OWNER,
        });
        expect(restored.path).toBe("Tasks/Ship Milestone.md");
        const restoredMd = await readFile(join(desktop.root, "Tasks/Ship Milestone.md"), "utf8");
        expect(restoredMd).toContain("Name: Live Updated");
        expect(restoredMd).toContain("Body from phone live");
      },
      REAL_DAEMON_DEADLINE_MS * 3,
    );

    it(
      "Proof 4: unopened-record property edit fallback preserves BOTH phone property edit and concurrent desktop body open",
      async () => {
        const stack = await startRealStack();
        const desktop = await stack.connectDesktop("desktop-proof4");
        await desktop.pull();

        // Desktop writes Projects/collection.yaml and Projects/Alpha.md WITHOUT opening Alpha.md live.
        await mkdir(join(desktop.root, "Projects"), { recursive: true });
        await writeFile(
          join(desktop.root, "Projects/collection.yaml"),
          "name: Projects\nfields:\n  Status:\n    type: select\n    options: [Todo, Done]\n",
          "utf8",
        );
        await writeFile(
          join(desktop.root, "Projects/Alpha.md"),
          "---\nid: rec_cccccccccccccccccccccccccc\nStatus: Todo\n---\nInitial body\n",
          "utf8",
        );
        await desktop.desktop.sessions.run(
          desktop.desktop.workspace,
          async ({ client, workspace }) => {
            const files = new VersionedLiveAdapter(client, workspace, { workspaceId: WORKSPACE });
            await files.writeTextFile({
              workspaceId: WORKSPACE,
              versionId: "main",
              path: "Projects/collection.yaml",
              text: "name: Projects\nfields:\n  Status:\n    type: select\n    options: [Todo, Done]\n",
              publish: true,
              metadata: { origin: "api" },
            });
            await files.writeTextFile({
              workspaceId: WORKSPACE,
              versionId: "main",
              path: "Projects/Alpha.md",
              text: "---\nid: rec_cccccccccccccccccccccccccc\nStatus: Todo\n---\nInitial body\n",
              publish: true,
              metadata: { origin: "api" },
            });
            await files.writeTextFile({
              workspaceId: WORKSPACE,
              versionId: "main",
              path: "Projects/Lossy.md",
              text: "---\nid: rec_dddddddddddddddddddddddddd\nStatus: Todo\n---\n1. Run this:\n\n       pnpm install\n\n2. Done\n",
              publish: true,
              metadata: { origin: "api" },
            });
          },
        );
        await desktop.push();

        const lossyObjId = stack.storage.currentFileObjectId({
          workspaceId: WORKSPACE,
          versionId: "main",
          path: "Projects/Lossy.md",
        });
        expect(lossyObjId).toBeTruthy();
        const lossyRefusal = await stack.phoneOp<{
          ok: false;
          refusal: string;
          reason: string;
        }>("editDocumentRecordFields", {
          path: "Projects/Lossy.md",
          expectedObjectId: lossyObjId!,
          fields: { Status: "Done" },
          requestId: "fallback-lossy-1",
        });
        expect(lossyRefusal).toMatchObject({ ok: false, refusal: "edit-refused" });

        const alphaObjId = stack.storage.objectIdAtPathInVersion({
          workspaceId: WORKSPACE,
          versionId: "main",
          path: "Projects/Alpha.md",
        });
        expect(alphaObjId).toBeTruthy();
        expect(
          stack.storage.mainLiveLineageExists({ workspaceId: WORKSPACE, objectId: alphaObjId! }),
        ).toBe(false);
        expect(await stack.phoneOp("openPage", { path: "Projects/Alpha.md" })).toEqual({
          status: "refused",
          reason: "live-document-without-lineage",
        });

        // Desktop opens Alpha.md locally and edits its body concurrently (before pushing).
        const desktopSession = await desktop.capture.openYDocSession({
          path: "Projects/Alpha.md",
          contentKind: "richdoc",
          onRemoteUpdate: () => undefined,
        });
        const bodyUpdate = documentEditUpdate(
          Y.encodeStateAsUpdate(desktopSession.doc),
          { replacement: "Concurrent desktop body edit" },
          { keepBlocks: false },
        );
        if (!(bodyUpdate instanceof Uint8Array)) throw new Error("documentEditUpdate failed");
        await desktopSession.applyLocalUpdate(bodyUpdate);
        await desktopSession.settleNow({ summary: "Desktop body edit" });
        await desktopSession.close();

        // Concurrently, phone edits Status via unopened-record fallback editDocumentRecordFields.
        const edited = await stack.phoneOp<{ ok: true; path: string; objectId: string }>(
          "editDocumentRecordFields",
          {
            path: "Projects/Alpha.md",
            expectedObjectId: alphaObjId!,
            fields: { Status: "Done" },
            requestId: "fallback-prop-1",
          },
        );
        expect(edited).toEqual({ ok: true, path: "Projects/Alpha.md", objectId: alphaObjId! });

        // Sync desktop with relay (pull + push + pull): BOTH phone Status: Done AND desktop body edit survive!
        await desktop.pull();
        await desktop.push();
        await desktop.pull();
        const merged = await readFile(join(desktop.root, "Projects/Alpha.md"), "utf8");
        expect(merged).toContain("Status: Done");
        expect(merged).toContain("Concurrent desktop body edit");
      },
      REAL_DAEMON_DEADLINE_MS * 3,
    );

    it(
      "Proof 1 (PR 8c): captureInboxItem lazily creates Inbox, is idempotent across retries, opens live with zero desktop, and interoperates with desktop listInboxItems",
      async () => {
        const stack = await startRealStack();
        const first = await stack.phoneOp<{
          ok: true;
          path: string;
          objectId: string;
          recordId: string;
        }>("captureInboxItem", {
          title: "Flight receipts",
          body: "Check boarding pass PDF",
          url: "https://example.com/trips/lisbon",
          kind: "link",
          requestId: "cap-req-1",
        });
        expect(first.ok).toBe(true);
        expect(first.path).toMatch(/^Inbox\/\d{4}-\d{2}-\d{2}-flight-receipts-[a-z0-9]{6}\.md$/u);
        expect(isRecordId(first.recordId)).toBe(true);

        // Idempotent retry with exact same requestId creates zero duplicate records.
        const replay = await stack.phoneOp<typeof first>("captureInboxItem", {
          title: "Flight receipts",
          body: "Check boarding pass PDF",
          url: "https://example.com/trips/lisbon",
          kind: "link",
          requestId: "cap-req-1",
        });
        expect(replay).toEqual(first);

        // Captured Inbox note opens live immediately on phone with zero desktop running.
        const live = await stack.openPhoneLive(first.path);
        await live.editBody("Added on phone right after capture");
        await live.waitSettled("Added on phone right after capture");
        await live.disconnect();

        // Second capture appends into existing Inbox without recreating collection.yaml.
        const second = await stack.phoneOp<typeof first>("captureInboxItem", {
          body: "Buy espresso beans",
          kind: "note",
          requestId: "cap-req-2",
        });
        expect(second.ok).toBe(true);

        // Phone Document Collection view shows both Inbox items with their Title: frontmatter.
        const phoneInbox = await stack.phoneOp<{
          ok: true;
          records: Array<{
            path: string;
            title: string;
            recordId: string | null;
            values: Record<string, unknown>;
          }>;
        }>("documentCollectionRecords", { collectionPath: "Inbox" });
        expect(phoneInbox.records.map((r) => r.title).sort()).toEqual([
          "Buy espresso beans",
          "Flight receipts",
        ]);

        // Desktop syncs and reads both items cleanly through desktop's own listInboxItems.
        const desktop = await stack.connectDesktop("desktop-inbox-interop");
        await desktop.pull();
        const desktopInbox = await listInboxItems(
          { workspaceId: WORKSPACE, rootPath: desktop.root },
          { status: "New" },
          {
            withAdapter: (fn) =>
              desktop.desktop.sessions.run(desktop.desktop.workspace, ({ client, workspace }) =>
                fn(new VersionedLiveAdapter(client, workspace, { workspaceId: WORKSPACE })),
              ),
          },
        );
        expect(desktopInbox.exists).toBe(true);
        expect(
          desktopInbox.items.map((i) => ({
            id: i.id,
            title: i.title,
            status: i.status,
            kind: i.kind,
            source: i.source,
          })),
        ).toEqual(
          expect.arrayContaining([
            {
              id: first.recordId,
              title: "Flight receipts",
              status: "New",
              kind: "link",
              source: "capture",
            },
            {
              id: second.recordId,
              title: "Buy espresso beans",
              status: "New",
              kind: "note",
              source: "capture",
            },
          ]),
        );
        const firstMd = await readFile(join(desktop.root, first.path), "utf8");
        expect(firstMd).toContain("URL: https://example.com/trips/lisbon");
        expect(firstMd).toContain("Added on phone right after capture");

        // Sol B3: deleting a captured record and replaying the original requestId acknowledges it without 503 or reviving the file.
        expect(
          await stack.phoneOp("deleteFile", {
            path: second.path,
            expectedObjectId: second.objectId,
            requestId: "cap-del-second",
          }),
        ).toMatchObject({ ok: true, path: second.path, objectId: second.objectId });
        expect(
          await stack.phoneOp("captureInboxItem", {
            body: "Buy espresso beans",
            kind: "note",
            requestId: "cap-req-2",
          }),
        ).toEqual(second);
        expect(
          stack.storage.objectIdAtPathInVersion({
            workspaceId: WORKSPACE,
            versionId: "main",
            path: second.path,
          }),
        ).toBeUndefined();
      },
      REAL_DAEMON_DEADLINE_MS * 3,
    );

    it(
      "Sol B2: a synced folder at Inbox/collection.yaml/ returns folder-occupied instead of 500",
      async () => {
        const stack = await startRealStack();
        const desktop = await stack.connectDesktop("desktop-inbox-dir-collision");
        await desktop.desktop.sessions.run(
          desktop.desktop.workspace,
          async ({ client, workspace }) => {
            await new VersionedLiveAdapter(client, workspace, {
              workspaceId: WORKSPACE,
            }).writeTextFile({
              workspaceId: WORKSPACE,
              versionId: "main",
              path: "Inbox/collection.yaml/nested.md",
              text: "blocker\n",
              publish: true,
              createOnly: true,
              metadata: { origin: "api" },
            });
          },
        );
        await desktop.push();
        expect(
          await stack.phoneOp("captureInboxItem", {
            body: "Should be refused cleanly",
            kind: "note",
            requestId: "cap-dir-collision",
          }),
        ).toMatchObject({ ok: false, refusal: "folder-occupied" });
      },
      REAL_DAEMON_DEADLINE_MS * 2,
    );
  },
);
