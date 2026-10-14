import { WorkspaceSyncPause, workspaceSyncPauseStatus } from "@dohc/workspace-contracts/workspace-sync";
import type { RegistryEntry } from "./registryStore";

export function syncPauseFor(workspace: RegistryEntry, localPersonId: string) {
  if (workspace.shareView) return undefined;
  const pause = WorkspaceSyncPause.safeParse(workspace.syncPause);
  return pause.success ? workspaceSyncPauseStatus(pause.data, localPersonId) : undefined;
}
