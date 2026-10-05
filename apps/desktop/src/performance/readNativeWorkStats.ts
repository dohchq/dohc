import { EngineFileObservation, type EngineWorkspace, type EngineWorkspaceSessions } from "@dohc/workspace-engine-client/daemon";
import type { NativeWorkStatsResult } from "./nativeWorkStats";

// The caller owns sender/workspace authorization. This read never opens a binding.
export async function readNativeWorkStats(
  sessions: EngineWorkspaceSessions | null,
  workspace: EngineWorkspace,
  assertCurrentRequest: () => void,
): Promise<NativeWorkStatsResult> {
  assertCurrentRequest();
  const unavailable = (reason: string): NativeWorkStatsResult => ({ workspaceId: workspace.workspaceId, status: "unavailable", reason });
  if (!sessions) return unavailable("Engine sessions unavailable.");
  let result: NativeWorkStatsResult;
  try {
    const stats = await sessions.runIfOpen(workspace, async binding => {
      const stats = await new EngineFileObservation(binding.client, binding.workspace).workStats();
      assertCurrentRequest();
      sessions.assertCurrentBinding(workspace, binding);
      return stats;
    });
    result = stats ? { workspaceId: workspace.workspaceId, status: "available", stats }
      : unavailable("No current open engine binding.");
  } catch (error) {
    result = unavailable(error instanceof Error ? error.message : String(error));
  }
  assertCurrentRequest();
  return result;
}
