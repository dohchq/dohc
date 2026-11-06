import { afterEach, describe, expect, it, vi } from "vitest";
import { AGENT_CHAT_MAX_WAIT_MS, MAX_AGENT_CHAT_WAITS_PER_CONNECTION } from "./agentChatRoutes";
import { DiscussionActivityHub } from "./discussionActivity";
import { errorResponse, notFound } from "./errors";
import { pkceS256Challenge } from "./linkSecurity";
import { LINK_CHAT_MESSAGE_ID_PREFIX, LINK_CHAT_ORIGIN_PREFIX } from "./relayLogInputs";
import type { SyncRelayHandler } from "./server";
import type { SyncRelayStorage } from "./storage";
import {
  RELAY_EXCHANGE_KEY,
  SHARE_WEB_ORIGIN,
  chatChannelCreate,
  chatMessageAppend,
  chatThreadCreate,
  closeTestStorages,
  createShare,
  json,
  jsonBody,
  linkSecret,
  request,
  sequenced,
  testHandler,
  testStorage,
  type ChatOp,
  type HandlerOverrides,
} from "./testing";

const OWNER = "acct-owner-agent-chat";
const MEMBER = "acct-member-agent-chat";
const workspaceId = "workspace-agent-chat";
const channelWireId = "wire-team";
const REDIRECT = "http://127.0.0.1:43110/callback";
const VERIFIER = "agent-pkce-verifier-0123456789-abcdefghijklmnopqrstuvwxyz";
const released: HandlerOverrides = {
  publicEditRelease: { version: 1 },
  relayExchangeKey: RELAY_EXCHANGE_KEY,
  namedBrowserSessionLimits: {
    maxSessions: 8, retentionMs: 60_000, maxPendingRequests: 4, maxRequestBytes: 8192, maxResponseBytes: 16384, timeoutMs: 1000,
  },
};

afterEach(() => {
  vi.restoreAllMocks();
  closeTestStorages();
});

type Fixture = {
  storage: SyncRelayStorage; h: SyncRelayHandler; activity: DiscussionActivityHub; shareId: string; clock: { value: number };
};
type Link = { grantId: string; shareId: string; secret: string };
type Agent = Link & { accessToken: string; connectionId: string };
type WaitAnswer = { ok: true; group: { channelWireId: string; name: string | null }; cursor: number; messages: Array<Record<string, unknown>> };

let ownerSeq = 0;

function appendOwnerOps(storage: SyncRelayStorage, ops: ChatOp[]) {
  storage.appendLogBatch({
    workspaceId, originId: "owner",
    ops: sequenced(ops, ownerSeq).map(({ payload, ...op }) => ({ ...op, payloadJson: JSON.stringify(payload) })),
  });
  ownerSeq += ops.length;
}

async function fixture(): Promise<Fixture> {
  ownerSeq = 0;
  const storage = await testStorage();
  const clock = { value: 2_000 };
  const activity = new DiscussionActivityHub();
  storage.claimWorkspace({ workspaceId, ownerUserId: OWNER, createdAtMs: 1 });
  appendOwnerOps(storage, [
    chatChannelCreate(channelWireId, { name: "Team", type: "both", folderPath: "team" }),
    chatThreadCreate("thread-team", channelWireId),
    chatThreadCreate("thread-other", channelWireId),
    chatMessageAppend("owner-first", "thread-team", "welcome", { authorUserId: OWNER, authorDisplayName: "Ada" }),
    chatChannelCreate("wire-private", { name: "Private" }),
    chatThreadCreate("thread-private", "wire-private"),
  ]);
  const h = testHandler(storage, { ...released, discussionActivity: activity, nowMs: () => clock.value });
  const created = await h(request(OWNER, `/sync/${workspaceId}/shares`, jsonBody({
    recipientUserId: MEMBER, channelWireId, paths: ["team"], access: "read-write", subjectName: "Team",
  })));
  expect(created.status, await created.clone().text()).toBe(200);
  return { storage, h, activity, shareId: String((await json(created)).shareId), clock };
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

function internal(f: Fixture, path: string, body: unknown, init: RequestInit = {}): Promise<Response> {
  return f.h(request(null, `/sync/link/${path}`, {
    method: "POST", ...init,
    headers: { "content-type": "application/json", "x-dohc-relay-exchange-key": RELAY_EXCHANGE_KEY },
    body: JSON.stringify(body),
  }));
}

async function createLink(f: Fixture, access: string, shareId = f.shareId): Promise<Link> {
  const link = await ok(await f.h(request(OWNER, `/sync/${workspaceId}/shares/${shareId}/links`, jsonBody({ access }))));
  return { grantId: String(link.grantId), shareId, secret: linkSecret(link.url) };
}

// Signs an agent in on `link`, as share-web's sign-in does; a new link of the Group without one.
async function connect(f: Fixture, access: string, given?: Link): Promise<Agent> {
  const link = given ?? await createLink(f, access);
  const resource = `${SHARE_WEB_ORIGIN}/mcp/s/${link.secret}`;
  const clientId = String((await ok(await internal(f, "agent-clients", {
    registration: "registered", redirectUris: [REDIRECT], clientName: "Helper",
  }))).clientId);
  const requestId = String((await ok(await internal(f, "agent-authorizations", {
    clientId, resource, redirectUri: REDIRECT, codeChallenge: pkceS256Challenge(VERIFIER), codeChallengeMethod: "S256", state: "s",
  }))).requestId);
  const code = String((await ok(await internal(f, "agent-authorizations/decision", { requestId, decision: "allow" }))).code);
  const tokens = await ok(await internal(f, "agent-token", {
    grantType: "authorization_code", clientId, code, redirectUri: REDIRECT, codeVerifier: VERIFIER, resource,
  }));
  const accessToken = String(tokens.accessToken);
  const { connectionId } = await ok(await internal(f, "agent-introspect", { accessToken }));
  return { ...link, accessToken, connectionId: String(connectionId) };
}

function post(f: Fixture, agent: Agent, fields: Record<string, unknown> = {}): Promise<Response> {
  return internal(f, "agent-chat/post", { accessToken: agent.accessToken, body: "from the agent", idempotencyKey: "post-1", ...fields });
}

function wait(f: Fixture, agent: Agent, fields: Record<string, unknown> = {}, signal?: AbortSignal): Promise<Response> {
  return internal(f, "agent-chat/wait", { accessToken: agent.accessToken, ...fields }, signal ? { signal } : {});
}

// Counts each time a wait parks, so a test can act once it is held.
function watchParks(f: Fixture) {
  let parked = 0;
  const waiting = new Map<number, () => void>();
  const original = f.activity.wait.bind(f.activity);
  vi.spyOn(f.activity, "wait").mockImplementation((group, actor, options) => {
    const before = f.activity.stats().waiters;
    const pending = original(group, actor, options);
    if (f.activity.stats().waiters > before) waiting.get(parked++)?.();
    return pending;
  });
  // Resolves once the wait has parked `index + 1` times.
  return { next: (index: number) => index < parked ? Promise.resolve() : new Promise<void>((done) => { waiting.set(index, done); }) };
}

function ownerLog(f: Fixture) {
  return f.storage.fetchLogPage({ workspaceId, sinceRelaySeq: 0, limit: 1_000 }).rows;
}

describe("an agent's posts through its link", () => {
  it("records the agent connection as the author under its link principal, whatever the request names", async () => {
    const f = await fixture();
    const agent = await connect(f, "read-write");
    const before = ownerLog(f).length;
    // Fields that would name another author are refused, not ignored.
    for (const forged of [
      { authorKind: "human" }, { authorDisplayName: "Ada" }, { authorUserId: OWNER }, { linkPrincipalId: "principal" },
      { agentConnectionId: "connection-other" }, { claimedName: "Sam" }, { channelWireId: "wire-private" },
    ]) {
      await expectRefused(await post(f, agent, forged));
    }
    expect(ownerLog(f)).toHaveLength(before);

    const { message } = await ok(await post(f, agent)) as { message: Record<string, unknown> };
    expect(message).toMatchObject({ authorKind: "link", authorDisplayName: "Helper", linkAgent: true, body: "from the agent" });
    const appended = ownerLog(f).slice(before);
    expect(appended.map((row) => row.opKind)).toEqual(["chat.thread.create", "chat.message.append"]);
    const payload = JSON.parse(appended[1]!.payloadJson) as Record<string, unknown>;
    const principalId = String(payload.linkPrincipalId);
    expect(payload).toEqual({
      messageId: message.messageId, threadId: message.threadId, body: "from the agent", authorKind: "link", authorDisplayName: "Helper",
      linkGrantId: agent.grantId, linkPrincipalId: principalId, agentConnectionId: agent.connectionId, createdAtMs: 2_000,
    });
    expect(appended[1]!.originId).toBe(`${LINK_CHAT_ORIGIN_PREFIX}${principalId}`);
    expect(String(message.messageId).startsWith(LINK_CHAT_MESSAGE_ID_PREFIX)).toBe(true);

    // A retry answers the first post and appends nothing.
    expect((await ok(await post(f, agent))).message).toMatchObject({ messageId: message.messageId });
    expect(ownerLog(f)).toHaveLength(before + 2);
    // A forged access token names no connection.
    await expectRefused(await post(f, { ...agent, accessToken: "x".repeat(43) }, { idempotencyKey: "post-2" }));
  });

  it("refuses a device's op that names an agent connection", async () => {
    const f = await fixture();
    for (const fields of [{ agentConnectionId: "connection-1" }, { authorKind: "link", agentConnectionId: "connection-1" }]) {
      const ops = sequenced([chatMessageAppend("forged", "thread-team", "forged", { authorUserId: OWNER, ...fields })], ownerSeq);
      const refused = await f.h(request(OWNER, `/sync/${workspaceId}/log`, jsonBody({ originId: "owner", ops })));
      expect(refused.status).toBe(403);
      expect(await json(refused)).toMatchObject({ code: "authorship_mismatch" });
    }
  });

  it("refuses the routes without the relay exchange key", async () => {
    const f = await fixture();
    const agent = await connect(f, "read-write");
    for (const action of ["post", "wait"]) {
      await expectRefused(await f.h(request(null, `/sync/link/agent-chat/${action}`, {
        ...jsonBody({ accessToken: agent.accessToken, body: "x", idempotencyKey: "post-1", timeoutMs: 0 }),
      })));
    }
  });
});

describe("which links may post and wait", () => {
  it("lets a link on a share without chat neither post nor wait", async () => {
    const f = await fixture();
    const files = await createShare(f.h, OWNER, workspaceId, { recipientUserId: MEMBER, paths: ["docs"] });
    const agent = await connect(f, "view", await createLink(f, "view", files));
    const before = ownerLog(f).length;
    await expectRefused(await post(f, agent));
    await expectRefused(await wait(f, agent, { timeoutMs: 0 }));
    expect(ownerLog(f)).toHaveLength(before);
  });

  it("lets a read-only Group link wait but not post", async () => {
    const f = await fixture();
    const agent = await connect(f, "read-only");
    const refused = await post(f, agent);
    expect(refused.status).toBe(403);
    expect(await json(refused)).toMatchObject({ code: "link_view_access" });
    expect(await ok(await wait(f, agent, { timeoutMs: 0 }))).toMatchObject({ messages: [], group: { channelWireId, name: "Team" } });
  });
});

describe("an agent waiting for messages", () => {
  it("answers at once with a message after its cursor, skipping a full page of other threads' rows", async () => {
    const f = await fixture();
    const agent = await connect(f, "read-only");
    const { cursor } = await ok(await wait(f, agent, { timeoutMs: 0 })) as WaitAnswer;
    appendOwnerOps(f.storage, [
      ...Array.from({ length: 20 }, (_, index) =>
        chatMessageAppend(`other-${index}`, "thread-other", "elsewhere", { authorUserId: OWNER, authorDisplayName: "Ada" })),
      chatMessageAppend("owner-next", "thread-team", "next", { authorUserId: OWNER, authorDisplayName: "Ada" }),
    ]);
    const answer = await ok(await wait(f, agent, { cursor, threadId: "thread-team" })) as WaitAnswer;
    expect(answer.messages.map((message) => message.messageId)).toEqual(["owner-next"]);
    expect(answer.cursor).toBe(answer.messages[0]!.relaySeq);
  });

  it("keeps holding across its own posts, other threads and other channels, then answers with the next message", async () => {
    const f = await fixture();
    const reader = await connect(f, "read-write");
    const { cursor } = await ok(await wait(f, reader, { timeoutMs: 0 })) as WaitAnswer;
    const parks = watchParks(f);
    const held = wait(f, reader, { cursor, threadId: "thread-team" });
    await parks.next(0);

    // Its own post in the thread, another thread's message, and a private channel's message.
    await ok(await post(f, reader, { threadId: "thread-team" }));
    await parks.next(1);
    appendOwnerOps(f.storage, [
      chatMessageAppend("owner-other", "thread-other", "elsewhere", { authorUserId: OWNER }),
      chatMessageAppend("private", "thread-private", "SENTINEL", { authorUserId: OWNER }),
    ]);
    f.activity.wakeLog(workspaceId);
    await parks.next(2);
    expect(f.activity.stats().waiters).toBe(1);

    appendOwnerOps(f.storage, [chatMessageAppend("owner-reply", "thread-team", "reply", { authorUserId: OWNER, authorDisplayName: "Ada" })]);
    f.activity.wakeLog(workspaceId);
    const answer = await ok(await held) as WaitAnswer;
    expect(answer.messages).toEqual([expect.objectContaining({ messageId: "owner-reply", body: "reply", authorDisplayName: "Ada", linkAgent: false })]);
    expect(JSON.stringify(answer)).not.toContain("SENTINEL");
    expect(f.activity.stats().waiters).toBe(0);

    // The cursor is past everything it skipped.
    const after = await ok(await wait(f, reader, { cursor: answer.cursor, timeoutMs: 0 })) as WaitAnswer;
    expect(after).toMatchObject({ messages: [], cursor: answer.cursor });
  });

  it("shows another agent's post on the same link as an agent that joined with the link", async () => {
    const f = await fixture();
    const first = await connect(f, "read-write");
    const second = await connect(f, "read-write", first);
    const { cursor } = await ok(await wait(f, first, { timeoutMs: 0 })) as WaitAnswer;
    await ok(await post(f, second));
    // Each connection posts as its own link principal, so only the other agent reads the post.
    expect(await ok(await wait(f, second, { cursor, timeoutMs: 0 }))).toMatchObject({ messages: [] });
    const seen = await ok(await wait(f, first, { cursor, timeoutMs: 0 })) as WaitAnswer;
    expect(seen.messages).toEqual([expect.objectContaining({ authorKind: "link", authorDisplayName: "Helper", linkAgent: true })]);
  });

  it("ends a held wait when its request ends, and frees its place", async () => {
    const f = await fixture();
    const agent = await connect(f, "read-only");
    const parks = watchParks(f);
    const controllers: AbortController[] = [];
    const held: Promise<Response>[] = [];
    for (let index = 0; index < MAX_AGENT_CHAT_WAITS_PER_CONNECTION; index++) {
      const controller = new AbortController();
      controllers.push(controller);
      held.push(wait(f, agent, {}, controller.signal));
      await parks.next(index);
    }
    const overflow = await wait(f, agent, { timeoutMs: 0 });
    expect(overflow.status).toBe(429);
    expect(await json(overflow)).toMatchObject({ code: "link_read_rate_limited" });

    controllers.forEach((controller) => controller.abort());
    for (const response of await Promise.all(held)) await expectRefused(response);
    expect(f.activity.stats().waiters).toBe(0);
    expect((await wait(f, agent, { timeoutMs: 0 })).status).toBe(200);
  });

  const revocations: Array<[string, (f: Fixture, agent: Agent) => Promise<Response>]> = [
    ["Disconnect", (f, agent) => f.h(request(OWNER,
      `/sync/${workspaceId}/shares/${agent.shareId}/links/${agent.grantId}/agents/${agent.connectionId}/disconnect`, jsonBody({})))],
    ["Reset link", (f, agent) => f.h(request(OWNER, `/sync/shares/${agent.shareId}/links/${agent.grantId}/rotate`,
      jsonBody({ workspaceId, expectedDependentGrantIds: [] })))],
    ["End link", (f, agent) => f.h(request(OWNER, `/sync/shares/${agent.shareId}/revoke`,
      jsonBody({ workspaceId, expectedDependentGrantIds: [], grantId: agent.grantId })))],
  ];

  it.each(revocations)("refuses a held wait after %s, and every later call", async (_, revoke) => {
    const f = await fixture();
    const agent = await connect(f, "read-write");
    const parks = watchParks(f);
    const held = wait(f, agent);
    await parks.next(0);
    await ok(await revoke(f, agent));
    await expectRefused(await held);
    expect(f.activity.stats().waiters).toBe(0);
    await expectRefused(await wait(f, agent, { timeoutMs: 0 }));
    await expectRefused(await post(f, agent, { idempotencyKey: "post-after" }));
  });

  it("refuses a wait whose message arrives after its link ended, before it answers", async () => {
    const f = await fixture();
    const agent = await connect(f, "read-only");
    const parks = watchParks(f);
    const held = wait(f, agent);
    await parks.next(0);
    // The owner's message and the link's end land before the wait wakes.
    appendOwnerOps(f.storage, [chatMessageAppend("owner-late", "thread-team", "late", { authorUserId: OWNER })]);
    f.storage.revokeShareGrant({ shareId: agent.shareId, grantId: agent.grantId, revokedAtMs: 2_000 });
    f.activity.wakeLog(workspaceId);
    const refused = await held;
    expect(await refused.clone().text()).not.toContain("late");
    await expectRefused(refused);
  });

  it("holds no longer than its bound, and answers empty when the deadline passes", async () => {
    const f = await fixture();
    const agent = await connect(f, "read-only");
    await expectRefused(await wait(f, agent, { timeoutMs: AGENT_CHAT_MAX_WAIT_MS + 1 }));
    await expectRefused(await wait(f, agent, { timeoutMs: -1 }));

    const { cursor } = await ok(await wait(f, agent, { timeoutMs: 0 })) as WaitAnswer;
    const holds: number[] = [];
    const original = f.activity.wait.bind(f.activity);
    vi.spyOn(f.activity, "wait").mockImplementation((group, actor, options) => {
      holds.push(options.holdMs);
      // The hold's time passes before the registry's timer fires.
      f.clock.value += options.holdMs;
      return original(group, actor, { ...options, holdMs: 1 });
    });
    const answer = await ok(await wait(f, agent, { timeoutMs: 40 })) as WaitAnswer;
    expect(answer).toMatchObject({ messages: [], cursor });
    expect(holds).toEqual([40]);

    holds.length = 0;
    await ok(await wait(f, agent));
    expect(holds).toEqual([AGENT_CHAT_MAX_WAIT_MS]);
  });
});
