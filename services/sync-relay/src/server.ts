import {parsePublicEditRelease, type PublicEditRelease} from "@dohc/security-contract";
import type { AppPublicationLimits } from "@dohc/security-contract/app-publication";
import { createAppBackendRoutes, type AppBackendRoute } from "./appBackendRoutes";
import type { AppBackendAdmissionLimits } from "./appBackendAdmission";
import { createDatasetAppRoutes, createDatasetRoutes, type DatasetRoute } from "./datasetRoutes";
import type { RelayDatasetHost } from "./datasetHost";
import { hashLinkProfileSecret } from "./linkSecurity";
import { LINK_SECRET_PATTERN } from "@dohc/security-contract/wire-patterns";
import { createOwnerAppPublicationRoutes, type OwnerAppPublicationRoute } from "./ownerAppPublicationRoutes";
import {readOwnerAppResponses,type OwnerAppResponseRoute} from "./ownerAppResponseRoutes";
import { createLinkAppPublicationRoutes, type LinkAppPublicationRoute } from "./linkAppPublicationRoutes";
import { createLinkAppCollectionRoutes, type LinkAppCollectionRoute, type AppCollectionPolicy } from "./appCollectionRoutes";
import {createNamedRecipientDocuments} from "./namedRecipientDocuments";
import { TokenBucketLimiter } from "@dohc/service-http";
import { createOwnerRestoreRoutes, type OwnerRestoreHost, type OwnerRestoreRoute } from "./ownerRestoreRoutes";
import { randomUUID } from "node:crypto";
import { createNamedLiveBrowserHttp, type NamedLiveBrowserHttpLimits } from "./namedLiveBrowserHttp";
import { MAX_SHARE_PROPOSAL_OPS } from "@dohc/security-contract/share-proposal-bound";
import type { ResolveActor } from "@dohc/workspace-auth/session";
import { createNamedShareTransportRoutes, type NamedShareTransportRoute } from "./namedShareTransportRoutes";
import { createKeyEnvelopeRoutes } from "./keyEnvelopeRoutes";
import { createWorkspaceBlobRoutes, type WorkspaceBlobRoute } from "./workspaceBlobRoutes";
import { createWorkspaceReplicationRoutes, type WorkspaceReplicationRoute } from "./workspaceReplicationRoutes";
import { createLinkResponseStreams } from "./linkResponseStreams";
import { createLinkCredentialRoutes } from "./linkCredentialRoutes";
import { createDiscussionRoutes } from "./discussionRoutes";
import { createShareReadQueries } from "./shareReadQueries";
import { createLinkReadRoutes, type LinkReadRoute } from "./linkReadRoutes";
import { createShareSummaries } from "./shareSummaries";
import { createShareGrantRoutes, type ShareGrantTransitionRoute, type WorkspaceShareCreationRoute } from "./shareGrantRoutes";
import { createShareInventoryRoutes, type ShareInventoryRoute } from "./shareInventoryRoutes";
import {
  hashRelayExchangeKey,
  LinkEgressRateLimiter,
  LINK_EXCHANGE_BUCKET_CAPACITY,
  LINK_EXCHANGE_REFILL_PER_SECOND,
  LINK_EXCHANGE_MAX_IPS,
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
import { createPresenceRoutes } from "./presenceRoutes";
import {
  createProposalRoutes,
  type ShareProposalRoute,
  type WorkspaceProposalRoute,
} from "./proposalRoutes";
import { parseShareId, parseString, parseWorkspaceId } from "./requestInputs";
import type { ShareSelector } from "./shareFilter";
import { type SyncRelayStorage } from "./storage";
import {
  authorizeShareAction,
  type AuthorizedShareAction,
  type ShareAction,
} from "./shareAuthorization";
import { errorResponse, invalidLinkCapability, notFound, relayError } from "./errors";
import { MAX_LOG_PAGE_SIZE, MAX_ORIGIN_ID_CHARS } from "./wireLimits";

export { MAX_BLOB_BYTES, MAX_PAYLOAD_JSON_BYTES } from "./wireLimits";
export { MAX_KEY_ENVELOPE_BYTES } from "./keyEnvelopeRoutes";
export { DISCUSSION_DISPLAY_NAME_LOOKUP_DEADLINE_MS } from "./discussionRoutes";
export { LINK_FRESHNESS_PAGE_BUDGET, MAX_RAW_ROWS_PER_LINK_PAGE } from "./shareReadQueries";

export type SyncRelayHandler = (request: Request) => Promise<Response>;

export interface CreateSyncRelayHandlerOptions {
  appPublicationLimits?: AppPublicationLimits;
  appCollectionPolicy?: AppCollectionPolicy;
  appBackendsEnabled?: boolean;
  appBackendMaxParticipantsPerGrant?: number;
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
  // Relay-instance HMAC key. When absent, every link route refuses without
  // touching storage. main.ts requires it outside development and test.
  linkKey?: string | Uint8Array;
  shareWebOrigin?: string;
  relayExchangeKey?: string;
  namedBrowserSessionLimits?: NamedLiveBrowserHttpLimits;
  publicEditRelease?: PublicEditRelease;
  linkExchangeRateLimiter?: TokenBucketLimiter;
  linkRedeemRateLimiter?: TokenBucketLimiter;
  linkReadRateLimiter?: TokenBucketLimiter;
  linkGrantReadRateLimiter?: TokenBucketLimiter;
  linkLogReadRateLimiter?: TokenBucketLimiter;
  linkGrantLogReadRateLimiter?: TokenBucketLimiter;
  linkGrantEgressRateLimiter?: LinkEgressRateLimiter;
  linkFreshnessPageSize?: number;
  linkCurrentFileLimit?: number;
  newLinkBearer?: () => string;
  newLinkHandoffCode?: () => string;
}

type SyncRelayRoute =
  | AppBackendRoute
  | DatasetRoute
  | LinkAppPublicationRoute
  | LinkAppCollectionRoute
  | OwnerAppPublicationRoute
  | OwnerAppResponseRoute
  | OwnerRestoreRoute
  | { route: "link-exchange" }
  | { route: "link-refresh" }
  | { route: "link-handoff" }
  | { route: "link-redeem" }
  | LinkReadRoute
  | { route: "link-discussion" }
  | { route: "link-discussion-activity" }
  | { route: "workspaces" }
  | WorkspaceBlobRoute
  | WorkspaceReplicationRoute
  | { route: "keys"; workspaceId: string }
  | WorkspaceShareCreationRoute
  | ShareInventoryRoute
  | ShareGrantTransitionRoute
  | NamedShareTransportRoute
  | { route: "share-discussion"; shareId: string }
  | { route: "share-discussion-activity"; shareId: string }
  | { route: "share-discussion-moderation"; shareId: string }
  | ShareProposalRoute
  | WorkspaceProposalRoute
  | { route: "presence"; workspaceId: string }
  | { route: "share-presence"; shareId: string };

const MAX_LINK_CURRENT_FILES = 5_000;

export function createSyncRelayHandler({
  appPublicationLimits,
  appCollectionPolicy,
  appBackendsEnabled = false,
  appBackendMaxParticipantsPerGrant,
  appBackendAdmissionLimits,
  datasetHost,
  ownerRestoreHost = () => undefined,
  storage,
  resolveActor,
  nowMs = () => Date.now(),
  resolveUserIdByEmail,
  lookupVerifiedUserEmail,
  lookupUserEmail,
  lookupUserDisplayName,
  newShareId = () => randomUUID(),
  newGrantId = () => randomUUID(),
  newId = () => randomUUID(),
  presence = new PresenceHub(),
  discussionActivity = new DiscussionActivityHub(),
  linkKey,
  shareWebOrigin,
  relayExchangeKey,
  namedBrowserSessionLimits,
  publicEditRelease: releaseInput,
  linkExchangeRateLimiter = new TokenBucketLimiter(LINK_EXCHANGE_BUCKET_CAPACITY, LINK_EXCHANGE_REFILL_PER_SECOND, LINK_EXCHANGE_MAX_IPS),
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
  linkFreshnessPageSize = MAX_LOG_PAGE_SIZE,
  linkCurrentFileLimit = MAX_LINK_CURRENT_FILES,
  newLinkBearer = () => mintLinkBearer(),
  newLinkHandoffCode = () => mintLinkHandoffCode(),
}: CreateSyncRelayHandlerOptions): SyncRelayHandler & {
  resolveNamedBrowserSession: ReturnType<typeof createNamedLiveBrowserHttp>["resolve"];
} {
  const publicEditRelease = parsePublicEditRelease(releaseInput);
  if (appBackendsEnabled && !appPublicationLimits) throw new TypeError("App backends require app publications.");
  const respondToAppBackend = appBackendsEnabled ? createAppBackendRoutes(
    storage.createAppBackendHost({limits: appPublicationLimits!, nowMs, maxParticipantsPerGrant:appBackendMaxParticipantsPerGrant}), storage.unavailable,
    {limits: appBackendAdmissionLimits, nowMs},
  ) : undefined;
  const respondToDataset = datasetHost ? createDatasetRoutes(datasetHost, storage, {limits: appBackendAdmissionLimits, nowMs}) : undefined;
  const respondToDatasetApp = datasetHost ? createDatasetAppRoutes(datasetHost, storage, {limits: appBackendAdmissionLimits, nowMs}) : undefined;
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
    resolveActor: resolveNamedActor, maxFiles: linkCurrentFileLimit,
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
  } = createShareReadQueries(storage, linkFreshnessPageSize);

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
    if (result.reason === "denied" && (action === "append" || action === "propose")) {
      throw relayError("share_read_only");
    }
    throw notFound();
  }

  const { respondToSharePresence, respondToWorkspacePresence } = createPresenceRoutes(
    presence,
    nowMs,
    storage,
    claimPendingShares,
    requireShareAction,
    chatResolverFor,
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
  );

  const respondToWorkspaceBlobs = createWorkspaceBlobRoutes(
    storage,
    nowMs,
  );

  const respondToKeyEnvelopes = createKeyEnvelopeRoutes(
    storage,
    nowMs,
  );

  const respondToNamedShareTransport = createNamedShareTransportRoutes(
    storage,
    nowMs,
    claimPendingShares,
    requireShareAction,
    shareActionGuard,
    filteredLogPage,
    historicalSharedBlob,
    discussionActivity,
  );

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

  const {
    grantedShareSummary,
    receivedShareSummary,
    linkGrantBody,
    namedGrantTransitionBody,
    dependentGrantSummary,
    independentGrantSummary,
    linkInventorySummary,
    namedBrowserInvitation,
  } = createShareSummaries(lookupUserEmail, namedBrowser ? shareWebOrigin : undefined);

  const { respondToShareInventory, respondToWorkspaceLinkInventory } = createShareInventoryRoutes(
    storage,
    claimPendingShares,
    lookupUserEmail,
    requireShareAction,
    grantedShareSummary,
    receivedShareSummary,
    independentGrantSummary,
    linkInventorySummary,
    publicEditRelease,
  );

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
      capabilityToken,
      linkKey,
      nowMs: nowMs(),
    });
    if (!capability) throw invalidLinkCapability();
    return {capabilityToken, capability};
  };
  const requireLinkRead = (
    request: Request,
    capabilityRateLimiter: TokenBucketLimiter,
    grantRateLimiter: TokenBucketLimiter,
  ) => {
    const {capabilityToken, capability} = requireLinkCapability(request);
    const admittedAtMs = nowMs();
    if (
      !capabilityRateLimiter.allow(
        capability.session.capabilityHash,
        admittedAtMs,
      ) || !grantRateLimiter.allow(capability.grantId, admittedAtMs)
    ) {
      throw relayError("link_read_rate_limited");
    }
    return { capabilityToken, capability };
  };

  const requireFreshLinkRead = (
    capabilityToken: string,
    expected: { shareId: string; grantId: string; generation: number },
  ) => {
    if (!linkKey) throw invalidLinkCapability();
    const fresh = validateLinkCapability({
      storage,
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
    publicEditRelease,
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
    linkRedeemRateLimiter,
    linkReadRateLimiter,
    linkGrantReadRateLimiter,
    publicEditRelease,
  );

  const respondToLinkRead = createLinkReadRoutes(
    storage,
    nowMs,
    linkCurrentFileLimit,
    requireLinkRead,
    requireFreshLinkRead,
    linkJsonResponse,
    filteredLogPage,
    newestFilteredOpFreshness,
    linkReadRateLimiter,
    linkGrantReadRateLimiter,
    linkLogReadRateLimiter,
    linkGrantLogReadRateLimiter,
    linkGrantEgressRateLimiter,
    discussionActivity,
    admitLinkBlobBytes,
    respondWithLinkBytes,
  );

  const respondToOwnerRestore = createOwnerRestoreRoutes({storage, host: ownerRestoreHost, nowMs, newId});
  const respondToOwnerAppPublication = createOwnerAppPublicationRoutes({storage, limits: appPublicationLimits, collectionsEnabled: appCollectionPolicy !== undefined, nowMs});
  const respondToLinkAppPublication = createLinkAppPublicationRoutes({storage, limits: appPublicationLimits, linkKey: linkKey!, publicEditRelease, nowMs,
    requireLinkRead, capabilityLimiter: linkReadRateLimiter, grantLimiter: linkGrantReadRateLimiter,
    egress: linkGrantEgressRateLimiter, streams: {admitLinkBlobBytes, respondWithLinkBytes}});
  const respondToLinkAppCollection = createLinkAppCollectionRoutes({storage,limits:appPublicationLimits,policy:appCollectionPolicy,linkKey:linkKey!,publicEditRelease,nowMs,
    requireLinkRead,capabilityLimiter:linkReadRateLimiter,grantLimiter:linkGrantReadRateLimiter,egress:linkGrantEgressRateLimiter,streams:{admitLinkBlobBytes,respondWithLinkBytes}});
  const handle: SyncRelayHandler = async (request) => {
    try {
      const pathname = new URL(request.url).pathname;
      if (pathname === "/sync/live/named-sessions" || pathname === "/sync/live/named-sessions/resolve") {
        return namedBrowser ? await namedBrowser(request) : errorResponse(notFound());
      }
      if (pathname === "/sync/live/named-documents") {
        return namedDocuments ? await namedDocuments(request) : errorResponse(notFound());
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
      if (route.route === "dataset") {
        if (!respondToDataset) throw notFound();
        const authorization = request.headers.get("authorization");
        if (request.headers.has("cookie") || !/^Bearer [^\s]+$/.test(authorization ?? "")) throw notFound();
        const actor = await resolveActor(new Request(request.url, {headers: {authorization: authorization!}, signal: request.signal}), route.workspaceId);
        if (actor.workspaceId !== route.workspaceId) throw notFound();
        const grant = request.headers.get("x-dohc-dataset-grant");
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
        if (!respondToAppBackend) throw notFound();
        if (!route.workspaceId) {
          if (!linkKey || request.headers.has("cookie")) throw notFound();
          const {capability} = requireLinkCapability(request);
          const secret = request.headers.get("x-dohc-link-profile-secret");
          if (!secret || !LINK_SECRET_PATTERN.test(secret)) throw notFound();
          const auth = {kind:"link" as const, capabilityHash:capability.session.capabilityHash,
            profileTokenHash:hashLinkProfileSecret(secret, linkKey)};
          if (respondToDatasetApp) { const datasetResponse = await respondToDatasetApp(request, route, auth); if (datasetResponse) return datasetResponse; }
          return await respondToAppBackend(request, route, auth);
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
        if (respondToDatasetApp) { const datasetResponse = await respondToDatasetApp(request, route, auth); if (datasetResponse) return datasetResponse; }
        return await respondToAppBackend(request, route, auth);
      }
      if (route.route === "link-app-publication") return respondToLinkAppPublication(request, route);
      if (route.route === "link-app-collection") return await respondToLinkAppCollection(request, route);
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

      if (route.route === "shares-list" || route.route === "share") {
        return await respondToShareInventory(request, route, actor);
      }

      if (
        route.route === "share-link-rotate" ||
        route.route === "share-link-retune" ||
        route.route === "share-grant-promote" ||
        route.route === "share-grant-revoke" ||
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

      if (route.route === "share-presence") {
        return await respondToSharePresence(request, route.shareId, actor.userId);
      }

      if (!storage.workspaceIsOwnedBy(route.workspaceId, actor.userId)) throw notFound();

      if (route.route === "owner-restore") return await respondToOwnerRestore(request, route, actor.userId);

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
        return await respondToWorkspaceReplication(request, route, actor);
      }

      throw relayError("method_not_allowed");
    } catch (error) {
      return errorResponse(error);
    }
  };
  return Object.assign(handle, {
    resolveNamedBrowserSession: (request: Request, discriminator: string) => namedBrowser?.resolve(request, discriminator) ?? Promise.resolve(null),
  });
}

function parseRoute(request: Request): SyncRelayRoute {
  const parts = new URL(request.url).pathname.split("/").filter(Boolean).map(decodeURIComponent);
  if (parts[0] === "sync" && parts[1] === "link" && parts[2] === "app-publications") {
    if (parts.length === 3) return {route: "link-app-publication"};
    const publicationId = parts[3];
    if (!publicationId || !/^[0-9a-f]{64}$/.test(publicationId)) throw notFound();
    if (parts.length === 4) return {route: "link-app-publication", publicationId};
    if (parts.length === 5 && parts[4] === "collection") return {route: "link-app-collection", publicationId};
    if (parts.length === 6 && parts[4] === "backend" && (parts[5] === "invoke" || parts[5] === "upload" || parts[5] === "file" || parts[5] === "attempt")) {
      return {route:"app-backend", publicationId, action:parts[5]};
    }
    if (parts.length === 6 && parts[4] === "blobs" && /^[0-9a-f]{64}$/.test(parts[5]!)) {
      return {route: "link-app-publication", publicationId, sha256: parts[5]};
    }
    throw notFound();
  }
  if (parts.length === 2 && parts[0] === "sync" && parts[1] === "link-exchange") {
    return { route: "link-exchange" };
  }
  if (parts.length === 2 && parts[0] === "sync" && parts[1] === "link-refresh") {
    return { route: "link-refresh" };
  }
  if (parts.length === 2 && parts[0] === "sync" && parts[1] === "link-handoff") {
    return { route: "link-handoff" };
  }
  if (parts.length === 2 && parts[0] === "sync" && parts[1] === "link-redeem") {
    return { route: "link-redeem" };
  }
  if (parts.length === 3 && parts[0] === "sync" && parts[1] === "link") {
    if (parts[2] === "share") return { route: "link-share" };
    if (parts[2] === "current") return { route: "link-current" };
    if (parts[2] === "log") return { route: "link-log" };
    if (parts[2] === "discussion") return { route: "link-discussion" };
  }
  if (
    parts.length === 4 &&
    parts[0] === "sync" &&
    parts[1] === "link" &&
    parts[2] === "discussion" &&
    parts[3] === "activity"
  ) {
    return { route: "link-discussion-activity" };
  }
  if (
    parts.length === 4 &&
    parts[0] === "sync" &&
    parts[1] === "link" &&
    parts[2] === "blobs"
  ) {
    return { route: "link-blob", sha256: parts[3]! };
  }
  if (parts.length === 2 && parts[0] === "sync" && parts[1] === "workspaces") {
    return { route: "workspaces" };
  }
  if (parts[0] !== "sync" || !parts[1]) throw notFound();
  // "/sync/shares/..." is the share-scoped namespace; "shares" is reserved as
  // a workspace id (parseWorkspaceId) so the two can never collide.
  if (parts[1] === "shares") {
    if (parts.length === 2) return { route: "shares-list" };
    const shareId = parseShareId(parts[2]);
    if (parts.length === 3) return { route: "share", shareId };
    if (parts.length === 4 && parts[3] === "revoke") return { route: "share-revoke", shareId };
    if (parts.length === 6 && parts[3] === "links" && parts[5] === "rotate") {
      return {
        route: "share-link-rotate",
        shareId,
        grantId: parseShareId(parts[4]),
      };
    }
    if (parts.length === 6 && parts[3] === "links" && parts[5] === "retune") {
      return {
        route: "share-link-retune",
        shareId,
        grantId: parseShareId(parts[4]),
      };
    }
    if (parts.length === 6 && parts[3] === "grants" && parts[5] === "promote") {
      return {
        route: "share-grant-promote",
        shareId,
        grantId: parseShareId(parts[4]),
      };
    }
    if (parts.length === 6 && parts[3] === "grants" && parts[5] === "revoke") {
      return {
        route: "share-grant-revoke",
        shareId,
        grantId: parseShareId(parts[4]),
      };
    }
    if (parts.length === 4 && parts[3] === "log") return { route: "share-log", shareId };
    if (parts.length === 4 && parts[3] === "discussion") {
      return { route: "share-discussion", shareId };
    }
    if (
      parts.length === 5 &&
      parts[3] === "discussion" &&
      parts[4] === "activity"
    ) {
      return { route: "share-discussion-activity", shareId };
    }
    if (
      parts.length === 5 &&
      parts[3] === "discussion" &&
      parts[4] === "moderation"
    ) {
      return { route: "share-discussion-moderation", shareId };
    }
    if (parts.length === 4 && parts[3] === "presence") return { route: "share-presence", shareId };
    if (parts.length === 5 && parts[3] === "blobs" && parts[4]) {
      return { route: "share-blob", shareId, sha256: parts[4] };
    }
    if (parts.length === 4 && parts[3] === "proposals") {
      return { route: "share-proposals", shareId };
    }
    if (parts.length === 6 && parts[3] === "proposals" && parts[5] === "withdraw") {
      return {
        route: "share-proposal-withdraw",
        shareId,
        proposalId: parseShareId(parts[4]),
      };
    }
    throw notFound();
  }
  const workspaceId = parseWorkspaceId(parts[1]);
  if (parts[2] === "datasets") {
    if (parts.length === 3) return {route:"dataset", workspaceId, action:"list"};
    const datasetId = parts[3];
    if (!datasetId || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(datasetId)) throw notFound();
    if (parts.length === 4) return {route:"dataset", workspaceId, datasetId, action:"describe"};
    if (parts.length === 5 && ["activate","artifacts","invoke","migrate","permissions","upload","file","history"].includes(parts[4]!)) return {route:"dataset", workspaceId, datasetId, action:parts[4] as DatasetRoute["action"]};
    if (parts.length === 5 && parts[4] === "grants") return {route:"dataset", workspaceId, datasetId, action:"grant"};
    if (parts.length === 5 && parts[4] === "binding") return {route:"dataset", workspaceId, datasetId, action:"binding"};
    throw notFound();
  }
  if(parts[2]==="app-responses" && parts.length===4)return {route:"owner-app-responses",workspaceId,grantId:parseShareId(parts[3])};
  if (parts[2] === "app-publications") {
    if (parts.length === 3) return {route: "owner-app-publication", workspaceId, action: "publish"};
    const publicationId = parts[3];
    if (!publicationId || !/^[0-9a-f]{64}$/.test(publicationId)) throw notFound();
    if (parts.length === 4) return {route: "owner-app-publication", workspaceId, publicationId, action: "read"};
    if (parts.length === 5 && parts[4] === "withdraw") return {route: "owner-app-publication", workspaceId, publicationId, action: "withdraw"};
    if (parts.length === 5 && parts[4] === "reactivate") return {route: "owner-app-publication", workspaceId, publicationId, action: "reactivate"};
    if (parts.length === 5 && parts[4] === "collection-approval") return {route: "owner-app-publication", workspaceId, publicationId, action: "collection-approval"};
    if (parts.length === 6 && parts[4] === "backend" &&
        (parts[5] === "activate" || parts[5] === "invoke" || parts[5] === "upload" || parts[5] === "file" || parts[5] === "attempt" ||
         parts[5] === "describe" || parts[5] === "descriptor" || parts[5] === "export" || parts[5] === "restore" || parts[5] === "helper")) {
      return {route:"app-backend",workspaceId,publicationId,action:parts[5]};
    }
    if (parts.length === 7 && parts[4] === "backend" && parts[5] === "blobs" && /^[0-9a-f]{64}$/.test(parts[6]!)) {
      return {route:"app-backend",workspaceId,publicationId,action:"blob",sha256:parts[6]};
    }
    throw notFound();
  }
  if (parts[2] === "live-restores") {
    if (parts.length === 3) return {route: "owner-restore", workspaceId, action: "begin"};
    if (parts.length === 4 && (parts[3] === "plan" || parts[3] === "options")) return {route: "owner-restore", workspaceId, action: parts[3]};
    const operationId = parseString(parts[3], "operationId", 512);
    if (parts.length === 4) return {route: "owner-restore", workspaceId, operationId, action: "status"};
    const action = parts[4];
    if (parts.length === 5 && (action === "prepare" || action === "review" || action === "confirm")) {
      return {route: "owner-restore", workspaceId, operationId, action};
    }
    throw notFound();
  }
  if (parts.length === 4 && parts[2] === "blobs" && parts[3] === "have") {
    return { route: "blob-have", workspaceId };
  }
  if (parts.length === 4 && parts[2] === "blobs" && parts[3]) {
    return { route: "blob", workspaceId, sha256: parts[3] };
  }
  if (parts.length === 4 && parts[2] === "maintenance" && parts[3] === "gc") {
    return { route: "gc", workspaceId };
  }
  if (parts.length === 3 && parts[2] === "log") {
    return { route: "log", workspaceId };
  }
  if (parts.length === 5 && parts[2] === "log") {
    const originId = parseString(parts[3], "originId", MAX_ORIGIN_ID_CHARS);
    const originSeq = Number(parts[4]);
    if (!Number.isSafeInteger(originSeq) || originSeq < 0) throw notFound();
    return { route: "log-coordinate", workspaceId, originId, originSeq };
  }
  if (parts.length === 3 && parts[2] === "bootstrap") {
    return { route: "bootstrap", workspaceId };
  }
  if (parts.length === 3 && parts[2] === "epoch") {
    return { route: "epoch", workspaceId };
  }
  if (parts.length === 3 && parts[2] === "presence") {
    return { route: "presence", workspaceId };
  }
  if (parts.length === 3 && parts[2] === "keys") {
    return { route: "keys", workspaceId };
  }
  if (parts.length === 3 && parts[2] === "shares") {
    return { route: "shares-create", workspaceId };
  }
  if (parts.length === 4 && parts[2] === "shares" && parts[3] === "links") {
    return { route: "share-link-create-atomic", workspaceId };
  }
  if (parts.length === 5 && parts[2] === "shares" && parts[4] === "links") {
    return {
      route: "share-link-create",
      workspaceId,
      shareId: parseShareId(parts[3]),
    };
  }
  if (parts.length === 3 && parts[2] === "proposals") {
    return { route: "workspace-proposals", workspaceId };
  }
  if (parts.length === 4 && parts[2] === "proposals") {
    return {
      route: "workspace-proposal",
      workspaceId,
      proposalId: parseShareId(parts[3]),
    };
  }
  if (parts.length === 6 && parts[2] === "proposals" && parts[4] === "ops") {
    return {
      route: "workspace-proposal-op",
      workspaceId,
      proposalId: parseShareId(parts[3]),
      opIndex: parseOpIndex(parts[5]),
    };
  }
  if (
    parts.length === 5 &&
    parts[2] === "proposals" &&
    (parts[4] === "accept" || parts[4] === "decline")
  ) {
    return {
      route: "workspace-proposal-settle",
      workspaceId,
      proposalId: parseShareId(parts[3]),
      decision: parts[4],
    };
  }
  throw notFound();
}

// A path segment naming an op's position in its proposal. Anything that is not
// a plain in-range index addresses no op, so it is the same generic 404 every
// other unresolvable lookup gives.
function parseOpIndex(value: string | undefined): number {
  if (typeof value !== "string" || !/^(0|[1-9][0-9]{0,6})$/.test(value)) {
    throw notFound();
  }
  const index = Number(value);
  if (index >= MAX_SHARE_PROPOSAL_OPS) throw notFound();
  return index;
}
