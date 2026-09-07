import { jsonResponse, sha256Hex, TokenBucketLimiter } from "@dohc/service-http";
import { randomUUID } from "node:crypto";
import { SHA256_HEX_PATTERN } from "@dohc/security-contract/wire-patterns";
import { MAX_SHARE_PROPOSAL_OPS } from "@dohc/security-contract/share-proposal-bound";
import type { ResolveActor } from "@dohc/workspace-auth/session";
import { createNamedShareTransportRoutes, type NamedShareTransportRoute } from "./namedShareTransportRoutes";
import { arrayBufferForBytes, readBytes } from "./relayBytes";
import { assertChatAuthorship, parseLogOp } from "./relayLogInputs";
import { createLinkResponseStreams } from "./linkResponseStreams";
import { createLinkCredentialRoutes } from "./linkCredentialRoutes";
import { createDiscussionRoutes } from "./discussionRoutes";
import { createShareReadQueries } from "./shareReadQueries";
import { createLinkReadRoutes, type LinkReadRoute } from "./linkReadRoutes";
import { createShareSummaries } from "./shareSummaries";
import {
  hashLinkBearer,
  hashRelayExchangeKey,
  isPublicLinkAccess,
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
import { assertSha256, cursorCodec, parseCursor, parseLimit, parseString, parseWorkspaceId, readJsonObject } from "./requestInputs";
import { isChatChannelSelector, parseStoredAnyShareSelectorJson, validateChatChannelShareSelector, validateChatShareAccess, validateFileShareAccess, validateShareSelector, type AnyShareSelector, type ShareSelector } from "./shareFilter";
import { type EnforceWorkspaceIdentityResult, type SyncRelayIndependentGrantInventoryCursor, type SyncRelayLinkInventoryCursor, type SyncRelayShareGrantRow, type SyncRelayShareWithGrantRow, type SyncRelayStorage } from "./storage";
import {
  authorizeShareAction,
  resolveReceivedShareAuthority,
  selectorTargetsBlockedChannel,
  type AuthorizedShareAction,
  type ShareAction,
} from "./shareAuthorization";
import { badRequest, errorResponse, invalidLinkCapability, notFound, RELAY_ERRORS, relayError } from "./errors";
import { MAX_BLOB_BYTES, MAX_LOG_PAGE_SIZE, MAX_OPS_PER_REQUEST, MAX_ORIGIN_ID_CHARS, MAX_SHARE_ID_CHARS } from "./wireLimits";

export { MAX_BLOB_BYTES, MAX_PAYLOAD_JSON_BYTES } from "./wireLimits";
export { DISCUSSION_DISPLAY_NAME_LOOKUP_DEADLINE_MS } from "./discussionRoutes";
export { LINK_FRESHNESS_PAGE_BUDGET, MAX_RAW_ROWS_PER_LINK_PAGE } from "./shareReadQueries";

export type SyncRelayHandler = (request: Request) => Promise<Response>;

function composePublicLinkUrl(shareWebOrigin: string, secret: string): string {
  return `${shareWebOrigin}/s/#${secret}`;
}

function validatePublicLinkAccess(value: unknown): "view" | "comment" {
  const validation = validateFileShareAccess(value);
  if (!validation.ok) {
    throw relayError(validation.code, validation.message);
  }
  if (!isPublicLinkAccess(validation.access)) {
    throw relayError("invalid_access", 'access must be "view" or "comment"');
  }
  return validation.access;
}

export interface CreateSyncRelayHandlerOptions {
  storage: SyncRelayStorage;
  resolveActor: ResolveActor;
  nowMs?: () => number;
  // Share-grant recipient lookup: maps an email to the relay account id, or
  // null when no account matches. Absent means email-addressed grants are
  // unavailable (grants by user id still work).
  resolveUserIdByEmail?: (email: string) => Promise<string | null> | string | null;
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
  | { route: "link-exchange" }
  | { route: "link-refresh" }
  | { route: "link-handoff" }
  | { route: "link-redeem" }
  | LinkReadRoute
  | { route: "link-discussion" }
  | { route: "link-discussion-activity" }
  | { route: "workspaces" }
  | { route: "blob"; workspaceId: string; sha256: string }
  | { route: "blob-have"; workspaceId: string }
  | { route: "gc"; workspaceId: string }
  | { route: "bootstrap"; workspaceId: string }
  | { route: "epoch"; workspaceId: string }
  | { route: "keys"; workspaceId: string }
  | { route: "log"; workspaceId: string }
  | { route: "log-coordinate"; workspaceId: string; originId: string; originSeq: number }
  | { route: "shares-create"; workspaceId: string }
  | { route: "share-link-create-atomic"; workspaceId: string }
  | { route: "share-link-create"; workspaceId: string; shareId: string }
  | { route: "shares-list" }
  | { route: "share"; shareId: string }
  | { route: "share-revoke"; shareId: string }
  | { route: "share-link-rotate"; shareId: string; grantId: string }
  | { route: "share-link-retune"; shareId: string; grantId: string }
  | { route: "share-grant-promote"; shareId: string; grantId: string }
  | { route: "share-grant-revoke"; shareId: string; grantId: string }
  | NamedShareTransportRoute
  | { route: "share-discussion"; shareId: string }
  | { route: "share-discussion-activity"; shareId: string }
  | { route: "share-discussion-moderation"; shareId: string }
  | ShareProposalRoute
  | WorkspaceProposalRoute
  | { route: "presence"; workspaceId: string }
  | { route: "share-presence"; shareId: string };

export const MAX_KEY_ENVELOPE_BYTES = 16 * 1024;
const MAX_LINK_CURRENT_FILES = 5_000;
const MAX_EMAIL_CHARS = 320;
const MAX_IDENTITY_BYTES = 512;

export function createSyncRelayHandler({
  storage,
  resolveActor,
  nowMs = () => Date.now(),
  resolveUserIdByEmail,
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
}: CreateSyncRelayHandlerOptions): SyncRelayHandler {
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

  // Lazy claim of pending email invites: the first time an
  // invited account authenticates to the relay, any share addressed to its
  // email becomes a real grant (recipient_user_id filled in). The session
  // email is server-derived (never client-supplied), so this cannot be used
  // to claim someone else's invite.
  const claimPendingShares = async (userId: string): Promise<void> => {
    if (!lookupUserEmail) return;
    const email = await lookupUserEmail(userId);
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

  // The share and an active grant of `kind` on it, when the actor owns both
  // the share and its workspace right now. Anything else is a generic 404.
  function requireOwnedGrant(
    kind: "link" | "user",
    shareId: string,
    grantId: string,
    actor: { userId: string },
  ): SyncRelayShareWithGrantRow {
    const share = storage.getShare(shareId);
    const grant = storage.getShareGrant(grantId);
    if (
      !share ||
      share.granterUserId !== actor.userId ||
      !storage.workspaceIsOwnedBy(share.workspaceId, actor.userId) ||
      !grant ||
      grant.shareId !== share.shareId ||
      grant.principalKind !== kind ||
      (kind === "user" && !grant.principalUserId) ||
      grant.status !== "active" ||
      grant.revokedAtMs !== null
    ) {
      throw notFound();
    }
    return { share, grant };
  }

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
  } = createShareSummaries(lookupUserEmail);

  const dependentSetConflict = async (
    dependents: SyncRelayShareGrantRow[],
    workspaceId: string,
    actorUserId: string,
  ): Promise<Response> => {
    const projected = await Promise.all(dependents.map(dependentGrantSummary));
    if (!storage.workspaceIsOwnedBy(workspaceId, actorUserId)) throw notFound();
    return jsonResponse(
      {
        ok: false,
        error: "active dependent grants changed",
        code: RELAY_ERRORS.dependents_changed.code,
        dependents: projected,
      },
      RELAY_ERRORS.dependents_changed.status,
    );
  };

  const requireLinkRead = (
    request: Request,
    capabilityRateLimiter: TokenBucketLimiter,
    grantRateLimiter: TokenBucketLimiter,
  ) => {
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

  return async (request) => {
    try {
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

      if (route.route === "workspaces" && request.method === "POST") {
        const input = await readJsonObject(request);
        const workspaceId = parseWorkspaceId(input.workspaceId);
        // Parse before claimWorkspace mutates storage: a malformed partial
        // identity must not reserve a brand-new workspace row.
        const identity = parseOptionalWorkspaceIdentity(input);
        const result = storage.claimWorkspace({
          workspaceId,
          ownerUserId: actor.userId,
          createdAtMs: nowMs(),
        });
        if (result === "not-owner") throw notFound();
        if (identity !== null) {
          assertWorkspaceIdentityResult(
            storage.claimWorkspaceIdentity({ workspaceId, ...identity }),
          );
        }
        return jsonResponse({ ok: true, workspaceId, created: result === "created" });
      }

      if (route.route === "workspaces") throw relayError("method_not_allowed");

      if (route.route === "shares-list" && request.method === "GET") {
        await claimPendingShares(actor.userId);
        const granted = await Promise.all(
          storage
            .listSharesGrantedBy(actor.userId)
            .filter((row) => row.grant.principalKind !== "link")
            .map((row) => grantedShareSummary(row)),
        );
        const receivedByShare = new Map<string, SyncRelayShareWithGrantRow[]>();
        for (const row of storage
          .listSharesReceivedBy(actor.userId)
          .filter((candidate) => candidate.grant.principalKind !== "link")) {
          const rows = receivedByShare.get(row.share.shareId);
          if (rows) rows.push(row);
          else receivedByShare.set(row.share.shareId, [row]);
        }
        const receivedLookups = await Promise.all(
          [...receivedByShare.values()].map(async (rows) => {
            const fallback = rows[0]!;
            const granterEmail = lookupUserEmail
              ? await lookupUserEmail(fallback.share.granterUserId)
              : null;
            return { fallback, granterEmail };
          }),
        );
        const received = receivedLookups.flatMap(({ fallback, granterEmail }) => {
          const effective = resolveReceivedShareAuthority({
            storage,
            actorUserId: actor.userId,
            shareId: fallback.share.shareId,
          });
          if (effective.ok) {
            return [
              receivedShareSummary(
                { share: effective.share, grant: effective.grant },
                granterEmail,
                effective.genericChatWritable,
              ),
            ];
          }

          const currentFallback = effective.fallback;
          if (!currentFallback) return [];
          // A damaged fallback does not carry validated selector authority.
          // Recheck its selector immediately before serialization so a channel
          // that became blocked does not get one final exposure.
          const selector = parseStoredAnyShareSelectorJson(
            currentFallback.share.selectorJson,
          );
          return selector &&
            selectorTargetsBlockedChannel(
              storage,
              currentFallback.share.workspaceId,
              selector,
            )
            ? []
            : [
                receivedShareSummary(
                  currentFallback,
                  granterEmail,
                  effective.genericChatWritable,
                ),
              ];
        });
        return jsonResponse({ ok: true, granted, received });
      }
      if (route.route === "shares-list") throw relayError("method_not_allowed");

      if (route.route === "share" && request.method === "GET") {
        await claimPendingShares(actor.userId);
        const initial = requireShareAction(route.shareId, actor.userId, "read");
        const granterEmail = lookupUserEmail
          ? await lookupUserEmail(initial.share.granterUserId)
          : null;
        const authorized = resolveReceivedShareAuthority({
          storage,
          actorUserId: actor.userId,
          shareId: route.shareId,
        });
        if (!authorized.ok) throw notFound();
        const summary = receivedShareSummary(
          { share: authorized.share, grant: authorized.grant },
          granterEmail,
          authorized.genericChatWritable,
        );
        return jsonResponse({ ok: true, ...summary });
      }
      if (route.route === "share") throw relayError("method_not_allowed");

      if (route.route === "share-link-rotate" && request.method === "POST") {
        const input = await readJsonObject(request);
        const workspaceId = parseWorkspaceId(input.workspaceId);
        const { share, grant } = requireOwnedGrant(
          "link",
          route.shareId,
          route.grantId,
          actor,
        );
        requireShareWorkspace(share, workspaceId);
        const expectedDependentGrantIds = parseExpectedDependentGrantIds(input, [
          "workspaceId",
          "expectedDependentGrantIds",
        ]);
        let secret: string | null = null;
        const result = storage.rotateLinkGrant({
          shareId: share.shareId,
          grantId: grant.grantId,
          rotatedAtMs: nowMs(),
          expectedDependentGrantIds,
          guard: () => {
            const current = requireOwnedGrant(
              "link",
              share.shareId,
              grant.grantId,
              actor,
            );
            requireShareWorkspace(current.share, workspaceId);
          },
          mintCredential: () => {
            secret = newLinkBearer();
            return {
              credentialId: newId(),
              secretHash: hashLinkBearer(secret, linkKey!),
            };
          },
        });
        if (!result.ok) {
          if ("reason" in result && result.reason === "dependents-changed") {
            return dependentSetConflict(result.dependents, share.workspaceId, actor.userId);
          }
          throw notFound();
        }
        if (!secret) throw notFound();
        terminateLinkStreamsForGrant(result.grant.grantId);
        discussionActivity.wake(share.shareId);
        discussionActivity.wake(`log:${share.workspaceId}`);
        return jsonResponse({
          ok: true,
          ...linkGrantBody(result.grant),
          url: composePublicLinkUrl(shareWebOrigin!, secret),
        });
      }
      if (route.route === "share-link-rotate") throw relayError("method_not_allowed");

      if (route.route === "share-link-retune" && request.method === "POST") {
        const input = await readJsonObject(request);
        const workspaceId = parseWorkspaceId(input.workspaceId);
        const { share, grant } = requireOwnedGrant(
          "link",
          route.shareId,
          route.grantId,
          actor,
        );
        requireShareWorkspace(share, workspaceId);
        if (!isPublicLinkAccess(grant.access)) throw notFound();
        const expectedDependentGrantIds = parseExpectedDependentGrantIds(input, [
          "workspaceId",
          "access",
          "expectedDependentGrantIds",
        ]);
        const access = validatePublicLinkAccess(input.access);
        const widening = grant.access === "view" && access === "comment";
        if (widening && (!linkKey || !shareWebOrigin)) throw notFound();
        let secret: string | null = null;
        const result = storage.retuneShareGrant({
          shareId: share.shareId,
          grantId: grant.grantId,
          access,
          changedAtMs: nowMs(),
          expectedDependentGrantIds,
          guard: () => {
            const current = requireOwnedGrant(
              "link",
              share.shareId,
              grant.grantId,
              actor,
            );
            requireShareWorkspace(current.share, workspaceId);
          },
          ...(widening
            ? {
                mintCredential: () => {
                  secret = newLinkBearer();
                  return {
                    credentialId: newId(),
                    secretHash: hashLinkBearer(secret, linkKey!),
                  };
                },
              }
            : {}),
        });
        if (!result.ok) {
          if ("reason" in result && result.reason === "dependents-changed") {
            return dependentSetConflict(result.dependents, share.workspaceId, actor.userId);
          }
          throw notFound();
        }
        if (widening) terminateLinkStreamsForGrant(result.grant.grantId);
        discussionActivity.wake(share.shareId);
        discussionActivity.wake(`log:${share.workspaceId}`);
        return jsonResponse({
          ok: true,
          ...linkGrantBody(result.grant),
          ...(secret === null
            ? {}
            : { url: composePublicLinkUrl(shareWebOrigin!, secret) }),
        });
      }
      if (route.route === "share-link-retune") throw relayError("method_not_allowed");

      if (route.route === "share-grant-promote" && request.method === "POST") {
        const input = await readJsonObject(request);
        const workspaceId = parseWorkspaceId(input.workspaceId);
        const { share } = requireOwnedGrant(
          "user",
          route.shareId,
          route.grantId,
          actor,
        );
        requireShareWorkspace(share, workspaceId);
        const { expectedParentGrantId, expectedParentGeneration } =
          parsePromotionExpectation(input);
        const result = storage.promoteShareGrant({
          shareId: route.shareId,
          grantId: route.grantId,
          expectedParentGrantId,
          expectedParentGeneration,
          guard: () => {
            const current = requireOwnedGrant(
              "user",
              route.shareId,
              route.grantId,
              actor,
            );
            requireShareWorkspace(current.share, workspaceId);
          },
        });
        if (!result.ok) throw notFound();
        discussionActivity.wake(route.shareId);
        discussionActivity.wake(`log:${share.workspaceId}`);
        return jsonResponse({
          ok: true,
          ...namedGrantTransitionBody(result.grant),
        });
      }
      if (route.route === "share-grant-promote") throw relayError("method_not_allowed");

      if (route.route === "share-grant-revoke" && request.method === "POST") {
        const input = await readJsonObject(request);
        const workspaceId = parseWorkspaceId(input.workspaceId);
        if (Object.keys(input).some((key) => key !== "workspaceId")) {
          throw badRequest("request body contains an unknown field");
        }
        const { share } = requireOwnedGrant(
          "user",
          route.shareId,
          route.grantId,
          actor,
        );
        requireShareWorkspace(share, workspaceId);
        const result = storage.revokeShareGrant({
          shareId: route.shareId,
          grantId: route.grantId,
          revokedAtMs: nowMs(),
          guard: () => {
            const current = requireOwnedGrant(
              "user",
              route.shareId,
              route.grantId,
              actor,
            );
            requireShareWorkspace(current.share, workspaceId);
          },
        });
        if (!result.ok) throw notFound();
        discussionActivity.wake(route.shareId);
        discussionActivity.wake(`log:${share.workspaceId}`);
        return jsonResponse({
          ok: true,
          ...namedGrantTransitionBody(result.grant),
        });
      }
      if (route.route === "share-grant-revoke") throw relayError("method_not_allowed");

      if (route.route === "share-revoke" && request.method === "POST") {
        const share = storage.getShare(route.shareId);
        // Only the granter may revoke; anyone else (including the recipient)
        // sees the byte-identical generic 404.
        if (!share || share.granterUserId !== actor.userId) {
          throw notFound();
        }
        if (!storage.workspaceIsOwnedBy(share.workspaceId, actor.userId)) throw notFound();
        const input = await readOptionalJsonObject(request);
        if (input !== null) {
          const grantId = parseShareId(
            typeof input.grantId === "string" ? input.grantId : undefined,
          );
          const workspaceId = parseWorkspaceId(input.workspaceId);
          requireShareWorkspace(share, workspaceId);
          const grant = storage.getShareGrant(grantId);
          if (
            !grant ||
            grant.shareId !== share.shareId ||
            grant.principalKind !== "link"
          ) {
            throw notFound();
          }
          const expectedDependentGrantIds = parseExpectedDependentGrantIds(input, [
            "grantId",
            "workspaceId",
            "expectedDependentGrantIds",
          ]);
          const result = storage.revokeShareGrant({
            shareId: share.shareId,
            grantId,
            revokedAtMs: nowMs(),
            expectedDependentGrantIds,
          });
          if (!result.ok) {
            if ("reason" in result && result.reason === "dependents-changed") {
              return dependentSetConflict(result.dependents, share.workspaceId, actor.userId);
            }
            throw notFound();
          }
          terminateLinkStreamsForGrant(result.grant.grantId);
          discussionActivity.wake(share.shareId);
          discussionActivity.wake(`log:${share.workspaceId}`);
          return jsonResponse({ ok: true, ...linkGrantBody(result.grant) });
        }
        if (storage.revokeShare(route.shareId, nowMs())) {
          terminateLinkStreamsForShare(route.shareId);
          discussionActivity.wake(route.shareId);
          discussionActivity.wake(`log:${share.workspaceId}`);
        }
        return jsonResponse({ ok: true, shareId: route.shareId });
      }
      if (route.route === "share-revoke") throw relayError("method_not_allowed");

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

      if (route.route === "bootstrap" && request.method === "GET") {
        const bootstrap = storage.getWorkspaceBootstrap(route.workspaceId);
        return jsonResponse({
          ok: true,
          hasContent: bootstrap.hasContent,
          replicationEpoch: bootstrap.identity?.replicationEpoch ?? null,
          streamIdentity: bootstrap.identity?.streamIdentity ?? null,
        });
      }
      if (route.route === "bootstrap") throw relayError("method_not_allowed");

      if (route.route === "epoch" && request.method === "POST") {
        const input = await readJsonObject(request);
        const replicationEpoch = parseWorkspaceIdentityValue(
          input.replicationEpoch,
          "replicationEpoch",
        );
        const streamIdentity = parseWorkspaceIdentityValue(
          input.streamIdentity,
          "streamIdentity",
        );
        const result = storage.rotateWorkspaceIdentity({
          workspaceId: route.workspaceId,
          ownerUserId: actor.userId,
          replicationEpoch,
          streamIdentity,
          rotatedAtMs: nowMs(),
        });
        if (result === "not-owner") throw notFound();
        if (result === "epoch-superseded") throw relayError("epoch_superseded");
        return jsonResponse({
          ok: true,
          rotated: result === "rotated",
          replicationEpoch,
          streamIdentity,
        });
      }
      if (route.route === "epoch") throw relayError("method_not_allowed");

      if (route.route === "gc" && request.method === "POST") {
        const result = await storage.collectUnreferencedBlobs(route.workspaceId, {
          nowMs: nowMs(),
        });
        return jsonResponse({ ok: true, ...result });
      }
      if (route.route === "gc") throw relayError("method_not_allowed");

      if (route.route === "share-link-create-atomic" && request.method === "GET") {
        if (!storage.workspaceIsOwnedBy(route.workspaceId, actor.userId)) throw notFound();
        const url = new URL(request.url);
        if (
          url.searchParams.getAll("cursor").length > 1 ||
          url.searchParams.getAll("independentGrantCursor").length > 1
        ) {
          throw badRequest("cursor is invalid");
        }
        const linkCursor = linkInventoryCursor.decode(
          url.searchParams.get("cursor"),
        );
        const independentGrantCursor = independentGrantInventoryCursor.decode(
          url.searchParams.get("independentGrantCursor"),
        );
        const page = storage.listLinkGrantsByWorkspace(
          route.workspaceId,
          linkCursor,
        );
        const independentGrantPage = storage.listActiveIndependentShareGrants({
          workspaceId: route.workspaceId,
          shareIds: page.links.map((row) => row.share.shareId),
          ...(independentGrantCursor
            ? { cursor: independentGrantCursor }
            : {}),
        });
        const [links, independentGrants] = await Promise.all([
          independentGrantCursor
            ? []
            : Promise.all(page.links.map(linkInventorySummary)),
          Promise.all(
            independentGrantPage.grants.map(independentGrantSummary),
          ),
        ]);
        if (!storage.workspaceIsOwnedBy(route.workspaceId, actor.userId)) throw notFound();
        return jsonResponse({
          ok: true,
          links,
          independentGrants,
          ...(independentGrantPage.nextCursor
            ? {
                nextIndependentGrantCursor:
                  independentGrantInventoryCursor.encode(
                    independentGrantPage.nextCursor,
                  ),
              }
            : {}),
          ...(page.nextCursor
            ? { nextCursor: linkInventoryCursor.encode(page.nextCursor) }
            : {}),
        });
      }

      if (route.route === "share-link-create-atomic" && request.method === "POST") {
        const input = await readJsonObject(request);
        if (
          Object.keys(input).some(
            (key) => key !== "paths" && key !== "versionId" && key !== "access",
          )
        ) {
          throw badRequest("A link accepts only access, paths, and versionId.");
        }
        const access = validatePublicLinkAccess(input.access);
        const validation = validateShareSelector({
          paths: input.paths,
          versionId: input.versionId,
        });
        if (!validation.ok) {
          throw relayError(validation.code, validation.message);
        }
        const selector = validation.selector;
        const shareId = newShareId();
        const grantId = newGrantId();
        const createdAtMs = nowMs();
        const secret = newLinkBearer();
        const share = {
          shareId,
          workspaceId: route.workspaceId,
          granterUserId: actor.userId,
          selectorJson: JSON.stringify(selector),
          createdAtMs,
        };
        const grant = {
          grantId,
          shareId,
          principalKind: "link" as const,
          principalUserId: null,
          principalEmail: null,
          access,
          generation: 1,
          status: "active" as const,
          createdAtMs,
          revokedAtMs: null,
          parentGrantId: null,
        };
        const created = storage.createFileLinkShare({
          share,
          grant,
          credential: {
            credentialId: newId(),
            grantId,
            secretHash: hashLinkBearer(secret, linkKey!),
            generation: 1,
            mintedAtMs: createdAtMs,
            retiredAtMs: null,
          },
          guard: () => {
            if (!storage.workspaceIsOwnedBy(route.workspaceId, actor.userId)) throw notFound();
          },
        });
        if (!created) throw notFound();
        return jsonResponse({
          ok: true,
          workspaceId: route.workspaceId,
          selector,
          ...linkGrantBody(grant),
          url: composePublicLinkUrl(shareWebOrigin!, secret),
        });
      }
      if (route.route === "share-link-create-atomic") throw relayError("method_not_allowed");

      if (route.route === "share-link-create" && request.method === "POST") {
        const input = await readJsonObject(request);
        if (Object.keys(input).some((key) => key !== "access")) {
          throw badRequest("A link accepts only access.");
        }
        const access = validatePublicLinkAccess(input.access);
        const share = storage.getShare(route.shareId);
        const selector = share
          ? parseStoredAnyShareSelectorJson(share.selectorJson)
          : null;
        if (
          !share ||
          share.workspaceId !== route.workspaceId ||
          share.granterUserId !== actor.userId ||
          !storage.workspaceIsOwnedBy(share.workspaceId, actor.userId) ||
          !selector ||
          "kind" in selector
        ) {
          throw notFound();
        }
        const secret = newLinkBearer();
        const grantId = newGrantId();
        const createdAtMs = nowMs();
        const grant = {
          grantId,
          shareId: share.shareId,
          principalKind: "link" as const,
          principalUserId: null,
          principalEmail: null,
          access,
          generation: 1,
          status: "active" as const,
          createdAtMs,
          revokedAtMs: null,
          parentGrantId: null,
        };
        const created = storage.createLinkGrant({
          grant,
          credential: {
            credentialId: newId(),
            grantId,
            secretHash: hashLinkBearer(secret, linkKey!),
            generation: 1,
            mintedAtMs: createdAtMs,
            retiredAtMs: null,
          },
        });
        if (!created) throw notFound();
        return jsonResponse({
          ok: true,
          ...linkGrantBody(grant),
          url: composePublicLinkUrl(shareWebOrigin!, secret),
        });
      }
      if (route.route === "share-link-create") throw relayError("method_not_allowed");

      if (route.route === "shares-create" && request.method === "POST") {
        const input = await readJsonObject(request);
        // Two grant kinds share one create surface: a chat-channel grant
        // (MU-C4, addressed by channelWireId + optional access) or the PR-18
        // path/version grant. The recipient addressing, pending-invite, and
        // anti-enumeration behavior below is identical for both.
        const { selector, access } = (() => {
          if (input.channelWireId !== undefined) {
            // Fail closed on an ambiguous body: a chat-channel selector must not
            // also carry a path/version selector. Silently preferring
            // channelWireId (and dropping the paths) would turn a stale/leftover
            // `paths` field into a full chat-channel grant — a silent intent
            // mismatch. Reject it instead (hardens regular shared-channel grants
            // too).
            if (input.paths !== undefined || input.versionId !== undefined) {
              throw relayError("ambiguous_selector", "a chat-channel share must not also carry paths or versionId");
            }
            const chatValidation = validateChatChannelShareSelector({
              channelWireId: input.channelWireId,
            });
            if (!chatValidation.ok) {
              throw relayError(chatValidation.code, chatValidation.message);
            }
            const accessValidation = validateChatShareAccess(input.access);
            if (!accessValidation.ok) {
              throw relayError(accessValidation.code, accessValidation.message);
            }
            const selector = chatValidation.selector;
            if (selectorTargetsBlockedChannel(storage, route.workspaceId, selector)) {
              throw relayError("invalid_channel", "channel is not shareable");
            }
            return { selector, access: accessValidation.access };
          }

          const accessValidation = validateFileShareAccess(input.access);
          if (!accessValidation.ok) {
            throw relayError(accessValidation.code, accessValidation.message);
          }
          const validation = validateShareSelector({
            paths: input.paths,
            versionId: input.versionId,
          });
          if (!validation.ok) {
            throw relayError(validation.code, validation.message);
          }
          const selector = validation.selector;
          return { selector, access: accessValidation.access };
        })();
        const shareId = newShareId();
        const grantId = newGrantId();
        const createdAtMs = nowMs();

        // Sharing by explicit user id: the granter already knows the id, so
        // there is no account existence to leak — echo it back.
        if (input.recipientUserId !== undefined) {
          const recipientUserId = parseString(
            input.recipientUserId,
            "recipientUserId",
            MAX_ORIGIN_ID_CHARS,
          );
          if (recipientUserId === actor.userId) throw relayError("self_share");
          if (selectorTargetsBlockedChannel(storage, route.workspaceId, selector)) {
            throw relayError("invalid_channel", "channel is not shareable");
          }
          storage.createShare({
            share: {
              shareId,
              workspaceId: route.workspaceId,
              granterUserId: actor.userId,
              selectorJson: JSON.stringify(selector),
              createdAtMs,
            },
            grant: {
              grantId,
              shareId,
              principalKind: "user",
              principalUserId: recipientUserId,
              principalEmail: null,
              access,
              generation: 1,
              status: "active",
              createdAtMs,
              revokedAtMs: null,
              parentGrantId: null,
            },
          });
          return jsonResponse({
            ok: true,
            shareId,
            workspaceId: route.workspaceId,
            recipientUserId,
            selector,
            access,
            grantId,
            generation: 1,
            createdAtMs,
          });
        }

        // Sharing by email. To close the account-enumeration oracle, the
        // response is identical whether or not the email has a dohc account:
        // a known account becomes an immediate recipient, an unknown email
        // becomes a pending invite (claimed when that account first touches
        // the relay). Either way the response never echoes a recipient user
        // id, so the granter cannot distinguish "has an account" from "does
        // not" by inspecting the reply.
        const email = parseString(input.recipientEmail, "recipientEmail", MAX_EMAIL_CHARS);
        if (!resolveUserIdByEmail) {
          throw badRequest("recipient email lookup is not available on this relay");
        }
        const resolved = await resolveUserIdByEmail(email);
        if (resolved === actor.userId) throw relayError("self_share");
        // Re-check after the asynchronous account lookup: a pre-provisioned
        // wire may have become an agent channel while this request was waiting.
        if (selectorTargetsBlockedChannel(storage, route.workspaceId, selector)) {
          throw relayError("invalid_channel", "channel is not shareable");
        }
        storage.createShare({
          share: {
            shareId,
            workspaceId: route.workspaceId,
            granterUserId: actor.userId,
            selectorJson: JSON.stringify(selector),
            createdAtMs,
          },
          grant: {
            grantId,
            shareId,
            principalKind: resolved ? "user" : "email",
            principalUserId: resolved ?? null,
            principalEmail: resolved ? null : email.trim().toLowerCase(),
            access,
            generation: 1,
            status: "active",
            createdAtMs,
            revokedAtMs: null,
            parentGrantId: null,
          },
        });
        return jsonResponse({
          ok: true,
          shareId,
          workspaceId: route.workspaceId,
          selector,
          access,
          grantId,
          generation: 1,
          createdAtMs,
        });
      }
      if (route.route === "shares-create") throw relayError("method_not_allowed");

      if (route.route === "blob" && request.method === "PUT") {
        assertSha256(route.sha256);
        const bytes = await readBytes(request, MAX_BLOB_BYTES);
        const actual = sha256Hex(bytes);
        if (actual !== route.sha256) {
          throw badRequest("blob content does not match sha256 path");
        }
        const put = storage.putBlob({
          workspaceId: route.workspaceId,
          sha256: route.sha256,
          content: bytes,
          createdAtMs: nowMs(),
        });
        return jsonResponse({
          ok: true,
          workspaceId: route.workspaceId,
          sha256: route.sha256,
          byteLength: put.byteLength,
          alreadyHad: put.alreadyHad,
        });
      }

      if (route.route === "blob" && request.method === "GET") {
        assertSha256(route.sha256);
        const blob = storage.getBlob(route.workspaceId, route.sha256);
        // Distinct from the absent-workspace 404: the caller already proved
        // ownership above, so this leaks nothing about other tenants, and
        // sync clients must be able to tell missing content apart from an
        // unavailable workspace.
        if (!blob) throw relayError("blob_not_found");
        return new Response(arrayBufferForBytes(blob), {
          status: 200,
          headers: { "content-type": "application/octet-stream" },
        });
      }

      if (route.route === "blob-have" && request.method === "POST") {
        const input = await readJsonObject(request);
        if (!Array.isArray(input.sha256s)) throw badRequest("sha256s must be an array");
        if (input.sha256s.length > 2_000) throw badRequest("too many sha256s");
        const sha256s = input.sha256s.map((value) => {
          if (typeof value !== "string") throw badRequest("sha256s must be strings");
          assertSha256(value);
          return value;
        });
        return jsonResponse({
          ok: true,
          missing: storage.missingBlobs(route.workspaceId, sha256s),
        });
      }

      if (route.route === "keys" && request.method === "PUT") {
        const bytes = await readBytes(request, MAX_KEY_ENVELOPE_BYTES);
        const envelopeJson = Buffer.from(bytes).toString("utf8");
        try {
          const parsed = JSON.parse(envelopeJson);
          if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
            throw new Error("not object");
          }
        } catch {
          throw badRequest("key envelope must be a JSON object");
        }
        // Create-only on first write; CAS via If-Match (sha256 of the envelope
        // being replaced) thereafter. A stale or absent precondition is a 409,
        // never a silent overwrite — the envelope is the only recovery path
        // for the wrapped workspace key. Replaced envelopes are retained in
        // the history table by storage.putKeyEnvelope.
        const result = storage.putKeyEnvelope({
          workspaceId: route.workspaceId,
          envelopeJson,
          updatedAtMs: nowMs(),
          expectedSha256: parseIfMatchSha256(request.headers.get("if-match")),
        });
        return jsonResponse(
          { ok: true, workspaceId: route.workspaceId, sha256: result.sha256 },
          200,
          { etag: `"${result.sha256}"` },
        );
      }

      if (route.route === "keys" && request.method === "GET") {
        const envelope = storage.getKeyEnvelope(route.workspaceId);
        if (!envelope) throw relayError("key_envelope_not_found");
        return new Response(envelope.envelopeJson, {
          status: 200,
          headers: {
            "content-type": "application/json",
            // Current fingerprint + write time so clients can detect that the
            // envelope they enrolled with has been replaced.
            etag: `"${envelope.sha256}"`,
            "x-key-envelope-updated-at-ms": String(envelope.updatedAtMs),
          },
        });
      }

      if (route.route === "log" && request.method === "POST") {
        const input = await readJsonObject(request);
        const identity = parseOptionalWorkspaceIdentity(input);
        const originId = parseString(input.originId, "originId", MAX_ORIGIN_ID_CHARS);
        if (!Array.isArray(input.ops)) throw badRequest("ops must be an array");
        if (input.ops.length > MAX_OPS_PER_REQUEST) throw badRequest("too many ops");
        // MU-C0 verified authorship — the trust boundary. Every chat op that
        // names an author must claim the authenticated pusher. The relay refuses
        // authorless messages and unknown chat ops. This check runs before
        // parseLogOp and appendLogBatch, so the relay rejects the full batch
        // before it writes any operation.
        assertChatAuthorship(input.ops, actor.userId);
        const ops = input.ops.map(parseLogOp);
        const result = storage.appendLogBatch({
          workspaceId: route.workspaceId,
          originId,
          ops,
          // Identity claim/verification rides the append's BEGIN IMMEDIATE
          // transaction. A gap/conflict/quota/blob failure later in append
          // rolls back a first-adopt claim together with the batch.
          guard: ({ enforceWorkspaceIdentity: enforceInAppend }) => {
            enforceWorkspaceIdentity(
              storage,
              route.workspaceId,
              identity,
              enforceInAppend,
            );
          },
        });
        if (result.inserted > 0) {
          discussionActivity.wake(`log:${route.workspaceId}`);
        }
        return jsonResponse({
          ok: true,
          accepted: ops.length,
          inserted: result.inserted,
          skipped: result.skipped,
          currentMaxOriginSeq: result.currentMaxOriginSeq,
        });
      }

      if (route.route === "log" && request.method === "GET") {
        const url = new URL(request.url);
        const identity = parseOptionalWorkspaceIdentityQuery(url.searchParams);
        const epochLogFloor = enforceWorkspaceIdentity(
          storage,
          route.workspaceId,
          identity,
        );
        const requestedSince = parseCursor(url.searchParams.get("since"));
        const since = Math.max(requestedSince, epochLogFloor);
        const limit = parseLimit(url.searchParams.get("limit"));
        const page = storage.fetchLogPage({
          workspaceId: route.workspaceId,
          sinceRelaySeq: since,
          limit,
        });
        return jsonResponse({
          ok: true,
          ops: page.rows.map((row) => ({
            relaySeq: row.relaySeq,
            workspaceId: row.workspaceId,
            originId: row.originId,
            originSeq: row.originSeq,
            opKind: row.opKind,
            payload: JSON.parse(row.payloadJson) as unknown,
            recordedAtMs: row.recordedAtMs,
          })),
          // A hidden epoch floor is a read filter, not a served log row. An
          // empty response therefore cannot advance the caller's cursor: the
          // strict page contract requires nextCursor to equal the final
          // relaySeq, or the requested cursor when no row was served.
          nextCursor: page.rows.length === 0 ? requestedSince : page.nextCursor,
          hasMore: page.hasMore,
        });
      }

      if (route.route === "log-coordinate" && request.method === "GET") {
        const url = new URL(request.url);
        const identity = parseOptionalWorkspaceIdentityQuery(url.searchParams);
        const epochLogFloor = enforceWorkspaceIdentity(
          storage,
          route.workspaceId,
          identity,
        );
        const row = storage.fetchLogCoordinate({
          workspaceId: route.workspaceId,
          originId: route.originId,
          originSeq: route.originSeq,
        });
        if (!row) return jsonResponse({ ok: true, status: "absent" });
        const op = {
          relaySeq: row.relaySeq,
          workspaceId: row.workspaceId,
          originId: row.originId,
          originSeq: row.originSeq,
          opKind: row.opKind,
          payload: JSON.parse(row.payloadJson) as unknown,
          recordedAtMs: row.recordedAtMs,
        };
        if (row.relaySeq <= epochLogFloor) {
          return jsonResponse({
            ok: true,
            status: "presentBelowEpochFloor",
            op,
          });
        }
        return jsonResponse({
          ok: true,
          status: "present",
          op,
        });
      }

      throw relayError("method_not_allowed");
    } catch (error) {
      return errorResponse(error);
    }
  };
}

function parseRoute(request: Request): SyncRelayRoute {
  const parts = new URL(request.url).pathname.split("/").filter(Boolean).map(decodeURIComponent);
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
  // a workspace id (parseWorkspaceId below) so the two can never collide.
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

function parseShareId(value: string | undefined): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > MAX_SHARE_ID_CHARS ||
    !/^[a-z0-9][a-z0-9-]*$/u.test(value)
  ) {
    throw notFound();
  }
  return value;
}

const linkInventoryCursor = cursorCodec<SyncRelayLinkInventoryCursor>(
  { shareCreatedAtMs: "ms", shareId: "id", linkCreatedAtMs: "ms", grantId: "id" },
  "cursor",
);
const independentGrantInventoryCursor = cursorCodec<SyncRelayIndependentGrantInventoryCursor>(
  { shareId: "id", grantCreatedAtMs: "ms", grantId: "id" },
  "independentGrantCursor",
);
function parseExpectedDependentGrantIds(
  input: Record<string, unknown>,
  allowedKeys: readonly string[],
): string[] {
  if (Object.keys(input).some((key) => !allowedKeys.includes(key))) {
    throw badRequest("request body contains an unknown field");
  }
  const value = input.expectedDependentGrantIds;
  if (!Array.isArray(value)) {
    throw badRequest("expectedDependentGrantIds must be an array of grant ids");
  }
  const normalized = new Set<string>();
  for (const grantId of value) {
    if (
      typeof grantId !== "string" ||
      grantId.length === 0 ||
      grantId.length > MAX_SHARE_ID_CHARS ||
      !/^[a-z0-9][a-z0-9-]*$/u.test(grantId)
    ) {
      throw badRequest("expectedDependentGrantIds must be an array of grant ids");
    }
    normalized.add(grantId);
  }
  return [...normalized];
}

function parsePromotionExpectation(input: Record<string, unknown>): {
  expectedParentGrantId: string;
  expectedParentGeneration: number;
} {
  const allowedKeys = [
    "workspaceId",
    "expectedParentGrantId",
    "expectedParentGeneration",
  ];
  if (Object.keys(input).some((key) => !allowedKeys.includes(key))) {
    throw badRequest("request body contains an unknown field");
  }
  const expectedParentGrantId = parseShareId(
    typeof input.expectedParentGrantId === "string"
      ? input.expectedParentGrantId
      : undefined,
  );
  if (
    !Number.isSafeInteger(input.expectedParentGeneration) ||
    Number(input.expectedParentGeneration) < 1
  ) {
    throw badRequest("expectedParentGeneration must be a positive integer");
  }
  return {
    expectedParentGrantId,
    expectedParentGeneration: Number(input.expectedParentGeneration),
  };
}

async function readOptionalJsonObject(
  request: Request,
): Promise<Record<string, unknown> | null> {
  const text = await request.text();
  if (text.length === 0) return null;
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw badRequest("request body must be valid JSON");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw badRequest("request body must be a JSON object");
  }
  return value as Record<string, unknown>;
}

function parseWorkspaceIdentityValue(value: unknown, name: string): string {
  const parsed = parseString(value, name, MAX_IDENTITY_BYTES);
  if (Buffer.byteLength(parsed, "utf8") > MAX_IDENTITY_BYTES) {
    throw badRequest(`${name} is too long`);
  }
  return parsed;
}

interface OptionalWorkspaceIdentity {
  replicationEpoch: string;
  streamIdentity: string;
}

function parseOptionalWorkspaceIdentity(
  input: Record<string, unknown>,
): OptionalWorkspaceIdentity | null {
  return parseOptionalWorkspaceIdentityValues(
    input.replicationEpoch,
    input.streamIdentity,
  );
}

function parseOptionalWorkspaceIdentityQuery(
  searchParams: URLSearchParams,
): OptionalWorkspaceIdentity | null {
  return parseOptionalWorkspaceIdentityValues(
    searchParams.has("replicationEpoch")
      ? searchParams.get("replicationEpoch")
      : undefined,
    searchParams.has("streamIdentity") ? searchParams.get("streamIdentity") : undefined,
  );
}

function parseOptionalWorkspaceIdentityValues(
  replicationEpochValue: unknown,
  streamIdentityValue: unknown,
): OptionalWorkspaceIdentity | null {
  const hasReplicationEpoch = replicationEpochValue !== undefined;
  const hasStreamIdentity = streamIdentityValue !== undefined;
  if (!hasReplicationEpoch && !hasStreamIdentity) return null;
  if (hasReplicationEpoch !== hasStreamIdentity) {
    throw badRequest("replicationEpoch and streamIdentity must be supplied together");
  }
  return {
    replicationEpoch: parseWorkspaceIdentityValue(
      replicationEpochValue,
      "replicationEpoch",
    ),
    streamIdentity: parseWorkspaceIdentityValue(
      streamIdentityValue,
      "streamIdentity",
    ),
  };
}

function enforceWorkspaceIdentity(
  storage: SyncRelayStorage,
  workspaceId: string,
  identity: OptionalWorkspaceIdentity | null,
  claimInAppend?: (
    identity: OptionalWorkspaceIdentity | null,
  ) => EnforceWorkspaceIdentityResult,
): number {
  if (claimInAppend) {
    assertWorkspaceIdentityResult(claimInAppend(identity));
    return 0;
  }
  if (identity === null) {
    if (storage.getWorkspaceIdentity(workspaceId) !== null) {
      throw relayError("identity_required");
    }
    return 0;
  }
  // GET is strictly read-only. An unset workspace cannot first-adopt identity
  // through a pull; there is no coordinate to verify, so it is reported as
  // unrecognized without writing.
  assertWorkspaceIdentityResult(
    storage.verifyWorkspaceIdentity({ workspaceId, ...identity }),
  );
  return storage.getEpochLogFloor(workspaceId);
}

function assertWorkspaceIdentityResult(
  result: EnforceWorkspaceIdentityResult,
): void {
  if (result === "epoch-superseded") throw relayError("epoch_superseded");
  if (result === "epoch-unknown") throw relayError("identity_not_recognized");
  if (result === "stream-mismatch") throw relayError("stream_identity_mismatch");
  if (result === "identity-required") throw relayError("identity_required");
}

// If-Match for PUT /keys: absent means create-only; otherwise a (optionally
// quoted) sha256 of the envelope the caller intends to replace. Wildcard and
// weak validators are refused — an unconditional overwrite is exactly the
// write this endpoint exists to prevent.
function parseIfMatchSha256(header: string | null): string | null {
  if (header === null) return null;
  const value = header.trim().replace(/^"(.*)"$/u, "$1");
  if (!SHA256_HEX_PATTERN.test(value)) {
    throw badRequest("if-match must be the sha256 of the current key envelope");
  }
  return value;
}
