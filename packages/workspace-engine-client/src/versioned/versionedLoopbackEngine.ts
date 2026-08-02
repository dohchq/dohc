import { createHash } from "node:crypto";
import { classifyEngineFilePath } from "@dohc/security-contract/engine-path-floor";
import { validateUserWritePath } from "@dohc/workspace-core/paths";
import type { ErrorCode } from "../ydoc/generated/ErrorCode";
import type { Event } from "../ydoc/generated/Event";
import type { JsonValue } from "../ydoc/generated/serde_json/JsonValue";
import type { Request } from "../ydoc/generated/Request";
import type { Response } from "../ydoc/generated/Response";
import type { WireError } from "../ydoc/generated/WireError";
import type { EngineTransport } from "../ydoc/ydocLiveAdapter";
import type { JsonObject } from "../ydoc/ydocWireContract";
import { MAX_DESKTOP_CAPTURE_TEXT_BYTES } from "./engineTextLimits";
import {
  VERSIONED_METHOD,
  type MomentRecord,
  type SecretMomentRecord,
  type VersionChangeStatus,
  type VersionedContentKind,
  type VersionedMethod,
  type VersionedOrigin,
} from "./versionedWireContract";

// A refusal the real engine reports as an internal failure rather than a
// caller mistake (`map_runtime` in crates/dohc-workspace-engine/src/lib.rs).
const INTERNAL_REFUSALS = new Set<string>(["state-corrupt", "persist-failed"]);

/**
 * Reject the way the real client rejects.
 *
 * `EngineClient` turns the engine's error envelope into an error carrying
 * `wireError`, which `DaemonLiveAdapter` re-throws as `DaemonRefusalError`. A
 * bare `Error` never reaches that path, so every caller that keys on a refusal
 * was dead code under the loopback and live against the daemon.
 *
 * The engine puts the kebab-case domain code in the wire MESSAGE, so a thrown
 * message is already the payload; only the envelope was missing.
 */
function refusalFrom(error: unknown): unknown {
  if (!(error instanceof Error)) return error;
  if ("wireError" in error) return error;
  const code: ErrorCode = INTERNAL_REFUSALS.has(error.message)
    ? "INTERNAL"
    : "INVALID_PARAMS";
  const wireError: WireError = { code, message: error.message, retry: "no" };
  return Object.assign(error, { wireError });
}

const INBAND_LIMIT_BYTES = 48 * 1024;

// The limits live in a leaf module (no imports) so a renderer can read them
// without pulling this fixture's `node:crypto` into a browser bundle.
export {
  MAX_DESKTOP_CAPTURE_TEXT_BYTES,
  MAX_MERGED_RESOLUTION_TEXT_BYTES,
  jsonStringEncodedLength,
} from "./engineTextLimits";

const MAX_SECRET_FILE_BYTES = 1024 * 1024;
const MAX_CAPTURE_BINARY_FILE_BYTES = 5 * 1024 * 1024;
const COMPARE_PAGE_SIZE = 200;
const MAX_MERGE_LINES = 2_000;
// Mirrors MAX_METADATA_FIELD_BYTES in crates/dohc-workspace-engine/src/lib.rs.
const MAX_METADATA_FIELD_BYTES = 16 * 1024;

/**
 * The daemon's `settled_snapshot_json` (lib.rs): a settled body past the
 * in-band cap leaves the answer as a digest and a limit, never as text, so the
 * answer's size never follows the body.
 */
export function settledSnapshotForWire(snapshot: JsonObject): JsonObject {
  const text = snapshot.text;
  if (typeof text !== "string" || utf8Length(text) <= MAX_DESKTOP_CAPTURE_TEXT_BYTES) {
    return snapshot;
  }
  return { ...snapshot, text: null, inbandLimitBytes: MAX_DESKTOP_CAPTURE_TEXT_BYTES };
}

/**
 * The daemon's `settled_conflict_json` (lib.rs): the SAME withholding rule
 * over every side of the conflict a resolution closed, so no part of that
 * answer grows with a body.
 */
export function settledConflictForWire(conflict: JsonObject): JsonObject {
  const settled = { ...conflict };
  for (const side of ["base", "current", "incoming"] as const) {
    const state = settled[side];
    if (state === null || typeof state !== "object" || Array.isArray(state)) continue;
    const snapshot = (state as JsonObject).snapshot;
    if (snapshot === null || typeof snapshot !== "object" || Array.isArray(snapshot)) {
      continue;
    }
    settled[side] = {
      ...(state as JsonObject),
      snapshot: settledSnapshotForWire(snapshot as JsonObject),
    };
  }
  return settled;
}

const ACCEPTED_ORIGINS = new Set<string>([
  "api",
  "local-file",
  "restore",
  "sync",
  "unknown",
]);

interface SerdeParamShape {
  requiredStrings?: readonly string[];
  optionalStrings?: readonly string[];
  optionalI64?: readonly string[];
  optionalUsize?: readonly string[];
  optionalBytes?: readonly string[];
  optionalJson?: readonly string[];
}

const MUTATION_OPTIONAL_STRINGS = [
  "workspaceId",
  "origin",
  "metadataOrigin",
  "summary",
  "correlationId",
  "authorJson",
  "requestId",
] as const;
const WRITE_OPTIONAL_STRINGS = [
  ...MUTATION_OPTIONAL_STRINGS,
  "objectId",
  "momentId",
] as const;
const REQUIRED_SECRET_METADATA = ["workspaceId", "origin"] as const;
const OPTIONAL_SECRET_METADATA = ["summary", "correlationId"] as const;

// One executable inventory of every method this loopback dispatches. Rust
// deserializes these deny_unknown_fields structs before it resolves a workspace
// handle; keeping the inventory exhaustive makes a new method fail typecheck
// until its wire shape is stated here too.
const VERSIONED_PARAM_SHAPES = {
  [VERSIONED_METHOD.textWrite]: {
    requiredStrings: ["versionId", "path", "text"],
    optionalStrings: WRITE_OPTIONAL_STRINGS,
    optionalI64: ["nowMs"],
    optionalJson: ["author"],
  },
  [VERSIONED_METHOD.textRead]: { requiredStrings: ["versionId", "path"] },
  [VERSIONED_METHOD.textReadBlob]: {
    requiredStrings: ["workspaceId", "sha256"],
  },
  [VERSIONED_METHOD.textRename]: {
    requiredStrings: ["versionId", "fromPath", "toPath"],
    optionalStrings: MUTATION_OPTIONAL_STRINGS,
    optionalI64: ["nowMs"],
    optionalJson: ["author"],
  },
  [VERSIONED_METHOD.textDelete]: {
    requiredStrings: ["versionId", "path"],
    optionalStrings: MUTATION_OPTIONAL_STRINGS,
    optionalI64: ["nowMs"],
    optionalJson: ["author"],
  },
  [VERSIONED_METHOD.textRollback]: {
    requiredStrings: ["versionId", "path", "mutationMomentId"],
    optionalStrings: [
      "workspaceId",
      "origin",
      "metadataOrigin",
      "authorJson",
      "requestId",
      "legacyBeforeText",
    ],
    optionalJson: ["author"],
  },
  [VERSIONED_METHOD.textList]: {
    requiredStrings: ["versionId"],
    optionalStrings: ["afterPath"],
    optionalUsize: ["limit"],
  },
  [VERSIONED_METHOD.binaryWrite]: {
    requiredStrings: ["versionId", "path"],
    optionalStrings: [...WRITE_OPTIONAL_STRINGS, "bytesBase64"],
    optionalI64: ["nowMs"],
    optionalBytes: ["bytes"],
    optionalJson: ["author"],
  },
  [VERSIONED_METHOD.binaryWriteBlob]: {
    requiredStrings: ["versionId", "path", "sha256"],
    optionalStrings: [...WRITE_OPTIONAL_STRINGS, "bytesBase64"],
    optionalI64: ["nowMs"],
    optionalJson: ["author"],
  },
  [VERSIONED_METHOD.binaryRead]: { requiredStrings: ["versionId", "path"] },
  [VERSIONED_METHOD.binaryReadBlob]: {
    requiredStrings: ["workspaceId", "sha256"],
  },
  [VERSIONED_METHOD.versionsCreateNamed]: {
    requiredStrings: ["workspaceId", "name", "fromVersionId"],
  },
  [VERSIONED_METHOD.versionsList]: { optionalStrings: ["afterVersionId"] },
  [VERSIONED_METHOD.versionsSetActive]: {
    requiredStrings: ["versionId"],
    optionalStrings: ["workspaceId"],
  },
  [VERSIONED_METHOD.versionsEnsureMain]: { optionalStrings: ["workspaceId"] },
  [VERSIONED_METHOD.versionsActive]: { optionalStrings: ["workspaceId"] },
  [VERSIONED_METHOD.versionsMerge]: {
    requiredStrings: ["path", "sourceVersionId", "targetVersionId"],
    optionalStrings: MUTATION_OPTIONAL_STRINGS,
    optionalI64: ["nowMs"],
    optionalJson: ["author"],
  },
  [VERSIONED_METHOD.versionsCompare]: {
    requiredStrings: ["path", "sourceVersionId", "targetVersionId"],
    optionalStrings: ["workspaceId"],
  },
  [VERSIONED_METHOD.versionsCompareFiles]: {
    requiredStrings: ["sourceVersionId", "targetVersionId"],
    optionalStrings: ["workspaceId", "afterPath"],
    optionalUsize: ["byteBudget"],
  },
  [VERSIONED_METHOD.secretsWrite]: {
    requiredStrings: [
      ...REQUIRED_SECRET_METADATA,
      "versionId",
      "path",
      "text",
      "momentId",
    ],
    optionalStrings: OPTIONAL_SECRET_METADATA,
  },
  [VERSIONED_METHOD.secretsList]: {
    requiredStrings: ["versionId"],
    optionalStrings: ["afterPath"],
    optionalUsize: ["limit"],
  },
  [VERSIONED_METHOD.secretsStateExists]: { optionalStrings: ["workspaceId"] },
  [VERSIONED_METHOD.secretsMaterialize]: {
    requiredStrings: ["versionId", "path"],
  },
  [VERSIONED_METHOD.secretsDelete]: {
    requiredStrings: [
      ...REQUIRED_SECRET_METADATA,
      "versionId",
      "path",
      "momentId",
    ],
    optionalStrings: OPTIONAL_SECRET_METADATA,
  },
  [VERSIONED_METHOD.secretsFork]: {
    requiredStrings: ["workspaceId", "fromVersionId", "toVersionId"],
  },
  [VERSIONED_METHOD.secretsCompare]: {
    requiredStrings: ["workspaceId", "sourceVersionId", "targetVersionId"],
    optionalStrings: ["afterPath"],
    optionalUsize: ["limit"],
  },
  [VERSIONED_METHOD.secretsApply]: {
    requiredStrings: [
      ...REQUIRED_SECRET_METADATA,
      "path",
      "sourceVersionId",
      "targetVersionId",
      "momentId",
    ],
    optionalStrings: OPTIONAL_SECRET_METADATA,
  },
  [VERSIONED_METHOD.secretsRestore]: {
    requiredStrings: [
      ...REQUIRED_SECRET_METADATA,
      "path",
      "beforeMomentId",
      "momentId",
    ],
    optionalStrings: OPTIONAL_SECRET_METADATA,
  },
  [VERSIONED_METHOD.secretsMomentsList]: {
    requiredStrings: ["workspaceId"],
    optionalStrings: ["versionId", "path"],
    optionalI64: ["beforeMomentOrder"],
    optionalUsize: ["limit"],
  },
  [VERSIONED_METHOD.secretsMomentsGet]: {
    requiredStrings: ["workspaceId", "momentId"],
  },
  [VERSIONED_METHOD.momentsList]: {
    optionalStrings: ["versionId", "objectId"],
    optionalI64: ["limit", "beforeMomentOrder"],
  },
  [VERSIONED_METHOD.momentsGet]: { requiredStrings: ["momentId"] },
  [VERSIONED_METHOD.searchEnsureIndex]: {
    requiredStrings: ["workspaceId", "versionId"],
  },
} satisfies Record<VersionedMethod, SerdeParamShape>;

interface LoopbackFile {
  objectId: string;
  contentKind: VersionedContentKind;
  text?: string;
  bytes?: number[];
  binarySha?: string;
  updatedAtMs: number;
  latestMomentId: string;
  metadataOrigin: string;
  momentLog: InternalMoment[];
}

interface InternalMoment {
  wire: MomentRecord;
  before?: LoopbackFile;
  after?: LoopbackFile;
  beforePath?: string;
  writeAuthorFingerprint?: string | null;
}

interface LoopbackVersion {
  id: string;
  workspaceId: string;
  kind: "main" | "named";
  name: string;
  createdAtMs: number;
  forkVersionId?: string;
  forkMomentId?: string;
  files: Map<string, LoopbackFile>;
  textForkBase: Map<string, LoopbackFile>;
  secrets: Map<string, string>;
  secretForkBase: Map<string, string>;
}

interface InternalSecretMoment {
  wire: SecretMomentRecord;
  before?: string;
  after?: string;
}

interface WorkspaceState {
  versioned: boolean;
  versions: Map<string, LoopbackVersion>;
  activeVersionId?: string;
  moments: Map<string, InternalMoment>;
  secretMoments: Map<string, InternalSecretMoment>;
  blobs: Map<string, number[]>;
  replays: Map<string, { fingerprint: string; result: JsonObject }>;
}

interface ParsedWriteFields {
  objectId?: string;
  momentId?: string;
  requestId?: string;
  nowMs?: number;
}

interface ParsedTextWriteFields extends ParsedWriteFields {
  versionId: string;
  path: string;
  text: string;
}

interface ParsedBinaryWriteFields extends ParsedWriteFields {
  versionId: string;
  path: string;
  bytes?: number[];
  bytesBase64?: string;
}

interface ParsedBinaryBlobWriteFields extends ParsedWriteFields {
  versionId: string;
  path: string;
  sha256: string;
  bytesBase64?: string;
}

interface ParsedTextRenameFields {
  versionId: string;
  fromPath: string;
  toPath: string;
  requestId?: string;
  nowMs?: number;
}

interface ParsedTextDeleteFields {
  versionId: string;
  path: string;
  requestId?: string;
  nowMs?: number;
}

interface ParsedSecretWriteFields {
  versionId: string;
  path: string;
  text: string;
  momentId: string;
}

interface ParsedSecretDeleteFields {
  versionId: string;
  path: string;
  momentId: string;
}

export interface SeedVersionedTextInput {
  workspace: string;
  versionId?: string;
  path: string;
  text: string;
  objectId?: string;
  momentId?: string;
  origin?: VersionedOrigin;
}

export interface SeedVersionedBinaryInput {
  workspace: string;
  versionId?: string;
  path: string;
  bytes: number[];
  objectId?: string;
  momentId?: string;
  origin?: VersionedOrigin;
}

export interface SeedSecretInput {
  workspace: string;
  versionId?: string;
  path: string;
  text: string;
  momentId?: string;
  origin?: VersionedOrigin;
}

function asObject(value: JsonValue, label: string): JsonObject {
  if (value === null || Array.isArray(value) || typeof value !== "object") {
    throw new Error(`${label} must be an object.`);
  }
  return value;
}

function requiredString(object: JsonObject, key: string, label: string): string {
  const value = object[key];
  if (typeof value !== "string") throw new Error(`${label}.${key} is invalid.`);
  return value;
}

function rejectUnknownFields(object: JsonObject, allowed: ReadonlySet<string>): void {
  if (Object.keys(object).some((key) => !allowed.has(key))) {
    throw new Error("invalid parameters");
  }
}

function serdeRequiredParamString(object: JsonObject, key: string): string {
  const value = object[key];
  if (typeof value !== "string") throw new Error("invalid parameters");
  return value;
}

function serdeOptionalParamString(object: JsonObject, key: string): string | undefined {
  const value = object[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw new Error("invalid parameters");
  return value;
}

const I64_MIN = -(1n << 63n);
const I64_MAX = (1n << 63n) - 1n;
const USIZE_MAX = (1n << 64n) - 1n;

function isSerdeI64(value: unknown): value is number {
  if (typeof value !== "number" || !Number.isFinite(value) || !Number.isInteger(value)) {
    return false;
  }
  // The daemon sees JSON text, not the in-memory IEEE-754 value. At the
  // negative boundary, `-(2 ** 63)` is represented internally as i64::MIN but
  // serializes as -9223372036854776000, which serde correctly rejects as below
  // i64::MIN. Compare the same decimal spelling that crosses the wire.
  try {
    const integer = BigInt(JSON.stringify(value));
    return integer >= I64_MIN && integer <= I64_MAX;
  } catch {
    return false;
  }
}

function serdeOptionalParamNumber(object: JsonObject, key: string): number | undefined {
  const value = object[key];
  if (value === undefined || value === null) return undefined;
  if (!isSerdeI64(value)) {
    throw new Error("invalid parameters");
  }
  return value;
}

function isSerdeUsize(value: unknown): value is number {
  if (typeof value !== "number" || !Number.isFinite(value) || !Number.isInteger(value)) {
    return false;
  }
  try {
    const integer = BigInt(JSON.stringify(value));
    return integer >= 0n && integer <= USIZE_MAX;
  } catch {
    return false;
  }
}

function serdeOptionalParamUsize(object: JsonObject, key: string): number | undefined {
  const value = object[key];
  if (value === undefined || value === null) return undefined;
  if (!isSerdeUsize(value)) throw new Error("invalid parameters");
  return value;
}

function serdeOptionalParamBytes(object: JsonObject, key: string): number[] | undefined {
  const value = object[key];
  if (value === undefined || value === null) return undefined;
  if (
    !Array.isArray(value) ||
    value.some(
      (byte) =>
        typeof byte !== "number" ||
        !Number.isInteger(byte) ||
        byte < 0 ||
        byte > 255,
    )
  ) {
    throw new Error("invalid parameters");
  }
  return value as number[];
}

function versionedParamFields(shape: SerdeParamShape): ReadonlySet<string> {
  return new Set([
    ...(shape.requiredStrings ?? []),
    ...(shape.optionalStrings ?? []),
    ...(shape.optionalI64 ?? []),
    ...(shape.optionalUsize ?? []),
    ...(shape.optionalBytes ?? []),
    ...(shape.optionalJson ?? []),
  ]);
}

function validateVersionedParams(
  method: string,
  params: JsonObject,
  request: Request,
): void {
  const shape: SerdeParamShape | undefined =
    VERSIONED_PARAM_SHAPES[method as VersionedMethod];
  if (shape === undefined) return;
  rejectUnknownFields(params, versionedParamFields(shape));
  requestIdempotencyKey(request);
  for (const key of shape.requiredStrings ?? []) serdeRequiredParamString(params, key);
  for (const key of shape.optionalStrings ?? []) serdeOptionalParamString(params, key);
  for (const key of shape.optionalI64 ?? []) serdeOptionalParamNumber(params, key);
  for (const key of shape.optionalUsize ?? []) serdeOptionalParamUsize(params, key);
  for (const key of shape.optionalBytes ?? []) serdeOptionalParamBytes(params, key);
}

function validatePreWorkspaceSemantics(method: string, params: JsonObject): void {
  switch (method) {
    case VERSIONED_METHOD.versionsSetActive: {
      const versionId = serdeRequiredParamString(params, "versionId");
      if (versionId.length === 0 || versionId.trim() !== versionId) {
        throw new Error("invalid-version");
      }
      break;
    }
    case VERSIONED_METHOD.textReadBlob:
    case VERSIONED_METHOD.binaryReadBlob: {
      const digest = serdeRequiredParamString(params, "sha256").toLowerCase();
      if (!/^[0-9a-f]{64}$/.test(digest)) throw new Error("invalid-input");
      break;
    }
    case VERSIONED_METHOD.momentsList:
      if (serdeOptionalParamString(params, "objectId") === "") {
        throw new Error("objectId must not be empty");
      }
      break;
    case VERSIONED_METHOD.momentsGet:
      if (serdeRequiredParamString(params, "momentId") === "") {
        throw new Error("momentId must not be empty");
      }
      break;
    case VERSIONED_METHOD.secretsApply:
      if (!isSecretClassifiedPath(serdeRequiredParamString(params, "path"))) {
        throw new Error("not-secret-path");
      }
      break;
    case VERSIONED_METHOD.secretsMaterialize:
      if (!isSecretClassifiedPath(serdeRequiredParamString(params, "path"))) {
        throw new Error("not a secret path");
      }
      break;
  }
}

function optionalString(object: JsonObject, key: string): string | undefined {
  const value = object[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new Error(`${key} is invalid.`);
  return value;
}

function serdeOptionalString(object: JsonObject, key: string): string | undefined {
  return object[key] === null ? undefined : optionalString(object, key);
}

function optionalNumber(object: JsonObject, key: string): number | undefined {
  const value = object[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value) || !Number.isInteger(value)) {
    throw new Error(`${key} is invalid.`);
  }
  return value;
}

function requestIdempotencyKey(request: Request): string | undefined {
  const value = request.idempotencyKey as unknown;
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw new Error("invalid parameters");
  return value;
}

function parseWriteFields(params: JsonObject, request: Request): ParsedWriteFields {
  const idempotencyKey = requestIdempotencyKey(request);
  serdeOptionalParamString(params, "workspaceId");
  serdeOptionalParamString(params, "origin");
  serdeOptionalParamString(params, "metadataOrigin");
  serdeOptionalParamString(params, "summary");
  serdeOptionalParamString(params, "correlationId");
  serdeOptionalParamString(params, "authorJson");
  return {
    objectId: serdeOptionalParamString(params, "objectId"),
    momentId: serdeOptionalParamString(params, "momentId"),
    requestId: serdeOptionalParamString(params, "requestId") ?? idempotencyKey,
    nowMs: serdeOptionalParamNumber(params, "nowMs"),
  };
}

function parseTextWriteFields(params: JsonObject, request: Request): ParsedTextWriteFields {
  return {
    ...parseWriteFields(params, request),
    versionId: serdeRequiredParamString(params, "versionId"),
    path: serdeRequiredParamString(params, "path"),
    text: serdeRequiredParamString(params, "text"),
  };
}

function parseBinaryWriteFields(params: JsonObject, request: Request): ParsedBinaryWriteFields {
  return {
    ...parseWriteFields(params, request),
    versionId: serdeRequiredParamString(params, "versionId"),
    path: serdeRequiredParamString(params, "path"),
    bytes: serdeOptionalParamBytes(params, "bytes"),
    bytesBase64: serdeOptionalParamString(params, "bytesBase64"),
  };
}

function parseBinaryBlobWriteFields(
  params: JsonObject,
  request: Request,
): ParsedBinaryBlobWriteFields {
  return {
    ...parseWriteFields(params, request),
    versionId: serdeRequiredParamString(params, "versionId"),
    path: serdeRequiredParamString(params, "path"),
    sha256: serdeRequiredParamString(params, "sha256"),
    bytesBase64: serdeOptionalParamString(params, "bytesBase64"),
  };
}

function parseWorkspaceOnlyFields(params: JsonObject): void {
  serdeOptionalParamString(params, "workspaceId");
}

function parseTextRenameFields(
  params: JsonObject,
  request: Request,
): ParsedTextRenameFields {
  const idempotencyKey = requestIdempotencyKey(request);
  serdeOptionalParamString(params, "workspaceId");
  serdeOptionalParamString(params, "origin");
  serdeOptionalParamString(params, "metadataOrigin");
  serdeOptionalParamString(params, "summary");
  serdeOptionalParamString(params, "correlationId");
  serdeOptionalParamString(params, "authorJson");
  return {
    versionId: serdeRequiredParamString(params, "versionId"),
    fromPath: serdeRequiredParamString(params, "fromPath"),
    toPath: serdeRequiredParamString(params, "toPath"),
    requestId: serdeOptionalParamString(params, "requestId") ?? idempotencyKey,
    nowMs: serdeOptionalParamNumber(params, "nowMs"),
  };
}

function parseTextDeleteFields(
  params: JsonObject,
  request: Request,
): ParsedTextDeleteFields {
  const idempotencyKey = requestIdempotencyKey(request);
  serdeOptionalParamString(params, "workspaceId");
  serdeOptionalParamString(params, "origin");
  serdeOptionalParamString(params, "metadataOrigin");
  serdeOptionalParamString(params, "summary");
  serdeOptionalParamString(params, "correlationId");
  serdeOptionalParamString(params, "authorJson");
  return {
    versionId: serdeRequiredParamString(params, "versionId"),
    path: serdeRequiredParamString(params, "path"),
    requestId: serdeOptionalParamString(params, "requestId") ?? idempotencyKey,
    nowMs: serdeOptionalParamNumber(params, "nowMs"),
  };
}

function parseSecretWriteFields(params: JsonObject, request: Request): ParsedSecretWriteFields {
  requestIdempotencyKey(request);
  serdeRequiredParamString(params, "workspaceId");
  serdeRequiredParamString(params, "origin");
  serdeOptionalParamString(params, "summary");
  serdeOptionalParamString(params, "correlationId");
  return {
    versionId: serdeRequiredParamString(params, "versionId"),
    path: serdeRequiredParamString(params, "path"),
    text: serdeRequiredParamString(params, "text"),
    momentId: serdeRequiredParamString(params, "momentId"),
  };
}

function parseSecretDeleteFields(params: JsonObject, request: Request): ParsedSecretDeleteFields {
  requestIdempotencyKey(request);
  serdeRequiredParamString(params, "workspaceId");
  serdeRequiredParamString(params, "origin");
  serdeOptionalParamString(params, "summary");
  serdeOptionalParamString(params, "correlationId");
  return {
    versionId: serdeRequiredParamString(params, "versionId"),
    path: serdeRequiredParamString(params, "path"),
    momentId: serdeRequiredParamString(params, "momentId"),
  };
}

// `secrets.restore` only. SecretsRestoreParams takes `origin` as a required field
// with deny_unknown_fields, so there is no legacy `metadataOrigin` fallback to
// honour — accepting one lets the fake through a request the daemon refuses while
// deserializing.
function restoreOrigin(object: JsonObject): VersionedOrigin {
  // `deny_unknown_fields` makes the mere PRESENCE of metadataOrigin fatal, even
  // alongside a valid `origin` — serde refuses before any field is read. So this
  // rejects the field rather than merely declining to fall back to it.
  if (object.metadataOrigin !== undefined) throw new Error("invalid-metadata");
  const origin = optionalString(object, "origin");
  if (origin === undefined || !ACCEPTED_ORIGINS.has(origin)) {
    throw new Error("invalid-metadata");
  }
  return origin as VersionedOrigin;
}

function requiredOrigin(object: JsonObject): VersionedOrigin {
  const origin = serdeOptionalString(object, "origin");
  const legacyOrigin = serdeOptionalString(object, "metadataOrigin");
  if (origin !== undefined) {
    if (!ACCEPTED_ORIGINS.has(origin)) throw new Error("invalid-metadata");
    return origin as VersionedOrigin;
  }
  if (legacyOrigin === "agent") return "api";
  if (!legacyOrigin || !ACCEPTED_ORIGINS.has(legacyOrigin)) {
    throw new Error("invalid-metadata");
  }
  return legacyOrigin as VersionedOrigin;
}

function copyFile(file: LoopbackFile): LoopbackFile {
  return {
    ...file,
    bytes: file.bytes ? [...file.bytes] : undefined,
    momentLog: [...file.momentLog],
  };
}

function utf8Length(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

// One reading of a metadata field, matching the daemon on all three points:
// JSON `null` is ABSENT (these deserialize as `Option<String>`), a non-string is
// a refusal, and either field over MAX_METADATA_FIELD_BYTES is
// `invalid-metadata`.
//
// THE ORDERING INVARIANT, stated once for every caller. `validate_metadata_fields`
// runs on EVERY write handler, immediately after the content checks and the
// origin, and BEFORE the handler reads any state. So a request that is wrong in
// two ways must fail on whichever the daemon reaches first, and the call sites
// below keep that order rather than restating why.
//
// Two ordering details must stay explicit at the call sites:
// `versionedBinary.writeBlob` validates before decoding while
// `versionedBinary.write` decodes first, and handlers must validate before they
// call `mutationVersion` because it can create `main` (#439).
function metadataField(params: JsonObject, key: string): string | undefined {
  const raw = params[key];
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "string") throw new Error(`${key} is invalid.`);
  if (utf8Length(raw) > MAX_METADATA_FIELD_BYTES) throw new Error("invalid-metadata");
  return raw;
}

function isSecretClassifiedPath(path: string): boolean {
  return classifyEngineFilePath(path).kind === "secret";
}

function validateRustPathFloor(path: string): void {
  const bytes = Buffer.from(path, "utf8");
  if (
    path.length === 0 ||
    path.includes("\0") ||
    path.startsWith("/") ||
    path.includes("\\") ||
    bytes[1] === 0x3a ||
    path.includes("..") ||
    path === ".dohc" ||
    path.startsWith(".dohc/")
  ) {
    throw new Error("invalid-path");
  }
}

function normalizedEnginePath(path: string, kind: "addressable" | "storable"): string {
  validateRustPathFloor(path);
  const classification = classifyEngineFilePath(path).kind;
  const accepted =
    kind === "addressable"
      ? classification !== "ignored"
      : classification === "tracked";
  const validation = validateUserWritePath(path);
  if (!accepted || !validation.ok) throw new Error("invalid-path");
  return validation.normalized;
}

function normalizedSecretPath(path: string): string {
  validateRustPathFloor(path);
  const validation = validateUserWritePath(path);
  if (classifyEngineFilePath(path).kind !== "secret" || !validation.ok) {
    throw new Error("not-secret-path");
  }
  return validation.normalized;
}

function validateTextMomentId(momentId: string): void {
  if (momentId.length === 0 || momentId.includes("\u001f")) {
    throw new Error("invalid-input");
  }
}

function validateSecretMomentId(momentId: string): void {
  if (momentId.length === 0) throw new Error("invalid-input");
}

function stableJsonStringify(value: JsonValue): string {
  const stableValue = (candidate: JsonValue): JsonValue => {
    if (Array.isArray(candidate)) return candidate.map(stableValue);
    if (typeof candidate !== "object" || candidate === null) return candidate;
    return Object.fromEntries(
      Object.keys(candidate)
        .sort()
        .map((key) => [key, stableValue(candidate[key]!)]),
    ) as JsonObject;
  };
  return JSON.stringify(stableValue(value));
}

function sha256(value: string | number[]): string {
  return createHash("sha256")
    .update(typeof value === "string" ? value : Uint8Array.from(value))
    .digest("hex");
}

function encodeBase64(bytes: number[]): string {
  return Buffer.from(bytes).toString("base64");
}

function decodeBase64(value: string): number[] {
  const bytes = [...Buffer.from(value, "base64")];
  if (encodeBase64(bytes) !== value) throw new Error("invalid-input");
  return bytes;
}

function comparePaths(left: string, right: string): number {
  return left === right ? 0 : left > right ? 1 : -1;
}

interface LineHunk {
  baseStart: number;
  baseEnd: number;
  replacement: string[];
}

type MarkdownMergeResult =
  | { status: "merged"; text: string }
  | { status: "conflict" };

function diffHunks(base: string[], side: string[]): LineHunk[] {
  const rowCount = base.length;
  const columnCount = side.length;
  const lcs = Array.from(
    { length: rowCount + 1 },
    () => Array<number>(columnCount + 1).fill(0),
  );
  for (let row = rowCount - 1; row >= 0; row -= 1) {
    for (let column = columnCount - 1; column >= 0; column -= 1) {
      lcs[row]![column] = base[row] === side[column]
        ? lcs[row + 1]![column + 1]! + 1
        : Math.max(lcs[row + 1]![column]!, lcs[row]![column + 1]!);
    }
  }

  const hunks: LineHunk[] = [];
  let row = 0;
  let column = 0;
  let pendingStart: number | undefined;
  let pendingReplacement: string[] = [];
  const flush = (baseEnd: number): void => {
    if (pendingStart === undefined) return;
    hunks.push({ baseStart: pendingStart, baseEnd, replacement: pendingReplacement });
    pendingStart = undefined;
    pendingReplacement = [];
  };

  while (row < rowCount && column < columnCount) {
    if (base[row] === side[column]) {
      flush(row);
      row += 1;
      column += 1;
    } else if (lcs[row + 1]![column]! >= lcs[row]![column + 1]!) {
      pendingStart ??= row;
      row += 1;
    } else {
      pendingStart ??= row;
      pendingReplacement.push(side[column]!);
      column += 1;
    }
  }
  if (row < rowCount || column < columnCount) {
    pendingStart ??= row;
    pendingReplacement.push(...side.slice(column));
    hunks.push({
      baseStart: pendingStart,
      baseEnd: rowCount,
      replacement: pendingReplacement,
    });
  } else {
    flush(row);
  }
  return hunks;
}

function mergeMarkdown(base: string, local: string, remote: string): MarkdownMergeResult {
  if (local === remote) return { status: "merged", text: local };
  if (local === base) return { status: "merged", text: remote };
  if (remote === base) return { status: "merged", text: local };

  const baseLines = base.split("\n");
  const localLines = local.split("\n");
  const remoteLines = remote.split("\n");
  if ([baseLines.length, localLines.length, remoteLines.length].some((count) => count > MAX_MERGE_LINES)) {
    return { status: "conflict" };
  }

  const localHunks = diffHunks(baseLines, localLines);
  const remoteHunks = diffHunks(baseLines, remoteLines);
  for (const localHunk of localHunks) {
    for (const remoteHunk of remoteHunks) {
      const bothInsertAtSameOffset =
        localHunk.baseStart === localHunk.baseEnd &&
        remoteHunk.baseStart === remoteHunk.baseEnd &&
        localHunk.baseStart === remoteHunk.baseStart;
      const sameStartWithInsertion =
        localHunk.baseStart === remoteHunk.baseStart &&
        (localHunk.baseStart === localHunk.baseEnd) !==
          (remoteHunk.baseStart === remoteHunk.baseEnd);
      const overlapping =
        localHunk.baseStart < remoteHunk.baseEnd &&
        remoteHunk.baseStart < localHunk.baseEnd;
      if (bothInsertAtSameOffset || sameStartWithInsertion || overlapping) {
        return { status: "conflict" };
      }
    }
  }

  const hunks = [...localHunks, ...remoteHunks].sort(
    (left, right) => left.baseStart - right.baseStart,
  );
  const output: string[] = [];
  let cursor = 0;
  for (const hunk of hunks) {
    output.push(...baseLines.slice(cursor, hunk.baseStart), ...hunk.replacement);
    cursor = hunk.baseEnd;
  }
  output.push(...baseLines.slice(cursor));
  return { status: "merged", text: output.join("\n") };
}

export class VersionedLoopbackEngine implements EngineTransport {
  readonly requests: Request[] = [];
  readonly responses: Response[] = [];

  private readonly workspaces = new Map<string, WorkspaceState>();
  private nextObjectId = 1;
  private nextMomentId = 1;
  private nextVersionId = 1;
  private clock = 1;

  onEvent(_handler: (event: Event) => void): () => void {
    return () => undefined;
  }

  seedTextFile(input: SeedVersionedTextInput): void {
    const path = normalizedEnginePath(input.path, "storable");
    const state = this.workspace(input.workspace);
    const versionId = input.versionId ?? "main";
    const version = versionId === "main"
      ? this.ensureMain(state, input.workspace)
      : this.version(state, versionId);
    const objectId = input.objectId ?? `object-${this.nextObjectId++}`;
    const momentId = input.momentId ?? `moment-${this.nextMomentId++}`;
    this.assertFreshMoment(state, momentId);
    const before = version.files.get(path);
    const file: LoopbackFile = {
      objectId,
      contentKind: "text",
      text: input.text,
      updatedAtMs: this.clock++,
      latestMomentId: momentId,
      metadataOrigin: input.origin ?? "local-file",
      momentLog: before ? [...before.momentLog] : [],
    };
    const moment = this.makeMoment(
      version,
      path,
      momentId,
      "write",
      file,
      before,
    );
    const internal = { wire: moment, before: before && copyFile(before), after: copyFile(file) };
    file.momentLog.push(internal);
    version.files.set(path, file);
    state.moments.set(momentId, internal);
  }

  seedBinaryFile(input: SeedVersionedBinaryInput): void {
    const path = normalizedEnginePath(input.path, "storable");
    const state = this.workspace(input.workspace);
    const versionId = input.versionId ?? "main";
    const version = versionId === "main"
      ? this.ensureMain(state, input.workspace)
      : this.version(state, versionId);
    const objectId = input.objectId ?? `object-${this.nextObjectId++}`;
    const momentId = input.momentId ?? `moment-${this.nextMomentId++}`;
    this.assertFreshMoment(state, momentId);
    const before = version.files.get(path);
    const binarySha = sha256(input.bytes);
    const file: LoopbackFile = {
      objectId,
      contentKind: "binary",
      bytes: [...input.bytes],
      binarySha,
      updatedAtMs: this.clock++,
      latestMomentId: momentId,
      metadataOrigin: input.origin ?? "local-file",
      momentLog: before ? [...before.momentLog] : [],
    };
    const moment = this.makeMoment(
      version,
      path,
      momentId,
      "write",
      file,
      before,
    );
    const internal = { wire: moment, before: before && copyFile(before), after: copyFile(file) };
    file.momentLog.push(internal);
    version.files.set(path, file);
    state.moments.set(momentId, internal);
    state.blobs.set(binarySha, [...input.bytes]);
  }

  seedSecretFile(input: SeedSecretInput): void {
    const path = normalizedSecretPath(input.path);
    const state = this.workspace(input.workspace);
    const versionId = input.versionId ?? "main";
    const version = versionId === "main"
      ? this.ensureMain(state, input.workspace)
      : this.version(state, versionId);
    const momentId = input.momentId ?? `secret-moment-${this.nextMomentId++}`;
    this.assertFreshSecretMoment(state, momentId);
    const before = version.secrets.get(path);
    version.secrets.set(path, input.text);
    const wire = this.makeSecretMoment(
      input.workspace,
      version.id,
      path,
      momentId,
      "write",
      input.origin ?? "local-file",
    );
    state.secretMoments.set(momentId, { wire, before, after: input.text });
  }

  secretValue(workspace: string, versionId: string, path: string): string | undefined {
    const normalizedPath = normalizedSecretPath(path);
    return this.version(this.workspace(workspace), versionId).secrets.get(normalizedPath);
  }

  async sendRequest(request: Request): Promise<Response> {
    this.requests.push(request);
    let result: JsonValue;
    try {
      result = this.handleRequest(request);
    } catch (error) {
      throw refusalFrom(error);
    }
    const response: Response = { id: request.id, result };
    this.responses.push(response);
    return response;
  }

  /**
   * The text write a conflict resolution settles, shaped as a
   * `versionedText.write` request but WITHOUT that method's in-band request
   * cap. The daemon settles a resolution inside the store
   * (`resolve_text_conflict`), so only the store's own text cap bounds the
   * body — a fixture that routed a resolution through the capped method would
   * refuse work the daemon accepts.
   */
  protected settleTextWrite(request: Request): Response {
    this.requests.push(request);
    let result: JsonValue;
    try {
      const params = asObject(request.params, `${request.method} params`);
      const parsed = parseTextWriteFields(params, request);
      const workspace = this.requireWorkspaceHandle(request);
      this.validateWorkspaceParam(params, workspace);
      result = this.textWrite(this.workspace(workspace), workspace, params, parsed, false);
    } catch (error) {
      throw refusalFrom(error);
    }
    const response: Response = { id: request.id, result };
    this.responses.push(response);
    return response;
  }

  private handleRequest(request: Request): JsonValue {
    const params = asObject(request.params, `${request.method} params`);
    validateVersionedParams(request.method, params, request);
    validatePreWorkspaceSemantics(request.method, params);
    let parsedTextWrite: ParsedTextWriteFields | undefined;
    let parsedBinaryWrite: ParsedBinaryWriteFields | undefined;
    let parsedBinaryBlobWrite: ParsedBinaryBlobWriteFields | undefined;
    let parsedTextRename: ParsedTextRenameFields | undefined;
    let parsedTextDelete: ParsedTextDeleteFields | undefined;
    let parsedSecretWrite: ParsedSecretWriteFields | undefined;
    let parsedSecretDelete: ParsedSecretDeleteFields | undefined;
    switch (request.method) {
      case VERSIONED_METHOD.textWrite:
        parsedTextWrite = parseTextWriteFields(params, request);
        break;
      case VERSIONED_METHOD.binaryWrite:
        parsedBinaryWrite = parseBinaryWriteFields(params, request);
        break;
      case VERSIONED_METHOD.binaryWriteBlob:
        parsedBinaryBlobWrite = parseBinaryBlobWriteFields(params, request);
        break;
      case VERSIONED_METHOD.textRename:
        parsedTextRename = parseTextRenameFields(params, request);
        break;
      case VERSIONED_METHOD.textDelete:
        parsedTextDelete = parseTextDeleteFields(params, request);
        break;
      case VERSIONED_METHOD.secretsWrite:
        parsedSecretWrite = parseSecretWriteFields(params, request);
        break;
      case VERSIONED_METHOD.secretsDelete:
        parsedSecretDelete = parseSecretDeleteFields(params, request);
        break;
      case VERSIONED_METHOD.versionsEnsureMain:
        parseWorkspaceOnlyFields(params);
        break;
    }
    // Rust deserializes method params before it opens the workspace handle.
    // Keep combined-invalid requests on that same refusal boundary.
    const workspace = this.requireWorkspaceHandle(request);
    this.validateWorkspaceParam(params, workspace);
    const state = this.workspace(workspace);
    switch (request.method) {
      case VERSIONED_METHOD.textWrite:
        return this.textWrite(state, workspace, params, parsedTextWrite!);
      case VERSIONED_METHOD.textRead:
        return this.textRead(state, workspace, params);
      case VERSIONED_METHOD.textReadBlob:
        return this.textReadBlob(state, params);
      case VERSIONED_METHOD.binaryWrite:
        return this.binaryWrite(state, workspace, params, parsedBinaryWrite!);
      case VERSIONED_METHOD.binaryWriteBlob:
        return this.binaryWriteBlob(state, workspace, params, parsedBinaryBlobWrite!);
      case VERSIONED_METHOD.textRename:
        return this.textRename(state, workspace, params, parsedTextRename!);
      case VERSIONED_METHOD.textDelete:
        return this.textDelete(state, workspace, params, parsedTextDelete!);
      case VERSIONED_METHOD.textRollback:
        return this.textRollback(state, workspace, params, request);
      case VERSIONED_METHOD.textList:
        return this.textList(state, params);
      case VERSIONED_METHOD.binaryRead:
        return this.binaryRead(state, params);
      case VERSIONED_METHOD.binaryReadBlob:
        return this.binaryReadBlob(state, params);
      case VERSIONED_METHOD.versionsCreateNamed:
        return this.createNamed(state, workspace, params, request);
      case VERSIONED_METHOD.versionsList:
        return this.versionsList(state, params);
      case VERSIONED_METHOD.versionsSetActive:
        return this.setActive(state, params);
      case VERSIONED_METHOD.versionsEnsureMain:
        return this.versionJson(this.ensureMain(state, workspace));
      case VERSIONED_METHOD.versionsActive:
        return state.versioned && state.activeVersionId !== undefined
          ? this.versionJson(this.version(state, state.activeVersionId))
          : null;
      case VERSIONED_METHOD.versionsMerge:
        return this.merge(state, workspace, params, request);
      case VERSIONED_METHOD.versionsCompare:
        return this.compare(state, workspace, params);
      case VERSIONED_METHOD.versionsCompareFiles:
        return this.compareFiles(state, params);
      case VERSIONED_METHOD.secretsWrite:
        return this.secretWrite(state, workspace, params, parsedSecretWrite!);
      case VERSIONED_METHOD.secretsList:
        return this.secretList(state, params);
      case VERSIONED_METHOD.secretsStateExists:
        return (
          state.secretMoments.size > 0 ||
          [...state.versions.values()].some((version) => version.secrets.size > 0)
        );
      case VERSIONED_METHOD.secretsMaterialize:
        return this.secretMaterialize(state, params);
      case VERSIONED_METHOD.secretsDelete:
        return this.secretDelete(state, workspace, params, parsedSecretDelete!);
      case VERSIONED_METHOD.secretsFork:
        return this.secretFork(state, params);
      case VERSIONED_METHOD.secretsCompare:
        return this.secretCompare(state, params);
      case VERSIONED_METHOD.secretsApply:
        return this.secretApply(state, workspace, params);
      case VERSIONED_METHOD.secretsRestore:
        return this.secretRestore(state, workspace, params);
      case VERSIONED_METHOD.secretsMomentsList:
        return this.secretMomentsList(state, params);
      case VERSIONED_METHOD.secretsMomentsGet:
        return this.secretMomentsGet(state, params);
      case VERSIONED_METHOD.momentsList:
        return this.momentsList(state, params);
      case VERSIONED_METHOD.momentsGet:
        return this.momentsGet(state, params);
      case VERSIONED_METHOD.searchEnsureIndex:
        this.version(state, requiredString(params, "versionId", request.method));
        return {};
      default:
        throw new Error(`Unsupported loopback method: ${request.method}`);
    }
  }

  private textWrite(
    state: WorkspaceState,
    workspace: string,
    params: JsonObject,
    parsed: ParsedTextWriteFields,
    inbandCapped = true,
  ): JsonValue {
    const { versionId, text } = parsed;
    if (inbandCapped && utf8Length(text) > MAX_DESKTOP_CAPTURE_TEXT_BYTES) {
      throw new Error("content-exceeds-inband-cap");
    }
    const origin = requiredOrigin(params);
    // Before every replay/dedup/unchanged return — see metadataField.
    const metadata = this.momentMetadataFields(params);
    const addressablePath = normalizedEnginePath(parsed.path, "addressable");
    if (parsed.momentId !== undefined) validateTextMomentId(parsed.momentId);
    const path = normalizedEnginePath(addressablePath, "storable");
    const knownVersion = state.versions.get(versionId);
    if (knownVersion === undefined && versionId !== "main") {
      this.version(state, versionId);
    }
    const requestId = parsed.requestId;
    const objectId = parsed.objectId ??
      (requestId !== undefined
        ? this.generatedWriteId("object", requestId, parsed.path)
        : knownVersion?.files.get(path)?.objectId ?? `object-${this.nextObjectId++}`);
    const momentId = parsed.momentId ??
      (requestId !== undefined
        ? this.generatedWriteId("moment", requestId, parsed.path)
        : undefined);
    let replayFingerprint: string | undefined;
    if (requestId !== undefined) {
      replayFingerprint = this.textWriteFingerprint(
        { ...params, path },
        origin,
        objectId,
        momentId!,
      );
      const replay = this.replay(state, requestId, params, replayFingerprint);
      if (replay) return replay;
    }
    const existingMoment = momentId === undefined ? undefined : state.moments.get(momentId);
    const authorFingerprint = this.writeAuthorFingerprint(params);
    if (existingMoment) {
      const exact =
        existingMoment.wire.versionId === versionId &&
        existingMoment.wire.path === path &&
        existingMoment.wire.operation === "write" &&
        existingMoment.wire.afterContentKind === "text" &&
        existingMoment.after?.contentKind === "text" &&
        existingMoment.after.text === text &&
        existingMoment.wire.metadataOrigin === origin &&
        // Compared against the ALREADY-NORMALIZED metadata. Re-reading the raw
        // fields here threw on an explicit `summary: null` that the first write
        // had accepted, so a fixed-momentId retry of a request the daemon
        // exact-replays (store.rs) got a refusal instead of `deduped: true`.
        (existingMoment.wire.metadataSummary ?? null) ===
          (metadata.metadataSummary ?? null) &&
        (existingMoment.wire.metadataCorrelationId ?? null) ===
          (metadata.metadataCorrelationId ?? null) &&
        (existingMoment.writeAuthorFingerprint ?? null) === authorFingerprint;
      if (exact) {
        const recorded = copyFile(existingMoment.after!);
        return {
          object: this.fileObject(workspace, recorded.objectId, existingMoment.wire.recordedAtMs),
          snapshot: this.textSnapshot(workspace, versionId, path, recorded),
          moment: this.capMoment(existingMoment.wire),
          deduped: true,
        };
      }
    }
    if (momentId !== undefined) this.assertFreshMoment(state, momentId);
    // The daemon checks the request ledger and a fixed moment before it reads
    // the current alias. A retry can therefore reconstruct its recorded write
    // after that path has been renamed or deleted.
    if (parsed.objectId === "" && !knownVersion?.files.has(path)) {
      throw new Error("invalid-input");
    }
    const version = this.mutationVersion(state, workspace, versionId);
    const resolvedMomentId = momentId ?? `moment-${this.nextMomentId++}`;
    replayFingerprint ??= this.textWriteFingerprint(
      { ...params, path },
      origin,
      objectId,
      resolvedMomentId,
    );
    if (momentId === undefined) this.assertFreshMoment(state, resolvedMomentId);
    const before = version.files.get(path);
    // The daemon binds the input object id to NEW paths only — an existing
    // head keeps its identity (store.rs existing_object.unwrap_or).
    const effectiveObjectId = before?.objectId ?? objectId;
    const now = parsed.nowMs ?? this.clock++;
    const file: LoopbackFile = {
      objectId: effectiveObjectId,
      contentKind: "text",
      text,
      updatedAtMs: now,
      latestMomentId: resolvedMomentId,
      metadataOrigin: origin,
      momentLog: before ? [...before.momentLog] : [],
    };
    const moment = this.makeMoment(
      version,
      path,
      resolvedMomentId,
      "write",
      file,
      before,
      now,
      metadata,
    );
    const internal = {
      wire: moment,
      before: before && copyFile(before),
      after: copyFile(file),
      writeAuthorFingerprint: authorFingerprint,
    };
    file.momentLog.push(internal);
    version.files.set(path, file);
    state.moments.set(resolvedMomentId, internal);
    const result: JsonObject = {
      object: this.fileObject(workspace, effectiveObjectId, now),
      snapshot: this.textSnapshot(workspace, version.id, path, file),
      moment: this.capMoment(moment),
      deduped: false,
    };
    this.recordReplay(state, requestId, params, result, replayFingerprint);
    return result;
  }

  private textRead(state: WorkspaceState, workspace: string, params: JsonObject): JsonValue {
    const path = normalizedEnginePath(
      requiredString(params, "path", "text read"),
      "addressable",
    );
    const version = this.version(state, requiredString(params, "versionId", "text read"));
    const file = version.files.get(path);
    if (!file) return null;

    const metadata = this.snapshotMetadata(workspace, version.id, path, file);
    if (file.contentKind === "binary") {
      return {
        ...metadata,
        text: "",
        blobSha256: file.binarySha ?? sha256([]),
      };
    }

    const text = file.text ?? "";
    if (utf8Length(text) > MAX_DESKTOP_CAPTURE_TEXT_BYTES) {
      return {
        ...metadata,
        text: null,
        blobSha256: sha256(text),
        inbandLimitBytes: MAX_DESKTOP_CAPTURE_TEXT_BYTES,
      };
    }
    return { ...metadata, text, blobSha256: sha256(text) };
  }

  /**
   * The text body behind a digest this workspace still references — a head, a
   * fork base, or a moment payload. The daemon authorizes a `readBlob` digest
   * the same way (`read_text_blob_with_hydration`, store.rs), so a fixture
   * that answered any digest would pin nothing about the request sent.
   *
   * Public because a body past the 48 KiB egress cap never rides in the
   * result: a harness that speaks the blob capability has to deliver those
   * bytes out of band, and this is where it reads them.
   */
  textBodyForDigest(workspace: string, sha256Hex: string): string | null {
    const digest = sha256Hex.toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(digest)) return null;
    return this.bodyForDigest(this.workspace(workspace), digest);
  }

  private bodyForDigest(state: WorkspaceState, digest: string): string | null {
    const candidates: string[] = [];
    for (const version of state.versions.values()) {
      for (const file of version.files.values()) {
        if (file.contentKind === "text") candidates.push(file.text ?? "");
      }
      for (const file of version.textForkBase.values()) {
        if (file.contentKind === "text") candidates.push(file.text ?? "");
      }
    }
    for (const moment of state.moments.values()) {
      if (moment.before?.contentKind === "text") candidates.push(moment.before.text ?? "");
      if (moment.after?.contentKind === "text") candidates.push(moment.after.text ?? "");
    }
    return candidates.find((candidate) => sha256(candidate) === digest) ?? null;
  }

  private textReadBlob(state: WorkspaceState, params: JsonObject): JsonValue {
    const digest = requiredString(params, "sha256", "text readBlob").toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(digest)) throw new Error("invalid-input");
    const text = this.bodyForDigest(state, digest);
    if (text === null) throw new Error("file-not-found");
    const bytes = [...Buffer.from(text, "utf8")];
    return bytes.length <= INBAND_LIMIT_BYTES
      ? { bytesBase64: encodeBase64(bytes) }
      : {
          bytesBase64: null,
          byteLength: bytes.length,
          inbandLimitBytes: INBAND_LIMIT_BYTES,
        };
  }

  private binaryWrite(
    state: WorkspaceState,
    workspace: string,
    params: JsonObject,
    parsed: ParsedBinaryWriteFields,
    allowFullRange = false,
  ): JsonValue {
    const { versionId } = parsed;
    const rawBytes = parsed.bytes;
    const rawBase64 = parsed.bytesBase64;
    let bytes: number[];
    if (Array.isArray(rawBytes) && rawBase64 === undefined) {
      bytes = [...rawBytes];
    } else if (typeof rawBase64 === "string" && rawBytes === undefined) {
      bytes = decodeBase64(rawBase64);
    } else {
      throw new Error("invalid-input");
    }
    if (!allowFullRange && bytes.length > INBAND_LIMIT_BYTES) {
      throw new Error("content-exceeds-inband-cap");
    }
    const origin = requiredOrigin(params);
    // The daemon decodes and caps bytes before it validates metadata.
    const metadata = this.momentMetadataFields(params);
    const addressablePath = normalizedEnginePath(parsed.path, "addressable");
    if (parsed.momentId !== undefined) validateTextMomentId(parsed.momentId);
    const path = normalizedEnginePath(addressablePath, "storable");
    // A refused fresh-main write must not create main. Existing equal binary
    // heads dedupe before Rust reaches the empty-object validation below.
    if (parsed.objectId === "" && versionId === "main" && !state.versions.has(versionId)) {
      throw new Error("invalid-input");
    }
    const version = this.mutationVersion(state, workspace, versionId);
    const requestId = parsed.requestId;
    const objectId = parsed.objectId ??
      (requestId !== undefined
        ? this.generatedWriteId("object", requestId, parsed.path)
        : version.files.get(path)?.objectId ?? `object-${this.nextObjectId++}`);
    const momentId = parsed.momentId ??
      (requestId !== undefined
        ? this.generatedWriteId("moment", requestId, parsed.path)
        : `moment-${this.nextMomentId++}`);
    const replayFingerprint = this.binaryWriteFingerprint(
      workspace,
      { ...params, path },
      bytes,
      origin,
      objectId,
      momentId,
    );
    const replay = this.replay(state, requestId, params, replayFingerprint);
    if (replay) {
      return {
        ...replay,
        materializeEnqueued: false,
        materialized: false,
        materializeOutcome: "skipped",
      };
    }
    const before = version.files.get(path);
    const binarySha = sha256(bytes);
    // Daemon parity: writing the SAME bytes over an equal binary head is a
    // content-equality dedup — no new moment, no materialization work.
    if (before?.contentKind === "binary" && before.binarySha === binarySha) {
      const headMoment = state.moments.get(before.latestMomentId);
      if (!headMoment) throw new Error("state-corrupt");
      const result: JsonObject = {
        object: this.fileObject(workspace, before.objectId, before.updatedAtMs),
        snapshot: {
          objectId: before.objectId,
          path,
          contentKind: "binary",
          text: "",
          sha256: binarySha,
          byteLength: bytes.length,
          workspaceId: workspace,
          versionId: version.id,
          updatedAtMs: before.updatedAtMs,
          latestMomentId: before.latestMomentId,
          metadataOrigin: before.metadataOrigin,
        },
        moment: this.capMoment(headMoment.wire),
        deduped: true,
        materializeEnqueued: false,
        materialized: false,
        materializeOutcome: "skipped",
      };
      this.recordReplay(state, requestId, params, result, replayFingerprint);
      return result;
    }
    if (parsed.objectId === "") throw new Error("invalid-input");
    this.assertFreshMoment(state, momentId);
    // Daemon parity: an existing head keeps its object identity.
    const effectiveObjectId = before?.objectId ?? objectId;
    const now = parsed.nowMs ?? this.clock++;
    const file: LoopbackFile = {
      objectId: effectiveObjectId,
      contentKind: "binary",
      bytes,
      binarySha,
      updatedAtMs: now,
      latestMomentId: momentId,
      metadataOrigin: origin,
      momentLog: before ? [...before.momentLog] : [],
    };
    const moment = this.makeMoment(
      version,
      path,
      momentId,
      "write",
      file,
      before,
      now,
      metadata,
    );
    const internal = { wire: moment, before: before && copyFile(before), after: copyFile(file) };
    file.momentLog.push(internal);
    version.files.set(path, file);
    state.moments.set(momentId, internal);
    state.blobs.set(binarySha, [...bytes]);
    const materializeEnqueued = version.id === state.activeVersionId;
    const result: JsonObject = {
      object: this.fileObject(workspace, effectiveObjectId, now),
      snapshot: {
        objectId: effectiveObjectId,
        path,
        contentKind: "binary",
        text: "",
        sha256: binarySha,
        byteLength: bytes.length,
        updatedAtMs: now,
        latestMomentId: momentId,
      },
      moment: this.capMoment(moment),
      deduped: false,
      materializeEnqueued,
      materialized: materializeEnqueued,
      materializeOutcome: materializeEnqueued ? "applied" : "skipped",
    };
    this.recordReplay(state, requestId, params, result, replayFingerprint);
    return result;
  }

  private binaryWriteBlob(
    state: WorkspaceState,
    workspace: string,
    params: JsonObject,
    parsed: ParsedBinaryBlobWriteFields,
  ): JsonValue {
    const expectedSha = parsed.sha256.toLowerCase();
    const encoded = parsed.bytesBase64;
    if (!/^[0-9a-f]{64}$/.test(expectedSha)) throw new Error("invalid-input");
    // The blob handler validates origin, metadata AND author before it decodes
    // or looks up the bytes (lib.rs versionedBinary.writeBlob: origin, metadata,
    // validated_author, then the decode), the OPPOSITE order from
    // versionedBinary.write, which decodes first. So a request wrong in both ways
    // answers for the metadata or author here and for the bytes there.
    //
    // All three, not two: an earlier version of this comment claimed author was
    // validated here while only origin and metadata were, so a malformed author
    // plus a missing blob still answered `file-not-found`. binaryWrite re-derives
    // all of them; these calls exist purely for the refusal order.
    requiredOrigin(params);
    this.momentMetadataFields(params);
    const bytes =
      encoded === undefined
        ? state.blobs.get(expectedSha)
        : decodeBase64(encoded);
    if (bytes === undefined) throw new Error("file-not-found");
    if (encoded !== undefined && bytes.length > MAX_CAPTURE_BINARY_FILE_BYTES) {
      throw new Error("content-exceeds-capture-cap");
    }
    if (sha256(bytes) !== expectedSha) throw new Error("invalid-input");
    const writeParams: JsonObject = { ...params, bytesBase64: encodeBase64(bytes) };
    delete writeParams.sha256;
    const binaryParsed: ParsedBinaryWriteFields = {
      ...parsed,
      bytesBase64: encodeBase64(bytes),
    };
    return this.binaryWrite(
      state,
      workspace,
      writeParams,
      binaryParsed,
      true,
    );
  }

  private textRename(
    state: WorkspaceState,
    workspace: string,
    params: JsonObject,
    parsed: ParsedTextRenameFields,
  ): JsonValue {
    const { versionId, requestId, nowMs } = parsed;
    const origin = requiredOrigin(params);
    const metadata = this.momentMetadataFields(params);
    const fromPath = normalizedEnginePath(parsed.fromPath, "addressable");
    const toAddressablePath = normalizedEnginePath(parsed.toPath, "addressable");
    const toPath = normalizedEnginePath(toAddressablePath, "storable");
    if (fromPath === toPath) throw new Error("invalid-path");
    const version = this.version(state, versionId);
    const momentId = requestId !== undefined
      ? this.generatedRequestId("moment", requestId, parsed.toPath)
      : `moment-${this.nextMomentId++}`;
    const fingerprint = this.renameFingerprint(
      workspace,
      { ...params, fromPath, toPath },
      origin,
      momentId,
    );
    const replay = this.replay(state, requestId, params, fingerprint);
    if (replay) return replay;
    const before = this.file(version, fromPath);
    const occupied = version.files.get(toPath);
    if (occupied && occupied.objectId !== before.objectId) {
      throw new Error("target-path-exists");
    }
    this.assertFreshMoment(state, momentId);
    const now = nowMs ?? this.clock++;
    const after: LoopbackFile = {
      ...copyFile(before),
      updatedAtMs: now,
      latestMomentId: momentId,
      metadataOrigin: origin,
    };
    const moment = this.makeMoment(
      version,
      toPath,
      momentId,
      "rename",
      after,
      before,
      now,
      metadata,
      fromPath,
    );
    const internal = {
      wire: moment,
      before: copyFile(before),
      after: copyFile(after),
      beforePath: fromPath,
    };
    after.momentLog.push(internal);
    version.files.delete(fromPath);
    version.files.set(toPath, after);
    state.moments.set(momentId, internal);
    const result: JsonObject = {
      object: this.fileObject(workspace, after.objectId, now),
      before: this.snapshotMetadata(workspace, version.id, fromPath, before),
      after: this.snapshotMetadata(workspace, version.id, toPath, after),
      moment: this.capMoment(moment),
      deduped: false,
    };
    this.recordReplay(state, requestId, params, result, fingerprint);
    return result;
  }

  private textDelete(
    state: WorkspaceState,
    workspace: string,
    params: JsonObject,
    parsed: ParsedTextDeleteFields,
  ): JsonValue {
    const { versionId, requestId, nowMs } = parsed;
    const origin = requiredOrigin(params);
    const metadata = this.momentMetadataFields(params);
    const path = normalizedEnginePath(parsed.path, "addressable");
    const version = this.version(state, versionId);
    const momentId = requestId !== undefined
      ? this.generatedRequestId("moment", requestId, parsed.path)
      : `moment-${this.nextMomentId++}`;
    const fingerprint = this.deleteFingerprint(
      workspace,
      { ...params, path },
      origin,
      momentId,
    );
    const replay = this.replay(state, requestId, params, fingerprint);
    if (replay) return replay;
    const before = this.file(version, path);
    this.assertFreshMoment(state, momentId);
    const now = nowMs ?? this.clock++;
    // The removed content, not an empty tombstone: a delete moment repeats it
    // on the after side (store.rs `delete_text_in_tx`, the `?8` params).
    const removed: LoopbackFile = {
      ...copyFile(before),
      updatedAtMs: now,
      latestMomentId: momentId,
      metadataOrigin: origin,
    };
    const moment = this.makeMoment(
      version,
      path,
      momentId,
      "delete",
      removed,
      before,
      now,
      metadata,
    );
    const internal = { wire: moment, before: copyFile(before) };
    state.moments.set(momentId, internal);
    version.files.delete(path);
    const result: JsonObject = {
      object: this.fileObject(workspace, before.objectId, now),
      before: this.snapshotMetadata(workspace, version.id, path, before),
      moment: this.capMoment(moment),
      deduped: false,
    };
    this.recordReplay(state, requestId, params, result, fingerprint);
    return result;
  }

  private textRollback(
    state: WorkspaceState,
    workspace: string,
    params: JsonObject,
    request: Request,
  ): JsonValue {
    const path = normalizedEnginePath(
      requiredString(params, "path", "rollback"),
      "addressable",
    );
    const origin = requiredOrigin(params);
    const authorJson = this.writeAuthorFingerprint(params);
    const requestId =
      serdeOptionalString(params, "requestId") ?? requestIdempotencyKey(request);
    const fingerprint = JSON.stringify({
      workspaceId: workspace,
      versionId: params.versionId,
      path,
      mutationMomentId: params.mutationMomentId,
      legacyBeforeText: params.legacyBeforeText ?? null,
      metadataOrigin: origin,
      authorJson,
    });
    const replay = this.replay(state, requestId, params, fingerprint);
    if (replay) {
      return {
        ...replay,
        materializeEnqueued: false,
        materialized: false,
        materializeOutcome: "skipped",
      };
    }
    const version = this.version(state, requiredString(params, "versionId", "rollback"));
    const mutationId = requiredString(params, "mutationMomentId", "rollback");
    const mutation = state.moments.get(mutationId);
    if (
      !mutation ||
      mutation.wire.versionId !== version.id ||
      mutation.wire.path !== path
    ) {
      throw new Error("file-not-found");
    }
    const superseded = [...state.moments.values()].some(
      (candidate) =>
        candidate.wire.versionId === version.id &&
        candidate.wire.objectId === mutation.wire.objectId &&
        candidate.wire.momentOrder > mutation.wire.momentOrder,
    );
    if (superseded) throw new Error("invalid-input");
    const forkPointDependent = [...state.versions.values()].some(
      (candidate) =>
        candidate.kind === "named" &&
        candidate.forkVersionId === version.id &&
        candidate.forkMomentId === mutationId,
    );
    if (forkPointDependent) throw new Error("invalid-input");
    const materializeEnqueued =
      mutation.wire.operation === "write" &&
      mutation.wire.afterContentKind === "binary" &&
      version.id === state.activeVersionId;
    version.files.delete(path);
    const restorePath = mutation.wire.operation === "rename"
      ? mutation.beforePath ?? path
      : path;
    if (mutation.before) version.files.set(restorePath, copyFile(mutation.before));
    state.moments.delete(mutationId);
    // Daemon parity: the rolled-back mutation's request-ledger row is deleted
    // too, so a retry of its requestId re-executes instead of replaying.
    for (const [ledgerRequestId, entry] of state.replays) {
      const moment = entry.result.moment;
      if (
        moment !== null &&
        typeof moment === "object" &&
        !Array.isArray(moment) &&
        (moment as JsonObject).momentId === mutationId
      ) {
        state.replays.delete(ledgerRequestId);
      }
    }
    const result: JsonObject = {
      rolledBack: true,
      deduped: false,
      materializeEnqueued,
      materialized: materializeEnqueued,
      materializeOutcome: materializeEnqueued ? "applied" : "skipped",
    };
    this.recordReplay(state, requestId, params, result, fingerprint);
    return result;
  }

  private textList(state: WorkspaceState, params: JsonObject): JsonValue {
    const version = this.version(state, requiredString(params, "versionId", "list"));
    const afterPath = optionalString(params, "afterPath");
    const limit = Math.min(500, Math.max(1, optionalNumber(params, "limit") ?? 200));
    const files = [...version.files.entries()]
      .filter(([path]) => afterPath === undefined || path > afterPath)
      .sort(([left], [right]) => comparePaths(left, right));
    const page = files.slice(0, limit);
    return {
      files: page.map(([path, file]) => ({
        path,
        objectId: file.objectId,
        contentKind: file.contentKind,
        sha256:
          file.contentKind === "binary"
            ? file.binarySha ?? sha256([])
            : sha256(file.text ?? ""),
        byteLength:
          file.contentKind === "text"
            ? utf8Length(file.text ?? "")
            : file.bytes?.length ?? 0,
        binarySha256: file.binarySha ?? null,
        updatedAtMs: file.updatedAtMs,
        latestMomentId: file.latestMomentId,
        metadataOrigin: file.metadataOrigin,
        // The loopback has no Y.Doc lineage of its own; a settle-owned path
        // is modelled by the ydoc loopback engine, not this one.
        hasYdocMarker: false,
      })),
      nextAfterPath: files.length > page.length ? page.at(-1)?.[0] ?? null : null,
    };
  }

  private binaryRead(state: WorkspaceState, params: JsonObject): JsonValue {
    const path = normalizedEnginePath(
      requiredString(params, "path", "binary read"),
      "addressable",
    );
    const version = this.version(state, requiredString(params, "versionId", "binary read"));
    const file = version.files.get(path);
    if (!file) return null;
    if (file.contentKind !== "binary" || !file.bytes || !file.binarySha) {
      return null;
    }
    return file.bytes.length <= INBAND_LIMIT_BYTES
      ? {
          objectId: file.objectId,
          sha256: file.binarySha,
          byteLength: file.bytes.length,
          bytesBase64: encodeBase64(file.bytes),
        }
      : {
          objectId: file.objectId,
          sha256: file.binarySha,
          byteLength: file.bytes.length,
          bytesBase64: null,
          inbandLimitBytes: INBAND_LIMIT_BYTES,
        };
  }

  private binaryReadBlob(state: WorkspaceState, params: JsonObject): JsonValue {
    const digest = requiredString(params, "sha256", "readBlob").toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(digest)) throw new Error("invalid-input");
    // Daemon parity: only workspace-REFERENCED digests are served — a rolled-
    // back mutation's orphaned bytes answer file-not-found like the daemon's
    // reference gate.
    const referenced =
      [...state.versions.values()].some((version) =>
        [...version.files.values()].some((file) => file.binarySha === digest),
      ) ||
      [...state.moments.values()].some(
        (moment) =>
          moment.wire.afterBinarySha256 === digest ||
          moment.wire.beforeBinarySha256 === digest,
      );
    if (!referenced) throw new Error("file-not-found");
    const bytes = state.blobs.get(digest);
    if (!bytes) throw new Error("file-not-found");
    return bytes.length <= INBAND_LIMIT_BYTES
      ? { bytesBase64: encodeBase64(bytes) }
      : { bytesBase64: null, byteLength: bytes.length, inbandLimitBytes: INBAND_LIMIT_BYTES };
  }

  private createNamed(
    state: WorkspaceState,
    workspace: string,
    params: JsonObject,
    request: Request,
  ): JsonValue {
    const from = this.version(state, requiredString(params, "fromVersionId", "createNamed"));
    const name = requiredString(params, "name", "createNamed");
    const requestId = request.idempotencyKey ?? undefined;
    const fingerprint = JSON.stringify({
      name,
      fromVersionId: from.id,
    });
    const replay = this.replay(state, requestId, params, fingerprint, false);
    if (replay) return replay;
    if ([...state.versions.values()].some((version) => version.name === name)) {
      throw new Error("version-name-conflict");
    }
    const id = `version-${this.nextVersionId++}`;
    const version: LoopbackVersion = {
      id,
      workspaceId: workspace,
      kind: "named",
      name,
      createdAtMs: this.clock++,
      forkVersionId: from.id,
      forkMomentId: this.latestMomentId(state, from.id),
      files: new Map([...from.files].map(([path, file]) => [path, copyFile(file)])),
      textForkBase: new Map([...from.files].map(([path, file]) => [path, copyFile(file)])),
      secrets: new Map(from.secrets),
      secretForkBase: new Map(from.secrets),
    };
    state.versions.set(id, version);
    const result = this.versionJson(version);
    this.recordReplay(state, requestId, params, result, fingerprint);
    return result;
  }

  private versionsList(state: WorkspaceState, params: JsonObject): JsonValue {
    const afterVersionId = optionalString(params, "afterVersionId");
    const versions = [...state.versions.values()].sort(
      (left, right) =>
        left.createdAtMs - right.createdAtMs ||
        left.name.localeCompare(right.name) ||
        left.id.localeCompare(right.id),
    );
    const afterIndex = afterVersionId === undefined
      ? -1
      : versions.findIndex((version) => version.id === afterVersionId);
    const page = afterIndex >= 0 ? versions.slice(afterIndex + 1) : versions;
    return {
      versions: page.map((version) => ({
        versionId: version.id,
        kind: version.kind,
        name: version.name,
        createdAtMs: version.createdAtMs,
        forkVersionId: version.forkVersionId ?? null,
        forkMomentId: version.forkMomentId ?? null,
      })),
      nextAfterVersionId: null,
    };
  }

  private setActive(state: WorkspaceState, params: JsonObject): JsonValue {
    const version = this.version(state, requiredString(params, "versionId", "setActive"));
    state.activeVersionId = version.id;
    state.versioned = true;
    return this.versionJson(version);
  }

  private comparisonRecord(
    workspace: string,
    path: string,
    target: LoopbackVersion,
    source: LoopbackVersion,
  ): JsonObject {
    const incoming = source.files.get(path);
    const current = target.files.get(path);
    const base = source.textForkBase.get(path);
    const status = this.filesEqual(current, incoming)
      ? "same"
      : this.filesEqual(current, base)
        ? "incoming-changed"
        : this.filesEqual(incoming, base)
          ? "current-changed"
          : "diverged";
    return {
      workspaceId: workspace,
      path,
      targetVersionId: target.id,
      sourceVersionId: source.id,
      base: base
        ? this.comparisonState(workspace, source.id, path, base)
        : null,
      current: current
        ? this.comparisonState(workspace, target.id, path, current)
        : null,
      incoming: incoming
        ? this.comparisonState(workspace, source.id, path, incoming)
        : null,
      status,
    };
  }

  private compare(
    state: WorkspaceState,
    workspace: string,
    params: JsonObject,
  ): JsonValue {
    const path = requiredString(params, "path", "compare");
    validateRustPathFloor(path);
    const source = this.version(state, requiredString(params, "sourceVersionId", "compare"));
    const target = this.version(state, requiredString(params, "targetVersionId", "compare"));
    return this.comparisonRecord(workspace, path, target, source);
  }

  private merge(
    state: WorkspaceState,
    workspace: string,
    params: JsonObject,
    request: Request,
  ): JsonValue {
    const origin = requiredOrigin(params);
    // Before every replay/dedup/unchanged return — see metadataField.
    const metadata = this.momentMetadataFields(params);
    const requestId =
      serdeOptionalString(params, "requestId") ?? requestIdempotencyKey(request);
    const sourceVersionId = requiredString(params, "sourceVersionId", "merge");
    const targetVersionId = requiredString(params, "targetVersionId", "merge");
    const path = requiredString(params, "path", "merge");
    // Rust merge validates the addressable-path classification without
    // normalizing the lookup key. Run that check before generated ids and
    // request replay, then keep the caller's raw path below.
    normalizedEnginePath(path, "addressable");
    const objectId = requestId !== undefined
      ? this.generatedRequestId("object", requestId, path)
      : `object-${this.nextObjectId++}`;
    const momentId = requestId !== undefined
      ? this.generatedRequestId("moment", requestId, path)
      : `moment-${this.nextMomentId++}`;
    const conflictId = requestId !== undefined
      ? this.generatedRequestId("conflict", requestId, path)
      : `conflict-${this.nextMomentId++}`;
    const fingerprint = this.mergeFingerprint(
      workspace,
      params,
      origin,
      objectId,
      momentId,
      conflictId,
    );
    const replay = this.replay(state, requestId, params, fingerprint);
    if (replay) {
      return {
        ...replay,
        materializeEnqueued: false,
        materialized: false,
        materializeOutcome: "skipped",
      };
    }
    const source = this.version(state, sourceVersionId);
    const target = this.version(state, targetVersionId);
    if (source.kind !== "named" || source.forkVersionId !== target.id) {
      throw new Error("fork-base-not-found");
    }
    const incoming = source.files.get(path);
    const current = target.files.get(path);
    const base = source.textForkBase.get(path);
    const comparison = this.comparisonRecord(workspace, path, target, source);
    // WS-G1: the fast-forward writes a side through the TEXT seam, so both LIVE
    // sides must be text. The base does not gate it — a binary base can never
    // compare equal to a text current. The line merge below reads all three, and
    // its own kind check keeps a binary ancestor out.
    const liveSidesBinary =
      incoming?.contentKind === "binary" || current?.contentKind === "binary";
    if (this.filesEqual(incoming, current)) {
      const result: JsonObject = {
        status: "unchanged",
        reason: "already-same",
        comparison,
        deduped: false,
        materializeEnqueued: false,
        materialized: false,
        materializeOutcome: "skipped",
      };
      this.recordReplay(state, requestId, params, result, fingerprint);
      return result;
    }
    if (this.filesEqual(incoming, base)) {
      const result: JsonObject = {
        status: "unchanged",
        reason: "source-unchanged",
        comparison,
        deduped: false,
        materializeEnqueued: false,
        materialized: false,
        materializeOutcome: "skipped",
      };
      this.recordReplay(state, requestId, params, result, fingerprint);
      return result;
    }
    let textToWrite = incoming?.text;
    // A source-only BINARY change fast-forwards through the binary seam:
    // current equals base by content ADDRESS (a binary side never compares
    // equal to a text one), so only the source moved. A removal keeps its
    // conflict — that seam is the text delete.
    const binaryFastForward =
      incoming?.contentKind === "binary" && this.filesEqual(current, base);
    if (!binaryFastForward && (liveSidesBinary || !this.filesEqual(current, base))) {
      const cleanMerge =
        base?.contentKind === "text" &&
        current?.contentKind === "text" &&
        incoming?.contentKind === "text"
          ? mergeMarkdown(base.text ?? "", current.text ?? "", incoming.text ?? "")
          : { status: "conflict" as const };
      if (cleanMerge.status === "merged") {
        textToWrite = cleanMerge.text;
      } else {
        const result: JsonObject = {
          status: "conflict",
          conflictId,
          comparison,
          deduped: false,
          materializeEnqueued: false,
          materialized: false,
          materializeOutcome: "skipped",
        };
        this.recordReplay(state, requestId, params, result, fingerprint);
        return result;
      }
    }
    const materializeEnqueued = target.id === state.activeVersionId;
    if (!incoming) {
      const before = this.file(target, path);
      const now = optionalNumber(params, "nowMs") ?? this.clock++;
      // The removed content, as the delete moment's after side (see the delete
      // handler above).
      const removed: LoopbackFile = {
        ...copyFile(before),
        updatedAtMs: now,
        latestMomentId: momentId,
        metadataOrigin: origin,
      };
      const moment = this.makeMoment(
        target,
        path,
        momentId,
        "delete",
        removed,
        before,
        now,
        metadata,
      );
      const internal: InternalMoment = { wire: moment, before: copyFile(before) };
      target.files.delete(path);
      state.moments.set(momentId, internal);
      const result: JsonObject = {
        status: "merged",
        writeKind: "delete",
        object: this.fileObject(workspace, before.objectId, now),
        before: this.snapshotMetadata(workspace, target.id, path, before),
        moment: this.capMoment(moment),
        comparison,
        deduped: false,
        materializeEnqueued,
        materialized: materializeEnqueued,
        materializeOutcome: materializeEnqueued ? "applied" : "skipped",
      };
      this.recordReplay(state, requestId, params, result, fingerprint);
      return result;
    }
    const before = target.files.get(path);
    const now = optionalNumber(params, "nowMs") ?? this.clock++;
    const copied: LoopbackFile = {
      ...copyFile(incoming),
      text: textToWrite,
      // Daemon parity: a path that already exists in the target keeps its
      // object identity; the source id binds only NEW target paths.
      objectId: before?.objectId ?? objectId,
      updatedAtMs: now,
      latestMomentId: momentId,
      metadataOrigin: origin,
    };
    const moment = this.makeMoment(
      target,
      path,
      momentId,
      "write",
      copied,
      before,
      now,
      metadata,
    );
    const internal: InternalMoment = {
      wire: moment,
      before: before && copyFile(before),
      after: copyFile(copied),
    };
    copied.momentLog.push(internal);
    target.files.set(path, copied);
    state.moments.set(momentId, internal);
    const result: JsonObject = {
      status: "merged",
      writeKind: copied.contentKind === "binary" ? "binary-write" : "write",
      object: this.fileObject(workspace, copied.objectId, now),
      snapshot: this.snapshotMetadata(workspace, target.id, path, copied),
      moment: this.capMoment(moment),
      comparison,
      deduped: false,
      materializeEnqueued,
      materialized: materializeEnqueued,
      materializeOutcome: materializeEnqueued ? "applied" : "skipped",
    };
    this.recordReplay(state, requestId, params, result, fingerprint);
    return result;
  }

  private compareFiles(state: WorkspaceState, params: JsonObject): JsonValue {
    const source = this.version(state, requiredString(params, "sourceVersionId", "compareFiles"));
    const target = this.version(state, requiredString(params, "targetVersionId", "compareFiles"));
    const afterPath = optionalString(params, "afterPath");
    const paths = [...new Set([...source.files.keys(), ...target.files.keys()])]
      .filter((path) => afterPath === undefined || path > afterPath)
      .sort(comparePaths);
    const scannedPaths = paths.slice(0, COMPARE_PAGE_SIZE);
    const changes = scannedPaths.flatMap((path) => {
      const sourceFile = source.files.get(path);
      const targetFile = target.files.get(path);
      if (this.filesEqual(sourceFile, targetFile)) return [];
      const status: VersionChangeStatus = !targetFile ? "added" : !sourceFile ? "deleted" : "modified";
      const entry: JsonObject = { path, status };
      if (sourceFile?.contentKind === "binary" || targetFile?.contentKind === "binary") entry.binary = true;
      return [entry];
    });
    let included = changes.length;
    const budget = Math.max(1, optionalNumber(params, "byteBudget") ?? Number.MAX_SAFE_INTEGER);
    // Daemon parity: the byte-budget cut has a PROGRESS GUARANTEE — the first
    // row always ships under a tiny budget (only the hard frame cap refuses).
    while (included > 1 && Buffer.byteLength(JSON.stringify(changes.slice(0, included))) > budget) included -= 1;
    const entries = changes.slice(0, included);
    const nextCursor = included < changes.length
      ? (entries.at(-1)?.path as string | undefined) ?? null
      : scannedPaths.length === COMPARE_PAGE_SIZE
        ? scannedPaths.at(-1) ?? null
        : null;
    return { entries, nextCursor };
  }

  // Parsed BEFORE any no-op check or mutation. `optionalString` throws on a
  // non-string, and evaluating it inside the makeSecretMoment call meant the
  // secret had already changed while the caller got a refusal and no moment —
  // the daemon refuses a malformed request atomically, before touching state.
  private secretMomentMetadata(params: JsonObject): {
    summary: string | null;
    correlationId: string | null;
  } {
    // Same validation as every other write path; secret moments just spell
    // "absent" as null rather than by omitting the field.
    return {
      summary: metadataField(params, "summary") ?? null,
      correlationId: metadataField(params, "correlationId") ?? null,
    };
  }

  private secretWrite(
    state: WorkspaceState,
    workspace: string,
    params: JsonObject,
    parsed: ParsedSecretWriteFields,
  ): JsonValue {
    const { versionId, text, momentId } = parsed;
    if (utf8Length(text) > MAX_SECRET_FILE_BYTES) {
      throw new Error("content-exceeds-inband-cap");
    }
    const origin = requiredOrigin(params);
    const metadata = this.secretMomentMetadata(params);
    const path = normalizedSecretPath(parsed.path);
    const version = state.versions.get(versionId);
    if (!version) throw new Error("invalid-version");
    validateSecretMomentId(momentId);
    const before = version.secrets.get(path);
    if (before === text) return { changed: false, moment: null };
    this.assertFreshSecretMoment(state, momentId);
    version.secrets.set(path, text);
    const wire = this.makeSecretMoment(
      workspace,
      version.id,
      path,
      momentId,
      "write",
      origin,
      metadata.summary,
      metadata.correlationId,
    );
    state.secretMoments.set(momentId, { wire, before, after: text });
    return { changed: true, moment: wire };
  }

  private secretList(state: WorkspaceState, params: JsonObject): JsonValue {
    const versionId = requiredString(params, "versionId", "secret list");
    const version = state.versions.get(versionId);
    if (!version) throw new Error("invalid-version");
    const afterPath = optionalString(params, "afterPath");
    const limit = Math.min(500, Math.max(1, optionalNumber(params, "limit") ?? 200));
    const entries = [...version.secrets.entries()]
      .filter(([path]) => afterPath === undefined || path > afterPath)
      .sort(([left], [right]) => left.localeCompare(right));
    const page = entries.slice(0, limit);
    return {
      secrets: page.map(([path, text]) => {
        const moment = this.latestSecretMoment(state, version.id, path, text);
        return {
          path,
          byteLength: utf8Length(text),
          updatedAtMs: moment.recordedAtMs,
          latestMomentId: moment.id,
        };
      }),
      nextAfterPath: entries.length > page.length ? page.at(-1)?.[0] ?? null : null,
    };
  }

  private secretMaterialize(state: WorkspaceState, params: JsonObject): JsonValue {
    const path = normalizedSecretPath(
      requiredString(params, "path", "secret materialize"),
    );
    const versionId = requiredString(params, "versionId", "secret materialize");
    const version = state.versions.get(versionId);
    if (!version) throw new Error("invalid-version");
    const text = version.secrets.get(path);
    if (text === undefined) return null;
    const byteLength = utf8Length(text);
    return byteLength <= MAX_SECRET_FILE_BYTES
      ? { text }
      : { text: null, byteLength, inbandLimitBytes: MAX_SECRET_FILE_BYTES };
  }

  private secretDelete(
    state: WorkspaceState,
    workspace: string,
    params: JsonObject,
    parsed: ParsedSecretDeleteFields,
  ): JsonValue {
    const { versionId, momentId } = parsed;
    const origin = requiredOrigin(params);
    const metadata = this.secretMomentMetadata(params);
    validateSecretMomentId(momentId);
    const path = normalizedSecretPath(parsed.path);
    const version = state.versions.get(versionId);
    if (!version) throw new Error("invalid-version");
    const before = version.secrets.get(path);
    if (before === undefined) return { moment: null };
    this.assertFreshSecretMoment(state, momentId);
    version.secrets.delete(path);
    const wire = this.makeSecretMoment(
      workspace,
      version.id,
      path,
      momentId,
      "delete",
      origin,
      metadata.summary,
      metadata.correlationId,
    );
    state.secretMoments.set(momentId, { wire, before });
    return { moment: wire };
  }

  private secretFork(state: WorkspaceState, params: JsonObject): JsonValue {
    const from = this.version(state, requiredString(params, "fromVersionId", "secret fork"));
    const to = this.version(state, requiredString(params, "toVersionId", "secret fork"));
    to.secrets = new Map(from.secrets);
    to.secretForkBase = new Map(from.secrets);
    return {};
  }

  private secretCompare(state: WorkspaceState, params: JsonObject): JsonValue {
    const source = this.version(state, requiredString(params, "sourceVersionId", "secret compare"));
    const target = this.version(state, requiredString(params, "targetVersionId", "secret compare"));
    const after = optionalString(params, "afterPath");
    const limit = Math.min(500, Math.max(1, optionalNumber(params, "limit") ?? 200));
    const paths = [...new Set([...source.secrets.keys(), ...target.secrets.keys()])]
      .filter((path) => after === undefined || path > after)
      .filter((path) => source.secrets.get(path) !== target.secrets.get(path))
      .sort();
    const page = paths.slice(0, limit);
    return {
      entries: page.map((path) => ({
        path,
        status: !target.secrets.has(path) ? "added" : !source.secrets.has(path) ? "deleted" : "modified",
      })),
      nextAfterPath: paths.length > page.length ? page.at(-1) ?? null : null,
    };
  }

  private secretApply(state: WorkspaceState, workspace: string, params: JsonObject): JsonValue {
    const rawPath = requiredString(params, "path", "secret apply");
    const momentId = requiredString(params, "momentId", "secret apply");
    const origin = requiredOrigin(params);
    // Above both version lookups, which is safe here because `state.versions.get`
    // only reads — the #439 handlers use `mutationVersion`, which creates.
    const { summary, correlationId } = this.secretMomentMetadata(params);
    const source = state.versions.get(requiredString(params, "sourceVersionId", "secret apply"));
    const target = state.versions.get(requiredString(params, "targetVersionId", "secret apply"));
    if (!source || !target) throw new Error("invalid-version");
    validateSecretMomentId(momentId);
    const path = normalizedSecretPath(rawPath);
    const before = target.secrets.get(path);
    const after = source.secrets.get(path);
    const base = source.secretForkBase.get(path);
    if ((before === undefined && after === undefined) || before === after || after === base) {
      return { changed: false, moment: null };
    }
    this.assertFreshSecretMoment(state, momentId);
    if (after === undefined) target.secrets.delete(path);
    else target.secrets.set(path, after);
    const operation = after === undefined ? "delete" : "write";
    const wire = this.makeSecretMoment(
      workspace,
      target.id,
      path,
      momentId,
      operation,
      origin,
      summary,
      correlationId,
    );
    state.secretMoments.set(momentId, { wire, before, after });
    return { changed: true, moment: wire };
  }

  private secretRestore(state: WorkspaceState, workspace: string, params: JsonObject): JsonValue {
    const rawPath = requiredString(params, "path", "secret restore");
    const beforeMomentId = requiredString(params, "beforeMomentId", "secret restore");
    const momentId = requiredString(params, "momentId", "secret restore");
    // Origin then metadata, both before any state is read — the daemon's order
    // (secrets_restore: validated_origin, validate_metadata_fields, then the
    // source-moment lookup). Origin is REQUIRED on this request: the daemon takes
    // it as a non-Option field, so a restore without one is refused. The fake used
    // to ignore params.origin entirely and hardcode "restore" below, which made it
    // accept requests production rejects while a comment here claimed the ordering
    // was matched.
    // `origin` strictly, NOT via requiredOrigin: that helper falls back to the
    // legacy `metadataOrigin`, while SecretsRestoreParams requires `origin` and
    // denies unknown fields, so the fallback accepts a request the daemon rejects
    // at deserialization.
    const origin = restoreOrigin(params);
    const metadata = this.secretMomentMetadata(params);
    validateSecretMomentId(beforeMomentId);
    validateSecretMomentId(momentId);
    const path = normalizedSecretPath(rawPath);
    const sourceMoment = state.secretMoments.get(beforeMomentId);
    if (!sourceMoment) throw new Error("moment-not-found");
    if (sourceMoment.wire.path !== path) throw new Error("invalid-input");
    const version = this.version(state, sourceMoment.wire.versionId);
    const prior = version.secrets.get(path);
    if (prior === sourceMoment.before) {
      return {
        restored: sourceMoment.before === undefined ? "deleted" : "text",
        restoredMomentId: beforeMomentId,
        path,
      };
    }
    this.assertFreshSecretMoment(state, momentId);
    if (sourceMoment.before === undefined) version.secrets.delete(path);
    else version.secrets.set(path, sourceMoment.before);
    const operation = sourceMoment.before === undefined ? "delete" : "write";
    const wire = this.makeSecretMoment(
      workspace,
      version.id,
      path,
      momentId,
      operation,
      origin,
      metadata.summary,
      metadata.correlationId,
    );
    state.secretMoments.set(momentId, { wire, before: prior, after: sourceMoment.before });
    return { restored: sourceMoment.before === undefined ? "deleted" : "text", restoredMomentId: momentId, path };
  }

  private secretMomentsList(state: WorkspaceState, params: JsonObject): JsonValue {
    const rawPath = optionalString(params, "path");
    const path = rawPath === undefined ? undefined : normalizedSecretPath(rawPath);
    const versionId = optionalString(params, "versionId");
    // Daemon parity: a PRESENT but unknown versionId refuses invalid-version
    // (require_version inside the keyless domain query) instead of answering
    // an empty page.
    if (versionId !== undefined && !state.versions.has(versionId)) {
      throw new Error("invalid-version");
    }
    const before = optionalNumber(params, "beforeMomentOrder");
    const limit = Math.min(500, Math.max(1, optionalNumber(params, "limit") ?? 200));
    const filtered = [...state.secretMoments.values()]
      .map((moment) => moment.wire)
      .filter(
        (moment) =>
          (versionId === undefined || moment.versionId === versionId) &&
          (path === undefined || moment.path === path),
      )
      .filter((moment) => before === undefined || moment.momentOrder < before)
      .sort((left, right) => right.momentOrder - left.momentOrder);
    const page = filtered.slice(0, limit);
    return {
      moments: page,
      nextBeforeMomentOrder:
        filtered.length > page.length ? page.at(-1)?.momentOrder ?? null : null,
    };
  }

  private secretMomentsGet(state: WorkspaceState, params: JsonObject): JsonValue {
    return state.secretMoments.get(requiredString(params, "momentId", "secret moment get"))?.wire ?? null;
  }

  private momentsList(state: WorkspaceState, params: JsonObject): JsonValue {
    const versionId = optionalString(params, "versionId");
    const objectId = optionalString(params, "objectId");
    const before = optionalNumber(params, "beforeMomentOrder");
    // The daemon's moments.list caps at 500 and lets the DOMAIN refuse a
    // non-positive limit (oracle normalizeMomentListLimit contract);
    // secrets.moments.list clamps instead — endpoint-specific on purpose.
    const requestedLimit = optionalNumber(params, "limit");
    if (requestedLimit !== undefined && requestedLimit < 1) {
      throw new Error("invalid-input");
    }
    const limit = Math.min(500, requestedLimit ?? 200);
    if (versionId !== undefined && !state.versions.has(versionId)) {
      throw new Error("version-not-found");
    }
    const all = [...state.moments.values()]
      .map((moment) => moment.wire)
      .filter((moment) => versionId === undefined || moment.versionId === versionId)
      .filter((moment) => objectId === undefined || moment.objectId === objectId)
      .sort((left, right) => right.momentOrder - left.momentOrder);
    const filtered = all.filter((moment) => before === undefined || moment.momentOrder < before);
    const page = filtered.slice(0, limit);
    return {
      moments: page.map((moment) => this.capMoment(moment)),
      nextBeforeMomentOrder: filtered.length > page.length ? page.at(-1)?.momentOrder ?? null : null,
      latestMomentOrder: all[0]?.momentOrder ?? -1,
    };
  }

  private momentsGet(state: WorkspaceState, params: JsonObject): JsonValue {
    const moment = state.moments.get(requiredString(params, "momentId", "moment get"));
    return moment ? this.capMoment(moment.wire) : null;
  }

  private workspace(id: string): WorkspaceState {
    let state = this.workspaces.get(id);
    if (!state) {
      state = {
        versioned: false,
        versions: new Map(),
        moments: new Map(),
        secretMoments: new Map(),
        blobs: new Map(),
        replays: new Map(),
      };
      this.workspaces.set(id, state);
    }
    return state;
  }

  private ensureMain(state: WorkspaceState, workspace: string): LoopbackVersion {
    const existing = state.versions.get("main");
    if (existing) {
      state.versioned = true;
      state.activeVersionId ??= existing.id;
      return existing;
    }
    const main: LoopbackVersion = {
      id: "main",
      workspaceId: workspace,
      kind: "main",
      name: "Main",
      createdAtMs: this.clock++,
      files: new Map(),
      textForkBase: new Map(),
      secrets: new Map(),
      secretForkBase: new Map(),
    };
    state.versions.set(main.id, main);
    state.versioned = true;
    state.activeVersionId = main.id;
    return main;
  }

  // Call only after the handler completes daemon-parity validation. This may
  // create `main`; a refused mutation must leave `versions.list` empty.
  private mutationVersion(
    state: WorkspaceState,
    workspace: string,
    versionId: string,
  ): LoopbackVersion {
    if (versionId === "main" && !state.versions.has(versionId)) {
      return this.ensureMain(state, workspace);
    }
    return this.version(state, versionId);
  }

  private version(state: WorkspaceState, id: string): LoopbackVersion {
    const version = state.versions.get(id);
    // The engine's code, verbatim. A prose message here ("version not found")
    // read as a refusal but matched no domain code, so it looked correct and
    // translated to nothing.
    if (!version) throw new Error("version-not-found");
    return version;
  }

  private file(version: LoopbackVersion, path: string): LoopbackFile {
    const file = version.files.get(path);
    if (!file) throw new Error("file-not-found");
    return file;
  }

  private requireWorkspaceHandle(request: Request): string {
    if (typeof request.workspace !== "string") throw new Error("workspace unavailable");
    return request.workspace;
  }

  private validateWorkspaceParam(
    params: JsonObject,
    workspace: string,
  ): void {
    const candidate = serdeOptionalString(params, "workspaceId");
    if (candidate !== undefined && candidate !== workspace) throw new Error("invalid-workspace");
  }

  private assertFreshMoment(state: WorkspaceState, momentId: string): void {
    if (state.moments.has(momentId) || state.secretMoments.has(momentId)) {
      throw new Error("duplicate-id");
    }
  }

  private assertFreshSecretMoment(state: WorkspaceState, momentId: string): void {
    this.assertFreshMoment(state, momentId);
  }

  private replay(
    state: WorkspaceState,
    requestId: string | undefined,
    params: JsonObject,
    fingerprint = JSON.stringify(params),
    markDeduped = true,
  ): JsonObject | undefined {
    if (requestId === undefined) return undefined;
    const recorded = state.replays.get(requestId);
    if (!recorded) return undefined;
    if (recorded.fingerprint !== fingerprint) {
      throw new Error("idempotency-key-reuse-mismatch");
    }
    return markDeduped
      ? { ...recorded.result, deduped: true }
      : { ...recorded.result };
  }

  private recordReplay(
    state: WorkspaceState,
    requestId: string | undefined,
    params: JsonObject,
    result: JsonObject,
    fingerprint = JSON.stringify(params),
  ): void {
    if (requestId !== undefined) {
      state.replays.set(requestId, {
        fingerprint,
        result,
      });
    }
  }

  private textWriteFingerprint(
    params: JsonObject,
    origin: VersionedOrigin,
    objectId: string,
    momentId: string,
  ): string {
    return JSON.stringify({
      versionId: params.versionId,
      path: params.path,
      text: params.text,
      momentId,
      objectId,
      metadataOrigin: origin,
      metadataSummary: params.summary ?? null,
      metadataCorrelationId: params.correlationId ?? null,
      authorJson: this.writeAuthorFingerprint(params),
    });
  }

  private binaryWriteFingerprint(
    workspace: string,
    params: JsonObject,
    bytes: number[],
    origin: VersionedOrigin,
    objectId: string,
    momentId: string,
  ): string {
    return JSON.stringify({
      operation: "versioned-binary-write",
      workspaceId: workspace,
      versionId: params.versionId,
      path: params.path,
      sha256: sha256(bytes),
      momentId,
      objectId,
      metadataOrigin: origin,
      metadataSummary: params.summary ?? null,
      metadataCorrelationId: params.correlationId ?? null,
      authorJson: this.writeAuthorFingerprint(params),
    });
  }

  private renameFingerprint(
    workspace: string,
    params: JsonObject,
    origin: VersionedOrigin,
    momentId: string,
  ): string {
    return JSON.stringify({
      workspaceId: workspace,
      versionId: params.versionId,
      fromPath: params.fromPath,
      toPath: params.toPath,
      momentId,
      metadataOrigin: origin,
      metadataSummary: params.summary ?? null,
      metadataCorrelationId: params.correlationId ?? null,
      authorJson: this.writeAuthorFingerprint(params),
    });
  }

  private deleteFingerprint(
    workspace: string,
    params: JsonObject,
    origin: VersionedOrigin,
    momentId: string,
  ): string {
    return JSON.stringify({
      workspaceId: workspace,
      versionId: params.versionId,
      path: params.path,
      momentId,
      metadataOrigin: origin,
      metadataSummary: params.summary ?? null,
      metadataCorrelationId: params.correlationId ?? null,
      authorJson: this.writeAuthorFingerprint(params),
    });
  }

  private mergeFingerprint(
    workspace: string,
    params: JsonObject,
    origin: VersionedOrigin,
    objectId: string,
    momentId: string,
    conflictId: string,
  ): string {
    return JSON.stringify({
      workspaceId: workspace,
      targetVersionId: params.targetVersionId,
      sourceVersionId: params.sourceVersionId,
      path: params.path,
      momentId,
      objectId,
      conflictId,
      metadataOrigin: origin,
      authorJson: this.writeAuthorFingerprint(params),
    });
  }

  private writeAuthorFingerprint(params: JsonObject): string | null {
    this.validatedAuthorValue(params);
    if (params.author !== undefined && params.author !== null) {
      return stableJsonStringify(params.author);
    }
    const legacy = params.authorJson;
    if (typeof legacy !== "string") return null;
    try {
      return stableJsonStringify(JSON.parse(legacy) as JsonValue);
    } catch {
      return legacy;
    }
  }

  private generatedWriteId(prefix: "object" | "moment", requestId: string, path: string): string {
    return this.generatedRequestId(prefix, requestId, path);
  }

  private generatedRequestId(prefix: string, requestId: string, path: string): string {
    const digest = createHash("sha256");
    for (const field of [requestId, path]) {
      const bytes = Buffer.from(field, "utf8");
      const length = Buffer.alloc(8);
      length.writeBigUInt64LE(BigInt(bytes.length));
      digest.update(length);
      digest.update(bytes);
    }
    return `${prefix}-${digest.digest("hex")}`;
  }

  private fileObject(workspace: string, objectId: string, createdAtMs: number): JsonObject {
    return { id: objectId, workspaceId: workspace, createdAtMs };
  }

  private textSnapshot(workspace: string, versionId: string, path: string, file: LoopbackFile): JsonObject {
    const digest = sha256(file.text ?? "");
    return {
      workspaceId: workspace,
      versionId,
      objectId: file.objectId,
      path,
      text: file.text ?? "",
      contentKind: "text",
      sha256: digest,
      byteLength: utf8Length(file.text ?? ""),
      blobSha256: digest,
      updatedAtMs: file.updatedAtMs,
      latestMomentId: file.latestMomentId,
      metadataOrigin: file.metadataOrigin,
    };
  }

  private snapshotMetadata(workspace: string, versionId: string, path: string, file: LoopbackFile): JsonObject {
    return {
      workspaceId: workspace,
      versionId,
      objectId: file.objectId,
      path,
      contentKind: file.contentKind,
      sha256: file.contentKind === "binary" ? file.binarySha ?? sha256([]) : sha256(file.text ?? ""),
      byteLength: file.contentKind === "binary" ? file.bytes?.length ?? 0 : utf8Length(file.text ?? ""),
      updatedAtMs: file.updatedAtMs,
      latestMomentId: file.latestMomentId,
      metadataOrigin: file.metadataOrigin,
    };
  }

  private comparisonState(
    workspace: string,
    versionId: string,
    path: string,
    file: LoopbackFile,
  ): JsonObject {
    const metadata = this.snapshotMetadata(workspace, versionId, path, file);
    const digest =
      file.contentKind === "binary"
        ? file.binarySha ?? sha256([])
        : sha256(file.text ?? "");
    return {
      ...metadata,
      text: file.contentKind === "binary" ? "" : file.text ?? "",
      blobSha256: digest,
    };
  }

  /**
   * The daemon stamps each moment with the write's `summary` and
   * `correlationId` (store.rs `metadata_summary` / `metadata_correlation_id`)
   * and returns them from moments.list and moments.get. A caller that supplies
   * neither gets neither field, so an unlabelled write keeps the shape it had.
   *
   * Known remaining gap: the daemon carries the same pair on the FILE HEAD, and
   * so on its snapshots. This loopback does not, because nothing reads it here
   * yet — the history row is what moments.list serves.
   */
  // Mirrors the daemon's `validated_author` (lib.rs), which is the WRITE path:
  // a malformed author is REFUSED with `invalid-metadata` before any mutation.
  // An earlier draft mirrored `parsed_moment_author` instead and recorded
  // `{ corrupt: true }` — but that marker exists for READING malformed
  // historical rows, so recording it here let the fake accept writes production
  // refuses. Same class as copying the author raw: permissive where the daemon
  // is strict.
  //
  // Returns the normalized author to store. `agentRunId` is OPTIONAL in the
  // contract and never nullable, so it is omitted rather than nulled.
  private validatedAuthorValue(params: JsonObject): JsonValue | undefined {
    const raw = params.author;
    const legacy = params.authorJson;
    const refuse = (): never => {
      throw new Error("invalid-metadata");
    };
    if (legacy !== undefined && legacy !== null && typeof legacy !== "string") refuse();
    if (raw !== undefined && raw !== null && typeof legacy === "string") refuse();
    let value: JsonValue;
    if (raw !== undefined && raw !== null) {
      value = raw;
    } else if (typeof legacy === "string") {
      try {
        value = JSON.parse(legacy) as JsonValue;
      } catch {
        return refuse();
      }
    } else {
      return undefined;
    }
    if (typeof value !== "object" || value === null || Array.isArray(value)) refuse();
    const object = value as JsonObject;
    const nonEmpty = (key: string): boolean =>
      typeof object[key] === "string" && (object[key] as string).length > 0;
    const runId = object.agentRunId;
    const runOk = runId === undefined || (typeof runId === "string" && runId.length > 0);
    if (object.kind !== "agent" || !nonEmpty("agentId") || !nonEmpty("onBehalfOf") || !runOk) {
      refuse();
    }
    return {
      kind: "agent",
      agentId: object.agentId,
      onBehalfOf: object.onBehalfOf,
      ...(runId === undefined ? {} : { agentRunId: runId }),
    } as unknown as JsonValue;
  }

  private momentMetadataFields(params: JsonObject): JsonObject {
    const summary = metadataField(params, "summary");
    const correlationId = metadataField(params, "correlationId");
    return {
      ...(summary !== undefined ? { metadataSummary: summary } : {}),
      ...(correlationId !== undefined
        ? { metadataCorrelationId: correlationId }
        : {}),
      // The daemon stamps the write's AUTHOR on the moment it records and
      // returns it from moments.list/get (store.rs `author_json`); a write
      // without one gets null. Dropping it here made every moment look
      // actor-neutral, so a caller could not tell agent-authored history from
      // the user's own.
      //
      // NORMALIZED, not copied. AgentAuthor is `JsonObject & {...}`, so a
      // caller may pass extension fields; the daemon accepts them and
      // `parsed_moment_author` returns only the recognized ones. Copying raw
      // made the loopback STRICTER than the daemon — the response failed the
      // client's own `strictObjectValue` on the extra key, so a write that
      // works against the engine broke against the fake.
      ...(() => {
        // Validated, not merely normalized — see validatedAuthorValue. Throws
        // `invalid-metadata` for a malformed author, exactly as the daemon
        // refuses the request before mutating anything.
        const author = this.validatedAuthorValue(params);
        return author === undefined ? {} : { author };
      })(),
    };
  }

  private makeMoment(
    version: LoopbackVersion,
    path: string,
    momentId: string,
    operation: "write" | "delete" | "rename",
    after: LoopbackFile,
    before: LoopbackFile | undefined,
    recordedAtMs = this.clock++,
    metadata: JsonObject = {},
    fromPath?: string,
  ): MomentRecord {
    const afterText = after.contentKind === "text" ? after.text ?? "" : null;
    const beforeText = before?.contentKind === "text" ? before.text ?? "" : null;
    return {
      ...metadata,
      momentOrder: this.clock++,
      momentId,
      versionId: version.id,
      objectId: after.objectId,
      path,
      recordedAtMs,
      operation,
      afterContentKind: after.contentKind,
      // A delete and a rename record ONE digest on BOTH sides: `delete_text_in_tx`
      // and the rename insert (store.rs) bind `before.blob_sha256` to
      // `after_blob_sha256` and `before_blob_sha256` alike, so their callers pass
      // an `after` that repeats the removed content.
      afterBlobSha256: after.contentKind === "text" ? sha256(afterText ?? "") : null,
      afterBinarySha256: after.binarySha ?? null,
      beforePresent: before !== undefined,
      beforeContentKind: before?.contentKind ?? "text",
      beforeBlobSha256: before?.contentKind === "text" ? sha256(beforeText ?? "") : null,
      beforeBinarySha256: before?.binarySha ?? null,
      beforeLatestMomentId: before?.latestMomentId ?? null,
      metadataOrigin: after.metadataOrigin,
      // Supplied through `metadata` by the write paths that carry one (see
      // momentMetadataFields); absent means actor-neutral, never undefined.
      author: (metadata.author as MomentRecord["author"] | undefined) ?? null,
      syncRecordOnly: false,
      afterText,
      afterByteLength:
        after.contentKind === "text"
          ? utf8Length(afterText ?? "")
          : after.bytes?.length ?? null,
      afterInbandLimitBytes: null,
      beforeText,
      beforeByteLength: before === undefined ? null : before.contentKind === "text" ? utf8Length(beforeText ?? "") : before.bytes?.length ?? null,
      beforeInbandLimitBytes: null,
      // The path the preimage occupied. A write or delete replaced or removed
      // content at its own path (`payload_before_path` is
      // `CASE WHEN before_present = 2 THEN path` in store.rs:2909 and
      // conflicts.rs:1222, and the delete's own path in store.rs:3540); a
      // rename carries the path it moved FROM (store.rs:381). No preimage, no
      // before side.
      beforePath: before === undefined ? null : fromPath ?? path,
    };
  }

  private capMoment(moment: MomentRecord): MomentRecord {
    const capped = { ...moment };
    if (
      moment.afterText !== null &&
      utf8Length(moment.afterText) > MAX_DESKTOP_CAPTURE_TEXT_BYTES
    ) {
      capped.afterText = null;
      capped.afterInbandLimitBytes = MAX_DESKTOP_CAPTURE_TEXT_BYTES;
    }
    if (
      moment.beforeText !== null &&
      utf8Length(moment.beforeText) > MAX_DESKTOP_CAPTURE_TEXT_BYTES
    ) {
      capped.beforeText = null;
      capped.beforeInbandLimitBytes = MAX_DESKTOP_CAPTURE_TEXT_BYTES;
    }
    return capped;
  }

  private makeSecretMoment(
    workspace: string,
    versionId: string,
    path: string,
    momentId: string,
    operation: "write" | "delete",
    origin: VersionedOrigin,
    summary: string | null = null,
    correlationId: string | null = null,
  ): SecretMomentRecord {
    return {
      id: momentId,
      workspaceId: workspace,
      versionId,
      path,
      recordedAtMs: this.clock++,
      operation,
      metadata: { origin, summary, correlationId },
      momentOrder: this.clock++,
      protected: true,
    };
  }

  private versionJson(version: LoopbackVersion): JsonObject {
    const value: JsonObject = {
      id: version.id,
      workspaceId: version.workspaceId,
      kind: version.kind,
      name: version.name,
      createdAtMs: version.createdAtMs,
    };
    if (version.forkVersionId) {
      const forkPoint: JsonObject = { versionId: version.forkVersionId };
      if (version.forkMomentId) forkPoint.momentId = version.forkMomentId;
      value.forkPoint = forkPoint;
    }
    return value;
  }

  private latestMomentId(state: WorkspaceState, versionId: string): string | undefined {
    return [...state.moments.values()]
      .map((moment) => moment.wire)
      .filter((moment) => moment.versionId === versionId && !moment.syncRecordOnly)
      .sort((left, right) => right.momentOrder - left.momentOrder)[0]?.momentId;
  }

  private latestSecretMoment(
    state: WorkspaceState,
    versionId: string,
    path: string,
    text: string,
  ): SecretMomentRecord {
    const moments = [...state.secretMoments.values()]
      .filter((moment) => moment.wire.path === path && moment.after === text)
      .sort((left, right) => right.wire.momentOrder - left.wire.momentOrder);
    const exact = moments.find((moment) => moment.wire.versionId === versionId);
    const latest = exact ?? moments[0];
    if (!latest) throw new Error("state-corrupt");
    return latest.wire;
  }

  private filesEqual(left: LoopbackFile | undefined, right: LoopbackFile | undefined): boolean {
    if (!left || !right) return left === right;
    if (left.contentKind !== right.contentKind) return false;
    return left.contentKind === "text"
      ? left.text === right.text
      : left.binarySha === right.binarySha;
  }

}
