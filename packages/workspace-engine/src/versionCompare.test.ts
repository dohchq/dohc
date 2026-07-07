import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { engineContractReExportCompileCheck } from "./engineContracts.compile";
import { closeTrackedEngineDbHandlesForTest } from "./engineDbSchema";
import { compareVersionFiles } from "./versionCompare";
import { createVersionedTextStore } from "./versionedTextStore";

void engineContractReExportCompileCheck;

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "dohc-version-compare-"));
});

afterEach(async () => {
  closeTrackedEngineDbHandlesForTest();
  await rm(root, { recursive: true, force: true });
});

const workspaceId = "workspace-compare";
const write = { origin: "local-file" as const };

describe("compareVersionFiles", () => {
  it("reports added, modified, and deleted paths with both texts, sorted", async () => {
    const store = createVersionedTextStore(root);
    const main = await store.ensureMainVersion({ workspaceId });
    for (const [path, text] of [
      ["docs/changed.md", "original\n"],
      ["docs/removed.md", "kept only in main\n"],
      ["docs/same.md", "identical\n"],
    ] as const) {
      await store.writeTextFile({
        workspaceId,
        versionId: main.id,
        path,
        text,
        metadata: write,
      });
    }
    const draft = await store.createNamedVersion({
      workspaceId,
      name: "Draft",
      fromVersionId: main.id,
    });
    await store.writeTextFile({
      workspaceId,
      versionId: draft.id,
      path: "docs/changed.md",
      text: "edited in draft\n",
      metadata: write,
    });
    await store.writeTextFile({
      workspaceId,
      versionId: draft.id,
      path: "docs/added.md",
      text: "new in draft\n",
      metadata: write,
    });
    await store.deleteTextFile({
      workspaceId,
      versionId: draft.id,
      path: "docs/removed.md",
      metadata: write,
    });

    const changes = await compareVersionFiles(store, {
      workspaceId,
      sourceVersionId: draft.id,
      targetVersionId: main.id,
    });

    expect(changes).toEqual([
      { path: "docs/added.md", status: "added", incomingText: "new in draft\n" },
      {
        path: "docs/changed.md",
        status: "modified",
        currentText: "original\n",
        incomingText: "edited in draft\n",
      },
      {
        path: "docs/removed.md",
        status: "deleted",
        currentText: "kept only in main\n",
      },
    ]);
  });

  it("returns an empty list for identical versions", async () => {
    const store = createVersionedTextStore(root);
    const main = await store.ensureMainVersion({ workspaceId });
    await store.writeTextFile({
      workspaceId,
      versionId: main.id,
      path: "plan.md",
      text: "v1\n",
      metadata: write,
    });
    const draft = await store.createNamedVersion({
      workspaceId,
      name: "Untouched",
      fromVersionId: main.id,
    });

    expect(
      await compareVersionFiles(store, {
        workspaceId,
        sourceVersionId: draft.id,
        targetVersionId: main.id,
      }),
    ).toEqual([]);
  });

  it("fails closed on unknown versions", async () => {
    const store = createVersionedTextStore(root);
    await store.ensureMainVersion({ workspaceId });
    await expect(
      compareVersionFiles(store, {
        workspaceId,
        sourceVersionId: "missing",
        targetVersionId: "main",
      }),
    ).rejects.toMatchObject({ code: "version-not-found" });
  });
});
