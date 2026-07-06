import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createLinkedChatStore, linkedChatProjectionPath } from "./linkedChatStore";
import { createVersionedTextStore } from "./versionedTextStore";
import { resolveEffectivePolicy, type FilesPolicyRule } from "./effectivePolicy";
import { classifyEngineFilePath, searchWorkspaceEngine } from "./workspaceSearch";

let root: string;
let now = 1000;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "dohc-workspace-search-"));
  now = 1000;
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

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

async function seededStores() {
  const versions = versionStore();
  const chats = chatStore();
  const main = await versions.ensureMainVersion({ workspaceId: "workspace-a" });
  const file = await versions.writeTextFile({
    workspaceId: "workspace-a",
    versionId: main.id,
    path: "docs/plan.md",
    text: "Launch plan\n\nThe alpha keyword lives here.\n",
    metadata: { origin: "local-file", summary: "seed plan" },
  });
  // PR 08: the text store's write gate now refuses secret paths outright, so
  // plaintext .env content can never be seeded here in the first place (the
  // secret store tests cover secret-content search denial end to end).
  await expect(
    versions.writeTextFile({
      workspaceId: "workspace-a",
      versionId: main.id,
      path: ".env",
      text: "ALPHA_SECRET=do-not-index\n",
      metadata: { origin: "local-file", summary: "seed secret" },
    }),
  ).rejects.toMatchObject({ code: "invalid-path" });
  const thread = await chats.createThread({
    workspaceId: "workspace-a",
    title: "Plan discussion",
    linkedFile: { objectId: file.object.id, pathHint: "docs/plan.md" },
  });
  await chats.sendMessage({
    workspaceId: "workspace-a",
    threadId: thread.id,
    author: { kind: "human", displayName: "Ice" },
    body: "The chat alpha keyword should also search.",
  });
  return { chats, file, main, thread, versions };
}

describe("workspace engine search", () => {
  it("returns file and linked chat hits through one bounded result list", async () => {
    const { chats, main, thread, versions } = await seededStores();

    const results = await searchWorkspaceEngine({
      workspaceId: "workspace-a",
      versionId: main.id,
      query: "alpha",
      versions,
      chats,
    });

    expect(results).toMatchObject([
      {
        surface: "file",
        path: "docs/plan.md",
        line: 3,
        objectId: "object-1",
      },
      {
        surface: "chat",
        path: linkedChatProjectionPath({ workspaceId: "workspace-a", threadId: thread.id }),
        threadId: thread.id,
      },
    ]);
    expect(results[0]?.preview).toContain("alpha keyword");
    expect(results[1]?.preview).toContain("chat alpha keyword");
  });

  it("defaults .env files to excluded from search", async () => {
    const { chats, main, versions } = await seededStores();

    const results = await searchWorkspaceEngine({
      workspaceId: "workspace-a",
      versionId: main.id,
      query: "ALPHA_SECRET",
      versions,
      chats,
    });

    expect(results).toEqual([]);
  });

  it("lets policy hide individual files while still searching visible chats", async () => {
    const { chats, main, versions } = await seededStores();

    const results = await searchWorkspaceEngine({
      workspaceId: "workspace-a",
      versionId: main.id,
      query: "alpha",
      versions,
      chats,
      policy: {
        fileVisibility: (file) =>
          file.path === "docs/plan.md"
            ? { searchable: false, reason: "permission-denied" }
            : { searchable: true },
      },
    });

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ surface: "chat" });
  });

  it("honors resolver-backed files policy searchable false at the search seam", async () => {
    const { chats, main, versions } = await seededStores();
    const filesPolicy: FilesPolicyRule[] = [
      { path: "docs/**", searchable: false },
    ];

    const results = await searchWorkspaceEngine({
      workspaceId: "workspace-a",
      versionId: main.id,
      query: "alpha",
      versions,
      chats,
      policy: {
        fileVisibility: (file) => {
          const policy = resolveEffectivePolicy({ path: file.path, filesPolicy });
          return policy.searchable
            ? { searchable: true }
            : {
                searchable: false,
                reason: policy.floor === "tracked" ? "permission-denied" : policy.floor,
              };
        },
      },
    });

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ surface: "chat" });
  });

  it("does not leak denied linked file metadata through chat search", async () => {
    const { chats, main, thread, versions } = await seededStores();

    await chats.sendMessage({
      workspaceId: "workspace-a",
      threadId: thread.id,
      author: { kind: "human", displayName: "Ice" },
      body: "Look for the unavailable marker.",
    });
    const results = await searchWorkspaceEngine({
      workspaceId: "workspace-a",
      versionId: main.id,
      query: "Linked file: unavailable",
      versions,
      chats,
      policy: {
        chatVisibility: () => ({
          searchable: true,
          projectionFileAccess: { kind: "denied" },
        }),
      },
    });

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ surface: "chat", threadId: thread.id });
    expect(results[0]?.preview).toContain("Linked file: unavailable");
    expect(JSON.stringify(results)).not.toContain("docs/plan.md");
    expect(JSON.stringify(results)).not.toContain("object-1");
  });

  it("honors the result limit across files and chats", async () => {
    const { chats, main, versions } = await seededStores();

    const results = await searchWorkspaceEngine({
      workspaceId: "workspace-a",
      versionId: main.id,
      query: "alpha",
      versions,
      chats,
      limit: 1,
    });

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ surface: "file" });
  });

  it("returns no results for blank queries", async () => {
    const { chats, main, versions } = await seededStores();

    await expect(
      searchWorkspaceEngine({
        workspaceId: "workspace-a",
        versionId: main.id,
        query: "   ",
        versions,
        chats,
      }),
    ).resolves.toEqual([]);
  });
});

describe("engine file path classifier (shared by search and capture)", () => {
  it("tracks ordinary workspace text paths", () => {
    expect(classifyEngineFilePath("notes/today.md")).toEqual({ kind: "tracked" });
    expect(classifyEngineFilePath("environment.md")).toEqual({ kind: "tracked" });
  });

  it("classifies .env-style secret paths at any depth or case", () => {
    expect(classifyEngineFilePath(".env")).toEqual({ kind: "secret" });
    expect(classifyEngineFilePath("config/.ENV")).toEqual({ kind: "secret" });
    expect(classifyEngineFilePath("apps/site/.env/local")).toEqual({ kind: "secret" });
    expect(classifyEngineFilePath("deploy/prod.env")).toEqual({ kind: "secret" });
  });

  it("classifies the whole .env.* family as secret (CodeRabbit critical)", () => {
    // .env.local / .env.production previously fell through to tracked and
    // would have been captured and indexed in PLAINTEXT.
    expect(classifyEngineFilePath(".env.local")).toEqual({ kind: "secret" });
    expect(classifyEngineFilePath(".env.production")).toEqual({ kind: "secret" });
    expect(classifyEngineFilePath("apps/site/.env.development")).toEqual({ kind: "secret" });
    expect(classifyEngineFilePath("config/.ENV.LOCAL")).toEqual({ kind: "secret" });
    // Deliberate over-classification: placeholders are protected too.
    expect(classifyEngineFilePath(".env.example")).toEqual({ kind: "secret" });
    // Non-family lookalikes stay tracked.
    expect(classifyEngineFilePath("notes/envelope.md")).toEqual({ kind: "tracked" });
    expect(classifyEngineFilePath("environments.md")).toEqual({ kind: "tracked" });
  });

  it("classifies percent-encoded .env disguises on the decoded path", () => {
    // validateUserWritePath decodes %2e -> "." and %2f -> "/" (and the
    // double-encoded forms); the secret checks must see the decoded path or
    // "secrets%2eenv" leaks into capture and search as tracked.
    expect(classifyEngineFilePath("secrets%2eenv")).toEqual({ kind: "secret" });
    expect(classifyEngineFilePath("secrets%252eenv")).toEqual({ kind: "secret" });
    expect(classifyEngineFilePath("config%2f.env")).toEqual({ kind: "secret" });
    expect(classifyEngineFilePath("%2eenv")).toEqual({ kind: "secret" });
  });

  it("classifies ignored and invalid paths as ignored", () => {
    expect(classifyEngineFilePath(".dohc/engine/engine.db")).toEqual({ kind: "ignored" });
    expect(classifyEngineFilePath("node_modules/pkg/index.js")).toEqual({ kind: "ignored" });
    expect(classifyEngineFilePath(".git/HEAD")).toEqual({ kind: "ignored" });
    expect(classifyEngineFilePath("../outside.md")).toEqual({ kind: "ignored" });
    expect(classifyEngineFilePath("")).toEqual({ kind: "ignored" });
  });
});
