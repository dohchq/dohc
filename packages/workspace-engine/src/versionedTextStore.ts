import { randomUUID } from "node:crypto";
import type { Stats } from "node:fs";
import { mkdir, open, readFile, rename, rm, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { validateUserWritePath } from "@dohc/workspace-core";

export const VERSIONED_TEXT_STORE_RELATIVE_PATH = ".dohc/engine/versioned-text-store.json";

export type WorkspaceObjectId = string;
export type VersionId = string;
export type WorkspaceId = string;
export type VersionedTextMomentId = string;

export type VersionedTextStoreErrorCode =
  | "duplicate-id"
  | "file-not-found"
  | "invalid-generated-id"
  | "invalid-input"
  | "invalid-metadata"
  | "invalid-object"
  | "invalid-path"
  | "invalid-root"
  | "invalid-version"
  | "invalid-text"
  | "invalid-timestamp"
  | "invalid-version-name"
  | "invalid-workspace"
  | "persist-failed"
  | "state-corrupt"
  | "target-path-exists"
  | "version-name-conflict"
  | "version-not-found"
  | "workspace-mismatch";

export class VersionedTextStoreError extends Error {
  readonly code: VersionedTextStoreErrorCode;

  constructor(code: VersionedTextStoreErrorCode, message: string) {
    super(message);
    this.name = "VersionedTextStoreError";
    this.code = code;
  }
}

export type VersionKind = "main" | "named";

export interface VersionRecord {
  id: VersionId;
  workspaceId: WorkspaceId;
  kind: VersionKind;
  name: string;
  createdAtMs: number;
  forkPoint?: {
    versionId: VersionId;
    momentId?: VersionedTextMomentId;
  };
}

export interface FileObjectRecord {
  id: WorkspaceObjectId;
  workspaceId: WorkspaceId;
  createdAtMs: number;
}

export type ActorNeutralWriteOrigin =
  | "api"
  | "local-file"
  | "restore"
  | "sync"
  | "unknown";

export interface ActorNeutralWriteMetadata {
  origin: ActorNeutralWriteOrigin;
  summary?: string;
  correlationId?: string;
}

export interface TextFileSnapshot {
  objectId: WorkspaceObjectId;
  versionId: VersionId;
  path: string;
  text: string;
  updatedAtMs: number;
  latestMomentId: VersionedTextMomentId;
  metadata: ActorNeutralWriteMetadata;
}

export interface VersionedTextMoment {
  id: VersionedTextMomentId;
  workspaceId: WorkspaceId;
  versionId: VersionId;
  objectId: WorkspaceObjectId;
  path: string;
  recordedAtMs: number;
  operation: "write" | "rename";
  metadata: ActorNeutralWriteMetadata;
}

export interface VersionedTextWriteResult {
  object: FileObjectRecord;
  snapshot: TextFileSnapshot;
  moment: VersionedTextMoment;
}

export interface VersionedTextRenameResult {
  object: FileObjectRecord;
  before: TextFileSnapshot;
  after: TextFileSnapshot;
  moment: VersionedTextMoment;
}

/**
 * Internal server-side storage primitive.
 *
 * Callers must derive workspace identity and authorization before invoking this
 * API. Browser/client-provided workspace, version, or object ids are not an
 * authorization boundary.
 */
export interface VersionedTextStore {
  ensureMainVersion(input: { workspaceId: WorkspaceId }): Promise<VersionRecord>;
  getMainVersion(input: { workspaceId: WorkspaceId }): Promise<VersionRecord | null>;
  createNamedVersion(input: {
    workspaceId: WorkspaceId;
    name: string;
    fromVersionId: VersionId;
  }): Promise<VersionRecord>;
  listVersions(input: { workspaceId: WorkspaceId }): Promise<VersionRecord[]>;
  writeTextFile(input: {
    workspaceId: WorkspaceId;
    versionId: VersionId;
    path: string;
    text: string;
    metadata: ActorNeutralWriteMetadata;
  }): Promise<VersionedTextWriteResult>;
  readTextFile(input: {
    workspaceId: WorkspaceId;
    versionId: VersionId;
    path: string;
  }): Promise<TextFileSnapshot | null>;
  listTextFiles(input: {
    workspaceId: WorkspaceId;
    versionId: VersionId;
  }): Promise<TextFileSnapshot[]>;
  renameTextFile(input: {
    workspaceId: WorkspaceId;
    versionId: VersionId;
    fromPath: string;
    toPath: string;
    metadata: ActorNeutralWriteMetadata;
  }): Promise<VersionedTextRenameResult>;
  getObject(input: {
    workspaceId: WorkspaceId;
    objectId: WorkspaceObjectId;
  }): Promise<FileObjectRecord | null>;
}

export interface VersionedTextStoreOptions {
  nowMs?: () => number;
  createId?: (kind: "moment" | "object" | "version") => string;
}

export interface VersionedTextStoreTestHooks {
  afterLoadWritableState?: () => void | Promise<void>;
  beforePersist?: () => void | Promise<void>;
  lockStaleMs?: number;
  lockTimeoutMs?: number;
  onLockBlocked?: () => void | Promise<void>;
  onWriteQueued?: () => void;
}

const storeWriteChains = new Map<string, Promise<unknown>>();
const ID_KEY_SEPARATOR = "\u0000";
const STORE_LOCK_STALE_MS = 30_000;
const STORE_LOCK_TIMEOUT_MS = 35_000;

interface PersistedWorkspaceState {
  mainVersionId: VersionId;
  versions: Record<VersionId, VersionRecord>;
  objects: Record<WorkspaceObjectId, FileObjectRecord>;
  pathAliases: Record<VersionId, Record<string, WorkspaceObjectId>>;
  snapshots: Record<VersionId, Record<WorkspaceObjectId, TextFileSnapshot>>;
  moments: VersionedTextMoment[];
}

interface PersistedVersionedTextState {
  schemaVersion: 1;
  workspaces: Record<WorkspaceId, PersistedWorkspaceState>;
}

function initialState(): PersistedVersionedTextState {
  return { schemaVersion: 1, workspaces: createDictionary() };
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function createDictionary<T>(
  entries: Iterable<readonly [string, T]> = [],
): Record<string, T> {
  const record = Object.create(null) as Record<string, T>;
  for (const [key, value] of entries) {
    record[key] = value;
  }
  return record;
}

function getOwn<T>(record: Record<string, T>, key: string): T | undefined {
  return Object.prototype.hasOwnProperty.call(record, key) ? record[key] : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertString(value: unknown): asserts value is string {
  if (typeof value !== "string") {
    throw new VersionedTextStoreError("state-corrupt", "Versioned text store is corrupt.");
  }
}

function assertPersistedNormalizedString(value: unknown): asserts value is string {
  assertString(value);
  if (value.trim() !== value || !value) {
    throw new VersionedTextStoreError("state-corrupt", "Versioned text store is corrupt.");
  }
}

function assertPersistedGeneratedId(value: unknown): asserts value is string {
  assertPersistedNormalizedString(value);
  if (value.includes(ID_KEY_SEPARATOR)) {
    throw new VersionedTextStoreError("state-corrupt", "Versioned text store is corrupt.");
  }
}

function assertNumber(value: unknown): asserts value is number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new VersionedTextStoreError("state-corrupt", "Versioned text store is corrupt.");
  }
}

function assertRecord(value: unknown): asserts value is Record<string, unknown> {
  if (!isRecord(value)) {
    throw new VersionedTextStoreError("state-corrupt", "Versioned text store is corrupt.");
  }
}

function assertWriteMetadata(value: unknown): asserts value is ActorNeutralWriteMetadata {
  assertRecord(value);
  if (
    value.origin !== "api" &&
    value.origin !== "local-file" &&
    value.origin !== "restore" &&
    value.origin !== "sync" &&
    value.origin !== "unknown"
  ) {
    throw new VersionedTextStoreError("state-corrupt", "Versioned text store is corrupt.");
  }
  if (value.summary !== undefined && typeof value.summary !== "string") {
    throw new VersionedTextStoreError("state-corrupt", "Versioned text store is corrupt.");
  }
  if (value.correlationId !== undefined && typeof value.correlationId !== "string") {
    throw new VersionedTextStoreError("state-corrupt", "Versioned text store is corrupt.");
  }
}

function assertPersistedWritePath(value: unknown): asserts value is string {
  assertString(value);
  const result = validateUserWritePath(value);
  if (!result.ok || result.normalized !== value) {
    throw new VersionedTextStoreError("state-corrupt", "Versioned text store is corrupt.");
  }
}

function pickWriteMetadata(metadata: ActorNeutralWriteMetadata): ActorNeutralWriteMetadata {
  return {
    origin: metadata.origin,
    ...(metadata.summary !== undefined ? { summary: metadata.summary } : {}),
    ...(metadata.correlationId !== undefined ? { correlationId: metadata.correlationId } : {}),
  };
}

function sameWriteMetadata(
  left: ActorNeutralWriteMetadata,
  right: ActorNeutralWriteMetadata,
): boolean {
  const normalizedLeft = pickWriteMetadata(left);
  const normalizedRight = pickWriteMetadata(right);
  return (
    normalizedLeft.origin === normalizedRight.origin &&
    normalizedLeft.summary === normalizedRight.summary &&
    normalizedLeft.correlationId === normalizedRight.correlationId
  );
}

function cloneSnapshot(snapshot: TextFileSnapshot): TextFileSnapshot {
  return {
    objectId: snapshot.objectId,
    versionId: snapshot.versionId,
    path: snapshot.path,
    text: snapshot.text,
    updatedAtMs: snapshot.updatedAtMs,
    latestMomentId: snapshot.latestMomentId,
    metadata: pickWriteMetadata(snapshot.metadata),
  };
}

function cloneMoment(moment: VersionedTextMoment): VersionedTextMoment {
  return {
    id: moment.id,
    workspaceId: moment.workspaceId,
    versionId: moment.versionId,
    objectId: moment.objectId,
    path: moment.path,
    recordedAtMs: moment.recordedAtMs,
    operation: moment.operation,
    metadata: pickWriteMetadata(moment.metadata),
  };
}

function cloneVersion(version: VersionRecord): VersionRecord {
  return {
    id: version.id,
    workspaceId: version.workspaceId,
    kind: version.kind,
    name: version.name,
    createdAtMs: version.createdAtMs,
    ...(version.forkPoint
      ? {
          forkPoint: {
            versionId: version.forkPoint.versionId,
            ...(version.forkPoint.momentId ? { momentId: version.forkPoint.momentId } : {}),
          },
        }
      : {}),
  };
}

function cloneFileObject(object: FileObjectRecord): FileObjectRecord {
  return {
    id: object.id,
    workspaceId: object.workspaceId,
    createdAtMs: object.createdAtMs,
  };
}

function storePath(rootDir: string): string {
  return join(rootDir, VERSIONED_TEXT_STORE_RELATIVE_PATH);
}

function stateFileToken(stats: Stats): string {
  return [
    stats.dev,
    stats.ino,
    stats.size,
    stats.mtimeMs,
    stats.ctimeMs,
  ].join(":");
}

async function readJsonWithStateToken(path: string): Promise<{ raw: unknown; token: string }> {
  try {
    const deadlineMs = Date.now() + 5_000;
    let before = await stat(path);
    let text = await readFile(path, "utf8");
    let token = stateFileToken(before);
    let after = await stat(path);
    let afterToken = stateFileToken(after);
    while (token !== afterToken) {
      if (Date.now() > deadlineMs) {
        throw new VersionedTextStoreError(
          "persist-failed",
          "Versioned text store did not reach a stable readable state.",
        );
      }
      before = after;
      text = await readFile(path, "utf8");
      token = stateFileToken(before);
      after = await stat(path);
      afterToken = stateFileToken(after);
    }
    return {
      raw: JSON.parse(text) as unknown,
      token,
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { raw: undefined, token: "missing" };
    }
    if (error instanceof SyntaxError) {
      throw new VersionedTextStoreError("state-corrupt", "Versioned text store is corrupt.");
    }
    throw error;
  }
}

async function readStateToken(path: string): Promise<string> {
  try {
    return stateFileToken(await stat(path));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "missing";
    throw error;
  }
}

function normalizeState(raw: unknown): PersistedVersionedTextState {
  if (raw === undefined) return initialState();
  if (!isRecord(raw) || raw.schemaVersion !== 1 || !isRecord(raw.workspaces)) {
    throw new VersionedTextStoreError("state-corrupt", "Versioned text store is corrupt.");
  }
  const workspaces = createDictionary<PersistedWorkspaceState>();
  const seenVersionIds = new Map<VersionId, WorkspaceId>();
  const seenObjectIds = new Map<WorkspaceObjectId, WorkspaceId>();
  for (const [workspaceId, workspace] of Object.entries(raw.workspaces)) {
    assertWorkspaceState(workspaceId, workspace);
    const normalizedWorkspace = normalizeWorkspaceState(
      workspace as unknown as PersistedWorkspaceState,
    );

    for (const versionId of Object.keys(normalizedWorkspace.versions)) {
      if (versionId === "main") continue;
      const existingWorkspaceId = seenVersionIds.get(versionId);
      if (existingWorkspaceId !== undefined && existingWorkspaceId !== workspaceId) {
        throw new VersionedTextStoreError("state-corrupt", "Versioned text store is corrupt.");
      }
      seenVersionIds.set(versionId, workspaceId);
    }

    for (const objectId of Object.keys(normalizedWorkspace.objects)) {
      const existingWorkspaceId = seenObjectIds.get(objectId);
      if (existingWorkspaceId !== undefined && existingWorkspaceId !== workspaceId) {
        throw new VersionedTextStoreError("state-corrupt", "Versioned text store is corrupt.");
      }
      seenObjectIds.set(objectId, workspaceId);
    }

    workspaces[workspaceId] = normalizedWorkspace;
  }
  return { schemaVersion: 1, workspaces };
}

function normalizeWorkspaceState(workspace: PersistedWorkspaceState): PersistedWorkspaceState {
  return {
    mainVersionId: workspace.mainVersionId,
    versions: createDictionary(
      Object.entries(workspace.versions).map(([versionId, version]) => [
        versionId,
        cloneVersion(version),
      ]),
    ),
    objects: createDictionary(
      Object.entries(workspace.objects).map(([objectId, object]) => [
        objectId,
        cloneFileObject(object),
      ]),
    ),
    pathAliases: createDictionary(
      Object.entries(workspace.pathAliases).map(([versionId, aliases]) => [
        versionId,
        createDictionary(Object.entries(aliases)),
      ]),
    ),
    snapshots: createDictionary(
      Object.entries(workspace.snapshots).map(([versionId, snapshots]) => [
        versionId,
        createDictionary(
          Object.entries(snapshots).map(([objectId, snapshot]) => [
            objectId,
            cloneSnapshot(snapshot),
          ]),
        ),
      ]),
    ),
    moments: workspace.moments.map(cloneMoment),
  };
}

function assertWorkspaceState(workspaceId: string, value: unknown): void {
  assertPersistedNormalizedString(workspaceId);
  assertRecord(value);
  assertPersistedGeneratedId(value.mainVersionId);
  assertRecord(value.versions);
  assertRecord(value.objects);
  assertRecord(value.pathAliases);
  assertRecord(value.snapshots);
  if (!Array.isArray(value.moments)) {
    throw new VersionedTextStoreError("state-corrupt", "Versioned text store is corrupt.");
  }

  let mainVersionCount = 0;
  const seenVersionNames = new Set<string>();
  for (const version of Object.values(value.versions)) {
    assertRecord(version);
    assertPersistedGeneratedId(version.id);
    if (getOwn(value.versions, version.id) !== version) {
      throw new VersionedTextStoreError("state-corrupt", "Versioned text store is corrupt.");
    }
    assertPersistedNormalizedString(version.workspaceId);
    if (version.workspaceId !== workspaceId) {
      throw new VersionedTextStoreError("state-corrupt", "Versioned text store is corrupt.");
    }
    if (version.kind !== "main" && version.kind !== "named") {
      throw new VersionedTextStoreError("state-corrupt", "Versioned text store is corrupt.");
    }
    if (version.kind !== "main" && version.id === "main") {
      throw new VersionedTextStoreError("state-corrupt", "Versioned text store is corrupt.");
    }
    if (version.kind === "main") {
      mainVersionCount += 1;
      if (version.forkPoint !== undefined) {
        throw new VersionedTextStoreError("state-corrupt", "Versioned text store is corrupt.");
      }
    } else if (version.forkPoint === undefined) {
      throw new VersionedTextStoreError("state-corrupt", "Versioned text store is corrupt.");
    }
    assertPersistedNormalizedString(version.name);
    if (seenVersionNames.has(version.name)) {
      throw new VersionedTextStoreError("state-corrupt", "Versioned text store is corrupt.");
    }
    seenVersionNames.add(version.name);
    assertNumber(version.createdAtMs);
    if (version.forkPoint !== undefined) {
      assertRecord(version.forkPoint);
      assertPersistedGeneratedId(version.forkPoint.versionId);
      if (getOwn(value.versions, version.forkPoint.versionId) === undefined) {
        throw new VersionedTextStoreError("state-corrupt", "Versioned text store is corrupt.");
      }
      if (
        version.forkPoint.momentId !== undefined &&
        (typeof version.forkPoint.momentId !== "string" ||
          version.forkPoint.momentId.includes(ID_KEY_SEPARATOR))
      ) {
        throw new VersionedTextStoreError("state-corrupt", "Versioned text store is corrupt.");
      }
    }
  }

  for (const version of Object.values(value.versions)) {
    assertRecord(version);
    assertPersistedGeneratedId(version.id);
    const seen = new Set<VersionId>();
    let cursor: unknown = version;
    while (isRecord(cursor) && isRecord(cursor.forkPoint)) {
      assertPersistedGeneratedId(cursor.id);
      if (seen.has(cursor.id)) {
        throw new VersionedTextStoreError("state-corrupt", "Versioned text store is corrupt.");
      }
      seen.add(cursor.id);
      assertPersistedGeneratedId(cursor.forkPoint.versionId);
      cursor = getOwn(value.versions, cursor.forkPoint.versionId);
    }
  }

  if (getOwn(value.versions, value.mainVersionId) === undefined) {
    throw new VersionedTextStoreError("state-corrupt", "Versioned text store is corrupt.");
  }
  const mainVersion = getOwn(value.versions, value.mainVersionId);
  if (mainVersionCount !== 1 || !isRecord(mainVersion) || mainVersion.kind !== "main") {
    throw new VersionedTextStoreError("state-corrupt", "Versioned text store is corrupt.");
  }

  for (const object of Object.values(value.objects)) {
    assertRecord(object);
    assertPersistedGeneratedId(object.id);
    if (getOwn(value.objects, object.id) !== object) {
      throw new VersionedTextStoreError("state-corrupt", "Versioned text store is corrupt.");
    }
    assertString(object.workspaceId);
    if (object.workspaceId !== workspaceId) {
      throw new VersionedTextStoreError("state-corrupt", "Versioned text store is corrupt.");
    }
    assertNumber(object.createdAtMs);
  }

  const referencedObjectIds = new Set<WorkspaceObjectId>();
  for (const [versionId, aliases] of Object.entries(value.pathAliases)) {
    if (getOwn(value.versions, versionId) === undefined) {
      throw new VersionedTextStoreError("state-corrupt", "Versioned text store is corrupt.");
    }
    assertRecord(aliases);
    for (const [path, objectId] of Object.entries(aliases)) {
      assertPersistedWritePath(path);
      assertPersistedGeneratedId(objectId);
      if (getOwn(value.objects, objectId) === undefined) {
        throw new VersionedTextStoreError("state-corrupt", "Versioned text store is corrupt.");
      }
      const versionSnapshots = getOwn(value.snapshots, versionId);
      if (!isRecord(versionSnapshots)) {
        throw new VersionedTextStoreError("state-corrupt", "Versioned text store is corrupt.");
      }
      const aliasedSnapshot = getOwn(versionSnapshots, objectId);
      if (!isRecord(aliasedSnapshot) || aliasedSnapshot.path !== path) {
        throw new VersionedTextStoreError("state-corrupt", "Versioned text store is corrupt.");
      }
      referencedObjectIds.add(objectId);
    }
  }

  for (const [versionId, snapshots] of Object.entries(value.snapshots)) {
    if (getOwn(value.versions, versionId) === undefined) {
      throw new VersionedTextStoreError("state-corrupt", "Versioned text store is corrupt.");
    }
    assertRecord(snapshots);
    const seenSnapshotPaths = new Map<string, WorkspaceObjectId>();
    for (const [objectId, snapshot] of Object.entries(snapshots)) {
      assertRecord(snapshot);
      assertPersistedGeneratedId(snapshot.objectId);
      if (snapshot.objectId !== objectId || getOwn(value.objects, objectId) === undefined) {
        throw new VersionedTextStoreError("state-corrupt", "Versioned text store is corrupt.");
      }
      assertString(snapshot.versionId);
      if (snapshot.versionId !== versionId) {
        throw new VersionedTextStoreError("state-corrupt", "Versioned text store is corrupt.");
      }
      assertPersistedWritePath(snapshot.path);
      const existingObjectId = seenSnapshotPaths.get(snapshot.path);
      if (existingObjectId !== undefined && existingObjectId !== objectId) {
        throw new VersionedTextStoreError("state-corrupt", "Versioned text store is corrupt.");
      }
      seenSnapshotPaths.set(snapshot.path, objectId);
      referencedObjectIds.add(objectId);
      assertString(snapshot.text);
      assertNumber(snapshot.updatedAtMs);
      assertPersistedGeneratedId(snapshot.latestMomentId);
      assertWriteMetadata(snapshot.metadata);
    }
  }

  const momentsById = new Map<VersionedTextMomentId, VersionedTextMoment>();
  const momentIndexes = new Map<VersionedTextMomentId, number>();
  const momentsByVersionObject = new Map<string, VersionedTextMoment[]>();
  const persistedMoments: VersionedTextMoment[] = [];
  for (const [index, moment] of value.moments.entries()) {
    assertRecord(moment);
    assertPersistedGeneratedId(moment.id);
    assertString(moment.workspaceId);
    if (moment.workspaceId !== workspaceId) {
      throw new VersionedTextStoreError("state-corrupt", "Versioned text store is corrupt.");
    }
    assertPersistedGeneratedId(moment.versionId);
    if (getOwn(value.versions, moment.versionId) === undefined) {
      throw new VersionedTextStoreError("state-corrupt", "Versioned text store is corrupt.");
    }
    assertPersistedGeneratedId(moment.objectId);
    if (getOwn(value.objects, moment.objectId) === undefined) {
      throw new VersionedTextStoreError("state-corrupt", "Versioned text store is corrupt.");
    }
    referencedObjectIds.add(moment.objectId);
    assertPersistedWritePath(moment.path);
    assertNumber(moment.recordedAtMs);
    if (moment.operation !== "write" && moment.operation !== "rename") {
      throw new VersionedTextStoreError("state-corrupt", "Versioned text store is corrupt.");
    }
    assertWriteMetadata(moment.metadata);
    if (momentsById.has(moment.id)) {
      throw new VersionedTextStoreError("state-corrupt", "Versioned text store is corrupt.");
    }
    const persistedMoment = moment as unknown as VersionedTextMoment;
    momentsById.set(moment.id, persistedMoment);
    momentIndexes.set(moment.id, index);
    const bucketKey = versionObjectKey(persistedMoment.versionId, persistedMoment.objectId);
    const bucket = momentsByVersionObject.get(bucketKey) ?? [];
    bucket.push(persistedMoment);
    momentsByVersionObject.set(bucketKey, bucket);
    persistedMoments.push(persistedMoment);
  }

  for (const objectId of Object.keys(value.objects)) {
    if (!referencedObjectIds.has(objectId)) {
      throw new VersionedTextStoreError("state-corrupt", "Versioned text store is corrupt.");
    }
  }

  const latestMomentCache = new Map<string, VersionedTextMoment | null>();
  const latestMomentForObject = (
    versionId: VersionId,
    objectId: WorkspaceObjectId,
    maxIndex = persistedMoments.length - 1,
  ): VersionedTextMoment | null => {
    const cacheKey = `${versionObjectKey(versionId, objectId)}${ID_KEY_SEPARATOR}${maxIndex}`;
    if (latestMomentCache.has(cacheKey)) return latestMomentCache.get(cacheKey) ?? null;
    const bucket = momentsByVersionObject.get(versionObjectKey(versionId, objectId)) ?? [];
    for (let index = bucket.length - 1; index >= 0; index -= 1) {
      const moment = bucket[index];
      const persistedIndex = momentIndexes.get(moment.id);
      if (persistedIndex !== undefined && persistedIndex <= maxIndex) {
        latestMomentCache.set(cacheKey, moment);
        return moment;
      }
    }
    latestMomentCache.set(cacheKey, null);
    return null;
  };

  const inheritedLatestMomentCache = new Map<string, VersionedTextMoment | null>();
  const inheritedLatestMomentForObject = (
    versionId: VersionId,
    objectId: WorkspaceObjectId,
    seen = new Set<VersionId>(),
  ): VersionedTextMoment | null => {
    const cacheKey = versionObjectKey(versionId, objectId);
    if (seen.size === 0 && inheritedLatestMomentCache.has(cacheKey)) {
      return inheritedLatestMomentCache.get(cacheKey) ?? null;
    }
    if (seen.has(versionId)) {
      throw new VersionedTextStoreError("state-corrupt", "Versioned text store is corrupt.");
    }
    seen.add(versionId);
    const version = getOwn(value.versions as Record<string, unknown>, versionId);
    if (!isRecord(version) || !isRecord(version.forkPoint)) {
      inheritedLatestMomentCache.set(cacheKey, null);
      return null;
    }
    assertPersistedGeneratedId(version.forkPoint.versionId);
    const forkMomentId = version.forkPoint.momentId;
    let forkIndex = -1;
    if (forkMomentId !== undefined) {
      assertPersistedGeneratedId(forkMomentId);
      const persistedForkIndex = momentIndexes.get(forkMomentId);
      if (persistedForkIndex === undefined) {
        throw new VersionedTextStoreError("state-corrupt", "Versioned text store is corrupt.");
      }
      forkIndex = persistedForkIndex;
    }
    const sourceLatest = latestMomentForObject(version.forkPoint.versionId, objectId, forkIndex);
    const inherited =
      sourceLatest ?? inheritedLatestMomentForObject(version.forkPoint.versionId, objectId, seen);
    inheritedLatestMomentCache.set(cacheKey, inherited);
    return inherited;
  };

  for (const version of Object.values(value.versions)) {
    assertRecord(version);
    assertString(version.id);
    if (version.forkPoint !== undefined && isRecord(version.forkPoint)) {
      assertPersistedGeneratedId(version.forkPoint.versionId);
      const momentId = version.forkPoint.momentId;
      if (momentId !== undefined) {
        assertPersistedGeneratedId(momentId);
        const forkMoment = momentsById.get(momentId);
        if (!forkMoment || forkMoment.versionId !== version.forkPoint.versionId) {
          throw new VersionedTextStoreError("state-corrupt", "Versioned text store is corrupt.");
        }
      }
    }
  }

  for (const [versionId, snapshots] of Object.entries(value.snapshots)) {
    assertRecord(snapshots);
    const version = getOwn(value.versions, versionId);
    assertRecord(version);
    for (const [objectId, snapshot] of Object.entries(snapshots)) {
      assertRecord(snapshot);
      assertString(snapshot.latestMomentId);
      const persistedSnapshot = snapshot as unknown as TextFileSnapshot;
      const latestMoment = momentsById.get(persistedSnapshot.latestMomentId);
      if (
        !latestMoment ||
        latestMoment.objectId !== objectId ||
        latestMoment.path !== persistedSnapshot.path
      ) {
        throw new VersionedTextStoreError("state-corrupt", "Versioned text store is corrupt.");
      }
      if (
        persistedSnapshot.updatedAtMs !== latestMoment.recordedAtMs ||
        !sameWriteMetadata(persistedSnapshot.metadata, latestMoment.metadata)
      ) {
        throw new VersionedTextStoreError("state-corrupt", "Versioned text store is corrupt.");
      }
      if (latestMoment.versionId === versionId) {
        const expected = latestMomentForObject(versionId, objectId);
        if (expected?.id !== persistedSnapshot.latestMomentId) {
          throw new VersionedTextStoreError("state-corrupt", "Versioned text store is corrupt.");
        }
        continue;
      }

      const expected = inheritedLatestMomentForObject(versionId, objectId);
      if (expected?.id !== persistedSnapshot.latestMomentId) {
        throw new VersionedTextStoreError("state-corrupt", "Versioned text store is corrupt.");
      }
    }
  }

  for (const versionId of Object.keys(value.versions)) {
    const snapshots = getOwn(value.snapshots, versionId);
    const aliases = getOwn(value.pathAliases, versionId);
    assertRecord(snapshots);
    assertRecord(aliases);
    for (const objectId of Object.keys(value.objects)) {
      const expectedMoment =
        latestMomentForObject(versionId, objectId) ??
        inheritedLatestMomentForObject(versionId, objectId);
      if (!expectedMoment) continue;
      const snapshot = getOwn(snapshots, objectId);
      if (
        !isRecord(snapshot) ||
        snapshot.path !== expectedMoment.path ||
        snapshot.latestMomentId !== expectedMoment.id ||
        getOwn(aliases, expectedMoment.path) !== objectId
      ) {
        throw new VersionedTextStoreError("state-corrupt", "Versioned text store is corrupt.");
      }
    }
  }
}

function versionObjectKey(versionId: VersionId, objectId: WorkspaceObjectId): string {
  return `${versionId}${ID_KEY_SEPARATOR}${objectId}`;
}

async function writeFileAtomic(path: string, data: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await replaceFileAtomic(path, data);
}

async function writeExistingFileAtomic(path: string, data: string): Promise<void> {
  await replaceFileAtomic(path, data);
}

async function replaceFileAtomic(path: string, data: string): Promise<void> {
  const tmp = `${path}.tmp-${process.pid}-${process.hrtime.bigint()}`;
  try {
    await writeFileDurably(tmp, data);
    await rename(tmp, path);
    await syncParentDirectory(path);
  } catch (error) {
    await rm(tmp, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function writeFileDurably(path: string, data: string): Promise<void> {
  const handle = await open(path, "w", 0o600);
  try {
    await handle.writeFile(data, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function syncParentDirectory(path: string): Promise<void> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(dirname(path), "r");
    await handle.sync();
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (
      code !== "EINVAL" &&
      code !== "EPERM" &&
      code !== "EISDIR" &&
      code !== "ENOTSUP" &&
      code !== "EOPNOTSUPP"
    ) {
      throw error;
    }
  } finally {
    await handle?.close();
  }
}

function delayMs(ms: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

interface StoreLockOwner {
  token: string;
  pid: number;
  createdAtMs: number;
  heartbeatAtMs: number;
}

function createLockOwner(token: string): StoreLockOwner {
  const nowMs = Date.now();
  return { token, pid: process.pid, createdAtMs: nowMs, heartbeatAtMs: nowMs };
}

function serializeLockOwner(owner: StoreLockOwner): string {
  return `${JSON.stringify(owner)}\n`;
}

function parseLockOwner(text: string): StoreLockOwner | null {
  try {
    const value = JSON.parse(text) as Partial<StoreLockOwner>;
    if (
      typeof value.token !== "string" ||
      typeof value.pid !== "number" ||
      !Number.isFinite(value.pid) ||
      typeof value.createdAtMs !== "number" ||
      !Number.isFinite(value.createdAtMs) ||
      typeof value.heartbeatAtMs !== "number" ||
      !Number.isFinite(value.heartbeatAtMs)
    ) {
      return null;
    }
    return value as StoreLockOwner;
  } catch {
    return null;
  }
}

function lockOwnershipLost(cause?: unknown): VersionedTextStoreError {
  const wrapped = new VersionedTextStoreError(
    "persist-failed",
    "Versioned text store lock ownership was lost.",
  );
  if (cause !== undefined) {
    (wrapped as Error & { cause?: unknown }).cause = cause;
  }
  return wrapped;
}

async function isBlockedByStaleLock(
  lockDirPath: string,
  ownerPath: string,
  staleMs: number,
): Promise<boolean> {
  try {
    const lockStats = await stat(lockDirPath);
    const ownerText = await readFile(ownerPath, "utf8");
    const owner = parseLockOwner(ownerText);
    if (!owner) {
      return Date.now() - lockStats.mtimeMs > staleMs;
    }
    return Date.now() - owner.heartbeatAtMs > staleMs;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      const lockStats = await stat(lockDirPath).catch(() => null);
      return lockStats ? Date.now() - lockStats.mtimeMs > staleMs : false;
    }
    throw error;
  }
}

interface StoreLockLease {
  assertHealthy: () => Promise<void>;
  release: () => Promise<void>;
}

async function acquireStoreLock(
  lockDirPath: string,
  lockTimeoutMs: number,
  lockStaleMs: number,
  onLockBlocked?: () => void | Promise<void>,
): Promise<StoreLockLease> {
  await mkdir(dirname(lockDirPath), { recursive: true, mode: 0o700 });
  const ownerPath = join(lockDirPath, "owner.json");
  const startedAt = Date.now();
  while (true) {
    try {
      await mkdir(lockDirPath, { mode: 0o700 });
      const token = randomUUID();
      let heartbeatFailure: unknown = null;
      let released = false;
      const heartbeatWrites = new Set<Promise<void>>();
      const trackHeartbeatWrite = (write: Promise<void>) => {
        let tracked: Promise<void>;
        tracked = write
          .catch((error: unknown) => {
            heartbeatFailure = error;
          })
          .finally(() => {
            heartbeatWrites.delete(tracked);
          });
        heartbeatWrites.add(tracked);
      };
      try {
        await writeExistingFileAtomic(ownerPath, serializeLockOwner(createLockOwner(token)));
      } catch (error) {
        await rm(lockDirPath, { recursive: true, force: true }).catch(() => undefined);
        throw error;
      }
      let heartbeatWritePending = false;
      const heartbeat = setInterval(() => {
        if (released) return;
        if (heartbeatWritePending) return;
        heartbeatWritePending = true;
        trackHeartbeatWrite(
          writeExistingFileAtomic(ownerPath, serializeLockOwner(createLockOwner(token))).finally(
            () => {
              heartbeatWritePending = false;
            },
          ),
        );
      }, 5_000);
      return {
        assertHealthy: async () => {
          if (heartbeatFailure) {
            const wrapped = new VersionedTextStoreError(
              "persist-failed",
              "Versioned text store lock heartbeat failed.",
            );
            (wrapped as Error & { cause?: unknown }).cause = heartbeatFailure;
            throw wrapped;
          }
          let owner: StoreLockOwner | null;
          try {
            owner = parseLockOwner(await readFile(ownerPath, "utf8"));
          } catch (error) {
            throw lockOwnershipLost(error);
          }
          if (owner?.token !== token) {
            throw lockOwnershipLost();
          }
        },
        release: async () => {
          released = true;
          clearInterval(heartbeat);
          while (heartbeatWrites.size > 0) {
            await Promise.all([...heartbeatWrites]);
          }
          try {
            const owner = parseLockOwner(await readFile(ownerPath, "utf8"));
            if (owner?.token === token) {
              await rm(lockDirPath, { recursive: true, force: true });
            }
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          }
        },
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      await onLockBlocked?.();
      if (await isBlockedByStaleLock(lockDirPath, ownerPath, lockStaleMs)) {
        throw new VersionedTextStoreError(
          "persist-failed",
          "Versioned text store lock is stale and requires manual recovery.",
        );
      }
      if (Date.now() - startedAt > lockTimeoutMs) {
        throw new VersionedTextStoreError(
          "persist-failed",
          "Versioned text store lock timed out.",
        );
      }
      await delayMs(25);
    }
  }
}

function normalizeWorkspaceId(workspaceId: string): WorkspaceId {
  if (typeof workspaceId !== "string") {
    throw new VersionedTextStoreError("invalid-workspace", "Workspace id is required.");
  }
  if (!workspaceId || workspaceId.trim() !== workspaceId) {
    throw new VersionedTextStoreError("invalid-workspace", "Workspace id is required.");
  }
  return workspaceId;
}

function normalizeVersionName(name: string): string {
  if (typeof name !== "string") {
    throw new VersionedTextStoreError("invalid-version-name", "Version name is required.");
  }
  if (!name || name.trim() !== name) {
    throw new VersionedTextStoreError("invalid-version-name", "Version name is required.");
  }
  return name;
}

function normalizeInputId(
  value: string,
  code: "invalid-object" | "invalid-version",
  label: string,
): string {
  if (
    typeof value !== "string" ||
    !value ||
    value.trim() !== value ||
    value.includes(ID_KEY_SEPARATOR)
  ) {
    throw new VersionedTextStoreError(code, `${label} id is invalid.`);
  }
  return value;
}

function normalizeVersionId(versionId: VersionId): VersionId {
  return normalizeInputId(versionId, "invalid-version", "Version");
}

function normalizeObjectId(objectId: WorkspaceObjectId): WorkspaceObjectId {
  return normalizeInputId(objectId, "invalid-object", "Object");
}

function assertInputEnvelope(input: unknown): asserts input is Record<string, unknown> {
  if (!isRecord(input)) {
    throw new VersionedTextStoreError("invalid-input", "Versioned text store input is required.");
  }
}

function normalizeRootDir(rootDir: string): string {
  if (typeof rootDir !== "string" || !rootDir || rootDir.trim() !== rootDir) {
    throw new VersionedTextStoreError("invalid-root", "Versioned text store root is required.");
  }
  return rootDir;
}

function normalizeTimestamp(value: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new VersionedTextStoreError(
      "invalid-timestamp",
      "Versioned text store clock returned an invalid timestamp.",
    );
  }
  return value;
}

function normalizeWritePath(path: string): string {
  if (typeof path !== "string") {
    throw new VersionedTextStoreError("invalid-path", "Workspace path must be a string.");
  }
  const result = validateUserWritePath(path);
  if (!result.ok) {
    throw new VersionedTextStoreError(
      "invalid-path",
      `Invalid workspace path ${JSON.stringify(path)}: ${result.reason}`,
    );
  }
  return result.normalized;
}

function normalizeWriteText(text: string): string {
  if (typeof text !== "string") {
    throw new VersionedTextStoreError("invalid-text", "Text file contents must be a string.");
  }
  return text;
}

function normalizeWriteMetadata(metadata: ActorNeutralWriteMetadata): ActorNeutralWriteMetadata {
  if (!isRecord(metadata)) {
    throw new VersionedTextStoreError("invalid-metadata", "Write metadata must be an object.");
  }
  if (
    metadata.origin !== "api" &&
    metadata.origin !== "local-file" &&
    metadata.origin !== "restore" &&
    metadata.origin !== "sync" &&
    metadata.origin !== "unknown"
  ) {
    throw new VersionedTextStoreError("invalid-metadata", "Write metadata origin is invalid.");
  }
  if (metadata.summary !== undefined && typeof metadata.summary !== "string") {
    throw new VersionedTextStoreError("invalid-metadata", "Write metadata summary is invalid.");
  }
  if (metadata.correlationId !== undefined && typeof metadata.correlationId !== "string") {
    throw new VersionedTextStoreError(
      "invalid-metadata",
      "Write metadata correlation id is invalid.",
    );
  }
  return pickWriteMetadata(metadata);
}

function rejectDuplicateId(kind: "moment" | "object" | "version", id: string): never {
  throw new VersionedTextStoreError("duplicate-id", `Generated ${kind} id ${id} already exists.`);
}

function normalizeGeneratedId(kind: "moment" | "object" | "version", id: unknown): string {
  if (
    typeof id !== "string" ||
    id.trim() !== id ||
    !id ||
    id.includes(ID_KEY_SEPARATOR)
  ) {
    throw new VersionedTextStoreError(
      "invalid-generated-id",
      `Generated ${kind} id is invalid.`,
    );
  }
  return id;
}

function defaultCreateId(kind: "moment" | "object" | "version"): string {
  return `${kind}_${randomUUID()}`;
}

function ensureWorkspace(
  state: PersistedVersionedTextState,
  workspaceId: WorkspaceId,
  nowMs: number,
): PersistedWorkspaceState {
  const existing = getOwn(state.workspaces, workspaceId);
  if (existing) return existing;

  const main: VersionRecord = {
    id: "main",
    workspaceId,
    kind: "main",
    name: "Main",
    createdAtMs: nowMs,
  };
  const workspace: PersistedWorkspaceState = {
    mainVersionId: main.id,
    versions: createDictionary([[main.id, main]]),
    objects: createDictionary(),
    pathAliases: createDictionary([[main.id, createDictionary<WorkspaceObjectId>()]]),
    snapshots: createDictionary([[main.id, createDictionary<TextFileSnapshot>()]]),
    moments: [],
  };
  state.workspaces[workspaceId] = workspace;
  return workspace;
}

function versionExistsInAnotherWorkspace(
  state: PersistedVersionedTextState,
  workspaceId: WorkspaceId,
  versionId: VersionId,
): boolean {
  if (versionId === "main") return false;
  return Object.entries(state.workspaces).some(
    ([candidateWorkspaceId, workspace]) =>
      candidateWorkspaceId !== workspaceId && getOwn(workspace.versions, versionId) !== undefined,
  );
}

function objectExistsInAnotherWorkspace(
  state: PersistedVersionedTextState,
  workspaceId: WorkspaceId,
  objectId: WorkspaceObjectId,
): boolean {
  return Object.entries(state.workspaces).some(
    ([candidateWorkspaceId, workspace]) =>
      candidateWorkspaceId !== workspaceId && getOwn(workspace.objects, objectId) !== undefined,
  );
}

function requireWorkspaceVersion(
  state: PersistedVersionedTextState,
  workspaceId: WorkspaceId,
  versionId: VersionId,
): { workspace: PersistedWorkspaceState; version: VersionRecord } {
  const workspace = getOwn(state.workspaces, workspaceId);
  const version = workspace ? getOwn(workspace.versions, versionId) : undefined;
  if (!workspace || !version) {
    if (versionExistsInAnotherWorkspace(state, workspaceId, versionId)) {
      throw new VersionedTextStoreError(
        "workspace-mismatch",
        `Version ${versionId} does not belong to workspace ${workspaceId}.`,
      );
    }
    throw new VersionedTextStoreError(
      "version-not-found",
      `Version ${versionId} was not found in workspace ${workspaceId}.`,
    );
  }
  return { workspace, version };
}

function latestMomentIdForVersion(
  workspace: PersistedWorkspaceState,
  versionId: VersionId,
): VersionedTextMomentId | undefined {
  for (let index = workspace.moments.length - 1; index >= 0; index -= 1) {
    const moment = workspace.moments[index];
    if (moment.versionId === versionId) return moment.id;
  }
  return undefined;
}

function findObjectIdByVersionPath(
  workspace: PersistedWorkspaceState,
  versionId: VersionId,
  path: string,
): WorkspaceObjectId | null {
  const aliases = getOwn(workspace.pathAliases, versionId);
  const aliasedObjectId = aliases ? (getOwn(aliases, path) ?? null) : null;
  if (aliasedObjectId) return aliasedObjectId;
  const snapshots = getOwn(workspace.snapshots, versionId) ?? createDictionary<TextFileSnapshot>();
  for (const snapshot of Object.values(snapshots)) {
    if (snapshot.path === path) return snapshot.objectId;
  }
  return null;
}

function pathAliasesForVersion(
  workspace: PersistedWorkspaceState,
  versionId: VersionId,
): Record<string, WorkspaceObjectId> {
  const existing = getOwn(workspace.pathAliases, versionId);
  if (existing) return existing;
  const aliases = createDictionary<WorkspaceObjectId>();
  workspace.pathAliases[versionId] = aliases;
  return aliases;
}

function createMoment(input: {
  id: VersionedTextMomentId;
  workspaceId: WorkspaceId;
  versionId: VersionId;
  objectId: WorkspaceObjectId;
  path: string;
  recordedAtMs: number;
  operation: "write" | "rename";
  metadata: ActorNeutralWriteMetadata;
}): VersionedTextMoment {
  return {
    id: input.id,
    workspaceId: input.workspaceId,
    versionId: input.versionId,
    objectId: input.objectId,
    path: input.path,
    recordedAtMs: input.recordedAtMs,
    operation: input.operation,
    metadata: pickWriteMetadata(input.metadata),
  };
}

function createVersionedTextStoreWithHooks(
  rootDir: string,
  options: VersionedTextStoreOptions = {},
  testHooks: VersionedTextStoreTestHooks = {},
): VersionedTextStore {
  const nowMs = options.nowMs ?? (() => Date.now());
  const readNowMs = () => normalizeTimestamp(nowMs());
  const createId = options.createId ?? defaultCreateId;
  const createGeneratedId = (kind: "moment" | "object" | "version") =>
    normalizeGeneratedId(kind, createId(kind));
  const stateFilePath = storePath(resolve(normalizeRootDir(rootDir)));
  const lockDirPath = `${stateFilePath}.lock`;
  let cachedState: PersistedVersionedTextState | null = null;
  let cachedStateToken: string | null = null;
  let activeLease: StoreLockLease | null = null;

  async function readStateFromDisk(): Promise<{
    state: PersistedVersionedTextState;
    token: string;
  }> {
    const { raw, token } = await readJsonWithStateToken(stateFilePath);
    return { state: normalizeState(raw), token };
  }

  async function loadState(): Promise<PersistedVersionedTextState> {
    const currentToken = await readStateToken(stateFilePath);
    if (cachedState && cachedStateToken === currentToken) return cachedState;
    const { state, token } = await readStateFromDisk();
    if (cachedState && cachedStateToken === token) return cachedState;
    cachedState = state;
    cachedStateToken = token;
    return cachedState;
  }

  async function loadWritableState(): Promise<PersistedVersionedTextState> {
    const { state } = await readStateFromDisk();
    await testHooks.afterLoadWritableState?.();
    return state;
  }

  async function saveState(state: PersistedVersionedTextState): Promise<void> {
    const normalized = normalizeState(cloneJson(state));
    const serialized = `${JSON.stringify(normalized, null, 2)}\n`;
    try {
      await testHooks.beforePersist?.();
      if (!activeLease) {
        throw new VersionedTextStoreError(
          "persist-failed",
          "Versioned text store write lock is required.",
        );
      }
      await activeLease.assertHealthy();
      await writeFileAtomic(stateFilePath, serialized);
      cachedStateToken = await readStateToken(stateFilePath);
    } catch (error) {
      const wrapped = new VersionedTextStoreError(
        "persist-failed",
        "Versioned text store could not be persisted.",
      );
      (wrapped as Error & { cause?: unknown }).cause = error;
      throw wrapped;
    }
    cachedState = normalized;
  }

  async function runWithStoreLock<T>(task: () => Promise<T>): Promise<T> {
    const lease = await acquireStoreLock(
      lockDirPath,
      testHooks.lockTimeoutMs ?? STORE_LOCK_TIMEOUT_MS,
      testHooks.lockStaleMs ?? STORE_LOCK_STALE_MS,
      testHooks.onLockBlocked,
    );
    const previousLease = activeLease;
    activeLease = lease;
    try {
      await lease.assertHealthy();
      const result = await task();
      await lease.assertHealthy();
      return result;
    } finally {
      activeLease = previousLease;
      await lease.release();
    }
  }

  function serialize<T>(task: () => Promise<T>): Promise<T> {
    const queuedBehindExistingWrite = storeWriteChains.has(stateFilePath);
    if (queuedBehindExistingWrite) {
      testHooks.onWriteQueued?.();
    }
    const previous = storeWriteChains.get(stateFilePath) ?? Promise.resolve();
    const run = previous.then(() => runWithStoreLock(task), () => runWithStoreLock(task));
    const next = run.then(
      () => undefined,
      () => undefined,
    );
    storeWriteChains.set(stateFilePath, next);
    next.finally(() => {
      if (storeWriteChains.get(stateFilePath) === next) {
        storeWriteChains.delete(stateFilePath);
      }
    });
    return run;
  }

  async function afterWrites<T>(task: () => Promise<T>): Promise<T> {
    await (storeWriteChains.get(stateFilePath) ?? Promise.resolve());
    return task();
  }

  return {
    ensureMainVersion(input) {
      return serialize(async () => {
        assertInputEnvelope(input);
        const workspaceId = normalizeWorkspaceId(input.workspaceId);
        const state = await loadWritableState();
        const existing = getOwn(state.workspaces, workspaceId);
        if (existing) {
          const main = getOwn(existing.versions, existing.mainVersionId);
          if (!main) {
            throw new VersionedTextStoreError("state-corrupt", "Versioned text store is corrupt.");
          }
          return cloneVersion(main);
        }
        const workspace = ensureWorkspace(state, workspaceId, readNowMs());
        await saveState(state);
        return cloneVersion(workspace.versions[workspace.mainVersionId]);
      });
    },

    getMainVersion(input) {
      return afterWrites(async () => {
        assertInputEnvelope(input);
        const workspaceId = normalizeWorkspaceId(input.workspaceId);
        const state = await loadState();
        const workspace = getOwn(state.workspaces, workspaceId);
        const version = workspace
          ? (getOwn(workspace.versions, workspace.mainVersionId) ?? null)
          : null;
        return version ? cloneVersion(version) : null;
      });
    },

    createNamedVersion(input) {
      return serialize(async () => {
        assertInputEnvelope(input);
        const workspaceId = normalizeWorkspaceId(input.workspaceId);
        const name = normalizeVersionName(input.name);
        const fromVersionId = normalizeVersionId(input.fromVersionId);
        const state = await loadWritableState();
        const { workspace, version: source } = requireWorkspaceVersion(
          state,
          workspaceId,
          fromVersionId,
        );
        if (Object.values(workspace.versions).some((version) => version.name === name)) {
          throw new VersionedTextStoreError(
            "version-name-conflict",
            `Version ${JSON.stringify(name)} already exists.`,
          );
        }

        const id = createGeneratedId("version");
        if (
          getOwn(workspace.versions, id) !== undefined ||
          versionExistsInAnotherWorkspace(state, workspaceId, id)
        ) {
          rejectDuplicateId("version", id);
        }
        const createdAtMs = readNowMs();
        const latestMomentId = latestMomentIdForVersion(workspace, source.id);
        const version: VersionRecord = {
          id,
          workspaceId,
          kind: "named",
          name,
          createdAtMs,
          forkPoint: {
            versionId: source.id,
            ...(latestMomentId ? { momentId: latestMomentId } : {}),
          },
        };

        workspace.versions[id] = version;
        const sourceSnapshots =
          getOwn(workspace.snapshots, source.id) ?? createDictionary<TextFileSnapshot>();
        workspace.snapshots[id] = createDictionary<TextFileSnapshot>(
          Object.entries(sourceSnapshots).map(([objectId, snapshot]) => [
            objectId,
            { ...cloneSnapshot(snapshot), versionId: id },
          ]),
        );
        workspace.pathAliases[id] = createDictionary<WorkspaceObjectId>(
          Object.entries(
            getOwn(workspace.pathAliases, source.id) ?? createDictionary<WorkspaceObjectId>(),
          ),
        );
        await saveState(state);
        return cloneVersion(version);
      });
    },

    listVersions(input) {
      return afterWrites(async () => {
        assertInputEnvelope(input);
        const workspaceId = normalizeWorkspaceId(input.workspaceId);
        const state = await loadState();
        const workspace = getOwn(state.workspaces, workspaceId);
        if (!workspace) return [];
        return Object.values(workspace.versions)
          .sort((a, b) => a.createdAtMs - b.createdAtMs || a.name.localeCompare(b.name))
          .map(cloneVersion);
      });
    },

    writeTextFile(input) {
      return serialize(async () => {
        assertInputEnvelope(input);
        const workspaceId = normalizeWorkspaceId(input.workspaceId);
        const versionId = normalizeVersionId(input.versionId);
        const path = normalizeWritePath(input.path);
        const text = normalizeWriteText(input.text);
        const metadata = normalizeWriteMetadata(input.metadata);
        const state = await loadWritableState();
        const { workspace } = requireWorkspaceVersion(state, workspaceId, versionId);
        const existingObjectId = findObjectIdByVersionPath(workspace, versionId, path);
        const recordedAtMs = readNowMs();
        let objectId = existingObjectId;
        let newObject: FileObjectRecord | null = null;

        if (!objectId) {
          objectId = createGeneratedId("object");
          if (
            getOwn(workspace.objects, objectId) !== undefined ||
            objectExistsInAnotherWorkspace(state, workspaceId, objectId)
          ) {
            rejectDuplicateId("object", objectId);
          }
          newObject = {
            id: objectId,
            workspaceId,
            createdAtMs: recordedAtMs,
          };
        }

        const momentId = createGeneratedId("moment");
        if (workspace.moments.some((moment) => moment.id === momentId)) {
          rejectDuplicateId("moment", momentId);
        }
        if (newObject) {
          workspace.objects[objectId] = newObject;
        }
        const object = getOwn(workspace.objects, objectId);
        if (!object) {
          throw new VersionedTextStoreError("state-corrupt", "Versioned text store is corrupt.");
        }
        const moment = createMoment({
          id: momentId,
          workspaceId,
          versionId,
          objectId,
          path,
          recordedAtMs,
          operation: "write",
          metadata,
        });
        const snapshot: TextFileSnapshot = {
          objectId,
          versionId,
          path,
          text,
          updatedAtMs: recordedAtMs,
          latestMomentId: moment.id,
          metadata: pickWriteMetadata(metadata),
        };

        pathAliasesForVersion(workspace, versionId)[path] = objectId;
        const snapshots =
          getOwn(workspace.snapshots, versionId) ?? createDictionary<TextFileSnapshot>();
        workspace.snapshots[versionId] = snapshots;
        snapshots[objectId] = snapshot;
        workspace.moments.push(moment);
        await saveState(state);
        return {
          object: cloneFileObject(object),
          snapshot: cloneSnapshot(snapshot),
          moment: cloneMoment(moment),
        };
      });
    },

    readTextFile(input) {
      return afterWrites(async () => {
        assertInputEnvelope(input);
        const workspaceId = normalizeWorkspaceId(input.workspaceId);
        const versionId = normalizeVersionId(input.versionId);
        const path = normalizeWritePath(input.path);
        const state = await loadState();
        const { workspace } = requireWorkspaceVersion(state, workspaceId, versionId);
        const objectId = findObjectIdByVersionPath(workspace, versionId, path);
        if (!objectId) return null;
        const snapshots = getOwn(workspace.snapshots, versionId);
        const snapshot = snapshots ? (getOwn(snapshots, objectId) ?? null) : null;
        return snapshot?.path === path ? cloneSnapshot(snapshot) : null;
      });
    },

    listTextFiles(input) {
      return afterWrites(async () => {
        assertInputEnvelope(input);
        const workspaceId = normalizeWorkspaceId(input.workspaceId);
        const versionId = normalizeVersionId(input.versionId);
        const state = await loadState();
        const { workspace } = requireWorkspaceVersion(state, workspaceId, versionId);
        const snapshots =
          getOwn(workspace.snapshots, versionId) ?? createDictionary<TextFileSnapshot>();
        return Object.values(snapshots)
          .sort((a, b) => a.path.localeCompare(b.path))
          .map(cloneSnapshot);
      });
    },

    renameTextFile(input) {
      return serialize(async () => {
        assertInputEnvelope(input);
        const workspaceId = normalizeWorkspaceId(input.workspaceId);
        const versionId = normalizeVersionId(input.versionId);
        const fromPath = normalizeWritePath(input.fromPath);
        const toPath = normalizeWritePath(input.toPath);
        if (fromPath === toPath) {
          throw new VersionedTextStoreError(
            "invalid-path",
            "Rename source and destination must differ.",
          );
        }
        const metadata = normalizeWriteMetadata(input.metadata);
        const state = await loadWritableState();
        const { workspace } = requireWorkspaceVersion(state, workspaceId, versionId);
        const objectId = findObjectIdByVersionPath(workspace, versionId, fromPath);
        if (!objectId) {
          throw new VersionedTextStoreError("file-not-found", `File ${fromPath} was not found.`);
        }
        const snapshots =
          getOwn(workspace.snapshots, versionId) ?? createDictionary<TextFileSnapshot>();
        workspace.snapshots[versionId] = snapshots;
        const before = getOwn(snapshots, objectId);
        if (!before || before.path !== fromPath) {
          throw new VersionedTextStoreError("file-not-found", `File ${fromPath} was not found.`);
        }

        const targetObjectId = findObjectIdByVersionPath(workspace, versionId, toPath);
        if (targetObjectId && targetObjectId !== objectId) {
          throw new VersionedTextStoreError(
            "target-path-exists",
            `File ${toPath} already exists.`,
          );
        }

        const recordedAtMs = readNowMs();
        const momentId = createGeneratedId("moment");
        if (workspace.moments.some((moment) => moment.id === momentId)) {
          rejectDuplicateId("moment", momentId);
        }
        const moment = createMoment({
          id: momentId,
          workspaceId,
          versionId,
          objectId,
          path: toPath,
          recordedAtMs,
          operation: "rename",
          metadata,
        });
        const after: TextFileSnapshot = {
          ...cloneSnapshot(before),
          path: toPath,
          updatedAtMs: recordedAtMs,
          latestMomentId: moment.id,
          metadata: pickWriteMetadata(metadata),
        };
        const object = getOwn(workspace.objects, objectId);
        if (!object) {
          throw new VersionedTextStoreError("state-corrupt", "Versioned text store is corrupt.");
        }
        const aliases = pathAliasesForVersion(workspace, versionId);
        if (getOwn(aliases, fromPath) === objectId) {
          delete aliases[fromPath];
        }
        aliases[toPath] = objectId;
        snapshots[objectId] = after;
        workspace.moments.push(moment);
        await saveState(state);
        return {
          object: cloneFileObject(object),
          before: cloneSnapshot(before),
          after: cloneSnapshot(after),
          moment: cloneMoment(moment),
        };
      });
    },

    getObject(input) {
      return afterWrites(async () => {
        assertInputEnvelope(input);
        const workspaceId = normalizeWorkspaceId(input.workspaceId);
        const objectId = normalizeObjectId(input.objectId);
        const state = await loadState();
        const workspace = getOwn(state.workspaces, workspaceId);
        const object = workspace ? (getOwn(workspace.objects, objectId) ?? null) : null;
        if (!object && objectExistsInAnotherWorkspace(state, workspaceId, objectId)) {
          throw new VersionedTextStoreError(
            "workspace-mismatch",
            `Object ${objectId} does not belong to workspace ${workspaceId}.`,
          );
        }
        return object ? cloneFileObject(object) : null;
      });
    },
  };
}

export function createVersionedTextStore(
  rootDir: string,
  options: VersionedTextStoreOptions = {},
): VersionedTextStore {
  return createVersionedTextStoreWithHooks(rootDir, options);
}

export function createTestableVersionedTextStore(
  rootDir: string,
  options: VersionedTextStoreOptions = {},
  testHooks: VersionedTextStoreTestHooks = {},
): VersionedTextStore {
  if (process.env.NODE_ENV !== "test" && process.env.VITEST !== "true") {
    throw new VersionedTextStoreError(
      "persist-failed",
      "Versioned text store test hooks are only available during tests.",
    );
  }
  return createVersionedTextStoreWithHooks(rootDir, options, testHooks);
}
