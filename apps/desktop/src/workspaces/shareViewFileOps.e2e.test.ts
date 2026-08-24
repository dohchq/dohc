import { createHash } from "node:crypto";
import {
  lstat,
  mkdir,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  EngineDaemonLifecycle,
  EngineWorkspaceSessions,
} from "@dohc/workspace-engine-client/daemon";
import { requireEngineBinaryOrSkip } from "../testing/engineBinary";
import {
  EngineRelayClient,
  RelayConfiguredDaemonClientSource,
  RelayTransportRouteGuard,
} from "./engineRelayClient";
import { readPendingMaterializationPaths } from "./sharedView";
import {
  createCaptureLiveStores,
  type CaptureVersionedTextStore,
} from "./workspaceEngineCaptureLiveStore";
import { createTestScratch } from "./testTemp";
import {
  createShareViewFiles,
  shareViewFilesStore,
  type ResolvedShareViewFilesTarget,
  type ShareViewFileChange,
  type ShareViewFileChangeValue,
} from "./shareViewFiles";
import {
  withStaleSensitiveWorkspaceOperation,
  type WorkspaceTextWriteResult,
} from "./workspaceAssets";
import { createFile, movePath } from "./workspaceFiles";

// The four remaining writes a share view admits (#802), driven the way
// `shareViewTextWrite.e2e.test.ts` drives the text save.
//
// "The recipient can send this change" is not a UI state: it is a moment in
// this replica's engine store and a row in its `replication_log`, because the
// submit lane reads exactly that log. So every case here asserts the journal
// and the projection, never the return value alone.

const engine = requireEngineBinaryOrSkip();
const SHARE_ID = "share-e2e";

const requireModule = createRequire(import.meta.url);

interface Harness {
  workspaceId: string;
  rootPath: string;
  store: CaptureVersionedTextStore;
  sessions: EngineWorkspaceSessions;
}

const lifecycles: EngineDaemonLifecycle[] = [];
const sessionSets: EngineWorkspaceSessions[] = [];
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    sessionSets
      .splice(0)
      .map((sessions) => sessions.closeAll().catch(() => undefined)),
  );
  await Promise.all(
    lifecycles
      .splice(0)
      .map((lifecycle) => lifecycle.stop().catch(() => undefined)),
  );
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

/**
 * A real daemon, a real engine store, and — for a share view — the sync
 * identity its journal needs. `workspace_journals_file_moments_in_tx` journals
 * a file moment only for a workspace that replicates, and for a share view the
 * `share_view_file_lane` row recorded here is what makes that true.
 */
async function harness(
  prefix: string,
  access?: "comment" | "edit",
): Promise<Harness> {
  const rootPath = await createTestScratch(prefix);
  roots.push(rootPath);
  const workspaceId = `${prefix}${process.pid}-${Date.now()}`;
  const lifecycle = new EngineDaemonLifecycle({
    command: engine.require(),
    requestTimeoutMs: 10_000,
  });
  lifecycles.push(lifecycle);
  await lifecycle.start();
  const routes = new RelayTransportRouteGuard();
  const sessions = new EngineWorkspaceSessions(
    new RelayConfiguredDaemonClientSource(lifecycle, routes),
  );
  sessionSets.push(sessions);
  if (access) {
    const client = new EngineRelayClient({
      sessions,
      routes,
      allowInsecureLoopbackForTests: true,
      requestDeadlineMs: 10_000,
    }).bind({
      workspaceId,
      rootPath,
      relay: { baseUrl: "http://127.0.0.1:9", token: "share-view-test-token" },
    });
    await client.recordShareViewIdentity({
      grantedSelector: { paths: ["docs"], versionId: null, access },
    });
  }
  const { store } = createCaptureLiveStores(
    { workspaceId, rootPath },
    sessions,
  );
  return { workspaceId, rootPath, store, sessions };
}

/** The granter's files, as the share's pull leaves them: moments and a projection. */
async function seedSharedFiles(
  harnessed: Harness,
  files: readonly { path: string; text: string }[],
): Promise<void> {
  const main = await harnessed.store.ensureMainVersion({
    workspaceId: harnessed.workspaceId,
  });
  for (const file of files) {
    await harnessed.store.writeTextFile({
      workspaceId: harnessed.workspaceId,
      versionId: main.id,
      path: file.path,
      text: file.text,
      metadata: { origin: "sync" },
    });
    await mkdir(dirname(join(harnessed.rootPath, file.path)), {
      recursive: true,
    });
    await writeFile(join(harnessed.rootPath, file.path), file.text, "utf8");
  }
}

function scope(harnessed: Harness) {
  return {
    workspaceId: harnessed.workspaceId,
    rootPath: harnessed.rootPath,
    shareViewStore: () => harnessed.store,
  };
}

function shareViewFilesOwner(
  harnessed: Pick<Harness, "workspaceId" | "rootPath">,
  store: CaptureVersionedTextStore,
) {
  const requested = {
    kind: "standalone" as const,
    workspaceId: harnessed.workspaceId,
  };
  const resolved: ResolvedShareViewFilesTarget = {
    ...requested,
    storeWorkspaceId: harnessed.workspaceId,
    schedulingRootPath: harnessed.rootPath,
    rootPath: harnessed.rootPath,
    shareId: SHARE_ID,
    granterEmail: "granter@example.com",
    grantedSelector: {
      paths: ["docs"],
      versionId: null,
      access: "edit" as const,
    },
    ended: false,
  };
  return {
    requested,
    files: createShareViewFiles({
      resolveTarget: (candidate) =>
        candidate.kind === requested.kind &&
        candidate.workspaceId === requested.workspaceId
          ? resolved
          : null,
      openStore: () => shareViewFilesStore(store),
      resolveRelay: async () => null,
      pull: async () => {
        throw new Error("Unexpected pull");
      },
      recordRefusals: async () => undefined,
      markEnded: async () => undefined,
      retireTarget: async () => undefined,
      assertProjectionRoot: async () => undefined,
      createMount: async () => undefined,
      removeMount: async () => ({ folderLeft: false }),
    }),
  };
}

async function settleShareViewThroughOwner(
  harnessed: Pick<Harness, "workspaceId" | "rootPath">,
  store: CaptureVersionedTextStore,
) {
  const owner = shareViewFilesOwner(harnessed, store);
  const outcome = await withStaleSensitiveWorkspaceOperation(
    harnessed.rootPath,
    (lease) => owner.files.reconcile(lease, owner.requested, "settle"),
  );
  if (outcome.kind !== "settle") {
    throw new Error("Share-view settlement returned another operation kind.");
  }
  const { kind: _kind, ...captured } = outcome;
  return captured;
}

function storeReplacingLeafAtMutationBoundary(
  store: CaptureVersionedTextStore,
  replace: () => Promise<void>,
): CaptureVersionedTextStore {
  let ensureMainCalls = 0;
  return new Proxy(store, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver) as unknown;
      if (property !== "ensureMainVersion" || typeof value !== "function") {
        return value;
      }
      return async (...args: unknown[]) => {
        ensureMainCalls += 1;
        // capture -> canonical snapshot -> file-change primitive. Replacing
        // on the third admission proves the primitive's own final lstat,
        // rather than the earlier capture guard, preserves recipient data.
        if (ensureMainCalls === 3) await replace();
        return (value as (...inner: unknown[]) => unknown).apply(target, args);
      };
    },
  }) as CaptureVersionedTextStore;
}

async function applyOwnedShareViewChange(
  input: ReturnType<typeof scope>,
  change: ShareViewFileChange,
): Promise<ShareViewFileChangeValue> {
  const owner = shareViewFilesOwner(input, input.shareViewStore());
  const outcome = await withStaleSensitiveWorkspaceOperation(
    input.rootPath,
    (lease) => owner.files.change(lease, owner.requested, change),
  );
  if (outcome.status !== "committed") throw new Error(outcome.message);
  return outcome.value;
}

function applyShareViewTextWrite(
  input: ReturnType<typeof scope> & {
    relativePath: string;
    text: string;
    expectedContentHash: string;
  },
) {
  return applyOwnedShareViewChange(input, {
    kind: "save",
    path: input.relativePath,
    text: input.text,
    expectedContentHash: input.expectedContentHash,
  }) as Promise<WorkspaceTextWriteResult>;
}

function applyShareViewFileCreate(
  input: ReturnType<typeof scope> & {
    relativePath: string;
    initialText: string;
  },
) {
  return applyOwnedShareViewChange(input, {
    kind: "create",
    path: input.relativePath,
    initialText: input.initialText,
  }) as Promise<string>;
}

function applyShareViewPathMove(
  input: ReturnType<typeof scope> & { fromPath: string; toPath: string },
) {
  return applyOwnedShareViewChange(input, {
    kind: "move",
    fromPath: input.fromPath,
    toPath: input.toPath,
  }) as Promise<string>;
}

function applyShareViewPathDelete(
  input: ReturnType<typeof scope> & { relativePath: string },
) {
  return applyOwnedShareViewChange(input, {
    kind: "delete",
    path: input.relativePath,
  }) as Promise<{ trashed: boolean }>;
}

function applyShareViewFileImport(
  input: ReturnType<typeof scope> & {
    absolutePaths: string[];
    screenAgainstRoots: string[] | null;
    targetDir: string | undefined;
  },
) {
  return applyOwnedShareViewChange(input, {
    kind: "import",
    absolutePaths: input.absolutePaths,
    screenAgainstRoots: input.screenAgainstRoots,
    targetDir: input.targetDir,
  }) as Promise<{ imported: string[]; skipped: number }>;
}

/**
 * The same store, with one method made to fail at the Nth call.
 *
 * A mid-apply failure is the case a folder operation cannot test any other
 * way: the engine has to accept some of the files and then refuse one, which
 * no arrangement of inputs produces on demand.
 */
function storeFailingAt(
  store: CaptureVersionedTextStore,
  method: "renameTextFile" | "deleteTextFile",
  ...calls: number[]
): CaptureVersionedTextStore {
  let seen = 0;
  return new Proxy(store, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver) as unknown;
      if (property !== method || typeof value !== "function") return value;
      return (...args: unknown[]) => {
        seen += 1;
        if (calls.includes(seen)) {
          return Promise.reject(
            new Error(`engine refused ${method} call ${seen}`),
          );
        }
        return (value as (...inner: unknown[]) => unknown).apply(target, args);
      };
    },
  }) as CaptureVersionedTextStore;
}

// The move RPC answers when the filesystem changed; the store row settles
// through the capture pipeline afterwards, so an instant read can see BOTH
// case-variants of one entry. Poll for the settled listing — a refused
// rename never reaches it and fails showing the store's actual state.
function waitForStorePaths(
  harnessed: Harness,
  expected: string[],
  message: string,
): Promise<void> {
  return expect
    .poll(() => storePaths(harnessed), {
      timeout: 30_000,
      interval: 25,
      message,
    })
    .toEqual(expected);
}

async function storePaths(harnessed: Harness): Promise<string[]> {
  const main = await harnessed.store.ensureMainVersion({
    workspaceId: harnessed.workspaceId,
  });
  const files = await harnessed.store.listTextFiles({
    workspaceId: harnessed.workspaceId,
    versionId: main.id,
  });
  return files.map((file) => file.path).sort();
}

// `replication_log` is what `push_share_ops` scans, so counting its rows is
// the difference between "the engine has the change" and "the recipient can
// send it".
function replicationLogRows(rootPath: string): number {
  const { DatabaseSync } = requireModule("node:sqlite") as {
    DatabaseSync: new (
      path: string,
      options?: { readOnly?: boolean },
    ) => {
      prepare(sql: string): { get(): Record<string, unknown> | undefined };
      close(): void;
    };
  };
  const database = new DatabaseSync(
    join(rootPath, ".dohc", "engine", "engine.db"),
    {
    readOnly: true,
    },
  );
  try {
    const row = database
      .prepare("SELECT COUNT(*) AS rows FROM replication_log")
      .get();
    return Number(row?.rows ?? 0);
  } finally {
    database.close();
  }
}

// `lstat`, not a read: a DIRECTORY answers a read with EISDIR, so a read-based
// probe reported every existing folder as absent — and a test asserting a
// folder was removed then passed whether or not it was.
async function exists(path: string): Promise<boolean> {
  return lstat(path).then(
    () => true,
    () => false,
  );
}

describe("share-view file operations through the real store", () => {
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
        collisionRecordQuarantined: false,
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
        "MUTATION: a create that only writes the file is a change the submit lane cannot see",
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
        collisionRecordQuarantined: false,
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
        "MUTATION: a create reports success for a path occupied only by the recipient's own file",
      ).rejects.toThrow(/already exists/);
      await expect(
        readFile(join(view.rootPath, "docs", "mine.md"), "utf8"),
        "MUTATION: a create that journals over an occupied path destroys the recipient's own file",
      ).resolves.toBe("mine\n");
      expect(replicationLogRows(view.rootPath)).toBe(journalBefore);
    },
    60_000,
  );

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
        "MUTATION: a rename that only moves the file leaves the store naming the old path",
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
        "MUTATION: removing the mutation's lifecycle lock lets capture observe the renamed store before its projection",
      ).toBe(false);
      expect(captured).toEqual({
        capturedPaths: 0,
        collisionRecordQuarantined: false,
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
        "MUTATION: capture in the rename gap journals a delete on top of the destination",
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
        "MUTATION: renaming only the directory leaves every file under it naming the old path",
      ).toEqual(["docs/roadmap/one.md", "docs/roadmap/two.md"]);
      expect(await readdir(join(view.rootPath, "docs"))).toEqual(["roadmap"]);
      await expect(
        readFile(join(view.rootPath, "docs", "roadmap", "two.md"), "utf8"),
      ).resolves.toBe("two\n");
    },
    60_000,
  );

  // THE PROJECTION IS NOT DOHC'S TO SPEND (sweep of #806, blockers 1-4).
  //
  // A share view's folder holds two kinds of file: the projection of the
  // store, which dohc rewrites freely, and whatever the recipient put there
  // themselves, which is their own data and which no moment describes. Every
  // operation below used to rewrite the folder without asking which kind it
  // was about to destroy. The rule is now the same one create and import
  // already took: refuse, and say what to move first.

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
        "MUTATION: a rename that asks only the store overwrites the recipient's own file",
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
        "MUTATION: an occupied-name check without the case carve-out refuses a rename that only changes case",
      );
      await expect(
        readFile(join(view.rootPath, "docs", "Note.md"), "utf8"),
      ).resolves.toBe("granter\n");
    },
    60_000,
  );

  // CASE IDENTITY IS THE FILESYSTEM'S ANSWER, NEVER A STRING'S (delta pass of
  // #806, findings 1, 2 and 9).
  //
  // On a case-insensitive filesystem `docs/Plans` and `docs/plans` are ONE
  // directory, and `Note.md` and `note.md` are ONE file. Every place this
  // module asked "same entry?" or "name taken?" with a string comparison got
  // the wrong answer there, and two of them answered by destroying data. The
  // three below are the shapes that were measured; they run on every platform
  // and assert what is true on all of them.

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
        "MUTATION: a case-only folder rename changes the store spelling but leaves the old directory spelling on disk",
      ).toEqual(["plans"]);
      // The cleanup that removes an emptied source folder must not run when
      // the source and the destination are the SAME folder: it would remove
      // the files this rename just put there.
      await expect(
        readFile(join(view.rootPath, "docs", "plans", "one.md"), "utf8"),
        "MUTATION: a case-only folder rename deletes everything it just moved",
      ).resolves.toBe("one\n");
      await expect(
        readFile(join(view.rootPath, "docs", "plans", "two.md"), "utf8"),
      ).resolves.toBe("two\n");
    },
    60_000,
  );

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
        "MUTATION: an import that compares names as strings overwrites a file whose name differs only in case",
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
        "MUTATION: exact-case store lookup accepts a second engine path for the same physical name",
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
        "MUTATION: a move screens only the folder it leaves, and merges into one holding files the store never had",
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
        "MUTATION: a folder move merges into an existing canonical folder",
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

      // The EXACT sentence, not a fragment every refusal in this module
      // shares: a scan that returned nothing would raise the "nothing to move"
      // refusal, which also contains that fragment, and this test could not
      // tell the two apart.
      await expect(
        applyShareViewPathMove({
          ...scope(view),
          fromPath: "docs/plans",
          toPath: "docs/roadmap",
        }),
        "MUTATION: moving a folder removes it whole, destroying the files under it the store never held",
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
        "MUTATION: deleting a folder removes it whole, destroying the files under it the store never held",
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
      const lateStore = storeReplacingLeafAtMutationBoundary(
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
          shareViewStore: () => lateStore,
          relativePath: "docs/notes.md",
        }),
        "MUTATION: deleting over a directory that replaced a tracked file recursively removes the directory and everything in it",
      ).rejects.toThrow(
        "dohc did not delete docs/notes.md. docs/notes.md replaces a tracked file with a folder or another entry. Restore the file or move the conflicting entry.",
      );
      expect(replacementRan).toBe(true);

      expect(
        (await lstat(join(view.rootPath, "docs", "notes.md"))).isDirectory(),
        "MUTATION: the recipient-owned directory must survive a refused delete",
      ).toBe(true);
      await expect(
        readFile(join(view.rootPath, "docs", "notes.md", "inside.txt"), "utf8"),
      ).resolves.toBe("recipient file\n");
      expect(await storePaths(view)).toEqual(["docs/notes.md"]);
      await expect(
        readPendingMaterializationPaths(view.rootPath),
        "MUTATION: a refused delete that still marked the path pending leaves recovery believing a materialization is owed",
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
      const lateStore = storeReplacingLeafAtMutationBoundary(
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
          shareViewStore: () => lateStore,
          fromPath: "docs/notes.md",
          toPath: "docs/renamed.md",
        }),
        "MUTATION: renaming over a directory that replaced a tracked file recursively removes the directory and everything in it",
      ).rejects.toThrow(
        "dohc did not rename docs/notes.md. docs/notes.md replaces a tracked file with a folder or another entry. Restore the file or move the conflicting entry.",
      );
      expect(replacementRan).toBe(true);

      expect(
        (await lstat(join(view.rootPath, "docs", "notes.md"))).isDirectory(),
        "MUTATION: the recipient-owned directory must survive a refused rename",
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
        "MUTATION: a refused rename that still marked the path pending leaves recovery believing a materialization is owed",
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
        "MUTATION: deleting over a symlink that replaced a tracked file follows it and destroys what it points at",
      ).rejects.toThrow(
        "dohc did not send your changes. docs/notes.md replaces a tracked file with a folder or another entry. Restore the file or move the conflicting entry. Fix this file, then send your changes again.",
      );

      expect(
        (await lstat(join(view.rootPath, "docs", "notes.md"))).isSymbolicLink(),
        "MUTATION: the symlink must survive a refused delete",
      ).toBe(true);
      await expect(readFile(outside, "utf8")).resolves.toBe("recipient file\n");
      expect(await storePaths(view)).toEqual(["docs/notes.md"]);
      await expect(
        readPendingMaterializationPaths(view.rootPath),
      ).resolves.toEqual(new Set());
    },
    60_000,
  );

  // #861's escape: the earlier pins replace a tracked LEAF with something
  // else, which the per-leaf lstat catches directly. A tracked FOLDER has no
  // leaf of its own — only the files under it are tracked — so a symlink
  // standing in for the FOLDER itself needs its own check. Without it, a
  // RENAME materializes each leaf as its own delete, and each one resolves
  // through the link (an ancestor symlink, not the final component held
  // back) — landing `rm` on files at the link's target and destroying the
  // RECIPIENT's own content there, not the ones the store lost. (A delete
  // over the same setup only unlinks the junction itself — `rm` never
  // recurses through a symlink at its own target — so rename is where this
  // actually destroys data; the fix still refuses both, from the same
  // folder-level check.)
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
        "MUTATION: renaming a folder a symlink replaced follows the link per leaf and destroys the recipient's files at its target",
      ).rejects.toThrow(
        "dohc did not rename docs/plans. docs/plans replaces this shared folder with a link or another entry. Restore the folder or move the conflicting entry.",
      );

      expect(
        (await lstat(join(view.rootPath, "docs", "plans"))).isSymbolicLink(),
        "MUTATION: the symlink standing in for the folder must survive a refused rename",
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
        "MUTATION: a refusal that lists every file is unreadable at the size a real folder reaches",
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
        "MUTATION: a binary file the store lists as text is dropped from a folder scan entirely",
      ).toEqual(["docs/renamed.png"]);
      await expect(
        readFile(join(view.rootPath, "docs", "renamed.png")),
        "MUTATION: materializing a renamed binary through readTextFile lands an empty or corrupt file",
      ).resolves.toEqual(bytes);
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
        "MUTATION: a failure part way through leaves half a folder renamed, and every one of those halves is proposable",
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
      // 5-7 are the put-backs in reverse. Failing call 6 strands the MIDDLE
      // put-back: the two around it must still run.
      await expect(
        applyShareViewPathMove({
          ...scope(view),
          fromPath: "docs/plans",
          toPath: "docs/roadmap",
          shareViewStore: () =>
            storeFailingAt(view.store, "renameTextFile", 4, 6),
        }),
        "MUTATION: a put-back that abandons the list at the first failure strands every file after it too",
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
      // THIRD call is the one that fails, and its file stays on both sides
      // while the two before it are gone from both.
      expect(await storePaths(view)).toEqual(["docs/plans/two.md"]);
      expect(
        await exists(join(view.rootPath, "docs", "plans", "one.md")),
        "MUTATION: a delete that fails part way leaves the projection holding files the store no longer has",
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

      const outcome = await applyShareViewFileImport({
        ...scope(view),
        absolutePaths: [file, directory],
        screenAgainstRoots: [view.rootPath],
        targetDir: "docs",
      });

      expect(
        outcome,
        "MUTATION: an unscreened drag-in writes a directory into the share view's store",
      ).toEqual({
        imported: ["docs/dropped.md"],
        skipped: 1,
      });
      expect(await storePaths(view)).toEqual([
        "docs/dropped.md",
        "docs/note.md",
      ]);
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
        "MUTATION: a delete that only removes the file leaves the store still holding it",
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
        "MUTATION: deleting a path the store never had removes a file the granter can never be told about",
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
        "MUTATION: deleting only the directory leaves every file under it in the store",
      ).toEqual(["docs/keep.md"]);
      expect(await readdir(join(view.rootPath, "docs"))).toEqual(["keep.md"]);
    },
    60_000,
  );

  it.skipIf(engine.missing)(
    "imports text and binary sources as moments, renames a collision, and refuses what the engine cannot own",
    async () => {
      const view = await harness("dohc-share-import-", "edit");
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
        "MUTATION: an import that only asks the store overwrites the recipient's own file",
      ).resolves.toBe("mine\n");
      expect(
        outcome.skipped,
        "MUTATION: a source the engine cannot own is counted as imported",
      ).toBe(1);
      expect(await storePaths(view)).toEqual([
        "docs/added.md",
        "docs/mine (2).md",
        "docs/note (2).md",
        "docs/note.md",
        "docs/picture.png",
      ]);
      expect(
        replicationLogRows(view.rootPath),
        "MUTATION: an import that only copies files is a change the submit lane cannot see",
      ).toBeGreaterThan(journalBefore);
      await expect(
        readFile(join(view.rootPath, "docs", "note (2).md"), "utf8"),
      ).resolves.toBe("collides\n");
      await expect(
        readFile(join(view.rootPath, "docs", "note.md"), "utf8"),
        "MUTATION: an import that overwrites replaces the granter's file with the recipient's",
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
        collisionRecordQuarantined: false,
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
        "MUTATION: disk probing refuses a visible canonical folder whose projection was deleted out of app",
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
        "MUTATION: an ordinary workspace writing engine-direct journals every change twice — once here, once from the watcher",
      ).toEqual(before);
    },
    60_000,
  );
});
