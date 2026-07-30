import {
  createWorkspaceEngineCapture,
  type WorkspaceEngineCapture,
} from "./workspaceEngineCapture";
import { readWorkspaceSettingsFile } from "./workspaceSettingsFile";
import type { WorkspaceCaptureHooks } from "./workspaceActivity";
import type { EngineWorkspaceSessions } from "@dohc/workspace-engine-client/daemon";

// THE captureFor gate (single owner). Workspace-engine alpha (PR 0M-3/0M-5):
// when the per-workspace flag is on, the engine store under .dohc/engine/ is
// the workspace's SOLE history recorder — watcher batches become engine
// moments and no legacy .dohc/history change set is written. The flag is read
// at open; toggling it takes effect on the next open of the workspace.
//
// The daemon is REQUIRED, not optional. `startRustEngineDaemon` in main.ts shows
// an error dialog and calls `app.quit()` when the daemon does not start, and
// `app.whenReady` returns early on its false result — before any window exists
// or IPC is registered. Its `rustEngineWorkspaceSessions` handle is assigned only
// on success and nulled only on that failure path, so no running workspace can
// reach this function without a daemon.
//
// It used to be `rustEngineSessions?: … | null` with a conditional spread, which
// made a no-daemon workspace silently construct the LEGACY TypeScript engine.
// That path was unreachable in production and reachable only from tests, but the
// type invited it back. `cliServer.ts` had already deleted its own copy of this
// branch for the same reason — see the comment on its removed legacy read.
//
// Deliberately no line numbers: an earlier draft of this comment cited them and
// was already wrong in its own commit, because adding `requireEngineSessions` to
// main.ts shifted every line it pointed at.
export async function captureForFlaggedWorkspace(
  workspace: { workspaceId: string; rootPath: string },
  hooks: WorkspaceCaptureHooks,
  rustEngineSessions: EngineWorkspaceSessions,
): Promise<WorkspaceEngineCapture | null> {
  if (!(await workspaceEngineEnabled(workspace.rootPath))) return null;
  return createWorkspaceEngineCapture({
    workspaceId: workspace.workspaceId,
    rootPath: workspace.rootPath,
    // Feeds the persistent history-capture notice (PR 0M-7): with legacy
    // recording off for flagged workspaces, a failing engine store must be
    // user-visible, not console-only.
    onCaptureOutcome: hooks.onCaptureOutcome,
    // PR 0N-1: batches settled while a dohc-tracked agent run is active are
    // stamped with agent authorship (History shows "<User Name>'s agent").
    activeAgentRun: hooks.activeAgentRun,
    rustEngineSessions,
    daemonOwnsCapture: true,
  });
}

// The gate's predicate on its own, for callers that must honor the opt-out
// WITHOUT touching the engine (e.g. the chat dispatch scan — for an opted-out
// workspace, merely resolving its stores would create .dohc/engine/).
export async function workspaceEngineEnabled(
  rootPath: string,
): Promise<boolean> {
  const { settings } = await readWorkspaceSettingsFile(rootPath);
  return settings.experimental.workspaceEngineAlpha;
}

// Whether a chat dispatch scan may touch this workspace's engine stores. An
// OPEN session keeps the capture decision made at open (the flag applies at
// the NEXT open) — rereading the file here would strand a mid-session
// opt-out's chats as forever-pending. An unopened workspace (tray-only pump
// scan) has no snapshot; the file read IS its open-time read.
export async function dispatchScanEligible(
  workspace: { workspaceId: string; rootPath: string },
  activity: {
    listOpenWorkspaceIds(): string[];
    engineCaptureFor(workspaceId: string): WorkspaceEngineCapture | null;
  },
): Promise<boolean> {
  if (activity.listOpenWorkspaceIds().includes(workspace.workspaceId)) {
    return activity.engineCaptureFor(workspace.workspaceId) !== null;
  }
  return workspaceEngineEnabled(workspace.rootPath);
}
