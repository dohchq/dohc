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
// moments and no legacy .dohc/history change set is written.
//
// WHEN the flag is read: on every fresh entry to this gate. A RETAINED session
// gets exactly one — `openWorkspaceActivity` retains what it opens and
// `workspaceActivity.open` skips a workspace it already watches — so a window
// that opened its workspace sees one decision per app session, and only a
// restart re-reads the flag (#687: that is why their copy says restart).
// Three paths re-enter without one: a tray scoped sync calls this gate per
// scan, a released dispatch entry rebuilds its capture on the next attempt
// (see `EngineOffRecovery` below), and a failed join closes the entry it just
// retained, so the user's retry re-reads.
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

// The noun rule for every capture refusal: name the FEATURE the user
// invoked — the word their surface already shows (Versions, Chats, Engine
// history, Chat mentions) — never an internal implementation noun. The
// history-off notice follows the same rule on its own surface ("recording
// history" is the feature there).
export type EngineFeature =
  | "Versions"
  | "Chats"
  | "Plugins"
  | "Engine history"
  | "Chat mentions";

// The real opt-out's copy, one sentence per feature so the verb agrees.
const NOT_ENABLED_COPY: Record<EngineFeature, string> = {
  Versions: "Versions are not enabled for this workspace.",
  Chats: "Chats are not enabled for this workspace.",
  Plugins: "Plugins are not enabled for this workspace.",
  "Engine history": "Engine history is not enabled for this workspace.",
  "Chat mentions": "Chat mentions are not enabled for this workspace.",
};

// What happened to the caller's action, leading the unreadable-settings
// refusal — the warning that follows says why, names the file, and gives
// the recovery.
const UNAVAILABLE_COPY: Record<EngineFeature, string> = {
  Versions: "Versions are unavailable.",
  Chats: "Chats are unavailable.",
  Plugins: "Plugins are unavailable.",
  "Engine history": "Engine history is unavailable.",
  "Chat mentions": "Chat mentions are unavailable.",
};

// What a refusal may SAY when the gate produced no capture (#541). "Not
// enabled" asserts a decision, and after a failed capture build — or an
// unreadable settings file — the truth is a failure, not a setting the user
// touched. The refusal names the cause the open-time decision established,
// from the same status that drives the history-off notice, and falls back to
// the feature's opt-out copy only when the opt-out is what happened.
export function engineOffRefusal(
  status: {
    settingsWarning?: string;
    historyRecordingUnavailable: boolean;
  },
  feature: EngineFeature,
  recovery: EngineOffRecovery,
): string {
  // #483: the warning already names the unreadable file and the fix. Its
  // canonical closing instruction is restart — right for a retained session.
  // On a retry path the entry is gone, so fixing the file and trying again
  // rebuilds the capture without a restart. If the warning's format ever
  // drifts past the replace, the untouched text still says restart — heavier
  // than needed on that path, but never false.
  if (status.settingsWarning) {
    // Same noun rule as below (#541 round 7): lead with what happened to the
    // FEATURE the caller invoked, then the warning's why / file / recovery.
    const warning =
      recovery === "retry"
        ? status.settingsWarning.replace(/ Then restart dohc.$/, " Then try again.")
        : status.settingsWarning;
    return `${UNAVAILABLE_COPY[feature]} ${warning}`;
  }
  if (status.historyRecordingUnavailable) {
    return recovery === "retry"
      ? `dohc could not start ${feature} for this workspace. Try again.`
      : `dohc could not start ${feature} for this workspace. Restart dohc to try again.`;
  }
  return NOT_ENABLED_COPY[feature];
}

// The dispatch release (#541, codex P2 round 4 on #583). It resolves to
// whether a fresh attempt would REBUILD the capture — the fact the refusal's
// recovery derives from — and that is decided from the POST-close state, not
// from having performed a close: the close's own await is a window, and a
// renderer/CLI open can retain the workspace during it, then build a fresh
// retained activity whose failed capture decision persists until restart.
export function createDispatchRunRelease(input: {
  alreadyOpen: boolean;
  isRetained: () => boolean;
  close: () => Promise<void>;
}): () => Promise<boolean> {
  let released = false;
  let retryable = false;
  return async () => {
    if (released) return retryable;
    released = true;
    if (input.alreadyOpen || input.isRetained()) return retryable;
    await input.close();
    retryable = !input.isRetained();
    return retryable;
  };
}

// The dispatch-run seam of the same refusal (#541, codex P2s on #583). Every
// fact is read at the only moment it is true:
// - the transient CAUSE comes from the status BEFORE the release — releasing
//   a transient open deletes the entry, and its defaults read as the opt-out;
// - after a release that closed the entry, the next attempt rebuilds the
//   capture: retry;
// - after a release that KEPT an entry (already open, retained, or reopened
//   by a retention that landed during the close), the post-state itself
//   answers. A reopened capture that BUILT means the workspace works right
//   now — proceed instead of refusing — and a still-null capture persists
//   until restart, with the KEPT entry's own status as the cause.
// A caller with a capture attached gets a no-op.
export async function releaseAndRefuseWithoutCapture(input: {
  capture: object | null;
  // Settles behind the kept entry's (re)open, so the capture read below
  // judges a state that has finished forming — the reopener's capture
  // builds AFTER our release resolves.
  settleKeptOpen: () => Promise<void>;
  // Live re-read of the workspace's current capture, for the kept-entry path.
  currentCapture: () => object | null;
  status: () => {
    settingsWarning?: string;
    historyRecordingUnavailable: boolean;
  };
  // Resolves to whether a fresh attempt would rebuild the capture (see
  // createDispatchRunRelease).
  release: () => Promise<boolean>;
  feature: EngineFeature;
}): Promise<void> {
  if (input.capture) return;
  const closedStatus = input.status();
  const retryable = await input.release();
  if (retryable) {
    throw new Error(engineOffRefusal(closedStatus, input.feature, "retry"));
  }
  await input.settleKeptOpen();
  if (input.currentCapture()) return;
  throw new Error(engineOffRefusal(input.status(), input.feature, "restart"));
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
