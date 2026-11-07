import { generateKeyPairSync } from "node:crypto";
import { getCookies } from "better-auth/cookies";
import { afterEach, expect, it, vi } from "vitest";
import { UnauthorizedError, type ResolveAccountSession } from "@dohc/workspace-auth/session";
import { createSyncRelayHandler } from "../../sync-relay/src/server";
import { parsePushVapidPublicKey } from "../../sync-relay/src/pushRoutes";
import { closeTestStorages, testStorage } from "../../sync-relay/src/testing";
import { createShareWebApplication } from "./server";

const origin = "https://share.example.test", exchangeKey = "push-exchange-key-at-least-32-characters";
const cookieName = getCookies({baseURL: origin}).sessionToken.name;
const limits = {maxPendingRequests: 2, maxRequestBytes: 4096, maxResponseBytes: 16384, timeoutMs: 1000};
function point(): string {
  const jwk = generateKeyPairSync("ec", {namedCurve: "P-256"}).publicKey.export({format: "jwk"});
  return Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x!, "base64url"), Buffer.from(jwk.y!, "base64url")]).toString("base64url");
}
const vapid = point(), vapidKeyId = parsePushVapidPublicKey(vapid).keyId;
const installationId = "installation-000000001";
const subscription = {installationId, vapidKeyId, endpoint: "https://push.example.test/send/one", p256dh: point(),
  auth: Buffer.alloc(16, 1).toString("base64url"), expiresAtMs: null};

function request(path: string, user: string | null = "alice", input?: unknown, headers: Record<string, string> = {}): Request {
  return new Request(`${origin}/api/push/${path}`, {method: input === undefined ? "GET" : "POST",
    ...(input === undefined ? {} : {body: typeof input === "string" ? input : JSON.stringify(input)}),
    headers: {host: "share.example.test", origin, "content-type": "application/json",
      ...(user === null ? {} : {cookie: `${cookieName}=${user}`}), ...headers}});
}
const status = (user: string | null = "alice", headers: Record<string, string> = {}) => request("status", user, {installationId}, headers);

async function fixture(relayOverride?: (incoming: Request) => Promise<Response>) {
  const storage = await testStorage();
  const resolveAccountSession = vi.fn<ResolveAccountSession>(async incoming => {
    expect([...incoming.headers.keys()]).toEqual(["cookie"]);
    const cookie = incoming.headers.get("cookie"), userId = cookie?.slice(cookieName.length + 1);
    if (!cookie?.startsWith(`${cookieName}=`) || !userId || userId.includes(";")) throw new UnauthorizedError();
    return {userId, sessionId: `sign-in-${userId}`, expiresAtMs: Number.MAX_SAFE_INTEGER};
  });
  const relay = createSyncRelayHandler({storage, resolveActor: () => {throw new UnauthorizedError();}, resolveAccountSession,
    pushVapidPublicKey: vapid, pushHosts: new Set(["push.example.test"]), shareWebOrigin: origin, relayExchangeKey: exchangeKey,
    namedBrowserSessionLimits: {...limits, maxSessions: 8, retentionMs: 60_000}});
  const forwarded: Request[] = [];
  const web = createShareWebApplication({relayUrl: "http://relay.invalid", publicRelayUrl: "https://relay.test", publicHosts: new Set(["share.example.test"]),
    accountAuth: {upstreamUrl: "http://auth.invalid", publicOrigin: origin}, relayExchangeKey: exchangeKey, namedBrowserSessionLimits: limits,
    fetchRelay: incoming => {forwarded.push(incoming.clone()); return (relayOverride ?? relay)(incoming);}});
  return {storage, resolveAccountSession, forwarded, web};
}
afterEach(async () => {vi.useRealTimers(); await closeTestStorages();});

it("turns alerts on and off through the account session, forwarding nothing else", async () => {
  const f = await fixture();
  const off = await f.web.handle(status());
  expect(off.status).toBe(200);
  expect(off.headers.get("cache-control")).toBe("private, no-store");
  expect(await off.json()).toEqual({ok: true, available: true, vapidPublicKey: vapid, vapidKeyId, enabled: false, generation: null, fingerprint: null});
  const incoming = request("subscribe", "alice", subscription, {authorization: "Bearer forged", "x-user-id": "bob",
    "x-dohc-relay-exchange-key": "forged", cookie: `${cookieName}=alice; dohc_link=secret; other=secret`});
  const on = await f.web.handle(incoming), result = await on.json();
  expect(on.status).toBe(200);
  expect(result).toMatchObject({enabled: true, generation: 1});
  expect(JSON.stringify(result)).not.toContain("push.example.test");
  const sent = f.forwarded.at(-1)!;
  expect(new URL(sent.url).pathname).toBe("/sync/push/subscribe");
  expect(Object.fromEntries(sent.headers)).toEqual({cookie: `${cookieName}=alice`, origin, "x-dohc-relay-exchange-key": exchangeKey,
    "content-type": "application/json", "x-dohc-api-version": "1"});
  expect(await (await f.web.handle(status("bob"))).json()).toMatchObject({enabled: false, fingerprint: null});
  expect(await (await f.web.handle(request("unsubscribe", "alice", {installationId}))).json()).toMatchObject({enabled: false});
  expect(await (await f.web.handle(status())).json()).toMatchObject({enabled: false});
});

it("refuses cross-site and wrong-origin requests before they reach the relay", async () => {
  const f = await fixture();
  for (const incoming of [
    request("subscribe", "alice", subscription, {origin: "https://evil.example"}),
    request("subscribe", "alice", subscription, {"sec-fetch-site": "cross-site"}),
    request("subscribe", "alice", subscription, {"content-type": "text/plain"}),
    request("subscribe", "alice", subscription, {host: "evil.example"}),
    request(`subscribe?installationId=${installationId}`, "alice", subscription),
    status("alice", {"sec-fetch-site": "cross-site"}),
    status("alice", {origin: "https://evil.example"}),
    // A status request with no Origin: browsers always send one on a POST.
    new Request(`${origin}/api/push/status`, {method: "POST", body: JSON.stringify({installationId}),
      headers: {host: "share.example.test", "content-type": "application/json", cookie: `${cookieName}=alice`}}),
    request(`status?installationId=${installationId}`, "alice"),
    request("subscribe", "alice"),
    request("other", "alice", {installationId}),
  ]) {
    expect((await f.web.handle(incoming)).status).toBe(404);
  }
  expect(f.forwarded).toEqual([]);
});

it("treats a link holder or a signed-out browser as signed out, without asking the relay", async () => {
  const f = await fixture();
  for (const incoming of [status(null), request("subscribe", null, subscription, {cookie: "dohc_link=secret"}),
    request("subscribe", null, subscription, {authorization: "LinkCapability " + "a".repeat(43)})]) {
    const response = await f.web.handle(incoming);
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({code: "signed_out"});
  }
  expect(f.forwarded).toEqual([]);
});

it("bounds the request body", async () => {
  const f = await fixture();
  const response = await f.web.handle(request("subscribe", "alice", {...subscription, endpoint: `https://push.example.test/${"x".repeat(5000)}`}));
  expect(response.status).toBe(413);
  expect(f.forwarded).toEqual([]);
});

it("refuses a relay answer that is not exactly a push status", async () => {
  const leaking = await fixture(async () => Response.json({ok: true, available: true, vapidPublicKey: vapid, vapidKeyId,
    enabled: true, generation: 1, fingerprint: "a".repeat(64), endpoint: "https://push.example.test/send/other"}));
  expect((await leaking.web.handle(status())).status).toBe(404);
  const redirect = await fixture(async () => new Response(null, {status: 302, headers: {location: "https://evil.example"}}));
  expect((await redirect.web.handle(status())).status).toBe(404);
  const failing = await fixture(async () => new Response(null, {status: 500}));
  expect((await failing.web.handle(status())).status).toBe(503);
});
