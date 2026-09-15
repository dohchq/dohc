import { request as httpRequest } from "node:http";
import { once } from "node:events";
import { createHash } from "node:crypto";
import { WebSocket } from "ws";
import { getCookies } from "better-auth/cookies";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { getDohcYDocBodyFragment } from "@dohc/ydoc-projection/body-fragment";
import { createLiveMarkdownJournalValidator } from "@dohc/ydoc-projection/live-journal-validation";
import { serveFetchHandler } from "@dohc/service-http";
import { UnauthorizedError } from "@dohc/workspace-auth/session";
import { createSyncRelayHandler } from "../../sync-relay/src/server.js";
import { createNamedLiveRoutes } from "../../sync-relay/src/namedLiveRoutes.js";
import { createLiveTickets } from "../../sync-relay/src/liveTickets.js";
import { createLiveHostReports } from "../../sync-relay/src/namedLiveHostReports.js";
import { createNamedFrameChanges, type NamedFrameNativeHost } from "../../sync-relay/src/namedLiveFrameHost.js";
import { fixture as ticketFixture, audience, binding, host, key, scope } from "../../sync-relay/src/liveTickets.test-helper.js";
import { createShareWebApplication } from "./server.js";
import { createLiveGateway } from "./liveGateway.js";
import { createNamedLiveRelayRoute, namedLiveGatewayRequest } from "./namedLiveRelayRoute.js";
import { createNamedLiveProvider } from "@dohc/ydoc-projection/named-live-provider";

const exchangeKey = "network-test-key-".repeat(3), cookieName = getCookies({ baseURL: audience }).sessionToken.name;
const cookie = `${cookieName}=reader-account`, otherCookie = `${cookieName}=other-account`;
const frames = { receive: { maxFrameBytes: 1024, maxStateVectorBytes: 1024, maxUpdateBytes: 4096, maxSyncBytes: 8192 },
  maxQueuedBytes: 8192, maxQueuedFrames: 32, maxControlBytes: 4096, maxControlFrames: 8, maxAssemblyBytes: 8192 };
const browserLimits = { maxPendingRequests: 4, maxRequestBytes: 2048, maxResponseBytes: 5000, timeoutMs: 2000 };
const transport = { maxConnections: 4, maxConnectionsPerSession: 2, maxConnectionsPerPrincipal: 3, maxConnectionsPerGrant: 4,
  maxPendingRequests: 4, maxRequestBytes: 2048, maxResponseBytes: 5000, maxPendingBytes: 8192, maxFragments: 8, maxBufferedChunks: 16,
  upgradeTimeoutMs: 2000, idleTimeoutMs: 10000, drainTimeoutMs: 100 };
const policy = { maxStructVisits: 10000, maxValueNodeVisits: 10000, maxDecodedPayloadByteVisits: 1000000, maxStructClientGroupVisits: 10000,
  maxDeleteClientGroupVisits: 10000, maxDeleteIntervalVisits: 10000, maxIndexOperations: 100000 };
const cleanups: (() => Promise<void>)[] = [];
beforeEach(() => {vi.spyOn(Date, "now").mockReturnValue(1000);});
afterEach(async () => {
  try { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); }
  finally { vi.restoreAllMocks(); }
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve };
}
async function post(port: number, path: string, body: unknown, account = cookie) {
  return new Promise<Response>((resolve, reject) => {
    const request = httpRequest(`http://127.0.0.1:${port}${path}`, { method: "POST", headers: {
      host: new URL(audience).host, origin: audience, cookie: `${account}; unrelated-link=not-forwarded`, "content-type": "application/json" } }, response => {
      const bytes: Buffer[] = []; response.on("data", chunk => bytes.push(Buffer.from(chunk)));
      response.once("end", () => resolve(new Response(Buffer.concat(bytes), { status: response.statusCode, headers: { "content-type": "application/json" } })));
      response.once("error", reject);
    });
    request.once("error", reject); request.end(JSON.stringify(body));
  });
}

/** Real public/relay HTTP and WS hops; native methods deliberately remain synthetic. */
async function fixture() {
  const stored = await ticketFixture(), sharedChanges = createNamedFrameChanges(8), invalidated = new AbortController();
  const noListeners = deferred<void>();
  const changes = { ...sharedChanges, subscribe(...args: Parameters<typeof sharedChanges.subscribe>) {
    const remove = sharedChanges.subscribe(...args);
    return () => { remove(); if (sharedChanges.listenerCount() === 0) noListeners.resolve(); };
  } };
  const doc = new Y.Doc(), text = new Y.XmlText(), paragraph = new Y.XmlElement("paragraph");
  text.insert(0, "native base"); paragraph.insert(0, [text]); getDohcYDocBodyFragment(doc).insert(0, [paragraph]);
  const opened = deferred<void>(), waitingRead = deferred<void>(), abortedSync = deferred<void>();
  let blockSync = false, queued: { bytes: Uint8Array; cursor: number } | undefined, acceptedCursor = 0;
  const native: NamedFrameNativeHost = {
    workspace: "private-native-handle", registrationId: 91, binding: { ...binding, selectorPaths: [binding.currentPath] }, coordinate: host,
    invalidated: invalidated.signal, changes, deadlineMs: 2000, nextRequestId: () => 1, drain: vi.fn(async () => undefined),
    client: {
      openLiveAppliedSync: vi.fn(async (_request, vector, _bounds, signal) => {
        opened.resolve();
        if (blockSync) await new Promise<void>((_resolve, reject) => {
          const abort = () => { abortedSync.resolve(); reject(signal?.reason); };
          signal!.addEventListener("abort", abort, { once: true }); if (signal!.aborted) abort();
        });
        return { binding: { ...binding, selectorPaths: [binding.currentPath] }, hostVector: Buffer.from(Y.encodeStateVector(doc)),
          missingStateUpdate: Buffer.from(Y.encodeStateAsUpdate(doc, vector)), observedLocalYDocHeadSequence: 99,
          position: { eventCount: 0, journalCursor: 0, evidenceDigest: "ab".repeat(32) } };
      }),
      readNextLiveApplied: vi.fn(async (_request, after) => {
        waitingRead.resolve(); const next = queued; queued = undefined;
        if (!next) return null;
        return { position: { eventCount: after.eventCount + 1, journalCursor: next.cursor, evidenceDigest: "cd".repeat(32) }, updateBytes: Buffer.from(next.bytes),
          ack: { deliveryId: "native-peer", updateDigest: createHash("sha256").update(next.bytes).digest("hex"), journalCursor: next.cursor,
            acceptingHostEpoch: host.hostEpoch, localYDocSequence: 7, applicationReplayed: false } };
      }),
      readLiveApplicationAck: vi.fn(async () => null),
    },
  };
  const resolveActor = vi.fn(async (request: Request, workspaceId: string) => {
    expect(request.headers.get("authorization")).toBeNull();
    expect(request.headers.get("cookie")).not.toContain("unrelated-link");
    if (request.headers.get("cookie") === cookie) return { userId: scope.userId, workspaceId };
    if (request.headers.get("cookie") === otherCookie) return { userId: "other-user", workspaceId };
    throw new UnauthorizedError();
  });
  const relayApp = createSyncRelayHandler({ storage: stored.storage, resolveActor, shareWebOrigin: audience, relayExchangeKey: exchangeKey, nowMs: () => 1000,
    namedBrowserSessionLimits: { ...browserLimits, maxSessions: 8, retentionMs: 30000 } });
  let routes!: ReturnType<typeof createNamedLiveRoutes>;
  const relayHttp = serveFetchHandler({ handler: request => new URL(request.url).pathname === "/sync/live/named-tickets" ? routes.handle(request) : relayApp(request),
    maxBodyBytes: () => 8192, oversized: () => new Response(null, { status: 404 }), failure: () => new Response(null, { status: 500 }) });
  relayHttp.listen(0, "127.0.0.1"); await once(relayHttp, "listening");
  const relayUrl = `http://127.0.0.1:${(relayHttp.address() as { port: number }).port}`;
  const captureNative = vi.fn(async () => native);
  const tickets = createLiveTickets({ storage: stored.storage, audience, key, hostReports: createLiveHostReports({ storage: stored.storage, captureNative }) });
  routes = createNamedLiveRoutes({ kind: "named", storage: stored.storage, hosts: new Set([new URL(relayUrl).host]), publicOrigin: audience, exchangeKey, frames, limits: transport,
    bounds: { maxClientVectorBytes: 1024, maxSyncOutputBytes: 8192, maxAppliedUpdateBytes: 4096, maxSubmissionBytes: 4096, maxAdmissionBytes: 16384 },
    validate: createLiveMarkdownJournalValidator(policy), sessions: { resolve: relayApp.resolveNamedBrowserSession }, tickets, captureNative });
  const upgrades: Promise<void>[] = [];
  relayHttp.on("upgrade", (request, socket, head) => { upgrades.push(routes.handleUpgrade(request, socket, head)); });
  const application = createShareWebApplication({ relayUrl, publicRelayUrl: audience, relayExchangeKey: exchangeKey,
    publicHosts: new Set([new URL(audience).host]), accountAuth: { publicOrigin: audience, upstreamUrl: "http://127.0.0.1:1" },
    namedBrowserSessionLimits: browserLimits, namedLiveTickets: true });
  const gateway = createLiveGateway({ publicOrigin: audience, publicHosts: new Set([new URL(audience).host]),
    limits: { maxConnections: 4, maxConnectionsPerSession: 2, maxConnectionsPerPrincipal: 3, maxConnectionsPerGrant: 4,
      maxFrameBytes: 1024, maxPendingBytes: 8192, maxPendingFrames: 32, maxFragments: 8, maxBufferedChunks: 16,
      upgradeTimeoutMs: 2000, idleTimeoutMs: 10000, drainTimeoutMs: 100 },
    resolveSession: async (request, discriminator, signal) => {
      const authenticated = namedLiveGatewayRequest(request, audience, signal);
      return authenticated ? application.resolveNamedBrowserSession(authenticated, discriminator) : null;
    },
    openHostRoute: createNamedLiveRelayRoute({ relayUrl, publicOrigin: audience, exchangeKey, handshakeTimeoutMs: 2000 }),
  });
  const publicHttp = serveFetchHandler({ handler: application.handle, maxBodyBytes: () => 8192,
    oversized: () => new Response(null, { status: 404 }), failure: () => new Response(null, { status: 500 }) });
  publicHttp.on("upgrade", (request, socket, head) => { upgrades.push(gateway.handleUpgrade(request, socket, head)); });
  publicHttp.listen(0, "127.0.0.1"); await once(publicHttp, "listening");
  const port = (publicHttp.address() as { port: number }).port, sockets: WebSocket[] = [];
  const providers: ReturnType<typeof createNamedLiveProvider>[] = [];
  cleanups.push(async () => {
    for (const provider of providers) { provider.close(); provider.doc.destroy(); }
    gateway.close(); routes.close(); sockets.forEach(socket => socket.terminate());
    await Promise.all(upgrades);
    await Promise.all([new Promise<void>(done => publicHttp.close(() => done())), new Promise<void>(done => relayHttp.close(() => done()))]);
    doc.destroy(); await stored.close();
  });
  const bootstrap = await post(port, "/api/live/named-session", { grantId: scope.grantId });
  expect(bootstrap.status).toBe(200);
  const { discriminator } = await bootstrap.json() as { discriminator: string };
  async function mint(account = cookie) { return post(port, "/api/live/named-ticket", { discriminator, objectId: binding.objectId }, account); }
  function connect(token: string, account = cookie) {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/api/live?session=${discriminator}`, ["dohc-live-v1", `dohc-live-ticket.${token}`], {
      headers: { host: new URL(audience).host, origin: audience, cookie: `${account}; unrelated-link=not-forwarded` }, perMessageDeflate: false });
    sockets.push(ws); ws.on("error", () => undefined);
    const received: Buffer[] = []; let route: ReturnType<ReturnType<typeof createNamedLiveProvider>["connect"]> | undefined;
    ws.on("message", bytes => { const owned = Buffer.from(bytes as Buffer); received.push(owned); if (route) void route.receive(owned); });
    ws.once("close", () => route?.disconnect());
    const status = new Promise<number>(done => {
      ws.once("open", () => done(101)); ws.once("error", () => done(0));
      ws.once("unexpected-response", (_request, response) => { response.resume(); done(response.statusCode!); ws.terminate(); });
    });
    function attach() {
      const provider = createNamedLiveProvider({ frames, maxPendingUpdateBytes: 8192, maxPendingUpdates: 4, maxDeliveryAttempts: 3 }); providers.push(provider);
      route = provider.connect({ send(bytes) { return new Promise<void>((resolve, reject) => ws.send(bytes, { binary: true, compress: false }, error => error ? reject(error) : resolve())); }, close() { ws.terminate(); } });
      for (const bytes of received) void route.receive(bytes);
      return provider;
    }
    return { ws, status, received, attach };
  }
  return { ...stored, native, changes, invalidated, doc, mint, connect, opened, waitingRead, abortedSync, noListeners,
    blockSync() { blockSync = true; },
    publish(textToAppend: string) { const vector = Y.encodeStateVector(doc); text.insert(text.length, textToAppend);
      queued = { cursor: ++acceptedCursor, bytes: Y.encodeStateAsUpdate(doc, vector) }; changes.notify(binding); },
  };
}
function untilLive(provider: ReturnType<typeof createNamedLiveProvider>) {
  if (provider.state().status === "live") return Promise.resolve();
  return new Promise<void>(done => { const unsubscribe = provider.subscribe(state => { if (state.status === "live") { unsubscribe(); done(); } }); });
}
function untilBody(provider: ReturnType<typeof createNamedLiveProvider>, text: string) {
  if (provider.body.toString().includes(text)) return Promise.resolve();
  return new Promise<void>(done => { const update = () => { if (provider.body.toString().includes(text)) { provider.doc.off("update", update); done(); } }; provider.doc.on("update", update); });
}

it("runs public ticket mint, one relay redemption, initial sync, and accepted feed through both network hops", async () => {
  const f = await fixture(), minted = await f.mint(); expect(minted.status).toBe(200);
  const { token } = await minted.json() as { token: string };
  const browser = f.connect(token); expect(await browser.status).toBe(101); expect(browser.ws.protocol).toBe("dohc-live-v1");
  const provider = browser.attach(); await untilLive(provider);
  expect(provider.body.toString()).toBe(getDohcYDocBodyFragment(f.doc).toString());
  await f.waitingRead.promise; const applied = untilBody(provider, " peer"); f.publish(" peer"); await applied;
  expect(provider.body.toString()).toBe(getDohcYDocBodyFragment(f.doc).toString());
  expect(provider.state().pendingUpdates).toBe(0);
  expect(f.native.client.openLiveAppliedSync).toHaveBeenCalledTimes(1);
  expect(f.raw.prepare("SELECT COUNT(*) AS count FROM sync_relay_live_session_tickets WHERE redeemed_at_ms IS NOT NULL").get()).toEqual({ count: 1 });
  expect(await f.connect(token).status).toBe(404);
  const closed = once(browser.ws, "close"); provider.close(); await closed; await f.noListeners.promise;
  expect(f.invalidated.signal.aborted).toBe(false); expect(f.changes.listenerCount()).toBe(0);
});

it("requires the current named account at the public ticket and upgrade boundaries", async () => {
  const f = await fixture(), minted = await f.mint(), { token } = await minted.json() as { token: string };
  expect((await f.mint(otherCookie)).status).toBe(404);
  expect((await f.mint("link=only")).status).toBe(404);
  expect(await f.connect(token, otherCookie).status).toBe(404);
  expect(await f.connect(token, "link=only").status).toBe(404);
  expect(f.raw.prepare("SELECT redeemed_at_ms FROM sync_relay_live_session_tickets").get()).toEqual({ redeemed_at_ms: null });
  expect(await f.connect(token).status).toBe(101);
});

it("cancels pending native sync when the public browser closes and leaves the shared host alive", async () => {
  const f = await fixture(), minted = await f.mint(), { token } = await minted.json() as { token: string };
  f.blockSync(); const browser = f.connect(token); expect(await browser.status).toBe(101);
  const provider = browser.attach(); await f.opened.promise;
  const closed = once(browser.ws, "close"); provider.close(); await closed; await f.abortedSync.promise; await f.noListeners.promise;
  expect(f.invalidated.signal.aborted).toBe(false);
  expect(f.native.client.readNextLiveApplied).not.toHaveBeenCalled();
  expect(f.changes.listenerCount()).toBe(0);
});

it("retires both network hops when the current grant changes", async () => {
  const f = await fixture(), minted = await f.mint(), { token } = await minted.json() as { token: string };
  const browser = f.connect(token); expect(await browser.status).toBe(101);
  const provider = browser.attach(); await untilLive(provider); await f.waitingRead.promise;
  const closed = once(browser.ws, "close"); f.raw.exec("UPDATE sync_relay_share_grants SET generation=generation+1"); f.changes.notify(); await closed; await f.noListeners.promise;
  expect(provider.state().status).toBe("disconnected"); expect(f.changes.listenerCount()).toBe(0); expect(f.invalidated.signal.aborted).toBe(false);
});
