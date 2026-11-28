import { createServer as createHttpsServer } from "node:https";
import { mkdir, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getCACertificates, setDefaultCACertificates } from "node:tls";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import * as Y from "yjs";
import { serveFetchHandler, TokenBucketLimiter } from "@dohc/service-http";
import {
  UnauthorizedError,
  type AccountSession,
  type ResolveAccountSession,
  type ResolveActor,
  type StoredAccountSession,
} from "@dohc/workspace-auth/session";
import { ChatsLiveAdapter, VersionedLiveAdapter } from "@dohc/workspace-engine-client";
import { documentEditUpdate } from "@dohc/ydoc-projection";
import { admitBodySequenceNotes } from "@dohc/ydoc-projection/live-journal-validation";
import { createNamedLiveProvider } from "@dohc/ydoc-projection/named-live-provider";
import { mintLocalhostCa } from "../../share-web/src/testing/localhostCa";
import { openLiveDaemonWorkspace } from "../../../apps/desktop/e2e/helpers/daemonSeed";
import { requireEngineBinaryOrSkip } from "../../../apps/desktop/src/testing/engineBinary";
import {
  REAL_DAEMON_DEADLINE_MS,
  realDaemonReaderConfig,
} from "../../../apps/desktop/src/testing/realDaemonWorkspaceSessions";
import {
  createBackgroundLiveStart,
  syncedNotePaths,
} from "../../../apps/desktop/src/workspaces/backgroundLiveStart";
import { probeRelayWorkspace } from "../../../apps/desktop/src/workspaces/relayWorkspaceProbe";
import { createRelaySyncEngine } from "../../../apps/desktop/src/workspaces/relaySyncEngine";
import {
  RELAY_FETCH_TIMEOUT_MS,
  relayFetchWithTimeout,
} from "../../../apps/desktop/src/workspaces/sharedChannels";
import { createShowOnPhone } from "../../../apps/desktop/src/workspaces/showOnPhone";
import { installWorkspaceDataKey } from "../../../apps/desktop/src/workspaces/workspaceDataKey";
import { createWorkspaceEngineCapture } from "../../../apps/desktop/src/workspaces/workspaceEngineCapture";
import { bootstrapJoinedWorkspace } from "../../../apps/desktop/src/workspaces/workspaceJoinEnrollment";
import {
  AUTOMATION_REPLICA_BEARER_PREFIX,
  authorizeAutomationReplication,
} from "./automationReplicaCredential";
import { DiscussionActivityHub } from "./discussionActivity";
import { createNamedFrameChanges } from "./liveHostChanges";
import { createLiveConnectionAdmission } from "./liveConnectionAdmission";
import { createLiveRooms, LiveRoomBindingEndedError } from "./liveRoom";
import { createLiveTickets } from "./liveTickets";
import { createLiveHostReports } from "./namedLiveHostReports";
import { parseNamedLiveConfig } from "./namedLiveConfig";
import { captureOwnerLiveFrameHost } from "./namedLiveFrameHost";
import { createOwnerLiveRoutes } from "./namedLiveRoutes";
import { createPhonePages, type PhonePages } from "./phonePages";
import { initializeRelayDeployment, openRelayDeployment } from "./relayDeployment";
import { selfHostLiveProfile } from "./selfHostLiveProfile";
import { selfHostedLiveHostId, startSelfHostedLiveHost } from "./selfHostedLiveHost";
import { createSyncRelayHandler, streamsRequestBody } from "./server";
import { startServerCopies, type ServerCopies } from "./serverCopies";
import { authorizeServiceHostReplication } from "./serviceHostCredential";
import { createServiceHostReplication } from "./serviceHostReplication";
import { LIVE_ROOM_EDITS } from "./storage/liveRoomEdits";
import { workspaceOwner } from "./storage/workspaces";
import type { StorageContext } from "./storage/context";
import { closeTestStorages, tempRoot } from "./testing";
import type { LiveObjectBinding } from "@dohc/live-session-contract/live-object-binding";

const engine = requireEngineBinaryOrSkip();
const SERVICE_HOST_PREFIX = "dohc-service-v1.";
const LINK_KEY = "account-file-writes-e2e-link-key-32bytes";
const EXCHANGE_KEY = "account-file-writes-e2e-exchange-32bytes";
const OWNER = "owner-1";
const WORKSPACE = "workspace-files";

let sharedCaRoot = "";
let sharedCa: Awaited<ReturnType<typeof mintLocalhostCa>>;
let previousRoots: readonly string[];
beforeAll(async () => {
  if (engine.missing) return;
  admitBodySequenceNotes(true);
  sharedCaRoot = await realpath(await mkdtemp(join(tmpdir(), "dohc-file-writes-ca-")));
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

async function startRealStack(
  options: {
    pullLimitOverride?: () => number | null;
    maxVisibleSeq?: () => number | null;
    onLogFetch?: () => void;
    saveEveryMs?: number;
  } = {},
) {
  const root = await realpath(await tempRoot("file-writes-e2e"));
  const ca = sharedCa;

  const trustEnv = {
    NODE_EXTRA_CA_CERTS: ca.caPath,
    DOHC_ENGINE_TEST_RELAY_CA_MODE: "1",
    DOHC_ENGINE_TEST_RELAY_CA_FILE: ca.caPath,
    DOHC_E2E_ALLOW_INSECURE_LOOPBACK_RELAY: "0",
    DOHC_RELAY_ALLOW_UNISOLATED_PROJECTION: "1",
    DOHC_ENGINE_READER_CONFIG: realDaemonReaderConfig(),
  };
  for (const [key, value] of Object.entries(trustEnv)) vi.stubEnv(key, value);

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

  const resolvePhoneSessionLocal: ResolveAccountSession = async (request) => {
    const base = await resolvePhoneSession(request);
    return { ...base, expiresAtMs: sessionExpiry };
  };
  let copies: ServerCopies | undefined;
  let selfHost: Awaited<ReturnType<typeof startSelfHostedLiveHost>> | undefined;
  let phonePages: PhonePages | undefined;
  let rooms: ReturnType<typeof createLiveRooms> | undefined;

  let origin = "";
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

  const handleRequest = async (request: Request) => {
    const auth = request.headers.get("authorization") ?? "";
    if (auth.startsWith(`Bearer ${SERVICE_HOST_PREFIX}`)) return serviceRepl(request);
    if (auth.startsWith(`Bearer ${AUTOMATION_REPLICA_BEARER_PREFIX}`))
      return automationRepl(request);
    if (request.method === "GET") {
      const url = new URL(request.url);
      if (/^\/sync\/[^/]+\/log$/u.test(url.pathname) && !url.searchParams.has("hold")) {
        options.onLogFetch?.();
        const limitOverride = options.pullLimitOverride?.();
        if (limitOverride) url.searchParams.set("limit", String(limitOverride));
        const response = await relay(new Request(url, request));
        const cap = options.maxVisibleSeq?.();
        if (cap !== null && cap !== undefined && response.ok) {
          const payload = (await response.json()) as {
            ok: true;
            ops: Array<{ relaySeq: number }>;
            nextCursor: number;
            hasMore: boolean;
            [k: string]: unknown;
          };
          const requestedSince = Number(url.searchParams.get("since") ?? "0") || 0;
          const ops = payload.ops.filter((op) => op.relaySeq <= cap);
          const nextCursor = ops.length > 0 ? ops[ops.length - 1]!.relaySeq : requestedSince;
          const hasMore =
            ops.length < payload.ops.length ? false : payload.hasMore && nextCursor < cap;
          return new Response(JSON.stringify({ ...payload, ops, nextCursor, hasMore }), {
            status: response.status,
            headers: response.headers,
          });
        }
        return response;
      }
    }
    return relay(request);
  };

  const server = createHttpsServer({ key: ca.key, cert: ca.certificate });
  const listener = serveFetchHandler({
    handler: handleRequest,
    streamBody: streamsRequestBody,
    maxBodyBytes: () => 21 * 1024 * 1024,
    oversized: () => new Response(null, { status: 413 }),
    failure: () => new Response(null, { status: 500 }),
  });
  server.on("request", listener.listeners("request")[0] as never);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  origin = `https://127.0.0.1:${port}`;
  cleanup.push(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  const hostErrors: unknown[] = [];
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
    onError: (error) => {
      hostErrors.push(error);
      console.error("[test-selfHost]", error);
    },
  });
  cleanup.push(() => selfHost!.close());

  const captureNative = async (binding: LiveObjectBinding, signal: AbortSignal) => {
    const current = selfHost!.current();
    if (!current) throw new Error("Self-hosted live host is unavailable.");
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
    saveEveryMs: options.saveEveryMs ?? 100,
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

  const startCopies = async () => {
    const started = await startServerCopies({
      storage,
      root: copiesRoot,
      engineExecutable: engine.require(),
      relayOrigin: origin,
      key,
      namespace: deployment.history.namespace,
    });
    copies = started;
    return started;
  };
  await startCopies();
  cleanup.push(async () => {
    await copies?.close();
  });

  // Claim workspace with replication identity, zero desktop running.
  expect(
    storage.claimWorkspace({ workspaceId: WORKSPACE, ownerUserId: OWNER, createdAtMs: 1 }),
  ).toBe("created");
  storage.claimWorkspaceIdentity({
    workspaceId: WORKSPACE,
    replicationEpoch: "epoch-1",
    streamIdentity: "stream-1",
  });

  const phoneOp = async <T = unknown>(operation: string, args: Record<string, unknown>) => {
    const response = await fetch(`${origin}/sync/${WORKSPACE}/ops/${operation}`, {
      method: "POST",
      headers: {
        authorization: `Bearer session:${OWNER}:phone-1`,
        "content-type": "application/json",
      },
      body: JSON.stringify(args),
    });
    const text = await response.text();
    expect(response.status, `${operation}: ${text}`).toBe(200);
    return (JSON.parse(text) as { ok: true; result: T }).result;
  };

  const openPhoneLive = async (path: string) => {
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
        const answer = await phoneOp<OpenAnswer>("openPage", { path });
        if (answer.status === "refused") throw new Error(`openPage refused: ${answer.reason}`);
        expect(answer.status).toBe("ready");
        if (answer.status === "ready") ready = answer;
      },
      { timeout: REAL_DAEMON_DEADLINE_MS, interval: 100 },
    );
    const wsUrl = `${origin.replace(/^https:/, "wss:")}/sync/workspaces/${WORKSPACE}/live/owner?objectId=${encodeURIComponent(ready!.objectId)}&lineageClaimId=${encodeURIComponent(ready!.lineageClaimId)}`;
    const ws = new WebSocket(wsUrl, ["dohc-live-v1", `dohc-live-ticket.${ready!.ticket}`], {
      headers: { authorization: `Bearer session:${OWNER}:phone-1` },
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
    return {
      ready: ready!,
      provider,
      async editMarkdown(replacement: string) {
        const update = documentEditUpdate(
          Y.encodeStateAsUpdate(provider.doc),
          { replacement },
          { keepBlocks: false },
        );
        if (!(update instanceof Uint8Array))
          throw new Error(`documentEditUpdate failed: ${JSON.stringify(update)}`);
        Y.applyUpdate(provider.doc, update);
        try {
          await vi.waitFor(
            () => {
              const s = provider.state();
              if (s.status === "quarantined" || s.status === "disconnected")
                throw new Error(`provider stopped: ${JSON.stringify(s)}`);
              expect(s.pendingUpdates).toBe(0);
              expect(s.status).toBe("live");
            },
            { timeout: 5_000, interval: 50 },
          );
        } catch (err) {
          console.error(
            "[editMarkdown state]",
            JSON.stringify(provider.state()),
            "rooms/edits:",
            storage.db.prepare(`SELECT COUNT(*) AS c FROM ${LIVE_ROOM_EDITS}`).get(),
          );
          throw err;
        }
      },
      async waitSettled(expectedText: string) {
        await vi.waitFor(
          async () => {
            const pendingEdits = storage.db
              .prepare(
                `SELECT COUNT(*) AS count FROM ${LIVE_ROOM_EDITS} WHERE workspace_id=? AND object_id=?`,
              )
              .get(WORKSPACE, ready!.objectId) as { count: number };
            expect(pendingEdits.count).toBe(0);
            const doc = await phoneOp<{ ok?: boolean; markdown?: string }>("documentRead", {
              path,
            });
            expect(doc.markdown).toContain(expectedText);
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

  const restartCopies = async () => {
    await copies?.close();
    copies = undefined;
    await startCopies();
  };

  return {
    root,
    origin,
    storage,
    selfHost: () => selfHost!,
    rooms: () => rooms!,
    phoneOp,
    openPhoneLive,
    restartCopies,
    relayConnection: { baseUrl: origin, token: `test:${OWNER}` },
  };
}

describe.skipIf(engine.missing)(
  "owner file lifecycle E2E with real engine, live host, and desktop",
  () => {
    it(
      "Proof 1 (Ice 4A): creates a page on the phone with zero desktop online, edits it live immediately, and desktop adopts cleanly in both arrival orders",
      async () => {
        let pullLimit: number | null = null;
        let maxVisibleSeq: number | null = null;
        let logFetches = 0;
        const stack = await startRealStack({
          pullLimitOverride: () => pullLimit,
          maxVisibleSeq: () => maxVisibleSeq,
          onLogFetch: () => {
            logFetches += 1;
          },
        });

        // 1. Phone creates page with ZERO desktop online.
        const created = await stack.phoneOp<{ ok: true; path: string; objectId: string }>(
          "createPage",
          {
            path: "notes/from-phone.md",
            requestId: "proof1-create",
          },
        );
        expect(created).toMatchObject({ ok: true, path: "notes/from-phone.md" });
        expect(
          stack.storage.mainLiveLineageExists({
            workspaceId: WORKSPACE,
            objectId: created.objectId,
          }),
        ).toBe(true);

        // 2. Phone opens the brand-new page live IMMEDIATELY and edits it with zero desktop online.
        const live = await stack.openPhoneLive("notes/from-phone.md");
        await live.editMarkdown("Hello from phone live");
        await live.waitSettled("Hello from phone live");
        await live.disconnect();

        // 3A. Arrival Order A: Desktop A pulls 1 op per page (file moment materializes BEFORE ydoc lineage),
        //     with PR #4833's backgroundLiveStart active on afterSuccessfulPull.
        const rootA = join(stack.root, "desktop-a");
        await mkdir(rootA, { recursive: true });
        const desktopA = await openLiveDaemonWorkspace(
          { workspaceId: WORKSPACE, rootPath: rootA },
          { maxRestarts: 0, allowInsecureLoopbackForTests: false },
        );
        cleanup.push(() => desktopA.close());
        const captureA = createWorkspaceEngineCapture({
          ...desktopA.workspace,
          rustEngineSessions: desktopA.sessions,
        });
        cleanup.push(() => captureA.stop());
        const relayA = desktopA.relay.bind({ ...desktopA.workspace, relay: stack.relayConnection });
        const probeA = await probeRelayWorkspace({
          workspaceId: WORKSPACE,
          relay: stack.relayConnection,
        });
        await bootstrapJoinedWorkspace({
          workspaceId: WORKSPACE,
          identity: probeA.identity,
          transport: relayA,
          installDataKey: async (key) => await installWorkspaceDataKey(rootA, key),
        });

        const showOnPhone = createShowOnPhone({
          session: async () => ({
            generation: 1,
            relay: {
              ...stack.relayConnection,
              fetch: relayFetchWithTimeout(RELAY_FETCH_TIMEOUT_MS),
            },
            unauthorized: async () => undefined,
          }),
          onError: (_msg, err) => {
            throw err;
          },
        });
        const phoneErrors: unknown[] = [];
        let liveNotesCalls = 0;
        let localLiveStarts = 0;
        let syncA!: ReturnType<typeof createRelaySyncEngine>;
        const backgroundLiveStart = createBackgroundLiveStart({
          eligible: () => true,
          noteIdentity: async (targetWorkspaceId, path) =>
            await desktopA.sessions.run(
              desktopA.workspace,
              async ({ client, workspace: handle }) => {
                const resolved = await new VersionedLiveAdapter(client, handle, {
                  workspaceId: targetWorkspaceId,
                }).resolveFiles({ workspaceId: targetWorkspaceId, targets: [{ path }] });
                const file = resolved.results[0];
                return resolved.versionId === "main" && file?.status === "found"
                  ? { versionId: resolved.versionId, objectId: file.objectId }
                  : null;
              },
            ),
          showsOnPhone: async () => true,
          catchUp: async (_ws, signal) => {
            await syncA.catchUp({ signal });
            return !signal.aborted && syncA.snapshot().syncFailure === null;
          },
          relayLiveNotes: async (targetWorkspaceId, signal) => {
            liveNotesCalls += 1;
            return await showOnPhone.liveNotes(targetWorkspaceId, signal);
          },
          noteBytes: async (_ws, path) =>
            (await readFile(join(rootA, path)).catch(() => null))?.byteLength ?? null,
          isLossyNote: async () => false,
          start: async (_ws, path) => {
            localLiveStarts += 1;
            const session = await captureA.openYDocSession({
              path,
              contentKind: "richdoc",
              onRemoteUpdate: () => undefined,
            });
            await session.close();
          },
          onError: (_msg, error) => phoneErrors.push(error),
          quietMs: 25,
          gapMs: 25,
          maxWaitMs: 250,
        });
        cleanup.push(() => backgroundLiveStart.stop());

        // Cap Desktop A's initial pull at the file-creation moment so notes/from-phone.md materializes
        // and PR #4833 backgroundLiveStart runs BEFORE the ydoc lineage ops arrive (Arrival Order A).
        const logPage = stack.storage.fetchLogPage({
          workspaceId: WORKSPACE,
          sinceRelaySeq: 0,
          limit: 50,
        });
        const createOp = logPage.rows.find((row) => row.opKind === "moment.append");
        expect(createOp).toBeDefined();
        maxVisibleSeq = createOp!.relaySeq;
        pullLimit = 1;
        syncA = createRelaySyncEngine({
          rootDir: rootA,
          relay: stack.relayConnection,
          operations: relayA,
          capture: captureA,
          onChange: () => undefined,
          debounceMs: 25,
          afterSuccessfulPull: async ({ fastForwardedPaths }) => {
            const notes = syncedNotePaths(fastForwardedPaths);
            if (notes.length > 0) backgroundLiveStart.note(WORKSPACE, notes);
            backgroundLiveStart.retry(WORKSPACE);
          },
        });
        cleanup.push(() => syncA.stop());
        await syncA.start();

        // Verify file materialized and backgroundLiveStart checked /live-notes WITHOUT seeding a competing lineage.
        await vi.waitFor(
          async () => {
            await readFile(join(rootA, "notes/from-phone.md"), "utf8");
            expect(liveNotesCalls).toBeGreaterThanOrEqual(1);
          },
          { timeout: REAL_DAEMON_DEADLINE_MS, interval: 50 },
        );
        expect(localLiveStarts).toBe(0);

        // Now release the remaining lineage + live edit ops 1 per page.
        maxVisibleSeq = null;
        await syncA.catchUp({ signal: new AbortController().signal });
        await vi.waitFor(
          async () => {
            const text = await readFile(join(rootA, "notes/from-phone.md"), "utf8").catch(() => "");
            expect(text).toContain("Hello from phone live");
          },
          { timeout: REAL_DAEMON_DEADLINE_MS, interval: 100 },
        );
        expect(logFetches).toBeGreaterThanOrEqual(3);
        expect(localLiveStarts).toBe(0);
        expect(phoneErrors).toEqual([]);
        const sessionA = await captureA.openYDocSession({
          path: "notes/from-phone.md",
          contentKind: "richdoc",
          onRemoteUpdate: () => undefined,
        });
        expect(sessionA.lineageAtOpen).toBe("existing");
        await sessionA.close();
        const conflictsA = await desktopA.sessions.run(
          desktopA.workspace,
          async ({ client, workspace: handle }) =>
            new VersionedLiveAdapter(client, handle, { workspaceId: WORKSPACE }).listTextConflicts({
              workspaceId: WORKSPACE,
            }),
        );
        expect(conflictsA.conflicts).toEqual([]);

        // 3B. Arrival Order B: Desktop B pulls all ops together (lineage + file + live edits in one batch)
        //     and opens live note directly without conflict or quarantine.
        pullLimit = null;
        const rootB = join(stack.root, "desktop-b");
        await mkdir(rootB, { recursive: true });
        const desktopB = await openLiveDaemonWorkspace(
          { workspaceId: WORKSPACE, rootPath: rootB },
          { maxRestarts: 0, allowInsecureLoopbackForTests: false },
        );
        cleanup.push(() => desktopB.close());
        const captureB = createWorkspaceEngineCapture({
          ...desktopB.workspace,
          rustEngineSessions: desktopB.sessions,
        });
        cleanup.push(() => captureB.stop());
        const relayB = desktopB.relay.bind({ ...desktopB.workspace, relay: stack.relayConnection });
        const probeB = await probeRelayWorkspace({
          workspaceId: WORKSPACE,
          relay: stack.relayConnection,
        });
        await bootstrapJoinedWorkspace({
          workspaceId: WORKSPACE,
          identity: probeB.identity,
          transport: relayB,
          installDataKey: async (key) => await installWorkspaceDataKey(rootB, key),
        });
        await relayB.pull((apply) => captureB.runRelaySync(apply));
        expect(await readFile(join(rootB, "notes/from-phone.md"), "utf8")).toContain(
          "Hello from phone live",
        );
        const sessionB = await captureB.openYDocSession({
          path: "notes/from-phone.md",
          contentKind: "richdoc",
          onRemoteUpdate: () => undefined,
        });
        expect(sessionB.lineageAtOpen).toBe("existing");
        await sessionB.close();
        const conflictsB = await desktopB.sessions.run(
          desktopB.workspace,
          async ({ client, workspace: handle }) =>
            new VersionedLiveAdapter(client, handle, { workspaceId: WORKSPACE }).listTextConflicts({
              workspaceId: WORKSPACE,
            }),
        );
        expect(conflictsB.conflicts).toEqual([]);
      },
      4 * REAL_DAEMON_DEADLINE_MS,
    );

    it(
      "Proofs 2-6: idempotency, live-edited rename/delete + link rewrite + reopen, active/unsettled refusals, stale/collision refusals, sketch rename/delete, and desktop History undo",
      async () => {
        const stack = await startRealStack({ saveEveryMs: 60_000 });

        // Set up Desktop once for fixture seeding, interrupted-rename edits, and Proof 6 History restore.
        const desktopRoot = join(stack.root, "desktop-history");
        await mkdir(desktopRoot, { recursive: true });
        const desktop = await openLiveDaemonWorkspace(
          { workspaceId: WORKSPACE, rootPath: desktopRoot },
          { maxRestarts: 0, allowInsecureLoopbackForTests: false },
        );
        cleanup.push(() => desktop.close());
        const relay = desktop.relay.bind({ ...desktop.workspace, relay: stack.relayConnection });
        const probe = await probeRelayWorkspace({
          workspaceId: WORKSPACE,
          relay: stack.relayConnection,
        });
        await bootstrapJoinedWorkspace({
          workspaceId: WORKSPACE,
          identity: probe.identity,
          transport: relay,
          installDataKey: async (key) => await installWorkspaceDataKey(desktopRoot, key),
        });
        const desktopCapture = createWorkspaceEngineCapture({
          ...desktop.workspace,
          rustEngineSessions: desktop.sessions,
        });
        cleanup.push(() => desktopCapture.stop());
        const pushDesktop = async () => {
          for (let more = true; more;) more = (await relay.push()).hasMore;
        };

        // Seed a page via createPage (always empty body), plus a linking index page via Desktop.
        const created = await stack.phoneOp<{ ok: true; path: string; objectId: string }>(
          "createPage",
          {
            path: "notes/target.md",
            requestId: "req-create-target",
          },
        );
        expect(created).toMatchObject({ ok: true, path: "notes/target.md" });

        // Proof 2a: idempotent createPage retry (immediate + after replica restart) vs path-exists with new requestId.
        const createReplay = await stack.phoneOp<{ ok: true; path: string; objectId: string }>(
          "createPage",
          { path: "notes/target.md", requestId: "req-create-target" },
        );
        expect(createReplay).toEqual(created);
        await stack.restartCopies();
        const createReplayCold = await stack.phoneOp<{ ok: true; path: string; objectId: string }>(
          "createPage",
          { path: "notes/target.md", requestId: "req-create-target" },
        );
        expect(createReplayCold).toEqual(created);
        expect(
          await stack.phoneOp("createPage", {
            path: "notes/target.md",
            requestId: "req-create-different",
          }),
        ).toMatchObject({ ok: false, refusal: "path-exists" });

        await relay.pull((apply) => desktopCapture.runRelaySync(apply));
        await desktop.sessions.run(desktop.workspace, async ({ client, workspace: handle }) => {
          const adapter = new VersionedLiveAdapter(client, handle, { workspaceId: WORKSPACE });
          await adapter.writeTextFile({
            workspaceId: WORKSPACE,
            versionId: "main",
            path: "notes/index.md",
            text: "See [[target]] and [[sketches/board.excalidraw]] for details.\n",
            publish: true,
            createOnly: true,
            metadata: { origin: "api" },
          });
        });
        await pushDesktop();

        // Open target live and edit it from the phone (with production-style 60s saveEveryMs so LIVE_ROOM_EDITS stays buffered).
        const live = await stack.openPhoneLive("notes/target.md");
        await live.editMarkdown("Live edit before rename");

        // Proof 4a: active editor refuses rename and delete without calling host.stop or rooms.saveFirst.
        const stopSpy = vi.spyOn(stack.selfHost(), "stop");
        const saveFirstSpy = vi.spyOn(stack.rooms(), "saveFirst");
        expect(
          await stack.phoneOp("renameFile", {
            fromPath: "notes/target.md",
            toPath: "notes/blocked.md",
            expectedObjectId: created.objectId,
            requestId: "req-rename-active",
          }),
        ).toMatchObject({ ok: false, refusal: "live-active" });
        expect(
          await stack.phoneOp("deleteFile", {
            path: "notes/target.md",
            expectedObjectId: created.objectId,
            requestId: "req-delete-active",
          }),
        ).toMatchObject({ ok: false, refusal: "live-active" });
        expect(stopSpy).not.toHaveBeenCalled();
        expect(saveFirstSpy).not.toHaveBeenCalled();
        stopSpy.mockRestore();
        saveFirstSpy.mockRestore();

        // Disconnect immediately WITHOUT waitSettled(): renameFile must flush buffered room edits via rooms.saveFirst!
        await live.disconnect();

        // Proof 4b: unsettled LIVE_ROOM_EDITS with failing save refuses rename and delete (insert an invalid/orphan row after settling).
        const flushLive = await stack.openPhoneLive("notes/target.md");
        await flushLive.editMarkdown("Live edit flushed on immediate rename");
        await flushLive.disconnect();

        // Proof 5: stale expectedObjectId, occupied target, and missing source refusals.
        expect(
          await stack.phoneOp("renameFile", {
            fromPath: "notes/target.md",
            toPath: "notes/other.md",
            expectedObjectId: "wrong-object-id",
            requestId: "req-rename-stale",
          }),
        ).toMatchObject({ ok: false, refusal: "stale-object" });
        expect(
          await stack.phoneOp("renameFile", {
            fromPath: "notes/target.md",
            toPath: "notes/index.md",
            expectedObjectId: created.objectId,
            requestId: "req-rename-exists",
          }),
        ).toMatchObject({ ok: false, refusal: "path-exists" });
        expect(
          await stack.phoneOp("renameFile", {
            fromPath: "notes/missing.md",
            toPath: "notes/other.md",
            expectedObjectId: created.objectId,
            requestId: "req-rename-missing",
          }),
        ).toMatchObject({ ok: false, refusal: "not-found" });
        expect(
          await stack.phoneOp("deleteFile", {
            path: "notes/target.md",
            expectedObjectId: "wrong-object-id",
            requestId: "req-delete-stale",
          }),
        ).toMatchObject({ ok: false, refusal: "stale-object" });
        expect(
          await stack.phoneOp("deleteFile", {
            path: "notes/missing.md",
            expectedObjectId: created.objectId,
            requestId: "req-delete-missing",
          }),
        ).toMatchObject({ ok: false, refusal: "not-found" });

        // Proof 3a: immediate rename after disconnect flushes buffered room edits via saveFirst, retires enrollment, rewrites links, and rebinds.
        const renamed = await stack.phoneOp<{
          ok: true;
          fromPath: string;
          path: string;
          objectId: string;
          linksUpdated: number;
        }>("renameFile", {
          fromPath: "notes/target.md",
          toPath: "notes/renamed.md",
          expectedObjectId: created.objectId,
          requestId: "req-rename-ok",
        });
        expect(renamed).toMatchObject({
          ok: true,
          fromPath: "notes/target.md",
          path: "notes/renamed.md",
          objectId: created.objectId,
        });
        expect(renamed.linksUpdated).toBeGreaterThanOrEqual(1);
        const renamedRead = await stack.phoneOp<{
          ok?: boolean;
          markdown?: string;
          objectId?: string;
        }>("documentRead", { path: "notes/renamed.md" });
        expect(renamedRead.markdown).toContain("Live edit flushed on immediate rename");
        expect(renamedRead.objectId).toBe(created.objectId);
        const indexRead = await stack.phoneOp<{ ok?: boolean; markdown?: string }>("documentRead", {
          path: "notes/index.md",
        });
        expect(indexRead.markdown).toContain("[[renamed]]");

        // Proof 2b: idempotent renameFile retry (even after replica restart).
        await stack.restartCopies();
        expect(
          await stack.phoneOp("renameFile", {
            fromPath: "notes/target.md",
            toPath: "notes/renamed.md",
            expectedObjectId: created.objectId,
            requestId: "req-rename-ok",
          }),
        ).toMatchObject({
          ok: true,
          fromPath: "notes/target.md",
          path: "notes/renamed.md",
          objectId: created.objectId,
        });

        // Proof 3b: reopen renamed page live and edit it cleanly, then test unsettled LIVE_ROOM_EDITS refusal on delete.
        const liveRenamed = await stack.openPhoneLive("notes/renamed.md");
        await liveRenamed.editMarkdown("Edited after rename");
        await liveRenamed.disconnect();
        await liveRenamed.waitSettled("Edited after rename");

        // Proof 4b: corrupt/unsettled LIVE_ROOM_EDITS row that cannot save refuses rename and delete with live-unsettled.
        stack.storage.db
          .prepare(
            `INSERT INTO ${LIVE_ROOM_EDITS}(workspace_id,main_version_id,object_id,lineage_claim_id,sender_snapshot_json,update_bytes,received_at_ms,storage_bytes)
           VALUES (?,?,?,?,'[]',X'00',10,16)`,
          )
          .run(WORKSPACE, "main", created.objectId, liveRenamed.ready.lineageClaimId);
        expect(
          await stack.phoneOp("renameFile", {
            fromPath: "notes/renamed.md",
            toPath: "notes/blocked.md",
            expectedObjectId: created.objectId,
            requestId: "req-rename-unsettled",
          }),
        ).toMatchObject({ ok: false, refusal: "live-unsettled" });
        expect(
          await stack.phoneOp("deleteFile", {
            path: "notes/renamed.md",
            expectedObjectId: created.objectId,
            requestId: "req-delete-unsettled",
          }),
        ).toMatchObject({ ok: false, refusal: "live-unsettled" });
        stack.storage.db
          .prepare(`DELETE FROM ${LIVE_ROOM_EDITS} WHERE workspace_id=? AND object_id=?`)
          .run(WORKSPACE, created.objectId);

        // Proof 3c: delete previously live-edited page + idempotent retry + enrollment cleared.
        const deleted = await stack.phoneOp<{
          ok: true;
          path: string;
          objectId: string;
          deleteMomentId: string;
        }>("deleteFile", {
          path: "notes/renamed.md",
          expectedObjectId: created.objectId,
          requestId: "req-delete-ok",
        });
        expect(deleted).toEqual({
          ok: true,
          path: "notes/renamed.md",
          objectId: created.objectId,
          deleteMomentId: expect.any(String),
        });
        expect(
          stack.storage.readServiceHostEnrollmentByObjectId(WORKSPACE, created.objectId),
        ).toBeNull();
        await stack.restartCopies();
        expect(
          await stack.phoneOp("deleteFile", {
            path: "notes/renamed.md",
            expectedObjectId: created.objectId,
            requestId: "req-delete-ok",
          }),
        ).toEqual(deleted);

        // Proof 6: Desktop History sees the phone-deleted file and restores it via History Restore!
        await relay.pull((apply) => desktopCapture.runRelaySync(apply));

        // File is deleted on desktop disk after pulling phone delete.
        await expect(readFile(join(desktopRoot, "notes/renamed.md"), "utf8")).rejects.toThrow();

        // Desktop History finds the phone delete moment (with its correlation ID) and restores it via History Restore!
        const moments = await desktopCapture.listMoments({ objectId: created.objectId, limit: 10 });
        const deleteMoment = moments.moments.find((m) => m.operation === "delete");
        expect(deleteMoment?.path).toBe("notes/renamed.md");
        await desktop.sessions.run(desktop.workspace, async ({ client, workspace: handle }) => {
          const adapter = new VersionedLiveAdapter(client, handle, { workspaceId: WORKSPACE });
          const raw = await adapter.listMoments({
            workspaceId: WORKSPACE,
            versionId: "main",
            objectId: created.objectId,
            limit: 5,
            metadataOnly: true,
          });
          expect(raw.moments.find((m) => m.operation === "delete")?.metadataCorrelationId).toBe(
            "dohc-operation:req-delete-ok",
          );
        });
        const restored = await desktopCapture.restoreFileToBeforeMoment(deleteMoment!.id, {
          kind: "human",
          humanId: OWNER,
        });
        expect(restored.path).toBe("notes/renamed.md");
        expect(await readFile(join(desktopRoot, "notes/renamed.md"), "utf8")).toContain(
          "Edited after rename",
        );

        // Sketch (.excalidraw) rename with interrupted link rewrite + intervening edit, then idempotent retry + delete.
        const sketchObjId = await desktop.sessions.run(
          desktop.workspace,
          async ({ client, workspace: handle }) => {
            const adapter = new VersionedLiveAdapter(client, handle, { workspaceId: WORKSPACE });
            const written = await adapter.writeTextFile({
              workspaceId: WORKSPACE,
              versionId: "main",
              path: "sketches/board.excalidraw",
              text: '{"type":"excalidraw","version":2,"elements":[]}\n',
              publish: true,
              createOnly: true,
              metadata: { origin: "api" },
            });
            return written.object.id;
          },
        );
        await pushDesktop();

        const interruptRewrite = vi
          .spyOn(VersionedLiveAdapter.prototype, "rewriteHistoryLinks")
          .mockRejectedValueOnce(new Error("interrupted link rewrite"));
        const interrupted = await fetch(`${stack.origin}/sync/${WORKSPACE}/ops/renameFile`, {
          method: "POST",
          headers: {
            authorization: `Bearer session:${OWNER}:phone-1`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            fromPath: "sketches/board.excalidraw",
            toPath: "sketches/wireframe.excalidraw",
            expectedObjectId: sketchObjId,
            requestId: "req-sketch-rename",
          }),
        });
        expect(interrupted.status).toBeGreaterThanOrEqual(500);
        interruptRewrite.mockRestore();

        // Edit the renamed sketch so its latest moment is "write" rather than "rename", then retry with the same requestId.
        await relay.pull((apply) => desktopCapture.runRelaySync(apply));
        await desktop.sessions.run(desktop.workspace, async ({ client, workspace: handle }) => {
          const adapter = new VersionedLiveAdapter(client, handle, { workspaceId: WORKSPACE });
          await adapter.writeTextFile({
            workspaceId: WORKSPACE,
            versionId: "main",
            path: "sketches/wireframe.excalidraw",
            text: '{"type":"excalidraw","version":2,"elements":[{"id":"e1"}]}\n',
            publish: true,
            metadata: { origin: "api" },
          });
        });
        await pushDesktop();

        const retriedSketchRename = await stack.phoneOp<{
          ok: true;
          fromPath: string;
          path: string;
          objectId: string;
          linksUpdated: number;
        }>("renameFile", {
          fromPath: "sketches/board.excalidraw",
          toPath: "sketches/wireframe.excalidraw",
          expectedObjectId: sketchObjId,
          requestId: "req-sketch-rename",
        });
        expect(retriedSketchRename).toMatchObject({
          ok: true,
          fromPath: "sketches/board.excalidraw",
          path: "sketches/wireframe.excalidraw",
          objectId: sketchObjId,
        });
        expect(retriedSketchRename.linksUpdated).toBeGreaterThanOrEqual(1);
        const indexAfterSketch = await stack.phoneOp<{ ok?: boolean; markdown?: string }>(
          "documentRead",
          { path: "notes/index.md" },
        );
        expect(indexAfterSketch.markdown).toContain("[[sketches/wireframe.excalidraw]]");

        expect(
          await stack.phoneOp("deleteFile", {
            path: "sketches/wireframe.excalidraw",
            expectedObjectId: sketchObjId,
            requestId: "req-sketch-delete",
          }),
        ).toEqual({
          ok: true,
          path: "sketches/wireframe.excalidraw",
          objectId: sketchObjId,
          deleteMomentId: expect.any(String),
        });

        // Collection ancestry: writes inside a Collection folder (holding dataset.json) are rejected with 400.
        const collectionDocId = await desktop.sessions.run(
          desktop.workspace,
          async ({ client, workspace: handle }) => {
            const adapter = new VersionedLiveAdapter(client, handle, { workspaceId: WORKSPACE });
            await adapter.writeTextFile({
              workspaceId: WORKSPACE,
              versionId: "main",
              path: "tasks/dataset.json",
              text: '{"name":"Tasks"}\n',
              publish: true,
              createOnly: true,
              metadata: { origin: "api" },
            });
            return (
              await adapter.writeTextFile({
                workspaceId: WORKSPACE,
                versionId: "main",
                path: "tasks/record.md",
                text: "# Task\n",
                publish: true,
                createOnly: true,
                metadata: { origin: "api" },
              })
            ).object.id;
          },
        );
        await pushDesktop();
        for (const [operation, args] of [
          ["createPage", { path: "tasks/new.md", requestId: "req-col-create" }],
          [
            "renameFile",
            {
              fromPath: "tasks/record.md",
              toPath: "tasks/renamed.md",
              expectedObjectId: collectionDocId,
              requestId: "req-col-rename",
            },
          ],
          [
            "deleteFile",
            {
              path: "tasks/record.md",
              expectedObjectId: collectionDocId,
              requestId: "req-col-delete",
            },
          ],
        ] as const) {
          const resp = await fetch(`${stack.origin}/sync/${WORKSPACE}/ops/${operation}`, {
            method: "POST",
            headers: {
              authorization: `Bearer session:${OWNER}:phone-1`,
              "content-type": "application/json",
            },
            body: JSON.stringify(args),
          });
          expect(resp.status, operation).toBe(400);
        }

        // Source replacement during holdCapture acquisition must refuse stale-object and never move the replacement.
        const swap = await stack.phoneOp<{ ok: true; path: string; objectId: string }>(
          "createPage",
          { path: "notes/swap.md", requestId: "req-create-swap" },
        );
        const origHold = VersionedLiveAdapter.prototype.holdCapture;
        let replacementId = "";
        const swapSpy = vi
          .spyOn(VersionedLiveAdapter.prototype, "holdCapture")
          .mockImplementationOnce(async function (this: VersionedLiveAdapter, input) {
            await this.renameTextFile({
              workspaceId: WORKSPACE,
              versionId: "main",
              fromPath: "notes/swap.md",
              toPath: "notes/swap-old.md",
              metadata: { origin: "api" },
            });
            replacementId = (
              await this.writeTextFile({
                workspaceId: WORKSPACE,
                versionId: "main",
                path: "notes/swap.md",
                text: "Replacement",
                publish: true,
                metadata: { origin: "api" },
              })
            ).object.id;
            return await origHold.call(this, input);
          });
        const staleSwap = await stack.phoneOp("renameFile", {
          fromPath: "notes/swap.md",
          toPath: "notes/swapped.md",
          expectedObjectId: swap.objectId,
          requestId: "req-rename-swap",
        });
        swapSpy.mockRestore();
        expect(replacementId).not.toBe(swap.objectId);
        expect(staleSwap).toMatchObject({ ok: false, refusal: "stale-object" });
        const afterSwap = await stack.phoneOp<{ ok?: boolean; objectId?: string }>("documentRead", {
          path: "notes/swap.md",
        });
        expect(afterSwap).toMatchObject({ ok: true, objectId: replacementId });

        // Deeply nested path (>64 segments -> >128 collection markers) batches marker checks cleanly.
        const deepDir = "a/".repeat(64);
        const deepPath = `${deepDir}leaf.md`;
        const deepRenamed = `${deepDir}leaf-renamed.md`;
        const deepCreated = await stack.phoneOp<{ ok: true; path: string; objectId: string }>(
          "createPage",
          { path: deepPath, requestId: "req-deep-create" },
        );
        expect(deepCreated).toMatchObject({ ok: true, path: deepPath });
        expect(
          await stack.phoneOp("renameFile", {
            fromPath: deepPath,
            toPath: deepRenamed,
            expectedObjectId: deepCreated.objectId,
            requestId: "req-deep-rename",
          }),
        ).toMatchObject({ ok: true, fromPath: deepPath, path: deepRenamed });
        expect(
          await stack.phoneOp("deleteFile", {
            path: deepRenamed,
            expectedObjectId: deepCreated.objectId,
            requestId: "req-deep-delete",
          }),
        ).toEqual({
          ok: true,
          path: deepRenamed,
          objectId: deepCreated.objectId,
          deleteMomentId: expect.any(String),
        });
      },
      4 * REAL_DAEMON_DEADLINE_MS,
    );

    it(
      "Proofs 3-4 (PR 8c): restoreDeletedFile preserves objectId, re-seeds live lineage for immediate live editing, restores sketches, is idempotent, and maps occupied/unavailable refusals",
      async () => {
        const stack = await startRealStack();
        const desktopRoot = join(stack.root, "desktop-restore");
        await mkdir(desktopRoot, { recursive: true });
        const desktop = await openLiveDaemonWorkspace(
          { workspaceId: WORKSPACE, rootPath: desktopRoot },
          { maxRestarts: 0, allowInsecureLoopbackForTests: false },
        );
        cleanup.push(() => desktop.close());
        const relay = desktop.relay.bind({ ...desktop.workspace, relay: stack.relayConnection });
        const probe = await probeRelayWorkspace({
          workspaceId: WORKSPACE,
          relay: stack.relayConnection,
        });
        await bootstrapJoinedWorkspace({
          workspaceId: WORKSPACE,
          identity: probe.identity,
          transport: relay,
          installDataKey: async (key) => await installWorkspaceDataKey(desktopRoot, key),
        });
        const desktopCapture = createWorkspaceEngineCapture({
          ...desktop.workspace,
          rustEngineSessions: desktop.sessions,
        });
        cleanup.push(() => desktopCapture.stop());
        const pushDesktop = async () => {
          for (let more = true; more;) more = (await relay.push()).hasMore;
        };

        // Create and live-edit a Markdown page on phone, then attach a file-comment thread linked to its objectId.
        const page = await stack.phoneOp<{ ok: true; path: string; objectId: string }>(
          "createPage",
          { path: "notes/undo-me.md", requestId: "req-undo-create" },
        );
        const liveBefore = await stack.openPhoneLive("notes/undo-me.md");
        await liveBefore.editMarkdown("Important live content before delete");
        await liveBefore.waitSettled("Important live content before delete");
        await liveBefore.disconnect();
        await relay.pull((apply) => desktopCapture.runRelaySync(apply));
        const commentThreadId = await desktop.sessions.run(
          desktop.workspace,
          async ({ client, workspace: handle }) => {
            const chats = new ChatsLiveAdapter(client, handle, { workspaceId: WORKSPACE });
            const thread = await chats.createThread({
              workspaceId: WORKSPACE,
              title: "Undo review",
              linkedFile: { objectId: page.objectId, pathHint: "notes/undo-me.md" },
            });
            await chats.sendMessage({
              workspaceId: WORKSPACE,
              threadId: thread.id,
              author: { kind: "human", displayName: "Owner" },
              authorUserId: OWNER,
              authorActorKey: null,
              body: "Keep this comment linked after undo.",
            });
            return thread.id;
          },
        );
        await pushDesktop();
        expect(
          await stack.phoneOp<{ threads: Array<{ id: string }> }>("fileChats", {
            path: "notes/undo-me.md",
          }),
        ).toMatchObject({ threads: [expect.objectContaining({ id: commentThreadId })] });

        // Delete the previously live-edited page and verify deleteMomentId + idempotent replay.
        const del = await stack.phoneOp<{
          ok: true;
          path: string;
          objectId: string;
          deleteMomentId: string;
        }>("deleteFile", {
          path: "notes/undo-me.md",
          expectedObjectId: page.objectId,
          requestId: "req-undo-delete",
        });
        expect(del).toEqual({
          ok: true,
          path: "notes/undo-me.md",
          objectId: page.objectId,
          deleteMomentId: expect.any(String),
        });
        expect(
          await stack.phoneOp("deleteFile", {
            path: "notes/undo-me.md",
            expectedObjectId: page.objectId,
            requestId: "req-undo-delete",
          }),
        ).toEqual(del);

        // Restore via restoreDeletedFile: preserves exact objectId, file-comment links, and re-seeds live lineage!
        const restored = await stack.phoneOp<{ ok: true; path: string; objectId: string }>(
          "restoreDeletedFile",
          {
            path: "notes/undo-me.md",
            objectId: page.objectId,
            deleteMomentId: del.deleteMomentId,
            requestId: "req-undo-restore",
          },
        );
        expect(restored).toEqual({ ok: true, path: "notes/undo-me.md", objectId: page.objectId });
        expect(
          await stack.phoneOp<{ threads: Array<{ id: string }> }>("fileChats", {
            path: "notes/undo-me.md",
          }),
        ).toMatchObject({ threads: [expect.objectContaining({ id: commentThreadId })] });

        // Idempotent retry after replica restart returns exact same ok result.
        await stack.restartCopies();
        expect(
          await stack.phoneOp("restoreDeletedFile", {
            path: "notes/undo-me.md",
            objectId: page.objectId,
            deleteMomentId: del.deleteMomentId,
            requestId: "req-undo-restore",
          }),
        ).toEqual(restored);

        // CRITICAL: Restored page immediately opens live on phone with ZERO desktop online and edits cleanly!
        const liveAfter = await stack.openPhoneLive("notes/undo-me.md");
        await liveAfter.editMarkdown("Edited live after restore");
        await liveAfter.waitSettled("Edited live after restore");
        await liveAfter.disconnect();

        // Desktop syncs and sees the restored file + post-restore live edit with exact same objectId and zero conflicts.
        await vi.waitFor(
          async () => {
            await relay.pull((apply) => desktopCapture.runRelaySync(apply));
            expect(await readFile(join(desktopRoot, "notes/undo-me.md"), "utf8")).toContain(
              "Edited live after restore",
            );
          },
          { timeout: REAL_DAEMON_DEADLINE_MS, interval: 100 },
        );
        const restoredDesktopLive = await desktopCapture.openYDocSession({
          path: "notes/undo-me.md",
          contentKind: "richdoc",
          onRemoteUpdate: () => undefined,
        });
        expect(restoredDesktopLive.lineageAtOpen).toBe("existing");
        await restoredDesktopLive.close();
        const desktopResolved = await desktop.sessions.run(
          desktop.workspace,
          async ({ client, workspace: handle }) => {
            const adapter = new VersionedLiveAdapter(client, handle, { workspaceId: WORKSPACE });
            const [res, conflicts] = await Promise.all([
              adapter.resolveFiles({
                workspaceId: WORKSPACE,
                targets: [{ path: "notes/undo-me.md" }],
              }),
              adapter.listTextConflicts({ workspaceId: WORKSPACE }),
            ]);
            return { res: res.results[0], conflicts: conflicts.conflicts };
          },
        );
        expect(desktopResolved.res).toMatchObject({ status: "found", objectId: page.objectId });
        expect(desktopResolved.conflicts).toEqual([]);

        // Sketch (.excalidraw) delete + restore preserves exact objectId and scene JSON.
        const sketchScene = '{"type":"excalidraw","version":2,"elements":[{"id":"box-1"}]}\n';
        const sketchObjId = await desktop.sessions.run(
          desktop.workspace,
          async ({ client, workspace: handle }) =>
            (
              await new VersionedLiveAdapter(client, handle, {
                workspaceId: WORKSPACE,
              }).writeTextFile({
                workspaceId: WORKSPACE,
                versionId: "main",
                path: "sketches/undo.excalidraw",
                text: sketchScene,
                publish: true,
                createOnly: true,
                metadata: { origin: "api" },
              })
            ).object.id,
        );
        await pushDesktop();
        const delSketch = await stack.phoneOp<{
          ok: true;
          path: string;
          objectId: string;
          deleteMomentId: string;
        }>("deleteFile", {
          path: "sketches/undo.excalidraw",
          expectedObjectId: sketchObjId,
          requestId: "req-del-sketch",
        });
        expect(
          await stack.phoneOp("restoreDeletedFile", {
            path: "sketches/undo.excalidraw",
            objectId: sketchObjId,
            deleteMomentId: delSketch.deleteMomentId,
            requestId: "req-restore-sketch",
          }),
        ).toEqual({ ok: true, path: "sketches/undo.excalidraw", objectId: sketchObjId });
        await relay.pull((apply) => desktopCapture.runRelaySync(apply));
        expect(await readFile(join(desktopRoot, "sketches/undo.excalidraw"), "utf8")).toBe(
          sketchScene,
        );

        // Edge case 1: occupied path returns path-exists (never 500).
        const occ = await stack.phoneOp<{ ok: true; path: string; objectId: string }>(
          "createPage",
          {
            path: "notes/occupied.md",
            requestId: "req-occ-1",
          },
        );
        const delOcc = await stack.phoneOp<{
          ok: true;
          path: string;
          objectId: string;
          deleteMomentId: string;
        }>("deleteFile", {
          path: "notes/occupied.md",
          expectedObjectId: occ.objectId,
          requestId: "req-occ-del",
        });
        await stack.phoneOp("createPage", { path: "notes/occupied.md", requestId: "req-occ-2" });
        expect(
          await stack.phoneOp("restoreDeletedFile", {
            path: "notes/occupied.md",
            objectId: occ.objectId,
            deleteMomentId: delOcc.deleteMomentId,
            requestId: "req-occ-restore",
          }),
        ).toMatchObject({ ok: false, refusal: "path-exists" });

        // Edge case 2: unavailable/mismatched deleteMomentId returns restore-unavailable (never 500).
        expect(
          await stack.phoneOp("restoreDeletedFile", {
            path: "notes/occupied.md",
            objectId: occ.objectId,
            deleteMomentId: "nonexistent-moment-id",
            requestId: "req-bad-moment",
          }),
        ).toMatchObject({ ok: false, refusal: "restore-unavailable" });
      },
      4 * REAL_DAEMON_DEADLINE_MS,
    );
  },
);
