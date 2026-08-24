import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { SharedFileReadOnlyError } from "@dohc/workspace-contracts/relay";
import {
  createShareViewFiles,
  type ResolvedShareViewFilesTarget,
  type ShareViewFilesDependencies,
  type ShareViewFilesStore,
  type ShareViewFilesTarget,
} from "./shareViewFiles";
import {
  captureSharedViewLocalDivergence,
  withShareViewRefreshLifecycleLock,
  writePendingMaterializationPaths,
} from "./sharedView";
import { SharePinInvalidError } from "./shareViewRecords";
import {
  type WorkspaceOperationLease,
  withExclusiveWorkspaceOperation,
  withStaleSensitiveWorkspaceOperation,
} from "./workspaceAssets";
import { WORKSPACE_TEXT_EDITOR_MAX_BYTES } from "./workspaceTextLimits";
import { createTestScratch } from "./testTemp";

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function workspaceRoot(): Promise<string> {
  const root = join(await createTestScratch("share-view-files-"), "workspace");
  await mkdir(root, { recursive: true });
  return root;
}

function target(
  rootPath: string,
  access: "view" | "comment" | "edit" = "edit",
): ResolvedShareViewFilesTarget {
  return {
    kind: "standalone",
    workspaceId: "workspace-a",
    storeWorkspaceId: "workspace-a",
    schedulingRootPath: rootPath,
    rootPath,
    shareId: "share-a",
    granterEmail: "granter@example.com",
    grantedSelector: { paths: [], versionId: "main", access },
    ended: false,
  };
}

function mountTarget(rootPath: string): ResolvedShareViewFilesTarget {
  return {
    ...target(rootPath, "view"),
    kind: "mount",
    workspaceId: "host-a",
    storeWorkspaceId: "host-a:share-a",
    schedulingRootPath: rootPath,
    mountLabel: "granter",
  };
}

function readStore(input: {
  text: string;
  paths?: Array<{ path: string; text: string }>;
}): ShareViewFilesStore {
  const rows = input.paths ?? [{ path: "notes/a.md", text: input.text }];
  return {
    ensureMainVersion: vi.fn(async () => ({ id: "main" })),
    readTextFile: vi.fn(async ({ path }: { path: string }) => {
      const row = rows.find((entry) => entry.path === path);
      if (!row) return null;
      const bytes = Buffer.from(row.text, "utf8");
      return {
        path,
        contentKind: "text",
        text: row.text,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      };
    }),
    readBinaryFile: vi.fn(async () => null),
    listTextFileMetadata: vi.fn(async () =>
      rows.map((row, index) => ({
        path: row.path,
        objectId: `object-${index}`,
        contentKind: "text" as const,
        byteLength: Buffer.byteLength(row.text),
        sha256: createHash("sha256").update(row.text).digest("hex"),
        updatedAtMs: 1,
        latestMomentId: `moment-${index}`,
        hasYdocMarker: false,
      })),
    ),
  } as unknown as ShareViewFilesStore;
}

function mutableTextStore(input?: {
  initial?: Array<{ path: string; text: string }>;
  afterWrite?: (path: string) => void;
  beforeDelete?: (path: string) => void;
  afterRename?: (fromPath: string, toPath: string) => void;
}): ShareViewFilesStore {
  const rows = new Map<
    string,
    {
      text: string;
      objectId: string;
      latestMomentId: string;
    }
  >();
  let nextId = 1;
  for (const initial of input?.initial ?? []) {
    const id = nextId++;
    rows.set(initial.path, {
      text: initial.text,
      objectId: `object-${id}`,
      latestMomentId: `moment-${id}`,
    });
  }
  const snapshots = () =>
    [...rows.entries()].map(([path, row]) => ({
      objectId: row.objectId,
      versionId: "main",
      path,
      contentKind: "text" as const,
      sha256: createHash("sha256").update(row.text).digest("hex"),
      byteLength: Buffer.byteLength(row.text),
      text: row.text,
      updatedAtMs: nextId,
      latestMomentId: row.latestMomentId,
      metadata: { origin: "local-file" as const },
    }));
  return {
    ensureMainVersion: vi.fn(async () => ({ id: "main" })),
    listTextFiles: vi.fn(async () => snapshots()),
    listTextFileMetadata: vi.fn(async () =>
      snapshots().map(({ text: _text, metadata: _metadata, ...row }) => row),
    ),
    getMoment: vi.fn(async () => ({ payload: { before: null } })),
    readTextFile: vi.fn(async ({ path }: { path: string }) => {
      return snapshots().find((row) => row.path === path) ?? null;
    }),
    readBinaryFile: vi.fn(async () => null),
    writeTextFile: vi.fn(
      async ({ path, text }: { path: string; text: string }) => {
        const existing = rows.get(path);
        const id = nextId++;
        rows.set(path, {
          text,
          objectId: existing?.objectId ?? `object-${id}`,
          latestMomentId: `moment-${id}`,
        });
        input?.afterWrite?.(path);
        return {};
      },
    ),
    deleteTextFile: vi.fn(async ({ path }: { path: string }) => {
      input?.beforeDelete?.(path);
      rows.delete(path);
      return {};
    }),
    renameTextFile: vi.fn(
      async ({ fromPath, toPath }: { fromPath: string; toPath: string }) => {
        const row = rows.get(fromPath);
        if (!row) throw new Error(`Missing source: ${fromPath}`);
        rows.delete(fromPath);
        rows.set(toPath, {
          ...row,
          latestMomentId: `moment-${nextId++}`,
        });
        input?.afterRename?.(fromPath, toPath);
        return {};
      },
    ),
  } as unknown as ShareViewFilesStore;
}

const unusedReconcilePorts: Pick<
  ShareViewFilesDependencies,
  | "resolveRelay"
  | "pull"
  | "recordRefusals"
  | "markEnded"
  | "retireTarget"
  | "assertProjectionRoot"
  | "removeMount"
> = {
  resolveRelay: async () => null,
  pull: async () => {
    throw new Error("Unexpected pull");
  },
  recordRefusals: async () => undefined,
  markEnded: async () => undefined,
  retireTarget: async () => undefined,
  assertProjectionRoot: async () => undefined,
  removeMount: async () => ({ folderLeft: false }),
};

describe("ShareViewFiles", () => {
  it("rereads authority after waiting for the share lifecycle", async () => {
    const rootPath = await workspaceRoot();
    let current = target(rootPath, "edit");
    const admitted = deferred();
    let resolves = 0;
    const openStore = vi.fn(() => readStore({ text: "unused" }));
    const files = createShareViewFiles({
      ...unusedReconcilePorts,
      resolveTarget: () => {
        resolves += 1;
        if (resolves === 1) admitted.resolve();
        return current;
      },
      openStore,
    });

    const releaseLifecycle = deferred();
    const lifecycleHeld = deferred();
    const blocker = withShareViewRefreshLifecycleLock(rootPath, async () => {
      lifecycleHeld.resolve();
      await releaseLifecycle.promise;
    });
    await lifecycleHeld.promise;

    const changing = withStaleSensitiveWorkspaceOperation(
      rootPath,
      async (lease) =>
        files.change(
          lease,
          { kind: "standalone", workspaceId: "workspace-a" },
          { kind: "create", path: "notes/new.md", initialText: "" },
        ),
    );
    await admitted.promise;
    current = target(rootPath, "view");
    releaseLifecycle.resolve();

    await expect(changing).rejects.toBeInstanceOf(SharedFileReadOnlyError);
    await blocker;
    expect(resolves).toBe(2);
    expect(openStore).not.toHaveBeenCalled();
  });

  it("does not reconcile a share removed while waiting for its lifecycle", async () => {
    const rootPath = await workspaceRoot();
    let current: ResolvedShareViewFilesTarget | null = target(rootPath);
    const admitted = deferred();
    let resolves = 0;
    const openStore = vi.fn(() => readStore({ text: "unused" }));
    const files = createShareViewFiles({
      ...unusedReconcilePorts,
      resolveTarget: () => {
        resolves += 1;
        if (resolves === 1) admitted.resolve();
        return current;
      },
      openStore,
    });

    const releaseLifecycle = deferred();
    const lifecycleHeld = deferred();
    const blocker = withShareViewRefreshLifecycleLock(rootPath, async () => {
      lifecycleHeld.resolve();
      await releaseLifecycle.promise;
    });
    await lifecycleHeld.promise;

    const reconciling = withStaleSensitiveWorkspaceOperation(
      rootPath,
      (lease) =>
        files.reconcile(
          lease,
          { kind: "standalone", workspaceId: "workspace-a" },
          "repair",
        ),
    );
    await admitted.promise;
    current = null;
    releaseLifecycle.resolve();

    await expect(reconciling).rejects.toMatchObject({
      name: "ShareViewFilesTargetMissingError",
    });
    await blocker;
    expect(resolves).toBe(2);
    expect(openStore).not.toHaveBeenCalled();
  });

  it("rejects an expired lease before resolving any mutation target", async () => {
    const rootPath = await workspaceRoot();
    const mountRoot = join(rootPath, "mount");
    await mkdir(mountRoot, { recursive: true });
    let expiredLease!: WorkspaceOperationLease;
    await withStaleSensitiveWorkspaceOperation(rootPath, async (lease) => {
      expiredLease = lease;
    });
    const exclusiveStarted = deferred();
    const releaseExclusive = deferred();
    const exclusive = withExclusiveWorkspaceOperation(rootPath, async () => {
      exclusiveStarted.resolve();
      await releaseExclusive.promise;
    });
    await exclusiveStarted.promise;

    const mounted = {
      ...mountTarget(mountRoot),
      schedulingRootPath: rootPath,
    };
    const resolveTarget = vi.fn((requested: ShareViewFilesTarget) =>
      requested.kind === "mount" ? mounted : target(rootPath),
    );
    const store = mutableTextStore();
    const removeMount = vi.fn(async () => ({ folderLeft: false }));
    const files = createShareViewFiles({
      ...unusedReconcilePorts,
      resolveTarget,
      openStore: () => store,
      removeMount,
    });
    const standalone = {
      kind: "standalone" as const,
      workspaceId: "workspace-a",
    };
    const mount = {
      kind: "mount" as const,
      workspaceId: "host-a",
      shareId: "share-a",
    };

    try {
      const outcomes = await Promise.all(
        [
          files.change(expiredLease, standalone, {
            kind: "create",
            path: "notes/new.md",
            initialText: "new\n",
          }),
          files.change(expiredLease, standalone, {
            kind: "move",
            fromPath: "notes/same.md",
            toPath: "notes/same.md",
          }),
          files.change(expiredLease, standalone, {
            kind: "import",
            absolutePaths: [],
            screenAgainstRoots: null,
            targetDir: undefined,
          }),
          files.reconcile(expiredLease, mount, "repair"),
          files.unmount(expiredLease, mount),
        ].map(async (attempt) => {
          try {
            await attempt;
            return "resolved";
          } catch (error) {
            return error instanceof Error ? error.message : String(error);
          }
        }),
      );

      expect(outcomes).toEqual(
        Array(5).fill(
          "Workspace operation lease is inactive or belongs to another root.",
        ),
      );
      expect(resolveTarget).not.toHaveBeenCalled();
      expect(removeMount).not.toHaveBeenCalled();
    } finally {
      releaseExclusive.resolve();
      await exclusive;
    }
  });

  it("reuses its workspace lease when capture orders a path", async () => {
    const rootPath = await workspaceRoot();
    const path = "notes/a.md";
    const canonical = "canonical before\n";
    await mkdir(join(rootPath, "notes"), { recursive: true });
    await writeFile(join(rootPath, path), canonical, "utf8");
    const baseStore = mutableTextStore({
      initial: [{ path, text: canonical }],
    });
    const metadataRead = deferred();
    const releaseMetadata = deferred();
    const pathOrdered = deferred();
    let metadataReads = 0;
    const store: ShareViewFilesStore = {
      ...baseStore,
      listTextFileMetadata: vi.fn(async (input) => {
        const rows = await baseStore.listTextFileMetadata!(input);
        metadataReads += 1;
        if (metadataReads === 1) {
          metadataRead.resolve();
          await releaseMetadata.promise;
        }
        return rows;
      }),
      readTextFile: vi.fn(async (input) => {
        pathOrdered.resolve();
        return baseStore.readTextFile(input);
      }),
    };
    const files = createShareViewFiles({
      ...unusedReconcilePorts,
      resolveTarget: () => target(rootPath),
      openStore: () => store,
    });
    const order: string[] = [];

    const changing = withStaleSensitiveWorkspaceOperation(
      rootPath,
      (lease) =>
        files.change(
          lease,
          { kind: "standalone", workspaceId: "workspace-a" },
          {
            kind: "save",
            path,
            text: "recipient edit\n",
            expectedContentHash: createHash("sha256")
              .update(canonical)
              .digest("hex"),
          },
        ),
    ).then((outcome) => {
      order.push("change");
      return outcome;
    });
    await metadataRead.promise;
    const exclusive = withExclusiveWorkspaceOperation(rootPath, async () => {
      order.push("exclusive");
    });
    releaseMetadata.resolve();

    // Capture must order the target through the workspace lease already held
    // by ShareViewFiles. Reacquiring the root scheduler here queues this read
    // behind `exclusive`, while `exclusive` waits for `changing`: a deadlock.
    await pathOrdered.promise;
    await expect(changing).resolves.toMatchObject({
      status: "committed",
      kind: "save",
    });
    await exclusive;
    expect(order).toEqual(["change", "exclusive"]);
  }, 2_000);

  it("keeps reconcile behind a save's projection gap", async () => {
    const rootPath = await workspaceRoot();
    const path = "notes/a.md";
    const canonical = "canonical before\n";
    await mkdir(join(rootPath, "notes"), { recursive: true });
    await writeFile(join(rootPath, path), canonical, "utf8");
    const baseStore = mutableTextStore({
      initial: [{ path, text: canonical }],
    });
    const saveStored = deferred();
    const releaseSave = deferred();
    const reconcileWaiting = deferred();
    const store: ShareViewFilesStore = {
      ...baseStore,
      writeTextFile: vi.fn(async (input) => {
        const outcome = await baseStore.writeTextFile(input);
        saveStored.resolve();
        await releaseSave.promise;
        return outcome;
      }),
    };
    let resolves = 0;
    const files = createShareViewFiles({
      ...unusedReconcilePorts,
      resolveTarget: () => {
        resolves += 1;
        if (resolves === 3) reconcileWaiting.resolve();
        return target(rootPath);
      },
      openStore: () => store,
    });
    const pending: Promise<unknown>[] = [];

    try {
      const changing = withStaleSensitiveWorkspaceOperation(
        rootPath,
        (lease) =>
          files.change(
            lease,
            { kind: "standalone", workspaceId: "workspace-a" },
            {
              kind: "save",
              path,
              text: "saved in app\n",
              expectedContentHash: createHash("sha256")
                .update(canonical)
                .digest("hex"),
            },
          ),
      );
      pending.push(changing);
      await saveStored.promise;
      await rm(join(rootPath, path));

      const reconciling = withStaleSensitiveWorkspaceOperation(
        rootPath,
        (lease) =>
          files.reconcile(
            lease,
            { kind: "standalone", workspaceId: "workspace-a" },
            "settle",
          ),
      );
      pending.push(reconciling);
      await reconcileWaiting.promise;

      expect(store.listTextFileMetadata).toHaveBeenCalledTimes(1);
      expect(store.deleteTextFile).not.toHaveBeenCalled();
      releaseSave.resolve();

      await expect(changing).resolves.toMatchObject({
        status: "committed",
        kind: "save",
      });
      await expect(reconciling).resolves.toMatchObject({
        kind: "settle",
        capturedPaths: 0,
        repairedPaths: 0,
      });
      expect(await readFile(join(rootPath, path), "utf8")).toBe("saved in app\n");
      expect(store.deleteTextFile).not.toHaveBeenCalled();
    } finally {
      releaseSave.resolve();
      await Promise.allSettled(pending);
    }
  });

  it("reuses an exclusive workspace lease while capturing a delete", async () => {
    const rootPath = await workspaceRoot();
    const path = "notes/a.md";
    await mkdir(join(rootPath, "notes"), { recursive: true });
    await writeFile(join(rootPath, path), "canonical\n", "utf8");
    const store = mutableTextStore({
      initial: [{ path, text: "canonical\n" }],
    });
    const files = createShareViewFiles({
      ...unusedReconcilePorts,
      resolveTarget: () => target(rootPath),
      openStore: () => store,
    });

    const outcome = await withExclusiveWorkspaceOperation(
      rootPath,
      (_markChanged, lease) =>
        files.change(
          lease,
          { kind: "standalone", workspaceId: "workspace-a" },
          { kind: "delete", path },
        ),
    );

    expect(outcome).toMatchObject({ status: "committed", kind: "delete" });
    await expect(readFile(join(rootPath, path), "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  }, 2_000);

  it("repairs tracked files without replacing recipient-owned directories", async () => {
    const rootPath = await workspaceRoot();
    const trackedPath = join(rootPath, "docs", "note.md");
    await mkdir(trackedPath, { recursive: true });
    await writeFile(join(trackedPath, "mine.md"), "recipient\n", "utf8");
    const store = mutableTextStore({
      initial: [{ path: "docs/note.md", text: "canonical\n" }],
    });
    const files = createShareViewFiles({
      ...unusedReconcilePorts,
      resolveTarget: () => target(rootPath, "view"),
      openStore: () => store,
    });

    const outcome = await withStaleSensitiveWorkspaceOperation(
      rootPath,
      (lease) =>
        files.reconcile(
          lease,
          { kind: "standalone", workspaceId: "workspace-a" },
          "repair",
        ),
    );

    expect(outcome).toMatchObject({
      kind: "repair",
      repairedPaths: 0,
      collisionRecordQuarantined: false,
      unjournalablePaths: [
        { path: "docs/note.md", reason: "non-file-replacement" },
      ],
    });
    await expect(
      readFile(join(trackedPath, "mine.md"), "utf8"),
    ).resolves.toBe("recipient\n");
  });

  it("repairs an ended view locally without resolving a relay", async () => {
    const rootPath = await workspaceRoot();
    await mkdir(join(rootPath, "docs"), { recursive: true });
    await writeFile(join(rootPath, "docs", "note.md"), "changed\n", "utf8");
    const store = mutableTextStore({
      initial: [{ path: "docs/note.md", text: "canonical\n" }],
    });
    const resolveRelay = vi.fn(async () => {
      throw new Error("relay resolution must not run for an ended view");
    });
    const files = createShareViewFiles({
      ...unusedReconcilePorts,
      resolveTarget: () => ({ ...target(rootPath, "edit"), ended: true }),
      openStore: () => store,
      resolveRelay,
    });

    const outcome = await withStaleSensitiveWorkspaceOperation(
      rootPath,
      (lease) =>
        files.reconcile(
          lease,
          { kind: "standalone", workspaceId: "workspace-a" },
          "refresh",
        ),
    );

    expect(outcome).toMatchObject({
      kind: "refresh",
      outcome: {
        ok: true,
        status: "ended",
        changedPaths: 1,
        collisionRecordQuarantined: false,
        unjournalablePaths: [],
      },
    });
    expect(resolveRelay).not.toHaveBeenCalled();
    await expect(readFile(join(rootPath, "docs", "note.md"), "utf8")).resolves.toBe(
      "canonical\n",
    );
  });

  it("repairs an ended mount locally without resolving or pulling a relay", async () => {
    const rootPath = await workspaceRoot();
    await mkdir(join(rootPath, "docs"), { recursive: true });
    await writeFile(join(rootPath, "docs", "note.md"), "changed\n", "utf8");
    const store = mutableTextStore({
      initial: [{ path: "docs/note.md", text: "canonical\n" }],
    });
    const resolveRelay = vi.fn(async () => {
      throw new Error("relay resolution must not run for an ended mount");
    });
    const pull = vi.fn(async () => {
      throw new Error("relay pull must not run for an ended mount");
    });
    const files = createShareViewFiles({
      ...unusedReconcilePorts,
      resolveTarget: () => ({ ...mountTarget(rootPath), ended: true }),
      openStore: () => store,
      resolveRelay,
      pull,
    });

    const outcome = await withStaleSensitiveWorkspaceOperation(
      rootPath,
      (lease) =>
        files.reconcile(
          lease,
          { kind: "mount", workspaceId: "host-a", shareId: "share-a" },
          "refresh",
        ),
    );

    expect(outcome).toMatchObject({
      kind: "refresh",
      outcome: {
        status: "ended",
        changedPaths: 1,
        collisionRecordQuarantined: false,
        unjournalablePaths: [],
      },
    });
    expect(resolveRelay).not.toHaveBeenCalled();
    expect(pull).not.toHaveBeenCalled();
    await expect(
      readFile(join(rootPath, "docs", "note.md"), "utf8"),
    ).resolves.toBe("canonical\n");
  });

  it("keeps mounted recipient data after quarantining a malformed collision record", async () => {
    const rootPath = await workspaceRoot();
    const path = "docs/collision.md";
    await mkdir(join(rootPath, "docs"), { recursive: true });
    await writeFile(join(rootPath, path), "recipient data\n", "utf8");
    await mkdir(join(rootPath, ".dohc"), { recursive: true });
    await writeFile(
      join(rootPath, ".dohc", "share-collision-record.json"),
      "not json",
      "utf8",
    );
    const store = mutableTextStore({
      initial: [{ path, text: "granter old\n" }],
    });
    const files = createShareViewFiles({
      ...unusedReconcilePorts,
      resolveTarget: () => mountTarget(rootPath),
      openStore: () => store,
      resolveRelay: async () => ({
        baseUrl: "https://relay.example",
        token: "test-token",
      }),
      pull: async () => {
        await store.writeTextFile({
          workspaceId: "host-a:share-a",
          versionId: "main",
          path,
          text: "granter new\n",
          metadata: { origin: "sync" },
        });
        return {
          fetched: 1,
          applied: 1,
          skipped: 0,
          refusals: [],
          refusalCount: 0,
          changedPaths: [
            { path, operation: "write" as const, contentKind: "text" as const },
          ],
          nextCursor: 1,
          commitCursor: async () => undefined,
        };
      },
    });
    const errorLog = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);

    try {
      const result = await withStaleSensitiveWorkspaceOperation(
        rootPath,
        (lease) =>
          files.reconcile(
            lease,
            { kind: "mount", workspaceId: "host-a", shareId: "share-a" },
            "refresh",
          ),
      );
      await expect(readFile(join(rootPath, path), "utf8")).resolves.toBe(
        "recipient data\n",
      );
      await expect(
        files.projectionStatus({
          kind: "mount",
          workspaceId: "host-a",
          shareId: "share-a",
        }),
      ).resolves.toEqual({
        state: "pending",
        pendingPathCount: 1,
        pendingPaths: [path],
        collisionPathCount: 0,
        collisionPaths: [],
        pullInFlight: false,
      });
      expect(result).toMatchObject({
        kind: "refresh",
        outcome: {
          status: "updated",
          changedPaths: 1,
          excludedPaths: [path],
          collisionRecordQuarantined: true,
        },
      });

      await withStaleSensitiveWorkspaceOperation(rootPath, (lease) =>
        files.reconcile(
          lease,
          { kind: "mount", workspaceId: "host-a", shareId: "share-a" },
          "repair",
        ),
      );
      await expect(readFile(join(rootPath, path), "utf8")).resolves.toBe(
        "granter new\n",
      );
      await expect(
        files.projectionStatus({
          kind: "mount",
          workspaceId: "host-a",
          shareId: "share-a",
        }),
      ).resolves.toEqual({ state: "current" });
    } finally {
      errorLog.mockRestore();
    }
  });

  it("propagates a mounted refresh failure", async () => {
    const rootPath = await workspaceRoot();
    const relayFailure = new Error("relay pull failed");
    const files = createShareViewFiles({
      ...unusedReconcilePorts,
      resolveTarget: () => mountTarget(rootPath),
      openStore: () => mutableTextStore(),
      resolveRelay: async () => ({
        baseUrl: "https://relay.example",
        token: "test-token",
      }),
      pull: async () => {
        throw relayFailure;
      },
    });

    await expect(
      withStaleSensitiveWorkspaceOperation(rootPath, (lease) =>
        files.reconcile(
          lease,
          { kind: "mount", workspaceId: "host-a", shareId: "share-a" },
          "refresh",
        ),
      ),
    ).rejects.toBe(relayFailure);
  });

  it("does not unmount a share removed while waiting for its lifecycle", async () => {
    const rootPath = await workspaceRoot();
    let current: ResolvedShareViewFilesTarget | null = mountTarget(rootPath);
    const admitted = deferred();
    let resolves = 0;
    const removeMount = vi.fn(async () => ({ folderLeft: false }));
    const files = createShareViewFiles({
      ...unusedReconcilePorts,
      removeMount,
      resolveTarget: () => {
        resolves += 1;
        if (resolves === 1) admitted.resolve();
        return current;
      },
      openStore: () => readStore({ text: "unused" }),
    });

    const releaseLifecycle = deferred();
    const lifecycleHeld = deferred();
    const blocker = withShareViewRefreshLifecycleLock(rootPath, async () => {
      lifecycleHeld.resolve();
      await releaseLifecycle.promise;
    });
    await lifecycleHeld.promise;

    const unmounting = withStaleSensitiveWorkspaceOperation(rootPath, (lease) =>
      files.unmount(lease, {
        kind: "mount",
        workspaceId: "host-a",
        shareId: "share-a",
      }),
    );
    await admitted.promise;
    current = null;
    releaseLifecycle.resolve();

    await expect(unmounting).rejects.toMatchObject({
      name: "ShareViewFilesTargetMissingError",
    });
    await blocker;
    expect(resolves).toBe(2);
    expect(removeMount).not.toHaveBeenCalled();
  });

  it("reads and lists the canonical store while the projected folder is stale", async () => {
    const rootPath = await workspaceRoot();
    await mkdir(join(rootPath, "notes"), { recursive: true });
    await writeFile(join(rootPath, "notes", "a.md"), "stale disk\n", "utf8");
    const store = readStore({
      text: "canonical store\n",
      paths: [
        {
          path: "notes/a.md",
          text: "---\nicon: telescope\n---\ncanonical store\n",
        },
        { path: "docs/nested/b.md", text: "second\n" },
      ],
    });
    const files = createShareViewFiles({
      ...unusedReconcilePorts,
      resolveTarget: () => target(rootPath),
      openStore: () => store,
    });

    await expect(
      files.read(
        { kind: "standalone", workspaceId: "workspace-a" },
        { kind: "text", path: "notes/a.md" },
      ),
    ).resolves.toMatchObject({
      kind: "text",
      text: "---\nicon: telescope\n---\ncanonical store\n",
      truncated: false,
    });
    await expect(
      files.list({ kind: "standalone", workspaceId: "workspace-a" }),
    ).resolves.toEqual({
      files: [
        { path: "docs/nested/b.md", kind: "file" },
        { path: "notes/a.md", kind: "file", icon: "telescope" },
      ],
      folders: ["docs", "docs/nested", "notes"],
    });
    expect(store.readTextFile).toHaveBeenCalledTimes(3);
    await files.list({ kind: "standalone", workspaceId: "workspace-a" });
    expect(store.readTextFile).toHaveBeenCalledTimes(3);
  });

  it("omits a partial trailing UTF-8 character from a truncated canonical read", async () => {
    const rootPath = await workspaceRoot();
    const prefix = "x".repeat(WORKSPACE_TEXT_EDITOR_MAX_BYTES - 1);
    const files = createShareViewFiles({
      ...unusedReconcilePorts,
      resolveTarget: () => target(rootPath),
      openStore: () => readStore({ text: `${prefix}😀tail` }),
    });

    const read = await files.read(
      { kind: "standalone", workspaceId: "workspace-a" },
      { kind: "text", path: "notes/a.md" },
    );

    expect(read).toMatchObject({
      kind: "text",
      truncated: true,
      contentHash: null,
    });
    if (read.kind !== "text") throw new Error("expected a text read");
    expect(read.text).toHaveLength(prefix.length);
    expect(read.text.at(-1)).toBe("x");
    expect(read.text).not.toContain("\uFFFD");
  });

  it("keeps canonical reads and listings on the shared-file security floor", async () => {
    const rootPath = await workspaceRoot();
    const store = readStore({
      text: "unused",
      paths: [
        { path: "notes/a.md", text: "shared\n" },
        { path: ".env", text: "SECRET=not-shared\n" },
      ],
    });
    const files = createShareViewFiles({
      ...unusedReconcilePorts,
      resolveTarget: () => target(rootPath),
      openStore: () => store,
    });

    await expect(
      files.read(
        { kind: "standalone", workspaceId: "workspace-a" },
        { kind: "text", path: ".env" },
      ),
    ).rejects.toBeInstanceOf(SharedFileReadOnlyError);
    await expect(
      files.list({ kind: "standalone", workspaceId: "workspace-a" }),
    ).resolves.toEqual({
      files: [{ path: "notes/a.md", kind: "file" }],
      folders: ["notes"],
    });
  });

  it("keeps a damaged standalone marker readable while refusing active work", async () => {
    const rootPath = await workspaceRoot();
    const store = readStore({ text: "canonical local copy\n" });
    const damaged = { ...target(rootPath), shareId: null };
    const files = createShareViewFiles({
      ...unusedReconcilePorts,
      resolveTarget: () => damaged,
      openStore: () => store,
    });
    const requested = {
      kind: "standalone" as const,
      workspaceId: "workspace-a",
    };

    await expect(
      files.read(requested, { kind: "text", path: "notes/a.md" }),
    ).resolves.toMatchObject({ text: "canonical local copy\n" });
    await expect(files.list(requested)).resolves.toMatchObject({
      files: [{ path: "notes/a.md", kind: "file" }],
    });
    await expect(files.projectionStatus(requested)).resolves.toEqual({
      state: "unavailable",
    });
    await expect(
      withStaleSensitiveWorkspaceOperation(rootPath, (lease) =>
        files.reconcile(lease, requested, "refresh"),
      ),
    ).rejects.toBeInstanceOf(SharePinInvalidError);
  });

  it("refuses a dynamically chosen import path outside the pinned grant", async () => {
    const rootPath = await workspaceRoot();
    const source = join(rootPath, "outside.txt");
    await writeFile(source, "outside\n", "utf8");
    const store = mutableTextStore();
    const scoped = {
      ...target(rootPath),
      grantedSelector: {
        paths: ["notes"],
        versionId: null,
        access: "edit" as const,
      },
    };
    const files = createShareViewFiles({
      ...unusedReconcilePorts,
      resolveTarget: () => scoped,
      openStore: () => store,
    });

    await expect(
      withStaleSensitiveWorkspaceOperation(rootPath, (lease) =>
        files.change(
          lease,
          { kind: "standalone", workspaceId: "workspace-a" },
          {
            kind: "import",
            absolutePaths: [source],
            screenAgainstRoots: null,
            targetDir: undefined,
          },
        ),
      ),
    ).rejects.toBeInstanceOf(SharedFileReadOnlyError);
    expect(store.writeTextFile).not.toHaveBeenCalled();
  });

  it("keeps a mount store warm across canonical reads and listings", async () => {
    const rootPath = await workspaceRoot();
    const store = Object.assign(readStore({ text: "canonical\n" }), {
      close: vi.fn(async () => undefined),
    });
    const files = createShareViewFiles({
      ...unusedReconcilePorts,
      resolveTarget: () => mountTarget(rootPath),
      openStore: () => store,
    });
    const requested = {
      kind: "mount" as const,
      workspaceId: "host-a",
      shareId: "share-a",
    };

    await files.read(requested, { kind: "text", path: "notes/a.md" });
    await files.list(requested);

    expect(store.close).not.toHaveBeenCalled();
  });

  it("validates a mount root before canonical or sidecar access", async () => {
    const rootPath = await workspaceRoot();
    const unsafeRoot = new Error("mount root escaped its host workspace");
    const assertProjectionRoot = vi.fn(async () => {
      throw unsafeRoot;
    });
    const openStore = vi.fn(() => readStore({ text: "must not open" }));
    const files = createShareViewFiles({
      ...unusedReconcilePorts,
      assertProjectionRoot,
      resolveTarget: () => mountTarget(rootPath),
      openStore,
    });
    const requested = {
      kind: "mount" as const,
      workspaceId: "host-a",
      shareId: "share-a",
    };
    const operations: Array<{ name: string; run: () => Promise<unknown> }> = [
      {
        name: "read",
        run: () => files.read(requested, { kind: "text", path: "notes/a.md" }),
      },
      { name: "list", run: () => files.list(requested) },
      { name: "projection status", run: () => files.projectionStatus(requested) },
      {
        name: "reconcile",
        run: () =>
          withStaleSensitiveWorkspaceOperation(rootPath, (lease) =>
            files.reconcile(lease, requested, "repair"),
          ),
      },
    ];

    for (const operation of operations) {
      assertProjectionRoot.mockClear();
      openStore.mockClear();

      await expect(operation.run(), operation.name).rejects.toBe(unsafeRoot);
      expect(assertProjectionRoot, operation.name).toHaveBeenCalledOnce();
      expect(openStore, operation.name).not.toHaveBeenCalled();
    }
  });

  it("can remove a damaged mount record without validating its folder", async () => {
    const rootPath = await workspaceRoot();
    const removeMount = vi.fn(async () => ({ folderLeft: true }));
    const files = createShareViewFiles({
      ...unusedReconcilePorts,
      resolveTarget: () => ({
        ...mountTarget(rootPath),
        rootPath,
        mountLabel: "../damaged",
      }),
      openStore: () => readStore({ text: "must not open" }),
      assertProjectionRoot: vi.fn(async () => {
        throw new Error("an unusable label has no safe folder to validate");
      }),
      removeMount,
    });

    await expect(
      withStaleSensitiveWorkspaceOperation(rootPath, (lease) =>
        files.unmount(lease, {
          kind: "mount",
          workspaceId: "host-a",
          shareId: "share-a",
        }),
      ),
    ).resolves.toEqual({ folderLeft: true });
    expect(removeMount).toHaveBeenCalledTimes(1);
  });

  it("reports bounded durable projection debt", async () => {
    const rootPath = await workspaceRoot();
    await writePendingMaterializationPaths(
      rootPath,
      Array.from({ length: 25 }, (_, index) => `notes/${index}.md`),
    );
    const files = createShareViewFiles({
      ...unusedReconcilePorts,
      resolveTarget: () => target(rootPath),
      openStore: () => readStore({ text: "unused" }),
    });

    await expect(
      files.projectionStatus({
        kind: "standalone",
        workspaceId: "workspace-a",
      }),
    ).resolves.toMatchObject({
      state: "pending",
      pendingPathCount: 25,
      pendingPaths: expect.arrayContaining(["notes/0.md", "notes/1.md"]),
      collisionPathCount: 0,
      pullInFlight: false,
    });
  });

  it.each([
    ["an invalid", "not json"],
    [
      "a stale",
      JSON.stringify({ shareId: "share-old", paths: ["notes/stale.md"] }),
    ],
  ])(
    "leaves %s collision record untouched for capture to quarantine",
    async (_recordKind, serialized) => {
      const rootPath = await workspaceRoot();
      const metadataPath = join(rootPath, ".dohc");
      const collisionPath = join(metadataPath, "share-collision-record.json");
      await mkdir(metadataPath, { recursive: true });
      await writeFile(collisionPath, serialized, "utf8");
      const store = readStore({ text: "canonical\n" });
      const files = createShareViewFiles({
        ...unusedReconcilePorts,
        resolveTarget: () => target(rootPath),
        openStore: () => store,
      });
      const errorLog = vi
        .spyOn(console, "error")
        .mockImplementation(() => undefined);
      try {
        await expect(
          files.projectionStatus({
            kind: "standalone",
            workspaceId: "workspace-a",
          }),
        ).resolves.toEqual({
          state: "pending",
          pendingPathCount: 0,
          pendingPaths: [],
          collisionPathCount: 0,
          collisionPaths: [],
          pullInFlight: false,
        });
        await expect(readFile(collisionPath, "utf8")).resolves.toBe(serialized);
        expect(await readdir(metadataPath)).toEqual([
          "share-collision-record.json",
        ]);
        expect(errorLog).not.toHaveBeenCalled();

        await expect(
          captureSharedViewLocalDivergence(
            rootPath,
            "workspace-a",
            store,
            true,
            "share-a",
          ),
        ).resolves.toMatchObject({ collisionRecordQuarantined: true });
        expect(errorLog).toHaveBeenCalledOnce();
      } finally {
        errorLog.mockRestore();
      }
      await expect(lstat(collisionPath)).rejects.toMatchObject({
        code: "ENOENT",
      });
      expect(await readdir(metadataPath)).toEqual([
        expect.stringMatching(/^share-collision-record\.json\.invalid-\d+$/),
      ]);
    },
  );

  it("reports a committed change when only its folder projection fails", async () => {
    const rootPath = await workspaceRoot();
    await writeFile(join(rootPath, "blocked"), "recipient file\n", "utf8");
    const store = mutableTextStore();
    const files = createShareViewFiles({
      ...unusedReconcilePorts,
      resolveTarget: () => target(rootPath),
      openStore: () => store,
    });

    const outcome = await withStaleSensitiveWorkspaceOperation(
      rootPath,
      (lease) =>
        files.change(
          lease,
          { kind: "standalone", workspaceId: "workspace-a" },
          {
            kind: "create",
            path: "blocked/new.md",
            initialText: "canonical\n",
          },
        ),
    );

    expect(outcome).toMatchObject({
      status: "committed",
      kind: "create",
      value: "blocked/new.md",
      projection: "pending",
    });
    await expect(
      files.read(
        { kind: "standalone", workspaceId: "workspace-a" },
        { kind: "text", path: "blocked/new.md" },
      ),
    ).resolves.toMatchObject({ text: "canonical\n" });
    await expect(
      files.projectionStatus({
        kind: "standalone",
        workspaceId: "workspace-a",
      }),
    ).resolves.toMatchObject({ state: "pending", pendingPathCount: 1 });
  });

  it("does not retry a mutation whose daemon response is indeterminate", async () => {
    const rootPath = await workspaceRoot();
    const transportError = Object.assign(new Error("daemon timed out"), {
      code: "transport-error",
    });
    const store = mutableTextStore();
    vi.mocked(store.writeTextFile).mockRejectedValueOnce(transportError);
    const files = createShareViewFiles({
      ...unusedReconcilePorts,
      resolveTarget: () => target(rootPath),
      openStore: () => store,
    });

    const outcome = await withStaleSensitiveWorkspaceOperation(
      rootPath,
      (lease) =>
        files.change(
          lease,
          { kind: "standalone", workspaceId: "workspace-a" },
          { kind: "create", path: "notes/new.md", initialText: "maybe\n" },
        ),
    );

    expect(outcome).toMatchObject({
      status: "indeterminate",
      kind: "create",
      projection: "pending",
      possibleEffects: [],
    });
    expect(store.writeTextFile).toHaveBeenCalledTimes(1);
    await expect(
      files.read(
        { kind: "standalone", workspaceId: "workspace-a" },
        { kind: "text", path: "notes/new.md" },
      ),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("honors a canonical commit proved after a lost daemon response", async () => {
    const rootPath = await workspaceRoot();
    const transportError = Object.assign(new Error("daemon timed out"), {
      code: "transport-error",
    });
    const store = mutableTextStore({
      afterWrite: () => {
        throw transportError;
      },
    });
    const files = createShareViewFiles({
      ...unusedReconcilePorts,
      resolveTarget: () => target(rootPath),
      openStore: () => store,
    });

    const outcome = await withStaleSensitiveWorkspaceOperation(
      rootPath,
      (lease) =>
        files.change(
          lease,
          { kind: "standalone", workspaceId: "workspace-a" },
          { kind: "create", path: "notes/new.md", initialText: "landed\n" },
        ),
    );

    expect(outcome).toMatchObject({
      status: "committed",
      kind: "create",
      projection: "pending",
      value: "notes/new.md",
    });
    expect(store.writeTextFile).toHaveBeenCalledTimes(1);
    await expect(
      files.read(
        { kind: "standalone", workspaceId: "workspace-a" },
        { kind: "text", path: "notes/new.md" },
      ),
    ).resolves.toMatchObject({ text: "landed\n" });
  });

  it("checks a save against canonical content while its folder is stale", async () => {
    const rootPath = await workspaceRoot();
    await mkdir(join(rootPath, "notes"), { recursive: true });
    await writePendingMaterializationPaths(rootPath, ["notes/a.md"]);
    const canonical = "canonical before\n";
    const store = mutableTextStore({
      initial: [{ path: "notes/a.md", text: canonical }],
    });
    const files = createShareViewFiles({
      ...unusedReconcilePorts,
      resolveTarget: () => target(rootPath),
      openStore: () => store,
    });

    const outcome = await withStaleSensitiveWorkspaceOperation(
      rootPath,
      (lease) =>
        files.change(
          lease,
          { kind: "standalone", workspaceId: "workspace-a" },
          {
            kind: "save",
            path: "notes/a.md",
            text: "recipient edit\n",
            expectedContentHash: createHash("sha256")
              .update(canonical)
              .digest("hex"),
          },
        ),
    );

    expect(outcome).toMatchObject({
      status: "committed",
      projection: "current",
    });
    await expect(
      readFile(join(rootPath, "notes", "a.md"), "utf8"),
    ).resolves.toBe("recipient edit\n");
  });

  it("captures an unmarked agent edit before checking a save conflict", async () => {
    const rootPath = await workspaceRoot();
    await mkdir(join(rootPath, "notes"), { recursive: true });
    const canonical = "canonical before\n";
    await writeFile(join(rootPath, "notes", "a.md"), canonical, "utf8");
    const store = mutableTextStore({
      initial: [{ path: "notes/a.md", text: canonical }],
    });
    const files = createShareViewFiles({
      ...unusedReconcilePorts,
      resolveTarget: () => target(rootPath),
      openStore: () => store,
    });
    await writeFile(
      join(rootPath, "notes", "a.md"),
      "agent edit\n",
      "utf8",
    );

    const outcome = await withStaleSensitiveWorkspaceOperation(
      rootPath,
      (lease) =>
        files.change(
          lease,
          { kind: "standalone", workspaceId: "workspace-a" },
          {
            kind: "save",
            path: "notes/a.md",
            text: "recipient edit\n",
            expectedContentHash: createHash("sha256")
              .update(canonical)
              .digest("hex"),
          },
        ),
    );

    expect(outcome).toMatchObject({
      status: "committed",
      value: {
        status: "conflict",
        currentContentHash: createHash("sha256")
          .update("agent edit\n")
          .digest("hex"),
      },
    });
    await expect(
      readFile(join(rootPath, "notes", "a.md"), "utf8"),
    ).resolves.toBe("agent edit\n");
    await expect(
      files.read(
        { kind: "standalone", workspaceId: "workspace-a" },
        { kind: "text", path: "notes/a.md" },
      ),
    ).resolves.toMatchObject({ text: "agent edit\n" });
  });

  it("reports the exact canonical prefix when a folder delete stops part way", async () => {
    const rootPath = await workspaceRoot();
    await mkdir(join(rootPath, "docs"), { recursive: true });
    await writeFile(join(rootPath, "docs", "a.md"), "a\n", "utf8");
    await writeFile(join(rootPath, "docs", "b.md"), "b\n", "utf8");
    let deletes = 0;
    const store = mutableTextStore({
      initial: [
        { path: "docs/a.md", text: "a\n" },
        { path: "docs/b.md", text: "b\n" },
      ],
      beforeDelete: () => {
        deletes += 1;
        if (deletes === 2) throw new Error("engine refused the second delete");
      },
    });
    const files = createShareViewFiles({
      ...unusedReconcilePorts,
      resolveTarget: () => target(rootPath),
      openStore: () => store,
    });

    const outcome = await withStaleSensitiveWorkspaceOperation(
      rootPath,
      (lease) =>
        files.change(
          lease,
          { kind: "standalone", workspaceId: "workspace-a" },
          { kind: "delete", path: "docs" },
        ),
    );

    expect(outcome).toMatchObject({
      status: "partial",
      projection: "pending",
      effects: [{ path: "docs/a.md", before: "present", after: "absent" }],
    });
    await expect(
      files.read(
        { kind: "standalone", workspaceId: "workspace-a" },
        { kind: "text", path: "docs/a.md" },
      ),
    ).rejects.toMatchObject({ code: "ENOENT" });
    await expect(
      files.read(
        { kind: "standalone", workspaceId: "workspace-a" },
        { kind: "text", path: "docs/b.md" },
      ),
    ).resolves.toMatchObject({ text: "b\n" });
  });

  it("rethrows a failed folder move after every landed rename is put back", async () => {
    const rootPath = await workspaceRoot();
    await mkdir(join(rootPath, "docs", "plans"), { recursive: true });
    await writeFile(join(rootPath, "docs", "plans", "a.md"), "a\n", "utf8");
    await writeFile(join(rootPath, "docs", "plans", "b.md"), "b\n", "utf8");
    let renames = 0;
    const store = mutableTextStore({
      initial: [
        { path: "docs/plans/a.md", text: "a\n" },
        { path: "docs/plans/b.md", text: "b\n" },
      ],
      afterRename: () => {
        renames += 1;
        if (renames === 2) throw new Error("engine refused the folder move");
      },
    });
    const files = createShareViewFiles({
      ...unusedReconcilePorts,
      resolveTarget: () => target(rootPath),
      openStore: () => store,
    });

    await expect(
      withStaleSensitiveWorkspaceOperation(rootPath, (lease) =>
        files.change(
          lease,
          { kind: "standalone", workspaceId: "workspace-a" },
          {
            kind: "move",
            fromPath: "docs/plans",
            toPath: "docs/roadmap",
          },
        ),
      ),
    ).rejects.toThrow("engine refused the folder move");
    await expect(
      files.read(
        { kind: "standalone", workspaceId: "workspace-a" },
        { kind: "text", path: "docs/plans/a.md" },
      ),
    ).resolves.toMatchObject({ text: "a\n" });
    await expect(
      files.read(
        { kind: "standalone", workspaceId: "workspace-a" },
        { kind: "text", path: "docs/plans/b.md" },
      ),
    ).resolves.toMatchObject({ text: "b\n" });
  });

  it("does not compensate a rename after an indeterminate daemon response", async () => {
    const rootPath = await workspaceRoot();
    await mkdir(join(rootPath, "docs"), { recursive: true });
    await writeFile(join(rootPath, "docs", "before.md"), "body\n", "utf8");
    const transportError = Object.assign(new Error("daemon timed out"), {
      code: "transport-error",
    });
    const store = mutableTextStore({
      initial: [{ path: "docs/before.md", text: "body\n" }],
      afterRename: () => {
        throw transportError;
      },
    });
    const files = createShareViewFiles({
      ...unusedReconcilePorts,
      resolveTarget: () => target(rootPath),
      openStore: () => store,
    });

    const outcome = await withStaleSensitiveWorkspaceOperation(
      rootPath,
      (lease) =>
        files.change(
          lease,
          { kind: "standalone", workspaceId: "workspace-a" },
          {
            kind: "move",
            fromPath: "docs/before.md",
            toPath: "docs/after.md",
          },
        ),
    );

    expect(outcome).toMatchObject({
      status: "committed",
      projection: "pending",
    });
    expect(store.renameTextFile).toHaveBeenCalledTimes(1);
    await expect(
      files.read(
        { kind: "standalone", workspaceId: "workspace-a" },
        { kind: "text", path: "docs/after.md" },
      ),
    ).resolves.toMatchObject({ text: "body\n" });
  });

  it("does not report a rejected same-path move as committed", async () => {
    const rootPath = await workspaceRoot();
    await mkdir(join(rootPath, "docs"), { recursive: true });
    await writeFile(join(rootPath, "docs", "note.md"), "body\n", "utf8");
    const store = mutableTextStore({
      initial: [{ path: "docs/note.md", text: "body\n" }],
    });
    const files = createShareViewFiles({
      ...unusedReconcilePorts,
      resolveTarget: () => target(rootPath),
      openStore: () => store,
    });

    await expect(
      withStaleSensitiveWorkspaceOperation(rootPath, (lease) =>
        files.change(
          lease,
          { kind: "standalone", workspaceId: "workspace-a" },
          {
            kind: "move",
            fromPath: "docs/note.md",
            toPath: "docs/note.md",
          },
        ),
      ),
    ).rejects.toThrow("Cannot move a path into itself");
    expect(store.renameTextFile).not.toHaveBeenCalled();
  });

  it("keeps main behind the received-share owner", async () => {
    const main = await readFile(new URL("../main.ts", import.meta.url), "utf8");
    expect(main).toContain("createShareViewFiles({");
    expect(main).not.toContain('from "./workspaces/sharedView"');
    expect(main).not.toContain('from "./workspaces/shareViewFileChanges"');
    expect(main).not.toContain('from "./workspaces/shareViewTextChange"');
    expect(main).not.toMatch(/routeWorkspace(?:Text|File|Path)/);
    expect(main).toContain(
      '...(target.kind === "mount" ? { shareMount: true as const } : {})',
    );
  });
});
