import { createAppExternalCalls } from "./appExternalCalls";
import { accountIsFenced, workspaceIsDeleted } from "./storage/accountDeletion";
import { parseRoute } from "./relayRoute";
import { RELAY_ROUTE_PATTERNS, SYNC_RELAY_REQUEST_LOG } from "./requestLog";
export { SYNC_RELAY_REQUEST_LOG } from "./requestLog";
import { createWorkReferenceRoutes } from "./workReferenceRoutes";
import { parsePublicEditRelease, type PublicEditRelease } from "@dohc/security-contract";
import { normalizeLinkRefusal } from "./linkRefusal";
import {
  APP_COLLECTION_REQUEST_BYTES,
  type AppPublicationLimits,
} from "@dohc/security-contract/app-publication";
import type { AppBackendAdmissionLimits } from "./appBackendAdmission";
import { createDatasetAppRoutes, createDatasetRoutes, datasetRequestBytes } from "./datasetRoutes";
import { createAppEventWaits } from "./appEventWaits";
import { MAX_BLOB_BYTES } from "./wireLimits";
import {
  APP_BACKEND_BULK_LIMITS,
  APP_BACKEND_UPLOAD_REQUEST_BYTES,
} from "@dohc/security-contract/app-backend";
import { createDatasetReplicaRoutes, datasetReplicaRequestBytes } from "./datasetReplicaRoutes";
import { createDatasetRecoveryExport } from "./datasetRecoveryExport";
import type { RelayDatasetHost } from "./datasetHost";
import { hashLinkProfileSecret } from "./linkSecurity";
import { LINK_SECRET_PATTERN } from "@dohc/security-contract/wire-patterns";
import { createOwnerAppPublicationRoutes } from "./ownerAppPublicationRoutes";
import { createMemberAppRoutes, MEMBER_APP_UPLOAD_BYTES } from "./memberAppRoutes";
import { UPLOAD_FILE_MAX_BODY_BYTES } from "./accountFileWrites";
import { SAVE_SKETCH_MAX_BODY_BYTES } from "./phoneSketches";
import { createPhoneApps } from "./phoneApps";
import { createPhoneCollections } from "./phoneCollections";
import { createNamedCollectionsRoute, NAMED_COLLECTIONS_PATH } from "./namedCollectionsRoute";
import type { PhoneAppLaunchScope } from "./storage/phoneApps";
import { readOwnerAppResponses } from "./ownerAppResponseRoutes";
import { createLinkAppPublicationRoutes } from "./linkAppPublicationRoutes";
import { createLinkAppCollectionRoutes, type AppCollectionPolicy } from "./appCollectionRoutes";
import { createNamedRecipientChat } from "./namedRecipientChat";
import { createPushRoutes } from "./pushRoutes";
import { createPushDeviceRoutes } from "./pushDeviceRoutes";
import { PUSH_DEVICES_PATH } from "@dohc/workspace-contracts/push-subscriptions";
import type { ApnsConfig } from "./pushConfig";
import { createNamedRecipientDocuments } from "./namedRecipientDocuments";
import { TokenBucketLimiter, type DeclaredHttpsTransport } from "@dohc/service-http";
import {
  createCollectionWriteRateLimiter,
  createCollectionWriteRoutes,
  createLinkCollectionWriteAdmission,
  createLinkCollectionWriteRoute,
  createPersonalCollectionWriteRoute,
  type LinkCollectionWriteAdmission,
  readOwnerCollectionWrites,
} from "./collectionWriteRoutes";
import { createHeldDocumentRoutes, type HeldDocumentHost } from "./heldDocumentRoutes";
import type { LiveRooms } from "./liveRoom";
import { createLiveRoomPauseRoutes } from "./liveRoomPauseRoutes";
import { createLiveNoteRoutes } from "./liveNoteRoutes";
import { randomUUID } from "node:crypto";
import {
  createNamedLiveBrowserHttp,
  type NamedLiveBrowserHttpLimits,
} from "./namedLiveBrowserHttp";
import type {
  AccountSessions,
  ResolveAccountSession,
  ResolveActor,
} from "@dohc/workspace-auth/session";
import {
  MEMBER_IDENTITY_MAX_AGE_MS,
  createNamedShareTransportRoutes,
} from "./namedShareTransportRoutes";
import { createKeyEnvelopeRoutes } from "./keyEnvelopeRoutes";
import {
  createWorkspaceSecretRateLimiter,
  createWorkspaceSecretRoutes,
  WORKSPACE_SECRET_MAX_BODY_BYTES,
} from "./workspaceSecretRoutes";
import { workspaceSecretKeyring, type WorkspaceSecretKeyring } from "./workspaceSecretCrypto";
import {
  createOutboundWebhookLimiters,
  createOutboundWebhookRoutes,
  executeRelayOutboundWebhook,
  MAX_HTTP_APPROVAL_BODY_BYTES,
  MAX_OUTBOUND_DISPATCH_BODY_BYTES,
  type OutboundWebhookExecutionDependencies,
  type OutboundWebhookLimiters,
} from "./outboundWebhookRoutes";
import {
  createIncomingWebhookLimiters,
  createIncomingWebhookRoutes,
  MAX_INCOMING_WEBHOOK_ADMIN_BODY_BYTES,
} from "./incomingWebhookRoutes";
import type {
  OutboundWebhookDispatchRequest,
  OutboundWebhookDispatchResponse,
} from "@dohc/workspace-contracts/http-step-approvals";
import {
  createNoticeRoutes,
  createNoticeWaits,
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
import { createAutomationServerRoutes, type ServerRuns } from "./automationServerRoutes";
import { createWorkspaceBlobRoutes } from "./workspaceBlobRoutes";
import { createAccountFeedWaits } from "./accountFeed";
import {
  createAccountOperationRateLimiter,
  createAccountOperationRoute,
} from "./accountOperationRoutes";
import { createChatWakeRoutes, createChatWakeWaits } from "./chatWakeRoutes";
import type { ServerCopies } from "./serverCopies";
import type { AccountFileWriteLiveHost } from "./accountFileWrites";
import type { PhonePages } from "./phonePages";
import { createAccountSessionRoutes } from "./accountSessionRoutes";
import type { OwnerLiveSockets } from "./namedLiveRoutes";
import { bearerAccountSession, createAccountWorkspaceRoutes } from "./accountWorkspaceRoutes";
import { createWorkspaceReplicationRoutes } from "./workspaceReplicationRoutes";
import { createLinkResponseStreams } from "./linkResponseStreams";
import { createLinkCredentialRoutes } from "./linkCredentialRoutes";
import { createAgentChatRoutes } from "./agentChatRoutes";
import { createAgentConnectionRoutes } from "./agentConnectionRoutes";
import { createPersonalAgentToolRoutes } from "./personalAgentRoutes";
import {
  createPersonalAgents,
  respondToWorkspaceName,
  type PersonalAgents,
} from "./personalAgents";
import type { CredentialFence } from "@dohc/workspace-auth/credentialFence";
import type { SendEmail } from "@dohc/workspace-auth/smtp";
import {
  accountDisplayName,
  createMentionAccountNameRefresher,
  type LookupUserDisplayNames,
} from "./accountDisplayName";
import { createDiscussionRoutes } from "./discussionRoutes";
import { shareSenderLabel as formatShareSender } from "@dohc/security-contract/share-labels";
import { createShareReadQueries } from "./shareReadQueries";
import { createLinkChatRoutes } from "./linkChatRoutes";
import { createLinkReadRoutes } from "./linkReadRoutes";
import {
  createLinkAuthorityResolver,
  type LinkAuthority,
  type LinkAuthorityResolver,
  type LinkJsonResponse,
} from "./linkAuthority";
import { createShareSummaries } from "./shareSummaries";
import { createShareGrantRoutes } from "./shareGrantRoutes";
import { createShareInvitationEmailer } from "./shareInvitationEmail";
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
import { createWorkspaceMemberRoutes, isWorkspaceMemberRoute } from "./workspaceMemberRoutes";
import { createDirectMessageRoutes, isDirectMessageRoute } from "./directMessageRoutes";
import { PresenceHub } from "./presence";
import { ReplicaWatches } from "./replicaWatches";
import { createPresenceRoutes } from "./presenceRoutes";
import { createProposalRoutes } from "./proposalRoutes";
import { parseShareId, parseWorkspaceId } from "./requestInputs";
import { parseStoredAnyShareSelectorJson, type ShareSelector } from "./shareFilter";
import { type SyncRelayStorage } from "./storage";
import type { AutomationServer } from "./storage/automationHosts";
import {
  authorizeShareAction,
  type AuthorizedShareAction,
  type ShareAction,
} from "./shareAuthorization";
import { errorResponse, invalidLinkCapability, notFound, relayError } from "./errors";
import { MAX_LOG_PAGE_SIZE } from "./wireLimits";
import { serverLogLine } from "./serverLogWords";

export { MAX_BLOB_BYTES, MAX_PAYLOAD_JSON_BYTES } from "./wireLimits";
export { MAX_KEY_ENVELOPE_BYTES } from "./keyEnvelopeRoutes";
export { ACCOUNT_NAME_LOOKUP_DEADLINE_MS } from "./accountDisplayName";
export { LINK_FRESHNESS_PAGE_BUDGET, MAX_RAW_ROWS_PER_SHARE_PAGE } from "./shareReadQueries";

export type SyncRelayHandler = (request: Request) => Promise<Response>;

export interface CreateSyncRelayHandlerOptions {
  appPublicationLimits?: AppPublicationLimits;
  appCollectionPolicy?: AppCollectionPolicy;
  appBackendAdmissionLimits?: Partial<AppBackendAdmissionLimits>;
  datasetHost?: RelayDatasetHost;
  liveRooms?: () => Pick<LiveRooms, "saveFirst"> | undefined;
  // The session host's read of what its hosted replicas hold for released retained work.
  heldDocumentHost?: () => HeldDocumentHost | undefined;
  storage: SyncRelayStorage;
  resolveActor: ResolveActor;
  // The browser sign-in behind a cookie, for state bound to it such as push subscriptions,
  // and an agent's sign-in approval. It refuses phone sessions.
  resolveAccountSession?: ResolveAccountSession;
  // The Bearer sign-in of the account routes the phone uses, a phone's included.
  // Only those routes take it. Without it the server serves no account routes.
  resolvePhoneCapableAccountSession?: ResolveAccountSession;
  // The accounts' sign-ins in Better Auth's session table, which the account routes list and revoke.
  accountSessions?: AccountSessions;
  // The owner's live connections, which a revoke or Show on phone turned off ends before it answers.
  ownerLiveSockets?: () => OwnerLiveSockets | undefined;
  // The accounts' password fences in Postgres. Absent means personal agents can't sign in here.
  credentialFence?: CredentialFence;
  // This server's VAPID public key. Absent means alerts are unavailable here.
  pushVapidPublicKey?: string;
  pushHosts?: ReadonlySet<string>;
  // The phone's APNs topic and environments. Absent means phone alerts are unavailable here.
  apnsConfig?: ApnsConfig;
  nowMs?: () => number;
  // A clock that only moves forward, for idle windows. Defaults to performance.now().
  elapsedMs?: () => number;
  // Maps a verified email to its account id. An unknown or unverified address returns null.
  // Absent means email-addressed grants are unavailable; grants by user id still work.
  resolveUserIdByEmail?: (email: string) => Promise<string | null> | string | null;
  // Returns an address only when the account has verified it server-side.
  lookupVerifiedUserEmail?: (userId: string) => Promise<string | null> | string | null;
  // Display-only reverse lookup for share listings; never used for authz.
  lookupUserEmail?: (userId: string) => Promise<string | null> | string | null;
  lookupUserEmails?: (userIds: readonly string[]) => Promise<ReadonlyMap<string, string>>;
  sendShareInvitationEmail?: SendEmail;
  // Better Auth display name for discussion authorship; never used for authz.
  lookupUserDisplayName?: (userId: string) => Promise<string | null> | string | null;
  lookupUserDisplayNames?: LookupUserDisplayNames;
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
  replicaWatches?: Pick<ReplicaWatches, "watched">;
  // Relay-instance HMAC key. When absent, every link route refuses without
  // touching storage. main.ts requires it outside development and test.
  linkKey?: string | Uint8Array;
  // The keys that seal workspace secrets; built from linkKey alone when absent.
  secretKeyring?: WorkspaceSecretKeyring | null;
  shareWebOrigin?: string;
  relayExchangeKey?: string;
  // Ends share-web's phone app sessions for these launch IDs' hashes once the relay has deleted them.
  endShareWebAppLaunches?: (launchHashes: readonly string[]) => void;
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
  // A signed-in person's reads of their apps' Collection changes, keyed by person.
  appEventReadRateLimiter?: TokenBucketLimiter;
  // Posts of notices to other people, keyed by sender.
  noticePostRateLimiter?: TokenBucketLimiter;
  // Changes to a workspace's automation host, and to the server's runs, keyed by owner.
  automationHostRateLimiter?: TokenBucketLimiter;
  workspaceSecretRateLimiter?: TokenBucketLimiter;
  outboundWebhookLimiters?: OutboundWebhookLimiters;
  resolveOutboundDestination?: OutboundWebhookExecutionDependencies["resolveDestination"];
  sendOutboundRequest?: OutboundWebhookExecutionDependencies["sendRequest"];
  readOutboundRequest?: OutboundWebhookExecutionDependencies["readRequest"];
  appExternalTransport?: DeclaredHttpsTransport;
  // This server while it runs workspaces' automations; absent when it does not.
  automationServer?: AutomationServer;
  pressDataset?: Parameters<typeof createDatasetRoutes>[2]["pressDataset"];
  // This server's runs, for their owners; undefined while it runs no automations.
  serverRuns?: () => ServerRuns | undefined;
  // A workspace's secrets changed, so this server's automations recheck the steps that use them.
  workspaceSecretsChanged?: (workspaceId: string) => void;
  serverCopies?: () => ServerCopies | undefined;
  // A phone's page opens for live editing; undefined while this server hosts no live pages for the phone.
  phonePages?: () => PhonePages | undefined;
  // The self-hosted live host, for retiring idle enrollments on owner file lifecycle mutations.
  liveHost?: () => AccountFileWriteLiveHost | undefined;
  // An account's reads and writes through those copies, keyed by sign-in.
  accountOperationRateLimiter?: TokenBucketLimiter;
  // This server's public HTTPS origin, which issues its accounts' actor keys. The phone's chat writes need it.
  relayPublicOrigin?: string;
  // Button presses from shared views, per grant, and the host's answers, per owner.
  automationPressRateLimiters?: ReturnType<typeof createAutomationPressRateLimiters>;
  linkFreshnessPageSize?: number;
  linkCurrentFileLimit?: number;
  newLinkBearer?: () => string;
  newLinkHandoffCode?: () => string;
  onWorkspaceCreated?: () => void;
}

const MAX_LINK_CURRENT_FILES = 5_000;

const MEMBERSHIP_MANAGED_SHARE_ROUTES: ReadonlySet<string> = new Set([
  "share-copy",
  "share-undo",
  "share-revoke",
  "share-grant-revoke",
  "share-grant-promote",
  "share-link-create",
  "share-link-rotate",
  "share-link-retune",
  "share-link-agents",
  "share-link-agent-disconnect",
]);

export function createSyncRelayHandler({
  appPublicationLimits,
  appCollectionPolicy,
  appBackendAdmissionLimits,
  datasetHost,
  liveRooms = () => undefined,
  heldDocumentHost = () => undefined,
  storage,
  resolveActor,
  resolveAccountSession,
  resolvePhoneCapableAccountSession,
  accountSessions,
  ownerLiveSockets = () => undefined,
  credentialFence,
  pushVapidPublicKey,
  pushHosts,
  apnsConfig,
  nowMs = () => Date.now(),
  elapsedMs,
  resolveUserIdByEmail,
  lookupVerifiedUserEmail,
  lookupUserEmail,
  lookupUserEmails,
  sendShareInvitationEmail,
  lookupUserDisplayName: lookupAccountDisplayName,
  lookupUserDisplayNames,
  newShareId = () => randomUUID(),
  newGrantId = () => randomUUID(),
  newId = () => randomUUID(),
  presence = new PresenceHub(),
  discussionActivity = new DiscussionActivityHub(),
  replicaWatches = new ReplicaWatches(discussionActivity),
  linkKey,
  secretKeyring = workspaceSecretKeyring({ linkKey }),
  shareWebOrigin,
  relayExchangeKey,
  endShareWebAppLaunches,
  namedBrowserSessionLimits,
  publicEditRelease: releaseInput,
  collectionWriteRateLimiter = createCollectionWriteRateLimiter(),
  linkCollectionWriteAdmission = createLinkCollectionWriteAdmission(),
  linkExchangeRateLimiter = new TokenBucketLimiter(
    LINK_EXCHANGE_BUCKET_CAPACITY,
    LINK_EXCHANGE_REFILL_PER_SECOND,
    LINK_EXCHANGE_MAX_IPS,
  ),
  linkExchangeGlobalRateLimiter = new TokenBucketLimiter(
    LINK_EXCHANGE_GLOBAL_BUCKET_CAPACITY,
    LINK_EXCHANGE_GLOBAL_REFILL_PER_SECOND,
    1,
  ),
  linkExchangeGrantRateLimiter = new TokenBucketLimiter(
    LINK_GRANT_READ_BUCKET_CAPACITY,
    LINK_GRANT_READ_REFILL_PER_SECOND,
    LINK_READ_MAX_CAPABILITIES,
  ),
  linkRedeemRateLimiter = new TokenBucketLimiter(
    LINK_READ_BUCKET_CAPACITY,
    LINK_READ_REFILL_PER_SECOND,
    LINK_READ_MAX_CAPABILITIES,
  ),
  linkReadRateLimiter = new TokenBucketLimiter(
    LINK_READ_BUCKET_CAPACITY,
    LINK_READ_REFILL_PER_SECOND,
    LINK_READ_MAX_CAPABILITIES,
  ),
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
  appEventReadRateLimiter = new TokenBucketLimiter(
    LINK_LOG_READ_BUCKET_CAPACITY,
    LINK_LOG_READ_REFILL_PER_SECOND,
    LINK_READ_MAX_CAPABILITIES,
  ),
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
  workspaceSecretRateLimiter = createWorkspaceSecretRateLimiter(),
  outboundWebhookLimiters = createOutboundWebhookLimiters(),
  resolveOutboundDestination,
  sendOutboundRequest,
  readOutboundRequest,
  appExternalTransport,
  linkFreshnessPageSize = MAX_LOG_PAGE_SIZE,
  linkCurrentFileLimit = MAX_LINK_CURRENT_FILES,
  newLinkBearer = () => mintLinkBearer(),
  newLinkHandoffCode = () => mintLinkHandoffCode(),
  automationServer,
  pressDataset,
  serverRuns = () => undefined,
  workspaceSecretsChanged = () => undefined,
  serverCopies = () => undefined,
  phonePages,
  liveHost,
  accountOperationRateLimiter = createAccountOperationRateLimiter(),
  relayPublicOrigin,
  onWorkspaceCreated,
}: CreateSyncRelayHandlerOptions): SyncRelayHandler & {
  resolveNamedBrowserSession: ReturnType<typeof createNamedLiveBrowserHttp>["resolve"];
  /** The browser sessions share-web's live socket resolves, when named browser sessions are enabled. */
  namedBrowserSessions: ReturnType<typeof createNamedLiveBrowserHttp>["sessions"] | undefined;
  /** The link resolver the MCP tool loop's routes use, for the live routes main composes. */
  linkAuthority: LinkAuthorityResolver;
  /** Personal agents' running work and fence, for the routes main composes. */
  personalAgents: PersonalAgents;
  /** The personal agent tools' per-connection limiter, which the personal live open shares. */
  personalLimiter: TokenBucketLimiter;
  /** Stops the fence listener. The Postgres pool can end once it settles. */
  dispose(): Promise<void>;
  /** Ends phone app launches in `scope`, on the relay and then in share-web. */
  endPhoneAppLaunches(scope: PhoneAppLaunchScope): void;
  deleteAccount(userId: string, workspaceIds: readonly string[], shareIds: readonly string[]): void;
  readOwnerShares(ownerUserId: string, path: string): Promise<{ status: number; body: unknown }>;
  executeOutboundWebhook(input: {
    readonly workspaceId: string;
    readonly ownerUserId: string;
    readonly request: OutboundWebhookDispatchRequest;
    readonly signal?: AbortSignal;
  }): Promise<{ httpStatus: number; body: OutboundWebhookDispatchResponse }>;
} {
  const accountActor = resolveActor;
  const requireUnfencedActor = (actor: Awaited<ReturnType<ResolveActor>>) => {
    if (accountIsFenced(storage, actor.userId)) throw notFound();
    return actor;
  };
  resolveActor = (request, workspaceId) => {
    const actor = accountActor(request, workspaceId);
    return typeof (actor as { then?: unknown }).then === "function"
      ? Promise.resolve(actor).then(requireUnfencedActor)
      : requireUnfencedActor(actor as Awaited<ReturnType<ResolveActor>>);
  };
  // Each name the relay looks up becomes the account's current name, which
  // mentions match when a message arrives.
  const lookupUserDisplayName =
    lookupAccountDisplayName &&
    (async (userId: string) => {
      const token = storage.beginAccountNameLookup();
      try {
        const name = await lookupAccountDisplayName(userId);
        storage.recordAccountName(userId, name, nowMs(), token.generation);
        return name;
      } finally {
        token.finish();
      }
    });
  const refreshMentionAccountNames = createMentionAccountNameRefresher({
    storage,
    lookupUserDisplayNames,
    lookupUserDisplayName: lookupAccountDisplayName,
    nowMs,
  });
  const publicEditRelease = parsePublicEditRelease(releaseInput);
  const respondToDataset = datasetHost
    ? createDatasetRoutes(datasetHost, storage, {
        limits: appBackendAdmissionLimits,
        nowMs,
        pressDataset,
      })
    : undefined;
  const respondToDatasetReplica = datasetHost
    ? createDatasetReplicaRoutes(datasetHost, storage, { limits: appBackendAdmissionLimits, nowMs })
    : undefined;
  const respondToDatasetExport = datasetHost
    ? createDatasetRecoveryExport(datasetHost, storage, {
        limits: appBackendAdmissionLimits,
        nowMs,
      })
    : undefined;
  const appEventWaits = datasetHost
    ? createAppEventWaits(storage, datasetHost.datasetRevision)
    : undefined;
  const fromDesktop = (request: Request, userId: string) => async () => {
    const sessionResolver = resolvePhoneCapableAccountSession ?? resolveAccountSession;
    if (!sessionResolver) return false;
    const session = await bearerAccountSession(storage, sessionResolver, request);
    return session.clientKind === "desktop" && session.userId === userId;
  };
  const respondToDatasetApp = datasetHost
    ? createDatasetAppRoutes(datasetHost, storage, {
        limits: appBackendAdmissionLimits,
        nowMs,
        shareSenderLabel,
        publications: appPublicationLimits !== undefined,
        events: appEventWaits,
        external: createAppExternalCalls({
          storage,
          keyring: secretKeyring,
          nowMs,
          ...(appExternalTransport ? { transport: appExternalTransport } : {}),
        }),
      })
    : undefined;
  if (
    publicEditRelease &&
    (!linkKey || !shareWebOrigin || !relayExchangeKey || !namedBrowserSessionLimits)
  ) {
    throw new TypeError(
      "Public Edit release requires link credentials, viewer origin, relay exchange, and named browser sessions.",
    );
  }
  if (namedBrowserSessionLimits && (!shareWebOrigin || !relayExchangeKey)) {
    throw new TypeError(
      "Named browser sessions require configured viewer origin and relay exchange.",
    );
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
  const namedBrowser = namedBrowserSessionLimits
    ? createNamedLiveBrowserHttp({
        storage,
        publicOrigin: shareWebOrigin!,
        exchangeKey: relayExchangeKey!,
        limits: namedBrowserSessionLimits,
        now: nowMs,
        elapsedNow: elapsedMs,
        resolveActor: resolveNamedActor,
      })
    : undefined;
  const namedDocuments = namedBrowserSessionLimits
    ? createNamedRecipientDocuments({
        storage,
        publicOrigin: shareWebOrigin!,
        exchangeKey: relayExchangeKey!,
        limits: namedBrowserSessionLimits,
        resolveActor: resolveNamedActor,
        maxFiles: linkCurrentFileLimit,
        shareSenderLabel,
      })
    : undefined;
  const relayExchangeKeyHash =
    relayExchangeKey === undefined ? undefined : hashRelayExchangeKey(relayExchangeKey);

  const hasValidRelayExchangeKey = (request: Request): boolean => {
    // An unconfigured key permits the request — that only occurs in
    // development and test; production and self-host require the key.
    if (relayExchangeKeyHash === undefined) return true;
    const presented = request.headers.get("x-dohc-relay-exchange-key");
    return verifyRelayExchangeKey(presented, relayExchangeKeyHash);
  };
  const phoneApps = createPhoneApps({
    storage,
    limits: appPublicationLimits,
    sessions: accountSessions,
    launchable: !!shareWebOrigin && !!relayExchangeKeyHash && !!respondToDatasetApp,
    nowMs,
    endShareWebLaunches: endShareWebAppLaunches,
    served(auth, publicationId, reviewing) {
      if (!datasetHost) throw notFound();
      return datasetHost.servedPublication(auth, publicationId, reviewing);
    },
    async authorName(userId) {
      const name = await accountDisplayName(lookupUserDisplayName, userId);
      const email = await lookupUserEmail?.(userId);
      return name || email ? formatShareSender(name, email) : null;
    },
  });
  // Share-web, with the exchange key and no person's credential, redeeming a grant or acting under a launch ID.
  const fromShareWeb = (request: Request) =>
    !request.headers.has("cookie") &&
    !request.headers.has("authorization") &&
    !!shareWebOrigin &&
    !!relayExchangeKeyHash &&
    request.headers.get("origin") === shareWebOrigin &&
    hasValidRelayExchangeKey(request);

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
    namedShareBlob,
    linkRevisionByteLength,
  } = createShareReadQueries(storage, linkFreshnessPageSize, linkKey);

  async function shareSenderLabel(
    granterUserId: string,
    knownEmail?: string | null,
  ): Promise<string> {
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
    const labels = new Map<string, Promise<{ senderLabel: string; senderEmail: string | null }>>();
    for (const { grantId, granterUserId, showsGranterEmail } of storage.pendingShareNotices(
      userId,
    )) {
      try {
        const key = `${showsGranterEmail ? "email" : "name"}:${granterUserId}`;
        let label = labels.get(key);
        if (label === undefined) {
          label = (async () => {
            const senderEmail = showsGranterEmail
              ? ((await lookupUserEmail?.(granterUserId)) ?? null)
              : null;
            return { senderLabel: await shareSenderLabel(granterUserId, senderEmail), senderEmail };
          })();
          labels.set(key, label);
        }
        storage.noticeShareReceived({ grantId, ...(await label), nowMs: nowMs() });
      } catch (error) {
        console.error("[sync-relay] share notice failed", serverLogLine(error));
      }
    }
  };

  // Claim email invites only after the authenticated account verifies its address.
  // One lookup per account at a time, so a slower lookup can't store an older
  // email over a newer one. `refreshedAt` lets the member feed skip a repeat
  // lookup within `maxAgeMs`.
  const accountRefreshes = new Map<
    string,
    { done: Promise<void>; callers: (AbortSignal | undefined)[] }
  >();
  const refreshedAt = new Map<string, number>();
  const refreshAccount = async (
    userId: string,
    callers: (AbortSignal | undefined)[],
  ): Promise<void> => {
    const startedAt = nowMs();
    if (!lookupVerifiedUserEmail) {
      storage.refreshAccountEmail(userId, null, startedAt);
      return;
    }
    // A failed lookup throws and keeps the stored email: design §1 makes it an error.
    const email = await lookupVerifiedUserEmail(userId);
    // Once every caller has cancelled, the result is dropped: nothing is stored or claimed.
    if (callers.every((signal) => signal?.aborted)) return;
    storage.refreshAccountEmail(userId, { verifiedEmail: email }, startedAt);
    // Kept in refresh order and capped: forgetting the oldest only costs a lookup.
    refreshedAt.delete(userId);
    refreshedAt.set(userId, startedAt);
    if (refreshedAt.size > 10_000) refreshedAt.delete(refreshedAt.keys().next().value!);
    if (email && storage.claimPendingSharesForEmail(email, userId) > 0) {
      await accountDisplayName(lookupUserDisplayName, userId);
    }
  };
  // Returns the shared refresh itself, adding no awaits of its own.
  const claimPendingShares = (
    userId: string,
    signal?: AbortSignal,
    maxAgeMs?: number,
  ): Promise<void> => {
    if (signal?.aborted) return Promise.reject(signal.reason);
    const last = refreshedAt.get(userId);
    if (maxAgeMs !== undefined && last !== undefined && nowMs() - last < maxAgeMs)
      return Promise.resolve();
    let running = accountRefreshes.get(userId);
    if (!running) {
      const callers: (AbortSignal | undefined)[] = [];
      const started = { done: refreshAccount(userId, callers), callers };
      running = started;
      accountRefreshes.set(userId, started);
      const clear = () => {
        if (accountRefreshes.get(userId) === started) accountRefreshes.delete(userId);
      };
      started.done.then(clear, clear);
    }
    running.callers.push(signal);
    return signal ? running.done.then(() => signal.throwIfAborted()) : running.done;
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
    if (storage.listRemovedSharesForRecipient(actorUserId, shareId).length > 0)
      throw relayError("share_access_removed");
    if (result.reason === "denied" && (action === "append" || action === "propose")) {
      throw relayError("share_read_only");
    }
    throw notFound();
  }

  const {
    respondToSharePresence,
    respondToWorkspacePresence,
    deleteAccount: deletePresenceAccount,
  } = createPresenceRoutes(
    presence,
    nowMs,
    storage,
    claimPendingShares,
    requireShareAction,
    chatResolverFor,
    // Presence names people without recording the name. A write would make
    // every waiting poll prepare its snapshot again.
    lookupAccountDisplayName,
  );

  function requireShareWorkspace(share: { workspaceId: string }, workspaceId: string): void {
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

  const { respondToWorkspaceRegistration, respondToWorkspaceReplication } =
    createWorkspaceReplicationRoutes(
      storage,
      nowMs,
      discussionActivity,
      replicaWatches,
      lookupUserDisplayName,
      refreshMentionAccountNames,
      onWorkspaceCreated,
    );

  const respondToWorkspaceBlobs = createWorkspaceBlobRoutes(storage, nowMs);

  const respondToKeyEnvelopes = createKeyEnvelopeRoutes(storage, nowMs);
  const respondToWorkspaceSecrets = createWorkspaceSecretRoutes({
    storage,
    keyring: secretKeyring,
    nowMs,
    rateLimiter: workspaceSecretRateLimiter,
    secretsChanged: workspaceSecretsChanged,
  });
  const outboundWebhookInFlight = new Map<string, number>();
  const readOwnerShares = async (
    ownerUserId: string,
    path: string,
  ): Promise<{ status: number; body: unknown }> => {
    const request = new Request(new URL(path, "http://relay.invalid"));
    const url = new URL(request.url);
    let response: Response;
    try {
      const parts = url.pathname
        .split("/")
        .filter(Boolean)
        .map((part) => decodeURIComponent(part));
      const actor = { userId: ownerUserId };
      if (url.pathname === "/sync/shares") {
        response = await ownerShareReads.respondToShareInventory(
          request,
          { route: "shares-list" },
          actor,
        );
      } else if (
        parts.length === 4 &&
        parts[0] === "sync" &&
        parts[2] === "shares" &&
        parts[3] === "links"
      ) {
        response = await ownerShareReads.respondToWorkspaceLinkInventory(
          request,
          parseWorkspaceId(parts[1]),
          actor,
        );
      } else {
        throw notFound();
      }
    } catch (error) {
      response = errorResponse(error);
    }
    return { status: response.status, body: await response.json().catch(() => undefined) };
  };
  const outboundWebhookDeps: OutboundWebhookExecutionDependencies = {
    storage,
    keyring: secretKeyring,
    readOwnerShares,
    approvalRateLimiter: outboundWebhookLimiters.approval,
    accountRateLimiter: outboundWebhookLimiters.account,
    workspaceRateLimiter: outboundWebhookLimiters.workspace,
    accountInFlight: outboundWebhookInFlight,
    nowMs,
    ...(resolveOutboundDestination ? { resolveDestination: resolveOutboundDestination } : {}),
    ...(sendOutboundRequest ? { sendRequest: sendOutboundRequest } : {}),
    ...(readOutboundRequest ? { readRequest: readOutboundRequest } : {}),
  };
  const respondToOutboundWebhooks = createOutboundWebhookRoutes(outboundWebhookDeps);
  const incomingWebhookLimiters = createIncomingWebhookLimiters();
  const incomingWebhooks = createIncomingWebhookRoutes({
    storage,
    linkKey,
    ...(relayPublicOrigin ? { publicOrigin: relayPublicOrigin } : {}),
    nowMs,
    limiters: incomingWebhookLimiters,
    automationServer: automationServer ?? null,
  });

  const noticeWaits = createNoticeWaits(storage, discussionActivity);
  const respondToNotices = createNoticeRoutes(
    storage,
    nowMs,
    lookupUserDisplayName,
    claimPendingShares,
    deliverPendingShareNotices,
    noticePostRateLimiter,
    {
      resolveAccountSession: resolvePhoneCapableAccountSession,
      limiter: accountOperationRateLimiter,
      waits: noticeWaits,
    },
  );
  const respondToAutomationHost = createAutomationHostRoutes(
    storage,
    nowMs,
    automationHostRateLimiter,
    automationServer ?? null,
  );
  const respondToAutomationServer = createAutomationServerRoutes(
    storage,
    serverRuns,
    nowMs,
    automationHostRateLimiter,
  );
  const ownerSockets: OwnerLiveSockets = {
    stopSession: (userId, sessionId) => ownerLiveSockets()?.stopSession(userId, sessionId),
    stopPhoneWorkspace: (userId, workspaceId) =>
      ownerLiveSockets()?.stopPhoneWorkspace(userId, workspaceId),
  };
  const respondToAccountWorkspaces = resolvePhoneCapableAccountSession
    ? createAccountWorkspaceRoutes({
        storage,
        resolveAccountSession: resolvePhoneCapableAccountSession,
        sockets: ownerSockets,
        fileWritesAvailable: () => serverCopies() !== undefined,
        hidden: (userId, workspaceId) => {
          phoneApps.end({ userId, workspaceId });
          serverCopies()?.endHold(workspaceId, userId);
        },
      })
    : undefined;
  const accountFeedWaits = createAccountFeedWaits(storage, discussionActivity);
  const chatWakeWaits = createChatWakeWaits(storage, discussionActivity);
  // A credential change makes the account's held feed, wake, and Notice reads check it now.
  const wakeAccountWaits = (userId: string) => {
    accountFeedWaits.wakeAccount(userId);
    chatWakeWaits.wakeAccount(userId);
    noticeWaits.wakeAccount(userId);
  };
  const respondToAccountSessions =
    resolvePhoneCapableAccountSession && accountSessions
      ? createAccountSessionRoutes({
          storage,
          resolveAccountSession: resolvePhoneCapableAccountSession,
          sessions: accountSessions,
          feedWaits: { wakeAccount: wakeAccountWaits },
          nowMs,
          sockets: ownerSockets,
          revoked: (userId, sessionId) => phoneApps.end({ userId, sessionId }),
        })
      : undefined;
  const phoneCollections = createPhoneCollections({ storage, host: datasetHost });
  const namedCollections =
    resolveAccountSession && shareWebOrigin && relayExchangeKeyHash
      ? createNamedCollectionsRoute({
          storage,
          collections: phoneCollections,
          resolveAccountSession,
          publicOrigin: shareWebOrigin,
          hasExchangeKey: hasValidRelayExchangeKey,
          limiter: accountOperationRateLimiter,
          nowMs,
        })
      : undefined;
  const respondToAccountOperation = resolvePhoneCapableAccountSession
    ? createAccountOperationRoute({
        storage,
        resolveAccountSession: resolvePhoneCapableAccountSession,
        copies: serverCopies,
        nowMs,
        limiter: accountOperationRateLimiter,
        feedWaits: accountFeedWaits,
        wakeWaits: chatWakeWaits,
        activity: discussionActivity,
        lookupUserDisplayName,
        refreshMentionAccountNames,
        refreshAccountEmail: (userId, signal) =>
          claimPendingShares(userId, signal, MEMBER_IDENTITY_MAX_AGE_MS),
        serverUrl: relayPublicOrigin,
        phoneApps,
        phoneCollections,
        ...(phonePages ? { phonePages } : {}),
        ...(liveHost ? { liveHost } : {}),
        liveRooms,
        ...(shareWebOrigin && relayExchangeKeyHash
          ? { browser: { origin: shareWebOrigin, hasExchangeKey: hasValidRelayExchangeKey } }
          : {}),
        admitBlobBytes: admitLinkBlobBytes,
      })
    : undefined;
  // The owner's computers claim wakes here; the phone reads wakes through its operations route.
  const respondToChatWakes = resolveAccountSession
    ? createChatWakeRoutes({
        storage,
        resolveAccountSession,
        waits: chatWakeWaits,
        nowMs,
        limiter: accountOperationRateLimiter,
      })
    : undefined;
  const automationPresses = createAutomationPressRoutes({
    storage,
    nowMs,
    newId,
    claimPendingShares,
    activity: discussionActivity,
    rateLimiters: automationPressRateLimiters,
  });

  const emailInvitation = createShareInvitationEmailer({
    storage,
    nowMs,
    sendEmail: sendShareInvitationEmail,
    lookupVerifiedUserEmail,
    lookupUserDisplayName: lookupAccountDisplayName,
    relayPublicOrigin,
  });
  const respondToWorkspaceMembers = createWorkspaceMemberRoutes({
    storage,
    nowMs,
    newId,
    newShareId,
    newGrantId,
    claimPendingShares,
    resolveUserIdByEmail,
    lookupUserEmail,
    lookupUserDisplayName,
    linkKey,
    shareWebOrigin,
    hasValidRelayExchangeKey,
    discussionActivity,
    emailInvitation,
    browserOrigin: namedBrowser ? shareWebOrigin : undefined,
    reachChanged: (workspaceId) => phoneApps.end({ joined: true, workspaceId }),
  });
  const respondToDirectMessages = createDirectMessageRoutes({
    storage,
    activity: discussionActivity,
    nowMs,
    newId,
    lookupUserDisplayName,
  });
  const respondToNamedShareTransport = createNamedShareTransportRoutes(
    storage,
    nowMs,
    claimPendingShares,
    requireShareAction,
    shareActionGuard,
    filteredLogPage,
    namedShareBlob,
    discussionActivity,
    lookupUserDisplayName,
    linkKey,
    refreshMentionAccountNames,
  );

  const namedChat = namedBrowserSessionLimits
    ? createNamedRecipientChat({
        storage,
        publicOrigin: shareWebOrigin!,
        exchangeKey: relayExchangeKey!,
        limits: namedBrowserSessionLimits,
        resolveActor,
        lookupUserDisplayName,
        refreshMentionAccountNames,
        claimPendingShares,
        activity: discussionActivity,
        nowMs,
        requireShareAction,
        reads: { chatResolverFor },
      })
    : undefined;

  const push =
    namedBrowserSessionLimits && resolveAccountSession
      ? createPushRoutes({
          storage,
          publicOrigin: shareWebOrigin!,
          exchangeKey: relayExchangeKey!,
          vapidPublicKey: pushVapidPublicKey,
          pushHosts,
          limits: namedBrowserSessionLimits,
          nowMs,
          resolveAccountSession: async (request) => {
            const session = await resolveAccountSession(request);
            if (accountIsFenced(storage, session.userId)) throw notFound();
            return session;
          },
        })
      : undefined;
  // The phone's own route, outside share-web: a Bearer phone session only.
  const pushDevices = resolvePhoneCapableAccountSession
    ? createPushDeviceRoutes({
        storage,
        resolveAccountSession: resolvePhoneCapableAccountSession,
        apns: apnsConfig,
        nowMs,
      })
    : undefined;

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
  } = createShareSummaries(
    storage,
    (shareId, reader) => {
      const membership = storage.getWorkspaceMembershipByShare(shareId);
      return membership
        ? { subjectName: membership.workspaceName }
        : storage.getShareLabels(shareId, reader);
    },
    lookupUserEmail,
    namedBrowser ? shareWebOrigin : undefined,
  );

  const shareInventoryRoutes = (claim: (userId: string) => Promise<void>) =>
    createShareInventoryRoutes(
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
      shareWebOrigin,
      lookupUserDisplayName,
    );
  const { respondToShareInventory, respondToWorkspaceLinkInventory } =
    shareInventoryRoutes(claimPendingShares);
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
    emailInvitation,
    publicEditRelease,
    liveRooms,
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
    return { capabilityToken, capability };
  };
  const requireLinkRead = (
    request: Request,
    capabilityRateLimiter: TokenBucketLimiter,
    grantRateLimiter: TokenBucketLimiter,
  ) => {
    const { capabilityToken, capability } = requireLinkCapability(request);
    const admittedAtMs = nowMs();
    const admitted =
      capabilityRateLimiter.allow(capability.session.capabilityHash, admittedAtMs) &&
      grantRateLimiter.allow(capability.grantId, admittedAtMs);
    if (!admitted) throw relayError("link_read_rate_limited");
    return { capabilityToken, capability };
  };

  const limitAppEvents = (route: { action: string }, userId: string) => {
    if (route.action === "events" && !appEventReadRateLimiter.allow(userId, nowMs()))
      throw relayError("link_read_rate_limited");
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

  const personalAgents = createPersonalAgents({
    storage,
    fence: credentialFence,
    activity: discussionActivity,
    nowMs,
    onFence: wakeAccountWaits,
  });

  // The routes share-web's MCP tool loop calls take a link holder's
  // capability or a connected agent's access token through this one resolver.
  // The link read routes also take a workspace member's account.
  const linkAuthority = createLinkAuthorityResolver({
    storage,
    personalAgents,
    linkKey,
    publicEditRelease,
    relayExchangeKeyConfigured: relayExchangeKeyHash !== undefined,
    hasValidRelayExchangeKey,
    nowMs,
    requireLinkCapability,
    requireFreshLinkRead,
    // A member's browser reads refresh their account email as the feed does,
    // so a rule that named their old address stops reaching them.
    resolveActor: async (request, workspaceId) => {
      const actor = await resolveActor(request, workspaceId);
      if (actor.workspaceId === workspaceId)
        await claimPendingShares(actor.userId, request.signal, MEMBER_IDENTITY_MAX_AGE_MS);
      return actor;
    },
    // A personal agent's requests refresh its person's email on the same terms.
    refreshAccountEmail: (userId) =>
      claimPendingShares(userId, undefined, MEMBER_IDENTITY_MAX_AGE_MS),
    publicOrigin: shareWebOrigin,
  });
  const respondToLinkCollectionWrites = linkKey
    ? createLinkCollectionWriteRoute({
        storage,
        rateLimiter: collectionWriteRateLimiter,
        admission: linkCollectionWriteAdmission,
        linkKey,
        linkAuthority,
        nowMs,
        newId,
        discussionActivity,
      })
    : null;

  const linkJsonResponse: LinkJsonResponse = (authority, body, signal) => {
    const bytes = new TextEncoder().encode(JSON.stringify(body));
    const settleEgress = linkGrantEgressRateLimiter.reserve(
      authority.grantId,
      bytes.byteLength,
      nowMs(),
    );
    if (!settleEgress) throw relayError("link_read_rate_limited");
    // An agent's answer stops once its token expires or its connection or link ends.
    let stream: { signal: AbortSignal; guard(): void } | undefined;
    if (authority.credential !== undefined && authority.credential.kind === "agent") {
      const agent: LinkAuthority = authority;
      stream = {
        signal,
        guard: () => {
          linkAuthority.fresh(agent);
        },
      };
    }
    return respondWithLinkBytes(
      bytes,
      authority.shareId,
      authority.grantId,
      () => undefined,
      settleEgress,
      { "content-type": "application/json" },
      stream,
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
    linkAuthority,
  );

  const { respondToLinkExchange, respondToLinkRefresh, respondToLinkHandoff, respondToLinkRedeem } =
    createLinkCredentialRoutes(
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

  const { respondToAgentSignIn, respondToLinkAgents } = createAgentConnectionRoutes({
    storage,
    linkKey,
    shareWebOrigin,
    relayExchangeKeyConfigured: relayExchangeKeyHash !== undefined,
    hasValidRelayExchangeKey,
    nowMs,
    newId,
    newLinkBearer,
    linkExchangeRateLimiter,
    linkExchangeGlobalRateLimiter,
    requireShareWorkspace,
    publicEditRelease,
    activity: discussionActivity,
    personalAgents,
    resolveAccountSession,
  });

  const respondToAgentChat = createAgentChatRoutes({
    storage,
    linkKey,
    relayExchangeKeyConfigured: relayExchangeKeyHash !== undefined,
    hasValidRelayExchangeKey,
    nowMs,
    activity: discussionActivity,
    reads: { chatResolverFor },
    refreshMentionAccountNames,
  });

  const respondToPersonalAgentTools = createPersonalAgentToolRoutes({
    storage,
    linkAuthority,
    personalAgents,
    nowMs,
    activity: discussionActivity,
    limiter: linkReadRateLimiter,
    admitBlobBytes: admitLinkBlobBytes,
    maxFiles: linkCurrentFileLimit,
    lookupUserDisplayName,
    refreshMentionAccountNames,
    collectionWrites: createPersonalCollectionWriteRoute({
      storage,
      rateLimiter: collectionWriteRateLimiter,
      admission: linkCollectionWriteAdmission,
      nowMs,
      newId,
      discussionActivity,
      lookupUserDisplayName,
    }),
  });

  const respondToLinkChat = createLinkChatRoutes({
    storage,
    linkKey,
    nowMs,
    linkAuthority,
    linkJsonResponse,
    readLimiters: { capability: linkReadRateLimiter, grant: linkGrantReadRateLimiter },
    followLimiters: { capability: linkLogReadRateLimiter, grant: linkGrantLogReadRateLimiter },
    activity: discussionActivity,
    reads: { chatResolverFor },
    refreshMentionAccountNames,
  });

  const respondToLinkRead = createLinkReadRoutes(
    storage,
    nowMs,
    linkCurrentFileLimit,
    linkAuthority,
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
    lookupUserDisplayName,
  );

  const respondToHeldDocuments = createHeldDocumentRoutes({ storage, host: heldDocumentHost });
  const respondToLivePauses = createLiveRoomPauseRoutes(storage);
  const respondToLiveNotes = createLiveNoteRoutes(storage);
  const respondToOwnerAppPublication = createOwnerAppPublicationRoutes({
    storage,
    limits: appPublicationLimits,
    collectionsEnabled: appCollectionPolicy !== undefined,
    nowMs,
  });
  const respondToMemberApps = datasetHost
    ? createMemberAppRoutes({
        host: datasetHost,
        storage,
        limits: appPublicationLimits,
        ...(shareWebOrigin ? { shareWebOrigin } : {}),
        authorName: (userId) => accountDisplayName(lookupUserDisplayName, userId),
      })
    : undefined;
  const respondToLinkAppPublication = createLinkAppPublicationRoutes({
    storage,
    limits: appPublicationLimits,
    linkKey: linkKey!,
    publicEditRelease,
    nowMs,
    requireCollectionFile: datasetHost?.requireCollectionFile,
    requireLinkRead,
    capabilityLimiter: linkReadRateLimiter,
    grantLimiter: linkGrantReadRateLimiter,
    egress: linkGrantEgressRateLimiter,
    streams: { admitLinkBlobBytes, respondWithLinkBytes },
  });
  const respondToLinkAppCollection = createLinkAppCollectionRoutes({
    storage,
    limits: appPublicationLimits,
    policy: appCollectionPolicy,
    linkKey: linkKey!,
    publicEditRelease,
    nowMs,
    requireLinkRead,
    capabilityLimiter: linkReadRateLimiter,
    grantLimiter: linkGrantReadRateLimiter,
    egress: linkGrantEgressRateLimiter,
    streams: { admitLinkBlobBytes, respondWithLinkBytes },
    discussionActivity,
  });
  const dispatch: SyncRelayHandler = async (request) => {
    try {
      const pathname = new URL(request.url).pathname;
      if (
        pathname === "/sync/live/named-sessions" ||
        pathname === "/sync/live/named-sessions/resolve"
      ) {
        return namedBrowser ? await namedBrowser(request) : errorResponse(notFound());
      }
      if (pathname === NAMED_COLLECTIONS_PATH) {
        return namedCollections ? await namedCollections(request) : errorResponse(notFound());
      }
      if (pathname === "/sync/live/named-documents") {
        return namedDocuments ? await namedDocuments(request) : errorResponse(notFound());
      }
      if (pathname.startsWith("/sync/named-chat/")) {
        return namedChat ? await namedChat(request) : errorResponse(notFound());
      }
      if (pathname === `/sync${PUSH_DEVICES_PATH}`) {
        return pushDevices ? await pushDevices(request) : errorResponse(notFound());
      }
      if (pathname.startsWith("/sync/push/")) {
        return push ? await push(request) : errorResponse(notFound());
      }
      const route = parseRoute(request);
      SYNC_RELAY_REQUEST_LOG.mark(request, RELAY_ROUTE_PATTERNS[route.route]);
      if (route.route === "incoming-webhook") {
        return await incomingWebhooks.respondToPublicIngress(request, route.token);
      }
      if (
        route.route === "work-reference" ||
        route.route === "work-references" ||
        route.route === "share-work-references" ||
        route.route === "internal-work-reference"
      ) {
        if (request.headers.has("cookie")) throw notFound();
        if (
          route.route === "internal-work-reference" &&
          (!relayExchangeKeyHash || !hasValidRelayExchangeKey(request))
        )
          throw notFound();
        const respond = createWorkReferenceRoutes(storage, linkKey, nowMs);
        if (request.headers.get("authorization")?.startsWith("LinkCapability ")) {
          const { capabilityToken, capability } = requireLinkCapability(request);
          const secret = request.headers.get("x-dohc-link-profile-secret");
          const datasetAuth =
            secret && linkKey && LINK_SECRET_PATTERN.test(secret)
              ? {
                  kind: "link" as const,
                  capabilityHash: capability.session.capabilityHash,
                  profileTokenHash: hashLinkProfileSecret(secret, linkKey),
                }
              : undefined;
          return await respond(request, route, {
            kind: "link",
            grantId: capability.grantId,
            generation: capability.generation,
            datasetAuth,
            requireSession: () => {
              requireFreshLinkRead(capabilityToken, capability);
            },
          });
        }
        const actor = await resolveActor(
          request,
          route.route === "work-references" ? route.workspaceId : "",
        );
        return await respond(request, route, { kind: "user", userId: actor.userId });
      }
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
      if (
        route.route === "agent-clients" ||
        route.route === "agent-authorizations" ||
        route.route === "agent-token" ||
        route.route === "agent-introspect"
      ) {
        return await respondToAgentSignIn(request, route);
      }
      if (route.route === "agent-chat") {
        return await respondToAgentChat(request, route);
      }
      if (route.route === "personal-agent-tools") {
        return await respondToPersonalAgentTools(request, route);
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
        if (
          request.headers.has("cookie") ||
          request.headers.has("x-dohc-dataset-grant") ||
          !/^Bearer [^\s]+$/.test(authorization ?? "")
        )
          throw notFound();
        const actor = await resolveActor(
          new Request(request.url, {
            headers: { authorization: authorization! },
            signal: request.signal,
          }),
          "",
        );
        const granted = requireShareAction(route.shareId, actor.userId, "read");
        if (
          granted.grant.principalKind !== "user" ||
          granted.grant.principalUserId !== actor.userId
        )
          throw notFound();
        const auth = {
          kind: "named" as const,
          workspaceId: granted.share.workspaceId,
          userId: actor.userId,
          grantId: granted.grant.grantId,
        };
        const fingerprint = datasetHost!.offlineAccessFingerprint(auth);
        const response = await respondToDataset(
          request,
          {
            route: "dataset",
            workspaceId: granted.share.workspaceId,
            datasetId: route.datasetId,
            action: route.action,
            named: true,
          },
          auth,
        );
        const currentFingerprint = datasetHost!.offlineAccessFingerprint(auth);
        if (fingerprint !== currentFingerprint) {
          await response.body?.cancel();
          return Response.json(
            { message: "Collection access changed. Refresh the Collection." },
            {
              status: 409,
              headers: { "cache-control": "no-store", "x-dohc-dataset-access": currentFingerprint },
            },
          );
        }
        response.headers.set("x-dohc-dataset-access", fingerprint);
        return response;
      }
      if (route.route === "dataset" || route.route === "dataset-replica") {
        if (!respondToDataset) throw notFound();
        const authorization = request.headers.get("authorization");
        if (request.headers.has("cookie") || !/^Bearer [^\s]+$/.test(authorization ?? ""))
          throw notFound();
        const actor = await resolveActor(
          new Request(request.url, {
            headers: { authorization: authorization! },
            signal: request.signal,
          }),
          route.workspaceId,
        );
        if (actor.workspaceId !== route.workspaceId) throw notFound();
        const grant = request.headers.get("x-dohc-dataset-grant");
        if (route.route === "dataset" && route.action === "export") {
          if (
            !respondToDatasetExport ||
            grant !== null ||
            !route.datasetId ||
            new URL(request.url).search
          )
            throw notFound();
          return respondToDatasetExport(
            request,
            { workspaceId: route.workspaceId, datasetId: route.datasetId, action: "export" },
            { kind: "named", workspaceId: route.workspaceId, userId: actor.userId },
          );
        }
        if (route.route === "dataset-replica") {
          if (!respondToDatasetReplica || grant !== null) throw notFound();
          return await respondToDatasetReplica(request, route, {
            kind: "named",
            workspaceId: route.workspaceId,
            userId: actor.userId,
          });
        }
        return await respondToDataset(
          request,
          route,
          {
            kind: "named",
            workspaceId: route.workspaceId,
            userId: actor.userId,
            ...(grant === null ? {} : { grantId: parseShareId(grant) }),
          },
          fromDesktop(request, actor.userId),
        );
      }
      if (route.route === "member-apps") {
        if (!respondToMemberApps) throw notFound();
        const authorization = request.headers.get("authorization");
        if (request.headers.has("cookie") || !/^Bearer [^\s]+$/.test(authorization ?? ""))
          throw notFound();
        const actor = await resolveNamedActor(
          new Request(request.url, {
            headers: { authorization: authorization! },
            signal: request.signal,
          }),
          route.workspaceId,
        );
        if (actor.workspaceId !== route.workspaceId) throw notFound();
        return await respondToMemberApps(request, route, actor.userId);
      }
      if (route.route === "owner-app-publication" || route.route === "owner-app-responses") {
        const authorization = request.headers.get("authorization");
        if (request.headers.has("cookie") || !/^Bearer [^\s]+$/.test(authorization ?? ""))
          throw notFound();
        // Owner publication uses explicit desktop/agent credentials, never ambient browser cookies.
        const actor = await resolveActor(
          new Request(request.url, {
            headers: { authorization: authorization! },
            signal: request.signal,
          }),
          route.workspaceId,
        );
        if (actor.workspaceId !== route.workspaceId) throw notFound();
        if (route.route === "owner-app-responses")
          return readOwnerAppResponses(request, route, actor.userId, storage);
        const answer = await respondToOwnerAppPublication(
          request,
          route,
          actor.userId,
          fromDesktop(request, actor.userId),
        );
        // Withdrawing, reactivating, and changing Collection approval each move the authority revision.
        if (answer.ok && "publicationId" in route && route.action !== "read")
          for (const scope of [{ userId: actor.userId }, { joined: true as const }])
            phoneApps.end({
              ...scope,
              workspaceId: route.workspaceId,
              publicationId: route.publicationId,
            });
        return answer;
      }
      if (route.route === "app-backend") {
        if (!respondToDatasetApp) throw notFound();
        if (!route.workspaceId) {
          if (!appPublicationLimits || !linkKey || request.headers.has("cookie")) throw notFound();
          const { capability } =
            route.action === "events"
              ? requireLinkRead(request, linkLogReadRateLimiter, linkGrantLogReadRateLimiter)
              : requireLinkCapability(request);
          const secret = request.headers.get("x-dohc-link-profile-secret");
          if (!secret || !LINK_SECRET_PATTERN.test(secret)) throw notFound();
          const auth = {
            kind: "link" as const,
            capabilityHash: capability.session.capabilityHash,
            profileTokenHash: hashLinkProfileSecret(secret, linkKey),
          };
          return await respondToDatasetApp(request, route, auth);
        }
        const launchId = request.headers.get("x-dohc-app-launch");
        if (route.action === "redeem" || launchId !== null) {
          if (!fromShareWeb(request)) throw notFound();
          const scope = { workspaceId: route.workspaceId, publicationId: route.publicationId };
          if (route.action === "redeem") {
            if (launchId !== null) throw notFound();
            return await phoneApps.redeem(request, scope);
          }
          // A phone launch reaches its own app's bundle and backend, never activation, the share summary or consent.
          if (
            route.action === "activate" ||
            route.action === "summary" ||
            route.action === "consent"
          )
            throw notFound();
          const { userId, guard } = await phoneApps.authorizeLaunch(launchId!, scope);
          limitAppEvents(route, userId);
          // The guard goes with the request: rechecked after its body, and inside each commit.
          const answer = await respondToDatasetApp(
            request,
            route,
            { kind: "named", workspaceId: route.workspaceId, userId, launch: guard },
            true,
          );
          // The backend's work may have waited, so its answer goes back only while the launch still holds.
          try {
            await guard.recheck();
          } catch (error) {
            await answer.body?.cancel().catch(() => {});
            throw error;
          }
          return answer;
        }
        const authorization = request.headers.get("authorization");
        let actorRequest: Request;
        if (request.headers.has("cookie")) {
          // Browser account authority is accepted only through the trusted viewer.
          if (
            authorization ||
            !shareWebOrigin ||
            !relayExchangeKeyHash ||
            request.headers.get("origin") !== shareWebOrigin ||
            !hasValidRelayExchangeKey(request)
          )
            throw notFound();
          actorRequest = request;
        } else {
          if (!/^Bearer [^\s]+$/.test(authorization ?? "")) throw notFound();
          actorRequest = new Request(request.url, {
            headers: { authorization: authorization! },
            signal: request.signal,
          });
        }
        const actor = await resolveNamedActor(actorRequest, route.workspaceId);
        if (actor.workspaceId !== route.workspaceId) throw notFound();
        limitAppEvents(route, actor.userId);
        const person =
          route.action === "consent" &&
          actorRequest === request &&
          resolveAccountSession !== undefined &&
          (await resolveAccountSession(
            new Request(request.url, {
              headers: { cookie: request.headers.get("cookie")! },
              signal: request.signal,
            }),
          ).then(
            (session) => session.clientKind === "browser" && session.userId === actor.userId,
            () => false,
          ));
        const sessionResolver = resolvePhoneCapableAccountSession ?? resolveAccountSession;
        const desktop =
          route.action === "activate" &&
          !!sessionResolver &&
          (await bearerAccountSession(storage, sessionResolver, actorRequest).then(
            (session) => session.clientKind === "desktop" && session.userId === actor.userId,
            () => false,
          ));
        const auth = {
          kind: "named" as const,
          workspaceId: route.workspaceId,
          userId: actor.userId,
          ...(person ? { person: true as const } : {}),
          ...(desktop ? { device: "desktop" as const } : {}),
        };
        const signedIn = async () => {
          const again = await resolveActor(actorRequest, actor.workspaceId);
          if (again.workspaceId !== actor.workspaceId || again.userId !== actor.userId)
            throw notFound();
        };
        return await respondToDatasetApp(request, route, auth, false, signedIn);
      }
      if (route.route === "link-app-publication")
        return respondToLinkAppPublication(request, route);
      if (route.route === "link-app-collection")
        return await respondToLinkAppCollection(request, route);
      if (route.route === "automation-presses") {
        // Desktop and agent credentials only, never ambient browser cookies.
        const authorization = request.headers.get("authorization");
        if (request.headers.has("cookie") || !/^Bearer [^\s]+$/.test(authorization ?? ""))
          throw notFound();
        const actor = await resolveActor(
          new Request(request.url, {
            headers: { authorization: authorization! },
            signal: request.signal,
          }),
          route.workspaceId,
        );
        if (actor.workspaceId !== route.workspaceId) throw notFound();
        return await automationPresses.respondToHost(request, route, actor.userId);
      }
      if (route.route === "held-documents") {
        // Desktop and agent credentials only, never ambient browser cookies.
        const authorization = request.headers.get("authorization");
        if (request.headers.has("cookie") || !/^Bearer [^\s]+$/.test(authorization ?? ""))
          throw notFound();
        const actor = await resolveActor(
          new Request(request.url, {
            headers: { authorization: authorization! },
            signal: request.signal,
          }),
          route.workspaceId,
        );
        if (actor.workspaceId !== route.workspaceId) throw notFound();
        return await respondToHeldDocuments(request, route, actor.userId);
      }
      if (route.route === "live-pauses" || route.route === "live-notes") {
        // Desktop and agent credentials only, never ambient browser cookies.
        const authorization = request.headers.get("authorization");
        if (request.headers.has("cookie") || !/^Bearer [^\s]+$/.test(authorization ?? ""))
          throw notFound();
        const actor = await resolveActor(
          new Request(request.url, {
            headers: { authorization: authorization! },
            signal: request.signal,
          }),
          route.workspaceId,
        );
        if (actor.workspaceId !== route.workspaceId) throw notFound();
        return route.route === "live-notes"
          ? respondToLiveNotes(request, route, actor.userId)
          : await respondToLivePauses(request, route, actor.userId);
      }
      if (route.route === "automation-host") {
        // Desktop and agent credentials only, never ambient browser cookies.
        const authorization = request.headers.get("authorization");
        if (request.headers.has("cookie") || !/^Bearer [^\s]+$/.test(authorization ?? ""))
          throw notFound();
        const actor = await resolveActor(
          new Request(request.url, {
            headers: { authorization: authorization! },
            signal: request.signal,
          }),
          route.workspaceId,
        );
        if (actor.workspaceId !== route.workspaceId) throw notFound();
        return await respondToAutomationHost(request, route, actor.userId);
      }
      if (route.route === "automation-server") {
        // Desktop and agent credentials only, never ambient browser cookies.
        const authorization = request.headers.get("authorization");
        if (request.headers.has("cookie") || !/^Bearer [^\s]+$/.test(authorization ?? ""))
          throw notFound();
        const actor = await resolveActor(
          new Request(request.url, {
            headers: { authorization: authorization! },
            signal: request.signal,
          }),
          route.workspaceId,
        );
        if (actor.workspaceId !== route.workspaceId) throw notFound();
        let recheckDesktopHttpApproval: (() => Promise<void>) | undefined;
        if (route.action === "allow") {
          const sessionResolver = resolvePhoneCapableAccountSession ?? resolveAccountSession;
          if (sessionResolver) {
            const verifyDesktopOwnerSession = async () => {
              const session = await bearerAccountSession(storage, sessionResolver, request);
              if (
                session.clientKind !== "desktop" ||
                session.userId !== actor.userId ||
                workspaceIsDeleted(storage, route.workspaceId) ||
                !storage.workspaceIsOwnedBy(route.workspaceId, session.userId)
              ) {
                throw notFound();
              }
              return session;
            };
            try {
              const initialDesktopSession = await verifyDesktopOwnerSession();
              recheckDesktopHttpApproval = async () => {
                const current = await verifyDesktopOwnerSession();
                if (current.sessionId !== initialDesktopSession.sessionId) {
                  throw notFound();
                }
              };
            } catch {
              recheckDesktopHttpApproval = undefined;
            }
          }
        }
        return await respondToAutomationServer(request, route, actor.userId, {
          ...(recheckDesktopHttpApproval ? { recheckDesktopHttpApproval } : {}),
        });
      }
      if (route.route === "account-workspaces" || route.route === "account-workspace") {
        if (!respondToAccountWorkspaces) throw notFound();
        return await respondToAccountWorkspaces(request, route);
      }
      if (route.route === "account-sessions" || route.route === "account-session-revoke") {
        if (!respondToAccountSessions) throw notFound();
        return await respondToAccountSessions(request, route);
      }
      if (route.route === "account-operation") {
        if (!respondToAccountOperation) throw notFound();
        return await respondToAccountOperation(request, route);
      }
      const bearerActor = async (workspaceId: string) => {
        const authorization = request.headers.get("authorization");
        if (request.headers.has("cookie") || !/^Bearer [^\s]+$/.test(authorization ?? ""))
          throw notFound();
        return await resolveActor(
          new Request(request.url, {
            headers: { authorization: authorization! },
            signal: request.signal,
          }),
          workspaceId,
        );
      };
      if (isDirectMessageRoute(route)) {
        return await respondToDirectMessages(request, route, await bearerActor(""));
      }
      if (
        route.route === "chat-runners" ||
        route.route === "chat-wakes" ||
        route.route === "chat-wake"
      ) {
        if (!respondToChatWakes) throw notFound();
        return await respondToChatWakes(request, route);
      }
      if (route.route === "notices" || route.route === "notice-marks") {
        // Desktop and agent credentials only, never ambient browser cookies. A read with `scope` or `wait` takes the account session itself.
        return await respondToNotices(request, route, async () => {
          const authorization = request.headers.get("authorization");
          if (request.headers.has("cookie") || !/^Bearer [^\s]+$/.test(authorization ?? ""))
            throw notFound();
          const actor = await resolveActor(
            new Request(request.url, {
              headers: { authorization: authorization! },
              signal: request.signal,
            }),
            "",
          );
          return actor.userId;
        });
      }
      if (route.route === "personal-agents" || route.route === "personal-agent") {
        // The account's own Bearer sign-in, never ambient browser cookies. A phone may list,
        // sign out, remove and restore agents, but never change what one reaches or how it shows.
        if (!resolvePhoneCapableAccountSession) throw notFound();
        const session = await bearerAccountSession(
          storage,
          resolvePhoneCapableAccountSession,
          request,
        );
        if (
          session.clientKind === "phone" &&
          route.route === "personal-agent" &&
          (route.action === "reach" || route.action === "name" || route.action === "hue")
        )
          throw notFound();
        return await personalAgents.respondToOwner(request, route, session.userId);
      }
      if (route.route === "workspace-name") {
        // The account's own credential only, never ambient browser cookies.
        const authorization = request.headers.get("authorization");
        if (request.headers.has("cookie") || !/^Bearer [^\s]+$/.test(authorization ?? ""))
          throw notFound();
        const actor = await resolveActor(
          new Request(request.url, {
            headers: { authorization: authorization! },
            signal: request.signal,
          }),
          route.workspaceId,
        );
        return await respondToWorkspaceName(storage, request, route.workspaceId, actor.userId);
      }
      if (
        route.route === "workspace-secrets" ||
        route.route === "workspace-secret" ||
        route.route === "workspace-http-approvals" ||
        route.route === "workspace-outbound-dispatch" ||
        route.route === "workspace-webhooks" ||
        route.route === "workspace-webhook" ||
        route.route === "workspace-webhook-rotate"
      ) {
        const sessionResolver = resolvePhoneCapableAccountSession ?? resolveAccountSession;
        if (!sessionResolver) throw notFound();
        const authorizeDesktopOwner = async () => {
          const session = await bearerAccountSession(storage, sessionResolver, request);
          if (session.clientKind !== "desktop") throw notFound();
          if (
            workspaceIsDeleted(storage, route.workspaceId) ||
            !storage.workspaceIsOwnedBy(route.workspaceId, session.userId)
          ) {
            throw notFound();
          }
          return session;
        };
        const session = await authorizeDesktopOwner();
        const recheckSession = async () => {
          const current = await authorizeDesktopOwner();
          if (current.userId !== session.userId || current.sessionId !== session.sessionId) {
            throw notFound();
          }
        };
        if (route.route === "workspace-secrets" || route.route === "workspace-secret") {
          return await respondToWorkspaceSecrets(request, route, session.userId, recheckSession);
        }
        if (
          route.route === "workspace-webhooks" ||
          route.route === "workspace-webhook" ||
          route.route === "workspace-webhook-rotate"
        ) {
          return await incomingWebhooks.respondToOwnerManagement(
            request,
            route,
            session.userId,
            recheckSession,
          );
        }
        return await respondToOutboundWebhooks(request, route, session.userId, recheckSession);
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

      // People join and leave a workspace share through its members routes.
      // The generic share changes would end, restore, copy, or link a member
      // grant behind the membership's back. Only the owner may make them, so
      // anyone else gets their usual 404 and learns nothing about the share.
      if (MEMBERSHIP_MANAGED_SHARE_ROUTES.has(route.route) && "shareId" in route) {
        const stored = storage.getShare(route.shareId);
        const selector =
          stored?.granterUserId === actor.userId
            ? parseStoredAnyShareSelectorJson(stored.selectorJson)
            : null;
        if (selector && "kind" in selector && selector.kind === "workspace")
          throw relayError("workspace_share_managed");
      }

      if (
        route.route === "shares-list" ||
        route.route === "share" ||
        route.route === "share-access" ||
        route.route === "share-copy"
      ) {
        return await respondToShareInventory(request, route, actor);
      }

      if (
        route.route === "share-link-rotate" ||
        route.route === "share-link-retune" ||
        route.route === "share-grant-promote" ||
        route.route === "share-grant-retune" ||
        route.route === "share-grant-revoke" ||
        route.route === "share-grant-invitation-email" ||
        route.route === "share-undo" ||
        route.route === "share-leave" ||
        route.route === "share-revoke"
      ) {
        return await respondToShareGrantTransition(request, route, actor);
      }

      if (route.route === "share-link-agents" || route.route === "share-link-agent-disconnect") {
        return respondToLinkAgents(request, route, actor);
      }

      if (route.route === "share-log" || route.route === "share-blob") {
        return await respondToNamedShareTransport(request, route, actor);
      }

      if (route.route === "share-proposals" || route.route === "share-proposal-withdraw") {
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

      // Members routes check the caller's role themselves. They sit before
      // the ownership check below, which stays owner-only.
      if (isWorkspaceMemberRoute(route)) {
        return await respondToWorkspaceMembers(request, route, actor);
      }

      if (!storage.workspaceIsOwnedBy(route.workspaceId, actor.userId)) throw notFound();

      if (route.route === "owner-collection-writes")
        return readOwnerCollectionWrites(request, route, actor.userId, storage);

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
    linkAuthority,
    personalAgents,
    personalLimiter: linkReadRateLimiter,
    dispose() {
      accountFeedWaits.close();
      appEventWaits?.close();
      chatWakeWaits.close();
      noticeWaits.close();
      return personalAgents.dispose();
    },
    endPhoneAppLaunches: (scope: PhoneAppLaunchScope) => phoneApps.end(scope),
    deleteAccount(userId: string, workspaceIds: readonly string[], shareIds: readonly string[]) {
      // Held reads check the fenced account now.
      wakeAccountWaits(userId);
      personalAgents.deleteAccount(userId);
      presence.deleteAccount(userId, workspaceIds);
      deletePresenceAccount(userId);
      namedBrowser?.deleteAccount(userId, workspaceIds);
      for (const shareId of shareIds) terminateLinkStreamsForShare(shareId);
    },
    resolveNamedBrowserSession: (request: Request, discriminator: string) =>
      namedBrowser?.resolve(request, discriminator) ?? Promise.resolve(null),
    namedBrowserSessions: namedBrowser?.sessions,
    /**
     * A GET of the owner's share listings, answered in process as the
     * routes answer the owner, so the server's automations find a
     * workspace's editors the way the owner's computers do. Only
     * `/sync/shares` and `/sync/:workspaceId/shares/links` are served.
     */
    readOwnerShares,
    executeOutboundWebhook: (input: {
      readonly workspaceId: string;
      readonly ownerUserId: string;
      readonly request: OutboundWebhookDispatchRequest;
      readonly signal?: AbortSignal;
    }) => executeRelayOutboundWebhook(outboundWebhookDeps, input),
  });
}

// Headroom over the blob cap so a maximal valid blob PUT still passes.
export const MAX_BODY_BYTES = MAX_BLOB_BYTES + 1024 * 1024;
const DEFAULT_BODY_BYTES = 256 * 1024;

/**
 * The largest body each route's handler reads. The adapter refuses a larger
 * one before the handler runs. Paths outside `parseRoute`, such as a hosted
 * replica's feed and the live session routes, keep the largest cap and bound
 * their own bodies.
 */
export function maxRequestBodyBytes(url: URL): number {
  let route: ReturnType<typeof parseRoute>;
  try {
    route = parseRoute({ url: url.href });
  } catch {
    return MAX_BODY_BYTES;
  }
  switch (route.route) {
    case "log":
    case "blob":
    case "share-log":
    case "share-blob":
    case "share-proposals":
      return MAX_BODY_BYTES;
    case "dataset":
      return Math.max(datasetRequestBytes(route.action, true), DEFAULT_BODY_BYTES);
    case "named-dataset":
    case "app-backend":
      if (
        route.route === "app-backend" &&
        route.workspaceId !== undefined &&
        route.action === "invoke"
      )
        return APP_BACKEND_BULK_LIMITS.requestBytes;
      return route.action === "upload" ? APP_BACKEND_UPLOAD_REQUEST_BYTES : DEFAULT_BODY_BYTES;
    case "dataset-replica":
      return datasetReplicaRequestBytes(route.action);
    case "member-apps":
      return route.action === "apps" ? MEMBER_APP_UPLOAD_BYTES : DEFAULT_BODY_BYTES;
    // Its handler reserves the link's bytes before reading, so the body arrives first.
    case "link-app-collection":
      return APP_COLLECTION_REQUEST_BYTES;
    // Up to 100 paths of up to 1,024 characters each.
    case "shares-create":
    case "share-link-create-atomic":
      return 1024 * 1024;
    case "workspace-secret":
      return WORKSPACE_SECRET_MAX_BODY_BYTES;
    case "workspace-http-approvals":
      return MAX_HTTP_APPROVAL_BODY_BYTES;
    case "workspace-outbound-dispatch":
      return MAX_OUTBOUND_DISPATCH_BODY_BYTES;
    case "account-operation":
      return route.operation === "collectionAttachmentUpload"
        ? APP_BACKEND_UPLOAD_REQUEST_BYTES
        : route.operation === "uploadFile"
          ? UPLOAD_FILE_MAX_BODY_BYTES
          : route.operation === "saveSketch"
            ? SAVE_SKETCH_MAX_BODY_BYTES
            : DEFAULT_BODY_BYTES;
    case "workspace-webhooks":
    case "workspace-webhook":
    case "workspace-webhook-rotate":
      return MAX_INCOMING_WEBHOOK_ADMIN_BODY_BYTES;
    default:
      return DEFAULT_BODY_BYTES;
  }
}

const SESSION_COOKIE = /(?:^|;)\s*(?:__Secure-)?better-auth\.session_token\s*=([^;]*)/gu;

/**
 * The one credential a request presents, which keys its share of bodies in
 * flight. A request that presents an `Authorization` header and a session
 * cookie, or two session cookies, could vary the one its handler ignores, so
 * it shares the client address's share with every request that presents none.
 * Anyone with a link can mint capabilities, so all of them share one share.
 */
export function requestBodyCaller(headers: Headers): string {
  const authorization = headers.get("authorization");
  if (authorization?.startsWith("LinkCapability ")) return "link";
  const cookies = [...(headers.get("cookie") ?? "").matchAll(SESSION_COOKIE)];
  if (authorization !== null && cookies.length === 0) {
    const bearer = /^bearer (.*)$/iu.exec(authorization)?.[1]?.trim();
    // The relay's own credentials, such as a service host's, are whole values.
    if (!bearer || bearer.startsWith("dohc-")) return `authorization ${authorization}`;
    return `session ${sessionToken(bearer)}`;
  }
  if (authorization === null && cookies.length === 1) {
    // Read as better-auth reads a cookie value: trimmed and unquoted.
    const value = cookies[0]![1]!.trim();
    return `session ${sessionToken(value.startsWith('"') ? value.slice(1, -1) : value)}`;
  }
  return `address ${headers.get("x-dohc-relay-client-ip") ?? ""}`;
}

// A session token is also accepted signed, as `token.signature`, and encoded.
function sessionToken(value: string): string {
  let decoded = value;
  try {
    decoded = decodeURIComponent(value);
  } catch {}
  return decoded.split(".", 1)[0]!;
}

/**
 * The routes whose handlers authenticate before they read the body, and bound
 * its size and receipt time: recovery imports, direct writes, a personal
 * agent's included, an account's reads through this server's copies, and Notice marks. Classified by
 * the same parse as dispatch, so every spelling of the path streams.
 */
export function streamsRequestBody(url: URL, method: string): boolean {
  try {
    const route = parseRoute({ url: url.href });
    return (
      (route.route === "dataset" && route.action === "import" && method === "POST") ||
      (route.route === "incoming-webhook" && method === "POST") ||
      route.route === "share-collection-writes" ||
      route.route === "link-collection-writes" ||
      route.route === "account-operation" ||
      (route.route === "notice-marks" && method === "POST") ||
      (route.route === "member-apps" && route.action === "apps" && method === "POST") ||
      (route.route === "personal-agent-tools" && route.action === "collection-writes")
    );
  } catch {
    return false;
  }
}
