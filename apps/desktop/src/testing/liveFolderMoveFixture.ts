// A real relay with its live host, the TLS proxy, an owner device bound to
// live pages, and a link holder who edits them through the relay's own
// link-live routes. Used by the real-engine tests of the folder-move refusal.
import { randomBytes, randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { getCACertificates, setDefaultCACertificates } from "node:tls";
import { expect, vi } from "vitest";
import { WebSocket } from "ws";
import * as Y from "yjs";
import { createNamedLiveBrowserTransport } from "@dohc/ydoc-projection/named-live-browser-transport";
import { VersionedLiveAdapter } from "@dohc/workspace-engine-client";
import { OwnerKnownRefusals } from "@dohc/workspace-engine-client/owner-ydoc-drainer";
import { mintLocalhostCa } from "../../../../services/share-web/src/testing/localhostCa";
import { selfHostLiveProfile } from "../../../../services/sync-relay/src/selfHostLiveProfile";
import { openLiveDaemonWorkspace } from "../../e2e/helpers/daemonSeed";
import { startServerProxy } from "../../e2e/helpers/selfHostOnboarding";
import { spawnSyncRelay } from "../../e2e/helpers/syncRelay";
import type { DesktopOwnerDeliveryDocument } from "../workspaces/desktopOwnerDelivery";
import { runNativeOwnerDeliveryPass } from "../workspaces/nativeOwnerDelivery";
import { readyOwnerDeliveryDocuments } from "../workspaces/serverOwnerDelivery";
import { createTestScratch } from "../workspaces/testTemp";
import { SECRET_FILE_STORE_RELATIVE_PATH } from "../workspaces/workspaceDataKey";
import { createWorkspaceEngineCapture } from "../workspaces/workspaceEngineCapture";
import { moveWorkspacePathByHand } from "../workspaces/workspaceFileMoves";
import { readLocalStateFrom, type LocalStateBindings } from "../workspaces/workspaceLocalState";

const LIVE_DEADLINE_MS = 120_000;
const person = { kind: "human", humanId: "local-person" } as const;

async function pushUntilDrained(relay: { push(): Promise<{ hasMore: boolean }> }) {
  let result = await relay.push();
  while (result.hasMore) result = await relay.push();
}

function readDb<T>(file: string, query: (db: DatabaseSync) => T): T {
  const db = new DatabaseSync(file, { readOnly: true });
  try { return query(db); } finally { db.close(); }
}

const numberOf = (value: unknown) => Number(value ?? 0);

/** Pages live at `notes/<name>.md`; a name may hold folders, as `box/inner/page`. */
export async function openLiveFolderMoveFixture(input: {
  workspaceId: string;
  compiledRelayMain: string;
  engineExecutable: string;
  pages: readonly string[];
}) {
  const { workspaceId } = input;
  const rootA = await createTestScratch("dohc-live-folder-owner-");
  const relayRoot = await createTestScratch("dohc-live-folder-relay-");
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
    if (failures.length) throw new AggregateError(failures, "The live folder move fixture did not close.");
  };
  try {
    const exchangeKey = "live-folder-exchange-key-".repeat(2);
    const relayServer = await spawnSyncRelay({ dbPath: join(relayRoot, "relay", "relay.sqlite"), compiledMain: input.compiledRelayMain,
      editLinks: { engineExecutable: input.engineExecutable, publicOrigin: proxy.origin, trustEnv },
      linkBoundary: { linkKey: "live-folder-link-key-".repeat(3), relayExchangeKey: exchangeKey, publicViewerOrigin: proxy.origin } });
    cleanups.push(() => relayServer.stop());
    proxy.routeRelayTo(relayServer.baseUrl);
    const relayConnection = { baseUrl: proxy.origin, token: `test:${workspaceId}` };
    const ownerHeaders = { authorization: `Bearer ${relayConnection.token}`, "content-type": "application/json" };
    const profile = selfHostLiveProfile();
    const nativeConfigPath = join(rootA, "owner-ingress.json");
    await writeFile(nativeConfigPath, JSON.stringify(profile.nativeIngress));
    const owner = await openLiveDaemonWorkspace({ workspaceId, rootPath: rootA }, { maxRestarts: 0,
      allowInsecureLoopbackForTests: false, privateOwnerHost: { configPath: nativeConfigPath, client: profile.nativeClient } });
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
    const capture = createWorkspaceEngineCapture({ ...owner.workspace, rustEngineSessions: owner.sessions, settleDebounceMs: 60_000 });
    cleanups.push(() => capture.stop());
    for (const name of input.pages) {
      const seeded = await capture.openYDocSession({ path: pagePath(name), contentKind: "richdoc", onRemoteUpdate: () => undefined });
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
    const pages = new Map(input.pages.map(name => {
      const document = documents.find(row => row.binding.currentPath === pagePath(name));
      if (!document) throw new Error(`No live document for ${name}.`);
      return [name, { path: pagePath(name), objectId: document.binding.objectId }] as const;
    }));
    const page = (name: string) => {
      const found = pages.get(name);
      if (!found) throw new Error(`No page ${name}.`);
      return found;
    };
    const configFor = (document: DesktopOwnerDeliveryDocument) => ({ ...profile.owner, nativeConfigPath,
      nativeClient: profile.nativeClient, relayUrl: proxy.origin, documents: [document] });

    // The owner binds every page with an ordinary owner pass.
    const refusals = new OwnerKnownRefusals();
    for (const document of documents) {
      const result = await owner.sessions.run(owner.workspace, ({ workspace }) => runNativeOwnerDeliveryPass({ client: owner.nativeClient(),
        workspaceHandle: workspace, document, config: configFor(document), refusals, signal: AbortSignal.timeout(60_000),
        bearer: relayConnection.token, accountId: workspaceId, assertCurrent() {} }));
      expect(["empty", "acknowledged"]).toContain(result);
    }
    capture.start();

    // The link holder: exchange the secret, then edit through the relay's link-live routes.
    const exchanged = await fetch(`${proxy.origin}/sync/link-exchange`, { method: "POST",
      headers: { "content-type": "application/json", "x-dohc-relay-exchange-key": exchangeKey }, body: JSON.stringify({ secret: linkSecret }) });
    expect(exchanged.status).toBe(200);
    const { capabilityToken } = await exchanged.json() as { capabilityToken: string };
    const discriminator = randomBytes(9).toString("base64url");
    const linkHeaders = { authorization: `LinkCapability ${capabilityToken}`, "x-dohc-link-profile-secret": randomBytes(32).toString("base64url"),
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
    const ownerDb = join(rootA, SECRET_FILE_STORE_RELATIVE_PATH);
    const operation = { workspace: { ...owner.workspace, readOnly: false, shareView: undefined }, assertCurrent() {} };
    const moveOptions = () => ({ capture, requestId: randomUUID(),
      trashItem: async () => { throw new Error("This test trashes nothing."); }, markDeleted: () => undefined });

    return {
      workspaceId, rootPath: rootA, capture, page,
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
      /** The owner's accepted cursor for the page. */
      ownerAccepted: (name: string) => readDb(ownerDb, db => numberOf(db.prepare(
        "SELECT accepted_cursor AS n FROM ydoc_owner_bindings WHERE workspace_id=? AND object_id=?").get(workspaceId, page(name).objectId)?.n)),
      /** Local changes journaled for the relay that name the page, by object or by path. */
      outbound: (name: string) => readDb(ownerDb, db => numberOf(db.prepare(
        `SELECT COUNT(*) AS n FROM replication_log WHERE workspace_id=? AND imported=0
           AND (json_extract(payload_json,'$.objectId')=? OR json_extract(payload_json,'$.path')=?)`)
        .get(workspaceId, page(name).objectId, page(name).path)?.n)),
      /** Moves by hand, as Explorer does. */
      moveByHand: (fromPath: string, toPath: string) =>
        moveWorkspacePathByHand(operation, { fromPath, toPath }, person, moveOptions()),
      read: (path: string) => readFile(join(rootA, path), "utf8"),
      close,
    };
  } catch (error) {
    await close().catch(() => undefined);
    throw error;
  }
}
