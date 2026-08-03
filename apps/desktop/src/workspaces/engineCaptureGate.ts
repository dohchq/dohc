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

// How the caller's path recovers from a failed capture build (#541, codex P2
// on #583). A RETAINED workspace session keeps the failed decision for the
// whole app session — only a restart re-runs it. A TRANSIENT open (background
// dispatch, runner self-test) is closed and removed by its release, so the
// next attempt rebuilds the capture: retry is the instruction that works.
export type EngineOffRecovery = "restart" | "retry";

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
  recovery: EngineOffRecovery,
): string {
  // #483: the warning already names the unreadable file and the fix. Its
  // canonical closing instruction is restart — right for a retained session.
  // On a retry path the entry is gone, so fixing the file and trying again
  // rebuilds the capture without a restart. If the warning's format ever
  // drifts past the replace, the untouched text still says restart — heavier
  // than needed on that path, but never false.
  if (status.settingsWarning) {
    return recovery === "retry"
      ? status.settingsWarning.replace(/ Then restart dohc.$/, " Then try again.")
      : status.settingsWarning;
  }
  if (status.historyRecordingUnavailable) {
    return recovery === "retry"
      ? "dohc could not start the workspace engine for this workspace. Try again."
      : "dohc could not start the workspace engine for this workspace. Restart dohc to try again.";
  }
  return notEnabled;
}

// The dispatch-run seam of the same refusal (#541, codex P2s on #583). Two
// facts have to be read at the only moment each is true:
// - the CAUSE comes from the status BEFORE the release — releasing a
//   transient open deletes the entry, and its defaults read as the opt-out;
// - the RECOVERY comes from what the release ACTUALLY did, not a pre-open
//   snapshot — a workspace retained between open and release keeps its
//   failed decision, and "try again" would be false there.
// So: read the status, release, then build the message from whether the
// release closed the entry. A caller with a capture attached gets a no-op.
export async function releaseAndRefuseWithoutCapture(input: {
  capture: object | null;
  status: () => {
    settingsWarning?: string;
    historyRecordingUnavailable: boolean;
  };
  // Resolves to whether it CLOSED the workspace's activity entry.
  release: () => Promise<boolean>;
  notEnabled: string;
}): Promise<void> {
  if (input.capture) return;
  const status = input.status();
  const closed = await input.release();
  throw new Error(
    engineOffRefusal(status, input.notEnabled, closed ? "retry" : "restart"),
  );
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
