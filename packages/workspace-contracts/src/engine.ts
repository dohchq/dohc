import type { AutomationRunAttribution } from "./collection";

type WorkspaceObjectId = string;
export type VersionId = string;
export type WorkspaceId = string;
type VersionedTextMomentId = string;
type VersionedTextConflictId = string;

export const MAX_VERSIONED_BINARY_FILE_BYTES = 5 * 1024 * 1024;

/**
 * Opaque key-envelope relay contracts.
 *
 * Data-key bytes are deliberately absent: wrapping, unwrapping, and key
 * installation belong to the desktop custody boundary. The daemon may only
 * transport the serialized wrapped envelope and its relay fingerprint.
 */
export interface KeyEnvelopeUploadResult {
  etag: string;
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
  | "object-identity-mismatch"
  | "fork-base-not-found"
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
  | "write-precondition-failed"
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

type VersionKind = "main" | "named";

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

type ActorNeutralWriteOrigin =
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

// A recorded moment can also say that a live document session settled it.
// The settle names no author, and it can carry a collaborator's synced
// updates, so "ydoc" says how the change arrived, not who made it. Writes
// take ActorNeutralWriteMetadata, so no write can claim it.
export interface MomentMetadata extends Omit<ActorNeutralWriteMetadata, "origin"> {
  origin: ActorNeutralWriteOrigin | "ydoc";
}

// Optional authorship carried by a MOMENT (never by snapshot metadata, which
// stays actor-neutral). A moment names a nonempty list of authors, one per
// person or agent whose edits it covers. Tracked agent runs stamp the agent
// variant, and a person's live edits the human variant. Relay
// collection creates stamp the public variant using a grant-scoped public
// principal mapping, never an internal principal or account ID. A named
// recipient's direct write to a Collection's own files stamps the named
// variant with the opaque relay user id, never an email. An Edit share
// link's direct write stamps the link variant: the link's grant is the
// author, and the server-minted link principal only tells its browser
// sessions apart. Neither carries a claimed name. Ordinary edits,
// reconciliation, and external agent CLIs remain actor-neutral. An
// automation that creates a record stamps the automation variant, so the
// record's added claim carries the automation and its chain depth.
interface AgentMomentAuthor {
  kind: "agent";
  agentId: string;
  onBehalfOf?: string;
  agentRunId?: string;
  // An agent run an automation started writes at its chain depth, so the
  // claims its writes cause carry the chain on. Named only past 0: a run a
  // person started names none, and absent means 0.
  depth?: number;
}

interface HumanMomentAuthor {
  kind: "human";
  humanId: string;
  onBehalfOf?: string;
}

interface PublicMomentAuthor {
  kind: "public";
  principalId: string;
  grantId: string;
}

interface NamedMomentAuthor {
  kind: "named";
  userId: string;
  grantId: string;
  grantGeneration: number;
}

interface LinkMomentAuthor {
  kind: "link";
  grantId: string;
  grantGeneration: number;
  principalId: string;
}

/**
 * An automation writing a file. The depth is its trigger's chain depth plus
 * one, so the claims its write causes carry the chain onward and stop at the
 * cap.
 */
interface AutomationMomentAuthor {
  kind: "automation";
  automationId: string;
  onBehalfOf?: string;
  depth: number;
}

export type MomentAuthor =
  | AgentMomentAuthor
  | HumanMomentAuthor
  | PublicMomentAuthor
  | NamedMomentAuthor
  | LinkMomentAuthor
  | AutomationMomentAuthor;

// A local agent write names the person the agent works for. An automation
// names its run's person, and none when its run has none.
export type MomentWriteAuthor = (AgentMomentAuthor & { onBehalfOf: string }) | AutomationMomentAuthor;

type VersionedFileContentKind = "text" | "binary";

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

type VersionedTextComparisonStatus =
  | "same"
  | "incoming-changed"
  | "current-changed"
  | "diverged";

interface VersionedTextComparison {
  workspaceId: WorkspaceId;
  path: string;
  targetVersionId: VersionId;
  sourceVersionId: VersionId;
  base: VersionedTextFileState;
  current: VersionedTextFileState;
  incoming: VersionedTextFileState;
  status: VersionedTextComparisonStatus;
}

type VersionedTextConflictStatus = "open" | "resolved";
type VersionedTextConflictResolution =
  | "applied-incoming"
  | "applied-merged"
  | "kept-current";
type VersionedTextConflictChoice = "current" | "incoming" | "merged";

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

type VersionedTextMergeResult =
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

type VersionedTextConflictResolveResult =
  | {
      kind: "resolved";
      conflict: VersionedTextConflictRecord;
      write?: VersionedTextWriteResult;
      delete?: VersionedTextDeleteResult;
    };

interface VersionedTextConflictPage {
  conflicts: VersionedTextConflictRecord[];
  // Pass back as afterConflictId to fetch the next page; null when this page
  // reached the end of the listing.
  nextAfterConflictId: VersionedTextConflictId | null;
}

export type SyncReplicationOpKind =
  | "workspace.init"
  | "moment.append"
  | "chat.thread.create"
  | "chat.message.append";

// Wire encoding of "did the origin see a prior state for this object": absent
// (no before at all), null (origin recorded an explicit no-file preimage), or
// present (the before* fields below carry the origin's preimage snapshot).
type SyncMomentBeforePresence = "absent" | "null" | "present";

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
  authors?: MomentAuthor[];
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
  // a signed-in send; the relay verifies `authorUserId === actor.userId` before
  // admitting the op to the replication log, so it is the durable, spoofing-
  // resistant "who said this". Solo/signed-out sends omit it — the op is then
  // byte-identical to the pre-MU-C0 shape and `authorDisplayName` (display-only,
  // never used for identity/authz) still renders. See the design's "Authenticated
  // authorship" section.
  authorOwnerDisplayName?: string;
  authorUserId?: string;
  parentMessageId?: ChatMessageId;
  // Local CLI writes are replicated so every device can exclude them from
  // agent dispatch. Absent preserves the pre-CLI wire shape.
  origin?: "cli";
  body: string;
  createdAtMs: number;
}

type ChatFollowTargetKind = "person" | "agent" | "channel" | "thread";
type ChatFollowState = "following" | "unfollowed";

export interface VersionedTextMoment {
  id: VersionedTextMomentId;
  workspaceId: WorkspaceId;
  versionId: VersionId;
  objectId: WorkspaceObjectId;
  path: string;
  recordedAtMs: number;
  operation: "write" | "rename" | "delete";
  payload: VersionedTextMomentPayload;
  metadata: MomentMetadata;
  // Present only when the moment recorded who made it.
  authors?: MomentAuthor[];
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
  metadata: MomentMetadata;
  // Present only when the moment recorded who made it.
  authors?: MomentAuthor[];
  momentOrder: number;
  // Present (true) only for sync divergence record-only rows — see
  // VersionedTextMoment.syncRecordOnly.
  syncRecordOnly?: boolean;
}

interface VersionedTextMomentPage {
  // Newest first (descending momentOrder).
  moments: VersionedTextMomentSummary[];
  // Pass back as beforeMomentOrder to fetch the next (older) page; null when
  // this page reached the beginning of the timeline.
  nextBeforeMomentOrder: number | null;
  // The workspace's newest moment order for the given filter (-1 when empty),
  // regardless of pagination position.
  latestMomentOrder: number;
}

interface VersionedTextMomentPayloadSnapshot {
  path: string;
  contentKind?: VersionedFileContentKind;
  sha256?: string;
  byteLength?: number;
  text: string;
}

interface VersionedTextMomentPayload {
  before: VersionedTextMomentPayloadSnapshot | null;
  after: VersionedTextMomentPayloadSnapshot;
}

interface VersionedTextWriteResult {
  materialized?: boolean;
  materializeOutcome?: "applied" | "skipped" | "conflict" | "superseded" | "error";
  object: FileObjectRecord;
  snapshot: TextFileSnapshot;
  moment: VersionedTextMoment;
}

interface VersionedTextRenameResult {
  object: FileObjectRecord;
  before: TextFileSnapshot;
  after: TextFileSnapshot;
  moment: VersionedTextMoment;
}

interface VersionedTextDeleteResult {
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
    requestId?: string;
    expectedSha256?: string;
    text: string;
    /** Publish after committing. Omit when recording bytes already on disk. */
    publish?: boolean;
    createOnly?: boolean;
    restoreBeforeMomentId?: VersionedTextMomentId;
    metadata: ActorNeutralWriteMetadata;
    author?: MomentWriteAuthor;
    momentId?: VersionedTextMomentId;
  }): Promise<VersionedTextWriteResult>;
  writeBinaryFile(input: {
    workspaceId: WorkspaceId;
    versionId: VersionId;
    path: string;
    requestId?: string;
    expectedSha256?: string;
    bytes: Uint8Array;
    createOnly?: boolean;
    metadata: ActorNeutralWriteMetadata;
    author?: MomentWriteAuthor;
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
  // order. Texts are hydrated per path by the caller that needs them.
  compareVersionFilesPage(input: {
    workspaceId: WorkspaceId;
    sourceVersionId: VersionId;
    targetVersionId: VersionId;
    afterPath?: string;
  }): Promise<VersionFileChangeEntryPage>;
  // Page-shaped on purpose: the engine pages `conflicts.list` under a
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
    expectedObjectId?: WorkspaceObjectId;
    // Delete only if the path is still missing on disk when the engine applies
    // the delete. A caller that saw the file missing sets it: a replace can
    // empty the name for a moment.
    onlyIfAbsentOnDisk?: boolean;
    requestId?: string;
    metadata: ActorNeutralWriteMetadata;
    author?: MomentWriteAuthor;
    momentId?: VersionedTextMomentId;
  }): Promise<VersionedTextDeleteResult>;
  // Fails closed (invalid-input) on sync record-only moments: divergent peer
  // history never rewrites the local materialized snapshot.
  rollbackTextFileMutation(input: {
    workspaceId: WorkspaceId;
    versionId: VersionId;
    path: string;
    mutationMomentId: VersionedTextMomentId;
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

export type ChatThreadId = string;
type ChatMessageId = string;
type ChatChannelId = string;

// A DM is a private channel subtype. Single-user alpha ships the
// kind enum only — no participant sets, presence, or DM UI yet.
export type ChatChannelKind = "channel" | "dm" | "agent";
/// What a group holds: posts, one running chat, or both.
export type ChatChannelType = "posts" | "chat" | "both";

// An automation posts only through the automation executor, which names
// itself with `ChatMessageAutomationInput`. Only people and agents react.
type ChatActor =
  | { kind: "human"; displayName: string }
  | { kind: "agent"; displayName: string }
  | { kind: "automation"; displayName: string };

// The automation executor's claim on a message it writes. Stays on this computer.
export interface ChatMessageAutomationInput {
  // `collection:<collection id>#<automation id>`.
  automationId: string;
  // One more than the depth of the change that triggered the automation.
  chainDepth: number;
}

// Which automation wrote a message on this computer. A message another
// computer's automation wrote has an automation author but no `automation`.
interface ChatMessageAutomation {
  automationId: string;
}

interface LinkedChatFileRef {
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
  type: ChatChannelType;
  purpose: string;
  // The workspace-relative folder the group's files live in. Absent for
  // dm and agent channels and for channels older than the groups migration.
  folderPath?: string;
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
// one local human actor for the single-user alpha). `lastReadSequence` counts
// messages read from the start of the thread; `revision` is server-owned and
// bumps on every applied advance — callers may CAS on it but never write it.
interface ChatThreadReadState {
  workspaceId: WorkspaceId;
  threadId: ChatThreadId;
  lastReadSequence: number;
  revision: number;
  updatedAtMs: number;
}

/// Which lane a channel thread sits in. The posts lane is the feed; the
/// chat lane is the group's one running conversation, kept out of the feed
/// and the post list.
export type ChatThreadLane = "posts" | "chat";

export interface ChatThread {
  id: ChatThreadId;
  workspaceId: WorkspaceId;
  // Display title. Untitled channel threads (the fast, no-title-prompt
  // composer path) derive this from their first message snippet at read time.
  title: string;
  createdAtMs: number;
  updatedAtMs: number;
  // Absent on older fixtures; a thread without a lane is a post.
  lane?: ChatThreadLane;
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
    authorOwnerDisplayName?: string;
    authorUserId?: string;
    createdAtMs: number;
    bodySnippet: string;
    automation?: ChatMessageAutomation;
    // Only active reactions belonging to this opening message.
    reactions: ChatReaction[];
  };
}

type ChatDecisionState = "open" | "resolved";

interface ChatDecisionRecord {
  workspaceId: WorkspaceId;
  threadId: ChatThreadId;
  messageId: ChatMessageId;
  state: ChatDecisionState;
  resolvedByMessageId?: ChatMessageId;
  atMs: number;
  // A poll's choices, in order. Absent for a bare question.
  options?: readonly string[];
  // The choice the answer named, when the poll had choices.
  chosenOption?: string;
}

interface ChatAttachment {
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
  authorOwnerDisplayName?: string;
  authorUserId?: string;
  parentMessageId?: ChatMessageId;
  origin?: "cli";
  body: string;
  createdAtMs: number;
  automation?: ChatMessageAutomation;
  attachments: ChatAttachment[];
}

interface ChatAgentReadState {
  workspaceId: WorkspaceId;
  threadId: ChatThreadId;
  lastReadCreatedAtMs: number;
  lastReadMessageId: ChatMessageId;
  revision: number;
  updatedAtMs: number;
}

interface ChatMentionRecord {
  threadId: ChatThreadId;
  messageId: ChatMessageId;
  handle: string;
  authorKind: ChatActor["kind"];
  createdAtMs: number;
}

// Reactions (WS-MU-C2). The observed cell state — an emoji reaction by an
// author is either present ("added") or tombstoned ("removed"). Tombstones are
// retained so a stale re-add cannot win the LWW register.
type ChatReactionState = "added" | "removed";

// Who reacted. Solo this is the local user/agent; the design's verified relay
// authorUserId (MU-C0) later fills authorId. displayName/kind render the
// reaction ("<User>" / "<Agent>") without a separate lookup.
interface ChatReactionAuthor {
  authorId: string;
  kind: "human" | "agent";
  displayName: string;
}

// One reaction cell as the store returns it. `listReactions` returns only
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

interface ChatFollow {
  workspaceId: WorkspaceId;
  ownerUserId: string;
  targetKind: ChatFollowTargetKind;
  targetId: string;
  state: ChatFollowState;
  updatedAtMs: number;
}

interface ChatFeedReadState {
  workspaceId: WorkspaceId;
  ownerUserId: string;
  lastSeenCreatedAtMs: number;
  lastSeenMessageId: ChatMessageId;
  updatedAtMs: number;
}

interface ChatFeedItem {
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

type ChatBookmarkTargetKind = "message" | "thread";
type ChatBookmarkMode = "live" | "snapshot";
type ChatBookmarkState = "active" | "archived";
type ChatBookmarkProjectionState = "pending" | "ready" | "failed" | "stale";

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

interface ChatBookmarkTransitionResult {
  bookmark: ChatBookmark;
  // False when a materializer reports an obsolete generation. The current
  // bookmark is returned so the worker can immediately observe newer work.
  applied: boolean;
}

type LinkedChatProjectionFileAccess =
  | { kind: "allowed"; path: string }
  | { kind: "denied" }
  | { kind: "unknown" };

interface LinkedChatProjection {
  path: string;
  readOnly: true;
  threadId: ChatThreadId;
  text: string;
}

export interface LinkedChatStore {
  // Creates a FILE-LINKED thread. linkedFile is required (exactly-one-owner
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
    type?: ChatChannelType;
    purpose?: string;
    folderPath?: string;
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
  // The fast composer path: thread + first message land in one transaction so
  // a failed send can never strand an empty thread. Title is optional — an
  // untitled thread displays its first-message snippet (the anti-forum rule).
  // The automation executor names the thread and message ids, its idempotency
  // key, and itself, so a retried step replays the recorded message.
  startChannelThread(input: {
    workspaceId: WorkspaceId;
    channelId: ChatChannelId;
    threadId?: ChatThreadId;
    messageId?: ChatMessageId;
    idempotencyKey?: string;
    automation?: ChatMessageAutomationInput;
    title?: string;
    lane?: ChatThreadLane;
    author: ChatActor;
    // WS-MU-C0: the sender's OPAQUE relay user id (Better Auth user id). Caller
    // supplies it only when signed in; the journaled message.append then carries
    // it for relay verification. Omit for solo (byte-identical to today).
    authorOwnerDisplayName?: string;
    authorUserId?: string;
    origin?: "cli";
    body: string;
    needsDecision?: boolean;
    // A poll's choices. Implies needsDecision.
    options?: string[];
    attachments?: Array<{
      objectId: WorkspaceObjectId;
      pathHint?: string;
      headingText?: string;
      headingAnchor?: string;
      headingOccurrence?: number;
    }>;
  }): Promise<{ thread: ChatThread; message: ChatMessage }>;
  // Most-recent-activity first, with derived unread counts.
  // The posts lane unless a lane is named.
  listChannelThreads(input: {
    workspaceId: WorkspaceId;
    channelId: ChatChannelId;
    lane?: ChatThreadLane;
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
    messageId?: ChatMessageId;
    idempotencyKey?: string;
    automation?: ChatMessageAutomationInput;
    author: ChatActor;
    // WS-MU-C0: the sender's OPAQUE relay user id (Better Auth user id). Caller
    // supplies it only when signed in; the journaled message.append then carries
    // it for relay verification. Omit for solo (byte-identical to today).
    authorOwnerDisplayName?: string;
    authorUserId?: string;
    parentMessageId?: ChatMessageId;
    origin?: "cli";
    body: string;
    needsDecision?: boolean;
    // A poll's choices. Implies needsDecision.
    options?: string[];
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
  getThreadRevision(input: {
    workspaceId: WorkspaceId;
    threadId: ChatThreadId;
  }): Promise<number>;
  resolveChatDecision(input: {
    workspaceId: WorkspaceId;
    threadId: ChatThreadId;
    messageId: ChatMessageId;
    resolvedByMessageId: ChatMessageId;
    // The choice, when the poll has choices. Must be one of them.
    chosenOption?: string;
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
  // Every active ("added") reaction in a thread, oldest-first per cell. The UI
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

type AgentDispatchState = "pending" | "running" | "done" | "failed";

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
  // The chain depth the run's writes declare: one more than the deepest
  // automation message among its triggers, or 0 when only people's
  // messages started it.
  chainDepth: number;
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
  latestRunForThread(workspaceId: WorkspaceId, threadId: ChatThreadId): AgentRunRecord | null;
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

export type SearchVisibility =
  | { searchable: true; projectionFileAccess?: LinkedChatProjectionFileAccess }
  | { searchable: false; reason: "ignored" | "permission-denied" | "secret" };

export type EngineFilePathClassification =
  | { kind: "tracked" }
  | { kind: "ignored" }
  | { kind: "secret" };

type VersionFileChangeStatus = "added" | "modified" | "deleted";

// One differing path, metadata only — what `versions.compareFiles` reports
// per row. The hydrated shape below is built from this by reading the sides.
interface VersionFileChangeEntry {
  path: string;
  status: VersionFileChangeStatus;
  binary?: boolean;
}

interface VersionFileChangeEntryPage {
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
  // True for secret-backed files: the change is reported
  // metadata-only — protected contents never ride a comparison, so
  // currentText/incomingText are always absent when this is set.
  protected?: boolean;
  // Binary file content is versioned byte-exactly, but comparisons are
  // metadata-only: no raw bytes and no text-shaped body ride this surface.
  binary?: boolean;
}

// --- Secret-backed files -------------------------------------------
//
// Secret-classified paths (the classifyEngineFilePath floor — policy can
// never unmark them) are versioned by a dedicated driver that stores only
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
interface SecretFileStat {
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

interface SecretFileCompareEntry {
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

interface SecretFileWriteOutcome {
  // False when the write matched the current tip exactly (no new moment).
  changed: boolean;
  moment?: SecretFileMoment;
}

interface SecretFileDeleteOutcome {
  // Null when the path was not tracked (delete of nothing is a no-op).
  moment: SecretFileMoment | null;
}

interface SecretFileRestoreOutcome {
  restored: "text" | "deleted";
  restoredMomentId: string;
  path: string;
}

type SecretFileMaterialization =
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
  // relative to the target). Page-shaped like every other listing: the
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
  // Returns the file to its state before the given moment by copying the
  // prior ciphertext forward as a new moment (history is never rewritten,
  // plaintext is never produced).
  restoreSecretFileToBeforeMoment(input: {
    workspaceId: WorkspaceId;
    momentId: string;
    metadata: ActorNeutralWriteMetadata;
  }): Promise<SecretFileRestoreOutcome>;
  // The single authorized plaintext accessor. Only dohc's own disk
  // materialization flows (version switch/merge/restore) may call this.
  materializeSecretFile(input: {
    workspaceId: WorkspaceId;
    versionId: VersionId;
    path: string;
  }): Promise<SecretFileMaterialization>;
  // Releases the underlying database handle after in-flight writes drain.
  close(): Promise<void>;
}

// Import change-author types from this module so the local-author label
// keeps the same nominal brand in every package.
declare const nonEmptyLocalAuthorLabelBrand: unique symbol;

export type NonEmptyLocalAuthorLabel = string & {
  readonly [nonEmptyLocalAuthorLabelBrand]: true;
};

export type ChangeAuthor =
  | { kind: "user"; userId: string }
  // depth is the chain depth of the agent's run: 0 unless an automation
  // started it.
  | { kind: "agent"; agentId: string; onBehalfOf: string; depth: number }
  // An automation's write, derived main-side from the claim the executor is
  // running, never from a request. automationId is the engine subscription
  // id ("collection:<collection id>#<automation id>"), and depth is the
  // write's automation-chain depth: one greater than its trigger's.
  // onBehalfOf is the run's person, left out when it has none. run names
  // the claim and the automation's name, for record history.
  | {
      kind: "automation";
      automationId: string;
      onBehalfOf?: string;
      depth: number;
      run: AutomationRunAttribution;
    }
  | { kind: "local"; label: NonEmptyLocalAuthorLabel };
