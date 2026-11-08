import { afterEach, describe, expect, it } from "vitest";
import { TokenBucketLimiter } from "@dohc/service-http";
import { hashAgentCredential, pkceS256Challenge } from "./linkSecurity";
import { linkRefusal, opaqueLinkRefusal } from "./linkRefusal";
import type { SyncRelayHandler } from "./server";
import { filterCollectionWriteForShare, type ProposedChange } from "./shareFilter";
import type { SyncRelayStorage } from "./storage";
import { AGENT_ACCESS_TOKEN_TTL_MS } from "./storage/agentConnections";
import {
  appendLog,
  chatChannelCreate,
  chatMessageAppend,
  chatThreadCreate,
  claimWorkspace,
  closeTestStorage,
  closeTestStorages,
  createShare,
  inspect,
  inspectDatabase,
  interceptStorage,
  json,
  jsonBody,
  LINK_KEY,
  linkRequest,
  linkSecret,
  moment,
  putBlob,
  RELAY_EXCHANGE_KEY,
  reopenTestStorage,
  request,
  sequenced,
  sha256,
  SHARE_WEB_ORIGIN,
  storagePath,
  testHandler,
  testStorage,
  type HandlerOverrides,
} from "./testing";
import { fixture as replicaFixture } from "./testing/replicaLink";

// A connected agent reads and writes its link through the routes share-web's
// MCP tools call, with `Authorization: DohcAgent <access token>` and the MCP
// address it signed in at. Agents sign in here through the relay's own
// sign-in routes, as share-web does.

const OWNER = "owner";
const WORKSPACE = "workspace-agent-links";
const GROUP_WORKSPACE = "workspace-agent-links-group";
const REDIRECT = "http://127.0.0.1:43110/callback";
const VERIFIER = "agent-pkce-verifier-0123456789-abcdefghijklmnopqrstuvwxyz";
const PROFILE = "p".repeat(43);
const SHARED = "# shared\n";
const HIDDEN = "hidden\n";
const PACKING = "trip/packing";
const SCHEMA = "name: Packing\nfields:\n  Title:\n    type: text\n";
const STAMP = "  - id: stamp\n    name: Stamp\n    when: record-added\n    do:\n      - set:\n          Title: Packed\n";
const automations = (...items: string[]) => `version: 1\nautomations:\n${items.join("")}`;
const RELEASED: HandlerOverrides = {
  publicEditRelease: { version: 1 },
  namedBrowserSessionLimits: {
    maxSessions: 8, retentionMs: 60_000, maxPendingRequests: 4, maxRequestBytes: 8192, maxResponseBytes: 16384, timeoutMs: 1000,
  },
};

afterEach(closeTestStorages);

type Fixture = { storage: SyncRelayStorage; dbPath: string; h: SyncRelayHandler; now: { value: number } };
type Link = { shareId: string; grantId: string; secret: string; resource: string };
type Agent = Link & { clientId: string; accessToken: string; refreshToken: string; connectionId: string };

function handler(storage: SyncRelayStorage, now: { value: number }, overrides: HandlerOverrides = RELEASED): SyncRelayHandler {
  return testHandler(storage, { nowMs: () => now.value, relayExchangeKey: RELAY_EXCHANGE_KEY, ...overrides });
}

let ownerSeq = 0;

// The owner's file at `path`, through its own log.
async function ownerWrites(f: Fixture, path: string, text: string): Promise<void> {
  await putBlob(f.h, OWNER, WORKSPACE, text);
  const originSeq = ownerSeq++;
  await appendLog(f.h, OWNER, WORKSPACE, [moment(path, text, {
    originSeq,
    payload: { payloadAfterContentKind: "text", payloadAfterByteLength: Buffer.byteLength(text) },
  })], { originId: "origin-owner" });
}

async function fixture(overrides?: HandlerOverrides): Promise<Fixture> {
  ownerSeq = 0;
  const storage = await testStorage();
  const now = { value: 10_000 };
  const h = handler(storage, now, overrides);
  await claimWorkspace(h, OWNER, WORKSPACE);
  const f = { storage, dbPath: storagePath(storage), h, now };
  await ownerWrites(f, "docs/shared.md", SHARED);
  await ownerWrites(f, "private/hidden.md", HIDDEN);
  return f;
}

async function ok(response: Response): Promise<Record<string, unknown>> {
  expect(response.status, await response.clone().text()).toBe(200);
  return json(response);
}

// Every refusal is the same bytes as a link that never existed.
async function expectRefused(response: Response): Promise<void> {
  const refusal = opaqueLinkRefusal();
  expect({ status: response.status, body: await response.text() })
    .toEqual({ status: refusal.status, body: await refusal.text() });
}

async function createLink(f: Fixture, paths: string[] = ["docs"], access = "view", workspaceId = WORKSPACE): Promise<Link> {
  const shareId = await createShare(f.h, OWNER, workspaceId, { recipientUserId: "seed-recipient", paths, access: access === "edit" ? "edit" : "view" });
  return mintLink(f, shareId, access, workspaceId);
}

async function mintLink(f: Fixture, shareId: string, access: string, workspaceId = WORKSPACE): Promise<Link> {
  const link = await ok(await f.h(request(OWNER, `/sync/${workspaceId}/shares/${shareId}/links`, jsonBody({ access }))));
  const secret = linkSecret(link.url);
  return { shareId, grantId: String(link.grantId), secret, resource: `${SHARE_WEB_ORIGIN}/mcp/s/${secret}` };
}

function internal(f: Pick<Fixture, "h">, path: string, body: unknown, exchangeKey = RELAY_EXCHANGE_KEY): Promise<Response> {
  return f.h(request(null, `/sync/link/${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-dohc-relay-exchange-key": exchangeKey },
    body: JSON.stringify(body),
  }));
}

// Signs an agent in on `link`, as share-web's sign-in does.
async function connect(f: Pick<Fixture, "h">, link: Link, exchangeKey = RELAY_EXCHANGE_KEY): Promise<Agent> {
  const send = (path: string, body: unknown) => internal(f, path, body, exchangeKey);
  const clientId = String((await ok(await send("agent-clients", {
    registration: "registered", redirectUris: [REDIRECT], clientName: "Test agent",
  }))).clientId);
  const requestId = String((await ok(await send("agent-authorizations", {
    clientId, resource: link.resource, redirectUri: REDIRECT, codeChallenge: pkceS256Challenge(VERIFIER), codeChallengeMethod: "S256",
  }))).requestId);
  const code = String((await ok(await send("agent-authorizations/decision", { requestId, decision: "allow" }))).code);
  const tokens = await ok(await send("agent-token", {
    grantType: "authorization_code", clientId, code, redirectUri: REDIRECT, codeVerifier: VERIFIER, resource: link.resource,
  }));
  const accessToken = String(tokens.accessToken);
  const { connectionId } = await ok(await send("agent-introspect", { accessToken }));
  return { ...link, clientId, accessToken, refreshToken: String(tokens.refreshToken), connectionId: String(connectionId) };
}

// An agent's request as share-web sends it. A null header value leaves it out.
function agentRequest(agent: Pick<Agent, "accessToken" | "resource">, path: string, init: RequestInit = {},
  headers: Record<string, string | null> = {}): Request {
  const sent = new Headers(init.headers);
  const all: Record<string, string | null> = {
    authorization: `DohcAgent ${agent.accessToken}`,
    "x-dohc-agent-resource": agent.resource,
    "x-dohc-relay-exchange-key": RELAY_EXCHANGE_KEY,
    ...headers,
  };
  for (const [name, value] of Object.entries(all)) {
    if (value !== null) sent.set(name, value);
  }
  return request(null, path, { ...init, headers: sent });
}

async function exchange(f: Fixture, link: Link): Promise<string> {
  return String((await ok(await f.h(request(null, "/sync/link-exchange", {
    ...jsonBody({ secret: link.secret }),
    headers: { "content-type": "application/json", "x-dohc-relay-exchange-key": RELAY_EXCHANGE_KEY },
  })))).capabilityToken);
}

function disconnect(f: Fixture, agent: Agent): Promise<Response> {
  return f.h(request(OWNER, `/sync/${WORKSPACE}/shares/${agent.shareId}/links/${agent.grantId}/agents/${agent.connectionId}/disconnect`, jsonBody({})));
}

function connection(f: Fixture, agent: Agent): { principal_id: unknown; last_action_at_ms: unknown; status: unknown } {
  return inspect(f.dbPath, (db) => db.prepare(`SELECT principal_id, last_action_at_ms, status
    FROM sync_relay_agent_connections WHERE connection_id = ?`).get(agent.connectionId) as
    { principal_id: unknown; last_action_at_ms: unknown; status: unknown });
}

function sql(f: Fixture, statement: string, ...values: Array<string | number>): void {
  const db = inspectDatabase(f.dbPath);
  try {
    db.prepare(statement).run(...values);
  } finally {
    db.close();
  }
}

// What ends an agent's access between a route's check and its write, or
// between two chunks of a response. Each commits straight in storage, as a
// racing owner request would, so the route's own stream ending is not what
// stops it: only the check in the write or before the chunk can.
const racedEnds: Array<[string, (f: Fixture, storage: SyncRelayStorage, agent: Agent) => void]> = [
  ["the owner disconnects it", (f, storage, agent) => {
    expect(storage.disconnectAgentConnection({
      workspaceId: WORKSPACE, shareId: agent.shareId, grantId: agent.grantId, connectionId: agent.connectionId,
      nowMs: f.now.value, guard: () => undefined,
    })).not.toBeNull();
  }],
  ["the owner resets the link", (f, storage, agent) => {
    expect(storage.rotateLinkGrant({
      shareId: agent.shareId, grantId: agent.grantId, rotatedAtMs: f.now.value, expectedDependentGrantIds: [], guard: () => {},
      mintCredential: () => ({ credentialId: "raced-credential", secretHash: "raced-secret-hash" }),
    }).ok).toBe(true);
  }],
  ["the owner ends the link", (f, storage, agent) => {
    expect(storage.revokeShareGrant({ shareId: agent.shareId, grantId: agent.grantId, revokedAtMs: f.now.value }).ok).toBe(true);
  }],
  ["its access token expires", (f) => {
    f.now.value += AGENT_ACCESS_TOKEN_TTL_MS;
  }],
];

describe("an agent reading its link", () => {
  it("reads the share, its current files, its log, and a blob as the link's holder does", async () => {
    const f = await fixture();
    const link = await createLink(f);
    const agent = await connect(f, link);
    const holder = await exchange(f, link);
    for (const path of ["/sync/link/share", "/sync/link/current", "/sync/link/log?current=true&since=0&limit=100"]) {
      const asAgent = await ok(await f.h(agentRequest(agent, path)));
      const asHolder = await ok(await f.h(linkRequest(holder, path)));
      // Only the agent's share answer names its grant, for share-web's per-link limits.
      expect(asAgent).toEqual(path === "/sync/link/share" ? { ...asHolder, grantId: link.grantId } : asHolder);
    }
    expect(await ok(await f.h(linkRequest(holder, "/sync/link/share")))).not.toHaveProperty("grantId");
    expect((await ok(await f.h(agentRequest(agent, "/sync/link/current")))).files)
      .toEqual([expect.objectContaining({ path: "docs/shared.md", blobSha256: sha256(SHARED) })]);
    const blob = await f.h(agentRequest(agent, `/sync/link/blobs/${sha256(SHARED)}`));
    expect(blob.status).toBe(200);
    expect(await blob.text()).toBe(SHARED);
    await expectRefused(await f.h(agentRequest(agent, `/sync/link/blobs/${sha256(HIDDEN)}`)));
    // A read is not an action.
    expect(connection(f, agent).last_action_at_ms).toBeNull();
  });

  it("refuses every credential that is not exactly the agent's own, with the bytes of a missing link", async () => {
    const f = await fixture();
    const link = await createLink(f);
    const other = await createLink(f, ["private"]);
    const agent = await connect(f, link);
    const otherAgent = await connect(f, other);
    const holder = await exchange(f, link);
    const cases: Array<[string, Request]> = [
      ["no relay exchange key", agentRequest(agent, "/sync/link/share", {}, { "x-dohc-relay-exchange-key": null })],
      ["a wrong relay exchange key", agentRequest(agent, "/sync/link/share", {}, { "x-dohc-relay-exchange-key": `${RELAY_EXCHANGE_KEY}-wrong` })],
      ["no MCP address", agentRequest(agent, "/sync/link/share", {}, { "x-dohc-agent-resource": null })],
      ["another link's MCP address", agentRequest(agent, "/sync/link/share", {}, { "x-dohc-agent-resource": other.resource })],
      ["its MCP address with more after it", agentRequest(agent, "/sync/link/share", {}, { "x-dohc-agent-resource": `${link.resource}/` })],
      ["another link's token at its MCP address", agentRequest({ ...otherAgent, resource: link.resource }, "/sync/link/share")],
      ["its refresh token", agentRequest({ ...agent, accessToken: agent.refreshToken }, "/sync/link/share")],
      ["an unknown token", agentRequest({ ...agent, accessToken: "z".repeat(43) }, "/sync/link/share")],
      ["a short token", agentRequest({ ...agent, accessToken: "z".repeat(42) }, "/sync/link/share")],
      ["the token under another scheme", agentRequest(agent, "/sync/link/share", {}, { authorization: `Bearer ${agent.accessToken}` })],
      ["a link profile", agentRequest(agent, "/sync/link/share", {}, { "x-dohc-link-profile-secret": PROFILE })],
      ["a cookie", agentRequest(agent, "/sync/link/share", {}, { cookie: "session=1" })],
      ["a holder's capability naming an MCP address", linkRequest(holder, "/sync/link/share", { headers: { "x-dohc-agent-resource": link.resource } })],
    ];
    for (const [name, refused] of cases) {
      const response = await f.h(refused);
      expect(response.status, name).toBe(404);
      await expectRefused(response);
    }
    // A relay with no exchange key configured serves no agent, and can't turn on the Edit release.
    await expectRefused(await handler(f.storage, f.now, { relayExchangeKey: undefined })(agentRequest(agent, "/sync/link/share")));
    expect(() => handler(f.storage, f.now, { ...RELEASED, relayExchangeKey: undefined })).toThrow(/relay exchange/);
    await ok(await f.h(agentRequest(agent, "/sync/link/share")));
    await ok(await f.h(agentRequest(otherAgent, "/sync/link/share")));
    await ok(await f.h(linkRequest(holder, "/sync/link/share")));
  });

  const ends: Array<[string, string, (f: Fixture, agent: Agent) => Promise<Fixture>]> = [
    ["the owner disconnects it", "view", async (f, agent) => {
      await ok(await disconnect(f, agent));
      return f;
    }],
    ["the owner resets the link", "view", async (f, agent) => {
      await ok(await f.h(request(OWNER, `/sync/shares/${agent.shareId}/links/${agent.grantId}/rotate`,
        jsonBody({ workspaceId: WORKSPACE, expectedDependentGrantIds: [] }))));
      return f;
    }],
    ["the owner ends the link", "view", async (f, agent) => {
      await ok(await f.h(request(OWNER, `/sync/shares/${agent.shareId}/revoke`,
        jsonBody({ workspaceId: WORKSPACE, expectedDependentGrantIds: [], grantId: agent.grantId }))));
      return f;
    }],
    ["its access token expires", "view", async (f) => {
      f.now.value += AGENT_ACCESS_TOKEN_TTL_MS;
      return f;
    }],
    ["the relay stops serving Edit links", "edit", async (f) => ({ ...f, h: handler(f.storage, f.now, {}) })],
  ];

  it.each(ends)("stops reading once %s", async (_name, access, end) => {
    const f = await fixture();
    const agent = await connect(f, await createLink(f, ["docs"], access));
    await ok(await f.h(agentRequest(agent, "/sync/link/share")));
    const after = await end(f, agent);
    for (const path of ["/sync/link/share", "/sync/link/current", "/sync/link/log?current=true&since=0", `/sync/link/blobs/${sha256(SHARED)}`]) {
      await expectRefused(await after.h(agentRequest(agent, path)));
    }
  });

  it("keeps its token across a relay restart", async () => {
    const f = await fixture();
    const agent = await connect(f, await createLink(f));
    closeTestStorage(f.storage);
    const storage = reopenTestStorage(f.dbPath);
    const h = handler(storage, f.now);
    expect((await ok(await h(agentRequest(agent, "/sync/link/current")))).files)
      .toEqual([expect.objectContaining({ path: "docs/shared.md" })]);
  });

  it("spends its own read budget, apart from the link's holders", async () => {
    const f = await fixture({ ...RELEASED, linkReadRateLimiter: new TokenBucketLimiter(1, 0.000001, 10) });
    const link = await createLink(f);
    const agent = await connect(f, link);
    const holder = await exchange(f, link);
    await ok(await f.h(agentRequest(agent, "/sync/link/share")));
    expect(await json(await f.h(agentRequest(agent, "/sync/link/share")))).toMatchObject({ code: "link_read_rate_limited" });
    await ok(await f.h(linkRequest(holder, "/sync/link/share")));
  });

  // Each pull of a response checks the token again: a blob, and the current
  // listing, whose JSON spans several chunks once the share holds enough files.
  const streams: Array<[string, (f: Fixture) => Promise<string>]> = [
    ["a blob download", async (f) => {
      const content = `${"a".repeat(64 * 1024)}${"b".repeat(64 * 1024)}${"c".repeat(64 * 1024)}`;
      await ownerWrites(f, "docs/large.md", content);
      return `/sync/link/blobs/${sha256(content)}`;
    }],
    ["the current listing", async (f) => {
      await appendLog(f.h, OWNER, WORKSPACE, Array.from({ length: 450 }, () => {
        const originSeq = ownerSeq++;
        return moment(`docs/many/${String(originSeq).padStart(3, "0")}-${"x".repeat(200)}.md`, SHARED, {
          originSeq, payload: { payloadAfterContentKind: "text", payloadAfterByteLength: Buffer.byteLength(SHARED) },
        });
      }), { originId: "origin-owner" });
      return "/sync/link/current";
    }],
  ];

  describe.each(streams)("%s", (_stream, setup) => {
    it.each(racedEnds)("ends between chunks once %s", async (_name, end) => {
      const f = await fixture();
      const path = await setup(f);
      const agent = await connect(f, await createLink(f));

      const whole = await f.h(agentRequest(agent, path));
      expect(whole.status).toBe(200);
      expect((await whole.arrayBuffer()).byteLength).toBeGreaterThan(64 * 1024);

      const response = await f.h(agentRequest(agent, path));
      expect(response.status).toBe(200);
      const reader = response.body!.getReader();
      const first = await reader.read();
      expect(first.done).toBe(false);
      expect(first.value?.byteLength).toBe(64 * 1024);
      end(f, f.storage, agent);
      await expect(reader.read()).rejects.toMatchObject({ code: "not_found" });
    });
  });

  // A relay serving current reads from the owner's replica authenticates the
  // agent inside the replica read's own snapshot.
  it("reads the replica's current files and streams its blobs", async () => {
    const f = await replicaFixture();
    try {
      const exchangeKey = "e".repeat(64);
      const resource = `https://viewer.dohc.test/mcp/s/${f.secret}`;
      const agent = await connect(f, { shareId: "s", grantId: "link", secret: f.secret, resource }, exchangeKey);
      const asAgent = (path: string) => f.h(agentRequest(agent, path, {}, { "x-dohc-relay-exchange-key": exchangeKey }));
      const text = "x".repeat(200_000);
      f.publish(text);

      const current = await ok(await asAgent("/sync/link/current"));
      expect(current.files).toEqual([expect.objectContaining({ path: "docs/a.md", blobSha256: sha256(text) })]);
      expect(current).toEqual(await ok(await f.send("/sync/link/current")));
      await ok(await asAgent("/sync/link/log?current=true&since=0"));
      // Four chunks, each checked again inside the replica read.
      const blob = await asAgent(`/sync/link/blobs/${sha256(text)}`);
      expect(blob.status).toBe(200);
      expect(await blob.text()).toBe(text);
    } finally {
      f.dispose();
    }
  });
});

describe("an agent in its link's discussion", () => {
  function holderPost(f: Fixture, capability: string, body: Record<string, unknown>): Promise<Response> {
    return f.h(linkRequest(capability, "/sync/link/discussion", {
      method: "POST",
      headers: { "content-type": "application/json", "x-dohc-relay-exchange-key": RELAY_EXCHANGE_KEY, "x-dohc-link-profile-secret": PROFILE },
      body: JSON.stringify(body),
    }));
  }

  function agentPost(f: Fixture, agent: Agent, body: Record<string, unknown>): Promise<Response> {
    return f.h(agentRequest(agent, "/sync/link/discussion", jsonBody(body)));
  }

  function messages(f: Fixture): Array<Record<string, unknown>> {
    return inspect(f.dbPath, (db) => db.prepare(`SELECT body, display_name_snapshot, link_principal_id, agent_connection_id
      FROM sync_relay_share_discussion_messages ORDER BY discussion_revision`).all());
  }

  it("reads under its own name, and posts as its connection's principal, recording the connection", async () => {
    const f = await fixture();
    const link = await createLink(f, ["docs"], "comment");
    const agent = await connect(f, link);
    await ok(await holderPost(f, await exchange(f, link), { body: "from a browser", claimedName: "Sam", idempotencyKey: "holder-1" }));

    expect(await ok(await f.h(agentRequest(agent, "/sync/link/discussion")))).toMatchObject({ profileName: "Test agent" });
    f.now.value += 5;
    await ok(await agentPost(f, agent, { body: "from the agent", idempotencyKey: "agent-1" }));
    // A retry answers from the message it made.
    await ok(await agentPost(f, agent, { body: "from the agent", idempotencyKey: "agent-1" }));

    const { principal_id: principalId, last_action_at_ms: lastActionAtMs } = connection(f, agent);
    const [fromHolder, fromAgent, ...rest] = messages(f);
    expect(rest).toEqual([]);
    expect(fromHolder).toMatchObject({ body: "from a browser", display_name_snapshot: "Sam", agent_connection_id: null });
    expect(fromAgent).toEqual({
      body: "from the agent", display_name_snapshot: "Test agent", link_principal_id: principalId, agent_connection_id: agent.connectionId,
    });
    expect(fromHolder!.link_principal_id).not.toBe(principalId);
    expect(lastActionAtMs).toBe(f.now.value);
  });

  it("refuses an agent that claims a name, posts through a View link, or writes while paused or blocked", async () => {
    const f = await fixture();
    const comment = await connect(f, await createLink(f, ["docs"], "comment"));
    expect((await agentPost(f, comment, { body: "named", claimedName: "Sam", idempotencyKey: "claim" })).status).toBe(400);

    const view = await connect(f, await createLink(f, ["docs"], "view"));
    const refusal = linkRefusal("link_view_access");
    const refused = await agentPost(f, view, { body: "from a viewer", idempotencyKey: "view" });
    expect({ status: refused.status, body: await refused.text() }).toEqual({ status: refusal.status, body: await refusal.text() });

    sql(f, "UPDATE sync_relay_shares SET link_writes_paused_at_ms = 1 WHERE share_id = ?", comment.shareId);
    expect(await json(await agentPost(f, comment, { body: "paused", idempotencyKey: "paused" }))).toMatchObject({ code: "link_discussion_paused" });
    sql(f, "UPDATE sync_relay_shares SET link_writes_paused_at_ms = NULL WHERE share_id = ?", comment.shareId);
    sql(f, "UPDATE sync_relay_link_principals SET blocked_at_ms = 1 WHERE principal_id = ?", String(connection(f, comment).principal_id));
    expect(await json(await agentPost(f, comment, { body: "blocked", idempotencyKey: "blocked" }))).toMatchObject({ code: "link_discussion_blocked" });
    expect(messages(f)).toEqual([]);
    expect(connection(f, comment).last_action_at_ms).toBeNull();
  });

  it.each(racedEnds)("refuses a post once %s inside the write, storing nothing", async (_name, end) => {
    const f = await fixture();
    const agent = await connect(f, await createLink(f, ["docs"], "comment"));
    await ok(await agentPost(f, agent, { body: "first", idempotencyKey: "first" }));
    // The route's own check passes, then access ends before the write's transaction reads the clock.
    const storage = interceptStorage(f.storage, {
      appendLinkDiscussionMessage: (target, input) => target.appendLinkDiscussionMessage({ ...input, guard: () => {
        input.guard?.();
        end(f, target, agent);
      } }),
    });
    await expectRefused(await handler(storage, f.now)(agentRequest(agent, "/sync/link/discussion", jsonBody({ body: "late", idempotencyKey: "late" }))));
    expect(messages(f).map((message) => message.body)).toEqual(["first"]);
  });
});

describe("an agent writing a Collection through an Edit link", () => {
  const encoded = (text: string) => Buffer.from(text).toString("base64");
  function linkEdit(path: string, before: string, after: string): Record<string, unknown> {
    return {
      basedOnPath: path, basedOnBlobSha256: sha256(before), operation: "write",
      afterPath: path, afterContentKind: "text", afterContentBase64: encoded(after), recordedAtMs: 1,
    };
  }
  function linkCreate(path: string, text: string): Record<string, unknown> {
    return { ...linkEdit(path, "", text), basedOnPath: null, basedOnBlobSha256: null };
  }
  function writeBody(submitId: string, changes: unknown[]): RequestInit {
    return { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ submitId, changes }) };
  }

  async function collectionFixture(access = "edit"): Promise<{ f: Fixture; link: Link }> {
    const f = await fixture();
    await ownerWrites(f, `${PACKING}/collection.yaml`, SCHEMA);
    return { f, link: await createLink(f, ["trip"], access) };
  }

  function ledger(f: Fixture): Array<Record<string, unknown>> {
    return inspect(f.dbPath, (db) => db.prepare(`SELECT submit_id, author_kind, principal_id, agent_connection_id
      FROM sync_relay_collection_writes ORDER BY first_origin_seq`).all());
  }

  it("writes as its connection's principal and records the connection on the ledger", async () => {
    const { f, link } = await collectionFixture();
    const agent = await connect(f, link);
    const one = automations(STAMP);
    const two = automations(STAMP.replace("Packed", "Ready"));
    const holder = await f.h(linkRequest(await exchange(f, link), "/sync/link/collection-writes", {
      ...writeBody("holder-1", [linkCreate(`${PACKING}/automations.yaml`, one)]),
      headers: { "content-type": "application/json", "x-dohc-link-profile-secret": PROFILE },
    }));
    await ok(holder);
    f.now.value += 5;
    const changes = [linkEdit(`${PACKING}/automations.yaml`, one, two)];
    expect(await ok(await f.h(agentRequest(agent, "/sync/link/collection-writes", writeBody("agent-1", changes)))))
      .toMatchObject({ ok: true, submitId: "agent-1", created: true });
    expect(await ok(await f.h(agentRequest(agent, "/sync/link/collection-writes", writeBody("agent-1", changes)))))
      .toMatchObject({ created: false });

    const { principal_id: principalId, last_action_at_ms: lastActionAtMs } = connection(f, agent);
    const [fromHolder, fromAgent, ...rest] = ledger(f);
    expect(rest).toEqual([]);
    expect(fromHolder).toMatchObject({ submit_id: "holder-1", author_kind: "link", agent_connection_id: null });
    expect(fromAgent).toEqual({ submit_id: "agent-1", author_kind: "link", principal_id: principalId, agent_connection_id: agent.connectionId });
    expect(fromHolder!.principal_id).not.toBe(principalId);
    expect(lastActionAtMs).toBe(f.now.value);

    const [written] = inspect(f.dbPath, (db) => db.prepare(`SELECT payload_json, admitted_author_snapshot_json FROM sync_relay_log
      WHERE origin_id = ? ORDER BY relay_seq DESC LIMIT 1`).all(`relay:collection-file:${link.grantId}`));
    expect(JSON.parse(String(written!.payload_json))).toMatchObject({
      payloadAfterBlobSha256: sha256(two), authors: [{ kind: "link", grantId: link.grantId, principalId }],
    });
    expect(JSON.parse(String(written!.admitted_author_snapshot_json))).toEqual([
      expect.objectContaining({ kind: "link", label: "Test agent" }),
    ]);
    // Nothing about the agent's credential reaches the owner's log.
    expect(JSON.stringify(written)).not.toContain(agent.accessToken);
    expect(JSON.stringify(written)).not.toContain(agent.resource);
  });

  it("refuses an agent on a Comment link, writing nothing", async () => {
    const { f, link } = await collectionFixture("comment");
    const agent = await connect(f, link);
    await expectRefused(await f.h(agentRequest(agent, "/sync/link/collection-writes",
      writeBody("agent-1", [linkCreate(`${PACKING}/automations.yaml`, automations(STAMP))]))));
    expect(ledger(f)).toEqual([]);
  });

  it.each(racedEnds)("refuses a write once %s after the route authenticated it, storing nothing", async (_name, end) => {
    const { f, link } = await collectionFixture();
    const agent = await connect(f, link);
    const one = automations(STAMP);
    const two = automations(STAMP.replace("Packed", "Ready"));
    await ok(await f.h(agentRequest(agent, "/sync/link/collection-writes",
      writeBody("agent-1", [linkCreate(`${PACKING}/automations.yaml`, one)]))));
    const storage = interceptStorage(f.storage, {
      commitCollectionWrite: (target, input) => {
        end(f, target, agent);
        return target.commitCollectionWrite(input);
      },
    });
    await expectRefused(await handler(storage, f.now)(agentRequest(agent, "/sync/link/collection-writes",
      writeBody("agent-2", [linkEdit(`${PACKING}/automations.yaml`, one, two)]))));
    expect(ledger(f).map((row) => row.submit_id)).toEqual(["agent-1"]);
    expect(f.storage.getBlob(WORKSPACE, sha256(two))).toBeNull();
  });

  it("refuses a write whose token expires while it waits, reading the clock inside the write", async () => {
    const { f, link } = await collectionFixture();
    const agent = await connect(f, link);
    const one = automations(STAMP);
    const change: ProposedChange = {
      basedOnPath: null, basedOnBlobSha256: null, operation: "write", afterPath: `${PACKING}/automations.yaml`,
      afterBlobSha256: sha256(one), afterContentKind: "text", afterByteLength: Buffer.byteLength(one), recordedAtMs: 1,
    };
    const decision = filterCollectionWriteForShare({ versionId: null, paths: ["trip"], access: "edit" }, [change]);
    if (!decision.allowed) throw new Error("expected the write to be allowed");
    // The first read of the clock is the check before the write; the token expires before the write's own.
    const clock = [f.now.value];
    expect(() => f.storage.commitCollectionWrite({
      shareId: link.shareId, grantId: link.grantId, grantGeneration: f.storage.getShareGrant(link.grantId)!.generation,
      writer: {
        kind: "agent",
        accessTokenHash: hashAgentCredential("access", agent.accessToken, LINK_KEY),
        resourceHash: hashAgentCredential("resource", agent.resource, LINK_KEY),
        content: new Map([[sha256(one), Buffer.from(one)]]),
        now: () => clock.shift() ?? f.now.value + AGENT_ACCESS_TOKEN_TTL_MS,
      },
      submitId: "agent-1", rawChanges: decision.write.kind === "automations" ? [decision.write.change] : [], write: decision.write,
      nowMs: f.now.value, newId: () => "id",
    })).toThrow(expect.objectContaining({ code: "not_found" }));
    expect(clock).toEqual([]);
    expect(ledger(f)).toEqual([]);
    expect(f.storage.getBlob(WORKSPACE, sha256(one))).toBeNull();
  });
});

describe("an agent reading its Group link's chat", () => {
  const channelWireId = "wire-team";

  it("reads the channel's messages, but not the channel list, and posts only through agent chat", async () => {
    const f = await fixture();
    f.storage.claimWorkspace({ workspaceId: GROUP_WORKSPACE, ownerUserId: OWNER, createdAtMs: 1 });
    f.storage.appendLogBatch({
      workspaceId: GROUP_WORKSPACE, originId: "owner",
      ops: sequenced([
        chatChannelCreate(channelWireId, { name: "Team", type: "both", folderPath: "team" }),
        chatThreadCreate("thread-team", channelWireId),
        chatMessageAppend("owner-first", "thread-team", "welcome", { authorUserId: OWNER, authorDisplayName: "Ada" }),
      ]).map(({ payload, ...op }) => ({ ...op, payloadJson: JSON.stringify(payload) })),
    });
    const shareId = await createShare(f.h, OWNER, GROUP_WORKSPACE, {
      recipientUserId: "member", channelWireId, paths: ["team"], access: "read-write", subjectName: "Team",
    });
    const agent = await connect(f, await mintLink(f, shareId, "read-only", GROUP_WORKSPACE));
    const history = `/sync/link/chat/messages?channelWireId=${channelWireId}`;

    expect((await ok(await f.h(agentRequest(agent, history)))).messages)
      .toEqual([expect.objectContaining({ messageId: "owner-first", body: "welcome" })]);
    await expectRefused(await f.h(agentRequest(agent, "/sync/link/chat/channels")));
    await expectRefused(await f.h(agentRequest(agent, "/sync/link/chat/messages",
      jsonBody({ channelWireId, body: "hello", idempotencyKey: "post-1" }), { "x-dohc-link-profile-secret": null })));

    sql(f, "UPDATE sync_relay_agent_connections SET status = 'disconnected', ended_at_ms = 1 WHERE connection_id = ?", agent.connectionId);
    await expectRefused(await f.h(agentRequest(agent, history)));
  });
});
