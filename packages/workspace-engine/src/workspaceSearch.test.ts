import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeTrackedEngineDbHandlesForTest } from "./engineDbSchema";
import { createLinkedChatStore, linkedChatProjectionPath } from "./linkedChatStore";
import { VERSIONED_TEXT_STORE_RELATIVE_PATH, createVersionedTextStore } from "./versionedTextStore";
import { resolveEffectivePolicy, type FilesPolicyRule } from "./effectivePolicy";
import {
  classifyEngineFilePath,
  classifyEngineFilePathForRead,
  searchWorkspaceEngine,
} from "./workspaceSearch";

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
  root = await mkdtemp(join(tmpdir(), "dohc-workspace-search-"));
  now = 1000;
});

afterEach(async () => {
  closeTrackedEngineDbHandlesForTest();
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
  it("confirms FTS5 is available in node:sqlite", () => {
    const db = new DatabaseSync(":memory:");
    try {
      db.exec("CREATE VIRTUAL TABLE fts_probe USING fts5(text, tokenize='trigram')");
      db.prepare("INSERT INTO fts_probe (text) VALUES (?)").run("alpha availability");
      expect(
        db.prepare("SELECT text FROM fts_probe WHERE fts_probe MATCH ?").get('"avail"')?.text,
      ).toBe("alpha availability");
    } finally {
      db.close();
    }
  });

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

  it("finds messages in channel threads (PR 12: search spans channels too)", async () => {
    const { chats, main, versions } = await seededStores();
    const channel = await chats.ensureGeneralChannel({ workspaceId: "workspace-a" });
    const started = await chats.startChannelThread({
      workspaceId: "workspace-a",
      channelId: channel.id,
      author: { kind: "human", displayName: "Ice" },
      body: "The channelalpha keyword lives in a channel thread.",
    });

    const results = await searchWorkspaceEngine({
      workspaceId: "workspace-a",
      versionId: main.id,
      query: "channelalpha",
      versions,
      chats,
    });

    // The query hits both the snippet-derived projection heading and the
    // message body; every hit belongs to the channel thread.
    expect(results.length).toBeGreaterThanOrEqual(1);
    for (const result of results) {
      expect(result).toMatchObject({
        surface: "chat",
        threadId: started.thread.id,
        // The untitled thread surfaces under its snippet display title.
        title: "The channelalpha keyword lives in a channel thread.",
      });
    }
    expect(
      results.some((result) =>
        result.preview.includes("channelalpha keyword lives in a channel thread."),
      ),
    ).toBe(true);
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

  it("does not index direct secret writes, including raw FTS table content", async () => {
    const versions = versionStore();
    const chats = chatStore();
    const main = await versions.ensureMainVersion({ workspaceId: "workspace-a" });
    // Post-WS-C the plaintext write gate refuses the write outright — the
    // strongest exclusion: the needle can never even reach the store, let
    // alone the index.
    await expect(
      versions.writeTextFile({
        workspaceId: "workspace-a",
        versionId: main.id,
        path: "secrets.env",
        text: "DISTINCT_SECRET_NEEDLE=never\n",
        metadata: { origin: "api" },
      }),
    ).rejects.toMatchObject({ code: "invalid-path" });

    await expect(
      searchWorkspaceEngine({
        workspaceId: "workspace-a",
        versionId: main.id,
        query: "DISTINCT_SECRET_NEEDLE",
        versions,
        chats,
      }),
    ).resolves.toEqual([]);

    const db = new DatabaseSync(join(root, VERSIONED_TEXT_STORE_RELATIVE_PATH));
    try {
      const rows = db.prepare("SELECT path, text FROM engine_search_files_fts").all();
      expect(JSON.stringify(rows)).not.toContain("DISTINCT_SECRET_NEEDLE");
      expect(JSON.stringify(rows)).not.toContain("secrets.env");
    } finally {
      db.close();
    }
  });

  it("keeps the index consistent through mutation rollback (codex-review major)", async () => {
    const versions = versionStore();
    const chats = chatStore();
    const main = await versions.ensureMainVersion({ workspaceId: "workspace-a" });
    await versions.writeTextFile({
      workspaceId: "workspace-a",
      versionId: main.id,
      path: "notes/keep.md",
      text: "durable ROLLBACK_KEEP_NEEDLE text\n",
      metadata: { origin: "api" },
    });
    const write = await versions.writeTextFile({
      workspaceId: "workspace-a",
      versionId: main.id,
      path: "notes/rolled.md",
      text: "ROLLBACK_GONE_NEEDLE should vanish\n",
      metadata: { origin: "api" },
    });
    // Populate the index for the version, then roll the second write back.
    await searchWorkspaceEngine({
      workspaceId: "workspace-a",
      versionId: main.id,
      query: "ROLLBACK_GONE_NEEDLE",
      versions,
      chats,
    });
    await versions.rollbackTextFileMutation({
      workspaceId: "workspace-a",
      versionId: main.id,
      path: "notes/rolled.md",
      mutationMomentId: write.moment.id,
    });
    await expect(
      searchWorkspaceEngine({
        workspaceId: "workspace-a",
        versionId: main.id,
        query: "ROLLBACK_GONE_NEEDLE",
        versions,
        chats,
      }),
    ).resolves.toEqual([]);
    // The untouched file stays searchable and the raw table holds no trace
    // of the rolled-back text.
    await expect(
      searchWorkspaceEngine({
        workspaceId: "workspace-a",
        versionId: main.id,
        query: "ROLLBACK_KEEP_NEEDLE",
        versions,
        chats,
      }),
    ).resolves.toMatchObject([{ path: "notes/keep.md" }]);
    const db = new DatabaseSync(join(root, VERSIONED_TEXT_STORE_RELATIVE_PATH));
    try {
      const rows = db.prepare("SELECT text FROM engine_search_files_fts").all();
      expect(JSON.stringify(rows)).not.toContain("ROLLBACK_GONE_NEEDLE");
    } finally {
      db.close();
    }
  });

  it("never indexes or returns files hidden by visibility.toml (codex-review major)", async () => {
    await mkdir(join(root, ".dohc"), { recursive: true });
    await writeFile(
      join(root, ".dohc", "visibility.toml"),
      '[[rule]]\npath = "private/**"\nvisibility = "hidden"\n',
    );
    const versions = versionStore();
    const chats = chatStore();
    const main = await versions.ensureMainVersion({ workspaceId: "workspace-a" });
    await versions.writeTextFile({
      workspaceId: "workspace-a",
      versionId: main.id,
      path: "private/plans.md",
      text: "HIDDEN_VISIBILITY_NEEDLE\n",
      metadata: { origin: "api" },
    });
    await expect(
      searchWorkspaceEngine({
        workspaceId: "workspace-a",
        versionId: main.id,
        query: "HIDDEN_VISIBILITY_NEEDLE",
        versions,
        chats,
      }),
    ).resolves.toEqual([]);
    const db = new DatabaseSync(join(root, VERSIONED_TEXT_STORE_RELATIVE_PATH));
    try {
      const rows = db.prepare("SELECT text FROM engine_search_files_fts").all();
      expect(JSON.stringify(rows)).not.toContain("HIDDEN_VISIBILITY_NEEDLE");
    } finally {
      db.close();
    }
  });

  it("searches a freshly forked version and incrementally reflects a write in the fork", async () => {
    const versions = versionStore();
    const chats = chatStore();
    const main = await versions.ensureMainVersion({ workspaceId: "workspace-a" });
    for (let index = 0; index < 5; index += 1) {
      await versions.writeTextFile({
        workspaceId: "workspace-a",
        versionId: main.id,
        path: `docs/file-${index}.md`,
        text: `Inherited cow-keyword ${index}\n`,
        metadata: { origin: "api" },
      });
    }
    const fork = await versions.createNamedVersion({
      workspaceId: "workspace-a",
      name: "Fork",
      fromVersionId: main.id,
    });
    await versions.setActiveVersion({ workspaceId: "workspace-a", versionId: fork.id });

    const inherited = await searchWorkspaceEngine({
      workspaceId: "workspace-a",
      versionId: fork.id,
      query: "cow-keyword",
      versions,
      chats,
    });
    expect(inherited).toHaveLength(5);

    await versions.writeTextFile({
      workspaceId: "workspace-a",
      versionId: fork.id,
      path: "docs/file-2.md",
      text: "Fork-only indexed needle\n",
      metadata: { origin: "api" },
    });
    await expect(
      searchWorkspaceEngine({
        workspaceId: "workspace-a",
        versionId: fork.id,
        query: "fork-only",
        versions,
        chats,
      }),
    ).resolves.toMatchObject([{ path: "docs/file-2.md" }]);
  });

  it("re-checks policy at read time after a searchable file is narrowed", async () => {
    const versions = versionStore();
    const chats = chatStore();
    const main = await versions.ensureMainVersion({ workspaceId: "workspace-a" });
    await versions.writeTextFile({
      workspaceId: "workspace-a",
      versionId: main.id,
      path: "docs/policy.md",
      text: "Policy narrowing needle\n",
      metadata: { origin: "api" },
    });
    await expect(
      searchWorkspaceEngine({
        workspaceId: "workspace-a",
        versionId: main.id,
        query: "narrowing",
        versions,
        chats,
      }),
    ).resolves.toHaveLength(1);

    await mkdir(join(root, ".dohc"), { recursive: true });
    await writeFile(
      join(root, ".dohc", "files.toml"),
      '[[rule]]\npath = "docs/**"\nsearchable = false\n',
    );
    await expect(
      searchWorkspaceEngine({
        workspaceId: "workspace-a",
        versionId: main.id,
        query: "narrowing",
        versions,
        chats,
      }),
    ).resolves.toEqual([]);
  });

  it("keeps indexed and linear search content equivalent for searchable results", async () => {
    const { chats, main, versions } = await seededStores();
    const linearVersions = {
      ...versions,
      ensureSearchIndex: undefined,
      querySearchIndex: undefined,
    };

    const indexed = await searchWorkspaceEngine({
      workspaceId: "workspace-a",
      versionId: main.id,
      query: "alpha",
      versions,
      chats,
    });
    const linear = await searchWorkspaceEngine({
      workspaceId: "workspace-a",
      versionId: main.id,
      query: "alpha",
      versions: linearVersions,
      chats,
    });

    expect(indexed).toEqual(linear);
  });

  it("hands custom visibility hooks the REAL snapshot and thread on the indexed path (CodeRabbit major)", async () => {
    const { chats, main, versions } = await seededStores();
    const linearVersions = {
      ...versions,
      ensureSearchIndex: undefined,
      querySearchIndex: undefined,
    };
    // These hooks make decisions from fields a synthetic candidate cast gets
    // wrong: the seeded file's REAL snapshot has origin "local-file", summary
    // "seed plan" and a positive updatedAtMs (the old indexed path fabricated
    // origin "api" / updatedAtMs 0 and would have kept the file visible); the
    // REAL thread has a title and linkedFile (the old cast had neither and
    // would have hidden the chat).
    const policy = {
      fileVisibility: (file: { metadata: { summary?: string }; updatedAtMs: number }) =>
        file.metadata.summary === "seed plan" && file.updatedAtMs > 0
          ? ({ searchable: false, reason: "permission-denied" } as const)
          : ({ searchable: true } as const),
      chatVisibility: (thread: { title?: string; linkedFile?: unknown }) =>
        thread.title === "Plan discussion" && thread.linkedFile
          ? ({ searchable: true } as const)
          : ({ searchable: false, reason: "permission-denied" } as const),
    };

    const indexed = await searchWorkspaceEngine({
      workspaceId: "workspace-a",
      versionId: main.id,
      query: "alpha",
      versions,
      chats,
      policy,
    });
    const linear = await searchWorkspaceEngine({
      workspaceId: "workspace-a",
      versionId: main.id,
      query: "alpha",
      versions: linearVersions,
      chats,
      policy,
    });

    expect(indexed).toEqual(linear);
    expect(indexed).toHaveLength(1);
    expect(indexed[0]).toMatchObject({ surface: "chat" });
  });

  it("fills the page from later index hits when hooks hide the leading candidates (CodeRabbit major)", async () => {
    const versions = versionStore();
    const chats = chatStore();
    const main = await versions.ensureMainVersion({ workspaceId: "workspace-a" });
    for (let index = 0; index < 10; index += 1) {
      await versions.writeTextFile({
        workspaceId: "workspace-a",
        versionId: main.id,
        path: `bulk/file-${index}.md`,
        text: `page-needle body ${index}\n`,
        metadata: { origin: "api" },
      });
    }
    const policy = {
      // Hide the first eight files — the index returns candidates in write
      // order, so a single limit-sized candidate fetch would see only hidden
      // files and report an empty page while file-8/file-9 stay unread.
      fileVisibility: (file: { path: string }) =>
        file.path === "bulk/file-8.md" || file.path === "bulk/file-9.md"
          ? ({ searchable: true } as const)
          : ({ searchable: false, reason: "permission-denied" } as const),
    };

    const fullPage = await searchWorkspaceEngine({
      workspaceId: "workspace-a",
      versionId: main.id,
      query: "page-needle",
      versions,
      chats,
      policy,
      limit: 2,
    });
    expect(fullPage.map((result) => result.path)).toEqual([
      "bulk/file-8.md",
      "bulk/file-9.md",
    ]);

    // When the whole index is exhausted before the page fills, every visible
    // hit still surfaces (no infinite growth, no dropped tail).
    const underfull = await searchWorkspaceEngine({
      workspaceId: "workspace-a",
      versionId: main.id,
      query: "page-needle",
      versions,
      chats,
      policy,
      limit: 5,
    });
    expect(underfull.map((result) => result.path)).toEqual([
      "bulk/file-8.md",
      "bulk/file-9.md",
    ]);
  });
});

describe("engine file path classifier (shared by search and capture)", () => {
  it("tracks ordinary workspace text paths", () => {
    expect(classifyEngineFilePath("notes/today.md")).toEqual({ kind: "tracked" });
    expect(classifyEngineFilePath("environment.md")).toEqual({ kind: "tracked" });
  });

  it("read classification sees mounted shares as the mount does", () => {
    // Write-side: everything under shared-with-me is ignored (not captured).
    expect(classifyEngineFilePath("shared-with-me/alex/.env")).toEqual({ kind: "ignored" });
    // Read-side: the secret floor holds INSIDE mounts, and mounted content
    // is visible/tracked for read surfaces (graph, search backstops).
    expect(classifyEngineFilePathForRead("shared-with-me/alex/.env")).toEqual({
      kind: "secret",
    });
    expect(classifyEngineFilePathForRead("shared-with-me/alex/config/prod.env")).toEqual({
      kind: "secret",
    });
    // Encoded and Windows-alias disguises classify secret inside mounts too.
    expect(classifyEngineFilePathForRead("shared-with-me/alex/%2eenv")).toEqual({
      kind: "secret",
    });
    expect(classifyEngineFilePathForRead("shared-with-me/alex/prod.env ")).toEqual({
      kind: "secret",
    });
    expect(classifyEngineFilePathForRead("Shared-With-Me/alex/.env")).toEqual({
      kind: "secret",
    });
    expect(classifyEngineFilePathForRead("shared-with-me/alex/brief.md")).toEqual({
      kind: "tracked",
    });
    expect(classifyEngineFilePathForRead("shared-with-me")).toEqual({ kind: "tracked" });
    // Outside mounts the two classifiers agree.
    expect(classifyEngineFilePathForRead(".env")).toEqual({ kind: "secret" });
    expect(classifyEngineFilePathForRead("notes/today.md")).toEqual({ kind: "tracked" });
    expect(classifyEngineFilePathForRead(".dohc/engine/engine.db")).toEqual({
      kind: "ignored",
    });
    expect(classifyEngineFilePathForRead("../escape.md")).toEqual({ kind: "ignored" });
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

  it("classifies Windows trailing-dot/space .env aliases as secret", () => {
    // Windows silently strips trailing dots and spaces, so a write to
    // `secret.env ` or `secret.env.` lands in the real `secret.env`. Without
    // alias normalization the floor classified these as tracked — versioning
    // their plaintext, indexing them in search, and admitting them through the
    // share selector. They must classify exactly like their canonical names.
    expect(classifyEngineFilePath(".env ")).toEqual({ kind: "secret" });
    expect(classifyEngineFilePath(".env.")).toEqual({ kind: "secret" });
    expect(classifyEngineFilePath(".ENV ")).toEqual({ kind: "secret" });
    expect(classifyEngineFilePath("secret.env ")).toEqual({ kind: "secret" });
    expect(classifyEngineFilePath("secret.env.")).toEqual({ kind: "secret" });
    expect(classifyEngineFilePath("config/.env ")).toEqual({ kind: "secret" });
    expect(classifyEngineFilePath("deploy/prod.env ")).toEqual({ kind: "secret" });
    expect(classifyEngineFilePath(".env.local ")).toEqual({ kind: "secret" });
    // A directory segment literally named `.env` (aliased) also classifies
    // secret — locks the `segments.some(segment === ".env")` branch, not just
    // the basename branch.
    expect(classifyEngineFilePath("apps/site/.env /local.md")).toEqual({ kind: "secret" });
    // A trailing-space ordinary file is still tracked (no false secrets).
    expect(classifyEngineFilePath("notes/today.md ")).toEqual({ kind: "tracked" });
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
