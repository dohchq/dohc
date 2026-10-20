import type {FirstOpenBaseBound} from "./firstOpenBase";
import type {FirstOpenReceipt} from "./storage/firstOpenEligibility";

/** The source a first-open request named. */
export interface FirstOpenSourceIdentity {
  readonly workspaceId: string;
  readonly objectId: string;
  readonly path: string;
  readonly sourceMomentId: string;
  readonly sourceDigest: string;
}

/**
 * What the caller does next. `pull`: pull the workspace normally, then capture
 * again; a receipt grants no readiness. `pull-current-source`: pull, then ask
 * again for the current source. `retry-later`: ask again on a later pass, with
 * backoff. `none`: asking again cannot help until the document's history or
 * content changes. `report`: stop; the details are for whoever runs the server.
 */
export type FirstOpenRecovery = "pull" | "pull-current-source" | "retry-later" | "none" | "report";

/**
 * Every answer the first-open route gives. Failures to read history, run the
 * worker, reach storage or stay within quota are not outcomes: they fail the
 * request, and never read as eligible or as a permanent refusal.
 * - `published` and `replayed` carry the base's real coordinates.
 * - `existing-history`: the document had live authority before; nothing was appended.
 * - `refused`: nothing was appended. `deletion` excludes the document for good,
 *   whatever was restored since. `too-large` names the bound in `code`.
 *   The service host reports `ordinary-activation-refused` after capture; the route never does.
 * - `unavailable`: `contention` when the workspace kept moving through every
 *   attempt, `busy` when no worker slot was free. Neither retains anything.
 * - `integrity`: the relay's own records disagree. Nothing was overwritten.
 */
export type FirstOpenOutcome = {readonly source: FirstOpenSourceIdentity; readonly recovery: FirstOpenRecovery} & (
  | {readonly kind: "published" | "replayed"; readonly receipt: FirstOpenReceipt}
  | {readonly kind: "existing-history"; readonly reason: "prior-authority"}
  | {readonly kind: "refused"; readonly reason: "deletion" | "stale-source" | "unsupported-source"}
  | {readonly kind: "refused"; readonly reason: "too-large"; readonly code: FirstOpenBaseBound}
  | {readonly kind: "refused"; readonly reason: "ordinary-activation-refused"; readonly code?: string}
  | {readonly kind: "unavailable"; readonly reason: "contention" | "busy"}
  | {readonly kind: "integrity"; readonly reason: "reserved-receipt" | "source-evidence" | "candidate"}
);

type Answer = FirstOpenOutcome extends infer O ? O extends unknown ? Omit<O, "source" | "recovery"> : never : never;

/** The one recovery each answer allows. */
export function firstOpenRecovery(answer: Answer): FirstOpenRecovery {
  switch (answer.kind) {
    case "published": case "replayed": case "existing-history": return "pull";
    case "unavailable": return "retry-later";
    case "integrity": return "report";
    case "refused":
      switch (answer.reason) {
        case "stale-source": return "pull-current-source";
        case "deletion": case "unsupported-source": case "too-large": return "none";
        case "ordinary-activation-refused": return "report";
      }
  }
}

export function firstOpenOutcome(source: FirstOpenSourceIdentity, answer: Answer): FirstOpenOutcome {
  const {workspaceId, objectId, path, sourceMomentId, sourceDigest} = source;
  return Object.freeze({...answer, source: Object.freeze({workspaceId, objectId, path, sourceMomentId, sourceDigest}),
    recovery: firstOpenRecovery(answer)}) as FirstOpenOutcome;
}
