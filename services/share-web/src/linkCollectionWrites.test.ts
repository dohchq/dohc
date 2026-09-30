import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { createSyncRelayHandler } from "@dohc/sync-relay";
import { openSyncRelayStorage, type SyncRelayStorage } from "@dohc/sync-relay/storage";
import { afterEach, expect, it } from "vitest";
import { collectionWriteBody, COLLECTION_WRITES_PATH, parseCollectionWriteOutcome, type CollectionFileWrite } from "./collectionWrites";
import { createShareWebApplication } from "./server";

// An Edit share link changes a Collection's own files through the real
// share-web and the real relay (ADR 0013): a person in a browser through the
// viewer's route, and their agent through the remote MCP. Neither has an
// account. Each write names the link as its author, and revoking the link
// refuses both.

const ORIGIN = "https://share.example.test";
const HOST = "share.example.test";
const EXCHANGE_KEY = "link-writes-relay-exchange-key-at-least-32";
const WORKSPACE = "workspace-links";
const OWNER = { authorization: "Bearer user:owner", "content-type": "application/json" };
const SCHEMA_PATH = "trip/packing/collection.yaml";
const AUTOMATIONS_PATH = "trip/packing/automations.yaml";
const SCHEMA = "name: Packing\nfields:\n  Title:\n    type: text\n";
const SCHEMA_TWO = "name: Packing\nfields:\n  Title:\n    type: text\n  Count:\n    type: number\n";
const AUTOMATIONS = "version: 1\nautomations:\n  - id: stamp\n    name: Stamp\n    when: record-added\n    do:\n      - set:\n          Title: Packed\n";
const AUTOMATIONS_TWO = AUTOMATIONS.replace("Packed", "Packed twice");
const ACCOUNT_COOKIE = "__Secure-better-auth.session_token=signed-in-person";
const liveLimits = {
  requests: { maxPendingRequests: 4, maxRequestBytes: 2048, maxResponseBytes: 8192, timeoutMs: 1000 },
  editor: { provider: { frames: { receive: { maxFrameBytes: 1024, maxStateVectorBytes: 4096, maxUpdateBytes: 8192, maxSyncBytes: 16384 },
    maxQueuedBytes: 16384, maxQueuedFrames: 64, maxControlBytes: 4096, maxControlFrames: 8, maxAssemblyBytes: 16384 },
    maxPendingUpdateBytes: 16384, maxPendingUpdates: 8, maxDeliveryAttempts: 4 },
    maxHttpResponseBytes: 16384, maxSocketBufferedBytes: 16384, connectTimeoutMs: 2000, sendTimeoutMs: 500, drainPollMs: 10 },
};

const roots: string[] = [];
const storages: SyncRelayStorage[] = [];
const clients: Client[] = [];
afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
  for (const storage of storages.splice(0)) storage.close();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

async function stack(access: "view" | "edit" = "edit") {
  const root = await mkdtemp(join(tmpdir(), "dohc-link-writes-"));
  roots.push(root);
  const storage = openSyncRelayStorage(join(root, "relay.sqlite"));
  storages.push(storage);
  let id = 0;
  const relayCalls: Request[] = [];
  const relay = createSyncRelayHandler({
    storage,
    resolveActor(request, workspaceId) {
      const match = /^Bearer user:([^ ]+)$/u.exec(request.headers.get("authorization") ?? "");
      if (!match) throw Object.assign(new Error("unauthorized"), { statusCode: 401 });
      return { userId: match[1]!, workspaceId };
    },
    lookupUserEmail: (userId) => `${userId}@example.test`,
    newShareId: () => "share-links",
    newGrantId: () => `grant-${id++}`,
    newId: () => `id-${id++}`,
    linkKey: "link-writes-link-key-with-at-least-thirty-two-bytes",
    shareWebOrigin: ORIGIN,
    relayExchangeKey: EXCHANGE_KEY,
    publicEditRelease: { version: 1 },
    namedBrowserSessionLimits: { maxSessions: 8, retentionMs: 60_000, maxPendingRequests: 4, maxRequestBytes: 8192, maxResponseBytes: 16384, timeoutMs: 1000 },
  });
  const owner = (path: string, init: RequestInit = {}) =>
    relay(new Request(`https://relay.example.test${path}`, { ...init, headers: { ...OWNER, ...init.headers } }));
  expect((await owner("/sync/workspaces", { method: "POST", body: JSON.stringify({ workspaceId: WORKSPACE }) })).status).toBe(200);
  const files = [[SCHEMA_PATH, SCHEMA], [AUTOMATIONS_PATH, AUTOMATIONS]] as const;
  for (const [, text] of files) {
    expect((await owner(`/sync/${WORKSPACE}/blobs/${sha256(text)}`, { method: "PUT", body: text })).status).toBe(200);
  }
  expect((await owner(`/sync/${WORKSPACE}/log`, { method: "POST", body: JSON.stringify({
    originId: "owner-origin",
    ops: files.map(([path, text], index) => ({ originSeq: index, opKind: "moment.append", recordedAtMs: 1_000 + index, payload: {
      momentId: `owner-moment-${index}`, versionId: "main", objectId: `owner-object-${index}`, path, recordedAtMs: 1_000 + index,
      operation: "write", payloadBeforeBlobSha256: null, payloadBeforePath: null, payloadAfterBlobSha256: sha256(text),
      payloadAfterPath: path, metadata: { origin: "user" }, beforePresent: "null",
    } })),
  }) })).status).toBe(200);
  const created = await owner(`/sync/${WORKSPACE}/shares/links`, { method: "POST", body: JSON.stringify({ paths: ["trip"], access }) });
  expect(created.status).toBe(200);
  const link = await created.json() as { url: string; grantId: string; shareId: string };

  const app = createShareWebApplication({
    relayUrl: "https://relay.example.test", publicRelayUrl: "https://relay.example.test", relayExchangeKey: EXCHANGE_KEY,
    publicHosts: new Set([HOST]), publicEditRelease: { version: 1 }, linkLive: { publicOrigin: ORIGIN, ...liveLimits },
    fetchRelay: (request) => {
      relayCalls.push(request.clone());
      return relay(request);
    },
  });
  const send = (path: string, init: RequestInit = {}) => {
    const headers = new Headers(init.headers);
    headers.set("host", HOST);
    return app.handle(new Request(ORIGIN + path, { ...init, headers }));
  };
  const secret = new URL(link.url).hash.slice(1);
  return { owner, link, secret, send, handle: app.handle, relayCalls };
}

type Stack = Awaited<ReturnType<typeof stack>>;

/** A person opening the link in a browser that is also signed in to a dohc account. */
async function browser(s: Stack) {
  const exchanged = await s.send("/api/exchange", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ secret: s.secret }) });
  expect(exchanged.status).toBe(200);
  const { session } = await exchanged.json() as { session: string };
  const cookies = exchanged.headers.getSetCookie().map((value) => value.split(";", 1)[0]!);
  const headers = { origin: ORIGIN, "sec-fetch-site": "same-origin", "content-type": "application/json", "x-dohc-link-session": session,
    cookie: [...cookies, ACCOUNT_COOKIE].join("; ") };
  /** The viewer's request, with any header replaced or, when null, left out. */
  const post = (body: BodyInit, changed: Record<string, string | null> = {}, path = COLLECTION_WRITES_PATH) => {
    const sent = new Headers(headers);
    for (const [name, value] of Object.entries(changed)) {
      if (value === null) sent.delete(name); else sent.set(name, value);
    }
    return s.send(path, { method: "POST", headers: sent, body, ...(body instanceof ReadableStream ? { duplex: "half" } : {}) } as RequestInit);
  };
  const write = async (submitId: string, files: CollectionFileWrite[]) => {
    const response = await post(collectionWriteBody(submitId, files, Date.now()));
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    return parseCollectionWriteOutcome(response.status, await response.json());
  };
  return { session, cookies, post, write };
}

/** An agent given only the link. */
async function agent(s: Stack): Promise<Client> {
  const exchanged = await s.send("/api/mcp/exchange", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ secret: s.secret }) });
  const { bearer } = await exchanged.json() as { bearer: string };
  const client = new Client({ name: "link-agent", version: "1" });
  clients.push(client);
  await client.connect(new StreamableHTTPClientTransport(new URL(ORIGIN + "/mcp"), {
    requestInit: { headers: { authorization: `Bearer ${bearer}` } },
    fetch: (input, init) => {
      const request = new Request(input, init);
      request.headers.set("host", HOST);
      return s.handle(request);
    },
  }));
  return client;
}

type Moment = { originId: string; payload: { path?: string; authors?: Record<string, unknown>[] } };

async function directMoments(s: Stack): Promise<Moment[]> {
  const log = await (await s.owner(`/sync/${WORKSPACE}/log?since=0&limit=1000`)).json() as { ops: Moment[] };
  return log.ops.filter((op) => op.originId.startsWith("relay:collection-file:"));
}

it("lets a browser and an agent holding only an Edit link change a Collection, each as the link, until it is revoked", async () => {
  const s = await stack();
  const { write } = await browser(s);
  const mcp = await agent(s);

  // The browser edits the schema; its account cookie never reaches the relay.
  expect(await write("browser-1", [{ path: SCHEMA_PATH, basedOnBlobSha256: sha256(SCHEMA), text: SCHEMA_TWO }]))
    .toEqual({ ok: true, outcome: "accepted", submitId: "browser-1" });
  // The agent finds the tool from the link alone, and replaces the automations.
  expect((await mcp.listTools()).tools.map((tool) => tool.name)).toContain("dohc_write_collection_files");
  const listed = (await mcp.callTool({ name: "dohc_list_files", arguments: {} })).structuredContent as { files: Array<{ path: string; blobSha256: string }> };
  const automations = listed.files.find((file) => file.path === AUTOMATIONS_PATH)!;
  expect((await mcp.callTool({ name: "dohc_write_collection_files", arguments: {
    submitId: "agent-1", files: [{ path: AUTOMATIONS_PATH, basedOnBlobSha256: automations.blobSha256, text: AUTOMATIONS_TWO }],
  } })).structuredContent).toEqual({ ok: true, outcome: "accepted", submitId: "agent-1" });
  // And creates a Collection beside it, with a record.
  expect((await mcp.callTool({ name: "dohc_write_collection_files", arguments: { submitId: "agent-2", files: [
    { path: "trip/gear/collection.yaml", basedOnBlobSha256: null, text: SCHEMA.replace("Packing", "Gear") },
    { path: "trip/gear/tent.md", basedOnBlobSha256: null, text: "---\nTitle: Tent\n---\n" },
  ] } })).structuredContent).toMatchObject({ ok: true, outcome: "accepted", submitId: "agent-2" });

  // Each write names the link, with a principal of its own for the browser
  // and the agent, and no person. No credential reaches the owner's log.
  const moments = await directMoments(s);
  expect(moments.map((moment) => moment.payload.path)).toEqual([SCHEMA_PATH, AUTOMATIONS_PATH, "trip/gear/collection.yaml", "trip/gear/tent.md"]);
  for (const moment of moments) {
    expect(moment.originId).toBe(`relay:collection-file:${s.link.grantId}`);
    expect(moment.payload.authors?.[0]).toEqual({ kind: "link", grantId: s.link.grantId, grantGeneration: 1, principalId: expect.any(String) });
  }
  expect(moments[0]!.payload.authors?.[0]!.principalId).not.toBe(moments[1]!.payload.authors?.[0]!.principalId);
  expect(moments[1]!.payload.authors?.[0]!.principalId).toBe(moments[2]!.payload.authors?.[0]!.principalId);
  expect(JSON.stringify(moments)).not.toContain(s.secret);
  // Share-web forwards the capability and the profile, and nothing of the browser's own.
  const writes = s.relayCalls.filter((call) => new URL(call.url).pathname === "/sync/link/collection-writes");
  expect(writes).toHaveLength(3);
  for (const call of writes) {
    expect(call.headers.get("authorization")).toMatch(/^LinkCapability [A-Za-z0-9_-]{43}$/u);
    expect(call.headers.get("x-dohc-link-profile-secret")).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(call.headers.has("cookie")).toBe(false);
    expect(call.headers.has("origin")).toBe(false);
  }

  // A write based on the schema the browser already replaced keeps its text
  // with the writer and names the current file.
  expect(await write("browser-2", [{ path: SCHEMA_PATH, basedOnBlobSha256: sha256(SCHEMA), text: `${SCHEMA}# mine\n` }]))
    .toEqual({ ok: false, outcome: "stale", path: SCHEMA_PATH, currentBlobSha256: sha256(SCHEMA_TWO) });
  // A retry whose answer was lost returns the same receipt without another write.
  expect(await write("browser-1", [{ path: SCHEMA_PATH, basedOnBlobSha256: sha256(SCHEMA), text: SCHEMA_TWO }]))
    .toEqual({ ok: true, outcome: "accepted", submitId: "browser-1" });
  expect(await directMoments(s)).toHaveLength(4);

  // The owner revokes the link: both are refused, and the owner keeps the ledger.
  const revoked = await s.owner(`/sync/shares/${s.link.shareId}/revoke`, { method: "POST",
    body: JSON.stringify({ workspaceId: WORKSPACE, grantId: s.link.grantId, expectedDependentGrantIds: [] }) });
  expect(revoked.status).toBe(200);
  expect(await write("browser-3", [{ path: SCHEMA_PATH, basedOnBlobSha256: sha256(SCHEMA_TWO), text: SCHEMA }]))
    .toEqual({ ok: false, outcome: "unavailable" });
  await expect(mcp.callTool({ name: "dohc_write_collection_files", arguments: {
    submitId: "agent-3", files: [{ path: AUTOMATIONS_PATH, basedOnBlobSha256: sha256(AUTOMATIONS_TWO), text: AUTOMATIONS }],
  } })).rejects.toThrow();
  expect(await directMoments(s)).toHaveLength(4);
  const ledger = await (await s.owner(`/sync/${WORKSPACE}/collection-writes/${s.link.grantId}`)).json() as { writes: Array<{ submitId: string }> };
  expect(ledger.writes.map((entry) => entry.submitId)).toEqual(["browser-1", "agent-1", "agent-2"]);
});

function writes(s: Stack): number {
  return s.relayCalls.filter((call) => new URL(call.url).pathname === "/sync/link/collection-writes").length;
}

it("takes a write only from the viewer page or this server's agent tools, never another site, an app, or a forged agent", async () => {
  const s = await stack();
  const b = await browser(s);
  const body = collectionWriteBody("forged", [{ path: SCHEMA_PATH, basedOnBlobSha256: sha256(SCHEMA), text: SCHEMA_TWO }], 1);
  const refusedRequests: Array<Promise<Response>> = [
    // A published app runs on its own origin, never the viewer's.
    b.post(body, { origin: "https://trip-app.apps.example.test" }),
    b.post(body, { origin: null }),
    b.post(body, { "sec-fetch-site": "same-site" }),
    b.post(body, { "sec-fetch-site": "cross-site" }),
    b.post(body, { "x-dohc-link-session": null }),
    b.post(body, { "content-type": "text/plain" }),
    b.post(body, { cookie: b.cookies.filter((cookie) => !cookie.startsWith("dohc_share_profile_")).join("; ") }),
    b.post(body, {}, `${COLLECTION_WRITES_PATH}?session=${b.session}`),
    // Who writes is never the request's to say.
    b.post(JSON.stringify({ ...JSON.parse(body) as object, author: { kind: "named", userId: "owner" } })),
    s.send(COLLECTION_WRITES_PATH, { headers: { origin: ORIGIN, "x-dohc-link-session": b.session, cookie: b.cookies.join("; ") } }),
  ];
  // An agent's bearer, sent as a browser's cookie with a profile the caller chose.
  const exchanged = await s.send("/api/mcp/exchange", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ secret: s.secret }) });
  const [discriminator, token] = ((await exchanged.json()) as { bearer: string }).bearer.split(".") as [string, string];
  refusedRequests.push(s.send(COLLECTION_WRITES_PATH, { method: "POST", body, headers: {
    origin: ORIGIN, "content-type": "application/json", "x-dohc-link-session": discriminator,
    cookie: `dohc_share_${discriminator}=${token}; dohc_share_profile_${discriminator}=${"P".repeat(43)}`,
  } }));
  for (const response of await Promise.all(refusedRequests)) {
    expect(response.status).toBe(404);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
  }
  expect(writes(s)).toBe(0);
  expect(await directMoments(s)).toEqual([]);
});

it("refuses a View link's browser and agent before reading a body or reaching the relay", async () => {
  const s = await stack("view");
  const b = await browser(s);
  // The body never finishes, and the refusal does not wait for it.
  const unread = await b.post(new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new TextEncoder().encode("{")); } }));
  expect(parseCollectionWriteOutcome(unread.status, null)).toEqual({ ok: false, outcome: "unavailable" });
  expect(await b.write("view-1", [{ path: SCHEMA_PATH, basedOnBlobSha256: sha256(SCHEMA), text: SCHEMA_TWO }])).toEqual({ ok: false, outcome: "unavailable" });
  expect(writes(s)).toBe(0);
  const mcp = await agent(s);
  expect((await mcp.listTools()).tools.map((tool) => tool.name)).not.toContain("dohc_write_collection_files");
  expect(await directMoments(s)).toEqual([]);
});

it("gives a refused write its reason, and holds one write body per link at a time", async () => {
  const s = await stack();
  const b = await browser(s);
  expect(await b.write("invalid", [{ path: SCHEMA_PATH, basedOnBlobSha256: sha256(SCHEMA), text: "fields: [" }]))
    .toEqual({ ok: false, outcome: "refused", reason: expect.stringContaining(`${SCHEMA_PATH} is not a valid collection.yaml`) });

  const body = collectionWriteBody("held", [{ path: SCHEMA_PATH, basedOnBlobSha256: sha256(SCHEMA), text: SCHEMA_TWO }], 1);
  let finish!: () => void;
  const held = b.post(new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(body.slice(0, 10)));
      finish = () => {
        controller.enqueue(new TextEncoder().encode(body.slice(10)));
        controller.close();
      };
    },
  }));
  // The first body is still arriving, so the link's next write waits its turn.
  await expect.poll(async () => parseCollectionWriteOutcome((await b.post(body)).status, null)).toEqual({ ok: false, outcome: "rate-limited" });
  finish();
  const first = await held;
  expect(parseCollectionWriteOutcome(first.status, await first.json())).toEqual({ ok: true, outcome: "accepted", submitId: "held" });
});

it("carries an agent's write larger than an ordinary MCP request, one such body per link at a time", async () => {
  const s = await stack();
  const mcp = await agent(s);
  const record = `---\nTitle: Long\n---\n${"packing list line\n".repeat(12_000)}`;
  expect((await mcp.callTool({ name: "dohc_write_collection_files", arguments: { submitId: "large", files: [
    { path: "trip/long/collection.yaml", basedOnBlobSha256: null, text: SCHEMA },
    { path: "trip/long/list.md", basedOnBlobSha256: null, text: record },
  ] } })).structuredContent).toEqual({ ok: true, outcome: "accepted", submitId: "large" });

  const exchanged = await s.send("/api/mcp/exchange", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ secret: s.secret }) });
  const { bearer } = await exchanged.json() as { bearer: string };
  const headers = { authorization: `Bearer ${bearer}`, "content-type": "application/json", accept: "application/json, text/event-stream" };
  let finish!: () => void;
  // A body past an ordinary request's size takes the link's one large slot while it arrives.
  const held = s.send("/mcp", { method: "POST", headers, duplex: "half", body: new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(`{"params":{"padding":"${"x".repeat(40 * 1024)}"},`));
      finish = () => {
        controller.enqueue(new TextEncoder().encode(`"jsonrpc":"2.0","id":1,"method":"tools/list"}`));
        controller.close();
      };
    },
  }) } as RequestInit);
  const large = JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: { padding: "x".repeat(40 * 1024) } });
  await expect.poll(async () => (await s.send("/mcp", { method: "POST", headers, body: large })).status).toBe(429);
  // So does the browser's write for the same link: large bodies share one pool.
  const b = await browser(s);
  expect(await b.write("browser-while-held", [{ path: SCHEMA_PATH, basedOnBlobSha256: sha256(SCHEMA), text: SCHEMA_TWO }]))
    .toEqual({ ok: false, outcome: "rate-limited" });
  // An ordinary request still goes through meanwhile.
  expect((await mcp.listTools()).tools.length).toBeGreaterThan(0);
  finish();
  expect((await held).status).toBe(200);
});

it("carries an agent's text whose JSON escapes double it, as far as the browser's base64 carries it", async () => {
  const s = await stack();
  const mcp = await agent(s);
  // Four records of line breaks, near 4 MiB of text, which JSON sends in near 8 MiB.
  const records = [1, 2, 3, 4].map((n) => ({ path: `trip/blank/${n}.md`, basedOnBlobSha256: null, text: `---\nTitle: ${n}\n---\n${"\n".repeat(1_000_000)}` }));
  expect((await mcp.callTool({ name: "dohc_write_collection_files", arguments: { submitId: "escaped", files: [
    { path: "trip/blank/collection.yaml", basedOnBlobSha256: null, text: SCHEMA },
    ...records,
  ] } })).structuredContent).toEqual({ ok: true, outcome: "accepted", submitId: "escaped" });
});

it("takes an agent's file as base64, and a write only in an MCP request of its own", async () => {
  const s = await stack();
  const mcp = await agent(s);
  // The listed schema says each file carries text or base64, one or the other.
  const tool = (await mcp.listTools()).tools.find((candidate) => candidate.name === "dohc_write_collection_files")!;
  const file = (tool.inputSchema.properties!.files as { items: { anyOf: Array<{ required: string[]; additionalProperties: boolean }> } }).items;
  expect(file.anyOf.map((variant) => [variant.required.sort(), variant.additionalProperties])).toEqual([
    [["basedOnBlobSha256", "path", "text"], false], [["base64", "basedOnBlobSha256", "path"], false]]);
  const control = `---\nTitle: Bell\n---\n${"\u0001".repeat(16)}\n`;
  expect((await mcp.callTool({ name: "dohc_write_collection_files", arguments: { submitId: "base64", files: [
    { path: "trip/bell/collection.yaml", basedOnBlobSha256: null, text: SCHEMA },
    { path: "trip/bell/bell.md", basedOnBlobSha256: null, base64: Buffer.from(control).toString("base64") },
  ] } })).structuredContent).toEqual({ ok: true, outcome: "accepted", submitId: "base64" });
  expect((await mcp.callTool({ name: "dohc_write_collection_files", arguments: { submitId: "both", files: [
    { path: "trip/bell/automations.yaml", basedOnBlobSha256: null, text: AUTOMATIONS, base64: Buffer.from(AUTOMATIONS).toString("base64") },
  ] } })).isError).toBe(true);
  // Megabytes of base64 are checked without exhausting the regular expression stack.
  expect((await mcp.callTool({ name: "dohc_write_collection_files", arguments: { submitId: "oversized", files: [
    { path: "trip/bell/huge.md", basedOnBlobSha256: null, base64: "A".repeat(5_600_000) },
  ] } })).isError).toBe(true);

  const exchanged = await s.send("/api/mcp/exchange", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ secret: s.secret }) });
  const { bearer } = await exchanged.json() as { bearer: string };
  const call = (id: number, submitId: string) => ({ jsonrpc: "2.0", id, method: "tools/call", params: { name: "dohc_write_collection_files",
    arguments: { submitId, files: [{ path: AUTOMATIONS_PATH, basedOnBlobSha256: sha256(AUTOMATIONS), text: AUTOMATIONS_TWO }] } } });
  const batch = await s.send("/mcp", { method: "POST", body: JSON.stringify([call(1, "batch-1"), call(2, "batch-2")]),
    headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json", accept: "application/json, text/event-stream" } });
  expect(await batch.json()).toMatchObject({ error: { code: -32600 } });
  expect((await directMoments(s)).map((moment) => moment.payload.path)).toEqual(["trip/bell/collection.yaml", "trip/bell/bell.md"]);
});
