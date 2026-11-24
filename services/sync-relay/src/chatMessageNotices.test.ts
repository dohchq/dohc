import { createECDH } from "node:crypto";
import { GENERAL_CHANNEL_WIRE_ID } from "@dohc/security-contract/chat-wire-ids";
import type { RelayNotice } from "@dohc/workspace-contracts/relay";
import { afterEach, describe, expect, it } from "vitest";
import type { SyncRelayHandler } from "./server";
import type { StorageContext } from "./storage/context";
import {
  chatChannelCreate,
  chatMessageAppend,
  chatThreadCreate,
  closeTestStorages,
  json,
  jsonBody,
  logOp,
  request,
  resetOpSeq,
  testHandler,
  testStorage,
} from "./testing";

afterEach(closeTestStorages);

const OWNER = "owner";
const WORKSPACE = "workspace-mentions";
const EVENTS = "wire-events";
const NAMES: Record<string, string> = { owner: "Kim", ana: "Ana", bo: "Bo" };
const browserKey = createECDH("prime256v1");
browserKey.generateKeys();

function channel(wireId: string, name: string) {
  return logOp(
    "chat.channel.create",
    chatChannelCreate(wireId, {
      channelId: `chan-${wireId}`,
      name,
      slug: name,
      kind: "channel",
      type: "both",
      purpose: "",
      folderPath: name,
    }).payload,
  );
}

function thread(threadId: string, wireId: string, slug: string) {
  return logOp("chat.thread.create", chatThreadCreate(threadId, wireId, { slug }).payload);
}

function post(h: SyncRelayHandler, as: string, path: string, body: Record<string, unknown> = {}) {
  return h(request(as, path, jsonBody(body)));
}

// The owner's workspace has a Group, #events, with a welcome message from
// the owner, and General, which members never read.
async function seed() {
  resetOpSeq();
  const storage = (await testStorage({ pushConfigured: true })) as StorageContext;
  const h = testHandler(storage, {
    lookupUserDisplayName: (userId: string) => NAMES[userId] ?? null,
  });
  expect((await post(h, OWNER, "/sync/workspaces", { workspaceId: WORKSPACE })).status).toBe(200);
  const ownerSays = async (
    messageId: string,
    threadId: string,
    body: string,
    extra: Record<string, unknown> = {},
  ) => {
    const response = await post(h, OWNER, `/sync/${WORKSPACE}/log`, {
      originId: "origin-owner",
      ops: [
        {
          ...logOp(
            "chat.message.append",
            chatMessageAppend(messageId, threadId, body, { authorUserId: OWNER, ...extra }).payload,
          ),
          originSeq: storage.maxOriginSeq(WORKSPACE, "origin-owner") + 1,
        },
      ],
    });
    expect(response.status, await response.clone().text()).toBe(200);
  };
  const ownerOps = await post(h, OWNER, `/sync/${WORKSPACE}/log`, {
    originId: "origin-owner",
    ops: [
      channel(EVENTS, "events"),
      thread("t-events", EVENTS, "events"),
      thread("t-quiet", EVENTS, "quiet"),
      channel(GENERAL_CHANNEL_WIRE_ID, "general"),
      thread("t-general", GENERAL_CHANNEL_WIRE_ID, "general"),
    ],
  });
  expect(ownerOps.status, await ownerOps.clone().text()).toBe(200);
  await ownerSays("welcome", "t-events", "welcome to events");

  const seqs = new Map<string, number>();
  const member = async (userId: string) => {
    const invited = await post(h, OWNER, `/sync/${WORKSPACE}/members/invites`, {
      email: `${userId}@dohc.test`,
      workspaceName: "Community",
    });
    expect(invited.status, await invited.clone().text()).toBe(200);
    const received = await json(await h(request(userId, "/sync/shares")));
    const shareId = (received.received as Array<Record<string, unknown>>).find(
      (row) => (row.selector as { kind?: string }).kind === "workspace",
    )!.shareId as string;
    // Opening the joined workspace checks access, as the member's computer does.
    expect((await h(request(userId, `/sync/shares/${shareId}/access`))).status).toBe(200);
    const memberId = (
      (await json(invited)).people as Array<{ memberId: string; email: string | null }>
    ).find((person) => person.email === `${userId}@dohc.test`)!.memberId;
    return {
      shareId,
      memberId,
      async says(
        messageId: string,
        threadId: string,
        body: string,
        extra: Record<string, unknown> = {},
      ) {
        const seq = seqs.get(userId) ?? 0;
        const response = await post(h, userId, `/sync/shares/${shareId}/log`, {
          originId: `origin-${userId}`,
          ops: [
            {
              ...logOp(
                "chat.message.append",
                chatMessageAppend(messageId, threadId, body, { authorUserId: userId, ...extra })
                  .payload,
              ),
              originSeq: seq,
            },
          ],
        });
        expect(response.status, await response.clone().text()).toBe(200);
        seqs.set(userId, seq + 1);
      },
    };
  };
  const bindPush = (userId: string) =>
    storage.bindPushSubscription({
      installationId: `installation-${userId}`.padEnd(22, "0"),
      userId,
      sessionId: `session-${userId}`,
      sessionExpiresAtMs: Date.now() + 1_000_000,
      endpoint: `https://push.example.test/send/${userId}`,
      p256dh: browserKey.getPublicKey().toString("base64url"),
      auth: Buffer.alloc(16, 7).toString("base64url"),
      vapidKeyId: "a".repeat(64),
      browserExpiresAtMs: null,
      nowMs: Date.now(),
      accountName: NAMES[userId] ?? "",
    });
  const notices = async (userId: string): Promise<RelayNotice[]> => {
    const response = await h(request(userId, "/sync/notices?limit=200"));
    expect(response.status, await response.clone().text()).toBe(200);
    return ((await json(response)).notices as RelayNotice[]).filter(
      (row) => row.kind === "chat-message",
    );
  };
  const pushes = (userId: string) =>
    storage.db
      .prepare(
        "SELECT message_id, reason FROM sync_relay_push_deliveries WHERE account_user_id = ? ORDER BY rowid",
      )
      .all(userId)
      .map((row) => ({ message: String(row.message_id), reason: String(row.reason) }));
  return { storage, h, ownerSays, member, bindPush, notices, pushes };
}

describe("mention and reply Notices", () => {
  it("tells a member the owner mentioned them, through their membership", async () => {
    const s = await seed();
    const ana = await s.member("ana");
    s.bindPush("ana");
    await s.ownerSays("hey", "t-events", "@Ana can you bring the chairs?");
    expect(await s.notices("ana")).toEqual([
      expect.objectContaining({
        kind: "chat-message",
        senderKind: "person",
        senderUserId: OWNER,
        senderLabel: "Kim",
        title: "Kim mentioned you in #events",
        body: "@Ana can you bring the chairs?",
        workspaceId: null,
        recipientShareId: ana.shareId,
        target: { share: ana.shareId, thread: "t-events", message: "hey" },
        originInstallId: "relay",
      }),
    ]);
    expect(s.pushes("ana")).toEqual([{ message: "hey", reason: "mention" }]);
  });

  it("tells the owner a member mentioned them, in the owned workspace", async () => {
    const s = await seed();
    const ana = await s.member("ana");
    await ana.says("ask", "t-quiet", "@Kim when do we start?");
    expect(await s.notices(OWNER)).toEqual([
      expect.objectContaining({
        senderUserId: "ana",
        senderLabel: "Ana",
        title: "Ana mentioned you in #events",
        workspaceId: WORKSPACE,
        recipientShareId: null,
        target: { thread: "t-quiet", message: "ask" },
      }),
    ]);
  });

  it("tells earlier human authors in the thread about a reply, and never the author", async () => {
    const s = await seed();
    const ana = await s.member("ana");
    await ana.says("first", "t-events", "count me in");
    expect((await s.notices(OWNER)).map((row) => row.title)).toEqual(["Ana replied in #events"]);
    expect(await s.notices("ana")).toEqual([]);
    await s.ownerSays("second", "t-events", "great, thanks");
    expect(await s.notices("ana")).toEqual([
      expect.objectContaining({
        title: "Kim replied in #events",
        target: { share: ana.shareId, thread: "t-events", message: "second" },
      }),
    ]);
    expect((await s.notices(OWNER)).map((row) => row.title)).toEqual(["Ana replied in #events"]);
  });

  it("writes nothing for a mention of the author", async () => {
    const s = await seed();
    const ana = await s.member("ana");
    s.bindPush("ana");
    await ana.says("self", "t-quiet", "note to @Ana");
    expect(await s.notices("ana")).toEqual([]);
    expect(s.pushes("ana")).toEqual([]);
  });

  it("writes no Notice and no push for someone who cannot read the chat", async () => {
    const s = await seed();
    await s.member("ana");
    s.bindPush("ana");
    await s.ownerSays("private", "t-general", "@Ana should not see this");
    expect(await s.notices("ana")).toEqual([]);
    expect(s.pushes("ana")).toEqual([]);
  });

  it("writes nothing for a removed member", async () => {
    const s = await seed();
    const ana = await s.member("ana");
    await ana.says("before", "t-events", "count me in");
    expect(
      (await post(s.h, OWNER, `/sync/${WORKSPACE}/members/${ana.memberId}/remove`)).status,
    ).toBe(200);
    s.bindPush("ana");
    await s.ownerSays("after", "t-events", "@Ana are you still coming?");
    expect(await s.notices("ana")).toEqual([]);
    expect(s.pushes("ana")).toEqual([]);
  });

  it("writes no Notice for an agent's message, and an agent's post makes no one a thread author", async () => {
    const s = await seed();
    const ana = await s.member("ana");
    await s.ownerSays("agent", "t-quiet", "@Ana here is the plan", {
      authorKind: "agent",
      authorDisplayName: "Planner",
      authorOwnerDisplayName: "Kim",
    });
    expect(await s.notices("ana")).toEqual([]);
    await ana.says("answer", "t-quiet", "thanks, @Planner");
    expect(await s.notices(OWNER)).toEqual([]);
  });

  it("gives push and Notices the same people for the same messages", async () => {
    const s = await seed();
    const ana = await s.member("ana");
    const bo = await s.member("bo");
    for (const userId of [OWNER, "ana", "bo"]) s.bindPush(userId);
    await ana.says("a1", "t-events", "count me in");
    await bo.says("b1", "t-quiet", "@Ana @Kim who is driving?");
    await s.ownerSays("o1", "t-events", "@Bo please drive");
    await s.ownerSays("o2", "t-general", "@Ana @Bo nothing here");
    for (const userId of [OWNER, "ana", "bo"]) {
      const fromNotices = (await s.notices(userId))
        .map((row) => ({
          message: row.target!.message!,
          reason: row.title.includes("mentioned") ? "mention" : "reply",
        }))
        .sort((a, b) => a.message.localeCompare(b.message));
      const fromPush = s.pushes(userId).sort((a, b) => a.message.localeCompare(b.message));
      expect(fromNotices.length, userId).toBeGreaterThan(0);
      expect(fromNotices, userId).toEqual(fromPush);
    }
  });
});
