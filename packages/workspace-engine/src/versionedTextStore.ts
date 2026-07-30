import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { basename, dirname, join, resolve } from "node:path";
import {
  MAX_VERSIONED_BINARY_FILE_BYTES,
  VERSIONED_TEXT_STORE_RELATIVE_PATH,
  VersionedTextStoreError,
} from "@dohc/workspace-contracts/engine";
import type {
  ActorNeutralWriteMetadata,
  ActorNeutralWriteOrigin,
  AgentMomentAuthor,
  FileObjectRecord,
  MomentAuthor,
  SyncApplyResult,
  SyncReplicationEnvelope,
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
  VersionedFileContentKind,
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
import type { PendingConflictResolve } from "@dohc/workspace-contracts/relay";
import { validateUserWritePath } from "@dohc/workspace-core";
import { mergeMarkdown } from "@dohc/workspace-core/mergeMarkdown";
import * as Y from "yjs";
import { yDocToMarkdown } from "@dohc/ydoc-projection";
import type { YDocUpdatePayload } from "@dohc/workspace-contracts/engine";
import {
  ENGINE_SQLITE_BUSY_TIMEOUT_MS,
  assertEngineSqliteIntegrity,
  initializeOrValidateEngineSchema,
  trackEngineDbHandleForTest,
  type EngineIntegrityCheckMode,
} from "./engineDbSchema";
import { classifyEngineFilePath } from "./enginePathFloor";
import { REMOTE_YDOC_APPLY_ORIGIN, getLiveYDoc, liveYDocKey } from "./liveYDocRegistry";
import {
  deleteFileSearchIndex,
  ensureSearchIndexForVersion,
  querySearchIndex,
  upsertFileSearchIndex,
} from "./searchIndex";
import {
  ackReplicationPeer,
  appliedApplyResult,
  journalLocalReplicationOp,
  journalReplicationOp,
  readReplicationAckedSeq,
  skippedApplyResult,
  type ConflictResolvePayload,
  type MomentAppendPayload,
  type VersionCreateForkSnapshot,
  type VersionCreatePayload,
} from "./syncReplication";

export {
  MAX_VERSIONED_BINARY_FILE_BYTES,
  VERSIONED_TEXT_STORE_RELATIVE_PATH,
  VersionedTextStoreError,
} from "@dohc/workspace-contracts/engine";
export const MAX_VERSIONED_TEXT_FILE_BYTES = 10 * 1024 * 1024;
const MAX_WRITE_METADATA_FIELD_BYTES = 16 * 1024;

export type {
  ActorNeutralWriteMetadata,
  ActorNeutralWriteOrigin,
  AgentMomentAuthor,
  FileObjectRecord,
  MomentAuthor,
  SyncApplyResult,
  SyncReplicationEnvelope,
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
  VersionedFileContentKind,
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
    ...(isBinarySnapshot(snapshot) ? { contentKind: "binary" as const } : {}),
    ...(isBinarySnapshot(snapshot) && snapshot.sha256 !== undefined
      ? { sha256: snapshot.sha256 }
      : {}),
    ...(isBinarySnapshot(snapshot) && snapshot.byteLength !== undefined
      ? { byteLength: snapshot.byteLength }
      : {}),
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
  const clonePayloadSnapshot = (
    snapshot: VersionedTextMomentPayloadSnapshot,
  ): VersionedTextMomentPayloadSnapshot => ({
    path: snapshot.path,
    ...(snapshot.contentKind === "binary" ? { contentKind: "binary" as const } : {}),
    ...(snapshot.contentKind === "binary" && snapshot.sha256 !== undefined
      ? { sha256: snapshot.sha256 }
      : {}),
    ...(snapshot.contentKind === "binary" && snapshot.byteLength !== undefined
      ? { byteLength: snapshot.byteLength }
      : {}),
    text: snapshot.text,
  });
  return {
    before: payload.before ? clonePayloadSnapshot(payload.before) : null,
    after: clonePayloadSnapshot(payload.after),
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

// Canonical FILESYSTEM identity of a rootDir's engine.db. Used to KEY the
// process-global write-chain map (storeWriteChains) and the Y.Doc driver's
// live-reservation set, so two rootDirs that resolve to the SAME physical
// engine.db — via a symlink, a case-insensitive alias, or a bind mount — share
// ONE write lane / reservation instead of racing two writers or two live Y.Docs
// on one file.
//
// resolve() alone is only a LEXICAL normalization: root /a and a symlinked
// /b -> /a produce different strings, so keying by it hands each a private lane
// and defeats the single-write-lane + single-canonical guarantees. realpath
// resolves the actual on-disk path. It requires the target to EXIST, and the
// key is computed before the DB is created, so we canonicalize the deepest
// existing ancestor and rejoin the not-yet-created trailing components. The
// engine.db lives at a FIXED relative path created only as plain dirs/file (the
// trailing components are never themselves symlinks), so the value is stable
// across the DB's later creation: once the DB file exists the walk stops at it
// and realpaths the whole path; while it does not, the walk stops at rootDir
// (always present) and resolves the same root symlink — both yield the same key.
export function canonicalEngineDbPath(rootDir: string): string {
  const dbPath = storePath(resolve(normalizeRootDir(rootDir)));
  let existing = dbPath;
  const trailing: string[] = [];
  while (!existsSync(existing)) {
    const parent = dirname(existing);
    // Reached the filesystem root with nothing existing (should never happen —
    // rootDir exists) — fall back to the lexical path rather than loop forever.
    if (parent === existing) return dbPath;
    trailing.unshift(basename(existing));
    existing = parent;
  }
  const canonical = realpathSync.native(existing);
  return trailing.length === 0 ? canonical : join(canonical, ...trailing);
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
  readonly isOpen?: boolean;
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
    db = trackEngineDbHandleForTest(new DatabaseSync(path));
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

function normalizeHydratedState(
  raw: unknown,
  recordOnlyMomentIds = new Set<VersionedTextMomentId>(),
  syncMaterializedVersionIds = new Set<VersionId>(),
): PersistedVersionedTextState {
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
    assertHydratedWorkspaceState(
      workspaceId,
      workspace,
      recordOnlyMomentIds,
      syncMaterializedVersionIds,
    );
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

function assertHydratedWorkspaceState(
  workspaceId: string,
  value: unknown,
  recordOnlyMomentIds = new Set<VersionedTextMomentId>(),
  syncMaterializedVersionIds = new Set<VersionId>(),
): void {
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
      if (
        persistedIndex !== undefined &&
        persistedIndex <= maxIndex &&
        !recordOnlyMomentIds.has(moment.id)
      ) {
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
    if (recordOnlyMomentIds.has(moment.id)) continue;
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

      // A sync-materialized fork's SEEDED rows come from the origin's shipped
      // fork-point state: their heads are real recorded moments (verified
      // above) but may be record-only here — local fork-point lineage
      // inference is not their source of truth. Writes made IN the fork after
      // materialization take the same-version branch above and stay strict.
      if (syncMaterializedVersionIds.has(versionId)) continue;
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
      const ownMoment = latestMomentForObject(versionId, objectId);
      const expectedMoment = ownMoment ?? inheritedLatestMomentForObject(versionId, objectId);
      if (!expectedMoment) continue;
      // Same exemption as above: expectations that cross a sync-materialized
      // fork's boundary derive from LOCAL lineage the origin never saw.
      if (!ownMoment && syncMaterializedVersionIds.has(versionId)) continue;
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

function sha256Bytes(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

// ---- WS-G2-C1: ydoc.update apply (the commutative CRDT core) ----------------
//
// Applying a `ydoc.update` op is FUNDAMENTALLY different from `moment.append`:
// there is NO before-head check, NO divergence detection, and NO P0D conflict
// row. `Y.applyUpdate` is commutative (arrival order is irrelevant to the
// converged state) and idempotent (a re-applied update is a no-op via Yjs
// state vectors), so convergence is guaranteed by Yjs semantics, not by the
// log. The op-log's per-origin `acked_seq` dedup (in applyReplicationOp, before
// the switch) is the only ordering machinery: a re-imported op is skipped there
// so no duplicate ydoc_updates row is ever appended, with CRDT idempotence as
// the backstop. Each peer keeps its OWN local `seq` numbering (the origin's seq
// lives in the replication log, not here), so two peers that apply the same set
// of updates in different orders still reconstruct byte-identical Y.Doc state
// and project byte-identical markdown.
const YDOC_PEER_COMPACTION_THRESHOLD = 128;

function readYDocUpdateBlobBytes(db: SqliteDb, sha256: string): Uint8Array {
  const row = db
    .prepare("SELECT content, byte_length FROM binary_blobs WHERE sha256 = ?")
    .get(sha256);
  const content = row?.content;
  if (!(content instanceof Uint8Array) && !Buffer.isBuffer(content)) throw corruptStore();
  const bytes = new Uint8Array(content as Uint8Array);
  // Verify the digest (matches the driver's read posture): reconstructing CRDT
  // state from unverified bytes would silently diverge the doc.
  if (bytes.byteLength !== Number(row?.byte_length)) throw corruptStore();
  if (sha256Bytes(bytes) !== sha256) throw corruptStore();
  return bytes;
}

function putYDocUpdateBlobBytes(db: SqliteDb, bytes: Uint8Array): string {
  const content = Buffer.from(bytes);
  const sha256 = sha256Bytes(content);
  db.prepare(
    "INSERT OR IGNORE INTO binary_blobs (sha256, byte_length, content) VALUES (?, ?, ?)",
  ).run(sha256, content.byteLength, content);
  return sha256;
}

// Rebuild the persisted Y.Doc from the latest snapshot + trailing update log,
// exactly as the driver's loadPersistedDoc does (Hocuspocus's load+replay
// shape), but on the apply transaction's connection.
function reconstructEngineYDoc(
  db: SqliteDb,
  workspaceId: WorkspaceId,
  versionId: VersionId,
  objectId: WorkspaceObjectId,
): Y.Doc {
  const doc = new Y.Doc();
  const snapshotRow = db
    .prepare(
      `SELECT up_to_seq, snapshot_blob_sha256
         FROM ydoc_snapshots
        WHERE workspace_id = ? AND version_id = ? AND object_id = ?
        ORDER BY up_to_seq DESC
        LIMIT 1`,
    )
    .get(workspaceId, versionId, objectId);
  let fromSeq = 0;
  if (snapshotRow) {
    Y.applyUpdate(doc, readYDocUpdateBlobBytes(db, String(snapshotRow.snapshot_blob_sha256)));
    fromSeq = Number(snapshotRow.up_to_seq);
  }
  const updates = db
    .prepare(
      `SELECT update_blob_sha256
         FROM ydoc_updates
        WHERE workspace_id = ? AND version_id = ? AND object_id = ? AND seq > ?
        ORDER BY seq ASC`,
    )
    .all(workspaceId, versionId, objectId, fromSeq);
  for (const u of updates) {
    Y.applyUpdate(doc, readYDocUpdateBlobBytes(db, String(u.update_blob_sha256)));
  }
  return doc;
}

// Bound peer-side replay: past a threshold of accumulated updates, fold the log
// into a fresh full-state snapshot and prune the folded rows (the compaction
// the legacy Hocuspocus stack skipped, design Risk 3). The snapshot blob is
// LOCAL compaction state (never pushed), still a GC root while referenced.
function maybeCompactPeerEngineYDoc(
  db: SqliteDb,
  workspaceId: WorkspaceId,
  versionId: VersionId,
  objectId: WorkspaceObjectId,
  headSeq: number,
  doc: Y.Doc,
  nowMs: number,
): void {
  const marker = db
    .prepare(
      `SELECT head_snapshot_seq FROM ydoc_docs
        WHERE workspace_id = ? AND version_id = ? AND object_id = ?`,
    )
    .get(workspaceId, versionId, objectId);
  const headSnapshotSeq = Number(marker?.head_snapshot_seq ?? 0);
  if (headSeq - headSnapshotSeq < YDOC_PEER_COMPACTION_THRESHOLD) return;
  const snapshotSha = putYDocUpdateBlobBytes(db, Y.encodeStateAsUpdate(doc));
  const stateVectorSha = putYDocUpdateBlobBytes(db, Y.encodeStateVector(doc));
  db.prepare(
    `INSERT OR REPLACE INTO ydoc_snapshots
       (workspace_id, version_id, object_id, up_to_seq,
        snapshot_blob_sha256, state_vector_blob_sha256, recorded_at_ms)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(workspaceId, versionId, objectId, headSeq, snapshotSha, stateVectorSha, nowMs);
  db.prepare(
    `DELETE FROM ydoc_updates
      WHERE workspace_id = ? AND version_id = ? AND object_id = ? AND seq <= ?`,
  ).run(workspaceId, versionId, objectId, headSeq);
  db.prepare(
    `DELETE FROM ydoc_snapshots
      WHERE workspace_id = ? AND version_id = ? AND object_id = ? AND up_to_seq < ?`,
  ).run(workspaceId, versionId, objectId, headSeq);
  db.prepare(
    `UPDATE ydoc_docs SET head_snapshot_seq = ?, updated_at_ms = ?
      WHERE workspace_id = ? AND version_id = ? AND object_id = ?`,
  ).run(headSeq, nowMs, workspaceId, versionId, objectId);
}

// PHASE 1 of applying a remote ydoc.update: validate + reconstruct the CONVERGED
// Y.Doc in memory (existing persisted state + the new update) and project it to
// markdown. This does NOT write ydoc rows yet — the projection write must create
// the file_object FIRST (ydoc_docs carries a FK to file_objects), so the caller
// materializes the markdown, THEN persistYDocUpdate stores the CRDT rows.
function projectYDocUpdate(
  db: SqliteDb,
  workspaceId: WorkspaceId,
  payload: YDocUpdatePayload,
): { markdown: string; doc: Y.Doc; update: Uint8Array } {
  // SECRET FLOOR (never a plaintext leak path): a secret-classified path must
  // never be opened/materialized as a replicated Y.Doc. Reject the op outright.
  if (classifyEngineFilePath(payload.path).kind === "secret") {
    throw new VersionedTextStoreError(
      "invalid-input",
      `Refusing ydoc.update for secret-classified path ${payload.path}; secret files never replicate as plaintext Y.Docs.`,
    );
  }
  // The target version must exist locally (its workspace.init/version.create op
  // orders before this one). Same contract as applyRemoteMomentAppend.
  requireWorkspaceVersionRow(db, workspaceId, payload.versionId);
  // OBJECT/PATH INTEGRITY (fix 2 — never write through a path occupant): the
  // materialization below (writeTextFileInDb) uses the EXISTING snapshot at
  // payload.path as its object when one exists, IGNORING payload.objectId. A
  // malformed/hostile op for object A carrying object B's occupied path would
  // otherwise project A's CRDT into B's markdown file while recording ydoc rows
  // under A — a sync payload silently mutating the WRONG plaintext file. There
  // is no rename protocol for Y.Docs, so require the identity to be pinned both
  // ways before materializing: any snapshot at this path must already be this
  // object, and any snapshot for this object must already be at this path.
  const byPath = selectSnapshotByPath(db, workspaceId, payload.versionId, payload.path);
  if (byPath && byPath.objectId !== payload.objectId) {
    throw new VersionedTextStoreError(
      "invalid-input",
      `Refusing ydoc.update for object ${payload.objectId}: path ${payload.path} is already occupied by object ${byPath.objectId}.`,
    );
  }
  const byObject = selectSnapshotByObject(db, workspaceId, payload.versionId, payload.objectId);
  if (byObject && byObject.path !== payload.path) {
    throw new VersionedTextStoreError(
      "invalid-input",
      `Refusing ydoc.update for object ${payload.objectId}: it already occupies path ${byObject.path}, not ${payload.path}.`,
    );
  }
  // The update bytes were hydrated into binary_blobs before this transaction
  // (applySyncQueues / the caller's blob transport). Read + digest-verify them.
  const update = readYDocUpdateBlobBytes(db, payload.updateBlobSha256);
  // Reconstruct existing persisted state (empty for a from-scratch peer) and
  // apply the new update in memory — Y.applyUpdate is commutative + idempotent.
  const doc = reconstructEngineYDoc(db, workspaceId, payload.versionId, payload.objectId);
  Y.applyUpdate(doc, update);
  return { markdown: yDocToMarkdown(doc), doc, update };
}

// PHASE 2: persist the CRDT rows once the file_object exists (created by the
// projection write between phase 1 and here). Appends the update to the per-doc
// log, advances the local head, and bounds replay by compaction.
function persistYDocUpdate(
  db: SqliteDb,
  workspaceId: WorkspaceId,
  payload: YDocUpdatePayload,
  doc: Y.Doc,
  actorOriginId: string,
  nowMs: number,
): void {
  const versionId = payload.versionId;
  const objectId = payload.objectId;
  const contentKind = payload.contentKind === "plaintext" ? "plaintext" : "richdoc";
  // Ensure the driver marker (create it for a from-scratch peer that just had
  // its file_object materialized). Never clobber an existing marker's heads.
  db.prepare(
    `INSERT INTO ydoc_docs
       (workspace_id, version_id, object_id, content_kind,
        head_update_seq, head_snapshot_seq, updated_at_ms)
     VALUES (?, ?, ?, ?, 0, 0, ?)
     ON CONFLICT(workspace_id, version_id, object_id) DO NOTHING`,
  ).run(workspaceId, versionId, objectId, contentKind, nowMs);
  const headRow = db
    .prepare(
      `SELECT head_update_seq FROM ydoc_docs
        WHERE workspace_id = ? AND version_id = ? AND object_id = ?`,
    )
    .get(workspaceId, versionId, objectId);
  const seq = Number(headRow?.head_update_seq ?? 0) + 1;
  db.prepare(
    `INSERT INTO ydoc_updates
       (workspace_id, version_id, object_id, seq,
        update_blob_sha256, actor_origin_id, recorded_at_ms)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(workspaceId, versionId, objectId, seq, payload.updateBlobSha256, actorOriginId, nowMs);
  db.prepare(
    `UPDATE ydoc_docs SET head_update_seq = ?, updated_at_ms = ?
      WHERE workspace_id = ? AND version_id = ? AND object_id = ?`,
  ).run(seq, nowMs, workspaceId, versionId, objectId);
  maybeCompactPeerEngineYDoc(db, workspaceId, versionId, objectId, seq, doc, nowMs);
}

function snapshotContentKind(
  snapshot: Pick<TextFileSnapshot, "contentKind">,
): VersionedFileContentKind {
  return snapshot.contentKind ?? "text";
}

function fileStateContentKind(
  state: Pick<VersionedTextFileState, "contentKind">,
): VersionedFileContentKind {
  return state.contentKind ?? "text";
}

function isBinarySnapshot(snapshot: Pick<TextFileSnapshot, "contentKind">): boolean {
  return snapshotContentKind(snapshot) === "binary";
}

function isBinaryState(state: Pick<VersionedTextFileState, "contentKind">): boolean {
  return fileStateContentKind(state) === "binary";
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

function rowBuffer(row: Record<string, unknown>, key: string): Buffer {
  const value = row[key];
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof Uint8Array) return Buffer.from(value);
  throw corruptStore();
}

function readBinaryBlobFromDb(db: SqliteDb, sha256: string): Buffer {
  const row = db.prepare("SELECT content FROM binary_blobs WHERE sha256 = ?").get(sha256);
  if (!row) throw corruptStore();
  return rowBuffer(row, "content");
}

function rowContentKind(
  row: Record<string, unknown>,
  key: string,
): VersionedFileContentKind {
  const value = row[key];
  if (value === null || value === undefined) return "text";
  if (value === "text" || value === "binary") return value;
  throw corruptStore();
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
  db.prepare(
    `INSERT INTO blobs (sha256, byte_length, text) VALUES (?, ?, ?)
     ON CONFLICT(sha256) DO UPDATE SET
       byte_length = excluded.byte_length,
       text = excluded.text`,
  ).run(sha256, Buffer.byteLength(text, "utf8"), text);
  return sha256;
}

function putBinaryBlob(db: SqliteDb, bytes: Uint8Array): string {
  const content = Buffer.from(bytes);
  const sha256 = sha256Bytes(content);
  // Sync journaling happens at the moment level (writeBinaryFileInDb journals
  // a moment.append whose payload references this sha); bundle export ships
  // the bytes from binary_blobs under blobs-bin/.
  db.prepare("INSERT OR IGNORE INTO binary_blobs (sha256, byte_length, content) VALUES (?, ?, ?)").run(
    sha256,
    content.byteLength,
    content,
  );
  // Existing databases still have foreign keys from *_blob_sha256 to blobs.
  // This row is a compatibility anchor only; binary bytes remain solely in
  // binary_blobs and text reads are gated by content_kind.
  db.prepare("INSERT OR IGNORE INTO blobs (sha256, byte_length, text) VALUES (?, ?, '')").run(
    sha256,
    content.byteLength,
  );
  return sha256;
}

function selectBlobText(db: SqliteDb, sha256: string): string | null {
  const row = db.prepare("SELECT text FROM blobs WHERE sha256 = ?").get(sha256);
  return typeof row?.text === "string" ? row.text : null;
}

function requireBlobText(db: SqliteDb, sha256: string): string {
  const text = selectBlobText(db, sha256);
  if (text === null) throw corruptStore();
  // Content-addressed reads verify the address (0P-C gate fix). A row whose
  // text does not hash to its key is either a poisoned store or — the sync
  // kind-confusion case — a binary blob's compatibility ANCHOR (text = "")
  // being misread as text. Fail closed: adopting empty text under a
  // mismatched sha would silently corrupt replicated state.
  if (sha256Text(text) !== sha256) throw corruptStore();
  return text;
}

function requirePayloadString(value: string | undefined): string {
  if (value === undefined) throw corruptStore();
  return value;
}

function requirePayloadNumber(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) throw corruptStore();
  return value;
}

// Wire → local payload snapshot: text resolves through blobs, binary resolves
// through binary_blobs (bytes were hydrated from the bundle before any op is
// applied, so a missing hash here is a corrupt/incomplete bundle).
function payloadSnapshotFromWire(
  db: SqliteDb,
  input: {
    path: string;
    sha256: string;
    contentKind?: VersionedFileContentKind;
    byteLength?: number;
  },
): VersionedTextMomentPayloadSnapshot {
  if ((input.contentKind ?? "text") === "binary") {
    const bytes = readBinaryBlobFromDb(db, input.sha256);
    return {
      path: input.path,
      contentKind: "binary",
      sha256: input.sha256,
      byteLength: input.byteLength ?? bytes.byteLength,
      text: "",
    };
  }
  return { path: input.path, text: requireBlobText(db, input.sha256) };
}

// A binary payload side never re-hashes bytes here: writeBinaryFileInDb
// already content-addressed them into binary_blobs, so the journal payload
// carries that sha (bundle export ships the bytes under blobs-bin/).
function payloadSnapshotWireFields(
  db: SqliteDb,
  snapshot: VersionedTextMomentPayloadSnapshot,
): { sha256: string; contentKind?: VersionedFileContentKind; byteLength?: number } {
  if ((snapshot.contentKind ?? "text") === "binary") {
    if (!snapshot.sha256 || snapshot.byteLength === undefined) throw corruptStore();
    return { sha256: snapshot.sha256, contentKind: "binary", byteLength: snapshot.byteLength };
  }
  return { sha256: putBlob(db, snapshot.text) };
}

function momentAppendPayload(input: {
  db: SqliteDb;
  moment: VersionedTextMoment;
  objectCreatedAtMs?: number;
}): MomentAppendPayload {
  const before = input.moment.before;
  const payloadBefore = input.moment.payload.before
    ? payloadSnapshotWireFields(input.db, input.moment.payload.before)
    : null;
  const payloadAfter = payloadSnapshotWireFields(input.db, input.moment.payload.after);
  const beforeWire = before && before !== null ? payloadSnapshotWireFields(input.db, before) : null;
  return {
    momentId: input.moment.id,
    versionId: input.moment.versionId,
    objectId: input.moment.objectId,
    ...(input.objectCreatedAtMs !== undefined ? { objectCreatedAtMs: input.objectCreatedAtMs } : {}),
    path: input.moment.path,
    recordedAtMs: input.moment.recordedAtMs,
    operation: input.moment.operation,
    payloadBeforeBlobSha256: payloadBefore?.sha256 ?? null,
    payloadBeforePath: input.moment.payload.before?.path ?? null,
    payloadAfterBlobSha256: payloadAfter.sha256,
    payloadAfterPath: input.moment.payload.after.path,
    ...(payloadBefore?.contentKind === "binary"
      ? {
          payloadBeforeContentKind: "binary" as const,
          payloadBeforeByteLength: payloadBefore.byteLength,
        }
      : {}),
    ...(payloadAfter.contentKind === "binary"
      ? {
          payloadAfterContentKind: "binary" as const,
          payloadAfterByteLength: payloadAfter.byteLength,
        }
      : {}),
    metadata: pickWriteMetadata(input.moment.metadata),
    ...(input.moment.author !== undefined ? { author: pickMomentAuthor(input.moment.author) } : {}),
    beforePresent: before === undefined ? "absent" : before === null ? "null" : "present",
    ...(before && before !== null && beforeWire
      ? {
          beforeObjectId: before.objectId,
          beforeVersionId: before.versionId,
          beforePath: before.path,
          beforeBlobSha256: beforeWire.sha256,
          ...(beforeWire.contentKind === "binary"
            ? { beforeContentKind: "binary" as const, beforeByteLength: beforeWire.byteLength }
            : {}),
          beforeUpdatedAtMs: before.updatedAtMs,
          beforeLatestMomentId: before.latestMomentId,
          beforeMetadata: pickWriteMetadata(before.metadata),
        }
      : {}),
  };
}

function momentFromAppendPayload(
  db: SqliteDb,
  workspaceId: WorkspaceId,
  payload: MomentAppendPayload,
): VersionedTextMoment {
  const beforeSha = payload.beforeBlobSha256 ?? "";
  const beforeIsBinary = (payload.beforeContentKind ?? "text") === "binary";
  const before =
    payload.beforePresent === "present"
      ? {
          objectId: requirePayloadString(payload.beforeObjectId),
          versionId: requirePayloadString(payload.beforeVersionId),
          path: requirePayloadString(payload.beforePath),
          ...(beforeIsBinary
            ? {
                contentKind: "binary" as const,
                sha256: beforeSha,
                byteLength:
                  payload.beforeByteLength ?? readBinaryBlobFromDb(db, beforeSha).byteLength,
                text: "",
              }
            : { text: requireBlobText(db, beforeSha) }),
          updatedAtMs: requirePayloadNumber(payload.beforeUpdatedAtMs),
          latestMomentId: requirePayloadString(payload.beforeLatestMomentId),
          metadata: pickWriteMetadata(payload.beforeMetadata ?? { origin: "unknown" }),
        }
      : payload.beforePresent === "null"
        ? null
        : undefined;
  return {
    id: payload.momentId,
    workspaceId,
    versionId: payload.versionId,
    objectId: payload.objectId,
    path: payload.path,
    recordedAtMs: payload.recordedAtMs,
    operation: payload.operation,
    payload: {
      before:
        payload.payloadBeforeBlobSha256 && payload.payloadBeforePath
          ? payloadSnapshotFromWire(db, {
              path: payload.payloadBeforePath,
              sha256: payload.payloadBeforeBlobSha256,
              contentKind: payload.payloadBeforeContentKind,
              byteLength: payload.payloadBeforeByteLength,
            })
          : null,
      after: payloadSnapshotFromWire(db, {
        path: payload.payloadAfterPath,
        sha256: payload.payloadAfterBlobSha256,
        contentKind: payload.payloadAfterContentKind,
        byteLength: payload.payloadAfterByteLength,
      }),
    },
    metadata: pickWriteMetadata(payload.metadata),
    ...(payload.author !== undefined ? { author: pickMomentAuthor(payload.author) } : {}),
    ...(before === undefined ? {} : { before }),
  };
}

function fileStateFromAppendBefore(
  db: SqliteDb,
  payload: MomentAppendPayload,
): VersionedTextFileState {
  if (payload.beforePresent !== "present") {
    return { exists: false, path: payload.payloadBeforePath ?? payload.path };
  }
  const beforeSha = payload.beforeBlobSha256 ?? "";
  return {
    exists: true,
    path: payload.beforePath ?? payload.path,
    objectId: payload.beforeObjectId,
    ...((payload.beforeContentKind ?? "text") === "binary"
      ? {
          contentKind: "binary" as const,
          sha256: beforeSha,
          byteLength: payload.beforeByteLength ?? readBinaryBlobFromDb(db, beforeSha).byteLength,
          text: "",
        }
      : { text: requireBlobText(db, beforeSha) }),
    updatedAtMs: payload.beforeUpdatedAtMs,
    latestMomentId: payload.beforeLatestMomentId,
    metadata: pickWriteMetadata(payload.beforeMetadata ?? { origin: "unknown" }),
  };
}

function snapshotFromRow(row: Record<string, unknown>): TextFileSnapshot {
  const contentKind = rowContentKind(row, "content_kind");
  const byteLength = rowNumber(row, "byte_length");
  const sha256 = rowString(row, "blob_sha256");
  return {
    objectId: rowString(row, "object_id"),
    versionId: rowString(row, "version_id"),
    path: rowString(row, "path"),
    contentKind,
    sha256,
    byteLength,
    text: contentKind === "text" ? rowString(row, "text") : "",
    updatedAtMs: rowNumber(row, "updated_at_ms"),
    latestMomentId: rowString(row, "latest_moment_id"),
    metadata: metadataFromRow(row),
  };
}

function payloadSnapshotFromRow(
  row: Record<string, unknown>,
  prefix: "payload_before" | "payload_after",
): VersionedTextMomentPayloadSnapshot {
  const contentKind = rowContentKind(row, `${prefix}_content_kind`);
  const sha256 = rowString(row, `${prefix}_blob_sha256`);
  const byteLength = rowNumber(row, `${prefix}_byte_length`);
  return {
    path: rowString(row, `${prefix}_path`),
    contentKind,
    sha256,
    byteLength,
    text: contentKind === "text" ? rowString(row, `${prefix}_text`) : "",
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
            contentKind: rowContentKind(row, "before_content_kind"),
            sha256: rowString(row, "before_blob_sha256"),
            byteLength: rowNumber(row, "before_byte_length"),
            text: rowContentKind(row, "before_content_kind") === "text" ? rowString(row, "before_text") : "",
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
      before: payloadBeforePath ? payloadSnapshotFromRow(row, "payload_before") : null,
      after: payloadSnapshotFromRow(row, "payload_after"),
    },
    metadata: metadataFromRow(row),
    ...(author !== undefined ? { author } : {}),
    ...(beforePresent === 0 ? {} : { before }),
  };
}

function momentSelectSql(where: string): string {
  return `SELECT m.*,
                 before_payload.text AS payload_before_text,
                 before_binary.byte_length AS payload_before_binary_byte_length,
                 COALESCE(before_payload.byte_length, before_binary.byte_length) AS payload_before_byte_length,
                 after_payload.text AS payload_after_text,
                 after_binary.byte_length AS payload_after_binary_byte_length,
                 COALESCE(after_payload.byte_length, after_binary.byte_length) AS payload_after_byte_length,
                 before_blob.text AS before_text,
                 before_binary_blob.byte_length AS before_binary_byte_length,
                 COALESCE(before_blob.byte_length, before_binary_blob.byte_length) AS before_byte_length
          FROM moments m
          LEFT JOIN blobs before_payload
            ON before_payload.sha256 = m.payload_before_blob_sha256
           AND COALESCE(m.payload_before_content_kind, 'text') = 'text'
          LEFT JOIN binary_blobs before_binary
            ON before_binary.sha256 = m.payload_before_blob_sha256
           AND COALESCE(m.payload_before_content_kind, 'text') = 'binary'
          LEFT JOIN blobs after_payload
            ON after_payload.sha256 = m.payload_after_blob_sha256
           AND COALESCE(m.payload_after_content_kind, 'text') = 'text'
          LEFT JOIN binary_blobs after_binary
            ON after_binary.sha256 = m.payload_after_blob_sha256
           AND COALESCE(m.payload_after_content_kind, 'text') = 'binary'
          LEFT JOIN blobs before_blob
            ON before_blob.sha256 = m.before_blob_sha256
           AND COALESCE(m.before_content_kind, 'text') = 'text'
          LEFT JOIN binary_blobs before_binary_blob
            ON before_binary_blob.sha256 = m.before_blob_sha256
           AND COALESCE(m.before_content_kind, 'text') = 'binary'
          ${where}`;
}

function fileStateFromConflictRow(
  row: Record<string, unknown>,
  prefix: "base" | "current" | "incoming",
): VersionedTextFileState {
  const path = rowString(row, `${prefix}_path`);
  if (Number(row[`${prefix}_exists`]) !== 1) return { exists: false, path };
  const contentKind = rowContentKind(row, `${prefix}_content_kind`);
  return {
    exists: true,
    path,
    objectId: rowString(row, `${prefix}_object_id`),
    contentKind,
    sha256: rowString(row, `${prefix}_blob_sha256`),
    byteLength: rowNumber(row, `${prefix}_byte_length`),
    text: contentKind === "text" ? rowString(row, `${prefix}_text`) : "",
    updatedAtMs: rowNumber(row, `${prefix}_updated_at_ms`),
    latestMomentId: rowString(row, `${prefix}_latest_moment_id`),
    metadata: metadataFromRow(row, `${prefix}_metadata_`),
  };
}

function loadStateFromDatabase(db: SqliteDb): PersistedVersionedTextState {
  const state = initialState();
  const recordOnlyMomentIds = new Set<VersionedTextMomentId>();
  const syncMaterializedVersionIds = new Set<VersionId>();
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
      if (Number(row.sync_materialized ?? 0) === 1) {
        syncMaterializedVersionIds.add(version.id);
      }
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
        `SELECT s.*, b.text, COALESCE(b.byte_length, bb.byte_length) AS byte_length
         FROM snapshots s
         LEFT JOIN blobs b
           ON b.sha256 = s.blob_sha256
          AND COALESCE(s.content_kind, 'text') = 'text'
         LEFT JOIN binary_blobs bb
           ON bb.sha256 = s.blob_sha256
          AND COALESCE(s.content_kind, 'text') = 'binary'
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
        `SELECT s.*, b.text, COALESCE(b.byte_length, bb.byte_length) AS byte_length
         FROM fork_base_snapshots s
         LEFT JOIN blobs b
           ON b.sha256 = s.blob_sha256
          AND COALESCE(s.content_kind, 'text') = 'text'
         LEFT JOIN binary_blobs bb
           ON bb.sha256 = s.blob_sha256
          AND COALESCE(s.content_kind, 'text') = 'binary'
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
        momentSelectSql("ORDER BY m.workspace_id, m.moment_order"),
      )
      .all()) {
      const workspace = state.workspaces[rowString(row, "workspace_id")];
      if (!workspace) throw corruptStore();
      if (Number(row.sync_record_only ?? 0) === 1) {
        recordOnlyMomentIds.add(rowString(row, "moment_id"));
      }
      workspace.moments.push(momentFromRow(row));
    }

    for (const row of db
      .prepare(
        conflictSelectSql("ORDER BY c.workspace_id, c.created_at_ms, c.conflict_id"),
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

  return normalizeHydratedState(state, recordOnlyMomentIds, syncMaterializedVersionIds);
}

function insertConflictFileState(
  db: SqliteDb,
  state: VersionedTextFileState,
): [
  number,
  string,
  string | null,
  string | null,
  string | null,
  number | null,
  string | null,
  string | null,
  string | null,
  string | null,
] {
  if (!state.exists) {
    return [0, state.path, null, null, null, null, null, null, null, null];
  }
  const metadata = state.metadata ?? { origin: "unknown" as const };
  const contentKind = fileStateContentKind(state);
  if (contentKind === "binary" && !state.sha256) throw corruptStore();
  return [
    1,
    state.path,
    state.objectId ?? null,
    contentKind,
    contentKind === "binary" ? state.sha256 ?? "" : putBlob(db, state.text ?? ""),
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

function normalizeWriteBinaryBytes(bytes: Uint8Array): Buffer {
  if (!(bytes instanceof Uint8Array)) {
    throw new VersionedTextStoreError("invalid-input", "Binary file content is required.");
  }
  if (bytes.byteLength > MAX_VERSIONED_BINARY_FILE_BYTES) {
    throw new VersionedTextStoreError(
      "file-too-large",
      `Binary file content exceeds ${MAX_VERSIONED_BINARY_FILE_BYTES} bytes.`,
    );
  }
  return Buffer.from(bytes);
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
    contentKind: snapshotContentKind(snapshot),
    ...(snapshot.sha256 !== undefined ? { sha256: snapshot.sha256 } : {}),
    ...(snapshot.byteLength !== undefined ? { byteLength: snapshot.byteLength } : {}),
    text: snapshot.text,
    updatedAtMs: snapshot.updatedAtMs,
    latestMomentId: snapshot.latestMomentId,
    metadata: cloneJson(snapshot.metadata),
  };
}

function fileStatesEqual(a: VersionedTextFileState, b: VersionedTextFileState): boolean {
  if (a.exists !== b.exists) return false;
  if (!a.exists && !b.exists) return true;
  if (fileStateContentKind(a) !== fileStateContentKind(b)) return false;
  if (isBinaryState(a)) return a.sha256 === b.sha256;
  return a.text === b.text;
}

// Exact live-state check for mirrored resolves (0P-C gate fix): beyond
// content, the LIVE snapshot must still be the precise state the conflict
// row recorded — same path, same object identity, and same latest moment id.
// Content-only equality would let a peer's resolution act on a lineage that
// moved on locally (e.g. edited then reverted to the same bytes, or a
// different object that now occupies the path).
function liveStateMatchesConflictCurrent(
  live: VersionedTextFileState,
  recorded: VersionedTextFileState,
): boolean {
  if (live.exists !== recorded.exists) return false;
  if (!live.exists && !recorded.exists) return true;
  return (
    live.path === recorded.path &&
    live.objectId === recorded.objectId &&
    live.latestMomentId === recorded.latestMomentId &&
    fileStateContentKind(live) === fileStateContentKind(recorded) &&
    (isBinaryState(live) ? live.sha256 === recorded.sha256 : live.text === recorded.text)
  );
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

function payloadFromSnapshot(snapshot: TextFileSnapshot): VersionedTextMomentPayloadSnapshot {
  return {
    path: snapshot.path,
    contentKind: snapshotContentKind(snapshot),
    ...(snapshot.sha256 !== undefined ? { sha256: snapshot.sha256 } : {}),
    ...(snapshot.byteLength !== undefined ? { byteLength: snapshot.byteLength } : {}),
    text: snapshot.text,
  };
}

function textPayload(path: string, text: string): VersionedTextMomentPayloadSnapshot {
  return { path, text };
}

function binaryPayload(input: {
  path: string;
  sha256: string;
  byteLength: number;
}): VersionedTextMomentPayloadSnapshot {
  return {
    path: input.path,
    contentKind: "binary",
    sha256: input.sha256,
    byteLength: input.byteLength,
    text: "",
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

function snapshotSelectSql(table: "snapshots" | "fork_base_snapshots", where: string): string {
  return `SELECT s.*, b.text, COALESCE(b.byte_length, bb.byte_length) AS byte_length
          FROM ${table} s
          LEFT JOIN blobs b
            ON b.sha256 = s.blob_sha256
           AND COALESCE(s.content_kind, 'text') = 'text'
          LEFT JOIN binary_blobs bb
            ON bb.sha256 = s.blob_sha256
           AND COALESCE(s.content_kind, 'text') = 'binary'
          ${where}`;
}

function selectSnapshotByObject(
  db: SqliteDb,
  workspaceId: WorkspaceId,
  versionId: VersionId,
  objectId: WorkspaceObjectId,
): TextFileSnapshot | null {
  const row = db
    .prepare(
      snapshotSelectSql(
        "snapshots",
        "WHERE s.workspace_id = ? AND s.version_id = ? AND s.object_id = ?",
      ),
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
      `SELECT s.*, b.text, COALESCE(b.byte_length, bb.byte_length) AS byte_length
       FROM path_aliases a
       JOIN snapshots s
         ON s.workspace_id = a.workspace_id
        AND s.version_id = a.version_id
        AND s.object_id = a.object_id
       LEFT JOIN blobs b
         ON b.sha256 = s.blob_sha256
        AND COALESCE(s.content_kind, 'text') = 'text'
       LEFT JOIN binary_blobs bb
         ON bb.sha256 = s.blob_sha256
        AND COALESCE(s.content_kind, 'text') = 'binary'
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
      snapshotSelectSql(
        "snapshots",
        `WHERE s.workspace_id = ? AND s.version_id = ? AND s.path = ?
         LIMIT 2`,
      ),
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
      snapshotSelectSql(
        "fork_base_snapshots",
        `WHERE s.workspace_id = ? AND s.version_id = ? AND s.path = ?
         LIMIT 2`,
      ),
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
  options: { journal?: boolean } = {},
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
  if (options.journal !== false) {
    journalLocalReplicationOp(db, {
      workspaceId,
      opKind: "workspace.init",
      payload: {},
      recordedAtMs: main.createdAtMs,
    });
  }
  return main;
}

function insertOrReplaceSnapshot(
  db: SqliteDb,
  table: "snapshots" | "fork_base_snapshots",
  workspaceId: WorkspaceId,
  versionId: VersionId,
  snapshot: TextFileSnapshot,
): void {
  const contentKind = snapshotContentKind(snapshot);
  const blobSha256 =
    contentKind === "binary"
      ? (() => {
          if (!snapshot.sha256) throw corruptStore();
          return snapshot.sha256;
        })()
      : putBlob(db, snapshot.text);
  db.prepare(
    `INSERT INTO ${table} (
      workspace_id, version_id, object_id, path, content_kind, blob_sha256, updated_at_ms,
      latest_moment_id, metadata_origin, metadata_summary, metadata_correlation_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(workspace_id, version_id, object_id) DO UPDATE SET
      path = excluded.path,
      content_kind = excluded.content_kind,
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
    contentKind,
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

function insertMomentRow(
  db: SqliteDb,
  moment: VersionedTextMoment,
  options: { recordOnly?: boolean } = {},
): void {
  const payloadBeforeKind = moment.payload.before?.contentKind ?? "text";
  const payloadAfterKind = moment.payload.after.contentKind ?? "text";
  const payloadBeforeSha = moment.payload.before
    ? payloadBeforeKind === "binary"
      ? moment.payload.before.sha256
      : putBlob(db, moment.payload.before.text)
    : null;
  const payloadAfterSha =
    payloadAfterKind === "binary"
      ? moment.payload.after.sha256
      : putBlob(db, moment.payload.after.text);
  const beforePresent = moment.before === undefined ? 0 : moment.before === null ? 1 : 2;
  const beforeKind =
    moment.before && moment.before !== null ? snapshotContentKind(moment.before) : "text";
  const beforeSha =
    moment.before && moment.before !== null
      ? beforeKind === "binary"
        ? moment.before.sha256
        : putBlob(db, moment.before.text)
      : null;
  if (
    (payloadBeforeKind === "binary" && !payloadBeforeSha) ||
    (payloadAfterKind === "binary" && !payloadAfterSha) ||
    (beforeKind === "binary" && !beforeSha)
  ) {
    throw corruptStore();
  }
  // Sync journaling is the CALLER's job (writeTextFileInDb, deleteTextFileInDb,
  // renameTextFile, writeBinaryFileInDb journal a moment.append beside this
  // insert; applyRemoteMomentAppend journals the imported envelope instead).
  db.prepare(
    `INSERT INTO moments (
      workspace_id, moment_order, moment_id, version_id, object_id, path,
      recorded_at_ms, operation, payload_before_path, payload_before_content_kind,
      payload_before_blob_sha256, payload_after_path, payload_after_content_kind,
      payload_after_blob_sha256, metadata_origin,
      metadata_summary, metadata_correlation_id, before_present, before_object_id,
      before_version_id, before_path, before_content_kind, before_blob_sha256, before_updated_at_ms,
      before_latest_moment_id, before_metadata_origin, before_metadata_summary,
      before_metadata_correlation_id, author_json, sync_record_only
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
    moment.payload.before ? payloadBeforeKind : null,
    payloadBeforeSha,
    moment.payload.after.path,
    payloadAfterKind,
    payloadAfterSha,
    ...metadataValues(moment.metadata),
    beforePresent,
    moment.before && moment.before !== null ? moment.before.objectId : null,
    moment.before && moment.before !== null ? moment.before.versionId : null,
    moment.before && moment.before !== null ? moment.before.path : null,
    moment.before && moment.before !== null ? beforeKind : null,
    beforeSha,
    moment.before && moment.before !== null ? moment.before.updatedAtMs : null,
    moment.before && moment.before !== null ? moment.before.latestMomentId : null,
    ...(moment.before && moment.before !== null ? metadataValues(moment.before.metadata) : [null, null, null]),
    momentAuthorToJson(moment.author),
    options.recordOnly ? 1 : null,
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
      base_exists, base_path, base_object_id, base_content_kind, base_blob_sha256, base_updated_at_ms,
      base_latest_moment_id, base_metadata_origin, base_metadata_summary,
      base_metadata_correlation_id, current_exists, current_path, current_object_id,
      current_content_kind, current_blob_sha256, current_updated_at_ms, current_latest_moment_id,
      current_metadata_origin, current_metadata_summary, current_metadata_correlation_id,
      incoming_exists, incoming_path, incoming_object_id, incoming_content_kind, incoming_blob_sha256,
      incoming_updated_at_ms, incoming_latest_moment_id, incoming_metadata_origin,
      incoming_metadata_summary, incoming_metadata_correlation_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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

// Deterministic, machine-independent identity for a SYNC divergence conflict
// (0P sync-hardening item 1). Sync conflicts are minted independently on each
// machine that applies a divergent remote moment.append (they never replicate
// as conflict.open ops), so their ids must be a pure function of the shared
// facts: the workspace, the version, the diverging object, and the fork-point
// moment both lineages descend from. Both machines therefore compute the SAME
// id for the same divergence, which lets a resolve on one close the mirror on
// the other by id (instead of the fragile swapped-head lookup), and lets
// repeated divergent ops in one episode coalesce onto one row.
//
// The base moment id is the shared fork point: `beforeLatestMomentId` of the
// FIRST divergent op each side sees (per-origin FIFO makes that the same M0 on
// both machines). Later ops in the episode coalesce, so the id never
// re-derives from their differing bases.
//
// N-WAY BRANCH IDENTITY (0P sync-hardening item 1 gate fix): the fork point
// alone is NOT enough. If machines A/B/C all fork the SAME object O from the
// SAME base moment M0, every pairwise divergence (A-vs-B, A-vs-C, B-vs-C)
// hashes to the SAME id -- so C's op coalesces onto A-vs-B's row, or a
// resolve-by-id closes the wrong mirror, and a branch is silently dropped from
// the actionable conflict set. The id therefore also folds in the identity of
// the TWO diverging branches: each branch's FIRST divergent op after M0 (its
// "branch root"). The pair is order-independent (min,max) so the SAME pairwise
// conflict still mints the SAME id on both machines (they see the same two
// root op ids, just with current/incoming swapped), while two DIFFERENT
// pairwise conflicts on one object get DIFFERENT ids.
function syncConflictId(
  workspaceId: WorkspaceId,
  versionId: VersionId,
  objectId: WorkspaceObjectId,
  baseMomentId: string | null,
  branchRoots?: { local: string | null; incoming: string | null },
): string {
  let branchPart = "";
  if (branchRoots) {
    const local = branchRoots.local ?? "\u0000absent-local-root";
    const incoming = branchRoots.incoming ?? "\u0000absent-incoming-root";
    const [low, high] = local <= incoming ? [local, incoming] : [incoming, local];
    branchPart = `\u0000${low}\u0000${high}`;
  }
  return `conflict_sync_${sha256Text(
    `${workspaceId}\u0000${versionId}\u0000${objectId}\u0000${baseMomentId ?? "\u0000absent-base"}${branchPart}`,
  ).slice(0, 32)}`;
}

// The local branch's FIRST divergent op after the shared fork point M0: the
// only APPLIED (non-record-only) local moment for this object whose preimage
// head is M0. Remote divergent ops are recorded as `sync_record_only`, so they
// are excluded -- this returns THIS machine's own branch root, which the peer
// sees as the incoming branch root of the mirror conflict (so both machines
// fold the same order-independent pair of roots into the id).
function localBranchRoot(
  db: SqliteDb,
  workspaceId: WorkspaceId,
  versionId: VersionId,
  objectId: string,
  baseMomentId: string | null,
): string | null {
  const row = db
    .prepare(
      `SELECT moment_id FROM moments
       WHERE workspace_id = ? AND version_id = ? AND object_id = ?
         AND before_latest_moment_id IS ?
         AND (sync_record_only IS NULL OR sync_record_only = 0)
       ORDER BY moment_order
       LIMIT 1`,
    )
    .get(workspaceId, versionId, objectId, baseMomentId);
  return row ? rowString(row, "moment_id") : null;
}

// Coalesce a newer divergent remote head onto an already-open sync conflict
// (0P sync-hardening item 2): update the incoming side to the newer remote
// head and bump updatedAtMs, preserving the row's identity, base, and current
// side. The current side is deliberately left as first recorded — it is THIS
// machine's own divergent head, which local writes advance independently of
// the conflict row; the resolve path always re-reads the live head before
// acting (liveStateMatchesConflictCurrent), so a lagging current is never
// acted on stale.
function coalesceConflictSides(
  db: SqliteDb,
  workspaceId: WorkspaceId,
  conflictId: string,
  incoming: VersionedTextFileState,
  updatedAtMs: number,
): void {
  db.prepare(
    `UPDATE conflicts SET
       updated_at_ms = ?,
       incoming_exists = ?, incoming_path = ?, incoming_object_id = ?,
       incoming_content_kind = ?, incoming_blob_sha256 = ?, incoming_updated_at_ms = ?,
       incoming_latest_moment_id = ?, incoming_metadata_origin = ?, incoming_metadata_summary = ?,
       incoming_metadata_correlation_id = ?
     WHERE workspace_id = ? AND conflict_id = ?`,
  ).run(updatedAtMs, ...insertConflictFileState(db, incoming), workspaceId, conflictId);
}

// Open a fresh sync conflict, OR coalesce onto the open one already tracking
// this branch lineage (items 1+2). Returns the number of conflicts newly
// opened (0 when it coalesced or was already present).
//
// COALESCING IS BRANCH- AND KIND-SPECIFIC (item 2 gate fix). A newer divergent
// op coalesces ONLY onto the open row it EXTENDS: the row's recorded incoming
// head equals this op's own preimage head (`incomingBranchBase`) — per-origin
// FIFO makes each op's base the previous op's head, tying a coalesce to one
// specific incoming branch — PLUS a kind-specific anchor on the correct object
// side:
//   - "same-object": the DIVERGING object is the incoming side
//     (incoming_object_id). When this machine holds its OWN copy of that
//     object the current side is it too (current_object_id), and a
//     co-created path-occupancy row shares the SAME incoming op; the
//     `current_object_id IS diverging` preference then breaks the tie toward
//     the primary row (the occupancy row's current is the displaced occupant).
//     When this machine has NO local copy (the incoming object collides at a
//     path an unrelated object holds) the current side is that occupant, no
//     occupancy row is created, and the incoming-side anchor still finds the
//     one row to extend.
//   - "occupancy": the DISPLACED occupant is the current side
//     (current_object_id), which the same incoming mover op never matches.
// This replaces the old `current OR incoming = O` lookup, which matched a
// same-object move conflict AND its occupancy row (data loss: a later coalesce
// landed on the occupancy row, leaving the real conflict stale) and matched
// every branch of an N-way fork onto whichever row sorted first (dropping the
// rest).
type SyncCoalesceAnchor =
  | { kind: "same-object"; divergingObjectId: string; incomingBranchBase: string | null }
  | { kind: "occupancy"; occupantObjectId: string; incomingBranchBase: string | null };

function openOrCoalesceSyncConflict(
  db: SqliteDb,
  workspaceId: WorkspaceId,
  params: {
    versionId: VersionId;
    coalesce: SyncCoalesceAnchor;
    conflictId: string;
    path: string;
    base: VersionedTextFileState;
    current: VersionedTextFileState;
    incoming: VersionedTextFileState;
    recordedAtMs: number;
  },
): number {
  const existingRow =
    params.coalesce.kind === "same-object"
      ? db
          .prepare(
            conflictSelectSql(
              `WHERE c.workspace_id = ? AND c.status = 'open' AND c.metadata_origin = 'sync'
                 AND c.target_version_id = ?
                 AND c.incoming_object_id IS ?
                 AND c.incoming_latest_moment_id IS ?
               ORDER BY (c.current_object_id IS ?) DESC, c.created_at_ms, c.conflict_id
               LIMIT 1`,
            ),
          )
          .get(
            workspaceId,
            params.versionId,
            params.coalesce.divergingObjectId,
            params.coalesce.incomingBranchBase,
            params.coalesce.divergingObjectId,
          )
      : db
          .prepare(
            conflictSelectSql(
              `WHERE c.workspace_id = ? AND c.status = 'open' AND c.metadata_origin = 'sync'
                 AND c.target_version_id = ?
                 AND c.current_object_id IS ?
                 AND c.incoming_latest_moment_id IS ?
               ORDER BY c.created_at_ms, c.conflict_id
               LIMIT 1`,
            ),
          )
          .get(
            workspaceId,
            params.versionId,
            params.coalesce.occupantObjectId,
            params.coalesce.incomingBranchBase,
          );
  if (existingRow) {
    coalesceConflictSides(
      db,
      workspaceId,
      rowString(existingRow, "conflict_id"),
      params.incoming,
      params.recordedAtMs,
    );
    return 0;
  }
  if (
    db
      .prepare("SELECT 1 FROM conflicts WHERE workspace_id = ? AND conflict_id = ?")
      .get(workspaceId, params.conflictId)
  ) {
    // A row with this deterministic id already exists (idempotent re-import,
    // or a resolved prior episode with the same base). Leave it untouched.
    return 0;
  }
  insertConflictRow(db, {
    id: params.conflictId,
    workspaceId,
    path: params.path,
    targetVersionId: params.versionId,
    sourceVersionId: params.versionId,
    createdAtMs: params.recordedAtMs,
    updatedAtMs: params.recordedAtMs,
    base: params.base,
    current: params.current,
    incoming: params.incoming,
    status: "open",
    chosenFrom: "current",
    metadata: { origin: "sync" },
  });
  return 1;
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
                 COALESCE(base_blob.byte_length, base_binary.byte_length) AS base_byte_length,
                 current_blob.text AS current_text,
                 COALESCE(current_blob.byte_length, current_binary.byte_length) AS current_byte_length,
                 incoming_blob.text AS incoming_text
                 , COALESCE(incoming_blob.byte_length, incoming_binary.byte_length) AS incoming_byte_length
          FROM conflicts c
          LEFT JOIN blobs base_blob
            ON base_blob.sha256 = c.base_blob_sha256
           AND COALESCE(c.base_content_kind, 'text') = 'text'
          LEFT JOIN binary_blobs base_binary
            ON base_binary.sha256 = c.base_blob_sha256
           AND COALESCE(c.base_content_kind, 'text') = 'binary'
          LEFT JOIN blobs current_blob
            ON current_blob.sha256 = c.current_blob_sha256
           AND COALESCE(c.current_content_kind, 'text') = 'text'
          LEFT JOIN binary_blobs current_binary
            ON current_binary.sha256 = c.current_blob_sha256
           AND COALESCE(c.current_content_kind, 'text') = 'binary'
          LEFT JOIN blobs incoming_blob
            ON incoming_blob.sha256 = c.incoming_blob_sha256
           AND COALESCE(c.incoming_content_kind, 'text') = 'text'
          LEFT JOIN binary_blobs incoming_binary
            ON incoming_binary.sha256 = c.incoming_blob_sha256
           AND COALESCE(c.incoming_content_kind, 'text') = 'binary'
          ${where}`;
}

function selectMomentByOrder(
  db: SqliteDb,
  workspaceId: WorkspaceId,
  versionId: VersionId,
  objectId: WorkspaceObjectId,
  maxOrder: number,
): { moment: VersionedTextMoment; order: number } | null {
  // Record-only sync divergence rows are timeline-visible history, never a
  // materialized predecessor: rollback preimages and fork-point inheritance
  // must resolve through applied moments only.
  const row = db
    .prepare(
      momentSelectSql(
        `WHERE m.workspace_id = ? AND m.version_id = ? AND m.object_id = ? AND m.moment_order <= ?
           AND (m.sync_record_only IS NULL OR m.sync_record_only = 0)
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
           AND (sync_record_only IS NULL OR sync_record_only = 0)
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
         AND (sync_record_only IS NULL OR sync_record_only = 0)
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
  // Canonical (symlink/alias-resolved) engine.db identity keys the shared write
  // chain so a store, a second store, and the Y.Doc driver on the SAME physical
  // engine.db all serialize through ONE lane (not per-lexical-path lanes).
  const stateFilePath = canonicalEngineDbPath(rootDir);
  let activeWriteDb: SqliteDb | null = null;
  // Set only while a runInEngineWriteLane task is executing. A store WRITE
  // (serialize) invoked from inside that task would queue behind the still-open
  // lane transaction and deadlock, so we refuse it loudly (see serialize()).
  let inEngineWriteLane = false;
  let dbHandle: SqliteDb | null = null;
  let validated = false;

  function db(): SqliteDb {
    if (!dbHandle || dbHandle.isOpen === false) {
      // A handle can be closed out from under the store (the test-teardown
      // sweep releases Windows file locks between tests); reopen and
      // re-validate instead of returning a dead handle.
      dbHandle = openDatabase(rootDir, options.integrityCheck ?? "quick");
      validated = false;
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
    // Reentry guard: a runInEngineWriteLane task holds the single lane
    // transaction open. If that task calls back into a serialized store write
    // (writeTextFile, writeBinaryFile, applyReplicationOp, another lane, …) the
    // new write would queue behind the still-running lane promise and never run
    // — a self-inflicted deadlock. The lane contract is SQL-only on the passed
    // connection; misuse must fail loud, not hang.
    if (inEngineWriteLane) {
      throw new VersionedTextStoreError(
        "write-lane-reentry",
        "A store write was called from inside a runInEngineWriteLane task. The lane task must operate ONLY on its passed connection (SQL-only) and must not re-enter serialized store methods, which would deadlock behind the open lane transaction.",
      );
    }
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
        before: before ? payloadFromSnapshot(before) : null,
        after: textPayload(input.path, input.text),
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
        before: payloadFromSnapshot(before),
        after: payloadFromSnapshot(before),
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
    // WS-G2-C1: skip journaling a moment.append replication op. A Y.Doc-driven
    // object's markdown is a LOCAL projection of the replicated ydoc.update
    // stream; journaling its settle would double-replicate the content and
    // collide two peers' independent settles into a P0D conflict. The moment +
    // snapshot + search index are still written (local history stays intact).
    suppressReplicationJournal?: boolean;
    // WS-G2-C1: pin the object identity (cross-machine, from a ydoc.update
    // payload) instead of minting a fresh local id, so the projected file and
    // the ydoc_docs marker (FK -> file_objects) share the ORIGIN's object id on
    // every peer. Only honored when creating a NEW object at this path.
    objectId?: WorkspaceObjectId;
    objectCreatedAtMs?: number;
  }): VersionedTextWriteResult {
    requireWorkspaceVersionRow(input.db, input.workspaceId, input.versionId);
    const before = selectSnapshotByPath(input.db, input.workspaceId, input.versionId, input.path);
    const recordedAtMs = readNowMs();
    let object: FileObjectRecord;

    if (before) {
      object = requireFileObjectRow(input.db, input.workspaceId, before.objectId);
    } else if (input.objectId !== undefined) {
      // Pinned (replicated) identity. Reuse an existing same-workspace object
      // row (a prior apply created it); reject a cross-workspace id collision;
      // otherwise insert with the origin's id + creation time.
      const existing = input.db
        .prepare("SELECT workspace_id, created_at_ms FROM file_objects WHERE object_id = ?")
        .get(input.objectId);
      if (existing && existing.workspace_id !== input.workspaceId) {
        rejectDuplicateId("object", input.objectId);
      }
      if (existing) {
        object = {
          id: input.objectId,
          workspaceId: input.workspaceId,
          createdAtMs: Number(existing.created_at_ms),
        };
      } else {
        const createdAtMs = input.objectCreatedAtMs ?? recordedAtMs;
        object = { id: input.objectId, workspaceId: input.workspaceId, createdAtMs };
        input.db
          .prepare("INSERT INTO file_objects (workspace_id, object_id, created_at_ms) VALUES (?, ?, ?)")
          .run(input.workspaceId, object.id, object.createdAtMs);
      }
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
        before: before ? payloadFromSnapshot(before) : null,
        after: textPayload(input.path, input.text),
      },
      metadata: input.metadata,
      ...(input.author !== undefined ? { author: input.author } : {}),
      before,
    });
    const snapshot: TextFileSnapshot = {
      objectId: object.id,
      versionId: input.versionId,
      path: input.path,
      contentKind: "text",
      sha256: sha256Text(input.text),
      byteLength: Buffer.byteLength(input.text, "utf8"),
      text: input.text,
      updatedAtMs: recordedAtMs,
      latestMomentId: moment.id,
      metadata: pickWriteMetadata(input.metadata),
    };

    insertMomentRow(input.db, moment);
    if (!input.suppressReplicationJournal) {
      journalLocalReplicationOp(input.db, {
        workspaceId: input.workspaceId,
        opKind: "moment.append",
        payload: momentAppendPayload({
          db: input.db,
          moment,
          objectCreatedAtMs: object.createdAtMs,
        }),
        recordedAtMs: moment.recordedAtMs,
      });
    }
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
        before: payloadFromSnapshot(before),
        after: payloadFromSnapshot(before),
      },
      metadata: input.metadata,
      ...(input.author !== undefined ? { author: input.author } : {}),
      before,
    });

    insertMomentRow(input.db, moment);
    journalLocalReplicationOp(input.db, {
      workspaceId: input.workspaceId,
      opKind: "moment.append",
      payload: momentAppendPayload({
        db: input.db,
        moment,
        objectCreatedAtMs: object.createdAtMs,
      }),
      recordedAtMs: moment.recordedAtMs,
    });
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

  function writeBinaryFileInDb(input: {
    db: SqliteDb;
    workspaceId: WorkspaceId;
    versionId: VersionId;
    path: string;
    bytes: Uint8Array;
    metadata: ActorNeutralWriteMetadata;
    author?: MomentAuthor;
    momentId?: VersionedTextMomentId;
  }): VersionedTextWriteResult {
    requireWorkspaceVersionRow(input.db, input.workspaceId, input.versionId);
    const bytes = normalizeWriteBinaryBytes(input.bytes);
    const sha256 = putBinaryBlob(input.db, bytes);
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
    const afterPayload = binaryPayload({
      path: input.path,
      sha256,
      byteLength: bytes.byteLength,
    });
    const moment = createMoment({
      id: momentId,
      workspaceId: input.workspaceId,
      versionId: input.versionId,
      objectId: object.id,
      path: input.path,
      recordedAtMs,
      operation: "write",
      payload: {
        before: before ? payloadFromSnapshot(before) : null,
        after: afterPayload,
      },
      metadata: input.metadata,
      ...(input.author !== undefined ? { author: input.author } : {}),
      before,
    });
    const snapshot: TextFileSnapshot = {
      objectId: object.id,
      versionId: input.versionId,
      path: input.path,
      contentKind: "binary",
      sha256,
      byteLength: bytes.byteLength,
      text: "",
      updatedAtMs: recordedAtMs,
      latestMomentId: moment.id,
      metadata: pickWriteMetadata(input.metadata),
    };

    insertMomentRow(input.db, moment);
    journalLocalReplicationOp(input.db, {
      workspaceId: input.workspaceId,
      opKind: "moment.append",
      payload: momentAppendPayload({
        db: input.db,
        moment,
        objectCreatedAtMs: object.createdAtMs,
      }),
      recordedAtMs: moment.recordedAtMs,
    });
    insertOrReplaceSnapshot(input.db, "snapshots", input.workspaceId, input.versionId, snapshot);
    input.db
      .prepare(
        `INSERT INTO path_aliases (workspace_id, version_id, path, object_id)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(workspace_id, version_id, path) DO UPDATE SET object_id = excluded.object_id`,
      )
      .run(input.workspaceId, input.versionId, input.path, object.id);
    deleteFileSearchIndex({
      db: input.db,
      workspaceId: input.workspaceId,
      versionId: input.versionId,
      objectId: object.id,
    });

    return {
      object: cloneFileObject(object),
      snapshot: cloneSnapshot(snapshot),
      moment: cloneMoment(moment),
    };
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
    journalLocalReplicationOp(input.db, {
      workspaceId: conflict.workspaceId,
      opKind: "conflict.open",
      payload: conflict,
      recordedAtMs: conflict.createdAtMs,
    });
    return conflict;
  }

  function journalImportedReplicationOp(db: SqliteDb, input: SyncReplicationEnvelope): void {
    db.prepare(
      `INSERT OR IGNORE INTO replication_log (
        workspace_id, origin_id, origin_seq, op_kind, payload_json, recorded_at_ms
      ) VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(
      input.workspaceId,
      input.originId,
      input.originSeq,
      input.opKind,
      JSON.stringify(input.payload),
      input.recordedAtMs,
    );
  }

  function importedReplicationLogExists(db: SqliteDb, input: SyncReplicationEnvelope): boolean {
    return Boolean(
      db
        .prepare(
          `SELECT 1 FROM replication_log
           WHERE workspace_id = ? AND origin_id = ? AND origin_seq = ?`,
        )
        .get(input.workspaceId, input.originId, input.originSeq),
    );
  }

  function insertVersionFromReplication(
    db: SqliteDb,
    workspaceId: WorkspaceId,
    payload: VersionCreatePayload,
  ): void {
    const existing = db
      .prepare("SELECT 1 FROM versions WHERE workspace_id = ? AND version_id = ?")
      .get(workspaceId, payload.versionId);
    if (existing) return;
    if (payload.versionId !== "main" && db.prepare("SELECT 1 FROM versions WHERE version_id = ?").get(payload.versionId)) {
      rejectDuplicateId("version", payload.versionId);
    }
    const source = payload.forkVersionId
      ? requireWorkspaceVersionRow(db, workspaceId, payload.forkVersionId)
      : undefined;
    db.prepare(
      `INSERT INTO versions (
        workspace_id, version_id, kind, name, created_at_ms, fork_version_id, fork_moment_id,
        sync_materialized
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      workspaceId,
      payload.versionId,
      payload.kind,
      payload.name,
      payload.createdAtMs,
      payload.forkVersionId ?? null,
      payload.forkMomentId ?? null,
      // Payload-materialized fork state is exempt from local fork-point
      // lineage inference (see engineDbSchema sync_materialized note).
      payload.forkSnapshots !== undefined ? 1 : null,
    );
    if (!source) return;
    if (payload.forkSnapshots !== undefined) {
      // Deterministic replay: materialize the fork from the ORIGIN's shipped
      // fork-point state. The importer's own current snapshots may hold local
      // edits the origin never saw — copying them would silently absorb them
      // into the origin's fork.
      for (const snapshot of payload.forkSnapshots) {
        const isBinary = (snapshot.contentKind ?? "text") === "binary";
        if (isBinary) {
          const blob = db
            .prepare("SELECT byte_length FROM binary_blobs WHERE sha256 = ?")
            .get(snapshot.blobSha256);
          if (!blob) throw corruptStore();
          // Compatibility anchor, mirroring putBinaryBlob: *_blob_sha256
          // foreign keys reference blobs, content_kind gates reads.
          db.prepare(
            "INSERT OR IGNORE INTO blobs (sha256, byte_length, text) VALUES (?, ?, '')",
          ).run(snapshot.blobSha256, rowNumber(blob, "byte_length"));
        } else if (!db.prepare("SELECT 1 FROM blobs WHERE sha256 = ?").get(snapshot.blobSha256)) {
          throw corruptStore();
        }
        db.prepare(
          "INSERT OR IGNORE INTO file_objects (workspace_id, object_id, created_at_ms) VALUES (?, ?, ?)",
        ).run(workspaceId, snapshot.objectId, snapshot.objectCreatedAtMs ?? payload.createdAtMs);
        for (const table of ["snapshots", "fork_base_snapshots"] as const) {
          db.prepare(
            `INSERT INTO ${table} (
              workspace_id, version_id, object_id, path, content_kind, blob_sha256, updated_at_ms,
              latest_moment_id, metadata_origin, metadata_summary, metadata_correlation_id
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          ).run(
            workspaceId,
            payload.versionId,
            snapshot.objectId,
            snapshot.path,
            isBinary ? "binary" : "text",
            snapshot.blobSha256,
            snapshot.updatedAtMs,
            snapshot.latestMomentId,
            ...metadataValues(pickWriteMetadata(snapshot.metadata)),
          );
        }
        db.prepare(
          `INSERT INTO path_aliases (workspace_id, version_id, path, object_id)
           VALUES (?, ?, ?, ?)`,
        ).run(workspaceId, payload.versionId, snapshot.path, snapshot.objectId);
      }
      return;
    }
    // Legacy payloads (journaled before fork-state shipping) fall back to
    // copying the importer's local source-version snapshots, content_kind
    // included so binary snapshots never degrade to empty text.
    db.prepare(
      `INSERT INTO snapshots (
        workspace_id, version_id, object_id, path, content_kind, blob_sha256, updated_at_ms,
        latest_moment_id, metadata_origin, metadata_summary, metadata_correlation_id
      )
      SELECT workspace_id, ?, object_id, path, content_kind, blob_sha256, updated_at_ms,
             latest_moment_id, metadata_origin, metadata_summary, metadata_correlation_id
      FROM snapshots
      WHERE workspace_id = ? AND version_id = ?`,
    ).run(payload.versionId, workspaceId, source.id);
    db.prepare(
      `INSERT INTO path_aliases (workspace_id, version_id, path, object_id)
       SELECT workspace_id, ?, path, object_id
       FROM path_aliases
       WHERE workspace_id = ? AND version_id = ?`,
    ).run(payload.versionId, workspaceId, source.id);
    db.prepare(
      `INSERT INTO fork_base_snapshots (
        workspace_id, version_id, object_id, path, content_kind, blob_sha256, updated_at_ms,
        latest_moment_id, metadata_origin, metadata_summary, metadata_correlation_id
      )
      SELECT workspace_id, ?, object_id, path, content_kind, blob_sha256, updated_at_ms,
             latest_moment_id, metadata_origin, metadata_summary, metadata_correlation_id
      FROM snapshots
      WHERE workspace_id = ? AND version_id = ?`,
    ).run(payload.versionId, workspaceId, source.id);
  }

  function applyRemoteMomentAppend(
    db: SqliteDb,
    workspaceId: WorkspaceId,
    payload: MomentAppendPayload,
  ): number {
    requireWorkspaceVersionRow(db, workspaceId, payload.versionId);
    if (db.prepare("SELECT 1 FROM moments WHERE workspace_id = ? AND moment_id = ?").get(workspaceId, payload.momentId)) {
      return 0;
    }
    const localSnapshot = selectSnapshotByObject(
      db,
      workspaceId,
      payload.versionId,
      payload.objectId,
    );
    const pathOccupant =
      payload.operation === "delete"
        ? null
        : selectSnapshotByPath(db, workspaceId, payload.versionId, payload.payloadAfterPath);
    const conflictingPathOccupant =
      pathOccupant && pathOccupant.objectId !== payload.objectId ? pathOccupant : null;
    const originSawAbsent =
      payload.beforePresent === "absent" || payload.beforePresent === "null";
    const headFastForward = originSawAbsent
      ? localSnapshot === null && conflictingPathOccupant === null
      : localSnapshot !== null &&
        localSnapshot.latestMomentId === payload.beforeLatestMomentId &&
        conflictingPathOccupant === null;
    // Content convergence (0P-C): heads that diverged but arrived at the SAME
    // bytes at the same path are agreement, not conflict — adopt the remote
    // moment as the new head so both machines converge on one lineage. This
    // is how a conflict-resolution round trip settles: the resolver's write
    // op lands on the peer (whose copy already matches) as a fast-forward
    // instead of a spurious identical-content conflict, and later edits
    // fast-forward by head again. A both-sides-deleted file converges the
    // same way.
    const contentFastForward =
      !headFastForward &&
      (payload.operation === "delete"
        ? localSnapshot === null && conflictingPathOccupant === null
        : localSnapshot !== null &&
          conflictingPathOccupant === null &&
          localSnapshot.path === payload.payloadAfterPath &&
          ((payload.payloadAfterContentKind ?? "text") === "binary"
            ? isBinarySnapshot(localSnapshot) &&
              localSnapshot.sha256 === payload.payloadAfterBlobSha256
            : !isBinarySnapshot(localSnapshot) &&
              localSnapshot.text === requireBlobText(db, payload.payloadAfterBlobSha256)));
    const canFastForward = headFastForward || contentFastForward;
    const moment = momentFromAppendPayload(db, workspaceId, payload);
    if (contentFastForward && payload.operation === "delete") {
      // Both sides deleted the file: agreement. The remote delete is kept as
      // a record-only row (its preimage describes the REMOTE lineage, which
      // this store's moment chain never materialized) and nothing else
      // changes — no snapshot exists, no conflict opens.
      db.prepare(
        "INSERT OR IGNORE INTO file_objects (workspace_id, object_id, created_at_ms) VALUES (?, ?, ?)",
      ).run(workspaceId, payload.objectId, payload.objectCreatedAtMs ?? payload.recordedAtMs);
      insertMomentRow(db, moment, { recordOnly: true });
      return 0;
    }
    if (canFastForward) {
      // A content-convergent adoption (heads diverged, same bytes) keeps the
      // moment-chain invariant honest by localizing the ROLLBACK preimage to
      // this store's actual previous state; the wire payload (and therefore
      // what re-replicates) stays byte-identical via the imported journal.
      const adoptedMoment =
        contentFastForward && !headFastForward && localSnapshot
          ? { ...moment, before: cloneSnapshot(localSnapshot) }
          : moment;
      db.prepare(
        "INSERT OR IGNORE INTO file_objects (workspace_id, object_id, created_at_ms) VALUES (?, ?, ?)",
      ).run(workspaceId, payload.objectId, payload.objectCreatedAtMs ?? payload.recordedAtMs);
      insertMomentRow(db, adoptedMoment);
      if (payload.operation === "delete") {
        db.prepare(
          "DELETE FROM path_aliases WHERE workspace_id = ? AND version_id = ? AND path = ? AND object_id = ?",
        ).run(workspaceId, payload.versionId, payload.path, payload.objectId);
        db.prepare(
          "DELETE FROM snapshots WHERE workspace_id = ? AND version_id = ? AND object_id = ?",
        ).run(workspaceId, payload.versionId, payload.objectId);
        deleteFileSearchIndex({
          db,
          workspaceId,
          versionId: payload.versionId,
          objectId: payload.objectId,
        });
        return 0;
      }
      const afterIsBinary = (payload.payloadAfterContentKind ?? "text") === "binary";
      const snapshot: TextFileSnapshot = {
        objectId: payload.objectId,
        versionId: payload.versionId,
        path: payload.payloadAfterPath,
        ...(afterIsBinary
          ? {
              contentKind: "binary" as const,
              sha256: payload.payloadAfterBlobSha256,
              byteLength:
                payload.payloadAfterByteLength ??
                readBinaryBlobFromDb(db, payload.payloadAfterBlobSha256).byteLength,
              text: "",
            }
          : { text: requireBlobText(db, payload.payloadAfterBlobSha256) }),
        updatedAtMs: payload.recordedAtMs,
        latestMomentId: payload.momentId,
        metadata: pickWriteMetadata(payload.metadata),
      };
      if (payload.operation === "rename" && payload.payloadBeforePath) {
        db.prepare(
          "DELETE FROM path_aliases WHERE workspace_id = ? AND version_id = ? AND path = ? AND object_id = ?",
        ).run(workspaceId, payload.versionId, payload.payloadBeforePath, payload.objectId);
      }
      db.prepare(
        `INSERT INTO path_aliases (workspace_id, version_id, path, object_id)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(workspace_id, version_id, path) DO UPDATE SET object_id = excluded.object_id`,
      ).run(workspaceId, payload.versionId, snapshot.path, payload.objectId);
      insertOrReplaceSnapshot(db, "snapshots", workspaceId, payload.versionId, snapshot);
      upsertFileSearchIndex({ db, rootDir, workspaceId, snapshot });
      return 0;
    }

    db.prepare(
      "INSERT OR IGNORE INTO file_objects (workspace_id, object_id, created_at_ms) VALUES (?, ?, ?)",
    ).run(workspaceId, payload.objectId, payload.objectCreatedAtMs ?? payload.recordedAtMs);
    insertMomentRow(db, moment, { recordOnly: true });
    const currentSnapshot = localSnapshot ?? conflictingPathOccupant;
    const current = currentSnapshot
      ? fileStateFromSnapshot(currentSnapshot.path, currentSnapshot)
      : ({
          exists: false,
          path: payload.beforePath ?? payload.payloadBeforePath ?? payload.path,
        } satisfies VersionedTextFileState);
    const incomingIsBinary = (payload.payloadAfterContentKind ?? "text") === "binary";
    const incoming: VersionedTextFileState =
      payload.operation === "delete"
        ? { exists: false, path: payload.payloadAfterPath }
        : {
            exists: true,
            path: payload.payloadAfterPath,
            objectId: payload.objectId,
            ...(incomingIsBinary
              ? {
                  contentKind: "binary" as const,
                  sha256: payload.payloadAfterBlobSha256,
                  byteLength:
                    payload.payloadAfterByteLength ??
                    readBinaryBlobFromDb(db, payload.payloadAfterBlobSha256).byteLength,
                  text: "",
                }
              : { text: requireBlobText(db, payload.payloadAfterBlobSha256) }),
            updatedAtMs: payload.recordedAtMs,
            latestMomentId: payload.momentId,
            metadata: pickWriteMetadata(payload.metadata),
          };
    // Deterministic id keyed on the shared fork point AND the two branch roots
    // (item 1) + branch-specific coalescing (item 2): both machines mint the
    // SAME id for the same pairwise divergence, DIFFERENT pairwise divergences
    // on one object get DIFFERENT ids, and repeated divergent ops in one
    // episode update the existing row instead of stacking. The incoming branch
    // root is THIS op's own moment id when the row first opens (the first
    // divergent op each side sees, per-origin FIFO); the local branch root is
    // this machine's own first divergent op after the shared fork point.
    const baseMomentId = payload.beforeLatestMomentId ?? null;
    const conflictId = syncConflictId(
      workspaceId,
      payload.versionId,
      payload.objectId,
      baseMomentId,
      {
        local: localBranchRoot(
          db,
          workspaceId,
          payload.versionId,
          payload.objectId,
          baseMomentId,
        ),
        incoming: payload.momentId,
      },
    );
    let conflictsOpened = openOrCoalesceSyncConflict(db, workspaceId, {
      versionId: payload.versionId,
      coalesce: {
        kind: "same-object",
        divergingObjectId: payload.objectId,
        incomingBranchBase: baseMomentId,
      },
      conflictId,
      path: current.path,
      base: fileStateFromAppendBefore(db, payload),
      current,
      incoming,
      recordedAtMs: payload.recordedAtMs,
    });
    // Destination occupancy is modeled EXPLICITLY: when the diverged object's
    // incoming path is occupied by a DIFFERENT local object, that occupant
    // gets its own path-occupancy conflict. Applying the incoming move later
    // requires the occupant to be handled first — nothing is silently written
    // elsewhere and the occupant is never silently clobbered.
    if (localSnapshot && conflictingPathOccupant) {
      // The occupant lineage never shared a moment with the incoming object,
      // so the fork point is the occupant's own head — a stable, deterministic
      // base that keeps repeated incoming ops coalescing onto one occupancy
      // row instead of stacking (item 2). Occupancy is inherently asymmetric
      // (only one machine holds the displaced occupant), so cross-machine id
      // symmetry does not apply here; the resolve path falls back to the
      // head-match for these (item 1's documented fallback). The incoming
      // mover's branch root still folds into the id so two DIFFERENT movers
      // displacing the SAME occupant get DISTINCT occupancy rows, not a
      // colliding id.
      const occupancyConflictId = syncConflictId(
        workspaceId,
        payload.versionId,
        conflictingPathOccupant.objectId,
        conflictingPathOccupant.latestMomentId ?? null,
        {
          local: conflictingPathOccupant.latestMomentId ?? null,
          incoming: payload.momentId,
        },
      );
      conflictsOpened += openOrCoalesceSyncConflict(db, workspaceId, {
        versionId: payload.versionId,
        coalesce: {
          kind: "occupancy",
          occupantObjectId: conflictingPathOccupant.objectId,
          // Coalesce on the INCOMING (mover) branch chain, not the occupant's
          // stable head: a repeated move by the same mover has
          // beforeLatestMomentId == the mover head already recorded on this
          // occupancy row's incoming side, so it extends this row instead of
          // stacking; a DIFFERENT mover has a different base and opens its own.
          incomingBranchBase: baseMomentId,
        },
        conflictId: occupancyConflictId,
        path: conflictingPathOccupant.path,
        // No shared base: the occupant and the incoming object never had a
        // common state at this path.
        base: { exists: false, path: conflictingPathOccupant.path },
        current: fileStateFromSnapshot(conflictingPathOccupant.path, conflictingPathOccupant),
        incoming,
        recordedAtMs: payload.recordedAtMs,
      });
    }
    return conflictsOpened;
  }

  // Applies the INCOMING side of a mirrored sync conflict when the peer's
  // conflict.resolve says the peer kept its own copy (0P-C). Returns false —
  // touching NOTHING — whenever the row no longer matches live state (the
  // file moved on locally, a destination is occupied, or a binary blob is
  // missing); the caller then leaves the conflict open and surfaces the op
  // for local review instead of clobbering newer local work.
  function applyMirroredIncomingState(
    db: SqliteDb,
    workspaceId: WorkspaceId,
    conflict: VersionedTextConflictRecord,
  ): boolean {
    const incoming = conflict.incoming;
    // Divergent-move refusal comes FIRST — before ANY equality shortcut
    // (0P-C gate fix). When the incoming side lives at a DIFFERENT path,
    // "same bytes" is not convergence: closing the conflict would leave the
    // two machines holding the file at different paths forever with no open
    // conflict anywhere. Applying here would also change a path the pull's
    // materialization diff never inspects, leaving disk stale. Surfacing for
    // local review is the honest move.
    if (incoming.exists && incoming.path !== conflict.path) return false;
    const live = fileStateFromSnapshot(
      conflict.path,
      selectSnapshotByPath(db, workspaceId, conflict.targetVersionId, conflict.path),
    );
    // Exact live-state guard (0P-C gate fix): the conflict row must describe
    // the CURRENT head — same path, object id, latest moment id, content
    // kind, and bytes. Byte-equality alone is not enough: a lineage that
    // moved on after the conflict opened (even with bytes later reverted) or
    // a different object now occupying the path is newer local work and must
    // never be overwritten.
    if (!liveStateMatchesConflictCurrent(live, conflict.current)) return false;
    // Auto-close WITHOUT writing only on FULL convergence: same path
    // (guaranteed above) and identical live content on both sides.
    if (fileStatesEqual(conflict.current, conflict.incoming)) return true;
    const metadata: ActorNeutralWriteMetadata = {
      origin: "sync",
      summary: "Applied the copy chosen on another machine",
    };
    if (!incoming.exists) {
      if (conflict.current.exists) {
        deleteTextFileInDb({
          db,
          workspaceId,
          versionId: conflict.targetVersionId,
          path: conflict.path,
          metadata,
        });
      }
      return true;
    }
    if (isBinaryState(incoming)) {
      const sha = incoming.sha256 ?? "";
      if (!sha || !db.prepare("SELECT 1 FROM binary_blobs WHERE sha256 = ?").get(sha)) {
        return false;
      }
      writeBinaryFileInDb({
        db,
        workspaceId,
        versionId: conflict.targetVersionId,
        path: conflict.path,
        bytes: readBinaryBlobFromDb(db, sha),
        metadata,
      });
      return true;
    }
    writeTextFileInDb({
      db,
      workspaceId,
      versionId: conflict.targetVersionId,
      path: conflict.path,
      text: incoming.text ?? "",
      metadata,
    });
    return true;
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
          // The rebuild validates chat thread ownership with the same
          // fail-closed posture as every other persisted-row read here.
          corrupt: (cause?: unknown) => {
            const error = new VersionedTextStoreError(
              "state-corrupt",
              "Versioned text store is corrupt.",
            );
            if (cause !== undefined) {
              (error as Error & { cause?: unknown }).cause = cause;
            }
            return error;
          },
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
        // Materialized-head semantics: a record-only sync divergence row may
        // hold the highest moment_order, but it never touched this version's
        // snapshots, so it must never become the fork point.
        const latestMoment = txDb
          .prepare(
            `SELECT moment_id FROM moments
             WHERE workspace_id = ? AND version_id = ?
               AND (sync_record_only IS NULL OR sync_record_only = 0)
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
              workspace_id, version_id, object_id, path, content_kind, blob_sha256, updated_at_ms,
              latest_moment_id, metadata_origin, metadata_summary, metadata_correlation_id
            )
            SELECT workspace_id, ?, object_id, path, content_kind, blob_sha256, updated_at_ms,
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
              workspace_id, version_id, object_id, path, content_kind, blob_sha256, updated_at_ms,
              latest_moment_id, metadata_origin, metadata_summary, metadata_correlation_id
            )
            SELECT workspace_id, ?, object_id, path, content_kind, blob_sha256, updated_at_ms,
                   latest_moment_id, metadata_origin, metadata_summary, metadata_correlation_id
            FROM snapshots
            WHERE workspace_id = ? AND version_id = ?`,
          )
          .run(id, workspaceId, source.id);
        // Ship the fork-point state in the payload: the source version's
        // snapshots AS OF this creation ARE the fork base, and importers must
        // replay from them — their own current snapshots may contain edits
        // this origin never saw.
        const forkSnapshots = txDb
          .prepare(
            `SELECT s.object_id, s.path, s.content_kind, s.blob_sha256, s.updated_at_ms,
                    s.latest_moment_id, s.metadata_origin, s.metadata_summary,
                    s.metadata_correlation_id,
                    COALESCE(b.byte_length, bb.byte_length) AS byte_length,
                    o.created_at_ms AS object_created_at_ms
             FROM snapshots s
             JOIN file_objects o
               ON o.workspace_id = s.workspace_id
              AND o.object_id = s.object_id
             LEFT JOIN blobs b
               ON b.sha256 = s.blob_sha256
              AND COALESCE(s.content_kind, 'text') = 'text'
             LEFT JOIN binary_blobs bb
               ON bb.sha256 = s.blob_sha256
              AND COALESCE(s.content_kind, 'text') = 'binary'
             WHERE s.workspace_id = ? AND s.version_id = ?
             ORDER BY s.path`,
          )
          .all(workspaceId, source.id)
          .map(
            (row): VersionCreateForkSnapshot => ({
              objectId: rowString(row, "object_id"),
              objectCreatedAtMs: rowNumber(row, "object_created_at_ms"),
              path: rowString(row, "path"),
              ...(rowContentKind(row, "content_kind") === "binary"
                ? { contentKind: "binary" as const }
                : {}),
              blobSha256: rowString(row, "blob_sha256"),
              byteLength: rowNumber(row, "byte_length"),
              updatedAtMs: rowNumber(row, "updated_at_ms"),
              latestMomentId: rowString(row, "latest_moment_id"),
              metadata: metadataFromRow(row),
            }),
          );
        journalLocalReplicationOp(txDb, {
          workspaceId,
          opKind: "version.create",
          payload: {
            versionId: version.id,
            name: version.name,
            kind: version.kind,
            forkVersionId: version.forkPoint?.versionId,
            forkMomentId: version.forkPoint?.momentId,
            createdAtMs: version.createdAtMs,
            forkSnapshots,
          } satisfies VersionCreatePayload,
          recordedAtMs: version.createdAtMs,
        });
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
                    m.payload_after_content_kind AS content_kind,
                    binary_after.byte_length AS binary_byte_length,
                    m.moment_order, m.sync_record_only
             FROM moments m
             LEFT JOIN binary_blobs binary_after
               ON binary_after.sha256 = m.payload_after_blob_sha256
              AND COALESCE(m.payload_after_content_kind, 'text') = 'binary'
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
            contentKind: rowContentKind(row, "content_kind"),
            ...(rowContentKind(row, "content_kind") === "binary"
              ? { byteLength: rowNumber(row, "binary_byte_length") }
              : {}),
            metadata: metadataFromRow(row),
            ...(author !== undefined ? { author } : {}),
            momentOrder: rowNumber(row, "moment_order"),
            // Divergent peer history stays VISIBLE on the timeline but is
            // explicitly marked so the UI can render it as inert.
            ...(Number(row.sync_record_only ?? 0) === 1 ? { syncRecordOnly: true } : {}),
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
        if (!row) return null;
        const moment = cloneMoment(momentFromRow(row));
        // Same marker as listMoments: divergent peer history reads back
        // explicitly flagged, never as ordinary applied history.
        return Number(row.sync_record_only ?? 0) === 1
          ? { ...moment, syncRecordOnly: true }
          : moment;
      });
    },

    applyReplicationOp(input): Promise<SyncApplyResult> {
      return serialize(async () => {
        assertInputEnvelope(input);
        const workspaceId = normalizeWorkspaceId(input.workspaceId);
        if (input.workspaceId !== workspaceId || input.workspaceId !== input.workspaceId.trim()) {
          throw new VersionedTextStoreError("invalid-workspace", "Workspace id is required.");
        }
        if (
          typeof input.originId !== "string" ||
          !input.originId ||
          !Number.isInteger(input.originSeq) ||
          input.originSeq < 0 ||
          typeof input.recordedAtMs !== "number" ||
          !Number.isFinite(input.recordedAtMs)
        ) {
          throw new VersionedTextStoreError("invalid-input", "Replication envelope is invalid.");
        }
        const txDb = db();
        const ackedSeq = readReplicationAckedSeq(txDb, workspaceId, input.originId);
        if (input.originSeq <= ackedSeq) return skippedApplyResult();
        if (importedReplicationLogExists(txDb, input)) {
          ackReplicationPeer(txDb, workspaceId, input.originId, input.originSeq);
          return skippedApplyResult();
        }
        if (input.originSeq !== ackedSeq + 1) {
          throw new VersionedTextStoreError(
            "state-corrupt",
            `Replication origin ${input.originId} has a gap before sequence ${input.originSeq}.`,
          );
        }

        let conflictsOpened = 0;
        const pendingResolves: PendingConflictResolve[] = [];
        switch (input.opKind) {
          case "workspace.init":
            ensureWorkspaceRow(txDb, workspaceId, input.recordedAtMs, { journal: false });
            break;
          case "moment.append":
            conflictsOpened = applyRemoteMomentAppend(txDb, workspaceId, input.payload);
            break;
          case "version.create":
            insertVersionFromReplication(txDb, workspaceId, input.payload);
            break;
          case "conflict.open": {
            const conflict = input.payload;
            if (
              !txDb
                .prepare("SELECT 1 FROM conflicts WHERE workspace_id = ? AND conflict_id = ?")
                .get(workspaceId, conflict.id)
            ) {
              insertConflictRow(txDb, conflict);
              conflictsOpened = 1;
            }
            break;
          }
          case "conflict.resolve": {
            const payload = input.payload;
            // Apply a peer's resolution to the LOCAL mirror of a sync conflict:
            // flip the choice/resolution (current/incoming are swapped between
            // the two machines) and, when the peer kept its own copy (which is
            // our "incoming"), adopt that state so the machines never disagree
            // forever with no open conflict anywhere. Guarded by
            // applyMirroredIncomingState — a lineage that moved on locally is
            // NEVER clobbered; it returns false and the op is surfaced.
            const applyMirroredResolve = (
              mirror: VersionedTextConflictRecord,
            ): boolean => {
              const mirroredChosenFrom =
                payload.chosenFrom === "current"
                  ? "incoming"
                  : payload.chosenFrom === "incoming"
                    ? "current"
                    : "merged";
              const mirroredResolution =
                payload.resolution === "applied-incoming"
                  ? "kept-current"
                  : payload.resolution === "kept-current"
                    ? "applied-incoming"
                    : payload.resolution;
              // A merged resolution (apply-merged) does NOT replicate its
              // merged bytes in the resolve payload, so this mirror has nothing
              // to apply. Marking it resolved anyway would leave the two
              // machines holding DIFFERENT text with no open conflict anywhere
              // (silent divergence). Surface it for local review instead.
              if (mirroredResolution === "applied-merged") return false;
              const applied =
                mirroredResolution === "applied-incoming"
                  ? applyMirroredIncomingState(txDb, workspaceId, mirror)
                  : true;
              if (!applied) return false;
              txDb
                .prepare(
                  `UPDATE conflicts
                   SET status = ?, chosen_from = ?, resolution = ?, updated_at_ms = ?
                   WHERE workspace_id = ? AND conflict_id = ?`,
                )
                .run(
                  payload.status,
                  mirroredChosenFrom,
                  mirroredResolution,
                  payload.updatedAtMs,
                  workspaceId,
                  mirror.id,
                );
              return true;
            };

            // Item 1: sync divergence conflicts now carry a DETERMINISTIC,
            // machine-independent id, so both machines share it and a resolve
            // closes the mirror BY ID — robust across coalesced incoming heads
            // and divergent moves that the swapped-head lookup would miss. The
            // row's shape decides how to apply it.
            const localRow = txDb
              .prepare(
                conflictSelectSql("WHERE c.workspace_id = ? AND c.conflict_id = ?"),
              )
              .get(workspaceId, payload.conflictId);
            const local = localRow ? conflictFromRow(localRow) : undefined;
            if (local && local.status !== "open") {
              // Already resolved locally or by an earlier pass — idempotent.
            } else if (local && local.metadata.origin === "sync") {
              // Sync conflicts are minted independently per side with
              // current/incoming SWAPPED, so a same-id match IS the mirror.
              if (!applyMirroredResolve(local)) {
                pendingResolves.push({
                  remoteConflictId: payload.conflictId,
                  localConflictId: local.id,
                  path: local.path,
                });
              }
            } else if (local) {
              // Merge conflicts replicate verbatim via conflict.open (same id,
              // same sides on both machines): apply the resolution as-is.
              txDb
                .prepare(
                  `UPDATE conflicts
                   SET status = ?, chosen_from = ?, resolution = ?, updated_at_ms = ?
                   WHERE workspace_id = ? AND conflict_id = ?`,
                )
                .run(
                  payload.status,
                  payload.chosenFrom,
                  payload.resolution,
                  payload.updatedAtMs,
                  workspaceId,
                  payload.conflictId,
                );
            } else {
              // No id match: fall back to the swapped-head mirror lookup for
              // conflicts whose ids genuinely cannot align — occupancy
              // conflicts (inherently asymmetric) and pre-deterministic legacy
              // rows.
              const mirrorRow =
                payload.targetVersionId !== undefined
                  ? txDb
                      .prepare(
                        conflictSelectSql(
                          `WHERE c.workspace_id = ? AND c.status = 'open'
                             AND c.target_version_id = ?
                             AND c.current_latest_moment_id IS ?
                             AND c.incoming_latest_moment_id IS ?
                           ORDER BY c.created_at_ms, c.conflict_id
                           LIMIT 1`,
                        ),
                      )
                      .get(
                        workspaceId,
                        payload.targetVersionId,
                        payload.incomingLatestMomentId ?? null,
                        payload.currentLatestMomentId ?? null,
                      )
                  : undefined;
              const mirror = mirrorRow ? conflictFromRow(mirrorRow) : undefined;
              if (mirror) {
                if (!applyMirroredResolve(mirror)) {
                  pendingResolves.push({
                    remoteConflictId: payload.conflictId,
                    localConflictId: mirror.id,
                    path: mirror.path,
                  });
                }
              } else {
                // No local match at all: journal + ack the op (idempotency and
                // ordering must hold) but surface it — a peer's resolution is
                // never silently swallowed.
                pendingResolves.push({
                  remoteConflictId: payload.conflictId,
                  localConflictId: null,
                  path: payload.path ?? null,
                });
              }
            }
            break;
          }
          case "ydoc.update": {
            // Commutative CRDT apply — no head check, no conflict row (Yjs
            // converges). Append + advance the head, then MATERIALIZE the
            // re-projected markdown as a LOCAL, non-journaling settle so
            // file/search/history stay coherent WITHOUT double-replicating the
            // content (the ydoc.update stream is this object's sole channel).
            const projection = projectYDocUpdate(txDb, workspaceId, input.payload);
            // Materialize the projection FIRST — this creates/updates the
            // file_object that ydoc_docs' FK requires — then persist the CRDT
            // rows. The write is non-journaling (ydoc.update is the sole channel).
            writeTextFileInDb({
              db: txDb,
              workspaceId,
              versionId: input.payload.versionId,
              path: input.payload.path,
              text: projection.markdown,
              metadata: { origin: "sync" },
              suppressReplicationJournal: true,
              objectId: input.payload.objectId,
            });
            persistYDocUpdate(
              txDb,
              workspaceId,
              input.payload,
              projection.doc,
              input.originId,
              input.recordedAtMs,
            );
            // LIVE-SESSION CONVERGENCE (fix 3 — never drop a remote edit on
            // close): if this object is OPEN in a Y.Doc session, the persisted
            // rows + re-projected file above are not enough — the live in-memory
            // doc would stay stale and, on close, settle OVER this projection and
            // (formerly) prune the newer CRDT, silently losing the remote edit.
            // Route the update straight into the live doc so it converges now;
            // Y.applyUpdate is commutative + idempotent, so the eventual close
            // settles the CONVERGED state. No live doc (closed object) => the
            // next open resumes the persisted rows, so nothing is lost either.
            {
              const liveDoc = getLiveYDoc(
                liveYDocKey(stateFilePath, workspaceId, input.payload.objectId),
              );
              // Apply under the RESERVED remote-apply origin (G2-C-2 handoff): a
              // future editor provider observing doc.on("update") MUST ignore
              // updates carrying REMOTE_YDOC_APPLY_ORIGIN so it never re-journals
              // a remote op back to every peer (echo storm). See liveYDocRegistry.
              if (liveDoc) Y.applyUpdate(liveDoc, projection.update, REMOTE_YDOC_APPLY_ORIGIN);
            }
            break;
          }
          case "version.rename":
          case "chat.channel.create":
          case "chat.thread.create":
          case "chat.thread.update":
          case "chat.message.append":
            throw new VersionedTextStoreError(
              "invalid-input",
              `Text store cannot apply replication op ${input.opKind}.`,
            );
          default:
            throw new VersionedTextStoreError("invalid-input", "Replication op kind is invalid.");
        }
        journalImportedReplicationOp(txDb, input);
        ackReplicationPeer(txDb, workspaceId, input.originId, input.originSeq);
        await persistBarrier();
        return appliedApplyResult(conflictsOpened, pendingResolves);
      });
    },

    // WS-G2-B engine write lane: the Y.Doc driver's writes share THIS store's
    // connection + serialized queue + single BEGIN IMMEDIATE, so a settle and a
    // Y.Doc update-append can never open two concurrent in-process write
    // transactions (node:sqlite busy-waits block the JS thread). The task runs
    // inside runTransaction — it must not BEGIN/COMMIT itself; a throw rolls the
    // lane transaction back.
    runInEngineWriteLane(task) {
      return serialize(async () => {
        // Guard ONLY the SYNCHRONOUS execution of the task, not an await gap.
        // A reentrant store write deadlocks by calling serialize synchronously
        // from within the task body (the lane contract is SQL-only + synchronous
        // on the passed connection), and JS can't interleave another async
        // continuation into a synchronous span — so a flag set/cleared around
        // the synchronous `task(db())` call catches real reentry with zero false
        // positives. Holding the flag across `await` instead would leak it into
        // unrelated continuations that run during the suspension (a concurrent
        // lane task's own await), flagging innocent serialize calls.
        const conn = db();
        let result: ReturnType<typeof task>;
        inEngineWriteLane = true;
        try {
          result = task(conn);
        } finally {
          inEngineWriteLane = false;
        }
        return await result;
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

    // WS-G2-C1: settle a Y.Doc projection WITHOUT journaling a moment.append op
    // (identical to writeTextFile otherwise). The Y.Doc driver uses this for
    // every rich-doc settle: the object replicates only through ydoc.update ops,
    // so its markdown must never independently ride the log and collide two
    // peers' settles into a P0D conflict.
    writeProjectedTextFile(input) {
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
          suppressReplicationJournal: true,
        });
        await persistBarrier();
        return result;
      });
    },

    writeBinaryFile(input) {
      return serialize(async () => {
        assertInputEnvelope(input);
        const workspaceId = normalizeWorkspaceId(input.workspaceId);
        const versionId = normalizeVersionId(input.versionId);
        const path = normalizePlaintextStorablePath(input.path);
        const bytes = normalizeWriteBinaryBytes(input.bytes);
        const metadata = normalizeWriteMetadata(input.metadata);
        const author = normalizeMomentAuthor(input.author);
        await beforeWriteMutation();
        const result = writeBinaryFileInDb({
          db: db(),
          workspaceId,
          versionId,
          path,
          bytes,
          metadata,
          ...(author !== undefined ? { author } : {}),
          momentId: input.momentId,
        });
        await persistBarrier();
        return result;
      });
    },

    readBinaryFile(input) {
      return afterWrites(async () => {
        assertInputEnvelope(input);
        const workspaceId = normalizeWorkspaceId(input.workspaceId);
        const versionId = normalizeVersionId(input.versionId);
        const path = normalizeWritePath(input.path);
        requireWorkspaceVersionRow(db(), workspaceId, versionId);
        const snapshot = selectSnapshotByPath(db(), workspaceId, versionId, path);
        if (!snapshot || !isBinarySnapshot(snapshot) || !snapshot.sha256) return null;
        const row = db()
          .prepare("SELECT content FROM binary_blobs WHERE sha256 = ?")
          .get(snapshot.sha256);
        return row ? rowBuffer(row, "content") : null;
      });
    },

    readBinaryBlob(input) {
      return afterWrites(async () => {
        assertInputEnvelope(input);
        normalizeWorkspaceId(input.workspaceId);
        assertPersistedNormalizedString(input.sha256);
        const row = db()
          .prepare("SELECT content FROM binary_blobs WHERE sha256 = ?")
          .get(input.sha256);
        return row ? rowBuffer(row, "content") : null;
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
            const write = isBinaryState(comparison.incoming)
              ? writeBinaryFileInDb({
                  db: txDb,
                  workspaceId,
                  versionId: targetVersionId,
                  path,
                  bytes: readBinaryBlobFromDb(txDb, comparison.incoming.sha256 ?? ""),
                  metadata,
                })
              : writeTextFileInDb({
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
          comparison.incoming.exists &&
          !isBinaryState(comparison.base) &&
          !isBinaryState(comparison.current) &&
          !isBinaryState(comparison.incoming)
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
        // Exact head check (0P sync-hardening item 3 gate fix): byte-equality
        // alone (fileStatesEqual) ignores object identity, path, and latest
        // moment id, so a file that moved on and reverted to the SAME bytes, or
        // a DIFFERENT object now sitting at this path with identical bytes,
        // would pass and let this resolve of the OLD conflict delete/overwrite
        // the newer local work. Require the live head to be the precise state
        // the conflict row recorded before acting on it.
        if (!liveStateMatchesConflictCurrent(current, conflict.current)) {
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
            const destinationPath = conflict.incoming.path;
            if (destinationPath !== conflict.path) {
              // Divergent MOVE: applying the incoming side lands at the
              // incoming path — never a silent write back at the local path.
              // A destination occupied by another object must be handled
              // first (it has its own path-occupancy conflict from import):
              // fail closed instead of clobbering the occupant.
              const occupant = selectSnapshotByPath(
                txDb,
                workspaceId,
                conflict.targetVersionId,
                destinationPath,
              );
              if (occupant) {
                throw new VersionedTextStoreError(
                  "target-path-exists",
                  `File ${destinationPath} already exists; resolve its path-occupancy conflict before applying this incoming state.`,
                );
              }
              if (conflict.current.exists) {
                deletion = deleteTextFileInDb({
                  db: txDb,
                  workspaceId,
                  versionId: conflict.targetVersionId,
                  path: conflict.path,
                  metadata,
                });
              }
            }
            write = isBinaryState(conflict.incoming)
              ? writeBinaryFileInDb({
                  db: txDb,
                  workspaceId,
                  versionId: conflict.targetVersionId,
                  path: destinationPath,
                  bytes: readBinaryBlobFromDb(txDb, conflict.incoming.sha256 ?? ""),
                  metadata,
                })
              : writeTextFileInDb({
                  db: txDb,
                  workspaceId,
                  versionId: conflict.targetVersionId,
                  path: destinationPath,
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
          if (
            isBinaryState(conflict.base) ||
            isBinaryState(conflict.current) ||
            isBinaryState(conflict.incoming)
          ) {
            throw new VersionedTextStoreError(
              "invalid-input",
              "Binary conflicts cannot be resolved with combined text.",
            );
          }
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
        journalLocalReplicationOp(txDb, {
          workspaceId,
          opKind: "conflict.resolve",
          payload: {
            conflictId: conflict.id,
            status: conflict.status,
            chosenFrom: conflict.chosenFrom,
            resolution: conflict.resolution,
            updatedAtMs: conflict.updatedAtMs,
            // Matching context for peers whose MIRROR of this conflict has a
            // different local id (sync divergence conflicts are minted
            // independently per side): the peer matches its open conflict by
            // swapped current/incoming heads.
            targetVersionId: conflict.targetVersionId,
            path: conflict.path,
            ...(conflict.current.latestMomentId !== undefined
              ? { currentLatestMomentId: conflict.current.latestMomentId }
              : {}),
            ...(conflict.incoming.latestMomentId !== undefined
              ? { incomingLatestMomentId: conflict.incoming.latestMomentId }
              : {}),
          } satisfies ConflictResolvePayload,
          recordedAtMs: conflict.updatedAtMs,
        });
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
            snapshotSelectSql(
              "snapshots",
              `WHERE s.workspace_id = ? AND s.version_id = ?
               ORDER BY s.path`,
            ),
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
            before: payloadFromSnapshot(before),
            after: { ...payloadFromSnapshot(before), path: toPath },
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
        journalLocalReplicationOp(txDb, {
          workspaceId,
          opKind: "moment.append",
          payload: momentAppendPayload({
            db: txDb,
            moment,
            objectCreatedAtMs: object.createdAtMs,
          }),
          recordedAtMs: moment.recordedAtMs,
        });
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
        if (Number(momentRow.sync_record_only ?? 0) === 1) {
          // A record-only row is a PEER's divergent history: its preimage
          // describes the peer's fork-point state, not this store's lineage.
          // Rolling it back would rewrite/delete the LOCAL live snapshot from
          // a state this store never materialized.
          throw new VersionedTextStoreError(
            "invalid-input",
            `Moment ${mutationMomentId} is a sync record-only divergence record and cannot be rolled back.`,
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
                 AND (sync_record_only IS NULL OR sync_record_only = 0)
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
