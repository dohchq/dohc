import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
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
  readPendingMaterializationPaths,
  SharePinInvalidError,
  materializeSharedViewPaths,
  refreshStandaloneShareViewOnce as refreshStandaloneShareViewOnceWithPull,
  refreshSharedViewOnce as refreshSharedViewOnceWithPull,
  shareViewIdentitySelector,
  writePendingMaterializationPaths,
} from "./sharedView";
import {
  MAX_ENGINE_CAPTURE_BINARY_BYTES,
  MAX_ENGINE_CAPTURE_TEXT_BYTES,
} from "./workspaceEngineCapture";
import { routeWorkspaceFileCreate } from "./workspaceFileOps";
import { routeWorkspaceTextWrite } from "./workspaceTextWrite";
import { withOrderedWorkspaceTextPath } from "./workspaceAssets";
import type { ShareViewRefusal } from "@dohc/workspace-contracts/relay";
import { denyRead, restoreRead } from "@dohc/workspace-fs/testing";
import { createTestScratch } from "./testTemp";

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
});

afterEach(async () => {
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
      const since = Number(parsed.searchParams.get("since") ?? 0);
      const rows = this.ops.filter((op) => Number(op.relaySeq) > since);
      const last = rows[rows.length - 1];
      return Response.json({
        ok: true,
        ops: rows,
        nextCursor: Number(last?.relaySeq ?? since),
        hasMore: false,
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
      expect(quiet.status).toBe("unchanged");
      expect(await readFile(join(rootDir, path), "utf8")).toBe("outside editor");
      const settled = await store.listMoments({ workspaceId: WORKSPACE, limit: 100 });
      expect(settled.moments.map((entry) => entry.id)).toEqual(momentIds);
    } finally {
      await store.close();
    }
  });

  it("does not journal an out-of-app edit when a view-level share refreshes", async () => {
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
    await writeFile(join(rootDir, path), "recipient tampered", "utf8");

    const store = harness.openStore(target);
    try {
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
      expect(outcome.changedPaths).toBe(0);
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
        repairedPaths: 0,
        unjournalablePaths: [],
      });
      expect(await momentIds(store)).toEqual(before);
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
        repairedPaths: 0,
        unjournalablePaths: [],
      });
      expect(await momentIds(store)).toEqual(before);
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
      );
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(repairMaterializationStarted).toBe(false);
      releaseSave();

      await expect(saving).resolves.toMatchObject({ status: "written" });
      await expect(repairing).resolves.toMatchObject({ unjournalablePaths: [] });
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
        captureSharedViewLocalDivergence(rootDir, WORKSPACE, racingStore),
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
        captureSharedViewLocalDivergence(rootDir, WORKSPACE, store),
      ).resolves.toEqual({
        capturedPaths: 0,
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
        captureSharedViewLocalDivergence(rootDir, WORKSPACE, store),
      ).resolves.toEqual({
        capturedPaths: 1,
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
        captureSharedViewLocalDivergence(rootDir, WORKSPACE, store),
      ).resolves.toEqual({
        capturedPaths: 0,
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
        captureSharedViewLocalDivergence(rootDir, WORKSPACE, store),
      ).resolves.toEqual({ capturedPaths: 0, repairedPaths: 1, unjournalablePaths: [] });
      expect(await readFile(join(rootDir, path), "utf8")).toBe("moment two");
      expect(await momentIds(store)).toEqual(before);
      await expect(readPendingMaterializationPaths(rootDir)).resolves.toEqual(new Set());
    } finally {
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
        captureSharedViewLocalDivergence(rootDir, WORKSPACE, store),
      ).resolves.toEqual({ capturedPaths: 1, repairedPaths: 0, unjournalablePaths: [] });
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
      );
      const main = await store.ensureMainVersion({ workspaceId: WORKSPACE });
      const head = await store.readTextFile({
        workspaceId: WORKSPACE,
        versionId: main.id,
        path,
      });
      const disk = await readFile(join(rootDir, path), "utf8");
      expect(
        disk === "recipient real edit" || head?.text === "recipient real edit",
        "the recipient out-of-app edit was silently discarded",
      ).toBe(true);
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
      ).rejects.toThrow("offline");
      await expect(readPendingMaterializationPaths(rootDir)).resolves.toEqual(
        new Set(),
      );

      await writeFile(join(rootDir, path), "recipient edit two", "utf8");
      await expect(
        captureSharedViewLocalDivergence(rootDir, WORKSPACE, store),
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
        captureSharedViewLocalDivergence(rootDir, WORKSPACE, store),
      ).resolves.toEqual({ capturedPaths: 0, repairedPaths: 1, unjournalablePaths: [] });
      await expect(stat(join(rootDir, path))).rejects.toMatchObject({ code: "ENOENT" });
      expect(await momentIds(store)).toEqual(before);
      await expect(readPendingMaterializationPaths(rootDir)).resolves.toEqual(new Set());
    } finally {
      await store.close();
    }
  });

  it("S-leftover: a pending UNTRACKED path deletes the recipient's own new file", async () => {
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
      ).rejects.toThrow("EBUSY: projection write failed");
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
        captureSharedViewLocalDivergence(rootDir, WORKSPACE, store),
      ).resolves.toEqual({
        capturedPaths: 0,
        repairedPaths: 1,
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
        captureSharedViewLocalDivergence(rootDir, WORKSPACE, inconsistentStore),
      ).resolves.toEqual({ capturedPaths: 0, repairedPaths: 0, unjournalablePaths: [] });
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

  it("does not count captured local changes after the share has ended", async () => {
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
      ).resolves.toMatchObject({ status: "ended", changedPaths: 0 });
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
          pull: async () => ({
            fetched: 1,
            applied: 1,
            skipped: 0,
            nextCursor: 1,
            refusalCount: 0,
            refusals: [],
            changedPaths: [{ path, operation: "write", contentKind: "text" }],
            commitCursor,
          }),
        } as Parameters<typeof refreshSharedViewOnceWithPull>[0]),
      ).rejects.toThrow("materialization interrupted");
      await expect(
        readFile(join(rootDir, ".dohc", "pending-materialization.json"), "utf8"),
      ).resolves.toBe(JSON.stringify({ counts: { [path]: 1 } }));
      expect(commitCursor).not.toHaveBeenCalled();

      await expect(
        captureSharedViewLocalDivergence(rootDir, WORKSPACE, store),
      ).resolves.toEqual({
        capturedPaths: 0,
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
        captureSharedViewLocalDivergence(rootDir, WORKSPACE, store),
      ).resolves.toEqual({
        capturedPaths: 1,
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

  it("leaves a symlink at a tracked path outside the journal", async () => {
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
        captureSharedViewLocalDivergence(rootDir, WORKSPACE, store),
      ).resolves.toEqual({
        capturedPaths: 0,
        repairedPaths: 0,
        unjournalablePaths: [],
      });
      const main = await store.ensureMainVersion({ workspaceId: WORKSPACE });
      await expect(
        store.readTextFile({ workspaceId: WORKSPACE, versionId: main.id, path }),
      ).resolves.toMatchObject({ text: "tracked body" });
      const after = await store.listMoments({ workspaceId: WORKSPACE, limit: 100 });
      expect(after.moments.map((moment) => moment.id)).toEqual(
        before.moments.map((moment) => moment.id),
      );
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
        captureSharedViewLocalDivergence(rootDir, WORKSPACE, store),
      ).resolves.toEqual({
        capturedPaths: 0,
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
