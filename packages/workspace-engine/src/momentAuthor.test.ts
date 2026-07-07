import { createRequire } from "node:module";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeTrackedEngineDbHandlesForTest } from "./engineDbSchema";
import {
  VERSIONED_TEXT_STORE_RELATIVE_PATH,
  VersionedTextStoreError,
  createVersionedTextStore,
  type MomentAuthor,
} from "./versionedTextStore";

// PR 0N-1 agent-attributed engine writes: moments carry an OPTIONAL agent
// author (dohc-tracked runs only). Absent author is the actor-neutral default
// — snapshots and conflicts stay actor-neutral by construction (the author
// lives on the moment row alone).

const requireModule = createRequire(import.meta.url);

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "dohc-moment-author-"));
});

afterEach(async () => {
  closeTrackedEngineDbHandlesForTest();
  await rm(root, { recursive: true, force: true });
});

const workspaceId = "workspace-author";
const neutral = { origin: "local-file" as const };
const agentAuthor: MomentAuthor = {
  kind: "agent",
  agentId: "dohc-mcp",
  onBehalfOf: "local",
  agentRunId: "run-1",
};

function rawEngineDb(rootDir: string) {
  const { DatabaseSync } = requireModule("node:sqlite") as {
    DatabaseSync: new (path: string) => {
      exec(sql: string): void;
      prepare(sql: string): {
        all(...params: unknown[]): Array<Record<string, unknown>>;
        run(...params: unknown[]): unknown;
      };
      close(): void;
    };
  };
  return new DatabaseSync(join(rootDir, VERSIONED_TEXT_STORE_RELATIVE_PATH));
}

describe("moment authorship", () => {
  it("stamps writes and deletes with the agent author and surfaces it on the timeline", async () => {
    const store = createVersionedTextStore(root);
    await store.ensureMainVersion({ workspaceId });
    const written = await store.writeTextFile({
      workspaceId,
      versionId: "main",
      path: "notes/plan.md",
      text: "# Plan\n",
      metadata: neutral,
      author: agentAuthor,
    });
    expect(written.moment.author).toEqual(agentAuthor);
    // Snapshot metadata stays actor-neutral: authorship is a MOMENT fact.
    expect(written.snapshot.metadata).toEqual(neutral);

    const deleted = await store.deleteTextFile({
      workspaceId,
      versionId: "main",
      path: "notes/plan.md",
      metadata: neutral,
      author: { kind: "agent", agentId: "dohc-mcp", onBehalfOf: "ice@example.com" },
    });
    expect(deleted.moment.author).toEqual({
      kind: "agent",
      agentId: "dohc-mcp",
      onBehalfOf: "ice@example.com",
    });

    const page = await store.listMoments({ workspaceId });
    expect(page.moments.map((moment) => moment.author)).toEqual([
      { kind: "agent", agentId: "dohc-mcp", onBehalfOf: "ice@example.com" },
      agentAuthor,
    ]);

    const full = await store.getMoment({ workspaceId, momentId: written.moment.id });
    expect(full?.author).toEqual(agentAuthor);
    await store.close();
  });

  it("leaves ordinary writes actor-neutral (no author field at all)", async () => {
    const store = createVersionedTextStore(root);
    await store.ensureMainVersion({ workspaceId });
    const written = await store.writeTextFile({
      workspaceId,
      versionId: "main",
      path: "a.md",
      text: "one\n",
      metadata: neutral,
    });
    expect("author" in written.moment).toBe(false);
    const page = await store.listMoments({ workspaceId });
    expect("author" in (page.moments[0] ?? {})).toBe(false);
    const full = await store.getMoment({ workspaceId, momentId: written.moment.id });
    expect(full && "author" in full).toBe(false);
    await store.close();
  });

  it("persists the author across a store reopen", async () => {
    const first = createVersionedTextStore(root);
    await first.ensureMainVersion({ workspaceId });
    await first.writeTextFile({
      workspaceId,
      versionId: "main",
      path: "a.md",
      text: "one\n",
      metadata: neutral,
      author: agentAuthor,
    });
    await first.close();

    const second = createVersionedTextStore(root);
    const page = await second.listMoments({ workspaceId });
    expect(page.moments[0]?.author).toEqual(agentAuthor);
    await second.close();
  });

  it("rejects invalid authors before touching the database", async () => {
    const store = createVersionedTextStore(root);
    await store.ensureMainVersion({ workspaceId });
    const invalidAuthors: unknown[] = [
      { kind: "human", agentId: "x", onBehalfOf: "y" },
      { kind: "agent", agentId: "", onBehalfOf: "local" },
      { kind: "agent", agentId: "dohc-mcp", onBehalfOf: " padded " },
      { kind: "agent", agentId: "dohc-mcp", onBehalfOf: "local", agentRunId: "" },
      "agent",
    ];
    for (const author of invalidAuthors) {
      await expect(
        store.writeTextFile({
          workspaceId,
          versionId: "main",
          path: "a.md",
          text: "one\n",
          metadata: neutral,
          author: author as MomentAuthor,
        }),
      ).rejects.toMatchObject({ code: "invalid-metadata" });
    }
    expect((await store.listMoments({ workspaceId })).moments).toHaveLength(0);
    await store.close();
  });

  it("upgrades a pre-author engine.db in place (lazy additive column)", async () => {
    // Build a real store, then strip the author column to simulate a database
    // created before PR 0N-1 (same lazy-upgrade posture as active_versions).
    const before = createVersionedTextStore(root);
    await before.ensureMainVersion({ workspaceId });
    await before.writeTextFile({
      workspaceId,
      versionId: "main",
      path: "old.md",
      text: "old\n",
      metadata: neutral,
    });
    await before.close();

    const raw = rawEngineDb(root);
    raw.exec("ALTER TABLE moments DROP COLUMN author_json");
    raw.close();

    const upgraded = createVersionedTextStore(root);
    // Old moments read as actor-neutral...
    const page = await upgraded.listMoments({ workspaceId });
    expect(page.moments).toHaveLength(1);
    expect("author" in (page.moments[0] ?? {})).toBe(false);
    // ...and new attributed writes work against the upgraded schema.
    const written = await upgraded.writeTextFile({
      workspaceId,
      versionId: "main",
      path: "new.md",
      text: "new\n",
      metadata: neutral,
      author: agentAuthor,
    });
    expect(written.moment.author).toEqual(agentAuthor);
    await upgraded.close();

    const reopened = createVersionedTextStore(root);
    const again = await reopened.listMoments({ workspaceId });
    expect(again.moments.map((moment) => moment.author ?? null)).toEqual([
      agentAuthor,
      null,
    ]);
    await reopened.close();
  });

  it("fails closed on corrupt persisted author json", async () => {
    const store = createVersionedTextStore(root);
    await store.ensureMainVersion({ workspaceId });
    await store.writeTextFile({
      workspaceId,
      versionId: "main",
      path: "a.md",
      text: "one\n",
      metadata: neutral,
      author: agentAuthor,
    });
    await store.close();

    const raw = rawEngineDb(root);
    raw.exec(`UPDATE moments SET author_json = '{"kind":"someone-else"}'`);
    raw.close();

    const reopened = createVersionedTextStore(root);
    await expect(reopened.listMoments({ workspaceId })).rejects.toBeInstanceOf(
      VersionedTextStoreError,
    );
    await reopened.close();
  });
});
