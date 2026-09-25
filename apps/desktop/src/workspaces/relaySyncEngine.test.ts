import {
  RelayApiVersionError,
  RelayOriginDivergedError,
  RelayUnauthorizedError,
  type PullWorkspaceFromRelayResult,
} from "@dohc/workspace-contracts/relay";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createRelaySyncEngine,
  type RelaySyncOperations,
} from "./relaySyncEngine";
import type { WorkspaceEngineCapture } from "./workspaceEngineCapture";

// The push/pull transport is injected; the capture is not over-mocked — its
// runRelaySync invokes the engine's real callback (the closure under test in
// relaySyncEngine.ts) and honors the commit-after-materialization contract,
// exactly like the real capture implementation.
const pushMock = vi.fn<RelaySyncOperations["push"]>();
const pullMock = vi.fn<RelaySyncOperations["pull"]>();
const recoverMock = vi.fn<RelaySyncOperations["recoverOrigin"]>();

function mockOperations(): RelaySyncOperations {
  return {
    push: pushMock,
    pull: pullMock,
    recoverOrigin: recoverMock,
  };
}

function pullResult(
  overrides: Partial<PullWorkspaceFromRelayResult> = {},
): PullWorkspaceFromRelayResult {
  return {
    fetched: 0,
    applied: 0,
    skipped: 0,
    conflictsOpened: 0,
    fastForwardedPaths: [],
    nextCursor: 0,
    ...overrides,
    sharingDeclined: overrides.sharingDeclined ?? [],
  };
}

function capture(): WorkspaceEngineCapture {
  return {
    // Mirrors the real capture: give the engine's push+pull closure a page
    // materializer. The relay operation commits each page after that callback
    // resolves.
    runRelaySync: vi.fn(
      async (task: (materializePage: () => Promise<void>) => Promise<unknown>) =>
        await task(async () => undefined),
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

function engine(input: {
  capture: WorkspaceEngineCapture;
  onChange?: () => void;
  syncSharedChannels?: () => Promise<boolean>;
  afterSuccessfulPull?: (pass: { recovered: boolean }) => Promise<void>;
  operations?: RelaySyncOperations;
}) {
  return createRelaySyncEngine({
    rootDir: "/tmp/workspace",
    relay: { baseUrl: "http://relay.test", token: "token" },
    capture: input.capture,
    onChange: input.onChange ?? vi.fn(),
    ...(input.syncSharedChannels ? { syncSharedChannels: input.syncSharedChannels } : {}),
    ...(input.afterSuccessfulPull
      ? { afterSuccessfulPull: input.afterSuccessfulPull }
      : {}),
    operations: input.operations ?? mockOperations(),
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
  pushMock.mockImplementation(async () => ({
    pushed: 0,
    originsPushed: [], ownerAdmissionPending: [],
    sharingDeclined: [],
  }));
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
  it("never invokes legacy TypeScript relay operations for a rooted daemon operation set", async () => {
    const operations: RelaySyncOperations = {
      push: vi.fn(async () => ({
        pushed: 1,
        originsPushed: [], ownerAdmissionPending: [],
        sharingDeclined: [],
      })),
      pull: vi.fn(async () => pullResult()),
      recoverOrigin: vi.fn(async () => ({
        oldOriginId: "old",
        newOriginId: "new",
        sharedPrefixLength: 0,
        preservedOps: 0,
      })),
    };
    const sync = engine({ capture: capture(), operations });

    await sync.start();

    expect(operations.push).toHaveBeenCalledOnce();
    expect(operations.pull).toHaveBeenCalledOnce();
    expect(pushMock).not.toHaveBeenCalled();
    expect(pullMock).not.toHaveBeenCalled();
    expect(recoverMock).not.toHaveBeenCalled();
    await sync.stop();
  });

  it("recovers injected origin divergence without crossing into TypeScript fallback", async () => {
    const operations: RelaySyncOperations = {
      push: vi
        .fn()
        .mockRejectedValueOnce(new RelayOriginDivergedError())
        .mockResolvedValue({
          pushed: 1,
          originsPushed: [], ownerAdmissionPending: [],
          sharingDeclined: [],
        }),
      pull: vi.fn(async () => pullResult()),
      recoverOrigin: vi.fn(async () => ({
        oldOriginId: "old",
        newOriginId: "new",
        sharedPrefixLength: 0,
        preservedOps: 0,
      })),
    };
    const sync = engine({ capture: capture(), operations });

    await sync.start();

    expect(operations.push).toHaveBeenCalledTimes(2);
    expect(operations.recoverOrigin).toHaveBeenCalledOnce();
    expect(operations.pull).toHaveBeenCalledOnce();
    expect(pushMock).not.toHaveBeenCalled();
    expect(pullMock).not.toHaveBeenCalled();
    expect(recoverMock).not.toHaveBeenCalled();
    await sync.stop();
  });

  it("runs post-pull work after cursor commit and contains its failure", async () => {
    const calls: string[] = [];
    const cap = capture();
    pullMock.mockImplementation(async (materializePage) => {
      await materializePage([]);
      calls.push("commit");
      return pullResult();
    });
    const afterSuccessfulPull = vi.fn(async () => {
      calls.push("after-pull");
      throw new Error("bookmark projection failed");
    });
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const sync = engine({ capture: cap, afterSuccessfulPull });

    await expect(sync.start()).resolves.toBeUndefined();
    expect(calls).toEqual(["commit", "after-pull"]);
    expect(afterSuccessfulPull).toHaveBeenCalledOnce();
    expect(sync.snapshot().lastSyncedAtMs).toBe(12345);
    expect(sync.snapshot().syncFailing).toBeFalsy();
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("post-pull work failed"),
      expect.any(Error),
    );

    errorSpy.mockRestore();
    await sync.stop();
  });

  it("does not run post-pull work when the relay pull fails", async () => {
    pullMock.mockRejectedValue(new Error("relay unavailable"));
    const afterSuccessfulPull = vi.fn(async () => undefined);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const sync = engine({ capture: capture(), afterSuccessfulPull });

    await expect(sync.start()).rejects.toThrow("relay unavailable");
    expect(afterSuccessfulPull).not.toHaveBeenCalled();

    errorSpy.mockRestore();
    await sync.stop();
  });

  it("runs the pull-start hook before each pull request, and its end whatever the pull does", async () => {
    const calls: string[] = [];
    const pullStarting = vi.fn(() => {
      calls.push("starting");
      return () => calls.push("ended");
    });
    pullMock.mockImplementationOnce(async () => {
      calls.push("pull");
      throw new Error("relay unavailable");
    });
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const sync = createRelaySyncEngine({
      rootDir: "/tmp/workspace",
      relay: { baseUrl: "http://relay.test", token: "token" },
      capture: capture(),
      onChange: vi.fn(),
      pullStarting,
      operations: mockOperations(),
      initialBackoffMs: 100,
    });

    await expect(sync.start()).rejects.toThrow("relay unavailable");
    expect(calls).toEqual(["starting", "pull", "ended"]);
    // The retry's push fails, so it never sends a pull and starts none.
    pushMock.mockRejectedValueOnce(new Error("offline"));
    await vi.advanceTimersByTimeAsync(100);
    expect(pushMock).toHaveBeenCalledTimes(2);
    expect(pullStarting).toHaveBeenCalledOnce();

    errorSpy.mockRestore();
    await sync.stop();
  });

  it("sends no pull request when the pull-start hook refuses, and still pushes", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const sync = createRelaySyncEngine({
      rootDir: "/tmp/workspace",
      relay: { baseUrl: "http://relay.test", token: "token" },
      capture: capture(),
      onChange: vi.fn(),
      pullStarting: () => {
        throw new Error("could not save the pull mark");
      },
      operations: mockOperations(),
    });

    await expect(sync.start()).rejects.toThrow("could not save the pull mark");
    expect(pushMock).toHaveBeenCalledOnce();
    expect(pullMock).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("relay sync failed"),
      expect.objectContaining({ message: "could not save the pull mark" }),
    );

    errorSpy.mockRestore();
    await sync.stop();
  });

  it("tells post-pull work when a pass succeeds after a failed one", async () => {
    pullMock.mockRejectedValueOnce(new Error("relay unavailable"));
    const afterSuccessfulPull = vi.fn(async (_pass: { recovered: boolean }) => undefined);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const sync = engine({ capture: capture(), afterSuccessfulPull });

    await expect(sync.start()).rejects.toThrow("relay unavailable");
    await vi.advanceTimersByTimeAsync(500);
    sync.queueSync();
    await vi.advanceTimersByTimeAsync(100);
    expect(afterSuccessfulPull.mock.calls).toEqual([[{ recovered: true }], [{ recovered: false }]]);

    errorSpy.mockRestore();
    await sync.stop();
  });

  it("refreshes shared channels on every pass and contains their failures (MU-C4)", async () => {
    const cap = capture();
    // The callback rejecting must not fail the workspace pass: shared-channel
    // refresh is best-effort (a revoked share can't wedge file sync).
    const syncSharedChannels = vi
      .fn<() => Promise<boolean>>()
      .mockRejectedValue(new Error("shared channel relay down"));
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const sync = engine({ capture: cap, syncSharedChannels });
    await sync.start();
    expect(syncSharedChannels).toHaveBeenCalledTimes(1);
    const snapshot = sync.snapshot();
    expect(snapshot.lastSyncedAtMs).toBe(12345);
    expect(snapshot.syncFailing).toBeFalsy();
    errorSpy.mockRestore();
    await sync.stop();
  });

  it("wires push then pull through the capture callback and folds conflicts into the snapshot", async () => {
    const cap = capture();
    const commit = vi.fn(async () => {});
    pullMock.mockImplementation(async (materializePage) => {
      await materializePage([]);
      await commit();
      return pullResult({ conflictsOpened: 2 });
    });
    const sync = engine({ capture: cap });
    await sync.start();

    expect(pushMock).toHaveBeenCalledOnce();
    expect(pullMock).toHaveBeenCalledOnce();
    expect(pushMock.mock.invocationCallOrder[0]!).toBeLessThan(
      pullMock.mock.invocationCallOrder[0]!,
    );
    // The pull result rode through the capture (which committed the cursor)
    // and its conflictsOpened landed in the snapshot.
    expect(commit).toHaveBeenCalledTimes(1);
    expect(sync.snapshot().conflictCount).toBe(2);
    expect(sync.snapshot().lastSyncedAtMs).toBe(12345);
  });

  it("keeps every sharing decline in the workspace snapshot", async () => {
    const result = pullResult();
    result.sharingDeclined = [
      {
        path: "notes/first.md",
        constraint: "MAX_YDOC_UPDATE_BYTES",
        limitBytes: 20,
        observedBytes: 21,
      },
      {
        path: "notes/second.md",
        constraint: "MAX_YDOC_UPDATE_BYTES",
        limitBytes: 20,
        observedBytes: 21,
      },
    ];
    pullMock
      .mockResolvedValueOnce(result)
      .mockResolvedValueOnce(result)
      .mockResolvedValueOnce(pullResult());
    const sync = engine({ capture: capture() });

    await sync.start();

    expect(sync.snapshot().sharingDeclined).toEqual(result.sharingDeclined);

    sync.queueSync();
    await vi.advanceTimersByTimeAsync(100);
    expect(pullMock).toHaveBeenCalledTimes(2);
    expect(sync.snapshot().sharingDeclined).toEqual(result.sharingDeclined);

    sync.queueSync();
    await vi.advanceTimersByTimeAsync(100);
    expect(pullMock).toHaveBeenCalledTimes(3);
    expect(sync.snapshot().sharingDeclined).toEqual([]);
    await sync.stop();
  });

  // 0P sync-hardening item 3: a RelayOriginDivergedError (restored/cloned
  // engine.db) is not a dead end — the pass recovers onto a fresh origin,
  // re-pushes, and completes normally instead of failing the pass.
  it("recovers and re-pushes when the origin diverged (restored/cloned engine.db)", async () => {
    const cap = capture();
    pushMock
      .mockRejectedValueOnce(new RelayOriginDivergedError())
      .mockResolvedValue({
        pushed: 1,
        originsPushed: ["origin_new"], ownerAdmissionPending: [],
        sharingDeclined: [],
      });
    const sync = engine({ capture: cap });
    await sync.start();

    // Divergence detected → recovery ran once → push retried → pull ran.
    expect(recoverMock).toHaveBeenCalledTimes(1);
    expect(pushMock).toHaveBeenCalledTimes(2);
    expect(pullMock).toHaveBeenCalledTimes(1);
    // The pass completed cleanly — no auth-expiry, no failure notice.
    expect(sync.snapshot().authExpired).toBe(false);
    expect(sync.snapshot().lastSyncedAtMs).toBe(12345);
  });

  it("recovers, re-pushes, and retries when pull finds a diverged local origin", async () => {
    pullMock
      .mockRejectedValueOnce(new RelayOriginDivergedError())
      .mockResolvedValue(pullResult());
    const sync = engine({ capture: capture() });
    await sync.start();

    expect(recoverMock).toHaveBeenCalledTimes(1);
    expect(pushMock).toHaveBeenCalledTimes(2);
    expect(pullMock).toHaveBeenCalledTimes(2);
    expect(recoverMock.mock.invocationCallOrder[0]!).toBeGreaterThan(
      pullMock.mock.invocationCallOrder[0]!,
    );
    expect(pushMock.mock.invocationCallOrder[1]!).toBeGreaterThan(
      recoverMock.mock.invocationCallOrder[0]!,
    );
    expect(pullMock.mock.invocationCallOrder[1]!).toBeGreaterThan(
      pushMock.mock.invocationCallOrder[1]!,
    );
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
      relay: { baseUrl: "http://relay.test", token: "token" },
      operations: mockOperations(),
      capture: cap,
      onChange: vi.fn(),
      countOpenConflicts: async () => openConflicts,
      debounceMs: 100,
      nowMs: () => 12345,
    });
    await sync.start();
    expect(sync.snapshot().conflictCount).toBe(2);

    // The user resolves both conflicts (locally or via a peer's replicated
    // resolution); the next pass must drop the count, not keep accumulating.
    openConflicts = 0;
    sync.queueSync();
    await vi.advanceTimersByTimeAsync(100);
    await vi.runAllTimersAsync();
    expect(sync.snapshot().conflictCount).toBe(0);
  });

  // 0P-C gate fix (High): a joining machine must never append ops to the
  // relay before its first successful pull — pushing first could seed
  // boilerplate into the remote workspace or mint conflicts against it.
  it("join bootstrap pulls before any push and only pushes after the first successful pull", async () => {
    const sync = createRelaySyncEngine({
      rootDir: "/tmp/workspace",
      relay: { baseUrl: "http://relay.test", token: "token" },
      operations: mockOperations(),
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
      relay: { baseUrl: "http://relay.test", token: "token" },
      operations: mockOperations(),
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

    // Backoff retry while still offline: still no push.
    await vi.advanceTimersByTimeAsync(500);
    expect(pullMock).toHaveBeenCalledTimes(2);
    expect(pushMock).not.toHaveBeenCalled();

    // Once a pull finally succeeds, normal push/reconcile resumes.
    fail = false;
    await vi.advanceTimersByTimeAsync(1000);
    await vi.runAllTimersAsync();
    expect(pushMock).toHaveBeenCalledTimes(1);
  });

  it("recovers a bootstrap pull divergence without pushing before the first pull succeeds", async () => {
    pullMock
      .mockRejectedValueOnce(new RelayOriginDivergedError())
      .mockResolvedValue(pullResult());
    const sync = createRelaySyncEngine({
      rootDir: "/tmp/workspace",
      relay: { baseUrl: "http://relay.test", token: "token" },
      operations: mockOperations(),
      capture: capture(),
      onChange: vi.fn(),
      joinBootstrap: true,
      debounceMs: 100,
      nowMs: () => 12345,
    });

    await sync.start();
    expect(recoverMock).toHaveBeenCalledTimes(1);
    expect(pullMock).toHaveBeenCalledTimes(2);
    expect(pushMock).not.toHaveBeenCalled();
  });

  it("queuePull runs a pass without recording a change and yields to a running, queued, or backing-off pass", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const cap = capture();
    const sync = engine({ capture: cap });
    sync.queuePull();
    await vi.advanceTimersByTimeAsync(0);
    expect(cap.runRelaySync).toHaveBeenCalledTimes(1);
    expect(sync.snapshot().pendingChangeCount).toBe(0);

    // A queued sync is about to pull, so the request adds no pass.
    sync.queueSync();
    sync.queuePull();
    await vi.runAllTimersAsync();
    expect(cap.runRelaySync).toHaveBeenCalledTimes(2);

    // A running pass pulls, so the request adds no pass either.
    let release!: () => void;
    pullMock.mockImplementationOnce(async () => {
      await new Promise<void>((resolve) => { release = resolve; });
      return pullResult();
    });
    sync.queuePull();
    await vi.advanceTimersByTimeAsync(0);
    expect(cap.runRelaySync).toHaveBeenCalledTimes(3);
    sync.queuePull();
    release();
    await vi.runAllTimersAsync();
    expect(cap.runRelaySync).toHaveBeenCalledTimes(3);

    // A failed pass backs off; the request does not shorten the wait.
    pullMock.mockRejectedValueOnce(new Error("network"));
    sync.queuePull();
    await vi.advanceTimersByTimeAsync(0);
    expect(cap.runRelaySync).toHaveBeenCalledTimes(4);
    sync.queuePull();
    await vi.advanceTimersByTimeAsync(499);
    expect(cap.runRelaySync).toHaveBeenCalledTimes(4);
    await vi.runAllTimersAsync();
    expect(cap.runRelaySync).toHaveBeenCalledTimes(5);
    await sync.stop();
    errorSpy.mockRestore();
  });

  it("queuePull pulls within one debounce interval of each poll while local writes keep restarting the debounce", async () => {
    const cap = capture();
    const sync = engine({ capture: cap });
    sync.queueSync();
    for (let poll = 1; poll <= 3; poll += 1) {
      sync.queuePull();
      // A write every 60 ms keeps the 100 ms debounce from ever firing.
      for (let write = 0; write < 5; write += 1) {
        sync.queueSync();
        await vi.advanceTimersByTimeAsync(60);
      }
      expect(cap.runRelaySync).toHaveBeenCalledTimes(poll);
    }
    // The writes stop, and the debounced pass pushes the rest.
    await vi.advanceTimersByTimeAsync(100);
    expect(cap.runRelaySync).toHaveBeenCalledTimes(4);
    expect(sync.snapshot().pendingChangeCount).toBe(0);
    await sync.stop();
  });

  it("queuePull announces its pass only when it applied ops or changed what the snapshot shows", async () => {
    const onChange = vi.fn();
    const cap = capture();
    const syncSharedChannels = vi.fn<() => Promise<boolean>>(async () => false);
    const sync = engine({ capture: cap, onChange, syncSharedChannels });
    sync.queuePull();
    await vi.advanceTimersByTimeAsync(0);
    expect(cap.runRelaySync).toHaveBeenCalledTimes(1);
    expect(onChange).not.toHaveBeenCalled();

    pullMock.mockResolvedValueOnce(pullResult({ fetched: 1, applied: 1 }));
    sync.queuePull();
    await vi.advanceTimersByTimeAsync(0);
    expect(onChange).toHaveBeenCalledOnce();

    // The shared-channel pass told the renderer itself, and the renderer read
    // "Syncing". The end is announced, so the status does not stay there.
    onChange.mockClear();
    syncSharedChannels.mockImplementationOnce(async () => {
      expect(sync.snapshot().syncing).toBe(true);
      return true;
    });
    sync.queuePull();
    await vi.advanceTimersByTimeAsync(0);
    expect(onChange).toHaveBeenCalledOnce();
    expect(sync.snapshot().syncing).toBe(false);

    // A write mid-pass announced `syncing`, so the end is announced too.
    onChange.mockClear();
    let release!: () => void;
    pullMock.mockImplementationOnce(async () => {
      await new Promise<void>((resolve) => { release = resolve; });
      return pullResult();
    });
    sync.queuePull();
    await vi.advanceTimersByTimeAsync(0);
    sync.queueSync();
    expect(onChange).toHaveBeenCalledOnce();
    release();
    await vi.advanceTimersByTimeAsync(0);
    expect(onChange).toHaveBeenCalledTimes(2);
    expect(sync.snapshot().syncing).toBe(false);
    await sync.stop();
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

  it.each(["push", "pull"] as const)(
    "stops syncing and names the side to update when the relay refuses this API version on %s",
    async (step) => {
      (step === "push" ? pushMock : pullMock).mockImplementation(async () => {
        throw new RelayApiVersionError("app");
      });
      const changes = vi.fn();
      const sync = engine({ capture: capture(), onChange: changes });
      await expect(sync.start()).rejects.toBeInstanceOf(RelayApiVersionError);
      expect(sync.snapshot().updateRequired).toBe("app");
      expect(sync.snapshot().syncFailing).toBeUndefined();
      expect(changes).toHaveBeenCalled();
      const calls = pushMock.mock.calls.length + pullMock.mock.calls.length;
      // No backoff retry and no new pass: retrying cannot help until dohc updates.
      sync.queueSync();
      await vi.advanceTimersByTimeAsync(10_000);
      expect(pushMock.mock.calls.length + pullMock.mock.calls.length).toBe(calls);
      await sync.stop();
    },
  );

  it("replaces an earlier sync failure with the update the server asks for", async () => {
    let refuse = false;
    pullMock.mockImplementation(async () => {
      if (refuse) throw new RelayApiVersionError("server");
      throw new Error("network");
    });
    const sync = engine({ capture: capture() });
    sync.queueSync();
    await vi.advanceTimersByTimeAsync(100);
    await vi.advanceTimersByTimeAsync(500);
    await vi.advanceTimersByTimeAsync(1000);
    expect(sync.snapshot().syncFailing).toBe(true);
    refuse = true;
    await vi.advanceTimersByTimeAsync(2000);
    expect(sync.snapshot().updateRequired).toBe("server");
    expect(sync.snapshot().syncFailing).toBeUndefined();
    await sync.stop();
  });
});

it("keeps owner admission pending after a successful pull and clears it only after publication", async () => {
  const pending={workspaceId:"workspace",originId:"origin",originSeq:4,versionId:"main",objectId:"object",path:"notes.md"};
  pushMock.mockResolvedValueOnce({pushed:0,originsPushed:[],sharingDeclined:[],ownerAdmissionPending:[pending]});
  const sync=engine({capture:capture()});await sync.start();
  expect(sync.snapshot().ownerAdmissionPending).toEqual([pending]);
  expect(sync.snapshot().pendingChangeCount).toBe(1);
  await vi.advanceTimersByTimeAsync(500);
  expect(sync.snapshot().ownerAdmissionPending).toEqual([]);
  expect(sync.snapshot().pendingChangeCount).toBe(0);
  await sync.stop();
});
