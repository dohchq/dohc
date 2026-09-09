import { ProtocolShapeError, mutableStruct } from "../wireSchema";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as SchemaIssue from "effect/SchemaIssue";
import type { JsonValue } from "../protocol";

export const YDOC_METHOD = {
  open: "ydoc.open",
  recordUpdate: "ydoc.recordUpdate",
  settle: "ydoc.settle",
  close: "ydoc.close",
  // Ends a session without settling and without pruning: the daemon drops the
  // session and its lease and leaves the durable lineage alone. The only exit
  // for a session that may not write its artifact and may not discard its
  // CRDT — see `EngineYdocProviderSession.evict`.
  evict: "ydoc.evict",
  // Re-fetches the session's lineage after a stale signal; the daemon serves
  // it in `EngineService::ydoc_resync`.
  resync: "ydoc.resync",
} as const;

export const YDOC_EVENT = {
  remoteUpdate: "ydoc.remoteUpdate",
} as const;

export type YdocContentKind = typeof YdocContentKindSchema.Type;
export type JsonObject = { [key: string]: JsonValue | undefined };

export type ArtifactAssetDescriptor = typeof ArtifactAssetDescriptorSchema.Type;

export type YdocOpenParams = JsonObject & {
  versionId: string;
  path: string;
  expectedObjectId?: string;
  contentKind?: YdocContentKind;
  seedFromArtifact?: boolean;
};

// Declared write provenance beside the actor origin: the kind of actor that
// wrote (a human, an agent, or an automation), the principal it acted for,
// and its automation-chain depth. Optional provenance, never a second authority; the
// engine records it on the update row and every history row the apply
// derives, and replicates it with the update.
export type ChangeAttributionWire = JsonObject & {
  actorKind: "human" | "agent" | "automation";
  onBehalfOf?: string;
  depth?: number;
};

export type YdocRecordUpdateParams = JsonObject & {
  sessionId: string;
  updateBase64: string;
  actorOriginId?: string;
  attribution?: ChangeAttributionWire;
  // Declares this update as the SEED: a faithful import of the seedContent
  // the open returned, built before any user input could reach the session.
  // Only the adapter's applySeedUpdate path sends it — never a replay of
  // prior state. The engine records the open-time head as the lineage's seed
  // source; a session whose only update is that seed then settles and closes
  // without rewriting the file.
  seed?: boolean;
};

export type YdocRecordUpdateResult = typeof RecordUpdateResultSchema.Type;

export type YdocSettleParams = JsonObject & {
  sessionId: string;
  summary?: string;
};

export type YdocSettleResult = typeof SettleResultSchema.Type;

export type YdocCloseParams = JsonObject & {
  sessionId: string;
  settle?: boolean;
  summary?: string;
};

export type YdocEvictParams = JsonObject & {
  sessionId: string;
};

type YdocRemoteUpdatePayload = typeof RemoteUpdatePayloadSchema.Type;

function decodeYdocSchema<S extends Schema.ConstraintDecoder<unknown>>(
  schema: S,
  value: JsonValue,
  label: string,
): S["Type"] {
  const decoded = Schema.decodeUnknownResult(schema)(value);
  if (Result.isFailure(decoded)) {
    const issue = SchemaIssue.makeFormatterStandardSchemaV1()(
      decoded.failure.issue,
    ).issues[0];
    const path = issue?.path?.map((part) =>
      typeof part === "number" ? `[${part}]` : `.${String(part)}`,
    ).join("") ?? "";
    throw new ProtocolShapeError(
      `${label}${path}: ${issue?.message ?? decoded.failure.message}`,
    );
  }
  return decoded.success;
}

const YdocContentKindSchema = Schema.Literals(["richdoc", "plaintext", "scene"]);
const OwnerDraftSchema = mutableStruct({
  binding: mutableStruct({
    workspaceId: Schema.String, mainVersionId: Schema.String, objectId: Schema.String,
    lineageClaimId: Schema.String, currentPath: Schema.String,
    selectorPaths: Schema.mutable(Schema.Array(Schema.String)), restoreFenceGeneration: Schema.Int,
  }),
  relayDatabaseNamespace: Schema.String, revision: Schema.Int,
  acceptedCursor: Schema.Int, nativeHeadSequence: Schema.Int,
  outboxId: Schema.NullOr(Schema.String), pendingBytes: Schema.Int,
  state: Schema.NullOr(Schema.Literals(["active", "sealed", "quarantined"])),
});
export type YdocOwnerDraft = typeof OwnerDraftSchema.Type;
const ArtifactAssetDescriptorSchema = mutableStruct({
  id: Schema.String,
  mimeType: Schema.String,
  created: Schema.Int,
  ref: Schema.String,
  sha256: Schema.String,
  lastRetrieved: Schema.optionalKey(Schema.Int),
  version: Schema.optionalKey(Schema.Int),
});
const OpenResultSchema = mutableStruct({
  ownerDraft: Schema.optionalKey(OwnerDraftSchema),
  sessionId: Schema.String,
  objectId: Schema.String,
  path: Schema.String,
  contentKind: YdocContentKindSchema,
  // Head describes the entered version's snapshot. Lineage describes durable
  // CRDT state. Only both absent means the session has neither source.
  head: Schema.Literals(["present", "absent"]),
  lineage: Schema.Literals(["existing", "absent"]),
  artifactAssets: Schema.optionalKey(Schema.mutable(Schema.Array(ArtifactAssetDescriptorSchema))),
  seedContent: Schema.optionalKey(Schema.String),
  lineageClaimId: Schema.NullOr(Schema.String),
});
const RecordUpdateResultSchema = Schema.Union([mutableStruct({
  seq: Schema.Int,
  lineageClaimId: Schema.NullOr(Schema.String),
}), mutableStruct({
  lineageClaimId: Schema.String,
  ownerDraft: mutableStruct({
    outboxId: Schema.String, sequence: Schema.Int, deliveryId: Schema.String,
    updateDigest: Schema.String, pendingBytes: Schema.Int,
    state: Schema.Literals(["active", "sealed", "quarantined"]),
  }),
})]);
const ResyncResultSchema = mutableStruct({
  ownerDraft: Schema.optionalKey(OwnerDraftSchema),
  lineageClaimId: Schema.NullOr(Schema.String),
  recoveredPaths: Schema.mutable(Schema.Array(Schema.String)),
  artifactAssets: Schema.mutable(Schema.Array(ArtifactAssetDescriptorSchema)),
});
const ProjectionProvenanceSchema = mutableStruct({
  contentKind: YdocContentKindSchema,
  sourceStateVectorSha256: Schema.String,
  destructive: Schema.Boolean,
});
const SettleResultSchema = mutableStruct({
  momentId: Schema.String,
  path: Schema.String,
  // Null means the committed content exceeded the in-band cap. Read the file.
  content: Schema.NullOr(Schema.String),
  sha256: Schema.String,
  // False means settlement committed but materialization is pending. Do not report saved.
  materialized: Schema.Boolean,
  projection: ProjectionProvenanceSchema,
});
const CloseResultSchema = mutableStruct({ closed: Schema.Literal(true) });
const EvictResultSchema = mutableStruct({ evicted: Schema.Literal(true) });
const RemoteUpdatePayloadSchema = mutableStruct({
  sessionId: Schema.String,
  updateBase64: Schema.String,
});

const YdocResultSchemas = {
  [YDOC_METHOD.open]: OpenResultSchema,
  [YDOC_METHOD.recordUpdate]: RecordUpdateResultSchema,
  [YDOC_METHOD.resync]: ResyncResultSchema,
  [YDOC_METHOD.settle]: SettleResultSchema,
  [YDOC_METHOD.close]: CloseResultSchema,
  [YDOC_METHOD.evict]: EvictResultSchema,
} as const;

type YdocMethod = keyof typeof YdocResultSchemas;
type YdocMethodResultMap = {
  [M in YdocMethod]: (typeof YdocResultSchemas)[M]["Type"];
};

function validateOpenAssets(assets: ArtifactAssetDescriptor[] | undefined): void {
  assets?.forEach((asset, index) => {
    if (
      asset.id.length === 0 ||
      asset.mimeType.length === 0 ||
      !isNonnegativeSafeInteger(asset.created) ||
      (asset.lastRetrieved !== undefined &&
        !isNonnegativeSafeInteger(asset.lastRetrieved)) ||
      (asset.version !== undefined &&
        !isNonnegativeSafeInteger(asset.version)) ||
      !isNormalizedWorkspaceRef(asset.ref) ||
      !/^[0-9a-f]{64}$/.test(asset.sha256)
    ) {
      throw new ProtocolShapeError(
        `ydoc.open result.artifactAssets[${index}] is not a valid asset descriptor.`,
      );
    }
  });
}

function isNonnegativeSafeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function isNormalizedWorkspaceRef(ref: string): boolean {
  if (
    !ref ||
    ref.includes("\\") ||
    ref.startsWith("/") ||
    /[:\u0000-\u001f\u007f-\u009f]/.test(ref) ||
    !hasWellFormedSurrogates(ref)
  ) {
    return false;
  }
  return ref
    .split("/")
    .every((part) => part.length > 0 && part !== "." && part !== "..");
}

function hasWellFormedSurrogates(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      return false;
    }
  }
  return true;
}

export function decodeYdocResult<M extends YdocMethod>(
  method: M,
  value: JsonValue,
): YdocMethodResultMap[M] {
  if (method === YDOC_METHOD.open) {
    const decoded = decodeYdocSchema(OpenResultSchema, value, `${method} result`);
    validateOpenAssets(decoded.artifactAssets);
    if (decoded.ownerDraft && (
      decoded.contentKind !== "richdoc" || decoded.lineage !== "existing"
      || decoded.ownerDraft.binding.objectId !== decoded.objectId
      || decoded.ownerDraft.binding.currentPath !== decoded.path
      || decoded.ownerDraft.binding.lineageClaimId !== decoded.lineageClaimId
    )) {
      throw new ProtocolShapeError("ydoc.open owner draft does not match the editor session.");
    }
    return decoded as YdocMethodResultMap[M];
  }
  return decodeYdocSchema(
    YdocResultSchemas[method],
    value,
    `${method} result`,
  ) as YdocMethodResultMap[M];
}

export function decodeYdocRemoteUpdatePayload(
  value: JsonValue,
): YdocRemoteUpdatePayload {
  return decodeYdocSchema(
    RemoteUpdatePayloadSchema,
    value,
    "ydoc.remoteUpdate payload",
  );
}
