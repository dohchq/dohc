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
  putBlob,
  request,
  resetOpSeq,
  testHandler,
  testStorage,
} from "./testing";

afterEach(closeTestStorages);

const OWNER = "owner";
const WORKSPACE = "workspace-mentions";
const EVENTS = "wire-events";
const NAMES: Record<string, string> = {
  owner: "Kim",
  ana: "Ana",
  bo: "Bo",
  ben: "Ben",
  cara: "Cara",
};
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
  // Appends ops from the owner's computer, one after another.
  const ownerAppends = async (
    ...ops: Array<{ opKind: string; payload: Record<string, unknown> }>
  ) => {
    for (const op of ops) {
      const originSeq = storage.maxOriginSeq(WORKSPACE, "origin-owner") + 1;
      const response = await post(h, OWNER, `/sync/${WORKSPACE}/log`, {
        originId: "origin-owner",
        ops: [{ ...op, originSeq, recordedAtMs: 1000 + originSeq }],
      });
      expect(response.status, await response.clone().text()).toBe(200);
    }
  };
  // Writes a file, or moves one, keeping its object id.
  const files = new Map<string, { path: string; sha: string }>();
  const ownerWrite = async (objectId: string, path: string, text: string) => {
    const sha = await putBlob(h, OWNER, WORKSPACE, text);
    const before = files.get(objectId);
    await ownerAppends({
      opKind: "moment.append",
      payload: {
        momentId: `m-${objectId}-${files.size}-${path}`,
        versionId: "main",
        objectId,
        path,
        recordedAtMs: 1000,
        operation: before && before.path !== path ? "rename" : "write",
        payloadBeforeBlobSha256: before?.sha ?? null,
        payloadBeforePath: before?.path ?? null,
        ...(before && before.path !== path ? { beforePath: before.path } : {}),
        payloadAfterBlobSha256: sha,
        payloadAfterPath: path,
        metadata: { origin: "user" },
        beforePresent: "null",
      },
    });
    files.set(objectId, { path, sha });
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
  // One page of chat Notices, and the cursor that follows it.
  const page = async (userId: string, cursor?: string) => {
    const response = await h(
      request(userId, `/sync/notices?limit=200${cursor ? `&cursor=${cursor}` : ""}`),
    );
    expect(response.status, await response.clone().text()).toBe(200);
    const read = await json(response);
    return {
      notices: (read.notices as RelayNotice[]).filter((row) => row.kind === "chat-message"),
      nextCursor: String(read.nextCursor),
    };
  };
  return {
    storage,
    h,
    ownerSays,
    ownerAppends,
    ownerWrite,
    member,
    bindPush,
    notices,
    page,
    pushes,
  };
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

  it("writes no Notice and no push for a member in a hidden Group, and still tells an admin", async () => {
    const s = await seed();
    await s.member("ana");
    const ben = await s.member("ben");
    expect(
      (await post(s.h, OWNER, `/sync/${WORKSPACE}/members/${ben.memberId}/role`, { role: "admin" }))
        .status,
    ).toBe(200);
    const hidden = await s.h(
      request(OWNER, `/sync/${WORKSPACE}/members/groups/${EVENTS}/rule`, {
        ...jsonBody({ level: "none" }),
        method: "PUT",
      }),
    );
    expect(hidden.status, await hidden.clone().text()).toBe(200);
    s.bindPush("ana");
    await s.ownerSays("hidden", "t-events", "@Ana @Ben the surprise is on Friday");
    expect(await s.notices("ana")).toEqual([]);
    expect(s.pushes("ana")).toEqual([]);
    expect((await s.notices("ben")).map((row) => row.title)).toEqual([
      "Kim mentioned you in #events",
    ]);
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

describe("a Notice a member can no longer read", () => {
  it("leaves a member nothing of a mention in a Group once it is hidden, and keeps an admin's and the owner's", async () => {
    const s = await seed();
    const ana = await s.member("ana");
    const ben = await s.member("ben");
    expect(
      (await post(s.h, OWNER, `/sync/${WORKSPACE}/members/${ben.memberId}/role`, { role: "admin" }))
        .status,
    ).toBe(200);
    await ana.says("ask", "t-events", "@Kim are we on?");
    await s.ownerSays("plan", "t-events", "@Ana @Ben the surprise is on Friday");
    const held = await s.page("ana");
    expect(JSON.stringify(held.notices)).toContain("#events");
    const ben0 = await s.notices("ben");
    const owner0 = await s.notices(OWNER);
    expect(ben0).toHaveLength(1);
    expect(owner0).toHaveLength(1);

    const hidden = await s.h(
      request(OWNER, `/sync/${WORKSPACE}/members/groups/${EVENTS}/rule`, {
        ...jsonBody({ level: "none" }),
        method: "PUT",
      }),
    );
    expect(hidden.status, await hidden.clone().text()).toBe(200);

    // Ana is still a member, and holds no row with a path.
    for (const [name, read] of [
      ["fresh", await s.page("ana")],
      ["after the held cursor", await s.page("ana", held.nextCursor)],
    ] as const) {
      const text = JSON.stringify(read.notices);
      expect(text, name).not.toContain("#events");
      expect(text, name).not.toContain("surprise");
      expect(read.notices, name).toEqual([
        expect.objectContaining({
          title: "dohc could not find this chat.",
          body: "",
          target: null,
        }),
      ]);
    }
    expect(await s.notices("ben")).toEqual(ben0);
    expect(await s.notices(OWNER)).toEqual(owner0);
  });

  it.each(["the folder is hidden", "the file moves into a hidden folder"] as const)(
    "leaves a member nothing of a mention in a file's Comments once %s",
    async (how) => {
      const s = await seed();
      await s.member("cara");
      await s.ownerWrite("object-budget", "Plans/Budget.md", "totals");
      await s.ownerWrite("object-private-rule", "Private/access.yaml", "");
      await s.ownerAppends({
        opKind: "chat.thread.create",
        payload: {
          threadId: "t-budget",
          title: "",
          createdAtMs: 3,
          linkedAtMs: 3,
          linkedObjectId: "object-budget",
        },
      });
      await s.ownerSays("c1", "t-budget", "@Cara the totals are off");
      const held = await s.page("cara");
      expect(JSON.stringify(held.notices), how).toContain("Budget");

      if (how === "the folder is hidden") {
        await s.ownerWrite("object-plans-rule", "Plans/access.yaml", "");
      } else {
        await s.ownerWrite("object-budget", "Private/Budget.md", "totals");
      }

      for (const [name, read] of [
        ["fresh", await s.page("cara")],
        ["after the held cursor", await s.page("cara", held.nextCursor)],
      ] as const) {
        const text = JSON.stringify(read.notices);
        expect(text, `${how}, ${name}`).not.toContain("Budget");
        expect(text, `${how}, ${name}`).not.toContain("totals are off");
        expect(read.notices, `${how}, ${name}`).toEqual([
          expect.objectContaining({
            title: "dohc could not find this chat.",
            body: "",
            target: null,
          }),
        ]);
      }
    },
  );
});

describe("a deleted message's Notices", () => {
  const page = async (s: Awaited<ReturnType<typeof seed>>, userId: string, query = "") => {
    const response = await s.h(request(userId, `/sync/notices?limit=200${query}`));
    expect(response.status, await response.clone().text()).toBe(200);
    return (await json(response)) as { notices: RelayNotice[]; nextCursor: string };
  };
  const remove = (
    s: Awaited<ReturnType<typeof seed>>,
    as: string,
    messageId: string,
    threadId: string,
  ) => post(s.h, as, `/sync/${WORKSPACE}/chat/messages/${messageId}/delete`, { threadId });
  const storedBodies = (s: Awaited<ReturnType<typeof seed>>) =>
    s.storage.db
      .prepare("SELECT * FROM sync_relay_notices")
      .all()
      .map((row) => JSON.stringify(row));

  it("removes each recipient's Notice, moves the head a parked read waits on, and keeps no copy of the body", async () => {
    const s = await seed();
    await s.member("ana");
    const bo = await s.member("bo");
    const held = (await page(s, "ana")).nextCursor;
    await bo.says("ask", "t-quiet", "@Ana @Kim the secret plan");
    const caughtUp = (await page(s, "ana")).nextCursor;
    expect((await s.notices("ana")).map((row) => row.target?.message)).toEqual(["ask"]);
    expect((await s.notices(OWNER)).map((row) => row.target?.message)).toEqual(["ask"]);

    // A parked read wakes when the head it compares moves.
    const head = s.storage.noticeHead("ana");
    expect((await remove(s, "bo", "ask", "t-quiet")).status).toBe(200);
    expect(s.storage.noticeHead("ana")).not.toBe(head);
    expect((await page(s, "ana", `&cursor=${encodeURIComponent(caughtUp)}`)).notices).toEqual([
      expect.objectContaining({ removed: true, body: "" }),
    ]);
    expect(await s.notices("ana")).toEqual([]);
    expect(await s.notices(OWNER)).toEqual([]);
    expect((await page(s, "ana", `&cursor=${encodeURIComponent(held)}`)).notices).toEqual([
      expect.objectContaining({ removed: true, body: "" }),
    ]);
    expect(storedBodies(s).some((row) => row.includes("secret plan"))).toBe(false);
  });

  it("removes the Notice of the owner's own message, which the owner's engine pushed", async () => {
    const s = await seed();
    await s.member("ana");
    await s.ownerSays("hey", "t-events", "@Ana the secret plan");
    expect((await s.notices("ana")).map((row) => row.target?.message)).toEqual(["hey"]);
    expect((await remove(s, OWNER, "hey", "t-events")).status).toBe(200);
    expect(await s.notices("ana")).toEqual([]);
    expect(storedBodies(s).some((row) => row.includes("secret plan"))).toBe(false);
  });
});
