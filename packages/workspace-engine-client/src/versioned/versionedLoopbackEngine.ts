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
  activeVersionId: string;
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

function sha256(value: string | number[]): string {
  return createHash("sha256")
    .update(typeof value === "string" ? value : Uint8Array.from(value))
    .digest("hex");
}

function encodeBase64(bytes: number[]): string {
  return Buffer.from(bytes).toString("base64");
}

function decodeBase64(value: string): number[] {
  return [...Buffer.from(value, "base64")];
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
    state.versioned = true;
    const version = this.version(state, input.versionId ?? "main");
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
    state.versioned = true;
    const version = this.version(state, input.versionId ?? "main");
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
      case VERSIONED_METHOD.binaryWrite:
        return this.binaryWrite(state, workspace, params, request);
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
        return this.createNamed(state, workspace, params);
      case VERSIONED_METHOD.versionsSetActive:
        return this.setActive(state, params);
      case VERSIONED_METHOD.versionsEnsureMain:
        state.versioned = true;
        return this.versionJson(this.version(state, "main"));
      case VERSIONED_METHOD.versionsActive:
        return state.versioned
          ? this.versionJson(this.version(state, state.activeVersionId))
          : null;
      case VERSIONED_METHOD.versionsMerge:
        return this.merge(state, workspace, params, request);
      case VERSIONED_METHOD.versionsCompare:
        return this.compare(state, params);
      case VERSIONED_METHOD.versionsCompareFiles:
        return this.compareFiles(state, params);
      case VERSIONED_METHOD.secretsWrite:
        return this.secretWrite(state, workspace, params);
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
    state.versioned = true;
    const version = this.version(state, requiredString(params, "versionId", "write"));
    const path = requiredString(params, "path", "write");
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
    this.assertFreshMoment(state, momentId);
    const before = version.files.get(path);
    const now = optionalNumber(params, "nowMs") ?? this.clock++;
    const file: LoopbackFile = {
      objectId,
      contentKind: "text",
      text,
      updatedAtMs: now,
      latestMomentId: momentId,
      metadataOrigin: origin,
      momentLog: before ? [...before.momentLog] : [],
    };
    const moment = this.makeMoment(version, path, momentId, "write", file, before, now);
    const internal = { wire: moment, before: before && copyFile(before), after: copyFile(file) };
    file.momentLog.push(internal);
    version.files.set(path, file);
    state.moments.set(momentId, internal);
    const result: JsonObject = {
      object: this.fileObject(workspace, objectId, now),
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

  private binaryWrite(
    state: WorkspaceState,
    workspace: string,
    params: JsonObject,
    request: Request,
  ): JsonValue {
    state.versioned = true;
    const version = this.version(state, requiredString(params, "versionId", "binary write"));
    const path = requiredString(params, "path", "binary write");
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
    if (bytes.length > INBAND_LIMIT_BYTES) throw new Error("content-exceeds-inband-cap");
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
    this.assertFreshMoment(state, momentId);
    const before = version.files.get(path);
    const now = optionalNumber(params, "nowMs") ?? this.clock++;
    const binarySha = sha256(bytes);
    const file: LoopbackFile = {
      objectId,
      contentKind: "binary",
      bytes,
      binarySha,
      updatedAtMs: now,
      latestMomentId: momentId,
      metadataOrigin: origin,
      momentLog: before ? [...before.momentLog] : [],
    };
    const moment = this.makeMoment(version, path, momentId, "write", file, before, now);
    const internal = { wire: moment, before: before && copyFile(before), after: copyFile(file) };
    file.momentLog.push(internal);
    version.files.set(path, file);
    state.moments.set(momentId, internal);
    state.blobs.set(binarySha, [...bytes]);
    const result: JsonObject = {
      object: this.fileObject(workspace, objectId, now),
      snapshot: {
        objectId,
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
      materializeEnqueued: true,
      materialized: true,
      materializeOutcome: "applied",
    };
    this.recordReplay(state, requestId, params, result, replayFingerprint);
    return result;
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
    const replay = this.replay(state, requestId, params);
    if (replay) return replay;
    const before = this.file(version, fromPath);
    const momentId = `moment-${this.nextMomentId++}`;
    this.assertFreshMoment(state, momentId);
    const now = optionalNumber(params, "nowMs") ?? this.clock++;
    const after: LoopbackFile = {
      ...copyFile(before),
      updatedAtMs: now,
      latestMomentId: momentId,
      metadataOrigin: origin,
    };
    const moment = this.makeMoment(version, toPath, momentId, "rename", after, before, now);
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
    this.recordReplay(state, requestId, params, result);
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
    const replay = this.replay(state, requestId, params);
    if (replay) return replay;
    const before = this.file(version, path);
    const momentId = `moment-${this.nextMomentId++}`;
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
    const moment = this.makeMoment(version, path, momentId, "delete", tombstone, before, now);
    const internal = { wire: moment, before: copyFile(before) };
    state.moments.set(momentId, internal);
    version.files.delete(path);
    const result: JsonObject = {
      object: this.fileObject(workspace, before.objectId, now),
      before: this.snapshotMetadata(workspace, version.id, path, before),
      moment: this.capMoment(moment),
      deduped: false,
    };
    this.recordReplay(state, requestId, params, result);
    return result;
  }

  private textRollback(state: WorkspaceState, params: JsonObject, request: Request): JsonValue {
    state.versioned = true;
    requiredOrigin(params);
    const requestId = optionalString(params, "requestId") ?? request.idempotencyKey ?? undefined;
    const replay = this.replay(state, requestId, params);
    if (replay) return replay;
    const version = this.version(state, requiredString(params, "versionId", "rollback"));
    const path = requiredString(params, "path", "rollback");
    const mutationId = requiredString(params, "mutationMomentId", "rollback");
    const mutation = state.moments.get(mutationId);
    if (!mutation) throw new Error("moment not found");
    version.files.delete(path);
    const restorePath = mutation.wire.operation === "rename"
      ? mutation.beforePath ?? path
      : path;
    if (mutation.before) version.files.set(restorePath, copyFile(mutation.before));
    state.moments.delete(mutationId);
    const result: JsonObject = {
      rolledBack: true,
      deduped: false,
      materializeEnqueued: true,
      materialized: true,
      materializeOutcome: "applied",
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
      .sort(([left], [right]) => left.localeCompare(right));
    const page = files.slice(0, limit);
    return {
      files: page.map(([path, file]) => ({
        path,
        objectId: file.objectId,
        contentKind: file.contentKind,
        byteLength: file.contentKind === "text" ? utf8Length(file.text ?? "") : null,
        binarySha256: file.binarySha ?? null,
        updatedAtMs: file.updatedAtMs,
        latestMomentId: file.latestMomentId,
        metadataOrigin: file.metadataOrigin,
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
    const digest = requiredString(params, "sha256", "readBlob");
    const bytes = state.blobs.get(digest);
    if (!bytes) throw new Error("file-not-found");
    return bytes.length <= INBAND_LIMIT_BYTES
      ? { bytesBase64: encodeBase64(bytes) }
      : { bytesBase64: null, byteLength: bytes.length, inbandLimitBytes: INBAND_LIMIT_BYTES };
  }

  private createNamed(state: WorkspaceState, workspace: string, params: JsonObject): JsonValue {
    state.versioned = true;
    const from = this.version(state, requiredString(params, "fromVersionId", "createNamed"));
    const id = `version-${this.nextVersionId++}`;
    const version: LoopbackVersion = {
      id,
      workspaceId: workspace,
      kind: "named",
      name: requiredString(params, "name", "createNamed"),
      createdAtMs: this.clock++,
      forkVersionId: from.id,
      forkMomentId: this.latestMomentId(from),
      files: new Map([...from.files].map(([path, file]) => [path, copyFile(file)])),
      secrets: new Map(from.secrets),
      secretForkBase: new Map(from.secrets),
    };
    state.versions.set(id, version);
    return this.versionJson(version);
  }

  private setActive(state: WorkspaceState, params: JsonObject): JsonValue {
    const version = this.version(state, requiredString(params, "versionId", "setActive"));
    state.activeVersionId = version.id;
    state.versioned = true;
    return this.versionJson(version);
  }

  private compare(state: WorkspaceState, params: JsonObject): JsonValue {
    const source = this.version(state, requiredString(params, "sourceVersionId", "compare"));
    const target = this.version(state, requiredString(params, "targetVersionId", "compare"));
    const path = requiredString(params, "path", "compare");
    return { status: this.filesEqual(source.files.get(path), target.files.get(path)) ? "unchanged" : "merged" };
  }

  private merge(
    state: WorkspaceState,
    workspace: string,
    params: JsonObject,
    request: Request,
  ): JsonValue {
    const origin = requiredOrigin(params);
    const requestId = optionalString(params, "requestId") ?? request.idempotencyKey ?? undefined;
    const replay = this.replay(state, requestId, params);
    if (replay) return replay;
    const source = this.version(state, requiredString(params, "sourceVersionId", "merge"));
    const target = this.version(state, requiredString(params, "targetVersionId", "merge"));
    const path = requiredString(params, "path", "merge");
    const incoming = source.files.get(path);
    if (this.filesEqual(incoming, target.files.get(path))) {
      const result: JsonObject = { status: "unchanged", deduped: false };
      this.recordReplay(state, requestId, params, result);
      return result;
    }
    // The loopback intentionally models only a conflict-free fast-forward.
    if (!incoming) {
      const before = this.file(target, path);
      const now = optionalNumber(params, "nowMs") ?? this.clock++;
      const momentId = `moment-${this.nextMomentId++}`;
      const tombstone: LoopbackFile = {
        objectId: before.objectId,
        contentKind: before.contentKind,
        updatedAtMs: now,
        latestMomentId: momentId,
        metadataOrigin: origin,
        momentLog: [...before.momentLog],
      };
      const moment = this.makeMoment(target, path, momentId, "delete", tombstone, before, now);
      const internal: InternalMoment = { wire: moment, before: copyFile(before) };
      target.files.delete(path);
      state.moments.set(momentId, internal);
      const result: JsonObject = {
        status: "merged",
        writeKind: "delete",
        object: this.fileObject(workspace, before.objectId, now),
        moment: this.capMoment(moment),
        deduped: false,
      };
      this.recordReplay(state, requestId, params, result);
      return result;
    }
    const before = target.files.get(path);
    const now = optionalNumber(params, "nowMs") ?? this.clock++;
    const momentId = `moment-${this.nextMomentId++}`;
    const copied: LoopbackFile = {
      ...copyFile(incoming),
      updatedAtMs: now,
      latestMomentId: momentId,
      metadataOrigin: origin,
    };
    const moment = this.makeMoment(target, path, momentId, "write", copied, before, now);
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
      deduped: false,
    };
    this.recordReplay(state, requestId, params, result);
    return result;
  }

  private compareFiles(state: WorkspaceState, params: JsonObject): JsonValue {
    const source = this.version(state, requiredString(params, "sourceVersionId", "compareFiles"));
    const target = this.version(state, requiredString(params, "targetVersionId", "compareFiles"));
    const afterPath = optionalString(params, "afterPath");
    const paths = [...new Set([...source.files.keys(), ...target.files.keys()])]
      .filter((path) => (afterPath === undefined || path > afterPath) && !this.filesEqual(source.files.get(path), target.files.get(path)))
      .sort();
    const changes = paths.map((path) => {
      const sourceFile = source.files.get(path);
      const targetFile = target.files.get(path);
      const status: VersionChangeStatus = !targetFile ? "added" : !sourceFile ? "deleted" : "modified";
      const entry: JsonObject = { path, status };
      if (sourceFile?.contentKind === "binary" || targetFile?.contentKind === "binary") entry.binary = true;
      return entry;
    });
    let included = Math.min(COMPARE_PAGE_SIZE, changes.length);
    const budget = Math.max(1, optionalNumber(params, "byteBudget") ?? Number.MAX_SAFE_INTEGER);
    while (included > 0 && Buffer.byteLength(JSON.stringify(changes.slice(0, included))) > budget) included -= 1;
    if (included === 0 && changes.length > 0) throw new Error("invalid-input");
    const entries = changes.slice(0, included);
    return { entries, nextCursor: included < changes.length ? paths[included - 1] ?? null : null };
  }

  private secretWrite(state: WorkspaceState, workspace: string, params: JsonObject): JsonValue {
    state.versioned = true;
    const version = this.version(state, requiredString(params, "versionId", "secret write"));
    const path = requiredString(params, "path", "secret write");
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

  private secretDelete(state: WorkspaceState, workspace: string, params: JsonObject): JsonValue {
    state.versioned = true;
    const version = this.version(state, requiredString(params, "versionId", "secret delete"));
    const path = requiredString(params, "path", "secret delete");
    const origin = requiredOrigin(params);
    const momentId = requiredString(params, "momentId", "secret delete");
    this.assertFreshSecretMoment(state, momentId);
    const before = version.secrets.get(path);
    if (before === undefined) return { moment: null };
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
    this.assertFreshSecretMoment(state, momentId);
    const before = target.secrets.get(path);
    const after = source.secrets.get(path);
    const base = source.secretForkBase.get(path);
    if ((before === undefined && after === undefined) || before === after || after === base) {
      return { changed: false, moment: null };
    }
    if (after === undefined) target.secrets.delete(path);
    else target.secrets.set(path, after);
    const operation = after === undefined ? "delete" : "write";
    const wire = this.makeSecretMoment(workspace, target.id, path, momentId, operation, "sync");
    state.secretMoments.set(momentId, { wire, before, after });
    return { changed: true, moment: wire };
  }

  private secretRestore(state: WorkspaceState, workspace: string, params: JsonObject): JsonValue {
    const path = requiredString(params, "path", "secret restore");
    const beforeMomentId = requiredString(params, "beforeMomentId", "secret restore");
    const momentId = requiredString(params, "momentId", "secret restore");
    this.assertFreshSecretMoment(state, momentId);
    const sourceMoment = state.secretMoments.get(beforeMomentId);
    if (!sourceMoment) throw new Error("moment not found");
    const version = this.version(state, sourceMoment.wire.versionId);
    const prior = version.secrets.get(path);
    if (prior === sourceMoment.before) {
      return {
        restored: sourceMoment.before === undefined ? "deleted" : "text",
        restoredMomentId: beforeMomentId,
        path,
      };
    }
    if (sourceMoment.before === undefined) version.secrets.delete(path);
    else version.secrets.set(path, sourceMoment.before);
    const operation = sourceMoment.before === undefined ? "delete" : "write";
    const wire = this.makeSecretMoment(workspace, version.id, path, momentId, operation, "restore");
    state.secretMoments.set(momentId, { wire, before: prior, after: sourceMoment.before });
    return { restored: sourceMoment.before === undefined ? "deleted" : "text", restoredMomentId: momentId, path };
  }

  private secretMomentsList(state: WorkspaceState, params: JsonObject): JsonValue {
    const versionId = optionalString(params, "versionId");
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
      const main: LoopbackVersion = {
        id: "main",
        workspaceId: id,
        kind: "main",
        name: "main",
        createdAtMs: this.clock++,
        files: new Map(),
        secrets: new Map(),
        secretForkBase: new Map(),
      };
      state = {
        versioned: false,
        versions: new Map([[main.id, main]]),
        activeVersionId: main.id,
        moments: new Map(),
        secretMoments: new Map(),
        blobs: new Map(),
        replays: new Map(),
      };
      this.workspaces.set(id, state);
    }
    return state;
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
  ): JsonObject | undefined {
    if (!requestId) return undefined;
    const recorded = state.replays.get(requestId);
    if (!recorded) return undefined;
    if (recorded.fingerprint !== fingerprint) {
      throw new Error("idempotency-key-reuse-mismatch");
    }
    return { ...recorded.result, deduped: true };
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

  private makeMoment(
    version: LoopbackVersion,
    path: string,
    momentId: string,
    operation: "write" | "delete" | "rename",
    after: LoopbackFile,
    before: LoopbackFile | undefined,
    recordedAtMs = this.clock++,
  ): MomentRecord {
    const afterText = after.contentKind === "text" ? after.text ?? "" : null;
    const beforeText = before?.contentKind === "text" ? before.text ?? "" : null;
    return {
      momentOrder: this.clock++,
      momentId,
      versionId: version.id,
      objectId: after.objectId,
      path,
      recordedAtMs,
      operation,
      afterContentKind: after.contentKind,
      afterBlobSha256: after.contentKind === "text" ? sha256(afterText ?? "") : null,
      afterBinarySha256: after.binarySha ?? null,
      beforePresent: before !== undefined,
      beforeContentKind: before?.contentKind ?? "text",
      beforeBlobSha256: before?.contentKind === "text" ? sha256(beforeText ?? "") : null,
      beforeBinarySha256: before?.binarySha ?? null,
      beforeLatestMomentId: before?.latestMomentId ?? null,
      metadataOrigin: after.metadataOrigin,
      author: null,
      syncRecordOnly: false,
      afterText,
      afterByteLength: after.contentKind === "text" ? utf8Length(afterText ?? "") : after.bytes?.length ?? null,
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
  ): SecretMomentRecord {
    return {
      id: momentId,
      workspaceId: workspace,
      versionId,
      path,
      recordedAtMs: this.clock++,
      operation,
      metadata: { origin, summary: null, correlationId: null },
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

  private latestMomentId(version: LoopbackVersion): string | undefined {
    return [...version.files.values()].sort((left, right) => right.updatedAtMs - left.updatedAtMs)[0]?.latestMomentId;
  }

  private filesEqual(left: LoopbackFile | undefined, right: LoopbackFile | undefined): boolean {
    if (!left || !right) return left === right;
    if (left.contentKind !== right.contentKind) return false;
    return left.contentKind === "text"
      ? left.text === right.text
      : left.binarySha === right.binarySha;
  }

}
