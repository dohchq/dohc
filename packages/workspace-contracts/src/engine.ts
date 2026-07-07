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
 *   @dohc/workspace-core / workspace-engine changeSetStore shapes that this
 *   package cannot import without a dependency cycle. They are pinned to the real
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
  | "file-too-large"
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
  | "workspace-mismatch"
  | "write-lane-reentry";

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
export type VersionedFileContentKind = "text" | "binary";

export interface TextFileSnapshot {
  objectId: WorkspaceObjectId;
  versionId: VersionId;
  path: string;
  contentKind?: VersionedFileContentKind;
  sha256?: string;
  byteLength?: number;
  text: string;
  updatedAtMs: number;
  latestMomentId: VersionedTextMomentId;
  metadata: ActorNeutralWriteMetadata;
}

export interface VersionedTextFileState {
  exists: boolean;
  path: string;
  objectId?: WorkspaceObjectId;
  contentKind?: VersionedFileContentKind;
  sha256?: string;
  byteLength?: number;
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

export type SyncReplicationOpKind =
  | "workspace.init"
  | "moment.append"
  | "version.create"
  // No version rename API exists yet; included so 0P-B/0P-C typings stay stable.
  | "version.rename"
  | "conflict.open"
  | "conflict.resolve"
  | "secret.file.put"
  | "secret.file.delete"
  | "secret.version.fork"
  | "chat.channel.create"
  | "chat.thread.create"
  // No chat thread update API exists yet; included so 0P-B/0P-C typings stay stable.
  | "chat.thread.update"
  | "chat.message.append";

// Wire encoding of "did the origin see a prior state for this object": absent
// (no before at all), null (origin recorded an explicit no-file preimage), or
// present (the before* fields below carry the origin's preimage snapshot).
export type SyncMomentBeforePresence = "absent" | "null" | "present";

export interface MomentAppendPayload {
  momentId: VersionedTextMomentId;
  versionId: VersionId;
  objectId: WorkspaceObjectId;
  objectCreatedAtMs?: number;
  path: string;
  recordedAtMs: number;
  operation: "write" | "rename" | "delete";
  payloadBeforeBlobSha256: string | null;
  payloadBeforePath: string | null;
  payloadAfterBlobSha256: string;
  payloadAfterPath: string;
  // Content kinds are absent for text (the pre-WS-G1 wire truth); "binary"
  // shas point into binary_blobs and their bytes ship in the bundle's
  // blobs-bin/ directory. Byte lengths ride along so importers can persist
  // snapshot rows without re-measuring blob content.
  payloadBeforeContentKind?: VersionedFileContentKind;
  payloadBeforeByteLength?: number;
  payloadAfterContentKind?: VersionedFileContentKind;
  payloadAfterByteLength?: number;
  metadata: ActorNeutralWriteMetadata;
  author?: MomentAuthor;
  beforePresent: SyncMomentBeforePresence;
  beforeObjectId?: WorkspaceObjectId;
  beforeVersionId?: VersionId;
  beforePath?: string;
  beforeBlobSha256?: string;
  beforeContentKind?: VersionedFileContentKind;
  beforeByteLength?: number;
  beforeUpdatedAtMs?: number;
  beforeLatestMomentId?: VersionedTextMomentId;
  beforeMetadata?: ActorNeutralWriteMetadata;
}

// One snapshot row of the origin's source version AS OF the fork moment. The
// version.create payload ships these so importers materialize the fork from
// the ORIGIN's fork-point state instead of their own current snapshots (which
// may contain unrelated local edits the origin never saw).
export interface VersionCreateForkSnapshot {
  objectId: WorkspaceObjectId;
  objectCreatedAtMs?: number;
  path: string;
  contentKind?: VersionedFileContentKind;
  blobSha256: string;
  byteLength?: number;
  updatedAtMs: number;
  latestMomentId: VersionedTextMomentId;
  metadata: ActorNeutralWriteMetadata;
}

export interface VersionCreatePayload {
  versionId: VersionId;
  name: string;
  kind: VersionKind;
  forkVersionId?: VersionId;
  forkMomentId?: VersionedTextMomentId;
  createdAtMs: number;
  // Lazy additive (0P-A gate fix): absent only in payloads journaled before
  // fork-state shipping; importers then fall back to copying their local
  // source-version snapshots (the legacy, divergence-prone behavior).
  forkSnapshots?: VersionCreateForkSnapshot[];
}

export interface ConflictResolvePayload {
  conflictId: VersionedTextConflictId;
  status: "resolved";
  chosenFrom: VersionedTextConflictChoice;
  resolution: VersionedTextConflictResolution;
  updatedAtMs: number;
  // Lazy additive matching context (0P-A gate fix): sync divergence conflicts
  // get independent local ids per peer, so importers that cannot match
  // conflictId fall back to the mirrored (targetVersionId, current/incoming
  // head) pair. Absent in payloads journaled before the context shipped.
  targetVersionId?: VersionId;
  path?: string;
  currentLatestMomentId?: VersionedTextMomentId;
  incomingLatestMomentId?: VersionedTextMomentId;
}

export interface SecretFilePutPayload {
  versionId: VersionId;
  path: string;
  metadata: ActorNeutralWriteMetadata;
  ivBase64: string;
  authTagBase64: string;
  // sha256 of the raw ciphertext bytes. Plaintext and workspace data keys
  // must never ride replication payloads.
  ciphertextSha256: string;
  byteLength: number;
}

export interface SecretFileDeletePayload {
  versionId: VersionId;
  path: string;
  metadata: ActorNeutralWriteMetadata;
}

export interface SecretVersionForkPayload {
  toVersionId: VersionId;
  fromVersionId: VersionId;
  rows: Array<{
    path: string;
    ivBase64: string;
    authTagBase64: string;
    ciphertextSha256: string;
    byteLength: number;
    updatedAtMs: number;
    // Provenance string copied verbatim from the origin's secret_files row.
    // Secret moment ids are machine-local, so this may not resolve through
    // getSecretMoment on replicas; secret_files intentionally has no FK here.
    latestMomentId: string;
  }>;
}

export interface ChatChannelCreatePayload {
  // Origin-local channel id; NOT a cross-machine identity (peers mint their
  // own local ids). Cross-machine identity is wireId below.
  channelId: string;
  name: string;
  slug: string;
  kind: ChatChannelKind;
  createdAtMs: number;
  // Stable cross-machine channel identity (0P-A gate fix). Same wireId means
  // same channel; same slug with a DIFFERENT wireId stays a distinct channel
  // (the importer suffixes its local slug). The auto-created "general"
  // channel uses a well-known constant wireId so independently-created
  // generals converge. Absent only in payloads journaled before wire ids
  // shipped; importers then fall back to slug identity.
  wireId?: string;
}

export interface ChatThreadCreatePayload {
  threadId: ChatThreadId;
  title: string;
  createdAtMs: number;
  linkedObjectId?: WorkspaceObjectId;
  linkedPathHint?: string;
  linkedAtMs?: number;
  channelSlug?: string;
  // Preferred channel routing (0P-A gate fix): resolves through the importer's
  // wire-id map before the slug alias. Absent in pre-wire-id payloads.
  channelWireId?: string;
}

export interface ChatMessageAppendPayload {
  messageId: ChatMessageId;
  threadId: ChatThreadId;
  authorKind: ChatActor["kind"];
  authorDisplayName: string;
  body: string;
  createdAtMs: number;
}

export interface SyncReplicationEnvelopeOf<
  Kind extends SyncReplicationOpKind,
  Payload,
> {
  workspaceId: WorkspaceId;
  originId: string;
  originSeq: number;
  opKind: Kind;
  payload: Payload;
  recordedAtMs: number;
}

/**
 * One replicated op, discriminated on opKind so the payload shape is checked
 * at compile time (a typo/mismatch between opKind and payload cannot build).
 * The reserved kinds (version.rename, chat.thread.update) keep an unknown
 * payload until their APIs exist; stores must reject them on apply.
 */
export type SyncReplicationEnvelope =
  | SyncReplicationEnvelopeOf<"workspace.init", Record<string, never>>
  | SyncReplicationEnvelopeOf<"moment.append", MomentAppendPayload>
  | SyncReplicationEnvelopeOf<"version.create", VersionCreatePayload>
  | SyncReplicationEnvelopeOf<"version.rename", unknown>
  | SyncReplicationEnvelopeOf<"conflict.open", VersionedTextConflictRecord>
  | SyncReplicationEnvelopeOf<"conflict.resolve", ConflictResolvePayload>
  | SyncReplicationEnvelopeOf<"secret.file.put", SecretFilePutPayload>
  | SyncReplicationEnvelopeOf<"secret.file.delete", SecretFileDeletePayload>
  | SyncReplicationEnvelopeOf<"secret.version.fork", SecretVersionForkPayload>
  | SyncReplicationEnvelopeOf<"chat.channel.create", ChatChannelCreatePayload>
  | SyncReplicationEnvelopeOf<"chat.thread.create", ChatThreadCreatePayload>
  | SyncReplicationEnvelopeOf<"chat.thread.update", unknown>
  | SyncReplicationEnvelopeOf<"chat.message.append", ChatMessageAppendPayload>;

/**
 * Identity of a peer's conflict.resolve that could not be applied here
 * (0P-C gate fix): carried alongside the pendingConflictResolves count so
 * the surfacing layer can LIFECYCLE the notice instead of accumulating a
 * sticky counter — it clears when the referenced local conflict is later
 * resolved (locally or by sync convergence) or on explicit dismissal.
 */
export interface PendingConflictResolve {
  // The peer-side conflict id from the resolve payload: a stable identity
  // for deduping the same op across retries/re-imports.
  remoteConflictId: VersionedTextConflictId;
  // The LOCAL open conflict the resolve matched by mirrored heads but could
  // not safely apply to (live state moved on); null when nothing local
  // matched at all.
  localConflictId: VersionedTextConflictId | null;
  // The affected path when known (conflict row path, else the payload's).
  path: string | null;
}

/**
 * Outcome of applying one replicated op. A single status discriminant keeps
 * illegal states unrepresentable: a skipped op can never report opened
 * conflicts, and callers branch on one field instead of two booleans.
 */
export type SyncApplyResult =
  | {
      status: "applied";
      conflictsOpened: number;
      // conflict.resolve ops that matched no local conflict (neither by id nor
      // by mirrored heads). Journaled and acked — the op is preserved for a
      // future reconciliation pass — but surfaced so import results never
      // silently swallow a peer's resolution.
      pendingConflictResolves?: number;
      // Identities for the count above (same length when present).
      pendingResolves?: PendingConflictResolve[];
    }
  | { status: "skipped"; conflictsOpened: 0 };

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
  // Present (true) only for sync divergence record-only rows: history that a
  // peer recorded but that never touched this store's materialized file
  // state. Visible on the timeline, inert everywhere else — record-only
  // moments are never a head, never a fork point, and cannot be rolled back.
  syncRecordOnly?: boolean;
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
  contentKind?: VersionedFileContentKind;
  byteLength?: number;
  metadata: ActorNeutralWriteMetadata;
  // Present only when a dohc-tracked agent run authored this moment.
  author?: MomentAuthor;
  momentOrder: number;
  // Present (true) only for sync divergence record-only rows — see
  // VersionedTextMoment.syncRecordOnly.
  syncRecordOnly?: boolean;
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
  contentKind?: VersionedFileContentKind;
  sha256?: string;
  byteLength?: number;
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

// Minimal SQL-execution seam the engine write lane hands to a co-tenant of
// engine.db (currently the WS-G2-B Y.Doc driver). Intentionally structural (no
// node:sqlite dependency in contracts): a prepared-statement runner plus raw
// exec, matching the DatabaseSync surface the store already uses. The task runs
// INSIDE the store's single BEGIN IMMEDIATE transaction, so it must NOT issue
// its own BEGIN/COMMIT/ROLLBACK — throwing rolls the whole lane transaction back.
export interface EngineWriteLaneStatement {
  all(...params: unknown[]): Array<Record<string, unknown>>;
  get(...params: unknown[]): Record<string, unknown> | undefined;
  run(...params: unknown[]): { changes: number };
}
export interface EngineWriteLaneConnection {
  exec(sql: string): void;
  prepare(sql: string): EngineWriteLaneStatement;
}

/**
 * Internal server-side storage primitive.
 *
 * Callers must derive workspace identity and authorization before invoking this
 * API. Browser/client-provided workspace, version, or object ids are not an
 * authorization boundary.
 */
export interface VersionedTextStore {
  // WS-G2-B single-writer safety: run `task` on the store's SAME SQLite
  // connection, serialized through the store's write queue and wrapped in one
  // BEGIN IMMEDIATE transaction. The Y.Doc engine driver routes ALL its
  // engine.db writes through here so a settle (writeTextFile) and a Y.Doc
  // update-append can never hold two concurrent in-process write transactions —
  // node:sqlite busy-waits block the JS thread, so two same-process writers on
  // separate connections would deadlock until busy_timeout. Optional on the
  // interface (like ensureSearchIndex) so partial mock stores still typecheck;
  // the real createVersionedTextStore always provides it.
  runInEngineWriteLane?<T>(task: (connection: EngineWriteLaneConnection) => T): Promise<T>;
  // Internal indexed-search seam (lazy additive in engine.db). Implementations
  // that do not have an engine search index may omit these and callers must
  // fall back to linear search.
  ensureSearchIndex?(input: {
    workspaceId: WorkspaceId;
    versionId: VersionId;
  }): Promise<void>;
  querySearchIndex?(input: {
    workspaceId: WorkspaceId;
    versionId: VersionId;
    query: string;
    limit: number;
  }): Promise<
    | Array<
        | {
            surface: "file";
            path: string;
            objectId: WorkspaceObjectId;
            text: string;
          }
        | { surface: "chat"; threadId: ChatThreadId }
      >
    | null
  >;
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
  writeBinaryFile(input: {
    workspaceId: WorkspaceId;
    versionId: VersionId;
    path: string;
    bytes: Uint8Array;
    metadata: ActorNeutralWriteMetadata;
    author?: MomentAuthor;
    momentId?: VersionedTextMomentId;
  }): Promise<VersionedTextWriteResult>;
  readBinaryFile(input: {
    workspaceId: WorkspaceId;
    versionId: VersionId;
    path: string;
  }): Promise<Uint8Array | null>;
  readBinaryBlob(input: {
    workspaceId: WorkspaceId;
    sha256: string;
  }): Promise<Uint8Array | null>;
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
  // Fails closed (invalid-input) on sync record-only moments: divergent peer
  // history never rewrites the local materialized snapshot.
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
  // THE peer-op entry point (0P-A). Behavior both stores must agree on:
  // - Idempotent on duplicates: originSeq at or below the origin's acked
  //   high-water mark, or already present in replication_log, applies nothing
  //   and returns status "skipped".
  // - Fails closed (state-corrupt) on per-origin sequence gaps: originSeq must
  //   be exactly ackedSeq + 1; nothing is applied or acked on a gap.
  // - Divergence never clobbers: a moment whose before-head does not match the
  //   local materialized head lands as a record-only history row plus an open
  //   sync conflict (counted in conflictsOpened); the local live file is
  //   untouched.
  // - The op journals into replication_log and advances the origin's acked
  //   seq in the SAME transaction as its state mutation.
  applyReplicationOp(input: SyncReplicationEnvelope): Promise<SyncApplyResult>;
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
export type ChatChannelId = string;

// PR 12 (WS-E): a DM is a private channel subtype. Single-user alpha ships the
// kind enum only — no participant sets, presence, or DM UI yet.
export type ChatChannelKind = "channel" | "dm";

export type LinkedChatStoreErrorCode =
  | "channel-exists"
  | "channel-not-found"
  | "invalid-channel-kind"
  | "invalid-channel-name"
  | "invalid-message-body"
  | "invalid-path"
  | "invalid-read-cursor"
  | "invalid-sender"
  | "invalid-thread-owner"
  | "invalid-thread-title"
  | "invalid-workspace"
  | "read-state-revision-mismatch"
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

// The Channel owns membership/visibility/container semantics per the chats
// design spec. Single-user alpha stores identity + kind only: `slug` is a
// LOOKUP ALIAS derived from the name — durable rows key on the stable
// channelId so a future rename can never fork channel state.
export interface ChatChannel {
  id: ChatChannelId;
  workspaceId: WorkspaceId;
  name: string;
  slug: string;
  kind: ChatChannelKind;
  createdAtMs: number;
  updatedAtMs: number;
}

export interface ChatChannelSummary extends ChatChannel {
  threadCount: number;
  // Derived: sum over the channel's threads of messages past the (single
  // local user's) read cursor. Never stored.
  unreadCount: number;
}

// Per-thread monotonic read cursor (the spec's ThreadReadState, simplified to
// ONE local human actor for the single-user alpha). `lastReadSequence` counts
// messages read from the start of the thread; `revision` is server-owned and
// bumps on every APPLIED advance — callers may CAS on it but never write it.
export interface ChatThreadReadState {
  workspaceId: WorkspaceId;
  threadId: ChatThreadId;
  lastReadSequence: number;
  revision: number;
  updatedAtMs: number;
}

export interface ChatThread {
  id: ChatThreadId;
  workspaceId: WorkspaceId;
  // Display title. Untitled channel threads (the fast, no-title-prompt
  // composer path) derive this from their first message snippet at read time.
  title: string;
  createdAtMs: number;
  updatedAtMs: number;
  // Exactly-one-owner (P0E rule, tightened at the WS-E gate): a thread is
  // file-linked OR belongs to a channel — never both, never neither. The
  // store enforces this at creation (createThread requires a linked file;
  // startChannelThread owns the channel path) and fails closed on rows that
  // violate it, including channel threads whose channel no longer exists.
  linkedFile?: LinkedChatFileRef;
  channelId?: ChatChannelId;
}

export interface ChannelThreadSummary {
  thread: ChatThread;
  messageCount: number;
  lastReadSequence: number;
  // Derived: messageCount - lastReadSequence, clamped at zero. Never stored.
  unreadCount: number;
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
  // Creates a FILE-LINKED thread. linkedFile is REQUIRED (exactly-one-owner
  // at creation): an ownerless thread would be readable and indexed but
  // unreachable by navigation. Channel threads go through startChannelThread.
  createThread(input: {
    workspaceId: WorkspaceId;
    title: string;
    linkedFile: { objectId: WorkspaceObjectId; pathHint?: string };
  }): Promise<ChatThread>;
  // --- Channels (PR 12, WS-E) ---------------------------------------------
  createChannel(input: {
    workspaceId: WorkspaceId;
    name: string;
    kind?: ChatChannelKind;
  }): Promise<ChatChannel>;
  // Idempotent: creates the workspace's default "general" channel on first
  // chat use, returns the existing one afterwards.
  ensureGeneralChannel(input: { workspaceId: WorkspaceId }): Promise<ChatChannel>;
  listChannels(input: { workspaceId: WorkspaceId }): Promise<ChatChannelSummary[]>;
  // Slug is a lookup ALIAS only; durable state keys on channelId.
  findChannelBySlug(input: {
    workspaceId: WorkspaceId;
    slug: string;
  }): Promise<ChatChannel | null>;
  // The fast composer path: thread + first message land in ONE transaction so
  // a failed send can never strand an empty thread. Title is optional — an
  // untitled thread displays its first-message snippet (the anti-forum rule).
  startChannelThread(input: {
    workspaceId: WorkspaceId;
    channelId: ChatChannelId;
    title?: string;
    author: ChatActor;
    body: string;
  }): Promise<{ thread: ChatThread; message: ChatMessage }>;
  // Most-recent-activity first, with derived unread counts.
  listChannelThreads(input: {
    workspaceId: WorkspaceId;
    channelId: ChatChannelId;
  }): Promise<ChannelThreadSummary[]>;
  // Monotonic cursor advance: a lower-or-equal sequence is a no-op returning
  // the current state (revision unchanged); upToSequence clamps to the
  // thread's message count. Optional CAS: a stale expectedRevision fails with
  // "read-state-revision-mismatch" instead of silently applying.
  markThreadRead(input: {
    workspaceId: WorkspaceId;
    threadId: ChatThreadId;
    upToSequence: number;
    expectedRevision?: number;
  }): Promise<ChatThreadReadState>;
  listThreads(input: { workspaceId: WorkspaceId }): Promise<ChatThread[]>;
  listThreadsForFile(input: {
    workspaceId: WorkspaceId;
    objectId: WorkspaceObjectId;
  }): Promise<ChatThread[]>;
  // Single-user alpha read-state rule: a HUMAN-authored send advances the
  // thread's read cursor to include the sent message (your own message is
  // never unread); agent-authored sends never touch the cursor — they are
  // exactly what the unread signal exists to surface.
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
  // Same replication contract as VersionedTextStore.applyReplicationOp:
  // idempotent skip on duplicate originSeq, fail-closed on per-origin gaps,
  // journal + ack in the same transaction as the mutation. Chat ops never
  // open conflicts: channel identity converges by wire id (slug is only a
  // lookup alias), threads/messages are create-only by stable id.
  applyReplicationOp(input: SyncReplicationEnvelope): Promise<SyncApplyResult>;
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
  createId?: (kind: "channel" | "message" | "thread") => string;
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
  // True for secret-backed files (PR 08): the change is reported
  // metadata-only — protected contents never ride a comparison, so
  // currentText/incomingText are always absent when this is set.
  protected?: boolean;
  // Binary file content is versioned byte-exactly, but comparisons are
  // metadata-only: no raw bytes and no text-shaped body ride this surface.
  binary?: boolean;
}

// --- Secret-backed files (PR 08) -------------------------------------------
//
// Secret-classified paths (the classifyEngineFilePath floor — policy can
// never unmark them) are versioned by a dedicated driver that stores ONLY
// AES-256-GCM ciphertext in engine.db. Moments are metadata-only: they have
// no plaintext field at all, by construction. The single plaintext exit is
// materializeSecretFile, used exclusively by dohc's own disk materialization
// flows (version switch/merge/restore) — the file was already plaintext on
// disk, so that is the same trust boundary.
//
// Honest boundary: once plaintext is materialized into the workspace folder,
// ordinary OS-level file access applies. dohc does not claim per-process
// enforcement for arbitrary local processes after materialization; the
// encryption's job is keeping secrets out of dohc's durable, derived, and
// replicated surfaces (history, search, export, sync, chats, logs).

export type SecretFileStoreErrorCode =
  | "decrypt-failed"
  | "invalid-input"
  | "invalid-metadata"
  | "invalid-path"
  | "invalid-text"
  | "invalid-version"
  | "invalid-workspace"
  | "key-corrupt"
  | "moment-not-found"
  | "not-secret-path"
  | "state-corrupt";

// Metadata-only description of one secret file's tip: no content, no digest
// of the plaintext, nothing derived from the secret bytes except length.
export interface SecretFileStat {
  workspaceId: WorkspaceId;
  versionId: VersionId;
  path: string;
  byteLength: number;
  updatedAtMs: number;
  latestMomentId: string;
}

// Metadata-only history moment for a secret file. There is deliberately no
// payload/text field on this type — "Updated .env", never the contents.
export interface SecretFileMoment {
  id: string;
  workspaceId: WorkspaceId;
  versionId: VersionId;
  path: string;
  recordedAtMs: number;
  operation: "write" | "delete";
  metadata: ActorNeutralWriteMetadata;
  momentOrder: number;
  protected: true;
}

export interface SecretFileCompareEntry {
  path: string;
  // Relative to the target (for example Main): "added" = only the source has
  // it, "deleted" = only the target has it, "modified" = both differ.
  status: VersionFileChangeStatus;
}

export interface SecretFileWriteOutcome {
  // False when the write matched the current tip exactly (no new moment).
  changed: boolean;
  moment?: SecretFileMoment;
}

export interface SecretFileDeleteOutcome {
  // Null when the path was not tracked (delete of nothing is a no-op).
  moment: SecretFileMoment | null;
}

export interface SecretFileRestoreOutcome {
  restored: "text" | "deleted";
  restoredMomentId: string;
  path: string;
}

export type SecretFileMaterialization =
  | { present: false }
  | { present: true; text: string };

/**
 * Internal server-side storage primitive for secret-backed files.
 *
 * Every read surface except materializeSecretFile is metadata-only. Callers
 * must derive workspace identity and authorization before invoking this API;
 * agent-facing surfaces (MCP tools, projections, exports) must never expose
 * materializeSecretFile.
 */
export interface SecretFileStore {
  applyReplicationOp(input: SyncReplicationEnvelope): Promise<SyncApplyResult>;
  writeSecretFile(input: {
    workspaceId: WorkspaceId;
    versionId: VersionId;
    path: string;
    text: string;
    metadata: ActorNeutralWriteMetadata;
  }): Promise<SecretFileWriteOutcome>;
  deleteSecretFile(input: {
    workspaceId: WorkspaceId;
    versionId: VersionId;
    path: string;
    metadata: ActorNeutralWriteMetadata;
  }): Promise<SecretFileDeleteOutcome>;
  listSecretFiles(input: {
    workspaceId: WorkspaceId;
    versionId: VersionId;
  }): Promise<SecretFileStat[]>;
  // Newest first (descending momentOrder). The secret timeline is expected
  // to stay short; callers merge it into paged text timelines by time range.
  listSecretMoments(input: {
    workspaceId: WorkspaceId;
    versionId?: VersionId;
  }): Promise<SecretFileMoment[]>;
  getSecretMoment(input: {
    workspaceId: WorkspaceId;
    momentId: string;
  }): Promise<SecretFileMoment | null>;
  // Copies the source version's secret tips into a freshly created version
  // (and records them as the new version's fork base for merges).
  forkVersion(input: {
    workspaceId: WorkspaceId;
    fromVersionId: VersionId;
    toVersionId: VersionId;
  }): Promise<void>;
  // Metadata-only comparison of two versions' secret files (statuses are
  // relative to the target).
  compareSecretFileVersions(input: {
    workspaceId: WorkspaceId;
    targetVersionId: VersionId;
    sourceVersionId: VersionId;
  }): Promise<SecretFileCompareEntry[]>;
  // Whole-file merge of one secret path from source into target. Secrets
  // never produce conflict records (conflict records carry side texts, which
  // protected contents must never ride): when the source changed relative to
  // its fork base, the source side wins and the target's previous state stays
  // one moment back in the target's protected history.
  applySecretFileFromVersion(input: {
    workspaceId: WorkspaceId;
    targetVersionId: VersionId;
    sourceVersionId: VersionId;
    path: string;
    metadata: ActorNeutralWriteMetadata;
  }): Promise<SecretFileWriteOutcome>;
  // Returns the file to its state BEFORE the given moment by copying the
  // prior ciphertext forward as a new moment (history is never rewritten,
  // plaintext is never produced).
  restoreSecretFileToBeforeMoment(input: {
    workspaceId: WorkspaceId;
    momentId: string;
    metadata: ActorNeutralWriteMetadata;
  }): Promise<SecretFileRestoreOutcome>;
  // THE single authorized plaintext accessor. Only dohc's own disk
  // materialization flows (version switch/merge/restore) may call this.
  materializeSecretFile(input: {
    workspaceId: WorkspaceId;
    versionId: VersionId;
    path: string;
  }): Promise<SecretFileMaterialization>;
  // Releases the underlying database handle after in-flight writes drain.
  close(): Promise<void>;
}

export interface SecretFileStoreOptions {
  nowMs?: () => number;
  createId?: (kind: "moment") => string;
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
