import { useSyncExternalStore } from "react";

export function documentKey(workspaceId: string, path: string): string {
  return JSON.stringify([workspaceId, path]);
}

export function documentVersionKey(
  workspaceId: string,
  path: string,
  reopenKey: number | undefined,
): string {
  return JSON.stringify([workspaceId, path, reopenKey ?? null]);
}

// Each workspace shell's versionEpoch, its editors' reopenKey. A Collection
// cell write opens outside the shell, and it shares the session of an editor
// that has its record open only when both use the same key.
const reopenKeys = new Map<string, number>();
const reopenKeyListeners = new Set<() => void>();

export function publishReopenKey(workspaceId: string, reopenKey: number): void {
  if (reopenKeys.get(workspaceId) === reopenKey) return;
  reopenKeys.set(workspaceId, reopenKey);
  for (const listener of reopenKeyListeners) listener();
}

function subscribeReopenKeys(listener: () => void): () => void {
  reopenKeyListeners.add(listener);
  return () => reopenKeyListeners.delete(listener);
}

export function useReopenKey(workspaceId: string): number | undefined {
  return useSyncExternalStore(subscribeReopenKeys, () => reopenKeys.get(workspaceId));
}
