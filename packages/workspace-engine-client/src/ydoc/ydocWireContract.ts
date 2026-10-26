import { ProtocolShapeError, mutableStruct } from "../wireSchema";
import * as Result from "effect/Result";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SchemaIssue from "effect/SchemaIssue";
import type { JsonValue } from "../protocol";
import type { AutomationRunAttribution } from "@dohc/workspace-contracts/collection";
import { parseLiveUpdateIdentifier } from "@dohc/live-session-contract/live-update-admission";
import { parseLiveObjectBinding, type LiveObjectBinding } from "@dohc/live-session-contract/live-object-binding";

export const YDOC_METHOD = {
  open: "ydoc.open",
  recordUpdate: "ydoc.recordUpdate",
  settle: "ydoc.settle",
  adoptCollectionRecord: "ydoc.adoptCollectionRecord",
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
  // The document this open continues. The engine refuses the open when the
  // path names another object. With no head, it also refuses to create a file
  // the document had and that was deleted outside dohc.
  expectedObjectId?: string;
  contentKind?: YdocContentKind;
  seedFromArtifact?: boolean;
  // The largest seed this client reads as a blob when it is past the engine's
  // in-band cap. Without it, such a seed refuses the open.
  seedLimitBytes?: number;
};

// Declared write provenance beside the actor origin: the kind of actor that
// wrote (a human, an agent, or an automation), the principal it acted for,
// its automation-chain depth, and for an automation the run that wrote it.
// Optional provenance, never a second authority; the engine records it on
// every history row the apply derives, and replicates it with the update.
export type ChangeAttributionWire = JsonObject & {
  actorKind: "human" | "agent" | "automation";
  onBehalfOf?: string;
  depth?: number;
  run?: AutomationRunAttribution;
};

export type YdocRecordUpdateParams = JsonObject & {
  sessionId: string;
  updateBase64: string;
  // The lineage claim this update's document was built on, as last observed
  // from open, record, or resync. The engine refuses the update with
  // ydoc-lineage-stale unless it matches the session's claim; null matches
  // only an unclaimed lineage.
  expectedLineageClaimId: string | null;
  actorOriginId?: string;
  attribution?: ChangeAttributionWire;
  trustedAutomationDraft?: boolean;
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
const LiveIdentifierSchema = Schema.String.check(Schema.makeFilter((value) => {
  try {
    parseLiveUpdateIdentifier(value);
    return true;
  } catch (error) {
    return (error as TypeError).message;
  }
}));
const PositiveSafeIntegerSchema = Schema.Int.check(Schema.isGreaterThan(0));
const NonnegativeSafeIntegerSchema = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
const OwnerAppendFields = {
  outboxId: LiveIdentifierSchema,
  sequence: PositiveSafeIntegerSchema,
  deliveryId: LiveIdentifierSchema,
  updateDigest: Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/)),
  pendingBytes: PositiveSafeIntegerSchema,
  state: Schema.Literals(["active", "sealed"]),
};
const OwnerYDocOutboxAppendResultSchema = Schema.Struct({
  ...OwnerAppendFields,
  oldestEntryAtMs: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
});
export type OwnerYDocOutboxAppendResult = typeof OwnerYDocOutboxAppendResultSchema.Type;

export function decodeOwnerYDocOutboxAppendResult(value: unknown): OwnerYDocOutboxAppendResult {
  const decoded = Schema.decodeUnknownResult(OwnerYDocOutboxAppendResultSchema)(value);
  if (Result.isFailure(decoded)) {
    throw new TypeError(`Invalid owner outbox append result: ${decoded.failure.message}`);
  }
  return decoded.success;
}

const LiveObjectBindingSchema = Schema.declareConstructor<LiveObjectBinding>()([], () => (value) => Effect.try({
  try: () => parseLiveObjectBinding(value),
  catch: (error) => new SchemaIssue.InvalidValue({ message: (error as TypeError).message }),
}));
const OwnerDraftSchema = mutableStruct({
  binding: LiveObjectBindingSchema,
  relayDatabaseNamespace: LiveIdentifierSchema, revision: PositiveSafeIntegerSchema,
  acceptedCursor: NonnegativeSafeIntegerSchema, nativeHeadSequence: NonnegativeSafeIntegerSchema,
  nativeUnsettled: Schema.Boolean,
  outboxId: Schema.NullOr(LiveIdentifierSchema), pendingBytes: NonnegativeSafeIntegerSchema,
  state: Schema.NullOr(Schema.Literals(["active", "sealed", "quarantined"])),
}).check(Schema.makeFilter((draft) =>
  draft.outboxId === null
    ? (draft.state === null && draft.pendingBytes === 0) || "An absent draft parent must have null state and zero pending bytes."
    : draft.state !== null || "A draft parent must have a state.",
));
export type YdocOwnerDraft = typeof OwnerDraftSchema.Type;

/** The particular locally committed write, independent of its current path. */
export interface SharedFileUpdate {
  outboxId: string | null;
  binding: YdocOwnerDraft["binding"];
  nativeHeadSequence: number;
  appendKey: string;
}
export type SharedFileUpdateState = "pending" | "settled" | "not-accepted" | "absent";

export function decodeOwnerYDocDraftDescriptor(value: unknown): YdocOwnerDraft {
  const decoded = Schema.decodeUnknownResult(OwnerDraftSchema)(value, { onExcessProperty: "error" });
  if (Result.isFailure(decoded)) {
    throw new TypeError(`Invalid draft descriptor: ${decoded.failure.message}`);
  }
  return decoded.success;
}
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
  // The resumed lineage holds updates its workspace file may not. Always
  // false when the lineage is absent.
  unsettled: Schema.Boolean,
  artifactAssets: Schema.optionalKey(Schema.mutable(Schema.Array(ArtifactAssetDescriptorSchema))),
  seedContent: Schema.optionalKey(Schema.String),
  // The Yjs client the seed of seedContent is built under. The engine derives
  // it from the head it seeds, so every device seeding that head sends the
  // same bytes and originates the same lineage.
  seedClientId: Schema.optionalKey(Schema.Int),
  // Set instead of seedContent for a seed past the in-band cap: the digest
  // the client reads it by through versionedText.readBlob.
  seedBlobSha256: Schema.optionalKey(Schema.String),
  lineageClaimId: Schema.NullOr(Schema.String),
  // Whether this device claimed the lineage from its own unclaimed history.
  lineageOriginatedHere: Schema.Boolean,
});
const RecordUpdateResultSchema = Schema.Union([mutableStruct({
  seq: Schema.Int,
  lineageClaimId: Schema.NullOr(Schema.String),
  lineageOriginatedHere: Schema.Boolean,
}), mutableStruct({
  lineageClaimId: Schema.String,
  lineageOriginatedHere: Schema.Boolean,
  ownerDraft: mutableStruct(OwnerAppendFields),
})]);
const ResyncResultSchema = mutableStruct({
  ownerDraft: Schema.optionalKey(OwnerDraftSchema),
  lineageClaimId: Schema.NullOr(Schema.String),
  lineageOriginatedHere: Schema.Boolean,
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
const RemoteUpdatePayloadSchema = Schema.Union([
  mutableStruct({sessionId: Schema.String, updateBase64: Schema.String}),
  mutableStruct({sessionId: Schema.String, resyncRequired: Schema.Literal(true)}),
]);

const YdocResultSchemas = {
  [YDOC_METHOD.open]: OpenResultSchema,
  [YDOC_METHOD.recordUpdate]: RecordUpdateResultSchema,
  [YDOC_METHOD.resync]: ResyncResultSchema,
  [YDOC_METHOD.settle]: SettleResultSchema,
  [YDOC_METHOD.adoptCollectionRecord]: mutableStruct({ status: Schema.Literals(["settled", "ownerPending", "declined"]) }),
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
