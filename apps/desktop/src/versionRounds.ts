// The version round: how the CLI and the MCP change a workspace's versions
// without losing what an open window holds.
//
// Before the window changes versions itself, it saves the edits it hasn't
// sent and finishes its queued Collection writes, then moves its editors and
// history to the new version. A change from the CLI reaches main directly, so
// main asks each window showing the workspace to do the same first. Every
// window answers ready, holding new Collection writes, or refused with the
// reason. Only when all are ready does the change run. Then main sends the
// round's end, and each window moves to the version the change left active
// and stops holding.
//
// A window that never answers may be busy, so silence refuses the change and
// nothing changes. The deadline outlasts the window's own wait for its
// Collection writes, so a window that gives up says why first. A window that
// closed holds nothing and counts as ready.

import type { VersionRoundMessage } from "./ipc/bridgeContract";

export const VERSION_ROUND_TIMEOUT_MS = 30_000;
const SILENT_REASON = "A dohc window showing this workspace didn't save its open edits in time, so nothing changed. Try again.";

// What the windows hear after the change ran: the version it left active,
// or nothing when they should ask.
export type VersionChange = { activeVersionId?: string };

export function createVersionRounds<Window>(options: {
  // The windows showing the workspace whose renderer can answer.
  windowsShowing(workspaceId: string): readonly Window[];
  windowId(window: Window): number;
  isGone(window: Window): boolean;
  send(window: Window, message: VersionRoundMessage): void;
  timeoutMs?: number;
}) {
  const timeoutMs = options.timeoutMs ?? VERSION_ROUND_TIMEOUT_MS;
  let sequence = 0;
  const open = new Map<number, {
    readonly members: ReadonlyMap<number, Window>;
    readonly ready: Set<number>;
    settle(refusal: string | null): void;
  }>();

  function allReady(round: NonNullable<ReturnType<typeof open.get>>): boolean {
    return [...round.members].every(([id, window]) => round.ready.has(id) || options.isGone(window));
  }

  // An answer from a window outside the round, or for a round that ended,
  // counts for nothing.
  function answer(windowId: number, roundId: number, reply: { ready: true } | { ready: false; reason: string }): void {
    const round = open.get(roundId);
    if (!round?.members.has(windowId)) return;
    if (!reply.ready) {
      round.settle(reply.reason);
      return;
    }
    round.ready.add(windowId);
    if (allReady(round)) round.settle(null);
  }

  async function run<Result>(
    workspaceId: string,
    change: () => Promise<Result>,
    announce: { done(result: Result): VersionChange; failed?: VersionChange },
  ): Promise<Result> {
    const roundId = ++sequence;
    const members = new Map(options.windowsShowing(workspaceId).map(window => [options.windowId(window), window] as const));
    const end = (changed: VersionChange | null) => {
      for (const window of members.values()) {
        if (options.isGone(window)) continue;
        options.send(window, { kind: "end", roundId, changed: changed !== null, ...changed });
      }
    };
    if (members.size > 0) {
      const refusal = await new Promise<string | null>(resolve => {
        const ready = new Set<number>();
        const timer = setTimeout(() => round.settle(allReady(round) ? null : SILENT_REASON), timeoutMs);
        timer.unref?.();
        const round = {
          members, ready,
          settle(refusal: string | null) {
            clearTimeout(timer);
            open.delete(roundId);
            resolve(refusal);
          },
        };
        open.set(roundId, round);
        for (const window of members.values()) options.send(window, { kind: "begin", roundId, workspaceId });
      });
      if (refusal !== null) {
        end(null);
        throw new Error(refusal);
      }
    }
    let result: Result;
    try {
      result = await change();
    } catch (error) {
      end(announce.failed ?? null);
      throw error;
    }
    end(announce.done(result));
    return result;
  }

  return { run, answer };
}
