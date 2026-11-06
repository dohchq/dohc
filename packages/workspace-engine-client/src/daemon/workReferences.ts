import * as Schema from "effect/Schema";

/** What a caller asks to reference. A version-scoped target without `versionId` uses the active version. */
export type WorkTargetInput =
  | { kind: "message"; messageId: string }
  | ({ kind: "file" | "app"; versionId?: string } & ({ objectId: string } | { path: string }))
  | { kind: "documentRecord"; versionId?: string; recordId: string }
  | { kind: "documentCollection"; versionId?: string; path: string }
  | { kind: "transactionalCollection"; datasetId: string; tableId: string }
  | { kind: "transactionalRecord"; datasetId: string; tableId: string; recordId: string | number };

const NonEmpty = Schema.String.check(Schema.isNonEmpty());
const Reference = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]{43}$/));
const SafeInt = Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(-Number.MAX_SAFE_INTEGER), Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER));
const Versioned = { versionId: NonEmpty, objectId: NonEmpty } as const;
const Target = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("message"), messageId: NonEmpty, threadId: NonEmpty, channelId: Schema.optionalKey(Schema.NullOr(NonEmpty)) }),
  Schema.Struct({ kind: Schema.Literals(["file", "app", "documentCollection"]), ...Versioned }),
  Schema.Struct({ kind: Schema.Literal("documentRecord"), versionId: NonEmpty, recordId: NonEmpty }),
  Schema.Struct({ kind: Schema.Literal("transactionalCollection"), datasetId: NonEmpty, tableId: NonEmpty }),
  Schema.Struct({ kind: Schema.Literal("transactionalRecord"), datasetId: NonEmpty, tableId: NonEmpty, recordId: Schema.Union([NonEmpty, SafeInt]) }),
]);
const Made = Schema.Struct({ reference: Reference, created: Schema.Boolean });
const Resolution = Schema.Union([
  Schema.Struct({ status: Schema.Literal("unknown") }),
  Schema.Struct({
    status: Schema.Literal("found"),
    reference: Reference,
    target: Target,
    state: Schema.Literals(["live", "deleted", "unchecked"]),
    path: Schema.optionalKey(NonEmpty),
    createdAtMs: SafeInt,
    registration: Schema.Literals(["pending", "registered"]),
  }),
]);

export type WorkTarget = typeof Target.Type;
export type MadeWorkReference = typeof Made.Type;
export type WorkReferenceResolution = typeof Resolution.Type;
export const decodeMadeWorkReference = Schema.decodeUnknownSync(Made);
export const decodeWorkReferenceResolution = Schema.decodeUnknownSync(Resolution);
export const decodeWorkTarget = Schema.decodeUnknownSync(Target, {onExcessProperty: "error"});
const Mapping = Schema.Struct({reference: Reference, target: Target, createdAtMs: SafeInt, deleted: Schema.optionalKey(Schema.Boolean)});
export type WorkReferenceMapping = typeof Mapping.Type;
export const decodeWorkReferenceMapping = Schema.decodeUnknownSync(Mapping, {onExcessProperty: "error"});
