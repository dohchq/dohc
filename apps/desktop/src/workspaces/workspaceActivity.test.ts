import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createWorkspaceActivity } from "./workspaceActivity";
import type { CreatedWorkspace } from "./createWorkspaceFolder";

// Retirement Phase C (WS-H1): the legacy change-set read surface
// (listChangeSets/readChangeSet) is gone from this layer — engine moments
// are the only history. These tests cover what remains: the capture hooks
// and the honest no-recorder status for opted-out workspaces.

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "dohc-activity-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function workspace(): CreatedWorkspace {
  return {
    workspaceId: "activity-test",
    rootPath: root,
    kind: "personal",
    mode: "local-first",
  };
}

// PR 0N-1: the capture hooks expose the workspace's LIVE agent-run slot so
// the engine capture can stamp settled batches with agent authorship while a
// dohc-tracked run is active.
describe("workspaceActivity capture hooks", () => {
  it("wires the live agent-run slot into captureFor's hooks", async () => {
    let liveSlot: (() => unknown) | null = null;
    const activity = createWorkspaceActivity(() => {}, {
      captureFor: (_workspace, hooks) => {
        liveSlot = hooks.activeAgentRun;
        return null;
      },
    });
    await activity.open(workspace());
    expect(liveSlot).not.toBeNull();
    expect(liveSlot!()).toBeNull();

    const run = { agentId: "dohc-mcp", onBehalfOf: "local", agentRunId: "run-1" };
    activity.setAgentRun("activity-test", run);
    expect(liveSlot!()).toEqual(run);
    activity.setAgentRun("activity-test", null);
    expect(liveSlot!()).toBeNull();
    await activity.stopAll();
  });
});

describe("workspaceActivity history-off status (retirement Phase C)", () => {
  it("reports historyRecordingOff when captureFor yields no capture (engine opt-out)", async () => {
    const activity = createWorkspaceActivity(() => {}, {
      captureFor: () => null,
    });
    const status = await activity.open(workspace());
    expect(status.historyRecordingOff).toBe(true);
    expect(activity.getStatus("activity-test").historyRecordingOff).toBe(true);
    // No capture also means no versions surface.
    expect(activity.engineCaptureFor("activity-test")).toBeNull();
    await activity.stopAll();
  });

  it("does not raise the history-off status before open or without a captureFor gate", async () => {
    const activity = createWorkspaceActivity(() => {});
    // Unknown/unopened workspace: status is derivable but never claims
    // history is off (nothing is known yet).
    expect(activity.getStatus("activity-test").historyRecordingOff).toBe(false);
    const status = await activity.open(workspace());
    // No captureFor option at all (test/legacy wiring): stays false.
    expect(status.historyRecordingOff).toBe(false);
    await activity.stopAll();
  });
});

describe("workspaceActivity cloud sync nudge (0P-C)", () => {
  it("queueCloudSync reaches the workspace's engine and no-ops everywhere else", async () => {
    let queued = 0;
    let dismissed = 0;
    const engine = {
      start: async () => {},
      queueSync: () => {
        queued += 1;
      },
      snapshot: () => ({
        syncing: false,
        lastSyncedAtMs: null,
        pendingChangeCount: 0,
        conflictCount: 0,
        unmatchedRemoteResolves: 2,
        authExpired: false,
      }),
      dismissUnmatchedResolves: () => {
        dismissed += 1;
      },
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

    await activity.open(workspace());
    activity.queueCloudSync("activity-test");
    expect(queued).toBe(1);
    // The engine snapshot's unmatched remote resolves ride the status.
    expect(activity.getStatus("activity-test").unmatchedRemoteResolves).toBe(2);
    // Explicit notice dismissal reaches the engine (0P-C gate fix) and
    // no-ops for unknown workspaces.
    activity.dismissUnmatchedRemoteResolves("activity-test");
    expect(dismissed).toBe(1);
    activity.dismissUnmatchedRemoteResolves("not-open");
    expect(dismissed).toBe(1);
    await activity.stopAll();
  });

  // Failed-join rollback (0P-C gate fix): close() tears down exactly one
  // workspace — engine stopped, entry forgotten — leaving others untouched.
  it("close stops and forgets a single workspace", async () => {
    let stopped = 0;
    const engine = {
      start: async () => {},
      queueSync: () => {},
      snapshot: () => ({
        syncing: false,
        lastSyncedAtMs: null,
        pendingChangeCount: 0,
        conflictCount: 0,
        unmatchedRemoteResolves: 0,
        authExpired: false,
      }),
      dismissUnmatchedResolves: () => {},
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
});
