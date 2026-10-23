import { createHash } from "node:crypto";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as SchemaIssue from "effect/SchemaIssue";
import { ProtocolShapeError, mutableStruct } from "../wireSchema";
import { decodeReleasedLineageBinding, releasedLineageBindingDigest, type ReleasedLineageBinding } from "./releasedLineageBinding";

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

const ReleasedLineageBindingSchema = Schema.declareConstructor<ReleasedLineageBinding>()([], () => (value) => Effect.try({
  try: () => decodeReleasedLineageBinding(value),
  catch: (error) => new SchemaIssue.InvalidValue({ message: (error as TypeError).message }),
}));

// What holds a hosted document from being ready, with the fields its reason names.
const HostedHold = Schema.Union([
  mutableStruct({ objectId: Text, reason: Schema.Literal("hosted-backfill-path-held"), path: Text, heldBy: Text }),
  mutableStruct({ objectId: Text, reason: Schema.Literal("hosted-conflict-parent-withheld"), conflictId: Text }),
  mutableStruct({ objectId: Text, reason: Schema.Literal("hosted-backfill-work-waiting") }),
  mutableStruct({ objectId: Text, reason: Schema.Literal("hosted-scope-path-mismatch"), scopePath: Text, headPath: Schema.NullOr(Text) }),
  // The host refused a live edit its session never admitted, so its copy is incomplete.
  mutableStruct({ objectId: Text, reason: Schema.Literal("hosted-live-edit-unadmitted") }),
  // An update that could destroy work a released activation retains, held with what it would change.
  mutableStruct({ objectId: Text, reason: Schema.Literal("released-lineage-unsettled"), binding: ReleasedLineageBindingSchema,
    continuation: Schema.Literals(["frozen", "dependency-drain"]), bindingStale: Schema.Boolean }),
]);
const RetirementError = mutableStruct({ code: Text, message: Text, retry: Text });

// The documents that left the scope and are not gone from the replica: their
// rows or their file remain.
const Departed = Schema.mutable(Schema.Array(Text));

const Digest = Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/));
// A journal cursor or outbox sequence: both count from one.
const Coordinate = Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(1), Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER));
const RetainedContributionSchema = Schema.Union([
  mutableStruct({ kind: Schema.Literal("carried"), deliveryId: Text, updateDigest: Digest, journalCursor: Coordinate }),
  mutableStruct({ kind: Schema.Literal("outbox"), outboxId: Text, sequence: Coordinate, deliveryId: Text, updateDigest: Digest }),
]);
// A document the hosted replica holds for retained work a released chain left.
const HeldDocumentFields = {
  objectId: Text,
  path: Text,
  binding: ReleasedLineageBindingSchema,
  bindingDigest: Digest,
  continuation: Schema.Literals(["frozen", "dependency-drain"]),
  bindingStale: Schema.Boolean,
};
// Best to worst: a preservation's status is its worst reason's.
const PRESERVATION_STATUSES = ["complete", "pending-dependencies", "missing-evidence", "invalid-evidence"] as const;
const PreservationStatus = Schema.Literals(PRESERVATION_STATUSES);
// Whether merged state keeps every retained contribution, why not, and what merging added.
const Preservation = mutableStruct({
  status: PreservationStatus,
  reasons: Schema.mutable(Schema.Array(mutableStruct({
    reason: Schema.Literals(["source-missing", "pending-head-dependencies", "pending-contribution-dependencies",
      "digest-mismatch", "malformed-update", "contradictory-evidence", "missing-feed-identity"]),
    status: PreservationStatus,
    namespace: Schema.NullOr(Text),
    contribution: Schema.NullOr(RetainedContributionSchema),
  }))),
  mergedContributionIds: Schema.mutable(Schema.Array(RetainedContributionSchema)),
  // Null above the in-band limit, when the engine streams it instead.
  markdown: Schema.NullOr(Schema.String),
  markdownSha256: Schema.NullOr(Digest),
  markdownByteLength: Schema.NullOr(Count),
  inbandLimitBytes: Count,
});

// A session host's hosted replica. A pass that adopted a new scope has no
// cursor; a commit can stand while the retirement after it failed, and while
// its departed documents could not be read (null).
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
    refusals: Schema.mutable(Schema.Array(Refusal)),
    sharingDeclined: Schema.mutable(Schema.Array(SharingDeclined)),
    held: Schema.mutable(Schema.Array(HostedHold)),
    departed: Departed,
  }),
  "sync.materializePendingCursor": OrdinarySyncResultSchemas["sync.materializePendingCursor"],
  "sync.commitCursor": mutableStruct({
    committed: Schema.Boolean,
    hasMore: Schema.Boolean,
    retirement: Schema.NullOr(RetirementError),
    departed: Schema.NullOr(Departed),
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
  if (method === "sync.heldDocuments") {
    for (const held of (result as HostedSyncMethodResultMap["sync.heldDocuments"]).documents) checkHeldDocument(method, held);
  } else if (method === "sync.heldDocument") {
    const inspected = result as HostedSyncMethodResultMap["sync.heldDocument"];
    if (inspected !== null) checkHeldInspection(inspected);
  }
  return result;
}

type HeldDocument = HostedSyncMethodResultMap["sync.heldDocuments"]["documents"][number];
export type HeldDocumentInspection = NonNullable<HostedSyncMethodResultMap["sync.heldDocument"]>;

function checkHeldDocument(method: HostedSyncMethod, held: HeldDocument): void {
  if (releasedLineageBindingDigest(held.binding) !== held.bindingDigest || held.binding.objectId !== held.objectId) {
    throw new ProtocolShapeError(`hosted ${method} result: binding digest or object does not match its binding`);
  }
}

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
};

// Only a current binding may preserve, and a hold marked stale never is
// current. Each reason has its own status, the preservation its worst
// reason's, and only complete preservation carries text, whose digest and
// length must name it.
function checkHeldInspection(inspected: HeldDocumentInspection): void {
  const method = "sync.heldDocument";
  checkHeldDocument(method, inspected);
  const preservation = inspected.preservation;
  const invalid = () => new ProtocolShapeError(`hosted ${method} result: preservation does not match its status`);
  if ((inspected.status === "current") !== (preservation !== null) || (inspected.bindingStale && inspected.status !== "stale")) {
    throw invalid();
  }
  if (preservation === null) return;
  const worst = preservation.reasons.reduce((worst, found) => {
    if (found.status !== REASON_STATUS[found.reason]) throw invalid();
    return Math.max(worst, PRESERVATION_STATUSES.indexOf(found.status));
  }, 0);
  const complete = preservation.status === "complete";
  if (preservation.status !== PRESERVATION_STATUSES[worst] || complete !== (preservation.markdownSha256 !== null) ||
    (preservation.markdownSha256 === null) !== (preservation.markdownByteLength === null) ||
    (!complete && preservation.markdown !== null)) throw invalid();
  if (preservation.markdown !== null) {
    const bytes = Buffer.from(preservation.markdown, "utf8");
    if (bytes.length !== preservation.markdownByteLength ||
      createHash("sha256").update(bytes).digest("hex") !== preservation.markdownSha256) throw invalid();
  } else if (complete && preservation.markdownByteLength! <= preservation.inbandLimitBytes) {
    throw invalid();
  }
}
