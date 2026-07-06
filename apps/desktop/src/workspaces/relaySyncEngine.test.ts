import { RelayUnauthorizedError } from "@dohc/workspace-engine";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRelaySyncEngine } from "./relaySyncEngine";
import type { WorkspaceEngineCapture } from "./workspaceEngineCapture";

function capture(
  task: () => Promise<{ fastForwardedPaths: [] }> = async () => ({ fastForwardedPaths: [] }),
): WorkspaceEngineCapture {
  return {
    runRelaySync: vi.fn(task),
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
});

afterEach(() => {
  vi.useRealTimers();
});

describe("relaySyncEngine", () => {
  it("debounces queued sync and serializes passes through capture", async () => {
    const calls: string[] = [];
    let releaseFirst!: () => void;
    const first = new Promise<{ fastForwardedPaths: [] }>((resolve) => {
      releaseFirst = () => resolve({ fastForwardedPaths: [] });
    });
    const cap = capture(
      vi
        .fn()
        .mockImplementationOnce(async () => {
          calls.push("first");
          return first;
        })
        .mockImplementationOnce(async () => {
          calls.push("second");
          return { fastForwardedPaths: [] };
        }),
    );
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
    const cap = capture(async () => {
      if (fail) throw new Error("network");
      return { fastForwardedPaths: [] };
    });
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
    const cap = capture(async () => {
      if (failuresRemaining > 0) {
        failuresRemaining -= 1;
        throw new Error("network");
      }
      return { fastForwardedPaths: [] };
    });
    const sync = engine({ capture: cap, onChange: changes });
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
    const cap = capture(async () => {
      throw new RelayUnauthorizedError();
    });
    const sync = engine({ capture: cap });
    await expect(sync.start()).rejects.toBeInstanceOf(RelayUnauthorizedError);
    expect(sync.snapshot().authExpired).toBe(true);
    sync.queueSync();
    expect(sync.snapshot().pendingChangeCount).toBe(0);
  });
});
