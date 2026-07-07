import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeTrackedEngineDbHandlesForTest } from "./engineDbSchema";
import {
  VersionedTextStoreError,
  createVersionedTextStore,
} from "./versionedTextStore";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "dohc-active-version-"));
});

afterEach(async () => {
  closeTrackedEngineDbHandlesForTest();
  await rm(root, { recursive: true, force: true });
});

const workspaceId = "workspace-active";
const write = { origin: "local-file" as const };

describe("versionedTextStore active version", () => {
  it("defaults to main once the workspace exists and is null before", async () => {
    const store = createVersionedTextStore(root);
    expect(await store.getActiveVersion({ workspaceId })).toBeNull();

    const main = await store.ensureMainVersion({ workspaceId });
    const active = await store.getActiveVersion({ workspaceId });
    expect(active?.id).toBe(main.id);
    expect(active?.kind).toBe("main");
    expect(active?.name).toBe("Main");
  });

  it("persists setActiveVersion across a fresh store handle", async () => {
    const store = createVersionedTextStore(root);
    const main = await store.ensureMainVersion({ workspaceId });
    const named = await store.createNamedVersion({
      workspaceId,
      name: "Draft",
      fromVersionId: main.id,
    });

    const set = await store.setActiveVersion({ workspaceId, versionId: named.id });
    expect(set.id).toBe(named.id);

    // A new store instance over the same engine.db reads the persisted value.
    const reopened = createVersionedTextStore(root);
    const active = await reopened.getActiveVersion({ workspaceId });
    expect(active?.id).toBe(named.id);
    expect(active?.name).toBe("Draft");

    // Switching back to main persists too.
    await reopened.setActiveVersion({ workspaceId, versionId: main.id });
    expect((await reopened.getActiveVersion({ workspaceId }))?.id).toBe(main.id);
  });

  it("fails closed on unknown version ids without changing the active version", async () => {
    const store = createVersionedTextStore(root);
    const main = await store.ensureMainVersion({ workspaceId });

    await expect(
      store.setActiveVersion({ workspaceId, versionId: "no-such-version" }),
    ).rejects.toMatchObject({ code: "version-not-found" });
    expect((await store.getActiveVersion({ workspaceId }))?.id).toBe(main.id);

    await expect(
      store.setActiveVersion({ workspaceId: "never-initialized", versionId: "main" }),
    ).rejects.toBeInstanceOf(VersionedTextStoreError);
  });

  it("rejects another workspace's version id with workspace-mismatch", async () => {
    const store = createVersionedTextStore(root);
    const mainA = await store.ensureMainVersion({ workspaceId: "workspace-a" });
    await store.ensureMainVersion({ workspaceId: "workspace-b" });
    const namedA = await store.createNamedVersion({
      workspaceId: "workspace-a",
      name: "A only",
      fromVersionId: mainA.id,
    });

    await expect(
      store.setActiveVersion({ workspaceId: "workspace-b", versionId: namedA.id }),
    ).rejects.toMatchObject({ code: "workspace-mismatch" });
    expect(
      (await store.getActiveVersion({ workspaceId: "workspace-b" }))?.kind,
    ).toBe("main");
  });

  it("upgrades a pre-active-version engine.db lazily on open", async () => {
    // Simulate a 0M-3 store: create it, then drop the active_versions table
    // the way an older writer would never have created it.
    const store = createVersionedTextStore(root);
    const main = await store.ensureMainVersion({ workspaceId });
    await store.writeTextFile({
      workspaceId,
      versionId: main.id,
      path: "plan.md",
      text: "v1\n",
      metadata: write,
    });

    const { createRequire } = await import("node:module");
    const requireModule = createRequire(import.meta.url);
    const { DatabaseSync } = requireModule("node:sqlite") as {
      DatabaseSync: new (path: string) => { exec(sql: string): void; close(): void };
    };
    const raw = new DatabaseSync(join(root, ".dohc/engine/engine.db"));
    try {
      raw.exec("DROP TABLE active_versions");
    } finally {
      raw.close();
    }

    const reopened = createVersionedTextStore(root);
    expect((await reopened.getActiveVersion({ workspaceId }))?.id).toBe(main.id);
    const named = await reopened.createNamedVersion({
      workspaceId,
      name: "Draft",
      fromVersionId: main.id,
    });
    await reopened.setActiveVersion({ workspaceId, versionId: named.id });
    expect((await reopened.getActiveVersion({ workspaceId }))?.id).toBe(named.id);
  });
});
