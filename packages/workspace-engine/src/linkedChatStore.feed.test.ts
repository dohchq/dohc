import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SyncReplicationEnvelope } from "@dohc/workspace-contracts/engine";
import {
  CHAT_MESSAGES_CANONICAL_ORDER_INDEX,
  closeTrackedEngineDbHandlesForTest,
} from "./engineDbSchema";
import {
  CHAT_FILE_MENTION_MAX_RESULTS,
  LINKED_CHAT_STORE_RELATIVE_PATH,
  createLinkedChatStore,
} from "./linkedChatStore";
import { applySyncQueues } from "./syncApply";
import { exportSyncBundle } from "./syncFolder";

interface RawSqliteStatement {
  all(...params: unknown[]): Array<Record<string, unknown>>;
  run(...params: unknown[]): { changes: number };
}

interface RawSqliteDb {
  exec(sql: string): void;
  prepare(sql: string): RawSqliteStatement;
  close(): void;
}

const requireModule = createRequire(import.meta.url);
const { DatabaseSync } = requireModule("node:sqlite") as {
  DatabaseSync: {
    new (path: string): RawSqliteDb;
    prototype: Pick<RawSqliteDb, "prepare">;
  };
};

let root: string;
let now: number;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "dohc-feed-"));
  now = 1_000;
});

afterEach(async () => {
  closeTrackedEngineDbHandlesForTest();
  await rm(root, { recursive: true, force: true });
});

function storeAt(path = root) {
  return createLinkedChatStore(path, {
    nowMs: () => ++now,
  });
}

function cursorFor(message: { id: string; createdAtMs: number }): string {
  return Buffer.from(JSON.stringify([message.createdAtMs, message.id]), "utf8").toString(
    "base64url",
  );
}

function receiverStateReplicationOps(): SyncReplicationEnvelope[] {
  const db = new DatabaseSync(join(root, LINKED_CHAT_STORE_RELATIVE_PATH));
  try {
    return db
      .prepare(
        `SELECT workspace_id, origin_id, origin_seq, op_kind, payload_json, recorded_at_ms
         FROM replication_log
         WHERE op_kind IN ('chat.follow.set', 'chat.feed.read.set')
         ORDER BY origin_id, origin_seq`,
      )
      .all()
      .map(
        (row) =>
          ({
            workspaceId: String(row.workspace_id),
            originId: String(row.origin_id),
            originSeq: Number(row.origin_seq),
            opKind: String(row.op_kind),
            payload: JSON.parse(String(row.payload_json)),
            recordedAtMs: Number(row.recorded_at_ms),
          }) as SyncReplicationEnvelope,
      );
  } finally {
    db.close();
  }
}

describe("personal chat Feed", () => {
  it("keeps unresolved channel placeholders out of defaults and Feed until authoritative create", async () => {
    const store = storeAt();
    const wireId = "wire-delayed-channel";
    const threadId = "thread-delayed-channel";
    await store.applyReplicationOp({
      workspaceId: "ws",
      originId: "delayed-thread-origin",
      originSeq: 0,
      opKind: "chat.thread.create",
      payload: {
        threadId,
        title: "Delayed channel thread",
        createdAtMs: 100,
        channelSlug: "delayed-channel",
        channelWireId: wireId,
      },
      recordedAtMs: 100,
    });
    await store.applyReplicationOp({
      workspaceId: "ws",
      originId: "delayed-message-origin",
      originSeq: 0,
      opKind: "chat.message.append",
      payload: {
        messageId: "message-delayed-channel",
        threadId,
        authorKind: "human",
        authorDisplayName: "Alice",
        authorUserId: "alice",
        body: "Must stay internal until the channel create arrives",
        createdAtMs: 200,
      },
      recordedAtMs: 200,
    });
    await store.ensureDefaultChannelFollows({ workspaceId: "ws", ownerUserId: "viewer" });
    await store.setFollow({
      workspaceId: "ws",
      ownerUserId: "viewer",
      targetKind: "thread",
      targetId: threadId,
      state: "following",
    });

    expect(await store.listChannels({ workspaceId: "ws" })).toEqual([]);
    expect(
      (await store.listFollows({
        workspaceId: "ws",
        ownerUserId: "viewer",
        state: "following",
      })).filter((follow) => follow.targetKind === "channel"),
    ).toEqual([]);
    expect(
      (await store.listPersonalFeed({ workspaceId: "ws", ownerUserId: "viewer" })).items,
    ).toEqual([]);

    await store.applyReplicationOp({
      workspaceId: "ws",
      originId: "delayed-channel-origin",
      originSeq: 0,
      opKind: "chat.channel.create",
      payload: {
        channelId: "remote-delayed-channel",
        name: "Delayed Channel",
        slug: "delayed-channel",
        kind: "channel",
        createdAtMs: 50,
        wireId,
      },
      recordedAtMs: 50,
    });
    await store.ensureDefaultChannelFollows({ workspaceId: "ws", ownerUserId: "viewer" });

    expect(await store.listChannels({ workspaceId: "ws" })).toEqual([
      expect.objectContaining({ name: "Delayed Channel", kind: "channel" }),
    ]);
    expect(
      await store.listFollows({
        workspaceId: "ws",
        ownerUserId: "viewer",
        state: "following",
      }),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ targetKind: "channel", targetId: wireId }),
      ]),
    );
    const feed = await store.listPersonalFeed({ workspaceId: "ws", ownerUserId: "viewer" });
    expect(feed.items).toHaveLength(1);
    expect(feed.items[0]).toMatchObject({
      message: { id: "message-delayed-channel" },
      matchedBy: ["thread", "channel"],
    });
  });

  it("keeps signed-out receiver state local and journals only a verified matching owner", async () => {
    const store = storeAt();
    const general = await store.ensureGeneralChannel({ workspaceId: "ws" });
    await store.startChannelThread({
      workspaceId: "ws",
      channelId: general.id,
      author: { kind: "human", displayName: "Alice" },
      authorUserId: "alice",
      body: "Opening post",
    });
    await store.ensureDefaultChannelFollows({
      workspaceId: "ws",
      ownerUserId: "local-fallback",
    });
    const page = await store.listPersonalFeed({
      workspaceId: "ws",
      ownerUserId: "local-fallback",
    });
    expect(page.headCursor).toBeTruthy();
    const beforeSignedOut = await exportSyncBundle({
      rootDir: root,
      workspaceId: "ws",
      toDir: join(root, "export-before-signed-out"),
    });

    await store.setFollow({
      workspaceId: "ws",
      ownerUserId: "local-fallback",
      targetKind: "person",
      targetId: "alice",
      state: "following",
    });
    await store.markPersonalFeedSeen({
      workspaceId: "ws",
      ownerUserId: "local-fallback",
      headCursor: page.headCursor!,
    });

    expect(receiverStateReplicationOps()).toEqual([]);
    expect(
      await exportSyncBundle({
        rootDir: root,
        workspaceId: "ws",
        toDir: join(root, "export-after-signed-out"),
      }),
    ).toMatchObject({ opCount: beforeSignedOut.opCount });
    expect(
      await store.listFollows({ workspaceId: "ws", ownerUserId: "local-fallback" }),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ targetKind: "person", targetId: "alice" }),
      ]),
    );
    expect(
      (await store.listPersonalFeed({ workspaceId: "ws", ownerUserId: "local-fallback" }))
        .readState,
    ).toMatchObject({ lastSeenMessageId: page.items[0]?.message.id });

    await expect(
      store.setFollow({
        workspaceId: "ws",
        ownerUserId: "local-fallback",
        replicationOwnerUserId: "user-a",
        targetKind: "person",
        targetId: "alice",
        state: "unfollowed",
      }),
    ).rejects.toThrow("Replication feed owner must match");

    await store.setFollow({
      workspaceId: "ws",
      ownerUserId: "user-a",
      replicationOwnerUserId: "user-a",
      targetKind: "person",
      targetId: "alice",
      state: "following",
    });
    await store.markPersonalFeedSeen({
      workspaceId: "ws",
      ownerUserId: "user-a",
      replicationOwnerUserId: "user-a",
      headCursor: page.headCursor!,
    });

    expect(receiverStateReplicationOps()).toEqual([
      expect.objectContaining({
        opKind: "chat.follow.set",
        payload: expect.objectContaining({ ownerUserId: "user-a" }),
      }),
      expect.objectContaining({
        opKind: "chat.feed.read.set",
        payload: expect.objectContaining({ ownerUserId: "user-a" }),
      }),
    ]);
    expect(
      await exportSyncBundle({
        rootDir: root,
        workspaceId: "ws",
        toDir: join(root, "export-after-signed-in"),
      }),
    ).toMatchObject({ opCount: beforeSignedOut.opCount + 2 });
  });

  it("derives a deduplicated, paginated Feed from channel, author, and thread follows", async () => {
    const store = storeAt();
    const general = await store.ensureGeneralChannel({ workspaceId: "ws" });
    const dm = await store.createChannel({ workspaceId: "ws", name: "Private", kind: "dm" });
    await store.ensureDefaultChannelFollows({ workspaceId: "ws", ownerUserId: "viewer" });

    const started = await store.startChannelThread({
      workspaceId: "ws",
      channelId: general.id,
      author: { kind: "human", displayName: "Alice" },
      authorUserId: "alice",
      body: "Opening post",
      attachments: [{ objectId: "object-opening", pathHint: "docs/opening.md" }],
    });
    const reply = await store.sendMessage({
      workspaceId: "ws",
      threadId: started.thread.id,
      author: { kind: "human", displayName: "Alice" },
      authorUserId: "alice",
      parentMessageId: started.message.id,
      body: "A reply",
      attachments: [{ objectId: "object-reply", pathHint: "docs/reply.md" }],
    });
    const replyReaction = await store.setReaction({
      workspaceId: "ws",
      threadId: started.thread.id,
      messageId: reply.id,
      emoji: "👍",
      author: { authorId: "viewer", kind: "human", displayName: "Viewer" },
      state: "added",
    });
    await store.startChannelThread({
      workspaceId: "ws",
      channelId: dm.id,
      author: { kind: "human", displayName: "Alice" },
      authorUserId: "alice",
      body: "DM must stay out of Feed",
    });

    const channelOnly = await store.listPersonalFeed({
      workspaceId: "ws",
      ownerUserId: "viewer",
    });
    expect(channelOnly.items.map((item) => item.message.body)).toEqual(["Opening post"]);
    expect(channelOnly.items[0]?.matchedBy).toEqual(["channel"]);

    await store.setFollow({
      workspaceId: "ws",
      ownerUserId: "viewer",
      targetKind: "person",
      targetId: "alice",
      state: "following",
    });
    await store.setFollow({
      workspaceId: "ws",
      ownerUserId: "viewer",
      targetKind: "thread",
      targetId: started.thread.id,
      state: "following",
    });

    const feedPrepare = vi.spyOn(DatabaseSync.prototype, "prepare");
    const first = await (async () => {
      try {
        const page = await store.listPersonalFeed({
          workspaceId: "ws",
          ownerUserId: "viewer",
          limit: 1,
        });
        expect(feedPrepare.mock.calls.length).toBeLessThanOrEqual(12);
        return page;
      } finally {
        feedPrepare.mockRestore();
      }
    })();
    expect(first.items).toHaveLength(1);
    expect(first.items[0]?.message.id).toBe(reply.id);
    expect(first.items[0]?.message.attachments).toEqual([
      expect.objectContaining({ objectId: "object-reply" }),
    ]);
    expect(first.items[0]?.matchedBy).toEqual(["person", "thread"]);
    expect(first.items[0]?.parentMessage?.id).toBe(started.message.id);
    expect(first.items[0]?.parentMessage?.attachments).toEqual([
      expect.objectContaining({ objectId: "object-opening" }),
    ]);
    expect(first.items[0]?.openingMessage).toEqual(first.items[0]?.parentMessage);
    expect(first.items[0]?.reactions).toEqual([replyReaction]);
    expect(first.nextCursor).toBeTruthy();
    expect(first.headCursor).toBeTruthy();

    const second = await store.listPersonalFeed({
      workspaceId: "ws",
      ownerUserId: "viewer",
      cursor: first.nextCursor,
      limit: 1,
    });
    expect(second.items.map((item) => item.message.id)).toEqual([started.message.id]);
    expect(second.items[0]?.matchedBy).toEqual(["person", "thread", "channel"]);

    const read = await store.markPersonalFeedSeen({
      workspaceId: "ws",
      ownerUserId: "viewer",
      headCursor: first.headCursor!,
    });
    expect(read.lastSeenMessageId).toBe(reply.id);
    expect(
      (await store.listPersonalFeed({ workspaceId: "ws", ownerUserId: "viewer" })).readState,
    ).toMatchObject({ lastSeenMessageId: reply.id });
  });

  it("uses the canonical earliest message for feed opening context and channel follows", async () => {
    const firstRoot = await mkdtemp(join(tmpdir(), "dohc-feed-opening-a-"));
    const secondRoot = await mkdtemp(join(tmpdir(), "dohc-feed-opening-b-"));
    const runScenario = async (path: string, arrival: Array<"older" | "newer">) => {
      const store = storeAt(path);
      try {
        const channel = await store.ensureGeneralChannel({ workspaceId: "ws" });
        const started = await store.startChannelThread({
          workspaceId: "ws",
          channelId: channel.id,
          author: { kind: "human", displayName: "Local" },
          body: "Local arrival-order opening",
        });
        await store.ensureDefaultChannelFollows({ workspaceId: "ws", ownerUserId: "viewer" });
        const envelopes = {
          older: {
            workspaceId: "ws",
            originId: "remote-older",
            originSeq: 0,
            opKind: "chat.message.append",
            payload: {
              messageId: "remote-older",
              threadId: started.thread.id,
              authorKind: "human",
              authorDisplayName: "Alice",
              authorUserId: "alice",
              body: "Canonical opening",
              createdAtMs: 100,
            },
            recordedAtMs: 100,
          },
          newer: {
            workspaceId: "ws",
            originId: "remote-newer",
            originSeq: 0,
            opKind: "chat.message.append",
            payload: {
              messageId: "remote-newer",
              threadId: started.thread.id,
              authorKind: "human",
              authorDisplayName: "Alice",
              authorUserId: "alice",
              body: "Newer remote",
              createdAtMs: 200,
            },
            recordedAtMs: 200,
          },
        } satisfies Record<"older" | "newer", SyncReplicationEnvelope>;
        for (const key of arrival) await store.applyReplicationOp(envelopes[key]);
        await store.setFollow({
          workspaceId: "ws",
          ownerUserId: "viewer",
          targetKind: "person",
          targetId: "alice",
          state: "following",
        });
        const page = await store.listPersonalFeed({ workspaceId: "ws", ownerUserId: "viewer" });
        const summaries = await store.listChannelThreads({
          workspaceId: "ws",
          channelId: channel.id,
        });
        return { page, summary: summaries[0] };
      } finally {
        await store.close();
      }
    };

    try {
      const olderFirst = await runScenario(firstRoot, ["older", "newer"]);
      const newerFirst = await runScenario(secondRoot, ["newer", "older"]);
      for (const result of [olderFirst, newerFirst]) {
        expect(result.page.items.map((item) => item.message.body)).toEqual([
          "Newer remote",
          "Canonical opening",
        ]);
        expect(result.page.items[0]?.openingMessage?.id).toBe("remote-older");
        expect(result.page.items[0]?.matchedBy).toEqual(["person"]);
        expect(result.page.items[1]?.openingMessage).toBeUndefined();
        expect(result.page.items[1]?.matchedBy).toEqual(["person", "channel"]);
        expect(result.summary?.openingMessage?.id).toBe("remote-older");
      }
    } finally {
      await rm(firstRoot, { recursive: true, force: true });
      await rm(secondRoot, { recursive: true, force: true });
    }
  });

  it("upgrades and uses the covering index for canonical opening lookup", async () => {
    let store = storeAt();
    const channel = await store.ensureGeneralChannel({ workspaceId: "ws" });
    const started = await store.startChannelThread({
      workspaceId: "ws",
      channelId: channel.id,
      author: { kind: "human", displayName: "Ice" },
      body: "Opening",
    });
    await store.close();

    const legacyDb = new DatabaseSync(join(root, LINKED_CHAT_STORE_RELATIVE_PATH));
    try {
      legacyDb.exec(`DROP INDEX IF EXISTS ${CHAT_MESSAGES_CANONICAL_ORDER_INDEX}`);
    } finally {
      legacyDb.close();
    }

    store = storeAt();
    try {
      await store.listMessages({ workspaceId: "ws", threadId: started.thread.id });
      const planDb = new DatabaseSync(join(root, LINKED_CHAT_STORE_RELATIVE_PATH));
      try {
        const plan = planDb
          .prepare(
            `EXPLAIN QUERY PLAN
             SELECT first.message_id FROM chat_messages first
             WHERE first.workspace_id = ? AND first.thread_id = ?
             ORDER BY first.created_at_ms, first.message_id LIMIT 1`,
          )
          .all("ws", started.thread.id)
          .map((row) => String(row.detail));
        const canonicalIndexStep = plan.find((detail) =>
          detail.includes(CHAT_MESSAGES_CANONICAL_ORDER_INDEX),
        );
        expect(canonicalIndexStep).toContain("USING COVERING INDEX");
      } finally {
        planDb.close();
      }
    } finally {
      await store.close();
    }
  });

  it("rejects read cursors for unfollowed messages and DMs", async () => {
    const store = storeAt();
    const updates = await store.createChannel({
      workspaceId: "ws",
      name: "Updates",
      kind: "channel",
    });
    const publicStarted = await store.startChannelThread({
      workspaceId: "ws",
      channelId: updates.id,
      author: { kind: "human", displayName: "Alice" },
      authorUserId: "alice",
      body: "Visible while Alice is followed",
    });
    await store.setFollow({
      workspaceId: "ws",
      ownerUserId: "viewer",
      targetKind: "person",
      targetId: "alice",
      state: "following",
    });
    const visible = await store.listPersonalFeed({
      workspaceId: "ws",
      ownerUserId: "viewer",
    });
    expect(visible.headCursor).toBe(cursorFor(publicStarted.message));

    await store.setFollow({
      workspaceId: "ws",
      ownerUserId: "viewer",
      targetKind: "person",
      targetId: "alice",
      state: "unfollowed",
    });
    await expect(
      store.markPersonalFeedSeen({
        workspaceId: "ws",
        ownerUserId: "viewer",
        headCursor: visible.headCursor!,
      }),
    ).rejects.toThrow("stale or no longer visible");

    const dm = await store.createChannel({
      workspaceId: "ws",
      name: "Private",
      kind: "dm",
    });
    const privateStarted = await store.startChannelThread({
      workspaceId: "ws",
      channelId: dm.id,
      author: { kind: "human", displayName: "Alice" },
      authorUserId: "alice",
      body: "Private message",
    });
    await store.setFollow({
      workspaceId: "ws",
      ownerUserId: "viewer",
      targetKind: "person",
      targetId: "alice",
      state: "following",
    });
    await expect(
      store.markPersonalFeedSeen({
        workspaceId: "ws",
        ownerUserId: "viewer",
        headCursor: cursorFor(privateStarted.message),
      }),
    ).rejects.toThrow("stale or no longer visible");
    expect(
      (await store.listPersonalFeed({ workspaceId: "ws", ownerUserId: "viewer" }))
        .readState,
    ).toBeUndefined();
  });

  it("retains unfollow tombstones and default seeding never resurrects them", async () => {
    const store = storeAt();
    const general = await store.ensureGeneralChannel({ workspaceId: "ws" });
    await store.ensureDefaultChannelFollows({ workspaceId: "ws", ownerUserId: "viewer" });
    const wireId = await store.getChannelWireId({ workspaceId: "ws", channelId: general.id });
    expect(wireId).toBeTruthy();

    await store.setFollow({
      workspaceId: "ws",
      ownerUserId: "viewer",
      targetKind: "channel",
      targetId: wireId!,
      state: "unfollowed",
    });
    await store.ensureDefaultChannelFollows({ workspaceId: "ws", ownerUserId: "viewer" });

    expect(await store.listFollows({ workspaceId: "ws", ownerUserId: "viewer" })).toEqual([
      expect.objectContaining({ targetId: wireId, state: "unfollowed" }),
    ]);
  });

  it("converges receiver-owned follow and read registers across origins", async () => {
    const aRoot = await mkdtemp(join(tmpdir(), "dohc-feed-a-"));
    const bRoot = await mkdtemp(join(tmpdir(), "dohc-feed-b-"));
    const a = storeAt(aRoot);
    const b = storeAt(bRoot);
    const follow = (originId: string, state: "following" | "unfollowed"): SyncReplicationEnvelope => ({
      workspaceId: "ws",
      originId,
      originSeq: 0,
      opKind: "chat.follow.set",
      payload: {
        ownerUserId: "viewer",
        targetKind: "thread",
        targetId: "thread-1",
        state,
        atMs: 10,
      },
      recordedAtMs: 10,
    });
    const read = (originId: string, messageId: string): SyncReplicationEnvelope => ({
      workspaceId: "ws",
      originId,
      originSeq: 0,
      opKind: "chat.feed.read.set",
      payload: {
        ownerUserId: "viewer",
        lastSeenCreatedAtMs: 20,
        lastSeenMessageId: messageId,
        atMs: 20,
      },
      recordedAtMs: 20,
    });

    await a.applyReplicationOp(follow("origin-a", "following"));
    await a.applyReplicationOp(follow("origin-b", "unfollowed"));
    await b.applyReplicationOp(follow("origin-b", "unfollowed"));
    await b.applyReplicationOp(follow("origin-a", "following"));
    await a.applyReplicationOp(read("origin-c", "message-a"));
    await a.applyReplicationOp(read("origin-d", "message-b"));
    await b.applyReplicationOp(read("origin-d", "message-b"));
    await b.applyReplicationOp(read("origin-c", "message-a"));

    expect(await a.listFollows({ workspaceId: "ws", ownerUserId: "viewer" })).toEqual(
      await b.listFollows({ workspaceId: "ws", ownerUserId: "viewer" }),
    );
    expect((await a.listFollows({ workspaceId: "ws", ownerUserId: "viewer" }))[0]?.state).toBe(
      "unfollowed",
    );
    // Both stores accepted the same winner even though arrival order differed.
    const rowA = await a.listPersonalFeed({ workspaceId: "ws", ownerUserId: "viewer" });
    const rowB = await b.listPersonalFeed({ workspaceId: "ws", ownerUserId: "viewer" });
    expect(rowA.readState).toEqual(rowB.readState);
    expect(rowA.readState?.lastSeenMessageId).toBe("message-b");

    await a.close();
    await b.close();
    await rm(aRoot, { recursive: true, force: true });
    await rm(bRoot, { recursive: true, force: true });
  });

  it("does not regress a feed read boundary when a stale cursor arrives last", async () => {
    const aRoot = await mkdtemp(join(tmpdir(), "dohc-feed-read-a-"));
    const bRoot = await mkdtemp(join(tmpdir(), "dohc-feed-read-b-"));
    const a = storeAt(aRoot);
    const b = storeAt(bRoot);
    const fresh: SyncReplicationEnvelope = {
      workspaceId: "ws",
      originId: "origin-fresh",
      originSeq: 0,
      opKind: "chat.feed.read.set",
      payload: {
        ownerUserId: "viewer",
        lastSeenCreatedAtMs: 30,
        lastSeenMessageId: "message-new",
        atMs: 10,
      },
      recordedAtMs: 10,
    };
    const stale: SyncReplicationEnvelope = {
      workspaceId: "ws",
      originId: "origin-stale",
      originSeq: 0,
      opKind: "chat.feed.read.set",
      payload: {
        ownerUserId: "viewer",
        lastSeenCreatedAtMs: 20,
        lastSeenMessageId: "message-old",
        // Wall-clock and replication metadata deliberately favor this stale
        // operation so only feed-coordinate ordering can prevent regression.
        atMs: 999,
      },
      recordedAtMs: 999,
    };

    await a.applyReplicationOp(fresh);
    await a.applyReplicationOp(stale);
    await b.applyReplicationOp(stale);
    await b.applyReplicationOp(fresh);

    const rowA = await a.listPersonalFeed({ workspaceId: "ws", ownerUserId: "viewer" });
    const rowB = await b.listPersonalFeed({ workspaceId: "ws", ownerUserId: "viewer" });
    expect(rowA.readState).toEqual(rowB.readState);
    expect(rowA.readState).toMatchObject({
      lastSeenCreatedAtMs: 30,
      lastSeenMessageId: "message-new",
    });

    await a.close();
    await b.close();
    await rm(aRoot, { recursive: true, force: true });
    await rm(bRoot, { recursive: true, force: true });
  });

  it("routes Feed receiver-state through the merged sync apply pipeline", async () => {
    const result = await applySyncQueues({
      rootDir: root,
      workspaceId: "ws",
      queues: [[
        {
          workspaceId: "ws",
          originId: "remote",
          originSeq: 0,
          opKind: "chat.follow.set",
          payload: {
            ownerUserId: "viewer",
            targetKind: "thread",
            targetId: "thread-remote",
            state: "following",
            atMs: 10,
          },
          recordedAtMs: 10,
        },
        {
          workspaceId: "ws",
          originId: "remote",
          originSeq: 1,
          opKind: "chat.feed.read.set",
          payload: {
            ownerUserId: "viewer",
            lastSeenCreatedAtMs: 9,
            lastSeenMessageId: "message-remote",
            atMs: 11,
          },
          recordedAtMs: 11,
        },
      ]],
      blobSource: async () => {
        throw new Error("Feed ops are blob-free");
      },
    });
    expect(result).toMatchObject({ applied: 2, skipped: 0 });
    const store = storeAt();
    expect(await store.listFollows({ workspaceId: "ws", ownerUserId: "viewer" })).toEqual([
      expect.objectContaining({ targetId: "thread-remote", state: "following" }),
    ]);
    expect(
      (await store.listPersonalFeed({ workspaceId: "ws", ownerUserId: "viewer" })).readState,
    ).toMatchObject({ lastSeenMessageId: "message-remote" });
  });
});

describe("chat file section mentions", () => {
  it("round-trips heading metadata and lists inverse file mentions newest-first", async () => {
    const store = storeAt();
    const channel = await store.ensureGeneralChannel({ workspaceId: "ws" });
    const first = await store.startChannelThread({
      workspaceId: "ws",
      channelId: channel.id,
      author: { kind: "human", displayName: "Ice" },
      body: "See the pricing assumptions.",
      attachments: [
        {
          objectId: "object-plan",
          pathHint: "docs/plan.md",
          headingText: "Pricing assumptions",
          headingAnchor: "pricing-assumptions",
          headingOccurrence: 0,
        },
        { objectId: "object-brief", pathHint: "docs/brief.md" },
      ],
    });
    await store.sendMessage({
      workspaceId: "ws",
      threadId: first.thread.id,
      author: { kind: "human", displayName: "Ice" },
      body: "Whole file too.",
      attachments: [{ objectId: "object-plan", pathHint: "docs/plan.md" }],
    });

    const mentionPrepare = vi.spyOn(DatabaseSync.prototype, "prepare");
    const mentions = await (async () => {
      try {
        const result = await store.listFileMentions({
          workspaceId: "ws",
          objectId: "object-plan",
        });
        expect(mentionPrepare.mock.calls.length).toBeLessThanOrEqual(6);
        return result;
      } finally {
        mentionPrepare.mockRestore();
      }
    })();
    expect(mentions.map((mention) => mention.message.body)).toEqual([
      "Whole file too.",
      "See the pricing assumptions.",
    ]);
    expect(mentions[1]?.attachment).toMatchObject({
      headingText: "Pricing assumptions",
      headingAnchor: "pricing-assumptions",
      headingOccurrence: 0,
    });
    expect(mentions[1]?.message.attachments).toHaveLength(2);
    expect(mentions[1]?.message.attachments.map((attachment) => attachment.objectId)).toEqual(
      expect.arrayContaining(["object-plan", "object-brief"]),
    );
    expect(mentions[1]?.channel?.id).toBe(channel.id);
  });

  it("caps inverse mentions before hydration while retaining the newest results", async () => {
    const store = storeAt();
    const channel = await store.ensureGeneralChannel({ workspaceId: "ws" });
    const started = await store.startChannelThread({
      workspaceId: "ws",
      channelId: channel.id,
      author: { kind: "human", displayName: "Ice" },
      body: "Opening",
    });
    const totalMentions = CHAT_FILE_MENTION_MAX_RESULTS + 1;
    const db = new DatabaseSync(join(root, LINKED_CHAT_STORE_RELATIVE_PATH));
    try {
      db.exec("BEGIN IMMEDIATE");
      const insertMessage = db.prepare(
        `INSERT INTO chat_messages (
           workspace_id, thread_id, message_order, message_id, author_kind,
           author_display_name, body, created_at_ms
         ) VALUES (?, ?, ?, ?, 'human', 'Ice', ?, ?)`,
      );
      const insertAttachment = db.prepare(
        `INSERT INTO chat_attachments (
           workspace_id, attachment_id, thread_id, message_id, target_kind,
           object_id, path_hint, created_at_ms
         ) VALUES (?, ?, ?, ?, 'file', 'object-cap', 'docs/cap.md', ?)`,
      );
      for (let index = 0; index < totalMentions; index += 1) {
        const suffix = index.toString().padStart(4, "0");
        const messageId = `message-cap-${suffix}`;
        const createdAtMs = 10_000 + index;
        insertMessage.run(
          "ws",
          started.thread.id,
          index + 1,
          messageId,
          `Mention ${index}`,
          createdAtMs,
        );
        insertAttachment.run(
          "ws",
          `attachment-cap-${suffix}`,
          started.thread.id,
          messageId,
          createdAtMs,
        );
      }
      db.exec("COMMIT");
    } catch (error) {
      try {
        db.exec("ROLLBACK");
      } catch {}
      throw error;
    } finally {
      db.close();
    }

    const mentionPrepare = vi.spyOn(DatabaseSync.prototype, "prepare");
    const mentions = await (async () => {
      try {
        const result = await store.listFileMentions({
          workspaceId: "ws",
          objectId: "object-cap",
        });
        expect(mentionPrepare.mock.calls.length).toBeLessThanOrEqual(6);
        return result;
      } finally {
        mentionPrepare.mockRestore();
      }
    })();
    expect(mentions).toHaveLength(CHAT_FILE_MENTION_MAX_RESULTS);
    expect(mentions[0]?.message.body).toBe(`Mention ${totalMentions - 1}`);
    expect(mentions.at(-1)?.message.body).toBe("Mention 1");
    expect(mentions.some((mention) => mention.message.body === "Mention 0")).toBe(false);
  });
});

describe("workspace-backed chat bookmarks", () => {
  it("persists desired state and enforces generation-checked projection transitions", async () => {
    let store = storeAt();
    const channel = await store.ensureGeneralChannel({ workspaceId: "ws" });
    const started = await store.startChannelThread({
      workspaceId: "ws",
      channelId: channel.id,
      author: { kind: "human", displayName: "Ice" },
      body: "Bookmark this post",
    });
    const saved = await store.saveBookmark({
      workspaceId: "ws",
      ownerUserId: "viewer",
      targetKind: "thread",
      targetId: started.thread.id,
      mode: "live",
      destinationPath: "Bookmarks/Chats/bookmark-this-post.md",
    });
    expect(saved).toMatchObject({
      generation: 1,
      projectedGeneration: 0,
      projectionState: "pending",
      state: "active",
    });
    expect(await store.listPendingBookmarks({ workspaceId: "ws", ownerUserId: "viewer" })).toHaveLength(1);

    const ready = await store.markBookmarkReady({
      workspaceId: "ws",
      ownerUserId: "viewer",
      bookmarkId: saved.bookmarkId,
      generation: 1,
      projectedAtMs: 2_000,
    });
    expect(ready).toMatchObject({
      applied: true,
      bookmark: { projectionState: "ready", projectedGeneration: 1, lastProjectedAtMs: 2_000 },
    });
    const lateDuplicateFailure = await store.markBookmarkFailed({
      workspaceId: "ws",
      ownerUserId: "viewer",
      bookmarkId: saved.bookmarkId,
      generation: 1,
      failureReason: "late duplicate worker",
    });
    expect(lateDuplicateFailure).toMatchObject({
      applied: false,
      bookmark: { projectionState: "ready" },
    });
    expect(lateDuplicateFailure.bookmark).not.toHaveProperty("failureReason");

    await store.sendMessage({
      workspaceId: "ws",
      threadId: started.thread.id,
      author: { kind: "human", displayName: "Ice" },
      body: "New live context",
    });
    const pending = await store.findBookmark({
      workspaceId: "ws",
      ownerUserId: "viewer",
      bookmarkId: saved.bookmarkId,
    });
    expect(pending).toMatchObject({ generation: 2, projectionState: "pending" });

    const obsolete = await store.markBookmarkReady({
      workspaceId: "ws",
      ownerUserId: "viewer",
      bookmarkId: saved.bookmarkId,
      generation: 1,
    });
    expect(obsolete).toMatchObject({
      applied: false,
      bookmark: { generation: 2, projectionState: "pending" },
    });

    expect(
      await store.markBookmarkFailed({
        workspaceId: "ws",
        ownerUserId: "viewer",
        bookmarkId: saved.bookmarkId,
        generation: 2,
        failureReason: "disk unavailable",
      }),
    ).toMatchObject({
      applied: true,
      bookmark: { projectionState: "failed", failureReason: "disk unavailable" },
    });
    const retried = await store.markBookmarkPending({
      workspaceId: "ws",
      ownerUserId: "viewer",
      bookmarkId: saved.bookmarkId,
    });
    expect(retried).toMatchObject({ generation: 3, projectionState: "pending" });
    expect(
      await store.markBookmarkStale({
        workspaceId: "ws",
        ownerUserId: "viewer",
        bookmarkId: saved.bookmarkId,
        generation: 3,
        failureReason: "source access revoked",
      }),
    ).toMatchObject({
      applied: true,
      bookmark: { projectionState: "stale", failureReason: "source access revoked" },
    });

    const resaved = await store.saveBookmark({
      workspaceId: "ws",
      ownerUserId: "viewer",
      targetKind: "thread",
      targetId: started.thread.id,
      mode: "live",
      destinationPath: "Research/Saved discussion.md",
    });
    expect(resaved).toMatchObject({
      bookmarkId: saved.bookmarkId,
      destinationPath: "Research/Saved discussion.md",
      generation: 4,
      projectionState: "pending",
    });
    const archived = await store.archiveBookmark({
      workspaceId: "ws",
      ownerUserId: "viewer",
      bookmarkId: saved.bookmarkId,
    });
    expect(archived).toMatchObject({
      state: "archived",
      generation: 5,
      projectedGeneration: 1,
      projectionState: "pending",
    });
    expect(
      await store.listPendingBookmarks({ workspaceId: "ws", ownerUserId: "viewer" }),
    ).toMatchObject([{ bookmarkId: saved.bookmarkId, state: "archived", generation: 5 }]);
    await store.close();
    store = storeAt();
    expect(
      await store.listPendingBookmarks({ workspaceId: "ws", ownerUserId: "viewer" }),
    ).toMatchObject([{ bookmarkId: saved.bookmarkId, state: "archived", generation: 5 }]);
    const lateArchivedReady = await store.markBookmarkReady({
      workspaceId: "ws",
      ownerUserId: "viewer",
      bookmarkId: saved.bookmarkId,
      generation: 4,
    });
    expect(lateArchivedReady).toMatchObject({
      applied: false,
      bookmark: { state: "archived", projectionState: "pending", generation: 5 },
    });
    const lateArchivedFailure = await store.markBookmarkFailed({
      workspaceId: "ws",
      ownerUserId: "viewer",
      bookmarkId: saved.bookmarkId,
      generation: 4,
      failureReason: "late archived projection",
    });
    expect(lateArchivedFailure).toMatchObject({
      applied: false,
      bookmark: { state: "archived", projectionState: "pending", generation: 5 },
    });
    expect(lateArchivedFailure.bookmark).not.toHaveProperty("failureReason");
    expect(
      await store.markBookmarkStale({
        workspaceId: "ws",
        ownerUserId: "viewer",
        bookmarkId: saved.bookmarkId,
        generation: 4,
        failureReason: "late stale worker",
      }),
    ).toMatchObject({
      applied: false,
      bookmark: { state: "archived", projectionState: "pending", generation: 5 },
    });
    expect(
      await store.markBookmarkReady({
        workspaceId: "ws",
        ownerUserId: "viewer",
        bookmarkId: saved.bookmarkId,
        generation: 5,
      }),
    ).toMatchObject({
      applied: true,
      bookmark: {
        state: "archived",
        projectionState: "ready",
        generation: 5,
        projectedGeneration: 5,
      },
    });
    expect(
      await store.listPendingBookmarks({ workspaceId: "ws", ownerUserId: "viewer" }),
    ).toEqual([]);
    await expect(
      store.markBookmarkReady({
        workspaceId: "ws",
        ownerUserId: "viewer",
        bookmarkId: saved.bookmarkId,
        generation: 0,
      }),
    ).rejects.toMatchObject({ code: "invalid-bookmark-target" });
    expect(await store.listBookmarks({ workspaceId: "ws", ownerUserId: "viewer", state: "active" })).toEqual([]);
    expect(await store.listBookmarks({ workspaceId: "ws", ownerUserId: "viewer", state: "archived" })).toHaveLength(1);
  });

  it("keeps snapshots ready while local and replicated appends requeue live bookmarks", async () => {
    const store = storeAt();
    const channel = await store.ensureGeneralChannel({ workspaceId: "ws" });
    const started = await store.startChannelThread({
      workspaceId: "ws",
      channelId: channel.id,
      author: { kind: "human", displayName: "Ice" },
      body: "Opening",
    });
    const live = await store.saveBookmark({
      workspaceId: "ws",
      ownerUserId: "viewer",
      targetKind: "thread",
      targetId: started.thread.id,
      mode: "live",
      destinationPath: "Bookmarks/Chats/live.md",
    });
    const snapshot = await store.saveBookmark({
      workspaceId: "ws",
      ownerUserId: "viewer",
      targetKind: "message",
      targetId: started.message.id,
      mode: "snapshot",
      destinationPath: "Bookmarks/Chats/snapshot.md",
    });
    await store.markBookmarkReady({
      workspaceId: "ws",
      ownerUserId: "viewer",
      bookmarkId: live.bookmarkId,
      generation: 1,
    });
    await store.markBookmarkReady({
      workspaceId: "ws",
      ownerUserId: "viewer",
      bookmarkId: snapshot.bookmarkId,
      generation: 1,
    });

    await store.applyReplicationOp({
      workspaceId: "ws",
      originId: "remote",
      originSeq: 0,
      opKind: "chat.message.append",
      payload: {
        messageId: "remote-message",
        threadId: started.thread.id,
        authorKind: "human",
        authorDisplayName: "Alice",
        body: "Replicated update",
        createdAtMs: 9_000,
      },
      recordedAtMs: 9_000,
    });

    expect(
      await store.findBookmark({
        workspaceId: "ws",
        ownerUserId: "viewer",
        bookmarkId: live.bookmarkId,
      }),
    ).toMatchObject({ generation: 2, projectionState: "pending" });
    expect(
      await store.findBookmark({
        workspaceId: "ws",
        ownerUserId: "viewer",
        bookmarkId: snapshot.bookmarkId,
      }),
    ).toMatchObject({ generation: 1, projectionState: "ready" });

    await store.markBookmarkReady({
      workspaceId: "ws",
      ownerUserId: "viewer",
      bookmarkId: live.bookmarkId,
      generation: 2,
    });
    await store.applyReplicationOp({
      workspaceId: "ws",
      originId: "remote",
      originSeq: 1,
      opKind: "chat.attachment.add",
      payload: {
        attachmentId: "remote-attachment",
        threadId: started.thread.id,
        messageId: "remote-message",
        targetKind: "file",
        pathHint: "docs/remote-plan.md",
        createdAtMs: 9_001,
      },
      recordedAtMs: 9_001,
    });

    expect(
      await store.findBookmark({
        workspaceId: "ws",
        ownerUserId: "viewer",
        bookmarkId: live.bookmarkId,
      }),
    ).toMatchObject({ generation: 3, projectionState: "pending" });
    expect(
      await store.findBookmark({
        workspaceId: "ws",
        ownerUserId: "viewer",
        bookmarkId: snapshot.bookmarkId,
      }),
    ).toMatchObject({ generation: 1, projectionState: "ready" });
  });
});
