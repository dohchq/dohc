import { once } from "node:events";
import { request as httpRequest } from "node:http";
import { createHash } from "node:crypto";
import { WebSocket } from "ws";
import { afterEach, expect, it, vi } from "vitest";
import { serveFetchHandler } from "@dohc/service-http";
import { UnauthorizedError } from "@dohc/workspace-auth/session";
import { createLiveFrameSession, decodeLiveFrame, type LiveFrame } from "@dohc/live-session-contract/live-frame";
import { createLiveMarkdownJournalValidator } from "@dohc/ydoc-projection/live-journal-validation";
import { createSyncRelayHandler } from "./server.js";
import { createNamedLiveRoutes, type NamedLiveRouteLimits } from "./namedLiveRoutes.js";
import { createLinkLiveBrowserResolver } from "./linkLiveBrowserAuth.js";
import { hashLinkBearer, hashLinkProfileSecret } from "./linkSecurity.js";
import { createLiveTickets } from "./liveTickets.js";
import { createLiveHostReports } from "./namedLiveHostReports.js";
import { createNamedFrameChanges, type NamedFrameNativeHost } from "./namedLiveFrameHost.js";
import { fixture as ticketFixture, audience, binding, host, key, scope } from "./liveTickets.test-helper.js";
import { parseNamedLiveConfig } from "./namedLiveConfig.js";

const exchangeKey = "test-exchange-key-".repeat(3), relayHost = "relay.example.test";
const frames = { receive: { maxFrameBytes: 1024, maxStateVectorBytes: 1024, maxUpdateBytes: 4096, maxSyncBytes: 4096 },
  maxQueuedBytes: 4096, maxQueuedFrames: 32, maxControlBytes: 4096, maxControlFrames: 8, maxAssemblyBytes: 4096 };
const bounds = { maxClientVectorBytes: 1024, maxSyncOutputBytes: 4096, maxAppliedUpdateBytes: 4096, maxSubmissionBytes: 4096, maxAdmissionBytes: 16384 };
const policy = { maxStructVisits: 10000, maxValueNodeVisits: 10000, maxDecodedPayloadByteVisits: 1000000, maxStructClientGroupVisits: 10000,
  maxDeleteClientGroupVisits: 10000, maxDeleteIntervalVisits: 10000, maxIndexOperations: 100000 };
const limits: NamedLiveRouteLimits = { maxConnections: 8, maxConnectionsPerSession: 2, maxConnectionsPerPrincipal: 3, maxConnectionsPerGrant: 4,
  maxPendingRequests: 4, maxRequestBytes: 4096, maxResponseBytes: 4096, maxPendingBytes: 4096, maxFragments: 8, maxBufferedChunks: 16,
  upgradeTimeoutMs: 1000, idleTimeoutMs: 5000, drainTimeoutMs: 100 };
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); vi.restoreAllMocks(); });
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve };
}
async function fixture(routeLimits = limits, link = false) {
  const state = await ticketFixture();
  const routeKind = link ? "link" : "named";
  const bearer = Buffer.alloc(32, 1).toString("base64url"), profile = Buffer.alloc(32, 2).toString("base64url");
  const currentScope = link ? { kind: "link" as const, workspaceId: scope.workspaceId, shareId: scope.shareId, grantId: scope.grantId,
    sessionId: "link-session", capabilityHash: hashLinkBearer(bearer, key), profileTokenHash: hashLinkProfileSecret(profile, key) } : scope;
  const linkHeaders: Record<string, string> = link ? { authorization: `Bearer ${bearer}`, "x-dohc-link-profile-secret": profile } : {};
  if (link) {
    vi.spyOn(Date, "now").mockReturnValue(1000);
    state.raw.exec("UPDATE sync_relay_share_grants SET principal_kind='link', principal_user_id=NULL");
    expect(state.storage.mintLinkSession({ session: { sessionId: "link-session", capabilityHash: hashLinkBearer(bearer, key),
      grantId: scope.grantId, generation: 4, mintedAtMs: 999, expiresAtMs: 61_000 } })).toBe(true);
  }
  const changes = createNamedFrameChanges(16), invalidated = new AbortController();
  const native: NamedFrameNativeHost = {
    workspace: "never-send-native-handle", registrationId: 73, binding: { ...binding, selectorPaths: [binding.currentPath] }, coordinate: host,
    invalidated: invalidated.signal, changes, deadlineMs: 1000, nextRequestId: () => 1, drain: vi.fn(async () => undefined),
    client: {
      openLiveAppliedSync: vi.fn(async () => ({ binding: { ...binding, selectorPaths: [binding.currentPath] }, hostVector: Buffer.from([0]), missingStateUpdate: Buffer.from([0, 0]),
        observedLocalYDocHeadSequence: 100, position: { eventCount: 0, journalCursor: 0, evidenceDigest: "ab".repeat(32) } })),
      readNextLiveApplied: vi.fn(async () => null), readLiveApplicationAck: vi.fn(async () => null),
    },
  };
  const captureNative = vi.fn(async () => native);
  const actor = vi.fn(async (request: Request, workspaceId: string) => {
    const cookie = request.headers.get("cookie");
    if (!cookie || cookie === "anonymous") throw new UnauthorizedError();
    return { userId: cookie === "account=reader" ? scope.userId : "other-user", workspaceId };
  });
  const application = createSyncRelayHandler({ storage: state.storage, resolveActor: actor, shareWebOrigin: audience, relayExchangeKey: exchangeKey, nowMs: () => 1000,
    namedBrowserSessionLimits: { maxSessions: 8, retentionMs: 30000, maxPendingRequests: 4, maxRequestBytes: 16384, maxResponseBytes: 16384, timeoutMs: 1000 } });
  const tickets = createLiveTickets({ storage: state.storage, audience, key, hostReports: createLiveHostReports({ storage: state.storage, captureNative }) });
  const routes = createNamedLiveRoutes({ kind: routeKind, storage: state.storage, hosts: new Set([relayHost]), publicOrigin: audience, exchangeKey, frames, bounds, limits: routeLimits,
    validate: createLiveMarkdownJournalValidator(policy), sessions: link ? createLinkLiveBrowserResolver({storage: state.storage, linkKey: key}) : { resolve: application.resolveNamedBrowserSession }, tickets, captureNative });
  const http = serveFetchHandler({ handler: request => new URL(request.url).pathname === `/sync/live/${routeKind}-tickets` ? routes.handle(request) : application(request),
    maxBodyBytes: () => 16384, oversized: () => Response.json({}, { status: 404 }), failure: () => Response.json({}, { status: 500 }) });
  const upgrades: Promise<void>[] = [], sockets: WebSocket[] = [];
  http.on("upgrade", (request, socket, head) => { upgrades.push(routes.handleUpgrade(request, socket, head)); });
  http.listen(0, "127.0.0.1"); await once(http, "listening");
  const port = (http.address() as { port: number }).port;
  async function post(path: string, body: unknown, cookie = "account=reader", extra: Record<string, string> = {}) {
    return new Promise<Response>((resolve, reject) => {
      const request = httpRequest(`http://127.0.0.1:${port}${path}`, { method: "POST", headers: {
        host: relayHost, origin: audience, "x-dohc-relay-exchange-key": exchangeKey, "content-type": "application/json", cookie, ...linkHeaders, ...extra } }, response => {
        const bytes: Buffer[] = []; response.on("data", chunk => bytes.push(Buffer.from(chunk)));
        response.once("end", () => resolve(new Response(Buffer.concat(bytes), { status: response.statusCode })));
        response.once("error", reject);
      });
      request.once("error", reject); request.end(JSON.stringify(body));
    });
  }
  cleanups.push(async () => { routes.close(); sockets.forEach(ws => ws.terminate()); await Promise.all(upgrades); await new Promise<void>(done => http.close(() => done())); await state.close(); });
  const bootstrap = link ? Response.json({ discriminator: "abcdefghijkl" }) : await post("/sync/live/named-sessions", { grantId: scope.grantId });
  expect(bootstrap.status).toBe(200);
  const { discriminator } = await bootstrap.json() as { discriminator: string };
  async function mint() {
    if (!link) expect(await application.resolveNamedBrowserSession(new Request("https://relay.example.test", { headers: { cookie: "account=reader" } }), discriminator)).toEqual(scope);
    expect(state.storage.resolveLiveObjectHostBinding(currentScope, binding.objectId)).toMatchObject({ kind: "current", binding });
    const response = await post(`/sync/live/${routeKind}-tickets`, { discriminator, objectId: binding.objectId });
    expect(response.status).toBe(200); return await response.json() as { token: string; expiresAtMs: number };
  }
  function connect(token: string, cookie = "account=reader", extra: Record<string, string> = {}) {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/sync/live/${routeKind}?session=${discriminator}`, ["dohc-live-v1", `dohc-live-ticket.${token}`], {
      headers: { host: relayHost, origin: audience, "x-dohc-relay-exchange-key": exchangeKey, cookie, ...linkHeaders, ...extra }, perMessageDeflate: false });
    sockets.push(ws); ws.on("error", () => undefined);
    const received: LiveFrame[] = [], watchers = new Set<() => void>();
    ws.on("message", bytes => { received.push(decodeLiveFrame(Buffer.from(bytes as Buffer), frames.receive.maxFrameBytes)); for (const notify of watchers) notify(); });
    const status = new Promise<number>(done => {
      ws.once("open", () => done(101)); ws.once("error", () => done(0));
      ws.once("unexpected-response", (_request, response) => { response.resume(); done(response.statusCode!); ws.terminate(); });
    });
    function until(condition: () => boolean) {
      if (condition()) return Promise.resolve();
      return new Promise<void>(done => { const notify = () => { if (condition()) { watchers.delete(notify); done(); } }; watchers.add(notify); });
    }
    return { ws, status, received, until };
  }
  return { ...state, post, discriminator, mint, connect, currentScope, bearer, profile, captureNative, native, changes, invalidated, actor, application, routes };
}

it.each([false, true])("mints through actual HTTP auth and redeems once before exposing only live frames; link=%s", async link => {
  const f = await fixture(limits, link), minted = await f.mint();
  expect(Object.keys(minted).sort()).toEqual(["expiresAtMs", "token"]);
  const browser = f.connect(minted.token); expect(await browser.status).toBe(101);
  await browser.until(() => browser.received.some(frame => frame.kind === "welcome"));
  expect(browser.ws.protocol).toBe("dohc-live-v1");
  expect(browser.received[0]).toMatchObject({ kind: "welcome", hostEpoch: host.hostEpoch });
  expect(JSON.stringify(browser.received)).not.toContain("never-send-native-handle");
  expect(JSON.stringify(browser.received)).not.toContain("registrationId");
  expect(f.raw.prepare("SELECT redeemed_at_ms FROM sync_relay_live_session_tickets").get()).toEqual({ redeemed_at_ms: 1000 });
  expect(await f.connect(minted.token).status).toBe(404);
});

it.each(["anonymous", "account=other"])("refuses %s on HTTP and WebSocket without consuming the valid ticket", async cookie => {
  const f = await fixture(), minted = await f.mint();
  expect((await f.post("/sync/live/named-tickets", { discriminator: f.discriminator, objectId: binding.objectId }, cookie)).status).toBe(404);
  expect(await f.connect(minted.token, cookie).status).toBe(404);
  expect(f.raw.prepare("SELECT redeemed_at_ms FROM sync_relay_live_session_tickets").get()).toEqual({ redeemed_at_ms: null });
  expect(await f.connect(minted.token).status).toBe(101);
});

it.each(["grant", "fence", "host"])("refuses a %s change between mint and upgrade", async changed => {
  const f = await fixture(), minted = await f.mint();
  if (changed === "grant") f.raw.exec("UPDATE sync_relay_share_grants SET generation=generation+1");
  if (changed === "fence") f.raw.exec("UPDATE sync_relay_live_documents SET restore_fence_generation=restore_fence_generation+1");
  if (changed === "host") f.invalidated.abort();
  expect(await f.connect(minted.token).status).toBe(404);
});

it.each<Record<string, string>>([{ origin: "https://foreign.example" }, { "x-dohc-relay-exchange-key": "wrong" }, { host: "foreign.example" }])("rejects untrusted forwarded route headers %j", async headers => {
  const f = await fixture(), minted = await f.mint();
  expect((await f.post("/sync/live/named-tickets", { discriminator: f.discriminator, objectId: binding.objectId }, "account=reader", headers)).status).toBe(404);
  expect(await f.connect(minted.token, "account=reader", headers).status).toBe(404);
  expect(f.raw.prepare("SELECT redeemed_at_ms FROM sync_relay_live_session_tickets").get()).toEqual({ redeemed_at_ms: null });
});

it("checks standing again when native capture finishes after a grant change", async () => {
  const f = await fixture(), minted = await f.mint(), entered = deferred<void>(), resume = deferred<void>();
  let calls = 0;
  f.captureNative.mockImplementation(async () => { if (++calls === 2) { entered.resolve(); await resume.promise; } return f.native; });
  const browser = f.connect(minted.token); await entered.promise;
  f.raw.exec("UPDATE sync_relay_share_grants SET generation=generation+1"); resume.resolve();
  expect(await browser.status).toBe(404);
  expect(f.native.client.openLiveAppliedSync).not.toHaveBeenCalled();
});

it("closes an upgraded route on standing invalidation without retiring its native registration", async () => {
  const f = await fixture(), minted = await f.mint(), browser = f.connect(minted.token);
  expect(await browser.status).toBe(101);
  const closed = once(browser.ws, "close");
  f.raw.exec("UPDATE sync_relay_share_grants SET generation=generation+1"); f.changes.notify(); await closed;
  expect(f.native.client.openLiveAppliedSync).not.toHaveBeenCalled();
  expect(f.native.invalidated.aborted).toBe(false);
  expect(f.changes.listenerCount()).toBe(0);
});

it("delivers accepted native sync through actual binary WebSocket frames", async () => {
  const f = await fixture(), minted = await f.mint(), browser = f.connect(minted.token);
  expect(await browser.status).toBe(101);
  await browser.until(() => browser.received.some(frame => frame.kind === "credit"));
  const protocol = createLiveFrameSession("client", frames);
  for (const frame of browser.received) { const encoded = (await import("@dohc/live-session-contract/live-frame")).encodeLiveFrame(frame, 1024); protocol.receive(encoded).release(); }
  const send = (frame: LiveFrame) => { const lease = protocol.send(frame); browser.ws.send(lease.value); lease.release(); };
  send({ kind: "hello", receivePolicy: frames.receive }); send({ kind: "credit", grantedBytes: 4096, grantedFrames: 32 });
  const bytes = Uint8Array.of(0);
  send({ kind: "begin", purpose: "client-vector", transferId: 1, totalBytes: 1, digest: createHash("sha256").update(bytes).digest("hex") });
  send({ kind: "chunk", transferId: 1, offset: 0, bytes });
  await browser.until(() => browser.received.some(frame => frame.kind === "chunk"));
  expect(browser.received.find(frame => frame.kind === "begin")).toMatchObject({ purpose: "initial-sync", appliedThroughJournalCursor: 0 });
  expect(f.native.client.openLiveAppliedSync).toHaveBeenCalledTimes(1);
  expect(f.native.client.readNextLiveApplied).not.toHaveBeenCalled();
  protocol.close();
});

it("rejects missing provisioning budgets and uses the promoted journal validator", () => {
  const config = { version: 1, tickets: { retainedTicketsPerPrincipalGrant: 2, expiredTicketCleanupBatchSize: 1 }, transport: limits, frames,
    host: bounds, validation: policy, maxListeners: 16 };
  expect(typeof parseNamedLiveConfig(config).validate).toBe("function");
  for (const field of Object.keys(config)) {
    const missing = { ...config } as Record<string, unknown>; delete missing[field]; expect(() => parseNamedLiveConfig(missing)).toThrow();
  }
  expect(() => parseNamedLiveConfig({ ...config, maxListeners: 1 })).toThrow();
});

it("keeps a cancelled authentication in its connection slot until it settles", async () => {
  const f = await fixture({ ...limits, maxConnections: 1 }), first = await f.mint(), second = await f.mint();
  const entered = deferred<void>(), resume = deferred<void>();
  f.actor.mockImplementation(async (_request, workspaceId) => { entered.resolve(); await resume.promise; return { userId: scope.userId, workspaceId }; });
  const browser = f.connect(first.token); await entered.promise;
  try {
    const closed = new Promise<void>(done => browser.ws.once("close", () => done())); browser.ws.terminate(); await closed;
    expect(await f.connect(second.token).status).toBe(404);
    expect(f.raw.prepare("SELECT COUNT(*) AS count FROM sync_relay_live_session_tickets WHERE redeemed_at_ms IS NOT NULL").get()).toEqual({ count: 0 });
  } finally { resume.resolve(); }
});

it("aborts the HTTP response on route shutdown while retaining pending authentication", async () => {
  const f = await fixture(), entered = deferred<void>(), resume = deferred<void>();
  f.actor.mockImplementation(async (_request, workspaceId) => { entered.resolve(); await resume.promise; return { userId: scope.userId, workspaceId }; });
  const pending = f.post("/sync/live/named-tickets", { discriminator: f.discriminator, objectId: binding.objectId });
  await entered.promise; f.routes.close(); expect((await pending).status).toBe(404); resume.resolve();
  expect(f.captureNative).not.toHaveBeenCalled();
});

it("never accepts browser identity fields or mismatched trusted share scope", async () => {
  const f = await fixture();
  expect((await f.post("/sync/live/named-tickets", { discriminator: f.discriminator, objectId: binding.objectId, userId: scope.userId })).status).toBe(404);
  expect(f.storage.resolveLiveObjectHostBinding({ ...scope, shareId: "other-share" }, binding.objectId)).toMatchObject({ kind: "refused", reason: "not-authorized" });
  expect(f.storage.resolveLiveObjectHostBinding(scope, "missing-object")).toMatchObject({ kind: "refused", reason: "stale-document" });
  expect(f.captureNative).not.toHaveBeenCalled();
});

it("answers control ping within its explicit budget and rejects text application data", async () => {
  const f = await fixture(), minted = await f.mint(), browser = f.connect(minted.token);
  expect(await browser.status).toBe(101);
  const pong = once(browser.ws, "pong"); browser.ws.ping("probe"); expect((await pong)[0].toString()).toBe("probe");
  const closed = once(browser.ws, "close"); browser.ws.send("not binary"); await closed;
  expect(f.native.client.openLiveAppliedSync).not.toHaveBeenCalled();
});


it("binds a link socket to its exact session and closes it when that session is refreshed", async () => {
  const f = await fixture(limits, true), minted = await f.mint(), browser = f.connect(minted.token);
  expect(await browser.status).toBe(101);
  await browser.until(() => browser.received.some(frame => frame.kind === "welcome"));
  const principal = f.raw.prepare("SELECT principal_id,display_name FROM sync_relay_link_principals").get()!;
  expect(principal.display_name).toBeNull();
  const serialized = JSON.stringify({ frames: browser.received, ticket: f.raw.prepare("SELECT * FROM sync_relay_live_session_tickets").get() });
  for (const secret of [f.bearer, f.profile, hashLinkBearer(f.bearer, key), hashLinkProfileSecret(f.profile, key)]) expect(serialized).not.toContain(secret);
  const old = f.storage.findLinkSessionByCapabilityHash(hashLinkBearer(f.bearer, key))!;
  const closed = once(browser.ws, "close");
  expect(f.storage.replaceLinkSession({ currentSession: old, session: { sessionId: "new-link-session", capabilityHash: hashLinkBearer("fresh", key),
    grantId: old.grantId, generation: old.generation, mintedAtMs: 1000, expiresAtMs: 70_000 }, guard() {} })).toBe(true);
  f.changes.notify(); await closed;
  expect(f.invalidated.signal.aborted).toBe(false);
  expect(f.raw.prepare("SELECT link_session_id FROM sync_relay_live_session_tickets").get()).toEqual({ link_session_id: old.sessionId });
});

it.each<Record<string, string>>([
  { authorization: "" }, { "x-dohc-link-profile-secret": "" }, { "x-dohc-link-profile-secret": Buffer.alloc(32, 9).toString("base64url") },
  { origin: "https://other.example" }, { host: "other.example" }, { "x-dohc-relay-exchange-key": "forged" },
])("refuses invalid private link credentials and origin without consuming a ticket: %j", async headers => {
  const f = await fixture(limits, true), minted = await f.mint();
  expect((await f.post("/sync/live/link-tickets", {discriminator: f.discriminator, objectId: binding.objectId}, "anonymous", headers)).status).toBe(404);
  expect(await f.connect(minted.token, "anonymous", headers).status).toBe(404);
  expect(f.raw.prepare("SELECT redeemed_at_ms FROM sync_relay_live_session_tickets").get()).toEqual({redeemed_at_ms: null});
  expect(await f.connect(minted.token, "anonymous").status).toBe(101);
});
