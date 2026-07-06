import {
  RelayUnauthorizedError,
  pullWorkspaceFromRelay,
  pushWorkspaceToRelay,
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
  };
});

const pushMock = vi.mocked(pushWorkspaceToRelay);
const pullMock = vi.mocked(pullWorkspaceFromRelay);

function pullResult(
  overrides: Partial<PullWorkspaceFromRelayResult> = {},
): PullWorkspaceFromRelayResult {
  return {
    fetched: 0,
    applied: 0,
    skipped: 0,
    conflictsOpened: 0,
    pendingConflictResolves: 0,
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
  pushMock.mockImplementation(async () => ({ pushed: 0, originsPushed: [] }));
  pullMock.mockImplementation(async () => pullResult());
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
