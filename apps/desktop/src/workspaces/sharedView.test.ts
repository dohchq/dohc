import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  lstat,
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { userInfo } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createShareViewDaemonHarness,
  type ShareViewDaemonHarness,
} from "../testing/shareViewLoopbackTransport";
import {
  assertShareChangesJournalable,
  captureSharedViewLocalDivergence,
  captureStandaloneShareViewDivergence,
  clearPendingMaterializationPaths,
  clearPullInFlightMarker,
  readPendingMaterializationPaths,
  SharePinInvalidError,
  materializeSharedViewPaths,
  readCollisionRecordPaths,
  refreshStandaloneShareViewOnce as refreshStandaloneShareViewOnceWithPull,
  refreshSharedViewOnce as refreshSharedViewOnceWithPull,
  recordCollisionPaths,
  shareViewIdentitySelector,
  withShareViewRefreshLifecycleLock,
  writePendingMaterializationPaths,
} from "./sharedView";
import {
  MAX_ENGINE_CAPTURE_BINARY_BYTES,
  MAX_ENGINE_CAPTURE_TEXT_BYTES,
} from "./workspaceEngineCapture";
import {
  routeWorkspaceFileCreate,
  routeWorkspaceFileImport,
  routeWorkspacePathDelete,
  routeWorkspacePathMove,
} from "./workspaceFileOps";
import { routeWorkspaceTextWrite } from "./workspaceTextWrite";
import { withOrderedWorkspaceTextPath } from "./workspaceAssets";
import { shareViewTakesLocalWrites } from "./shareWriteGate";
import {
  ShareUnavailableError,
  type PullShareViewResult,
  type ShareViewRefusal,
} from "@dohc/workspace-contracts/relay";
import { denyRead, restoreRead } from "@dohc/workspace-fs/testing";
import { createTestScratch } from "./testTemp";

// A recording spy, not a poisoning one: every readdir call this file's own
// setup or fixtures make is allowed through unchanged. It proves that capture
// makes zero readdir calls, so the recursive tree walk #866 removed stays gone.
let readdirCalls: string[] = [];
let observeRealpath: ((path: string) => void) | null = null;
let failRenameToPathOnce: { path: string; error: Error } | null = null;
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    readdir: (async (path: Parameters<typeof readdir>[0], options?: unknown) => {
      readdirCalls.push(String(path));
      return actual.readdir(path as string, options as never);
    }) as typeof readdir,
    realpath: (async (
      path: Parameters<typeof actual.realpath>[0],
      options?: unknown,
    ) => {
      const resolved = await actual.realpath(path, options as never);
      observeRealpath?.(String(path));
      return resolved;
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
  };
});

// These tests drive the pull with the selector a share record pins. It is a
// REAL selector — no paths and no version selects nothing at all, which the
// engine refuses.
const PINNED_SELECTOR = {
  paths: ["docs"],
  versionId: null,
  access: "view",
} as const;

const WORKSPACE = "shared-view-ws";
const SHARE_ID = "share-1";
const TOKEN = "test:recipient";

// chmod-based fixtures cannot make a path unreadable for root. Windows uses
// the workspace-fs NTFS deny-read fixture and has no getuid.
const itNonRoot = process.getuid?.() === 0 ? it.skip : it;

async function denyFileContentRead(absolutePath: string): Promise<void> {
  if (process.platform === "win32") {
    execFileSync(
      "icacls",
      [absolutePath, "/deny", `${userInfo().username}:(RD)`],
      { stdio: "pipe" },
    );
    return;
  }
  await denyRead(absolutePath, "file");
}

// This file no longer references the legacy TypeScript engine at all — not by import
// and not by vi.mock. That is a stronger guarantee than a not-called spy: the
// module cannot be reached from here even indirectly. The production side is
// held by the #402 ratchet, which fails if sharedView.ts ever gains a runtime
// import of the legacy package.
//
// materializeSharedViewPaths touches exactly two store methods
// (sharedView.ts:68 ensureMainVersion, :91-104 readTextFile/readBinaryFile), so
// the two tests that drive it directly need nothing more than this.
function stubStore(
  readTextFile: () => Promise<{ text: string }>,
): Parameters<typeof materializeSharedViewPaths>[3] {
  return {
    ensureMainVersion: async () => ({ id: "main" }),
    readTextFile,
    readBinaryFile: async () => {
      throw new Error("stubStore: binary reads are not part of these two tests");
    },
    close: async () => undefined,
  } as unknown as Parameters<typeof materializeSharedViewPaths>[3];
}

let roots: string[] = [];
let harnesses: ShareViewDaemonHarness[] = [];

beforeEach(() => {
  roots = [];
  harnesses = [];
  observeRealpath = null;
  failRenameToPathOnce = null;
});

afterEach(async () => {
  failRenameToPathOnce = null;
  await Promise.all(harnesses.map((harness) => harness.closeAll()));
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

async function tempRoot(): Promise<string> {
  const root = await createTestScratch("dohc-shared-view-desktop-");
  roots.push(root);
  return root;
}

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

async function momentIds(store: {
  listMoments: (input: { workspaceId: string; limit: number }) => Promise<{
    moments: Array<{ id: string }>;
  }>;
}): Promise<string[]> {
  return (await store.listMoments({ workspaceId: WORKSPACE, limit: 200 })).moments.map(
    (moment) => moment.id,
  );
}

// Minimal share-route double (same shape the engine share client tests use).
class FakeShareRelay {
  ops: Array<Record<string, unknown>> = [];
  blobs = new Map<string, Buffer>();
  ended = false;
  pageSize: number | null = null;
  logRequests = 0;
  beforeLogRequest?: (requestNumber: number) => Promise<void>;
  // The share metadata route is the ONLY route a re-pin could use. Counted so
  // a test can prove that a refresh never reaches it.
  metadataRequests = 0;
  private nextSeq = 1;

  // A moment the share never granted: same shape, another lineage. The pinned
  // selector follows main, so the recipient's boundary refuses this one.
  addWriteFromAnotherVersion(path: string, content: string, versionId: string): void {
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

  fetch = async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const href = typeof url === "string" ? url : url instanceof URL ? url.href : url.url;
    const parsed = new URL(href);
    const auth = new Headers(init?.headers).get("authorization");
    if (auth !== `Bearer ${TOKEN}`) {
      return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
    }
    const notFound = () =>
      Response.json({ ok: false, error: "not found", code: "not_found" }, { status: 404 });
    if (this.ended) return notFound();
    const parts = parsed.pathname.split("/").filter(Boolean);
    if (parts[0] !== "sync" || parts[1] !== "shares" || parts[2] !== SHARE_ID) return notFound();
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
  it("captures an out-of-app modification through the standalone refresh", async () => {
    const rootDir = await tempRoot();
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
      const before = await store.listMoments({ workspaceId: WORKSPACE, limit: 100 });
      const beforeIds = new Set(before.moments.map((moment) => moment.id));

      const refreshed = await refreshStandaloneShareViewOnceWithPull({
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

      const after = await store.listMoments({ workspaceId: WORKSPACE, limit: 100 });
      const captured = after.moments.find((moment) => !beforeIds.has(moment.id));
      expect(captured?.path).toBe(path);
      expect(captured?.metadata.origin).toBe("local-file");
      const moment = captured
        ? await store.getMoment({ workspaceId: WORKSPACE, momentId: captured.id })
        : null;
      expect(moment?.payload.after.text).toBe("outside editor");
      expect(await readFile(join(rootDir, path), "utf8")).toBe("outside editor");

      const momentIds = after.moments.map((entry) => entry.id);
      const quiet = await refreshStandaloneShareViewOnceWithPull({
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
      expect(await readFile(join(rootDir, path), "utf8")).toBe("outside editor");
      const settled = await store.listMoments({ workspaceId: WORKSPACE, limit: 100 });
      expect(settled.moments.map((entry) => entry.id)).toEqual(momentIds);
    } finally {
      await store.close();
    }
  });

  it("repairs an interrupted pull for a view-level share without journaling", async () => {
    const rootDir = await tempRoot();
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
        join(rootDir, ".dohc", "pull-in-flight.marker"),
        "",
        "utf8",
      );
      const before = await momentIds(store);
      const outcome = await refreshStandaloneShareViewOnceWithPull({
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
    const rootDir = await tempRoot();
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

    const store = harness.openStore({ workspaceId: WORKSPACE, rootPath: rootDir });
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
    const rootDir = await tempRoot();
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

    const store = harness.openStore({ workspaceId: WORKSPACE, rootPath: rootDir });
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
    const rootDir = await tempRoot();
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
    const barrierPath = "docs/barrier.md";
    await writeFile(join(rootDir, barrierPath), "barrier", "utf8");

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
      const capturing = captureSharedViewLocalDivergence(
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
      );
      pendingOperations.push(capturing);
      await captureBlocked;
      const saving = routeWorkspaceTextWrite({
        workspaceId: WORKSPACE,
        rootPath: rootDir,
        relativePath: path,
        text: "saved in app",
        expectedContentHash: sha256("outside editor"),
        shareView: { access: "edit", ended: false },
        shareViewStore: () => saveStore,
      });
      pendingOperations.push(saving);
      let samePathProbeRan = false;
      const samePathProbe = withOrderedWorkspaceTextPath(
        rootDir,
        path,
        async () => {
          samePathProbeRan = true;
        },
      );
      pendingOperations.push(samePathProbe);
      await withOrderedWorkspaceTextPath(
        rootDir,
        barrierPath,
        async () => undefined,
      );
      for (let turn = 0; turn < 20 && !saveWriteStarted; turn += 1) {
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
      expect(saveWriteStarted).toBe(false);
      expect(samePathProbeRan).toBe(false);
      releaseCapture();
      const [captured] = await Promise.all([capturing, saving, samePathProbe]);

      expect(saveWriteStarted).toBe(true);
      expect(samePathProbeRan).toBe(true);
      const main = await store.ensureMainVersion({ workspaceId: WORKSPACE });
      await expect(
        store.readTextFile({ workspaceId: WORKSPACE, versionId: main.id, path }),
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

  it("keeps capture queued behind an editor save's projection gap", async () => {
    const rootDir = await tempRoot();
    const relay = new FakeShareRelay();
    const harness = daemonHarness(relay);
    const path = "docs/save-gap.md";
    const target = { workspaceId: WORKSPACE, rootPath: rootDir };
    relay.addWrite(path, "granter body");
    await refreshSharedViewOnce(harness, {
      rootDir,
      workspaceId: WORKSPACE,
      shareId: SHARE_ID,
    });

    const store = harness.openStore(target);
    let signalSaveStored!: () => void;
    let releaseSave!: () => void;
    const saveStored = new Promise<void>((resolve) => {
      signalSaveStored = resolve;
    });
    const saveHeld = new Promise<void>((resolve) => {
      releaseSave = resolve;
    });
    const saveStore: typeof store = {
      ...store,
      async writeTextFile(input) {
        const result = await store.writeTextFile(input);
        signalSaveStored();
        await saveHeld;
        return result;
      },
    };
    let captureDeleteStarted = false;
    const captureStore: typeof store = {
      ...store,
      async deleteTextFile(input) {
        captureDeleteStarted = true;
        return await store.deleteTextFile(input);
      },
    };
    const pendingOperations: Promise<unknown>[] = [];

    try {
      const saving = routeWorkspaceTextWrite({
        workspaceId: WORKSPACE,
        rootPath: rootDir,
        relativePath: path,
        text: "saved in app",
        expectedContentHash: sha256("granter body"),
        shareView: { access: "edit", ended: false },
        shareViewStore: () => saveStore,
      });
      pendingOperations.push(saving);
      await saveStored;
      // Hold the save's per-path lock after its store write, with the
      // projection absent in the same window materialization creates.
      await rm(join(rootDir, path));

      const capturing = captureSharedViewLocalDivergence(
        rootDir,
        WORKSPACE,
        captureStore,
        true,
        SHARE_ID,
      );
      pendingOperations.push(capturing);
      for (let turn = 0; turn < 200 && !captureDeleteStarted; turn += 1) {
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
      expect(
        captureDeleteStarted,
        "MUTATION: an unlocked scanned delete can erase the editor save before its projection lands",
      ).toBe(false);

      releaseSave();
      await expect(saving).resolves.toMatchObject({ status: "written" });
      await expect(capturing).resolves.toEqual({
        capturedPaths: 0,
        collisionRecordQuarantined: false,
        repairedPaths: 1,
        unjournalablePaths: [],
      });
      const main = await store.ensureMainVersion({ workspaceId: WORKSPACE });
      await expect(
        store.readTextFile({ workspaceId: WORKSPACE, versionId: main.id, path }),
      ).resolves.toMatchObject({ text: "saved in app" });
      expect(await readFile(join(rootDir, path), "utf8")).toBe("saved in app");
    } finally {
      releaseSave();
      await Promise.allSettled(pendingOperations);
      await store.close();
    }
  });

  it("compares disk with the snapshot current after an in-app save", async () => {
    const rootDir = await tempRoot();
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
        const snapshot = await store.listTextFileMetadata!(input);
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
        routeWorkspaceTextWrite({
          workspaceId: WORKSPACE,
          rootPath: rootDir,
          relativePath: path,
          text: "saved in app",
          expectedContentHash: sha256("granter body"),
          shareView: { access: "edit", ended: false },
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
        moments.map(async (moment) =>
          (await store.getMoment({ workspaceId: WORKSPACE, momentId: moment.id }))
            ?.payload.after.text,
        ),
      );
      expect(savedBodies.filter((body) => body === "saved in app")).toHaveLength(1);
    } finally {
      releaseCapture();
      await store.close();
    }
  });

  it("queues an in-app save behind a pending-path repair on the same target", async () => {
    const rootDir = await tempRoot();
    const relay = new FakeShareRelay();
    const harness = daemonHarness(relay);
    const path = "docs/pending-ordered.md";
    const target = { workspaceId: WORKSPACE, rootPath: rootDir };
    relay.addWrite(path, "moment one");
    await refreshSharedViewOnce(harness, { rootDir, workspaceId: WORKSPACE, shareId: SHARE_ID });

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
      const saving = routeWorkspaceTextWrite({
        workspaceId: WORKSPACE,
        rootPath: rootDir,
        relativePath: path,
        text: "saved in app",
        expectedContentHash: sha256("moment one"),
        shareView: { access: "edit", ended: false },
        shareViewStore: () => saveStore,
      });
      await saveStarted;
      await rm(join(rootDir, path));
      const repairing = captureSharedViewLocalDivergence(
        rootDir,
        WORKSPACE,
        repairStore,
        true,
        SHARE_ID,
      );
      for (let turn = 0; turn < 20 && !repairMaterializationStarted; turn += 1) {
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
      expect(repairMaterializationStarted).toBe(false);
      releaseSave();

      await expect(saving).resolves.toMatchObject({ status: "written" });
      await expect(repairing).resolves.toEqual({
        capturedPaths: 0,
        collisionRecordQuarantined: false,
        repairedPaths: 1,
        unjournalablePaths: [],
      });
      expect(await readFile(join(rootDir, path), "utf8")).toBe("saved in app");
    } finally {
      releaseSave();
      await store.close();
    }
  });

  it("handles a tracked file deleted before its ordered admission", async () => {
    const rootDir = await tempRoot();
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

    const store = harness.openStore({ workspaceId: WORKSPACE, rootPath: rootDir });
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
        captureSharedViewLocalDivergence(rootDir, WORKSPACE, racingStore, true, SHARE_ID),
      ).resolves.toMatchObject({ capturedPaths: 2 });
    } finally {
      await store.close();
    }
  });

  it("leaves unjournalable local content in place when the pull changes its path", async () => {
    const rootDir = await tempRoot();
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
      const before = await store.listMoments({ workspaceId: WORKSPACE, limit: 100 });
      relay.addWrite(path, "new granter body");
      const refreshed = await refreshStandaloneShareViewOnceWithPull({
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
      const after = await store.listMoments({ workspaceId: WORKSPACE, limit: 100 });
      expect(after.moments).toHaveLength(before.moments.length + 1);

      const quiet = await refreshStandaloneShareViewOnceWithPull({
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
      const rootDir = await tempRoot();
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

        const refreshed = await refreshStandaloneShareViewOnceWithPull({
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
    const rootDir = await tempRoot();
    const relay = new FakeShareRelay();
    const harness = daemonHarness(relay);
    const binaryPath = "docs/huge.png";
    const scenePath = "docs/drawing.excalidraw";
    const target = { workspaceId: WORKSPACE, rootPath: rootDir };
    relay.addWrite(binaryPath, "small image placeholder");
    relay.addWrite(scenePath, "{}\n");
    await refreshSharedViewOnce(harness, { rootDir, workspaceId: WORKSPACE, shareId: SHARE_ID });
    await writeFile(
      join(rootDir, binaryPath),
      Buffer.alloc(MAX_ENGINE_CAPTURE_BINARY_BYTES + 1),
    );
    await writeFile(join(rootDir, scenePath), Buffer.from([0xff, 0xfe, 0xfd]));

    const store = harness.openStore(target);
    try {
      await expect(
        captureSharedViewLocalDivergence(rootDir, WORKSPACE, store, true, SHARE_ID),
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
    const rootDir = await tempRoot();
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

  it("leaves a directory that replaced a tracked file untouched during refresh", async () => {
    const rootDir = await tempRoot();
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
      const refreshed = await refreshStandaloneShareViewOnceWithPull({
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
    const rootDir = await tempRoot();
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
        routeWorkspaceTextWrite({
          workspaceId: WORKSPACE,
          rootPath: rootDir,
          relativePath: path,
          text: "moment B",
          expectedContentHash: sha256("moment A"),
          shareView: { access: "edit", ended: false },
          shareViewStore: () => store,
        }),
      ).resolves.toMatchObject({ status: "written" });
      await writeFile(join(rootDir, path), "moment A", "utf8");

      await expect(
        captureSharedViewLocalDivergence(rootDir, WORKSPACE, store, true, SHARE_ID),
      ).resolves.toEqual({
        capturedPaths: 1,
        collisionRecordQuarantined: false,
        repairedPaths: 0,
        unjournalablePaths: [],
      });
      const main = await store.ensureMainVersion({ workspaceId: WORKSPACE });
      await expect(
        store.readTextFile({ workspaceId: WORKSPACE, versionId: main.id, path }),
      ).resolves.toMatchObject({ text: "moment A" });
    } finally {
      await store.close();
    }
  });

  it("clears a pending marker when disk already matches the current head", async () => {
    const rootDir = await tempRoot();
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
      const before = await store.listMoments({ workspaceId: WORKSPACE, limit: 100 });

      await expect(
        captureSharedViewLocalDivergence(rootDir, WORKSPACE, store, true, SHARE_ID),
      ).resolves.toEqual({
        capturedPaths: 0,
        collisionRecordQuarantined: false,
        repairedPaths: 1,
        unjournalablePaths: [],
      });
      await expect(
        store.readTextFile({ workspaceId: WORKSPACE, versionId: main.id, path }),
      ).resolves.toMatchObject({ text: "moment two" });
      expect(await readFile(join(rootDir, path), "utf8")).toBe("moment two");
      await expect(readPendingMaterializationPaths(rootDir)).resolves.toEqual(
        new Set(),
      );
      const after = await store.listMoments({ workspaceId: WORKSPACE, limit: 100 });
      expect(after.moments.map((moment) => moment.id)).toEqual(
        before.moments.map((moment) => moment.id),
      );
    } finally {
      await store.close();
    }
  });

  it("uses the current moment preimage when a pending path advances after listing", async () => {
    const rootDir = await tempRoot();
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
          const tracked = await store.listTextFileMetadata!(input);
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
        captureSharedViewLocalDivergence(rootDir, WORKSPACE, captureStore, true, SHARE_ID),
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
        store.readTextFile({ workspaceId: WORKSPACE, versionId: main.id, path }),
      ).resolves.toMatchObject({ text: "moment two" });
      expect(await readFile(join(rootDir, path), "utf8")).toBe("moment two");
    } finally {
      await store.close();
    }
  });

  it("reports a repair-only standalone refresh as updated", async () => {
    const rootDir = await tempRoot();
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
        refreshStandaloneShareViewOnceWithPull({
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
    const rootDir = await tempRoot();
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
        refreshStandaloneShareViewOnceWithPull({
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
    const rootDir = await tempRoot();
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
        return await store.listTextFileMetadata!(input);
      },
    };
    try {
      await expect(
        refreshStandaloneShareViewOnceWithPull({
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
    const rootDir = await tempRoot();
    const relay = new FakeShareRelay();
    const harness = daemonHarness(relay);
    const path = "docs/debris.md";
    const target = { workspaceId: WORKSPACE, rootPath: rootDir };
    relay.addWrite(path, "moment one");
    await refreshSharedViewOnce(harness, { rootDir, workspaceId: WORKSPACE, shareId: SHARE_ID });

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
        captureSharedViewLocalDivergence(rootDir, WORKSPACE, store, true, SHARE_ID),
      ).resolves.toEqual({
        capturedPaths: 0,
        collisionRecordQuarantined: false,
        repairedPaths: 1,
        unjournalablePaths: [],
      });
      expect(await readFile(join(rootDir, path), "utf8")).toBe("moment two");
      expect(await momentIds(store)).toEqual(before);
      await expect(readPendingMaterializationPaths(rootDir)).resolves.toEqual(new Set());
    } finally {
      await store.close();
    }
  });

  it("repairs an absent pending overwrite without journaling a delete", async () => {
    const rootDir = await tempRoot();
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
        captureSharedViewLocalDivergence(rootDir, WORKSPACE, store, true, SHARE_ID),
      ).resolves.toEqual({
        capturedPaths: 0,
        collisionRecordQuarantined: false,
        repairedPaths: 1,
        unjournalablePaths: [],
      });
      expect(await readFile(join(rootDir, path), "utf8")).toBe("moment two");
      await expect(
        store.readTextFile({ workspaceId: WORKSPACE, versionId: main.id, path }),
      ).resolves.toMatchObject({ text: "moment two" });
      expect(await momentIds(store)).toEqual(before);
    } finally {
      await store.close();
    }
  });

  itNonRoot("keeps a pending marker while its tracked file is unreadable", async () => {
    const rootDir = await tempRoot();
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
        captureSharedViewLocalDivergence(rootDir, WORKSPACE, store, true, SHARE_ID),
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
  });

  it("journals a third body that landed after an interrupted materialization", async () => {
    const rootDir = await tempRoot();
    const relay = new FakeShareRelay();
    const harness = daemonHarness(relay);
    const path = "docs/third-body.md";
    const target = { workspaceId: WORKSPACE, rootPath: rootDir };
    relay.addWrite(path, "moment one");
    await refreshSharedViewOnce(harness, { rootDir, workspaceId: WORKSPACE, shareId: SHARE_ID });

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
        captureSharedViewLocalDivergence(rootDir, WORKSPACE, store, true, SHARE_ID),
      ).resolves.toEqual({
        capturedPaths: 1,
        collisionRecordQuarantined: false,
        repairedPaths: 0,
        unjournalablePaths: [],
      });
      await expect(
        store.readTextFile({ workspaceId: WORKSPACE, versionId: main.id, path }),
      ).resolves.toMatchObject({ text: "moment three" });
      expect(await readFile(join(rootDir, path), "utf8")).toBe("moment three");
      await expect(readPendingMaterializationPaths(rootDir)).resolves.toEqual(new Set());
    } finally {
      await store.close();
    }
  });

  it("preserves a real edit made after materialization completed with a stale marker", async () => {
    const rootDir = await tempRoot();
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

  it("does not let a stale marker survive a failed pull and revert later edits", async () => {
    const rootDir = await tempRoot();
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
        refreshStandaloneShareViewOnceWithPull({
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
        captureSharedViewLocalDivergence(rootDir, WORKSPACE, store, true, SHARE_ID),
      ).resolves.toMatchObject({ capturedPaths: 1, repairedPaths: 0 });
      expect(await readFile(join(rootDir, path), "utf8")).toBe(
        "recipient edit two",
      );
    } finally {
      await store.close();
    }
  });

  it("clears a repaired submit marker before the next local edit", async () => {
    const rootDir = await tempRoot();
    const relay = new FakeShareRelay();
    const harness = daemonHarness(relay);
    const path = "docs/submit-repair.md";
    const target = { workspaceId: WORKSPACE, rootPath: rootDir };
    relay.addWrite(path, "moment one");
    await refreshSharedViewOnce(harness, { rootDir, workspaceId: WORKSPACE, shareId: SHARE_ID });

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
      await expect(readPendingMaterializationPaths(rootDir)).resolves.toEqual(new Set());

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
        store.readTextFile({ workspaceId: WORKSPACE, versionId: main.id, path }),
      ).resolves.toMatchObject({ text: "recipient edit" });
    } finally {
      await store.close();
    }
  });

  it("serializes refresh lifecycle callers per view without blocking other views", async () => {
    const firstRoot = await tempRoot();
    const secondRoot = await tempRoot();
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
    const otherView = withShareViewRefreshLifecycleLock(secondRoot, async () => {
      order.push("other-view");
    });
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

  it("keeps existing pending references when an in-app save clears its own", async () => {
    const rootDir = await tempRoot();
    const relay = new FakeShareRelay();
    const harness = daemonHarness(relay);
    const savedPath = "docs/saved.md";
    const otherPath = "docs/still-pending.md";
    const target = { workspaceId: WORKSPACE, rootPath: rootDir };
    relay.addWrite(savedPath, "saved before");
    relay.addWrite(otherPath, "other before");
    await refreshSharedViewOnce(harness, { rootDir, workspaceId: WORKSPACE, shareId: SHARE_ID });

    const store = harness.openStore(target);
    try {
      await writePendingMaterializationPaths(rootDir, [savedPath, otherPath]);
      await routeWorkspaceTextWrite({
        workspaceId: WORKSPACE,
        rootPath: rootDir,
        relativePath: savedPath,
        text: "saved after",
        expectedContentHash: sha256("saved before"),
        shareView: { access: "edit", ended: false },
        shareViewStore: () => store,
      });
      await expect(readPendingMaterializationPaths(rootDir)).resolves.toEqual(
        new Set([savedPath, otherPath]),
      );
    } finally {
      await store.close();
    }
  });

  it("keeps a same-path marker until both pending producers clear it", async () => {
    const rootDir = await tempRoot();
    const path = "docs/overlap.md";

    await writePendingMaterializationPaths(rootDir, [path, path]);
    await writePendingMaterializationPaths(rootDir, [path]);
    await clearPendingMaterializationPaths(rootDir, [path]);

    await expect(readPendingMaterializationPaths(rootDir)).resolves.toEqual(
      new Set([path]),
    );
    await expect(
      readFile(join(rootDir, ".dohc", "pending-materialization.json"), "utf8"),
    ).resolves.toBe(JSON.stringify({ counts: { [path]: 1 } }));

    await clearPendingMaterializationPaths(rootDir, [path]);
    await expect(readPendingMaterializationPaths(rootDir)).resolves.toEqual(
      new Set(),
    );
  });

  it("uses the same written error for an invalid pending shape and malformed JSON", async () => {
    const rootDir = await tempRoot();
    await mkdir(join(rootDir, ".dohc"), { recursive: true });
    const pendingPath = join(rootDir, ".dohc", "pending-materialization.json");
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
    const rootDir = await tempRoot();
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
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => undefined);
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
        rootDir,
        ".dohc",
        "pending-materialization.json",
      );
      await writeFile(pendingPath, "not json", "utf8");

      await expect(
        refreshStandaloneShareViewOnceWithPull({
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
        (await readdir(join(rootDir, ".dohc"))).some((name) =>
          /^pending-materialization\.json\.invalid-\d+$/.test(name),
        ),
      ).toBe(true);
      await expect(lstat(pendingPath)).rejects.toMatchObject({ code: "ENOENT" });
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
      const rootDir = await tempRoot();
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
      const errorLog = vi.spyOn(console, "error").mockImplementation(() => undefined);
      try {
        const before = await momentIds(store);
        await writeFile(
          join(rootDir, ".dohc", "pending-materialization.json"),
          JSON.stringify({ counts: { [invalidPath]: 1 } }),
          "utf8",
        );

        await expect(
          refreshStandaloneShareViewOnceWithPull({
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
          (await readdir(join(rootDir, ".dohc"))).some((name) =>
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
    const rootDir = await tempRoot();
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
        refreshStandaloneShareViewOnceWithPull({
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
        unjournalablePaths: [
          { path, reason: "non-file-replacement" },
        ],
      });
      expect((await stat(join(rootDir, path))).isDirectory()).toBe(true);
      expect(await readFile(childPath, "utf8")).toBe("recipient data");
    } finally {
      await store.close();
    }
  });

  it("reports an untracked file that blocks a newly shared path", async () => {
    const rootDir = await tempRoot();
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
        refreshStandaloneShareViewOnceWithPull({
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
      expect(await readFile(join(rootDir, path), "utf8")).toBe("recipient data");
    } finally {
      await store.close();
    }
  });

  it("does not adopt a recorded local collision on a later refresh", async () => {
    const rootDir = await tempRoot();
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
      await refreshStandaloneShareViewOnceWithPull({
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
      await expect(readCollisionRecordPaths(rootDir, SHARE_ID)).resolves.toEqual(
        new Set([path]),
      );
      const before = await momentIds(store);

      await expect(
        refreshStandaloneShareViewOnceWithPull({
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
      expect(await readFile(join(rootDir, path), "utf8")).toBe("recipient data");
    } finally {
      await store.close();
    }
  });

  it("keeps a recorded local collision excluded from a later delete", async () => {
    const rootDir = await tempRoot();
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
      await refreshStandaloneShareViewOnceWithPull({
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
      await expect(readCollisionRecordPaths(rootDir, SHARE_ID)).resolves.toEqual(
        new Set([path]),
      );
      relay.addDelete(path);

      await expect(
        refreshStandaloneShareViewOnceWithPull({
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

      expect(await readFile(join(rootDir, path), "utf8")).toBe("recipient data");
      await rm(join(rootDir, path));
      await refreshStandaloneShareViewOnceWithPull({
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
      await expect(readCollisionRecordPaths(rootDir, SHARE_ID)).resolves.toEqual(new Set());

      relay.addWrite(path, "granter re-add");
      await expect(
        refreshStandaloneShareViewOnceWithPull({
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
      expect(await readFile(join(rootDir, path), "utf8")).toBe("granter re-add");
    } finally {
      await store.close();
    }
  });

  it("does not process a collision-recorded pending path twice", async () => {
    const rootDir = await tempRoot();
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
        captureSharedViewLocalDivergence(rootDir, WORKSPACE, store, true, SHARE_ID),
      ).resolves.toEqual({
        capturedPaths: 0,
        collisionRecordQuarantined: false,
        repairedPaths: 0,
        unjournalablePaths: [{ path, reason: "local-collision" }],
      });
      expect(await readFile(join(rootDir, path), "utf8")).toBe("moment one");
      await expect(readCollisionRecordPaths(rootDir, SHARE_ID)).resolves.toEqual(
        new Set([path]),
      );
      await expect(readPendingMaterializationPaths(rootDir)).resolves.toEqual(
        new Set([path]),
      );
    } finally {
      await store.close();
    }
  });

  it("records a non-final pull page collision before fetching the next page", async () => {
    const rootDir = await tempRoot();
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
      await expect(readCollisionRecordPaths(rootDir, SHARE_ID)).resolves.toEqual(
        new Set([path]),
      );
      observedBeforeSecondPage = true;
    };

    const store = harness.openStore(target);
    try {
      await refreshStandaloneShareViewOnceWithPull({
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
      await expect(readCollisionRecordPaths(rootDir, SHARE_ID)).resolves.toEqual(
        new Set([path]),
      );
      expect(await readFile(join(rootDir, path), "utf8")).toBe("recipient data");
      expect(await readFile(join(rootDir, "docs/page-two.md"), "utf8")).toBe(
        "second page",
      );
    } finally {
      await store.close();
    }
  });

  it("keeps a recorded collision protected for a view-access share", async () => {
    const rootDir = await tempRoot();
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
        refreshStandaloneShareViewOnceWithPull({
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
      await expect(readCollisionRecordPaths(rootDir, SHARE_ID)).resolves.toEqual(
        new Set([path]),
      );

      await expect(
        refreshStandaloneShareViewOnceWithPull({
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
      expect(await readFile(join(rootDir, path), "utf8")).toBe("recipient data");
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
      const rootDir = await tempRoot();
      const outsideRoot = await tempRoot();
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
        pinnedSelector: { paths: ["seed.md", "docs"], versionId: null, access: "view" },
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
          captureSharedViewLocalDivergence(rootDir, WORKSPACE, store, true, SHARE_ID),
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
    const rootDir = await tempRoot();
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
      await refreshStandaloneShareViewOnceWithPull({
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
      await expect(readCollisionRecordPaths(rootDir, SHARE_ID)).resolves.toEqual(
        new Set([path]),
      );
      await rm(join(rootDir, path));
      const before = await momentIds(store);

      await refreshStandaloneShareViewOnceWithPull({
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

      await expect(readCollisionRecordPaths(rootDir, SHARE_ID)).resolves.toEqual(new Set());
      expect(await readFile(join(rootDir, path), "utf8")).toBe("granter file");
      expect(await momentIds(store)).toEqual(before);

      // Simulate a crash after materialization succeeded but before capture
      // cleared the collision record.
      await recordCollisionPaths(rootDir, SHARE_ID, [path]);
      const beforeCrashRecovery = await momentIds(store);
      await expect(
        captureSharedViewLocalDivergence(rootDir, WORKSPACE, store, true, SHARE_ID),
      ).resolves.toEqual({
        capturedPaths: 0,
        collisionRecordQuarantined: false,
        repairedPaths: 1,
        unjournalablePaths: [],
      });
      await expect(readCollisionRecordPaths(rootDir, SHARE_ID)).resolves.toEqual(new Set());
      expect(await readFile(join(rootDir, path), "utf8")).toBe("granter file");
      expect(await momentIds(store)).toEqual(beforeCrashRecovery);
    } finally {
      await store.close();
    }
  });

  it("keeps a collision record when the store loses the tracked path", async () => {
    const rootDir = await tempRoot();
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
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => undefined);
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
      await expect(readCollisionRecordPaths(rootDir, SHARE_ID)).resolves.toEqual(
        new Set([path]),
      );
      expect(errorLog).toHaveBeenCalledWith(
        expect.stringContaining("shared view store lost tracked path"),
      );
    } finally {
      errorLog.mockRestore();
      await store.close();
    }
  });

  it.each(["write", "delete"] as const)(
    "consults the collision record at the materialization boundary for a later %s",
    async (operation) => {
      const rootDir = await tempRoot();
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
        await refreshStandaloneShareViewOnceWithPull({
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
        await expect(readCollisionRecordPaths(rootDir, SHARE_ID)).resolves.toEqual(
          new Set([path]),
        );
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

        expect(await readFile(join(rootDir, path), "utf8")).toBe("recipient data");
      } finally {
        await store.close();
      }
    },
  );

  it("catches a collision that appears after the page recording pass, before materialization", async () => {
    const rootDir = await tempRoot();
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
        refreshStandaloneShareViewOnceWithPull({
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
      expect(await readFile(join(rootDir, path), "utf8")).toBe("recipient data");
      await expect(readCollisionRecordPaths(rootDir, SHARE_ID)).resolves.toEqual(
        new Set([path]),
      );
    } finally {
      await store.close();
    }
  });

  it("publishes a durable collision record without leaving a temp file", async () => {
    const rootDir = await tempRoot();
    const paths = ["docs/b.md", "docs/a.md"];

    await recordCollisionPaths(rootDir, SHARE_ID, paths);

    await expect(readCollisionRecordPaths(rootDir, SHARE_ID)).resolves.toEqual(new Set(paths));
    expect(
      (await readdir(join(rootDir, ".dohc"))).filter((name) =>
        /^\.share-collision-record\.json\..+\.tmp$/.test(name),
      ),
    ).toEqual([]);
  });

  it("ignores a stale collision-record temp file beside the intact target", async () => {
    const rootDir = await tempRoot();
    const paths = ["docs/a.md", "docs/b.md"];
    await recordCollisionPaths(rootDir, SHARE_ID, paths);
    await writeFile(
      join(
        rootDir,
        ".dohc",
        ".share-collision-record.json.999.00000000-0000-0000-0000-000000000000.tmp",
      ),
      "not json",
      "utf8",
    );

    await expect(readCollisionRecordPaths(rootDir, SHARE_ID)).resolves.toEqual(
      new Set(paths),
    );
  });

  it("quarantines a corrupt collision record and accepts a clean write", async () => {
    const rootDir = await tempRoot();
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
    const collisionPath = join(
      rootDir,
      ".dohc",
      "share-collision-record.json",
    );
    const store = harness.openStore(target);
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      await refreshStandaloneShareViewOnceWithPull({
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
      await expect(readCollisionRecordPaths(rootDir, SHARE_ID)).resolves.toEqual(
        new Set([path]),
      );
      await writeFile(collisionPath, "not json", "utf8");

      await expect(readCollisionRecordPaths(rootDir, SHARE_ID)).resolves.toEqual(new Set());
      expect(
        (await readdir(join(rootDir, ".dohc"))).some((name) =>
          /^share-collision-record\.json\.invalid-\d+$/.test(name),
        ),
      ).toBe(true);
      await expect(lstat(collisionPath)).rejects.toMatchObject({ code: "ENOENT" });
      expect(errorLog).toHaveBeenCalledWith(expect.stringContaining(collisionPath));

      await recordCollisionPaths(rootDir, SHARE_ID, ["docs/fresh.md"]);
      await expect(readCollisionRecordPaths(rootDir, SHARE_ID)).resolves.toEqual(
        new Set(["docs/fresh.md"]),
      );
    } finally {
      errorLog.mockRestore();
      await store.close();
    }
  });

  it("repairs a view-share path after quarantining its collision record", async () => {
    const rootDir = await tempRoot();
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
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      await refreshStandaloneShareViewOnceWithPull({
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
        join(rootDir, ".dohc", "share-collision-record.json"),
        "not json",
        "utf8",
      );

      await expect(
        refreshStandaloneShareViewOnceWithPull({
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
        collisionRecordQuarantined: true,
      });
      expect(await readFile(join(rootDir, path), "utf8")).toBe("granter file");
      await expect(readCollisionRecordPaths(rootDir, SHARE_ID)).resolves.toEqual(new Set());
      expect(errorLog).toHaveBeenCalledWith(
        expect.stringContaining("ordinary capture rules"),
      );
    } finally {
      errorLog.mockRestore();
      await store.close();
    }
  });

  it("keeps an intact collision ahead of corrupt pending verification", async () => {
    const rootDir = await tempRoot();
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
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      await refreshStandaloneShareViewOnceWithPull({
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
        join(rootDir, ".dohc", "pending-materialization.json"),
        "not json",
        "utf8",
      );
      const before = await momentIds(store);

      await expect(
        refreshStandaloneShareViewOnceWithPull({
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
      expect(await readFile(join(rootDir, path), "utf8")).toBe("recipient data");
      await expect(readCollisionRecordPaths(rootDir, SHARE_ID)).resolves.toEqual(
        new Set([path]),
      );
      expect(errorLog).toHaveBeenCalledWith(
        expect.stringContaining("verifying every tracked path"),
      );
    } finally {
      errorLog.mockRestore();
      await store.close();
    }
  });

  it("quarantines another share's collision record before recording fresh collisions", async () => {
    const rootDir = await tempRoot();
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
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      await expect(
        refreshStandaloneShareViewOnceWithPull({
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
      await expect(readCollisionRecordPaths(rootDir, SHARE_ID)).resolves.toEqual(
        new Set([collisionPath]),
      );
      expect(
        (await readdir(join(rootDir, ".dohc"))).some((name) =>
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
    const rootDir = await tempRoot();
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
        refreshStandaloneShareViewOnceWithPull({
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
      expect(await readFile(join(rootDir, path), "utf8")).toBe("recipient data");
    } finally {
      await store.close();
    }
  });

  it("repairs a share-view create whose projection fails without journaling a delete", async () => {
    const rootDir = await tempRoot();
    const relay = new FakeShareRelay();
    const harness = daemonHarness(relay);
    relay.addWrite("docs/seed.md", "seed");
    await refreshSharedViewOnce(harness, {
      rootDir,
      workspaceId: WORKSPACE,
      shareId: SHARE_ID,
    });

    const store = harness.openStore({ workspaceId: WORKSPACE, rootPath: rootDir });
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
        routeWorkspaceFileCreate({
          workspaceId: WORKSPACE,
          rootPath: rootDir,
          shareView: { access: "edit", ended: false, granterEmail: null },
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
          (moment) =>
            moment.path === created && moment.operation === "delete",
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
    const rootDir = await tempRoot();
    const relay = new FakeShareRelay();
    const harness = daemonHarness(relay);
    relay.addWrite("docs/seed.md", "seed");
    await refreshSharedViewOnce(harness, {
      rootDir,
      workspaceId: WORKSPACE,
      shareId: SHARE_ID,
    });

    const store = harness.openStore({ workspaceId: WORKSPACE, rootPath: rootDir });
    const created = "docs/new-then-deleted.md";
    try {
      await routeWorkspaceFileCreate({
        workspaceId: WORKSPACE,
        rootPath: rootDir,
        shareView: { access: "edit", ended: false, granterEmail: null },
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
        captureSharedViewLocalDivergence(rootDir, WORKSPACE, store, true, SHARE_ID),
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
    const rootDir = await tempRoot();
    const relay = new FakeShareRelay();
    const harness = daemonHarness(relay);
    relay.addWrite("docs/seed.md", "seed");
    await refreshSharedViewOnce(harness, {
      rootDir,
      workspaceId: WORKSPACE,
      shareId: SHARE_ID,
    });

    const store = harness.openStore({ workspaceId: WORKSPACE, rootPath: rootDir });
    const created = "docs/view-repair.md";
    try {
      await routeWorkspaceFileCreate({
        workspaceId: WORKSPACE,
        rootPath: rootDir,
        shareView: { access: "edit", ended: false, granterEmail: null },
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
      expect(await readFile(join(rootDir, created), "utf8")).toBe("restore me\n");
      expect(await momentIds(store)).toEqual(beforeIds);
    } finally {
      await store.close();
    }
  });

  it("marks every move path until its projection is materialized", async () => {
    const rootDir = await tempRoot();
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

    const store = harness.openStore({ workspaceId: WORKSPACE, rootPath: rootDir });
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
      const moving = routeWorkspacePathMove({
        workspaceId: WORKSPACE,
        rootPath: rootDir,
        shareView: { access: "edit", ended: false, granterEmail: null },
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
    const rootDir = await tempRoot();
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

    const store = harness.openStore({ workspaceId: WORKSPACE, rootPath: rootDir });
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
      const deleting = routeWorkspacePathDelete({
        workspaceId: WORKSPACE,
        rootPath: rootDir,
        shareView: { access: "edit", ended: false, granterEmail: null },
        shareViewStore: () => pausedStore,
        relativePath: "docs/remove",
        trashItem: async () => {
          throw new Error("share-view delete must not use the OS trash");
        },
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
    const rootDir = await tempRoot();
    const sourceRoot = await tempRoot();
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

    const store = harness.openStore({ workspaceId: WORKSPACE, rootPath: rootDir });
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
      const importing = routeWorkspaceFileImport({
        workspaceId: WORKSPACE,
        rootPath: rootDir,
        shareView: { access: "edit", ended: false, granterEmail: null },
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

  it("finishes a pending delete that no longer appears in tracked metadata", async () => {
    const rootDir = await tempRoot();
    const relay = new FakeShareRelay();
    const harness = daemonHarness(relay);
    const path = "docs/delete-debris.md";
    const target = { workspaceId: WORKSPACE, rootPath: rootDir };
    relay.addWrite(path, "delete me");
    await refreshSharedViewOnce(harness, { rootDir, workspaceId: WORKSPACE, shareId: SHARE_ID });

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
        captureSharedViewLocalDivergence(rootDir, WORKSPACE, store, true, SHARE_ID),
      ).resolves.toEqual({
        capturedPaths: 0,
        collisionRecordQuarantined: false,
        repairedPaths: 1,
        unjournalablePaths: [],
      });
      await expect(stat(join(rootDir, path))).rejects.toMatchObject({ code: "ENOENT" });
      expect(await momentIds(store)).toEqual(before);
      await expect(readPendingMaterializationPaths(rootDir)).resolves.toEqual(new Set());
    } finally {
      await store.close();
    }
  });

  // #859: a share-view FOLDER delete crashing between the store deleting its
  // children and `materializeSharedViewPaths`' single recursive rm on the
  // folder path used to leave the projection showing files the store had
  // already deleted — `shareViewDelete` marked only the FOLDER path pending,
  // so recovery never revisited the children at all, found a still-present
  // directory with no matching preimage, and misclassified it as an
  // unjournalable non-file replacement. #862 changed `shareViewDelete` to
  // mark every CHILD path pending before the store mutation, which is what
  // makes them reachable here: the leftover-pending arm below predates #862
  // unchanged, but a path only reaches it when the marker names it.
  //
  // The crash is driven through the REAL writer, not hand-assembled: a
  // failing store proxy lets both `deleteTextFile` calls succeed, then makes
  // the very first call `materializeSharedViewPaths` itself makes
  // (`ensureMainVersion`) throw — so `routeWorkspacePathDelete` leaves
  // whatever state `shareViewDelete` actually produces at that exact point,
  // with disk untouched because materialization never ran its rm.
  //
  // Also pins a known, accepted residue (finding 6): recovery finishes each
  // child individually and has no equivalent of the folder-level rm's
  // directory removal, so the emptied `docs/plans` stays on disk after
  // recovery where an uninterrupted delete would have removed it too.
  it("recovers a crashed folder delete's children, but leaves the emptied folder until something prunes it", async () => {
    const rootDir = await tempRoot();
    const relay = new FakeShareRelay();
    const harness = daemonHarness(relay);
    const paths = ["docs/plans/one.md", "docs/plans/two.md"];
    relay.addWrite(paths[0], "one");
    relay.addWrite(paths[1], "two");
    await refreshSharedViewOnce(harness, { rootDir, workspaceId: WORKSPACE, shareId: SHARE_ID });

    const store = harness.openStore({ workspaceId: WORKSPACE, rootPath: rootDir });
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
          // after the store mutation shareViewDelete makes is already done.
          if (deletesDone >= paths.length) {
            throw Object.assign(new Error("EBUSY: projection delete failed"), {
              code: "EBUSY",
            });
          }
          return await store.ensureMainVersion(input);
        },
      };

      await expect(
        routeWorkspacePathDelete({
          workspaceId: WORKSPACE,
          rootPath: rootDir,
          shareView: { access: "edit", ended: false, granterEmail: null },
          shareViewStore: () => failingStore,
          relativePath: "docs/plans",
          trashItem: async () => {
            throw new Error("a share view's delete must not reach the ordinary trash path");
          },
        }),
      ).rejects.toThrow("EBUSY: projection delete failed");

      // What shareViewDelete actually left behind: both children gone from
      // the store, both children (not the folder path) marked pending, disk
      // untouched because materialization died before its rm.
      await expect(readPendingMaterializationPaths(rootDir)).resolves.toEqual(
        new Set(paths),
      );
      await expect(readFile(join(rootDir, paths[0]), "utf8")).resolves.toBe("one");
      await expect(readFile(join(rootDir, paths[1]), "utf8")).resolves.toBe("two");

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
        await expect(stat(join(rootDir, path))).rejects.toMatchObject({ code: "ENOENT" });
      }
      await expect(readPendingMaterializationPaths(rootDir)).resolves.toEqual(new Set());

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
      const rootDir = await tempRoot();
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
          captureSharedViewLocalDivergence(rootDir, WORKSPACE, store, true, SHARE_ID),
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
    const rootDir = await tempRoot();
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
      const listMoments = vi.fn(async (input: Parameters<typeof store.listMoments>[0]) => {
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
      });
      const pagingStore: typeof store = { ...store, listMoments };
      const before = await momentIds(store);

      await expect(
        captureSharedViewLocalDivergence(rootDir, WORKSPACE, pagingStore, true, SHARE_ID),
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
    const rootDir = await tempRoot();
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
        refreshStandaloneShareViewOnceWithPull({
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
        store.readTextFile({ workspaceId: WORKSPACE, versionId: main.id, path }),
      ).resolves.toBeNull();

      await writeFile(join(rootDir, path), "my own new file", "utf8");
      const beforeIds = await momentIds(store);

      await expect(
        captureSharedViewLocalDivergence(rootDir, WORKSPACE, store, true, SHARE_ID),
      ).resolves.toEqual({
        capturedPaths: 0,
        collisionRecordQuarantined: false,
        repairedPaths: 0,
        unjournalablePaths: [],
      });
      expect(await readFile(join(rootDir, path), "utf8")).toBe("my own new file");
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
    const rootDir = await tempRoot();
    const relay = new FakeShareRelay();
    const harness = daemonHarness(relay);
    const path = "docs/inconsistent.md";
    const target = { workspaceId: WORKSPACE, rootPath: rootDir };
    relay.addWrite(path, "before");
    await refreshSharedViewOnce(harness, { rootDir, workspaceId: WORKSPACE, shareId: SHARE_ID });
    await writeFile(join(rootDir, path), "after", "utf8");

    const store = harness.openStore(target);
    const inconsistentStore: typeof store = {
      ...store,
      async readTextFile(input) {
        if (input.path === path) return null;
        return await store.readTextFile(input);
      },
    };
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
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
        expect.stringContaining(
          `workspace ${WORKSPACE} version ${main.id}`,
        ),
      );
      expect(error).toHaveBeenCalledWith(expect.stringContaining(path));
    } finally {
      error.mockRestore();
      await store.close();
    }
  });

  it("counts local changes captured before the pull discovers the share ended", async () => {
    const rootDir = await tempRoot();
    const relay = new FakeShareRelay();
    const harness = daemonHarness(relay);
    const path = "docs/ended.md";
    const target = { workspaceId: WORKSPACE, rootPath: rootDir };
    relay.addWrite(path, "before");
    await refreshSharedViewOnce(harness, { rootDir, workspaceId: WORKSPACE, shareId: SHARE_ID });
    await writeFile(join(rootDir, path), "recipient edit", "utf8");
    relay.ended = true;

    const store = harness.openStore(target);
    try {
      await expect(
        refreshStandaloneShareViewOnceWithPull({
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
        lstat(join(rootDir, ".dohc", "pull-in-flight.marker")),
      ).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await store.close();
    }
  });

  it("repairs every tracked path after a pull stops before per-path markers", async () => {
    const rootDir = await tempRoot();
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
          interruptedInput as Parameters<typeof refreshSharedViewOnceWithPull>[0],
        ),
      ).rejects.toThrow("simulated crash after pull");
      await expect(
        readFile(join(rootDir, ".dohc", "pending-materialization.json"), "utf8"),
      ).rejects.toMatchObject({ code: "ENOENT" });
      const beforeRecovery = await momentIds(store);

      await expect(
        refreshStandaloneShareViewOnceWithPull({
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
        readFile(join(rootDir, ".dohc", "pull-in-flight.marker"), "utf8"),
      ).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await store.close();
    }
  });

  it("replaces a pull marker symlink without writing through it", async () => {
    const rootDir = await tempRoot();
    const outsideDir = await tempRoot();
    const externalPath = join(outsideDir, "external.txt");
    const markerPath = join(rootDir, ".dohc", "pull-in-flight.marker");
    const original = Buffer.from("outside authority stays unchanged", "utf8");
    await mkdir(join(rootDir, ".dohc"), { recursive: true });
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
    const rootDir = await tempRoot();
    const metadataDir = join(rootDir, ".dohc");

    await expect(clearPullInFlightMarker(rootDir)).resolves.toBeUndefined();

    await expect(lstat(metadataDir)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("refuses to write sidecars through a symlinked metadata directory", async () => {
    const rootDir = await tempRoot();
    const outsideDir = await tempRoot();
    const metadataDir = join(rootDir, ".dohc");
    await symlink(
      outsideDir,
      metadataDir,
      process.platform === "win32" ? "junction" : "dir",
    );
    const outsideBefore = await readdir(outsideDir);

    await expect(
      writePendingMaterializationPaths(rootDir, ["docs/pending.md"]),
    ).rejects.toThrow("not a real directory");

    expect(await readdir(outsideDir)).toEqual(outsideBefore);
    expect((await lstat(metadataDir)).isSymbolicLink()).toBe(true);
  });

  it("leaves a substituted pull-marker directory untouched", async () => {
    const rootDir = await tempRoot();
    const outsideDir = await tempRoot();
    const metadataDir = join(rootDir, ".dohc");
    const markerName = "pull-in-flight.marker";
    const markerPath = join(metadataDir, markerName);
    const target = { workspaceId: WORKSPACE, rootPath: rootDir };
    const published = new Error("leave the published marker in place");

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

    await rm(metadataDir, { force: true, recursive: true });
    await writeFile(join(outsideDir, markerName), "external marker", "utf8");
    const outsideBefore = await readdir(outsideDir);
    await symlink(
      outsideDir,
      metadataDir,
      process.platform === "win32" ? "junction" : "dir",
    );

    await expect(clearPullInFlightMarker(rootDir)).resolves.toBeUndefined();

    expect(await readdir(outsideDir)).toEqual(outsideBefore);
  });

  it("reports an ended share when pull-marker cleanup finds a metadata symlink", async () => {
    const rootDir = await tempRoot();
    const outsideDir = await tempRoot();
    const metadataDir = join(rootDir, ".dohc");

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

  it("refuses to clear pending paths through a substituted metadata directory", async () => {
    const rootDir = await tempRoot();
    const outsideDir = await tempRoot();
    const metadataDir = join(rootDir, ".dohc");
    const pendingName = "pending-materialization.json";
    const path = "docs/pending.md";

    await writePendingMaterializationPaths(rootDir, [path]);
    await expect(lstat(join(metadataDir, pendingName))).resolves.toBeTruthy();

    await rm(metadataDir, { force: true, recursive: true });
    await writeFile(
      join(outsideDir, pendingName),
      JSON.stringify({ counts: { [path]: 1 } }),
      "utf8",
    );
    const outsideBefore = await readdir(outsideDir);
    await symlink(
      outsideDir,
      metadataDir,
      process.platform === "win32" ? "junction" : "dir",
    );

    const error = await clearPendingMaterializationPaths(rootDir, [path]).then(
      () => null,
      (rejection: unknown) => rejection,
    );

    expect.soft(error).toBeInstanceOf(Error);
    expect.soft((error as Error).message).toContain("not a real directory");
    expect(await readdir(outsideDir)).toEqual(outsideBefore);
  });

  it("still journals a genuine edit while recovering an interrupted pull", async () => {
    const rootDir = await tempRoot();
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
          interruptedInput as Parameters<typeof refreshSharedViewOnceWithPull>[0],
        ),
      ).rejects.toThrow("simulated crash after pull");
      const beforeRecovery = new Set(await momentIds(store));

      await expect(
        refreshStandaloneShareViewOnceWithPull({
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
      ).resolves.toMatchObject({ status: "updated", changedPaths: 2 });

      expect(await readFile(join(rootDir, stalePath), "utf8")).toBe("moment B");
      await expect(
        store.readTextFile({
          workspaceId: WORKSPACE,
          versionId: main.id,
          path: editedPath,
        }),
      ).resolves.toMatchObject({ text: "recipient edit" });
      expect(await readFile(join(rootDir, editedPath), "utf8")).toBe(
        "recipient edit",
      );
      const addedMoments = (
        await store.listMoments({ workspaceId: WORKSPACE, limit: 200 })
      ).moments.filter((moment) => !beforeRecovery.has(moment.id));
      expect(addedMoments).toHaveLength(1);
      expect(addedMoments[0]).toMatchObject({
        path: editedPath,
        metadata: { origin: "local-file" },
      });
    } finally {
      await store.close();
    }
  });

  it("leaves a pending record after refresh materialization throws and repairs it later", async () => {
    const rootDir = await tempRoot();
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
      const before = await store.listMoments({ workspaceId: WORKSPACE, limit: 100 });
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
        readFile(join(rootDir, ".dohc", "pending-materialization.json"), "utf8"),
      ).resolves.toBe(JSON.stringify({ counts: { [path]: 1 } }));
      expect(commitCursor).not.toHaveBeenCalled();

      await expect(
        captureSharedViewLocalDivergence(rootDir, WORKSPACE, store, true, SHARE_ID),
      ).resolves.toEqual({
        capturedPaths: 0,
        collisionRecordQuarantined: false,
        repairedPaths: 1,
        unjournalablePaths: [],
      });
      expect(await readFile(join(rootDir, path), "utf8")).toBe("moment B");
      const after = await store.listMoments({ workspaceId: WORKSPACE, limit: 100 });
      expect(after.moments.map((moment) => moment.id)).toEqual(
        before.moments.map((moment) => moment.id),
      );
    } finally {
      await store.close();
    }
  });

  it("preserves an older disk body after two writes and a failed materialization", async () => {
    const rootDir = await tempRoot();
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
        store.readTextFile({ workspaceId: WORKSPACE, versionId: main.id, path }),
      ).resolves.toMatchObject({ text: "granter three" });
      expect(await readFile(join(rootDir, path), "utf8")).toBe("granter one");

      const recovered = await refreshStandaloneShareViewOnceWithPull({
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
      expect(recovered).toMatchObject({ status: "updated", changedPaths: 2 });

      const moments = (
        await store.listMoments({ workspaceId: WORKSPACE, limit: 200 })
      ).moments.filter((moment) => moment.path === path);
      const bodies = await Promise.all(
        moments.map(async (moment) =>
          (await store.getMoment({ workspaceId: WORKSPACE, momentId: moment.id }))
            ?.payload.after.text,
        ),
      );
      expect(bodies.filter((body) => body === "granter one")).toHaveLength(2);
      await expect(
        store.readTextFile({ workspaceId: WORKSPACE, versionId: main.id, path }),
      ).resolves.toMatchObject({ text: "granter three" });
      expect(await readFile(join(rootDir, path), "utf8")).toBe("granter three");
      await expect(
        readFile(join(rootDir, ".dohc", "pending-materialization.json"), "utf8"),
      ).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      failProjection = false;
      await store.close();
    }
  });

  it("issues zero readdir calls when a tracked view sits beside an untracked subtree", async () => {
    const rootDir = await tempRoot();
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

    const store = harness.openStore({ workspaceId: WORKSPACE, rootPath: rootDir });
    try {
      readdirCalls = [];
      await expect(
        captureSharedViewLocalDivergence(rootDir, WORKSPACE, store, true, SHARE_ID),
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
    const rootDir = await tempRoot();
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

    const store = harness.openStore({ workspaceId: WORKSPACE, rootPath: rootDir });
    try {
      const before = await store.listMoments({ workspaceId: WORKSPACE, limit: 100 });
      const beforeIds = new Set(before.moments.map((moment) => moment.id));
      await expect(
        captureSharedViewLocalDivergence(rootDir, WORKSPACE, store, true, SHARE_ID),
      ).resolves.toEqual({
        capturedPaths: 1,
        collisionRecordQuarantined: false,
        repairedPaths: 0,
        unjournalablePaths: [],
      });

      const main = await store.ensureMainVersion({ workspaceId: WORKSPACE });
      await expect(
        store.readTextFile({ workspaceId: WORKSPACE, versionId: main.id, path }),
      ).resolves.toBeNull();
      const after = await store.listMoments({ workspaceId: WORKSPACE, limit: 100 });
      const captured = after.moments.find((moment) => !beforeIds.has(moment.id));
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
      const rootDir = await tempRoot();
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

      const store = harness.openStore({ workspaceId: WORKSPACE, rootPath: rootDir });
      try {
        await denyRead(parent, "dir");
        try {
          await expect(
            captureSharedViewLocalDivergence(rootDir, WORKSPACE, store, true, SHARE_ID),
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
          captureSharedViewLocalDivergence(rootDir, WORKSPACE, store, true, SHARE_ID),
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
      const rootDir = await tempRoot();
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
      await writePendingMaterializationPaths(rootDir, [repairedPath, deniedPath]);

      const store = harness.openStore(target);
      try {
        await denyRead(parent, "dir");
        try {
          await expect(
            refreshStandaloneShareViewOnceWithPull({
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
          ).resolves.toMatchObject({ ok: false, changedPaths: 1 });
        } finally {
          await restoreRead(parent, 0o755);
        }
      } finally {
        await store.close();
      }
    },
  );

  it("preserves a repair count when clearing its pending marker fails", async () => {
    const rootDir = await tempRoot();
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
        path: join(rootDir, ".dohc", "pending-materialization.json"),
        error: new Error("pending marker unavailable"),
      };
      await expect(
        refreshStandaloneShareViewOnceWithPull({
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
      ).resolves.toMatchObject({ ok: false, changedPaths: 1 });
    } finally {
      failRenameToPathOnce = null;
      await store.close();
    }
  });

  it("keeps an engine failure inside pending repair distinct from an unreadable path", async () => {
    const rootDir = await tempRoot();
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
        refreshStandaloneShareViewOnceWithPull({
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
        changedPaths: 0,
        errorMessage: "engine store unavailable",
      });
    } finally {
      await store.close();
    }
  });

  itNonRoot(
    "preserves a leftover repair before pending path resolution finds an unreadable directory",
    async () => {
      const rootDir = await tempRoot();
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
        await writePendingMaterializationPaths(rootDir, [repairedPath, deniedPath]);
        await rm(join(rootDir, repairedPath));
        await denyRead(parent, "dir");
        try {
          await expect(
            refreshStandaloneShareViewOnceWithPull({
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
          ).resolves.toEqual({
            ok: false,
            changedPaths: 1,
            errorMessage: `dohc could not read ${deniedPath}. Close anything using this file, or wait.`,
          });
        } finally {
          await restoreRead(parent, 0o755);
        }
      } finally {
        await store.close();
      }
    },
  );

  itNonRoot(
    "reports a pending path below an unreadable directory and recovers when access returns",
    async () => {
      const rootDir = await tempRoot();
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
      await writePendingMaterializationPaths(rootDir, [repairedPath, deniedPath]);

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
        const deniedPathBlocker = withOrderedWorkspaceTextPath(
          rootDir,
          deniedPath,
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
        const refreshing = refreshStandaloneShareViewOnceWithPull({
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
          const failed = await refreshing;
          await expect(readPendingMaterializationPaths(rootDir)).resolves.toEqual(
            new Set([deniedPath]),
          );
          if (failed.ok) throw new Error("expected the unreadable refresh to fail");
          expect(failed).toMatchObject({
            changedPaths: 1,
          });
          expect(failed.errorMessage).toBe(
            `dohc could not read ${deniedPath}. Close anything using this file, or wait.`,
          );
        } finally {
          observeRealpath = null;
          releaseDeniedPathLock();
          await deniedPathBlocker;
          if (parentDenied) await restoreRead(parent, 0o755);
        }

        await expect(
          refreshStandaloneShareViewOnceWithPull({
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
        ).resolves.toMatchObject({ ok: true, status: "updated", changedPaths: 1 });
        await expect(readPendingMaterializationPaths(rootDir)).resolves.toEqual(
          new Set(),
        );
      } finally {
        await store.close();
      }
    },
  );

  it("reports and preserves a symlink that replaced a tracked file", async () => {
    const rootDir = await tempRoot();
    const outsideRoot = await tempRoot();
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

    const store = harness.openStore({ workspaceId: WORKSPACE, rootPath: rootDir });
    try {
      const before = await store.listMoments({ workspaceId: WORKSPACE, limit: 100 });
      await expect(
        captureSharedViewLocalDivergence(rootDir, WORKSPACE, store, true, SHARE_ID),
      ).resolves.toEqual({
        capturedPaths: 0,
        collisionRecordQuarantined: false,
        repairedPaths: 0,
        unjournalablePaths: [
          { path, reason: "non-file-replacement" },
        ],
      });
      const main = await store.ensureMainVersion({ workspaceId: WORKSPACE });
      await expect(
        store.readTextFile({ workspaceId: WORKSPACE, versionId: main.id, path }),
      ).resolves.toMatchObject({ text: "tracked body" });
      const after = await store.listMoments({ workspaceId: WORKSPACE, limit: 100 });
      expect(after.moments.map((moment) => moment.id)).toEqual(
        before.moments.map((moment) => moment.id),
      );

      relay.addWrite(path, "new granter body");
      await expect(
        refreshStandaloneShareViewOnceWithPull({
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
        unjournalablePaths: [
          { path, reason: "non-file-replacement" },
        ],
      });
      expect((await lstat(join(rootDir, path))).isSymbolicLink()).toBe(true);
      expect(await readFile(outside, "utf8")).toBe("foreign body");
    } finally {
      await store.close();
    }
  });

  it("does not echo a freshly materialized file into another moment", async () => {
    const rootDir = await tempRoot();
    const relay = new FakeShareRelay();
    const harness = daemonHarness(relay);
    relay.addWrite("docs/a.md", "fresh projection");
    await refreshSharedViewOnce(harness, {
      rootDir,
      workspaceId: WORKSPACE,
      shareId: SHARE_ID,
    });

    const store = harness.openStore({ workspaceId: WORKSPACE, rootPath: rootDir });
    try {
      const before = await store.listMoments({ workspaceId: WORKSPACE, limit: 100 });
      await expect(
        captureSharedViewLocalDivergence(rootDir, WORKSPACE, store, true, SHARE_ID),
      ).resolves.toEqual({
        capturedPaths: 0,
        collisionRecordQuarantined: false,
        repairedPaths: 0,
        unjournalablePaths: [],
      });
      const after = await store.listMoments({ workspaceId: WORKSPACE, limit: 100 });
      expect(after.moments.map((moment) => moment.id)).toEqual(
        before.moments.map((moment) => moment.id),
      );
    } finally {
      await store.close();
    }
  });

  it("refuses to track a secret-classified path in the engine store", async () => {
    const rootDir = await tempRoot();
    const relay = new FakeShareRelay();
    const harness = daemonHarness(relay);
    relay.addWrite("docs/seed.md", "seed");
    await refreshSharedViewOnce(harness, {
      rootDir,
      workspaceId: WORKSPACE,
      shareId: SHARE_ID,
    });

    const store = harness.openStore({ workspaceId: WORKSPACE, rootPath: rootDir });
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
    const rootDir = await tempRoot();
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
    expect(await readFile(join(rootDir, "docs/a.md"), "utf8")).toBe("first body");
    expect(await readFile(join(rootDir, "docs/nested/deep.md"), "utf8")).toBe("deep body");
    // The cursor moved because refreshSharedViewOnce committed it through
    // sync.commitCursor — the ONLY thing that advances it. Without this the
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
    expect(await readFile(join(rootDir, "docs/a.md"), "utf8")).toBe("updated body");
    await expect(stat(join(rootDir, "docs/nested/deep.md"))).rejects.toMatchObject({
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
    expect(await readFile(join(rootDir, "docs/a.md"), "utf8")).toBe("updated body");

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
    // Every row below carries a VALID access, so each is refused for the
    // reason it names rather than for a missing level.
    ["no paths array", { versionId: "v1", access: "view" }],
    ["a non-string path", { paths: ["docs", 7], versionId: null, access: "view" }],
    // Selects NOTHING: the relay refuses to create this one
    // (`empty_selector`) and serves nothing through it.
    ["selects nothing", { paths: [], versionId: null, access: "view" }],
    // A version id the relay could not have issued. These are the dangerous
    // ones: the engine reads any version-bearing selector with no paths as
    // granting every tracked path, so a damaged version must never be read as
    // a version at all.
    ["an empty version id", { paths: [], versionId: "", access: "view" }],
    ["a whitespace-only version id", { paths: [], versionId: "   ", access: "view" }],
    ["a padded version id", { paths: [], versionId: " v1 ", access: "view" }],
    [
      "an unbounded version id",
      { paths: [], versionId: "v".repeat(129), access: "view" },
    ],
    // The level dimension (#646). A record whose level is missing or
    // unreadable is damaged the same way, and its refresh must not pull at a
    // level nobody granted.
    ["no access at all", { paths: ["docs"], versionId: null }],
    ["a cased access", { paths: ["docs"], versionId: null, access: "View" }],
    ["a padded access", { paths: ["docs"], versionId: null, access: "edit " }],
    [
      "a chat-channel access value",
      { paths: ["docs"], versionId: null, access: "read-write" },
    ],
  ];

  for (const [label, pinnedSelector] of damagedPins) {
    it(`refuses to pull when the pinned selector is ${label}`, async () => {
      const rootDir = await tempRoot();
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
        `MUTATION: reading a ${label} pin as a grant pulls against a scope the relay never issued`,
      ).toBe(0);
      await expect(stat(join(rootDir, "docs/a.md"))).rejects.toMatchObject({
        code: "ENOENT",
      });
      await harness.closeAll();
    });
  }

  it("rejects a damaged pin through the standalone refresh wrapper", async () => {
    const rootDir = await tempRoot();
    const relay = new FakeShareRelay();
    const harness = daemonHarness(relay);
    const target = { workspaceId: WORKSPACE, rootPath: rootDir };
    const store = harness.openStore(target);

    try {
      await expect(
        refreshStandaloneShareViewOnceWithPull({
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
    const rootDir = await tempRoot();
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

  // A pinned selector is used EXACTLY as recorded, and the relay is never
  // asked to restate it. There is no code path left that could.
  // The pull SKIPS an op it refuses and keeps going, which is the right
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
    const rootDir = await tempRoot();
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
        "MUTATION: swallowing the refusal leaves a bare count the user never sees",
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
    const rootDir = await tempRoot();
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
    expect(await readFile(join(rootDir, "docs/a.md"), "utf8")).toBe("first body");

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
      "MUTATION: re-fetching the selector lets the relay restate the grant on every pull",
    ).toBe(0);
  });

  // A read that fails must not cost the user the file they already had.
  // preparedTarget removes the existing projection, so reading afterwards
  // would leave a hole — and because the cursor is only committed after a
  // clean pass, every later refresh would replay into the same hole.
  it("leaves the existing projection intact when the content read fails", async () => {
    const rootDir = await tempRoot();
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
    const rootDir = await tempRoot();
    await expect(
      materializeSharedViewPaths(
        rootDir,
        WORKSPACE,
        [{ path: "../escape.md", operation: "write", contentKind: "text" }],
        // The refusal happens before any CONTENT read, so a store whose
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
});

// #646 PR3-1 — which share views ask for a sync identity.
//
// The main process runs this before every pull and push. It must fail closed
// on every tri-state: skip, never throw, and never enrol a share that may not
// push.
describe("shareViewIdentitySelector", () => {
  const COMMENT = { paths: ["docs"], versionId: null, access: "comment" };
  const match = (left: string, right: string): boolean => left === right;

  function decide(
    shareView: Parameters<
      typeof shareViewIdentitySelector
    >[0]["shareView"],
    relayUrl: string | null = "https://relay.example",
  ) {
    return shareViewIdentitySelector({
      shareView,
      relayUrl,
      relayUrlsMatch: match,
    });
  }

  it("enrols a comment or edit share view against its pinned grant", () => {
    for (const access of ["comment", "edit"] as const) {
      expect(
        decide({
          grantedSelector: { ...COMMENT, access },
          relayUrl: "https://relay.example",
        }),
      ).toEqual({ paths: ["docs"], versionId: null, access });
    }
  });

  it("never enrols a view share, which may push nothing", () => {
    expect(
      decide({
        grantedSelector: { ...COMMENT, access: "view" },
        relayUrl: "https://relay.example",
      }),
    ).toBeNull();
  });

  it("skips a share view whose pinned grant is damaged", () => {
    // One damaged field per case, each already refused by
    // `recordedShareSelector`. A record this build cannot read completely is
    // not a narrower grant, so it must not enrol at a level nobody granted.
    for (const grantedSelector of [
      undefined,
      null,
      { ...COMMENT, access: "owner" },
      { ...COMMENT, access: undefined },
      { ...COMMENT, paths: "docs" },
      { ...COMMENT, paths: ["../escape"] },
      { ...COMMENT, paths: ["docs/"] },
      { paths: [], versionId: null, access: "comment" },
      { ...COMMENT, versionId: " v1" },
    ]) {
      expect(
        decide({ grantedSelector, relayUrl: "https://relay.example" }),
      ).toBeNull();
    }
  });

  it("skips a share that has ended", () => {
    expect(
      decide({
        grantedSelector: COMMENT,
        ended: true,
        relayUrl: "https://relay.example",
      }),
    ).toBeNull();
  });

  it("skips a workspace that is not a share view at all", () => {
    expect(decide(null)).toBeNull();
    expect(decide(undefined)).toBeNull();
  });

  it("skips when there are no dohc Cloud credentials", () => {
    for (const relayUrl of [null, ""]) {
      expect(
        decide(
          { grantedSelector: COMMENT, relayUrl: "https://relay.example" },
          relayUrl,
        ),
      ).toBeNull();
    }
  });

  it("skips a session signed into a relay that is not this share's origin", () => {
    expect(
      decide(
        { grantedSelector: COMMENT, relayUrl: "https://origin.example" },
        "https://other.example",
      ),
    ).toBeNull();
    // A record with no origin relay predates that field; the session's relay
    // is all there is, and it enrols.
    expect(decide({ grantedSelector: COMMENT })).toEqual({
      paths: ["docs"],
      versionId: null,
      access: "comment",
    });
  });
});
