import { createServer } from "node:http";
import { once } from "node:events";
import { WebSocket as NodeWebSocket } from "ws";
import { getCookies } from "better-auth/cookies";
import { afterEach, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { markdownToYDoc } from "@dohc/ydoc-projection";
import { TokenBucketLimiter } from "@dohc/service-http";
import { createLiveMarkdownJournalValidator } from "@dohc/ydoc-projection/live-journal-validation";
import {
  decodeLiveFrameSync,
  encodeLiveFrame,
  type LiveFrame,
  type LiveFrameBegin,
} from "@dohc/live-session-contract/live-frame";
import { createHash } from "node:crypto";
import { createAccountFeedWaits } from "../../sync-relay/src/accountFeed";
import { createAccountOperationRoute } from "../../sync-relay/src/accountOperationRoutes";
import { createChatWakeWaits } from "../../sync-relay/src/chatWakeRoutes";
import { DiscussionActivityHub } from "../../sync-relay/src/discussionActivity";
import { errorResponse } from "../../sync-relay/src/errors";
import { createLiveConnectionAdmission } from "../../sync-relay/src/liveConnectionAdmission";
import { createLiveRooms, type LiveRooms } from "../../sync-relay/src/liveRoom";
import {
  captureOwnerLiveFrameHost,
  type NamedFrameRoomHost,
} from "../../sync-relay/src/namedLiveFrameHost";
import { createPhonePages } from "../../sync-relay/src/phonePages";
import { selfHostLiveProfile } from "../../sync-relay/src/selfHostLiveProfile";
import {
  attachLiveJournalHistory,
  createLiveJournalHistoryAuthority,
} from "../../sync-relay/src/storage/liveJournalHistory";
import type { StorageContext } from "../../sync-relay/src/storage/context";
import {
  audience,
  binding,
  retainServiceActivation,
  scope,
} from "../../sync-relay/src/liveTickets.test-helper";
import {
  cleanups,
  exchangeKey,
  fixture,
  openProductionSync,
  policy,
  relayHost,
} from "../../sync-relay/src/namedLiveRoutes.test-helper";
import { memberDocument, openMemberPage } from "../viewer/src/memberLive";
import { createLiveGateway } from "./liveGateway";
import { ownerLiveSession } from "./liveGatewayRequest";
import { createNamedLiveRelayRoute, namedLiveGatewayRequest } from "./namedLiveRelayRoute";
import { createShareWebApplication } from "./server";

// The owner edits a page from a browser, through every piece production runs except the engine,
// which a fake stands for below: share-web's page open and gateway, the relay's account route,
// page open and owner socket with the note's room on, and the viewer's live session.

afterEach(async () => {
  vi.unstubAllGlobals();
  try {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  } finally {
    vi.restoreAllMocks();
  }
});

const profile = selfHostLiveProfile(),
  publicHost = new URL(audience).host,
  namespace = "owner-browser-live-test",
  ownerCookie = `${getCookies({ baseURL: audience }).sessionToken.name}=owner-browser`;
type Fixture = Awaited<ReturnType<typeof fixture>>;

/**
 * The engine's applied journal, as the relay reads it: each committed edit is applied at the next
 * drain, and every capture's feed reads it in order.
 */
function fakeEngine(f: Fixture) {
  const state = new Y.Doc(),
    pending: { bytes: Uint8Array; ack: Record<string, unknown> }[] = [],
    applied: typeof pending = [];
  const commit = f.storage.commitLiveUpdateJournal.bind(f.storage);
  vi.spyOn(f.storage, "commitLiveUpdateJournal").mockImplementation((input) => {
    const answer = commit(input);
    if (answer.result.kind !== "refused" && answer.result.kind !== "retry")
      pending.push({
        bytes: input.updateBytes,
        ack: { ...answer.result.receipt, localYDocSequence: 100, applicationReplayed: false },
      });
    return answer;
  });
  const position = () => ({
    eventCount: applied.length,
    journalCursor: (applied.at(-1)?.ack.journalCursor as number | undefined) ?? 0,
    evidenceDigest: "ab".repeat(32),
  });
  vi.mocked(f.native.drain).mockImplementation(async () => {
    if (!pending.length) return;
    for (const row of pending.splice(0)) {
      Y.applyUpdate(state, row.bytes);
      applied.push(row);
    }
    f.changes.notify(binding);
  });
  vi.mocked(f.native.client.openLiveAppliedSync).mockImplementation((async (
    _request: unknown,
    vector: Uint8Array,
  ) => ({
    binding: f.native.binding,
    hostVector: Buffer.from(Y.encodeStateVector(state)),
    missingStateUpdate: Buffer.from(Y.encodeStateAsUpdate(state, vector)),
    observedLocalYDocHeadSequence: 100,
    position: position(),
  })) as never);
  vi.mocked(f.native.client.readNextLiveApplied).mockImplementation((async (
    _request: unknown,
    after: { eventCount: number },
  ) => {
    const row = applied[after.eventCount];
    return row
      ? {
          position: {
            eventCount: after.eventCount + 1,
            journalCursor: row.ack.journalCursor,
            evidenceDigest: "cd".repeat(32),
          },
          updateBytes: Buffer.from(row.bytes),
          ack: row.ack,
        }
      : null;
  }) as never);
  vi.mocked(f.native.client.readLiveApplicationAck).mockImplementation(
    (async (_request: unknown, identity: { deliveryId: string; updateDigest: string }) =>
      applied.find(
        (row) =>
          row.ack.deliveryId === identity.deliveryId &&
          row.ack.updateDigest === identity.updateDigest,
      )?.ack ?? null) as never,
  );
  return { state };
}

async function owner() {
  let rooms: LiveRooms | undefined;
  const f = await fixture(
    profile.namedLive.transport,
    false,
    undefined,
    true,
    false,
    createLiveConnectionAdmission(),
    0,
    0,
    true,
    undefined,
    undefined,
    undefined,
    {
      join: (captured: NamedFrameRoomHost, options?: { owner?: boolean }) =>
        rooms!.join(captured, options),
    } as unknown as LiveRooms,
  );
  // The room saves the desktop's edits soon, so the browser hears of them in this test's time.
  rooms = createLiveRooms({
    storage: f.storage,
    maxUpdateBytes: 1 << 20,
    maxNoteBytes: 1 << 22,
    maxAppliedBytes: 1 << 20,
    saveEveryMs: 50,
    log() {},
    openSaver: async () =>
      captureOwnerLiveFrameHost({
        authenticatedUserId: "owner-1",
        storage: f.storage,
        native: f.native,
        bounds: profile.namedLive.host,
        validate: ({ retainStateUpdate: _retainStateUpdate, ...input }) =>
          createLiveMarkdownJournalValidator(policy)(input),
      }),
  });
  cleanups.push(async () => rooms!.close());
  const engine = fakeEngine(f);
  const history = createLiveJournalHistoryAuthority({ namespace, reconciled: true });
  attachLiveJournalHistory(f.storage as unknown as StorageContext, history);
  // The fixture's lineage starts from an empty update, which is no page. A desktop's first save writes one.
  const document = {
    workspaceId: binding.workspaceId,
    mainVersionId: "main",
    objectId: binding.objectId,
    lineageClaimId: binding.lineageClaimId,
  };
  const actor = { kind: "owner" as const, userId: "owner-1" };
  const current = f.storage.resolveCurrentLiveDocumentBinding({ document, actor }),
    cut = f.storage.readLiveUpdateJournalCut({ document });
  if (current.kind !== "current" || cut.kind !== "cut") throw new Error("The page has no lineage.");
  const first = Y.encodeStateAsUpdate(markdownToYDoc("Plan\n"));
  const saved = f.storage.commitLiveUpdateJournal({
    host: f.native.coordinate,
    actor,
    expectedAuthority: current.authority,
    metadata: {
      deliveryId: "first-save",
      updateDigest: createHash("sha256").update(first).digest("hex"),
      binding: current.binding,
      authorContext: { kind: "account", accountId: "owner-1" },
    },
    cutToken: cut.cut,
    validation: createLiveMarkdownJournalValidator(policy)({
      document,
      currentPath: binding.currentPath,
      checkpoint: cut.cut.checkpoint.bytes,
      suffix: [],
      candidate: first,
    }),
    updateBytes: first,
    receivedAtMs: Date.now(),
    trustedAccount: { accountId: "owner-1", name: "Owner" },
  });
  expect(saved.result.kind).toBe("accepted");
  await f.native.drain(document, new AbortController().signal);

  // The owner's browser sign-in, as better-auth's cookie names it, beside the fixture's own.
  const resolve = f.accountSession.getMockImplementation()!;
  f.accountSession.mockImplementation(async (request) =>
    request.headers.get("cookie") === ownerCookie
      ? {
          userId: "owner-1",
          sessionId: "browser-session",
          expiresAtMs: 8e12,
          clientKind: "browser",
        }
      : resolve(request),
  );

  // The page has live history, and the server's live host holds it, as after a desktop opened it live.
  f.storage.claimWorkspaceIdentity({
    workspaceId: scope.workspaceId,
    replicationEpoch: "epoch",
    streamIdentity: "stream",
  });
  f.raw
    .prepare(
      "INSERT INTO sync_relay_log(workspace_id,origin_id,origin_seq,op_kind,payload_json,recorded_at_ms,relay_seq) VALUES (?,'owner',0,'moment.append','{}',1,1)",
    )
    .run(scope.workspaceId);
  f.raw
    .prepare(
      "INSERT INTO sync_relay_log(workspace_id,origin_id,origin_seq,op_kind,payload_json,recorded_at_ms,relay_seq) VALUES (?,'desktop',100,'ydoc.update',?,2,100)",
    )
    .run(scope.workspaceId, JSON.stringify({ objectId: binding.objectId, versionId: "main" }));
  f.raw
    .prepare("INSERT INTO sync_relay_current_files VALUES (?,'main',?,?,'text',1)")
    .run(scope.workspaceId, binding.currentPath, "b".repeat(64));
  const control = f.storage.getLiveHostControl()!;
  vi.spyOn(f.storage, "getLiveHostControl").mockReturnValue({
    ...control,
    configuredMode: "service",
    configuredHostId: "self-host-owner-browser-test",
  });
  retainServiceActivation(f.raw, namespace, true);
  const pages = createPhonePages({
    storage: f.storage,
    history,
    host: {
      ready: () => true,
      unavailable: false,
      blocked: () => undefined,
      holdReason: () => undefined,
      failing: () => undefined,
      diverged: () => false,
      reconcile() {},
    },
    supported: () => true,
    tickets: f.tickets,
    sessions: { read: f.readSessions },
    nowMs: () => Date.now(),
    editorLimits: profile.editor,
  });
  const hub = new DiscussionActivityHub();
  const accountRoute = createAccountOperationRoute({
    storage: f.storage,
    resolveAccountSession: f.accountSession,
    copies: () => undefined,
    nowMs: () => Date.now(),
    limiter: new TokenBucketLimiter(1_000, 1_000, 4_096),
    feedWaits: createAccountFeedWaits(f.storage, hub),
    wakeWaits: createChatWakeWaits(f.storage, hub),
    phonePages: () => pages,
    browser: {
      origin: audience,
      hasExchangeKey: (request) => request.headers.get("x-dohc-relay-exchange-key") === exchangeKey,
    },
  });

  // The relay's own listener, under the Host it serves. share-web reaches it at its address.
  const relay = createServer();
  relay.on("upgrade", (request, socket, head) => {
    for (let index = 0; index < request.rawHeaders.length; index += 2)
      if (request.rawHeaders[index]!.toLowerCase() === "host")
        request.rawHeaders[index + 1] = relayHost;
    request.headers.host = relayHost;
    void f.routes.handleUpgrade(request, socket, head);
  });
  relay.listen(0, "127.0.0.1");
  await once(relay, "listening");
  const relayUrl = `http://127.0.0.1:${(relay.address() as { port: number }).port}`;
  const opens: string[] = [];
  const application = createShareWebApplication({
    relayUrl,
    publicRelayUrl: audience,
    relayExchangeKey: exchangeKey,
    publicHosts: new Set([publicHost]),
    accountAuth: { publicOrigin: audience, upstreamUrl: "http://127.0.0.1:1" },
    namedBrowserSessionLimits: profile.requests,
    namedLiveTickets: true,
    fetchRelay: async (request) => {
      const { pathname } = new URL(request.url);
      opens.push(pathname);
      if (pathname !== `/sync/${scope.workspaceId}/ops/openPage`)
        return new Response(null, { status: 404 });
      return accountRoute(request, {
        route: "account-operation",
        workspaceId: scope.workspaceId,
        operation: "openPage",
      }).catch((error: unknown) => errorResponse(error));
    },
  });
  // The owner's gateway, as share-web's main module builds it.
  const gateway = createLiveGateway({
    publicOrigin: audience,
    publicHosts: new Set([publicHost]),
    path: "/api/live/owner",
    limits: profile.gateway,
    resolveSession: async (request, query, signal) =>
      namedLiveGatewayRequest(request, audience, signal) ? ownerLiveSession(query) : null,
    openHostRoute: createNamedLiveRelayRoute({
      relayUrl,
      publicOrigin: audience,
      exchangeKey,
      handshakeTimeoutMs: 10_000,
      owner: true,
    }),
  });
  const share = createServer();
  share.on("upgrade", (request, socket, head) => void gateway.handleUpgrade(request, socket, head));
  share.listen(0, "127.0.0.1");
  await once(share, "listening");
  const sharePort = (share.address() as { port: number }).port;
  cleanups.push(async () => {
    gateway.close();
    await Promise.all([
      new Promise<void>((done) => share.close(() => done())),
      new Promise<void>((done) => relay.close(() => done())),
    ]);
  });

  // The browser: its page's origin, share-web's API as its fetch reaches it, and its sockets to share-web.
  const sockets: NodeWebSocket[] = [];
  vi.stubGlobal("location", { origin: audience, host: publicHost });
  vi.stubGlobal("fetch", async (input: string, init: RequestInit) =>
    application.handle(
      new Request(new URL(input, audience), {
        ...init,
        headers: {
          ...(init.headers as Record<string, string>),
          host: publicHost,
          origin: audience,
          cookie: ownerCookie,
        },
      }),
    ),
  );
  vi.stubGlobal(
    "WebSocket",
    class extends NodeWebSocket {
      constructor(url: string, protocols: string[]) {
        const target = new URL(url);
        expect(target.origin).toBe(`wss://${publicHost}`);
        super(`ws://127.0.0.1:${sharePort}${target.pathname}${target.search}`, protocols, {
          headers: { host: publicHost, origin: audience, cookie: ownerCookie },
          perMessageDeflate: false,
        });
        sockets.push(this);
      }
    },
  );
  cleanups.push(async () => sockets.forEach((socket) => socket.terminate()));
  return { f, engine, opens };
}

const text = (doc: Y.Doc) => doc.getXmlFragment("body").toString();
const paragraph = (doc: Y.Doc, words: string) => {
  const line = new Y.XmlElement("paragraph");
  line.insert(0, [new Y.XmlText(words)]);
  doc.getXmlFragment("body").push([line]);
};

it("takes the owner's browser edit through share-web to the desktop, and brings the desktop's edit back unquarantined", async () => {
  const { f, engine, opens } = await owner();
  const signal = new AbortController().signal;

  // The desktop is in the note's room.
  const desktop = f.connect("");
  expect(await desktop.status).toBe(101);
  // The first save moved the journal on, so the desktop acknowledges the cursor its initial sync names.
  await openProductionSync(f, desktop, false);
  const send = (frame: LiveFrame) =>
    desktop.ws.send(encodeLiveFrame(frame, f.frames.receive.maxFrameBytes));
  send({
    kind: "credit",
    grantedBytes: f.frames.maxQueuedBytes,
    grantedFrames: f.frames.maxQueuedFrames,
  });
  let synced: LiveFrameBegin | undefined;
  await desktop.until(() => {
    synced = desktop.received.find(
      (frame): frame is LiveFrameBegin =>
        frame.kind === "begin" && frame.purpose === "initial-sync",
    );
    return synced !== undefined && desktop.received.at(-1)?.kind === "chunk";
  }, "the initial sync");
  if (synced?.purpose !== "initial-sync") throw new Error("No initial sync.");
  send({ kind: "sync-applied", appliedThroughJournalCursor: synced.appliedThroughJournalCursor });

  // The viewer opens the page as the owner's page view does.
  const admission = await openMemberPage(
    { workspaceId: scope.workspaceId },
    binding.currentPath,
    signal,
  );
  expect(opens).toEqual([`/sync/${scope.workspaceId}/ops/openPage`]);
  expect(admission).toMatchObject({ kind: "owner", objectId: binding.objectId });
  if (admission.kind !== "owner") throw new Error("The page did not open.");
  const refusals: string[] = [];
  const page = memberDocument({
    target: { workspaceId: scope.workspaceId },
    path: binding.currentPath,
    accountId: "owner-1",
    admission,
    onRefused: (code) => refusals.push(code),
  });
  cleanups.push(async () => page.close());
  void page.session.reconnect();
  await vi.waitFor(() => expect(page.session.state().status).toBe("live"), { timeout: 10_000 });

  // The owner types in the browser. The engine applies it, and the desktop reads it from the relay.
  expect(page.session.edit(() => paragraph(page.session.doc, "From the browser"))).toBe(true);
  await vi.waitFor(() => expect(page.session.state().pendingUpdates).toBe(0), { timeout: 10_000 });
  expect(text(engine.state)).toContain("From the browser");
  // Saved as the owner's own edit, never an agent's.
  const saved = vi
    .mocked(f.storage.commitLiveUpdateJournal)
    .mock.calls.map(([input]) => input)
    .filter((input) => input.metadata.deliveryId !== "first-save");
  expect(saved).toHaveLength(1);
  expect(saved[0]).toMatchObject({
    actor: { kind: "owner", userId: "owner-1" },
    metadata: { authorContext: { kind: "account", accountId: "owner-1" } },
  });
  const desktopDoc = new Y.Doc();
  await desktop.until(() => {
    for (const bytes of transfers(f, desktop.received)) Y.applyUpdate(desktopDoc, bytes);
    return text(desktopDoc).includes("From the browser");
  }, "the browser's edit");

  // The desktop types. The room saves it, and the browser's own feed brings it in.
  const desktopEdit = new Y.Doc();
  Y.applyUpdate(desktopEdit, Y.encodeStateAsUpdate(engine.state));
  const before = Y.encodeStateVector(desktopEdit);
  paragraph(desktopEdit, "From the desktop");
  submit(f, desktop, Y.encodeStateAsUpdate(desktopEdit, before));
  await vi.waitFor(() => expect(text(page.session.doc)).toContain("From the desktop"), {
    timeout: 10_000,
  });
  expect(page.session.state()).toMatchObject({ status: "live", reason: null });
  expect(refusals).toEqual([]);
});

/** The initial sync and applied updates a socket has received whole, as Yjs updates in order. */
function transfers(f: Fixture, frames: LiveFrame[]): Uint8Array[] {
  const updates: Uint8Array[] = [],
    open = new Map<number, { begin: LiveFrameBegin; chunks: Uint8Array[] }>();
  for (const frame of frames) {
    if (
      frame.kind === "begin" &&
      (frame.purpose === "initial-sync" || frame.purpose === "applied-update")
    )
      open.set(frame.transferId, { begin: frame, chunks: [] });
    else if (frame.kind === "chunk" && open.has(frame.transferId)) {
      const transfer = open.get(frame.transferId)!;
      transfer.chunks.push(frame.bytes);
      if (
        transfer.chunks.reduce((total, chunk) => total + chunk.length, 0) ===
        transfer.begin.totalBytes
      ) {
        const bytes = Buffer.concat(transfer.chunks);
        updates.push(
          transfer.begin.purpose === "initial-sync"
            ? decodeLiveFrameSync(bytes, f.frames.receive).missingStateUpdate
            : bytes,
        );
        open.delete(frame.transferId);
      }
    }
  }
  return updates;
}

function submit(f: Fixture, socket: ReturnType<Fixture["connect"]>, updateBytes: Uint8Array) {
  const encode = (frame: LiveFrame) => encodeLiveFrame(frame, f.frames.receive.maxFrameBytes);
  socket.ws.send(
    encode({
      kind: "begin",
      purpose: "submit-update",
      deliveryId: "desktop-edit",
      transferId: 2,
      totalBytes: updateBytes.length,
      digest: createHash("sha256").update(updateBytes).digest("hex"),
    }),
  );
  socket.ws.send(encode({ kind: "chunk", transferId: 2, offset: 0, bytes: updateBytes }));
}
