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
