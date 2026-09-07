import { getCookies } from "better-auth/cookies";
import { afterEach, describe, expect, it, vi } from "vitest";
import { UnauthorizedError, type ResolveActor } from "@dohc/workspace-auth/session";
import { createSyncRelayHandler } from "../../sync-relay/src/server";
import { testStorage, closeTestStorages } from "../../sync-relay/src/testing";
import { parseNamedLiveBrowserHttpLimits } from "../../sync-relay/src/namedLiveBrowserHttp";
import { createShareWebApplication } from "./server";
import { parseNamedLiveBrowserClientLimits } from "./namedLiveBrowserClient";
import { LIVE_UPDATE_IDENTIFIER_MAX_BYTES, parseLiveUpdateIdentifier } from "@dohc/live-session-contract/live-update-admission";

const origin = "https://share.example.test", exchangeKey = "named-bootstrap-test-exchange-key-32-characters";
const cookieName = getCookies({ baseURL: origin }).sessionToken.name;
const preferenceCookieName = getCookies({ baseURL: origin }).dontRememberToken.name;
const transport = { maxPendingRequests: 2, maxRequestBytes: 1038, maxResponseBytes: 4152, timeoutMs: 1000 };
const relayLimits = { ...transport, maxSessions: 4, retentionMs: 60000 };
const cookie = (user: string) => `${cookieName}=${user}`;
function request(body: unknown = { grantId: "alice-grant" }, user = "alice", changes: RequestInit = {}) {
  return new Request(`${origin}/api/live/named-session`, { method: "POST", body: JSON.stringify(body),
    headers: { host: "share.example.test", origin, "content-type": "application/json", cookie: cookie(user) }, ...changes });
}

async function fixture(resolve?: ResolveActor, options: { maxSessions?: number; maxPendingRequests?: number; timeoutMs?: number } = {}, access = "edit", lookups: {
  lookupVerifiedUserEmail?: (userId: string) => Promise<string | null> | string | null;
  lookupUserEmail?: (userId: string) => Promise<string | null> | string | null;
} = {}) {
  const storage = await testStorage();
  storage.claimWorkspace({ workspaceId: "workspace", ownerUserId: "owner", createdAtMs: 1 });
  for (const user of ["alice", "bob"]) storage.createShare({
    share: { shareId: `${user}-share`, workspaceId: "workspace", granterUserId: "owner",
      selectorJson: JSON.stringify({ paths: ["docs"], versionId: null }), createdAtMs: 1 },
    grant: { grantId: `${user}-grant`, shareId: `${user}-share`, principalKind: "user", principalUserId: user,
      principalEmail: null, access, generation: 1, status: "active", createdAtMs: 1, revokedAtMs: null, parentGrantId: null },
  });
  const resolveActor = vi.fn<ResolveActor>(resolve ?? ((incoming, workspaceId) => {
    const value = incoming.headers.get("cookie");
    const userId = value === cookie("alice") ? "alice" : value === cookie("bob") ? "bob" : null;
    if (!userId) throw new UnauthorizedError();
    return { userId, workspaceId };
  }));
  const relayOptions = { storage, resolveActor, ...lookups, shareWebOrigin: origin, relayExchangeKey: exchangeKey,
    namedBrowserSessionLimits: { ...relayLimits, ...options } };
  let relay = createSyncRelayHandler(relayOptions);
  const forwarded: Request[] = [];
  const web = createShareWebApplication({ relayUrl: "http://relay.invalid", publicRelayUrl: "https://relay.example.test",
    publicHosts: new Set(["share.example.test"]), relayExchangeKey: exchangeKey,
    accountAuth: { upstreamUrl: "http://auth.invalid", publicOrigin: origin }, namedBrowserSessionLimits: { ...transport, timeoutMs: options.timeoutMs ?? transport.timeoutMs },
    fetchRelay: async incoming => { forwarded.push(incoming.clone()); return relay(incoming); } });
  return { storage, resolveActor, web, forwarded, relay: (incoming: Request) => relay(incoming),
    restart: () => { relay = createSyncRelayHandler(relayOptions); } };
}

afterEach(async () => { vi.useRealTimers(); await closeTestStorages(); });

describe("named browser HTTP bootstrap and private resolution", () => {
  function seedPendingInvite(storage: Awaited<ReturnType<typeof fixture>>["storage"]) {
    storage.createShare({
      share: { shareId: "pending-share", workspaceId: "workspace", granterUserId: "owner",
        selectorJson: JSON.stringify({ paths: ["docs"], versionId: null }), createdAtMs: 1 },
      grant: { grantId: "pending-grant", shareId: "pending-share", principalKind: "email", principalUserId: null,
        principalEmail: "invited@example.test", access: "edit", generation: 1, status: "active", createdAtMs: 1, revokedAtMs: null, parentGrantId: null },
    });
  }

  it.each([
    { label: "verified invited account", user: "alice", verifiedEmail: "invited@example.test", status: 200 },
    { label: "wrong verified account", user: "bob", verifiedEmail: "bob@example.test", status: 404 },
    { label: "unverified invited account", user: "alice", verifiedEmail: null, status: 404 },
  ])("claims pending email invites only for the $label", async ({ user, verifiedEmail, status }) => {
    const lookupVerifiedUserEmail = vi.fn(() => verifiedEmail);
    const f = await fixture(undefined, {}, "edit", { lookupVerifiedUserEmail, lookupUserEmail: () => "invited@example.test" });
    seedPendingInvite(f.storage);
    const response = await f.web.handle(request({ grantId: "pending-grant" }, user));
    expect(response.status).toBe(status);
    expect(f.resolveActor).toHaveBeenCalledTimes(1);
    expect(lookupVerifiedUserEmail).toHaveBeenCalledExactlyOnceWith(user);
    if (status === 200) {
      const { discriminator } = await response.json() as { discriminator: string };
      expect(f.storage.getShareGrant("pending-grant")).toMatchObject({ principalKind: "user", principalUserId: "alice", principalEmail: null });
      expect(await f.web.resolveNamedBrowserSession(request(), discriminator)).toEqual({ userId: "alice", workspaceId: "workspace", shareId: "pending-share", grantId: "pending-grant" });
    } else {
      expect(f.storage.getShareGrant("pending-grant")).toMatchObject({ principalKind: "email", principalUserId: null });
      expect((await f.relay(new Request("http://relay.invalid/sync/shares", { headers: { cookie: cookie(user) } }))).status).toBe(200);
      expect(f.storage.getShareGrant("pending-grant")).toMatchObject({ principalKind: "email", principalUserId: null });
      expect((await f.web.handle(request({ grantId: "pending-grant" }, user))).status).toBe(404);
    }
  });

  it("does not claim a pending email invite for a mismatched workspace", async () => {
    const lookupVerifiedUserEmail = vi.fn(() => "invited@example.test");
    const f = await fixture(() => ({ userId: "alice", workspaceId: "other" }), {}, "edit", { lookupVerifiedUserEmail });
    seedPendingInvite(f.storage);
    expect((await f.web.handle(request({ grantId: "pending-grant" }))).status).toBe(404);
    expect(lookupVerifiedUserEmail).not.toHaveBeenCalled();
    expect(f.storage.getShareGrant("pending-grant")).toMatchObject({ principalKind: "email", principalUserId: null });
  });

  it("keeps a cancelled pending email lookup in its slot and never claims its invite", async () => {
    let enter!: () => void, release!: () => void;
    const entered = new Promise<void>(resolve => { enter = resolve; });
    const blocked = new Promise<void>(resolve => { release = resolve; });
    const f = await fixture(undefined, { maxPendingRequests: 1 }, "edit", { lookupVerifiedUserEmail: async userId => {
      if (userId !== "alice") return "bob@example.test";
      enter(); await blocked; return "invited@example.test";
    } });
    seedPendingInvite(f.storage);
    const controller = new AbortController();
    const pending = f.web.handle(request({ grantId: "pending-grant" }, "alice", { signal: controller.signal }));
    await entered; controller.abort();
    expect((await pending).status).toBe(404);
    expect((await f.web.handle(request({ grantId: "bob-grant" }, "bob"))).status).toBe(404);
    release();
    await vi.waitFor(async () => expect((await f.web.handle(request({ grantId: "bob-grant" }, "bob"))).status).toBe(200));
    expect(f.storage.getShareGrant("pending-grant")).toMatchObject({ principalKind: "email", principalUserId: null });
  });

  it("ignores valueless cookie suffixes and preserves only recognized account cookies", async () => {
    const f = await fixture(incoming => {
      expect(incoming.headers.get("cookie")).toBe(`${cookie("alice")}; ${preferenceCookieName}=signed-preference`);
      expect(incoming.headers.has("authorization")).toBe(false);
      return { userId: "alice", workspaceId: "workspace" };
    });
    const incoming = request();
    incoming.headers.set("cookie", `${cookieName}X; ${cookie("alice")}; ${preferenceCookieName}=signed-preference; unrelated=secret`);
    incoming.headers.set("authorization", "Bearer other-user");
    const response = await f.web.handle(incoming);
    expect(response.status).toBe(200);
    const { discriminator } = await response.json() as { discriminator: string };
    expect(await f.web.resolveNamedBrowserSession(incoming, discriminator)).toMatchObject({ userId: "alice" });
    for (const duplicate of [cookie("alice"), `${preferenceCookieName}=another-preference`]) {
      const repeated = request();
      repeated.headers.set("cookie", `${cookie("alice")}; ${preferenceCookieName}=signed-preference; ${duplicate}`);
      expect((await f.web.handle(repeated)).status).toBe(404);
    }
    const valueless = request(); valueless.headers.set("cookie", `${cookieName}X`);
    expect((await f.web.handle(valueless)).status).toBe(404);
    expect(f.resolveActor).toHaveBeenCalledTimes(2);
  });

  it("requires capacity for every valid identifier after JSON escaping", () => {
    for (const unit of ['"', "\\", "é", "😀"]) {
      const identifier = unit.repeat(LIVE_UPDATE_IDENTIFIER_MAX_BYTES / Buffer.byteLength(unit));
      expect(parseLiveUpdateIdentifier(identifier)).toBe(identifier);
      expect(Buffer.byteLength(JSON.stringify({ grantId: identifier }))).toBeLessThanOrEqual(1038);
      expect(Buffer.byteLength(JSON.stringify({ userId: identifier, workspaceId: identifier, shareId: identifier, grantId: identifier }))).toBeLessThanOrEqual(4152);
    }
    const longest = '"'.repeat(LIVE_UPDATE_IDENTIFIER_MAX_BYTES);
    expect(Buffer.byteLength(JSON.stringify({ grantId: longest }))).toBe(1038);
    expect(Buffer.byteLength(JSON.stringify({ userId: longest, workspaceId: longest, shareId: longest, grantId: longest }))).toBe(4152);
    for (const invalid of ["\u0000", "\u001f", "\u007f", "\ud800", "x".repeat(513)]) expect(() => parseLiveUpdateIdentifier(invalid)).toThrow();
    for (const [parse, limits] of [[parseNamedLiveBrowserClientLimits, transport], [parseNamedLiveBrowserHttpLimits, relayLimits]] as const) {
      expect(parse(limits)).toEqual(limits);
      expect(() => parse({ ...limits, maxRequestBytes: 1037 })).toThrow(/limits/);
      expect(() => parse({ ...limits, maxResponseBytes: 4151 })).toThrow(/limits/);
      expect(parse({ ...limits, maxRequestBytes: 64 * 1024 * 1024, maxResponseBytes: 64 * 1024 * 1024 }).maxRequestBytes).toBe(64 * 1024 * 1024);
    }
  });

  it("bootstraps and resolves maximum escaped identifiers at the structural byte minima", async () => {
    const id = parseLiveUpdateIdentifier('"'.repeat(512));
    const storage = await testStorage();
    storage.claimWorkspace({ workspaceId: id, ownerUserId: "owner", createdAtMs: 1 });
    storage.createShare({
      share: { shareId: id, workspaceId: id, granterUserId: "owner", selectorJson: JSON.stringify({ paths: ["docs"], versionId: null }), createdAtMs: 1 },
      grant: { grantId: id, shareId: id, principalKind: "user", principalUserId: id, principalEmail: null, access: "edit", generation: 1, status: "active", createdAtMs: 1, revokedAtMs: null, parentGrantId: null },
    });
    const relay = createSyncRelayHandler({ storage, resolveActor: (_request, workspaceId) => ({ userId: id, workspaceId }),
      shareWebOrigin: origin, relayExchangeKey: exchangeKey, namedBrowserSessionLimits: relayLimits });
    const web = createShareWebApplication({ relayUrl: "http://relay.invalid", publicRelayUrl: "https://relay.example.test",
      publicHosts: new Set(["share.example.test"]), relayExchangeKey: exchangeKey,
      accountAuth: { upstreamUrl: "http://auth.invalid", publicOrigin: origin }, namedBrowserSessionLimits: transport, fetchRelay: relay });
    const response = await web.handle(request({ grantId: id }));
    expect(response.status).toBe(200);
    const { discriminator } = await response.json() as { discriminator: string };
    expect(await web.resolveNamedBrowserSession(request(), discriminator)).toEqual({ userId: id, workspaceId: id, shareId: id, grantId: id });
  });

  it("derives route scope from SQLite and forwards only the account cookie through the service boundary", async () => {
    const f = await fixture();
    const incoming = request();
    incoming.headers.set("cookie", `${cookie("alice")}; dohc_link=secret; dohc_profile=secret`);
    incoming.headers.set("authorization", "Bearer bob");
    incoming.headers.set("x-user-id", "bob");
    incoming.headers.set("x-dohc-relay-exchange-key", "forged");
    const response = await f.web.handle(incoming);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("set-cookie")).toBeNull();
    const issued = await response.json() as { discriminator: string; expiresAtMs: number };
    expect(Object.keys(issued).sort()).toEqual(["discriminator", "expiresAtMs"]);
    expect(issued.discriminator).toMatch(/^[A-Za-z0-9_-]{12}$/u);
    expect(f.forwarded[0]!.headers.get("cookie")).toBe(cookie("alice"));
    expect(f.forwarded[0]!.headers.get("x-dohc-relay-exchange-key")).toBe(exchangeKey);
    expect(f.forwarded[0]!.headers.get("authorization")).toBeNull();
    expect(f.forwarded[0]!.headers.get("x-user-id")).toBeNull();
    expect(f.resolveActor.mock.calls[0]![1]).toBe("workspace");
    expect(await f.web.resolveNamedBrowserSession(request(), issued.discriminator)).toEqual({
      userId: "alice", workspaceId: "workspace", shareId: "alice-share", grantId: "alice-grant" });
    expect(await f.web.resolveNamedBrowserSession(request({}, "bob"), issued.discriminator)).toBeNull();
    f.restart();
    expect(await f.web.resolveNamedBrowserSession(request(), issued.discriminator)).toBeNull();
  });

  it("rejects forged scope, other grants, non-Edit grants, bad cookies, and missing configuration", async () => {
    const f = await fixture();
    for (const body of [{ grantId: "alice-grant", userId: "bob" }, { grantId: "alice-grant", workspaceId: "forged" },
      { grantId: "alice-grant", shareId: "bob-share" }, { grantId: "bob-grant" }, { grantId: "missing" }]) {
      expect((await f.web.handle(request(body))).status).toBe(404);
    }
    const duplicate = request(); duplicate.headers.set("cookie", `${cookie("alice")}; ${cookie("bob")}`);
    expect((await f.web.handle(duplicate)).status).toBe(404);
    const linkOnly = request(); linkOnly.headers.set("cookie", "dohc_link=secret");
    expect((await f.web.handle(linkOnly)).status).toBe(404);
    expect((await f.web.handle(request({}, "unknown"))).status).toBe(404);
    const viewOnly = await fixture(undefined, {}, "view");
    expect((await viewOnly.web.handle(request())).status).toBe(404);
    const disabled = createShareWebApplication({ relayUrl: "http://relay.invalid", publicRelayUrl: "https://relay.example.test", publicHosts: new Set(["share.example.test"]) });
    expect((await disabled.handle(request())).status).toBe(404);
    expect(await disabled.resolveNamedBrowserSession(request(), "abcdefghijkl")).toBeNull();
  });

  it("rejects missing or hostile origin, private exchange bypass, and malformed request bodies", async () => {
    const f = await fixture();
    for (const value of [null, "https://other.test", "null"]) {
      const incoming = request();
      if (value === null) incoming.headers.delete("origin"); else incoming.headers.set("origin", value);
      expect((await f.web.handle(incoming)).status).toBe(404);
    }
    const crossSite = request(); crossSite.headers.set("sec-fetch-site", "cross-site");
    expect((await f.web.handle(crossSite)).status).toBe(404);
    const badHost = request(); badHost.headers.set("host", "other.test");
    expect((await f.web.handle(badHost)).status).toBe(404);
    for (const path of ["/sync/live/named-sessions", "/sync/live/named-sessions/resolve"]) {
      expect((await f.relay(new Request(`http://relay.invalid${path}`, { method: "POST", body: "{}",
        headers: { origin, "content-type": "application/json", cookie: cookie("alice") } }))).status).toBe(404);
    }
    expect((await f.web.handle(request(undefined, "alice", { body: "x".repeat(transport.maxRequestBytes + 1) }))).status).toBe(404);
    expect((await f.web.handle(request(undefined, "alice", { body: "{" }))).status).toBe(404);
    expect(f.resolveActor).not.toHaveBeenCalled();
  });

  it("rechecks revocation for bootstrap and private resolution without registering a document", async () => {
    const f = await fixture();
    const response = await f.web.handle(request());
    const { discriminator } = await response.json() as { discriminator: string };
    expect(f.storage.revokeShareGrant({ shareId: "alice-share", grantId: "alice-grant", revokedAtMs: 2 }).ok).toBe(true);
    expect((await f.web.handle(request())).status).toBe(404);
    expect(await f.web.resolveNamedBrowserSession(request(), discriminator)).toBeNull();
    expect(f.storage.getLiveHostControl()).toBeNull();
  });

  it("does not create a mapping after cancellation while cookie authentication is pending", async () => {
    let finish!: () => void, started!: () => void;
    const entered = new Promise<void>(resolve => { started = resolve; });
    const blocked = new Promise<void>(resolve => { finish = resolve; });
    let calls = 0;
    const f = await fixture(async (_incoming, workspaceId) => {
      if (++calls === 1) { started(); await blocked; }
      return { userId: "alice", workspaceId };
    }, { maxSessions: 1 });
    const controller = new AbortController();
    const waiting = f.web.handle(request(undefined, "alice", { signal: controller.signal }));
    await entered; controller.abort();
    expect((await waiting).status).toBe(404);
    finish();
    // A completed second HTTP operation also lets the cancelled auth finish.
    expect((await f.web.handle(request())).status).toBe(200);
  });

  it("refuses a grant revoked while cookie authentication is pending", async () => {
    let finish!: () => void, started!: () => void;
    const entered = new Promise<void>(resolve => { started = resolve; });
    const blocked = new Promise<void>(resolve => { finish = resolve; });
    const f = await fixture(async (_incoming, workspaceId) => { started(); await blocked; return { userId: "alice", workspaceId }; });
    const waiting = f.web.handle(request());
    await entered;
    expect(f.storage.revokeShareGrant({ shareId: "alice-share", grantId: "alice-grant", revokedAtMs: 2 }).ok).toBe(true);
    finish();
    expect((await waiting).status).toBe(404);
  });

  it("holds request capacity until timed-out authentication settles and then reuses it", async () => {
    vi.useFakeTimers();
    let finish!: () => void, started!: () => void;
    const entered = new Promise<void>(resolve => { started = resolve; });
    const blocked = new Promise<void>(resolve => { finish = resolve; });
    const f = await fixture(async (_incoming, workspaceId) => { started(); await blocked; return { userId: "alice", workspaceId }; });
    const first = f.web.handle(request()); await entered;
    const second = f.web.handle(request());
    await vi.advanceTimersByTimeAsync(1000);
    expect((await first).status).toBe(404); expect((await second).status).toBe(404);
    expect((await f.web.handle(request())).status).toBe(404);
    finish(); await vi.runAllTimersAsync();
    expect((await f.web.handle(request())).status).toBe(200);
  });

  it("requires every operational limit explicitly and rejects injected or invalid fields", () => {
    for (const [parse, value] of [[parseNamedLiveBrowserHttpLimits, relayLimits], [parseNamedLiveBrowserClientLimits, transport]] as const) {
      expect(parse(value)).toEqual(value);
      for (const field of Object.keys(value)) {
        const missing = { ...value } as Record<string, unknown>; delete missing[field];
        expect(() => parse(missing)).toThrow(/limits/);
        for (const bad of [0, -1, 1.5, "1", Number.MAX_SAFE_INTEGER + 1]) expect(() => parse({ ...value, [field]: bad })).toThrow(/limits/);
      }
      expect(() => parse({ ...value, timeoutMs: 2 ** 31 })).toThrow(/limits/);
      expect(() => parse({ ...value, ports: {} })).toThrow(/limits/);
    }
  });

  it("rejects retention that cannot form a safe session expiry at startup", () => {
    const now = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(now);
    try {
      const retentionMs = Number.MAX_SAFE_INTEGER - now;
      expect(parseNamedLiveBrowserHttpLimits({ ...relayLimits, retentionMs }).retentionMs).toBe(retentionMs);
      for (const value of [retentionMs + 1, Number.MAX_SAFE_INTEGER]) {
        expect(() => parseNamedLiveBrowserHttpLimits({ ...relayLimits, retentionMs: value })).toThrow(/limits/);
      }
    } finally { clock.mockRestore(); }
  });
});
