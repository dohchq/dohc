import type { JsonValue } from "./generated/serde_json/JsonValue";

export const YDOC_METHOD = {
  open: "ydoc.open",
  recordUpdate: "ydoc.recordUpdate",
  settle: "ydoc.settle",
  applyExternalMarkdownEdit: "ydoc.applyExternalMarkdownEdit",
  close: "ydoc.close",
  // Ends a session without settling and without pruning: the daemon drops the
  // session and its lease and leaves the durable lineage alone. The only exit
  // for a session that may not write its artifact and may not discard its
  // CRDT — see `EngineYdocProviderSession.evict` (#665).
  evict: "ydoc.evict",
  // R13 OBLIGATION (resync): implement this transport after a stale signal.
  // R13 OBLIGATION (schema): add Rust serde counterparts for all ydoc.* shapes.
  resync: "ydoc.resync",
} as const;

export const YDOC_EVENT = {
  remoteUpdate: "ydoc.remoteUpdate",
} as const;

export type YdocContentKind = "richdoc" | "plaintext";
export type JsonObject = { [key: string]: JsonValue | undefined };

export type YdocOpenParams = JsonObject & {
  versionId: string;
  path: string;
  contentKind?: YdocContentKind;
};

export type YdocOpenResult = JsonObject & {
  sessionId: string;
  objectId: string;
  path: string;
  contentKind: YdocContentKind;
  initialUpdateBase64: string;
  // Whether the ENTERED VERSION has a committed snapshot for this path.
  // "absent" means the version does not contain the path. See
  // EngineYdocProviderSession.head.
  head: "present" | "absent";
  // Whether the daemon resumed durable CRDT state for this object. These two
  // are INDEPENDENT and both are read: an ordinary first open of a captured
  // file is lineage-absent and head-present, and a crash-orphaned draft the
  // daemon resurrects is lineage-existing and head-absent. Only both absent
  // means the session is bound to an EMPTY doc over nothing.
  lineage: "existing" | "absent";
  // Present only when the engine opened a captured artifact without durable
  // CRDT lineage. The client records this content as the lineage's first update.
  seedContent?: string;
};

export type YdocRecordUpdateParams = JsonObject & {
  sessionId: string;
  updateBase64: string;
  actorOriginId?: string;
};

export type YdocRecordUpdateResult = JsonObject & {
  seq: number;
};

export type YdocSettleParams = JsonObject & {
  sessionId: string;
  summary?: string;
};

export type YdocProjectionProvenance = JsonObject & {
  contentKind: YdocContentKind;
  sourceStateVectorSha256: string;
  destructive: boolean;
};

export type YdocSettleResult = JsonObject & {
  momentId: string;
  path: string;
  // null once the settled body is past the engine's in-band response cap. The
  // settle still committed and the engine wrote the file — read it from disk
  // rather than echoing it back over the wire.
  content: string | null;
  sha256: string;
  // false => the settle committed but the FILE did not move (materialization
  // blocked by containment; the write is pending a retry). Nothing may report
  // the document as saved on a false.
  materialized: boolean;
  projection: YdocProjectionProvenance;
};

export type YdocApplyExternalMarkdownEditParams = JsonObject & {
  sessionId: string;
  markdown: string;
};

export type YdocApplyExternalMarkdownEditResult =
  | (JsonObject & { kind: "merged"; markdown: string })
  | (JsonObject & { kind: "conflict"; conflictPath: string });

export type YdocCloseParams = JsonObject & {
  sessionId: string;
  settle?: boolean;
  summary?: string;
};

export type YdocCloseResult = JsonObject & {
  closed: true;
};

export type YdocEvictParams = JsonObject & {
  sessionId: string;
};

export type YdocEvictResult = JsonObject & {
  evicted: true;
};

export type YdocRemoteUpdatePayload = JsonObject & {
  sessionId: string;
  updateBase64: string;
};

export class YdocProtocolShapeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "YdocProtocolShapeError";
  }
}

function objectValue(value: JsonValue, label: string): JsonObject {
  if (value === null || Array.isArray(value) || typeof value !== "object") {
    throw new YdocProtocolShapeError(`${label} must be a JSON object.`);
  }
  return value;
}

function stringValue(object: JsonObject, key: string, label: string): string {
  const value = object[key];
  if (typeof value !== "string") {
    throw new YdocProtocolShapeError(`${label}.${key} must be a string.`);
  }
  return value;
}

// A field the engine answers with the value OR with an explicit null (never
// absent, never an empty-string stand-in): null MEANS something, so an absent
// key is still a protocol violation.
function nullableStringValue(
  object: JsonObject,
  key: string,
  label: string,
): string | null {
  const value = object[key];
  if (value === null) return null;
  if (typeof value !== "string") {
    throw new YdocProtocolShapeError(
      `${label}.${key} must be a string or null.`,
    );
  }
  return value;
}

function booleanValue(object: JsonObject, key: string, label: string): boolean {
  const value = object[key];
  if (typeof value !== "boolean") {
    throw new YdocProtocolShapeError(`${label}.${key} must be a boolean.`);
  }
  return value;
}

function numberValue(object: JsonObject, key: string, label: string): number {
  const value = object[key];
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new YdocProtocolShapeError(`${label}.${key} must be a safe integer.`);
  }
  return value;
}

function contentKindValue(
  object: JsonObject,
  key: string,
  label: string,
): YdocContentKind {
  const value = object[key];
  if (value !== "richdoc" && value !== "plaintext") {
    throw new YdocProtocolShapeError(
      `${label}.${key} must be richdoc or plaintext.`,
    );
  }
  return value;
}

export function decodeYdocOpenResult(value: JsonValue): YdocOpenResult {
  const object = objectValue(value, "ydoc.open result");
  return {
    sessionId: stringValue(object, "sessionId", "ydoc.open result"),
    objectId: stringValue(object, "objectId", "ydoc.open result"),
    path: stringValue(object, "path", "ydoc.open result"),
    contentKind: contentKindValue(object, "contentKind", "ydoc.open result"),
    initialUpdateBase64: stringValue(
      object,
      "initialUpdateBase64",
      "ydoc.open result",
    ),
    head: headValue(object, "head", "ydoc.open result"),
    lineage: lineageValue(object, "lineage", "ydoc.open result"),
    ...(object.seedContent === undefined
      ? {}
      : {
          seedContent: stringValue(
            object,
            "seedContent",
            "ydoc.open result",
          ),
        }),
  };
}

// Both fields gate a REFUSAL, so neither may be inferred. A decoder that
// defaulted a missing or garbled value to the permissive side would silently
// turn the refusal off — the same hole the field exists to close.
function headValue(
  object: JsonObject,
  key: string,
  label: string,
): "present" | "absent" {
  const value = object[key];
  if (value !== "present" && value !== "absent") {
    throw new YdocProtocolShapeError(
      `${label}.${key} must be present or absent.`,
    );
  }
  return value;
}

function lineageValue(
  object: JsonObject,
  key: string,
  label: string,
): "existing" | "absent" {
  const value = object[key];
  if (value !== "existing" && value !== "absent") {
    throw new YdocProtocolShapeError(
      `${label}.${key} must be existing or absent.`,
    );
  }
  return value;
}

export function decodeYdocRecordUpdateResult(
  value: JsonValue,
): YdocRecordUpdateResult {
  const object = objectValue(value, "ydoc.recordUpdate result");
  return { seq: numberValue(object, "seq", "ydoc.recordUpdate result") };
}

export function decodeYdocSettleResult(value: JsonValue): YdocSettleResult {
  const object = objectValue(value, "ydoc.settle result");
  const projection = objectValue(
    object.projection ?? null,
    "ydoc.settle result.projection",
  );
  const destructive = projection.destructive;
  if (typeof destructive !== "boolean") {
    throw new YdocProtocolShapeError(
      "ydoc.settle result.projection.destructive must be a boolean.",
    );
  }
  return {
    momentId: stringValue(object, "momentId", "ydoc.settle result"),
    path: stringValue(object, "path", "ydoc.settle result"),
    content: nullableStringValue(object, "content", "ydoc.settle result"),
    sha256: stringValue(object, "sha256", "ydoc.settle result"),
    materialized: booleanValue(object, "materialized", "ydoc.settle result"),
    projection: {
      contentKind: contentKindValue(
        projection,
        "contentKind",
        "ydoc.settle result.projection",
      ),
      sourceStateVectorSha256: stringValue(
        projection,
        "sourceStateVectorSha256",
        "ydoc.settle result.projection",
      ),
      destructive,
    },
  };
}

export function decodeYdocExternalEditResult(
  value: JsonValue,
): YdocApplyExternalMarkdownEditResult {
  const object = objectValue(value, "ydoc.applyExternalMarkdownEdit result");
  if (object.kind === "merged") {
    return {
      kind: "merged",
      markdown: stringValue(
        object,
        "markdown",
        "ydoc.applyExternalMarkdownEdit result",
      ),
    };
  }
  if (object.kind === "conflict") {
    return {
      kind: "conflict",
      conflictPath: stringValue(
        object,
        "conflictPath",
        "ydoc.applyExternalMarkdownEdit result",
      ),
    };
  }
  throw new YdocProtocolShapeError(
    "ydoc.applyExternalMarkdownEdit result.kind is invalid.",
  );
}

export function decodeYdocCloseResult(value: JsonValue): YdocCloseResult {
  const object = objectValue(value, "ydoc.close result");
  if (object.closed !== true) {
    throw new YdocProtocolShapeError("ydoc.close result.closed must be true.");
  }
  return { closed: true };
}

export function decodeYdocEvictResult(value: JsonValue): YdocEvictResult {
  const object = objectValue(value, "ydoc.evict result");
  if (object.evicted !== true) {
    throw new YdocProtocolShapeError("ydoc.evict result.evicted must be true.");
  }
  return { evicted: true };
}

export function decodeYdocRemoteUpdatePayload(
  value: JsonValue,
): YdocRemoteUpdatePayload {
  const object = objectValue(value, "ydoc.remoteUpdate payload");
  return {
    sessionId: stringValue(object, "sessionId", "ydoc.remoteUpdate payload"),
    updateBase64: stringValue(
      object,
      "updateBase64",
      "ydoc.remoteUpdate payload",
    ),
  };
}
