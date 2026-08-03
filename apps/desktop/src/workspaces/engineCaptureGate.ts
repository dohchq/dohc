import {
  createWorkspaceEngineCapture,
  type WorkspaceEngineCapture,
} from "./workspaceEngineCapture";
import { readWorkspaceSettingsFile } from "./workspaceSettingsFile";
import type {
  WorkspaceCaptureDecision,
  WorkspaceCaptureHooks,
} from "./workspaceActivity";
import type { EngineWorkspaceSessions } from "@dohc/workspace-engine-client/daemon";

// THE captureFor gate (single owner). Workspace-engine alpha (PR 0M-3/0M-5):
// when the per-workspace flag is on, the engine store under .dohc/engine/ is
// the workspace's SOLE history recorder — watcher batches become engine
// moments and no legacy .dohc/history change set is written. The flag is read
// at open; toggling it takes effect on the next open of the workspace.
//
// The daemon is REQUIRED, not optional: `startRustEngineDaemon` quits the app
// when it cannot start, before any window exists, so no running workspace can
// reach here without one. Accepting a null would mean silently recording history
// through the legacy TypeScript engine instead.
export async function captureForFlaggedWorkspace(
  workspace: { workspaceId: string; rootPath: string; shareView: boolean },
  hooks: WorkspaceCaptureHooks,
  rustEngineSessions: EngineWorkspaceSessions,
): Promise<WorkspaceCaptureDecision> {
  // A shared view never gets a recorder (#540): it is fed exclusively by
  // the share's filtered pull, and a watcher would re-journal materialized
  // files. Decided BEFORE the settings read — a shared view materializes no
  // settings file, so reading defaults here would start a capture. The
  // caller states the share identity (it owns the registry); the gate owns
  // what that identity means for the decision.
  if (workspace.shareView) {
    return { capture: null, shareView: true };
  }
  // ONE read decides both the recorder and what the user is told about it.
  // A second read taken later (the renderer's) could disagree with this one
  // and give the notice a cause that never happened.
  const { settings, warning } = await readWorkspaceSettingsFile(workspace.rootPath);
  if (!settings.experimental.workspaceEngineAlpha) {
    return { capture: null, shareView: false, ...(warning ? { warning } : {}) };
  }
  return {
    shareView: false,
    capture: createWorkspaceEngineCapture({
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
    }),
  };
}

// What a refusal may SAY when the gate produced no capture (#541). "Not
// enabled" asserts a decision, and after a failed capture build — or an
// unreadable settings file — the truth is a failure, not a setting the user
// touched. The refusal names the cause the open-time decision established,
// from the same status that drives the history-off notice, and falls back to
// the caller's opt-out copy only when the opt-out is what happened.
export function engineOffRefusal(
  status: {
    settingsWarning?: string;
    historyRecordingUnavailable: boolean;
  },
  notEnabled: string,
): string {
  // #483: the warning already names the unreadable file and the fix.
  if (status.settingsWarning) return status.settingsWarning;
  if (status.historyRecordingUnavailable) {
    // Restart, not reopen: main builds the recorder once per workspace per
    // app session, so reopening the workspace re-reads nothing.
    return "dohc could not start the workspace engine for this workspace. Restart dohc to try again.";
  }
  return notEnabled;
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
