/**
 * Engine contract rename mapping
 *
 * Type-only extraction for this slice; zod schema mirrors are a follow-up
 * if/when contracts need runtime validation here.
 *
 * | Plan / matrix symbol | Shipped engine contract symbol | Status | Notes |
 * | --- | --- | --- | --- |
 * | WorkspaceObject | FileObjectRecord | adopted | Shape differs from the plan matrix; this is the engine's real shipped record. |
 * | WorkspaceVersion | VersionRecord + VersionKind | adopted | Version kind remains a separate union. |
 * | HistoryMoment | VersionedTextMoment + VersionedTextMomentSummary | adopted | Full moment payload and summary/list row are separate shapes. |
 * | ConflictRecord | VersionedTextConflictRecord | adopted | Uses the engine's shipped text-conflict record. |
 * | ChatThread | ChatThread | adopted | Name unchanged. |
 * | ThreadMessage | ChatMessage | renamed | Engine ships messages under the chat-specific name. |
 * | WorkspaceLinkRef | LinkedChatFileRef | partial | Only the chat-file link case is implemented; a general link-ref vocabulary is not implemented. |
 * | VersionRef | Not implemented | not implemented | The engine currently uses plain version ids (VersionId) plus ad hoc fork-related fields where needed. |
 * | Phase0EffectivePolicyInput / Phase0EffectivePolicyResult | resolveEffectivePolicy + EffectivePolicyResult (from @dohc/workspace-engine) | partial | Covers path/file policy plus search/capture ownership only; actor permissions, sharing, chat-export, and object-family inputs are not implemented yet. |
 * | WorkspaceEvent / DurabilityEvent | Not implemented | not implemented | The engine coalesces writes directly into moments (VersionedTextMoment) instead of emitting a separate durability/event log. |
 *
 * Ownership notes:
 * - ChangeAuthor and NonEmptyLocalAuthorLabel are canonically owned here;
 *   @dohc/workspace-core re-exports them (it depends on this package), which
 *   keeps the branded local-author label one nominal type everywhere.
 * - The Engine*-prefixed private types at the bottom are structural copies of
 *   @dohc/workspace-core / @dohc/workspace-history shapes that this package
 *   cannot import without a dependency cycle. They are pinned to the real
 *   types by exact-identity compile checks in
 *   packages/workspace-engine/src/engineContracts.compile.ts, so drift fails
 *   the engine typecheck.
 */

export type WorkspaceObjectId = string;
export type VersionId = string;
export type WorkspaceId = string;
export type VersionedTextMomentId = string;
export type VersionedTextConflictId = string;

export type VersionedTextStoreErrorCode =
  | "conflict-not-found"
  | "conflict-stale-target"
  | "duplicate-id"
  | "file-not-found"
  | "fork-base-not-found"
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

// Optional authorship carried by a MOMENT (never by snapshot metadata, which
// stays actor-neutral). Mirrors the agent variant of ChangeAuthor plus the
// locally meaningful agent-run id (the .dohc/agent-runs.json record). Only
// dohc-TRACKED agent runs stamp this; ordinary edits, reconciliation, and raw
// external agent CLIs remain actor-neutral — an absent author is the honest
// default, not a fallback.
export interface AgentMomentAuthor {
  kind: "agent";
  agentId: string;
  onBehalfOf: string;
  agentRunId?: string;
}

export type MomentAuthor = AgentMomentAuthor;

export interface TextFileSnapshot {
  objectId: WorkspaceObjectId;
  versionId: VersionId;
  path: string;
  text: string;
  updatedAtMs: number;
  latestMomentId: VersionedTextMomentId;
  metadata: ActorNeutralWriteMetadata;
}

export interface VersionedTextFileState {
  exists: boolean;
  path: string;
  objectId?: WorkspaceObjectId;
  text?: string;
  updatedAtMs?: number;
  latestMomentId?: VersionedTextMomentId;
  metadata?: ActorNeutralWriteMetadata;
}

export type VersionedTextComparisonStatus =
  | "same"
  | "incoming-changed"
  | "current-changed"
  | "diverged";

export interface VersionedTextComparison {
  workspaceId: WorkspaceId;
  path: string;
  targetVersionId: VersionId;
  sourceVersionId: VersionId;
  base: VersionedTextFileState;
  current: VersionedTextFileState;
  incoming: VersionedTextFileState;
  status: VersionedTextComparisonStatus;
}

export type VersionedTextConflictStatus = "open" | "resolved";
export type VersionedTextConflictResolution =
  | "applied-incoming"
  | "applied-merged"
  | "kept-current";
export type VersionedTextConflictChoice = "current" | "incoming" | "merged";

export interface VersionedTextConflictRecord {
  id: VersionedTextConflictId;
  workspaceId: WorkspaceId;
  path: string;
  targetVersionId: VersionId;
  sourceVersionId: VersionId;
  createdAtMs: number;
  updatedAtMs: number;
  base: VersionedTextFileState;
  current: VersionedTextFileState;
  incoming: VersionedTextFileState;
  status: VersionedTextConflictStatus;
  chosenFrom: VersionedTextConflictChoice;
  metadata: ActorNeutralWriteMetadata;
  resolution?: VersionedTextConflictResolution;
}

export type VersionedTextMergeResult =
  | {
      kind: "unchanged";
      reason: "already-same" | "source-unchanged";
      comparison: VersionedTextComparison;
    }
  | {
      kind: "merged";
      operation: "write";
      comparison: VersionedTextComparison;
      write: VersionedTextWriteResult;
    }
  | {
      kind: "merged";
      operation: "delete";
      comparison: VersionedTextComparison;
      delete: VersionedTextDeleteResult;
    }
  | {
      kind: "conflict";
      comparison: VersionedTextComparison;
      conflict: VersionedTextConflictRecord;
    };

export type VersionedTextConflictResolveResult =
  | {
      kind: "resolved";
      conflict: VersionedTextConflictRecord;
      write?: VersionedTextWriteResult;
      delete?: VersionedTextDeleteResult;
    };

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
  // Present only when a dohc-tracked agent run authored this moment.
  author?: MomentAuthor;
  before?: TextFileSnapshot | null;
}

// Timeline row (PR 0M-5 history flip): everything the history list needs
// without hauling snapshot text bodies. momentOrder is the workspace-global
// recording order — the keyset-pagination cursor and a monotonic refresh key.
export interface VersionedTextMomentSummary {
  id: VersionedTextMomentId;
  workspaceId: WorkspaceId;
  versionId: VersionId;
  objectId: WorkspaceObjectId;
  path: string;
  recordedAtMs: number;
  operation: "write" | "rename" | "delete";
  metadata: ActorNeutralWriteMetadata;
  // Present only when a dohc-tracked agent run authored this moment.
  author?: MomentAuthor;
  momentOrder: number;
}

export interface VersionedTextMomentPage {
  // Newest first (descending momentOrder).
  moments: VersionedTextMomentSummary[];
  // Pass back as beforeMomentOrder to fetch the next (older) page; null when
  // this page reached the beginning of the timeline.
  nextBeforeMomentOrder: number | null;
  // The workspace's newest moment order for the given filter (-1 when empty),
  // regardless of pagination position.
  latestMomentOrder: number;
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
  // Engine-owned "which version does the workspace folder show right now".
  // Defaults to main until setActiveVersion persists a different choice; null
  // only when the workspace has never been initialized in this store.
  getActiveVersion(input: { workspaceId: WorkspaceId }): Promise<VersionRecord | null>;
  // Fails closed: an unknown or other-workspace version id throws
  // (version-not-found / workspace-mismatch) and the active version is
  // unchanged.
  setActiveVersion(input: {
    workspaceId: WorkspaceId;
    versionId: VersionId;
  }): Promise<VersionRecord>;
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
    author?: MomentAuthor;
    momentId?: VersionedTextMomentId;
  }): Promise<VersionedTextWriteResult>;
  readTextFile(input: {
    workspaceId: WorkspaceId;
    versionId: VersionId;
    path: string;
  }): Promise<TextFileSnapshot | null>;
  compareTextFileVersions(input: {
    workspaceId: WorkspaceId;
    targetVersionId: VersionId;
    sourceVersionId: VersionId;
    path: string;
  }): Promise<VersionedTextComparison>;
  mergeTextFileFromVersion(input: {
    workspaceId: WorkspaceId;
    targetVersionId: VersionId;
    sourceVersionId: VersionId;
    path: string;
    metadata: ActorNeutralWriteMetadata;
  }): Promise<VersionedTextMergeResult>;
  listTextConflicts(input: {
    workspaceId: WorkspaceId;
    status?: VersionedTextConflictStatus;
  }): Promise<VersionedTextConflictRecord[]>;
  resolveTextConflict(input: {
    workspaceId: WorkspaceId;
    conflictId: VersionedTextConflictId;
    resolution:
      | { kind: "keep-current" }
      | { kind: "apply-incoming" }
      | { kind: "apply-merged"; text: string };
    metadata: ActorNeutralWriteMetadata;
  }): Promise<VersionedTextConflictResolveResult>;
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
    author?: MomentAuthor;
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
  // Timeline reads (PR 0M-5 history flip). listMoments serves the history
  // list without payload bodies; getMoment serves the diff page with the full
  // before/after payload. Both are workspace-scoped: a moment id from another
  // workspace reads as null / absent.
  listMoments(input: {
    workspaceId: WorkspaceId;
    versionId?: VersionId;
    objectId?: WorkspaceObjectId;
    limit?: number;
    beforeMomentOrder?: number;
  }): Promise<VersionedTextMomentPage>;
  getMoment(input: {
    workspaceId: WorkspaceId;
    momentId: VersionedTextMomentId;
  }): Promise<VersionedTextMoment | null>;
  // Releases the underlying database handle after in-flight writes drain.
  // Callers that own a store (workspace teardown, app quit) must close it so
  // SQLite handles/WAL locks never outlive the workspace session.
  close(): Promise<void>;
}

export interface VersionedTextStoreOptions {
  nowMs?: () => number;
  createId?: (kind: "conflict" | "moment" | "object" | "version") => string;
  // "quick" (default) runs PRAGMA quick_check on open; "full" runs the
  // O(entire-database) PRAGMA integrity_check for diagnostics.
  integrityCheck?: "quick" | "full";
}

export type FileWorkspacePlatformMode = "linux-anchored" | "portable";

export interface FileWorkspaceCapabilityReport {
  // process.platform values as a plain literal union: this package stays
  // dependency-light, so the contract must not require @types/node ambient
  // types (NodeJS.Platform) to resolve for non-Node consumers.
  platform:
    | "aix"
    | "android"
    | "darwin"
    | "freebsd"
    | "haiku"
    | "linux"
    | "openbsd"
    | "sunos"
    | "win32"
    | "cygwin"
    | "netbsd";
  mode: FileWorkspacePlatformMode;
  atomicReplace: boolean;
  symlinkDefense: "descriptor-relative" | "o-nofollow-lstat" | "lstat-only";
  descriptorPinning: boolean;
  containmentCheck: "realpath-root-containment";
  fileFsync: boolean;
  parentDirectoryFsync: "supported" | "best-effort-noop";
  notes: readonly string[];
}

export type VersionedFileWorkspaceErrorCode =
  | "file-too-large"
  | "file-not-found"
  | "history-record-failed"
  | "invalid-input"
  | "invalid-path"
  | "invalid-restore-direction"
  | "not-text"
  | "recovery-failed"
  | "restore-file-not-found"
  | "restore-snapshot-unavailable"
  | "restore-stale-live-file"
  | "stale-live-file"
  | "unsupported-filesystem";

export interface VersionedFileStat {
  path: string;
  mediaType: string;
  sizeBytes: number;
  sha256: string;
}

export type VersionedFileReadResult = string | null;
export type VersionedFileListResult = VersionedFileStat[];

export interface VersionedFileWriteResult {
  path: string;
  versionId: VersionId;
  snapshot: TextFileSnapshot;
  history: EngineHistoryRecord;
}

export interface VersionedFileDeleteResult {
  path: string;
  versionId: VersionId;
  deleted: TextFileSnapshot | null;
  history: EngineHistoryRecord;
}

export type VersionedFileRestoreResult = (VersionedFileWriteResult | VersionedFileDeleteResult) & {
  restoredFrom: {
    changeSetId: string;
    path: string;
    direction: "before" | "after";
  };
};

export interface VersionedFileWorkspace {
  capabilities(): FileWorkspaceCapabilityReport;
  ensureMainVersion(): Promise<VersionRecord>;
  createNamedVersion(input: { name: string; fromVersionId: VersionId }): Promise<VersionRecord>;
  writeTextFile(input: {
    path: string;
    text: string;
    versionId?: VersionId;
    metadata?: ActorNeutralWriteMetadata;
    summary?: string;
    provenance?: EngineChangeProvenance;
  }): Promise<VersionedFileWriteResult>;
  deleteTextFile(input: {
    path: string;
    versionId?: VersionId;
    metadata?: ActorNeutralWriteMetadata;
    summary?: string;
    provenance?: EngineChangeProvenance;
  }): Promise<VersionedFileDeleteResult>;
  readTextFile(input: { path: string }): Promise<VersionedFileReadResult>;
  listTextFiles(): Promise<VersionedFileListResult>;
  statTextFile(input: { path: string }): Promise<VersionedFileStat | null>;
  restoreTextFile(input: {
    changeSetId: string;
    path: string;
    direction?: "before" | "after";
    versionId?: VersionId;
  }): Promise<VersionedFileRestoreResult>;
  history: VersionedFileHistoryReader;
  versions: VersionedFileVersionReader;
}

export type VersionedFileHistoryReader = Pick<
  EngineChangeSetStore,
  "get" | "list" | "listIndexed" | "listSince"
>;

export interface VersionedFileVersionReader {
  getMainVersion(): Promise<VersionRecord | null>;
  getObject(input: { objectId: WorkspaceObjectId }): Promise<FileObjectRecord | null>;
  listTextFiles(input: { versionId: VersionId }): Promise<TextFileSnapshot[]>;
  listVersions(): Promise<VersionRecord[]>;
  readTextFile(input: {
    versionId: VersionId;
    path: string;
  }): Promise<TextFileSnapshot | null>;
}

export interface VersionedFileWorkspaceOptions extends VersionedTextStoreOptions {
  rootDir: string;
  workspaceId: WorkspaceId;
  author?: ChangeAuthor;
}

export type ChatThreadId = string;
export type ChatMessageId = string;

export type LinkedChatStoreErrorCode =
  | "invalid-message-body"
  | "invalid-path"
  | "invalid-sender"
  | "invalid-thread-title"
  | "invalid-workspace"
  | "state-corrupt"
  | "thread-not-found"
  | "workspace-mismatch";

export type ChatActor =
  | { kind: "human"; displayName: string }
  | { kind: "agent"; displayName: string };

export interface LinkedChatFileRef {
  objectId: WorkspaceObjectId;
  pathHint?: string;
  linkedAtMs: number;
}

export interface ChatThread {
  id: ChatThreadId;
  workspaceId: WorkspaceId;
  title: string;
  createdAtMs: number;
  updatedAtMs: number;
  linkedFile?: LinkedChatFileRef;
}

export interface ChatMessage {
  id: ChatMessageId;
  workspaceId: WorkspaceId;
  threadId: ChatThreadId;
  author: ChatActor;
  body: string;
  createdAtMs: number;
}

export type LinkedChatProjectionFileAccess =
  | { kind: "allowed"; path: string }
  | { kind: "denied" }
  | { kind: "unknown" };

export interface LinkedChatProjection {
  path: string;
  readOnly: true;
  threadId: ChatThreadId;
  text: string;
}

export interface LinkedChatStore {
  createThread(input: {
    workspaceId: WorkspaceId;
    title: string;
    linkedFile?: { objectId: WorkspaceObjectId; pathHint?: string };
  }): Promise<ChatThread>;
  listThreads(input: { workspaceId: WorkspaceId }): Promise<ChatThread[]>;
  listThreadsForFile(input: {
    workspaceId: WorkspaceId;
    objectId: WorkspaceObjectId;
  }): Promise<ChatThread[]>;
  sendMessage(input: {
    workspaceId: WorkspaceId;
    threadId: ChatThreadId;
    author: ChatActor;
    body: string;
  }): Promise<ChatMessage>;
  listMessages(input: {
    workspaceId: WorkspaceId;
    threadId: ChatThreadId;
  }): Promise<ChatMessage[]>;
  getThreadProjection(input: {
    workspaceId: WorkspaceId;
    threadId: ChatThreadId;
    linkedFileAccess?: LinkedChatProjectionFileAccess;
  }): Promise<LinkedChatProjection>;
  // Releases the underlying database handle after in-flight writes drain.
  // Callers that own a store (workspace teardown, app quit) must close it so
  // SQLite handles/WAL locks never outlive the workspace session.
  close(): Promise<void>;
}

export interface LinkedChatStoreOptions {
  nowMs?: () => number;
  createId?: (kind: "message" | "thread") => string;
}

export type SearchSurface = "chat" | "file";

export type SearchVisibility =
  | { searchable: true; projectionFileAccess?: LinkedChatProjectionFileAccess }
  | { searchable: false; reason: "ignored" | "permission-denied" | "secret" };

export type WorkspaceSearchPolicy = {
  fileVisibility?: (file: TextFileSnapshot) => SearchVisibility;
  chatVisibility?: (thread: ChatThread) => SearchVisibility;
};

export interface WorkspaceEngineSearchResult {
  surface: SearchSurface;
  path: string;
  title: string;
  line: number;
  preview: string;
  matchStart: number;
  matchEnd: number;
  threadId?: string;
  objectId?: string;
}

export interface WorkspaceEngineSearchOptions {
  workspaceId: WorkspaceId;
  versionId: VersionId;
  query: string;
  versions: VersionedTextStore;
  chats: LinkedChatStore;
  policy?: WorkspaceSearchPolicy;
  limit?: number;
}

export type EngineFilePathClassification =
  | { kind: "tracked" }
  | { kind: "ignored" }
  | { kind: "secret" };

export type VersionFileChangeStatus = "added" | "modified" | "deleted";

export interface VersionFileChange {
  path: string;
  status: VersionFileChangeStatus;
  // Target-side text (for example Main); absent when the file was added.
  currentText?: string;
  // Source-side text (the compared version); absent when the file was deleted.
  incomingText?: string;
}

type EngineChangeSetKind =
  | "user-edit"
  | "agent-run"
  | "import"
  | "sync"
  | "site-build"
  | "history-restore";

type EngineBoundaryCrossing =
  | "public-share"
  | "external-export"
  | "permission-change"
  | "bulk-delete"
  | "site-publish"
  | "private-to-shared"
  | "unmergeable-overwrite";

// Canonical home of the change-author vocabulary. `@dohc/workspace-core`
// re-exports these (it already depends on this package), so the branded
// local-author label stays a single nominal type everywhere instead of a
// lossy structural copy.
declare const nonEmptyLocalAuthorLabelBrand: unique symbol;

export type NonEmptyLocalAuthorLabel = string & {
  readonly [nonEmptyLocalAuthorLabelBrand]: true;
};

export type ChangeAuthor =
  | { kind: "user"; userId: string }
  | { kind: "agent"; agentId: string; onBehalfOf: string }
  | { kind: "local"; label: NonEmptyLocalAuthorLabel };

interface EngineFileChange {
  path: string;
  operation: "write" | "delete" | "rename";
  mediaType?: string;
  before?: EngineFileChangeSnapshot | null;
  after?: EngineFileChangeSnapshot | null;
}

interface EngineFileChangeSnapshot {
  sha256?: string;
  sizeBytes?: number;
  text?: string;
  truncated?: boolean;
  unavailableReason?: "missing" | "binary" | "too-large" | "unreadable";
}

interface EngineChangeProvenance {
  source: EngineChangeSetKind;
  prompt?: string;
  agentRunId?: string;
  importPath?: string;
  restoreOfChangeSetId?: string;
  restoreOfPath?: string;
  restoreDirection?: "restore" | "undo" | "redo";
}

interface EngineChangeSet {
  kind: EngineChangeSetKind;
  author: ChangeAuthor;
  summary: string;
  files: EngineFileChange[];
  boundaryCrossings: EngineBoundaryCrossing[];
  provenance?: EngineChangeProvenance;
}

interface EngineHistoryRecord {
  id: string;
  recordedAtMs: number;
  kind: EngineChangeSetKind;
  author: ChangeAuthor;
  summary: string;
  files: EngineFileChange[];
  provenance?: EngineChangeProvenance;
  boundaryCrossings: EngineBoundaryCrossing[];
}

interface EngineIndexedHistoryRecord {
  index: number;
  record: EngineHistoryRecord;
}

interface EngineChangeSetStore {
  record(
    set: EngineChangeSet,
    opts: { id: string; recordedAtMs: number },
  ): Promise<EngineHistoryRecord>;
  list(): Promise<EngineHistoryRecord[]>;
  listIndexed(): Promise<EngineIndexedHistoryRecord[]>;
  listSince(afterMs: number): Promise<EngineHistoryRecord[]>;
  maxRecordedAtMs(): Promise<number>;
  get(id: string): Promise<EngineHistoryRecord | null>;
}
