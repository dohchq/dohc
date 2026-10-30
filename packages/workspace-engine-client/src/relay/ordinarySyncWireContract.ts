import { createHash } from "node:crypto";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { ProtocolShapeError, mutableStruct } from "../wireSchema";
import {
  canonicalJson, canonicalRetainedContribution, decodeReleasedLineageBinding, decodeRetainedContribution,
  mergedContributionsCommitment, releasedLineageBindingDigest, releasedTailContributionsCommitment,
  type ReleasedLineageBinding, type RetainedContribution,
} from "./releasedLineageBinding";

export { releasedLineageBindingDigest, type ReleasedLineageBinding } from "./releasedLineageBinding";

const Text = Schema.String.check(Schema.isMinLength(1));
const Count = Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0));
const SharingDeclined = mutableStruct({
  objectId: Text,
  versionId: Text,
  lineagePruned: Schema.Boolean,
  headBlobSha256: Schema.NullOr(Text),
  path: Text,
  constraint: Text,
  limitBytes: Count,
  observedBytes: Count,
});
const OwnerAdmissionPending = mutableStruct({
  workspaceId: Text,
  originId: Text,
  originSeq: Count,
  versionId: Text,
  objectId: Text,
  path: Text,
});
const ChangedPath = mutableStruct({
  versionId: Text,
  path: Text,
  operation: Schema.Literals(["write", "delete"]),
  contentKind: Schema.Literals(["text", "binary", "secret"]),
});
const Refusal = mutableStruct({
  workspaceId: Text,
  originId: Text,
  originSeq: Count,
  opKind: Text,
  code: Text,
  reason: Text,
});

// Method projections strip extra native fields. Push has null cursor fields;
// pull must carry the engine-issued token before either consumer applies it.
const OrdinarySyncResultSchemas = {
  "sync.push": mutableStruct({
    status: Schema.Literal("complete"),
    pushed: Count,
    hasMore: Schema.Boolean,
    ownerAdmissionPending: Schema.mutable(Schema.Array(OwnerAdmissionPending)),
    sharingDeclined: Schema.mutable(Schema.Array(SharingDeclined)),
  }),
  "sync.pull": mutableStruct({
    status: Schema.Literal("complete"),
    fetched: Count,
    applied: Count,
    refused: Count,
    skipped: Count,
    conflictsOpened: Count,
    nextCursor: Count,
    hasMore: Schema.Boolean,
    pendingCursor: mutableStruct({ kind: Schema.Literal("relay"), token: Text }),
    changedPaths: Schema.mutable(Schema.Array(ChangedPath)),
    refusals: Schema.mutable(Schema.Array(Refusal)),
    sharingDeclined: Schema.mutable(Schema.Array(SharingDeclined)),
  }),
  "sync.commitCursor": mutableStruct({
    committed: Schema.Literal(true),
    sharingDeclined: Schema.mutable(Schema.Array(SharingDeclined)),
  }),
  "sync.materializePendingCursor": mutableStruct({ materialized: Schema.Literal(true) }),
} as const;

export type OrdinarySyncMethod = keyof typeof OrdinarySyncResultSchemas;
export type OrdinarySyncMethodResultMap = {
  [M in OrdinarySyncMethod]: (typeof OrdinarySyncResultSchemas)[M]["Type"];
};

export function decodeOrdinarySyncResult<M extends OrdinarySyncMethod>(
  method: M,
  value: unknown,
): OrdinarySyncMethodResultMap[M] {
  const decoded = Schema.decodeUnknownResult(OrdinarySyncResultSchemas[method])(value);
  if (Result.isFailure(decoded)) {
    throw new ProtocolShapeError(`${method} result: ${decoded.failure.message}`);
  }
  return decoded.success as OrdinarySyncMethodResultMap[M];
}

const Digest = Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/));
// A document the hosted replica holds for retained work a released chain
// left, named by its binding's digest; the binding itself is in the
// contribution artifact.
const HeldDocumentFields = {
  objectId: Text,
  path: Text,
  bindingDigest: Digest,
  continuation: Schema.Literals(["frozen", "dependency-drain"]),
  bindingStale: Schema.Boolean,
};

// What holds a hosted document from being ready, with the fields its reason names.
const HostedHold = Schema.Union([
  mutableStruct({ objectId: Text, reason: Schema.Literal("hosted-backfill-path-held"), path: Text, heldBy: Text }),
  mutableStruct({ objectId: Text, reason: Schema.Literal("hosted-conflict-parent-withheld"), conflictId: Text }),
  mutableStruct({ objectId: Text, reason: Schema.Literal("hosted-backfill-work-waiting") }),
  mutableStruct({ objectId: Text, reason: Schema.Literal("hosted-scope-path-mismatch"), scopePath: Text, headPath: Schema.NullOr(Text) }),
  // The host refused a live edit its session never admitted, so its copy is incomplete.
  mutableStruct({ objectId: Text, reason: Schema.Literal("hosted-live-edit-unadmitted") }),
  // An update that could destroy work a released activation retains, held as discovery lists it. Its
  // binding, whose tails are unbounded, never rides a pull.
  mutableStruct({ reason: Schema.Literal("released-lineage-unsettled"), ...HeldDocumentFields, binding: Schema.optionalKey(Schema.Never) }),
]);
// A document a pass moved from ready to held, with only what holding it needs.
const NewlyHeld = Schema.Union([
  mutableStruct({ objectId: Text, reason: Schema.Literals(["hosted-backfill-path-held", "hosted-conflict-parent-withheld",
    "hosted-backfill-work-waiting", "hosted-scope-path-mismatch", "hosted-live-edit-unadmitted"]) }),
  mutableStruct({ objectId: Text, reason: Schema.Literal("released-lineage-unsettled"), bindingDigest: Digest }),
]);
const RetirementError = mutableStruct({ code: Text, message: Text, retry: Text });

// The documents that left the scope and are not gone from the replica: their
// rows or their file remain.
const Departed = Schema.mutable(Schema.Array(Text));

// A journal cursor or outbox sequence: both count from one.
const Coordinate = Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(1), Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER));
// Where a finding's contribution is, without who made it.
const ContributionLocatorSchema = Schema.Union([
  mutableStruct({ kind: Schema.Literal("carried"), deliveryId: Text, updateDigest: Digest, journalCursor: Coordinate }),
  mutableStruct({ kind: Schema.Literal("outbox"), outboxId: Text, sequence: Coordinate, deliveryId: Text, updateDigest: Digest }),
]);
// Best to worst: a preservation's status is its worst reason's.
const PRESERVATION_STATUSES = ["complete", "pending-dependencies", "missing-evidence", "invalid-evidence"] as const;
const PreservationStatus = Schema.Literals(PRESERVATION_STATUSES);
// In the engine's order, which the answer lists them in.
const PRESERVATION_REASONS = ["source-missing", "pending-head-dependencies", "pending-contribution-dependencies",
  "digest-mismatch", "malformed-update", "contradictory-evidence", "missing-feed-identity", "malformed-authorship"] as const;
// The most findings the engine lists for one reason.
const MAX_REASON_EXAMPLES = 8;
// Whether merged state keeps every retained contribution, and why not: each
// reason once, with how many findings gave it and where a few of them are.
// The covered and merged work itself is in the contribution artifact, named
// here by its SHA-256 and length; the merged list also by its commitment.
// An artifact past what one blob streams is too large: neither its SHA-256
// nor its length is named, and the merged commitment and the rest still answer.
const Preservation = mutableStruct({
  status: PreservationStatus,
  reasons: Schema.mutable(Schema.Array(mutableStruct({
    reason: Schema.Literals(PRESERVATION_REASONS),
    status: PreservationStatus,
    total: Count,
    omitted: Count,
    examples: Schema.mutable(Schema.Array(mutableStruct({
      namespace: Schema.NullOr(Text),
      contribution: Schema.NullOr(ContributionLocatorSchema),
    }))),
  }))),
  mergedContributions: mutableStruct({ count: Count, digest: Digest }),
  contributionsSha256: Schema.NullOr(Digest),
  contributionsByteLength: Schema.NullOr(Count),
  contributionsTooLarge: Schema.Boolean,
  // Null when JSON would encode it past the in-band limit, and the engine streams it instead.
  markdown: Schema.NullOr(Schema.String),
  markdownSha256: Schema.NullOr(Digest),
  markdownByteLength: Schema.NullOr(Count),
  inbandLimitBytes: Count,
});

// A session host's hosted replica. A pass that adopted a new scope has no
// cursor; a commit can stand while the retirement after it failed, and while
// its departed documents could not be read (null). Each answer fits the
// engine's control budget, so each list may stop early:
// - A pass lists the documents it holds after the pull's `heldAfter`, in
//   object ID order, through its `heldThrough`, the last listed, or to the
//   last of them when that is null.
// - Departed documents page the same way, after the pull's `departedAfter`
//   through `departedThrough`, in the pass and in its commit.
// - `newlyHeld` names documents the pass moved from ready to held, wherever
//   they fall. With `newlyHeldOmitted` above zero it left some out.
// - The other counts say how many changed paths, refusals and declined
//   shares the pass reports beyond those listed; the engine keeps them all.
const HostedSyncResultSchemas = {
  "sync.createHostedReplica": mutableStruct({ hosted: Schema.Literal(true) }),
  "sync.pullHosted": mutableStruct({
    fetched: Count,
    applied: Count,
    refused: Count,
    skipped: Count,
    conflictsOpened: Count,
    hasMore: Schema.Boolean,
    pendingCursor: Schema.NullOr(mutableStruct({ kind: Schema.Literal("hosted"), token: Text })),
    changedPaths: Schema.mutable(Schema.Array(ChangedPath)),
    changedPathsOmitted: Count,
    refusals: Schema.mutable(Schema.Array(Refusal)),
    refusalsOmitted: Count,
    sharingDeclined: Schema.mutable(Schema.Array(SharingDeclined)),
    sharingDeclinedOmitted: Count,
    held: Schema.mutable(Schema.Array(HostedHold)),
    heldThrough: Schema.NullOr(Text),
    newlyHeld: Schema.mutable(Schema.Array(NewlyHeld)),
    newlyHeldOmitted: Count,
    departed: Departed,
    departedThrough: Schema.NullOr(Text),
  }),
  "sync.materializePendingCursor": OrdinarySyncResultSchemas["sync.materializePendingCursor"],
  "sync.commitCursor": mutableStruct({
    committed: Schema.Boolean,
    hasMore: Schema.Boolean,
    retirement: Schema.NullOr(RetirementError),
    departed: Schema.NullOr(Departed),
    departedThrough: Schema.NullOr(Text),
    sharingDeclined: Schema.mutable(Schema.Array(SharingDeclined)),
  }),
  "sync.push": OrdinarySyncResultSchemas["sync.push"],
  "sync.heldDocuments": mutableStruct({
    documents: Schema.mutable(Schema.Array(mutableStruct(HeldDocumentFields))),
    hasMore: Schema.Boolean,
  }),
  // Null when nothing is held there. A stale binding claims nothing, so it carries no preservation.
  "sync.heldDocument": Schema.NullOr(mutableStruct({
    ...HeldDocumentFields,
    status: Schema.Literals(["current", "stale"]),
    preservation: Schema.NullOr(Preservation),
    resolution: Schema.Null,
  })),
} as const;

export type HostedSyncMethod = keyof typeof HostedSyncResultSchemas;
export type HostedSyncMethodResultMap = {
  [M in HostedSyncMethod]: (typeof HostedSyncResultSchemas)[M]["Type"];
};

export function decodeHostedSyncResult<M extends HostedSyncMethod>(
  method: M,
  value: unknown,
): HostedSyncMethodResultMap[M] {
  const decoded = Schema.decodeUnknownResult(HostedSyncResultSchemas[method])(value);
  if (Result.isFailure(decoded)) {
    throw new ProtocolShapeError(`hosted ${method} result: ${decoded.failure.message}`);
  }
  const result = decoded.success as HostedSyncMethodResultMap[M];
  if (method === "sync.pullHosted") {
    const pass = result as HostedSyncMethodResultMap["sync.pullHosted"];
    // A list that stops early stops at the last document it lists.
    if (!pagedList(pass.held.map(hold => hold.objectId), pass.heldThrough) || !ascending(pass.newlyHeld.map(hold => hold.objectId))) {
      throw new ProtocolShapeError(`hosted ${method} result: held documents do not match where their list stops`);
    }
    if (!pagedList(pass.departed, pass.departedThrough)) {
      throw new ProtocolShapeError(`hosted ${method} result: departed documents do not match where their list stops`);
    }
  } else if (method === "sync.commitCursor") {
    const commit = result as HostedSyncMethodResultMap["sync.commitCursor"];
    // Unread, it stops nowhere.
    if (commit.departed === null ? commit.departedThrough !== null : !pagedList(commit.departed, commit.departedThrough)) {
      throw new ProtocolShapeError(`hosted ${method} result: departed documents do not match where their list stops`);
    }
  } else if (method === "sync.heldDocuments") {
    const page = result as HostedSyncMethodResultMap["sync.heldDocuments"];
    // The next page starts after the last document listed, so one that claims more lists one.
    if (page.hasMore && page.documents.length === 0) {
      throw new ProtocolShapeError(`hosted ${method} result: a page that claims more lists nothing`);
    }
  } else if (method === "sync.heldDocument") {
    const inspected = result as HostedSyncMethodResultMap["sync.heldDocument"];
    if (inspected !== null) checkHeldInspection(inspected);
  }
  return result;
}

// The engine orders object IDs by their UTF-8 bytes.
const compareObjectIds = (a: string, b: string) => Buffer.compare(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));
const ascending = (ids: readonly string[]) => ids.every((id, index) => index === 0 || compareObjectIds(ids[index - 1]!, id) < 0);
const pagedList = (ids: readonly string[], through: string | null) => ascending(ids) && (through === null || through === ids.at(-1));

/**
 * Where a hosted pass's held or departed list runs: after `after`, from the
 * first when undefined, through `through`, or to the last when null.
 */
export type HostedWindow = { readonly after: string | undefined; readonly through: string | null };

/** Whether a list speaks for the document: inside its window, a document it does not list is not held, or not departed. */
export function hostedWindowCovers(window: HostedWindow, objectId: string): boolean {
  return (window.after === undefined || compareObjectIds(objectId, window.after) > 0) &&
    (window.through === null || compareObjectIds(objectId, window.through) <= 0);
}

export type HeldDocumentInspection = NonNullable<HostedSyncMethodResultMap["sync.heldDocument"]>;

type HeldPreservation = NonNullable<HeldDocumentInspection["preservation"]>;
// The status each reason holds preservation at.
const REASON_STATUS: Record<HeldPreservation["reasons"][number]["reason"], HeldPreservation["status"]> = {
  "source-missing": "missing-evidence",
  "pending-head-dependencies": "pending-dependencies",
  "pending-contribution-dependencies": "pending-dependencies",
  "digest-mismatch": "invalid-evidence",
  "malformed-update": "invalid-evidence",
  "contradictory-evidence": "invalid-evidence",
  "missing-feed-identity": "invalid-evidence",
  "malformed-authorship": "invalid-evidence",
};

// What no merged contributions commit to.
const NOTHING_MERGED = mergedContributionsCommitment([]).digest;

// Only a current binding may preserve, and a hold marked stale never is
// current. Each reason appears once, in order, under its own status, with
// its examples and omitted findings adding up to its total; the preservation
// takes its worst reason's status, however few examples that reason lists.
// The artifact and its length are named exactly when the artifact is not too
// large; the merged commitment always is. The merged commitment is the
// canonical empty one exactly when nothing merged, and only complete
// preservation carries text, whose digest and length must name it.
function checkHeldInspection(inspected: HeldDocumentInspection): void {
  const method = "sync.heldDocument";
  const preservation = inspected.preservation;
  const invalid = () => new ProtocolShapeError(`hosted ${method} result: preservation does not match its status`);
  if ((inspected.status === "current") !== (preservation !== null) || (inspected.bindingStale && inspected.status !== "stale")) {
    throw invalid();
  }
  if (preservation === null) return;
  let worst = 0;
  preservation.reasons.forEach((found, index) => {
    const before = preservation.reasons[index - 1];
    if (found.status !== REASON_STATUS[found.reason] || found.total < 1 || found.examples.length > MAX_REASON_EXAMPLES ||
      found.examples.length + found.omitted !== found.total ||
      (before && PRESERVATION_REASONS.indexOf(before.reason) >= PRESERVATION_REASONS.indexOf(found.reason))) throw invalid();
    worst = Math.max(worst, PRESERVATION_STATUSES.indexOf(found.status));
  });
  const { mergedContributions: merged, contributionsSha256: sha256, contributionsByteLength: byteLength } = preservation;
  if ((merged.count === 0) !== (merged.digest === NOTHING_MERGED)) throw invalid();
  if (preservation.contributionsTooLarge) {
    if (sha256 !== null || byteLength !== null) throw invalid();
  } else if (sha256 === null || byteLength === null || merged.digest === sha256 || byteLength < 1) {
    throw invalid();
  }
  const complete = preservation.status === "complete";
  if (preservation.status !== PRESERVATION_STATUSES[worst] || complete !== (preservation.markdownSha256 !== null) ||
    (preservation.markdownSha256 === null) !== (preservation.markdownByteLength === null) ||
    (!complete && preservation.markdown !== null)) throw invalid();
  if (preservation.markdown !== null) {
    const bytes = Buffer.from(preservation.markdown, "utf8");
    if (bytes.length !== preservation.markdownByteLength ||
      createHash("sha256").update(bytes).digest("hex") !== preservation.markdownSha256) throw invalid();
  }
}

/** One valid tail's covered work, as the contribution artifact lists it. */
type HeldCoveredContributions = { namespace: string; contributions: RetainedContribution[] };

/** The binding of a current inspection, every contribution it covers, and what merging added. */
export type HeldContributions = {
  binding: ReleasedLineageBinding;
  coveredContributions: HeldCoveredContributions[];
  mergedContributionIds: RetainedContribution[];
};

const CONTRIBUTIONS_KEYS = "binding,coveredContributions,mergedContributionIds,version";

/**
 * The contribution artifact `inspected` names, from its streamed `bytes`; an
 * inspection whose artifact is too large names none to decode.
 * They must be exactly the bytes its SHA-256 and length name, in canonical
 * JSON of format version 1; the binding the one its digest names; each tail
 * with valid coverage listed in the binding's order with exactly the work
 * that tail commits to; and the merged contributions in canonical order,
 * each covered, committing as the inspection says.
 */
export function decodeHeldContributions(bytes: Uint8Array, inspected: HeldDocumentInspection): HeldContributions {
  const preservation = inspected.preservation;
  const invalid = () => new ProtocolShapeError("held document contributions do not match their inspection");
  if (inspected.status !== "current" || preservation === null || preservation.contributionsTooLarge ||
    bytes.length !== preservation.contributionsByteLength ||
    createHash("sha256").update(bytes).digest("hex") !== preservation.contributionsSha256) throw invalid();
  const committed = preservation.mergedContributions;
  let text: string, parsed: unknown;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
    parsed = JSON.parse(text);
  } catch {
    throw invalid();
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed) || canonicalJson(parsed) !== text ||
    Object.keys(parsed).sort().join() !== CONTRIBUTIONS_KEYS) throw invalid();
  const row = parsed as Record<string, unknown>;
  if (row.version !== 1 || !Array.isArray(row.coveredContributions) || !Array.isArray(row.mergedContributionIds)) throw invalid();
  let decoded: HeldContributions;
  try {
    decoded = {
      binding: decodeReleasedLineageBinding(row.binding),
      coveredContributions: row.coveredContributions.map((tail: unknown) => {
        const listed = tail as Record<string, unknown>;
        if (typeof tail !== "object" || tail === null || Object.keys(tail).sort().join() !== "contributions,namespace" ||
          typeof listed.namespace !== "string" || !Array.isArray(listed.contributions)) throw invalid();
        return { namespace: listed.namespace, contributions: listed.contributions.map(decodeRetainedContribution) };
      }),
      mergedContributionIds: row.mergedContributionIds.map(decodeRetainedContribution),
    };
  } catch {
    throw invalid();
  }
  const { binding, coveredContributions, mergedContributionIds } = decoded;
  if (releasedLineageBindingDigest(binding) !== inspected.bindingDigest || binding.objectId !== inspected.objectId) throw invalid();
  const valid = (binding.tails ?? []).filter(tail => tail.unproven !== null);
  if (coveredContributions.length !== valid.length) throw invalid();
  const every = new Set<string>();
  coveredContributions.forEach(({ namespace, contributions }, index) => {
    const tail = valid[index]!;
    const committed = tail.unproven!;
    const commitment = contributions.length === 0 ? null : releasedTailContributionsCommitment(contributions);
    if (namespace !== tail.namespace || commitment === null || commitment.count !== committed.count ||
      commitment.digest !== committed.digest) throw invalid();
    for (const contribution of contributions) every.add(canonicalRetainedContribution(contribution));
  });
  if (mergedContributionIds.some(merged => !every.has(canonicalRetainedContribution(merged)))) throw invalid();
  let merged;
  try {
    merged = mergedContributionsCommitment(mergedContributionIds);
  } catch {
    throw invalid();
  }
  if (merged.count !== committed.count || merged.digest !== committed.digest) throw invalid();
  return decoded;
}
