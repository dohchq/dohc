import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeTrackedEngineDbHandlesForTest } from "./engineDbSchema";
import {
  VersionedTextStoreError,
  createVersionedTextStore,
} from "./versionedTextStore";

interface RawSqliteStatement {
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
let deterministicCounters = { conflict: 0, moment: 0, object: 0, version: 0 };

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "dohc-versioned-merge-"));
  now = 1000;
  deterministicCounters = { conflict: 0, moment: 0, object: 0, version: 0 };
});

afterEach(async () => {
  closeTrackedEngineDbHandlesForTest();
  await rm(root, { recursive: true, force: true });
});

function storeWithDeterministicIds() {
  return createVersionedTextStore(root, {
    nowMs: () => {
      now += 10;
      return now;
    },
    createId: (kind) => {
      deterministicCounters[kind] += 1;
      return `${kind}-${deterministicCounters[kind]}`;
    },
  });
}

function withRawDb(fn: (db: RawSqliteDb) => void): void {
  const db = new DatabaseSync(join(root, ".dohc/engine/engine.db"));
  try {
    db.exec("PRAGMA foreign_keys = ON");
    fn(db);
  } finally {
    db.close();
  }
}

const localFileWrite = { origin: "local-file" as const, summary: "local save" };
const mergeWrite = { origin: "api" as const, summary: "merge named version" };

async function createForkedPlan(workspaceId = "workspace-a") {
  const store = storeWithDeterministicIds();
  const main = await store.ensureMainVersion({ workspaceId });
  await store.writeTextFile({
    workspaceId,
    versionId: main.id,
    path: "docs/plan.md",
    text: "Title\n\nIntro\n\nCost: old\n",
    metadata: localFileWrite,
  });
  const named = await store.createNamedVersion({
    workspaceId,
    name: "Experiment",
    fromVersionId: main.id,
  });
  return { main, named, store, workspaceId };
}

describe("versioned text compare and merge", () => {
  it("compares a named version against Main with exact base/current/incoming text", async () => {
    const { main, named, store } = await createForkedPlan();
    await store.writeTextFile({
      workspaceId: "workspace-a",
      versionId: main.id,
      path: "docs/plan.md",
      text: "Title\n\nIntro from Main\n\nCost: old\n",
      metadata: localFileWrite,
    });
    await store.writeTextFile({
      workspaceId: "workspace-a",
      versionId: named.id,
      path: "docs/plan.md",
      text: "Title\n\nIntro\n\nCost: from named\n",
      metadata: { origin: "api", summary: "named edit" },
    });

    const comparison = await store.compareTextFileVersions({
      workspaceId: "workspace-a",
      targetVersionId: main.id,
      sourceVersionId: named.id,
      path: "docs/plan.md",
    });

    expect(comparison.status).toBe("diverged");
    expect(comparison.base).toMatchObject({ exists: true, text: "Title\n\nIntro\n\nCost: old\n" });
    expect(comparison.current).toMatchObject({
      exists: true,
      text: "Title\n\nIntro from Main\n\nCost: old\n",
    });
    expect(comparison.incoming).toMatchObject({
      exists: true,
      text: "Title\n\nIntro\n\nCost: from named\n",
    });
  });

  it("cleanly merges non-overlapping line edits into Main without conflict markers", async () => {
    const { main, named, store } = await createForkedPlan();
    await store.writeTextFile({
      workspaceId: "workspace-a",
      versionId: main.id,
      path: "docs/plan.md",
      text: "Title\n\nIntro from Main\n\nCost: old\n",
      metadata: localFileWrite,
    });
    await store.writeTextFile({
      workspaceId: "workspace-a",
      versionId: named.id,
      path: "docs/plan.md",
      text: "Title\n\nIntro\n\nCost: from named\n",
      metadata: { origin: "api", summary: "named edit" },
    });

    const merge = await store.mergeTextFileFromVersion({
      workspaceId: "workspace-a",
      targetVersionId: main.id,
      sourceVersionId: named.id,
      path: "docs/plan.md",
      metadata: mergeWrite,
    });

    expect(merge.kind).toBe("merged");
    await expect(
      store.readTextFile({
        workspaceId: "workspace-a",
        versionId: main.id,
        path: "docs/plan.md",
      }),
    ).resolves.toMatchObject({
      text: "Title\n\nIntro from Main\n\nCost: from named\n",
    });
    const mainAfter = await store.readTextFile({
      workspaceId: "workspace-a",
      versionId: main.id,
      path: "docs/plan.md",
    });
    expect(mainAfter?.text).not.toMatch(/<<<<<<<|=======|>>>>>>>/);
    await expect(store.listTextConflicts({ workspaceId: "workspace-a" })).resolves.toEqual([]);
  });

  it("preserves same-line conflicts without mutating Main", async () => {
    const { main, named, store } = await createForkedPlan();
    await store.writeTextFile({
      workspaceId: "workspace-a",
      versionId: main.id,
      path: "docs/plan.md",
      text: "Title\n\nIntro\n\nCost: Main says 100\n",
      metadata: localFileWrite,
    });
    await store.writeTextFile({
      workspaceId: "workspace-a",
      versionId: named.id,
      path: "docs/plan.md",
      text: "Title\n\nIntro\n\nCost: named says 80\n",
      metadata: { origin: "api", summary: "named edit" },
    });

    const merge = await store.mergeTextFileFromVersion({
      workspaceId: "workspace-a",
      targetVersionId: main.id,
      sourceVersionId: named.id,
      path: "docs/plan.md",
      metadata: mergeWrite,
    });

    expect(merge.kind).toBe("conflict");
    if (merge.kind === "conflict") {
      expect(merge.conflict).toMatchObject({
        id: "conflict-1",
        status: "open",
        chosenFrom: "current",
        base: { text: "Title\n\nIntro\n\nCost: old\n" },
        current: { text: "Title\n\nIntro\n\nCost: Main says 100\n" },
        incoming: { text: "Title\n\nIntro\n\nCost: named says 80\n" },
      });
    }
    await expect(
      store.readTextFile({
        workspaceId: "workspace-a",
        versionId: main.id,
        path: "docs/plan.md",
      }),
    ).resolves.toMatchObject({ text: "Title\n\nIntro\n\nCost: Main says 100\n" });
    await expect(store.listTextConflicts({ workspaceId: "workspace-a", status: "open" })).resolves
      .toHaveLength(1);
  });

  it("treats delete-vs-edit as a preserved conflict", async () => {
    const { main, named, store } = await createForkedPlan();
    await store.writeTextFile({
      workspaceId: "workspace-a",
      versionId: main.id,
      path: "docs/plan.md",
      text: "Title\n\nIntro\n\nCost: edited in Main\n",
      metadata: localFileWrite,
    });
    await store.deleteTextFile({
      workspaceId: "workspace-a",
      versionId: named.id,
      path: "docs/plan.md",
      metadata: { origin: "api", summary: "delete in named version" },
    });

    const merge = await store.mergeTextFileFromVersion({
      workspaceId: "workspace-a",
      targetVersionId: main.id,
      sourceVersionId: named.id,
      path: "docs/plan.md",
      metadata: mergeWrite,
    });

    expect(merge.kind).toBe("conflict");
    if (merge.kind === "conflict") {
      expect(merge.conflict.base.exists).toBe(true);
      expect(merge.conflict.current).toMatchObject({
        exists: true,
        text: "Title\n\nIntro\n\nCost: edited in Main\n",
      });
      expect(merge.conflict.incoming).toMatchObject({
        exists: false,
        path: "docs/plan.md",
      });
    }
  });

  it("resolves a conflict by applying incoming text after confirming Main is unchanged", async () => {
    const { main, named, store } = await createForkedPlan();
    await store.writeTextFile({
      workspaceId: "workspace-a",
      versionId: main.id,
      path: "docs/plan.md",
      text: "Title\n\nIntro\n\nCost: Main says 100\n",
      metadata: localFileWrite,
    });
    await store.writeTextFile({
      workspaceId: "workspace-a",
      versionId: named.id,
      path: "docs/plan.md",
      text: "Title\n\nIntro\n\nCost: named says 80\n",
      metadata: { origin: "api", summary: "named edit" },
    });
    const merge = await store.mergeTextFileFromVersion({
      workspaceId: "workspace-a",
      targetVersionId: main.id,
      sourceVersionId: named.id,
      path: "docs/plan.md",
      metadata: mergeWrite,
    });
    if (merge.kind !== "conflict") throw new Error("expected conflict");

    const resolved = await store.resolveTextConflict({
      workspaceId: "workspace-a",
      conflictId: merge.conflict.id,
      resolution: { kind: "apply-incoming" },
      metadata: { origin: "api", summary: "resolve with incoming" },
    });

    expect(resolved.conflict).toMatchObject({
      status: "resolved",
      resolution: "applied-incoming",
      chosenFrom: "incoming",
    });
    await expect(
      store.readTextFile({
        workspaceId: "workspace-a",
        versionId: main.id,
        path: "docs/plan.md",
      }),
    ).resolves.toMatchObject({ text: "Title\n\nIntro\n\nCost: named says 80\n" });
  });

  it("refuses to resolve a conflict after Main changes again", async () => {
    const { main, named, store } = await createForkedPlan();
    await store.writeTextFile({
      workspaceId: "workspace-a",
      versionId: main.id,
      path: "docs/plan.md",
      text: "Title\n\nIntro\n\nCost: Main says 100\n",
      metadata: localFileWrite,
    });
    await store.writeTextFile({
      workspaceId: "workspace-a",
      versionId: named.id,
      path: "docs/plan.md",
      text: "Title\n\nIntro\n\nCost: named says 80\n",
      metadata: { origin: "api", summary: "named edit" },
    });
    const merge = await store.mergeTextFileFromVersion({
      workspaceId: "workspace-a",
      targetVersionId: main.id,
      sourceVersionId: named.id,
      path: "docs/plan.md",
      metadata: mergeWrite,
    });
    if (merge.kind !== "conflict") throw new Error("expected conflict");

    await store.writeTextFile({
      workspaceId: "workspace-a",
      versionId: main.id,
      path: "docs/plan.md",
      text: "Title\n\nIntro\n\nCost: Main changed again\n",
      metadata: localFileWrite,
    });

    await expect(
      store.resolveTextConflict({
        workspaceId: "workspace-a",
        conflictId: merge.conflict.id,
        resolution: { kind: "apply-incoming" },
        metadata: { origin: "api", summary: "stale resolve" },
      }),
    ).rejects.toMatchObject({ code: "conflict-stale-target" });
  });

  it("fails closed for versions that do not have a durable fork base", async () => {
    const { main, named, store } = await createForkedPlan();
    withRawDb((db) => {
      db.prepare("DELETE FROM fork_base_snapshots WHERE workspace_id = ? AND version_id = ?").run(
        "workspace-a",
        named.id,
      );
    });

    await expect(
      store.compareTextFileVersions({
        workspaceId: "workspace-a",
        targetVersionId: main.id,
        sourceVersionId: named.id,
        path: "docs/plan.md",
      }),
    ).rejects.toMatchObject({ code: "fork-base-not-found" });
  });

  it("rejects merge when the source version belongs to another workspace", async () => {
    const { main, named, store } = await createForkedPlan();
    await store.ensureMainVersion({ workspaceId: "workspace-b" });

    await expect(
      store.mergeTextFileFromVersion({
        workspaceId: "workspace-b",
        targetVersionId: main.id,
        sourceVersionId: named.id,
        path: "docs/plan.md",
        metadata: mergeWrite,
      }),
    ).rejects.toBeInstanceOf(VersionedTextStoreError);
    await expect(
      store.mergeTextFileFromVersion({
        workspaceId: "workspace-b",
        targetVersionId: main.id,
        sourceVersionId: named.id,
        path: "docs/plan.md",
        metadata: mergeWrite,
      }),
    ).rejects.toMatchObject({ code: "workspace-mismatch" });
  });

  it("does not silently drop small edit/delete combinations", async () => {
    const sourceEdits = [
      { source: "current" as const, text: "A\nB current\nC\n" },
      { source: "incoming" as const, text: "A\nB incoming\nC\n" },
      { source: "incoming-delete" as const, text: null },
    ];

    for (const [index, edit] of sourceEdits.entries()) {
      const workspaceId = `workspace-small-${index}`;
      const { main, named, store } = await createForkedPlan(workspaceId);
      await store.writeTextFile({
        workspaceId,
        versionId: main.id,
        path: "docs/plan.md",
        text: "A\nB current\nC\n",
        metadata: localFileWrite,
      });
      if (edit.text === null) {
        await store.deleteTextFile({
          workspaceId,
          versionId: named.id,
          path: "docs/plan.md",
          metadata: { origin: "api", summary: edit.source },
        });
      } else {
        await store.writeTextFile({
          workspaceId,
          versionId: named.id,
          path: "docs/plan.md",
          text: edit.text,
          metadata: { origin: "api", summary: edit.source },
        });
      }

      const merge = await store.mergeTextFileFromVersion({
        workspaceId,
        targetVersionId: main.id,
        sourceVersionId: named.id,
        path: "docs/plan.md",
        metadata: mergeWrite,
      });

      if (merge.kind === "conflict") {
        expect(merge.conflict.current.exists).toBe(true);
        expect(merge.conflict.incoming.exists).toBe(edit.text !== null);
      } else {
        const current = await store.readTextFile({
          workspaceId,
          versionId: main.id,
          path: "docs/plan.md",
        });
        expect(current?.text ?? null).toBe(edit.text ?? "A\nB current\nC\n");
      }
    }
  });
});
