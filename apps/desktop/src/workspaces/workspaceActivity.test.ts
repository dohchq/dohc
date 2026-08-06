import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createWorkspaceActivity } from "./workspaceActivity";
import { captureForFlaggedWorkspace } from "./engineCaptureGate";
import type { CreatedWorkspace } from "./createWorkspaceFolder";
import type { EngineWorkspaceSessions } from "@dohc/workspace-engine-client/daemon";
import { createTestScratch } from "./testTemp";

// The shared-view pin drives the REAL gate, which never reaches the engine
// for a shared view — these sessions prove it by throwing on any use.
const engineUnreachableSessions = new Proxy({} as EngineWorkspaceSessions, {
  get(_target, property) {
    throw new Error(
      `workspaceActivity.test: sessions.${String(property)} was used, but a shared view must not reach the engine`,
    );
  },
});

// Retirement Phase C (WS-H1): the legacy change-set read surface
// (listChangeSets/readChangeSet) is gone from this layer — engine moments
// are the only history. These tests cover what remains: the capture hooks
// and the honest no-recorder status for opted-out workspaces.

let root: string;

beforeEach(async () => {
  root = await createTestScratch("dohc-activity-");
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
  it("fires and contains the dormant Rust shadow observer only when supplied", async () => {
    const captureBatch = vi.fn();
    const onRustEngineShadowActivity = vi.fn(async () => {
      throw new Error("shadow adapter unavailable");
    });
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const activity = createWorkspaceActivity(() => {}, {
      captureFor: () => ({
        shareView: false,
        capture: {
          start: vi.fn(),
          captureBatch,
          stop: vi.fn(async () => undefined),
        } as never,
      }),
      onRustEngineShadowActivity,
    });
    await activity.open(workspace());
    await writeFile(join(root, "shadow.md"), "shadow");

    await vi.waitFor(
      () => {
        expect(captureBatch).toHaveBeenCalled();
        expect(onRustEngineShadowActivity).toHaveBeenCalledWith({
          workspaceId: "activity-test",
          rootPath: root,
        });
        expect(errorSpy).toHaveBeenCalledWith(
          expect.stringContaining("Rust engine shadow activity failed"),
          expect.any(Error),
        );
      },
      { timeout: 3_000 },
    );
    await activity.stopAll();
  });

  it("wires the live agent-run slot into captureFor's hooks", async () => {
    let liveSlot: (() => unknown) | null = null;
    const activity = createWorkspaceActivity(() => {}, {
      captureFor: (_workspace, hooks) => {
        liveSlot = hooks.activeAgentRun;
        return { capture: null, shareView: false };
      },
    });
    await activity.open(workspace());
    expect(liveSlot).not.toBeNull();
    expect(liveSlot!()).toBeNull();

    const run = { agentId: "dohc-mcp", onBehalfOf: "local", agentRunId: "run-1" };
    await activity.setAgentRun("activity-test", run);
    expect(liveSlot!()).toEqual(run);
    await activity.setAgentRun("activity-test", null);
    expect(liveSlot!()).toBeNull();
    await activity.stopAll();
  });

  it("claims the single attribution slot atomically and clears by owner run id", async () => {
    let liveSlot: (() => unknown) | null = null;
    const activity = createWorkspaceActivity(() => {}, {
      captureFor: (_workspace, hooks) => {
        liveSlot = hooks.activeAgentRun;
        return { capture: null, shareView: false };
      },
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
    expect(liveSlot!()).toEqual(first);
    await activity.clearAgentRun("activity-test", first.agentRunId);
    expect(liveSlot!()).toBeNull();
    expect(await activity.claimAgentRun("activity-test", second)).toBe(true);
    await activity.stopAll();
  });
});

describe("workspaceActivity history-off status (retirement Phase C)", () => {
  it("reports historyRecordingOff when captureFor yields no capture (engine opt-out)", async () => {
    const activity = createWorkspaceActivity(() => {}, {
      captureFor: () => ({ capture: null, shareView: false }),
    });
    const status = await activity.open(workspace());
    expect(status.historyRecordingOff).toBe(true);
    expect(activity.getStatus("activity-test").historyRecordingOff).toBe(true);
    // A decision, not a failure and not a shared view: the notice may name
    // Settings for this one and only this one.
    expect(status.historyRecordingUnavailable).toBe(false);
    expect(status.historyShareView).toBe(false);
    // No capture also means no versions surface.
    expect(activity.engineCaptureFor("activity-test")).toBeNull();
    await activity.stopAll();
  });

  // #540: a shared view's null capture is a capability — the view is fed by
  // the share's pull and never records here. Without this cause on the
  // status, the notice blames a Settings toggle nobody touched. Wired
  // through the REAL gate, so the share rule and the status thread are
  // pinned together: deleting either breaks this test.
  it("separates a shared view's null capture from the engine opt-out", async () => {
    const activity = createWorkspaceActivity(() => {}, {
      captureFor: (w, hooks) =>
        captureForFlaggedWorkspace(
          { workspaceId: w.workspaceId, rootPath: w.rootPath, shareView: true },
          hooks,
          engineUnreachableSessions,
        ),
    });
    const status = await activity.open(workspace());
    expect(status.historyRecordingOff).toBe(true);
    expect(status.historyShareView).toBe(true);
    expect(activity.getStatus("activity-test").historyShareView).toBe(true);
    // A capability, not a failure.
    expect(status.historyRecordingUnavailable).toBe(false);
    await activity.stopAll();
  });

  // #483: main's open-time read is the ONLY source of the notice's cause. It
  // rides the status the renderer already consumes, so a renderer-side read
  // can neither invent a cause nor promise "no history" while recording.
  it("carries the open-time read's reason into the status", async () => {
    const warning =
      "Workspace settings could not be read. dohc records no history for this workspace. Fix /ws/.dohc/settings.local.json. Then restart dohc.";
    const activity = createWorkspaceActivity(() => {}, {
      captureFor: () => ({ capture: null, warning, shareView: false }),
    });
    const status = await activity.open(workspace());
    expect(status.historyRecordingOff).toBe(true);
    expect(status.settingsWarning).toBe(warning);
    expect(activity.getStatus("activity-test").settingsWarning).toBe(warning);
    await activity.stopAll();
  });

  it("carries no reason when the open-time read was fine", async () => {
    const activity = createWorkspaceActivity(() => {}, {
      captureFor: () => ({ capture: null, shareView: false }),
    });
    const status = await activity.open(workspace());
    expect(status.historyRecordingOff).toBe(true);
    expect(status.settingsWarning).toBeUndefined();
    await activity.stopAll();
  });

  // #505: a capture build that THREW leaves the same empty recorder, but the
  // cause is a failure. The status separates the two so the notice can.
  it("separates a failed capture build from the engine opt-out", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const activity = createWorkspaceActivity(() => {}, {
      captureFor: () => {
        throw new Error("engine store unavailable");
      },
    });
    const status = await activity.open(workspace());
    expect(status.historyRecordingOff).toBe(true);
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
    expect(activity.getStatus("activity-test").historyRecordingOff).toBe(false);
    const status = await activity.open(workspace());
    // No captureFor option at all (test/legacy wiring): stays false.
    expect(status.historyRecordingOff).toBe(false);
    expect(status.historyRecordingUnavailable).toBe(false);
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
