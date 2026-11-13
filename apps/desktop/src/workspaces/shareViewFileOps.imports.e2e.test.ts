import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { type CaptureVersionedTextStore } from "./workspaceEngineCaptureLiveStore";
import { createTestScratch } from "./testTemp";
import {
  engine,
  roots,
  harness,
  seedSharedFiles,
  scope,
  settleShareViewThroughOwner,
  applyShareViewFileImport,
  storePaths,
  replicationLogRows,
  exists,
} from "./shareViewFileOps.fixture";

describe("share-view file operations through the real store", () => {
  it.skipIf(engine.missing)(
    "reserves an absent projection's store name without regard to case",
    async () => {
      const view = await harness("dohc-share-import-store-case-", "edit");
      const main = await view.store.ensureMainVersion({
        workspaceId: view.workspaceId,
      });
      await view.store.writeTextFile({
        workspaceId: view.workspaceId,
        versionId: main.id,
        path: "docs/Note.md",
        text: "granter\n",
        metadata: { origin: "sync" },
      });
      await mkdir(join(view.rootPath, "docs"), { recursive: true });
      const sourceDir = await createTestScratch("dohc-share-import-store-case-src-");
      roots.push(sourceDir);
      const source = join(sourceDir, "note.md");
      await writeFile(source, "imported\n", "utf8");

      const outcome = await applyShareViewFileImport({
        ...scope(view),
        absolutePaths: [source],
        screenAgainstRoots: null,
        targetDir: "docs",
      });

      expect(
        outcome,
        "exact-case store lookup accepts a second engine path for the same physical name",
      ).toEqual({ imported: ["docs/note (2).md"], skipped: 0 });
      expect(await storePaths(view)).toEqual(["docs/Note.md", "docs/note (2).md"]);
      expect(await exists(join(view.rootPath, "docs", "Note.md"))).toBe(false);
      await expect(readFile(join(view.rootPath, "docs", "note (2).md"), "utf8")).resolves.toBe(
        "imported\n",
      );
    },
    60_000,
  );

  it.skipIf(engine.missing)(
    "keeps capture disabled after chat opens first, imports sources, and renames a collision",
    async () => {
      const view = await harness("dohc-share-import-", "edit", {
        chatFirst: true,
      });
      await seedSharedFiles(view, [{ path: "docs/note.md", text: "granter\n" }]);
      const sourceDir = await createTestScratch("dohc-share-import-src-");
      roots.push(sourceDir);
      await writeFile(join(sourceDir, "added.md"), "imported\n", "utf8");
      await writeFile(join(sourceDir, "note.md"), "collides\n", "utf8");
      await writeFile(join(sourceDir, "picture.png"), Buffer.from([0x89, 0x50, 0x00, 0x01]));
      // A local addition whose name an import would otherwise take.
      await writeFile(join(sourceDir, "mine.md"), "imported mine\n", "utf8");
      await writeFile(join(view.rootPath, "docs", "mine.md"), "mine\n", "utf8");
      // A directory: nothing the engine can own, and nothing that may land on
      // disk on its way to being refused.
      await mkdir(join(sourceDir, "folder"));
      const journalBefore = replicationLogRows(view.rootPath);

      const outcome = await applyShareViewFileImport({
        ...scope(view),
        absolutePaths: [
          join(sourceDir, "added.md"),
          join(sourceDir, "note.md"),
          join(sourceDir, "mine.md"),
          join(sourceDir, "picture.png"),
          join(sourceDir, "folder"),
        ],
        screenAgainstRoots: null,
        targetDir: "docs",
      });

      expect(outcome.imported.sort()).toEqual([
        "docs/added.md",
        "docs/mine (2).md",
        "docs/note (2).md",
        "docs/picture.png",
      ]);
      await expect(
        readFile(join(view.rootPath, "docs", "mine.md"), "utf8"),
        "an import that only asks the store overwrites the recipient's own file",
      ).resolves.toBe("mine\n");
      expect(outcome.skipped, "a source the engine cannot own is counted as imported").toBe(1);
      const paths = await storePaths(view);
      expect(
        paths,
        "the received-share watcher journals a recipient-owned collision file",
      ).not.toContain("docs/mine.md");
      expect(paths).toEqual([
        "docs/added.md",
        "docs/mine (2).md",
        "docs/note (2).md",
        "docs/note.md",
        "docs/picture.png",
      ]);
      expect(
        replicationLogRows(view.rootPath),
        "an import that only copies files is a change the submit lane cannot see",
      ).toBeGreaterThan(journalBefore);
      await expect(readFile(join(view.rootPath, "docs", "note (2).md"), "utf8")).resolves.toBe(
        "collides\n",
      );
      await expect(
        readFile(join(view.rootPath, "docs", "note.md"), "utf8"),
        "an import that overwrites replaces the granter's file with the recipient's",
      ).resolves.toBe("granter\n");
      await expect(readFile(join(view.rootPath, "docs", "picture.png"))).resolves.toEqual(
        Buffer.from([0x89, 0x50, 0x00, 0x01]),
      );
      expect(await exists(join(view.rootPath, "docs", "folder"))).toBe(false);
    },
    60_000,
  );

  it.skipIf(engine.missing)(
    "repairs an import whose store write landed before materialization failed",
    async () => {
      const view = await harness("dohc-share-import-repair-", "edit");
      const sourceDir = await createTestScratch("dohc-share-import-repair-src-");
      roots.push(sourceDir);
      const source = join(sourceDir, "interrupted.md");
      await writeFile(source, "imported body\n", "utf8");
      await mkdir(join(view.rootPath, "docs"), { recursive: true });
      const failingStore: CaptureVersionedTextStore = {
        ...view.store,
        async readTextFile() {
          throw new Error("projection materialization failed");
        },
      };

      await expect(
        applyShareViewFileImport({
          ...scope(view),
          shareViewStore: () => failingStore,
          absolutePaths: [source],
          screenAgainstRoots: null,
          targetDir: "docs",
        }),
      ).rejects.toThrow("projection materialization failed");

      await expect(settleShareViewThroughOwner(view, view.store)).resolves.toEqual({
        capturedPaths: 0,
        repairedPaths: 1,
        unjournalablePaths: [],
      });
      await expect(readFile(join(view.rootPath, "docs", "interrupted.md"), "utf8")).resolves.toBe(
        "imported body\n",
      );
      expect(await storePaths(view)).toContain("docs/interrupted.md");
    },
    60_000,
  );
});
