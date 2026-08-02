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
   * `null` when the daemon withheld the body for being past the in-band cap,
   * beside the `inbandLimitBytes` that says so. `conflicts.resolve` answers
   * that way; `conflicts.list` always carries the bodies it returns.
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

export type PendingConflictResolve = WorkspaceJsonObject & {
  remoteConflictId: string;
  localConflictId: string | null;
  path: string | null;
  reason: string;
};

export type ReplicatedConflictResult =
  | (WorkspaceJsonObject & {
      replicated: true;
      status: "applied";
      conflictId: string;
      inserted: boolean | null;
      matched: boolean;
      deferred: boolean;
      pendingResolve: PendingConflictResolve | null;
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

function objectValue(
  value: JsonValue,
  label: string,
  keys: readonly string[],
): WorkspaceJsonObject {
  if (value === null || Array.isArray(value) || typeof value !== "object") {
    throw new WorkspaceProtocolShapeError(`${label} must be a JSON object.`);
  }
  for (const key of Object.keys(value)) {
    if (!keys.includes(key)) {
      throw new WorkspaceProtocolShapeError(`${label}.${key} is not allowed.`);
    }
  }
  return value;
}

function nonEmptyStringValue(
  object: WorkspaceJsonObject,
  key: string,
  label: string,
): string {
  const value = stringValue(object, key, label);
  if (value.length === 0) {
    throw new WorkspaceProtocolShapeError(
      `${label}.${key} must not be empty.`,
    );
  }
  return value;
}

function recordValue(value: JsonValue, label: string): WorkspaceJsonObject {
  if (value === null || Array.isArray(value) || typeof value !== "object") {
    throw new WorkspaceProtocolShapeError(`${label} must be a JSON object.`);
  }
  return value;
}

function stringValue(
  object: WorkspaceJsonObject,
  key: string,
  label: string,
): string {
  const value = object[key];
  if (typeof value !== "string") {
    throw new WorkspaceProtocolShapeError(`${label}.${key} must be a string.`);
  }
  return value;
}

function nullableString(
  object: WorkspaceJsonObject,
  key: string,
  label: string,
): string | null {
  const value = object[key];
  if (value !== null && typeof value !== "string") {
    throw new WorkspaceProtocolShapeError(
      `${label}.${key} must be a string or null.`,
    );
  }
  return value;
}

function booleanValue(
  object: WorkspaceJsonObject,
  key: string,
  label: string,
): boolean {
  const value = object[key];
  if (typeof value !== "boolean") {
    throw new WorkspaceProtocolShapeError(`${label}.${key} must be a boolean.`);
  }
  return value;
}

function integerValue(
  object: WorkspaceJsonObject,
  key: string,
  label: string,
): number {
  const value = object[key];
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new WorkspaceProtocolShapeError(
      `${label}.${key} must be a safe integer.`,
    );
  }
  return value;
}

function nullableInteger(
  object: WorkspaceJsonObject,
  key: string,
  label: string,
): number | null {
  const value = object[key];
  if (
    value !== null &&
    (typeof value !== "number" || !Number.isSafeInteger(value))
  ) {
    throw new WorkspaceProtocolShapeError(
      `${label}.${key} must be a safe integer or null.`,
    );
  }
  return value;
}

function enumValue<T extends string>(
  object: WorkspaceJsonObject,
  key: string,
  label: string,
  values: readonly T[],
): T {
  const value = object[key];
  if (typeof value !== "string" || !values.includes(value as T)) {
    throw new WorkspaceProtocolShapeError(`${label}.${key} is invalid.`);
  }
  return value as T;
}

/**
 * Whether THIS response may withhold a conflict body.
 *
 * Only `conflicts.resolve` withholds (`settled_conflict_json`, lib.rs), and it
 * does so to keep its answer inside one control frame. A listing carries every
 * body it returns, so a null from that surface is a protocol fault, not a
 * hydration hint — and accepting one there would hand a reader an empty
 * document that looks like an edit.
 */
type ConflictBodies = "carried" | "may-be-withheld";

function decodeSnapshot(
  value: JsonValue,
  label: string,
  bodies: ConflictBodies,
): ConflictSnapshot {
  const object = objectValue(value, label, [
    "workspaceId",
    "versionId",
    "objectId",
    "path",
    "text",
    "contentKind",
    "sha256",
    "byteLength",
    "blobSha256",
    "updatedAtMs",
    "latestMomentId",
    "metadataOrigin",
    "metadataSummary",
    "metadataCorrelationId",
    "inbandLimitBytes",
  ]);
  if (object.contentKind !== "text") {
    throw new WorkspaceProtocolShapeError(
      `${label}.contentKind must be text.`,
    );
  }
  const inbandLimitBytes =
    object.inbandLimitBytes === undefined || object.inbandLimitBytes === null
      ? undefined
      : integerValue(object, "inbandLimitBytes", label);
  return {
    workspaceId: stringValue(object, "workspaceId", label),
    versionId: stringValue(object, "versionId", label),
    objectId: stringValue(object, "objectId", label),
    path: stringValue(object, "path", label),
    text:
      object.text === null && bodies === "may-be-withheld"
        ? null
        : stringValue(object, "text", label),
    ...(inbandLimitBytes === undefined ? {} : { inbandLimitBytes }),
    contentKind: "text",
    sha256: stringValue(object, "sha256", label),
    byteLength: integerValue(object, "byteLength", label),
    blobSha256: stringValue(object, "blobSha256", label),
    updatedAtMs: integerValue(object, "updatedAtMs", label),
    latestMomentId: stringValue(object, "latestMomentId", label),
    metadataOrigin: stringValue(object, "metadataOrigin", label),
    metadataSummary: nullableString(object, "metadataSummary", label),
    metadataCorrelationId: nullableString(
      object,
      "metadataCorrelationId",
      label,
    ),
  };
}

function decodeConflictState(
  value: JsonValue,
  label: string,
  bodies: ConflictBodies,
): ConflictFileState {
  const object = objectValue(value, label, [
    "path",
    "contentKind",
    "snapshot",
    "binarySha256",
    "binaryByteLength",
    "binaryObjectId",
    "binaryLatestMomentId",
    "metadataSummary",
    "metadataCorrelationId",
  ]);
  return {
    path: stringValue(object, "path", label),
    contentKind: enumValue(object, "contentKind", label, ["text", "binary"]),
    snapshot:
      object.snapshot === null
        ? null
        : decodeSnapshot(object.snapshot ?? null, `${label}.snapshot`, bodies),
    binarySha256: nullableString(object, "binarySha256", label),
    binaryByteLength: nullableInteger(object, "binaryByteLength", label),
    binaryObjectId: nullableString(object, "binaryObjectId", label),
    binaryLatestMomentId: nullableString(
      object,
      "binaryLatestMomentId",
      label,
    ),
    metadataSummary: nullableString(object, "metadataSummary", label),
    metadataCorrelationId: nullableString(
      object,
      "metadataCorrelationId",
      label,
    ),
  };
}

export function decodeConflictRecord(
  value: JsonValue,
  label = "conflict",
  bodies: ConflictBodies = "carried",
): ConflictRecord {
  const object = objectValue(value, label, [
    "id",
    "workspaceId",
    "path",
    "targetVersionId",
    "sourceVersionId",
    "createdAtMs",
    "updatedAtMs",
    "status",
    "chosenFrom",
    "resolution",
    "metadata",
    "base",
    "current",
    "incoming",
  ]);
  const metadataLabel = `${label}.metadata`;
  const metadata = objectValue(object.metadata ?? null, metadataLabel, [
    "origin",
    "summary",
    "correlationId",
  ]);
  const resolution = object.resolution;
  if (
    resolution !== null &&
    resolution !== "kept-current" &&
    resolution !== "applied-incoming" &&
    resolution !== "applied-merged"
  ) {
    throw new WorkspaceProtocolShapeError(`${label}.resolution is invalid.`);
  }
  return {
    id: stringValue(object, "id", label),
    workspaceId: stringValue(object, "workspaceId", label),
    path: stringValue(object, "path", label),
    targetVersionId: stringValue(object, "targetVersionId", label),
    sourceVersionId: stringValue(object, "sourceVersionId", label),
    createdAtMs: integerValue(object, "createdAtMs", label),
    updatedAtMs: integerValue(object, "updatedAtMs", label),
    status: enumValue(object, "status", label, ["open", "resolved"]),
    chosenFrom: enumValue(object, "chosenFrom", label, [
      "current",
      "incoming",
      "merged",
    ]),
    resolution,
    metadata: {
      origin: stringValue(metadata, "origin", metadataLabel),
      summary: nullableString(metadata, "summary", metadataLabel),
      correlationId: nullableString(metadata, "correlationId", metadataLabel),
    },
    base: decodeConflictState(object.base ?? null, `${label}.base`, bodies),
    current: decodeConflictState(
      object.current ?? null,
      `${label}.current`,
      bodies,
    ),
    incoming: decodeConflictState(
      object.incoming ?? null,
      `${label}.incoming`,
      bodies,
    ),
  };
}

function decodePendingResolve(
  value: JsonValue,
  label: string,
): PendingConflictResolve {
  const object = objectValue(value, label, [
    "remoteConflictId",
    "localConflictId",
    "path",
    "reason",
  ]);
  return {
    remoteConflictId: stringValue(object, "remoteConflictId", label),
    localConflictId: nullableString(object, "localConflictId", label),
    path: nullableString(object, "path", label),
    reason: stringValue(object, "reason", label),
  };
}

function decodeReplicatedConflict(
  value: JsonValue,
  label: string,
): ReplicatedConflictResult {
  const base = recordValue(value, label);
  if (base.replicated !== true) {
    throw new WorkspaceProtocolShapeError(`${label}.replicated must be true.`);
  }
  if (base.status === "skipped") {
    objectValue(value, label, ["replicated", "status"]);
    return { replicated: true, status: "skipped" };
  }
  if (base.status === "crashed") {
    const object = objectValue(value, label, [
      "replicated",
      "status",
      "committed",
    ]);
    return {
      replicated: true,
      status: "crashed",
      committed: booleanValue(object, "committed", label),
    };
  }
  if (base.status !== "applied") {
    throw new WorkspaceProtocolShapeError(`${label}.status is invalid.`);
  }
  const object = objectValue(value, label, [
    "replicated",
    "status",
    "conflictId",
    "inserted",
    "matched",
    "deferred",
    "pendingResolve",
  ]);
  const inserted = object.inserted;
  if (inserted !== null && typeof inserted !== "boolean") {
    throw new WorkspaceProtocolShapeError(
      `${label}.inserted must be a boolean or null.`,
    );
  }
  return {
    replicated: true,
    status: "applied",
    conflictId: stringValue(object, "conflictId", label),
    inserted,
    matched: booleanValue(object, "matched", label),
    deferred: booleanValue(object, "deferred", label),
    pendingResolve:
      object.pendingResolve === null
        ? null
        : decodePendingResolve(
            object.pendingResolve ?? null,
            `${label}.pendingResolve`,
          ),
  };
}

function decodeSearchResult(value: JsonValue, label: string): SearchResult {
  const object = objectValue(value, label, [
    "surface",
    "path",
    "title",
    "line",
    "preview",
    "matchStart",
    "matchEnd",
    "threadId",
    "objectId",
  ]);
  return {
    surface: enumValue(object, "surface", label, ["file", "chat"]),
    path: stringValue(object, "path", label),
    title: stringValue(object, "title", label),
    line: integerValue(object, "line", label),
    preview: stringValue(object, "preview", label),
    matchStart: integerValue(object, "matchStart", label),
    matchEnd: integerValue(object, "matchEnd", label),
    threadId: nullableString(object, "threadId", label),
    objectId: nullableString(object, "objectId", label),
  };
}

export function decodeSearchQueryPageResult(
  value: JsonValue,
  label = `${WORKSPACE_METHOD.searchQueryPage} result`,
): SearchQueryPageResult {
  const object = objectValue(value, label, [
    "results",
    "nextCursor",
    "versionId",
    "restartRequired",
  ]);
  if (!Array.isArray(object.results)) {
    throw new WorkspaceProtocolShapeError(`${label}.results must be an array.`);
  }
  const nextCursor = nullableString(object, "nextCursor", label);
  if (nextCursor === "") {
    throw new WorkspaceProtocolShapeError(`${label}.nextCursor must not be empty.`);
  }
  return {
    results: object.results.map((entry, index) =>
      decodeSearchResult(entry, `${label}.results[${index}]`),
    ),
    nextCursor,
    versionId: nonEmptyStringValue(object, "versionId", label),
    restartRequired: booleanValue(object, "restartRequired", label),
  };
}

function decodeGranularChatMessageSearchResults(
  value: JsonValue,
  label: string,
): GranularChatMessageSearchResult[] {
  if (!Array.isArray(value)) {
    throw new WorkspaceProtocolShapeError(`${label} must be an array.`);
  }
  return value.map((entry, index) => {
    const entryLabel = `${label}[${index}]`;
    const object = objectValue(entry, entryLabel, [
      "threadId",
      "messageId",
      "text",
    ]);
    const messageId = nullableString(object, "messageId", entryLabel);
    if (messageId === "") {
      throw new WorkspaceProtocolShapeError(
        `${entryLabel}.messageId must not be empty.`,
      );
    }
    return {
      threadId: nonEmptyStringValue(object, "threadId", entryLabel),
      messageId,
      text: stringValue(object, "text", entryLabel),
    };
  });
}

export function decodeGranularChatMessageSearchResponse(
  value: JsonValue,
  label = `${WORKSPACE_METHOD.searchQueryChatMessagesGranular} result`,
): GranularChatMessageSearchResponse {
  const object = objectValue(value, label, ["results", "saturated"]);
  return {
    results: decodeGranularChatMessageSearchResults(
      object.results ?? null,
      `${label}.results`,
    ),
    saturated: booleanValue(object, "saturated", label),
  };
}

export function decodeWorkspaceResult<M extends WorkspaceMethod>(
  method: M,
  value: JsonValue,
): WorkspaceMethodResultMap[M] {
  const label = `${method} result`;
  let result: unknown;
  switch (method) {
    case WORKSPACE_METHOD.open: {
      const object = objectValue(value, label, ["workspace"]);
      result = { workspace: stringValue(object, "workspace", label) };
      break;
    }
    case WORKSPACE_METHOD.close: {
      const object = objectValue(value, label, ["closed"]);
      result = { closed: booleanValue(object, "closed", label) };
      break;
    }
    case WORKSPACE_METHOD.conflictsList: {
      const object = objectValue(value, label, [
        "conflicts",
        "nextAfterConflictId",
      ]);
      if (!Array.isArray(object.conflicts)) {
        throw new WorkspaceProtocolShapeError(
          `${label}.conflicts must be an array.`,
        );
      }
      result = {
        conflicts: object.conflicts.map((entry, index) =>
          decodeConflictRecord(entry, `${label}.conflicts[${index}]`),
        ),
        nextAfterConflictId: nullableString(
          object,
          "nextAfterConflictId",
          label,
        ),
      };
      break;
    }
    case WORKSPACE_METHOD.conflictsOpen: {
      const object = recordValue(value, label);
      if (object.replicated === true) {
        result = decodeReplicatedConflict(value, label);
      } else {
        const local = objectValue(value, label, ["inserted"]);
        result = { inserted: booleanValue(local, "inserted", label) };
      }
      break;
    }
    case WORKSPACE_METHOD.conflictsResolve: {
      const object = recordValue(value, label);
      if (object.replicated === true) {
        result = decodeReplicatedConflict(value, label);
      } else {
        const local = objectValue(value, label, ["conflict", "write", "delete"]);
        result = {
          conflict: decodeConflictRecord(
            local.conflict ?? null,
            `${label}.conflict`,
            "may-be-withheld",
          ),
          write:
            local.write === null
              ? null
              : recordValue(local.write ?? null, `${label}.write`),
          delete:
            local.delete === null
              ? null
              : recordValue(local.delete ?? null, `${label}.delete`),
        };
      }
      break;
    }
    case WORKSPACE_METHOD.searchQuery:
      if (!Array.isArray(value)) {
        throw new WorkspaceProtocolShapeError(`${label} must be an array.`);
      }
      result = value.map((entry, index) =>
        decodeSearchResult(entry, `${label}[${index}]`),
      );
      break;
    case WORKSPACE_METHOD.searchQueryPage:
      result = decodeSearchQueryPageResult(value, label);
      break;
    case WORKSPACE_METHOD.searchQueryChatMessagesGranular:
      result = decodeGranularChatMessageSearchResponse(value, label);
      break;
    case WORKSPACE_METHOD.watcherStatus: {
      const object = objectValue(value, label, [
        "running",
        "degraded",
        "terminal",
      ]);
      result = {
        running: booleanValue(object, "running", label),
        degraded: booleanValue(object, "degraded", label),
        terminal: booleanValue(object, "terminal", label),
      };
      break;
    }
    case WORKSPACE_METHOD.captureFlush: {
      const object = objectValue(value, label, [
        "settled",
        "running",
        "degraded",
      ]);
      result = {
        settled: booleanValue(object, "settled", label),
        running: booleanValue(object, "running", label),
        degraded: booleanValue(object, "degraded", label),
      };
      break;
    }
    case WORKSPACE_METHOD.captureSetAuthor: {
      const object = objectValue(value, label, ["updated"]);
      if (object.updated !== true) {
        throw new WorkspaceProtocolShapeError(
          `${label}.updated must be true.`,
        );
      }
      result = { updated: true };
      break;
    }
    default: {
      const exhaustive: never = method;
      throw new WorkspaceProtocolShapeError(
        `Unsupported workspace method: ${exhaustive}`,
      );
    }
  }
  return result as WorkspaceMethodResultMap[M];
}
