import { afterEach, describe, expect, it } from "vitest";
import { errorResponse, notFound } from "./errors";
import { pkceS256Challenge } from "./linkSecurity";
import type { SyncRelayHandler } from "./server";
import type { SyncRelayStorage } from "./storage";
import {
  claimWorkspace,
  closeTestStorage,
  closeTestStorages,
  createShare,
  inspect,
  interceptStorage,
  json,
  jsonBody,
  linkSecret,
  RELAY_EXCHANGE_KEY,
  reopenTestStorage,
  request,
  SHARE_WEB_ORIGIN,
  storagePath,
  testHandler,
  testStorage,
} from "./testing";

const OWNER = "owner";
const OTHER = "other-account";
const WORKSPACE = "workspace-agents";
const OWNER_SECOND_WORKSPACE = "workspace-agents-second";
const OTHER_WORKSPACE = "workspace-agents-other";
const REDIRECT = "http://127.0.0.1:43110/callback";
const OTHER_REDIRECT = "https://agent.example.test/callback";
const VERIFIER = "agent-pkce-verifier-0123456789-abcdefghijklmnopqrstuvwxyz";
const OTHER_VERIFIER = "other-pkce-verifier-0123456789-abcdefghijklmnopqrstuvwxyz";
const AGENT_TABLES = [
  "sync_relay_agent_clients",
  "sync_relay_agent_authorizations",
  "sync_relay_agent_connections",
  "sync_relay_agent_tokens",
] as const;

afterEach(closeTestStorages);

type Fixture = { storage: SyncRelayStorage; dbPath: string; h: SyncRelayHandler; now: { value: number } };
type Link = { shareId: string; grantId: string; secret: string; resource: string };
type Connected = { clientId: string; code: string; accessToken: string; refreshToken: string; connectionId: string };

function handler(storage: SyncRelayStorage, now: { value: number }): SyncRelayHandler {
  return testHandler(storage, { nowMs: () => now.value, relayExchangeKey: RELAY_EXCHANGE_KEY });
}

async function fixture(): Promise<Fixture> {
  const storage = await testStorage();
  const now = { value: 10_000 };
  const h = handler(storage, now);
  await claimWorkspace(h, OWNER, WORKSPACE);
  return { storage, dbPath: storagePath(storage), h, now };
}

function resourceFor(secret: string): string {
  return `${SHARE_WEB_ORIGIN}/mcp/s/${secret}`;
}

async function ok(response: Response): Promise<Record<string, unknown>> {
  expect(response.status, await response.clone().text()).toBe(200);
  return json(response);
}

// Every refusal is the same bytes as a link that never existed.
async function expectRefused(response: Response): Promise<void> {
  const refusal = errorResponse(notFound());
  expect({ status: response.status, body: await response.text() })
    .toEqual({ status: refusal.status, body: await refusal.text() });
}

async function createLink(f: Fixture, paths: string[] = ["docs"]): Promise<Link> {
  const shareId = await createShare(f.h, OWNER, WORKSPACE, { recipientUserId: "seed-recipient", paths });
  const link = await ok(await f.h(request(OWNER, `/sync/${WORKSPACE}/shares/${shareId}/links`, jsonBody({ access: "view" }))));
  const secret = linkSecret(link.url);
  return { shareId, grantId: String(link.grantId), secret, resource: resourceFor(secret) };
}

function internal(f: Fixture, path: string, body: unknown, exchangeKey: string | null = RELAY_EXCHANGE_KEY): Promise<Response> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (exchangeKey !== null) headers["x-dohc-relay-exchange-key"] = exchangeKey;
  return f.h(request(null, `/sync/link/${path}`, { method: "POST", headers, body: JSON.stringify(body) }));
}

async function registerClient(f: Fixture, redirectUris: string[] = [REDIRECT]): Promise<string> {
  const body = await ok(await internal(f, "agent-clients", { registration: "registered", redirectUris, clientName: "Test agent" }));
  return String(body.clientId);
}

function begin(f: Fixture, link: Link, clientId: string, redirectUri = REDIRECT, verifier = VERIFIER): Promise<Response> {
  return internal(f, "agent-authorizations", {
    clientId,
    resource: link.resource,
    redirectUri,
    codeChallenge: pkceS256Challenge(verifier),
    codeChallengeMethod: "S256",
    state: "agent-state",
  });
}

async function beginRequest(f: Fixture, link: Link, clientId: string): Promise<string> {
  return String((await ok(await begin(f, link, clientId))).requestId);
}

function decide(f: Fixture, requestId: string, decision: "allow" | "cancel" = "allow"): Promise<Response> {
  return internal(f, "agent-authorizations/decision", { requestId, decision });
}

async function authorize(f: Fixture, link: Link, clientId: string, redirectUri = REDIRECT): Promise<string> {
  const requestId = String((await ok(await begin(f, link, clientId, redirectUri))).requestId);
  const decided = await ok(await decide(f, requestId));
  expect(decided).toMatchObject({ redirectUri, state: "agent-state" });
  return String(decided.code);
}

function redeem(f: Fixture, input: { clientId: string; code: string; resource: string; redirectUri?: string; codeVerifier?: string }): Promise<Response> {
  return internal(f, "agent-token", {
    grantType: "authorization_code",
    clientId: input.clientId,
    code: input.code,
    redirectUri: input.redirectUri ?? REDIRECT,
    codeVerifier: input.codeVerifier ?? VERIFIER,
    resource: input.resource,
  });
}

function refresh(f: Fixture, clientId: string, refreshToken: string, resource: string): Promise<Response> {
  return internal(f, "agent-token", { grantType: "refresh_token", clientId, refreshToken, resource });
}

function introspect(f: Fixture, accessToken: string): Promise<Response> {
  return internal(f, "agent-introspect", { accessToken });
}

async function connect(f: Fixture, link: Link, clientId?: string): Promise<Connected> {
  const client = clientId ?? await registerClient(f);
  const code = await authorize(f, link, client);
  const tokens = await ok(await redeem(f, { clientId: client, code, resource: link.resource }));
  const accessToken = String(tokens.accessToken);
  const introspected = await ok(await introspect(f, accessToken));
  return { clientId: client, code, accessToken, refreshToken: String(tokens.refreshToken), connectionId: String(introspected.connectionId) };
}

function agentsPath(link: Link, workspaceId = WORKSPACE, suffix = ""): string {
  return `/sync/${workspaceId}/shares/${link.shareId}/links/${link.grantId}/agents${suffix}`;
}

function listAgents(f: Fixture, user: string, link: Link, options: { workspaceId?: string; cursor?: string } = {}): Promise<Response> {
  const query = options.cursor ? `?cursor=${encodeURIComponent(options.cursor)}` : "";
  return f.h(request(user, `${agentsPath(link, options.workspaceId)}${query}`));
}

function disconnect(f: Fixture, user: string, link: Link, connectionId: string, workspaceId = WORKSPACE): Promise<Response> {
  return f.h(request(user, agentsPath(link, workspaceId, `/${connectionId}/disconnect`), jsonBody({})));
}

async function agentStatuses(f: Fixture, link: Link): Promise<Record<string, unknown>> {
  const body = await ok(await listAgents(f, OWNER, link));
  return Object.fromEntries((body.agents as Array<{ connectionId: string; status: string }>).map((agent) => [agent.connectionId, agent.status]));
}

function resetLink(f: Fixture, link: Link): Promise<Response> {
  return f.h(request(OWNER, `/sync/shares/${link.shareId}/links/${link.grantId}/rotate`,
    jsonBody({ workspaceId: WORKSPACE, expectedDependentGrantIds: [] })));
}

function endLink(f: Fixture, link: Link): Promise<Response> {
  return f.h(request(OWNER, `/sync/shares/${link.shareId}/revoke`,
    jsonBody({ workspaceId: WORKSPACE, expectedDependentGrantIds: [], grantId: link.grantId })));
}

function rowCount(dbPath: string, table: (typeof AGENT_TABLES)[number]): number {
  return inspect(dbPath, (db) => Number(db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get()?.count ?? 0));
}

describe("agent sign-in for share links", () => {
  it("refuses every internal route without the relay exchange key", async () => {
    const f = await fixture();
    const link = await createLink(f);
    const clientId = await registerClient(f);
    const routes: Array<[string, unknown]> = [
      ["agent-clients", { registration: "registered", redirectUris: [REDIRECT] }],
      ["agent-authorizations", { clientId, resource: link.resource, redirectUri: REDIRECT, codeChallenge: pkceS256Challenge(VERIFIER), codeChallengeMethod: "S256" }],
      ["agent-authorizations/consent", { requestId: "x".repeat(43) }],
      ["agent-authorizations/decision", { requestId: "x".repeat(43), decision: "allow" }],
      ["agent-token", { grantType: "refresh_token", clientId, refreshToken: "x".repeat(43), resource: link.resource }],
      ["agent-introspect", { accessToken: "x".repeat(43) }],
    ];
    for (const [path, body] of routes) {
      await expectRefused(await internal(f, path, body, null));
      await expectRefused(await internal(f, path, body, `${RELAY_EXCHANGE_KEY}-wrong`));
    }
    const unconfigured = { ...f, h: testHandler(f.storage, { nowMs: () => f.now.value }) };
    await expectRefused(await internal(unconfigured, "agent-clients", { registration: "registered", redirectUris: [REDIRECT] }));
  });

  it("connects an agent with consent, stores only hashes, and keeps the connection across a restart", async () => {
    const f = await fixture();
    const link = await createLink(f);
    const clientId = await registerClient(f);
    const requestId = await beginRequest(f, link, clientId);
    expect(await ok(await internal(f, "agent-authorizations/consent", { requestId }))).toMatchObject({
      access: "view",
      reportedClientName: "Test agent",
      redirectUri: REDIRECT,
    });
    const code = String((await ok(await decide(f, requestId))).code);
    const tokens = await ok(await redeem(f, { clientId, code, resource: link.resource }));
    const accessToken = String(tokens.accessToken);
    const refreshToken = String(tokens.refreshToken);
    const introspected = await ok(await introspect(f, accessToken));
    expect(introspected).toMatchObject({ shareId: link.shareId, grantId: link.grantId, access: "view" });

    const listed = await ok(await listAgents(f, OWNER, link));
    expect(listed.nextCursor).toBeNull();
    expect(listed.agents).toEqual([{
      connectionId: introspected.connectionId,
      reportedName: "Test agent",
      connectedAtMs: 10_000,
      lastActionAtMs: null,
      status: "active",
    }]);

    const stored = inspect(f.dbPath, (db) =>
      JSON.stringify(AGENT_TABLES.map((table) => db.prepare(`SELECT * FROM ${table}`).all())));
    for (const raw of [link.secret, requestId, code, accessToken, refreshToken]) {
      expect(stored).not.toContain(raw);
    }

    closeTestStorage(f.storage);
    const storage = reopenTestStorage(f.dbPath);
    const reopened: Fixture = { ...f, storage, h: handler(storage, f.now) };
    expect(await ok(await introspect(reopened, accessToken))).toMatchObject({ connectionId: introspected.connectionId });
    const refreshed = await ok(await refresh(reopened, clientId, refreshToken, link.resource));
    expect(await ok(await introspect(reopened, String(refreshed.accessToken)))).toMatchObject({ connectionId: introspected.connectionId });
    expect(await agentStatuses(reopened, link)).toEqual({ [String(introspected.connectionId)]: "active" });
  });

  it("refuses a redirect address the client did not register, and spends a code sent to another one", async () => {
    const f = await fixture();
    const link = await createLink(f);
    const narrow = await registerClient(f, [REDIRECT]);
    await expectRefused(await begin(f, link, narrow, OTHER_REDIRECT));
    await expectRefused(await begin(f, link, narrow, "https://evil.example.test/callback"));

    const both = await registerClient(f, [REDIRECT, OTHER_REDIRECT]);
    const code = await authorize(f, link, both, REDIRECT);
    await expectRefused(await redeem(f, { clientId: both, code, resource: link.resource, redirectUri: OTHER_REDIRECT }));
    await expectRefused(await redeem(f, { clientId: both, code, resource: link.resource, redirectUri: REDIRECT }));
    expect(rowCount(f.dbPath, "sync_relay_agent_connections")).toBe(0);
  });

  it("spends a code on a PKCE mismatch, so the right verifier fails after it", async () => {
    const f = await fixture();
    const link = await createLink(f);
    const clientId = await registerClient(f);
    const code = await authorize(f, link, clientId);
    await expectRefused(await redeem(f, { clientId, code, resource: link.resource, codeVerifier: OTHER_VERIFIER }));
    await expectRefused(await redeem(f, { clientId, code, resource: link.resource }));
    expect(rowCount(f.dbPath, "sync_relay_agent_connections")).toBe(0);
    expect(rowCount(f.dbPath, "sync_relay_agent_tokens")).toBe(0);
  });

  it("refuses a code redeemed by another client or for another link", async () => {
    const f = await fixture();
    const link = await createLink(f);
    const other = await createLink(f, ["notes"]);
    const clientId = await registerClient(f);
    const otherClient = await registerClient(f);
    await expectRefused(await redeem(f, { clientId: otherClient, code: await authorize(f, link, clientId), resource: link.resource }));
    await expectRefused(await redeem(f, { clientId, code: await authorize(f, link, clientId), resource: other.resource }));
    expect(rowCount(f.dbPath, "sync_relay_agent_connections")).toBe(0);
  });

  it("ends the connection when its code is replayed", async () => {
    const f = await fixture();
    const link = await createLink(f);
    const agent = await connect(f, link);
    await expectRefused(await redeem(f, { clientId: agent.clientId, code: agent.code, resource: link.resource }));
    await expectRefused(await introspect(f, agent.accessToken));
    await expectRefused(await refresh(f, agent.clientId, agent.refreshToken, link.resource));
    expect(await agentStatuses(f, link)).toEqual({ [agent.connectionId]: "retired" });
  });

  it("ends the whole token family when a rotated refresh token is reused", async () => {
    const f = await fixture();
    const link = await createLink(f);
    const agent = await connect(f, link);
    const rotated = await ok(await refresh(f, agent.clientId, agent.refreshToken, link.resource));
    const nextAccess = String(rotated.accessToken);
    const nextRefresh = String(rotated.refreshToken);
    expect(await ok(await introspect(f, nextAccess))).toMatchObject({ connectionId: agent.connectionId });

    await expectRefused(await refresh(f, agent.clientId, agent.refreshToken, link.resource));
    await expectRefused(await introspect(f, nextAccess));
    await expectRefused(await introspect(f, agent.accessToken));
    await expectRefused(await refresh(f, agent.clientId, nextRefresh, link.resource));
    expect(await agentStatuses(f, link)).toEqual({ [agent.connectionId]: "retired" });
  });

  it("keeps a connection to its own workspace, share, and link", async () => {
    const f = await fixture();
    await claimWorkspace(f.h, OWNER, OWNER_SECOND_WORKSPACE);
    const link = await createLink(f);
    const other = await createLink(f, ["notes"]);
    const agent = await connect(f, link);

    await expectRefused(await listAgents(f, OWNER, link, { workspaceId: OWNER_SECOND_WORKSPACE }));
    await expectRefused(await disconnect(f, OWNER, link, agent.connectionId, OWNER_SECOND_WORKSPACE));
    await expectRefused(await listAgents(f, OWNER, { ...other, grantId: link.grantId }));
    await expectRefused(await disconnect(f, OWNER, other, agent.connectionId));
    expect((await ok(await listAgents(f, OWNER, other))).agents).toEqual([]);

    await expectRefused(await refresh(f, agent.clientId, agent.refreshToken, other.resource));
    expect(await ok(await introspect(f, agent.accessToken))).toMatchObject({ shareId: link.shareId, grantId: link.grantId });
    expect(await agentStatuses(f, link)).toEqual({ [agent.connectionId]: "active" });
    await ok(await refresh(f, agent.clientId, agent.refreshToken, link.resource));
  });

  it("shows and disconnects a link's agents only for the share's owner", async () => {
    const f = await fixture();
    await claimWorkspace(f.h, OTHER, OTHER_WORKSPACE);
    const link = await createLink(f);
    const agent = await connect(f, link);

    for (const workspaceId of [WORKSPACE, OTHER_WORKSPACE]) {
      await expectRefused(await listAgents(f, OTHER, link, { workspaceId }));
      await expectRefused(await disconnect(f, OTHER, link, agent.connectionId, workspaceId));
    }
    expect(await agentStatuses(f, link)).toEqual({ [agent.connectionId]: "active" });
    await ok(await introspect(f, agent.accessToken));
  });

  it("disconnects one agent and leaves the others on the link connected", async () => {
    const f = await fixture();
    const link = await createLink(f);
    const first = await connect(f, link);
    const second = await connect(f, link);

    const ended = await ok(await disconnect(f, OWNER, link, first.connectionId));
    expect(ended.agent).toMatchObject({ connectionId: first.connectionId, status: "disconnected" });
    expect(Object.keys(ended.agent as object).sort()).toEqual(["connectedAtMs", "connectionId", "lastActionAtMs", "reportedName", "status"]);
    await expectRefused(await introspect(f, first.accessToken));
    await expectRefused(await refresh(f, first.clientId, first.refreshToken, link.resource));
    await ok(await introspect(f, second.accessToken));
    await ok(await refresh(f, second.clientId, second.refreshToken, link.resource));

    f.now.value += 1_000;
    expect(await ok(await disconnect(f, OWNER, link, first.connectionId))).toEqual(ended);
    await expectRefused(await disconnect(f, OWNER, link, "id-missing"));
    expect(await agentStatuses(f, link)).toEqual({ [first.connectionId]: "disconnected", [second.connectionId]: "active" });
  });

  it("pages a link's agents newest first", async () => {
    const f = await fixture();
    const link = await createLink(f);
    const clientId = await registerClient(f);
    const connected: string[] = [];
    for (let index = 0; index < 51; index += 1) {
      f.now.value += 1;
      connected.push((await connect(f, link, clientId)).connectionId);
    }
    const first = await ok(await listAgents(f, OWNER, link));
    const firstIds = (first.agents as Array<{ connectionId: string }>).map((agent) => agent.connectionId);
    expect(firstIds).toEqual(connected.slice(1).reverse());
    expect(typeof first.nextCursor).toBe("string");
    const second = await ok(await listAgents(f, OWNER, link, { cursor: String(first.nextCursor) }));
    expect((second.agents as Array<{ connectionId: string }>).map((agent) => agent.connectionId)).toEqual([connected[0]]);
    expect(second.nextCursor).toBeNull();
  });

  // Each change, once through the owner route and once straight in storage, so a
  // race can commit it inside a sign-in step after the route has read its request.
  const changes: Array<[
    name: string,
    change: (f: Fixture, link: Link) => Promise<Response>,
    changeInStorage: (storage: SyncRelayStorage, link: Link, atMs: number) => unknown,
  ]> = [
    ["Reset link", resetLink, (storage, link, atMs) => storage.rotateLinkGrant({
      shareId: link.shareId,
      grantId: link.grantId,
      rotatedAtMs: atMs,
      expectedDependentGrantIds: [],
      guard: () => {},
      mintCredential: () => ({ credentialId: "raced-credential", secretHash: "raced-secret-hash" }),
    })],
    ["End link", endLink, (storage, link, atMs) =>
      storage.revokeShareGrant({ shareId: link.shareId, grantId: link.grantId, revokedAtMs: atMs })],
  ];

  describe.each(changes)("%s", (_name, change, changeInStorage) => {
    it("ends the link's connections, pending consent, and unredeemed codes", async () => {
      const f = await fixture();
      const link = await createLink(f);
      const other = await createLink(f, ["notes"]);
      const agent = await connect(f, link);
      const bystander = await connect(f, other);
      const pending = await beginRequest(f, link, agent.clientId);
      const code = await authorize(f, link, agent.clientId);

      await ok(await change(f, link));

      await expectRefused(await introspect(f, agent.accessToken));
      await expectRefused(await refresh(f, agent.clientId, agent.refreshToken, link.resource));
      await expectRefused(await internal(f, "agent-authorizations/consent", { requestId: pending }));
      await expectRefused(await decide(f, pending));
      await expectRefused(await redeem(f, { clientId: agent.clientId, code, resource: link.resource }));
      const remaining = inspect(f.dbPath, (db) => ({
        authorizations: db.prepare("SELECT COUNT(*) AS count FROM sync_relay_agent_authorizations WHERE grant_id = ?").get(link.grantId)?.count,
        tokens: db.prepare("SELECT COUNT(*) AS count FROM sync_relay_agent_tokens WHERE connection_id = ?").get(agent.connectionId)?.count,
        status: db.prepare("SELECT status FROM sync_relay_agent_connections WHERE connection_id = ?").get(agent.connectionId)?.status,
      }));
      expect(remaining).toEqual({ authorizations: 0, tokens: 0, status: "retired" });
      await ok(await introspect(f, bystander.accessToken));
    });

    it.each(["decision", "code exchange"] as const)("refuses an agent when the change lands during its %s", async (step) => {
      const f = await fixture();
      const link = await createLink(f);
      const clientId = await registerClient(f);
      const requestId = await beginRequest(f, link, clientId);
      const code = step === "code exchange" ? String((await ok(await decide(f, requestId))).code) : null;
      const landed: unknown[] = [];
      const racing = interceptStorage(f.storage, {
        decideAgentAuthorization: (target, input) => {
          landed.push(changeInStorage(target, link, f.now.value));
          return target.decideAgentAuthorization(input);
        },
        redeemAgentAuthorizationCode: (target, input) => {
          landed.push(changeInStorage(target, link, f.now.value));
          return target.redeemAgentAuthorizationCode(input);
        },
      });
      const raced: Fixture = { ...f, h: handler(racing, f.now) };
      if (step === "decision") {
        await expectRefused(await decide(raced, requestId));
      } else {
        await expectRefused(await redeem(raced, { clientId, code: code!, resource: link.resource }));
      }
      expect(landed).toEqual([expect.objectContaining({ ok: true })]);
      expect(rowCount(f.dbPath, "sync_relay_agent_connections")).toBe(0);
      expect(rowCount(f.dbPath, "sync_relay_agent_tokens")).toBe(0);
      expect(rowCount(f.dbPath, "sync_relay_agent_authorizations")).toBe(0);
    });
  });
});
