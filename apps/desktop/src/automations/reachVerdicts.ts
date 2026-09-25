import type { StepReach } from "./automationReach";

// The reach check (ADR 0012) answers for the editors a Collection has now.
// When an editor leaves, a step they could not have run by hand can become
// allowed without anyone changing it. Removing someone must never switch on
// what they wrote, so the executor keeps each step's last verdict, and a
// step that goes from stopped to allowed under the same definition is held
// until a current editor confirms it.
//
// The other way, a share can narrow reach. A switched-on step that could
// run and now cannot is marked narrowed, and a notice names it until someone
// dismisses it or the step's reach comes back.
//
// Verdicts carry a sequence number from a counter that only rises, so a
// confirmation or a dismissal applies only to the verdict the person saw,
// whatever the clock.

export type ReachVerdict = "allowed" | "stopped" | "held";

export interface StoredReachVerdict {
  /** The engine automation id. */
  automationId: string;
  definitionHash: string;
  /** The step's place among the steps the reach check sees. */
  step: number;
  verdict: ReachVerdict;
  /** The editor whose reach stopped the step, kept while it is held. */
  stoppedFor: string | null;
  /** The step could run before reach narrowed, and nobody has dismissed its notice. */
  narrowed?: true;
  seq: number;
}

type Verdict = Pick<StoredReachVerdict, "verdict" | "stoppedFor" | "narrowed">;

/**
 * The verdict to keep for one step, given its last one and what the roster
 * says now. `switchedOn` says whether its automation runs, so a step that
 * never ran is not announced as stopped.
 */
export function nextReachVerdict(previous: Verdict | undefined, reach: StepReach, switchedOn: boolean): Verdict {
  if (!reach.allowed) {
    const narrowed = switchedOn &&
      (previous?.verdict === "allowed" || (previous?.verdict === "stopped" && previous.narrowed === true));
    return { verdict: "stopped", stoppedFor: reach.person ?? null, ...(narrowed ? { narrowed: true } : {}) };
  }
  if (previous?.verdict === "stopped" || previous?.verdict === "held") {
    return { verdict: "held", stoppedFor: previous.stoppedFor };
  }
  return { verdict: "allowed", stoppedFor: null };
}

export function reachVerdictKey(automationId: string, definitionHash: string, step: number): string {
  return JSON.stringify([automationId, definitionHash, step]);
}
