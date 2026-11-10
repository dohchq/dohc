import { lstat, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readPendingMaterializationPaths } from "./sharedView";
import { engine, harness, seedSharedFiles, scope, storeReplacingLeafAtMutationBoundary, expectLeafReplacementAtMutationBoundary, applyShareViewPathMove, applyShareViewPathDelete, storeFailingAt, storePaths, replicationLogRows, exists } from './shareViewFileOps.fixture';

describe("share-view file operations through the real store", () => {
it.skipIf(engine.missing)(
    "refuses to delete a folder that holds files no moment describes",
    async () => {
      const view = await harness("dohc-share-delete-dir-local-", "edit");
      await seedSharedFiles(view, [
        { path: "docs/plans/one.md", text: "one\n" },
        { path: "docs/plans/two.md", text: "two\n" },
      ]);
      await writeFile(
        join(view.rootPath, "docs", "plans", "mine.md"),
        "mine\n",
        "utf8",
      );

      await expect(
        applyShareViewPathDelete({
          ...scope(view),
          relativePath: "docs/plans",
        }),
        "deleting a folder removes it whole, destroying the files under it the store never held",
      ).rejects.toThrow(
        "docs/plans holds 1 file that is not part of this shared view: docs/plans/mine.md. Move it out of the folder first.",
      );

      await expect(
        readFile(join(view.rootPath, "docs", "plans", "mine.md"), "utf8"),
      ).resolves.toBe("mine\n");
      expect(await storePaths(view)).toEqual([
        "docs/plans/one.md",
        "docs/plans/two.md",
      ]);
    },
    60_000,
  );

it.skipIf(engine.missing)(
    "refuses to delete a tracked file something outside dohc replaced with a directory",
    async () => {
      const view = await harness("dohc-share-delete-dir-replacement-", "edit");
      await seedSharedFiles(view, [
        { path: "docs/notes.md", text: "granter\n" },
      ]);
      let replacementRan = false;
      const late = storeReplacingLeafAtMutationBoundary(
        view.store,
        async () => {
          replacementRan = true;
          await rm(join(view.rootPath, "docs", "notes.md"));
          await mkdir(join(view.rootPath, "docs", "notes.md"));
          await writeFile(
            join(view.rootPath, "docs", "notes.md", "inside.txt"),
            "recipient file\n",
            "utf8",
          );
        },
      );

      await expect(
        applyShareViewPathDelete({
          ...scope(view),
          shareViewStore: () => late.store,
          relativePath: "docs/notes.md",
        }),
        "deleting over a directory that replaced a tracked file recursively removes the directory and everything in it",
      ).rejects.toThrow(
        "dohc did not delete docs/notes.md. docs/notes.md replaces a tracked file with a folder or another entry. Restore the file or move the conflicting entry.",
      );
      expect(replacementRan).toBe(true);
      expectLeafReplacementAtMutationBoundary(late.observation);

      expect(
        (await lstat(join(view.rootPath, "docs", "notes.md"))).isDirectory(),
        "the recipient-owned directory must survive a refused delete",
      ).toBe(true);
      await expect(
        readFile(join(view.rootPath, "docs", "notes.md", "inside.txt"), "utf8"),
      ).resolves.toBe("recipient file\n");
      expect(await storePaths(view)).toEqual(["docs/notes.md"]);
      await expect(
        readPendingMaterializationPaths(view.rootPath),
        "a refused delete that still marked the path pending leaves recovery believing a materialization is owed",
      ).resolves.toEqual(new Set());
    },
    60_000,
  );

it.skipIf(engine.missing)(
    "refuses to rename a tracked file something outside dohc replaced with a directory",
    async () => {
      const view = await harness("dohc-share-rename-dir-replacement-", "edit");
      await seedSharedFiles(view, [
        { path: "docs/notes.md", text: "granter\n" },
      ]);
      let replacementRan = false;
      const late = storeReplacingLeafAtMutationBoundary(
        view.store,
        async () => {
          replacementRan = true;
          await rm(join(view.rootPath, "docs", "notes.md"));
          await mkdir(join(view.rootPath, "docs", "notes.md"));
          await writeFile(
            join(view.rootPath, "docs", "notes.md", "inside.txt"),
            "recipient file\n",
            "utf8",
          );
        },
      );

      await expect(
        applyShareViewPathMove({
          ...scope(view),
          shareViewStore: () => late.store,
          fromPath: "docs/notes.md",
          toPath: "docs/renamed.md",
        }),
        "renaming over a directory that replaced a tracked file recursively removes the directory and everything in it",
      ).rejects.toThrow(
        "dohc did not rename docs/notes.md. docs/notes.md replaces a tracked file with a folder or another entry. Restore the file or move the conflicting entry.",
      );
      expect(replacementRan).toBe(true);
      expectLeafReplacementAtMutationBoundary(late.observation);

      expect(
        (await lstat(join(view.rootPath, "docs", "notes.md"))).isDirectory(),
        "the recipient-owned directory must survive a refused rename",
      ).toBe(true);
      await expect(
        readFile(join(view.rootPath, "docs", "notes.md", "inside.txt"), "utf8"),
      ).resolves.toBe("recipient file\n");
      expect(await storePaths(view)).toEqual(["docs/notes.md"]);
      expect(await exists(join(view.rootPath, "docs", "renamed.md"))).toBe(
        false,
      );
      await expect(
        readPendingMaterializationPaths(view.rootPath),
        "a refused rename that still marked the path pending leaves recovery believing a materialization is owed",
      ).resolves.toEqual(new Set());
    },
    60_000,
  );

it.skipIf(engine.missing)(
    "refuses to delete a tracked file something outside dohc replaced with a symlink",
    async () => {
      const view = await harness(
        "dohc-share-delete-symlink-replacement-",
        "edit",
      );
      await seedSharedFiles(view, [
        { path: "docs/notes.md", text: "granter\n" },
      ]);
      const outside = join(view.rootPath, "outside.md");
      await writeFile(outside, "recipient file\n", "utf8");
      await rm(join(view.rootPath, "docs", "notes.md"));
      await symlink(outside, join(view.rootPath, "docs", "notes.md"), "file");

      await expect(
        applyShareViewPathDelete({
          ...scope(view),
          relativePath: "docs/notes.md",
        }),
        "deleting over a symlink that replaced a tracked file follows it and destroys what it points at",
      ).rejects.toThrow(
        "dohc did not send your changes. docs/notes.md replaces a tracked file with a folder or another entry. Restore the file or move the conflicting entry. Fix this file, then send your changes again.",
      );

      expect(
        (await lstat(join(view.rootPath, "docs", "notes.md"))).isSymbolicLink(),
        "the symlink must survive a refused delete",
      ).toBe(true);
      await expect(readFile(outside, "utf8")).resolves.toBe("recipient file\n");
      expect(await storePaths(view)).toEqual(["docs/notes.md"]);
      await expect(
        readPendingMaterializationPaths(view.rootPath),
      ).resolves.toEqual(new Set());
    },
    60_000,
  );

it.skipIf(engine.missing)(
    "refuses to rename a tracked folder something outside dohc replaced with a symlink to another directory",
    async () => {
      const view = await harness("dohc-share-rename-folder-symlink-", "edit");
      await seedSharedFiles(view, [
        { path: "docs/plans/one.md", text: "one\n" },
        { path: "docs/plans/two.md", text: "two\n" },
      ]);
      const linkTarget = join(view.rootPath, "elsewhere");
      await mkdir(linkTarget);
      await writeFile(join(linkTarget, "one.md"), "recipient one\n", "utf8");
      await writeFile(join(linkTarget, "two.md"), "recipient two\n", "utf8");
      await rm(join(view.rootPath, "docs", "plans"), {
        recursive: true,
        force: true,
      });
      await symlink(
        linkTarget,
        join(view.rootPath, "docs", "plans"),
        "junction",
      );

      await expect(
        applyShareViewPathMove({
          ...scope(view),
          fromPath: "docs/plans",
          toPath: "docs/roadmap",
        }),
        "renaming a folder a symlink replaced follows the link per leaf and destroys the recipient's files at its target",
      ).rejects.toThrow(
        "dohc did not rename docs/plans. docs/plans replaces this shared folder with a link or another entry. Restore the folder or move the conflicting entry.",
      );

      expect(
        (await lstat(join(view.rootPath, "docs", "plans"))).isSymbolicLink(),
        "the symlink standing in for the folder must survive a refused rename",
      ).toBe(true);
      await expect(readFile(join(linkTarget, "one.md"), "utf8")).resolves.toBe(
        "recipient one\n",
      );
      await expect(readFile(join(linkTarget, "two.md"), "utf8")).resolves.toBe(
        "recipient two\n",
      );
      expect(await storePaths(view)).toEqual([
        "docs/plans/one.md",
        "docs/plans/two.md",
      ]);
      expect(await exists(join(view.rootPath, "docs", "roadmap"))).toBe(false);
      await expect(
        readPendingMaterializationPaths(view.rootPath),
      ).resolves.toEqual(new Set());
    },
    60_000,
  );

it.skipIf(engine.missing)(
    "puts a folder rename back when the engine refuses one of its files",
    async () => {
      const view = await harness("dohc-share-rename-midfail-", "edit");
      await seedSharedFiles(view, [
        { path: "docs/plans/one.md", text: "one\n" },
        { path: "docs/plans/two.md", text: "two\n" },
        { path: "docs/plans/three.md", text: "three\n" },
        { path: "docs/plans/four.md", text: "four\n" },
        { path: "docs/plans/five.md", text: "five\n" },
      ]);

      await expect(
        applyShareViewPathMove({
          ...scope(view),
          fromPath: "docs/plans",
          toPath: "docs/roadmap",
          shareViewStore: () => storeFailingAt(view.store, "renameTextFile", 3),
        }),
      ).rejects.toThrow(/engine refused renameTextFile call 3/);

      expect(
        await storePaths(view),
        "a failure part way through leaves half a folder renamed, and every one of those halves is proposable",
      ).toEqual([
        "docs/plans/five.md",
        "docs/plans/four.md",
        "docs/plans/one.md",
        "docs/plans/three.md",
        "docs/plans/two.md",
      ]);
      // The projection never moved either: it follows the store, and the
      // store went back to where it started.
      expect(await exists(join(view.rootPath, "docs", "roadmap"))).toBe(false);
      await expect(
        readFile(join(view.rootPath, "docs", "plans", "one.md"), "utf8"),
      ).resolves.toBe("one\n");
      await expect(
        readPendingMaterializationPaths(view.rootPath),
      ).resolves.toEqual(new Set());
    },
    60_000,
  );

it.skipIf(engine.missing)(
    "keeps putting files back after one put-back fails, and names what is left out of place",
    async () => {
      const view = await harness("dohc-share-putback-midfail-", "edit");
      await seedSharedFiles(view, [
        { path: "docs/plans/one.md", text: "one\n" },
        { path: "docs/plans/three.md", text: "three\n" },
        { path: "docs/plans/two.md", text: "two\n" },
        { path: "docs/plans/four.md", text: "four\n" },
      ]);
      // Paths move in sorted order — four, one, three, two — so calls 1-3 are
      // the forward renames that land, call 4 is the one that fails, and calls
      // 5-7 are the put-backs in reverse. Failing call 6 strands the middle
      // put-back: the two around it must still run.
      await expect(
        applyShareViewPathMove({
          ...scope(view),
          fromPath: "docs/plans",
          toPath: "docs/roadmap",
          shareViewStore: () =>
            storeFailingAt(view.store, "renameTextFile", 4, 6),
        }),
        "a put-back that abandons the list at the first failure strands every file after it too",
      ).rejects.toThrow("docs/roadmap/one.md is not at docs/plans/one.md");

      // Exactly one file is stranded; the put-backs on either side of the
      // failure ran, so their files are back where they started.
      expect(await storePaths(view)).toEqual([
        "docs/plans/four.md",
        "docs/plans/three.md",
        "docs/plans/two.md",
        "docs/roadmap/one.md",
      ]);
      const pending = await readPendingMaterializationPaths(view.rootPath);
      expect(pending).toContain("docs/plans/one.md");
      expect(pending).toContain("docs/roadmap/one.md");
    },
    60_000,
  );

it.skipIf(engine.missing)(
    "shows every delete that landed when the engine refuses one of them",
    async () => {
      const view = await harness("dohc-share-delete-midfail-", "edit");
      await seedSharedFiles(view, [
        { path: "docs/plans/one.md", text: "one\n" },
        { path: "docs/plans/two.md", text: "two\n" },
        { path: "docs/plans/three.md", text: "three\n" },
      ]);

      await expect(
        applyShareViewPathDelete({
          ...scope(view),
          relativePath: "docs/plans",
          shareViewStore: () => storeFailingAt(view.store, "deleteTextFile", 3),
        }),
      ).rejects.toThrow(/engine refused deleteTextFile call 3/);

      // A delete cannot be put back, so the rule is the other one: what
      // happened is visible. Files go in path order — one, three, two — so the
      // third call is the one that fails, and its file stays on both sides
      // while the two before it are gone from both.
      expect(await storePaths(view)).toEqual(["docs/plans/two.md"]);
      expect(
        await exists(join(view.rootPath, "docs", "plans", "one.md")),
        "a delete that fails part way leaves the projection holding files the store no longer has",
      ).toBe(false);
      expect(
        await exists(join(view.rootPath, "docs", "plans", "three.md")),
      ).toBe(false);
      await expect(
        readFile(join(view.rootPath, "docs", "plans", "two.md"), "utf8"),
      ).resolves.toBe("two\n");
    },
    60_000,
  );

it.skipIf(engine.missing)(
    "deletes a file as a moment and removes its projection",
    async () => {
      const view = await harness("dohc-share-delete-", "edit");
      await seedSharedFiles(view, [
        { path: "docs/note.md", text: "granter\n" },
        { path: "docs/keep.md", text: "keep\n" },
      ]);
      const journalBefore = replicationLogRows(view.rootPath);

      const result = await applyShareViewPathDelete({
        ...scope(view),
        relativePath: "docs/note.md",
      });

      expect(result).toEqual({ trashed: false });
      expect(
        await storePaths(view),
        "a delete that only removes the file leaves the store still holding it",
      ).toEqual(["docs/keep.md"]);
      expect(replicationLogRows(view.rootPath)).toBeGreaterThan(journalBefore);
      expect(await exists(join(view.rootPath, "docs", "note.md"))).toBe(false);
      await expect(
        readFile(join(view.rootPath, "docs", "keep.md"), "utf8"),
      ).resolves.toBe("keep\n");
    },
    60_000,
  );

it.skipIf(engine.missing)(
    "refuses to send a change for a path no moment describes, and leaves the file alone",
    async () => {
      const view = await harness("dohc-share-delete-local-", "edit");
      await seedSharedFiles(view, [
        { path: "docs/note.md", text: "granter\n" },
      ]);
      await writeFile(join(view.rootPath, "docs", "mine.md"), "mine\n", "utf8");

      await expect(
        applyShareViewPathDelete({
          ...scope(view),
          relativePath: "docs/mine.md",
        }),
        "deleting a path the store never had removes a file the granter can never be told about",
      ).rejects.toThrow(/not part of this shared view/);
      await expect(
        readFile(join(view.rootPath, "docs", "mine.md"), "utf8"),
      ).resolves.toBe("mine\n");

      await expect(
        applyShareViewPathMove({
          ...scope(view),
          fromPath: "docs/mine.md",
          toPath: "docs/renamed.md",
        }),
      ).rejects.toThrow(/not part of this shared view/);
      expect(await exists(join(view.rootPath, "docs", "renamed.md"))).toBe(
        false,
      );
    },
    60_000,
  );

it.skipIf(engine.missing)(
    "deletes a folder as the files under it, and removes the directory",
    async () => {
      const view = await harness("dohc-share-delete-dir-", "edit");
      await seedSharedFiles(view, [
        { path: "docs/plans/one.md", text: "one\n" },
        { path: "docs/plans/two.md", text: "two\n" },
        { path: "docs/keep.md", text: "keep\n" },
      ]);

      await applyShareViewPathDelete({
        ...scope(view),
        relativePath: "docs/plans",
      });

      expect(
        await storePaths(view),
        "deleting only the directory leaves every file under it in the store",
      ).toEqual(["docs/keep.md"]);
      expect(await readdir(join(view.rootPath, "docs"))).toEqual(["keep.md"]);
    },
    60_000,
  );
});
