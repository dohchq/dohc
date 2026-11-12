import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { type CaptureVersionedTextStore } from "./workspaceEngineCaptureLiveStore";
import { withStaleSensitiveWorkspaceOperation } from "./workspaceAssets";
import { movePath } from "./workspaceFiles";
import { engine, harness, seedSharedFiles, scope, shareViewFilesOwner, settleShareViewThroughOwner, applyShareViewPathMove, applyShareViewPathDelete, waitForStorePaths, storePaths, replicationLogRows, exists } from './shareViewFileOps.fixture';

describe("share-view file operations through the real store", () => {
it.skipIf(engine.missing)(
    "renames a file in the store and moves its projection with it",
    async () => {
      const view = await harness("dohc-share-rename-", "edit");
      await seedSharedFiles(view, [
        { path: "docs/note.md", text: "granter\n" },
      ]);
      const journalBefore = replicationLogRows(view.rootPath);

      const path = await applyShareViewPathMove({
        ...scope(view),
        fromPath: "docs/note.md",
        toPath: "docs/renamed.md",
      });

      expect(path).toBe("docs/renamed.md");
      expect(
        await storePaths(view),
        "a rename that only moves the file leaves the store naming the old path",
      ).toEqual(["docs/renamed.md"]);
      expect(replicationLogRows(view.rootPath)).toBeGreaterThan(journalBefore);
      await expect(
        readFile(join(view.rootPath, "docs", "renamed.md"), "utf8"),
      ).resolves.toBe("granter\n");
      expect(await exists(join(view.rootPath, "docs", "note.md"))).toBe(false);
    },
    60_000,
  );

it.skipIf(engine.missing)(
    "keeps refresh capture outside a rename's store-to-projection gap",
    async () => {
      const view = await harness("dohc-share-rename-capture-race-", "edit");
      const fromPath = "docs/note.md";
      const toPath = "docs/renamed.md";
      await seedSharedFiles(view, [{ path: fromPath, text: "granter\n" }]);

      let signalStoreRenamed!: () => void;
      const storeRenamed = new Promise<void>((resolve) => {
        signalStoreRenamed = resolve;
      });
      let releaseRename!: () => void;
      const holdRename = new Promise<void>((resolve) => {
        releaseRename = resolve;
      });
      const pausedStore = new Proxy(view.store, {
        get(target, property, receiver) {
          const value = Reflect.get(target, property, receiver) as unknown;
          if (property !== "renameTextFile" || typeof value !== "function") {
            return value;
          }
          return async (...args: unknown[]) => {
            const result = await (
              value as (...inner: unknown[]) => unknown
            ).apply(target, args);
            signalStoreRenamed();
            await holdRename;
            return result;
          };
        },
      }) as CaptureVersionedTextStore;
      const owner = shareViewFilesOwner(view, pausedStore);

      const moving = withStaleSensitiveWorkspaceOperation(
        view.rootPath,
        (lease) =>
          owner.files.change(lease, owner.requested, {
            kind: "move",
            fromPath,
            toPath,
          }),
      );
      await storeRenamed;

      let captureEnteredGap = false;
      const observingStore = new Proxy(view.store, {
        get(target, property, receiver) {
          const value = Reflect.get(target, property, receiver) as unknown;
          if (property !== "ensureMainVersion" || typeof value !== "function") {
            return value;
          }
          return (...args: unknown[]) => {
            captureEnteredGap = true;
            return (value as (...inner: unknown[]) => unknown).apply(
              target,
              args,
            );
          };
        },
      }) as CaptureVersionedTextStore;
      const capturing = settleShareViewThroughOwner(view, observingStore);
      for (let turn = 0; turn < 20 && !captureEnteredGap; turn += 1) {
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
      const captureStartedBeforeProjection = captureEnteredGap;

      releaseRename();
      await expect(moving).resolves.toMatchObject({
        status: "committed",
        kind: "move",
        value: toPath,
      });
      const captured = await capturing;

      expect(
        captureStartedBeforeProjection,
        "removing the mutation's lifecycle lock lets capture observe the renamed store before its projection",
      ).toBe(false);
      expect(captured).toEqual({
        capturedPaths: 0,
        repairedPaths: 0,
        unjournalablePaths: [],
      });
      expect(await storePaths(view)).toEqual([toPath]);
      expect(await exists(join(view.rootPath, fromPath))).toBe(false);
      await expect(readFile(join(view.rootPath, toPath), "utf8")).resolves.toBe(
        "granter\n",
      );

      const destinationMoments = (
        await view.store.listMoments({
          workspaceId: view.workspaceId,
          limit: 200,
        })
      ).moments
        .filter(
          (moment) =>
            moment.path === toPath && moment.metadata.origin === "local-file",
        )
        .map((moment) => moment.operation);
      expect(
        destinationMoments,
        "capture in the rename gap journals a delete on top of the destination",
      ).toEqual(["rename"]);
    },
    60_000,
  );

it.skipIf(engine.missing)(
    "renames a folder as the files under it, and leaves no empty directory behind",
    async () => {
      const view = await harness("dohc-share-rename-dir-", "edit");
      await seedSharedFiles(view, [
        { path: "docs/plans/one.md", text: "one\n" },
        { path: "docs/plans/two.md", text: "two\n" },
      ]);

      await applyShareViewPathMove({
        ...scope(view),
        fromPath: "docs/plans",
        toPath: "docs/roadmap",
      });

      expect(
        await storePaths(view),
        "renaming only the directory leaves every file under it naming the old path",
      ).toEqual(["docs/roadmap/one.md", "docs/roadmap/two.md"]);
      expect(await readdir(join(view.rootPath, "docs"))).toEqual(["roadmap"]);
      await expect(
        readFile(join(view.rootPath, "docs", "roadmap", "two.md"), "utf8"),
      ).resolves.toBe("two\n");
    },
    60_000,
  );

it.skipIf(engine.missing)(
    "refuses a rename onto a name the folder already holds",
    async () => {
      const view = await harness("dohc-share-rename-onto-", "edit");
      await seedSharedFiles(view, [
        { path: "docs/note.md", text: "granter\n" },
      ]);
      await writeFile(join(view.rootPath, "docs", "mine.md"), "mine\n", "utf8");

      await expect(
        applyShareViewPathMove({
          ...scope(view),
          fromPath: "docs/note.md",
          toPath: "docs/mine.md",
        }),
        "a rename that asks only the store overwrites the recipient's own file",
      ).rejects.toThrow(/already exists/);

      await expect(
        readFile(join(view.rootPath, "docs", "mine.md"), "utf8"),
      ).resolves.toBe("mine\n");
      await expect(
        readFile(join(view.rootPath, "docs", "note.md"), "utf8"),
      ).resolves.toBe("granter\n");
      expect(await storePaths(view)).toEqual(["docs/note.md"]);
    },
    60_000,
  );

it.skipIf(engine.missing)(
    "renames a file whose name differs only in case",
    async () => {
      const view = await harness("dohc-share-rename-case-", "edit");
      await seedSharedFiles(view, [
        { path: "docs/note.md", text: "granter\n" },
      ]);

      // The carve-out `movePath` already makes: on a case-insensitive
      // filesystem the destination "exists" because it IS the source, and
      // refusing there would block a rename the user plainly meant.
      const path = await applyShareViewPathMove({
        ...scope(view),
        fromPath: "docs/note.md",
        toPath: "docs/Note.md",
      });

      expect(path).toBe("docs/Note.md");
      await waitForStorePaths(
        view,
        ["docs/Note.md"],
        "an occupied-name check without the case carve-out refuses a rename that only changes case",
      );
      await expect(
        readFile(join(view.rootPath, "docs", "Note.md"), "utf8"),
      ).resolves.toBe("granter\n");
    },
    60_000,
  );

it.skipIf(engine.missing)(
    "renames a folder whose name differs only in case, keeping the files in it",
    async () => {
      const view = await harness("dohc-share-dir-case-", "edit");
      await seedSharedFiles(view, [
        { path: "docs/Plans/one.md", text: "one\n" },
        { path: "docs/Plans/two.md", text: "two\n" },
      ]);

      await applyShareViewPathMove({
        ...scope(view),
        fromPath: "docs/Plans",
        toPath: "docs/plans",
      });

      await waitForStorePaths(
        view,
        ["docs/plans/one.md", "docs/plans/two.md"],
        "The case-only folder rename never settled in the store",
      );
      expect(
        await readdir(join(view.rootPath, "docs")),
        "a case-only folder rename changes the store spelling but leaves the old directory spelling on disk",
      ).toEqual(["plans"]);
      // The cleanup that removes an emptied source folder must not run when
      // the source and the destination are the same folder: it would remove
      // the files this rename just put there.
      await expect(
        readFile(join(view.rootPath, "docs", "plans", "one.md"), "utf8"),
        "a case-only folder rename deletes everything it just moved",
      ).resolves.toBe("one\n");
      await expect(
        readFile(join(view.rootPath, "docs", "plans", "two.md"), "utf8"),
      ).resolves.toBe("two\n");
    },
    60_000,
  );

it.skipIf(engine.missing)(
    "refuses to move a folder onto one that holds files no moment describes",
    async () => {
      const view = await harness("dohc-share-move-into-", "edit");
      await seedSharedFiles(view, [
        { path: "docs/plans/one.md", text: "one\n" },
      ]);
      await mkdir(join(view.rootPath, "docs", "roadmap"), { recursive: true });
      await writeFile(
        join(view.rootPath, "docs", "roadmap", "mine.md"),
        "mine\n",
        "utf8",
      );

      await expect(
        applyShareViewPathMove({
          ...scope(view),
          fromPath: "docs/plans",
          toPath: "docs/roadmap",
        }),
        "a move screens only the folder it leaves, and merges into one holding files the store never had",
      ).rejects.toThrow(/not part of this shared view/);

      await expect(
        readFile(join(view.rootPath, "docs", "roadmap", "mine.md"), "utf8"),
      ).resolves.toBe("mine\n");
      expect(await storePaths(view)).toEqual(["docs/plans/one.md"]);
    },
    60_000,
  );

it.skipIf(engine.missing)(
    "refuses to move a folder onto an existing folder in the store",
    async () => {
      const view = await harness("dohc-share-move-store-folder-", "edit");
      await seedSharedFiles(view, [
        { path: "docs/plans/one.md", text: "one\n" },
        { path: "docs/roadmap/keep.md", text: "keep\n" },
      ]);

      await expect(
        applyShareViewPathMove({
          ...scope(view),
          fromPath: "docs/plans",
          toPath: "docs/roadmap",
        }),
        "a folder move merges into an existing canonical folder",
      ).rejects.toThrow(/already exists/);

      expect(await storePaths(view)).toEqual([
        "docs/plans/one.md",
        "docs/roadmap/keep.md",
      ]);
      await expect(
        readFile(join(view.rootPath, "docs", "plans", "one.md"), "utf8"),
      ).resolves.toBe("one\n");
      await expect(
        readFile(join(view.rootPath, "docs", "roadmap", "keep.md"), "utf8"),
      ).resolves.toBe("keep\n");
    },
    60_000,
  );

it.skipIf(engine.missing)(
    "refuses to move a folder that holds files no moment describes",
    async () => {
      const view = await harness("dohc-share-rename-dir-local-", "edit");
      await seedSharedFiles(view, [
        { path: "docs/plans/one.md", text: "one\n" },
        { path: "docs/plans/two.md", text: "two\n" },
      ]);
      await writeFile(
        join(view.rootPath, "docs", "plans", "mine.md"),
        "mine\n",
        "utf8",
      );

      // The exact sentence, not a fragment every refusal in this module
      // shares: a scan that returned nothing would raise the "nothing to move"
      // refusal, which also contains that fragment, and this test could not
      // tell the two apart.
      await expect(
        applyShareViewPathMove({
          ...scope(view),
          fromPath: "docs/plans",
          toPath: "docs/roadmap",
        }),
        "moving a folder removes it whole, destroying the files under it the store never held",
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
      expect(await exists(join(view.rootPath, "docs", "roadmap"))).toBe(false);
    },
    60_000,
  );

it.skipIf(engine.missing)(
    "names the first three files it will not move, and counts the rest",
    async () => {
      const view = await harness("dohc-share-untracked-many-", "edit");
      await seedSharedFiles(view, [
        { path: "docs/plans/one.md", text: "one\n" },
      ]);
      for (const name of ["a.md", "b.md", "c.md", "d.md", "e.md"]) {
        await writeFile(
          join(view.rootPath, "docs", "plans", name),
          "mine\n",
          "utf8",
        );
      }

      await expect(
        applyShareViewPathDelete({
          ...scope(view),
          relativePath: "docs/plans",
        }),
        "a refusal that lists every file is unreadable at the size a real folder reaches",
      ).rejects.toThrow(
        "docs/plans holds 5 files that are not part of this shared view: docs/plans/a.md, docs/plans/b.md, docs/plans/c.md, and 2 more. Move them out of the folder first.",
      );
    },
    60_000,
  );

it.skipIf(engine.missing)(
    "renames a binary file without corrupting its bytes",
    async () => {
      const view = await harness("dohc-share-rename-binary-", "edit");
      const main = await view.store.ensureMainVersion({
        workspaceId: view.workspaceId,
      });
      // Bytes that are not valid UTF-8, so a text round trip cannot survive
      // them: this is what a rename materializing through `readTextFile`
      // would silently replace with an empty file.
      const bytes = Buffer.from([
        0x89, 0x50, 0x4e, 0x47, 0x00, 0xff, 0xfe, 0x01,
      ]);
      await view.store.writeBinaryFile({
        workspaceId: view.workspaceId,
        versionId: main.id,
        path: "docs/picture.png",
        bytes,
        metadata: { origin: "sync" },
      });
      await mkdir(join(view.rootPath, "docs"), { recursive: true });
      await writeFile(join(view.rootPath, "docs", "picture.png"), bytes);

      const path = await applyShareViewPathMove({
        ...scope(view),
        fromPath: "docs/picture.png",
        toPath: "docs/renamed.png",
      });

      expect(path).toBe("docs/renamed.png");
      expect(
        await storePaths(view),
        "a binary file the store lists as text is dropped from a folder scan entirely",
      ).toEqual(["docs/renamed.png"]);
      await expect(
        readFile(join(view.rootPath, "docs", "renamed.png")),
        "materializing a renamed binary through readTextFile lands an empty or corrupt file",
      ).resolves.toEqual(bytes);
    },
    60_000,
  );
});
