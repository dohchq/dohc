import type { SignIn } from "./account";
import {
  cacheScope,
  createWorkspaceData,
  type ReadCache,
  type WorkspaceData,
} from "./workspaceData";
import type { ChatMessage } from "./workspaceReads";
import { isJoined, type WorkspaceListStore } from "./workspaceList";

export interface OpenWorkspaceState {
  readonly currentWorkspaceId: string | null;
  readonly data: WorkspaceData | null;
  /** The choice saved last is still being read, so nothing is open yet and the list can't say why. */
  readonly choosing: boolean;
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
  /** A read of a workspace showed these messages, for the outbox's handoff. */
  readonly onMessages?: (workspaceId: string, messages: readonly ChatMessage[]) => void;
  /** The open workspace becomes `workspaceId`, before the open store stops (appTeardown). */
  readonly beforeSwitch?: (workspaceId: string | null) => void;
  readonly onGone?: (workspaceId: string) => void;
}): OpenWorkspace {
  const { signIn, list, cache, onMessages, beforeSwitch, onGone } = options;
  const listeners = new Set<() => void>();
  const saved = cache.savedList(signIn);
  let chosen: string | null = null;
  let active = false;
  let stopped = false;
  let state: OpenWorkspaceState = {
    currentWorkspaceId: null,
    data: null,
    choosing: saved !== null,
  };
  let unsubscribe: (() => void) | null = null;

  function open(workspaceId: string, joined: boolean): WorkspaceData {
    const data = createWorkspaceData({
      signIn,
      workspaceId,
      joined,
      cache,
      onGone: () => {
        onGone?.(workspaceId);
        list.reload();
      },
      onMessages: onMessages && ((messages) => onMessages(workspaceId, messages)),
      // Only the store open now reopens; a later one has replaced any other.
      reopen: () => {
        if (!stopped && state.data === data) show(workspaceId);
      },
    });
    return data;
  }

  const joinedNow = (workspaceId: string) => {
    const listed = list.state();
    return listed.status === "ready" && isJoined(listed.workspaces, workspaceId);
  };

  /** Opens `workspaceId`, or none, in a new store, and stops the last one. */
  function show(workspaceId: string | null) {
    if (state.data) beforeSwitch?.(workspaceId);
    state.data?.stop();
    const data = workspaceId === null ? null : open(workspaceId, joinedNow(workspaceId));
    if (active) data?.resume();
    state = { currentWorkspaceId: workspaceId, data, choosing: false };
    for (const listener of listeners) listener();
  }

  function endChoosing() {
    if (!state.choosing) return update();
    state = { ...state, choosing: false };
    update();
    if (state.currentWorkspaceId === null) for (const listener of listeners) listener();
  }

  function update() {
    if (stopped || state.choosing) return;
    const listed = list.state();
    const openable =
      listed.status === "ready"
        ? listed.workspaces
            .filter((entry) => entry.showOnPhone && entry.canOpen)
            .map((entry) => entry.workspaceId)
        : [];
    const current = openable.find((workspaceId) => workspaceId === chosen) ?? openable[0] ?? null;
    const roleChanged =
      current !== null &&
      current === state.currentWorkspaceId &&
      state.data !== null &&
      state.data.joined !== joinedNow(current);
    if (roleChanged) cache.drop(cacheScope(signIn, current));
    if (current !== state.currentWorkspaceId || roleChanged) show(current);
  }

  update();
  void saved?.loadChosen().then((found) => {
    if (stopped || !signIn.isCurrent()) return;
    chosen ??= found;
    endChoosing();
  });
  return {
    state: () => state,
    subscribe(listener) {
      listeners.add(listener);
      if (!unsubscribe) {
        unsubscribe = list.subscribe(update);
        update();
      }
      return () => void listeners.delete(listener);
    },
    choose(workspaceId) {
      chosen = workspaceId;
      if (!stopped && signIn.isCurrent()) saved?.chose(workspaceId);
      endChoosing();
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
