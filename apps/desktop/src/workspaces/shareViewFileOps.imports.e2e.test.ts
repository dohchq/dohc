import { mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { type CaptureVersionedTextStore } from "./workspaceEngineCaptureLiveStore";
import { createTestScratch } from "./testTemp";
import { createFile, movePath } from "./workspaceFiles";
import { engine, roots, harness, seedSharedFiles, scope, settleShareViewThroughOwner, applyShareViewFileImport, storePaths, replicationLogRows, exists } from './shareViewFileOps.fixture';

describe("share-view file operations through the real store", () => {
it.skipIf(engine.missing)(
    "imports beside a file whose name differs only in case, never over it",
    async () => {
      const view = await harness("dohc-share-import-case-", "edit");
      await seedSharedFiles(view, [
        { path: "docs/Note.md", text: "granter\n" },
      ]);
      const sourceDir = await createTestScratch("dohc-share-import-case-src-");
      roots.push(sourceDir);
      await writeFile(join(sourceDir, "note.md"), "imported\n", "utf8");

      const outcome = await applyShareViewFileImport({
        ...scope(view),
        absolutePaths: [join(sourceDir, "note.md")],
        screenAgainstRoots: null,
        targetDir: "docs",
      });

      // The ordinary import is safe here because `copyFile` runs with
      // COPYFILE_EXCL, which the filesystem answers; the share path has to be
      // as safe, and a name set built from `readdir` strings is not.
      await expect(
        readFile(join(view.rootPath, "docs", "Note.md"), "utf8"),
        "an import that compares names as strings overwrites a file whose name differs only in case",
      ).resolves.toBe("granter\n");
      // WHERE the import landed differs by platform — `note (2).md` where the
      // filesystem folds case, `note.md` where it does not — so this asserts
      // the invariant both share: one file landed, and it holds the imported
      // bytes.
      expect(outcome.imported).toHaveLength(1);
      expect(outcome.skipped).toBe(0);
      await expect(
        readFile(join(view.rootPath, outcome.imported[0]!), "utf8"),
      ).resolves.toBe("imported\n");
      expect(await storePaths(view)).toContain("docs/Note.md");
    },
    60_000,
  );

  it.skipIf(engine.missing)(
    "leaves a picked file inside a .dohc folder out of a shared workspace's import",
    async () => {
      const view = await harness("dohc-share-import-metadata-", "edit");
      await seedSharedFiles(view, [
        { path: "docs/note.md", text: "granter\n" },
      ]);
      const sourceDir = await createTestScratch("dohc-share-import-metadata-src-");
      roots.push(sourceDir);
      const kept = join(sourceDir, ".dohc", "local", "protected-copies");
      await mkdir(kept, { recursive: true });
      await writeFile(join(kept, "copy.json"), "{\"text\":\"SECRET\"}", "utf8");
      await writeFile(join(sourceDir, "plain.md"), "plain\n", "utf8");

      const outcome = await applyShareViewFileImport({
        ...scope(view),
        absolutePaths: [join(kept, "copy.json"), join(sourceDir, "plain.md")],
        screenAgainstRoots: null,
        targetDir: "docs",
      });

      expect(outcome).toEqual({
        imported: ["docs/plain.md"],
        skipped: 1,
        skippedSources: [{ path: "copy.json", reason: "workspace-data" }],
      });
      expect(await storePaths(view)).toEqual(["docs/note.md", "docs/plain.md"]);
      expect(await exists(join(view.rootPath, "docs", "copy.json"))).toBe(false);
    },
    60_000,
  );

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
      const sourceDir = await createTestScratch(
        "dohc-share-import-store-case-src-",
      );
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
      expect(await storePaths(view)).toEqual([
        "docs/Note.md",
        "docs/note (2).md",
      ]);
      expect(await exists(join(view.rootPath, "docs", "Note.md"))).toBe(false);
      await expect(
        readFile(join(view.rootPath, "docs", "note (2).md"), "utf8"),
      ).resolves.toBe("imported\n");
    },
    60_000,
  );

it.skipIf(engine.missing)(
    "screens an OS drag-in before it writes a share view's store",
    async () => {
      const view = await harness("dohc-share-import-dropped-", "edit");
      await seedSharedFiles(view, [
        { path: "docs/note.md", text: "granter\n" },
      ]);
      const sourceDir = await createTestScratch("dohc-share-dropped-src-");
      roots.push(sourceDir);
      const file = join(sourceDir, "dropped.md");
      await writeFile(file, "dropped\n", "utf8");
      const directory = join(sourceDir, "folder");
      await mkdir(directory);
      const link = join(sourceDir, "link.md");
      await symlink(file, link);

      const outcome = await applyShareViewFileImport({
        ...scope(view),
        absolutePaths: [file, directory, link],
        screenAgainstRoots: [view.rootPath],
        targetDir: "docs",
      });

      // The store holds files only, so a folder with no file in it is
      // skipped, and the screen refuses the link before following it.
      expect(
        outcome,
        "an unscreened drag-in writes a directory or a link's target into the share view's store",
      ).toEqual({
        imported: ["docs/dropped.md"],
        skipped: 2,
        skippedSources: [{ path: "link.md", reason: "link" }, { path: "folder", reason: "no-files" }],
      });
      expect(await storePaths(view)).toEqual([
        "docs/dropped.md",
        "docs/note.md",
      ]);
    },
    60_000,
  );

it.skipIf(engine.missing)(
    "keeps capture disabled after chat opens first, imports sources, and renames a collision",
    async () => {
      const view = await harness("dohc-share-import-", "edit", {
        chatFirst: true,
      });
      await seedSharedFiles(view, [
        { path: "docs/note.md", text: "granter\n" },
      ]);
      const sourceDir = await createTestScratch("dohc-share-import-src-");
      roots.push(sourceDir);
      await writeFile(join(sourceDir, "added.md"), "imported\n", "utf8");
      await writeFile(join(sourceDir, "note.md"), "collides\n", "utf8");
      await writeFile(
        join(sourceDir, "picture.png"),
        Buffer.from([0x89, 0x50, 0x00, 0x01]),
      );
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
      expect(
        outcome.skipped,
        "a source the engine cannot own is counted as imported",
      ).toBe(1);
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
      await expect(
        readFile(join(view.rootPath, "docs", "note (2).md"), "utf8"),
      ).resolves.toBe("collides\n");
      await expect(
        readFile(join(view.rootPath, "docs", "note.md"), "utf8"),
        "an import that overwrites replaces the granter's file with the recipient's",
      ).resolves.toBe("granter\n");
      await expect(
        readFile(join(view.rootPath, "docs", "picture.png")),
      ).resolves.toEqual(Buffer.from([0x89, 0x50, 0x00, 0x01]));
      expect(await exists(join(view.rootPath, "docs", "folder"))).toBe(false);
    },
    60_000,
  );

it.skipIf(engine.missing)(
    "repairs an import whose store write landed before materialization failed",
    async () => {
      const view = await harness("dohc-share-import-repair-", "edit");
      const sourceDir = await createTestScratch(
        "dohc-share-import-repair-src-",
      );
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

      await expect(
        settleShareViewThroughOwner(view, view.store),
      ).resolves.toEqual({
        capturedPaths: 0,
        repairedPaths: 1,
        unjournalablePaths: [],
      });
      await expect(
        readFile(join(view.rootPath, "docs", "interrupted.md"), "utf8"),
      ).resolves.toBe("imported body\n");
      expect(await storePaths(view)).toContain("docs/interrupted.md");
    },
    60_000,
  );

it.skipIf(engine.missing)(
    "repairs a missing canonical destination before importing into it",
    async () => {
      const view = await harness(
        "dohc-share-import-missing-destination-",
        "edit",
      );
      await seedSharedFiles(view, [
        { path: "docs/target/keep.md", text: "keep\n" },
      ]);
      await rm(join(view.rootPath, "docs", "target"), {
        recursive: true,
        force: true,
      });
      const sourceDir = await createTestScratch(
        "dohc-share-import-missing-destination-src-",
      );
      roots.push(sourceDir);
      const source = join(sourceDir, "added.md");
      await writeFile(source, "added\n", "utf8");

      await expect(
        applyShareViewFileImport({
          ...scope(view),
          absolutePaths: [source],
          screenAgainstRoots: null,
          targetDir: "docs/target",
        }),
        "disk probing refuses a visible canonical folder whose projection was deleted out of app",
      ).resolves.toEqual({ imported: ["docs/target/added.md"], skipped: 0 });

      expect(await storePaths(view)).toEqual([
        "docs/target/added.md",
        "docs/target/keep.md",
      ]);
      await expect(
        readFile(join(view.rootPath, "docs", "target", "keep.md"), "utf8"),
      ).resolves.toBe("keep\n");
      await expect(
        readFile(join(view.rootPath, "docs", "target", "added.md"), "utf8"),
      ).resolves.toBe("added\n");
    },
    60_000,
  );

it.skipIf(engine.missing)(
    "leaves an ordinary workspace's file operations on disk, where the watcher records them",
    async () => {
      const workspace = await harness("dohc-ordinary-file-ops-");
      // The store is opened first so the daemon's own open-time reconciliation
      // is counted here rather than mistaken for a filesystem write below.
      const before = await storePaths(workspace);

      await createFile(workspace.rootPath, "note.md", "hello\n");
      await movePath(workspace.rootPath, "note.md", "renamed.md");

      await expect(
        readFile(join(workspace.rootPath, "renamed.md"), "utf8"),
      ).resolves.toBe("hello\n");
      expect(
        await storePaths(workspace),
        "an ordinary workspace writing engine-direct journals every change twice — once here, once from the watcher",
      ).toEqual(before);
    },
    60_000,
  );
});
