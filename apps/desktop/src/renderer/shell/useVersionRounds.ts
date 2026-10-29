import { useEffect, useRef } from "react";
import { bridge } from "../bridge";
import { ipcErrorMessage } from "../ipcError";

const LEFT_REASON = "A dohc window left this workspace while the change waited, so nothing changed. Try again.";

// A version change from the CLI or the MCP reaches main, not this window, so
// main asks first (versionRounds.ts). The window saves its open edits and
// holds Collection writes as it does before its own switch, then answers.
// When the round ends, it moves to the version the change left active and
// lets go.
export function useVersionRounds(
  workspaceId: string,
  beginLineageOperation: () => Promise<() => void>,
  onWorkspaceStateChanged: (activeVersionId?: string) => void,
): void {
  const begin = useRef(beginLineageOperation);
  const changed = useRef(onWorkspaceStateChanged);
  begin.current = beginLineageOperation;
  changed.current = onWorkspaceStateChanged;

  useEffect(() => {
    // Each open round's release, or null while the window is still saving.
    const holds = new Map<number, (() => void) | null>();
    const unsubscribe = bridge().onVersionRound((message) => {
      const { roundId } = message;
      if (message.kind === "end") {
        if (!holds.has(roundId)) return;
        const release = holds.get(roundId);
        holds.delete(roundId);
        if (message.changed) changed.current(message.activeVersionId);
        release?.();
        return;
      }
      if (message.workspaceId !== workspaceId) {
        void bridge().answerVersionRound({ roundId, ready: true }).catch(() => undefined);
        return;
      }
      holds.set(roundId, null);
      void begin.current().then(
        (release) => {
          // Main gave up waiting, or the window moved on.
          if (!holds.has(roundId)) return release();
          holds.set(roundId, release);
          return bridge().answerVersionRound({ roundId, ready: true });
        },
        (error: unknown) => {
          holds.delete(roundId);
          const reason = ipcErrorMessage(error, "A dohc window couldn't save its open edits, so nothing changed.");
          return bridge().answerVersionRound({ roundId, ready: false, reason: reason.slice(0, 1000) });
        },
      ).catch(() => undefined);
    });
    // Leaving the workspace lets go of its holds, so a change still waiting
    // on this window must not run on its earlier ready: if the window came
    // back, it would edit without holding while the change ran.
    return () => {
      unsubscribe();
      for (const [roundId, release] of holds) {
        void bridge().answerVersionRound({ roundId, ready: false, reason: LEFT_REASON }).catch(() => undefined);
        release?.();
      }
      holds.clear();
    };
  }, [workspaceId]);
}
