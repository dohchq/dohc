import { realpathSync } from "node:fs";
import { expect, it, vi } from "vitest";
import { canonicalWorkspaceRoot } from "./createWorkspaceFolder";
import { createTestScratch } from "./testTemp";
import { createWorkspaceActivity, WorkspaceActivityState } from "./workspaceActivity";
import { idleObservation } from "./workspaceActivity.testSupport";

it.each(["native", "registry"] as const)("keeps activity and agent checks on one folder across %s roots", async spelling => {
  const folder = await createTestScratch("activity-root-spelling-");
  const other = canonicalWorkspaceRoot(await createTestScratch("activity-other-root-"));
  const native = realpathSync.native(folder), registry = canonicalWorkspaceRoot(folder);
  const expectedRoot = spelling === "native" ? native : registry;
  const workspace = { workspaceId: "workspace", rootPath: native, attachmentId: Symbol("attachment"),
    kind: "personal" as const, mode: "local-first" as const };
  const capture = { start: vi.fn(), stop: vi.fn(async () => undefined),
    setActiveAgentRun: vi.fn(async () => undefined), settleAndCloseAllLiveSessions: vi.fn(async () => undefined) };
  const activity = createWorkspaceActivity(vi.fn(), { observationFor: idleObservation,
    captureFor: () => ({ shareView: false, capture: capture as never }) });
  const state = new WorkspaceActivityState();
  const run = { agentId: "agent", onBehalfOf: "person", agentRunId: "run", depth: 0 };
  try {
    await activity.open(workspace, state);
    await expect(activity.open({ ...workspace, rootPath: other }, state)).rejects.toThrow("another physical root");
    await activity.open({ ...workspace, rootPath: expectedRoot }, state);
    expect(activity.engineCaptureFor(state, other)).toBeNull();
    expect(activity.engineCaptureFor(state, expectedRoot)).toBe(capture);
    await expect(activity.claimAgentRun(workspace, state, run, other)).rejects.toThrow("another physical root");
    expect(await activity.claimAgentRun(workspace, state, run, expectedRoot)).toBe(true);
    expect(activity.hasAgentRun(state, other)).toBe(false);
    expect(activity.hasAgentRun(state, expectedRoot)).toBe(true);
    await activity.clearAgentRun(state, run.agentRunId, other);
    expect(activity.hasAgentRun(state)).toBe(true);
    await activity.clearAgentRun(state, run.agentRunId, expectedRoot);
    expect(activity.hasAgentRun(state)).toBe(false);
    expect(await activity.close(workspace, state, { expectedRootPath: other })).toBe(false);
    await activity.claimAgentRun(workspace, state, run, expectedRoot);
    expect(await activity.close(workspace, state, { expectedRootPath: expectedRoot, preserveAgentRun: true })).toBe(true);
    // A closed activity can still own a run; a mismatched close must leave it alone.
    await activity.close(workspace, state, { expectedRootPath: other });
    expect(activity.hasAgentRun(state)).toBe(true);
    await activity.close(workspace, state, { expectedRootPath: expectedRoot });
    expect(activity.hasAgentRun(state)).toBe(false);
  } finally {
    await activity.stop(state);
  }
});

it("reopens a capture with the preserved run's root after admitting another spelling", async () => {
  const folder = await createTestScratch("activity-reopen-root-");
  const rootPath = realpathSync.native(folder);
  const workspace = { workspaceId: "workspace", rootPath, attachmentId: Symbol("attachment"),
    kind: "personal" as const, mode: "local-first" as const };
  const capture = { start: vi.fn(), stop: vi.fn(async () => undefined),
    setActiveAgentRun: vi.fn(async () => undefined), settleAndCloseAllLiveSessions: vi.fn(async () => undefined) };
  const captureFor = vi.fn((_workspace: { rootPath: string }) => ({ shareView: false, capture: capture as never }));
  const activity = createWorkspaceActivity(vi.fn(), { observationFor: idleObservation, captureFor });
  const state = new WorkspaceActivityState();
  try {
    await activity.open(workspace, state);
    await activity.claimAgentRun(workspace, state, { agentId: "agent", onBehalfOf: "person", agentRunId: "run", depth: 0 });
    await activity.close(workspace, state, { preserveAgentRun: true });
    await activity.open({ ...workspace, rootPath: `${canonicalWorkspaceRoot(folder)}/` }, state);
    expect(captureFor).toHaveBeenCalledTimes(2);
    expect(captureFor.mock.calls[1]?.[0].rootPath).toBe(rootPath);
    expect(activity.workspaceRootPath(state)).toBe(rootPath);
  } finally {
    await activity.stop(state);
  }
});
