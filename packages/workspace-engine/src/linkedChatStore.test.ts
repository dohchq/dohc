import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
    await mkdir(join(root, ".dohc", "engine"), { recursive: true });
    await writeFile(join(root, LINKED_CHAT_STORE_RELATIVE_PATH), "{\"schemaVersion\":2}\n");
    const chats = createLinkedChatStore(root);

    await expect(chats.listThreads({ workspaceId: "workspace-a" })).rejects.toBeInstanceOf(
      LinkedChatStoreError,
    );
    await expect(chats.listThreads({ workspaceId: "workspace-a" })).rejects.toMatchObject({
      code: "state-corrupt",
    });
  });

  it("persists inspectable JSON and reloads the same thread", async () => {
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

    const raw = await readFile(join(root, LINKED_CHAT_STORE_RELATIVE_PATH), "utf8");
    expect(JSON.parse(raw).schemaVersion).toBe(1);
    const reloaded = createLinkedChatStore(root);

    await expect(reloaded.listThreads({ workspaceId: "workspace-a" })).resolves.toMatchObject([
      { id: thread.id, title: "Durable thread" },
    ]);
    await expect(
      reloaded.listMessages({ workspaceId: "workspace-a", threadId: thread.id }),
    ).resolves.toMatchObject([{ body: "This survives reload." }]);
  });
});
