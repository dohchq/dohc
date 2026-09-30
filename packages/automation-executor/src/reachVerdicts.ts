import { z } from "zod";
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
//
// Verdicts follow the automation host. A computer that hands over releases
// its verdicts with its Group handover, and the next host takes them before
// it runs anything, so a step stopped on one host stays stopped on the next.
// A host that starts with no verdicts to take, after a take over, cannot
// prove its own are current: in a workspace that was ever shared, it holds
// every step it would allow until a current editor confirms it.

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

export const StoredReachVerdictSchema = z.object({
  automationId: z.string().min(1),
  definitionHash: z.string().min(1),
  step: z.string().min(1).max(512),
  verdict: z.enum(["allowed", "stopped", "held"]),
  stoppedFor: z.string().nullable(),
  narrowed: z.literal(true).optional(),
  accountedLinks: z.array(z.string().min(1)).optional(),
  seq: z.number().int().nonnegative(),
  recipient: z.object({ id: z.string(), name: z.string(), action: z.enum(["post", "notify", "change"]) }).optional(),
});

/**
 * What a release carries as `reach`, and what the next host takes: the
 * releasing computer's verdicts, the definitions whose history it could not
 * prove, by definitionKey, so the next host holds their unseen steps too,
 * `unprovenAll` while it could not prove any definition it had not seen,
 * and the Collections whose automations it could not list, where any
 * definition it had not seen waits as well.
 */
export interface ReachHandover {
  version: 2;
  verdicts: StoredReachVerdict[];
  unproven: string[];
  unprovenAll: boolean;
  unprovenFolders: string[];
  unprovenPaths: string[];
}

const ReachHandoverSchema = z.object({
  version: z.literal(2),
  verdicts: z.array(StoredReachVerdictSchema),
  unproven: z.array(z.string()),
  unprovenAll: z.boolean(),
  unprovenFolders: z.array(z.string()),
  unprovenPaths: z.array(z.string()),
});

/** What a release carried, or null when it carried none or nothing this computer can read. */
export function parseReachHandover(value: unknown): ReachHandover | null {
  const parsed = ReachHandoverSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/** A definition's key among the unproven ones. */
export function definitionKey(automationId: string, hash: string): string {
  return JSON.stringify([automationId, hash]);
}

/**
 * The relay's last release or take over, as the next host reads it at its
 * generation: `generation` 0 for none, `reach` when a release left it for
 * this computer, and whether the workspace was ever shared.
 */
export interface ReachRelayRecord {
  generation: number;
  reach: ReachHandover | null;
  everShared: boolean;
}

/**
 * One step's verdict after the next host took the last host's: a step
 * stopped or held on either side stays so, and an allowed verdict counts
 * only where this computer has none. Both are for the same definition,
 * since the key names it.
 */
export function mergedReachVerdict(local: StoredReachVerdict | undefined, taken: StoredReachVerdict): StoredReachVerdict | undefined {
  if (local === undefined) return taken;
  if (local.verdict !== "allowed" || taken.verdict === "allowed") return undefined;
  return taken;
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
