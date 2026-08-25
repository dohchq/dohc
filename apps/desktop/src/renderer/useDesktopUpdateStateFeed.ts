import { useCallback, useEffect, useRef, useState } from "react";
import type { UpdateStateEvent } from "../ipc/bridgeContract";
import { bridge } from "./bridge";

export interface DesktopUpdateStateSource {
  getUpdateState(): Promise<UpdateStateEvent>;
  onUpdateState(listener: (state: UpdateStateEvent) => void): () => void;
}

export interface DesktopUpdateStateFollower {
  acceptUpdateResult(state: UpdateStateEvent): void;
  stop(): void;
}

/**
 * Follows the desktop update state without leaving a gap between the initial
 * snapshot and live events. Once a live event or command result arrives, the
 * older snapshot can no longer commit. Cleanup rejects every late source.
 */
export function followDesktopUpdateState(
  source: DesktopUpdateStateSource,
  acceptState: (state: UpdateStateEvent) => void,
  acceptLiveState?: (state: UpdateStateEvent) => void,
): DesktopUpdateStateFollower {
  let acceptsState = true;
  let receivedNewerState = false;
  const acceptNewerState = (state: UpdateStateEvent) => {
    if (!acceptsState) return;
    receivedNewerState = true;
    acceptState(state);
  };
  const unsubscribe = source.onUpdateState((state) => {
    if (!acceptsState) return;
    acceptNewerState(state);
    acceptLiveState?.(state);
  });

  void source.getUpdateState().then(
    (state) => {
      if (acceptsState && !receivedNewerState) acceptState(state);
    },
    () => undefined,
  );

  return {
    acceptUpdateResult: acceptNewerState,
    stop: () => {
      acceptsState = false;
      unsubscribe();
    },
  };
}

export function useDesktopUpdateStateFeed(
  acceptLiveState?: (state: UpdateStateEvent) => void,
): {
  updateState: UpdateStateEvent | null;
  acceptUpdateResult: (state: UpdateStateEvent) => void;
} {
  const [updateState, setUpdateState] = useState<UpdateStateEvent | null>(null);
  const followerRef = useRef<DesktopUpdateStateFollower | null>(null);
  const acceptLiveStateRef = useRef(acceptLiveState);
  acceptLiveStateRef.current = acceptLiveState;
  const acceptUpdateResult = useCallback((state: UpdateStateEvent) => {
    followerRef.current?.acceptUpdateResult(state);
  }, []);

  useEffect(() => {
    const follower = followDesktopUpdateState(
      bridge(),
      setUpdateState,
      (state) => acceptLiveStateRef.current?.(state),
    );
    followerRef.current = follower;
    return () => {
      if (followerRef.current === follower) followerRef.current = null;
      follower.stop();
    };
  }, []);

  return { updateState, acceptUpdateResult };
}
