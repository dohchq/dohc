import type { StorageContext } from "./storage/context";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fenceAccount, initializeAccountDeletion } from "./storage/accountDeletion";
import { agentChannelWireId, GENERAL_CHANNEL_WIRE_ID } from "@dohc/security-contract/chat-wire-ids";

import type { RelayNoticePage } from "@dohc/workspace-contracts/relay";
import type {
  ConsentCredentials,
  CredentialFence,
  CredentialFenceChange,
  CredentialFenceListener,
} from "@dohc/workspace-auth/credentialFence";
import { CREDENTIAL_FENCE_READ_TIMEOUT_MS } from "@dohc/workspace-auth/credentialFence";
import type { WorkspaceAuth } from "@dohc/workspace-auth/betterAuth";
import {
  createAccountSessionResolver,
  UnauthorizedError,
  type ResolveAccountSession,
} from "@dohc/workspace-auth/session";

import { PERSONAL_WRITE_WORKSPACE_HEADER } from "./collectionWriteRoutes";
import { DiscussionActivityHub } from "./discussionActivity";
import { errorResponse, notFound } from "./errors";
import { pkceS256Challenge } from "./linkSecurity";

import { singleFlightFenceReads, type PersonalRunningEntry } from "./personalAgents";
import {
  personalAgentOrigin,
  personalCollectionOrigin,
  PERSONAL_MESSAGE_ID_PREFIX,
  PERSONAL_THREAD_ID_PREFIX,
} from "./relayLogInputs";
import type { createSyncRelayHandler } from "./server";
import type { SyncRelayStorage } from "./storage";

import {
  appendLog,
  chatChannelCreate,
  chatMessageAppend,
  chatThreadCreate,
  claimWorkspace,
  closeTestStorage,
  closeTestStorages,
  createShare,
  expectNoDeletedDigest,
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
  resolveTestAccountSession,
  resolveTestActor,
  sequenced,
  SHARE_WEB_ORIGIN,
  storagePath,
  testHandler,
  testStorage,
  type ChatOp,
  type HandlerOverrides,
} from "./testing";

const OWNER = "owner";
const DELETION_KEY = "personal-agent-deletion-key-at-least-32-bytes";
const OTHER = "other-account";
const WS_A = "workspace-a";
const WS_B = "workspace-b";
const OTHER_WS = "workspace-other";
const REDIRECT = "http://127.0.0.1:43110/callback";
const VERIFIER = "agent-pkce-verifier-0123456789-abcdefghijklmnopqrstuvwxyz";
// A session began before any password change unless a test starts it with
// `startSession`, as a browser that signs in again does.
const SESSIONS: Record<string, string> = {
  "owner-session": OWNER,
  "owner-new-session": OWNER,
  "other-session": OTHER,
  "joiner-session": "joiner-account",
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

/** The Postgres fence as the relay sees it: epochs, when sessions began, and the notification channel. */
class FakeFence implements CredentialFence {
  readonly epochs = new Map<string, number>();
  readonly changes: CredentialFenceChange[] = [];
  readonly changedSinceCalls: number[] = [];
  down = false;
  listener: CredentialFenceListener | undefined;
  /** A commit that lands just after consent's read. */
  afterConsentRead: (() => void) | undefined;
  private clock = 1_000;
  /** The order each account's last password change and each session's start committed in. */
  private order = 0;
  private readonly lastChange = new Map<string, number>();
  private readonly sessionStarts = new Map<string, number>();

  async readEpoch(userId: string): Promise<number> {
    this.assertUp();
    return this.epochs.get(userId) ?? 0;
  }

  async readConsentCredentials(
    userId: string,
    sessionId: string,
  ): Promise<ConsentCredentials | null> {
    this.assertUp();
    const read = {
      epoch: this.epochs.get(userId) ?? 0,
      sessionCurrent:
        (this.sessionStarts.get(sessionId) ?? 0) >= (this.lastChange.get(userId) ?? 0),
    };
    const commit = this.afterConsentRead;
    this.afterConsentRead = undefined;
    commit?.();
    return read;
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
  changePassword(userId: string, changedAtMs?: number): CredentialFenceChange {
    this.clock += 1_000;
    const change = {
      userId,
      epoch: (this.epochs.get(userId) ?? 0) + 1,
      changedAtMs: changedAtMs ?? this.clock,
    };
    this.epochs.set(userId, change.epoch);
    this.lastChange.set(userId, ++this.order);
    this.changes.push(change);
    return change;
  }

  /** A browser signs in, so its session begins after every change so far. */
  startSession(sessionId: string): void {
    this.sessionStarts.set(sessionId, ++this.order);
  }

  private assertUp(): void {
    if (this.down) throw new Error("The database is unreachable.");
  }
}

const resolveSession: ResolveAccountSession = async (incoming) => {
  const sessionId = /(?:^|;\s*)session=([^;]+)/u.exec(incoming.headers.get("cookie") ?? "")?.[1];
  const userId = sessionId === undefined ? undefined : SESSIONS[sessionId];
  if (!sessionId || !userId) throw new UnauthorizedError();
  return { userId, sessionId, expiresAtMs: Number.MAX_SAFE_INTEGER, clientKind: "browser" };
};

const handlers: Handler[] = [];
const cleanup: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const close of cleanup.splice(0)) await close();
  await Promise.all(handlers.splice(0).map((h) => h.dispose()));
  await closeTestStorages();
});

function handler(
  storage: SyncRelayStorage,
  f: Pick<Fixture, "now" | "fence" | "activity">,
  overrides: HandlerOverrides = {},
): Handler {
  const h = testHandler(storage, {
    nowMs: () => f.now.value,
    relayExchangeKey: RELAY_EXCHANGE_KEY,
    credentialFence: f.fence,
    resolvePhoneCapableAccountSession: resolveTestAccountSession,
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
  return {
    agentId: "probe",
    ownerUserId: "probe",
    connectionId: "probe",
    fenceEpoch: 0,
    workspaceIds: [],
    kind: "wait",
    terminate: () => {},
  };
}

/** The fence listener comes up and catches up, so running work can start. */
async function listening(f: Pick<Fixture, "fence" | "h">): Promise<void> {
  f.fence.listener!.onUp();
  await vi.waitFor(() => f.h.personalAgents.register(probe())());
}

async function fixture(overrides: HandlerOverrides = {}): Promise<Fixture> {
  const storage = await testStorage();
  const parts = {
    now: { value: 10_000 },
    fence: new FakeFence(),
    activity: new DiscussionActivityHub(),
  };
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

async function expectRefused(response: Response): Promise<void> {
  const refusal = errorResponse(notFound());
  expect({ status: response.status, body: await response.text() }).toEqual({
    status: refusal.status,
    body: await refusal.text(),
  });
}

async function expectCode(response: Response, status: number, code: string): Promise<void> {
  expect(response.status, await response.clone().text()).toBe(status);
  expect((await json(response)).code).toBe(code);
}

function cookie(session: string): Record<string, string> {
  return { cookie: `session=${session}` };
}

/** A call from share-web. `ip` is the address share-web reports for the caller. */
function internal(
  f: Fixture,
  path: string,
  body: unknown,
  headers: Record<string, string> = {},
  ip?: string,
): Promise<Response> {
  const forwarded = request(null, `/sync/link/${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-dohc-relay-exchange-key": RELAY_EXCHANGE_KEY,
      ...headers,
    },
    body: JSON.stringify(body),
  });
  if (ip !== undefined) forwarded.headers.set("x-dohc-relay-client-ip", ip);
  return f.h(forwarded);
}

async function registerClient(
  f: Fixture,
  reported: { clientName?: string; clientVersion?: string } = { clientName: "Test agent" },
): Promise<string> {
  const body = await ok(
    await internal(f, "agent-clients", {
      registration: "registered",
      redirectUris: [REDIRECT],
      ...reported,
    }),
  );
  return String(body.clientId);
}

function begin(f: Fixture, clientId: string, resource: string, ip?: string): Promise<Response> {
  return internal(
    f,
    "agent-authorizations",
    {
      clientId,
      resource,
      redirectUri: REDIRECT,
      codeChallenge: pkceS256Challenge(VERIFIER),
      codeChallengeMethod: "S256",
      state: "agent-state",
    },
    {},
    ip,
  );
}

async function beginRequest(
  f: Fixture,
  clientId: string,
  workspaceId = WS_A,
  ip?: string,
): Promise<string> {
  return String((await ok(await begin(f, clientId, resourceFor(workspaceId), ip))).requestId);
}

function consent(f: Fixture, requestId: string, session = "owner-session"): Promise<Response> {
  return internal(f, "agent-authorizations/personal-consent", { requestId }, cookie(session));
}

function allow(
  f: Fixture,
  requestId: string,
  input: {
    agent?: AgentChoice;
    reach?: Reach;
    session?: string;
  } = {},
): Promise<Response> {
  return internal(
    f,
    "agent-authorizations/personal-decision",
    {
      requestId,
      decision: "allow",
      agent: input.agent ?? { kind: "new", name: "Helper" },
      reach: input.reach ?? [{ workspaceId: WS_A, level: "view" }],
    },
    cookie(input.session ?? "owner-session"),
  );
}

async function approve(
  f: Fixture,
  input: {
    clientId: string;
    workspaceId?: string;
    agent?: AgentChoice;
    reach?: Reach;
    session?: string;
  },
): Promise<{ code: string; resource: string }> {
  const workspaceId = input.workspaceId ?? WS_A;
  const requestId = await beginRequest(f, input.clientId, workspaceId);
  const allowed = await ok(await allow(f, requestId, input));
  expect(allowed).toMatchObject({ redirectUri: REDIRECT, state: "agent-state" });
  return { code: String(allowed.code), resource: resourceFor(workspaceId) };
}

function redeem(
  f: Fixture,
  input: { clientId: string; code: string; resource: string },
): Promise<Response> {
  return internal(f, "agent-token", {
    grantType: "authorization_code",
    clientId: input.clientId,
    code: input.code,
    redirectUri: REDIRECT,
    codeVerifier: VERIFIER,
    resource: input.resource,
  });
}

function refresh(
  f: Fixture,
  clientId: string,
  refreshToken: string,
  resource: string,
): Promise<Response> {
  return internal(f, "agent-token", {
    grantType: "refresh_token",
    clientId,
    refreshToken,
    resource,
  });
}

function agentRequest(accessToken: string, resource: string): Request {
  return new Request("http://relay.test/sync/link/agent-chat", {
    headers: {
      authorization: `DohcAgent ${accessToken}`,
      "x-dohc-agent-resource": resource,
      "x-dohc-relay-exchange-key": RELAY_EXCHANGE_KEY,
    },
  });
}

async function signIn(
  f: Fixture,
  input: {
    clientId?: string;
    workspaceId?: string;
    agent?: AgentChoice;
    reach?: Reach;
    session?: string;
  } = {},
): Promise<Signed> {
  const clientId = input.clientId ?? (await registerClient(f));
  const { code, resource } = await approve(f, { ...input, clientId });
  const tokens = await ok(await redeem(f, { clientId, code, resource }));
  const accessToken = String(tokens.accessToken);
  const authority = await f.h.linkAuthority.personal(agentRequest(accessToken, resource));
  return {
    clientId,
    resource,
    accessToken,
    refreshToken: String(tokens.refreshToken),
    agentId: authority.agentId,
    connectionId: authority.connectionId,
    fenceEpoch: authority.fenceEpoch,
  };
}

function expectPersonal(f: Fixture, signed: Pick<Signed, "accessToken" | "resource">) {
  return expect(f.h.linkAuthority.personal(agentRequest(signed.accessToken, signed.resource)));
}

function running(
  f: Fixture,
  signed: Signed,
  workspaceIds: string[],
  kind: PersonalRunningEntry["kind"] = "stream",
) {
  const terminate = vi.fn();
  f.h.personalAgents.register({
    agentId: signed.agentId,
    ownerUserId: OWNER,
    connectionId: signed.connectionId,
    fenceEpoch: signed.fenceEpoch,
    workspaceIds,
    kind,
    terminate,
  });
  return terminate;
}

function owner(
  f: Fixture,
  path: string,
  init: { method: string; body?: unknown } = { method: "GET" },
  userId = OWNER,
): Promise<Response> {
  return f.h(
    request(
      userId,
      `/sync/personal-agents${path}`,
      init.body === undefined
        ? { method: init.method }
        : {
            method: init.method,
            headers: { "content-type": "application/json" },
            body: JSON.stringify(init.body),
          },
    ),
  );
}

async function roster(f: Fixture, userId = OWNER) {
  return (await ok(await owner(f, "", { method: "GET" }, userId))) as {
    revision: number;
    agents: {
      agentId: string;
      name: string;
      hue: string;
      status: string;
      reportedProduct: string | null;
      reportedVersion: string | null;
      createdAtMs: number;
      signedInAtMs: number | null;
      lastActionAtMs: number | null;
      reach: Reach;
    }[];
    workspaces: {
      workspaceId: string;
      name: string | null;
      role: "owner" | "admin" | "member" | "ended";
    }[];
  };
}

function count(f: Fixture, table: string, where = "1", ...params: unknown[]): number {
  return inspect(f.dbPath, (db) =>
    Number(
      db.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE ${where}`).get(...params)?.count ??
        0,
    ),
  );
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
  it("asks only the workspace's owner, and offers View, Comment, and Edit over the workspaces it owns", async () => {
    const f = await fixture();
    const clientId = await registerClient(f);
    const requestId = await beginRequest(f, clientId);
    expect(await ok(await consent(f, requestId))).toMatchObject({
      reportedClientName: "Test agent",
      redirectUri: REDIRECT,
      workspaceId: WS_A,
      levels: ["view", "comment", "edit"],
      workspaces: [
        { workspaceId: WS_A, name: null, role: "owner" },
        { workspaceId: WS_B, name: null, role: "owner" },
      ],
      agents: [],
    });
    await expectRefused(await consent(f, requestId, "other-session"));
    await expectRefused(await allow(f, requestId, { session: "other-session" }));
    // No session is a sign-in, not a refusal.
    expect((await internal(f, "agent-authorizations/personal-consent", { requestId })).status).toBe(
      401,
    );

    const elsewhere = await beginRequest(f, clientId, OTHER_WS);
    await expectRefused(await consent(f, elsewhere));
    await expectRefused(await allow(f, elsewhere));
    expect(await ok(await consent(f, elsewhere, "other-session"))).toMatchObject({
      workspaces: [{ workspaceId: OTHER_WS, name: null }],
    });

    await expectRefused(
      await allow(f, requestId, { reach: [{ workspaceId: OTHER_WS, level: "view" }] }),
    );
    await expectRefused(
      await allow(f, requestId, { reach: [{ workspaceId: WS_A, level: "admin" as Level }] }),
    );
    await expectRefused(await allow(f, requestId, { reach: [] }));
    await ok(
      await allow(f, requestId, {
        reach: [
          { workspaceId: WS_A, level: "edit" },
          { workspaceId: WS_B, level: "view" },
        ],
      }),
    );
  });

  it("refuses redemption when the account no longer owns a workspace in the reach", async () => {
    const f = await fixture();
    const clientId = await registerClient(f);
    const { code, resource } = await approve(f, {
      clientId,
      reach: [
        { workspaceId: WS_A, level: "view" },
        { workspaceId: WS_B, level: "view" },
      ],
    });
    const db = inspectDatabase(f.dbPath, { foreignKeys: true });
    db.prepare("UPDATE sync_relay_workspaces SET owner_user_id = ? WHERE workspace_id = ?").run(
      OTHER,
      WS_B,
    );
    db.close();
    await expectRefused(await redeem(f, { clientId, code, resource }));
    expect((await roster(f)).agents).toEqual([]);

    const owned = await approve(f, { clientId });
    await ok(await redeem(f, { clientId, ...owned }));
  });
});

describe("families never mix", () => {
  async function linkAgent(f: Fixture, clientId: string) {
    const shareId = await createShare(f.h, OWNER, WS_A, {
      recipientUserId: "seed-recipient",
      paths: ["docs"],
    });
    const link = await ok(
      await f.h(
        request(OWNER, `/sync/${WS_A}/shares/${shareId}/links`, jsonBody({ access: "view" })),
      ),
    );
    const resource = `${SHARE_WEB_ORIGIN}/mcp/s/${linkSecret(link.url)}`;
    const requestId = String((await ok(await begin(f, clientId, resource))).requestId);
    const code = String(
      (
        await ok(
          await internal(f, "agent-authorizations/decision", { requestId, decision: "allow" }),
        )
      ).code,
    );
    return { resource, code };
  }

  it("redeems and refreshes each family's credentials only in its own tables", async () => {
    const f = await fixture();
    const clientId = await registerClient(f);
    const link = await linkAgent(f, clientId);
    const personal = await approve(f, { clientId });

    await expectRefused(
      await redeem(f, { clientId, code: link.code, resource: personal.resource }),
    );
    await expectRefused(
      await redeem(f, { clientId, code: personal.code, resource: link.resource }),
    );
    const linkTokens = await ok(await redeem(f, { clientId, ...link }));
    const personalTokens = await ok(await redeem(f, { clientId, ...personal }));

    await expectRefused(
      await refresh(f, clientId, String(linkTokens.refreshToken), personal.resource),
    );
    await expectRefused(
      await refresh(f, clientId, String(personalTokens.refreshToken), link.resource),
    );
    await ok(await refresh(f, clientId, String(linkTokens.refreshToken), link.resource));
    await ok(await refresh(f, clientId, String(personalTokens.refreshToken), personal.resource));

    await expectRefused(
      await internal(f, "agent-introspect", { accessToken: String(personalTokens.accessToken) }),
    );
  });

  it("refuses an approval from the owner's phone session sent as a cookie", async () => {
    // Better Auth answers for the cookie; the relay's default account resolver judges its kind.
    const auth = {
      api: {
        getSession: async ({ headers }: { headers: Headers }) => {
          const token = /(?:^|;\s*)session=([^;]+)/u.exec(headers.get("cookie") ?? "")?.[1];
          const clientKind =
            token === "owner-phone" ? "phone" : token === "owner-session" ? "browser" : undefined;
          return clientKind
            ? {
                user: { id: OWNER },
                session: { id: token, userId: OWNER, expiresAt: 8_000_000_000_000, clientKind },
              }
            : null;
        },
      },
    } as unknown as WorkspaceAuth;
    const f = await fixture({ resolveAccountSession: createAccountSessionResolver(auth) });
    const requestId = await beginRequest(f, await registerClient(f), WS_A);
    const phone = await allow(f, requestId, { session: "owner-phone" });
    const unknown = await allow(f, requestId, { session: "nobody" });
    expect({ status: phone.status, body: await phone.text() }).toEqual({
      status: unknown.status,
      body: await unknown.text(),
    });
    expect(phone.status).toBe(401);
    expect((await roster(f)).agents).toEqual([]);
    await ok(await allow(f, requestId, { session: "owner-session" }));
  });

  it("lets the owner's phone list, sign out, remove and restore agents, and change nothing else", async () => {
    const f = await fixture();
    const signed = await signIn(f);
    const asPhone = (path: string, init: { method: string; body?: unknown } = { method: "GET" }) =>
      f.h(
        new Request(`http://relay.test/sync/personal-agents${path}`, {
          method: init.method,
          headers: {
            authorization: `Bearer phone:${OWNER}`,
            ...(init.body === undefined ? {} : { "content-type": "application/json" }),
          },
          ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
        }),
      );
    expect((await ok(await asPhone(""))).agents).toEqual([
      expect.objectContaining({ agentId: signed.agentId, status: "active" }),
    ]);
    for (const [action, body] of [
      ["reach", { reach: [{ workspaceId: WS_B, level: "comment" }] }],
      ["name", { name: "Renamed by a phone" }],
      ["hue", { hue: "teal" }],
    ] as const)
      await expectRefused(await asPhone(`/${signed.agentId}/${action}`, { method: "PUT", body }));
    expect((await roster(f)).agents).toEqual([
      expect.objectContaining({
        name: "Helper",
        reach: [{ workspaceId: WS_A, level: "view" }],
      }),
    ]);
    for (const [action, status] of [
      ["sign-out", "signed_out"],
      ["remove", "removed"],
      ["restore", "signed_out"],
    ] as const)
      expect(
        (await ok(await asPhone(`/${signed.agentId}/${action}`, { method: "POST" }))).agent,
        action,
      ).toMatchObject({ status });
  });

  it("refuses an agent's token at the owner's routes", async () => {
    const f = await fixture();
    const signed = await signIn(f);
    const asAgent = (path: string, init: RequestInit = {}) =>
      f.h(
        new Request(`http://relay.test${path}`, {
          ...init,
          headers: {
            authorization: `DohcAgent ${signed.accessToken}`,
            "x-dohc-agent-resource": signed.resource,
            "x-dohc-relay-exchange-key": RELAY_EXCHANGE_KEY,
            "content-type": "application/json",
          },
        }),
      );
    expect((await asAgent("/sync/personal-agents")).status).toBe(404);
    expect(
      (await asAgent(`/sync/personal-agents/${signed.agentId}/sign-out`, { method: "POST" }))
        .status,
    ).toBe(404);
    expect(
      (
        await asAgent(`/sync/personal-agents/${signed.agentId}/reach`, {
          method: "PUT",
          body: JSON.stringify({ reach: [{ workspaceId: WS_B, level: "comment" }] }),
        })
      ).status,
    ).toBe(404);
    expect(
      (await f.h(request(OWNER, "/sync/personal-agents", { headers: cookie("owner-session") })))
        .status,
    ).toBe(404);

    expect((await roster(f)).agents).toEqual([
      expect.objectContaining({ status: "active", reach: [{ workspaceId: WS_A, level: "view" }] }),
    ]);
    await expectPersonal(f, signed).resolves.toMatchObject({ agentId: signed.agentId });
  });
});

describe("revocation", () => {
  it("ends the connection when an old refresh token comes back", async () => {
    const f = await fixture();
    const agent = await signIn(f);
    const rotated = await ok(await refresh(f, agent.clientId, agent.refreshToken, agent.resource));
    await expectPersonal(f, {
      accessToken: String(rotated.accessToken),
      resource: agent.resource,
    }).resolves.toMatchObject({
      connectionId: agent.connectionId,
    });

    const terminate = running(f, agent, [WS_A]);
    await expectRefused(await refresh(f, agent.clientId, agent.refreshToken, agent.resource));
    expect(terminate).toHaveBeenCalledOnce();
    await expectRefused(
      await refresh(f, agent.clientId, String(rotated.refreshToken), agent.resource),
    );
    await expectPersonal(f, {
      accessToken: String(rotated.accessToken),
      resource: agent.resource,
    }).rejects.toMatchObject({ code: "not_found" });
    expect(
      count(f, "sync_relay_personal_agent_connections", "connection_id = ?", agent.connectionId),
    ).toBe(0);
    expect((await roster(f)).agents).toEqual([
      expect.objectContaining({ agentId: agent.agentId, status: "signed_out" }),
    ]);
  });

  it("refuses a request, write, redemption, and refresh once a reset commits, before any notification", async () => {
    const f = await fixture();
    const agent = await signIn(f);
    const authority = await f.h.linkAuthority.personal(
      agentRequest(agent.accessToken, agent.resource),
    );
    await expect(f.h.linkAuthority.freshPersonal(authority)).resolves.toMatchObject({
      connectionId: agent.connectionId,
    });
    const pending = await approve(f, { clientId: agent.clientId });

    f.fence.changePassword(OWNER);
    await expectPersonal(f, agent).rejects.toMatchObject({ code: "not_found" });
    await expect(f.h.linkAuthority.freshPersonal(authority)).rejects.toMatchObject({
      code: "not_found",
    });
    await expectRefused(await redeem(f, { clientId: agent.clientId, ...pending }));
    await expectRefused(await refresh(f, agent.clientId, agent.refreshToken, agent.resource));
    // The direct read refused them: no notification arrived, so nothing was cleaned up.
    expect(connectionTokens(f, agent.connectionId)).toBe(2);
  });

  it("ends running work while the notification channel is down, and keeps checking the fence directly", async () => {
    const f = await fixture();
    const agent = await signIn(f, {
      reach: [
        { workspaceId: WS_A, level: "view" },
        { workspaceId: WS_B, level: "view" },
      ],
    });
    const wait = running(f, agent, [WS_A], "wait");
    const stream = running(f, agent, [WS_B]);

    f.fence.listener!.onDown();
    expect(wait).toHaveBeenCalledTimes(1);
    expect(stream).toHaveBeenCalledTimes(1);
    expect(thrown(() => running(f, agent, [WS_A], "wait"))).toMatchObject({
      code: "personal_agent_unavailable",
      statusCode: 503,
    });
    await expectPersonal(f, agent).resolves.toMatchObject({ connectionId: agent.connectionId });

    f.fence.changePassword(OWNER);
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

    await expectPersonal(f, agent).rejects.toMatchObject({
      code: "personal_agent_unavailable",
      statusCode: 503,
    });
    await expectCode(
      await redeem(f, { clientId: agent.clientId, ...pending }),
      503,
      "personal_agent_unavailable",
    );
    await expectCode(
      await refresh(f, agent.clientId, agent.refreshToken, agent.resource),
      503,
      "personal_agent_unavailable",
    );
    await expectCode(await consent(f, requestId), 503, "personal_agent_unavailable");
    await expectCode(await allow(f, requestId), 503, "personal_agent_unavailable");
    // The owner's controls create no credentials, so they don't need it.
    expect((await roster(f)).agents).toHaveLength(1);

    f.fence.down = false;
    await expectPersonal(f, agent).resolves.toMatchObject({ connectionId: agent.connectionId });
    await ok(await redeem(f, { clientId: agent.clientId, ...pending }));
  });

  it("signs out the account's agents and ends their running work at account deletion's fence, before purge", async () => {
    const f = await fixture();
    const wake = vi.spyOn(f.activity, "wakeLog");
    const agent = await signIn(f, {
      reach: [
        { workspaceId: WS_A, level: "view" },
        { workspaceId: WS_B, level: "view" },
      ],
    });
    const stream = running(f, agent, [WS_A]);
    const wait = running(f, agent, [WS_B], "wait");
    const pending = await approve(f, { clientId: agent.clientId });

    const context = f.storage as StorageContext;
    initializeAccountDeletion(context, DELETION_KEY);
    const job = fenceAccount(context, DELETION_KEY, OWNER, `${OWNER}@dohc.test`);
    f.h.deleteAccount(
      OWNER,
      job.manifest!.workspaces.map((row) => row.workspaceId),
      job.manifest!.shareIds,
    );

    expect(stream).toHaveBeenCalledTimes(1);
    expect(wait).toHaveBeenCalledTimes(1);
    expect(wake).toHaveBeenCalledWith(WS_A);
    expect(wake).toHaveBeenCalledWith(WS_B);
    await expectPersonal(f, agent).rejects.toMatchObject({ code: "not_found" });
    await expectRefused(await redeem(f, { clientId: agent.clientId, ...pending }));
    expect(connectionTokens(f, agent.connectionId)).toBe(0);
    // Purge hasn't run: the agent's row is still there, signed out.
    expect(
      count(
        f,
        "sync_relay_personal_agents",
        "agent_id = ? AND status = 'signed_out'",
        agent.agentId,
      ),
    ).toBe(1);
  });

  it("keeps a signed-in agent's token across a relay reopen", async () => {
    const f = await fixture();
    const agent = await signIn(f);
    await f.h.dispose();
    closeTestStorage(f.storage);
    const storage = reopenTestStorage(f.dbPath);
    const reopened = { ...f, storage, h: handler(storage, f) };

    await expectPersonal(reopened, agent).resolves.toMatchObject({
      agentId: agent.agentId,
      connectionId: agent.connectionId,
    });
    await ok(await refresh(reopened, agent.clientId, agent.refreshToken, agent.resource));
  });

  it("adds the version and sign-in columns to a relay without them, and fills them at the next sign-in", async () => {
    const f = await fixture();
    const agent = await signIn(f);
    await f.h.dispose();
    closeTestStorage(f.storage);
    const db = inspectDatabase(f.dbPath);
    db.exec(`ALTER TABLE sync_relay_agent_clients DROP COLUMN reported_version;
      ALTER TABLE sync_relay_personal_agents DROP COLUMN reported_version;
      ALTER TABLE sync_relay_personal_agents DROP COLUMN signed_in_at_ms;
      DELETE FROM sync_relay_migrations WHERE migration_id = 'personal-agent-activity-v1';`);
    db.close();
    const storage = reopenTestStorage(f.dbPath);
    const reopened = { ...f, storage, h: handler(storage, f) };

    expect((await roster(reopened)).agents).toEqual([
      expect.objectContaining({
        agentId: agent.agentId,
        reportedProduct: "Test agent",
        reportedVersion: null,
        signedInAtMs: null,
      }),
    ]);
    f.now.value += 1_000;
    await signIn(reopened, {
      clientId: await registerClient(reopened, { clientName: "Test agent", clientVersion: "1.0" }),
      agent: { kind: "existing", agentId: agent.agentId },
    });
    expect((await roster(reopened)).agents).toEqual([
      expect.objectContaining({
        agentId: agent.agentId,
        reportedProduct: "Test agent",
        reportedVersion: "1.0",
        signedInAtMs: f.now.value,
      }),
    ]);
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

    expect(
      await changed(await owner(f, `${path}/name`, { method: "PUT", body: { name: "Research" } })),
    ).toMatchObject({ name: "Research" });
    expect(
      await changed(await owner(f, `${path}/hue`, { method: "PUT", body: { hue: "teal" } })),
    ).toMatchObject({ hue: "teal" });
    expect((await owner(f, `${path}/hue`, { method: "PUT", body: { hue: "neon" } })).status).toBe(
      400,
    );
    expect(
      await changed(
        await owner(f, `${path}/reach`, {
          method: "PUT",
          body: {
            reach: [
              { workspaceId: WS_A, level: "comment" },
              { workspaceId: WS_B, level: "view" },
            ],
          },
        }),
      ),
    ).toMatchObject({
      reach: [
        { workspaceId: WS_A, level: "comment" },
        { workspaceId: WS_B, level: "view" },
      ],
    });
    await expectCode(await owner(f, `${path}/remove`, { method: "POST" }), 409, "conflict");
    expect(await changed(await owner(f, `${path}/sign-out`, { method: "POST" }))).toMatchObject({
      status: "signed_out",
    });
    await expectPersonal(f, agent).rejects.toMatchObject({ code: "not_found" });
    expect(await changed(await owner(f, `${path}/remove`, { method: "POST" }))).toMatchObject({
      status: "removed",
    });
    expect((await roster(f)).agents).toEqual([]);
    expect(await changed(await owner(f, `${path}/restore`, { method: "POST" }))).toMatchObject({
      status: "signed_out",
      name: "Research",
    });

    expect(revisions).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect((await roster(f)).revision).toBe(7);
  });

  it("answers only the agent's own account", async () => {
    const f = await fixture();
    const agent = await signIn(f);
    await expectRefused(
      await owner(f, `/${agent.agentId}/name`, { method: "PUT", body: { name: "Mine" } }, OTHER),
    );
    await expectRefused(await owner(f, `/${agent.agentId}/sign-out`, { method: "POST" }, OTHER));
    await expectRefused(
      await owner(f, `/p-${"a".repeat(26)}/name`, { method: "PUT", body: { name: "Nobody" } }),
    );
    expect((await roster(f, OTHER)).agents).toEqual([]);
    expect((await roster(f)).agents).toEqual([
      expect.objectContaining({ name: "Helper", status: "active" }),
    ]);
    await expectPersonal(f, agent).resolves.toMatchObject({ agentId: agent.agentId });
  });

  it("sets reach only to the account's own workspaces, at View, Comment, or Edit", async () => {
    const f = await fixture();
    const agent = await signIn(f);
    const setReach = (reach: unknown) =>
      owner(f, `/${agent.agentId}/reach`, { method: "PUT", body: { reach } });
    expect((await setReach([{ workspaceId: OTHER_WS, level: "view" }])).status).toBe(400);
    expect((await setReach([{ workspaceId: WS_A, level: "admin" }])).status).toBe(400);
    expect(
      (
        await setReach([
          { workspaceId: WS_A, level: "view" },
          { workspaceId: WS_A, level: "comment" },
        ])
      ).status,
    ).toBe(400);
    expect((await setReach([{ workspaceId: WS_A, level: "view", extra: 1 }])).status).toBe(400);
    expect((await owner(f, `/${agent.agentId}/reach`, { method: "POST" })).status).toBe(405);
    expect((await roster(f)).agents[0]?.reach).toEqual([{ workspaceId: WS_A, level: "view" }]);
    await ok(await setReach([{ workspaceId: WS_A, level: "edit" }]));
    expect((await roster(f)).agents[0]?.reach).toEqual([{ workspaceId: WS_A, level: "edit" }]);
  });

  it("moves the Notice head with each roster change, so a read from before it answers the new revision and no row", async () => {
    const f = await fixture();
    const agent = await signIn(f);
    const read = async (query = "") =>
      (await ok(await f.h(request(OWNER, `/sync/notices${query}`)))) as unknown as RelayNoticePage;
    const before = await read();
    await ok(
      await owner(f, `/${agent.agentId}/name`, { method: "PUT", body: { name: "Research" } }),
    );
    const after = await read(`?cursor=${before.nextCursor}`);
    expect(after).toMatchObject({
      notices: [],
      hasMore: false,
      replace: false,
      personalAgentsRevision: before.personalAgentsRevision + 1,
    });
    expect(Number(after.nextCursor)).toBe(Number(before.nextCursor) + 1);
  });
});

type WaitCursor = { v: 1; agentId: string; seqs: Record<string, number>; turn: string | null };
type WaitAnswer = {
  ok: true;
  messages: Array<Record<string, unknown>>;
  cursor: WaitCursor;
  more: boolean;
};
type ChatPage = { messages: Array<Record<string, unknown>>; olderCursor: number | null };

const computerSeqs = new WeakMap<SyncRelayStorage, Map<string, number>>();

function fromComputer(f: Fixture, workspaceId: string, ops: ChatOp[]): void {
  const seqs = computerSeqs.get(f.storage) ?? new Map<string, number>();
  computerSeqs.set(f.storage, seqs);
  for (let start = 0; start < ops.length; start += 500) {
    const batch = ops.slice(start, start + 500);
    const first = seqs.get(workspaceId) ?? 0;
    f.storage.appendLogBatch({
      workspaceId,
      originId: "owner-computer",
      ops: sequenced(batch, first).map(({ payload, ...op }) => ({
        ...op,
        payloadJson: JSON.stringify(payload),
      })),
    });
    seqs.set(workspaceId, first + batch.length);
  }
  f.activity.wakeLog(workspaceId);
}

function ownerSays(
  messageId: string,
  threadId: string,
  body: string,
  extra: Record<string, unknown> = {},
): ChatOp {
  return chatMessageAppend(messageId, threadId, body, {
    authorUserId: OWNER,
    authorDisplayName: "Ada",
    ...extra,
  });
}

function fileThread(threadId: string, binding: Record<string, string>): ChatOp {
  return {
    opKind: "chat.thread.create",
    payload: { threadId, title: "", createdAtMs: 2, linkedAtMs: 2, ...binding },
  };
}

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
  f: Fixture,
  agent: Pick<Signed, "accessToken" | "resource">,
  action: string,
  body: unknown,
  signal?: AbortSignal,
  headers: Record<string, string> = {},
): Promise<Response> {
  return f.h(
    request(null, `/sync/link/personal-agent/${action}`, {
      method: "POST",
      headers: {
        authorization: `DohcAgent ${agent.accessToken}`,
        "x-dohc-agent-resource": agent.resource,
        "x-dohc-relay-exchange-key": RELAY_EXCHANGE_KEY,
        "content-type": "application/json",
        ...headers,
      },
      ...(body instanceof ReadableStream
        ? { body, duplex: "half" }
        : { body: JSON.stringify(body) }),
      ...(signal === undefined ? {} : { signal }),
    } as RequestInit),
  );
}

function post(f: Fixture, agent: Signed, fields: Record<string, unknown>): Promise<Response> {
  return tool(f, agent, "post", {
    workspaceId: WS_A,
    body: "from the agent",
    idempotencyKey: "post-1",
    ...fields,
  });
}

async function waitOnce(
  f: Fixture,
  agent: Signed,
  fields: Record<string, unknown> = {},
): Promise<WaitAnswer> {
  return (await ok(await tool(f, agent, "wait", { timeoutMs: 0, ...fields }))) as WaitAnswer;
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

async function parked(f: Fixture, count: number): Promise<void> {
  await vi.waitFor(() => expect(f.activity.stats().waiters).toBe(count));
}

function setOwner(f: Fixture, workspaceId: string, userId: string): void {
  const db = inspectDatabase(f.dbPath, { foreignKeys: true });
  try {
    db.prepare("UPDATE sync_relay_workspaces SET owner_user_id = ? WHERE workspace_id = ?").run(
      userId,
      workspaceId,
    );
  } finally {
    db.close();
  }
}

function setReach(f: Fixture, agent: Signed, reach: Reach): Promise<Response> {
  return owner(f, `/${agent.agentId}/reach`, { method: "PUT", body: { reach } });
}

const BOTH_VIEW: Reach = [
  { workspaceId: WS_A, level: "view" },
  { workspaceId: WS_B, level: "view" },
];

describe("a personal agent's posts", () => {
  it("posts as itself from its own origin, with its account, connection, and current name, whatever the request names", async () => {
    const f = await fixture();
    const agent = await signIn(f, { reach: [{ workspaceId: WS_A, level: "comment" }] });
    chats(f, WS_A, agent.agentId);
    const dm = agentChannelWireId(agent.agentId);
    const before = logOf(f, WS_A).length;

    for (const forged of [
      { authorUserId: OTHER },
      { authorAgentId: `p-${"b".repeat(26)}` },
      { originId: "owner-computer" },
    ]) {
      expect((await post(f, agent, { channelWireId: dm, ...forged })).status).toBe(400);
    }
    expect(logOf(f, WS_A)).toHaveLength(before);

    const { message } = (await ok(await post(f, agent, { channelWireId: dm }))) as {
      message: Record<string, unknown>;
    };
    expect(message).toMatchObject({
      workspaceId: WS_A,
      channelWireId: dm,
      authorKind: "agent",
      authorDisplayName: "Helper",
      linkAgent: false,
      body: "from the agent",
    });
    expect(String(message.messageId).startsWith(PERSONAL_MESSAGE_ID_PREFIX)).toBe(true);
    expect(String(message.threadId).startsWith(PERSONAL_THREAD_ID_PREFIX)).toBe(true);
    const [thread, appended] = logOf(f, WS_A).slice(before);
    expect(thread).toMatchObject({
      originId: personalAgentOrigin(agent.agentId),
      opKind: "chat.thread.create",
    });
    expect(payloadOf(thread!)).toMatchObject({
      threadId: message.threadId,
      channelWireId: dm,
      lane: "chat",
    });
    expect(appended).toMatchObject({
      originId: personalAgentOrigin(agent.agentId),
      opKind: "chat.message.append",
    });
    expect(payloadOf(appended!)).toMatchObject({
      messageId: message.messageId,
      authorKind: "agent",
      authorUserId: OWNER,
      authorAgentId: agent.agentId,
      agentConnectionId: agent.connectionId,
      authorDisplayName: "Helper",
    });

    expect((await ok(await post(f, agent, { channelWireId: dm }))).message).toMatchObject({
      messageId: message.messageId,
    });
    await expectCode(
      await post(f, agent, { channelWireId: dm, body: "something else" }),
      409,
      "conflict",
    );
    expect(logOf(f, WS_A)).toHaveLength(before + 2);

    await ok(
      await owner(f, `/${agent.agentId}/name`, { method: "PUT", body: { name: "Research" } }),
    );
    expect(
      (await ok(await post(f, agent, { threadId: "thread-team", idempotencyKey: "post-2" })))
        .message,
    ).toMatchObject({
      threadId: "thread-team",
      channelWireId: "wire-team",
      authorDisplayName: "Research",
    });
    expect(count(f, "sync_relay_personal_agent_threads", "agent_id = ?", agent.agentId)).toBe(2);
  });

  it("deletes its own message at View, and not its person's or another agent's", async () => {
    const f = await fixture();
    const reach: Reach = [{ workspaceId: WS_A, level: "comment" }];
    const agent = await signIn(f, { reach });
    const second = await signIn(f, { agent: { kind: "new", name: "Second" }, reach });
    chats(f, WS_A, agent.agentId);
    fromComputer(f, WS_A, [ownerSays("from-owner", "thread-team", "the owner's words")]);
    const mine = (await ok(await post(f, agent, { threadId: "thread-team" }))).message as {
      messageId: string;
    };
    const theirs = (await ok(await post(f, second, { threadId: "thread-team" }))).message as {
      messageId: string;
    };
    await ok(await setReach(f, agent, [{ workspaceId: WS_A, level: "view" }]));
    const remove = (messageId: string) =>
      tool(f, agent, "delete", { workspaceId: WS_A, threadId: "thread-team", messageId });

    expect(await ok(await remove(mine.messageId))).toMatchObject({
      workspaceId: WS_A,
      threadId: "thread-team",
      messageId: mine.messageId,
    });
    await expectRefused(await remove("from-owner"));
    await expectRefused(await remove(theirs.messageId));
    // Every delete door takes the same id lengths.
    await expectRefused(await remove("m".repeat(512)));
    const kinds = logOf(f, WS_A).map((row) => [row.opKind, payloadOf(row).messageId]);
    expect(kinds).toContainEqual(["chat.message.tombstone", mine.messageId]);
    expect(kinds).toContainEqual(["chat.message.delete", mine.messageId]);
    expect(kinds).toContainEqual(["chat.message.append", "from-owner"]);
    expect(kinds).toContainEqual(["chat.message.append", theirs.messageId]);
  });

  it("reads and replies in a Comment thread by its id, on a current or deleted file, never on a secret path", async () => {
    const f = await fixture();
    await claimWorkspace(f.h, OWNER, "workspace-c");
    const agent = await signIn(f, {
      reach: [
        { workspaceId: WS_A, level: "comment" },
        { workspaceId: WS_B, level: "view" },
      ],
    });
    const deleted = (path: string, originSeq: number, objectId: string) =>
      moment(path, "", {
        originSeq,
        objectId,
        operation: "delete",
        beforePath: path,
        beforeContent: "plan",
        afterPath: null,
        afterContent: null,
      });
    await putBlob(f.h, OWNER, WS_A, "plan");
    await appendLog(f.h, OWNER, WS_A, [
      moment("notes/plan.md", "plan", { originSeq: 0, objectId: "object-plan" }),
      moment("notes/gone.md", "plan", { originSeq: 1, objectId: "object-gone" }),
      moment("notes/hidden.md", "plan", { originSeq: 2, objectId: "object-hidden" }),
      deleted("notes/gone.md", 3, "object-gone"),
      moment("config/prod.env", "plan", {
        originSeq: 4,
        objectId: "object-hidden",
        operation: "rename",
        beforePath: "notes/hidden.md",
        beforeContent: "plan",
      }),
      deleted("config/prod.env", 5, "object-hidden"),
    ]);
    await putBlob(f.h, OWNER, WS_B, "plan");
    await appendLog(f.h, OWNER, WS_B, [
      moment("notes/b.md", "plan", { originSeq: 0, objectId: "object-b" }),
      deleted("notes/b.md", 1, "object-b"),
    ]);
    await putBlob(f.h, OWNER, "workspace-c", "plan");
    await appendLog(f.h, OWNER, "workspace-c", [
      moment("notes/c.md", "plan", { originSeq: 0, objectId: "object-c" }),
    ]);
    fromComputer(f, WS_A, [
      fileThread("thread-plan", { linkedObjectId: "object-plan" }),
      ownerSays("on-plan", "thread-plan", "a note"),
      fileThread("thread-gone", { linkedObjectId: "object-gone" }),
      ownerSays("first", "thread-gone", "what about this?"),
      ownerSays("second", "thread-gone", "and this?"),
      fileThread("thread-hidden", { linkedObjectId: "object-hidden" }),
      ownerSays("on-hidden", "thread-hidden", "about the secret"),
      chatChannelCreate("wire-team"),
      chatThreadCreate("thread-team", "wire-team"),
    ]);
    fromComputer(f, WS_B, [
      fileThread("thread-b", { linkedObjectId: "object-b" }),
      ownerSays("on-b", "thread-b", "in b"),
    ]);
    fromComputer(f, "workspace-c", [fileThread("thread-c", { linkedObjectId: "object-c" })]);
    const read = (fields: Record<string, unknown>) =>
      tool(f, agent, "discussion", { workspaceId: WS_A, ...fields });

    const page = (await ok(await read({ threadId: "thread-gone", limit: 1 }))) as ChatPage &
      Record<string, unknown>;
    expect(page).toMatchObject({
      ok: true,
      workspaceId: WS_A,
      threadId: "thread-gone",
      filePath: "notes/gone.md",
    });
    expect(ids(page)).toEqual(["second"]);
    const older = (await ok(
      await read({ threadId: "thread-gone", limit: 1, before: page.olderCursor }),
    )) as ChatPage;
    expect(ids(older)).toEqual(["first"]);
    expect(older.olderCursor).toBeNull();
    const replied = (await ok(await post(f, agent, { threadId: "thread-gone", body: "an answer" })))
      .message as Record<string, unknown>;
    expect(replied).toMatchObject({
      threadId: "thread-gone",
      channelWireId: null,
      filePath: "notes/gone.md",
      body: "an answer",
    });
    expect(ids((await ok(await read({ threadId: "thread-gone" }))) as ChatPage)).toEqual([
      replied.messageId,
      "second",
      "first",
    ]);
    expect(await ok(await read({ threadId: "thread-plan" }))).toEqual({
      ok: true,
      workspaceId: WS_A,
      threadId: "thread-plan",
      filePath: "notes/plan.md",
      messages: [expect.objectContaining({ messageId: "on-plan" })],
      olderCursor: null,
    });

    expect((await read({ filePath: "notes/plan.md", threadId: "thread-plan" })).status).toBe(400);
    expect((await read({})).status).toBe(400);
    const before = logOf(f, WS_A).length;
    for (const threadId of ["thread-hidden", "thread-none", "thread-b"]) {
      await expectRefused(await read({ threadId }));
      await expectRefused(await post(f, agent, { threadId, idempotencyKey: `post-${threadId}` }));
    }
    expect(logOf(f, WS_A)).toHaveLength(before);
    await expectRefused(await read({ threadId: "thread-team" }));

    expect(
      ids((await ok(await read({ workspaceId: WS_B, threadId: "thread-b" }))) as ChatPage),
    ).toEqual(["on-b"]);
    await expectCode(
      await post(f, agent, { workspaceId: WS_B, threadId: "thread-b", idempotencyKey: "post-b" }),
      403,
      "personal_agent_view_only",
    );
    await expectCode(
      await read({ workspaceId: "workspace-c", threadId: "thread-c" }),
      403,
      "personal_agent_out_of_reach",
    );
    await expectCode(
      await post(f, agent, {
        workspaceId: "workspace-c",
        threadId: "thread-c",
        idempotencyKey: "post-c",
      }),
      403,
      "personal_agent_out_of_reach",
    );
    await ok(await setReach(f, agent, [{ workspaceId: WS_B, level: "view" }]));
    await expectCode(await read({ threadId: "thread-gone" }), 403, "personal_agent_out_of_reach");
    await expectCode(
      await post(f, agent, { threadId: "thread-gone", idempotencyKey: "post-gone" }),
      403,
      "personal_agent_out_of_reach",
    );
  });

  it("refuses a post when a reset commits while its body is still arriving", async () => {
    const f = await fixture();
    const agent = await signIn(f, { reach: [{ workspaceId: WS_A, level: "comment" }] });
    const dm = agentChannelWireId(agent.agentId);
    // The body's bytes come only when the relay reads them, after it authenticated the request.
    const arriving = (idempotencyKey: string, meanwhile: () => void) =>
      new ReadableStream<Uint8Array>(
        {
          pull(controller) {
            meanwhile();
            controller.enqueue(
              new TextEncoder().encode(
                JSON.stringify({
                  workspaceId: WS_A,
                  channelWireId: dm,
                  body: "late",
                  idempotencyKey,
                }),
              ),
            );
            controller.close();
          },
        },
        { highWaterMark: 0 },
      );

    await ok(
      await tool(
        f,
        agent,
        "post",
        arriving("post-1", () => {}),
      ),
    );
    const before = logOf(f, WS_A).length;
    // No notification: the read of the fence after the body refuses.
    await expectRefused(
      await tool(
        f,
        agent,
        "post",
        arriving("post-2", () => {
          f.fence.changePassword(OWNER);
        }),
      ),
    );
    expect(logOf(f, WS_A)).toHaveLength(before);
  });
});

describe("a personal agent's Collection writes", () => {
  const SCHEMA = "name: Packing\nfields:\n  Title:\n    type: text\n";
  const RECORD = "---\nid: rec_aaaaaaaaaaaaaaaaaaaaaaaaaa\n---\nSocks\n";
  const created = (path = "trip/packing/Socks.md", text = RECORD) => ({
    basedOnPath: null,
    basedOnBlobSha256: null,
    operation: "write",
    afterPath: path,
    afterContentKind: "text",
    afterContentBase64: Buffer.from(text).toString("base64"),
    recordedAtMs: 1,
  });
  const body = (changes: unknown[], fields: Record<string, unknown> = {}) => ({
    workspaceId: WS_A,
    submitId: "submit-1",
    changes,
    ...fields,
  });
  const writingTo = (workspaceId: string) => ({
    [PERSONAL_WRITE_WORKSPACE_HEADER]: encodeURIComponent(workspaceId),
  });
  const write = (
    f: Fixture,
    agent: Signed,
    changes: unknown[],
    fields: Record<string, unknown> = {},
  ) =>
    tool(
      f,
      agent,
      "collection-writes",
      body(changes, fields),
      undefined,
      writingTo(String(fields.workspaceId ?? WS_A)),
    );
  const written = (f: Fixture, agent: Signed) =>
    logOf(f, WS_A).filter((row) => row.originId === personalCollectionOrigin(agent.agentId));

  async function packing(f: Fixture): Promise<void> {
    await putBlob(f.h, OWNER, WS_A, SCHEMA);
    await appendLog(f.h, OWNER, WS_A, [
      moment("trip/packing/collection.yaml", SCHEMA, { originSeq: 0 }),
    ]);
  }

  it("writes at Edit from the agent's own origin, as the agent on its owner's behalf, once per submit", async () => {
    const f = await fixture();
    const agent = await signIn(f, { reach: [{ workspaceId: WS_A, level: "edit" }] });
    await packing(f);
    expect(await ok(await write(f, agent, [created()]))).toMatchObject({
      ok: true,
      submitId: "submit-1",
      paths: ["trip/packing/Socks.md"],
      created: true,
    });
    const rows = written(f, agent);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ opKind: "moment.append" });
    expect(payloadOf(rows[0]!)).toMatchObject({
      path: "trip/packing/Socks.md",
      authors: [{ kind: "agent", agentId: agent.agentId, onBehalfOf: OWNER }],
    });
    expect(await ok(await write(f, agent, [created()]))).toMatchObject({
      submitId: "submit-1",
      created: false,
    });
    await expectCode(await write(f, agent, [created("trip/packing/Hats.md")]), 409, "conflict");
    expect(written(f, agent)).toHaveLength(1);
  });

  it("refuses at View and Comment, any file outside a Collection, a workspace out of reach, and a field it does not take", async () => {
    const f = await fixture();
    const agent = await signIn(f, { reach: [{ workspaceId: WS_A, level: "view" }] });
    await packing(f);
    await expectCode(await write(f, agent, [created()]), 403, "personal_agent_edit_needed");
    await ok(await setReach(f, agent, [{ workspaceId: WS_A, level: "comment" }]));
    await expectCode(await write(f, agent, [created()]), 403, "personal_agent_edit_needed");
    await ok(await setReach(f, agent, [{ workspaceId: WS_A, level: "edit" }]));
    for (const path of ["notes.md", "notes/a.md", "trip/packing/photo.png"]) {
      await expectCode(
        await write(f, agent, [created(path)]),
        403,
        "personal_agent_not_collection",
      );
    }
    await expectCode(
      await write(f, agent, [created()], { workspaceId: OTHER_WS }),
      403,
      "personal_agent_out_of_reach",
    );
    expect((await write(f, agent, [created()], { note: "extra" })).status).toBe(400);
    // Its tool passes this reason on, so it says what to fix.
    const unread = await write(f, agent, [{ ...created(), afterContentBase64: "QR==" }]);
    expect({ status: unread.status, body: await json(unread) }).toMatchObject({
      status: 403,
      body: { code: "share_op_rejected", error: expect.stringContaining("standard base64") },
    });
    expect(written(f, agent)).toEqual([]);
  });

  it("refuses a retry of a write after sign-out, and never answers it as written", async () => {
    const cases: Array<
      [(f: Fixture, agent: Signed) => Promise<Response>, (response: Response) => Promise<void>]
    > = [[(f, agent) => owner(f, `/${agent.agentId}/sign-out`, { method: "POST" }), expectRefused]];
    for (const [revoke, refused] of cases) {
      const f = await fixture();
      const agent = await signIn(f, { reach: [{ workspaceId: WS_A, level: "edit" }] });
      await packing(f);
      await ok(await write(f, agent, [created()]));
      const retry = new ReadableStream<Uint8Array>(
        {
          async pull(controller) {
            await ok(await revoke(f, agent));
            controller.enqueue(new TextEncoder().encode(JSON.stringify(body([created()]))));
            controller.close();
          },
        },
        { highWaterMark: 0 },
      );
      await refused(await tool(f, agent, "collection-writes", retry, undefined, writingTo(WS_A)));
      await refused(await write(f, agent, [created()]));
      expect(written(f, agent)).toHaveLength(1);
    }
  });
});

describe("a personal agent's tools", () => {
  it("serve only a personal agent's token at its address, with the relay exchange key, by POST", async () => {
    const f = await fixture();
    const agent = await signIn(f);
    await ok(await tool(f, agent, "files", { workspaceId: WS_A }));
    await expectRefused(
      await f.h(
        request(null, "/sync/link/personal-agent/files", {
          method: "POST",
          headers: {
            authorization: `DohcAgent ${agent.accessToken}`,
            "x-dohc-agent-resource": agent.resource,
            "content-type": "application/json",
          },
          body: JSON.stringify({ workspaceId: WS_A }),
        }),
      ),
    );
    await expectRefused(
      await tool(f, { ...agent, accessToken: "x".repeat(43) }, "files", { workspaceId: WS_A }),
    );
    await expectRefused(
      await tool(f, { ...agent, resource: resourceFor(WS_B) }, "files", { workspaceId: WS_A }),
    );
    expect(
      (await f.h(request(null, "/sync/link/personal-agent/files", { method: "GET" }))).status,
    ).toBe(405);
    expect((await tool(f, agent, "list", {})).status).toBe(404);
    expect((await tool(f, agent, "files", { workspaceId: WS_A, extra: 1 })).status).toBe(400);
  });
});

/**
 * A relay with this server's copies of workspaces, each copy's engine an
 * in-memory stand-in for its chats. Each workspace in `identified` has a sync
 * identity, so a copy can open; by default every workspace the fixture claims
 * does. Syncs can be held.
 */
describe("a personal agent's Groups", () => {
  it("lists the workspace's Groups from the relay at View, and never General, a DM or an agent chat", async () => {
    const f = await fixture();
    const agent = await signIn(f, { reach: [{ workspaceId: WS_A, level: "view" }] });
    fromComputer(f, WS_A, [
      chatChannelCreate("wire-planning", { name: "Planning", purpose: "Where we go" }),
      chatChannelCreate(GENERAL_CHANNEL_WIRE_ID, { name: "General" }),
      chatChannelCreate("wire-people", { name: "Ada and Ben", kind: "dm" }),
      chatChannelCreate(agentChannelWireId(agent.agentId), { name: "Helper", kind: "agent" }),
    ]);

    expect(await ok(await tool(f, agent, "groups", { workspaceId: WS_A }))).toEqual({
      ok: true,
      workspaceId: WS_A,
      groups: [{ channelWireId: "wire-planning", name: "Planning", purpose: "Where we go" }],
    });
    await ok(await tool(f, agent, "chat", { workspaceId: WS_A, channelWireId: "wire-planning" }));

    for (const body of [{}, { workspaceId: WS_A, group: "planning" }]) {
      expect((await tool(f, agent, "groups", body)).status, JSON.stringify(body)).toBe(400);
    }
    await expectCode(
      await tool(f, agent, "groups", { workspaceId: WS_B }),
      403,
      "personal_agent_out_of_reach",
    );
  });

  it("ends with not-found, and no Group, once the agent signs out", async () => {
    const f = await fixture();
    const agent = await signIn(f, { reach: [{ workspaceId: WS_A, level: "view" }] });
    fromComputer(f, WS_A, [chatChannelCreate("wire-planning", { name: "Planning" })]);
    await ok(await owner(f, `/${agent.agentId}/sign-out`, { method: "POST" }));
    const response = await tool(f, agent, "groups", { workspaceId: WS_A });
    expect(await response.clone().text()).not.toContain("Planning");
    await expectRefused(response);
  });
});

describe("a personal agent's wait", () => {
  it("answers its owner's posts in its DM, mentioning its current name, and in threads it posted in, with where each is", async () => {
    const f = await fixture();
    const agent = await signIn(f, { reach: [{ workspaceId: WS_A, level: "comment" }] });
    chats(f, WS_A, agent.agentId);
    await putBlob(f.h, OWNER, WS_A, "plan");
    await appendLog(f.h, OWNER, WS_A, [
      moment("notes/plan.md", "plan", { originSeq: 0, objectId: "object-plan" }),
    ]);
    const elsewhere = agentChannelWireId(`p-${"b".repeat(26)}`);
    fromComputer(f, WS_A, [
      chatChannelCreate(elsewhere, { kind: "agent" }),
      chatThreadCreate("thread-elsewhere", elsewhere),
      {
        opKind: "chat.thread.create",
        payload: {
          threadId: "thread-file",
          title: "",
          createdAtMs: 2,
          linkedObjectId: "object-plan",
          linkedAtMs: 2,
        },
      },
    ]);
    await ok(await post(f, agent, { threadId: "thread-team" }));
    await ok(
      await owner(f, `/${agent.agentId}/name`, { method: "PUT", body: { name: "Research" } }),
    );
    fromComputer(f, WS_A, [
      ownerSays("dm", "thread-dm", "hello"),
      ownerSays("mention", "thread-other", "@Research a question"),
      ownerSays("reply", "thread-team", "thanks"),
      ownerSays("old-name", "thread-other", "@Helper an old handle"),
      ownerSays("unrelated", "thread-other", "no one in particular"),
      ownerSays("from-cli", "thread-dm", "from the CLI", { origin: "cli" }),
      ownerSays("as-agent", "thread-dm", "an agent's post", { authorKind: "agent" }),
      chatMessageAppend("other-account", "thread-dm", "hello", {
        authorUserId: OTHER,
        authorDisplayName: "Bo",
      }),
      chatMessageAppend("no-account", "thread-dm", "hello"),
      ownerSays("other-dm", "thread-elsewhere", "@Research in another agent's DM"),
      ownerSays("other-dm-unmentioned", "thread-elsewhere", "for the other agent"),
      ownerSays("on-file", "thread-file", "@Research a comment"),
      ownerSays("on-file-unmentioned", "thread-file", "a note"),
    ]);

    const answer = await waitOnce(f, agent);
    expect(ids(answer)).toEqual(["dm", "mention", "reply", "other-dm", "on-file"]);
    expect(answer.messages[0]).toMatchObject({
      workspaceId: WS_A,
      channelWireId: agentChannelWireId(agent.agentId),
      filePath: null,
      authorKind: "human",
      body: "hello",
    });
    expect(answer.messages[0]).not.toHaveProperty("authorUserId");
    expect(answer.messages[1]).toMatchObject({
      workspaceId: WS_A,
      channelWireId: "wire-team",
      filePath: null,
    });
    expect(answer.messages[3]).toMatchObject({
      workspaceId: WS_A,
      channelWireId: elsewhere,
      filePath: null,
    });
    expect(answer.messages[4]).toMatchObject({
      workspaceId: WS_A,
      channelWireId: null,
      filePath: "notes/plan.md",
    });
    expect(answer).toMatchObject({
      more: false,
      cursor: { v: 1, agentId: agent.agentId, turn: WS_A },
    });
    expect(ids(await waitOnce(f, agent, { cursor: answer.cursor }))).toEqual([]);
  });

  it("leaves out a message deleted while its answer waits on the fence", async () => {
    const f = await fixture();
    const agent = await signIn(f, { reach: [{ workspaceId: WS_A, level: "comment" }] });
    chats(f, WS_A, agent.agentId);
    fromComputer(f, WS_A, [
      ownerSays("kept", "thread-team", "@Helper still here"),
      ownerSays("gone", "thread-team", "@Helper the deleted words"),
    ]);
    const fresh = f.h.linkAuthority.freshPersonal.bind(f.h.linkAuthority);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let reached!: () => void;
    const atFence = new Promise<void>((resolve) => (reached = resolve));
    vi.spyOn(f.h.linkAuthority, "freshPersonal").mockImplementation(async (authority) => {
      const current = await fresh(authority);
      reached();
      await gate;
      return current;
    });

    const answering = tool(f, agent, "wait", { timeoutMs: 0 });
    await atFence;
    vi.mocked(f.h.linkAuthority.freshPersonal).mockImplementation(fresh);
    expect(
      f.storage.deleteWorkspaceMessage({
        workspaceId: WS_A,
        threadId: "thread-team",
        messageId: "gone",
        actor: { kind: "account", userId: OWNER },
        nowMs: 5000,
      }).ok,
    ).toBe(true);
    release();
    const answer = (await ok(await answering)) as WaitAnswer;
    expect(ids(answer)).toEqual(["kept"]);
    expect(JSON.stringify(answer)).not.toContain("the deleted words");
  });

  it("reads a deleted message in a channel as its line, with no body and no digest", async () => {
    const f = await fixture();
    const agent = await signIn(f, { reach: [{ workspaceId: WS_A, level: "view" }] });
    chats(f, WS_A, agent.agentId);
    fromComputer(f, WS_A, [ownerSays("gone", "thread-team", "the deleted words")]);
    expect(
      f.storage.deleteWorkspaceMessage({
        workspaceId: WS_A,
        threadId: "thread-team",
        messageId: "gone",
        actor: { kind: "account", userId: OWNER },
        nowMs: 5000,
      }).ok,
    ).toBe(true);

    const page = await ok(
      await tool(f, agent, "chat", { workspaceId: WS_A, channelWireId: "wire-team" }),
    );
    expect(page.messages).toEqual([
      expect.objectContaining({ messageId: "gone", deletedAtMs: 5000 }),
    ]);
    expect(JSON.stringify(page)).not.toContain("the deleted words");
    expectNoDeletedDigest(f.dbPath, page);
  });

  it("reads only from where each workspace entered its reach, whatever the cursor names", async () => {
    const f = await fixture();
    fromComputer(f, WS_A, [
      chatChannelCreate("wire-team"),
      chatThreadCreate("thread-other", "wire-team"),
      ownerSays("before", "thread-other", "@Helper before"),
    ]);
    const agent = await signIn(f);
    fromComputer(f, WS_A, [ownerSays("after", "thread-other", "@Helper after")]);
    const answer = await waitOnce(f, agent, {
      cursor: {
        v: 1,
        agentId: agent.agentId,
        seqs: { [WS_A]: 0, [WS_B]: 0, [OTHER_WS]: 0 },
        turn: null,
      },
    });
    expect(ids(answer)).toEqual(["after"]);
    expect(Object.keys(answer.cursor.seqs)).toEqual([WS_A]);

    const second = await signIn(f, { agent: { kind: "new", name: "Second" } });
    expect((await tool(f, second, "wait", { timeoutMs: 0, cursor: answer.cursor })).status).toBe(
      400,
    );
    expect(
      (
        await tool(f, agent, "wait", {
          timeoutMs: 0,
          cursor: { ...answer.cursor, seqs: { [WS_A]: -1 } },
        })
      ).status,
    ).toBe(400);
    expect(
      (await tool(f, agent, "wait", { timeoutMs: 0, cursor: { ...answer.cursor, extra: 1 } }))
        .status,
    ).toBe(400);
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
    const answer = (await ok(await answered)) as WaitAnswer;
    expect(ids(answer)).toEqual(["in-b"]);
    expect(f.activity.stats().waiters).toBe(0);

    const controller = new AbortController();
    const aborted = tool(f, agent, "wait", { cursor: answer.cursor }, controller.signal);
    await parked(f, 2);
    controller.abort();
    await expectRefused(await aborted);
    expect(f.activity.stats().waiters).toBe(0);

    const holds: number[] = [];
    const original = f.activity.wait.bind(f.activity);
    vi.spyOn(f.activity, "wait").mockImplementation((group, actor, options) => {
      holds.push(options.holdMs);
      f.now.value += options.holdMs;
      return original(group, actor, { ...options, holdMs: 1 });
    });
    expect(
      await ok(await tool(f, agent, "wait", { cursor: answer.cursor, timeoutMs: 40 })),
    ).toMatchObject({ messages: [], more: false });
    expect(holds).toEqual([40, 40]);
    expect(f.activity.stats().waiters).toBe(0);
  });
});

describe("a personal agent's reads", () => {
  it("reads a channel's messages newest first, a page at a time, only in a channel of the named workspace", async () => {
    const f = await fixture();
    const agent = await signIn(f, { reach: BOTH_VIEW });
    chats(f, WS_A, agent.agentId);
    fromComputer(f, WS_B, [chatChannelCreate("wire-b")]);
    fromComputer(
      f,
      WS_A,
      ["first", "second", "third"].map((id) => ownerSays(id, "thread-team", id)),
    );
    const read = (fields: Record<string, unknown>) =>
      tool(f, agent, "chat", { workspaceId: WS_A, channelWireId: "wire-team", ...fields });

    const page = (await ok(await read({ limit: 2 }))) as ChatPage;
    expect(ids(page)).toEqual(["third", "second"]);
    expect(page.messages[0]).not.toHaveProperty("authorUserId");
    expect(page.olderCursor).toEqual(expect.any(Number));
    const older = (await ok(await read({ limit: 2, before: page.olderCursor }))) as ChatPage;
    expect(ids(older)).toEqual(["first"]);
    expect(older.olderCursor).toBeNull();

    f.storage.appendLogBatch({
      workspaceId: WS_A,
      originId: personalAgentOrigin(agent.agentId),
      ops: [
        {
          originSeq: 1,
          opKind: "chat.message.append",
          recordedAtMs: 1,
          payloadJson: JSON.stringify({
            messageId: `${PERSONAL_MESSAGE_ID_PREFIX}forged`,
            threadId: "thread-team",
            authorKind: "agent",
            authorDisplayName: "Helper",
            authorUserId: OWNER,
            authorAgentId: `p-${"b".repeat(26)}`,
            agentConnectionId: agent.connectionId,
            body: "forged",
            createdAtMs: 3,
          }),
        },
      ],
    });
    expect(ids((await ok(await read({}))) as ChatPage)).toEqual(["third", "second", "first"]);

    await expectRefused(await read({ channelWireId: "wire-b" }));
    await expectRefused(await read({ channelWireId: "wire-nowhere" }));
    expect((await read({ limit: 101 })).status).toBe(400);
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
      workspaceId: WS_A,
      truncated: false,
      files: [expect.objectContaining({ path: "notes/a.md", blobSha256: sha })],
    });
    const read = await tool(f, agent, "blob", { workspaceId: WS_A, sha256: sha });
    expect(read.status).toBe(200);
    expect(await read.text()).toBe("hello");
    await expectRefused(await tool(f, agent, "blob", { workspaceId: WS_A, sha256: stale }));
    await expectRefused(await tool(f, agent, "blob", { workspaceId: WS_A, sha256: inB }));
    await expectCode(
      await tool(f, agent, "blob", { workspaceId: WS_B, sha256: inB }),
      403,
      "personal_agent_out_of_reach",
    );
    expect((await tool(f, agent, "blob", { workspaceId: WS_A, sha256: "not-a-sha" })).status).toBe(
      400,
    );
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
        originSeq: 2,
        opKind: "secret.file.put",
        recordedAtMs: 1_002,
        payload: {
          versionId: "main",
          path: "config/.env",
          metadata: { origin: "user" },
          ivBase64: "AA==",
          authTagBase64: "AA==",
          ciphertextSha256: ciphertext,
          byteLength: 10,
        },
      },
    ]);

    const listed = await ok(await tool(f, agent, "files", { workspaceId: WS_A }));
    expect(listed.files).toEqual([
      expect.objectContaining({ path: "notes/a.md", blobSha256: sha }),
    ]);
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

    const narrowed = await open();
    await ok(await setReach(f, agent, [{ workspaceId: WS_B, level: "view" }]));
    await expect(narrowed.read()).rejects.toThrow("personal agent access changed during stream");

    await ok(await setReach(f, agent, BOTH_VIEW));
    const lost = await open();
    setOwner(f, WS_A, OTHER);
    await expect(lost.read()).rejects.toMatchObject({ code: "not_found" });

    setOwner(f, WS_A, OWNER);
    const reset = await open();
    f.fence.changePassword(OWNER);
    await expect(reset.read()).rejects.toMatchObject({ code: "not_found" });
  });
});

// The agent's person is a member of OTHER's workspace, which members know as "Community".
const COMMUNITY = OTHER_WS;
const MEMBER_ID = "member-ada";
// Hides the folder it is in from every member but ben, whom the relay can't match to the person.
const HIDING_RULE = "people:\n  ben@dohc.test: edit\n";

function joinCommunity(f: Fixture, input: { level?: Level; role?: "admin" } = {}): void {
  expect(
    f.storage.inviteWorkspaceMember({
      workspaceId: COMMUNITY,
      actorUserId: OTHER,
      workspaceName: "Community",
      email: "ada@dohc.test",
      recipientUserId: OWNER,
      newMemberId: () => MEMBER_ID,
      newGrantId: () => "grant-ada",
      newShareId: () => "share-community",
      nowMs: 5,
    }),
  ).toMatchObject({ ok: true });
  if (input.level) memberLevel(f, input.level);
  if (input.role)
    expect(
      f.storage.setWorkspaceMemberRole({
        workspaceId: COMMUNITY,
        actorUserId: OTHER,
        memberId: MEMBER_ID,
        role: input.role,
      }),
    ).toEqual({ ok: true });
}

function memberLevel(f: Fixture, level: Level): void {
  expect(
    f.storage.setWorkspaceMemberLevel({
      workspaceId: COMMUNITY,
      actorUserId: OTHER,
      level,
      workspaceName: undefined,
      newShareId: () => "unused-share",
      nowMs: 6,
    }),
  ).toEqual({ ok: true });
}

const communitySeqs = new WeakMap<SyncRelayStorage, number>();

/** OTHER writes a file in the community; its object id is `object-<path>`. */
async function communityWrite(f: Fixture, path: string, text: string): Promise<string> {
  const sha = await putBlob(f.h, OTHER, COMMUNITY, text);
  const originSeq = communitySeqs.get(f.storage) ?? 0;
  communitySeqs.set(f.storage, originSeq + 1);
  await appendLog(f.h, OTHER, COMMUNITY, [
    moment(path, text, { originSeq, objectId: `object-${path}` }),
  ]);
  return sha;
}

function communityGroups(f: Fixture): void {
  fromComputer(f, COMMUNITY, [
    chatChannelCreate("wire-team", { name: "Team", purpose: "Day to day" }),
    chatThreadCreate("thread-team", "wire-team"),
    chatChannelCreate("wire-news", { name: "Announcements" }),
    chatThreadCreate("thread-news", "wire-news"),
    chatChannelCreate("wire-secret", { name: "Secret" }),
    chatThreadCreate("thread-secret", "wire-secret"),
  ]);
}

/** OTHER sets a Group's rule, as Members does. */
async function groupRule(f: Fixture, channelWireId: string, level: "none" | "view" | "comment") {
  const response = await f.h(
    request(OTHER, `/sync/${COMMUNITY}/members/groups/${channelWireId}/rule`, {
      ...jsonBody({ level }),
      method: "PUT",
    }),
  );
  expect(response.status, await response.clone().text()).toBe(200);
}

async function removeFromCommunity(f: Fixture): Promise<void> {
  const response = await f.h(
    request(OTHER, `/sync/${COMMUNITY}/members/${MEMBER_ID}/remove`, jsonBody({})),
  );
  expect(response.status, await response.clone().text()).toBe(200);
}

const BOTH_COMMENT: Reach = [
  { workspaceId: WS_A, level: "comment" },
  { workspaceId: COMMUNITY, level: "comment" },
];

describe("a personal agent in a workspace its person joined", () => {
  it("signs in at a joined workspace for a member who owns none, again once signed out, and never once the membership ends", async () => {
    const f = await fixture();
    expect(
      f.storage.inviteWorkspaceMember({
        workspaceId: COMMUNITY,
        actorUserId: OTHER,
        workspaceName: "Community",
        email: "joiner@dohc.test",
        recipientUserId: "joiner-account",
        newMemberId: () => "member-joiner",
        newGrantId: () => "grant-joiner",
        newShareId: () => "share-community",
        nowMs: 5,
      }),
    ).toMatchObject({ ok: true });
    const session = "joiner-session";
    const reach: Reach = [{ workspaceId: COMMUNITY, level: "comment" }];
    const clientId = await registerClient(f);
    const asked = await beginRequest(f, clientId, COMMUNITY);
    expect(await ok(await consent(f, asked, session))).toMatchObject({
      workspaceId: COMMUNITY,
      workspaces: [{ workspaceId: COMMUNITY, name: "Community", role: "member" }],
    });
    await expectRefused(await consent(f, asked));
    const agent = await signIn(f, { clientId, workspaceId: COMMUNITY, session, reach });
    expect((await ok(await tool(f, agent, "workspaces", {}))).workspaces).toEqual([
      expect.objectContaining({ workspaceId: COMMUNITY, role: "member" }),
    ]);

    await ok(await owner(f, `/${agent.agentId}/sign-out`, { method: "POST" }, "joiner-account"));
    const again = await signIn(f, {
      clientId,
      workspaceId: COMMUNITY,
      session,
      reach,
      agent: { kind: "existing", agentId: agent.agentId },
    });
    expect(again.agentId).toBe(agent.agentId);

    const response = await f.h(
      request(OTHER, `/sync/${COMMUNITY}/members/member-joiner/remove`, jsonBody({})),
    );
    expect(response.status, await response.clone().text()).toBe(200);
    const ended = await beginRequest(f, clientId, COMMUNITY);
    await expectRefused(await consent(f, ended, session));
    await expectRefused(await allow(f, ended, { session, reach }));
  });

  it("names its person beside its post in another member's browser, whatever name the agent took", async () => {
    const f = await fixture({
      namedBrowserSessionLimits: {
        maxSessions: 8,
        retentionMs: 60_000,
        maxPendingRequests: 8,
        maxRequestBytes: 100_000,
        maxResponseBytes: 200_000,
        timeoutMs: 1000,
      },
      lookupUserDisplayName: (userId: string) =>
        userId === OWNER ? "Ada" : userId === OTHER ? "Olive" : null,
      // A browser's cookie names its person; a test request's bearer names its own.
      resolveActor: (incoming, workspaceId) => {
        const sessionId = /^session=([\w-]+)$/u.exec(incoming.headers.get("cookie") ?? "")?.[1];
        if (sessionId === undefined) return resolveTestActor(incoming, workspaceId);
        const userId = SESSIONS[sessionId];
        if (!userId) throw new UnauthorizedError();
        return { userId, workspaceId };
      },
    });
    joinCommunity(f);
    communityGroups(f);
    expect(
      f.storage.inviteWorkspaceMember({
        workspaceId: COMMUNITY,
        actorUserId: OTHER,
        workspaceName: "Community",
        email: "joiner@dohc.test",
        recipientUserId: "joiner-account",
        newMemberId: () => "member-joiner",
        newGrantId: () => "grant-joiner",
        newShareId: () => "share-community",
        nowMs: 5,
      }),
    ).toMatchObject({ ok: true });
    const agent = await signIn(f, { reach: [{ workspaceId: COMMUNITY, level: "comment" }] });
    // Named after the workspace's owner, the post still names Ada.
    await ok(await owner(f, `/${agent.agentId}/name`, { method: "PUT", body: { name: "Olive" } }));
    await ok(await post(f, agent, { workspaceId: COMMUNITY, channelWireId: "wire-team" }));

    const read = await f.h(
      new Request(
        `http://relay.test/sync/named-chat/messages?shareId=share-community&channelWireId=wire-team`,
        {
          headers: {
            cookie: "session=joiner-session",
            origin: SHARE_WEB_ORIGIN,
            "x-dohc-relay-exchange-key": RELAY_EXCHANGE_KEY,
          },
        },
      ),
    );
    expect((await ok(read)).messages).toEqual([
      expect.objectContaining({
        authorKind: "agent",
        authorDisplayName: "Olive",
        authorUserId: OWNER,
        authorOwnerDisplayName: "Ada",
      }),
    ]);
  });

  it("takes a joined workspace into reach, never one its person isn't a member of, and appends no chat there", async () => {
    const f = await fixture();
    joinCommunity(f);
    await claimWorkspace(f.h, OTHER, "workspace-third");
    const before = logOf(f, COMMUNITY).length;
    const agent = await signIn(f, { reach: BOTH_COMMENT });
    expect((await roster(f)).agents[0]?.reach).toEqual(BOTH_COMMENT);
    await ok(await setReach(f, agent, [{ workspaceId: COMMUNITY, level: "view" }]));
    expect((await roster(f)).agents[0]?.reach).toEqual([{ workspaceId: COMMUNITY, level: "view" }]);
    expect(
      (await setReach(f, agent, [{ workspaceId: "workspace-third", level: "view" }])).status,
    ).toBe(400);
    expect(logOf(f, COMMUNITY)).toHaveLength(before);
    expect((await roster(f)).workspaces).toEqual([
      { workspaceId: WS_A, name: null, role: "owner" },
      { workspaceId: WS_B, name: null, role: "owner" },
      { workspaceId: COMMUNITY, name: "Community", role: "member" },
    ]);
  });

  it("acts at the lower of its own level and its person's, in the workspace and in a Group", async () => {
    const f = await fixture();
    joinCommunity(f, { level: "view" });
    communityGroups(f);
    const agent = await signIn(f, {
      reach: [
        { workspaceId: WS_A, level: "view" },
        { workspaceId: COMMUNITY, level: "edit" },
      ],
    });
    expect((await ok(await tool(f, agent, "workspaces", {}))).workspaces).toContainEqual({
      workspaceId: COMMUNITY,
      name: "Community",
      level: "view",
      role: "member",
      dmChannelWireId: null,
    });
    await expectCode(
      await post(f, agent, { workspaceId: COMMUNITY, channelWireId: "wire-team" }),
      403,
      "personal_agent_view_only",
    );

    memberLevel(f, "edit");
    await groupRule(f, "wire-team", "comment");
    await ok(await setReach(f, agent, [{ workspaceId: COMMUNITY, level: "view" }]));
    await ok(await tool(f, agent, "chat", { workspaceId: COMMUNITY, channelWireId: "wire-team" }));
    await expectCode(
      await post(f, agent, {
        workspaceId: COMMUNITY,
        channelWireId: "wire-team",
        idempotencyKey: "post-2",
      }),
      403,
      "personal_agent_view_only",
    );
    await ok(await setReach(f, agent, [{ workspaceId: COMMUNITY, level: "comment" }]));
    const { message } = (await ok(
      await post(f, agent, {
        workspaceId: COMMUNITY,
        channelWireId: "wire-team",
        idempotencyKey: "post-3",
      }),
    )) as { message: Record<string, unknown> };
    expect(message).toMatchObject({ channelWireId: "wire-team", authorDisplayName: "Helper" });
    expect(payloadOf(logOf(f, COMMUNITY).at(-1)!)).toMatchObject({
      authorUserId: OWNER,
      authorAgentId: agent.agentId,
    });
  });

  it("keeps a hidden folder's files, bytes and Comments and a hidden Group out of reach, and posts nowhere members only read", async () => {
    const f = await fixture();
    joinCommunity(f);
    communityGroups(f);
    await groupRule(f, "wire-secret", "none");
    await groupRule(f, "wire-news", "view");
    const open = await communityWrite(f, "plans/a.md", "open plan");
    await communityWrite(f, "hidden/access.yaml", HIDING_RULE);
    const hidden = await communityWrite(f, "hidden/b.md", "hidden plan");
    fromComputer(f, COMMUNITY, [
      fileThread("thread-open", { linkedObjectId: "object-plans/a.md" }),
      ownerSays("on-open", "thread-open", "a note"),
      fileThread("thread-hidden", { linkedObjectId: "object-hidden/b.md" }),
      ownerSays("on-hidden", "thread-hidden", "a secret note"),
    ]);
    const agent = await signIn(f, { reach: BOTH_COMMENT });
    const read = (action: string, fields: Record<string, unknown>) =>
      tool(f, agent, action, { workspaceId: COMMUNITY, ...fields });
    const postIn = (fields: Record<string, unknown>) =>
      post(f, agent, {
        workspaceId: COMMUNITY,
        idempotencyKey: `post-${JSON.stringify(fields)}`,
        ...fields,
      });

    const listed = await ok(await read("files", {}));
    expect(listed.files).toEqual([
      expect.objectContaining({ path: "plans/a.md", blobSha256: open }),
    ]);
    expect(JSON.stringify(listed)).not.toContain("hidden/");
    expect(await (await read("blob", { sha256: open })).text()).toBe("open plan");
    await expectRefused(await read("blob", { sha256: hidden }));

    expect(await ok(await read("groups", {}))).toEqual({
      ok: true,
      workspaceId: COMMUNITY,
      groups: [
        { channelWireId: "wire-team", name: "Team", purpose: "Day to day" },
        { channelWireId: "wire-news", name: "Announcements", purpose: null },
      ],
    });
    await expectRefused(await read("chat", { channelWireId: "wire-secret" }));
    await expectRefused(await postIn({ channelWireId: "wire-secret" }));
    await expectRefused(await postIn({ threadId: "thread-secret" }));
    await ok(await read("chat", { channelWireId: "wire-news" }));
    await expectCode(await postIn({ channelWireId: "wire-news" }), 403, "personal_agent_view_only");

    expect(
      ids((await ok(await read("discussion", { threadId: "thread-open" }))) as ChatPage),
    ).toEqual(["on-open"]);
    await expectRefused(await read("discussion", { threadId: "thread-hidden" }));
    await expectRefused(await read("discussion", { filePath: "hidden/b.md" }));
    await expectRefused(await postIn({ threadId: "thread-hidden" }));
    await expectRefused(await postIn({ filePath: "hidden/b.md" }));
    await ok(await postIn({ filePath: "plans/a.md" }));
  });

  it("withholds a file link its person can't read, in a Group, in Comments, and in a wait answered after a rule hid it", async () => {
    const f = await fixture();
    joinCommunity(f);
    communityGroups(f);
    await communityWrite(f, "plans/a.md", "open plan");
    await communityWrite(f, "hidden/access.yaml", HIDING_RULE);
    await communityWrite(f, "hidden/b.md", "hidden plan");
    await communityWrite(f, "later/c.md", "for now");
    const agent = await signIn(f, { reach: BOTH_COMMENT });
    fromComputer(f, COMMUNITY, [
      fileThread("thread-open", { linkedObjectId: "object-plans/a.md" }),
      ownerSays("in-team", "thread-team", "@Helper see @[hidden/b.md#Layoffs] and @[plans/a.md]", {
        authorDisplayName: "Ada @[hidden/b.md]",
      }),
      ownerSays("on-open", "thread-open", "@Helper compare @[hidden/b.md]"),
    ]);
    const team = {
      messageId: "in-team",
      authorDisplayName: "Ada (a file not shared here)",
      body: "@Helper see (a file not shared here) and @[plans/a.md]",
    };
    const comment = { messageId: "on-open", body: "@Helper compare (a file not shared here)" };
    const read = async (action: string, fields: Record<string, unknown>) =>
      ((await ok(await tool(f, agent, action, { workspaceId: COMMUNITY, ...fields }))) as ChatPage)
        .messages;

    expect(await read("chat", { channelWireId: "wire-team" })).toEqual([
      expect.objectContaining(team),
    ]);
    expect(await read("discussion", { filePath: "plans/a.md" })).toEqual([
      expect.objectContaining(comment),
    ]);
    expect(await read("discussion", { threadId: "thread-open" })).toEqual([
      expect.objectContaining(comment),
    ]);
    const answer = await waitOnce(f, agent);
    expect(answer.messages).toEqual(
      expect.arrayContaining([expect.objectContaining(team), expect.objectContaining(comment)]),
    );
    expect(JSON.stringify(answer)).not.toContain("hidden/");

    // A folder hidden after the wait's scan read the message is withheld in its answer.
    fromComputer(f, COMMUNITY, [
      ownerSays("to-later", "thread-team", "@Helper read @[later/c.md]"),
    ]);
    const fresh = f.h.linkAuthority.freshPersonal.bind(f.h.linkAuthority);
    let entered!: () => void;
    let release!: () => void;
    const holding = new Promise<void>((resolve) => (entered = resolve));
    const released = new Promise<void>((resolve) => (release = resolve));
    vi.spyOn(f.h.linkAuthority, "freshPersonal").mockImplementationOnce(async (authority) => {
      entered();
      await released;
      return await fresh(authority);
    });
    const answered = tool(f, agent, "wait", { cursor: answer.cursor, timeoutMs: 0 });
    await holding;
    await communityWrite(f, "later/access.yaml", HIDING_RULE);
    release();
    expect(((await ok(await answered)) as WaitAnswer).messages).toEqual([
      expect.objectContaining({
        messageId: "to-later",
        body: "@Helper read (a file not shared here)",
      }),
    ]);
  });

  it("answers not-found for General, a direct message and its own chat id in a joined workspace, and reads another agent's chat in an owned one without posting there", async () => {
    const f = await fixture();
    joinCommunity(f);
    const agent = await signIn(f, { reach: BOTH_COMMENT });
    const own = agentChannelWireId(agent.agentId);
    fromComputer(f, COMMUNITY, [
      chatChannelCreate(GENERAL_CHANNEL_WIRE_ID, { name: "General" }),
      chatThreadCreate("thread-general", GENERAL_CHANNEL_WIRE_ID),
      chatChannelCreate("wire-people", { kind: "dm" }),
      chatThreadCreate("thread-people", "wire-people"),
      chatChannelCreate(own, { kind: "agent" }),
      chatThreadCreate("thread-own", own),
    ]);
    const before = logOf(f, COMMUNITY).length;
    for (const [channelWireId, threadId] of [
      [GENERAL_CHANNEL_WIRE_ID, "thread-general"],
      ["wire-people", "thread-people"],
      [own, "thread-own"],
    ] as const) {
      await expectRefused(await tool(f, agent, "chat", { workspaceId: COMMUNITY, channelWireId }));
      await expectRefused(
        await post(f, agent, {
          workspaceId: COMMUNITY,
          channelWireId,
          idempotencyKey: `post-${channelWireId}`,
        }),
      );
      await expectRefused(
        await post(f, agent, {
          workspaceId: COMMUNITY,
          threadId,
          idempotencyKey: `post-${threadId}`,
        }),
      );
    }
    expect(logOf(f, COMMUNITY)).toHaveLength(before);

    const another = agentChannelWireId(`p-${"b".repeat(26)}`);
    fromComputer(f, WS_A, [
      chatChannelCreate(another, { kind: "agent" }),
      chatThreadCreate("thread-another", another),
      ownerSays("for-another", "thread-another", "hello"),
    ]);
    expect(
      ids(
        (await ok(
          await tool(f, agent, "chat", { workspaceId: WS_A, channelWireId: another }),
        )) as ChatPage,
      ),
    ).toEqual(["for-another"]);
    const owned = logOf(f, WS_A).length;
    await expectCode(
      await post(f, agent, { channelWireId: another, idempotencyKey: "post-another" }),
      403,
      "personal_agent_view_only",
    );
    await expectCode(
      await post(f, agent, { threadId: "thread-another", idempotencyKey: "post-thread" }),
      403,
      "personal_agent_view_only",
    );
    expect(logOf(f, WS_A)).toHaveLength(owned);
  });

  it("shows an admin's agent a folder hidden from members and its access.yaml, as it shows an owner's agent its rules", async () => {
    const f = await fixture();
    joinCommunity(f, { role: "admin" });
    await communityWrite(f, "hidden/access.yaml", HIDING_RULE);
    await communityWrite(f, "hidden/b.md", "hidden plan");
    await putBlob(f.h, OWNER, WS_A, "members: view\n");
    await appendLog(f.h, OWNER, WS_A, [
      moment("shared/access.yaml", "members: view\n", { originSeq: 0 }),
    ]);
    const agent = await signIn(f, { reach: BOTH_COMMENT });
    const paths = async (workspaceId: string) =>
      ((await ok(await tool(f, agent, "files", { workspaceId }))).files as { path: string }[]).map(
        (file) => file.path,
      );
    expect(await paths(COMMUNITY)).toEqual(["hidden/access.yaml", "hidden/b.md"]);
    expect(await paths(WS_A)).toEqual(["shared/access.yaml"]);
    expect((await ok(await tool(f, agent, "workspaces", {}))).workspaces).toContainEqual(
      expect.objectContaining({ workspaceId: COMMUNITY, role: "admin", level: "comment" }),
    );
  });

  it("ends a file's stream at the next chunk once a rule hides its folder", async () => {
    const f = await fixture();
    joinCommunity(f);
    const content = "z".repeat(200_000);
    const sha = await communityWrite(f, "plans/large.md", content);
    const agent = await signIn(f, { reach: BOTH_COMMENT });
    const response = await tool(f, agent, "blob", { workspaceId: COMMUNITY, sha256: sha });
    expect(response.status).toBe(200);
    const reader = response.body!.getReader();
    expect((await reader.read()).value?.byteLength).toBe(64 * 1024);
    await communityWrite(f, "plans/access.yaml", HIDING_RULE);
    await expect(reader.read()).rejects.toMatchObject({ code: "not_found" });
  });

  it("answers a held wait without a message whose Group or file was hidden while it held", async () => {
    const f = await fixture();
    joinCommunity(f);
    communityGroups(f);
    await communityWrite(f, "plans/a.md", "plan");
    const agent = await signIn(f, { reach: BOTH_COMMENT });
    fromComputer(f, COMMUNITY, [
      fileThread("thread-plan", { linkedObjectId: "object-plans/a.md" }),
      ownerSays("in-team", "thread-team", "@Helper in the team"),
      ownerSays("in-news", "thread-news", "@Helper in the news"),
      ownerSays("on-plan", "thread-plan", "@Helper on the plan"),
    ]);
    // The wait's last fresh read, after its scan found the messages, waits for the test.
    const fresh = f.h.linkAuthority.freshPersonal.bind(f.h.linkAuthority);
    let entered!: () => void;
    let release!: () => void;
    const holding = new Promise<void>((resolve) => (entered = resolve));
    const released = new Promise<void>((resolve) => (release = resolve));
    vi.spyOn(f.h.linkAuthority, "freshPersonal").mockImplementationOnce(async (authority) => {
      entered();
      await released;
      return await fresh(authority);
    });
    const answered = tool(f, agent, "wait", { timeoutMs: 0 });
    await holding;
    await groupRule(f, "wire-team", "none");
    await communityWrite(f, "plans/access.yaml", HIDING_RULE);
    release();
    expect(ids((await ok(await answered)) as WaitAnswer)).toEqual(["in-news"]);
  });

  it("answers a parked wait once a rule hides a Group it reads", async () => {
    const f = await fixture();
    joinCommunity(f);
    communityGroups(f);
    const agent = await signIn(f, { reach: BOTH_COMMENT });
    const { cursor } = await waitOnce(f, agent);
    const answered = tool(f, agent, "wait", { cursor });
    await parked(f, 2);
    await groupRule(f, "wire-team", "none");
    expect(await ok(await answered)).toMatchObject({ messages: [], more: false });
    expect(f.activity.stats().waiters).toBe(0);
  });

  it("spans owned and joined workspaces, and once its person is removed answers not-found there and ends a running wait", async () => {
    const f = await fixture();
    joinCommunity(f);
    communityGroups(f);
    const sha = await communityWrite(f, "plans/a.md", "plan");
    fromComputer(f, COMMUNITY, [
      fileThread("thread-plan", { linkedObjectId: "object-plans/a.md" }),
    ]);
    const agent = await signIn(f, { reach: BOTH_COMMENT });
    chats(f, WS_A, agent.agentId);
    expect((await ok(await tool(f, agent, "workspaces", {}))).workspaces).toEqual([
      expect.objectContaining({
        workspaceId: WS_A,
        level: "comment",
        role: "owner",
        dmChannelWireId: agentChannelWireId(agent.agentId),
      }),
      {
        workspaceId: COMMUNITY,
        name: "Community",
        level: "comment",
        role: "member",
        dmChannelWireId: null,
      },
    ]);
    fromComputer(f, WS_A, [ownerSays("in-a", "thread-dm", "hello")]);
    fromComputer(f, COMMUNITY, [ownerSays("in-community", "thread-team", "@Helper hello")]);
    const answer = await waitOnce(f, agent);
    expect(ids(answer).sort()).toEqual(["in-a", "in-community"]);
    expect(Object.keys(answer.cursor.seqs).sort()).toEqual([WS_A, COMMUNITY].sort());

    const running = tool(f, agent, "wait", { cursor: answer.cursor });
    await parked(f, 2);
    await removeFromCommunity(f);
    const ended = (await ok(await running)) as WaitAnswer;
    expect(ended.messages).toEqual([]);
    expect(Object.keys(ended.cursor.seqs)).toEqual([WS_A]);
    expect(f.activity.stats().waiters).toBe(0);

    expect((await ok(await tool(f, agent, "workspaces", {}))).workspaces).toEqual([
      expect.objectContaining({ workspaceId: WS_A }),
    ]);
    for (const [action, fields] of [
      ["files", {}],
      ["blob", { sha256: sha }],
      ["groups", {}],
      ["chat", { channelWireId: "wire-team" }],
      ["discussion", { threadId: "thread-plan" }],
      ["discussion", { filePath: "plans/a.md" }],
    ] as const) {
      await expectRefused(await tool(f, agent, action, { workspaceId: COMMUNITY, ...fields }));
    }
    await expectRefused(
      await post(f, agent, {
        workspaceId: COMMUNITY,
        channelWireId: "wire-team",
        idempotencyKey: "post-after",
      }),
    );
    expect((await roster(f)).workspaces).toContainEqual({
      workspaceId: COMMUNITY,
      name: "Community",
      role: "ended",
    });

    // A change elsewhere keeps the ended workspace as it was, never higher, and Remove drops it.
    const keeping = (level: "comment" | "edit"): Reach => [
      { workspaceId: WS_A, level: "view" },
      { workspaceId: COMMUNITY, level },
    ];
    expect((await setReach(f, agent, keeping("edit"))).status).toBe(400);
    expect((await setReach(f, agent, keeping("comment"))).status).toBe(200);
    expect((await setReach(f, agent, [{ workspaceId: WS_A, level: "view" }])).status).toBe(200);
    expect((await roster(f)).workspaces.map((workspace) => workspace.workspaceId)).not.toContain(
      COMMUNITY,
    );
    expect((await setReach(f, agent, keeping("comment"))).status).toBe(400);
  });

  it("reaches nothing in a workspace its person rejoins until the person chooses its reach again", async () => {
    const f = await fixture();
    joinCommunity(f);
    communityGroups(f);
    const reach: Reach = [
      { workspaceId: WS_A, level: "view" },
      { workspaceId: COMMUNITY, level: "comment" },
    ];
    const agent = await signIn(f, { reach });
    await removeFromCommunity(f);
    expect((await roster(f)).agents[0]?.reach).toEqual(reach);

    const back = await f.h(
      request(OTHER, `/sync/${COMMUNITY}/members/${MEMBER_ID}/let-back-in`, jsonBody({})),
    );
    expect(back.status, await back.clone().text()).toBe(200);
    expect((await roster(f)).workspaces).toContainEqual({
      workspaceId: COMMUNITY,
      name: "Community",
      role: "member",
    });
    expect((await roster(f)).agents[0]?.reach).toEqual([{ workspaceId: WS_A, level: "view" }]);
    expect((await ok(await tool(f, agent, "workspaces", {}))).workspaces).toEqual([
      expect.objectContaining({ workspaceId: WS_A }),
    ]);
    await expectCode(
      await tool(f, agent, "chat", { workspaceId: COMMUNITY, channelWireId: "wire-team" }),
      403,
      "personal_agent_out_of_reach",
    );

    await ok(await setReach(f, agent, reach));
    await ok(await tool(f, agent, "chat", { workspaceId: COMMUNITY, channelWireId: "wire-team" }));

    // Leaving, then an invite back, starts over too.
    const left = await f.h(request(OWNER, `/sync/${COMMUNITY}/members/leave`, jsonBody({})));
    expect(left.status, await left.clone().text()).toBe(200);
    expect((await roster(f)).agents[0]?.reach).toEqual(reach);
    expect(
      f.storage.inviteWorkspaceMember({
        workspaceId: COMMUNITY,
        actorUserId: OTHER,
        workspaceName: undefined,
        email: "ada@dohc.test",
        recipientUserId: OWNER,
        newMemberId: () => "member-ada-again",
        newGrantId: () => "grant-ada-again",
        newShareId: () => "unused-share",
        nowMs: 7,
      }),
    ).toMatchObject({ ok: true });
    expect((await roster(f)).agents[0]?.reach).toEqual([{ workspaceId: WS_A, level: "view" }]);
  });

  it("refuses a Collection write in a joined workspace, even at Edit", async () => {
    const f = await fixture();
    joinCommunity(f, { level: "edit" });
    const SCHEMA = "name: Packing\nfields:\n  Title:\n    type: text\n";
    await communityWrite(f, "trip/packing/collection.yaml", SCHEMA);
    const agent = await signIn(f, {
      reach: [
        { workspaceId: WS_A, level: "edit" },
        { workspaceId: COMMUNITY, level: "edit" },
      ],
    });
    const before = logOf(f, COMMUNITY).length;
    await expectCode(
      await tool(
        f,
        agent,
        "collection-writes",
        {
          workspaceId: COMMUNITY,
          submitId: "submit-1",
          changes: [
            {
              basedOnPath: null,
              basedOnBlobSha256: null,
              operation: "write",
              afterPath: "trip/packing/Socks.md",
              afterContentKind: "text",
              afterContentBase64: Buffer.from(
                "---\nid: rec_aaaaaaaaaaaaaaaaaaaaaaaaaa\n---\nSocks\n",
              ).toString("base64"),
              recordedAtMs: 1,
            },
          ],
        },
        undefined,
        { [PERSONAL_WRITE_WORKSPACE_HEADER]: encodeURIComponent(COMMUNITY) },
      ),
      403,
      "personal_agent_out_of_reach",
    );
    expect(logOf(f, COMMUNITY)).toHaveLength(before);
  });
});

describe("single-flight fence reads", () => {
  function reads() {
    const started: { userId: string; settle(epoch: number): void; fail(error: Error): void }[] = [];
    const read = vi.fn(
      (userId: string) =>
        new Promise<number>((resolve, reject) => {
          started.push({ userId, settle: resolve, fail: reject });
        }),
    );
    return {
      started,
      read,
      fenceRead: singleFlightFenceReads(read, () => new Error("The fence read timed out.")),
    };
  }

  it("shares the next read among everyone who asked during the running one", async () => {
    const { started, read, fenceRead } = reads();
    const first = fenceRead(OWNER);
    const waiting = [fenceRead(OWNER), fenceRead(OWNER), fenceRead(OWNER)];
    started[0]!.settle(1);
    await first;
    await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(2));
    started[1]!.settle(2);
    await expect(Promise.all(waiting)).resolves.toEqual([2, 2, 2]);
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("fails a read Postgres doesn't answer in time, and then begins the next read", async () => {
    vi.useFakeTimers();
    try {
      const { started, read, fenceRead } = reads();
      const stalled = fenceRead(OWNER);
      const waiting = fenceRead(OWNER);
      const failed = expect(stalled).rejects.toThrow("The fence read timed out.");
      await vi.advanceTimersByTimeAsync(CREDENTIAL_FENCE_READ_TIMEOUT_MS - 1);
      expect(read).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      await failed;
      await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(2));
      started[1]!.settle(1);
      await expect(waiting).resolves.toBe(1);
      started[0]!.settle(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("reads each account on its own", async () => {
    const { started, read, fenceRead } = reads();
    const owner = fenceRead(OWNER),
      other = fenceRead(OTHER);
    expect(read.mock.calls).toEqual([[OWNER], [OTHER]]);
    started[1]!.settle(5);
    started[0]!.settle(4);
    await expect(Promise.all([owner, other])).resolves.toEqual([4, 5]);
  });
});
