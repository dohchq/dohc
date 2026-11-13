import { lstat, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readPendingMaterializationPaths } from "./sharedView";
import {
  engine,
  harness,
  seedSharedFiles,
  scope,
  storeReplacingLeafAtMutationBoundary,
  expectLeafReplacementAtMutationBoundary,
  applyShareViewPathMove,
  applyShareViewPathDelete,
  storeFailingAt,
  storePaths,
  exists,
} from "./shareViewFileOps.fixture";

describe("share-view file operations through the real store", () => {
  it.skipIf(engine.missing)(
    "refuses to delete a folder that holds files no moment describes",
    async () => {
      const view = await harness("dohc-share-delete-dir-local-", "edit");
      await seedSharedFiles(view, [
        { path: "docs/plans/one.md", text: "one\n" },
        { path: "docs/plans/two.md", text: "two\n" },
      ]);
      await writeFile(join(view.rootPath, "docs", "plans", "mine.md"), "mine\n", "utf8");

      await expect(
        applyShareViewPathDelete({
          ...scope(view),
          relativePath: "docs/plans",
        }),
        "deleting a folder removes it whole, destroying the files under it the store never held",
      ).rejects.toThrow(
        "docs/plans holds 1 file that is not part of this shared view: docs/plans/mine.md. Move it out of the folder first.",
      );

      await expect(readFile(join(view.rootPath, "docs", "plans", "mine.md"), "utf8")).resolves.toBe(
        "mine\n",
      );
      expect(await storePaths(view)).toEqual(["docs/plans/one.md", "docs/plans/two.md"]);
    },
    60_000,
  );

  it.skipIf(engine.missing)(
    "refuses to delete a tracked file something outside dohc replaced with a directory",
    async () => {
      const view = await harness("dohc-share-delete-dir-replacement-", "edit");
      await seedSharedFiles(view, [{ path: "docs/notes.md", text: "granter\n" }]);
      let replacementRan = false;
      const late = storeReplacingLeafAtMutationBoundary(view.store, async () => {
        replacementRan = true;
        await rm(join(view.rootPath, "docs", "notes.md"));
        await mkdir(join(view.rootPath, "docs", "notes.md"));
        await writeFile(
          join(view.rootPath, "docs", "notes.md", "inside.txt"),
          "recipient file\n",
          "utf8",
        );
      });

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
      await symlink(linkTarget, join(view.rootPath, "docs", "plans"), "junction");

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
      await expect(readFile(join(linkTarget, "one.md"), "utf8")).resolves.toBe("recipient one\n");
      await expect(readFile(join(linkTarget, "two.md"), "utf8")).resolves.toBe("recipient two\n");
      expect(await storePaths(view)).toEqual(["docs/plans/one.md", "docs/plans/two.md"]);
      expect(await exists(join(view.rootPath, "docs", "roadmap"))).toBe(false);
      await expect(readPendingMaterializationPaths(view.rootPath)).resolves.toEqual(new Set());
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
          shareViewStore: () => storeFailingAt(view.store, "renameTextFile", 4, 6),
        }),
        "a put-back that abandons the list at the first failure strands every file after it too",
      ).rejects.toThrow("docs/roadmap/one.md is not at docs/plans/one.md");

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
      expect(await exists(join(view.rootPath, "docs", "plans", "three.md"))).toBe(false);
      await expect(readFile(join(view.rootPath, "docs", "plans", "two.md"), "utf8")).resolves.toBe(
        "two\n",
      );
    },
    60_000,
  );
});
