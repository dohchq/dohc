import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeTrackedEngineDbHandlesForTest } from "./engineDbSchema";
import {
  LINKED_CHAT_STORE_RELATIVE_PATH,
  LinkedChatStoreError,
  createLinkedChatStore,
  linkedChatProjectionPath,
} from "./linkedChatStore";
import { createVersionedTextStore } from "./versionedTextStore";

interface RawSqliteStatement {
  all(...params: unknown[]): Array<Record<string, unknown>>;
  get(...params: unknown[]): Record<string, unknown> | undefined;
  run(...params: unknown[]): { changes: number };
}

interface RawSqliteDb {
  exec(sql: string): void;
  prepare(sql: string): RawSqliteStatement;
  close(): void;
}

const requireModule = createRequire(import.meta.url);
const { DatabaseSync } = requireModule("node:sqlite") as {
  DatabaseSync: new (path: string) => RawSqliteDb;
};

let root: string;
let now = 1000;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "dohc-linked-chat-"));
  now = 1000;
});

afterEach(async () => {
  closeTrackedEngineDbHandlesForTest();
  await rm(root, { recursive: true, force: true });
});

function chatStore() {
  const counters = { channel: 0, message: 0, thread: 0 };
  return createLinkedChatStore(root, {
    nowMs: () => {
      now += 10;
      return now;
    },
    createId: (kind) => {
      counters[kind] += 1;
      return `${kind}-${counters[kind]}`;
    },
  });
}

function versionStore() {
  const counters = { conflict: 0, moment: 0, object: 0, version: 0 };
  return createVersionedTextStore(root, {
    nowMs: () => {
      now += 10;
      return now;
    },
    createId: (kind) => {
      counters[kind] += 1;
      return `${kind}-${counters[kind]}`;
    },
  });
}

function withRawDb<T>(fn: (db: RawSqliteDb) => T): T {
  const db = new DatabaseSync(join(root, LINKED_CHAT_STORE_RELATIVE_PATH));
  try {
    db.exec("PRAGMA foreign_keys = ON");
    return fn(db);
  } finally {
    db.close();
  }
}

function rawRows(sql: string, ...params: unknown[]): Array<Record<string, unknown>> {
  return withRawDb((db) => db.prepare(sql).all(...params));
}

function rawExec(sql: string, ...params: unknown[]): void {
  withRawDb((db) => {
    db.prepare(sql).run(...params);
  });
}

describe("linked chat store", () => {
  it("creates a thread linked to a stable file object and sends messages", async () => {
    const versions = versionStore();
    const main = await versions.ensureMainVersion({ workspaceId: "workspace-a" });
    const file = await versions.writeTextFile({
      workspaceId: "workspace-a",
      versionId: main.id,
      path: "docs/plan.md",
      text: "Plan\n",
      metadata: { origin: "local-file", summary: "seed file" },
    });
    const chats = chatStore();

    const thread = await chats.createThread({
      workspaceId: "workspace-a",
      title: "Plan discussion",
      linkedFile: { objectId: file.object.id, pathHint: "docs/plan.md" },
    });
    const message = await chats.sendMessage({
      workspaceId: "workspace-a",
      threadId: thread.id,
      author: { kind: "human", displayName: "Ice" },
      body: "Let's keep the plan beside the work.",
    });

    expect(thread).toMatchObject({
      id: "thread-1",
      linkedFile: { objectId: file.object.id, pathHint: "docs/plan.md" },
    });
    expect(message).toMatchObject({
      id: "message-1",
      threadId: thread.id,
      author: { kind: "human", displayName: "Ice" },
    });
    await expect(
      chats.listThreadsForFile({ workspaceId: "workspace-a", objectId: file.object.id }),
    ).resolves.toMatchObject([{ id: thread.id, title: "Plan discussion" }]);
    await expect(
      chats.listMessages({ workspaceId: "workspace-a", threadId: thread.id }),
    ).resolves.toMatchObject([{ id: message.id, body: "Let's keep the plan beside the work." }]);
  });

  it("keeps the file link stable when the file path changes", async () => {
    const versions = versionStore();
    const main = await versions.ensureMainVersion({ workspaceId: "workspace-a" });
    const file = await versions.writeTextFile({
      workspaceId: "workspace-a",
      versionId: main.id,
      path: "docs/plan.md",
      text: "Plan\n",
      metadata: { origin: "local-file", summary: "seed file" },
    });
    const chats = chatStore();
    const thread = await chats.createThread({
      workspaceId: "workspace-a",
      title: "Plan discussion",
      linkedFile: { objectId: file.object.id, pathHint: "docs/plan.md" },
    });

    await versions.renameTextFile({
      workspaceId: "workspace-a",
      versionId: main.id,
      fromPath: "docs/plan.md",
      toPath: "archive/plan.md",
      metadata: { origin: "local-file", summary: "rename plan" },
    });
    const projection = await chats.getThreadProjection({
      workspaceId: "workspace-a",
      threadId: thread.id,
      linkedFileAccess: { kind: "allowed", path: "archive/plan.md" },
    });

    await expect(
      chats.listThreadsForFile({ workspaceId: "workspace-a", objectId: file.object.id }),
    ).resolves.toMatchObject([{ id: thread.id }]);
    expect(projection.text).toContain("Linked file: archive/plan.md");
  });

  it("projects chats as read-only text for agent context", async () => {
    const chats = chatStore();
    const thread = await chats.createThread({
      workspaceId: "workspace-a",
      title: "Launch notes",
      linkedFile: { objectId: "object-launch" },
    });
    await chats.sendMessage({
      workspaceId: "workspace-a",
      threadId: thread.id,
      author: { kind: "human", displayName: "Ice" },
      body: "Ship the obvious path first.",
    });
    await chats.sendMessage({
      workspaceId: "workspace-a",
      threadId: thread.id,
      author: { kind: "agent", displayName: "Ice's agent" },
      body: "I will check the files and report back.",
    });

    const projection = await chats.getThreadProjection({
      workspaceId: "workspace-a",
      threadId: thread.id,
    });

    expect(projection).toMatchObject({
      path: ".dohc/chats/v1-6pqlydvjozgw62bmric7vq2bt3jan3v7nyeiktafistuoca52adq.md",
      readOnly: true,
      threadId: thread.id,
    });
    expect(projection.path).toBe(
      linkedChatProjectionPath({ workspaceId: "workspace-a", threadId: thread.id }),
    );
    expect(projection.path).toMatch(/^\.dohc\/chats\/v1-[a-z2-7]{52}\.md$/u);
    expect(projection.path).not.toContain(thread.id);
    expect(projection.text).toContain("# Launch notes");
    expect(projection.text).toContain("## Ice\n\nShip the obvious path first.");
    expect(projection.text).toContain("## Ice's agent (agent)\n\nI will check");
  });

  it("rejects unsafe projection identity before constructing a path", async () => {
    const chats = createLinkedChatStore(root, {
      nowMs: () => {
        now += 10;
        return now;
      },
      createId: (kind) => (kind === "thread" ? "../thread-1" : "message-1"),
    });
    const thread = await chats.createThread({
      workspaceId: "workspace-a",
      title: "Unsafe id",
      linkedFile: { objectId: "object-unsafe" },
    });

    await expect(
      chats.getThreadProjection({ workspaceId: "workspace-a", threadId: thread.id }),
    ).rejects.toMatchObject({ code: "invalid-path" });
  });

  it("keeps projection digests deterministic and case-sensitive", () => {
    const upper = linkedChatProjectionPath({
      workspaceId: "workspace-a",
      threadId: "Thread-1",
    });
    const lower = linkedChatProjectionPath({
      workspaceId: "workspace-a",
      threadId: "thread-1",
    });

    expect(upper).toMatch(/^\.dohc\/chats\/v1-[a-z2-7]{52}\.md$/u);
    expect(lower).toMatch(/^\.dohc\/chats\/v1-[a-z2-7]{52}\.md$/u);
    expect(upper).not.toBe(lower);
  });

  it("redacts linked file metadata from projections when access is denied", async () => {
    const chats = chatStore();
    const thread = await chats.createThread({
      workspaceId: "workspace-a",
      title: "Private file discussion",
      linkedFile: { objectId: "object-secret", pathHint: "secrets/private.md" },
    });
    await chats.sendMessage({
      workspaceId: "workspace-a",
      threadId: thread.id,
      author: { kind: "human", displayName: "Ice" },
      body: "Discuss without leaking the file name.",
    });

    const projection = await chats.getThreadProjection({
      workspaceId: "workspace-a",
      threadId: thread.id,
      linkedFileAccess: { kind: "denied" },
    });

    expect(projection.text).toContain("Linked file: unavailable");
    expect(projection.text).not.toContain("secrets/private.md");
    expect(projection.text).not.toContain("object-secret");
  });

  it("denies reading or writing a thread through the wrong workspace", async () => {
    const chats = chatStore();
    const thread = await chats.createThread({
      workspaceId: "workspace-a",
      title: "Workspace A",
      linkedFile: { objectId: "object-a" },
    });

    await expect(
      chats.listMessages({ workspaceId: "workspace-b", threadId: thread.id }),
    ).rejects.toMatchObject({ code: "workspace-mismatch" });
    await expect(
      chats.sendMessage({
        workspaceId: "workspace-b",
        threadId: thread.id,
        author: { kind: "human", displayName: "Ice" },
        body: "wrong workspace",
      }),
    ).rejects.toBeInstanceOf(LinkedChatStoreError);
  });

  it("rejects unsafe linked file path hints", async () => {
    const chats = chatStore();

    await expect(
      chats.createThread({
        workspaceId: "workspace-a",
        title: "Unsafe link",
        linkedFile: { objectId: "object-1", pathHint: ".dohc/engine/chat.md" },
      }),
    ).rejects.toMatchObject({ code: "invalid-path" });
  });

  it("fails closed on corrupt persisted state", async () => {
    const chats = createLinkedChatStore(root);
    await chats.createThread({
      workspaceId: "workspace-a",
      title: "Seed",
      linkedFile: { objectId: "object-seed" },
    });
    withRawDb((db) => {
      db.prepare("UPDATE schema_version SET version = 2 WHERE id = 1").run();
    });
    const reloadedChats = createLinkedChatStore(root);

    await expect(reloadedChats.listThreads({ workspaceId: "workspace-a" })).rejects.toBeInstanceOf(
      LinkedChatStoreError,
    );
    await expect(reloadedChats.listThreads({ workspaceId: "workspace-a" })).rejects.toMatchObject({
      code: "state-corrupt",
    });
  });

  it("persists inspectable SQLite rows and reloads the same thread", async () => {
    const chats = chatStore();
    const thread = await chats.createThread({
      workspaceId: "workspace-a",
      title: "Durable thread",
      linkedFile: { objectId: "object-durable" },
    });
    await chats.sendMessage({
      workspaceId: "workspace-a",
      threadId: thread.id,
      author: { kind: "human", displayName: "Ice" },
      body: "This survives reload.",
    });

    expect(rawRows("SELECT version FROM schema_version WHERE id = 1")).toEqual([{ version: 1 }]);
    expect(rawRows("SELECT thread_id, title FROM chat_threads")).toEqual([
      { thread_id: thread.id, title: "Durable thread" },
    ]);
    expect(rawRows("SELECT body FROM chat_messages")).toEqual([
      { body: "This survives reload." },
    ]);
    const reloaded = createLinkedChatStore(root);

    await expect(reloaded.listThreads({ workspaceId: "workspace-a" })).resolves.toMatchObject([
      { id: thread.id, title: "Durable thread" },
    ]);
    await expect(
      reloaded.listMessages({ workspaceId: "workspace-a", threadId: thread.id }),
    ).resolves.toMatchObject([{ body: "This survives reload." }]);
  });
});

describe("linked chat store hardening (CodeRabbit arc gate)", () => {
  it("fails closed on a corrupt persisted author_kind", async () => {
    const chats = chatStore();
    const thread = await chats.createThread({
      workspaceId: "workspace-a",
      title: "Corrupt author",
      linkedFile: { objectId: "object-corrupt" },
    });
    await chats.sendMessage({
      workspaceId: "workspace-a",
      threadId: thread.id,
      author: { kind: "agent", displayName: "Ice" },
      body: "Real agent message.",
    });
    rawExec("UPDATE chat_messages SET author_kind = 'ghost'");

    const reloaded = createLinkedChatStore(root);
    await expect(
      reloaded.listMessages({ workspaceId: "workspace-a", threadId: thread.id }),
    ).rejects.toMatchObject({ code: "state-corrupt" });
  });

  it("close releases the handle and a later call lazily reopens", async () => {
    const chats = chatStore();
    const thread = await chats.createThread({
      workspaceId: "workspace-a",
      title: "Closable",
      linkedFile: { objectId: "object-closable" },
    });
    await chats.close();
    await chats.close();

    await expect(chats.listThreads({ workspaceId: "workspace-a" })).resolves.toMatchObject([
      { id: thread.id },
    ]);
    await chats.close();
  });

  // PR 0N-1 two-writer posture: the desktop AND the MCP process both write
  // chats over separate WAL connections to the same engine.db. A writer that
  // arrives while another PROCESS holds the write lock must WAIT (via PRAGMA
  // busy_timeout's synchronous busy wait) and then land, not fail. This must
  // be a REAL second process: node:sqlite's busy wait blocks the JS thread,
  // so an in-process competing connection could never release its lock while
  // the store is waiting (that deadlock shape is exactly why the desktop and
  // MCP hold locks from separate processes only).
  it("a send waits out another process's write transaction and lands", async () => {
    const chats = chatStore();
    const thread = await chats.createThread({
      workspaceId: "workspace-a",
      title: "Contended",
      linkedFile: { objectId: "object-contended" },
    });
    // Force the store's connection open before taking the competing lock so
    // schema bootstrap does not sit inside the contention window.
    await chats.listThreads({ workspaceId: "workspace-a" });

    const { spawn } = requireModule("node:child_process") as typeof import("node:child_process");
    const dbPath = join(root, LINKED_CHAT_STORE_RELATIVE_PATH);
    const markerPath = join(root, "chat-lock-held.marker");
    const holdScript = `
      const { writeFileSync } = require("node:fs");
      const { DatabaseSync } = require("node:sqlite");
      const db = new DatabaseSync(process.argv[1]);
      db.exec("BEGIN IMMEDIATE");
      writeFileSync(process.argv[2], "locked\\n");
      setTimeout(() => {
        db.exec("COMMIT");
        db.close();
      }, 1000);
    `;
    const holder = spawn(process.execPath, ["-e", holdScript, dbPath, markerPath], {
      stdio: ["ignore", "ignore", "inherit"],
    });
    try {
      const startedAt = Date.now();
      for (;;) {
        try {
          await stat(markerPath);
          break;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          if (Date.now() - startedAt > 2000) {
            throw new Error("Timed out waiting for lock holder.");
          }
          await new Promise((resolve) => setTimeout(resolve, 5));
        }
      }
      // The other process holds the write lock right now; this send must
      // block on busy_timeout and land once the holder commits.
      const message = await chats.sendMessage({
        workspaceId: "workspace-a",
        threadId: thread.id,
        author: { kind: "agent", displayName: "You" },
        body: "Written under contention.",
      });
      expect(message.body).toBe("Written under contention.");
    } finally {
      holder.kill();
    }

    const messages = await chats.listMessages({
      workspaceId: "workspace-a",
      threadId: thread.id,
    });
    expect(messages.map((message) => message.body)).toEqual([
      "Written under contention.",
    ]);
    await chats.close();
  });

  // Single-source schema: whichever store opens a brand-new workspace FIRST
  // must create a database the OTHER store validates cleanly (this order —
  // chat store first — is the one the old duplicated DDL drifted on).
  it("a chat-store-created database validates for the versioned text store", async () => {
    const chats = chatStore();
    await chats.createThread({
      workspaceId: "workspace-a",
      title: "First",
      linkedFile: { objectId: "object-first" },
    });

    const texts = versionStore();
    await expect(
      texts.ensureMainVersion({ workspaceId: "workspace-a" }),
    ).resolves.toMatchObject({ id: "main" });
    await expect(
      texts.setActiveVersion({ workspaceId: "workspace-a", versionId: "main" }),
    ).resolves.toMatchObject({ id: "main" });
  });
});

// --- Channels, DMs, and read cursors (PR 12, WS-E) ---------------------------

// Exactly-one-owner (WS-E gate): a thread is file-linked OR channel-owned —
// enforced at creation, failed closed on read. An ownerless thread would be
// readable and indexed but unreachable by navigation (an orphan), so neither
// creation nor a tampered row may produce one.
describe("thread ownership (exactly-one-owner)", () => {
  it("rejects ownerless thread creation through the legacy createThread", async () => {
    const chats = chatStore();
    await expect(
      chats.createThread({ workspaceId: "workspace-a", title: "Orphan" } as never),
    ).rejects.toMatchObject({ code: "invalid-thread-owner" });
    await expect(chats.listThreads({ workspaceId: "workspace-a" })).resolves.toEqual([]);
    await chats.close();
  });

  it("fails closed on a persisted thread with NO owner", async () => {
    const chats = chatStore();
    const thread = await chats.createThread({
      workspaceId: "workspace-a",
      title: "Owned",
      linkedFile: { objectId: "object-owned" },
    });
    await chats.close();
    rawExec(
      "UPDATE chat_threads SET linked_object_id = NULL, linked_path_hint = NULL, linked_at_ms = NULL WHERE thread_id = ?",
      thread.id,
    );
    const reopened = chatStore();
    await expect(
      reopened.listThreads({ workspaceId: "workspace-a" }),
    ).rejects.toMatchObject({ code: "state-corrupt" });
    await expect(
      reopened.listMessages({ workspaceId: "workspace-a", threadId: thread.id }),
    ).rejects.toMatchObject({ code: "state-corrupt" });
    await reopened.close();
  });

  it("fails closed on a channel thread whose channel does not exist", async () => {
    const chats = chatStore();
    const channel = await chats.ensureGeneralChannel({ workspaceId: "workspace-a" });
    const started = await chats.startChannelThread({
      workspaceId: "workspace-a",
      channelId: channel.id,
      author: { kind: "human", displayName: "You" },
      body: "Soon to be orphaned",
    });
    await chats.close();
    rawExec(
      "UPDATE chat_threads SET channel_id = 'ghost-channel' WHERE thread_id = ?",
      started.thread.id,
    );
    const reopened = chatStore();
    await expect(
      reopened.listThreads({ workspaceId: "workspace-a" }),
    ).rejects.toMatchObject({ code: "state-corrupt" });
    await expect(
      reopened.markThreadRead({
        workspaceId: "workspace-a",
        threadId: started.thread.id,
        upToSequence: 1,
      }),
    ).rejects.toMatchObject({ code: "state-corrupt" });
    await reopened.close();
  });
});

describe("chat channels", () => {
  it("creates a channel with a slug lookup alias derived from the name", async () => {
    const chats = chatStore();
    const channel = await chats.createChannel({
      workspaceId: "workspace-a",
      name: "Client ACME launch",
    });
    expect(channel).toMatchObject({
      id: "channel-1",
      workspaceId: "workspace-a",
      name: "Client ACME launch",
      slug: "client-acme-launch",
      kind: "channel",
    });
    // Slug resolves as an alias; durable identity stays the channel id.
    const bySlug = await chats.findChannelBySlug({
      workspaceId: "workspace-a",
      slug: "Client ACME  Launch",
    });
    expect(bySlug?.id).toBe("channel-1");
    await chats.close();
  });

  it("accepts the dm channel kind and rejects unknown kinds", async () => {
    const chats = chatStore();
    const dm = await chats.createChannel({
      workspaceId: "workspace-a",
      name: "Ice and Sarah",
      kind: "dm",
    });
    expect(dm.kind).toBe("dm");
    await expect(
      chats.createChannel({
        workspaceId: "workspace-a",
        name: "Bad kind",
        kind: "broadcast" as never,
      }),
    ).rejects.toMatchObject({ code: "invalid-channel-kind" });
    await chats.close();
  });

  it("rejects duplicate slugs and unusable names", async () => {
    const chats = chatStore();
    await chats.createChannel({ workspaceId: "workspace-a", name: "Product" });
    // Same slug through a different display spelling is a duplicate.
    await expect(
      chats.createChannel({ workspaceId: "workspace-a", name: "  product " }),
    ).rejects.toMatchObject({ code: "channel-exists" });
    // The SAME name in another workspace is fine (workspace-scoped).
    await expect(
      chats.createChannel({ workspaceId: "workspace-b", name: "Product" }),
    ).resolves.toMatchObject({ slug: "product" });
    await expect(
      chats.createChannel({ workspaceId: "workspace-a", name: "   " }),
    ).rejects.toMatchObject({ code: "invalid-channel-name" });
    await expect(
      chats.createChannel({ workspaceId: "workspace-a", name: "!!!" }),
    ).rejects.toMatchObject({ code: "invalid-channel-name" });
    await chats.close();
  });

  it("ensureGeneralChannel creates general once and returns it forever after", async () => {
    const chats = chatStore();
    const first = await chats.ensureGeneralChannel({ workspaceId: "workspace-a" });
    const second = await chats.ensureGeneralChannel({ workspaceId: "workspace-a" });
    expect(first).toMatchObject({ name: "general", slug: "general", kind: "channel" });
    expect(second.id).toBe(first.id);
    const channels = await chats.listChannels({ workspaceId: "workspace-a" });
    expect(channels).toHaveLength(1);
    expect(channels[0]).toMatchObject({
      id: first.id,
      threadCount: 0,
      unreadCount: 0,
    });
    await chats.close();
  });

  it("channels and their threads never leak across workspaces", async () => {
    const chats = chatStore();
    const channel = await chats.createChannel({ workspaceId: "workspace-a", name: "general" });
    await expect(
      chats.startChannelThread({
        workspaceId: "workspace-b",
        channelId: channel.id,
        author: { kind: "human", displayName: "You" },
        body: "Hello",
      }),
    ).rejects.toMatchObject({ code: "workspace-mismatch" });
    await expect(
      chats.listChannelThreads({ workspaceId: "workspace-b", channelId: channel.id }),
    ).rejects.toMatchObject({ code: "workspace-mismatch" });
    await expect(
      chats.startChannelThread({
        workspaceId: "workspace-a",
        channelId: "missing-channel",
        author: { kind: "human", displayName: "You" },
        body: "Hello",
      }),
    ).rejects.toMatchObject({ code: "channel-not-found" });
    expect(await chats.listChannels({ workspaceId: "workspace-b" })).toEqual([]);
    await chats.close();
  });
});

describe("channel threads", () => {
  it("starts an untitled thread whose display title is the first-message snippet", async () => {
    const chats = chatStore();
    const channel = await chats.ensureGeneralChannel({ workspaceId: "workspace-a" });
    const started = await chats.startChannelThread({
      workspaceId: "workspace-a",
      channelId: channel.id,
      author: { kind: "human", displayName: "You" },
      body: "Should we ship on Friday?\nSecond line ignored.",
    });
    expect(started.thread).toMatchObject({
      title: "Should we ship on Friday?",
      channelId: channel.id,
    });
    expect(started.thread.linkedFile).toBeUndefined();
    expect(started.message).toMatchObject({
      threadId: started.thread.id,
      body: "Should we ship on Friday?\nSecond line ignored.",
    });
    // The derived title also comes back from every read path.
    const listed = await chats.listChannelThreads({
      workspaceId: "workspace-a",
      channelId: channel.id,
    });
    expect(listed[0]?.thread.title).toBe("Should we ship on Friday?");
    const messages = await chats.listMessages({
      workspaceId: "workspace-a",
      threadId: started.thread.id,
    });
    expect(messages).toHaveLength(1);
    await chats.close();
  });

  it("bounds long snippet titles and honors an explicit title", async () => {
    const chats = chatStore();
    const channel = await chats.ensureGeneralChannel({ workspaceId: "workspace-a" });
    const longFirstLine = "word ".repeat(40).trim();
    const untitled = await chats.startChannelThread({
      workspaceId: "workspace-a",
      channelId: channel.id,
      author: { kind: "human", displayName: "You" },
      body: longFirstLine,
    });
    expect(untitled.thread.title.length).toBeLessThanOrEqual(80);
    expect(untitled.thread.title.endsWith("…")).toBe(true);
    const titled = await chats.startChannelThread({
      workspaceId: "workspace-a",
      channelId: channel.id,
      title: "Launch checklist",
      author: { kind: "human", displayName: "You" },
      body: "First item",
    });
    expect(titled.thread.title).toBe("Launch checklist");
    await chats.close();
  });

  it("orders channel threads by most recent activity", async () => {
    const chats = chatStore();
    const channel = await chats.ensureGeneralChannel({ workspaceId: "workspace-a" });
    const first = await chats.startChannelThread({
      workspaceId: "workspace-a",
      channelId: channel.id,
      author: { kind: "human", displayName: "You" },
      body: "First thread",
    });
    const second = await chats.startChannelThread({
      workspaceId: "workspace-a",
      channelId: channel.id,
      author: { kind: "human", displayName: "You" },
      body: "Second thread",
    });
    let threads = await chats.listChannelThreads({
      workspaceId: "workspace-a",
      channelId: channel.id,
    });
    expect(threads.map((entry) => entry.thread.id)).toEqual([
      second.thread.id,
      first.thread.id,
    ]);
    // New activity in the older thread moves it back to the top.
    await chats.sendMessage({
      workspaceId: "workspace-a",
      threadId: first.thread.id,
      author: { kind: "human", displayName: "You" },
      body: "Bump",
    });
    threads = await chats.listChannelThreads({
      workspaceId: "workspace-a",
      channelId: channel.id,
    });
    expect(threads.map((entry) => entry.thread.id)).toEqual([
      first.thread.id,
      second.thread.id,
    ]);
    await chats.close();
  });

  it("fails closed on a row claiming BOTH a file link and a channel (XOR ownership)", async () => {
    const chats = chatStore();
    const channel = await chats.ensureGeneralChannel({ workspaceId: "workspace-a" });
    const started = await chats.startChannelThread({
      workspaceId: "workspace-a",
      channelId: channel.id,
      author: { kind: "human", displayName: "You" },
      body: "Legit thread",
    });
    await chats.close();
    rawExec(
      "UPDATE chat_threads SET linked_object_id = 'object-x', linked_at_ms = 1 WHERE thread_id = ?",
      started.thread.id,
    );
    const reopened = chatStore();
    await expect(
      reopened.listThreads({ workspaceId: "workspace-a" }),
    ).rejects.toMatchObject({ code: "state-corrupt" });
    await expect(
      reopened.listChannelThreads({ workspaceId: "workspace-a", channelId: channel.id }),
    ).rejects.toMatchObject({ code: "state-corrupt" });
    await reopened.close();
  });

  it("indexes channel thread messages and snippet headers for search", async () => {
    const chats = chatStore();
    const channel = await chats.ensureGeneralChannel({ workspaceId: "workspace-a" });
    const started = await chats.startChannelThread({
      workspaceId: "workspace-a",
      channelId: channel.id,
      author: { kind: "human", displayName: "You" },
      body: "The quarterly budget needs a second pass.",
    });
    await chats.close();
    const rows = rawRows(
      "SELECT thread_id, message_id, text FROM engine_search_chat_messages_fts WHERE workspace_id = 'workspace-a'",
    );
    const forThread = rows.filter((row) => row.thread_id === started.thread.id);
    // One header row (the snippet display title) + one message row.
    expect(forThread.some((row) => String(row.text).includes("quarterly budget"))).toBe(true);
    expect(
      forThread.some(
        (row) =>
          row.message_id === "__thread__" &&
          String(row.text).includes("The quarterly budget needs a second pass."),
      ),
    ).toBe(true);
  });
});

describe("thread read cursors", () => {
  it("derives unread counts: human sends are read, agent sends are unread", async () => {
    const chats = chatStore();
    const channel = await chats.ensureGeneralChannel({ workspaceId: "workspace-a" });
    const started = await chats.startChannelThread({
      workspaceId: "workspace-a",
      channelId: channel.id,
      author: { kind: "human", displayName: "You" },
      body: "Kicking off",
    });
    let threads = await chats.listChannelThreads({
      workspaceId: "workspace-a",
      channelId: channel.id,
    });
    expect(threads[0]).toMatchObject({
      messageCount: 1,
      lastReadSequence: 1,
      unreadCount: 0,
    });

    await chats.sendMessage({
      workspaceId: "workspace-a",
      threadId: started.thread.id,
      author: { kind: "agent", displayName: "You" },
      body: "Agent reply one",
    });
    await chats.sendMessage({
      workspaceId: "workspace-a",
      threadId: started.thread.id,
      author: { kind: "agent", displayName: "You" },
      body: "Agent reply two",
    });
    threads = await chats.listChannelThreads({
      workspaceId: "workspace-a",
      channelId: channel.id,
    });
    expect(threads[0]).toMatchObject({ messageCount: 3, unreadCount: 2 });

    // Channel summary rolls the same unread up.
    const channels = await chats.listChannels({ workspaceId: "workspace-a" });
    expect(channels[0]).toMatchObject({ threadCount: 1, unreadCount: 2 });

    // A HUMAN send catches the cursor up (your own message is never unread,
    // and everything before it was on screen when you replied).
    await chats.sendMessage({
      workspaceId: "workspace-a",
      threadId: started.thread.id,
      author: { kind: "human", displayName: "You" },
      body: "Human reply",
    });
    threads = await chats.listChannelThreads({
      workspaceId: "workspace-a",
      channelId: channel.id,
    });
    expect(threads[0]).toMatchObject({ messageCount: 4, unreadCount: 0 });
    await chats.close();
  });

  it("threads started by an agent are fully unread until marked read", async () => {
    const chats = chatStore();
    const channel = await chats.ensureGeneralChannel({ workspaceId: "workspace-a" });
    const started = await chats.startChannelThread({
      workspaceId: "workspace-a",
      channelId: channel.id,
      author: { kind: "agent", displayName: "You" },
      body: "Ping from the agent",
    });
    let threads = await chats.listChannelThreads({
      workspaceId: "workspace-a",
      channelId: channel.id,
    });
    expect(threads[0]).toMatchObject({ messageCount: 1, unreadCount: 1 });

    const state = await chats.markThreadRead({
      workspaceId: "workspace-a",
      threadId: started.thread.id,
      upToSequence: 1,
    });
    expect(state).toMatchObject({ lastReadSequence: 1, revision: 1 });
    threads = await chats.listChannelThreads({
      workspaceId: "workspace-a",
      channelId: channel.id,
    });
    expect(threads[0]?.unreadCount).toBe(0);
    await chats.close();
  });

  it("cursors are monotonic, clamped, and revisioned by the store", async () => {
    const chats = chatStore();
    const channel = await chats.ensureGeneralChannel({ workspaceId: "workspace-a" });
    const started = await chats.startChannelThread({
      workspaceId: "workspace-a",
      channelId: channel.id,
      author: { kind: "agent", displayName: "You" },
      body: "One",
    });
    await chats.sendMessage({
      workspaceId: "workspace-a",
      threadId: started.thread.id,
      author: { kind: "agent", displayName: "You" },
      body: "Two",
    });

    const advanced = await chats.markThreadRead({
      workspaceId: "workspace-a",
      threadId: started.thread.id,
      upToSequence: 2,
    });
    expect(advanced).toMatchObject({ lastReadSequence: 2, revision: 1 });

    // Backwards mark is a NO-OP: cursor and revision both hold.
    const backwards = await chats.markThreadRead({
      workspaceId: "workspace-a",
      threadId: started.thread.id,
      upToSequence: 1,
    });
    expect(backwards).toMatchObject({ lastReadSequence: 2, revision: 1 });

    // Beyond-the-end clamps to the real message count (a "mark all read"
    // caller can pass a huge sequence safely) — already at 2, so no-op.
    const clamped = await chats.markThreadRead({
      workspaceId: "workspace-a",
      threadId: started.thread.id,
      upToSequence: Number.MAX_SAFE_INTEGER,
    });
    expect(clamped).toMatchObject({ lastReadSequence: 2, revision: 1 });

    await expect(
      chats.markThreadRead({
        workspaceId: "workspace-a",
        threadId: started.thread.id,
        upToSequence: -1,
      }),
    ).rejects.toMatchObject({ code: "invalid-read-cursor" });
    await expect(
      chats.markThreadRead({
        workspaceId: "workspace-a",
        threadId: started.thread.id,
        upToSequence: 1.5,
      }),
    ).rejects.toMatchObject({ code: "invalid-read-cursor" });
    await expect(
      chats.markThreadRead({
        workspaceId: "workspace-a",
        threadId: "missing-thread",
        upToSequence: 1,
      }),
    ).rejects.toMatchObject({ code: "thread-not-found" });
    await expect(
      chats.markThreadRead({
        workspaceId: "workspace-b",
        threadId: started.thread.id,
        upToSequence: 1,
      }),
    ).rejects.toMatchObject({ code: "workspace-mismatch" });
    await chats.close();
  });

  it("CAS: a stale expectedRevision fails instead of silently applying", async () => {
    const chats = chatStore();
    const channel = await chats.ensureGeneralChannel({ workspaceId: "workspace-a" });
    const started = await chats.startChannelThread({
      workspaceId: "workspace-a",
      channelId: channel.id,
      author: { kind: "agent", displayName: "You" },
      body: "One",
    });
    // Correct expectation applies (fresh cursor is revision 0).
    const applied = await chats.markThreadRead({
      workspaceId: "workspace-a",
      threadId: started.thread.id,
      upToSequence: 1,
      expectedRevision: 0,
    });
    expect(applied).toMatchObject({ lastReadSequence: 1, revision: 1 });
    // Stale expectation fails closed.
    await expect(
      chats.markThreadRead({
        workspaceId: "workspace-a",
        threadId: started.thread.id,
        upToSequence: 1,
        expectedRevision: 0,
      }),
    ).rejects.toMatchObject({ code: "read-state-revision-mismatch" });
    await chats.close();
  });

  it("read state survives reopen and reads back after close", async () => {
    const chats = chatStore();
    const channel = await chats.ensureGeneralChannel({ workspaceId: "workspace-a" });
    const started = await chats.startChannelThread({
      workspaceId: "workspace-a",
      channelId: channel.id,
      author: { kind: "agent", displayName: "You" },
      body: "Durable?",
    });
    await chats.markThreadRead({
      workspaceId: "workspace-a",
      threadId: started.thread.id,
      upToSequence: 1,
    });
    await chats.close();

    const reopened = chatStore();
    const threads = await reopened.listChannelThreads({
      workspaceId: "workspace-a",
      channelId: channel.id,
    });
    expect(threads[0]).toMatchObject({ lastReadSequence: 1, unreadCount: 0 });
    await reopened.close();
  });

  // A tampered OVER-COUNT cursor (> message count) used to make every future
  // advance a no-op — unread counts were silently stuck at zero forever. The
  // store now clamps on read and persists the repair on the next mark-read.
  it("clamps a tampered over-count cursor and repairs it in place", async () => {
    const chats = chatStore();
    const channel = await chats.ensureGeneralChannel({ workspaceId: "workspace-a" });
    const started = await chats.startChannelThread({
      workspaceId: "workspace-a",
      channelId: channel.id,
      author: { kind: "agent", displayName: "You" },
      body: "One",
    });
    await chats.markThreadRead({
      workspaceId: "workspace-a",
      threadId: started.thread.id,
      upToSequence: 1,
    });
    // close() flushes; the SAME store lazily reopens below (fresh stores
    // would reset the deterministic id counters and collide on message ids).
    await chats.close();
    rawExec(
      "UPDATE chat_thread_read_state SET last_read_sequence = 999 WHERE thread_id = ?",
      started.thread.id,
    );

    const reopened = chats;
    // The summary never claims more read than exists.
    let threads = await reopened.listChannelThreads({
      workspaceId: "workspace-a",
      channelId: channel.id,
    });
    expect(threads[0]).toMatchObject({
      messageCount: 1,
      lastReadSequence: 1,
      unreadCount: 0,
    });
    // A mark-read persists the clamp; the revision holds (a repair is not an
    // applied advance).
    const repaired = await reopened.markThreadRead({
      workspaceId: "workspace-a",
      threadId: started.thread.id,
      upToSequence: 1,
    });
    expect(repaired).toMatchObject({ lastReadSequence: 1, revision: 1 });
    expect(
      rawRows(
        "SELECT last_read_sequence FROM chat_thread_read_state WHERE thread_id = ?",
        started.thread.id,
      ),
    ).toEqual([{ last_read_sequence: 1 }]);
    // Unread math works again: a new agent message surfaces as unread and a
    // real advance applies normally.
    await reopened.sendMessage({
      workspaceId: "workspace-a",
      threadId: started.thread.id,
      author: { kind: "agent", displayName: "You" },
      body: "Two",
    });
    threads = await reopened.listChannelThreads({
      workspaceId: "workspace-a",
      channelId: channel.id,
    });
    expect(threads[0]).toMatchObject({ messageCount: 2, unreadCount: 1 });
    const advanced = await reopened.markThreadRead({
      workspaceId: "workspace-a",
      threadId: started.thread.id,
      upToSequence: 2,
    });
    expect(advanced).toMatchObject({ lastReadSequence: 2, revision: 2 });
    await reopened.close();
  });

  it("fails closed on a negative or non-integer persisted cursor", async () => {
    const chats = chatStore();
    const channel = await chats.ensureGeneralChannel({ workspaceId: "workspace-a" });
    const started = await chats.startChannelThread({
      workspaceId: "workspace-a",
      channelId: channel.id,
      author: { kind: "agent", displayName: "You" },
      body: "One",
    });
    await chats.markThreadRead({
      workspaceId: "workspace-a",
      threadId: started.thread.id,
      upToSequence: 1,
    });
    await chats.close();
    rawExec(
      "UPDATE chat_thread_read_state SET last_read_sequence = -3 WHERE thread_id = ?",
      started.thread.id,
    );

    const reopened = chatStore();
    await expect(
      reopened.listChannelThreads({ workspaceId: "workspace-a", channelId: channel.id }),
    ).rejects.toMatchObject({ code: "state-corrupt" });
    await expect(
      reopened.listChannels({ workspaceId: "workspace-a" }),
    ).rejects.toMatchObject({ code: "state-corrupt" });
    await expect(
      reopened.markThreadRead({
        workspaceId: "workspace-a",
        threadId: started.thread.id,
        upToSequence: 1,
      }),
    ).rejects.toMatchObject({ code: "state-corrupt" });
    await reopened.close();

    rawExec(
      "UPDATE chat_thread_read_state SET last_read_sequence = 0.5 WHERE thread_id = ?",
      started.thread.id,
    );
    const fractional = chatStore();
    await expect(
      fractional.listChannelThreads({ workspaceId: "workspace-a", channelId: channel.id }),
    ).rejects.toMatchObject({ code: "state-corrupt" });
    await fractional.close();
  });
});

// --- FTS rebuild parity (WS-E gate) ------------------------------------------

describe("chat search index rebuild", () => {
  it("rebuilding after a wipe reproduces identical rows, including snippet titles", async () => {
    const versions = versionStore();
    const main = await versions.ensureMainVersion({ workspaceId: "workspace-a" });
    const file = await versions.writeTextFile({
      workspaceId: "workspace-a",
      versionId: main.id,
      path: "docs/plan.md",
      text: "Plan\n",
      metadata: { origin: "local-file", summary: "seed file" },
    });
    const chats = chatStore();
    const linked = await chats.createThread({
      workspaceId: "workspace-a",
      title: "Plan discussion",
      linkedFile: { objectId: file.object.id, pathHint: "docs/plan.md" },
    });
    await chats.sendMessage({
      workspaceId: "workspace-a",
      threadId: linked.id,
      author: { kind: "human", displayName: "Ice" },
      body: "Keep the plan close.",
    });
    const channel = await chats.ensureGeneralChannel({ workspaceId: "workspace-a" });
    await chats.startChannelThread({
      workspaceId: "workspace-a",
      channelId: channel.id,
      author: { kind: "agent", displayName: "Ice" },
      body: "Untitled snippet title here.\nSecond line ignored.",
    });
    await chats.close();

    const selectRows =
      "SELECT thread_id, message_id, text FROM engine_search_chat_messages_fts WHERE workspace_id = 'workspace-a' ORDER BY thread_id, message_id";
    const writeTimeRows = rawRows(selectRows);
    // The untitled channel thread's header row carries its SNIPPET title.
    expect(
      writeTimeRows.some(
        (row) => row.message_id === "__thread__" && row.text === "Untitled snippet title here.",
      ),
    ).toBe(true);

    // Wipe the FTS + index state (the rebuild trigger), then rebuild.
    rawExec("DELETE FROM engine_search_chat_messages_fts");
    rawExec("DELETE FROM engine_search_index_state");
    if (!versions.ensureSearchIndex) throw new Error("ensureSearchIndex missing");
    await versions.ensureSearchIndex({ workspaceId: "workspace-a", versionId: main.id });

    expect(rawRows(selectRows)).toEqual(writeTimeRows);
    await versions.close();
  });

  it("the rebuild fails closed on a thread pointing at a missing channel", async () => {
    const versions = versionStore();
    const main = await versions.ensureMainVersion({ workspaceId: "workspace-a" });
    const chats = chatStore();
    const channel = await chats.ensureGeneralChannel({ workspaceId: "workspace-a" });
    const started = await chats.startChannelThread({
      workspaceId: "workspace-a",
      channelId: channel.id,
      author: { kind: "human", displayName: "You" },
      body: "Legit at write time",
    });
    await chats.close();
    rawExec(
      "UPDATE chat_threads SET channel_id = 'ghost-channel' WHERE thread_id = ?",
      started.thread.id,
    );
    rawExec("DELETE FROM engine_search_index_state");

    if (!versions.ensureSearchIndex) throw new Error("ensureSearchIndex missing");
    await expect(
      versions.ensureSearchIndex({ workspaceId: "workspace-a", versionId: main.id }),
    ).rejects.toMatchObject({ code: "state-corrupt" });
    await versions.close();
  });
});
