import { createHmac } from "node:crypto";
import { createServer as createHttpsServer } from "node:https";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getCACertificates, setDefaultCACertificates } from "node:tls";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import * as Y from "yjs";
import { parseAccessRule } from "@dohc/security-contract/access-rules";
import { serveFetchHandler, TokenBucketLimiter } from "@dohc/service-http";
import {
  UnauthorizedError,
  type AccountSession,
  type ResolveAccountSession,
  type ResolveActor,
  type StoredAccountSession,
} from "@dohc/workspace-auth/session";
import { documentEditUpdate, yDocToMarkdown } from "@dohc/ydoc-projection";
import { admitBodySequenceNotes } from "@dohc/ydoc-projection/live-journal-validation";
import { createNamedLiveProvider } from "@dohc/ydoc-projection/named-live-provider";
import type { LiveObjectBinding } from "@dohc/live-session-contract/live-object-binding";
import { mintLocalhostCa } from "../../share-web/src/testing/localhostCa";
import { openLiveDaemonWorkspace } from "../../../apps/desktop/e2e/helpers/daemonSeed";
import { requireEngineBinaryOrSkip } from "../../../apps/desktop/src/testing/engineBinary";
import {
  REAL_DAEMON_DEADLINE_MS,
  realDaemonReaderConfig,
} from "../../../apps/desktop/src/testing/realDaemonWorkspaceSessions";
import { createRelaySyncEngine } from "../../../apps/desktop/src/workspaces/relaySyncEngine";
import { createWorkspaceEngineCapture } from "../../../apps/desktop/src/workspaces/workspaceEngineCapture";
import { DiscussionActivityHub } from "./discussionActivity";
import { createNamedFrameChanges } from "./liveHostChanges";
import { createLiveConnectionAdmission } from "./liveConnectionAdmission";
import { createLiveRooms, LiveRoomBindingEndedError } from "./liveRoom";
import { createLiveTickets } from "./liveTickets";
import { createLiveHostReports } from "./namedLiveHostReports";
import { parseNamedLiveConfig } from "./namedLiveConfig";
import { captureOwnerLiveFrameHost } from "./namedLiveFrameHost";
import { createNamedLiveRoutes, createOwnerLiveRoutes } from "./namedLiveRoutes";
import {
  createPhoneMemberLiveSessions,
  createPhonePages,
  type PhoneMemberLiveSessions,
  type PhonePages,
} from "./phonePages";
import { initializeRelayDeployment, openRelayDeployment } from "./relayDeployment";
import { selfHostLiveProfile } from "./selfHostLiveProfile";
import { selfHostedLiveHostId, startSelfHostedLiveHost } from "./selfHostedLiveHost";
import { createSyncRelayHandler, streamsRequestBody } from "./server";
import { authorizeServiceHostReplication } from "./serviceHostCredential";
import { createServiceHostReplication } from "./serviceHostReplication";
import { LIVE_ROOM_EDITS } from "./storage/liveRoomEdits";
import { workspaceOwner } from "./storage/workspaces";
import type { StorageContext } from "./storage/context";
import { closeTestStorages, tempRoot } from "./testing";

const engine = requireEngineBinaryOrSkip();
const SERVICE_HOST_PREFIX = "dohc-service-v1.";
const LINK_KEY = "member-live-pages-e2e-link-key-32bytes";
const EXCHANGE_KEY = "member-live-pages-e2e-exchange-32bytes";
const OWNER = "owner-1";
const MEMBER = "member-1";
const WORKSPACE = "workspace-member-live";

let sharedCaRoot = "";
let sharedCa: Awaited<ReturnType<typeof mintLocalhostCa>>;
let previousRoots: readonly string[];

beforeAll(async () => {
  if (engine.missing) return;
  admitBodySequenceNotes(true);
  sharedCaRoot = await realpath(await mkdtemp(join(tmpdir(), "dohc-member-live-ca-")));
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

async function startRealMemberStack() {
  const root = await realpath(await tempRoot("member-live-e2e"));
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
  await mkdir(liveHostRoot, { recursive: true });

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
    ["phone-owner", { userId: OWNER, expiresAtMs: sessionExpiry, clientKind: "phone" }],
    ["phone-m1", { userId: MEMBER, expiresAtMs: sessionExpiry, clientKind: "phone" }],
    ["phone-m2", { userId: MEMBER, expiresAtMs: sessionExpiry, clientKind: "phone" }],
  ]);
  const accountSessions = {
    read: async (ids: readonly string[]) =>
      new Map(
        ids.flatMap((id): Array<[string, StoredAccountSession]> => {
          const found = storedSessions.get(id);
          return found ? [[id, found]] : [];
        }),
      ),
    list: async () => [],
    revoke: async () => null,
    phoneSessionIsCurrent: async ({ userId, sessionId }: { userId: string; sessionId: string }) => {
      const found = storedSessions.get(sessionId);
      return (
        found?.userId === userId && found.clientKind === "phone" && found.expiresAtMs > Date.now()
      );
    },
  };
  const resolvePhoneSession: ResolveAccountSession = async (request) => {
    const match = /^Bearer session:([\w-]+):([\w-]+)$/u.exec(
      request.headers.get("authorization") ?? "",
    );
    if (!match) throw new UnauthorizedError();
    return {
      userId: match[1]!,
      sessionId: match[2]!,
      expiresAtMs: sessionExpiry,
      clientKind: "phone",
    } satisfies AccountSession;
  };

  let selfHost: Awaited<ReturnType<typeof startSelfHostedLiveHost>> | undefined;
  let phonePages: PhonePages | undefined;
  let rooms: ReturnType<typeof createLiveRooms> | undefined;
  let ownerLive: ReturnType<typeof createOwnerLiveRoutes> | undefined;
  let phoneLive: ReturnType<typeof createNamedLiveRoutes> | undefined;
  let phoneMemberSessions: PhoneMemberLiveSessions | undefined;
  const copiesSpy = vi.fn(() => undefined);

  const relay = createSyncRelayHandler({
    storage,
    discussionActivity: activity,
    resolveActor,
    resolvePhoneCapableAccountSession: resolvePhoneSession,
    accountSessions,
    ownerLiveSockets: () => ({
      stopSession: (userId, sessionId) => {
        ownerLive?.stopSession(userId, sessionId);
        phoneLive?.stopSession(userId, sessionId);
        phoneMemberSessions?.stopSession(userId, sessionId);
      },
      stopPhoneWorkspace: (userId, workspaceId) => {
        ownerLive?.stopPhoneWorkspace(userId, workspaceId);
        phoneLive?.stopPhoneWorkspace(userId, workspaceId);
        phoneMemberSessions?.stopPhoneWorkspace(userId, workspaceId);
      },
    }),
    serverCopies: copiesSpy,
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

  const server = createHttpsServer({ key: ca.key, cert: ca.certificate });
  const listener = serveFetchHandler({
    handler: (request) => {
      const auth = request.headers.get("authorization") ?? "";
      return auth.startsWith(`Bearer ${SERVICE_HOST_PREFIX}`)
        ? serviceRepl(request)
        : relay(request);
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
    trustedAccount: (accountId) => ({ accountId, name: accountId }),
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
    if (!current) throw new Error("Self-hosted live host is unavailable.");
    return current.captureNative(binding, signal);
  };
  const hostReports = createLiveHostReports({ storage, captureNative });
  const tickets = createLiveTickets({ storage, audience: origin, key, hostReports });
  const phoneNamedTickets = createLiveTickets({
    storage,
    audience: origin,
    key: createHmac("sha256", LINK_KEY).update("dohc-phone-named-live-ticket").digest(),
    hostReports,
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

  const admission = createLiveConnectionAdmission();
  ownerLive = createOwnerLiveRoutes({
    rooms,
    storage,
    resolveAccountSession: resolvePhoneSession,
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
    admission,
  });
  cleanup.push(() => ownerLive!.close());

  phoneMemberSessions = createPhoneMemberLiveSessions({ storage, maxSessions: 16 });
  phoneLive = createNamedLiveRoutes({
    rooms,
    kind: "named",
    phoneBearer: true,
    resolveAccountSession: resolvePhoneSession,
    accountSessions,
    phoneSessions: phoneMemberSessions,
    storage,
    hosts: new Set([`127.0.0.1:${port}`]),
    publicOrigin: origin,
    exchangeKey: EXCHANGE_KEY,
    limits: namedLiveConfig.transport,
    frames: namedLiveConfig.frames,
    bounds,
    validate: namedLiveConfig.validate,
    tickets: phoneNamedTickets,
    captureNative,
    admission,
  });
  cleanup.push(() => phoneLive!.close());

  server.on("upgrade", (req, socket, head) => {
    if (/^\/sync\/workspaces\/[^/]+\/live\/owner(?:\?|$)/u.test(req.url ?? ""))
      void ownerLive!.handleUpgrade(req, socket, head).catch(() => socket.destroy());
    else if (req.url?.startsWith("/sync/live/phone?"))
      void phoneLive!.handleUpgrade(req, socket, head).catch(() => socket.destroy());
    else socket.destroy();
  });

  phonePages = createPhonePages({
    storage,
    history: deployment.history,
    host: selfHost,
    supported: () => true,
    tickets,
    phoneNamedTickets,
    phoneMemberSessions,
    sessions: accountSessions,
    nowMs: () => Date.now(),
    editorLimits: profile.editor,
  });

  // Start Owner's real desktop engine, seed pages, and push live lineages to the relay.
  const desktopRoot = join(root, "desktop-owner");
  await mkdir(join(desktopRoot, "shared"), { recursive: true });
  await mkdir(join(desktopRoot, "docs"), { recursive: true });
  await mkdir(join(desktopRoot, "private"), { recursive: true });
  await writeFile(join(desktopRoot, "shared", "plan.md"), "Initial shared plan\n", "utf8");
  await writeFile(join(desktopRoot, "docs", "spec.md"), "Read-only spec\n", "utf8");
  await writeFile(join(desktopRoot, "private", "notes.md"), "Private notes\n", "utf8");
  await writeFile(join(desktopRoot, "shared", ".env"), "SECRET=1\n", "utf8");

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
  const transport = desktop.relay.bind({ ...desktop.workspace, relay: relayConn });
  const sync = createRelaySyncEngine({
    rootDir: desktopRoot,
    relay: relayConn,
    operations: transport,
    capture,
    onChange: () => undefined,
    debounceMs: 25,
  });
  cleanup.push(() => sync.stop());
  await sync.start();

  const catchUp = () => sync.catchUp({ signal: new AbortController().signal });

  // Open each page once on desktop so its Y.Doc live lineage exists on the relay.
  for (const path of ["shared/plan.md", "docs/spec.md", "private/notes.md"]) {
    const s = await capture.openYDocSession({
      path,
      contentKind: "richdoc",
      onRemoteUpdate: () => undefined,
    });
    await s.close();
  }
  await vi.waitFor(
    async () => {
      await catchUp();
      const obj = storage.objectIdAtPathInVersion({
        workspaceId: WORKSPACE,
        versionId: "main",
        path: "shared/plan.md",
      });
      expect(obj).toBeDefined();
      expect(storage.mainLiveLineageExists({ workspaceId: WORKSPACE, objectId: obj! })).toBe(true);
    },
    { timeout: REAL_DAEMON_DEADLINE_MS, interval: 100 },
  );

  // Invite member-1 with default view, Edit on shared/, Read-only on docs/, hidden on private/.
  expect(
    storage.inviteWorkspaceMember({
      workspaceId: WORKSPACE,
      actorUserId: OWNER,
      workspaceName: "Shared Trip",
      email: "member@dohc.test",
      recipientUserId: MEMBER,
      newMemberId: () => "member-1",
      newGrantId: () => "grant-member-1",
      newShareId: () => "share-member-live",
      nowMs: 10,
    }),
  ).toMatchObject({ ok: true });
  const sharedRule = storage.changeFolderRule({
    workspaceId: WORKSPACE,
    actorUserId: OWNER,
    change: {
      kind: "create",
      folder: "shared",
      rule: parseAccessRule("members: edit\n")!,
    },
    nowMs: 11,
  });
  expect(sharedRule).toMatchObject({ ok: true });
  expect(
    storage.changeFolderRule({
      workspaceId: WORKSPACE,
      actorUserId: OWNER,
      change: {
        kind: "create",
        folder: "private",
        rule: parseAccessRule("people:\n  other@dohc.test: edit\n")!,
      },
      nowMs: 12,
    }),
  ).toMatchObject({ ok: true });

  type OpenReady = {
    status: "ready";
    mode?: "named";
    session?: string;
    liveWorkspaceId?: string;
    objectId: string;
    lineageClaimId: string;
    ticket: string;
    editorLimits: typeof profile.editor;
  };
  type OpenAnswer = OpenReady | { status: "preparing" } | { status: "refused"; reason: string };

  const callOp = async (as: string, operation: string, args: Record<string, unknown>) => {
    const response = await fetch(`${origin}/sync/${WORKSPACE}/ops/${operation}`, {
      method: "POST",
      headers: {
        authorization: `Bearer session:${as}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(args),
    });
    return { status: response.status, json: (await response.json()) as unknown };
  };

  const openPageUntilReady = async (as: string, path: string): Promise<OpenReady> => {
    let ready: OpenReady | undefined;
    await vi.waitFor(
      async () => {
        const res = await callOp(as, "openPage", { path });
        expect(res.status).toBe(200);
        const result = (res.json as { ok: true; result: OpenAnswer }).result;
        if (result.status === "refused") throw new Error(`openPage refused: ${result.reason}`);
        expect(result.status).toBe("ready");
        if (result.status === "ready") ready = result;
      },
      { timeout: REAL_DAEMON_DEADLINE_MS, interval: 100 },
    );
    return ready!;
  };

  const probeUpgrade = (url: string, ticket: string, as: string) =>
    new Promise<number>((resolve) => {
      const ws = new WebSocket(url, ["dohc-live-v1", `dohc-live-ticket.${ticket}`], {
        headers: { authorization: `Bearer session:${as}` },
        ca: ca.ca,
      });
      ws.once("upgrade", () => {
        ws.terminate();
        resolve(101);
      });
      ws.once("unexpected-response", (_req, res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      });
      ws.on("error", () => {});
    });

  const connectLive = async (ready: OpenReady, as: string) => {
    const wsUrl =
      ready.mode === "named"
        ? `${origin.replace(/^https:/, "wss:")}/sync/live/phone?session=${encodeURIComponent(ready.session!)}`
        : `${origin.replace(/^https:/, "wss:")}/sync/workspaces/${WORKSPACE}/live/owner?objectId=${encodeURIComponent(ready.objectId)}&lineageClaimId=${encodeURIComponent(ready.lineageClaimId)}`;
    const ws = new WebSocket(wsUrl, ["dohc-live-v1", `dohc-live-ticket.${ready.ticket}`], {
      headers: { authorization: `Bearer session:${as}` },
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
    const provider = createNamedLiveProvider(ready.editorLimits.provider, {
      workspaceId: ready.liveWorkspaceId ?? WORKSPACE,
      objectId: ready.objectId,
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
    cleanup.push(async () => {
      provider.close();
      ws.terminate();
    });
    await vi.waitFor(() => expect(provider.state().status).toBe("live"), {
      timeout: REAL_DAEMON_DEADLINE_MS,
      interval: 50,
    });
    return {
      ws,
      provider,
      closed,
      applyMarkdown(replacement: string) {
        const update = documentEditUpdate(
          Y.encodeStateAsUpdate(provider.doc),
          { replacement },
          { keepBlocks: false },
        );
        if (!(update instanceof Uint8Array))
          throw new Error(`documentEditUpdate failed: ${JSON.stringify(update)}`);
        Y.applyUpdate(provider.doc, update);
      },
      async editAndAck(replacement: string) {
        this.applyMarkdown(replacement);
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
      },
      async disconnect() {
        provider.close();
        await closed;
      },
    };
  };

  return {
    origin,
    desktopRoot,
    storage,
    catchUp,
    sharedRule: sharedRule as { ok: true; ruleId: string; revision: number },
    copiesSpy,
    callOp,
    openPageUntilReady,
    probeUpgrade,
    connectLive,
  };
}

describe.skipIf(engine.missing)(
  "joined member live page editing E2E with real engine, live host, and desktop",
  () => {
    it(
      "Proofs 1, 2, 4, 5: syncs Member live edits to Owner desktop and phone, isolates tickets, keeps Read-only and hidden paths safe, and refuses owner-only ops without ServerCopies",
      async () => {
        const stack = await startRealMemberStack();

        // Proof 1: Member opens shared/plan.md via openPage (zero ServerCopies touched).
        const memberReady = await stack.openPageUntilReady(`${MEMBER}:phone-m1`, "shared/plan.md");
        expect(memberReady.mode).toBe("named");
        expect(memberReady.session).toMatch(/^[A-Za-z0-9_-]{12}$/);
        expect(memberReady.liveWorkspaceId).toBe("named:grant-member-1");
        expect(stack.copiesSpy).not.toHaveBeenCalled();

        // Proof 4: Wrong phone session, wrong user, and wrong route cannot redeem the minted phone named ticket.
        const phoneUrl = `${stack.origin.replace(/^https:/, "wss:")}/sync/live/phone?session=${encodeURIComponent(memberReady.session!)}`;
        expect(await stack.probeUpgrade(phoneUrl, memberReady.ticket, `${MEMBER}:phone-m2`)).toBe(
          404,
        );
        expect(await stack.probeUpgrade(phoneUrl, memberReady.ticket, `${OWNER}:phone-owner`)).toBe(
          404,
        );
        const ownerUrl = `${stack.origin.replace(/^https:/, "wss:")}/sync/workspaces/${WORKSPACE}/live/owner?objectId=${encodeURIComponent(memberReady.objectId)}&lineageClaimId=${encodeURIComponent(memberReady.lineageClaimId)}`;
        expect(await stack.probeUpgrade(ownerUrl, memberReady.ticket, `${OWNER}:phone-owner`)).toBe(
          404,
        );

        // Connect Member phone and Owner phone concurrently on shared/plan.md.
        const memberLive = await stack.connectLive(memberReady, `${MEMBER}:phone-m1`);
        const ownerReady = await stack.openPageUntilReady(`${OWNER}:phone-owner`, "shared/plan.md");
        const ownerLive = await stack.connectLive(ownerReady, `${OWNER}:phone-owner`);

        // Member live-edits shared/plan.md -> syncs to Owner's phone AND Owner's real desktop file on disk.
        await memberLive.editAndAck("Updated live by joined member");
        await vi.waitFor(
          async () => {
            await stack.catchUp();
            const pending = stack.storage.db
              .prepare(
                `SELECT COUNT(*) AS count FROM ${LIVE_ROOM_EDITS} WHERE workspace_id=? AND object_id=?`,
              )
              .get(WORKSPACE, memberReady.objectId) as { count: number };
            expect(pending.count).toBe(0);
            expect(yDocToMarkdown(ownerLive.provider.doc)).toContain(
              "Updated live by joined member",
            );
            const onDisk = await readFile(join(stack.desktopRoot, "shared", "plan.md"), "utf8");
            expect(onDisk).toContain("Updated live by joined member");
          },
          { timeout: REAL_DAEMON_DEADLINE_MS, interval: 100 },
        );
        await memberLive.disconnect();
        await ownerLive.disconnect();

        // Proof 2: Read-only path refuses with read-only; hidden and out-of-reach paths answer missing.
        expect(
          await stack.callOp(`${MEMBER}:phone-m1`, "openPage", { path: "docs/spec.md" }),
        ).toEqual({
          status: 200,
          json: { ok: true, result: { status: "refused", reason: "read-only" } },
        });
        expect(
          await stack.callOp(`${MEMBER}:phone-m1`, "openPage", { path: "shared/.env" }),
        ).toEqual({
          status: 200,
          json: { ok: true, result: { status: "refused", reason: "missing" } },
        });
        expect(
          await stack.callOp(`${MEMBER}:phone-m1`, "openPage", { path: "private/notes.md" }),
        ).toEqual({
          status: 200,
          json: { ok: true, result: { status: "refused", reason: "missing" } },
        });

        // Proof 5: Joined Member gets 404 on every owner-only file, sketch, and Document Collection op.
        for (const operation of [
          "createPage",
          "renameFile",
          "deleteFile",
          "saveSketch",
          "documentCollections",
          "documentCollectionRecords",
          "createDocumentCollection",
          "createDocumentRecord",
          "editDocumentRecordFields",
        ]) {
          const res = await stack.callOp(`${MEMBER}:phone-m1`, operation, {});
          expect(res.status, operation).toBe(404);
        }
        expect(stack.copiesSpy).not.toHaveBeenCalled();
      },
      REAL_DAEMON_DEADLINE_MS * 2,
    );

    it(
      "Proof 3 (Race): Show on phone off via PATCH and Edit grant downgrade/revocation close the Member socket immediately and refuse pending edits",
      async () => {
        const stack = await startRealMemberStack();

        // Case A: Show on phone turned off via real PATCH /sync/account/workspaces/:id.
        const readyA = await stack.openPageUntilReady(`${MEMBER}:phone-m1`, "shared/plan.md");
        const liveA = await stack.connectLive(readyA, `${MEMBER}:phone-m1`);
        await liveA.editAndAck("Committed before hide");

        const hideRes = await fetch(`${stack.origin}/sync/account/workspaces/${WORKSPACE}`, {
          method: "PATCH",
          headers: {
            authorization: `Bearer session:${MEMBER}:phone-m1`,
            "content-type": "application/json",
          },
          body: JSON.stringify({ showOnPhone: false }),
        });
        expect(hideRes.status).toBe(200);
        liveA.applyMarkdown("Must not commit after hide");
        await liveA.closed;

        // Re-enable Show on phone and verify the post-hide edit never committed.
        const showRes = await fetch(`${stack.origin}/sync/account/workspaces/${WORKSPACE}`, {
          method: "PATCH",
          headers: {
            authorization: `Bearer session:${MEMBER}:phone-m1`,
            "content-type": "application/json",
          },
          body: JSON.stringify({ showOnPhone: true }),
        });
        expect(showRes.status).toBe(200);
        await vi.waitFor(
          async () => {
            await stack.catchUp();
            const onDisk = await readFile(join(stack.desktopRoot, "shared", "plan.md"), "utf8");
            expect(onDisk).toContain("Committed before hide");
            expect(onDisk).not.toContain("Must not commit after hide");
          },
          { timeout: REAL_DAEMON_DEADLINE_MS, interval: 100 },
        );

        // Case B: Folder rule downgraded from Edit to Read-only closes Member socket immediately.
        const readyB = await stack.openPageUntilReady(`${MEMBER}:phone-m1`, "shared/plan.md");
        const liveB = await stack.connectLive(readyB, `${MEMBER}:phone-m1`);
        const downgraded = stack.storage.changeFolderRule({
          workspaceId: WORKSPACE,
          actorUserId: OWNER,
          change: {
            kind: "change",
            ruleId: stack.sharedRule.ruleId,
            revision: stack.sharedRule.revision,
            rule: parseAccessRule("members: view\n")!,
          },
          nowMs: 20,
        });
        expect(downgraded).toMatchObject({ ok: true });
        liveB.applyMarkdown("Must not commit after downgrade");
        await liveB.closed;
        expect(
          await stack.callOp(`${MEMBER}:phone-m1`, "openPage", { path: "shared/plan.md" }),
        ).toEqual({
          status: 200,
          json: { ok: true, result: { status: "refused", reason: "read-only" } },
        });

        // Case C: Restore Edit, reconnect, then remove Member -> socket closes immediately and edit never commits.
        expect(
          stack.storage.changeFolderRule({
            workspaceId: WORKSPACE,
            actorUserId: OWNER,
            change: {
              kind: "change",
              ruleId: stack.sharedRule.ruleId,
              revision: (downgraded as { ok: true; revision: number }).revision,
              rule: parseAccessRule("members: edit\n")!,
            },
            nowMs: 21,
          }),
        ).toMatchObject({ ok: true });
        const readyC = await stack.openPageUntilReady(`${MEMBER}:phone-m1`, "shared/plan.md");
        const liveC = await stack.connectLive(readyC, `${MEMBER}:phone-m1`);
        expect(
          stack.storage.removeWorkspaceMember({
            workspaceId: WORKSPACE,
            actorUserId: OWNER,
            memberId: "member-1",
            nowMs: 22,
          }),
        ).toMatchObject({ ok: true });
        liveC.applyMarkdown("Must not commit after revoke");
        await liveC.closed;
        expect(
          (await stack.callOp(`${MEMBER}:phone-m1`, "openPage", { path: "shared/plan.md" })).status,
        ).toBe(404);

        await stack.catchUp();
        const finalDisk = await readFile(join(stack.desktopRoot, "shared", "plan.md"), "utf8");
        expect(finalDisk).toContain("Committed before hide");
        expect(finalDisk).not.toContain("Must not commit after downgrade");
        expect(finalDisk).not.toContain("Must not commit after revoke");
      },
      REAL_DAEMON_DEADLINE_MS * 2,
    );
  },
);
