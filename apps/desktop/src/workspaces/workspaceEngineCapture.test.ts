import type { MomentAuthor } from "@dohc/workspace-contracts";
import type {
  MaterializeRelayPullPage,
  RelayMaterializedPath,
} from "@dohc/workspace-contracts/relay";
import { defaultWorkspaceMode } from "@dohc/workspace-core";
import { denyRead, restoreRead } from "@dohc/workspace-fs/testing";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CreatedWorkspace } from "./createWorkspaceFolder";
import { mockLiveSessions } from "../testing/liveEngineSessions";
import {
  localWorkspaceSdkDatabaseEditor,
  localWorkspaceSdkReads,
} from "../testing/localWorkspaceSdkReads";
import { createInMemoryWorkspaceActivity as createWorkspaceActivity } from "./workspaceActivity.testSupport";
import { invokePluginSdkHost } from "../plugins/pluginSdkHost";
import {
  DAEMON_CAPTURE_HEALTH_POLL_MS,
  MAX_ENGINE_CAPTURE_BINARY_BYTES,
  MAX_SETTLED_FILE_BYTES,
  UnsupportedWorkspacePathError,
  assertGeneratedMarkdownPath,
  createDefaultDiskWriter,
  createWorkspaceEngineCapture,
  isYDocPathNotInVersionError,
  probeEngineStoreRefusal,
  YDocOpenRacedError,
  YDocSessionUnreleasedError,
  YDocUncapturedArtifactError,
  type EngineDiskWriter,
  type WorkspaceEngineCapture,
  type WorkspaceEngineCaptureFailure,
} from "./workspaceEngineCapture";
import {
  DaemonRefusalError,
  type ArtifactAssetDescriptor,
  type EngineYdocProviderSession,
  type EngineYdocProviderSessionOptions,
  VERSIONED_METHOD,
  type JsonValue,
  type Request,
  type Response,
} from "@dohc/workspace-engine-client";
import { VersionedLoopbackEngine } from "@dohc/workspace-engine-client/testing";
import { startWorkspaceWatch } from "./workspaceWatcher";
import { EngineWorkspaceSessions } from "@dohc/workspace-engine-client/daemon";
import {
  createCaptureLiveStores,
  type CaptureVersionedTextStore,
} from "./workspaceEngineCaptureLiveStore";
import * as Y from "yjs";
import { MAX_DESKTOP_CAPTURE_TEXT_BYTES } from "@dohc/workspace-engine-client/limits";
import { deferred } from "../testing/deferred";

import { createTestScratch } from "./testTemp";
afterEach(async () => {
  vi.restoreAllMocks();
});

interface EngineMomentRow {
  path: string;
  operation: string;
  text: string;
  origin: string;
  summary: string | null;
  correlationId: string | null;
}

async function write(root: string, path: string, contents: string | Uint8Array) {
  const absolute = join(root, path);
  await mkdir(dirname(absolute), { recursive: true });
  await writeFile(absolute, contents);
}

function sha256Utf8(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

const WORKSPACE_ID = "engine-capture-test";
const WORKSPACE_ATTACHMENT_ID = Symbol("workspace-engine-capture-test");

// chmod/ACL-based fixtures cannot make a path unreadable for root (root
// ignores file modes), so every test that needs an unreadable path skips
// under uid 0.
const itNonRoot = process.getuid?.() === 0 ? it.skip : it;

interface CaptureOptions {
  store?: CaptureVersionedTextStore;
  now?: () => number;
  createId?: () => string;
  onError?: (context: string, error: unknown) => void;
  onCaptureOutcome?: (failure: WorkspaceEngineCaptureFailure, detail?: string | null) => void;
  rustEngineSessions?: EngineWorkspaceSessions;
  diskWriter?: EngineDiskWriter;
  openRustYDocProviderSession?: (
    options: EngineYdocProviderSessionOptions,
  ) => Promise<EngineYdocProviderSession>;
}

function capture(root: string, options: CaptureOptions = {}) {
  const { rustEngineSessions, ...rest } = options;
  return createWorkspaceEngineCapture({
    workspaceId: WORKSPACE_ID,
    rootPath: root,
    attachmentId: WORKSPACE_ATTACHMENT_ID,
    rustEngineSessions:
      rustEngineSessions ?? mockLiveSessions(new VersionedLoopbackEngine()),
    ...rest,
  });
}

describe("probeEngineStoreRefusal", () => {
  it("probes through the exact attachment session key", async () => {
    const root = await createTestScratch("dohc-engine-capture-");
    const sessions = mockLiveSessions(new VersionedLoopbackEngine());
    const run = vi.spyOn(sessions, "run");
    const attachmentId = Symbol("attachment");

    await expect(
      probeEngineStoreRefusal(
        { workspaceId: WORKSPACE_ID, rootPath: root, attachmentId },
        sessions,
      ),
    ).resolves.toBeNull();
    expect(run).toHaveBeenCalled();
    expect(run.mock.calls[0]?.[0]).toMatchObject({
      workspaceId: WORKSPACE_ID,
      rootPath: root,
      attachmentId,
    });
  });

  it("rethrows an unrecognized engine error", async () => {
    const root = await createTestScratch("dohc-engine-capture-");
    const probeError = Object.assign(new Error("permission denied"), {
      code: "EACCES",
    });
    const sessions = mockLiveSessions(
      new VersionedLoopbackEngine(),
      undefined,
      () => ({ settled: true, running: true, degraded: false }),
      async () => {
        throw probeError;
      },
    );

    await expect(
      probeEngineStoreRefusal(
        {
          workspaceId: WORKSPACE_ID,
          rootPath: root,
          attachmentId: WORKSPACE_ATTACHMENT_ID,
        },
        sessions,
      ),
    ).rejects.toBe(probeError);
  });
});

// Daemon-path capture: `rustEngineSessions` selects the Rust engine, and the
// VersionedLoopbackEngine behind it holds real state and real sha256 — so the
// history these tests read back is recorded engine state, not a hand-written
// responder. Passing the same loopback to two captures models two sessions
// against one workspace, the way two sessions shared one engine.db before.
function liveCapture(
  root: string,
  loopback: VersionedLoopbackEngine,
  options: Omit<CaptureOptions, "rustEngineSessions"> & { requests?: Request[] } = {},
): WorkspaceEngineCapture {
  const { requests, ...rest } = options;
  return capture(root, {
    rustEngineSessions: mockLiveSessions(loopback, requests),
    ...rest,
  });
}

// The daemon-path equivalent of readEngineMoments: the same six facts, read
// through the engine's own timeline API. Oldest first, matching the raw
// `ORDER BY moment_order` query. Protected (secret) rows are dropped here
// exactly as a query against the text `moments` table dropped them.
async function liveMoments(engine: WorkspaceEngineCapture): Promise<EngineMomentRow[]> {
  // DRAINED, not capped. An earlier draft asked for one 500-row page, which
  // returns the newest 500 — so the moment a test recorded more, the reversed
  // array stopped being oldest-first and every count and sequence assertion
  // below would have compared against a truncated page without saying so. A cap
  // here is a limit rejecting valid work; paging costs nothing and removes the
  // question. (Same correction as the moments reader on #417.)
  const summaries: Awaited<ReturnType<WorkspaceEngineCapture["listMoments"]>>["moments"] = [];
  let beforeMomentOrder: number | undefined;
  for (;;) {
    const page = await engine.listMoments({
      ...(beforeMomentOrder === undefined ? {} : { beforeMomentOrder }),
    });
    summaries.push(...page.moments);
    if (page.nextBeforeMomentOrder === null) break;
    beforeMomentOrder = page.nextBeforeMomentOrder;
  }
  const rows: EngineMomentRow[] = [];
  for (const summary of [...summaries].reverse()) {
    if (summary.protected) continue;
    const detail = await engine.readMoment(summary.id);
    // A null detail must fail, not collapse to an empty body: `text: ""` for a
    // missing read makes a readMoment regression look like an empty file, which
    // several assertions below would accept.
    if (detail === null) {
      throw new Error(`readMoment returned null for ${summary.id} (${summary.path})`);
    }
    const payload = detail.protected === false ? detail.moment.payload : undefined;
    rows.push({
      path: summary.path,
      operation: summary.operation,
      text: payload?.after.text ?? "",
      origin: summary.metadata.origin,
      summary: summary.metadata.summary ?? null,
      correlationId: summary.metadata.correlationId ?? null,
    });
  }
  return rows;
}

// A loopback whose versioned requests reject while `failing` is true — the
// daemon-path stand-in for a broken engine store. Only the calls that carry
// history fail: workspace open/close, capture flush, and watcher status are
// answered by mockLiveSessions before the request reaches here, exactly as a
// live daemon whose store is failing would still answer its lifecycle calls.
function failableLoopback(match: (request: Request) => boolean = () => true): {
  loopback: VersionedLoopbackEngine;
  state: { failing: boolean };
} {
  const real = new VersionedLoopbackEngine();
  const state = { failing: true };
  const loopback = new Proxy(real, {
    get(target, prop, receiver) {
      if (prop !== "sendRequest") return Reflect.get(target, prop, receiver);
      return async (request: Request) => {
        if (state.failing && match(request)) {
          throw new Error("engine store unavailable");
        }
        return await target.sendRequest(request);
      };
    },
  });
  return { loopback, state };
}

// The daemon-path equivalent of readEngineMomentAuthors: the author each
// recorded moment carries, oldest first, with null for actor-neutral.
async function liveMomentAuthors(
  engine: WorkspaceEngineCapture,
): Promise<Array<MomentAuthor | null>> {
  const page = await engine.listMoments({ limit: 500 });
  return [...page.moments]
    .reverse()
    .filter((moment) => !moment.protected)
    .map((moment) => moment.author ?? null);
}

describe("workspaceEngineCapture batch capture", () => {
  it("uses the daemon as the sole capture and version-switch materialization owner", async () => {
    const root = await createTestScratch("dohc-engine-capture-");
    const loopback = new VersionedLoopbackEngine();
    const requests: Request[] = [];
    loopback.seedTextFile({
      workspace: "engine-capture-test",
      versionId: "main",
      path: "note.md",
      text: "main",
    });
    const engine = capture(root, {
      rustEngineSessions: mockLiveSessions(loopback, requests),
    });

    engine.start();
    await engine.flush();
    engine.captureBatch([{ path: "note.md", operation: "update" }]);
    await engine.flush();
    expect(
      loopback.requests.some(
        (request) =>
          request.method === VERSIONED_METHOD.textWrite ||
          request.method === VERSIONED_METHOD.textDelete,
      ),
    ).toBe(false);

    const draft = await engine.createVersion("Draft");
    loopback.requests.length = 0;
    requests.length = 0;
    const result = await engine.switchVersion("main");

    expect(result).toEqual({
      activeVersionId: "main",
      changedFileCount: 0,
    });
    expect(
      loopback.requests.some(
        (request) =>
          request.method === VERSIONED_METHOD.textRead ||
          request.method === VERSIONED_METHOD.binaryRead ||
          request.method === VERSIONED_METHOD.textWrite ||
          request.method === VERSIONED_METHOD.textDelete,
      ),
    ).toBe(false);
    const flushIndex = requests.findIndex(
      (request) => request.method === "capture.flush",
    );
    expect(flushIndex, "omit the daemon flush in switchVersion. Source metadata is listed without a capture settlement between the target preflight and the before/after comparison.").toBeGreaterThanOrEqual(0);
    expect(
      requests
        .slice(flushIndex + 1)
        .some((request) => request.method === VERSIONED_METHOD.textList),
    ).toBe(true);
    expect(
      loopback.requests.some(
        (request) => request.method === VERSIONED_METHOD.versionsSetActive,
      ),
    ).toBe(true);
    expect(draft.activeVersionId).not.toBe("main");
    await engine.stop();
  });

  it("flushes daemon capture before resolving a file object id", async () => {
    const root = await createTestScratch("dohc-engine-capture-");
    const loopback = new VersionedLoopbackEngine();
    const requests: Request[] = [];
    loopback.seedTextFile({
      workspace: "engine-capture-test",
      versionId: "main",
      path: "just-saved.md",
      text: "ready for chat",
    });
    const engine = capture(root, {
      rustEngineSessions: mockLiveSessions(loopback, requests),
    });

    const objectId = await engine.fileObjectIdForPath("just-saved.md");
    const relevant = requests
      .map((request) => request.method)
      .filter(
        (method) =>
          method === "capture.flush" || method === VERSIONED_METHOD.textRead,
      );

    expect(objectId).toBeTruthy();
    expect(relevant, "remove fileObjectIdForPath's flushCapture call. The read remains, making this order assertion fail on the missing first entry.").toEqual(["capture.flush", VERSIONED_METHOD.textRead]);
    await engine.stop();
  });

  it("continues draining pending collection adoptions after one adoption fails", async () => {
    const root = await createTestScratch("dohc-engine-capture-");
    let listed = false;
    const store = {
      ensureMainVersion: async () => undefined,
      flushCapture: async () => undefined,
      reconcileCapture: async () => undefined,
      listPendingCollectionAdoptions: async () => {
        if (listed) return { adoptions: [], nextCursor: null };
        listed = true;
        return {
          adoptions: [
            {
              versionId: "main",
              recordId: "rec_aaaaaaaaaaaaaaaaaaaaaaaaaa",
              collectionPath: "projects",
              filePath: "projects/poisoned.md",
              objectId: "object-poisoned",
            },
            {
              versionId: "main",
              recordId: "rec_bbbbbbbbbbbbbbbbbbbbbbbbbb",
              collectionPath: "projects",
              filePath: "projects/healthy.md",
              objectId: "object-healthy",
            },
          ],
          nextCursor: null,
        };
      },
    } as unknown as CaptureVersionedTextStore;
    const poison = new Error("poisoned adoption");
    let adoptionRuns = 0;
    const sessions = {
      run: async (_workspace: unknown, task: (binding: unknown) => unknown) => {
        adoptionRuns += 1;
        if (adoptionRuns === 1) throw poison;
        return await task({ client: {}, workspace: "workspace" });
      },
    } as unknown as EngineWorkspaceSessions;
    const errors: Array<{ context: string; error: unknown }> = [];
    const engine = capture(root, {
      store,
      rustEngineSessions: sessions,
      onError: (context, error) => errors.push({ context, error }),
      openRustYDocProviderSession: async (options) =>
        ({ path: options.path, evict: async () => undefined }) as EngineYdocProviderSession,
    });

    await engine.flush();

    expect(adoptionRuns).toBe(2);
    expect(errors).toEqual([
      {
        context: "collection adoption of projects/poisoned.md",
        error: poison,
      },
    ]);
    await engine.stop();
  });

  it("retries a busy collection adoption provider on a later pass while other items proceed", async () => {
    const root = await createTestScratch("dohc-engine-capture-");
    const adoptions = [
      {
        versionId: "main",
        recordId: "rec_aaaaaaaaaaaaaaaaaaaaaaaaaa",
        collectionPath: "projects",
        filePath: "projects/busy.md",
        objectId: "object-busy",
      },
      {
        versionId: "main",
        recordId: "rec_bbbbbbbbbbbbbbbbbbbbbbbbbb",
        collectionPath: "projects",
        filePath: "projects/healthy.md",
        objectId: "object-healthy",
      },
    ];
    const completed = new Set<string>();
    const attempts: string[] = [];
    const leasedPaths = new Set<string>();
    const store = {
      ensureMainVersion: async () => undefined,
      flushCapture: async () => undefined,
      reconcileCapture: async () => {
        attempts.push("reconcile");
        if (leasedPaths.size > 0) {
          throw new Error("collection-reconciliation-lease-held");
        }
      },
      listPendingCollectionAdoptions: async () => ({
        adoptions: adoptions.filter(
          (adoption) => !completed.has(adoption.filePath),
        ),
        nextCursor: null,
      }),
    } as unknown as CaptureVersionedTextStore;
    const busy = new DaemonRefusalError(
      {
        code: "OVERLOADED",
        message: "engine-store-busy",
        retry: "afterBackoff",
      },
      undefined,
    );
    const opens = new Map<string, number>();
    const sessions = {
      run: async (_workspace: unknown, task: (binding: unknown) => unknown) =>
        await task({ client: {}, workspace: "workspace" }),
    } as unknown as EngineWorkspaceSessions;
    const errors: Array<{ context: string; error: unknown }> = [];
    const engine = capture(root, {
      store,
      rustEngineSessions: sessions,
      onError: (context, error) => errors.push({ context, error }),
      openRustYDocProviderSession: async (options) => {
        opens.set(options.path, (opens.get(options.path) ?? 0) + 1);
        leasedPaths.add(options.path);
        let evictions = 0;
        return {
          path: options.path,
          evict: async () => {
            evictions += 1;
            attempts.push(`${options.path}:${evictions}`);
            if (options.path === "projects/busy.md" && evictions === 1) {
              throw busy;
            }
            leasedPaths.delete(options.path);
            completed.add(options.path);
          },
        } as EngineYdocProviderSession;
      },
    });

    await engine.flush();

    expect(completed).toEqual(new Set(["projects/healthy.md"]));
    expect(attempts).toEqual([
      "projects/busy.md:1",
      "projects/healthy.md:1",
    ]);
    expect(errors).toEqual([]);

    await engine.flush();

    expect(completed).toEqual(
      new Set(["projects/healthy.md", "projects/busy.md"]),
    );
    expect(attempts).toEqual([
      "projects/busy.md:1",
      "projects/healthy.md:1",
      "projects/busy.md:2",
      "reconcile",
    ]);
    expect(opens).toEqual(
      new Map([
        ["projects/busy.md", 1],
        ["projects/healthy.md", 1],
      ]),
    );
    expect(errors).toEqual([]);
    await engine.stop();
  });

  it("retains the provider after a cancelled eviction and reuses it on a later pass", async () => {
    const root = await createTestScratch("dohc-engine-capture-");
    const adoption = {
      versionId: "main",
      recordId: "rec_aaaaaaaaaaaaaaaaaaaaaaaaaa",
      collectionPath: "projects",
      filePath: "projects/cancelled.md",
      objectId: "object-cancelled",
    };
    const completed = new Set<string>();
    const attempts: string[] = [];
    const leasedPaths = new Set<string>();
    const store = {
      ensureMainVersion: async () => undefined,
      flushCapture: async () => undefined,
      reconcileCapture: async () => {
        attempts.push("reconcile");
        if (leasedPaths.size > 0) {
          throw new Error("collection-reconciliation-lease-held");
        }
      },
      listPendingCollectionAdoptions: async () => ({
        adoptions: completed.has(adoption.filePath) ? [] : [adoption],
        nextCursor: null,
      }),
    } as unknown as CaptureVersionedTextStore;
    const cancelled = new Error("cancelled while ydoc.evict was queued");
    const sessions = {
      run: async (_workspace: unknown, task: (binding: unknown) => unknown) =>
        await task({ client: {}, workspace: "workspace" }),
    } as unknown as EngineWorkspaceSessions;
    const errors: Array<{ context: string; error: unknown }> = [];
    let opens = 0;
    const engine = capture(root, {
      store,
      rustEngineSessions: sessions,
      onError: (context, error) => errors.push({ context, error }),
      openRustYDocProviderSession: async (options) => {
        opens += 1;
        leasedPaths.add(options.path);
        let evictions = 0;
        return {
          path: options.path,
          evict: async () => {
            evictions += 1;
            attempts.push(`${options.path}:${evictions}`);
            if (evictions === 1) throw cancelled;
            leasedPaths.delete(options.path);
            completed.add(options.path);
          },
        } as EngineYdocProviderSession;
      },
    });

    await engine.flush();

    expect(attempts).toEqual(["projects/cancelled.md:1"]);
    expect(errors).toEqual([
      {
        context: "collection adoption of projects/cancelled.md",
        error: cancelled,
      },
    ]);

    await engine.flush();

    expect(completed).toEqual(new Set(["projects/cancelled.md"]));
    expect(attempts).toEqual([
      "projects/cancelled.md:1",
      "projects/cancelled.md:2",
      "reconcile",
    ]);
    expect(opens).toBe(1);
    await engine.stop();
  });

  it("releases a retained busy collection adoption provider after the file is deleted", async () => {
    const root = await createTestScratch("dohc-engine-capture-");
    const adoption = {
      versionId: "main",
      recordId: "rec_aaaaaaaaaaaaaaaaaaaaaaaaaa",
      collectionPath: "projects",
      filePath: "projects/deleted.md",
      objectId: "object-deleted",
    };
    await write(root, adoption.filePath, "# Deleted\n");
    const store = {
      ensureMainVersion: async () => undefined,
      flushCapture: async () => undefined,
      reconcileCapture: async () => undefined,
      listPendingCollectionAdoptions: async () => ({
        adoptions: existsSync(join(root, adoption.filePath)) ? [adoption] : [],
        nextCursor: null,
      }),
    } as unknown as CaptureVersionedTextStore;
    const busy = new DaemonRefusalError(
      {
        code: "OVERLOADED",
        message: "engine-store-busy",
        retry: "afterBackoff",
      },
      undefined,
    );
    const sessions = {
      run: async (_workspace: unknown, task: (binding: unknown) => unknown) =>
        await task({ client: {}, workspace: "workspace" }),
    } as unknown as EngineWorkspaceSessions;
    let evictionAttempts = 0;
    const engine = capture(root, {
      store,
      rustEngineSessions: sessions,
      openRustYDocProviderSession: async (options) =>
        ({
          path: options.path,
          evict: async () => {
            evictionAttempts += 1;
            if (evictionAttempts === 1) throw busy;
          },
        }) as EngineYdocProviderSession,
    });

    await engine.flush();
    expect(evictionAttempts).toBe(1);

    await unlink(join(root, adoption.filePath));
    await engine.flush();
    const evictionAttemptsAfterDeletionPass = evictionAttempts;
    await engine.stop();

    expect(evictionAttemptsAfterDeletionPass).toBe(2);
  });

  it("releases a retained collection adoption when its provider path matches a renamed pending item", async () => {
    const root = await createTestScratch("dohc-engine-capture-");
    const originalAdoption = {
      versionId: "main",
      recordId: "rec_aaaaaaaaaaaaaaaaaaaaaaaaaa",
      collectionPath: "projects",
      filePath: "projects/original.md",
      objectId: "object-renamed",
    };
    const renamedAdoption = {
      ...originalAdoption,
      filePath: "projects/renamed.md",
    };
    let pendingAdoption = originalAdoption;
    const store = {
      ensureMainVersion: async () => undefined,
      flushCapture: async () => undefined,
      reconcileCapture: async () => undefined,
      listPendingCollectionAdoptions: async () => ({
        adoptions: [pendingAdoption],
        nextCursor: null,
      }),
    } as unknown as CaptureVersionedTextStore;
    const busy = new DaemonRefusalError(
      {
        code: "OVERLOADED",
        message: "engine-store-busy",
        retry: "afterBackoff",
      },
      undefined,
    );
    const sessions = {
      run: async (_workspace: unknown, task: (binding: unknown) => unknown) =>
        await task({ client: {}, workspace: "workspace" }),
    } as unknown as EngineWorkspaceSessions;
    let originalProviderPath = originalAdoption.filePath;
    let originalEvictionAttempts = 0;
    let renamedEvictionAttempts = 0;
    const engine = capture(root, {
      store,
      rustEngineSessions: sessions,
      openRustYDocProviderSession: async (options) => {
        if (options.path === originalAdoption.filePath) {
          return {
            get path() {
              return originalProviderPath;
            },
            evict: async () => {
              originalEvictionAttempts += 1;
              if (originalEvictionAttempts === 1) throw busy;
            },
          } as EngineYdocProviderSession;
        }
        return {
          path: options.path,
          evict: async () => {
            renamedEvictionAttempts += 1;
          },
        } as EngineYdocProviderSession;
      },
    });

    await engine.flush();
    expect(originalEvictionAttempts).toBe(1);

    pendingAdoption = renamedAdoption;
    originalProviderPath = renamedAdoption.filePath;
    await engine.flush();
    const originalEvictionsAfterRenamePass = originalEvictionAttempts;
    const renamedEvictionsAfterRenamePass = renamedEvictionAttempts;
    await engine.stop();

    expect(renamedEvictionsAfterRenamePass).toBe(1);
    expect(originalEvictionsAfterRenamePass).toBe(2);
  });

  it("releases the old collection adoption provider before reopening after a transport rebind", async () => {
    const root = await createTestScratch("dohc-engine-capture-");
    const adoption = {
      versionId: "main",
      recordId: "rec_aaaaaaaaaaaaaaaaaaaaaaaaaa",
      collectionPath: "projects",
      filePath: "projects/rebound.md",
      objectId: "object-rebound",
    };
    let completed = false;
    let reconciles = 0;
    const store = {
      ensureMainVersion: async () => undefined,
      flushCapture: async () => undefined,
      reconcileCapture: async () => {
        reconciles += 1;
      },
      listPendingCollectionAdoptions: async () => ({
        adoptions: completed ? [] : [adoption],
        nextCursor: null,
      }),
    } as unknown as CaptureVersionedTextStore;
    const firstClient = {};
    const replacementClient = {};
    const transportFailure = Object.assign(new Error("daemon transport replaced"), {
      code: "transport-error",
    });
    const sessions = {
      run: async (_workspace: unknown, task: (binding: unknown) => unknown) => {
        try {
          return await task({ client: firstClient, workspace: "first-workspace" });
        } catch (error) {
          if (error !== transportFailure) throw error;
          return await task({
            client: replacementClient,
            workspace: "replacement-workspace",
          });
        }
      },
    } as unknown as EngineWorkspaceSessions;
    const openedTransports: unknown[] = [];
    const evictedTransports: unknown[] = [];
    const activeTransports = new Set<unknown>();
    const activeProviderCountsAtOpen: number[] = [];
    let firstProviderEvictions = 0;
    const errors: Array<{ context: string; error: unknown }> = [];
    const engine = capture(root, {
      store,
      rustEngineSessions: sessions,
      onError: (context, error) => errors.push({ context, error }),
      openRustYDocProviderSession: async (options) => {
        activeProviderCountsAtOpen.push(activeTransports.size);
        if (activeTransports.size > 0) {
          throw new DaemonRefusalError(
            {
              code: "INVALID_PARAMS",
              message: "ydoc-session-busy",
              retry: "no",
            },
            undefined,
          );
        }
        openedTransports.push(options.transport);
        activeTransports.add(options.transport);
        return {
          path: options.path,
          evict: async () => {
            evictedTransports.push(options.transport);
            if (
              options.transport === firstClient &&
              firstProviderEvictions++ === 0
            ) {
              throw transportFailure;
            }
            activeTransports.delete(options.transport);
            completed = true;
          },
        } as EngineYdocProviderSession;
      },
    });

    await engine.flush();

    expect(completed).toBe(true);
    expect(openedTransports).toEqual([firstClient, replacementClient]);
    expect(evictedTransports).toEqual([
      firstClient,
      firstClient,
      replacementClient,
    ]);
    expect(activeProviderCountsAtOpen).toEqual([0, 0]);
    expect(activeTransports.size).toBe(0);
    expect(reconciles).toBe(1);
    expect(errors).toEqual([]);
    await engine.stop();
  });

  it("serializes overlapping collection adoption drains and preserves a busy provider", async () => {
    const root = await createTestScratch("dohc-engine-capture-");
    const adoption = {
      versionId: "main",
      recordId: "rec_aaaaaaaaaaaaaaaaaaaaaaaaaa",
      collectionPath: "projects",
      filePath: "projects/busy-overlap.md",
      objectId: "object-busy-overlap",
    };
    const firstListingEntered = deferred();
    const releaseListings = deferred();
    let activeListings = 0;
    let maxActiveListings = 0;
    let completed = false;
    const store = {
      ensureMainVersion: async () => undefined,
      flushCapture: async () => undefined,
      reconcileCapture: async () => undefined,
      listPendingCollectionAdoptions: async () => {
        activeListings += 1;
        maxActiveListings = Math.max(maxActiveListings, activeListings);
        firstListingEntered.resolve();
        await releaseListings.promise;
        activeListings -= 1;
        return {
          adoptions: completed ? [] : [adoption],
          nextCursor: null,
        };
      },
    } as unknown as CaptureVersionedTextStore;
    const busy = new DaemonRefusalError(
      {
        code: "OVERLOADED",
        message: "engine-store-busy",
        retry: "afterBackoff",
      },
      undefined,
    );
    const sessionBusy = new DaemonRefusalError(
      {
        code: "INVALID_PARAMS",
        message: "ydoc-session-busy",
        retry: "no",
      },
      undefined,
    );
    const sessions = {
      run: async (_workspace: unknown, task: (binding: unknown) => unknown) =>
        await task({ client: {}, workspace: "workspace" }),
    } as unknown as EngineWorkspaceSessions;
    let opens = 0;
    let evictionAttempts = 0;
    const errors: Array<{ context: string; error: unknown }> = [];
    const engine = capture(root, {
      store,
      rustEngineSessions: sessions,
      onError: (context, error) => errors.push({ context, error }),
      openRustYDocProviderSession: async (options) => {
        opens += 1;
        if (opens > 1) throw sessionBusy;
        return {
          path: options.path,
          evict: async () => {
            evictionAttempts += 1;
            if (evictionAttempts === 1) throw busy;
            completed = true;
          },
        } as EngineYdocProviderSession;
      },
    });

    const firstFlush = engine.flush();
    await firstListingEntered.promise;
    const overlappingFlush = engine.flush();
    await new Promise<void>((resolveTurn) => setImmediate(resolveTurn));
    releaseListings.resolve();
    await Promise.all([firstFlush, overlappingFlush]);

    await engine.flush();

    expect(maxActiveListings).toBe(1);
    expect(opens).toBe(1);
    expect(evictionAttempts).toBe(2);
    expect(completed).toBe(true);
    expect(errors).toEqual([]);
    await engine.stop();
  });

  it("flushes daemon capture before reading versions for a merge", async () => {
    const root = await createTestScratch("dohc-engine-capture-");
    const requests: Request[] = [];
    const engine = capture(root, {
      rustEngineSessions: mockLiveSessions(new VersionedLoopbackEngine(), requests),
    });

    const outcome = await engine
      .mergeVersionIntoMain("missing-version")
      .catch((error: unknown) => error);
    expect(outcome).toBeInstanceOf(Error);
    const relevant = requests
      .map((request) => request.method)
      .filter(
        (method) =>
          method === "capture.flush" || method === VERSIONED_METHOD.versionsList,
      );

    expect(relevant, "remove mergeVersionIntoMain's daemon flush. The versions read remains, making this order assertion fail on the missing first entry.").toEqual(["capture.flush", VERSIONED_METHOD.versionsList]);
    await engine.stop();
  });

  it("flushes daemon capture before reading conflicts for resolution", async () => {
    const root = await createTestScratch("dohc-engine-capture-");
    const requests: Request[] = [];
    const engine = capture(root, {
      rustEngineSessions: mockLiveSessions(new VersionedLoopbackEngine(), requests),
    });

    const outcome = await engine
      .resolveConflict("missing-conflict", { kind: "keep-current" })
      .catch((error: unknown) => error);
    expect(outcome).toBeInstanceOf(Error);
    const relevant = requests
      .map((request) => request.method)
      .filter(
        (method) => method === "capture.flush" || method === "conflicts.list",
      );

    expect(relevant, "remove resolveConflict's daemon flush. The conflict lookup remains, making this order assertion fail on the missing first entry.").toEqual(["capture.flush", "conflicts.list"]);
    await engine.stop();
  });

  it("flushes daemon capture before reading a moment for restore", async () => {
    const root = await createTestScratch("dohc-engine-capture-");
    const requests: Request[] = [];
    const engine = capture(root, {
      rustEngineSessions: mockLiveSessions(new VersionedLoopbackEngine(), requests),
    });

    const outcome = await engine
      .restoreFileToBeforeMoment("missing-moment")
      .catch((error: unknown) => error);
    expect(outcome).toBeInstanceOf(Error);
    const relevant = requests
      .map((request) => request.method)
      .filter(
        (method) =>
          method === "capture.flush" || method === VERSIONED_METHOD.momentsGet,
      );

    expect(relevant, "remove restoreFileToBeforeMoment's daemon flush. The moment read remains, making this order assertion fail on the missing first entry.").toEqual(["capture.flush", VERSIONED_METHOD.momentsGet]);
    await engine.stop();
  });

  it("removes a renamed accepted response and preserves replacements on retry",async()=>{
    const root=await createTestScratch("dohc-response-undo-");
    const requests:Request[]=[];
    const sessions=mockLiveSessions(new VersionedLoopbackEngine(),requests);
    const store=createCaptureLiveStores({workspaceId:WORKSPACE_ID,rootPath:root,attachmentId:WORKSPACE_ATTACHMENT_ID},sessions).store;
    await store.ensureMainVersion({workspaceId:WORKSPACE_ID});
    const created=await store.writeTextFile({workspaceId:WORKSPACE_ID,versionId:"main",path:"responses/accepted-a.md",text:"response",metadata:{origin:"api"}});
    const getMoment=store.getMoment.bind(store);
    vi.spyOn(store,"getMoment").mockImplementation(async input=>{
      const moment=await getMoment(input);
      return moment?.id===created.moment.id?{...moment,author:{kind:"public",principalId:"public-a",grantId:"grant"}}:moment;
    });
    await store.renameTextFile({workspaceId:WORKSPACE_ID,versionId:"main",fromPath:created.snapshot.path,toPath:"responses/moved.md",metadata:{origin:"api"}});
    await write(root,"responses/moved.md","response");
    const engine=capture(root,{store,rustEngineSessions:sessions});
    const selection={acceptanceId:"accepted-a",objectId:created.object.id,momentId:created.moment.id,path:created.snapshot.path,collectionPath:"responses",versionId:"main",publicPrincipalId:"public-a",grantId:"grant",requestId:"undo-a"};
    const result=await engine.undoAcceptedAppResponse(selection);
    expect(result.status).toBe("deleted");expect(result.momentId).toBeTruthy();
    expect(existsSync(join(root,"responses/moved.md"))).toBe(false);
    const deletion=requests.findLast(request=>request.method==="versionedText.delete");
    expect(deletion?.params).toMatchObject({path:"responses/moved.md",expectedObjectId:created.object.id,requestId:"undo-a"});
    await engine.stop();
    const reopened=capture(root,{store,rustEngineSessions:sessions});
    // Another object now occupies the deleted path; retries cannot touch it.
    await store.writeTextFile({workspaceId:WORKSPACE_ID,versionId:"main",path:"responses/moved.md",text:"replacement",metadata:{origin:"api"}});
    await write(root,"responses/moved.md","replacement");
    const retry=await reopened.undoAcceptedAppResponse(selection);
    expect(retry).toEqual({status:"deleted",momentId:result.momentId});
    expect(await readFile(join(root,"responses/moved.md"),"utf8")).toBe("replacement");
    expect(requests.filter(request=>request.method==="versionedText.delete")).toHaveLength(1);
    await reopened.stop();
  });

  it("pages long response history and recovers an interrupted deletion without deleting a restore",async()=>{
    const root=await createTestScratch("dohc-response-recovery-");
    const requests:Request[]=[];
    const sessions=mockLiveSessions(new VersionedLoopbackEngine(),requests);
    const store=createCaptureLiveStores({workspaceId:WORKSPACE_ID,rootPath:root,attachmentId:WORKSPACE_ATTACHMENT_ID},sessions).store;
    await store.ensureMainVersion({workspaceId:WORKSPACE_ID});
    const created=await store.writeTextFile({workspaceId:WORKSPACE_ID,versionId:"main",path:"responses/accepted-a.md",text:"response",metadata:{origin:"api"}});
    const getMoment=store.getMoment.bind(store);
    vi.spyOn(store,"getMoment").mockImplementation(async input=>{
      const moment=await getMoment(input);
      return moment?.id===created.moment.id?{...moment,author:{kind:"public",principalId:"public-a",grantId:"grant"}}:moment;
    });
    const selection={acceptanceId:"accepted-a",objectId:created.object.id,momentId:created.moment.id,path:created.snapshot.path,collectionPath:"responses",versionId:"main",publicPrincipalId:"public-a",grantId:"grant",requestId:"undo-a"};
    const engine=capture(root,{store,rustEngineSessions:sessions});
    for(let i=0;i<105;i++)await store.writeTextFile({workspaceId:WORKSPACE_ID,versionId:"main",path:created.snapshot.path,text:`response ${i}`,metadata:{origin:"api"}});
    await write(root,created.snapshot.path,"response 104");
    const deleted=await engine.undoAcceptedAppResponse(selection);
    expect(deleted.status).toBe("deleted");
    // Recreate the bytes left by a crash between native commit and materialization.
    await write(root,created.snapshot.path,"response 104");
    expect(await engine.undoAcceptedAppResponse(selection)).toEqual(deleted);
    expect(existsSync(join(root,created.snapshot.path))).toBe(false);
    await engine.restoreFileToBeforeMoment(deleted.momentId!);
    expect(requests.filter(request=>request.method==="versionedText.write").at(-1)?.params).toMatchObject({
      restoreBeforeMomentId: deleted.momentId,
      origin: "restore",
    });
    for(let i=0;i<105;i++)await store.writeTextFile({workspaceId:WORKSPACE_ID,versionId:"main",path:created.snapshot.path,text:`restored ${i}`,metadata:{origin:"api"}});
    await write(root,created.snapshot.path,"restored 104");
    expect(await engine.undoAcceptedAppResponse(selection)).toEqual(deleted);
    expect(await readFile(join(root,created.snapshot.path),"utf8")).toBe("restored 104");
    expect(requests.filter(request=>request.method==="versionedText.delete")).toHaveLength(1);
    await engine.stop();
  });

  it("reports stale disk bytes from a different response delete as a conflict",async()=>{
    const root=await createTestScratch("dohc-response-orphan-");
    const sessions=mockLiveSessions(new VersionedLoopbackEngine());
    const store=createCaptureLiveStores({workspaceId:WORKSPACE_ID,rootPath:root,attachmentId:WORKSPACE_ATTACHMENT_ID},sessions).store;
    await store.ensureMainVersion({workspaceId:WORKSPACE_ID});
    const created=await store.writeTextFile({workspaceId:WORKSPACE_ID,versionId:"main",path:"responses/accepted-a.md",text:"response",metadata:{origin:"api"}});
    const getMoment=store.getMoment.bind(store);
    vi.spyOn(store,"getMoment").mockImplementation(async input=>{
      const moment=await getMoment(input);
      return moment?.id===created.moment.id?{...moment,author:{kind:"public",principalId:"public-a",grantId:"grant"}}:moment;
    });
    await store.renameTextFile({workspaceId:WORKSPACE_ID,versionId:"main",fromPath:created.snapshot.path,toPath:"responses/moved.md",metadata:{origin:"api"}});
    await write(root,"responses/moved.md","response");
    await store.deleteTextFile({workspaceId:WORKSPACE_ID,versionId:"main",path:"responses/moved.md",metadata:{origin:"api"}});
    const engine=capture(root,{store,rustEngineSessions:sessions});
    const selection={acceptanceId:"accepted-a",objectId:created.object.id,momentId:created.moment.id,path:created.snapshot.path,collectionPath:"responses",versionId:"main",publicPrincipalId:"public-a",grantId:"grant",requestId:"undo-a"};
    expect(await engine.undoAcceptedAppResponse(selection)).toEqual({status:"conflict"});
    expect(await readFile(join(root,"responses/moved.md"),"utf8")).toBe("response");
    await rm(join(root,"responses/moved.md"));
    expect(await engine.undoAcceptedAppResponse(selection)).toEqual({status:"already-absent"});
    await engine.stop();
  });

  it("refuses response removal with forged public attribution or uncaptured disk edits",async()=>{
    const root=await createTestScratch("dohc-response-conflict-");
    const sessions=mockLiveSessions(new VersionedLoopbackEngine());
    const store=createCaptureLiveStores({workspaceId:WORKSPACE_ID,rootPath:root,attachmentId:WORKSPACE_ATTACHMENT_ID},sessions).store;
    await store.ensureMainVersion({workspaceId:WORKSPACE_ID});
    const created=await store.writeTextFile({workspaceId:WORKSPACE_ID,versionId:"main",path:"responses/accepted-a.md",text:"response",metadata:{origin:"api"}});
    await write(root,created.snapshot.path,"disk edit");
    const engine=capture(root,{store,rustEngineSessions:sessions});
    const selection={acceptanceId:"accepted-a",objectId:created.object.id,momentId:created.moment.id,path:created.snapshot.path,collectionPath:"responses",versionId:"main",publicPrincipalId:"public-a",grantId:"grant",requestId:"undo-a"};
    expect(await engine.undoAcceptedAppResponse(selection)).toEqual({status:"conflict"});
    const getMoment=store.getMoment.bind(store);
    vi.spyOn(store,"getMoment").mockImplementation(async input=>{
      const moment=await getMoment(input);
      return moment?.id===created.moment.id?{...moment,author:{kind:"public",principalId:"public-a",grantId:"grant"}}:moment;
    });
    expect(await engine.undoAcceptedAppResponse(selection)).toEqual({status:"conflict"});
    expect(await readFile(join(root,created.snapshot.path),"utf8")).toBe("disk edit");
    await engine.stop();
  });

  it.each(["present", "absent"])("explains a shared live file restore refusal with the artifact %s", async artifact => {
    const root = await createTestScratch("dohc-live-restore-refusal-");
    let deletionAttempts = 0;
    const sessions = mockLiveSessions(new VersionedLoopbackEngine(), undefined, undefined, request => {
      if (request.method === "versionedText.delete") {
        deletionAttempts += 1;
        throw new DaemonRefusalError(
          { code: "INVALID_PARAMS", message: "live-document-binding-active", retry: "no" },
          new Error("daemon response"),
        );
      }
    });
    const store = createCaptureLiveStores({ workspaceId: WORKSPACE_ID, rootPath: root, attachmentId: WORKSPACE_ATTACHMENT_ID }, sessions).store;
    await store.ensureMainVersion({ workspaceId: WORKSPACE_ID });
    const created = await store.writeTextFile({ workspaceId: WORKSPACE_ID, versionId: "main", path: "shared.md", text: "original", metadata: { origin: "api" } });
    if (artifact === "present") await write(root, "shared.md", "original");
    const engine = capture(root, { store, rustEngineSessions: sessions });
    await expect(engine.restoreFileToBeforeMoment(created.moment.id)).rejects.toThrow("dohc could not restore shared.md. This action is unavailable for shared live files.");
    expect(deletionAttempts).toBe(1);
    expect((await store.readTextFile({ workspaceId: WORKSPACE_ID, versionId: "main", path: "shared.md" }))?.text).toBe("original");
    if (artifact === "present") expect(await readFile(join(root, "shared.md"), "utf8")).toBe("original");
    else expect(existsSync(join(root, "shared.md"))).toBe(false);
    await engine.stop();
  });

  it.each(["binary source", "current binary artifact"])("explains a restore refusal from a %s", async route => {
    const root = await createTestScratch("dohc-live-binary-restore-refusal-");
    const binary = Uint8Array.of(0xff, 0x00, 0xfe);
    const refusal = new DaemonRefusalError(
      { code: "INVALID_PARAMS", message: "live-document-binding-active", retry: "no" },
      new Error("daemon response"),
    );
    let refuseBinaryWrites = false;
    let binaryAttempts = 0;
    const sessions = mockLiveSessions(new VersionedLoopbackEngine(), undefined, undefined, request => {
      if (refuseBinaryWrites && (request.method === VERSIONED_METHOD.binaryWrite || request.method === VERSIONED_METHOD.binaryWriteBlob)) {
        binaryAttempts += 1;
        throw refusal;
      }
    });
    const store = createCaptureLiveStores({ workspaceId: WORKSPACE_ID, rootPath: root, attachmentId: WORKSPACE_ATTACHMENT_ID }, sessions).store;
    const target = { workspaceId: WORKSPACE_ID, versionId: "main", path: "shared.md", metadata: { origin: "api" as const } };
    await store.ensureMainVersion({ workspaceId: WORKSPACE_ID });
    if (route === "binary source") await store.writeBinaryFile({ ...target, bytes: binary });
    else await store.writeTextFile({ ...target, text: "original" });
    const changed = await store.writeTextFile({ ...target, text: "current" });
    const disk = route === "binary source" ? Buffer.from("current") : Buffer.from(binary);
    await write(root, target.path, disk);
    refuseBinaryWrites = true;
    const engine = capture(root, { store, rustEngineSessions: sessions });
    await expect(engine.restoreFileToBeforeMoment(changed.moment.id)).rejects.toMatchObject({
      message: "dohc could not restore shared.md. This action is unavailable for shared live files. Continue editing at the current location.",
      cause: refusal,
    });
    expect(binaryAttempts).toBe(1);
    expect((await store.readTextFile(target))?.text).toBe("current");
    expect(await readFile(join(root, target.path))).toEqual(disk);
    await engine.stop();
  });

  it("closes both daemon stores when the final capture flush rejects", async () => {
    const root = await createTestScratch("dohc-engine-capture-");
    const loopback = new VersionedLoopbackEngine();
    let settled = true;
    const sessions = mockLiveSessions(loopback, undefined, () => ({
      settled,
      running: true,
      degraded: !settled,
    }));
    const closeWorkspace = vi.spyOn(sessions, "closeWorkspace");
    const engine = capture(root, {
      rustEngineSessions: sessions,
    });

    // createVersion opens both the text and secret daemon adapters.
    await engine.createVersion("Draft");
    settled = false;
    const outcome = await engine.stop().catch((error: unknown) => error);

    expect(outcome).toBeInstanceOf(Error);
    expect((outcome as Error).message).toContain("did not settle");
    expect(closeWorkspace, "await the final flush outside try/finally. Its rejection skips both adapter closes, so this count is zero.").toHaveBeenCalledTimes(2);
  });

  it("flushes daemon capture before closing production workspace stores", async () => {
    const root = await createTestScratch("dohc-engine-capture-");
    const requests: Request[] = [];
    const loopback = new VersionedLoopbackEngine();
    const engine = capture(root, {
      rustEngineSessions: mockLiveSessions(loopback, requests),
    });

    // createVersion opens both the text and secret daemon adapters.
    await engine.createVersion("Draft");
    requests.length = 0;
    await engine.stop();

    expect(
      requests
        .map((request) => request.method)
        .filter(
          (method) => method === "capture.flush" || method === "workspace.close",
        ),
    ).toEqual(["capture.flush", "workspace.close"]);
  });

  it("mutation proof: installs remote updates buffered during the initial Y.Doc open", async () => {
    const root = await createTestScratch("dohc-engine-capture-");
    const loopback = new VersionedLoopbackEngine();
    loopback.seedTextFile({
      workspace: "engine-capture-test",
      versionId: "main",
      path: "note.md",
      text: "seed",
    });
    const baseDoc = new Y.Doc();
    baseDoc.getText("content").insert(0, "base");
    const staleInitialUpdate = Y.encodeStateAsUpdate(baseDoc);
    const daemonDoc = new Y.Doc();
    Y.applyUpdate(daemonDoc, staleInitialUpdate);
    const remoteDoc = new Y.Doc();
    Y.applyUpdate(remoteDoc, staleInitialUpdate);
    remoteDoc.getText("content").insert(4, "+remote");
    const bufferedUpdate = Y.encodeStateAsUpdate(
      remoteDoc,
      Y.encodeStateVector(daemonDoc),
    );
    const forwarded: Uint8Array[] = [];
    const engine = capture(root, {
      rustEngineSessions: mockLiveSessions(loopback),
      openRustYDocProviderSession: async (options) => {
        Y.applyUpdate(daemonDoc, bufferedUpdate);
        options.onRemoteUpdate(bufferedUpdate);
        return {
          doc: daemonDoc,
          initialUpdate: staleInitialUpdate,
          contentKind: "plaintext",
          path: "note.md",
          head: "present" as const,
          lineage: "existing" as const,
          evict: async () => undefined,
          applyLocalUpdate: async () => undefined,
          settleNow: async () =>
            ({ sha256: "a".repeat(64), content: "" }) as never,
          close: async () => undefined,
        };
      },
    });

    const session = await engine.openYDocSession({
      path: "note.md",
      onRemoteUpdate: (update) => forwarded.push(update),
    });
    const rendererDoc = new Y.Doc();
    Y.applyUpdate(rendererDoc, session.initialUpdate);

    expect(rendererDoc.getText("content").toString()).toBe("base+remote");
    expect(forwarded).toEqual([bufferedUpdate]);
    await session.close({ settle: false });
    await engine.stop();
  });

  it("settles and retires every live Y.Doc session before stopping the capture", async () => {
    const root = await createTestScratch("dohc-engine-capture-");
    const loopback = new VersionedLoopbackEngine();
    loopback.seedTextFile({
      workspace: WORKSPACE_ID,
      versionId: "main",
      path: "note.md",
      text: "seed",
    });
    loopback.seedTextFile({
      workspace: WORKSPACE_ID,
      versionId: "main",
      path: "drawing.md",
      text: "seed",
    });
    const order: string[] = [];
    const engine = capture(root, {
      rustEngineSessions: mockLiveSessions(loopback),
      openRustYDocProviderSession: async (options) => {
        const doc = new Y.Doc();
        return {
          doc,
          initialUpdate: Y.encodeStateAsUpdate(doc),
          contentKind: "richdoc" as const,
          path: options.path,
          head: "present" as const,
          lineage: "existing" as const,
          evict: async () => undefined,
          applyLocalUpdate: async () => undefined,
          settleNow: async () => {
            order.push(`settle:${options.path}`);
            return { sha256: "a".repeat(64), content: "# Edited\n" } as never;
          },
          close: async (closeOptions?: { settle?: boolean }) => {
            order.push(`close:${options.path}:${String(closeOptions?.settle)}`);
          },
        };
      },
    });
    await engine.openYDocSession({
      path: "note.md",
      contentKind: "richdoc",
      onRemoteUpdate: () => undefined,
    });
    await engine.openYDocSession({
      path: "drawing.md",
      contentKind: "richdoc",
      onRemoteUpdate: () => undefined,
    });

    await engine.settleAndCloseAllLiveSessions!();
    await engine.stop();

    expect(order).toEqual([
      "settle:note.md",
      "close:note.md:false",
      "settle:drawing.md",
      "close:drawing.md:false",
    ]);
  });

  // The engine owns the.md: it materializes a changed projection and
  // leaves a drifted file alone. The desktop mirrored the settled content
  // over the file anyway, so an edit made outside dohc while the document was
  // open vanished from disk. The desktop no longer writes here at all, and
  // every case below drives the real onSettled against a real file; only the
  // daemon session is a fake, and it calls onSettled exactly where
  // ydocProviderSession's runSettle does.
  function driftFixture(settled: {
    sha256: string;
    content: string | null;
    path?: string;
  }) {
    return async (options: EngineYdocProviderSessionOptions) => {
      const doc = new Y.Doc();
      return {
        doc,
        initialUpdate: Y.encodeStateAsUpdate(doc),
        contentKind: "plaintext",
        path: settled.path ?? "note.md",
        // Stated by hand: `as never` below stops tsc checking this literal, and
        // an absent `head` would silently disable the absent-head refusal for
        // every drift case here.
        head: "present" as const,
        lineage: "existing" as const,
        evict: async () => undefined,
        applyLocalUpdate: async () => undefined,
        settleNow: async () => {
          await options.onSettled?.({ ...settled, materialized: true } as never, 1);
          return settled as never;
        },
        close: async (closeOptions?: { settle?: boolean }) => {
          if (closeOptions?.settle === false) return;
          await options.onSettled?.({ ...settled, materialized: true } as never, 2);
        },
      } as never;
    };
  }

  // Open a session on note.md, let its close settle, and report the save
  // states that settle produced.
  async function settleOnClose(
    root: string,
    settled: { sha256: string; content: string | null },
    onError?: (context: string, error: unknown) => void,
  ): Promise<string[]> {
    const states: string[] = [];
    const engine = capture(root, {
      ...(onError ? { onError } : {}),
      openRustYDocProviderSession: driftFixture(settled),
    });
    const session = await engine.openYDocSession({
      path: "note.md",
      onRemoteUpdate: () => undefined,
      onSaveState: (state) => states.push(state),
    });
    await session.close();
    await engine.stop();
    return states;
  }

  const EDITOR_TEXT = "typed in dohc\n";

  it("keeps an edit made outside dohc when the open document's session closes", async () => {
    const root = await createTestScratch("dohc-engine-capture-");
    const outside = "written outside dohc\n";
    await write(root, "note.md", outside);

    const states = await settleOnClose(root, {
      sha256: sha256Utf8(EDITOR_TEXT),
      content: EDITOR_TEXT,
    });

    expect(await readFile(join(root, "note.md"), "utf8"), "restore the mirror write and the file reads 'typed in dohc' — the outside edit is gone from disk.").toBe(outside);
    expect(states).toEqual(["changed-on-disk"]);
  });

  // The size the old check gave up at: readDiskTextState returns
  // untracked-content with NO sha past its 5 MiB cap, so a check that trusted
  // it read "no proof of drift" and mirrored 14 bytes over the biggest file in
  // the workspace — reporting "Saved".
  it("keeps an outside edit larger than the capture size cap", async () => {
    const root = await createTestScratch("dohc-engine-capture-");
    const huge = `${"o".repeat(MAX_ENGINE_CAPTURE_BINARY_BYTES + 1)}\n`;
    await write(root, "note.md", huge);

    const states = await settleOnClose(root, {
      sha256: sha256Utf8(EDITOR_TEXT),
      content: EDITOR_TEXT,
    });

    expect((await readFile(join(root, "note.md"), "utf8")).length).toBe(
      huge.length,
    );
    expect(states).toEqual(["changed-on-disk"]);
  });

  // An outside DELETE is an intent, not an accident. Writing the document back
  // is the same overwrite in reverse.
  it("does not recreate a file deleted outside dohc", async () => {
    const root = await createTestScratch("dohc-engine-capture-");

    const states = await settleOnClose(root, {
      sha256: sha256Utf8(EDITOR_TEXT),
      content: EDITOR_TEXT,
    });

    expect(existsSync(join(root, "note.md"))).toBe(false);
    expect(states).toEqual(["changed-on-disk"]);
  });

  // content === null: the body is past the engine's in-band response cap, so
  // it never rode back over the wire. The settle still reports its sha, so
  // drift is just as answerable there — the old code returned "Saved" without
  // looking.
  it("reports the drift for an over-cap settle whose content never crossed the wire", async () => {
    const root = await createTestScratch("dohc-engine-capture-");
    const outside = "written outside dohc\n";
    await write(root, "note.md", outside);

    const states = await settleOnClose(root, {
      sha256: sha256Utf8("a body far past the in-band cap"),
      content: null,
    });

    expect(await readFile(join(root, "note.md"), "utf8")).toBe(outside);
    expect(states).toEqual(["changed-on-disk"]);
  });

  // A file bigger than the largest projection the engine can produce cannot BE
  // the settled artifact, so its size answers the question and its bytes are
  // never read — a close must not wait on an unbounded read. The deny-read ACE
  // is the proof: reading would fail (EPERM), which would report "error"
  // instead.
  itNonRoot("answers an oversized file from its size, without reading it", async () => {
    const root = await createTestScratch("dohc-engine-capture-");
    const absolute = join(root, "note.md");
    await write(root, "note.md", "b".repeat(MAX_SETTLED_FILE_BYTES + 1));
    await denyRead(absolute, "file");

    try {
      const states = await settleOnClose(root, {
        sha256: sha256Utf8(EDITOR_TEXT),
        content: EDITOR_TEXT,
      });

      expect(states).toEqual(["changed-on-disk"]);
    } finally {
      await restoreRead(absolute, 0o644);
    }
  });

  // A file dohc cannot read is not a file dohc knows changed. Sending the user
  // to History over a scanner's transient lock would be a lie about a file
  // that probably holds exactly this document; "error" is the retryable state,
  // and the next settle checks again.
  itNonRoot("reports the retryable error state when the file cannot be read", async () => {
    const root = await createTestScratch("dohc-engine-capture-");
    const absolute = join(root, "note.md");
    await write(root, "note.md", EDITOR_TEXT);
    await denyRead(absolute, "file");
    const errors: Array<{ context: string; error: unknown }> = [];

    try {
      const states = await settleOnClose(
        root,
        { sha256: sha256Utf8(EDITOR_TEXT), content: EDITOR_TEXT },
        (context, error) => errors.push({ context, error }),
      );

      expect(states).toEqual(["error"]);
      expect(String(errors[0]?.error)).toContain("could not check the file");
    } finally {
      await restoreRead(absolute, 0o644);
    }
  });

  // Containment, the same invariant the disk writer holds: a parent directory
  // replaced by a link out of the workspace must not be read through. A file
  // out there whose bytes matched would otherwise report a save — and arm a
  // self-write suppression — for an artifact that is not in the workspace.
  it("refuses to read the settled file through a folder that leaves the workspace", async () => {
    const root = await createTestScratch("dohc-engine-capture-");
    const outside = await createTestScratch("dohc-engine-capture-");
    await write(outside, "note.md", EDITOR_TEXT);
    let linked = true;
    try {
      // A junction needs no privilege on Windows; symlink elsewhere.
      await symlink(
        join(outside),
        join(root, "notes"),
        process.platform === "win32" ? "junction" : "dir",
      );
    } catch {
      linked = false;
    }
    if (!linked) return;

    const states: string[] = [];
    const errors: Array<{ context: string; error: unknown }> = [];
    const engine = capture(root, {
      onError: (context, error) => errors.push({ context, error }),
      openRustYDocProviderSession: driftFixture({
        sha256: sha256Utf8(EDITOR_TEXT),
        content: EDITOR_TEXT,
        path: "notes/note.md",
      }),
    });
    const session = await engine.openYDocSession({
      path: "notes/note.md",
      onRemoteUpdate: () => undefined,
      onSaveState: (state) => states.push(state),
    });
    await session.close();
    await engine.stop();

    expect(states, "drop the containment check and the matching file outside the workspace reports ['saved'].").toEqual(["error"]);
    expect(String(errors[0]?.error)).toContain("outside the workspace");
  });

  // The narrowness guard: the refusal above must fire only on a drifted file.
  it("still reports a plain saved settle when nothing changed the file", async () => {
    const root = await createTestScratch("dohc-engine-capture-");
    await write(root, "note.md", EDITOR_TEXT);

    const states = await settleOnClose(root, {
      sha256: sha256Utf8(EDITOR_TEXT),
      content: EDITOR_TEXT,
    });

    expect(await readFile(join(root, "note.md"), "utf8")).toBe(EDITOR_TEXT);
    expect(states).toEqual(["saved"]);
  });

  it("mutation proof: polls daemon watcher degradation after startup", async () => {
    vi.useFakeTimers();
    try {
      const root = await createTestScratch("dohc-engine-capture-");
      let degraded = false;
      const outcomes: boolean[] = [];
      const sessions = mockLiveSessions(new VersionedLoopbackEngine());
      const liveStore = createCaptureLiveStores(
        {
          workspaceId: WORKSPACE_ID,
          rootPath: root,
          attachmentId: WORKSPACE_ATTACHMENT_ID,
        },
        sessions,
      ).store;
      const daemonStore = new Proxy(liveStore, {
        get(target, property) {
          if (property === "watcherStatus") {
            return async () => ({
              running: true,
              degraded,
              terminal: false,
            });
          }
          if (property === "flushCapture") return async () => undefined;
          const value = Reflect.get(target, property, target);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
      const engine = capture(root, {
        store: daemonStore,
        rustEngineSessions: sessions,
          onCaptureOutcome: (failure) => outcomes.push(failure === null),
      });
      try {
        engine.start();
        await engine.flush();
        degraded = true;
        await vi.advanceTimersByTimeAsync(DAEMON_CAPTURE_HEALTH_POLL_MS);
        await engine.flush();

        expect(outcomes).toEqual([true, false]);
      } finally {
        try {
          await engine.stop();
        } finally {
          await liveStore.close();
        }
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([false, true])("coalesces blocked capture health polls and resumes after failure=%s", async (failFirst) => {
    vi.useFakeTimers();
    const root = await createTestScratch("dohc-engine-capture-");
    const entered = deferred();
    const release = deferred();
    const sessions = mockLiveSessions(new VersionedLoopbackEngine());
    const liveStore = createCaptureLiveStores({
      workspaceId: WORKSPACE_ID, rootPath: root, attachmentId: WORKSPACE_ATTACHMENT_ID,
    }, sessions).store;
    const watcherStatus = vi.fn(async () => {
      if (watcherStatus.mock.calls.length === 1) {
        entered.resolve();
        await release.promise;
        if (failFirst) throw new Error("temporary watcher failure");
      }
      return { running: true, degraded: false, terminal: false };
    });
    const adoptions = vi.fn(async () => ({ adoptions: [], nextCursor: null }));
    const outcomes: WorkspaceEngineCaptureFailure[] = [];
    const daemonStore = new Proxy(liveStore, {
      get(target, property) {
        if (property === "watcherStatus") return watcherStatus;
        if (property === "listPendingCollectionAdoptions") return adoptions;
        if (property === "flushCapture") return async () => undefined;
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const engine = capture(root, {
      store: daemonStore, rustEngineSessions: sessions,
      onError: () => {}, onCaptureOutcome: (outcome) => outcomes.push(outcome),
    });
    try {
      engine.start();
      await entered.promise;
      await vi.advanceTimersByTimeAsync(12 * DAEMON_CAPTURE_HEALTH_POLL_MS);
      expect(watcherStatus).toHaveBeenCalledTimes(1);
      release.resolve();
      await engine.flush();
      // One current observation, not twelve obsolete observations queued behind it.
      expect(watcherStatus).toHaveBeenCalledTimes(1);
      expect(adoptions).toHaveBeenCalledTimes(failFirst ? 1 : 2);
      expect(outcomes).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(DAEMON_CAPTURE_HEALTH_POLL_MS);
      await engine.flush();
      expect(watcherStatus).toHaveBeenCalledTimes(2);
      expect(outcomes.at(-1)).toBeNull();
      await engine.stop();
      await vi.advanceTimersByTimeAsync(2 * DAEMON_CAPTURE_HEALTH_POLL_MS);
      expect(watcherStatus).toHaveBeenCalledTimes(2);
    } finally {
      release.resolve();
      await engine.stop();
      await liveStore.close();
      vi.useRealTimers();
    }
  });

  // The engine refusing the workspace's database is not a degraded
  // watcher. The outcome carries the fence's classification so the product
  // offers the move-aside rebuild instead of "History paused" — and a later
  // pass that reaches the store clears it.
  it("carries the store refusal on the health outcome and clears it on recovery", async () => {
    vi.useFakeTimers();
    try {
      const root = await createTestScratch("dohc-engine-capture-");
      let refuse = true;
      const outcomes: WorkspaceEngineCaptureFailure[] = [];
      const sessions = mockLiveSessions(new VersionedLoopbackEngine());
      const liveStore = createCaptureLiveStores(
        {
          workspaceId: WORKSPACE_ID,
          rootPath: root,
          attachmentId: WORKSPACE_ATTACHMENT_ID,
        },
        sessions,
      ).store;
      const daemonStore = new Proxy(liveStore, {
        get(target, property) {
          if (property === "watcherStatus") {
            return async () => {
              if (refuse) {
                // The wire shape a refused workspace.open reaches the desktop
                // in: an INTERNAL error whose message is the storage code.
                throw Object.assign(new Error("foreign-database"), {
                  wireError: {
                    code: "INTERNAL",
                    message: "foreign-database",
                    retry: "no",
                  },
                });
              }
              return { running: true, degraded: false, terminal: false };
            };
          }
          if (property === "flushCapture") return async () => undefined;
          const value = Reflect.get(target, property, target);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
      const engine = capture(root, {
        store: daemonStore,
        rustEngineSessions: sessions,
          onError: () => {},
        onCaptureOutcome: (outcome) => outcomes.push(outcome),
      });
      try {
        engine.start();
        await engine.flush();
        expect(outcomes).toEqual(["foreign-database"]);

        refuse = false;
        await vi.advanceTimersByTimeAsync(DAEMON_CAPTURE_HEALTH_POLL_MS);
        await engine.flush();
        expect(outcomes).toEqual(["foreign-database", null]);
      } finally {
        try {
          await engine.stop();
        } finally {
          await liveStore.close();
        }
      }
    } finally {
      vi.useRealTimers();
    }
  });

  // The move-aside rebuild closes the capture before it moves the store. A
  // refused store was never opened, so the closing flush can only repeat
  // the refusal; the stop must finish anyway or the rebuild never starts.
  it("stops a capture whose store is refused without failing on the closing flush", async () => {
    vi.useFakeTimers();
    try {
      const root = await createTestScratch("dohc-engine-capture-");
      // The engine names the cause after the code.
      const message = "migration-failed: migration v2-baseline was applied from a different definition than this build's";
      const refusal = () =>
        Object.assign(new Error(message), {
          wireError: { code: "INTERNAL", message, retry: "no" },
        });
      const outcomes: WorkspaceEngineCaptureFailure[] = [];
      const details: Array<string | null> = [];
      const sessions = mockLiveSessions(new VersionedLoopbackEngine());
      const liveStore = createCaptureLiveStores(
        { workspaceId: WORKSPACE_ID, rootPath: root, attachmentId: WORKSPACE_ATTACHMENT_ID },
        sessions,
      ).store;
      const daemonStore = new Proxy(liveStore, {
        get(target, property) {
          if (property === "watcherStatus" || property === "flushCapture") {
            return async () => {
              throw refusal();
            };
          }
          const value = Reflect.get(target, property, target);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
      const engine = capture(root, {
        store: daemonStore,
        rustEngineSessions: sessions,
        onError: () => {},
        onCaptureOutcome: (outcome, detail) => {
          outcomes.push(outcome);
          details.push(detail ?? null);
        },
      });
      try {
        engine.start();
        // flush() ends with the same refused flushCapture; the pass before it
        // already reported the refusal.
        await engine.flush().catch(() => undefined);
        expect(outcomes).toEqual(["migration-failed"]);
        expect(details).toEqual(["migration v2-baseline was applied from a different definition than this build's"]);
        await expect(engine.stop()).resolves.toBeUndefined();
      } finally {
        await liveStore.close();
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it("mutation proof: counts a secret-only daemon version switch", async () => {
    const root = await createTestScratch("dohc-engine-capture-");
    const loopback = new VersionedLoopbackEngine();
    loopback.seedSecretFile({
      workspace: "engine-capture-test",
      versionId: "main",
      path: ".env",
      text: "VALUE=main\n",
    });
    await write(root, ".env", "VALUE=main\n");
    const engine = capture(root, {
      rustEngineSessions: mockLiveSessions(loopback),
    });
    const created = await engine.createVersion("Draft");
    const draftId = created.activeVersionId;
    loopback.seedSecretFile({
      workspace: "engine-capture-test",
      versionId: draftId,
      path: ".env",
      text: "VALUE=draft\n",
    });
    await write(root, ".env", "VALUE=draft\n");

    await expect(engine.switchVersion("main")).resolves.toEqual({
      activeVersionId: "main",
      changedFileCount: 1,
    });
    await engine.stop();
  });

  it("validates an unknown switch target from metadata without attempting text hydration", async () => {
    const root = await createTestScratch("dohc-engine-capture-");
    const loopback = new VersionedLoopbackEngine();
    const engine = capture(root, {
      rustEngineSessions: mockLiveSessions(loopback),
    });
    loopback.requests.length = 0;

    await expect(engine.switchVersion("missing-version")).rejects.toThrow();
    expect(
      loopback.requests.filter(
        (request) => request.method === "versionedText.read",
      ),
    ).toHaveLength(0);
    await engine.stop();
  });

});

describe("workspaceEngineCapture relay sync materialization", () => {
  async function deliverRelayPage<T extends {
    fastForwardedPaths: readonly RelayMaterializedPath[];
  }>(
    materializePage: MaterializeRelayPullPage,
    result: T,
    commit: () => Promise<void> = async () => undefined,
  ): Promise<T> {
    await materializePage(result.fastForwardedPaths);
    await commit();
    return result;
  }

  async function protectedVersionFixture(mainText: string) {
    const root = await createTestScratch("dohc-engine-capture-");
    const loopback = new VersionedLoopbackEngine();
    loopback.seedSecretFile({
      workspace: WORKSPACE_ID,
      versionId: "main",
      path: ".env",
      text: mainText,
      origin: "sync",
    });
    await write(root, ".env", mainText);
    const engine = liveCapture(root, loopback);
    const draftId = (await engine.createVersion("Draft")).activeVersionId;
    loopback.seedSecretFile({
      workspace: WORKSPACE_ID,
      versionId: draftId,
      path: ".env",
      text: "VALUE=draft engine\n",
      origin: "local-file",
    });
    await engine.switchVersion("main");
    return { root, loopback, engine, draftId };
  }

  it("initializes the main version before the first relay task", async () => {
    const root = await createTestScratch("dohc-engine-capture-");
    const requests: Request[] = [];
    const engine = liveCapture(root, new VersionedLoopbackEngine(), {
      requests,
    });

    let initializedWhenTaskRan = false;
    await engine.runRelaySync(async (materializePage) => {
      initializedWhenTaskRan = requests.some(
        (request) => request.method === VERSIONED_METHOD.versionsEnsureMain,
      );
      return await deliverRelayPage(materializePage, {
        fastForwardedPaths: [],
      });
    });

    expect(initializedWhenTaskRan).toBe(true);
    await engine.stop();
  });

  it("settles daemon capture after relay materialization before committing the cursor", async () => {
    const root = await createTestScratch("dohc-engine-capture-");
    const loopback = new VersionedLoopbackEngine();
    const requests: Request[] = [];
    let settled = true;
    const engine = capture(root, {
      rustEngineSessions: mockLiveSessions(loopback, requests, () => ({
        settled,
        running: true,
        degraded: !settled,
      })),
    });
    loopback.seedTextFile({
      workspace: WORKSPACE_ID,
      versionId: "main",
      path: "notes/remote.md",
      text: "remote machine wrote this\n",
      origin: "sync",
    });
    let flushedWhenCommitted = false;

    await engine.runRelaySync(async (materializePage) =>
      await deliverRelayPage(
        materializePage,
        {
          fastForwardedPaths: [
            {
              versionId: "main",
              path: "notes/remote.md",
              operation: "write" as const,
              contentKind: "text" as const,
            },
          ],
        },
        async () => {
        flushedWhenCommitted = requests.some(
          (request) => request.method === "capture.reconcile",
        );
        },
      ),
    );

    expect(flushedWhenCommitted).toBe(true);

    settled = false;
    loopback.seedTextFile({
      workspace: WORKSPACE_ID,
      versionId: "main",
      path: "notes/remote.md",
      text: "new remote text\n",
      origin: "sync",
    });
    const commitWhileUnsettled = vi.fn(async () => {});
    await expect(
      engine.runRelaySync(async (materializePage) =>
        await deliverRelayPage(
          materializePage,
          {
            fastForwardedPaths: [
              {
                versionId: "main",
                path: "notes/remote.md",
                operation: "write" as const,
                contentKind: "text" as const,
              },
            ],
          },
          commitWhileUnsettled,
        ),
      ),
    ).rejects.toThrow("did not settle");
    expect(commitWhileUnsettled).not.toHaveBeenCalled();

    settled = true;
    await engine.stop();
  });

  it("materializes pull-fast-forwarded text to disk", async () => {
    const root = await createTestScratch("dohc-engine-capture-");
    const loopback = new VersionedLoopbackEngine();
    const engine = liveCapture(root, loopback);
    // Simulate the post-pull state: the engine holds remote content the folder
    // does not have yet (pull applies ops to the engine; runRelaySync owns
    // getting them onto disk).
    loopback.seedTextFile({
      workspace: WORKSPACE_ID,
      versionId: "main",
      path: "notes/remote.md",
      text: "remote machine wrote this\n",
      origin: "sync",
    });

    const result = await engine.runRelaySync(async (materializePage) =>
      await deliverRelayPage(materializePage, {
        fastForwardedPaths: [
          {
            versionId: "main",
            path: "notes/remote.md",
            operation: "write" as const,
            contentKind: "text" as const,
          },
        ],
      }),
    );
    expect(result.fastForwardedPaths).toHaveLength(1);
    expect(await readFile(join(root, "notes/remote.md"), "utf8")).toBe(
      "remote machine wrote this\n",
    );
    await engine.stop();
  });

  it("materializes a pull-fast-forwarded binary path from authoritative bytes", async () => {
    const root = await createTestScratch("dohc-engine-capture-");
    const loopback = new VersionedLoopbackEngine();
    const engine = liveCapture(root, loopback);
    const bytes = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
    loopback.seedBinaryFile({
      workspace: WORKSPACE_ID,
      versionId: "main",
      path: "assets/excalidraw/abc/asset.png",
      bytes,
      origin: "sync",
    });

    await engine.runRelaySync(async (materializePage) =>
      await deliverRelayPage(materializePage, {
        fastForwardedPaths: [
          {
            versionId: "main",
            path: "assets/excalidraw/abc/asset.png",
            operation: "write" as const,
            contentKind: "binary" as const,
          },
        ],
      }),
    );

    expect(await readFile(join(root, "assets/excalidraw/abc/asset.png"))).toEqual(
      Buffer.from(bytes),
    );
    await engine.stop();
  });

  it("materializes a remote delete and reports no disk work when nothing fast-forwarded", async () => {
    const root = await createTestScratch("dohc-engine-capture-");
    const loopback = new VersionedLoopbackEngine();
    const engine = liveCapture(root, loopback);
    await write(root, "doomed.md", "here today\n");
    loopback.seedTextFile({
      workspace: WORKSPACE_ID,
      versionId: "main",
      path: "doomed.md",
      text: "here today\n",
    });

    // Remote deleted the file; pull already applied the delete to the engine.
    await loopback.sendRequest({
      id: -2,
      method: VERSIONED_METHOD.textDelete,
      workspace: WORKSPACE_ID,
      params: {
        workspaceId: WORKSPACE_ID,
        versionId: "main",
        path: "doomed.md",
        origin: "sync",
        summary: "remote delete",
      },
    });
    const momentsBefore = (await liveMoments(engine)).length;

    await engine.runRelaySync(async (materializePage) =>
      await deliverRelayPage(materializePage, {
        fastForwardedPaths: [
          {
            versionId: "main",
            path: "doomed.md",
            operation: "delete" as const,
            contentKind: "text" as const,
          },
        ],
      }),
    );
    expect(existsSync(join(root, "doomed.md"))).toBe(false);

    // A quiescent pass (no fast-forwarded paths) touches nothing.
    await engine.runRelaySync(async (materializePage) =>
      await deliverRelayPage(materializePage, { fastForwardedPaths: [] }),
    );
    await engine.flush();
    expect(await liveMoments(engine)).toHaveLength(momentsBefore);
    await engine.stop();
  });

  it("materializes protected writes and deletes before committing the relay cursor", async () => {
    const root = await createTestScratch("dohc-engine-capture-");
    const loopback = new VersionedLoopbackEngine();
    const engine = liveCapture(root, loopback);
    loopback.seedSecretFile({
      workspace: WORKSPACE_ID,
      versionId: "main",
      path: ".env",
      text: "ACCESS_TOKEN=protected\r\n",
      origin: "sync",
    });
    const commitOrder: string[] = [];

    await engine.runRelaySync(async (materializePage) =>
      await deliverRelayPage(
        materializePage,
        {
          fastForwardedPaths: [
            {
              versionId: "main",
              path: ".env",
              operation: "write" as const,
              contentKind: "secret" as const,
            },
          ],
        },
        async () => {
        expect(await readFile(join(root, ".env"), "utf8")).toBe(
          "ACCESS_TOKEN=protected\r\n",
        );
        commitOrder.push("write");
        },
      ),
    );

    await loopback.sendRequest({
      id: -3,
      method: VERSIONED_METHOD.secretsDelete,
      workspace: WORKSPACE_ID,
      params: {
        workspaceId: WORKSPACE_ID,
        versionId: "main",
        path: ".env",
        origin: "sync",
        momentId: "remote-secret-delete",
      },
    });
    await engine.runRelaySync(async (materializePage) =>
      await deliverRelayPage(
        materializePage,
        {
          fastForwardedPaths: [
            {
              versionId: "main",
              path: ".env",
              operation: "delete" as const,
              contentKind: "secret" as const,
            },
          ],
        },
        async () => {
        expect(existsSync(join(root, ".env"))).toBe(false);
        commitOrder.push("delete");
        },
      ),
    );

    expect(commitOrder).toEqual(["write", "delete"]);
    await engine.stop();
  });

  it("does not replay a protected write into a version entered after materialization failed", async () => {
    const { root, engine, draftId } = await protectedVersionFixture(
      "VALUE=main remote\n",
    );

    await rm(join(root, ".env"), { force: true });
    await mkdir(join(root, ".env"));
    const commit = vi.fn(async () => {});
    const replay = () => ({
      fastForwardedPaths: [
        {
          versionId: "main",
          path: ".env",
          operation: "write" as const,
          contentKind: "secret" as const,
        },
      ],
    });
    await expect(
      engine.runRelaySync(async (materializePage) =>
        await deliverRelayPage(materializePage, replay(), commit),
      ),
    ).rejects.toThrow(/Could not update \.env/u);
    expect(commit).not.toHaveBeenCalled();

    await rm(join(root, ".env"), { recursive: true, force: true });
    await write(root, ".env", "VALUE=main remote\n");
    await engine.switchVersion(draftId);
    await write(root, ".env", "VALUE=draft local drift\n");
    await engine.runRelaySync(async (materializePage) =>
      await deliverRelayPage(materializePage, replay(), commit),
    );

    expect(await readFile(join(root, ".env"), "utf8")).toBe(
      "VALUE=draft local drift\n",
    );
    expect(commit).toHaveBeenCalledTimes(1);
    await engine.stop();
  });

  it("does not replay a protected delete into a version entered after materialization failed", async () => {
    const { root, loopback, engine, draftId } = await protectedVersionFixture(
      "VALUE=main\n",
    );
    await loopback.sendRequest({
      id: -4,
      method: VERSIONED_METHOD.secretsDelete,
      workspace: WORKSPACE_ID,
      params: {
        workspaceId: WORKSPACE_ID,
        versionId: "main",
        path: ".env",
        origin: "sync",
        momentId: "remote-secret-delete-before-version-switch",
      },
    });

    await rm(join(root, ".env"), { force: true });
    await mkdir(join(root, ".env"));
    const commit = vi.fn(async () => {});
    const replay = () => ({
      fastForwardedPaths: [
        {
          versionId: "main",
          path: ".env",
          operation: "delete" as const,
          contentKind: "secret" as const,
        },
      ],
    });
    await expect(
      engine.runRelaySync(async (materializePage) =>
        await deliverRelayPage(materializePage, replay(), commit),
      ),
    ).rejects.toThrow(/Could not update \.env/u);
    expect(commit).not.toHaveBeenCalled();

    await rm(join(root, ".env"), { recursive: true, force: true });
    await engine.switchVersion(draftId);
    await write(root, ".env", "VALUE=draft local drift\n");
    await engine.runRelaySync(async (materializePage) =>
      await deliverRelayPage(materializePage, replay(), commit),
    );

    expect(await readFile(join(root, ".env"), "utf8")).toBe(
      "VALUE=draft local drift\n",
    );
    expect(commit).toHaveBeenCalledTimes(1);
    await engine.stop();
  });

  // Data-safety gate finding: the relay fetch cursor must only commit after
  // the pulled state is safely on disk. A failed materialization leaves the
  // cursor un-advanced so the next pass retries the same ops.
  it("commits the relay fetch cursor only after disk materialization succeeds", async () => {
    const root = await createTestScratch("dohc-engine-capture-");
    const loopback = new VersionedLoopbackEngine();
    const engine = liveCapture(root, loopback);
    loopback.seedTextFile({
      workspace: WORKSPACE_ID,
      versionId: "main",
      path: "notes/remote.md",
      text: "remote machine wrote this\n",
      origin: "sync",
    });

    // Block materialization: a directory squats on the file path.
    await mkdir(join(root, "notes/remote.md"), { recursive: true });
    const commit = vi.fn(async () => {});
    const pullResult = () => ({
      fastForwardedPaths: [
        {
          versionId: "main",
          path: "notes/remote.md",
          operation: "write" as const,
          contentKind: "text" as const,
        },
      ],
    });
    await expect(
      engine.runRelaySync(async (materializePage) =>
        await deliverRelayPage(materializePage, pullResult(), commit),
      ),
    ).rejects.toThrow(/Could not update notes\/remote\.md/u);
    expect(commit).not.toHaveBeenCalled();

    // Unblock the path: the retry pass materializes and THEN commits.
    await rm(join(root, "notes/remote.md"), { recursive: true, force: true });
    await engine.runRelaySync(async (materializePage) =>
      await deliverRelayPage(materializePage, pullResult(), commit),
    );
    expect(commit).toHaveBeenCalledTimes(1);
    expect(await readFile(join(root, "notes/remote.md"), "utf8")).toBe(
      "remote machine wrote this\n",
    );

    // A quiescent pass (chat-only or own-origin ops) still commits: cursor
    // progress must not depend on file materialization work existing.
    const quiescentCommit = vi.fn(async () => {});
    await engine.runRelaySync(async (materializePage) =>
      await deliverRelayPage(
        materializePage,
        { fastForwardedPaths: [] },
        quiescentCommit,
      ),
    );
    await engine.stop();
    expect(quiescentCommit).toHaveBeenCalledTimes(1);
  });
});

describe("assertGeneratedMarkdownPath host-unsafe rejection (materialize boundary)", () => {
  it("throws a typed unsupported-name error only when the host is Windows", () => {
    // Windows-illegal names that can arrive from a sync peer and cannot be
    // materialized on a Windows disk.
    for (const path of ["nul.md", "notes.md:hidden.md", "DOHC~1.md"]) {
      expect(() => assertGeneratedMarkdownPath(path, "win32")).toThrow(
        UnsupportedWorkspacePathError,
      );
      try {
        assertGeneratedMarkdownPath(path, "win32");
      } catch (error) {
        expect(error).toBeInstanceOf(UnsupportedWorkspacePathError);
        expect((error as UnsupportedWorkspacePathError).code).toBe("unsupported-name");
        expect((error as UnsupportedWorkspacePathError).workspacePath).toBe(path);
      }
      // Same names are host-legal off Windows: no typed rejection.
      expect(assertGeneratedMarkdownPath(path, "linux")).toBe(path);
    }
  });

  it("still rejects genuinely-unsafe generated paths generically on every host", () => {
    expect(() => assertGeneratedMarkdownPath("../escape.md", "linux")).toThrow(
      /safe visible Markdown path/,
    );
    expect(() => assertGeneratedMarkdownPath("notes/plan.txt", "linux")).toThrow(
      /safe visible Markdown path/,
    );
  });
});

describe("workspaceEngineCapture recorder", () => {
  it("records nothing without an engine capture", async () => {
    const root = await createTestScratch("dohc-engine-capture-");
    const workspace: CreatedWorkspace = {
      workspaceId: "no-recorder",
      rootPath: root,
      kind: "personal",
      mode: defaultWorkspaceMode("personal"),
    };
    let resolveRecorded: (() => void) | null = null;
    const recorded = new Promise<void>((resolve) => {
      resolveRecorded = resolve;
    });
    const handle = startWorkspaceWatch(workspace, {
      settleMs: 60,
      onRecorded: () => resolveRecorded?.(),
    });
    await handle.ready;
    await write(root, "notes.md", "# Notes\n");
    // The batch still settles (UI refresh / cloud queue), but no history of
    // any kind is written: no legacy change sets, no engine store.
    await recorded;
    await handle.stop();

    expect(existsSync(join(root, ".dohc", "history"))).toBe(false);
    expect(existsSync(join(root, ".dohc", "engine", "engine.db"))).toBe(false);
  });
});

describe("workspaceEngineCapture capture-failure notice", () => {
  it("mutation proof: daemon startup open failure raises the capture outcome", async () => {
    const root = await createTestScratch("dohc-engine-capture-");
    const { loopback, state } = failableLoopback();
    const outcomes: boolean[] = [];
    const errors: string[] = [];
    let resolveOutcome!: () => void;
    const outcomeReported = new Promise<void>((resolve) => {
      resolveOutcome = resolve;
    });
    let resolveError!: () => void;
    const errorReported = new Promise<void>((resolve) => {
      resolveError = resolve;
    });
    const engine = liveCapture(root, loopback, {
      onCaptureOutcome: (failure) => {
        outcomes.push(failure === null);
        resolveOutcome();
      },
      onError: (context) => {
        errors.push(context);
        resolveError();
      },
    });

    engine.start();
    await Promise.all([outcomeReported, errorReported]);

    expect(outcomes).toEqual([false]);
    expect(errors).toEqual(["daemon capture health"]);
    state.failing = false;
    await engine.stop();
  });

  it("keeps a workspace without a capture unaffected", async () => {
    const root = await createTestScratch("dohc-engine-capture-");
    const workspace: CreatedWorkspace = {
      workspaceId: "engine-capture-no-capture-notice",
      rootPath: root,
      kind: "personal",
      mode: defaultWorkspaceMode("personal"),
    };
    const activity = createWorkspaceActivity(() => {}, {
      captureFor: () => ({ capture: null, shareView: false }),
    });
    await activity.open(workspace);
    expect(activity.getStatus(workspace.workspaceId).historyCaptureFailed).toBeUndefined();
    await activity.stopAll();
    // Not-open workspaces report a clean status too.
    expect(activity.getStatus("never-opened").historyCaptureFailed).toBeUndefined();
  });
});

describe("workspaceEngineCapture lifecycle via workspaceActivity", () => {
  it("registerExpectedEngineEvents reaches the open workspace's capture", async () => {
    const root = await createTestScratch("dohc-engine-capture-");
    const workspace: CreatedWorkspace = {
      workspaceId: "engine-capture-expected",
      rootPath: root,
      kind: "personal",
      mode: defaultWorkspaceMode("personal"),
    };
    const loopback = new VersionedLoopbackEngine();
    const activity = createWorkspaceActivity(() => {}, {
      captureFor: (w) => ({
        shareView: false,
        capture: createWorkspaceEngineCapture({
          workspaceId: w.workspaceId,
          rootPath: w.rootPath,
          attachmentId: w.attachmentId,
          rustEngineSessions: mockLiveSessions(loopback),
        }),
      }),
    });
    await activity.open(workspace);
    const cancel = activity.registerExpectedEngineEvents(workspace.workspaceId, [
      { path: "a.md" },
    ]);
    expect(typeof cancel).toBe("function");
    cancel?.();
    await activity.stopAll();

    expect(() =>
      activity.registerExpectedEngineEvents("not-open", [
        { path: "a.md" },
      ]),
    ).toThrow(/not open/i);
  });
});

describe("createDefaultDiskWriter symlink containment", () => {
  // The engine's own materialization writes (switch/merge/restore) must stay
  // inside the workspace even against adversarial symlinks on disk.
  it("refuses to write through a symlink leaf", async () => {
    const root = await createTestScratch("dohc-engine-capture-");
    const outside = await createTestScratch("dohc-engine-capture-");
    await write(outside, "target.md", "original outside content\n");
    await symlink(join(outside, "target.md"), join(root, "notes.md"));

    const writer = createDefaultDiskWriter(root);
    await expect(
      writer.writeTextFile(join(root, "notes.md"), "engine text\n"),
    ).rejects.toThrow(/symlink/);
    // The symlink target outside the workspace was never touched.
    expect(await readFile(join(outside, "target.md"), "utf8")).toBe(
      "original outside content\n",
    );
  });

  it("refuses to mkdir through a symlinked ancestor pointing outside the workspace", async () => {
    const root = await createTestScratch("dohc-engine-capture-");
    const outside = await createTestScratch("dohc-engine-capture-");
    await symlink(outside, join(root, "escape"));

    const writer = createDefaultDiskWriter(root);
    await expect(
      writer.writeTextFile(join(root, "escape", "deep", "file.md"), "x\n"),
    ).rejects.toThrow(/escaped the workspace root/);
    // mkdir -p never created directories on the far side of the symlink.
    expect(existsSync(join(outside, "deep"))).toBe(false);
  });

  it("writes normally inside the workspace, creating missing directories", async () => {
    const root = await createTestScratch("dohc-engine-capture-");
    const writer = createDefaultDiskWriter(root);
    await writer.writeTextFile(join(root, "a", "b", "c.md"), "nested\n");
    expect(await readFile(join(root, "a", "b", "c.md"), "utf8")).toBe("nested\n");
  });

  it("writes into a directory whose NAME starts with '..'", async () => {
    const root = await createTestScratch("dohc-engine-capture-");
    const writer = createDefaultDiskWriter(root);
    await writer.writeTextFile(join(root, "..cache", "c.md"), "cached\n");
    expect(await readFile(join(root, "..cache", "c.md"), "utf8"), "..-segment: a bare '..-prefix' isInside refuses this real contained name.").toBe("cached\n");
  });

  it("deleting a symlink leaf removes the link, not its target", async () => {
    const root = await createTestScratch("dohc-engine-capture-");
    const outside = await createTestScratch("dohc-engine-capture-");
    await write(outside, "keep.md", "must survive\n");
    await symlink(join(outside, "keep.md"), join(root, "gone.md"));

    const writer = createDefaultDiskWriter(root);
    await writer.deletePath(join(root, "gone.md"));
    expect(existsSync(join(root, "gone.md"))).toBe(false);
    expect(await readFile(join(outside, "keep.md"), "utf8")).toBe("must survive\n");
  });
});

// Agent-attributed capture: while a dohc-tracked agent run is active the
// daemon stamps its captures with that author; a plugin write carries its
// own author instead.
describe("workspaceEngineCapture agent attribution", () => {
  const run = { agentId: "dohc-mcp", onBehalfOf: "local", agentRunId: "run-1" };

  it("routes plugin files.write with an explicit plugin author, not the ambient run", async () => {
    const root = await createTestScratch("dohc-engine-capture-");
    const loopback = new VersionedLoopbackEngine();
    const engine = liveCapture(root, loopback);
    await engine.setActiveAgentRun(run);
    const spawnId = "plugin-spawn-123";

    await invokePluginSdkHost(
      {
        pluginId: "hello-plugin",
        workspaceRoot: root,
        reads: localWorkspaceSdkReads(root),
        editDatabase: localWorkspaceSdkDatabaseEditor(root),
        spawnId,
        requestPath: "plugin-process",
        isWritable: () => true,
        writeAvailable: async () => true,
        writeAuthoredText: async (path, text, options) => {
          expect(options.overwrite).toBe(true);
          await engine.writeAuthoredTextFile(
            join(root, path),
            text,
            options.author,
          );
          return { path };
        },
      },
      "files.write",
      { path: "plugin-output.txt", text: "Written by plugin\n" },
    );

    expect(await readFile(join(root, "plugin-output.txt"), "utf8")).toBe(
      "Written by plugin\n",
    );
    expect(await liveMomentAuthors(engine)).toEqual([
      {
        kind: "agent",
        agentId: "plugin:hello-plugin",
        onBehalfOf: "local",
        agentRunId: spawnId,
      },
    ]);
    await engine.stop();
  });

  it("records the canonical path when an authored write uses an in-workspace alias", async () => {
    const root = await createTestScratch("dohc-engine-capture-");
    const canonical = join(root, "canonical");
    await mkdir(canonical);
    await symlink(
      canonical,
      join(root, "alias"),
      process.platform === "win32" ? "junction" : "dir",
    );
    const engine = liveCapture(root, new VersionedLoopbackEngine());

    const result = await engine.writeAuthoredTextFile(
      join(root, "alias", "output.txt"),
      "canonical\n",
      { kind: "agent", agentId: "plugin:test", onBehalfOf: "local", agentRunId: "spawn" },
    );

    expect(result.resolvedAbsolutePath).toBe(join(canonical, "output.txt"));
    await expect(readFile(join(canonical, "output.txt"), "utf8")).resolves.toBe(
      "canonical\n",
    );
    expect((await liveMoments(engine)).map((moment) => moment.path)).toEqual([
      "canonical/output.txt",
    ]);
    await engine.stop();
  });

  it("serializes concurrent create-only authored writes so exactly one wins", async () => {
    const root = await createTestScratch("dohc-engine-capture-");
    const engine = liveCapture(root, new VersionedLoopbackEngine());
    const target = join(root, "exclusive.txt");
    const author = {
      kind: "agent" as const,
      agentId: "plugin:test",
      onBehalfOf: "local",
      agentRunId: "spawn",
    };

    const attempts = await Promise.allSettled([
      engine.writeAuthoredTextFile(target, "first", author, { createOnly: true }),
      engine.writeAuthoredTextFile(target, "second", author, { createOnly: true }),
    ]);

    expect(attempts.filter((attempt) => attempt.status === "fulfilled")).toHaveLength(1);
    expect(attempts.filter((attempt) => attempt.status === "rejected")).toHaveLength(1);
    expect(String(attempts.find((attempt) => attempt.status === "rejected")?.reason)).toContain(
      "File already exists: exclusive.txt",
    );
    await expect(readFile(target, "utf8")).resolves.toMatch(/^(?:first|second)$/);
    await engine.stop();
  });

  it("keeps the text of a writer that creates the file during a create-only write, and records no head", async () => {
    const root = await createTestScratch("dohc-engine-capture-");
    const disk = createDefaultDiskWriter(root);
    const target = join(root, "raced.md");
    const engine = liveCapture(root, new VersionedLoopbackEngine(), {
      diskWriter: {
        ...disk,
        async createTextFile(absolutePath, text) {
          // Another writer creates the file just before the create lands.
          await writeFile(absolutePath, "Written elsewhere.\n");
          await disk.createTextFile(absolutePath, text);
        },
      },
    });

    await expect(
      engine.writeAuthoredTextFile(target, "", null, { createOnly: true }),
    ).rejects.toMatchObject({ code: "EEXIST", message: "File already exists: raced.md" });
    await expect(readFile(target, "utf8")).resolves.toBe("Written elsewhere.\n");
    expect(await liveMoments(engine)).toEqual([]);
    await engine.stop();
  });

  it("rechecks panel cancellation after an authored write reaches the capture queue", async () => {
    const root = await createTestScratch("dohc-engine-capture-");
    const realLoopback = new VersionedLoopbackEngine();
    const entered = deferred();
    const release = deferred();
    let blocked = false;
    const loopback = new Proxy(realLoopback, {
      get(target, property, receiver) {
        if (property !== "sendRequest") return Reflect.get(target, property, receiver);
        return async (request: Request) => {
          if (!blocked && request.method === VERSIONED_METHOD.textWrite) {
            blocked = true;
            entered.resolve();
            await release.promise;
          }
          return target.sendRequest(request);
        };
      },
    });
    const engine = liveCapture(root, loopback);
    const blocker = engine.writeAuthoredTextFile(
      join(root, "queue-blocker.txt"),
      "block\n",
      { kind: "agent", agentId: "plugin:test", onBehalfOf: "local", agentRunId: "spawn" },
    );
    await entered.promise;

    const controller = new AbortController();
    const pending = engine.writeAuthoredTextFile(
      join(root, "cancelled.txt"),
      "must not land\n",
      { kind: "agent", agentId: "plugin:test", onBehalfOf: "local", agentRunId: "spawn" },
      { signal: controller.signal },
    );
    controller.abort();
    release.resolve();

    await expect(pending).rejects.toThrow("Plugin panel is no longer active.");
    await blocker;
    expect(existsSync(join(root, "cancelled.txt"))).toBe(false);
    await engine.stop();
  });

  it("enforces the authored capture size limit and reports observed UTF-8 bytes", async () => {
    const root = await createTestScratch("dohc-engine-capture-");
    const engine = liveCapture(root, new VersionedLoopbackEngine());
    const author = {
      kind: "agent" as const,
      agentId: "plugin:test",
      onBehalfOf: "local",
      agentRunId: "spawn",
    };

    await expect(
      engine.writeAuthoredTextFile(
        join(root, "at-limit.txt"),
        "x".repeat(MAX_DESKTOP_CAPTURE_TEXT_BYTES),
        author,
      ),
    ).resolves.toEqual({ resolvedAbsolutePath: join(root, "at-limit.txt") });
    await expect(
      engine.writeAuthoredTextFile(
        join(root, "over-limit.txt"),
        "x".repeat(MAX_DESKTOP_CAPTURE_TEXT_BYTES + 1),
        author,
      ),
    ).rejects.toThrow(
      `Authored text exceeds the in-band write limit: limit ${MAX_DESKTOP_CAPTURE_TEXT_BYTES} bytes, observed ${MAX_DESKTOP_CAPTURE_TEXT_BYTES + 1} bytes.`,
    );
    await engine.stop();
  });

  it("mutation proof: daemon author state is set before work and flushed before clear", async () => {
    const root = await createTestScratch("dohc-engine-capture-");
    const requests: Request[] = [];
    const loopback = new VersionedLoopbackEngine();
    const engine = capture(root, {
      rustEngineSessions: mockLiveSessions(loopback, requests),
    });

    await engine.setActiveAgentRun(run);
    await engine.setActiveAgentRun(null);

    const authorRequests = requests.filter((request) =>
      request.method === "capture.setAuthor" ||
      request.method === "capture.flush",
    );
    expect(authorRequests.map((request) => request.method)).toEqual([
      "capture.setAuthor",
      "capture.flush",
      "capture.setAuthor",
    ]);
    expect(authorRequests[0]?.params).toEqual({
      author: { kind: "agent", ...run },
    });
    expect(authorRequests[2]?.params).toEqual({ author: null });
    await engine.stop();
  });

  it("mutation proof: an unsettled flush refuses to clear daemon authorship", async () => {
    const root = await createTestScratch("dohc-engine-capture-");
    const requests: Request[] = [];
    const loopback = new VersionedLoopbackEngine();
    let settled = false;
    const engine = capture(root, {
      rustEngineSessions: mockLiveSessions(loopback, requests, () => ({
        settled,
        running: true,
        degraded: !settled,
      })),
    });

    await engine.setActiveAgentRun(run);
    await expect(engine.setActiveAgentRun(null)).rejects.toThrow("did not settle");
    const methods = requests
      .filter(
        (request) =>
          request.method === "capture.flush" ||
          request.method === "capture.setAuthor",
      )
      .map((request) => request.method);
    // The guarantee is that authorship is never cleared behind an unsettled
    // flush — not how many times the flush was asked. flushCapture now polls
    // for quiescence, as the daemon documents and every Rust consumer does,
    // so pinning the exact call count would fail on the retries while proving
    // nothing extra. Pin the guarantee instead: the run was stamped once, the
    // clear never happened, and nothing but flushes ran in between.
    expect(methods[0]).toBe("capture.setAuthor");
    expect(methods.filter((method) => method === "capture.setAuthor")).toEqual([
      "capture.setAuthor",
    ]);
    expect(methods.slice(1).every((method) => method === "capture.flush")).toBe(
      true,
    );
    expect(methods.length).toBeGreaterThan(1);

    settled = true;
    await engine.setActiveAgentRun(null);
    expect(
      requests.filter((request) => request.method === "capture.setAuthor").at(-1)
        ?.params,
    ).toEqual({ author: null });
    await engine.stop();
  });

});

describe("Rust engine session selection", () => {
  // An injected store can observe capture operations, but it cannot select the
  // retired in-process Y.Doc provider.
  async function openWith(
    root: string,
  ): Promise<{ providerOpened: number; storeReads: number }> {
    const loopback = new VersionedLoopbackEngine();
    const sessions = mockLiveSessions(loopback);
    const liveStore = createCaptureLiveStores(
      {
        workspaceId: WORKSPACE_ID,
        rootPath: root,
        attachmentId: WORKSPACE_ATTACHMENT_ID,
      },
      sessions,
    ).store;
    let storeReads = 0;
    const observedStore = new Proxy(liveStore, {
      get(target, property) {
        if (property === "readTextFile") {
          return async (input: Parameters<typeof liveStore.readTextFile>[0]) => {
            storeReads += 1;
            return await liveStore.readTextFile(input);
          };
        }
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    let providerOpened = 0;
    const engine = capture(root, {
      store: observedStore,
      rustEngineSessions: sessions,
      openRustYDocProviderSession: async () => {
        providerOpened += 1;
        const doc = new Y.Doc();
        doc.getText("content").insert(0, "daemon");
        return {
          doc,
          initialUpdate: Y.encodeStateAsUpdate(doc),
          contentKind: "plaintext",
          path: "note.md",
          head: "present" as const,
          lineage: "existing" as const,
          evict: async () => undefined,
          applyLocalUpdate: async () => undefined,
          settleNow: async () =>
            ({ sha256: "b".repeat(64), content: "daemon" }) as never,
          close: async () => undefined,
        } as never;
      },
    });
    const session = await engine.openYDocSession({
      path: "note.md",
      onRemoteUpdate: () => undefined,
    });
    await session.close({ settle: false });
    await engine.stop();
    await liveStore.close();
    return { providerOpened, storeReads };
  }

  it("uses the Rust provider session when a store is injected", async () => {
    const root = await createTestScratch("dohc-engine-capture-");
    const { providerOpened } = await openWith(root);
    expect(providerOpened).toBe(1);
  });
});

// A Y.Doc session's version binding and its registry entry are decided
// one daemon round trip apart: `openYDocSession` reads the active version,
// opens the provider, and only then records the session as live. Off the
// capture chain, a version operation running inside that gap swept a registry
// the session had not reached yet — so the sweep vacated nothing, and the
// session went live against the version the user had just LEFT. Everything
// typed into it settled into that version's lineage and materialized its
// projection over the folder the operation had just written.
//
// Both tests stage the interleaving rather than race it. The daemon request
// that marks "this version operation is past its live-session sweep" blocks,
// the open is issued inside that window, and the window is then held open for
// a full daemon round trip the test drives itself (`listVersions`) — strictly
// more turns than an unserialized open needs to reach the provider. So an
// empty provider log at that point is PROOF the open is queued behind the
// chain, not evidence that it happened to be slower.
describe("workspaceEngineCapture Y.Doc session ordering against version operations", () => {
  function recordingProvider(openedVersionIds: string[]) {
    return async (
      options: EngineYdocProviderSessionOptions,
    ): Promise<EngineYdocProviderSession> => {
      openedVersionIds.push(options.versionId);
      const doc = new Y.Doc();
      return {
        doc,
        initialUpdate: Y.encodeStateAsUpdate(doc),
        contentKind: "plaintext",
        path: options.path,
        // `as never` below stops tsc checking this literal, so these two are
        // stated by hand. Without them `head` was undefined here and the
        // absent-head refusal never ran in this test at all.
        head: "present" as const,
        lineage: "existing" as const,
        evict: async () => undefined,
        applyLocalUpdate: async () => undefined,
        settleNow: async () =>
          ({ sha256: "c".repeat(64), content: "" }) as never,
        close: async () => undefined,
      } as never;
    };
  }

  it("hydrates a live artifact asset by its workspace-scoped blob after its head is retired", async () => {
    const root = await createTestScratch("dohc-engine-capture-");
    const loopback = new VersionedLoopbackEngine();
    const path = "drawings/asset-recovery.excalidraw";
    const assetPath = `assets/excalidraw/${"a".repeat(64)}/${"b".repeat(64)}.png`;
    const bytes = Uint8Array.from([0x89, 0x50, 0x4e, 0x47]);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    loopback.seedTextFile({
      workspace: WORKSPACE_ID,
      versionId: "main",
      path,
      text: '{"type":"excalidraw","elements":[],"appState":{},"files":{}}',
    });
    loopback.seedBinaryFile({
      workspace: WORKSPACE_ID,
      versionId: "main",
      path: assetPath,
      bytes: Array.from(bytes),
      origin: "sync",
    });
    const engine = capture(root, {
      rustEngineSessions: mockLiveSessions(loopback),
      openRustYDocProviderSession: async (options) => {
        const doc = new Y.Doc();
        return {
          doc,
          initialUpdate: Y.encodeStateAsUpdate(doc),
          contentKind: "scene",
          path: options.path,
          head: "present",
          lineage: "existing",
          artifactAssets: [
            {
              id: "image-file",
              mimeType: "image/png",
              created: 1,
              ref: assetPath,
              sha256,
            },
          ],
          evict: async () => undefined,
          applyLocalUpdate: async () => undefined,
          settleNow: async () => ({ sha256: "c".repeat(64), content: "" }) as never,
          close: async () => undefined,
        } as never;
      },
    });
    const session = await engine.openYDocSession({ path, onRemoteUpdate: () => undefined });
    await loopback.sendRequest({
      id: -1,
      method: VERSIONED_METHOD.textDelete,
      workspace: WORKSPACE_ID,
      params: { versionId: "main", path: assetPath, origin: "api" },
    });

    const descriptor = session.artifactAssets?.[0];
    expect(descriptor).toBeDefined();
    await expect(session.readArtifactAsset(descriptor!)).resolves.toEqual({
      descriptor,
      bytes,
    });
    await session.close({ settle: false });
    await engine.stop();
  });

  it("exposes replacement assets after a live lineage resync", async () => {
    const root = await createTestScratch("dohc-engine-capture-");
    const loopback = new VersionedLoopbackEngine();
    const path = "drawings/replaced-assets.excalidraw";
    const bytes = Uint8Array.from([0x89, 0x50, 0x4e, 0x47]);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const losing: ArtifactAssetDescriptor = {
      id: "losing-image",
      mimeType: "image/png",
      created: 1,
      ref: `assets/excalidraw/${"a".repeat(64)}/${"b".repeat(64)}.png`,
      sha256: "a".repeat(64),
    };
    const winning: ArtifactAssetDescriptor = {
      id: "winning-image",
      mimeType: "image/png",
      created: 2,
      ref: `assets/excalidraw/${"c".repeat(64)}/${sha256}.png`,
      sha256,
    };
    loopback.seedTextFile({
      workspace: WORKSPACE_ID,
      versionId: "main",
      path,
      text: '{"type":"excalidraw","elements":[],"appState":{},"files":{}}',
    });
    loopback.seedBinaryFile({
      workspace: WORKSPACE_ID,
      versionId: "main",
      path: winning.ref,
      bytes: Array.from(bytes),
      origin: "sync",
    });
    let replaceLineage!: () => void;
    let activeAssets: readonly ArtifactAssetDescriptor[] = [losing];
    let lineageClaimId = "losing-claim";
    const engine = capture(root, {
      rustEngineSessions: mockLiveSessions(loopback),
      openRustYDocProviderSession: async (options) => {
        const doc = new Y.Doc();
        const provider = {
          doc,
          initialUpdate: Y.encodeStateAsUpdate(doc),
          get lineageClaimId() {
            return lineageClaimId;
          },
          contentKind: "scene" as const,
          path: options.path,
          head: "present" as const,
          lineage: "existing" as const,
          get artifactAssets() {
            return activeAssets;
          },
          evict: async () => undefined,
          applyLocalUpdate: async () => undefined,
          settleNow: async () => ({
            sha256: "c".repeat(64),
            content: "",
          }) as never,
          close: async () => undefined,
        } satisfies EngineYdocProviderSession;
        replaceLineage = () => {
          activeAssets = [winning];
          lineageClaimId = "winning-claim";
          options.onLineageReplaced?.(new Y.Doc(), []);
        };
        return provider;
      },
    });
    const replacements: Uint8Array[] = [];
    const session = await engine.openYDocSession({
      path,
      onRemoteUpdate: () => undefined,
      onLineageReplaced: (update) => replacements.push(update),
    });

    replaceLineage();

    expect(replacements).toHaveLength(1);
    expect(session.artifactAssets).toEqual([winning]);
    await expect(session.readArtifactAsset(winning)).resolves.toEqual({
      descriptor: winning,
      bytes,
    });
    await session.close({ settle: false });
    await engine.stop();
  });

  it("opens a session against the version a running switch is ENTERING, never the one it is leaving", async () => {
    const root = await createTestScratch("dohc-engine-capture-");
    const loopback = new VersionedLoopbackEngine();
    loopback.seedTextFile({
      workspace: WORKSPACE_ID,
      versionId: "main",
      path: "plan.md",
      text: "main\n",
    });
    const openedVersionIds: string[] = [];
    const switchReachedMaterialization = deferred();
    const releaseSwitch = deferred();
    // The daemon materializes the entered version inside versions.setActive,
    // so blocking that request holds the switch exactly where the issue puts
    // it: past the live-session sweep, still rewriting the folder.
    const sessions = mockLiveSessions(
      loopback,
      undefined,
      undefined,
      async (request) => {
        if (request.method !== VERSIONED_METHOD.versionsSetActive) return;
        const params = request.params as { versionId?: string };
        // createVersion's own set-active is not the switch under test.
        if (params.versionId !== "main") return;
        switchReachedMaterialization.resolve();
        await releaseSwitch.promise;
      },
    );
    const engine = capture(root, {
      rustEngineSessions: sessions,
      openRustYDocProviderSession: recordingProvider(openedVersionIds),
    });

    // Create-and-switch leaves "Draft" active; the switch under test returns
    // to Main, so the two versions are distinguishable in the assertion.
    const created = await engine.createVersion("Draft");
    const draftVersionId = created.activeVersionId;
    expect(draftVersionId).not.toBe("main");

    const switching = engine.switchVersion("main");
    await switchReachedMaterialization.promise;
    const opening = engine.openYDocSession({
      path: "plan.md",
      onRemoteUpdate: () => undefined,
    });
    // Hold the window open for two full daemon round trips. The open's own
    // active-version read was issued first and travels the same transport, so
    // an off-chain open has already reached the provider by the time these
    // return.
    await engine.listVersions();
    await engine.listVersions();
    expect(openedVersionIds, "drop the enqueueResult wrapper from openYDocSession. The open reads the active version while set-active is still blocked and opens the provider on [draftVersionId] — a live session on the version the user left, which the switch's sweep had already passed and could not vacate.").toEqual([]);

    releaseSwitch.resolve();
    const session = await opening;
    await switching;

    // Whatever the user types next belongs to the version they are looking at.
    expect(openedVersionIds).toEqual(["main"]);
    await session.close({ settle: false });
    await engine.stop();
  });

  // The loopback has no conflict ledger, and mergeVersionIntoMain reads one
  // unconditionally to resume an already-open conflict. An empty page is the
  // honest answer for a workspace that has never conflicted, and it keeps the
  // merge under test a real merge instead of a rejected one.
  class MergeableLoopbackEngine extends VersionedLoopbackEngine {
    override async sendRequest(request: Request): Promise<Response> {
      if (request.method === "conflicts.list") {
        return {
          id: request.id,
          result: { conflicts: [], nextAfterConflictId: null },
        };
      }
      return await super.sendRequest(request);
    }
  }

  it("opens a session only after a running merge has finished reading and writing heads", async () => {
    const root = await createTestScratch("dohc-engine-capture-");
    const loopback = new MergeableLoopbackEngine();
    loopback.seedTextFile({
      workspace: WORKSPACE_ID,
      versionId: "main",
      path: "plan.md",
      text: "main\n",
    });
    const openedVersionIds: string[] = [];
    const order: string[] = [];
    const mergeReachedHeads = deferred();
    const releaseMerge = deferred();
    // conflicts.list runs after the merge's sweep and flush, before it reads
    // or writes a single head — the "merging immediately after an edit" window.
    const sessions = mockLiveSessions(
      loopback,
      undefined,
      undefined,
      async (request) => {
        if (request.method !== "conflicts.list") return;
        order.push("merge:reads-heads");
        mergeReachedHeads.resolve();
        await releaseMerge.promise;
      },
    );
    const engine = capture(root, {
      rustEngineSessions: sessions,
      openRustYDocProviderSession: async (options) => {
        order.push("ydoc:open");
        return await recordingProvider(openedVersionIds)(options);
      },
    });

    const created = await engine.createVersion("Draft");
    const draftVersionId = created.activeVersionId;
    const merging = engine.mergeVersionIntoMain(draftVersionId);
    await mergeReachedHeads.promise;
    const opening = engine.openYDocSession({
      path: "plan.md",
      onRemoteUpdate: () => undefined,
    });
    // Same verification staging as the switch test: two round trips the test
    // drives itself, so an unserialized open has provably reached the provider.
    await engine.listVersions();
    await engine.listVersions();
    expect(order, "drop the enqueueResult wrapper from openYDocSession. The open lands inside the merge, so this reads ['merge:reads-heads', 'ydoc:open'] — a session seeded from a head the merge is in the middle of replacing, and invisible to the sweep that was supposed to vacate it.").toEqual(["merge:reads-heads"]);

    releaseMerge.resolve();
    const session = await opening;
    await merging;

    expect(order).toEqual(["merge:reads-heads", "ydoc:open"]);
    await session.close({ settle: false });
    await engine.stop();
  });

  it("still opens a session on the active version when no version operation is running", async () => {
    const root = await createTestScratch("dohc-engine-capture-");
    const loopback = new VersionedLoopbackEngine();
    loopback.seedTextFile({
      workspace: WORKSPACE_ID,
      versionId: "main",
      path: "plan.md",
      text: "main\n",
    });
    const openedVersionIds: string[] = [];
    const engine = capture(root, {
      rustEngineSessions: mockLiveSessions(loopback),
      openRustYDocProviderSession: recordingProvider(openedVersionIds),
    });

    const first = await engine.openYDocSession({
      path: "plan.md",
      onRemoteUpdate: () => undefined,
    });
    await first.close({ settle: false });
    const created = await engine.createVersion("Draft");
    const second = await engine.openYDocSession({
      path: "plan.md",
      onRemoteUpdate: () => undefined,
    });

    expect(openedVersionIds).toEqual(["main", created.activeVersionId]);
    await second.close({ settle: false });
    await engine.stop();
  });
});

// The absent-head refusal reads the disk, and that read is
// awaited. On a shared workspace a replicated `onRemoteUpdate` can land inside
// that await: a peer is writing this very path. Two things then stop being
// true at once — the version does have the document, so "not in this version"
// is false; and the lineage is dirty, so the refusal's `close({settle:false})`
// is answered with UnsettledClose and the provider escalates it to a settling
// close, materializing the path the refusal was about to call missing. The
// refusal would create the phantom it exists to prevent.
describe("workspaceEngineCapture absent-head refusal against replication", () => {
  it("binds instead of refusing when a replicated update reached the session", async () => {
    const root = await createTestScratch("dohc-engine-capture-");
    const loopback = new VersionedLoopbackEngine();
    loopback.seedTextFile({
      workspace: WORKSPACE_ID,
      versionId: "main",
      path: "unrelated.md",
      text: "main",
    });
    const remoteDoc = new Y.Doc();
    remoteDoc.getText("content").insert(0, "written by a peer");
    const peerUpdate = Y.encodeStateAsUpdate(remoteDoc);
    const settles: string[] = [];
    let closedWithSettle: boolean | undefined;
    const engine = capture(root, {
      rustEngineSessions: mockLiveSessions(loopback),
      openRustYDocProviderSession: async (options) => {
        // After the open resolves, inside the awaited disk check. A timer beats
        // an lstat round trip, so the update lands where the race puts it —
        // which is what makes the recheck's POSITION testable, not just its
        // existence.
        // Delivered during the open, which the generation buffers and replays
        // the moment it installs — after the daemon has answered
        // head/lineage absent, before the guard runs. That is deterministic.
        // The window codex named (arrival inside the awaited disk check) is the
        // same defect one tick later, and the guard reads the count once after
        // that await, so both arrivals take the identical path. Racing an lstat
        // with a timer is not stageable, so this stages the half that is.
        options.onRemoteUpdate(peerUpdate);
        return {
          doc: remoteDoc,
          initialUpdate: Y.encodeStateAsUpdate(remoteDoc),
          contentKind: "plaintext",
          path: options.path,
          // The daemon's answer at open time: nothing committed, nothing
          // durable. The peer's update is still in flight behind it.
          head: "absent" as const,
          lineage: "absent" as const,
          evict: async () => undefined,
          applyLocalUpdate: async () => undefined,
          settleNow: async () => {
            settles.push("settle");
            return { sha256: "d".repeat(64), content: "written by a peer" } as never;
          },
          close: async (closeOptions?: { settle?: boolean }) => {
            closedWithSettle = closeOptions?.settle;
          },
        } as never;
      },
    });

    // The path is in neither the version nor on disk — every input the refusal
    // keys on says "missing". Only the peer's update says otherwise.
    const session = await engine.openYDocSession({
      path: "peer-created.md",
      onRemoteUpdate: () => undefined,
    });

    expect(session.path).toBe("peer-created.md");
    // Nothing was settled or materialized by a refusal that never happened.
    expect(settles).toEqual([]);
    expect(closedWithSettle).toBeUndefined();
    await expect(readFile(join(root, "peer-created.md"), "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
    await session.close({ settle: false });
    await engine.stop();
  });

  it("refuses without settling, and without calling it missing, when an update wins the release gap", async () => {
    // The narrower seam: the count is read, THEN the release is queued through
    // the operation chain, so an update can still arrive before the close
    // reaches the daemon. The daemon answers UnsettledClose — "content arrived
    // after all". The session cannot be handed back (its provider already
    // closed itself and dropped every subscription) and cannot be reopened (a
    // refused close reinserts the daemon entry with its lease held).
    //
    // Two things must be true of the answer, and #665 changed which refusal
    // carries them. It may never call the path missing — something IS writing
    // it — and it may never leave the surface writable over a session the
    // daemon still holds.
    //
    // The orphan now evicts when its close is refused, so the daemon no longer
    // holds the session and the second hazard is gone with it. What remains is
    // the first, and `YDocOpenRacedError` is exactly it: this open's answer is
    // already stale, open it again — and the next open binds the lineage the
    // eviction preserved. The path this test guards is that the refusal is
    // decided by the refused close, not by a second look at the disk.
    const root = await createTestScratch("dohc-engine-capture-");
    const loopback = new VersionedLoopbackEngine();
    loopback.seedTextFile({
      workspace: WORKSPACE_ID,
      versionId: "main",
      path: "unrelated.md",
      text: "main",
    });
    const doc = new Y.Doc();
    doc.getText("content").insert(0, "arrived from a peer");
    const peerUpdate = Y.encodeStateAsUpdate(doc);
    const closeCalls: Array<{ settle?: boolean; settleOnRefusal?: boolean }> = [];
    const settles: string[] = [];
    let evicts = 0;
    const engine = capture(root, {
      rustEngineSessions: mockLiveSessions(loopback),
      openRustYDocProviderSession: async (options) => {
        let deliver: (() => void) | null = () => options.onRemoteUpdate(peerUpdate);
        return {
          doc,
          initialUpdate: Y.encodeStateAsUpdate(doc),
          contentKind: "plaintext",
          path: options.path,
          head: "absent" as const,
          lineage: "absent" as const,
          evict: async () => {
            evicts += 1;
          },
          applyLocalUpdate: async () => undefined,
          settleNow: async () => {
            settles.push("settle");
            return { sha256: "e".repeat(64), content: "arrived from a peer" } as never;
          },
          close: async (closeOptions?: {
            settle?: boolean;
            settleOnRefusal?: boolean;
          }) => {
            closeCalls.push({ ...closeOptions });
            // The update lands in the gap the release was queued across, and
            // the daemon refuses because the lineage is now dirty.
            if (deliver) {
              deliver();
              deliver = null;
              throw new DaemonRefusalError(
                {
                  code: "INVALID_PARAMS",
                  message: "ydoc-unsettled-close",
                  retry: "no",
                },
                undefined,
              );
            }
          },
        } as never;
      },
    });

    const refusal = await engine
      .openYDocSession({ path: "peer-created.md", onRemoteUpdate: () => undefined })
      .then(
        () => null,
        (error: unknown) => error,
      );

    expect(refusal, "drop the `dischargedByEvict` arm (#665) -> the recheck finds the path still absent and the refusal claims the version does not have a file a peer is writing into it.").toBeInstanceOf(YDocOpenRacedError);
    expect(isYDocPathNotInVersionError(refusal)).toBe(false);
    // The lease is gone, so the surface may fall back — that is what makes the
    // raced refusal safe here where #564 needed the unreleased one.
    expect(refusal).not.toBeInstanceOf(YDocSessionUnreleasedError);
    expect(evicts).toBe(1);
    // And the release never escalated, so nothing was materialized.
    expect(closeCalls).toEqual([{ settle: false, settleOnRefusal: false }]);
    expect(settles).toEqual([]);
    await expect(readFile(join(root, "peer-created.md"), "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
    await engine.stop();
  });

  it("clears dead-session health when orphan eviction discharges it", async () => {
    // A handed-out session can never become an orphan: only the absent-head
    // refusal below sets that state, before open returns. Stage daemon death at
    // that boundary through the provider's real reconnect callback instead.
    const root = await createTestScratch("dohc-engine-capture-");
    const loopback = new VersionedLoopbackEngine();
    loopback.seedTextFile({
      workspace: WORKSPACE_ID,
      versionId: "main",
      path: "unrelated.md",
      text: "main",
    });
    const doc = new Y.Doc();
    const outcomes: boolean[] = [];
    const reconnectFailure = Object.assign(new Error("daemon exited"), {
      code: "transport-error",
    });
    const replacementFailure = new Error("replacement daemon unavailable");
    const unsettled = new DaemonRefusalError(
      {
        code: "INVALID_PARAMS",
        message: "ydoc-unsettled-close",
        retry: "no",
      },
      undefined,
    );
    let opens = 0;
    let evicts = 0;
    let reportedDeath = false;
    const engine = capture(root, {
      rustEngineSessions: mockLiveSessions(loopback),
      onCaptureOutcome: (failure) => outcomes.push(failure === null),
      onError: () => undefined,
      openRustYDocProviderSession: async (options) => {
        opens += 1;
        if (opens > 1) throw replacementFailure;
        return {
          doc,
          initialUpdate: Y.encodeStateAsUpdate(doc),
          contentKind: "plaintext",
          path: options.path,
          get head() {
            if (!reportedDeath) {
              reportedDeath = true;
              options.onSessionError?.(reconnectFailure);
            }
            return "absent" as const;
          },
          lineage: "absent" as const,
          evict: async () => {
            evicts += 1;
          },
          applyLocalUpdate: async () => undefined,
          settleNow: async () =>
            ({ sha256: "f".repeat(64), content: "" }) as never,
          close: async () => {
            throw unsettled;
          },
        };
      },
    });

    const refusal = await engine
      .openYDocSession({
        path: "peer-created.md",
        onRemoteUpdate: () => undefined,
      })
      .then(
        () => null,
        (error: unknown) => error,
      );

    expect(refusal, "delete `clearDeadYDocSession` from the orphan evict -> the last outcome stays false.").toBeInstanceOf(YDocOpenRacedError);
    expect(opens).toBe(2);
    expect(outcomes).toEqual([false, true]);
    expect(evicts, "drop the `releaseObligation` branch from the wrapper's `evict()` -> the obligated session's lease remains held forever.").toBe(1);
    await engine.stop();
  });

  it("does not evict an orphan when its close fails for an unrelated reason", async () => {
    const root = await createTestScratch("dohc-engine-capture-");
    const loopback = new VersionedLoopbackEngine();
    loopback.seedTextFile({
      workspace: WORKSPACE_ID,
      versionId: "main",
      path: "unrelated.md",
      text: "main",
    });
    const doc = new Y.Doc();
    doc.getText("content").insert(0, "arrived from a peer");
    const peerUpdate = Y.encodeStateAsUpdate(doc);
    const closeCalls: Array<{ settle?: boolean; settleOnRefusal?: boolean }> = [];
    const settles: string[] = [];
    let evicts = 0;
    const engine = capture(root, {
      rustEngineSessions: mockLiveSessions(loopback),
      openRustYDocProviderSession: async (options) => {
        let deliver: (() => void) | null = () =>
          options.onRemoteUpdate(peerUpdate);
        return {
          doc,
          initialUpdate: Y.encodeStateAsUpdate(doc),
          contentKind: "plaintext",
          path: options.path,
          head: "absent" as const,
          lineage: "absent" as const,
          evict: async () => {
            evicts += 1;
          },
          applyLocalUpdate: async () => undefined,
          settleNow: async () => {
            settles.push("settle");
            return {
              sha256: "f".repeat(64),
              content: "arrived from a peer",
            } as never;
          },
          close: async (closeOptions?: {
            settle?: boolean;
            settleOnRefusal?: boolean;
          }) => {
            closeCalls.push({ ...closeOptions });
            if (deliver) {
              deliver();
              deliver = null;
              throw new DaemonRefusalError(
                {
                  code: "INVALID_PARAMS",
                  message: "ydoc-something-else",
                  retry: "no",
                },
                undefined,
              );
            }
          },
        } as never;
      },
    });

    const refusal = await engine
      .openYDocSession({
        path: "peer-created.md",
        onRemoteUpdate: () => undefined,
      })
      .then(
        () => null,
        (error: unknown) => error,
      );

    expect(refusal).toBeInstanceOf(YDocSessionUnreleasedError);
    expect(refusal).not.toBeInstanceOf(YDocOpenRacedError);
    expect(evicts).toBe(0);
    expect(closeCalls).toEqual([{ settle: false, settleOnRefusal: false }]);
    expect(settles).toEqual([]);
    await expect(
      readFile(join(root, "peer-created.md"), "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });
    await engine.stop();
  });

  it("does not claim the version is missing a file an agent created during the release", async () => {
    // The disk read is one syscall and the release that follows awaits a daemon
    // round trip. This chain serializes ENGINE work, not the filesystem, so an
    // agent or an external editor can create the path inside that window — and
    // the queued watcher then captures a file the user was just told does not
    // exist. Staged on the close, which is the window.
    const root = await createTestScratch("dohc-engine-capture-");
    const loopback = new VersionedLoopbackEngine();
    loopback.seedTextFile({
      workspace: WORKSPACE_ID,
      versionId: "main",
      path: "unrelated.md",
      text: "main",
    });
    const doc = new Y.Doc();
    const settles: string[] = [];
    const engine = capture(root, {
      rustEngineSessions: mockLiveSessions(loopback),
      openRustYDocProviderSession: async (options) => ({
        doc,
        initialUpdate: Y.encodeStateAsUpdate(doc),
        contentKind: "plaintext",
        path: options.path,
        head: "absent" as const,
        lineage: "absent" as const,
        evict: async () => undefined,
        applyLocalUpdate: async () => undefined,
        settleNow: async () => {
          settles.push("settle");
          return { sha256: "a".repeat(64), content: "" } as never;
        },
        close: async () => {
          // The agent's write lands while the release is in flight.
          await writeFile(join(root, "agent-made.md"), "written by an agent", "utf8");
        },
      }) as never,
    });

    const refusal = await engine
      .openYDocSession({ path: "agent-made.md", onRemoteUpdate: () => undefined })
      .then(
        () => null,
        (error: unknown) => error,
      );

    // The file is there now, so "this version doesn't have this file" would be
    // a false statement to the user.
    expect(isYDocPathNotInVersionError(refusal)).toBe(false);
    expect(refusal).toBeInstanceOf(YDocOpenRacedError);
    // And the agent's bytes were never touched.
    expect(await readFile(join(root, "agent-made.md"), "utf8")).toBe(
      "written by an agent",
    );
    expect(settles).toEqual([]);
    await engine.stop();
  });

  it("keeps refusing an uncaptured artifact even when a replicated update arrived", async () => {
    // Replication-as-existence is safe for a path with nothing on disk. It is
    // not safe when the file is there with bytes capture has not ingested: this
    // bind carries no seed, so its doc holds only the replicated update, and
    // settling it would write that over the user's file — while this same
    // capture chain is what keeps the watcher from ingesting those bytes.
    const root = await createTestScratch("dohc-engine-capture-");
    const loopback = new VersionedLoopbackEngine();
    loopback.seedTextFile({
      workspace: WORKSPACE_ID,
      versionId: "main",
      path: "unrelated.md",
      text: "main",
    });
    await writeFile(join(root, "uncaptured.md"), "bytes the watcher has not seen", "utf8");
    const doc = new Y.Doc();
    doc.getText("content").insert(0, "arrived from a peer");
    const peerUpdate = Y.encodeStateAsUpdate(doc);
    const settles: string[] = [];
    const closeCalls: Array<{ settle?: boolean; settleOnRefusal?: boolean }> = [];
    const engine = capture(root, {
      rustEngineSessions: mockLiveSessions(loopback),
      openRustYDocProviderSession: async (options) => {
        // Delivered during the open, so the count is already non-zero when the
        // rules run — the exact input that used to bypass this refusal.
        options.onRemoteUpdate(peerUpdate);
        return {
          doc,
          initialUpdate: Y.encodeStateAsUpdate(doc),
          contentKind: "plaintext",
          path: options.path,
          head: "absent" as const,
          lineage: "absent" as const,
          evict: async () => undefined,
          applyLocalUpdate: async () => undefined,
          settleNow: async () => {
            settles.push("settle");
            return { sha256: "f".repeat(64), content: "arrived from a peer" } as never;
          },
          close: async (closeOptions?: {
            settle?: boolean;
            settleOnRefusal?: boolean;
          }) => {
            closeCalls.push({ ...closeOptions });
          },
        } as never;
      },
    });

    const refusal = await engine
      .openYDocSession({ path: "uncaptured.md", onRemoteUpdate: () => undefined })
      .then(
        () => null,
        (error: unknown) => error,
      );

    expect(refusal).toBeInstanceOf(YDocUncapturedArtifactError);
    expect(settles).toEqual([]);
    expect(closeCalls).toEqual([{ settle: false, settleOnRefusal: false }]);
    // The bytes the empty bind would have erased are untouched.
    expect(await readFile(join(root, "uncaptured.md"), "utf8")).toBe(
      "bytes the watcher has not seen",
    );
    await engine.stop();
  });

  it("refuses an uncaptured artifact again after orphan eviction resurrects its lineage", async () => {
    const root = await createTestScratch("dohc-engine-capture-");
    const loopback = new VersionedLoopbackEngine();
    loopback.seedTextFile({
      workspace: WORKSPACE_ID,
      versionId: "main",
      path: "unrelated.md",
      text: "main",
    });
    // The default policy tracks this short Markdown file, so capture will reach it.
    const path = "resurrected.md";
    const original = "already on disk, never captured";
    const resurrected = "resurrected and settled";
    await writeFile(join(root, path), original, "utf8");
    const doc = new Y.Doc();
    doc.getText("content").insert(0, resurrected);
    const settled: string[] = [];
    let opens = 0;
    let evicts = 0;
    const engine = capture(root, {
      rustEngineSessions: mockLiveSessions(loopback),
      openRustYDocProviderSession: async (options) => {
        opens += 1;
        return {
          doc,
          initialUpdate: Y.encodeStateAsUpdate(doc),
          contentKind: "plaintext",
          path: options.path,
          head: "absent" as const,
          lineage: opens === 1 ? ("absent" as const) : ("existing" as const),
          evict: async () => {
            evicts += 1;
          },
          applyLocalUpdate: async () => undefined,
          settleNow: async () => {
            settled.push(resurrected);
            await writeFile(join(root, path), resurrected, "utf8");
            return { sha256: "7".repeat(64), content: resurrected } as never;
          },
          close: async () => {
            throw new DaemonRefusalError(
              {
                code: "INVALID_PARAMS",
                message: "ydoc-unsettled-close",
                retry: "no",
              },
              undefined,
            );
          },
        } as never;
      },
    });

    await expect(
      engine.openYDocSession({ path, onRemoteUpdate: () => undefined }),
    ).rejects.toBeInstanceOf(YDocUncapturedArtifactError);
    expect(evicts).toBe(1);
    expect(await readFile(join(root, path), "utf8")).toBe(original);

    await expect(
      engine.openYDocSession({ path, onRemoteUpdate: () => undefined }),
    ).rejects.toBeInstanceOf(YDocUncapturedArtifactError);
    expect(opens).toBe(2);
    expect(evicts).toBe(2);
    expect(settled).toEqual([]);
    expect(await readFile(join(root, path), "utf8")).toBe(original);
    await engine.stop();
  });
});
