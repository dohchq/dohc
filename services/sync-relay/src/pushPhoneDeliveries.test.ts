import { createECDH } from "node:crypto";
import { AGENT_CHANNEL_WIRE_ID } from "@dohc/security-contract/chat-wire-ids";
import { accountDeletionIdentity } from "@dohc/workspace-auth/accountDeletion";
import { afterEach, expect, it, vi } from "vitest";
import { phoneCanShow } from "./chatMessageInterest";
import { readPushConfig } from "./pushConfig";
import { createPushSender, type PushTransport } from "./pushSender";
import { fenceAccount, initializeAccountDeletion } from "./storage/accountDeletion";
import type { StorageContext } from "./storage/context";
import type { PostNoticeInput } from "./storage/notices";
import {
  claimPushDelivery,
  finishPushDelivery,
  nextPushDeliveryAt,
  PUSH_DELIVERY_EXPIRY_MS,
  PUSH_SENDER_ATTEMPTS_PER_MINUTE,
  recordNoticePushDeliveries,
} from "./storage/pushDeliveries";
import {
  chatChannelCreate,
  chatMessageAppend,
  chatThreadCreate,
  closeTestStorage,
  closeTestStorages,
  inspectDatabase,
  moment,
  putBlob,
  reopenTestStorage,
  sequenced,
  storagePath,
  testHandler,
  testStorage,
  type ChatOp,
} from "./testing";

const W = "workspace";
const DELETION_KEY = "account-deletion-key-at-least-32-bytes";
const vapid = createECDH("prime256v1");
vapid.generateKeys();
const config = readPushConfig({
  DOHC_RELAY_PUSH_VAPID_PUBLIC_KEY: vapid.getPublicKey().toString("base64url"),
  DOHC_RELAY_PUSH_VAPID_PRIVATE_KEY: Buffer.concat([Buffer.alloc(32), vapid.getPrivateKey()])
    .subarray(-32)
    .toString("base64url"),
  DOHC_RELAY_PUSH_VAPID_SUBJECT: "mailto:push@example.test",
  DOHC_RELAY_PUSH_HOSTS: "push.example.test",
})!;

afterEach(async () => {
  vi.restoreAllMocks();
  await closeTestStorages();
});

/**
 * The owner's workspace with a channel, a DM, and an agent chat, a share of
 * the channel to Alice, and the owner's phone, named Kim. `browsers` turns
 * browser push on too.
 */
async function fixture(options: { browsers?: boolean } = {}) {
  const storage = (await testStorage({
    apnsConfigured: true,
    pushConfigured: options.browsers ?? false,
  })) as StorageContext;
  storage.claimWorkspace({ workspaceId: W, ownerUserId: "owner", createdAtMs: 1 });
  const append = (ops: ChatOp[], originId: string) =>
    storage.appendLogBatch({
      workspaceId: W,
      originId,
      ops: sequenced(ops, storage.maxOriginSeq(W, originId) + 1).map(({ payload, ...op }) => ({
        ...op,
        payloadJson: JSON.stringify(payload),
      })),
    });
  append(
    [
      chatChannelCreate("team", {
        kind: "channel",
        name: "Team",
        type: "both",
        folderPath: "team",
      }),
      chatChannelCreate("direct", { kind: "dm", name: "Alice" }),
      // Only the reserved agent wire id makes a chat an agent's.
      chatChannelCreate(AGENT_CHANNEL_WIRE_ID, { kind: "agent", name: "Claude" }),
      chatThreadCreate("team-thread", "team"),
      chatThreadCreate("dm-thread", "direct"),
      chatThreadCreate("agent-thread", AGENT_CHANNEL_WIRE_ID),
    ],
    "owner",
  );
  storage.createShare({
    share: {
      shareId: "share",
      workspaceId: W,
      granterUserId: "owner",
      createdAtMs: 1,
      selectorJson: JSON.stringify({ kind: "chat", channelWireId: "team" }),
      labels: { subjectName: "Team" },
    },
    grant: {
      grantId: "grant",
      shareId: "share",
      principalKind: "user",
      principalUserId: "alice",
      principalEmail: null,
      access: "read-write",
      generation: 1,
      status: "active",
      createdAtMs: 1,
      revokedAtMs: null,
      parentGrantId: null,
    },
  });
  const phone = (userId: string, accountName: string) =>
    storage.bindPushDevice({
      userId,
      sessionId: `${userId}-phone`,
      sessionExpiresAtMs: Date.now() + 1_000_000,
      token: (userId === "owner" ? "ab" : "cd").repeat(32),
      environment: "sandbox",
      topic: "com.example.phone",
      accountName,
      nowMs: Date.now(),
    }).generation;
  let browsers = 0;
  const browser = (userId: string, accountName: string) =>
    storage.bindPushSubscription({
      installationId: `installation-00000000${++browsers}`,
      userId,
      sessionId: `${userId}-browser-${browsers}`,
      sessionExpiresAtMs: Date.now() + 1_000_000,
      endpoint: `https://push.example.test/send/${browsers}`,
      p256dh: `B${"a".repeat(86)}`,
      auth: "a".repeat(22),
      vapidKeyId: config.keyId,
      browserExpiresAtMs: null,
      nowMs: Date.now(),
      accountName,
    });
  const generation = phone("owner", "Kim");
  return {
    storage,
    generation,
    append,
    phone,
    browser,
    say(author: string, messageId: string, threadId: string, body: string, extra = {}) {
      append(
        [chatMessageAppend(messageId, threadId, body, { authorUserId: author, ...extra })],
        author,
      );
    },
    agent(messageId: string, threadId: string, body = "Done.") {
      append(
        [
          chatMessageAppend(messageId, threadId, body, {
            authorUserId: "owner",
            authorKind: "agent",
            authorDisplayName: "Claude",
          }),
        ],
        "owner-agent",
      );
    },
    notice(messageId: string, threadId: string, nowMs = Date.now(), noticeId = "agent-run:1") {
      const input: PostNoticeInput = {
        noticeId,
        recipientUserId: "owner",
        reach: { workspaceId: W },
        kind: "agent-run",
        title: "Your agent finished",
        body: "",
        target: { thread: threadId, message: messageId },
        originInstallId: "install-a",
        senderUserId: "owner",
        senderLabel: "Claude",
        nowMs,
      };
      storage.postNotice(input);
    },
    rows: () => storage.db.prepare("SELECT * FROM sync_relay_push_deliveries ORDER BY rowid").all(),
    phoneRows: () =>
      storage.db
        .prepare(
          "SELECT * FROM sync_relay_push_deliveries WHERE installation_id IS NULL ORDER BY rowid",
        )
        .all(),
    arrivedAt: (messageId: string) =>
      Number(
        storage.db
          .prepare("SELECT arrived_at_ms FROM sync_relay_push_arrivals WHERE message_id = ?")
          .get(messageId)?.arrived_at_ms,
      ),
  };
}

it.each([
  ["mention", "team-thread"],
  ["dm", "dm-thread"],
  ["reply", "team-thread"],
  ["agent", "agent-thread"],
] as const)("alerts the owner's phone for a %s", async (reason, threadId) => {
  const f = await fixture();
  if (reason === "reply") f.say("owner", "prior", threadId, "Who has the tickets?");
  if (reason === "agent") f.agent("message", threadId);
  else f.say("alice", "message", threadId, reason === "mention" ? "@Kim I do" : "I do");
  expect(f.rows()).toEqual([
    expect.objectContaining({
      account_user_id: "owner",
      installation_id: null,
      generation: f.generation,
      message_id: "message",
      reason,
      state: "pending",
      sender_key: reason === "agent" ? "user:owner" : "user:alice",
    }),
  ]);
});

it("matches a mention by the phone's own account name", async () => {
  const f = await fixture();
  f.storage.db.prepare("DELETE FROM sync_relay_push_device_names").run();
  f.say("alice", "message", "team-thread", "@Kim I do");
  expect(f.rows()).toEqual([]);
  f.phone("owner", "Kim");
  f.say("alice", "again", "team-thread", "@Kim I do");
  expect(f.phoneRows()).toEqual([expect.objectContaining({ message_id: "again" })]);
});

it("alerts a share grantee's browser but never their phone", async () => {
  const f = await fixture({ browsers: true });
  f.phone("alice", "Alice");
  f.browser("alice", "Alice");
  f.say("owner", "message", "team-thread", "@Alice can you book it?");
  expect(f.rows()).toEqual([
    expect.objectContaining({
      account_user_id: "alice",
      installation_id: "installation-000000001",
    }),
  ]);
});

it("queues nothing for the phone of a workspace with Show on phone off", async () => {
  const f = await fixture({ browsers: true });
  f.browser("owner", "Kim");
  f.storage.setShowOnPhone({ ownerUserId: "owner", workspaceId: W, showOnPhone: false });
  f.say("alice", "message", "team-thread", "@Kim I do");
  f.agent("answer", "team-thread");
  f.notice("answer", "team-thread");
  expect(f.phoneRows()).toEqual([]);
  // The browser still alerts as it always has.
  expect(f.rows()).toEqual([expect.objectContaining({ message_id: "message", reason: "mention" })]);
});

it.each([
  ["stays at docs/plan.md", 1],
  ["moves to docs/.env.local", 0],
] as const)("for a chat whose file %s, queues %i phone alerts", async (move, count) => {
  const f = await fixture();
  await putBlob(testHandler(f.storage), "owner", W, "plan");
  f.append(
    [
      moment("docs/plan.md", "plan", { objectId: "plan" }),
      chatThreadCreate("file-thread", "", {
        channelWireId: null,
        channelSlug: null,
        linkedObjectId: "plan",
        linkedAtMs: 2,
      }),
    ],
    "owner",
  );
  if (count === 0)
    f.append(
      [
        moment("docs/.env.local", "plan", {
          objectId: "plan",
          operation: "rename",
          beforePath: "docs/plan.md",
          beforeContent: "plan",
        }),
      ],
      "owner",
    );
  f.say("alice", "message", "file-thread", "@Kim see this");
  expect(f.phoneRows(), move).toHaveLength(count);
});

it.each(["account", "workspace"] as const)(
  "queues nothing for a phone once the %s is being deleted",
  async (deleted) => {
    const f = await fixture();
    f.agent("answer", "team-thread");
    expect(phoneCanShow(f.storage, "owner", W, "team-thread")).toBe(true);
    initializeAccountDeletion(f.storage, DELETION_KEY);
    if (deleted === "account") fenceAccount(f.storage, DELETION_KEY, "owner", "owner@dohc.test");
    else
      f.storage.db
        .prepare("INSERT INTO sync_relay_deleted_workspaces VALUES (?)")
        .run(accountDeletionIdentity(DELETION_KEY, `workspace:${W}`));
    expect(phoneCanShow(f.storage, "owner", W, "team-thread")).toBe(false);
    f.storage.tx(() =>
      recordNoticePushDeliveries(f.storage, {
        userId: "owner",
        workspaceId: W,
        threadId: "team-thread",
        messageId: "answer",
        noticeId: "agent-run:1",
        nowMs: Date.now(),
      }),
    );
    expect(f.rows()).toEqual([]);
  },
);

it("gives one alert when the message arrives before its run Notice", async () => {
  const f = await fixture();
  f.agent("answer", "agent-thread");
  f.notice("answer", "agent-thread");
  expect(f.rows()).toEqual([
    expect.objectContaining({ message_id: "answer", reason: "agent", notice_id: "agent-run:1" }),
  ]);
});

it("gives one alert when the run Notice arrives before its message", async () => {
  const f = await fixture();
  f.notice("answer", "agent-thread");
  expect(f.rows()).toEqual([
    expect.objectContaining({ message_id: "answer", relay_seq: null, state: "pending" }),
  ]);
  const now = Date.now();
  // Waiting for its message, it is due only to expire.
  expect(claimPushDelivery(f.storage, now)).toBeNull();
  expect(nextPushDeliveryAt(f.storage, now)).toBe(Number(f.rows()[0]!.expires_at_ms));
  f.agent("answer", "agent-thread");
  expect(f.rows()).toEqual([
    expect.objectContaining({
      message_id: "answer",
      relay_seq: expect.any(Number),
      state: "pending",
      reason: "agent",
      notice_id: "agent-run:1",
    }),
  ]);
  expect(claimPushDelivery(f.storage, Date.now())).toMatchObject({ noticeId: "agent-run:1" });
});

it("alerts for a message on its own when the run Notice that waited for it isn't its agent's", async () => {
  const f = await fixture();
  f.notice("answer", "team-thread");
  f.say("alice", "answer", "team-thread", "@Kim not your agent");
  expect(f.rows()).toEqual([
    expect.objectContaining({
      message_id: "answer",
      reason: "mention",
      state: "pending",
      notice_id: null,
    }),
  ]);
});

it.each([
  ["live", 60_000],
  ["expired", 0],
] as const)(
  "when a %s run Notice's message arrives, keeps the alert for the newest message",
  async (wait, leftMs) => {
    const f = await fixture();
    f.notice("answer", "team-thread");
    f.storage.db
      .prepare("UPDATE sync_relay_push_deliveries SET expires_at_ms = ? WHERE relay_seq IS NULL")
      .run(Date.now() + leftMs);
    f.say("alice", "mention", "team-thread", "@Kim one");
    f.agent("answer", "team-thread");
    if (wait === "live")
      // The reply is fresh from its own arrival, not from when the Notice came.
      expect(f.rows()).toEqual([
        expect.objectContaining({
          message_id: "answer",
          state: "pending",
          expires_at_ms: f.arrivedAt("answer") + PUSH_DELIVERY_EXPIRY_MS,
        }),
        expect.objectContaining({ message_id: "mention", state: "dropped" }),
      ]);
    // An expired wait can't replace the mention, and nothing alerts for it.
    else
      expect(f.rows()).toEqual([
        expect.objectContaining({ message_id: "mention", state: "pending" }),
      ]);
  },
);

it("alerts for a message on its own after the sender swept its run Notice's expired wait", async () => {
  const f = await fixture();
  f.notice("answer", "team-thread");
  f.storage.db
    .prepare("UPDATE sync_relay_push_deliveries SET expires_at_ms = ? WHERE relay_seq IS NULL")
    .run(Date.now() - 1);
  // The sender marks the expired wait dropped; nothing is sendable yet.
  expect(claimPushDelivery(f.storage, Date.now())).toBeNull();
  f.say("alice", "answer", "team-thread", "@Kim the reply");
  expect(f.rows()).toEqual([
    expect.objectContaining({
      message_id: "answer",
      reason: "mention",
      state: "pending",
      notice_id: null,
    }),
  ]);
});

it("doesn't let a late run Notice for an older message replace a newer alert", async () => {
  const f = await fixture();
  f.agent("older", "team-thread");
  f.say("alice", "newer", "team-thread", "@Kim two");
  f.notice("older", "team-thread");
  expect(f.rows().map((row) => [row.message_id, row.state])).toEqual([
    ["newer", "pending"],
    ["older", "dropped"],
  ]);
});

it("forgets a deleted account as a sender in the rate counts", async () => {
  const f = await fixture();
  f.say("alice", "message", "team-thread", "@Kim I do");
  expect(claimPushDelivery(f.storage, Date.now())).not.toBeNull();
  const senders = () =>
    f.storage.db.prepare("SELECT sender_key FROM sync_relay_push_sender_rate").all();
  expect(senders()).toEqual([{ sender_key: "user:alice" }]);
  initializeAccountDeletion(f.storage, DELETION_KEY);
  fenceAccount(f.storage, DELETION_KEY, "alice", "alice@dohc.test");
  expect(senders()).toEqual([]);
});

it("keeps only a thread's newest pending phone alert", async () => {
  const f = await fixture();
  f.say("alice", "first", "team-thread", "@Kim one");
  f.say("alice", "second", "team-thread", "@Kim two");
  f.say("alice", "direct", "dm-thread", "three");
  expect(f.rows().map((row) => [row.message_id, row.state])).toEqual([
    ["first", "dropped"],
    ["second", "pending"],
    ["direct", "pending"],
  ]);
  // A Notice's late reply is the newest.
  f.notice("answer", "team-thread");
  f.agent("answer", "team-thread");
  expect(f.rows().map((row) => [row.message_id, row.state])).toEqual([
    ["first", "dropped"],
    ["second", "dropped"],
    ["direct", "pending"],
    ["answer", "pending"],
  ]);
});

it("times a run Notice's alert from the server's first append, not the author's clock", async () => {
  const f = await fixture();
  // The author's recorded time is from 1970; only the arrival counts.
  f.agent("answer", "team-thread");
  expect(f.rows()).toEqual([]);
  const arrivedAt = f.arrivedAt("answer");
  f.notice("answer", "team-thread", arrivedAt + 60_000);
  expect(f.rows()).toEqual([
    expect.objectContaining({ expires_at_ms: arrivedAt + PUSH_DELIVERY_EXPIRY_MS }),
  ]);
  f.agent("late", "team-thread");
  f.notice("late", "team-thread", f.arrivedAt("late") + PUSH_DELIVERY_EXPIRY_MS, "agent-run:2");
  // A message the relay has no arrival for is too old to alert.
  f.agent("forgotten", "agent-thread");
  f.storage.db
    .prepare("DELETE FROM sync_relay_push_deliveries WHERE message_id = 'forgotten'")
    .run();
  f.storage.db.prepare("DELETE FROM sync_relay_push_arrivals WHERE message_id = 'forgotten'").run();
  f.notice("forgotten", "agent-thread", Date.now(), "agent-run:3");
  expect(f.rows().map((row) => row.message_id)).toEqual(["answer"]);
});

it(`caps one sender at ${PUSH_SENDER_ATTEMPTS_PER_MINUTE} phone alerts a minute to one recipient`, async () => {
  const f = await fixture();
  const threads = Array.from({ length: PUSH_SENDER_ATTEMPTS_PER_MINUTE + 1 }, (_, n) => `t${n}`);
  f.append(
    threads.map((id) => chatThreadCreate(id, "team")),
    "owner",
  );
  for (const id of threads) f.say("alice", `m-${id}`, id, "@Kim ping");
  f.append([chatThreadCreate("bob-thread", "team")], "owner");
  f.say("bob", "from-bob", "bob-thread", "@Kim hello");
  const message = (delivery: { deliveryId: string } | null) =>
    delivery && f.rows().find((row) => row.delivery_id === delivery.deliveryId)?.message_id;
  const now = Date.now();
  const nextMinute = (Math.floor(now / 60_000) + 1) * 60_000;
  const claimed: unknown[] = [];
  for (let n = 0; n <= PUSH_SENDER_ATTEMPTS_PER_MINUTE; n++) {
    const delivery = claimPushDelivery(f.storage, now)!;
    claimed.push(message(delivery));
    finishPushDelivery(f.storage, delivery, "sent", now);
  }
  // Alice's seventh waits; Bob's later message still reaches the same phone.
  expect(claimed).toEqual([...threads.slice(0, -1).map((id) => `m-${id}`), "from-bob"]);
  expect(claimPushDelivery(f.storage, now)).toBeNull();
  expect(nextPushDeliveryAt(f.storage, now)).toBe(nextMinute);
  expect(message(claimPushDelivery(f.storage, nextMinute))).toBe(`m-${threads.at(-1)}`);
});

it("leases one delivery per recipient at a time, the longest-waiting recipient first", async () => {
  const f = await fixture({ browsers: true });
  f.browser("owner", "Kim");
  f.browser("alice", "Alice");
  f.storage.db.prepare("DELETE FROM sync_relay_push_subscriptions WHERE kind = 'apns'").run();
  f.append(
    ["o1", "o2", "a1", "a2"].map((id) => chatThreadCreate(id, "team")),
    "owner",
  );
  f.say("bob", "o1", "o1", "@Kim one");
  f.say("bob", "o2", "o2", "@Kim two");
  f.say("bob", "a1", "a1", "@Alice one");
  f.say("bob", "a2", "a2", "@Alice two");
  const message = (delivery: { deliveryId: string } | null) =>
    delivery && f.rows().find((row) => row.delivery_id === delivery.deliveryId)?.message_id;
  const now = Date.now();
  const first = claimPushDelivery(f.storage, now)!;
  expect(message(first)).toBe("o1");
  finishPushDelivery(f.storage, first, "sent", now);
  // Alice has waited longer than the owner, whose o2 is older.
  const second = claimPushDelivery(f.storage, now + 1)!;
  expect(message(second)).toBe("a1");
  const third = claimPushDelivery(f.storage, now + 1)!;
  expect(message(third)).toBe("o2");
  // Both recipients are busy, so a2 waits though it is due.
  expect(claimPushDelivery(f.storage, now + 1)).toBeNull();
  finishPushDelivery(f.storage, second, "sent", now + 1);
  expect(message(claimPushDelivery(f.storage, now + 1))).toBe("a2");
});

it("keeps browser alerts as they were: no own-agent reason, no sender cap, no phone rows sent", async () => {
  const f = await fixture({ browsers: true });
  f.browser("owner", "Kim");
  f.agent("answer", "agent-thread");
  expect(f.rows().map((row) => [row.installation_id, row.reason])).toEqual([[null, "agent"]]);
  const threads = Array.from({ length: PUSH_SENDER_ATTEMPTS_PER_MINUTE + 1 }, (_, n) => `t${n}`);
  f.append(
    threads.map((id) => chatThreadCreate(id, "team")),
    "owner",
  );
  for (const id of threads) f.say("alice", `m-${id}`, id, "@Kim ping");
  const now = Date.now();
  for (let n = 0; n < threads.length; n++) {
    const delivery = claimPushDelivery(f.storage, now, { native: false });
    expect(delivery?.installationId).toBe("installation-000000001");
    finishPushDelivery(f.storage, delivery!, "sent", now);
  }
  expect(claimPushDelivery(f.storage, now, { native: false })).toBeNull();

  // The browser sender leaves phone alerts queued, and wakes for them only to expire them.
  const transport = vi.fn<PushTransport>(async () => 201);
  const sender = createPushSender({
    storage: f.storage,
    config,
    transport,
    lookup: async () => [{ address: "8.8.8.8", family: 4 }],
    lookupAccountName: () => "Kim",
    sessionIsValid: async () => true,
    resolveAlertLink: () => "/l/opaque-reference",
  });
  expect(await sender.runOnce()).toBe(false);
  await sender.close();
  expect(transport).not.toHaveBeenCalled();
  const phoneRows = f.phoneRows().filter((row) => row.state === "pending");
  expect(phoneRows.length).toBeGreaterThan(0);
  expect(nextPushDeliveryAt(f.storage, now, Number.MAX_SAFE_INTEGER)).toBe(
    Math.min(...phoneRows.map((row) => Number(row.expires_at_ms))),
  );
});

it("keeps queued browser deliveries through the phone upgrade", async () => {
  const f = await fixture({ browsers: true });
  f.browser("owner", "Kim");
  f.storage.db.prepare("DELETE FROM sync_relay_push_subscriptions WHERE kind = 'apns'").run();
  f.say("alice", "message", "team-thread", "@Kim I do");
  const path = storagePath(f.storage);
  closeTestStorage(f.storage);
  // Put the deliveries back as the browser-only schema left them.
  const db = inspectDatabase(path, { foreignKeys: true });
  db.exec(`CREATE TABLE previous AS SELECT * FROM sync_relay_push_deliveries;
    DROP TABLE sync_relay_push_deliveries; DROP TABLE sync_relay_push_sender_rate;
    DROP TABLE sync_relay_push_device_names; DROP TABLE sync_relay_push_arrivals;
    CREATE TABLE sync_relay_push_deliveries (
    delivery_id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL REFERENCES sync_relay_workspaces(workspace_id) ON DELETE CASCADE,
    thread_id TEXT NOT NULL, message_id TEXT NOT NULL, relay_seq INTEGER NOT NULL,
    account_user_id TEXT NOT NULL, installation_id TEXT NOT NULL,
    generation INTEGER NOT NULL, reason TEXT NOT NULL CHECK (reason IN ('mention','dm','reply')),
    state TEXT NOT NULL CHECK (state IN ('pending','sent','dropped')),
    attempts INTEGER NOT NULL CHECK (attempts BETWEEN 0 AND 5),
    created_at_ms INTEGER NOT NULL, expires_at_ms INTEGER NOT NULL,
    available_at_ms INTEGER NOT NULL, last_attempt_at_ms INTEGER,
    lease_token TEXT, lease_until_ms INTEGER,
    UNIQUE (workspace_id, thread_id, message_id, installation_id, generation)
  ) STRICT;
    CREATE INDEX idx_push_deliveries_due ON sync_relay_push_deliveries(state, available_at_ms);
    CREATE INDEX idx_push_deliveries_recipient ON sync_relay_push_deliveries(account_user_id, state, last_attempt_at_ms);
    INSERT INTO sync_relay_push_deliveries SELECT delivery_id, workspace_id, thread_id, message_id, relay_seq,
      account_user_id, installation_id, generation, reason, state, attempts, created_at_ms, expires_at_ms,
      available_at_ms, last_attempt_at_ms, lease_token, lease_until_ms FROM previous;
    DROP TABLE previous;
    DELETE FROM sync_relay_migrations WHERE migration_id = 'push-native-deliveries-v1';`);
  db.close();
  const reopened = reopenTestStorage(path) as StorageContext;
  expect(
    reopened.db
      .prepare("SELECT message_id, sender_key, notice_id FROM sync_relay_push_deliveries")
      .all(),
  ).toEqual([{ message_id: "message", sender_key: "", notice_id: null }]);
  expect(claimPushDelivery(reopened, Date.now() + 1)).toMatchObject({
    installationId: "installation-000000001",
  });
});
