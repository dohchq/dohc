import type { ServiceActivationAccess } from "./storage/serviceActivationAccess";
import { ServiceActivationStore } from "./storage/serviceActivation";
import * as serviceHostEnrollmentStorage from "./storage/serviceHostEnrollment";
import { LiveCommittedDeliveryStore } from "./storage/liveCommittedDelivery";
import * as liveRestoreOperationStorage from "./storage/liveRestoreOperation";
import * as ownerRestoreOptionsStorage from "./storage/ownerRestoreOptions";
import { RelayWriteOwner } from "./storage/writeOwner";
import { isAsyncFunction } from "node:util/types";
import type { LiveJournalHistoryAuthority } from "./storage/liveJournalHistory";
import type { LiveDocumentKey } from "@dohc/live-session-contract/live-update-admission";
import type { LiveJournalStoredUpdate, LiveUpdateJournalCut, LiveUpdateJournalCutResult, LiveJournalValidation, LiveUpdateJournalCommitInput, RelayLiveUpdateJournalResult, CommittedLiveUpdateResult } from "./storage/types";
export type { LiveJournalStoredUpdate, LiveUpdateJournalCut, LiveUpdateJournalCutResult, LiveJournalValidation, LiveUpdateJournalCommitInput, RelayLiveUpdateJournalResult, CommittedLiveUpdateResult } from "./storage/types";
export { LiveJournalAdmittedCapacityError } from "./storage/errors";
import * as liveUpdateJournalStorage from "./storage/liveUpdateJournal";
import type {
  SqliteDb,
  OpenSyncRelayStorageOptions,
  SyncRelayStorage,
  LiveTicketStoragePolicy,
  CurrentLiveBindingRequest,
  LiveDocumentBaselineRegistrationInput,
  RelayBaselineRegistrationResult,
  CurrentLiveBindingResult,
  LiveHostControlResult,
  LiveHostConnectionCoordinate,
  BeginLiveHostTransitionInput,
  ActivateLiveHostTransitionInput,
  WorkspaceSyncIdentity,
  WorkspaceBootstrap,
  VerifyWorkspaceIdentityResult,
  ClaimWorkspaceIdentityResult,
  RotateWorkspaceIdentityResult,
  PutBlobResult,
  CollectUnreferencedBlobsResult,
  KeyEnvelopeRow,
  SyncRelayLogInput,
  AppendLogBatchGuardContext,
  AppendLogBatchResult,
  SyncRelayShareRow,
  SyncRelayShareGrantRow,
  SyncRelayLinkCredentialRow,
  SyncRelayLinkCredentialGrantRow,
  SyncRelayLinkCredentialMint,
  LinkGrantTransitionResult,
  ShareGrantTransitionResult,
  SyncRelayLinkSessionRow,
  AppendLinkDiscussionMessageResult,
  AppendAuthenticatedDiscussionMessageResult,
  SyncRelayShareDiscussionCursor,
  SyncRelayShareDiscussionPageDirection,
  SyncRelayShareDiscussionPage,
  SyncRelayShareDiscussionActivityPage,
  SyncRelayLinkPrincipalRow,
  SyncRelayDeletedDiscussionMessage,
  SyncRelayLinkHandoffCodeRow,
  LinkHandoffRedeemResult,
  SyncRelayShareWithGrantRow,
  SyncRelayLinkInventoryCursor,
  SyncRelayLinkInventoryPage,
  SyncRelayIndependentGrantInventoryCursor,
  SyncRelayIndependentGrantInventoryPage,
  SyncRelayLogRow,
  ThreadFileBinding,
  ObjectMomentRow,
  ShareProposalOpRow,
  ShareProposalRow,
  ShareProposalState,
  FetchLogPageResult,
  CurrentFileStateSnapshot,
  LiveTicketLookup,
  LiveTicketMint,
  LiveTicketRedemption,
  DeviceHostCredentialResult,
} from "./storage/types";
import { createRequire } from "node:module";
import { resolve, dirname } from "node:path";
import { mkdirSync } from "node:fs";
import { pathToFileURL } from "node:url";
import {
  DEFAULT_WORKSPACE_QUOTA_BYTES,
  DEFAULT_BLOB_GRACE_MS,
  LINK_DISCUSSION_PRINCIPAL_LIMIT,
  DISCUSSION_MESSAGE_RATE_LIMIT,
  DISCUSSION_LIFETIME_MESSAGE_LIMIT,
  DISCUSSION_NON_OWNER_SHARE_ROW_LIMIT,
  SYNC_RELAY_BUSY_TIMEOUT_MS,
} from "./storage/limits";
import { LINK_SESSIONS_PER_GRANT_LIMIT } from "./linkSecurity";
import { randomUUID } from "node:crypto";
import { ticketRecord } from "./liveTicketInputs";
import { initializeSyncRelaySchema } from "./storage/schema";
import { LIVE_TICKET_REFUSED } from "./storage/liveDocumentAuthority";
import type { HostControlSnapshot, HostMode, HostTransitionGeneration } from "@dohc/live-session-contract/host-control";
import * as hostControlStorage from "./storage/hostControl";
import * as workspacesStorage from "./storage/workspaces";
import * as blobsStorage from "./storage/blobs";
import * as publicationStorage from "./storage/publications";
import * as appCollectionStorage from "./storage/appCollections";
import * as appCollectionModeration from "./storage/appCollectionModeration";
import * as keyEnvelopesStorage from "./storage/keyEnvelopes";
import * as logStorage from "./storage/log";
import * as sharesStorage from "./storage/shares";
import * as discussionStorage from "./storage/discussion";
import * as handoffStorage from "./storage/handoff";
import * as objectIndexStorage from "./storage/objectIndex";
import * as proposalsStorage from "./storage/proposals";
import * as currentFilesStorage from "./storage/currentFiles";
import * as liveDocumentAuthorityStorage from "./storage/liveDocumentAuthority";
import type { RedeemedLiveTicket } from "@dohc/live-session-contract/live-ticket";
import type { DeviceHostCredential } from "./deviceHostCredential";

export {
  SHARED_BLOB_CANDIDATE_LIMIT,
  LINK_INVENTORY_PAGE_SIZE,
  LINK_INVENTORY_INDEPENDENT_GRANT_LIMIT,
  SYNC_RELAY_BUSY_TIMEOUT_MS,
  DEFAULT_WORKSPACE_QUOTA_BYTES,
  LINK_DISCUSSION_BODY_CODE_POINT_LIMIT,
  LINK_DISCUSSION_BODY_INPUT_BYTE_LIMIT,
  LINK_DISCUSSION_NAME_CODE_POINT_LIMIT,
  LINK_DISCUSSION_NAME_BYTE_LIMIT,
  LINK_DISCUSSION_IDEMPOTENCY_KEY_LIMIT,
  LINK_DISCUSSION_PRINCIPAL_LIMIT,
  DISCUSSION_MESSAGE_RATE_LIMIT,
  DISCUSSION_MESSAGE_RATE_WINDOW_MS,
  DISCUSSION_LIFETIME_MESSAGE_LIMIT,
  DISCUSSION_NON_OWNER_SHARE_ROW_LIMIT,
  LINK_DISCUSSION_PAGE_LIMIT,
  LINK_DISCUSSION_DELETING_USER_ID_BYTE_LIMIT,
  DEFAULT_BLOB_GRACE_MS,
} from "./storage/limits";
export {
  type LiveHostControlRefusalReason,
  type LiveHostControlResult,
  type LiveHostConnectionCoordinate,
  type BeginLiveHostTransitionInput,
  type ActivateLiveHostTransitionInput,
  type SyncRelayLogInput,
  type SyncRelayLogRow,
  type CurrentFileStateRow,
  type CurrentFileStateSnapshot,
  type CollectUnreferencedBlobsResult,
  type SyncRelayShareRow,
  type SyncRelayShareGrantStatus,
  type SyncRelayShareGrantRow,
  type SyncRelayLinkCredentialRow,
  type SyncRelayLinkCredentialGrantRow,
  type SyncRelayLinkSessionRow,
  type SyncRelayLinkPrincipalRow,
  type SyncRelayShareDiscussionMessageRow,
  type SyncRelayShareDiscussionCursor,
  type SyncRelayShareDiscussionPageMessage,
  type SyncRelayShareDiscussionPage,
  type SyncRelayShareDiscussionPageDirection,
  type SyncRelayShareDiscussionActivityPage,
  type SyncRelayDeletedDiscussionMessage,
  type AppendLinkDiscussionMessageResult,
  type AppendAuthenticatedDiscussionMessageResult,
  type SyncRelayLinkHandoffCodeRow,
  type LinkHandoffRedeemResult,
  type ShareGrantTransitionResult,
  type LinkGrantTransitionResult,
  type SyncRelayShareWithGrantRow,
  type SyncRelayLinkInventoryRow,
  type SyncRelayLinkInventoryCursor,
  type SyncRelayLinkInventoryPage,
  type SyncRelayIndependentGrantInventoryCursor,
  type SyncRelayIndependentGrantInventoryPage,
  type ShareProposalState,
  type ShareProposalRow,
  type ShareProposalOpRow,
  type ObjectMomentRow,
  type WorkspaceSyncIdentity,
  type ClaimWorkspaceIdentityResult,
  type VerifyWorkspaceIdentityResult,
  type EnforceWorkspaceIdentityResult,
  type RotateWorkspaceIdentityResult,
  type AppendLogBatchGuardContext,
  type SyncRelayStorage,
  type ThreadFileBinding,
  type OpenSyncRelayStorageOptions,
  type CurrentLiveBindingRequest,
  type LiveDocumentBaselineRegistrationInput,
  type RelayBaselineRegistrationResult,
  type CurrentLiveBindingResult,
  type DeviceHostCredentialResult,
  type TicketHostReport,
  type LiveTicketLookup,
  type LiveTicketMint,
  type LiveTicketRedemption,
  type LiveTicketStoragePolicy,
} from "./storage/types";
export {
  objectPathFromMomentPayload,
  objectMomentFromMomentPayload,
  currentFileStateQuery,
  currentFileBlobByteLengthQuery,
} from "./storage/currentFiles";
export { normalizeDiscussionDisplayName } from "./storage/discussion";
export { referencedBlobShas } from "./storage/blobReferences";
export { SyncRelayConflictError, SyncRelayQuotaExceededError, SyncRelayBlobMissingError } from "./storage/errors";

interface SqliteModule {
  DatabaseSync: new (path: string) => SqliteDb;
}

const requireModule = createRequire(import.meta.url);

function nodeSqlite(): SqliteModule {
  return requireModule("node:sqlite") as SqliteModule;
}

export function openSyncRelayStorage(
  dbPath: string,
  options: OpenSyncRelayStorageOptions = {},
  createOwner?: (db: SqliteDb) => RelayWriteOwner,
): SyncRelayStorage {
  const resolved = resolve(dbPath);
  mkdirSync(dirname(resolved), { recursive: true });
  const { DatabaseSync } = nodeSqlite();
  const workspaceQuotaBytes =
    options.workspaceQuotaBytes ?? DEFAULT_WORKSPACE_QUOTA_BYTES;
  // Validate the quota here, not just in main.ts: this helper is exported and
  // reused (tests, other services). A NaN/Infinity/negative cap would silently
  // disable the quota check (currentUsage + added > NaN is always false), so
  // reject anything that is not a positive safe integer before constructing
  // storage.
  if (!Number.isSafeInteger(workspaceQuotaBytes) || workspaceQuotaBytes <= 0) {
    throw new Error(
      `workspaceQuotaBytes must be a positive safe integer, got ${String(workspaceQuotaBytes)}`,
    );
  }
  const blobGraceMs = options.blobGraceMs ?? DEFAULT_BLOB_GRACE_MS;
  if (!Number.isSafeInteger(blobGraceMs) || blobGraceMs < 0) {
    throw new Error(
      `blobGraceMs must be a non-negative safe integer, got ${String(blobGraceMs)}`,
    );
  }
  const linkSessionsPerGrantLimit =
    options.linkSessionsPerGrantLimit ?? LINK_SESSIONS_PER_GRANT_LIMIT;
  if (
    !Number.isSafeInteger(linkSessionsPerGrantLimit) ||
    linkSessionsPerGrantLimit <= 0
  ) {
    throw new Error(
      `linkSessionsPerGrantLimit must be a positive safe integer, got ${String(linkSessionsPerGrantLimit)}`,
    );
  }
  const linkDiscussionPrincipalLimit =
    options.linkDiscussionPrincipalLimit ?? LINK_DISCUSSION_PRINCIPAL_LIMIT;
  const discussionMessageRateLimit =
    options.discussionMessageRateLimit ?? DISCUSSION_MESSAGE_RATE_LIMIT;
  const discussionLifetimeMessageLimit =
    options.discussionLifetimeMessageLimit ??
    DISCUSSION_LIFETIME_MESSAGE_LIMIT;
  const discussionNonOwnerShareRowLimit =
    options.discussionNonOwnerShareRowLimit ?? DISCUSSION_NON_OWNER_SHARE_ROW_LIMIT;
  for (const [name, value] of [
    ["linkDiscussionPrincipalLimit", linkDiscussionPrincipalLimit],
    ["discussionMessageRateLimit", discussionMessageRateLimit],
    ["discussionLifetimeMessageLimit", discussionLifetimeMessageLimit],
    ["discussionNonOwnerShareRowLimit", discussionNonOwnerShareRowLimit],
  ] as const) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new Error(`${name} must be a positive safe integer, got ${String(value)}`);
    }
  }
  const newDiscussionId = options.newDiscussionId ?? randomUUID;
  const suppliedTickets = options.liveTickets;
  const liveTickets = suppliedTickets === undefined ? undefined :
    ticketRecord(suppliedTickets, ["retainedTicketsPerPrincipalGrant", "expiredTicketCleanupBatchSize", "now"]);
  if (liveTickets !== undefined) {
    for (const field of ["retainedTicketsPerPrincipalGrant", "expiredTicketCleanupBatchSize"] as const) {
      if (typeof liveTickets[field] !== "number" || !Number.isSafeInteger(liveTickets[field]) || liveTickets[field] <= 0) {
        throw new TypeError("Live-ticket policies must be positive safe integers.");
      }
    }
    if (typeof liveTickets.now !== "function") throw new TypeError("Live tickets require a storage clock.");
  }
  const uri = pathToFileURL(resolved);
  uri.searchParams.set("mode", "rw");
  // A configured deployment must already exist; SQLite owns all file handles.
  const db = new DatabaseSync(createOwner ? uri.href : resolved);
  let owner: RelayWriteOwner | undefined;
  try {
    db.exec(`PRAGMA busy_timeout = ${SYNC_RELAY_BUSY_TIMEOUT_MS}`);
    db.exec("PRAGMA foreign_keys = ON");
    db.exec("PRAGMA journal_mode = WAL");
    db.exec("PRAGMA synchronous = FULL");
    if (!createOwner && db.prepare("SELECT 1 FROM sqlite_schema WHERE name='sync_relay_continuity'").get()) {
      throw new Error("Use the configured relay deployment to open this database.");
    }
    owner = createOwner ? createOwner(db) : new RelayWriteOwner(db);
    owner.write(() => initializeSyncRelaySchema(db));
    return new SqliteSyncRelayStorage(
      db,
      {
        workspaceQuotaBytes,
        blobGraceMs,
        linkSessionsPerGrantLimit,
        linkDiscussionPrincipalLimit,
        discussionMessageRateLimit,
        discussionLifetimeMessageLimit,
        discussionNonOwnerShareRowLimit,
        newDiscussionId,
      },
      liveTickets as unknown as LiveTicketStoragePolicy | undefined,
      owner,
    );
  } catch (error) {
    try {
      if (owner) owner.close(); else db.close();
    } catch {}
    throw error;
  }
}

class SqliteSyncRelayStorage implements SyncRelayStorage {
  readonly newDiscussionId: () => string;
  private readingLiveAuthority = false;

  constructor(
    readonly db: SqliteDb,
    readonly options: Required<Omit<OpenSyncRelayStorageOptions, "liveTickets">>,
    private readonly liveTickets: LiveTicketStoragePolicy | undefined,
    private readonly owner: RelayWriteOwner,
  ) {
    this.newDiscussionId = options.newDiscussionId;
  }

  close(): void {
    this.owner.close();
  }

  get unavailable(): AbortSignal { return this.owner.unavailable; }
  captureStanding(): () => void { return this.owner.captureStanding(); }

  enrollServiceHostDocument(input: serviceHostEnrollmentStorage.EnrollServiceHostDocumentInput) {
    return serviceHostEnrollmentStorage.enrollServiceHostDocument(this, input);
  }
  enrollServiceHostDocuments(inputs: readonly serviceHostEnrollmentStorage.EnrollServiceHostDocumentInput[]) {
    return serviceHostEnrollmentStorage.enrollServiceHostDocuments(this, inputs);
  }
  listServiceHostEnrollments(workspaceId?: string) {
    return serviceHostEnrollmentStorage.listServiceHostEnrollments(this, workspaceId);
  }
  listCurrentServiceHostEnrollments(workspaceId: string) {
    return serviceHostEnrollmentStorage.listCurrentServiceHostEnrollments(this, workspaceId);
  }
  listServiceHostCandidateShares(limit?: number) {
    return serviceHostEnrollmentStorage.listServiceHostCandidateShares(this, limit);
  }
  setServiceHostEnrollmentEnabled(input: serviceHostEnrollmentStorage.SetServiceHostEnrollmentEnabledInput) {
    return serviceHostEnrollmentStorage.setServiceHostEnrollmentEnabled(this, input);
  }

  readStopRestorePlan(input: Parameters<typeof liveRestoreOperationStorage.readStopRestorePlan>[1]) {
    return liveRestoreOperationStorage.readStopRestorePlan(this, input);
  }
  readOwnerRestoreOptions(input: Parameters<typeof ownerRestoreOptionsStorage.readOwnerRestoreOptions>[1]) {
    return ownerRestoreOptionsStorage.readOwnerRestoreOptions(this, input);
  }
  readOwnerRestoreStatus(input: Parameters<typeof ownerRestoreOptionsStorage.readOwnerRestoreStatus>[1]) {
    return ownerRestoreOptionsStorage.readOwnerRestoreStatus(this, input);
  }
  beginStopRestore(input: Parameters<typeof liveRestoreOperationStorage.beginStopRestore>[1], now: number) {
    return liveRestoreOperationStorage.beginStopRestore(this, input, now);
  }
  advanceStopRestoreFence(input: Parameters<typeof liveRestoreOperationStorage.advanceStopRestoreFence>[1], now: number) {
    return liveRestoreOperationStorage.advanceStopRestoreFence(this, input, now);
  }
  readStopRestore(input: Parameters<typeof liveRestoreOperationStorage.readStopRestore>[1]) {
    return liveRestoreOperationStorage.readStopRestore(this, input);
  }

  resolveCurrentLiveDocumentBinding(input: CurrentLiveBindingRequest, activation?: ServiceActivationAccess): CurrentLiveBindingResult {
    return liveDocumentAuthorityStorage.resolveCurrentLiveDocumentBinding(this, input, activation);
  }

  resolveLiveObjectHostBinding(scope: Parameters<typeof liveDocumentAuthorityStorage.resolveLiveObjectHostBinding>[1], objectId: string): liveDocumentAuthorityStorage.LiveObjectHostBindingResult {
    return liveDocumentAuthorityStorage.resolveLiveObjectHostBinding(this, scope, objectId);
  }

  registerLiveDocumentBaseline(input: LiveDocumentBaselineRegistrationInput): RelayBaselineRegistrationResult {
    return liveDocumentAuthorityStorage.registerLiveDocumentBaseline(this, input);
  }

  readLiveUpdateJournalCut(input: { document: LiveDocumentKey }): LiveUpdateJournalCutResult {
    return liveUpdateJournalStorage.readLiveUpdateJournalCut(this, input);
  }

  commitLiveUpdateJournal(input: LiveUpdateJournalCommitInput, activation?: ServiceActivationAccess): RelayLiveUpdateJournalResult {
    return liveUpdateJournalStorage.commitLiveUpdateJournal(this, input, activation);
  }

  readCommittedLiveUpdate(input: { host: LiveHostConnectionCoordinate; document: LiveDocumentKey; journalCursor: number }): CommittedLiveUpdateResult {
    return liveUpdateJournalStorage.readCommittedLiveUpdate(this, input);
  }

  createLiveCommittedDeliveryStore(history: LiveJournalHistoryAuthority, activation?: ServiceActivationAccess): LiveCommittedDeliveryStore {
    return new LiveCommittedDeliveryStore(this, history, activation);
  }
  createServiceActivationStore(history: LiveJournalHistoryAuthority): ServiceActivationStore {
    return new ServiceActivationStore(this,history);
  }

  getLiveHostControl(): HostControlSnapshot | null {
    return hostControlStorage.getLiveHostControl(this);
  }

  provisionLiveHostControl(input: {
    mode: HostMode;
    hostId: string;
    updatedAtMs: number;
    guard: () => void;
  }): LiveHostControlResult {
    return hostControlStorage.provisionLiveHostControl(this, input);
  }

  registerLiveHost(input: LiveHostConnectionCoordinate & {
    updatedAtMs: number;
    guard: () => void;
  }): LiveHostControlResult {
    return hostControlStorage.registerLiveHost(this, input);
  }

  disconnectLiveHost(input: LiveHostConnectionCoordinate & {
    updatedAtMs: number;
    guard: () => void;
  }): LiveHostControlResult {
    return hostControlStorage.disconnectLiveHost(this, input);
  }

  beginLiveHostTransition(input: BeginLiveHostTransitionInput): LiveHostControlResult {
    return hostControlStorage.beginLiveHostTransition(this, input);
  }

  abortLiveHostTransition(input: {
    transitionId: string;
    transitionGeneration: HostTransitionGeneration;
    updatedAtMs: number;
  }): LiveHostControlResult {
    return hostControlStorage.abortLiveHostTransition(this, input);
  }

  commitLiveHostTransitionEpoch(input: {
    transitionId: string;
    transitionGeneration: HostTransitionGeneration;
    updatedAtMs: number;
  }): LiveHostControlResult {
    return hostControlStorage.commitLiveHostTransitionEpoch(this, input);
  }

  activateLiveHostTransition(input: ActivateLiveHostTransitionInput): LiveHostControlResult {
    return hostControlStorage.activateLiveHostTransition(this, input);
  }

  claimWorkspace(input: {
    workspaceId: string;
    ownerUserId: string;
    createdAtMs: number;
  }): "created" | "owned" | "not-owner" {
    return workspacesStorage.claimWorkspace(this, input);
  }

  getWorkspaceIdentity(workspaceId: string): WorkspaceSyncIdentity | null {
    return workspacesStorage.getWorkspaceIdentity(this, workspaceId);
  }

  getWorkspaceBootstrap(workspaceId: string): WorkspaceBootstrap {
    return workspacesStorage.getWorkspaceBootstrap(this, workspaceId);
  }

  getEpochLogFloor(workspaceId: string): number {
    return workspacesStorage.getEpochLogFloor(this, workspaceId);
  }

  verifyWorkspaceIdentity(input: {
    workspaceId: string;
    replicationEpoch: string;
    streamIdentity: string;
  }): VerifyWorkspaceIdentityResult {
    return workspacesStorage.verifyWorkspaceIdentity(this, input);
  }

  claimWorkspaceIdentity(input: {
    workspaceId: string;
    replicationEpoch: string;
    streamIdentity: string;
  }): ClaimWorkspaceIdentityResult {
    return workspacesStorage.claimWorkspaceIdentity(this, input);
  }

  rotateWorkspaceIdentity(input: {
    workspaceId: string;
    ownerUserId: string;
    replicationEpoch: string;
    streamIdentity: string;
    rotatedAtMs: number;
  }): RotateWorkspaceIdentityResult {
    return workspacesStorage.rotateWorkspaceIdentity(this, input);
  }

  workspaceIsOwnedBy(workspaceId: string, ownerUserId: string): boolean {
    return workspacesStorage.workspaceIsOwnedBy(this, workspaceId, ownerUserId);
  }

  publishAppPublication(input: publicationStorage.PublishAppPublicationInput) {
    return publicationStorage.publishAppPublication(this, input);
  }

  approveAppCollection(input: appCollectionStorage.ApproveAppCollectionInput) {
    return appCollectionStorage.approveAppCollection(this,input);
  }

  acceptAppCollection(input: appCollectionStorage.AcceptAppCollectionInput, policy: appCollectionStorage.AppCollectionAcceptancePolicy) {
    return appCollectionStorage.acceptAppCollection(this,input,policy);
  }

  readAppCollection(input: appCollectionStorage.ReadAppCollectionInput) {
    return appCollectionStorage.readAppCollection(this,input);
  }
  authorizeLinkAppCollection(input: publicationStorage.LinkAppPublicationInput) {
    return appCollectionStorage.authorizeLinkAppCollection(this,input);
  }

  readOwnerAppCollectionAcceptances(input: appCollectionModeration.OwnerAppCollectionAcceptancesInput) {
    return appCollectionModeration.readOwnerAppCollectionAcceptances(this,input);
  }

  readAppPublication(input: publicationStorage.ReadAppPublicationInput) {
    return publicationStorage.readAppPublication(this, input);
  }

  listAppPublications(input: publicationStorage.ListAppPublicationsInput) {
    return publicationStorage.listAppPublications(this, input);
  }

  listLinkAppPublications(input: publicationStorage.ListLinkAppPublicationsInput) {
    return publicationStorage.listLinkAppPublications(this, input);
  }

  withdrawAppPublication(input: publicationStorage.WithdrawAppPublicationInput) {
    return publicationStorage.withdrawAppPublication(this, input);
  }

  reactivateAppPublication(input: publicationStorage.ReactivateAppPublicationInput) {
    return publicationStorage.reactivateAppPublication(this, input);
  }

  authorizeLinkAppPublication(input: publicationStorage.LinkAppPublicationInput) {
    return publicationStorage.authorizeLinkAppPublication(this, input);
  }

  createLinkAppPublicationGuard(input: publicationStorage.LinkAppPublicationInput) {
    return publicationStorage.createLinkAppPublicationGuard(this, input);
  }

  readLinkAppPublicationBlob(input: publicationStorage.LinkAppPublicationInput & {sha256: string; expectedAuthorityRevision: number}) {
    return publicationStorage.readLinkAppPublicationBlob(this, input);
  }

  putBlob(input: {
    workspaceId: string;
    sha256: string;
    content: Uint8Array;
    createdAtMs: number;
  }): PutBlobResult {
    return blobsStorage.putBlob(this, input);
  }

  collectUnreferencedBlobs(
    workspaceId: string,
    options: { nowMs: number },
  ): Promise<CollectUnreferencedBlobsResult> {
    return blobsStorage.collectUnreferencedBlobs(this, workspaceId, options);
  }

  getBlob(workspaceId: string, sha256: string): Uint8Array | null {
    return blobsStorage.getBlob(this, workspaceId, sha256);
  }

  missingBlobs(workspaceId: string, sha256s: string[]): string[] {
    return blobsStorage.missingBlobs(this, workspaceId, sha256s);
  }

  putKeyEnvelope(input: {
    workspaceId: string;
    envelopeJson: string;
    updatedAtMs: number;
    expectedSha256: string | null;
  }): { sha256: string } {
    return keyEnvelopesStorage.putKeyEnvelope(this, input);
  }

  getKeyEnvelope(workspaceId: string): KeyEnvelopeRow | null {
    return keyEnvelopesStorage.getKeyEnvelope(this, workspaceId);
  }

  appendLogBatch(input: {
    workspaceId: string;
    originId: string;
    ops: SyncRelayLogInput[];
    guard?: (context: AppendLogBatchGuardContext) => void;
  }): AppendLogBatchResult {
    return logStorage.appendLogBatch(this, input);
  }

  createShare(input: {
    share: SyncRelayShareRow;
    grant: SyncRelayShareGrantRow;
  }): void {
    return sharesStorage.createShare(this, input);
  }

  createFileLinkShare(input: {
    share: SyncRelayShareRow;
    grant: SyncRelayShareGrantRow;
    credential: SyncRelayLinkCredentialRow;
    guard: () => void;
  }): boolean {
    return sharesStorage.createFileLinkShare(this, input);
  }

  createLinkGrant(input: {
    grant: SyncRelayShareGrantRow;
    credential: SyncRelayLinkCredentialRow;
  }): boolean {
    return sharesStorage.createLinkGrant(this, input);
  }

  getShareGrant(grantId: string): SyncRelayShareGrantRow | null {
    return sharesStorage.getShareGrant(this, grantId);
  }

  getCurrentLinkCredential(grantId: string): SyncRelayLinkCredentialRow | null {
    return sharesStorage.getCurrentLinkCredential(this, grantId);
  }

  findLinkGrantByCredentialHash(
    secretHash: string,
  ): SyncRelayLinkCredentialGrantRow | null {
    return sharesStorage.findLinkGrantByCredentialHash(this, secretHash);
  }

  rotateLinkGrant(input: {
    shareId: string;
    grantId: string;
    rotatedAtMs: number;
    expectedDependentGrantIds: readonly string[];
    guard: () => void;
    mintCredential: () => SyncRelayLinkCredentialMint;
  }): LinkGrantTransitionResult {
    return sharesStorage.rotateLinkGrant(this, input);
  }

  retuneShareGrant(input: {
    shareId: string;
    grantId: string;
    access: string;
    changedAtMs: number;
    expectedDependentGrantIds: readonly string[];
    guard: () => void;
    mintCredential?: () => SyncRelayLinkCredentialMint;
  }): LinkGrantTransitionResult {
    return sharesStorage.retuneShareGrant(this, input);
  }

  revokeShareGrant(input: {
    shareId: string;
    grantId: string;
    revokedAtMs: number;
    expectedDependentGrantIds?: readonly string[];
    guard?: () => void;
  }): LinkGrantTransitionResult {
    return sharesStorage.revokeShareGrant(this, input);
  }

  promoteShareGrant(input: {
    shareId: string;
    grantId: string;
    expectedParentGrantId: string;
    expectedParentGeneration: number;
    guard: () => void;
  }): ShareGrantTransitionResult {
    return sharesStorage.promoteShareGrant(this, input);
  }

  mintLinkSession(input: {
    session: Omit<SyncRelayLinkSessionRow, "principalId">;
    guard?: () => void;
  }): boolean {
    return sharesStorage.mintLinkSession(this, input);
  }

  replaceLinkSession(input: {
    currentSession: SyncRelayLinkSessionRow;
    session: Omit<SyncRelayLinkSessionRow, "principalId">;
    guard: () => void;
  }): boolean {
    return sharesStorage.replaceLinkSession(this, input);
  }

  findLinkSessionByCapabilityHash(
    capabilityHash: string,
  ): SyncRelayLinkSessionRow | null {
    return sharesStorage.findLinkSessionByCapabilityHash(this, capabilityHash);
  }

  appendLinkDiscussionMessage(input: {
    capabilityHash: string;
    profileTokenHash: string;
    claimedName?: string | null;
    body: string;
    idempotencyKey: string;
    createdAtMs: number;
    guard?: () => void;
  }): AppendLinkDiscussionMessageResult {
    return discussionStorage.appendLinkDiscussionMessage(this, input);
  }

  appendAuthenticatedDiscussionMessage(input: {
    shareId: string;
    authorUserId: string;
    displayName: string;
    body: string;
    idempotencyKey: string;
    createdAtMs: number;
    readGuard: () => "owner" | "recipient";
    appendGuard: () => "owner" | "recipient";
  }): AppendAuthenticatedDiscussionMessageResult {
    return discussionStorage.appendAuthenticatedDiscussionMessage(this, input);
  }

  listShareDiscussionMessages(input: {
    shareId: string;
    after?: SyncRelayShareDiscussionCursor | null;
    before?: SyncRelayShareDiscussionCursor | null;
    direction?: SyncRelayShareDiscussionPageDirection;
    limit: number;
  }): SyncRelayShareDiscussionPage {
    return discussionStorage.listShareDiscussionMessages(this, input);
  }

  getShareDiscussionRevision(shareId: string): number | null {
    return discussionStorage.getShareDiscussionRevision(this, shareId);
  }

  listShareDiscussionActivity(input: {
    shareId: string;
    sinceRevision: number;
    limit: number;
  }): SyncRelayShareDiscussionActivityPage {
    return discussionStorage.listShareDiscussionActivity(this, input);
  }

  getLinkPrincipal(principalId: string): SyncRelayLinkPrincipalRow | null {
    return discussionStorage.getLinkPrincipal(this, principalId);
  }

  getLinkPrincipalForGrantProfile(
    grantId: string,
    profileTokenHash: string,
  ): SyncRelayLinkPrincipalRow | null {
    return discussionStorage.getLinkPrincipalForGrantProfile(this, grantId, profileTokenHash);
  }

  setLinkPrincipalBlocked(input: {
    shareId: string;
    workspaceId: string;
    principalId: string;
    actorUserId: string;
    blockedAtMs: number | null;
  }): boolean {
    return discussionStorage.setLinkPrincipalBlocked(this, input);
  }

  setShareLinkWritesPaused(input: {
    shareId: string;
    workspaceId: string;
    actorUserId: string;
    pausedAtMs: number | null;
  }): boolean {
    return discussionStorage.setShareLinkWritesPaused(this, input);
  }

  deleteShareDiscussionMessage(input: {
    shareId: string;
    workspaceId: string;
    messageId: string;
    deletedAtMs: number;
    actorUserId: string;
  }): SyncRelayDeletedDiscussionMessage | null {
    return discussionStorage.deleteShareDiscussionMessage(this, input);
  }

  mintLinkHandoffCode(input: {
    code: SyncRelayLinkHandoffCodeRow;
    guard: () => boolean;
  }): boolean {
    return handoffStorage.mintLinkHandoffCode(this, input);
  }

  hasLinkHandoffCode(codeHash: string): boolean {
    return handoffStorage.hasLinkHandoffCode(this, codeHash);
  }

  redeemLinkHandoffCode(input: {
    codeHash: string;
    principalUserId: string;
    redeemedAtMs: number;
    mintGrantId: () => string;
    guard: (code: SyncRelayLinkHandoffCodeRow) => boolean;
  }): LinkHandoffRedeemResult {
    return handoffStorage.redeemLinkHandoffCode(this, input);
  }

  claimPendingSharesForEmail(email: string, userId: string): number {
    return sharesStorage.claimPendingSharesForEmail(this, email, userId);
  }

  getShare(shareId: string): SyncRelayShareRow | null {
    return sharesStorage.getShare(this, shareId);
  }

  listActiveShareGrantsForRecipient(
    shareId: string,
    recipientUserId: string,
  ): SyncRelayShareGrantRow[] {
    return sharesStorage.listActiveShareGrantsForRecipient(this, shareId, recipientUserId);
  }

  listSharesGrantedBy(granterUserId: string): SyncRelayShareWithGrantRow[] {
    return sharesStorage.listSharesGrantedBy(this, granterUserId);
  }

  listLinkGrantsByWorkspace(
    workspaceId: string,
    cursor?: SyncRelayLinkInventoryCursor,
  ): SyncRelayLinkInventoryPage {
    return sharesStorage.listLinkGrantsByWorkspace(this, workspaceId, cursor);
  }

  listActiveIndependentShareGrants(input: {
    workspaceId: string;
    shareIds: readonly string[];
    cursor?: SyncRelayIndependentGrantInventoryCursor;
  }): SyncRelayIndependentGrantInventoryPage {
    return sharesStorage.listActiveIndependentShareGrants(this, input);
  }

  listSharesReceivedBy(recipientUserId: string): SyncRelayShareWithGrantRow[] {
    return sharesStorage.listSharesReceivedBy(this, recipientUserId);
  }

  revokeShare(shareId: string, revokedAtMs: number): boolean {
    return sharesStorage.revokeShare(this, shareId, revokedAtMs);
  }

  listObjectMomentLogRowsByBlob(input: {
    workspaceId: string;
    versionId: string;
    sha256: string;
    semantics: "historical-log" | "current-state";
    selectorPaths?: readonly string[];
  }): SyncRelayLogRow[] {
    return objectIndexStorage.listObjectMomentLogRowsByBlob(this, input);
  }

  listVersionCreateLogRowsByBlob(input: {
    workspaceId: string;
    versionId: string;
    sha256: string;
  }): SyncRelayLogRow[] {
    return objectIndexStorage.listVersionCreateLogRowsByBlob(this, input);
  }

  findThreadCreateChannelWireId(
    workspaceId: string,
    threadId: string,
  ): string | null | undefined {
    return objectIndexStorage.findThreadCreateChannelWireId(this, workspaceId, threadId);
  }

  findChannelCreateKind(
    workspaceId: string,
    channelWireId: string,
  ): "channel" | "dm" | "agent" | null | undefined {
    return objectIndexStorage.findChannelCreateKind(this, workspaceId, channelWireId);
  }

  findChannelCreateFolderPath(
    workspaceId: string,
    channelWireId: string,
  ): string | null | undefined {
    return objectIndexStorage.findChannelCreateFolderPath(this, workspaceId, channelWireId);
  }

  findThreadCreateFileBinding(
    workspaceId: string,
    threadId: string,
  ): ThreadFileBinding | null | undefined {
    return objectIndexStorage.findThreadCreateFileBinding(this, workspaceId, threadId);
  }

  objectIdAtPath(workspaceId: string, path: string): string | undefined {
    return objectIndexStorage.objectIdAtPath(this, workspaceId, path);
  }

  objectCurrentPath(workspaceId: string, objectId: string): string | null | undefined {
    return objectIndexStorage.objectCurrentPath(this, workspaceId, objectId);
  }

  objectIdAtPathInVersion(input: {
    workspaceId: string;
    versionId: string;
    path: string;
  }): string | undefined {
    return objectIndexStorage.objectIdAtPathInVersion(this, input);
  }

  objectMoment(input: {
    workspaceId: string;
    objectId: string;
    versionId: string;
    blobSha256?: string;
  }): ObjectMomentRow | null {
    return objectIndexStorage.objectMoment(this, input);
  }

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
  }): { proposalId: string; created: boolean } {
    return proposalsStorage.insertShareProposal(this, input);
  }

  getShareProposal(
    proposalId: string,
  ): (ShareProposalRow & { ops: ShareProposalOpRow[] }) | null {
    return proposalsStorage.getShareProposal(this, proposalId);
  }

  listShareProposalsForShare(shareId: string): Array<ShareProposalRow & { opCount: number }> {
    return proposalsStorage.listShareProposalsForShare(this, shareId);
  }

  listShareProposalsForWorkspace(
    workspaceId: string,
  ): Array<ShareProposalRow & { opCount: number }> {
    return proposalsStorage.listShareProposalsForWorkspace(this, workspaceId);
  }

  settleShareProposal(
    proposalId: string,
    to: Exclude<ShareProposalState, "open">,
    settledAtMs: number,
  ): boolean {
    return proposalsStorage.settleShareProposal(this, proposalId, to, settledAtMs);
  }

  // One write transaction, so a caller states what it writes rather than the
  // BEGIN/COMMIT/ROLLBACK frame around it.
  tx<T>(run: () => T): T {
    if (!hasRelayWriteObservers(this)) return this.owner.write(run);
    const revision = this.db.prepare("SELECT total_changes() AS changes,(SELECT schema_version FROM pragma_schema_version) AS schema_version");
    const before = JSON.stringify(revision.get());
    try { return this.owner.write(run); }
    finally {
      if (this.unavailable.aborted || JSON.stringify(revision.get()) !== before) notifyRelayWrite(this);
    }
  }

  readTx<T>(run: () => T): T {
    this.captureStanding();
    this.db.exec("BEGIN");
    try {
      const result = run();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      try {
        this.db.exec("ROLLBACK");
      } catch {}
      throw error;
    }
  }

  readLiveAuthority<T>(run: () => T): T {
    if (isAsyncFunction(run)) throw new TypeError("Live authority reads must be synchronous.");
    const read = () => {
      const value = run();
      if (value !== null && (typeof value === "object" || typeof value === "function") &&
        typeof (value as {then?: unknown}).then === "function") throw new TypeError("Live authority reads must be synchronous.");
      return value;
    };
    if (this.readingLiveAuthority) { this.captureStanding(); return read(); }
    return this.readTx(() => {
      this.readingLiveAuthority = true;
      try { return read(); }
      finally { this.readingLiveAuthority = false; }
    });
  }

  settleShareProposalInTransaction(
    proposalId: string,
    to: Exclude<ShareProposalState, "open">,
    settledAtMs: number,
  ): boolean {
    return proposalsStorage.settleShareProposalInTransaction(this, proposalId, to, settledAtMs);
  }

  maxOriginSeq(workspaceId: string, originId: string): number {
    return logStorage.maxOriginSeq(this, workspaceId, originId);
  }

  fetchLogPage(input: {
    workspaceId: string;
    sinceRelaySeq: number;
    limit: number;
  }): FetchLogPageResult {
    return logStorage.fetchLogPage(this, input);
  }

  readCurrentFileState(input: {
    workspaceId: string;
    versionId: string;
    selectorPaths: readonly string[];
    limit: number;
  }): CurrentFileStateSnapshot {
    return currentFilesStorage.readCurrentFileState(this, input);
  }

  currentFileBlobByteLength(input: {
    workspaceId: string;
    versionId: string;
    selectorPaths: readonly string[];
    sha256: string;
    epochLogFloor: number;
  }): number | null {
    return currentFilesStorage.currentFileBlobByteLength(this, input);
  }

  fetchLogPageDescending(input: {
    workspaceId: string;
    beforeRelaySeq: number | null;
    limit: number;
  }): SyncRelayLogRow[] {
    return logStorage.fetchLogPageDescending(this, input);
  }

  fetchLogCoordinate(input: {
    workspaceId: string;
    originId: string;
    originSeq: number;
  }): SyncRelayLogRow | null {
    return logStorage.fetchLogCoordinate(this, input);
  }

  ticketTransaction<T>(run: (now: number, policy: LiveTicketStoragePolicy) => T): T | null {
    const policy = this.liveTickets;
    if (policy === undefined) throw new Error("Live-ticket storage is not configured.");
    try {
      return this.tx(() => {
        const now = policy.now();
        if (typeof now !== "number" || !Number.isSafeInteger(now) || now < 0) throw new Error("Invalid live-ticket clock.");
        return run(now, policy);
      });
    } catch (error) {
      if (error === LIVE_TICKET_REFUSED) return null;
      throw error;
    }
  }

  readLiveTicketTarget(input: LiveTicketLookup): { workspaceId: string; objectId: string } | null {
    return liveDocumentAuthorityStorage.readLiveTicketTarget(this, input);
  }

  mintLiveTicket(input: LiveTicketMint): { expiresAtMs: number } | null {
    return liveDocumentAuthorityStorage.mintLiveTicket(this, input);
  }

  redeemLiveTicket(input: LiveTicketRedemption): RedeemedLiveTicket | null {
    return liveDocumentAuthorityStorage.redeemLiveTicket(this, input);
  }

  provisionDeviceHostCredential(input: { credential: DeviceHostCredential; updatedAtMs: number }): DeviceHostCredentialResult {
    return hostControlStorage.provisionDeviceHostCredential(this, input);
  }

  registerDeviceHost(input: { credential: DeviceHostCredential; connectionId: string; updatedAtMs: number }): DeviceHostCredentialResult {
    return hostControlStorage.registerDeviceHost(this, input);
  }

  disconnectDeviceHost(input: { credential: DeviceHostCredential; connectionId: string; updatedAtMs: number }): DeviceHostCredentialResult {
    return hostControlStorage.disconnectDeviceHost(this, input);
  }

  revokeDeviceHostCredential(input: { hostId: string; instanceId: string; updatedAtMs: number }): DeviceHostCredentialResult {
    return hostControlStorage.revokeDeviceHostCredential(this, input);
  }
}
import {hasRelayWriteObservers, notifyRelayWrite} from "./relayWriteChanges";
