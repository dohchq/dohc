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

const pick = (memberId: string, workspaceId = WORKSPACE): DirectMemberPick => ({ workspaceId, memberId });

let messageSeq = 0;
function send(h: SyncRelayHandler, as: string, target: { conversationId: string } | { people: DirectMemberPick[] }, body = "hello", messageId = `m-${++messageSeq}`) {
  return post(h, as, "/sync/direct/send", { ...target, messageId, body });
}

async function sent(h: SyncRelayHandler, as: string, target: { conversationId: string } | { people: DirectMemberPick[] }, body = "hello"): Promise<string> {
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
    const conversationId = await sent(h, OWNER, { people: [pick(ana)] }, "hi ana");
    // Ana starts from her side, picking the owner: the same conversation.
    expect(await sent(h, "ana", { people: [pick("owner")] }, "hi back")).toBe(conversationId);
    const resolved = parseDirectResolution(await json(await post(h, "ana", "/sync/direct/resolve", { people: [pick("owner")] })));
    expect(resolved).toEqual({ conversationId, people: [{ personId: OWNER, name: `Name ${OWNER}`, blocked: false }] });

    const ownerSide = only((await list(h, OWNER)).conversations);
    expect(ownerSide).toMatchObject({ conversationId, people: [{ personId: "ana", name: "Name ana" }], unread: 1, blocked: false });
    expect(ownerSide.last).toMatchObject({ body: "hi back", authorId: "ana" });
    expect(await bodies(h, "ana", conversationId)).toEqual(["hi ana", "hi back"]);
    const raw = JSON.stringify(await json(await h(request("ana", "/sync/direct/conversations"))));
    expect(raw).not.toContain("@");
  });

  it("refuses a person the caller does not share a workspace with, the same way as one that does not exist", async () => {
    const { h } = await seed();
    const ana = await member(h, "ana");
    const elsewhere = await member(h, "bea", OTHER_WORKSPACE, "stranger");
    const refusals = [
      await send(h, OWNER, { people: [pick(elsewhere)] }),
      await send(h, OWNER, { people: [pick(elsewhere, OTHER_WORKSPACE)] }),
      await send(h, OWNER, { people: [pick("no-such-member")] }),
      await send(h, "outsider", { people: [pick(ana)] }),
      await post(h, "outsider", "/sync/direct/resolve", { people: [pick(ana)] }),
    ];
    for (const response of refusals) expect(response.status).toBe(404);
    expect((await send(h, OWNER, { people: [pick("owner")] })).status).toBe(404);
  });

  it("keeps a conversation private to its people", async () => {
    const { h } = await seed();
    const ana = await member(h, "ana");
    await member(h, "bea");
    const conversationId = await sent(h, OWNER, { people: [pick(ana)] }, "SENTINEL");
    expect((await list(h, "bea")).conversations).toEqual([]);
    for (const response of [
      await h(request("bea", `/sync/direct/conversations/${conversationId}/messages`)),
      await send(h, "bea", { conversationId }),
      await post(h, "bea", `/sync/direct/conversations/${conversationId}/read`, { seq: 1 }),
      await post(h, "bea", `/sync/direct/conversations/${conversationId}/block`, { personId: OWNER, blocked: true }),
    ]) {
      expect(response.status).toBe(404);
      expect(await response.text()).not.toContain("SENTINEL");
    }
  });

  it("continues after a membership ends, and opens it again from the old pick only while it is current", async () => {
    const { h } = await seed();
    const ana = await member(h, "ana");
    const conversationId = await sent(h, OWNER, { people: [pick(ana)] }, "before");
    expect((await post(h, OWNER, `/sync/${WORKSPACE}/members/${ana}/remove`)).status).toBe(200);
    expect(await sent(h, "ana", { conversationId }, "after")).toBe(conversationId);
    expect(await bodies(h, OWNER, conversationId)).toEqual(["before", "after"]);
    // A removed member is no longer on the member list, so the list cannot reach them.
    expect((await send(h, OWNER, { people: [pick(ana)] })).status).toBe(404);
  });

  it("answers a retried send with its first seq and refuses an id reused for something else", async () => {
    const { h } = await seed();
    const ana = await member(h, "ana");
    const conversationId = await sent(h, OWNER, { people: [pick(ana)] });
    const first = await send(h, OWNER, { conversationId }, "once", "retry-1");
    const again = await send(h, OWNER, { conversationId }, "once", "retry-1");
    expect((await json(first)).seq).toBe((await json(again)).seq);
    expect(await code(await send(h, OWNER, { conversationId }, "different", "retry-1"))).toBe("direct_message_id_taken");
    expect(await bodies(h, OWNER, conversationId)).toEqual(["hello", "once"]);
  });

  it("pages back through history and reads only what is new", async () => {
    const { h } = await seed();
    const ana = await member(h, "ana");
    const conversationId = await sent(h, OWNER, { people: [pick(ana)] }, "1");
    for (const body of ["2", "3", "4", "5"]) await sent(h, OWNER, { conversationId }, body);
    const latest = parseDirectMessagePage(await json(await h(request("ana", `/sync/direct/conversations/${conversationId}/messages?limit=2`))))!;
    expect(latest.messages.map((message) => message.body)).toEqual(["4", "5"]);
    expect(latest.more).toBe(true);
    expect(await bodies(h, "ana", conversationId, `?before=${latest.messages[0]!.seq}&limit=2`)).toEqual(["2", "3"]);
    expect(await bodies(h, "ana", conversationId, "?after=3")).toEqual(["4", "5"]);
    expect((await h(request("ana", `/sync/direct/conversations/${conversationId}/messages?after=1&before=3`))).status).toBe(400);
  });

  it("counts unread from other people only and never moves the read mark back", async () => {
    const { h } = await seed();
    const ana = await member(h, "ana");
    const conversationId = await sent(h, OWNER, { people: [pick(ana)] }, "1");
    await sent(h, OWNER, { conversationId }, "2");
    expect(only((await list(h, OWNER)).conversations).unread).toBe(0);
    expect(only((await list(h, "ana")).conversations).unread).toBe(2);
    expect((await post(h, "ana", `/sync/direct/conversations/${conversationId}/read`, { seq: 99 })).status).toBe(200);
    expect(only((await list(h, "ana")).conversations).unread).toBe(0);
    await sent(h, OWNER, { conversationId }, "3");
    expect((await post(h, "ana", `/sync/direct/conversations/${conversationId}/read`, { seq: 1 })).status).toBe(200);
    expect(only((await list(h, "ana")).conversations).unread).toBe(1);
  });

  it("refuses a blocked person in a two-person conversation, and a new conversation that includes the blocker", async () => {
    const { h } = await seed();
    const ana = await member(h, "ana");
    const bea = await member(h, "bea");
    const conversationId = await sent(h, OWNER, { people: [pick(ana)] }, "before the block");
    expect((await post(h, "ana", `/sync/direct/conversations/${conversationId}/block`, { personId: OWNER, blocked: true })).status).toBe(200);
    expect(only((await list(h, "ana")).conversations).blocked).toBe(true);
    expect(await code(await send(h, OWNER, { conversationId }))).toBe("direct_blocked");
    expect(await code(await send(h, OWNER, { people: [pick(ana), pick(bea)] }))).toBe("direct_blocked");
    // The blocker can still write, and the earlier message stays.
    expect(await sent(h, "ana", { conversationId }, "from ana")).toBe(conversationId);
    expect(await bodies(h, "ana", conversationId)).toEqual(["before the block", "from ana"]);
    // A block belongs to the account, so a group the two share undoes it too.
    const group = await sent(h, "ana", { people: [pick("owner"), pick(bea)] }, "group from ana");
    expect((await post(h, "ana", `/sync/direct/conversations/${group}/block`, { personId: OWNER, blocked: false })).status).toBe(200);
    expect(await sent(h, OWNER, { conversationId }, "after")).toBe(conversationId);
  });

  it("hides a blocked person's messages in a larger conversation everywhere the blocker could see them, for good", async () => {
    const { h } = await seed();
    const ana = await member(h, "ana");
    const bea = await member(h, "bea");
    const conversationId = await sent(h, OWNER, { people: [pick(ana), pick(bea)] }, "hello all");
    expect((await post(h, "ana", `/sync/direct/conversations/${conversationId}/read`, { seq: 1 })).status).toBe(200);
    expect((await post(h, "ana", `/sync/direct/conversations/${conversationId}/block`, { personId: "bea", blocked: true })).status).toBe(200);
    await sent(h, "bea", { conversationId }, "SENTINEL from bea");
    const anaSide = only((await list(h, "ana")).conversations);
    expect(anaSide).toMatchObject({ unread: 0, blocked: false });
    // The blocker sees whom they block, so they can undo it.
    expect(anaSide.people.map(({ personId, blocked }) => [personId, blocked])).toEqual([[OWNER, false], ["bea", true]].sort());
    expect(anaSide.last?.body).toBe("hello all");
    expect(await bodies(h, "ana", conversationId)).toEqual(["hello all"]);
    expect(await bodies(h, OWNER, conversationId)).toEqual(["hello all", "SENTINEL from bea"]);
    // Unblocking shows what bea says next, never what was hidden.
    expect((await post(h, "ana", `/sync/direct/conversations/${conversationId}/block`, { personId: "bea", blocked: false })).status).toBe(200);
    await sent(h, "bea", { conversationId }, "after");
    expect(await bodies(h, "ana", conversationId)).toEqual(["hello all", "after"]);
    expect(only((await list(h, "ana")).conversations).people.every((person) => !person.blocked)).toBe(true);
  });

  it("blocks only a person the blocker shares the conversation with", async () => {
    const { h } = await seed();
    const ana = await member(h, "ana");
    await member(h, "bea");
    const conversationId = await sent(h, OWNER, { people: [pick(ana)] });
    expect((await post(h, OWNER, `/sync/direct/conversations/${conversationId}/block`, { personId: "bea", blocked: true })).status).toBe(404);
    expect((await post(h, OWNER, `/sync/direct/conversations/${conversationId}/block`, { personId: OWNER, blocked: true })).status).toBe(404);
  });

  it("wakes the people a message reaches, and not a blocker", async () => {
    const activity = new DiscussionActivityHub();
    const { h } = await seed({ activity });
    const ana = await member(h, "ana");
    const bea = await member(h, "bea");
    const conversationId = await sent(h, OWNER, { people: [pick(ana), pick(bea)] });
    expect((await post(h, "ana", `/sync/direct/conversations/${conversationId}/block`, { personId: "bea", blocked: true })).status).toBe(200);
    const revision = async (as: string) => (await json(await h(request(as, "/sync/direct/activity")))).revision as number;
    const [ownerAt, anaAt] = [await revision(OWNER), await revision("ana")];
    const ownerWait = h(request(OWNER, `/sync/direct/activity?since=${ownerAt}&waitMs=20000`));
    const anaWait = h(request("ana", `/sync/direct/activity?since=${anaAt}&waitMs=150`));
    await sent(h, "bea", { conversationId }, "hidden from ana");
    expect((await json(await ownerWait)).revision).toBeGreaterThan(ownerAt);
    expect((await json(await anaWait)).revision).toBe(anaAt);
  });

  it("keeps a deleted account's messages for the people it wrote to, and refuses writing to nobody", async () => {
    const { h, storage } = await seed();
    const ana = await member(h, "ana");
    const conversationId = await sent(h, OWNER, { people: [pick(ana)] }, "from owner");
    await sent(h, "ana", { conversationId }, "from ana");
    const context = storage as unknown as StorageContext;
    const key = "account-deletion-key-at-least-32-bytes";
    initializeAccountDeletion(context, key);
    const { manifest } = fenceAccount(context, key, "ana", "ana@dohc.test");
    purgeAccountRows(context, "ana", "ana@dohc.test", manifest ?? { workspaces: [], shareIds: [], datasets: [], grantIds: [], publicationIds: [] });
    deletedAccounts.add("ana");
    expect(await bodies(h, OWNER, conversationId)).toEqual(["from owner", "from ana"]);
    const conversation = only((await list(h, OWNER)).conversations);
    expect(conversation.people).toEqual([{ personId: "ana", name: null, blocked: false }]);
    expect(await code(await send(h, OWNER, { conversationId }))).toBe("direct_alone");
    // Once nobody holds it, the conversation and its messages go.
    const ownerDeletion = fenceAccount(context, key, OWNER, `${OWNER}@dohc.test`);
    purgeAccountRows(context, OWNER, `${OWNER}@dohc.test`, ownerDeletion.manifest!);
    expect(context.db.prepare("SELECT count(*) AS n FROM sync_relay_direct_messages").get()!.n).toBe(0);
  });

  it("limits how fast one account sends, and still answers a retry", async () => {
    let now = 1_000_000;
    const { h } = await seed({ nowMs: () => now });
    const ana = await member(h, "ana");
    const conversationId = await sent(h, OWNER, { people: [pick(ana)] });
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
    for (const name of ["a1", "a2", "a3", "a4", "a5", "a6", "a7"]) members.push(await member(h, name));
    // Distinct sets of people, each a new conversation.
    const sets = Array.from({ length: 2 ** members.length - 1 }, (_, mask) => members.filter((_, bit) => ((mask + 1) >> bit) & 1));
    for (const people of sets.slice(0, DIRECT_NEW_CONVERSATION_LIMIT)) {
      now += 3_000;
      await sent(h, OWNER, { people: people.map((memberId) => pick(memberId)) });
    }
    now += DIRECT_SEND_RATE_WINDOW_MS;
    const next = sets[DIRECT_NEW_CONVERSATION_LIMIT]!.map((memberId) => pick(memberId));
    const refused = await send(h, OWNER, { people: next });
    expect(refused.status).toBe(429);
    expect(await code(refused)).toBe("direct_rate_limited");
    expect((await list(h, OWNER)).conversations).toHaveLength(DIRECT_NEW_CONVERSATION_LIMIT);
    // Writing to a conversation that exists is still fine.
    expect((await send(h, OWNER, { people: sets[0]!.map((memberId) => pick(memberId)) })).status).toBe(200);
    now += DIRECT_NEW_CONVERSATION_WINDOW_MS;
    expect((await send(h, OWNER, { people: next })).status).toBe(200);
  });

  it("stops an account at the most this server stores for it", async () => {
    const { h, storage } = await seed();
    const ana = await member(h, "ana");
    const conversationId = await sent(h, OWNER, { people: [pick(ana)] }, "1234567890");
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
