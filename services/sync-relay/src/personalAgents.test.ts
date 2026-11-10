import { afterEach, describe, expect, it, vi } from "vitest";
import { agentChannelWireId } from "@dohc/security-contract/chat-wire-ids";
import { accountDeletionIdentity } from "@dohc/workspace-auth/accountDeletion";
import type {
  ConsentCredentials,
  CredentialFence,
  CredentialFenceChange,
  CredentialFenceListener,
} from "@dohc/workspace-auth/credentialFence";
import { UnauthorizedError, type ResolveAccountSession } from "@dohc/workspace-auth/session";
import { MAX_AGENT_CHAT_WAITS_PER_CONNECTION } from "./agentChatRoutes";
import { DiscussionActivityHub } from "./discussionActivity";
import { errorResponse, notFound } from "./errors";
import { LINK_EXCHANGE_BUCKET_CAPACITY, pkceS256Challenge } from "./linkSecurity";
import { MAX_PERSONAL_WAITS_PER_ACCOUNT, PERSONAL_WAIT_MAX_MESSAGES } from "./personalAgentRoutes";
import { CREDENTIAL_FENCE_CATCH_UP_MARGIN_MS, PERSONAL_PASSWORD_ATTEMPTS, type PersonalRunningEntry } from "./personalAgents";
import { personalAgentOrigin, PERSONAL_MESSAGE_ID_PREFIX, PERSONAL_THREAD_ID_PREFIX } from "./relayLogInputs";
import type { createSyncRelayHandler } from "./server";
import type { SyncRelayStorage } from "./storage";
import { fenceAccount, initializeAccountDeletion } from "./storage/accountDeletion";
import type { StorageContext } from "./storage/context";
import { CHAT_HISTORY_SCAN_BYTES, CHAT_HISTORY_SCAN_WINDOW } from "./storage/log";
import { PERSONAL_PENDING_AUTHORIZATIONS_PER_WORKSPACE_LIMIT } from "./storage/personalAgents";
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
  json,
  jsonBody,
  linkSecret,
  moment,
  putBlob,
  RELAY_EXCHANGE_KEY,
  reopenTestStorage,
  request,
  sequenced,
  SHARE_WEB_ORIGIN,
  storagePath,
  testHandler,
  testStorage,
  type ChatOp,
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
    // Account sessions live in the same Postgres as the fence.
    resolveAccountSession: async (incoming) => {
      if (f.fence.down) throw new Error("The database is unreachable.");
      return await resolveSession(incoming);
    },
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

    const terminate = running(f, agent, [WS_A]);
    await expectRefused(await refresh(f, agent.clientId, agent.refreshToken, agent.resource));
    expect(terminate).toHaveBeenCalledOnce();
    await expectRefused(await refresh(f, agent.clientId, String(rotated.refreshToken), agent.resource));
    await expectPersonal(f, { accessToken: String(rotated.accessToken), resource: agent.resource }).rejects.toMatchObject({ code: "not_found" });
    expect(count(f, "sync_relay_personal_agent_connections", "connection_id = ?", agent.connectionId)).toBe(0);
    // With nothing left to sign in with, the roster shows it signed out.
    expect((await roster(f)).agents).toEqual([expect.objectContaining({ agentId: agent.agentId, status: "signed_out" })]);
  });

  it("ends the connection and its running work when a redeemed code comes back", async () => {
    const f = await fixture();
    const clientId = await registerClient(f);
    const { code, resource } = await approve(f, { clientId });
    const tokens = await ok(await redeem(f, { clientId, code, resource }));
    const accessToken = String(tokens.accessToken);
    const authority = await f.h.linkAuthority.personal(agentRequest(accessToken, resource));
    const terminate = running(f, {
      clientId, resource, accessToken, refreshToken: String(tokens.refreshToken),
      agentId: authority.agentId, connectionId: authority.connectionId, fenceEpoch: authority.fenceEpoch,
    }, [WS_A]);

    await expectRefused(await redeem(f, { clientId, code, resource }));
    expect(terminate).toHaveBeenCalledOnce();
    await expectPersonal(f, { accessToken, resource }).rejects.toMatchObject({ code: "not_found" });
    expect((await roster(f)).agents).toEqual([expect.objectContaining({ agentId: authority.agentId, status: "signed_out" })]);
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

type WaitCursor = { v: 1; agentId: string; seqs: Record<string, number>; turn: string | null };
type WaitAnswer = { ok: true; messages: Array<Record<string, unknown>>; cursor: WaitCursor; more: boolean };
type ChatPage = { messages: Array<Record<string, unknown>>; olderCursor: number | null };

const computerSeqs = new WeakMap<SyncRelayStorage, Map<string, number>>();

/** The owner's computer pushes these ops, and held waits wake. */
function fromComputer(f: Fixture, workspaceId: string, ops: ChatOp[]): void {
  const seqs = computerSeqs.get(f.storage) ?? new Map<string, number>();
  computerSeqs.set(f.storage, seqs);
  for (let start = 0; start < ops.length; start += 500) {
    const batch = ops.slice(start, start + 500);
    const first = seqs.get(workspaceId) ?? 0;
    f.storage.appendLogBatch({
      workspaceId, originId: "owner-computer",
      ops: sequenced(batch, first).map(({ payload, ...op }) => ({ ...op, payloadJson: JSON.stringify(payload) })),
    });
    seqs.set(workspaceId, first + batch.length);
  }
  f.activity.wakeLog(workspaceId);
}

/** A post by the owner's account from their computer. */
function ownerSays(messageId: string, threadId: string, body: string, extra: Record<string, unknown> = {}): ChatOp {
  return chatMessageAppend(messageId, threadId, body, { authorUserId: OWNER, authorDisplayName: "Ada", ...extra });
}

/** A thread on a file, bound by the file's object id or by its path. */
function fileThread(threadId: string, binding: Record<string, string>): ChatOp {
  return { opKind: "chat.thread.create", payload: { threadId, title: "", createdAtMs: 2, linkedAtMs: 2, ...binding } };
}

/** A team channel with two threads, and a thread in the agent's DM. */
function chats(f: Fixture, workspaceId: string, agentId: string): void {
  fromComputer(f, workspaceId, [
    chatChannelCreate("wire-team"),
    chatThreadCreate("thread-team", "wire-team"),
    chatThreadCreate("thread-other", "wire-team"),
    chatThreadCreate("thread-dm", agentChannelWireId(agentId)),
  ]);
}

/** A personal agent's tool call, as share-web forwards it. A stream is sent as the body as it arrives. */
function tool(
  f: Fixture, agent: Pick<Signed, "accessToken" | "resource">, action: string, body: unknown, signal?: AbortSignal,
): Promise<Response> {
  return f.h(request(null, `/sync/link/personal-agent/${action}`, {
    method: "POST",
    headers: {
      authorization: `DohcAgent ${agent.accessToken}`,
      "x-dohc-agent-resource": agent.resource,
      "x-dohc-relay-exchange-key": RELAY_EXCHANGE_KEY,
      "content-type": "application/json",
    },
    ...(body instanceof ReadableStream ? { body, duplex: "half" } : { body: JSON.stringify(body) }),
    ...(signal === undefined ? {} : { signal }),
  } as RequestInit));
}

function post(f: Fixture, agent: Signed, fields: Record<string, unknown>): Promise<Response> {
  return tool(f, agent, "post", { workspaceId: WS_A, body: "from the agent", idempotencyKey: "post-1", ...fields });
}

async function waitOnce(f: Fixture, agent: Signed, fields: Record<string, unknown> = {}): Promise<WaitAnswer> {
  return await ok(await tool(f, agent, "wait", { timeoutMs: 0, ...fields })) as WaitAnswer;
}

function ids(answer: { messages: Array<Record<string, unknown>> }): unknown[] {
  return answer.messages.map((message) => message.messageId);
}

function logOf(f: Fixture, workspaceId: string) {
  return f.storage.fetchLogPage({ workspaceId, sinceRelaySeq: 0, limit: 100_000 }).rows;
}

function payloadOf(row: { payloadJson: string }): Record<string, unknown> {
  return JSON.parse(row.payloadJson) as Record<string, unknown>;
}

/** Resolves once `count` subscriptions are parked. */
async function parked(f: Fixture, count: number): Promise<void> {
  await vi.waitFor(() => expect(f.activity.stats().waiters).toBe(count));
}

function setOwner(f: Fixture, workspaceId: string, userId: string): void {
  const db = inspectDatabase(f.dbPath, { foreignKeys: true });
  try {
    db.prepare("UPDATE sync_relay_workspaces SET owner_user_id = ? WHERE workspace_id = ?").run(userId, workspaceId);
  } finally {
    db.close();
  }
}

function deleteAccountAtFence(f: Fixture): void {
  const context = f.storage as StorageContext;
  initializeAccountDeletion(context, DELETION_KEY);
  const job = fenceAccount(context, DELETION_KEY, OWNER, `${OWNER}@dohc.test`);
  f.h.deleteAccount(OWNER, job.manifest!.workspaces.map((row) => row.workspaceId), job.manifest!.shareIds);
}

function setReach(f: Fixture, agent: Signed, reach: Reach): Promise<Response> {
  return owner(f, `/${agent.agentId}/reach`, { method: "PUT", body: { reach } });
}

const BOTH_VIEW: Reach = [{ workspaceId: WS_A, level: "view" }, { workspaceId: WS_B, level: "view" }];
const BOTH_COMMENT: Reach = [{ workspaceId: WS_A, level: "comment" }, { workspaceId: WS_B, level: "comment" }];

describe("a personal agent's DM", () => {
  it("is appended from the agent's origin in each workspace entering its reach, at sign-in and on widening", async () => {
    const f = await fixture();
    const agent = await signIn(f);
    const origin = personalAgentOrigin(agent.agentId);
    const creates = (workspaceId: string) => logOf(f, workspaceId).filter((row) => row.originId === origin);
    expect(creates(WS_A)).toEqual([expect.objectContaining({ opKind: "chat.channel.create", originSeq: 0 })]);
    expect(payloadOf(creates(WS_A)[0]!)).toEqual({
      channelId: `personal-dm:${agent.agentId}`, name: "Helper", slug: `my-agent-${agent.agentId}`, kind: "agent",
      createdAtMs: f.now.value, wireId: agentChannelWireId(agent.agentId),
    });
    expect(creates(WS_B)).toEqual([]);

    await ok(await setReach(f, agent, [{ workspaceId: WS_A, level: "comment" }, { workspaceId: WS_B, level: "view" }]));
    expect(creates(WS_A)).toHaveLength(1);
    expect(creates(WS_B)).toEqual([expect.objectContaining({ opKind: "chat.channel.create", originSeq: 0 })]);
    // Leaving reach and entering again costs one more small op.
    await ok(await setReach(f, agent, [{ workspaceId: WS_A, level: "comment" }]));
    await ok(await setReach(f, agent, [{ workspaceId: WS_A, level: "comment" }, { workspaceId: WS_B, level: "view" }]));
    expect(creates(WS_B).map((row) => row.originSeq)).toEqual([0, 1]);
  });
});

describe("a personal agent's posts", () => {
  it("posts as itself from its own origin, with its account, connection, and current name, whatever the request names", async () => {
    const f = await fixture();
    const agent = await signIn(f, { reach: [{ workspaceId: WS_A, level: "comment" }] });
    chats(f, WS_A, agent.agentId);
    const dm = agentChannelWireId(agent.agentId);
    const before = logOf(f, WS_A).length;

    // A field that would name the author is refused, not ignored.
    for (const forged of [{ authorUserId: OTHER }, { authorAgentId: `p-${"b".repeat(26)}` }, { originId: "owner-computer" }]) {
      expect((await post(f, agent, { channelWireId: dm, ...forged })).status).toBe(400);
    }
    expect(logOf(f, WS_A)).toHaveLength(before);

    const { message } = await ok(await post(f, agent, { channelWireId: dm })) as { message: Record<string, unknown> };
    expect(message).toMatchObject({
      workspaceId: WS_A, channelWireId: dm, authorKind: "agent", authorDisplayName: "Helper", linkAgent: false, body: "from the agent",
    });
    expect(String(message.messageId).startsWith(PERSONAL_MESSAGE_ID_PREFIX)).toBe(true);
    expect(String(message.threadId).startsWith(PERSONAL_THREAD_ID_PREFIX)).toBe(true);
    const [thread, appended] = logOf(f, WS_A).slice(before);
    expect(thread).toMatchObject({ originId: personalAgentOrigin(agent.agentId), opKind: "chat.thread.create" });
    expect(payloadOf(thread!)).toMatchObject({ threadId: message.threadId, channelWireId: dm, lane: "chat" });
    expect(appended).toMatchObject({ originId: personalAgentOrigin(agent.agentId), opKind: "chat.message.append" });
    expect(payloadOf(appended!)).toMatchObject({
      messageId: message.messageId, authorKind: "agent", authorUserId: OWNER, authorAgentId: agent.agentId,
      agentConnectionId: agent.connectionId, authorDisplayName: "Helper",
    });

    // A retry answers the same post; the same key with another body is a conflict.
    expect((await ok(await post(f, agent, { channelWireId: dm }))).message).toMatchObject({ messageId: message.messageId });
    await expectCode(await post(f, agent, { channelWireId: dm, body: "something else" }), 409, "conflict");
    expect(logOf(f, WS_A)).toHaveLength(before + 2);

    await ok(await owner(f, `/${agent.agentId}/name`, { method: "PUT", body: { name: "Research" } }));
    expect((await ok(await post(f, agent, { threadId: "thread-team", idempotencyKey: "post-2" }))).message).toMatchObject({
      threadId: "thread-team", channelWireId: "wire-team", authorDisplayName: "Research",
    });
    expect(count(f, "sync_relay_personal_agent_threads", "agent_id = ?", agent.agentId)).toBe(2);
  });

  it("resolves a channel or thread only inside the named workspace, and never posts in a person's DM or another agent's", async () => {
    const f = await fixture();
    const agent = await signIn(f, { reach: BOTH_COMMENT });
    const second = await signIn(f, { agent: { kind: "new", name: "Second" }, reach: BOTH_COMMENT });
    fromComputer(f, WS_B, [chatChannelCreate("wire-b"), chatThreadCreate("thread-b", "wire-b")]);
    fromComputer(f, WS_A, [
      chatChannelCreate("wire-person", { kind: "dm" }),
      chatThreadCreate("thread-person", "wire-person"),
      { opKind: "chat.thread.create", payload: { threadId: "thread-file", title: "", createdAtMs: 2, linkedObjectId: "object-a", linkedAtMs: 2 } },
    ]);
    const before = logOf(f, WS_A).length;

    await expectRefused(await post(f, agent, { threadId: "thread-b" }));
    await expectRefused(await post(f, agent, { channelWireId: "wire-b" }));
    await expectRefused(await post(f, agent, { channelWireId: "wire-nowhere" }));
    // A person's DM, as a new thread there or a reply in one of its threads.
    await expectRefused(await post(f, agent, { channelWireId: "wire-person" }));
    await expectRefused(await post(f, agent, { threadId: "thread-person", idempotencyKey: "post-person" }));
    // A thread on a file has no channel to post in.
    await expectRefused(await post(f, agent, { threadId: "thread-file", idempotencyKey: "post-file" }));
    expect(logOf(f, WS_A)).toHaveLength(before);
    // Another agent's DM, as a new thread there or a reply in one of its threads.
    const theirs = await ok(await post(f, second, { channelWireId: agentChannelWireId(second.agentId) })) as {
      message: { threadId: string };
    };
    await expectRefused(await post(f, agent, { channelWireId: agentChannelWireId(second.agentId), idempotencyKey: "post-2" }));
    await expectRefused(await post(f, agent, { threadId: theirs.message.threadId, idempotencyKey: "post-3" }));

    await ok(await post(f, agent, { workspaceId: WS_B, threadId: "thread-b" }));
    await ok(await post(f, agent, { channelWireId: agentChannelWireId(agent.agentId), idempotencyKey: "post-4" }));
  });

  it("refuses a workspace out of reach, a post at View, and a workspace its account lost or deleted", async () => {
    const f = await fixture();
    await claimWorkspace(f.h, OWNER, "workspace-c");
    const agent = await signIn(f, { reach: [{ workspaceId: WS_A, level: "view" }, { workspaceId: WS_B, level: "comment" }] });
    for (const workspaceId of [WS_A, WS_B, "workspace-c"]) fromComputer(f, workspaceId, [chatChannelCreate("wire-team")]);
    const read = (workspaceId: string) => tool(f, agent, "chat", { workspaceId, channelWireId: "wire-team" });

    await expectCode(await post(f, agent, { channelWireId: "wire-team" }), 403, "personal_agent_view_only");
    await ok(await read(WS_A));
    await ok(await post(f, agent, { workspaceId: WS_B, channelWireId: "wire-team" }));
    // An owned workspace not in reach, and another account's, answer the same.
    for (const workspaceId of ["workspace-c", OTHER_WS]) {
      await expectCode(await read(workspaceId), 403, "personal_agent_out_of_reach");
      await expectCode(await post(f, agent, { workspaceId, channelWireId: "wire-team" }), 403, "personal_agent_out_of_reach");
      await expectCode(await tool(f, agent, "files", { workspaceId }), 403, "personal_agent_out_of_reach");
    }
    expect(Object.keys((await waitOnce(f, agent)).cursor.seqs)).toEqual([WS_A, WS_B]);

    setOwner(f, WS_B, OTHER);
    await expectCode(await post(f, agent, { workspaceId: WS_B, channelWireId: "wire-team", idempotencyKey: "post-2" }), 403,
      "personal_agent_out_of_reach");
    await expectCode(await read(WS_B), 403, "personal_agent_out_of_reach");

    const context = f.storage as StorageContext;
    initializeAccountDeletion(context, DELETION_KEY);
    context.db.prepare("INSERT INTO sync_relay_deleted_workspaces (workspace_hash) VALUES (?)")
      .run(accountDeletionIdentity(DELETION_KEY, `workspace:${WS_A}`));
    await expectCode(await read(WS_A), 403, "personal_agent_out_of_reach");
    expect((await waitOnce(f, agent)).cursor.seqs).toEqual({});
  });

  const commitRaces: Array<[string, (f: Fixture, agent: Signed) => Promise<void>, string]> = [
    ["Sign out", async (f, agent) => { await ok(await owner(f, `/${agent.agentId}/sign-out`, { method: "POST" })); }, "not-authorized"],
    ["a reset and its notification", async (f) => { f.fence.listener!.onChange(f.fence.changePassword(OWNER, NEW_PASSWORD)); }, "not-authorized"],
    ["account deletion", async (f) => { deleteAccountAtFence(f); }, "not-authorized"],
    ["narrowing", async (f, agent) => { await ok(await setReach(f, agent, [{ workspaceId: WS_B, level: "comment" }])); }, "out-of-reach"],
    ["lowering to View", async (f, agent) => { await ok(await setReach(f, agent, BOTH_VIEW)); }, "read-only"],
    ["ownership lost", async (f) => { setOwner(f, WS_A, OTHER); }, "out-of-reach"],
  ];

  it.each(commitRaces)("refuses a post whose access ends by %s between authentication and its commit", async (_, revoke, reason) => {
    const f = await fixture();
    const agent = await signIn(f, { reach: BOTH_COMMENT });
    const authority = await f.h.linkAuthority.personal(agentRequest(agent.accessToken, agent.resource));
    const commit = (idempotencyKey: string) => f.storage.appendPersonalChatPost({
      check: authority.check, connectionId: authority.connectionId, fenceEpoch: authority.fenceEpoch, now: () => f.now.value,
      workspaceId: WS_A, target: { channelWireId: agentChannelWireId(agent.agentId) }, body: "late", idempotencyKey,
    });
    expect(commit("before")).toMatchObject({ ok: true, replayed: false });
    await revoke(f, agent);
    expect(commit("after")).toEqual({ ok: false, reason });
  });

  it("refuses a post when a reset commits while its body is still arriving", async () => {
    const f = await fixture();
    const agent = await signIn(f, { reach: [{ workspaceId: WS_A, level: "comment" }] });
    const dm = agentChannelWireId(agent.agentId);
    // The body's bytes come only when the relay reads them, after it authenticated the request.
    const arriving = (idempotencyKey: string, meanwhile: () => void) => new ReadableStream<Uint8Array>({
      pull(controller) {
        meanwhile();
        controller.enqueue(new TextEncoder().encode(JSON.stringify({ workspaceId: WS_A, channelWireId: dm, body: "late", idempotencyKey })));
        controller.close();
      },
    }, { highWaterMark: 0 });

    await ok(await tool(f, agent, "post", arriving("post-1", () => {})));
    const before = logOf(f, WS_A).length;
    // No notification: the read of the fence after the body refuses.
    await expectRefused(await tool(f, agent, "post", arriving("post-2", () => { f.fence.changePassword(OWNER, NEW_PASSWORD); })));
    expect(logOf(f, WS_A)).toHaveLength(before);
  });

  it("refuses a chat or file read when a reset commits while its body is still arriving", async () => {
    for (const action of ["chat", "files"] as const) {
      const f = await fixture();
      const agent = await signIn(f, { reach: [{ workspaceId: WS_A, level: "comment" }] });
      const fields = action === "chat" ? { workspaceId: WS_A, channelWireId: agentChannelWireId(agent.agentId) } : { workspaceId: WS_A };
      const arriving = (meanwhile: () => void) => new ReadableStream<Uint8Array>({
        pull(controller) {
          meanwhile();
          controller.enqueue(new TextEncoder().encode(JSON.stringify(fields)));
          controller.close();
        },
      }, { highWaterMark: 0 });

      await ok(await tool(f, agent, action, arriving(() => {})));
      // No notification: the read of the fence after the body refuses.
      await expectRefused(await tool(f, agent, action, arriving(() => { f.fence.changePassword(OWNER, NEW_PASSWORD); })));
    }
  });
});

describe("a personal agent's tools", () => {
  it("serve only a personal agent's token at its address, with the relay exchange key, by POST", async () => {
    const f = await fixture();
    const agent = await signIn(f);
    await ok(await tool(f, agent, "files", { workspaceId: WS_A }));
    await expectRefused(await f.h(request(null, "/sync/link/personal-agent/files", {
      method: "POST",
      headers: { authorization: `DohcAgent ${agent.accessToken}`, "x-dohc-agent-resource": agent.resource, "content-type": "application/json" },
      body: JSON.stringify({ workspaceId: WS_A }),
    })));
    await expectRefused(await tool(f, { ...agent, accessToken: "x".repeat(43) }, "files", { workspaceId: WS_A }));
    await expectRefused(await tool(f, { ...agent, resource: resourceFor(WS_B) }, "files", { workspaceId: WS_A }));
    expect((await f.h(request(null, "/sync/link/personal-agent/files", { method: "GET" }))).status).toBe(405);
    expect((await tool(f, agent, "list", {})).status).toBe(404);
    expect((await tool(f, agent, "files", { workspaceId: WS_A, extra: 1 })).status).toBe(400);
  });

  const revocations: Array<[string, (f: Fixture, agent: Signed) => Promise<void>]> = [
    ["Sign out", async (f, agent) => { await ok(await owner(f, `/${agent.agentId}/sign-out`, { method: "POST" })); }],
    // No notification: the direct read of the fence refuses.
    ["a reset", async (f) => { f.fence.changePassword(OWNER, NEW_PASSWORD); }],
    ["account deletion", async (f) => { deleteAccountAtFence(f); }],
  ];

  it.each(revocations)("refuse every call after %s, before any read", async (_, revoke) => {
    const f = await fixture();
    const agent = await signIn(f, { reach: [{ workspaceId: WS_A, level: "comment" }] });
    const sha = await putBlob(f.h, OWNER, WS_A, "hello");
    await appendLog(f.h, OWNER, WS_A, [moment("notes/a.md", "hello", { originSeq: 0 })]);
    const dm = agentChannelWireId(agent.agentId);
    const calls: Array<[string, Record<string, unknown>]> = [
      ["post", { workspaceId: WS_A, channelWireId: dm, body: "hello", idempotencyKey: "post-1" }],
      ["wait", { timeoutMs: 0 }],
      ["chat", { workspaceId: WS_A, channelWireId: dm }],
      ["files", { workspaceId: WS_A }],
      ["blob", { workspaceId: WS_A, sha256: sha }],
    ];
    for (const [action, body] of calls) {
      const response = await tool(f, agent, action, body);
      expect(response.status, action).toBe(200);
      await response.arrayBuffer();
    }
    await revoke(f, agent);
    for (const [action, body] of calls) await expectRefused(await tool(f, agent, action, body));
  });

  it("reach nothing in a workspace narrowing removed", async () => {
    const f = await fixture();
    const agent = await signIn(f, { reach: BOTH_COMMENT });
    const sha = await putBlob(f.h, OWNER, WS_A, "hello");
    await appendLog(f.h, OWNER, WS_A, [moment("notes/a.md", "hello", { originSeq: 0 })]);
    const dm = agentChannelWireId(agent.agentId);
    await ok(await setReach(f, agent, [{ workspaceId: WS_B, level: "comment" }]));

    await expectCode(await post(f, agent, { channelWireId: dm }), 403, "personal_agent_out_of_reach");
    await expectCode(await tool(f, agent, "chat", { workspaceId: WS_A, channelWireId: dm }), 403, "personal_agent_out_of_reach");
    await expectCode(await tool(f, agent, "files", { workspaceId: WS_A }), 403, "personal_agent_out_of_reach");
    await expectCode(await tool(f, agent, "blob", { workspaceId: WS_A, sha256: sha }), 403, "personal_agent_out_of_reach");
    expect(Object.keys((await waitOnce(f, agent)).cursor.seqs)).toEqual([WS_B]);
  });
});

describe("a personal agent's wait", () => {
  it("answers its owner's posts in its DM, mentioning its current name, and in threads it posted in, with where each is", async () => {
    const f = await fixture();
    const agent = await signIn(f, { reach: [{ workspaceId: WS_A, level: "comment" }] });
    chats(f, WS_A, agent.agentId);
    await putBlob(f.h, OWNER, WS_A, "plan");
    await appendLog(f.h, OWNER, WS_A, [moment("notes/plan.md", "plan", { originSeq: 0, objectId: "object-plan" })]);
    const elsewhere = agentChannelWireId(`p-${"b".repeat(26)}`);
    fromComputer(f, WS_A, [
      chatChannelCreate(elsewhere, { kind: "agent" }),
      chatThreadCreate("thread-elsewhere", elsewhere),
      { opKind: "chat.thread.create", payload: { threadId: "thread-file", title: "", createdAtMs: 2, linkedObjectId: "object-plan", linkedAtMs: 2 } },
    ]);
    await ok(await post(f, agent, { threadId: "thread-team" }));
    await ok(await owner(f, `/${agent.agentId}/name`, { method: "PUT", body: { name: "Research" } }));
    fromComputer(f, WS_A, [
      ownerSays("dm", "thread-dm", "hello"),
      ownerSays("mention", "thread-other", "@Research a question"),
      ownerSays("reply", "thread-team", "thanks"),
      ownerSays("old-name", "thread-other", "@Helper an old handle"),
      ownerSays("unrelated", "thread-other", "no one in particular"),
      ownerSays("from-cli", "thread-dm", "from the CLI", { origin: "cli" }),
      ownerSays("as-agent", "thread-dm", "an agent's post", { authorKind: "agent" }),
      chatMessageAppend("other-account", "thread-dm", "hello", { authorUserId: OTHER, authorDisplayName: "Bo" }),
      chatMessageAppend("no-account", "thread-dm", "hello"),
      // Another agent's DM and a thread on a file count as any thread outside its own DM.
      ownerSays("other-dm", "thread-elsewhere", "@Research in another agent's DM"),
      ownerSays("other-dm-unmentioned", "thread-elsewhere", "for the other agent"),
      ownerSays("on-file", "thread-file", "@Research a comment"),
      ownerSays("on-file-unmentioned", "thread-file", "a note"),
    ]);

    const answer = await waitOnce(f, agent);
    expect(ids(answer)).toEqual(["dm", "mention", "reply", "other-dm", "on-file"]);
    expect(answer.messages[0]).toMatchObject({
      workspaceId: WS_A, channelWireId: agentChannelWireId(agent.agentId), filePath: null, authorKind: "human", body: "hello",
    });
    expect(answer.messages[0]).not.toHaveProperty("authorUserId");
    expect(answer.messages[1]).toMatchObject({ workspaceId: WS_A, channelWireId: "wire-team", filePath: null });
    expect(answer.messages[3]).toMatchObject({ workspaceId: WS_A, channelWireId: elsewhere, filePath: null });
    expect(answer.messages[4]).toMatchObject({ workspaceId: WS_A, channelWireId: null, filePath: "notes/plan.md" });
    expect(answer).toMatchObject({ more: false, cursor: { v: 1, agentId: agent.agentId, turn: WS_A } });
    expect(ids(await waitOnce(f, agent, { cursor: answer.cursor }))).toEqual([]);
  });

  it("leaves out a comment on a file whose current path is secret, however the path is spelled", async () => {
    const f = await fixture();
    const agent = await signIn(f);
    await putBlob(f.h, OWNER, WS_A, "plan");
    await appendLog(f.h, OWNER, WS_A, [
      moment("notes/kept.md", "plan", { originSeq: 0, objectId: "object-kept" }),
      moment("config/.env", "plan", { originSeq: 1, objectId: "object-env" }),
      moment("config/.ENV", "plan", { originSeq: 2, objectId: "object-upper" }),
      moment("config/%2eenv.local", "plan", { originSeq: 3, objectId: "object-encoded" }),
      moment("notes/plan.md", "plan", { originSeq: 4, objectId: "object-moved" }),
      moment("config/prod.env", "plan", {
        originSeq: 5, objectId: "object-moved", operation: "rename", beforePath: "notes/plan.md", beforeContent: "plan",
      }),
    ]);
    fromComputer(f, WS_A, [
      fileThread("thread-kept", { linkedObjectId: "object-kept" }),
      fileThread("thread-env", { linkedObjectId: "object-env" }),
      fileThread("thread-upper", { linkedObjectId: "object-upper" }),
      fileThread("thread-encoded", { linkedObjectId: "object-encoded" }),
      fileThread("thread-moved", { linkedObjectId: "object-moved" }),
      fileThread("thread-by-path", { linkedPath: "config/.env" }),
      // A secret file has no object on the relay, so only its path names it.
      fileThread("thread-secret-only", { linkedPath: "keys/.env.production" }),
      ...["kept", "env", "upper", "encoded", "moved", "by-path", "secret-only"].map((name) => ownerSays(name, `thread-${name}`, "@Helper a comment")),
    ]);

    const answer = await waitOnce(f, agent);
    expect(answer.messages.map((message) => [message.messageId, message.filePath])).toEqual([["kept", "notes/kept.md"]]);
    expect(JSON.stringify(answer)).not.toContain("config/");
    expect(JSON.stringify(answer)).not.toContain("keys/");
  });

  it("names a file's path after a rename, and no path once the file is gone or the relay never saw it", async () => {
    const f = await fixture();
    const agent = await signIn(f);
    await putBlob(f.h, OWNER, WS_A, "plan");
    await appendLog(f.h, OWNER, WS_A, [
      moment("notes/plan.md", "plan", { originSeq: 0, objectId: "object-moved" }),
      moment("notes/gone.md", "plan", { originSeq: 1, objectId: "object-gone" }),
      moment("notes/moved.md", "plan", {
        originSeq: 2, objectId: "object-moved", operation: "rename", beforePath: "notes/plan.md", beforeContent: "plan",
      }),
      moment("notes/gone.md", "", {
        originSeq: 3, objectId: "object-gone", operation: "delete", beforePath: "notes/gone.md", beforeContent: "plan",
        afterPath: null, afterContent: null,
      }),
    ]);
    fromComputer(f, WS_A, [
      fileThread("thread-moved", { linkedObjectId: "object-moved", linkedPathHint: "notes/plan.md" }),
      fileThread("thread-gone", { linkedObjectId: "object-gone", linkedPathHint: "notes/gone.md" }),
      fileThread("thread-unknown", { linkedObjectId: "object-unknown", linkedPathHint: "notes/unknown.md" }),
      // Bound by the path the file left.
      fileThread("thread-old-path", { linkedPath: "notes/plan.md" }),
      ...["moved", "gone", "unknown", "old-path"].map((name) => ownerSays(name, `thread-${name}`, "@Helper a comment")),
    ]);

    const answer = await waitOnce(f, agent);
    expect(answer.messages.map((message) => [message.messageId, message.filePath])).toEqual([
      ["moved", "notes/moved.md"], ["gone", null], ["unknown", null], ["old-path", null],
    ]);
  });

  it("reads only from where each workspace entered its reach, whatever the cursor names", async () => {
    const f = await fixture();
    fromComputer(f, WS_A, [
      chatChannelCreate("wire-team"), chatThreadCreate("thread-other", "wire-team"), ownerSays("before", "thread-other", "@Helper before"),
    ]);
    const agent = await signIn(f);
    fromComputer(f, WS_A, [ownerSays("after", "thread-other", "@Helper after")]);
    const answer = await waitOnce(f, agent, {
      cursor: { v: 1, agentId: agent.agentId, seqs: { [WS_A]: 0, [WS_B]: 0, [OTHER_WS]: 0 }, turn: null },
    });
    expect(ids(answer)).toEqual(["after"]);
    expect(Object.keys(answer.cursor.seqs)).toEqual([WS_A]);

    // Another agent's cursor, and a malformed one, are refused.
    const second = await signIn(f, { agent: { kind: "new", name: "Second" } });
    expect((await tool(f, second, "wait", { timeoutMs: 0, cursor: answer.cursor })).status).toBe(400);
    expect((await tool(f, agent, "wait", { timeoutMs: 0, cursor: { ...answer.cursor, seqs: { [WS_A]: -1 } } })).status).toBe(400);
    expect((await tool(f, agent, "wait", { timeoutMs: 0, cursor: { ...answer.cursor, extra: 1 } })).status).toBe(400);
  });

  it("answers a match 2,500 rows in on the second call, after an empty answer with more", async () => {
    const f = await fixture();
    const agent = await signIn(f);
    chats(f, WS_A, agent.agentId);
    fromComputer(f, WS_A, [
      ...Array.from({ length: 2_500 }, (_, index) => ownerSays(`noise-${index}`, "thread-other", "elsewhere")),
      ownerSays("dm", "thread-dm", "hello"),
    ]);
    const parks = vi.spyOn(f.activity, "wait");
    const first = await ok(await tool(f, agent, "wait", {})) as WaitAnswer;
    expect(first).toMatchObject({ messages: [], more: true });
    const second = await ok(await tool(f, agent, "wait", { cursor: first.cursor })) as WaitAnswer;
    expect(ids(second)).toEqual(["dm"]);
    expect(second.more).toBe(false);
    expect(parks).not.toHaveBeenCalled();
  });

  it("answers 101 matches as 100, then the last at once", async () => {
    const f = await fixture();
    const agent = await signIn(f);
    chats(f, WS_A, agent.agentId);
    const all = Array.from({ length: PERSONAL_WAIT_MAX_MESSAGES + 1 }, (_, index) => `dm-${index}`);
    fromComputer(f, WS_A, all.map((id) => ownerSays(id, "thread-dm", "hello")));
    const parks = vi.spyOn(f.activity, "wait");
    const first = await ok(await tool(f, agent, "wait", {})) as WaitAnswer;
    expect(ids(first)).toEqual(all.slice(0, PERSONAL_WAIT_MAX_MESSAGES));
    expect(first.more).toBe(true);
    const second = await ok(await tool(f, agent, "wait", { cursor: first.cursor })) as WaitAnswer;
    expect(ids(second)).toEqual(all.slice(PERSONAL_WAIT_MAX_MESSAGES));
    expect(parks).not.toHaveBeenCalled();
  });

  it("resumes a size-cut answer at the message that didn't fit", async () => {
    const f = await fixture();
    const agent = await signIn(f);
    chats(f, WS_A, agent.agentId);
    const large = "x".repeat(200_000);
    fromComputer(f, WS_A, ["large-0", "large-1", "large-2"].map((id) => ownerSays(id, "thread-dm", large)));
    const first = await waitOnce(f, agent);
    expect(ids(first)).toEqual(["large-0", "large-1"]);
    expect(first.more).toBe(true);
    const second = await waitOnce(f, agent, { cursor: first.cursor });
    expect(ids(second)).toEqual(["large-2"]);
    expect(second.messages[0]).toMatchObject({ body: large, bodyTooLarge: false });
  });

  it("gives the next call to another workspace while one has more than a budget, and keeps the first one's place", async () => {
    const f = await fixture();
    const agent = await signIn(f, { reach: BOTH_VIEW });
    chats(f, WS_A, agent.agentId);
    chats(f, WS_B, agent.agentId);
    const noise = (from: number) => Array.from({ length: 2 * CHAT_HISTORY_SCAN_WINDOW }, (_, index) =>
      ownerSays(`noise-${from + index}`, "thread-other", "elsewhere"));
    fromComputer(f, WS_A, noise(0));
    fromComputer(f, WS_B, [ownerSays("in-b", "thread-dm", "hello")]);

    // A's turn uses the whole budget.
    const first = await waitOnce(f, agent);
    expect(first).toMatchObject({ messages: [], more: true, cursor: { turn: WS_B } });
    // B's turn finds its message, and A goes on with what is left.
    const second = await waitOnce(f, agent, { cursor: first.cursor });
    expect(ids(second)).toEqual(["in-b"]);
    expect(second).toMatchObject({ more: true, cursor: { turn: WS_A } });
    expect(second.cursor.seqs[WS_A]).toBeGreaterThan(first.cursor.seqs[WS_A]!);

    fromComputer(f, WS_A, noise(2 * CHAT_HISTORY_SCAN_WINDOW));
    fromComputer(f, WS_B, [ownerSays("in-b-again", "thread-dm", "hello")]);
    const third = await waitOnce(f, agent, { cursor: second.cursor });
    expect(third).toMatchObject({ messages: [], more: true, cursor: { turn: WS_B } });
    expect(third.cursor.seqs[WS_A]).toBeGreaterThan(second.cursor.seqs[WS_A]!);
    expect(ids(await waitOnce(f, agent, { cursor: third.cursor }))).toEqual(["in-b-again"]);
  });

  it("reads past a scan's byte budget only for the scan's first row, not each workspace's", async () => {
    const f = await fixture();
    const agent = await signIn(f, { reach: BOTH_VIEW });
    chats(f, WS_A, agent.agentId);
    chats(f, WS_B, agent.agentId);
    const { cursor } = await waitOnce(f, agent);
    expect(cursor.turn).toBe(WS_B);
    // B's turn reads three quarters of the budget. A's next row is larger than what is left.
    fromComputer(f, WS_B, ["noise-0", "noise-1"].map((id) => ownerSays(id, "thread-other", "x".repeat(CHAT_HISTORY_SCAN_BYTES * 3 / 8))));
    fromComputer(f, WS_A, [
      ownerSays("large", "thread-other", "x".repeat(CHAT_HISTORY_SCAN_BYTES / 2)),
      ownerSays("dm-a", "thread-dm", "hello"),
    ]);
    const large = logOf(f, WS_A).find((row) => row.opKind === "chat.message.append" && payloadOf(row).messageId === "large")!;
    const windows = vi.spyOn(f.storage, "readPersonalWaitWindow");

    const first = await waitOnce(f, agent, { cursor });
    expect(first).toMatchObject({ messages: [], more: true, cursor: { turn: WS_A } });
    expect(first.cursor.seqs[WS_A]).toBeLessThan(large.relaySeq);
    const read = windows.mock.results.reduce((bytes, result) => bytes + (result.value as { bytes: number }).bytes, 0);
    expect(read).toBeLessThanOrEqual(CHAT_HISTORY_SCAN_BYTES);
    // A's turn starts the next scan, so the large row is that scan's first.
    expect(ids(await waitOnce(f, agent, { cursor: first.cursor }))).toEqual(["dm-a"]);
  });

  it("parks on every workspace in reach, and releases every subscription on answer, abort, and deadline", async () => {
    const f = await fixture();
    const agent = await signIn(f, { reach: BOTH_VIEW });
    chats(f, WS_A, agent.agentId);
    chats(f, WS_B, agent.agentId);
    const { cursor } = await waitOnce(f, agent);

    const answered = tool(f, agent, "wait", { cursor });
    await parked(f, 2);
    fromComputer(f, WS_B, [ownerSays("in-b", "thread-dm", "hello")]);
    const answer = await ok(await answered) as WaitAnswer;
    expect(ids(answer)).toEqual(["in-b"]);
    expect(f.activity.stats().waiters).toBe(0);

    const controller = new AbortController();
    const aborted = tool(f, agent, "wait", { cursor: answer.cursor }, controller.signal);
    await parked(f, 2);
    controller.abort();
    await expectRefused(await aborted);
    expect(f.activity.stats().waiters).toBe(0);

    // Both subscriptions hold to the same deadline.
    const holds: number[] = [];
    const original = f.activity.wait.bind(f.activity);
    vi.spyOn(f.activity, "wait").mockImplementation((group, actor, options) => {
      holds.push(options.holdMs);
      f.now.value += options.holdMs;
      return original(group, actor, { ...options, holdMs: 1 });
    });
    expect(await ok(await tool(f, agent, "wait", { cursor: answer.cursor, timeoutMs: 40 }))).toMatchObject({ messages: [], more: false });
    expect(holds).toEqual([40, 40]);
    expect(f.activity.stats().waiters).toBe(0);
  });

  it("holds at most its connection's share of waits, and frees a place when one ends", async () => {
    const f = await fixture();
    const agent = await signIn(f);
    chats(f, WS_A, agent.agentId);
    const controllers = Array.from({ length: MAX_AGENT_CHAT_WAITS_PER_CONNECTION }, () => new AbortController());
    const held = controllers.map((controller) => tool(f, agent, "wait", {}, controller.signal));
    await parked(f, MAX_AGENT_CHAT_WAITS_PER_CONNECTION);
    await expectCode(await tool(f, agent, "wait", { timeoutMs: 0 }), 429, "link_read_rate_limited");
    controllers.forEach((controller) => controller.abort());
    for (const response of await Promise.all(held)) await expectRefused(response);
    await waitOnce(f, agent);
  });

  it("holds at most its account's share of waits across its agents, and frees a place when one ends", async () => {
    expect(MAX_PERSONAL_WAITS_PER_ACCOUNT % MAX_AGENT_CHAT_WAITS_PER_CONNECTION).toBe(0);
    const f = await fixture();
    const agents: Signed[] = [];
    for (let index = 0; index <= MAX_PERSONAL_WAITS_PER_ACCOUNT / MAX_AGENT_CHAT_WAITS_PER_CONNECTION; index++) {
      agents.push(await signIn(f, { agent: { kind: "new", name: `Agent ${index}` } }));
    }
    const last = agents.pop()!;
    const holders = agents.flatMap((agent) => Array.from({ length: MAX_AGENT_CHAT_WAITS_PER_CONNECTION }, () => agent));
    const controllers = holders.map(() => new AbortController());
    const held = holders.map((agent, index) => tool(f, agent, "wait", {}, controllers[index]!.signal));
    await parked(f, MAX_PERSONAL_WAITS_PER_ACCOUNT);
    // Its own connection holds none, but its account is full.
    await expectCode(await tool(f, last, "wait", { timeoutMs: 0 }), 429, "link_read_rate_limited");

    controllers[0]!.abort();
    await expectRefused(await held[0]!);
    await waitOnce(f, last);
    controllers.slice(1).forEach((controller) => controller.abort());
    for (const response of await Promise.all(held.slice(1))) await expectRefused(response);
  });

  const parkedRevocations: Array<[
    string,
    (f: Fixture, agent: Signed) => Promise<void>,
    (f: Fixture, agent: Signed, response: Response) => Promise<void>,
  ]> = [
    ["Sign out", async (f, agent) => { await ok(await owner(f, `/${agent.agentId}/sign-out`, { method: "POST" })); },
      async (_f, _agent, response) => { await expectRefused(response); }],
    ["a reset", async (f) => { f.fence.listener!.onChange(f.fence.changePassword(OWNER, NEW_PASSWORD)); },
      async (_f, _agent, response) => { await expectRefused(response); }],
    ["account deletion", async (f) => { deleteAccountAtFence(f); },
      async (_f, _agent, response) => { await expectRefused(response); }],
    ["narrowing", async (f, agent) => { await ok(await setReach(f, agent, [{ workspaceId: WS_A, level: "view" }])); },
      async (_f, _agent, response) => {
        const answer = await ok(response) as WaitAnswer;
        expect(answer).toMatchObject({ messages: [], more: false });
        expect(Object.keys(answer.cursor.seqs)).toEqual([WS_A]);
      }],
    ["the fence notifications stopping", async (f) => { f.fence.listener!.onDown(); }, async (f, agent, response) => {
      expect(await ok(response)).toMatchObject({ messages: [] });
      await expectCode(await tool(f, agent, "wait", { timeoutMs: 0 }), 503, "personal_agent_unavailable");
    }],
  ];

  it.each(parkedRevocations)("answers a parked wait at once after %s", async (_, revoke, expectAnswer) => {
    const f = await fixture();
    const agent = await signIn(f, { reach: BOTH_VIEW });
    const { cursor } = await waitOnce(f, agent);
    const held = tool(f, agent, "wait", { cursor });
    await parked(f, 2);
    await revoke(f, agent);
    await expectAnswer(f, agent, await held);
    expect(f.activity.stats().waiters).toBe(0);
  });
});

describe("a personal agent's reads", () => {
  it("reads a channel's messages newest first, a page at a time, only in a channel of the named workspace", async () => {
    const f = await fixture();
    const agent = await signIn(f, { reach: BOTH_VIEW });
    chats(f, WS_A, agent.agentId);
    fromComputer(f, WS_B, [chatChannelCreate("wire-b")]);
    fromComputer(f, WS_A, ["first", "second", "third"].map((id) => ownerSays(id, "thread-team", id)));
    const read = (fields: Record<string, unknown>) => tool(f, agent, "chat", { workspaceId: WS_A, channelWireId: "wire-team", ...fields });

    const page = await ok(await read({ limit: 2 })) as ChatPage;
    expect(ids(page)).toEqual(["third", "second"]);
    expect(page.messages[0]).not.toHaveProperty("authorUserId");
    expect(page.olderCursor).toEqual(expect.any(Number));
    const older = await ok(await read({ limit: 2, before: page.olderCursor })) as ChatPage;
    expect(ids(older)).toEqual(["first"]);
    expect(older.olderCursor).toBeNull();

    // A row at the agent's origin that names another agent isn't the agent's post.
    f.storage.appendLogBatch({
      workspaceId: WS_A, originId: personalAgentOrigin(agent.agentId),
      ops: [{ originSeq: 1, opKind: "chat.message.append", recordedAtMs: 1, payloadJson: JSON.stringify({
        messageId: `${PERSONAL_MESSAGE_ID_PREFIX}forged`, threadId: "thread-team", authorKind: "agent", authorDisplayName: "Helper",
        authorUserId: OWNER, authorAgentId: `p-${"b".repeat(26)}`, agentConnectionId: agent.connectionId, body: "forged", createdAtMs: 3,
      }) }],
    });
    expect(ids(await ok(await read({})) as ChatPage)).toEqual(["third", "second", "first"]);

    await expectRefused(await read({ channelWireId: "wire-b" }));
    await expectRefused(await read({ channelWireId: "wire-nowhere" }));
    expect((await read({ limit: 101 })).status).toBe(400);
  });

  it("leaves out a thread whose first create names the channel and also binds a file", async () => {
    const f = await fixture();
    const agent = await signIn(f);
    await putBlob(f.h, OWNER, WS_A, "key");
    await appendLog(f.h, OWNER, WS_A, [moment("config/.env", "key", { originSeq: 0, objectId: "object-env" })]);
    fromComputer(f, WS_A, [
      chatChannelCreate("wire-team"),
      chatThreadCreate("thread-team", "wire-team"),
      chatThreadCreate("thread-both", "wire-team", { linkedObjectId: "object-env", linkedAtMs: 2 }),
      ownerSays("in-channel", "thread-team", "in the channel"),
      ownerSays("on-file", "thread-both", "about the file"),
      ownerSays("in-channel-again", "thread-team", "in the channel again"),
    ]);

    const page = await ok(await tool(f, agent, "chat", { workspaceId: WS_A, channelWireId: "wire-team" })) as ChatPage;
    expect(ids(page)).toEqual(["in-channel-again", "in-channel"]);
    expect(JSON.stringify(page)).not.toContain("about the file");
  });

  it("lists the workspace's current files and reads a current file's bytes, only through that workspace", async () => {
    const f = await fixture();
    const agent = await signIn(f);
    const sha = await putBlob(f.h, OWNER, WS_A, "hello");
    const stale = await putBlob(f.h, OWNER, WS_A, "not a current file");
    await appendLog(f.h, OWNER, WS_A, [moment("notes/a.md", "hello", { originSeq: 0 })]);
    const inB = await putBlob(f.h, OWNER, WS_B, "in b");
    await appendLog(f.h, OWNER, WS_B, [moment("notes/b.md", "in b", { originSeq: 0 })]);

    expect(await ok(await tool(f, agent, "files", { workspaceId: WS_A }))).toMatchObject({
      workspaceId: WS_A, truncated: false, files: [expect.objectContaining({ path: "notes/a.md", blobSha256: sha })],
    });
    const read = await tool(f, agent, "blob", { workspaceId: WS_A, sha256: sha });
    expect(read.status).toBe(200);
    expect(await read.text()).toBe("hello");
    await expectRefused(await tool(f, agent, "blob", { workspaceId: WS_A, sha256: stale }));
    await expectRefused(await tool(f, agent, "blob", { workspaceId: WS_A, sha256: inB }));
    await expectCode(await tool(f, agent, "blob", { workspaceId: WS_B, sha256: inB }), 403, "personal_agent_out_of_reach");
    expect((await tool(f, agent, "blob", { workspaceId: WS_A, sha256: "not-a-sha" })).status).toBe(400);
  });

  it("keeps a secret file out of the file list, and its bytes out of reach", async () => {
    const f = await fixture();
    const agent = await signIn(f);
    const sha = await putBlob(f.h, OWNER, WS_A, "hello");
    const ciphertext = await putBlob(f.h, OWNER, WS_A, "ciphertext");
    const plaintext = await putBlob(f.h, OWNER, WS_A, "KEY=value");
    await appendLog(f.h, OWNER, WS_A, [
      moment("notes/a.md", "hello", { originSeq: 0 }),
      moment("config/.env.local", "KEY=value", { originSeq: 1 }),
      {
        originSeq: 2, opKind: "secret.file.put", recordedAtMs: 1_002, payload: {
          versionId: "main", path: "config/.env", metadata: { origin: "user" },
          ivBase64: "AA==", authTagBase64: "AA==", ciphertextSha256: ciphertext, byteLength: 10,
        },
      },
    ]);

    const listed = await ok(await tool(f, agent, "files", { workspaceId: WS_A }));
    expect(listed.files).toEqual([expect.objectContaining({ path: "notes/a.md", blobSha256: sha })]);
    expect(JSON.stringify(listed)).not.toContain("config/");
    await expectRefused(await tool(f, agent, "blob", { workspaceId: WS_A, sha256: ciphertext }));
    await expectRefused(await tool(f, agent, "blob", { workspaceId: WS_A, sha256: plaintext }));
  });

  it("ends a file's stream at the next chunk once the agent's access ends", async () => {
    const f = await fixture();
    const agent = await signIn(f, { reach: BOTH_VIEW });
    const content = "z".repeat(200_000);
    const sha = await putBlob(f.h, OWNER, WS_A, content);
    await appendLog(f.h, OWNER, WS_A, [moment("notes/large.md", content, { originSeq: 0 })]);
    const open = async () => {
      const response = await tool(f, agent, "blob", { workspaceId: WS_A, sha256: sha });
      expect(response.status).toBe(200);
      const reader = response.body!.getReader();
      expect((await reader.read()).value?.byteLength).toBe(64 * 1024);
      return reader;
    };

    // A reach change ends it as running work.
    const narrowed = await open();
    await ok(await setReach(f, agent, [{ workspaceId: WS_B, level: "view" }]));
    await expect(narrowed.read()).rejects.toThrow("personal agent access changed during stream");

    // Ownership lost: the next chunk's check refuses.
    await ok(await setReach(f, agent, BOTH_VIEW));
    const lost = await open();
    setOwner(f, WS_A, OTHER);
    await expect(lost.read()).rejects.toMatchObject({ code: "not_found" });

    // A reset with its notification withheld: the next chunk reads the fence again and refuses.
    setOwner(f, WS_A, OWNER);
    const reset = await open();
    f.fence.changePassword(OWNER, NEW_PASSWORD);
    await expect(reset.read()).rejects.toMatchObject({ code: "not_found" });
  });
});
