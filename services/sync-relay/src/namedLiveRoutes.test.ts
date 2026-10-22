import {LIVE_CONNECTION_LIMIT_CLOSE_CODE} from "@dohc/live-session-contract/live-connection";
import {selfHostLiveProfile} from "./selfHostLiveProfile";
import { createNamedDesktopLive } from "./namedDesktopLive";
import { notifyRelayWrite } from "./relayWriteChanges";
import { notifyDesktopReadiness } from "./desktopReadinessChanges";
import {createLiveConnectionAdmission} from "./liveConnectionAdmission";
import { once } from "node:events";
import { request as httpRequest } from "node:http";
import { createHash } from "node:crypto";
import { WebSocket } from "ws";
import { afterEach, expect, it, vi } from "vitest";
import { serveFetchHandler } from "@dohc/service-http";
import { UnauthorizedError } from "@dohc/workspace-auth/session";
import { LIVE_FRAME_DECLARED_SUBMIT_MAX_BYTES, createLiveFrameSession, decodeLiveFrame, encodeLiveFrame, encodeLiveFrameSync, type LiveFrame } from "@dohc/live-session-contract/live-frame";
import { createLiveMarkdownJournalValidator } from "@dohc/ydoc-projection/live-journal-validation";
import { createSyncRelayHandler } from "./server.js";
import { createOwnerLiveRoutes, createNamedLiveRoutes, parseNamedLiveRouteLimits, type NamedLiveRouteLimits } from "./namedLiveRoutes.js";
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
import type { LiveUpdateJournalCut } from "./storage/types.js";
import type { LiveObjectBinding } from "@dohc/live-session-contract/live-object-binding";
import { liveEditors } from "./liveEditors.js";
import { linkRefusalBody } from "@dohc/security-contract/link-refusal";

const exchangeKey = "test-exchange-key-".repeat(3), relayHost = "relay.example.test";
const frames = { receive: { maxFrameBytes: LIVE_FRAME_DECLARED_SUBMIT_MAX_BYTES, maxStateVectorBytes: 1024, maxUpdateBytes: 4096, maxSyncBytes: 4096 },
  maxQueuedBytes: 4096, maxQueuedFrames: 32, maxControlBytes: 4096, maxControlFrames: 8, maxAssemblyBytes: 4096 };
const bounds = { maxClientVectorBytes: 1024, maxSyncOutputBytes: 4096, maxAppliedUpdateBytes: 4096, maxSubmissionBytes: 4096, maxAdmissionBytes: 16384 };
const policy = { maxStructVisits: 10000, maxValueNodeVisits: 10000, maxDecodedPayloadByteVisits: 1000000, maxStructClientGroupVisits: 10000,
  maxDeleteClientGroupVisits: 10000, maxDeleteIntervalVisits: 10000, maxIndexOperations: 100000 };
const limits: NamedLiveRouteLimits = { maxConnections: 8, maxConnectionsPerWorkspace: 96, reservedOwnerConnections: 0, maxConnectionsPerSession: 2, maxConnectionsPerPrincipal: 3, maxConnectionsPerGrant: 4, maxBufferedBytes: 134217728,
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
  const cancel = new AbortController();
  const waiting = f.desktopAdmission!.handle(new Request(`https://${relayHost}/sync/live/desktop-open`, {
    method: "POST", headers: {host: relayHost, authorization: "Bearer reader-token", "content-type": "application/json"},
    body: JSON.stringify(body), signal: cancel.signal,
  }));
  await vi.waitFor(() => expect(mint).toHaveBeenCalledTimes(1));
  cancel.abort();
  expect((await waiting).status).toBe(404);
  mint.mockResolvedValue({token: "ab".repeat(32), expiresAtMs: 61_000});
  expect((await f.post("/sync/live/desktop-open", body)).status).toBe(200);
});

it("waits for host readiness on a subscription without another desktop open", async () => {
  const f = await fixture(limits, false, undefined, false, true);
  const mint = vi.spyOn(f.tickets, "mint").mockResolvedValue(null);
  const waiting = f.post("/sync/live/desktop-open", {shareId: scope.shareId, path: binding.currentPath});
  await vi.waitFor(() => expect(mint).toHaveBeenCalledTimes(1));
  mint.mockResolvedValue({token: "ab".repeat(32), expiresAtMs: 61_000});
  f.changes.notify(binding);
  expect((await waiting).status).toBe(200);
  expect(mint).toHaveBeenCalledTimes(2);
});

it("finishes a desktop open started during reconnect after one host readiness wake", async () => {
  const f = await fixture(limits, false, undefined, false, true);
  f.captureNative.mockRejectedValue(new Error("Host reconnecting."));
  const mint = vi.spyOn(f.tickets, "mint");
  const waiting = f.post("/sync/live/desktop-open", {shareId: scope.shareId, path: binding.currentPath});
  await vi.waitFor(() => expect(mint).toHaveBeenCalledTimes(1));
  f.captureNative.mockResolvedValue(f.native);
  f.changes.notifyHost([binding.workspaceId]);
  const response = await waiting;
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({objectId: binding.objectId, path: binding.currentPath, ticket: {token: expect.any(String)}});
  expect(mint).toHaveBeenCalledTimes(2);
  expect(f.changes.listenerCount()).toBe(0);
});

it("resolves waiting readiness after one host readiness wake", async () => {
  const f = await fixture(limits, false, undefined, false, true);
  f.captureNative.mockRejectedValue(new Error("Host reconnecting."));
  const mint = vi.spyOn(f.tickets, "mint");
  const reader = (await f.desktopAdmission!.handle(readinessRequest())).body!.getReader();
  try {
    expect(new TextDecoder().decode((await reader.read()).value)).toBe("waiting\n");
    await vi.waitFor(() => expect(mint).toHaveBeenCalledTimes(1));
    f.captureNative.mockResolvedValue(f.native);
    f.changes.notifyHost([binding.workspaceId]);
    expect(new TextDecoder().decode((await reader.read()).value)).toBe("ready\n");
    expect((await reader.read()).done).toBe(true);
    expect(mint).toHaveBeenCalledTimes(2);
    expect(f.changes.listenerCount()).toBe(0);
  } finally { await reader.cancel(); }
});

it("keeps readiness past the admission deadline and ignores unrelated document, host, and relay writes", async () => {
  const f = await fixture(limits, false, undefined, false, true);
  const mint = vi.spyOn(f.tickets, "mint").mockResolvedValue(null);
  vi.useFakeTimers();
  try {
    const response = await f.desktopAdmission!.handle(new Request(`https://${relayHost}/sync/live/desktop-ready`, {
      method: "POST", headers: {host: relayHost, authorization: "Bearer reader-token", "content-type": "application/json"},
      body: JSON.stringify({shareId: scope.shareId, path: binding.currentPath}),
    }));
    const reader = response.body!.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toBe("waiting\n");
    await vi.waitFor(() => expect(mint).toHaveBeenCalledTimes(1));
    f.changes.notify({...binding, objectId: "other-object"});
    f.changes.notify({...binding, workspaceId: "other-workspace"});
    f.changes.notifyHost(["other-workspace"]);
    f.changes.notify();
    notifyRelayWrite(f.storage);
    notifyDesktopReadiness(f.storage, {shareId: "other-share"});
    notifyDesktopReadiness(f.storage, {workspaceId: binding.workspaceId, path: "docs/other.md"});
    await vi.advanceTimersByTimeAsync(2000);
    expect(mint).toHaveBeenCalledTimes(1);
    mint.mockResolvedValue({token: "ab".repeat(32), expiresAtMs: 61_000});
    f.changes.notify(binding);
    expect(new TextDecoder().decode((await reader.read()).value)).toBe("ready\n");
    expect((await reader.read()).done).toBe(true);
    expect(mint).toHaveBeenCalledTimes(2);
  } finally { vi.useRealTimers(); }
});

function readinessRequest(user = "reader", path = binding.currentPath) {
  return new Request(`https://${relayHost}/sync/live/desktop-ready`, {
    method: "POST", headers: {host: relayHost, authorization: `Bearer ${user}-token`, "content-type": "application/json"},
    body: JSON.stringify({shareId: scope.shareId, path}),
  });
}

it("keeps desktop admission available with a full readiness pool across users", async () => {
  const f = await fixture(limits, false, undefined, false, true);
  f.raw.prepare(`INSERT INTO sync_relay_share_grants
    (grant_id,share_id,principal_kind,principal_user_id,principal_email,access,generation,status,created_at_ms,revoked_at_ms,parent_grant_id)
    VALUES ('other-edit',?,'user','other-user',NULL,'edit',1,'active',0,NULL,NULL)`).run(scope.shareId);
  const mint = vi.spyOn(f.tickets, "mint").mockResolvedValue(null);
  const readers: ReadableStreamDefaultReader<Uint8Array>[] = [];
  try {
    for (const user of ["reader", "other"]) for (let index = 0; index < 4; index++) {
      const reader = (await f.desktopAdmission!.handle(readinessRequest(user))).body!.getReader();
      readers.push(reader);
      await reader.read();
    }
    await vi.waitFor(() => expect(mint).toHaveBeenCalledTimes(8));
    expect((await f.desktopAdmission!.handle(readinessRequest())).status).toBe(404);
    mint.mockResolvedValue({token: "ab".repeat(32), expiresAtMs: 61_000});
    expect((await f.post("/sync/live/desktop-open", {shareId: scope.shareId, path: binding.currentPath})).status).toBe(200);
  } finally { await Promise.all(readers.map(reader => reader.cancel())); }
});

it("caps readiness per authenticated user and frees that user's slot on cancel", async () => {
  const f = await fixture(limits, false, undefined, false, true);
  const mint = vi.spyOn(f.tickets, "mint").mockResolvedValue(null);
  const readers: ReadableStreamDefaultReader<Uint8Array>[] = [];
  try {
    for (let index = 0; index < 4; index++) {
      const reader = (await f.desktopAdmission!.handle(readinessRequest())).body!.getReader();
      readers.push(reader); await reader.read();
    }
    await vi.waitFor(() => expect(mint).toHaveBeenCalledTimes(4));
    expect(await (await f.desktopAdmission!.handle(readinessRequest())).text()).toBe("waiting\nunavailable\n");
    expect(mint).toHaveBeenCalledTimes(4);
    await readers.shift()!.cancel();
    const replacement = (await f.desktopAdmission!.handle(readinessRequest())).body!.getReader();
    readers.push(replacement); await replacement.read();
    await vi.waitFor(() => expect(mint).toHaveBeenCalledTimes(5));
  } finally { await Promise.all(readers.map(reader => reader.cancel())); }
});

it("ends readiness with unavailable at its deadline and releases its slot", async () => {
  const f = await fixture(limits, false, undefined, false, true);
  const mint = vi.spyOn(f.tickets, "mint").mockResolvedValue(null);
  vi.useFakeTimers();
  try {
    const response = await f.desktopAdmission!.handle(readinessRequest());
    const text = response.text();
    await vi.advanceTimersByTimeAsync(5000);
    expect(await text).toBe("waiting\nunavailable\n");
    expect(f.changes.listenerCount()).toBe(0);
    mint.mockResolvedValue({token: "ab".repeat(32), expiresAtMs: 61_000});
    expect(await (await f.desktopAdmission!.handle(readinessRequest())).text()).toBe("waiting\nready\n");
  } finally { vi.useRealTimers(); }
});

it("wakes only the caller's share when that share's access changes", async () => {
  const f = await fixture(limits, false, undefined, false, true);
  const mint = vi.spyOn(f.tickets, "mint").mockResolvedValue(null);
  const grants = vi.spyOn(f.storage, "listActiveShareGrantsForRecipient");
  const reader = (await f.desktopAdmission!.handle(readinessRequest())).body!.getReader();
  try {
    await reader.read();
    await vi.waitFor(() => expect(mint).toHaveBeenCalledTimes(1));
    f.storage.revokeShare("other-share", 2000);
    await new Promise<void>(queueMicrotask);
    expect(grants).toHaveBeenCalledTimes(1);
    f.storage.revokeShare(scope.shareId, 2000);
    expect(new TextDecoder().decode((await reader.read()).value)).toBe("unavailable\n");
    expect(grants).toHaveBeenCalledTimes(2);
    expect(mint).toHaveBeenCalledTimes(1);
  } finally { await reader.cancel(); }
});

it("rechecks access and releases a waiting readiness subscription on cancellation", async () => {
  const f = await fixture(limits, false, undefined, false, true);
  const mint = vi.spyOn(f.tickets, "mint").mockResolvedValue(null);
  const request = () => new Request(`https://${relayHost}/sync/live/desktop-ready`, {
    method: "POST", headers: {host: relayHost, authorization: "Bearer reader-token", "content-type": "application/json"},
    body: JSON.stringify({shareId: scope.shareId, path: binding.currentPath}),
  });
  const cancelled = (await f.desktopAdmission!.handle(request())).body!.getReader();
  await cancelled.read();
  await vi.waitFor(() => expect(mint).toHaveBeenCalledTimes(1));
  await cancelled.cancel();
  const reader = (await f.desktopAdmission!.handle(request())).body!.getReader();
  await reader.read();
  await vi.waitFor(() => expect(mint).toHaveBeenCalledTimes(2));
  f.raw.prepare("UPDATE sync_relay_share_grants SET access='view'").run();
  f.changes.notify(binding);
  expect(new TextDecoder().decode((await reader.read()).value)).toBe("unavailable\n");
  expect((await reader.read()).done).toBe(true);
  expect(mint).toHaveBeenCalledTimes(2);
});

it("rechecks Edit access when a waiting desktop admission wakes", async () => {
  const f = await fixture(limits, false, undefined, false, true);
  const mint = vi.spyOn(f.tickets, "mint").mockResolvedValue(null);
  const waiting = f.post("/sync/live/desktop-open", {shareId: scope.shareId, path: binding.currentPath});
  await vi.waitFor(() => expect(mint).toHaveBeenCalledTimes(1));
  f.raw.prepare("UPDATE sync_relay_share_grants SET access='view'").run();
  f.changes.notify(binding);
  expect((await waiting).status).toBe(404);
  expect(mint).toHaveBeenCalledTimes(1);
});
afterEach(async () => {
  const owned = cleanups.splice(0).reverse(); vi.restoreAllMocks();
  for (const cleanup of owned) await cleanup();
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve };
}
const defaultScope = scope, defaultBinding = binding, defaultFrames = frames, defaultBounds = bounds;
async function fixture(routeLimits = limits, link = false, membershipPolicy: LiveMembershipPolicy = {maxSessions: 16, maxMembers: 8, maxSnapshotBytes: 153}, owner = false, desktop = false, admission?: ReturnType<typeof createLiveConnectionAdmission>, person = 0, document = 0, production = false, workspaceId = defaultScope.workspaceId, shareId = defaultScope.shareId, population?: {people: number; documents: number}) {
  const liveProfile = selfHostLiveProfile();
  const frames = production ? liveProfile.frames : defaultFrames, bounds = production ? liveProfile.namedLive.host : defaultBounds;
  const scope = {...defaultScope, workspaceId, shareId, userId: person ? "reader-" + person : defaultScope.userId,
    grantId: link && shareId !== defaultScope.shareId ? shareId + "-link" : !link && person ? "edit-" + person : defaultScope.grantId};
  const binding = {...defaultBinding, workspaceId, objectId: document ? "object-" + document : defaultBinding.objectId};
  const state = await ticketFixture(population ? {liveTickets: {...liveProfile.namedLive.tickets, now: () => 1000}} : undefined,
    {userId: scope.userId, grantId: scope.grantId, objectId: binding.objectId, workspaceId, shareId}, population);
  const routeKind = desktop ? "desktop" : link ? "link" : "named";
  const memberships = createLiveMembershipRegistry(membershipPolicy, state.storage.readLiveAuthority.bind(state.storage));
  const bearer = Buffer.alloc(32, 1).toString("base64url"), profile = Buffer.alloc(32, person || 2).toString("base64url");
  const currentScope = link ? { kind: "link" as const, workspaceId: scope.workspaceId, shareId: scope.shareId, grantId: scope.grantId,
    sessionId: "link-session", capabilityHash: hashLinkBearer(bearer, key), profileTokenHash: hashLinkProfileSecret(profile, key) } : scope;
  const linkHeaders: Record<string, string> = link ? { authorization: `Bearer ${bearer}`, "x-dohc-link-profile-secret": profile } : {};
  if (link) {
    vi.spyOn(Date, "now").mockReturnValue(1000);
    state.raw.exec("UPDATE sync_relay_share_grants SET principal_kind='link', principal_user_id=NULL");
    for (let person = 1; person <= (population?.people ?? 1); person++) {
      expect(state.storage.mintLinkSession({ session: { sessionId: population ? "link-session-" + person : "link-session",
        capabilityHash: hashLinkBearer(population ? Buffer.alloc(32, person).toString("base64url") : bearer, key),
        grantId: scope.grantId, generation: 4, mintedAtMs: 999, expiresAtMs: 61_000 } })).toBe(true);
    }
  }
  const changes = createNamedFrameChanges(population ? liveProfile.namedLive.maxListeners : 16), invalidated = new AbortController();
  const native: NamedFrameNativeHost = {
    workspace: "never-send-native-handle", registrationId: 73, binding: { ...binding, selectorPaths: [binding.currentPath] }, coordinate: host,
    invalidated: invalidated.signal, changes, deadlineMs: 1000, nextRequestId: () => 1, drain: vi.fn(async () => undefined),
    client: {
      openLiveAppliedSync: vi.fn(async () => ({ binding: { ...binding, selectorPaths: [binding.currentPath] }, hostVector: Buffer.from([0]), missingStateUpdate: Buffer.from([0, 0]),
        observedLocalYDocHeadSequence: 100, position: { eventCount: 0, journalCursor: 0, evidenceDigest: "ab".repeat(32) } })),
      readNextLiveApplied: vi.fn(async () => null), readLiveApplicationAck: vi.fn(async () => null),
    },
  };
  const captureNative = vi.fn(async (current?: LiveObjectBinding) => population && current ? {...native, binding: {...current, selectorPaths: [current.currentPath]}} : native);
  const sessionHostBlocked = vi.fn((_document: {workspaceId: string; objectId: string}) => false);
  const actor = vi.fn(async (request: Request, workspaceId: string) => {
    if (owner || desktop) {
      const bearer = request.headers.get("authorization");
      if (!bearer) throw new UnauthorizedError();
      return {userId: bearer === "Bearer owner-token" ? "owner-1" : bearer === "Bearer reader-token" ? "reader-1" : "other-user", workspaceId};
    }
    const cookie = request.headers.get("cookie");
    if (!cookie || cookie === "anonymous") throw new UnauthorizedError();
    return { userId: population && /^account=reader-\d+$/.test(cookie) ? cookie.slice("account=".length) : cookie === "account=reader" ? scope.userId : "other-user", workspaceId };
  });
  const application = createSyncRelayHandler({ storage: state.storage, resolveActor: actor, shareWebOrigin: audience, relayExchangeKey: exchangeKey, nowMs: () => 1000,
    namedBrowserSessionLimits: { maxSessions: population ? liveProfile.browserSessions.maxSessions : 8, retentionMs: 30000, maxPendingRequests: 4, maxRequestBytes: 16384, maxResponseBytes: 16384, timeoutMs: 1000 } });
  const tickets = createLiveTickets({ storage: state.storage, audience, key, hostReports: createLiveHostReports({ storage: state.storage, captureNative }) });
  const desktopAdmission = desktop ? createNamedDesktopLive({ storage: state.storage, resolveActor: actor,
    readinessLimits: {maxPendingRequests: 8, maxPendingPerUser: 4, timeoutMs: 5000},
    publicOrigin: audience, hosts: new Set([relayHost]), tickets, changes,
    limits: {maxSessions: 10, retentionMs: 60000, maxPendingRequests: 4, maxRequestBytes: 16384, maxResponseBytes: 16384, timeoutMs: 1000},
    editorLimits: {provider: {frames, maxPendingUpdateBytes: 8192, maxPendingUpdates: 4, maxDeliveryAttempts: 3},
      maxHttpResponseBytes: 4096, maxSocketBufferedBytes: 4096, connectTimeoutMs: 1000, sendTimeoutMs: 1000, drainPollMs: 10} }) : undefined;
  const routes = owner ? createOwnerLiveRoutes({storage: state.storage, resolveActor: actor, hosts: new Set([relayHost]), publicOrigin: audience, exchangeKey,
    frames, bounds, limits: routeLimits, validate: ({retainStateUpdate: _retainStateUpdate, ...input}) => createLiveMarkdownJournalValidator(policy)(input), captureNative, admission}) : createNamedLiveRoutes({ kind: link ? "link" : "named", desktopBearer: desktop, membership: memberships, storage: state.storage, hosts: new Set([relayHost]), publicOrigin: audience, exchangeKey, frames, bounds, limits: routeLimits,
    validate: ({retainStateUpdate: _retainStateUpdate, ...input}) => createLiveMarkdownJournalValidator(policy)(input), sessions: desktopAdmission ?? (link ? createLinkLiveBrowserResolver({publicEditRelease:{version:1},storage: state.storage, linkKey: key}) : { resolve: application.resolveNamedBrowserSession }), tickets, captureNative, admission, sessionHostBlocked });
  const http = serveFetchHandler({ handler: request => new URL(request.url).pathname === "/sync/live/desktop-open" && desktopAdmission ? desktopAdmission.handle(request) : new URL(request.url).pathname === `/sync/live/${routeKind}-tickets` ? routes.handle(request) : application(request),
    maxBodyBytes: () => 16384, oversized: () => Response.json({}, { status: 404 }), failure: () => Response.json({}, { status: 500 }) });
  const upgrades: Promise<void>[] = [], sockets: WebSocket[] = [];
  http.on("upgrade", (request, socket, head) => { upgrades.push(routes.handleUpgrade(request, socket, head)); });
  cleanups.push(async () => { routes.close(); sockets.forEach(ws => ws.terminate()); await Promise.all(upgrades); await new Promise<void>(done => http.close(() => done())); await state.close(); });
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
  const bootstrap = desktop ? await post("/sync/live/desktop-open", {shareId: scope.shareId, path: binding.currentPath}) : population || link || owner ? Response.json({ discriminator: production && document ? "abcdefghijk" + document.toString(36) : "abcdefghijkl" }) : await post("/sync/live/named-sessions", { grantId: scope.grantId });
  expect(bootstrap.status).toBe(200);
  const bootstrapped = await bootstrap.json() as {discriminator: string; ticket?: {token: string; expiresAtMs: number}};
  let discriminator = bootstrapped.discriminator, initialDesktopTicket = bootstrapped.ticket;
  async function mint(): Promise<{token: string; expiresAtMs: number; publicPrincipalId?: string}> {
    if (desktop) {
      if (initialDesktopTicket) { const ticket = initialDesktopTicket; initialDesktopTicket = undefined; return ticket; }
      const response = await post("/sync/live/desktop-open", {shareId: scope.shareId, path: binding.currentPath});
      expect(response.status).toBe(200);
      const admitted = await response.json() as {discriminator: string; ticket: {token: string; expiresAtMs: number}};
      discriminator = admitted.discriminator;
      return admitted.ticket;
    }
    if (!link && !desktop) expect(await application.resolveNamedBrowserSession(new Request("https://relay.example.test", { headers: { cookie: "account=reader" } }), discriminator)).toEqual(scope);
    expect(state.storage.resolveLiveObjectHostBinding(currentScope, binding.objectId)).toMatchObject({ kind: "current", binding });
    const response = await post(`/sync/live/${routeKind}-tickets`, { discriminator, objectId: binding.objectId });
    expect(response.status).toBe(200); return await response.json() as { token: string; expiresAtMs: number; publicPrincipalId?: string };
  }
  function connect(token: string, cookie = "account=reader", extra: Record<string, string> = {}, ownerQuery = "", session = discriminator) {
    const target = owner ? `/sync/workspaces/${binding.workspaceId}/live/owner?shareId=${scope.shareId}&objectId=${binding.objectId}&lineageClaimId=${binding.lineageClaimId}${ownerQuery}` : `/sync/live/${routeKind}?session=${session}`;
    const ws = new WebSocket(`ws://127.0.0.1:${port}${target}`, owner ? ["dohc-live-v1"] : ["dohc-live-v1", `dohc-live-ticket.${token}`], {
      headers: desktop ? {host: relayHost, authorization: "Bearer reader-token", ...extra} : owner ? {host: relayHost, authorization: "Bearer owner-token", ...extra} : { host: relayHost, origin: audience, "x-dohc-relay-exchange-key": exchangeKey, cookie, ...linkHeaders, ...extra }, perMessageDeflate: false });
    sockets.push(ws); ws.on("error", () => undefined);
    const received: LiveFrame[] = [], watchers = new Set<() => void>();
    ws.on("message", bytes => { received.push(decodeLiveFrame(Buffer.from(bytes as Buffer), frames.receive.maxFrameBytes)); for (const notify of watchers) notify(); });
    const status = new Promise<number>(done => {
      ws.once("open", () => done(101)); ws.once("error", () => done(0));
      ws.once("unexpected-response", (_request, response) => { response.resume(); done(response.statusCode!); ws.terminate(); });
    });
    function until(condition: () => boolean, expected = "the expected frame") {
      if (condition()) return Promise.resolve();
      return new Promise<void>((resolve, reject) => {
        const clear = () => { watchers.delete(notify); ws.off("close", close); ws.off("error", error); };
        const notify = () => { if (condition()) { clear(); resolve(); } };
        const close = (code: number, reason: Buffer) => { clear(); reject(new Error(`Live socket closed before ${expected}: ${code} ${reason.toString()}`)); };
        const error = (cause: Error) => { clear(); reject(new Error(`Live socket failed before ${expected}`, {cause})); };
        if (ws.readyState === WebSocket.CLOSED || ws.readyState === WebSocket.CLOSING) { reject(new Error(`Live socket closed before ${expected}`)); return; }
        watchers.add(notify); ws.once("close", close); ws.once("error", error);
      });
    }
    const closed = new Promise<[number, string]>(resolve => ws.once("close", (code, reason) => resolve([code, reason.toString()])));
    return { ws, status, received, until, closed };
  }
  async function peer(person: number, document: number) {
    const grantId = link ? scope.grantId : "edit-" + person, cookie = "account=reader-" + person;
    const profile = Buffer.alloc(32, person).toString("base64url"), bearer = Buffer.alloc(32, person).toString("base64url");
    const headers: Record<string, string> = link ? {authorization: `Bearer ${bearer}`, "x-dohc-link-profile-secret": profile} : {};
    const bootstrap = link ? Response.json({discriminator}) : await post("/sync/live/named-sessions", {grantId}, cookie);
    expect(bootstrap.status).toBe(200);
    const session = (await bootstrap.json() as {discriminator: string}).discriminator;
    return {
      async mint() {
        if (!link) expect(await application.resolveNamedBrowserSession(new Request("https://relay.example.test", {headers: {cookie}}), session))
          .toEqual({...scope, grantId, userId: "reader-" + person});
        const context = currentScope.kind === "link" ? {...currentScope, sessionId: "link-session-" + person,
          capabilityHash: hashLinkBearer(bearer, key), profileTokenHash: hashLinkProfileSecret(profile, key)} : {...scope, grantId, userId: "reader-" + person};
        expect(state.storage.resolveLiveObjectHostBinding(context, "object-" + document)).toMatchObject({kind: "current",
          binding: {...binding, objectId: "object-" + document, currentPath: `docs/${document}.md`}});
        const response = await post(`/sync/live/${routeKind}-tickets`, {discriminator: session, objectId: "object-" + document}, cookie, headers);
        expect(response.status).toBe(200);
        return await response.json() as {token: string};
      },
      connect: (token: string) => connect(token, cookie, headers, "", session),
    };
  }
  return { ...state, frames, binding, post, discriminator, mint, connect, peer, currentScope, bearer, profile, memberships, tickets, captureNative, native, changes, invalidated, actor, application, routes, desktopAdmission, sessionHostBlocked };
}

it.each([false, true])("refuses a ticket for a document the session host blocked until the block lifts; link=%s", async link => {
  const f = await fixture(limits, link);
  const mint = vi.spyOn(f.tickets, "mint");
  f.sessionHostBlocked.mockReturnValue(true);
  const refused = await f.post(`/sync/live/${link ? "link" : "named"}-tickets`, {discriminator: f.discriminator, objectId: binding.objectId});
  expect([refused.status, await refused.json()]).toEqual(link ? [503, linkRefusalBody("link_live_unavailable")] : [404, {ok: false, error: "not found"}]);
  expect(f.sessionHostBlocked).toHaveBeenCalledWith({workspaceId: binding.workspaceId, objectId: binding.objectId});
  expect(mint).not.toHaveBeenCalled();
  if (link) {
    const hidden = await f.post("/sync/live/link-tickets", {discriminator: f.discriminator, objectId: "hidden-object"});
    expect([hidden.status, await hidden.text()]).toEqual([404, '{"ok":false,"error":"not found"}']);
  }
  f.sessionHostBlocked.mockReturnValue(false);
  expect(await f.connect((await f.mint()).token).status).toBe(101);
});

it.each(["view", "comment"] as const)("names %s access only for an in-scope ticket target", async access => {
  const f = await fixture(limits, true);
  f.raw.prepare("UPDATE sync_relay_share_grants SET access=?").run(access);
  const selected = await f.post("/sync/live/link-tickets", {discriminator: f.discriminator, objectId: binding.objectId});
  expect(selected.status).toBe(403);
  expect(await selected.json()).toMatchObject({code: access === "view" ? "link_view_access" : "link_comment_access"});
  const hidden = await f.post("/sync/live/link-tickets", {discriminator: f.discriminator, objectId: "hidden-object"});
  expect([hidden.status, await hidden.text()]).toEqual([404, '{"ok":false,"error":"not found"}']);
});

it.each(["link", "desktop", "owner"])("shares total connection capacity with the %s route", async kind => {
  const admission = createLiveConnectionAdmission(), routeLimits = {...limits, maxConnections: 1};
  const first = await fixture(routeLimits, false, undefined, false, false, admission);
  const second = await fixture(routeLimits, kind === "link", undefined, kind === "owner", kind === "desktop", admission);
  const firstTicket = await first.mint(), secondTicket = kind === "owner" ? {token: ""} : await second.mint();
  const current = first.connect(firstTicket.token); expect(await current.status).toBe(101);
  const refused = second.connect(secondTicket.token);
  expect(await refused.status).toBe(101);
  expect(await refused.closed).toEqual([LIVE_CONNECTION_LIMIT_CLOSE_CODE, "live_total_limit"]);
  const released = once(current.ws, "close"); current.ws.terminate(); await released;
  // The route releases capacity when it sees the socket close.
  await vi.waitFor(() => {
    const release = admission.reserve([["connections", 1]]); expect(release).not.toBeNull(); release?.();
  }, {timeout: 10_000});
  expect(await second.connect(kind === "owner" ? "" : (await second.mint()).token).status).toBe(101);
});

it.each([false, true])("mints through actual HTTP auth and redeems once before exposing only live frames; link=%s", async link => {
  const f = await fixture(limits, link), minted = await f.mint();
  expect(Object.keys(minted).sort()).toEqual(link ? ["expiresAtMs", "publicPrincipalId", "token"] : ["expiresAtMs", "token"]);
  if (link) {
    const publicId = minted.publicPrincipalId;
    expect(publicId).toMatch(/^public_/);
    expect(f.raw.prepare("SELECT public_principal_id FROM sync_relay_app_public_principals").get()).toEqual({public_principal_id: publicId});
    expect((await f.mint()) as Record<string, unknown>).toMatchObject({publicPrincipalId: publicId});
  }
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
  const desktopLimits = {maxPendingAdmissionRequests: 4, maxPendingReadinessRequests: 13};
  expect(() => parseNamedLiveConfig(config, desktopLimits)).toThrow(/desktop admission and readiness/);
  expect(() => parseNamedLiveConfig({...config, maxListeners: 17}, desktopLimits)).not.toThrow();
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
    validate: ({retainStateUpdate: _retainStateUpdate, ...input}) => createLiveMarkdownJournalValidator(policy)(input)});
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

it.each([
  { ...frames, receive: { ...frames.receive, maxFrameBytes: LIVE_FRAME_DECLARED_SUBMIT_MAX_BYTES - 1 } },
  { ...frames, maxControlBytes: LIVE_FRAME_DECLARED_SUBMIT_MAX_BYTES - 1 },
])("refuses an owner route whose frame or control budget cannot carry the largest declared submission", ownerFrames => {
  type OwnerRoute = Parameters<typeof createOwnerLiveRoutes>[0];
  expect(() => createOwnerLiveRoutes({ storage: {} as OwnerRoute["storage"], resolveActor: async () => { throw new UnauthorizedError(); },
    captureNative: async () => { throw new Error("No host opens in this test."); },
    hosts: new Set([relayHost]), publicOrigin: audience, exchangeKey, frames: ownerFrames,
    bounds, limits, validate: createLiveMarkdownJournalValidator(policy) })).toThrow("The owner route must receive the largest declared submission.");
});

it("accepts an owner route at the largest declared submission's frame and control minimum", () => {
  type OwnerRoute = Parameters<typeof createOwnerLiveRoutes>[0];
  const route = createOwnerLiveRoutes({ storage: {} as OwnerRoute["storage"], resolveActor: async () => { throw new UnauthorizedError(); },
    captureNative: async () => { throw new Error("No host opens in this test."); },
    hosts: new Set([relayHost]), publicOrigin: audience, exchangeKey,
    frames: { ...frames, receive: { ...frames.receive, maxFrameBytes: LIVE_FRAME_DECLARED_SUBMIT_MAX_BYTES }, maxControlBytes: LIVE_FRAME_DECLARED_SUBMIT_MAX_BYTES },
    bounds, limits, validate: createLiveMarkdownJournalValidator(policy) });
  route.close();
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
  const refused = f.connect(""); expect(await refused.status).toBe(101);
  expect(await refused.closed).toEqual([LIVE_CONNECTION_LIMIT_CLOSE_CODE, "live_session_limit"]);
  const closed = once(first.ws, "close"); f.invalidated.abort(); await closed;
});

it.each(["named", "link", "desktop", "owner"] as const)("counts a %s connection as an editor from before native capture until it closes", async kind => {
  const f = await fixture(limits, kind === "link", undefined, kind === "owner", kind === "desktop");
  const editors = liveEditors(f.storage), document = {workspaceId: binding.workspaceId, objectId: binding.objectId}, counted: boolean[] = [];
  f.captureNative.mockImplementation(async () => {counted.push(editors.connected(document)); return f.native;});
  const ticket = kind === "owner" ? {token: ""} : await f.mint();
  const client = f.connect(ticket.token); expect(await client.status).toBe(101);
  expect(counted.at(-1)).toBe(true); expect(editors.connected(document)).toBe(true);
  const closed = once(client.ws, "close"); client.ws.terminate(); await closed;
  await vi.waitFor(() => expect(editors.connected(document)).toBe(false));
});

it("stops counting an editor whose native capture fails", async () => {
  const f = await fixture(), minted = await f.mint(), editors = liveEditors(f.storage);
  const document = {workspaceId: binding.workspaceId, objectId: binding.objectId};
  // Ticket redemption captures too, before the route counts the connection; only the route's capture fails.
  let counted = false;
  f.captureNative.mockImplementation(async () => {
    if (!editors.connected(document)) return f.native;
    counted = true; throw new Error("Host reconnecting.");
  });
  expect(await f.connect(minted.token).status).toBe(404);
  expect(counted).toBe(true);
  await vi.waitFor(() => expect(editors.connected(document)).toBe(false));
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

it.each(["named", "link", "owner", "desktop"])("deletion closes a running %s live connection", async kind => {
  const f = await fixture(limits, kind === "link", undefined, kind === "owner", kind === "desktop");
  const minted = kind === "owner" ? {token: ""} : await f.mint();
  const connection = f.connect(minted.token);
  expect(await connection.status).toBe(101);
  const closed = once(connection.ws, "close");
  f.routes.deleteAccount("owner-1", [binding.workspaceId]);
  await closed;
  expect(connection.ws.readyState).toBe(WebSocket.CLOSED);
});

it("keeps an unrelated desktop connection that is still resolving its account",async()=>{
  const f=await fixture(limits,false,undefined,false,true),ticket=await f.mint();
  const entered=deferred<void>(),resume=deferred<void>(),resolve=f.actor.getMockImplementation()!;
  f.actor.mockImplementation(async(...args)=>{entered.resolve();await resume.promise;return resolve(...args);});
  const socket=f.connect(ticket.token);await entered.promise;
  f.routes.deleteAccount("unrelated",["unrelated-workspace"]);resume.resolve();
  expect(await socket.status).toBe(101);
});

it.each([false, true])("connects 20 people with three documents each under the promoted profile; link=%s", async link => {
  const admission = createLiveConnectionAdmission(), profile = selfHostLiveProfile(), sockets: WebSocket[] = [];
  const f = await fixture({...profile.namedLive.transport, idleTimeoutMs: 60_000}, link,
    {maxSessions: 128, maxMembers: 128, maxSnapshotBytes: 4096}, false, false, admission, 0, 0, false, scope.workspaceId, scope.shareId,
    {people: 20, documents: 3});
  for (let person = 1; person <= 20; person++) for (let document = 1; document <= 3; document++) {
    const peer = await f.peer(person, document), socket = peer.connect((await peer.mint()).token);
    expect(await socket.status).toBe(101);
    await socket.until(() => socket.received.some(frame => frame.kind === "welcome"), "welcome");
    sockets.push(socket.ws);
  }
  expect(sockets).toHaveLength(60);
  expect(sockets.every(socket => socket.readyState === WebSocket.OPEN)).toBe(true);
}, 60_000);

it.each([
  ["maxConnections", "live_total_limit"], ["maxConnectionsPerWorkspace", "live_workspace_limit"], ["maxConnectionsPerGrant", "live_grant_limit"],
  ["maxConnectionsPerPrincipal", "live_person_limit"], ["maxConnectionsPerSession", "live_session_limit"],
] as const)("names %s only after authenticating and redeeming an in-scope ticket", async (limit, code) => {
  const f = await fixture({...limits, [limit]: 1});
  const first = f.connect((await f.mint()).token); expect(await first.status).toBe(101);
  const ticket = await f.mint();
  expect(await f.connect(ticket.token, "account=other").status).toBe(404);
  const refused = f.connect(ticket.token); expect(await refused.status).toBe(101);
  expect(await refused.closed).toEqual([LIVE_CONNECTION_LIMIT_CLOSE_CODE, code]);
  expect(f.captureNative).toHaveBeenCalledTimes(5);
});

it("refuses aggregate frame pressure and releases it on close", async () => {
  const admission = createLiveConnectionAdmission();
  const f = await fixture({...limits, maxBufferedBytes: 10_000}, false, undefined, false, false, admission);
  const socket = f.connect((await f.mint()).token); expect(await socket.status).toBe(101);
  await socket.until(() => socket.received.some(frame => frame.kind === "credit"));
  const buffers = admission.buffers(10_000), release = buffers.reserve(9_990);
  const protocol = createLiveFrameSession("client", frames);
  for (const frame of socket.received) protocol.receive((await import("@dohc/live-session-contract/live-frame")).encodeLiveFrame(frame, frames.receive.maxFrameBytes)).release();
  const hello = protocol.send({kind: "hello", receivePolicy: frames.receive});
  socket.ws.send(hello.value); hello.release();
  expect(await socket.closed).toEqual([LIVE_CONNECTION_LIMIT_CLOSE_CODE, "live_buffer_limit"]);
  release(); await vi.waitFor(() => expect(buffers.usage()).toBe(0)); protocol.close();
});

it("charges WebSocket sends until their callback settles", async () => {
  const admission = createLiveConnectionAdmission(), f = await fixture(limits, false, undefined, false, false, admission);
  const ticket = await f.mint(), sent = deferred<void>();
  let callback: (() => void) | undefined, heldBytes = 0;
  const original = WebSocket.prototype.send;
  vi.spyOn(WebSocket.prototype, "send").mockImplementation(function(this: WebSocket, ...args: Parameters<WebSocket["send"]>) {
    if (this.url === undefined) {
      const bytes = args[0];
      if (bytes instanceof Uint8Array) heldBytes = bytes.byteLength;
      const completed = args.at(-1);
      callback = () => {if (typeof completed === "function") completed();};
      sent.resolve(); return;
    }
    original.apply(this, args);
  });
  const socket = f.connect(ticket.token); expect(await socket.status).toBe(101); await sent.promise;
  const buffers = admission.buffers(limits.maxBufferedBytes);
  try {
    expect(buffers.usage()).toBe(2 * heldBytes);
    socket.ws.terminate(); await socket.closed;
    expect(buffers.usage()).toBe(2 * heldBytes);
  } finally { f.routes.close(); callback?.(); }
  await vi.waitFor(() => expect(buffers.usage()).toBe(0));
});

it("charges control pong bytes until completion", async () => {
  const admission = createLiveConnectionAdmission(), f = await fixture(limits, false, undefined, false, false, admission);
  const socket = f.connect((await f.mint()).token); expect(await socket.status).toBe(101);
  await socket.until(() => socket.received.some(frame => frame.kind === "credit"));
  const entered = deferred<void>(); let complete: (() => void) | undefined;
  const original = WebSocket.prototype.pong;
  vi.spyOn(WebSocket.prototype, "pong").mockImplementation(function(this: WebSocket, ...args: Parameters<WebSocket["pong"]>) {
    if (this.url === undefined) {
      const callback = args.at(-1); complete = () => {if (typeof callback === "function") callback();};
      entered.resolve(); return;
    }
    original.apply(this, args);
  });
  const buffers = admission.buffers(limits.maxBufferedBytes);
  socket.ws.ping("probe"); await entered.promise;
  try { expect(buffers.usage()).toBe(5); }
  finally { f.routes.close(); complete?.(); }
  await vi.waitFor(() => expect(buffers.usage()).toBe(0));
});

it("bounds authenticated total-limit refusal slots and releases them on close", async () => {
  const admission = createLiveConnectionAdmission();
  const f = await fixture({...limits, maxConnections: 1, maxPendingRequests: 1}, false, undefined, false, false, admission);
  const ticket = await f.mint();
  const releaseTotal = admission.reserve([["connections", 1]])!;
  const releaseRefusal = admission.reserve([["upgrade-refusals", 1]])!;
  f.actor.mockClear();
  expect(await f.connect(ticket.token).status).toBe(404);
  expect(f.actor).not.toHaveBeenCalled();
  releaseRefusal();
  const refused = f.connect(ticket.token);
  expect(await refused.status).toBe(101);
  expect(await refused.closed).toEqual([LIVE_CONNECTION_LIMIT_CLOSE_CODE, "live_total_limit"]);
  await vi.waitFor(() => {
    const release = admission.reserve([["upgrade-refusals", 1]]);
    expect(release).not.toBeNull(); release?.();
  });
  releaseTotal();
});

type ProductionPeer = {f: Awaited<ReturnType<typeof fixture>>; socket: ReturnType<Awaited<ReturnType<typeof fixture>>["connect"]>};

async function openProductionSync(f: Awaited<ReturnType<typeof fixture>>, socket: ReturnType<Awaited<ReturnType<typeof fixture>>["connect"]>, credit = true) {
  await vi.waitFor(() => {
    expect(socket.ws.readyState).toBe(WebSocket.OPEN);
    expect(socket.received.map(frame => frame.kind)).toContain("credit");
  }, {timeout: 5000});
  const send = (frame: LiveFrame) => socket.ws.send(encodeLiveFrame(frame, f.frames.receive.maxFrameBytes));
  send({kind: "hello", receivePolicy: f.frames.receive});
  if (credit) send({kind: "credit", grantedBytes: f.frames.maxQueuedBytes, grantedFrames: f.frames.maxQueuedFrames});
  const vector = Uint8Array.of(0);
  send({kind: "begin", purpose: "client-vector", transferId: 1, totalBytes: vector.length,
    digest: createHash("sha256").update(vector).digest("hex")});
  send({kind: "chunk", transferId: 1, offset: 0, bytes: vector});
  if (credit) await vi.waitFor(() => {
    expect(socket.ws.readyState).toBe(WebSocket.OPEN);
    expect(socket.received.map(frame => frame.kind)).toContain("chunk");
  }, {timeout: 5000});
  if (credit) send({kind: "sync-applied", appliedThroughJournalCursor: 0});
}

it.each([false, true])("delivers one production-size 2 MiB edit to 22 readers of one document; link=%s", async link => {
  const profile = selfHostLiveProfile(), admission = createLiveConnectionAdmission();
  const readers: ProductionPeer[] = [];
  const sharedChanges = createNamedFrameChanges(128);
  let shared: NamedFrameNativeHost | undefined;
  for (let person = 1; person <= 22; person++) {
    const f = await fixture(profile.namedLive.transport, link, undefined, false, false, admission, person, 1, true);
    if (!shared) shared = {...f.native, changes: sharedChanges};
    const native = shared;
    f.captureNative.mockImplementation(async () => native);
    const socket = f.connect((await f.mint()).token);
    expect(await socket.status).toBe(101);
    await openProductionSync(f, socket);
    readers.push({f, socket});
  }
  const updateBytes = Buffer.alloc(profile.namedLive.host.maxAppliedUpdateBytes, 42);
  vi.mocked(shared!.client.readNextLiveApplied).mockImplementation(async (_request, after) => after.eventCount ? null : {
    position: {eventCount: 1, journalCursor: 1, evidenceDigest: "cd".repeat(32)}, updateBytes,
    ack: {deliveryId: "edit", updateDigest: createHash("sha256").update(updateBytes).digest("hex"), journalCursor: 1,
      acceptingHostEpoch: host.hostEpoch, localYDocSequence: 1, applicationReplayed: false},
  });
  await vi.waitFor(() => expect(sharedChanges.listenerCount()).toBe(44));
  sharedChanges.notify(readers[0]!.f.binding);
  await vi.waitFor(() => {
    expect(readers.map(({socket}) => socket.ws.readyState)).toEqual(Array(22).fill(WebSocket.OPEN));
    expect(readers.map(({socket}) => socket.received.filter(frame => frame.kind === "chunk" && frame.transferId === 2)
      .reduce((sum, frame) => sum + (frame.kind === "chunk" ? frame.bytes.length : 0), 0))).toEqual(Array(22).fill(updateBytes.length));
  }, {timeout: 10_000});
  for (const {socket} of readers) {
    const chunks = socket.received.filter((frame): frame is Extract<LiveFrame, {kind: "chunk"}> => frame.kind === "chunk" && frame.transferId === 2);
    expect(Buffer.concat(chunks.map(frame => Buffer.from(frame.bytes))).equals(updateBytes)).toBe(true);
  }
  expect(readers.every(({socket}) => socket.ws.readyState === WebSocket.OPEN)).toBe(true);
  await vi.waitFor(() => expect(admission.buffers(profile.namedLive.transport.maxBufferedBytes).usage()).toBe(0));
}, 60_000);

it("admits a burst of 22 small-document syncs with production bounds", async () => {
  const profile = selfHostLiveProfile(), admission = createLiveConnectionAdmission();
  const peers: ProductionPeer[] = [];
  for (let person = 1; person <= 22; person++) {
    const f = await fixture(profile.namedLive.transport, false, undefined, false, false, admission, person, person, true);
    const socket = f.connect((await f.mint()).token); expect(await socket.status).toBe(101);
    peers.push({f, socket});
  }
  await Promise.all(peers.map(({f, socket}) => openProductionSync(f, socket, false)));
  await vi.waitFor(() => expect(peers.every(({f}) => vi.mocked(f.native.client.openLiveAppliedSync).mock.calls.length >= 1)).toBe(true));
  const usage = admission.buffers(profile.namedLive.transport.maxBufferedBytes).usage();
  expect(usage).toBeGreaterThan(22 * 2); expect(usage).toBeLessThan(32 * 1024);
  expect(peers.every(({socket}) => socket.ws.readyState === WebSocket.OPEN)).toBe(true);
  for (const {f, socket} of peers) socket.ws.send(encodeLiveFrame({kind: "credit", grantedBytes: f.frames.maxQueuedBytes,
    grantedFrames: f.frames.maxQueuedFrames}, f.frames.receive.maxFrameBytes));
  await Promise.all(peers.map(({socket}) => socket.until(() => socket.received.some(frame => frame.kind === "chunk"))));
}, 60_000);

it.each([false, true])("contains 11 stalled syncs from one principal while other workspaces and the owner remain live; link=%s", async link => {
  const profile = selfHostLiveProfile(), admission = createLiveConnectionAdmission(), stalled = [];
  const others = [];
  for (const owner of [false, true]) {
    const f = await fixture(profile.namedLive.transport, false, undefined, owner, false, admission, 23, 1, true, "other-workspace");
    const socket = f.connect(owner ? "" : (await f.mint()).token); expect(await socket.status).toBe(101);
    await openProductionSync(f, socket); others.push(socket);
  }
  for (let index = 0; index < 11; index++) {
    const f = await fixture(profile.namedLive.transport, link, undefined, false, false, admission, 1, index + 1, true);
    const socket = f.connect((await f.mint()).token); expect(await socket.status).toBe(101);
    stalled.push({f, socket});
  }
  for (const {f} of stalled) vi.mocked(f.native.client.openLiveAppliedSync).mockResolvedValue({binding: {...f.binding, selectorPaths: [f.binding.currentPath]},
    hostVector: Buffer.from([0]), missingStateUpdate: Buffer.alloc(4 * 1024 * 1024 - 1024),
    observedLocalYDocHeadSequence: 1, position: {eventCount: 0, journalCursor: 0, evidenceDigest: "ab".repeat(32)}});
  for (let index = 0; index < stalled.length; index++) {
    const {f, socket} = stalled[index]!;
    await openProductionSync(f, socket, false);
    if (index < 3) await vi.waitFor(() => expect(admission.buffers(profile.namedLive.transport.maxBufferedBytes).usage()).toBeGreaterThan(index * 4 * 1024 * 1024 + 3 * 1024 * 1024));
    else expect(await socket.closed).toEqual([LIVE_CONNECTION_LIMIT_CLOSE_CODE, "live_buffer_limit"]);
  }
  for (const socket of others) {
    const pong = once(socket.ws, "pong"); socket.ws.ping("still-live"); await pong;
  }
  expect(admission.buffers(profile.namedLive.transport.maxBufferedBytes).usage()).toBeLessThanOrEqual(12 * 1024 * 1024);
  expect(stalled.slice(0, 3).every(({socket}) => socket.ws.readyState === WebSocket.OPEN)).toBe(true);
  expect(others.every(socket => socket.ws.readyState === WebSocket.OPEN)).toBe(true);
}, 60_000);

it("keeps production workspace and server owner slots after non-owner capacity fills", async () => {
  const profile = selfHostLiveProfile(), admission = createLiveConnectionAdmission(), maximum = profile.namedLive.transport;
  const release = admission.reserve([[JSON.stringify(["non-owner-workspace", scope.workspaceId]), maximum.maxConnectionsPerWorkspace - maximum.reservedOwnerConnections]])!;
  const fill = Array.from({length: 79}, () => admission.reserve([[JSON.stringify(["non-owner-workspace", scope.workspaceId]), 80]])!);
  const named = await fixture(maximum, false, undefined, false, false, admission, 1, 1, true);
  const refused = named.connect((await named.mint()).token); expect(await refused.status).toBe(101);
  await vi.waitFor(() => expect(refused.ws.readyState).toBe(WebSocket.CLOSED), {timeout: 2000});
  expect(await refused.closed).toEqual([LIVE_CONNECTION_LIMIT_CLOSE_CODE, "live_workspace_limit"]);
  const owner = await fixture(maximum, false, undefined, true, false, admission, 1, 1, true);
  const own = owner.connect(""); expect(await own.status).toBe(101); await openProductionSync(owner, own);
  release(); fill.forEach(release => release());
  const fullWorkspace = Array.from({length: maximum.maxConnectionsPerWorkspace - 1}, () => admission.reserve([[JSON.stringify(["workspace", scope.workspaceId]), maximum.maxConnectionsPerWorkspace]])!);
  const full = owner.connect(""); expect(await full.status).toBe(101);
  await vi.waitFor(() => expect(full.ws.readyState).toBe(WebSocket.CLOSED), {timeout: 2000});
  expect(await full.closed).toEqual([LIVE_CONNECTION_LIMIT_CLOSE_CODE, "live_workspace_limit"]);
  fullWorkspace.forEach(release => release());
  const nonOwners = Array.from({length: maximum.maxConnections - maximum.reservedOwnerConnections}, () => admission.reserve([["non-owner", maximum.maxConnections - maximum.reservedOwnerConnections]])!);
  const serverRefusal = named.connect((await named.mint()).token); expect(await serverRefusal.status).toBe(101);
  await vi.waitFor(() => expect(serverRefusal.ws.readyState).toBe(WebSocket.CLOSED), {timeout: 2000});
  expect(await serverRefusal.closed).toEqual([LIVE_CONNECTION_LIMIT_CLOSE_CODE, "live_total_limit"]);
  const secondOwner = owner.connect(""); expect(await secondOwner.status).toBe(101); await openProductionSync(owner, secondOwner);
  nonOwners.forEach(release => release());
  expect(own.ws.readyState).toBe(WebSocket.OPEN); expect(secondOwner.ws.readyState).toBe(WebSocket.OPEN);
}, 60_000);

it.each(["principal", "share"])("enforces the production relay %s byte portion after authorization", async mode => {
  const profile = selfHostLiveProfile(), admission = createLiveConnectionAdmission(), limits = profile.namedLive.transport;
  const budget = admission.buffers(limits.maxBufferedBytes);
  const f = await fixture(limits, false, undefined, false, false, admission, 1, 1, true);
  const key = JSON.stringify(mode === "principal" ? ["principal", "named", "reader-1"] : ["share", scope.workspaceId, scope.shareId]);
  const size = limits.maxBufferedBytes * (mode === "principal" ? limits.maxConnectionsPerPrincipal : limits.maxConnectionsPerGrant) / limits.maxConnections;
  const release = budget.reserve(size, [[key, size]]);
  try {
    const refused = f.connect((await f.mint()).token); expect(await refused.status).toBe(101);
    await vi.waitFor(() => expect(refused.ws.readyState).toBe(WebSocket.CLOSED), {timeout: 2000});
    expect(await refused.closed).toEqual([LIVE_CONNECTION_LIMIT_CLOSE_CODE, "live_buffer_limit"]);
    const owner = await fixture(limits, false, undefined, true, false, admission, 1, 1, true);
    const own = owner.connect(""); expect(await own.status).toBe(101); await openProductionSync(owner, own);
    expect(own.ws.readyState).toBe(WebSocket.OPEN);
  } finally {release();}
});

it("rejects an owner reserve that exhausts total or workspace capacity", () => {
  const profile = selfHostLiveProfile().namedLive.transport;
  for (const reservedOwnerConnections of [profile.maxConnections, profile.maxConnectionsPerWorkspace])
    expect(() => parseNamedLiveRouteLimits({...profile, reservedOwnerConnections})).toThrow("Invalid named route limits");
  expect(parseNamedLiveRouteLimits({...profile, reservedOwnerConnections: 0}).reservedOwnerConnections).toBe(0);
});

function submitUpdate(f: Awaited<ReturnType<typeof fixture>>, socket: ReturnType<Awaited<ReturnType<typeof fixture>>["connect"]>, deliveryId: string, transferId: number) {
  const updateBytes = Uint8Array.of(0, 0);
  socket.ws.send(encodeLiveFrame({kind: "begin", purpose: "submit-update", deliveryId, transferId, totalBytes: updateBytes.length,
    digest: createHash("sha256").update(updateBytes).digest("hex")}, f.frames.receive.maxFrameBytes));
  socket.ws.send(encodeLiveFrame({kind: "chunk", transferId, offset: 0, bytes: updateBytes}, f.frames.receive.maxFrameBytes));
}

it.each(["named", "owner", "link"])("keeps %s validation work out of frame buffers and retries an occupied person slot", async kind => {
  const profile = selfHostLiveProfile(), admission = createLiveConnectionAdmission(), limits = profile.namedLive.transport;
  const f = await fixture(limits, kind === "link", undefined, kind === "owner", false, admission, 1, 1, true);
  const socket = f.connect(kind === "owner" ? "" : (await f.mint()).token); expect(await socket.status).toBe(101);
  await openProductionSync(f, socket);
  const principal = JSON.stringify(kind === "link" ? ["principal", "link", scope.workspaceId, scope.grantId,
    hashLinkProfileSecret(f.profile, key)] : ["principal", "named", kind === "owner" ? "owner-1" : "reader-1"]);
  const release = admission.reserve([[JSON.stringify(["validation", principal]), 1]])!;
  const frameBudget = admission.buffers(limits.maxBufferedBytes), budget = admission.validationBuffers(limits.maxBufferedBytes);
  const read = vi.spyOn(f.storage, "readLiveUpdateJournalCut").mockImplementation((_input, reserve) => {
    expect(reserve).toBeDefined(); reserve!(20 * 1024 * 1024);
    expect(budget.usage()).toBeGreaterThan(20 * 1024 * 1024);
    expect(frameBudget.usage()).toBeLessThan(1024 * 1024);
    return {kind: "refused", reason: "baseline-missing"};
  });
  const submit = (deliveryId: string, transferId: number) => submitUpdate(f, socket, deliveryId, transferId);
  try {
    submit("occupied", 2);
    await vi.waitFor(() => expect(socket.received).toContainEqual(expect.objectContaining({kind: "result", result: "retry", reason: "admission-unavailable"})));
    expect(read).not.toHaveBeenCalled(); expect(socket.ws.readyState).toBe(WebSocket.OPEN);
  } finally {release();}
  submit("available", 3);
  await vi.waitFor(() => expect(socket.received).toContainEqual(expect.objectContaining({kind: "result", deliveryId: "available", reason: "baseline-missing"})));
  expect(read).toHaveBeenCalledOnce();
  await vi.waitFor(() => expect(budget.usage()).toBe(0));
});

it("keeps another workspace's 4 MiB sync open while a nearly full workspace checks a large edit", async () => {
  const profile = selfHostLiveProfile(), limits = profile.namedLive.transport, admission = createLiveConnectionAdmission(), MiB = 1024 * 1024;
  const frameBudget = admission.buffers(limits.maxBufferedBytes), validationBudget = admission.validationBuffers(limits.maxBufferedBytes);
  const editor = await fixture(limits, true, undefined, false, false, admission, 1, 1, true);
  const editing = editor.connect((await editor.mint()).token); expect(await editing.status).toBe(101);
  await openProductionSync(editor, editing);
  const releaseFrames = frameBudget.reserve(76 * MiB, [[JSON.stringify(["workspace", scope.workspaceId]), 80 * MiB]]);
  const checking = deferred<void>(), drained = deferred<void>(), updateBytes = Uint8Array.of(0, 0);
  vi.spyOn(editor.storage, "readLiveUpdateJournalCut").mockImplementation((_input, reserve) => {
    reserve!(50 * MiB);
    return {kind: "cut", cut: {checkpoint: {bytes: Uint8Array.of(0, 0)}, suffix: []} as unknown as LiveUpdateJournalCut};
  });
  vi.spyOn(editor.storage, "commitLiveUpdateJournal").mockReturnValue({result: {kind: "accepted", receipt: {deliveryId: "large-edit",
    updateDigest: createHash("sha256").update(updateBytes).digest("hex"), journalCursor: 1, acceptingHostEpoch: host.hostEpoch}}} as never);
  vi.mocked(editor.native.drain).mockImplementation(async () => { checking.resolve(); await drained.promise; });
  try {
    submitUpdate(editor, editing, "large-edit", 2);
    await checking.promise;
    expect(frameBudget.usage() + validationBudget.usage()).toBeGreaterThanOrEqual(126 * MiB);
    const other = await fixture(limits, true, undefined, false, false, admission, 2, 1, true, "other-workspace");
    vi.mocked(other.native.client.openLiveAppliedSync).mockResolvedValue({binding: {...other.binding, selectorPaths: [other.binding.currentPath]},
      hostVector: Buffer.from([0]), missingStateUpdate: Buffer.alloc(4 * MiB - 1024), observedLocalYDocHeadSequence: 1,
      position: {eventCount: 0, journalCursor: 0, evidenceDigest: "ab".repeat(32)}});
    const reader = other.connect((await other.mint()).token); expect(await reader.status).toBe(101);
    const before = frameBudget.usage();
    await openProductionSync(other, reader, false);
    await vi.waitFor(() => expect(reader.ws.readyState === WebSocket.CLOSED || frameBudget.usage() > before + 4 * MiB - 2048).toBe(true));
    expect(reader.ws.readyState).toBe(WebSocket.OPEN);
    const pong = once(reader.ws, "pong"); reader.ws.ping("still-live"); await pong;
    expect(reader.ws.readyState).toBe(WebSocket.OPEN); expect(editing.ws.readyState).toBe(WebSocket.OPEN);
    expect(validationBudget.usage()).toBeGreaterThanOrEqual(50 * MiB);
  } finally {drained.resolve(); releaseFrames();}
  await vi.waitFor(() => expect(editing.received).toContainEqual(expect.objectContaining({kind: "result", deliveryId: "large-edit", result: "retry", reason: "application-pending"})));
  await vi.waitFor(() => expect(validationBudget.usage()).toBe(0));
}, 60_000);

it.each(["named", "owner", "link"])("finally refuses a %s edit whose check can never fit the validation pool", async kind => {
  const profile = selfHostLiveProfile(), admission = createLiveConnectionAdmission(), limits = profile.namedLive.transport;
  const f = await fixture(limits, kind === "link", undefined, kind === "owner", false, admission, 1, 1, true);
  const socket = f.connect(kind === "owner" ? "" : (await f.mint()).token); expect(await socket.status).toBe(101);
  await openProductionSync(f, socket);
  const read = vi.spyOn(f.storage, "readLiveUpdateJournalCut").mockImplementation((_input, reserve) => {
    reserve!(limits.maxBufferedBytes - 6 + 1);
    throw new Error("The cut is read only after its check is reserved.");
  });
  submitUpdate(f, socket, "oversized", 2);
  await vi.waitFor(() => expect(socket.received).toContainEqual(expect.objectContaining({kind: "result", deliveryId: "oversized", result: "refused", reason: "capacity-refused"})));
  expect(read).toHaveBeenCalledOnce();
  expect(admission.validationBuffers(limits.maxBufferedBytes).usage()).toBe(0);
});

it("contains stalled syncs across two links in one workspace while another workspace stays open", async () => {
  const profile = selfHostLiveProfile(), limits = profile.namedLive.transport, admission = createLiveConnectionAdmission();
  const other = await fixture(limits, false, undefined, true, false, admission, 23, 1, true, "other-workspace");
  const owner = other.connect(""); expect(await owner.status).toBe(101); await openProductionSync(other, owner);
  const stalled = [], budget = admission.buffers(limits.maxBufferedBytes), MiB = 1024 * 1024;
  const workspacePortion = limits.maxBufferedBytes * (limits.maxConnectionsPerWorkspace - limits.reservedOwnerConnections) / limits.maxConnections;
  expect(workspacePortion).toBe(80 * MiB);
  for (let index = 0; index < 21; index++) {
    const f = await fixture(limits, true, undefined, false, false, admission, index + 1, 1, true, scope.workspaceId,
      index < 10 ? "first-share" : "second-share");
    vi.mocked(f.native.client.openLiveAppliedSync).mockResolvedValue({binding: {...f.binding, selectorPaths: [f.binding.currentPath]},
      hostVector: Buffer.from([0]), missingStateUpdate: Buffer.alloc(4 * MiB - 1024), observedLocalYDocHeadSequence: 1,
      position: {eventCount: 0, journalCursor: 0, evidenceDigest: "ab".repeat(32)}});
    const socket = f.connect((await f.mint()).token); expect(await socket.status).toBe(101);
    await openProductionSync(f, socket, false);
    if (index < 20) {
      await vi.waitFor(() => expect(budget.usage()).toBeGreaterThan((index + 1) * (4 * MiB - 1024)));
      stalled.push(socket);
    } else {
      await vi.waitFor(() => expect(socket.ws.readyState === WebSocket.CLOSED || budget.usage() > workspacePortion).toBe(true));
      expect(budget.usage()).toBeLessThanOrEqual(workspacePortion);
      expect(await socket.closed).toEqual([LIVE_CONNECTION_LIMIT_CLOSE_CODE, "live_buffer_limit"]);
    }
  }
  expect(budget.usage()).toBeLessThanOrEqual(workspacePortion);
  expect(stalled.every(socket => socket.ws.readyState === WebSocket.OPEN)).toBe(true);
  const pong = once(owner.ws, "pong"); owner.ws.ping("still-live"); await pong;
  expect(owner.ws.readyState).toBe(WebSocket.OPEN);
}, 60_000);

it("opens an owner 4 MiB sync while the non-owner workspace byte portion is full", async () => {
  const profile = selfHostLiveProfile(), limits = profile.namedLive.transport, admission = createLiveConnectionAdmission(), MiB = 1024 * 1024;
  const budget = admission.buffers(limits.maxBufferedBytes), workspacePortion = 80 * MiB;
  const release = budget.reserve(workspacePortion, [[JSON.stringify(["workspace", scope.workspaceId]), workspacePortion]]);
  const owner = await fixture(limits, false, undefined, true, false, admission, 1, 1, true);
  const syncBinding = {...owner.binding, selectorPaths: [owner.binding.currentPath]}, hostVector = Buffer.from([0]);
  const current = owner.storage.resolveCurrentLiveDocumentBinding({document: {workspaceId: owner.binding.workspaceId,
    mainVersionId: owner.binding.mainVersionId, objectId: owner.binding.objectId, lineageClaimId: owner.binding.lineageClaimId},
    actor: {kind: "owner", userId: "owner-1", shareId: scope.shareId}});
  if (current.kind !== "current") throw new Error("Expected current owner binding");
  const overhead = encodeLiveFrameSync({binding: current.binding, hostVector, missingStateUpdate: Uint8Array.of(0)}, owner.frames.receive).length - 1;
  const missingStateUpdate = Buffer.alloc(4 * MiB - overhead);
  expect(encodeLiveFrameSync({binding: current.binding, hostVector, missingStateUpdate}, owner.frames.receive)).toHaveLength(4 * MiB);
  vi.mocked(owner.native.client.openLiveAppliedSync).mockResolvedValue({binding: syncBinding,
    hostVector, missingStateUpdate, observedLocalYDocHeadSequence: 1,
    position: {eventCount: 0, journalCursor: 0, evidenceDigest: "ab".repeat(32)}});
  const own = owner.connect("");
  try {
    const named = await fixture(limits, false, undefined, false, false, admission, 2, 1, true);
    const refused = named.connect((await named.mint()).token); expect(await refused.status).toBe(101);
    expect(await refused.closed).toEqual([LIVE_CONNECTION_LIMIT_CLOSE_CODE, "live_buffer_limit"]);
    expect(await own.status).toBe(101); await openProductionSync(owner, own, false);
    await vi.waitFor(() => expect(budget.usage()).toBeGreaterThanOrEqual(workspacePortion + 4 * MiB));
    expect(budget.usage()).toBeLessThan(limits.maxBufferedBytes);
    expect(own.ws.readyState).toBe(WebSocket.OPEN);
  } finally {release(); own.ws.terminate();}
  await vi.waitFor(() => expect(budget.usage()).toBe(0));
});

function setNamedGrantKind(f: Awaited<ReturnType<typeof fixture>>, kind: "direct" | "claimed-email" | "link-dependent") {
  if (kind === "claimed-email") {
    f.raw.prepare("UPDATE sync_relay_share_grants SET principal_kind='email', principal_user_id=NULL, principal_email='reader@example.test' WHERE grant_id=?").run(scope.grantId);
    expect(f.storage.claimPendingSharesForEmail("reader@example.test", scope.userId)).toBe(1);
  } else if (kind === "link-dependent") {
    f.raw.prepare(`INSERT INTO sync_relay_share_grants
      (grant_id,share_id,principal_kind,principal_user_id,principal_email,access,generation,status,created_at_ms,revoked_at_ms,parent_grant_id)
      VALUES ('parent-link',?,'link',NULL,NULL,'edit',1,'active',1,NULL,NULL)`).run(scope.shareId);
    f.raw.prepare("UPDATE sync_relay_share_grants SET parent_grant_id='parent-link' WHERE grant_id=?").run(scope.grantId);
  }
}

it.each(["direct", "claimed-email", "link-dependent"] as const)("returns only the named grant binding from desktop admission for %s", async kind => {
  const f = await fixture(limits, false, undefined, false, true);
  setNamedGrantKind(f, kind);
  const response = await f.post("/sync/live/desktop-open", {shareId: scope.shareId, path: binding.currentPath});
  expect(response.status).toBe(200);
  const body = await response.json();
  expect(body).toMatchObject({workspaceId: `named:${scope.grantId}`, grantId: scope.grantId, objectId: binding.objectId, path: binding.currentPath});
  expect(JSON.stringify(body)).not.toContain(scope.workspaceId);
  expect(f.native.binding.workspaceId).toBe(scope.workspaceId);
});

it.each((["direct", "claimed-email", "link-dependent"] as const).flatMap(kind => [false, true].map(desktop => ({kind, desktop}))))
  ("returns only the named grant binding in live frames for $kind; desktop=$desktop", async ({kind, desktop}) => {
    const f = await fixture(limits, false, undefined, false, desktop);
    setNamedGrantKind(f, kind);
    const minted = await f.mint(), socket = f.connect(minted.token);
    expect(await socket.status).toBe(101);
    const {provider, until} = await startProvider(socket);
    await until(() => provider.state().status === "live");
    expect(provider.state().binding).toMatchObject({...binding, workspaceId: `named:${scope.grantId}`});
    expect(JSON.stringify(provider.state().binding)).not.toContain(scope.workspaceId);
    expect(f.native.binding.workspaceId).toBe(scope.workspaceId);
});

it.each(["view", "comment"] as const)("keeps %s recipients out of desktop admission and named live frames", async access => {
  const f = await fixture(limits, false, undefined, false, true), minted = await f.mint();
  f.raw.prepare("UPDATE sync_relay_share_grants SET access=?").run(access);
  const response = await f.post("/sync/live/desktop-open", {shareId: scope.shareId, path: binding.currentPath});
  expect(response.status).toBe(404);
  expect(await response.json()).toEqual({ok: false});
  expect(await f.connect(minted.token).status).not.toBe(101);
  expect(f.native.client.openLiveAppliedSync).not.toHaveBeenCalled();
});
