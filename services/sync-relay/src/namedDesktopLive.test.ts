import {afterEach, expect, it, vi} from "vitest";
import {LIVE_FRAME_DECLARED_SUBMIT_MAX_BYTES} from "@dohc/live-session-contract/live-frame";
import {createNamedDesktopLive} from "./namedDesktopLive";
import {createNamedFrameChanges} from "./namedLiveFrameHost";
import {fixture as ticketFixture, binding, scope} from "./liveTickets.test-helper";
import {LiveHostingRefusal} from "./storage/serviceHostEnrollment";
import {RELAY_EXCHANGE_KEY} from "./testing";

// A workspace member's desktop open on a server that hosts members'
// documents: it enrolls the document once, before any wait, and a refusal
// answers at once.

const relayHost = "relay.example.test", origin = "https://share.example.test";
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {for (const close of cleanups.splice(0).reverse()) await close(); vi.restoreAllMocks();});

async function fixture(options: {level?: "view" | "comment" | "edit"; hostsMemberDocuments?: boolean; browser?: boolean} = {}) {
  const hostBlocked = vi.fn((_document: {workspaceId: string; objectId: string}): string | undefined => undefined);
  const f = await ticketFixture(); cleanups.push(f.close);
  f.storage.claimWorkspaceIdentity({workspaceId: scope.workspaceId, replicationEpoch: "epoch", streamIdentity: "stream"});
  expect(f.storage.inviteWorkspaceMember({workspaceId: scope.workspaceId, actorUserId: "owner-1", workspaceName: "Plans", email: "sam@example.test",
    recipientUserId: "member-1", newMemberId: () => "member-entry", newGrantId: () => "member-grant", newShareId: () => "members-share", nowMs: 5}))
    .toMatchObject({ok: true});
  expect(f.storage.setWorkspaceMemberLevel({workspaceId: scope.workspaceId, actorUserId: "owner-1", level: options.level ?? "edit",
    workspaceName: undefined, newShareId: () => "unused-share", nowMs: 6})).toEqual({ok: true});
  const tickets = {mint: vi.fn(async () => null as {token: string; expiresAtMs: number} | null)};
  const changes = createNamedFrameChanges(16);
  // A browser's sessions belong to share-web's live route, which resolves them later.
  let sessionCount = 0;
  const browserSessions = {create: vi.fn(() => ({discriminator: `browser-${String(++sessionCount).padStart(4, "0")}`, expiresAtMs: 90_000})),
    remove: vi.fn(() => true)};
  const live = createNamedDesktopLive({
    ...(options.browser ? {browser: {exchangeKey: RELAY_EXCHANGE_KEY, sessions: browserSessions}} : {}),
    storage: f.storage, publicOrigin: origin, hosts: new Set([relayHost]), tickets: tickets as never, changes,
    resolveActor: async (request: Request, workspaceId: string) =>
      ({userId: request.headers.get("authorization") === "Bearer member" || request.headers.get("cookie") === "session=member" ? "member-1" : scope.userId,
        workspaceId}) as never,
    hostsMemberDocuments: () => options.hostsMemberDocuments ?? true,
    hostBlocked,
    readinessLimits: {maxPendingRequests: 8, maxPendingPerUser: 4, timeoutMs: 5000},
    limits: {maxSessions: 10, retentionMs: 60000, maxPendingRequests: 4, maxRequestBytes: 16384, maxResponseBytes: 16384, timeoutMs: 5000},
    editorLimits: {provider: {frames: {receive: {maxFrameBytes: LIVE_FRAME_DECLARED_SUBMIT_MAX_BYTES, maxStateVectorBytes: 1024, maxUpdateBytes: 4096, maxSyncBytes: 4096},
      maxQueuedBytes: 4096, maxQueuedFrames: 32, maxControlBytes: 4096, maxControlFrames: 8, maxAssemblyBytes: 4096},
      maxPendingUpdateBytes: 8192, maxPendingUpdates: 4, maxDeliveryAttempts: 3},
      maxHttpResponseBytes: 4096, maxSocketBufferedBytes: 4096, connectTimeoutMs: 1000, sendTimeoutMs: 1000, drainPollMs: 10},
  });
  const enroll = vi.spyOn(f.storage, "ensureOwnedLiveDocument");
  function post(route: "open" | "ready", body: {shareId: string; path: string} = {shareId: "members-share", path: binding.currentPath},
    who = "member", signal?: AbortSignal) {
    return live.handle(new Request(`https://${relayHost}/sync/live/desktop-${route}`, {
      method: "POST", headers: {host: relayHost, authorization: `Bearer ${who}`, "content-type": "application/json"}, body: JSON.stringify(body), signal,
    }));
  }
  function browserPost(route: "open" | "ready", body: Record<string, unknown> = {grantId: "member-grant", path: binding.currentPath},
    headers: Record<string, string> = {}, signal?: AbortSignal) {
    return live.handle(new Request(`https://${relayHost}/sync/live/member-${route}`, {
      method: "POST", body: JSON.stringify(body), signal, headers: {cookie: "session=member", origin,
        "x-dohc-relay-exchange-key": RELAY_EXCHANGE_KEY, "content-type": "application/json", ...headers},
    }));
  }
  return {...f, live, tickets, changes, enroll, post, browserPost, browserSessions, hostBlocked};
}

it("enrolls a member's document once before waiting for its host, then admits once the host is ready", async () => {
  const f = await fixture();
  const waiting = f.post("open");
  await vi.waitFor(() => expect(f.tickets.mint).toHaveBeenCalledTimes(1));
  expect(f.enroll).toHaveBeenCalledTimes(1);
  expect(f.enroll.mock.calls[0]![0]).toMatchObject({intent: "member-open", userId: "member-1", workspaceId: scope.workspaceId, path: binding.currentPath});
  expect(f.storage.readServiceHostEnrollment(scope.workspaceId, binding.currentPath)).toMatchObject({enabled: true, ownerUserId: "owner-1", shareId: "members-share"});
  f.tickets.mint.mockResolvedValue({token: "ab".repeat(32), expiresAtMs: 61_000});
  f.changes.notify(binding);
  const response = await waiting;
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({shareId: "members-share", grantId: "member-grant", path: binding.currentPath});
  expect(f.enroll).toHaveBeenCalledTimes(1);
});

it.each(["open", "ready"] as const)("answers a member's %s on a full host at once with the host's refusal", async route => {
  const f = await fixture();
  f.enroll.mockImplementation(() => {throw new LiveHostingRefusal("live_host_full");});
  const response = await f.post(route);
  if (route === "open") {
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ok: false, code: "live_host_full"});
  } else expect(await response.text()).toBe("waiting\nunavailable\n");
  expect(f.tickets.mint).not.toHaveBeenCalled();
});

it.each(["comment", "view"] as const)("refuses a member's open at %s at once and hosts nothing", async level => {
  const f = await fixture({level});
  expect((await f.post("open")).status).toBe(404);
  expect(f.tickets.mint).not.toHaveBeenCalled();
  expect(f.storage.readServiceHostEnrollment(scope.workspaceId, binding.currentPath)).toBeNull();
});

it.each([
  ["a path share's open", {}, {shareId: scope.shareId, path: binding.currentPath}, "reader"],
  ["a server that does not host members' documents", {hostsMemberDocuments: false}, undefined, "member"],
] as const)("enrolls nothing for %s", async (_, options, body, who) => {
  const f = await fixture(options);
  const cancel = new AbortController();
  const waiting = f.post("open", body, who, cancel.signal);
  await vi.waitFor(() => expect(f.tickets.mint).toHaveBeenCalledTimes(1));
  cancel.abort();
  expect((await waiting).status).toBe(404);
  expect(f.enroll).not.toHaveBeenCalled();
});

// A document with no live-editing history waits for its owner's desktop to
// start one. The member's open says so at once, even when the host blocks it
// while the open waits, and the readiness wait keeps waiting for the host.
it("answers a member's open at once when the host is blocked for lack of lineage", async () => {
  const f = await fixture();
  f.hostBlocked.mockReturnValue("without-lineage");
  const response = await f.post("open");
  expect(response.status).toBe(409);
  expect(await response.json()).toEqual({ok: false, code: "live-document-without-lineage"});
  expect(f.hostBlocked).toHaveBeenCalledWith({workspaceId: scope.workspaceId, objectId: binding.objectId});
  expect(f.tickets.mint).not.toHaveBeenCalled();
});

it("wakes a waiting open when its host blocks the document for lack of lineage", async () => {
  const f = await fixture();
  const waiting = f.post("open");
  await vi.waitFor(() => expect(f.tickets.mint).toHaveBeenCalledTimes(1));
  f.hostBlocked.mockReturnValue("without-lineage");
  f.changes.notifyHost([scope.workspaceId]);
  const response = await waiting;
  expect(response.status).toBe(409);
  expect(await response.json()).toEqual({ok: false, code: "live-document-without-lineage"});
});

it("keeps a readiness wait open while the host is blocked for lack of lineage, and answers ready once it hosts", async () => {
  const f = await fixture();
  f.hostBlocked.mockReturnValue("without-lineage");
  const response = await f.post("ready");
  const reader = response.body!.getReader(), decoder = new TextDecoder();
  expect(decoder.decode((await reader.read()).value)).toBe(`waiting${"\n"}`);
  await vi.waitFor(() => expect(f.tickets.mint).toHaveBeenCalledTimes(1));
  f.hostBlocked.mockReturnValue(undefined);
  f.tickets.mint.mockResolvedValue({token: "ab".repeat(32), expiresAtMs: 61_000});
  f.changes.notifyHost([scope.workspaceId]);
  expect(decoder.decode((await reader.read()).value)).toBe(`ready${"\n"}`);
});

it.each(["refused", "live-edit-unadmitted", "history-over-budget"])("keeps waiting on a host blocked as %s", async block => {
  const f = await fixture();
  f.hostBlocked.mockReturnValue(block);
  const cancel = new AbortController();
  const waiting = f.post("open", undefined, "member", cancel.signal);
  await vi.waitFor(() => expect(f.tickets.mint).toHaveBeenCalledTimes(1));
  cancel.abort();
  expect((await waiting).status).toBe(404);
});

// A member's browser opens a page through share-web: the account cookie and
// the exchange key, the grant by name, and the browser's own live sessions.
it("opens a member's page from a browser with the account cookie, in the browser's sessions", async () => {
  const f = await fixture({browser: true});
  f.tickets.mint.mockResolvedValue({token: "ab".repeat(32), expiresAtMs: 61_000});
  const response = await f.browserPost("open");
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({kind: "named", userId: "member-1", workspaceId: "named:member-grant", grantId: "member-grant",
    shareId: "members-share", path: binding.currentPath, discriminator: "browser-0002", ticket: {token: "ab".repeat(32)}});
  expect(f.enroll.mock.calls[0]![0]).toMatchObject({intent: "member-open", userId: "member-1"});
  expect(f.browserSessions.create).toHaveBeenCalledWith(expect.objectContaining({userId: "member-1", grantId: "member-grant", workspaceId: scope.workspaceId}));
  expect((await f.browserPost("ready")).headers.get("content-type")).toBe("text/plain");
});

it("answers a browser's open with the host's refusal, and waits on readiness for a page without lineage", async () => {
  const f = await fixture({browser: true});
  f.hostBlocked.mockReturnValue("without-lineage");
  const response = await f.browserPost("open");
  expect(response.status).toBe(409);
  expect(await response.json()).toEqual({ok: false, code: "live-document-without-lineage"});
  const ready = await f.browserPost("ready");
  const reader = ready.body!.getReader(), decoder = new TextDecoder();
  expect(decoder.decode((await reader.read()).value)).toBe(`waiting${"\n"}`);
  await vi.waitFor(() => expect(f.tickets.mint).toHaveBeenCalledTimes(1));
  f.hostBlocked.mockReturnValue(undefined);
  f.tickets.mint.mockResolvedValue({token: "ab".repeat(32), expiresAtMs: 61_000});
  f.changes.notifyHost([scope.workspaceId]);
  expect(decoder.decode((await reader.read()).value)).toBe(`ready${"\n"}`);
});

it.each([
  ["no exchange key", {}, {"x-dohc-relay-exchange-key": "wrong-key-wrong-key-wrong-key-wrong-key"}],
  ["another origin", {}, {origin: "https://elsewhere.test"}],
  ["a bearer token", {}, {authorization: "Bearer member"}],
  ["another account", {}, {cookie: "session=other"}],
  ["a path share's grant", {grantId: scope.grantId, path: binding.currentPath}, {cookie: "session=reader"}],
  ["a share named instead of a grant", {shareId: "members-share", path: binding.currentPath}, {}],
] as const)("refuses a browser's open with %s", async (_, body, headers) => {
  const f = await fixture({browser: true});
  f.tickets.mint.mockResolvedValue({token: "ab".repeat(32), expiresAtMs: 61_000});
  const response = await f.browserPost("open", Object.keys(body).length ? body : undefined, headers);
  expect(response.status).toBe(404);
  expect(f.browserSessions.create).not.toHaveBeenCalled();
});

it("keeps the desktop routes and the browser routes apart", async () => {
  const browser = await fixture({browser: true});
  expect((await browser.post("open")).status).toBe(404);
  const desktop = await fixture();
  expect((await desktop.browserPost("open")).status).toBe(404);
});
