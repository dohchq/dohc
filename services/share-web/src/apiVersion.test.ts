import { afterEach, expect, it, vi } from "vitest";
import { createShareWebApplication, type CreateShareWebApplicationOptions } from "./server";

const build = vi.hoisted(() => ({compiled: 1, accepted: {min: 1, max: 1}}));
vi.mock("@dohc/workspace-contracts/relay-values", async importOriginal => {
  const actual = await importOriginal<typeof import("@dohc/workspace-contracts/relay-values")>();
  return {...actual, get SHARE_WEB_API_VERSION() {return build.compiled;}};
});
vi.mock("./apiVersion", async importOriginal => {
  const actual = await importOriginal<typeof import("./apiVersion")>();
  return {...actual, get SHARE_WEB_API_VERSIONS() {return build.accepted;}};
});
// A later build speaks `compiled` and still accepts versions from `min`.
const release = (compiled: number, min: number) => {build.compiled = compiled; build.accepted = {min, max: compiled};};
afterEach(() => release(1, 1));

const host = "share.example.com", origin = "https://" + host;
const header = "x-dohc-share-web-api-version";
const versionHeader = (version: string | undefined): Record<string, string> => version === undefined ? {} : {[header]: version};
const secret = "A".repeat(43), capability = "B".repeat(43);
const routes = [
  ["POST", "/api/exchange"], ["POST", "/api/handoff"],
  ["GET", "/api/view/meta"], ["GET", "/api/view/current"], ["GET", "/api/view/log"],
  ["GET", "/api/view/discussion"], ["POST", "/api/view/discussion"], ["GET", "/api/view/discussion/activity"],
  ["POST", "/api/view/collection-writes"], ["GET", "/api/view/chat/channels"], ["GET", "/api/view/chat/messages"],
  ["POST", "/api/view/chat/messages"], ["GET", "/api/account/session"],
  ["POST", "/api/account/sign-in"], ["POST", "/api/account/sign-out"],
  ...["link-document", "link-ticket", "named-session", "named-ticket", "named-documents"].map(path => ["POST", "/api/live/" + path]),
  ["GET", "/api/apps"], ["POST", "/api/apps/launch"], ["POST", "/api/apps/summary"],
  ["POST", "/api/mcp/exchange"], ["GET", "/mcp"], ["POST", "/mcp"], ["DELETE", "/mcp"],
];
function fixture(extra: Partial<CreateShareWebApplicationOptions> = {}) {
  const calls: Request[] = [];
  let revoked = false;
  const relay = vi.fn(async (request: Request) => {
    calls.push(request);
    const path = new URL(request.url).pathname;
    if (path === "/sync/link-exchange") return Response.json({ok: true, grantId: "grant-a", capabilityToken: capability, capabilityExpiresAtMs: Date.now() + 900_000});
    if (revoked) return new Response(null, {status: 404});
    if (path === "/sync/link/share") return Response.json({ok: true, access: "view", effectiveSelector: {versionId: null, paths: [], access: "view"}});
    if (path === "/sync/link/log") return Response.json({ok: true, ops: [], nextCursor: 7, hasMore: false, epochLogFloor: 0});
    if (path === "/sync/link/current") return Response.json({ok: true, files: []});
    if (path === "/sync/link/chat/channels") return new Response(null, {status: 404});
    return Response.json({ok: true});
  });
  const app = createShareWebApplication({relayUrl: "https://relay.test", publicRelayUrl: "https://relay.test", publicHosts: new Set([host]),
    fetchRelay: relay, appLaunch: {viewerOrigin: origin, appDomain: "example.net"}, ...extra});
  const send = (path: string, init: RequestInit = {}) => app.handle(new Request(origin + path, {...init, headers: {host, ...init.headers}}));
  const exchange = (version?: string, agent = false) => send(agent ? "/api/mcp/exchange" : "/api/exchange", {method: "POST",
    headers: {"content-type": "application/json", ...versionHeader(version)}, body: JSON.stringify({secret})});
  const mcp = (bearer: string, version?: string) => send("/mcp", {method: "POST", headers: {authorization: "Bearer " + bearer,
    "content-type": "application/json", accept: "application/json, text/event-stream", ...versionHeader(version)},
    body: JSON.stringify({jsonrpc: "2.0", id: 1, method: "tools/list"})});
  return {app, send, exchange, mcp, relay, calls, revoke() {revoked = true;}};
}

it.each(routes)("refuses %s %s before authentication, body reads or upstream calls", async (method, path) => {
  const f = fixture();
  const result = await f.send(path!, {method, headers: {[header]: "99"}, ...(method === "POST" ? {body: "not-json"} : {})});
  expect(result.status).toBe(409);
  expect(await result.json()).toMatchObject({ok: false, api: "share-web", code: "api_version_too_new", apiVersions: {min: 1, max: 1}, discovery: "/api/mcp"});
  expect(result.headers.get("cache-control")).toBe("private, no-store");
  expect(result.headers.get("x-content-type-options")).toBe("nosniff");
  expect(f.calls).toHaveLength(0);
});

it.each(["", "0", "01", "1.0", "one", "1, 1", "1234567890", "sensitive-client-value"])("answers malformed %j without echoing it", async value => {
  const result = await fixture().send("/api/view/meta", {headers: {[header]: value}});
  expect(result.status).toBe(400);
  const body = await result.json();
  expect(body).toMatchObject({ok: false, api: "share-web", code: "bad_request", discovery: "/api/mcp", apiVersions: {min: 1, max: 1}});
  const other = await fixture().send("/api/view/meta", {headers: {[header]: "different-sensitive-value"}});
  expect(body).toEqual(await other.json());
});

it("keeps wrong hosts, unknown paths, unsupported methods and excluded routes opaque", async () => {
  const f = fixture();
  for (const path of ["/unknown", "/api/view/unknown", "/api/account/unknown", "/api/live/unknown", "/api/view/blob/" + "a".repeat(64), "/api/live", "/api/live/link"]) {
    const result = await f.send(path, {headers: {[header]: "99"}});
    expect(result.status, path).toBe(404);
    expect(await result.json()).toEqual({ok: false, error: "not found"});
  }
  expect((await f.send("/api/exchange", {headers: {[header]: "99"}})).status).toBe(404);
  for (const path of ["/api/view/meta", "/api/apps/launch", "/api/apps/summary"]) {
    expect((await f.app.handle(new Request("https://wrong.test" + path, {method: "POST", headers: {host: "wrong.test", [header]: "99"}}))).status).toBe(404);
  }
  for (const path of ["/bootstrap", "/status", "/collection", "/backend", "/api/apps/launch", "/api/apps/summary"]) {
    const result = await f.app.handle(new Request("https://" + "a".repeat(48) + ".example.net" + path, {method: "POST", headers: {host: "a".repeat(48) + ".example.net", [header]: "99"}}));
    expect(result.status).toBe(404);
    expect((await result.json()).api).toBeUndefined();
  }
});

it("gates viewer app routes the same way with or without app launch configured", async () => {
  for (const path of ["/api/apps/launch", "/api/apps/summary"]) {
    const results = [];
    for (const appLaunch of [undefined, {viewerOrigin: origin, appDomain: "example.net"}]) {
      const f = fixture({appLaunch});
      const response = await f.send(path, {method: "POST", headers: {[header]: "99"}});
      results.push({status: response.status, body: await response.json(), headers: [...response.headers]});
      expect((await f.app.handle(new Request("https://wrong.test" + path, {method: "POST", headers: {host: "wrong.test", [header]: "99"}}))).status).toBe(404);
    }
    expect(results[0]).toEqual(results[1]);
    expect(results[0]!.status).toBe(409);
  }
});

it("keeps discovery ungated and publishes route-specific versions", async () => {
  release(2, 2);
  const result = await fixture().send("/api/mcp", {headers: {[header]: "garbage"}});
  expect(result.status).toBe(200);
  expect(await result.json()).toMatchObject({api: "share-web", apiVersions: {min: 2, max: 2}, versionHeader: header, defaultVersion: 1, mcpApiVersions: {min: 1, max: 2}});
});

it("refuses to start unless it accepts the version its own MCP bridge sends", () => {
  build.accepted = {min: 2, max: 2};
  expect(() => fixture()).toThrow(TypeError);
});

it.each([undefined, "1", "2"])("keeps authorization, revocation and body/rate bounds under every accepted version %s", async version => {
  release(2, 1);
  const f = fixture();
  const headers = versionHeader(version);
  expect((await f.send("/api/view/meta", {headers})).status).toBe(404);
  const exchanged = await f.exchange(version);
  const {session} = await exchanged.json();
  const cookie = exchanged.headers.getSetCookie().map(value => value.split(";", 1)[0]).join("; ");
  const authorized = {...headers, cookie, "x-dohc-link-session": session};
  expect((await f.send("/api/view/meta", {headers: authorized})).status).toBe(200);
  expect((await f.send("/api/view/collection-writes", {method: "POST", headers: {...authorized, origin, "content-type": "application/json"}, body: "{}"})).status).toBe(404);
  expect(new URL(f.calls.at(-1)!.url).pathname).toBe("/sync/link/share");
  const {bearer} = await (await f.exchange(version, true)).json();
  expect((await f.mcp(bearer, version)).status).toBe(200);
  const calls = f.calls.length;
  const oversized = JSON.stringify({secret, padding: "x".repeat(8192)});
  for (let i = 0; i < 12; i++) expect((await f.send("/api/exchange", {method: "POST", headers: {...headers, "content-type": "application/json"}, body: oversized})).status).toBe(404);
  expect((await f.send("/api/exchange", {method: "POST", headers: {...headers, "content-type": "application/json"}, body: oversized})).status).toBe(429);
  expect(f.calls).toHaveLength(calls);
  f.revoke();
  expect((await f.send("/api/view/meta", {headers: authorized})).status).toBe(404);
  expect((await f.mcp(bearer, version)).status).toBe(404);
});

it("forwards only relay log keys and never interprets query versions", async () => {
  const f = fixture();
  const exchanged = await f.exchange();
  const {session} = await exchanged.json();
  const headers = {cookie: exchanged.headers.getSetCookie().map(value => value.split(";", 1)[0]).join("; "), "x-dohc-link-session": session};
  const result = await f.send("/api/view/log?since=7&limit=500&hold=0&current=true&session=" + session + "&apiVersion=99&other=secret", {headers});
  expect(result.status).toBe(200);
  expect(new URL(f.calls.at(-1)!.url).search).toBe("?since=7&limit=500&hold=0&current=true");
  for (const path of ["/api/mcp?apiVersion=1", "/mcp?apiVersion=1", "/api/mcp/exchange?apiVersion=1", "/api/account/session?apiVersion=1"]) {
    expect((await f.send(path, {method: path.includes("exchange") ? "POST" : "GET"})).status).toBe(404);
  }
});

it("returns the same public refusal with account routes enabled or disabled", async () => {
  const results = [];
  for (const config of [undefined, {publicOrigin: origin, upstreamUrl: "https://auth.test"}]) {
    const auth = vi.fn();
    const f = fixture({accountAuth: config, fetchAuth: auth});
    const response = await f.send("/api/account/session", {headers: {[header]: "99", origin: "https://hostile.test"}});
    results.push({status: response.status, body: await response.json(), headers: [...response.headers]});
    expect(auth).not.toHaveBeenCalled();
  }
  expect(results[0]).toEqual(results[1]);
});

// Production buffers every other body before `handle` runs (`streamBody` in main.ts).
it.each(["/mcp", "/api/view/collection-writes"])("does not consume a streamed %s body before refusing its wire version", async path => {
  let pulled = 0;
  const stream = new ReadableStream<Uint8Array>({pull() {pulled++;}}, {highWaterMark: 0});
  const f = fixture();
  const request = new Request(origin + path, {method: "POST", headers: {host, [header]: "99"}, body: stream, duplex: "half"} as RequestInit);
  expect((await f.app.handle(request)).status).toBe(409);
  expect(pulled).toBe(0);
  expect(f.calls).toHaveLength(0);
  await stream.cancel();
});

it("keeps headerless MCP working when a later build retires ordinary HTTP v1", async () => {
  release(2, 2);
  const f = fixture();
  const {bearer} = await (await f.exchange(undefined, true)).json();
  expect((await f.exchange()).status).toBe(409);
  const result = await f.mcp(bearer);
  expect(result.status).toBe(200);
  expect(await result.text()).toContain("dohc_list_files");
});

it("never forwards a client's version header to the relay or auth service", async () => {
  const authRequests: Request[] = [];
  release(2, 1);
  const f = fixture({accountAuth: {publicOrigin: origin, upstreamUrl: "https://auth.test"},
    fetchAuth: async request => {authRequests.push(request); return Response.json(null);}});
  expect((await f.exchange("2")).status).toBe(200);
  expect((await f.send("/api/account/session", {headers: {[header]: "2", "x-dohc-api-version": "99"}})).status).toBe(200);
  expect(authRequests).toHaveLength(1);
  for (const request of [...f.calls, ...authRequests]) expect(request.headers.has(header)).toBe(false);
  expect(f.calls[0]!.headers.get("x-dohc-api-version")).toBe("1");
  expect(authRequests[0]!.headers.has("x-dohc-api-version")).toBe(false);
});
