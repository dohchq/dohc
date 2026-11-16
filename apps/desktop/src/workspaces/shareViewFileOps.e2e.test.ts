import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { type CaptureVersionedTextStore } from "./workspaceEngineCaptureLiveStore";
import { withStaleSensitiveWorkspaceOperation } from "./workspaceAssets";
import { JOINED_BY_ANOTHER_ACCOUNT } from "../ipc/joinedAccountWords";
import { readSharedViewProjectionDebt } from "./sharedView";
import {
  signedInAccountFrom,
  type ShareViewAccount,
  type ShareViewFileChange,
} from "./shareViewFiles";
import { CredentialSessionCache } from "./credentialSessionCache";
import {
  engine,
  JOINED_RELAY_URL,
  SHARE_ID,
  harness,
  seedSharedFiles,
  scope,
  shareViewFilesOwner,
  settleShareViewThroughOwner,
  applyShareViewFileCreate,
  storePaths,
  replicationLogRows,
  exists,
} from "./shareViewFileOps.fixture";

describe("share-view file operations through the real store", () => {
  it.skipIf(engine.missing)(
    "keeps a Collection file apart after rebuilding its saved list",
    async () => {
      const written: string[][] = [];
      const uploaded: string[] = [];
      const collectionWritePaths: Array<string | null> = [];
      const ownFileSha256 = createHash("sha256").update("my own file").digest("hex");
      const server = createServer((request, response) => {
        void (async () => {
          if (
            request.method === "POST" &&
            request.url === `/sync/shares/${SHARE_ID}/collection-writes`
          ) {
            const chunks: Buffer[] = [];
            for await (const chunk of request)
              chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
            const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
              changes: Array<{ basedOnPath: string | null; afterPath: string | null }>;
            };
            collectionWritePaths.push(
              ...body.changes.flatMap((change) => [change.basedOnPath, change.afterPath]),
            );
            const paths = body.changes.flatMap((change) =>
              change.afterPath == null ? [] : [change.afterPath],
            );
            written.push(paths);
            response.writeHead(200, { "content-type": "application/json", connection: "close" });
            response.end(JSON.stringify({ paths }));
          } else if (
            request.method === "PUT" &&
            request.url?.startsWith(`/sync/shares/${SHARE_ID}/blobs/`)
          ) {
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
        const view = await harness("dohc-kept-collection-", "edit", {
          relayUrl: `http://127.0.0.1:${address.port}`,
        });
        if (!view.directClient) throw new Error("No share client");
        const path = "docs/packing/collection.yaml";
        const controlPath = "docs/packing/automations.yaml";
        await seedSharedFiles(view, [
          { path, text: "fields: {}\n" },
          { path: controlPath, text: "actions: []\n" },
        ]);
        const grantedSelector = { paths: ["docs"], versionId: null, access: "edit" as const };
        await expect(
          view.directClient.pushDirectWrites({ shareId: SHARE_ID, grantedSelector }),
        ).resolves.toEqual({
          writes: [{ paths: [path, controlPath], result: "written" }],
          morePending: false,
        });
        expect([...uploaded].sort()).toEqual(
          ["fields: {}\n", "actions: []\n"]
            .map((text) => createHash("sha256").update(text).digest("hex"))
            .sort(),
        );
        expect(collectionWritePaths.filter((value) => value != null).sort()).toEqual(
          [path, controlPath].sort(),
        );
        uploaded.length = 0;
        collectionWritePaths.length = 0;
        written.length = 0;
        const beforeRefresh = replicationLogRows(view.rootPath);
        await writeFile(join(view.rootPath, path), "my own file", "utf8");
        const record = join(
          view.rootPath,
          ".dohc",
          "local",
          "share-refresh",
          "share-collision-record.json",
        );
        await mkdir(dirname(record), { recursive: true, mode: 0o700 });
        await writeFile(record, "not json", { mode: 0o600 });
        const owner = shareViewFilesOwner(view, view.store);
        for (let pass = 0; pass < 2; pass += 1) {
          await withStaleSensitiveWorkspaceOperation(view.rootPath, (lease) =>
            owner.files.reconcile(lease, owner.requested, "refresh"),
          );
        }
        await expect(
          view.directClient.pushDirectWrites({ shareId: SHARE_ID, grantedSelector }),
        ).resolves.toEqual({ writes: [], morePending: false });
        expect(uploaded).not.toContain(ownFileSha256);
        expect(collectionWritePaths).not.toContain(path);
        expect(written).toEqual([]);
        expect(replicationLogRows(view.rootPath)).toBe(beforeRefresh);
        expect(await readFile(join(view.rootPath, path), "utf8")).toBe("my own file");
        expect(JSON.parse(await readFile(record, "utf8"))).toEqual({
          shareId: SHARE_ID,
          paths: [path],
        });

        const main = await view.store.ensureMainVersion({ workspaceId: view.workspaceId });
        await view.store.writeTextFile({
          workspaceId: view.workspaceId,
          versionId: main.id,
          path: controlPath,
          text: "actions: []\n# updated\n",
          metadata: { origin: "api" },
        });
        await expect(
          view.directClient.pushDirectWrites({ shareId: SHARE_ID, grantedSelector }),
        ).resolves.toMatchObject({ writes: [{ paths: [controlPath], result: "written" }] });
        expect(uploaded).not.toContain(ownFileSha256);
        expect(collectionWritePaths).not.toContain(path);
        expect(written).toEqual([[controlPath]]);
        expect(await readFile(join(view.rootPath, path), "utf8")).toBe("my own file");
        expect(JSON.parse(await readFile(record, "utf8"))).toEqual({
          shareId: SHARE_ID,
          paths: [path],
        });
      } finally {
        errorLog.mockRestore();
        await new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        );
      }
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
      await expect(settleShareViewThroughOwner(view, view.store)).resolves.toEqual({
        capturedPaths: 0,
        repairedPaths: 1,
        unjournalablePaths: [],
      });
      expect(await storePaths(view)).toEqual(pathsBeforeRecovery);
      await expect(readFile(join(view.rootPath, path), "utf8")).resolves.toBe("recipient\n");
    },
    60_000,
  );

  it.skipIf(engine.missing)(
    "leaves a file the recipient put in the folder by hand alone",
    async () => {
      const view = await harness("dohc-share-create-local-", "edit");
      await seedSharedFiles(view, [{ path: "docs/note.md", text: "granter\n" }]);
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
  it.skipIf(engine.missing)(
    "refuses a joined workspace's changes while another account is signed in",
    async () => {
      const view = await harness("dohc-share-other-account-", "edit");
      const text = "granter\n";
      await seedSharedFiles(view, [{ path: "docs/note.md", text }]);
      const joinedAccount: ShareViewAccount = { userId: "recipient-a", relayUrl: JOINED_RELAY_URL };
      const otherAccount: ShareViewAccount = { userId: "someone-else", relayUrl: JOINED_RELAY_URL };
      let signedIn: ShareViewAccount | null = otherAccount;
      const hash = createHash("sha256").update(text).digest("hex");
      const changes: ShareViewFileChange[] = [
        { kind: "save", path: "docs/note.md", text: "other account\n", expectedContentHash: hash },
        { kind: "create", path: "docs/new.md", initialText: "new\n" },
        { kind: "move", fromPath: "docs/note.md", toPath: "docs/moved.md" },
        { kind: "delete", path: "docs/note.md" },
      ];
      const unchanged = async (why: string) => {
        expect(await storePaths(view), why).toEqual(["docs/note.md"]);
        const main = await view.store.ensureMainVersion({ workspaceId: view.workspaceId });
        expect(
          (
            await view.store.readTextFile({
              workspaceId: view.workspaceId,
              versionId: main.id,
              path: "docs/note.md",
            })
          )?.text,
          why,
        ).toBe(text);
        expect(replicationLogRows(view.rootPath), why).toBe(journalBefore);
        await expect(readFile(join(view.rootPath, "docs", "note.md"), "utf8"), why).resolves.toBe(
          text,
        );
        expect(await exists(join(view.rootPath, "docs", "new.md")), why).toBe(false);
        expect(await exists(join(view.rootPath, "docs", "moved.md")), why).toBe(false);
        expect(
          [...(await readSharedViewProjectionDebt(view.rootPath, SHARE_ID)).pendingPaths],
          why,
        ).toEqual([]);
      };
      // Settle first, so the projection holds the seeded file and the journal
      // count below starts from it.
      await settleShareViewThroughOwner(view, view.store);
      const journalBefore = replicationLogRows(view.rootPath);

      const owner = shareViewFilesOwner(view, view.store, { account: () => signedIn });
      for (const change of changes) {
        await expect(
          withStaleSensitiveWorkspaceOperation(view.rootPath, (lease) =>
            owner.files.change(lease, owner.requested, change),
          ),
          `a ${change.kind} under another account`,
        ).rejects.toThrow(JOINED_BY_ANOTHER_ACCOUNT);
        await unchanged(`a ${change.kind} under another account`);
      }

      // The joined account starts the change, and another signs in while it
      // reads the store: the change still commits nothing.
      let reads = 0;
      const switching = new Proxy(view.store, {
        get(target, property, receiver) {
          const value = Reflect.get(target, property, receiver) as unknown;
          if (typeof value !== "function") return value;
          return (...args: unknown[]) => {
            if (
              property === "ensureMainVersion" &&
              signedIn === joinedAccount &&
              (reads += 1) === 1
            )
              signedIn = otherAccount;
            return (value as (...inner: unknown[]) => unknown).apply(target, args);
          };
        },
      });
      const switched = shareViewFilesOwner(view, switching, { account: () => signedIn });
      for (const change of changes) {
        signedIn = joinedAccount;
        reads = 0;
        await expect(
          withStaleSensitiveWorkspaceOperation(view.rootPath, (lease) =>
            switched.files.change(lease, switched.requested, change),
          ),
          `a ${change.kind} after another account signed in`,
        ).rejects.toThrow(JOINED_BY_ANOTHER_ACCOUNT);
        expect(reads, "the switch came after the change started").toBe(1);
        await unchanged(`a ${change.kind} after another account signed in`);
      }

      // Back as the account that joined, the same save commits and journals.
      signedIn = joinedAccount;
      await expect(
        withStaleSensitiveWorkspaceOperation(view.rootPath, (lease) =>
          owner.files.change(lease, owner.requested, changes[0]!),
        ),
      ).resolves.toMatchObject({ status: "committed" });
      expect(replicationLogRows(view.rootPath)).toBeGreaterThan(journalBefore);
      await expect(readFile(join(view.rootPath, "docs", "note.md"), "utf8")).resolves.toBe(
        "other account\n",
      );
    },
    60_000,
  );

  it.skipIf(engine.missing)(
    "keeps a joined workspace's save when the same account's credentials reload during it",
    async () => {
      const view = await harness("dohc-share-same-account-reload-", "edit");
      const text = "granter\n";
      await seedSharedFiles(view, [{ path: "docs/note.md", text }]);
      await settleShareViewThroughOwner(view, view.store);
      const journalBefore = replicationLogRows(view.rootPath);
      const joinedAccount: ShareViewAccount = { userId: "recipient-a", relayUrl: JOINED_RELAY_URL };
      // Main's own credential session, wired as main wires it.
      const cache = new CredentialSessionCache<ShareViewAccount>();
      cache.set(joinedAccount);
      const signedInAccount = signedInAccountFrom(cache, async () => undefined);
      // The save reads the file, and the same account's credentials reload
      // before it commits, as a credential refresh does.
      let reloads = 0;
      const reloading = new Proxy(view.store, {
        get(target, property, receiver) {
          const value = Reflect.get(target, property, receiver) as unknown;
          if (typeof value !== "function") return value;
          return (...args: unknown[]) => {
            if (property === "readTextFile" && reloads === 0) {
              reloads += 1;
              void cache.refresh(async () => joinedAccount);
            }
            return (value as (...inner: unknown[]) => unknown).apply(target, args);
          };
        },
      });
      const owner = shareViewFilesOwner(view, reloading, { signedInAccount });
      const hash = createHash("sha256").update(text).digest("hex");
      await expect(
        withStaleSensitiveWorkspaceOperation(view.rootPath, (lease) =>
          owner.files.change(lease, owner.requested, {
            kind: "save",
            path: "docs/note.md",
            text: "after\n",
            expectedContentHash: hash,
          }),
        ),
      ).resolves.toMatchObject({ status: "committed" });
      expect(reloads, "the reload came while the save ran").toBe(1);
      expect(replicationLogRows(view.rootPath)).toBeGreaterThan(journalBefore);
      await expect(readFile(join(view.rootPath, "docs", "note.md"), "utf8")).resolves.toBe(
        "after\n",
      );
    },
    60_000,
  );
});
