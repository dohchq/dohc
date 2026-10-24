import {accountIsFenced} from "./storage/accountDeletion";
import {parseRoute} from "./relayRoute";
import {parsePublicEditRelease, type PublicEditRelease} from "@dohc/security-contract";
import {normalizeLinkRefusal} from "./linkRefusal";
import type { AppPublicationLimits } from "@dohc/security-contract/app-publication";
import type { AppBackendAdmissionLimits } from "./appBackendAdmission";
import { createDatasetAppRoutes, createDatasetRoutes } from "./datasetRoutes";
import { createDatasetReplicaRoutes } from "./datasetReplicaRoutes";
import { createDatasetRecoveryExport } from "./datasetRecoveryExport";
import type { RelayDatasetHost } from "./datasetHost";
import { hashLinkProfileSecret } from "./linkSecurity";
import { LINK_SECRET_PATTERN } from "@dohc/security-contract/wire-patterns";
import { createOwnerAppPublicationRoutes } from "./ownerAppPublicationRoutes";
import {readOwnerAppResponses} from "./ownerAppResponseRoutes";
import { createLinkAppPublicationRoutes } from "./linkAppPublicationRoutes";
import { createLinkAppCollectionRoutes, type AppCollectionPolicy } from "./appCollectionRoutes";
import {createNamedRecipientChat} from "./namedRecipientChat";
import {createNamedRecipientDocuments} from "./namedRecipientDocuments";
import { TokenBucketLimiter } from "@dohc/service-http";
import {
  createCollectionWriteRateLimiter,
  createCollectionWriteRoutes,
  createLinkCollectionWriteAdmission,
  createLinkCollectionWriteRoute,
  type LinkCollectionWriteAdmission,
  readOwnerCollectionWrites,
} from "./collectionWriteRoutes";
import { createOwnerRestoreRoutes, type OwnerRestoreHost } from "./ownerRestoreRoutes";
import { randomUUID } from "node:crypto";
import { createNamedLiveBrowserHttp, type NamedLiveBrowserHttpLimits } from "./namedLiveBrowserHttp";
import type { ResolveActor } from "@dohc/workspace-auth/session";
import { createNamedShareTransportRoutes } from "./namedShareTransportRoutes";
import { createKeyEnvelopeRoutes } from "./keyEnvelopeRoutes";
import {
  createNoticeRoutes,
  NOTICE_POST_BUCKET_CAPACITY,
  NOTICE_POST_MAX_SENDERS,
  NOTICE_POST_REFILL_PER_SECOND,
} from "./noticeRoutes";
import {
  createAutomationPressRateLimiters,
  createAutomationPressRoutes,
} from "./automationPressRoutes";
import {
  AUTOMATION_HOST_BUCKET_CAPACITY,
  AUTOMATION_HOST_MAX_OWNERS,
  AUTOMATION_HOST_REFILL_PER_SECOND,
  createAutomationHostRoutes,
} from "./automationHostRoutes";
import {
  createAutomationServerRoutes,
  type ServerRuns,
} from "./automationServerRoutes";
import { createWorkspaceBlobRoutes } from "./workspaceBlobRoutes";
import { createWorkspaceReplicationRoutes } from "./workspaceReplicationRoutes";
import { createLinkResponseStreams } from "./linkResponseStreams";
import { createLinkCredentialRoutes } from "./linkCredentialRoutes";
import { accountDisplayName } from "./accountDisplayName";
import { createDiscussionRoutes } from "./discussionRoutes";
import {shareSenderLabel as formatShareSender} from "@dohc/security-contract/share-labels";
import { createShareReadQueries } from "./shareReadQueries";
import { createLinkChatRoutes } from "./linkChatRoutes";
import { createLinkReadRoutes } from "./linkReadRoutes";
import { createShareSummaries } from "./shareSummaries";
import { createShareGrantRoutes } from "./shareGrantRoutes";
import { createShareInventoryRoutes } from "./shareInventoryRoutes";
import {
  hashRelayExchangeKey,
  LinkEgressRateLimiter,
  LINK_EXCHANGE_BUCKET_CAPACITY,
  LINK_EXCHANGE_REFILL_PER_SECOND,
  LINK_EXCHANGE_MAX_IPS,
  LINK_EXCHANGE_GLOBAL_BUCKET_CAPACITY,
  LINK_EXCHANGE_GLOBAL_REFILL_PER_SECOND,
  LINK_READ_BUCKET_CAPACITY,
  LINK_READ_REFILL_PER_SECOND,
  LINK_READ_MAX_CAPABILITIES,
  LINK_GRANT_LOG_READ_BUCKET_CAPACITY,
  LINK_GRANT_LOG_READ_REFILL_PER_SECOND,
  LINK_GRANT_READ_BUCKET_CAPACITY,
  LINK_GRANT_READ_REFILL_PER_SECOND,
  LINK_LOG_READ_BUCKET_CAPACITY,
  LINK_LOG_READ_REFILL_PER_SECOND,
  mintLinkBearer,
  mintLinkHandoffCode,
  validateLinkCapability,
  verifyRelayExchangeKey,
} from "./linkSecurity";
import { DiscussionActivityHub } from "./discussionActivity";
import { PresenceHub } from "./presence";
import { ReplicaWatches } from "./replicaWatches";
import type {DevelopmentReplicaReads} from "./replicaLinkReadService";
import { createPresenceRoutes } from "./presenceRoutes";
import { createProposalRoutes } from "./proposalRoutes";
import { parseShareId, parseWorkspaceId } from "./requestInputs";
import type { ShareSelector } from "./shareFilter";
import { type SyncRelayStorage } from "./storage";
import type { AutomationServer } from "./storage/automationHosts";
import {
  authorizeShareAction,
  type AuthorizedShareAction,
  type ShareAction,
} from "./shareAuthorization";
import { errorResponse, invalidLinkCapability, notFound, relayError } from "./errors";
import { MAX_LOG_PAGE_SIZE } from "./wireLimits";

export { MAX_BLOB_BYTES, MAX_PAYLOAD_JSON_BYTES } from "./wireLimits";
export { MAX_KEY_ENVELOPE_BYTES } from "./keyEnvelopeRoutes";
export { ACCOUNT_NAME_LOOKUP_DEADLINE_MS } from "./accountDisplayName";
export { LINK_FRESHNESS_PAGE_BUDGET, MAX_RAW_ROWS_PER_LINK_PAGE } from "./shareReadQueries";

export type SyncRelayHandler = (request: Request) => Promise<Response>;

export interface CreateSyncRelayHandlerOptions {
  appPublicationLimits?: AppPublicationLimits;
  appCollectionPolicy?: AppCollectionPolicy;
  appBackendAdmissionLimits?: Partial<AppBackendAdmissionLimits>;
  datasetHost?: RelayDatasetHost;
  ownerRestoreHost?: () => OwnerRestoreHost | undefined;
  storage: SyncRelayStorage;
  resolveActor: ResolveActor;
  nowMs?: () => number;
  // Maps a verified email to its account id. An unknown or unverified address returns null.
  // Absent means email-addressed grants are unavailable; grants by user id still work.
  resolveUserIdByEmail?: (email: string) => Promise<string | null> | string | null;
  // Returns an address only when the account has verified it server-side.
  lookupVerifiedUserEmail?: (userId: string) => Promise<string | null> | string | null;
  // Display-only reverse lookup for share listings; never used for authz.
  lookupUserEmail?: (userId: string) => Promise<string | null> | string | null;
  lookupUserEmails?: (userIds: readonly string[]) => Promise<ReadonlyMap<string, string>>;
  // Better Auth display name for discussion authorship; never used for authz.
  lookupUserDisplayName?: (
    userId: string,
  ) => Promise<string | null> | string | null;
  newShareId?: () => string;
  newGrantId?: () => string;
  // Ids the relay mints — proposal ids, and the moment and object
  // ids a proposal's accept stamps on the granter's own log. Minted, never
  // taken from the recipient: a recipient-supplied moment id could name a
  // moment the granter already holds. Injectable so tests can pin them.
  newId?: () => string;
  // The EPHEMERAL awareness transport (presence/typing). Injectable so a
  // self-hoster's single relay process shares one hub across requests, and so
  // tests can assert it holds only in-memory state (never a storage row).
  // Absent => a fresh in-memory hub, which is correct for production too.
  presence?: PresenceHub;
  // Wake-only long-poll coordination. Durable revisions and data stay in
  // storage, so replacing this hub cannot invalidate a client watermark.
  discussionActivity?: DiscussionActivityHub;
  replicaWatches?: Pick<ReplicaWatches, "watched"> & Partial<Pick<ReplicaWatches,"holdReader">>;
  developmentReplicaReads?: DevelopmentReplicaReads;
  // Relay-instance HMAC key. When absent, every link route refuses without
  // touching storage. main.ts requires it outside development and test.
  linkKey?: string | Uint8Array;
  shareWebOrigin?: string;
  relayExchangeKey?: string;
  namedBrowserSessionLimits?: NamedLiveBrowserHttpLimits;
  publicEditRelease?: PublicEditRelease;
  // Rate limit for direct writes to a Collection's own files under Edit.
  collectionWriteRateLimiter?: TokenBucketLimiter;
  // Link direct-write bodies the relay holds in memory at once.
  linkCollectionWriteAdmission?: LinkCollectionWriteAdmission;
  linkExchangeRateLimiter?: TokenBucketLimiter;
  linkExchangeGlobalRateLimiter?: TokenBucketLimiter;
  linkExchangeGrantRateLimiter?: TokenBucketLimiter;
  linkRedeemRateLimiter?: TokenBucketLimiter;
  linkReadRateLimiter?: TokenBucketLimiter;
  linkGrantReadRateLimiter?: TokenBucketLimiter;
  linkLogReadRateLimiter?: TokenBucketLimiter;
  linkGrantLogReadRateLimiter?: TokenBucketLimiter;
  linkGrantEgressRateLimiter?: LinkEgressRateLimiter;
  // Posts of notices to other people, keyed by sender.
  noticePostRateLimiter?: TokenBucketLimiter;
  // Changes to a workspace's automation host, and to the server's runs, keyed by owner.
  automationHostRateLimiter?: TokenBucketLimiter;
  // This server while it runs workspaces' automations; absent when it does not.
  automationServer?: AutomationServer;
  pressDataset?: Parameters<typeof createDatasetRoutes>[2]["pressDataset"];
  // This server's runs, for their owners; undefined while it runs no automations.
  serverRuns?: () => ServerRuns | undefined;
  // Button presses from shared views, per grant, and the host's answers, per owner.
  automationPressRateLimiters?: ReturnType<typeof createAutomationPressRateLimiters>;
  linkFreshnessPageSize?: number;
  linkCurrentFileLimit?: number;
  newLinkBearer?: () => string;
  newLinkHandoffCode?: () => string;
}

const MAX_LINK_CURRENT_FILES = 5_000;

export function createSyncRelayHandler({
  appPublicationLimits,
  appCollectionPolicy,
  appBackendAdmissionLimits,
  datasetHost,
  ownerRestoreHost = () => undefined,
  storage,
  resolveActor,
  nowMs = () => Date.now(),
  resolveUserIdByEmail,
  lookupVerifiedUserEmail,
  lookupUserEmail,
  lookupUserEmails,
  lookupUserDisplayName,
  newShareId = () => randomUUID(),
  newGrantId = () => randomUUID(),
  newId = () => randomUUID(),
  presence = new PresenceHub(),
  discussionActivity = new DiscussionActivityHub(),
  replicaWatches = new ReplicaWatches(discussionActivity),
  developmentReplicaReads,
  linkKey,
  shareWebOrigin,
  relayExchangeKey,
  namedBrowserSessionLimits,
  publicEditRelease: releaseInput,
  collectionWriteRateLimiter = createCollectionWriteRateLimiter(),
  linkCollectionWriteAdmission = createLinkCollectionWriteAdmission(),
  linkExchangeRateLimiter = new TokenBucketLimiter(LINK_EXCHANGE_BUCKET_CAPACITY, LINK_EXCHANGE_REFILL_PER_SECOND, LINK_EXCHANGE_MAX_IPS),
  linkExchangeGlobalRateLimiter = new TokenBucketLimiter(LINK_EXCHANGE_GLOBAL_BUCKET_CAPACITY, LINK_EXCHANGE_GLOBAL_REFILL_PER_SECOND, 1),
  linkExchangeGrantRateLimiter = new TokenBucketLimiter(LINK_GRANT_READ_BUCKET_CAPACITY, LINK_GRANT_READ_REFILL_PER_SECOND, LINK_READ_MAX_CAPABILITIES),
  linkRedeemRateLimiter = new TokenBucketLimiter(LINK_READ_BUCKET_CAPACITY, LINK_READ_REFILL_PER_SECOND, LINK_READ_MAX_CAPABILITIES),
  linkReadRateLimiter = new TokenBucketLimiter(LINK_READ_BUCKET_CAPACITY, LINK_READ_REFILL_PER_SECOND, LINK_READ_MAX_CAPABILITIES),
  linkGrantReadRateLimiter = new TokenBucketLimiter(
    LINK_GRANT_READ_BUCKET_CAPACITY,
    LINK_GRANT_READ_REFILL_PER_SECOND,
    LINK_READ_MAX_CAPABILITIES,
  ),
  linkLogReadRateLimiter = new TokenBucketLimiter(
    LINK_LOG_READ_BUCKET_CAPACITY,
    LINK_LOG_READ_REFILL_PER_SECOND,
    LINK_READ_MAX_CAPABILITIES,
  ),
  linkGrantLogReadRateLimiter = new TokenBucketLimiter(
    LINK_GRANT_LOG_READ_BUCKET_CAPACITY,
    LINK_GRANT_LOG_READ_REFILL_PER_SECOND,
    LINK_READ_MAX_CAPABILITIES,
  ),
  linkGrantEgressRateLimiter = new LinkEgressRateLimiter(),
  noticePostRateLimiter = new TokenBucketLimiter(
    NOTICE_POST_BUCKET_CAPACITY,
    NOTICE_POST_REFILL_PER_SECOND,
    NOTICE_POST_MAX_SENDERS,
  ),
  automationPressRateLimiters = createAutomationPressRateLimiters(),
  automationHostRateLimiter = new TokenBucketLimiter(
    AUTOMATION_HOST_BUCKET_CAPACITY,
    AUTOMATION_HOST_REFILL_PER_SECOND,
    AUTOMATION_HOST_MAX_OWNERS,
  ),
  linkFreshnessPageSize = MAX_LOG_PAGE_SIZE,
  linkCurrentFileLimit = MAX_LINK_CURRENT_FILES,
  newLinkBearer = () => mintLinkBearer(),
  newLinkHandoffCode = () => mintLinkHandoffCode(),
  automationServer,
  pressDataset,
  serverRuns = () => undefined,
}: CreateSyncRelayHandlerOptions): SyncRelayHandler & {
  resolveNamedBrowserSession: ReturnType<typeof createNamedLiveBrowserHttp>["resolve"];
  dispose(): void;
  deleteAccount(userId: string, workspaceIds: readonly string[], shareIds: readonly string[]): void;
  readOwnerShares(ownerUserId: string, path: string): Promise<{ status: number; body: unknown }>;
} {
  const accountActor = resolveActor;
  const requireUnfencedActor = (actor: Awaited<ReturnType<ResolveActor>>) => {
    if (accountIsFenced(storage, actor.userId)) throw notFound();
    return actor;
  };
  resolveActor = (request, workspaceId) => {
    const actor = accountActor(request, workspaceId);
    return typeof (actor as {then?: unknown}).then === "function"
      ? Promise.resolve(actor).then(requireUnfencedActor) : requireUnfencedActor(actor as Awaited<ReturnType<ResolveActor>>);
  };
  const publicEditRelease = parsePublicEditRelease(releaseInput);
  const respondToDataset = datasetHost ? createDatasetRoutes(datasetHost, storage, {limits: appBackendAdmissionLimits, nowMs, pressDataset}) : undefined;
  const respondToDatasetReplica = datasetHost ? createDatasetReplicaRoutes(datasetHost, storage, {limits: appBackendAdmissionLimits, nowMs}) : undefined;
  const respondToDatasetExport = datasetHost ? createDatasetRecoveryExport(datasetHost, storage, {limits: appBackendAdmissionLimits, nowMs}) : undefined;
  const respondToDatasetApp = datasetHost ? createDatasetAppRoutes(datasetHost, storage, {limits: appBackendAdmissionLimits, nowMs, shareSenderLabel}) : undefined;
  if (publicEditRelease && (!linkKey || !shareWebOrigin || !relayExchangeKey || !namedBrowserSessionLimits)) {
    throw new TypeError("Public Edit release requires link credentials, viewer origin, relay exchange, and named browser sessions.");
  }
  if (namedBrowserSessionLimits && (!shareWebOrigin || !relayExchangeKey)) {
    throw new TypeError("Named browser sessions require configured viewer origin and relay exchange.");
  }
  const resolveNamedActor: ResolveActor = async (request, workspaceId) => {
    request.signal.throwIfAborted();
    const actor = await resolveActor(request, workspaceId);
    request.signal.throwIfAborted();
    if (actor.workspaceId !== workspaceId) return actor;
    await claimPendingShares(actor.userId, request.signal);
    request.signal.throwIfAborted();
    return actor;
  };
  const namedBrowser = namedBrowserSessionLimits ? createNamedLiveBrowserHttp({
    storage, publicOrigin: shareWebOrigin!, exchangeKey: relayExchangeKey!, limits: namedBrowserSessionLimits, now: nowMs,
    resolveActor: resolveNamedActor,
  }) : undefined;
  const namedDocuments = namedBrowserSessionLimits ? createNamedRecipientDocuments({
    storage, publicOrigin: shareWebOrigin!, exchangeKey: relayExchangeKey!, limits: namedBrowserSessionLimits,
    resolveActor: resolveNamedActor, maxFiles: linkCurrentFileLimit, shareSenderLabel,
  }) : undefined;
  const relayExchangeKeyHash =
    relayExchangeKey === undefined ? undefined : hashRelayExchangeKey(relayExchangeKey);

  const hasValidRelayExchangeKey = (request: Request): boolean => {
    // An unconfigured key permits the request — that only occurs in
    // development and test; production and self-host require the key.
    if (relayExchangeKeyHash === undefined) return true;
    const presented = request.headers.get("x-dohc-relay-exchange-key");
    return verifyRelayExchangeKey(presented, relayExchangeKeyHash);
  };

  const {
    admitLinkBlobBytes,
    respondWithLinkBytes,
    terminateLinkStreamsForGrant,
    terminateLinkStreamsForShare,
  } = createLinkResponseStreams(nowMs);

  const {
    chatResolverFor,
    filteredLogPage,
    newestFilteredOpFreshness,
    historicalSharedBlob,
    linkRevisionByteLength,
  } = createShareReadQueries(storage, linkFreshnessPageSize, linkKey);

  async function shareSenderLabel(granterUserId: string, knownEmail?: string | null): Promise<string> {
    const name = await accountDisplayName(lookupUserDisplayName, granterUserId);
    const email = knownEmail === undefined ? await lookupUserEmail?.(granterUserId) : knownEmail;
    return formatShareSender(name, email);
  }

  // Delivers the share notices this person can receive now, before their
  // pull; only those look up a granter's name, once per granter. A failure
  // leaves a delivery waiting for the next pull. The share routes do no
  // delivery work, so sharing takes the same time whether or not the
  // address has an account.
  const deliverPendingShareNotices = async (userId: string): Promise<void> => {
    const labels = new Map<string, Promise<{senderLabel: string; senderEmail: string | null}>>();
    for (const { grantId, granterUserId } of storage.pendingShareNotices(userId)) {
      try {
        let label = labels.get(granterUserId);
        if (label === undefined) {
          label = (async () => {
            const senderEmail = await lookupUserEmail?.(granterUserId) ?? null;
            return {senderLabel: await shareSenderLabel(granterUserId, senderEmail), senderEmail};
          })();
          labels.set(granterUserId, label);
        }
        storage.noticeShareReceived({ grantId, ...await label, nowMs: nowMs() });
      } catch (error) {
        console.error("[sync-relay] share notice failed", error);
      }
    }
  };

  // Claim email invites only after the authenticated account verifies its address.
  const claimPendingShares = async (userId: string, signal?: AbortSignal): Promise<void> => {
    signal?.throwIfAborted();
    if (!lookupVerifiedUserEmail) return;
    const email = await lookupVerifiedUserEmail(userId);
    signal?.throwIfAborted();
    if (email) storage.claimPendingSharesForEmail(email, userId);
  };

  function requireShareAction(
    shareId: string,
    actorUserId: string,
    action: "propose",
  ): AuthorizedShareAction<ShareSelector>;
  function requireShareAction(
    shareId: string,
    actorUserId: string,
    action: ShareAction,
  ): AuthorizedShareAction;
  function requireShareAction(
    shareId: string,
    actorUserId: string,
    action: ShareAction,
  ): AuthorizedShareAction {
    const result = authorizeShareAction({ storage, actorUserId, shareId, action });
    if (result.ok) return result;
    if (storage.listRemovedSharesForRecipient(actorUserId, shareId).length > 0) throw relayError("share_access_removed");
    if (result.reason === "denied" && (action === "append" || action === "propose")) {
      throw relayError("share_read_only");
    }
    throw notFound();
  }

  const { respondToSharePresence, respondToWorkspacePresence, deleteAccount: deletePresenceAccount } = createPresenceRoutes(
    presence,
    nowMs,
    storage,
    claimPendingShares,
    requireShareAction,
    chatResolverFor,
    lookupUserDisplayName,
  );

  function requireShareWorkspace(
    share: { workspaceId: string },
    workspaceId: string,
  ): void {
    if (share.workspaceId !== workspaceId) throw notFound();
  }

  function shareActionGuard(
    shareId: string,
    actorUserId: string,
    action: "append" | "propose",
    workspaceId: string,
  ): () => void {
    return () => {
      const fresh = requireShareAction(shareId, actorUserId, action);
      if (fresh.share.workspaceId !== workspaceId) throw notFound();
    };
  }

  const { respondToWorkspaceRegistration, respondToWorkspaceReplication } = createWorkspaceReplicationRoutes(
    storage,
    nowMs,
    discussionActivity,
    replicaWatches,
    lookupUserDisplayName,
  );

  const respondToWorkspaceBlobs = createWorkspaceBlobRoutes(
    storage,
    nowMs,
  );

  const respondToKeyEnvelopes = createKeyEnvelopeRoutes(
    storage,
    nowMs,
  );

  const respondToNotices = createNoticeRoutes(
    storage,
    nowMs,
    lookupUserDisplayName,
    claimPendingShares,
    deliverPendingShareNotices,
    noticePostRateLimiter,
  );
  const respondToAutomationHost = createAutomationHostRoutes(
    storage, nowMs, automationHostRateLimiter, automationServer ?? null,
  );
  const respondToAutomationServer = createAutomationServerRoutes(storage, serverRuns, nowMs, automationHostRateLimiter);
  const automationPresses = createAutomationPressRoutes({
    storage, nowMs, newId, claimPendingShares, activity: discussionActivity, rateLimiters: automationPressRateLimiters,
  });

  const respondToNamedShareTransport = createNamedShareTransportRoutes(
    storage,
    nowMs,
    claimPendingShares,
    requireShareAction,
    shareActionGuard,
    filteredLogPage,
    historicalSharedBlob,
    discussionActivity,
    lookupUserDisplayName,
  );

  const namedChat = namedBrowserSessionLimits ? createNamedRecipientChat({
    storage, publicOrigin: shareWebOrigin!, exchangeKey: relayExchangeKey!, limits: namedBrowserSessionLimits,
    resolveActor, lookupUserDisplayName, claimPendingShares, activity: discussionActivity, nowMs, requireShareAction, transport: respondToNamedShareTransport, reads: {chatResolverFor},
  }) : undefined;

  const { respondToShareProposals, respondToWorkspaceProposals } = createProposalRoutes(
    storage,
    nowMs,
    newId,
    lookupUserEmail,
    claimPendingShares,
    requireShareAction,
    shareActionGuard,
    discussionActivity,
  );

  const respondToCollectionWrites = createCollectionWriteRoutes({
    storage,
    lookupUserDisplayName,
    rateLimiter: collectionWriteRateLimiter,
    nowMs,
    newId,
    claimPendingShares,
    discussionActivity,
  });

  const {
    grantedShareSummary,
    receivedShareSummary,
    linkGrantBody,
    namedGrantTransitionBody,
    dependentGrantSummary,
    independentGrantSummary,
    linkInventorySummary,
    namedBrowserInvitation,
  } = createShareSummaries(storage, (shareId) => storage.getShareLabels(shareId), lookupUserEmail, namedBrowser ? shareWebOrigin : undefined);

  const shareInventoryRoutes = (claim: (userId: string) => Promise<void>) => createShareInventoryRoutes(
    storage,
    nowMs,
    claim,
    lookupUserEmail,
    requireShareAction,
    grantedShareSummary,
    receivedShareSummary,
    independentGrantSummary,
    linkInventorySummary,
    namedBrowserInvitation,
    publicEditRelease,
    shareSenderLabel,
    undefined,
    lookupUserEmails,
    linkKey,
  );
  const { respondToShareInventory, respondToWorkspaceLinkInventory } = shareInventoryRoutes(claimPendingShares);
  // The server reads the owner's shares without the owner there, so it
  // binds none of the owner's pending invites; the roster reads only the
  // shares the owner granted.
  const ownerShareReads = shareInventoryRoutes(async () => undefined);

  const { respondToShareGrantTransition, respondToWorkspaceShareCreation } = createShareGrantRoutes(
    storage,
    nowMs,
    newShareId,
    newGrantId,
    newId,
    newLinkBearer,
    resolveUserIdByEmail,
    lookupUserEmail,
    linkKey,
    shareWebOrigin,
    requireShareWorkspace,
    terminateLinkStreamsForGrant,
    terminateLinkStreamsForShare,
    discussionActivity,
    linkGrantBody,
    namedGrantTransitionBody,
    dependentGrantSummary,
    namedBrowserInvitation,
    publicEditRelease,
  );

  const requireLinkCapability = (request: Request) => {
    if (!linkKey) throw invalidLinkCapability();
    const match = /^LinkCapability ([A-Za-z0-9_-]{43})$/u.exec(
      request.headers.get("authorization") ?? "",
    );
    if (!match) throw invalidLinkCapability();
    const capabilityToken = match[1]!;
    const capability = validateLinkCapability({
      storage,
      publicEditRelease,
      capabilityToken,
      linkKey,
      nowMs: nowMs(),
    });
    if (!capability) throw invalidLinkCapability();
    return {capabilityToken, capability};
  };
  const respondToLinkCollectionWrites = linkKey ? createLinkCollectionWriteRoute({
    storage,
    rateLimiter: collectionWriteRateLimiter,
    admission: linkCollectionWriteAdmission,
    linkKey,
    requireLinkCapability,
    nowMs,
    newId,
    discussionActivity,
  }) : null;
  const requireLinkRead = (
    request: Request,
    capabilityRateLimiter: TokenBucketLimiter,
    grantRateLimiter: TokenBucketLimiter,
  ) => {
    const {capabilityToken, capability} = requireLinkCapability(request);
    const admittedAtMs = nowMs();
    const admitted =
      capabilityRateLimiter.allow(
        capability.session.capabilityHash,
        admittedAtMs,
      ) && grantRateLimiter.allow(capability.grantId, admittedAtMs);
    if (!admitted) throw relayError("link_read_rate_limited");
    return { capabilityToken, capability };
  };

  const requireFreshLinkRead = (
    capabilityToken: string,
    expected: { shareId: string; grantId: string; generation: number },
  ) => {
    if (!linkKey) throw invalidLinkCapability();
    const fresh = validateLinkCapability({
      storage,
      publicEditRelease,
      capabilityToken,
      linkKey,
      nowMs: nowMs(),
    });
    if (
      !fresh ||
      fresh.shareId !== expected.shareId ||
      fresh.grantId !== expected.grantId ||
      fresh.generation !== expected.generation
    ) {
      throw invalidLinkCapability();
    }
    return fresh;
  };

  const linkJsonResponse = (
    shareId: string,
    grantId: string,
    body: unknown,
  ): Response => {
    const bytes = new TextEncoder().encode(JSON.stringify(body));
    const settleEgress = linkGrantEgressRateLimiter.reserve(
      grantId,
      bytes.byteLength,
      nowMs(),
    );
    if (!settleEgress) throw relayError("link_read_rate_limited");
    return respondWithLinkBytes(
      bytes,
      shareId,
      grantId,
      () => undefined,
      settleEgress,
      { "content-type": "application/json" },
    );
  };

  const {
    respondToLinkDiscussion,
    respondToLinkDiscussionActivity,
    respondToShareDiscussion,
    respondToShareDiscussionActivity,
    respondToShareDiscussionModeration,
  } = createDiscussionRoutes(
    storage,
    resolveActor,
    nowMs,
    lookupUserDisplayName,
    claimPendingShares,
    requireShareAction,
    requireShareWorkspace,
    linkKey,
    relayExchangeKeyHash !== undefined,
    hasValidRelayExchangeKey,
    requireLinkRead,
    requireFreshLinkRead,
    linkJsonResponse,
    linkReadRateLimiter,
    linkGrantReadRateLimiter,
    discussionActivity,
  );

  const {
    respondToLinkExchange,
    respondToLinkRefresh,
    respondToLinkHandoff,
    respondToLinkRedeem,
  } = createLinkCredentialRoutes(
    storage,
    linkKey,
    relayExchangeKeyHash !== undefined,
    hasValidRelayExchangeKey,
    requireLinkRead,
    nowMs,
    newId,
    newGrantId,
    newLinkBearer,
    newLinkHandoffCode,
    linkExchangeRateLimiter,
    linkExchangeGlobalRateLimiter,
    linkExchangeGrantRateLimiter,
    linkRedeemRateLimiter,
    linkReadRateLimiter,
    linkGrantReadRateLimiter,
    publicEditRelease,
  );

  const respondToLinkChat = createLinkChatRoutes({
    storage,
    linkKey,
    nowMs,
    requireLinkRead,
    requireFreshLinkRead,
    linkJsonResponse,
    readLimiters: { capability: linkReadRateLimiter, grant: linkGrantReadRateLimiter },
    followLimiters: { capability: linkLogReadRateLimiter, grant: linkGrantLogReadRateLimiter },
    activity: discussionActivity,
    reads: { chatResolverFor },
  });

  const replicaLinkReads=developmentReplicaReads ? storage.createReplicaLinkReadService(developmentReplicaReads,
    {holdReader:authorized=>replicaWatches.holdReader?.(authorized)},discussionActivity,newestFilteredOpFreshness,linkKey) : undefined;
  const respondToLinkRead = createLinkReadRoutes(
    storage,
    nowMs,
    linkCurrentFileLimit,
    requireLinkRead,
    requireFreshLinkRead,
    linkJsonResponse,
    filteredLogPage,
    newestFilteredOpFreshness,
    linkRevisionByteLength,
    linkReadRateLimiter,
    linkGrantReadRateLimiter,
    linkLogReadRateLimiter,
    linkGrantLogReadRateLimiter,
    linkGrantEgressRateLimiter,
    discussionActivity,
    admitLinkBlobBytes,
    respondWithLinkBytes,
    linkKey,
    replicaLinkReads,
  );

  const respondToOwnerRestore = createOwnerRestoreRoutes({storage, host: ownerRestoreHost, nowMs, newId, lookupUserEmail});
  const respondToOwnerAppPublication = createOwnerAppPublicationRoutes({storage, limits: appPublicationLimits, collectionsEnabled: appCollectionPolicy !== undefined, nowMs});
  const respondToLinkAppPublication = createLinkAppPublicationRoutes({storage, limits: appPublicationLimits, linkKey: linkKey!, publicEditRelease, nowMs,
    requireLinkRead, capabilityLimiter: linkReadRateLimiter, grantLimiter: linkGrantReadRateLimiter,
    egress: linkGrantEgressRateLimiter, streams: {admitLinkBlobBytes, respondWithLinkBytes}});
  const respondToLinkAppCollection = createLinkAppCollectionRoutes({storage,limits:appPublicationLimits,policy:appCollectionPolicy,linkKey:linkKey!,publicEditRelease,nowMs,
    requireLinkRead,capabilityLimiter:linkReadRateLimiter,grantLimiter:linkGrantReadRateLimiter,egress:linkGrantEgressRateLimiter,streams:{admitLinkBlobBytes,respondWithLinkBytes},discussionActivity});
  const dispatch: SyncRelayHandler = async (request) => {
    try {
      const pathname = new URL(request.url).pathname;
      if (pathname === "/sync/live/named-sessions" || pathname === "/sync/live/named-sessions/resolve") {
        return namedBrowser ? await namedBrowser(request) : errorResponse(notFound());
      }
      if (pathname === "/sync/live/named-documents") {
        return namedDocuments ? await namedDocuments(request) : errorResponse(notFound());
      }
      if (pathname.startsWith("/sync/named-chat/")) {
        return namedChat ? await namedChat(request) : errorResponse(notFound());
      }
      const route = parseRoute(request);
      if (route.route === "link-exchange") {
        if (request.method !== "POST") throw relayError("method_not_allowed");
        return await respondToLinkExchange(request);
      }
      if (route.route === "link-refresh") {
        if (request.method !== "POST") throw relayError("method_not_allowed");
        return respondToLinkRefresh(request);
      }
      if (route.route === "link-handoff") {
        if (request.method !== "POST") throw relayError("method_not_allowed");
        return respondToLinkHandoff(request);
      }
      if (route.route === "link-redeem") {
        if (request.method !== "POST") throw relayError("method_not_allowed");
        const actor = await resolveActor(request, "");
        return await respondToLinkRedeem(request, actor.userId);
      }
      if (route.route === "link-discussion") {
        return await respondToLinkDiscussion(request);
      }
      if (route.route === "link-discussion-activity") {
        return await respondToLinkDiscussionActivity(request);
      }
      if (route.route === "link-chat-channels" || route.route === "link-chat-messages") {
        return await respondToLinkChat(request, route);
      }
      if (route.route === "link-collection-writes") {
        if (!respondToLinkCollectionWrites) throw notFound();
        return await respondToLinkCollectionWrites(request);
      }
      if (route.route === "share-discussion") {
        return await respondToShareDiscussion(request, route.shareId);
      }
      if (route.route === "share-discussion-activity") {
        return await respondToShareDiscussionActivity(request, route.shareId);
      }
      if (route.route === "share-discussion-moderation") {
        return await respondToShareDiscussionModeration(request, route.shareId);
      }
      if (
        route.route === "link-share" ||
        route.route === "link-current" ||
        route.route === "link-log" ||
        route.route === "link-blob"
      ) {
        return await respondToLinkRead(request, route);
      }
      if (route.route === "named-dataset") {
        if (!respondToDataset) throw notFound();
        const authorization = request.headers.get("authorization");
        if (request.headers.has("cookie") || request.headers.has("x-dohc-dataset-grant") || !/^Bearer [^\s]+$/.test(authorization ?? "")) throw notFound();
        const actor = await resolveActor(new Request(request.url, { headers: { authorization: authorization! }, signal: request.signal }), "");
        const granted = requireShareAction(route.shareId, actor.userId, "read");
        if (granted.grant.principalKind !== "user" || granted.grant.principalUserId !== actor.userId) throw notFound();
        const auth = { kind: "named" as const, workspaceId: granted.share.workspaceId, userId: actor.userId, grantId: granted.grant.grantId };
        const fingerprint = datasetHost!.offlineAccessFingerprint(auth);
        const response = await respondToDataset(request, { route: "dataset", workspaceId: granted.share.workspaceId, datasetId: route.datasetId, action: route.action, named: true }, auth);
        const currentFingerprint = datasetHost!.offlineAccessFingerprint(auth);
        if (fingerprint !== currentFingerprint) {
          await response.body?.cancel();
          return Response.json({ message: "Collection access changed. Refresh the Collection." }, { status: 409,
            headers: { "cache-control": "no-store", "x-dohc-dataset-access": currentFingerprint } });
        }
        response.headers.set("x-dohc-dataset-access", fingerprint);
        return response;
      }
      if (route.route === "dataset" || route.route === "dataset-replica") {
        if (!respondToDataset) throw notFound();
        const authorization = request.headers.get("authorization");
        if (request.headers.has("cookie") || !/^Bearer [^\s]+$/.test(authorization ?? "")) throw notFound();
        const actor = await resolveActor(new Request(request.url, {headers: {authorization: authorization!}, signal: request.signal}), route.workspaceId);
        if (actor.workspaceId !== route.workspaceId) throw notFound();
        const grant = request.headers.get("x-dohc-dataset-grant");
        if(route.route==="dataset"&&route.action==="export") {
          if(!respondToDatasetExport||grant!==null||!route.datasetId||new URL(request.url).search)throw notFound();
          return respondToDatasetExport(request,{workspaceId:route.workspaceId,datasetId:route.datasetId,action:"export"},{kind:"named",workspaceId:route.workspaceId,userId:actor.userId});
        }
        if (route.route === "dataset-replica") {
          if (!respondToDatasetReplica || grant !== null) throw notFound();
          return await respondToDatasetReplica(request,route,{kind:"named",workspaceId:route.workspaceId,userId:actor.userId});
        }
        return await respondToDataset(request, route, {kind:"named", workspaceId:route.workspaceId, userId:actor.userId,
          ...(grant === null ? {} : {grantId: parseShareId(grant)})});
      }
      if (route.route === "owner-app-publication" || route.route === "owner-app-responses") {
        const authorization = request.headers.get("authorization");
        if (request.headers.has("cookie") || !/^Bearer [^\s]+$/.test(authorization ?? "")) throw notFound();
        // Owner publication uses explicit desktop/agent credentials, never ambient browser cookies.
        const actor = await resolveActor(new Request(request.url, {
          headers: {authorization: authorization!}, signal: request.signal,
        }), route.workspaceId);
        if (actor.workspaceId !== route.workspaceId) throw notFound();
        if(route.route==="owner-app-responses")return readOwnerAppResponses(request,route,actor.userId,storage);
        return await respondToOwnerAppPublication(request, route, actor.userId);
      }
      if (route.route === "app-backend") {
        if (!appPublicationLimits || !respondToDatasetApp) throw notFound();
        if (!route.workspaceId) {
          if (!linkKey || request.headers.has("cookie")) throw notFound();
          const {capability} = requireLinkCapability(request);
          const secret = request.headers.get("x-dohc-link-profile-secret");
          if (!secret || !LINK_SECRET_PATTERN.test(secret)) throw notFound();
          const auth = {kind:"link" as const, capabilityHash:capability.session.capabilityHash,
            profileTokenHash:hashLinkProfileSecret(secret, linkKey)};
          return await respondToDatasetApp(request, route, auth);
        }
        const authorization = request.headers.get("authorization");
        let actorRequest: Request;
        if (request.headers.has("cookie")) {
          // Browser account authority is accepted only through the trusted viewer.
          if (authorization || !shareWebOrigin || !relayExchangeKeyHash ||
              request.headers.get("origin") !== shareWebOrigin || !hasValidRelayExchangeKey(request)) throw notFound();
          actorRequest = request;
        } else {
          if (!/^Bearer [^\s]+$/.test(authorization ?? "")) throw notFound();
          actorRequest = new Request(request.url, {headers:{authorization:authorization!},signal:request.signal});
        }
        const actor = await resolveNamedActor(actorRequest, route.workspaceId);
        if (actor.workspaceId !== route.workspaceId) throw notFound();
        const auth = {kind:"named" as const, workspaceId:route.workspaceId,userId:actor.userId};
        return await respondToDatasetApp(request, route, auth);
      }
      if (route.route === "link-app-publication") return respondToLinkAppPublication(request, route);
      if (route.route === "link-app-collection") return await respondToLinkAppCollection(request, route);
      if (route.route === "automation-presses") {
        // Desktop and agent credentials only, never ambient browser cookies.
        const authorization = request.headers.get("authorization");
        if (request.headers.has("cookie") || !/^Bearer [^\s]+$/.test(authorization ?? "")) throw notFound();
        const actor = await resolveActor(new Request(request.url, {
          headers: {authorization: authorization!}, signal: request.signal,
        }), route.workspaceId);
        if (actor.workspaceId !== route.workspaceId) throw notFound();
        return await automationPresses.respondToHost(request, route, actor.userId);
      }
      if (route.route === "automation-host") {
        // Desktop and agent credentials only, never ambient browser cookies.
        const authorization = request.headers.get("authorization");
        if (request.headers.has("cookie") || !/^Bearer [^\s]+$/.test(authorization ?? "")) throw notFound();
        const actor = await resolveActor(new Request(request.url, {
          headers: {authorization: authorization!}, signal: request.signal,
        }), route.workspaceId);
        if (actor.workspaceId !== route.workspaceId) throw notFound();
        return await respondToAutomationHost(request, route, actor.userId);
      }
      if (route.route === "automation-server") {
        // Desktop and agent credentials only, never ambient browser cookies.
        const authorization = request.headers.get("authorization");
        if (request.headers.has("cookie") || !/^Bearer [^\s]+$/.test(authorization ?? "")) throw notFound();
        const actor = await resolveActor(new Request(request.url, {
          headers: {authorization: authorization!}, signal: request.signal,
        }), route.workspaceId);
        if (actor.workspaceId !== route.workspaceId) throw notFound();
        return await respondToAutomationServer(request, route, actor.userId);
      }
      if (route.route === "notices" || route.route === "notice-marks") {
        // Desktop and agent credentials only, never ambient browser cookies.
        const authorization = request.headers.get("authorization");
        if (request.headers.has("cookie") || !/^Bearer [^\s]+$/.test(authorization ?? "")) throw notFound();
        const actor = await resolveActor(new Request(request.url, {
          headers: {authorization: authorization!}, signal: request.signal,
        }), "");
        return await respondToNotices(request, route, actor.userId);
      }
      const actor = await resolveActor(request, "workspaceId" in route ? route.workspaceId : "");
      if (
        request.method === "POST" &&
        (!linkKey || !shareWebOrigin) &&
        (route.route === "share-link-create-atomic" ||
          route.route === "share-link-create" ||
          route.route === "share-link-rotate")
      ) {
        throw notFound();
      }

      if (route.route === "workspaces") {
        return await respondToWorkspaceRegistration(request, actor);
      }

      if (route.route === "shares-list" || route.route === "share" || route.route === "share-access" || route.route === "share-copy") {
        return await respondToShareInventory(request, route, actor);
      }

      if (
        route.route === "share-link-rotate" ||
        route.route === "share-link-retune" ||
        route.route === "share-grant-promote" ||
        route.route === "share-grant-revoke" ||
        route.route === "share-undo" ||
        route.route === "share-revoke"
      ) {
        return await respondToShareGrantTransition(request, route, actor);
      }

      if (route.route === "share-log" || route.route === "share-blob") {
        return await respondToNamedShareTransport(request, route, actor);
      }

      if (
        route.route === "share-proposals" ||
        route.route === "share-proposal-withdraw"
      ) {
        return await respondToShareProposals(request, route, actor.userId);
      }

      if (route.route === "share-collection-writes") {
        return await respondToCollectionWrites(request, route, actor.userId);
      }

      if (route.route === "share-automation-presses") {
        return await automationPresses.respondToSharePress(request, route.shareId, actor.userId);
      }

      if (route.route === "share-presence") {
        return await respondToSharePresence(request, route.shareId, actor.userId);
      }

      if (!storage.workspaceIsOwnedBy(route.workspaceId, actor.userId)) throw notFound();

      if (route.route === "owner-restore") return await respondToOwnerRestore(request, route, actor.userId);
      if (route.route === "owner-collection-writes") return readOwnerCollectionWrites(request, route, actor.userId, storage);

      // The granter's half. Everything below this line is
      // owner-scoped by the one check above, which is why accept and decline
      // live in the workspace namespace rather than the share's: ownership is
      // derived from the workspace, never from the share, so a recipient can
      // never accept its own changes.
      if (
        route.route === "workspace-proposals" ||
        route.route === "workspace-proposal" ||
        route.route === "workspace-proposal-op" ||
        route.route === "workspace-proposal-settle"
      ) {
        return await respondToWorkspaceProposals(request, route, actor.userId);
      }

      if (route.route === "presence") {
        return await respondToWorkspacePresence(request, route.workspaceId, actor.userId);
      }

      if (route.route === "bootstrap" || route.route === "epoch") {
        return await respondToWorkspaceReplication(request, route, actor);
      }

      if (route.route === "gc") {
        return await respondToWorkspaceBlobs(request, route);
      }

      if (route.route === "share-link-create-atomic" && request.method === "GET") {
        return await respondToWorkspaceLinkInventory(request, route.workspaceId, actor);
      }

      if (
        route.route === "share-link-create-atomic" ||
        route.route === "share-link-create" ||
        route.route === "shares-create"
      ) {
        return await respondToWorkspaceShareCreation(request, route, actor);
      }

      if (route.route === "blob" || route.route === "blob-have") {
        return await respondToWorkspaceBlobs(request, route);
      }

      if (route.route === "keys") {
        return await respondToKeyEnvelopes(request, route.workspaceId);
      }

      if (route.route === "log" || route.route === "log-coordinate") {
        return await respondToWorkspaceReplication(request, route, actor, undefined, async () => {
          const current = await resolveActor(request, route.workspaceId);
          if (current.userId !== actor.userId) throw notFound();
        });
      }

      throw relayError("method_not_allowed");
    } catch (error) {
      return errorResponse(error);
    }
  };
  const handle: SyncRelayHandler = async (request) => {
    const result = await dispatch(request);
    const path = new URL(request.url).pathname;
    return normalizeLinkRefusal(result, path);
  };
  return Object.assign(handle, {
    dispose(){replicaLinkReads?.close();},
    deleteAccount(userId: string, workspaceIds: readonly string[], shareIds: readonly string[]) {
      presence.deleteAccount(userId, workspaceIds);
      deletePresenceAccount(userId);
      namedBrowser?.deleteAccount(userId, workspaceIds);
      for (const shareId of shareIds) terminateLinkStreamsForShare(shareId);
    },
    resolveNamedBrowserSession: (request: Request, discriminator: string) => namedBrowser?.resolve(request, discriminator) ?? Promise.resolve(null),
    /**
     * A GET of the owner's share listings, answered in process as the
     * routes answer the owner, so the server's automations find a
     * workspace's editors the way the owner's computers do. Only
     * `/sync/shares` and `/sync/:workspaceId/shares/links` are served.
     */
    async readOwnerShares(ownerUserId: string, path: string) {
      const request = new Request(new URL(path, "http://relay.invalid"));
      const url = new URL(request.url);
      let response: Response;
      try {
        const parts = url.pathname.split("/").filter(Boolean).map((part) => decodeURIComponent(part));
        const actor = { userId: ownerUserId };
        if (url.pathname === "/sync/shares") {
          response = await ownerShareReads.respondToShareInventory(request, { route: "shares-list" }, actor);
        } else if (parts.length === 4 && parts[0] === "sync" && parts[2] === "shares" && parts[3] === "links") {
          response = await ownerShareReads.respondToWorkspaceLinkInventory(request, parseWorkspaceId(parts[1]), actor);
        } else {
          throw notFound();
        }
      } catch (error) {
        response = errorResponse(error);
      }
      return { status: response.status, body: await response.json().catch(() => undefined) };
    },
  });
}

/**
 * The routes whose handlers authenticate before they read the body, and bound
 * its size and receipt time: recovery imports and direct writes. Classified by
 * the same parse as dispatch, so every spelling of the path streams.
 */
export function streamsRequestBody(url: URL, method: string): boolean {
  try {
    const route = parseRoute({ url: url.href });
    return (route.route === "dataset" && route.action === "import" && method === "POST") ||
      route.route === "share-collection-writes" || route.route === "link-collection-writes";
  } catch { return false; }
}
