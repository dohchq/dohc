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

// Each workspace's reopenKey, which its shells' editors and a Collection cell
// write read from here. A cell write opens outside the shell, and it shares the
// session of an editor that has its record open only when both use the same
// key. Both read one store, so a change reaches them in the same render, and
// both release the old session before either opens the next.
const reopenKeys = new Map<string, number>();
// The live-session generation a shell of each workspace saw last, so a change
// every shell of the workspace sees moves the key once between them.
const seenGenerations = new Map<string, number>();
const reopenKeyListeners = new Set<() => void>();

/** Moves every editor and cell write in the workspace to a new session. */
export function advanceReopenKey(workspaceId: string): void {
  reopenKeys.set(workspaceId, (reopenKeys.get(workspaceId) ?? 0) + 1);
  for (const listener of reopenKeyListeners) listener();
}

/**
 * A shell read main's live-session generation. `changed`: it differs from the
 * one this shell read before, so main retired every session in the workspace.
 * A shell's first read only records it.
 */
export function observeLiveSessions(workspaceId: string, generation: number, changed: boolean): void {
  const seen = seenGenerations.get(workspaceId);
  seenGenerations.set(workspaceId, generation);
  if (changed && seen !== generation) advanceReopenKey(workspaceId);
}

function subscribeReopenKeys(listener: () => void): () => void {
  reopenKeyListeners.add(listener);
  return () => reopenKeyListeners.delete(listener);
}

export function useReopenKey(workspaceId: string): number {
  return useSyncExternalStore(subscribeReopenKeys, () => reopenKeys.get(workspaceId) ?? 0);
}
