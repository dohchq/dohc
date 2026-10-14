import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { ProtocolShapeError, mutableStruct } from "../wireSchema";

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

// What holds a hosted document from being ready, with the fields its reason names.
const HostedHold = Schema.Union([
  mutableStruct({ objectId: Text, reason: Schema.Literal("hosted-backfill-path-held"), path: Text, heldBy: Text }),
  mutableStruct({ objectId: Text, reason: Schema.Literal("hosted-conflict-parent-withheld"), conflictId: Text }),
  mutableStruct({ objectId: Text, reason: Schema.Literal("hosted-backfill-work-waiting") }),
  mutableStruct({ objectId: Text, reason: Schema.Literal("hosted-scope-path-mismatch"), scopePath: Text, headPath: Schema.NullOr(Text) }),
]);
const RetirementError = mutableStruct({ code: Text, message: Text, retry: Text });

// A session host's hosted replica. A pass that adopted a new scope has no
// cursor; a commit can stand while the retirement after it failed.
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
  }),
  "sync.materializePendingCursor": OrdinarySyncResultSchemas["sync.materializePendingCursor"],
  "sync.commitCursor": mutableStruct({
    committed: Schema.Boolean,
    hasMore: Schema.Boolean,
    retirement: Schema.NullOr(RetirementError),
    sharingDeclined: Schema.mutable(Schema.Array(SharingDeclined)),
  }),
  "sync.push": OrdinarySyncResultSchemas["sync.push"],
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
  return decoded.success as HostedSyncMethodResultMap[M];
}
