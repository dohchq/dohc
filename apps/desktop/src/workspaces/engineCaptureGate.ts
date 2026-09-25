import {
  createWorkspaceEngineCapture,
} from "./workspaceEngineCapture";
import type {
  WorkspaceCaptureDecision,
  WorkspaceCaptureHooks,
} from "./workspaceActivity";
import type {
  AttachedEngineWorkspace,
  EngineWorkspaceSessions,
} from "@dohc/workspace-engine-client/daemon";

// The captureFor gate (single owner): the engine store under .dohc/engine/ is
// the workspace's sole history recorder. The daemon is required, not
// optional: `startRustEngineDaemon` quits the app when it cannot start, before
// any window exists, so no running workspace can reach here without one.
export function captureForWorkspace(
  workspace: AttachedEngineWorkspace & {
    shareView: boolean;
  },
  hooks: WorkspaceCaptureHooks,
  rustEngineSessions: EngineWorkspaceSessions,
): WorkspaceCaptureDecision {
  // A shared view never gets a recorder: it is fed exclusively by
  // the share's filtered pull, and a watcher would re-journal materialized
  // files. At edit level too: the recipient's edits reach the engine because
  // the app writes them there itself.
  if (workspace.shareView) {
    return { capture: null, shareView: true };
  }
  return {
    shareView: false,
    capture: createWorkspaceEngineCapture({
      workspaceId: workspace.workspaceId,
      rootPath: workspace.rootPath,
      attachmentId: workspace.attachmentId,
      // Feeds the persistent history-capture notice: a failing engine store
      // must be user-visible, not console-only.
      onCaptureOutcome: hooks.onCaptureOutcome,
      rustEngineSessions,
    }),
  };
}

// The feature a refusal names when the workspace has no capture: the word
// the user's surface already shows, never an internal noun.
export type EngineFeature =
  | "Versions"
  | "Chats"
  | "Plugins"
  | "Engine history"
  | "Chat mentions"
  | "Automations";

// A workspace without a capture had its recorder fail to build at open. Main
// builds the recorder once per workspace per app session, so a restart is the
// step that retries it.
export function captureRefusal(feature: EngineFeature): string {
  return `dohc could not start ${feature} for this workspace. Restart dohc to try again.`;
}
