import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as SchemaGetter from "effect/SchemaGetter";
import * as Struct from "effect/Struct";
import type { JsonValue } from "../ydoc/generated/serde_json/JsonValue";

export const WORKSPACE_METHOD = {
  open: "workspace.open",
  close: "workspace.close",
  conflictsList: "conflicts.list",
  conflictsOpen: "conflicts.open",
  conflictsResolve: "conflicts.resolve",
  searchQuery: "search.query",
  searchQueryPage: "search.queryPage",
  searchQueryChatMessagesGranular: "search.queryChatMessagesGranular",
  watcherStatus: "watcher.status",
  captureFlush: "capture.flush",
  captureSetAuthor: "capture.setAuthor",
} as const;

export type WorkspaceMethod =
  (typeof WORKSPACE_METHOD)[keyof typeof WORKSPACE_METHOD];
export type WorkspaceJsonObject = {
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
export type WorkspaceEmptyParams = WorkspaceJsonObject;
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
export type SearchQueryParams = WorkspaceJsonObject & {
  versionId: string;
  query: string;
  limit?: number;
  nowMs?: number;
};
export type SearchQueryPageParams = WorkspaceJsonObject & {
  query: string;
  limit?: number;
  cursor?: string;
  nowMs?: number;
};
export type SearchQueryChatMessagesGranularParams = WorkspaceJsonObject & {
  query: string;
  limit: number;
};

export const MAX_GRANULAR_CHAT_QUERY_CHARS = 4096;

export type WorkspaceOpenResult = WorkspaceJsonObject & {
  workspace: string;
};
export type WorkspaceCloseResult = WorkspaceJsonObject & {
  closed: boolean;
};

export type ConflictSnapshot = WorkspaceJsonObject & {
  workspaceId: string;
  versionId: string;
  objectId: string;
  path: string;
  /**
   * `null` when the daemon withheld the body, beside the `inbandLimitBytes`
   * that says so. `conflicts.resolve` withholds every over-cap side to keep
   * its answer in one control frame; `conflicts.list` withholds the sides of
   * a row past the conflict row frame cap. Either way `blobSha256` names the
   * body, and the adapter hydrates it through `versionedText.readBlob`.
   */
  text: string | null;
  inbandLimitBytes?: number;
  contentKind: "text";
  sha256: string;
  byteLength: number;
  blobSha256: string;
  updatedAtMs: number;
  latestMomentId: string;
  metadataOrigin: string;
  metadataSummary: string | null;
  metadataCorrelationId: string | null;
};

export type ConflictFileState = WorkspaceJsonObject & {
  path: string;
  contentKind: "text" | "binary";
  snapshot: ConflictSnapshot | null;
  binarySha256: string | null;
  binaryByteLength: number | null;
  binaryObjectId: string | null;
  binaryLatestMomentId: string | null;
  metadataSummary: string | null;
  metadataCorrelationId: string | null;
};

export type ConflictRecord = WorkspaceJsonObject & {
  id: string;
  workspaceId: string;
  path: string;
  targetVersionId: string;
  sourceVersionId: string;
  createdAtMs: number;
  updatedAtMs: number;
  status: "open" | "resolved";
  chosenFrom: "current" | "incoming" | "merged";
  resolution:
    | "kept-current"
    | "applied-incoming"
    | "applied-merged"
    | null;
  metadata: WorkspaceJsonObject & {
    origin: string;
    summary: string | null;
    correlationId: string | null;
  };
  base: ConflictFileState;
  current: ConflictFileState;
  incoming: ConflictFileState;
};

export type ConflictListPage = WorkspaceJsonObject & {
  conflicts: ConflictRecord[];
  nextAfterConflictId: string | null;
};

export type ReplicatedConflictResult =
  | (WorkspaceJsonObject & {
      replicated: true;
      status: "applied";
      conflictId: string;
      inserted: boolean | null;
      matched: boolean;
    })
  | (WorkspaceJsonObject & {
      replicated: true;
      status: "skipped";
    })
  | (WorkspaceJsonObject & {
      replicated: true;
      status: "crashed";
      committed: boolean;
    });

export type ConflictOpenResult =
  | (WorkspaceJsonObject & { inserted: boolean })
  | ReplicatedConflictResult;
export type ConflictResolveResult =
  | (WorkspaceJsonObject & {
      conflict: ConflictRecord;
      write: WorkspaceJsonObject | null;
      delete: WorkspaceJsonObject | null;
    })
  | ReplicatedConflictResult;

export type SearchResult = WorkspaceJsonObject & {
  surface: "file" | "chat";
  path: string;
  title: string;
  line: number;
  preview: string;
  matchStart: number;
  matchEnd: number;
  threadId: string | null;
  objectId: string | null;
};
export type SearchQueryPageResult = WorkspaceJsonObject & {
  results: SearchResult[];
  nextCursor: string | null;
  versionId: string;
  restartRequired: boolean;
};
export type GranularChatMessageSearchResult = WorkspaceJsonObject & {
  threadId: string;
  messageId: string | null;
  text: string;
};
export type GranularChatMessageSearchResponse = WorkspaceJsonObject & {
  results: GranularChatMessageSearchResult[];
  saturated: boolean;
};

export type WatcherStatusResult = WorkspaceJsonObject & {
  running: boolean;
  degraded: boolean;
  terminal: boolean;
};
export type CaptureFlushResult = WorkspaceJsonObject & {
  settled: boolean;
  running: boolean;
  degraded: boolean;
};
export type CaptureSetAuthorParams = WorkspaceJsonObject & {
  author:
    | (WorkspaceJsonObject & {
        kind: "agent";
        agentId: string;
        onBehalfOf: string;
        agentRunId?: string;
      })
    | null;
};
export type CaptureSetAuthorResult = WorkspaceJsonObject & {
  updated: true;
};

export type WorkspaceMethodParamsMap = {
  [WORKSPACE_METHOD.open]: WorkspaceOpenParams;
  [WORKSPACE_METHOD.close]: WorkspaceEmptyParams;
  [WORKSPACE_METHOD.conflictsList]: ConflictListParams;
  [WORKSPACE_METHOD.conflictsOpen]: ConflictOpenParams;
  [WORKSPACE_METHOD.conflictsResolve]: ConflictResolveParams;
  [WORKSPACE_METHOD.searchQuery]: SearchQueryParams;
  [WORKSPACE_METHOD.searchQueryPage]: SearchQueryPageParams;
  [WORKSPACE_METHOD.searchQueryChatMessagesGranular]: SearchQueryChatMessagesGranularParams;
  [WORKSPACE_METHOD.watcherStatus]: WorkspaceEmptyParams;
  [WORKSPACE_METHOD.captureFlush]: WorkspaceEmptyParams;
  [WORKSPACE_METHOD.captureSetAuthor]: CaptureSetAuthorParams;
};

export type WorkspaceMethodResultMap = {
  [WORKSPACE_METHOD.open]: WorkspaceOpenResult;
  [WORKSPACE_METHOD.close]: WorkspaceCloseResult;
  [WORKSPACE_METHOD.conflictsList]: ConflictListPage;
  [WORKSPACE_METHOD.conflictsOpen]: ConflictOpenResult;
  [WORKSPACE_METHOD.conflictsResolve]: ConflictResolveResult;
  [WORKSPACE_METHOD.searchQuery]: SearchResult[];
  [WORKSPACE_METHOD.searchQueryPage]: SearchQueryPageResult;
  [WORKSPACE_METHOD.searchQueryChatMessagesGranular]: GranularChatMessageSearchResponse;
  [WORKSPACE_METHOD.watcherStatus]: WatcherStatusResult;
  [WORKSPACE_METHOD.captureFlush]: CaptureFlushResult;
  [WORKSPACE_METHOD.captureSetAuthor]: CaptureSetAuthorResult;
};

export class WorkspaceProtocolShapeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkspaceProtocolShapeError";
  }
}

function mutableStruct<const Fields extends Schema.Struct.Fields>(fields: Fields) {
  return Schema.Struct(fields).mapFields(Struct.map(Schema.mutableKey));
}

const NullableString = Schema.NullOr(Schema.String);
const NullableInt = Schema.NullOr(Schema.Int);
const JsonObjectSchema = Schema.Record(Schema.String, Schema.Unknown);
const OptionalIntFromNullable = Schema.optional(
  Schema.NullOr(Schema.Int),
).pipe(
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
  [WORKSPACE_METHOD.searchQuery]: Schema.mutable(Schema.Array(SearchResultSchema)),
  [WORKSPACE_METHOD.searchQueryPage]: SearchQueryPageResultSchema,
  [WORKSPACE_METHOD.searchQueryChatMessagesGranular]:
    GranularChatMessageSearchResponseSchema,
  [WORKSPACE_METHOD.watcherStatus]: mutableStruct({
    running: Schema.Boolean,
    degraded: Schema.Boolean,
    terminal: Schema.Boolean,
  }),
  [WORKSPACE_METHOD.captureFlush]: mutableStruct({
    settled: Schema.Boolean,
    running: Schema.Boolean,
    degraded: Schema.Boolean,
  }),
  [WORKSPACE_METHOD.captureSetAuthor]: mutableStruct({
    updated: Schema.Literal(true),
  }),
} as const;

function decodeWorkspaceSchema<S extends Schema.ConstraintDecoder<unknown>>(
  schema: S,
  value: JsonValue,
  label: string,
): S["Type"] {
  const decoded = Schema.decodeUnknownResult(schema, {
    onExcessProperty: "error",
  })(value);
  if (Result.isFailure(decoded)) {
    if (decoded.failure.message === "Expected object") {
      throw new WorkspaceProtocolShapeError(
        `${label} must be a JSON object.`,
      );
    }
    throw new WorkspaceProtocolShapeError(`${label}: ${decoded.failure.message}`);
  }
  return decoded.success;
}

export function decodeConflictRecord(
  value: JsonValue,
  label = "conflict",
): ConflictRecord {
  return decodeWorkspaceSchema(
    ConflictRecordSchema,
    value,
    label,
  ) as ConflictRecord;
}

export function decodeSearchQueryPageResult(
  value: JsonValue,
  label = `${WORKSPACE_METHOD.searchQueryPage} result`,
): SearchQueryPageResult {
  return decodeWorkspaceSchema(
    SearchQueryPageResultSchema,
    value,
    label,
  ) as SearchQueryPageResult;
}

export function decodeGranularChatMessageSearchResponse(
  value: JsonValue,
  label = `${WORKSPACE_METHOD.searchQueryChatMessagesGranular} result`,
): GranularChatMessageSearchResponse {
  return decodeWorkspaceSchema(
    GranularChatMessageSearchResponseSchema,
    value,
    label,
  ) as GranularChatMessageSearchResponse;
}

export function decodeWorkspaceResult<M extends WorkspaceMethod>(
  method: M,
  value: JsonValue,
): WorkspaceMethodResultMap[M] {
  const schema = WorkspaceResultSchemas[method];
  if (schema === undefined) {
    throw new WorkspaceProtocolShapeError(
      `Unsupported workspace method: ${method}`,
    );
  }
  return decodeWorkspaceSchema(
    schema,
    value,
    `${method} result`,
  ) as WorkspaceMethodResultMap[M];
}
