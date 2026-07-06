import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
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
  await rm(root, { recursive: true, force: true });
});

function chatStore() {
  const counters = { message: 0, thread: 0 };
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
    await chats.createThread({ workspaceId: "workspace-a", title: "Seed" });
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
    });
    // Force the store's connection open before taking the competing lock so
    // schema bootstrap does not sit inside the contention window.
    await chats.listThreads({ workspaceId: "workspace-a" });

    const { spawn } = requireModule("node:child_process") as typeof import("node:child_process");
    const dbPath = join(root, LINKED_CHAT_STORE_RELATIVE_PATH);
    const holdScript = `
      const { DatabaseSync } = require("node:sqlite");
      const db = new DatabaseSync(process.argv[1]);
      db.exec("BEGIN IMMEDIATE");
      process.stdout.write("locked\\n");
      setTimeout(() => {
        db.exec("COMMIT");
        db.close();
      }, 400);
    `;
    const holder = spawn(process.execPath, ["-e", holdScript, dbPath], {
      stdio: ["ignore", "pipe", "inherit"],
    });
    try {
      await new Promise<void>((resolve, reject) => {
        holder.stdout.on("data", (chunk: Buffer) => {
          if (chunk.toString("utf8").includes("locked")) resolve();
        });
        holder.on("exit", (code) =>
          reject(new Error(`lock holder exited early (${code})`)),
        );
        holder.on("error", reject);
      });
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
    await chats.createThread({ workspaceId: "workspace-a", title: "First" });

    const texts = versionStore();
    await expect(
      texts.ensureMainVersion({ workspaceId: "workspace-a" }),
    ).resolves.toMatchObject({ id: "main" });
    await expect(
      texts.setActiveVersion({ workspaceId: "workspace-a", versionId: "main" }),
    ).resolves.toMatchObject({ id: "main" });
  });
});
