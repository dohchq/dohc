import { createWorkspaceEngineCapture, type WorkspaceEngineCapture } from "./workspaceEngineCapture";
import { readWorkspaceSettingsFile } from "./workspaceSettingsFile";
import type { WorkspaceCaptureHooks } from "./workspaceActivity";

// THE captureFor gate (single owner). Workspace-engine alpha (PR 0M-3/0M-5):
// when the per-workspace flag is on, the engine store under .dohc/engine/ is
// the workspace's SOLE history recorder — watcher batches become engine
// moments and no legacy .dohc/history change set is written. The flag is read
// at open; toggling it takes effect on the next open of the workspace.
//
// Shared by main.ts (production wiring) and scripts/phase0m-agent-engine-qa.ts
// (the arc-gate QA harness) so the harness can never silently drift from the
// real gate.
export async function captureForFlaggedWorkspace(
  workspace: { workspaceId: string; rootPath: string },
  hooks: WorkspaceCaptureHooks,
): Promise<WorkspaceEngineCapture | null> {
  const { settings } = await readWorkspaceSettingsFile(workspace.rootPath);
  if (!settings.experimental.workspaceEngineAlpha) return null;
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
  });
}
