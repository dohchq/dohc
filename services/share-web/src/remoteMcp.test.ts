import {afterEach, expect, it, onTestFinished, vi} from "vitest";
import { createHash, randomBytes } from "node:crypto";
import {Client, StreamableHTTPClientTransport} from "@modelcontextprotocol/client";
import {MCP_FAILED_SIGN_IN_CAPACITY, createShareWebApplication} from "./server";
import {LINK_REFUSALS, linkRefusalBody} from "@dohc/security-contract/link-refusal";
import {asRecord} from "@dohc/workspace-core/records";

const origin = "https://share.example.test";
const secret = "A".repeat(43);
// The link's MCP address. The sign-in itself, against the real relay, is in mcpSignIn.test.ts.
const mcpPath = `/mcp/s/${secret}`, resource = origin + mcpPath;
const challenge = `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp/s/${secret}"`;
const clients: Client[] = [];
let servedLog: unknown;
afterEach(async () => {servedLog = logPage; await Promise.all(clients.splice(0).map(client => client.close()));});
const [first, second, withdrawn] = ["a".repeat(64), "b".repeat(64), "c".repeat(64)];
const moment = (relaySeq: number, payload: Record<string, unknown>) =>
  ({relaySeq, originSeq: relaySeq, opKind: "moment.append", recordedAtMs: relaySeq * 1000, payload: {versionId: "main", metadata: {origin: "sync"}, payloadBeforeBlobSha256: null, ...payload}});
const logPage = {ok: true, nextCursor: 12, hasMore: false, epochLogFloor: 3, ops: [
  {relaySeq: 7, originSeq: 7, opKind: "workspace.init", recordedAtMs: 7000, payload: {}},
  moment(8, {operation: "write", payloadAfterPath: "doc.md", payloadAfterBlobSha256: first}),
  moment(9, {operation: "write", payloadBeforePath: "doc.md", payloadBeforeBlobSha256: first, payloadAfterPath: "doc.md", payloadAfterBlobSha256: second}),
  moment(10, {operation: "rename", payloadBeforePath: "doc.md", payloadBeforeBlobSha256: second, payloadAfterPath: "plan.md", payloadAfterBlobSha256: second}),
  moment(11, {operation: "write", payloadAfterPath: "cat.png", payloadAfterBlobSha256: first, payloadAfterContentKind: "binary"}),
  moment(12, {operation: "delete", path: "plan.md", payloadBeforePath: "plan.md", payloadBeforeBlobSha256: second}),
]};
servedLog = logPage;

it.each(["view", "comment"] as const)("current-only %s agents cannot enumerate History", async access => {
  const f = fixture(access), client = await f.connect(f.token());
  expect((await client.listTools()).tools.map(tool => tool.name)).not.toContain("dohc_list_changes");
  await expect(client.callTool({name:"dohc_list_changes",arguments:{since:0}})).rejects.toThrow("not found");
  expect(f.calls.some(call=>new URL(call.url).pathname === "/sync/link/log")).toBe(false);
  expect((await client.callTool({name:"dohc_share_status",arguments:{}})).structuredContent).toMatchObject({summary:expect.stringContaining("History is unavailable")});
});

it("sends a client to sign in, and asks the relay again for each request with a revoked token", async () => {
  const f = fixture();
  const token = f.token();
  expect((await (await f.connect(token)).listTools()).tools.length).toBeGreaterThan(0);
  f.revoke();
  const snapshot = async (authorization?: string) => {
    const response = await f.send(mcpPath, {method: "POST",
      headers: {"content-type": "application/json", ...(authorization ? {authorization} : {})},
      body: JSON.stringify({jsonrpc: "2.0", id: 1, method: "tools/list"})});
    return {status: response.status, body: await response.text(), headers: Object.fromEntries(response.headers)};
  };
  const missing = await snapshot();
  expect(missing).toMatchObject({status: 401, body: "", headers: {"www-authenticate": challenge, "access-control-allow-origin": "*"}});
  // A malformed credential names no token, so it is invalid without asking the relay.
  const before = f.calls.length;
  expect((await snapshot("Bearer short")).headers["www-authenticate"]).toBe(`${challenge}, error="invalid_token"`);
  expect(f.calls).toHaveLength(before);
  const first = await snapshot(`Bearer ${token}`);
  const between = f.calls.length;
  const later = await snapshot(`Bearer ${token}`);
  expect(first).toMatchObject({status: 401, body: "", headers: {"www-authenticate": `${challenge}, error="invalid_token"`,
    "access-control-expose-headers": "WWW-Authenticate, Mcp-Session-Id"}});
  expect(later).toEqual(first);
  // share-web keeps no token, so the relay decides each time.
  expect(between).toBeGreaterThan(before);
  expect(f.calls.length - between).toBe(between - before);
});

function fixture(access: "view" | "comment" | "edit" = "comment", live = false, versionId: string | null = null, contentKind: "text" | "binary" = "text", paths: string[] = [], automationText?: string) {
  const calls: Request[] = [];
  // The access tokens the relay has issued for this link's address.
  const tokens = new Set<string>();
  let revoked = false;
  let rateLimited: string | undefined;
  let refusalCode: "link_read_rate_limited" | "link_unavailable" = "link_read_rate_limited";
  // The relay path whose next answer is lost after the relay made it.
  let lost: string | undefined;
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
      if (path === lost) {
        lost = undefined;
        throw new TypeError("connection reset");
      }
      if (path === "/sync/link-exchange") return Response.json({ok: true, grantId: "grant-a", capabilityToken: "B".repeat(43), capabilityExpiresAtMs: Date.now() + 900_000, access});
      // The relay's check: an issued token, sent to the address it was issued for, and no holder credential.
      const agent = /^DohcAgent (.+)$/u.exec(request.headers.get("authorization") ?? "")?.[1];
      if (revoked || !agent || !tokens.has(agent) || request.headers.get("x-dohc-agent-resource") !== resource ||
        request.headers.has("x-dohc-link-profile-secret") || request.headers.has("cookie") ||
        request.headers.get("x-dohc-relay-exchange-key") !== "exchange-key-at-least-thirty-two-bytes") return new Response(null, {status: 404});
      if (path === rateLimited) return Response.json(linkRefusalBody(refusalCode), {status: refusalCode === "link_read_rate_limited" ? 429 : 503});
      // As the relay does for an agent, the share answer names the link's grant.
      if (path === "/sync/link/share") return Response.json({ok: true, subjectName: "Trip", access, effectiveSelector: {versionId, paths, access}, lastSettledKnown: true, lastSettledAtMs: 123, grantId: "grant-a"});
      if (path === "/sync/link/current") return Response.json({ok: true, files: automationText !== undefined
        ? [{ path: "Tasks/automations.yaml", blobSha256: createHash("sha256").update(automationText).digest("hex"), contentKind, automationSwitchable: true }]
        : [{path: "doc.md", blobSha256: "a".repeat(64), contentKind}]});
      if (path === "/sync/link/log") return Response.json(servedLog);
      if (path === `/sync/link/blobs/${withdrawn}`) return new Response(null, {status: 404});
      if (path.startsWith("/sync/link/blobs/")) return new Response(automationText ?? "hello", {headers: {"content-type": "text/plain"}});
      if (path === "/sync/link/collection-writes") {
        const body = await request.json() as { submitId: string; changes: Array<{ afterPath: string }> };
        return Response.json({ ok: true, submitId: body.submitId, paths: body.changes.map(change => change.afterPath), committedAtMs: 1000, created: true });
      }
      if (path === "/sync/link/discussion") return Response.json({ok: true, ...(request.method === "POST" ? {body: await request.json()} : {limit: new URL(request.url).searchParams.get("limit")}), profile: request.headers.get("x-dohc-link-profile-secret")});
      if (path === "/sync/live/link-document") return new Response(null, {status: 404});
      // Not a Group share's link, so it has no channel.
      if (path === "/sync/link/chat/channels") return new Response(null, {status: 404});
      throw new Error(`Unexpected route: ${path}`);
    }});
  const send = (path: string, init: RequestInit = {}) => app.handle(new Request(origin + path, {...init, headers: {host: "share.example.test", ...init.headers}}));
  // An access token as the relay issues it at the end of the sign-in.
  function token() {
    const value = randomBytes(32).toString("base64url");
    tokens.add(value);
    return value;
  }
  async function connect(bearer: string, mode: "legacy" | "auto" = "auto", headers: Record<string, string> = {}) {
    const client = new Client({name: "test-agent", version: "1"}, {versionNegotiation: {mode}});
    clients.push(client);
    await client.connect(new StreamableHTTPClientTransport(new URL(resource), {
      requestInit: {headers: {...headers, authorization: `Bearer ${bearer}`}},
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
  return {calls, send, token, connect, revoke() {revoked = true;}, limit(path: string, code: typeof refusalCode = "link_read_rate_limited") {rateLimited = path;refusalCode = code;},
    lose(path: string) {lost = path;}};
}

it("tells an agent to try again when a files, changes, file or discussion answer is lost", async () => {
  const f = fixture("edit", true); const client = await f.connect(f.token());
  const again = {isError: true, content: [{type: "text", text: LINK_REFUSALS.link_unavailable.error}]};
  for (const [path, name, args] of [
    ["/sync/link/current", "dohc_list_files", {}],
    ["/sync/link/log", "dohc_list_changes", {}],
    [`/sync/link/blobs/${first}`, "dohc_read_file", {blobSha256: first}],
    ["/sync/link/discussion", "dohc_read_discussion", {}],
  ] as const) {
    f.lose(path);
    expect(await client.callTool({name, arguments: args}), name).toMatchObject(again);
    expect((await client.callTool({name, arguments: args})).isError, name).toBeFalsy();
  }
  // A post whose answer was lost may have landed, so the agent keeps its key.
  f.lose("/sync/link/discussion");
  expect(await client.callTool({name: "dohc_post_discussion", arguments: {body: "hello", idempotencyKey: "same-key"}})).toMatchObject({isError: true,
    structuredContent: {ok: false, code: "link_unavailable",
      error: "dohc could not confirm this post, so it may have posted. Send it again with the same idempotencyKey and fields; it posts only once."}});
});

it("refuses an out-of-scope blob before requesting rate-limited inventory", async () => {
  const f = fixture(); const client = await f.connect(f.token());
  f.limit("/sync/link/current");
  const before = f.calls.length;
  const result = await client.callTool({name: "dohc_read_file", arguments: {blobSha256: withdrawn}});
  expect(result).toMatchObject({isError: true, content: [{type: "text", text: "not found"}]});
  expect(f.calls.slice(before).map(call => new URL(call.url).pathname)).not.toContain("/sync/link/current");
});

it.each(["link_read_rate_limited", "link_unavailable"] as const)("returns the same %s metadata refusal for every MCP method", async code => {
  const f = fixture(); const bearer = f.token();
  f.limit("/sync/link/share", code);
  for (const method of ["initialize", "tools/list", "tools/call", "resources/list"]) {
    const response = await f.send(mcpPath, {method: "POST", headers: {authorization: `Bearer ${bearer}`, "content-type": "application/json"},
      body: JSON.stringify({jsonrpc: "2.0", id: 1, method, ...(method === "tools/call" ? {params: {name: "dohc_read_file", arguments: {blobSha256: withdrawn}}} : {})})});
    expect(response.status).toBe(code === "link_read_rate_limited" ? 429 : 503);
    expect(await response.json()).toEqual(linkRefusalBody(code));
  }
});

it.each(["legacy", "auto"] as const)("serves a real %s MCP client without transport sessions", async mode => {
  const f = fixture(); const client = await f.connect(f.token(), mode);
  expect((await client.listTools()).tools.map(tool => tool.name)).toEqual(expect.arrayContaining(["dohc_list_files", "dohc_post_discussion"]));
  expect((await client.listTools()).tools.some(tool => tool.name === "dohc_edit_document")).toBe(false);
  const result = await client.callTool({name: "dohc_list_files", arguments: {}});
  expect(result.structuredContent).toMatchObject({ok: true, files: [{path: "doc.md"}]});
});

it("sends each agent's own token and address to the relay, with no profile, and refuses a revoked one", async () => {
  const f = fixture(); const [a, b] = [f.token(), f.token()];
  const first = await f.connect(a), second = await f.connect(b);
  const tool = {name: "dohc_post_discussion", arguments: {body: "hello", idempotencyKey: "same-key"}};
  await first.callTool(tool); await second.callTool(tool);
  const posts = f.calls.filter(call => new URL(call.url).pathname === "/sync/link/discussion" && call.method === "POST");
  expect(posts.map(call => call.headers.get("authorization"))).toEqual([`DohcAgent ${a}`, `DohcAgent ${b}`]);
  expect(posts.map(call => [call.headers.get("x-dohc-agent-resource"), call.headers.has("x-dohc-link-profile-secret")]))
    .toEqual([[resource, false], [resource, false]]);
  f.revoke(); await expect(first.listTools()).rejects.toThrow();
});

it("takes the token only from the Authorization header, from any origin", async () => {
  const f = fixture(); const bearer = f.token();
  const cookie = await f.send(mcpPath, {headers: {cookie: "dohc_share_any=token"}});
  expect([cookie.status, cookie.headers.get("www-authenticate")]).toEqual([401, challenge]);
  expect((await f.send(`${mcpPath}?access_token=${bearer}`, {headers: {authorization: `Bearer ${bearer}`}})).status).toBe(404);
  // A browser MCP client calls from its own origin, with the token as its only credential.
  const client = await f.connect(bearer, "auto", {origin: "https://inspector.example.test"});
  expect((await client.callTool({name: "dohc_list_files", arguments: {}})).structuredContent).toMatchObject({ok: true});
});

it.each([
  ["view", false, null, false, false],
  ["comment", false, null, true, false],
  ["edit", true, null, true, true],
  ["edit", true, "pinned", true, false],
] as const)("advertises only the granted tools for %s with live=%s and version=%s", async (access, live, version, comment, edit) => {
  const f = fixture(access, live, version); const client = await f.connect(f.token());
  const names = (await client.listTools()).tools.map(tool => tool.name);
  expect(names.includes("dohc_post_discussion")).toBe(comment);
  expect(names.includes("dohc_edit_document")).toBe(edit);
  expect(names.includes("dohc_write_collection_files")).toBe(access === "edit" && version === null);
  expect(names).toContain("dohc_list_automations");
  expect(names.includes("dohc_switch_automation")).toBe(access === "edit" && version === null);
  if (edit) expect(await client.callTool({name: "dohc_edit_document", arguments: {path: "doc.md", find: "old", replacement: "new"}})).toMatchObject({isError: true, structuredContent: {ok: false, outcome: "not-applied"}});
});

it("remote agents read and switch through the same definition serializer and link route", async () => {
  const source = "version: 1\nautomations:\n  - id: stamp\n    name: Stamp\n    when: record-added\n    do:\n      - set:\n          Title: Ready\n        operation: records.edit\n";
  const f = fixture("edit", true, null, "text", ["Tasks"], source);
  const client = await f.connect(f.token());
  const hash = createHash("sha256").update(source).digest("hex");
  expect((await client.callTool({ name: "dohc_list_automations", arguments: { collectionPath: "Tasks" } })).structuredContent)
    .toMatchObject({ definitions: { canSwitch: true, contentHash: hash, file: { status: "read" } } });
  const inventory = f.calls.find(call => new URL(call.url).pathname === "/sync/link/current");
  expect(new URL(inventory!.url).searchParams.get("collectionPath")).toBe("Tasks");
  expect((await client.callTool({ name: "dohc_switch_automation", arguments: { collectionPath: "Tasks", automation: "stamp", enabled: false, expectedContentHash: hash, reformat: true, submitId: "switch-1" } })).structuredContent)
    .toMatchObject({ result: { status: "written", sync: "accepted" } });
  const request = f.calls.find(call => new URL(call.url).pathname === "/sync/link/collection-writes");
  expect([request?.headers.get("x-dohc-agent-resource"), request?.headers.has("x-dohc-link-profile-secret")]).toEqual([resource, false]);
});

it("an Edit-link agent creates one record through the same collection file operation", async () => {
  const f = fixture("edit", true, null, "text", ["Tasks"]);
  const client = await f.connect(f.token());
  const tools = await client.listTools();
  expect(tools.tools.find(tool => tool.name === "dohc_write_collection_files")?.description).toContain("one Markdown record");
  const args = { submitId: "create-record-1", files: [{ path: "Tasks/One.md", basedOnBlobSha256: null,
    text: "---\nid: rec_aaaaaaaaaaaaaaaaaaaaaaaaaa\n---\n" }] };
  expect((await client.callTool({ name: "dohc_write_collection_files", arguments: args })).structuredContent)
    .toEqual({ ok: true, outcome: "accepted", submitId: args.submitId });
  const request = f.calls.find(call => new URL(call.url).pathname === "/sync/link/collection-writes");
  expect(request?.headers.has("x-dohc-link-profile-secret")).toBe(false);
  expect(request?.headers.get("authorization")).toMatch(/^DohcAgent /);
});

it("does not turn a browser session token into an agent bearer", async () => {
  const f = fixture();
  const browser = await f.send("/api/exchange", {method: "POST", body: JSON.stringify({secret})});
  const {session} = await browser.json() as {session: string};
  const cookie = browser.headers.getSetCookie().find(value => value.startsWith(`dohc_share_${session}=`))!;
  const token = cookie.split(";", 1)[0]!.split("=")[1]!;
  for (const authorization of [`Bearer ${session}.${token}`, `Bearer ${token}`]) {
    const response = await f.send(mcpPath, {method: "POST", headers: {authorization, "content-type": "application/json"},
      body: JSON.stringify({jsonrpc: "2.0", id: 1, method: "tools/list"})});
    expect([response.status, response.headers.get("www-authenticate")]).toEqual([401, `${challenge}, error="invalid_token"`]);
  }
});

it("limits refused bearers by client address, and never spends for a valid one", async () => {
  // A stopped clock: the address's budget cannot refill while the test runs.
  vi.useFakeTimers({toFake: ["Date"]});
  onTestFinished(() => { vi.useRealTimers(); });
  const f = fixture(); const bearer = f.token();
  const send = (address: string, authorization: string) => f.send(mcpPath, {method: "POST", body: JSON.stringify({jsonrpc: "2.0", id: 1, method: "tools/list"}),
    headers: {authorization, "content-type": "application/json", accept: "application/json, text/event-stream", "x-dohc-share-web-client-ip": address}});
  // A valid bearer never spends from its address.
  for (let i = 0; i <= MCP_FAILED_SIGN_IN_CAPACITY; i++) expect((await send("192.0.2.1", `Bearer ${bearer}`)).status).toBe(200);
  // An unknown token and a malformed header each spend one, until the address waits.
  for (let i = 0; i < MCP_FAILED_SIGN_IN_CAPACITY; i++) {
    expect((await send("192.0.2.2", i % 2 ? "Bearer short" : `Bearer ${"D".repeat(43)}`)).status).toBe(401);
  }
  const relayCalls = f.calls.length;
  expect((await send("192.0.2.2", `Bearer ${"D".repeat(43)}`)).status).toBe(429);
  expect((await send("192.0.2.2", `Bearer ${bearer}`)).status).toBe(429);
  expect(f.calls.length).toBe(relayCalls);
  // A sign-in can still start from that address.
  const unsigned = await f.send(mcpPath, {method: "POST", body: JSON.stringify({jsonrpc: "2.0", id: 1, method: "tools/list"}),
    headers: {"content-type": "application/json", "x-dohc-share-web-client-ip": "192.0.2.2"}});
  expect([unsigned.status, unsigned.headers.get("www-authenticate")]).toEqual([401, challenge]);
  // Another address is not affected, and the scheme's case does not matter.
  expect((await send("192.0.2.3", `bearer ${bearer}`)).status).toBe(200);
});

it("rejects oversized and malformed MCP bodies without tool side effects", async () => {
  const f = fixture(); const bearer = f.token();
  const send = (body: string) => f.send(mcpPath, {method: "POST", headers: {authorization: `Bearer ${bearer}`, "content-type": "application/json"}, body});
  for (const body of ["{", JSON.stringify({data: "x".repeat(33 * 1024)})]) expect((await send(body)).status).toBe(404);
  expect(f.calls.some(call => new URL(call.url).pathname === "/sync/link/discussion")).toBe(false);
  expect((await (await f.connect(bearer)).listTools()).tools.length).toBeGreaterThan(0);
});

it("refuses subscriptions immediately and does not create legacy GET sessions", async () => {
  const f = fixture(); const bearer = f.token();
  const headers = {authorization: `Bearer ${bearer}`, "content-type": "application/json"};
  expect(await (await f.send(mcpPath, {method: "POST", headers, body: JSON.stringify({jsonrpc: "2.0", id: 1, method: "subscriptions/listen"})})).json()).toMatchObject({error: {code: -32601}});
  expect((await f.send(mcpPath, {headers})).status).toBe(405);
});

it("caps discussion pages at the relay limit before sending a request", async () => {
  const f = fixture(); const client = await f.connect(f.token());
  expect(await client.callTool({name: "dohc_read_discussion", arguments: {limit: 101}})).toMatchObject({isError: true});
  expect(f.calls.some(call => new URL(call.url).pathname === "/sync/link/discussion")).toBe(false);
  expect(await client.callTool({name: "dohc_read_discussion", arguments: {limit: 100}})).toMatchObject({structuredContent: {ok: true, limit: "100"}});
});

it("validates discussion inputs before forwarding invalid writes", async () => {
  const f = fixture(); const client = await f.connect(f.token());
  for (const args of [
    {body: "x".repeat(2001)},
    {body: "😀".repeat(2001)},
    {body: "\0"},
    {idempotencyKey: "k".repeat(65)},
    {idempotencyKey: "bad\nkey"},
  ]) {
    expect(await client.callTool({name: "dohc_post_discussion", arguments: {body: "hello", idempotencyKey: "key", ...args}})).toMatchObject({isError: true});
  }
  expect(f.calls.some(call => new URL(call.url).pathname === "/sync/link/discussion")).toBe(false);
  // The post carries no name: the relay shows the name the client reported when it signed in.
  const body = "😀".repeat(2000), idempotencyKey = "k".repeat(64);
  const posted = await client.callTool({name: "dohc_post_discussion", arguments: {body, idempotencyKey}});
  expect(asRecord(posted.structuredContent)?.body).toEqual({body, idempotencyKey});
  // The widest JSON a body can make still fits the envelope: 2,000 control characters escape to 12 KiB.
  const escaped = "\u0001".repeat(2000);
  const escapedPost = await client.callTool({name: "dohc_post_discussion", arguments: {body: escaped, idempotencyKey: "escaped"}});
  expect(asRecord(escapedPost.structuredContent)?.body).toEqual({body: escaped, idempotencyKey: "escaped"});
});

it.each(["text", "binary"] as const)("uses authoritative %s metadata for UTF-8-compatible file bytes", async contentKind => {
  const f = fixture("view", false, null, contentKind); const client = await f.connect(f.token());
  expect(await client.callTool({name: "dohc_read_file", arguments: {blobSha256: "a".repeat(64)}})).toMatchObject({
    structuredContent: {ok: true, encoding: contentKind === "binary" ? "base64" : "utf8", content: contentKind === "binary" ? Buffer.from("hello").toString("base64") : "hello"},
  });
});

it("lists the link log as changes through the browser's log route", async () => {
  const f = fixture("edit", true); const client = await f.connect(f.token());
  expect((await client.callTool({name: "dohc_list_changes", arguments: {since: 7, limit: 50}})).structuredContent).toEqual({ok: true, nextCursor: 12, hasMore: false, epochLogFloor: 3, changes: [
    {recordedAtMs: 8000, operation: "write", path: "doc.md", afterBlobSha256: first, contentKind: "text"},
    {recordedAtMs: 9000, operation: "write", path: "doc.md", afterBlobSha256: second, contentKind: "text", beforeBlobSha256: first},
    {recordedAtMs: 10000, operation: "rename", path: "plan.md", beforePath: "doc.md", afterBlobSha256: second, contentKind: "text", beforeBlobSha256: second},
    {recordedAtMs: 11000, operation: "write", path: "cat.png", afterBlobSha256: first, contentKind: "binary"},
    {recordedAtMs: 12000, operation: "delete", path: "plan.md", beforeBlobSha256: second},
  ]});
  const log = f.calls.filter(call => new URL(call.url).pathname === "/sync/link/log").map(call => new URL(call.url).search);
  expect(log).toEqual(["?since=7&limit=50"]);
  expect(await client.callTool({name: "dohc_list_changes", arguments: {limit: 501}})).toMatchObject({isError: true});
  expect(f.calls.filter(call => new URL(call.url).pathname === "/sync/link/log")).toHaveLength(1);
  expect(await client.callTool({name: "dohc_read_file", arguments: {blobSha256: second}})).toMatchObject({structuredContent: {ok: true, encoding: "utf8", content: "hello"}});
  expect(await client.callTool({name: "dohc_read_file", arguments: {blobSha256: withdrawn}})).toMatchObject({isError: true, content: [{text: "not found"}]});
  expect(f.calls.filter(call => new URL(call.url).pathname.startsWith("/sync/link/blobs/")).map(call => new URL(call.url).pathname)).toEqual([`/sync/link/blobs/${second}`, `/sync/link/blobs/${withdrawn}`]);
});

it("shows a pinned version's fork snapshot as one version change", async () => {
  servedLog = {ok: true, nextCursor: 5, hasMore: false, epochLogFloor: 0, ops: [{relaySeq: 5, originSeq: 5, opKind: "version.create", recordedAtMs: 5000,
    payload: {versionId: "v1", forkSnapshots: [{path: "doc.md", blobSha256: first}, {path: "cat.png", blobSha256: second, contentKind: "binary"}, {path: "empty.md"}]}}]};
  const f = fixture("edit", true, "v1"); const client = await f.connect(f.token());
  expect((await client.callTool({name: "dohc_list_changes", arguments: {}})).structuredContent).toEqual({ok: true, nextCursor: 5, hasMore: false, epochLogFloor: 0, changes: [
    {recordedAtMs: 5000, operation: "version", versionId: "v1", files: [
      {path: "doc.md", blobSha256: first, contentKind: "text"}, {path: "cat.png", blobSha256: second, contentKind: "binary"}, {path: "empty.md", contentKind: "text"},
    ]},
  ]});
});

it("returns an error and no changes for a malformed log page", async () => {
  servedLog = {...logPage, ops: [...logPage.ops, moment(13, {operation: "write", payloadAfterPath: "doc.md", payloadAfterBlobSha256: "not-a-hash"})]};
  const f = fixture("edit", true); const client = await f.connect(f.token());
  const result = await client.callTool({name: "dohc_list_changes", arguments: {}});
  expect(result).toMatchObject({isError: true});
  expect(result.structuredContent).toBeUndefined();
});

it("refuses the log after the link is revoked", async () => {
  const f = fixture("edit", true); const client = await f.connect(f.token());
  f.revoke();
  await expect(client.callTool({name: "dohc_list_changes", arguments: {}})).rejects.toThrow();
  expect(f.calls.some(call => new URL(call.url).pathname === "/sync/link/log")).toBe(false);
});

it.each([
  ["view", false, null],
  ["comment", false, null],
  ["edit", true, null],
  ["edit", true, "pinned"],
] as const)("summarizes link status for %s, live=%s, version=%s without losing metadata", async (access, live, versionId) => {
  const f = fixture(access, live, versionId, "text", ["docs", "plan.md"]);
  const client = await f.connect(f.token());
  const result = await client.callTool({name: "dohc_share_status", arguments: {}});
  expect(result.structuredContent).toMatchObject({ok: true, access,
    effectiveSelector: {versionId, paths: ["docs", "plan.md"], access}, lastSettledKnown: true, lastSettledAtMs: 123});
  const summary = asRecord(result.structuredContent)?.summary;
  expect(summary).toEqual(expect.any(String));
  expect(summary).toContain("Trip");
  expect(asRecord(result.structuredContent)).not.toHaveProperty("sharerName");
  // share-web keeps the grant the relay named for its own limits.
  expect(asRecord(result.structuredContent)).not.toHaveProperty("grantId");
  expect(summary).toContain(access === "view" ? "You can read files and comments." :
    access === "comment" ? "You can read files and post comments." : "This link grants read, comment, and edit access.");
  expect(summary).toContain("Included paths: docs, plan.md.");
  expect(summary).toContain("this share's comments");
  expect(summary).toContain(access === "edit" ? "retained History of files that remain in this share" : "History is unavailable with view or comment access.");
  if (access !== "edit") expect(summary).toContain(access === "view" ? "does not let you comment or edit" : "does not let you edit files");
  if (versionId !== null) {
    expect(summary).toContain("pinned version");
    expect(summary).toContain("Editing is unavailable on this link.");
  } else if (access === "edit") {
    expect(summary).toContain("Editing pauses while the workspace is offline");
    expect(summary).toContain("You can change a Collection's collection.yaml and automations.yaml here.");
  }
  expect(result.content).toContainEqual({type: "text", text: JSON.stringify(result.structuredContent)});
  expect(f.calls.every(call => ["/sync/link/share", "/sync/link/chat/channels"].includes(new URL(call.url).pathname))).toBe(true);
});

it("describes an unfiltered link without claiming access to private workspace data", async () => {
  const f = fixture("view"); const client = await f.connect(f.token());
  const result = await client.callTool({name: "dohc_share_status", arguments: {}});
  expect(asRecord(result.structuredContent)?.summary).toContain("Included: shareable workspace files and this share's comments.");
});
