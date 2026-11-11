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
// The live-session generation the key last moved for, or a shell's first read
// before any move, so a change every shell of the workspace sees moves it once.
// Forgotten once no shell reads the workspace, since main counts again then.
const keyedGenerations = new Map<string, number>();
const watchers = new Map<string, number>();
const reopenKeyListeners = new Set<() => void>();

/** Moves every editor and cell write in the workspace to a new session. */
export function advanceReopenKey(workspaceId: string): void {
  reopenKeys.set(workspaceId, (reopenKeys.get(workspaceId) ?? 0) + 1);
  for (const listener of reopenKeyListeners) listener();
}

/** A shell reads the workspace's live-session generation until the returned stop. */
export function watchLiveSessions(workspaceId: string): () => void {
  watchers.set(workspaceId, (watchers.get(workspaceId) ?? 0) + 1);
  return () => {
    const left = watchers.get(workspaceId)! - 1;
    if (left > 0) { watchers.set(workspaceId, left); return; }
    watchers.delete(workspaceId); keyedGenerations.delete(workspaceId);
  };
}

/**
 * A shell read main's live-session generation. `changed`: it differs from the
 * one this shell read before, so main retired every session in the workspace.
 * A shell's first read moves nothing, and a shell that opens after a change
 * reads its generation first, so only a change sets what the key moved for.
 */
export function observeLiveSessions(workspaceId: string, generation: number, changed: boolean): void {
  if (!changed) { if (!keyedGenerations.has(workspaceId)) keyedGenerations.set(workspaceId, generation); return; }
  if (keyedGenerations.get(workspaceId) === generation) return;
  keyedGenerations.set(workspaceId, generation);
  advanceReopenKey(workspaceId);
}

function subscribeReopenKeys(listener: () => void): () => void {
  reopenKeyListeners.add(listener);
  return () => reopenKeyListeners.delete(listener);
}

export function useReopenKey(workspaceId: string): number {
  return useSyncExternalStore(subscribeReopenKeys, () => reopenKeys.get(workspaceId) ?? 0);
}

