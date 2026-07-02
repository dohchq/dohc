import { randomUUID } from "node:crypto";
import type { Stats } from "node:fs";
import { mkdir, open, readFile, rename, rm, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { validateUserWritePath } from "@dohc/workspace-core";

export const VERSIONED_TEXT_STORE_RELATIVE_PATH = ".dohc/engine/versioned-text-store.json";
export const MAX_VERSIONED_TEXT_FILE_BYTES = 10 * 1024 * 1024;
const MAX_WRITE_METADATA_FIELD_BYTES = 16 * 1024;

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
  operation: "write" | "rename" | "delete";
  payload: VersionedTextMomentPayload;
  metadata: ActorNeutralWriteMetadata;
  before?: TextFileSnapshot | null;
}

export interface VersionedTextMomentPayloadSnapshot {
  path: string;
  text: string;
}

export interface VersionedTextMomentPayload {
  before: VersionedTextMomentPayloadSnapshot | null;
  after: VersionedTextMomentPayloadSnapshot;
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

export interface VersionedTextDeleteResult {
  object: FileObjectRecord;
  before: TextFileSnapshot;
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
    momentId?: VersionedTextMomentId;
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
  deleteTextFile(input: {
    workspaceId: WorkspaceId;
    versionId: VersionId;
    path: string;
    metadata: ActorNeutralWriteMetadata;
    momentId?: VersionedTextMomentId;
  }): Promise<VersionedTextDeleteResult>;
  rollbackTextFileMutation(input: {
    workspaceId: WorkspaceId;
    versionId: VersionId;
    path: string;
    mutationMomentId: VersionedTextMomentId;
    legacyBeforeText?: string;
  }): Promise<void>;
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
  beforeAtomicPublish?: () => void | Promise<void>;
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

function assertMomentPayload(value: unknown): asserts value is VersionedTextMomentPayload {
  assertRecord(value);
  if (value.before !== null) {
    assertMomentPayloadSnapshot(value.before);
  }
  assertMomentPayloadSnapshot(value.after);
}

function assertMomentPayloadSnapshot(
  value: unknown,
): asserts value is VersionedTextMomentPayloadSnapshot {
  assertRecord(value);
  assertPersistedWritePath(value.path);
  assertString(value.text);
}

function assertPersistedWritePath(value: unknown): asserts value is string {
  assertString(value);
  const result = validateUserWritePath(value, { allowIgnoredSegments: true });
  if (!result.ok || result.normalized !== value) {
    throw new VersionedTextStoreError("state-corrupt", "Versioned text store is corrupt.");
  }
}

function assertPersistedText(value: unknown): asserts value is string {
  assertString(value);
  try {
    normalizeWriteText(value);
  } catch {
    throw new VersionedTextStoreError("state-corrupt", "Versioned text store is corrupt.");
  }
}

function assertPersistedSnapshot(value: unknown): asserts value is TextFileSnapshot {
  assertRecord(value);
  assertPersistedGeneratedId(value.objectId);
  assertString(value.versionId);
  assertPersistedWritePath(value.path);
  assertPersistedText(value.text);
  assertNumber(value.updatedAtMs);
  assertPersistedGeneratedId(value.latestMomentId);
  assertWriteMetadata(value.metadata);
}

function assertMomentBefore(value: unknown): asserts value is TextFileSnapshot | null | undefined {
  if (value === undefined || value === null) return;
  assertPersistedSnapshot(value);
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
    payload: cloneMomentPayload(moment.payload),
    metadata: pickWriteMetadata(moment.metadata),
    ...(moment.before !== undefined
      ? { before: moment.before === null ? null : cloneSnapshot(moment.before) }
      : {}),
  };
}

function cloneMomentPayload(payload: VersionedTextMomentPayload): VersionedTextMomentPayload {
  return {
    before: payload.before
      ? { path: payload.before.path, text: payload.before.text }
      : null,
    after: { path: payload.after.path, text: payload.after.text },
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

export function versionedTextStoreLockDirForTest(rootDir: string): string {
  return `${storePath(resolve(normalizeRootDir(rootDir)))}.lock`;
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

function normalizeStateAfterWorkspaceMutation(
  state: PersistedVersionedTextState,
  changedWorkspaceId: WorkspaceId,
): PersistedVersionedTextState {
  if (state.schemaVersion !== 1 || !isRecord(state.workspaces)) {
    throw new VersionedTextStoreError("state-corrupt", "Versioned text store is corrupt.");
  }
  const workspace = getOwn(state.workspaces, changedWorkspaceId);
  if (!workspace) {
    throw new VersionedTextStoreError("state-corrupt", "Versioned text store is corrupt.");
  }
  assertWorkspaceState(changedWorkspaceId, workspace);
  const normalizedWorkspace = normalizeWorkspaceState(workspace);

  for (const [workspaceId, otherWorkspace] of Object.entries(state.workspaces)) {
    if (workspaceId === changedWorkspaceId) continue;
    for (const versionId of Object.keys(normalizedWorkspace.versions)) {
      if (versionId !== "main" && getOwn(otherWorkspace.versions, versionId) !== undefined) {
        throw new VersionedTextStoreError("state-corrupt", "Versioned text store is corrupt.");
      }
    }
    for (const objectId of Object.keys(normalizedWorkspace.objects)) {
      if (getOwn(otherWorkspace.objects, objectId) !== undefined) {
        throw new VersionedTextStoreError("state-corrupt", "Versioned text store is corrupt.");
      }
    }
  }

  return {
    schemaVersion: 1,
    workspaces: createDictionary(
      Object.entries(state.workspaces).map(([workspaceId, workspaceState]) => [
        workspaceId,
        workspaceId === changedWorkspaceId ? normalizedWorkspace : workspaceState,
      ]),
    ),
  };
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
      assertPersistedText(snapshot.text);
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
    if (
      moment.operation !== "write" &&
      moment.operation !== "rename" &&
      moment.operation !== "delete"
    ) {
      throw new VersionedTextStoreError("state-corrupt", "Versioned text store is corrupt.");
    }
    assertMomentPayload(moment.payload);
    if (moment.payload.after.path !== moment.path) {
      throw new VersionedTextStoreError("state-corrupt", "Versioned text store is corrupt.");
    }
    if (moment.operation === "write" && moment.payload.before?.path !== undefined) {
      if (moment.payload.before.path !== moment.path) {
        throw new VersionedTextStoreError("state-corrupt", "Versioned text store is corrupt.");
      }
    }
    if (moment.operation === "rename") {
      if (!moment.payload.before || moment.payload.before.text !== moment.payload.after.text) {
        throw new VersionedTextStoreError("state-corrupt", "Versioned text store is corrupt.");
      }
    }
    assertWriteMetadata(moment.metadata);
    assertMomentBefore(moment.before);
    if (moment.operation === "delete" && (moment.before === undefined || moment.before === null)) {
      throw new VersionedTextStoreError("state-corrupt", "Versioned text store is corrupt.");
    }
    if (moment.operation === "rename" && moment.before === null) {
      throw new VersionedTextStoreError("state-corrupt", "Versioned text store is corrupt.");
    }
    if (moment.before !== undefined && moment.before !== null) {
      if (
        moment.before.objectId !== moment.objectId ||
        moment.before.versionId !== moment.versionId ||
        (moment.operation !== "rename" && moment.before.path !== moment.path)
      ) {
        throw new VersionedTextStoreError("state-corrupt", "Versioned text store is corrupt.");
      }
    }
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

  for (const [index, moment] of persistedMoments.entries()) {
    const before = moment.before;
    if (before === undefined) continue;
    const expectedBefore =
      latestMomentForObject(moment.versionId, moment.objectId, index - 1) ??
      inheritedLatestMomentForObject(moment.versionId, moment.objectId);
    if (before === null) {
      if (expectedBefore && expectedBefore.operation !== "delete") {
        throw new VersionedTextStoreError("state-corrupt", "Versioned text store is corrupt.");
      }
      continue;
    }
    if (
      !expectedBefore ||
      expectedBefore.operation === "delete" ||
      expectedBefore.id !== before.latestMomentId ||
      expectedBefore.path !== before.path ||
      expectedBefore.recordedAtMs !== before.updatedAtMs ||
      !sameWriteMetadata(expectedBefore.metadata, before.metadata)
    ) {
      throw new VersionedTextStoreError("state-corrupt", "Versioned text store is corrupt.");
    }
  }

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
        persistedSnapshot.text !== latestMoment.payload.after.text ||
        persistedSnapshot.path !== latestMoment.payload.after.path ||
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
      if (expectedMoment.operation === "delete") {
        if (snapshot !== undefined || getOwn(aliases, expectedMoment.path) === objectId) {
          throw new VersionedTextStoreError("state-corrupt", "Versioned text store is corrupt.");
        }
        continue;
      }
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

type AtomicPublishGuard = () => void | Promise<void>;

async function writeFileAtomic(
  path: string,
  data: string,
  beforePublish?: AtomicPublishGuard,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await replaceFileAtomic(path, data, beforePublish);
}

async function replaceFileAtomic(
  path: string,
  data: string,
  beforePublish?: AtomicPublishGuard,
): Promise<void> {
  const tmp = `${path}.tmp-${process.pid}-${process.hrtime.bigint()}`;
  try {
    await writeFileDurably(tmp, data);
    await beforePublish?.();
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

function lockHeartbeatIntervalMs(staleMs: number): number {
  if (!Number.isFinite(staleMs) || staleMs <= 0) {
    throw new VersionedTextStoreError(
      "persist-failed",
      "Versioned text store lock stale threshold is too low for safe heartbeats.",
    );
  }
  return Math.max(1, Math.min(5_000, Math.floor(staleMs / 3)));
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

async function statIfExists(path: string): Promise<Stats | null> {
  try {
    return await stat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function readLockOwnerIfExists(ownerPath: string): Promise<StoreLockOwner | null> {
  try {
    return parseLockOwner(await readFile(ownerPath, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function readLockOwnerBestEffort(ownerPath: string): Promise<StoreLockOwner | null> {
  try {
    return await readLockOwnerIfExists(ownerPath);
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

function lockInspectionFailed(message: string, cause: unknown): VersionedTextStoreError {
  const wrapped = new VersionedTextStoreError("persist-failed", message);
  (wrapped as Error & { cause?: unknown }).cause = cause;
  return wrapped;
}

interface LockOwnerDirectoryFence {
  directoryPath: string;
  directoryStats: Stats;
}

async function assertLockOwnerDirectoryFence(fence: LockOwnerDirectoryFence): Promise<void> {
  const current = await statIfExists(fence.directoryPath);
  if (!current || !current.isDirectory() || !sameFileIdentity(fence.directoryStats, current)) {
    throw lockOwnershipLost();
  }
}

async function removeDirectoryIfSameIdentity(path: string, expected: Stats): Promise<void> {
  const current = await statIfExists(path);
  if (!current || !sameFileIdentity(expected, current)) return;
  const quarantinePath = `${path}.removing-${process.pid}-${process.hrtime.bigint()}`;
  try {
    await rename(path, quarantinePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  await syncParentDirectory(path);

  const quarantined = await statIfExists(quarantinePath);
  if (!quarantined || !sameFileIdentity(expected, quarantined)) {
    if (quarantined) {
      await restoreQuarantinedDirectoryBestEffort({
        quarantinePath,
        targetPath: path,
        expected: quarantined,
      });
    }
    return;
  }

  await rm(quarantinePath, { recursive: true, force: true });
  await syncParentDirectory(quarantinePath);
}

async function restoreQuarantinedDirectoryBestEffort(input: {
  quarantinePath: string;
  targetPath: string;
  expected: Stats;
}): Promise<void> {
  const currentQuarantine = await statIfExists(input.quarantinePath);
  if (!currentQuarantine || !sameFileIdentity(input.expected, currentQuarantine)) return;
  if (await statIfExists(input.targetPath)) return;
  try {
    await rename(input.quarantinePath, input.targetPath);
    await syncParentDirectory(input.targetPath);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT" && code !== "EEXIST" && code !== "ENOTEMPTY" && code !== "ENOTDIR") {
      throw error;
    }
  }
}

async function writeFencedLockOwnerFile(
  ownerPath: string,
  token: string,
  fence: LockOwnerDirectoryFence,
): Promise<void> {
  const tmp = `${ownerPath}.tmp-${process.pid}-${process.hrtime.bigint()}`;
  try {
    await assertLockOwnerDirectoryFence(fence);
    await writeFileDurably(tmp, serializeLockOwner(createLockOwner(token)));
    await assertLockOwnerDirectoryFence(fence);
    await rename(tmp, ownerPath);
    await syncParentDirectory(ownerPath);
    await assertLockOwnerDirectoryFence(fence);
  } catch (error) {
    await rm(tmp, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function refreshStoreLockOwner(
  ownerPath: string,
  token: string,
  fence?: LockOwnerDirectoryFence,
): Promise<void> {
  // Store locks assume local-disk mtime and fsync semantics. Networked roots
  // need an explicit platform guard before this heartbeat scheme is reused.
  if (fence) await assertLockOwnerDirectoryFence(fence);
  const handle = await open(ownerPath, "r+");
  try {
    const owner = parseLockOwner(await handle.readFile("utf8"));
    if (owner?.token !== token) {
      throw lockOwnershipLost();
    }
    const now = new Date();
    await handle.utimes(now, now);
    await handle.sync();
  } finally {
    await handle.close();
  }
  if (fence) await assertLockOwnerDirectoryFence(fence);
}

function sameFileIdentity(left: Stats, right: Stats): boolean {
  return Number(left.dev) === Number(right.dev) && Number(left.ino) === Number(right.ino);
}

async function isBlockedByStaleLock(
  lockDirPath: string,
  ownerPath: string,
  staleMs: number,
): Promise<boolean> {
  const lockStats = await statIfExists(lockDirPath);
  if (!lockStats) return false;
  const ownerStats = await statIfExists(ownerPath);
  const owner = await readLockOwnerBestEffort(ownerPath);
  if (!owner) {
    return Date.now() - Math.max(lockStats.mtimeMs, ownerStats?.mtimeMs ?? 0) > staleMs;
  }
  return Date.now() - (ownerStats?.mtimeMs ?? owner.heartbeatAtMs) > staleMs;
}

async function readObservedStaleStoreLock(
  lockDirPath: string,
  ownerPath: string,
  staleMs: number,
): Promise<Stats | null> {
  const lockStats = await statIfExists(lockDirPath);
  if (!lockStats) return null;
  const ownerStats = await statIfExists(ownerPath);
  const owner = await readLockOwnerBestEffort(ownerPath);
  const stale = owner
    ? Date.now() - (ownerStats?.mtimeMs ?? owner.heartbeatAtMs) > staleMs
    : Date.now() - Math.max(lockStats.mtimeMs, ownerStats?.mtimeMs ?? 0) > staleMs;
  return stale ? lockStats : null;
}

function storeLockReclaimerPath(lockDirPath: string): string {
  return `${lockDirPath}.reclaimer`;
}

function storeLockReclaimerOwnerPath(reclaimerPath: string): string {
  return join(reclaimerPath, "owner.json");
}

async function writeStoreLockReclaimerOwner(
  reclaimerPath: string,
  token: string,
  reclaimerStats: Stats,
): Promise<void> {
  const ownerPath = storeLockReclaimerOwnerPath(reclaimerPath);
  await writeFencedLockOwnerFile(ownerPath, token, {
    directoryPath: reclaimerPath,
    directoryStats: reclaimerStats,
  });
}

async function readStoreLockReclaimerLease(
  reclaimerPath: string,
  reclaimerStats: Stats,
): Promise<{ owner: StoreLockOwner | null; freshnessMs: number }> {
  const ownerPath = storeLockReclaimerOwnerPath(reclaimerPath);
  const ownerStats = await statIfExists(ownerPath);
  const owner = await readLockOwnerBestEffort(ownerPath);
  return {
    owner,
    freshnessMs: Math.max(
      reclaimerStats.mtimeMs,
      owner?.heartbeatAtMs ?? 0,
      ownerStats?.mtimeMs ?? 0,
    ),
  };
}

async function removeStaleStoreLockReclaimer(
  reclaimerPath: string,
  reclaimerStaleMs: number,
): Promise<boolean> {
  const observed = await statIfExists(reclaimerPath);
  if (!observed) return false;
  const observedLease = await readStoreLockReclaimerLease(reclaimerPath, observed);
  if (Date.now() - observedLease.freshnessMs <= reclaimerStaleMs) return false;
  const quarantinePath = `${reclaimerPath}.stale-${process.pid}-${process.hrtime.bigint()}`;
  try {
    await rename(reclaimerPath, quarantinePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
  await syncParentDirectory(reclaimerPath);
  const quarantined = await statIfExists(quarantinePath);
  if (!quarantined) {
    return false;
  }
  const restoreQuarantinedReclaimerBestEffort = () =>
    restoreQuarantinedDirectoryBestEffort({
      quarantinePath,
      targetPath: reclaimerPath,
      expected: quarantined,
    });
  if (!sameFileIdentity(observed, quarantined)) {
    await restoreQuarantinedReclaimerBestEffort();
    return false;
  }
  const quarantinedLease = await readStoreLockReclaimerLease(quarantinePath, quarantined);
  if (observedLease.owner && quarantinedLease.owner?.token !== observedLease.owner.token) {
    await restoreQuarantinedReclaimerBestEffort();
    return false;
  }
  if (Date.now() - quarantinedLease.freshnessMs <= reclaimerStaleMs) {
    await restoreQuarantinedReclaimerBestEffort();
    return false;
  }
  await rm(quarantinePath, { recursive: true, force: true });
  await syncParentDirectory(quarantinePath);
  return true;
}

async function isStoreLockReclaimerActive(
  lockDirPath: string,
  reclaimerStaleMs: number,
): Promise<boolean> {
  const reclaimerPath = storeLockReclaimerPath(lockDirPath);
  const info = await stat(reclaimerPath).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (!info) return false;
  const lease = await readStoreLockReclaimerLease(reclaimerPath, info);
  if (Date.now() - lease.freshnessMs > reclaimerStaleMs) {
    if (await removeStaleStoreLockReclaimer(reclaimerPath, reclaimerStaleMs)) return false;
    return (await statIfExists(reclaimerPath)) !== null;
  }
  return true;
}

interface StoreLockReclaimerLease {
  assertHealthy: () => Promise<boolean>;
  release: () => Promise<void>;
}

async function acquireStoreLockReclaimer(
  lockDirPath: string,
  deadlineAtMs: number,
  reclaimerStaleMs: number,
): Promise<StoreLockReclaimerLease> {
  const reclaimerPath = storeLockReclaimerPath(lockDirPath);
  while (true) {
    if (Date.now() > deadlineAtMs) {
      throw new VersionedTextStoreError(
        "persist-failed",
        `Timed out waiting for versioned text store lock reclaimer: ${reclaimerPath}`,
      );
    }
    let createdReclaimer = false;
    let acquiredReclaimer: Stats | null = null;
    try {
      const token = randomUUID();
      await mkdir(reclaimerPath, { mode: 0o700 });
      createdReclaimer = true;
      const acquiredReclaimerStats = await stat(reclaimerPath);
      acquiredReclaimer = acquiredReclaimerStats;
      const reclaimerFence = {
        directoryPath: reclaimerPath,
        directoryStats: acquiredReclaimerStats,
      };
      await writeStoreLockReclaimerOwner(reclaimerPath, token, acquiredReclaimerStats);
      await syncParentDirectory(reclaimerPath);
      const ownerPath = storeLockReclaimerOwnerPath(reclaimerPath);
      let released = false;
      let heartbeatFailure: unknown = null;
      let heartbeatWritePending = false;
      const heartbeatWrites = new Set<Promise<void>>();
      const heartbeatIntervalMs = lockHeartbeatIntervalMs(reclaimerStaleMs);
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
      const heartbeat = setInterval(() => {
        if (released || heartbeatWritePending) return;
        heartbeatWritePending = true;
        trackHeartbeatWrite(
          refreshStoreLockOwner(ownerPath, token, reclaimerFence)
            .finally(() => {
              heartbeatWritePending = false;
            }),
        );
      }, heartbeatIntervalMs);
      const assertHealthy = async () => {
        if (heartbeatFailure) return false;
        const current = await statIfExists(reclaimerPath);
        if (!current || !sameFileIdentity(acquiredReclaimerStats, current)) return false;
        const owner = await readLockOwnerIfExists(ownerPath);
        return owner?.token === token;
      };
      return {
        assertHealthy,
        release: async () => {
          released = true;
          clearInterval(heartbeat);
          while (heartbeatWrites.size > 0) {
            await Promise.all([...heartbeatWrites]);
          }
          if (!(await assertHealthy())) return;
          await removeDirectoryIfSameIdentity(reclaimerPath, acquiredReclaimerStats);
        },
      };
    } catch (error) {
      if (createdReclaimer && acquiredReclaimer) {
        await removeDirectoryIfSameIdentity(reclaimerPath, acquiredReclaimer).catch(() => undefined);
      }
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (await removeStaleStoreLockReclaimer(reclaimerPath, reclaimerStaleMs)) continue;
      if (Date.now() > deadlineAtMs) {
        throw new VersionedTextStoreError(
          "persist-failed",
          `Timed out waiting for versioned text store lock reclaimer: ${reclaimerPath}`,
        );
      }
      await delayMs(25);
    }
  }
}

async function reclaimStaleStoreLock(
  lockDirPath: string,
  ownerPath: string,
  staleMs: number,
  deadlineAtMs: number,
): Promise<boolean> {
  const reclaimer = await acquireStoreLockReclaimer(lockDirPath, deadlineAtMs, staleMs);
  try {
    if (!(await reclaimer.assertHealthy())) return false;
    const observed = await readObservedStaleStoreLock(lockDirPath, ownerPath, staleMs);
    if (!observed) return false;
    const current = await stat(lockDirPath).catch(() => null);
    if (!current || !sameFileIdentity(observed, current)) return false;
    const quarantinePath = `${lockDirPath}.stale-${process.pid}-${process.hrtime.bigint()}`;
    if (!(await reclaimer.assertHealthy())) return false;
    try {
      await rename(lockDirPath, quarantinePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
    await syncParentDirectory(lockDirPath);

    const quarantined = await stat(quarantinePath).catch(() => null);
    if (!quarantined) {
      return false;
    }
    const restoreQuarantinedLockBestEffort = () =>
      restoreQuarantinedDirectoryBestEffort({
        quarantinePath,
        targetPath: lockDirPath,
        expected: quarantined,
      });
    if (!sameFileIdentity(observed, quarantined)) {
      await restoreQuarantinedLockBestEffort();
      return false;
    }
    let quarantinedLockIsStale: boolean;
    try {
      quarantinedLockIsStale = await isBlockedByStaleLock(
        quarantinePath,
        join(quarantinePath, "owner.json"),
        staleMs,
      );
    } catch (error) {
      await restoreQuarantinedLockBestEffort();
      throw error;
    }
    if (!quarantinedLockIsStale) {
      await restoreQuarantinedLockBestEffort();
      return false;
    }
    if (!(await reclaimer.assertHealthy())) {
      await restoreQuarantinedLockBestEffort();
      return false;
    }
    await rm(quarantinePath, { recursive: true, force: true });
    await syncParentDirectory(quarantinePath);
    return true;
  } finally {
    await reclaimer.release();
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
      if (await isStoreLockReclaimerActive(lockDirPath, lockStaleMs)) {
        await onLockBlocked?.();
        if (Date.now() - startedAt > lockTimeoutMs) {
          throw new VersionedTextStoreError(
            "persist-failed",
            "Versioned text store lock timed out.",
          );
        }
        await delayMs(25);
        continue;
      }
      await mkdir(lockDirPath, { mode: 0o700 });
      const acquiredBeforeReclaimerCheck = await stat(lockDirPath);
      const storeLockFence = {
        directoryPath: lockDirPath,
        directoryStats: acquiredBeforeReclaimerCheck,
      };
      if (await isStoreLockReclaimerActive(lockDirPath, lockStaleMs)) {
        const current = await statIfExists(lockDirPath);
        if (current && sameFileIdentity(acquiredBeforeReclaimerCheck, current)) {
          await removeDirectoryIfSameIdentity(lockDirPath, acquiredBeforeReclaimerCheck).catch(
            () => undefined,
          );
        }
        await onLockBlocked?.();
        if (Date.now() - startedAt > lockTimeoutMs) {
          throw new VersionedTextStoreError(
            "persist-failed",
            "Versioned text store lock timed out.",
          );
        }
        await delayMs(25);
        continue;
      }
      const token = randomUUID();
      let heartbeatFailure: unknown = null;
      let released = false;
      const heartbeatWrites = new Set<Promise<void>>();
      const heartbeatIntervalMs = lockHeartbeatIntervalMs(lockStaleMs);
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
        await writeFencedLockOwnerFile(ownerPath, token, storeLockFence);
      } catch (error) {
        await removeDirectoryIfSameIdentity(lockDirPath, acquiredBeforeReclaimerCheck).catch(
          () => undefined,
        );
        throw error;
      }
      let heartbeatWritePending = false;
      const heartbeat = setInterval(() => {
        if (released) return;
        if (heartbeatWritePending) return;
        heartbeatWritePending = true;
        trackHeartbeatWrite(
          refreshStoreLockOwner(ownerPath, token, storeLockFence).finally(() => {
            heartbeatWritePending = false;
          }),
        );
      }, heartbeatIntervalMs);
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
          const current = await statIfExists(lockDirPath);
          if (!current || !sameFileIdentity(acquiredBeforeReclaimerCheck, current)) {
            throw lockOwnershipLost();
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
            const current = await statIfExists(lockDirPath);
            if (!current || !sameFileIdentity(acquiredBeforeReclaimerCheck, current)) return;
            const owner = parseLockOwner(await readFile(ownerPath, "utf8"));
            if (owner?.token === token) {
              await removeDirectoryIfSameIdentity(lockDirPath, acquiredBeforeReclaimerCheck);
            }
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          }
        },
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      await onLockBlocked?.();
      let blockedByStaleLock: boolean;
      try {
        blockedByStaleLock = await isBlockedByStaleLock(lockDirPath, ownerPath, lockStaleMs);
      } catch (inspectionError) {
        throw lockInspectionFailed(
          "Failed to inspect versioned text store lock owner.",
          inspectionError,
        );
      }
      if (blockedByStaleLock) {
        if (
          await reclaimStaleStoreLock(
            lockDirPath,
            ownerPath,
            lockStaleMs,
            startedAt + lockTimeoutMs,
          )
        ) {
          continue;
        }
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
  const byteLength = Buffer.byteLength(text, "utf8");
  if (byteLength > MAX_VERSIONED_TEXT_FILE_BYTES) {
    throw new VersionedTextStoreError(
      "invalid-text",
      "Text file contents are too large for the versioned text store.",
    );
  }
  const bytes = Buffer.from(text, "utf8");
  if (bytes.toString("utf8") !== text) {
    throw new VersionedTextStoreError(
      "invalid-text",
      "Text file contents must round-trip through UTF-8.",
    );
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
  if (metadata.summary !== undefined) {
    assertWriteMetadataFieldSize(metadata.summary, "summary");
  }
  if (metadata.correlationId !== undefined && typeof metadata.correlationId !== "string") {
    throw new VersionedTextStoreError(
      "invalid-metadata",
      "Write metadata correlation id is invalid.",
    );
  }
  if (metadata.correlationId !== undefined) {
    assertWriteMetadataFieldSize(metadata.correlationId, "correlation id");
  }
  return pickWriteMetadata(metadata);
}

function assertWriteMetadataFieldSize(value: string, label: string): void {
  if (Buffer.byteLength(value, "utf8") > MAX_WRITE_METADATA_FIELD_BYTES) {
    throw new VersionedTextStoreError(
      "invalid-metadata",
      `Write metadata ${label} is too large.`,
    );
  }
}

function invalidRollbackSnapshot(): never {
  throw new VersionedTextStoreError(
    "invalid-input",
    "Rollback snapshot does not match the target file.",
  );
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

function workspaceReferencesObject(
  workspace: PersistedWorkspaceState,
  objectId: WorkspaceObjectId,
): boolean {
  for (const aliases of Object.values(workspace.pathAliases)) {
    if (Object.values(aliases).some((candidate) => candidate === objectId)) return true;
  }
  for (const snapshots of Object.values(workspace.snapshots)) {
    if (getOwn(snapshots, objectId) !== undefined) return true;
  }
  return workspace.moments.some((moment) => moment.objectId === objectId);
}

function rollbackMomentHasDependents(
  workspace: PersistedWorkspaceState,
  versionId: VersionId,
  momentId: VersionedTextMomentId,
  momentIndex: number,
  objectId: WorkspaceObjectId,
): boolean {
  const momentIndexById = new Map(
    workspace.moments.map((moment, index) => [moment.id, index] as const),
  );
  const versionHasIndependentObjectMutationInRange = (
    candidateVersionId: VersionId,
    afterIndex: number,
    atOrBeforeIndex: number,
  ) =>
    workspace.moments.some(
      (moment, index) =>
        index > afterIndex &&
        index <= atOrBeforeIndex &&
        moment.versionId === candidateVersionId &&
        moment.objectId === objectId &&
        moment.before !== undefined &&
        moment.before !== null,
    );
  const lineageHasIndependentObjectMutation = (
    candidateVersionId: VersionId,
    afterIndex: number,
  ): boolean => {
    let cursor = getOwn(workspace.versions, candidateVersionId);
    let atOrBeforeIndex = Number.POSITIVE_INFINITY;
    const seen = new Set<VersionId>();
    while (cursor) {
      if (seen.has(cursor.id)) return false;
      seen.add(cursor.id);
      if (versionHasIndependentObjectMutationInRange(cursor.id, afterIndex, atOrBeforeIndex)) {
        return true;
      }
      if (!cursor.forkPoint || cursor.forkPoint.versionId === versionId) return false;
      atOrBeforeIndex =
        cursor.forkPoint.momentId === undefined
          ? -1
          : (momentIndexById.get(cursor.forkPoint.momentId) ?? -1);
      cursor = getOwn(workspace.versions, cursor.forkPoint.versionId);
    }
    return false;
  };
  const forkIndexFromVersion = (version: VersionRecord): number | null => {
    let cursor: VersionRecord | undefined = version;
    const seen = new Set<VersionId>();
    while (cursor?.forkPoint) {
      if (seen.has(cursor.id)) return null;
      seen.add(cursor.id);
      if (cursor.forkPoint.versionId === versionId) {
        return cursor.forkPoint.momentId
          ? (momentIndexById.get(cursor.forkPoint.momentId) ?? null)
          : null;
      }
      cursor = getOwn(workspace.versions, cursor.forkPoint.versionId);
    }
    return null;
  };

  for (const version of Object.values(workspace.versions)) {
    if (version.id !== versionId) {
      const forkIndex = forkIndexFromVersion(version);
      if (
        forkIndex !== null &&
        forkIndex >= momentIndex &&
        (forkIndex === momentIndex || !lineageHasIndependentObjectMutation(version.id, forkIndex))
      ) {
        return true;
      }
    }
  }
  for (const [candidateVersionId, snapshots] of Object.entries(workspace.snapshots)) {
    if (candidateVersionId === versionId) continue;
    if (Object.values(snapshots).some((snapshot) => snapshot.latestMomentId === momentId)) {
      return true;
    }
  }
  if (
    workspace.moments.some(
      (candidate) =>
        candidate.id !== momentId &&
        candidate.objectId === objectId &&
        candidate.before?.latestMomentId === momentId,
    )
  ) {
    return true;
  }
  return false;
}

function previousObjectMoment(
  workspace: PersistedWorkspaceState,
  versionId: VersionId,
  objectId: WorkspaceObjectId,
  beforeIndex: number,
): VersionedTextMoment | null {
  for (let index = beforeIndex - 1; index >= 0; index -= 1) {
    const moment = workspace.moments[index];
    if (moment?.versionId === versionId && moment.objectId === objectId) return moment;
  }
  return null;
}

function latestObjectMomentAtOrBefore(
  workspace: PersistedWorkspaceState,
  versionId: VersionId,
  objectId: WorkspaceObjectId,
  maxIndex: number,
): VersionedTextMoment | null {
  for (let index = maxIndex; index >= 0; index -= 1) {
    const moment = workspace.moments[index];
    if (moment?.versionId === versionId && moment.objectId === objectId) return moment;
  }
  return null;
}

function inheritedObjectMoment(
  workspace: PersistedWorkspaceState,
  versionId: VersionId,
  objectId: WorkspaceObjectId,
  seen = new Set<VersionId>(),
): VersionedTextMoment | null {
  if (seen.has(versionId)) {
    throw new VersionedTextStoreError("state-corrupt", "Versioned text store is corrupt.");
  }
  seen.add(versionId);
  const version = getOwn(workspace.versions, versionId);
  if (!version?.forkPoint) return null;
  const forkMomentId = version.forkPoint.momentId;
  const forkIndex =
    forkMomentId === undefined
      ? -1
      : workspace.moments.findIndex((moment) => moment.id === forkMomentId);
  if (forkMomentId !== undefined && forkIndex < 0) {
    throw new VersionedTextStoreError("state-corrupt", "Versioned text store is corrupt.");
  }
  return (
    latestObjectMomentAtOrBefore(
      workspace,
      version.forkPoint.versionId,
      objectId,
      forkIndex,
    ) ?? inheritedObjectMoment(workspace, version.forkPoint.versionId, objectId, seen)
  );
}

function legacyRollbackBeforeSnapshot(input: {
  workspace: PersistedWorkspaceState;
  versionId: VersionId;
  path: string;
  moment: VersionedTextMoment;
  momentIndex: number;
  legacyBeforeText?: string;
}): TextFileSnapshot | null {
  const previous = previousObjectMoment(
    input.workspace,
    input.versionId,
    input.moment.objectId,
    input.momentIndex,
  ) ?? inheritedObjectMoment(input.workspace, input.versionId, input.moment.objectId);
  if (input.legacyBeforeText !== undefined) {
    const legacyBeforeText = normalizeWriteText(input.legacyBeforeText);
    if (!previous || previous.operation === "delete") {
      throw new VersionedTextStoreError(
        "invalid-input",
        `Legacy mutation moment ${input.moment.id} has no earlier snapshot to restore.`,
      );
    }
    const rollbackPath = input.moment.operation === "rename" ? previous.path : input.path;
    return {
      objectId: input.moment.objectId,
      versionId: input.versionId,
      path: rollbackPath,
      text: legacyBeforeText,
      updatedAtMs: previous.recordedAtMs,
      latestMomentId: previous.id,
      metadata: pickWriteMetadata(previous.metadata),
    };
  }
  if (input.moment.operation === "write" && !previous) return null;
  throw new VersionedTextStoreError(
    "invalid-input",
    `Legacy mutation moment ${input.moment.id} is missing a rollback preimage.`,
  );
}

function createMoment(input: {
  id: VersionedTextMomentId;
  workspaceId: WorkspaceId;
  versionId: VersionId;
  objectId: WorkspaceObjectId;
  path: string;
  recordedAtMs: number;
  operation: "write" | "rename" | "delete";
  payload: VersionedTextMomentPayload;
  metadata: ActorNeutralWriteMetadata;
  before: TextFileSnapshot | null;
}): VersionedTextMoment {
  return {
    id: input.id,
    workspaceId: input.workspaceId,
    versionId: input.versionId,
    objectId: input.objectId,
    path: input.path,
    recordedAtMs: input.recordedAtMs,
    operation: input.operation,
    payload: cloneMomentPayload(input.payload),
    metadata: pickWriteMetadata(input.metadata),
    before: input.before === null ? null : cloneSnapshot(input.before),
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

  async function saveState(
    state: PersistedVersionedTextState,
    changedWorkspaceId: WorkspaceId,
  ): Promise<void> {
    const normalized = normalizeStateAfterWorkspaceMutation(state, changedWorkspaceId);
    const serialized = `${JSON.stringify(normalized, null, 2)}\n`;
    try {
      await testHooks.beforePersist?.();
      if (!activeLease) {
        throw new VersionedTextStoreError(
          "persist-failed",
          "Versioned text store write lock is required.",
        );
      }
      const lease = activeLease;
      await lease.assertHealthy();
      await writeFileAtomic(stateFilePath, serialized, async () => {
        await testHooks.beforeAtomicPublish?.();
        await lease.assertHealthy();
      });
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
        await saveState(state, workspaceId);
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
        await saveState(state, workspaceId);
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
        const snapshots =
          getOwn(workspace.snapshots, versionId) ?? createDictionary<TextFileSnapshot>();
        workspace.snapshots[versionId] = snapshots;
        const before = existingObjectId ? (getOwn(snapshots, existingObjectId) ?? null) : null;
        if (before && before.path !== path) {
          throw new VersionedTextStoreError("state-corrupt", "Versioned text store is corrupt.");
        }
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

        const momentId =
          input.momentId === undefined
            ? createGeneratedId("moment")
            : normalizeGeneratedId("moment", input.momentId);
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
          payload: {
            before: before ? { path: before.path, text: before.text } : null,
            after: { path, text },
          },
          metadata,
          before,
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
        snapshots[objectId] = snapshot;
        workspace.moments.push(moment);
        await saveState(state, workspaceId);
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
          payload: {
            before: { path: before.path, text: before.text },
            after: { path: toPath, text: before.text },
          },
          metadata,
          before,
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
        await saveState(state, workspaceId);
        return {
          object: cloneFileObject(object),
          before: cloneSnapshot(before),
          after: cloneSnapshot(after),
          moment: cloneMoment(moment),
        };
      });
    },

    deleteTextFile(input) {
      return serialize(async () => {
        assertInputEnvelope(input);
        const workspaceId = normalizeWorkspaceId(input.workspaceId);
        const versionId = normalizeVersionId(input.versionId);
        const path = normalizeWritePath(input.path);
        const metadata = normalizeWriteMetadata(input.metadata);
        const state = await loadWritableState();
        const { workspace } = requireWorkspaceVersion(state, workspaceId, versionId);
        const objectId = findObjectIdByVersionPath(workspace, versionId, path);
        if (!objectId) {
          throw new VersionedTextStoreError("file-not-found", `File ${path} was not found.`);
        }
        const snapshots =
          getOwn(workspace.snapshots, versionId) ?? createDictionary<TextFileSnapshot>();
        workspace.snapshots[versionId] = snapshots;
        const before = getOwn(snapshots, objectId);
        if (!before || before.path !== path) {
          throw new VersionedTextStoreError("file-not-found", `File ${path} was not found.`);
        }

        const recordedAtMs = readNowMs();
        const momentId =
          input.momentId === undefined
            ? createGeneratedId("moment")
            : normalizeGeneratedId("moment", input.momentId);
        if (workspace.moments.some((moment) => moment.id === momentId)) {
          rejectDuplicateId("moment", momentId);
        }
        const moment = createMoment({
          id: momentId,
          workspaceId,
          versionId,
          objectId,
          path,
          recordedAtMs,
          operation: "delete",
          payload: {
            before: { path: before.path, text: before.text },
            after: { path: before.path, text: before.text },
          },
          metadata,
          before,
        });
        const aliases = pathAliasesForVersion(workspace, versionId);
        if (getOwn(aliases, path) === objectId) {
          delete aliases[path];
        }
        delete snapshots[objectId];
        workspace.moments.push(moment);
        const object = getOwn(workspace.objects, objectId);
        if (!object) {
          throw new VersionedTextStoreError("state-corrupt", "Versioned text store is corrupt.");
        }
        await saveState(state, workspaceId);
        return {
          object: cloneFileObject(object),
          before: cloneSnapshot(before),
          moment: cloneMoment(moment),
        };
      });
    },

    rollbackTextFileMutation(input) {
      return serialize(async () => {
        assertInputEnvelope(input);
        const workspaceId = normalizeWorkspaceId(input.workspaceId);
        const versionId = normalizeVersionId(input.versionId);
        const path = normalizeWritePath(input.path);
        const mutationMomentId = normalizeGeneratedId("moment", input.mutationMomentId);
        const state = await loadWritableState();
        const { workspace } = requireWorkspaceVersion(state, workspaceId, versionId);
        const momentIndex = workspace.moments.findIndex(
          (moment) =>
            moment.id === mutationMomentId &&
            moment.workspaceId === workspaceId &&
            moment.versionId === versionId &&
            moment.path === path,
        );
        if (momentIndex < 0) {
          throw new VersionedTextStoreError(
            "file-not-found",
            `Mutation moment ${mutationMomentId} was not found for ${path}.`,
          );
        }
        const moment = workspace.moments[momentIndex];
        if (!moment) {
          throw new VersionedTextStoreError("state-corrupt", "Versioned text store is corrupt.");
        }
        const before =
          moment.before === undefined
            ? legacyRollbackBeforeSnapshot({
                workspace,
                versionId,
                path,
                moment,
                momentIndex,
                legacyBeforeText: input.legacyBeforeText,
              })
            : moment.before;
        if (before && before.versionId !== versionId) {
          invalidRollbackSnapshot();
        }
        if (
          workspace.moments.some(
            (candidate, index) =>
              index > momentIndex &&
              candidate.workspaceId === workspaceId &&
              candidate.versionId === versionId &&
              candidate.objectId === moment.objectId,
          )
        ) {
          throw new VersionedTextStoreError(
            "invalid-input",
            `Mutation moment ${mutationMomentId} is not the latest mutation for ${path}.`,
          );
        }
        if (
          rollbackMomentHasDependents(
            workspace,
            versionId,
            mutationMomentId,
            momentIndex,
            moment.objectId,
          )
        ) {
          throw new VersionedTextStoreError(
            "invalid-input",
            `Mutation moment ${mutationMomentId} has dependent versions and cannot be rolled back.`,
          );
        }
        if (before && before.path !== path && moment.operation !== "rename") {
          invalidRollbackSnapshot();
        }
        const aliases = pathAliasesForVersion(workspace, versionId);
        const snapshots =
          getOwn(workspace.snapshots, versionId) ?? createDictionary<TextFileSnapshot>();
        workspace.snapshots[versionId] = snapshots;

        if (before) {
          if (before.objectId !== moment.objectId) {
            invalidRollbackSnapshot();
          }
          const restorePathObjectId = getOwn(aliases, before.path);
          if (restorePathObjectId !== undefined && restorePathObjectId !== before.objectId) {
            throw new VersionedTextStoreError(
              "target-path-exists",
              `File ${before.path} already exists.`,
            );
          }
        }

        workspace.moments.splice(momentIndex, 1);
        if (getOwn(aliases, path) === moment.objectId) {
          delete aliases[path];
        }
        delete snapshots[moment.objectId];

        if (before) {
          const object = getOwn(workspace.objects, before.objectId);
          if (!object) {
            throw new VersionedTextStoreError(
              "state-corrupt",
              "Versioned text store is corrupt.",
            );
          }
          aliases[before.path] = before.objectId;
          snapshots[before.objectId] = cloneSnapshot(before);
        }

        if (!workspaceReferencesObject(workspace, moment.objectId)) {
          delete workspace.objects[moment.objectId];
        }
        await saveState(state, workspaceId);
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
