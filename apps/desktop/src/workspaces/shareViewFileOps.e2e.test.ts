import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { type CaptureVersionedTextStore } from "./workspaceEngineCaptureLiveStore";
import { withStaleSensitiveWorkspaceOperation } from "./workspaceAssets";
import { engine, SHARE_ID, harness, flushCapture, seedSharedFiles, scope, shareViewFilesOwner, settleShareViewThroughOwner, applyShareViewTextWrite, applyShareViewFileCreate, storePaths, replicationLogRows, exists } from './shareViewFileOps.fixture';

describe("share-view file operations through the real store", () => {
it.skipIf(engine.missing)("keeps a Collection file apart after rebuilding its saved list", async () => {
    const written: string[][] = [];
    const uploaded: string[] = [];
    const collectionWritePaths: Array<string | null> = [];
    const ownFileSha256 = createHash("sha256").update("my own file").digest("hex");
    const server = createServer((request, response) => {
      void (async () => {
        if (request.method === "POST" && request.url === `/sync/shares/${SHARE_ID}/collection-writes`) {
          const chunks: Buffer[] = [];
          for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
          const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { changes: Array<{ basedOnPath: string | null; afterPath: string | null }> };
          collectionWritePaths.push(...body.changes.flatMap(change => [change.basedOnPath, change.afterPath]));
          const paths = body.changes.flatMap(change => change.afterPath == null ? [] : [change.afterPath]);
          written.push(paths);
          response.writeHead(200, { "content-type": "application/json", connection: "close" });
          response.end(JSON.stringify({ paths }));
        } else if (request.method === "PUT" && request.url?.startsWith(`/sync/shares/${SHARE_ID}/blobs/`)) {
          const sha256 = request.url.slice(`/sync/shares/${SHARE_ID}/blobs/`.length);
          uploaded.push(sha256);
          let byteLength = 0;
          for await (const chunk of request) byteLength += Buffer.byteLength(chunk);
          response.writeHead(200, { "content-type": "application/json", connection: "close" });
          response.end(JSON.stringify({ ok: true, shareId: SHARE_ID, sha256, byteLength }));
        } else {
          response.writeHead(500, { connection: "close" });
          response.end("Unexpected request");
        }
      })().catch((error: unknown) => {
        response.writeHead(500, { connection: "close" });
        response.end(error instanceof Error ? error.message : String(error));
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const address = server.address();
      if (address === null || typeof address === "string") throw new Error("No relay address");
      const view = await harness("dohc-kept-collection-", "edit", { relayUrl: `http://127.0.0.1:${address.port}` });
      if (!view.directClient) throw new Error("No share client");
      const path = "docs/packing/collection.yaml";
      const controlPath = "docs/packing/automations.yaml";
      await seedSharedFiles(view, [{ path, text: "fields: {}\n" }, { path: controlPath, text: "actions: []\n" }]);
      const grantedSelector = { paths: ["docs"], versionId: null, access: "edit" as const };
      await expect(view.directClient.pushDirectWrites({ shareId: SHARE_ID, grantedSelector }))
        .resolves.toEqual({ writes: [{ paths: [path, controlPath], result: "written" }], morePending: false });
      expect([...uploaded].sort()).toEqual(
        ["fields: {}\n", "actions: []\n"].map(text => createHash("sha256").update(text).digest("hex")).sort(),
      );
      expect(collectionWritePaths.filter(value => value != null).sort()).toEqual([path, controlPath].sort());
      uploaded.length = 0;
      collectionWritePaths.length = 0;
      written.length = 0;
      const beforeRefresh = replicationLogRows(view.rootPath);
      await writeFile(join(view.rootPath, path), "my own file", "utf8");
      const record = join(view.rootPath, ".dohc", "local", "share-refresh", "share-collision-record.json");
      await mkdir(dirname(record), { recursive: true, mode: 0o700 });
      await writeFile(record, "not json", { mode: 0o600 });
      const owner = shareViewFilesOwner(view, view.store);
      for (let pass = 0; pass < 2; pass += 1) {
        await withStaleSensitiveWorkspaceOperation(view.rootPath,
          lease => owner.files.reconcile(lease, owner.requested, "refresh"));
      }
      await expect(view.directClient.pushDirectWrites({ shareId: SHARE_ID, grantedSelector }))
        .resolves.toEqual({ writes: [], morePending: false });
      expect(uploaded).not.toContain(ownFileSha256);
      expect(collectionWritePaths).not.toContain(path);
      expect(written).toEqual([]);
      expect(replicationLogRows(view.rootPath)).toBe(beforeRefresh);
      expect(await readFile(join(view.rootPath, path), "utf8")).toBe("my own file");
      expect(JSON.parse(await readFile(record, "utf8"))).toEqual({ shareId: SHARE_ID, paths: [path] });

      const main = await view.store.ensureMainVersion({ workspaceId: view.workspaceId });
      await view.store.writeTextFile({ workspaceId: view.workspaceId, versionId: main.id, path: controlPath,
        text: "actions: []\n# updated\n", metadata: { origin: "api" } });
      await expect(view.directClient.pushDirectWrites({ shareId: SHARE_ID, grantedSelector }))
        .resolves.toMatchObject({ writes: [{ paths: [controlPath], result: "written" }] });
      expect(uploaded).not.toContain(ownFileSha256);
      expect(collectionWritePaths).not.toContain(path);
      expect(written).toEqual([[controlPath]]);
      expect(await readFile(join(view.rootPath, path), "utf8")).toBe("my own file");
      expect(JSON.parse(await readFile(record, "utf8"))).toEqual({ shareId: SHARE_ID, paths: [path] });
    } finally {
      errorLog.mockRestore();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
  }, 60_000);

it.skipIf(engine.missing)(
    "opens an access-bearing received share with capture disabled",
    async () => {
      const view = await harness("dohc-share-capture-posture-", "edit");

      await expect(flushCapture(view)).resolves.toEqual({ deferredWrites: [],
        heldFiles: [],
        running: false,
        settled: false,
        degraded: true,
      });
    },
  );

it.skipIf(engine.missing)(
    "journals out-of-app and in-app edits for the same submit lane",
    async () => {
      const view = await harness("dohc-share-outside-edit-", "edit");
      const outsidePath = "docs/outside.md";
      const inAppPath = "docs/in-app.md";
      await seedSharedFiles(view, [
        { path: outsidePath, text: "outside before\n" },
        { path: inAppPath, text: "in-app before\n" },
      ]);
      await writeFile(
        join(view.rootPath, outsidePath),
        "outside after\n",
        "utf8",
      );

      const beforeOutside = replicationLogRows(view.rootPath);
      await expect(
        settleShareViewThroughOwner(view, view.store),
      ).resolves.toEqual({
        capturedPaths: 1,
        repairedPaths: 0,
        unjournalablePaths: [],
      });
      const afterOutside = replicationLogRows(view.rootPath);
      const outsideRows = afterOutside - beforeOutside;
      expect(outsideRows).toBeGreaterThan(0);
      const outsideSummary = (
        await view.store.listMoments({
          workspaceId: view.workspaceId,
          limit: 200,
        })
      ).moments.find(
        (moment) =>
          moment.path === outsidePath &&
          moment.metadata.origin === "local-file",
      );
      expect(outsideSummary?.metadata.origin).toBe("local-file");
      const outsideMoment = outsideSummary
        ? await view.store.getMoment({
            workspaceId: view.workspaceId,
            momentId: outsideSummary.id,
          })
        : null;
      expect(outsideMoment?.payload.after.text).toBe("outside after\n");

      const result = await applyShareViewTextWrite({
        ...scope(view),
        relativePath: inAppPath,
        text: "in-app after\n",
        expectedContentHash: createHash("sha256")
          .update("in-app before\n")
          .digest("hex"),
      });
      expect(result.status).toBe("written");
      const inAppRows = replicationLogRows(view.rootPath) - afterOutside;
      expect(inAppRows).toBe(outsideRows);
      const inAppSummary = (
        await view.store.listMoments({
          workspaceId: view.workspaceId,
          limit: 200,
        })
      ).moments.find(
        (moment) =>
          moment.path === inAppPath && moment.metadata.origin === "local-file",
      );
      expect(inAppSummary?.metadata.origin).toBe("local-file");
      const inAppMoment = inAppSummary
        ? await view.store.getMoment({
            workspaceId: view.workspaceId,
            momentId: inAppSummary.id,
          })
        : null;
      expect(inAppMoment?.payload.after.text).toBe("in-app after\n");
    },
    60_000,
  );

it.skipIf(engine.missing)(
    "makes a recipient's new file a proposable moment, not just a file",
    async () => {
      const view = await harness("dohc-share-create-", "edit");
      await seedSharedFiles(view, [
        { path: "docs/note.md", text: "granter\n" },
      ]);
      const journalBefore = replicationLogRows(view.rootPath);

      const path = await applyShareViewFileCreate({
        ...scope(view),
        relativePath: "docs/added.md",
        initialText: "recipient\n",
      });

      expect(path).toBe("docs/added.md");
      expect(await storePaths(view)).toEqual(["docs/added.md", "docs/note.md"]);
      expect(
        replicationLogRows(view.rootPath),
        "a create that only writes the file is a change the submit lane cannot see",
      ).toBeGreaterThan(journalBefore);
      await expect(
        readFile(join(view.rootPath, "docs", "added.md"), "utf8"),
      ).resolves.toBe("recipient\n");
    },
    60_000,
  );

it.skipIf(engine.missing)(
    "repairs a create interrupted after the store write instead of journaling a delete",
    async () => {
      const view = await harness("dohc-share-interrupted-create-", "edit");
      const path = "docs/added.md";
      const failingStore: CaptureVersionedTextStore = {
        ...view.store,
        async writeTextFile(input) {
          await view.store.writeTextFile(input);
          throw new Error("simulated crash after store write");
        },
      };

      await expect(
        applyShareViewFileCreate({
          ...scope(view),
          relativePath: path,
          initialText: "recipient\n",
          shareViewStore: () => failingStore,
        }),
      ).resolves.toBe(path);

      const pathsBeforeRecovery = await storePaths(view);
      await expect(
        settleShareViewThroughOwner(view, view.store),
      ).resolves.toEqual({
        capturedPaths: 0,
        repairedPaths: 1,
        unjournalablePaths: [],
      });
      expect(await storePaths(view)).toEqual(pathsBeforeRecovery);
      await expect(readFile(join(view.rootPath, path), "utf8")).resolves.toBe(
        "recipient\n",
      );
    },
    60_000,
  );

it.skipIf(engine.missing)(
    "leaves a file the recipient put in the folder by hand alone",
    async () => {
      const view = await harness("dohc-share-create-local-", "edit");
      await seedSharedFiles(view, [
        { path: "docs/note.md", text: "granter\n" },
      ]);
      // A local addition: the projection holds it, the store does not, and
      // `repairSharedViewProjection` leaves it there because it is user data.
      await writeFile(join(view.rootPath, "docs", "mine.md"), "mine\n", "utf8");
      const journalBefore = replicationLogRows(view.rootPath);
      const owner = shareViewFilesOwner(view, view.store);

      await expect(
        withStaleSensitiveWorkspaceOperation(view.rootPath, (lease) =>
          owner.files.change(lease, owner.requested, {
            kind: "create",
            path: "docs/mine.md",
            initialText: "# overwritten\n",
          }),
        ),
        "a create reports success for a path occupied only by the recipient's own file",
      ).rejects.toThrow(/already exists/);
      await expect(
        readFile(join(view.rootPath, "docs", "mine.md"), "utf8"),
        "a create that journals over an occupied path destroys the recipient's own file",
      ).resolves.toBe("mine\n");
      expect(replicationLogRows(view.rootPath)).toBe(journalBefore);
    },
    60_000,
  );
});
