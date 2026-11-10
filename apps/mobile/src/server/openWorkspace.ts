import type { SignIn } from "./account";
import { cacheScope, createWorkspaceData, type ReadCache, type WorkspaceData } from "./workspaceData";
import type { WorkspaceListStore } from "./workspaceList";

// The workspace open on the phone, and the store that reads it. The open workspace is the one the person chose in the
// switcher, or else the first the list shows on the phone. Changing it stops the last store and makes another, so
// nothing the last one started can reach the screen.
//
// A store that the server answers 404 has stopped and cleared itself: the workspace is hidden from the phone on
// another device, or no longer the account's. It isn't opened again, and the list is read again so the phone opens
// another. Once the list no longer shows it, or the person chooses it, it can open again.

export interface OpenWorkspaceState {
  readonly currentWorkspaceId: string | null;
  readonly data: WorkspaceData | null;
}

export interface OpenWorkspace {
  state(): OpenWorkspaceState;
  subscribe(listener: () => void): () => void;
  choose(workspaceId: string): void;
  /** Changes Show on phone. Hiding a workspace drops what the phone read of it. */
  setShowOnPhone(workspaceId: string, showOnPhone: boolean): void;
  /** Runs the open store's feed, and each one opened after, until `pause`. */
  resume(): void;
  pause(): void;
  stop(): void;
}

export function createOpenWorkspace(options: {
  readonly signIn: Pick<SignIn, "client" | "isCurrent" | "origin" | "userId">;
  readonly list: WorkspaceListStore;
  readonly cache: ReadCache;
}): OpenWorkspace {
  const { signIn, list, cache } = options;
  const listeners = new Set<() => void>();
  const gone = new Set<string>();
  let chosen: string | null = null;
  let active = false;
  let stopped = false;
  let state: OpenWorkspaceState = { currentWorkspaceId: null, data: null };
  let unsubscribe: (() => void) | null = null;

  function open(workspaceId: string): WorkspaceData {
    return createWorkspaceData({
      signIn, workspaceId, cache,
      onGone: () => {
        gone.add(workspaceId);
        list.reload();
        update();
      },
    });
  }

  function update() {
    if (stopped) return;
    const listed = list.state();
    const shown = listed.status === "ready" ? listed.workspaces.filter(entry => entry.showOnPhone).map(entry => entry.workspaceId) : [];
    for (const workspaceId of gone) if (!shown.includes(workspaceId)) gone.delete(workspaceId);
    const candidates = shown.filter(workspaceId => !gone.has(workspaceId));
    const current = candidates.find(workspaceId => workspaceId === chosen) ?? candidates[0] ?? null;
    if (current === state.currentWorkspaceId) return;
    state.data?.stop();
    const data = current === null ? null : open(current);
    if (active) data?.resume();
    state = { currentWorkspaceId: current, data };
    for (const listener of listeners) listener();
  }

  update();
  return {
    state: () => state,
    subscribe(listener) {
      listeners.add(listener);
      // The list is followed from the first subscriber, so making this starts nothing.
      if (!unsubscribe) {
        unsubscribe = list.subscribe(update);
        update();
      }
      return () => void listeners.delete(listener);
    },
    choose(workspaceId) {
      chosen = workspaceId;
      gone.delete(workspaceId);
      update();
    },
    setShowOnPhone(workspaceId, showOnPhone) {
      list.setShowOnPhone(workspaceId, showOnPhone);
      if (!showOnPhone) cache.drop(cacheScope(signIn, workspaceId));
    },
    resume() {
      active = true;
      state.data?.resume();
    },
    pause() {
      active = false;
      state.data?.pause();
    },
    stop() {
      stopped = true;
      unsubscribe?.();
      state.data?.stop();
    },
  };
}
