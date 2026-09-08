import type {
  HostControlSnapshot,
  HostMode,
  HostEpoch,
  HostTransitionGeneration,
} from "@dohc/live-session-contract/host-control";
import type { LiveDocumentKey, ServerDerivedLiveUpdateAuthority } from "@dohc/live-session-contract/live-update-admission";
import type { LiveObjectBinding } from "@dohc/live-session-contract/live-object-binding";
import type { RedeemedLiveTicket } from "@dohc/live-session-contract/live-ticket";
import type { DeviceHostCredential } from "../deviceHostCredential";
import type { NamedLiveBrowserContext } from "../namedLiveBrowserAuth";

export type LiveHostControlRefusalReason =
  | "not-provisioned"
  | "conflicting-provision"
  | "stale-epoch"
  | "wrong-mode"
  | "wrong-host"
  | "wrong-instance"
  | "wrong-connection"
  | "busy-transition"
  | "draining"
  | "closed"
  | "same-mode"
  | "stale-transition"
  | "completed-transition-id"
  | "exhausted-epoch"
  | "exhausted-transition-generation";

export type LiveHostControlResult =
  | { readonly ok: true; readonly snapshot: HostControlSnapshot }
  | { readonly ok: false; readonly reason: LiveHostControlRefusalReason };

export interface LiveHostConnectionCoordinate {
  readonly mode: HostMode;
  readonly hostId: string;
  readonly hostEpoch: HostEpoch;
  readonly instanceId: string;
  readonly connectionId: string;
}

export interface CurrentLiveBindingRequest {
  readonly document: LiveDocumentKey;
  readonly actor:
    | { readonly kind: "owner"; readonly userId: string; readonly shareId: string }
    | { readonly kind: "named"; readonly userId: string; readonly grantId: string };
}

export type CurrentLiveBindingResult =
  | {
      readonly kind: "current";
      readonly binding: LiveObjectBinding;
      readonly authority: ServerDerivedLiveUpdateAuthority;
      readonly host: LiveHostConnectionCoordinate;
    }
  | {
      readonly kind: "refused";
      readonly reason: "host-unavailable" | "stale-document" | "stale-selector" | "not-authorized";
    };

export interface BeginLiveHostTransitionInput {
  readonly from: LiveHostConnectionCoordinate;
  readonly toMode: HostMode;
  readonly toHostId: string;
  readonly transitionId: string;
  readonly startedAtMs: number;
  readonly guard: () => void;
}

export interface ActivateLiveHostTransitionInput {
  readonly transitionGeneration: HostTransitionGeneration;
  readonly transitionId: string;
  readonly transitionFromEpoch: HostEpoch;
  readonly mode: HostMode;
  readonly hostId: string;
  readonly hostEpoch: HostEpoch;
  readonly instanceId: string;
  readonly connectionId: string;
  readonly updatedAtMs: number;
  readonly guard: () => void;
}

export interface SyncRelayLogInput {
  originSeq: number;
  opKind: string;
  payloadJson: string;
  recordedAtMs: number;
}

export interface SyncRelayLogRow extends SyncRelayLogInput {
  workspaceId: string;
  originId: string;
  relaySeq: number;
}

export interface AppendLogBatchResult {
  inserted: number;
  skipped: number;
  currentMaxOriginSeq: number;
}

export interface FetchLogPageResult {
  rows: SyncRelayLogRow[];
  nextCursor: number;
  hasMore: boolean;
}

export interface CurrentFileStateRow {
  path: string;
  blobSha256: string;
  contentKind: "text" | "binary";
}

export interface CurrentFileStateSnapshot {
  files: CurrentFileStateRow[];
  nextCursor: number;
  epochLogFloor: number;
  tooMany: boolean;
}

export interface PutBlobResult {
  byteLength: number;
  alreadyHad: boolean;
}

export interface CollectUnreferencedBlobsResult {
  removed: number;
  removedSha256s: string[];
}

export interface KeyEnvelopeRow {
  envelopeJson: string;
  sha256: string;
  updatedAtMs: number;
}

export interface SyncRelayShareRow {
  shareId: string;
  workspaceId: string;
  granterUserId: string;
  // Validated selector JSON without access. The grant owns access.
  selectorJson: string;
  createdAtMs: number;
}

export type SyncRelayShareGrantStatus = "active" | "revoked";

export interface SyncRelayShareGrantRow {
  grantId: string;
  shareId: string;
  principalKind: "user" | "email" | "link";
  principalUserId: string | null;
  principalEmail: string | null;
  access: string;
  generation: number;
  status: SyncRelayShareGrantStatus;
  createdAtMs: number;
  revokedAtMs: number | null;
  parentGrantId: string | null;
}

export interface SyncRelayLinkCredentialRow {
  credentialId: string;
  grantId: string;
  secretHash: string;
  generation: number;
  mintedAtMs: number;
  retiredAtMs: number | null;
}

export interface SyncRelayLinkCredentialGrantRow {
  credential: SyncRelayLinkCredentialRow;
  grant: SyncRelayShareGrantRow;
}

export interface SyncRelayLinkSessionRow {
  sessionId: string;
  capabilityHash: string;
  grantId: string;
  generation: number;
  mintedAtMs: number;
  expiresAtMs: number;
  principalId: string | null;
}

export interface SyncRelayLinkPrincipalRow {
  principalId: string;
  grantId: string;
  mintGeneration: number;
  profileTokenHash: string;
  displayName: string | null;
  createdAtMs: number;
  blockedAtMs: number | null;
  discussionRevision: number;
  storageBytes: number;
}

export interface SyncRelayShareDiscussionMessageRow {
  messageId: string;
  shareId: string;
  idempotencyKey: string;
  requestHash: string;
  authorKind: "owner" | "named" | "link";
  authorUserId: string | null;
  linkGrantId: string | null;
  linkPrincipalId: string | null;
  displayNameSnapshot: string;
  body: string | null;
  createdAtMs: number;
  deletedAtMs: number | null;
  deletedByUserId: string | null;
  discussionRevision: number;
  storageBytes: number;
}

export interface SyncRelayShareDiscussionCursor {
  createdAtMs: number;
  messageId: string;
}

export interface SyncRelayShareDiscussionPageMessage
  extends SyncRelayShareDiscussionMessageRow {
  linkPrincipalBlocked: boolean | null;
}

export interface SyncRelayShareDiscussionPage {
  messages: SyncRelayShareDiscussionPageMessage[];
  nextCursor: SyncRelayShareDiscussionCursor | null;
  linkCommentsPaused: boolean;
  activityRevision: number;
}

export type SyncRelayShareDiscussionPageDirection =
  | "oldest-first"
  | "newest-first";

export interface SyncRelayShareDiscussionActivityPage {
  latestRevision: number;
  cursorRevision: number;
  hasMore: boolean;
  messages: SyncRelayShareDiscussionPageMessage[];
  principals: SyncRelayLinkPrincipalRow[];
  linkCommentsPaused: boolean;
}

export interface SyncRelayDeletedDiscussionMessage {
  messageId: string;
  createdAtMs: number;
  deletedAtMs: number;
}

export type AppendLinkDiscussionMessageResult =
  | {
      ok: true;
      replayed: boolean;
      principal: SyncRelayLinkPrincipalRow;
      message: SyncRelayShareDiscussionMessageRow;
    }
  | {
      ok: false;
      reason: "paused" | "blocked";
      activityRevision: number;
    }
  | {
      ok: false;
      reason:
        | "invalid-input"
        | "not-authorized"
        | "name-already-set"
        | "idempotency-conflict"
        | "principal-limit"
        | "rate-limit"
        | "lifetime-limit"
        | "share-limit"
        | "workspace-quota";
    };

export type AppendAuthenticatedDiscussionMessageResult =
  | {
      ok: true;
      replayed: boolean;
      message: SyncRelayShareDiscussionMessageRow;
    }
  | {
      ok: false;
      reason:
        | "invalid-input"
        | "idempotency-conflict"
        | "rate-limit"
        | "lifetime-limit"
        | "share-limit"
        | "workspace-quota";
    };

export interface SyncRelayLinkHandoffCodeRow {
  codeId: string;
  codeHash: string;
  grantId: string;
  generation: number;
  mintedAtMs: number;
  expiresAtMs: number;
}

export interface StoredSyncRelayLinkHandoffCodeRow
  extends SyncRelayLinkHandoffCodeRow {
  resultGrantId: string | null;
}

export type LinkHandoffRedeemResult =
  | {
      ok: true;
      shareId: string;
      grant: SyncRelayShareGrantRow;
    }
  | { ok: false };

export type ShareGrantTransitionResult =
  | { ok: true; grant: SyncRelayShareGrantRow }
  | { ok: false };

export type LinkGrantTransitionResult =
  | ShareGrantTransitionResult
  | {
      ok: false;
      reason: "dependents-changed";
      dependents: SyncRelayShareGrantRow[];
    };

export interface SyncRelayShareWithGrantRow {
  share: SyncRelayShareRow;
  grant: SyncRelayShareGrantRow;
}

export interface SyncRelayLinkInventoryRow extends SyncRelayShareWithGrantRow {
  dependents: SyncRelayShareGrantRow[];
  lastUsedAtMs: number | null;
  urlIssuedAtMs: number | null;
}

export interface SyncRelayLinkInventoryCursor {
  shareCreatedAtMs: number;
  shareId: string;
  linkCreatedAtMs: number;
  grantId: string;
}

export interface SyncRelayLinkInventoryPage {
  links: SyncRelayLinkInventoryRow[];
  nextCursor: SyncRelayLinkInventoryCursor | null;
}

export interface SyncRelayIndependentGrantInventoryCursor {
  shareId: string;
  grantCreatedAtMs: number;
  grantId: string;
}

export interface SyncRelayIndependentGrantInventoryPage {
  grants: SyncRelayShareGrantRow[];
  nextCursor: SyncRelayIndependentGrantInventoryCursor | null;
}

export interface SyncRelayLinkCredentialMint {
  credentialId: string;
  secretHash: string;
}

// A recipient's submitted changes, held at the relay until the
// granter accepts or declines them. `open` is the only state that can change.
export type ShareProposalState = "open" | "accepted" | "declined" | "withdrawn";

export interface ShareProposalRow {
  proposalId: string;
  shareId: string;
  workspaceId: string;
  // SERVER-derived from the authenticated submitter. Never client-supplied.
  proposedByUserId: string;
  // The one version the share exposed when this was submitted.
  versionId: string;
  state: ShareProposalState;
  createdAtMs: number;
  settledAtMs: number | null;
}

// One net change to one file. Not a moment: the relay mints the moment from
// the granter's own facts at accept (see `shareProposals.ts`).
export interface ShareProposalOpRow {
  opIndex: number;
  basedOnPath: string | null;
  // Which file the change is built on, resolved from `basedOnPath` at submit
  // and followed at accept. null for a file the granter does not have.
  basedOnObjectId: string | null;
  basedOnBlobSha256: string | null;
  operation: "write" | "delete";
  afterPath: string | null;
  afterBlobSha256: string | null;
  afterContentKind: "text" | "binary" | null;
  afterByteLength: number | null;
  recordedAtMs: number;
}

// One moment the granter's log holds for one object, as the base rewrite needs
// to describe it. `path` and `blobSha256` are null when the moment deletes the
// object.
export interface ObjectMomentRow {
  momentId: string;
  versionId: string;
  path: string | null;
  blobSha256: string | null;
  contentKind: string | null;
  byteLength: number | null;
  recordedAtMs: number;
}

export interface WorkspaceSyncIdentity {
  replicationEpoch: string;
  streamIdentity: string;
}

export interface WorkspaceBootstrap {
  hasContent: boolean;
  identity: WorkspaceSyncIdentity | null;
}

export type ClaimWorkspaceIdentityResult =
  | "claimed"
  | "matched"
  | "epoch-superseded"
  | "epoch-unknown"
  | "stream-mismatch";

export type VerifyWorkspaceIdentityResult = Exclude<
  ClaimWorkspaceIdentityResult,
  "claimed"
>;

export type EnforceWorkspaceIdentityResult =
  | ClaimWorkspaceIdentityResult
  | "identity-required";

export type RotateWorkspaceIdentityResult =
  | "rotated"
  | "not-owner"
  | "unchanged"
  | "epoch-superseded";

export interface AppendLogBatchGuardContext {
  enforceWorkspaceIdentity(
    identity: WorkspaceSyncIdentity | null,
  ): EnforceWorkspaceIdentityResult;
}

export interface SyncRelayStorage {
  close(): void;
  resolveCurrentLiveDocumentBinding(input: CurrentLiveBindingRequest): CurrentLiveBindingResult;
  mintNamedLiveTicket(input: NamedLiveTicketMint): { expiresAtMs: number } | null;
  readNamedLiveTicketTarget(input: NamedLiveTicketLookup): { workspaceId: string; objectId: string } | null;
  redeemNamedLiveTicket(input: NamedLiveTicketRedemption): RedeemedLiveTicket | null;
  getLiveHostControl(): HostControlSnapshot | null;
  // Local deployment-operator operations. Account and device requests cannot call these.
  provisionDeviceHostCredential(input: { credential: DeviceHostCredential; updatedAtMs: number }): DeviceHostCredentialResult;
  revokeDeviceHostCredential(input: { hostId: string; instanceId: string; updatedAtMs: number }): DeviceHostCredentialResult;
  // The authenticated transport supplies a fresh connection ID, never the device.
  registerDeviceHost(input: { credential: DeviceHostCredential; connectionId: string; updatedAtMs: number }): DeviceHostCredentialResult;
  disconnectDeviceHost(input: { credential: DeviceHostCredential; connectionId: string; updatedAtMs: number }): DeviceHostCredentialResult;
  provisionLiveHostControl(input: {
    mode: HostMode;
    hostId: string;
    updatedAtMs: number;
    guard: () => void;
  }): LiveHostControlResult;
  registerLiveHost(input: LiveHostConnectionCoordinate & {
    updatedAtMs: number;
    guard: () => void;
  }): LiveHostControlResult;
  disconnectLiveHost(input: LiveHostConnectionCoordinate & {
    updatedAtMs: number;
    guard: () => void;
  }): LiveHostControlResult;
  beginLiveHostTransition(input: BeginLiveHostTransitionInput): LiveHostControlResult;
  abortLiveHostTransition(input: {
    transitionId: string;
    transitionGeneration: HostTransitionGeneration;
    updatedAtMs: number;
  }): LiveHostControlResult;
  commitLiveHostTransitionEpoch(input: {
    transitionId: string;
    transitionGeneration: HostTransitionGeneration;
    updatedAtMs: number;
  }): LiveHostControlResult;
  activateLiveHostTransition(input: ActivateLiveHostTransitionInput): LiveHostControlResult;
  claimWorkspace(input: {
    workspaceId: string;
    ownerUserId: string;
    createdAtMs: number;
  }): "created" | "owned" | "not-owner";
  getWorkspaceBootstrap(workspaceId: string): WorkspaceBootstrap;
  getWorkspaceIdentity(workspaceId: string): WorkspaceSyncIdentity | null;
  getEpochLogFloor(workspaceId: string): number;
  verifyWorkspaceIdentity(input: {
    workspaceId: string;
    replicationEpoch: string;
    streamIdentity: string;
  }): VerifyWorkspaceIdentityResult;
  claimWorkspaceIdentity(input: {
    workspaceId: string;
    replicationEpoch: string;
    streamIdentity: string;
  }): ClaimWorkspaceIdentityResult;
  rotateWorkspaceIdentity(input: {
    workspaceId: string;
    ownerUserId: string;
    replicationEpoch: string;
    streamIdentity: string;
    rotatedAtMs: number;
  }): RotateWorkspaceIdentityResult;
  workspaceIsOwnedBy(workspaceId: string, ownerUserId: string): boolean;
  putBlob(input: {
    workspaceId: string;
    sha256: string;
    content: Uint8Array;
    createdAtMs: number;
  }): PutBlobResult;
  // Async + chunked so a large sweep never monopolizes the event loop on the
  // request path. Only reclaims blobs that are both unreferenced and older than
  // the retention grace window (created_at_ms <= nowMs - grace), which is what
  // keeps a blob uploaded moments before its referencing log op is appended
  // from being deleted between the two phases.
  collectUnreferencedBlobs(
    workspaceId: string,
    options: { nowMs: number },
  ): Promise<CollectUnreferencedBlobsResult>;
  getBlob(workspaceId: string, sha256: string): Uint8Array | null;
  missingBlobs(workspaceId: string, sha256s: string[]): string[];
  // Create-only on first write (expectedSha256 null), compare-and-swap
  // thereafter: the caller must present the sha256 of the envelope it intends
  // to replace. Replaced envelopes are retained in an append-only history
  // table (audit trail + server-side recovery from a bad overwrite).
  putKeyEnvelope(input: {
    workspaceId: string;
    envelopeJson: string;
    updatedAtMs: number;
    expectedSha256: string | null;
  }): { sha256: string };
  getKeyEnvelope(workspaceId: string): KeyEnvelopeRow | null;
  appendLogBatch(input: {
    workspaceId: string;
    originId: string;
    ops: SyncRelayLogInput[];
    // MU-C4 revoke-race gate: runs inside the append's BEGIN IMMEDIATE
    // transaction, i.e. under the SQLite write lock that serializes revokes,
    // before anything is inserted. A throwing guard rolls the whole batch
    // back. This is how the member-append route re-verifies the share
    // (recipient-owned, unrevoked, granter in standing) with NO window left
    // between the check and the insert — a route-level re-check alone leaves
    // a gap where a concurrent revoke commits after the check but before the
    // transaction opens.
    guard?: (context: AppendLogBatchGuardContext) => void;
  }): AppendLogBatchResult;
  fetchLogPage(input: {
    workspaceId: string;
    sinceRelaySeq: number;
    limit: number;
  }): FetchLogPageResult;
  fetchLogPageDescending(input: {
    workspaceId: string;
    beforeRelaySeq: number | null;
    limit: number;
  }): SyncRelayLogRow[];
  fetchLogCoordinate(input: {
    workspaceId: string;
    originId: string;
    originSeq: number;
  }): SyncRelayLogRow | null;
  readCurrentFileState(input: {
    workspaceId: string;
    versionId: string;
    selectorPaths: readonly string[];
    limit: number;
  }): CurrentFileStateSnapshot;
  currentFileBlobByteLength(input: {
    workspaceId: string;
    versionId: string;
    selectorPaths: readonly string[];
    sha256: string;
    epochLogFloor: number;
  }): number | null;
  createShare(input: {
    share: SyncRelayShareRow;
    grant: SyncRelayShareGrantRow;
  }): void;
  createFileLinkShare(input: {
    share: SyncRelayShareRow;
    grant: SyncRelayShareGrantRow;
    credential: SyncRelayLinkCredentialRow;
    guard: () => void;
  }): boolean;
  createLinkGrant(input: {
    grant: SyncRelayShareGrantRow;
    credential: SyncRelayLinkCredentialRow;
  }): boolean;
  getShareGrant(grantId: string): SyncRelayShareGrantRow | null;
  getCurrentLinkCredential(grantId: string): SyncRelayLinkCredentialRow | null;
  findLinkGrantByCredentialHash(
    secretHash: string,
  ): SyncRelayLinkCredentialGrantRow | null;
  rotateLinkGrant(input: {
    shareId: string;
    grantId: string;
    rotatedAtMs: number;
    expectedDependentGrantIds: readonly string[];
    guard: () => void;
    mintCredential: () => SyncRelayLinkCredentialMint;
  }): LinkGrantTransitionResult;
  retuneShareGrant(input: {
    shareId: string;
    grantId: string;
    access: string;
    changedAtMs: number;
    expectedDependentGrantIds: readonly string[];
    guard: () => void;
    mintCredential?: () => SyncRelayLinkCredentialMint;
  }): LinkGrantTransitionResult;
  revokeShareGrant(input: {
    shareId: string;
    grantId: string;
    revokedAtMs: number;
    expectedDependentGrantIds?: readonly string[];
    guard?: () => void;
  }): LinkGrantTransitionResult;
  promoteShareGrant(input: {
    shareId: string;
    grantId: string;
    expectedParentGrantId: string;
    expectedParentGeneration: number;
    guard: () => void;
  }): ShareGrantTransitionResult;
  mintLinkSession(input: {
    session: Omit<SyncRelayLinkSessionRow, "principalId">;
    guard?: () => void;
  }): boolean;
  replaceLinkSession(input: {
    currentSession: SyncRelayLinkSessionRow;
    session: Omit<SyncRelayLinkSessionRow, "principalId">;
    guard: () => void;
  }): boolean;
  findLinkSessionByCapabilityHash(
    capabilityHash: string,
  ): SyncRelayLinkSessionRow | null;
  appendLinkDiscussionMessage(input: {
    capabilityHash: string;
    profileTokenHash: string;
    claimedName?: string | null;
    body: string;
    idempotencyKey: string;
    createdAtMs: number;
    guard?: () => void;
  }): AppendLinkDiscussionMessageResult;
  appendAuthenticatedDiscussionMessage(input: {
    shareId: string;
    authorUserId: string;
    displayName: string;
    body: string;
    idempotencyKey: string;
    createdAtMs: number;
    readGuard: () => "owner" | "recipient";
    appendGuard: () => "owner" | "recipient";
  }): AppendAuthenticatedDiscussionMessageResult;
  listShareDiscussionMessages(input: {
    shareId: string;
    after?: SyncRelayShareDiscussionCursor | null;
    before?: SyncRelayShareDiscussionCursor | null;
    direction?: SyncRelayShareDiscussionPageDirection;
    limit: number;
  }): SyncRelayShareDiscussionPage;
  getShareDiscussionRevision(shareId: string): number | null;
  listShareDiscussionActivity(input: {
    shareId: string;
    sinceRevision: number;
    limit: number;
  }): SyncRelayShareDiscussionActivityPage;
  getLinkPrincipal(principalId: string): SyncRelayLinkPrincipalRow | null;
  getLinkPrincipalForGrantProfile(
    grantId: string,
    profileTokenHash: string,
  ): SyncRelayLinkPrincipalRow | null;
  setLinkPrincipalBlocked(input: {
    shareId: string;
    workspaceId: string;
    principalId: string;
    actorUserId: string;
    blockedAtMs: number | null;
  }): boolean;
  setShareLinkWritesPaused(input: {
    shareId: string;
    workspaceId: string;
    actorUserId: string;
    pausedAtMs: number | null;
  }): boolean;
  deleteShareDiscussionMessage(input: {
    shareId: string;
    workspaceId: string;
    messageId: string;
    deletedAtMs: number;
    actorUserId: string;
  }): SyncRelayDeletedDiscussionMessage | null;
  mintLinkHandoffCode(input: {
    code: SyncRelayLinkHandoffCodeRow;
    guard: () => boolean;
  }): boolean;
  hasLinkHandoffCode(codeHash: string): boolean;
  redeemLinkHandoffCode(input: {
    codeHash: string;
    principalUserId: string;
    redeemedAtMs: number;
    mintGrantId: () => string;
    guard: (code: SyncRelayLinkHandoffCodeRow) => boolean;
  }): LinkHandoffRedeemResult;
  // Claims any pending email invites addressed to `email` for `userId`,
  // changing the grant principal from email to user. Idempotent; the email
  // match is exact on the normalized (lowercased) address. Returns the number
  // of grants claimed.
  claimPendingSharesForEmail(email: string, userId: string): number;
  getShare(shareId: string): SyncRelayShareRow | null;
  listActiveShareGrantsForRecipient(
    shareId: string,
    recipientUserId: string,
  ): SyncRelayShareGrantRow[];
  listSharesGrantedBy(granterUserId: string): SyncRelayShareWithGrantRow[];
  listLinkGrantsByWorkspace(
    workspaceId: string,
    cursor?: SyncRelayLinkInventoryCursor,
  ): SyncRelayLinkInventoryPage;
  listActiveIndependentShareGrants(input: {
    workspaceId: string;
    shareIds: readonly string[];
    cursor?: SyncRelayIndependentGrantInventoryCursor;
  }): SyncRelayIndependentGrantInventoryPage;
  // Received listings exclude revoked shares entirely: after revocation the
  // recipient must not be able to read even the share's metadata (paths,
  // version names) — a revoked share is indistinguishable from one that
  // never existed.
  listSharesReceivedBy(recipientUserId: string): SyncRelayShareWithGrantRow[];
  // Idempotent; returns false only when the share does not exist.
  revokeShare(shareId: string, revokedAtMs: number): boolean;
  // Candidate moment rows for the shared-blob allowlist. Both semantics start
  // from objects that used the exact hash. Historical reads choose each
  // object's latest matching moment. Current-state reads resolve only those
  // objects' latest moments, then match the blob and path before applying the
  // cap. The share filter still makes the authorization decision.
  listObjectMomentLogRowsByBlob(input: {
    workspaceId: string;
    versionId: string;
    sha256: string;
    semantics: "historical-log" | "current-state";
    selectorPaths?: readonly string[];
  }): SyncRelayLogRow[];
  // version.create snapshot candidates use their own exact-hash index. The
  // share filter still decides which snapshots the selector exposes.
  listVersionCreateLogRowsByBlob(input: {
    workspaceId: string;
    versionId: string;
    sha256: string;
  }): SyncRelayLogRow[];
  // MU-C4 shared channels: the channelWireId bound by the earliest
  // chat.thread.create op for this threadId in the workspace's log (relay
  // order). undefined means no create exists; null means the earliest create
  // exists but carries no shareable channel binding. Earliest-wins mirrors the
  // engine's insert-if-absent thread apply, so a later forged re-create can
  // never re-bind an existing thread across a share boundary.
  findThreadCreateChannelWireId(
    workspaceId: string,
    threadId: string,
  ): string | null | undefined;
  // The kind claimed by the earliest chat.channel.create op for this wire id.
  // undefined means no create exists; null means the earliest exact create is
  // malformed/unshareable. Later duplicate creates never override the first.
  findChannelCreateKind(
    workspaceId: string,
    channelWireId: string,
  ): "channel" | "dm" | "agent" | null | undefined;
  // The file a thread is about, as claimed by the earliest
  // chat.thread.create for this threadId. Earliest-wins for the same reason
  // the channel binding uses it: a later forged re-create must not re-bind an
  // existing thread into a share. undefined means no create exists; null means
  // the earliest create exists but binds the thread to no file.
  findThreadCreateFileBinding(
    workspaceId: string,
    threadId: string,
  ): ThreadFileBinding | null | undefined;
  // Where this object sits right NOW. undefined means the relay has never
  // seen the object; null means its latest moment deleted it (or named no
  // readable path). Both deny.
  objectCurrentPath(workspaceId: string, objectId: string): string | null | undefined;
  // The object at this path right now, or undefined when none is. The reverse
  // of the lookup above; a thread bound by path is re-proved through it.
  objectIdAtPath(workspaceId: string, path: string): string | undefined;
  // Which object sits at this path, in the one version a share
  // exposes. `objectIdAtPath` above answers across every version at once, so
  // a path last touched in a side version resolves to an object that share
  // never saw — and every lookup below would then be scoped to a version that
  // object has nothing in. undefined means "nothing is there", which the
  // submit door refuses rather than minting a create.
  objectIdAtPathInVersion(input: {
    workspaceId: string;
    versionId: string;
    path: string;
  }): string | undefined;
  // The granter's own moment for this object within one version:
  // the latest one, or the latest that produced `blobSha256` when one is
  // named. The first answers "did this file drift since they sent it?"; the
  // second is the correct three-way base for a change built on that content.
  //
  // The latest match wins, because content can return to an earlier state and
  // the recipient started from the most recent moment that produced it. null
  // when no moment did, which reads as an unknown base and opens a conflict.
  //
  // A share exposes exactly one version, and the same content can sit under
  // the same object id in another one. An unscoped lookup would hand a main
  // share a base from a side version — a moment the granter's main line never
  // held — so the version is a parameter, never a default.
  objectMoment(input: {
    workspaceId: string;
    objectId: string;
    versionId: string;
    blobSha256?: string;
  }): ObjectMomentRow | null;
  // Store one submit. `submitId` is idempotent per share: a retried POST
  // returns `created: false` and the proposal it already made, so a lost
  // response can never become two proposals for one intent.
  insertShareProposal(input: {
    proposalId: string;
    shareId: string;
    workspaceId: string;
    proposedByUserId: string;
    versionId: string;
    submitId: string;
    createdAtMs: number;
    ops: ShareProposalOpRow[];
    guard?: () => void;
  }): { proposalId: string; created: boolean };
  getShareProposal(
    proposalId: string,
  ): (ShareProposalRow & { ops: ShareProposalOpRow[] }) | null;
  listShareProposalsForShare(shareId: string): Array<ShareProposalRow & { opCount: number }>;
  // The granter's open proposals, as counts rather than op rows. The review
  // surface polls this on a timer and renders a sender and a count from it, so
  // serving every op of every open proposal would resolve a base per op on
  // every tick to build rows nobody reads. One proposal's ops come from
  // getShareProposal, when a granter opens it.
  listShareProposalsForWorkspace(
    workspaceId: string,
  ): Array<ShareProposalRow & { opCount: number }>;
  // Move a proposal out of `open`. Returns false when it already moved, which
  // is how a double accept, a decline racing an accept, and a withdraw racing
  // either one all lose without a second check.
  settleShareProposal(
    proposalId: string,
    to: Exclude<ShareProposalState, "open">,
    settledAtMs: number,
  ): boolean;
  // The same move, without a transaction of its own, for a caller that already
  // holds the write lock. Accept uses it inside appendLogBatch's guard so the
  // release and the settle commit together or not at all.
  settleShareProposalInTransaction(
    proposalId: string,
    to: Exclude<ShareProposalState, "open">,
    settledAtMs: number,
  ): boolean;
  // The highest origin_seq this origin holds, or -1 when it holds none. The
  // proposal accept needs it because a proposal's changes carry no
  // coordinates: they were never a log, so the relay numbers them.
  maxOriginSeq(workspaceId: string, originId: string): number;
}

// The two wire shapes a file-linked thread create carries, kept apart because
// they come from opposite ends of a share. `object` is the granter's own op —
// its `linkedObjectId` is a granter-local id the relay resolves to a path.
// `path` is a RECIPIENT's op, pushed back through the share log: a recipient's
// object ids are its own and mean nothing here, so its create names the
// granted path directly, and the relay re-proves that path against the log.
//
// Declared here, where it is read out of the log, and re-exported by
// `shareFilter.ts` for the filter that consumes it.
export type ThreadFileBinding =
  | { kind: "object"; objectId: string }
  | { kind: "path"; path: string };

interface SqliteRunResult {
  changes: number;
  lastInsertRowid?: number | bigint;
}

interface SqliteStatement {
  all(...params: unknown[]): Array<Record<string, unknown>>;
  get(...params: unknown[]): Record<string, unknown> | undefined;
  iterate(...params: unknown[]): IterableIterator<Record<string, unknown>>;
  run(...params: unknown[]): SqliteRunResult;
}

export interface SqliteDb {
  exec(sql: string): void;
  prepare(sql: string): SqliteStatement;
  close(): void;
}

export interface OpenSyncRelayStorageOptions {
  liveTickets?: LiveTicketStoragePolicy;
  workspaceQuotaBytes?: number;
  blobGraceMs?: number;
  linkSessionsPerGrantLimit?: number;
  linkDiscussionPrincipalLimit?: number;
  discussionMessageRateLimit?: number;
  discussionLifetimeMessageLimit?: number;
  discussionNonOwnerShareRowLimit?: number;
  newDiscussionId?: () => string;
}

export type DeviceHostCredentialResult = LiveHostControlResult |
  { readonly ok: false; readonly reason: "credential-refused" };

export interface TicketHostReport {
  readonly connection: LiveHostConnectionCoordinate;
  readonly binding: LiveObjectBinding;
}

export interface NamedLiveTicketLookup {
  readonly tokenHash: string;
  readonly scope: NamedLiveBrowserContext;
  readonly audience: string;
}

export interface NamedLiveTicketMint extends NamedLiveTicketLookup {
  readonly objectId: string;
  readonly ticketId: string;
  readonly report: TicketHostReport;
}

export interface NamedLiveTicketRedemption extends NamedLiveTicketLookup {
  readonly report: TicketHostReport;
}

export interface LiveTicketStoragePolicy {
  readonly retainedTicketsPerPrincipalGrant: number;
  readonly expiredTicketCleanupBatchSize: number;
  readonly now: () => number;
}
