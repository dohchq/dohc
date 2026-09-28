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
//
// A share link that wrote a Collection's automations and then stopped
// editing may have written a step before this computer ever checked it
// with the link as an editor. So a step that link could not have run waits
// once, whatever its last verdict, and the verdict remembers the link so a
// confirmation is not asked for again.

export type ReachVerdict = "allowed" | "stopped" | "held";

export interface StoredReachVerdict {
  /** The engine automation id. */
  automationId: string;
  definitionHash: string;
  /** The step's place among the steps the reach check sees, or, with `recipient`, the step's place in the automation. */
  step: string;
  /**
   * A person a formula named, whose message the step sends, or a Collection
   * a code step named, whose records it changes. Each gets a verdict of its
   * own the first time a run names it. `id` is the person's user id or the
   * Collection's path.
   */
  recipient?: { id: string; name: string; action: "post" | "notify" | "change" };
  verdict: ReachVerdict;
  /** The editor whose reach stopped the step, kept while it is held. */
  stoppedFor: string | null;
  /** The step could run before reach narrowed, and nobody has dismissed its notice. */
  narrowed?: true;
  /** The former links' evidence this step has already waited for, as "grant#generation". */
  accountedLinks?: readonly string[];
  seq: number;
}

type Verdict = Pick<StoredReachVerdict, "verdict" | "stoppedFor" | "narrowed" | "accountedLinks">;

/**
 * The verdict to keep for one step, given its last one and what the roster
 * says now. `switchedOn` says whether its automation runs, so a step that
 * never ran is not announced as stopped.
 */
export function nextReachVerdict(previous: Verdict | undefined, reach: StepReach, switchedOn: boolean): Verdict {
  const accounted = previous?.accountedLinks ?? [];
  const kept = accounted.length === 0 ? {} : { accountedLinks: accounted };
  if (!reach.allowed) {
    const narrowed = switchedOn &&
      (previous?.verdict === "allowed" || (previous?.verdict === "stopped" && previous.narrowed === true));
    return { verdict: "stopped", stoppedFor: reach.person ?? null, ...(narrowed ? { narrowed: true } : {}), ...kept };
  }
  const formerStops = reach.formerStops ?? [];
  const accountedLinks = [...new Set([...accounted, ...formerStops.map((stop) => stop.evidence)])].sort();
  const withLinks = accountedLinks.length === 0 ? {} : { accountedLinks };
  if (previous?.verdict === "stopped" || previous?.verdict === "held") {
    return { verdict: "held", stoppedFor: previous.stoppedFor, ...withLinks };
  }
  const unaccounted = formerStops.find((stop) => !accounted.includes(stop.evidence));
  if (unaccounted) return { verdict: "held", stoppedFor: unaccounted.name, ...withLinks };
  return { verdict: "allowed", stoppedFor: null, ...kept };
}

/** Whether two verdicts would be saved the same. */
export function sameReachVerdict(left: Verdict | undefined, right: Verdict): boolean {
  return left?.verdict === right.verdict && left.stoppedFor === right.stoppedFor && left.narrowed === right.narrowed &&
    (left.accountedLinks ?? []).join("\n") === (right.accountedLinks ?? []).join("\n");
}

export function reachVerdictKey(automationId: string, definitionHash: string, step: string, recipient?: string): string {
  return JSON.stringify(recipient === undefined ? [automationId, definitionHash, step] : [automationId, definitionHash, step, recipient]);
}
