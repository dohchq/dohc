import type { AgentThreadLine, AgentThreadLinesEvent } from "../../ipc/bridgeContract";
import { bridge } from "../bridge";

const NONE: readonly AgentThreadLine[] = [];

// What each agent's thread is doing with the last message dohc forwarded to
// it from each chat thread of one workspace. Main pushes every change. The
// store listens first and then reads once, so no change falls between the
// two, and it costs no timer. An answer for another workspace, or one no
// newer than the one held, is dropped, so a slow first read never replaces a
// change that arrived while it ran.
export function createAgentThreadLinesStore(
  workspaceId: string,
  onReadError: (error: unknown, retry: () => void) => void,
) {
  let revision = -1;
  let lines = NONE;
  const listeners = new Set<() => void>();
  let stopListening: (() => void) | null = null;
  // Counts each time the store starts listening, so an answer to a read made
  // for an earlier time says nothing about this one.
  let listening = 0;

  function receive(event: AgentThreadLinesEvent): void {
    if (event.workspaceId !== workspaceId || event.revision <= revision) return;
    revision = event.revision;
    if (event.lines.length === 0 && lines.length === 0) return;
    lines = event.lines;
    for (const listener of [...listeners]) listener();
  }

  // A Try again after the store stopped showing does nothing.
  function read(): void {
    if (!stopListening) return;
    const during = listening;
    void bridge()
      .readAgentThreadLines({ workspaceId })
      .then(receive, (error: unknown) => {
        if (stopListening && during === listening) onReadError(error, read);
      });
  }

  return {
    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      if (!stopListening) {
        listening += 1;
        stopListening = bridge().onAgentThreadLines(receive);
        read();
      }
      return () => {
        listeners.delete(listener);
        if (listeners.size > 0) return;
        stopListening?.();
        stopListening = null;
      };
    },
    lines: () => lines,
  };
}

export type AgentThreadLinesStore = ReturnType<typeof createAgentThreadLinesStore>;
