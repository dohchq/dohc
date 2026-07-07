import {
  RelayOriginDivergedError,
  RelayUnauthorizedError,
  pullWorkspaceFromRelay,
  pushWorkspaceToRelay,
  recoverRelayOrigin,
  type PullWorkspaceFromRelayResult,
} from "@dohc/workspace-engine";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRelaySyncEngine } from "./relaySyncEngine";
import type { WorkspaceEngineCapture } from "./workspaceEngineCapture";

// The push/pull transport is mocked; the capture is NOT over-mocked — its
// runRelaySync invokes the engine's real callback (the closure under test in
// relaySyncEngine.ts) and honors the commit-after-materialization contract,
// exactly like the real capture implementation.
vi.mock("@dohc/workspace-engine", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@dohc/workspace-engine")>();
  return {
    ...actual,
    pushWorkspaceToRelay: vi.fn(),
    pullWorkspaceFromRelay: vi.fn(),
    recoverRelayOrigin: vi.fn(),
  };
});

const pushMock = vi.mocked(pushWorkspaceToRelay);
const pullMock = vi.mocked(pullWorkspaceFromRelay);
const recoverMock = vi.mocked(recoverRelayOrigin);

function pullResult(
  overrides: Partial<PullWorkspaceFromRelayResult> = {},
): PullWorkspaceFromRelayResult {
  return {
    fetched: 0,
    applied: 0,
    skipped: 0,
    conflictsOpened: 0,
    pendingConflictResolves: 0,
    pendingResolves: [],
    fastForwardedPaths: [],
    nextCursor: 0,
    commitFetchCursor: vi.fn(async () => {}),
    ...overrides,
  };
}

function capture(): WorkspaceEngineCapture {
  return {
    // Mirrors the real capture: run the task (the engine's push+pull
    // closure), materialize (no-op here), then commit the fetch cursor.
    runRelaySync: vi.fn(
      async (task: () => Promise<{ commitFetchCursor?: () => Promise<void> }>) => {
        const result = await task();
        await result.commitFetchCursor?.();
        return result;
      },
    ),
    start: vi.fn(),
    captureBatch: vi.fn(),
    registerExpectedEngineEvents: vi.fn(() => () => {}),
    listVersions: vi.fn(),
    createVersion: vi.fn(),
    switchVersion: vi.fn(),
    compareVersions: vi.fn(),
    mergeVersionIntoMain: vi.fn(),
    listOpenConflicts: vi.fn(),
    resolveConflict: vi.fn(),
    listMoments: vi.fn(),
    readMoment: vi.fn(),
    restoreFileToBeforeMoment: vi.fn(),
    fileObjectIdForPath: vi.fn(),
    beginFileRename: vi.fn(),
    flush: vi.fn(),
    stop: vi.fn(),
  } as unknown as WorkspaceEngineCapture;
}

function engine(input: { capture: WorkspaceEngineCapture; onChange?: () => void }) {
  return createRelaySyncEngine({
    rootDir: "/tmp/workspace",
    remoteWorkspaceId: "workspace-a",
    relay: { baseUrl: "http://relay.test", token: "token" },
    capture: input.capture,
    onChange: input.onChange ?? vi.fn(),
    debounceMs: 100,
    initialBackoffMs: 500,
    maxBackoffMs: 2000,
    nowMs: () => 12345,
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  pushMock.mockReset();
  pullMock.mockReset();
  recoverMock.mockReset();
  pushMock.mockImplementation(async () => ({ pushed: 0, originsPushed: [] }));
  pullMock.mockImplementation(async () => pullResult());
  recoverMock.mockImplementation(async () => ({
    oldOriginId: "origin_old",
    newOriginId: "origin_new",
    sharedPrefixLength: 0,
    preservedOps: 0,
  }));
});

afterEach(() => {
  vi.useRealTimers();
});

describe("relaySyncEngine", () => {
  it("wires push then pull through the capture callback and folds conflicts into the snapshot", async () => {
    const cap = capture();
    const commit = vi.fn(async () => {});
    pullMock.mockImplementation(async () =>
      pullResult({ conflictsOpened: 2, commitFetchCursor: commit }),
    );
    const sync = engine({ capture: cap });
    await sync.start();

    const expectedInput = {
      rootDir: "/tmp/workspace",
      workspaceId: "workspace-a",
      relay: { baseUrl: "http://relay.test", token: "token" },
    };
    expect(pushMock).toHaveBeenCalledWith(expectedInput);
    expect(pullMock).toHaveBeenCalledWith(expectedInput);
    expect(pushMock.mock.invocationCallOrder[0]!).toBeLessThan(
      pullMock.mock.invocationCallOrder[0]!,
    );
    // The pull result rode through the capture (which committed the cursor)
    // and its conflictsOpened landed in the snapshot.
    expect(commit).toHaveBeenCalledTimes(1);
    expect(sync.snapshot().conflictCount).toBe(2);
    expect(sync.snapshot().lastSyncedAtMs).toBe(12345);
  });

  // 0P sync-hardening item 3: a RelayOriginDivergedError (restored/cloned
  // engine.db) is not a dead end — the pass recovers onto a fresh origin,
  // re-pushes, and completes normally instead of failing the pass.
  it("recovers and re-pushes when the origin diverged (restored/cloned engine.db)", async () => {
    const cap = capture();
    pushMock
      .mockRejectedValueOnce(new RelayOriginDivergedError())
      .mockResolvedValue({ pushed: 1, originsPushed: ["origin_new"] });
    const sync = engine({ capture: cap });
    await sync.start();

    const expectedInput = {
      rootDir: "/tmp/workspace",
      workspaceId: "workspace-a",
      relay: { baseUrl: "http://relay.test", token: "token" },
    };
    // Divergence detected → recovery ran once → push retried → pull ran.
    expect(recoverMock).toHaveBeenCalledWith(expectedInput);
    expect(recoverMock).toHaveBeenCalledTimes(1);
    expect(pushMock).toHaveBeenCalledTimes(2);
    expect(pullMock).toHaveBeenCalledTimes(1);
    // The pass completed cleanly — no auth-expiry, no failure notice.
    expect(sync.snapshot().authExpired).toBe(false);
    expect(sync.snapshot().lastSyncedAtMs).toBe(12345);
  });

  it("debounces queued sync and serializes passes through capture", async () => {
    const calls: string[] = [];
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    pullMock
      .mockImplementationOnce(async () => {
        calls.push("first");
        await firstGate;
        return pullResult();
      })
      .mockImplementationOnce(async () => {
        calls.push("second");
        return pullResult();
      });
    const cap = capture();
    const sync = engine({ capture: cap });
    sync.queueSync();
    sync.queueSync();
    await vi.advanceTimersByTimeAsync(100);
    expect(calls).toEqual(["first"]);
    sync.queueSync();
    await vi.advanceTimersByTimeAsync(100);
    expect(calls).toEqual(["first"]);
    releaseFirst();
    await vi.runAllTimersAsync();
    expect(calls).toEqual(["first", "second"]);
  });

  it("backs off after failures, coalesces queued work, and resets on success", async () => {
    let fail = true;
    pullMock.mockImplementation(async () => {
      if (fail) throw new Error("network");
      return pullResult();
    });
    const cap = capture();
    const sync = engine({ capture: cap });
    sync.queueSync();
    await vi.advanceTimersByTimeAsync(100);
    expect(cap.runRelaySync).toHaveBeenCalledTimes(1);

    sync.queueSync();
    sync.queueSync();
    await vi.advanceTimersByTimeAsync(499);
    expect(cap.runRelaySync).toHaveBeenCalledTimes(1);
    fail = false;
    await vi.advanceTimersByTimeAsync(1);
    await vi.runAllTimersAsync();
    expect(cap.runRelaySync).toHaveBeenCalledTimes(2);
    expect(sync.snapshot().syncFailing).toBeUndefined();

    sync.queueSync();
    await vi.advanceTimersByTimeAsync(100);
    await vi.runAllTimersAsync();
    expect(cap.runRelaySync).toHaveBeenCalledTimes(3);
  });

  it("raises syncFailing after three consecutive transient failures and clears on success", async () => {
    let failuresRemaining = 3;
    const changes = vi.fn();
    pullMock.mockImplementation(async () => {
      if (failuresRemaining > 0) {
        failuresRemaining -= 1;
        throw new Error("network");
      }
      return pullResult();
    });
    const sync = engine({ capture: capture(), onChange: changes });
    sync.queueSync();
    await vi.advanceTimersByTimeAsync(100);
    await vi.advanceTimersByTimeAsync(500);
    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(1999);
    expect(sync.snapshot().syncFailing).toBe(true);
    const changesAtFailure = changes.mock.calls.length;
    await vi.advanceTimersByTimeAsync(1);
    expect(sync.snapshot().syncFailing).toBeUndefined();
    expect(changes.mock.calls.length).toBeGreaterThan(changesAtFailure);
  });

  it("re-reads open-conflict truth each pass so resolved conflicts clear the snapshot", async () => {
    const cap = capture();
    let openConflicts = 0;
    pullMock
      .mockImplementationOnce(async () => {
        openConflicts = 2;
        return pullResult({ conflictsOpened: 2 });
      })
      .mockImplementation(async () => pullResult());
    const sync = createRelaySyncEngine({
      rootDir: "/tmp/workspace",
      remoteWorkspaceId: "workspace-a",
      relay: { baseUrl: "http://relay.test", token: "token" },
      capture: cap,
      onChange: vi.fn(),
      countOpenConflicts: async () => openConflicts,
      debounceMs: 100,
      nowMs: () => 12345,
    });
    await sync.start();
    expect(sync.snapshot().conflictCount).toBe(2);

    // The user resolves both conflicts (locally or via a peer's replicated
    // resolution); the next pass must DROP the count, not keep accumulating.
    openConflicts = 0;
    sync.queueSync();
    await vi.advanceTimersByTimeAsync(100);
    await vi.runAllTimersAsync();
    expect(sync.snapshot().conflictCount).toBe(0);
  });

  it("counts unmatched remote conflict resolutions instead of swallowing them", async () => {
    pullMock.mockImplementationOnce(async () =>
      pullResult({
        pendingConflictResolves: 1,
        pendingResolves: [
          { remoteConflictId: "peer-conflict-1", localConflictId: null, path: "x.md" },
        ],
      }),
    );
    const sync = engine({ capture: capture() });
    await sync.start();
    expect(sync.snapshot().unmatchedRemoteResolves).toBe(1);
  });

  // 0P-C gate fix: unmatchedRemoteResolves is a LIFECYCLED set of pending
  // resolve identities, not a session-sticky monotone counter. The same
  // remote resolution re-reported across passes never double-counts, and it
  // clears when its local conflict closes (local resolution or a later sync
  // pass converging it).
  it("clears a pending remote resolve once its local conflict is no longer open", async () => {
    let openConflictIds: string[] = ["conflict-local-1"];
    pullMock
      .mockImplementationOnce(async () =>
        pullResult({
          pendingConflictResolves: 1,
          pendingResolves: [
            {
              remoteConflictId: "peer-conflict-1",
              localConflictId: "conflict-local-1",
              path: "notes/x.md",
            },
          ],
        }),
      )
      .mockImplementationOnce(async () =>
        // The peer retries the same resolve on the next pass (idempotent
        // re-report): identity dedupe keeps the count at 1, not 2.
        pullResult({
          pendingConflictResolves: 1,
          pendingResolves: [
            {
              remoteConflictId: "peer-conflict-1",
              localConflictId: "conflict-local-1",
              path: "notes/x.md",
            },
          ],
        }),
      )
      .mockImplementation(async () => pullResult());
    const sync = createRelaySyncEngine({
      rootDir: "/tmp/workspace",
      remoteWorkspaceId: "workspace-a",
      relay: { baseUrl: "http://relay.test", token: "token" },
      capture: capture(),
      onChange: vi.fn(),
      listOpenConflictIds: async () => openConflictIds,
      debounceMs: 100,
      nowMs: () => 12345,
    });
    await sync.start();
    expect(sync.snapshot().unmatchedRemoteResolves).toBe(1);
    expect(sync.snapshot().conflictCount).toBe(1);

    sync.queueSync();
    await vi.advanceTimersByTimeAsync(100);
    await vi.runAllTimersAsync();
    expect(sync.snapshot().unmatchedRemoteResolves).toBe(1);

    // The user resolves the conflict locally (or a later pull converges it):
    // the next pass drops the pending resolve along with the conflict.
    openConflictIds = [];
    sync.queueSync();
    await vi.advanceTimersByTimeAsync(100);
    await vi.runAllTimersAsync();
    expect(sync.snapshot().unmatchedRemoteResolves).toBe(0);
    expect(sync.snapshot().conflictCount).toBe(0);
  });

  it("a pending resolve that matched no local conflict persists until explicitly dismissed", async () => {
    const changes = vi.fn();
    pullMock
      .mockImplementationOnce(async () =>
        pullResult({
          pendingConflictResolves: 1,
          pendingResolves: [
            { remoteConflictId: "peer-orphan-1", localConflictId: null, path: "gone.md" },
          ],
        }),
      )
      .mockImplementation(async () => pullResult());
    const sync = createRelaySyncEngine({
      rootDir: "/tmp/workspace",
      remoteWorkspaceId: "workspace-a",
      relay: { baseUrl: "http://relay.test", token: "token" },
      capture: capture(),
      onChange: changes,
      listOpenConflictIds: async () => [],
      debounceMs: 100,
      nowMs: () => 12345,
    });
    await sync.start();
    expect(sync.snapshot().unmatchedRemoteResolves).toBe(1);

    // No local conflict can ever clear it — later passes keep it visible.
    sync.queueSync();
    await vi.advanceTimersByTimeAsync(100);
    await vi.runAllTimersAsync();
    expect(sync.snapshot().unmatchedRemoteResolves).toBe(1);

    // The explicit dismissal is the release valve.
    const changesBefore = changes.mock.calls.length;
    sync.dismissUnmatchedResolves();
    expect(sync.snapshot().unmatchedRemoteResolves).toBe(0);
    expect(changes.mock.calls.length).toBeGreaterThan(changesBefore);
    // Dismissing an empty set is a no-op (no notify spam).
    sync.dismissUnmatchedResolves();
    expect(changes.mock.calls.length).toBe(changesBefore + 1);
  });

  // 0P-C gate fix (High): a joining machine must NEVER append ops to the
  // relay before its first successful pull — pushing first could seed
  // boilerplate into the remote workspace or mint conflicts against it.
  it("join bootstrap pulls before any push and only pushes after the first successful pull", async () => {
    const sync = createRelaySyncEngine({
      rootDir: "/tmp/workspace",
      remoteWorkspaceId: "workspace-a",
      relay: { baseUrl: "http://relay.test", token: "token" },
      capture: capture(),
      onChange: vi.fn(),
      joinBootstrap: true,
      debounceMs: 100,
      nowMs: () => 12345,
    });
    await sync.start();
    // First pass: pull only. The relay log is untouched by this machine.
    expect(pullMock).toHaveBeenCalledTimes(1);
    expect(pushMock).not.toHaveBeenCalled();

    // After the bootstrap pull succeeded, the follow-up pass reconciles
    // normally (push then pull).
    await vi.runAllTimersAsync();
    expect(pushMock).toHaveBeenCalledTimes(1);
    expect(pullMock).toHaveBeenCalledTimes(2);
    expect(pushMock.mock.invocationCallOrder[0]!).toBeGreaterThan(
      pullMock.mock.invocationCallOrder[0]!,
    );
  });

  it("a failed bootstrap pull keeps the engine pull-only until a pull succeeds", async () => {
    let fail = true;
    pullMock.mockImplementation(async () => {
      if (fail) throw new Error("offline");
      return pullResult();
    });
    const sync = createRelaySyncEngine({
      rootDir: "/tmp/workspace",
      remoteWorkspaceId: "workspace-a",
      relay: { baseUrl: "http://relay.test", token: "token" },
      capture: capture(),
      onChange: vi.fn(),
      joinBootstrap: true,
      debounceMs: 100,
      initialBackoffMs: 500,
      maxBackoffMs: 2000,
      nowMs: () => 12345,
    });
    await expect(sync.start()).rejects.toThrow("offline");
    expect(pushMock).not.toHaveBeenCalled();

    // Backoff retry while still offline: STILL no push.
    await vi.advanceTimersByTimeAsync(500);
    expect(pullMock).toHaveBeenCalledTimes(2);
    expect(pushMock).not.toHaveBeenCalled();

    // Once a pull finally succeeds, normal push/reconcile resumes.
    fail = false;
    await vi.advanceTimersByTimeAsync(1000);
    await vi.runAllTimersAsync();
    expect(pushMock).toHaveBeenCalledTimes(1);
  });

  it("treats typed 401 as terminal authExpired and stops accumulating queued work", async () => {
    pushMock.mockImplementation(async () => {
      throw new RelayUnauthorizedError();
    });
    const sync = engine({ capture: capture() });
    await expect(sync.start()).rejects.toBeInstanceOf(RelayUnauthorizedError);
    expect(sync.snapshot().authExpired).toBe(true);
    expect(pullMock).not.toHaveBeenCalled();
    sync.queueSync();
    expect(sync.snapshot().pendingChangeCount).toBe(0);
  });
});
