import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LinkedChatStore, SyncReplicationEnvelope } from "@dohc/workspace-contracts/engine";
import { afterEach, describe, expect, it } from "vitest";
import { closeTrackedEngineDbHandlesForTest } from "./engineDbSchema";
import {
  AGENT_CHANNEL_WIRE_ID,
  LINKED_CHAT_STORE_RELATIVE_PATH,
  createLinkedChatStore,
} from "./linkedChatStore";

interface RawSqliteStatement {
  get(...params: unknown[]): Record<string, unknown> | undefined;
  run(...params: unknown[]): unknown;
}

interface RawSqliteDb {
  prepare(sql: string): RawSqliteStatement;
  close(): void;
}

const requireModule = createRequire(import.meta.url);
const { DatabaseSync } = requireModule("node:sqlite") as {
  DatabaseSync: new (path: string) => RawSqliteDb;
};

const WORKSPACE_ID = "workspace-placeholder-provenance";
let root: string | undefined;
let store: LinkedChatStore | undefined;

afterEach(async () => {
  await store?.close();
  closeTrackedEngineDbHandlesForTest();
  if (root) await rm(root, { recursive: true, force: true });
  root = undefined;
  store = undefined;
});

function rawDb<T>(read: (db: RawSqliteDb) => T): T {
  if (!root) throw new Error("Expected a test workspace root.");
  const db = new DatabaseSync(join(root, LINKED_CHAT_STORE_RELATIVE_PATH));
  try {
    return read(db);
  } finally {
    db.close();
  }
}

describe("replicated channel placeholder provenance", () => {
  it("does not make a reused authoritative agent channel mutable", async () => {
    root = await mkdtemp(join(tmpdir(), "dohc-chat-placeholder-provenance-"));
    let clock = 1000;
    let nextChannelId = 0;
    store = createLinkedChatStore(root, {
      nowMs: () => ++clock,
      createId: (kind) => {
        if (kind === "channel") return `local-channel-${++nextChannelId}`;
        return `local-${kind}-1`;
      },
    });
    const authoritative = await store.ensureAgentChannel({ workspaceId: WORKSPACE_ID });

    // Simulate a genuine agent channel created before wire mappings shipped.
    rawDb((db) =>
      db
        .prepare("DELETE FROM chat_channel_wire_ids WHERE workspace_id = ? AND channel_id = ?")
        .run(WORKSPACE_ID, authoritative.id),
    );

    const threadOp: SyncReplicationEnvelope = {
      workspaceId: WORKSPACE_ID,
      originId: "remote-thread-origin",
      originSeq: 0,
      opKind: "chat.thread.create",
      payload: {
        threadId: "remote-agent-thread",
        title: "Remote agent task",
        createdAtMs: 4000,
        channelSlug: "my-agent",
        channelWireId: AGENT_CHANNEL_WIRE_ID,
      },
      recordedAtMs: 4000,
    };
    await store.applyReplicationOp(threadOp);

    expect(
      await store.getChannelWireId({
        workspaceId: WORKSPACE_ID,
        channelId: authoritative.id,
      }),
    ).toBe(AGENT_CHANNEL_WIRE_ID);
    expect(
      rawDb((db) =>
        db
          .prepare(
            "SELECT 1 FROM chat_channel_placeholders WHERE workspace_id = ? AND channel_id = ?",
          )
          .get(WORKSPACE_ID, authoritative.id),
      ),
    ).toBeUndefined();

    await store.applyReplicationOp({
      workspaceId: WORKSPACE_ID,
      originId: "remote-channel-origin",
      originSeq: 0,
      opKind: "chat.channel.create",
      payload: {
        channelId: "remote-agent-channel",
        name: "My agent",
        slug: "my-agent",
        kind: "agent",
        createdAtMs: 500,
        wireId: AGENT_CHANNEL_WIRE_ID,
      },
      recordedAtMs: 500,
    });

    expect(await store.listChannels({ workspaceId: WORKSPACE_ID })).toEqual([
      expect.objectContaining(authoritative),
    ]);
    expect(
      await store.listChannelThreads({
        workspaceId: WORKSPACE_ID,
        channelId: authoritative.id,
      }),
    ).toEqual([
      expect.objectContaining({
        thread: expect.objectContaining({ id: "remote-agent-thread" }),
      }),
    ]);
  });
});
