import { createHash, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import type {
  ActorNeutralWriteMetadata,
  ActorNeutralWriteOrigin,
  AgentMomentAuthor,
  FileObjectRecord,
  MomentAuthor,
  TextFileSnapshot,
  VersionId,
  VersionKind,
  VersionRecord,
  VersionedTextComparison,
  VersionedTextComparisonStatus,
  VersionedTextConflictChoice,
  VersionedTextConflictId,
  VersionedTextConflictRecord,
  VersionedTextConflictResolveResult,
  VersionedTextConflictResolution,
  VersionedTextConflictStatus,
  VersionedTextDeleteResult,
  VersionedTextFileState,
  VersionedTextMergeResult,
  VersionedTextMoment,
  VersionedTextMomentId,
  VersionedTextMomentPage,
  VersionedTextMomentPayload,
  VersionedTextMomentPayloadSnapshot,
  VersionedTextMomentSummary,
  VersionedTextRenameResult,
  VersionedTextStore,
  VersionedTextStoreErrorCode,
  VersionedTextStoreOptions,
  VersionedTextWriteResult,
  WorkspaceId,
  WorkspaceObjectId,
} from "@dohc/workspace-contracts/engine";
import { validateUserWritePath } from "@dohc/workspace-core";
import { mergeMarkdown } from "@dohc/workspace-history/mergeMarkdown";
import {
  ENGINE_SQLITE_BUSY_TIMEOUT_MS,
  assertEngineSqliteIntegrity,
  initializeOrValidateEngineSchema,
  type EngineIntegrityCheckMode,
} from "./engineDbSchema";
import { classifyEngineFilePath } from "./enginePathFloor";
import {
  deleteFileSearchIndex,
  ensureSearchIndexForVersion,
  querySearchIndex,
  upsertFileSearchIndex,
} from "./searchIndex";

export const VERSIONED_TEXT_STORE_RELATIVE_PATH = ".dohc/engine/engine.db";
export const MAX_VERSIONED_TEXT_FILE_BYTES = 10 * 1024 * 1024;
const MAX_WRITE_METADATA_FIELD_BYTES = 16 * 1024;

export type {
  ActorNeutralWriteMetadata,
  ActorNeutralWriteOrigin,
  AgentMomentAuthor,
  FileObjectRecord,
  MomentAuthor,
  TextFileSnapshot,
  VersionId,
  VersionKind,
  VersionRecord,
  VersionedTextComparison,
  VersionedTextComparisonStatus,
  VersionedTextConflictChoice,
  VersionedTextConflictId,
  VersionedTextConflictRecord,
  VersionedTextConflictResolveResult,
  VersionedTextConflictResolution,
  VersionedTextConflictStatus,
  VersionedTextDeleteResult,
  VersionedTextFileState,
  VersionedTextMergeResult,
  VersionedTextMoment,
  VersionedTextMomentId,
  VersionedTextMomentPage,
  VersionedTextMomentPayload,
  VersionedTextMomentPayloadSnapshot,
  VersionedTextMomentSummary,
  VersionedTextRenameResult,
  VersionedTextStore,
  VersionedTextStoreErrorCode,
  VersionedTextStoreOptions,
  VersionedTextWriteResult,
  WorkspaceId,
  WorkspaceObjectId,
} from "@dohc/workspace-contracts/engine";

export class VersionedTextStoreError extends Error {
  readonly code: VersionedTextStoreErrorCode;

  constructor(code: VersionedTextStoreErrorCode, message: string) {
    super(message);
    this.name = "VersionedTextStoreError";
    this.code = code;
  }
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

interface PersistedWorkspaceState {
  mainVersionId: VersionId;
  versions: Record<VersionId, VersionRecord>;
  objects: Record<WorkspaceObjectId, FileObjectRecord>;
  pathAliases: Record<VersionId, Record<string, WorkspaceObjectId>>;
  snapshots: Record<VersionId, Record<WorkspaceObjectId, TextFileSnapshot>>;
  forkBaseSnapshots: Record<VersionId, Record<WorkspaceObjectId, TextFileSnapshot>>;
  moments: VersionedTextMoment[];
  conflicts: Record<VersionedTextConflictId, VersionedTextConflictRecord>;
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

function pickMomentAuthor(author: MomentAuthor): MomentAuthor {
  return {
    kind: "agent",
    agentId: author.agentId,
    onBehalfOf: author.onBehalfOf,
    ...(author.agentRunId !== undefined ? { agentRunId: author.agentRunId } : {}),
  };
}

// Moment authorship is fail-closed on read: a hand-edited/corrupt author_json
// must never render as a valid-looking attribution (the same posture as the
// chat store's author_kind).
function assertMomentAuthor(value: unknown): asserts value is MomentAuthor | undefined {
  if (value === undefined) return;
  assertRecord(value);
  if (
    value.kind !== "agent" ||
    typeof value.agentId !== "string" ||
    !value.agentId ||
    typeof value.onBehalfOf !== "string" ||
    !value.onBehalfOf ||
    (value.agentRunId !== undefined &&
      (typeof value.agentRunId !== "string" || !value.agentRunId))
  ) {
    throw new VersionedTextStoreError("state-corrupt", "Versioned text store is corrupt.");
  }
}

function normalizeMomentAuthor(author: unknown): MomentAuthor | undefined {
  if (author === undefined) return undefined;
  if (!isRecord(author) || author.kind !== "agent") {
    throw new VersionedTextStoreError("invalid-metadata", "Moment author is invalid.");
  }
  const fields: Array<[string, unknown, boolean]> = [
    ["agentId", author.agentId, true],
    ["onBehalfOf", author.onBehalfOf, true],
    ["agentRunId", author.agentRunId, false],
  ];
  for (const [label, value, required] of fields) {
    if (!required && value === undefined) continue;
    if (typeof value !== "string" || value.trim() !== value || !value) {
      throw new VersionedTextStoreError(
        "invalid-metadata",
        `Moment author ${label} is invalid.`,
      );
    }
    assertWriteMetadataFieldSize(value, `author ${label}`);
  }
  return pickMomentAuthor(author as unknown as AgentMomentAuthor);
}

function momentAuthorToJson(author: MomentAuthor | undefined): string | null {
  return author === undefined ? null : JSON.stringify(pickMomentAuthor(author));
}

function momentAuthorFromRow(row: Record<string, unknown>): MomentAuthor | undefined {
  // Databases created before the additive author_json upgrade surface the
  // column as absent/NULL; both read as "actor-neutral moment".
  const raw = row.author_json;
  if (raw === null || raw === undefined) return undefined;
  if (typeof raw !== "string") throw corruptStore();
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw corruptStore(error);
  }
  assertMomentAuthor(parsed);
  return parsed === undefined ? undefined : pickMomentAuthor(parsed);
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
    ...(moment.author !== undefined ? { author: pickMomentAuthor(moment.author) } : {}),
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

interface SqliteStatement {
  all(...params: unknown[]): Array<Record<string, unknown>>;
  get(...params: unknown[]): Record<string, unknown> | undefined;
  run(...params: unknown[]): { changes: number };
}

interface SqliteDb {
  exec(sql: string): void;
  prepare(sql: string): SqliteStatement;
  close(): void;
}

interface SqliteModule {
  DatabaseSync: new (path: string, options?: { readOnly?: boolean }) => SqliteDb;
}

const requireModule = createRequire(import.meta.url);

function nodeSqlite(): SqliteModule {
  return requireModule("node:sqlite") as SqliteModule;
}

function openDatabase(
  rootDir: string,
  integrityCheck: EngineIntegrityCheckMode = "quick",
): SqliteDb {
  const path = storePath(resolve(normalizeRootDir(rootDir)));
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const { DatabaseSync } = nodeSqlite();
  let db: SqliteDb;
  try {
    db = new DatabaseSync(path);
  } catch (error) {
    throw corruptStore(error);
  }
  try {
    db.exec(`PRAGMA busy_timeout = ${ENGINE_SQLITE_BUSY_TIMEOUT_MS}`);
    db.exec("PRAGMA foreign_keys = ON");
    db.exec("PRAGMA journal_mode = WAL");
    // Schema bootstrap + integrity are shared with linkedChatStore (one
    // engine.db, one DDL owner — see engineDbSchema.ts).
    initializeOrValidateEngineSchema(db, corruptStore);
    assertEngineSqliteIntegrity(db, corruptStore, integrityCheck);
    return db;
  } catch (error) {
    try {
      db.close();
    } catch {}
    if (error instanceof VersionedTextStoreError) throw error;
    throw corruptStore(error);
  }
}

function corruptStore(cause?: unknown): VersionedTextStoreError {
  const error = new VersionedTextStoreError("state-corrupt", "Versioned text store is corrupt.");
  if (cause !== undefined) {
    (error as Error & { cause?: unknown }).cause = cause;
  }
  return error;
}

function persistFailed(cause: unknown): VersionedTextStoreError {
  const error = new VersionedTextStoreError(
    "persist-failed",
    "Versioned text store could not be persisted.",
  );
  (error as Error & { cause?: unknown }).cause = cause;
  return error;
}

function normalizeHydratedState(raw: unknown): PersistedVersionedTextState {
  if (raw === undefined) return initialState();
  if (!isRecord(raw) || raw.schemaVersion !== 1 || !isRecord(raw.workspaces)) {
    throw new VersionedTextStoreError("state-corrupt", "Versioned text store is corrupt.");
  }
  const workspaces = createDictionary<PersistedWorkspaceState>();
  const seenVersionIds = new Map<VersionId, WorkspaceId>();
  const seenObjectIds = new Map<WorkspaceObjectId, WorkspaceId>();
  for (const [workspaceId, workspace] of Object.entries(raw.workspaces)) {
    if (isRecord(workspace)) {
      workspace.forkBaseSnapshots ??= createDictionary();
      workspace.conflicts ??= createDictionary();
    }
    assertHydratedWorkspaceState(workspaceId, workspace);
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
  assertHydratedWorkspaceState(changedWorkspaceId, workspace);
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
    forkBaseSnapshots: createDictionary(
      Object.entries(workspace.forkBaseSnapshots).map(([versionId, snapshots]) => [
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
    conflicts: createDictionary(
      Object.entries(workspace.conflicts).map(([conflictId, conflict]) => [
        conflictId,
        cloneJson(conflict),
      ]),
    ),
  };
}

function assertHydratedWorkspaceState(workspaceId: string, value: unknown): void {
  assertPersistedNormalizedString(workspaceId);
  assertRecord(value);
  assertPersistedGeneratedId(value.mainVersionId);
  assertRecord(value.versions);
  assertRecord(value.objects);
  assertRecord(value.pathAliases);
  assertRecord(value.snapshots);
  assertRecord(value.forkBaseSnapshots);
  assertRecord(value.conflicts);
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

  for (const [versionId, snapshots] of Object.entries(value.forkBaseSnapshots)) {
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
      // Same consistency rule as the snapshots loop above: a fork-base row
      // filed under one version must not claim to belong to another.
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
    assertMomentAuthor(moment.author);
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

function sha256Text(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function rowString(row: Record<string, unknown>, key: string): string {
  const value = row[key];
  if (typeof value !== "string") throw corruptStore();
  return value;
}

function rowOptionalString(row: Record<string, unknown>, key: string): string | undefined {
  const value = row[key];
  if (value === null || value === undefined) return undefined;
  if (typeof value !== "string") throw corruptStore();
  return value;
}

function rowNumber(row: Record<string, unknown>, key: string): number {
  const value = row[key];
  if (typeof value !== "number" || !Number.isFinite(value)) throw corruptStore();
  return value;
}

function metadataFromRow(
  row: Record<string, unknown>,
  prefix = "metadata_",
): ActorNeutralWriteMetadata {
  return pickWriteMetadata({
    origin: rowString(row, `${prefix}origin`) as ActorNeutralWriteOrigin,
    ...(rowOptionalString(row, `${prefix}summary`) !== undefined
      ? { summary: rowOptionalString(row, `${prefix}summary`) }
      : {}),
    ...(rowOptionalString(row, `${prefix}correlation_id`) !== undefined
      ? { correlationId: rowOptionalString(row, `${prefix}correlation_id`) }
      : {}),
  });
}

function metadataValues(metadata: ActorNeutralWriteMetadata): [string, string | null, string | null] {
  return [metadata.origin, metadata.summary ?? null, metadata.correlationId ?? null];
}

function putBlob(db: SqliteDb, text: string): string {
  const sha256 = sha256Text(text);
  db.prepare("INSERT OR IGNORE INTO blobs (sha256, byte_length, text) VALUES (?, ?, ?)").run(
    sha256,
    Buffer.byteLength(text, "utf8"),
    text,
  );
  return sha256;
}

function snapshotFromRow(row: Record<string, unknown>): TextFileSnapshot {
  return {
    objectId: rowString(row, "object_id"),
    versionId: rowString(row, "version_id"),
    path: rowString(row, "path"),
    text: rowString(row, "text"),
    updatedAtMs: rowNumber(row, "updated_at_ms"),
    latestMomentId: rowString(row, "latest_moment_id"),
    metadata: metadataFromRow(row),
  };
}

function momentFromRow(row: Record<string, unknown>): VersionedTextMoment {
  const beforePresent = Number(row.before_present);
  const before =
    beforePresent === 0
      ? undefined
      : beforePresent === 1
        ? null
        : {
            objectId: rowString(row, "before_object_id"),
            versionId: rowString(row, "before_version_id"),
            path: rowString(row, "before_path"),
            text: rowString(row, "before_text"),
            updatedAtMs: rowNumber(row, "before_updated_at_ms"),
            latestMomentId: rowString(row, "before_latest_moment_id"),
            metadata: metadataFromRow(row, "before_metadata_"),
          };
  const payloadBeforePath = rowOptionalString(row, "payload_before_path");
  const author = momentAuthorFromRow(row);
  return {
    id: rowString(row, "moment_id"),
    workspaceId: rowString(row, "workspace_id"),
    versionId: rowString(row, "version_id"),
    objectId: rowString(row, "object_id"),
    path: rowString(row, "path"),
    recordedAtMs: rowNumber(row, "recorded_at_ms"),
    operation: rowString(row, "operation") as VersionedTextMoment["operation"],
    payload: {
      before: payloadBeforePath
        ? { path: payloadBeforePath, text: rowString(row, "payload_before_text") }
        : null,
      after: {
        path: rowString(row, "payload_after_path"),
        text: rowString(row, "payload_after_text"),
      },
    },
    metadata: metadataFromRow(row),
    ...(author !== undefined ? { author } : {}),
    ...(beforePresent === 0 ? {} : { before }),
  };
}

function momentSelectSql(where: string): string {
  return `SELECT m.*,
                 before_payload.text AS payload_before_text,
                 after_payload.text AS payload_after_text,
                 before_blob.text AS before_text
          FROM moments m
          LEFT JOIN blobs before_payload ON before_payload.sha256 = m.payload_before_blob_sha256
          JOIN blobs after_payload ON after_payload.sha256 = m.payload_after_blob_sha256
          LEFT JOIN blobs before_blob ON before_blob.sha256 = m.before_blob_sha256
          ${where}`;
}

function fileStateFromConflictRow(
  row: Record<string, unknown>,
  prefix: "base" | "current" | "incoming",
): VersionedTextFileState {
  const path = rowString(row, `${prefix}_path`);
  if (Number(row[`${prefix}_exists`]) !== 1) return { exists: false, path };
  return {
    exists: true,
    path,
    objectId: rowString(row, `${prefix}_object_id`),
    text: rowString(row, `${prefix}_text`),
    updatedAtMs: rowNumber(row, `${prefix}_updated_at_ms`),
    latestMomentId: rowString(row, `${prefix}_latest_moment_id`),
    metadata: metadataFromRow(row, `${prefix}_metadata_`),
  };
}

function loadStateFromDatabase(db: SqliteDb): PersistedVersionedTextState {
  const state = initialState();
  try {
    for (const row of db
      .prepare("SELECT workspace_id, main_version_id FROM versioned_workspaces ORDER BY workspace_id")
      .all()) {
      state.workspaces[rowString(row, "workspace_id")] = {
        mainVersionId: rowString(row, "main_version_id"),
        versions: createDictionary(),
        objects: createDictionary(),
        pathAliases: createDictionary(),
        snapshots: createDictionary(),
        forkBaseSnapshots: createDictionary(),
        moments: [],
        conflicts: createDictionary(),
      };
    }

    for (const row of db
      .prepare(
        "SELECT * FROM versions ORDER BY workspace_id, created_at_ms, name, version_id",
      )
      .all()) {
      const workspace = state.workspaces[rowString(row, "workspace_id")];
      if (!workspace) throw corruptStore();
      const forkVersionId = rowOptionalString(row, "fork_version_id");
      const version: VersionRecord = {
        id: rowString(row, "version_id"),
        workspaceId: rowString(row, "workspace_id"),
        kind: rowString(row, "kind") as VersionKind,
        name: rowString(row, "name"),
        createdAtMs: rowNumber(row, "created_at_ms"),
        ...(forkVersionId
          ? {
              forkPoint: {
                versionId: forkVersionId,
                ...(rowOptionalString(row, "fork_moment_id")
                  ? { momentId: rowOptionalString(row, "fork_moment_id") }
                  : {}),
              },
            }
          : {}),
      };
      workspace.versions[version.id] = version;
      workspace.pathAliases[version.id] ??= createDictionary();
      workspace.snapshots[version.id] ??= createDictionary();
    }

    for (const row of db.prepare("SELECT * FROM file_objects ORDER BY workspace_id, object_id").all()) {
      const workspace = state.workspaces[rowString(row, "workspace_id")];
      if (!workspace) throw corruptStore();
      workspace.objects[rowString(row, "object_id")] = {
        id: rowString(row, "object_id"),
        workspaceId: rowString(row, "workspace_id"),
        createdAtMs: rowNumber(row, "created_at_ms"),
      };
    }

    for (const row of db
      .prepare("SELECT * FROM path_aliases ORDER BY workspace_id, version_id, path")
      .all()) {
      const workspace = state.workspaces[rowString(row, "workspace_id")];
      if (!workspace) throw corruptStore();
      const versionId = rowString(row, "version_id");
      workspace.pathAliases[versionId] ??= createDictionary();
      workspace.pathAliases[versionId][rowString(row, "path")] = rowString(row, "object_id");
    }

    for (const row of db
      .prepare(
        `SELECT s.*, b.text
         FROM snapshots s
         JOIN blobs b ON b.sha256 = s.blob_sha256
         ORDER BY s.workspace_id, s.version_id, s.path`,
      )
      .all()) {
      const workspace = state.workspaces[rowString(row, "workspace_id")];
      if (!workspace) throw corruptStore();
      const versionId = rowString(row, "version_id");
      workspace.snapshots[versionId] ??= createDictionary();
      const snapshot = snapshotFromRow(row);
      workspace.snapshots[versionId][snapshot.objectId] = snapshot;
    }

    for (const row of db
      .prepare(
        `SELECT s.*, b.text
         FROM fork_base_snapshots s
         JOIN blobs b ON b.sha256 = s.blob_sha256
         ORDER BY s.workspace_id, s.version_id, s.path`,
      )
      .all()) {
      const workspace = state.workspaces[rowString(row, "workspace_id")];
      if (!workspace) throw corruptStore();
      const versionId = rowString(row, "version_id");
      workspace.forkBaseSnapshots[versionId] ??= createDictionary();
      const snapshot = snapshotFromRow(row);
      workspace.forkBaseSnapshots[versionId][snapshot.objectId] = snapshot;
    }

    for (const row of db
      .prepare(
        `SELECT m.*,
                before_payload.text AS payload_before_text,
                after_payload.text AS payload_after_text,
                before_blob.text AS before_text
         FROM moments m
         LEFT JOIN blobs before_payload ON before_payload.sha256 = m.payload_before_blob_sha256
         JOIN blobs after_payload ON after_payload.sha256 = m.payload_after_blob_sha256
         LEFT JOIN blobs before_blob ON before_blob.sha256 = m.before_blob_sha256
         ORDER BY m.workspace_id, m.moment_order`,
      )
      .all()) {
      const workspace = state.workspaces[rowString(row, "workspace_id")];
      if (!workspace) throw corruptStore();
      const beforePresent = Number(row.before_present);
      const before =
        beforePresent === 0
          ? undefined
          : beforePresent === 1
            ? null
            : {
                objectId: rowString(row, "before_object_id"),
                versionId: rowString(row, "before_version_id"),
                path: rowString(row, "before_path"),
                text: rowString(row, "before_text"),
                updatedAtMs: rowNumber(row, "before_updated_at_ms"),
                latestMomentId: rowString(row, "before_latest_moment_id"),
                metadata: metadataFromRow(row, "before_metadata_"),
              };
      const payloadBeforePath = rowOptionalString(row, "payload_before_path");
      const author = momentAuthorFromRow(row);
      workspace.moments.push({
        id: rowString(row, "moment_id"),
        workspaceId: rowString(row, "workspace_id"),
        versionId: rowString(row, "version_id"),
        objectId: rowString(row, "object_id"),
        path: rowString(row, "path"),
        recordedAtMs: rowNumber(row, "recorded_at_ms"),
        operation: rowString(row, "operation") as VersionedTextMoment["operation"],
        payload: {
          before: payloadBeforePath
            ? { path: payloadBeforePath, text: rowString(row, "payload_before_text") }
            : null,
          after: {
            path: rowString(row, "payload_after_path"),
            text: rowString(row, "payload_after_text"),
          },
        },
        metadata: metadataFromRow(row),
        ...(author !== undefined ? { author } : {}),
        ...(beforePresent === 0 ? {} : { before }),
      });
    }

    for (const row of db
      .prepare(
        `SELECT c.*,
                base_blob.text AS base_text,
                current_blob.text AS current_text,
                incoming_blob.text AS incoming_text
         FROM conflicts c
         LEFT JOIN blobs base_blob ON base_blob.sha256 = c.base_blob_sha256
         LEFT JOIN blobs current_blob ON current_blob.sha256 = c.current_blob_sha256
         LEFT JOIN blobs incoming_blob ON incoming_blob.sha256 = c.incoming_blob_sha256
         ORDER BY c.workspace_id, c.created_at_ms, c.conflict_id`,
      )
      .all()) {
      const workspace = state.workspaces[rowString(row, "workspace_id")];
      if (!workspace) throw corruptStore();
      const conflict: VersionedTextConflictRecord = {
        id: rowString(row, "conflict_id"),
        workspaceId: rowString(row, "workspace_id"),
        path: rowString(row, "path"),
        targetVersionId: rowString(row, "target_version_id"),
        sourceVersionId: rowString(row, "source_version_id"),
        createdAtMs: rowNumber(row, "created_at_ms"),
        updatedAtMs: rowNumber(row, "updated_at_ms"),
        base: fileStateFromConflictRow(row, "base"),
        current: fileStateFromConflictRow(row, "current"),
        incoming: fileStateFromConflictRow(row, "incoming"),
        status: rowString(row, "status") as VersionedTextConflictStatus,
        chosenFrom: rowString(row, "chosen_from") as VersionedTextConflictChoice,
        metadata: metadataFromRow(row),
        ...(rowOptionalString(row, "resolution")
          ? { resolution: rowOptionalString(row, "resolution") as VersionedTextConflictResolution }
          : {}),
      };
      workspace.conflicts[conflict.id] = conflict;
    }
  } catch (error) {
    if (error instanceof VersionedTextStoreError) throw error;
    throw corruptStore(error);
  }

  return normalizeHydratedState(state);
}

function insertConflictFileState(
  db: SqliteDb,
  state: VersionedTextFileState,
): [
  number,
  string,
  string | null,
  string | null,
  number | null,
  string | null,
  string | null,
  string | null,
  string | null,
] {
  if (!state.exists) {
    return [0, state.path, null, null, null, null, null, null, null];
  }
  const metadata = state.metadata ?? { origin: "unknown" as const };
  return [
    1,
    state.path,
    state.objectId ?? null,
    putBlob(db, state.text ?? ""),
    state.updatedAtMs ?? null,
    state.latestMomentId ?? null,
    ...metadataValues(metadata),
  ];
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

const MOMENT_LIST_DEFAULT_LIMIT = 200;
const MOMENT_LIST_MAX_LIMIT = 500;

function normalizeMomentListLimit(limit: number | undefined): number {
  if (limit === undefined) return MOMENT_LIST_DEFAULT_LIMIT;
  if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1) {
    throw new VersionedTextStoreError(
      "invalid-input",
      "Moment list limit must be a positive integer.",
    );
  }
  return Math.min(limit, MOMENT_LIST_MAX_LIMIT);
}

function normalizeMomentListCursor(cursor: number | undefined): number | undefined {
  if (cursor === undefined) return undefined;
  if (typeof cursor !== "number" || !Number.isFinite(cursor)) {
    throw new VersionedTextStoreError(
      "invalid-input",
      "Moment list cursor must be a finite number.",
    );
  }
  return cursor;
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

// PR 08 secret floor, enforced at the store door: this store persists
// PLAINTEXT snapshots/moments, so a secret-classified path (the
// classifyEngineFilePath floor — .dohc policy can never unmark it) must be
// rejected by every mutating entry point that could introduce a new path.
// Read/compare/merge paths need no gate: a secret path can never gain a row,
// so they honestly report absence. Secret-backed files are versioned by the
// dedicated encrypted secret file store instead.
function normalizePlaintextStorablePath(path: string): string {
  const normalized = normalizeWritePath(path);
  if (classifyEngineFilePath(normalized).kind === "secret") {
    throw new VersionedTextStoreError(
      "invalid-path",
      `Secret-classified path ${JSON.stringify(normalized)} cannot be stored as plaintext; secret-backed files go through the secret file store.`,
    );
  }
  return normalized;
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

function rejectDuplicateId(kind: "conflict" | "moment" | "object" | "version", id: string): never {
  throw new VersionedTextStoreError("duplicate-id", `Generated ${kind} id ${id} already exists.`);
}

function normalizeGeneratedId(
  kind: "conflict" | "moment" | "object" | "version",
  id: unknown,
): string {
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

function defaultCreateId(kind: "conflict" | "moment" | "object" | "version"): string {
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
    forkBaseSnapshots: createDictionary(),
    moments: [],
    conflicts: createDictionary(),
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

function snapshotByPath(
  snapshots: Record<WorkspaceObjectId, TextFileSnapshot> | undefined,
  path: string,
): TextFileSnapshot | null {
  for (const snapshot of Object.values(snapshots ?? {})) {
    if (snapshot.path === path) return snapshot;
  }
  return null;
}

function fileStateFromSnapshot(
  path: string,
  snapshot: TextFileSnapshot | null,
): VersionedTextFileState {
  if (!snapshot) return { exists: false, path };
  return {
    exists: true,
    path: snapshot.path,
    objectId: snapshot.objectId,
    text: snapshot.text,
    updatedAtMs: snapshot.updatedAtMs,
    latestMomentId: snapshot.latestMomentId,
    metadata: cloneJson(snapshot.metadata),
  };
}

function fileStatesEqual(a: VersionedTextFileState, b: VersionedTextFileState): boolean {
  if (a.exists !== b.exists) return false;
  if (!a.exists && !b.exists) return true;
  return a.text === b.text;
}

function comparisonStatus(input: {
  base: VersionedTextFileState;
  current: VersionedTextFileState;
  incoming: VersionedTextFileState;
}): VersionedTextComparisonStatus {
  if (fileStatesEqual(input.current, input.incoming)) return "same";
  if (fileStatesEqual(input.current, input.base)) return "incoming-changed";
  if (fileStatesEqual(input.incoming, input.base)) return "current-changed";
  return "diverged";
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
  author?: MomentAuthor;
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
    ...(input.author !== undefined ? { author: pickMomentAuthor(input.author) } : {}),
    before: input.before === null ? null : cloneSnapshot(input.before),
  };
}

function versionFromRow(row: Record<string, unknown>): VersionRecord {
  const forkVersionId = rowOptionalString(row, "fork_version_id");
  return {
    id: rowString(row, "version_id"),
    workspaceId: rowString(row, "workspace_id"),
    kind: rowString(row, "kind") as VersionKind,
    name: rowString(row, "name"),
    createdAtMs: rowNumber(row, "created_at_ms"),
    ...(forkVersionId
      ? {
          forkPoint: {
            versionId: forkVersionId,
            ...(rowOptionalString(row, "fork_moment_id")
              ? { momentId: rowOptionalString(row, "fork_moment_id") }
              : {}),
          },
        }
      : {}),
  };
}

function objectFromRow(row: Record<string, unknown>): FileObjectRecord {
  return {
    id: rowString(row, "object_id"),
    workspaceId: rowString(row, "workspace_id"),
    createdAtMs: rowNumber(row, "created_at_ms"),
  };
}

function selectSnapshotByObject(
  db: SqliteDb,
  workspaceId: WorkspaceId,
  versionId: VersionId,
  objectId: WorkspaceObjectId,
): TextFileSnapshot | null {
  const row = db
    .prepare(
      `SELECT s.*, b.text
       FROM snapshots s
       JOIN blobs b ON b.sha256 = s.blob_sha256
       WHERE s.workspace_id = ? AND s.version_id = ? AND s.object_id = ?`,
    )
    .get(workspaceId, versionId, objectId);
  return row ? snapshotFromRow(row) : null;
}

function selectSnapshotByPath(
  db: SqliteDb,
  workspaceId: WorkspaceId,
  versionId: VersionId,
  path: string,
): TextFileSnapshot | null {
  const aliased = db
    .prepare(
      `SELECT s.*, b.text
       FROM path_aliases a
       JOIN snapshots s
         ON s.workspace_id = a.workspace_id
        AND s.version_id = a.version_id
        AND s.object_id = a.object_id
       JOIN blobs b ON b.sha256 = s.blob_sha256
       WHERE a.workspace_id = ? AND a.version_id = ? AND a.path = ?`,
    )
    .get(workspaceId, versionId, path);
  if (aliased) {
    const snapshot = snapshotFromRow(aliased);
    if (snapshot.path !== path) throw corruptStore();
    return snapshot;
  }
  const fallback = db
    .prepare(
      `SELECT s.*, b.text
       FROM snapshots s
       JOIN blobs b ON b.sha256 = s.blob_sha256
       WHERE s.workspace_id = ? AND s.version_id = ? AND s.path = ?
       LIMIT 2`,
    )
    .all(workspaceId, versionId, path);
  if (fallback.length > 1) throw corruptStore();
  return fallback[0] ? snapshotFromRow(fallback[0]) : null;
}

function selectForkBaseSnapshotByPath(
  db: SqliteDb,
  workspaceId: WorkspaceId,
  versionId: VersionId,
  path: string,
): TextFileSnapshot | null {
  const rows = db
    .prepare(
      `SELECT s.*, b.text
       FROM fork_base_snapshots s
       JOIN blobs b ON b.sha256 = s.blob_sha256
       WHERE s.workspace_id = ? AND s.version_id = ? AND s.path = ?
       LIMIT 2`,
    )
    .all(workspaceId, versionId, path);
  if (rows.length > 1) throw corruptStore();
  return rows[0] ? snapshotFromRow(rows[0]) : null;
}

function requireWorkspaceVersionRow(
  db: SqliteDb,
  workspaceId: WorkspaceId,
  versionId: VersionId,
): VersionRecord {
  const row = db
    .prepare("SELECT * FROM versions WHERE workspace_id = ? AND version_id = ?")
    .get(workspaceId, versionId);
  if (row) return versionFromRow(row);
  const other = db
    .prepare("SELECT workspace_id FROM versions WHERE version_id = ? AND workspace_id <> ?")
    .get(versionId, workspaceId);
  if (other && versionId !== "main") {
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

function ensureWorkspaceRow(
  db: SqliteDb,
  workspaceId: WorkspaceId,
  nowMs: number,
): VersionRecord {
  const existing = db
    .prepare(
      `SELECT v.*
       FROM versioned_workspaces w
       JOIN versions v
         ON v.workspace_id = w.workspace_id
        AND v.version_id = w.main_version_id
       WHERE w.workspace_id = ?`,
    )
    .get(workspaceId);
  if (existing) return versionFromRow(existing);

  const main: VersionRecord = {
    id: "main",
    workspaceId,
    kind: "main",
    name: "Main",
    createdAtMs: nowMs,
  };
  db.prepare("INSERT INTO versioned_workspaces (workspace_id, main_version_id) VALUES (?, ?)").run(
    workspaceId,
    main.id,
  );
  db.prepare(
    `INSERT INTO versions (
      workspace_id, version_id, kind, name, created_at_ms, fork_version_id, fork_moment_id
    ) VALUES (?, ?, ?, ?, ?, NULL, NULL)`,
  ).run(workspaceId, main.id, main.kind, main.name, main.createdAtMs);
  return main;
}

function insertOrReplaceSnapshot(
  db: SqliteDb,
  table: "snapshots" | "fork_base_snapshots",
  workspaceId: WorkspaceId,
  versionId: VersionId,
  snapshot: TextFileSnapshot,
): void {
  const blobSha256 = putBlob(db, snapshot.text);
  db.prepare(
    `INSERT INTO ${table} (
      workspace_id, version_id, object_id, path, blob_sha256, updated_at_ms,
      latest_moment_id, metadata_origin, metadata_summary, metadata_correlation_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(workspace_id, version_id, object_id) DO UPDATE SET
      path = excluded.path,
      blob_sha256 = excluded.blob_sha256,
      updated_at_ms = excluded.updated_at_ms,
      latest_moment_id = excluded.latest_moment_id,
      metadata_origin = excluded.metadata_origin,
      metadata_summary = excluded.metadata_summary,
      metadata_correlation_id = excluded.metadata_correlation_id`,
  ).run(
    workspaceId,
    versionId,
    snapshot.objectId,
    snapshot.path,
    blobSha256,
    snapshot.updatedAtMs,
    snapshot.latestMomentId,
    ...metadataValues(snapshot.metadata),
  );
}

function nextMomentOrder(db: SqliteDb, workspaceId: WorkspaceId): number {
  const row = db
    .prepare("SELECT COALESCE(MAX(moment_order), -1) + 1 AS next_order FROM moments WHERE workspace_id = ?")
    .get(workspaceId);
  return Number(row?.next_order ?? 0);
}

function insertMomentRow(db: SqliteDb, moment: VersionedTextMoment): void {
  const payloadBeforeSha = moment.payload.before ? putBlob(db, moment.payload.before.text) : null;
  const payloadAfterSha = putBlob(db, moment.payload.after.text);
  const beforePresent = moment.before === undefined ? 0 : moment.before === null ? 1 : 2;
  const beforeSha = moment.before && moment.before !== null ? putBlob(db, moment.before.text) : null;
  db.prepare(
    `INSERT INTO moments (
      workspace_id, moment_order, moment_id, version_id, object_id, path,
      recorded_at_ms, operation, payload_before_path, payload_before_blob_sha256,
      payload_after_path, payload_after_blob_sha256, metadata_origin,
      metadata_summary, metadata_correlation_id, before_present, before_object_id,
      before_version_id, before_path, before_blob_sha256, before_updated_at_ms,
      before_latest_moment_id, before_metadata_origin, before_metadata_summary,
      before_metadata_correlation_id, author_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    moment.workspaceId,
    nextMomentOrder(db, moment.workspaceId),
    moment.id,
    moment.versionId,
    moment.objectId,
    moment.path,
    moment.recordedAtMs,
    moment.operation,
    moment.payload.before?.path ?? null,
    payloadBeforeSha,
    moment.payload.after.path,
    payloadAfterSha,
    ...metadataValues(moment.metadata),
    beforePresent,
    moment.before && moment.before !== null ? moment.before.objectId : null,
    moment.before && moment.before !== null ? moment.before.versionId : null,
    moment.before && moment.before !== null ? moment.before.path : null,
    beforeSha,
    moment.before && moment.before !== null ? moment.before.updatedAtMs : null,
    moment.before && moment.before !== null ? moment.before.latestMomentId : null,
    ...(moment.before && moment.before !== null ? metadataValues(moment.before.metadata) : [null, null, null]),
    momentAuthorToJson(moment.author),
  );
}

function requireFileObjectRow(
  db: SqliteDb,
  workspaceId: WorkspaceId,
  objectId: WorkspaceObjectId,
): FileObjectRecord {
  const row = db
    .prepare("SELECT * FROM file_objects WHERE workspace_id = ? AND object_id = ?")
    .get(workspaceId, objectId);
  if (!row) throw corruptStore();
  return objectFromRow(row);
}

function insertConflictRow(db: SqliteDb, conflict: VersionedTextConflictRecord): void {
  db.prepare(
    `INSERT INTO conflicts (
      workspace_id, conflict_id, path, target_version_id, source_version_id,
      created_at_ms, updated_at_ms, status, chosen_from, resolution,
      metadata_origin, metadata_summary, metadata_correlation_id,
      base_exists, base_path, base_object_id, base_blob_sha256, base_updated_at_ms,
      base_latest_moment_id, base_metadata_origin, base_metadata_summary,
      base_metadata_correlation_id, current_exists, current_path, current_object_id,
      current_blob_sha256, current_updated_at_ms, current_latest_moment_id,
      current_metadata_origin, current_metadata_summary, current_metadata_correlation_id,
      incoming_exists, incoming_path, incoming_object_id, incoming_blob_sha256,
      incoming_updated_at_ms, incoming_latest_moment_id, incoming_metadata_origin,
      incoming_metadata_summary, incoming_metadata_correlation_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    conflict.workspaceId,
    conflict.id,
    conflict.path,
    conflict.targetVersionId,
    conflict.sourceVersionId,
    conflict.createdAtMs,
    conflict.updatedAtMs,
    conflict.status,
    conflict.chosenFrom,
    conflict.resolution ?? null,
    ...metadataValues(conflict.metadata),
    ...insertConflictFileState(db, conflict.base),
    ...insertConflictFileState(db, conflict.current),
    ...insertConflictFileState(db, conflict.incoming),
  );
}

function conflictFromRow(row: Record<string, unknown>): VersionedTextConflictRecord {
  return {
    id: rowString(row, "conflict_id"),
    workspaceId: rowString(row, "workspace_id"),
    path: rowString(row, "path"),
    targetVersionId: rowString(row, "target_version_id"),
    sourceVersionId: rowString(row, "source_version_id"),
    createdAtMs: rowNumber(row, "created_at_ms"),
    updatedAtMs: rowNumber(row, "updated_at_ms"),
    base: fileStateFromConflictRow(row, "base"),
    current: fileStateFromConflictRow(row, "current"),
    incoming: fileStateFromConflictRow(row, "incoming"),
    status: rowString(row, "status") as VersionedTextConflictStatus,
    chosenFrom: rowString(row, "chosen_from") as VersionedTextConflictChoice,
    metadata: metadataFromRow(row),
    ...(rowOptionalString(row, "resolution")
      ? { resolution: rowOptionalString(row, "resolution") as VersionedTextConflictResolution }
      : {}),
  };
}

function conflictSelectSql(where: string): string {
  return `SELECT c.*,
                 base_blob.text AS base_text,
                 current_blob.text AS current_text,
                 incoming_blob.text AS incoming_text
          FROM conflicts c
          LEFT JOIN blobs base_blob ON base_blob.sha256 = c.base_blob_sha256
          LEFT JOIN blobs current_blob ON current_blob.sha256 = c.current_blob_sha256
          LEFT JOIN blobs incoming_blob ON incoming_blob.sha256 = c.incoming_blob_sha256
          ${where}`;
}

function selectMomentByOrder(
  db: SqliteDb,
  workspaceId: WorkspaceId,
  versionId: VersionId,
  objectId: WorkspaceObjectId,
  maxOrder: number,
): { moment: VersionedTextMoment; order: number } | null {
  const row = db
    .prepare(
      momentSelectSql(
        `WHERE m.workspace_id = ? AND m.version_id = ? AND m.object_id = ? AND m.moment_order <= ?
         ORDER BY m.moment_order DESC LIMIT 1`,
      ),
    )
    .get(workspaceId, versionId, objectId, maxOrder);
  return row ? { moment: momentFromRow(row), order: rowNumber(row, "moment_order") } : null;
}

function inheritedObjectMomentFromDb(
  db: SqliteDb,
  workspaceId: WorkspaceId,
  versionId: VersionId,
  objectId: WorkspaceObjectId,
  seen = new Set<VersionId>(),
): { moment: VersionedTextMoment; order: number } | null {
  if (seen.has(versionId)) throw corruptStore();
  seen.add(versionId);
  const version = requireWorkspaceVersionRow(db, workspaceId, versionId);
  if (!version.forkPoint) return null;
  let forkOrder = -1;
  if (version.forkPoint.momentId !== undefined) {
    const forkMoment = db
      .prepare("SELECT moment_order FROM moments WHERE workspace_id = ? AND moment_id = ?")
      .get(workspaceId, version.forkPoint.momentId);
    if (!forkMoment) throw corruptStore();
    forkOrder = rowNumber(forkMoment, "moment_order");
  }
  return (
    selectMomentByOrder(db, workspaceId, version.forkPoint.versionId, objectId, forkOrder) ??
    inheritedObjectMomentFromDb(
      db,
      workspaceId,
      version.forkPoint.versionId,
      objectId,
      seen,
    )
  );
}

function rollbackMomentHasDependentsInDb(input: {
  db: SqliteDb;
  workspaceId: WorkspaceId;
  versionId: VersionId;
  momentId: VersionedTextMomentId;
  momentOrder: number;
  objectId: WorkspaceObjectId;
}): boolean {
  if (
    input.db
      .prepare(
        `SELECT 1 FROM snapshots
         WHERE workspace_id = ? AND version_id <> ? AND latest_moment_id = ?
         LIMIT 1`,
      )
      .get(input.workspaceId, input.versionId, input.momentId)
  ) {
    return true;
  }
  if (
    input.db
      .prepare(
        `SELECT 1 FROM moments
         WHERE workspace_id = ? AND moment_id <> ? AND object_id = ? AND before_latest_moment_id = ?
         LIMIT 1`,
      )
      .get(input.workspaceId, input.momentId, input.objectId, input.momentId)
  ) {
    return true;
  }

  const versions = new Map(
    input.db
      .prepare("SELECT * FROM versions WHERE workspace_id = ?")
      .all(input.workspaceId)
      .map((row) => [rowString(row, "version_id"), versionFromRow(row)] as const),
  );
  const momentOrders = new Map(
    input.db
      .prepare("SELECT moment_id, moment_order FROM moments WHERE workspace_id = ?")
      .all(input.workspaceId)
      .map((row) => [rowString(row, "moment_id"), rowNumber(row, "moment_order")] as const),
  );
  const objectMoments = input.db
    .prepare(
      `SELECT version_id, moment_order, before_present
       FROM moments
       WHERE workspace_id = ? AND object_id = ?
       ORDER BY moment_order`,
    )
    .all(input.workspaceId, input.objectId);

  const versionHasIndependentObjectMutationInRange = (
    candidateVersionId: VersionId,
    afterOrder: number,
    atOrBeforeOrder: number,
  ) =>
    objectMoments.some(
      (row) =>
        rowString(row, "version_id") === candidateVersionId &&
        rowNumber(row, "moment_order") > afterOrder &&
        rowNumber(row, "moment_order") <= atOrBeforeOrder &&
        Number(row.before_present) === 2,
    );

  const lineageHasIndependentObjectMutation = (
    candidateVersionId: VersionId,
    afterOrder: number,
  ): boolean => {
    let cursor = versions.get(candidateVersionId);
    let atOrBeforeOrder = Number.POSITIVE_INFINITY;
    const seen = new Set<VersionId>();
    while (cursor) {
      if (seen.has(cursor.id)) return false;
      seen.add(cursor.id);
      if (
        versionHasIndependentObjectMutationInRange(
          cursor.id,
          afterOrder,
          atOrBeforeOrder,
        )
      ) {
        return true;
      }
      if (!cursor.forkPoint || cursor.forkPoint.versionId === input.versionId) return false;
      atOrBeforeOrder =
        cursor.forkPoint.momentId === undefined
          ? -1
          : (momentOrders.get(cursor.forkPoint.momentId) ?? -1);
      cursor = versions.get(cursor.forkPoint.versionId);
    }
    return false;
  };

  const forkOrderFromVersion = (version: VersionRecord): number | null => {
    let cursor: VersionRecord | undefined = version;
    const seen = new Set<VersionId>();
    while (cursor?.forkPoint) {
      if (seen.has(cursor.id)) return null;
      seen.add(cursor.id);
      if (cursor.forkPoint.versionId === input.versionId) {
        return cursor.forkPoint.momentId
          ? (momentOrders.get(cursor.forkPoint.momentId) ?? null)
          : null;
      }
      cursor = versions.get(cursor.forkPoint.versionId);
    }
    return null;
  };

  for (const version of versions.values()) {
    if (version.id === input.versionId) continue;
    const forkOrder = forkOrderFromVersion(version);
    if (
      forkOrder !== null &&
      forkOrder >= input.momentOrder &&
      (forkOrder === input.momentOrder ||
        !lineageHasIndependentObjectMutation(version.id, forkOrder))
    ) {
      return true;
    }
  }
  return false;
}

function createVersionedTextStoreWithHooks(
  rootDir: string,
  options: VersionedTextStoreOptions = {},
  testHooks: VersionedTextStoreTestHooks = {},
): VersionedTextStore {
  const nowMs = options.nowMs ?? (() => Date.now());
  const readNowMs = () => normalizeTimestamp(nowMs());
  const createId = options.createId ?? defaultCreateId;
  const createGeneratedId = (kind: "conflict" | "moment" | "object" | "version") =>
    normalizeGeneratedId(kind, createId(kind));
  const stateFilePath = storePath(resolve(normalizeRootDir(rootDir)));
  let activeWriteDb: SqliteDb | null = null;
  let dbHandle: SqliteDb | null = null;
  let validated = false;

  function db(): SqliteDb {
    if (!dbHandle) {
      dbHandle = openDatabase(rootDir, options.integrityCheck ?? "quick");
    }
    if (!validated) {
      loadStateFromDatabase(dbHandle);
      validated = true;
    }
    return dbHandle;
  }

  async function beforeWriteMutation(): Promise<void> {
    await testHooks.afterLoadWritableState?.();
  }

  async function persistBarrier(): Promise<void> {
    try {
      await testHooks.beforePersist?.();
      await testHooks.beforeAtomicPublish?.();
    } catch (error) {
      if (error instanceof VersionedTextStoreError && error.code === "state-corrupt") throw error;
      throw persistFailed(error);
    }
  }

  async function runTransaction<T>(task: () => Promise<T>): Promise<T> {
    const txDb = db();
    const previousDb = activeWriteDb;
    activeWriteDb = txDb;
    try {
      txDb.exec("BEGIN IMMEDIATE");
      const result = await task();
      txDb.exec("COMMIT");
      return result;
    } catch (error) {
      try {
        txDb.exec("ROLLBACK");
      } catch {}
      throw error;
    } finally {
      activeWriteDb = previousDb;
    }
  }

  function serialize<T>(task: () => Promise<T>): Promise<T> {
    const queuedBehindExistingWrite = storeWriteChains.has(stateFilePath);
    if (queuedBehindExistingWrite) {
      testHooks.onWriteQueued?.();
    }
    const previous = storeWriteChains.get(stateFilePath) ?? Promise.resolve();
    const run = previous.then(() => runTransaction(task), () => runTransaction(task));
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

  function compareTextFileVersionsInWorkspace(input: {
    workspace: PersistedWorkspaceState;
    workspaceId: WorkspaceId;
    targetVersionId: VersionId;
    sourceVersion: VersionRecord;
    path: string;
  }): VersionedTextComparison {
    if (
      input.sourceVersion.kind !== "named" ||
      input.sourceVersion.forkPoint?.versionId !== input.targetVersionId
    ) {
      throw new VersionedTextStoreError(
        "fork-base-not-found",
        `Version ${input.sourceVersion.id} does not have a fork base for ${input.targetVersionId}.`,
      );
    }

    const baseSnapshots = input.workspace.forkBaseSnapshots[input.sourceVersion.id];
    if (!baseSnapshots) {
      throw new VersionedTextStoreError(
        "fork-base-not-found",
        `Version ${input.sourceVersion.id} does not have durable fork-base snapshots.`,
      );
    }

    const base = fileStateFromSnapshot(input.path, snapshotByPath(baseSnapshots, input.path));
    const current = fileStateFromSnapshot(
      input.path,
      snapshotByPath(input.workspace.snapshots[input.targetVersionId], input.path),
    );
    const incoming = fileStateFromSnapshot(
      input.path,
      snapshotByPath(input.workspace.snapshots[input.sourceVersion.id], input.path),
    );

    return {
      workspaceId: input.workspaceId,
      path: input.path,
      targetVersionId: input.targetVersionId,
      sourceVersionId: input.sourceVersion.id,
      base,
      current,
      incoming,
      status: comparisonStatus({ base, current, incoming }),
    };
  }

  function writeTextFileInWorkspace(input: {
    state: PersistedVersionedTextState;
    workspace: PersistedWorkspaceState;
    workspaceId: WorkspaceId;
    versionId: VersionId;
    path: string;
    text: string;
    metadata: ActorNeutralWriteMetadata;
    momentId?: VersionedTextMomentId;
  }): VersionedTextWriteResult {
    const existingObjectId = findObjectIdByVersionPath(
      input.workspace,
      input.versionId,
      input.path,
    );
    const snapshots =
      getOwn(input.workspace.snapshots, input.versionId) ?? createDictionary<TextFileSnapshot>();
    input.workspace.snapshots[input.versionId] = snapshots;
    const before = existingObjectId ? (getOwn(snapshots, existingObjectId) ?? null) : null;
    if (before && before.path !== input.path) {
      throw new VersionedTextStoreError("state-corrupt", "Versioned text store is corrupt.");
    }
    const recordedAtMs = readNowMs();
    let objectId = existingObjectId;
    let newObject: FileObjectRecord | null = null;

    if (!objectId) {
      objectId = createGeneratedId("object");
      if (
        getOwn(input.workspace.objects, objectId) !== undefined ||
        objectExistsInAnotherWorkspace(input.state, input.workspaceId, objectId)
      ) {
        rejectDuplicateId("object", objectId);
      }
      newObject = {
        id: objectId,
        workspaceId: input.workspaceId,
        createdAtMs: recordedAtMs,
      };
    }

    const momentId =
      input.momentId === undefined
        ? createGeneratedId("moment")
        : normalizeGeneratedId("moment", input.momentId);
    if (input.workspace.moments.some((moment) => moment.id === momentId)) {
      rejectDuplicateId("moment", momentId);
    }
    if (newObject) {
      input.workspace.objects[objectId] = newObject;
    }
    const object = getOwn(input.workspace.objects, objectId);
    if (!object) {
      throw new VersionedTextStoreError("state-corrupt", "Versioned text store is corrupt.");
    }
    const moment = createMoment({
      id: momentId,
      workspaceId: input.workspaceId,
      versionId: input.versionId,
      objectId,
      path: input.path,
      recordedAtMs,
      operation: "write",
      payload: {
        before: before ? { path: before.path, text: before.text } : null,
        after: { path: input.path, text: input.text },
      },
      metadata: input.metadata,
      before,
    });
    const snapshot: TextFileSnapshot = {
      objectId,
      versionId: input.versionId,
      path: input.path,
      text: input.text,
      updatedAtMs: recordedAtMs,
      latestMomentId: moment.id,
      metadata: pickWriteMetadata(input.metadata),
    };

    pathAliasesForVersion(input.workspace, input.versionId)[input.path] = objectId;
    snapshots[objectId] = snapshot;
    input.workspace.moments.push(moment);
    return {
      object: cloneFileObject(object),
      snapshot: cloneSnapshot(snapshot),
      moment: cloneMoment(moment),
    };
  }

  function deleteTextFileInWorkspace(input: {
    workspace: PersistedWorkspaceState;
    workspaceId: WorkspaceId;
    versionId: VersionId;
    path: string;
    metadata: ActorNeutralWriteMetadata;
    momentId?: VersionedTextMomentId;
  }): VersionedTextDeleteResult {
    const objectId = findObjectIdByVersionPath(input.workspace, input.versionId, input.path);
    if (!objectId) {
      throw new VersionedTextStoreError("file-not-found", `File ${input.path} was not found.`);
    }
    const snapshots =
      getOwn(input.workspace.snapshots, input.versionId) ?? createDictionary<TextFileSnapshot>();
    input.workspace.snapshots[input.versionId] = snapshots;
    const before = getOwn(snapshots, objectId);
    if (!before || before.path !== input.path) {
      throw new VersionedTextStoreError("file-not-found", `File ${input.path} was not found.`);
    }

    const recordedAtMs = readNowMs();
    const momentId =
      input.momentId === undefined
        ? createGeneratedId("moment")
        : normalizeGeneratedId("moment", input.momentId);
    if (input.workspace.moments.some((moment) => moment.id === momentId)) {
      rejectDuplicateId("moment", momentId);
    }
    const moment = createMoment({
      id: momentId,
      workspaceId: input.workspaceId,
      versionId: input.versionId,
      objectId,
      path: input.path,
      recordedAtMs,
      operation: "delete",
      payload: {
        before: { path: before.path, text: before.text },
        after: { path: before.path, text: before.text },
      },
      metadata: input.metadata,
      before,
    });
    const aliases = pathAliasesForVersion(input.workspace, input.versionId);
    if (getOwn(aliases, input.path) === objectId) {
      delete aliases[input.path];
    }
    delete snapshots[objectId];
    input.workspace.moments.push(moment);
    const object = getOwn(input.workspace.objects, objectId);
    if (!object) {
      throw new VersionedTextStoreError("state-corrupt", "Versioned text store is corrupt.");
    }
    return {
      object: cloneFileObject(object),
      before: cloneSnapshot(before),
      moment: cloneMoment(moment),
    };
  }

  function recordTextConflict(input: {
    workspace: PersistedWorkspaceState;
    comparison: VersionedTextComparison;
    metadata: ActorNeutralWriteMetadata;
  }): VersionedTextConflictRecord {
    const recordedAtMs = readNowMs();
    const conflictId = createGeneratedId("conflict");
    if (getOwn(input.workspace.conflicts, conflictId) !== undefined) {
      rejectDuplicateId("conflict", conflictId);
    }
    const conflict: VersionedTextConflictRecord = {
      id: conflictId,
      workspaceId: input.comparison.workspaceId,
      path: input.comparison.path,
      targetVersionId: input.comparison.targetVersionId,
      sourceVersionId: input.comparison.sourceVersionId,
      createdAtMs: recordedAtMs,
      updatedAtMs: recordedAtMs,
      base: cloneJson(input.comparison.base),
      current: cloneJson(input.comparison.current),
      incoming: cloneJson(input.comparison.incoming),
      status: "open",
      chosenFrom: "current",
      metadata: pickWriteMetadata(input.metadata),
    };
    input.workspace.conflicts[conflict.id] = conflict;
    return conflict;
  }

  function compareTextFileVersionsInDb(input: {
    db: SqliteDb;
    workspaceId: WorkspaceId;
    targetVersionId: VersionId;
    sourceVersion: VersionRecord;
    path: string;
  }): VersionedTextComparison {
    if (
      input.sourceVersion.kind !== "named" ||
      input.sourceVersion.forkPoint?.versionId !== input.targetVersionId
    ) {
      throw new VersionedTextStoreError(
        "fork-base-not-found",
        `Version ${input.sourceVersion.id} does not have a fork base for ${input.targetVersionId}.`,
      );
    }

    const forkBaseCount = input.db
      .prepare(
        "SELECT COUNT(*) AS count FROM fork_base_snapshots WHERE workspace_id = ? AND version_id = ?",
      )
      .get(input.workspaceId, input.sourceVersion.id);
    if (Number(forkBaseCount?.count ?? 0) === 0) {
      throw new VersionedTextStoreError(
        "fork-base-not-found",
        `Version ${input.sourceVersion.id} does not have durable fork-base snapshots.`,
      );
    }

    const base = fileStateFromSnapshot(
      input.path,
      selectForkBaseSnapshotByPath(input.db, input.workspaceId, input.sourceVersion.id, input.path),
    );
    const current = fileStateFromSnapshot(
      input.path,
      selectSnapshotByPath(input.db, input.workspaceId, input.targetVersionId, input.path),
    );
    const incoming = fileStateFromSnapshot(
      input.path,
      selectSnapshotByPath(input.db, input.workspaceId, input.sourceVersion.id, input.path),
    );

    return {
      workspaceId: input.workspaceId,
      path: input.path,
      targetVersionId: input.targetVersionId,
      sourceVersionId: input.sourceVersion.id,
      base,
      current,
      incoming,
      status: comparisonStatus({ base, current, incoming }),
    };
  }

  function writeTextFileInDb(input: {
    db: SqliteDb;
    workspaceId: WorkspaceId;
    versionId: VersionId;
    path: string;
    text: string;
    metadata: ActorNeutralWriteMetadata;
    author?: MomentAuthor;
    momentId?: VersionedTextMomentId;
  }): VersionedTextWriteResult {
    requireWorkspaceVersionRow(input.db, input.workspaceId, input.versionId);
    const before = selectSnapshotByPath(input.db, input.workspaceId, input.versionId, input.path);
    const recordedAtMs = readNowMs();
    let object: FileObjectRecord;

    if (before) {
      object = requireFileObjectRow(input.db, input.workspaceId, before.objectId);
    } else {
      const objectId = createGeneratedId("object");
      const existing = input.db
        .prepare("SELECT workspace_id FROM file_objects WHERE object_id = ?")
        .get(objectId);
      if (existing) rejectDuplicateId("object", objectId);
      object = { id: objectId, workspaceId: input.workspaceId, createdAtMs: recordedAtMs };
      input.db
        .prepare("INSERT INTO file_objects (workspace_id, object_id, created_at_ms) VALUES (?, ?, ?)")
        .run(input.workspaceId, object.id, object.createdAtMs);
    }

    const momentId =
      input.momentId === undefined
        ? createGeneratedId("moment")
        : normalizeGeneratedId("moment", input.momentId);
    if (
      input.db
        .prepare("SELECT 1 FROM moments WHERE workspace_id = ? AND moment_id = ?")
        .get(input.workspaceId, momentId)
    ) {
      rejectDuplicateId("moment", momentId);
    }

    const moment = createMoment({
      id: momentId,
      workspaceId: input.workspaceId,
      versionId: input.versionId,
      objectId: object.id,
      path: input.path,
      recordedAtMs,
      operation: "write",
      payload: {
        before: before ? { path: before.path, text: before.text } : null,
        after: { path: input.path, text: input.text },
      },
      metadata: input.metadata,
      ...(input.author !== undefined ? { author: input.author } : {}),
      before,
    });
    const snapshot: TextFileSnapshot = {
      objectId: object.id,
      versionId: input.versionId,
      path: input.path,
      text: input.text,
      updatedAtMs: recordedAtMs,
      latestMomentId: moment.id,
      metadata: pickWriteMetadata(input.metadata),
    };

    insertMomentRow(input.db, moment);
    insertOrReplaceSnapshot(input.db, "snapshots", input.workspaceId, input.versionId, snapshot);
    input.db
      .prepare(
        `INSERT INTO path_aliases (workspace_id, version_id, path, object_id)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(workspace_id, version_id, path) DO UPDATE SET object_id = excluded.object_id`,
      )
      .run(input.workspaceId, input.versionId, input.path, object.id);
    upsertFileSearchIndex({
      db: input.db,
      rootDir,
      workspaceId: input.workspaceId,
      snapshot,
    });

    return {
      object: cloneFileObject(object),
      snapshot: cloneSnapshot(snapshot),
      moment: cloneMoment(moment),
    };
  }

  function deleteTextFileInDb(input: {
    db: SqliteDb;
    workspaceId: WorkspaceId;
    versionId: VersionId;
    path: string;
    metadata: ActorNeutralWriteMetadata;
    author?: MomentAuthor;
    momentId?: VersionedTextMomentId;
  }): VersionedTextDeleteResult {
    requireWorkspaceVersionRow(input.db, input.workspaceId, input.versionId);
    const before = selectSnapshotByPath(input.db, input.workspaceId, input.versionId, input.path);
    if (!before) {
      throw new VersionedTextStoreError("file-not-found", `File ${input.path} was not found.`);
    }
    const object = requireFileObjectRow(input.db, input.workspaceId, before.objectId);
    const recordedAtMs = readNowMs();
    const momentId =
      input.momentId === undefined
        ? createGeneratedId("moment")
        : normalizeGeneratedId("moment", input.momentId);
    if (
      input.db
        .prepare("SELECT 1 FROM moments WHERE workspace_id = ? AND moment_id = ?")
        .get(input.workspaceId, momentId)
    ) {
      rejectDuplicateId("moment", momentId);
    }
    const moment = createMoment({
      id: momentId,
      workspaceId: input.workspaceId,
      versionId: input.versionId,
      objectId: before.objectId,
      path: input.path,
      recordedAtMs,
      operation: "delete",
      payload: {
        before: { path: before.path, text: before.text },
        after: { path: before.path, text: before.text },
      },
      metadata: input.metadata,
      ...(input.author !== undefined ? { author: input.author } : {}),
      before,
    });

    insertMomentRow(input.db, moment);
    input.db
      .prepare(
        "DELETE FROM path_aliases WHERE workspace_id = ? AND version_id = ? AND path = ? AND object_id = ?",
      )
      .run(input.workspaceId, input.versionId, input.path, before.objectId);
    input.db
      .prepare("DELETE FROM snapshots WHERE workspace_id = ? AND version_id = ? AND object_id = ?")
      .run(input.workspaceId, input.versionId, before.objectId);
    deleteFileSearchIndex({
      db: input.db,
      workspaceId: input.workspaceId,
      versionId: input.versionId,
      objectId: before.objectId,
    });

    return { object, before: cloneSnapshot(before), moment: cloneMoment(moment) };
  }

  function recordTextConflictInDb(input: {
    db: SqliteDb;
    comparison: VersionedTextComparison;
    metadata: ActorNeutralWriteMetadata;
  }): VersionedTextConflictRecord {
    const recordedAtMs = readNowMs();
    const conflictId = createGeneratedId("conflict");
    if (
      input.db
        .prepare("SELECT 1 FROM conflicts WHERE workspace_id = ? AND conflict_id = ?")
        .get(input.comparison.workspaceId, conflictId)
    ) {
      rejectDuplicateId("conflict", conflictId);
    }
    const conflict: VersionedTextConflictRecord = {
      id: conflictId,
      workspaceId: input.comparison.workspaceId,
      path: input.comparison.path,
      targetVersionId: input.comparison.targetVersionId,
      sourceVersionId: input.comparison.sourceVersionId,
      createdAtMs: recordedAtMs,
      updatedAtMs: recordedAtMs,
      base: cloneJson(input.comparison.base),
      current: cloneJson(input.comparison.current),
      incoming: cloneJson(input.comparison.incoming),
      status: "open",
      chosenFrom: "current",
      metadata: pickWriteMetadata(input.metadata),
    };
    insertConflictRow(input.db, conflict);
    return conflict;
  }

  return {
    ensureSearchIndex(input: { workspaceId: WorkspaceId; versionId: VersionId }) {
      return serialize(async () => {
        assertInputEnvelope(input);
        const workspaceId = normalizeWorkspaceId(input.workspaceId);
        const versionId = normalizeVersionId(input.versionId);
        const txDb = db();
        requireWorkspaceVersionRow(txDb, workspaceId, versionId);
        ensureSearchIndexForVersion({
          db: txDb,
          rootDir,
          workspaceId,
          versionId,
          nowMs: readNowMs(),
        });
      });
    },

    querySearchIndex(input: {
      workspaceId: WorkspaceId;
      versionId: VersionId;
      query: string;
      limit: number;
    }) {
      return afterWrites(async () => {
        assertInputEnvelope(input);
        const workspaceId = normalizeWorkspaceId(input.workspaceId);
        const versionId = normalizeVersionId(input.versionId);
        const limit = Math.max(0, Math.floor(input.limit));
        if (limit <= 0) return [];
        const txDb = db();
        requireWorkspaceVersionRow(txDb, workspaceId, versionId);
        return querySearchIndex({
          db: txDb,
          rootDir,
          workspaceId,
          versionId,
          query: input.query,
          limit,
        });
      });
    },

    ensureMainVersion(input) {
      return serialize(async () => {
        assertInputEnvelope(input);
        const workspaceId = normalizeWorkspaceId(input.workspaceId);
        await beforeWriteMutation();
        const main = ensureWorkspaceRow(db(), workspaceId, readNowMs());
        await persistBarrier();
        return cloneVersion(main);
      });
    },

    getMainVersion(input) {
      return afterWrites(async () => {
        assertInputEnvelope(input);
        const workspaceId = normalizeWorkspaceId(input.workspaceId);
        const version = db()
          .prepare(
            `SELECT v.*
             FROM versioned_workspaces w
             JOIN versions v
               ON v.workspace_id = w.workspace_id
              AND v.version_id = w.main_version_id
             WHERE w.workspace_id = ?`,
          )
          .get(workspaceId);
        return version ? cloneVersion(versionFromRow(version)) : null;
      });
    },

    getActiveVersion(input) {
      return afterWrites(async () => {
        assertInputEnvelope(input);
        const workspaceId = normalizeWorkspaceId(input.workspaceId);
        const txDb = db();
        const workspaceRow = txDb
          .prepare("SELECT main_version_id FROM versioned_workspaces WHERE workspace_id = ?")
          .get(workspaceId);
        if (!workspaceRow) return null;
        const mainVersionId = rowString(workspaceRow, "main_version_id");
        const activeRow = txDb
          .prepare("SELECT version_id FROM active_versions WHERE workspace_id = ?")
          .get(workspaceId);
        const activeVersionId = activeRow ? rowString(activeRow, "version_id") : mainVersionId;
        const versionRow = txDb
          .prepare("SELECT * FROM versions WHERE workspace_id = ? AND version_id = ?")
          .get(workspaceId, activeVersionId);
        // A stale active row (should be unreachable: versions are never
        // deleted) reads as main rather than bricking every active-version
        // read for the workspace.
        const resolvedRow =
          versionRow ??
          txDb
            .prepare("SELECT * FROM versions WHERE workspace_id = ? AND version_id = ?")
            .get(workspaceId, mainVersionId);
        if (!resolvedRow) throw corruptStore();
        return cloneVersion(versionFromRow(resolvedRow));
      });
    },

    setActiveVersion(input) {
      return serialize(async () => {
        assertInputEnvelope(input);
        const workspaceId = normalizeWorkspaceId(input.workspaceId);
        const versionId = normalizeVersionId(input.versionId);
        await beforeWriteMutation();
        const txDb = db();
        // Fail closed: unknown ids and other-workspace ids throw before any
        // mutation (version-not-found / workspace-mismatch).
        const version = requireWorkspaceVersionRow(txDb, workspaceId, versionId);
        txDb
          .prepare(
            `INSERT INTO active_versions (workspace_id, version_id) VALUES (?, ?)
             ON CONFLICT(workspace_id) DO UPDATE SET version_id = excluded.version_id`,
          )
          .run(workspaceId, version.id);
        await persistBarrier();
        return cloneVersion(version);
      });
    },

    createNamedVersion(input) {
      return serialize(async () => {
        assertInputEnvelope(input);
        const workspaceId = normalizeWorkspaceId(input.workspaceId);
        const name = normalizeVersionName(input.name);
        const fromVersionId = normalizeVersionId(input.fromVersionId);
        await beforeWriteMutation();
        const txDb = db();
        const source = requireWorkspaceVersionRow(txDb, workspaceId, fromVersionId);
        if (
          txDb
            .prepare("SELECT 1 FROM versions WHERE workspace_id = ? AND name = ?")
            .get(workspaceId, name)
        ) {
          throw new VersionedTextStoreError(
            "version-name-conflict",
            `Version ${JSON.stringify(name)} already exists.`,
          );
        }

        const id = createGeneratedId("version");
        if (id !== "main" && txDb.prepare("SELECT 1 FROM versions WHERE version_id = ?").get(id)) {
          rejectDuplicateId("version", id);
        }
        const createdAtMs = readNowMs();
        const latestMoment = txDb
          .prepare(
            `SELECT moment_id FROM moments
             WHERE workspace_id = ? AND version_id = ?
             ORDER BY moment_order DESC LIMIT 1`,
          )
          .get(workspaceId, source.id);
        const latestMomentId = rowOptionalString(latestMoment ?? {}, "moment_id");
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

        txDb
          .prepare(
            `INSERT INTO versions (
              workspace_id, version_id, kind, name, created_at_ms, fork_version_id, fork_moment_id
            ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            workspaceId,
            version.id,
            version.kind,
            version.name,
            version.createdAtMs,
            version.forkPoint?.versionId ?? null,
            version.forkPoint?.momentId ?? null,
          );
        txDb
          .prepare(
            `INSERT INTO snapshots (
              workspace_id, version_id, object_id, path, blob_sha256, updated_at_ms,
              latest_moment_id, metadata_origin, metadata_summary, metadata_correlation_id
            )
            SELECT workspace_id, ?, object_id, path, blob_sha256, updated_at_ms,
                   latest_moment_id, metadata_origin, metadata_summary, metadata_correlation_id
            FROM snapshots
            WHERE workspace_id = ? AND version_id = ?`,
          )
          .run(id, workspaceId, source.id);
        txDb
          .prepare(
            `INSERT INTO path_aliases (workspace_id, version_id, path, object_id)
             SELECT workspace_id, ?, path, object_id
             FROM path_aliases
             WHERE workspace_id = ? AND version_id = ?`,
          )
          .run(id, workspaceId, source.id);
        txDb
          .prepare(
            `INSERT INTO fork_base_snapshots (
              workspace_id, version_id, object_id, path, blob_sha256, updated_at_ms,
              latest_moment_id, metadata_origin, metadata_summary, metadata_correlation_id
            )
            SELECT workspace_id, ?, object_id, path, blob_sha256, updated_at_ms,
                   latest_moment_id, metadata_origin, metadata_summary, metadata_correlation_id
            FROM snapshots
            WHERE workspace_id = ? AND version_id = ?`,
          )
          .run(id, workspaceId, source.id);
        await persistBarrier();
        return cloneVersion(version);
      });
    },

    listVersions(input) {
      return afterWrites(async () => {
        assertInputEnvelope(input);
        const workspaceId = normalizeWorkspaceId(input.workspaceId);
        return db()
          .prepare(
            `SELECT * FROM versions
             WHERE workspace_id = ?
             ORDER BY created_at_ms, name, version_id`,
          )
          .all(workspaceId)
          .map(versionFromRow)
          .map(cloneVersion);
      });
    },

    listMoments(input) {
      return afterWrites(async () => {
        assertInputEnvelope(input);
        const workspaceId = normalizeWorkspaceId(input.workspaceId);
        const versionId =
          input.versionId === undefined ? undefined : normalizeVersionId(input.versionId);
        const objectId =
          input.objectId === undefined ? undefined : normalizeObjectId(input.objectId);
        const limit = normalizeMomentListLimit(input.limit);
        const beforeMomentOrder = normalizeMomentListCursor(input.beforeMomentOrder);
        const txDb = db();
        // Fail closed on an unknown or other-workspace version filter instead
        // of silently returning an empty timeline for it.
        if (versionId !== undefined) {
          requireWorkspaceVersionRow(txDb, workspaceId, versionId);
        }
        const conditions = ["m.workspace_id = ?"];
        const params: unknown[] = [workspaceId];
        if (versionId !== undefined) {
          conditions.push("m.version_id = ?");
          params.push(versionId);
        }
        if (objectId !== undefined) {
          conditions.push("m.object_id = ?");
          params.push(objectId);
        }
        const filterSql = conditions.join(" AND ");
        const latestRow = txDb
          .prepare(
            `SELECT COALESCE(MAX(m.moment_order), -1) AS latest_order
             FROM moments m WHERE ${filterSql}`,
          )
          .get(...params);
        const latestMomentOrder = rowNumber(latestRow ?? {}, "latest_order");
        const pageConditions = [...conditions];
        const pageParams = [...params];
        if (beforeMomentOrder !== undefined) {
          pageConditions.push("m.moment_order < ?");
          pageParams.push(beforeMomentOrder);
        }
        // limit + 1 answers "is there an older page" without a second count.
        const rows = txDb
          .prepare(
            `SELECT m.moment_id, m.workspace_id, m.version_id, m.object_id, m.path,
                    m.recorded_at_ms, m.operation, m.metadata_origin,
                    m.metadata_summary, m.metadata_correlation_id, m.author_json,
                    m.moment_order
             FROM moments m
             WHERE ${pageConditions.join(" AND ")}
             ORDER BY m.moment_order DESC
             LIMIT ?`,
          )
          .all(...pageParams, limit + 1);
        const hasMore = rows.length > limit;
        const pageRows = hasMore ? rows.slice(0, limit) : rows;
        const moments = pageRows.map<VersionedTextMomentSummary>((row) => {
          const author = momentAuthorFromRow(row);
          return {
            id: rowString(row, "moment_id"),
            workspaceId: rowString(row, "workspace_id"),
            versionId: rowString(row, "version_id"),
            objectId: rowString(row, "object_id"),
            path: rowString(row, "path"),
            recordedAtMs: rowNumber(row, "recorded_at_ms"),
            operation: rowString(row, "operation") as VersionedTextMomentSummary["operation"],
            metadata: metadataFromRow(row),
            ...(author !== undefined ? { author } : {}),
            momentOrder: rowNumber(row, "moment_order"),
          };
        });
        return cloneJson({
          moments,
          nextBeforeMomentOrder: hasMore
            ? (moments[moments.length - 1]?.momentOrder ?? null)
            : null,
          latestMomentOrder,
        });
      });
    },

    getMoment(input) {
      return afterWrites(async () => {
        assertInputEnvelope(input);
        const workspaceId = normalizeWorkspaceId(input.workspaceId);
        if (typeof input.momentId !== "string" || input.momentId.trim().length === 0) {
          throw new VersionedTextStoreError("invalid-input", "Moment id is required.");
        }
        const row = db()
          .prepare(momentSelectSql("WHERE m.workspace_id = ? AND m.moment_id = ?"))
          .get(workspaceId, input.momentId.trim());
        return row ? cloneMoment(momentFromRow(row)) : null;
      });
    },

    writeTextFile(input) {
      return serialize(async () => {
        assertInputEnvelope(input);
        const workspaceId = normalizeWorkspaceId(input.workspaceId);
        const versionId = normalizeVersionId(input.versionId);
        const path = normalizePlaintextStorablePath(input.path);
        const text = normalizeWriteText(input.text);
        const metadata = normalizeWriteMetadata(input.metadata);
        const author = normalizeMomentAuthor(input.author);
        await beforeWriteMutation();
        const result = writeTextFileInDb({
          db: db(),
          workspaceId,
          versionId,
          path,
          text,
          metadata,
          ...(author !== undefined ? { author } : {}),
          momentId: input.momentId,
        });
        await persistBarrier();
        return result;
      });
    },

    readTextFile(input) {
      return afterWrites(async () => {
        assertInputEnvelope(input);
        const workspaceId = normalizeWorkspaceId(input.workspaceId);
        const versionId = normalizeVersionId(input.versionId);
        const path = normalizeWritePath(input.path);
        requireWorkspaceVersionRow(db(), workspaceId, versionId);
        const snapshot = selectSnapshotByPath(db(), workspaceId, versionId, path);
        return snapshot ? cloneSnapshot(snapshot) : null;
      });
    },

    compareTextFileVersions(input) {
      return afterWrites(async () => {
        assertInputEnvelope(input);
        const workspaceId = normalizeWorkspaceId(input.workspaceId);
        const targetVersionId = normalizeVersionId(input.targetVersionId);
        const sourceVersionId = normalizeVersionId(input.sourceVersionId);
        const path = normalizeWritePath(input.path);
        const txDb = db();
        requireWorkspaceVersionRow(txDb, workspaceId, targetVersionId);
        const sourceVersion = requireWorkspaceVersionRow(txDb, workspaceId, sourceVersionId);
        return cloneJson(
          compareTextFileVersionsInDb({
            db: txDb,
            workspaceId,
            targetVersionId,
            sourceVersion,
            path,
          }),
        );
      });
    },

    mergeTextFileFromVersion(input) {
      return serialize(async () => {
        assertInputEnvelope(input);
        const workspaceId = normalizeWorkspaceId(input.workspaceId);
        const targetVersionId = normalizeVersionId(input.targetVersionId);
        const sourceVersionId = normalizeVersionId(input.sourceVersionId);
        const path = normalizeWritePath(input.path);
        const metadata = normalizeWriteMetadata(input.metadata);
        await beforeWriteMutation();
        const txDb = db();
        requireWorkspaceVersionRow(txDb, workspaceId, targetVersionId);
        const sourceVersion = requireWorkspaceVersionRow(txDb, workspaceId, sourceVersionId);
        const comparison = compareTextFileVersionsInDb({
          db: txDb,
          workspaceId,
          targetVersionId,
          sourceVersion,
          path,
        });

        if (fileStatesEqual(comparison.current, comparison.incoming)) {
          return cloneJson({ kind: "unchanged", reason: "already-same", comparison });
        }
        if (fileStatesEqual(comparison.incoming, comparison.base)) {
          return cloneJson({ kind: "unchanged", reason: "source-unchanged", comparison });
        }

        if (fileStatesEqual(comparison.current, comparison.base)) {
          if (comparison.incoming.exists) {
            const write = writeTextFileInDb({
              db: txDb,
              workspaceId,
              versionId: targetVersionId,
              path,
              text: comparison.incoming.text ?? "",
              metadata,
            });
            await persistBarrier();
            return cloneJson({ kind: "merged", operation: "write", comparison, write });
          }
          const deletion = deleteTextFileInDb({
            db: txDb,
            workspaceId,
            versionId: targetVersionId,
            path,
            metadata,
          });
          await persistBarrier();
          return cloneJson({
            kind: "merged",
            operation: "delete",
            comparison,
            delete: deletion,
          });
        }

        if (
          comparison.base.exists &&
          comparison.current.exists &&
          comparison.incoming.exists
        ) {
          const merged = mergeMarkdown({
            base: comparison.base.text ?? "",
            local: comparison.current.text ?? "",
            remote: comparison.incoming.text ?? "",
          });
          if (merged.kind === "merged") {
            const write = writeTextFileInDb({
              db: txDb,
              workspaceId,
              versionId: targetVersionId,
              path,
              text: merged.content,
              metadata,
            });
            await persistBarrier();
            return cloneJson({ kind: "merged", operation: "write", comparison, write });
          }
        }

        const conflict = recordTextConflictInDb({
          db: txDb,
          comparison,
          metadata,
        });
        await persistBarrier();
        return cloneJson({ kind: "conflict", comparison, conflict });
      });
    },

    listTextConflicts(input) {
      return afterWrites(async () => {
        assertInputEnvelope(input);
        const workspaceId = normalizeWorkspaceId(input.workspaceId);
        if (
          input.status !== undefined &&
          input.status !== "open" &&
          input.status !== "resolved"
        ) {
          throw new VersionedTextStoreError("invalid-input", "Conflict status is invalid.");
        }
        const where =
          input.status === undefined
            ? "WHERE c.workspace_id = ? ORDER BY c.created_at_ms, c.conflict_id"
            : "WHERE c.workspace_id = ? AND c.status = ? ORDER BY c.created_at_ms, c.conflict_id";
        const params = input.status === undefined ? [workspaceId] : [workspaceId, input.status];
        return db()
          .prepare(conflictSelectSql(where))
          .all(...params)
          .map(conflictFromRow)
          .map(cloneJson);
      });
    },

    resolveTextConflict(input) {
      return serialize(async () => {
        assertInputEnvelope(input);
        const workspaceId = normalizeWorkspaceId(input.workspaceId);
        const conflictId = normalizeGeneratedId("conflict", input.conflictId);
        const metadata = normalizeWriteMetadata(input.metadata);
        const mergedText =
          input.resolution.kind === "apply-merged"
            ? normalizeWriteText(input.resolution.text)
            : undefined;
        await beforeWriteMutation();
        const txDb = db();
        const conflictRow = txDb
          .prepare(conflictSelectSql("WHERE c.workspace_id = ? AND c.conflict_id = ?"))
          .get(workspaceId, conflictId);
        const conflict = conflictRow ? conflictFromRow(conflictRow) : undefined;
        if (!conflict) {
          throw new VersionedTextStoreError(
            "conflict-not-found",
            `Conflict ${conflictId} was not found in workspace ${workspaceId}.`,
          );
        }
        const current = fileStateFromSnapshot(
          conflict.path,
          selectSnapshotByPath(txDb, workspaceId, conflict.targetVersionId, conflict.path),
        );
        if (!fileStatesEqual(current, conflict.current)) {
          throw new VersionedTextStoreError(
            "conflict-stale-target",
            `Conflict ${conflict.id} no longer matches ${conflict.path}.`,
          );
        }

        let write: VersionedTextWriteResult | undefined;
        let deletion: VersionedTextDeleteResult | undefined;
        let resolution: VersionedTextConflictResolution = "kept-current";
        if (input.resolution.kind === "apply-incoming") {
          resolution = "applied-incoming";
          conflict.chosenFrom = "incoming";
          if (conflict.incoming.exists) {
            write = writeTextFileInDb({
              db: txDb,
              workspaceId,
              versionId: conflict.targetVersionId,
              path: conflict.path,
              text: conflict.incoming.text ?? "",
              metadata,
            });
          } else if (conflict.current.exists) {
            deletion = deleteTextFileInDb({
              db: txDb,
              workspaceId,
              versionId: conflict.targetVersionId,
              path: conflict.path,
              metadata,
            });
          }
        } else if (input.resolution.kind === "apply-merged") {
          resolution = "applied-merged";
          conflict.chosenFrom = "merged";
          write = writeTextFileInDb({
            db: txDb,
            workspaceId,
            versionId: conflict.targetVersionId,
            path: conflict.path,
            text: mergedText ?? "",
            metadata,
          });
        }

        conflict.status = "resolved";
        conflict.resolution = resolution;
        conflict.updatedAtMs = readNowMs();
        txDb
          .prepare(
            `UPDATE conflicts
             SET status = ?, chosen_from = ?, resolution = ?, updated_at_ms = ?
             WHERE workspace_id = ? AND conflict_id = ?`,
          )
          .run(
            conflict.status,
            conflict.chosenFrom,
            conflict.resolution,
            conflict.updatedAtMs,
            workspaceId,
            conflict.id,
          );
        await persistBarrier();
        return cloneJson({ kind: "resolved", conflict, write, delete: deletion });
      });
    },

    listTextFiles(input) {
      return afterWrites(async () => {
        assertInputEnvelope(input);
        const workspaceId = normalizeWorkspaceId(input.workspaceId);
        const versionId = normalizeVersionId(input.versionId);
        requireWorkspaceVersionRow(db(), workspaceId, versionId);
        return db()
          .prepare(
            `SELECT s.*, b.text
             FROM snapshots s
             JOIN blobs b ON b.sha256 = s.blob_sha256
             WHERE s.workspace_id = ? AND s.version_id = ?
             ORDER BY s.path`,
          )
          .all(workspaceId, versionId)
          .map(snapshotFromRow)
          .map(cloneSnapshot);
      });
    },

    renameTextFile(input) {
      return serialize(async () => {
        assertInputEnvelope(input);
        const workspaceId = normalizeWorkspaceId(input.workspaceId);
        const versionId = normalizeVersionId(input.versionId);
        const fromPath = normalizeWritePath(input.fromPath);
        // A rename can introduce a NEW path, so the destination gets the same
        // secret-floor gate as writeTextFile (renaming notes.md -> .env must
        // not smuggle plaintext under a secret path).
        const toPath = normalizePlaintextStorablePath(input.toPath);
        if (fromPath === toPath) {
          throw new VersionedTextStoreError(
            "invalid-path",
            "Rename source and destination must differ.",
          );
        }
        const metadata = normalizeWriteMetadata(input.metadata);
        await beforeWriteMutation();
        const txDb = db();
        requireWorkspaceVersionRow(txDb, workspaceId, versionId);
        const before = selectSnapshotByPath(txDb, workspaceId, versionId, fromPath);
        if (!before) {
          throw new VersionedTextStoreError("file-not-found", `File ${fromPath} was not found.`);
        }

        const target = selectSnapshotByPath(txDb, workspaceId, versionId, toPath);
        if (target && target.objectId !== before.objectId) {
          throw new VersionedTextStoreError(
            "target-path-exists",
            `File ${toPath} already exists.`,
          );
        }

        const recordedAtMs = readNowMs();
        const momentId = createGeneratedId("moment");
        if (txDb.prepare("SELECT 1 FROM moments WHERE workspace_id = ? AND moment_id = ?").get(workspaceId, momentId)) {
          rejectDuplicateId("moment", momentId);
        }
        const moment = createMoment({
          id: momentId,
          workspaceId,
          versionId,
          objectId: before.objectId,
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
        const object = requireFileObjectRow(txDb, workspaceId, before.objectId);
        insertMomentRow(txDb, moment);
        txDb
          .prepare(
            "DELETE FROM path_aliases WHERE workspace_id = ? AND version_id = ? AND path = ? AND object_id = ?",
          )
          .run(workspaceId, versionId, fromPath, before.objectId);
        txDb
          .prepare(
            `INSERT INTO path_aliases (workspace_id, version_id, path, object_id)
             VALUES (?, ?, ?, ?)
             ON CONFLICT(workspace_id, version_id, path) DO UPDATE SET object_id = excluded.object_id`,
          )
          .run(workspaceId, versionId, toPath, before.objectId);
        insertOrReplaceSnapshot(txDb, "snapshots", workspaceId, versionId, after);
        deleteFileSearchIndex({
          db: txDb,
          workspaceId,
          versionId,
          objectId: before.objectId,
        });
        upsertFileSearchIndex({
          db: txDb,
          rootDir,
          workspaceId,
          snapshot: after,
        });
        await persistBarrier();
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
        const author = normalizeMomentAuthor(input.author);
        await beforeWriteMutation();
        const result = deleteTextFileInDb({
          db: db(),
          workspaceId,
          versionId,
          path,
          metadata,
          ...(author !== undefined ? { author } : {}),
          momentId: input.momentId,
        });
        await persistBarrier();
        return result;
      });
    },

    rollbackTextFileMutation(input) {
      return serialize(async () => {
        assertInputEnvelope(input);
        const workspaceId = normalizeWorkspaceId(input.workspaceId);
        const versionId = normalizeVersionId(input.versionId);
        const path = normalizeWritePath(input.path);
        const mutationMomentId = normalizeGeneratedId("moment", input.mutationMomentId);
        await beforeWriteMutation();
        const txDb = db();
        requireWorkspaceVersionRow(txDb, workspaceId, versionId);
        const momentRow = txDb
          .prepare(
            momentSelectSql(
              `WHERE m.workspace_id = ? AND m.moment_id = ? AND m.version_id = ? AND m.path = ?`,
            ),
          )
          .get(workspaceId, mutationMomentId, versionId, path);
        if (!momentRow) {
          throw new VersionedTextStoreError(
            "file-not-found",
            `Mutation moment ${mutationMomentId} was not found for ${path}.`,
          );
        }
        const moment = momentFromRow(momentRow);
        const momentOrder = rowNumber(momentRow, "moment_order");
        const before =
          moment.before === undefined
            ? (() => {
                const previous =
                  selectMomentByOrder(
                    txDb,
                    workspaceId,
                    versionId,
                    moment.objectId,
                    momentOrder - 1,
                  ) ??
                  inheritedObjectMomentFromDb(
                    txDb,
                    workspaceId,
                    versionId,
                    moment.objectId,
                  );
                if (input.legacyBeforeText !== undefined) {
                  const legacyBeforeText = normalizeWriteText(input.legacyBeforeText);
                  if (!previous || previous.moment.operation === "delete") {
                    throw new VersionedTextStoreError(
                      "invalid-input",
                      `Legacy mutation moment ${moment.id} has no earlier snapshot to restore.`,
                    );
                  }
                  const rollbackPath =
                    moment.operation === "rename" ? previous.moment.path : path;
                  return {
                    objectId: moment.objectId,
                    versionId,
                    path: rollbackPath,
                    text: legacyBeforeText,
                    updatedAtMs: previous.moment.recordedAtMs,
                    latestMomentId: previous.moment.id,
                    metadata: pickWriteMetadata(previous.moment.metadata),
                  };
                }
                if (moment.operation === "write" && !previous) return null;
                throw new VersionedTextStoreError(
                  "invalid-input",
                  `Legacy mutation moment ${moment.id} is missing a rollback preimage.`,
                );
              })()
            : moment.before;
        if (before && before.versionId !== versionId) {
          invalidRollbackSnapshot();
        }
        if (
          txDb
            .prepare(
              `SELECT 1 FROM moments
               WHERE workspace_id = ? AND version_id = ? AND object_id = ? AND moment_order > ?
               LIMIT 1`,
            )
            .get(workspaceId, versionId, moment.objectId, momentOrder)
        ) {
          throw new VersionedTextStoreError(
            "invalid-input",
            `Mutation moment ${mutationMomentId} is not the latest mutation for ${path}.`,
          );
        }
        if (
          rollbackMomentHasDependentsInDb({
            db: txDb,
            workspaceId,
            versionId,
            momentId: mutationMomentId,
            momentOrder,
            objectId: moment.objectId,
          })
        ) {
          throw new VersionedTextStoreError(
            "invalid-input",
            `Mutation moment ${mutationMomentId} has dependent versions and cannot be rolled back.`,
          );
        }
        if (before && before.path !== path && moment.operation !== "rename") {
          invalidRollbackSnapshot();
        }

        if (before) {
          if (before.objectId !== moment.objectId) {
            invalidRollbackSnapshot();
          }
          const restorePathObject = txDb
            .prepare(
              "SELECT object_id FROM path_aliases WHERE workspace_id = ? AND version_id = ? AND path = ?",
            )
            .get(workspaceId, versionId, before.path);
          const restorePathObjectId = restorePathObject
            ? rowString(restorePathObject, "object_id")
            : undefined;
          if (restorePathObjectId !== undefined && restorePathObjectId !== before.objectId) {
            throw new VersionedTextStoreError(
              "target-path-exists",
              `File ${before.path} already exists.`,
            );
          }
        }
        await persistBarrier();
        txDb
          .prepare("DELETE FROM moments WHERE workspace_id = ? AND moment_id = ?")
          .run(workspaceId, mutationMomentId);
        txDb
          .prepare(
            "DELETE FROM path_aliases WHERE workspace_id = ? AND version_id = ? AND path = ? AND object_id = ?",
          )
          .run(workspaceId, versionId, path, moment.objectId);
        txDb
          .prepare("DELETE FROM snapshots WHERE workspace_id = ? AND version_id = ? AND object_id = ?")
          .run(workspaceId, versionId, moment.objectId);
        // Keep the search index in the same transaction as the rollback:
        // without this, rolled-back text stays searchable (and a rolled-back
        // delete leaves restored text unfindable) because
        // engine_search_index_state marks the version populated.
        deleteFileSearchIndex({
          db: txDb,
          workspaceId,
          versionId,
          objectId: moment.objectId,
        });

        if (before) {
          txDb
            .prepare(
              `INSERT INTO path_aliases (workspace_id, version_id, path, object_id)
               VALUES (?, ?, ?, ?)
               ON CONFLICT(workspace_id, version_id, path) DO UPDATE SET object_id = excluded.object_id`,
            )
            .run(workspaceId, versionId, before.path, before.objectId);
          insertOrReplaceSnapshot(txDb, "snapshots", workspaceId, versionId, before);
          upsertFileSearchIndex({
            db: txDb,
            rootDir,
            workspaceId,
            snapshot: before,
          });
        }

        const remainingReferences = txDb
          .prepare(
            `SELECT 1
             WHERE EXISTS (SELECT 1 FROM path_aliases WHERE workspace_id = ? AND object_id = ?)
                OR EXISTS (SELECT 1 FROM snapshots WHERE workspace_id = ? AND object_id = ?)
                OR EXISTS (SELECT 1 FROM fork_base_snapshots WHERE workspace_id = ? AND object_id = ?)
                OR EXISTS (SELECT 1 FROM moments WHERE workspace_id = ? AND object_id = ?)
             LIMIT 1`,
          )
          .get(
            workspaceId,
            moment.objectId,
            workspaceId,
            moment.objectId,
            workspaceId,
            moment.objectId,
            workspaceId,
            moment.objectId,
          );
        if (!remainingReferences) {
          txDb
            .prepare("DELETE FROM file_objects WHERE workspace_id = ? AND object_id = ?")
            .run(workspaceId, moment.objectId);
        }
      });
    },

    getObject(input) {
      return afterWrites(async () => {
        assertInputEnvelope(input);
        const workspaceId = normalizeWorkspaceId(input.workspaceId);
        const objectId = normalizeObjectId(input.objectId);
        const objectRow = db()
          .prepare("SELECT * FROM file_objects WHERE workspace_id = ? AND object_id = ?")
          .get(workspaceId, objectId);
        if (
          !objectRow &&
          db()
            .prepare("SELECT workspace_id FROM file_objects WHERE object_id = ? AND workspace_id <> ?")
            .get(objectId, workspaceId)
        ) {
          throw new VersionedTextStoreError(
            "workspace-mismatch",
            `Object ${objectId} does not belong to workspace ${workspaceId}.`,
          );
        }
        return objectRow ? cloneFileObject(objectFromRow(objectRow)) : null;
      });
    },

    // Releases the SQLite handle (and its WAL locks) after in-flight writes
    // drain. The store stays usable: a later call lazily reopens, so close is
    // safe to call from workspace teardown without poisoning late readers.
    async close() {
      await (storeWriteChains.get(stateFilePath) ?? Promise.resolve());
      if (dbHandle) {
        try {
          dbHandle.close();
        } catch {}
        dbHandle = null;
        validated = false;
      }
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
