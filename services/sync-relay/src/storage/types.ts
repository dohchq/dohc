import type { MemberFolders } from "../shareFilter";
import type { ShareLabels } from "@dohc/security-contract/share-labels";
import type { ShareLabelReader, ShareSelector } from "../shareFilter";
import type { LiveAuthorSnapshot } from "@dohc/live-session-contract/live-authorship";
import type { ServiceActivationAccess } from "./serviceActivationAccess";
import type { ServiceActivationStore } from "./serviceActivation";
import type { LiveCommittedDeliveryStore } from "./liveCommittedDelivery";
import type { LiveJournalHistoryAuthority } from "./liveJournalHistory";
import type {
  AdmittedLiveUpdate,
  AdmittedLiveUpdateMetadata,
  LiveUpdateSubmissionMetadata,
  LiveUpdateAcceptResult,
} from "@dohc/live-session-contract/live-update-admission";
import type {
  HostControlSnapshot,
  HostMode,
  HostEpoch,
  HostTransitionGeneration,
} from "@dohc/live-session-contract/host-control";
import type {
  LiveDocumentKey,
  LiveUpdateStructRange,
  ServerDerivedLiveUpdateAuthority,
} from "@dohc/live-session-contract/live-update-admission";
import type { LiveObjectBinding } from "@dohc/live-session-contract/live-object-binding";
import type { RedeemedLiveTicket } from "@dohc/live-session-contract/live-ticket";
import type { DeviceHostCredential } from "../deviceHostCredential";
import type { LiveTicketScope } from "../liveBrowserContext";

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
    | { readonly kind: "owner"; readonly userId: string }
    | { readonly kind: "named"; readonly userId: string; readonly grantId: string }
    | {
        readonly kind: "link";
        readonly sessionId: string;
        readonly profileTokenHash: string;
        readonly grantId: string;
        readonly workspaceId: string;
      }
    // An agent connected through its link edits as the link principal its connection holds.
    | {
        readonly kind: "link";
        readonly agentConnectionId: string;
        readonly accessTokenHash: string;
        readonly resourceHash: string;
        readonly grantId: string;
        readonly workspaceId: string;
      }
    // A personal agent edits in its owner's workspace, at the fence its last fresh read returned.
    | {
        readonly kind: "personal";
        readonly workspaceId: string;
        readonly agentId: string;
        readonly connectionId: string;
        readonly accessTokenHash: string;
        readonly resourceHash: string;
        readonly fenceEpoch: number;
      };
}

export interface LiveDocumentBaselineRegistrationInput {
  readonly host: LiveHostConnectionCoordinate;
  readonly evidence: {
    readonly version: 1;
    readonly document: LiveDocumentKey;
    readonly currentPath: string;
    readonly checkpoint: {
      readonly updateDigest: string;
      readonly ranges: readonly LiveUpdateStructRange[];
    };
    readonly projectedMarkdownSha256: string;
    readonly projectedMarkdownByteLength: number;
  };
  readonly baselineBytes: Uint8Array;
  readonly registeredAtMs: number;
}

export type RelayBaselineRegistrationResult =
  | {
      readonly kind: "registered";
      readonly document: LiveDocumentKey;
      readonly currentPath: string;
      readonly restoreFenceGeneration: number;
      readonly registeredAtMs: number;
      readonly replayed: boolean;
    }
  | {
      readonly kind: "refused";
      readonly reason:
        | "invalid-baseline"
        | "host-unavailable"
        | "stale-host"
        | "stale-document"
        | "lineage-conflict"
        | "baseline-conflict";
    };

export type CurrentLiveBindingResult =
  | {
      readonly kind: "current";
      readonly binding: LiveObjectBinding;
      /** What this editor is shown of `binding`: the binding itself for an owner, the recipient's share's view for a named or link recipient. */
      readonly view: LiveObjectBinding;
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
  admittedAuthorSnapshot?: LiveAuthorSnapshot;
  settlementAdmission?: import("./hostedSettlement").SettlementAdmission;
  relayAdmission?: import("./relayAdmission").RelayAdmission;
}

export interface SyncRelayLogRow extends SyncRelayLogInput {
  workspaceId: string;
  originId: string;
  relaySeq: number;
}

export interface AppendLogBatchResult {
  registeredReferences?: string[];
  inserted: number;
  skipped: number;
  currentMaxOriginSeq: number;
  settlementRefusals?: {
    originId: string;
    originSeq: number;
    momentId: string;
    settlementId: string;
    reason: string;
  }[];
  // Copies of retained work this batch published again, each with the creation the log accepted first.
  redundantRecoveries?: RedundantRecovery[];
}

export interface RedundantRecovery {
  originSeq: number;
  recoveryMomentId: string;
  acceptedOriginId: string;
  acceptedOriginSeq: number;
  acceptedRelaySeq: number;
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
  creationProvenance?: {
    agent: import("@dohc/security-contract/approval-provenance").ApprovalAgent | null;
    selector: unknown;
    access: string;
  };
  labels?: ShareLabels;
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
  secretSealed: string | null;
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

export interface SyncRelayShareDiscussionPageMessage extends SyncRelayShareDiscussionMessageRow {
  linkPrincipalBlocked: boolean | null;
}

export interface SyncRelayShareDiscussionPage {
  messages: SyncRelayShareDiscussionPageMessage[];
  nextCursor: SyncRelayShareDiscussionCursor | null;
  linkCommentsPaused: boolean;
  activityRevision: number;
}

export type SyncRelayShareDiscussionPageDirection = "oldest-first" | "newest-first";

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

export interface StoredSyncRelayLinkHandoffCodeRow extends SyncRelayLinkHandoffCodeRow {
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

// A grant the owner gave, with the newest grant generation at which it wrote
// a Collection's automations.yaml directly (ADR 0013), or null.
export interface SyncRelayGrantedShareRow extends SyncRelayShareWithGrantRow {
  automationsGeneration: number | null;
}

export interface SyncRelayGrantedInventoryCursor {
  grantId: string;
}

export interface SyncRelayGrantedInventoryPage {
  granted: SyncRelayGrantedShareRow[];
  nextCursor: SyncRelayGrantedInventoryCursor | null;
}

export interface SyncRelayReceivedInventoryCursor {
  shareId: string;
}
export interface SyncRelayReceivedInventoryPage {
  shareIds: string[];
  nextCursor: SyncRelayReceivedInventoryCursor | null;
}

export interface SyncRelayLinkInventoryRow extends SyncRelayShareWithGrantRow {
  dependents: SyncRelayShareGrantRow[];
  lastUsedAtMs: number | null;
  urlIssuedAtMs: number | null;
  // The newest grant generation at which the link wrote a Collection's
  // automations.yaml directly (ADR 0013), or null when it never did. The
  // owner's reach check keeps such a link as a former editor once it ends,
  // and a later editing period writes under a newer generation.
  automationsGeneration: number | null;
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

export interface SyncRelayHistoryAccount {
  grantId: string;
  recipientUserId: string;
  parentGrantId: string;
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
  secretSealed: string | null;
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

export type VerifyWorkspaceIdentityResult = Exclude<ClaimWorkspaceIdentityResult, "claimed">;

export type EnforceWorkspaceIdentityResult = ClaimWorkspaceIdentityResult | "identity-required";

export type RotateWorkspaceIdentityResult =
  | "rotated"
  | "not-owner"
  | "unchanged"
  | "epoch-superseded";

export interface AppendLogBatchGuardContext {
  enforceWorkspaceIdentity(identity: WorkspaceSyncIdentity | null): EnforceWorkspaceIdentityResult;
}

export interface StoredLiveDocumentAuthority {
  binding: LiveObjectBinding;
  current: boolean;
  open: boolean;
  replacesLineageClaimId: string | null;
  baselineSequence: number;
  baselineDigest: string;
  baselineBytes: Uint8Array;
  projectedDigest: string;
  projectedLength: number;
  ranges: LiveUpdateStructRange[];
  registeredAtMs: number;
}

export interface LiveJournalStoredUpdate {
  readonly cursor: number;
  readonly digest: string;
  readonly bytes: Uint8Array;
  readonly metadata: AdmittedLiveUpdateMetadata;
}
export interface LiveUpdateJournalCut {
  readonly authorityHistory: readonly StoredLiveDocumentAuthority[];
  readonly document: LiveDocumentKey;
  readonly currentPath: string;
  readonly restoreFenceGeneration: number;
  readonly baseline: {
    readonly sequence: number;
    readonly digest: string;
    readonly bytes: Uint8Array;
    readonly ranges: readonly LiveUpdateStructRange[];
    readonly projectedDigest: string;
    readonly projectedLength: number;
    readonly registeredAtMs: number;
    readonly replacesLineageClaimId: string | null;
  };
  readonly checkpoint: {
    readonly cursor: number | null;
    readonly digest: string;
    readonly bytes: Uint8Array;
    readonly metadata: AdmittedLiveUpdateMetadata | null;
    readonly updateBytes: Uint8Array | null;
  };
  readonly suffix: readonly LiveJournalStoredUpdate[];
  readonly highWater: number | null;
  readonly suffixCount: number;
  readonly suffixBytes: number;
}
export type AcceptedLiveDocument =
  | { readonly kind: "cut"; readonly cut: LiveUpdateJournalCut }
  | { readonly kind: "none" };
/** Where reading a journal cut spent its time, in milliseconds, added across reads. */
export interface JournalCutReadTiming {
  /** The read transaction: the size queries, the rows and their decoding. */
  queryMs: number;
  /** Checking every row's digest. */
  verifyMs: number;
  /** Copying the cut for the caller. */
  copyMs: number;
}
export type LiveUpdateJournalCutResult =
  | { readonly kind: "cut"; readonly cut: LiveUpdateJournalCut }
  | {
      readonly kind: "refused";
      readonly reason: "baseline-missing" | "authority-refused" | "stale-binding";
    };
export type LiveJournalValidation =
  | {
      readonly kind: "accepted";
      readonly evidence: {
        readonly version: 1;
        readonly document: LiveDocumentKey;
        readonly currentPath: string;
        readonly checkpointDigest: string;
        readonly checkpointRanges: readonly LiveUpdateStructRange[];
        readonly suffixDigests: readonly string[];
        readonly candidate: {
          readonly updateDigest: string;
          readonly ranges: readonly LiveUpdateStructRange[];
          readonly firstSeen: readonly LiveUpdateStructRange[];
          readonly firstSeenDeletes: readonly LiveUpdateStructRange[];
        };
        readonly stateUpdate?: Uint8Array;
        readonly stateUpdateSha256: string;
        readonly stateUpdateByteLength: number;
        readonly projectedMarkdownSha256: string;
        readonly projectedMarkdownByteLength: number;
      };
    }
  | {
      readonly kind: "refused";
      readonly reason:
        | "invalid-input"
        | "invalid-update"
        | "invalid-schema"
        | "projection-mutated"
        | "capacity-refused";
      readonly source: "call" | "admitted-cut" | "candidate" | "final";
    };
export interface LiveUpdateJournalCommitInput {
  readonly trustedAccount?: { readonly accountId: string; readonly name: string };
  readonly trustedAutomation?: import("@dohc/live-session-contract/live-authorship").AutomationDeclaration;
  readonly trustedAutomationPress?: { readonly hostPressId: string; readonly automationId: string };
  readonly trustedAutomationGrant?: { readonly grantId: string; readonly grantGeneration: number };
  readonly host: LiveHostConnectionCoordinate;
  readonly actor: CurrentLiveBindingRequest["actor"];
  readonly expectedAuthority: ServerDerivedLiveUpdateAuthority;
  readonly metadata: LiveUpdateSubmissionMetadata;
  readonly cutToken: LiveUpdateJournalCut;
  readonly validation: LiveJournalValidation;
  readonly updateBytes: Uint8Array;
  readonly receivedAtMs: number;
  readonly room?: LiveRoomSave;
}
/** The access a live room edit came in under: the note's owner's, or a share's. */
export type LiveRoomAuthority = Exclude<
  ServerDerivedLiveUpdateAuthority,
  { readonly principalKind: "personal" }
>;
/**
 * A live room's save: one sender's edits, committed on the owner's capture and stored under the
 * access the sender had when the room took them.
 */
export interface LiveRoomSave {
  /** The sender, as the room credited the edits when it took them. */
  readonly authors: import("@dohc/live-session-contract/live-authorship").LiveAuthorSnapshot;
  /** The sender's access when the room took the edits. */
  readonly authority: LiveRoomAuthority;
  /**
   * Runs inside the transaction that commits the save, with the save's journal cursor. What it
   * returns runs once that transaction has committed.
   */
  readonly committed: (journalCursor: number) => () => void;
}
export type RelayLiveUpdateJournalResult =
  | {
      readonly result: Extract<LiveUpdateAcceptResult, { kind: "accepted" }>;
      readonly admitted: AdmittedLiveUpdate;
    }
  | {
      readonly result: Exclude<LiveUpdateAcceptResult, { kind: "accepted" }>;
      readonly admitted: null;
    };
export type CommittedLiveUpdateResult =
  | { readonly kind: "committed"; readonly admitted: AdmittedLiveUpdate }
  | { readonly kind: "missing" }
  | { readonly kind: "refused"; readonly reason: "stale-session" }
  | { readonly kind: "retry"; readonly reason: "host-unavailable" };

export interface SyncRelayStorage {
  indexReceivedWorkTargets(
    rows: Parameters<typeof import("./workReferences").indexReceivedWorkTargets>[1],
  ): void;
  prepareWorkReferenceRegistration(
    input: Parameters<typeof import("./workReferences").prepareWorkReferenceRegistration>[1],
  ): ReturnType<typeof import("./workReferences").prepareWorkReferenceRegistration>;
  makeWorkReference(
    input: Parameters<typeof import("./workReferences").makeWorkReference>[1],
  ): ReturnType<typeof import("./workReferences").makeWorkReference>;
  resolveWorkReference(
    input: Parameters<typeof import("./workReferences").resolveWorkReference>[1],
  ): ReturnType<typeof import("./workReferences").resolveWorkReference>;
  listWorkReferences(
    input: Parameters<typeof import("./workReferences").listWorkReferences>[1],
  ): ReturnType<typeof import("./workReferences").listWorkReferences>;
  createDatasetHost(
    options: Omit<import("../datasetHost").RelayDatasetHostOptions, "storage">,
  ): Promise<import("../datasetHost").RelayDatasetHost>;
  ensureOwnedLiveDocuments(
    inputs: readonly import("./serviceHostEnrollment").EnsureOwnedLiveDocumentInput[],
  ): readonly import("./serviceHostEnrollment").ServiceHostEnrollment[];
  ensureOwnedLiveDocument(
    input: import("./serviceHostEnrollment").EnsureOwnedLiveDocumentInput,
  ): import("./serviceHostEnrollment").ServiceHostEnrollment;
  renewPersonalSessionDemand(input: {
    workspaceId: string;
    objectId: string;
    nowMs: number;
  }): boolean;
  /** Moves one note's live record. See `moveLiveNote` in `serviceHostEnrollment`. */
  moveLiveNote(
    input: import("./serviceHostEnrollment").MoveLiveNoteInput,
  ): import("./serviceHostEnrollment").MoveLiveNoteResult;
  /** Moves each note still starting past its start period to off (start-failed). Returns those it moved. */
  failLapsedLiveNoteStarts(
    nowMs: number,
    cause: (
      enrollment: import("./serviceHostEnrollment").ServiceHostEnrollment,
    ) => import("./serviceHostEnrollment").LiveNoteStartFailure,
  ): readonly import("./serviceHostEnrollment").ServiceHostEnrollment[];
  /** Reclaims the documents only recorded demand keeps that went unused for the retention period. Returns those it reclaimed. */
  reclaimIdleLiveDocuments(
    nowMs: number,
  ): readonly import("./serviceHostEnrollment").ServiceHostEnrollment[];
  listServiceHostEnrollments(
    workspaceId?: string,
  ): readonly import("./serviceHostEnrollment").ServiceHostEnrollment[];
  listUndrainedServiceHostEnrollments(
    after?: import("./serviceHostEnrollment").ServiceHostEnrollmentCursor,
  ): {
    documents: readonly import("./serviceHostEnrollment").ServiceHostEnrollment[];
    nextCursor: import("./serviceHostEnrollment").ServiceHostEnrollmentCursor | null;
  };
  hasKeptServiceHostEnrollment(workspaceId: string, path: string): boolean;
  readServiceHostEnrollment(
    workspaceId: string,
    path: string,
  ): import("./serviceHostEnrollment").ServiceHostEnrollment | null;
  isHostedForLiveEditing(workspaceId: string, objectId: string): boolean;
  readServiceHostEnrollmentByObjectId(
    workspaceId: string,
    objectId: string,
  ): import("./serviceHostEnrollment").ServiceHostEnrollment | null;
  listRetiredServiceHostEnrollments(
    workspaceId: string,
    after?: string,
  ): {
    documents: readonly import("./serviceHostEnrollment").ServiceHostEnrollment[];
    nextCursor: string | null;
  };
  retiredAcceptedCursor(workspaceId: string, objectId: string): number | null;
  readRetiredJournalPage(
    input: Parameters<typeof import("./serviceActivationRetirement").readRetiredJournalPage>[1],
  ): import("./serviceActivationRetirement").RetiredJournalPage | null;
  currentServiceHostWorkspace(
    workspaceId: string,
    includeUndrained?: boolean,
  ): import("./serviceHostEnrollment").ServiceHostWorkspace | null;
  readServiceHostFeedScope(
    workspaceId: string,
  ): import("./serviceHostFeed").ServiceHostFeedScope | null;
  listServiceHostDocumentRows(input: {
    workspaceId: string;
    objectId: string;
    afterRelaySeq: number;
    limit: number;
  }): SyncRelayLogRow[];
  /** The relay sequence of the document's latest Y.Doc update, or 0 while it has none. */
  latestServiceHostDocumentUpdate(input: { workspaceId: string; objectId: string }): number;
  hasServiceHostConflictEffect(input: {
    workspaceId: string;
    objectId: string;
    path: string;
  }): boolean;
  canResumeMovedServiceHostEnrollment(
    enrollment: import("./serviceHostEnrollment").ServiceHostEnrollment,
    targetPath: string,
  ): boolean;
  /** Stores blob bytes the service host uploaded, with its proof of holding them. */
  putServiceHostBlob(input: {
    workspaceId: string;
    sha256: string;
    content: Uint8Array;
    createdAtMs: number;
  }): PutBlobResult;
  serviceHostUploaded(workspaceId: string, sha256: string): boolean;
  /** Proves a settling document's settlement audits before the append's writer. */
  prepareSettlementAudits(
    input: { workspaceId: string; ops: SyncRelayLogInput[]; batched: boolean },
    signal?: AbortSignal,
  ): Promise<void>;
  /** Under the append's writer: null for a settling document's verified retirement output, otherwise why it is refused. */
  admitRetirementPublication(
    retirement: import("./serviceActivationRetirement").ServiceActivationRetirement,
    op: SyncRelayLogInput,
    batch: import("./serviceActivationPublication").RetirementBatch,
  ): import("./serviceActivationPublication").RetirementRefusal | null;
  /** After confirmation: whether what that row's admission waited on was confirmed. */
  retirementPublicationConfirmed(op: SyncRelayLogInput): boolean;
  /** Owner queues the service host keeps refused, until they are delivered or the host no longer holds them. */
  recordServiceKeptEdits(input: {
    identity: import("./serviceKeptEdits").ServiceKeptEditsIdentity;
    outboxId: string;
    binding: import("@dohc/live-session-contract/live-object-binding").LiveObjectBinding;
    reason: string;
    headDeliveryId: string;
    refusalKey: string;
    nowMs: number;
  }): void;
  forgetServiceKeptEdits(queue: import("./serviceKeptEdits").ServiceKeptEditsQueue): void;
  releaseServiceKeptEdits(document: { workspaceId: string; objectId: string }): void;
  listServiceKeptEdits(
    workspaceId: string,
    after?: number,
  ): {
    keptEdits: readonly import("./serviceKeptEdits").ServiceKeptEdits[];
    nextCursor: number | null;
  };
  readServiceKeptEdits(
    queue: import("./serviceKeptEdits").ServiceKeptEditsQueue,
  ): import("./serviceKeptEdits").ServiceKeptEdits | null;
  readServiceKeptEditsRefusal(input: {
    workspaceId: string;
    outboxId: string;
    generation: number;
  }): import("./serviceKeptEdits").ServiceKeptEdits | null;
  serviceKeptEditsOf(
    document: { workspaceId: string; objectId: string },
    after?: number,
  ): {
    keptEdits: readonly import("./serviceKeptEdits").ServiceKeptEdits[];
    nextCursor: number | null;
  };
  markServiceKeptEditsRetrying(input: {
    workspaceId: string;
    outboxId: string;
    generation: number;
  }): boolean;
  endServiceKeptEditsRetry(queue: import("./serviceKeptEdits").ServiceKeptEditsQueue): void;
  confirmServiceKeptEditsCopy(input: {
    workspaceId: string;
    outboxId: string;
    generation: number;
    checkpointDigest: string | null;
  }): boolean;
  observeServiceKeptEditsCheckpoint(
    queue: import("./serviceKeptEdits").ServiceKeptEditsQueue,
    frozenCheckpoint: string | null,
  ): void;
  serviceKeptEditsHeld(
    document: { workspaceId: string; objectId: string },
    identity: import("./serviceKeptEdits").ServiceKeptEditsIdentity,
  ): boolean;
  serviceKeptEditsStoreHeld(
    workspaceId: string,
    identity: import("./serviceKeptEdits").ServiceKeptEditsIdentity,
  ): boolean;
  scanServiceHostCandidateShares(
    after?: import("./serviceHostEnrollment").ServiceHostCandidateCursor,
    workspaceId?: string,
  ): import("./serviceHostEnrollment").ServiceHostCandidatePage;
  checkServiceHostDocuments(input: {
    workspaceId: string;
    ownerUserId: string;
    shareId: string;
    paths: readonly string[];
  }): void;
  setServiceHostEnrollmentEnabled(
    input: import("./serviceHostEnrollment").SetServiceHostEnrollmentEnabledInput,
  ): import("./serviceHostEnrollment").ServiceHostEnrollment | null;
  retireIdleServiceHostEnrollment(
    input: Parameters<typeof import("./serviceHostEnrollment").retireIdleServiceHostEnrollment>[1],
  ): import("./serviceHostEnrollment").RetireIdleServiceHostEnrollmentResult;
  rebindRetiredServiceHostEnrollment(
    input: Parameters<
      typeof import("./serviceHostEnrollment").rebindRetiredServiceHostEnrollment
    >[1],
  ): import("./serviceHostEnrollment").ServiceHostEnrollment | null;
  clearDrainedDeletedServiceHostEnrollment(
    input: Parameters<
      typeof import("./serviceHostEnrollment").clearDrainedDeletedServiceHostEnrollment
    >[1],
  ): boolean;
  /** The enrolled documents an active Edit grant on the share covers. */
  serviceHostEnrollmentsCoveredByShare(
    shareId: string,
  ): readonly import("./serviceHostEnrollment").ServiceHostEnrollment[];
  /** Whether an Edit grant of its owner keeps the enrolled document live. */
  serviceHostEnrollmentCovered(
    enrollment: Pick<
      import("./serviceHostEnrollment").ServiceHostEnrollment,
      "workspaceId" | "objectId" | "ownerUserId" | "shareId" | "path"
    >,
    nowMs?: number,
  ): boolean;
  serviceHostDocumentEnabled(document: { workspaceId: string; objectId: string }): boolean;
  /** The document's open retirement obligation, if Stop recorded one its activation has not completed. */
  serviceActivationRetirement(document: {
    workspaceId: string;
    objectId: string;
  }): import("./serviceActivationRetirement").ServiceActivationRetirement | null;
  /** The workspace's open retirement obligations, by object. */
  serviceActivationRetirements(
    workspaceId: string,
  ): import("./serviceActivationRetirement").ServiceActivationRetirement[];
  /** Whether the relay holds a Y.Doc update for the document on main, so some computer has opened it live. */
  mainLiveLineageExists(document: { workspaceId: string; objectId: string }): boolean;
  serviceActivationRetirementDecision(
    document: { workspaceId: string; objectId: string },
    activation: import("./serviceActivationRetirement").RetirableServiceActivation,
  ): import("./serviceActivationRetirement").ServiceActivationRetirement | null;
  /** The prepared activation a new Stop of the document would retire, once no retirement is open. */
  retirableServiceActivation(document: {
    workspaceId: string;
    objectId: string;
  }): import("./serviceActivationRetirement").RetirableServiceActivation | null;
  /** The live journal's answer, for a retirement's reconciliation, for the deliveries it names. */
  retirementJournalEvidence(
    retirement: import("./serviceActivationRetirement").ServiceActivationRetirement,
    deliveryIds: readonly string[],
  ): {
    receipts: import("@dohc/live-session-contract/live-update-admission").LiveUpdateReceipt[];
    absent: string[];
  };
  /** Opens the retirement of a live session once nothing covers its document. Returns whether it opened one. */
  endLapsedServiceHostRun(
    enrollment: import("./serviceHostEnrollment").ServiceHostEnrollment,
    nowMs: number,
  ): boolean;
  releaseServiceHostEnrollment(input: {
    workspaceId: string;
    objectId: string;
    nowMs: number;
  }): import("./serviceHostEnrollment").ServiceHostEnrollment | null;
  readPushSubscription(
    installationId: string,
  ): import("./pushSubscriptions").PushSubscriptionRow | null;
  bindPushSubscription(
    input: import("./pushSubscriptions").BindPushSubscriptionInput,
  ): import("./pushSubscriptions").PushSubscriptionRow;
  // The account's current display name, which mentions match (storage/accountNames.ts).
  beginAccountNameLookup(): import("./accountNames").AccountNameLookupToken;
  recordAccountName(userId: string, name: string | null, nowMs?: number, generation?: number): void;
  recordAccountNames(
    entries: Iterable<readonly [string, string | null]>,
    nowMs?: number,
    generation?: number,
  ): void;
  workspaceAccountIds(workspaceId: string, limit?: number): string[];
  unnamedAccountIds(limit: number, afterUserId?: string): string[];
  removePushSubscription(input: { installationId: string; userId: string }): void;
  readPushDevice(input: {
    userId: string;
    sessionId: string;
    nowMs: number;
  }): import("./pushDevices").PushDeviceRow | null;
  bindPushDevice(
    input: import("./pushDevices").BindPushDeviceInput,
  ): import("./pushDevices").PushDeviceRow;
  removePushDevice(input: { userId: string; sessionId: string; generation: number }): void;
  fencePushSession(input: import("./pushDevices").PushSessionFence & { expiresAtMs: number }): void;
  settlePushSessionFence(
    input: import("./pushDevices").PushSessionFence & { revokedExpiresAtMs: number | null },
  ): void;
  sweepExpiredPushDevices(nowMs: number): void;
  postNotice(input: import("./notices").PostNoticeInput): void;
  postAutomationWake(
    input: import("./notices").PostAutomationWakeInput,
  ): import("./notices").PostedAutomationWake;
  readNoticeChanges(
    input: import("./notices").ReadNoticeChangesInput,
  ): import("@dohc/workspace-contracts/relay").RelayNoticePage;
  /** The recipient's Notice change head; zero for a list that never changed. */
  noticeHead(recipientUserId: string): number;
  markNotices(input: import("./notices").MarkNoticesInput): {
    dismissed: string[];
    repeated: string[];
  };
  noticeShareReceived(input: import("./notices").NoticeShareReceivedInput): void;
  pendingShareNotices(
    recipientUserId: string,
  ): { grantId: string; granterUserId: string; showsGranterEmail: boolean }[];
  readAutomationHost(
    input: import("./automationHosts").AutomationHostReadInput,
  ): import("@dohc/workspace-contracts/relay").RelayAutomationHostState;
  checkInAutomationComputer(
    input: import("./automationHosts").AutomationHostCheckInInput,
  ): import("@dohc/workspace-contracts/relay").RelayAutomationHostState;
  chooseAutomationHost(
    input: import("./automationHosts").AutomationHostChooseInput,
  ): import("@dohc/workspace-contracts/relay").RelayAutomationHostState;
  releaseAutomationHost(
    input: import("./automationHosts").AutomationHostReleaseInput,
  ): import("@dohc/workspace-contracts/relay").RelayAutomationHostState;
  takeOverAutomationHost(
    input: import("./automationHosts").AutomationHostTakeOverInput,
  ): import("@dohc/workspace-contracts/relay").RelayAutomationHostState;
  readAutomationGroupHandover(
    input: import("./automationHosts").AutomationGroupHandoverInput,
  ): import("./automationHosts").AutomationGroupHandover;
  authorizeLinkCollectionWrite(
    input: Parameters<typeof import("./collectionWrites").authorizeLinkCollectionWrite>[1],
  ): import("../shareAuthorization").AuthorizedShareAction;
  authorizeAgentCollectionWrite(
    input: Parameters<typeof import("./collectionWrites").authorizeAgentCollectionWrite>[1],
  ): import("../shareAuthorization").AuthorizedShareAction;
  automationHostRecord(
    workspaceId: string,
  ): import("@dohc/workspace-contracts/relay").RelayAutomationHost | null;
  readAutomationServerSchedules(
    workspaceId: string,
  ): import("./automationHosts").AutomationServerSchedules | null;
  beginAutomationServerCopy(input: { workspaceId: string; incarnation: number }): void;
  recordAutomationServerStart(input: {
    workspaceId: string;
    incarnation: number;
    generation: number;
    releasedThroughMs: number | null;
  }): void;
  recordAutomationServerTaken(input: { workspaceId: string; generation: number }): void;
  recordAutomationServerProgress(input: { workspaceId: string; throughMs: number }): void;
  recordAutomationServerRunChanging(
    input: Parameters<typeof import("./automationHosts").recordAutomationServerRunChanging>[1],
  ): void;
  endAutomationServerRun(input: import("./automationHosts").AutomationServerRun): boolean;
  endedAutomationServerRuns(input: {
    workspaceId: string;
    incarnation: number;
  }): Array<{ automationId: string; claimId: string; touch: number }>;
  confirmAutomationServerRunsSent(
    input: Parameters<typeof import("./automationHosts").confirmAutomationServerRunsSent>[1],
  ): void;
  markAutomationServerRunsLost(input: {
    workspaceId: string;
    incarnation: number;
    nowMs: number;
  }): void;
  lostAutomationServerRuns(
    input: Parameters<typeof import("./automationHosts").lostAutomationServerRuns>[1],
  ): import("./automationHosts").LostAutomationServerRun[];
  unreportedLostAutomationServerRuns(input: {
    workspaceId: string;
    nowMs: number;
  }): ReturnType<typeof import("./automationHosts").unreportedLostAutomationServerRuns>;
  reportAutomationServerRunsLost(
    input: Parameters<typeof import("./automationHosts").reportAutomationServerRunsLost>[1],
  ): void;
  joinAutomationWorkspace(input: {
    workspaceId: string;
    nowMs: number;
    reasons: readonly import("./automationWorkspaces").CopyReason[];
  }): import("./automationWorkspaces").AutomationWorkspace | null;
  replaceLostAutomationReplica(input: {
    workspaceId: string;
    incarnation: number;
    nowMs: number;
  }): import("./automationWorkspaces").AutomationWorkspace | null;
  unwantAutomationWorkspace(input: {
    workspaceId: string;
    nowMs: number;
  }): import("./automationWorkspaces").AutomationWorkspace | null;
  listAutomationWorkspaces(): import("./automationWorkspaces").AutomationWorkspace[];
  forgetAutomationWorkspace(input: { workspaceId: string; incarnation: number }): void;
  forgetAutomationWorkspaces(kept?: readonly string[]): void;
  endCopyReasonEverywhere(reason: import("./automationWorkspaces").CopyReason): void;
  endCopyReason(workspaceId: string, reason: import("./automationWorkspaces").CopyReason): void;
  listAccountWorkspaces(userId: string): import("./accountWorkspaces").AccountWorkspace[];
  showsOnPhone(userId: string, workspaceId: string): boolean;
  phoneRole(userId: string, workspaceId: string): import("./accountWorkspaces").PhoneRole | null;
  setShowOnPhone(input: { userId: string; workspaceId: string; showOnPhone: boolean }): boolean;
  endAccountReasonsOfHiddenOrDisownedCopies(): void;
  recordAccountOperation(
    input: import("./operationRecords").RecordOperationInput,
  ): import("./operationRecords").OperationClaim;
  lookupAccountOperation(input: {
    accountId: string;
    operationId: string;
    binding: import("./operationRecords").OperationBinding;
  }): import("./operationRecords").OperationLookup;
  advanceAccountOperation(
    input: import("./operationRecords").AdvanceOperationInput,
  ): { moved: boolean; record: import("./operationRecords").OperationRecord } | null;
  listUnfinishedAccountOperations(input: {
    workspaceId: string;
    incarnation?: number;
  }): import("./operationRecords").OperationRecord[];
  listUnfinishedOperationCopies(): Array<{ workspaceId: string; incarnation: number }>;
  /** Each workspace with phone writes still to finish, with the earliest end of their active time. */
  unfinishedOperationActiveEnds(): Array<{ workspaceId: string; activeUntilMs: number }>;
  /** The relay's row at a phone write's coordinate, only within the log rows the write's own epoch and stream could make. */
  fetchAccountOperationLogRow(
    input: Parameters<typeof import("./operationRecords").operationLogRow>[1],
  ): SyncRelayLogRow | null;
  /** The copies whose phone writes may still publish, those with a write not yet stalled first, then oldest write first. */
  publishingCopies(): import("./operationRecords").PublishingCopy[];
  /** Gives exactly those copies the `publication` reason. */
  restorePublicationReasons(): void;
  tombstoneSettledAccountOperations(nowMs: number): number;
  /** Replaces one computer's declared agents in a workspace the account owns. False, writing nothing, when it doesn't own it. */
  replaceChatRunners(
    input: Parameters<typeof import("./chatWakes").replaceChatRunners>[1],
  ): boolean;
  enabledChatRunners(input: {
    accountId: string;
    workspaceId: string;
    nowMs: number;
  }): import("./chatWakes").ChatRunner[];
  /** Every agent the account's computers have in the workspace, by ID, with its name; null when that isn't known. */
  declaredAgentNames(input: { accountId: string; workspaceId: string }): Map<string, string> | null;
  chatWakeHead(accountId: string): number;
  /** The latest generation of each wake target of messages the phone shows, in the threads it read them in. */
  phoneChatWakes(
    input: Parameters<typeof import("./chatWakes").phoneChatWakes>[1],
  ): import("@dohc/workspace-contracts/chat-wakes").PhoneChatWake[];
  /** The threads of the account's wakes in a workspace whose rows changed after `since`, through `through`. */
  chatWakeChanges(
    input: Parameters<typeof import("./chatWakes").chatWakeChanges>[1],
  ): ReturnType<typeof import("./chatWakes").chatWakeChanges>;
  listWaitingChatWakes(
    input: Parameters<typeof import("./chatWakes").listWaitingChatWakes>[1],
  ): ReturnType<typeof import("./chatWakes").listWaitingChatWakes>;
  claimChatWake(
    input: Parameters<typeof import("./chatWakes").claimChatWake>[1],
  ): ReturnType<typeof import("./chatWakes").claimChatWake>;
  confirmChatWakeQueued(
    input: Parameters<typeof import("./chatWakes").confirmChatWakeQueued>[1],
  ): import("@dohc/workspace-contracts/chat-wakes").ChatWakeView | null;
  /** The threads of every wake a retry could answer: the wake it names, and the generation its binding answered. */
  retryWakeThreads(input: Parameters<typeof import("./chatWakes").retryWakeThreads>[1]): string[];
  retryChatWake(
    input: Parameters<typeof import("./chatWakes").retryChatWake>[1],
  ): import("./chatWakes").ChatWakeRetry;
  /** Ends wakes whose wait ran out and deletes those ended long ago, a batch at a time. Answers how many rows changed. */
  sweepChatWakes(nowMs: number): number;
  accountFeedStanding(workspaceId: string): import("./accountFeed").AccountFeedStanding | null;
  accountFeedLogRows(input: {
    workspaceId: string;
    after: number;
    through: number;
    limit: number;
  }): import("./accountFeed").AccountFeedLogRow[];
  accountFeedJournalRows(input: {
    workspaceId: string;
    after: number;
    through: number;
    limit: number;
  }): Array<{ journalCursor: number; objectId: string; path: string }>;
  accountFeedThreadPaths(
    workspaceId: string,
    threadId: string,
  ): ReturnType<typeof import("./accountFeed").accountFeedThreadPaths>;
  currentAutomationWorkspace(
    workspaceId: string,
  ): import("./automationWorkspaces").AutomationWorkspace | null;
  automationWorkspaceLogSeq(input: {
    workspaceId: string;
    originId: string;
    originSeq: number;
  }): number | null;
  liveClaimLogSeq(input: { workspaceId: string; liveCursor: number }): number | null;
  serverHostedWorkspaces(): string[];
  automationWorkspaceLogHead(workspaceId: string): number;
  automationWorkspaceInfo(workspaceId: string): { ownerUserId: string; everShared: boolean } | null;
  restoreAutomationWorkspaceTimes(input: {
    workspaceId: string;
    incarnation: number;
    unwantedSinceMs: number;
    leftAtMs: number | null;
  }): void;
  commitCollectionWrite(
    input: import("./collectionWrites").CommitCollectionWriteInput,
  ): import("./collectionWrites").CommittedCollectionWrite;
  checkPersonalCollectionWriter(
    input: import("./collectionWrites").PersonalWriterInput,
    nowMs: number,
  ): void;
  commitPersonalCollectionWrite(
    input: import("./collectionWrites").CommitPersonalCollectionWriteInput,
  ): import("./collectionWrites").CommittedCollectionWrite;
  /** The folders a person in the workspace may write pages in, or null without a role. */
  memberFolders(workspaceId: string, userId: string, grantId?: string): MemberFolders | null;
  automationSwitchableFolder(workspaceId: string, folder: string): boolean;
  readOwnerCollectionWrites(
    input: import("./ownerCollectionWrites").OwnerCollectionWritesInput,
  ): import("./ownerCollectionWrites").OwnerCollectionWritesPage;
  recordAutomationPress(
    input: import("./automationPresses").RecordAutomationPressInput,
  ): import("@dohc/workspace-contracts/relay").RelayAutomationPressReceipt;
  resolveAutomationPress(
    input: Parameters<typeof import("./automationPresses").resolveAutomationPress>[1],
  ): import("@dohc/workspace-contracts/relay").RelayButtonAuthority;
  inspectAutomationButton(
    input: import("../automationButtonInspections").ButtonInspectionInput,
  ): Promise<import("@dohc/workspace-contracts/relay").RelayButtonInspection>;
  parkButtonInspectionHost(scope: import("./automationPresses").HostScope): () => void;
  listButtonInspections(
    input: import("./automationPresses").HostScope,
  ): import("@dohc/workspace-contracts/relay").RelayButtonInspectionRequest[];
  resolveButtonInspection(
    input: Parameters<typeof import("../automationButtonInspections").resolveButtonInspection>[1],
  ): import("@dohc/workspace-contracts/relay").RelayButtonAuthority;
  answerButtonInspection(
    input: Parameters<typeof import("../automationButtonInspections").answerButtonInspection>[1],
    result: import("@dohc/workspace-contracts/relay").RelayButtonInspection,
  ): void;
  listAutomationPresses(
    input: import("./automationPresses").HostScope & { nowMs: number },
  ): import("@dohc/workspace-contracts/relay").RelayAutomationPress[];
  automationPressWait(
    input: import("./automationPresses").HostScope & { nowMs: number },
  ): "not-host" | "waiting" | "empty";
  pruneExpiredAutomationPresses(nowMs: number): number;
  acceptAutomationPresses(
    input: Parameters<typeof import("./automationPresses").acceptAutomationPresses>[1],
  ): string[];
  settleAutomationPress(
    input: Parameters<typeof import("./automationPresses").settleAutomationPress>[1],
  ): import("@dohc/workspace-contracts/relay").RelayAutomationPressReceipt;
  publishAppPublication(
    input: import("./publications").PublishAppPublicationInput,
  ): import("./publications").AppPublicationRow;
  approveAppCollection(input: import("./appCollections").ApproveAppCollectionInput): {
    publicationId: string;
    authorityRevision: number;
    capability: import("@dohc/security-contract/app-publication").AppCollectionCapability | null;
  };
  acceptAppCollection(
    input: import("./appCollections").AcceptAppCollectionInput,
    policy: import("./appCollections").AppCollectionAcceptancePolicy,
  ): import("./appCollections").AppCollectionReceipt;
  readAppCollection(
    input: import("./appCollections").ReadAppCollectionInput,
  ): import("./appCollections").AppCollectionPage;
  readOwnerAppCollectionAcceptances(
    input: import("./appCollectionModeration").OwnerAppCollectionAcceptancesInput,
  ): import("./appCollectionModeration").OwnerAppCollectionAcceptancesPage;
  authorizeLinkAppCollection(
    input: import("./publications").LinkAppPublicationInput,
  ): import("./publications").LinkAppPublicationAuthority;
  readAppPublication(
    input: import("./publications").ReadAppPublicationInput,
  ): ReturnType<typeof import("./publications").readAppPublication>;
  listAppPublications(
    input: import("./publications").ListAppPublicationsInput,
  ): ReturnType<typeof import("./publications").listAppPublications>;
  listLinkAppPublications(
    input: import("./publications").ListLinkAppPublicationsInput,
  ): ReturnType<typeof import("./publications").listLinkAppPublications>;
  withdrawAppPublication(
    input: import("./publications").WithdrawAppPublicationInput,
  ): import("./publications").AppPublicationState;
  disableAppPublication(
    input: import("./publications").DisableAppPublicationInput,
  ): import("./publications").AppPublicationTakedownResult;
  liftAppPublishingHold(publicationId: string): boolean;
  reactivateAppPublication(
    input: import("./publications").ReactivateAppPublicationInput,
  ): import("./publications").AppPublicationState;
  authorizeLinkAppPublication(
    input: import("./publications").LinkAppPublicationInput,
  ): import("./publications").LinkAppPublicationAuthority;
  createLinkAppPublicationGuard(
    input: import("./publications").LinkAppPublicationInput,
  ): (nowMs: number) => void;
  readLinkAppPublicationBlob(
    input: import("./publications").LinkAppPublicationInput & {
      sha256: string;
      expectedAuthorityRevision: number;
    },
  ): import("./publications").LinkAppPublicationAuthority & {
    file: import("@dohc/security-contract/app-publication").AppPublicationCandidate["files"][number];
    bytes: Uint8Array;
  };
  readonly unavailable: AbortSignal;
  captureStanding(): () => void;
  createLiveCommittedDeliveryStore(
    history: LiveJournalHistoryAuthority,
    activation?: ServiceActivationAccess,
  ): LiveCommittedDeliveryStore;
  createServiceActivationStore(history: LiveJournalHistoryAuthority): ServiceActivationStore;
  liveNoteFormatOff(document: LiveDocumentKey): boolean;
  readLiveUpdateJournalCut(
    input: { document: LiveDocumentKey },
    reserveBytes?: (size: number) => void,
    timing?: JournalCutReadTiming,
  ): LiveUpdateJournalCutResult;
  commitLiveUpdateJournal(
    input: LiveUpdateJournalCommitInput,
    activation?: ServiceActivationAccess,
  ): RelayLiveUpdateJournalResult;
  readCommittedLiveUpdate(input: {
    host: LiveHostConnectionCoordinate;
    document: LiveDocumentKey;
    journalCursor: number;
  }): CommittedLiveUpdateResult;

  close(): void;
  invalidate(): void;
  resolveCurrentLiveDocumentBinding(
    input: CurrentLiveBindingRequest,
    activation?: ServiceActivationAccess,
  ): CurrentLiveBindingResult;
  /** The same check from the live row's metadata, reading no baseline bytes. */
  resolveCurrentLiveDocumentBindingFromMetadata(
    input: CurrentLiveBindingRequest,
  ): CurrentLiveBindingResult;
  automationRecordWriteAllowed(input: {
    workspaceId: string;
    ownerUserId: string;
    currentPath: string;
    declaration: import("@dohc/live-session-contract/live-authorship").AutomationDeclaration;
    authority:
      | { readonly hostPressId: string; readonly automationId: string }
      | { readonly grantId: string; readonly grantGeneration: number };
  }): boolean;
  automationRecordBinding(
    workspaceId: string,
    ownerUserId: string,
    path: string,
  ): { binding: LiveObjectBinding } | null;
  /**
   * The accepted state of the live document now at `path` in main: its
   * journal cut, or "none" when the settled file is the page.
   */
  readAcceptedLiveDocument(workspaceId: string, path: string): AcceptedLiveDocument;
  automationRecordJournalCursor(binding: LiveObjectBinding): number;
  /** Groups synchronous authority checks in one current read snapshot. */
  readLiveAuthority<T>(run: () => T): T;
  resolveLiveObjectHostBinding(
    scope: LiveTicketScope,
    objectId: string,
  ): import("./liveDocumentAuthority").LiveObjectHostBindingResult;
  registerLiveDocumentBaseline(
    input: LiveDocumentBaselineRegistrationInput,
  ): RelayBaselineRegistrationResult;
  mintLiveTicket(input: LiveTicketMint): { expiresAtMs: number; publicPrincipalId?: string } | null;
  readLiveTicketTarget(input: LiveTicketLookup): { workspaceId: string; objectId: string } | null;
  /** Whether a link browser's ticket would enroll one browser more than its link takes. */
  liveLinkFull(scope: LiveTicketScope): boolean;
  redeemLiveTicket(input: LiveTicketRedemption): RedeemedLiveTicket | null;
  getLiveHostControl(): HostControlSnapshot | null;
  // Local deployment-operator operations. Account and device requests cannot call these.
  provisionDeviceHostCredential(input: {
    credential: DeviceHostCredential;
    updatedAtMs: number;
  }): DeviceHostCredentialResult;
  revokeDeviceHostCredential(input: {
    hostId: string;
    instanceId: string;
    updatedAtMs: number;
  }): DeviceHostCredentialResult;
  // The authenticated transport supplies a fresh connection ID, never the device.
  registerDeviceHost(input: {
    credential: DeviceHostCredential;
    connectionId: string;
    updatedAtMs: number;
  }): DeviceHostCredentialResult;
  disconnectDeviceHost(input: {
    credential: DeviceHostCredential;
    connectionId: string;
    updatedAtMs: number;
  }): DeviceHostCredentialResult;
  provisionLiveHostControl(input: {
    mode: HostMode;
    hostId: string;
    updatedAtMs: number;
    guard: () => void;
  }): LiveHostControlResult;
  registerLiveHost(
    input: LiveHostConnectionCoordinate & {
      updatedAtMs: number;
      guard: () => void;
    },
  ): LiveHostControlResult;
  disconnectLiveHost(
    input: LiveHostConnectionCoordinate & {
      updatedAtMs: number;
      guard: () => void;
    },
  ): LiveHostControlResult;
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
  workspaceOwner(workspaceId: string): string | null;
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
  prepareLogAppend(
    input: { workspaceId: string; originId: string; ops: SyncRelayLogInput[] },
    signal?: AbortSignal,
  ): Promise<void>;
  appendLogBatch(input: {
    workspaceId: string;
    originId: string;
    ops: SyncRelayLogInput[];
    // Revoke-race gate: runs inside the append's BEGIN IMMEDIATE
    // transaction, i.e. under the SQLite write lock that serializes revokes,
    // before anything is inserted. A throwing guard rolls the whole batch
    // back. This is how the member-append route re-verifies the share
    // (recipient-owned, unrevoked, granter in standing) with NO window left
    // between the check and the insert — a route-level re-check alone leaves
    // a gap where a concurrent revoke commits after the check but before the
    // transaction opens.
    guard?: (context: AppendLogBatchGuardContext) => void;
    // Runs after the guard, under the same lock, with the ops at coordinates
    // the log does not hold yet. It may refuse an op or mark it departed.
    admit?: (ops: SyncRelayLogInput[]) => void;
    // Runs after settlement and application confirmation, still under the
    // lock, with the same ops. It may refuse an op that confirmation did not prove.
    confirm?: (ops: SyncRelayLogInput[]) => void;
    // The owner's publication lane: a copy of retained work another device
    // already published keeps its coordinate and changes nothing else.
    classifyRedundantRecoveries?: boolean;
    workReferences?: {
      userId: string;
      references: readonly import("@dohc/workspace-engine-client/daemon").WorkReferenceMapping[];
      datasetAccess?: import("./workReferences").DatasetReferenceAccess;
    };
  }): AppendLogBatchResult;
  fetchLogPage(input: {
    workspaceId: string;
    sinceRelaySeq: number;
    limit: number;
  }): FetchLogPageResult;
  /** Whether `fetchLogPage` with `limit: count` would report `hasMore`, without reading the rows. */
  logHasMoreThan(input: { workspaceId: string; sinceRelaySeq: number; count: number }): boolean;
  fetchLogPageDescending(input: {
    workspaceId: string;
    beforeRelaySeq: number | null;
    limit: number;
  }): SyncRelayLogRow[];
  fetchChatMessages(input: {
    workspaceId: string;
    channelWireId: string;
    cursor: number | null;
    direction: "older" | "newer";
    limit: number;
  }): FetchLogPageResult & { latestCursor: number };
  fetchChannelMessages(input: {
    workspaceId: string;
    cursor: number | null;
    direction: "older" | "newer";
    limit: number;
  }): FetchLogPageResult & { latestCursor: number };
  fetchCommentMessages(input: {
    workspaceId: string;
    objectId: string;
    path: string;
    cursor: number | null;
    direction: "older" | "newer";
    limit: number;
  }): FetchLogPageResult & { latestCursor: number };
  fetchThreadMessages(input: {
    workspaceId: string;
    threadId: string;
    cursor: number | null;
    direction: "older" | "newer";
    limit: number;
  }): FetchLogPageResult & { latestCursor: number };
  fetchChatMessage(input: {
    workspaceId: string;
    originId: string;
    messageId: string;
  }): SyncRelayLogRow | null;
  appendBrowserChatBatch(input: {
    workspaceId: string;
    originId: string;
    messageId: string;
    ops: SyncRelayLogInput[];
    guard?: (context: AppendLogBatchGuardContext) => void;
    wakes?: import("./chatWakes").BrowserPostWakes;
  }): AppendLogBatchResult;
  appendLinkChatPost(
    input: Parameters<typeof import("./linkChat").appendLinkChatPost>[1],
  ): import("./linkChat").AppendLinkChatPostResult;
  appendAgentChatPost(
    input: Parameters<typeof import("./linkChat").appendAgentChatPost>[1],
  ): import("./linkChat").AppendAgentChatPostResult;
  linkPrincipalThreadIds(workspaceId: string, principalId: string): Set<string>;
  registerAgentClient(
    input: Parameters<typeof import("./agentConnections").registerAgentClient>[1],
  ): boolean;
  getAgentClient(clientId: string): import("./agentConnections").AgentClientRow | null;
  beginAgentAuthorization(
    input: Parameters<typeof import("./agentConnections").beginAgentAuthorization>[1],
  ): boolean;
  readAgentAuthorization(
    requestHash: string,
    nowMs: number,
  ): import("./agentConnections").AgentAuthorizationRow | null;
  decideAgentAuthorization(
    input: Parameters<typeof import("./agentConnections").decideAgentAuthorization>[1],
  ): import("./agentConnections").AgentAuthorizationDecision;
  redeemAgentAuthorizationCode(
    input: Parameters<typeof import("./agentConnections").redeemAgentAuthorizationCode>[1],
  ): import("./agentConnections").AgentTokenGrantResult;
  refreshAgentTokens(
    input: Parameters<typeof import("./agentConnections").refreshAgentTokens>[1],
  ): import("./agentConnections").AgentTokenGrantResult;
  authenticateAgentAccessToken(
    accessTokenHash: string,
    nowMs: number,
  ): import("./agentConnections").AgentConnectionRow | null;
  authenticateAgentAuthority(
    check: import("./agentConnections").AgentAccessCheck,
    nowMs: number,
  ): import("./agentConnections").AgentConnectionRow | null;
  recordAgentConnectionAction(connectionId: string, atMs: number): void;
  listAgentConnections(
    input: Parameters<typeof import("./agentConnections").listAgentConnections>[1],
  ): import("./agentConnections").AgentConnectionPage;
  disconnectAgentConnection(
    input: Parameters<typeof import("./agentConnections").disconnectAgentConnection>[1],
  ): import("./agentConnections").AgentConnectionRow | null;
  beginPersonalAuthorization(
    input: Parameters<typeof import("./personalAgents").beginPersonalAuthorization>[1],
  ): boolean;
  readPersonalAuthorization(
    requestHash: string,
    nowMs: number,
  ): import("./personalAgents").PersonalAuthorizationRow | null;
  cancelPersonalAuthorization(
    requestHash: string,
    nowMs: number,
  ): import("./personalAgents").PersonalAuthorizationRow | null;
  allowPersonalAuthorization(
    input: Parameters<typeof import("./personalAgents").allowPersonalAuthorization>[1],
  ): import("./personalAgents").PersonalAuthorizationRow | null;
  personalCredentialOwner(
    credential: Parameters<typeof import("./personalAgents").personalCredentialOwner>[1],
  ): string | null;
  redeemPersonalAuthorizationCode(
    input: Parameters<typeof import("./personalAgents").redeemPersonalAuthorizationCode>[1],
  ): import("./personalAgents").PersonalTokenGrant;
  refreshPersonalTokens(
    input: Parameters<typeof import("./personalAgents").refreshPersonalTokens>[1],
  ): import("./personalAgents").PersonalTokenGrant;
  authenticatePersonalAuthority(
    check: import("./agentConnections").AgentAccessCheck,
    fenceEpoch: number,
    nowMs: number,
  ): import("./personalAgents").PersonalConnectionRow | null;
  listPersonalAgents(ownerUserId: string): import("./personalAgents").PersonalRoster;
  // Opens no transaction, so a read inside another read uses its snapshot.
  personalRosterRevision(ownerUserId: string): number;
  changePersonalAgent(
    input: Parameters<typeof import("./personalAgents").changePersonalAgent>[1],
  ): import("./personalAgents").PersonalAgentChangeResult;
  revokePersonalCredentialsBelowFence(ownerUserId: string, epoch: number): string[];
  signOutAccountPersonalAgents(ownerUserId: string): string[];
  readCredentialFencePosition(): number;
  advanceCredentialFencePosition(changedAtMs: number): void;
  setWorkspaceDisplayName(
    input: Parameters<typeof import("./personalAgents").setWorkspaceDisplayName>[1],
  ): boolean;
  readPersonalScope(
    credential: import("./personalAgentChat").PersonalCredential,
    nowMs: number,
  ): import("./personalAgentChat").PersonalScope | null;
  readPersonalReach(
    credential: import("./personalAgentChat").PersonalCredential,
    workspaceId: string,
    nowMs: number,
  ): import("./personalAgentChat").PersonalReachRead;
  readPersonalWorkspaces(
    credential: import("./personalAgentChat").PersonalCredential,
    nowMs: number,
  ): import("./personalAgentChat").PersonalWorkspaces | null;
  appendPersonalChatPost(
    input: Parameters<typeof import("./personalAgentChat").appendPersonalChatPost>[1],
  ): import("./personalAgentChat").AppendPersonalChatPostResult;
  personalAgentPostedIn(
    input: Parameters<typeof import("./personalAgentChat").personalAgentPostedIn>[1],
  ): boolean;
  readPersonalWaitWindow(
    input: Parameters<typeof import("./personalAgentChat").readPersonalWaitWindow>[1],
  ): import("./personalAgentChat").PersonalWaitWindow;
  fetchLogCoordinate(input: {
    workspaceId: string;
    originId: string;
    originSeq: number;
  }): SyncRelayLogRow | null;
  hasRefusedSettlement(input: {
    workspaceId: string;
    originId: string;
    originSeq: number;
    settlementId: string;
    momentId: string;
    reason: string;
  }): boolean;
  readCurrentFileState(input: {
    workspaceId: string;
    versionId: string;
    selectorPaths: readonly string[];
    limit: number;
    /** Lists only files at a path this passes, paging past the rest. */
    visible?: (path: string) => boolean;
  }): CurrentFileStateSnapshot;
  currentFileBlobByteLength(input: {
    workspaceId: string;
    versionId: string;
    selectorPaths: readonly string[];
    sha256: string;
    epochLogFloor: number;
    visible?: (path: string) => boolean;
    pastHidden?: true;
  }): number | null;
  listLinkRevisionLogRows(input: {
    workspaceId: string;
    versionId: string;
    selectorPaths: readonly string[];
    sha256: string;
    epochLogFloor: number;
  }): SyncRelayLogRow[];
  captureReadRevisionMatches(): () => boolean;
  listCurrentFileLogRowsByBlob(input: {
    workspaceId: string;
    versionId: string;
    selectorPaths: readonly string[];
    sha256: string;
    afterPath?: string;
  }): Array<{ path: string; row: SyncRelayLogRow }>;
  isCurrentFileState(input: {
    workspaceId: string;
    versionId: string;
    path: string;
    relaySeq: number;
  }): boolean;
  readShareTx<T>(read: () => T): T;
  /** The workspace log's newest relay seq, read in the caller's share read when there is one. */
  shareLogHead(workspaceId: string): number;
  memberReach(
    workspaceId: string,
    userId: string,
    role: "admin" | "member",
    level: import("@dohc/security-contract/share-selector").ShareAccess,
  ): import("./memberReach").MemberReach;
  refreshAccountEmail(
    userId: string,
    email: import("./accountEmails").AccountEmail | null,
    nowMs: number,
  ): void;
  currentObjectFile(input: {
    workspaceId: string;
    versionId: string;
    objectId: string;
    epochLogFloor: number;
  }): CurrentFileStateRow | null | "reset";
  currentFileBlobSha256(input: {
    workspaceId: string;
    versionId: string;
    path: string;
  }): string | undefined;
  currentFileObjectId(input: {
    workspaceId: string;
    versionId: string;
    path: string;
  }): string | undefined;
  currentObjectPath(input: {
    workspaceId: string;
    versionId: string;
    objectId: string;
  }): string | null;
  currentObjectBlobByteLength(input: {
    workspaceId: string;
    versionId: string;
    selectorPaths: readonly string[];
    objectId: string;
    sha256: string;
    epochLogFloor: number;
  }): number | null;
  laterObjectMomentPaths(input: {
    workspaceId: string;
    versionId: string;
    objectId: string;
    afterRelaySeq: number;
    limit: number;
  }): Array<string | null>;
  /** False, with nothing written, when the recipient account is being deleted. */
  createShare(input: { share: SyncRelayShareRow; grant: SyncRelayShareGrantRow }): boolean;
  readLinkCreation(
    workspaceId: string,
    operationId: string,
    ownerUserId: string,
  ): { shareId: string; grantId: string; requestJson: string } | null;
  createFileLinkShare(input: {
    operation?: { operationId: string; requestJson: string };
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
  findLinkGrantByCredentialHash(secretHash: string): SyncRelayLinkCredentialGrantRow | null;
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
  retuneNamedShareGrant(input: {
    shareId: string;
    grantId: string;
    access: string;
    changedAtMs: number;
    guard: () => void;
  }): ShareGrantTransitionResult;
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
  findLinkSessionByCapabilityHash(capabilityHash: string): SyncRelayLinkSessionRow | null;
  appendLinkDiscussionMessage(
    input: import("./discussion").AppendLinkDiscussionMessageInput,
  ): AppendLinkDiscussionMessageResult;
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
  mintLinkHandoffCode(input: { code: SyncRelayLinkHandoffCodeRow; guard: () => boolean }): boolean;
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
  // Whether a current pending invite is addressed to `email`, matched on the
  // same normalized address a claim uses.
  hasPendingInvite(email: string): boolean;
  // Workspace members (storage/workspaceMembers.ts).
  workspaceMemberGrantIsCurrent: WorkspaceMembersMethod<"workspaceMemberGrantIsCurrent">;
  workspaceMemberGrantRole: WorkspaceMembersMethod<"workspaceMemberGrantRole">;
  workspaceRoleOf: WorkspaceMembersMethod<"workspaceRoleOf">;
  listJoinedWorkspaces: WorkspaceMembersMethod<"listJoinedWorkspaces">;
  workspaceLevelChangedBy: WorkspaceMembersMethod<"workspaceLevelChangedBy">;
  readWorkspaceMembers: WorkspaceMembersMethod<"readWorkspaceMembers">;
  getWorkspaceMembershipByShare: WorkspaceMembersMethod<"getWorkspaceMembershipByShare">;
  inviteWorkspaceMember: WorkspaceMembersMethod<"inviteWorkspaceMember">;
  setWorkspaceMemberLevel: WorkspaceMembersMethod<"setWorkspaceMemberLevel">;
  setWorkspaceMemberRole: WorkspaceMembersMethod<"setWorkspaceMemberRole">;
  removeWorkspaceMember: WorkspaceMembersMethod<"removeWorkspaceMember">;
  letWorkspaceMemberBackIn: WorkspaceMembersMethod<"letWorkspaceMemberBackIn">;
  leaveWorkspace: WorkspaceMembersMethod<"leaveWorkspace">;
  endWorkspaceMembership: WorkspaceMembersMethod<"endWorkspaceMembership">;
  changeWorkspaceInviteLink: WorkspaceMembersMethod<"changeWorkspaceInviteLink">;
  inviteLinkAdmitsSignUp: WorkspaceMembersMethod<"inviteLinkAdmitsSignUp">;
  previewWorkspaceJoin: WorkspaceMembersMethod<"previewWorkspaceJoin">;
  joinWorkspace: WorkspaceMembersMethod<"joinWorkspace">;
  createWorkspaceGroup: WorkspaceMembersMethod<"createWorkspaceGroup">;
  setWorkspaceGroupRule: WorkspaceMembersMethod<"setWorkspaceGroupRule">;
  // Deleted messages (storage/messageDeletes.ts).
  deleteWorkspaceMessage: MessageDeletesMethod<"deleteWorkspaceMessage">;
  deletedMessageCount: MessageDeletesMethod<"deletedMessageCount">;
  messageDeleted: MessageDeletesMethod<"messageDeleted">;
  deletedMessageTimes: MessageDeletesMethod<"deletedMessageTimes">;
  // Folder rules (storage/folderRules.ts).
  changeFolderRule: FolderRulesMethod<"changeFolderRule">;
  removeFolderMarkers: FolderRulesMethod<"removeFolderMarkers">;
  readFolderRules: FolderRulesMethod<"readFolderRules">;
  // Direct messages (storage/directMessages.ts).
  resolveDirectPick: DirectMessagesMethod<"resolveDirectPick">;
  findDirectConversation: DirectMessagesMethod<"findDirectConversation">;
  directPerson: DirectMessagesMethod<"directPerson">;
  sendDirectMessage: DirectMessagesMethod<"sendDirectMessage">;
  listDirectConversations: DirectMessagesMethod<"listDirectConversations">;
  readDirectMessages: DirectMessagesMethod<"readDirectMessages">;
  markDirectRead: DirectMessagesMethod<"markDirectRead">;
  setDirectBlock: DirectMessagesMethod<"setDirectBlock">;
  directRevision: DirectMessagesMethod<"directRevision">;
  shareHasActiveGrants(shareId: string): boolean;
  getShareLabels(
    shareId: string,
    reader: ShareLabelReader,
    readerFiles?: ShareSelector | null,
  ): ShareLabels;
  setShareLabels(shareId: string, labels: ShareLabels, updatedAtMs: number): void;
  getShare(shareId: string): SyncRelayShareRow | null;
  listActiveShareGrantsForRecipient(
    shareId: string,
    recipientUserId: string,
  ): SyncRelayShareGrantRow[];
  listSharesGrantedBy(granterUserId: string): SyncRelayGrantedShareRow[];
  listSharesGrantedPage(
    granterUserId: string,
    workspaceId: string,
    cursor?: SyncRelayGrantedInventoryCursor,
  ): SyncRelayGrantedInventoryPage;
  listLinkGrantsByWorkspace(
    workspaceId: string,
    cursor?: SyncRelayLinkInventoryCursor,
  ): SyncRelayLinkInventoryPage;
  lookupHistoryAccounts(
    workspaceId: string,
    grantIds: readonly string[],
    userIds: readonly string[],
  ): SyncRelayHistoryAccount[];
  listActiveIndependentShareGrants(input: {
    workspaceId: string;
    shareIds: readonly string[];
    cursor?: SyncRelayIndependentGrantInventoryCursor;
  }): SyncRelayIndependentGrantInventoryPage;
  // Active listings never disclose revoked selectors. Removed named recipients
  // receive only their grant ID, share ID, removal time, and an explanation.
  listSharesReceivedBy(recipientUserId: string): SyncRelayShareWithGrantRow[];
  listReceivedShareIdsPage(
    recipientUserId: string,
    cursor?: SyncRelayReceivedInventoryCursor,
  ): SyncRelayReceivedInventoryPage;
  removeShareAccess(
    input: import("./shareRemoval").ShareRemovalInput,
  ): ReturnType<typeof import("./shareRemoval").removeShareAccess>;
  undoShareRemoval(input: Parameters<typeof import("./shareRemoval").undoShareRemoval>[1]): void;
  purgeExpiredShareRemovals(nowMs: number): void;
  listRemovedSharesForRecipient(
    userId: string,
    shareId?: string,
  ): ReturnType<typeof import("./shareRemoval").listRemovedSharesForRecipient>;
  listRemovedSharesInRecipientList(
    userId: string,
    shareId?: string,
  ): ReturnType<typeof import("./shareRemoval").listRemovedSharesInRecipientList>;
  leaveShare(
    input: Parameters<typeof import("./shareRemoval").leaveShare>[1],
  ): ReturnType<typeof import("./shareRemoval").leaveShare>;
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
    aboveRelaySeq?: number;
  }): SyncRelayLogRow[];
  // Shared channels: the channelWireId bound by the earliest
  // chat.thread.create op for this threadId in the workspace's log (relay
  // order). undefined means no create exists; null means the earliest create
  // exists but carries no shareable channel binding. Earliest-wins mirrors the
  // engine's insert-if-absent thread apply, so a later forged re-create can
  // never re-bind an existing thread across a share boundary.
  findThreadCreateChannelWireId(workspaceId: string, threadId: string): string | null | undefined;
  // The kind claimed by the earliest chat.channel.create op for this wire id.
  // undefined means no create exists; null means the earliest exact create is
  // malformed/unshareable. Later duplicate creates never override the first.
  findChannelCreateKind(
    workspaceId: string,
    channelWireId: string,
  ): "channel" | "dm" | "agent" | null | undefined;
  findChannelCreateFolderPath(
    workspaceId: string,
    channelWireId: string,
  ): string | null | undefined;
  /** Each channel's earliest create, in log order: its wire id, name, type, and purpose, null when it has none. */
  listChannelCreates(workspaceId: string): {
    channelWireId: string;
    name: string;
    type: "posts" | "chat" | "both";
    purpose: string | null;
  }[];
  findThreadCreateLane(workspaceId: string, threadId: string): "posts" | "chat" | undefined;
  findThreadFirstMessageId(workspaceId: string, threadId: string): string | undefined;
  ownerComputerMessage(
    workspaceId: string,
    threadId: string,
    messageId: string,
  ): ReturnType<typeof import("./objectIndex").ownerComputerMessage>;
  findChannelChatThread(workspaceId: string, channelWireId: string): string | null;
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
  // Where the object last was: the path its latest moment named in any
  // version, as the relay's log recorded it. undefined when the relay holds no
  // moment of the object.
  objectLastKnownPath(workspaceId: string, objectId: string): string | undefined;
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
  getShareProposal(proposalId: string): (ShareProposalRow & { ops: ShareProposalOpRow[] }) | null;
  listShareProposalsForShare(
    shareId: string,
    proposedByUserId: string,
  ): Array<ShareProposalRow & { opCount: number }>;
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
  listWorkspaceSecrets(
    workspaceId: string,
  ): import("@dohc/workspace-contracts/workspace-secrets").WorkspaceSecretSummary[];
  readWorkspaceSecretForExecution(
    workspaceId: string,
    name: string,
  ): import("./workspaceSecrets").StoredWorkspaceSecret | null;
  upsertWorkspaceSecret(
    input: Parameters<typeof import("./workspaceSecrets").upsertWorkspaceSecret>[1],
  ): import("./workspaceSecrets").UpsertWorkspaceSecretResult;
  deleteWorkspaceSecret(
    workspaceId: string,
    ownerUserId: string,
    name: string,
  ): import("./workspaceSecrets").DeleteWorkspaceSecretResult;
  listWorkspaceSecretSeals(): import("./workspaceSecrets").WorkspaceSecretSeal[];
  replaceWorkspaceSecretSeal(
    seal: import("./workspaceSecrets").WorkspaceSecretSeal,
    next: { readonly keyId: string; readonly sealedValue: string },
  ): boolean;
  listWorkspaceHttpStepApprovals(workspaceId: string): string[];
  hasWorkspaceHttpStepApproval(workspaceId: string, approvalDigest: string): boolean;
  approveWorkspaceHttpStep(
    input: Parameters<typeof import("./outboundWebhooks").approveWorkspaceHttpStep>[1],
  ): import("./outboundWebhooks").ApproveWorkspaceHttpStepResult;
  reserveWorkspaceHttpDispatch<Refusal = never>(input: {
    readonly workspaceId: string;
    readonly ownerUserId: string;
    readonly deliveryId: string;
    readonly nowMs: number;
    readonly beforeReserve?: () => Refusal | null;
  }): import("./outboundWebhooks").ReserveWorkspaceHttpDispatchResult<Refusal>;
  listActiveWorkspaceShareGrants(
    workspaceId: string,
  ): import("./outboundWebhooks").ActiveWorkspaceShareGrantRow[];
  finalizeWorkspaceHttpDispatch(
    input: Parameters<typeof import("./outboundWebhooks").finalizeWorkspaceHttpDispatch>[1],
  ): void;
  readCommittedWorkspaceTextFile(
    workspaceId: string,
    versionId: string,
    path: string,
    maxBytes: number,
  ): string | null;
  committedWorkspaceFileExists(workspaceId: string, versionId: string, path: string): boolean;
  listIncomingWebhooks(
    workspaceId: string,
  ): import("@dohc/workspace-contracts/incoming-webhooks").IncomingWebhookSummary[];
  createIncomingWebhook(
    input: Parameters<typeof import("./incomingWebhooks").createIncomingWebhook>[1],
  ): import("./incomingWebhooks").CreateIncomingWebhookResult;
  updateIncomingWebhook(
    input: Parameters<typeof import("./incomingWebhooks").updateIncomingWebhook>[1],
  ): import("./incomingWebhooks").UpdateIncomingWebhookResult;
  rotateIncomingWebhookToken(
    input: Parameters<typeof import("./incomingWebhooks").rotateIncomingWebhookToken>[1],
  ): import("./incomingWebhooks").RotateIncomingWebhookResult;
  deleteIncomingWebhook(
    workspaceId: string,
    ownerUserId: string,
    webhookId: string,
  ): import("./incomingWebhooks").DeleteIncomingWebhookResult;
  lookupActiveIncomingWebhookByToken(
    linkKey: string | Uint8Array,
    token: string,
  ): import("./incomingWebhooks").ResolvedIncomingWebhook | null;
  precheckIncomingWebhookBudgets(
    webhookId: string,
    workspaceId: string,
    nowMs: number,
    deliveryKey?: string | null,
  ): ReturnType<typeof import("./incomingWebhooks").precheckIncomingWebhookBudgets>;
  enqueueIncomingWebhookDelivery(
    input: Parameters<typeof import("./incomingWebhooks").enqueueIncomingWebhookDelivery>[1],
  ): import("./incomingWebhooks").EnqueueIncomingWebhookDeliveryResult;
  claimNextIncomingWebhookDelivery(
    input: Parameters<typeof import("./incomingWebhooks").claimNextIncomingWebhookDelivery>[1],
  ): import("./incomingWebhooks").ClaimedIncomingWebhookDelivery | null;
  verifyIncomingWebhookPublicationAuthority(
    input: Parameters<
      typeof import("./incomingWebhooks").verifyIncomingWebhookPublicationAuthority
    >[1],
  ): ReturnType<typeof import("./incomingWebhooks").verifyIncomingWebhookPublicationAuthority>;
  settleIncomingWebhookDelivery(
    input: Parameters<typeof import("./incomingWebhooks").settleIncomingWebhookDelivery>[1],
  ): boolean;
  releaseAcceptedIncomingWebhookDelivery(
    input: Parameters<
      typeof import("./incomingWebhooks").releaseAcceptedIncomingWebhookDelivery
    >[1],
  ): void;
  recoverAcceptedIncomingWebhookDeliveries(
    input: Parameters<
      typeof import("./incomingWebhooks").recoverAcceptedIncomingWebhookDeliveries
    >[1],
  ): number;
  recordFailedIncomingWebhookAttempt(
    input: Parameters<typeof import("./incomingWebhooks").recordFailedIncomingWebhookAttempt>[1],
  ): ReturnType<typeof import("./incomingWebhooks").recordFailedIncomingWebhookAttempt>;
  hasPendingIncomingWebhookDeliveries(
    workspaceId: string,
    nowMs?: number,
    ownerUserId?: string,
    leaseId?: string,
  ): boolean;
  nextIncomingWebhookRetryAtMs(workspaceId: string, ownerUserId?: string): number | null;
  workspacesWithIncomingWebhooks(): string[];
  pruneExpiredIncomingWebhookDeliveries(nowMs: number, workspaceId?: string): number;
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

export interface SqliteStatement {
  all(...params: unknown[]): Array<Record<string, unknown>>;
  get(...params: unknown[]): Record<string, unknown> | undefined;
  iterate(...params: unknown[]): IterableIterator<Record<string, unknown>>;
  run(...params: unknown[]): SqliteRunResult;
}

export interface SqliteDb {
  readonly isTransaction?: boolean;
  exec(sql: string): void;
  prepare(sql: string): SqliteStatement;
  close(): void;
}

export type SyncRelayOpenPart = "lock" | "file" | "continuity" | "schema" | "purge";

export interface OpenSyncRelayStorageOptions {
  /** Called as each part of the open ends, in order, with the part's name. */
  opened?: (part: SyncRelayOpenPart) => void;
  pushConfigured?: boolean;
  apnsConfigured?: boolean;
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

export type DeviceHostCredentialResult =
  | LiveHostControlResult
  | { readonly ok: false; readonly reason: "credential-refused" };

export interface TicketHostReport {
  readonly connection: LiveHostConnectionCoordinate;
  readonly binding: LiveObjectBinding;
}

export interface LiveTicketLookup {
  readonly tokenHash: string;
  readonly scope: LiveTicketScope;
  readonly audience: string;
}

export interface LiveTicketMint extends LiveTicketLookup {
  readonly objectId: string;
  readonly ticketId: string;
  readonly report: TicketHostReport;
}

export interface LiveTicketRedemption extends LiveTicketLookup {
  readonly report: TicketHostReport;
}

export interface LiveTicketStoragePolicy {
  readonly retainedTicketsPerPrincipalGrant: number;
  readonly expiredTicketCleanupBatchSize: number;
  readonly now: () => number;
}

type WorkspaceMembersModule = typeof import("./workspaceMembers");
type FolderRulesModule = typeof import("./folderRules");
type FolderRulesMethod<K extends keyof FolderRulesModule> = FolderRulesModule[K] extends (
  storage: never,
  ...args: infer A
) => infer R
  ? (...args: A) => R
  : never;
type DirectMessagesModule = typeof import("./directMessages");
type MessageDeletesModule = typeof import("./messageDeletes");
type MessageDeletesMethod<K extends keyof MessageDeletesModule> = MessageDeletesModule[K] extends (
  storage: never,
  ...args: infer A
) => infer R
  ? (...args: A) => R
  : never;
type DirectMessagesMethod<K extends keyof DirectMessagesModule> = DirectMessagesModule[K] extends (
  storage: never,
  ...args: infer A
) => infer R
  ? (...args: A) => R
  : never;
type WorkspaceMembersMethod<K extends keyof WorkspaceMembersModule> =
  WorkspaceMembersModule[K] extends (storage: never, ...args: infer A) => infer R
    ? (...args: A) => R
    : never;
