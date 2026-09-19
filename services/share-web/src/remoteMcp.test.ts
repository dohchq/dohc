import {afterEach, expect, it} from "vitest";
import {Client, StreamableHTTPClientTransport} from "@modelcontextprotocol/client";
import {createShareWebApplication} from "./server";

const origin = "https://share.example.test";
const secret = "A".repeat(43);
const clients: Client[] = [];
afterEach(async () => {await Promise.all(clients.splice(0).map(client => client.close()));});
function fixture(access: "view" | "comment" | "edit" = "comment", live = false, versionId: string | null = null) {
  const calls: Request[] = [];
  let revoked = false;
  const app = createShareWebApplication({relayUrl: "https://relay.example.test", publicRelayUrl: "https://relay.example.test",
    relayExchangeKey: "exchange-key-at-least-thirty-two-bytes", publicHosts: new Set(["share.example.test"]),
    ...(live ? {publicEditRelease: {version: 1 as const}, linkLive: {publicOrigin: origin,
      requests: {maxPendingRequests: 4, maxRequestBytes: 2048, maxResponseBytes: 8192, timeoutMs: 1000},
      editor: {provider: {frames: {receive: {maxFrameBytes: 1024, maxStateVectorBytes: 4096, maxUpdateBytes: 8192, maxSyncBytes: 16384},
        maxQueuedBytes: 16384, maxQueuedFrames: 64, maxControlBytes: 4096, maxControlFrames: 8, maxAssemblyBytes: 16384},
        maxPendingUpdateBytes: 16384, maxPendingUpdates: 8, maxDeliveryAttempts: 4},
        maxHttpResponseBytes: 16384, maxSocketBufferedBytes: 16384, connectTimeoutMs: 2000, sendTimeoutMs: 500, drainPollMs: 10}}} : {}),
    async fetchRelay(request) {
      calls.push(request);
      const path = new URL(request.url).pathname;
      if (path === "/sync/link-exchange") return Response.json({ok: true, grantId: "grant-a", capabilityToken: "B".repeat(43), capabilityExpiresAtMs: Date.now() + 900_000, access});
      if (revoked) return new Response(null, {status: 401});
      if (path === "/sync/link/share") return Response.json({ok: true, access, effectiveSelector: {versionId}});
      if (path === "/sync/link/current") return Response.json({ok: true, files: [{path: "doc.md", blobSha256: "a".repeat(64)}]});
      if (path.startsWith("/sync/link/blobs/")) return new Response("hello", {headers: {"content-type": "text/plain"}});
      if (path === "/sync/link/discussion") return Response.json({ok: true, body: await request.json(), profile: request.headers.get("x-dohc-link-profile-secret")});
      if (path === "/sync/live/link-document") return new Response(null, {status: 404});
      throw new Error(`Unexpected route: ${path}`);
    }});
  const send = (path: string, init: RequestInit = {}) => app.handle(new Request(origin + path, {...init, headers: {host: "share.example.test", ...init.headers}}));
  async function exchange() {
    const response = await send("/api/mcp/exchange", {method: "POST", headers: {"content-type": "application/json"}, body: JSON.stringify({secret})});
    expect(response.headers.has("set-cookie")).toBe(false);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    return (await response.json() as {bearer: string}).bearer;
  }
  async function connect(bearer: string, mode: "legacy" | "auto" = "auto") {
    const client = new Client({name: "test-agent", version: "1"}, {versionNegotiation: {mode}});
    clients.push(client);
    await client.connect(new StreamableHTTPClientTransport(new URL(origin + "/mcp"), {
      requestInit: {headers: {authorization: `Bearer ${bearer}`}},
      fetch: async (input, init) => {
        const request = new Request(input, init); request.headers.set("host", "share.example.test");
        const result = await app.handle(request);
        expect(result.headers.has("mcp-session-id")).toBe(false);
        expect(result.headers.has("set-cookie")).toBe(false);
        return result;
      },
    }));
    return client;
  }
  return {calls, send, exchange, connect, revoke() {revoked = true;}};
}

it.each(["legacy", "auto"] as const)("serves a real %s MCP client without transport sessions", async mode => {
  const f = fixture(); const client = await f.connect(await f.exchange(), mode);
  expect((await client.listTools()).tools.map(tool => tool.name)).toEqual(expect.arrayContaining(["dohc_list_files", "dohc_post_discussion"]));
  expect((await client.listTools()).tools.some(tool => tool.name === "dohc_edit_document")).toBe(false);
  const result = await client.callTool({name: "dohc_list_files", arguments: {}});
  expect(result.structuredContent).toMatchObject({ok: true, files: [{path: "doc.md"}]});
});

it("assigns independent agent profiles and rejects revoked bearers", async () => {
  const f = fixture(); const first = await f.connect(await f.exchange()), second = await f.connect(await f.exchange());
  const tool = {name: "dohc_post_discussion", arguments: {body: "hello", idempotencyKey: "same-key"}};
  await first.callTool(tool); await first.callTool(tool); await second.callTool(tool);
  const profiles = f.calls.filter(call => new URL(call.url).pathname === "/sync/link/discussion").map(call => call.headers.get("x-dohc-link-profile-secret"));
  expect(profiles[0]).toBe(profiles[1]); expect(profiles[2]).not.toBe(profiles[0]);
  f.revoke(); await expect(first.listTools()).rejects.toThrow();
});

it("rejects browser cookies, foreign origins, and query credentials", async () => {
  const f = fixture(); const bearer = await f.exchange();
  expect((await f.send("/mcp", {headers: {cookie: "dohc_share_any=token"}})).status).toBe(401);
  expect((await f.send("/mcp?bearer=" + bearer, {headers: {authorization: `Bearer ${bearer}`}})).status).toBe(404);
  expect((await f.send("/mcp", {headers: {authorization: `Bearer ${bearer}`, origin: "https://evil.test"}})).status).toBe(404);
});

it.each([
  ["view", false, null, false, false],
  ["comment", false, null, true, false],
  ["edit", true, null, true, true],
  ["edit", true, "pinned", true, false],
] as const)("advertises only the granted tools for %s with live=%s and version=%s", async (access, live, version, comment, edit) => {
  const f = fixture(access, live, version); const client = await f.connect(await f.exchange());
  const names = (await client.listTools()).tools.map(tool => tool.name);
  expect(names.includes("dohc_post_discussion")).toBe(comment);
  expect(names.includes("dohc_edit_document")).toBe(edit);
  if (edit) expect(await client.callTool({name: "dohc_edit_document", arguments: {path: "doc.md", find: "old", replacement: "new"}})).toMatchObject({isError: true, structuredContent: {ok: false, outcome: "not-applied"}});
});

it("keeps Public Edit disabled without the release marker", async () => {
  const f = fixture("edit");
  const result = await f.send("/api/mcp/exchange", {method: "POST", body: JSON.stringify({secret})});
  expect(result.status).toBe(404);
});

it("does not turn a browser session token into an agent bearer", async () => {
  const f = fixture();
  const browser = await f.send("/api/exchange", {method: "POST", body: JSON.stringify({secret})});
  const {session} = await browser.json() as {session: string};
  const cookie = browser.headers.getSetCookie().find(value => value.startsWith(`dohc_share_${session}=`))!;
  const token = cookie.split(";", 1)[0]!.split("=")[1]!;
  expect((await f.send("/mcp", {headers: {authorization: `Bearer ${session}.${token}`}})).status).toBe(401);
});

it("rejects oversized and malformed MCP bodies without tool side effects", async () => {
  const f = fixture(); const bearer = await f.exchange();
  for (const body of ["{", JSON.stringify({data: "x".repeat(33 * 1024)})]) {
    expect((await f.send("/mcp", {method: "POST", headers: {authorization: `Bearer ${bearer}`, "content-type": "application/json"}, body})).status).toBe(404);
  }
  expect(f.calls.some(call => new URL(call.url).pathname === "/sync/link/discussion")).toBe(false);
});

it("refuses subscriptions immediately and does not create legacy GET sessions", async () => {
  const f = fixture(); const bearer = await f.exchange();
  const headers = {authorization: `Bearer ${bearer}`, "content-type": "application/json"};
  expect(await (await f.send("/mcp", {method: "POST", headers, body: JSON.stringify({jsonrpc: "2.0", id: 1, method: "subscriptions/listen"})})).json()).toMatchObject({error: {code: -32601}});
  expect((await f.send("/mcp", {headers})).status).toBe(405);
});
