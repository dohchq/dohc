// A real relay with its live host, the TLS proxy, an owner device bound to
// live pages, and a link holder who edits them through the relay's own
// link-live routes. Used by the real-engine tests of the move guard.
import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, readdirSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { getCACertificates, setDefaultCACertificates } from "node:tls";
import { expect, vi } from "vitest";
import { WebSocket } from "ws";
import * as Y from "yjs";
import { createNamedLiveBrowserTransport } from "@dohc/ydoc-projection/named-live-browser-transport";
import { DaemonRefusalError, VersionedLiveAdapter, WorkspaceDaemonRequester } from "@dohc/workspace-engine-client";
import type { EngineClient } from "@dohc/workspace-engine-client/daemon";
import { OwnerKnownRefusals } from "@dohc/workspace-engine-client/owner-ydoc-drainer";
import { mintLocalhostCa } from "../../../../services/share-web/src/testing/localhostCa";
import { selfHostLiveProfile } from "../../../../services/sync-relay/src/selfHostLiveProfile";
import { openLiveDaemonWorkspace } from "../../e2e/helpers/daemonSeed";
import { startServerProxy } from "../../e2e/helpers/selfHostOnboarding";
import { spawnSyncRelay } from "../../e2e/helpers/syncRelay";
import type { DesktopOwnerDeliveryDocument } from "../workspaces/desktopOwnerDelivery";
import type { EngineRelayWorkspaceClient } from "../workspaces/engineRelayClient";
import { createMoveAcceptedEditsGuard } from "../workspaces/moveAcceptedEditsGuard";
import { runNativeOwnerDeliveryPass } from "../workspaces/nativeOwnerDelivery";
import { createRelaySyncEngine, type RelaySyncOperations } from "../workspaces/relaySyncEngine";
import { probeRelayWorkspace } from "../workspaces/relayWorkspaceProbe";
import { catchUpOwnerDocuments, readyOwnerDeliveryDocuments, startServerOwnerDelivery } from "../workspaces/serverOwnerDelivery";
import { createTestScratch } from "../workspaces/testTemp";
import { installWorkspaceDataKey, SECRET_FILE_STORE_RELATIVE_PATH } from "../workspaces/workspaceDataKey";
import { createWorkspaceEngineCapture, type WorkspaceEngineCapture } from "../workspaces/workspaceEngineCapture";
import { moveWorkspacePathByHand } from "../workspaces/workspaceFileMoves";
import { bootstrapJoinedWorkspace } from "../workspaces/workspaceJoinEnrollment";
import { readLocalStateFrom, type LocalStateBindings } from "../workspaces/workspaceLocalState";

const LIVE_DEADLINE_MS = 120_000;
const person = { kind: "human", humanId: "local-person" } as const;

export interface LivePage {
  path: string;
  objectId: string;
  document: DesktopOwnerDeliveryDocument;
}

type OpenedDaemon = Awaited<ReturnType<typeof openLiveDaemonWorkspace>>;

/** What one relay engine pull answered, recorded before the engine swallows a failure. */
export type GuardPull =
  | { result: "succeeded"; elapsedMs: number }
  | { result: "failed"; wireCode: string | null; message: string; retry: string | null; elapsedMs: number };

/** The pulls the guard's catch-up ran for one guarded move. */
export interface GuardPulls {
  pulls: GuardPull[];
  // Another pass was running when the catch-up began, so a pull here may be that pass's.
  shared: boolean;
  // The catch-up had ended when the guard stopped waiting, so the guard
  // returned because its pull finished, not because its wait ran out.
  endedInWait: boolean;
}

function failedPull(error: unknown, elapsedMs: number): GuardPull {
  if (error instanceof DaemonRefusalError) return { result: "failed", wireCode: error.wireCode, message: error.message, retry: error.retry, elapsedMs };
  const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  return { result: "failed", wireCode: null, message, retry: null, elapsedMs };
}

/** One desktop: its engine, its capture, and the guard wired as the desktop wires it. */
export interface MoveDevice {
  rootPath: string;
  capture: WorkspaceEngineCapture;
  relay: EngineRelayWorkspaceClient;
  /** Runs work with the native client and workspace handle, holding the engine session. */
  runNative<T>(work: (client: EngineClient, handle: string) => Promise<T>): Promise<T>;
  /** Owner syncs the guard asked the owner loop for. */
  targetedPasses(): number;
  /** One pull outside the relay engine, as setup does. */
  pull(): Promise<{ fetched: number }>;
  /** Moves by hand, as Explorer does. Resolves with the elapsed milliseconds. */
  move(fromPath: string, toPath: string, options: { guarded: boolean }): Promise<number>;
  /** Waits for the last guarded move's catch-up to end, then returns the pulls it ran. */
  guardPulls(): Promise<GuardPulls>;
  /** Relay engine pulls that no guard's catch-up ran. */
  backgroundPulls(): readonly GuardPull[];
  /** Whether the relay engine reports a sync failure, which makes the guard skip its catch-up. */
  syncFailed(): boolean;
  refusalNotices(): Promise<unknown>;
}

async function pushUntilDrained(relay: EngineRelayWorkspaceClient) {
  let result = await relay.push();
  while (result.hasMore) result = await relay.push();
}

function readDb<T>(file: string, query: (db: DatabaseSync) => T): T {
  const db = new DatabaseSync(file, { readOnly: true });
  try { return query(db); } finally { db.close(); }
}

const numberOf = (value: unknown) => Number(value ?? 0);

export async function openLiveMoveFixture(input: {
  workspaceId: string;
  compiledRelayMain: string;
  engineExecutable: string;
  pages: readonly string[];
  /** Opens a second device that joins the workspace and never binds a page. */
  peer?: boolean;
}) {
  const { workspaceId } = input;
  const rootA = await createTestScratch("dohc-live-move-owner-");
  const relayRoot = await createTestScratch("dohc-live-move-relay-");
  const ca = await mintLocalhostCa(relayRoot);
  const previousRoots = getCACertificates("default");
  setDefaultCACertificates([...previousRoots, ca.ca]);
  const trustEnv = { NODE_EXTRA_CA_CERTS: ca.caPath, DOHC_ENGINE_TEST_RELAY_CA_MODE: "1",
    DOHC_ENGINE_TEST_RELAY_CA_FILE: ca.caPath, DOHC_E2E_ALLOW_INSECURE_LOOPBACK_RELAY: "0" };
  for (const [name, value] of Object.entries(trustEnv)) vi.stubEnv(name, value);
  let refuseLog = false;
  const proxy = await startServerProxy(ca, {
    refuse: (method, path) => refuseLog && method === "GET" && /^\/sync\/[^/]+\/log(?:\?|$)/u.test(path),
  });
  const localStates = new Map<string, LocalStateBindings>();
  readLocalStateFrom({
    currentBinding: workspace => localStates.get(workspace.rootPath)?.currentBinding(workspace) ?? null,
    openInProgress: workspace => localStates.get(workspace.rootPath)?.openInProgress?.(workspace) ?? null,
    localStateOpenAt: rootPath => localStates.get(rootPath)?.localStateOpenAt(rootPath) ?? Promise.resolve(null),
  });
  const cleanups: Array<() => Promise<void>> = [];
  const close = async () => {
    const failures: unknown[] = [];
    for (const cleanup of cleanups.reverse()) {
      try { await cleanup(); } catch (error) { failures.push(error); }
    }
    readLocalStateFrom(null);
    await proxy.close().catch(error => failures.push(error));
    setDefaultCACertificates(previousRoots);
    vi.unstubAllEnvs();
    if (failures.length) throw new AggregateError(failures, "The live move fixture did not close.");
  };
  try {
    const exchangeKey = "live-move-exchange-key-".repeat(2);
    const relayServer = await spawnSyncRelay({ dbPath: join(relayRoot, "relay", "relay.sqlite"), compiledMain: input.compiledRelayMain,
      editLinks: { engineExecutable: input.engineExecutable, publicOrigin: proxy.origin, trustEnv },
      linkBoundary: { linkKey: "live-move-link-key-".repeat(3), relayExchangeKey: exchangeKey, publicViewerOrigin: proxy.origin } });
    cleanups.push(() => relayServer.stop());
    proxy.routeRelayTo(relayServer.baseUrl);
    const relayConnection = { baseUrl: proxy.origin, token: `test:${workspaceId}` };
    const ownerHeaders = { authorization: `Bearer ${relayConnection.token}`, "content-type": "application/json" };
    const profile = selfHostLiveProfile();
    const nativeConfigPath = join(rootA, "owner-ingress.json");
    await writeFile(nativeConfigPath, JSON.stringify(profile.nativeIngress));
    // Every desktop's daemon gets the private live transport, as the desktop prepares it; the peer never enrolls.
    const privateOwnerHost = { configPath: nativeConfigPath, client: profile.nativeClient };
    const owner = await openLiveDaemonWorkspace({ workspaceId, rootPath: rootA }, { maxRestarts: 0,
      allowInsecureLoopbackForTests: false, privateOwnerHost });
    cleanups.push(() => owner.close());
    localStates.set(rootA, owner.sessions);
    const ownerRelay = owner.relay.bind({ ...owner.workspace, relay: relayConnection });
    await ownerRelay.claim();
    await owner.chats.ensureGeneralChannel({ workspaceId });
    await pushUntilDrained(ownerRelay);

    // Each page is a richdoc whose first block is one paragraph.
    const pagePath = (name: string) => `notes/${name}.md`;
    const adapter = await owner.sessions.run(owner.workspace, async ({ client, workspace }) => new VersionedLiveAdapter(client, workspace, { workspaceId }));
    await adapter.ensureMainVersion({ workspaceId });
    for (const name of input.pages) {
      await adapter.writeTextFile({ workspaceId, versionId: "main", path: pagePath(name), text: `Page ${name} body.\n`,
        publish: true, metadata: { origin: "api" }, author: person });
    }
    const ownerCapture = createWorkspaceEngineCapture({ ...owner.workspace, rustEngineSessions: owner.sessions, settleDebounceMs: 60_000 });
    cleanups.push(() => ownerCapture.stop());
    for (const name of input.pages) {
      const seeded = await ownerCapture.openYDocSession({ path: pagePath(name), contentKind: "richdoc", onRemoteUpdate: () => undefined });
      await seeded.settleNow();
      await seeded.close();
    }
    await pushUntilDrained(ownerRelay);

    // The owner shares the folder by an edit link and turns live editing on.
    const created = await fetch(`${proxy.origin}/sync/${workspaceId}/shares/links`, { method: "POST", headers: ownerHeaders,
      body: JSON.stringify({ paths: ["notes"], access: "edit" }) });
    expect(created.status).toBe(200);
    const link = await created.json() as { shareId: string; url: string };
    const linkSecret = new URL(link.url).hash.slice(1);
    const enrollment = await fetch(`${proxy.origin}/sync/${workspaceId}/live-host`, { method: "POST", headers: ownerHeaders,
      body: JSON.stringify({ shareId: link.shareId }) });
    expect([200, 202]).toContain(enrollment.status);
    let discoveryPayload: unknown;
    const discovery = async () => {
      const response = await fetch(`${proxy.origin}/sync/${workspaceId}/live-host`, { headers: { authorization: ownerHeaders.authorization } });
      expect(response.status).toBe(200);
      discoveryPayload = await response.json();
      return readyOwnerDeliveryDocuments(discoveryPayload, workspaceId);
    };
    try { await expect.poll(async () => (await discovery()).length, { timeout: LIVE_DEADLINE_MS }).toBe(input.pages.length); }
    catch (error) { throw new Error(JSON.stringify({ discoveryPayload, diagnostics: relayServer.diagnostics() }), { cause: error }); }
    const documents = await discovery();
    const pages = new Map<string, LivePage>(input.pages.map(name => {
      const document = documents.find(row => row.binding.currentPath === pagePath(name));
      if (!document) throw new Error(`No live document for ${name}.`);
      return [name, { path: pagePath(name), objectId: document.binding.objectId, document }];
    }));
    const page = (name: string) => {
      const found = pages.get(name);
      if (!found) throw new Error(`No page ${name}.`);
      return found;
    };
    const configFor = (document: DesktopOwnerDeliveryDocument) => ({ ...profile.owner, nativeConfigPath,
      nativeClient: profile.nativeClient, relayUrl: proxy.origin, documents: [document] });

    // Wires a device as the desktop does: the owner loop with its targeted
    // slot, the relay engine's guard pass, and the guard over both. Ordinary
    // owner passes are left out, so only the guard syncs.
    const device = (opened: OpenedDaemon, rootPath: string, capture: WorkspaceEngineCapture, relay: EngineRelayWorkspaceClient): MoveDevice => {
      const runNative = <T,>(work: (client: EngineClient, handle: string) => Promise<T>) =>
        opened.sessions.run(opened.workspace, ({ workspace }) => work(opened.nativeClient(), workspace));
      const refusals = new OwnerKnownRefusals();
      let targeted = 0;
      const delivery = startServerOwnerDelivery({ workspaceIds: () => [workspaceId], attemptTimeoutMs: 60_000, retryDelayMs: 60_000,
        runPass: async () => ({ documentCount: 0, acknowledged: false }),
        runTargetedPass(_workspaceId, objectIds, signal) {
          targeted++;
          return catchUpOwnerDocuments(documents, objectIds, document => runNative((client, handle) => runNativeOwnerDeliveryPass({ client,
            workspaceHandle: handle, document, config: configFor(document), refusals, signal, bearer: relayConnection.token, accountId: workspaceId,
            assertCurrent() {}, observedOnly: true })));
        },
        onError: () => undefined });
      // Each relay engine pull is recorded, before the engine swallows a
      // failure, against the guard catch-up running when the pull started.
      // The guard hands both of an attempt's catch-ups the same signal, so
      // the signal ties the pull to the move whose wait started the attempt.
      interface CatchUp { pulls: GuardPull[]; shared: boolean; ended: boolean; settled: Promise<void> }
      interface MoveRecord { catchUps: CatchUp[]; endedInWait: boolean }
      let moving: MoveRecord | undefined;
      let lastGuarded: MoveRecord | undefined;
      const attempts = new WeakMap<AbortSignal, MoveRecord>();
      let catchingUp: GuardPull[] | undefined;
      let pullsRunning = 0;
      const background: GuardPull[] = [];
      const operations: RelaySyncOperations = {
        claim: () => relay.claim(),
        push: () => relay.push(),
        recoverOrigin: () => relay.recoverOrigin(),
        async pull(runBatch) {
          const into = catchingUp ?? background;
          const started = performance.now();
          pullsRunning++;
          try {
            const result = await relay.pull(runBatch);
            into.push({ result: "succeeded", elapsedMs: performance.now() - started });
            return result;
          } catch (error) {
            into.push(failedPull(error, performance.now() - started));
            throw error;
          } finally { pullsRunning--; }
        },
      };
      const sync = createRelaySyncEngine({ rootDir: rootPath, relay: relayConnection, operations, capture, onChange: () => undefined });
      cleanups.push(async () => { await sync.stop(); await delivery.stop(); });
      const guard = createMoveAcceptedEditsGuard({
        liveDocuments: () => documents.map(row => ({ path: row.binding.currentPath, objectId: row.binding.objectId })),
        offline: () => sync.snapshot().syncFailure !== null,
        ownerCatchUp(id, objectIds, signal) {
          if (moving) attempts.set(signal, moving);
          return delivery.catchUp(id, objectIds, signal);
        },
        relayCatchUp(_id, signal) {
          const shared = sync.snapshot().syncing || pullsRunning > 0;
          const pulls: GuardPull[] = [];
          catchingUp = pulls;
          const run = sync.catchUp({ signal });
          // Attached before the guard awaits the run, so `ended` is set before the guard can return.
          const catchUp: CatchUp = { pulls, shared, ended: false, settled: Promise.resolve() };
          const end = () => { catchUp.ended = true; };
          catchUp.settled = run.then(end, end).finally(() => { if (catchingUp === pulls) catchingUp = undefined; });
          attempts.get(signal)?.catchUps.push(catchUp);
          return run;
        },
      });
      const operation = { workspace: { ...opened.workspace, readOnly: false, shareView: undefined }, assertCurrent() {} };
      return {
        rootPath, capture, relay, runNative,
        targetedPasses: () => targeted,
        pull: () => relay.pull(apply => capture.runRelaySync(apply)),
        async move(fromPath, toPath, { guarded }) {
          const record: MoveRecord = { catchUps: [], endedInWait: false };
          if (guarded) lastGuarded = record;
          const beforeMove = async (storedSpelling: () => Promise<string>) => {
            moving = record;
            try { await guard.beforeMove(workspaceId, storedSpelling); } finally {
              moving = undefined;
              record.endedInWait = record.catchUps.length > 0 && record.catchUps.every(catchUp => catchUp.ended);
            }
          };
          const started = performance.now();
          await moveWorkspacePathByHand(operation, { fromPath, toPath }, person, { capture, requestId: randomUUID(),
            trashItem: async () => { throw new Error("This test trashes nothing."); }, markDeleted: () => undefined,
            ...(guarded ? { beforeMove } : {}) });
          return performance.now() - started;
        },
        async guardPulls() {
          if (!lastGuarded) throw new Error("This device made no guarded move.");
          const { catchUps, endedInWait } = lastGuarded;
          await Promise.all(catchUps.map(catchUp => catchUp.settled));
          return { pulls: catchUps.flatMap(catchUp => catchUp.pulls), shared: catchUps.some(catchUp => catchUp.shared), endedInWait };
        },
        backgroundPulls: () => background,
        syncFailed: () => sync.snapshot().syncFailure !== null,
        refusalNotices: () => opened.sessions.run(opened.workspace, ({ client, workspace }) =>
          new WorkspaceDaemonRequester(client).request("sync.refusalNotices", { workspaceId }, { workspace })),
      };
    };

    // The owner binds every page with an ordinary owner pass.
    const refusals = new OwnerKnownRefusals();
    for (const { document } of pages.values()) {
      const result = await owner.sessions.run(owner.workspace, ({ workspace }) => runNativeOwnerDeliveryPass({ client: owner.nativeClient(),
        workspaceHandle: workspace, document, config: configFor(document), refusals, signal: AbortSignal.timeout(60_000),
        bearer: relayConnection.token, accountId: workspaceId, assertCurrent() {} }));
      expect(["empty", "acknowledged"]).toContain(result);
    }
    const ownerDevice = device(owner, rootA, ownerCapture, ownerRelay);

    let peerDevice: MoveDevice | undefined;
    if (input.peer) {
      const rootB = await createTestScratch("dohc-live-move-peer-");
      const peer = await openLiveDaemonWorkspace({ workspaceId, rootPath: rootB }, { maxRestarts: 0, allowInsecureLoopbackForTests: false,
        privateOwnerHost });
      cleanups.push(() => peer.close());
      localStates.set(rootB, peer.sessions);
      const peerRelay = peer.relay.bind({ ...peer.workspace, relay: relayConnection });
      const probe = await probeRelayWorkspace({ workspaceId, relay: relayConnection });
      await bootstrapJoinedWorkspace({ workspaceId, identity: probe.identity, transport: peerRelay,
        installDataKey: async key => await installWorkspaceDataKey(rootB, key) });
      const peerCapture = createWorkspaceEngineCapture({ ...peer.workspace, rustEngineSessions: peer.sessions });
      cleanups.push(() => peerCapture.stop());
      peerDevice = device(peer, rootB, peerCapture, peerRelay);
      await peerDevice.pull();
      for (const { path } of pages.values()) expect(await readFile(join(rootB, path), "utf8")).toContain("body.");
    }

    // The link holder: exchange the secret, then edit through the relay's link-live routes.
    const exchanged = await fetch(`${proxy.origin}/sync/link-exchange`, { method: "POST",
      headers: { "content-type": "application/json", "x-dohc-relay-exchange-key": exchangeKey }, body: JSON.stringify({ secret: linkSecret }) });
    expect(exchanged.status).toBe(200);
    const { capabilityToken } = await exchanged.json() as { capabilityToken: string };
    const discriminator = randomBytes(9).toString("base64url");
    const linkHeaders = { authorization: `Bearer ${capabilityToken}`, "x-dohc-link-profile-secret": randomBytes(32).toString("base64url"),
      "x-dohc-relay-exchange-key": exchangeKey, origin: proxy.origin };
    const sockets = new Set<WebSocket>();
    let publicPrincipalId: string | undefined;
    const transport = createNamedLiveBrowserTransport<{ objectId: string }>({ publicOrigin: proxy.origin, limits: profile.editor,
      recordingContext() {
        if (!publicPrincipalId) throw new Error("Link identity is unavailable.");
        return { kind: "link", publicPrincipalId };
      },
      async authorize(selection, signal) {
        const response = await fetch(`${proxy.origin}/sync/live/link-tickets`, { method: "POST", signal,
          headers: { ...linkHeaders, "content-type": "application/json" }, body: JSON.stringify({ discriminator, objectId: selection.objectId }) });
        if (response.status !== 200) throw new Error(`Link ticket refused: ${response.status} ${await response.text()}`);
        const ticket = await response.json() as { expiresAtMs: number; publicPrincipalId: string; token: string };
        publicPrincipalId = ticket.publicPrincipalId;
        const url = new URL("/sync/live/link", proxy.origin);
        url.protocol = "wss:";
        url.searchParams.set("session", discriminator);
        return { ticketToken: ticket.token, discriminator, websocketUrl: url.href };
      },
      openSocket(url, protocols) {
        const socket = new WebSocket(url, protocols, { ca: ca.ca, headers: linkHeaders, perMessageDeflate: false });
        sockets.add(socket);
        socket.once("close", () => sockets.delete(socket));
        return socket as unknown as globalThis.WebSocket;
      } });
    cleanups.push(async () => {
      transport.close();
      for (const socket of sockets) socket.terminate();
    });

    const relayDb = join(relayRoot, "relay", "relay.sqlite");
    const acceptedHead = (path: string) => readDb(relayDb, db => numberOf(db.prepare(
      "SELECT COALESCE(MAX(journal_cursor),0) AS n FROM sync_relay_live_update_journal WHERE workspace_id=? AND current_path=?").get(workspaceId, path)?.n));
    const hostDbs = () => {
      const hostRoot = join(relayRoot, "relay-deployment", "live-host");
      return readdirSync(hostRoot, { withFileTypes: true }).filter(entry => entry.isDirectory() && entry.name !== "automations")
        .map(entry => join(hostRoot, entry.name, ".dohc", "engine", "engine.db")).filter(file => existsSync(file));
    };
    // The live host settled the page through `cursor` and pushed everything it saved.
    const published = (objectId: string, cursor: number) => hostDbs().some(file => readDb(file, db =>
      numberOf(db.prepare("SELECT COALESCE(MAX(terminal_cursor),0) AS n FROM live_device_settlements WHERE object_id=?").get(objectId)?.n) >= cursor &&
      numberOf(db.prepare(`SELECT COUNT(*) AS n FROM replication_log l LEFT JOIN sync_relay_push_state p
        ON p.workspace_id=l.workspace_id AND p.origin_id=l.origin_id WHERE l.imported=0 AND l.origin_seq>COALESCE(p.pushed_seq,-1)`).get()?.n) === 0));
    const ownerDb = join(rootA, SECRET_FILE_STORE_RELATIVE_PATH);

    return {
      workspaceId, proxy, owner: ownerDevice, page,
      get peer(): MoveDevice {
        if (!peerDevice) throw new Error("This fixture has no peer.");
        return peerDevice;
      },
      /** The owner's engine, for reads and wrapped native work. */
      ownerEngine: owner,
      ownerDocument: (name: string) => page(name).document,
      ownerConfig: configFor,
      relayConnection,
      /** Answers the engine's log pulls with 503 while set. */
      refuseLogPulls(value: boolean) { refuseLog = value; },
      /**
       * Appends `marker` to the page's first paragraph as the link holder and
       * waits until the live host accepted it. Returns the accepted cursor.
       */
      async edit(name: string, marker: string): Promise<number> {
        const { path, objectId } = page(name);
        const before = acceptedHead(path);
        const session = transport.select({ objectId });
        await session.reconnect();
        await expect.poll(() => session.state().status, { timeout: LIVE_DEADLINE_MS }).toBe("live");
        const block = session.doc.getXmlFragment("body").get(0);
        const text = block instanceof Y.XmlElement ? block.get(0) : undefined;
        if (!(text instanceof Y.XmlText)) throw new Error("The page has no first paragraph.");
        expect(session.edit(() => text.insert(text.length, marker))).toBe(true);
        await expect.poll(() => session.state().pendingUpdates, { timeout: LIVE_DEADLINE_MS }).toBe(0);
        await expect.poll(() => acceptedHead(path), { timeout: LIVE_DEADLINE_MS }).toBeGreaterThan(before);
        return acceptedHead(path);
      },
      /** Waits until the live host saved the page through `cursor` and published that save. */
      async waitPublished(name: string, cursor: number) {
        await expect.poll(() => published(page(name).objectId, cursor), { timeout: LIVE_DEADLINE_MS }).toBe(true);
      },
      /** Saves the owner pulled and parked until its accepted state catches up. */
      ownerPendingSettlements: (name: string) => readDb(ownerDb, db => numberOf(db.prepare(
        "SELECT COUNT(*) AS n FROM owner_pending_settlements WHERE workspace_id=? AND object_id=? AND applied=0").get(workspaceId, page(name).objectId)?.n)),
      /** Whether a device's engine holds an owner binding for the page. A move never makes one. */
      ownerBound: (device: MoveDevice, name: string) => readDb(join(device.rootPath, SECRET_FILE_STORE_RELATIVE_PATH), db => numberOf(db.prepare(
        "SELECT COUNT(*) AS n FROM ydoc_owner_bindings WHERE workspace_id=? AND object_id=?").get(workspaceId, page(name).objectId)?.n) > 0),
      /**
       * One owner pass for the page, without the guard: it installs what the
       * live host accepted. Only a pull saves that into the file.
       */
      ownerSync: (name: string) => owner.sessions.run(owner.workspace, ({ workspace }) => runNativeOwnerDeliveryPass({ client: owner.nativeClient(),
        workspaceHandle: workspace, document: page(name).document, config: configFor(page(name).document), refusals,
        signal: AbortSignal.timeout(60_000), bearer: relayConnection.token, accountId: workspaceId, assertCurrent() {}, observedOnly: true })),
      /** The owner's rows for the page in its replication log. A refused move adds none. */
      outbound: (name: string) => readDb(ownerDb, db => numberOf(db.prepare(
        `SELECT COUNT(*) AS n FROM replication_log WHERE workspace_id=? AND imported=0
           AND (json_extract(payload_json,'$.objectId')=? OR json_extract(payload_json,'$.path')=?)`)
        .get(workspaceId, page(name).objectId, page(name).path)?.n)),
      /** The owner's durable accepted state for the page: its cursor and checkpoint. */
      ownerAccepted: (name: string) => readDb(ownerDb, db => {
        const row = db.prepare("SELECT accepted_cursor AS cursor, checkpoint_digest AS digest FROM ydoc_owner_bindings WHERE workspace_id=? AND object_id=?")
          .get(workspaceId, page(name).objectId);
        if (!row) throw new Error("The owner is not bound to the page.");
        return { cursor: numberOf(row.cursor), digest: String(row.digest) };
      }),
      read: (device: MoveDevice, path: string) => readFile(join(device.rootPath, path), "utf8"),
      close,
    };
  } catch (error) {
    await close().catch(() => undefined);
    throw error;
  }
}

export type LiveMoveFixture = Awaited<ReturnType<typeof openLiveMoveFixture>>;

export interface GuardTiming {
  name: string;
  route: "bound" | "unbound";
  guard: "on" | "off";
  proxyDelayMs: number;
  elapsedMs: number;
  // A refused move is timed until the engine refused it. An unbound guarded
  // move either carried the edit, or went ahead without it after its pull
  // answered retry later.
  outcome: "moved" | "refused" | "carried" | "stale-retry-later";
  // What a guarded move's catch-up pulled.
  guardPulls?: GuardPulls;
}

/** Prints the timings, and writes them as JSON when `DOHC_GUARD_TIMINGS_DIR` is set. */
export async function recordGuardTimings(name: string, timings: readonly GuardTiming[]) {
  const guarded = timings.filter(timing => timing.guard === "on");
  const guardedOver3s = guarded.filter(timing => timing.elapsedMs > 3_000).length;
  const staleRetryLater = guarded.filter(timing => timing.outcome === "stale-retry-later").length;
  const report = { name, timings, guardedOver3s, guardedMoves: guarded.length, staleRetryLater };
  console.log(`guard timings: ${guarded.length - guardedOver3s} guarded moves took 3 s or less and ${guardedOver3s} took over 3 s; `
    + `${staleRetryLater} went ahead without the edit after a pull that answered retry later. ${JSON.stringify(report)}`);
  const directory = process.env.DOHC_GUARD_TIMINGS_DIR;
  if (directory) await writeFile(join(directory, `guard-timings-${name}.json`), `${JSON.stringify(report, null, 2)}\n`);
}
