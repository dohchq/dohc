import { createHash } from "node:crypto";
import type { Event } from "../ydoc/generated/Event";
import type { JsonValue } from "../ydoc/generated/serde_json/JsonValue";
import type { Request } from "../ydoc/generated/Request";
import type { Response } from "../ydoc/generated/Response";
import type { EngineTransport } from "../ydoc/ydocLiveAdapter";
import type { JsonObject } from "../ydoc/ydocWireContract";
import {
  VERSIONED_METHOD,
  type MomentRecord,
  type SecretMomentRecord,
  type VersionChangeStatus,
  type VersionedContentKind,
  type VersionedOrigin,
} from "./versionedWireContract";

const INBAND_LIMIT_BYTES = 48 * 1024;
const COMPARE_PAGE_SIZE = 200;
const MAX_MERGE_LINES = 2_000;
const ACCEPTED_ORIGINS = new Set<string>([
  "api",
  "local-file",
  "restore",
  "sync",
  "unknown",
]);

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

function optionalString(object: JsonObject, key: string): string | undefined {
  const value = object[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new Error(`${key} is invalid.`);
  return value;
}

function optionalNumber(object: JsonObject, key: string): number | undefined {
  const value = object[key];
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new Error(`${key} is invalid.`);
  }
  return value;
}

function requiredOrigin(object: JsonObject): VersionedOrigin {
  const origin = optionalString(object, "origin");
  if (origin !== undefined) {
    if (!ACCEPTED_ORIGINS.has(origin)) throw new Error("invalid-metadata");
    return origin as VersionedOrigin;
  }
  const legacyOrigin = optionalString(object, "metadataOrigin");
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

/**
 * Loopback subset of dohc-engine-files' path floor. It mirrors the common
 * case-insensitive `.env` segment, `name.env`, and `.env.*` basename rules;
 * percent decoding, reserved aliases, and the full disk-sink policy stay in
 * the daemon.
 */
function isSecretClassifiedPath(path: string): boolean {
  const segments = path
    .split(/[\\/]/)
    .filter(Boolean)
    .map((segment) => segment.toLowerCase());
  const basename = segments.at(-1) ?? "";
  return (
    segments.includes(".env") ||
    basename.endsWith(".env") ||
    basename.startsWith(".env.")
  );
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
    const state = this.workspace(input.workspace);
    const versionId = input.versionId ?? "main";
    const version = versionId === "main"
      ? this.ensureMain(state, input.workspace)
      : this.version(state, versionId);
    const objectId = input.objectId ?? `object-${this.nextObjectId++}`;
    const momentId = input.momentId ?? `moment-${this.nextMomentId++}`;
    this.assertFreshMoment(state, momentId);
    const before = version.files.get(input.path);
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
      input.path,
      momentId,
      "write",
      file,
      before,
    );
    const internal = { wire: moment, before: before && copyFile(before), after: copyFile(file) };
    file.momentLog.push(internal);
    version.files.set(input.path, file);
    state.moments.set(momentId, internal);
  }

  seedBinaryFile(input: SeedVersionedBinaryInput): void {
    const state = this.workspace(input.workspace);
    const versionId = input.versionId ?? "main";
    const version = versionId === "main"
      ? this.ensureMain(state, input.workspace)
      : this.version(state, versionId);
    const objectId = input.objectId ?? `object-${this.nextObjectId++}`;
    const momentId = input.momentId ?? `moment-${this.nextMomentId++}`;
    this.assertFreshMoment(state, momentId);
    const before = version.files.get(input.path);
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
      input.path,
      momentId,
      "write",
      file,
      before,
    );
    const internal = { wire: moment, before: before && copyFile(before), after: copyFile(file) };
    file.momentLog.push(internal);
    version.files.set(input.path, file);
    state.moments.set(momentId, internal);
    state.blobs.set(binarySha, [...input.bytes]);
  }

  seedSecretFile(input: SeedSecretInput): void {
    if (!isSecretClassifiedPath(input.path)) throw new Error("not-secret-path");
    const state = this.workspace(input.workspace);
    const versionId = input.versionId ?? "main";
    const version = versionId === "main"
      ? this.ensureMain(state, input.workspace)
      : this.version(state, versionId);
    const momentId = input.momentId ?? `secret-moment-${this.nextMomentId++}`;
    this.assertFreshSecretMoment(state, momentId);
    const before = version.secrets.get(input.path);
    version.secrets.set(input.path, input.text);
    const wire = this.makeSecretMoment(
      input.workspace,
      version.id,
      input.path,
      momentId,
      "write",
      input.origin ?? "local-file",
    );
    state.secretMoments.set(momentId, { wire, before, after: input.text });
  }

  secretValue(workspace: string, versionId: string, path: string): string | undefined {
    return this.version(this.workspace(workspace), versionId).secrets.get(path);
  }

  async sendRequest(request: Request): Promise<Response> {
    this.requests.push(request);
    const result = this.handleRequest(request);
    const response: Response = { id: request.id, result };
    this.responses.push(response);
    return response;
  }

  private handleRequest(request: Request): JsonValue {
    const workspace = this.requireWorkspaceHandle(request);
    const state = this.workspace(workspace);
    const params = asObject(request.params, `${request.method} params`);
    this.validateWorkspaceParam(params, workspace);
    switch (request.method) {
      case VERSIONED_METHOD.textWrite:
        return this.textWrite(state, workspace, params, request);
      case VERSIONED_METHOD.textRead:
        return this.textRead(state, workspace, params);
      case VERSIONED_METHOD.textReadBlob:
        return this.textReadBlob(state, params);
      case VERSIONED_METHOD.binaryWrite:
        return this.binaryWrite(state, workspace, params, request);
      case VERSIONED_METHOD.binaryWriteBlob:
        return this.binaryWriteBlob(state, workspace, params, request);
      case VERSIONED_METHOD.textRename:
        return this.textRename(state, workspace, params, request);
      case VERSIONED_METHOD.textDelete:
        return this.textDelete(state, workspace, params, request);
      case VERSIONED_METHOD.textRollback:
        return this.textRollback(state, params, request);
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
        return this.secretWrite(state, workspace, params);
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
        return this.secretDelete(state, workspace, params);
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
    request: Request,
  ): JsonValue {
    const path = requiredString(params, "path", "write");
    if (isSecretClassifiedPath(path)) throw new Error("invalid-path");
    const version = this.mutationVersion(
      state,
      workspace,
      requiredString(params, "versionId", "write"),
    );
    const text = requiredString(params, "text", "write");
    if (utf8Length(text) > INBAND_LIMIT_BYTES) throw new Error("content-exceeds-inband-cap");
    const origin = requiredOrigin(params);
    const requestId = optionalString(params, "requestId") ?? request.idempotencyKey ?? undefined;
    const objectId = optionalString(params, "objectId") ??
      (requestId
        ? this.generatedWriteId("object", requestId, path)
        : version.files.get(path)?.objectId ?? `object-${this.nextObjectId++}`);
    const momentId = optionalString(params, "momentId") ??
      (requestId
        ? this.generatedWriteId("moment", requestId, path)
        : `moment-${this.nextMomentId++}`);
    const replayFingerprint = this.textWriteFingerprint(params, origin, objectId, momentId);
    const replay = this.replay(state, requestId, params, replayFingerprint);
    if (replay) return replay;
    const existingMoment = state.moments.get(momentId);
    const authorFingerprint = this.writeAuthorFingerprint(params);
    if (existingMoment) {
      const exact =
        existingMoment.wire.versionId === version.id &&
        existingMoment.wire.path === path &&
        existingMoment.wire.operation === "write" &&
        existingMoment.wire.afterContentKind === "text" &&
        existingMoment.after?.contentKind === "text" &&
        existingMoment.after.text === text &&
        existingMoment.wire.metadataOrigin === origin &&
        (existingMoment.wire.metadataSummary ?? null) ===
          (optionalString(params, "summary") ?? null) &&
        (existingMoment.wire.metadataCorrelationId ?? null) ===
          (optionalString(params, "correlationId") ?? null) &&
        (existingMoment.writeAuthorFingerprint ?? null) === authorFingerprint;
      if (exact) {
        const recorded = copyFile(existingMoment.after!);
        return {
          object: this.fileObject(workspace, recorded.objectId, existingMoment.wire.recordedAtMs),
          snapshot: this.textSnapshot(workspace, version.id, path, recorded),
          moment: this.capMoment(existingMoment.wire),
          deduped: true,
        };
      }
    }
    this.assertFreshMoment(state, momentId);
    const before = version.files.get(path);
    // The daemon binds the input object id to NEW paths only — an existing
    // head keeps its identity (store.rs existing_object.unwrap_or).
    const effectiveObjectId = before?.objectId ?? objectId;
    const now = optionalNumber(params, "nowMs") ?? this.clock++;
    const file: LoopbackFile = {
      objectId: effectiveObjectId,
      contentKind: "text",
      text,
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
      this.momentMetadataFields(params),
    );
    const internal = {
      wire: moment,
      before: before && copyFile(before),
      after: copyFile(file),
      writeAuthorFingerprint: authorFingerprint,
    };
    file.momentLog.push(internal);
    version.files.set(path, file);
    state.moments.set(momentId, internal);
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
    const version = this.version(state, requiredString(params, "versionId", "text read"));
    const path = requiredString(params, "path", "text read");
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
    if (utf8Length(text) > INBAND_LIMIT_BYTES) {
      return {
        ...metadata,
        text: null,
        blobSha256: sha256(text),
        inbandLimitBytes: INBAND_LIMIT_BYTES,
      };
    }
    return { ...metadata, text, blobSha256: sha256(text) };
  }

  private textReadBlob(state: WorkspaceState, params: JsonObject): JsonValue {
    const digest = requiredString(params, "sha256", "text readBlob").toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(digest)) throw new Error("invalid-input");
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
    const text = candidates.find((candidate) => sha256(candidate) === digest);
    if (text === undefined) throw new Error("file-not-found");
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
    request: Request,
    allowFullRange = false,
  ): JsonValue {
    const path = requiredString(params, "path", "binary write");
    if (isSecretClassifiedPath(path)) throw new Error("invalid-path");
    const version = this.mutationVersion(
      state,
      workspace,
      requiredString(params, "versionId", "binary write"),
    );
    const origin = requiredOrigin(params);
    const rawBytes = params.bytes;
    const rawBase64 = params.bytesBase64;
    let bytes: number[];
    if (Array.isArray(rawBytes) && rawBase64 === undefined) {
      bytes = rawBytes.map((byte) => {
        if (typeof byte !== "number" || !Number.isInteger(byte) || byte < 0 || byte > 255) {
          throw new Error("invalid-input");
        }
        return byte;
      });
    } else if (typeof rawBase64 === "string" && rawBytes === undefined) {
      bytes = decodeBase64(rawBase64);
    } else {
      throw new Error("invalid-input");
    }
    if (!allowFullRange && bytes.length > INBAND_LIMIT_BYTES) {
      throw new Error("content-exceeds-inband-cap");
    }
    const requestId = optionalString(params, "requestId") ?? request.idempotencyKey ?? undefined;
    const objectId = optionalString(params, "objectId") ??
      (requestId
        ? this.generatedWriteId("object", requestId, path)
        : version.files.get(path)?.objectId ?? `object-${this.nextObjectId++}`);
    const momentId = optionalString(params, "momentId") ??
      (requestId
        ? this.generatedWriteId("moment", requestId, path)
        : `moment-${this.nextMomentId++}`);
    const replayFingerprint = this.binaryWriteFingerprint(
      workspace,
      params,
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
    this.assertFreshMoment(state, momentId);
    // Daemon parity: an existing head keeps its object identity.
    const effectiveObjectId = before?.objectId ?? objectId;
    const now = optionalNumber(params, "nowMs") ?? this.clock++;
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
      this.momentMetadataFields(params),
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
    request: Request,
  ): JsonValue {
    const expectedSha = requiredString(params, "sha256", "binary blob write").toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(expectedSha)) throw new Error("invalid-input");
    const encoded = optionalString(params, "bytesBase64");
    const bytes =
      encoded === undefined
        ? state.blobs.get(expectedSha)
        : decodeBase64(encoded);
    if (bytes === undefined) throw new Error("file-not-found");
    if (sha256(bytes) !== expectedSha) throw new Error("invalid-input");
    return this.binaryWrite(
      state,
      workspace,
      { ...params, bytesBase64: encodeBase64(bytes) },
      request,
      true,
    );
  }

  private textRename(
    state: WorkspaceState,
    workspace: string,
    params: JsonObject,
    request: Request,
  ): JsonValue {
    const version = this.version(state, requiredString(params, "versionId", "rename"));
    const fromPath = requiredString(params, "fromPath", "rename");
    const toPath = requiredString(params, "toPath", "rename");
    const origin = requiredOrigin(params);
    const requestId = optionalString(params, "requestId") ?? request.idempotencyKey ?? undefined;
    const momentId = requestId
      ? this.generatedRequestId("moment", requestId, toPath)
      : `moment-${this.nextMomentId++}`;
    const fingerprint = this.renameFingerprint(
      workspace,
      params,
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
    const now = optionalNumber(params, "nowMs") ?? this.clock++;
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
      this.momentMetadataFields(params),
    );
    moment.beforePath = fromPath;
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
    request: Request,
  ): JsonValue {
    const version = this.version(state, requiredString(params, "versionId", "delete"));
    const path = requiredString(params, "path", "delete");
    const origin = requiredOrigin(params);
    const requestId = optionalString(params, "requestId") ?? request.idempotencyKey ?? undefined;
    const momentId = requestId
      ? this.generatedRequestId("moment", requestId, path)
      : `moment-${this.nextMomentId++}`;
    const fingerprint = this.deleteFingerprint(
      workspace,
      params,
      origin,
      momentId,
    );
    const replay = this.replay(state, requestId, params, fingerprint);
    if (replay) return replay;
    const before = this.file(version, path);
    this.assertFreshMoment(state, momentId);
    const now = optionalNumber(params, "nowMs") ?? this.clock++;
    const tombstone: LoopbackFile = {
      objectId: before.objectId,
      contentKind: before.contentKind,
      updatedAtMs: now,
      latestMomentId: momentId,
      metadataOrigin: origin,
      momentLog: [...before.momentLog],
    };
    const moment = this.makeMoment(
      version,
      path,
      momentId,
      "delete",
      tombstone,
      before,
      now,
      this.momentMetadataFields(params),
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

  private textRollback(state: WorkspaceState, params: JsonObject, request: Request): JsonValue {
    requiredOrigin(params);
    const requestId = optionalString(params, "requestId") ?? request.idempotencyKey ?? undefined;
    const replay = this.replay(state, requestId, params);
    if (replay) {
      return {
        ...replay,
        materializeEnqueued: false,
        materialized: false,
        materializeOutcome: "skipped",
      };
    }
    const version = this.version(state, requiredString(params, "versionId", "rollback"));
    const path = requiredString(params, "path", "rollback");
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
    this.recordReplay(state, requestId, params, result);
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
    const version = this.version(state, requiredString(params, "versionId", "binary read"));
    const path = requiredString(params, "path", "binary read");
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
    const source = this.version(state, requiredString(params, "sourceVersionId", "compare"));
    const target = this.version(state, requiredString(params, "targetVersionId", "compare"));
    const path = requiredString(params, "path", "compare");
    return this.comparisonRecord(workspace, path, target, source);
  }

  private merge(
    state: WorkspaceState,
    workspace: string,
    params: JsonObject,
    request: Request,
  ): JsonValue {
    const origin = requiredOrigin(params);
    const requestId = optionalString(params, "requestId") ?? request.idempotencyKey ?? undefined;
    const sourceVersionId = requiredString(params, "sourceVersionId", "merge");
    const targetVersionId = requiredString(params, "targetVersionId", "merge");
    const path = requiredString(params, "path", "merge");
    const objectId = requestId
      ? this.generatedRequestId("object", requestId, path)
      : `object-${this.nextObjectId++}`;
    const momentId = requestId
      ? this.generatedRequestId("moment", requestId, path)
      : `moment-${this.nextMomentId++}`;
    const conflictId = requestId
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
    if (
      incoming?.contentKind === "binary" ||
      current?.contentKind === "binary" ||
      base?.contentKind === "binary"
    ) {
      throw new Error("binary-head-not-text");
    }
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
    if (!this.filesEqual(current, base)) {
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
      const tombstone: LoopbackFile = {
        objectId: before.objectId,
        contentKind: before.contentKind,
        updatedAtMs: now,
        latestMomentId: momentId,
        metadataOrigin: origin,
        momentLog: [...before.momentLog],
      };
      const moment = this.makeMoment(
        target,
        path,
        momentId,
        "delete",
        tombstone,
        before,
        now,
        this.momentMetadataFields(params),
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
      this.momentMetadataFields(params),
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
      writeKind: "write",
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

  private secretWrite(state: WorkspaceState, workspace: string, params: JsonObject): JsonValue {
    const path = requiredString(params, "path", "secret write");
    if (!isSecretClassifiedPath(path)) throw new Error("not-secret-path");
    const version = this.mutationVersion(
      state,
      workspace,
      requiredString(params, "versionId", "secret write"),
    );
    const text = requiredString(params, "text", "secret write");
    if (utf8Length(text) > INBAND_LIMIT_BYTES) throw new Error("content-exceeds-inband-cap");
    const origin = requiredOrigin(params);
    const momentId = requiredString(params, "momentId", "secret write");
    const before = version.secrets.get(path);
    if (before === text) return { changed: false, moment: null };
    this.assertFreshSecretMoment(state, momentId);
    version.secrets.set(path, text);
    const wire = this.makeSecretMoment(workspace, version.id, path, momentId, "write", origin);
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
    const path = requiredString(params, "path", "secret materialize");
    if (!isSecretClassifiedPath(path)) throw new Error("not-secret-path");
    const versionId = requiredString(params, "versionId", "secret materialize");
    const version = state.versions.get(versionId);
    if (!version) throw new Error("invalid-version");
    const text = version.secrets.get(path);
    if (text === undefined) return null;
    const byteLength = utf8Length(text);
    return byteLength <= INBAND_LIMIT_BYTES
      ? { text }
      : { text: null, byteLength, inbandLimitBytes: INBAND_LIMIT_BYTES };
  }

  private secretDelete(state: WorkspaceState, workspace: string, params: JsonObject): JsonValue {
    const version = this.mutationVersion(
      state,
      workspace,
      requiredString(params, "versionId", "secret delete"),
    );
    const path = requiredString(params, "path", "secret delete");
    const origin = requiredOrigin(params);
    const momentId = requiredString(params, "momentId", "secret delete");
    const before = version.secrets.get(path);
    if (before === undefined) return { moment: null };
    this.assertFreshSecretMoment(state, momentId);
    version.secrets.delete(path);
    const wire = this.makeSecretMoment(workspace, version.id, path, momentId, "delete", origin);
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
    const source = state.versions.get(requiredString(params, "sourceVersionId", "secret apply"));
    const target = state.versions.get(requiredString(params, "targetVersionId", "secret apply"));
    if (!source || !target) throw new Error("invalid-version");
    const path = requiredString(params, "path", "secret apply");
    const momentId = requiredString(params, "momentId", "secret apply");
    const origin = requiredOrigin(params);
    const summary = optionalString(params, "summary") ?? null;
    const correlationId = optionalString(params, "correlationId") ?? null;
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
    const path = requiredString(params, "path", "secret restore");
    const beforeMomentId = requiredString(params, "beforeMomentId", "secret restore");
    const momentId = requiredString(params, "momentId", "secret restore");
    const sourceMoment = state.secretMoments.get(beforeMomentId);
    if (!sourceMoment) throw new Error("moment not found");
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
    const wire = this.makeSecretMoment(workspace, version.id, path, momentId, operation, "restore");
    state.secretMoments.set(momentId, { wire, before: prior, after: sourceMoment.before });
    return { restored: sourceMoment.before === undefined ? "deleted" : "text", restoredMomentId: momentId, path };
  }

  private secretMomentsList(state: WorkspaceState, params: JsonObject): JsonValue {
    const versionId = optionalString(params, "versionId");
    // Daemon parity: a PRESENT but unknown versionId refuses invalid-version
    // (require_version inside the keyless domain query) instead of answering
    // an empty page.
    if (versionId !== undefined && !state.versions.has(versionId)) {
      throw new Error("invalid-version");
    }
    const path = optionalString(params, "path");
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
    if (!version) throw new Error("version not found");
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

  private validateWorkspaceParam(params: JsonObject, workspace: string): void {
    const candidate = optionalString(params, "workspaceId");
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
    if (!requestId) return undefined;
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
    if (requestId) {
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
      metadataSummary: params.summary ?? null,
      metadataCorrelationId: params.correlationId ?? null,
      authorJson: this.writeAuthorFingerprint(params),
    });
  }

  private writeAuthorFingerprint(params: JsonObject): string | null {
    if (params.author !== undefined) return JSON.stringify(params.author);
    const legacy = params.authorJson;
    if (typeof legacy !== "string") return null;
    try {
      return JSON.stringify(JSON.parse(legacy));
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
  private momentMetadataFields(params: JsonObject): JsonObject {
    const summary = optionalString(params, "summary");
    const correlationId = optionalString(params, "correlationId");
    return {
      ...(summary !== undefined ? { metadataSummary: summary } : {}),
      ...(correlationId !== undefined
        ? { metadataCorrelationId: correlationId }
        : {}),
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
  ): MomentRecord {
    const deleted = operation === "delete";
    const afterText = !deleted && after.contentKind === "text" ? after.text ?? "" : null;
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
      afterBlobSha256: !deleted && after.contentKind === "text" ? sha256(afterText ?? "") : null,
      afterBinarySha256: deleted ? null : after.binarySha ?? null,
      beforePresent: before !== undefined,
      beforeContentKind: before?.contentKind ?? "text",
      beforeBlobSha256: before?.contentKind === "text" ? sha256(beforeText ?? "") : null,
      beforeBinarySha256: before?.binarySha ?? null,
      beforeLatestMomentId: before?.latestMomentId ?? null,
      metadataOrigin: after.metadataOrigin,
      author: null,
      syncRecordOnly: false,
      afterText,
      afterByteLength: deleted
        ? null
        : after.contentKind === "text"
          ? utf8Length(afterText ?? "")
          : after.bytes?.length ?? null,
      afterInbandLimitBytes: null,
      beforeText,
      beforeByteLength: before === undefined ? null : before.contentKind === "text" ? utf8Length(beforeText ?? "") : before.bytes?.length ?? null,
      beforeInbandLimitBytes: null,
    };
  }

  private capMoment(moment: MomentRecord): MomentRecord {
    const capped = { ...moment };
    if (moment.afterText !== null && utf8Length(moment.afterText) > INBAND_LIMIT_BYTES) {
      capped.afterText = null;
      capped.afterInbandLimitBytes = INBAND_LIMIT_BYTES;
    }
    if (moment.beforeText !== null && utf8Length(moment.beforeText) > INBAND_LIMIT_BYTES) {
      capped.beforeText = null;
      capped.beforeInbandLimitBytes = INBAND_LIMIT_BYTES;
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
