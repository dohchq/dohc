import { useMemo, useRef, useSyncExternalStore } from "react";
import type { AgentRunStateEvent } from "../../ipc/bridgeContract";
import { bridge } from "../bridge";

// Whether this computer's agent is running in one workspace. Main pushes each
// change of the workspace's run slot. The store reads once when it is first
// shown and then only listens, so an idle workspace costs no reads and no
// timers. An answer for another workspace, or older than the one shown, is
// dropped.
export function createAgentRunStateStore(
  workspaceId: string,
  onReadError: (error: unknown, retry: () => void) => void,
) {
  let revision = -1;
  let active = false;
  const listeners = new Set<() => void>();
  let stopListening: (() => void) | null = null;

  function receive(event: AgentRunStateEvent): void {
    if (event.workspaceId !== workspaceId || event.revision <= revision) return;
    revision = event.revision;
    if (event.active === active) return;
    active = event.active;
    for (const listener of [...listeners]) listener();
  }

  // A Try again after the store stopped showing does nothing.
  function read(): void {
    if (!stopListening) return;
    void bridge().readAgentRunState({ workspaceId }).then(receive, (error: unknown) => {
      if (stopListening) onReadError(error, read);
    });
  }

  return {
    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      if (!stopListening) {
        stopListening = bridge().onAgentRunState(receive);
        read();
      }
      return () => {
        listeners.delete(listener);
        if (listeners.size > 0) return;
        stopListening?.();
        stopListening = null;
      };
    },
    active: () => active,
  };
}

export function useAgentRunActive(
  workspaceId: string,
  onReadError: (error: unknown, retry: () => void) => void,
): boolean {
  const report = useRef(onReadError);
  report.current = onReadError;
  const store = useMemo(
    () => createAgentRunStateStore(workspaceId, (error, retry) => report.current(error, retry)),
    [workspaceId],
  );
  return useSyncExternalStore(store.subscribe, store.active);
}
