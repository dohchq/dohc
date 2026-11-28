import type { MemberFolders } from "./shareFilter";
import { memberReach } from "./storage/memberReach";
import { currentAccessRuleSet } from "./storage/accessRules";
import type { AccessRuleSet } from "@dohc/security-contract/access-rules";
import { accountEmail, refreshAccountEmail, type AccountEmail } from "./storage/accountEmails";
import { normalizeRuleEmail } from "@dohc/security-contract/access-rules";
import { accountIsFenced, workspaceIsDeleted } from "./storage/accountDeletion";
import { reusePreparedStatements } from "./storage/preparedStatements";
import * as workReferenceStorage from "./storage/workReferences";
import * as workspaceMembersStorage from "./storage/workspaceMembers";
import * as messageDeletesStorage from "./storage/messageDeletes";
import * as folderRulesStorage from "./storage/folderRules";
import * as directMessagesStorage from "./storage/directMessages";
import { prepareLiveApplications } from "./storage/liveApplicationAuthorship";
import { prepareHostedSettlements, prepareSettlementAudits } from "./storage/hostedSettlement";
import * as serviceActivationPublication from "./storage/serviceActivationPublication";
import * as serviceActivationRetirementStorage from "./storage/serviceActivationRetirement";
import type { ServiceActivationRetirement } from "./storage/serviceActivationRetirement";
import * as shareLabelsStorage from "./storage/shareLabels";
import * as buttonInspections from "./automationButtonInspections";
import type { ShareLabels } from "@dohc/security-contract/share-labels";
import type { ShareLabelReader, ShareSelector } from "./shareFilter";
import type { ServiceActivationAccess } from "./storage/serviceActivationAccess";
import { ServiceActivationStore } from "./storage/serviceActivation";
import * as serviceHostEnrollmentStorage from "./storage/serviceHostEnrollment";
import * as serviceHostFeedStorage from "./storage/serviceHostFeed";
import * as serviceHostUploadStorage from "./storage/serviceHostUploads";
import * as serviceKeptEditsStorage from "./storage/serviceKeptEdits";
import { LiveCommittedDeliveryStore } from "./storage/liveCommittedDelivery";
import { RelayWriteOwner } from "./storage/writeOwner";
import { isAsyncFunction } from "node:util/types";
import type { LiveJournalHistoryAuthority } from "./storage/liveJournalHistory";
import type { LiveDocumentKey } from "@dohc/live-session-contract/live-update-admission";
import type {
  AcceptedLiveDocument,
  JournalCutReadTiming,
  LiveUpdateJournalCutResult,
  LiveUpdateJournalCommitInput,
  RelayLiveUpdateJournalResult,
  CommittedLiveUpdateResult,
} from "./storage/types";
export type {
  LiveJournalStoredUpdate,
  LiveUpdateJournalCut,
  LiveUpdateJournalCutResult,
  LiveJournalValidation,
  LiveUpdateJournalCommitInput,
  RelayLiveUpdateJournalResult,
  CommittedLiveUpdateResult,
} from "./storage/types";
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
  SyncRelayGrantedShareRow,
  SyncRelayGrantedInventoryCursor,
  SyncRelayGrantedInventoryPage,
  SyncRelayReceivedInventoryCursor,
  SyncRelayReceivedInventoryPage,
  SyncRelayLinkInventoryCursor,
  SyncRelayLinkInventoryPage,
  SyncRelayHistoryAccount,
  SyncRelayIndependentGrantInventoryCursor,
  SyncRelayIndependentGrantInventoryPage,
  SyncRelayLogRow,
  ThreadFileBinding,
  ObjectMomentRow,
  ShareProposalOpRow,
  ShareProposalRow,
  ShareProposalState,
  FetchLogPageResult,
  CurrentFileStateRow,
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
import type {
  HostControlSnapshot,
  HostMode,
  HostTransitionGeneration,
} from "@dohc/live-session-contract/host-control";
import * as hostControlStorage from "./storage/hostControl";
import * as workspacesStorage from "./storage/workspaces";
import * as blobsStorage from "./storage/blobs";
import * as publicationStorage from "./storage/publications";
import * as appCollectionStorage from "./storage/appCollections";
import * as noticeStorage from "./storage/notices";
import * as pushStorage from "./storage/pushSubscriptions";
import * as pushDeviceStorage from "./storage/pushDevices";
import {
  beginAccountNameLookup,
  recordAccountName,
  recordAccountNames,
  unnamedAccountIds,
  workspaceAccountIds,
  type AccountNameLookupToken,
} from "./storage/accountNames";
import * as automationHostStorage from "./storage/automationHosts";
import * as automationWorkspaceStorage from "./storage/automationWorkspaces";
import * as accountWorkspaceStorage from "./storage/accountWorkspaces";
import * as operationRecordStorage from "./storage/operationRecords";
import * as chatWakeStorage from "./storage/chatWakes";
import * as accountFeedStorage from "./storage/accountFeed";
import * as collectionWriteStorage from "./storage/collectionWrites";
import * as ownerCollectionWriteStorage from "./storage/ownerCollectionWrites";
import * as automationPressStorage from "./storage/automationPresses";
import { createRelayDatasetHost, type RelayDatasetHostOptions } from "./datasetHost";
import * as appCollectionModeration from "./storage/appCollectionModeration";
import * as keyEnvelopesStorage from "./storage/keyEnvelopes";
import * as workspaceSecretStorage from "./storage/workspaceSecrets";
import * as outboundWebhookStorage from "./storage/outboundWebhooks";
import * as incomingWebhookStorage from "./storage/incomingWebhooks";
import * as logStorage from "./storage/log";
import * as linkChatStorage from "./storage/linkChat";
import * as agentConnectionStorage from "./storage/agentConnections";
import * as personalAgentStorage from "./storage/personalAgents";
import * as personalAgentChatStorage from "./storage/personalAgentChat";
import * as shareRemovalStorage from "./storage/shareRemoval";
import * as sharesStorage from "./storage/shares";
import * as discussionStorage from "./storage/discussion";
import * as handoffStorage from "./storage/handoff";
import * as objectIndexStorage from "./storage/objectIndex";
import * as proposalsStorage from "./storage/proposals";
import * as currentFilesStorage from "./storage/currentFiles";
import { captureSqliteReadRevisionMatches } from "./storage/readRevision";
import type { LiveTicketScope } from "./liveBrowserContext";
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
  type SyncRelayGrantedShareRow,
  type SyncRelayGrantedInventoryCursor,
  type SyncRelayGrantedInventoryPage,
  type SyncRelayReceivedInventoryCursor,
  type SyncRelayReceivedInventoryPage,
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
export {
  CollectionWriteStaleError,
  type CollectionWriteReceipt,
  type CommitCollectionWriteInput,
} from "./storage/collectionWrites";
export { referencedBlobShas } from "./storage/blobReferences";
export {
  SyncRelayConflictError,
  SyncRelayQuotaExceededError,
  SyncRelayBlobMissingError,
} from "./storage/errors";

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
  const workspaceQuotaBytes = options.workspaceQuotaBytes ?? DEFAULT_WORKSPACE_QUOTA_BYTES;
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
    throw new Error(`blobGraceMs must be a non-negative safe integer, got ${String(blobGraceMs)}`);
  }
  const linkSessionsPerGrantLimit =
    options.linkSessionsPerGrantLimit ?? LINK_SESSIONS_PER_GRANT_LIMIT;
  if (!Number.isSafeInteger(linkSessionsPerGrantLimit) || linkSessionsPerGrantLimit <= 0) {
    throw new Error(
      `linkSessionsPerGrantLimit must be a positive safe integer, got ${String(linkSessionsPerGrantLimit)}`,
    );
  }
  const linkDiscussionPrincipalLimit =
    options.linkDiscussionPrincipalLimit ?? LINK_DISCUSSION_PRINCIPAL_LIMIT;
  const discussionMessageRateLimit =
    options.discussionMessageRateLimit ?? DISCUSSION_MESSAGE_RATE_LIMIT;
  const discussionLifetimeMessageLimit =
    options.discussionLifetimeMessageLimit ?? DISCUSSION_LIFETIME_MESSAGE_LIMIT;
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
  const liveTickets =
    suppliedTickets === undefined
      ? undefined
      : ticketRecord(suppliedTickets, [
          "retainedTicketsPerPrincipalGrant",
          "expiredTicketCleanupBatchSize",
          "now",
        ]);
  if (liveTickets !== undefined) {
    for (const field of [
      "retainedTicketsPerPrincipalGrant",
      "expiredTicketCleanupBatchSize",
    ] as const) {
      if (
        typeof liveTickets[field] !== "number" ||
        !Number.isSafeInteger(liveTickets[field]) ||
        liveTickets[field] <= 0
      ) {
        throw new TypeError("Live-ticket policies must be positive safe integers.");
      }
    }
    if (typeof liveTickets.now !== "function")
      throw new TypeError("Live tickets require a storage clock.");
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
    options.opened?.("file");
    if (
      !createOwner &&
      db.prepare("SELECT 1 FROM sqlite_schema WHERE name='sync_relay_continuity'").get()
    ) {
      throw new Error("Use the configured relay deployment to open this database.");
    }
    owner = createOwner ? createOwner(db) : new RelayWriteOwner(db);
    if (createOwner) options.opened?.("continuity");
    owner.write(() => initializeSyncRelaySchema(db));
    watchLiveAuthorityWrites(db);
    options.opened?.("schema");
    const storage = new SqliteSyncRelayStorage(
      reusePreparedStatements(db),
      {
        pushConfigured: options.pushConfigured ?? false,
        apnsConfigured: options.apnsConfigured ?? false,
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
    storage.purgeExpiredShareRemovals(Date.now());
    options.opened?.("purge");
    return storage;
  } catch (error) {
    try {
      if (owner) owner.close();
      else db.close();
    } catch {}
    throw error;
  }
}

class SqliteSyncRelayStorage implements SyncRelayStorage {
  workReferenceDatasetAccess?: import("./storage/context").StorageContext["workReferenceDatasetAccess"];
  prepareWorkReferenceRegistration(
    input: Parameters<SyncRelayStorage["prepareWorkReferenceRegistration"]>[0],
  ) {
    return workReferenceStorage.prepareWorkReferenceRegistration(this, input);
  }
  indexReceivedWorkTargets(rows: Parameters<SyncRelayStorage["indexReceivedWorkTargets"]>[0]) {
    workReferenceStorage.indexReceivedWorkTargets(this, rows);
  }
  makeWorkReference(input: Parameters<SyncRelayStorage["makeWorkReference"]>[0]) {
    return workReferenceStorage.makeWorkReference(this, input);
  }
  resolveWorkReference(input: Parameters<SyncRelayStorage["resolveWorkReference"]>[0]) {
    return workReferenceStorage.resolveWorkReference(this, input);
  }
  listWorkReferences(input: Parameters<SyncRelayStorage["listWorkReferences"]>[0]) {
    return workReferenceStorage.listWorkReferences(this, input);
  }
  readonly newDiscussionId: () => string;
  private readingLiveAuthority = false;

  constructor(
    readonly db: SqliteDb,
    readonly options: Required<Omit<OpenSyncRelayStorageOptions, "liveTickets" | "opened">>,
    private readonly liveTickets: LiveTicketStoragePolicy | undefined,
    private readonly owner: RelayWriteOwner,
  ) {
    this.newDiscussionId = options.newDiscussionId;
  }

  invalidate(): void {
    this.owner.invalidate();
  }

  close(): void {
    this.owner.close();
  }

  get unavailable(): AbortSignal {
    return this.owner.unavailable;
  }
  captureStanding(): () => void {
    return this.owner.captureStanding();
  }

  ensureOwnedLiveDocument(input: serviceHostEnrollmentStorage.EnsureOwnedLiveDocumentInput) {
    const result = serviceHostEnrollmentStorage.ensureOwnedLiveDocument(this, input);
    notifyDesktopReadiness(this, { workspaceId: result.workspaceId, path: result.path });
    return result;
  }
  ensureOwnedLiveDocuments(
    inputs: readonly serviceHostEnrollmentStorage.EnsureOwnedLiveDocumentInput[],
  ) {
    const result = serviceHostEnrollmentStorage.ensureOwnedLiveDocuments(this, inputs);
    for (const enrollment of result)
      notifyDesktopReadiness(this, { workspaceId: enrollment.workspaceId, path: enrollment.path });
    return result;
  }
  renewPersonalSessionDemand(input: { workspaceId: string; objectId: string; nowMs: number }) {
    return serviceHostEnrollmentStorage.renewPersonalSessionDemand(this, input);
  }
  moveLiveNote(input: serviceHostEnrollmentStorage.MoveLiveNoteInput) {
    const result = serviceHostEnrollmentStorage.moveLiveNote(this, input),
      moved = result.moved
        ? this.readServiceHostEnrollmentByObjectId(input.workspaceId, input.objectId)
        : null;
    if (moved) notifyDesktopReadiness(this, { workspaceId: moved.workspaceId, path: moved.path });
    return result;
  }
  failLapsedLiveNoteStarts(
    nowMs: number,
    cause: (
      enrollment: serviceHostEnrollmentStorage.ServiceHostEnrollment,
    ) => serviceHostEnrollmentStorage.LiveNoteStartFailure,
  ) {
    return serviceHostEnrollmentStorage.failLapsedLiveNoteStarts(this, nowMs, cause);
  }
  reclaimIdleLiveDocuments(nowMs: number) {
    const result = serviceHostEnrollmentStorage.reclaimIdleLiveDocuments(this, nowMs);
    for (const enrollment of result)
      notifyDesktopReadiness(this, { workspaceId: enrollment.workspaceId, path: enrollment.path });
    return result;
  }
  listServiceHostEnrollments(workspaceId?: string) {
    return serviceHostEnrollmentStorage.listServiceHostEnrollments(this, workspaceId);
  }
  listUndrainedServiceHostEnrollments(
    after?: serviceHostEnrollmentStorage.ServiceHostEnrollmentCursor,
  ) {
    return serviceHostEnrollmentStorage.listUndrainedServiceHostEnrollments(this, after);
  }
  hasKeptServiceHostEnrollment(workspaceId: string, path: string) {
    return serviceHostEnrollmentStorage.hasKeptServiceHostEnrollment(this, workspaceId, path);
  }
  readServiceHostEnrollment(workspaceId: string, path: string) {
    return serviceHostEnrollmentStorage.readServiceHostEnrollment(this, workspaceId, path);
  }
  isHostedForLiveEditing(workspaceId: string, objectId: string) {
    return serviceHostEnrollmentStorage.isHostedForLiveEditing(this, workspaceId, objectId);
  }
  readServiceHostEnrollmentByObjectId(workspaceId: string, objectId: string) {
    return serviceHostEnrollmentStorage.readServiceHostEnrollmentByObjectId(
      this,
      workspaceId,
      objectId,
    );
  }
  listRetiredServiceHostEnrollments(workspaceId: string, after?: string) {
    return serviceHostEnrollmentStorage.listRetiredServiceHostEnrollments(this, workspaceId, after);
  }
  retiredAcceptedCursor(workspaceId: string, objectId: string) {
    return this.readTx(() =>
      serviceActivationRetirementStorage.retiredAcceptedCursor(this, workspaceId, objectId),
    );
  }
  readRetiredJournalPage(
    input: Parameters<typeof serviceActivationRetirementStorage.readRetiredJournalPage>[1],
  ) {
    return serviceActivationRetirementStorage.readRetiredJournalPage(this, input);
  }
  currentServiceHostWorkspace(workspaceId: string, includeUndrained = false) {
    const row = serviceHostEnrollmentStorage.currentServiceHostWorkspace(
      this,
      workspaceId,
      includeUndrained,
    );
    return row && !accountIsFenced(this, row.ownerUserId) ? row : null;
  }
  readServiceHostFeedScope(workspaceId: string) {
    return serviceHostFeedStorage.readServiceHostFeedScope(this, workspaceId);
  }
  listServiceHostDocumentRows(
    input: Parameters<typeof serviceHostFeedStorage.listServiceHostDocumentRows>[1],
  ) {
    return serviceHostFeedStorage.listServiceHostDocumentRows(this, input);
  }
  latestServiceHostDocumentUpdate(
    input: Parameters<typeof serviceHostFeedStorage.latestServiceHostDocumentUpdate>[1],
  ) {
    return serviceHostFeedStorage.latestServiceHostDocumentUpdate(this, input);
  }
  mainLiveLineageExists(document: { workspaceId: string; objectId: string }) {
    return serviceHostFeedStorage.mainLiveLineageExists(this, document);
  }
  hasServiceHostConflictEffect(
    input: Parameters<typeof serviceHostFeedStorage.hasServiceHostConflictEffect>[1],
  ) {
    return serviceHostFeedStorage.hasServiceHostConflictEffect(this, input);
  }
  canResumeMovedServiceHostEnrollment(
    enrollment: Parameters<
      typeof serviceHostEnrollmentStorage.canResumeMovedServiceHostEnrollment
    >[1],
    targetPath: string,
  ) {
    return serviceHostEnrollmentStorage.canResumeMovedServiceHostEnrollment(
      this,
      enrollment,
      targetPath,
    );
  }
  retireIdleServiceHostEnrollment(
    input: Parameters<typeof serviceHostEnrollmentStorage.retireIdleServiceHostEnrollment>[1],
  ) {
    const result = serviceHostEnrollmentStorage.retireIdleServiceHostEnrollment(this, input);
    if (result.status === "retired")
      notifyDesktopReadiness(this, {
        workspaceId: result.enrollment.workspaceId,
        path: result.enrollment.path,
      });
    return result;
  }
  rebindRetiredServiceHostEnrollment(
    input: Parameters<typeof serviceHostEnrollmentStorage.rebindRetiredServiceHostEnrollment>[1],
  ) {
    const result = serviceHostEnrollmentStorage.rebindRetiredServiceHostEnrollment(this, input);
    if (result)
      notifyDesktopReadiness(this, { workspaceId: result.workspaceId, path: result.path });
    return result;
  }
  clearDrainedDeletedServiceHostEnrollment(
    input: Parameters<
      typeof serviceHostEnrollmentStorage.clearDrainedDeletedServiceHostEnrollment
    >[1],
  ) {
    return serviceHostEnrollmentStorage.clearDrainedDeletedServiceHostEnrollment(this, input);
  }
  putServiceHostBlob(input: Parameters<typeof serviceHostUploadStorage.putServiceHostBlob>[1]) {
    return serviceHostUploadStorage.putServiceHostBlob(this, input);
  }
  serviceHostUploaded(workspaceId: string, sha256: string) {
    return serviceHostUploadStorage.serviceHostUploaded(this, workspaceId, sha256);
  }
  prepareSettlementAudits(
    input: { workspaceId: string; ops: SyncRelayLogInput[]; batched: boolean },
    signal?: AbortSignal,
  ) {
    return prepareSettlementAudits(this, input, undefined, signal);
  }
  admitRetirementPublication(
    retirement: ServiceActivationRetirement,
    op: SyncRelayLogInput,
    batch: serviceActivationPublication.RetirementBatch,
  ) {
    return serviceActivationPublication.admitRetirementPublication(this, retirement, op, batch);
  }
  retirementPublicationConfirmed(op: SyncRelayLogInput) {
    return serviceActivationPublication.retirementPublicationConfirmed(op);
  }
  recordServiceKeptEdits(
    input: Parameters<typeof serviceKeptEditsStorage.recordServiceKeptEdits>[1],
  ) {
    return serviceKeptEditsStorage.recordServiceKeptEdits(this, input);
  }
  forgetServiceKeptEdits(queue: serviceKeptEditsStorage.ServiceKeptEditsQueue) {
    return serviceKeptEditsStorage.forgetServiceKeptEdits(this, queue);
  }
  releaseServiceKeptEdits(document: { workspaceId: string; objectId: string }) {
    return serviceKeptEditsStorage.releaseServiceKeptEdits(this, document);
  }
  listServiceKeptEdits(workspaceId: string, after?: number) {
    return serviceKeptEditsStorage.listServiceKeptEdits(this, workspaceId, after);
  }
  readServiceKeptEdits(queue: serviceKeptEditsStorage.ServiceKeptEditsQueue) {
    return serviceKeptEditsStorage.readServiceKeptEdits(this, queue);
  }
  readServiceKeptEditsRefusal(input: {
    workspaceId: string;
    outboxId: string;
    generation: number;
  }) {
    return serviceKeptEditsStorage.readServiceKeptEditsRefusal(this, input);
  }
  serviceKeptEditsOf(document: { workspaceId: string; objectId: string }, after?: number) {
    return serviceKeptEditsStorage.serviceKeptEditsOf(this, document, after);
  }
  markServiceKeptEditsRetrying(input: {
    workspaceId: string;
    outboxId: string;
    generation: number;
  }) {
    return serviceKeptEditsStorage.markServiceKeptEditsRetrying(this, input);
  }
  endServiceKeptEditsRetry(queue: serviceKeptEditsStorage.ServiceKeptEditsQueue) {
    return serviceKeptEditsStorage.endServiceKeptEditsRetry(this, queue);
  }
  confirmServiceKeptEditsCopy(input: {
    workspaceId: string;
    outboxId: string;
    generation: number;
    checkpointDigest: string | null;
  }) {
    return serviceKeptEditsStorage.confirmServiceKeptEditsCopy(this, input);
  }
  observeServiceKeptEditsCheckpoint(
    queue: serviceKeptEditsStorage.ServiceKeptEditsQueue,
    frozenCheckpoint: string | null,
  ) {
    return serviceKeptEditsStorage.observeServiceKeptEditsCheckpoint(this, queue, frozenCheckpoint);
  }
  serviceKeptEditsHeld(
    document: { workspaceId: string; objectId: string },
    identity: serviceKeptEditsStorage.ServiceKeptEditsIdentity,
  ) {
    return serviceKeptEditsStorage.serviceKeptEditsHeld(this, document, identity);
  }
  serviceKeptEditsStoreHeld(
    workspaceId: string,
    identity: serviceKeptEditsStorage.ServiceKeptEditsIdentity,
  ) {
    return serviceKeptEditsStorage.serviceKeptEditsStoreHeld(this, workspaceId, identity);
  }
  scanServiceHostCandidateShares(
    after?: serviceHostEnrollmentStorage.ServiceHostCandidateCursor,
    workspaceId?: string,
  ) {
    return serviceHostEnrollmentStorage.scanServiceHostCandidateShares(this, after, workspaceId);
  }
  checkServiceHostDocuments(
    input: Parameters<typeof serviceHostEnrollmentStorage.checkServiceHostDocuments>[1],
  ) {
    return serviceHostEnrollmentStorage.checkServiceHostDocuments(this, input);
  }
  setServiceHostEnrollmentEnabled(
    input: serviceHostEnrollmentStorage.SetServiceHostEnrollmentEnabledInput,
  ) {
    const result = serviceHostEnrollmentStorage.setServiceHostEnrollmentEnabled(this, input);
    if (result)
      notifyDesktopReadiness(this, { workspaceId: result.workspaceId, path: result.path });
    return result;
  }
  serviceHostEnrollmentsCoveredByShare(shareId: string) {
    return serviceHostEnrollmentStorage.serviceHostEnrollmentsCoveredByShare(this, shareId);
  }
  serviceHostEnrollmentCovered(
    enrollment: Pick<
      serviceHostEnrollmentStorage.ServiceHostEnrollment,
      "workspaceId" | "objectId" | "ownerUserId" | "shareId" | "path"
    >,
    nowMs?: number,
  ) {
    return serviceHostEnrollmentStorage.serviceHostEnrollmentCovered(this, enrollment, nowMs);
  }
  serviceHostDocumentEnabled(document: { workspaceId: string; objectId: string }) {
    return serviceHostEnrollmentStorage.serviceHostDocumentEnabled(this, document);
  }
  serviceActivationRetirement(document: { workspaceId: string; objectId: string }) {
    return serviceActivationRetirementStorage.readServiceActivationRetirement(this, document);
  }
  serviceActivationRetirements(workspaceId: string) {
    return serviceActivationRetirementStorage.listServiceActivationRetirements(this, workspaceId);
  }
  serviceActivationRetirementDecision(
    document: { workspaceId: string; objectId: string },
    activation: serviceActivationRetirementStorage.RetirableServiceActivation,
  ) {
    return serviceActivationRetirementStorage.readServiceActivationRetirementDecision(
      this,
      document,
      activation,
    );
  }
  retirableServiceActivation(document: { workspaceId: string; objectId: string }) {
    return serviceActivationRetirementStorage.retirableServiceActivation(this, document);
  }
  retirementJournalEvidence(
    retirement: ServiceActivationRetirement,
    deliveryIds: readonly string[],
  ) {
    return serviceActivationRetirementStorage.retirementJournalEvidence(
      this,
      retirement,
      deliveryIds,
    );
  }
  endLapsedServiceHostRun(
    enrollment: serviceHostEnrollmentStorage.ServiceHostEnrollment,
    nowMs: number,
  ) {
    return serviceHostEnrollmentStorage.endLapsedServiceHostRun(this, enrollment, nowMs);
  }
  releaseServiceHostEnrollment(input: { workspaceId: string; objectId: string; nowMs: number }) {
    const result = serviceHostEnrollmentStorage.releaseServiceHostEnrollment(this, input);
    if (result)
      notifyDesktopReadiness(this, { workspaceId: result.workspaceId, path: result.path });
    return result;
  }

  resolveCurrentLiveDocumentBinding(
    input: CurrentLiveBindingRequest,
    activation?: ServiceActivationAccess,
  ): CurrentLiveBindingResult {
    return liveDocumentAuthorityStorage.resolveCurrentLiveDocumentBinding(this, input, activation);
  }

  resolveCurrentLiveDocumentBindingFromMetadata(
    input: CurrentLiveBindingRequest,
  ): CurrentLiveBindingResult {
    return liveDocumentAuthorityStorage.resolveCurrentLiveDocumentBindingFromMetadata(this, input);
  }

  automationRecordWriteAllowed(
    input: Parameters<SyncRelayStorage["automationRecordWriteAllowed"]>[0],
  ): boolean {
    const { authority, ...target } = input;
    return this.readTx(() =>
      "hostPressId" in authority
        ? automationPressStorage.automationPressAdmissionAllowed(this, { ...target, ...authority })
        : automationPressStorage.automationGrantAdmissionAllowed(this, { ...target, ...authority }),
    );
  }

  automationRecordBinding(workspaceId: string, ownerUserId: string, path: string) {
    return liveDocumentAuthorityStorage.automationRecordBinding(
      this,
      workspaceId,
      ownerUserId,
      path,
    );
  }

  readAcceptedLiveDocument(workspaceId: string, path: string): AcceptedLiveDocument {
    const document = liveDocumentAuthorityStorage.currentLiveDocument(this, workspaceId, path);
    if (document === null) return { kind: "none" };
    const read = this.readLiveUpdateJournalCut({ document });
    return read.kind === "cut" && read.cut.currentPath === path ? read : { kind: "none" };
  }

  /** Internal replica refresh hint; accepted bytes still pass the journal's validated sync path. */
  automationRecordJournalCursor(
    binding: import("@dohc/live-session-contract/live-object-binding").LiveObjectBinding,
  ): number {
    return Number(
      this.db
        .prepare(`SELECT COALESCE(MAX(journal_cursor),0) AS cursor FROM sync_relay_live_update_journal
      WHERE workspace_id=? AND main_version_id=? AND object_id=? AND lineage_claim_id=?`)
        .get(binding.workspaceId, binding.mainVersionId, binding.objectId, binding.lineageClaimId)!
        .cursor,
    );
  }

  resolveLiveObjectHostBinding(
    scope: Parameters<typeof liveDocumentAuthorityStorage.resolveLiveObjectHostBinding>[1],
    objectId: string,
  ): liveDocumentAuthorityStorage.LiveObjectHostBindingResult {
    return liveDocumentAuthorityStorage.resolveLiveObjectHostBinding(this, scope, objectId);
  }

  registerLiveDocumentBaseline(
    input: LiveDocumentBaselineRegistrationInput,
  ): RelayBaselineRegistrationResult {
    return liveDocumentAuthorityStorage.registerLiveDocumentBaseline(this, input);
  }

  liveNoteFormatOff(document: LiveDocumentKey): boolean {
    return liveDocumentAuthorityStorage.liveNoteFormatOff(this, document);
  }

  readLiveUpdateJournalCut(
    input: { document: LiveDocumentKey },
    reserveBytes?: (size: number) => void,
    timing?: JournalCutReadTiming,
  ): LiveUpdateJournalCutResult {
    return liveUpdateJournalStorage.readLiveUpdateJournalCut(this, input, reserveBytes, timing);
  }

  commitLiveUpdateJournal(
    input: LiveUpdateJournalCommitInput,
    activation?: ServiceActivationAccess,
  ): RelayLiveUpdateJournalResult {
    return liveUpdateJournalStorage.commitLiveUpdateJournal(this, input, activation);
  }

  readCommittedLiveUpdate(input: {
    host: LiveHostConnectionCoordinate;
    document: LiveDocumentKey;
    journalCursor: number;
  }): CommittedLiveUpdateResult {
    return liveUpdateJournalStorage.readCommittedLiveUpdate(this, input);
  }

  createLiveCommittedDeliveryStore(
    history: LiveJournalHistoryAuthority,
    activation?: ServiceActivationAccess,
  ): LiveCommittedDeliveryStore {
    return new LiveCommittedDeliveryStore(this, history, activation);
  }
  createServiceActivationStore(history: LiveJournalHistoryAuthority): ServiceActivationStore {
    return new ServiceActivationStore(this, history);
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

  registerLiveHost(
    input: LiveHostConnectionCoordinate & {
      updatedAtMs: number;
      guard: () => void;
    },
  ): LiveHostControlResult {
    return hostControlStorage.registerLiveHost(this, input);
  }

  disconnectLiveHost(
    input: LiveHostConnectionCoordinate & {
      updatedAtMs: number;
      guard: () => void;
    },
  ): LiveHostControlResult {
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
    return (
      !accountIsFenced(this, ownerUserId) &&
      workspacesStorage.workspaceIsOwnedBy(this, workspaceId, ownerUserId)
    );
  }
  workspaceOwner(workspaceId: string): string | null {
    return workspacesStorage.workspaceOwner(this, workspaceId);
  }

  postAutomationWake(
    input: noticeStorage.PostAutomationWakeInput,
  ): noticeStorage.PostedAutomationWake {
    return noticeStorage.postAutomationWake(this, input);
  }

  readPushSubscription(installationId: string): pushStorage.PushSubscriptionRow | null {
    return this.readTx(() => pushStorage.readPushSubscription(this, installationId));
  }

  bindPushSubscription(
    input: pushStorage.BindPushSubscriptionInput,
  ): pushStorage.PushSubscriptionRow {
    return pushStorage.bindPushSubscription(this, input);
  }
  beginAccountNameLookup(): AccountNameLookupToken {
    return beginAccountNameLookup(this);
  }
  recordAccountName(
    userId: string,
    name: string | null,
    nowMs?: number,
    generation?: number,
  ): void {
    recordAccountName(this, userId, name, nowMs, generation);
  }
  recordAccountNames(
    entries: Iterable<readonly [string, string | null]>,
    nowMs?: number,
    generation?: number,
  ): void {
    recordAccountNames(this, entries, nowMs, generation);
  }
  workspaceAccountIds(workspaceId: string, limit?: number): string[] {
    return workspaceAccountIds(this, workspaceId, limit);
  }
  unnamedAccountIds(limit: number, afterUserId?: string): string[] {
    return unnamedAccountIds(this, limit, afterUserId);
  }

  removePushSubscription(input: { installationId: string; userId: string }): void {
    pushStorage.removePushSubscription(this, input);
  }

  readPushDevice(input: {
    userId: string;
    sessionId: string;
    nowMs: number;
  }): pushDeviceStorage.PushDeviceRow | null {
    return this.readTx(() => pushDeviceStorage.readPushDevice(this, input));
  }

  bindPushDevice(input: pushDeviceStorage.BindPushDeviceInput): pushDeviceStorage.PushDeviceRow {
    return pushDeviceStorage.bindPushDevice(this, input);
  }

  removePushDevice(input: { userId: string; sessionId: string; generation: number }): void {
    pushDeviceStorage.removePushDevice(this, input);
  }

  fencePushSession(input: pushDeviceStorage.PushSessionFence & { expiresAtMs: number }): void {
    pushDeviceStorage.fencePushSession(this, input);
  }

  settlePushSessionFence(
    input: pushDeviceStorage.PushSessionFence & { revokedExpiresAtMs: number | null },
  ): void {
    pushDeviceStorage.settlePushSessionFence(this, input);
  }

  sweepExpiredPushDevices(nowMs: number): void {
    pushDeviceStorage.sweepExpiredPushDevices(this, nowMs);
  }

  postNotice(input: noticeStorage.PostNoticeInput): void {
    noticeStorage.postNotice(this, input);
  }

  readNoticeChanges(input: noticeStorage.ReadNoticeChangesInput) {
    return noticeStorage.readNoticeChanges(this, input);
  }

  noticeHead(recipientUserId: string): number {
    return noticeStorage.noticeHead(this, recipientUserId);
  }

  markNotices(input: noticeStorage.MarkNoticesInput): { dismissed: string[]; repeated: string[] } {
    return noticeStorage.markNotices(this, input);
  }

  noticeShareReceived(input: noticeStorage.NoticeShareReceivedInput): void {
    noticeStorage.noticeShareReceived(this, input);
  }

  pendingShareNotices(recipientUserId: string) {
    return noticeStorage.pendingShareNotices(this, recipientUserId);
  }

  readAutomationHost(input: automationHostStorage.AutomationHostReadInput) {
    return automationHostStorage.readAutomationHost(this, input);
  }

  checkInAutomationComputer(input: automationHostStorage.AutomationHostCheckInInput) {
    return automationHostStorage.checkInAutomationComputer(this, input);
  }

  chooseAutomationHost(input: automationHostStorage.AutomationHostChooseInput) {
    return automationHostStorage.chooseAutomationHost(this, input);
  }

  releaseAutomationHost(input: automationHostStorage.AutomationHostReleaseInput) {
    return automationHostStorage.releaseAutomationHost(this, input);
  }

  takeOverAutomationHost(input: automationHostStorage.AutomationHostTakeOverInput) {
    return automationHostStorage.takeOverAutomationHost(this, input);
  }

  readAutomationGroupHandover(input: automationHostStorage.AutomationGroupHandoverInput) {
    return automationHostStorage.readAutomationGroupHandover(this, input);
  }

  authorizeLinkCollectionWrite(
    input: Parameters<typeof collectionWriteStorage.authorizeLinkCollectionWrite>[1],
  ) {
    return this.readTx(
      () => collectionWriteStorage.authorizeLinkCollectionWrite(this, input).authorized,
    );
  }

  authorizeAgentCollectionWrite(
    input: Parameters<typeof collectionWriteStorage.authorizeAgentCollectionWrite>[1],
  ) {
    return this.readTx(
      () => collectionWriteStorage.authorizeAgentCollectionWrite(this, input).authorized,
    );
  }

  automationHostRecord(workspaceId: string) {
    return automationHostStorage.automationHostRecord(this, workspaceId);
  }

  readAutomationServerSchedules(workspaceId: string) {
    return this.readTx(() =>
      automationHostStorage.readAutomationServerSchedules(this, workspaceId),
    );
  }

  beginAutomationServerCopy(input: { workspaceId: string; incarnation: number }) {
    automationHostStorage.beginAutomationServerCopy(this, input);
  }

  recordAutomationServerStart(
    input: Parameters<typeof automationHostStorage.recordAutomationServerStart>[1],
  ) {
    automationHostStorage.recordAutomationServerStart(this, input);
  }

  recordAutomationServerTaken(input: { workspaceId: string; generation: number }) {
    automationHostStorage.recordAutomationServerTaken(this, input);
  }

  recordAutomationServerProgress(input: { workspaceId: string; throughMs: number }) {
    automationHostStorage.recordAutomationServerProgress(this, input);
  }

  recordAutomationServerRunChanging(
    input: Parameters<typeof automationHostStorage.recordAutomationServerRunChanging>[1],
  ) {
    automationHostStorage.recordAutomationServerRunChanging(this, input);
  }

  endAutomationServerRun(input: automationHostStorage.AutomationServerRun) {
    return automationHostStorage.endAutomationServerRun(this, input);
  }

  endedAutomationServerRuns(input: { workspaceId: string; incarnation: number }) {
    return this.readTx(() => automationHostStorage.endedAutomationServerRuns(this, input));
  }

  confirmAutomationServerRunsSent(
    input: Parameters<typeof automationHostStorage.confirmAutomationServerRunsSent>[1],
  ) {
    automationHostStorage.confirmAutomationServerRunsSent(this, input);
  }

  markAutomationServerRunsLost(input: { workspaceId: string; incarnation: number; nowMs: number }) {
    automationHostStorage.markAutomationServerRunsLost(this, input);
  }

  lostAutomationServerRuns(
    input: Parameters<typeof automationHostStorage.lostAutomationServerRuns>[1],
  ) {
    return this.readTx(() => automationHostStorage.lostAutomationServerRuns(this, input));
  }

  unreportedLostAutomationServerRuns(input: { workspaceId: string; nowMs: number }) {
    return this.readTx(() => automationHostStorage.unreportedLostAutomationServerRuns(this, input));
  }

  reportAutomationServerRunsLost(
    input: Parameters<typeof automationHostStorage.reportAutomationServerRunsLost>[1],
  ) {
    automationHostStorage.reportAutomationServerRunsLost(this, input);
  }

  joinAutomationWorkspace(input: {
    workspaceId: string;
    nowMs: number;
    reasons: readonly automationWorkspaceStorage.CopyReason[];
  }) {
    return automationWorkspaceStorage.joinAutomationWorkspace(this, input);
  }

  replaceLostAutomationReplica(input: { workspaceId: string; incarnation: number; nowMs: number }) {
    return automationWorkspaceStorage.replaceLostAutomationReplica(this, input);
  }

  unwantAutomationWorkspace(input: { workspaceId: string; nowMs: number }) {
    return automationWorkspaceStorage.unwantAutomationWorkspace(this, input);
  }

  listAutomationWorkspaces() {
    return automationWorkspaceStorage.listAutomationWorkspaces(this);
  }

  forgetAutomationWorkspace(input: { workspaceId: string; incarnation: number }) {
    automationWorkspaceStorage.forgetAutomationWorkspace(this, input);
  }

  forgetAutomationWorkspaces(kept?: readonly string[]) {
    automationWorkspaceStorage.forgetAutomationWorkspaces(this, kept);
  }

  endCopyReasonEverywhere(reason: automationWorkspaceStorage.CopyReason) {
    automationWorkspaceStorage.endCopyReasonEverywhere(this, reason);
  }

  endCopyReason(workspaceId: string, reason: automationWorkspaceStorage.CopyReason) {
    this.tx(() => automationWorkspaceStorage.endCopyReasonInTransaction(this, workspaceId, reason));
  }

  listAccountWorkspaces(userId: string) {
    return accountWorkspaceStorage.listAccountWorkspaces(this, userId);
  }

  showsOnPhone(userId: string, workspaceId: string) {
    return accountWorkspaceStorage.showsOnPhone(this, userId, workspaceId);
  }

  phoneRole(userId: string, workspaceId: string) {
    return accountWorkspaceStorage.phoneRole(this, userId, workspaceId);
  }

  setShowOnPhone(input: { userId: string; workspaceId: string; showOnPhone: boolean }) {
    return accountWorkspaceStorage.setShowOnPhone(this, input);
  }

  endAccountReasonsOfHiddenOrDisownedCopies() {
    accountWorkspaceStorage.endAccountReasonsOfHiddenOrDisownedCopies(this);
  }

  recordAccountOperation(input: operationRecordStorage.RecordOperationInput) {
    return operationRecordStorage.recordOperation(this, input);
  }

  lookupAccountOperation(input: {
    accountId: string;
    operationId: string;
    binding: operationRecordStorage.OperationBinding;
  }) {
    return operationRecordStorage.lookupOperation(this, input);
  }

  advanceAccountOperation(input: operationRecordStorage.AdvanceOperationInput) {
    return operationRecordStorage.advanceOperation(this, input);
  }

  listUnfinishedAccountOperations(input: { workspaceId: string; incarnation?: number }) {
    return operationRecordStorage.listUnfinishedOperations(this, input);
  }

  listUnfinishedOperationCopies() {
    return operationRecordStorage.listUnfinishedOperationCopies(this);
  }

  unfinishedOperationActiveEnds() {
    return operationRecordStorage.unfinishedOperationActiveEnds(this);
  }

  fetchAccountOperationLogRow(input: Parameters<typeof operationRecordStorage.operationLogRow>[1]) {
    return operationRecordStorage.operationLogRow(this, input);
  }

  publishingCopies() {
    return this.readTx(() => this.publishingCopiesInTransaction());
  }

  // Each pass asks, so it writes only when the reasons changed.
  restorePublicationReasons() {
    const changed = () =>
      JSON.stringify(this.publishingWorkspaceIds()) !==
      JSON.stringify(operationRecordStorage.publicationReasonCopiesInTransaction(this).sort());
    if (!this.readTx(changed)) return;
    this.tx(() =>
      operationRecordStorage.setPublicationReasonsInTransaction(
        this,
        this.publishingWorkspaceIds(),
      ),
    );
  }

  private publishingCopiesInTransaction() {
    return operationRecordStorage
      .publishingCopiesInTransaction(this)
      .filter(
        (copy) =>
          !accountIsFenced(this, copy.ownerUserId) && !workspaceIsDeleted(this, copy.workspaceId),
      );
  }

  private publishingWorkspaceIds() {
    return [
      ...new Set(this.publishingCopiesInTransaction().map((copy) => copy.workspaceId)),
    ].sort();
  }

  tombstoneSettledAccountOperations(nowMs: number) {
    return operationRecordStorage.tombstoneSettledOperations(this, nowMs);
  }

  replaceChatRunners(input: Parameters<typeof chatWakeStorage.replaceChatRunners>[1]) {
    return chatWakeStorage.replaceChatRunners(this, input);
  }

  enabledChatRunners(input: { accountId: string; workspaceId: string; nowMs: number }) {
    return chatWakeStorage.enabledChatRunners(this, input);
  }

  declaredAgentNames(input: { accountId: string; workspaceId: string }) {
    return chatWakeStorage.declaredAgentNames(this, input);
  }

  chatWakeHead(accountId: string) {
    return chatWakeStorage.chatWakeHead(this, accountId);
  }

  phoneChatWakes(input: Parameters<typeof chatWakeStorage.phoneChatWakes>[1]) {
    return chatWakeStorage.phoneChatWakes(this, input);
  }

  chatWakeChanges(input: Parameters<typeof chatWakeStorage.chatWakeChanges>[1]) {
    return chatWakeStorage.chatWakeChanges(this, input);
  }

  listWaitingChatWakes(input: Parameters<typeof chatWakeStorage.listWaitingChatWakes>[1]) {
    return chatWakeStorage.listWaitingChatWakes(this, input);
  }

  claimChatWake(input: Parameters<typeof chatWakeStorage.claimChatWake>[1]) {
    return chatWakeStorage.claimChatWake(this, input);
  }

  confirmChatWakeQueued(input: Parameters<typeof chatWakeStorage.confirmChatWakeQueued>[1]) {
    return chatWakeStorage.confirmChatWakeQueued(this, input);
  }

  retryWakeThreads(input: Parameters<typeof chatWakeStorage.retryWakeThreads>[1]) {
    return chatWakeStorage.retryWakeThreads(this, input);
  }

  retryChatWake(input: Parameters<typeof chatWakeStorage.retryChatWake>[1]) {
    return chatWakeStorage.retryChatWake(this, input);
  }

  sweepChatWakes(nowMs: number) {
    return chatWakeStorage.sweepChatWakes(this, nowMs);
  }

  accountFeedStanding(workspaceId: string) {
    return accountFeedStorage.accountFeedStanding(this, workspaceId);
  }

  accountFeedLogRows(input: {
    workspaceId: string;
    after: number;
    through: number;
    limit: number;
  }) {
    return accountFeedStorage.accountFeedLogRows(this, input);
  }

  accountFeedJournalRows(input: {
    workspaceId: string;
    after: number;
    through: number;
    limit: number;
  }) {
    return accountFeedStorage.accountFeedJournalRows(this, input);
  }

  accountFeedThreadPaths(workspaceId: string, threadId: string) {
    return accountFeedStorage.accountFeedThreadPaths(this, workspaceId, threadId);
  }

  currentAutomationWorkspace(workspaceId: string) {
    const row = automationWorkspaceStorage.currentAutomationWorkspace(this, workspaceId);
    return row && !accountIsFenced(this, row.ownerUserId) ? row : null;
  }

  liveClaimLogSeq(input: { workspaceId: string; liveCursor: number }) {
    return automationWorkspaceStorage.liveClaimLogSeq(this, input);
  }

  automationWorkspaceLogSeq(input: { workspaceId: string; originId: string; originSeq: number }) {
    return automationWorkspaceStorage.automationWorkspaceLogSeq(this, input);
  }

  serverHostedWorkspaces() {
    return automationWorkspaceStorage.serverHostedWorkspaces(this);
  }

  restoreAutomationWorkspaceTimes(input: {
    workspaceId: string;
    incarnation: number;
    unwantedSinceMs: number;
    leftAtMs: number | null;
  }) {
    automationWorkspaceStorage.restoreAutomationWorkspaceTimes(this, input);
  }

  automationWorkspaceInfo(workspaceId: string) {
    return automationWorkspaceStorage.automationWorkspaceInfo(this, workspaceId);
  }
  automationWorkspaceLogHead(workspaceId: string) {
    return automationWorkspaceStorage.automationWorkspaceLogHead(this, workspaceId);
  }

  commitCollectionWrite(input: collectionWriteStorage.CommitCollectionWriteInput) {
    return collectionWriteStorage.commitCollectionWrite(this, input);
  }

  checkPersonalCollectionWriter(
    input: collectionWriteStorage.PersonalWriterInput,
    nowMs: number,
  ): void {
    collectionWriteStorage.checkPersonalCollectionWriter(this, input, nowMs);
  }

  commitPersonalCollectionWrite(input: collectionWriteStorage.CommitPersonalCollectionWriteInput) {
    return collectionWriteStorage.commitPersonalCollectionWrite(this, input);
  }

  memberFolders(workspaceId: string, userId: string, grantId?: string): MemberFolders | null {
    return collectionWriteStorage.memberFolders(this, workspaceId, userId, grantId);
  }

  automationSwitchableFolder(workspaceId: string, folder: string): boolean {
    return collectionWriteStorage.automationSwitchableFolder(this, workspaceId, folder);
  }

  readOwnerCollectionWrites(input: ownerCollectionWriteStorage.OwnerCollectionWritesInput) {
    return ownerCollectionWriteStorage.readOwnerCollectionWrites(this, input);
  }

  recordAutomationPress(input: automationPressStorage.RecordAutomationPressInput) {
    return automationPressStorage.recordAutomationPress(this, input);
  }

  resolveAutomationPress(
    input: Parameters<typeof automationPressStorage.resolveAutomationPress>[1],
  ) {
    return automationPressStorage.resolveAutomationPress(this, input);
  }

  inspectAutomationButton(input: buttonInspections.ButtonInspectionInput) {
    return buttonInspections.inspectAutomationButton(this, input);
  }
  parkButtonInspectionHost(scope: import("./storage/automationPresses").HostScope) {
    return buttonInspections.parkButtonInspectionHost(this, scope);
  }
  listButtonInspections(input: Parameters<typeof buttonInspections.listButtonInspections>[1]) {
    return buttonInspections.listButtonInspections(this, input);
  }
  resolveButtonInspection(input: Parameters<typeof buttonInspections.resolveButtonInspection>[1]) {
    return buttonInspections.resolveButtonInspection(this, input);
  }
  answerButtonInspection(
    input: Parameters<typeof buttonInspections.answerButtonInspection>[1],
    result: Parameters<typeof buttonInspections.answerButtonInspection>[2],
  ) {
    return buttonInspections.answerButtonInspection(this, input, result);
  }

  listAutomationPresses(input: automationPressStorage.HostScope & { nowMs: number }) {
    return automationPressStorage.listAutomationPresses(this, input);
  }

  automationPressWait(input: automationPressStorage.HostScope & { nowMs: number }) {
    return automationPressStorage.automationPressWait(this, input);
  }

  pruneExpiredAutomationPresses(nowMs: number) {
    return this.tx(() => automationPressStorage.pruneExpired(this, nowMs));
  }

  acceptAutomationPresses(
    input: Parameters<typeof automationPressStorage.acceptAutomationPresses>[1],
  ) {
    return automationPressStorage.acceptAutomationPresses(this, input);
  }

  settleAutomationPress(input: Parameters<typeof automationPressStorage.settleAutomationPress>[1]) {
    return automationPressStorage.settleAutomationPress(this, input);
  }

  publishAppPublication(input: publicationStorage.PublishAppPublicationInput) {
    return publicationStorage.publishAppPublication(this, input);
  }

  approveAppCollection(input: appCollectionStorage.ApproveAppCollectionInput) {
    return appCollectionStorage.approveAppCollection(this, input);
  }

  acceptAppCollection(
    input: appCollectionStorage.AcceptAppCollectionInput,
    policy: appCollectionStorage.AppCollectionAcceptancePolicy,
  ) {
    return appCollectionStorage.acceptAppCollection(this, input, policy);
  }

  readAppCollection(input: appCollectionStorage.ReadAppCollectionInput) {
    return appCollectionStorage.readAppCollection(this, input);
  }
  authorizeLinkAppCollection(input: publicationStorage.LinkAppPublicationInput) {
    return appCollectionStorage.authorizeLinkAppCollection(this, input);
  }
  createDatasetHost(options: Omit<RelayDatasetHostOptions, "storage">) {
    return createRelayDatasetHost({ ...options, storage: this });
  }

  readOwnerAppCollectionAcceptances(
    input: appCollectionModeration.OwnerAppCollectionAcceptancesInput,
  ) {
    return appCollectionModeration.readOwnerAppCollectionAcceptances(this, input);
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

  disableAppPublication(input: publicationStorage.DisableAppPublicationInput) {
    return publicationStorage.disableAppPublication(this, input);
  }

  liftAppPublishingHold(publicationId: string) {
    return publicationStorage.liftAppPublishingHold(this, publicationId);
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

  readLinkAppPublicationBlob(
    input: publicationStorage.LinkAppPublicationInput & {
      sha256: string;
      expectedAuthorityRevision: number;
    },
  ) {
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

  async prepareLogAppend(
    input: { workspaceId: string; originId: string; ops: SyncRelayLogInput[] },
    signal?: AbortSignal,
  ): Promise<void> {
    await prepareHostedSettlements(this, input, undefined, signal);
    await prepareLiveApplications(this, input, signal);
  }

  appendLogBatch(input: {
    workspaceId: string;
    originId: string;
    ops: SyncRelayLogInput[];
    guard?: (context: AppendLogBatchGuardContext) => void;
    admit?: (ops: SyncRelayLogInput[]) => void;
    confirm?: (ops: SyncRelayLogInput[]) => void;
    classifyRedundantRecoveries?: boolean;
    workReferences?: {
      userId: string;
      references: readonly import("@dohc/workspace-engine-client/daemon").WorkReferenceMapping[];
      datasetAccess?: import("./storage/workReferences").DatasetReferenceAccess;
    };
  }): AppendLogBatchResult {
    return logStorage.appendLogBatch(this, input);
  }

  createShare(input: { share: SyncRelayShareRow; grant: SyncRelayShareGrantRow }): boolean {
    return sharesStorage.createShare(this, input);
  }

  readLinkCreation(
    workspaceId: string,
    operationId: string,
    ownerUserId: string,
  ): { shareId: string; grantId: string; requestJson: string } | null {
    if (!this.workspaceIsOwnedBy(workspaceId, ownerUserId)) return null;
    const row = this.db
      .prepare(
        "SELECT * FROM sync_relay_link_creations WHERE workspace_id=? AND operation_id=? AND owner_user_id=?",
      )
      .get(workspaceId, operationId, ownerUserId);
    return row
      ? {
          shareId: String(row.share_id),
          grantId: String(row.grant_id),
          requestJson: String(row.request_json),
        }
      : null;
  }

  createFileLinkShare(input: {
    operation?: { operationId: string; requestJson: string };
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

  findLinkGrantByCredentialHash(secretHash: string): SyncRelayLinkCredentialGrantRow | null {
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
    const result = sharesStorage.retuneShareGrant(this, input);
    if (result.ok) notifyDesktopReadiness(this, { shareId: result.grant.shareId });
    return result;
  }

  retuneNamedShareGrant(input: {
    shareId: string;
    grantId: string;
    access: string;
    changedAtMs: number;
    guard: () => void;
  }): ShareGrantTransitionResult {
    const result = sharesStorage.retuneNamedShareGrant(this, input);
    if (result.ok) notifyDesktopReadiness(this, { shareId: result.grant.shareId });
    return result;
  }

  revokeShareGrant(input: {
    shareId: string;
    grantId: string;
    revokedAtMs: number;
    expectedDependentGrantIds?: readonly string[];
    guard?: () => void;
  }): LinkGrantTransitionResult {
    const result = sharesStorage.revokeShareGrant(this, input);
    if (result.ok) notifyDesktopReadiness(this, { shareId: result.grant.shareId });
    return result;
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

  findLinkSessionByCapabilityHash(capabilityHash: string): SyncRelayLinkSessionRow | null {
    return sharesStorage.findLinkSessionByCapabilityHash(this, capabilityHash);
  }

  appendLinkDiscussionMessage(
    input: discussionStorage.AppendLinkDiscussionMessageInput,
  ): AppendLinkDiscussionMessageResult {
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

  mintLinkHandoffCode(input: { code: SyncRelayLinkHandoffCodeRow; guard: () => boolean }): boolean {
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

  hasPendingInvite(email: string): boolean {
    return sharesStorage.hasPendingInvite(this, email);
  }
  workspaceMemberGrantIsCurrent(
    ...args: Parameters<SyncRelayStorage["workspaceMemberGrantIsCurrent"]>
  ) {
    return workspaceMembersStorage.workspaceMemberGrantIsCurrent(this, ...args);
  }
  workspaceMemberGrantRole(...args: Parameters<SyncRelayStorage["workspaceMemberGrantRole"]>) {
    return workspaceMembersStorage.workspaceMemberGrantRole(this, ...args);
  }
  workspaceRoleOf(...args: Parameters<SyncRelayStorage["workspaceRoleOf"]>) {
    return workspaceMembersStorage.workspaceRoleOf(this, ...args);
  }
  listJoinedWorkspaces(...args: Parameters<SyncRelayStorage["listJoinedWorkspaces"]>) {
    return workspaceMembersStorage.listJoinedWorkspaces(this, ...args);
  }
  workspaceLevelChangedBy(...args: Parameters<SyncRelayStorage["workspaceLevelChangedBy"]>) {
    return workspaceMembersStorage.workspaceLevelChangedBy(this, ...args);
  }
  createWorkspaceGroup(...args: Parameters<SyncRelayStorage["createWorkspaceGroup"]>) {
    return workspaceMembersStorage.createWorkspaceGroup(this, ...args);
  }
  setWorkspaceGroupRule(...args: Parameters<SyncRelayStorage["setWorkspaceGroupRule"]>) {
    return workspaceMembersStorage.setWorkspaceGroupRule(this, ...args);
  }
  deleteWorkspaceMessage(...args: Parameters<SyncRelayStorage["deleteWorkspaceMessage"]>) {
    return messageDeletesStorage.deleteWorkspaceMessage(this, ...args);
  }
  deletedMessageCount(...args: Parameters<SyncRelayStorage["deletedMessageCount"]>) {
    return messageDeletesStorage.deletedMessageCount(this, ...args);
  }
  messageDeleted(...args: Parameters<SyncRelayStorage["messageDeleted"]>) {
    return messageDeletesStorage.messageDeleted(this, ...args);
  }
  deletedMessageTimes(...args: Parameters<SyncRelayStorage["deletedMessageTimes"]>) {
    return messageDeletesStorage.deletedMessageTimes(this, ...args);
  }
  changeFolderRule(...args: Parameters<SyncRelayStorage["changeFolderRule"]>) {
    return folderRulesStorage.changeFolderRule(this, ...args);
  }
  removeFolderMarkers(...args: Parameters<SyncRelayStorage["removeFolderMarkers"]>) {
    return folderRulesStorage.removeFolderMarkers(this, ...args);
  }
  readFolderRules(...args: Parameters<SyncRelayStorage["readFolderRules"]>) {
    return folderRulesStorage.readFolderRules(this, ...args);
  }
  resolveDirectPick(...args: Parameters<SyncRelayStorage["resolveDirectPick"]>) {
    return directMessagesStorage.resolveDirectPick(this, ...args);
  }
  findDirectConversation(...args: Parameters<SyncRelayStorage["findDirectConversation"]>) {
    return directMessagesStorage.findDirectConversation(this, ...args);
  }
  directPerson(...args: Parameters<SyncRelayStorage["directPerson"]>) {
    return directMessagesStorage.directPerson(this, ...args);
  }
  sendDirectMessage(...args: Parameters<SyncRelayStorage["sendDirectMessage"]>) {
    return directMessagesStorage.sendDirectMessage(this, ...args);
  }
  listDirectConversations(...args: Parameters<SyncRelayStorage["listDirectConversations"]>) {
    return directMessagesStorage.listDirectConversations(this, ...args);
  }
  readDirectMessages(...args: Parameters<SyncRelayStorage["readDirectMessages"]>) {
    return directMessagesStorage.readDirectMessages(this, ...args);
  }
  markDirectRead(...args: Parameters<SyncRelayStorage["markDirectRead"]>) {
    return directMessagesStorage.markDirectRead(this, ...args);
  }
  setDirectBlock(...args: Parameters<SyncRelayStorage["setDirectBlock"]>) {
    return directMessagesStorage.setDirectBlock(this, ...args);
  }
  directRevision(...args: Parameters<SyncRelayStorage["directRevision"]>) {
    return directMessagesStorage.directRevision(this, ...args);
  }
  readWorkspaceMembers(...args: Parameters<SyncRelayStorage["readWorkspaceMembers"]>) {
    return workspaceMembersStorage.readWorkspaceMembers(this, ...args);
  }
  getWorkspaceMembershipByShare(
    ...args: Parameters<SyncRelayStorage["getWorkspaceMembershipByShare"]>
  ) {
    return workspaceMembersStorage.getWorkspaceMembershipByShare(this, ...args);
  }
  inviteWorkspaceMember(...args: Parameters<SyncRelayStorage["inviteWorkspaceMember"]>) {
    return workspaceMembersStorage.inviteWorkspaceMember(this, ...args);
  }
  setWorkspaceMemberLevel(...args: Parameters<SyncRelayStorage["setWorkspaceMemberLevel"]>) {
    return workspaceMembersStorage.setWorkspaceMemberLevel(this, ...args);
  }
  setWorkspaceMemberRole(...args: Parameters<SyncRelayStorage["setWorkspaceMemberRole"]>) {
    return workspaceMembersStorage.setWorkspaceMemberRole(this, ...args);
  }
  removeWorkspaceMember(...args: Parameters<SyncRelayStorage["removeWorkspaceMember"]>) {
    return workspaceMembersStorage.removeWorkspaceMember(this, ...args);
  }
  letWorkspaceMemberBackIn(...args: Parameters<SyncRelayStorage["letWorkspaceMemberBackIn"]>) {
    return workspaceMembersStorage.letWorkspaceMemberBackIn(this, ...args);
  }
  leaveWorkspace(...args: Parameters<SyncRelayStorage["leaveWorkspace"]>) {
    return workspaceMembersStorage.leaveWorkspace(this, ...args);
  }
  endWorkspaceMembership(...args: Parameters<SyncRelayStorage["endWorkspaceMembership"]>) {
    return workspaceMembersStorage.endWorkspaceMembership(this, ...args);
  }
  changeWorkspaceInviteLink(...args: Parameters<SyncRelayStorage["changeWorkspaceInviteLink"]>) {
    return workspaceMembersStorage.changeWorkspaceInviteLink(this, ...args);
  }
  inviteLinkAdmitsSignUp(...args: Parameters<SyncRelayStorage["inviteLinkAdmitsSignUp"]>) {
    return workspaceMembersStorage.inviteLinkAdmitsSignUp(this, ...args);
  }
  previewWorkspaceJoin(...args: Parameters<SyncRelayStorage["previewWorkspaceJoin"]>) {
    return workspaceMembersStorage.previewWorkspaceJoin(this, ...args);
  }
  joinWorkspace(...args: Parameters<SyncRelayStorage["joinWorkspace"]>) {
    return workspaceMembersStorage.joinWorkspace(this, ...args);
  }

  shareHasActiveGrants(shareId: string): boolean {
    return !!this.db
      .prepare(
        "SELECT 1 FROM sync_relay_share_grants WHERE share_id = ? AND status = 'active' LIMIT 1",
      )
      .get(shareId);
  }
  getShareLabels(
    shareId: string,
    reader: ShareLabelReader,
    readerFiles?: ShareSelector | null,
  ): ShareLabels {
    return shareLabelsStorage.getShareLabels(this, shareId, reader, readerFiles);
  }
  setShareLabels(shareId: string, labels: ShareLabels, updatedAtMs: number): void {
    shareLabelsStorage.setShareLabels(this, shareId, labels, updatedAtMs);
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

  listSharesGrantedBy(granterUserId: string): SyncRelayGrantedShareRow[] {
    return sharesStorage.listSharesGrantedBy(this, granterUserId);
  }

  listSharesGrantedPage(
    granterUserId: string,
    workspaceId: string,
    cursor?: SyncRelayGrantedInventoryCursor,
  ): SyncRelayGrantedInventoryPage {
    return sharesStorage.listSharesGrantedPage(this, granterUserId, workspaceId, cursor);
  }

  listLinkGrantsByWorkspace(
    workspaceId: string,
    cursor?: SyncRelayLinkInventoryCursor,
  ): SyncRelayLinkInventoryPage {
    return sharesStorage.listLinkGrantsByWorkspace(this, workspaceId, cursor);
  }

  lookupHistoryAccounts(
    workspaceId: string,
    grantIds: readonly string[],
    userIds: readonly string[],
  ): SyncRelayHistoryAccount[] {
    return sharesStorage.lookupHistoryAccounts(this, workspaceId, grantIds, userIds);
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
  listReceivedShareIdsPage(
    recipientUserId: string,
    cursor?: SyncRelayReceivedInventoryCursor,
  ): SyncRelayReceivedInventoryPage {
    return sharesStorage.listReceivedShareIdsPage(this, recipientUserId, cursor);
  }

  removeShareAccess(input: shareRemovalStorage.ShareRemovalInput) {
    const result = shareRemovalStorage.removeShareAccess(this, input);
    if (result.ok)
      notifyDesktopReadiness(this, { shareId: result.grant?.shareId ?? input.shareId });
    return result;
  }

  purgeExpiredShareRemovals(nowMs: number): void {
    shareRemovalStorage.purgeExpiredShareRemovals(this, nowMs);
  }

  undoShareRemoval(input: Parameters<typeof shareRemovalStorage.undoShareRemoval>[1]) {
    return shareRemovalStorage.undoShareRemoval(this, input);
  }

  listRemovedSharesForRecipient(userId: string, shareId?: string) {
    return shareRemovalStorage.listRemovedSharesForRecipient(this, userId, shareId);
  }

  listRemovedSharesInRecipientList(userId: string, shareId?: string) {
    return shareRemovalStorage.listRemovedSharesInRecipientList(this, userId, shareId);
  }

  leaveShare(input: Parameters<typeof shareRemovalStorage.leaveShare>[1]) {
    const result = shareRemovalStorage.leaveShare(this, input);
    if (result.ok && result.workspaceId !== null)
      notifyDesktopReadiness(this, { shareId: input.shareId });
    return result;
  }

  revokeShare(shareId: string, revokedAtMs: number): boolean {
    try {
      return sharesStorage.revokeShare(this, shareId, revokedAtMs);
    } finally {
      notifyDesktopReadiness(this, { shareId });
    }
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
    aboveRelaySeq?: number;
  }): SyncRelayLogRow[] {
    return objectIndexStorage.listVersionCreateLogRowsByBlob(this, input);
  }

  findThreadCreateChannelWireId(workspaceId: string, threadId: string): string | null | undefined {
    return objectIndexStorage.findThreadCreateChannelWireId(this, workspaceId, threadId);
  }

  findChannelCreateKind(
    workspaceId: string,
    channelWireId: string,
  ): "channel" | "dm" | "agent" | null | undefined {
    return objectIndexStorage.findChannelCreateKind(this, workspaceId, channelWireId);
  }

  listChannelCreates(
    workspaceId: string,
  ): ReturnType<typeof objectIndexStorage.listChannelCreates> {
    return objectIndexStorage.listChannelCreates(this, workspaceId);
  }

  findThreadCreateLane(workspaceId: string, threadId: string): "posts" | "chat" | undefined {
    return objectIndexStorage.findThreadCreateLane(this, workspaceId, threadId);
  }

  findThreadFirstMessageId(workspaceId: string, threadId: string): string | undefined {
    return objectIndexStorage.findThreadFirstMessageId(this, workspaceId, threadId);
  }
  ownerComputerMessage(workspaceId: string, threadId: string, messageId: string) {
    return objectIndexStorage.ownerComputerMessage(this, workspaceId, threadId, messageId);
  }

  findChannelChatThread(workspaceId: string, channelWireId: string): string | null {
    return objectIndexStorage.findChannelChatThread(this, workspaceId, channelWireId);
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

  objectLastKnownPath(workspaceId: string, objectId: string): string | undefined {
    return objectIndexStorage.objectLastKnownPath(this, workspaceId, objectId);
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

  getShareProposal(proposalId: string): (ShareProposalRow & { ops: ShareProposalOpRow[] }) | null {
    return proposalsStorage.getShareProposal(this, proposalId);
  }

  listShareProposalsForShare(
    shareId: string,
    proposedByUserId: string,
  ): Array<ShareProposalRow & { opCount: number }> {
    return proposalsStorage.listShareProposalsForShare(this, shareId, proposedByUserId);
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
  // A write no live host needs to hear about, such as current view persistence or a room's
  // taken edit, wakes no relay-write observer.
  quietTx<T>(run: () => T): T {
    return this.owner.write(run);
  }

  /**
   * A document limits the write to that document's journal and delivery
   * state, which no connection on another document is authorized by. Live
   * connections on other documents then skip their standing check.
   * `NO_LIVE_AUTHORITY` skips every live connection's check, unless the write
   * changed the schema or a table in `LIVE_AUTHORITY_TABLES`.
   */
  tx<T>(run: () => T, scope?: RelayWriteScope): T {
    const operation = run;
    run = () => this.withTransactionRules(operation);
    if (!hasRelayWriteObservers(this)) return this.owner.write(run);
    const revision = this.db
      .prepare(`SELECT total_changes() AS changes,(SELECT schema_version FROM pragma_schema_version) AS schema_version,
      ${LIVE_AUTHORITY_WRITE_COUNT} AS authority`);
    const before = revision.get()!;
    try {
      return this.owner.write(run);
    } finally {
      // A committed write must not fail because this read did, so a failed read counts as a change.
      try {
        const after = this.unavailable.aborted ? undefined : revision.get()!;
        if (!after) notifyRelayWrite(this);
        else if (
          after.changes !== before.changes ||
          after.schema_version !== before.schema_version
        ) {
          notifyRelayWrite(
            this,
            scope === NO_LIVE_AUTHORITY &&
              (after.authority !== before.authority ||
                after.schema_version !== before.schema_version)
              ? undefined
              : scope,
          );
        }
      } catch {
        notifyRelayWrite(this);
      }
    }
  }

  readTx<T>(run: () => T): T {
    this.captureStanding();
    this.db.exec("BEGIN");
    try {
      const result = this.withTransactionRules(run);
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
      if (
        value !== null &&
        (typeof value === "object" || typeof value === "function") &&
        typeof (value as { then?: unknown }).then === "function"
      )
        throw new TypeError("Live authority reads must be synchronous.");
      return value;
    };
    if (this.readingLiveAuthority) {
      this.captureStanding();
      return read();
    }
    return this.readTx(() => {
      this.readingLiveAuthority = true;
      try {
        return read();
      } finally {
        this.readingLiveAuthority = false;
      }
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

  logHasMoreThan(input: { workspaceId: string; sinceRelaySeq: number; count: number }): boolean {
    return logStorage.logHasMoreThan(this, input);
  }

  hasRefusedSettlement(input: Parameters<SyncRelayStorage["hasRefusedSettlement"]>[0]): boolean {
    return logStorage.hasRefusedSettlement(this, input);
  }

  readCurrentFileState(input: {
    workspaceId: string;
    versionId: string;
    selectorPaths: readonly string[];
    limit: number;
    /** Lists only files at a path this passes, paging past the rest. */
    visible?: (path: string) => boolean;
  }): CurrentFileStateSnapshot {
    return currentFilesStorage.readCurrentFileState(this, input);
  }

  currentFileBlobByteLength(input: {
    workspaceId: string;
    versionId: string;
    selectorPaths: readonly string[];
    sha256: string;
    epochLogFloor: number;
    visible?: (path: string) => boolean;
    pastHidden?: true;
  }): number | null {
    return currentFilesStorage.currentFileBlobByteLength(this, input);
  }

  listLinkRevisionLogRows(input: {
    workspaceId: string;
    versionId: string;
    selectorPaths: readonly string[];
    sha256: string;
    epochLogFloor: number;
  }): SyncRelayLogRow[] {
    return currentFilesStorage.listLinkRevisionLogRows(this, input);
  }

  captureReadRevisionMatches(): () => boolean {
    return captureSqliteReadRevisionMatches(this.db);
  }

  listCurrentFileLogRowsByBlob(input: {
    workspaceId: string;
    versionId: string;
    selectorPaths: readonly string[];
    sha256: string;
    afterPath?: string;
  }): Array<{ path: string; row: SyncRelayLogRow }> {
    return currentFilesStorage.listCurrentFileLogRowsByBlob(this, input);
  }

  isCurrentFileState(input: {
    workspaceId: string;
    versionId: string;
    path: string;
    relaySeq: number;
  }): boolean {
    return currentFilesStorage.isCurrentFileState(this, input);
  }

  memberReach(
    workspaceId: string,
    userId: string,
    role: "admin" | "member",
    level: import("@dohc/security-contract/share-selector").ShareAccess,
  ) {
    return this.readShareTx(() =>
      memberReach(this.db, workspaceId, userId, role, level, this.transactionRules(workspaceId)),
    );
  }

  // Each workspace's rules, read once per transaction until a write lands.
  private openRules: Map<string, { changes: number; rules: AccessRuleSet }> | null = null;
  private withTransactionRules<T>(run: () => T): T {
    this.openRules = new Map();
    try {
      return run();
    } finally {
      this.openRules = null;
    }
  }
  private transactionRules(workspaceId: string): AccessRuleSet | undefined {
    if (!this.openRules) return undefined;
    const changes = Number(this.db.prepare("SELECT total_changes() AS changes").get()!.changes);
    const held = this.openRules.get(workspaceId);
    if (held?.changes === changes) return held.rules;
    const rules = currentAccessRuleSet(this.db, workspaceId);
    this.openRules.set(workspaceId, { changes, rules });
    return rules;
  }

  readShareTx<T>(read: () => T): T {
    return this.db.isTransaction ? read() : this.readTx(read);
  }

  shareLogHead(workspaceId: string): number {
    return this.readShareTx(() =>
      Number(
        this.db
          .prepare(
            "SELECT COALESCE(MAX(relay_seq), 0) AS head FROM sync_relay_log WHERE workspace_id = ?",
          )
          .get(workspaceId)?.head ?? 0,
      ),
    );
  }

  refreshAccountEmail(userId: string, email: AccountEmail | null, nowMs: number): void {
    // Most refreshes find the same email; skip the write transaction for those.
    const stored = this.readShareTx(() => accountEmail(this.db, userId));
    const normalized = email && {
      verifiedEmail: email.verifiedEmail === null ? null : normalizeRuleEmail(email.verifiedEmail),
    };
    if (
      stored === null
        ? normalized === null
        : normalized !== null && stored.verifiedEmail === normalized.verifiedEmail
    )
      return;
    this.tx(() => refreshAccountEmail(this.db, userId, email, nowMs));
  }

  currentObjectFile(input: {
    workspaceId: string;
    versionId: string;
    objectId: string;
    epochLogFloor: number;
  }): CurrentFileStateRow | null | "reset" {
    return currentFilesStorage.currentObjectFile(this, input);
  }

  currentFileBlobSha256(input: {
    workspaceId: string;
    versionId: string;
    path: string;
  }): string | undefined {
    return currentFilesStorage.currentFileBlobSha256(this, input);
  }

  currentFileObjectId(input: {
    workspaceId: string;
    versionId: string;
    path: string;
  }): string | undefined {
    return currentFilesStorage.currentFileObjectId(this, input);
  }

  currentObjectPath(input: {
    workspaceId: string;
    versionId: string;
    objectId: string;
  }): string | null {
    return currentFilesStorage.currentObjectPath(this, input);
  }

  currentObjectBlobByteLength(input: {
    workspaceId: string;
    versionId: string;
    selectorPaths: readonly string[];
    objectId: string;
    sha256: string;
    epochLogFloor: number;
  }): number | null {
    return currentFilesStorage.currentObjectBlobByteLength(this, input);
  }

  laterObjectMomentPaths(input: {
    workspaceId: string;
    versionId: string;
    objectId: string;
    afterRelaySeq: number;
    limit: number;
  }): Array<string | null> {
    return currentFilesStorage.laterObjectMomentPaths(this, input);
  }

  fetchLogPageDescending(input: {
    workspaceId: string;
    beforeRelaySeq: number | null;
    limit: number;
  }): SyncRelayLogRow[] {
    return logStorage.fetchLogPageDescending(this, input);
  }

  fetchChannelMessages(
    input: Parameters<typeof logStorage.fetchChannelMessages>[1],
  ): ReturnType<typeof logStorage.fetchChannelMessages> {
    return logStorage.fetchChannelMessages(this, input);
  }

  fetchChatMessages(
    input: Parameters<typeof logStorage.fetchChatMessages>[1],
  ): ReturnType<typeof logStorage.fetchChatMessages> {
    return logStorage.fetchChatMessages(this, input);
  }

  fetchCommentMessages(
    input: Parameters<typeof logStorage.fetchCommentMessages>[1],
  ): ReturnType<typeof logStorage.fetchCommentMessages> {
    return logStorage.fetchCommentMessages(this, input);
  }

  fetchThreadMessages(
    input: Parameters<typeof logStorage.fetchThreadMessages>[1],
  ): ReturnType<typeof logStorage.fetchThreadMessages> {
    return logStorage.fetchThreadMessages(this, input);
  }

  fetchChatMessage(
    input: Parameters<typeof logStorage.fetchChatMessage>[1],
  ): SyncRelayLogRow | null {
    return logStorage.fetchChatMessage(this, input);
  }

  appendBrowserChatBatch(
    input: Parameters<typeof logStorage.appendBrowserChatBatch>[1],
  ): AppendLogBatchResult {
    return logStorage.appendBrowserChatBatch(this, input);
  }

  appendLinkChatPost(
    input: Parameters<typeof linkChatStorage.appendLinkChatPost>[1],
  ): linkChatStorage.AppendLinkChatPostResult {
    return linkChatStorage.appendLinkChatPost(this, input);
  }

  appendAgentChatPost(
    input: Parameters<typeof linkChatStorage.appendAgentChatPost>[1],
  ): linkChatStorage.AppendAgentChatPostResult {
    return linkChatStorage.appendAgentChatPost(this, input);
  }

  linkPrincipalThreadIds(workspaceId: string, principalId: string): Set<string> {
    return linkChatStorage.linkPrincipalThreadIds(this, workspaceId, principalId);
  }

  registerAgentClient(
    input: Parameters<typeof agentConnectionStorage.registerAgentClient>[1],
  ): boolean {
    return agentConnectionStorage.registerAgentClient(this, input);
  }

  getAgentClient(clientId: string): agentConnectionStorage.AgentClientRow | null {
    return agentConnectionStorage.getAgentClient(this, clientId);
  }

  beginAgentAuthorization(
    input: Parameters<typeof agentConnectionStorage.beginAgentAuthorization>[1],
  ): boolean {
    return agentConnectionStorage.beginAgentAuthorization(this, input);
  }

  readAgentAuthorization(
    requestHash: string,
    nowMs: number,
  ): agentConnectionStorage.AgentAuthorizationRow | null {
    return agentConnectionStorage.readAgentAuthorization(this, requestHash, nowMs);
  }

  decideAgentAuthorization(
    input: Parameters<typeof agentConnectionStorage.decideAgentAuthorization>[1],
  ): agentConnectionStorage.AgentAuthorizationDecision {
    return agentConnectionStorage.decideAgentAuthorization(this, input);
  }

  redeemAgentAuthorizationCode(
    input: Parameters<typeof agentConnectionStorage.redeemAgentAuthorizationCode>[1],
  ): agentConnectionStorage.AgentTokenGrantResult {
    return agentConnectionStorage.redeemAgentAuthorizationCode(this, input);
  }

  refreshAgentTokens(
    input: Parameters<typeof agentConnectionStorage.refreshAgentTokens>[1],
  ): agentConnectionStorage.AgentTokenGrantResult {
    return agentConnectionStorage.refreshAgentTokens(this, input);
  }

  authenticateAgentAccessToken(
    accessTokenHash: string,
    nowMs: number,
  ): agentConnectionStorage.AgentConnectionRow | null {
    return agentConnectionStorage.authenticateAgentAccessToken(this, accessTokenHash, nowMs);
  }

  // Opens no transaction, so a read inside another read's snapshot uses that snapshot.
  authenticateAgentAuthority(
    check: agentConnectionStorage.AgentAccessCheck,
    nowMs: number,
  ): agentConnectionStorage.AgentConnectionRow | null {
    return agentConnectionStorage.readAgentAuthority(this, check, nowMs);
  }

  recordAgentConnectionAction(connectionId: string, atMs: number): void {
    agentConnectionStorage.recordAgentConnectionAction(this, connectionId, atMs);
  }

  listAgentConnections(
    input: Parameters<typeof agentConnectionStorage.listAgentConnections>[1],
  ): agentConnectionStorage.AgentConnectionPage {
    return agentConnectionStorage.listAgentConnections(this, input);
  }

  disconnectAgentConnection(
    input: Parameters<typeof agentConnectionStorage.disconnectAgentConnection>[1],
  ): agentConnectionStorage.AgentConnectionRow | null {
    return agentConnectionStorage.disconnectAgentConnection(this, input);
  }

  beginPersonalAuthorization(
    input: Parameters<typeof personalAgentStorage.beginPersonalAuthorization>[1],
  ): boolean {
    return personalAgentStorage.beginPersonalAuthorization(this, input);
  }

  readPersonalAuthorization(
    requestHash: string,
    nowMs: number,
  ): personalAgentStorage.PersonalAuthorizationRow | null {
    return personalAgentStorage.readPersonalAuthorization(this, requestHash, nowMs);
  }

  cancelPersonalAuthorization(
    requestHash: string,
    nowMs: number,
  ): personalAgentStorage.PersonalAuthorizationRow | null {
    return personalAgentStorage.cancelPersonalAuthorization(this, requestHash, nowMs);
  }

  allowPersonalAuthorization(
    input: Parameters<typeof personalAgentStorage.allowPersonalAuthorization>[1],
  ): personalAgentStorage.PersonalAuthorizationRow | null {
    return personalAgentStorage.allowPersonalAuthorization(this, input);
  }

  personalCredentialOwner(
    credential: Parameters<typeof personalAgentStorage.personalCredentialOwner>[1],
  ): string | null {
    return personalAgentStorage.personalCredentialOwner(this, credential);
  }

  redeemPersonalAuthorizationCode(
    input: Parameters<typeof personalAgentStorage.redeemPersonalAuthorizationCode>[1],
  ): personalAgentStorage.PersonalTokenGrant {
    return personalAgentStorage.redeemPersonalAuthorizationCode(this, input);
  }

  refreshPersonalTokens(
    input: Parameters<typeof personalAgentStorage.refreshPersonalTokens>[1],
  ): personalAgentStorage.PersonalTokenGrant {
    return personalAgentStorage.refreshPersonalTokens(this, input);
  }

  // Opens no transaction, as the link agent check opens none.
  authenticatePersonalAuthority(
    check: agentConnectionStorage.AgentAccessCheck,
    fenceEpoch: number,
    nowMs: number,
  ): personalAgentStorage.PersonalConnectionRow | null {
    return personalAgentStorage.readPersonalAuthority(this, check, fenceEpoch, nowMs);
  }

  listPersonalAgents(ownerUserId: string): personalAgentStorage.PersonalRoster {
    return personalAgentStorage.listPersonalAgents(this, ownerUserId);
  }

  personalRosterRevision(ownerUserId: string): number {
    return personalAgentStorage.personalRosterRevision(this, ownerUserId);
  }

  changePersonalAgent(
    input: Parameters<typeof personalAgentStorage.changePersonalAgent>[1],
  ): personalAgentStorage.PersonalAgentChangeResult {
    return personalAgentStorage.changePersonalAgent(this, input);
  }

  revokePersonalCredentialsBelowFence(ownerUserId: string, epoch: number): string[] {
    return personalAgentStorage.revokePersonalCredentialsBelowFence(this, ownerUserId, epoch);
  }

  signOutAccountPersonalAgents(ownerUserId: string): string[] {
    return personalAgentStorage.signOutAccountPersonalAgents(this, ownerUserId);
  }

  readCredentialFencePosition(): number {
    return personalAgentStorage.readCredentialFencePosition(this);
  }

  advanceCredentialFencePosition(changedAtMs: number): void {
    personalAgentStorage.advanceCredentialFencePosition(this, changedAtMs);
  }

  setWorkspaceDisplayName(
    input: Parameters<typeof personalAgentStorage.setWorkspaceDisplayName>[1],
  ): boolean {
    return personalAgentStorage.setWorkspaceDisplayName(this, input);
  }

  readPersonalScope(
    credential: personalAgentChatStorage.PersonalCredential,
    nowMs: number,
  ): personalAgentChatStorage.PersonalScope | null {
    return personalAgentChatStorage.readPersonalScope(this, credential, nowMs);
  }

  readPersonalReach(
    credential: personalAgentChatStorage.PersonalCredential,
    workspaceId: string,
    nowMs: number,
  ): personalAgentChatStorage.PersonalReachRead {
    return personalAgentChatStorage.readPersonalReach(this, credential, workspaceId, nowMs);
  }

  readPersonalWorkspaces(
    credential: personalAgentChatStorage.PersonalCredential,
    nowMs: number,
  ): personalAgentChatStorage.PersonalWorkspaces | null {
    return personalAgentChatStorage.readPersonalWorkspaces(this, credential, nowMs);
  }

  appendPersonalChatPost(
    input: Parameters<typeof personalAgentChatStorage.appendPersonalChatPost>[1],
  ): personalAgentChatStorage.AppendPersonalChatPostResult {
    return personalAgentChatStorage.appendPersonalChatPost(this, input);
  }

  personalAgentPostedIn(
    input: Parameters<typeof personalAgentChatStorage.personalAgentPostedIn>[1],
  ): boolean {
    return personalAgentChatStorage.personalAgentPostedIn(this, input);
  }

  readPersonalWaitWindow(
    input: Parameters<typeof personalAgentChatStorage.readPersonalWaitWindow>[1],
  ): personalAgentChatStorage.PersonalWaitWindow {
    return personalAgentChatStorage.readPersonalWaitWindow(this, input);
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
        if (typeof now !== "number" || !Number.isSafeInteger(now) || now < 0)
          throw new Error("Invalid live-ticket clock.");
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

  liveLinkFull(scope: LiveTicketScope): boolean {
    return liveDocumentAuthorityStorage.liveLinkFull(this, scope);
  }

  redeemLiveTicket(input: LiveTicketRedemption): RedeemedLiveTicket | null {
    return liveDocumentAuthorityStorage.redeemLiveTicket(this, input);
  }

  provisionDeviceHostCredential(input: {
    credential: DeviceHostCredential;
    updatedAtMs: number;
  }): DeviceHostCredentialResult {
    return hostControlStorage.provisionDeviceHostCredential(this, input);
  }

  registerDeviceHost(input: {
    credential: DeviceHostCredential;
    connectionId: string;
    updatedAtMs: number;
  }): DeviceHostCredentialResult {
    return hostControlStorage.registerDeviceHost(this, input);
  }

  disconnectDeviceHost(input: {
    credential: DeviceHostCredential;
    connectionId: string;
    updatedAtMs: number;
  }): DeviceHostCredentialResult {
    return hostControlStorage.disconnectDeviceHost(this, input);
  }

  revokeDeviceHostCredential(input: {
    hostId: string;
    instanceId: string;
    updatedAtMs: number;
  }): DeviceHostCredentialResult {
    return hostControlStorage.revokeDeviceHostCredential(this, input);
  }

  listWorkspaceSecrets(workspaceId: string) {
    return workspaceSecretStorage.listWorkspaceSecrets(this, workspaceId);
  }

  readWorkspaceSecretForExecution(workspaceId: string, name: string) {
    return workspaceSecretStorage.readWorkspaceSecretForExecution(this, workspaceId, name);
  }

  upsertWorkspaceSecret(input: Parameters<typeof workspaceSecretStorage.upsertWorkspaceSecret>[1]) {
    return workspaceSecretStorage.upsertWorkspaceSecret(this, input);
  }

  deleteWorkspaceSecret(workspaceId: string, ownerUserId: string, name: string) {
    return workspaceSecretStorage.deleteWorkspaceSecret(this, workspaceId, ownerUserId, name);
  }

  listWorkspaceSecretSeals() {
    return workspaceSecretStorage.listWorkspaceSecretSeals(this);
  }

  replaceWorkspaceSecretSeal(
    seal: workspaceSecretStorage.WorkspaceSecretSeal,
    next: { readonly keyId: string; readonly sealedValue: string },
  ) {
    return workspaceSecretStorage.replaceWorkspaceSecretSeal(this, seal, next);
  }

  listWorkspaceHttpStepApprovals(workspaceId: string) {
    return outboundWebhookStorage.listWorkspaceHttpStepApprovals(this, workspaceId);
  }

  hasWorkspaceHttpStepApproval(workspaceId: string, approvalDigest: string) {
    return outboundWebhookStorage.hasWorkspaceHttpStepApproval(this, workspaceId, approvalDigest);
  }

  approveWorkspaceHttpStep(
    input: Parameters<typeof outboundWebhookStorage.approveWorkspaceHttpStep>[1],
  ) {
    return outboundWebhookStorage.approveWorkspaceHttpStep(this, input);
  }

  reserveWorkspaceHttpDispatch<Refusal = never>(input: {
    readonly workspaceId: string;
    readonly ownerUserId: string;
    readonly deliveryId: string;
    readonly nowMs: number;
    readonly beforeReserve?: () => Refusal | null;
  }): outboundWebhookStorage.ReserveWorkspaceHttpDispatchResult<Refusal> {
    return outboundWebhookStorage.reserveWorkspaceHttpDispatch(this, input);
  }

  listActiveWorkspaceShareGrants(workspaceId: string) {
    return outboundWebhookStorage.listActiveWorkspaceShareGrants(this, workspaceId);
  }

  finalizeWorkspaceHttpDispatch(
    input: Parameters<typeof outboundWebhookStorage.finalizeWorkspaceHttpDispatch>[1],
  ) {
    return outboundWebhookStorage.finalizeWorkspaceHttpDispatch(this, input);
  }

  readCommittedWorkspaceTextFile(
    workspaceId: string,
    versionId: string,
    path: string,
    maxBytes: number,
  ) {
    return outboundWebhookStorage.readCommittedWorkspaceTextFile(
      this,
      workspaceId,
      versionId,
      path,
      maxBytes,
    );
  }

  committedWorkspaceFileExists(workspaceId: string, versionId: string, path: string) {
    return outboundWebhookStorage.committedWorkspaceFileExists(this, workspaceId, versionId, path);
  }

  listIncomingWebhooks(workspaceId: string) {
    return incomingWebhookStorage.listIncomingWebhooks(this, workspaceId);
  }

  createIncomingWebhook(input: Parameters<typeof incomingWebhookStorage.createIncomingWebhook>[1]) {
    return incomingWebhookStorage.createIncomingWebhook(this, input);
  }

  updateIncomingWebhook(input: Parameters<typeof incomingWebhookStorage.updateIncomingWebhook>[1]) {
    return incomingWebhookStorage.updateIncomingWebhook(this, input);
  }

  rotateIncomingWebhookToken(
    input: Parameters<typeof incomingWebhookStorage.rotateIncomingWebhookToken>[1],
  ) {
    return incomingWebhookStorage.rotateIncomingWebhookToken(this, input);
  }

  deleteIncomingWebhook(workspaceId: string, ownerUserId: string, webhookId: string) {
    return incomingWebhookStorage.deleteIncomingWebhook(this, workspaceId, ownerUserId, webhookId);
  }

  lookupActiveIncomingWebhookByToken(linkKey: string | Uint8Array, token: string) {
    return incomingWebhookStorage.lookupActiveIncomingWebhookByToken(this, linkKey, token);
  }

  precheckIncomingWebhookBudgets(
    webhookId: string,
    workspaceId: string,
    nowMs: number,
    deliveryKey?: string | null,
  ) {
    return incomingWebhookStorage.precheckIncomingWebhookBudgets(
      this,
      webhookId,
      workspaceId,
      nowMs,
      deliveryKey,
    );
  }

  enqueueIncomingWebhookDelivery(
    input: Parameters<typeof incomingWebhookStorage.enqueueIncomingWebhookDelivery>[1],
  ) {
    return incomingWebhookStorage.enqueueIncomingWebhookDelivery(this, input);
  }

  recoverAcceptedIncomingWebhookDeliveries(
    input: Parameters<typeof incomingWebhookStorage.recoverAcceptedIncomingWebhookDeliveries>[1],
  ) {
    return incomingWebhookStorage.recoverAcceptedIncomingWebhookDeliveries(this, input);
  }

  claimNextIncomingWebhookDelivery(
    input: Parameters<typeof incomingWebhookStorage.claimNextIncomingWebhookDelivery>[1],
  ) {
    return incomingWebhookStorage.claimNextIncomingWebhookDelivery(this, input);
  }

  verifyIncomingWebhookPublicationAuthority(
    input: Parameters<typeof incomingWebhookStorage.verifyIncomingWebhookPublicationAuthority>[1],
  ) {
    return incomingWebhookStorage.verifyIncomingWebhookPublicationAuthority(this, input);
  }

  settleIncomingWebhookDelivery(
    input: Parameters<typeof incomingWebhookStorage.settleIncomingWebhookDelivery>[1],
  ) {
    return incomingWebhookStorage.settleIncomingWebhookDelivery(this, input);
  }

  releaseAcceptedIncomingWebhookDelivery(
    input: Parameters<typeof incomingWebhookStorage.releaseAcceptedIncomingWebhookDelivery>[1],
  ) {
    return incomingWebhookStorage.releaseAcceptedIncomingWebhookDelivery(this, input);
  }

  recordFailedIncomingWebhookAttempt(
    input: Parameters<typeof incomingWebhookStorage.recordFailedIncomingWebhookAttempt>[1],
  ) {
    return incomingWebhookStorage.recordFailedIncomingWebhookAttempt(this, input);
  }

  hasPendingIncomingWebhookDeliveries(
    workspaceId: string,
    nowMs?: number,
    ownerUserId?: string,
    leaseId?: string,
  ) {
    return incomingWebhookStorage.hasPendingIncomingWebhookDeliveries(
      this,
      workspaceId,
      nowMs,
      ownerUserId,
      leaseId,
    );
  }

  nextIncomingWebhookRetryAtMs(workspaceId: string, ownerUserId?: string) {
    return incomingWebhookStorage.nextIncomingWebhookRetryAtMs(this, workspaceId, ownerUserId);
  }

  workspacesWithIncomingWebhooks() {
    return incomingWebhookStorage.workspacesWithIncomingWebhooks(this);
  }

  pruneExpiredIncomingWebhookDeliveries(nowMs: number, workspaceId?: string) {
    return incomingWebhookStorage.pruneExpiredIncomingWebhookDeliveries(this, nowMs, workspaceId);
  }
}
import {
  hasRelayWriteObservers,
  NO_LIVE_AUTHORITY,
  notifyRelayWrite,
  type RelayWriteScope,
} from "./relayWriteChanges";
import {
  LIVE_AUTHORITY_WRITE_COUNT,
  watchLiveAuthorityWrites,
} from "./storage/liveAuthorityWrites";
import { notifyDesktopReadiness } from "./desktopReadinessChanges";
