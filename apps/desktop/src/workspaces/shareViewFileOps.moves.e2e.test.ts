import { readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { type CaptureVersionedTextStore } from "./workspaceEngineCaptureLiveStore";
import { withStaleSensitiveWorkspaceOperation } from "./workspaceAssets";
import { engine, harness, seedSharedFiles, scope, shareViewFilesOwner, settleShareViewThroughOwner, applyShareViewPathMove, waitForStorePaths, storePaths, exists } from './shareViewFileOps.fixture';

describe("share-view file operations through the real store", () => {

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

});
