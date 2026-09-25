import { ProtocolShapeError, mutableStruct } from "../wireSchema";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as SchemaGetter from "effect/SchemaGetter";
import {
  COLLECTION_SCHEMA_REASON_CODES,
  FIELD_VALUE_REASON_CODES,
  type CollectionGetParams as CollectionGetContractParams,
  type CollectionGetRecordParams as CollectionGetRecordContractParams,
  type CollectionGetRecordResult as CollectionGetRecordContractResult,
  type CollectionGetResult as CollectionGetContractResult,
  type CollectionListResult as CollectionListContractResult,
  type CollectionQueryParams as CollectionQueryContractParams,
  type CollectionQueryResult as CollectionQueryContractResult,
  type CollectionValue,
} from "@dohc/workspace-contracts/collection";
import type { JsonValue } from "../protocol";

export const WORKSPACE_METHOD = {
  open: "workspace.open",
  close: "workspace.close",
  conflictsList: "conflicts.list",
  conflictsOpen: "conflicts.open",
  conflictsResolve: "conflicts.resolve",
  collectionsList: "collections.list",
  collectionsListPendingAdoptions: "collections.listPendingAdoptions",
  collectionsGet: "collections.get",
  collectionsQuery: "collections.query",
  collectionsGetRecord: "collections.getRecord",
  searchQueryPage: "search.queryPage",
  searchQueryChatMessagesGranular: "search.queryChatMessagesGranular",
  watcherStatus: "watcher.status",
  captureFlush: "capture.flush",
  captureReconcile: "capture.reconcile",
  captureSetAuthor: "capture.setAuthor",
  automationsSubscribe: "automations.subscribe",
  automationsUnsubscribe: "automations.unsubscribe",
  automationsClaimNext: "automations.claimNext",
  automationsFailures: "automations.failures",
  automationsListClaims: "automations.listClaims",
  automationsSettle: "automations.settle",
  automationsRetry: "automations.retry",
  automationsRelease: "automations.release",
  automationsPress: "automations.press",
  automationsClaimSchedule: "automations.claimSchedule",
  automationsScheduleMarks: "automations.scheduleMarks",
  syncRemoteChanges: "sync.remoteChanges",
} as const;

/**
 * Emitted by the daemon post-commit, once per automation claim a LOCAL apply
 * inserted (ADR 0008: a synced apply claims nothing). A wake-up for the
 * desktop's drain loop, not the claim transport — the claim is taken with
 * `automations.claimNext`. The payload is the claim without its field facts.
 */
export const AUTOMATION_CLAIMED_EVENT = "automation.claimed";

export type WorkspaceMethod =
  (typeof WORKSPACE_METHOD)[keyof typeof WORKSPACE_METHOD];
type WorkspaceJsonObject = {
  [key: string]: JsonValue | undefined;
};

export type WorkspaceOpenParams = WorkspaceJsonObject & {
  rootDir: string;
  workspaceId: string;
  captureAuthor?:
    | (WorkspaceJsonObject & {
        kind: "agent";
        agentId: string;
        onBehalfOf: string;
        agentRunId?: string;
      })
    | null;
  captureMode?: "none";
  recoverRunningDispatches?: boolean;
};
type WorkspaceEmptyParams = WorkspaceJsonObject;
export type CollectionGetParams = WorkspaceJsonObject &
  CollectionGetContractParams;
export type CollectionQueryParams = CollectionQueryContractParams;
export type CollectionGetRecordParams = WorkspaceJsonObject &
  CollectionGetRecordContractParams;
export type ConflictListParams = WorkspaceJsonObject & {
  status?: "open" | "resolved";
  afterConflictId?: string;
};
export type ConflictOpenParams = WorkspaceJsonObject & {
  conflict?: WorkspaceJsonObject;
  envelope?: WorkspaceJsonObject;
};
export type ConflictResolveParams = WorkspaceJsonObject & {
  local?: WorkspaceJsonObject;
  envelope?: WorkspaceJsonObject;
};
export type SearchQueryPageParams = WorkspaceJsonObject & {
  query: string;
  limit?: number;
  cursor?: string;
  nowMs?: number;
};
type SearchQueryChatMessagesGranularParams = WorkspaceJsonObject & {
  query: string;
  limit: number;
};

export const MAX_GRANULAR_CHAT_QUERY_CHARS = 4096;

export type ConflictFileState = typeof ConflictFileStateSchema.Type;

export type ConflictRecord = typeof ConflictRecordSchema.Type;

export type ConflictOpenResult =
  WorkspaceMethodResultMap[typeof WORKSPACE_METHOD.conflictsOpen];
export type ConflictResolveResult =
  WorkspaceMethodResultMap[typeof WORKSPACE_METHOD.conflictsResolve];

export type CollectionListResult = CollectionListContractResult;
type CollectionListParams = WorkspaceJsonObject & {
  limit?: number;
  cursor?: string;
};
export type CollectionListPage = WorkspaceJsonObject & {
  collections: CollectionListResult["collections"];
  nextCursor: string | null;
};
type CollectionPendingAdoption = WorkspaceJsonObject & {
  versionId: string;
  recordId: string;
  collectionPath: string;
  filePath: string;
  objectId: string;
};
export type CollectionPendingAdoptionCursor = WorkspaceJsonObject & {
  filePath: string;
  recordId: string;
};
export type CollectionPendingAdoptionsParams = WorkspaceJsonObject & {
  limit?: number;
  cursor?: CollectionPendingAdoptionCursor;
};
export type CollectionPendingAdoptionsPage = WorkspaceJsonObject & {
  adoptions: CollectionPendingAdoption[];
  nextCursor: CollectionPendingAdoptionCursor | null;
};
export type CollectionGetResult = CollectionGetContractResult;
export type CollectionQueryResult = CollectionQueryContractResult;
export type CollectionGetRecordResult = CollectionGetRecordContractResult;

export type SearchResult = typeof SearchResultSchema.Type;
export type GranularChatMessageSearchResult =
  GranularChatMessageSearchResponse["results"][number];
export type GranularChatMessageSearchResponse =
  typeof GranularChatMessageSearchResponseSchema.Type;

export type WatcherStatusResult =
  WorkspaceMethodResultMap[typeof WORKSPACE_METHOD.watcherStatus];

export type CaptureFlushResult = typeof CaptureFlushResultSchema.Type;
/** A kind of record change a subscription wants and a claim runs for. */
export type AutomationChangeKind = "added" | "changed" | "removed";

/** Mirrors AutomationSubscribeParams in crates/dohc-workspace-engine. */
export type AutomationSubscribeParams = WorkspaceJsonObject & {
  automationId: string;
  /** Collection path prefix; "." covers the whole workspace. */
  path: string;
  /** The change kinds that claim; at least one. */
  kinds: AutomationChangeKind[];
  /**
   * A changed record claims only when one of these fields changed (at most
   * 64). Omitted, any field change claims. Added and removed records ignore
   * it.
   */
  fields?: string[];
};

/** Mirrors AutomationUnsubscribeParams in crates/dohc-workspace-engine. */
export type AutomationUnsubscribeParams = WorkspaceJsonObject & {
  automationId: string;
  path: string;
};

export type AutomationClaimNextParams = WorkspaceJsonObject & {
  nowMs?: number;
  /**
   * Serve only claims whose automation id starts with this, so each
   * executor drains its own namespace: the plugin executor "plugin:" (ids
   * "plugin:<plugin name>/<automation id>"), the Collection executor
   * "collection:" (ids "collection:<collection path>#<automation id>").
   */
  automationIdPrefix: string;
};

export type AutomationSettleParams = WorkspaceJsonObject & {
  claimId: string;
  state: "done" | "failed";
  /** Required exactly when state is "failed". */
  error?: string;
  nowMs?: number;
};

export type AutomationRetryParams = WorkspaceJsonObject & {
  claimId: string;
  nowMs?: number;
};

export type AutomationReleaseParams = WorkspaceJsonObject & {
  claimId: string;
  nowMs?: number;
};

export type AutomationListClaimsParams = WorkspaceJsonObject & {
  automationId: string;
};

/** Mirrors AutomationPressParams in crates/dohc-workspace-engine. */
export type AutomationPressParams = WorkspaceJsonObject & {
  /** The pressing window's id for the press. Send the same id again after a lost reply. */
  pressId: string;
  /** The Collection automation the button runs: "collection:<path>#<id>". */
  automationId: string;
  recordId: string;
  /**
   * The person who pressed. The run acts for them, so the caller must take
   * it from its own checked identity, never from a renderer.
   */
  pressedBy: string;
  nowMs?: number;
};

/** Mirrors AutomationClaimScheduleParams in crates/dohc-workspace-engine. */
export type AutomationClaimScheduleParams = WorkspaceJsonObject & {
  /** The Collection automation the schedule runs: "collection:<path>#<id>". */
  automationId: string;
  /** The scheduler's hash of the schedule. A new hash starts a new mark. */
  scheduleHash: string;
  /** Due times to run, each after the stored mark and at or before throughMs; at most 100. */
  run: number[];
  /** The mark's new position. A due time after the stored mark that is not in run is skipped. */
  throughMs: number;
  nowMs?: number;
};

/** A claim `automations.claimNext` serves, with its change's field facts. */
export type AutomationClaim = typeof AutomationClaimSchema.Type;

/** A claim without its field facts, as settle, retry, release, and the history answer. */
export type AutomationClaimSummary = typeof AutomationClaimSummarySchema.Type;

export type AutomationSubscribeResult =
  WorkspaceMethodResultMap[typeof WORKSPACE_METHOD.automationsSubscribe];

export type AutomationUnsubscribeResult =
  WorkspaceMethodResultMap[typeof WORKSPACE_METHOD.automationsUnsubscribe];

/** Null when no pending claim remains: the drain loop's stop condition. */
export type AutomationClaimNextResult =
  WorkspaceMethodResultMap[typeof WORKSPACE_METHOD.automationsClaimNext];

export type AutomationFailuresResult =
  WorkspaceMethodResultMap[typeof WORKSPACE_METHOD.automationsFailures];

/** One automation's newest claims in every state, newest first (at most 100). */
export type AutomationListClaimsResult =
  WorkspaceMethodResultMap[typeof WORKSPACE_METHOD.automationsListClaims];

/**
 * The claim that runs a press: new, or the same person's earlier press of
 * the button on the record. `busy` is true, with no claim, while the button
 * runs on the record for someone else.
 */
export type AutomationPressResult =
  WorkspaceMethodResultMap[typeof WORKSPACE_METHOD.automationsPress];

/**
 * The claims a schedule step inserted and the mark after it. A step with no
 * due times and a mark behind the stored one changes nothing and answers
 * the stored mark.
 */
export type AutomationClaimScheduleResult =
  WorkspaceMethodResultMap[typeof WORKSPACE_METHOD.automationsClaimSchedule];

export type AutomationScheduleMarksResult =
  WorkspaceMethodResultMap[typeof WORKSPACE_METHOD.automationsScheduleMarks];

type CaptureSetAuthorParams = WorkspaceJsonObject & {
  author:
    | (WorkspaceJsonObject & {
        kind: "agent";
        agentId: string;
        onBehalfOf: string;
        agentRunId?: string;
      })
    | null;
};

export type WorkspaceMethodParamsMap = {
  [WORKSPACE_METHOD.open]: WorkspaceOpenParams;
  [WORKSPACE_METHOD.close]: WorkspaceEmptyParams;
  [WORKSPACE_METHOD.conflictsList]: ConflictListParams;
  [WORKSPACE_METHOD.conflictsOpen]: ConflictOpenParams;
  [WORKSPACE_METHOD.conflictsResolve]: ConflictResolveParams;
  [WORKSPACE_METHOD.collectionsList]: CollectionListParams;
  [WORKSPACE_METHOD.collectionsListPendingAdoptions]: CollectionPendingAdoptionsParams;
  [WORKSPACE_METHOD.collectionsGet]: CollectionGetParams;
  [WORKSPACE_METHOD.collectionsQuery]: CollectionQueryParams;
  [WORKSPACE_METHOD.collectionsGetRecord]: CollectionGetRecordParams;
  [WORKSPACE_METHOD.searchQueryPage]: SearchQueryPageParams;
  [WORKSPACE_METHOD.searchQueryChatMessagesGranular]: SearchQueryChatMessagesGranularParams;
  [WORKSPACE_METHOD.watcherStatus]: WorkspaceEmptyParams;
  [WORKSPACE_METHOD.captureFlush]: WorkspaceEmptyParams;
  [WORKSPACE_METHOD.captureReconcile]: WorkspaceEmptyParams;
  [WORKSPACE_METHOD.captureSetAuthor]: CaptureSetAuthorParams;
  [WORKSPACE_METHOD.automationsSubscribe]: AutomationSubscribeParams;
  [WORKSPACE_METHOD.automationsUnsubscribe]: AutomationUnsubscribeParams;
  [WORKSPACE_METHOD.automationsClaimNext]: AutomationClaimNextParams;
  [WORKSPACE_METHOD.automationsFailures]: WorkspaceEmptyParams;
  [WORKSPACE_METHOD.automationsListClaims]: AutomationListClaimsParams;
  [WORKSPACE_METHOD.automationsSettle]: AutomationSettleParams;
  [WORKSPACE_METHOD.automationsRetry]: AutomationRetryParams;
  [WORKSPACE_METHOD.automationsRelease]: AutomationReleaseParams;
  [WORKSPACE_METHOD.automationsPress]: AutomationPressParams;
  [WORKSPACE_METHOD.automationsClaimSchedule]: AutomationClaimScheduleParams;
  [WORKSPACE_METHOD.automationsScheduleMarks]: WorkspaceEmptyParams;
  [WORKSPACE_METHOD.syncRemoteChanges]: WorkspaceEmptyParams;
};

type CollectionMethodResultMap = {
  [WORKSPACE_METHOD.collectionsList]: CollectionListPage;
  [WORKSPACE_METHOD.collectionsListPendingAdoptions]: CollectionPendingAdoptionsPage;
  [WORKSPACE_METHOD.collectionsGet]: CollectionGetResult;
  [WORKSPACE_METHOD.collectionsQuery]: CollectionQueryResult;
  [WORKSPACE_METHOD.collectionsGetRecord]: CollectionGetRecordResult;
};

export type WorkspaceMethodResultMap = {
  [M in WorkspaceMethod]: M extends keyof CollectionMethodResultMap
    ? CollectionMethodResultMap[M]
    : (typeof WorkspaceResultSchemas)[M]["Type"];
};

const COLLECTION_INTEGER_MARKER = "$dohcInt64";
const COLLECTION_FLOAT_MARKER = "$dohcFloat64";
const MAX_SAFE_COLLECTION_INTEGER = BigInt(Number.MAX_SAFE_INTEGER);
const MIN_COLLECTION_INTEGER = -(1n << 63n);
const MAX_COLLECTION_INTEGER = (1n << 64n) - 1n;

function isCollectionMarkerSpelling(key: string): boolean {
  return /^\$+dohc(?:Int64|Float64)$/.test(key);
}

function unescapeCollectionMarkerKey(key: string): string | null {
  return key.startsWith("$$") && isCollectionMarkerSpelling(key)
    ? key.slice(1)
    : null;
}

function collectionWireObject(
  value: JsonValue | undefined,
): WorkspaceJsonObject | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value
    : null;
}

function singleCollectionWireEntry(
  value: JsonValue,
): [string, JsonValue | undefined] | null {
  const object = collectionWireObject(value);
  if (object === null) return null;
  const entries = Object.entries(object);
  return entries.length === 1 ? entries[0]! : null;
}

function collectionIntegerMarker(value: JsonValue): bigint | null {
  const entry = singleCollectionWireEntry(value);
  if (entry?.[0] !== COLLECTION_INTEGER_MARKER) {
    return null;
  }
  const decimal = entry[1];
  if (typeof decimal !== "string" || !/^-?(?:0|[1-9]\d*)$/.test(decimal)) {
    throw new ProtocolShapeError(
      "A collection integer marker must contain a canonical decimal string.",
    );
  }
  const integer = BigInt(decimal);
  if (integer < MIN_COLLECTION_INTEGER || integer > MAX_COLLECTION_INTEGER) {
    throw new ProtocolShapeError(
      "A collection integer marker must fit in the engine's 64-bit integer range.",
    );
  }
  if (
    integer >= -MAX_SAFE_COLLECTION_INTEGER &&
    integer <= MAX_SAFE_COLLECTION_INTEGER
  ) {
    throw new ProtocolShapeError(
      "A collection integer marker must contain an out-of-safe-range engine integer.",
    );
  }
  return integer;
}

function collectionFloatMarker(value: JsonValue): number | null {
  const entry = singleCollectionWireEntry(value);
  if (entry?.[0] !== COLLECTION_FLOAT_MARKER) {
    return null;
  }
  const decimal = entry[1];
  if (typeof decimal !== "string" || !/^-?(?:0|[1-9]\d*)$/.test(decimal)) {
    throw new ProtocolShapeError(
      "A collection float marker must contain a canonical decimal string.",
    );
  }
  const number = Number(decimal);
  if (
    !Number.isFinite(number) ||
    !Number.isInteger(number) ||
    Number.isSafeInteger(number) ||
    BigInt(number).toString() !== decimal
  ) {
    throw new ProtocolShapeError(
      "A collection float marker must contain an out-of-safe-range integral float.",
    );
  }
  return number;
}

export function decodeCollectionValue(value: JsonValue): CollectionValue {
  const entry = singleCollectionWireEntry(value);
  const unescapedKey =
    entry === null ? null : unescapeCollectionMarkerKey(entry[0]);
  if (entry !== null && unescapedKey !== null) {
    return { [unescapedKey]: decodeCollectionValue(entry[1]!) };
  }
  const integer = collectionIntegerMarker(value);
  if (integer !== null) return integer;
  const float = collectionFloatMarker(value);
  if (float !== null) return float;
  if (Array.isArray(value)) return value.map(decodeCollectionValue);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [
        key,
        decodeCollectionValue(child!),
      ]),
    );
  }
  return value;
}

export function encodeCollectionValue(value: CollectionValue): JsonValue {
  if (
    typeof value === "number" &&
    Number.isFinite(value) &&
    Number.isInteger(value) &&
    !Number.isSafeInteger(value)
  ) {
    return { [COLLECTION_FLOAT_MARKER]: BigInt(value).toString() };
  }
  if (typeof value === "bigint") {
    if (value < MIN_COLLECTION_INTEGER || value > MAX_COLLECTION_INTEGER) {
      throw new ProtocolShapeError(
        "A collection integer must fit in the engine's 64-bit integer range.",
      );
    }
    if (
      value >= -MAX_SAFE_COLLECTION_INTEGER &&
      value <= MAX_SAFE_COLLECTION_INTEGER
    ) {
      return Number(value);
    }
    return { [COLLECTION_INTEGER_MARKER]: value.toString() };
  }
  if (Array.isArray(value)) return value.map(encodeCollectionValue);
  if (value !== null && typeof value === "object") {
    const encoded = Object.fromEntries(
      Object.entries(value).map(([key, child]) => [
        key,
        encodeCollectionValue(child),
      ]),
    );
    const entry = Object.entries(encoded);
    const key = entry.length === 1 ? entry[0]?.[0] : undefined;
    return key !== undefined && isCollectionMarkerSpelling(key)
      ? { [`$${key}`]: entry[0]![1] }
      : encoded;
  }
  return value;
}

export function encodeCollectionQueryParams(
  input: CollectionQueryParams,
): JsonValue {
  return {
    ...input,
    ...(input.filter !== undefined
      ? {
          filter: {
            ...input.filter,
            value: encodeCollectionValue(input.filter.value),
          },
        }
      : {}),
    ...(input.cursor !== undefined
      ? {
          cursor: {
            ...input.cursor,
            sortValues: input.cursor.sortValues.map((value) => ({
              ...value,
              value: encodeCollectionValue(value.value),
            })),
          },
        }
      : {}),
  } as unknown as JsonValue;
}

export type CollectionBlobResult = WorkspaceJsonObject & {
  collectionJson: null;
  blobSha256: string;
  byteLength: number;
  inbandLimitBytes: number;
};

export function collectionResultExpectsBlob(value: JsonValue): boolean {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    value.collectionJson === null
  );
}

const NullableString = Schema.NullOr(Schema.String);
const NullableInt = Schema.NullOr(Schema.Int);
const JsonObjectSchema = Schema.Record(
  Schema.String,
  Schema.mutableKey(Schema.Unknown),
);
const OptionalIntFromNullable = Schema.optional(Schema.NullOr(Schema.Int)).pipe(
  Schema.decodeTo(Schema.optionalKey(Schema.Int), {
    decode: SchemaGetter.transformOptional(
      Option.filter((value): value is number => value != null),
    ),
    encode: SchemaGetter.passthrough(),
  }),
);

const ConflictSnapshotSchema = mutableStruct({
  workspaceId: Schema.String,
  versionId: Schema.String,
  objectId: Schema.String,
  path: Schema.String,
  /**
   * `null` when the daemon withheld the body, beside the `inbandLimitBytes`
   * that says so. `conflicts.resolve` withholds every over-cap side to keep
   * its answer in one control frame; `conflicts.list` withholds the sides of
   * a row past the conflict row frame cap. Either way `blobSha256` names the
   * body, and the adapter hydrates it through `versionedText.readBlob`.
   */
  text: Schema.NullOr(Schema.String),
  inbandLimitBytes: OptionalIntFromNullable,
  contentKind: Schema.Literal("text"),
  sha256: Schema.String,
  byteLength: Schema.Int,
  blobSha256: Schema.String,
  updatedAtMs: Schema.Int,
  latestMomentId: Schema.String,
  metadataOrigin: Schema.String,
  metadataSummary: NullableString,
  metadataCorrelationId: NullableString,
});

const ConflictFileStateSchema = mutableStruct({
  path: Schema.String,
  contentKind: Schema.Literals(["text", "binary"]),
  snapshot: Schema.NullOr(ConflictSnapshotSchema),
  binarySha256: NullableString,
  binaryByteLength: NullableInt,
  binaryObjectId: NullableString,
  binaryLatestMomentId: NullableString,
  metadataSummary: NullableString,
  metadataCorrelationId: NullableString,
});

const ConflictRecordSchema = mutableStruct({
  id: Schema.String,
  workspaceId: Schema.String,
  path: Schema.String,
  targetVersionId: Schema.String,
  sourceVersionId: Schema.String,
  createdAtMs: Schema.Int,
  updatedAtMs: Schema.Int,
  status: Schema.Literals(["open", "resolved"]),
  chosenFrom: Schema.Literals(["current", "incoming", "merged"]),
  resolution: Schema.NullOr(
    Schema.Literals(["kept-current", "applied-incoming", "applied-merged"]),
  ),
  metadata: mutableStruct({
    origin: Schema.String,
    summary: NullableString,
    correlationId: NullableString,
  }),
  base: ConflictFileStateSchema,
  current: ConflictFileStateSchema,
  incoming: ConflictFileStateSchema,
});

const ReplicatedConflictResultSchema = Schema.Union([
  mutableStruct({
    replicated: Schema.Literal(true),
    status: Schema.Literal("applied"),
    conflictId: Schema.String,
    inserted: Schema.NullOr(Schema.Boolean),
    matched: Schema.Boolean,
  }),
  mutableStruct({
    replicated: Schema.Literal(true),
    status: Schema.Literal("skipped"),
  }),
  mutableStruct({
    replicated: Schema.Literal(true),
    status: Schema.Literal("crashed"),
    committed: Schema.Boolean,
  }),
]);

const CollectionSchemaReasonSchema = mutableStruct({
  code: Schema.Literals(COLLECTION_SCHEMA_REASON_CODES),
  path: Schema.String,
});

const CollectionFieldDefinitionSchema = Schema.Union([
  mutableStruct({
    name: Schema.String,
    type: Schema.Literals([
      "text",
      "number",
      "checkbox",
      "date",
      "person",
      "url",
    ]),
  }),
  mutableStruct({
    name: Schema.String,
    type: Schema.Literals(["select", "multi-select"]),
    options: Schema.mutable(Schema.Array(Schema.String)),
  }),
  mutableStruct({
    name: Schema.String,
    type: Schema.Literal("relation"),
    collection: Schema.String,
    many: Schema.Boolean,
  }),
]);

const CollectionSchemaSchema = mutableStruct({
  name: NullableString,
  description: NullableString,
  fields: Schema.mutable(Schema.Array(CollectionFieldDefinitionSchema)),
  views: Schema.mutable(
    Schema.Array(
      mutableStruct({
        name: Schema.String,
        kind: Schema.Literals(["table", "board", "calendar"]),
        groupBy: NullableString,
        sort: Schema.mutable(
          Schema.Array(
            mutableStruct({
              field: Schema.String,
              direction: Schema.Literals(["asc", "desc"]),
            }),
          ),
        ),
        visibleFields: Schema.NullOr(
          Schema.mutable(Schema.Array(Schema.String)),
        ),
        dateField: NullableString,
      }),
    ),
  ),
});

const CollectionSummarySchema = mutableStruct({
  path: Schema.String,
  status: Schema.Literals(["valid", "degraded"]),
  reasons: Schema.mutable(Schema.Array(CollectionSchemaReasonSchema)),
  omittedReasons: Schema.optionalKey(Schema.Int),
});

const CollectionDetailsSchema = mutableStruct({
  path: Schema.String,
  status: Schema.Literals(["valid", "degraded"]),
  reasons: Schema.mutable(Schema.Array(CollectionSchemaReasonSchema)),
  schema: CollectionSchemaSchema,
  recordCount: Schema.Int,
});

const CollectionFieldValueReasonSchema = mutableStruct({
  code: Schema.Literals(FIELD_VALUE_REASON_CODES),
  path: Schema.String,
});

const CollectionIndexedValueValidationSchema = Schema.Union([
  mutableStruct({ status: Schema.Literal("valid") }),
  mutableStruct({
    status: Schema.Literal("flagged"),
    reason: CollectionFieldValueReasonSchema,
  }),
  mutableStruct({ status: Schema.Literal("untyped") }),
]);

const CollectionRecordSchema = mutableStruct({
  id: Schema.String,
  path: Schema.String,
  conflicted: Schema.Boolean,
  values: Schema.mutable(
    Schema.Array(
      mutableStruct({
        field: Schema.String,
        value: Schema.MutableJson,
        validation: CollectionIndexedValueValidationSchema,
        resolvedRelations: Schema.mutable(
          Schema.Array(
            mutableStruct({
              recordId: Schema.String,
              label: Schema.String,
            }),
          ),
        ),
      }),
    ),
  ),
});

const CollectionListPageSchema = mutableStruct({
  collections: Schema.mutable(Schema.Array(CollectionSummarySchema)),
  nextCursor: NullableString,
});

const CollectionQueryCursorSchema = mutableStruct({
  sortValues: Schema.mutable(
    Schema.Array(
      mutableStruct({
        present: Schema.Boolean,
        value: Schema.MutableJson,
      }),
    ),
  ),
  recordPath: Schema.String,
  recordId: Schema.String,
});

const CollectionPendingAdoptionCursorSchema = mutableStruct({
  filePath: Schema.String,
  recordId: Schema.String,
});

const CollectionPendingAdoptionsPageSchema = mutableStruct({
  adoptions: Schema.mutable(
    Schema.Array(
      mutableStruct({
        versionId: Schema.String,
        recordId: Schema.String,
        collectionPath: Schema.String,
        filePath: Schema.String,
        objectId: Schema.String,
      }),
    ),
  ),
  nextCursor: Schema.NullOr(CollectionPendingAdoptionCursorSchema),
});

const CollectionBlobResultSchema = mutableStruct({
  collectionJson: Schema.Null,
  blobSha256: Schema.String,
  byteLength: Schema.Int,
  inbandLimitBytes: Schema.Int,
});

const CollectionQueryResultSchema = mutableStruct({
  collection: CollectionSummarySchema,
  records: Schema.mutable(Schema.Array(CollectionRecordSchema)),
  groups: Schema.NullOr(
    Schema.mutable(
      Schema.Array(
        mutableStruct({
          value: Schema.MutableJson,
          records: Schema.mutable(Schema.Array(CollectionRecordSchema)),
        }),
      ),
    ),
  ),
  nextCursor: Schema.NullOr(CollectionQueryCursorSchema),
});

const CollectionGetRecordResultSchema = mutableStruct({
  collection: CollectionSummarySchema,
  record: CollectionRecordSchema,
  history: Schema.mutable(
    Schema.Array(
      mutableStruct({
        historyId: Schema.Int,
        field: Schema.String,
        previous: mutableStruct({
          present: Schema.Boolean,
          value: Schema.MutableJson,
        }),
        next: mutableStruct({
          present: Schema.Boolean,
          value: Schema.MutableJson,
        }),
        authorOriginId: NullableString,
        actorKind: Schema.NullOr(
          Schema.Literals(["human", "agent", "automation"]),
        ),
        onBehalfOf: NullableString,
        depth: Schema.NullOr(Schema.Int),
        recordedAtMs: Schema.Int,
      }),
    ),
  ),
  nextBeforeHistoryId: NullableInt,
});

const SearchResultSchema = mutableStruct({
  surface: Schema.Literals(["file", "chat"]),
  path: Schema.String,
  title: Schema.String,
  line: Schema.Int,
  preview: Schema.String,
  matchStart: Schema.Int,
  matchEnd: Schema.Int,
  threadId: NullableString,
  objectId: NullableString,
});

const SearchQueryPageResultSchema = mutableStruct({
  results: Schema.mutable(Schema.Array(SearchResultSchema)),
  nextCursor: Schema.NullOr(Schema.NonEmptyString),
  versionId: Schema.NonEmptyString,
  restartRequired: Schema.Boolean,
});

const GranularChatMessageSearchResponseSchema = mutableStruct({
  results: Schema.mutable(
    Schema.Array(
      mutableStruct({
        threadId: Schema.NonEmptyString,
        messageId: Schema.NullOr(Schema.NonEmptyString),
        text: Schema.String,
      }),
    ),
  ),
  saturated: Schema.Boolean,
});

const CaptureFlushResultSchema = mutableStruct({
  settled: Schema.Boolean,
  running: Schema.Boolean,
  degraded: Schema.Boolean,
});

const automationClaimFields = {
  claimId: Schema.NonEmptyString,
  automationId: Schema.NonEmptyString,
  /**
   * The change that inserted the claim. A field change keys on its
   * replication coordinate or, on a never-synced lineage, on the
   * device-local history row id. An added or removed record keys on the
   * moment that moved its file into or out of the Collection. A message, a
   * press, and a due time key on text: "message:<message id>",
   * "press:<press id>", "schedule:<due ms>". Exactly one of the four shapes.
   */
  trigger: Schema.Union([
    mutableStruct({ originId: Schema.NonEmptyString, originSeq: Schema.Int }),
    mutableStruct({ historyId: Schema.Int }),
    mutableStruct({ momentOrder: Schema.Int }),
    mutableStruct({ key: Schema.NonEmptyString }),
  ]),
  /** The record the claim runs on; null for a message or a schedule. */
  recordId: Schema.NullOr(Schema.NonEmptyString),
  collectionPath: Schema.NonEmptyString,
  depth: Schema.Int,
  state: Schema.Literals(["pending", "running", "done", "failed"]),
  /**
   * How many times claimNext served the claim, across every run. A retried
   * claim that crashes has no requeue left and fails as reclaim-exhausted.
   */
  attempts: Schema.Int,
  /**
   * 1, plus one per automations.retry; a crash requeue keeps it. Executors
   * key each write on "<claimId>/<run>/<write ordinal>", so a requeued run
   * repeats its writes under the same keys and a retried run writes anew.
   */
  run: Schema.Int,
  createdAtMs: Schema.Int,
  updatedAtMs: Schema.Int,
  error: Schema.optionalKey(Schema.String),
};

/**
 * The change a claim runs for and who made it, named as record history
 * names them. Each author field is null when the write did not declare it.
 */
const automationChangeFields = {
  kind: Schema.Literals(["added", "changed", "removed", "message", "button", "schedule"]),
  authorOriginId: NullableString,
  actorKind: Schema.NullOr(Schema.Literals(["human", "agent", "automation"])),
  onBehalfOf: NullableString,
};

/**
 * One side of a changed field, null where the field was absent. A present
 * value travels wrapped as { value }, so a field whose value is null, or an
 * object shaped like the truncation marker, stays distinct from both. A
 * value over 8 KiB of JSON, nested deeper than 16 levels, or past the
 * claim's 64 KiB budget travels as { truncated: true, bytes } instead; the
 * whole value is in the history row the fact names.
 */
const AutomationFactValueSchema = Schema.NullOr(
  Schema.Union([
    mutableStruct({ value: Schema.MutableJson }),
    mutableStruct({ truncated: Schema.Literal(true), bytes: Schema.Int }),
  ]),
);

const AutomationClaimSummarySchema = mutableStruct({
  ...automationClaimFields,
  change: mutableStruct(automationChangeFields),
});

const automationFactFields = {
  /**
   * The fields in field-name order. A changed record lists its changed
   * fields with the history row that recorded each. An added record lists
   * its values as next, a removed record its last values as previous;
   * neither has a history row.
   */
  fields: Schema.mutable(
    Schema.Array(
      mutableStruct({
        field: Schema.String,
        historyId: NullableInt,
        previous: AutomationFactValueSchema,
        next: AutomationFactValueSchema,
      }),
    ),
  ),
  /** Changed fields whose names alone did not fit; read the history. */
  fieldsOmitted: Schema.Int,
};

/**
 * The message a message claim runs for. Mirrors claim_message in
 * crates/dohc-engine-domain: the body travels whole, or as { truncated:
 * true, bytes } past the claim's budget, to read through chats.messages.get.
 * The parent, owner name, and user id are present only when set.
 */
const AutomationClaimMessageSchema = mutableStruct({
  id: Schema.NonEmptyString,
  threadId: Schema.NonEmptyString,
  groupId: Schema.NonEmptyString,
  lane: Schema.Literals(["posts", "chat"]),
  authorKind: Schema.Literals(["human", "agent", "automation"]),
  authorDisplayName: Schema.String,
  createdAtMs: Schema.Int,
  body: Schema.Union([
    Schema.String,
    mutableStruct({ truncated: Schema.Literal(true), bytes: Schema.Int }),
  ]),
  parentMessageId: Schema.optionalKey(Schema.NonEmptyString),
  authorOwnerDisplayName: Schema.optionalKey(Schema.String),
  authorUserId: Schema.optionalKey(Schema.NonEmptyString),
});

const AutomationClaimSchema = mutableStruct({
  ...automationClaimFields,
  change: Schema.Union([
    mutableStruct({
      ...automationChangeFields,
      kind: Schema.Literals(["added", "changed", "removed", "button", "schedule"]),
      ...automationFactFields,
    }),
    // A message claim always carries its message.
    mutableStruct({
      ...automationChangeFields,
      kind: Schema.Literal("message"),
      ...automationFactFields,
      message: AutomationClaimMessageSchema,
    }),
  ]),
});

const AutomationScheduleMarkSchema = mutableStruct({
  automationId: Schema.NonEmptyString,
  scheduleHash: Schema.NonEmptyString,
  /** Every due time at or before this was claimed or skipped. */
  throughMs: Schema.Int,
});

const WorkspaceResultSchemas = {
  [WORKSPACE_METHOD.open]: mutableStruct({ workspace: Schema.String }),
  [WORKSPACE_METHOD.close]: mutableStruct({ closed: Schema.Boolean }),
  [WORKSPACE_METHOD.conflictsList]: mutableStruct({
    conflicts: Schema.mutable(Schema.Array(ConflictRecordSchema)),
    nextAfterConflictId: NullableString,
  }),
  [WORKSPACE_METHOD.conflictsOpen]: Schema.Union([
    mutableStruct({ inserted: Schema.Boolean }),
    ReplicatedConflictResultSchema,
  ]),
  [WORKSPACE_METHOD.conflictsResolve]: Schema.Union([
    mutableStruct({
      conflict: ConflictRecordSchema,
      write: Schema.NullOr(JsonObjectSchema),
      delete: Schema.NullOr(JsonObjectSchema),
    }),
    ReplicatedConflictResultSchema,
  ]),
  [WORKSPACE_METHOD.collectionsList]: CollectionListPageSchema,
  [WORKSPACE_METHOD.collectionsListPendingAdoptions]:
    CollectionPendingAdoptionsPageSchema,
  [WORKSPACE_METHOD.collectionsGet]: CollectionDetailsSchema,
  [WORKSPACE_METHOD.collectionsQuery]: CollectionQueryResultSchema,
  [WORKSPACE_METHOD.collectionsGetRecord]: CollectionGetRecordResultSchema,
  [WORKSPACE_METHOD.searchQueryPage]: SearchQueryPageResultSchema,
  [WORKSPACE_METHOD.searchQueryChatMessagesGranular]:
    GranularChatMessageSearchResponseSchema,
  [WORKSPACE_METHOD.watcherStatus]: mutableStruct({
    running: Schema.Boolean,
    degraded: Schema.Boolean,
    terminal: Schema.Boolean,
    phase: Schema.Union([
      Schema.Literal("starting"),
      Schema.Literal("importing"),
      Schema.Literal("ready"),
      Schema.Literal("degraded"),
    ]),
  }),
  [WORKSPACE_METHOD.captureFlush]: CaptureFlushResultSchema,
  [WORKSPACE_METHOD.captureReconcile]: CaptureFlushResultSchema,
  [WORKSPACE_METHOD.captureSetAuthor]: mutableStruct({
    updated: Schema.Literal(true),
  }),
  /** True when the call inserted the pair or replaced its filter. */
  [WORKSPACE_METHOD.automationsSubscribe]: mutableStruct({
    subscribed: Schema.Boolean,
  }),
  [WORKSPACE_METHOD.automationsUnsubscribe]: mutableStruct({
    unsubscribed: Schema.Boolean,
  }),
  [WORKSPACE_METHOD.automationsClaimNext]: Schema.NullOr(AutomationClaimSchema),
  /**
   * One automation with at least one failed claim. Mirrors AutomationFailure
   * in crates/dohc-workspace-engine: the newest failed claim, its error and
   * time, plus a generation — every failure of the automation's claims,
   * counted even across a retry, so it only grows and an acknowledgment at
   * generation N hides the owner's notice exactly until a newer failure
   * passes N.
   */
  [WORKSPACE_METHOD.automationsFailures]: mutableStruct({
    failures: Schema.mutable(
      Schema.Array(
        mutableStruct({
          automationId: Schema.NonEmptyString,
          claimId: Schema.NonEmptyString,
          /** The newest failed claim is a chain stop, which no retry runs. */
          chainStopped: Schema.Boolean,
          error: Schema.String,
          updatedAtMs: Schema.Int,
          generation: Schema.Int,
        }),
      ),
    ),
  }),
  [WORKSPACE_METHOD.automationsListClaims]: mutableStruct({
    claims: Schema.mutable(Schema.Array(AutomationClaimSummarySchema)),
  }),
  [WORKSPACE_METHOD.automationsSettle]: AutomationClaimSummarySchema,
  [WORKSPACE_METHOD.automationsRetry]: AutomationClaimSummarySchema,
  [WORKSPACE_METHOD.automationsRelease]: AutomationClaimSummarySchema,
  [WORKSPACE_METHOD.automationsPress]: Schema.Union([
    mutableStruct({ busy: Schema.Literal(false), claim: AutomationClaimSummarySchema }),
    mutableStruct({ busy: Schema.Literal(true), claim: Schema.Null }),
  ]),
  [WORKSPACE_METHOD.automationsClaimSchedule]: mutableStruct({
    claims: Schema.mutable(Schema.Array(AutomationClaimSummarySchema)),
    mark: AutomationScheduleMarkSchema,
  }),
  [WORKSPACE_METHOD.automationsScheduleMarks]: mutableStruct({
    marks: Schema.mutable(Schema.Array(AutomationScheduleMarkSchema)),
  }),
  /**
   * How many changes that did not originate on this computer the engine has
   * applied to the workspace. Compare it for equality only: restoring a
   * backup can lower it.
   */
  [WORKSPACE_METHOD.syncRemoteChanges]: mutableStruct({
    applied: Schema.Int,
  }),
} as const;

function decodeWorkspaceSchema<S extends Schema.ConstraintDecoder<unknown>>(
  schema: S,
  value: JsonValue,
  label: string,
  expectObject = true,
): S["Type"] {
  if (
    expectObject &&
    (value === null || typeof value !== "object" || Array.isArray(value))
  ) {
    throw new ProtocolShapeError(`${label} must be a JSON object.`);
  }
  const decoded = Schema.decodeUnknownResult(schema, {
    onExcessProperty: "error",
  })(value);
  if (Result.isFailure(decoded)) {
    throw new ProtocolShapeError(`${label}: ${decoded.failure.message}`);
  }
  return decoded.success;
}

export function decodeConflictRecord(
  value: JsonValue,
  label = "conflict",
): ConflictRecord {
  return decodeWorkspaceSchema(ConflictRecordSchema, value, label);
}

export function decodeCollectionBlobResult(
  value: JsonValue,
): CollectionBlobResult {
  return decodeWorkspaceSchema(
    CollectionBlobResultSchema,
    value,
    "blob-backed collection result",
  ) as CollectionBlobResult;
}

function decodeCollectionRecordValues(
  record: CollectionQueryResult["records"][number],
): CollectionQueryResult["records"][number] {
  return {
    ...record,
    values: record.values.map((field) => ({
      ...field,
      value: decodeCollectionValue(field.value as JsonValue),
    })),
  };
}

function decodeCollectionQueryResultValues(
  result: CollectionQueryResult,
): CollectionQueryResult {
  return {
    ...result,
    records: result.records.map(decodeCollectionRecordValues),
    groups:
      result.groups === null
        ? null
        : result.groups.map((group) => ({
            ...group,
            value: decodeCollectionValue(group.value as JsonValue),
            records: group.records.map(decodeCollectionRecordValues),
          })),
    nextCursor:
      result.nextCursor === null
        ? null
        : {
            ...result.nextCursor,
            sortValues: result.nextCursor.sortValues.map((value) => ({
              ...value,
              value: decodeCollectionValue(value.value as JsonValue),
            })),
          },
  };
}

function decodeCollectionGetRecordResultValues(
  result: CollectionGetRecordResult,
): CollectionGetRecordResult {
  return {
    ...result,
    record: decodeCollectionRecordValues(result.record),
    history: result.history.map((entry) => ({
      ...entry,
      previous: {
        ...entry.previous,
        value: decodeCollectionValue(entry.previous.value as JsonValue),
      },
      next: {
        ...entry.next,
        value: decodeCollectionValue(entry.next.value as JsonValue),
      },
    })),
  };
}

export function decodeWorkspaceResult<M extends WorkspaceMethod>(
  method: M,
  value: JsonValue,
): WorkspaceMethodResultMap[M] {
  const schema = WorkspaceResultSchemas[method];
  if (schema === undefined) {
    throw new ProtocolShapeError(`Unsupported workspace method: ${method}`);
  }
  const decoded = decodeWorkspaceSchema(
    schema,
    value,
    `${method} result`,
    // claimNext answers null when no pending claim remains.
    method !== WORKSPACE_METHOD.automationsClaimNext,
  ) as WorkspaceMethodResultMap[M];
  if (method === WORKSPACE_METHOD.collectionsQuery) {
    return decodeCollectionQueryResultValues(
      decoded as CollectionQueryResult,
    ) as WorkspaceMethodResultMap[M];
  }
  if (method === WORKSPACE_METHOD.collectionsGetRecord) {
    return decodeCollectionGetRecordResultValues(
      decoded as CollectionGetRecordResult,
    ) as WorkspaceMethodResultMap[M];
  }
  return decoded;
}
