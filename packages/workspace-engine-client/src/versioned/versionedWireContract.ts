import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as SchemaIssue from "effect/SchemaIssue";
import * as Struct from "effect/Struct";
import type { JsonValue } from "../ydoc/generated/serde_json/JsonValue";

export const VERSIONED_METHOD = {
  textWrite: "versionedText.write",
  textRead: "versionedText.read",
  textReadBlob: "versionedText.readBlob",
  textRename: "versionedText.rename",
  textDelete: "versionedText.delete",
  textRollback: "versionedText.rollback",
  textList: "versionedText.list",
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
  searchEnsureIndex: "search.ensureIndex",
} as const;

export type VersionedMethod =
  (typeof VERSIONED_METHOD)[keyof typeof VERSIONED_METHOD];
type JsonObject = { [key: string]: JsonValue | undefined };
export type VersionedContentKind = "text" | "binary";
export type VersionKind = "main" | "named";
export type VersionChangeStatus = "added" | "modified" | "deleted";
export type VersionedComparisonStatus = "unchanged" | "merged" | "conflict";
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
  metadataOrigin?: VersionedOrigin | "agent";
  author?: AgentAuthor;
  authorJson?: string;
  requestId?: string;
  nowMs?: number;
  summary?: string;
  correlationId?: string;
};

export type VersionedTextWriteParams = MutationMetadata & {
  versionId: string;
  objectId?: string;
  path: string;
  text: string;
  momentId?: string;
};

export type VersionedTextReadParams = JsonObject & {
  versionId: string;
  path: string;
};

export type VersionedTextReadBlobParams = JsonObject & {
  workspaceId: string;
  sha256: string;
};

export type VersionedBinaryWriteParams = MutationMetadata & {
  versionId: string;
  objectId?: string;
  path: string;
  bytes?: number[];
  bytesBase64?: string;
  momentId?: string;
};

export type VersionedBinaryWriteBlobParams = MutationMetadata & {
  versionId: string;
  objectId?: string;
  path: string;
  sha256: string;
  bytesBase64?: string;
  momentId?: string;
};

export type VersionedTextRenameParams = MutationMetadata & {
  versionId: string;
  fromPath: string;
  toPath: string;
};

export type VersionedTextDeleteParams = MutationMetadata & {
  versionId: string;
  path: string;
};

export type VersionedTextRollbackParams = Omit<MutationMetadata, "nowMs"> & {
  versionId: string;
  path: string;
  mutationMomentId: string;
  legacyBeforeText?: string;
};

export type VersionedTextListParams = JsonObject & {
  versionId: string;
  afterPath?: string;
  limit?: number;
};

export type VersionedBinaryReadParams = JsonObject & {
  versionId: string;
  path: string;
};

export type VersionedBinaryReadBlobParams = JsonObject & {
  workspaceId: string;
  sha256: string;
};

export type VersionsCreateNamedParams = JsonObject & {
  workspaceId: string;
  name: string;
  fromVersionId: string;
};

export type VersionsListParams = JsonObject & {
  afterVersionId?: string;
};

export type VersionsSetActiveParams = JsonObject & {
  workspaceId?: string;
  versionId: string;
};

export type WorkspaceOnlyParams = JsonObject & { workspaceId?: string };

export type VersionsMergeParams = MutationMetadata & {
  path: string;
  sourceVersionId: string;
  targetVersionId: string;
};

export type VersionsCompareParams = JsonObject & {
  workspaceId?: string;
  path: string;
  sourceVersionId: string;
  targetVersionId: string;
};

export type VersionsCompareFilesParams = JsonObject & {
  workspaceId?: string;
  sourceVersionId: string;
  targetVersionId: string;
  afterPath?: string;
  byteBudget?: number;
};

export type SecretsWriteParams = JsonObject & {
  workspaceId: string;
  versionId: string;
  path: string;
  text: string;
  origin: VersionedOrigin;
  momentId: string;
  summary?: string;
  correlationId?: string;
};

export type SecretsListParams = JsonObject & {
  versionId: string;
  afterPath?: string;
  limit?: number;
};

export type SecretsMaterializeParams = JsonObject & {
  versionId: string;
  path: string;
};

export type SecretsDeleteParams = JsonObject & {
  workspaceId: string;
  versionId: string;
  path: string;
  origin: VersionedOrigin;
  momentId: string;
  summary?: string;
  correlationId?: string;
};

export type SecretsForkParams = JsonObject & {
  workspaceId: string;
  fromVersionId: string;
  toVersionId: string;
};

export type SecretsCompareParams = JsonObject & {
  workspaceId: string;
  sourceVersionId: string;
  targetVersionId: string;
  afterPath?: string;
  limit?: number;
};

export type SecretsApplyParams = JsonObject & {
  workspaceId: string;
  path: string;
  sourceVersionId: string;
  targetVersionId: string;
  momentId: string;
  origin: VersionedOrigin;
  summary?: string;
  correlationId?: string;
};

export type SecretsRestoreParams = JsonObject & {
  workspaceId: string;
  path: string;
  beforeMomentId: string;
  momentId: string;
  origin: VersionedOrigin;
  summary?: string;
  correlationId?: string;
};

export type SecretsMomentsListParams = JsonObject & {
  workspaceId: string;
  versionId?: string;
  path?: string;
  beforeMomentOrder?: number;
  limit?: number;
};

export type SecretsMomentsGetParams = JsonObject & {
  workspaceId: string;
  momentId: string;
};

export type MomentsListParams = JsonObject & {
  versionId?: string;
  objectId?: string;
  limit?: number;
  beforeMomentOrder?: number;
};

export type MomentsGetParams = JsonObject & { momentId: string };

export type SearchEnsureIndexParams = JsonObject & {
  workspaceId: string;
  versionId: string;
};

export type FileObject = JsonObject & {
  id: string;
  workspaceId: string;
  createdAtMs: number;
};

export type SnapshotMetadata = JsonObject & {
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

export type TextWriteSnapshot = SnapshotMetadata & {
  contentKind: "text";
  text: string;
  blobSha256: string;
};

export type BinaryWriteSnapshot = JsonObject & {
  objectId: string;
  path: string;
  contentKind: "binary";
  text: "";
  sha256: string;
  byteLength: number;
  updatedAtMs: number;
  latestMomentId: string;
};

export type MomentAuthor = AgentAuthor | (JsonObject & { corrupt: true }) | null;

export type MomentRecord = JsonObject & {
  momentOrder: number;
  momentId: string;
  versionId: string;
  objectId: string;
  path: string;
  recordedAtMs: number;
  operation: "write" | "delete" | "rename";
  afterContentKind: VersionedContentKind;
  afterBlobSha256: string | null;
  afterBinarySha256: string | null;
  beforePresent: boolean;
  beforeContentKind: VersionedContentKind;
  beforeBlobSha256: string | null;
  beforeBinarySha256: string | null;
  beforeLatestMomentId: string | null;
  metadataOrigin: string;
  metadataSummary?: string | null;
  metadataCorrelationId?: string | null;
  author: MomentAuthor;
  syncRecordOnly: boolean;
  afterText: string | null;
  afterByteLength: number | null;
  afterInbandLimitBytes: number | null;
  beforeText: string | null;
  beforeByteLength: number | null;
  beforeInbandLimitBytes: number | null;
  beforePath?: string | null;
};

export type VersionedTextWriteResult = JsonObject & {
  object: FileObject;
  snapshot: TextWriteSnapshot;
  moment: MomentRecord;
  deduped: boolean;
};

type VersionedTextReadMetadata = SnapshotMetadata & {
  blobSha256: string;
};

export type VersionedTextReadValue =
  | (VersionedTextReadMetadata & {
      contentKind: "text";
      text: string;
      inbandLimitBytes?: never;
    })
  | (VersionedTextReadMetadata & {
      contentKind: "text";
      text: null;
      inbandLimitBytes: number;
    })
  | (VersionedTextReadMetadata & {
      contentKind: "binary";
      text: "";
      inbandLimitBytes?: never;
    });

export type VersionedTextReadResult = VersionedTextReadValue | null;

export type VersionedBinaryWriteResult = JsonObject & {
  object: FileObject;
  snapshot: BinaryWriteSnapshot;
  moment: MomentRecord;
  deduped: boolean;
  materializeEnqueued: boolean;
  materialized: boolean;
  materializeOutcome: MaterializeOutcome;
};

export type MaterializeOutcome = "applied" | "skipped" | "conflict" | "superseded" | "error";

export type VersionedTextRenameResult = JsonObject & {
  object: FileObject;
  before: SnapshotMetadata;
  after: SnapshotMetadata;
  moment: MomentRecord;
  deduped: boolean;
};

export type VersionedTextDeleteResult = JsonObject & {
  object: FileObject;
  before: SnapshotMetadata;
  moment: MomentRecord;
  deduped: boolean;
};

export type VersionedTextRollbackResult = JsonObject & {
  rolledBack: true;
  deduped: boolean;
  materializeEnqueued: boolean;
  materialized: boolean;
  materializeOutcome: MaterializeOutcome;
};

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

export type VersionedTextListResult = JsonObject & {
  files: VersionedTextListEntry[];
  nextAfterPath: string | null;
};

export type VersionedBinaryReadValue = JsonObject & {
  objectId: string;
  sha256: string;
  byteLength: number;
  bytesBase64: string | null;
  inbandLimitBytes?: number;
};

export type VersionedBinaryReadResult = VersionedBinaryReadValue | null;

export type VersionedBinaryReadBlobResult =
  | (JsonObject & { bytesBase64: string })
  | (JsonObject & {
      bytesBase64: null;
      byteLength: number;
      inbandLimitBytes: number;
    });

export type VersionedTextReadBlobResult =
  | (JsonObject & { bytesBase64: string })
  | (JsonObject & {
      bytesBase64: null;
      byteLength: number;
      inbandLimitBytes: number;
    });

export type ForkPoint = JsonObject & {
  versionId: string;
  momentId?: string;
};

export type VersionRecord = JsonObject & {
  id: string;
  workspaceId: string;
  kind: VersionKind;
  name: string;
  forkPoint?: ForkPoint;
  createdAtMs: number;
};

export type VersionsCreateNamedResult = VersionRecord;
export type VersionsListEntry = JsonObject & {
  versionId: string;
  kind: VersionKind;
  name: string;
  createdAtMs: number;
  forkVersionId: string | null;
  forkMomentId: string | null;
};
export type VersionsListResult = JsonObject & {
  versions: VersionsListEntry[];
  nextAfterVersionId: string | null;
};
export type VersionsSetActiveResult = VersionRecord;
export type VersionsEnsureMainResult = VersionRecord;
export type VersionsActiveResult = VersionRecord | null;

type MergeMaterializationResult = {
  materializeEnqueued: boolean;
  materialized: boolean;
  materializeOutcome: MaterializeOutcome;
};

export type VersionsMergeResult =
  | (JsonObject &
      MergeMaterializationResult & {
        status: "unchanged";
        deduped: boolean;
        comparison: VersionedComparisonRecord;
        reason?: "already-same" | "source-unchanged";
      })
  | (JsonObject &
      MergeMaterializationResult & {
        status: "conflict";
        conflictId: string;
        deduped: boolean;
        comparison: VersionedComparisonRecord;
      })
  | (JsonObject & {
      status: "merged";
      writeKind: "write";
      object: FileObject;
      snapshot: SnapshotMetadata;
      moment: MomentRecord;
      deduped: boolean;
      comparison: VersionedComparisonRecord;
    } & MergeMaterializationResult)
  | (JsonObject & {
      status: "merged";
      writeKind: "binary-write";
      object: FileObject;
      snapshot: SnapshotMetadata;
      moment: MomentRecord;
      deduped: boolean;
      comparison: VersionedComparisonRecord;
    } & MergeMaterializationResult)
  | (JsonObject & {
      status: "merged";
      writeKind: "delete";
      object: FileObject;
      before: SnapshotMetadata;
      moment: MomentRecord;
      deduped: boolean;
      comparison: VersionedComparisonRecord;
    } & MergeMaterializationResult);

export type VersionedComparisonRecord = JsonObject & {
  workspaceId: string;
  path: string;
  targetVersionId: string;
  sourceVersionId: string;
  base: VersionedTextReadValue | null;
  current: VersionedTextReadValue | null;
  incoming: VersionedTextReadValue | null;
  status: "same" | "incoming-changed" | "current-changed" | "diverged";
};

export type VersionsCompareResult = VersionedComparisonRecord;

export type VersionsCompareFilesEntry = JsonObject & {
  path: string;
  status: VersionChangeStatus;
  binary?: true;
};

export type VersionsCompareFilesResult = JsonObject & {
  entries: VersionsCompareFilesEntry[];
  nextCursor: string | null;
};

export type SecretMomentRecord = JsonObject & {
  id: string;
  workspaceId: string;
  versionId: string;
  path: string;
  recordedAtMs: number;
  operation: "write" | "delete";
  metadata: JsonObject & {
    origin: string;
    summary: string | null;
    correlationId: string | null;
  };
  momentOrder: number;
  protected: true;
};

export type SecretWriteResult = JsonObject & {
  changed: boolean;
  moment: SecretMomentRecord | null;
};
export type SecretListEntry = JsonObject & {
  path: string;
  byteLength: number;
  updatedAtMs: number;
  latestMomentId: string;
};
export type SecretsListResult = JsonObject & {
  secrets: SecretListEntry[];
  nextAfterPath: string | null;
};
export type SecretsMaterializeResult =
  | null
  | (JsonObject & { text: string })
  | (JsonObject & {
      text: null;
      byteLength: number;
      inbandLimitBytes: number;
    });
export type SecretDeleteResult = JsonObject & {
  moment: SecretMomentRecord | null;
};
export type SecretsForkResult = JsonObject;
export type SecretCompareEntry = JsonObject & {
  path: string;
  status: VersionChangeStatus;
};
export type SecretCompareResult = JsonObject & {
  entries: SecretCompareEntry[];
  nextAfterPath: string | null;
};
export type SecretApplyResult = SecretWriteResult;
export type SecretRestoreResult = JsonObject & {
  restored: "text" | "deleted";
  restoredMomentId: string;
  path: string;
};
export type SecretsMomentsListResult = JsonObject & {
  moments: SecretMomentRecord[];
  nextBeforeMomentOrder: number | null;
};
export type SecretsMomentsGetResult = SecretMomentRecord | null;

export type MomentsListResult = JsonObject & {
  moments: MomentRecord[];
  nextBeforeMomentOrder: number | null;
  latestMomentOrder: number;
};
export type MomentsGetResult = MomentRecord | null;
export type SearchEnsureIndexResult = JsonObject;

export type VersionedMethodParamsMap = {
  [VERSIONED_METHOD.textWrite]: VersionedTextWriteParams;
  [VERSIONED_METHOD.textRead]: VersionedTextReadParams;
  [VERSIONED_METHOD.textReadBlob]: VersionedTextReadBlobParams;
  [VERSIONED_METHOD.textRename]: VersionedTextRenameParams;
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
  [VERSIONED_METHOD.searchEnsureIndex]: SearchEnsureIndexParams;
};

export type VersionedMethodResultMap = {
  [VERSIONED_METHOD.textWrite]: VersionedTextWriteResult;
  [VERSIONED_METHOD.textRead]: VersionedTextReadResult;
  [VERSIONED_METHOD.textReadBlob]: VersionedTextReadBlobResult;
  [VERSIONED_METHOD.textRename]: VersionedTextRenameResult;
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
  [VERSIONED_METHOD.searchEnsureIndex]: SearchEnsureIndexResult;
};

export class VersionedProtocolShapeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VersionedProtocolShapeError";
  }
}

function mutableStruct<const Fields extends Schema.Struct.Fields>(fields: Fields) {
  return Schema.Struct(fields).mapFields(Struct.map(Schema.mutableKey));
}

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
    const path = issue?.path?.map((part) =>
      typeof part === "number" ? `[${part}]` : `.${String(part)}`,
    ).join("") ?? "";
    throw new VersionedProtocolShapeError(
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
const CorruptAuthorSchema = mutableStruct({ corrupt: Schema.Literal(true) });
const MomentAuthorSchema = Schema.NullOr(
  Schema.Union([AgentAuthorSchema, CorruptAuthorSchema]),
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

export function decodeVersionedTextWriteResult(value: JsonValue): VersionedTextWriteResult {
  return decodeVersionedSchema(
    TextWriteResultSchema,
    value,
    "versionedText.write result",
  ) as VersionedTextWriteResult;
}

export function decodeVersionedTextReadResult(value: JsonValue): VersionedTextReadResult {
  return decodeVersionedSchema(
    Schema.NullOr(VersionedTextReadValueSchema),
    value,
    "versionedText.read result",
  ) as VersionedTextReadResult;
}

export function decodeVersionedBinaryWriteResult(value: JsonValue): VersionedBinaryWriteResult {
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

export function decodeVersionedTextRenameResult(value: JsonValue): VersionedTextRenameResult {
  return decodeVersionedSchema(
    TextRenameResultSchema,
    value,
    "versionedText.rename result",
  ) as VersionedTextRenameResult;
}

export function decodeVersionedTextDeleteResult(value: JsonValue): VersionedTextDeleteResult {
  return decodeVersionedSchema(
    TextDeleteResultSchema,
    value,
    "versionedText.delete result",
  ) as VersionedTextDeleteResult;
}

export function decodeVersionedTextRollbackResult(value: JsonValue): VersionedTextRollbackResult {
  return decodeVersionedSchema(
    TextRollbackResultSchema,
    value,
    "versionedText.rollback result",
  ) as VersionedTextRollbackResult;
}

export function decodeVersionRecord(value: JsonValue): VersionRecord {
  return decodeVersionedSchema(VersionRecordSchema, value, "version record") as VersionRecord;
}

export function decodeVersionsActiveResult(value: JsonValue): VersionsActiveResult {
  return value === null ? null : decodeVersionRecord(value);
}

export function decodeVersionsListResult(value: JsonValue): VersionsListResult {
  return decodeVersionedSchema(
    VersionsListResultSchema,
    value,
    "versions.list result",
  ) as VersionsListResult;
}

export function decodeVersionsMergeResult(value: JsonValue): VersionsMergeResult {
  return decodeVersionedSchema(
    VersionsMergeResultSchema,
    value,
    "versionedText.merge result",
  ) as VersionsMergeResult;
}

export function decodeVersionsCompareFilesResult(value: JsonValue): VersionsCompareFilesResult {
  return decodeVersionedSchema(
    VersionsCompareFilesResultSchema,
    value,
    "versions.compareFiles result",
  ) as VersionsCompareFilesResult;
}

export function decodeVersionedBinaryReadResult(value: JsonValue): VersionedBinaryReadResult {
  return decodeVersionedSchema(
    BinaryReadResultSchema,
    value,
    "versionedBinary.read result",
  ) as VersionedBinaryReadResult;
}

function decodeBlobReadResult(
  value: JsonValue,
  label: string,
): VersionedBinaryReadBlobResult {
  const decoded = decodeVersionedSchema(
    BlobReadResultSchema,
    value,
    label,
  );
  return typeof decoded.bytesBase64 === "string"
    ? { bytesBase64: decoded.bytesBase64 }
    : decoded;
}

export function decodeVersionedBinaryReadBlobResult(value: JsonValue): VersionedBinaryReadBlobResult {
  return decodeBlobReadResult(value, "versionedBinary.readBlob result");
}

export function decodeVersionedTextReadBlobResult(value: JsonValue): VersionedTextReadBlobResult {
  return decodeBlobReadResult(value, "versionedText.readBlob result");
}

export function decodeSecretWriteResult(value: JsonValue): SecretWriteResult {
  return decodeVersionedSchema(
    SecretWriteResultSchema,
    value,
    "secrets.write result",
  ) as SecretWriteResult;
}

export function decodeSecretsListResult(value: JsonValue): SecretsListResult {
  return decodeVersionedSchema(
    SecretsListResultSchema,
    value,
    "secrets.list result",
  ) as SecretsListResult;
}

export function decodeSecretsStateExistsResult(value: JsonValue): boolean {
  return decodeVersionedSchema(
    Schema.Boolean,
    value,
    "secrets.stateExists result",
  );
}

export function decodeSecretsMaterializeResult(
  value: JsonValue,
): SecretsMaterializeResult {
  return decodeVersionedSchema(
    SecretsMaterializeResultSchema,
    value,
    "secrets.materialize result",
  ) as SecretsMaterializeResult;
}

export function decodeSecretDeleteResult(value: JsonValue): SecretDeleteResult {
  return decodeVersionedSchema(
    SecretDeleteResultSchema,
    value,
    "secrets.delete result",
  ) as SecretDeleteResult;
}

export function decodeSecretCompareResult(value: JsonValue): SecretCompareResult {
  return decodeVersionedSchema(
    SecretCompareResultSchema,
    value,
    "secrets.compare result",
  ) as SecretCompareResult;
}

export const decodeSecretApplyResult = decodeSecretWriteResult;

export function decodeSecretRestoreResult(value: JsonValue): SecretRestoreResult {
  return decodeVersionedSchema(
    SecretRestoreResultSchema,
    value,
    "secrets.restore result",
  ) as SecretRestoreResult;
}

export function decodeSecretsMomentsListResult(value: JsonValue): SecretsMomentsListResult {
  return decodeVersionedSchema(
    SecretsMomentsListResultSchema,
    value,
    "secrets.moments.list result",
  ) as SecretsMomentsListResult;
}

export function decodeSecretsMomentsGetResult(value: JsonValue): SecretsMomentsGetResult {
  return decodeVersionedSchema(
    Schema.NullOr(SecretMomentRecordSchema),
    value,
    "secrets.moments.get result",
  ) as SecretsMomentsGetResult;
}

export function decodeMomentsListResult(value: JsonValue): MomentsListResult {
  return decodeVersionedSchema(
    MomentsListResultSchema,
    value,
    "moments.list result",
  ) as MomentsListResult;
}

export function decodeMomentsGetResult(value: JsonValue): MomentsGetResult {
  return decodeVersionedSchema(
    Schema.NullOr(MomentRecordSchema),
    value,
    "moments.get result",
  ) as MomentsGetResult;
}

export function decodeVersionedTextListResult(
  value: JsonValue,
): VersionedTextListResult {
  return decodeVersionedSchema(
    TextListResultSchema,
    value,
    "versionedText.list result",
  ) as VersionedTextListResult;
}

export function decodeVersionsCompareResult(
  value: JsonValue,
): VersionsCompareResult {
  return decodeVersionedSchema(
    VersionedComparisonRecordSchema,
    value,
    "versionedText.compare result",
  ) as VersionsCompareResult;
}

function decodeEmptyObject(value: JsonValue, label: string): JsonObject {
  return decodeVersionedSchema(EmptyObjectSchema, value, label);
}

export function decodeVersionedResult<M extends VersionedMethod>(
  method: M,
  value: JsonValue,
): VersionedMethodResultMap[M] {
  let result: unknown;
  switch (method) {
    case VERSIONED_METHOD.textWrite:
      result = decodeVersionedTextWriteResult(value);
      break;
    case VERSIONED_METHOD.textRead:
      result = decodeVersionedTextReadResult(value);
      break;
    case VERSIONED_METHOD.textReadBlob:
      result = decodeVersionedTextReadBlobResult(value);
      break;
    case VERSIONED_METHOD.textRename:
      result = decodeVersionedTextRenameResult(value);
      break;
    case VERSIONED_METHOD.textDelete:
      result = decodeVersionedTextDeleteResult(value);
      break;
    case VERSIONED_METHOD.textRollback:
      result = decodeVersionedTextRollbackResult(value);
      break;
    case VERSIONED_METHOD.textList:
      result = decodeVersionedTextListResult(value);
      break;
    case VERSIONED_METHOD.binaryWrite:
    case VERSIONED_METHOD.binaryWriteBlob:
      result = decodeVersionedBinaryWriteResult(value);
      break;
    case VERSIONED_METHOD.binaryRead:
      result = decodeVersionedBinaryReadResult(value);
      break;
    case VERSIONED_METHOD.binaryReadBlob:
      result = decodeVersionedBinaryReadBlobResult(value);
      break;
    case VERSIONED_METHOD.versionsCreateNamed:
    case VERSIONED_METHOD.versionsSetActive:
    case VERSIONED_METHOD.versionsEnsureMain:
      result = decodeVersionRecord(value);
      break;
    case VERSIONED_METHOD.versionsList:
      result = decodeVersionsListResult(value);
      break;
    case VERSIONED_METHOD.versionsActive:
      result = decodeVersionsActiveResult(value);
      break;
    case VERSIONED_METHOD.versionsMerge:
      result = decodeVersionsMergeResult(value);
      break;
    case VERSIONED_METHOD.versionsCompare:
      result = decodeVersionsCompareResult(value);
      break;
    case VERSIONED_METHOD.versionsCompareFiles:
      result = decodeVersionsCompareFilesResult(value);
      break;
    case VERSIONED_METHOD.secretsWrite:
      result = decodeSecretWriteResult(value);
      break;
    case VERSIONED_METHOD.secretsList:
      result = decodeSecretsListResult(value);
      break;
    case VERSIONED_METHOD.secretsStateExists:
      result = decodeSecretsStateExistsResult(value);
      break;
    case VERSIONED_METHOD.secretsMaterialize:
      result = decodeSecretsMaterializeResult(value);
      break;
    case VERSIONED_METHOD.secretsDelete:
      result = decodeSecretDeleteResult(value);
      break;
    case VERSIONED_METHOD.secretsFork:
      result = decodeEmptyObject(value, "secrets.fork result");
      break;
    case VERSIONED_METHOD.secretsCompare:
      result = decodeSecretCompareResult(value);
      break;
    case VERSIONED_METHOD.secretsApply:
      result = decodeSecretApplyResult(value);
      break;
    case VERSIONED_METHOD.secretsRestore:
      result = decodeSecretRestoreResult(value);
      break;
    case VERSIONED_METHOD.secretsMomentsList:
      result = decodeSecretsMomentsListResult(value);
      break;
    case VERSIONED_METHOD.secretsMomentsGet:
      result = decodeSecretsMomentsGetResult(value);
      break;
    case VERSIONED_METHOD.momentsList:
      result = decodeMomentsListResult(value);
      break;
    case VERSIONED_METHOD.momentsGet:
      result = decodeMomentsGetResult(value);
      break;
    case VERSIONED_METHOD.searchEnsureIndex:
      result = decodeEmptyObject(value, "search.ensureIndex result");
      break;
    default: {
      const exhaustive: never = method;
      throw new VersionedProtocolShapeError(
        `Unsupported versioned method: ${exhaustive}`,
      );
    }
  }
  return result as VersionedMethodResultMap[M];
}
