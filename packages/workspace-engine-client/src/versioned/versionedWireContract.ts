import type { JsonValue } from "../ydoc/generated/serde_json/JsonValue";

export const VERSIONED_METHOD = {
  textWrite: "versionedText.write",
  textRead: "versionedText.read",
  textRename: "versionedText.rename",
  textDelete: "versionedText.delete",
  textRollback: "versionedText.rollback",
  textList: "versionedText.list",
  binaryWrite: "versionedBinary.write",
  binaryRead: "versionedBinary.read",
  binaryReadBlob: "versionedBinary.readBlob",
  versionsCreateNamed: "versions.createNamed",
  versionsSetActive: "versions.setActive",
  versionsEnsureMain: "versions.ensureMain",
  versionsActive: "versions.active",
  versionsMerge: "versionedText.merge",
  versionsCompare: "versionedText.compare",
  versionsCompareFiles: "versions.compareFiles",
  secretsWrite: "secrets.write",
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

export type VersionedBinaryWriteParams = MutationMetadata & {
  versionId: string;
  objectId?: string;
  path: string;
  bytes?: number[];
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
};

export type SecretsDeleteParams = JsonObject & {
  workspaceId: string;
  versionId: string;
  path: string;
  origin: VersionedOrigin;
  momentId: string;
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
  author: MomentAuthor;
  syncRecordOnly: boolean;
  afterText: string | null;
  afterByteLength: number | null;
  afterInbandLimitBytes: number | null;
  beforeText: string | null;
  beforeByteLength: number | null;
  beforeInbandLimitBytes: number | null;
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
  byteLength: number | null;
  binarySha256: string | null;
  updatedAtMs: number;
  latestMomentId: string;
  metadataOrigin: string;
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
        status: "unchanged" | "conflict";
        deduped: boolean;
      })
  | (JsonObject & {
      status: "merged";
      writeKind: "write";
      object: FileObject;
      snapshot: SnapshotMetadata;
      moment: MomentRecord;
      deduped: boolean;
    } & MergeMaterializationResult)
  | (JsonObject & {
      status: "merged";
      writeKind: "delete";
      object: FileObject;
      moment: MomentRecord;
      deduped: boolean;
    } & MergeMaterializationResult);

export type VersionsCompareResult = JsonObject & {
  status: VersionedComparisonStatus;
};

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

export class VersionedProtocolShapeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VersionedProtocolShapeError";
  }
}

function objectValue(value: JsonValue, label: string): JsonObject {
  if (value === null || Array.isArray(value) || typeof value !== "object") {
    throw new VersionedProtocolShapeError(`${label} must be a JSON object.`);
  }
  return value;
}

function stringValue(object: JsonObject, key: string, label: string): string {
  const value = object[key];
  if (typeof value !== "string") {
    throw new VersionedProtocolShapeError(`${label}.${key} must be a string.`);
  }
  return value;
}

function numberValue(object: JsonObject, key: string, label: string): number {
  const value = object[key];
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new VersionedProtocolShapeError(
      `${label}.${key} must be a safe integer.`,
    );
  }
  return value;
}

function booleanValue(object: JsonObject, key: string, label: string): boolean {
  const value = object[key];
  if (typeof value !== "boolean") {
    throw new VersionedProtocolShapeError(`${label}.${key} must be a boolean.`);
  }
  return value;
}

function nullableStringValue(
  object: JsonObject,
  key: string,
  label: string,
): string | null {
  const value = object[key];
  if (value !== null && typeof value !== "string") {
    throw new VersionedProtocolShapeError(
      `${label}.${key} must be a string or null.`,
    );
  }
  return value;
}

function nullableNumberValue(
  object: JsonObject,
  key: string,
  label: string,
): number | null {
  const value = object[key];
  if (value !== null && (typeof value !== "number" || !Number.isSafeInteger(value))) {
    throw new VersionedProtocolShapeError(
      `${label}.${key} must be a safe integer or null.`,
    );
  }
  return value;
}

function arrayValue(object: JsonObject, key: string, label: string): JsonValue[] {
  const value = object[key];
  if (!Array.isArray(value)) {
    throw new VersionedProtocolShapeError(`${label}.${key} must be an array.`);
  }
  return value;
}

function contentKindValue(
  object: JsonObject,
  key: string,
  label: string,
): VersionedContentKind {
  const value = object[key];
  if (value !== "text" && value !== "binary") {
    throw new VersionedProtocolShapeError(
      `${label}.${key} must be text or binary.`,
    );
  }
  return value;
}

function fileObjectValue(value: JsonValue, label: string): FileObject {
  const object = objectValue(value, label);
  return {
    id: stringValue(object, "id", label),
    workspaceId: stringValue(object, "workspaceId", label),
    createdAtMs: numberValue(object, "createdAtMs", label),
  };
}

function snapshotMetadataValue(value: JsonValue, label: string): SnapshotMetadata {
  const object = objectValue(value, label);
  return {
    workspaceId: stringValue(object, "workspaceId", label),
    versionId: stringValue(object, "versionId", label),
    objectId: stringValue(object, "objectId", label),
    path: stringValue(object, "path", label),
    contentKind: contentKindValue(object, "contentKind", label),
    sha256: stringValue(object, "sha256", label),
    byteLength: numberValue(object, "byteLength", label),
    updatedAtMs: numberValue(object, "updatedAtMs", label),
    latestMomentId: stringValue(object, "latestMomentId", label),
    metadataOrigin: stringValue(object, "metadataOrigin", label),
  };
}

function momentAuthorValue(value: JsonValue, label: string): MomentAuthor {
  if (value === null) return null;
  const object = objectValue(value, label);
  if (object.corrupt === true) return { corrupt: true };
  if (object.kind !== "agent") {
    throw new VersionedProtocolShapeError(`${label}.kind is invalid.`);
  }
  const author: AgentAuthor = {
    kind: "agent",
    agentId: stringValue(object, "agentId", label),
    onBehalfOf: stringValue(object, "onBehalfOf", label),
  };
  if (object.agentRunId !== undefined) {
    author.agentRunId = stringValue(object, "agentRunId", label);
  }
  return author;
}

function momentValue(value: JsonValue, label: string): MomentRecord {
  const object = objectValue(value, label);
  const operation = object.operation;
  if (operation !== "write" && operation !== "delete" && operation !== "rename") {
    throw new VersionedProtocolShapeError(`${label}.operation is invalid.`);
  }
  return {
    momentOrder: numberValue(object, "momentOrder", label),
    momentId: stringValue(object, "momentId", label),
    versionId: stringValue(object, "versionId", label),
    objectId: stringValue(object, "objectId", label),
    path: stringValue(object, "path", label),
    recordedAtMs: numberValue(object, "recordedAtMs", label),
    operation,
    afterContentKind: contentKindValue(object, "afterContentKind", label),
    afterBlobSha256: nullableStringValue(object, "afterBlobSha256", label),
    afterBinarySha256: nullableStringValue(object, "afterBinarySha256", label),
    beforePresent: booleanValue(object, "beforePresent", label),
    beforeContentKind: contentKindValue(object, "beforeContentKind", label),
    beforeBlobSha256: nullableStringValue(object, "beforeBlobSha256", label),
    beforeBinarySha256: nullableStringValue(object, "beforeBinarySha256", label),
    beforeLatestMomentId: nullableStringValue(object, "beforeLatestMomentId", label),
    metadataOrigin: stringValue(object, "metadataOrigin", label),
    author: momentAuthorValue(object.author ?? null, `${label}.author`),
    syncRecordOnly: booleanValue(object, "syncRecordOnly", label),
    afterText: nullableStringValue(object, "afterText", label),
    afterByteLength: nullableNumberValue(object, "afterByteLength", label),
    afterInbandLimitBytes: nullableNumberValue(object, "afterInbandLimitBytes", label),
    beforeText: nullableStringValue(object, "beforeText", label),
    beforeByteLength: nullableNumberValue(object, "beforeByteLength", label),
    beforeInbandLimitBytes: nullableNumberValue(object, "beforeInbandLimitBytes", label),
  };
}

function secretMomentValue(value: JsonValue, label: string): SecretMomentRecord {
  const object = objectValue(value, label);
  const operation = object.operation;
  if (operation !== "write" && operation !== "delete") {
    throw new VersionedProtocolShapeError(`${label}.operation is invalid.`);
  }
  const metadata = objectValue(object.metadata ?? null, `${label}.metadata`);
  const summary = nullableStringValue(metadata, "summary", `${label}.metadata`);
  const correlationId = nullableStringValue(
    metadata,
    "correlationId",
    `${label}.metadata`,
  );
  if (object.protected !== true) {
    throw new VersionedProtocolShapeError(`${label}.protected must be true.`);
  }
  return {
    id: stringValue(object, "id", label),
    workspaceId: stringValue(object, "workspaceId", label),
    versionId: stringValue(object, "versionId", label),
    path: stringValue(object, "path", label),
    recordedAtMs: numberValue(object, "recordedAtMs", label),
    operation,
    metadata: {
      origin: stringValue(metadata, "origin", `${label}.metadata`),
      summary,
      correlationId,
    },
    momentOrder: numberValue(object, "momentOrder", label),
    protected: true,
  };
}

export function decodeVersionedTextWriteResult(value: JsonValue): VersionedTextWriteResult {
  const label = "versionedText.write result";
  const object = objectValue(value, label);
  const snapshot = snapshotMetadataValue(object.snapshot ?? null, `${label}.snapshot`);
  const snapshotObject = objectValue(object.snapshot ?? null, `${label}.snapshot`);
  if (snapshot.contentKind !== "text") {
    throw new VersionedProtocolShapeError(`${label}.snapshot.contentKind must be text.`);
  }
  return {
    object: fileObjectValue(object.object ?? null, `${label}.object`),
    snapshot: {
      ...snapshot,
      contentKind: "text",
      text: stringValue(snapshotObject, "text", `${label}.snapshot`),
      blobSha256: stringValue(snapshotObject, "blobSha256", `${label}.snapshot`),
    },
    moment: momentValue(object.moment ?? null, `${label}.moment`),
    deduped: booleanValue(object, "deduped", label),
  };
}

export function decodeVersionedTextReadResult(value: JsonValue): VersionedTextReadResult {
  if (value === null) return null;
  const label = "versionedText.read result";
  const object = objectValue(value, label);
  const metadata = snapshotMetadataValue(value, label);
  const blobSha256 = stringValue(object, "blobSha256", label);
  const text = nullableStringValue(object, "text", label);

  if (metadata.contentKind === "binary") {
    if (text !== "") {
      throw new VersionedProtocolShapeError(`${label}.text must be empty for binary content.`);
    }
    if (object.inbandLimitBytes !== undefined) {
      throw new VersionedProtocolShapeError(
        `${label}.inbandLimitBytes is invalid for binary content.`,
      );
    }
    return { ...metadata, contentKind: "binary", text: "", blobSha256 };
  }

  if (text === null) {
    return {
      ...metadata,
      contentKind: "text",
      text: null,
      blobSha256,
      inbandLimitBytes: numberValue(object, "inbandLimitBytes", label),
    };
  }
  if (object.inbandLimitBytes !== undefined) {
    throw new VersionedProtocolShapeError(
      `${label}.inbandLimitBytes is invalid for in-band text.`,
    );
  }
  return { ...metadata, contentKind: "text", text, blobSha256 };
}

export function decodeVersionedBinaryWriteResult(value: JsonValue): VersionedBinaryWriteResult {
  const label = "versionedBinary.write result";
  const object = objectValue(value, label);
  const snapshot = objectValue(object.snapshot ?? null, `${label}.snapshot`);
  if (snapshot.contentKind !== "binary") {
    throw new VersionedProtocolShapeError(`${label}.snapshot.contentKind must be binary.`);
  }
  if (snapshot.text !== "") {
    throw new VersionedProtocolShapeError(`${label}.snapshot.text must be empty.`);
  }
  return {
    object: fileObjectValue(object.object ?? null, `${label}.object`),
    snapshot: {
      objectId: stringValue(snapshot, "objectId", `${label}.snapshot`),
      path: stringValue(snapshot, "path", `${label}.snapshot`),
      contentKind: "binary",
      text: "",
      sha256: stringValue(snapshot, "sha256", `${label}.snapshot`),
      byteLength: numberValue(snapshot, "byteLength", `${label}.snapshot`),
      updatedAtMs: numberValue(snapshot, "updatedAtMs", `${label}.snapshot`),
      latestMomentId: stringValue(snapshot, "latestMomentId", `${label}.snapshot`),
    },
    moment: momentValue(object.moment ?? null, `${label}.moment`),
    deduped: booleanValue(object, "deduped", label),
    materializeEnqueued: booleanValue(object, "materializeEnqueued", label),
    materialized: booleanValue(object, "materialized", label),
    materializeOutcome: materializeOutcomeValue(object, label),
  };
}

export function decodeVersionedTextRenameResult(value: JsonValue): VersionedTextRenameResult {
  const label = "versionedText.rename result";
  const object = objectValue(value, label);
  return {
    object: fileObjectValue(object.object ?? null, `${label}.object`),
    before: snapshotMetadataValue(object.before ?? null, `${label}.before`),
    after: snapshotMetadataValue(object.after ?? null, `${label}.after`),
    moment: momentValue(object.moment ?? null, `${label}.moment`),
    deduped: booleanValue(object, "deduped", label),
  };
}

export function decodeVersionedTextDeleteResult(value: JsonValue): VersionedTextDeleteResult {
  const label = "versionedText.delete result";
  const object = objectValue(value, label);
  return {
    object: fileObjectValue(object.object ?? null, `${label}.object`),
    before: snapshotMetadataValue(object.before ?? null, `${label}.before`),
    moment: momentValue(object.moment ?? null, `${label}.moment`),
    deduped: booleanValue(object, "deduped", label),
  };
}

export function decodeVersionedTextRollbackResult(value: JsonValue): VersionedTextRollbackResult {
  const label = "versionedText.rollback result";
  const object = objectValue(value, label);
  if (object.rolledBack !== true) {
    throw new VersionedProtocolShapeError(`${label}.rolledBack must be true.`);
  }
  return {
    rolledBack: true,
    deduped: booleanValue(object, "deduped", label),
    materializeEnqueued: booleanValue(object, "materializeEnqueued", label),
    materialized: booleanValue(object, "materialized", label),
    materializeOutcome: materializeOutcomeValue(object, label),
  };
}

function materializeOutcomeValue(object: JsonObject, label: string): MaterializeOutcome {
  const outcome = object.materializeOutcome;
  if (
    outcome !== "applied" &&
    outcome !== "skipped" &&
    outcome !== "conflict" &&
    outcome !== "superseded" &&
    outcome !== "error"
  ) {
    throw new VersionedProtocolShapeError(`${label}.materializeOutcome is invalid.`);
  }
  return outcome;
}

export function decodeVersionRecord(value: JsonValue): VersionRecord {
  const label = "version record";
  const object = objectValue(value, label);
  const kind = object.kind;
  if (kind !== "main" && kind !== "named") {
    throw new VersionedProtocolShapeError(`${label}.kind must be main or named.`);
  }
  const record: VersionRecord = {
    id: stringValue(object, "id", label),
    workspaceId: stringValue(object, "workspaceId", label),
    kind,
    name: stringValue(object, "name", label),
    createdAtMs: numberValue(object, "createdAtMs", label),
  };
  if (object.forkPoint !== undefined) {
    const fork = objectValue(object.forkPoint, `${label}.forkPoint`);
    record.forkPoint = { versionId: stringValue(fork, "versionId", `${label}.forkPoint`) };
    if (fork.momentId !== undefined) {
      record.forkPoint.momentId = stringValue(fork, "momentId", `${label}.forkPoint`);
    }
  }
  return record;
}

export function decodeVersionsActiveResult(value: JsonValue): VersionsActiveResult {
  return value === null ? null : decodeVersionRecord(value);
}

export function decodeVersionsMergeResult(value: JsonValue): VersionsMergeResult {
  const label = "versionedText.merge result";
  const object = objectValue(value, label);
  const status = object.status;
  const materialization: MergeMaterializationResult = {
    materializeEnqueued: booleanValue(object, "materializeEnqueued", label),
    materialized: booleanValue(object, "materialized", label),
    materializeOutcome: materializeOutcomeValue(object, label),
  };
  if (status === "unchanged" || status === "conflict") {
    return {
      status,
      deduped: booleanValue(object, "deduped", label),
      ...materialization,
    };
  }
  if (status !== "merged") {
    throw new VersionedProtocolShapeError(`${label}.status is invalid.`);
  }
  const writeKind = object.writeKind;
  if (writeKind === "write") {
    return {
      status,
      writeKind,
      object: fileObjectValue(object.object ?? null, `${label}.object`),
      snapshot: snapshotMetadataValue(object.snapshot ?? null, `${label}.snapshot`),
      moment: momentValue(object.moment ?? null, `${label}.moment`),
      deduped: booleanValue(object, "deduped", label),
      ...materialization,
    };
  }
  if (writeKind === "delete") {
    return {
      status,
      writeKind,
      object: fileObjectValue(object.object ?? null, `${label}.object`),
      moment: momentValue(object.moment ?? null, `${label}.moment`),
      deduped: booleanValue(object, "deduped", label),
      ...materialization,
    };
  }
  throw new VersionedProtocolShapeError(`${label}.writeKind is invalid.`);
}

export function decodeVersionsCompareFilesResult(value: JsonValue): VersionsCompareFilesResult {
  const label = "versions.compareFiles result";
  const object = objectValue(value, label);
  const entries = arrayValue(object, "entries", label).map((entry, index) => {
    const entryLabel = `${label}.entries[${index}]`;
    const row = objectValue(entry, entryLabel);
    const status = row.status;
    if (status !== "added" && status !== "modified" && status !== "deleted") {
      throw new VersionedProtocolShapeError(`${entryLabel}.status is invalid.`);
    }
    const decoded: VersionsCompareFilesEntry = {
      path: stringValue(row, "path", entryLabel),
      status,
    };
    if (row.binary !== undefined) {
      if (row.binary !== true) {
        throw new VersionedProtocolShapeError(`${entryLabel}.binary must be true.`);
      }
      decoded.binary = true;
    }
    return decoded;
  });
  return { entries, nextCursor: nullableStringValue(object, "nextCursor", label) };
}

export function decodeVersionedBinaryReadResult(value: JsonValue): VersionedBinaryReadResult {
  if (value === null) return null;
  const label = "versionedBinary.read result";
  const object = objectValue(value, label);
  const bytesBase64 = nullableStringValue(object, "bytesBase64", label);
  const result: VersionedBinaryReadValue = {
    objectId: stringValue(object, "objectId", label),
    sha256: stringValue(object, "sha256", label),
    byteLength: numberValue(object, "byteLength", label),
    bytesBase64,
  };
  if (bytesBase64 === null) {
    result.inbandLimitBytes = numberValue(object, "inbandLimitBytes", label);
  } else if (object.inbandLimitBytes !== undefined) {
    throw new VersionedProtocolShapeError(
      `${label}.inbandLimitBytes is invalid for in-band bytes.`,
    );
  }
  return result;
}

export function decodeVersionedBinaryReadBlobResult(value: JsonValue): VersionedBinaryReadBlobResult {
  const label = "versionedBinary.readBlob result";
  const object = objectValue(value, label);
  if (object.bytesBase64 === null) {
    return {
      bytesBase64: null,
      byteLength: numberValue(object, "byteLength", label),
      inbandLimitBytes: numberValue(object, "inbandLimitBytes", label),
    };
  }
  return { bytesBase64: stringValue(object, "bytesBase64", label) };
}

export function decodeSecretWriteResult(value: JsonValue): SecretWriteResult {
  const label = "secrets.write result";
  const object = objectValue(value, label);
  return {
    changed: booleanValue(object, "changed", label),
    moment: object.moment === null
      ? null
      : secretMomentValue(object.moment ?? null, `${label}.moment`),
  };
}

export function decodeSecretDeleteResult(value: JsonValue): SecretDeleteResult {
  const label = "secrets.delete result";
  const object = objectValue(value, label);
  return {
    moment: object.moment === null
      ? null
      : secretMomentValue(object.moment ?? null, `${label}.moment`),
  };
}

export function decodeSecretCompareResult(value: JsonValue): SecretCompareResult {
  const label = "secrets.compare result";
  const object = objectValue(value, label);
  const entries = arrayValue(object, "entries", label).map((entry, index) => {
    const entryLabel = `${label}.entries[${index}]`;
    const row = objectValue(entry, entryLabel);
    const status = row.status;
    if (status !== "added" && status !== "modified" && status !== "deleted") {
      throw new VersionedProtocolShapeError(`${entryLabel}.status is invalid.`);
    }
    const decoded: SecretCompareEntry = {
      path: stringValue(row, "path", entryLabel),
      status,
    };
    return decoded;
  });
  return { entries, nextAfterPath: nullableStringValue(object, "nextAfterPath", label) };
}

export const decodeSecretApplyResult = decodeSecretWriteResult;

export function decodeSecretRestoreResult(value: JsonValue): SecretRestoreResult {
  const label = "secrets.restore result";
  const object = objectValue(value, label);
  const restored = object.restored;
  if (restored !== "text" && restored !== "deleted") {
    throw new VersionedProtocolShapeError(`${label}.restored is invalid.`);
  }
  return {
    restored,
    restoredMomentId: stringValue(object, "restoredMomentId", label),
    path: stringValue(object, "path", label),
  };
}

export function decodeSecretsMomentsListResult(value: JsonValue): SecretsMomentsListResult {
  const label = "secrets.moments.list result";
  const object = objectValue(value, label);
  return {
    moments: arrayValue(object, "moments", label).map((moment, index) =>
      secretMomentValue(moment, `${label}.moments[${index}]`),
    ),
    nextBeforeMomentOrder: nullableNumberValue(object, "nextBeforeMomentOrder", label),
  };
}

export function decodeSecretsMomentsGetResult(value: JsonValue): SecretsMomentsGetResult {
  return value === null ? null : secretMomentValue(value, "secrets.moments.get result");
}

export function decodeMomentsListResult(value: JsonValue): MomentsListResult {
  const label = "moments.list result";
  const object = objectValue(value, label);
  return {
    moments: arrayValue(object, "moments", label).map((moment, index) =>
      momentValue(moment, `${label}.moments[${index}]`),
    ),
    nextBeforeMomentOrder: nullableNumberValue(object, "nextBeforeMomentOrder", label),
    latestMomentOrder: numberValue(object, "latestMomentOrder", label),
  };
}

export function decodeMomentsGetResult(value: JsonValue): MomentsGetResult {
  return value === null ? null : momentValue(value, "moments.get result");
}
