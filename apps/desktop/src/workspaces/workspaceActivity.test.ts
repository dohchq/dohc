import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  closeWorkspaceActivityAndRelay,
  createWorkspaceActivity as createPhysicalWorkspaceActivity,
  WorkspaceActivityState,
  type ActivityWorkspace,
  type WorkspaceCaptureHooks,
} from "./workspaceActivity";
import { createInMemoryWorkspaceActivity as createWorkspaceActivity } from "./workspaceActivity.testSupport";
import { captureForWorkspace } from "./engineCaptureGate";
import type { EngineWorkspaceSessions } from "@dohc/workspace-engine-client/daemon";
import { createTestScratch } from "./testTemp";

// The shared-view pin drives the real gate, which never reaches the engine
// for a shared view — these sessions prove it by throwing on any use.
const engineUnreachableSessions = new Proxy({} as EngineWorkspaceSessions, {
  get(_target, property) {
    throw new Error(
      `workspaceActivity.test: sessions.${String(property)} was used, but a shared view must not reach the engine`,
    );
  },
});

// The legacy change-set read surface
// (listChangeSets/readChangeSet) is gone from this layer — engine moments
// are the only history. These tests cover what remains: the capture hooks
// and the honest no-recorder status for a workspace without a capture.

let root: string;

beforeEach(async () => {
  root = await createTestScratch("dohc-activity-");
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const ATTACHMENT_ID = Symbol("activity-test-attachment");

function workspace(): ActivityWorkspace {
  return {
    workspaceId: "activity-test",
    rootPath: root,
    attachmentId: ATTACHMENT_ID,
    kind: "personal",
    mode: "local-first",
  };
}

describe("workspaceActivity capture hooks", () => {
  it("keeps an old attachment close from stopping its successor", async () => {
    const successorRoot = await createTestScratch("dohc-activity-successor-");
    const oldCaptureStop = vi.fn(async () => undefined);
    const successorCaptureStop = vi.fn(async () => undefined);
    const activity = createPhysicalWorkspaceActivity(() => {}, {
      captureFor: (candidate) => ({
        shareView: false,
        capture: {
          start: vi.fn(),
          settleAndCloseAllLiveSessions: vi.fn(async () => undefined),
          stop:
            candidate.rootPath === root
              ? oldCaptureStop
              : successorCaptureStop,
        } as never,
      }),
    });
    const oldState = new WorkspaceActivityState();
    const successorState = new WorkspaceActivityState();
    const oldWorkspace = workspace();
    const successorWorkspace = {
      ...oldWorkspace,
      rootPath: successorRoot,
    };
    try {
      await activity.open(oldWorkspace, oldState);
      await activity.open(successorWorkspace, successorState);

      await activity.close(oldWorkspace, oldState);

      expect(oldCaptureStop).toHaveBeenCalledOnce();
      expect(successorCaptureStop).not.toHaveBeenCalled();
      expect(activity.isOpen(successorState)).toBe(true);
    } finally {
      await activity.stop(successorState);
      await rm(successorRoot, { recursive: true, force: true });
    }
  });

  it("publishes settled watcher paths with the workspace activity", async () => {
    const notify = vi.fn();
    const activity = createWorkspaceActivity(notify, {
      captureFor: () => ({ capture: null, shareView: false }),
    });
    await activity.open(workspace());
    notify.mockClear();

    await writeFile(join(root, "changed.md"), "changed");

    await vi.waitFor(() => {
      expect(notify).toHaveBeenCalledWith({
        workspaceId: "activity-test",
        paths: ["changed.md"],
      });
    });
    await activity.stopAll();
  });

  it("forwards the agent-run slot to the open workspace's capture", async () => {
    const setActiveAgentRun = vi.fn(async () => undefined);
    const activity = createWorkspaceActivity(() => {}, {
      captureFor: () => ({
        shareView: false,
        capture: {
          start: vi.fn(),
          setActiveAgentRun,
          settleAndCloseAllLiveSessions: vi.fn(async () => undefined),
          stop: vi.fn(async () => undefined),
        } as never,
      }),
    });
    await activity.open(workspace());
    expect(activity.hasAgentRun("activity-test")).toBe(false);

    const run = { agentId: "dohc-mcp", onBehalfOf: "local", agentRunId: "run-1" };
    await activity.setAgentRun("activity-test", run);
    expect(setActiveAgentRun).toHaveBeenLastCalledWith(run);
    expect(activity.hasAgentRun("activity-test")).toBe(true);
    await activity.setAgentRun("activity-test", null);
    expect(setActiveAgentRun).toHaveBeenLastCalledWith(null);
    expect(activity.hasAgentRun("activity-test")).toBe(false);
    await activity.stopAll();
  });

  it("claims the single attribution slot atomically and clears by owner run id", async () => {
    const setActiveAgentRun = vi.fn(async () => undefined);
    const activity = createWorkspaceActivity(() => {}, {
      captureFor: () => ({
        shareView: false,
        capture: {
          start: vi.fn(),
          setActiveAgentRun,
          settleAndCloseAllLiveSessions: vi.fn(async () => undefined),
          stop: vi.fn(async () => undefined),
        } as never,
      }),
    });
    await activity.open(workspace());
    const first = {
      agentId: "chat-runner",
      onBehalfOf: "local",
      agentRunId: "run-1",
    };
    const second = {
      agentId: "panel",
      onBehalfOf: "local",
      agentRunId: "run-2",
    };
    expect(await activity.claimAgentRun("activity-test", first)).toBe(true);
    expect(await activity.claimAgentRun("activity-test", second)).toBe(false);
    await activity.clearAgentRun("activity-test", second.agentRunId);
    expect(setActiveAgentRun).toHaveBeenLastCalledWith(first);
    expect(activity.hasAgentRun("activity-test")).toBe(true);
    await activity.clearAgentRun("activity-test", first.agentRunId);
    expect(setActiveAgentRun).toHaveBeenLastCalledWith(null);
    expect(activity.hasAgentRun("activity-test")).toBe(false);
    expect(await activity.claimAgentRun("activity-test", second)).toBe(true);
    await activity.stopAll();
  });
});

describe("workspaceActivity history-off status", () => {
  it("reports no cause when captureFor yields no capture and names none", async () => {
    const activity = createWorkspaceActivity(() => {}, {
      captureFor: () => ({ capture: null, shareView: false }),
    });
    const status = await activity.open(workspace());
    expect(status.historyRecordingUnavailable).toBe(false);
    expect(status.historyShareView).toBe(false);
    // No capture also means no versions surface.
    expect(activity.engineCaptureFor("activity-test")).toBeNull();
    await activity.stopAll();
  });

  // A shared view's null capture is a capability — the view is fed by
  // the share's pull and never records here. Without this cause on the
  // status, the notice blames a Settings toggle nobody touched. Wired
  // through the real gate, so the share rule and the status thread are
  // pinned together: deleting either breaks this test.
  it("separates a shared view's null capture from a failed build", async () => {
    const activity = createWorkspaceActivity(() => {}, {
      captureFor: (w, hooks) =>
        captureForWorkspace(
          {
            workspaceId: w.workspaceId,
            rootPath: w.rootPath,
            attachmentId: w.attachmentId,
            shareView: true,
          },
          hooks,
          engineUnreachableSessions,
        ),
    });
    const status = await activity.open(workspace());
    expect(status.historyShareView).toBe(true);
    expect(activity.getStatus("activity-test").historyShareView).toBe(true);
    // A capability, not a failure.
    expect(status.historyRecordingUnavailable).toBe(false);
    await activity.stopAll();
  });

  // A capture build that threw leaves an empty recorder, and the cause is a
  // failure. The status says so, so the notice can.
  it("marks a failed capture build unavailable", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const activity = createWorkspaceActivity(() => {}, {
      captureFor: () => {
        throw new Error("engine store unavailable");
      },
    });
    const status = await activity.open(workspace());
    expect(status.historyRecordingUnavailable).toBe(true);
    expect(
      activity.getStatus("activity-test").historyRecordingUnavailable,
    ).toBe(true);
    expect(activity.engineCaptureFor("activity-test")).toBeNull();
    // The failure itself stays developer-facing, in the log.
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
    await activity.stopAll();
  });

  it("does not raise the history-off status before open or without a captureFor gate", async () => {
    const activity = createWorkspaceActivity(() => {});
    // Unknown/unopened workspace: status is derivable but never claims
    // history is off (nothing is known yet).
    expect(activity.getStatus("activity-test").historyRecordingUnavailable).toBe(false);
    const status = await activity.open(workspace());
    // No captureFor option at all (test/legacy wiring): stays false.
    expect(status.historyRecordingUnavailable).toBe(false);
    await activity.stopAll();
  });
});

describe("workspaceActivity cloud sync nudge", () => {
  it("queueCloudSync reaches the workspace's engine and no-ops everywhere else", async () => {
    let queued = 0;
    const engine = {
      start: async () => {},
      queueSync: () => {
        queued += 1;
      },
      queuePull: () => {},
      snapshot: () => ({
        syncing: false,
        lastSyncedAtMs: null,
        pendingChangeCount: 0,
        conflictCount: 0,
        authExpired: false,
        sharingDeclined: [
          {
            path: "notes/large.md",
            constraint: "MAX_YDOC_UPDATE_BYTES",
            limitBytes: 262_144,
            observedBytes: 280_001,
          },
        ],
      }),
      stop: async () => {},
    };
    const activity = createWorkspaceActivity(() => {}, {
      engineFor: () => engine,
      cloudStateFor: () => ({ enabled: true, connected: true }),
    });
    // Before open: silently nothing (a resolve on an unopened workspace
    // cannot happen, but the method must never throw).
    activity.queueCloudSync("activity-test");
    expect(queued).toBe(0);

    const status = await activity.open(workspace());
    expect(status.sharingDeclined).toEqual(engine.snapshot().sharingDeclined);
    activity.queueCloudSync("activity-test");
    expect(queued).toBe(1);
    await activity.stopAll();
  });

  // Failed-join rollback (0P-C gate fix): close() tears down exactly one
  // workspace — engine stopped, entry forgotten — leaving others untouched.
  it("close stops and forgets a single workspace", async () => {
    let stopped = 0;
    const engine = {
      start: async () => {},
      queueSync: () => {},
      queuePull: () => {},
      snapshot: () => ({
        syncing: false,
        lastSyncedAtMs: null,
        pendingChangeCount: 0,
        conflictCount: 0,
        authExpired: false,
        sharingDeclined: [],
      }),
      stop: async () => {
        stopped += 1;
      },
    };
    const activity = createWorkspaceActivity(() => {}, {
      engineFor: () => engine,
      cloudStateFor: () => ({ enabled: true, connected: true }),
    });
    await activity.open(workspace());
    await activity.close("activity-test");
    expect(stopped).toBe(1);
    // The entry is gone: status derives from nothing and re-open works.
    expect(activity.getStatus("activity-test").conflictCount).toBe(0);
    await activity.close("activity-test"); // idempotent, never throws
    await activity.stopAll();
  });

  it("stops the capture and forgets the entry when an engine stop rejects", async () => {
    const stopError = new Error("engine stop failed");
    const firstCaptureStop = vi.fn(async () => undefined);
    const secondCaptureStop = vi.fn(async () => undefined);
    let captureBuilds = 0;
    let engineBuilds = 0;
    const activity = createWorkspaceActivity(() => {}, {
      captureFor: () => {
        captureBuilds += 1;
        return {
          capture: {
            start: vi.fn(),
            captureBatch: vi.fn(),
            settleAndCloseAllLiveSessions: vi.fn(async () => undefined),
            stop: captureBuilds === 1 ? firstCaptureStop : secondCaptureStop,
          } as never,
          shareView: false,
        };
      },
      engineFor: () => {
        engineBuilds += 1;
        return {
          start: async () => undefined,
          queueSync: () => undefined, queuePull: () => undefined,
          snapshot: () => ({
            syncing: false,
            lastSyncedAtMs: null,
            pendingChangeCount: 0,
            conflictCount: 0,
            authExpired: false,
            sharingDeclined: [],
          }),
          stop: async () => {
            if (engineBuilds === 1) throw stopError;
          },
        };
      },
      cloudStateFor: () => ({ enabled: true, connected: true }),
    });
    await activity.open(workspace());

    await expect(activity.close("activity-test")).rejects.toBe(stopError);

    expect(firstCaptureStop).toHaveBeenCalledOnce();
    expect(activity.listOpenWorkspaceIds()).toEqual([]);
    await expect(activity.open(workspace())).resolves.toBeDefined();
    expect(activity.listOpenWorkspaceIds()).toEqual(["activity-test"]);
    expect(captureBuilds).toBe(2);
    await activity.close("activity-test");
    expect(secondCaptureStop).toHaveBeenCalledOnce();
  });

  it("keeps a refused status visible when close fails before any reopen", async () => {
    let hooks: WorkspaceCaptureHooks | null = null;
    let activity!: ReturnType<typeof createWorkspaceActivity>;
    const statusesSeenByRenderer: Array<string | null | undefined> = [];
    const closeError = new Error("engine stop failed");
    activity = createWorkspaceActivity(
      () => {
        statusesSeenByRenderer.push(
          activity.getStatus("activity-test").engineStoreRefused,
        );
      },
      {
        captureFor: (_workspace, captureHooks) => {
          hooks = captureHooks;
          return {
            capture: {
              start: vi.fn(),
              captureBatch: vi.fn(),
              settleAndCloseAllLiveSessions: vi.fn(async () => undefined),
              stop: vi.fn(async () => undefined),
            } as never,
            shareView: false,
          };
        },
        engineFor: () => ({
          start: async () => undefined,
          queueSync: () => undefined, queuePull: () => undefined,
          snapshot: () => ({
            syncing: false,
            lastSyncedAtMs: null,
            pendingChangeCount: 0,
            conflictCount: 0,
            authExpired: false,
            sharingDeclined: [],
          }),
          stop: async () => {
            throw closeError;
          },
        }),
        cloudStateFor: () => ({ enabled: true, connected: true }),
      },
    );
    await activity.open(workspace());
    hooks!.onCaptureOutcome("unsupported-fingerprint");
    statusesSeenByRenderer.length = 0;

    await expect(
      activity.close("activity-test", { preserveStatus: true }),
    ).rejects.toBe(closeError);

    expect(activity.listOpenWorkspaceIds()).toEqual([]);
    expect(activity.getStatus("activity-test").engineStoreRefused).toBe(
      "unsupported-fingerprint",
    );
    expect(statusesSeenByRenderer).toEqual(["unsupported-fingerprint"]);
    await activity.stopAll();
  });

  it("keeps the refused status through a successful close until reopen completes", async () => {
    let hooks: WorkspaceCaptureHooks | null = null;
    let finishReopen: () => void = () => {
      throw new Error("Reopen did not start.");
    };
    let captureBuilds = 0;
    const activity = createWorkspaceActivity(() => {}, {
      captureFor: (_workspace, captureHooks) => {
        hooks = captureHooks;
        captureBuilds += 1;
        if (captureBuilds === 2) {
          return new Promise((resolve) => {
            finishReopen = () =>
              resolve({
                capture: {
                  start: vi.fn(),
                  captureBatch: vi.fn(),
                  settleAndCloseAllLiveSessions: vi.fn(async () => undefined),
                  stop: vi.fn(async () => undefined),
                } as never,
                shareView: false,
              });
          });
        }
        return {
          capture: {
            start: vi.fn(),
            captureBatch: vi.fn(),
            settleAndCloseAllLiveSessions: vi.fn(async () => undefined),
            stop: vi.fn(async () => undefined),
          } as never,
          shareView: false,
        };
      },
    });
    await activity.open(workspace());
    hooks!.onCaptureOutcome("unsupported-fingerprint");

    await activity.close("activity-test", { preserveStatus: true });
    expect(activity.getStatus("activity-test").engineStoreRefused).toBe(
      "unsupported-fingerprint",
    );

    const reopening = activity.open(workspace());
    expect(activity.getStatus("activity-test").engineStoreRefused).toBe(
      "unsupported-fingerprint",
    );
    finishReopen();
    await reopening;

    expect(activity.getStatus("activity-test").engineStoreRefused).toBeUndefined();
    await activity.close("activity-test");
    expect(activity.getStatus("activity-test").engineStoreRefused).toBeUndefined();
  });

  it("keeps live-session retirement generations current across preserved closes and reopens", async () => {
    const retireLiveSessions = vi.fn(async () => undefined);
    const notify = vi.fn();
    const activity = createWorkspaceActivity(notify, {
      captureFor: () => ({
        capture: {
          start: vi.fn(),
          captureBatch: vi.fn(),
          settleAndCloseAllLiveSessions: retireLiveSessions,
          stop: vi.fn(async () => undefined),
        } as never,
        shareView: false,
      }),
    });

    expect((await activity.open(workspace())).liveSessionsGeneration).toBe(0);
    notify.mockClear();
    await activity.close("activity-test", { preserveStatus: true });
    expect(retireLiveSessions).toHaveBeenCalledOnce();
    expect(activity.getStatus("activity-test").liveSessionsGeneration).toBe(1);
    // The close notifies with its own workspace as the scope — a wrong or
    // missing workspaceId would repaint other workspaces' windows.
    expect(notify).toHaveBeenCalledExactlyOnceWith({
      workspaceId: "activity-test",
    });

    expect((await activity.open(workspace())).liveSessionsGeneration).toBe(1);
    notify.mockClear();
    await activity.close("activity-test", {
      preserveStatus: true,
      notify: false,
    });
    expect(retireLiveSessions).toHaveBeenCalledTimes(2);
    expect(activity.getStatus("activity-test").liveSessionsGeneration).toBe(2);
    expect(notify).not.toHaveBeenCalled();
    await activity.stopAll();
  });

  it("logs a relay close failure after local activity closes without rejecting", async () => {
    const relayError = new Error("relay close failed");
    const onRelayCloseError = vi.fn();
    const order: string[] = [];

    await expect(
      closeWorkspaceActivityAndRelay({
        closeActivity: async () => {
          order.push("local");
        },
        closeRelay: async () => {
          order.push("relay");
          throw relayError;
        },
        onRelayCloseError,
      }),
    ).resolves.toBeUndefined();

    expect(order).toEqual(["local", "relay"]);
    expect(onRelayCloseError).toHaveBeenCalledWith(relayError);
  });

  it("waits for the watcher and engine before stopping the capture", async () => {
    let finishEngineStop: () => void = () => {
      throw new Error("Engine stop did not start.");
    };
    const engineStopStarted = vi.fn();
    const retireLiveSessions = vi.fn(async () => undefined);
    const captureStop = vi.fn(async () => undefined);
    const activity = createWorkspaceActivity(() => {}, {
      captureFor: () => ({
        capture: {
          start: vi.fn(),
          captureBatch: vi.fn(),
          settleAndCloseAllLiveSessions: retireLiveSessions,
          stop: captureStop,
        } as never,
        shareView: false,
      }),
      engineFor: () => ({
        start: async () => undefined,
        queueSync: () => undefined, queuePull: () => undefined,
        snapshot: () => ({
          syncing: false,
          lastSyncedAtMs: null,
          pendingChangeCount: 0,
          conflictCount: 0,
          authExpired: false,
          sharingDeclined: [],
        }),
        stop: () => {
          engineStopStarted();
          return new Promise<void>((resolve) => {
            finishEngineStop = resolve;
          });
        },
      }),
      cloudStateFor: () => ({ enabled: true, connected: true }),
    });
    await activity.open(workspace());

    const closing = activity.close("activity-test");
    await vi.waitFor(() => expect(engineStopStarted).toHaveBeenCalledOnce());
    expect(retireLiveSessions).not.toHaveBeenCalled();
    expect(captureStop).not.toHaveBeenCalled();

    finishEngineStop();
    await closing;
    expect(retireLiveSessions).toHaveBeenCalledOnce();
    expect(captureStop).toHaveBeenCalledOnce();
    expect(retireLiveSessions.mock.invocationCallOrder[0]).toBeLessThan(
      captureStop.mock.invocationCallOrder[0]!,
    );
  });

  // A shared view has no recorder, so its refresh reports the store's
  // refusal. The status carries it like a capture's, and only a shared view
  // takes it: a workspace with a recorder hears its store through capture.
  it("puts a shared view's store refusal on its status", async () => {
    const notify = vi.fn();
    const activity = createWorkspaceActivity(notify, {
      captureFor: () => ({ shareView: true, capture: null }),
    });
    await activity.open(workspace());
    notify.mockClear();
    activity.recordShareViewStoreRefusal("activity-test", "migrated-by-newer-build", "a newer build ran migration 5 (next)");
    const refused = activity.getStatus("activity-test");
    expect(refused.historyShareView).toBe(true);
    expect(refused.engineStoreRefused).toBe("migrated-by-newer-build");
    expect(refused.engineStoreRefusedDetail).toBe("a newer build ran migration 5 (next)");
    expect(notify).toHaveBeenCalledOnce();
    activity.recordShareViewStoreRefusal("activity-test", "migrated-by-newer-build", "a newer build ran migration 5 (next)");
    expect(notify).toHaveBeenCalledOnce();
    activity.recordShareViewStoreRefusal("activity-test", null, null);
    expect(activity.getStatus("activity-test").engineStoreRefused).toBeUndefined();
    await activity.stopAll();

    const owned = createWorkspaceActivity(vi.fn(), {
      captureFor: () => ({ shareView: false, capture: null }),
    });
    await owned.open(workspace());
    owned.recordShareViewStoreRefusal("activity-test", "migrated-by-newer-build", null);
    expect(owned.getStatus("activity-test").engineStoreRefused).toBeUndefined();
    await owned.stopAll();
  });

  // The engine's own words for a refusal ride along, so a report can carry
  // them without the log, and leave with the refusal.
  it("carries the refusal detail on the status", async () => {
    let hooks: WorkspaceCaptureHooks | null = null;
    const activity = createWorkspaceActivity(vi.fn(), {
      captureFor: (_workspace, captureHooks) => {
        hooks = captureHooks;
        return {
          shareView: false,
          capture: {
            start: vi.fn(),
            captureBatch: vi.fn(),
            settleAndCloseAllLiveSessions: vi.fn(async () => undefined),
            stop: vi.fn(async () => undefined),
          } as never,
        };
      },
    });
    await activity.open(workspace());
    hooks!.onCaptureOutcome("migration-failed", "migration v2-baseline was applied from a different definition than this build's");
    const refused = activity.getStatus("activity-test");
    expect(refused.engineStoreRefused).toBe("migration-failed");
    expect(refused.engineStoreRefusedDetail).toBe("migration v2-baseline was applied from a different definition than this build's");
    hooks!.onCaptureOutcome(null);
    expect(activity.getStatus("activity-test").engineStoreRefusedDetail).toBeUndefined();
    await activity.stopAll();
  });

  // A refused engine store rides the capture outcome into the status
  // the notice center reads, transition-only like the capture-failed flag —
  // a persistently refused store re-reports the same code on every pass and
  // must not re-notify.
  it("publishes a store refusal, clears it on recovery, and notifies only on transitions", async () => {
    let hooks: WorkspaceCaptureHooks | null = null;
    const notify = vi.fn();
    const activity = createWorkspaceActivity(notify, {
      captureFor: (_workspace, captureHooks) => {
        hooks = captureHooks;
        return {
          shareView: false,
          capture: {
            start: vi.fn(),
            captureBatch: vi.fn(),
            settleAndCloseAllLiveSessions: vi.fn(async () => undefined),
            stop: vi.fn(async () => undefined),
          } as never,
        };
      },
    });
    await activity.open(workspace());
    expect(activity.getStatus("activity-test").engineStoreRefused).toBeUndefined();

    notify.mockClear();
    hooks!.onCaptureOutcome("unsupported-fingerprint");
    const refused = activity.getStatus("activity-test");
    expect(refused.engineStoreRefused).toBe("unsupported-fingerprint");
    expect(refused.historyCaptureFailed).toBe(true);
    expect(notify).toHaveBeenCalledTimes(1);

    // The same refusal again is not news.
    hooks!.onCaptureOutcome("unsupported-fingerprint");
    expect(notify).toHaveBeenCalledTimes(1);

    // A pass that reached the store clears the refusal with the failure.
    hooks!.onCaptureOutcome(null);
    expect(activity.getStatus("activity-test").engineStoreRefused).toBeUndefined();
    expect(notify).toHaveBeenCalledTimes(2);

    hooks!.onCaptureOutcome("other");
    const otherFailure = activity.getStatus("activity-test");
    expect(otherFailure.historyCaptureFailed).toBe(true);
    expect(otherFailure.engineStoreRefused).toBeNull();
    expect(notify).toHaveBeenCalledTimes(3);
    // Every transition names its workspace — a scope-free notify here would
    // repaint every window.
    for (const call of notify.mock.calls) {
      expect(call).toEqual([{ workspaceId: "activity-test" }]);
    }
    await activity.stopAll();
  });
});
