import { createFolderAppDetection } from "./folderAppDetection";
import { settleYDocsAfterFileObservation } from "./workspaceActivity";
import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  closeWorkspaceActivityAndRelay,
  createWorkspaceActivity as createPhysicalWorkspaceActivity,
  WorkspaceActivityState,
  type ActivityWorkspace,
  type WorkspaceCaptureHooks,
} from "./workspaceActivity";
import { createInMemoryWorkspaceActivity as createWorkspaceActivity, idleObservation } from "./workspaceActivity.testSupport";
import type { WorkspaceObservationCallbacks } from "./workspaceFileObservation";
import { observeWorkspaceFiles } from "./workspaceFileObservation";
import type { CloudSyncFailure } from "./relaySyncEngine";
import { captureForWorkspace } from "./engineCaptureGate";
import type { EngineWorkspaceSessions } from "@dohc/workspace-engine-client/daemon";
import { createTestScratch } from "./testTemp";
import type { ActiveAgentRun } from "../agents/activeAgentRun";
import type { AgentRunStateEvent } from "../ipc/bridgeContract";

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
  it("pushes held status changes without generic activity and discards a retired capture's update", async () => {
    let hooks!: WorkspaceCaptureHooks;
    const notify = vi.fn();
    const onHeldFiles = vi.fn();
    const activity = createWorkspaceActivity(notify, {
      onHeldFiles,
      captureFor: (_workspace, value) => {
        hooks = value;
        return { shareView: false, capture: { start: vi.fn(), stop: vi.fn(async () => {}), settleAndCloseAllLiveSessions: vi.fn(async () => {}) } as never };
      },
    });
    const held = { workspaceId: "activity-test", sourceVersionId: "main", objectId: "held", path: "held.md",
      observedSha256: "digest", observedSize: 4, reason: "ydoc-resolution-not-representable" as const,
      observedAtMs: 1, attemptCount: 1, retryRequested: false };
    await activity.open(workspace());
    notify.mockClear();
    hooks.onHeldFiles([held]);
    expect(activity.getStatus("activity-test").heldFiles).toEqual([held]);
    expect(onHeldFiles).toHaveBeenCalledExactlyOnceWith("activity-test", [held]);
    expect(notify).not.toHaveBeenCalled();
    hooks.onHeldFiles([held]);
    expect(onHeldFiles).toHaveBeenCalledOnce();
    hooks.onHeldFiles([]);
    expect(onHeldFiles).toHaveBeenLastCalledWith("activity-test", []);
    await activity.stopAll();
    hooks.onHeldFiles([held]);
    expect(onHeldFiles).toHaveBeenCalledTimes(2);
  });
  it("carries the old file copies the engine reports, pushing only a change, until the capture retires", async () => {
    let hooks!: WorkspaceCaptureHooks;
    const notify = vi.fn();
    const activity = createWorkspaceActivity(notify, {
      captureFor: (_workspace, value) => {
        hooks = value;
        return { shareView: false, capture: { start: vi.fn(), stop: vi.fn(async () => {}), settleAndCloseAllLiveSessions: vi.fn(async () => {}) } as never };
      },
    });
    await activity.open(workspace());
    expect(activity.getStatus("activity-test").retainedCopies).toBeUndefined();
    notify.mockClear();
    hooks.onRetainedCopies({ count: 3, bytes: 300 });
    expect(activity.getStatus("activity-test").retainedCopies).toEqual({ count: 3, bytes: 300 });
    expect(notify).toHaveBeenCalledExactlyOnceWith({ workspaceId: "activity-test" });
    hooks.onRetainedCopies({ count: 3, bytes: 300 });
    expect(notify).toHaveBeenCalledOnce();
    await activity.stopAll();
    hooks.onRetainedCopies({ count: 4, bytes: 400 });
    expect(notify).toHaveBeenCalledOnce();
  });
  it("attaches observation after capture fails and queues sync only for capture announcements", async () => {
    let observation!: WorkspaceObservationCallbacks;
    const queueSync = vi.fn();
    const queueWatchedUpload = vi.fn();
    const activity = createWorkspaceActivity(vi.fn(), {
      observationFor: (w, callbacks) => { observation = callbacks; return idleObservation(w, callbacks); },
      captureFor: () => { throw new Error("capture failed"); },
      engineFor: () => ({ start: async () => {}, stop: async () => {}, queueSync, queueWatchedUpload, snapshot: () => ({}) }) as never,
    });
    const status = await activity.open(workspace());
    expect(status.historyRecordingUnavailable).toBe(true);
    observation.facts([{ path: "note.md", kind: "changed" }]);
    expect(queueSync).not.toHaveBeenCalled();
    observation.captured();
    expect(queueSync).toHaveBeenCalledOnce();
    expect(queueWatchedUpload).toHaveBeenCalledExactlyOnceWith();
    await activity.stopAll();
  });

  it.each([false, true])("drains and resyncs failed observation before closing live sessions (%s)", async fails => {
    const steps: string[] = [];
    const drainFailed = vi.fn(() => { steps.push("unconfirmed"); });
    const activity = createWorkspaceActivity(vi.fn(), {
      observationFor: () => ({ ...idleObservation(workspace(), {} as never), stop: async () => {
        steps.push("drain");
        if (fails) throw new Error("drain failed");
      } }),
      captureFor: () => ({ shareView: false, capture: {
        start: () => {}, observationDrainFailed: drainFailed,
        resyncFileObservation: async () => { steps.push("resync"); },
        settleAndCloseAllLiveSessions: async () => { steps.push("sessions"); },
        stop: async () => { steps.push("capture"); },
      } as never }),
    });
    await activity.open(workspace());
    const closed = activity.close("activity-test");
    if (fails) await expect(closed).rejects.toThrow("drain failed"); else await closed;
    expect(steps).toEqual(fails ? ["drain", "unconfirmed", "resync", "sessions", "capture"] : ["drain", "sessions", "capture"]);
  });

  it("bounds a slow first scan without reporting a file observation failure", async () => {
    vi.useFakeTimers();
    try {
      const notify = vi.fn();
      const activity = createWorkspaceActivity(notify, {
        observationFor: () => ({ ...idleObservation(workspace(), {} as never), ready: new Promise(() => {}) }),
      });
      const opening = activity.open(workspace());
      await vi.advanceTimersByTimeAsync(4_999);
      expect(notify).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(await opening).toMatchObject({ historyRecordingUnavailable: false });
      expect(activity.getStatus("activity-test").fileObservationFailure).toBeUndefined();
      expect(notify).not.toHaveBeenCalled();
      await activity.stopAll();
    } finally { vi.useRealTimers(); }
  });

  it("opens a known degraded feed without waiting for the timeout", async () => {
    const activity = createWorkspaceActivity(vi.fn(), {
      observationFor: (_workspace, callbacks) => observeWorkspaceFiles({
        callbacks, subscribe: () => () => {}, onError: vi.fn(),
        read: async () => ({ cursor: { generation: "degraded", revision: 0 }, ready: false, degraded: true, resync: false, facts: [] }),
      }),
    });
    expect(await activity.open(workspace())).toMatchObject({ historyRecordingUnavailable: false, fileObservationFailure: "unavailable" });
    await activity.stopAll();
  });

  it("close releases an open waiting on readiness", async () => {
    const read = vi.fn(async () => ({ cursor: { generation: "starting", revision: 0 }, ready: false, resync: false, facts: [] }));
    const activity = createWorkspaceActivity(vi.fn(), {
      observationFor: (_workspace, callbacks) => observeWorkspaceFiles({ callbacks, read,
        subscribe: () => () => {}, onError: vi.fn() }),
    });
    const opening = activity.open(workspace());
    await vi.waitFor(() => expect(read).toHaveBeenCalledOnce());
    expect(await activity.close("activity-test")).toBe(true);
    await opening;
  });
  it("keeps an old attachment close from stopping its successor", async () => {
    const successorRoot = await createTestScratch("dohc-activity-successor-");
    const oldCaptureStop = vi.fn(async () => undefined);
    const successorCaptureStop = vi.fn(async () => undefined);
    const activity = createPhysicalWorkspaceActivity(() => {}, {
      observationFor: idleObservation,
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

  it("publishes observation paths with the workspace activity", async () => {
    const notify = vi.fn();
    let observation!: WorkspaceObservationCallbacks;
    const activity = createWorkspaceActivity(notify, {
      observationFor: (_workspace, callbacks) => { observation = callbacks; return idleObservation(_workspace, callbacks); },
      captureFor: () => ({ capture: null, shareView: false }),
    });
    await activity.open(workspace());
    notify.mockClear();

    await writeFile(join(root, "changed.md"), "changed");
    observation.facts([{ path: "changed.md", kind: "appeared" }]);

    await vi.waitFor(() => {
      expect(notify).toHaveBeenCalledWith({
        workspaceId: "activity-test",
        paths: ["changed.md"],
        pathSetChanged: true,
      });
    });
    observation.captured(["changed.md"]);
    expect(notify).toHaveBeenLastCalledWith({ workspaceId: "activity-test", paths: ["changed.md"], pathSetChanged: false });
    await activity.stopAll();
  });

  it.each(["coalesced with the pull", "with no pull echo"])("delivers a local edit %s without another pull", async scenario => {
    const notify = vi.fn();
    const onWatcherBatch = vi.fn();
    const observeFileEvents = vi.fn();
    let wake!: () => void;
    const read = vi.fn().mockResolvedValue({ cursor: { generation: "first", revision: 1 }, ready: true, resync: false, facts: [] });
    const activity = createPhysicalWorkspaceActivity(notify, {
      observationFor: (_w, callbacks) => observeWorkspaceFiles({ callbacks, read, onError: vi.fn(),
        subscribe(onWake) { wake = onWake; return () => {}; } }),
      onWatcherBatch,
      captureFor: () => ({ shareView: false, capture: { start() {}, observeFileEvents,
        settleAndCloseAllLiveSessions: async () => {}, stop: async () => {} } as never }),
    });
    const w = workspace();
    const state = new WorkspaceActivityState();
    await activity.open(w, state);
    await writeFile(join(root, "automation.ts"), "pulled definition");
    activity.pullStarting(state);
    await activity.handlePulledPaths(state, ["automation.ts"]);
    expect(onWatcherBatch).toHaveBeenCalledExactlyOnceWith(w, [{ path: "automation.ts", operation: "update" }]);
    activity.pullFinished(state);
    onWatcherBatch.mockClear();
    if (scenario === "with no pull echo") {
      wake();
      await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(2));
      expect(onWatcherBatch).not.toHaveBeenCalled();
    }
    await writeFile(join(root, "automation.ts"), "local definition");
    const seenDefinitions: Promise<string>[] = [];
    onWatcherBatch.mockImplementation((_workspace, events) => {
      for (const event of events) seenDefinitions.push(readFile(join(root, event.path), "utf8"));
    });
    read.mockResolvedValueOnce({ cursor: { generation: "first", revision: 2 }, ready: true, resync: false,
      facts: [{ path: "automation.ts", kind: "changed" }] });
    wake();
    await vi.waitFor(() => expect(observeFileEvents).toHaveBeenCalledOnce());
    expect(onWatcherBatch).toHaveBeenCalledExactlyOnceWith(w, [{ path: "automation.ts", operation: "update" }]);
    expect(await Promise.all(seenDefinitions)).toEqual(["local definition"]);
    expect(notify).toHaveBeenLastCalledWith({ workspaceId: w.workspaceId, paths: ["automation.ts"], pathSetChanged: false });
    await activity.stop(state);
  });

  it.each([true, false])("clears a persistent failed read after recovery with ready=%s", async ready => {
    vi.useFakeTimers();
    try {
      const recovered = {
        cursor: { generation: "recovered", revision: 1 }, ready, resync: false, facts: [],
      };
      const read = vi.fn().mockRejectedValue(new Error("read failed"));
      const activity = createPhysicalWorkspaceActivity(vi.fn(), {
        observationFor: (_w, callbacks) => observeWorkspaceFiles({ callbacks, read, subscribe: () => () => {}, onError: vi.fn() }),
      });
      const state = new WorkspaceActivityState();
      const w = workspace();
      const opening = activity.open(w, state);
      await vi.advanceTimersByTimeAsync(0);
      expect((await opening).historyRecordingUnavailable).toBe(false);
      expect(activity.getStatus(w, state).fileObservationFailure).toBeUndefined();
      await vi.advanceTimersByTimeAsync(7_750);
      expect(activity.getStatus(w, state)).toMatchObject({ historyRecordingUnavailable: false, fileObservationFailure: "read-failed" });
      read.mockResolvedValue(recovered);
      await vi.advanceTimersByTimeAsync(5_000);
      expect(activity.getStatus(w, state).fileObservationFailure).toBeUndefined();
      await activity.retryFileObservation(state);
      expect(activity.getStatus(w, state).fileObservationFailure).toBeUndefined();
      await activity.stop(state);
    } finally { vi.useRealTimers(); }
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

    const run = { agentId: "dohc-mcp", onBehalfOf: "local", agentRunId: "run-1", depth: 0 };
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
      depth: 0,
    };
    const second = {
      agentId: "panel",
      onBehalfOf: "local",
      agentRunId: "run-2",
      depth: 0,
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

describe("workspaceActivity agent run state", () => {
  function heldCapture() {
    const held: Array<() => void> = [];
    let holdNext = false;
    const setActiveAgentRun = vi.fn(async (_run: ActiveAgentRun | null) => {
      if (!holdNext) return;
      holdNext = false;
      await new Promise<void>((release) => held.push(release));
    });
    return {
      setActiveAgentRun,
      holdNext: () => { holdNext = true; },
      release: () => held.shift()?.(),
      decision: () => ({
        shareView: false,
        capture: {
          start: vi.fn(),
          setActiveAgentRun,
          settleAndCloseAllLiveSessions: vi.fn(async () => undefined),
          stop: vi.fn(async () => undefined),
        } as never,
      }),
    };
  }
  const run = (agentRunId: string, agentId = "dohc-mcp"): ActiveAgentRun =>
    ({ agentId, onBehalfOf: "local", agentRunId, depth: 0 });
  const id = "activity-test";

  async function opened() {
    const capture = heldCapture();
    const pushed: AgentRunStateEvent[] = [];
    const activity = createWorkspaceActivity(() => {}, {
      captureFor: capture.decision,
      onAgentRunState: (event) => pushed.push(event),
    });
    await activity.open(workspace());
    return { activity, capture, pushed };
  }

  it("stops recording when restoring the agent author fails during reopen", async () => {
    const setActiveAgentRun = vi.fn(async (_run: ActiveAgentRun | null) => {});
    const start = vi.fn();
    const stop = vi.fn(async () => {});
    const observeFileEvents = vi.fn();
    let observation!: WorkspaceObservationCallbacks;
    const activity = createPhysicalWorkspaceActivity(vi.fn(), {
      observationFor: (w, callbacks) => {
        observation = callbacks;
        return idleObservation(w, callbacks);
      },
      captureFor: () => ({ shareView: false, capture: {
        start, stop, observeFileEvents, setActiveAgentRun,
        settleAndCloseAllLiveSessions: async () => {},
      } as never }),
    });
    const w = workspace();
    const state = new WorkspaceActivityState();
    try {
      await activity.open(w, state);
      await activity.claimAgentRun(w, state, { ...run("dispatch-1"), dispatch: "run" });
      await activity.close(w, state, { preserveAgentRun: true });
      start.mockClear();
      stop.mockClear();
      setActiveAgentRun.mockRejectedValueOnce(new Error("author unavailable"));
      const status = await activity.open(w, state);
      expect(status.historyRecordingUnavailable).toBe(true);
      expect(stop).toHaveBeenCalledOnce();
      expect(start).not.toHaveBeenCalled();
      expect(activity.dispatchedAgent(state)).toBe("dohc-mcp");
      observation.facts([{ path: "note.md", kind: "changed" }]);
      expect(observeFileEvents).not.toHaveBeenCalled();
    } finally {
      await activity.close(w, state);
    }
  });

  it("pushes once when a run starts and once when it ends, read from the slot", async () => {
    const { activity, pushed } = await opened();
    expect(activity.agentRunState(id)).toEqual({ workspaceId: id, revision: 0, active: false });
    await activity.setAgentRun(id, run("run-1"));
    // One run replacing another is no change in whether the agent works.
    await activity.setAgentRun(id, run("run-2"));
    expect(activity.agentRunState(id)).toEqual({ workspaceId: id, revision: 1, active: true });
    await activity.setAgentRun(id, null);
    expect(pushed).toEqual([
      { workspaceId: id, revision: 1, active: true },
      { workspaceId: id, revision: 2, active: false },
    ]);
    expect(activity.agentRunState(id)).toEqual({ workspaceId: id, revision: 2, active: false });
    await activity.stopAll();
  });

  it("shows a chat dispatch run and leaves the runner self-test out", async () => {
    const { activity, pushed } = await opened();
    expect(await activity.claimAgentRun(id, { ...run("dispatch-1"), dispatch: "run" })).toBe(true);
    expect(activity.agentRunState(id).active).toBe(true);
    await activity.clearAgentRun(id, "dispatch-1");
    expect(await activity.claimAgentRun(id, { ...run("self-test"), dispatch: "self-test" })).toBe(true);
    expect(activity.agentRunState(id).active).toBe(false);
    await activity.clearAgentRun(id, "self-test");
    expect(pushed.map((event) => event.active)).toEqual([true, false]);
    await activity.stopAll();
  });

  it("reads the agent of a run dohc dispatched from the slot", async () => {
    const { activity } = await opened();
    expect(activity.dispatchedAgent(id)).toBeNull();
    await activity.claimAgentRun(id, run("cli-run"));
    expect(activity.dispatchedAgent(id)).toBeNull();
    await activity.clearAgentRun(id, "cli-run");
    await activity.claimAgentRun(id, { ...run("dispatch-1", "codex"), dispatch: "run" });
    expect(activity.dispatchedAgent(id)).toBe("codex");
    await activity.clearAgentRun(id, "dispatch-1");
    await activity.claimAgentRun(id, { ...run("self-test", "default"), dispatch: "self-test" });
    expect(activity.dispatchedAgent(id)).toBe("default");
    await activity.clearAgentRun(id, "self-test");
    expect(activity.dispatchedAgent(id)).toBeNull();
    await activity.stopAll();
  });

  it("pushes nothing for a refused claim and returns to idle after a failed one", async () => {
    const { activity, capture, pushed } = await opened();
    expect(await activity.claimAgentRun(id, run("run-1"))).toBe(true);
    expect(await activity.claimAgentRun(id, run("run-2"))).toBe(false);
    expect(pushed).toHaveLength(1);
    await activity.clearAgentRun(id, "run-1");
    capture.setActiveAgentRun.mockRejectedValueOnce(new Error("capture refused the run"));
    await expect(activity.claimAgentRun(id, run("run-3"))).rejects.toThrow("capture refused the run");
    expect(activity.agentRunState(id).active).toBe(false);
    expect(pushed.at(-1)).toMatchObject({ active: false });
    await activity.stopAll();
  });

  it("keeps a newer run when an older run's clear settles after it", async () => {
    const { activity, capture, pushed } = await opened();
    expect(await activity.claimAgentRun(id, run("run-1"))).toBe(true);
    capture.holdNext();
    const ending = activity.clearAgentRun(id, "run-1");
    await activity.setAgentRun(id, run("run-2"));
    capture.release();
    await ending;
    expect(activity.agentRunState(id).active).toBe(true);
    // Ending an older run does nothing for a run it does not hold.
    await activity.clearAgentRun(id, "run-1");
    expect(activity.agentRunState(id).active).toBe(true);
    expect(pushed).toEqual([{ workspaceId: id, revision: 1, active: true }]);
    await activity.stopAll();
  });

  it("pushes idle when the workspace closes during a run, and nothing for a write that lands after", async () => {
    const { activity, capture, pushed } = await opened();
    await activity.setAgentRun(id, run("run-1"));
    await activity.clearAgentRun(id, "run-1");
    capture.holdNext();
    const starting = activity.setAgentRun(id, run("run-2"));
    await vi.waitFor(() => expect(capture.setActiveAgentRun).toHaveBeenLastCalledWith(run("run-2")));
    await activity.setAgentRun(id, run("run-3"));
    await activity.close(id);
    capture.release();
    await starting;
    expect(pushed.map((event) => event.active)).toEqual([true, false, true, false]);
    expect(activity.agentRunState(id)).toEqual({ workspaceId: id, revision: 4, active: false });
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
      queueWatchedUpload: () => {},
      queuePull: () => {},
      retryNow: async () => undefined, pushRecorded: async () => undefined,
      snapshot: () => ({
        syncFailure: null,
        retrying: false,
        syncing: false,
        lastSyncedAtMs: null,
        pendingChangeCount: 0,
        conflictCount: 0,
        authExpired: false,
        sharingDeclined: [
          {
            path: "notes/large.md",
            objectId: "notes/large.md",
            versionId: "main",
            lineagePruned: false, headBlobSha256: null,
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

  describe("the Collections wait across signing in and out", () => {
    // Signing in attaches this engine; it knows nothing about the wait.
    const syncEngine = () => ({
      start: async () => {}, queueSync: () => {}, queuePull: () => {}, queueWatchedUpload: () => {}, retryNow: async () => undefined, pushRecorded: async () => undefined, stop: async () => {},
      snapshot: () => ({
        syncFailure: null, retrying: false, syncing: true, lastSyncedAtMs: null, pendingChangeCount: 0,
        conflictCount: 0, authExpired: false, sharingDeclined: [],
      }),
    });

    async function opened(input: { signedIn: boolean; atOpen: boolean }) {
      let signedIn = input.signedIn;
      const atOpen = Promise.resolve(input.atOpen);
      const service = createPhysicalWorkspaceActivity(() => {}, {
        observationFor: idleObservation,
        cloudStateFor: () => ({ enabled: true, connected: signedIn }),
        engineFor: () => (signedIn ? syncEngine() : null),
        collectionsWaitingFor: () => atOpen,
      });
      const state = new WorkspaceActivityState();
      await service.open(workspace(), state);
      // The same promise the activity awaits, so its answer lands first.
      await atOpen;
      return {
        service, state,
        waiting: () => service.getStatus(workspace(), state).collectionsWaitingForSync,
        signIn: () => { signedIn = true; service.reconcileCloud(state, () => syncEngine(), false); },
        signOut: async () => { signedIn = false; await service.stopEngine(state, false); },
        passEnded: (failed: boolean, answer: boolean) => service.syncPassEnded(workspace(), state, failed, async () => answer),
      };
    }

    it("keeps the wait read while signed out through signing in, until a pass finishes the pull", async () => {
      const h = await opened({ signedIn: false, atOpen: true });
      expect(h.waiting()).toBe("sync");
      h.signIn();
      expect(h.waiting()).toBe("sync");
      await expect(h.passEnded(true, true)).resolves.toBe(false);
      expect(h.waiting()).toBe("sync");
      await expect(h.passEnded(false, false)).resolves.toBe(true);
      expect(h.waiting()).toBeUndefined();
      await h.service.stop(h.state);
    });

    it("keeps the wait a failed pull left through signing out", async () => {
      const h = await opened({ signedIn: true, atOpen: false });
      expect(h.waiting()).toBeUndefined();
      await expect(h.passEnded(true, true)).resolves.toBe(true);
      await h.signOut();
      expect(h.waiting()).toBe("sync");
      await h.service.stop(h.state);
    });

    it("keeps the end of a wait through signing out, and asks nothing after a pass that waited for nothing", async () => {
      const h = await opened({ signedIn: true, atOpen: true });
      expect(h.waiting()).toBe("sync");
      await h.passEnded(false, false);
      await h.signOut();
      expect(h.waiting()).toBeUndefined();
      const read = vi.fn(async () => true);
      await h.service.syncPassEnded(workspace(), h.state, false, read);
      expect(read).not.toHaveBeenCalled();
      expect(h.waiting()).toBeUndefined();
      await h.service.stop(h.state);
    });
  });

  it("keeps a newer Collections answer over an older read that resolves after it", async () => {
    const atOpen = Promise.withResolvers<boolean>();
    const service = createPhysicalWorkspaceActivity(() => {}, {
      observationFor: idleObservation,
      collectionsWaitingFor: () => atOpen.promise,
    });
    const state = new WorkspaceActivityState();
    await service.open(workspace(), state);
    await service.syncPassEnded(workspace(), state, true, async () => true);
    expect(service.getStatus(workspace(), state).collectionsWaitingForSync).toBe("sync");
    atOpen.resolve(false);
    await atOpen.promise;
    expect(service.getStatus(workspace(), state).collectionsWaitingForSync).toBe("sync");
    await service.stop(state);
  });

  it("opens without waiting for the network-share check, then pushes what it found", async () => {
    const notify = vi.fn();
    const check = Promise.withResolvers<boolean>();
    const onNetworkShare = vi.fn(() => check.promise);
    const service = createPhysicalWorkspaceActivity(notify, { observationFor: idleObservation, onNetworkShare });
    const state = new WorkspaceActivityState();
    const opened = await service.open(workspace(), state);
    expect(onNetworkShare).toHaveBeenCalledWith(workspace().rootPath);
    expect(opened.onNetworkShare).toBeUndefined();
    notify.mockClear();
    check.resolve(true);
    await vi.waitFor(() => expect(notify).toHaveBeenCalledWith({ workspaceId: "activity-test" }));
    expect(service.getStatus(workspace(), state).onNetworkShare).toBe(true);
    await service.stop(state);
  });

  it("says nothing about a root on this computer's disk, or after the workspace closed", async () => {
    const notify = vi.fn();
    const late = Promise.withResolvers<boolean>();
    let answer: Promise<boolean> = Promise.resolve(false);
    const service = createPhysicalWorkspaceActivity(notify, { observationFor: idleObservation, onNetworkShare: () => answer });
    const state = new WorkspaceActivityState();
    await service.open(workspace(), state);
    await answer;
    expect(service.getStatus(workspace(), state).onNetworkShare).toBeUndefined();
    await service.stop(state);

    answer = late.promise;
    const reopened = new WorkspaceActivityState();
    await service.open(workspace(), reopened);
    await service.stop(reopened);
    notify.mockClear();
    late.resolve(true);
    await late.promise;
    expect(notify).not.toHaveBeenCalled();
    expect(service.getStatus(workspace(), reopened).onNetworkShare).toBeUndefined();
  });

  it("never lets a slow Collections answer for one workspace change another", async () => {
    const notify = vi.fn();
    const slow = Promise.withResolvers<boolean>();
    const other: ActivityWorkspace = { ...workspace(), workspaceId: "activity-other", attachmentId: Symbol("other") };
    const service = createPhysicalWorkspaceActivity(notify, {
      observationFor: idleObservation,
      collectionsWaitingFor: target => (target.workspaceId === "activity-test" ? slow.promise : Promise.resolve(false)),
    });
    const a = new WorkspaceActivityState();
    const b = new WorkspaceActivityState();
    await service.open(workspace(), a);
    await service.open(other, b);
    notify.mockClear();
    slow.resolve(true);
    await slow.promise;
    expect(service.getStatus(workspace(), a).collectionsWaitingForSync).toBe("sync");
    expect(service.getStatus(other, b).collectionsWaitingForSync).toBeUndefined();
    await vi.waitFor(() => expect(notify).toHaveBeenCalled());
    expect(notify.mock.calls).toEqual([[{ workspaceId: "activity-test" }]]);
    await service.stop(a);
    await service.stop(b);
  });

  it("asks the engine at open when no sync engine runs, as when signed out", async () => {
    let pullUnfinished = true;
    const reads: Promise<boolean>[] = [];
    const activity = createWorkspaceActivity(() => {}, {
      engineFor: () => null,
      cloudStateFor: () => ({ enabled: true, connected: false }),
      // The same promise the test awaits, so the activity's answer lands first.
      collectionsWaitingFor: () => {
        const read = Promise.resolve(pullUnfinished);
        reads.push(read);
        return read;
      },
    });
    await activity.open(workspace());
    await reads[0];
    expect(activity.getStatus("activity-test").collectionsWaitingForSync).toBe("sync");
    // Abandoning the pull ends the wait the next open reads.
    await activity.close("activity-test");
    pullUnfinished = false;
    await activity.open(workspace());
    await reads[1];
    expect(activity.getStatus("activity-test").collectionsWaitingForSync).toBeUndefined();
    await activity.stopAll();
  });

  it("keeps a failed reopen after a pause until the engine answers that nothing waits", async () => {
    const quiet = vi.spyOn(console, "error").mockImplementation(() => {});
    const answers: Array<() => Promise<boolean>> = [
      async () => { throw new Error("workspace-open-failed"); },
      async () => false,
    ];
    const reads: Promise<boolean>[] = [];
    const service = createPhysicalWorkspaceActivity(() => {}, {
      observationFor: idleObservation,
      collectionsWaitingFor: () => {
        const read = answers.shift()!();
        reads.push(read);
        return read;
      },
    });
    const state = new WorkspaceActivityState();
    try {
      service.recordSyncPauseReopenFailed(workspace(), state);
      // The activity opens though the engine refused the owner open.
      await service.open(workspace(), state);
      await reads[0]!.catch(() => undefined);
      expect(service.getStatus(workspace(), state).collectionsWaitingForSync).toBe("reopen");
      await expect(service.readCollectionsWaiting(workspace(), state)).resolves.toBe(false);
      expect(service.getStatus(workspace(), state).collectionsWaitingForSync).toBeUndefined();
    } finally {
      await service.stop(state);
      quiet.mockRestore();
    }
  });

  it("syncs now only when the pass ends without a failure, whatever the status shows first", async () => {
    let failure: CloudSyncFailure | null = null;
    let passes = 0;
    const engine = {
      start: async () => {},
      queueSync: () => {},
      queueWatchedUpload: () => {},
      queuePull: () => {},
      retryNow: async () => { passes += 1; }, pushRecorded: async () => undefined,
      snapshot: () => ({
        syncFailure: failure, retrying: false, syncing: false, lastSyncedAtMs: null, pendingChangeCount: 0,
        // A conflict shows first in the status, and must not hide a failed pass.
        conflictCount: 1, authExpired: false, sharingDeclined: [],
      }),
      stop: async () => {},
    };
    const activity = createWorkspaceActivity(() => {}, {
      engineFor: () => engine,
      cloudStateFor: () => ({ enabled: true, connected: true }),
    });
    await activity.open(workspace());
    await expect(activity.syncNow("activity-test")).resolves.toBeUndefined();
    failure = { cause: "server-unreachable", detail: "fetch failed", sinceMs: 1, attempts: 1 };
    await expect(activity.syncNow("activity-test")).rejects.toThrow("dohc could not sync this workspace with your server");
    expect(passes).toBe(2);
    await activity.stopAll();
  });

  it("reads an engine stopped on the relay API version as disconnected, naming the side to update", async () => {
    const engine = {
      start: async () => {},
      queueSync: () => {},
      queueWatchedUpload: () => {},
      queuePull: () => {},
      retryNow: async () => undefined, pushRecorded: async () => undefined,
      snapshot: () => ({
        syncFailure: null,
        retrying: false,
        syncing: false,
        lastSyncedAtMs: null,
        pendingChangeCount: 2,
        conflictCount: 0,
        authExpired: false,
        updateRequired: "server" as const,
        sharingDeclined: [],
      }),
      stop: async () => {},
    };
    const activity = createWorkspaceActivity(() => {}, {
      engineFor: () => engine,
      cloudStateFor: () => ({ enabled: true, connected: true }),
    });
    const status = await activity.open(workspace());
    expect(status.state).toBe("cloud-disconnected");
    expect(status.updateRequired).toBe("server");
    await activity.stopAll();
  });

  // Failed-join rollback (0P-C gate fix): close() tears down exactly one
  // workspace — engine stopped, entry forgotten — leaving others untouched.
  // A pass someone asked for reads as syncing, not as the failure it may
  // clear; an automatic pass does not hide the failure.
  it("shows a failed sync as syncing only while a retry someone asked for runs", async () => {
    let retrying = false;
    let claimingIdentity = false;
    const engine = {
      start: async () => {},
      queueSync: () => {},
      queueWatchedUpload: () => {},
      queuePull: () => {},
      retryNow: async () => undefined, pushRecorded: async () => undefined,
      snapshot: () => ({
        syncFailure: { cause: "server-unreachable" as const, detail: "down", sinceMs: 1, attempts: 2 },
        retrying,
        claimingIdentity,
        syncing: true,
        lastSyncedAtMs: null,
        pendingChangeCount: 1,
        conflictCount: 0,
        authExpired: false,
        sharingDeclined: [],
      }),
      stop: async () => {},
    };
    const activity = createWorkspaceActivity(() => {}, {
      engineFor: () => engine,
      cloudStateFor: () => ({ enabled: true, connected: true }),
    });
    await activity.open(workspace());
    expect(activity.getStatus("activity-test").state).toBe("sync-failed");
    retrying = true;
    claimingIdentity = true;
    expect(activity.getStatus("activity-test").claimingIdentity).toBe(true);
    expect(activity.getStatus("activity-test").state).toBe("syncing");
    expect(activity.getStatus("activity-test").syncFailure?.attempts).toBe(2);
    await activity.stopAll();
  });

  it("close stops and forgets a single workspace", async () => {
    let stopped = 0;
    const engine = {
      start: async () => {},
      queueSync: () => {},
      queueWatchedUpload: () => {},
      queuePull: () => {},
      retryNow: async () => undefined, pushRecorded: async () => undefined,
      snapshot: () => ({
        syncFailure: null,
        retrying: false,
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
            observeFileEvents: vi.fn(),
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
          queueSync: () => undefined,
          queueWatchedUpload: () => {},
          queuePull: () => undefined,
          retryNow: async () => undefined, pushRecorded: async () => undefined,
          snapshot: () => ({
            syncFailure: null,
            retrying: false,
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
              observeFileEvents: vi.fn(),
              settleAndCloseAllLiveSessions: vi.fn(async () => undefined),
              stop: vi.fn(async () => undefined),
            } as never,
            shareView: false,
          };
        },
        engineFor: () => ({
          start: async () => undefined,
          queueSync: () => undefined,
          queueWatchedUpload: () => {},
          queuePull: () => undefined,
          retryNow: async () => undefined, pushRecorded: async () => undefined,
          snapshot: () => ({
            syncFailure: null,
            retrying: false,
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
                  observeFileEvents: vi.fn(),
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
            observeFileEvents: vi.fn(),
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
          observeFileEvents: vi.fn(),
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
          observeFileEvents: vi.fn(),
          settleAndCloseAllLiveSessions: retireLiveSessions,
          stop: captureStop,
        } as never,
        shareView: false,
      }),
      engineFor: () => ({
        start: async () => undefined,
        queueSync: () => undefined,
        queueWatchedUpload: () => {},
        queuePull: () => undefined,
        retryNow: async () => undefined, pushRecorded: async () => undefined,
        snapshot: () => ({
          syncFailure: null,
          retrying: false,
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
            observeFileEvents: vi.fn(),
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
            observeFileEvents: vi.fn(),
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

it("still settles healthy workspaces when an outage checkpoint fails",async()=>{
 let release!:()=>void;const healthyDrain=new Promise<void>(done=>{release=done;});const settled=vi.fn(async()=>{});
 const quit=settleYDocsAfterFileObservation([Promise.reject(Error("checkpoint disk full")),healthyDrain],settled);await Promise.resolve();expect(settled).not.toHaveBeenCalled();release();await quit;expect(settled).toHaveBeenCalledOnce();
});

it("reads current pause metadata even while activity preserves a failure status", async () => {
  let atMs = 42;
  const activity = createPhysicalWorkspaceActivity(vi.fn(), {
    observationFor: w => idleObservation(w, {} as never),
    cloudStateFor: () => ({ enabled: false, connected: false, syncPause: { atMs,
      author: { kind: "person", personId: "local:person", self: true } } }),
  });
  const state = new WorkspaceActivityState();
  state.preservedStatus = { state: "local-changes", pendingChangeCount: 1, lastSyncedAtMs: null,
    historyRecordingUnavailable: true, historyShareView: false, liveSessionsGeneration: 0 };
  expect(activity.getStatus(workspace(), state).syncPause?.atMs).toBe(42);
  atMs = 84;
  expect(activity.getStatus(workspace(), state)).toMatchObject({ historyRecordingUnavailable: true,
    syncPause: { atMs: 84, author: { self: true } } });
});
 it.each(["appeared", "changed", "disappeared"] as const)("round2 policy %s reaches listing refresh but no file-work consumer", async kind => {
  const notify = vi.fn();
  const observeFileEvents = vi.fn();
  const handleWatcherEvents = vi.fn();
  const sources = vi.fn(async () => ["index.html"]);
  const apps = createFolderAppDetection({ sources, updated: vi.fn(), failed: vi.fn() });
  const onWatcherBatch = vi.fn((w, events) => { handleWatcherEvents(events); apps.settledEvents(w, events); });
  let observation!: WorkspaceObservationCallbacks;
  const w = workspace();
  const activity = createWorkspaceActivity(notify, {
    observationFor: (w, callbacks) => { observation = callbacks; return idleObservation(w, callbacks); },
    onWatcherBatch,
    captureFor: () => ({ shareView: false, capture: { start() {}, observeFileEvents, settleAndCloseAllLiveSessions: async () => {}, stop: async () => {} } as never }),
  });
  try {
    await activity.open(w);
    await apps.read(w, ".");
    notify.mockClear();
    observation.facts([{ path: ".dohc/visibility.toml", kind }]);
    await apps.retire(w.attachmentId);
    expect.soft(observeFileEvents).not.toHaveBeenCalled();
    expect.soft(onWatcherBatch).not.toHaveBeenCalled();
    expect.soft(handleWatcherEvents).not.toHaveBeenCalled();
    expect.soft(sources).toHaveBeenCalledOnce();
    expect(notify).toHaveBeenCalledExactlyOnceWith({ workspaceId: w.workspaceId, paths: [".dohc/visibility.toml"], pathSetChanged: kind !== "changed" });
  } finally { await activity.stopAll(); await apps.retire(w.attachmentId); }
 });
