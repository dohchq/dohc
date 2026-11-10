import type { SignIn } from "./account";
import { cacheScope, createWorkspaceData, type ReadCache, type WorkspaceData } from "./workspaceData";
import type { WorkspaceListStore } from "./workspaceList";

// The workspace open on the phone, and the store that reads it. The open workspace is the one the person chose in the
// switcher, or else the first the list shows on the phone that the server can open. Changing it stops the last store
// and makes another, so nothing the last one started can reach the screen.
//
// A store that the server answers 404 has stopped and cleared itself, and the list is read again to decide. If the
// list no longer shows the workspace, or the server can't open it, the phone opens the next. If it still shows it, it
// stays open, empty, as a failed read, until Try again opens it in a new store. Nothing opens again by itself, so a
// workspace that keeps answering 404 can't make the phone loop.

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
  let chosen: string | null = null;
  let active = false;
  let stopped = false;
  let state: OpenWorkspaceState = { currentWorkspaceId: null, data: null };
  let unsubscribe: (() => void) | null = null;

  function open(workspaceId: string): WorkspaceData {
    const data = createWorkspaceData({
      signIn, workspaceId, cache,
      onGone: () => list.reload(),
      // Only the store open now reopens; a later one has replaced any other.
      reopen: () => {
        if (!stopped && state.data === data) show(workspaceId);
      },
    });
    return data;
  }

  /** Opens `workspaceId`, or none, in a new store, and stops the last one. */
  function show(workspaceId: string | null) {
    state.data?.stop();
    const data = workspaceId === null ? null : open(workspaceId);
    if (active) data?.resume();
    state = { currentWorkspaceId: workspaceId, data };
    for (const listener of listeners) listener();
  }

  function update() {
    if (stopped) return;
    const listed = list.state();
    const openable = listed.status === "ready"
      ? listed.workspaces.filter(entry => entry.showOnPhone && entry.canOpen).map(entry => entry.workspaceId) : [];
    const current = openable.find(workspaceId => workspaceId === chosen) ?? openable[0] ?? null;
    if (current !== state.currentWorkspaceId) show(current);
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
