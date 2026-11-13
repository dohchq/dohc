import { createHash } from "node:crypto";
import * as fsPromises from "node:fs/promises";
import { chmod, link, lstat, mkdir, readFile, readdir, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { dirname, join, sep } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createShareViewDaemonHarness, type ShareViewDaemonHarness } from "../testing/shareViewLoopbackTransport";
import { readPendingMaterializationPaths, readSharedViewProjectionDebt, createShareViewLifecycle, shareViewFilesProjection, withShareViewRefreshLifecycleLock } from "./sharedView";
import { SharePinInvalidError, shareViewIdentitySelector } from "./shareViewRecords";
import { MAX_ENGINE_CAPTURE_TEXT_BYTES } from "./workspaceEngineCapture";
import { createShareViewFiles, type ResolvedShareViewFilesTarget, type ShareViewFileChange, type ShareViewFileChangeValue } from "./shareViewFiles";
import type { ShareViewFilesOwnerCapability } from "./shareViewFilesOwner";
import { withStaleSensitiveWorkspaceOperation, type WorkspaceTextWriteResult } from "./workspaceAssets";
import type { PullShareViewResult, ShareViewRefusal } from "@dohc/workspace-contracts/relay";
import { createTestScratch } from "./testTemp";
import type { ImportCopyOutcome } from "./workspaceFiles";
import type { CaptureVersionedTextStore } from "./workspaceEngineCaptureLiveStore";
import { LocalStateUnavailableError, readLocalStateFrom } from "./workspaceLocalState";

// This suite isolates shared-view primitives. Owner admission itself is kept
// real in shareViewFiles.test.ts and every file-operation/mount e2e suite.
vi.mock("./shareViewFilesOwner", () => {
  const resources = new WeakMap<object, Record<string, unknown>>();
  return {
    // Without an owner, the view each call names is its own workspace.
    assertActiveShareViewFilesOwner: (
      owner: object,
      expected: { rootPath?: string } = {},
    ) =>
      resources.get(owner) ?? {
        kind: "standalone",
        workspaceId: "test-workspace",
        storeWorkspaceId: "test-workspace",
        schedulingRootPath: expected.rootPath ?? "unused",
        rootPath: "unused",
        shareId: "test-share",
        ...expected,
      },
    withActiveShareViewFilesOwnerOperation: (
      _owner: unknown,
      _expected: unknown,
      operation: () => Promise<unknown>,
    ) => operation(),
    withShareViewFilesOwner: async (
      input: { resource: Record<string, unknown> },
      run: (owner: ShareViewFilesOwnerCapability) => Promise<unknown>,
    ) => {
      const owner = {} as ShareViewFilesOwnerCapability;
      resources.set(owner, input.resource);
      try {
        return await run(owner);
      } finally {
        resources.delete(owner);
      }
    },
  };
});

const testLifecycle = createShareViewLifecycle(
  {} as ShareViewFilesOwnerCapability,
);
const testProjection = shareViewFilesProjection(
  {} as ShareViewFilesOwnerCapability,
);
const clearPullInFlightMarker = testProjection.clearPullInFlight;
const recordCollisionPaths = testProjection.recordCollisions;
const captureSharedViewLocalDivergence = (
  rootDir: string,
  workspaceId: string,
  store: CaptureVersionedTextStore,
  allowLocalJournaling: boolean,
  shareId: string,
  options?: {
    beforeCaptureWrite?: (path: string) => Promise<void>;
    paths?: readonly string[];
    workspaceLease?: Parameters<typeof testLifecycle.captureShared>[0]["workspaceLease"];
  },
) =>
  testLifecycle.captureShared({
    rootDir,
    workspaceId,
    store,
    allowLocalJournaling,
    shareId,
    ...options,
  });
const captureStandaloneShareViewDivergence = testLifecycle.captureStandalone;
const captureStandaloneShareViewRefresh =
  testLifecycle.captureStandaloneRefresh;
const reconcileStandaloneShareView = testLifecycle.reconcileStandalone;
const refreshSharedViewOnceWithPull = testLifecycle.refreshOnce;

async function readCollisionRecordPaths(
  rootDir: string,
  shareId: string,
): Promise<Set<string>> {
  return (await readSharedViewProjectionDebt(rootDir, shareId)).collisionPaths;
}

// Record reads while allowing the real filesystem operations.
let readdirCalls: string[] = [];
let realpathOverride:
  | ((path: string, resolved: string) => string | null)
  | null = null;
let failRenameToPathOnce: { path: string; error: Error } | null = null;
let failReaddirPathOnce: { path: string; error: Error } | null = null;
let beforeOpen: ((path: string) => Promise<void>) | null = null;
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    readdir: (async (
      path: Parameters<typeof readdir>[0],
      options?: unknown,
    ) => {
      readdirCalls.push(String(path));
      const failure = failReaddirPathOnce;
      if (failure !== null && String(path) === failure.path) {
        failReaddirPathOnce = null;
        throw failure.error;
      }
      return actual.readdir(path as string, options as never);
    }) as typeof readdir,
    realpath: (async (
      path: Parameters<typeof actual.realpath>[0],
      options?: unknown,
    ) => {
      const resolved = await actual.realpath(path, options as never);
      return realpathOverride?.(String(path), String(resolved)) ?? resolved;
    }) as typeof actual.realpath,
    rename: (async (
      oldPath: Parameters<typeof actual.rename>[0],
      newPath: Parameters<typeof actual.rename>[1],
    ) => {
      const failure = failRenameToPathOnce;
      if (failure !== null && String(newPath) === failure.path) {
        failRenameToPathOnce = null;
        throw failure.error;
      }
      return actual.rename(oldPath, newPath);
    }) as typeof actual.rename,
    open: (async (...args: Parameters<typeof actual.open>) => {
      await beforeOpen?.(String(args[0]));
      return actual.open(...args);
    }) as typeof actual.open,
  };
});

// Another process changes a dropped folder after the screen and before the
// import reads it. A test can also forge what the screen recorded.
let afterDropScreen: ((screened: Awaited<ReturnType<typeof import("./workspaceFiles").screenDroppedPaths>>) => Promise<void>) | null = null;
vi.mock("./workspaceFiles", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./workspaceFiles")>();
  return {
    ...actual,
    screenDroppedPaths: (async (...args: Parameters<typeof actual.screenDroppedPaths>) => {
      const screened = await actual.screenDroppedPaths(...args);
      await afterDropScreen?.(screened);
      return screened;
    }) as typeof actual.screenDroppedPaths,
  };
});

// These tests drive the pull with the selector a share record pins. It is a
// real selector — no paths and no version selects nothing at all, which the
// engine refuses.
const PINNED_SELECTOR = {
  paths: ["docs"],
  versionId: null,
  access: "view",
} as const;

const WORKSPACE = "shared-view-ws";
const SHARE_ID = "share-1";
const TOKEN = "test:recipient";

function reconcileStandaloneForTest(
  input: Omit<
    Parameters<typeof reconcileStandaloneShareView>[0],
    "captured"
  > & { ended: boolean },
) {
  return withShareViewRefreshLifecycleLock(input.rootDir, async () => {
    const { ended, ...refreshInput } = input;
    const capture = await captureStandaloneShareViewRefresh({
      rootDir: input.rootDir,
      workspaceId: input.workspaceId,
      store: input.store,
      pinnedSelector: input.pinnedSelector,
      shareId: input.shareId,
      ended,
      preservedPaths: input.preservedPaths,
    });
    if (!capture.ok) return capture;
    return reconcileStandaloneShareView({ ...refreshInput, captured: capture.captured });
  });
}

// This file no longer references the legacy TypeScript engine at all — not by import
// and not by vi.mock. That is a stronger guarantee than a not-called spy: the
// module cannot be reached from here even indirectly. The production side is
// held by the ratchet, which fails if sharedView.ts ever gains a runtime
// import of the legacy package.
//
// materializeSharedViewPaths touches only ensureMainVersion and the two read
// methods, so the tests that drive it directly need nothing more than this.
function stubStore(
  readTextFile: () => Promise<{ text: string }>,
): Parameters<typeof materializeSharedViewPaths>[3] {
  return {
    ensureMainVersion: async () => ({ id: "main" }),
    readTextFile,
    readBinaryFile: async () => {
      throw new Error(
        "stubStore: binary reads are not part of these two tests",
      );
    },
    close: async () => undefined,
  } as unknown as Parameters<typeof materializeSharedViewPaths>[3];
}

let harnesses: ShareViewDaemonHarness[] = [];

// Writers of `.dohc/local` ask the engine's open. Here a view counts as opened
// once its `.dohc/local` exists, as the loopback's open leaves it, unless a
// test closes it or opens it without keeping `.dohc/local` out of iCloud.
const OPENED = { localStateReady: true };
const NOT_EXCLUDED = { localStateReady: false };
const closedViews = new Set<string>();
const unexcludedViews = new Set<string>();

/** Where a view's refresh records live. */
function recordsDir(rootDir: string): string {
  return join(rootDir, ".dohc", "local", "share-refresh");
}

/** A view whose store the engine has opened: its `.dohc/local` is made. */
async function openedView(rootDir: string): Promise<void> {
  await mkdir(join(rootDir, ".dohc", "local"), { recursive: true, mode: 0o700 });
}

/** An opened view's records folder, made as dohc makes it. */
async function openedRecordsDir(rootDir: string): Promise<string> {
  await mkdir(recordsDir(rootDir), { recursive: true, mode: 0o700 });
  return recordsDir(rootDir);
}

beforeEach(() => {
  closedViews.clear();
  unexcludedViews.clear();
  readLocalStateFrom({
    currentBinding: (view) =>
      closedViews.has(view.rootPath)
        ? null
        : unexcludedViews.has(view.rootPath)
          ? NOT_EXCLUDED
          : OPENED,
    // An open that could not keep the folder out of iCloud Drive prepared it.
    localStateOpenAt: async (rootPath) => (closedViews.has(rootPath) ? null : { current: () => !closedViews.has(rootPath) }),
  });
  harnesses = [];
  realpathOverride = null;
  failRenameToPathOnce = null;
  failReaddirPathOnce = null;
});

afterEach(async () => {
  realpathOverride = null;
  failRenameToPathOnce = null;
  failReaddirPathOnce = null;
  beforeOpen = null;
  await Promise.all(harnesses.map((harness) => harness.closeAll()));
});

function daemonHarness(relay: FakeShareRelay): ShareViewDaemonHarness {
  const harness = createShareViewDaemonHarness(relay.connection());
  harnesses.push(harness);
  return harness;
}

// One refresh pass over the production daemon path: EngineRelayClient's
// share.view.pull for the pull, createCaptureLiveStores for the store. The
// store is opened and closed per pass exactly as the legacy fixture did, so a
// cursor that only survived inside one open session would fail the
// "unchanged" assertions below.
async function refreshSharedViewOnce(
  harness: ShareViewDaemonHarness,
  input: {
    rootDir: string;
    workspaceId: string;
    shareId: string;
    pinnedSelector?: unknown;
    recordRefusals?: (refusals: ShareViewRefusal[]) => Promise<void>;
  },
) {
  const target = { workspaceId: input.workspaceId, rootPath: input.rootDir };
  const pull = harness.pullFor(target);
  const store = harness.openStore(target);
  try {
    return await refreshSharedViewOnceWithPull({
      rootDir: input.rootDir,
      workspaceId: input.workspaceId,
      relay: harness.relay,
      shareId: input.shareId,
      pull,
      pinnedSelector: input.pinnedSelector ?? PINNED_SELECTOR,
      recordRefusals: input.recordRefusals ?? (async () => undefined),
      store,
    });
  } finally {
    await store.close();
  }
}

function sha256(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

async function writePendingMaterializationPaths(
  rootDir: string,
  paths: readonly string[],
): Promise<void> {
  const recordPath = join(
    await openedRecordsDir(rootDir),
    "pending-materialization.json",
  );
  const counts = await readFile(recordPath, "utf8").then(
    (serialized) =>
      (JSON.parse(serialized) as { counts: Record<string, number> }).counts,
    () => ({}) as Record<string, number>,
  );
  for (const path of new Set(paths)) counts[path] = (counts[path] ?? 0) + 1;
  await writeFile(recordPath, JSON.stringify({ counts }), { encoding: "utf8", mode: 0o600 });
}

async function materializeSharedViewPaths(
  rootDir: string,
  workspaceId: string,
  changedPaths: PullShareViewResult["changedPaths"],
  store: CaptureVersionedTextStore,
): Promise<void> {
  await refreshSharedViewOnceWithPull({
    rootDir,
    workspaceId,
    relay: new FakeShareRelay().connection(),
    shareId: SHARE_ID,
    pinnedSelector: { paths: [], versionId: "main", access: "view" },
    recordRefusals: async () => undefined,
    store,
    pull: async () => ({
      fetched: changedPaths.length,
      applied: changedPaths.length,
      skipped: 0,
      nextCursor: changedPaths.length,
      refusalCount: 0,
      refusals: [],
      changedPaths,
      commitCursor: async () => undefined,
    }),
  });
}

interface OwnedChangeScope {
  workspaceId: string;
  rootPath: string;
  shareViewStore: () => CaptureVersionedTextStore;
  // Files the share grants one by one. Absent grants the whole version.
  grantedPaths?: string[];
}

async function applyOwnedShareViewChange(
  scope: OwnedChangeScope,
  change: ShareViewFileChange,
): Promise<ShareViewFileChangeValue> {
  const requested = {
    kind: "standalone" as const,
    workspaceId: scope.workspaceId,
  };
  const resolved: ResolvedShareViewFilesTarget = {
    ...requested,
    storeWorkspaceId: scope.workspaceId,
    schedulingRootPath: scope.rootPath,
    rootPath: scope.rootPath,
    shareId: SHARE_ID,
    recipientUserId: "recipient-a",
    granterEmail: "granter@example.com",
    grantedSelector: { paths: scope.grantedPaths ?? [], versionId: "main", access: "edit" },
    ended: false,
  };
  const files = createShareViewFiles({
    resolveTarget: () => resolved,
    openStore: () => scope.shareViewStore(),
    resolveRelay: async () => null,
    pull: async () => {
      throw new Error("Unexpected pull");
    },
    recordRefusals: async () => undefined,
    updateUnsavedPaths: async () => undefined,
    markEnded: async () => undefined,
    retireTarget: async () => undefined,
    assertProjectionRoot: async () => undefined,
    createMount: async () => undefined,
    removeMount: async () => ({ folderLeft: false }),
  });
  const outcome = await withStaleSensitiveWorkspaceOperation(
    scope.rootPath,
    (lease) => files.change(lease, requested, change),
  );
  if (outcome.status !== "committed") throw new Error(outcome.message);
  return outcome.value;
}

function applyShareViewTextWrite(
  input: OwnedChangeScope & {
    relativePath: string;
    text: string;
    expectedContentHash: string;
  },
): Promise<WorkspaceTextWriteResult> {
  return applyOwnedShareViewChange(input, {
    kind: "save",
    path: input.relativePath,
    text: input.text,
    expectedContentHash: input.expectedContentHash,
  }) as Promise<WorkspaceTextWriteResult>;
}

function applyShareViewPathDelete(
  input: OwnedChangeScope & { relativePath: string },
): Promise<{ trashed: boolean }> {
  return applyOwnedShareViewChange(input, {
    kind: "delete",
    path: input.relativePath,
  }) as Promise<{ trashed: boolean }>;
}

function applyShareViewFileImport(
  input: OwnedChangeScope & {
    absolutePaths: string[];
    screenAgainstRoots: string[] | null;
    targetDir: string | undefined;
  },
): Promise<ImportCopyOutcome> {
  return applyOwnedShareViewChange(input, {
    kind: "import",
    absolutePaths: input.absolutePaths,
    screenAgainstRoots: input.screenAgainstRoots,
    targetDir: input.targetDir,
  }) as Promise<ImportCopyOutcome>;
}

async function momentIds(store: {
  listMoments: (input: { workspaceId: string; limit: number }) => Promise<{
    moments: Array<{ id: string }>;
  }>;
}): Promise<string[]> {
  return (
    await store.listMoments({ workspaceId: WORKSPACE, limit: 200 })
  ).moments.map((moment) => moment.id);
}

// Minimal share-route double (same shape the engine share client tests use).
class FakeShareRelay {
  ops: Array<Record<string, unknown>> = [];
  blobs = new Map<string, Buffer>();
  ended = false;
  pageSize: number | null = null;
  logRequests = 0;
  private nextSeq = 1;

  addWrite(path: string, content: string): void {
    const relaySeq = this.nextSeq++;
    this.blobs.set(sha256(content), Buffer.from(content, "utf8"));
    this.ops.push({
      relaySeq,
      originId: "origin-granter",
      originSeq: relaySeq,
      opKind: "moment.append",
      payload: {
        momentId: `moment-${relaySeq}`,
        versionId: "main",
        objectId: `object-${path}`,
        path,
        recordedAtMs: 1000 + relaySeq,
        operation: "write",
        payloadBeforeBlobSha256: null,
        payloadBeforePath: null,
        payloadAfterBlobSha256: sha256(content),
        payloadAfterPath: path,
        metadata: { origin: "local-file" },
        beforePresent: "null",
      },
      recordedAtMs: 1000 + relaySeq,
    });
  }

  addRename(from: string, to: string, content: string): void {
    const relaySeq = this.nextSeq++;
    this.blobs.set(sha256(content), Buffer.from(content, "utf8"));
    this.ops.push({
      relaySeq,
      originId: "origin-granter",
      originSeq: relaySeq,
      opKind: "moment.append",
      payload: {
        momentId: `moment-${relaySeq}`,
        versionId: "main",
        objectId: "object-renamed",
        path: to,
        recordedAtMs: 1000 + relaySeq,
        operation: "rename",
        payloadBeforeBlobSha256: sha256(content),
        payloadBeforePath: from,
        payloadAfterBlobSha256: sha256(content),
        payloadAfterPath: to,
        metadata: { origin: "local-file" },
        beforePresent: "present",
      },
      recordedAtMs: 1000 + relaySeq,
    });
  }

  addDelete(path: string): void {
    const relaySeq = this.nextSeq++;
    this.ops.push({
      relaySeq,
      originId: "origin-granter",
      originSeq: relaySeq,
      opKind: "moment.append",
      payload: {
        momentId: `moment-${relaySeq}`,
        versionId: "main",
        objectId: `object-${path}`,
        path,
        recordedAtMs: 1000 + relaySeq,
        operation: "delete",
        payloadBeforeBlobSha256: null,
        payloadBeforePath: null,
        payloadAfterBlobSha256: sha256(""),
        payloadAfterPath: path,
        metadata: { origin: "local-file" },
        beforePresent: "present",
      },
      recordedAtMs: 1000 + relaySeq,
    });
  }

  fetch = async (
    url: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const href =
      typeof url === "string" ? url : url instanceof URL ? url.href : url.url;
    const parsed = new URL(href);
    const auth = new Headers(init?.headers).get("authorization");
    if (auth !== `Bearer ${TOKEN}`) {
      return Response.json(
        { ok: false, error: "unauthorized" },
        { status: 401 },
      );
    }
    const notFound = () =>
      Response.json(
        { ok: false, error: "not found", code: "not_found" },
        { status: 404 },
      );
    if (this.ended) return notFound();
    const parts = parsed.pathname.split("/").filter(Boolean);
    if (parts[0] !== "sync" || parts[1] !== "shares" || parts[2] !== SHARE_ID)
      return notFound();
    if (parts.length === 3) {
      return notFound();
    }
    if (parts.length === 4 && parts[3] === "log") {
      this.logRequests += 1;
      const since = Number(parsed.searchParams.get("since") ?? 0);
      const remaining = this.ops.filter((op) => Number(op.relaySeq) > since);
      const rows =
        this.pageSize === null ? remaining : remaining.slice(0, this.pageSize);
      const last = rows[rows.length - 1];
      return Response.json({
        ok: true,
        ops: rows,
        nextCursor: Number(last?.relaySeq ?? since),
        hasMore: rows.length < remaining.length,
      });
    }
    if (parts.length === 5 && parts[3] === "blobs") {
      const blob = this.blobs.get(parts[4]!);
      if (!blob) return notFound();
      return new Response(new Uint8Array(blob), { status: 200 });
    }
    return notFound();
  };

  connection() {
    return { baseUrl: "http://relay.test", token: TOKEN, fetch: this.fetch };
  }
}

describe("shared view refresh", () => {
  describe("materialization through an in-view alias", () => {
    const store = {
      ensureMainVersion: async () => ({ id: "main" }),
      listTextFileMetadata: async () => [],
      readTextFile: async () => ({ text: "relay bytes" }),
      readBinaryFile: async () => {
        throw new Error("not part of this test");
      },
      close: async () => undefined,
    } as unknown as Parameters<
      typeof refreshSharedViewOnceWithPull
    >[0]["store"];

    const write = (rootDir: string, path: string) =>
      refreshSharedViewOnceWithPull({
        rootDir,
        workspaceId: WORKSPACE,
        relay: new FakeShareRelay().connection(),
        shareId: SHARE_ID,
        pinnedSelector: { paths: [], versionId: "main", access: "view" },
        recordRefusals: async () => undefined,
        store,
        pull: async () => ({
          fetched: 1,
          applied: 1,
          skipped: 0,
          nextCursor: 1,
          refusalCount: 0,
          refusals: [],
          changedPaths: [{ path, operation: "write", contentKind: "text" }],
          commitCursor: async () => undefined,
        }),
      });

    it("refuses relay bytes that land in the view's own metadata", async () => {
      const rootDir = await createTestScratch("dohc-shared-view-desktop-");
      await mkdir(join(rootDir, ".dohc"), { recursive: true });
      await symlink(join(rootDir, ".dohc"), join(rootDir, "meta"), "dir");
      await expect(write(rootDir, "meta/owned.md")).rejects.toThrow(
        /Shared view path leads to a reserved area/,
      );
      await expect(lstat(join(rootDir, ".dohc", "owned.md"))).rejects.toMatchObject({
        code: "ENOENT",
      });
    });

    it.each(["dangling", "metadata", "outside"] as const)(
      "heals a %s leaf link without following it",
      async (shape) => {
        const rootDir = await createTestScratch("dohc-shared-view-desktop-");
        const outsideDir = await createTestScratch("dohc-shared-view-desktop-");
        await mkdir(join(rootDir, ".dohc"), { recursive: true });
        await writeFile(join(rootDir, ".dohc", "settings.json"), "settings");
        const target =
          shape === "dangling"
            ? join(rootDir, "gone.md")
            : shape === "metadata"
              ? join(rootDir, ".dohc", "settings.json")
              : join(outsideDir, "victim.md");
        if (shape === "outside") await writeFile(target, "untouched");
        await symlink(target, join(rootDir, "note.md"), "file");

        await write(rootDir, "note.md");

        expect((await lstat(join(rootDir, "note.md"))).isSymbolicLink()).toBe(
          false,
        );
        await expect(readFile(join(rootDir, "note.md"), "utf8")).resolves.toBe(
          "relay bytes",
        );
        if (shape === "metadata") {
          await expect(
            readFile(join(rootDir, ".dohc", "settings.json"), "utf8"),
          ).resolves.toBe("settings");
        }
        if (shape === "outside") {
          await expect(readFile(target, "utf8")).resolves.toBe("untouched");
        }
      },
    );

  });
  // A view on a disk that ignores case, refreshed the way dohc refreshes it,
  // capturing first. Skips where the disk keeps case apart.
  async function caseFoldingView(context: { skip: (note: string) => void }, access: "view" | "edit") {
    const rootDir = await createTestScratch("dohc-shared-view-desktop-");
    await writeFile(join(rootDir, "probe.md"), "");
    const ignoresCase = await stat(join(rootDir, "PROBE.md")).then(() => true, () => false);
    await rm(join(rootDir, "probe.md"));
    if (!ignoresCase) context.skip("this disk keeps case apart");
    const relay = new FakeShareRelay();
    const harness = daemonHarness(relay);
    const target = { workspaceId: WORKSPACE, rootPath: rootDir };
    const store = harness.openStore(target);
    const pinnedSelector = { ...PINNED_SELECTOR, access };
    const reconcile = async (preservedPaths?: readonly string[]) => {
      const refreshed = await reconcileStandaloneForTest({
        rootDir, workspaceId: WORKSPACE, relay: harness.relay, shareId: SHARE_ID, store, pull: harness.pullFor(target),
        pinnedSelector, recordRefusals: async () => undefined, ended: false, preservedPaths,
      });
      if (!refreshed.ok) throw new Error(refreshed.errorMessage);
      return refreshed;
    };
    const capture = (preservedPaths?: readonly string[] | null) => captureStandaloneShareViewDivergence({
      rootDir, workspaceId: WORKSPACE, store, pinnedSelector, shareId: SHARE_ID, ended: false, preservedPaths,
    });
    const head = async (path: string) => {
      const main = await store.ensureMainVersion({ workspaceId: WORKSPACE });
      return (await store.readTextFile({ workspaceId: WORKSPACE, versionId: main.id, path }))?.text ?? null;
    };
    const names = async (folder = rootDir) => (await readdir(folder)).filter((name) => !name.startsWith("."));
    return { rootDir, relay, harness, store, reconcile, capture, head, names };
  }

  async function dropIntoDocs(
    build: (sourceRoot: string) => Promise<string[]>,
    options: { held?: string; grantedPaths?: string[] } = {},
  ) {
    const rootDir = await createTestScratch("dohc-shared-view-desktop-");
    const sourceRoot = await createTestScratch("dohc-shared-view-desktop-");
    const absolutePaths = await build(sourceRoot);
    const relay = new FakeShareRelay();
    const harness = daemonHarness(relay);
    relay.addWrite(options.held ?? "docs/seed.md", "seed");
    await refreshSharedViewOnce(harness, { rootDir, workspaceId: WORKSPACE, shareId: SHARE_ID });
    const store = harness.openStore({ workspaceId: WORKSPACE, rootPath: rootDir });
    const importing = applyShareViewFileImport({
      workspaceId: WORKSPACE,
      rootPath: rootDir,
      shareViewStore: () => store,
      absolutePaths,
      screenAgainstRoots: [rootDir],
      targetDir: "docs",
      ...(options.grantedPaths ? { grantedPaths: options.grantedPaths } : {}),
    });
    const stored = async () => {
      const main = await store.ensureMainVersion({ workspaceId: WORKSPACE });
      return store.listTextFileMetadata({ workspaceId: WORKSPACE, versionId: main.id });
    };
    const storePaths = async () => (await stored()).map((file) => file.path).sort();
    return { importing, stored, storePaths, close: () => store.close() };
  }

  it("refuses a folder delete when its projection cannot be read", async () => {
    const rootDir = await createTestScratch("dohc-shared-view-desktop-");
    const relay = new FakeShareRelay();
    const harness = daemonHarness(relay);
    const path = "docs/plans/one.md";
    relay.addWrite(path, "one\n");
    await refreshSharedViewOnce(harness, {
      rootDir,
      workspaceId: WORKSPACE,
      shareId: SHARE_ID,
    });
    const store = harness.openStore({
      workspaceId: WORKSPACE,
      rootPath: rootDir,
    });
    failReaddirPathOnce = {
      path: join(rootDir, "docs", "plans"),
      error: Object.assign(new Error("projection directory is unreadable"), {
        code: "EACCES",
      }),
    };

    try {
      await expect(
        applyShareViewPathDelete({
          workspaceId: WORKSPACE,
          rootPath: rootDir,
          relativePath: "docs/plans",
          shareViewStore: () => store,
        }),
        "an unreadable directory looks empty and is deleted recursively",
      ).rejects.toThrow("projection directory is unreadable");
      await expect(readFile(join(rootDir, path), "utf8")).resolves.toBe(
        "one\n",
      );
      const main = await store.ensureMainVersion({ workspaceId: WORKSPACE });
      await expect(
        store.listTextFileMetadata({
          workspaceId: WORKSPACE,
          versionId: main.id,
        }),
      ).resolves.toEqual([expect.objectContaining({ path })]);
    } finally {
      await store.close();
    }
  });

  it("captures an out-of-app modification through the standalone refresh", async () => {
    const rootDir = await createTestScratch("dohc-shared-view-desktop-");
    const relay = new FakeShareRelay();
    const harness = daemonHarness(relay);
    const path = "docs/a.md";
    const target = { workspaceId: WORKSPACE, rootPath: rootDir };
    relay.addWrite(path, "granter body");
    await refreshSharedViewOnce(harness, {
      rootDir,
      workspaceId: WORKSPACE,
      shareId: SHARE_ID,
    });
    await writeFile(join(rootDir, path), "outside editor", "utf8");

    const store = harness.openStore(target);
    try {
      const before = await store.listMoments({
        workspaceId: WORKSPACE,
        limit: 100,
      });
      const beforeIds = new Set(before.moments.map((moment) => moment.id));

      const refreshed = await reconcileStandaloneForTest({
        rootDir,
        workspaceId: WORKSPACE,
        relay: harness.relay,
        shareId: SHARE_ID,
        store,
        pull: harness.pullFor(target),
        pinnedSelector: { ...PINNED_SELECTOR, access: "edit" },
        recordRefusals: async () => undefined,
        ended: false,
      });
      if (!refreshed.ok) throw new Error(refreshed.errorMessage);
      expect(refreshed.status).toBe("updated");
      expect(refreshed.changedPaths).toBe(1);
      expect(refreshed.excludedPaths).toEqual([]);
      expect(refreshed.unjournalablePaths).toEqual([]);

      const after = await store.listMoments({
        workspaceId: WORKSPACE,
        limit: 100,
      });
      const captured = after.moments.find(
        (moment) => !beforeIds.has(moment.id),
      );
      expect(captured?.path).toBe(path);
      expect(captured?.metadata.origin).toBe("local-file");
      const moment = captured
        ? await store.getMoment({
            workspaceId: WORKSPACE,
            momentId: captured.id,
          })
        : null;
      expect(moment?.payload.after.text).toBe("outside editor");
      expect(await readFile(join(rootDir, path), "utf8")).toBe(
        "outside editor",
      );

      const momentIds = after.moments.map((entry) => entry.id);
      const quiet = await reconcileStandaloneForTest({
        rootDir,
        workspaceId: WORKSPACE,
        relay: harness.relay,
        shareId: SHARE_ID,
        store,
        pull: harness.pullFor(target),
        pinnedSelector: { ...PINNED_SELECTOR, access: "edit" },
        recordRefusals: async () => undefined,
        ended: false,
      });
      if (!quiet.ok) throw new Error(quiet.errorMessage);
      expect(quiet.status).toBe("unchanged");
      expect(await readFile(join(rootDir, path), "utf8")).toBe(
        "outside editor",
      );
      const settled = await store.listMoments({
        workspaceId: WORKSPACE,
        limit: 100,
      });
      expect(settled.moments.map((entry) => entry.id)).toEqual(momentIds);
    } finally {
      await store.close();
    }
  });

  it("does not journal an out-of-app edit from submit capture on a view share", async () => {
    const rootDir = await createTestScratch("dohc-shared-view-desktop-");
    const relay = new FakeShareRelay();
    const harness = daemonHarness(relay);
    const path = "docs/view-only-submit.md";
    relay.addWrite(path, "granter body");
    await refreshSharedViewOnce(harness, {
      rootDir,
      workspaceId: WORKSPACE,
      shareId: SHARE_ID,
    });
    await writeFile(join(rootDir, path), "recipient tampered", "utf8");

    const store = harness.openStore({
      workspaceId: WORKSPACE,
      rootPath: rootDir,
    });
    try {
      const before = await momentIds(store);
      await expect(
        captureStandaloneShareViewDivergence({
          rootDir,
          workspaceId: WORKSPACE,
          store,
          pinnedSelector: PINNED_SELECTOR,
          shareId: SHARE_ID,
          ended: false,
        }),
      ).resolves.toEqual({
        capturedPaths: 0,
        repairedPaths: 1,
        unjournalablePaths: [],
      });
      expect(await momentIds(store)).toEqual(before);
      expect(await readFile(join(rootDir, path), "utf8")).toBe("granter body");
    } finally {
      await store.close();
    }
  });

  it("does not journal an out-of-app edit after the share ended", async () => {
    const rootDir = await createTestScratch("dohc-shared-view-desktop-");
    const relay = new FakeShareRelay();
    const harness = daemonHarness(relay);
    const path = "docs/ended.md";
    relay.addWrite(path, "granter body");
    await refreshSharedViewOnce(harness, {
      rootDir,
      workspaceId: WORKSPACE,
      shareId: SHARE_ID,
    });
    await writeFile(join(rootDir, path), "recipient tampered", "utf8");

    const store = harness.openStore({
      workspaceId: WORKSPACE,
      rootPath: rootDir,
    });
    try {
      const before = await momentIds(store);
      await expect(
        captureStandaloneShareViewDivergence({
          rootDir,
          workspaceId: WORKSPACE,
          store,
          pinnedSelector: { ...PINNED_SELECTOR, access: "edit" },
          shareId: SHARE_ID,
          ended: true,
        }),
      ).resolves.toEqual({
        capturedPaths: 0,
        repairedPaths: 1,
        unjournalablePaths: [],
      });
      expect(await momentIds(store)).toEqual(before);
      expect(await readFile(join(rootDir, path), "utf8")).toBe("granter body");
    } finally {
      await store.close();
    }
  });

  it("compares disk with the snapshot current after an in-app save", async () => {
    const rootDir = await createTestScratch("dohc-shared-view-desktop-");
    const relay = new FakeShareRelay();
    const harness = daemonHarness(relay);
    const path = "docs/fresh-head.md";
    const target = { workspaceId: WORKSPACE, rootPath: rootDir };
    relay.addWrite(path, "granter body");
    await refreshSharedViewOnce(harness, {
      rootDir,
      workspaceId: WORKSPACE,
      shareId: SHARE_ID,
    });

    const store = harness.openStore(target);
    let markSnapshotRead!: () => void;
    let releaseCapture!: () => void;
    const snapshotRead = new Promise<void>((resolve) => {
      markSnapshotRead = resolve;
    });
    const captureHeld = new Promise<void>((resolve) => {
      releaseCapture = resolve;
    });
    const captureStore: typeof store = {
      ...store,
      async listTextFileMetadata(input) {
        const snapshot = await store.listTextFileMetadata(input);
        markSnapshotRead();
        await captureHeld;
        return snapshot;
      },
    };

    try {
      const capturing = captureSharedViewLocalDivergence(
        rootDir,
        WORKSPACE,
        captureStore,
        true,
        SHARE_ID,
      );
      await snapshotRead;
      await expect(
        applyShareViewTextWrite({
          workspaceId: WORKSPACE,
          rootPath: rootDir,
          relativePath: path,
          text: "saved in app",
          expectedContentHash: sha256("granter body"),
          shareViewStore: () => store,
        }),
      ).resolves.toMatchObject({ status: "written" });
      releaseCapture();

      await expect(capturing).resolves.toEqual({
        capturedPaths: 0,
        repairedPaths: 0,
        unjournalablePaths: [],
      });
      const moments = (
        await store.listMoments({ workspaceId: WORKSPACE, limit: 200 })
      ).moments.filter((moment) => moment.path === path);
      const savedBodies = await Promise.all(
        moments.map(
          async (moment) =>
            (
              await store.getMoment({
                workspaceId: WORKSPACE,
                momentId: moment.id,
              })
            )?.payload.after.text,
        ),
      );
      expect(
        savedBodies.filter((body) => body === "saved in app"),
      ).toHaveLength(1);
    } finally {
      releaseCapture();
      await store.close();
    }
  });

  it("leaves unjournalable local content in place when the pull changes its path", async () => {
    const rootDir = await createTestScratch("dohc-shared-view-desktop-");
    const relay = new FakeShareRelay();
    const harness = daemonHarness(relay);
    const path = "docs/oversized.md";
    const target = { workspaceId: WORKSPACE, rootPath: rootDir };
    relay.addWrite(path, "granter body");
    await refreshSharedViewOnce(harness, {
      rootDir,
      workspaceId: WORKSPACE,
      shareId: SHARE_ID,
    });
    const oversized = "o".repeat(MAX_ENGINE_CAPTURE_TEXT_BYTES + 1);
    await writeFile(join(rootDir, path), oversized, "utf8");

    const store = harness.openStore(target);
    try {
      const before = await store.listMoments({
        workspaceId: WORKSPACE,
        limit: 100,
      });
      relay.addWrite(path, "new granter body");
      const refreshed = await reconcileStandaloneForTest({
        rootDir,
        workspaceId: WORKSPACE,
        relay: harness.relay,
        shareId: SHARE_ID,
        store,
        pull: harness.pullFor(target),
        pinnedSelector: { ...PINNED_SELECTOR, access: "edit" },
        recordRefusals: async () => undefined,
        ended: false,
      });
      if (!refreshed.ok) throw new Error(refreshed.errorMessage);

      expect(refreshed.excludedPaths).toEqual([path]);
      expect(refreshed.unjournalablePaths).toEqual([
        { path, reason: "oversized-text" },
      ]);
      expect(await readFile(join(rootDir, path), "utf8")).toBe(oversized);
      const after = await store.listMoments({
        workspaceId: WORKSPACE,
        limit: 100,
      });
      expect(after.moments).toHaveLength(before.moments.length + 1);

      const quiet = await reconcileStandaloneForTest({
        rootDir,
        workspaceId: WORKSPACE,
        relay: harness.relay,
        shareId: SHARE_ID,
        store,
        pull: harness.pullFor(target),
        pinnedSelector: { ...PINNED_SELECTOR, access: "edit" },
        recordRefusals: async () => undefined,
        ended: false,
      });
      if (!quiet.ok) throw new Error(quiet.errorMessage);
      expect(quiet.excludedPaths).toEqual([]);
      expect(quiet.unjournalablePaths).toEqual([
        { path, reason: "oversized-text" },
      ]);
      expect(await readFile(join(rootDir, path), "utf8")).toBe(oversized);
    } finally {
      await store.close();
    }
  });

  it("keeps a file renamed by case and back across pages", async (context) => {
    const rootDir = await createTestScratch("dohc-shared-view-desktop-");
    await writeFile(join(rootDir, "probe.md"), "");
    const ignoresCase = await stat(join(rootDir, "PROBE.md")).then(() => true, () => false);
    await rm(join(rootDir, "probe.md"));
    if (!ignoresCase) context.skip("this disk keeps case apart");
    const relay = new FakeShareRelay();
    relay.pageSize = 2;
    relay.addWrite("notes.md", "body\n");
    relay.addRename("notes.md", "Notes.md", "body\n");
    relay.addRename("Notes.md", "notes.md", "body\n");

    await refreshSharedViewOnce(daemonHarness(relay), {
      rootDir,
      workspaceId: WORKSPACE,
      shareId: SHARE_ID,
    });

    expect((await readdir(rootDir)).filter((name) => !name.startsWith("."))).toEqual(["notes.md"]);
    expect(await readFile(join(rootDir, "notes.md"), "utf8")).toBe("body\n");
  });

  it.for([
    { name: "Windows with colliding folder IDs", platform: "win32", ino: 42n, equalFiles: true },
    { name: "Linux with zero folder inodes", platform: "linux", ino: 0n, equalFiles: true },
    { name: "Linux with colliding folder IDs and distinct files", platform: "linux", ino: 42n, equalFiles: false },
  ])("deletes only its own normalization spelling on $name", async ({ platform: simulatedPlatform, ino, equalFiles }, context) => {
    const rootDir = await createTestScratch("dohc-shared-view-desktop-");
    const composed = "café/notes.md";
    const decomposed = composed.normalize("NFD");
    await mkdir(dirname(join(rootDir, decomposed)), { recursive: true });
    if (await stat(dirname(join(rootDir, composed))).then(() => true, () => false)) context.skip("this disk folds normalization");
    const relay = new FakeShareRelay();
    const harness = daemonHarness(relay);
    const refresh = () => refreshSharedViewOnce(harness, { rootDir, workspaceId: WORKSPACE, shareId: SHARE_ID });
    relay.addWrite(composed, "composed\n");
    relay.addWrite(decomposed, "decomposed\n");
    await refresh();
    expect(await readFile(join(rootDir, composed), "utf8")).toBe("composed\n");
    expect(await readFile(join(rootDir, decomposed), "utf8")).toBe("decomposed\n");
    const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    const files = new Set([join(rootDir, composed), join(rootDir, decomposed)]);
    const fileStat = vi.spyOn(fsPromises, "lstat").mockImplementation((async (path: Parameters<typeof lstat>[0], options?: unknown) => {
      const info = await actual.lstat(path, options as never);
      if (!equalFiles || !files.has(String(path))) return info;
      return new Proxy(info, {
        get(target, key, receiver) {
          if (key === "dev") return typeof target.dev === "bigint" ? 1n : 1;
          if (key === "ino") return typeof target.ino === "bigint" ? 42n : 42;
          if (key === "ctimeNs") return 1n;
          return Reflect.get(target, key, receiver);
        },
      });
    }) as typeof lstat);
    const parents = new Set([dirname(join(rootDir, composed)), dirname(join(rootDir, decomposed))]);
    const folderStat = vi.spyOn(fsPromises, "stat").mockImplementation((async (path: Parameters<typeof stat>[0], options?: unknown) => {
      const info = await actual.stat(path, options as never);
      if (!parents.has(String(path))) return info;
      return new Proxy(info, {
        get(target, key, receiver) {
          if (key === "dev") return typeof target.dev === "bigint" ? 1n : 1;
          if (key === "ino") return typeof target.ino === "bigint" ? ino : Number(ino);
          return Reflect.get(target, key, receiver);
        },
      });
    }) as typeof stat);
    const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
    Object.defineProperty(process, "platform", { ...platform, value: simulatedPlatform });
    try {
      relay.addDelete(composed);
      readdirCalls = [];
      await refresh();
      await expect(lstat(join(rootDir, composed))).rejects.toMatchObject({ code: "ENOENT" });
      expect(await readFile(join(rootDir, decomposed), "utf8")).toBe("decomposed\n");
      expect(readdirCalls).not.toEqual([]);
      if (!equalFiles) {
        expect(folderStat.mock.calls.filter(([path]) => parents.has(String(path)))).toEqual([]);
      } else if (simulatedPlatform === "linux") {
        expect(folderStat.mock.calls.map(([path]) => String(path))).toEqual(expect.arrayContaining([...parents]));
      }
    } finally {
      Object.defineProperty(process, "platform", platform);
      folderStat.mockRestore();
      fileStat.mockRestore();
    }
  });

  it("stops a delete with unknown stored names before removing another spelling's file", async (context) => {
    const view = await caseFoldingView(context, "edit");
    realpathOverride = (path) => path.startsWith(`${view.rootDir}${sep}`) ? path : null;
    try {
      view.relay.addWrite("notes.md", "old\n");
      await view.reconcile();
      view.relay.addWrite("Notes.md", "live\n");
      await view.reconcile();
      view.relay.addDelete("notes.md");
      const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
      const listing = vi.spyOn(fsPromises, "readdir").mockImplementation((async (path: Parameters<typeof readdir>[0], options?: unknown) => {
        if (String(path) === view.rootDir) return [];
        return actual.readdir(path, options as never);
      }) as typeof readdir);
      try {
        await expect(view.reconcile()).rejects.toThrow();
        expect(await readFile(join(view.rootDir, "notes.md"), "utf8")).toBe("old\n");
        expect((await readSharedViewProjectionDebt(view.rootDir, SHARE_ID)).pendingPaths).toContain("notes.md");
      } finally {
        listing.mockRestore();
      }
    } finally {
      await view.store.close();
    }
  });

  it("deletes only its own spelling where the disk keeps case apart", async (context) => {
    const rootDir = await createTestScratch("dohc-shared-view-desktop-");
    await writeFile(join(rootDir, "probe.md"), "");
    const ignoresCase = await stat(join(rootDir, "PROBE.md")).then(() => true, () => false);
    await rm(join(rootDir, "probe.md"));
    if (ignoresCase) context.skip("this disk ignores case");
    const relay = new FakeShareRelay();
    const harness = daemonHarness(relay);
    const refresh = () => refreshSharedViewOnce(harness, { rootDir, workspaceId: WORKSPACE, shareId: SHARE_ID });
    relay.addWrite("notes.md", "old\n");
    relay.addWrite("Notes.md", "live\n");
    await refresh();
    relay.addDelete("notes.md");
    await refresh();

    expect((await readdir(rootDir)).filter((name) => !name.startsWith("."))).toEqual(["Notes.md"]);
    expect(await readFile(join(rootDir, "Notes.md"), "utf8")).toBe("live\n");
  });

  it("hands a deleted owner's file to one held spelling and keeps holding the rest", async (context) => {
    const view = await caseFoldingView(context, "edit");
    try {
      view.relay.addWrite("notes.md", "n\n");
      view.relay.addWrite("Notes.md", "N\n");
      view.relay.addWrite("NOTES.md", "NN\n");
      await view.reconcile();
      view.relay.addDelete("notes.md");
      await view.reconcile();
      const before = await momentIds(view.store);
      const captured = await view.capture(["Notes.md"]);

      expect(captured.unjournalablePaths).toEqual([{ path: "Notes.md", reason: "spelling-collision", owner: "NOTES.md" }]);
      expect(await momentIds(view.store)).toEqual(before);
      expect(await view.head("Notes.md")).toBe("N\n");
      expect(await view.head("NOTES.md")).toBe("NN\n");
      expect(await view.names()).toEqual(["NOTES.md"]);
    } finally {
      await view.store.close();
    }
  });

  it("keeps a person's file apart beside a letter-case spelling after access narrows", async (context) => {
    const rootDir = await createTestScratch("dohc-shared-view-desktop-");
    await writeFile(join(rootDir, "probe.md"), "");
    const ignoresCase = await stat(join(rootDir, "PROBE.md")).then(() => true, () => false);
    await rm(join(rootDir, "probe.md"));
    if (ignoresCase) context.skip("this disk ignores case");
    const relay = new FakeShareRelay();
    const harness = daemonHarness(relay);
    const target = { workspaceId: WORKSPACE, rootPath: rootDir };
    const store = harness.openStore(target);
    const reconcile = async () => {
      const refreshed = await reconcileStandaloneForTest({
        rootDir, workspaceId: WORKSPACE, relay: harness.relay, shareId: SHARE_ID, store, pull: harness.pullFor(target),
        pinnedSelector: { ...PINNED_SELECTOR, access: "edit" }, recordRefusals: async () => undefined, ended: false,
      });
      if (!refreshed.ok) throw new Error(refreshed.errorMessage);
      return refreshed;
    };
    try {
      relay.addWrite("notes.md", "shared\n");
      await reconcile();
      await writeFile(join(rootDir, "Notes.md"), "mine\n");
      relay.addWrite("Notes.md", "theirs\n");
      const pulled = await reconcile();
      expect(pulled.unjournalablePaths).toEqual([{ path: "Notes.md", reason: "local-collision" }]);
      await expect(readCollisionRecordPaths(rootDir, SHARE_ID)).resolves.toEqual(new Set(["Notes.md"]));
      const before = await momentIds(store);
      const captured = await captureStandaloneShareViewDivergence({
        rootDir, workspaceId: WORKSPACE, store,
        pinnedSelector: { ...PINNED_SELECTOR, access: "view" }, shareId: SHARE_ID, ended: false, preservedPaths: ["Notes.md"],
      });

      expect(captured.unjournalablePaths).toEqual([{ path: "Notes.md", reason: "local-collision" }]);
      expect(captured.remainingPreservedPaths).toEqual(["Notes.md"]);
      await expect(readCollisionRecordPaths(rootDir, SHARE_ID)).resolves.toEqual(new Set(["Notes.md"]));
      const main = await store.ensureMainVersion({ workspaceId: WORKSPACE });
      expect((await store.readTextFile({ workspaceId: WORKSPACE, versionId: main.id, path: "Notes.md" }))?.text).toBe("theirs\n");
      expect((await store.readTextFile({ workspaceId: WORKSPACE, versionId: main.id, path: "notes.md" }))?.text).toBe("shared\n");
      expect(await readFile(join(rootDir, "Notes.md"), "utf8")).toBe("mine\n");
      expect(await momentIds(store)).toEqual(before);
    } finally {
      await store.close();
    }
  });

  it("repairs an absent pending overwrite without journaling a delete", async () => {
    const rootDir = await createTestScratch("dohc-shared-view-desktop-");
    const relay = new FakeShareRelay();
    const harness = daemonHarness(relay);
    const path = "docs/interrupted-overwrite.md";
    const target = { workspaceId: WORKSPACE, rootPath: rootDir };
    relay.addWrite(path, "moment one");
    await refreshSharedViewOnce(harness, {
      rootDir,
      workspaceId: WORKSPACE,
      shareId: SHARE_ID,
    });

    const store = harness.openStore(target);
    try {
      const main = await store.ensureMainVersion({ workspaceId: WORKSPACE });
      await store.writeTextFile({
        workspaceId: WORKSPACE,
        versionId: main.id,
        path,
        text: "moment two",
        metadata: { origin: "sync" },
      });
      await writePendingMaterializationPaths(rootDir, [path]);
      await rm(join(rootDir, path));
      const before = await momentIds(store);

      await expect(
        captureSharedViewLocalDivergence(
          rootDir,
          WORKSPACE,
          store,
          true,
          SHARE_ID,
        ),
      ).resolves.toEqual({
        capturedPaths: 0,
        repairedPaths: 1,
        unjournalablePaths: [],
      });
      expect(await readFile(join(rootDir, path), "utf8")).toBe("moment two");
      await expect(
        store.readTextFile({
          workspaceId: WORKSPACE,
          versionId: main.id,
          path,
        }),
      ).resolves.toMatchObject({ text: "moment two" });
      expect(await momentIds(store)).toEqual(before);
    } finally {
      await store.close();
    }
  });

  it("journals a third body that landed after an interrupted materialization", async () => {
    const rootDir = await createTestScratch("dohc-shared-view-desktop-");
    const relay = new FakeShareRelay();
    const harness = daemonHarness(relay);
    const path = "docs/third-body.md";
    const target = { workspaceId: WORKSPACE, rootPath: rootDir };
    relay.addWrite(path, "moment one");
    await refreshSharedViewOnce(harness, {
      rootDir,
      workspaceId: WORKSPACE,
      shareId: SHARE_ID,
    });

    const store = harness.openStore(target);
    try {
      const main = await store.ensureMainVersion({ workspaceId: WORKSPACE });
      await store.writeTextFile({
        workspaceId: WORKSPACE,
        versionId: main.id,
        path,
        text: "moment two",
        metadata: { origin: "sync" },
      });
      await writePendingMaterializationPaths(rootDir, [path]);
      await writeFile(join(rootDir, path), "moment three", "utf8");

      await expect(
        captureSharedViewLocalDivergence(
          rootDir,
          WORKSPACE,
          store,
          true,
          SHARE_ID,
        ),
      ).resolves.toEqual({
        capturedPaths: 1,
        repairedPaths: 0,
        unjournalablePaths: [],
      });
      await expect(
        store.readTextFile({
          workspaceId: WORKSPACE,
          versionId: main.id,
          path,
        }),
      ).resolves.toMatchObject({ text: "moment three" });
      expect(await readFile(join(rootDir, path), "utf8")).toBe("moment three");
      await expect(readPendingMaterializationPaths(rootDir)).resolves.toEqual(
        new Set(),
      );
    } finally {
      await store.close();
    }
  });

  it("quarantines a corrupt pending record and verifies every tracked path", async () => {
    const rootDir = await createTestScratch("dohc-shared-view-desktop-");
    const relay = new FakeShareRelay();
    const harness = daemonHarness(relay);
    const path = "docs/corrupt-sidecar.md";
    const target = { workspaceId: WORKSPACE, rootPath: rootDir };
    relay.addWrite(path, "moment one");
    await refreshSharedViewOnce(harness, {
      rootDir,
      workspaceId: WORKSPACE,
      shareId: SHARE_ID,
    });

    const store = harness.openStore(target);
    const errorLog = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    try {
      const main = await store.ensureMainVersion({ workspaceId: WORKSPACE });
      await store.writeTextFile({
        workspaceId: WORKSPACE,
        versionId: main.id,
        path,
        text: "moment two",
        metadata: { origin: "sync" },
      });
      const before = await momentIds(store);
      const pendingPath = join(
        await openedRecordsDir(rootDir),
        "pending-materialization.json",
      );
      await writeFile(pendingPath, "not json", "utf8");

      await expect(
        reconcileStandaloneForTest({
          rootDir,
          workspaceId: WORKSPACE,
          relay: harness.relay,
          shareId: SHARE_ID,
          store,
          pull: harness.pullFor(target),
          pinnedSelector: { ...PINNED_SELECTOR, access: "edit" },
          recordRefusals: async () => undefined,
          ended: false,
        }),
      ).resolves.toMatchObject({ status: "updated", changedPaths: 1 });

      expect(await readFile(join(rootDir, path), "utf8")).toBe("moment two");
      expect(await momentIds(store)).toEqual(before);
      expect(
        (await readdir(recordsDir(rootDir))).some((name) =>
          /^pending-materialization\.json\.invalid-\d+$/.test(name),
        ),
      ).toBe(true);
      await expect(lstat(pendingPath)).rejects.toMatchObject({
        code: "ENOENT",
      });
      expect(errorLog).toHaveBeenCalledWith(
        expect.stringContaining(pendingPath),
      );
    } finally {
      errorLog.mockRestore();
      await store.close();
    }
  });

  it("keeps a recorded local collision excluded from a later delete", async () => {
    const rootDir = await createTestScratch("dohc-shared-view-desktop-");
    const relay = new FakeShareRelay();
    const harness = daemonHarness(relay);
    const path = "docs/recipient-delete-collision.md";
    const target = { workspaceId: WORKSPACE, rootPath: rootDir };
    relay.addWrite("docs/seed.md", "seed");
    await refreshSharedViewOnce(harness, {
      rootDir,
      workspaceId: WORKSPACE,
      shareId: SHARE_ID,
    });
    await writeFile(join(rootDir, path), "recipient data", "utf8");
    relay.addWrite(path, "granter file");

    const store = harness.openStore(target);
    try {
      await reconcileStandaloneForTest({
        rootDir,
        workspaceId: WORKSPACE,
        relay: harness.relay,
        shareId: SHARE_ID,
        store,
        pull: harness.pullFor(target),
        pinnedSelector: { ...PINNED_SELECTOR, access: "edit" },
        recordRefusals: async () => undefined,
        ended: false,
      });
      await expect(
        readCollisionRecordPaths(rootDir, SHARE_ID),
      ).resolves.toEqual(new Set([path]));
      relay.addDelete(path);

      await expect(
        reconcileStandaloneForTest({
          rootDir,
          workspaceId: WORKSPACE,
          relay: harness.relay,
          shareId: SHARE_ID,
          store,
          pull: harness.pullFor(target),
          pinnedSelector: { ...PINNED_SELECTOR, access: "edit" },
          recordRefusals: async () => undefined,
          ended: false,
        }),
      ).resolves.toMatchObject({
        excludedPaths: [path],
        unjournalablePaths: [{ path, reason: "local-collision" }],
      });

      expect(await readFile(join(rootDir, path), "utf8")).toBe(
        "recipient data",
      );
      await rm(join(rootDir, path));
      await reconcileStandaloneForTest({
        rootDir,
        workspaceId: WORKSPACE,
        relay: harness.relay,
        shareId: SHARE_ID,
        store,
        pull: harness.pullFor(target),
        pinnedSelector: { ...PINNED_SELECTOR, access: "edit" },
        recordRefusals: async () => undefined,
        ended: false,
      });
      await expect(
        readCollisionRecordPaths(rootDir, SHARE_ID),
      ).resolves.toEqual(new Set());

      relay.addWrite(path, "granter re-add");
      await expect(
        reconcileStandaloneForTest({
          rootDir,
          workspaceId: WORKSPACE,
          relay: harness.relay,
          shareId: SHARE_ID,
          store,
          pull: harness.pullFor(target),
          pinnedSelector: { ...PINNED_SELECTOR, access: "edit" },
          recordRefusals: async () => undefined,
          ended: false,
        }),
      ).resolves.toMatchObject({ excludedPaths: [], unjournalablePaths: [] });
      expect(await readFile(join(rootDir, path), "utf8")).toBe(
        "granter re-add",
      );
    } finally {
      await store.close();
    }
  });

  it("resolves a recorded local collision without journaling a delete", async () => {
    const rootDir = await createTestScratch("dohc-shared-view-desktop-");
    const relay = new FakeShareRelay();
    const harness = daemonHarness(relay);
    const path = "docs/recipient-resolution.md";
    const target = { workspaceId: WORKSPACE, rootPath: rootDir };
    relay.addWrite("docs/seed.md", "seed");
    await refreshSharedViewOnce(harness, {
      rootDir,
      workspaceId: WORKSPACE,
      shareId: SHARE_ID,
    });
    await writeFile(join(rootDir, path), "recipient data", "utf8");
    relay.addWrite(path, "granter file");

    const store = harness.openStore(target);
    try {
      await reconcileStandaloneForTest({
        rootDir,
        workspaceId: WORKSPACE,
        relay: harness.relay,
        shareId: SHARE_ID,
        store,
        pull: harness.pullFor(target),
        pinnedSelector: { ...PINNED_SELECTOR, access: "edit" },
        recordRefusals: async () => undefined,
        ended: false,
      });
      await expect(
        readCollisionRecordPaths(rootDir, SHARE_ID),
      ).resolves.toEqual(new Set([path]));
      await rm(join(rootDir, path));
      const before = await momentIds(store);

      await reconcileStandaloneForTest({
        rootDir,
        workspaceId: WORKSPACE,
        relay: harness.relay,
        shareId: SHARE_ID,
        store,
        pull: harness.pullFor(target),
        pinnedSelector: { ...PINNED_SELECTOR, access: "edit" },
        recordRefusals: async () => undefined,
        ended: false,
      });

      await expect(
        readCollisionRecordPaths(rootDir, SHARE_ID),
      ).resolves.toEqual(new Set());
      expect(await readFile(join(rootDir, path), "utf8")).toBe("granter file");
      expect(await momentIds(store)).toEqual(before);

      // Simulate a crash after materialization succeeded but before capture
      // cleared the collision record.
      await recordCollisionPaths(rootDir, SHARE_ID, [path]);
      const beforeCrashRecovery = await momentIds(store);
      await expect(
        captureSharedViewLocalDivergence(
          rootDir,
          WORKSPACE,
          store,
          true,
          SHARE_ID,
        ),
      ).resolves.toEqual({
        capturedPaths: 0,
        repairedPaths: 1,
        unjournalablePaths: [],
      });
      await expect(
        readCollisionRecordPaths(rootDir, SHARE_ID),
      ).resolves.toEqual(new Set());
      expect(await readFile(join(rootDir, path), "utf8")).toBe("granter file");
      expect(await momentIds(store)).toEqual(beforeCrashRecovery);
    } finally {
      await store.close();
    }
  });

  it("quarantines a corrupt collision record and accepts a clean write", async () => {
    const rootDir = await createTestScratch("dohc-shared-view-desktop-");
    const relay = new FakeShareRelay();
    const harness = daemonHarness(relay);
    const path = "docs/corrupt-collision.md";
    const target = { workspaceId: WORKSPACE, rootPath: rootDir };
    relay.addWrite("docs/seed.md", "seed");
    await refreshSharedViewOnce(harness, {
      rootDir,
      workspaceId: WORKSPACE,
      shareId: SHARE_ID,
    });
    await writeFile(join(rootDir, path), "recipient data", "utf8");
    relay.addWrite(path, "granter file");
    const collisionPath = join(recordsDir(rootDir), "share-collision-record.json");
    const store = harness.openStore(target);
    const errorLog = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    try {
      await reconcileStandaloneForTest({
        rootDir,
        workspaceId: WORKSPACE,
        relay: harness.relay,
        shareId: SHARE_ID,
        store,
        pull: harness.pullFor(target),
        pinnedSelector: { ...PINNED_SELECTOR, access: "edit" },
        recordRefusals: async () => undefined,
        ended: false,
      });
      await expect(
        readCollisionRecordPaths(rootDir, SHARE_ID),
      ).resolves.toEqual(new Set([path]));
      await writeFile(collisionPath, "not json", "utf8");

      await expect(
        captureSharedViewLocalDivergence(
          rootDir,
          WORKSPACE,
          store,
          true,
          SHARE_ID,
        ),
      ).rejects.toThrow("could not read");
      await expect(
        readCollisionRecordPaths(rootDir, SHARE_ID),
      ).rejects.toThrow("Invalid share collision record.");
      expect(await readFile(collisionPath, "utf8")).toBe("not json");
      await expect(reconcileStandaloneForTest({
        rootDir, workspaceId: WORKSPACE, relay: harness.relay, shareId: SHARE_ID,
        store, pull: harness.pullFor(target), pinnedSelector: { ...PINNED_SELECTOR, access: "edit" },
        recordRefusals: async () => undefined, ended: false,
      })).resolves.toMatchObject({ collisionRecordQuarantined: true });
      await expect(readCollisionRecordPaths(rootDir, SHARE_ID)).resolves.toEqual(new Set([path]));
      expect(
        (await readdir(recordsDir(rootDir))).some((name) =>
          /^share-collision-record\.json\.invalid-\d+$/.test(name),
        ),
      ).toBe(true);
      await rename(join(rootDir, path), join(rootDir, "kept.md"));
      await reconcileStandaloneForTest({
        rootDir, workspaceId: WORKSPACE, relay: harness.relay, shareId: SHARE_ID,
        store, pull: harness.pullFor(target), pinnedSelector: { ...PINNED_SELECTOR, access: "edit" },
        recordRefusals: async () => undefined, ended: false,
      });
      await expect(lstat(collisionPath)).rejects.toMatchObject({
        code: "ENOENT",
      });
      expect(errorLog).toHaveBeenCalledWith(
        expect.stringContaining(collisionPath),
      );

      await recordCollisionPaths(rootDir, SHARE_ID, ["docs/fresh.md"]);
      await expect(
        readCollisionRecordPaths(rootDir, SHARE_ID),
      ).resolves.toEqual(new Set(["docs/fresh.md"]));
    } finally {
      errorLog.mockRestore();
      await store.close();
    }
  });

  it("imports a dropped folder through its files, beside a held folder of its name", async () => {
    const rootDir = await createTestScratch("dohc-shared-view-desktop-");
    const sourceRoot = await createTestScratch("dohc-shared-view-desktop-");
    const trip = join(sourceRoot, "Trip");
    await mkdir(join(trip, "sub"), { recursive: true });
    await mkdir(join(trip, "empty"), { recursive: true });
    await writeFile(join(trip, "plan.md"), "plan\n", "utf8");
    await writeFile(join(trip, "sub", "notes.md"), "notes\n", "utf8");
    await writeFile(join(trip, ".DS_Store"), "finder", "utf8");
    const relay = new FakeShareRelay();
    const harness = daemonHarness(relay);
    relay.addWrite("docs/Trip/seed.md", "seed");
    await refreshSharedViewOnce(harness, {
      rootDir,
      workspaceId: WORKSPACE,
      shareId: SHARE_ID,
    });
    // Only the store holds the folder now, so only the store can say its
    // name is taken.
    await rm(join(rootDir, "docs", "Trip"), { recursive: true });

    const store = harness.openStore({ workspaceId: WORKSPACE, rootPath: rootDir });
    try {
      const outcome = await applyShareViewFileImport({
        workspaceId: WORKSPACE,
        rootPath: rootDir,
        shareViewStore: () => store,
        absolutePaths: [trip],
        screenAgainstRoots: [rootDir],
        targetDir: "docs",
      });
      expect({ ...outcome, imported: outcome.imported.sort() }).toEqual({
        imported: ["docs/Trip (2)/plan.md", "docs/Trip (2)/sub/notes.md"],
        skipped: 0,
      });
      await expect(
        readFile(join(rootDir, "docs", "Trip (2)", "sub", "notes.md"), "utf8"),
      ).resolves.toBe("notes\n");
      const main = await store.ensureMainVersion({ workspaceId: WORKSPACE });
      const held = await store.listTextFileMetadata({
        workspaceId: WORKSPACE,
        versionId: main.id,
      });
      expect(held.map((file) => file.path).sort()).toEqual([
        "docs/Trip (2)/plan.md",
        "docs/Trip (2)/sub/notes.md",
        "docs/Trip/seed.md",
      ]);
    } finally {
      await store.close();
    }
  });

  it("refuses a drop holding a file the grant refuses before any file lands", async () => {
    const drop = await dropIntoDocs(async (sourceRoot) => {
      await writeFile(join(sourceRoot, "first.md"), "first\n", "utf8");
      await mkdir(join(sourceRoot, "Trip"));
      await writeFile(join(sourceRoot, "Trip", "plan.md"), "plan\n", "utf8");
      await writeFile(join(sourceRoot, "Trip", ".env"), "TOKEN=1\n", "utf8");
      return [join(sourceRoot, "first.md"), join(sourceRoot, "Trip")];
    });
    try {
      await expect(drop.importing).rejects.toThrow("docs/Trip/.env");
      expect(await drop.storePaths()).toEqual(["docs/seed.md"]);
    } finally {
      await drop.close();
    }
  });

  it("checks the final collision names against the grant before any file lands", async () => {
    const drop = await dropIntoDocs(async (sourceRoot) => {
      await writeFile(join(sourceRoot, "ok.md"), "ok\n", "utf8");
      await writeFile(join(sourceRoot, "notes.md"), "notes\n", "utf8");
      return [join(sourceRoot, "ok.md"), join(sourceRoot, "notes.md")];
    }, { held: "docs/notes.md", grantedPaths: ["docs/ok.md", "docs/notes.md"] });
    try {
      await expect(drop.importing).rejects.toThrow("docs/notes (2).md");
      expect(await drop.storePaths()).toEqual(["docs/notes.md"]);
    } finally {
      await drop.close();
    }
  });

  it("checks a dropped file's folder again after opening it", async () => {
    const secrets = await createTestScratch("dohc-shared-view-secrets-");
    await writeFile(join(secrets, "a.md"), "SECRET\n", "utf8");
    const secret = await lstat(join(secrets, "a.md"), { bigint: true });
    let trip = "";
    afterDropScreen = async (screened) => {
      const entry = screened.usable[0]!.entries!.find((candidate) => candidate.path === "sub/a.md")!;
      entry.identity = { dev: secret.dev, ino: secret.ino };
      beforeOpen = async (path) => {
        if (path !== join(trip, "sub", "a.md")) return;
        beforeOpen = null;
        await rm(join(trip, "sub"), { recursive: true });
        await symlink(secrets, join(trip, "sub"), "dir");
      };
    };
    try {
      const drop = await dropIntoDocs(async (sourceRoot) => {
        trip = join(sourceRoot, "Trip");
        await mkdir(join(trip, "sub"), { recursive: true });
        await writeFile(join(trip, "sub", "a.md"), "a\n", "utf8");
        return [trip];
      });
      try {
        await expect(drop.importing).rejects.toThrow("sub changed after dohc checked it.");
        expect(await drop.storePaths()).toEqual(["docs/seed.md"]);
      } finally {
        await drop.close();
      }
    } finally {
      afterDropScreen = null;
      beforeOpen = null;
    }
  });

  it("recovers a crashed folder delete's children, but leaves the emptied folder until something prunes it", async () => {
    const rootDir = await createTestScratch("dohc-shared-view-desktop-");
    const relay = new FakeShareRelay();
    const harness = daemonHarness(relay);
    const paths = ["docs/plans/one.md", "docs/plans/two.md"];
    relay.addWrite(paths[0], "one");
    relay.addWrite(paths[1], "two");
    await refreshSharedViewOnce(harness, {
      rootDir,
      workspaceId: WORKSPACE,
      shareId: SHARE_ID,
    });

    const store = harness.openStore({
      workspaceId: WORKSPACE,
      rootPath: rootDir,
    });
    try {
      let deletesDone = 0;
      const failingStore: typeof store = {
        ...store,
        async deleteTextFile(input) {
          const result = await store.deleteTextFile(input);
          deletesDone += 1;
          return result;
        },
        async ensureMainVersion(input) {
          // Both children are gone from the store by the time materialization
          // asks for the main version, which is the first thing it does — so
          // this fails materialization before its rm ever runs, and only
          // after the store mutation applyShareViewPathDelete makes is already
          // done.
          if (deletesDone >= paths.length) {
            throw Object.assign(new Error("EBUSY: projection delete failed"), {
              code: "EBUSY",
            });
          }
          return await store.ensureMainVersion(input);
        },
      };

      await expect(
        applyShareViewPathDelete({
          workspaceId: WORKSPACE,
          rootPath: rootDir,
          shareViewStore: () => failingStore,
          relativePath: "docs/plans",
        }),
      ).rejects.toThrow("EBUSY: projection delete failed");

      // What applyShareViewPathDelete actually left behind: both children gone
      // from the store, both children (not the folder path) marked pending,
      // disk untouched because materialization died before its rm.
      await expect(readPendingMaterializationPaths(rootDir)).resolves.toEqual(
        new Set(paths),
      );
      await expect(readFile(join(rootDir, paths[0]), "utf8")).resolves.toBe(
        "one",
      );
      await expect(readFile(join(rootDir, paths[1]), "utf8")).resolves.toBe(
        "two",
      );

      const outcome = await captureSharedViewLocalDivergence(
        rootDir,
        WORKSPACE,
        store,
        true,
        SHARE_ID,
      );
      expect(outcome.repairedPaths).toBe(2);
      expect(outcome.unjournalablePaths).toEqual([]);
      for (const path of paths) {
        await expect(stat(join(rootDir, path))).rejects.toMatchObject({
          code: "ENOENT",
        });
      }
      await expect(readPendingMaterializationPaths(rootDir)).resolves.toEqual(
        new Set(),
      );

      // The documented residue: recovery completed each child but never
      // touched their now-empty parent, unlike an uninterrupted delete's
      // single recursive rm on the folder path.
      expect(await readdir(join(rootDir, "docs", "plans"))).toEqual([]);
    } finally {
      await store.close();
    }
  });

  it("replaces a pull marker symlink without writing through it", async () => {
    const rootDir = await createTestScratch("dohc-shared-view-desktop-");
    const outsideDir = await createTestScratch("dohc-shared-view-desktop-");
    const externalPath = join(outsideDir, "external.txt");
    const markerPath = join(
      await openedRecordsDir(rootDir),
      "pull-in-flight.marker",
    );
    const original = Buffer.from("outside authority stays unchanged", "utf8");
    await writeFile(externalPath, original);
    await symlink(externalPath, markerPath, "file");

    let externalAfterWrite: Buffer | null = null;
    let markerWasSymlinkAfterWrite: boolean | null = null;
    const emptyPull: PullShareViewResult = {
      fetched: 0,
      applied: 0,
      skipped: 0,
      nextCursor: 0,
      refusalCount: 0,
      refusals: [],
      changedPaths: [],
      commitCursor: async () => undefined,
    };

    await refreshSharedViewOnceWithPull({
      rootDir,
      workspaceId: WORKSPACE,
      relay: new FakeShareRelay().connection(),
      shareId: SHARE_ID,
      pinnedSelector: PINNED_SELECTOR,
      recordRefusals: async () => undefined,
      store: stubStore(async () => ({ text: "unused" })),
      trackPendingMaterialization: true,
      pull: async () => {
        externalAfterWrite = await readFile(externalPath);
        markerWasSymlinkAfterWrite = (await lstat(markerPath)).isSymbolicLink();
        return emptyPull;
      },
    });

    expect(externalAfterWrite).toEqual(original);
    expect(markerWasSymlinkAfterWrite).toBe(false);
    await expect(readFile(externalPath)).resolves.toEqual(original);
    await expect(lstat(markerPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("leaves a pull marker under a substituted .dohc/local untouched", async () => {
    const rootDir = await createTestScratch("dohc-shared-view-desktop-");
    const outsideDir = await createTestScratch("dohc-shared-view-desktop-");
    const localDir = join(rootDir, ".dohc", "local");
    const markerName = join("share-refresh", "pull-in-flight.marker");
    const markerPath = join(localDir, markerName);
    const published = new Error("leave the published marker in place");
    await openedView(rootDir);

    await expect(
      refreshSharedViewOnceWithPull({
        rootDir,
        workspaceId: WORKSPACE,
        relay: new FakeShareRelay().connection(),
        shareId: SHARE_ID,
        pinnedSelector: PINNED_SELECTOR,
        recordRefusals: async () => undefined,
        store: stubStore(async () => ({ text: "unused" })),
        trackPendingMaterialization: true,
        pull: async () => {
          throw published;
        },
      }),
    ).rejects.toBe(published);
    await expect(lstat(markerPath)).resolves.toBeTruthy();

    await rm(localDir, { force: true, recursive: true });
    await mkdir(join(outsideDir, "share-refresh"));
    await writeFile(join(outsideDir, markerName), "external marker", "utf8");
    await symlink(
      outsideDir,
      localDir,
      process.platform === "win32" ? "junction" : "dir",
    );

    // dohc trusts nothing under a linked `.dohc/local`, so the view reads as
    // not current, and nothing there is removed.
    await expect(readSharedViewProjectionDebt(rootDir, SHARE_ID)).rejects.toThrow(
      /\.dohc\/local is a link/,
    );
    await expect(clearPullInFlightMarker(rootDir)).rejects.toBeInstanceOf(
      LocalStateUnavailableError,
    );

    await expect(
      readFile(join(outsideDir, markerName), "utf8"),
    ).resolves.toBe("external marker");
  });

  it("preserves an ambiguous edit while recovering an interrupted pull", async () => {
    const rootDir = await createTestScratch("dohc-shared-view-desktop-");
    const relay = new FakeShareRelay();
    const harness = daemonHarness(relay);
    const stalePath = "docs/stale-projection.md";
    const editedPath = "docs/real-edit.md";
    const target = { workspaceId: WORKSPACE, rootPath: rootDir };
    relay.addWrite(stalePath, "moment A");
    relay.addWrite(editedPath, "original edit body");
    await refreshSharedViewOnce(harness, {
      rootDir,
      workspaceId: WORKSPACE,
      shareId: SHARE_ID,
    });
    await writeFile(join(rootDir, editedPath), "recipient edit", "utf8");

    const store = harness.openStore(target);
    try {
      const main = await store.ensureMainVersion({ workspaceId: WORKSPACE });
      const preTrackedPaths = new Set([stalePath, editedPath]);
      vi.spyOn(preTrackedPaths, "has").mockImplementation(() => {
        throw new Error("simulated crash after pull");
      });
      const interruptedInput = {
        rootDir,
        workspaceId: WORKSPACE,
        relay: harness.relay,
        shareId: SHARE_ID,
        store,
        pinnedSelector: { ...PINNED_SELECTOR, access: "edit" },
        recordRefusals: async () => undefined,
        trackPendingMaterialization: true,
        preTrackedPaths,
        pull: async (): Promise<PullShareViewResult> => {
          await store.writeTextFile({
            workspaceId: WORKSPACE,
            versionId: main.id,
            path: stalePath,
            text: "moment B",
            metadata: { origin: "sync" },
          });
          return {
            fetched: 1,
            applied: 1,
            skipped: 0,
            nextCursor: 3,
            refusalCount: 0,
            refusals: [],
            changedPaths: [
              { path: stalePath, operation: "write", contentKind: "text" },
            ],
            commitCursor: async () => undefined,
          };
        },
      };

      await expect(
        refreshSharedViewOnceWithPull(
          interruptedInput as Parameters<
            typeof refreshSharedViewOnceWithPull
          >[0],
        ),
      ).rejects.toThrow("simulated crash after pull");
      const beforeRecovery = new Set(await momentIds(store));

      await expect(
        reconcileStandaloneForTest({
          rootDir,
          workspaceId: WORKSPACE,
          relay: harness.relay,
          shareId: SHARE_ID,
          store,
          pull: harness.pullFor(target),
          pinnedSelector: { ...PINNED_SELECTOR, access: "edit" },
          recordRefusals: async () => undefined,
          ended: false,
        }),
      ).resolves.toMatchObject({
        status: "updated",
        changedPaths: 1,
        unjournalablePaths: [
          { path: editedPath, reason: "local-collision" },
        ],
      });

      expect(await readFile(join(rootDir, stalePath), "utf8")).toBe("moment B");
      await expect(
        store.readTextFile({
          workspaceId: WORKSPACE,
          versionId: main.id,
          path: editedPath,
        }),
      ).resolves.toMatchObject({ text: "original edit body" });
      expect(await readFile(join(rootDir, editedPath), "utf8")).toBe(
        "recipient edit",
      );
      const addedMoments = (
        await store.listMoments({ workspaceId: WORKSPACE, limit: 200 })
      ).moments.filter((moment) => !beforeRecovery.has(moment.id));
      expect(addedMoments).toHaveLength(0);
    } finally {
      await store.close();
    }
  });

  it("preserves an earlier captured edit when the next store write fails", async () => {
    const rootDir = await createTestScratch("dohc-shared-view-desktop-");
    const relay = new FakeShareRelay();
    const harness = daemonHarness(relay);
    const firstPath = "docs/a-captured-first.md";
    const failedPath = "docs/z-capture-fails.md";
    const target = { workspaceId: WORKSPACE, rootPath: rootDir };
    relay.addWrite(firstPath, "first original");
    relay.addWrite(failedPath, "second original");
    await refreshSharedViewOnce(harness, {
      rootDir,
      workspaceId: WORKSPACE,
      shareId: SHARE_ID,
    });
    await writeFile(join(rootDir, firstPath), "first local edit", "utf8");
    await writeFile(join(rootDir, failedPath), "second local edit", "utf8");

    const store = harness.openStore(target);
    const failingStore: typeof store = {
      ...store,
      async writeTextFile(input) {
        if (input.path === failedPath)
          throw new Error("engine store unavailable");
        return await store.writeTextFile(input);
      },
    };
    try {
      await expect(
        captureStandaloneShareViewRefresh({
          rootDir,
          workspaceId: WORKSPACE,
          store: failingStore,
          pinnedSelector: { ...PINNED_SELECTOR, access: "edit" },
          shareId: SHARE_ID,
          ended: false,
        }),
      ).resolves.toEqual({
        ok: false,
        changedPaths: 1,
        errorMessage: "engine store unavailable",
      });
      await expect(
        store.readTextFile({
          workspaceId: WORKSPACE,
          versionId: "main",
          path: firstPath,
        }),
      ).resolves.toMatchObject({ text: "first local edit" });
      await expect(
        store.readTextFile({
          workspaceId: WORKSPACE,
          versionId: "main",
          path: failedPath,
        }),
      ).resolves.toMatchObject({ text: "second original" });
    } finally {
      await store.close();
    }
  });

  it("reports and preserves a symlink that replaced a tracked file", async () => {
    const rootDir = await createTestScratch("dohc-shared-view-desktop-");
    const outsideRoot = await createTestScratch("dohc-shared-view-desktop-");
    const relay = new FakeShareRelay();
    const harness = daemonHarness(relay);
    const path = "docs/linked.md";
    const outside = join(outsideRoot, "foreign.md");
    relay.addWrite(path, "tracked body");
    await refreshSharedViewOnce(harness, {
      rootDir,
      workspaceId: WORKSPACE,
      shareId: SHARE_ID,
    });
    await writeFile(outside, "foreign body", "utf8");
    await rm(join(rootDir, path));
    await symlink(outside, join(rootDir, path), "file");

    const store = harness.openStore({
      workspaceId: WORKSPACE,
      rootPath: rootDir,
    });
    try {
      const before = await store.listMoments({
        workspaceId: WORKSPACE,
        limit: 100,
      });
      await expect(
        captureSharedViewLocalDivergence(
          rootDir,
          WORKSPACE,
          store,
          true,
          SHARE_ID,
        ),
      ).resolves.toEqual({
        capturedPaths: 0,
        repairedPaths: 0,
        unjournalablePaths: [{ path, reason: "non-file-replacement" }],
      });
      const main = await store.ensureMainVersion({ workspaceId: WORKSPACE });
      await expect(
        store.readTextFile({
          workspaceId: WORKSPACE,
          versionId: main.id,
          path,
        }),
      ).resolves.toMatchObject({ text: "tracked body" });
      const after = await store.listMoments({
        workspaceId: WORKSPACE,
        limit: 100,
      });
      expect(after.moments.map((moment) => moment.id)).toEqual(
        before.moments.map((moment) => moment.id),
      );

      relay.addWrite(path, "new granter body");
      await expect(
        reconcileStandaloneForTest({
          rootDir,
          workspaceId: WORKSPACE,
          relay: harness.relay,
          shareId: SHARE_ID,
          store,
          pull: harness.pullFor({ workspaceId: WORKSPACE, rootPath: rootDir }),
          pinnedSelector: { ...PINNED_SELECTOR, access: "edit" },
          recordRefusals: async () => undefined,
          ended: false,
        }),
      ).resolves.toMatchObject({
        excludedPaths: [path],
        unjournalablePaths: [{ path, reason: "non-file-replacement" }],
      });
      expect((await lstat(join(rootDir, path))).isSymbolicLink()).toBe(true);
      expect(await readFile(outside, "utf8")).toBe("foreign body");
    } finally {
      await store.close();
    }
  });

  it("pulls, materializes to disk, and reports honest statuses across refreshes", async () => {
    const rootDir = await createTestScratch("dohc-shared-view-desktop-");
    const relay = new FakeShareRelay();
    const harness = daemonHarness(relay);
    relay.addWrite("docs/a.md", "first body");
    relay.addWrite("docs/nested/deep.md", "deep body");

    const first = await refreshSharedViewOnce(harness, {
      rootDir,
      workspaceId: WORKSPACE,
      shareId: SHARE_ID,
    });
    expect(first).toEqual({
      status: "updated",
      changedPaths: 2,
      excludedPaths: [],
      unjournalablePaths: [],
      refusedOps: 0,
      refusedDetail: null,
    });
    expect(await readFile(join(rootDir, "docs/a.md"), "utf8")).toBe(
      "first body",
    );
    expect(await readFile(join(rootDir, "docs/nested/deep.md"), "utf8")).toBe(
      "deep body",
    );
    // The cursor moved because refreshSharedViewOnce committed it through
    // sync.commitCursor — the only thing that advances it. Without this the
    // "unchanged" assertion below would pass on a pull that simply forgot to
    // ask for the ops again.
    expect(harness.transport.committedCursor(WORKSPACE)).toBe(2);

    const idle = await refreshSharedViewOnce(harness, {
      rootDir,
      workspaceId: WORKSPACE,
      shareId: SHARE_ID,
    });
    expect(idle).toEqual({
      status: "unchanged",
      changedPaths: 0,
      excludedPaths: [],
      unjournalablePaths: [],
      refusedOps: 0,
      refusedDetail: null,
    });

    relay.addWrite("docs/a.md", "updated body");
    relay.addDelete("docs/nested/deep.md");
    const second = await refreshSharedViewOnce(harness, {
      rootDir,
      workspaceId: WORKSPACE,
      shareId: SHARE_ID,
    });
    expect(second).toEqual({
      status: "updated",
      changedPaths: 2,
      excludedPaths: [],
      unjournalablePaths: [],
      refusedOps: 0,
      refusedDetail: null,
    });
    expect(await readFile(join(rootDir, "docs/a.md"), "utf8")).toBe(
      "updated body",
    );
    await expect(
      stat(join(rootDir, "docs/nested/deep.md")),
    ).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(harness.transport.committedCursor(WORKSPACE)).toBe(4);

    // Revocation: the next refresh reports "ended" and the local files stay.
    relay.ended = true;
    const ended = await refreshSharedViewOnce(harness, {
      rootDir,
      workspaceId: WORKSPACE,
      shareId: SHARE_ID,
    });
    expect(ended).toEqual({
      status: "ended",
      changedPaths: 0,
      excludedPaths: [],
      unjournalablePaths: [],
      refusedOps: 0,
      refusedDetail: null,
    });
    expect(await readFile(join(rootDir, "docs/a.md"), "utf8")).toBe(
      "updated body",
    );

    // Provable migration: the pull really went through the daemon share RPC.
    // (That no legacy store was built is structural here — this file has no
    // reference to the legacy TypeScript engine at all.)
    expect(
      harness.transport.requests.map((request) => request.method),
    ).toContain("share.view.pull");
  });

  it("leaves the existing projection intact when the content read fails", async () => {
    const rootDir = await createTestScratch("dohc-shared-view-desktop-");
    const target = join(rootDir, "docs/a.md");
    await materializeSharedViewPaths(
      rootDir,
      WORKSPACE,
      [{ path: "docs/a.md", operation: "write", contentKind: "text" }],
      stubStore(async () => ({ text: "good body" })),
    );
    expect(await readFile(target, "utf8")).toBe("good body");

    await expect(
      materializeSharedViewPaths(
        rootDir,
        WORKSPACE,
        [{ path: "docs/a.md", operation: "write", contentKind: "text" }],
        stubStore(async () => {
          throw new Error("over-cap text body");
        }),
      ),
    ).rejects.toThrow(/over-cap text body/);

    expect(await readFile(target, "utf8")).toBe("good body");
  });

  it("refuses to materialize a path that escapes the workspace root", async () => {
    const rootDir = await createTestScratch("dohc-shared-view-desktop-");
    await expect(
      materializeSharedViewPaths(
        rootDir,
        WORKSPACE,
        [{ path: "../escape.md", operation: "write", contentKind: "text" }],
        // The refusal happens before any content read, so a store whose
        // readTextFile throws still yields the escape error. It is not before
        // every store call — `ensureMainVersion` does run first; making that
        // throw changes the error, which is how this was checked rather than
        // assumed.
        stubStore(async () => {
          throw new Error("stubStore: must not be read for an escaping path");
        }),
      ),
    ).rejects.toThrow(/escapes the workspace/);
  });

  const damagedPins: Array<[string, unknown]> = [
    ["absent", undefined],
    ["empty version", { paths: [], versionId: "", access: "view" }],
  ];
  for (const [label, pinnedSelector] of damagedPins) {
    it(`refuses to pull when the pinned selector is ${label}`, async () => {
      const rootDir = await createTestScratch("dohc-shared-view-desktop-");
      const relay = new FakeShareRelay();
      const harness = daemonHarness(relay);
      relay.addWrite("docs/a.md", "body the relay must not get to send");
      let pulls = 0;

      await expect(
        refreshSharedViewOnceWithPull({
          rootDir,
          workspaceId: WORKSPACE,
          relay: harness.relay,
          shareId: SHARE_ID,
          store: harness.openStore({
            workspaceId: WORKSPACE,
            rootPath: rootDir,
          }),
          pinnedSelector,
          recordRefusals: async () => undefined,
          pull: async (input) => {
            pulls += 1;
            return await harness.pullFor({
              workspaceId: WORKSPACE,
              rootPath: rootDir,
            })(input);
          },
        }),
      ).rejects.toBeInstanceOf(SharePinInvalidError);

      expect(
        pulls,
        `reading a ${label} pin as a grant pulls against a scope the relay never issued`,
      ).toBe(0);
      await expect(stat(join(rootDir, "docs/a.md"))).rejects.toMatchObject({
        code: "ENOENT",
      });
      await harness.closeAll();
    });

  }
});

describe("share-refresh records in .dohc/local", () => {
  const RECORDS = [
    "pull-in-flight.marker",
    "pending-materialization.json",
    "share-collision-record.json",
  ];

  // A view share whose granter added a file where the person already had
  // their own. The refresh recorded the collision and kept the person's file.
  async function collidedView() {
    const rootDir = await createTestScratch("dohc-shared-view-records-");
    const relay = new FakeShareRelay();
    const harness = daemonHarness(relay);
    const path = "docs/mine.md";
    const target = { workspaceId: WORKSPACE, rootPath: rootDir };
    relay.addWrite("docs/seed.md", "seed");
    await refreshSharedViewOnce(harness, {
      rootDir,
      workspaceId: WORKSPACE,
      shareId: SHARE_ID,
    });
    await writeFile(join(rootDir, path), "my own file", "utf8");
    relay.addWrite(path, "granter file");
    const store = harness.openStore(target);
    // As ShareViewFiles refreshes: capture, then pull, each failure an outcome.
    const refresh = (
      pull: Parameters<typeof refreshSharedViewOnceWithPull>[0]["pull"] =
        harness.pullFor(target),
      access: "view" | "edit" = "view",
    ) =>
      withShareViewRefreshLifecycleLock(rootDir, async () => {
        const pinnedSelector = { ...PINNED_SELECTOR, access };
        const captured = await captureStandaloneShareViewRefresh({
          rootDir,
          workspaceId: WORKSPACE,
          store,
          pinnedSelector,
          shareId: SHARE_ID,
          ended: false,
        });
        if (!captured.ok) return captured;
        return reconcileStandaloneShareView({
          rootDir,
          workspaceId: WORKSPACE,
          relay: harness.relay,
          shareId: SHARE_ID,
          store,
          pull,
          pinnedSelector,
          recordRefusals: async () => undefined,
          captured: captured.captured,
        });
      });
    await expect(refresh()).resolves.toMatchObject({
      ok: true,
      unjournalablePaths: [{ path, reason: "local-collision" }],
    });
    const collisionRecord = join(recordsDir(rootDir), "share-collision-record.json");
    return { rootDir, relay, harness, store, target, path, refresh, collisionRecord };
  }
  const NOT_OPENED_WORDS =
    "dohc did not update these shared files because the workspace has not finished opening. Try again when it opens.";

  // On Windows dohc reads `.dohc/local` only while one open of the view holds
  // it throughout. This ends that open as dohc opens `name` there, by closing
  // the view or by starting a new open of it, while `armed`.
  function openEndsWhileReading(rootDir: string, name: string, how: "close" | "rebind") {
    const bindings = [{ localStateReady: true }];
    readLocalStateFrom({
      currentBinding: (view) =>
        closedViews.has(view.rootPath) ? null : view.rootPath === rootDir ? bindings.at(-1)! : OPENED,
      localStateOpenAt: async (rootPath) => {
        if (closedViews.has(rootPath)) return null;
        const at = bindings.length;
        return { current: () => at === bindings.length && !closedViews.has(rootPath) };
      },
    });
    const record = join(recordsDir(rootDir), name);
    const trip = { armed: true, ended: 0 };
    beforeOpen = async (path) => {
      if (!trip.armed || path !== record) return;
      trip.armed = false;
      trip.ended += 1;
      if (how === "close") closedViews.add(rootDir);
      else bindings.push({ localStateReady: true });
    };
    return trip;
  }

  it("keeps the unreadable saved list when its replacement cannot be written", async () => {
    const view = await collidedView();
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      await writeFile(view.collisionRecord, "not json", "utf8");
      failRenameToPathOnce = { path: view.collisionRecord, error: new Error("replacement unavailable") };
      await expect(view.refresh()).resolves.toMatchObject({ ok: false, changedPaths: 0, errorKind: "collision-record" });
      expect(await readFile(view.collisionRecord, "utf8")).toBe("not json");
      expect(await readFile(join(view.rootDir, view.path), "utf8")).toBe("my own file");
      await expect(view.refresh()).resolves.toMatchObject({
        ok: true, unjournalablePaths: [{ path: view.path, reason: "local-collision" }],
      });
    } finally {
      failRenameToPathOnce = null;
      errorLog.mockRestore();
      await view.store.close();
    }
  });

  it("writes each record in .dohc/local/share-refresh for this user only", async () => {
    const view = await collidedView();
    try {
      const seen: string[][] = [];
      const modes: number[] = [];
      view.relay.addWrite("docs/new.md", "new");
      await expect(
        view.refresh(async (input) => {
          const pulled = await view.harness.pullFor(view.target)(input);
          await input.recordChangedPaths?.(["docs/new.md"]);
          const names = await readdir(recordsDir(view.rootDir));
          seen.push(names);
          for (const name of names) {
            modes.push((await stat(join(recordsDir(view.rootDir), name))).mode & 0o777);
          }
          return pulled;
        }),
      ).resolves.toMatchObject({ ok: true });
      // The pull ran with its marker and its pending paths beside the
      // collision record, each this user's alone.
      expect(seen).toEqual([RECORDS.slice().sort()]);
      if (process.platform !== "win32") {
        expect(modes).toEqual([0o600, 0o600, 0o600]);
        expect((await stat(recordsDir(view.rootDir))).mode & 0o777).toBe(0o700);
      }
      // A finished refresh leaves only the collision it still protects.
      expect(await readdir(recordsDir(view.rootDir))).toEqual([
        "share-collision-record.json",
      ]);
      expect(await readFile(view.collisionRecord, "utf8")).toBe(
        JSON.stringify({ shareId: SHARE_ID, paths: [view.path] }),
      );
      const top = await readdir(join(view.rootDir, ".dohc"));
      expect(top.filter((name) => RECORDS.includes(name))).toEqual([]);
    } finally {
      await view.store.close();
    }
  });

  it.each(["view", "edit"] as const)(
    "refuses a %s share's refresh while an older collision record is in .dohc, and keeps the person's file",
    async (access) => {
      const view = await collidedView();
      try {
        const older = join(view.rootDir, ".dohc", "share-collision-record.json");
        await rename(view.collisionRecord, older);
        view.relay.addWrite(view.path, "granter file two");
        const logRequests = view.relay.logRequests;
        const moments = await momentIds(view.store);
        const refusal = {
          ok: false,
          changedPaths: 0,
          errorMessage:
            "dohc did not update these shared files because an older record at .dohc/share-collision-record.json may be keeping your own files apart from the share. " +
            "Move the files it lists out of the shared folder, then remove the record and try again. " +
            "Files you leave in place are no longer kept apart. A refresh may replace them or count them as your edits.",
        };

        await expect(view.refresh(undefined, access)).resolves.toEqual(refusal);
        expect(view.relay.logRequests).toBe(logRequests);
        expect(await momentIds(view.store)).toEqual(moments);
        expect(await readFile(join(view.rootDir, view.path), "utf8")).toBe("my own file");
        await expect(readSharedViewProjectionDebt(view.rootDir, SHARE_ID)).rejects.toThrow("older share collision record");

        // Once the person moves their file out and removes the record, the share's file lands.
        await rename(join(view.rootDir, view.path), join(await createTestScratch("dohc-moved-out-"), "mine.md"));
        await rm(older);
        await expect(view.refresh(undefined, access)).resolves.toMatchObject({ ok: true, unjournalablePaths: [] });
        expect(await readFile(join(view.rootDir, view.path), "utf8")).toBe("granter file two");
      } finally {
        await view.store.close();
      }
    },
  );

  it("writes nothing before the view's open prepares .dohc/local, and creates nothing", async () => {
    const rootDir = await createTestScratch("dohc-shared-view-records-");
    await mkdir(join(rootDir, ".dohc"));
    const notOpened = {
      refusal: "not-opened",
      message:
        "dohc did not update these shared files because the workspace has not finished opening. Try again when it opens.",
    };
    const pull = vi.fn(async (): Promise<PullShareViewResult> => {
      throw new Error("Unexpected pull");
    });
    const refresh = () =>
      refreshSharedViewOnceWithPull({
        rootDir,
        workspaceId: WORKSPACE,
        relay: new FakeShareRelay().connection(),
        shareId: SHARE_ID,
        pinnedSelector: PINNED_SELECTOR,
        recordRefusals: async () => undefined,
        store: stubStore(async () => ({ text: "unused" })),
        trackPendingMaterialization: true,
        pull,
      });

    // No `.dohc/local` yet: the engine has not opened this view's store.
    await expect(testProjection.markPending(rootDir, ["docs/a.md"])).rejects.toMatchObject(notOpened);
    await expect(recordCollisionPaths(rootDir, SHARE_ID, ["docs/a.md"])).rejects.toMatchObject(notOpened);
    await expect(refresh()).rejects.toMatchObject(notOpened);
    expect(await readdir(join(rootDir, ".dohc"))).toEqual([]);

    // `.dohc/local` is there, but this open is closing.
    await openedView(rootDir);
    closedViews.add(rootDir);
    await expect(refresh()).rejects.toMatchObject(notOpened);
    await expect(testProjection.markPending(rootDir, ["docs/a.md"])).rejects.toMatchObject(notOpened);

    // The open could not keep `.dohc/local` out of iCloud Drive.
    closedViews.delete(rootDir);
    unexcludedViews.add(rootDir);
    await expect(refresh()).rejects.toMatchObject({
      refusal: "not-excluded",
      message:
        "dohc did not update these shared files because it can't keep .dohc/local out of iCloud Drive. Restart dohc to try again.",
    });
    await expect(recordCollisionPaths(rootDir, SHARE_ID, ["docs/a.md"])).rejects.toBeInstanceOf(
      LocalStateUnavailableError,
    );

    expect(pull).not.toHaveBeenCalled();
    expect(await readdir(join(rootDir, ".dohc", "local"))).toEqual([]);
  });

  it("keeps a pull in flight, and the person's file, when the view's open ends during the pull", async () => {
    const view = await collidedView();
    try {
      view.relay.addWrite(view.path, "granter file two");
      view.relay.addWrite("docs/new.md", "new");
      await expect(
        view.refresh(async (input) => {
          const pulled = await view.harness.pullFor(view.target)(input);
          closedViews.add(view.rootDir);
          return pulled;
        }),
      ).resolves.toMatchObject({
        ok: false,
        errorMessage:
          "dohc did not update these shared files because the workspace has not finished opening. Try again when it opens.",
      });
      // The store moved on, the folder did not, and the marker says so.
      expect(await readFile(join(view.rootDir, view.path), "utf8")).toBe("my own file");
      await expect(stat(join(view.rootDir, "docs/new.md"))).rejects.toMatchObject({ code: "ENOENT" });
      expect(await readdir(recordsDir(view.rootDir))).toEqual([
        "pull-in-flight.marker",
        "share-collision-record.json",
      ]);

      closedViews.delete(view.rootDir);
      await expect(view.refresh()).resolves.toMatchObject({
        ok: true,
        unjournalablePaths: [{ path: view.path, reason: "local-collision" }],
      });
      expect(await readFile(join(view.rootDir, view.path), "utf8")).toBe("my own file");
      expect(await readFile(join(view.rootDir, "docs/new.md"), "utf8")).toBe("new");
      expect(await readdir(recordsDir(view.rootDir))).toEqual([
        "share-collision-record.json",
      ]);
    } finally {
      await view.store.close();
    }
  });

  it.runIf(process.platform === "win32").each(["close", "rebind"] as const)(
    "refuses a refresh and keeps the collision record when a %s ends the view's open as dohc reads it after the pull",
    async (how) => {
      const view = await collidedView();
      try {
        view.relay.addWrite(view.path, "granter file two");
        view.relay.addWrite("docs/new.md", "new");
        const record = await readFile(view.collisionRecord, "utf8");
        const trip = openEndsWhileReading(view.rootDir, "share-collision-record.json", how);
        trip.armed = false;

        await expect(
          view.refresh(async (input) => {
            const pulled = await view.harness.pullFor(view.target)(input);
            trip.armed = true;
            return pulled;
          }),
        ).resolves.toMatchObject({ ok: false, errorMessage: NOT_OPENED_WORDS });
        expect(trip.ended).toBe(1);
        expect(await readFile(view.collisionRecord, "utf8")).toBe(record);
        expect((await readdir(recordsDir(view.rootDir))).filter((name) => name.includes(".invalid-"))).toEqual([]);
        expect(await readFile(join(view.rootDir, view.path), "utf8")).toBe("my own file");

        closedViews.delete(view.rootDir);
        await expect(view.refresh()).resolves.toMatchObject({
          ok: true,
          unjournalablePaths: [{ path: view.path, reason: "local-collision" }],
        });
        expect(await readFile(join(view.rootDir, view.path), "utf8")).toBe("my own file");
        expect(await readFile(join(view.rootDir, "docs/new.md"), "utf8")).toBe("new");
      } finally {
        await view.store.close();
      }
    },
  );

  it.skipIf(process.platform === "win32").each([
    ["writable by others", "dohc did not update these shared files because it can't trust .dohc/local/share-refresh/share-collision-record.json. It keeps a refresh from replacing your own files. Make it a file only you can change, then try again."],
    ["hard-linked", "dohc did not update these shared files because .dohc/local/share-refresh/share-collision-record.json has a second name elsewhere. It keeps a refresh from replacing your own files. Remove the other name, or replace this file with a copy of it, then try again."],
    ["another user's", "dohc did not update these shared files. This workspace's .dohc belongs to another user. Make it and everything in it yours again, then try again."],
    ["under a linked .dohc/local", "dohc did not update these shared files. This workspace's .dohc/local is a link. Put what it links to in its place, then try again."],
    ["under a linked records folder", "dohc did not update these shared files because it can't trust .dohc/local/share-refresh. Its records keep a refresh from replacing your own files. Make it a folder only you can change, then try again."],
  ] as const)(
    "refuses a collision record %s, and keeps the person's file",
    async (kind, errorMessage) => {
      const view = await collidedView();
      const elsewhere = await createTestScratch("dohc-shared-view-records-elsewhere-");
      const errorLog = vi.spyOn(console, "error").mockImplementation(() => undefined);
      let uid: ReturnType<typeof vi.spyOn> | undefined;
      try {
        view.relay.addWrite(view.path, "granter file two");
        await writeFile(view.collisionRecord, JSON.stringify({ shareId: SHARE_ID, paths: [] }));
        if (kind === "writable by others") await chmod(view.collisionRecord, 0o666);
        if (kind === "hard-linked") await link(view.collisionRecord, join(elsewhere, "second-name.json"));
        if (kind === "another user's") uid = vi.spyOn(process, "getuid").mockReturnValue(process.getuid!() + 1);
        const moved =
          kind === "under a linked .dohc/local" ? join(view.rootDir, ".dohc", "local")
            : kind === "under a linked records folder" ? recordsDir(view.rootDir)
              : undefined;
        if (moved) {
          await rename(moved, join(elsewhere, "moved"));
          await symlink(join(elsewhere, "moved"), moved, "dir");
        }
        const elsewhereBefore = await readdir(elsewhere, { recursive: true });
        const logRequests = view.relay.logRequests;

        await expect(view.refresh()).resolves.toEqual({ ok: false, changedPaths: 0, errorMessage });
        uid?.mockRestore();
        expect(view.relay.logRequests).toBe(logRequests);
        expect(await readFile(join(view.rootDir, view.path), "utf8")).toBe("my own file");
        expect(await readdir(elsewhere, { recursive: true })).toEqual(elsewhereBefore);
        if (!moved) {
          expect(await readdir(recordsDir(view.rootDir))).toEqual(["share-collision-record.json"]);
        }
      } finally {
        uid?.mockRestore();
        errorLog.mockRestore();
        await view.store.close();
      }
    },
  );

  it.skipIf(process.platform === "win32").each(["writable by others", "hard-linked"] as const)(
    "sets aside a pending record %s and deletes nothing on its word",
    async (kind) => {
      const rootDir = await createTestScratch("dohc-shared-view-records-");
      const relay = new FakeShareRelay();
      const harness = daemonHarness(relay);
      const path = "docs/deleted-by-granter.md";
      const target = { workspaceId: WORKSPACE, rootPath: rootDir };
      relay.addWrite(path, "granter body");
      await refreshSharedViewOnce(harness, { rootDir, workspaceId: WORKSPACE, shareId: SHARE_ID });
      const elsewhere = await createTestScratch("dohc-shared-view-records-elsewhere-");
      const store = harness.openStore(target);
      const errorLog = vi.spyOn(console, "error").mockImplementation(() => undefined);
      try {
        const main = await store.ensureMainVersion({ workspaceId: WORKSPACE });
        await store.deleteTextFile({ workspaceId: WORKSPACE, versionId: main.id, path, metadata: { origin: "sync" } });
        await writePendingMaterializationPaths(rootDir, [path]);
        const pending = join(recordsDir(rootDir), "pending-materialization.json");
        if (kind === "writable by others") await chmod(pending, 0o666);
        if (kind === "hard-linked") await link(pending, join(elsewhere, "second-name.json"));

        await expect(captureSharedViewLocalDivergence(rootDir, WORKSPACE, store, true, SHARE_ID)).resolves.toEqual({
          capturedPaths: 0,
          repairedPaths: 0,
          unjournalablePaths: [],
        });
        expect(await readFile(join(rootDir, path), "utf8")).toBe("granter body");
        expect((await readdir(recordsDir(rootDir))).some((name) =>
          /^pending-materialization\.json\.invalid-\d+$/.test(name))).toBe(true);
        await expect(readPendingMaterializationPaths(rootDir)).resolves.toEqual(new Set());

        // The same record of dohc's own finishes the delete.
        await writePendingMaterializationPaths(rootDir, [path]);
        await expect(captureSharedViewLocalDivergence(rootDir, WORKSPACE, store, true, SHARE_ID)).resolves.toMatchObject({
          repairedPaths: 1,
        });
        await expect(stat(join(rootDir, path))).rejects.toMatchObject({ code: "ENOENT" });
      } finally {
        errorLog.mockRestore();
        await store.close();
      }
    },
  );

  it.skipIf(process.platform === "win32").each(["writable by others", "hard-linked"] as const)(
    "reads a pull marker %s as a pull in flight",
    async (kind) => {
      const rootDir = await createTestScratch("dohc-shared-view-records-");
      const relay = new FakeShareRelay();
      const harness = daemonHarness(relay);
      const path = "docs/stale.md";
      const target = { workspaceId: WORKSPACE, rootPath: rootDir };
      relay.addWrite(path, "moment one");
      await refreshSharedViewOnce(harness, { rootDir, workspaceId: WORKSPACE, shareId: SHARE_ID });
      const elsewhere = await createTestScratch("dohc-shared-view-records-elsewhere-");
      const store = harness.openStore(target);
      const errorLog = vi.spyOn(console, "error").mockImplementation(() => undefined);
      try {
        // The pull wrote moment two to the store and stopped before the folder.
        const main = await store.ensureMainVersion({ workspaceId: WORKSPACE });
        await store.writeTextFile({ workspaceId: WORKSPACE, versionId: main.id, path, text: "moment two", metadata: { origin: "sync" } });
        const marker = join(await openedRecordsDir(rootDir), "pull-in-flight.marker");
        await writeFile(marker, "", { mode: 0o600 });
        if (kind === "writable by others") await chmod(marker, 0o666);
        if (kind === "hard-linked") await link(marker, join(elsewhere, "second-name.marker"));
        await expect(readSharedViewProjectionDebt(rootDir, SHARE_ID)).resolves.toMatchObject({ pullInFlight: true });
        const before = await momentIds(store);

        // An edit share would otherwise take moment one, still on disk, as the person's edit.
        await expect(captureSharedViewLocalDivergence(rootDir, WORKSPACE, store, true, SHARE_ID)).resolves.toMatchObject({
          capturedPaths: 0,
          repairedPaths: 1,
          unjournalablePaths: [],
        });
        expect(await momentIds(store)).toEqual(before);
        expect(await readFile(join(rootDir, path), "utf8")).toBe("moment two");
        await expect(readSharedViewProjectionDebt(rootDir, SHARE_ID)).resolves.toMatchObject({ pullInFlight: false });
      } finally {
        errorLog.mockRestore();
        await store.close();
      }
    },
  );

});

describe("shareViewIdentitySelector", () => {
  const EDIT = { paths: ["docs"], versionId: null, access: "edit" };
  const match = (left: string, right: string): boolean => left === right;

  function decide(
    shareView: Parameters<typeof shareViewIdentitySelector>[0]["shareView"],
    relayUrl: string | null = "https://relay.example",
  ) {
    return shareViewIdentitySelector({
      shareView,
      relayUrl,
      relayUrlsMatch: match,
    });
  }

  it("enrols an Edit share view against its pinned grant", () => {
    expect(
      decide({
        grantedSelector: EDIT,
        relayUrl: "https://relay.example",
      }),
    ).toEqual({ paths: ["docs"], versionId: null, access: "edit" });
  });

  it("never enrols a View or Comment share outside the proposal lane", () => {
    for (const access of ["view", "comment"] as const) {
      expect(
        decide({
          grantedSelector: { ...EDIT, access },
          relayUrl: "https://relay.example",
        }),
      ).toBeNull();
    }
  });

  it("skips a share view whose pinned grant is damaged", () => {
    // One damaged field per case, each already refused by
    // `recordedShareSelector`. A record this build cannot read completely is
    // not a narrower grant, so it must not enrol at a level nobody granted.
    for (const grantedSelector of [
      undefined,
      null,
      { ...EDIT, access: "owner" },
      { ...EDIT, access: undefined },
      { ...EDIT, paths: "docs" },
      { ...EDIT, paths: ["../escape"] },
      { ...EDIT, paths: ["docs/"] },
      { paths: [], versionId: null, access: "comment" },
      { ...EDIT, versionId: " v1" },
    ]) {
      expect(
        decide({ grantedSelector, relayUrl: "https://relay.example" }),
      ).toBeNull();
    }
  });

  it("skips a share that has ended", () => {
    expect(
      decide({
        grantedSelector: EDIT,
        ended: true,
        relayUrl: "https://relay.example",
      }),
    ).toBeNull();
  });

  it("skips a session signed into a relay that is not this share's origin", () => {
    expect(
      decide(
        { grantedSelector: EDIT, relayUrl: "https://origin.example" },
        "https://other.example",
      ),
    ).toBeNull();
    // A record with no origin relay predates that field; the session's relay
    // is all there is, and it enrols.
    expect(decide({ grantedSelector: EDIT })).toEqual({
      paths: ["docs"],
      versionId: null,
      access: "edit",
    });
  });

});
