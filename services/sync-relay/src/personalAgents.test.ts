import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  ConsentCredentials,
  CredentialFence,
  CredentialFenceChange,
  CredentialFenceListener,
} from "@dohc/workspace-auth/credentialFence";
import { UnauthorizedError, type ResolveAccountSession } from "@dohc/workspace-auth/session";
import { DiscussionActivityHub } from "./discussionActivity";
import { errorResponse, notFound } from "./errors";
import { LINK_EXCHANGE_BUCKET_CAPACITY, pkceS256Challenge } from "./linkSecurity";
import { CREDENTIAL_FENCE_CATCH_UP_MARGIN_MS, PERSONAL_PASSWORD_ATTEMPTS, type PersonalRunningEntry } from "./personalAgents";
import type { createSyncRelayHandler } from "./server";
import type { SyncRelayStorage } from "./storage";
import { fenceAccount, initializeAccountDeletion } from "./storage/accountDeletion";
import type { StorageContext } from "./storage/context";
import { PERSONAL_PENDING_AUTHORIZATIONS_PER_WORKSPACE_LIMIT } from "./storage/personalAgents";
import {
  claimWorkspace,
  closeTestStorage,
  closeTestStorages,
  createShare,
  inspect,
  inspectDatabase,
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
  type HandlerOverrides,
} from "./testing";

const OWNER = "owner";
const OTHER = "other-account";
const WS_A = "workspace-a";
const WS_B = "workspace-b";
const OTHER_WS = "workspace-other";
const PASSWORD = "owner password";
const NEW_PASSWORD = "owner new password";
const OTHER_PASSWORD = "other password";
const REDIRECT = "http://127.0.0.1:43110/callback";
const VERIFIER = "agent-pkce-verifier-0123456789-abcdefghijklmnopqrstuvwxyz";
const DELETION_KEY = "personal-agent-deletion-key-at-least-32-bytes";
// "owner-new-session" began after the owner's last password change; the fake
// marks a session older than a change through `staleSessions`.
const SESSIONS: Record<string, string> = {
  "owner-session": OWNER,
  "owner-new-session": OWNER,
  "other-session": OTHER,
};

type Handler = ReturnType<typeof createSyncRelayHandler>;
type Level = "view" | "comment" | "edit";
type Reach = { workspaceId: string; level: Level }[];
type AgentChoice = { kind: "new"; name: string } | { kind: "existing"; agentId: string };
type Fixture = {
  storage: SyncRelayStorage;
  dbPath: string;
  h: Handler;
  now: { value: number };
  fence: FakeFence;
  activity: DiscussionActivityHub;
};
type Signed = {
  clientId: string;
  resource: string;
  accessToken: string;
  refreshToken: string;
  agentId: string;
  connectionId: string;
  fenceEpoch: number;
};

/** The Postgres fence as the relay sees it: epochs, password hashes, and the notification channel. */
class FakeFence implements CredentialFence {
  readonly epochs = new Map<string, number>();
  readonly passwords = new Map<string, string>([[OWNER, PASSWORD], [OTHER, OTHER_PASSWORD]]);
  /** Sessions that began before their account's last password change. */
  readonly staleSessions = new Set<string>();
  readonly changes: CredentialFenceChange[] = [];
  readonly changedSinceCalls: number[] = [];
  down = false;
  listener: CredentialFenceListener | undefined;
  /** A commit that lands just after consent's read. */
  afterConsentRead: (() => void) | undefined;
  verifyGate: Promise<void> | undefined;
  private clock = 1_000;

  async readEpoch(userId: string): Promise<number> {
    this.assertUp();
    return this.epochs.get(userId) ?? 0;
  }

  async readConsentCredentials(userId: string, sessionId: string): Promise<ConsentCredentials | null> {
    this.assertUp();
    const password = this.passwords.get(userId);
    const read = {
      passwordHash: password === undefined ? null : `hash:${password}`,
      epoch: this.epochs.get(userId) ?? 0,
      sessionCurrent: !this.staleSessions.has(sessionId),
    };
    const commit = this.afterConsentRead;
    this.afterConsentRead = undefined;
    commit?.();
    return read;
  }

  async verifyPassword(passwordHash: string, password: string): Promise<boolean> {
    await this.verifyGate;
    return passwordHash === `hash:${password}`;
  }

  async changedSince(positionMs: number): Promise<CredentialFenceChange[]> {
    this.changedSinceCalls.push(positionMs);
    this.assertUp();
    return this.changes.filter((change) => change.changedAtMs >= positionMs);
  }

  listen(listener: CredentialFenceListener): { close(): Promise<void> } {
    this.listener = listener;
    return {
      close: async () => {
        if (this.listener === listener) this.listener = undefined;
      },
    };
  }

  /** A password change commits. Its notification is the test's to deliver. */
  changePassword(userId: string, password: string, changedAtMs?: number): CredentialFenceChange {
    this.clock += 1_000;
    const change = { userId, epoch: (this.epochs.get(userId) ?? 0) + 1, changedAtMs: changedAtMs ?? this.clock };
    this.epochs.set(userId, change.epoch);
    this.passwords.set(userId, password);
    this.changes.push(change);
    return change;
  }

  private assertUp(): void {
    if (this.down) throw new Error("The database is unreachable.");
  }
}

const resolveSession: ResolveAccountSession = async (incoming) => {
  const sessionId = /(?:^|;\s*)session=([^;]+)/u.exec(incoming.headers.get("cookie") ?? "")?.[1];
  const userId = sessionId === undefined ? undefined : SESSIONS[sessionId];
  if (!sessionId || !userId) throw new UnauthorizedError();
  return { userId, sessionId, expiresAtMs: Number.MAX_SAFE_INTEGER };
};

const handlers: Handler[] = [];

afterEach(async () => {
  await Promise.all(handlers.splice(0).map((h) => h.dispose()));
  await closeTestStorages();
});

function handler(storage: SyncRelayStorage, f: Pick<Fixture, "now" | "fence" | "activity">, overrides: HandlerOverrides = {}): Handler {
  const h = testHandler(storage, {
    nowMs: () => f.now.value,
    relayExchangeKey: RELAY_EXCHANGE_KEY,
    credentialFence: f.fence,
    resolveAccountSession: resolveSession,
    discussionActivity: f.activity,
    ...overrides,
  });
  handlers.push(h);
  return h;
}

function probe(): PersonalRunningEntry {
  return { agentId: "probe", ownerUserId: "probe", connectionId: "probe", fenceEpoch: 0, workspaceIds: [], kind: "wait", terminate: () => {} };
}

/** The fence listener comes up and catches up, so running work can start. */
async function listening(f: Pick<Fixture, "fence" | "h">): Promise<void> {
  f.fence.listener!.onUp();
  await vi.waitFor(() => f.h.personalAgents.register(probe())());
}

async function fixture(overrides: HandlerOverrides = {}): Promise<Fixture> {
  const storage = await testStorage();
  const parts = { now: { value: 10_000 }, fence: new FakeFence(), activity: new DiscussionActivityHub() };
  const h = handler(storage, parts, overrides);
  await claimWorkspace(h, OWNER, WS_A);
  await claimWorkspace(h, OWNER, WS_B);
  await claimWorkspace(h, OTHER, OTHER_WS);
  const f = { storage, dbPath: storagePath(storage), h, ...parts };
  if (h.personalAgents.fence) await listening(f);
  return f;
}

function resourceFor(workspaceId: string): string {
  return `${SHARE_WEB_ORIGIN}/mcp/agent/w/${encodeURIComponent(workspaceId)}`;
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

async function expectCode(response: Response, status: number, code: string): Promise<void> {
  expect(response.status, await response.clone().text()).toBe(status);
  expect((await json(response)).code).toBe(code);
}

function cookie(session: string): Record<string, string> {
  return { cookie: `session=${session}` };
}

/** A call from share-web. `ip` is the address share-web reports for the caller. */
function internal(f: Fixture, path: string, body: unknown, headers: Record<string, string> = {}, ip?: string): Promise<Response> {
  const forwarded = request(null, `/sync/link/${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-dohc-relay-exchange-key": RELAY_EXCHANGE_KEY, ...headers },
    body: JSON.stringify(body),
  });
  if (ip !== undefined) forwarded.headers.set("x-dohc-relay-client-ip", ip);
  return f.h(forwarded);
}

async function registerClient(f: Fixture): Promise<string> {
  const body = await ok(await internal(f, "agent-clients", { registration: "registered", redirectUris: [REDIRECT], clientName: "Test agent" }));
  return String(body.clientId);
}

function begin(f: Fixture, clientId: string, resource: string, ip?: string): Promise<Response> {
  return internal(f, "agent-authorizations", {
    clientId,
    resource,
    redirectUri: REDIRECT,
    codeChallenge: pkceS256Challenge(VERIFIER),
    codeChallengeMethod: "S256",
    state: "agent-state",
  }, {}, ip);
}

async function beginRequest(f: Fixture, clientId: string, workspaceId = WS_A, ip?: string): Promise<string> {
  return String((await ok(await begin(f, clientId, resourceFor(workspaceId), ip))).requestId);
}

function consent(f: Fixture, requestId: string, session = "owner-session"): Promise<Response> {
  return internal(f, "agent-authorizations/personal-consent", { requestId }, cookie(session));
}

function allow(f: Fixture, requestId: string, input: {
  agent?: AgentChoice; reach?: Reach; password?: string; session?: string;
} = {}): Promise<Response> {
  return internal(f, "agent-authorizations/personal-decision", {
    requestId,
    decision: "allow",
    password: input.password ?? PASSWORD,
    agent: input.agent ?? { kind: "new", name: "Helper" },
    reach: input.reach ?? [{ workspaceId: WS_A, level: "view" }],
  }, cookie(input.session ?? "owner-session"));
}

/** A code the owner approved; not yet redeemed. */
async function approve(f: Fixture, input: {
  clientId: string; workspaceId?: string; agent?: AgentChoice; reach?: Reach; password?: string; session?: string;
}): Promise<{ code: string; resource: string }> {
  const workspaceId = input.workspaceId ?? WS_A;
  const requestId = await beginRequest(f, input.clientId, workspaceId);
  const allowed = await ok(await allow(f, requestId, input));
  expect(allowed).toMatchObject({ redirectUri: REDIRECT, state: "agent-state" });
  return { code: String(allowed.code), resource: resourceFor(workspaceId) };
}

function redeem(f: Fixture, input: { clientId: string; code: string; resource: string }): Promise<Response> {
  return internal(f, "agent-token", {
    grantType: "authorization_code",
    clientId: input.clientId,
    code: input.code,
    redirectUri: REDIRECT,
    codeVerifier: VERIFIER,
    resource: input.resource,
  });
}

function refresh(f: Fixture, clientId: string, refreshToken: string, resource: string): Promise<Response> {
  return internal(f, "agent-token", { grantType: "refresh_token", clientId, refreshToken, resource });
}

/** What share-web forwards for an agent's tool call. */
function agentRequest(accessToken: string, resource: string): Request {
  return new Request("http://relay.test/sync/link/agent-chat", {
    headers: {
      authorization: `DohcAgent ${accessToken}`,
      "x-dohc-agent-resource": resource,
      "x-dohc-relay-exchange-key": RELAY_EXCHANGE_KEY,
    },
  });
}

async function signIn(f: Fixture, input: {
  clientId?: string; workspaceId?: string; agent?: AgentChoice; reach?: Reach; password?: string; session?: string;
} = {}): Promise<Signed> {
  const clientId = input.clientId ?? await registerClient(f);
  const { code, resource } = await approve(f, { ...input, clientId });
  const tokens = await ok(await redeem(f, { clientId, code, resource }));
  const accessToken = String(tokens.accessToken);
  const authority = await f.h.linkAuthority.personal(agentRequest(accessToken, resource));
  return {
    clientId, resource, accessToken, refreshToken: String(tokens.refreshToken),
    agentId: authority.agentId, connectionId: authority.connectionId, fenceEpoch: authority.fenceEpoch,
  };
}

function expectPersonal(f: Fixture, signed: Pick<Signed, "accessToken" | "resource">) {
  return expect(f.h.linkAuthority.personal(agentRequest(signed.accessToken, signed.resource)));
}

/** Running work under a connection, registered as a wait or stream registers it. */
function running(f: Fixture, signed: Signed, workspaceIds: string[], kind: PersonalRunningEntry["kind"] = "stream") {
  const terminate = vi.fn();
  f.h.personalAgents.register({
    agentId: signed.agentId, ownerUserId: OWNER, connectionId: signed.connectionId, fenceEpoch: signed.fenceEpoch,
    workspaceIds, kind, terminate,
  });
  return terminate;
}

function owner(f: Fixture, path: string, init: { method: string; body?: unknown } = { method: "GET" }, userId = OWNER): Promise<Response> {
  return f.h(request(userId, `/sync/personal-agents${path}`, init.body === undefined ? { method: init.method } : {
    method: init.method, headers: { "content-type": "application/json" }, body: JSON.stringify(init.body),
  }));
}

async function roster(f: Fixture, userId = OWNER) {
  return await ok(await owner(f, "", { method: "GET" }, userId)) as {
    revision: number;
    agents: { agentId: string; name: string; hue: string; status: string; reportedProduct: string | null; reach: Reach }[];
    workspaces: { workspaceId: string; name: string | null }[];
  };
}

function count(f: Fixture, table: string, where = "1", ...params: unknown[]): number {
  return inspect(f.dbPath, (db) => Number(db.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE ${where}`).get(...params)?.count ?? 0));
}

function connectionTokens(f: Fixture, connectionId: string): number {
  return count(f, "sync_relay_personal_agent_tokens", "connection_id = ?", connectionId);
}

function thrown(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  return undefined;
}

describe("personal agent sign-in", () => {
  it("begins at a workspace's one address, only where the fence can be read", async () => {
    const f = await fixture();
    const clientId = await registerClient(f);
    const begun = await ok(await begin(f, clientId, resourceFor(WS_A)));
    expect(begun.requestId).toEqual(expect.any(String));
    expect(count(f, "sync_relay_personal_agent_authorizations")).toBe(1);
    expect(count(f, "sync_relay_agent_authorizations")).toBe(0);

    // Another spelling of the same address, a workspace nobody claimed, and a reserved id.
    await expectRefused(await begin(f, clientId, `${SHARE_WEB_ORIGIN}/mcp/agent/w/%77orkspace-a`));
    await expectRefused(await begin(f, clientId, resourceFor("workspace-unclaimed")));
    await expectRefused(await begin(f, clientId, resourceFor("personal-agents")));

    const withoutFence = await fixture({ credentialFence: undefined });
    await expectRefused(await begin(withoutFence, await registerClient(withoutFence), resourceFor(WS_A)));
  });

  it("counts every personal sign-in begun from an address, so a flood can't push out the owner's request", async () => {
    const f = await fixture();
    const clientId = await registerClient(f);
    const owners = await beginRequest(f, clientId, WS_A, "198.51.100.7");
    // Enough begins to fill the workspace's pending requests, all from one address.
    const statuses: number[] = [];
    for (let begun = 0; begun < PERSONAL_PENDING_AUTHORIZATIONS_PER_WORKSPACE_LIMIT; begun += 1) {
      statuses.push((await begin(f, clientId, resourceFor(WS_A), "203.0.113.9")).status);
    }
    expect(statuses.filter((status) => status === 200)).toHaveLength(LINK_EXCHANGE_BUCKET_CAPACITY);
    await expectCode(await begin(f, clientId, resourceFor(WS_A), "203.0.113.9"), 429, "link_read_rate_limited");

    // The owner's request is still there, and another address can still begin.
    await ok(await consent(f, owners));
    await ok(await begin(f, clientId, resourceFor(WS_A), "198.51.100.8"));
  });

  it("asks only the workspace's owner, and offers View and Comment over the workspaces it owns", async () => {
    const f = await fixture();
    const clientId = await registerClient(f);
    const requestId = await beginRequest(f, clientId);
    expect(await ok(await consent(f, requestId))).toMatchObject({
      reportedClientName: "Test agent",
      redirectUri: REDIRECT,
      workspaceId: WS_A,
      levels: ["view", "comment"],
      workspaces: [{ workspaceId: WS_A, name: null }, { workspaceId: WS_B, name: null }],
      agents: [],
    });
    // Another account signed in to the browser can't read or answer it.
    await expectRefused(await consent(f, requestId, "other-session"));
    await expectRefused(await allow(f, requestId, { session: "other-session", password: OTHER_PASSWORD }));
    // No session is a sign-in, not a refusal.
    expect((await internal(f, "agent-authorizations/personal-consent", { requestId })).status).toBe(401);

    // An address naming a workspace the account doesn't own.
    const elsewhere = await beginRequest(f, clientId, OTHER_WS);
    await expectRefused(await consent(f, elsewhere));
    await expectRefused(await allow(f, elsewhere));
    expect(await ok(await consent(f, elsewhere, "other-session"))).toMatchObject({
      workspaces: [{ workspaceId: OTHER_WS, name: null }],
    });

    // A reach naming another account's workspace, Edit, or nothing.
    await expectRefused(await allow(f, requestId, { reach: [{ workspaceId: OTHER_WS, level: "view" }] }));
    await expectRefused(await allow(f, requestId, { reach: [{ workspaceId: WS_A, level: "edit" }] }));
    await expectRefused(await allow(f, requestId, { reach: [] }));
    await ok(await allow(f, requestId, { reach: [{ workspaceId: WS_A, level: "comment" }, { workspaceId: WS_B, level: "view" }] }));
  });

  it("refuses redemption when the account no longer owns a workspace in the reach", async () => {
    const f = await fixture();
    const clientId = await registerClient(f);
    const { code, resource } = await approve(f, { clientId, reach: [{ workspaceId: WS_A, level: "view" }, { workspaceId: WS_B, level: "view" }] });
    const db = inspectDatabase(f.dbPath, { foreignKeys: true });
    db.prepare("UPDATE sync_relay_workspaces SET owner_user_id = ? WHERE workspace_id = ?").run(OTHER, WS_B);
    db.close();
    await expectRefused(await redeem(f, { clientId, code, resource }));
    expect((await roster(f)).agents).toEqual([]);

    const owned = await approve(f, { clientId });
    await ok(await redeem(f, { clientId, ...owned }));
  });

  it("creates the agent with its reach, name, color, and reported product", async () => {
    const f = await fixture();
    const signed = await signIn(f, { reach: [{ workspaceId: WS_B, level: "comment" }, { workspaceId: WS_A, level: "view" }] });
    expect(signed.agentId).toMatch(/^p-[a-z2-7]{26}$/u);
    expect(await roster(f)).toEqual({
      ok: true,
      revision: 1,
      agents: [expect.objectContaining({
        agentId: signed.agentId, name: "Helper", hue: "olive", status: "active", reportedProduct: "Test agent",
        reach: [{ workspaceId: WS_A, level: "view" }, { workspaceId: WS_B, level: "comment" }],
      })],
      workspaces: [{ workspaceId: WS_A, name: null }, { workspaceId: WS_B, name: null }],
    });
    // The next agent takes the next free color. The roster lists agents oldest first.
    f.now.value += 1_000;
    await signIn(f, { agent: { kind: "new", name: "Second" } });
    expect((await roster(f)).agents.map((agent) => agent.hue)).toEqual(["olive", "blue"]);
  });

  it("counts wrong passwords per account, as sign-in does", async () => {
    const f = await fixture();
    const clientId = await registerClient(f);
    const requestId = await beginRequest(f, clientId);
    for (let attempt = 0; attempt < PERSONAL_PASSWORD_ATTEMPTS; attempt++) {
      await expectCode(await allow(f, requestId, { password: "guess" }), 403, "password_incorrect");
    }
    await expectCode(await allow(f, requestId, { password: PASSWORD }), 429, "password_rate_limited");
    const elsewhere = await beginRequest(f, clientId, OTHER_WS);
    await ok(await allow(f, elsewhere, { session: "other-session", password: OTHER_PASSWORD, reach: [{ workspaceId: OTHER_WS, level: "view" }] }));
  });

  it("checks one password at a time per account", async () => {
    const f = await fixture();
    const requestId = await beginRequest(f, await registerClient(f));
    let open!: () => void;
    f.fence.verifyGate = new Promise<void>((resolve) => { open = resolve; });
    const first = allow(f, requestId, { password: "guess" });
    await expectCode(await allow(f, requestId, { password: "guess" }), 429, "password_rate_limited");
    open();
    await expectCode(await first, 403, "password_incorrect");
  });
});

describe("families never mix", () => {
  async function linkAgent(f: Fixture, clientId: string) {
    const shareId = await createShare(f.h, OWNER, WS_A, { recipientUserId: "seed-recipient", paths: ["docs"] });
    const link = await ok(await f.h(request(OWNER, `/sync/${WS_A}/shares/${shareId}/links`, jsonBody({ access: "view" }))));
    const resource = `${SHARE_WEB_ORIGIN}/mcp/s/${linkSecret(link.url)}`;
    const requestId = String((await ok(await begin(f, clientId, resource))).requestId);
    const code = String((await ok(await internal(f, "agent-authorizations/decision", { requestId, decision: "allow" }))).code);
    return { resource, code };
  }

  it("redeems and refreshes each family's credentials only in its own tables", async () => {
    const f = await fixture();
    const clientId = await registerClient(f);
    const link = await linkAgent(f, clientId);
    const personal = await approve(f, { clientId });

    // A code at the other family's address finds nothing, and stays unspent.
    await expectRefused(await redeem(f, { clientId, code: link.code, resource: personal.resource }));
    await expectRefused(await redeem(f, { clientId, code: personal.code, resource: link.resource }));
    const linkTokens = await ok(await redeem(f, { clientId, ...link }));
    const personalTokens = await ok(await redeem(f, { clientId, ...personal }));

    await expectRefused(await refresh(f, clientId, String(linkTokens.refreshToken), personal.resource));
    await expectRefused(await refresh(f, clientId, String(personalTokens.refreshToken), link.resource));
    await ok(await refresh(f, clientId, String(linkTokens.refreshToken), link.resource));
    await ok(await refresh(f, clientId, String(personalTokens.refreshToken), personal.resource));

    // A personal token is unknown to the link introspection.
    await expectRefused(await internal(f, "agent-introspect", { accessToken: String(personalTokens.accessToken) }));
  });

  it("resolves each family's token only as its own kind at tool calls", async () => {
    const f = await fixture();
    const clientId = await registerClient(f);
    const link = await linkAgent(f, clientId);
    const linkAccess = String((await ok(await redeem(f, { clientId, ...link }))).accessToken);
    const personal = await signIn(f, { clientId });

    await expect(f.h.linkAuthority.personal(agentRequest(linkAccess, link.resource))).rejects.toMatchObject({ code: "not_found" });
    await expect(f.h.linkAuthority.personal(agentRequest(linkAccess, personal.resource))).rejects.toMatchObject({ code: "not_found" });
    expect(thrown(() => f.h.linkAuthority.resolve(agentRequest(personal.accessToken, personal.resource)))).toMatchObject({ code: "not_found" });
    expect(thrown(() => f.h.linkAuthority.resolve(agentRequest(personal.accessToken, link.resource)))).toMatchObject({ code: "not_found" });

    expect(f.h.linkAuthority.resolve(agentRequest(linkAccess, link.resource)).credential.kind).toBe("agent");
    await expectPersonal(f, personal).resolves.toMatchObject({ kind: "personal", agentId: personal.agentId, ownerUserId: OWNER });
    // A personal check needs the exchange key and never takes a browser's cookie.
    const withCookie = agentRequest(personal.accessToken, personal.resource);
    withCookie.headers.set("cookie", "session=owner-session");
    await expect(f.h.linkAuthority.personal(withCookie)).rejects.toMatchObject({ code: "not_found" });
    const withoutKey = agentRequest(personal.accessToken, personal.resource);
    withoutKey.headers.delete("x-dohc-relay-exchange-key");
    await expect(f.h.linkAuthority.personal(withoutKey)).rejects.toMatchObject({ code: "not_found" });
  });

  it("refuses a token at another workspace's address, even one in the agent's reach", async () => {
    const f = await fixture();
    const agent = await signIn(f, { reach: [{ workspaceId: WS_A, level: "view" }, { workspaceId: WS_B, level: "view" }] });
    await expect(f.h.linkAuthority.personal(agentRequest(agent.accessToken, resourceFor(WS_B))))
      .rejects.toMatchObject({ code: "not_found" });
    await expectPersonal(f, agent).resolves.toMatchObject({ connectionId: agent.connectionId });
  });

  it("refuses an agent's token at the owner's routes", async () => {
    const f = await fixture();
    const signed = await signIn(f);
    const asAgent = (path: string, init: RequestInit = {}) => f.h(new Request(`http://relay.test${path}`, {
      ...init,
      headers: {
        authorization: `DohcAgent ${signed.accessToken}`,
        "x-dohc-agent-resource": signed.resource,
        "x-dohc-relay-exchange-key": RELAY_EXCHANGE_KEY,
        "content-type": "application/json",
      },
    }));
    expect((await asAgent("/sync/personal-agents")).status).toBe(404);
    expect((await asAgent(`/sync/personal-agents/${signed.agentId}/sign-out`, { method: "POST" })).status).toBe(404);
    expect((await asAgent(`/sync/personal-agents/${signed.agentId}/reach`, {
      method: "PUT", body: JSON.stringify({ reach: [{ workspaceId: WS_B, level: "comment" }] }),
    })).status).toBe(404);
    // A browser's cookie beside the account's bearer is refused too.
    expect((await f.h(request(OWNER, "/sync/personal-agents", { headers: cookie("owner-session") }))).status).toBe(404);

    expect((await roster(f)).agents).toEqual([expect.objectContaining({ status: "active", reach: [{ workspaceId: WS_A, level: "view" }] })]);
    await expectPersonal(f, signed).resolves.toMatchObject({ agentId: signed.agentId });
  });
});

describe("revocation", () => {
  it("refuses a code approved before the agent's reach changed", async () => {
    const f = await fixture();
    const agent = await signIn(f, { reach: [{ workspaceId: WS_A, level: "view" }, { workspaceId: WS_B, level: "view" }] });
    const existing = { kind: "existing" as const, agentId: agent.agentId };

    // Approved for A and B, then narrowed to A.
    const narrowed = await approve(f, { clientId: agent.clientId, agent: existing,
      reach: [{ workspaceId: WS_A, level: "view" }, { workspaceId: WS_B, level: "view" }] });
    const fresh = await approve(f, { clientId: agent.clientId, agent: { kind: "new", name: "Unrelated" } });
    await ok(await owner(f, `/${agent.agentId}/reach`, { method: "PUT", body: { reach: [{ workspaceId: WS_A, level: "view" }] } }));
    await expectRefused(await redeem(f, { clientId: agent.clientId, ...narrowed }));
    expect((await roster(f)).agents.find((row) => row.agentId === agent.agentId)?.reach).toEqual([{ workspaceId: WS_A, level: "view" }]);

    // Approved for A, then widened to A and B.
    const widened = await approve(f, { clientId: agent.clientId, agent: existing });
    await ok(await owner(f, `/${agent.agentId}/reach`, { method: "PUT", body: {
      reach: [{ workspaceId: WS_A, level: "view" }, { workspaceId: WS_B, level: "view" }],
    } }));
    await expectRefused(await redeem(f, { clientId: agent.clientId, ...widened }));

    // A request for a new agent isn't tied to this one.
    await ok(await redeem(f, { clientId: agent.clientId, ...fresh }));
    // Without a change between, the code redeems, and reach is exactly its choice.
    const kept = await approve(f, { clientId: agent.clientId, agent: existing, reach: [{ workspaceId: WS_B, level: "comment" }] });
    await ok(await redeem(f, { clientId: agent.clientId, ...kept }));
    expect((await roster(f)).agents.find((row) => row.agentId === agent.agentId)?.reach).toEqual([{ workspaceId: WS_B, level: "comment" }]);
  });

  it("refuses a pending code after Sign out, Remove, signing in again, or a password reset", async () => {
    const f = await fixture();
    const agent = await signIn(f);
    const existing = { kind: "existing" as const, agentId: agent.agentId };
    const redeemIt = (code: { code: string; resource: string }) => redeem(f, { clientId: agent.clientId, ...code });

    const beforeSignOut = await approve(f, { clientId: agent.clientId, agent: existing });
    await ok(await owner(f, `/${agent.agentId}/sign-out`, { method: "POST" }));
    await expectRefused(await redeemIt(beforeSignOut));

    const beforeRemove = await approve(f, { clientId: agent.clientId, agent: existing });
    await ok(await owner(f, `/${agent.agentId}/remove`, { method: "POST" }));
    await ok(await owner(f, `/${agent.agentId}/restore`, { method: "POST" }));
    await expectRefused(await redeemIt(beforeRemove));

    const first = await approve(f, { clientId: agent.clientId, agent: existing });
    const second = await approve(f, { clientId: agent.clientId, agent: existing });
    await ok(await redeemIt(first));
    await expectRefused(await redeemIt(second));

    const beforeReset = await approve(f, { clientId: agent.clientId, agent: existing });
    const newAgentBeforeReset = await approve(f, { clientId: agent.clientId });
    f.fence.changePassword(OWNER, NEW_PASSWORD);
    await expectRefused(await redeemIt(beforeReset));
    await expectRefused(await redeemIt(newAgentBeforeReset));
    await ok(await redeemIt(await approve(f, { clientId: agent.clientId, agent: existing, password: NEW_PASSWORD, session: "owner-new-session" })));
  });

  it("signing in again ends the agent's old connections, and its reach becomes the new choice", async () => {
    const f = await fixture();
    const before = await signIn(f, { reach: [{ workspaceId: WS_A, level: "view" }, { workspaceId: WS_B, level: "view" }] });
    const stream = running(f, before, [WS_A]);
    const after = await signIn(f, {
      clientId: before.clientId,
      agent: { kind: "existing", agentId: before.agentId },
      reach: [{ workspaceId: WS_B, level: "comment" }],
    });
    expect(after.agentId).toBe(before.agentId);
    expect(after.connectionId).not.toBe(before.connectionId);

    await expectPersonal(f, before).rejects.toMatchObject({ code: "not_found" });
    await expectRefused(await refresh(f, before.clientId, before.refreshToken, before.resource));
    expect(connectionTokens(f, before.connectionId)).toBe(0);
    expect(stream).toHaveBeenCalledTimes(1);
    expect((await roster(f)).agents).toEqual([expect.objectContaining({
      agentId: before.agentId, status: "active", reach: [{ workspaceId: WS_B, level: "comment" }],
    })]);
    await expectPersonal(f, after).resolves.toMatchObject({ connectionId: after.connectionId, agentEpoch: 2 });
  });

  it("ends the connection when an old refresh token comes back", async () => {
    const f = await fixture();
    const agent = await signIn(f);
    const rotated = await ok(await refresh(f, agent.clientId, agent.refreshToken, agent.resource));
    await expectPersonal(f, { accessToken: String(rotated.accessToken), resource: agent.resource }).resolves.toMatchObject({
      connectionId: agent.connectionId,
    });

    await expectRefused(await refresh(f, agent.clientId, agent.refreshToken, agent.resource));
    await expectRefused(await refresh(f, agent.clientId, String(rotated.refreshToken), agent.resource));
    await expectPersonal(f, { accessToken: String(rotated.accessToken), resource: agent.resource }).rejects.toMatchObject({ code: "not_found" });
    expect(count(f, "sync_relay_personal_agent_connections", "connection_id = ?", agent.connectionId)).toBe(0);
    // With nothing left to sign in with, the roster shows it signed out.
    expect((await roster(f)).agents).toEqual([expect.objectContaining({ agentId: agent.agentId, status: "signed_out" })]);
  });

  it("refuses a refresh from another client, and keeps the token for its own", async () => {
    const f = await fixture();
    const agent = await signIn(f);
    const otherClientId = await registerClient(f);
    await expectRefused(await refresh(f, otherClientId, agent.refreshToken, agent.resource));
    await ok(await refresh(f, agent.clientId, agent.refreshToken, agent.resource));
  });

  it("refuses a request, write, redemption, and refresh once a reset commits, before any notification", async () => {
    const f = await fixture();
    const agent = await signIn(f);
    const authority = await f.h.linkAuthority.personal(agentRequest(agent.accessToken, agent.resource));
    await expect(f.h.linkAuthority.freshPersonal(authority)).resolves.toMatchObject({ connectionId: agent.connectionId });
    const pending = await approve(f, { clientId: agent.clientId });

    f.fence.changePassword(OWNER, NEW_PASSWORD);
    await expectPersonal(f, agent).rejects.toMatchObject({ code: "not_found" });
    await expect(f.h.linkAuthority.freshPersonal(authority)).rejects.toMatchObject({ code: "not_found" });
    await expectRefused(await redeem(f, { clientId: agent.clientId, ...pending }));
    await expectRefused(await refresh(f, agent.clientId, agent.refreshToken, agent.resource));
    // The direct read refused them: no notification arrived, so nothing was cleaned up.
    expect(connectionTokens(f, agent.connectionId)).toBe(2);
  });

  it("accepts consent only with the password at the current fence", async () => {
    const f = await fixture();
    const clientId = await registerClient(f);
    f.fence.changePassword(OWNER, NEW_PASSWORD);
    f.fence.staleSessions.add("owner-session");

    // A session from before the change signs in again first.
    const fromOldSession = await beginRequest(f, clientId);
    await expectCode(await consent(f, fromOldSession), 403, "sign_in_again");
    await expectCode(await allow(f, fromOldSession, { password: PASSWORD }), 403, "sign_in_again");
    // A session made after the change, including a sign-in that read the old hash, still needs the new password.
    await expectCode(await allow(f, fromOldSession, { password: PASSWORD, session: "owner-new-session" }), 403, "password_incorrect");
    const code = String((await ok(await allow(f, fromOldSession, { password: NEW_PASSWORD, session: "owner-new-session" }))).code);
    const tokens = await ok(await redeem(f, { clientId, code, resource: resourceFor(WS_A) }));
    await expectPersonal(f, { accessToken: String(tokens.accessToken), resource: resourceFor(WS_A) }).resolves.toMatchObject({ fenceEpoch: 1 });

    // A reset committed just after consent's read: the code holds the older fence and fails redemption.
    const raced = await beginRequest(f, clientId);
    f.fence.afterConsentRead = () => f.fence.changePassword(OWNER, "owner third password");
    const racedCode = String((await ok(await allow(f, raced, { password: NEW_PASSWORD, session: "owner-new-session" }))).code);
    await expectRefused(await redeem(f, { clientId, code: racedCode, resource: resourceFor(WS_A) }));
  });

  it("asks a session that kept its sign-in through a password change to sign in again", async () => {
    const f = await fixture();
    const clientId = await registerClient(f);
    const requestId = await beginRequest(f, clientId);
    f.fence.changePassword(OWNER, NEW_PASSWORD);
    f.fence.staleSessions.add("owner-session");
    await expectCode(await consent(f, requestId), 403, "sign_in_again");
    await ok(await consent(f, requestId, "owner-new-session"));
  });

  it("keeps credentials and running work from the new fence when a late notification arrives", async () => {
    const f = await fixture();
    const wake = vi.spyOn(f.activity, "wakeLog");
    const old = await signIn(f, { reach: [{ workspaceId: WS_B, level: "view" }] });
    const oldStream = running(f, old, [WS_B]);
    const change = f.fence.changePassword(OWNER, NEW_PASSWORD);
    const current = await signIn(f, { password: NEW_PASSWORD, session: "owner-new-session" });
    expect(current.fenceEpoch).toBe(1);
    const currentLive = running(f, current, [WS_A], "live");
    const currentStream = running(f, current, [WS_A]);
    const before = (await roster(f)).revision;

    f.fence.listener!.onChange(change);
    expect(oldStream).toHaveBeenCalledTimes(1);
    expect(currentLive).not.toHaveBeenCalled();
    expect(currentStream).not.toHaveBeenCalled();
    expect(wake).toHaveBeenCalledWith(WS_B);
    expect(connectionTokens(f, old.connectionId)).toBe(0);
    expect(connectionTokens(f, current.connectionId)).toBe(2);
    await expectPersonal(f, current).resolves.toMatchObject({ connectionId: current.connectionId });
    expect(f.storage.readCredentialFencePosition()).toBe(change.changedAtMs);
    // The owner sees the old agent signed out, and the one signed in at the new fence still active.
    const after = await roster(f);
    expect(after.revision).toBe(before + 1);
    expect(new Map(after.agents.map((agent) => [agent.agentId, agent.status]))).toEqual(new Map([
      [old.agentId, "signed_out"],
      [current.agentId, "active"],
    ]));
  });

  it("signs out each agent a password change left with nothing to sign in with, once", async () => {
    const f = await fixture();
    const left = await signIn(f);
    const again = await signIn(f);
    const waiting = await signIn(f);
    const change = f.fence.changePassword(OWNER, NEW_PASSWORD);
    // After the change, one agent signs in again, and the owner approves another's sign-in that it hasn't redeemed.
    const newSignIn = { password: NEW_PASSWORD, session: "owner-new-session" };
    await signIn(f, { ...newSignIn, clientId: again.clientId, agent: { kind: "existing", agentId: again.agentId } });
    const code = await approve(f, { ...newSignIn, clientId: waiting.clientId, agent: { kind: "existing", agentId: waiting.agentId } });
    const before = (await roster(f)).revision;

    f.fence.listener!.onChange(change);
    const after = await roster(f);
    expect(after.revision).toBe(before + 1);
    expect(new Map(after.agents.map((agent) => [agent.agentId, agent.status]))).toEqual(new Map([
      [left.agentId, "signed_out"],
      [again.agentId, "active"],
      [waiting.agentId, "active"],
    ]));

    // The same notice again changes nothing.
    f.fence.listener!.onChange(change);
    expect((await roster(f)).revision).toBe(after.revision);
    // The approved sign-in still redeems: its agent kept its epoch.
    await ok(await redeem(f, { clientId: waiting.clientId, ...code }));
  });

  it("ends running work while the notification channel is down, and keeps checking the fence directly", async () => {
    const f = await fixture();
    const agent = await signIn(f, { reach: [{ workspaceId: WS_A, level: "view" }, { workspaceId: WS_B, level: "view" }] });
    const wait = running(f, agent, [WS_A], "wait");
    const stream = running(f, agent, [WS_B]);

    f.fence.listener!.onDown();
    expect(wait).toHaveBeenCalledTimes(1);
    expect(stream).toHaveBeenCalledTimes(1);
    expect(thrown(() => running(f, agent, [WS_A], "wait"))).toMatchObject({ code: "personal_agent_unavailable", statusCode: 503 });
    await expectPersonal(f, agent).resolves.toMatchObject({ connectionId: agent.connectionId });

    f.fence.changePassword(OWNER, NEW_PASSWORD);
    await expectPersonal(f, agent).rejects.toMatchObject({ code: "not_found" });

    // Back up: catch-up reads the change it missed before new work starts.
    await listening(f);
    expect(connectionTokens(f, agent.connectionId)).toBe(0);
  });

  it("fails closed with 503 while Postgres is down", async () => {
    const f = await fixture();
    const agent = await signIn(f);
    const pending = await approve(f, { clientId: agent.clientId });
    const requestId = await beginRequest(f, agent.clientId);
    f.fence.down = true;

    await expectPersonal(f, agent).rejects.toMatchObject({ code: "personal_agent_unavailable", statusCode: 503 });
    await expectCode(await redeem(f, { clientId: agent.clientId, ...pending }), 503, "personal_agent_unavailable");
    await expectCode(await refresh(f, agent.clientId, agent.refreshToken, agent.resource), 503, "personal_agent_unavailable");
    await expectCode(await consent(f, requestId), 503, "personal_agent_unavailable");
    await expectCode(await allow(f, requestId), 503, "personal_agent_unavailable");
    // The owner's controls create no credentials, so they don't need it.
    expect((await roster(f)).agents).toHaveLength(1);

    f.fence.down = false;
    await expectPersonal(f, agent).resolves.toMatchObject({ connectionId: agent.connectionId });
    await ok(await redeem(f, { clientId: agent.clientId, ...pending }));
  });

  it("catches up from the stored position at startup and deletes stale credentials", async () => {
    const f = await fixture();
    const agent = await signIn(f);
    f.fence.changePassword(OWNER, NEW_PASSWORD, 40_000);
    f.storage.advanceCredentialFencePosition(70_000);

    await f.h.dispose();
    closeTestStorage(f.storage);
    const storage = reopenTestStorage(f.dbPath);
    const restarted = { ...f, storage, h: handler(storage, f) };
    await listening(restarted);

    expect(f.fence.changedSinceCalls.at(-1)).toBe(70_000 - CREDENTIAL_FENCE_CATCH_UP_MARGIN_MS);
    expect(connectionTokens(restarted, agent.connectionId)).toBe(0);
    expect(storage.readCredentialFencePosition()).toBe(70_000);
  });

  it("signs out the account's agents and ends their running work at account deletion's fence, before purge", async () => {
    const f = await fixture();
    const wake = vi.spyOn(f.activity, "wakeLog");
    const agent = await signIn(f, { reach: [{ workspaceId: WS_A, level: "view" }, { workspaceId: WS_B, level: "view" }] });
    const stream = running(f, agent, [WS_A]);
    const wait = running(f, agent, [WS_B], "wait");
    const pending = await approve(f, { clientId: agent.clientId });

    const context = f.storage as StorageContext;
    initializeAccountDeletion(context, DELETION_KEY);
    const job = fenceAccount(context, DELETION_KEY, OWNER, `${OWNER}@dohc.test`);
    f.h.deleteAccount(OWNER, job.manifest!.workspaces.map((row) => row.workspaceId), job.manifest!.shareIds);

    expect(stream).toHaveBeenCalledTimes(1);
    expect(wait).toHaveBeenCalledTimes(1);
    expect(wake).toHaveBeenCalledWith(WS_A);
    expect(wake).toHaveBeenCalledWith(WS_B);
    await expectPersonal(f, agent).rejects.toMatchObject({ code: "not_found" });
    await expectRefused(await redeem(f, { clientId: agent.clientId, ...pending }));
    expect(connectionTokens(f, agent.connectionId)).toBe(0);
    // Purge hasn't run: the agent's row is still there, signed out.
    expect(count(f, "sync_relay_personal_agents", "agent_id = ? AND status = 'signed_out'", agent.agentId)).toBe(1);
  });

  it("keeps a signed-in agent's token across a relay reopen", async () => {
    const f = await fixture();
    const agent = await signIn(f);
    await f.h.dispose();
    closeTestStorage(f.storage);
    const storage = reopenTestStorage(f.dbPath);
    const reopened = { ...f, storage, h: handler(storage, f) };

    await expectPersonal(reopened, agent).resolves.toMatchObject({ agentId: agent.agentId, connectionId: agent.connectionId });
    await ok(await refresh(reopened, agent.clientId, agent.refreshToken, agent.resource));
  });
});

describe("the owner's controls", () => {
  it("renames, colors, sets reach, signs out, removes, and restores, with the roster revision", async () => {
    const f = await fixture();
    const agent = await signIn(f);
    const path = `/${agent.agentId}`;
    const revisions = [(await roster(f)).revision];
    const changed = async (response: Response) => {
      const body = await ok(response);
      revisions.push(Number(body.revision));
      return body.agent as Record<string, unknown>;
    };

    expect(await changed(await owner(f, `${path}/name`, { method: "PUT", body: { name: "Research" } }))).toMatchObject({ name: "Research" });
    expect(await changed(await owner(f, `${path}/hue`, { method: "PUT", body: { hue: "teal" } }))).toMatchObject({ hue: "teal" });
    expect((await owner(f, `${path}/hue`, { method: "PUT", body: { hue: "neon" } })).status).toBe(400);
    expect(await changed(await owner(f, `${path}/reach`, { method: "PUT", body: {
      reach: [{ workspaceId: WS_A, level: "comment" }, { workspaceId: WS_B, level: "view" }],
    } }))).toMatchObject({ reach: [{ workspaceId: WS_A, level: "comment" }, { workspaceId: WS_B, level: "view" }] });
    // Remove follows Sign out.
    await expectCode(await owner(f, `${path}/remove`, { method: "POST" }), 409, "conflict");
    expect(await changed(await owner(f, `${path}/sign-out`, { method: "POST" }))).toMatchObject({ status: "signed_out" });
    await expectPersonal(f, agent).rejects.toMatchObject({ code: "not_found" });
    expect(await changed(await owner(f, `${path}/remove`, { method: "POST" }))).toMatchObject({ status: "removed" });
    expect((await roster(f)).agents).toEqual([]);
    expect(await changed(await owner(f, `${path}/restore`, { method: "POST" }))).toMatchObject({ status: "signed_out", name: "Research" });

    expect(revisions).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect((await roster(f)).revision).toBe(7);
  });

  it("answers only the agent's own account", async () => {
    const f = await fixture();
    const agent = await signIn(f);
    await expectRefused(await owner(f, `/${agent.agentId}/name`, { method: "PUT", body: { name: "Mine" } }, OTHER));
    await expectRefused(await owner(f, `/${agent.agentId}/sign-out`, { method: "POST" }, OTHER));
    await expectRefused(await owner(f, `/p-${"a".repeat(26)}/name`, { method: "PUT", body: { name: "Nobody" } }));
    expect((await roster(f, OTHER)).agents).toEqual([]);
    expect((await roster(f)).agents).toEqual([expect.objectContaining({ name: "Helper", status: "active" })]);
    await expectPersonal(f, agent).resolves.toMatchObject({ agentId: agent.agentId });
  });

  it("sets reach only to the account's own workspaces, at View or Comment", async () => {
    const f = await fixture();
    const agent = await signIn(f);
    const setReach = (reach: unknown) => owner(f, `/${agent.agentId}/reach`, { method: "PUT", body: { reach } });
    expect((await setReach([{ workspaceId: OTHER_WS, level: "view" }])).status).toBe(400);
    expect((await setReach([{ workspaceId: WS_A, level: "edit" }])).status).toBe(400);
    expect((await setReach([{ workspaceId: WS_A, level: "view" }, { workspaceId: WS_A, level: "comment" }])).status).toBe(400);
    expect((await setReach([{ workspaceId: WS_A, level: "view", extra: 1 }])).status).toBe(400);
    expect((await owner(f, `/${agent.agentId}/reach`, { method: "POST" })).status).toBe(405);
    expect((await roster(f)).agents[0]?.reach).toEqual([{ workspaceId: WS_A, level: "view" }]);
  });

  it("ends running work in a workspace leaving reach, and wakes the logs it held", async () => {
    const f = await fixture();
    const wake = vi.spyOn(f.activity, "wakeLog");
    const agent = await signIn(f, { reach: [{ workspaceId: WS_A, level: "view" }, { workspaceId: WS_B, level: "view" }] });
    const inA = running(f, agent, [WS_A]);
    const inB = running(f, agent, [WS_B], "wait");

    await ok(await owner(f, `/${agent.agentId}/reach`, { method: "PUT", body: { reach: [{ workspaceId: WS_A, level: "view" }] } }));
    expect(inB).toHaveBeenCalledTimes(1);
    expect(inA).not.toHaveBeenCalled();
    expect(wake).toHaveBeenCalledWith(WS_A);
    expect(wake).toHaveBeenCalledWith(WS_B);

    await ok(await owner(f, `/${agent.agentId}/sign-out`, { method: "POST" }));
    expect(inA).toHaveBeenCalledTimes(1);
  });
});
