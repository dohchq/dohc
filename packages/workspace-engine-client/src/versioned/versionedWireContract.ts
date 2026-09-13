import { ProtocolShapeError, mutableStruct } from "../wireSchema";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as SchemaIssue from "effect/SchemaIssue";
import type { JsonValue } from "../protocol";

export const VERSIONED_METHOD = {
  textWrite: "versionedText.write",
  textRead: "versionedText.read",
  textReadBlob: "versionedText.readBlob",
  textRename: "versionedText.rename",
  textCheckMove: "versionedText.checkMove",
  textDelete: "versionedText.delete",
  textRollback: "versionedText.rollback",
  textList: "versionedText.list",
  textCaptureSources: "versionedText.captureSources",
  binaryWrite: "versionedBinary.write",
  binaryWriteBlob: "versionedBinary.writeBlob",
  binaryRead: "versionedBinary.read",
  binaryReadBlob: "versionedBinary.readBlob",
  versionsCreateNamed: "versions.createNamed",
  versionsList: "versions.list",
  versionsSetActive: "versions.setActive",
  versionsEnsureMain: "versions.ensureMain",
  versionsActive: "versions.active",
  versionsMerge: "versionedText.merge",
  versionsCompare: "versionedText.compare",
  versionsCompareFiles: "versions.compareFiles",
  secretsWrite: "secrets.write",
  secretsList: "secrets.list",
  secretsStateExists: "secrets.stateExists",
  secretsMaterialize: "secrets.materialize",
  secretsDelete: "secrets.delete",
  secretsFork: "secrets.fork",
  secretsCompare: "secrets.compare",
  secretsApply: "secrets.apply",
  secretsRestore: "secrets.restore",
  secretsMomentsList: "secrets.moments.list",
  secretsMomentsGet: "secrets.moments.get",
  momentsList: "moments.list",
  momentsGet: "moments.get",
  historyPage: "history.page",
  searchEnsureIndex: "search.ensureIndex",
} as const;

export type VersionedMethod =
  (typeof VERSIONED_METHOD)[keyof typeof VERSIONED_METHOD];
type JsonObject = { [key: string]: JsonValue | undefined };
export type VersionedContentKind = "text" | "binary";

export type VersionChangeStatus = "added" | "modified" | "deleted";

export type VersionedOrigin =
  | "api"
  | "local-file"
  | "restore"
  | "sync"
  | "unknown";

export type AgentAuthor = JsonObject & {
  kind: "agent";
  agentId: string;
  onBehalfOf: string;
  agentRunId?: string;
};

type MutationMetadata = JsonObject & {
  workspaceId?: string;
  origin?: VersionedOrigin;
  author?: AgentAuthor;
  requestId?: string;
  nowMs?: number;
  summary?: string;
  correlationId?: string;
};

type VersionedTextWriteParams = MutationMetadata & {
  versionId: string;
  objectId?: string;
  path: string;
  text: string;
  restoreBeforeMomentId?: string;
  momentId?: string;
};

type VersionedTextReadParams = JsonObject & {
  versionId: string;
  path: string;
};

type VersionedTextReadBlobParams = JsonObject & {
  workspaceId: string;
  sha256: string;
};

type VersionedBinaryWriteParams = MutationMetadata & {
  versionId: string;
  objectId?: string;
  path: string;
  bytes?: number[];
  bytesBase64?: string;
  momentId?: string;
};

type VersionedBinaryWriteBlobParams = MutationMetadata & {
  versionId: string;
  objectId?: string;
  path: string;
  sha256: string;
  bytesBase64?: string;
  momentId?: string;
};

type VersionedTextRenameParams = MutationMetadata & {
  versionId: string;
  fromPath: string;
  toPath: string;
};

type VersionedTextDeleteParams = MutationMetadata & {
  versionId: string;
  path: string;
  expectedObjectId?: string;
};

type VersionedTextRollbackParams = Omit<MutationMetadata, "nowMs"> & {
  versionId: string;
  path: string;
  mutationMomentId: string;
};

type VersionedTextListParams = JsonObject & {
  versionId: string;
  afterPath?: string;
  limit?: number;
};

type VersionedBinaryReadParams = JsonObject & {
  versionId: string;
  path: string;
};

type VersionedBinaryReadBlobParams = JsonObject & {
  workspaceId: string;
  sha256: string;
};

type VersionsCreateNamedParams = JsonObject & {
  workspaceId: string;
  name: string;
  fromVersionId: string;
};

type VersionsListParams = JsonObject & {
  afterVersionId?: string;
};

type VersionsSetActiveParams = JsonObject & {
  workspaceId?: string;
  versionId: string;
};

type WorkspaceOnlyParams = JsonObject & { workspaceId?: string };

type VersionsMergeParams = MutationMetadata & {
  path: string;
  sourceVersionId: string;
  targetVersionId: string;
};

type VersionsCompareParams = JsonObject & {
  workspaceId?: string;
  path: string;
  sourceVersionId: string;
  targetVersionId: string;
};

type VersionsCompareFilesParams = JsonObject & {
  workspaceId?: string;
  sourceVersionId: string;
  targetVersionId: string;
  afterPath?: string;
  byteBudget?: number;
};

type SecretsWriteParams = JsonObject & {
  workspaceId: string;
  versionId: string;
  path: string;
  text: string;
  origin: VersionedOrigin;
  momentId: string;
  summary?: string;
  correlationId?: string;
};

type SecretsListParams = JsonObject & {
  versionId: string;
  afterPath?: string;
  limit?: number;
};

type SecretsMaterializeParams = JsonObject & {
  versionId: string;
  path: string;
};

type SecretsDeleteParams = JsonObject & {
  workspaceId: string;
  versionId: string;
  path: string;
  origin: VersionedOrigin;
  momentId: string;
  summary?: string;
  correlationId?: string;
};

type SecretsForkParams = JsonObject & {
  workspaceId: string;
  fromVersionId: string;
  toVersionId: string;
};

type SecretsCompareParams = JsonObject & {
  workspaceId: string;
  sourceVersionId: string;
  targetVersionId: string;
  afterPath?: string;
  limit?: number;
};

type SecretsApplyParams = JsonObject & {
  workspaceId: string;
  path: string;
  sourceVersionId: string;
  targetVersionId: string;
  momentId: string;
  origin: VersionedOrigin;
  summary?: string;
  correlationId?: string;
};

type SecretsRestoreParams = JsonObject & {
  workspaceId: string;
  path: string;
  beforeMomentId: string;
  momentId: string;
  origin: VersionedOrigin;
  summary?: string;
  correlationId?: string;
};

type SecretsMomentsListParams = JsonObject & {
  workspaceId: string;
  versionId?: string;
  path?: string;
  beforeMomentOrder?: number;
  limit?: number;
};

type SecretsMomentsGetParams = JsonObject & {
  workspaceId: string;
  momentId: string;
};

type MomentsListParams = JsonObject & {
  versionId?: string;
  objectId?: string;
  limit?: number;
  beforeMomentOrder?: number;
};

type MomentsGetParams = JsonObject & { momentId: string };

type HistoryPageParams = JsonObject & {
  workspaceId: string;
  limit?: number;
  beforeMomentOrder?: number;
};

type SearchEnsureIndexParams = JsonObject & {
  workspaceId: string;
  versionId: string;
};

type FileObject = typeof FileObjectSchema.Type;

type SnapshotMetadata = JsonObject & {
  workspaceId: string;
  versionId: string;
  objectId: string;
  path: string;
  contentKind: VersionedContentKind;
  sha256: string;
  byteLength: number;
  updatedAtMs: number;
  latestMomentId: string;
  metadataOrigin: string;
  metadataSummary?: string | null;
  metadataCorrelationId?: string | null;
};

type BinaryWriteSnapshot = JsonObject & {
  objectId: string;
  path: string;
  contentKind: "binary";
  text: "";
  sha256: string;
  byteLength: number;
  updatedAtMs: number;
  latestMomentId: string;
};

export type MomentRecord = typeof MomentRecordSchema.Type;

type VersionedTextWriteResult = typeof TextWriteResultSchema.Type;

type VersionedTextReadMetadata = SnapshotMetadata & {
  blobSha256: string;
};

export type VersionedTextReadValue = typeof VersionedTextReadValueSchema.Type;

type VersionedTextReadResult = VersionedTextReadValue | null;

type VersionedBinaryWriteResult = JsonObject & {
  object: FileObject;
  snapshot: BinaryWriteSnapshot;
  moment: MomentRecord;
  deduped: boolean;
  materializeEnqueued: boolean;
  materialized: boolean;
  materializeOutcome: MaterializeOutcome;
};

type MaterializeOutcome =
  | "applied"
  | "skipped"
  | "conflict"
  | "superseded"
  | "error";

type VersionedTextRenameResult = typeof TextRenameResultSchema.Type;

type VersionedTextDeleteResult = typeof TextDeleteResultSchema.Type;

type VersionedTextRollbackResult = typeof TextRollbackResultSchema.Type;

export type VersionedTextListEntry = JsonObject & {
  path: string;
  objectId: string;
  contentKind: VersionedContentKind;
  sha256: string;
  byteLength: number | null;
  binarySha256: string | null;
  updatedAtMs: number;
  latestMomentId: string;
  metadataOrigin: string;
  // Is this path owned by the Y.Doc editor (a ydoc_docs marker exists)? A
  // settled Y.Doc is bounded by nothing, so callers that hold size limits for
  // ordinary captured content must not mistake the engine's own artifact for
  // content it cannot own.
  hasYdocMarker: boolean;
  metadataSummary?: string | null;
  metadataCorrelationId?: string | null;
};

type VersionedTextListResult = typeof TextListResultSchema.Type;

type VersionedBinaryReadResult = typeof BinaryReadResultSchema.Type;

type VersionedBinaryReadBlobResult =
  | (JsonObject & { bytesBase64: string })
  | (JsonObject & {
      bytesBase64: null;
      byteLength: number;
      inbandLimitBytes: number;
    });

type VersionedTextReadBlobResult =
  | (JsonObject & { bytesBase64: string })
  | (JsonObject & {
      bytesBase64: null;
      byteLength: number;
      inbandLimitBytes: number;
    });

export type VersionRecord = typeof VersionRecordSchema.Type;

type VersionsCreateNamedResult = VersionRecord;

type VersionsListResult = typeof VersionsListResultSchema.Type;
type VersionsSetActiveResult = VersionRecord;
type VersionsEnsureMainResult = VersionRecord;
type VersionsActiveResult = VersionRecord | null;

type MergeMaterializationResult = {
  materializeEnqueued: boolean;
  materialized: boolean;
  materializeOutcome: MaterializeOutcome;
};

type VersionsMergeResult = typeof VersionsMergeResultSchema.Type;

export type VersionedComparisonRecord =
  typeof VersionedComparisonRecordSchema.Type;

type VersionsCompareResult = typeof VersionedComparisonRecordSchema.Type;

type VersionsCompareFilesResult = typeof VersionsCompareFilesResultSchema.Type;

export type SecretMomentRecord = typeof SecretMomentRecordSchema.Type;

type SecretWriteResult = typeof SecretWriteResultSchema.Type;

type SecretsListResult = typeof SecretsListResultSchema.Type;
type SecretsMaterializeResult = typeof SecretsMaterializeResultSchema.Type;
type SecretDeleteResult = typeof SecretDeleteResultSchema.Type;
type SecretsForkResult = JsonObject;
export type SecretCompareEntry = JsonObject & {
  path: string;
  status: VersionChangeStatus;
};
type SecretCompareResult = typeof SecretCompareResultSchema.Type;
type SecretApplyResult = SecretWriteResult;
type SecretRestoreResult = typeof SecretRestoreResultSchema.Type;
type SecretsMomentsListResult = typeof SecretsMomentsListResultSchema.Type;
type SecretsMomentsGetResult = SecretMomentRecord | null;

export type MomentsListResult = typeof MomentsListResultSchema.Type;
type MomentsGetResult = MomentRecord | null;
type HistoryPageResult = typeof HistoryPageResultSchema.Type;
type SearchEnsureIndexResult = JsonObject;

export type VersionedMethodParamsMap = {
  [VERSIONED_METHOD.textCaptureSources]: JsonObject & {
    versionId: string;
    paths: string[];
    bounds: { maxInputFiles: number; maxInputBytes: number };
  };
  [VERSIONED_METHOD.textWrite]: VersionedTextWriteParams;
  [VERSIONED_METHOD.textRead]: VersionedTextReadParams;
  [VERSIONED_METHOD.textReadBlob]: VersionedTextReadBlobParams;
  [VERSIONED_METHOD.textRename]: VersionedTextRenameParams;
  [VERSIONED_METHOD.textCheckMove]: JsonObject & { versionId: string; path: string };
  [VERSIONED_METHOD.textDelete]: VersionedTextDeleteParams;
  [VERSIONED_METHOD.textRollback]: VersionedTextRollbackParams;
  [VERSIONED_METHOD.textList]: VersionedTextListParams;
  [VERSIONED_METHOD.binaryWrite]: VersionedBinaryWriteParams;
  [VERSIONED_METHOD.binaryWriteBlob]: VersionedBinaryWriteBlobParams;
  [VERSIONED_METHOD.binaryRead]: VersionedBinaryReadParams;
  [VERSIONED_METHOD.binaryReadBlob]: VersionedBinaryReadBlobParams;
  [VERSIONED_METHOD.versionsCreateNamed]: VersionsCreateNamedParams;
  [VERSIONED_METHOD.versionsList]: VersionsListParams;
  [VERSIONED_METHOD.versionsSetActive]: VersionsSetActiveParams;
  [VERSIONED_METHOD.versionsEnsureMain]: WorkspaceOnlyParams;
  [VERSIONED_METHOD.versionsActive]: WorkspaceOnlyParams;
  [VERSIONED_METHOD.versionsMerge]: VersionsMergeParams;
  [VERSIONED_METHOD.versionsCompare]: VersionsCompareParams;
  [VERSIONED_METHOD.versionsCompareFiles]: VersionsCompareFilesParams;
  [VERSIONED_METHOD.secretsWrite]: SecretsWriteParams;
  [VERSIONED_METHOD.secretsList]: SecretsListParams;
  [VERSIONED_METHOD.secretsStateExists]: WorkspaceOnlyParams;
  [VERSIONED_METHOD.secretsMaterialize]: SecretsMaterializeParams;
  [VERSIONED_METHOD.secretsDelete]: SecretsDeleteParams;
  [VERSIONED_METHOD.secretsFork]: SecretsForkParams;
  [VERSIONED_METHOD.secretsCompare]: SecretsCompareParams;
  [VERSIONED_METHOD.secretsApply]: SecretsApplyParams;
  [VERSIONED_METHOD.secretsRestore]: SecretsRestoreParams;
  [VERSIONED_METHOD.secretsMomentsList]: SecretsMomentsListParams;
  [VERSIONED_METHOD.secretsMomentsGet]: SecretsMomentsGetParams;
  [VERSIONED_METHOD.momentsList]: MomentsListParams;
  [VERSIONED_METHOD.momentsGet]: MomentsGetParams;
  [VERSIONED_METHOD.historyPage]: HistoryPageParams;
  [VERSIONED_METHOD.searchEnsureIndex]: SearchEnsureIndexParams;
};

export type VersionedMethodResultMap = {
  [VERSIONED_METHOD.textCaptureSources]: SourceCapture;
  [VERSIONED_METHOD.textWrite]: VersionedTextWriteResult;
  [VERSIONED_METHOD.textRead]: VersionedTextReadResult;
  [VERSIONED_METHOD.textReadBlob]: VersionedTextReadBlobResult;
  [VERSIONED_METHOD.textRename]: VersionedTextRenameResult;
  [VERSIONED_METHOD.textCheckMove]: { allowed: true };
  [VERSIONED_METHOD.textDelete]: VersionedTextDeleteResult;
  [VERSIONED_METHOD.textRollback]: VersionedTextRollbackResult;
  [VERSIONED_METHOD.textList]: VersionedTextListResult;
  [VERSIONED_METHOD.binaryWrite]: VersionedBinaryWriteResult;
  [VERSIONED_METHOD.binaryWriteBlob]: VersionedBinaryWriteResult;
  [VERSIONED_METHOD.binaryRead]: VersionedBinaryReadResult;
  [VERSIONED_METHOD.binaryReadBlob]: VersionedBinaryReadBlobResult;
  [VERSIONED_METHOD.versionsCreateNamed]: VersionsCreateNamedResult;
  [VERSIONED_METHOD.versionsList]: VersionsListResult;
  [VERSIONED_METHOD.versionsSetActive]: VersionsSetActiveResult;
  [VERSIONED_METHOD.versionsEnsureMain]: VersionsEnsureMainResult;
  [VERSIONED_METHOD.versionsActive]: VersionsActiveResult;
  [VERSIONED_METHOD.versionsMerge]: VersionsMergeResult;
  [VERSIONED_METHOD.versionsCompare]: VersionsCompareResult;
  [VERSIONED_METHOD.versionsCompareFiles]: VersionsCompareFilesResult;
  [VERSIONED_METHOD.secretsWrite]: SecretWriteResult;
  [VERSIONED_METHOD.secretsList]: SecretsListResult;
  [VERSIONED_METHOD.secretsStateExists]: boolean;
  [VERSIONED_METHOD.secretsMaterialize]: SecretsMaterializeResult;
  [VERSIONED_METHOD.secretsDelete]: SecretDeleteResult;
  [VERSIONED_METHOD.secretsFork]: SecretsForkResult;
  [VERSIONED_METHOD.secretsCompare]: SecretCompareResult;
  [VERSIONED_METHOD.secretsApply]: SecretApplyResult;
  [VERSIONED_METHOD.secretsRestore]: SecretRestoreResult;
  [VERSIONED_METHOD.secretsMomentsList]: SecretsMomentsListResult;
  [VERSIONED_METHOD.secretsMomentsGet]: SecretsMomentsGetResult;
  [VERSIONED_METHOD.momentsList]: MomentsListResult;
  [VERSIONED_METHOD.momentsGet]: MomentsGetResult;
  [VERSIONED_METHOD.historyPage]: HistoryPageResult;
  [VERSIONED_METHOD.searchEnsureIndex]: SearchEnsureIndexResult;
};

function decodeVersionedSchema<S extends Schema.ConstraintDecoder<unknown>>(
  schema: S,
  value: JsonValue,
  label: string,
): S["Type"] {
  const decoded = Schema.decodeUnknownResult(schema, {
    onExcessProperty: "error",
  })(value);
  if (Result.isFailure(decoded)) {
    const issue = SchemaIssue.makeFormatterStandardSchemaV1()(
      decoded.failure.issue,
    ).issues[0];
    const path =
      issue?.path
        ?.map((part) =>
          typeof part === "number" ? `[${part}]` : `.${String(part)}`,
        )
        .join("") ?? "";
    throw new ProtocolShapeError(
      `${label}${path}: ${issue?.message ?? decoded.failure.message}`,
    );
  }
  return decoded.success;
}

const NullableString = Schema.NullOr(Schema.String);
const NullableInt = Schema.NullOr(Schema.Int);
const ContentKindSchema = Schema.Literals(["text", "binary"]);
const VersionKindSchema = Schema.Literals(["main", "named"]);
const ChangeStatusSchema = Schema.Literals(["added", "modified", "deleted"]);
const MaterializeOutcomeSchema = Schema.Literals([
  "applied",
  "skipped",
  "conflict",
  "superseded",
  "error",
]);
const EmptyObjectSchema = Schema.Record(Schema.String, Schema.Never);

const FileObjectSchema = mutableStruct({
  id: Schema.String,
  workspaceId: Schema.String,
  createdAtMs: Schema.Int,
});

const SnapshotMetadataFields = {
  workspaceId: Schema.String,
  versionId: Schema.String,
  objectId: Schema.String,
  path: Schema.String,
  contentKind: ContentKindSchema,
  sha256: Schema.String,
  byteLength: Schema.Int,
  updatedAtMs: Schema.Int,
  latestMomentId: Schema.String,
  metadataOrigin: Schema.String,
  metadataSummary: Schema.optionalKey(NullableString),
  metadataCorrelationId: Schema.optionalKey(NullableString),
} as const;

const SnapshotMetadataSchema = mutableStruct(SnapshotMetadataFields);
const TextWriteSnapshotSchema = mutableStruct({
  ...SnapshotMetadataFields,
  contentKind: Schema.Literal("text"),
  text: Schema.String,
  blobSha256: Schema.String,
});
const BinaryWriteSnapshotWireSchema = mutableStruct({
  objectId: Schema.String,
  path: Schema.String,
  contentKind: Schema.Literal("binary"),
  text: Schema.Literal(""),
  sha256: Schema.String,
  byteLength: Schema.Int,
  workspaceId: Schema.optionalKey(Schema.Unknown),
  versionId: Schema.optionalKey(Schema.Unknown),
  updatedAtMs: Schema.Int,
  latestMomentId: Schema.String,
  metadataOrigin: Schema.optionalKey(Schema.Unknown),
});

const AgentAuthorSchema = mutableStruct({
  kind: Schema.Literal("agent"),
  agentId: Schema.String,
  onBehalfOf: Schema.String,
  agentRunId: Schema.optionalKey(Schema.String),
});
const PublicAuthorSchema = mutableStruct({
  kind: Schema.Literal("public"),
  principalId: Schema.String,
  grantId: Schema.String,
});
const CorruptAuthorSchema = mutableStruct({ corrupt: Schema.Literal(true) });
const MomentAuthorSchema = Schema.NullOr(
  Schema.Union([AgentAuthorSchema, PublicAuthorSchema, CorruptAuthorSchema]),
);

const MomentRecordSchema = mutableStruct({
  momentOrder: Schema.Int,
  momentId: Schema.String,
  versionId: Schema.String,
  objectId: Schema.String,
  path: Schema.String,
  recordedAtMs: Schema.Int,
  operation: Schema.Literals(["write", "delete", "rename"]),
  afterContentKind: ContentKindSchema,
  afterBlobSha256: NullableString,
  afterBinarySha256: NullableString,
  beforePresent: Schema.Boolean,
  beforeContentKind: ContentKindSchema,
  beforeBlobSha256: NullableString,
  beforeBinarySha256: NullableString,
  beforeLatestMomentId: NullableString,
  metadataOrigin: Schema.String,
  metadataSummary: Schema.optionalKey(NullableString),
  metadataCorrelationId: Schema.optionalKey(NullableString),
  author: MomentAuthorSchema,
  syncRecordOnly: Schema.Boolean,
  afterText: NullableString,
  afterByteLength: NullableInt,
  afterInbandLimitBytes: NullableInt,
  beforeText: NullableString,
  beforeByteLength: NullableInt,
  beforeInbandLimitBytes: NullableInt,
  beforePath: Schema.optionalKey(NullableString),
});

const TextReadMetadataFields = {
  ...SnapshotMetadataFields,
  blobSha256: Schema.String,
} as const;
const VersionedTextReadValueSchema = Schema.Union([
  mutableStruct({
    ...TextReadMetadataFields,
    contentKind: Schema.Literal("text"),
    text: Schema.String,
  }),
  mutableStruct({
    ...TextReadMetadataFields,
    contentKind: Schema.Literal("text"),
    text: Schema.Null,
    inbandLimitBytes: Schema.Int,
  }),
  mutableStruct({
    ...TextReadMetadataFields,
    contentKind: Schema.Literal("binary"),
    text: Schema.Literal(""),
  }),
]);

const TextWriteResultSchema = mutableStruct({
  object: FileObjectSchema,
  snapshot: TextWriteSnapshotSchema,
  moment: MomentRecordSchema,
  deduped: Schema.Boolean,
});
const BinaryWriteResultWireSchema = mutableStruct({
  object: FileObjectSchema,
  snapshot: BinaryWriteSnapshotWireSchema,
  moment: MomentRecordSchema,
  deduped: Schema.Boolean,
  materializeEnqueued: Schema.Boolean,
  materialized: Schema.Boolean,
  materializeOutcome: MaterializeOutcomeSchema,
});
const TextRenameResultSchema = mutableStruct({
  object: FileObjectSchema,
  before: SnapshotMetadataSchema,
  after: SnapshotMetadataSchema,
  moment: MomentRecordSchema,
  deduped: Schema.Boolean,
});
const TextDeleteResultSchema = mutableStruct({
  object: FileObjectSchema,
  before: SnapshotMetadataSchema,
  moment: MomentRecordSchema,
  deduped: Schema.Boolean,
});
const TextRollbackResultSchema = mutableStruct({
  rolledBack: Schema.Literal(true),
  deduped: Schema.Boolean,
  materializeEnqueued: Schema.Boolean,
  materialized: Schema.Boolean,
  materializeOutcome: MaterializeOutcomeSchema,
});

const VersionRecordSchema = mutableStruct({
  id: Schema.String,
  workspaceId: Schema.String,
  kind: VersionKindSchema,
  name: Schema.String,
  forkPoint: Schema.optionalKey(
    mutableStruct({
      versionId: Schema.String,
      momentId: Schema.optionalKey(Schema.String),
    }),
  ),
  createdAtMs: Schema.Int,
});
const VersionsListEntrySchema = mutableStruct({
  versionId: Schema.String,
  kind: VersionKindSchema,
  name: Schema.String,
  createdAtMs: Schema.Int,
  forkVersionId: NullableString,
  forkMomentId: NullableString,
});
const VersionsListResultSchema = mutableStruct({
  versions: Schema.mutable(Schema.Array(VersionsListEntrySchema)),
  nextAfterVersionId: NullableString,
});

const VersionedComparisonRecordSchema = mutableStruct({
  workspaceId: Schema.String,
  path: Schema.String,
  targetVersionId: Schema.String,
  sourceVersionId: Schema.String,
  base: Schema.NullOr(VersionedTextReadValueSchema),
  current: Schema.NullOr(VersionedTextReadValueSchema),
  incoming: Schema.NullOr(VersionedTextReadValueSchema),
  status: Schema.Literals([
    "same",
    "incoming-changed",
    "current-changed",
    "diverged",
  ]),
});
const MergeMaterializationFields = {
  materializeEnqueued: Schema.Boolean,
  materialized: Schema.Boolean,
  materializeOutcome: MaterializeOutcomeSchema,
} as const;
const VersionsMergeResultSchema = Schema.Union([
  mutableStruct({
    status: Schema.Literal("unchanged"),
    deduped: Schema.Boolean,
    comparison: VersionedComparisonRecordSchema,
    reason: Schema.Literals(["already-same", "source-unchanged"]),
    ...MergeMaterializationFields,
  }),
  mutableStruct({
    status: Schema.Literal("conflict"),
    conflictId: Schema.String,
    deduped: Schema.Boolean,
    comparison: VersionedComparisonRecordSchema,
    ...MergeMaterializationFields,
  }),
  mutableStruct({
    status: Schema.Literal("merged"),
    writeKind: Schema.Literals(["write", "binary-write"]),
    object: FileObjectSchema,
    snapshot: SnapshotMetadataSchema,
    moment: MomentRecordSchema,
    deduped: Schema.Boolean,
    comparison: VersionedComparisonRecordSchema,
    ...MergeMaterializationFields,
  }),
  mutableStruct({
    status: Schema.Literal("merged"),
    writeKind: Schema.Literal("delete"),
    object: FileObjectSchema,
    before: SnapshotMetadataSchema,
    moment: MomentRecordSchema,
    deduped: Schema.Boolean,
    comparison: VersionedComparisonRecordSchema,
    ...MergeMaterializationFields,
  }),
]);

const CompareFilesEntrySchema = mutableStruct({
  path: Schema.String,
  status: ChangeStatusSchema,
  binary: Schema.optionalKey(Schema.Literal(true)),
});
const VersionsCompareFilesResultSchema = mutableStruct({
  entries: Schema.mutable(Schema.Array(CompareFilesEntrySchema)),
  nextCursor: NullableString,
});

const BinaryReadResultSchema = Schema.NullOr(
  Schema.Union([
    mutableStruct({
      objectId: Schema.String,
      sha256: Schema.String,
      byteLength: Schema.Int,
      bytesBase64: Schema.String,
    }),
    mutableStruct({
      objectId: Schema.String,
      sha256: Schema.String,
      byteLength: Schema.Int,
      bytesBase64: Schema.Null,
      inbandLimitBytes: Schema.Int,
    }),
  ]),
);
const BlobReadResultSchema = Schema.Union([
  mutableStruct({
    bytesBase64: Schema.String,
    byteLength: Schema.optionalKey(Schema.Int),
    inbandLimitBytes: Schema.optionalKey(Schema.Int),
  }),
  mutableStruct({
    bytesBase64: Schema.Null,
    byteLength: Schema.Int,
    inbandLimitBytes: Schema.Int,
  }),
]);

const SecretMomentRecordSchema = mutableStruct({
  id: Schema.String,
  workspaceId: Schema.String,
  versionId: Schema.String,
  path: Schema.String,
  recordedAtMs: Schema.Int,
  operation: Schema.Literals(["write", "delete"]),
  metadata: mutableStruct({
    origin: Schema.String,
    summary: NullableString,
    correlationId: NullableString,
  }),
  momentOrder: Schema.Int,
  protected: Schema.Literal(true),
});
const SecretWriteResultSchema = mutableStruct({
  changed: Schema.Boolean,
  moment: Schema.NullOr(SecretMomentRecordSchema),
});
const SecretsListResultSchema = mutableStruct({
  secrets: Schema.mutable(
    Schema.Array(
      mutableStruct({
        path: Schema.String,
        byteLength: Schema.Int,
        updatedAtMs: Schema.Int,
        latestMomentId: Schema.String,
      }),
    ),
  ),
  nextAfterPath: NullableString,
});
const SecretsMaterializeResultSchema = Schema.NullOr(
  Schema.Union([
    mutableStruct({ text: Schema.String }),
    mutableStruct({
      text: Schema.Null,
      byteLength: Schema.Int,
      inbandLimitBytes: Schema.Int,
    }),
  ]),
);
const SecretDeleteResultSchema = mutableStruct({
  moment: Schema.NullOr(SecretMomentRecordSchema),
});
const SecretCompareResultSchema = mutableStruct({
  entries: Schema.mutable(
    Schema.Array(
      mutableStruct({
        path: Schema.String,
        status: ChangeStatusSchema,
      }),
    ),
  ),
  nextAfterPath: NullableString,
});
const SecretRestoreResultSchema = mutableStruct({
  restored: Schema.Literals(["text", "deleted"]),
  restoredMomentId: Schema.String,
  path: Schema.String,
});
const SecretsMomentsListResultSchema = mutableStruct({
  moments: Schema.mutable(Schema.Array(SecretMomentRecordSchema)),
  nextBeforeMomentOrder: NullableInt,
});
const MomentsListResultSchema = mutableStruct({
  moments: Schema.mutable(Schema.Array(MomentRecordSchema)),
  nextBeforeMomentOrder: NullableInt,
  latestMomentOrder: Schema.Int,
});
const HistoryPageResultSchema = mutableStruct({
  activeVersion: VersionRecordSchema,
  textMomentPage: MomentsListResultSchema,
  protectedMoments: Schema.mutable(Schema.Array(SecretMomentRecordSchema)),
  protectedTruncated: Schema.Boolean,
});
const TextListResultSchema = mutableStruct({
  files: Schema.mutable(
    Schema.Array(
      mutableStruct({
        path: Schema.String,
        objectId: Schema.String,
        contentKind: ContentKindSchema,
        sha256: Schema.String,
        byteLength: NullableInt,
        binarySha256: NullableString,
        updatedAtMs: Schema.Int,
        latestMomentId: Schema.String,
        metadataOrigin: Schema.String,
        hasYdocMarker: Schema.Boolean,
        metadataSummary: Schema.optionalKey(NullableString),
        metadataCorrelationId: Schema.optionalKey(NullableString),
      }),
    ),
  ),
  nextAfterPath: NullableString,
});

const SourceCaptureSchema = mutableStruct({
  workspaceId: Schema.String,
  versionId: Schema.String,
  sourceDigest: Schema.String,
  totalBytes: Schema.Int,
  files: Schema.mutable(Schema.Array(mutableStruct({
    path: Schema.String,
    objectId: Schema.String,
    contentKind: ContentKindSchema,
    sha256: Schema.String,
    byteLength: Schema.Int,
    latestMomentId: Schema.String,
  }))),
});
export type SourceCapture = typeof SourceCaptureSchema.Type;

const VersionedResultSchemas = {
  [VERSIONED_METHOD.textCaptureSources]: SourceCaptureSchema,
  [VERSIONED_METHOD.textWrite]: TextWriteResultSchema,
  [VERSIONED_METHOD.textRead]: Schema.NullOr(VersionedTextReadValueSchema),
  [VERSIONED_METHOD.textReadBlob]: BlobReadResultSchema,
  [VERSIONED_METHOD.textRename]: TextRenameResultSchema,
  [VERSIONED_METHOD.textCheckMove]: mutableStruct({ allowed: Schema.Literal(true) }),
  [VERSIONED_METHOD.textDelete]: TextDeleteResultSchema,
  [VERSIONED_METHOD.textRollback]: TextRollbackResultSchema,
  [VERSIONED_METHOD.textList]: TextListResultSchema,
  [VERSIONED_METHOD.binaryWrite]: BinaryWriteResultWireSchema,
  [VERSIONED_METHOD.binaryWriteBlob]: BinaryWriteResultWireSchema,
  [VERSIONED_METHOD.binaryRead]: BinaryReadResultSchema,
  [VERSIONED_METHOD.binaryReadBlob]: BlobReadResultSchema,
  [VERSIONED_METHOD.versionsCreateNamed]: VersionRecordSchema,
  [VERSIONED_METHOD.versionsSetActive]: VersionRecordSchema,
  [VERSIONED_METHOD.versionsEnsureMain]: VersionRecordSchema,
  [VERSIONED_METHOD.versionsList]: VersionsListResultSchema,
  [VERSIONED_METHOD.versionsActive]: Schema.NullOr(VersionRecordSchema),
  [VERSIONED_METHOD.versionsMerge]: VersionsMergeResultSchema,
  [VERSIONED_METHOD.versionsCompare]: VersionedComparisonRecordSchema,
  [VERSIONED_METHOD.versionsCompareFiles]: VersionsCompareFilesResultSchema,
  [VERSIONED_METHOD.secretsWrite]: SecretWriteResultSchema,
  [VERSIONED_METHOD.secretsList]: SecretsListResultSchema,
  [VERSIONED_METHOD.secretsStateExists]: Schema.Boolean,
  [VERSIONED_METHOD.secretsMaterialize]: SecretsMaterializeResultSchema,
  [VERSIONED_METHOD.secretsDelete]: SecretDeleteResultSchema,
  [VERSIONED_METHOD.secretsFork]: EmptyObjectSchema,
  [VERSIONED_METHOD.secretsCompare]: SecretCompareResultSchema,
  [VERSIONED_METHOD.secretsApply]: SecretWriteResultSchema,
  [VERSIONED_METHOD.secretsRestore]: SecretRestoreResultSchema,
  [VERSIONED_METHOD.secretsMomentsList]: SecretsMomentsListResultSchema,
  [VERSIONED_METHOD.secretsMomentsGet]: Schema.NullOr(SecretMomentRecordSchema),
  [VERSIONED_METHOD.momentsList]: MomentsListResultSchema,
  [VERSIONED_METHOD.momentsGet]: Schema.NullOr(MomentRecordSchema),
  [VERSIONED_METHOD.historyPage]: HistoryPageResultSchema,
  [VERSIONED_METHOD.searchEnsureIndex]: EmptyObjectSchema,
} as const;

function decodeVersionedBinaryWriteResult(
  value: JsonValue,
): VersionedBinaryWriteResult {
  const decoded = decodeVersionedSchema(
    BinaryWriteResultWireSchema,
    value,
    "versionedBinary.write result",
  );
  return {
    ...decoded,
    snapshot: {
      objectId: decoded.snapshot.objectId,
      path: decoded.snapshot.path,
      contentKind: "binary",
      text: "",
      sha256: decoded.snapshot.sha256,
      byteLength: decoded.snapshot.byteLength,
      updatedAtMs: decoded.snapshot.updatedAtMs,
      latestMomentId: decoded.snapshot.latestMomentId,
    },
  } as VersionedBinaryWriteResult;
}

function decodeBlobReadResult(
  value: JsonValue,
  label: string,
): VersionedBinaryReadBlobResult {
  const decoded = decodeVersionedSchema(BlobReadResultSchema, value, label);
  return typeof decoded.bytesBase64 === "string"
    ? { bytesBase64: decoded.bytesBase64 }
    : decoded;
}

export function decodeVersionedResult<M extends VersionedMethod>(
  method: M,
  value: JsonValue,
): VersionedMethodResultMap[M] {
  if (
    method === VERSIONED_METHOD.binaryWrite ||
    method === VERSIONED_METHOD.binaryWriteBlob
  ) {
    return decodeVersionedBinaryWriteResult(
      value,
    ) as VersionedMethodResultMap[M];
  }
  if (
    method === VERSIONED_METHOD.binaryReadBlob ||
    method === VERSIONED_METHOD.textReadBlob
  ) {
    return decodeBlobReadResult(
      value,
      `${method} result`,
    ) as VersionedMethodResultMap[M];
  }
  const schema = VersionedResultSchemas[method];
  if (schema === undefined)
    throw new ProtocolShapeError(`Unsupported versioned method: ${method}`);
  return decodeVersionedSchema(
    schema,
    value,
    `${method} result`,
  ) as VersionedMethodResultMap[M];
}
