import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as SchemaIssue from "effect/SchemaIssue";
import * as Struct from "effect/Struct";
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
  markdown: string | null;
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

function mutableStruct<const Fields extends Schema.Struct.Fields>(fields: Fields) {
  return Schema.Struct(fields).mapFields(Struct.map(Schema.mutableKey));
}

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
    throw new YdocProtocolShapeError(
      `${label}${path}: ${issue?.message ?? decoded.failure.message}`,
    );
  }
  return decoded.success;
}

const YdocContentKindSchema = Schema.Literals(["richdoc", "plaintext"]);
const OpenResultSchema = mutableStruct({
  sessionId: Schema.String,
  objectId: Schema.String,
  path: Schema.String,
  contentKind: YdocContentKindSchema,
  initialUpdateBase64: Schema.String,
  head: Schema.Literals(["present", "absent"]),
  lineage: Schema.Literals(["existing", "absent"]),
});
const RecordUpdateResultSchema = mutableStruct({ seq: Schema.Int });
const ProjectionProvenanceSchema = mutableStruct({
  contentKind: YdocContentKindSchema,
  sourceStateVectorSha256: Schema.String,
  destructive: Schema.Boolean,
});
const SettleResultSchema = mutableStruct({
  momentId: Schema.String,
  path: Schema.String,
  markdown: Schema.NullOr(Schema.String),
  sha256: Schema.String,
  materialized: Schema.Boolean,
  projection: ProjectionProvenanceSchema,
});
const ExternalEditResultSchema = Schema.Union([
  mutableStruct({ kind: Schema.Literal("merged"), markdown: Schema.String }),
  mutableStruct({
    kind: Schema.Literal("conflict"),
    conflictPath: Schema.String,
  }),
]);
const CloseResultSchema = mutableStruct({ closed: Schema.Literal(true) });
const EvictResultSchema = mutableStruct({ evicted: Schema.Literal(true) });
const RemoteUpdatePayloadSchema = mutableStruct({
  sessionId: Schema.String,
  updateBase64: Schema.String,
});

export function decodeYdocOpenResult(value: JsonValue): YdocOpenResult {
  return decodeYdocSchema(
    OpenResultSchema,
    value,
    "ydoc.open result",
  ) as YdocOpenResult;
}

export function decodeYdocRecordUpdateResult(
  value: JsonValue,
): YdocRecordUpdateResult {
  return decodeYdocSchema(
    RecordUpdateResultSchema,
    value,
    "ydoc.recordUpdate result",
  ) as YdocRecordUpdateResult;
}

export function decodeYdocSettleResult(value: JsonValue): YdocSettleResult {
  return decodeYdocSchema(
    SettleResultSchema,
    value,
    "ydoc.settle result",
  ) as YdocSettleResult;
}

export function decodeYdocExternalEditResult(
  value: JsonValue,
): YdocApplyExternalMarkdownEditResult {
  return decodeYdocSchema(
    ExternalEditResultSchema,
    value,
    "ydoc.applyExternalMarkdownEdit result",
  ) as YdocApplyExternalMarkdownEditResult;
}

export function decodeYdocCloseResult(value: JsonValue): YdocCloseResult {
  return decodeYdocSchema(
    CloseResultSchema,
    value,
    "ydoc.close result",
  ) as YdocCloseResult;
}

export function decodeYdocEvictResult(value: JsonValue): YdocEvictResult {
  return decodeYdocSchema(
    EvictResultSchema,
    value,
    "ydoc.evict result",
  ) as YdocEvictResult;
}

export function decodeYdocRemoteUpdatePayload(
  value: JsonValue,
): YdocRemoteUpdatePayload {
  return decodeYdocSchema(
    RemoteUpdatePayloadSchema,
    value,
    "ydoc.remoteUpdate payload",
  ) as YdocRemoteUpdatePayload;
}
