import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  findMentions,
  type MentionCandidate,
} from "@dohc/workspace-contracts/chat-mentions";
import type { LinkedChatStore, SyncReplicationEnvelope } from "@dohc/workspace-contracts/engine";
import { afterEach, describe, expect, it } from "vitest";
import { parseMentionHandles } from "./chatMentions";
import { closeTrackedEngineDbHandlesForTest } from "./engineDbSchema";
import { AGENT_CHANNEL_WIRE_ID, LINKED_CHAT_STORE_RELATIVE_PATH, createLinkedChatStore } from "./linkedChatStore";

interface RawSqliteStatement {
  all(...params: unknown[]): Array<Record<string, unknown>>;
  get(...params: unknown[]): Record<string, unknown> | undefined;
  run(...params: unknown[]): unknown;
}

interface RawSqliteDb {
  prepare(sql: string): RawSqliteStatement;
  close(): void;
}

interface TestEngine {
  root: string;
  store: LinkedChatStore;
}

const requireModule = createRequire(import.meta.url);
const { DatabaseSync } = requireModule("node:sqlite") as {
  DatabaseSync: new (path: string) => RawSqliteDb;
};

const WORKSPACE_ID = "workspace-phase1";
const engines: TestEngine[] = [];

afterEach(async () => {
  const closing = engines.splice(0);
  for (const engine of closing) await engine.store.close();
  closeTrackedEngineDbHandlesForTest();
  for (const engine of closing) {
    await rm(engine.root, { recursive: true, force: true });
  }
});

async function makeEngine(label: string, tickMs = 10): Promise<TestEngine> {
  const root = await mkdtemp(join(tmpdir(), `dohc-chat-phase1-${label}-`));
  const counters = { channel: 0, message: 0, thread: 0 };
  let clock = 1000;
  const store = createLinkedChatStore(root, {
    nowMs: () => {
      clock += tickMs;
      return clock;
    },
    createId: (kind) => {
      counters[kind] += 1;
      return `${label}-${kind}-${counters[kind]}`;
    },
  });
  const engine = { root, store };
  engines.push(engine);
  return engine;
}

function rawDbFor<T>(engine: TestEngine, read: (db: RawSqliteDb) => T): T {
  const db = new DatabaseSync(join(engine.root, LINKED_CHAT_STORE_RELATIVE_PATH));
  try {
    return read(db);
  } finally {
    db.close();
  }
}

function replicationOps(engine: TestEngine): SyncReplicationEnvelope[] {
  return rawDbFor(engine, (db) =>
    db
      .prepare(
        `SELECT workspace_id, origin_id, origin_seq, op_kind, payload_json, recorded_at_ms
         FROM replication_log ORDER BY origin_id, origin_seq`,
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
      ),
  );
}

function messageEnvelope(input: {
  originId: string;
  originSeq?: number;
  threadId: string;
  messageId: string;
  body: string;
  createdAtMs: number;
  parentMessageId?: string;
  origin?: "cli";
}): SyncReplicationEnvelope {
  return {
    workspaceId: WORKSPACE_ID,
    originId: input.originId,
    originSeq: input.originSeq ?? 0,
    opKind: "chat.message.append",
    payload: {
      messageId: input.messageId,
      threadId: input.threadId,
      authorKind: "human",
      authorDisplayName: "Peer",
      ...(input.parentMessageId !== undefined ? { parentMessageId: input.parentMessageId } : {}),
      ...(input.origin !== undefined ? { origin: input.origin } : {}),
      body: input.body,
      createdAtMs: input.createdAtMs,
    },
    recordedAtMs: input.createdAtMs,
  };
}

function decisionEnvelope(input: {
  originId: string;
  originSeq?: number;
  state: "open" | "resolved";
  atMs: number;
}): SyncReplicationEnvelope {
  return {
    workspaceId: WORKSPACE_ID,
    originId: input.originId,
    originSeq: input.originSeq ?? 0,
    opKind: "chat.decision.set",
    payload: {
      threadId: "thread-decision",
      messageId: "message-decision",
      state: input.state,
      ...(input.state === "resolved" ? { resolvedByMessageId: "message-resolution" } : {}),
      atMs: input.atMs,
    },
    recordedAtMs: input.atMs,
  };
}

describe("phase-one linked chat model", () => {
  it("round-trips CLI origin locally and omits it from ordinary message ops", async () => {
    const engine = await makeEngine("cli-origin-local");
    const channel = await engine.store.ensureGeneralChannel({
      workspaceId: WORKSPACE_ID,
    });
    const started = await engine.store.startChannelThread({
      workspaceId: WORKSPACE_ID,
      channelId: channel.id,
      author: { kind: "human", displayName: "You" },
      origin: "cli",
      body: "CLI opening",
    });
    const cliReply = await engine.store.sendMessage({
      workspaceId: WORKSPACE_ID,
      threadId: started.thread.id,
      author: { kind: "agent", displayName: "Your agent" },
      origin: "cli",
      body: "CLI reply",
    });
    const ordinaryReply = await engine.store.sendMessage({
      workspaceId: WORKSPACE_ID,
      threadId: started.thread.id,
      author: { kind: "human", displayName: "You" },
      body: "Ordinary reply",
    });

    expect(started.message.origin).toBe("cli");
    expect(cliReply.origin).toBe("cli");
    expect(ordinaryReply.origin).toBeUndefined();
    expect(
      (
        await engine.store.listMessages({
          workspaceId: WORKSPACE_ID,
          threadId: started.thread.id,
        })
      ).map((message) => message.origin),
    ).toEqual(["cli", "cli", undefined]);
    expect(
      rawDbFor(engine, (db) =>
        db
          .prepare(
            "SELECT origin FROM chat_messages WHERE workspace_id = ? AND thread_id = ? ORDER BY message_order",
          )
          .all(WORKSPACE_ID, started.thread.id)
          .map((row) => row.origin),
      ),
    ).toEqual(["cli", "cli", null]);

    const messageOps = replicationOps(engine).filter(
      (op) => op.opKind === "chat.message.append",
    );
    expect(messageOps.map((op) => op.payload.origin)).toEqual(["cli", "cli", undefined]);
    expect(Object.prototype.hasOwnProperty.call(messageOps[2]?.payload, "origin")).toBe(false);
  });

  it("replicates CLI origin and preserves legacy messages without it", async () => {
    const source = await makeEngine("cli-origin-source");
    const receiver = await makeEngine("cli-origin-receiver");
    const channel = await source.store.ensureGeneralChannel({
      workspaceId: WORKSPACE_ID,
    });
    const started = await source.store.startChannelThread({
      workspaceId: WORKSPACE_ID,
      channelId: channel.id,
      author: { kind: "human", displayName: "You" },
      origin: "cli",
      body: "CLI opening",
    });
    const cliReply = await source.store.sendMessage({
      workspaceId: WORKSPACE_ID,
      threadId: started.thread.id,
      author: { kind: "agent", displayName: "Your agent" },
      origin: "cli",
      body: "CLI reply",
    });
    for (const op of replicationOps(source)) await receiver.store.applyReplicationOp(op);

    await receiver.store.applyReplicationOp(
      messageEnvelope({
        originId: "origin-legacy-message",
        threadId: started.thread.id,
        messageId: "legacy-message-without-origin",
        body: "Legacy wire payload",
        createdAtMs: cliReply.createdAtMs + 100,
      }),
    );
    const messages = await receiver.store.listMessages({
      workspaceId: WORKSPACE_ID,
      threadId: started.thread.id,
    });
    expect(messages.find((message) => message.id === started.message.id)?.origin).toBe("cli");
    expect(messages.find((message) => message.id === cliReply.id)?.origin).toBe("cli");
    expect(
      messages.find((message) => message.id === "legacy-message-without-origin")?.origin,
    ).toBeUndefined();
  });

  it("rejects replicated message origins other than cli", async () => {
    const engine = await makeEngine("cli-origin-validation");
    const channel = await engine.store.ensureGeneralChannel({
      workspaceId: WORKSPACE_ID,
    });
    const started = await engine.store.startChannelThread({
      workspaceId: WORKSPACE_ID,
      channelId: channel.id,
      author: { kind: "human", displayName: "You" },
      body: "Opening",
    });
    const validEnvelope = messageEnvelope({
      originId: "origin-invalid-message",
      threadId: started.thread.id,
      messageId: "message-invalid-origin",
      body: "Invalid origin",
      createdAtMs: 5000,
    });
    if (validEnvelope.opKind !== "chat.message.append") {
      throw new Error("Expected a chat message envelope.");
    }
    const invalidEnvelope = {
      ...validEnvelope,
      payload: { ...validEnvelope.payload, origin: "terminal" },
    } as unknown as SyncReplicationEnvelope;

    await expect(engine.store.applyReplicationOp(invalidEnvelope)).rejects.toMatchObject({
      code: "state-corrupt",
    });
  });

  it("defers a replicated child parent until that parent arrives in the same thread", async () => {
    const engine = await makeEngine("parents");
    const channel = await engine.store.ensureGeneralChannel({
      workspaceId: WORKSPACE_ID,
    });
    const started = await engine.store.startChannelThread({
      workspaceId: WORKSPACE_ID,
      channelId: channel.id,
      author: { kind: "human", displayName: "You" },
      body: "Opening",
    });
    const localParent = await engine.store.sendMessage({
      workspaceId: WORKSPACE_ID,
      threadId: started.thread.id,
      author: { kind: "human", displayName: "You" },
      body: "Local parent",
    });
    const localChild = await engine.store.sendMessage({
      workspaceId: WORKSPACE_ID,
      threadId: started.thread.id,
      parentMessageId: localParent.id,
      author: { kind: "human", displayName: "You" },
      body: "Local child",
    });
    expect(localChild.parentMessageId).toBe(localParent.id);

    await engine.store.applyReplicationOp(
      messageEnvelope({
        originId: "origin-child",
        threadId: started.thread.id,
        messageId: "remote-child",
        parentMessageId: "remote-parent",
        body: "Remote child",
        createdAtMs: 3000,
      }),
    );
    expect(
      (await engine.store.listMessages({
        workspaceId: WORKSPACE_ID,
        threadId: started.thread.id,
      })).find((message) => message.id === "remote-child")?.parentMessageId,
    ).toBeUndefined();
    expect(
      rawDbFor(engine, (db) =>
        Number(
          db
            .prepare(
              "SELECT COUNT(*) AS count FROM chat_pending_message_parents WHERE workspace_id = ?",
            )
            .get(WORKSPACE_ID)?.count,
        ),
      ),
    ).toBe(1);
    await engine.store.applyReplicationOp(
      messageEnvelope({
        originId: "origin-parent",
        threadId: started.thread.id,
        messageId: "remote-parent",
        body: "Remote parent",
        createdAtMs: 2000,
      }),
    );
    await engine.store.applyReplicationOp(
      messageEnvelope({
        originId: "origin-legacy",
        threadId: started.thread.id,
        messageId: "legacy-message",
        body: "No parent field",
        createdAtMs: 4000,
      }),
    );

    const messages = await engine.store.listMessages({
      workspaceId: WORKSPACE_ID,
      threadId: started.thread.id,
    });
    expect(messages.find((message) => message.id === localChild.id)?.parentMessageId).toBe(localParent.id);
    expect(messages.find((message) => message.id === "remote-child")?.parentMessageId).toBe("remote-parent");
    expect(messages.find((message) => message.id === "legacy-message")?.parentMessageId).toBeUndefined();
    expect(
      rawDbFor(engine, (db) =>
        Number(
          db
            .prepare(
              "SELECT COUNT(*) AS count FROM chat_pending_message_parents WHERE workspace_id = ?",
            )
            .get(WORKSPACE_ID)?.count,
        ),
      ),
    ).toBe(0);
  });

  it("keeps local parents strict and never activates replicated cross-thread parents", async () => {
    const engine = await makeEngine("parent-integrity");
    const channel = await engine.store.ensureGeneralChannel({ workspaceId: WORKSPACE_ID });
    const first = await engine.store.startChannelThread({
      workspaceId: WORKSPACE_ID,
      channelId: channel.id,
      author: { kind: "human", displayName: "You" },
      body: "First opening",
    });
    const second = await engine.store.startChannelThread({
      workspaceId: WORKSPACE_ID,
      channelId: channel.id,
      author: { kind: "human", displayName: "You" },
      body: "Second opening",
    });

    await expect(
      engine.store.sendMessage({
        workspaceId: WORKSPACE_ID,
        threadId: first.thread.id,
        parentMessageId: "message-does-not-exist",
        author: { kind: "human", displayName: "You" },
        body: "Missing local parent",
      }),
    ).rejects.toMatchObject({ code: "message-not-found" });
    await expect(
      engine.store.sendMessage({
        workspaceId: WORKSPACE_ID,
        threadId: second.thread.id,
        parentMessageId: first.message.id,
        author: { kind: "human", displayName: "You" },
        body: "Cross-thread local parent",
      }),
    ).rejects.toMatchObject({ code: "message-not-found" });

    await expect(
      engine.store.applyReplicationOp(
        messageEnvelope({
          originId: "origin-missing-parent",
          threadId: first.thread.id,
          messageId: "remote-missing-parent",
          parentMessageId: "message-does-not-exist",
          body: "Missing remote parent",
          createdAtMs: 5000,
        }),
      ),
    ).resolves.toMatchObject({ status: "applied" });
    expect(
      (await engine.store.listMessages({
        workspaceId: WORKSPACE_ID,
        threadId: first.thread.id,
      })).find((message) => message.id === "remote-missing-parent")?.parentMessageId,
    ).toBeUndefined();
    await expect(
      engine.store.applyReplicationOp(
        messageEnvelope({
          originId: "origin-cross-thread-parent",
          threadId: second.thread.id,
          messageId: "remote-cross-thread-parent",
          parentMessageId: first.message.id,
          body: "Cross-thread remote parent",
          createdAtMs: 5001,
        }),
      ),
    ).resolves.toMatchObject({ status: "applied" });

    await expect(
      engine.store.applyReplicationOp(
        messageEnvelope({
          originId: "origin-child-first-cross-thread",
          threadId: second.thread.id,
          messageId: "remote-child-first-cross-thread",
          parentMessageId: "future-parent-in-other-thread",
          body: "Child before cross-thread parent",
          createdAtMs: 5002,
        }),
      ),
    ).resolves.toMatchObject({ status: "applied" });
    await expect(
      engine.store.applyReplicationOp(
        messageEnvelope({
          originId: "origin-future-cross-thread-parent",
          threadId: first.thread.id,
          messageId: "future-parent-in-other-thread",
          body: "Parent materialized elsewhere",
          createdAtMs: 5003,
        }),
      ),
    ).resolves.toMatchObject({ status: "applied" });

    const secondMessages = await engine.store.listMessages({
      workspaceId: WORKSPACE_ID,
      threadId: second.thread.id,
    });
    expect(
      secondMessages.find((message) => message.id === "remote-child-first-cross-thread")
        ?.parentMessageId,
    ).toBeUndefined();
    expect(
      secondMessages.find((message) => message.id === "remote-cross-thread-parent")
        ?.parentMessageId,
    ).toBeUndefined();
    expect(
      rawDbFor(engine, (db) =>
        Number(
          db
            .prepare(
              `SELECT COUNT(*) AS count FROM chat_pending_message_parents
               WHERE workspace_id = ? AND parent_message_id = ?`,
            )
            .get(WORKSPACE_ID, "future-parent-in-other-thread")?.count,
        ),
      ),
    ).toBe(0);
  });

  it("migrates legacy unresolved parents into deferred state and removes cross-thread links", async () => {
    const engine = await makeEngine("parent-migration");
    const channel = await engine.store.ensureGeneralChannel({ workspaceId: WORKSPACE_ID });
    const first = await engine.store.startChannelThread({
      workspaceId: WORKSPACE_ID,
      channelId: channel.id,
      author: { kind: "human", displayName: "You" },
      body: "First opening",
    });
    const second = await engine.store.startChannelThread({
      workspaceId: WORKSPACE_ID,
      channelId: channel.id,
      author: { kind: "human", displayName: "You" },
      body: "Second opening",
    });
    const unresolvedChild = await engine.store.sendMessage({
      workspaceId: WORKSPACE_ID,
      threadId: second.thread.id,
      author: { kind: "human", displayName: "You" },
      body: "Legacy unresolved child",
    });
    await engine.store.close();
    rawDbFor(engine, (db) => {
      db.prepare(
        "UPDATE chat_messages SET parent_message_id = ? WHERE workspace_id = ? AND message_id = ?",
      ).run(first.message.id, WORKSPACE_ID, second.message.id);
      db.prepare(
        "UPDATE chat_messages SET parent_message_id = ? WHERE workspace_id = ? AND message_id = ?",
      ).run("future-same-thread-parent", WORKSPACE_ID, unresolvedChild.id);
    });

    engine.store = createLinkedChatStore(engine.root);
    let messages = await engine.store.listMessages({
      workspaceId: WORKSPACE_ID,
      threadId: second.thread.id,
    });
    expect(messages.find((message) => message.id === second.message.id)?.parentMessageId).toBeUndefined();
    expect(messages.find((message) => message.id === unresolvedChild.id)?.parentMessageId).toBeUndefined();
    expect(
      rawDbFor(engine, (db) =>
        Number(
          db
            .prepare(
              "SELECT COUNT(*) AS count FROM chat_pending_message_parents WHERE workspace_id = ?",
            )
            .get(WORKSPACE_ID)?.count,
        ),
      ),
    ).toBe(1);

    await engine.store.applyReplicationOp(
      messageEnvelope({
        originId: "origin-migrated-parent",
        threadId: second.thread.id,
        messageId: "future-same-thread-parent",
        body: "Deferred parent arrived",
        createdAtMs: 6000,
      }),
    );
    messages = await engine.store.listMessages({
      workspaceId: WORKSPACE_ID,
      threadId: second.thread.id,
    });
    expect(messages.find((message) => message.id === unresolvedChild.id)?.parentMessageId).toBe(
      "future-same-thread-parent",
    );
    expect(messages.find((message) => message.id === second.message.id)?.parentMessageId).toBeUndefined();
  });

  it("orders messages by created time and message id instead of arrival order", async () => {
    const engine = await makeEngine("ordering");
    const channel = await engine.store.ensureGeneralChannel({
      workspaceId: WORKSPACE_ID,
    });
    const started = await engine.store.startChannelThread({
      workspaceId: WORKSPACE_ID,
      channelId: channel.id,
      author: { kind: "human", displayName: "You" },
      body: "Opening",
    });
    for (const op of [
      messageEnvelope({
        originId: "origin-z",
        threadId: started.thread.id,
        messageId: "message-z",
        body: "Arrived first",
        createdAtMs: 5000,
      }),
      messageEnvelope({
        originId: "origin-b",
        threadId: started.thread.id,
        messageId: "message-b",
        body: "Tie B",
        createdAtMs: 4000,
      }),
      messageEnvelope({
        originId: "origin-a",
        threadId: started.thread.id,
        messageId: "message-a",
        body: "Tie A",
        createdAtMs: 4000,
      }),
    ]) {
      await engine.store.applyReplicationOp(op);
    }
    const ids = (
      await engine.store.listMessages({
        workspaceId: WORKSPACE_ID,
        threadId: started.thread.id,
      })
    ).map((message) => message.id);
    expect(ids.slice(-3)).toEqual(["message-a", "message-b", "message-z"]);
    const storedOrders = rawDbFor(engine, (db) =>
      db
        .prepare(
          `SELECT message_id FROM chat_messages
           WHERE workspace_id = ? AND thread_id = ? AND message_id LIKE 'message-%'
           ORDER BY message_order`,
        )
        .all(WORKSPACE_ID, started.thread.id)
        .map((row) => String(row.message_id)),
    );
    expect(storedOrders).toEqual(["message-z", "message-b", "message-a"]);
  });

  it("derives an untitled thread from the visibly-first out-of-order message", async () => {
    const engine = await makeEngine("title-ordering");
    const channel = await engine.store.ensureGeneralChannel({
      workspaceId: WORKSPACE_ID,
    });
    const channelWireId = await engine.store.getChannelWireId({
      workspaceId: WORKSPACE_ID,
      channelId: channel.id,
    });
    if (!channelWireId) throw new Error("Expected a general channel wire id.");
    const threadId = "thread-title-ordering";
    await engine.store.applyReplicationOp({
      workspaceId: WORKSPACE_ID,
      originId: "origin-title-thread",
      originSeq: 0,
      opKind: "chat.thread.create",
      payload: {
        threadId,
        title: "",
        createdAtMs: 3000,
        channelSlug: channel.slug,
        channelWireId,
      },
      recordedAtMs: 3000,
    });
    await engine.store.applyReplicationOp(
      messageEnvelope({
        originId: "origin-title-later",
        threadId,
        messageId: "message-title-later",
        body: "Arrived first but appears second",
        createdAtMs: 5000,
      }),
    );
    await engine.store.applyReplicationOp(
      messageEnvelope({
        originId: "origin-title-earlier",
        threadId,
        messageId: "message-title-earlier",
        body: "Visible first message",
        createdAtMs: 4000,
      }),
    );

    const messages = await engine.store.listMessages({ workspaceId: WORKSPACE_ID, threadId });
    expect(messages.map((message) => message.body)).toEqual([
      "Visible first message",
      "Arrived first but appears second",
    ]);
    const summaries = await engine.store.listChannelThreads({
      workspaceId: WORKSPACE_ID,
      channelId: channel.id,
    });
    expect(summaries.find((summary) => summary.thread.id === threadId)?.thread.title).toBe(
      "Visible first message",
    );
    expect(
      rawDbFor(engine, (db) =>
        db
          .prepare(
            `SELECT text FROM engine_search_chat_messages_fts
             WHERE workspace_id = ? AND thread_id = ? AND message_id = '__thread__'`,
          )
          .get(WORKSPACE_ID, threadId)?.text,
      ),
    ).toBe("Visible first message");
  });

  it("opens, resolves, and summarizes per-message decisions", async () => {
    const engine = await makeEngine("decisions");
    const channel = await engine.store.ensureGeneralChannel({
      workspaceId: WORKSPACE_ID,
    });
    const started = await engine.store.startChannelThread({
      workspaceId: WORKSPACE_ID,
      channelId: channel.id,
      author: { kind: "human", displayName: "You" },
      body: "Opening",
    });
    const decisionMessage = await engine.store.sendMessage({
      workspaceId: WORKSPACE_ID,
      threadId: started.thread.id,
      author: { kind: "agent", displayName: "Your agent" },
      body: "Choose a launch date",
      needsDecision: true,
    });
    expect(await engine.store.listThreadDecisions(WORKSPACE_ID, started.thread.id)).toEqual([
      expect.objectContaining({ messageId: decisionMessage.id, state: "open" }),
    ]);
    expect(
      (
        await engine.store.listChannelThreads({
          workspaceId: WORKSPACE_ID,
          channelId: channel.id,
        })
      )[0]?.openDecisionCount,
    ).toBe(1);

    const resolved = await engine.store.resolveChatDecision({
      workspaceId: WORKSPACE_ID,
      threadId: started.thread.id,
      messageId: decisionMessage.id,
      resolvedByMessageId: "resolution-message",
    });
    expect(resolved).toMatchObject({
      state: "resolved",
      resolvedByMessageId: "resolution-message",
    });
    await expect(
      engine.store.resolveChatDecision({
        workspaceId: WORKSPACE_ID,
        threadId: started.thread.id,
        messageId: decisionMessage.id,
        resolvedByMessageId: "another-resolution",
      }),
    ).resolves.toEqual(resolved);
    expect(
      (
        await engine.store.listChannelThreads({
          workspaceId: WORKSPACE_ID,
          channelId: channel.id,
        })
      )[0]?.openDecisionCount,
    ).toBe(0);
    await expect(
      engine.store.resolveChatDecision({
        workspaceId: WORKSPACE_ID,
        threadId: started.thread.id,
        messageId: "missing-decision",
        resolvedByMessageId: "resolution-message",
      }),
    ).rejects.toMatchObject({ code: "decision-not-found" });
  });

  it("converges decision LWW state and preserves replication front-matter rules", async () => {
    const forward = await makeEngine("decision-forward");
    const reverse = await makeEngine("decision-reverse");
    const open = decisionEnvelope({
      originId: "origin-open",
      state: "open",
      atMs: 5000,
    });
    const resolved = decisionEnvelope({
      originId: "origin-resolved",
      state: "resolved",
      atMs: 5000,
    });
    await forward.store.applyReplicationOp(open);
    await forward.store.applyReplicationOp(resolved);
    await reverse.store.applyReplicationOp(resolved);
    await reverse.store.applyReplicationOp(open);
    const state = (engine: TestEngine) =>
      rawDbFor(engine, (db) =>
        db
          .prepare("SELECT state, resolved_by_message_id FROM chat_decisions WHERE workspace_id = ? AND message_id = ?")
          .get(WORKSPACE_ID, "message-decision"),
      );
    expect(state(forward)).toEqual({
      state: "resolved",
      resolved_by_message_id: "message-resolution",
    });
    expect(state(reverse)).toEqual(state(forward));
    await expect(forward.store.applyReplicationOp(resolved)).resolves.toMatchObject({
      status: "skipped",
    });
    await expect(
      forward.store.applyReplicationOp(
        decisionEnvelope({
          originId: "origin-gap",
          originSeq: 1,
          state: "open",
          atMs: 6000,
        }),
      ),
    ).rejects.toMatchObject({ code: "state-corrupt" });
  });

  it("replicates deterministic file attachments and exposes them on messages", async () => {
    const source = await makeEngine("attachment-source");
    const receiver = await makeEngine("attachment-receiver");
    const channel = await source.store.ensureGeneralChannel({
      workspaceId: WORKSPACE_ID,
    });
    const started = await source.store.startChannelThread({
      workspaceId: WORKSPACE_ID,
      channelId: channel.id,
      author: { kind: "human", displayName: "You" },
      body: "Review this file",
      attachments: [
        { objectId: "object-plan", pathHint: "plans/launch.md" },
        { objectId: "object-plan", pathHint: "plans/launch.md" },
      ],
      needsDecision: true,
    });
    const expectedId = createHash("sha256").update(`${started.message.id}fileobject-plan`, "utf8").digest("hex");
    expect(started.message.attachments).toEqual([
      expect.objectContaining({
        attachmentId: expectedId,
        objectId: "object-plan",
      }),
    ]);
    for (const op of replicationOps(source)) await receiver.store.applyReplicationOp(op);
    const received = await receiver.store.listMessages({
      workspaceId: WORKSPACE_ID,
      threadId: started.thread.id,
    });
    expect(received[0]?.attachments).toEqual([
      expect.objectContaining({
        attachmentId: expectedId,
        pathHint: "plans/launch.md",
      }),
    ]);
    expect(await receiver.store.listThreadAttachments(WORKSPACE_ID, started.thread.id)).toHaveLength(1);
    expect(await receiver.store.listThreadDecisions(WORKSPACE_ID, started.thread.id)).toEqual([
      expect.objectContaining({ messageId: started.message.id, state: "open" }),
    ]);
    const attachmentOp = replicationOps(source).find((op) => op.opKind === "chat.attachment.add");
    if (!attachmentOp) throw new Error("Expected an attachment op.");
    expect(replicationOps(source).filter((op) => op.opKind === "chat.attachment.add")).toHaveLength(1);
    await expect(receiver.store.applyReplicationOp(attachmentOp)).resolves.toMatchObject({
      status: "skipped",
    });
    await expect(
      receiver.store.applyReplicationOp({
        ...attachmentOp,
        originId: "origin-same-attachment",
        originSeq: 0,
      }),
    ).resolves.toMatchObject({ status: "applied" });
    expect(
      rawDbFor(receiver, (db) =>
        Number(
          db.prepare("SELECT COUNT(*) AS count FROM chat_attachments WHERE workspace_id = ?").get(WORKSPACE_ID)?.count,
        ),
      ),
    ).toBe(1);

    const invalid = {
      ...attachmentOp,
      originId: "origin-invalid-attachment",
      originSeq: 0,
      payload: { ...attachmentOp.payload, targetKind: "url" },
    } as unknown as SyncReplicationEnvelope;
    await expect(receiver.store.applyReplicationOp(invalid)).rejects.toMatchObject({
      code: "state-corrupt",
    });
  });

  it("applies redacted attachment ops idempotently without file metadata", async () => {
    const source = await makeEngine("redacted-attachment-source");
    const receiver = await makeEngine("redacted-attachment-receiver");
    const channel = await source.store.ensureGeneralChannel({ workspaceId: WORKSPACE_ID });
    const started = await source.store.startChannelThread({
      workspaceId: WORKSPACE_ID,
      channelId: channel.id,
      author: { kind: "human", displayName: "You" },
      body: "Shared file",
      attachments: [{ objectId: "object-private", pathHint: "private/plan.md" }],
    });
    const attachmentOp = replicationOps(source).find(
      (op) => op.opKind === "chat.attachment.add",
    );
    if (!attachmentOp || attachmentOp.opKind !== "chat.attachment.add") {
      throw new Error("Expected an attachment op.");
    }
    for (const op of replicationOps(source)) {
      if (op.opKind !== "chat.attachment.add") await receiver.store.applyReplicationOp(op);
    }
    const redactedOp: SyncReplicationEnvelope = {
      ...attachmentOp,
      payload: {
        attachmentId: attachmentOp.payload.attachmentId,
        threadId: attachmentOp.payload.threadId,
        messageId: attachmentOp.payload.messageId,
        targetKind: "file",
        createdAtMs: attachmentOp.payload.createdAtMs,
      },
    };

    await expect(receiver.store.applyReplicationOp(redactedOp)).resolves.toMatchObject({
      status: "applied",
    });
    await expect(receiver.store.applyReplicationOp(redactedOp)).resolves.toMatchObject({
      status: "skipped",
    });
    await expect(
      receiver.store.applyReplicationOp({
        ...redactedOp,
        originId: "origin-redacted-replay",
        originSeq: 0,
      }),
    ).resolves.toMatchObject({ status: "applied" });

    const messages = await receiver.store.listMessages({
      workspaceId: WORKSPACE_ID,
      threadId: started.thread.id,
    });
    expect(messages[0]?.attachments).toEqual([
      {
        attachmentId: attachmentOp.payload.attachmentId,
        threadId: started.thread.id,
        messageId: started.message.id,
        targetKind: "file",
        createdAtMs: attachmentOp.payload.createdAtMs,
      },
    ]);
    expect(
      rawDbFor(receiver, (db) =>
        db
          .prepare("SELECT object_id, path_hint FROM chat_attachments WHERE workspace_id = ?")
          .get(WORKSPACE_ID),
      ),
    ).toEqual({ object_id: null, path_hint: null });
    expect(
      rawDbFor(receiver, (db) =>
        db
          .prepare("PRAGMA table_info(chat_attachments)")
          .all()
          .find((row) => row.name === "object_id")?.notnull,
      ),
    ).toBe(0);

    await expect(
      receiver.store.applyReplicationOp({
        ...redactedOp,
        originId: "origin-mismatched-attachment",
        originSeq: 0,
        payload: { ...redactedOp.payload, objectId: "object-does-not-match-id" },
      }),
    ).rejects.toMatchObject({ code: "state-corrupt" });
  });

  it("provisions one convergent agent channel and rejects user-created agent channels", async () => {
    const first = await makeEngine("agent-first");
    const second = await makeEngine("agent-second");
    const firstChannel = await first.store.ensureAgentChannel({
      workspaceId: WORKSPACE_ID,
    });
    expect(await first.store.ensureAgentChannel({ workspaceId: WORKSPACE_ID })).toEqual(firstChannel);
    const secondChannel = await second.store.ensureAgentChannel({
      workspaceId: WORKSPACE_ID,
    });
    await expect(
      first.store.createChannel({
        workspaceId: WORKSPACE_ID,
        name: "Another agent",
        kind: "agent",
      }),
    ).rejects.toMatchObject({ code: "invalid-channel-kind" });
    await expect(
      first.store.createChannel({ workspaceId: WORKSPACE_ID, name: "My agent" }),
    ).rejects.toMatchObject({ code: "channel-exists" });
    await expect(
      first.store.applyReplicationOp({
        workspaceId: WORKSPACE_ID,
        originId: "origin-reserved-agent-slug",
        originSeq: 0,
        opKind: "chat.channel.create",
        payload: {
          channelId: "poison-channel",
          name: "My agent",
          slug: "my-agent",
          kind: "channel",
          createdAtMs: 1000,
          wireId: "wire-poison",
        },
        recordedAtMs: 1000,
      }),
    ).rejects.toMatchObject({ code: "state-corrupt" });
    for (const op of replicationOps(first).filter((entry) => entry.opKind === "chat.channel.create")) {
      await second.store.applyReplicationOp(op);
    }
    for (const op of replicationOps(second).filter((entry) => entry.opKind === "chat.channel.create")) {
      await first.store.applyReplicationOp(op);
    }
    for (const engine of [first, second]) {
      const channels = await engine.store.listChannels({
        workspaceId: WORKSPACE_ID,
      });
      expect(channels).toHaveLength(1);
      expect(channels[0]).toMatchObject({
        name: "My agent",
        slug: "my-agent",
        kind: "agent",
      });
      expect(channels.filter((entry) => entry.kind === "dm")).toEqual([]);
      expect(
        await engine.store.getChannelWireId({
          workspaceId: WORKSPACE_ID,
          channelId: channels[0]!.id,
        }),
      ).toBe(AGENT_CHANNEL_WIRE_ID);
    }
    expect(firstChannel.id).not.toBe(secondChannel.id);
  });

  it("keeps an out-of-order agent thread placeholder classified as agent", async () => {
    const engine = await makeEngine("agent-placeholder");
    await expect(
      engine.store.applyReplicationOp({
        workspaceId: WORKSPACE_ID,
        originId: "origin-thread-poison",
        originSeq: 0,
        opKind: "chat.thread.create",
        payload: {
          threadId: "thread-poison",
          title: "Wrong owner",
          createdAtMs: 1900,
          channelSlug: "my-agent",
          channelWireId: "wire-not-agent",
        },
        recordedAtMs: 1900,
      }),
    ).rejects.toMatchObject({ code: "state-corrupt" });
    await engine.store.applyReplicationOp({
      workspaceId: WORKSPACE_ID,
      originId: "origin-thread",
      originSeq: 0,
      opKind: "chat.thread.create",
      payload: {
        threadId: "thread-agent",
        title: "Agent task",
        createdAtMs: 2000,
        channelSlug: "my-agent",
        channelWireId: AGENT_CHANNEL_WIRE_ID,
      },
      recordedAtMs: 2000,
    });
    await engine.store.applyReplicationOp({
      workspaceId: WORKSPACE_ID,
      originId: "origin-channel",
      originSeq: 0,
      opKind: "chat.channel.create",
      payload: {
        channelId: "remote-agent-channel",
        name: "My agent",
        slug: "my-agent",
        kind: "agent",
        createdAtMs: 1000,
        wireId: AGENT_CHANNEL_WIRE_ID,
      },
      recordedAtMs: 1000,
    });
    expect(await engine.store.listChannels({ workspaceId: WORKSPACE_ID })).toEqual([
      expect.objectContaining({ kind: "agent", slug: "my-agent" }),
    ]);
  });

  it("maintains an agent-only CAS cursor and human-authored unread threads", async () => {
    const engine = await makeEngine("agent-read", 0);
    const channel = await engine.store.ensureGeneralChannel({
      workspaceId: WORKSPACE_ID,
    });
    const started = await engine.store.startChannelThread({
      workspaceId: WORKSPACE_ID,
      channelId: channel.id,
      author: { kind: "human", displayName: "You" },
      body: "Opening",
    });
    expect((await engine.store.listAgentUnreadThreads(WORKSPACE_ID)).map((thread) => thread.id)).toEqual([
      started.thread.id,
    ]);
    const opCountBeforeRead = replicationOps(engine).length;
    const firstState = await engine.store.markThreadReadByAgent({
      workspaceId: WORKSPACE_ID,
      threadId: started.thread.id,
      upTo: {
        createdAtMs: started.message.createdAtMs,
        messageId: started.message.id,
      },
      expectedRevision: 0,
    });
    expect(firstState.revision).toBe(1);
    expect(replicationOps(engine)).toHaveLength(opCountBeforeRead);
    expect(
      await engine.store.markThreadReadByAgent({
        workspaceId: WORKSPACE_ID,
        threadId: started.thread.id,
        upTo: { createdAtMs: 9_999_999, messageId: "future-message" },
      }),
    ).toEqual(firstState);
    await expect(
      engine.store.markThreadReadByAgent({
        workspaceId: WORKSPACE_ID,
        threadId: started.thread.id,
        upTo: {
          createdAtMs: started.message.createdAtMs,
          messageId: started.message.id,
        },
        expectedRevision: 0,
      }),
    ).rejects.toMatchObject({ code: "read-state-revision-mismatch" });
    expect(
      await engine.store.markThreadReadByAgent({
        workspaceId: WORKSPACE_ID,
        threadId: started.thread.id,
        upTo: {
          createdAtMs: started.message.createdAtMs,
          messageId: started.message.id,
        },
      }),
    ).toEqual(firstState);

    const agentMessage = await engine.store.sendMessage({
      workspaceId: WORKSPACE_ID,
      threadId: started.thread.id,
      author: { kind: "agent", displayName: "Your agent" },
      body: "Agent report",
    });
    expect(await engine.store.listAgentUnreadThreads(WORKSPACE_ID)).toEqual([]);
    const humanMessage = await engine.store.sendMessage({
      workspaceId: WORKSPACE_ID,
      threadId: started.thread.id,
      author: { kind: "human", displayName: "You" },
      body: "Follow up",
    });
    expect((await engine.store.listAgentUnreadThreads(WORKSPACE_ID)).map((thread) => thread.id)).toEqual([
      started.thread.id,
    ]);
    const latest = await engine.store.markThreadReadByAgent({
      workspaceId: WORKSPACE_ID,
      threadId: started.thread.id,
      upTo: {
        createdAtMs: humanMessage.createdAtMs,
        messageId: humanMessage.id,
      },
      expectedRevision: 1,
    });
    const noOp = await engine.store.markThreadReadByAgent({
      workspaceId: WORKSPACE_ID,
      threadId: started.thread.id,
      upTo: {
        createdAtMs: agentMessage.createdAtMs,
        messageId: agentMessage.id,
      },
    });
    expect(noOp).toEqual(latest);
    expect(await engine.store.listAgentUnreadThreads(WORKSPACE_ID)).toEqual([]);
  });

  it("indexes local and replicated mentions and filters them by the agent cursor", async () => {
    expect(
      parseMentionHandles(
        "Hi @Agent and @agent. email@ignored é@ignored @K @ſ `ignore @inline`\n```ts\nignore @fenced\n```\n`multi line\nignore @multiline`\n@other-team",
      ),
    ).toEqual(["agent", "k", "ſ", "other-team"]);

    const parityCandidates: MentionCandidate[] = [
      { id: "agent", kind: "agent", handle: "agent", label: "Agent" },
      { id: "ops", kind: "agent", handle: "agent.ops_v2", label: "Ops agent" },
      { id: "you", kind: "user", handle: "you_name", label: "You" },
    ];
    const parityBodies = [
      "@Agent and (@agent.ops_v2) plus [@you_name]",
      "email@agent and slash/@agent are inert",
      "outside @agent `inside @agent.ops_v2`",
      "```ts\n@agent\n```\n@you_name",
      "~~~~\n@agent.ops_v2\n~~~~\n@Agent",
    ];
    for (const body of parityBodies) {
      const highlighted = findMentions(body, parityCandidates, { ignoreCode: true });
      const expected = [...new Set(
        highlighted.map((mention) => mention.candidate.handle.toLowerCase()),
      )];
      expect(parseMentionHandles(body)).toEqual(expected);
    }

    const source = await makeEngine("mention-source");
    const receiver = await makeEngine("mention-receiver");
    const channel = await source.store.ensureGeneralChannel({
      workspaceId: WORKSPACE_ID,
    });
    const started = await source.store.startChannelThread({
      workspaceId: WORKSPACE_ID,
      channelId: channel.id,
      author: { kind: "human", displayName: "You" },
      body: "Hello @Agent and @agent",
    });
    expect(await source.store.listMentionsForHandle(WORKSPACE_ID, "agent")).toEqual([
      expect.objectContaining({
        messageId: started.message.id,
        handle: "agent",
      }),
    ]);
    expect(
      await source.store.listMentionsForHandle(WORKSPACE_ID, "agent", {
        unreadByAgentOnly: true,
      }),
    ).toHaveLength(1);
    await source.store.markThreadReadByAgent({
      workspaceId: WORKSPACE_ID,
      threadId: started.thread.id,
      upTo: {
        createdAtMs: started.message.createdAtMs,
        messageId: started.message.id,
      },
    });
    expect(
      await source.store.listMentionsForHandle(WORKSPACE_ID, "agent", {
        unreadByAgentOnly: true,
      }),
    ).toEqual([]);
    const follow = await source.store.sendMessage({
      workspaceId: WORKSPACE_ID,
      threadId: started.thread.id,
      author: { kind: "human", displayName: "You" },
      body: "New work for @agent",
    });
    expect(
      await source.store.listMentionsForHandle(WORKSPACE_ID, "agent", {
        unreadByAgentOnly: true,
      }),
    ).toEqual([expect.objectContaining({ messageId: follow.id })]);

    for (const op of replicationOps(source)) await receiver.store.applyReplicationOp(op);
    expect((await receiver.store.listMentionsForHandle(WORKSPACE_ID, "agent")).map((row) => row.messageId)).toEqual([
      started.message.id,
      follow.id,
    ]);
  });
});
