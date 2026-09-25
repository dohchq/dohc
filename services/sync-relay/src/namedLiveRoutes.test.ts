import { createNamedDesktopLive } from "./namedDesktopLive";
import {createLiveConnectionAdmission} from "./liveConnectionAdmission";
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
import { createOwnerLiveRoutes, createNamedLiveRoutes, type NamedLiveRouteLimits } from "./namedLiveRoutes.js";
import { createLinkLiveBrowserResolver } from "./linkLiveBrowserAuth.js";
import { hashLinkBearer, hashLinkProfileSecret } from "./linkSecurity.js";
import { createNamedLiveProvider } from "@dohc/ydoc-projection/named-live-provider";
import { createLiveMembershipRegistry, type LiveMembershipPolicy } from "./liveMembership.js";
import { liveBrowserActor } from "./liveBrowserContext.js";
import { captureNamedLiveFrameHost } from "./namedLiveFrameHost.js";
import { createLiveTickets } from "./liveTickets.js";
import { createLiveHostReports } from "./namedLiveHostReports.js";
import { createNamedFrameChanges, type NamedFrameNativeHost } from "./namedLiveFrameHost.js";
import { fixture as ticketFixture, audience, binding, host, key, scope } from "./liveTickets.test-helper.js";
import { parseNamedLiveConfig } from "./namedLiveConfig.js";
import type { StorageContext } from "./storage/context.js";

const exchangeKey = "test-exchange-key-".repeat(3), relayHost = "relay.example.test";
const frames = { receive: { maxFrameBytes: 1024, maxStateVectorBytes: 1024, maxUpdateBytes: 4096, maxSyncBytes: 4096 },
  maxQueuedBytes: 4096, maxQueuedFrames: 32, maxControlBytes: 4096, maxControlFrames: 8, maxAssemblyBytes: 4096 };
const bounds = { maxClientVectorBytes: 1024, maxSyncOutputBytes: 4096, maxAppliedUpdateBytes: 4096, maxSubmissionBytes: 4096, maxAdmissionBytes: 16384 };
const policy = { maxStructVisits: 10000, maxValueNodeVisits: 10000, maxDecodedPayloadByteVisits: 1000000, maxStructClientGroupVisits: 10000,
  maxDeleteClientGroupVisits: 10000, maxDeleteIntervalVisits: 10000, maxIndexOperations: 100000 };
const limits: NamedLiveRouteLimits = { maxConnections: 8, maxConnectionsPerSession: 2, maxConnectionsPerPrincipal: 3, maxConnectionsPerGrant: 4,
  maxPendingRequests: 4, maxRequestBytes: 4096, maxResponseBytes: 4096, maxPendingBytes: 4096, maxFragments: 8, maxBufferedChunks: 16,
  // Open routes idle between frames while a test sets up its next peer over real
  // sockets; a loaded gate host can stretch that past 5 s.
  upgradeTimeoutMs: 1000, idleTimeoutMs: 10_000, drainTimeoutMs: 100 };
const cleanups: (() => Promise<void>)[] = [];

it("admits the authenticated desktop recipient through the named ticket and host path", async () => {
  const f = await fixture(limits, false, undefined, false, true);
  const ticket = await f.mint();
  const socket = f.connect(ticket.token);
  expect(await socket.status).toBe(101);
  await socket.until(() => socket.received.length > 0);
  expect(f.captureNative).toHaveBeenCalled();
  expect(await f.connect(ticket.token).status).not.toBe(101);
});

it("refuses desktop cross-account, scope, Origin, cookie, and host changes", async () => {
  const f = await fixture(limits, false, undefined, false, true);
  const body = {shareId: scope.shareId, path: binding.currentPath};
  for (const headers of [{authorization: "Bearer other-token"}, {origin: "https://evil.test"}, {cookie: "account=reader"}, {host: "evil.test"}] as Record<string, string>[]) {
    expect((await f.post("/sync/live/desktop-open", body, "", headers)).status).toBe(404);
  }
  for (const path of ["other/a.md", "docs/missing.md", "docs/a.excalidraw", "../docs/a.md"]) {
    expect((await f.post("/sync/live/desktop-open", {...body, path})).status).toBe(404);
  }
  const ticket = await f.mint();
  expect(await f.connect(ticket.token, "", {authorization: "Bearer other-token"}).status).not.toBe(101);
  expect(await f.connect(ticket.token, "", {origin: "https://evil.test"}).status).not.toBe(101);
  expect(await f.connect(ticket.token, "", {cookie: "account=reader"}).status).not.toBe(101);
  expect(await f.connect(ticket.token).status).toBe(101);
});

it("does not mint more desktop tickets when browser session capacity is full", async () => {
  const f = await fixture(limits, false, undefined, false, true);
  const mint = vi.spyOn(f.tickets, "mint").mockResolvedValue({token: "ab".repeat(32), expiresAtMs: 61_000});
  const body = {shareId: scope.shareId, path: binding.currentPath};
  for (let i = 0; i < 9; i++) expect((await f.post("/sync/live/desktop-open", body)).status).toBe(200);
  expect(mint).toHaveBeenCalledTimes(9);
  expect((await f.post("/sync/live/desktop-open", body)).status).toBe(404);
  expect(mint).toHaveBeenCalledTimes(9);
});

it("returns a usable desktop session when ticket minting outlives its reservation", async () => {
  const clock = vi.spyOn(Date, "now").mockReturnValue(1000);
  const f = await fixture(limits, false, undefined, false, true);
  const original = f.tickets.mint.bind(f.tickets);
  vi.spyOn(f.tickets, "mint").mockImplementation(async (...args) => {
    clock.mockReturnValue(61_000);
    return original(...args);
  });
  const response = await f.post("/sync/live/desktop-open", {shareId: scope.shareId, path: binding.currentPath});
  expect(response.status).toBe(200);
  const session = await response.json() as {discriminator: string; expiresAtMs: number};
  expect(session.expiresAtMs).toBe(121_000);
  const request = new Request(`https://${relayHost}`, {headers: {authorization: "Bearer reader-token"}});
  expect(await f.desktopAdmission!.resolve(request, session.discriminator)).toEqual(scope);
  clock.mockReturnValue(121_000);
  expect(await f.desktopAdmission!.resolve(request, session.discriminator)).toBeNull();
});

it("releases a desktop session reservation when ticket minting refuses", async () => {
  const f = await fixture(limits, false, undefined, false, true);
  const mint = vi.spyOn(f.tickets, "mint").mockResolvedValue(null);
  const body = {shareId: scope.shareId, path: binding.currentPath};
  for (let i = 0; i < 10; i++) expect((await f.post("/sync/live/desktop-open", body)).status).toBe(404);
  mint.mockResolvedValue({token: "ab".repeat(32), expiresAtMs: 61_000});
  expect((await f.post("/sync/live/desktop-open", body)).status).toBe(200);
});
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); vi.restoreAllMocks(); });
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve };
}
async function fixture(routeLimits = limits, link = false, membershipPolicy: LiveMembershipPolicy = {maxSessions: 16, maxMembers: 8, maxSnapshotBytes: 153}, owner = false, desktop = false, admission?: ReturnType<typeof createLiveConnectionAdmission>) {
  const state = await ticketFixture();
  const routeKind = desktop ? "desktop" : link ? "link" : "named";
  const memberships = createLiveMembershipRegistry(membershipPolicy, state.storage.readLiveAuthority.bind(state.storage));
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
    if (owner || desktop) {
      const bearer = request.headers.get("authorization");
      if (!bearer) throw new UnauthorizedError();
      return {userId: bearer === "Bearer owner-token" ? "owner-1" : bearer === "Bearer reader-token" ? "reader-1" : "other-user", workspaceId};
    }
    const cookie = request.headers.get("cookie");
    if (!cookie || cookie === "anonymous") throw new UnauthorizedError();
    return { userId: cookie === "account=reader" ? scope.userId : "other-user", workspaceId };
  });
  const application = createSyncRelayHandler({ storage: state.storage, resolveActor: actor, shareWebOrigin: audience, relayExchangeKey: exchangeKey, nowMs: () => 1000,
    namedBrowserSessionLimits: { maxSessions: 8, retentionMs: 30000, maxPendingRequests: 4, maxRequestBytes: 16384, maxResponseBytes: 16384, timeoutMs: 1000 } });
  const tickets = createLiveTickets({ storage: state.storage, audience, key, hostReports: createLiveHostReports({ storage: state.storage, captureNative }) });
  const desktopAdmission = desktop ? createNamedDesktopLive({ storage: state.storage, resolveActor: actor,
    publicOrigin: audience, hosts: new Set([relayHost]), tickets,
    limits: {maxSessions: 10, retentionMs: 60000, maxPendingRequests: 4, maxRequestBytes: 16384, maxResponseBytes: 16384, timeoutMs: 1000},
    editorLimits: {provider: {frames, maxPendingUpdateBytes: 8192, maxPendingUpdates: 4, maxDeliveryAttempts: 3},
      maxHttpResponseBytes: 4096, maxSocketBufferedBytes: 4096, connectTimeoutMs: 1000, sendTimeoutMs: 1000, drainPollMs: 10} }) : undefined;
  const routes = owner ? createOwnerLiveRoutes({storage: state.storage, resolveActor: actor, hosts: new Set([relayHost]), publicOrigin: audience, exchangeKey,
    frames, bounds, limits: routeLimits, validate: createLiveMarkdownJournalValidator(policy), captureNative, admission}) : createNamedLiveRoutes({ kind: link ? "link" : "named", desktopBearer: desktop, membership: memberships, storage: state.storage, hosts: new Set([relayHost]), publicOrigin: audience, exchangeKey, frames, bounds, limits: routeLimits,
    validate: createLiveMarkdownJournalValidator(policy), sessions: desktopAdmission ?? (link ? createLinkLiveBrowserResolver({storage: state.storage, linkKey: key}) : { resolve: application.resolveNamedBrowserSession }), tickets, captureNative, admission });
  const http = serveFetchHandler({ handler: request => new URL(request.url).pathname === "/sync/live/desktop-open" && desktopAdmission ? desktopAdmission.handle(request) : new URL(request.url).pathname === `/sync/live/${routeKind}-tickets` ? routes.handle(request) : application(request),
    maxBodyBytes: () => 16384, oversized: () => Response.json({}, { status: 404 }), failure: () => Response.json({}, { status: 500 }) });
  const upgrades: Promise<void>[] = [], sockets: WebSocket[] = [];
  http.on("upgrade", (request, socket, head) => { upgrades.push(routes.handleUpgrade(request, socket, head)); });
  http.listen(0, "127.0.0.1"); await once(http, "listening");
  const port = (http.address() as { port: number }).port;
  async function post(path: string, body: unknown, cookie = "account=reader", extra: Record<string, string> = {}) {
    return new Promise<Response>((resolve, reject) => {
      const request = httpRequest(`http://127.0.0.1:${port}${path}`, { method: "POST", headers: {
        host: relayHost, "content-type": "application/json", ...(desktop ? {authorization: "Bearer reader-token"} : {origin: audience, "x-dohc-relay-exchange-key": exchangeKey, cookie, ...linkHeaders}), ...extra } }, response => {
        const bytes: Buffer[] = []; response.on("data", chunk => bytes.push(Buffer.from(chunk)));
        response.once("end", () => resolve(new Response(Buffer.concat(bytes), { status: response.statusCode })));
        response.once("error", reject);
      });
      request.once("error", reject); request.end(JSON.stringify(body));
    });
  }
  cleanups.push(async () => { routes.close(); sockets.forEach(ws => ws.terminate()); await Promise.all(upgrades); await new Promise<void>(done => http.close(() => done())); await state.close(); });
  const bootstrap = desktop ? await post("/sync/live/desktop-open", {shareId: scope.shareId, path: binding.currentPath}) : link || owner ? Response.json({ discriminator: "abcdefghijkl" }) : await post("/sync/live/named-sessions", { grantId: scope.grantId });
  expect(bootstrap.status).toBe(200);
  let { discriminator } = await bootstrap.json() as { discriminator: string };
  async function mint() {
    if (desktop) {
      const response = await post("/sync/live/desktop-open", {shareId: scope.shareId, path: binding.currentPath});
      expect(response.status).toBe(200);
      const admitted = await response.json() as {discriminator: string; ticket: {token: string; expiresAtMs: number}};
      discriminator = admitted.discriminator;
      return admitted.ticket;
    }
    if (!link && !desktop) expect(await application.resolveNamedBrowserSession(new Request("https://relay.example.test", { headers: { cookie: "account=reader" } }), discriminator)).toEqual(scope);
    expect(state.storage.resolveLiveObjectHostBinding(currentScope, binding.objectId)).toMatchObject({ kind: "current", binding });
    const response = await post(`/sync/live/${routeKind}-tickets`, { discriminator, objectId: binding.objectId });
    expect(response.status).toBe(200); return await response.json() as { token: string; expiresAtMs: number };
  }
  function connect(token: string, cookie = "account=reader", extra: Record<string, string> = {}, ownerQuery = "") {
    const target = owner ? `/sync/workspaces/${binding.workspaceId}/live/owner?shareId=${scope.shareId}&objectId=${binding.objectId}&lineageClaimId=${binding.lineageClaimId}${ownerQuery}` : `/sync/live/${routeKind}?session=${discriminator}`;
    const ws = new WebSocket(`ws://127.0.0.1:${port}${target}`, owner ? ["dohc-live-v1"] : ["dohc-live-v1", `dohc-live-ticket.${token}`], {
      headers: desktop ? {host: relayHost, authorization: "Bearer reader-token", ...extra} : owner ? {host: relayHost, authorization: "Bearer owner-token", ...extra} : { host: relayHost, origin: audience, "x-dohc-relay-exchange-key": exchangeKey, cookie, ...linkHeaders, ...extra }, perMessageDeflate: false });
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
  return { ...state, post, discriminator, mint, connect, currentScope, bearer, profile, memberships, tickets, captureNative, native, changes, invalidated, actor, application, routes, desktopAdmission };
}

it.each(["link", "desktop", "owner"])("shares total connection capacity with the %s route", async kind => {
  const admission = createLiveConnectionAdmission(), routeLimits = {...limits, maxConnections: 1};
  const first = await fixture(routeLimits, false, undefined, false, false, admission);
  const second = await fixture(routeLimits, kind === "link", undefined, kind === "owner", kind === "desktop", admission);
  const firstTicket = await first.mint(), secondTicket = kind === "owner" ? {token: ""} : await second.mint();
  const current = first.connect(firstTicket.token); expect(await current.status).toBe(101);
  expect(await second.connect(secondTicket.token).status).toBe(404);
  const released = once(current.ws, "close"); current.ws.terminate(); await released;
  // The route releases capacity when it sees the socket close.
  await vi.waitFor(() => {
    const release = admission.reserve([["connections", 1]]); expect(release).not.toBeNull(); release?.();
  }, {timeout: 10_000});
  expect(await second.connect(secondTicket.token).status).toBe(101);
});

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
  for (const field of ["maxSyncOutputBytes", "maxAppliedUpdateBytes"]) {
    expect(() => parseNamedLiveConfig({...config, host: {...bounds, [field]: 1}})).toThrow();
    expect(() => parseNamedLiveConfig({...config, host: {...bounds, [field]: 2}})).not.toThrow();
  }
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


it("keeps a link socket through bearer refresh and closes it on revocation", async () => {
  const f = await fixture(limits, true), minted = await f.mint(), browser = f.connect(minted.token);
  expect(await browser.status).toBe(101);
  await browser.until(() => browser.received.some(frame => frame.kind === "welcome"));
  const principal = f.raw.prepare("SELECT principal_id,display_name FROM sync_relay_link_principals").get()!;
  expect(principal.display_name).toBeNull();
  const serialized = JSON.stringify({ frames: browser.received, ticket: f.raw.prepare("SELECT * FROM sync_relay_live_session_tickets").get() });
  for (const secret of [f.bearer, f.profile, hashLinkBearer(f.bearer, key), hashLinkProfileSecret(f.profile, key)]) expect(serialized).not.toContain(secret);
  const old = f.storage.findLinkSessionByCapabilityHash(hashLinkBearer(f.bearer, key))!;
  expect(f.storage.replaceLinkSession({ currentSession: old, session: { sessionId: old.sessionId, capabilityHash: hashLinkBearer("fresh", key),
    grantId: old.grantId, generation: old.generation, mintedAtMs: 1000, expiresAtMs: 70_000 }, guard() {} })).toBe(true);
  f.changes.notify();
  expect(f.storage.findLinkSessionByCapabilityHash(old.capabilityHash)).toBeNull();
  expect((await f.post("/sync/live/link-tickets", {discriminator: f.discriminator, objectId: binding.objectId})).status).toBe(404);
  const pong = once(browser.ws, "pong"); browser.ws.ping("still-connected"); await pong;
  const {provider, until} = await startProvider(browser);
  await until(() => provider.state().status === "live");
  expect(provider.state().binding?.workspaceId).toBe(`link:${scope.grantId}`);
  const closed = once(browser.ws, "close");
  f.storage.revokeShareGrant({shareId: scope.shareId, grantId: scope.grantId, revokedAtMs: 1001});
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


async function startProvider(browser: ReturnType<Awaited<ReturnType<typeof fixture>>["connect"]>) {
  const provider = createNamedLiveProvider({frames, maxPendingUpdateBytes: 4096, maxPendingUpdates: 4, maxDeliveryAttempts: 2});
  const route = provider.connect({send: bytes => new Promise<void>((resolve, reject) => browser.ws.send(bytes, error => error ? reject(error) : resolve())),
    close: () => browser.ws.terminate()});
  const {encodeLiveFrame} = await import("@dohc/live-session-contract/live-frame");
  for (const frame of browser.received) void route.receive(encodeLiveFrame(frame, frames.receive.maxFrameBytes));
  browser.ws.on("message", bytes => {void route.receive(Buffer.from(bytes as Buffer));});
  const until = (check: () => boolean) => check() ? Promise.resolve() : new Promise<void>(resolve => {
    const remove = provider.subscribe(() => {if (check()) {remove(); resolve();}});
  });
  cleanups.push(async () => {provider.close(); await route.settled(); provider.doc.destroy();});
  await until(() => provider.state().membership !== null);
  return {provider, until};
}

async function namedMember(f: Awaited<ReturnType<typeof fixture>>) {
  f.storage.createShare({share: {shareId: "named-other-share", workspaceId: scope.workspaceId, granterUserId: "owner-1",
    selectorJson: JSON.stringify({paths: [binding.currentPath], versionId: null}), createdAtMs: 1},
    grant: {grantId: "named-other-grant", shareId: "named-other-share", principalKind: "user", principalUserId: scope.userId,
      principalEmail: null, access: "edit", generation: 1, status: "active", revokedAtMs: null, createdAtMs: 1, parentGrantId: null}});
  const boot = await f.post("/sync/live/named-sessions", {grantId: "named-other-grant"});
  const {discriminator} = await boot.json() as {discriminator: string};
  const context = await f.application.resolveNamedBrowserSession(new Request("https://relay.example.test", {headers: {cookie: "account=reader"}}), discriminator);
  if (!context) throw new Error("Named member authentication missing");
  const minted = await f.tickets.mint({objectId: binding.objectId}, context), ticket = await f.tickets.redeem(minted!.token, context);
  if (!ticket) throw new Error("Named member ticket missing");
  const host = captureNamedLiveFrameHost({ticket, actor: liveBrowserActor(context), storage: f.storage, native: f.native, bounds,
    validate: createLiveMarkdownJournalValidator(policy)});
  const member = f.memberships.join({ticket, invalidated: host.invalidated, assertCurrent: host.assertCurrent});
  cleanups.push(async () => {member.close(); host.close();});
  return member;
}

it("shares authenticated named and link membership on the same path across grants and selectors", async () => {
  const f = await fixture(limits, true), minted = await f.mint(), browser = f.connect(minted.token);
  expect(await browser.status).toBe(101);
  const live = await startProvider(browser), named = await namedMember(f);
  await live.until(() => live.provider.state().membership?.members.length === 2);
  const first = live.provider.state().membership!;
  expect(named.snapshot(1024)).toEqual(first);
  expect(first.overflow).toBe(false);
  for (const secret of [scope.userId, scope.grantId, f.bearer, f.profile, "link-session"]) expect(JSON.stringify(first)).not.toContain(secret);
  named.close();
  await live.until(() => live.provider.state().membership?.members.length === 1);
});

it.each(["expiry", "blocked", "paused"])("prunes an idle link member after %s when an authenticated named peer reads membership", async change => {
  const f = await fixture(limits, true), minted = await f.mint(), browser = f.connect(minted.token);
  expect(await browser.status).toBe(101);
  const live = await startProvider(browser), named = await namedMember(f);
  await live.until(() => live.provider.state().membership?.members.length === 2);
  const closed = once(browser.ws, "close");
  if (change === "expiry") vi.spyOn(Date, "now").mockReturnValue(61_000);
  if (change === "blocked") f.raw.exec("UPDATE sync_relay_link_principals SET blocked_at_ms=1000");
  if (change === "paused") f.raw.exec("UPDATE sync_relay_shares SET link_writes_paused_at_ms=1000");
  const exec = vi.spyOn((f.storage as StorageContext).db, "exec");
  expect(named.snapshot(1024).members).toHaveLength(1);
  expect(exec.mock.calls.filter(([sql]) => sql === "BEGIN IMMEDIATE")).toHaveLength(0);
  expect(exec.mock.calls.filter(([sql]) => sql === "BEGIN")).toHaveLength(1);
  await closed;
  expect(f.invalidated.signal.aborted).toBe(false);
});

it("closes a host capture when membership is full and leaves its redeemed ticket consumed", async () => {
  const f = await fixture(limits, true, {maxSessions: 1, maxMembers: 1, maxSnapshotBytes: 41});
  const first = await f.mint(), second = await f.mint(), browser = f.connect(first.token);
  expect(await browser.status).toBe(101);
  expect(await f.connect(second.token).status).toBe(404);
  expect(f.raw.prepare("SELECT COUNT(*) AS n FROM sync_relay_live_session_tickets WHERE redeemed_at_ms IS NOT NULL").get()).toEqual({n: 2});
  expect(f.changes.listenerCount()).toBe(1);
  const closed = once(browser.ws, "close"); browser.ws.terminate(); await closed;
  expect(await f.connect(second.token).status).toBe(404);
  expect(f.changes.listenerCount()).toBe(0);
  expect(f.invalidated.signal.aborted).toBe(false);
});


it("opens the owner bearer route without a recipient, browser cookie, ticket, or exchange key", async () => {
  const f = await fixture(limits, false, undefined, true);
  f.raw.exec("DELETE FROM sync_relay_share_grants");
  const client = f.connect("", "", {cookie: "account=reader"});
  expect(await client.status).toBe(101);
  await client.until(() => client.received.some(frame => frame.kind === "welcome"));
  expect(client.received[0]).toMatchObject({kind: "welcome", hostEpoch: host.hostEpoch});
  expect(f.actor.mock.calls[0]![0].headers.get("cookie")).toBeNull();
  expect(f.raw.prepare("SELECT COUNT(*) AS count FROM sync_relay_live_session_tickets").get()).toEqual({count: 0});
});

it.each<Record<string, string>>([{authorization: ""}, {authorization: "Bearer reader-token"}, {origin: "https://foreign.example"}, {host: "foreign.example"}])(
  "refuses unauthenticated, non-owner and foreign owner upgrades %j", async headers => {
    const f = await fixture(limits, false, undefined, true);
    expect(await f.connect("", "", headers).status).toBe(404);
    expect(f.captureNative).not.toHaveBeenCalled();
  });

it("refuses additional identity and duplicate selector fields on owner upgrades", async () => {
  const f = await fixture(limits, false, undefined, true);
  for (const query of ["&userId=owner-1", "&shareId=share-1"]) expect(await f.connect("", "", {}, query).status).toBe(404);
  expect(f.actor).not.toHaveBeenCalled();
});

it.each(["owner", "fence", "selector"])("rechecks owner %s standing after native capture awaits", async changed => {
  const f = await fixture(limits, false, undefined, true);
  f.captureNative.mockImplementationOnce(async () => {
    f.raw.exec(changed === "owner" ? "UPDATE sync_relay_workspaces SET owner_user_id='other'" : changed === "selector" ?
      `UPDATE sync_relay_shares SET selector_json='{"paths":["elsewhere"],"versionId":null}'` :
      "UPDATE sync_relay_live_documents SET restore_fence_generation=restore_fence_generation+1");
    return f.native;
  });
  expect(await f.connect("").status).toBe(404);
});

it("applies owner connection limits and closes captured owners on host invalidation", async () => {
  const f = await fixture({...limits, maxConnectionsPerSession: 1}, false, undefined, true);
  const first = f.connect(""); expect(await first.status).toBe(101);
  expect(await f.connect("").status).toBe(404);
  const closed = once(first.ws, "close"); f.invalidated.abort(); await closed;
});


it("refuses a stale owner lineage before native capture", async () => {
  const f = await fixture(limits, false, undefined, true);
  f.raw.exec("UPDATE sync_relay_live_documents SET lineage_state='retired', admission_state='closed', retired_at_ms=1000");
  expect(await f.connect("").status).toBe(404);
  expect(f.captureNative).not.toHaveBeenCalled();
});


it("refuses a native capture for a different owner document", async () => {
  const f = await fixture(limits, false, undefined, true);
  f.captureNative.mockImplementationOnce(async () => ({...f.native, binding: {...f.native.binding, objectId: "other-object"}}));
  expect(await f.connect("").status).toBe(404);
  expect(f.native.client.openLiveAppliedSync).not.toHaveBeenCalled();
});

it("projects file-only link sync metadata before it reaches the browser provider", async () => {
  const f = await fixture(limits, true);
  f.raw.prepare("UPDATE sync_relay_shares SET selector_json=?").run(JSON.stringify({paths: [binding.currentPath], versionId: null}));
  const minted = await f.tickets.mint({objectId: binding.objectId}, f.currentScope);
  expect(minted).not.toBeNull();
  const browser = f.connect(minted!.token); expect(await browser.status).toBe(101);
  const {provider, until} = await startProvider(browser);
  await until(() => provider.state().status === "live");
  expect(provider.state().binding).toMatchObject({workspaceId: `link:${scope.grantId}`, currentPath: "a.md", selectorPaths: ["a.md"], objectId: binding.objectId});
  expect(JSON.stringify(provider.state().binding)).not.toContain(scope.workspaceId);
  expect(JSON.stringify(provider.state().binding)).not.toContain("docs/");
  expect(f.native.client.openLiveAppliedSync).toHaveBeenCalled();
});
