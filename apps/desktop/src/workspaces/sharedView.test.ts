import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import * as fsPromises from "node:fs/promises";
import {
  chmod,
  link,
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { userInfo } from "node:os";
import { basename, dirname, join, sep } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createShareViewDaemonHarness,
  type ShareViewDaemonHarness,
} from "../testing/shareViewLoopbackTransport";
import {
  readPendingMaterializationPaths,
  readSharedViewProjectionDebt,
  resolvedShareViewTarget,
  createShareViewLifecycle,
  shareViewFilesProjection,
  withShareViewRefreshLifecycleLock,
} from "./sharedView";
import {
  assertShareChangesJournalable,
  SharePinInvalidError,
  shareViewIdentitySelector,
} from "./shareViewRecords";
import {
  MAX_ENGINE_CAPTURE_BINARY_BYTES,
  MAX_ENGINE_CAPTURE_TEXT_BYTES,
} from "./workspaceEngineCapture";
import {
  createShareViewFiles,
  type ResolvedShareViewFilesTarget,
  type ShareViewFileChange,
  type ShareViewFileChangeValue,
} from "./shareViewFiles";
import type { ShareViewFilesOwnerCapability } from "./shareViewFilesOwner";
import {
  withOrderedWorkspaceTargetPath,
  withStaleSensitiveWorkspaceOperation,
  type WorkspaceTextWriteResult,
} from "./workspaceAssets";
import type { ImportCopyOutcome } from "./workspaceFiles";
import { shareViewTakesLocalWrites } from "./shareWriteGate";
import {
  ShareUnavailableError,
  type PullShareViewResult,
  type ShareViewRefusal,
} from "@dohc/workspace-contracts/relay";
import { deniedReadCode, denyRead, restoreRead } from "@dohc/workspace-fs/testing";
import { createTestScratch } from "./testTemp";
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

// A recording spy, not a poisoning one: every readdir call this file's own
// setup or fixtures make is allowed through unchanged. It proves that capture
// makes zero readdir calls, so the recursive tree walk #866 removed stays gone.
let readdirCalls: string[] = [];
let observeRealpath: ((path: string) => void) | null = null;
let realpathOverride:
  | ((path: string, resolved: string) => string | null)
  | null = null;
let failRenameToPathOnce: { path: string; error: Error } | null = null;
let failRemovePathOnce: { path: string; error: Error } | null = null;
let failReaddirPathOnce: { path: string; error: Error } | null = null;
let beforeOpen: ((path: string) => Promise<void>) | null = null;
let collisionRecordRenameTargets: string[] = [];
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
      observeRealpath?.(String(path));
      return realpathOverride?.(String(path), String(resolved)) ?? resolved;
    }) as typeof actual.realpath,
    rename: (async (
      oldPath: Parameters<typeof actual.rename>[0],
      newPath: Parameters<typeof actual.rename>[1],
    ) => {
      if (/[\\/]share-collision-record\.json$/.test(String(newPath))) {
        collisionRecordRenameTargets.push(String(newPath));
      }
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
    rm: (async (
      path: Parameters<typeof actual.rm>[0],
      options?: Parameters<typeof actual.rm>[1],
    ) => {
      const failure = failRemovePathOnce;
      if (failure !== null && String(path) === failure.path) {
        failRemovePathOnce = null;
        throw failure.error;
      }
      return actual.rm(path, options);
    }) as typeof actual.rm,
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
    const captured = await captureStandaloneShareViewDivergence({
      rootDir: input.rootDir,
      workspaceId: input.workspaceId,
      store: input.store,
      pinnedSelector: input.pinnedSelector,
      shareId: input.shareId,
      ended,
      preservedPaths: input.preservedPaths,
    });
    return reconcileStandaloneShareView({ ...refreshInput, captured });
  });
}

// chmod-based fixtures cannot make a path unreadable for root. Windows uses
// the workspace-fs NTFS deny-read fixture and has no getuid.
const itNonRoot = process.getuid?.() === 0 ? it.skip : it;

async function denyFileContentRead(absolutePath: string): Promise<void> {
  if (process.platform === "win32") {
    execFileSync(
      "icacls",
      [absolutePath, "/deny", `${userInfo().username}:(RD)`],
      {
        stdio: "pipe",
      },
    );
    return;
  }
  await denyRead(absolutePath, "file");
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

let outsideLinks: string[] = [];
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
  outsideLinks = [];
  harnesses = [];
  observeRealpath = null;
  realpathOverride = null;
  failRenameToPathOnce = null;
  failRemovePathOnce = null;
  failReaddirPathOnce = null;
  collisionRecordRenameTargets = [];
});

afterEach(async () => {
  realpathOverride = null;
  failRenameToPathOnce = null;
  failRemovePathOnce = null;
  failReaddirPathOnce = null;
  collisionRecordRenameTargets = [];
  await Promise.all(harnesses.map((harness) => harness.closeAll()));
  await Promise.all(
    outsideLinks.map((link) => rm(link, { recursive: true, force: true })),
  );
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

function applyShareViewFileCreate(
  input: OwnedChangeScope & { relativePath: string; initialText: string },
): Promise<string> {
  return applyOwnedShareViewChange(input, {
    kind: "create",
    path: input.relativePath,
    initialText: input.initialText,
  }) as Promise<string>;
}

function applyShareViewPathMove(
  input: OwnedChangeScope & { fromPath: string; toPath: string },
): Promise<string> {
  return applyOwnedShareViewChange(input, {
    kind: "move",
    fromPath: input.fromPath,
    toPath: input.toPath,
  }) as Promise<string>;
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
  beforeLogRequest?: (requestNumber: number) => Promise<void>;
  // The share metadata route is the only route a re-pin could use. Counted so
  // a test can prove that a refresh never reaches it.
  metadataRequests = 0;
  private nextSeq = 1;

  // A moment the share never granted: same shape, another lineage. The pinned
  // selector follows main, so the recipient's boundary refuses this one.
  addWriteFromAnotherVersion(
    path: string,
    content: string,
    versionId: string,
  ): void {
    this.addWrite(path, content);
    const served = this.ops[this.ops.length - 1] as {
      payload: Record<string, unknown>;
    };
    served.payload.versionId = versionId;
  }

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
      this.metadataRequests += 1;
      return notFound();
    }
    if (parts.length === 4 && parts[3] === "log") {
      this.logRequests += 1;
      await this.beforeLogRequest?.(this.logRequests);
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

  it("does not heal a malformed canonical path outside the projection", async () => {
    const rootDir = await createTestScratch("dohc-shared-view-desktop-");
    const outside = await createTestScratch("dohc-shared-view-desktop-");
    const outsideLink = join(
      dirname(rootDir),
      `${basename(rootDir)}-outside-link`,
    );
    outsideLinks.push(outsideLink);
    await symlink(outside, outsideLink, "dir");
    const maliciousPath = `../${basename(outsideLink)}/child.md`;
    const harness = daemonHarness(new FakeShareRelay());
    const store = harness.openStore({
      workspaceId: WORKSPACE,
      rootPath: rootDir,
    });
    const malformedStore: typeof store = {
      ...store,
      async listTextFileMetadata() {
        return [
          {
            path: maliciousPath,
            objectId: "malformed-object",
            contentKind: "text",
            byteLength: 1,
            sha256: "0".repeat(64),
            updatedAtMs: 1,
            latestMomentId: "malformed-moment",
            hasYdocMarker: false,
          },
        ];
      },
    };

    try {
      await expect(
        captureSharedViewLocalDivergence(
          rootDir,
          WORKSPACE,
          malformedStore,
          false,
          SHARE_ID,
        ),
      ).rejects.toThrow(/escapes the workspace/);
      await expect(
        lstat(outsideLink),
        "projection healing removes a link outside the projection",
      ).resolves.toBeDefined();
    } finally {
      await store.close();
    }
  });

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

  it("captures an edit to a Collection's automations as text and leaves its schema alone", async () => {
    const rootDir = await createTestScratch("dohc-shared-view-desktop-");
    const relay = new FakeShareRelay();
    const harness = daemonHarness(relay);
    const path = "trip/automations.yaml";
    const edited = "version: 1\nautomations: []\n# packing list\n";
    const target = { workspaceId: WORKSPACE, rootPath: rootDir };
    relay.addWrite("trip/collection.yaml", "name: Trip\n");
    relay.addWrite(path, "version: 1\nautomations: []\n");
    await refreshSharedViewOnce(harness, {
      rootDir,
      workspaceId: WORKSPACE,
      shareId: SHARE_ID,
    });
    await writeFile(join(rootDir, path), edited, "utf8");

    const store = harness.openStore(target);
    try {
      const before = await store.listMoments({ workspaceId: WORKSPACE, limit: 100 });
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
      expect(refreshed.changedPaths).toBe(1);
      expect(refreshed.unjournalablePaths).toEqual([]);

      const after = await store.listMoments({ workspaceId: WORKSPACE, limit: 100 });
      const captured = after.moments.filter((moment) => !beforeIds.has(moment.id));
      expect(captured.map((moment) => moment.path)).toEqual([path]);
      const moment = await store.getMoment({ workspaceId: WORKSPACE, momentId: captured[0]!.id });
      expect(moment?.payload.after.text).toBe(edited);
      const main = await store.ensureMainVersion({ workspaceId: WORKSPACE });
      await expect(
        store.readTextFile({ workspaceId: WORKSPACE, versionId: main.id, path }),
      ).resolves.toMatchObject({ contentKind: "text", text: edited });
    } finally {
      await store.close();
    }
  });

  // A Collection file stored as binary before capture read it as text. Its
  // bytes on disk are the same, so nothing changed.
  async function binaryAutomationsView() {
    const rootDir = await createTestScratch("dohc-shared-view-desktop-");
    const relay = new FakeShareRelay();
    const harness = daemonHarness(relay);
    const path = "trip/automations.yaml";
    const text = "version: 1\nautomations: []\n";
    const target = { workspaceId: WORKSPACE, rootPath: rootDir };
    relay.addWrite("trip/collection.yaml", "name: Trip\n");
    await refreshSharedViewOnce(harness, { rootDir, workspaceId: WORKSPACE, shareId: SHARE_ID });
    const store = harness.openStore(target);
    const main = await store.ensureMainVersion({ workspaceId: WORKSPACE });
    await store.writeBinaryFile({
      workspaceId: WORKSPACE,
      versionId: main.id,
      path,
      bytes: Buffer.from(text, "utf8"),
      metadata: { origin: "sync" },
    });
    await writeFile(join(rootDir, path), text, "utf8");
    return { rootDir, harness, store, target, path, text };
  }

  it.each(["edit", "view"] as const)(
    "leaves a Collection file stored as binary alone when its bytes are unchanged (%s)",
    async (access) => {
      const { rootDir, harness, store, target, path, text } = await binaryAutomationsView();
      try {
        const before = await momentIds(store);
        const refreshed = await reconcileStandaloneForTest({
          rootDir,
          workspaceId: WORKSPACE,
          relay: harness.relay,
          shareId: SHARE_ID,
          store,
          pull: harness.pullFor(target),
          pinnedSelector: { ...PINNED_SELECTOR, access },
          recordRefusals: async () => undefined,
          ended: false,
        });
        if (!refreshed.ok) throw new Error(refreshed.errorMessage);
        expect(refreshed).toMatchObject({ status: "unchanged", unjournalablePaths: [] });
        expect(await momentIds(store)).toEqual(before);
        expect(await readFile(join(rootDir, path), "utf8")).toBe(text);
      } finally {
        await store.close();
      }
    },
  );

  it("repairs an interrupted pull over a Collection file stored as binary without a collision", async () => {
    const { rootDir, store, path } = await binaryAutomationsView();
    try {
      await writePendingMaterializationPaths(rootDir, [path]);
      await writeFile(join(recordsDir(rootDir), "pull-in-flight.marker"), "");
      const before = await momentIds(store);
      await expect(
        captureSharedViewLocalDivergence(rootDir, WORKSPACE, store, true, SHARE_ID),
      ).resolves.toMatchObject({ unjournalablePaths: [] });
      expect(await momentIds(store)).toEqual(before);
      await expect(readSharedViewProjectionDebt(rootDir, SHARE_ID)).resolves.toEqual({
        pendingPaths: new Set(),
        collisionPaths: new Set(),
        pullInFlight: false,
      });
    } finally {
      await store.close();
    }
  });

  it("repairs an interrupted pull for a view-level share without journaling", async () => {
    const rootDir = await createTestScratch("dohc-shared-view-desktop-");
    const relay = new FakeShareRelay();
    const harness = daemonHarness(relay);
    const path = "docs/view-only-refresh.md";
    const target = { workspaceId: WORKSPACE, rootPath: rootDir };
    relay.addWrite(path, "granter body");
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
        text: "new granter body",
        metadata: { origin: "sync" },
      });
      await writeFile(
        join(await openedRecordsDir(rootDir), "pull-in-flight.marker"),
        "",
        "utf8",
      );
      const before = await momentIds(store);
      const outcome = await reconcileStandaloneForTest({
        rootDir,
        workspaceId: WORKSPACE,
        relay: harness.relay,
        shareId: SHARE_ID,
        store,
        pull: harness.pullFor(target),
        pinnedSelector: PINNED_SELECTOR,
        recordRefusals: async () => undefined,
        ended: false,
      });
      expect(outcome).toMatchObject({ status: "updated", changedPaths: 1 });
      expect(await readFile(join(rootDir, path), "utf8")).toBe(
        "new granter body",
      );
      expect(await momentIds(store)).toEqual(before);
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
        collisionRecordQuarantined: false,
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
        collisionRecordQuarantined: false,
        repairedPaths: 1,
        unjournalablePaths: [],
      });
      expect(await momentIds(store)).toEqual(before);
      expect(await readFile(join(rootDir, path), "utf8")).toBe("granter body");
    } finally {
      await store.close();
    }
  });

  it("keeps a save queued behind capture as the journal head", async () => {
    const rootDir = await createTestScratch("dohc-shared-view-desktop-");
    const relay = new FakeShareRelay();
    const harness = daemonHarness(relay);
    const path = "docs/ordered.md";
    const target = { workspaceId: WORKSPACE, rootPath: rootDir };
    relay.addWrite(path, "granter body");
    await refreshSharedViewOnce(harness, {
      rootDir,
      workspaceId: WORKSPACE,
      shareId: SHARE_ID,
    });
    await writeFile(join(rootDir, path), "outside editor", "utf8");
    const store = harness.openStore(target);
    let markCaptureBlocked!: () => void;
    let releaseCapture!: () => void;
    const captureBlocked = new Promise<void>((resolve) => {
      markCaptureBlocked = resolve;
    });
    const captureHeld = new Promise<void>((resolve) => {
      releaseCapture = resolve;
    });
    let saveWriteStarted = false;
    const saveStore: typeof store = {
      ...store,
      async writeTextFile(input) {
        saveWriteStarted = true;
        return await store.writeTextFile(input);
      },
    };
    const pendingOperations: Promise<unknown>[] = [];

    try {
      const capturing = withShareViewRefreshLifecycleLock(rootDir, () =>
        captureSharedViewLocalDivergence(
          rootDir,
          WORKSPACE,
          store,
          true,
          SHARE_ID,
          {
            async beforeCaptureWrite(hookPath) {
              markCaptureBlocked();
              expect(hookPath).toBe(path);
              await captureHeld;
            },
          },
        ),
      );
      pendingOperations.push(capturing);
      await captureBlocked;
      const saving = applyShareViewTextWrite({
          workspaceId: WORKSPACE,
          rootPath: rootDir,
          relativePath: path,
          text: "saved in app",
          expectedContentHash: sha256("outside editor"),
          shareViewStore: () => saveStore,
      });
      pendingOperations.push(saving);
      for (let turn = 0; turn < 20 && !saveWriteStarted; turn += 1) {
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
      expect(saveWriteStarted).toBe(false);
      releaseCapture();
      const [captured] = await Promise.all([capturing, saving]);

      expect(saveWriteStarted).toBe(true);
      const main = await store.ensureMainVersion({ workspaceId: WORKSPACE });
      await expect(
        store.readTextFile({
          workspaceId: WORKSPACE,
          versionId: main.id,
          path,
        }),
      ).resolves.toMatchObject({ text: "saved in app" });
      expect(await readFile(join(rootDir, path), "utf8")).toBe("saved in app");
      const moments = (
        await store.listMoments({ workspaceId: WORKSPACE, limit: 200 })
      ).moments;
      const head = moments.find((moment) => moment.path === path);
      const headMoment = head
        ? await store.getMoment({ workspaceId: WORKSPACE, momentId: head.id })
        : null;
      expect(headMoment?.payload.after.text).toBe("saved in app");
      expect(captured.capturedPaths).toBe(1);
    } finally {
      releaseCapture();
      await Promise.allSettled(pendingOperations);
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
        collisionRecordQuarantined: false,
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

  it("queues a pending-path repair behind an in-app save on the same target", async () => {
    const rootDir = await createTestScratch("dohc-shared-view-desktop-");
    const relay = new FakeShareRelay();
    const harness = daemonHarness(relay);
    const path = "docs/pending-ordered.md";
    const target = { workspaceId: WORKSPACE, rootPath: rootDir };
    relay.addWrite(path, "moment one");
    await refreshSharedViewOnce(harness, {
      rootDir,
      workspaceId: WORKSPACE,
      shareId: SHARE_ID,
    });

    const store = harness.openStore(target);
    const main = await store.ensureMainVersion({ workspaceId: WORKSPACE });
    await store.writeTextFile({
      workspaceId: WORKSPACE,
      versionId: main.id,
      path,
      text: "moment two",
      metadata: { origin: "sync" },
    });
    await writePendingMaterializationPaths(rootDir, [path]);
    let markSaveStarted!: () => void;
    let releaseSave!: () => void;
    const saveStarted = new Promise<void>((resolve) => {
      markSaveStarted = resolve;
    });
    const saveHeld = new Promise<void>((resolve) => {
      releaseSave = resolve;
    });
    let repairMaterializationStarted = false;
    const repairStore: typeof store = {
      ...store,
      async readTextFile(input) {
        repairMaterializationStarted = true;
        return await store.readTextFile(input);
      },
    };
    const saveStore: typeof store = {
      ...store,
      async writeTextFile(input) {
        markSaveStarted();
        await saveHeld;
        return await store.writeTextFile(input);
      },
    };

    try {
      const saving = applyShareViewTextWrite({
          workspaceId: WORKSPACE,
          rootPath: rootDir,
          relativePath: path,
          text: "saved in app",
          expectedContentHash: sha256("moment two"),
          shareViewStore: () => saveStore,
      });
      await saveStarted;
      await rm(join(rootDir, path));
      const repairing = withShareViewRefreshLifecycleLock(rootDir, () =>
        captureSharedViewLocalDivergence(
          rootDir,
          WORKSPACE,
          repairStore,
          true,
          SHARE_ID,
        ),
      );
      for (
        let turn = 0;
        turn < 20 && !repairMaterializationStarted;
        turn += 1
      ) {
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
      expect(repairMaterializationStarted).toBe(false);
      releaseSave();

      await expect(saving).resolves.toMatchObject({ status: "written" });
      await expect(repairing).resolves.toEqual({
        capturedPaths: 0,
        collisionRecordQuarantined: false,
        repairedPaths: 0,
        unjournalablePaths: [],
      });
      expect(await readFile(join(rootDir, path), "utf8")).toBe("saved in app");
    } finally {
      releaseSave();
      await store.close();
    }
  });

  it("handles a tracked file deleted before its ordered admission", async () => {
    const rootDir = await createTestScratch("dohc-shared-view-desktop-");
    const relay = new FakeShareRelay();
    const harness = daemonHarness(relay);
    relay.addWrite("docs/a.md", "body a");
    relay.addWrite("docs/b.md", "body b");
    await refreshSharedViewOnce(harness, {
      rootDir,
      workspaceId: WORKSPACE,
      shareId: SHARE_ID,
    });
    await writeFile(join(rootDir, "docs/a.md"), "tampered a", "utf8");
    await writeFile(join(rootDir, "docs/b.md"), "tampered b", "utf8");

    const store = harness.openStore({
      workspaceId: WORKSPACE,
      rootPath: rootDir,
    });
    const racingStore: typeof store = {
      ...store,
      async writeTextFile(input) {
        const other = input.path === "docs/a.md" ? "docs/b.md" : "docs/a.md";
        await rm(join(rootDir, other), { force: true });
        return await store.writeTextFile(input);
      },
    };
    try {
      await expect(
        captureSharedViewLocalDivergence(
          rootDir,
          WORKSPACE,
          racingStore,
          true,
          SHARE_ID,
        ),
      ).resolves.toMatchObject({ capturedPaths: 2 });
    } finally {
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

  itNonRoot(
    "leaves an unreadable tracked file untouched when the pull changes its path",
    async () => {
      const rootDir = await createTestScratch("dohc-shared-view-desktop-");
      const relay = new FakeShareRelay();
      const harness = daemonHarness(relay);
      const path = "docs/locked.md";
      const absolutePath = join(rootDir, path);
      const target = { workspaceId: WORKSPACE, rootPath: rootDir };
      relay.addWrite(path, "recipient bytes");
      await refreshSharedViewOnce(harness, {
        rootDir,
        workspaceId: WORKSPACE,
        shareId: SHARE_ID,
      });

      const store = harness.openStore(target);
      let denied = false;
      try {
        await denyFileContentRead(absolutePath);
        denied = true;
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
          { path, reason: "unreadable" },
        ]);
        await restoreRead(absolutePath, 0o600);
        denied = false;
        expect(await readFile(absolutePath, "utf8")).toBe("recipient bytes");
      } finally {
        if (denied) await restoreRead(absolutePath, 0o600);
        await store.close();
      }
    },
  );

  it("reports oversized binary and non-UTF-8 causes separately", async () => {
    const rootDir = await createTestScratch("dohc-shared-view-desktop-");
    const relay = new FakeShareRelay();
    const harness = daemonHarness(relay);
    const binaryPath = "docs/huge.png";
    const scenePath = "docs/drawing.excalidraw";
    const target = { workspaceId: WORKSPACE, rootPath: rootDir };
    relay.addWrite(binaryPath, "small image placeholder");
    relay.addWrite(scenePath, "{}\n");
    await refreshSharedViewOnce(harness, {
      rootDir,
      workspaceId: WORKSPACE,
      shareId: SHARE_ID,
    });
    await writeFile(
      join(rootDir, binaryPath),
      Buffer.alloc(MAX_ENGINE_CAPTURE_BINARY_BYTES + 1),
    );
    await writeFile(join(rootDir, scenePath), Buffer.from([0xff, 0xfe, 0xfd]));

    const store = harness.openStore(target);
    try {
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
        collisionRecordQuarantined: false,
        repairedPaths: 0,
        unjournalablePaths: [
          { path: scenePath, reason: "non-utf8" },
          { path: binaryPath, reason: "oversized-binary" },
        ],
      });
    } finally {
      await store.close();
    }
  });

  it("refuses to submit when an oversized tracked edit cannot enter the journal", async () => {
    const rootDir = await createTestScratch("dohc-shared-view-desktop-");
    const relay = new FakeShareRelay();
    const harness = daemonHarness(relay);
    const path = "docs/too-large.md";
    const target = { workspaceId: WORKSPACE, rootPath: rootDir };
    relay.addWrite(path, "granter body");
    await refreshSharedViewOnce(harness, {
      rootDir,
      workspaceId: WORKSPACE,
      shareId: SHARE_ID,
    });
    await writeFile(
      join(rootDir, path),
      "o".repeat(MAX_ENGINE_CAPTURE_TEXT_BYTES + 1),
      "utf8",
    );

    const store = harness.openStore(target);
    const submitShareProposal = vi.fn(async () => undefined);
    try {
      const submit = async () => {
        const captured = await captureStandaloneShareViewDivergence({
          rootDir,
          workspaceId: WORKSPACE,
          store,
          pinnedSelector: { ...PINNED_SELECTOR, access: "edit" },
          shareId: SHARE_ID,
          ended: false,
        });
        assertShareChangesJournalable(captured.unjournalablePaths);
        await submitShareProposal();
      };

      await expect(submit()).rejects.toThrow(
        `dohc did not send your changes. ${path} is larger than the 10.0 MB text limit. ` +
          "Make this file smaller. Fix this file, then send your changes again.",
      );
      expect(submitShareProposal).not.toHaveBeenCalled();
    } finally {
      await store.close();
    }
  });

  it("keeps per-cause submit guidance separate", () => {
    expect(() =>
      assertShareChangesJournalable([
        { path: "docs/too-large.md", reason: "oversized-text" },
        { path: "docs/replaced.md", reason: "non-file-replacement" },
      ]),
    ).toThrowError(
      expect.objectContaining({
        message: expect.stringMatching(
          /docs\/too-large\.md[^.]*10\.0 MB[\s\S]*Make[^.]*smaller[\s\S]*docs\/replaced\.md[\s\S]*(restore|Restore)[\s\S]*(move|Move)/,
        ),
      }),
    );
  });

  it("tells the recipient how to retry an unreadable file without size guidance", () => {
    expect(() =>
      assertShareChangesJournalable([
        { path: "docs/locked.md", reason: "unreadable" },
      ]),
    ).toThrowError(
      expect.objectContaining({
        message: expect.stringMatching(
          /dohc could not read docs\/locked\.md\.[\s\S]*(close|Close)[\s\S]*(wait|Wait)[\s\S]*send your changes again/,
        ),
      }),
    );
  });

  // A refresh merges its pull's pages, and a merged path keeps the place it
  // first had. Here page one writes `notes.md` and renames it `Notes.md`, and
  // page two renames it back, so the merge lists the write of `notes.md`
  // before the delete of `Notes.md`. On a disk that ignores case that delete
  // would remove the file just written.
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

  // A sharer on Linux holds `notes.md` and `Notes.md` as two files. Here the
  // second arrives in its own refresh and takes the one file a disk that
  // ignores case has for both, and a later refresh deletes `notes.md`. That
  // delete would remove the file `Notes.md` still owns (#2294).
  it("keeps the file another spelling still owns when a later refresh deletes one spelling", async (context) => {
    const rootDir = await createTestScratch("dohc-shared-view-desktop-");
    await writeFile(join(rootDir, "probe.md"), "");
    const ignoresCase = await stat(join(rootDir, "PROBE.md")).then(() => true, () => false);
    await rm(join(rootDir, "probe.md"));
    if (!ignoresCase) context.skip("this disk keeps case apart");
    // Linux resolves links but keeps the lookup's case, even on this disk.
    realpathOverride = (path) => path.startsWith(`${rootDir}${sep}`) ? path : null;
    const relay = new FakeShareRelay();
    const harness = daemonHarness(relay);
    const refresh = () => refreshSharedViewOnce(harness, { rootDir, workspaceId: WORKSPACE, shareId: SHARE_ID });
    relay.addWrite("docs/notes.md", "old\n");
    await refresh();
    relay.addWrite("Docs/Notes.md", "live\n");
    await refresh();
    relay.addDelete("docs/notes.md");
    await refresh();

    expect(await readdir(join(rootDir, "docs"))).toEqual(["Notes.md"]);
    expect(await readFile(join(rootDir, "docs", "Notes.md"), "utf8")).toBe("live\n");
  });

  it("refreshes a remote case-only folder rename without listing folders when realpath gives stored names", async (context) => {
    const view = await caseFoldingView(context, "edit");
    try {
      for (let index = 0; index < 12; index += 1) view.relay.addWrite(`docs/plans/${index}.md`, `body ${index}\n`);
      await view.reconcile();
      for (let index = 0; index < 12; index += 1) view.relay.addRename(`docs/plans/${index}.md`, `docs/Plans/${index}.md`, `body ${index}\n`);
      readdirCalls = [];
      await view.reconcile();
      expect(readdirCalls).toEqual([]);
      for (let index = 0; index < 12; index += 1) expect(await readFile(join(view.rootDir, "docs", "Plans", `${index}.md`), "utf8")).toBe(`body ${index}\n`);
    } finally {
      await view.store.close();
    }
  });

  it("replays an unknown held release as a local collision without overwriting its owner", async (context) => {
    const view = await caseFoldingView(context, "edit");
    const harness = view.harness;
    const target = { workspaceId: WORKSPACE, rootPath: view.rootDir };
    realpathOverride = (path) => path.startsWith(`${view.rootDir}${sep}`) ? path : null;
    view.relay.addWrite("notes.md", "owner\n");
    view.relay.addWrite("Notes.md", "held\n");
    const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    const listing = vi.spyOn(fsPromises, "readdir").mockImplementation((async (path: Parameters<typeof readdir>[0], options?: unknown) => {
      if (String(path) === view.rootDir) return [];
      return actual.readdir(path, options as never);
    }) as typeof readdir);
    const refresh = async () => {
      const main = await view.store.ensureMainVersion({ workspaceId: WORKSPACE });
      const preTrackedPaths = new Set((await view.store.listTextFileMetadata({ workspaceId: WORKSPACE, versionId: main.id })).map((file) => file.path));
      return refreshSharedViewOnceWithPull({
        rootDir: view.rootDir, workspaceId: WORKSPACE, relay: harness.relay, shareId: SHARE_ID,
        pull: harness.pullFor(target), pinnedSelector: { ...PINNED_SELECTOR, access: "edit" },
        recordRefusals: async () => undefined, store: view.store, preTrackedPaths, trackPendingMaterialization: true,
      });
    };
    try {
      await expect(refresh()).rejects.toThrow("Could not identify the stored name");
      expect(await readFile(join(view.rootDir, "notes.md"), "utf8")).toBe("owner\n");
      await expect(refresh()).resolves.toMatchObject({ status: "updated", unjournalablePaths: [{ path: "Notes.md", reason: "local-collision" }] });
      expect(await readFile(join(view.rootDir, "notes.md"), "utf8")).toBe("owner\n");
      await expect(refresh()).resolves.toMatchObject({ status: "unchanged" });
    } finally {
      listing.mockRestore();
      await view.store.close();
    }
  });

  it("keeps a protected owner's file and delete debt when its folder cannot be listed", async (context) => {
    const view = await caseFoldingView(context, "edit");
    const harness = daemonHarness(view.relay);
    const target = { workspaceId: WORKSPACE, rootPath: view.rootDir };
    try {
      view.relay.addWrite("docs/notes.md", "old\n");
      await view.reconcile();
      view.relay.addWrite("docs/Notes.md", "live\n");
      await view.reconcile();
      await writeFile(join(view.rootDir, "docs", "notes.md"), "local bytes\n");
      view.relay.addDelete("docs/notes.md");
      failReaddirPathOnce = { path: join(view.rootDir, "docs"), error: Object.assign(new Error("listing denied"), { code: "EACCES" }) };
      const protectedPaths = new Set(["docs/Notes.md"]);
      await refreshSharedViewOnceWithPull({
        rootDir: view.rootDir, workspaceId: WORKSPACE, relay: harness.relay,
        shareId: SHARE_ID, pull: harness.pullFor(target),
        pinnedSelector: { ...PINNED_SELECTOR, access: "edit" }, recordRefusals: async () => undefined,
        store: view.store, excludeFromMaterialization: protectedPaths, protectedPaths, trackPendingMaterialization: true,
      });
      expect(await readFile(join(view.rootDir, "docs", "notes.md"), "utf8")).toBe("local bytes\n");
      expect((await readSharedViewProjectionDebt(view.rootDir, SHARE_ID)).pendingPaths).toContain("docs/notes.md");
    } finally {
      await view.store.close();
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

  it("keeps a held spelling excluded from capture when stored names are unknown", async (context) => {
    const view = await caseFoldingView(context, "edit");
    realpathOverride = (path) => path.startsWith(`${view.rootDir}${sep}`) ? path : null;
    try {
      view.relay.addWrite("notes.md", "same\n");
      view.relay.addWrite("Notes.md", "same\n");
      await view.reconcile();
      const before = await momentIds(view.store);
      const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
      const listing = vi.spyOn(fsPromises, "readdir").mockImplementation((async (path: Parameters<typeof readdir>[0], options?: unknown) => {
        if (String(path) === view.rootDir) return [];
        return actual.readdir(path, options as never);
      }) as typeof readdir);
      try {
        const captured = await view.capture(["Notes.md"]);
        expect(captured.unjournalablePaths).toEqual([{ path: "Notes.md", reason: "unreadable" }]);
        expect(await readCollisionRecordPaths(view.rootDir, SHARE_ID)).toEqual(new Set(["Notes.md"]));
        expect(await momentIds(view.store)).toEqual(before);
      } finally {
        listing.mockRestore();
      }
    } finally {
      await view.store.close();
    }
  });

  // The same sequence the way dohc refreshes a view, capturing first: the
  // second spelling arrives while the first's file is there, so it is held back
  // as a collision and never written. Deleting the first then writes the live
  // spelling's head into the file, which settles the collision.
  it("writes the live spelling's head when a later refresh deletes the spelling the disk holds", async (context) => {
    const rootDir = await createTestScratch("dohc-shared-view-desktop-");
    await writeFile(join(rootDir, "probe.md"), "");
    const ignoresCase = await stat(join(rootDir, "PROBE.md")).then(() => true, () => false);
    await rm(join(rootDir, "probe.md"));
    if (!ignoresCase) context.skip("this disk keeps case apart");
    const relay = new FakeShareRelay();
    const harness = daemonHarness(relay);
    const target = { workspaceId: WORKSPACE, rootPath: rootDir };
    const store = harness.openStore(target);
    const reconcile = async () => {
      const refreshed = await reconcileStandaloneForTest({
        rootDir, workspaceId: WORKSPACE, relay: harness.relay, shareId: SHARE_ID, store, pull: harness.pullFor(target),
        pinnedSelector: PINNED_SELECTOR, recordRefusals: async () => undefined, ended: false,
      });
      if (!refreshed.ok) throw new Error(refreshed.errorMessage);
      return refreshed;
    };
    try {
      relay.addWrite("docs/notes.md", "old\n");
      await reconcile();
      relay.addWrite("Docs/Notes.md", "live\n");
      await reconcile();
      expect(await readFile(join(rootDir, "docs", "notes.md"), "utf8")).toBe("old\n");
      relay.addDelete("docs/notes.md");
      await reconcile();

      expect(await readdir(join(rootDir, "docs"))).toEqual(["Notes.md"]);
      expect(await readFile(join(rootDir, "docs", "Notes.md"), "utf8")).toBe("live\n");
      expect((await reconcile()).unjournalablePaths).toEqual([]);
      expect(await readFile(join(rootDir, "docs", "Notes.md"), "utf8")).toBe("live\n");
    } finally {
      await store.close();
    }
  });

  // Both spellings arrive in one refresh, so the first owns the disk's one
  // file and the later one is held back. Deleting the first writes the later
  // one's head there, under its spelling, which ends the hold.
  it("writes the held spelling's head when a refresh deletes the spelling whose file it is", async (context) => {
    const rootDir = await createTestScratch("dohc-shared-view-desktop-");
    await writeFile(join(rootDir, "probe.md"), "");
    const ignoresCase = await stat(join(rootDir, "PROBE.md")).then(() => true, () => false);
    await rm(join(rootDir, "probe.md"));
    if (!ignoresCase) context.skip("this disk keeps case apart");
    const relay = new FakeShareRelay();
    const harness = daemonHarness(relay);
    const target = { workspaceId: WORKSPACE, rootPath: rootDir };
    const store = harness.openStore(target);
    const reconcile = async () => {
      const refreshed = await reconcileStandaloneForTest({
        rootDir, workspaceId: WORKSPACE, relay: harness.relay, shareId: SHARE_ID, store, pull: harness.pullFor(target),
        pinnedSelector: PINNED_SELECTOR, recordRefusals: async () => undefined, ended: false,
      });
      if (!refreshed.ok) throw new Error(refreshed.errorMessage);
      return refreshed;
    };
    try {
      relay.addWrite("notes.md", "old\n");
      relay.addWrite("Notes.md", "live\n");
      await reconcile();
      expect(await readFile(join(rootDir, "notes.md"), "utf8")).toBe("old\n");
      relay.addDelete("notes.md");
      await reconcile();

      expect((await readdir(rootDir)).filter((name) => !name.startsWith("."))).toEqual(["Notes.md"]);
      expect(await readFile(join(rootDir, "Notes.md"), "utf8")).toBe("live\n");
      expect((await reconcile()).unjournalablePaths).toEqual([]);
      await expect(readCollisionRecordPaths(rootDir, SHARE_ID)).resolves.toEqual(new Set());
    } finally {
      await store.close();
    }
  });

  it("gives an identical held head its stored spelling when realpath keeps lookup case", async (context) => {
    const view = await caseFoldingView(context, "view");
    realpathOverride = (path) => path.startsWith(`${view.rootDir}${sep}`) ? path : null;
    try {
      view.relay.addWrite("notes.md", "same\n");
      view.relay.addWrite("Notes.md", "same\n");
      await view.reconcile();
      view.relay.addDelete("notes.md");
      await view.reconcile();

      expect(await view.names()).toEqual(["Notes.md"]);
      expect(await readFile(join(view.rootDir, "Notes.md"), "utf8")).toBe("same\n");
    } finally {
      await view.store.close();
    }
  });

  it("keeps an owner's identical head in place when realpath keeps lookup case", async (context) => {
    const rootDir = await createTestScratch("dohc-shared-view-desktop-");
    await writeFile(join(rootDir, "probe.md"), "");
    const ignoresCase = await stat(join(rootDir, "PROBE.md")).then(() => true, () => false);
    await rm(join(rootDir, "probe.md"));
    if (!ignoresCase) context.skip("this disk keeps case apart");
    realpathOverride = (path) => path.startsWith(`${rootDir}${sep}`) ? path : null;
    const relay = new FakeShareRelay();
    const harness = daemonHarness(relay);
    const refresh = () => refreshSharedViewOnce(harness, { rootDir, workspaceId: WORKSPACE, shareId: SHARE_ID });
    relay.addWrite("notes.md", "same\n");
    await refresh();
    relay.addWrite("Notes.md", "same\n");
    await refresh();
    const backup = join(await createTestScratch("dohc-share-owner-link-"), "backup.md");
    await link(join(rootDir, "Notes.md"), backup);
    const original = await lstat(backup, { bigint: true });
    relay.addDelete("notes.md");
    await refresh();

    expect((await readdir(rootDir)).filter((name) => !name.startsWith("."))).toEqual(["Notes.md"]);
    const kept = await lstat(join(rootDir, "Notes.md"), { bigint: true });
    expect([kept.dev, kept.ino]).toEqual([original.dev, original.ino]);
  });

  // A spelling the refresh protects, here a preserved path holding local
  // edits, keeps its file: deleting another spelling neither removes the file
  // nor writes the protected spelling's head over those edits.
  it("leaves a protected spelling's file alone when a refresh deletes another spelling of it", async (context) => {
    const rootDir = await createTestScratch("dohc-shared-view-desktop-");
    await writeFile(join(rootDir, "probe.md"), "");
    const ignoresCase = await stat(join(rootDir, "PROBE.md")).then(() => true, () => false);
    await rm(join(rootDir, "probe.md"));
    if (!ignoresCase) context.skip("this disk keeps case apart");
    const relay = new FakeShareRelay();
    const harness = daemonHarness(relay);
    relay.addWrite("Notes.md", "N\n");
    relay.addWrite("notes.md", "n\n");
    await refreshSharedViewOnce(harness, { rootDir, workspaceId: WORKSPACE, shareId: SHARE_ID });
    await writeFile(join(rootDir, "notes.md"), "local bytes\n");
    relay.addDelete("Notes.md");
    const target = { workspaceId: WORKSPACE, rootPath: rootDir };
    const store = harness.openStore(target);
    try {
      const notes = new Set(["notes.md"]);
      await refreshSharedViewOnceWithPull({
        rootDir, workspaceId: WORKSPACE, relay: harness.relay, shareId: SHARE_ID, pull: harness.pullFor(target),
        pinnedSelector: PINNED_SELECTOR, recordRefusals: async () => undefined, store,
        excludeFromMaterialization: notes, protectedPaths: notes, trackPendingMaterialization: true,
      });

      expect(await readFile(join(rootDir, "notes.md"), "utf8")).toBe("local bytes\n");
      // The delete left undone keeps its debt, so a capture after the owner is free settles the file.
      await expect(readPendingMaterializationPaths(rootDir)).resolves.toEqual(new Set(["Notes.md"]));
    } finally {
      await store.close();
    }
  });

  // A rename only by capitals in one refresh leaves the old spelling to the
  // new one's write, which recreates the file under the new spelling.
  it("ends a rename only by capitals with the new spelling on a disk that ignores case", async (context) => {
    const rootDir = await createTestScratch("dohc-shared-view-desktop-");
    await writeFile(join(rootDir, "probe.md"), "");
    const ignoresCase = await stat(join(rootDir, "PROBE.md")).then(() => true, () => false);
    await rm(join(rootDir, "probe.md"));
    if (!ignoresCase) context.skip("this disk keeps case apart");
    const relay = new FakeShareRelay();
    const harness = daemonHarness(relay);
    const refresh = () => refreshSharedViewOnce(harness, { rootDir, workspaceId: WORKSPACE, shareId: SHARE_ID });
    relay.addWrite("notes.md", "body\n");
    await refresh();
    relay.addRename("notes.md", "Notes.md", "body\n");
    await refresh();

    expect((await readdir(rootDir)).filter((name) => !name.startsWith("."))).toEqual(["Notes.md"]);
    expect(await readFile(join(rootDir, "Notes.md"), "utf8")).toBe("body\n");
  });

  // On a disk that keeps case apart the two spellings are two files, so the
  // delete removes only its own.
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

  // Both spellings arrive in one refresh. The first one written owns the
  // file, and the later one is held back, as one arriving in a later refresh
  // is. Neither sends anything, and a view that can only read leaves the file
  // alone (#2416).
  for (const access of ["view", "edit"] as const) {
    it(`holds back the later of two spellings from one refresh and sends nothing (${access})`, async (context) => {
      const view = await caseFoldingView(context, access);
      try {
        view.relay.addWrite("notes.md", "old\n");
        view.relay.addWrite("Notes.md", "live\n");
        await view.reconcile();
        const before = await momentIds(view.store);
        for (let pass = 0; pass < 2; pass += 1) {
          const settled = await view.reconcile();
          expect(settled.unjournalablePaths).toEqual([{ path: "Notes.md", reason: "spelling-collision", owner: "notes.md" }]);
          expect(() => assertShareChangesJournalable(settled.unjournalablePaths)).not.toThrow();
        }
        expect(await momentIds(view.store)).toEqual(before);
        expect(await view.names()).toEqual(["notes.md"]);
        expect(await readFile(join(view.rootDir, "notes.md"), "utf8")).toBe("old\n");
      } finally {
        await view.store.close();
      }
    });
  }

  // The spellings can differ in a folder name too. The folder keeps the first
  // write's spelling, and the later spelling is still held back.
  for (const [first, later] of [["docs/a.md", "Docs/a.md"], ["docs/A.md", "Docs/a.md"]] as const) {
    it(`holds back ${later} after ${first} from one refresh and sends nothing`, async (context) => {
      const view = await caseFoldingView(context, "edit");
      try {
        view.relay.addWrite(first, "first\n");
        view.relay.addWrite(later, "later\n");
        await view.reconcile();
        const before = await momentIds(view.store);
        expect((await view.reconcile()).unjournalablePaths).toEqual([{ path: later, reason: "spelling-collision", owner: first }]);
        expect(await momentIds(view.store)).toEqual(before);
        expect(await view.head(first)).toBe("first\n");
        expect(await view.head(later)).toBe("later\n");
        expect(await readFile(join(view.rootDir, ...first.split("/")), "utf8")).toBe("first\n");
      } finally {
        await view.store.close();
      }
    });
  }

  // A capture that keeps unsaved work aside, as one before access narrows
  // does, still sends nothing for a held spelling, and does not keep it
  // aside: its file is another spelling's, not unsaved work.
  it("sends nothing for a held spelling that a capture keeps aside", async (context) => {
    const view = await caseFoldingView(context, "view");
    try {
      view.relay.addWrite("notes.md", "old\n");
      view.relay.addWrite("Notes.md", "live\n");
      await view.reconcile();
      for (const preserved of [["Notes.md"], null]) {
        const captured = await view.capture(preserved);
        expect(captured.unjournalablePaths).toEqual([{ path: "Notes.md", reason: "spelling-collision", owner: "notes.md" }]);
        expect(captured.remainingPreservedPaths).not.toContain("Notes.md");
      }
      expect(await view.head("Notes.md")).toBe("live\n");
      expect(await view.head("notes.md")).toBe("old\n");
      await expect(readCollisionRecordPaths(view.rootDir, SHARE_ID)).resolves.toEqual(new Set(["Notes.md"]));
    } finally {
      await view.store.close();
    }
  });

  // What a capture kept aside protects files in the next refresh. A held
  // spelling is not among them, so when its owner is deleted, it gets the
  // file with its own text, and capture never saves the owner's text as its.
  it("gives a held spelling its own text when its owner is deleted after a capture kept files aside", async (context) => {
    const view = await caseFoldingView(context, "edit");
    try {
      view.relay.addWrite("notes.md", "old\n");
      view.relay.addWrite("Notes.md", "live\n");
      await view.reconcile();
      const kept = (await view.capture(null)).remainingPreservedPaths ?? [];
      view.relay.addDelete("notes.md");
      await view.reconcile(kept);
      await view.reconcile(kept);

      expect(await view.head("Notes.md")).toBe("live\n");
      expect(await view.names()).toEqual(["Notes.md"]);
      expect(await readFile(join(view.rootDir, "Notes.md"), "utf8")).toBe("live\n");
    } finally {
      await view.store.close();
    }
  });

  // With three spellings, deleting the owner gives its file to one held
  // spelling, which then owns it: the other stays held behind it, even when
  // a capture keeps it aside.
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

  // Deleting the visible file deletes only the spelling the person saw, even
  // when a capture keeps the held spelling aside: the held one gets its own
  // file and text.
  for (const preserved of [["Notes.md"], null]) {
    it(`deletes only the visible spelling when a capture keeps the held one aside (${JSON.stringify(preserved)})`, async (context) => {
      const view = await caseFoldingView(context, "edit");
      try {
        view.relay.addWrite("notes.md", "old\n");
        view.relay.addWrite("Notes.md", "live\n");
        await view.reconcile();
        await rm(join(view.rootDir, "notes.md"));
        await view.capture(preserved);

        expect(await view.head("notes.md")).toBeNull();
        expect(await view.head("Notes.md")).toBe("live\n");
        expect(await view.names()).toEqual(["Notes.md"]);
        expect(await readFile(join(view.rootDir, "Notes.md"), "utf8")).toBe("live\n");
      } finally {
        await view.store.close();
      }
    });
  }

  // A capture scoped to one path, as a save, move or delete runs before it
  // acts, still treats a recorded spelling outside its scope as held. Here
  // this machine's own notes.md blocks both incoming spellings, so neither
  // owns the file, and the capture of notes.md keeps its local collision.
  for (const scoped of ["notes.md", "Notes.md"]) {
    it(`keeps a local collision blocking in a capture scoped to one spelling (${scoped})`, async (context) => {
      const view = await caseFoldingView(context, "edit");
      try {
        await writeFile(join(view.rootDir, "notes.md"), "mine\n");
        view.relay.addWrite("notes.md", "n\n");
        view.relay.addWrite("Notes.md", "N\n");
        await view.reconcile();
        await expect(readCollisionRecordPaths(view.rootDir, SHARE_ID)).resolves.toEqual(new Set(["notes.md", "Notes.md"]));
        const captured = await captureStandaloneShareViewDivergence({
          rootDir: view.rootDir, workspaceId: WORKSPACE, store: view.store,
          pinnedSelector: { ...PINNED_SELECTOR, access: "edit" }, shareId: SHARE_ID, ended: false, paths: [scoped],
        });

        expect(captured.unjournalablePaths).toEqual([{ path: scoped, reason: "local-collision" }]);
        expect(await readFile(join(view.rootDir, "notes.md"), "utf8")).toBe("mine\n");
      } finally {
        await view.store.close();
      }
    });
  }

  // A pull that deleted the owner in the store and stopped before the disk
  // leaves the owner pending and its file in place. A capture that keeps
  // every path aside then never saves the owner's text as the held spelling's.
  it("never saves a crashed pull's deleted owner's text as a held spelling's", async (context) => {
    const view = await caseFoldingView(context, "edit");
    try {
      view.relay.addWrite("notes.md", "old\n");
      view.relay.addWrite("Notes.md", "live\n");
      await view.reconcile();
      const main = await view.store.ensureMainVersion({ workspaceId: WORKSPACE });
      await view.store.deleteTextFile({ workspaceId: WORKSPACE, versionId: main.id, path: "notes.md", metadata: { origin: "sync" } });
      await writePendingMaterializationPaths(view.rootDir, ["notes.md"]);
      await view.capture(null);

      expect(await view.head("Notes.md")).toBe("live\n");
    } finally {
      await view.store.close();
    }
  });

  // A person's own file at a recorded path, beside a spelling the disk keeps
  // apart, is still their unsaved work: a capture that keeps it aside saves
  // it, whatever other spellings of its name exist. NTFS keeps decomposed and
  // composed accents apart; a disk that folds them skips.
  it("saves a person's own file at a recorded path beside another spelling with its own file", async (context) => {
    const view = await caseFoldingView(context, "edit");
    try {
      const [decomposed, composed] = ["café.md", "café.md"];
      view.relay.addWrite(decomposed, "decomposed\n");
      await view.reconcile();
      if (await stat(join(view.rootDir, composed)).then(() => true, () => false)) context.skip("this disk folds normalization");
      await writeFile(join(view.rootDir, composed), "mine\n");
      view.relay.addWrite(composed, "theirs\n");
      await view.reconcile();
      const captured = await view.capture([composed]);

      expect(captured.unjournalablePaths).toEqual([]);
      expect(await view.head(composed)).toBe("mine\n");
      expect(await view.head(decomposed)).toBe("decomposed\n");
    } finally {
      await view.store.close();
    }
  });

  // A refresh that stopped after giving a deleted owner's file to NOTES.md,
  // before ending its record, leaves both remaining spellings recorded. The
  // capture after it settles NOTES.md and never saves its text as Notes.md's.
  it("never saves the new owner's text as a held spelling's after an interrupted handoff", async (context) => {
    const view = await caseFoldingView(context, "edit");
    try {
      view.relay.addWrite("notes.md", "n\n");
      view.relay.addWrite("Notes.md", "N\n");
      view.relay.addWrite("NOTES.md", "NN\n");
      await view.reconcile();
      view.relay.addDelete("notes.md");
      await view.reconcile();
      await recordCollisionPaths(view.rootDir, SHARE_ID, ["NOTES.md"]);
      const before = await momentIds(view.store);
      await view.capture(["Notes.md"]);
      await view.capture(["Notes.md"]);

      expect(await momentIds(view.store)).toEqual(before);
      expect(await view.head("Notes.md")).toBe("N\n");
      expect(await view.head("NOTES.md")).toBe("NN\n");
      await expect(readCollisionRecordPaths(view.rootDir, SHARE_ID)).resolves.toEqual(new Set(["Notes.md"]));
    } finally {
      await view.store.close();
    }
  });

  // Three spellings where the disk keeps the first apart but not the other
  // two, as NTFS keeps decomposed and composed accents apart but not case:
  // the second gets its own file, and the third stays held behind it.
  it("holds a spelling that reaches the file of another spelling the refresh released", async (context) => {
    const view = await caseFoldingView(context, "edit");
    try {
      const [decomposed, composed, upper] = ["café.md", "café.md", "CAFÉ.md"];
      view.relay.addWrite(decomposed, "decomposed\n");
      view.relay.addWrite(composed, "composed\n");
      view.relay.addWrite(upper, "upper\n");
      await view.reconcile();
      const before = await momentIds(view.store);
      await view.reconcile();

      expect(await momentIds(view.store)).toEqual(before);
      expect(await view.head(decomposed)).toBe("decomposed\n");
      expect(await view.head(composed)).toBe("composed\n");
      expect(await view.head(upper)).toBe("upper\n");
    } finally {
      await view.store.close();
    }
  });

  // Deleting the file someone sees deletes the spelling they saw, and the
  // held spelling then gets its own file.
  it("deletes the spelling the person saw when they delete a held-back pair's file", async (context) => {
    const view = await caseFoldingView(context, "edit");
    try {
      view.relay.addWrite("notes.md", "old\n");
      view.relay.addWrite("Notes.md", "live\n");
      await view.reconcile();
      await rm(join(view.rootDir, "notes.md"));
      await view.capture();

      expect(await view.head("notes.md")).toBeNull();
      expect(await view.head("Notes.md")).toBe("live\n");
      expect(await view.names()).toEqual(["Notes.md"]);
      expect(await readFile(join(view.rootDir, "Notes.md"), "utf8")).toBe("live\n");
      await expect(readCollisionRecordPaths(view.rootDir, SHARE_ID)).resolves.toEqual(new Set());
    } finally {
      await view.store.close();
    }
  });

  // A spelling held back because another one's file is there says so, and
  // once the sharer deletes it, the hold ends and the other file stays.
  it("reports a held-back spelling as one and ends the hold when it is deleted", async (context) => {
    const view = await caseFoldingView(context, "edit");
    try {
      view.relay.addWrite("notes.md", "old\n");
      await view.reconcile();
      view.relay.addWrite("Notes.md", "live\n");
      const held = [{ path: "Notes.md", reason: "spelling-collision", owner: "notes.md" }];
      expect((await view.reconcile()).unjournalablePaths).toEqual(held);
      expect((await view.reconcile()).unjournalablePaths).toEqual(held);
      view.relay.addDelete("Notes.md");
      await view.reconcile();

      expect((await view.reconcile()).unjournalablePaths).toEqual([]);
      await expect(readCollisionRecordPaths(view.rootDir, SHARE_ID)).resolves.toEqual(new Set());
      expect(await view.names()).toEqual(["notes.md"]);
      expect(await readFile(join(view.rootDir, "notes.md"), "utf8")).toBe("old\n");
    } finally {
      await view.store.close();
    }
  });

  it("leaves a directory that replaced a tracked file untouched during refresh", async () => {
    const rootDir = await createTestScratch("dohc-shared-view-desktop-");
    const relay = new FakeShareRelay();
    const harness = daemonHarness(relay);
    const path = "docs/notes.md";
    const localPath = join(rootDir, path, "local.txt");
    const target = { workspaceId: WORKSPACE, rootPath: rootDir };
    relay.addWrite(path, "granter body");
    await refreshSharedViewOnce(harness, {
      rootDir,
      workspaceId: WORKSPACE,
      shareId: SHARE_ID,
    });
    await rm(join(rootDir, path));
    await mkdir(join(rootDir, path));
    await writeFile(localPath, "recipient file", "utf8");

    const store = harness.openStore(target);
    try {
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
        { path, reason: "non-file-replacement" },
      ]);
      expect((await stat(join(rootDir, path))).isDirectory()).toBe(true);
      expect(await readFile(localPath, "utf8")).toBe("recipient file");
    } finally {
      await store.close();
    }
  });

  it("captures a deliberate out-of-app revert to an earlier body", async () => {
    const rootDir = await createTestScratch("dohc-shared-view-desktop-");
    const relay = new FakeShareRelay();
    const harness = daemonHarness(relay);
    const path = "docs/reverted.md";
    const target = { workspaceId: WORKSPACE, rootPath: rootDir };
    relay.addWrite(path, "moment A");
    await refreshSharedViewOnce(harness, {
      rootDir,
      workspaceId: WORKSPACE,
      shareId: SHARE_ID,
    });

    const store = harness.openStore(target);
    try {
      await expect(
        applyShareViewTextWrite({
          workspaceId: WORKSPACE,
          rootPath: rootDir,
          relativePath: path,
          text: "moment B",
          expectedContentHash: sha256("moment A"),
          shareViewStore: () => store,
        }),
      ).resolves.toMatchObject({ status: "written" });
      await writeFile(join(rootDir, path), "moment A", "utf8");

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
        collisionRecordQuarantined: false,
        repairedPaths: 0,
        unjournalablePaths: [],
      });
      const main = await store.ensureMainVersion({ workspaceId: WORKSPACE });
      await expect(
        store.readTextFile({
          workspaceId: WORKSPACE,
          versionId: main.id,
          path,
        }),
      ).resolves.toMatchObject({ text: "moment A" });
    } finally {
      await store.close();
    }
  });

  it("clears a pending marker when disk already matches the current head", async () => {
    const rootDir = await createTestScratch("dohc-shared-view-desktop-");
    const relay = new FakeShareRelay();
    const harness = daemonHarness(relay);
    const path = "docs/lagging.md";
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
      await writeFile(join(rootDir, path), "moment two", "utf8");
      await writePendingMaterializationPaths(rootDir, [path]);
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
        collisionRecordQuarantined: false,
        repairedPaths: 1,
        unjournalablePaths: [],
      });
      await expect(
        store.readTextFile({
          workspaceId: WORKSPACE,
          versionId: main.id,
          path,
        }),
      ).resolves.toMatchObject({ text: "moment two" });
      expect(await readFile(join(rootDir, path), "utf8")).toBe("moment two");
      await expect(readPendingMaterializationPaths(rootDir)).resolves.toEqual(
        new Set(),
      );
      const after = await store.listMoments({
        workspaceId: WORKSPACE,
        limit: 100,
      });
      expect(after.moments.map((moment) => moment.id)).toEqual(
        before.moments.map((moment) => moment.id),
      );
    } finally {
      await store.close();
    }
  });

  it("uses the current moment preimage when a pending path advances after listing", async () => {
    const rootDir = await createTestScratch("dohc-shared-view-desktop-");
    const relay = new FakeShareRelay();
    const harness = daemonHarness(relay);
    const path = "docs/advanced-pending.md";
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
      const initial = await store.readTextFile({
        workspaceId: WORKSPACE,
        versionId: main.id,
        path,
      });
      if (initial === null) throw new Error("Expected the initial snapshot.");
      await writePendingMaterializationPaths(rootDir, [path]);

      let currentMomentId: string | undefined;
      const fetchedMomentIds: string[] = [];
      const captureStore: typeof store = {
        ...store,
        async listTextFileMetadata(input) {
          const tracked = await store.listTextFileMetadata(input);
          expect(tracked.find((entry) => entry.path === path)).toMatchObject({
            latestMomentId: initial.latestMomentId,
          });
          const advanced = await store.writeTextFile({
            workspaceId: WORKSPACE,
            versionId: main.id,
            path,
            text: "moment two",
            metadata: { origin: "sync" },
          });
          currentMomentId = advanced.moment.id;
          return tracked;
        },
        async getMoment(input) {
          fetchedMomentIds.push(input.momentId);
          return await store.getMoment(input);
        },
      };

      await expect(
        captureSharedViewLocalDivergence(
          rootDir,
          WORKSPACE,
          captureStore,
          true,
          SHARE_ID,
        ),
      ).resolves.toEqual({
        capturedPaths: 0,
        collisionRecordQuarantined: false,
        repairedPaths: 1,
        unjournalablePaths: [],
      });
      expect(currentMomentId).toBeDefined();
      expect(fetchedMomentIds).toEqual([currentMomentId]);
      const moments = (
        await store.listMoments({ workspaceId: WORKSPACE, limit: 100 })
      ).moments.filter((moment) => moment.path === path);
      expect(moments).toHaveLength(2);
      await expect(
        store.readTextFile({
          workspaceId: WORKSPACE,
          versionId: main.id,
          path,
        }),
      ).resolves.toMatchObject({ text: "moment two" });
      expect(await readFile(join(rootDir, path), "utf8")).toBe("moment two");
    } finally {
      await store.close();
    }
  });

  it("reports a repair-only standalone refresh as updated", async () => {
    const rootDir = await createTestScratch("dohc-shared-view-desktop-");
    const relay = new FakeShareRelay();
    const harness = daemonHarness(relay);
    const path = "docs/repaint-after-repair.md";
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
    } finally {
      await store.close();
    }
  });

  it("returns a repair count when the following pull fails", async () => {
    const rootDir = await createTestScratch("dohc-shared-view-desktop-");
    const relay = new FakeShareRelay();
    const harness = daemonHarness(relay);
    const path = "docs/repaint-after-failed-pull.md";
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

      await expect(
        reconcileStandaloneForTest({
          rootDir,
          workspaceId: WORKSPACE,
          relay: harness.relay,
          shareId: SHARE_ID,
          store,
          pull: async () => {
            throw new Error("relay failed");
          },
          pinnedSelector: { ...PINNED_SELECTOR, access: "edit" },
          recordRefusals: async () => undefined,
          ended: false,
        }),
      ).resolves.toEqual({
        ok: false,
        changedPaths: 1,
        errorMessage: "relay failed",
      });
      expect(await readFile(join(rootDir, path), "utf8")).toBe("moment two");
    } finally {
      await store.close();
    }
  });

  it("returns a repair count when the post-capture metadata read fails", async () => {
    const rootDir = await createTestScratch("dohc-shared-view-desktop-");
    const relay = new FakeShareRelay();
    const harness = daemonHarness(relay);
    const path = "docs/repaint-after-failed-metadata-read.md";
    const target = { workspaceId: WORKSPACE, rootPath: rootDir };
    relay.addWrite(path, "granter body");
    await refreshSharedViewOnce(harness, {
      rootDir,
      workspaceId: WORKSPACE,
      shareId: SHARE_ID,
    });
    await writeFile(join(rootDir, path), "outside editor", "utf8");

    const store = harness.openStore(target);
    let metadataCalls = 0;
    const failingStore: typeof store = {
      ...store,
      async listTextFileMetadata(input) {
        metadataCalls += 1;
        if (metadataCalls === 2) throw new Error("metadata read failed");
        return await store.listTextFileMetadata(input);
      },
    };
    try {
      await expect(
        reconcileStandaloneForTest({
          rootDir,
          workspaceId: WORKSPACE,
          relay: harness.relay,
          shareId: SHARE_ID,
          store: failingStore,
          pull: harness.pullFor(target),
          pinnedSelector: PINNED_SELECTOR,
          recordRefusals: async () => undefined,
          ended: false,
        }),
      ).resolves.toEqual({
        ok: false,
        changedPaths: 1,
        errorMessage: "metadata read failed",
      });
      expect(metadataCalls).toBe(2);
      expect(await readFile(join(rootDir, path), "utf8")).toBe("granter body");
    } finally {
      await store.close();
    }
  });

  it("repairs pending debris only when disk matches the recorded preimage", async () => {
    const rootDir = await createTestScratch("dohc-shared-view-desktop-");
    const relay = new FakeShareRelay();
    const harness = daemonHarness(relay);
    const path = "docs/debris.md";
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
        collisionRecordQuarantined: false,
        repairedPaths: 1,
        unjournalablePaths: [],
      });
      expect(await readFile(join(rootDir, path), "utf8")).toBe("moment two");
      expect(await momentIds(store)).toEqual(before);
      await expect(readPendingMaterializationPaths(rootDir)).resolves.toEqual(
        new Set(),
      );
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
        collisionRecordQuarantined: false,
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

  itNonRoot(
    "keeps a pending marker while its tracked file is unreadable",
    async () => {
    const rootDir = await createTestScratch("dohc-shared-view-desktop-");
    const relay = new FakeShareRelay();
    const harness = daemonHarness(relay);
    const path = "docs/pending-locked.md";
    const absolutePath = join(rootDir, path);
    const target = { workspaceId: WORKSPACE, rootPath: rootDir };
    relay.addWrite(path, "tracked body");
    await refreshSharedViewOnce(harness, {
      rootDir,
      workspaceId: WORKSPACE,
      shareId: SHARE_ID,
    });

    const store = harness.openStore(target);
    let denied = false;
    try {
      await writePendingMaterializationPaths(rootDir, [path]);
      await denyFileContentRead(absolutePath);
      denied = true;

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
        collisionRecordQuarantined: false,
        repairedPaths: 0,
        unjournalablePaths: [{ path, reason: "unreadable" }],
      });
      await expect(readPendingMaterializationPaths(rootDir)).resolves.toEqual(
        new Set([path]),
      );
    } finally {
      if (denied) await restoreRead(absolutePath, 0o600);
      await store.close();
    }
    },
  );

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
        collisionRecordQuarantined: false,
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

  it("preserves a real edit made after materialization completed with a stale marker", async () => {
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
    expect(await readFile(join(rootDir, path), "utf8")).toBe("granter body");

    await writePendingMaterializationPaths(rootDir, [path]);
    await writeFile(join(rootDir, path), "recipient real edit", "utf8");

    const store = harness.openStore(target);
    try {
      const before = await momentIds(store);
      const captured = await captureSharedViewLocalDivergence(
        rootDir,
        WORKSPACE,
        store,
        true,
        SHARE_ID,
      );
      const main = await store.ensureMainVersion({ workspaceId: WORKSPACE });
      const head = await store.readTextFile({
        workspaceId: WORKSPACE,
        versionId: main.id,
        path,
      });
      expect(await readFile(join(rootDir, path), "utf8")).toBe(
        "recipient real edit",
      );
      expect(head?.text).toBe("recipient real edit");
      expect(captured.capturedPaths).toBe(1);
      expect((await momentIds(store)).length).toBe(before.length + 1);
    } finally {
      await store.close();
    }
  });

  it("does not guess that bytes written after a failed pull are journalable", async () => {
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

    const store = harness.openStore(target);
    try {
      await writePendingMaterializationPaths(rootDir, [path]);
      await writeFile(join(rootDir, path), "recipient edit one", "utf8");
      await expect(
        reconcileStandaloneForTest({
          rootDir,
          workspaceId: WORKSPACE,
          relay: harness.relay,
          shareId: SHARE_ID,
          store,
          ended: false,
          pull: async () => {
            throw new Error("offline");
          },
          pinnedSelector: { ...PINNED_SELECTOR, access: "edit" },
          recordRefusals: async () => undefined,
        }),
      ).resolves.toEqual({
        ok: false,
        changedPaths: 1,
        errorMessage: "offline",
      });
      await expect(readPendingMaterializationPaths(rootDir)).resolves.toEqual(
        new Set(),
      );

      await writeFile(join(rootDir, path), "recipient edit two", "utf8");
      await expect(
        captureSharedViewLocalDivergence(
          rootDir,
          WORKSPACE,
          store,
          true,
          SHARE_ID,
        ),
      ).resolves.toMatchObject({
        capturedPaths: 0,
        repairedPaths: 0,
        unjournalablePaths: [{ path, reason: "local-collision" }],
      });
      expect(await readFile(join(rootDir, path), "utf8")).toBe(
        "recipient edit two",
      );
    } finally {
      await store.close();
    }
  });

  it("clears a repaired submit marker before the next local edit", async () => {
    const rootDir = await createTestScratch("dohc-shared-view-desktop-");
    const relay = new FakeShareRelay();
    const harness = daemonHarness(relay);
    const path = "docs/submit-repair.md";
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

      await expect(
        captureStandaloneShareViewDivergence({
          rootDir,
          workspaceId: WORKSPACE,
          store,
          pinnedSelector: { ...PINNED_SELECTOR, access: "edit" },
          shareId: SHARE_ID,
          ended: false,
        }),
      ).resolves.toMatchObject({ capturedPaths: 0, repairedPaths: 1 });
      await expect(readPendingMaterializationPaths(rootDir)).resolves.toEqual(
        new Set(),
      );

      await writeFile(join(rootDir, path), "recipient edit", "utf8");
      await expect(
        captureStandaloneShareViewDivergence({
          rootDir,
          workspaceId: WORKSPACE,
          store,
          pinnedSelector: { ...PINNED_SELECTOR, access: "edit" },
          shareId: SHARE_ID,
          ended: false,
        }),
      ).resolves.toMatchObject({ capturedPaths: 1, repairedPaths: 0 });
      await expect(
        store.readTextFile({
          workspaceId: WORKSPACE,
          versionId: main.id,
          path,
        }),
      ).resolves.toMatchObject({ text: "recipient edit" });
    } finally {
      await store.close();
    }
  });

  it("serializes refresh lifecycle callers per view without blocking other views", async () => {
    const firstRoot = await createTestScratch("dohc-shared-view-desktop-");
    const secondRoot = await createTestScratch("dohc-shared-view-desktop-");
    const order: string[] = [];
    let releaseFirst!: () => void;
    let signalFirstEntered!: () => void;
    const firstEntered = new Promise<void>((resolve) => {
      signalFirstEntered = resolve;
    });
    const holdFirst = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    const first = withShareViewRefreshLifecycleLock(firstRoot, async () => {
      order.push("first:start");
      signalFirstEntered();
      await holdFirst;
      order.push("first:end");
    });
    await firstEntered;

    const sameView = withShareViewRefreshLifecycleLock(firstRoot, async () => {
      order.push("same-view");
    });
    const otherView = withShareViewRefreshLifecycleLock(
      secondRoot,
      async () => {
      order.push("other-view");
      },
    );
    await otherView;

    expect(order).toEqual(["first:start", "other-view"]);
    releaseFirst();
    await Promise.all([first, sameView]);
    expect(order).toEqual([
      "first:start",
      "other-view",
      "first:end",
      "same-view",
    ]);
  });

  it("clears repaired debt before an in-app save records its own", async () => {
    const rootDir = await createTestScratch("dohc-shared-view-desktop-");
    const relay = new FakeShareRelay();
    const harness = daemonHarness(relay);
    const savedPath = "docs/saved.md";
    const otherPath = "docs/still-pending.md";
    const target = { workspaceId: WORKSPACE, rootPath: rootDir };
    relay.addWrite(savedPath, "saved before");
    relay.addWrite(otherPath, "other before");
    await refreshSharedViewOnce(harness, {
      rootDir,
      workspaceId: WORKSPACE,
      shareId: SHARE_ID,
    });

    const store = harness.openStore(target);
    try {
      await writePendingMaterializationPaths(rootDir, [savedPath, otherPath]);
      await applyShareViewTextWrite({
        workspaceId: WORKSPACE,
        rootPath: rootDir,
        relativePath: savedPath,
        text: "saved after",
        expectedContentHash: sha256("saved before"),
        shareViewStore: () => store,
      });
      await expect(readPendingMaterializationPaths(rootDir)).resolves.toEqual(
        new Set([otherPath]),
      );
    } finally {
      await store.close();
    }
  });

  it("uses the same written error for an invalid pending shape and malformed JSON", async () => {
    const rootDir = await createTestScratch("dohc-shared-view-desktop-");
    const pendingPath = join(
      await openedRecordsDir(rootDir),
      "pending-materialization.json",
    );
    await writeFile(pendingPath, JSON.stringify({ counts: [] }), "utf8");
    await expect(readPendingMaterializationPaths(rootDir)).rejects.toThrow(
      "Invalid pending-materialization record.",
    );

    await writeFile(pendingPath, "not json", "utf8");
    await expect(readPendingMaterializationPaths(rootDir)).rejects.toThrow(
      "Invalid pending-materialization record.",
    );
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

  it.each(["../outside", ".dohc/whatever"])(
    "quarantines a pending record with the invalid path %s",
    async (invalidPath) => {
      const rootDir = await createTestScratch("dohc-shared-view-desktop-");
      const relay = new FakeShareRelay();
      const harness = daemonHarness(relay);
      const path = "docs/valid-sidecar-neighbor.md";
      const target = { workspaceId: WORKSPACE, rootPath: rootDir };
      relay.addWrite(path, "tracked body");
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
        const before = await momentIds(store);
        await writeFile(
          join(await openedRecordsDir(rootDir), "pending-materialization.json"),
          JSON.stringify({ counts: { [invalidPath]: 1 } }),
          "utf8",
        );

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
        ).resolves.toMatchObject({ status: "unchanged", changedPaths: 0 });

        expect(await momentIds(store)).toEqual(before);
        expect(
          (await readdir(recordsDir(rootDir))).some((name) =>
            /^pending-materialization\.json\.invalid-\d+$/.test(name),
          ),
        ).toBe(true);
      } finally {
        errorLog.mockRestore();
        await store.close();
      }
    },
  );

  it("preserves an untracked directory when the granter adds a file at its path", async () => {
    const rootDir = await createTestScratch("dohc-shared-view-desktop-");
    const relay = new FakeShareRelay();
    const harness = daemonHarness(relay);
    const path = "docs/recipient-directory.md";
    const childPath = join(rootDir, path, "kept.txt");
    const target = { workspaceId: WORKSPACE, rootPath: rootDir };
    relay.addWrite("docs/seed.md", "seed");
    await refreshSharedViewOnce(harness, {
      rootDir,
      workspaceId: WORKSPACE,
      shareId: SHARE_ID,
    });
    await mkdir(join(rootDir, path), { recursive: true });
    await writeFile(childPath, "recipient data", "utf8");
    relay.addWrite(path, "granter file");

    const store = harness.openStore(target);
    try {
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
        unjournalablePaths: [{ path, reason: "non-file-replacement" }],
      });
      expect((await stat(join(rootDir, path))).isDirectory()).toBe(true);
      expect(await readFile(childPath, "utf8")).toBe("recipient data");
    } finally {
      await store.close();
    }
  });

  it("reports an untracked file that blocks a newly shared path", async () => {
    const rootDir = await createTestScratch("dohc-shared-view-desktop-");
    const relay = new FakeShareRelay();
    const harness = daemonHarness(relay);
    const path = "docs/recipient-file.md";
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
    } finally {
      await store.close();
    }
  });

  it("does not adopt a recorded local collision on a later refresh", async () => {
    const rootDir = await createTestScratch("dohc-shared-view-desktop-");
    const relay = new FakeShareRelay();
    const harness = daemonHarness(relay);
    const path = "docs/recipient-file.md";
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
      const before = await momentIds(store);

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
        unjournalablePaths: [{ path, reason: "local-collision" }],
      });

      expect(await momentIds(store)).toEqual(before);
      expect(await readFile(join(rootDir, path), "utf8")).toBe(
        "recipient data",
      );
    } finally {
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

  it("does not process a collision-recorded pending path twice", async () => {
    const rootDir = await createTestScratch("dohc-shared-view-desktop-");
    const relay = new FakeShareRelay();
    const harness = daemonHarness(relay);
    const path = "docs/collision-pending.md";
    const target = { workspaceId: WORKSPACE, rootPath: rootDir };
    relay.addWrite(path, "moment one");
    await refreshSharedViewOnce(harness, {
      rootDir,
      workspaceId: WORKSPACE,
      shareId: SHARE_ID,
    });
    relay.addWrite(path, "moment two");
    await refreshSharedViewOnce(harness, {
      rootDir,
      workspaceId: WORKSPACE,
      shareId: SHARE_ID,
    });
    await writeFile(join(rootDir, path), "moment one", "utf8");
    await recordCollisionPaths(rootDir, SHARE_ID, [path]);
    await writePendingMaterializationPaths(rootDir, [path]);

    const store = harness.openStore(target);
    try {
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
        collisionRecordQuarantined: false,
        repairedPaths: 0,
        unjournalablePaths: [{ path, reason: "local-collision" }],
      });
      expect(await readFile(join(rootDir, path), "utf8")).toBe("moment one");
      await expect(
        readCollisionRecordPaths(rootDir, SHARE_ID),
      ).resolves.toEqual(new Set([path]));
      await expect(readPendingMaterializationPaths(rootDir)).resolves.toEqual(
        new Set([path]),
      );
    } finally {
      await store.close();
    }
  });

  it("records a non-final pull page collision before fetching the next page", async () => {
    const rootDir = await createTestScratch("dohc-shared-view-desktop-");
    const relay = new FakeShareRelay();
    relay.pageSize = 1;
    const harness = daemonHarness(relay);
    const path = "docs/page-one-collision.md";
    const target = { workspaceId: WORKSPACE, rootPath: rootDir };
    await mkdir(join(rootDir, "docs"), { recursive: true });
    await writeFile(join(rootDir, path), "recipient data", "utf8");
    relay.addWrite(path, "granter file");
    relay.addWrite("docs/page-two.md", "second page");
    let observedBeforeSecondPage = false;
    relay.beforeLogRequest = async (requestNumber) => {
      if (requestNumber !== 2) return;
      await expect(
        readCollisionRecordPaths(rootDir, SHARE_ID),
      ).resolves.toEqual(new Set([path]));
      observedBeforeSecondPage = true;
    };

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

      expect(observedBeforeSecondPage).toBe(true);
      expect(relay.logRequests).toBe(2);
      await expect(
        readCollisionRecordPaths(rootDir, SHARE_ID),
      ).resolves.toEqual(new Set([path]));
      expect(await readFile(join(rootDir, path), "utf8")).toBe(
        "recipient data",
      );
      expect(await readFile(join(rootDir, "docs/page-two.md"), "utf8")).toBe(
        "second page",
      );
    } finally {
      await store.close();
    }
  });

  it("keeps a recorded collision protected for a view-access share", async () => {
    const rootDir = await createTestScratch("dohc-shared-view-desktop-");
    const relay = new FakeShareRelay();
    const harness = daemonHarness(relay);
    const path = "docs/view-access-collision.md";
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
      await expect(
        reconcileStandaloneForTest({
          rootDir,
          workspaceId: WORKSPACE,
          relay: harness.relay,
          shareId: SHARE_ID,
          store,
          pull: harness.pullFor(target),
          pinnedSelector: { ...PINNED_SELECTOR, access: "view" },
          recordRefusals: async () => undefined,
          ended: false,
        }),
      ).resolves.toMatchObject({
        excludedPaths: [path],
        unjournalablePaths: [{ path, reason: "local-collision" }],
      });
      await expect(
        readCollisionRecordPaths(rootDir, SHARE_ID),
      ).resolves.toEqual(new Set([path]));

      await expect(
        reconcileStandaloneForTest({
          rootDir,
          workspaceId: WORKSPACE,
          relay: harness.relay,
          shareId: SHARE_ID,
          store,
          pull: harness.pullFor(target),
          pinnedSelector: { ...PINNED_SELECTOR, access: "view" },
          recordRefusals: async () => undefined,
          ended: false,
        }),
      ).resolves.toMatchObject({
        collisionRecordQuarantined: false,
        unjournalablePaths: [{ path, reason: "local-collision" }],
      });
      expect(await readFile(join(rootDir, path), "utf8")).toBe(
        "recipient data",
      );
    } finally {
      await store.close();
    }
  });

  itNonRoot.each([
    ["tracked collision record", true, true],
    ["ordinary tracked path", true, false],
    ["collision-record sweep", false, true],
  ] as const)(
    "reports an unreadable escaped ancestor for a %s without aborting capture",
    async (_case, tracked, collisionRecorded) => {
      const rootDir = await createTestScratch("dohc-shared-view-desktop-");
      const outsideRoot = await createTestScratch("dohc-shared-view-desktop-");
      const relay = new FakeShareRelay();
      const harness = daemonHarness(relay);
      const path = "docs/escaped.md";
      const target = { workspaceId: WORKSPACE, rootPath: rootDir };
      relay.addWrite("seed.md", "seed");
      if (tracked) relay.addWrite(path, "tracked body");
      await refreshSharedViewOnce(harness, {
        rootDir,
        workspaceId: WORKSPACE,
        shareId: SHARE_ID,
        pinnedSelector: {
          paths: ["seed.md", "docs"],
          versionId: null,
          access: "view",
        },
      });
      if (collisionRecorded) {
        await recordCollisionPaths(rootDir, SHARE_ID, [path]);
      }
      await rm(join(rootDir, "docs"), { recursive: true, force: true });
      await writeFile(join(outsideRoot, "escaped.md"), "outside data", "utf8");
      await symlink(
        outsideRoot,
        join(rootDir, "docs"),
        process.platform === "win32" ? "junction" : "dir",
      );

      const store = harness.openStore(target);
      let outsideDenied = false;
      try {
        await denyRead(outsideRoot, "dir");
        outsideDenied = true;
        await expect(
          captureSharedViewLocalDivergence(
            rootDir,
            WORKSPACE,
            store,
            true,
            SHARE_ID,
          ),
        ).resolves.toMatchObject({
          capturedPaths: 0,
          collisionRecordQuarantined: false,
          repairedPaths: 0,
          unjournalablePaths: [{ path, reason: "unreadable" }],
        });
      } finally {
        if (outsideDenied) await restoreRead(outsideRoot, 0o755);
        await store.close();
      }
    },
  );

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
        collisionRecordQuarantined: false,
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

  it("clears all resolved collision paths with one record publish", async () => {
    const rootDir = await createTestScratch("dohc-shared-view-desktop-");
    const relay = new FakeShareRelay();
    const harness = daemonHarness(relay);
    const paths = ["docs/one.md", "docs/two.md", "docs/three.md"];
    const unresolvedPath = "docs/unresolved.md";
    const target = { workspaceId: WORKSPACE, rootPath: rootDir };
    for (const path of paths) relay.addWrite(path, `granter ${path}`);
    await refreshSharedViewOnce(harness, {
      rootDir,
      workspaceId: WORKSPACE,
      shareId: SHARE_ID,
    });
    await writeFile(join(rootDir, unresolvedPath), "recipient data", "utf8");
    await recordCollisionPaths(rootDir, SHARE_ID, [...paths, unresolvedPath]);
    await Promise.all(paths.map((path) => rm(join(rootDir, path))));

    const store = harness.openStore(target);
    try {
      collisionRecordRenameTargets = [];
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
        collisionRecordQuarantined: false,
        repairedPaths: 3,
        unjournalablePaths: [
          { path: unresolvedPath, reason: "local-collision" },
        ],
      });
      expect(collisionRecordRenameTargets).toEqual([
        join(recordsDir(rootDir), "share-collision-record.json"),
      ]);
      await expect(
        readCollisionRecordPaths(rootDir, SHARE_ID),
      ).resolves.toEqual(new Set([unresolvedPath]));
    } finally {
      await store.close();
    }
  });

  it("keeps a collision record when the store loses the tracked path", async () => {
    const rootDir = await createTestScratch("dohc-shared-view-desktop-");
    const relay = new FakeShareRelay();
    const harness = daemonHarness(relay);
    const path = "docs/lost-collision-path.md";
    const target = { workspaceId: WORKSPACE, rootPath: rootDir };
    relay.addWrite(path, "granter file");
    await refreshSharedViewOnce(harness, {
      rootDir,
      workspaceId: WORKSPACE,
      shareId: SHARE_ID,
    });

    const store = harness.openStore(target);
    const inconsistentStore: typeof store = {
      ...store,
      async readTextFile(input) {
        if (input.path === path) return null;
        return await store.readTextFile(input);
      },
    };
    const errorLog = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    try {
      await recordCollisionPaths(rootDir, SHARE_ID, [path]);
      await rm(join(rootDir, path));

      await expect(
        captureSharedViewLocalDivergence(
          rootDir,
          WORKSPACE,
          inconsistentStore,
          true,
          SHARE_ID,
        ),
      ).resolves.toEqual({
        capturedPaths: 0,
        collisionRecordQuarantined: false,
        repairedPaths: 0,
        unjournalablePaths: [],
      });
      await expect(
        readCollisionRecordPaths(rootDir, SHARE_ID),
      ).resolves.toEqual(new Set([path]));
      expect(errorLog).toHaveBeenCalledWith(
        expect.stringContaining("shared view store lost tracked path"),
      );
    } finally {
      errorLog.mockRestore();
      await store.close();
    }
  });

  it("keeps a tracked collision as durable debt when reading canonical content fails", async () => {
    const rootDir = await createTestScratch("dohc-shared-view-desktop-");
    const relay = new FakeShareRelay();
    const harness = daemonHarness(relay);
    const path = "docs/unreadable-collision-head.md";
    const target = { workspaceId: WORKSPACE, rootPath: rootDir };
    relay.addWrite(path, "granter file");
    await refreshSharedViewOnce(harness, {
      rootDir,
      workspaceId: WORKSPACE,
      shareId: SHARE_ID,
    });

    const store = harness.openStore(target);
    const failingStore: typeof store = {
      ...store,
      async readTextFile(input) {
        if (input.path === path) throw new Error("engine store unavailable");
        return await store.readTextFile(input);
      },
    };
    try {
      await recordCollisionPaths(rootDir, SHARE_ID, [path]);
      await rm(join(rootDir, path));

      await expect(
        captureSharedViewLocalDivergence(
          rootDir,
          WORKSPACE,
          failingStore,
          true,
          SHARE_ID,
        ),
      ).rejects.toMatchObject({
        name: "CapturePartialFailureError",
        capturedPaths: 0,
        repairedPaths: 0,
        path,
        reason: "other",
        message: "engine store unavailable",
      });
      await expect(
        readCollisionRecordPaths(rootDir, SHARE_ID),
      ).resolves.toEqual(new Set([path]));
    } finally {
      await store.close();
    }
  });

  it("keeps a tracked collision as durable debt when repair materialization fails", async () => {
    const rootDir = await createTestScratch("dohc-shared-view-desktop-");
    const relay = new FakeShareRelay();
    const harness = daemonHarness(relay);
    const path = "docs/failed-collision-repair.md";
    const absolutePath = join(rootDir, path);
    const target = { workspaceId: WORKSPACE, rootPath: rootDir };
    relay.addWrite(path, "granter file");
    await refreshSharedViewOnce(harness, {
      rootDir,
      workspaceId: WORKSPACE,
      shareId: SHARE_ID,
    });

    const store = harness.openStore(target);
    try {
      await recordCollisionPaths(rootDir, SHARE_ID, [path]);
      await rm(absolutePath);
      failRemovePathOnce = {
        path: absolutePath,
        error: new Error("projection write unavailable"),
      };

      await expect(
        captureSharedViewLocalDivergence(
          rootDir,
          WORKSPACE,
          store,
          true,
          SHARE_ID,
        ),
      ).rejects.toMatchObject({
        name: "CapturePartialFailureError",
        capturedPaths: 0,
        repairedPaths: 0,
        path,
        reason: "other",
        message: "projection write unavailable",
      });
      await expect(
        readCollisionRecordPaths(rootDir, SHARE_ID),
      ).resolves.toEqual(new Set([path]));
    } finally {
      failRemovePathOnce = null;
      await store.close();
    }
  });

  it("settles absent untracked pending and collision debt once", async () => {
    const rootDir = await createTestScratch("dohc-shared-view-desktop-");
    const relay = new FakeShareRelay();
    const harness = daemonHarness(relay);
    const path = "docs/resolved-dual-debt.md";
    const target = { workspaceId: WORKSPACE, rootPath: rootDir };
    relay.addWrite(path, "granter file");
    await refreshSharedViewOnce(harness, {
      rootDir,
      workspaceId: WORKSPACE,
      shareId: SHARE_ID,
    });
    relay.addDelete(path);
    await refreshSharedViewOnce(harness, {
      rootDir,
      workspaceId: WORKSPACE,
      shareId: SHARE_ID,
    });
    await writePendingMaterializationPaths(rootDir, [path]);
    await writePendingMaterializationPaths(rootDir, [path]);
    await recordCollisionPaths(rootDir, SHARE_ID, [path]);

    const store = harness.openStore(target);
    try {
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
        collisionRecordQuarantined: false,
        repairedPaths: 1,
        unjournalablePaths: [],
      });
      await expect(
        readSharedViewProjectionDebt(rootDir, SHARE_ID),
      ).resolves.toMatchObject({
        pendingPaths: new Set(),
        collisionPaths: new Set(),
      });
    } finally {
      await store.close();
    }
  });

  it("gives collision debt precedence over a matching delete preimage", async () => {
    const rootDir = await createTestScratch("dohc-shared-view-desktop-");
    const relay = new FakeShareRelay();
    const harness = daemonHarness(relay);
    const path = "docs/untracked-dual-debt.md";
    const recipientContent = "recipient file";
    const target = { workspaceId: WORKSPACE, rootPath: rootDir };
    relay.addWrite(path, recipientContent);
    await refreshSharedViewOnce(harness, {
      rootDir,
      workspaceId: WORKSPACE,
      shareId: SHARE_ID,
    });
    relay.addDelete(path);
    await refreshSharedViewOnce(harness, {
      rootDir,
      workspaceId: WORKSPACE,
      shareId: SHARE_ID,
    });
    await writeFile(join(rootDir, path), recipientContent, "utf8");
    await writePendingMaterializationPaths(rootDir, [path]);
    await recordCollisionPaths(rootDir, SHARE_ID, [path]);

    const store = harness.openStore(target);
    try {
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
        collisionRecordQuarantined: false,
        repairedPaths: 0,
        unjournalablePaths: [{ path, reason: "local-collision" }],
      });
      await expect(readFile(join(rootDir, path), "utf8")).resolves.toBe(
        recipientContent,
      );
      await expect(
        readSharedViewProjectionDebt(rootDir, SHARE_ID),
      ).resolves.toMatchObject({
        pendingPaths: new Set([path]),
        collisionPaths: new Set([path]),
      });
    } finally {
      await store.close();
    }
  });

  it.each(["write", "delete"] as const)(
    "consults the collision record at the materialization boundary for a later %s",
    async (operation) => {
      const rootDir = await createTestScratch("dohc-shared-view-desktop-");
      const relay = new FakeShareRelay();
      const harness = daemonHarness(relay);
      const path = `docs/boundary-${operation}-collision.md`;
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
        if (operation === "write") {
          relay.addWrite(path, "granter revision");
        } else {
          relay.addDelete(path);
        }

        await expect(
          refreshSharedViewOnceWithPull({
            rootDir,
            workspaceId: WORKSPACE,
            relay: harness.relay,
            shareId: SHARE_ID,
            store,
            pull: harness.pullFor(target),
            pinnedSelector: { ...PINNED_SELECTOR, access: "edit" },
            recordRefusals: async () => undefined,
            trackPendingMaterialization: true,
            preTrackedPaths: new Set([path]),
          }),
        ).resolves.toMatchObject({
          excludedPaths: [path],
          unjournalablePaths: [{ path, reason: "local-collision" }],
        });

        expect(await readFile(join(rootDir, path), "utf8")).toBe(
          "recipient data",
        );
      } finally {
        await store.close();
      }
    },
  );

  it("catches a collision that appears after the page recording pass, before materialization", async () => {
    const rootDir = await createTestScratch("dohc-shared-view-desktop-");
    const relay = new FakeShareRelay();
    const harness = daemonHarness(relay);
    const path = "docs/late-collision.md";
    const target = { workspaceId: WORKSPACE, rootPath: rootDir };
    relay.addWrite("docs/seed.md", "seed");
    await refreshSharedViewOnce(harness, {
      rootDir,
      workspaceId: WORKSPACE,
      shareId: SHARE_ID,
    });
    relay.addWrite(path, "granter file");

    const store = harness.openStore(target);
    try {
      const realPull = harness.pullFor(target);
      const lateCreatingPull: typeof realPull = async (input) => {
        const result = await realPull(input);
        await writeFile(join(rootDir, path), "recipient data", "utf8");
        return result;
      };

      await expect(
        reconcileStandaloneForTest({
          rootDir,
          workspaceId: WORKSPACE,
          relay: harness.relay,
          shareId: SHARE_ID,
          store,
          pull: lateCreatingPull,
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
      await expect(
        readCollisionRecordPaths(rootDir, SHARE_ID),
      ).resolves.toEqual(new Set([path]));
    } finally {
      await store.close();
    }
  });

  it("publishes a durable collision record without leaving a temp file", async () => {
    const rootDir = await createTestScratch("dohc-shared-view-desktop-");
    const paths = ["docs/b.md", "docs/a.md"];
    await openedView(rootDir);

    await recordCollisionPaths(rootDir, SHARE_ID, paths);

    await expect(readCollisionRecordPaths(rootDir, SHARE_ID)).resolves.toEqual(
      new Set(paths),
    );
    expect(await readdir(recordsDir(rootDir))).toEqual([
      "share-collision-record.json",
    ]);
  });

  it("ignores a stale collision-record temp file beside the intact target", async () => {
    const rootDir = await createTestScratch("dohc-shared-view-desktop-");
    const paths = ["docs/a.md", "docs/b.md"];
    await openedView(rootDir);
    await recordCollisionPaths(rootDir, SHARE_ID, paths);
    await writeFile(
      join(
        recordsDir(rootDir),
        "share-collision-record.json.tmp-999-00000000-0000-0000-0000-000000000000",
      ),
      "not json",
      "utf8",
    );

    await expect(readCollisionRecordPaths(rootDir, SHARE_ID)).resolves.toEqual(
      new Set(paths),
    );
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
      ).resolves.toMatchObject({ collisionRecordQuarantined: true });
      await expect(
        readCollisionRecordPaths(rootDir, SHARE_ID),
      ).resolves.toEqual(new Set());
      expect(
        (await readdir(recordsDir(rootDir))).some((name) =>
          /^share-collision-record\.json\.invalid-\d+$/.test(name),
        ),
      ).toBe(true);
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

  it("does no capture work until after reporting a quarantined collision record", async () => {
    const rootDir = await createTestScratch("dohc-shared-view-desktop-");
    const relay = new FakeShareRelay();
    const harness = daemonHarness(relay);
    const path = "docs/view-quarantined-collision.md";
    const target = { workspaceId: WORKSPACE, rootPath: rootDir };
    relay.addWrite(path, "granter file");
    await refreshSharedViewOnce(harness, {
      rootDir,
      workspaceId: WORKSPACE,
      shareId: SHARE_ID,
    });
    await writeFile(join(rootDir, path), "recipient data", "utf8");
    await writeFile(
      join(await openedRecordsDir(rootDir), "share-collision-record.json"),
      "not json",
      "utf8",
    );

    const store = harness.openStore(target);
    const errorLog = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    try {
      const firstCapture = await captureSharedViewLocalDivergence(
        rootDir,
        WORKSPACE,
        store,
        false,
        SHARE_ID,
      );
      expect(await readFile(join(rootDir, path), "utf8")).toBe(
        "recipient data",
      );
      expect(firstCapture).toEqual({
        capturedPaths: 0,
        repairedPaths: 0,
        unjournalablePaths: [],
        collisionRecordQuarantined: true,
      });

      await expect(
        captureSharedViewLocalDivergence(
          rootDir,
          WORKSPACE,
          store,
          false,
          SHARE_ID,
        ),
      ).resolves.toEqual({
        capturedPaths: 0,
        repairedPaths: 1,
        unjournalablePaths: [],
        collisionRecordQuarantined: false,
      });
      expect(await readFile(join(rootDir, path), "utf8")).toBe("granter file");
      await expect(
        readCollisionRecordPaths(rootDir, SHARE_ID),
      ).resolves.toEqual(new Set());
      expect(errorLog).toHaveBeenCalledWith(
        expect.stringContaining("ordinary capture rules"),
      );
    } finally {
      errorLog.mockRestore();
      await store.close();
    }
  });

  it("reports a quarantined collision record before repairing a view-share path", async () => {
    const rootDir = await createTestScratch("dohc-shared-view-desktop-");
    const relay = new FakeShareRelay();
    const harness = daemonHarness(relay);
    const path = "docs/view-quarantined-collision.md";
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
      await writeFile(
        join(await openedRecordsDir(rootDir), "share-collision-record.json"),
        "not json",
        "utf8",
      );

      await expect(
        reconcileStandaloneForTest({
          rootDir,
          workspaceId: WORKSPACE,
          relay: harness.relay,
          shareId: SHARE_ID,
          store,
          pull: harness.pullFor(target),
          pinnedSelector: { ...PINNED_SELECTOR, access: "view" },
          recordRefusals: async () => undefined,
          ended: false,
        }),
      ).resolves.toMatchObject({
        status: "unchanged",
        unjournalablePaths: [],
        collisionRecordQuarantined: true,
      });
      expect(await readFile(join(rootDir, path), "utf8")).toBe(
        "recipient data",
      );

      await expect(
        reconcileStandaloneForTest({
          rootDir,
          workspaceId: WORKSPACE,
          relay: harness.relay,
          shareId: SHARE_ID,
          store,
          pull: harness.pullFor(target),
          pinnedSelector: { ...PINNED_SELECTOR, access: "view" },
          recordRefusals: async () => undefined,
          ended: false,
        }),
      ).resolves.toMatchObject({
        status: "updated",
        unjournalablePaths: [],
        collisionRecordQuarantined: false,
      });
      expect(await readFile(join(rootDir, path), "utf8")).toBe("granter file");
      await expect(
        readCollisionRecordPaths(rootDir, SHARE_ID),
      ).resolves.toEqual(new Set());
      expect(errorLog).toHaveBeenCalledWith(
        expect.stringContaining("ordinary capture rules"),
      );
    } finally {
      errorLog.mockRestore();
      await store.close();
    }
  });

  it("keeps an intact collision ahead of corrupt pending verification", async () => {
    const rootDir = await createTestScratch("dohc-shared-view-desktop-");
    const relay = new FakeShareRelay();
    const harness = daemonHarness(relay);
    const path = "docs/pending-quarantine-collision.md";
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
      await writeFile(
        join(await openedRecordsDir(rootDir), "pending-materialization.json"),
        "not json",
        "utf8",
      );
      const before = await momentIds(store);

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
        unjournalablePaths: [{ path, reason: "local-collision" }],
      });
      expect(await momentIds(store)).toEqual(before);
      expect(await readFile(join(rootDir, path), "utf8")).toBe(
        "recipient data",
      );
      await expect(
        readCollisionRecordPaths(rootDir, SHARE_ID),
      ).resolves.toEqual(new Set([path]));
      expect(errorLog).toHaveBeenCalledWith(
        expect.stringContaining("verifying every tracked path"),
      );
    } finally {
      errorLog.mockRestore();
      await store.close();
    }
  });

  it("quarantines another share's collision record before recording fresh collisions", async () => {
    const rootDir = await createTestScratch("dohc-shared-view-desktop-");
    const relay = new FakeShareRelay();
    const harness = daemonHarness(relay);
    const stalePath = "docs/stale-share-path.md";
    const collisionPath = "docs/new-share-collision.md";
    const target = { workspaceId: WORKSPACE, rootPath: rootDir };
    relay.addWrite("docs/seed.md", "seed");
    await refreshSharedViewOnce(harness, {
      rootDir,
      workspaceId: WORKSPACE,
      shareId: SHARE_ID,
    });
    await recordCollisionPaths(rootDir, "share-old", [stalePath]);
    await writeFile(join(rootDir, collisionPath), "recipient data", "utf8");
    relay.addWrite(stalePath, "new share file");
    relay.addWrite(collisionPath, "granter file");

    const store = harness.openStore(target);
    const errorLog = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    try {
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
        excludedPaths: [collisionPath],
        unjournalablePaths: [
          { path: collisionPath, reason: "local-collision" },
        ],
      });

      expect(await readFile(join(rootDir, stalePath), "utf8")).toBe(
        "new share file",
      );
      expect(await readFile(join(rootDir, collisionPath), "utf8")).toBe(
        "recipient data",
      );
      await expect(
        readCollisionRecordPaths(rootDir, SHARE_ID),
      ).resolves.toEqual(new Set([collisionPath]));
      expect(
        (await readdir(recordsDir(rootDir))).some((name) =>
          /^share-collision-record\.json\.invalid-\d+$/.test(name),
        ),
      ).toBe(true);
      expect(errorLog).toHaveBeenCalledWith(
        expect.stringContaining("not share-1"),
      );
    } finally {
      errorLog.mockRestore();
      await store.close();
    }
  });

  it("preserves an untracked file when a same-pull create and delete coalesce", async () => {
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
    relay.addWrite(path, "transient granter data");
    relay.addDelete(path);

    const store = harness.openStore(target);
    try {
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
    } finally {
      await store.close();
    }
  });

  it("repairs a share-view create whose projection fails without journaling a delete", async () => {
    const rootDir = await createTestScratch("dohc-shared-view-desktop-");
    const relay = new FakeShareRelay();
    const harness = daemonHarness(relay);
    relay.addWrite("docs/seed.md", "seed");
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
      const created = "docs/new.md";
      let armed = false;
      const failingStore: typeof store = {
        ...store,
        async readTextFile(input) {
          if (armed && input.path === created) {
            throw Object.assign(new Error("EBUSY: projection write failed"), {
              code: "EBUSY",
            });
          }
          return await store.readTextFile(input);
        },
        async writeTextFile(input) {
          const result = await store.writeTextFile(input);
          if (input.path === created) armed = true;
          return result;
        },
      };

      await expect(
        applyShareViewFileCreate({
          workspaceId: WORKSPACE,
          rootPath: rootDir,
          shareViewStore: () => failingStore,
          relativePath: created,
          initialText: "the recipient's new file\n",
        }),
      ).rejects.toThrow("EBUSY: projection write failed");
      armed = false;
      await expect(readPendingMaterializationPaths(rootDir)).resolves.toEqual(
        new Set([created]),
      );

      const before = (
        await store.listMoments({ workspaceId: WORKSPACE, limit: 200 })
      ).moments;
      const captured = await captureSharedViewLocalDivergence(
        rootDir,
        WORKSPACE,
        store,
        true,
        SHARE_ID,
      );
      const after = (
        await store.listMoments({ workspaceId: WORKSPACE, limit: 200 })
      ).moments;
      const beforeIds = new Set(before.map((moment) => moment.id));
      const added = after
        .filter((moment) => !beforeIds.has(moment.id))
        .map((moment) => ({
          path: moment.path,
          operation: moment.operation,
          origin: moment.metadata?.origin,
        }));
      expect(
        added.some(
          (moment) => moment.path === created && moment.operation === "delete",
        ),
        "capture journaled a delete of the file the recipient just created",
      ).toBe(false);
      expect(captured).toEqual({
        capturedPaths: 0,
        collisionRecordQuarantined: false,
        repairedPaths: 1,
        unjournalablePaths: [],
      });
      expect(await readFile(join(rootDir, created), "utf8")).toBe(
        "the recipient's new file\n",
      );
      await expect(readPendingMaterializationPaths(rootDir)).resolves.toEqual(
        new Set(),
      );
    } finally {
      await store.close();
    }
  });

  it("journals a direct delete after a successful share-view create", async () => {
    const rootDir = await createTestScratch("dohc-shared-view-desktop-");
    const relay = new FakeShareRelay();
    const harness = daemonHarness(relay);
    relay.addWrite("docs/seed.md", "seed");
    await refreshSharedViewOnce(harness, {
      rootDir,
      workspaceId: WORKSPACE,
      shareId: SHARE_ID,
    });

    const store = harness.openStore({
      workspaceId: WORKSPACE,
      rootPath: rootDir,
    });
    const created = "docs/new-then-deleted.md";
    try {
      await applyShareViewFileCreate({
        workspaceId: WORKSPACE,
        rootPath: rootDir,
        shareViewStore: () => store,
        relativePath: created,
        initialText: "delete me\n",
      });
      await expect(readPendingMaterializationPaths(rootDir)).resolves.toEqual(
        new Set(),
      );
      await rm(join(rootDir, created));
      const beforeIds = await momentIds(store);

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
        collisionRecordQuarantined: false,
        repairedPaths: 0,
        unjournalablePaths: [],
      });
      await expect(stat(join(rootDir, created))).rejects.toMatchObject({
        code: "ENOENT",
      });
      const added = (
        await store.listMoments({ workspaceId: WORKSPACE, limit: 200 })
      ).moments.filter((moment) => !beforeIds.includes(moment.id));
      expect(added).toEqual([
        expect.objectContaining({
          path: created,
          operation: "delete",
          metadata: expect.objectContaining({ origin: "local-file" }),
        }),
      ]);
    } finally {
      await store.close();
    }
  });

  // The gate returns false for every access level except edit, so view and
  // comment cannot reach distinct branches through this seam.
  it("repairs a direct delete after a successful share-view create for a non-edit access level", async () => {
    const rootDir = await createTestScratch("dohc-shared-view-desktop-");
    const relay = new FakeShareRelay();
    const harness = daemonHarness(relay);
    relay.addWrite("docs/seed.md", "seed");
    await refreshSharedViewOnce(harness, {
      rootDir,
      workspaceId: WORKSPACE,
      shareId: SHARE_ID,
    });

    const store = harness.openStore({
      workspaceId: WORKSPACE,
      rootPath: rootDir,
    });
    const created = "docs/view-repair.md";
    try {
      await applyShareViewFileCreate({
        workspaceId: WORKSPACE,
        rootPath: rootDir,
        shareViewStore: () => store,
        relativePath: created,
        initialText: "restore me\n",
      });
      await rm(join(rootDir, created));
      const beforeIds = await momentIds(store);

      await expect(
        captureSharedViewLocalDivergence(
          rootDir,
          WORKSPACE,
          store,
          shareViewTakesLocalWrites({ access: "view", ended: false }),
          SHARE_ID,
        ),
      ).resolves.toEqual({
        capturedPaths: 0,
        collisionRecordQuarantined: false,
        repairedPaths: 1,
        unjournalablePaths: [],
      });
      expect(await readFile(join(rootDir, created), "utf8")).toBe(
        "restore me\n",
      );
      expect(await momentIds(store)).toEqual(beforeIds);
    } finally {
      await store.close();
    }
  });

  it("marks every move path until its projection is materialized", async () => {
    const rootDir = await createTestScratch("dohc-shared-view-desktop-");
    const relay = new FakeShareRelay();
    const harness = daemonHarness(relay);
    const from = "docs/before.md";
    const to = "docs/after.md";
    relay.addWrite(from, "move me\n");
    await refreshSharedViewOnce(harness, {
      rootDir,
      workspaceId: WORKSPACE,
      shareId: SHARE_ID,
    });

    const store = harness.openStore({
      workspaceId: WORKSPACE,
      rootPath: rootDir,
    });
    let mutationStored!: () => void;
    const stored = new Promise<void>((resolve) => {
      mutationStored = resolve;
    });
    let releaseMutation!: () => void;
    const mutationHeld = new Promise<void>((resolve) => {
      releaseMutation = resolve;
    });
    const pausedStore: typeof store = {
      ...store,
      async renameTextFile(input) {
        const result = await store.renameTextFile(input);
        mutationStored();
        await mutationHeld;
        return result;
      },
    };
    try {
      const moving = applyShareViewPathMove({
        workspaceId: WORKSPACE,
        rootPath: rootDir,
        shareViewStore: () => pausedStore,
        fromPath: from,
        toPath: to,
      });
      await stored;
      let markerError: unknown;
      try {
        await expect(readPendingMaterializationPaths(rootDir)).resolves.toEqual(
          new Set([from, to]),
        );
      } catch (error) {
        markerError = error;
      } finally {
        releaseMutation();
      }
      await expect(moving).resolves.toBe(to);
      if (markerError) throw markerError;
      await expect(readPendingMaterializationPaths(rootDir)).resolves.toEqual(
        new Set(),
      );
    } finally {
      releaseMutation();
      await store.close();
    }
  });

  it("marks every delete target until its projection is materialized", async () => {
    const rootDir = await createTestScratch("dohc-shared-view-desktop-");
    const relay = new FakeShareRelay();
    const harness = daemonHarness(relay);
    const first = "docs/remove/a.md";
    const second = "docs/remove/b.md";
    relay.addWrite(first, "a\n");
    relay.addWrite(second, "b\n");
    await refreshSharedViewOnce(harness, {
      rootDir,
      workspaceId: WORKSPACE,
      shareId: SHARE_ID,
    });

    const store = harness.openStore({
      workspaceId: WORKSPACE,
      rootPath: rootDir,
    });
    let mutationStored!: () => void;
    const stored = new Promise<void>((resolve) => {
      mutationStored = resolve;
    });
    let releaseMutation!: () => void;
    const mutationHeld = new Promise<void>((resolve) => {
      releaseMutation = resolve;
    });
    let firstDelete = true;
    const pausedStore: typeof store = {
      ...store,
      async deleteTextFile(input) {
        const result = await store.deleteTextFile(input);
        if (firstDelete) {
          firstDelete = false;
          mutationStored();
          await mutationHeld;
        }
        return result;
      },
    };
    try {
      const deleting = applyShareViewPathDelete({
        workspaceId: WORKSPACE,
        rootPath: rootDir,
        shareViewStore: () => pausedStore,
        relativePath: "docs/remove",
      });
      await stored;
      let markerError: unknown;
      try {
        await expect(readPendingMaterializationPaths(rootDir)).resolves.toEqual(
          new Set([first, second]),
        );
      } catch (error) {
        markerError = error;
      } finally {
        releaseMutation();
      }
      await expect(deleting).resolves.toEqual({ trashed: false });
      if (markerError) throw markerError;
      await expect(readPendingMaterializationPaths(rootDir)).resolves.toEqual(
        new Set(),
      );
    } finally {
      releaseMutation();
      await store.close();
    }
  });

  it("marks each import path until its projection is materialized", async () => {
    const rootDir = await createTestScratch("dohc-shared-view-desktop-");
    const sourceRoot = await createTestScratch("dohc-shared-view-desktop-");
    const source = join(sourceRoot, "picked.md");
    await writeFile(source, "import me\n", "utf8");
    const relay = new FakeShareRelay();
    const harness = daemonHarness(relay);
    relay.addWrite("docs/seed.md", "seed");
    await refreshSharedViewOnce(harness, {
      rootDir,
      workspaceId: WORKSPACE,
      shareId: SHARE_ID,
    });

    const store = harness.openStore({
      workspaceId: WORKSPACE,
      rootPath: rootDir,
    });
    let mutationStored!: () => void;
    const stored = new Promise<void>((resolve) => {
      mutationStored = resolve;
    });
    let releaseMutation!: () => void;
    const mutationHeld = new Promise<void>((resolve) => {
      releaseMutation = resolve;
    });
    const pausedStore: typeof store = {
      ...store,
      async writeTextFile(input) {
        const result = await store.writeTextFile(input);
        if (input.path === "docs/picked.md") {
          mutationStored();
          await mutationHeld;
        }
        return result;
      },
    };
    try {
      const importing = applyShareViewFileImport({
        workspaceId: WORKSPACE,
        rootPath: rootDir,
        shareViewStore: () => pausedStore,
        absolutePaths: [source],
        screenAgainstRoots: null,
        targetDir: "docs",
      });
      await stored;
      let markerError: unknown;
      try {
        await expect(readPendingMaterializationPaths(rootDir)).resolves.toEqual(
          new Set(["docs/picked.md"]),
        );
      } catch (error) {
        markerError = error;
      } finally {
        releaseMutation();
      }
      await expect(importing).resolves.toEqual({
        imported: ["docs/picked.md"],
        skipped: 0,
      });
      if (markerError) throw markerError;
      await expect(readPendingMaterializationPaths(rootDir)).resolves.toEqual(
        new Set(),
      );
    } finally {
      releaseMutation();
      await store.close();
    }
  });

  // The store holds files, not folders: a dropped folder lands through its
  // files, under a name no held file's folder already uses.
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

  // A share view never takes a .env. The grant decides every file before the
  // first write, so the refusal names it and nothing lands.
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

  // A shared view holds files within its limits, so each skip says which
  // limit it met.
  it("names a folder with no files and a file past the limit, and why each was skipped", async () => {
    const drop = await dropIntoDocs(async (sourceRoot) => {
      await mkdir(join(sourceRoot, "Photos"));
      await writeFile(join(sourceRoot, "movie.mp4"), Buffer.alloc(MAX_ENGINE_CAPTURE_BINARY_BYTES + 1));
      await writeFile(join(sourceRoot, "ok.md"), "ok\n", "utf8");
      return [join(sourceRoot, "Photos"), join(sourceRoot, "movie.mp4"), join(sourceRoot, "ok.md")];
    });
    try {
      await expect(drop.importing).resolves.toEqual({
        imported: ["docs/ok.md"],
        skipped: 2,
        skippedSources: [{ path: "Photos", reason: "no-files" }, { path: "movie.mp4", reason: "too-large" }],
      });
      expect(await drop.storePaths()).toEqual(["docs/ok.md", "docs/seed.md"]);
    } finally {
      await drop.close();
    }
  });

  // The validator decodes %2f, so the grant would check docs/Trip/x/y.md
  // while the store took the raw name.
  it("skips a nested name the destination would rewrite", async () => {
    const drop = await dropIntoDocs(async (sourceRoot) => {
      await mkdir(join(sourceRoot, "Trip"));
      await writeFile(join(sourceRoot, "Trip", "ok.md"), "ok\n", "utf8");
      await writeFile(join(sourceRoot, "Trip", "x%2fy.md"), "encoded\n", "utf8");
      return [join(sourceRoot, "Trip")];
    });
    try {
      await expect(drop.importing).resolves.toEqual({
        imported: ["docs/Trip/ok.md"],
        skipped: 1,
        skippedSources: [{ path: "Trip/x%2fy.md", reason: "name" }],
      });
      expect(await drop.storePaths()).toEqual(["docs/Trip/ok.md", "docs/seed.md"]);
    } finally {
      await drop.close();
    }
  });

  it.each(["file", "folder"] as const)("never reads a %s swapped for a link after the screen", async (swapped) => {
    const secrets = await createTestScratch("dohc-shared-view-secrets-");
    await writeFile(join(secrets, "a.md"), "SECRET\n", "utf8");
    let trip = "";
    afterDropScreen = async () => {
      if (swapped === "file") {
        await rm(join(trip, "notes", "a.md"));
        await symlink(join(secrets, "a.md"), join(trip, "notes", "a.md"), "file");
      } else {
        await rm(join(trip, "notes"), { recursive: true });
        await symlink(secrets, join(trip, "notes"), "dir");
      }
    };
    try {
      const drop = await dropIntoDocs(async (sourceRoot) => {
        trip = join(sourceRoot, "Trip");
        await mkdir(join(trip, "notes"), { recursive: true });
        await writeFile(join(trip, "notes", "a.md"), "notes\n", "utf8");
        return [trip];
      });
      try {
        await expect(drop.importing).rejects.toThrow("changed after dohc checked it");
        expect(await drop.storePaths()).toEqual(["docs/seed.md"]);
      } finally {
        await drop.close();
      }
    } finally {
      afterDropScreen = null;
    }
  });

  // notes.md is held, so the dropped notes.md lands as notes (2).md, which
  // the grant does not name. That is known before ok.md is written.
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

  // Capture reads main.ts under sites/<app>/ as site source text, so the
  // import classifies it by the path it lands at, not its path in the drop.
  it("classifies a dropped file by the path it lands at", async () => {
    const drop = await dropIntoDocs(async (sourceRoot) => {
      await mkdir(join(sourceRoot, "sites", "app"), { recursive: true });
      await writeFile(join(sourceRoot, "sites", "app", "main.ts"), "export {};\n", "utf8");
      return [join(sourceRoot, "sites")];
    });
    try {
      await expect(drop.importing).resolves.toEqual({ imported: ["docs/sites/app/main.ts"], skipped: 0 });
      expect((await drop.stored()).find((file) => file.path === "docs/sites/app/main.ts")?.contentKind).toBe("text");
    } finally {
      await drop.close();
    }
  });

  itNonRoot("skips a dropped file it cannot read, as the path reader does", async () => {
    let locked = "";
    const drop = await dropIntoDocs(async (sourceRoot) => {
      await mkdir(join(sourceRoot, "Trip"));
      await writeFile(join(sourceRoot, "Trip", "ok.md"), "ok\n", "utf8");
      locked = join(sourceRoot, "Trip", "locked.md");
      await writeFile(locked, "locked\n", "utf8");
      await denyFileContentRead(locked);
      return [join(sourceRoot, "Trip")];
    });
    try {
      await expect(drop.importing).resolves.toEqual({
        imported: ["docs/Trip/ok.md"],
        skipped: 1,
        skippedSources: [{ path: "Trip/locked.md", reason: "unreadable" }],
      });
    } finally {
      await restoreRead(locked, 0o600);
      await drop.close();
    }
  });

  // The forged identity stands for a screen that recorded the link target's
  // file. The folder check after the open still refuses the read.
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

  it("finishes a pending delete that no longer appears in tracked metadata", async () => {
    const rootDir = await createTestScratch("dohc-shared-view-desktop-");
    const relay = new FakeShareRelay();
    const harness = daemonHarness(relay);
    const path = "docs/delete-debris.md";
    const target = { workspaceId: WORKSPACE, rootPath: rootDir };
    relay.addWrite(path, "delete me");
    await refreshSharedViewOnce(harness, {
      rootDir,
      workspaceId: WORKSPACE,
      shareId: SHARE_ID,
    });

    const store = harness.openStore(target);
    try {
      const main = await store.ensureMainVersion({ workspaceId: WORKSPACE });
      await store.deleteTextFile({
        workspaceId: WORKSPACE,
        versionId: main.id,
        path,
        metadata: { origin: "local-file" },
      });
      await writePendingMaterializationPaths(rootDir, [path]);
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
        collisionRecordQuarantined: false,
        repairedPaths: 1,
        unjournalablePaths: [],
      });
      await expect(stat(join(rootDir, path))).rejects.toMatchObject({
        code: "ENOENT",
      });
      expect(await momentIds(store)).toEqual(before);
      await expect(readPendingMaterializationPaths(rootDir)).resolves.toEqual(
        new Set(),
      );
    } finally {
      await store.close();
    }
  });

  // A share-view FOLDER delete crashing between the store deleting its
  // children and `materializeSharedViewPaths`' single recursive rm on the
  // folder path used to leave the projection showing files the store had
  // already deleted — the old delete primitive marked only the FOLDER path
  // pending,
  // so recovery never revisited the children at all, found a still-present
  // directory with no matching preimage, and misclassified it as an
  // unjournalable non-file replacement. #862 changed the delete primitive to
  // mark every CHILD path pending before the store mutation, which is what
  // makes them reachable here: the leftover-pending arm below predates #862
  // unchanged, but a path only reaches it when the marker names it.
  //
  // The crash is driven through the real writer, not hand-assembled: a
  // failing store proxy lets both `deleteTextFile` calls succeed, then makes
  // the very first call `materializeSharedViewPaths` itself makes
  // (`ensureMainVersion`) throw — so `applyShareViewPathDelete` leaves
  // whatever state `applyShareViewPathDelete` produces at that exact point,
  // with disk untouched because materialization never ran its rm.
  //
  // Also pins a known, accepted residue: recovery finishes each
  // child individually and has no equivalent of the folder-level rm's
  // directory removal, so the emptied `docs/plans` stays on disk after
  // recovery where an uninterrupted delete would have removed it too.
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

  itNonRoot(
    "keeps an unreadable pending delete marker for the next pass",
    async () => {
      const rootDir = await createTestScratch("dohc-shared-view-desktop-");
      const relay = new FakeShareRelay();
      const harness = daemonHarness(relay);
      const path = "docs/unreadable-delete.md";
      const absolutePath = join(rootDir, path);
      const target = { workspaceId: WORKSPACE, rootPath: rootDir };
      relay.addWrite(path, "delete me");
      await refreshSharedViewOnce(harness, {
        rootDir,
        workspaceId: WORKSPACE,
        shareId: SHARE_ID,
      });

      const store = harness.openStore(target);
      let denied = false;
      try {
        const main = await store.ensureMainVersion({ workspaceId: WORKSPACE });
        await store.deleteTextFile({
          workspaceId: WORKSPACE,
          versionId: main.id,
          path,
          metadata: { origin: "sync" },
        });
        await writePendingMaterializationPaths(rootDir, [path]);
        await denyFileContentRead(absolutePath);
        denied = true;

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
          collisionRecordQuarantined: false,
          repairedPaths: 0,
          unjournalablePaths: [{ path, reason: "unreadable" }],
        });
        await expect(readPendingMaterializationPaths(rootDir)).resolves.toEqual(
          new Set([path]),
        );
      } finally {
        if (denied) await restoreRead(absolutePath, 0o600);
        await store.close();
      }
    },
  );

  it("pages past 500 newer moments to finish a pending delete", async () => {
    const rootDir = await createTestScratch("dohc-shared-view-desktop-");
    const relay = new FakeShareRelay();
    const harness = daemonHarness(relay);
    const path = "docs/old-delete.md";
    const target = { workspaceId: WORKSPACE, rootPath: rootDir };
    relay.addWrite(path, "delete me");
    await refreshSharedViewOnce(harness, {
      rootDir,
      workspaceId: WORKSPACE,
      shareId: SHARE_ID,
    });

    const store = harness.openStore(target);
    try {
      const main = await store.ensureMainVersion({ workspaceId: WORKSPACE });
      await store.deleteTextFile({
        workspaceId: WORKSPACE,
        versionId: main.id,
        path,
        metadata: { origin: "sync" },
      });
      await writePendingMaterializationPaths(rootDir, [path]);
      const actualPage = await store.listMoments({
        workspaceId: WORKSPACE,
        limit: 500,
      });
      const deletion = actualPage.moments.find(
        (moment) => moment.path === path && moment.operation === "delete",
      );
      expect(deletion).toBeDefined();
      const listMoments = vi.fn(
        async (input: Parameters<typeof store.listMoments>[0]) => {
        if (input.beforeMomentOrder === undefined) {
          return {
            ...actualPage,
            moments: Array.from({ length: 500 }, (_, index) => ({
              ...deletion!,
              id: `newer-${index}`,
              path: `docs/newer-${index}.md`,
              momentOrder: 1_000 - index,
            })),
            nextBeforeMomentOrder: 40,
          };
        }
        expect(input.beforeMomentOrder).toBe(40);
        return { ...actualPage, nextBeforeMomentOrder: null };
        },
      );
      const pagingStore: typeof store = { ...store, listMoments };
      const before = await momentIds(store);

      await expect(
        captureSharedViewLocalDivergence(
          rootDir,
          WORKSPACE,
          pagingStore,
          true,
          SHARE_ID,
        ),
      ).resolves.toEqual({
        capturedPaths: 0,
        collisionRecordQuarantined: false,
        repairedPaths: 1,
        unjournalablePaths: [],
      });
      await expect(stat(join(rootDir, path))).rejects.toMatchObject({
        code: "ENOENT",
      });
      expect(await momentIds(store)).toEqual(before);
      expect(listMoments).toHaveBeenCalledTimes(2);
    } finally {
      await store.close();
    }
  });

  it("keeps the recipient's own new file at a pending untracked path", async () => {
    const rootDir = await createTestScratch("dohc-shared-view-desktop-");
    const relay = new FakeShareRelay();
    const harness = daemonHarness(relay);
    const path = "docs/gone.md";
    const target = { workspaceId: WORKSPACE, rootPath: rootDir };
    relay.addWrite(path, "granter body");
    relay.addWrite("docs/keep.md", "keep");
    await refreshSharedViewOnce(harness, {
      rootDir,
      workspaceId: WORKSPACE,
      shareId: SHARE_ID,
    });
    relay.addDelete(path);

    const store = harness.openStore(target);
    try {
      let armed = false;
      const realPull = harness.pullFor(target);
      const failingStore: typeof store = {
        ...store,
        async ensureMainVersion(input) {
          if (armed) {
            throw Object.assign(new Error("EBUSY: projection write failed"), {
              code: "EBUSY",
            });
          }
          return await store.ensureMainVersion(input);
        },
      };
      await expect(
        reconcileStandaloneForTest({
          rootDir,
          workspaceId: WORKSPACE,
          relay: harness.relay,
          shareId: SHARE_ID,
          store: failingStore,
          ended: false,
          pull: async (input) => {
            const page = await realPull(input);
            armed = true;
            return page;
          },
          pinnedSelector: { ...PINNED_SELECTOR, access: "edit" },
          recordRefusals: async () => undefined,
        }),
      ).resolves.toEqual({
        ok: false,
        changedPaths: 0,
        errorMessage: "EBUSY: projection write failed",
      });
      armed = false;
      await expect(readPendingMaterializationPaths(rootDir)).resolves.toEqual(
        new Set([path]),
      );
      const main = await store.ensureMainVersion({ workspaceId: WORKSPACE });
      await expect(
        store.readTextFile({
          workspaceId: WORKSPACE,
          versionId: main.id,
          path,
        }),
      ).resolves.toBeNull();

      await writeFile(join(rootDir, path), "my own new file", "utf8");
      const beforeIds = await momentIds(store);

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
        collisionRecordQuarantined: false,
        repairedPaths: 0,
        unjournalablePaths: [],
      });
      expect(await readFile(join(rootDir, path), "utf8")).toBe(
        "my own new file",
      );
      await expect(
        store.readTextFile({
          workspaceId: WORKSPACE,
          versionId: main.id,
          path,
        }),
      ).resolves.toBeNull();
      expect(await momentIds(store)).toEqual(beforeIds);
      await expect(readPendingMaterializationPaths(rootDir)).resolves.toEqual(
        new Set(),
      );
    } finally {
      await store.close();
    }
  });

  it("logs tracked metadata that has no readable store snapshot", async () => {
    const rootDir = await createTestScratch("dohc-shared-view-desktop-");
    const relay = new FakeShareRelay();
    const harness = daemonHarness(relay);
    const path = "docs/inconsistent.md";
    const target = { workspaceId: WORKSPACE, rootPath: rootDir };
    relay.addWrite(path, "before");
    await refreshSharedViewOnce(harness, {
      rootDir,
      workspaceId: WORKSPACE,
      shareId: SHARE_ID,
    });
    await writeFile(join(rootDir, path), "after", "utf8");

    const store = harness.openStore(target);
    const inconsistentStore: typeof store = {
      ...store,
      async readTextFile(input) {
        if (input.path === path) return null;
        return await store.readTextFile(input);
      },
    };
    const error = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    try {
      const main = await store.ensureMainVersion({ workspaceId: WORKSPACE });
      await expect(
        captureSharedViewLocalDivergence(
          rootDir,
          WORKSPACE,
          inconsistentStore,
          true,
          SHARE_ID,
        ),
      ).resolves.toEqual({
        capturedPaths: 0,
        collisionRecordQuarantined: false,
        repairedPaths: 0,
        unjournalablePaths: [],
      });
      expect(error).toHaveBeenCalledWith(
        expect.stringContaining(`workspace ${WORKSPACE} version ${main.id}`),
      );
      expect(error).toHaveBeenCalledWith(expect.stringContaining(path));
    } finally {
      error.mockRestore();
      await store.close();
    }
  });

  it("counts local changes captured before the pull discovers the share ended", async () => {
    const rootDir = await createTestScratch("dohc-shared-view-desktop-");
    const relay = new FakeShareRelay();
    const harness = daemonHarness(relay);
    const path = "docs/ended.md";
    const target = { workspaceId: WORKSPACE, rootPath: rootDir };
    relay.addWrite(path, "before");
    await refreshSharedViewOnce(harness, {
      rootDir,
      workspaceId: WORKSPACE,
      shareId: SHARE_ID,
    });
    await writeFile(join(rootDir, path), "recipient edit", "utf8");
    relay.ended = true;

    const store = harness.openStore(target);
    try {
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
      ).resolves.toMatchObject({ status: "ended", changedPaths: 1 });
      await expect(
        lstat(join(recordsDir(rootDir), "pull-in-flight.marker")),
      ).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      await store.close();
    }
  });

  it("records per-path debt before post-pull classification fails", async () => {
    const rootDir = await createTestScratch("dohc-shared-view-desktop-");
    const relay = new FakeShareRelay();
    const harness = daemonHarness(relay);
    const path = "docs/pull-window.md";
    const target = { workspaceId: WORKSPACE, rootPath: rootDir };
    relay.addWrite(path, "moment A");
    await refreshSharedViewOnce(harness, {
      rootDir,
      workspaceId: WORKSPACE,
      shareId: SHARE_ID,
    });

    const store = harness.openStore(target);
    try {
      const main = await store.ensureMainVersion({ workspaceId: WORKSPACE });
      const preTrackedPaths = new Set([path]);
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
            path,
            text: "moment B",
            metadata: { origin: "sync" },
          });
          return {
            fetched: 1,
            applied: 1,
            skipped: 0,
            nextCursor: 2,
            refusalCount: 0,
            refusals: [],
            changedPaths: [{ path, operation: "write", contentKind: "text" }],
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
      await expect(readPendingMaterializationPaths(rootDir)).resolves.toEqual(
        new Set([path]),
      );
      const beforeRecovery = await momentIds(store);

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

      expect(await readFile(join(rootDir, path), "utf8")).toBe("moment B");
      expect(await momentIds(store)).toEqual(beforeRecovery);
      await expect(
        readFile(join(recordsDir(rootDir), "pull-in-flight.marker"), "utf8"),
      ).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      await store.close();
    }
  });

  it("clears every retry count after materializing the latest canonical value", async () => {
    const rootDir = await createTestScratch("dohc-shared-view-desktop-");
    const path = "docs/retried.md";
    const pendingRecord = join(
      recordsDir(rootDir),
      "pending-materialization.json",
    );
    await writePendingMaterializationPaths(rootDir, [path]);
    const commitCursor = vi.fn(async () => undefined);

    await refreshSharedViewOnceWithPull({
      rootDir,
      workspaceId: WORKSPACE,
      relay: new FakeShareRelay().connection(),
      shareId: SHARE_ID,
      pinnedSelector: PINNED_SELECTOR,
      recordRefusals: async () => undefined,
      store: stubStore(async () => ({ text: "latest canonical body" })),
      trackPendingMaterialization: true,
      pull: async (input) => {
        await input.recordChangedPaths?.([path]);
        await expect(readFile(pendingRecord, "utf8")).resolves.toBe(
          JSON.stringify({ counts: { [path]: 2 } }),
        );
        return {
          fetched: 1,
          applied: 1,
          skipped: 0,
          nextCursor: 2,
          refusalCount: 0,
          refusals: [],
          changedPaths: [{ path, operation: "write", contentKind: "text" }],
          commitCursor,
        };
      },
    });

    await expect(readPendingMaterializationPaths(rootDir)).resolves.toEqual(
      new Set(),
    );
    await expect(readFile(join(rootDir, path), "utf8")).resolves.toBe(
      "latest canonical body",
    );
    expect(commitCursor).toHaveBeenCalledOnce();
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

  it("clears an absent pull marker without creating metadata", async () => {
    const rootDir = await createTestScratch("dohc-shared-view-desktop-");
    const metadataDir = join(rootDir, ".dohc");

    await expect(clearPullInFlightMarker(rootDir)).resolves.toBeUndefined();

    await expect(lstat(metadataDir)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("clears a stale pull marker only after a full successful capture", async () => {
    const rootDir = await createTestScratch("dohc-shared-view-desktop-");
    const relay = new FakeShareRelay();
    const harness = daemonHarness(relay);
    const path = "notes/recovered.md";
    relay.addWrite(path, "canonical\n");
    await refreshSharedViewOnce(harness, {
      rootDir,
      workspaceId: WORKSPACE,
      shareId: SHARE_ID,
    });
    await writeFile(
      join(await openedRecordsDir(rootDir), "pull-in-flight.marker"),
      "",
    );

    const store = harness.openStore({
      workspaceId: WORKSPACE,
      rootPath: rootDir,
    });
    try {
      await expect(
        readSharedViewProjectionDebt(rootDir, SHARE_ID),
      ).resolves.toMatchObject({
        pullInFlight: true,
      });

      await captureSharedViewLocalDivergence(
        rootDir,
        WORKSPACE,
        store,
        true,
        SHARE_ID,
        {
          paths: [path],
        },
      );
      await expect(
        readSharedViewProjectionDebt(rootDir, SHARE_ID),
      ).resolves.toMatchObject({
        pullInFlight: true,
      });

      await expect(
        captureSharedViewLocalDivergence(
          rootDir,
          WORKSPACE,
          store,
          true,
          SHARE_ID,
        ),
      ).resolves.toMatchObject({
        unjournalablePaths: [],
      });
      await expect(
        readSharedViewProjectionDebt(rootDir, SHARE_ID),
      ).resolves.toEqual({
        pendingPaths: new Set(),
        collisionPaths: new Set(),
        pullInFlight: false,
      });
    } finally {
      await store.close();
    }
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

  it("reports an ended share when pull-marker cleanup finds a metadata symlink", async () => {
    const rootDir = await createTestScratch("dohc-shared-view-desktop-");
    const outsideDir = await createTestScratch("dohc-shared-view-desktop-");
    const metadataDir = join(rootDir, ".dohc");
    await openedView(rootDir);

    const outcome = refreshSharedViewOnceWithPull({
      rootDir,
      workspaceId: WORKSPACE,
      relay: new FakeShareRelay().connection(),
      shareId: SHARE_ID,
      pinnedSelector: PINNED_SELECTOR,
      recordRefusals: async () => undefined,
      store: stubStore(async () => ({ text: "unused" })),
      trackPendingMaterialization: true,
      pull: async () => {
        await rm(metadataDir, { force: true, recursive: true });
        await symlink(
          outsideDir,
          metadataDir,
          process.platform === "win32" ? "junction" : "dir",
        );
        throw new ShareUnavailableError();
      },
    });

    await expect(outcome).resolves.toMatchObject({ status: "ended" });
    expect(await readdir(outsideDir)).toEqual([]);
    expect((await lstat(metadataDir)).isSymbolicLink()).toBe(true);
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

  it("leaves a pending record after refresh materialization throws and repairs it later", async () => {
    const rootDir = await createTestScratch("dohc-shared-view-desktop-");
    const relay = new FakeShareRelay();
    const harness = daemonHarness(relay);
    const path = "docs/interrupted.md";
    const target = { workspaceId: WORKSPACE, rootPath: rootDir };
    relay.addWrite(path, "moment A");
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
        text: "moment B",
        metadata: { origin: "sync" },
      });
      await writeFile(join(rootDir, path), "moment A", "utf8");
      const before = await store.listMoments({
        workspaceId: WORKSPACE,
        limit: 100,
      });
      const commitCursor = vi.fn(async () => undefined);
      const pullResult: PullShareViewResult = {
        fetched: 1,
        applied: 1,
        skipped: 0,
        nextCursor: 1,
        refusalCount: 0,
        refusals: [],
        changedPaths: [{ path, operation: "write", contentKind: "text" }],
        commitCursor,
      };
      const throwingStore: typeof store = {
        ...store,
        async readTextFile() {
          throw new Error("materialization interrupted");
        },
      };

      await expect(
        refreshSharedViewOnceWithPull({
          rootDir,
          workspaceId: WORKSPACE,
          relay: harness.relay,
          shareId: SHARE_ID,
          pinnedSelector: PINNED_SELECTOR,
          recordRefusals: async () => undefined,
          store: throwingStore,
          trackPendingMaterialization: true,
          pull: async () => pullResult,
        }),
      ).rejects.toThrow("materialization interrupted");
      await expect(
        readFile(
          join(recordsDir(rootDir), "pending-materialization.json"),
          "utf8",
        ),
      ).resolves.toBe(JSON.stringify({ counts: { [path]: 1 } }));
      expect(commitCursor).not.toHaveBeenCalled();

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
        collisionRecordQuarantined: false,
        repairedPaths: 1,
        unjournalablePaths: [],
      });
      expect(await readFile(join(rootDir, path), "utf8")).toBe("moment B");
      const after = await store.listMoments({
        workspaceId: WORKSPACE,
        limit: 100,
      });
      expect(after.moments.map((moment) => moment.id)).toEqual(
        before.moments.map((moment) => moment.id),
      );
    } finally {
      await store.close();
    }
  });

  it("preserves an older disk body after two writes and a failed materialization", async () => {
    const rootDir = await createTestScratch("dohc-shared-view-desktop-");
    const relay = new FakeShareRelay();
    const harness = daemonHarness(relay);
    const path = "docs/twice.md";
    const target = { workspaceId: WORKSPACE, rootPath: rootDir };
    relay.addWrite(path, "granter one");
    await refreshSharedViewOnce(harness, {
      rootDir,
      workspaceId: WORKSPACE,
      shareId: SHARE_ID,
    });
    expect(await readFile(join(rootDir, path), "utf8")).toBe("granter one");
    relay.addWrite(path, "granter two");
    relay.addWrite(path, "granter three");

    const store = harness.openStore(target);
    let failProjection = true;
    const failingStore: typeof store = {
      ...store,
      async readTextFile(input) {
        if (failProjection && input.path === path) {
          throw Object.assign(new Error("EBUSY: projection write failed"), {
            code: "EBUSY",
          });
        }
        return await store.readTextFile(input);
      },
    };
    try {
      await expect(
        refreshSharedViewOnceWithPull({
          rootDir,
          workspaceId: WORKSPACE,
          relay: harness.relay,
          shareId: SHARE_ID,
          store: failingStore,
          pull: harness.pullFor(target),
          pinnedSelector: { ...PINNED_SELECTOR, access: "edit" },
          recordRefusals: async () => undefined,
          trackPendingMaterialization: true,
        }),
      ).rejects.toThrow("EBUSY: projection write failed");
      failProjection = false;

      const main = await store.ensureMainVersion({ workspaceId: WORKSPACE });
      await expect(
        store.readTextFile({
          workspaceId: WORKSPACE,
          versionId: main.id,
          path,
        }),
      ).resolves.toMatchObject({ text: "granter three" });
      expect(await readFile(join(rootDir, path), "utf8")).toBe("granter one");

      const recovered = await reconcileStandaloneForTest({
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
      expect(recovered).toMatchObject({
        status: "updated",
        changedPaths: 1,
        unjournalablePaths: [{ path, reason: "local-collision" }],
      });

      const moments = (
        await store.listMoments({ workspaceId: WORKSPACE, limit: 200 })
      ).moments.filter((moment) => moment.path === path);
      const bodies = await Promise.all(
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
      expect(bodies.filter((body) => body === "granter one")).toHaveLength(1);
      await expect(
        store.readTextFile({
          workspaceId: WORKSPACE,
          versionId: main.id,
          path,
        }),
      ).resolves.toMatchObject({ text: "granter three" });
      expect(await readFile(join(rootDir, path), "utf8")).toBe("granter one");
      await expect(
        readFile(
          join(recordsDir(rootDir), "pending-materialization.json"),
          "utf8",
        ),
      ).resolves.toContain(path);
    } finally {
      failProjection = false;
      await store.close();
    }
  });

  it("issues zero readdir calls when a tracked view sits beside an untracked subtree", async () => {
    const rootDir = await createTestScratch("dohc-shared-view-desktop-");
    const relay = new FakeShareRelay();
    const harness = daemonHarness(relay);
    const path = "docs/tracked.md";
    relay.addWrite(path, "tracked body");
    await refreshSharedViewOnce(harness, {
      rootDir,
      workspaceId: WORKSPACE,
      shareId: SHARE_ID,
    });
    await mkdir(join(rootDir, "untracked", "nested"), { recursive: true });
    await writeFile(join(rootDir, "untracked", "one.txt"), "one", "utf8");
    await writeFile(
      join(rootDir, "untracked", "nested", "two.txt"),
      "two",
      "utf8",
    );

    const store = harness.openStore({
      workspaceId: WORKSPACE,
      rootPath: rootDir,
    });
    try {
      readdirCalls = [];
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
        collisionRecordQuarantined: false,
        repairedPaths: 0,
        unjournalablePaths: [],
      });
      expect(readdirCalls).toEqual([]);
    } finally {
      await store.close();
    }
  });

  it("captures an out-of-app delete as a local-file moment", async () => {
    const rootDir = await createTestScratch("dohc-shared-view-desktop-");
    const relay = new FakeShareRelay();
    const harness = daemonHarness(relay);
    const path = "docs/deleted.md";
    relay.addWrite(path, "remove me");
    await refreshSharedViewOnce(harness, {
      rootDir,
      workspaceId: WORKSPACE,
      shareId: SHARE_ID,
    });
    await rm(join(rootDir, path));

    const store = harness.openStore({
      workspaceId: WORKSPACE,
      rootPath: rootDir,
    });
    try {
      const before = await store.listMoments({
        workspaceId: WORKSPACE,
        limit: 100,
      });
      const beforeIds = new Set(before.moments.map((moment) => moment.id));
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
        collisionRecordQuarantined: false,
        repairedPaths: 0,
        unjournalablePaths: [],
      });

      const main = await store.ensureMainVersion({ workspaceId: WORKSPACE });
      await expect(
        store.readTextFile({
          workspaceId: WORKSPACE,
          versionId: main.id,
          path,
        }),
      ).resolves.toBeNull();
      const after = await store.listMoments({
        workspaceId: WORKSPACE,
        limit: 100,
      });
      const captured = after.moments.find(
        (moment) => !beforeIds.has(moment.id),
      );
      expect(captured).toMatchObject({
        path,
        operation: "delete",
        metadata: { origin: "local-file" },
      });
    } finally {
      await store.close();
    }
  });

  itNonRoot(
    "reports a tracked path below an unreadable directory and still captures an absent directory",
    async () => {
      const rootDir = await createTestScratch("dohc-shared-view-desktop-");
      const relay = new FakeShareRelay();
      const harness = daemonHarness(relay);
      const path = "locked/tracked.md";
      const parent = join(rootDir, "locked");
      relay.addWrite(path, "tracked body");
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
        await denyRead(parent, "dir");
        try {
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
            collisionRecordQuarantined: false,
            repairedPaths: 0,
            unjournalablePaths: [{ path, reason: "unreadable" }],
          });
        } finally {
          await restoreRead(parent, 0o755);
        }

        await rm(parent, { recursive: true });
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
          collisionRecordQuarantined: false,
          repairedPaths: 0,
          unjournalablePaths: [],
        });
      } finally {
        await store.close();
      }
    },
  );

  itNonRoot(
    "preserves an earlier repair count when pending path resolution finds an unreadable directory",
    async () => {
      const rootDir = await createTestScratch("dohc-shared-view-desktop-");
      const relay = new FakeShareRelay();
      const harness = daemonHarness(relay);
      const repairedPath = "docs/a-repaired-first.md";
      const deniedPath = "docs/z-locked/pending.md";
      const parent = join(rootDir, "docs", "z-locked");
      const target = { workspaceId: WORKSPACE, rootPath: rootDir };
      relay.addWrite(repairedPath, "already correct body");
      relay.addWrite(deniedPath, "tracked body");
      await refreshSharedViewOnce(harness, {
        rootDir,
        workspaceId: WORKSPACE,
        shareId: SHARE_ID,
      });
      await writePendingMaterializationPaths(rootDir, [
        repairedPath,
        deniedPath,
      ]);

      const store = harness.openStore(target);
      try {
        await denyRead(parent, "dir");
        try {
          await expect(
            reconcileStandaloneForTest({
              rootDir,
              workspaceId: WORKSPACE,
              relay: harness.relay,
              shareId: SHARE_ID,
              store,
              pull: harness.pullFor(target),
              pinnedSelector: PINNED_SELECTOR,
              recordRefusals: async () => undefined,
              ended: false,
            }),
          ).rejects.toMatchObject({
            name: "CapturePartialFailureError",
            capturedPaths: 0,
            repairedPaths: 1,
            path: deniedPath,
            reason: "unreadable",
          });
        } finally {
          await restoreRead(parent, 0o755);
        }
      } finally {
        await store.close();
      }
    },
  );

  it("preserves a repair count when clearing its pending marker fails", async () => {
    const rootDir = await createTestScratch("dohc-shared-view-desktop-");
    const relay = new FakeShareRelay();
    const harness = daemonHarness(relay);
    const path = "docs/already-correct.md";
    const target = { workspaceId: WORKSPACE, rootPath: rootDir };
    relay.addWrite(path, "already correct body");
    await refreshSharedViewOnce(harness, {
      rootDir,
      workspaceId: WORKSPACE,
      shareId: SHARE_ID,
    });
    await writePendingMaterializationPaths(rootDir, [path]);
    await writePendingMaterializationPaths(rootDir, [path]);

    const store = harness.openStore(target);
    try {
      failRenameToPathOnce = {
        path: join(recordsDir(rootDir), "pending-materialization.json"),
        error: new Error("pending marker unavailable"),
      };
      await expect(
        reconcileStandaloneForTest({
          rootDir,
          workspaceId: WORKSPACE,
          relay: harness.relay,
          shareId: SHARE_ID,
          store,
          pull: harness.pullFor(target),
          pinnedSelector: PINNED_SELECTOR,
          recordRefusals: async () => undefined,
          ended: false,
        }),
      ).rejects.toMatchObject({
        name: "CapturePartialFailureError",
        capturedPaths: 0,
        repairedPaths: 1,
        path,
        reason: "other",
      });
    } finally {
      failRenameToPathOnce = null;
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

  it("preserves resolved collision repairs when clearing durable debt fails", async () => {
    const rootDir = await createTestScratch("dohc-shared-view-desktop-");
    const relay = new FakeShareRelay();
    const harness = daemonHarness(relay);
    const path = "docs/resolved-collision.md";
    const target = { workspaceId: WORKSPACE, rootPath: rootDir };
    relay.addWrite(path, "granter body");
    await refreshSharedViewOnce(harness, {
      rootDir,
      workspaceId: WORKSPACE,
      shareId: SHARE_ID,
    });
    await recordCollisionPaths(rootDir, SHARE_ID, [path]);
    await rm(join(rootDir, path));

    const store = harness.openStore(target);
    try {
      const cleanupFailure = new Error("collision record unavailable");
      failRemovePathOnce = {
        path: join(recordsDir(rootDir), "share-collision-record.json"),
        error: cleanupFailure,
      };

      await expect(
        captureStandaloneShareViewRefresh({
          rootDir,
          workspaceId: WORKSPACE,
          store,
          pinnedSelector: PINNED_SELECTOR,
          shareId: SHARE_ID,
          ended: false,
        }),
      ).resolves.toEqual({
        ok: false,
        changedPaths: 1,
        errorMessage: cleanupFailure.message,
      });
      expect(await readFile(join(rootDir, path), "utf8")).toBe(
        "granter body",
      );
    } finally {
      failRemovePathOnce = null;
      await store.close();
    }
  });

  it("preserves captured deletions when clearing the pull marker fails", async () => {
    const rootDir = await createTestScratch("dohc-shared-view-desktop-");
    const relay = new FakeShareRelay();
    const harness = daemonHarness(relay);
    const path = "docs/captured-before-marker-cleanup.md";
    const target = { workspaceId: WORKSPACE, rootPath: rootDir };
    relay.addWrite(path, "granter body");
    await refreshSharedViewOnce(harness, {
      rootDir,
      workspaceId: WORKSPACE,
      shareId: SHARE_ID,
    });
    await rm(join(rootDir, path));
    const markerPath = join(
      await openedRecordsDir(rootDir),
      "pull-in-flight.marker",
    );
    await writeFile(markerPath, "", "utf8");

    const store = harness.openStore(target);
    try {
      const cleanupFailure = new Error("pull marker unavailable");
      failRemovePathOnce = { path: markerPath, error: cleanupFailure };

      await expect(
        captureStandaloneShareViewRefresh({
          rootDir,
          workspaceId: WORKSPACE,
          store,
          pinnedSelector: { ...PINNED_SELECTOR, access: "edit" },
          shareId: SHARE_ID,
          ended: false,
        }),
      ).resolves.toEqual({
        ok: false,
        changedPaths: 1,
        errorMessage: cleanupFailure.message,
      });
    } finally {
      failRemovePathOnce = null;
      await store.close();
    }
  });

  it("keeps an engine failure inside pending repair distinct from an unreadable path", async () => {
    const rootDir = await createTestScratch("dohc-shared-view-desktop-");
    const relay = new FakeShareRelay();
    const harness = daemonHarness(relay);
    const path = "docs/engine-failure.md";
    const target = { workspaceId: WORKSPACE, rootPath: rootDir };
    relay.addWrite(path, "moment A");
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
        text: "moment B",
        metadata: { origin: "sync" },
      });
      await writePendingMaterializationPaths(rootDir, [path]);
      let pathReads = 0;
      const failingStore: typeof store = {
        ...store,
        async readTextFile(input) {
          if (input.path === path && ++pathReads === 2) {
            throw new Error("engine store unavailable");
          }
          return await store.readTextFile(input);
        },
      };

      await expect(
        reconcileStandaloneForTest({
          rootDir,
          workspaceId: WORKSPACE,
          relay: harness.relay,
          shareId: SHARE_ID,
          store: failingStore,
          pull: harness.pullFor(target),
          pinnedSelector: PINNED_SELECTOR,
          recordRefusals: async () => undefined,
          ended: false,
        }),
      ).rejects.toMatchObject({
        name: "CapturePartialFailureError",
        capturedPaths: 0,
        repairedPaths: 0,
        path,
        reason: "other",
        message: "engine store unavailable",
      });
    } finally {
      await store.close();
    }
  });

  it(
    "preserves a leftover repair when pending path resolution fails",
    async () => {
      const rootDir = await createTestScratch("dohc-shared-view-desktop-");
      const relay = new FakeShareRelay();
      const harness = daemonHarness(relay);
      const repairedPath = "docs/a-repaired-first.md";
      const deniedPath = "docs/z-locked/pending-delete.md";
      const parent = join(rootDir, "docs", "z-locked");
      const target = { workspaceId: WORKSPACE, rootPath: rootDir };
      relay.addWrite(repairedPath, "first body");
      relay.addWrite(deniedPath, "second body");
      await refreshSharedViewOnce(harness, {
        rootDir,
        workspaceId: WORKSPACE,
        shareId: SHARE_ID,
      });

      const store = harness.openStore(target);
      try {
        const main = await store.ensureMainVersion({ workspaceId: WORKSPACE });
        for (const path of [repairedPath, deniedPath]) {
          await store.deleteTextFile({
            workspaceId: WORKSPACE,
            versionId: main.id,
            path,
            metadata: { origin: "sync" },
          });
        }
        await writePendingMaterializationPaths(rootDir, [
          repairedPath,
          deniedPath,
        ]);
        await rm(join(rootDir, repairedPath));
        realpathOverride = (path) => {
          if (path === parent) {
            throw Object.assign(new Error("Pending parent is unreadable."), {
              code: deniedReadCode,
            });
          }
          return null;
        };
        try {
          await expect(
            reconcileStandaloneForTest({
              rootDir,
              workspaceId: WORKSPACE,
              relay: harness.relay,
              shareId: SHARE_ID,
              store,
              pull: harness.pullFor(target),
              pinnedSelector: PINNED_SELECTOR,
              recordRefusals: async () => undefined,
              ended: false,
            }),
          ).rejects.toMatchObject({
            name: "CapturePartialFailureError",
            capturedPaths: 0,
            repairedPaths: 1,
            path: deniedPath,
            reason: "unreadable",
          });
          await expect(readPendingMaterializationPaths(rootDir)).resolves.toEqual(
            new Set([deniedPath]),
          );
        } finally {
          realpathOverride = null;
        }
      } finally {
        await store.close();
      }
    },
  );

  itNonRoot(
    "reports a pending path below an unreadable directory and recovers when access returns",
    async () => {
      const rootDir = await createTestScratch("dohc-shared-view-desktop-");
      const relay = new FakeShareRelay();
      const harness = daemonHarness(relay);
      const repairedPath = "docs/a-repaired-first.md";
      const deniedPath = "docs/z-locked/pending.md";
      const parent = join(rootDir, "docs", "z-locked");
      const target = { workspaceId: WORKSPACE, rootPath: rootDir };
      relay.addWrite(repairedPath, "already correct body");
      relay.addWrite(deniedPath, "tracked body");
      await refreshSharedViewOnce(harness, {
        rootDir,
        workspaceId: WORKSPACE,
        shareId: SHARE_ID,
      });
      await writePendingMaterializationPaths(rootDir, [
        repairedPath,
        deniedPath,
      ]);

      const store = harness.openStore(target);
      try {
        let releaseDeniedPathLock: () => void = () => undefined;
        let markDeniedPathLockHeld: () => void = () => undefined;
        const deniedPathLockHeld = new Promise<void>((resolve) => {
          markDeniedPathLockHeld = resolve;
        });
        const holdDeniedPathLock = new Promise<void>((resolve) => {
          releaseDeniedPathLock = resolve;
        });
        const deniedPathBlocker = withOrderedWorkspaceTargetPath(
          rootDir,
          await realpath(join(rootDir, deniedPath)),
          async () => {
            markDeniedPathLockHeld();
            await holdDeniedPathLock;
          },
        );
        await deniedPathLockHeld;

        // Deny the parent after containment resolves it but before the queued
        // pending branch runs, so that branch's own lstat reports the failure.
        let markDeniedParentResolved: () => void = () => undefined;
        const deniedParentResolved = new Promise<void>((resolve) => {
          markDeniedParentResolved = resolve;
        });
        observeRealpath = (absolutePath) => {
          if (absolutePath === parent) markDeniedParentResolved();
        };
        const refreshing = reconcileStandaloneForTest({
          rootDir,
          workspaceId: WORKSPACE,
          relay: harness.relay,
          shareId: SHARE_ID,
          store,
          pull: harness.pullFor(target),
          pinnedSelector: PINNED_SELECTOR,
          recordRefusals: async () => undefined,
          ended: false,
        });

        let parentDenied = false;
        try {
          await deniedParentResolved;
          await denyRead(parent, "dir");
          parentDenied = true;
          releaseDeniedPathLock();
          await expect(refreshing).rejects.toMatchObject({
            name: "CapturePartialFailureError",
            capturedPaths: 0,
            repairedPaths: 1,
            path: deniedPath,
            reason: "unreadable",
          });
          await expect(
            readPendingMaterializationPaths(rootDir),
          ).resolves.toEqual(new Set([deniedPath]));
        } finally {
          observeRealpath = null;
          releaseDeniedPathLock();
          await deniedPathBlocker;
          if (parentDenied) await restoreRead(parent, 0o755);
        }

        await expect(
          reconcileStandaloneForTest({
            rootDir,
            workspaceId: WORKSPACE,
            relay: harness.relay,
            shareId: SHARE_ID,
            store,
            pull: harness.pullFor(target),
            pinnedSelector: PINNED_SELECTOR,
            recordRefusals: async () => undefined,
            ended: false,
          }),
        ).resolves.toMatchObject({
          ok: true,
          status: "updated",
          changedPaths: 1,
        });
        await expect(readPendingMaterializationPaths(rootDir)).resolves.toEqual(
          new Set(),
        );
      } finally {
        await store.close();
      }
    },
  );

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
        collisionRecordQuarantined: false,
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

  it("does not echo a freshly materialized file into another moment", async () => {
    const rootDir = await createTestScratch("dohc-shared-view-desktop-");
    const relay = new FakeShareRelay();
    const harness = daemonHarness(relay);
    relay.addWrite("docs/a.md", "fresh projection");
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
        collisionRecordQuarantined: false,
        repairedPaths: 0,
        unjournalablePaths: [],
      });
      const after = await store.listMoments({
        workspaceId: WORKSPACE,
        limit: 100,
      });
      expect(after.moments.map((moment) => moment.id)).toEqual(
        before.moments.map((moment) => moment.id),
      );
    } finally {
      await store.close();
    }
  });

  it("refuses to track a secret-classified path in the engine store", async () => {
    const rootDir = await createTestScratch("dohc-shared-view-desktop-");
    const relay = new FakeShareRelay();
    const harness = daemonHarness(relay);
    relay.addWrite("docs/seed.md", "seed");
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
      const main = await store.ensureMainVersion({ workspaceId: WORKSPACE });
      await expect(
        store.writeTextFile({
          workspaceId: WORKSPACE,
          versionId: main.id,
          path: "docs/.env",
          text: "API_TOKEN=do-not-track\n",
          metadata: { origin: "local-file" },
        }),
      ).rejects.toThrow("invalid-path");
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

  // The pin is part of the share record's contract: both accept paths write a
  // selector before the record exists, so a record without a readable one is
  // DAMAGED. Every damaged shape must refuse the pull outright. It must not be
  // repaired from the relay — that ask is the one a relay able to damage or
  // race a record would answer with a wider scope, which is exactly the
  // widening the pin exists to stop.
  const damagedPins: Array<[string, unknown]> = [
    ["absent — the record was never written with one", undefined],
    ["null", null],
    ["not an object", "docs"],
    // Every row below carries a valid access, so each is refused for the
    // reason it names rather than for a missing level.
    ["no paths array", { versionId: "v1", access: "view" }],
    [
      "a non-string path",
      { paths: ["docs", 7], versionId: null, access: "view" },
    ],
    // Selects nothing: the relay refuses to create this one
    // (`empty_selector`) and serves nothing through it.
    ["selects nothing", { paths: [], versionId: null, access: "view" }],
    // A version id the relay could not have issued. These are the dangerous
    // ones: the engine reads any version-bearing selector with no paths as
    // granting every tracked path, so a damaged version must never be read as
    // a version at all.
    ["an empty version id", { paths: [], versionId: "", access: "view" }],
    [
      "a whitespace-only version id",
      { paths: [], versionId: "   ", access: "view" },
    ],
    ["a padded version id", { paths: [], versionId: " v1 ", access: "view" }],
    [
      "an unbounded version id",
      { paths: [], versionId: "v".repeat(129), access: "view" },
    ],
    // The level dimension. A record whose level is missing or
    // unreadable is damaged the same way, and its refresh must not pull at a
    // level nobody granted.
    ["no access at all", { paths: ["docs"], versionId: null }],
    ["a cased access", { paths: ["docs"], versionId: null, access: "View" }],
    ["a padded access", { paths: ["docs"], versionId: null, access: "edit " }],
    [
      "a chat access value",
      { paths: ["docs"], versionId: null, access: "read-write" },
    ],
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

  it("rejects a damaged pin through the standalone refresh wrapper", async () => {
    const rootDir = await createTestScratch("dohc-shared-view-desktop-");
    const relay = new FakeShareRelay();
    const harness = daemonHarness(relay);
    const target = { workspaceId: WORKSPACE, rootPath: rootDir };
    const store = harness.openStore(target);

    try {
      await expect(
        reconcileStandaloneForTest({
          rootDir,
          workspaceId: WORKSPACE,
          relay: harness.relay,
          shareId: SHARE_ID,
          store,
          pull: harness.pullFor(target),
          pinnedSelector: { versionId: "v1", access: "view" },
          recordRefusals: async () => undefined,
          ended: false,
        }),
      ).rejects.toBeInstanceOf(SharePinInvalidError);
    } finally {
      await store.close();
    }
  });

  // The refusal names the constraint, so the handler above it can tell the
  // user what to do instead of reporting "refreshed, nothing new" forever.
  it("names the damaged record in the refusal", async () => {
    const rootDir = await createTestScratch("dohc-shared-view-desktop-");
    const relay = new FakeShareRelay();
    const harness = daemonHarness(relay);

    await expect(
      refreshSharedViewOnceWithPull({
        rootDir,
        workspaceId: WORKSPACE,
        relay: harness.relay,
        shareId: SHARE_ID,
        store: harness.openStore({ workspaceId: WORKSPACE, rootPath: rootDir }),
        pinnedSelector: undefined,
        recordRefusals: async () => undefined,
        pull: async () => {
          throw new Error("unreachable");
        },
      }),
    ).rejects.toThrow(
      /Share share-1 has no readable pinned selector; its record is damaged and the share must be added again\./u,
    );
    await harness.closeAll();
  });

  // A pinned selector is used exactly as recorded, and the relay is never
  // asked to restate it. There is no code path left that could.
  // The pull skips an op it refuses and keeps going, which is the right
  // liveness call — one op a diverging relay serves must not wedge the share.
  // The cost is that the view quietly stops carrying part of what the granter
  // shares, so the refusal has to reach the caller and the user. The engine
  // produces these (see `share_view_pull_reports_why_it_skipped_a_version_
  // refused_op`); what this pins is that the refresh does not swallow them.
  //
  // The daemon double deliberately enforces no grant, so the refusal is
  // supplied here rather than provoked — provoking it would need a second
  // implementation of the boundary rule in a test double, which is how a
  // double starts certifying fiction.
  it("reports the refusals its pull returned instead of swallowing them", async () => {
    const rootDir = await createTestScratch("dohc-shared-view-desktop-");
    const errors: string[] = [];
    const logged = vi
      .spyOn(console, "error")
      .mockImplementation((...args: unknown[]) => {
        errors.push(args.map(String).join(" "));
      });
    try {
      const outcome = await refreshSharedViewOnceWithPull({
        rootDir,
        workspaceId: WORKSPACE,
        relay: { baseUrl: "http://relay.test", token: TOKEN },
        shareId: SHARE_ID,
        pinnedSelector: PINNED_SELECTOR,
        recordRefusals: async () => undefined,
        store: stubStore(async () => {
          throw new Error("no changed path is materialized in this test");
        }),
        pull: async () => ({
          fetched: 2,
          applied: 1,
          skipped: 1,
          refusalCount: 1,
          refusals: [
            {
              originId: "origin-granter",
              originSeq: 7,
              opKind: "moment.append",
              code: "share-boundary-violation",
              detail:
                "replicated moment is outside the share boundary: the share " +
                "granted version main, the relay offered version version-other",
            },
          ],
          changedPaths: [],
          nextCursor: 2,
          commitCursor: async () => undefined,
        }),
      });

      expect(
        outcome.refusedOps,
        "swallowing the refusal leaves a bare count the user never sees",
      ).toBe(1);
      expect(outcome.refusedDetail).toContain("version-other");
      // And it is logged whole, with the op it refused: the count alone
      // cannot be diagnosed.
      const log = errors.join(" | ");
      expect(log).toContain("origin-granter@7");
      expect(log).toContain("version-other");
    } finally {
      logged.mockRestore();
    }
  });

  it("pulls with the pinned selector and never asks the relay for another", async () => {
    const rootDir = await createTestScratch("dohc-shared-view-desktop-");
    const relay = new FakeShareRelay();
    const harness = daemonHarness(relay);
    relay.addWrite("docs/a.md", "first body");

    const first = await refreshSharedViewOnce(harness, {
      rootDir,
      workspaceId: WORKSPACE,
      shareId: SHARE_ID,
      pinnedSelector: { paths: ["docs"], versionId: null, access: "view" },
      recordRefusals: async () => undefined,
    });
    expect(first).toEqual({
      status: "updated",
      changedPaths: 1,
      excludedPaths: [],
      unjournalablePaths: [],
      refusedOps: 0,
      refusedDetail: null,
    });
    expect(await readFile(join(rootDir, "docs/a.md"), "utf8")).toBe(
      "first body",
    );

    relay.addWrite("docs/b.md", "second body");
    const second = await refreshSharedViewOnce(harness, {
      rootDir,
      workspaceId: WORKSPACE,
      shareId: SHARE_ID,
      pinnedSelector: { paths: ["docs"], versionId: null, access: "view" },
      recordRefusals: async () => undefined,
    });
    expect(second).toEqual({
      status: "updated",
      changedPaths: 1,
      excludedPaths: [],
      unjournalablePaths: [],
      refusedOps: 0,
      refusedDetail: null,
    });

    // The share metadata route is what a re-pin would have to call. Nothing
    // in a refresh touches it.
    expect(
      relay.metadataRequests,
      "re-fetching the selector lets the relay restate the grant on every pull",
    ).toBe(0);
  });

  // A read that fails must not cost the user the file they already had.
  // preparedTarget removes the existing projection, so reading afterwards
  // would leave a hole — and because the cursor is only committed after a
  // clean pass, every later refresh would replay into the same hole.
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

  if (process.platform === "win32") {
    it("refuses a parent that resolves under a case-distinct sibling", async () => {
      const rootDir = await createTestScratch("dohc-shared-view-desktop-");
      const parent = join(rootDir, "docs");
      await mkdir(parent);
      const siblingRoot = join(
        dirname(rootDir),
        basename(rootDir).toUpperCase(),
      );

      await expect(
        materializeSharedViewPaths(
          rootDir,
          WORKSPACE,
          [{ path: "docs/a.md", operation: "write", contentKind: "text" }],
          stubStore(async () => {
            // Turn on the simulated symlink resolution after the common
            // workspace resolver has judged the target. This isolates the
            // real-parent isInside guard in materializeSharedViewPaths.
            realpathOverride = (path) =>
              path === parent ? join(siblingRoot, "docs") : null;
            return { text: "must not be written" };
          }),
        ),
      ).rejects.toThrow(/parent escapes the workspace/i);
    });
  }
});

// Which share views ask for a sync identity.
//
// The main process runs this before an Edit share submits document changes.
// It must fail closed on every tri-state: skip, never throw, and never enrol a
// share outside that proposal lane.
// A shared view's refresh records describe what this computer did to its own
// copy, so they live in its `.dohc/local/share-refresh`, written only after
// the engine's open prepared `.dohc/local`. A record dohc can't trust never
// lets a refresh replace the person's files or count a pull as finished.
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

  // An old collision record is the exception: see the test after this one.
  it("ignores a pull marker and pending record left at the top of .dohc, and leaves them there", async () => {
    const rootDir = await createTestScratch("dohc-shared-view-records-");
    const relay = new FakeShareRelay();
    const harness = daemonHarness(relay);
    const target = { workspaceId: WORKSPACE, rootPath: rootDir };
    relay.addWrite("docs/seed.md", "seed");
    await refreshSharedViewOnce(harness, {
      rootDir,
      workspaceId: WORKSPACE,
      shareId: SHARE_ID,
    });
    const old = {
      "pull-in-flight.marker": "",
      "pending-materialization.json": JSON.stringify({ counts: { "docs/seed.md": 1 } }),
    };
    for (const [name, content] of Object.entries(old)) {
      await writeFile(join(rootDir, ".dohc", name), content, { mode: 0o600 });
    }
    await expect(readSharedViewProjectionDebt(rootDir, SHARE_ID)).resolves.toEqual({
      pendingPaths: new Set(),
      collisionPaths: new Set(),
      pullInFlight: false,
    });

    relay.addWrite("docs/seed.md", "seed two");
    const store = harness.openStore(target);
    try {
      await expect(
        reconcileStandaloneForTest({
          rootDir,
          workspaceId: WORKSPACE,
          relay: harness.relay,
          shareId: SHARE_ID,
          store,
          pull: harness.pullFor(target),
          pinnedSelector: PINNED_SELECTOR,
          recordRefusals: async () => undefined,
          ended: false,
        }),
      ).resolves.toMatchObject({ ok: true, status: "updated", unjournalablePaths: [] });
    } finally {
      await store.close();
    }
    // The old records changed nothing, and nothing touched them.
    expect(await readFile(join(rootDir, "docs/seed.md"), "utf8")).toBe("seed two");
    for (const [name, content] of Object.entries(old)) {
      expect(await readFile(join(rootDir, ".dohc", name), "utf8")).toBe(content);
    }
  });

  // A view updated from before #2372 may have its collision record at the top
  // of `.dohc`. With no new record, ordinary rules would replace the files it
  // kept apart, so the refresh refuses until the person moves the old one.
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

  // Sol's case: a folder dohc can't look into is not a folder with no records.
  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "refuses a refresh while it can't look into .dohc, and keeps the person's file",
    async () => {
      const view = await collidedView();
      const dohc = join(view.rootDir, ".dohc");
      const errorLog = vi.spyOn(console, "error").mockImplementation(() => undefined);
      try {
        view.relay.addWrite(view.path, "granter file two");
        const logRequests = view.relay.logRequests;
        await chmod(dohc, 0o600);
        try {
          await expect(view.refresh()).resolves.toEqual({
            ok: false,
            changedPaths: 0,
            errorMessage:
              "dohc did not update these shared files. This workspace's .dohc/local can't be read. Make sure you can open it, then try again.",
          });
        } finally {
          await chmod(dohc, 0o700);
        }
        expect(view.relay.logRequests).toBe(logRequests);
        expect(await readFile(join(view.rootDir, view.path), "utf8")).toBe("my own file");
        expect(await readdir(recordsDir(view.rootDir))).toEqual(["share-collision-record.json"]);
      } finally {
        errorLog.mockRestore();
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

  it.each([
    ["has not finished opening", closedViews, "dohc did not update these shared files because the workspace has not finished opening. Try again when it opens."],
    ["can't keep .dohc/local out of iCloud Drive", unexcludedViews, "dohc did not update these shared files because it can't keep .dohc/local out of iCloud Drive. Restart dohc to try again."],
  ] as const)(
    "refuses a refresh while the view %s, changes nothing, and keeps protecting the person's file",
    async (_state, views, errorMessage) => {
      const view = await collidedView();
      try {
        view.relay.addWrite(view.path, "granter file two");
        view.relay.addWrite("docs/new.md", "new");
        const record = await readFile(view.collisionRecord, "utf8");
        const logRequests = view.relay.logRequests;

        views.add(view.rootDir);
        await expect(view.refresh()).resolves.toEqual({ ok: false, changedPaths: 0, errorMessage });
        expect(view.relay.logRequests).toBe(logRequests);
        expect(await readFile(join(view.rootDir, view.path), "utf8")).toBe("my own file");
        await expect(stat(join(view.rootDir, "docs/new.md"))).rejects.toMatchObject({ code: "ENOENT" });
        expect(await readdir(recordsDir(view.rootDir))).toEqual(["share-collision-record.json"]);
        expect(await readFile(view.collisionRecord, "utf8")).toBe(record);

        views.delete(view.rootDir);
        await expect(view.refresh()).resolves.toMatchObject({
          ok: true,
          status: "updated",
          unjournalablePaths: [{ path: view.path, reason: "local-collision" }],
        });
        expect(await readFile(join(view.rootDir, view.path), "utf8")).toBe("my own file");
        expect(await readFile(join(view.rootDir, "docs/new.md"), "utf8")).toBe("new");
      } finally {
        await view.store.close();
      }
    },
  );

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

  // What another user, a second name or a link could make a collision record
  // say. The planted record protects nothing, so a refresh that trusted it
  // would replace the person's file with the granter's.
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

  // The granter deleted a file and the pull stopped before removing it from
  // the folder. A pending record of dohc's own lets capture finish that
  // delete; one dohc can't trust must not delete anything.
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
          collisionRecordQuarantined: false,
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

  // A marker says the store may be ahead of the folder. One dohc can't trust
  // still says so, and capture checks every tracked path before it counts the
  // pull as finished.
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

  it("never reads a view under a linked .dohc/local as current", async () => {
    const view = await collidedView();
    const elsewhere = await createTestScratch("dohc-shared-view-records-elsewhere-");
    try {
      // What the link leads to holds no records at all.
      const local = join(view.rootDir, ".dohc", "local");
      await rename(local, join(elsewhere, "moved"));
      await mkdir(join(elsewhere, "empty"));
      await symlink(join(elsewhere, "empty"), local, "dir");
      await expect(readSharedViewProjectionDebt(view.rootDir, SHARE_ID)).rejects.toThrow(
        "This workspace's .dohc/local is a link.",
      );
      await expect(readPendingMaterializationPaths(view.rootDir)).rejects.toThrow();
    } finally {
      await view.store.close();
    }
  });

  it("removes each record from .dohc/local/share-refresh once its work is done", async () => {
    const view = await collidedView();
    try {
      await rm(join(view.rootDir, view.path));
      await expect(view.refresh()).resolves.toMatchObject({ ok: true, unjournalablePaths: [] });
      expect(await readFile(join(view.rootDir, view.path), "utf8")).toBe("granter file");
      expect(await readdir(recordsDir(view.rootDir))).toEqual([]);
      await expect(readSharedViewProjectionDebt(view.rootDir, SHARE_ID)).resolves.toEqual({
        pendingPaths: new Set(),
        collisionPaths: new Set(),
        pullInFlight: false,
      });
    } finally {
      await view.store.close();
    }
  });
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

  it("skips a workspace that is not a share view at all", () => {
    expect(decide(null)).toBeNull();
    expect(decide(undefined)).toBeNull();
  });

  it("skips when there are no server credentials", () => {
    for (const relayUrl of [null, ""]) {
      expect(
        decide(
          { grantedSelector: EDIT, relayUrl: "https://relay.example" },
          relayUrl,
        ),
      ).toBeNull();
    }
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

describe("containment of '..'-prefixed names", () => {
  it("resolves a shared-view target under a directory whose NAME starts with '..'", async () => {
    const root = await createTestScratch("dohc-shared-view-dotdot-");
    await mkdir(join(root, "..cache"), { recursive: true });
    await writeFile(join(root, "..cache", "x.md"), "cached");
    await expect(resolvedShareViewTarget(root, "..cache/x.md")).resolves.toBe(
      join(root, "..cache", "x.md"),
    );
  });
});
