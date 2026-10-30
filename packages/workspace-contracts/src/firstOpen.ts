/**
 * The relay's answers when a service host asks it to give a document with only
 * ordinary history its first live base, and how each answer reaches the
 * document's owner and their agents. The relay, owner status, the desktop and
 * its renderer share these types.
 */

/** How the engine refused a candidate, as `dohc_engine_collab::FirstOpenCandidateRefusal` names it. */
export const FIRST_OPEN_CANDIDATE_REFUSALS = ["malformed-candidate", "incomplete-candidate", "invalid-public-baseline", "projection-failed", "settlement-mismatch"] as const;
export type FirstOpenCandidateRefusal = (typeof FIRST_OPEN_CANDIDATE_REFUSALS)[number];

/** The source a first-open request named. */
export interface FirstOpenSourceIdentity {
  readonly workspaceId: string;
  readonly objectId: string;
  readonly path: string;
  readonly sourceMomentId: string;
  readonly sourceDigest: string;
}

/** Where a first-open base sits in the relay log: always the first coordinate of its reserved origin. */
export interface FirstOpenReceipt {readonly originId: string; readonly originSeq: 0; readonly relaySeq: number}

/** A configured bound a base does not fit. `validation-budget`: the registration validator ran out of its configured policy. */
const FIRST_OPEN_BASE_BOUNDS = ["update-limit", "capture-budget", "read-budget", "validation-budget"] as const;
export type FirstOpenBaseBound = (typeof FIRST_OPEN_BASE_BOUNDS)[number];

/**
 * Why a file is too large to go live automatically: a bound its base does not
 * fit, or `source-limit`: the file is longer than a live document can be;
 * `host-capacity`: the service host's configuration can never fit this check
 * until its operator raises it; `seed-worker-capacity`: building the base ran
 * the relay's first-open worker out of memory, as it would on every try.
 */
export const FIRST_OPEN_TOO_LARGE_CODES = [...FIRST_OPEN_BASE_BOUNDS, "source-limit", "host-capacity", "seed-worker-capacity"] as const;
type FirstOpenTooLargeCode = (typeof FIRST_OPEN_TOO_LARGE_CODES)[number];

/**
 * Why a current file cannot start live. The engine's own causes name how it
 * refused the candidate. `not-utf8`: the file is not UTF-8 text.
 * `relay-projection`: the relay's validator does not read the candidate back
 * as the file, or the file holds what the live schema cannot, such as a link
 * around inline code or containers nested past the live document contract.
 */
export const FIRST_OPEN_UNSUPPORTED_CAUSES = [...FIRST_OPEN_CANDIDATE_REFUSALS, "not-utf8", "relay-projection"] as const;
type FirstOpenUnsupportedCause = (typeof FIRST_OPEN_UNSUPPORTED_CAUSES)[number];

/** Which of the relay's own records, or what it told the engine, disagree. */
export const FIRST_OPEN_INTEGRITY_CODES = ["reserved-receipt", "source-evidence", "candidate", "check-evidence"] as const;
type FirstOpenIntegrityCode = (typeof FIRST_OPEN_INTEGRITY_CODES)[number];

/** The shape of the code a service host gives an `ordinary-activation-refused` answer, at most 128 characters. */
export const FIRST_OPEN_ACTIVATION_CODE = /^[a-z0-9][a-z0-9-]{0,127}$/;

/** A step that failed for a reason a later request can outlast. */
export type FirstOpenFailure = "history-unavailable" | "worker-failed" | "storage-failed";

/**
 * Why the service host's engine gave no verdict. `host-absent`: no host runs,
 * or it retired, exited or detached the workspace. `host-unreachable`: the
 * connection to it failed. `check-failed`: the check itself failed.
 * `check-deadline`: it did not answer in time.
 */
export type FirstOpenHostFailure = "host-absent" | "host-unreachable" | "check-failed" | "check-deadline";

/**
 * What the caller does next. `pull`: pull the workspace normally, then capture
 * again; a receipt grants no readiness. `pull-current-source`: pull, then ask
 * again for the current source. `retry-later`: ask again on a later pass,
 * waiting longer each time the same answer repeats. `none`: asking again cannot
 * help until the document's history or content changes. `report`: stop; the
 * details are for whoever runs the server.
 */
export const FIRST_OPEN_RECOVERIES = ["pull", "pull-current-source", "retry-later", "none", "report"] as const;
export type FirstOpenRecovery = (typeof FIRST_OPEN_RECOVERIES)[number];

/**
 * Every answer the first-open route gives. Cancellation, shutdown, a timeout,
 * quota, authorization and the relay's own faults are not outcomes: they keep
 * their own request errors.
 * - `published` and `replayed` carry the base's real coordinates.
 * - `existing-history`: the document had live authority before; nothing was appended.
 * - `refused`: nothing was appended. `deletion` excludes the document for good,
 *   whatever was restored since. `unsupported-source` names its `cause`.
 *   `too-large` names the bound in `code`. The service host reports
 *   `ordinary-activation-refused` after capture; the route never does.
 * - `unavailable`: the document's history says nothing yet. `contention`: the
 *   workspace kept moving through every attempt. `busy`: no worker slot or
 *   engine capacity was free. `reconfigured`: the validation policy changed
 *   after the base was built under it. `history-unavailable`: its history could not be
 *   read. `worker-failed`: the worker building the base failed, other than by
 *   running out of memory. `build-deadline`: building the base took longer
 *   than the relay allows, so it ended the worker; a slow host proves nothing
 *   about the note. The relay builds the same source again only after
 *   `retryAfterMs`, which doubles each time the build repeats this, up to an
 *   hour; an edit is a new source. The host failures say why the engine gave
 *   no verdict. Nothing was appended for any of these.
 *   `storage-failed`: the relay database failed in
 *   a way that can pass, possibly while committing the base; asking again
 *   replays any base that was appended. The relay logs the failures.
 * - `integrity`: the relay's own records, or what it told the engine, disagree.
 *   Nothing was overwritten.
 */
export type FirstOpenOutcome = {readonly source: FirstOpenSourceIdentity; readonly recovery: FirstOpenRecovery} & (
  | {readonly kind: "published" | "replayed"; readonly receipt: FirstOpenReceipt}
  | {readonly kind: "existing-history"; readonly reason: "prior-authority"}
  | {readonly kind: "refused"; readonly reason: "deletion" | "stale-source"}
  | {readonly kind: "refused"; readonly reason: "unsupported-source"; readonly cause: FirstOpenUnsupportedCause}
  | {readonly kind: "refused"; readonly reason: "too-large"; readonly code: FirstOpenTooLargeCode}
  | {readonly kind: "refused"; readonly reason: "ordinary-activation-refused"; readonly code?: string}
  | {readonly kind: "unavailable"; readonly reason: "contention" | "busy" | "reconfigured" | FirstOpenFailure | FirstOpenHostFailure}
  | {readonly kind: "unavailable"; readonly reason: "build-deadline"; readonly retryAfterMs: number}
  | {readonly kind: "integrity"; readonly reason: FirstOpenIntegrityCode}
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

/** Throws for an `ordinary-activation-refused` code outside `FIRST_OPEN_ACTIVATION_CODE`, so no reader meets one. */
export function firstOpenOutcome(source: FirstOpenSourceIdentity, answer: Answer): FirstOpenOutcome {
  if (answer.kind === "refused" && answer.reason === "ordinary-activation-refused" && answer.code !== undefined &&
    !FIRST_OPEN_ACTIVATION_CODE.test(answer.code)) throw new Error("A refused activation code must be lowercase letters, digits and hyphens.");
  const {workspaceId, objectId, path, sourceMomentId, sourceDigest} = source;
  return Object.freeze({...answer, source: Object.freeze({workspaceId, objectId, path, sourceMomentId, sourceDigest}),
    recovery: firstOpenRecovery(answer)}) as FirstOpenOutcome;
}

/**
 * What each answer means to the document's owner. `refusal`: live editing
 * cannot start for this file until something changes, so the owner gets a
 * Notice. `transient`: a later request can get another answer, so nobody is
 * told yet. `none`: nothing stopped; the host pulls the history it names.
 */
export const FIRST_OPEN_OWNER_NOTICE = {
  "published": "none", "replayed": "none", "prior-authority": "none", "stale-source": "none",
  "unavailable": "transient",
  "deletion": "refusal", "unsupported-source": "refusal", "too-large": "refusal", "ordinary-activation-refused": "refusal", "integrity": "refusal",
} as const satisfies Record<FirstOpenReason, "refusal" | "transient" | "none">;
export type FirstOpenRefusalReason = {[R in FirstOpenReason]: (typeof FIRST_OPEN_OWNER_NOTICE)[R] extends "refusal" ? R : never}[FirstOpenReason];
export const FIRST_OPEN_REFUSAL_REASONS = ["deletion", "unsupported-source", "too-large", "ordinary-activation-refused", "integrity"] as const satisfies readonly FirstOpenRefusalReason[];

/** A source stopped after three deadlines. An edit or the owner's retry starts a new attempt sequence. */
export interface FirstOpenTemporaryStop {
  readonly source: FirstOpenSourceIdentity;
  readonly reason: "retry-stopped";
  readonly code: "build-deadline";
  readonly deadlineAnswers: 3;
  readonly recovery: "retry-later";
}

/** An answer that stops live editing for one file, as its owner and their agents read it. */
export type FirstOpenRefusal = {readonly source: FirstOpenSourceIdentity; readonly recovery: FirstOpenRecovery} & (
  | {readonly reason: "deletion"}
  | {readonly reason: "unsupported-source"; readonly code: FirstOpenUnsupportedCause}
  | {readonly reason: "too-large"; readonly code: FirstOpenTooLargeCode}
  | {readonly reason: "ordinary-activation-refused"; readonly code?: string}
  | {readonly reason: "integrity"; readonly code: FirstOpenIntegrityCode}
);

/**
 * Every answer as one stable reason, the specific code where the answer has
 * one, the source it names and what to do next. Agents read these fields;
 * nothing here is text to parse.
 */
export type FirstOpenReport = FirstOpenRefusal | ({readonly source: FirstOpenSourceIdentity; readonly recovery: FirstOpenRecovery} & (
  | {readonly reason: "published" | "replayed" | "prior-authority" | "stale-source"}
  | {readonly reason: "unavailable"; readonly code: Exclude<Extract<FirstOpenOutcome, {kind: "unavailable"}>["reason"], "build-deadline">}
  | {readonly reason: "unavailable"; readonly code: "build-deadline"; readonly retryAfterMs: number}
));
export type FirstOpenReason = "published" | "replayed" | "prior-authority" | "deletion" | "stale-source" | "unsupported-source" | "too-large" |
  "ordinary-activation-refused" | "unavailable" | "integrity";

export function firstOpenReport(outcome: FirstOpenOutcome): FirstOpenReport {
  const {source, recovery} = outcome;
  switch (outcome.kind) {
    case "published": case "replayed": return {reason: outcome.kind, source, recovery};
    case "existing-history": return {reason: outcome.reason, source, recovery};
    case "integrity": return {reason: "integrity", code: outcome.reason, source, recovery};
    case "unavailable":
      return outcome.reason === "build-deadline"
        ? {reason: "unavailable", code: outcome.reason, retryAfterMs: outcome.retryAfterMs, source, recovery}
        : {reason: "unavailable", code: outcome.reason, source, recovery};
    case "refused":
      switch (outcome.reason) {
        case "deletion": case "stale-source": return {reason: outcome.reason, source, recovery};
        case "unsupported-source": return {reason: outcome.reason, code: outcome.cause, source, recovery};
        case "too-large": return {reason: outcome.reason, code: outcome.code, source, recovery};
        case "ordinary-activation-refused":
          return {reason: outcome.reason, ...(outcome.code === undefined ? {} : {code: outcome.code}), source, recovery};
      }
  }
}

/** The refusal an answer reports to the owner, or undefined when it stops nothing. */
export function firstOpenRefusal(outcome: FirstOpenOutcome): FirstOpenRefusal | undefined {
  const report = firstOpenReport(outcome);
  return FIRST_OPEN_OWNER_NOTICE[report.reason] === "refusal" ? report as FirstOpenRefusal : undefined;
}
