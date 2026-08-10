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
 * | Phase0EffectivePolicyInput / Phase0EffectivePolicyResult | resolveEffectivePolicy + EffectivePolicyResult (from @dohc/security-contract) | partial | Covers path/file policy plus search/capture ownership only; actor permissions, sharing, chat-export, and object-family inputs are not implemented yet. |
 * | WorkspaceEvent / DurabilityEvent | Not implemented | not implemented | The engine coalesces writes directly into moments (VersionedTextMoment) instead of emitting a separate durability/event log. |
 *
 * Ownership notes:
 * - ChangeAuthor and NonEmptyLocalAuthorLabel are canonically owned here;
 *   @dohc/workspace-core re-exports them (it depends on this package), which
 *   keeps the branded local-author label one nominal type everywhere.
 * - The Engine*-prefixed private history and provenance types at the bottom are
 *   structural copies of @dohc/workspace-core shapes that this package cannot
 *   import without a dependency cycle. Exact-identity compile checks in
 *   packages/workspace-core/src/engineContracts.compile.ts pin their core-owned
 *   fields to the corresponding core types, so drift fails the workspace-core
 *   typecheck.
 */

export type WorkspaceObjectId = string;
export type VersionId = string;
export type WorkspaceId = string;
export type VersionedTextMomentId = string;
export type VersionedTextConflictId = string;

export const VERSIONED_TEXT_STORE_RELATIVE_PATH = ".dohc/engine/engine.db";
export const MAX_VERSIONED_BINARY_FILE_BYTES = 5 * 1024 * 1024;

/**
 * Opaque key-envelope relay contracts.
 *
 * Data-key bytes are deliberately absent: wrapping, unwrapping, and key
 * installation belong to the desktop custody boundary. The daemon may only
 * transport the serialized wrapped envelope and its relay fingerprint.
 */
export interface KeyEnvelopeUploadParams {
  workspaceId: WorkspaceId;
  envelopeJson: string;
  ifMatch?: string;
}

export interface KeyEnvelopeUploadResult {
  etag: string;
}

export interface KeyEnvelopeDownloadParams {
  workspaceId: WorkspaceId;
}

export interface KeyEnvelopeDownloadResult {
  envelopeJson: string;
  etag: string;
}

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
  // No `invalid-text`: the engine raises `DomainError::InvalidText` only for
  // the secret file size limit, which answers on the secret surface and its
  // own `SecretFileStoreErrorCode`. This store's text validation is size-only
  // and reports `payload-too-large`.
  | "invalid-timestamp"
  | "invalid-version-name"
  | "invalid-workspace"
  // A write past a measured byte ceiling. Its message carries the constraint,
  // the limit and the observed usage, so callers read the numbers there.
  | "payload-too-large"
  | "persist-failed"
  | "state-corrupt"
  | "target-path-exists"
  | "version-name-conflict"
  | "version-not-found"
  | "workspace-mismatch"
  | "write-lane-reentry";

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

export interface VersionedTextConflictPage {
  conflicts: VersionedTextConflictRecord[];
  // Pass back as afterConflictId to fetch the next page; null when this page
  // reached the end of the listing.
  nextAfterConflictId: VersionedTextConflictId | null;
}

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
  | "chat.message.append"
  | "chat.decision.set"
  | "chat.attachment.add"
  // WS-MU-C2: an emoji reaction on a chat message. A set-membership CRDT keyed
  // by (messageId, emoji, authorId) — add/remove COMMUTE and re-apply is a
  // no-op. It rides the SAME 0P chat replication transport as the other chat
  // kinds (blob-free). See ChatReactionSetPayload.
  | "chat.reaction.set"
  // Receiver-owned personal Feed state. These ops ride the owner's ordinary
  // workspace-sync lane and are deliberately excluded from chat-channel
  // shares; the shared-channel allowlist must never serve them.
  | "chat.follow.set"
  | "chat.feed.read.set"
  // WS-G2-C1: a Yjs CRDT update for a rich-doc object. UNLIKE moment.append it
  // is a COMMUTATIVE delta — apply carries NO head-check and opens NO P0D
  // conflict (Yjs guarantees convergence). See YDocUpdatePayload.
  | "ydoc.update";

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
  forkSnapshots: VersionCreateForkSnapshot[];
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
  chunkIndex: number;
  totalRows: number;
  rows: Array<{
    path: string;
    ivBase64: string;
    authTagBase64: string;
    ciphertextSha256: string;
    byteLength: number;
    updatedAtMs: number;
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
  // WS-MU-C0 verified authorship: the OPAQUE Better Auth user id of the sender,
  // never a raw email (PII must not enter the replicated CRDT). Present only for
  // a signed-in send; the relay VERIFIES `authorUserId === actor.userId` before
  // admitting the op to the replication log, so it is the durable, spoofing-
  // resistant "who said this". Solo/signed-out sends OMIT it — the op is then
  // byte-identical to the pre-MU-C0 shape and `authorDisplayName` (display-only,
  // never used for identity/authz) still renders. See the design's "Authenticated
  // authorship" section.
  authorUserId?: string;
  parentMessageId?: ChatMessageId;
  // Local CLI writes are replicated so every device can exclude them from
  // agent dispatch. Absent preserves the pre-CLI wire shape.
  origin?: "cli";
  body: string;
  createdAtMs: number;
}

export interface ChatDecisionSetPayload {
  threadId: ChatThreadId;
  messageId: ChatMessageId;
  state: ChatDecisionState;
  resolvedByMessageId?: ChatMessageId;
  atMs: number;
}

export interface ChatAttachmentAddPayload {
  attachmentId: string;
  threadId: ChatThreadId;
  messageId: ChatMessageId;
  targetKind: "file";
  // Shared-channel relays omit local file identity and paths. Local producers
  // still require objectId through sendMessage/startChannelThread inputs.
  objectId?: WorkspaceObjectId;
  pathHint?: string;
  headingText?: string;
  headingAnchor?: string;
  headingOccurrence?: number;
  createdAtMs: number;
}

/**
 * WS-MU-C2 — one emoji reaction membership change. A reaction is the relation
 * "author A reacted with emoji E to message M": a member of a set. State is an
 * observed register per `(messageId, emoji, authorId)` CELL.
 *
 * CRDT semantics — LWW-per-cell (last-writer-wins register per cell). Each cell
 * holds the winning op by a TOTAL order on `(atMs, then remove-wins on tie)`.
 * Apply keeps the op maximizing that order, so:
 * - COMMUTATIVE: max over a total order is arrival-order independent — applying
 *   the same set of ops in ANY interleaving (across incremental sync passes,
 *   not just within one merged pass) yields the same winner.
 * - IDEMPOTENT: re-applying an op is never strictly newer than the value it
 *   already produced, so it is a no-op.
 * Different authors never share a cell (distinct rows), so cross-user
 * add/remove never conflict. This is the same "convergence by op semantics, not
 * by head check" property `ydoc.update` relies on — no conflict row, no before
 * guard. Chosen over the plan's op-order 2P-set because LWW converges under
 * arbitrary ARRIVAL order, which the two-store fuzz gate exercises.
 *
 * Forward-compat (MU-C0 verified authorship): `authorId` is the field the relay
 * later stamps/verifies as `actor.userId`. Solo it is the local user identity
 * chat messages already attribute by; `authorKind`/`authorDisplayName` ride
 * along so replicated reactions render "<User>" / "<User>'s agent" without a
 * separate lookup.
 */
export interface ChatReactionSetPayload {
  // Stable cross-machine identity: a deterministic function of
  // (messageId, emoji, authorId). Same cell => same reactionId on every machine,
  // which is what makes an add and its later remove address the same register.
  reactionId: string;
  messageId: ChatMessageId;
  threadId: ChatThreadId;
  // Normalized unicode emoji (NFC). Callers pass a short allowlist member.
  emoji: string;
  // The reactor's stable identity: relay user id in multi-user, local user id
  // solo. The relay verifies `authorId === actor.userId` on shared channels.
  authorId: string;
  authorKind: ChatActor["kind"];
  authorDisplayName: string;
  // The cell's observed membership after this op.
  state: ChatReactionState;
  // LWW clock for this cell (the op's wall time). Ties break remove-wins.
  atMs: number;
}

export type ChatFollowTargetKind = "person" | "agent" | "channel" | "thread";
export type ChatFollowState = "following" | "unfollowed";

/** Receiver-owned LWW register for one Feed subscription. */
export interface ChatFollowSetPayload {
  ownerUserId: string;
  targetKind: ChatFollowTargetKind;
  targetId: string;
  state: ChatFollowState;
  atMs: number;
}

/** Receiver-owned LWW register for the Feed's caught-up boundary. */
export interface ChatFeedReadSetPayload {
  ownerUserId: string;
  lastSeenCreatedAtMs: number;
  lastSeenMessageId: ChatMessageId;
  atMs: number;
}

// WS-G2-C1 / G2-C-2 HANDOFF CONTRACT — the reserved transaction origin for a
// REMOTE replicated ydoc.update apply.
//
// When applyReplicationOp routes a remote update into a live in-memory Y.Doc, it
// applies it with THIS origin (`Y.applyUpdate(liveDoc, update, origin)`). Today
// the engine driver has no doc.on("update") observer, so nothing double-journals.
// But the G2-C-2 editor provider WILL observe doc.on("update", (u, origin) => …)
// to journal LOCAL edits — and it MUST ignore any update whose
// `origin === REMOTE_YDOC_APPLY_ORIGIN`. That update is a remote op the store
// already persisted, journaled, and acked via applyReplicationOp; re-journaling
// it under the local origin would push it back to every peer (an echo storm).
// Local/editor edits carry a null or editor origin and ARE journaled; remote
// applies carry this reserved symbol and are NOT.
export const REMOTE_YDOC_APPLY_ORIGIN: unique symbol = Symbol(
  "dohc.remoteYDocApplyOrigin",
);

export type YDocEngineDriverErrorCode =
  | "state-corrupt"
  | "not-found"
  | "already-live"
  | "session-closed"
  | "invalid-input";

export class YDocEngineDriverError extends Error {
  readonly code: YDocEngineDriverErrorCode;
  constructor(code: YDocEngineDriverErrorCode, message: string) {
    super(message);
    this.name = "YDocEngineDriverError";
    this.code = code;
  }
}

// The driver dimension for a replicated rich doc: does its projection read the
// XmlFragment body (richdoc) or the plain Y.Text (plaintext). Mirrors the
// engine's ydoc_docs.content_kind column.
export type YDocReplicationContentKind = "richdoc" | "plaintext";

/**
 * WS-G2-C1 — one Yjs CRDT update for a rich-doc object, riding the multi-origin
 * op log as a COMMUTATIVE op (0P sync design "ydoc.update"). The `updateBlob`
 * is a `Y.encodeStateAsUpdate`/incremental-`update` byte string, content-
 * addressed into `binary_blobs` and shipped over the identical blob-have/
 * blob-put transport moment.append's binary blobs use — no new route.
 *
 * Apply semantics differ FUNDAMENTALLY from moment.append: there is no
 * before-head, no divergence check, no conflict row. `Y.applyUpdate` is
 * commutative (any order converges) and idempotent (re-apply is a no-op via
 * Yjs state vectors), so the log's per-origin `acked_seq` dedup is the only
 * ordering machinery and the CRDT is the convergence backstop.
 */
export interface YDocUpdatePayload {
  versionId: VersionId;
  objectId: WorkspaceObjectId;
  // The projection target path: where the peer materializes the settled
  // markdown, and the SECRET-floor gate (a secret-classified path is never
  // opened as a replicated Y.Doc).
  path: string;
  contentKind: YDocReplicationContentKind;
  // The Yjs update bytes, content-addressed into binary_blobs(sha256).
  updateBlobSha256: string;
  // True for the full-state BASE op the driver emits when a live session's
  // replication baseline is established (`Y.encodeStateAsUpdate(seed)`). It is
  // still just a Yjs update — applied identically — but marks the op that lets
  // a from-scratch peer (no file, no prior state) reconstruct the doc, and
  // bounds replay (a fresh base supersedes older deltas). Deltas omit it.
  isBaseState?: boolean;
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
  | SyncReplicationEnvelopeOf<"chat.message.append", ChatMessageAppendPayload>
  | SyncReplicationEnvelopeOf<"chat.decision.set", ChatDecisionSetPayload>
  | SyncReplicationEnvelopeOf<"chat.attachment.add", ChatAttachmentAddPayload>
  | SyncReplicationEnvelopeOf<"chat.reaction.set", ChatReactionSetPayload>
  | SyncReplicationEnvelopeOf<"chat.follow.set", ChatFollowSetPayload>
  | SyncReplicationEnvelopeOf<"chat.feed.read.set", ChatFeedReadSetPayload>
  | SyncReplicationEnvelopeOf<"ydoc.update", YDocUpdatePayload>;

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
  // WS-G2-C1 non-journaling projection write. Materializes a rich doc's settled
  // markdown (a local moment + searchable snapshot) WITHOUT journaling a
  // moment.append replication op. A Y.Doc-driven object replicates SOLELY
  // through the commutative ydoc.update op stream; if its projection ALSO
  // journaled moment.append, two peers' independent settles would collide into
  // a P0D conflict on markdown the CRDT already reconciled. Optional (like
  // runInEngineWriteLane) so partial mocks typecheck; the Y.Doc driver requires
  // it. Behaves exactly like writeTextFile otherwise (origin metadata, moment,
  // snapshot, search index) minus the journal.
  writeProjectedTextFile?(input: {
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
  // One page of the engine's whole-version comparison (`versions.compareFiles`):
  // every path that differs between the two versions, metadata only, in path
  // order. Texts are hydrated per path by the caller that needs them (#562).
  compareVersionFilesPage(input: {
    workspaceId: WorkspaceId;
    sourceVersionId: VersionId;
    targetVersionId: VersionId;
    afterPath?: string;
  }): Promise<VersionFileChangeEntryPage>;
  // Page-shaped on purpose (#562): the engine pages `conflicts.list` under a
  // byte budget, and a drain here is what let one caller undo that. A caller
  // that needs every row loops pages; most callers need one.
  listTextConflicts(input: {
    workspaceId: WorkspaceId;
    status?: VersionedTextConflictStatus;
    afterConflictId?: VersionedTextConflictId;
    // Bodies the daemon withheld are rebuilt by default, under a byte budget.
    // A caller that reads only ids, paths or counts passes "withheld": for it
    // the rebuild transfers every body and then discards it.
    bodies?: "hydrate" | "withheld";
  }): Promise<VersionedTextConflictPage>;
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
export type ChatChannelKind = "channel" | "dm" | "agent";

export type LinkedChatStoreErrorCode =
  | "channel-exists"
  | "channel-not-found"
  | "decision-not-found"
  | "invalid-channel-kind"
  | "invalid-channel-name"
  | "invalid-bookmark-target"
  | "invalid-follow-target"
  | "invalid-message-body"
  | "message-not-found"
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

export const LINKED_CHAT_STORE_RELATIVE_PATH = VERSIONED_TEXT_STORE_RELATIVE_PATH;

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
  openDecisionCount: number;
  // Additive feed preview: listChannelThreads supplies the opening message
  // without making callers load every message in every listed thread. Older
  // consumers can omit it; an empty thread has no preview.
  openingMessage?: {
    id: ChatMessageId;
    author: ChatActor;
    createdAtMs: number;
    bodySnippet: string;
    // Only active reactions belonging to this opening message.
    reactions: ChatReaction[];
  };
}

export type ChatDecisionState = "open" | "resolved";

export interface ChatDecisionRecord {
  workspaceId: WorkspaceId;
  threadId: ChatThreadId;
  messageId: ChatMessageId;
  state: ChatDecisionState;
  resolvedByMessageId?: ChatMessageId;
  atMs: number;
}

export interface ChatAttachment {
  attachmentId: string;
  threadId: ChatThreadId;
  messageId: ChatMessageId;
  targetKind: "file";
  // Absent for an opaque attachment received through a shared channel.
  objectId?: WorkspaceObjectId;
  pathHint?: string;
  headingText?: string;
  headingAnchor?: string;
  headingOccurrence?: number;
  createdAtMs: number;
}

export interface ChatFileMention {
  attachment: ChatAttachment;
  message: ChatMessage;
  thread: ChatThread;
  channel?: ChatChannel;
}

export interface ChatMessage {
  id: ChatMessageId;
  workspaceId: WorkspaceId;
  threadId: ChatThreadId;
  author: ChatActor;
  // WS-MU-C0 verified authorship: the sender's OPAQUE relay user id (Better Auth
  // user id), the same value the relay verifies as `actor.userId`. Present only
  // for a signed-in send; absent for solo/legacy messages. `author` stays the
  // display-only convenience — identity/authz key on `authorUserId`, never the
  // display name.
  authorUserId?: string;
  parentMessageId?: ChatMessageId;
  origin?: "cli";
  body: string;
  createdAtMs: number;
  attachments: ChatAttachment[];
}

export interface ChatAgentReadState {
  workspaceId: WorkspaceId;
  threadId: ChatThreadId;
  lastReadCreatedAtMs: number;
  lastReadMessageId: ChatMessageId;
  revision: number;
  updatedAtMs: number;
}

export interface ChatMentionRecord {
  threadId: ChatThreadId;
  messageId: ChatMessageId;
  handle: string;
  authorKind: ChatActor["kind"];
  createdAtMs: number;
}

// Reactions (WS-MU-C2). The observed cell state — an emoji reaction by an
// author is either present ("added") or tombstoned ("removed"). Tombstones are
// retained so a stale re-add cannot win the LWW register.
export type ChatReactionState = "added" | "removed";

// Who reacted. Solo this is the local user/agent; the design's verified relay
// authorUserId (MU-C0) later fills authorId. displayName/kind render the
// reaction ("<User>" / "<User>'s agent") without a separate lookup.
export interface ChatReactionAuthor {
  authorId: string;
  kind: ChatActor["kind"];
  displayName: string;
}

// One reaction CELL as the store returns it. `listReactions` returns only
// active ("added") cells for display; `setReaction` returns the resolved cell
// after the LWW upsert (whose `state` reflects the winning op). The UI groups
// active reactions by (messageId, emoji) into pills with a count and the
// reactors' names.
export interface ChatReaction {
  reactionId: string;
  threadId: ChatThreadId;
  messageId: ChatMessageId;
  emoji: string;
  author: ChatReactionAuthor;
  state: ChatReactionState;
  atMs: number;
}

export interface ChatFollow {
  workspaceId: WorkspaceId;
  ownerUserId: string;
  targetKind: ChatFollowTargetKind;
  targetId: string;
  state: ChatFollowState;
  updatedAtMs: number;
}

export interface ChatFeedReadState {
  workspaceId: WorkspaceId;
  ownerUserId: string;
  lastSeenCreatedAtMs: number;
  lastSeenMessageId: ChatMessageId;
  updatedAtMs: number;
}

export interface ChatFeedItem {
  message: ChatMessage;
  thread: ChatThread;
  channel?: ChatChannel;
  parentMessage?: ChatMessage;
  openingMessage?: ChatMessage;
  reactions: ChatReaction[];
  matchedBy: ChatFollowTargetKind[];
}

export interface ChatFeedPage {
  items: ChatFeedItem[];
  nextCursor?: string;
  headCursor?: string;
  readState?: ChatFeedReadState;
}

export type ChatBookmarkTargetKind = "message" | "thread";
export type ChatBookmarkMode = "live" | "snapshot";
export type ChatBookmarkState = "active" | "archived";
export type ChatBookmarkProjectionState = "pending" | "ready" | "failed" | "stale";

/**
 * A receiver-owned request to materialize chat context as a workspace file.
 * The engine owns desired state + a generation-checked outbox only; filesystem
 * materialization belongs to the desktop workspace layer.
 */
export interface ChatBookmark {
  bookmarkId: string;
  workspaceId: WorkspaceId;
  ownerUserId: string;
  targetKind: ChatBookmarkTargetKind;
  targetId: string;
  threadId: ChatThreadId;
  messageId?: ChatMessageId;
  mode: ChatBookmarkMode;
  destinationPath: string;
  state: ChatBookmarkState;
  generation: number;
  projectedGeneration: number;
  projectionState: ChatBookmarkProjectionState;
  // Stable engine identity of the generated artifact this bookmark owns.
  // Absent until the first projection succeeds; callers must never infer
  // ownership from whichever object currently occupies destinationPath.
  projectionObjectId?: WorkspaceObjectId;
  createdAtMs: number;
  updatedAtMs: number;
  lastProjectedAtMs?: number;
  failureReason?: string;
}

export interface ChatBookmarkTransitionResult {
  bookmark: ChatBookmark;
  // False when a materializer reports an obsolete generation. The current
  // bookmark is returned so the worker can immediately observe newer work.
  applied: boolean;
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
  ensureAgentChannel(input: { workspaceId: WorkspaceId }): Promise<ChatChannel>;
  listChannels(input: { workspaceId: WorkspaceId }): Promise<ChatChannelSummary[]>;
  // Slug is a lookup ALIAS only; durable state keys on channelId.
  findChannelBySlug(input: {
    workspaceId: WorkspaceId;
    slug: string;
  }): Promise<ChatChannel | null>;
  // The channel's cross-machine WIRE identity (MU-C4 shared channels key on
  // it): its own id for a locally created channel, the originating store's id
  // for a replicated one, the well-known constant for "general". Null for a
  // channel with no recorded wire mapping (pre-wire-id rows).
  getChannelWireId(input: {
    workspaceId: WorkspaceId;
    channelId: ChatChannelId;
  }): Promise<string | null>;
  // MU-C4 read-only write gate: resolve a thread to its bound channel with a
  // single indexed lookup (no workspace-wide thread scan). Null when the
  // thread is missing, cross-workspace, or not channel-bound (a file-linked
  // thread).
  findThreadChannelId(input: {
    workspaceId: WorkspaceId;
    threadId: ChatThreadId;
  }): Promise<ChatChannelId | null>;
  // The fast composer path: thread + first message land in ONE transaction so
  // a failed send can never strand an empty thread. Title is optional — an
  // untitled thread displays its first-message snippet (the anti-forum rule).
  startChannelThread(input: {
    workspaceId: WorkspaceId;
    channelId: ChatChannelId;
    title?: string;
    author: ChatActor;
    // WS-MU-C0: the sender's OPAQUE relay user id (Better Auth user id). Caller
    // supplies it ONLY when signed in; the journaled message.append then carries
    // it for relay verification. Omit for solo (byte-identical to today).
    authorUserId?: string;
    origin?: "cli";
    body: string;
    needsDecision?: boolean;
    attachments?: Array<{
      objectId: WorkspaceObjectId;
      pathHint?: string;
      headingText?: string;
      headingAnchor?: string;
      headingOccurrence?: number;
    }>;
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
    // WS-MU-C0: the sender's OPAQUE relay user id (Better Auth user id). Caller
    // supplies it ONLY when signed in; the journaled message.append then carries
    // it for relay verification. Omit for solo (byte-identical to today).
    authorUserId?: string;
    parentMessageId?: ChatMessageId;
    origin?: "cli";
    body: string;
    needsDecision?: boolean;
    attachments?: Array<{
      objectId: WorkspaceObjectId;
      pathHint?: string;
      headingText?: string;
      headingAnchor?: string;
      headingOccurrence?: number;
    }>;
  }): Promise<ChatMessage>;
  listMessages(input: {
    workspaceId: WorkspaceId;
    threadId: ChatThreadId;
  }): Promise<ChatMessage[]>;
  resolveChatDecision(input: {
    workspaceId: WorkspaceId;
    threadId: ChatThreadId;
    messageId: ChatMessageId;
    resolvedByMessageId: ChatMessageId;
  }): Promise<ChatDecisionRecord>;
  listThreadDecisions(
    workspaceId: WorkspaceId,
    threadId: ChatThreadId,
  ): Promise<ChatDecisionRecord[]>;
  listThreadAttachments(
    workspaceId: WorkspaceId,
    threadId: ChatThreadId,
  ): Promise<ChatAttachment[]>;
  listFileMentions(input: {
    workspaceId: WorkspaceId;
    objectId?: WorkspaceObjectId;
    pathHint?: string;
  }): Promise<ChatFileMention[]>;
  markThreadReadByAgent(input: {
    workspaceId: WorkspaceId;
    threadId: ChatThreadId;
    upTo: { createdAtMs: number; messageId: ChatMessageId };
    expectedRevision?: number;
  }): Promise<ChatAgentReadState>;
  listAgentUnreadThreads(workspaceId: WorkspaceId): Promise<ChatThread[]>;
  listMentionsForHandle(
    workspaceId: WorkspaceId,
    handle: string,
    options?: { unreadByAgentOnly?: boolean },
  ): Promise<ChatMentionRecord[]>;
  // --- Reactions (WS-MU-C2) ------------------------------------------------
  // Set (add or remove) one author's emoji reaction on a message. A
  // set-membership CRDT cell keyed by (messageId, emoji, author.authorId):
  // LWW-per-cell by (atMs, remove-wins tie), so the op is commutative and
  // re-applying is a no-op. It always persists locally. It journals a
  // `chat.reaction.set` op only when replicationAuthorId is present and
  // matches author.authorId. Returns the resolved cell after the LWW upsert
  // (state reflects the winning op, which is always this call for a local set).
  setReaction(input: {
    workspaceId: WorkspaceId;
    threadId: ChatThreadId;
    messageId: ChatMessageId;
    emoji: string;
    author: ChatReactionAuthor;
    replicationAuthorId?: string;
    state: ChatReactionState;
  }): Promise<ChatReaction>;
  // Every ACTIVE ("added") reaction in a thread, oldest-first per cell. The UI
  // groups by (messageId, emoji). Tombstones are never returned.
  listReactions(input: {
    workspaceId: WorkspaceId;
    threadId: ChatThreadId;
  }): Promise<ChatReaction[]>;
  // --- Personal Feed -------------------------------------------------------
  // Receiver-owned state: ownerUserId is derived by the trusted caller (main
  // process / local CLI), never by a browser renderer. Channel targets use the
  // cross-machine wire id; person/agent targets use verified opaque user ids.
  setFollow(input: {
    workspaceId: WorkspaceId;
    ownerUserId: string;
    // Supplied only when the trusted caller has a verified relay identity.
    // Omit for signed-out/local-only state. When present it must equal
    // ownerUserId before this mutation is admitted to the replication log.
    replicationOwnerUserId?: string;
    targetKind: ChatFollowTargetKind;
    targetId: string;
    state: ChatFollowState;
  }): Promise<ChatFollow>;
  listFollows(input: {
    workspaceId: WorkspaceId;
    ownerUserId: string;
    state?: ChatFollowState;
  }): Promise<ChatFollow[]>;
  // Seeds missing non-DM channel follows at clock zero. It never journals and
  // INSERT OR IGNORE means a real unfollow tombstone cannot be resurrected.
  ensureDefaultChannelFollows(input: {
    workspaceId: WorkspaceId;
    ownerUserId: string;
  }): Promise<void>;
  listPersonalFeed(input: {
    workspaceId: WorkspaceId;
    ownerUserId: string;
    cursor?: string;
    limit?: number;
  }): Promise<ChatFeedPage>;
  markPersonalFeedSeen(input: {
    workspaceId: WorkspaceId;
    ownerUserId: string;
    // Same verified-identity gate as setFollow. Signed-out read position is
    // durable locally but intentionally absent from sync exports.
    replicationOwnerUserId?: string;
    headCursor: string;
  }): Promise<ChatFeedReadState>;
  // --- Workspace-backed chat bookmarks -----------------------------------
  saveBookmark(input: {
    workspaceId: WorkspaceId;
    ownerUserId: string;
    targetKind: ChatBookmarkTargetKind;
    targetId: string;
    mode: ChatBookmarkMode;
    destinationPath: string;
  }): Promise<ChatBookmark>;
  listBookmarks(input: {
    workspaceId: WorkspaceId;
    ownerUserId: string;
    state?: ChatBookmarkState;
  }): Promise<ChatBookmark[]>;
  findBookmark(input: {
    workspaceId: WorkspaceId;
    ownerUserId: string;
    bookmarkId: string;
  }): Promise<ChatBookmark | null>;
  archiveBookmark(input: {
    workspaceId: WorkspaceId;
    ownerUserId: string;
    bookmarkId: string;
  }): Promise<ChatBookmark>;
  listPendingBookmarks(input: {
    workspaceId: WorkspaceId;
    ownerUserId: string;
    limit?: number;
  }): Promise<ChatBookmark[]>;
  markBookmarkPending(input: {
    workspaceId: WorkspaceId;
    ownerUserId: string;
    bookmarkId: string;
  }): Promise<ChatBookmark>;
  markBookmarkReady(input: {
    workspaceId: WorkspaceId;
    ownerUserId: string;
    bookmarkId: string;
    generation: number;
    projectedAtMs?: number;
    projectionObjectId?: WorkspaceObjectId;
    // Required with projectionObjectId so an obsolete worker may safely
    // record ownership only while the bookmark still targets the same path.
    projectionPath?: string;
  }): Promise<ChatBookmarkTransitionResult>;
  markBookmarkFailed(input: {
    workspaceId: WorkspaceId;
    ownerUserId: string;
    bookmarkId: string;
    generation: number;
    failureReason: string;
  }): Promise<ChatBookmarkTransitionResult>;
  markBookmarkStale(input: {
    workspaceId: WorkspaceId;
    ownerUserId: string;
    bookmarkId: string;
    generation: number;
    failureReason?: string;
  }): Promise<ChatBookmarkTransitionResult>;
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

export type AgentDispatchState = "pending" | "running" | "done" | "failed";

export interface AgentDispatchRecord {
  workspaceId: WorkspaceId;
  triggerMessageId: ChatMessageId;
  threadId: ChatThreadId;
  state: AgentDispatchState;
  runId?: string;
  failureReason?: string;
  attemptCount: number;
  createdAtMs: number;
  updatedAtMs: number;
}

export interface AgentRunRecord {
  workspaceId: WorkspaceId;
  runId: string;
  threadId: ChatThreadId;
  triggerMessageId: ChatMessageId;
  command: string;
  startedAtMs: number;
  endedAtMs?: number;
  exitCode?: number;
  failureReason?: string;
  logPath?: string;
  failureNotePosted: boolean;
}

export interface AgentDispatchClaim {
  dispatch: AgentDispatchRecord;
  run: AgentRunRecord;
}

export interface ThreadDispatchPauseState {
  workspaceId: WorkspaceId;
  threadId: ChatThreadId;
  paused: boolean;
  reason?: string;
  updatedAtMs: number;
}

export interface AgentDispatchStore {
  recordEligibleTriggers(input: {
    workspaceId: WorkspaceId;
    verifiedUserId?: string;
  }): number;
  recordTrigger(input: {
    workspaceId: WorkspaceId;
    triggerMessageId: ChatMessageId;
    threadId: ChatThreadId;
  }): boolean;
  claimNextPending(
    workspaceId: WorkspaceId,
    options?: { command?: string; logPath?: string },
  ): AgentDispatchClaim | null;
  failPendingForThread(input: {
    workspaceId: WorkspaceId;
    threadId: ChatThreadId;
    reason: string;
  }): number;
  completeRun(input: { runId: string; exitCode: number }): AgentRunRecord;
  failRun(input: { runId: string; exitCode?: number; reason: string }): AgentRunRecord;
  listPending(workspaceId: WorkspaceId): AgentDispatchRecord[];
  openRuns(workspaceId: WorkspaceId): AgentDispatchClaim[];
  markFailureNotePosted(runId: string): AgentRunRecord;
  recentDispatchCount(input: {
    workspaceId: WorkspaceId;
    threadId: ChatThreadId;
    sinceMs: number;
  }): number;
  recordRunMessage(input: {
    workspaceId: WorkspaceId;
    messageId: ChatMessageId;
    runId: string;
  }): boolean;
  listRunMessages(workspaceId: WorkspaceId, runId: string): ChatMessageId[];
  runIdForMessage(workspaceId: WorkspaceId, messageId: ChatMessageId): string | null;
  runRecordsForThread(
    workspaceId: WorkspaceId,
    threadId: ChatThreadId,
    options?: { limit?: number },
  ): Record<ChatMessageId, AgentRunRecord>;
  getRunRecord(runId: string): AgentRunRecord | null;
  setThreadDispatchPaused(input: {
    workspaceId: WorkspaceId;
    threadId: ChatThreadId;
    paused: boolean;
    reason?: string;
  }): ThreadDispatchPauseState;
  threadDispatchPaused(workspaceId: WorkspaceId, threadId: ChatThreadId): boolean;
  getThreadDispatchPauseState(
    workspaceId: WorkspaceId,
    threadId: ChatThreadId,
  ): ThreadDispatchPauseState | null;
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

// One differing path, metadata only — what `versions.compareFiles` reports
// per row. The hydrated shape below is built from this by reading the sides.
export interface VersionFileChangeEntry {
  path: string;
  status: VersionFileChangeStatus;
  binary?: boolean;
}

export interface VersionFileChangeEntryPage {
  entries: VersionFileChangeEntry[];
  // Pass back as afterPath to fetch the next page; null when this page
  // reached the end of the comparison.
  nextAfterPath: string | null;
}

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

export interface SecretFileComparePage {
  entries: SecretFileCompareEntry[];
  // Pass back as afterPath to fetch the next page; null when this page
  // reached the end of the comparison.
  nextAfterPath: string | null;
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
  // relative to the target). Page-shaped like every other listing (#562): the
  // engine pages this on the wire, and a drain here is what put every
  // remaining protected row on one compare page.
  compareSecretFileVersions(input: {
    workspaceId: WorkspaceId;
    targetVersionId: VersionId;
    sourceVersionId: VersionId;
    afterPath?: string;
  }): Promise<SecretFileComparePage>;
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
