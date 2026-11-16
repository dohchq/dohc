import {
  parseDirectConversationList,
  parseDirectMessagePage,
  parseDirectResolution,
  type DirectConversation,
  type DirectMemberPick,
} from "@dohc/security-contract/direct-messages";
import { afterEach, describe, expect, it } from "vitest";
import { DiscussionActivityHub } from "./discussionActivity";
import { parseRoute } from "./relayRoute";
import type { SyncRelayHandler } from "./server";
import { fenceAccount, initializeAccountDeletion, purgeAccountRows } from "./storage/accountDeletion";
import type { StorageContext } from "./storage/context";
import {
  DIRECT_MESSAGE_ROW_BYTES, DIRECT_NEW_CONVERSATION_LIMIT, DIRECT_NEW_CONVERSATION_WINDOW_MS, DIRECT_SEND_RATE_LIMIT, DIRECT_SEND_RATE_WINDOW_MS,
  DIRECT_STORED_BYTES_LIMIT,
} from "./storage/directMessages";
import { closeTestStorages, json, jsonBody, request, testHandler, testStorage } from "./testing";

afterEach(closeTestStorages);

const OWNER = "owner";
const WORKSPACE = "workspace-dms";
const OTHER_WORKSPACE = "workspace-elsewhere";
// Accounts the account service no longer knows, as after account deletion.
const deletedAccounts = new Set<string>();
afterEach(() => deletedAccounts.clear());

async function seed(options: { activity?: DiscussionActivityHub; nowMs?: () => number } = {}) {
  const storage = await testStorage();
  const h = testHandler(storage, {
    lookupUserDisplayName: (userId: string) => deletedAccounts.has(userId) ? null : `Name ${userId}`,
    ...(options.activity ? { discussionActivity: options.activity } : {}),
    ...(options.nowMs ? { nowMs: options.nowMs } : {}),
  });
  for (const [owner, workspaceId] of [[OWNER, WORKSPACE], ["stranger", OTHER_WORKSPACE]] as const) {
    expect((await h(request(owner, "/sync/workspaces", jsonBody({ workspaceId })))).status).toBe(200);
  }
  return { storage, h };
}

function post(h: SyncRelayHandler, as: string, path: string, body: Record<string, unknown> = {}) {
  return h(request(as, path, jsonBody(body)));
}

async function member(h: SyncRelayHandler, userId: string, workspaceId = WORKSPACE, owner = OWNER): Promise<string> {
  const response = await post(h, owner, `/sync/${workspaceId}/members/invites`, { email: `${userId}@dohc.test`, workspaceName: "Community" });
  expect(response.status, await response.clone().text()).toBe(200);
  return (await json(response)).memberId as string;
}

const pick = (memberId: string, workspaceId = WORKSPACE): { person: DirectMemberPick } => ({ person: { workspaceId, memberId } });
type Target = { conversationId: string } | { person: DirectMemberPick };

let messageSeq = 0;
function send(h: SyncRelayHandler, as: string, target: Target | Record<string, unknown>, body = "hello", messageId = `m-${++messageSeq}`) {
  return post(h, as, "/sync/direct/send", { ...target, messageId, body });
}

async function sent(h: SyncRelayHandler, as: string, target: Target, body = "hello"): Promise<string> {
  const response = await send(h, as, target, body);
  expect(response.status, await response.clone().text()).toBe(200);
  return (await json(response)).conversationId as string;
}

async function list(h: SyncRelayHandler, as: string) {
  const response = await h(request(as, "/sync/direct/conversations"));
  expect(response.status, await response.clone().text()).toBe(200);
  const parsed = parseDirectConversationList(await response.json());
  expect(parsed).not.toBeNull();
  return parsed!;
}

async function bodies(h: SyncRelayHandler, as: string, conversationId: string, query = ""): Promise<string[]> {
  const response = await h(request(as, `/sync/direct/conversations/${conversationId}/messages${query}`));
  expect(response.status, await response.clone().text()).toBe(200);
  return parseDirectMessagePage(await response.json())!.messages.map((message) => message.body);
}

const block = (h: SyncRelayHandler, as: string, conversationId: string, blocked: boolean) =>
  post(h, as, `/sync/direct/conversations/${conversationId}/block`, { blocked });

const code = async (response: Response) => (await json(response)).code;
const only = (conversations: DirectConversation[]) => {
  expect(conversations).toHaveLength(1);
  return conversations[0]!;
};

describe("direct message routes", () => {
  it("parses every direct path, and only those", () => {
    const parse = (path: string) => parseRoute({ url: `http://relay.test${path}` });
    expect(parse("/sync/direct/conversations")).toEqual({ route: "direct-conversations" });
    expect(parse("/sync/direct/resolve")).toEqual({ route: "direct-resolve" });
    expect(parse("/sync/direct/send")).toEqual({ route: "direct-send" });
    expect(parse("/sync/direct/activity")).toEqual({ route: "direct-activity" });
    for (const [tail, route] of [["messages", "direct-messages"], ["read", "direct-read"], ["block", "direct-block"]]) {
      expect(parse(`/sync/direct/conversations/c-1/${tail}`)).toEqual({ route, conversationId: "c-1" });
    }
    for (const path of ["/sync/direct", "/sync/direct/other", "/sync/direct/conversations/c-1", "/sync/direct/conversations/c-1/other", "/sync/direct/conversations/c%201/read"]) {
      expect(() => parse(path)).toThrow();
    }
  });

  it("gives two people one conversation, from either side, without any email", async () => {
    const { h } = await seed();
    const ana = await member(h, "ana");
    const conversationId = await sent(h, OWNER, pick(ana), "hi ana");
    // Ana starts from her side, picking the owner: the same conversation.
    expect(await sent(h, "ana", pick("owner"), "hi back")).toBe(conversationId);
    const resolved = parseDirectResolution(await json(await post(h, "ana", "/sync/direct/resolve", pick("owner"))));
    expect(resolved).toEqual({ conversationId, person: { personId: OWNER, name: `Name ${OWNER}`, blocked: false } });

    const ownerSide = only((await list(h, OWNER)).conversations);
    expect(ownerSide).toMatchObject({ conversationId, person: { personId: "ana", name: "Name ana", blocked: false }, unread: 1 });
    expect(ownerSide.last).toMatchObject({ body: "hi back", authorId: "ana" });
    expect(await bodies(h, "ana", conversationId)).toEqual(["hi ana", "hi back"]);
    const raw = JSON.stringify(await json(await h(request("ana", "/sync/direct/conversations"))));
    expect(raw).not.toContain("@");
  });

  it("holds two people only: a third can't join, and a start naming more than one person is refused", async () => {
    const { h, storage } = await seed();
    const ana = await member(h, "ana");
    const bea = await member(h, "bea");
    const conversationId = await sent(h, OWNER, pick(ana), "just us");
    // Bea, a member of the same workspace, reaches nothing in it.
    expect((await send(h, "bea", { conversationId })).status).toBe(404);
    // A start names one person. The old list of people is not a request this relay reads.
    const many = await send(h, OWNER, { people: [pick(ana).person, pick(bea).person] });
    expect(many.status).toBe(400);
    // Bea writing to the owner starts a conversation of their own.
    const beaWithOwner = await sent(h, "bea", pick("owner"), "hi owner");
    expect(beaWithOwner).not.toBe(conversationId);
    expect((await list(h, "ana")).conversations.map((entry) => entry.conversationId)).toEqual([conversationId]);
    // The store holds a pair and nothing else.
    const context = storage as unknown as StorageContext;
    expect(() => context.db.prepare("INSERT INTO sync_relay_direct_conversations (conversation_id, people_key, created_at_ms) VALUES (?, ?, ?)")
      .run("three", JSON.stringify(["ana", "bea", OWNER]), 1)).toThrow();
  });

  it("refuses a person the caller does not share a workspace with, the same way as one that does not exist", async () => {
    const { h } = await seed();
    const ana = await member(h, "ana");
    const elsewhere = await member(h, "bea", OTHER_WORKSPACE, "stranger");
    const refusals = [
      await send(h, OWNER, pick(elsewhere)),
      await send(h, OWNER, pick(elsewhere, OTHER_WORKSPACE)),
      await send(h, OWNER, pick("no-such-member")),
      await send(h, "outsider", pick(ana)),
      await post(h, "outsider", "/sync/direct/resolve", pick(ana)),
    ];
    for (const response of refusals) expect(response.status).toBe(404);
    expect((await send(h, OWNER, pick("owner"))).status).toBe(404);
  });

  it("keeps a conversation private to its two people", async () => {
    const { h } = await seed();
    const ana = await member(h, "ana");
    await member(h, "bea");
    const conversationId = await sent(h, OWNER, pick(ana), "SENTINEL");
    expect((await list(h, "bea")).conversations).toEqual([]);
    for (const response of [
      await h(request("bea", `/sync/direct/conversations/${conversationId}/messages`)),
      await send(h, "bea", { conversationId }),
      await post(h, "bea", `/sync/direct/conversations/${conversationId}/read`, { seq: 1 }),
      await block(h, "bea", conversationId, true),
    ]) {
      expect(response.status).toBe(404);
      expect(await response.text()).not.toContain("SENTINEL");
    }
  });

  it("continues after a membership ends, and opens it again from the old pick only while it is current", async () => {
    const { h } = await seed();
    const ana = await member(h, "ana");
    const conversationId = await sent(h, OWNER, pick(ana), "before");
    expect((await post(h, OWNER, `/sync/${WORKSPACE}/members/${ana}/remove`)).status).toBe(200);
    expect(await sent(h, "ana", { conversationId }, "after")).toBe(conversationId);
    expect(await bodies(h, OWNER, conversationId)).toEqual(["before", "after"]);
    // A removed member is no longer on the member list, so the list cannot reach them.
    expect((await send(h, OWNER, pick(ana))).status).toBe(404);
  });

  it("answers a retried send with its first seq and refuses an id reused for something else", async () => {
    const { h } = await seed();
    const ana = await member(h, "ana");
    const conversationId = await sent(h, OWNER, pick(ana));
    const first = await send(h, OWNER, { conversationId }, "once", "retry-1");
    const again = await send(h, OWNER, { conversationId }, "once", "retry-1");
    expect((await json(first)).seq).toBe((await json(again)).seq);
    expect(await code(await send(h, OWNER, { conversationId }, "different", "retry-1"))).toBe("direct_message_id_taken");
    expect(await bodies(h, OWNER, conversationId)).toEqual(["hello", "once"]);
  });

  it("pages back through history and reads only what is new", async () => {
    const { h } = await seed();
    const ana = await member(h, "ana");
    const conversationId = await sent(h, OWNER, pick(ana), "1");
    for (const body of ["2", "3", "4", "5"]) await sent(h, OWNER, { conversationId }, body);
    const latest = parseDirectMessagePage(await json(await h(request("ana", `/sync/direct/conversations/${conversationId}/messages?limit=2`))))!;
    expect(latest.messages.map((message) => message.body)).toEqual(["4", "5"]);
    expect(latest.more).toBe(true);
    expect(await bodies(h, "ana", conversationId, `?before=${latest.messages[0]!.seq}&limit=2`)).toEqual(["2", "3"]);
    expect(await bodies(h, "ana", conversationId, "?after=3")).toEqual(["4", "5"]);
    expect((await h(request("ana", `/sync/direct/conversations/${conversationId}/messages?after=1&before=3`))).status).toBe(400);
  });

  it("counts unread from the other person only and never moves the read mark back", async () => {
    const { h } = await seed();
    const ana = await member(h, "ana");
    const conversationId = await sent(h, OWNER, pick(ana), "1");
    await sent(h, OWNER, { conversationId }, "2");
    expect(only((await list(h, OWNER)).conversations).unread).toBe(0);
    expect(only((await list(h, "ana")).conversations).unread).toBe(2);
    expect((await post(h, "ana", `/sync/direct/conversations/${conversationId}/read`, { seq: 99 })).status).toBe(200);
    expect(only((await list(h, "ana")).conversations).unread).toBe(0);
    await sent(h, OWNER, { conversationId }, "3");
    expect((await post(h, "ana", `/sync/direct/conversations/${conversationId}/read`, { seq: 1 })).status).toBe(200);
    expect(only((await list(h, "ana")).conversations).unread).toBe(1);
  });

  it("refuses the blocked person's sends, in the conversation and from the member list, until the block is undone", async () => {
    const { h } = await seed();
    const ana = await member(h, "ana");
    const conversationId = await sent(h, OWNER, pick(ana), "before the block");
    expect((await block(h, "ana", conversationId, true)).status).toBe(200);
    expect(only((await list(h, "ana")).conversations).person).toMatchObject({ personId: OWNER, blocked: true });
    const refused = await send(h, OWNER, { conversationId }, "SENTINEL");
    expect(refused.status).toBe(403);
    expect(await code(refused)).toBe("direct_blocked");
    expect(await code(await send(h, OWNER, pick(ana)))).toBe("direct_blocked");
    // Nothing is stored or hidden: the blocker's history holds what was said before.
    expect(await bodies(h, "ana", conversationId)).toEqual(["before the block"]);
    // The blocker can still write.
    expect(await sent(h, "ana", { conversationId }, "from ana")).toBe(conversationId);
    expect((await block(h, "ana", conversationId, false)).status).toBe(200);
    expect(await sent(h, OWNER, { conversationId }, "after")).toBe(conversationId);
    expect(await bodies(h, OWNER, conversationId)).toEqual(["before the block", "from ana", "after"]);
  });

  it("refuses a new conversation with someone who blocks the caller", async () => {
    const { h } = await seed();
    const ana = await member(h, "ana");
    const bea = await member(h, "bea");
    // Bea blocks the owner through the conversation the two of them share.
    const withBea = await sent(h, "bea", pick("owner"), "hi");
    expect((await block(h, "bea", withBea, true)).status).toBe(200);
    // The owner's conversation with Ana is not affected.
    expect(await sent(h, OWNER, pick(ana), "hi ana")).toBeTruthy();
    expect(await code(await send(h, OWNER, pick(bea)))).toBe("direct_blocked");
  });

  it("wakes both people on a send, and nobody on a refused one", async () => {
    const activity = new DiscussionActivityHub();
    const { h } = await seed({ activity });
    const ana = await member(h, "ana");
    const conversationId = await sent(h, OWNER, pick(ana));
    const revision = async (as: string) => (await json(await h(request(as, "/sync/direct/activity")))).revision as number;
    const anaAt = await revision("ana");
    const anaWait = h(request("ana", `/sync/direct/activity?since=${anaAt}&waitMs=20000`));
    await sent(h, OWNER, { conversationId }, "wake up");
    expect((await json(await anaWait)).revision).toBeGreaterThan(anaAt);

    expect((await block(h, "ana", conversationId, true)).status).toBe(200);
    const [ownerAt, blockedAt] = [await revision(OWNER), await revision("ana")];
    const anaQuiet = h(request("ana", `/sync/direct/activity?since=${blockedAt}&waitMs=150`));
    expect((await send(h, OWNER, { conversationId })).status).toBe(403);
    expect((await json(await anaQuiet)).revision).toBe(blockedAt);
    expect(await revision(OWNER)).toBe(ownerAt);
  });

  it("keeps a deleted account's messages for the other person, and refuses writing to nobody", async () => {
    const { h, storage } = await seed();
    const ana = await member(h, "ana");
    const conversationId = await sent(h, OWNER, pick(ana), "from owner");
    await sent(h, "ana", { conversationId }, "from ana");
    const context = storage as unknown as StorageContext;
    const key = "account-deletion-key-at-least-32-bytes";
    initializeAccountDeletion(context, key);
    const { manifest } = fenceAccount(context, key, "ana", "ana@dohc.test");
    purgeAccountRows(context, "ana", "ana@dohc.test", manifest ?? { workspaces: [], shareIds: [], datasets: [], grantIds: [], publicationIds: [] });
    deletedAccounts.add("ana");
    expect(await bodies(h, OWNER, conversationId)).toEqual(["from owner", "from ana"]);
    const conversation = only((await list(h, OWNER)).conversations);
    expect(conversation.person).toEqual({ personId: "ana", name: null, blocked: false });
    expect((await send(h, OWNER, { conversationId })).status).toBe(404);
    // Once nobody holds it, the conversation and its messages go.
    const ownerDeletion = fenceAccount(context, key, OWNER, `${OWNER}@dohc.test`);
    purgeAccountRows(context, OWNER, `${OWNER}@dohc.test`, ownerDeletion.manifest!);
    expect(context.db.prepare("SELECT count(*) AS n FROM sync_relay_direct_messages").get()!.n).toBe(0);
  });

  it("limits how fast one account sends, and still answers a retry", async () => {
    let now = 1_000_000;
    const { h } = await seed({ nowMs: () => now });
    const ana = await member(h, "ana");
    const conversationId = await sent(h, OWNER, pick(ana));
    for (let index = 1; index < DIRECT_SEND_RATE_LIMIT; index += 1) await sent(h, OWNER, { conversationId });
    const refused = await send(h, OWNER, { conversationId }, "one more", "over-the-rate");
    expect(refused.status).toBe(429);
    expect(await code(refused)).toBe("direct_rate_limited");
    // A retry of a message already stored is not a new send.
    expect((await send(h, OWNER, { conversationId }, "hello", `m-${messageSeq}`)).status).toBe(200);
    // Ana's own sends are counted apart.
    expect((await send(h, "ana", { conversationId })).status).toBe(200);
    now += DIRECT_SEND_RATE_WINDOW_MS + 1;
    expect((await send(h, OWNER, { conversationId }, "one more", "over-the-rate")).status).toBe(200);
  });

  it("limits new conversations a day, without leaving an empty one behind", async () => {
    let now = 1_000_000;
    const { h } = await seed({ nowMs: () => now });
    const members: string[] = [];
    for (let index = 0; index <= DIRECT_NEW_CONVERSATION_LIMIT; index += 1) members.push(await member(h, `p${index}`));
    for (const memberId of members.slice(0, DIRECT_NEW_CONVERSATION_LIMIT)) {
      now += 3_000;
      await sent(h, OWNER, pick(memberId));
    }
    now += DIRECT_SEND_RATE_WINDOW_MS;
    const next = pick(members[DIRECT_NEW_CONVERSATION_LIMIT]!);
    const refused = await send(h, OWNER, next);
    expect(refused.status).toBe(429);
    expect(await code(refused)).toBe("direct_rate_limited");
    expect((await list(h, OWNER)).conversations).toHaveLength(DIRECT_NEW_CONVERSATION_LIMIT);
    // Writing to a conversation that exists is still fine.
    expect((await send(h, OWNER, pick(members[0]!))).status).toBe(200);
    now += DIRECT_NEW_CONVERSATION_WINDOW_MS;
    expect((await send(h, OWNER, next)).status).toBe(200);
  });

  it("stops an account at the most this server stores for it", async () => {
    const { h, storage } = await seed();
    const ana = await member(h, "ana");
    const conversationId = await sent(h, OWNER, pick(ana), "1234567890");
    const context = storage as unknown as StorageContext;
    // A message costs its words and its row.
    expect(context.db.prepare("SELECT stored_bytes FROM sync_relay_direct_usage WHERE user_id = ?").get(OWNER)!.stored_bytes).toBe(10 + DIRECT_MESSAGE_ROW_BYTES);
    context.db.prepare("UPDATE sync_relay_direct_usage SET stored_bytes = ? WHERE user_id = ?").run(DIRECT_STORED_BYTES_LIMIT - 10 - DIRECT_MESSAGE_ROW_BYTES, OWNER);
    const refused = await send(h, OWNER, { conversationId }, "12345678901");
    expect(refused.status).toBe(413);
    expect(await code(refused)).toBe("direct_limit_reached");
    expect((await send(h, OWNER, { conversationId }, "1234567890")).status).toBe(200);
    expect(context.db.prepare("SELECT stored_bytes FROM sync_relay_direct_usage WHERE user_id = ?").get(OWNER)!.stored_bytes).toBe(DIRECT_STORED_BYTES_LIMIT);
    expect(await bodies(h, OWNER, conversationId)).toEqual(["1234567890", "1234567890"]);
  });
});
