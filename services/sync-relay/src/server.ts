import { jsonResponse, sha256Hex, TokenBucketLimiter } from "@dohc/service-http";
import { randomUUID } from "node:crypto";
import { SHA256_HEX_PATTERN } from "@dohc/security-contract/wire-patterns";
import { MAX_SHARE_PROPOSAL_OPS } from "@dohc/security-contract/share-proposal-bound";
import type { ResolveActor } from "@dohc/workspace-auth/session";
import { stableJsonStringify } from "./canonicalJson";
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
import { filterOpForShareAppend, isChatChannelSelector, parseStoredAnyShareSelectorJson, validateChatChannelShareSelector, validateChatShareAccess, validateFileShareAccess, validateShareSelector, type AnyShareSelector, type ChatShareThreadResolver, type ShareSelector, type ThreadFileBinding } from "./shareFilter";
import { type EnforceWorkspaceIdentityResult, type SyncRelayLogInput, type SyncRelayIndependentGrantInventoryCursor, type SyncRelayLinkInventoryCursor, type SyncRelayShareGrantRow, type SyncRelayShareWithGrantRow, type SyncRelayStorage } from "./storage";
import {
  authorizeShareAction,
  resolveReceivedShareAuthority,
  selectorTargetsBlockedChannel,
  type AuthorizedShareAction,
  type ShareAction,
} from "./shareAuthorization";
import { PROPOSAL_ORIGIN_PREFIX } from "./shareProposals";
import { badRequest, errorResponse, invalidLinkCapability, notFound, RELAY_ERRORS, relayError } from "./errors";
import { MAX_BLOB_BYTES, MAX_LOG_PAGE_SIZE, MAX_PAYLOAD_JSON_BYTES, MAX_SHARE_ID_CHARS } from "./wireLimits";

export { MAX_BLOB_BYTES, MAX_DISCUSSION_ACTIVITY_HOLD_MS, MAX_PAYLOAD_JSON_BYTES } from "./wireLimits";
export { DISCUSSION_DISPLAY_NAME_LOOKUP_DEADLINE_MS } from "./discussionRoutes";
export { LINK_FRESHNESS_PAGE_BUDGET, MAX_RAW_ROWS_PER_LINK_PAGE } from "./shareReadQueries";
export { validateLinkCapability } from "./linkSecurity";
export {
  MAX_PRESENCE_TOPIC_CHARS,
  MAX_CLIENT_ID_CHARS,
  MAX_PRESENCE_STATE_BYTES,
  DEFAULT_PRESENCE_HOLD_MS,
} from "./presenceRoutes";

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
  | { route: "share-log"; shareId: string }
  | { route: "share-discussion"; shareId: string }
  | { route: "share-discussion-activity"; shareId: string }
  | { route: "share-discussion-moderation"; shareId: string }
  | { route: "share-blob"; shareId: string; sha256: string }
  | ShareProposalRoute
  | WorkspaceProposalRoute
  | { route: "presence"; workspaceId: string }
  | { route: "share-presence"; shareId: string };

export const MAX_KEY_ENVELOPE_BYTES = 16 * 1024;
// One PAGE of the continuous replication lane, for the two log routes. It is
// not the submit bound: a submit is one user act carrying one intent, and it
// is bounded by what a person changes (MAX_SHARE_PROPOSAL_OPS), not by what a
// page should hold. Raising this one would only lengthen each replication
// stall.
export const MAX_OPS_PER_REQUEST = 500;
const MAX_LINK_CURRENT_FILES = 5_000;
const MAX_ORIGIN_ID_CHARS = 256;
const MAX_OP_KIND_CHARS = 128;
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

      if (route.route === "share-log" && request.method === "GET") {
        await claimPendingShares(actor.userId);
        const authorized = requireShareAction(route.shareId, actor.userId, "read");
        const share = { ...authorized.share, selector: authorized.effectiveSelector };
        const url = new URL(request.url);
        const channelWireId = url.searchParams.get("channelWireId");
        if (
          channelWireId !== null &&
          (!isChatChannelSelector(share.selector) ||
            share.selector.channelWireId !== channelWireId)
        ) {
          throw notFound();
        }
        const since = parseCursor(url.searchParams.get("since"));
        const limit = parseLimit(url.searchParams.get("limit"));
        // Both routes share selector filtering and cursor behavior. The
        // accountless route applies a narrower metadata boundary afterward.
        const page = filteredLogPage(
          share.workspaceId,
          share.selector,
          since,
          limit,
          "authenticated",
        );
        // Re-check revocation immediately before returning the body: a revoke
        // that raced with this in-flight read (after the entry check, while
        // the page was assembled) must abort the response, not leak a final
        // filtered page. Re-loading the share throws the same generic 404.
        requireShareAction(route.shareId, actor.userId, "read");
        return jsonResponse({
          ok: true,
          ...page,
        });
      }

      // MU-C4 member append — the bidirectional extension of the PR-18
      // recipient model, and the first place a non-owner writes into an
      // owner's bucket. Fail-closed gauntlet, in order:
      //   1. authorizeShareAction: membership, grant status, granter standing —
      //      every denial is the same byte-identical generic 404.
      //   2. The selector must accept appends: a read-write chat-channel
      //      grant, or a file share at comment or edit. A
      //      read-only member and a VIEW file share are refused with an
      //      explicit 403 — the member legitimately knows the share exists,
      //      so this is a refusal, not a 404 — and with one code and one
      //      body, because a level-specific refusal would tell a probing
      //      recipient the selector's level.
      //   3. MU-C0 verified authorship: every authored chat op must claim the
      //      AUTHENTICATED pusher (assertChatAuthorship verifies it) — a
      //      member cannot forge a message or reaction as another member.
      //   4. Every op must pass the same fail-closed chat filter that scopes
      //      reads: chat.* only, granted channel only, earliest-thread-binding
      //      honored. One rejected op rejects the whole batch atomically.
      // Accepted ops land in the OWNER's workspace bucket under a
      // share-namespaced origin id, so a member can never extend (or collide
      // with) the owner's — or another member's — origin sequence space; the
      // relay still assigns no cross-origin order.
      // Deliberate R10b boundary: members are not workspace replicas. Their
      // share-namespaced appends are governed by the fail-closed share/channel
      // filter, so workspace epoch enforcement does not apply on this route.
      if (route.route === "share-log" && request.method === "POST") {
        await claimPendingShares(actor.userId);
        const authorized = requireShareAction(route.shareId, actor.userId, "append");
        const share = { ...authorized.share, selector: authorized.effectiveSelector };
        const input = await readJsonObject(request);
        const originId = parseString(input.originId, "originId", MAX_ORIGIN_ID_CHARS);
        // A share's origin space is shared between the recipient's
        // own pushes and the streams accept mints for its proposals. The
        // recipient names its half; this prefix is the relay's, and a client
        // that claimed it could take sequence numbers out of an accept stream.
        if (originId.startsWith(PROPOSAL_ORIGIN_PREFIX)) {
          throw badRequest(`originId must not start with "${PROPOSAL_ORIGIN_PREFIX}"`);
        }
        if (!Array.isArray(input.ops)) throw badRequest("ops must be an array");
        if (input.ops.length > MAX_OPS_PER_REQUEST) throw badRequest("too many ops");
        // Authorship runs before the filter and parseLogOp so neither admits nor
        // freezes a payload whose claimed author is missing or forged (MU-C0).
        assertChatAuthorship(input.ops, actor.userId);
        // Batch-aware channel scoping: a thread created earlier in this batch
        // is a valid target for later ops in the same batch (the composer's
        // thread.create + first message.append), but the log's earliest
        // binding always wins over the batch — a batch cannot re-bind an
        // existing thread.
        const pendingThreadBindings = new Map<string, string>();
        // The path sibling of the same rule, for a file share. A
        // recipient's `chat.thread.create` names the granted PATH (its own
        // object ids mean nothing here), and the message it composes with
        // rides in the same batch.
        const pendingThreadFiles = new Map<string, ThreadFileBinding>();
        const resolver: ChatShareThreadResolver = {
          channelKind: (channelWireId) =>
            storage.findChannelCreateKind(share.workspaceId, channelWireId),
          threadChannelWireId: (threadId) => {
            const stored = storage.findThreadCreateChannelWireId(share.workspaceId, threadId);
            return stored !== undefined ? stored : pendingThreadBindings.get(threadId);
          },
          threadFileBinding: (threadId) => {
            const stored = storage.findThreadCreateFileBinding(share.workspaceId, threadId);
            return stored !== undefined ? stored : pendingThreadFiles.get(threadId);
          },
          objectCurrentPath: (objectId) =>
            storage.objectCurrentPath(share.workspaceId, objectId),
          objectIdAtPath: (path) => storage.objectIdAtPath(share.workspaceId, path),
        };
        const ops = input.ops.map(parseLogOp);
        for (const op of ops) {
          // The write filter, never the read one: what a recipient may see is
          // not what it may push into the granter's log (#646 PR3-0).
          const decision = filterOpForShareAppend(
            share.selector,
            op.opKind,
            op.payloadJson,
            resolver,
          );
          if (!decision.allowed) throw relayError("share_op_rejected");
          // Persist the filter's (possibly redacted) copy, never the pusher's
          // original bytes: the owner bucket is read back over the UNfiltered
          // owner lane, so any field the filter withholds (e.g. a member
          // attachment's objectId/pathHint) must not survive the append.
          op.payloadJson = JSON.stringify(decision.payload);
          if (op.opKind === "chat.thread.create") {
            // Read back from the served copy assigned above, which carries the
            // path this relay proved — never the pusher's own string.
            const created = JSON.parse(op.payloadJson) as {
              threadId?: unknown;
              linkedPath?: unknown;
            };
            const threadId = created.threadId;
            if (typeof threadId === "string" && threadId.length > 0) {
              if (isChatChannelSelector(share.selector)) {
                pendingThreadBindings.set(threadId, share.selector.channelWireId);
              } else if (
                typeof created.linkedPath === "string" &&
                created.linkedPath.length > 0
              ) {
                // The accept door converts the binding.
                //
                // A recipient names its file by path because its own object
                // ids mean nothing here. This is the one moment the relay can
                // turn that into the granter's own object id: the filter just
                // proved an object sits at this exact path. Persisting the
                // object id instead of the path is what makes a recipient's
                // thread behave like the granter's — it follows the file
                // through a rename inside the share, and stops at one that
                // leaves it, because both answers come from the same
                // object→path lookup.
                //
                // Rewriting a payload before persisting is what this route
                // already does: the served copy above is a redaction, and the
                // path in it was normalized by the filter.
                const objectId = storage.objectIdAtPath(
                  share.workspaceId,
                  created.linkedPath,
                );
                // The filter admitted this op by proving an object is there,
                // so this is unreachable through the filter's own path. A
                // batch that reaches it is refused whole rather than stored as
                // a thread bound to nothing.
                if (!objectId) throw relayError("share_op_rejected");
                const bound: Record<string, unknown> = { ...created };
                delete bound.linkedPath;
                bound.linkedObjectId = objectId;
                op.payloadJson = JSON.stringify(bound);
                pendingThreadFiles.set(threadId, { kind: "object", objectId });
              }
            }
          }
        }
        const result = storage.appendLogBatch({
          workspaceId: share.workspaceId,
          // Namespaced per share (= per member): member origins live in their
          // own corner of the owner bucket's origin space.
          originId: `share:${share.shareId}:${originId}`,
          ops,
          // Close the revoke race completely: the share is re-verified inside
          // the append's own BEGIN IMMEDIATE transaction (the same write lock
          // revokeShare takes), so a revoke committed after the entry check
          // above can never slip a write in — the guard sees it and the whole
          // batch rolls back as the same generic 404. The guard re-runs the
          // full appendability gauntlet: recipient-owned, unrevoked, granter
          // in standing, and still a selector that accepts appends at its
          // current level on the same workspace bucket — a level
          // narrowed mid-flight loses the race the same way a revoke does.
          guard: shareActionGuard(
            route.shareId,
            actor.userId,
            "append",
            share.workspaceId,
          ),
        });
        if (result.inserted > 0) {
          discussionActivity.wake(`log:${share.workspaceId}`);
        }
        return jsonResponse({
          ok: true,
          accepted: ops.length,
          inserted: result.inserted,
          skipped: result.skipped,
          currentMaxOriginSeq: result.currentMaxOriginSeq,
        });
      }
      if (route.route === "share-log") throw relayError("method_not_allowed");

      if (route.route === "share-blob" && request.method === "GET") {
        await claimPendingShares(actor.userId);
        const authorized = requireShareAction(route.shareId, actor.userId, "read");
        const share = { ...authorized.share, selector: authorized.effectiveSelector };
        assertSha256(route.sha256);
        // A blob is served to a recipient only when at least one op that
        // passes the share filter legitimately references it. Everything
        // else — a blob of an unshared file, a secret ciphertext blob, a
        // random hash — is the same generic 404 as a nonexistent share.
        // Chat shares expose no blob because their filter decisions name none.
        const blob = historicalSharedBlob(
          share.workspaceId,
          share.selector,
          route.sha256,
        );
        if (!blob) throw notFound();
        // Re-check revocation immediately before returning the blob body: a
        // revoke that raced with this in-flight read must abort rather than
        // serve a final shared blob. The re-load throws the same generic 404.
        requireShareAction(route.shareId, actor.userId, "read");
        return new Response(arrayBufferForBytes(blob), {
          status: 200,
          headers: { "content-type": "application/octet-stream" },
        });
      }
      // A recipient's blob, charged to the GRANTER's workspace.
      // Same level gate as the proposal route, same refusal, so a probe cannot
      // tell the level from the code.
      //
      // It needs no bound of its own. Three already apply and all three are
      // the granter's: MAX_BLOB_BYTES per blob, the granter's workspace quota
      // per workspace (`putBlob` charges it), and the unreferenced-blob sweep,
      // which reclaims anything no open proposal claims. A blob count would
      // bound bytes less tightly than the byte quota that already refuses
      // them.
      if (route.route === "share-blob" && request.method === "PUT") {
        await claimPendingShares(actor.userId);
        const authorized = requireShareAction(route.shareId, actor.userId, "propose");
        const share = { ...authorized.share, selector: authorized.effectiveSelector };
        assertSha256(route.sha256);
        const bytes = await readBytes(request, MAX_BLOB_BYTES);
        const actual = sha256Hex(bytes);
        if (actual !== route.sha256) {
          throw badRequest("blob content does not match sha256 path");
        }
        const put = storage.putBlob({
          workspaceId: share.workspaceId,
          sha256: route.sha256,
          content: bytes,
          createdAtMs: nowMs(),
        });
        // Re-check the grant immediately before answering, mirroring the read
        // routes: a revoke that raced this upload aborts rather than
        // confirming a write into the granter's workspace.
        requireShareAction(route.shareId, actor.userId, "propose");
        return jsonResponse({
          ok: true,
          shareId: route.shareId,
          sha256: route.sha256,
          byteLength: put.byteLength,
        });
      }
      if (route.route === "share-blob") throw relayError("method_not_allowed");

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

async function readBytes(request: Request, maxBytes: number): Promise<Uint8Array> {
  const length = request.headers.get("content-length");
  if (length !== null && Number(length) > maxBytes) throw relayError("payload_too_large");
  const bytes = new Uint8Array(await request.arrayBuffer());
  if (bytes.byteLength > maxBytes) throw relayError("payload_too_large");
  return bytes;
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

function parseLogOp(value: unknown): SyncRelayLogInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw badRequest("each op must be a JSON object");
  }
  const op = value as Record<string, unknown>;
  const originSeq = Number(op.originSeq);
  if (!Number.isInteger(originSeq) || originSeq < 0) {
    throw badRequest("originSeq must be a non-negative integer");
  }
  const opKind = parseString(op.opKind, "opKind", MAX_OP_KIND_CHARS);
  if (!op.payload || typeof op.payload !== "object" || Array.isArray(op.payload)) {
    throw badRequest("payload must be a JSON object");
  }
  const recordedAtMs = op.recordedAtMs;
  if (typeof recordedAtMs !== "number" || !Number.isSafeInteger(recordedAtMs)) {
    throw badRequest("recordedAtMs must be an integer in the safe wire range");
  }
  const payloadJson = stableJsonStringify(op.payload);
  if (Buffer.byteLength(payloadJson, "utf8") > MAX_PAYLOAD_JSON_BYTES) {
    throw badRequest("payload is too large");
  }
  return { originSeq, opKind, payloadJson, recordedAtMs };
}

// MU-C0 verified authorship. The relay authenticates who is pushing
// (actor.userId, server-derived from the Better Auth session — a client cannot
// assert it). For every chat op that names an author, that author must be the
// pusher, or the whole batch is rejected. This is the one place the relay reads
// into a chat payload — a second narrow, tested relaxation of "payloads are
// opaque", after PR-18's share filter, scoped to the author field, fail-closed.
//
// FAIL-CLOSED COMPLETENESS. The chat.* namespace is exhaustive here: every
// chat op is either an explicitly-enumerated structural (no-author) op or an
// authored op with a known author field. An unknown/unmapped chat.* op (a
// future chat.thread.update, chat.message.edit,...) is rejected, never
// admitted unverified — shipping a new authored chat op without extending this
// policy fails closed, not open. Non-chat ops stay fully opaque and pass
// through untouched.
//
// Author identity is always the OPAQUE relay user id (never a raw email — PII
// must not enter the replicated CRDT):
//  - chat.message.append.authorUserId — REQUIRED. Messages without a verified
//    relay identity stay in the local engine and never enter a relay log.
//  - chat.reaction.set.authorId       — REQUIRED. A reaction is inherently an
//    authored act, so a missing/non-string author id is a malformed op and is
//    rejected (fail-closed), same as a mismatch.
//  - chat.decision.set / chat.attachment.add carry no author field. They are
//    derived from messages whose authorship was already verified, so they are
//    explicitly structural here and receive no separate authorship assertion.
//
// A future authored chat op is verified by adding it to CHAT_OP_POLICY; a
// future no-author chat op by enumerating it as "structural".
type ChatOpPolicy =
  | { kind: "structural" }
  | {
      kind: "authored";
      field: string;
    };
const CHAT_OP_POLICY: Record<string, ChatOpPolicy> = {
  // No-author structural/derived ops: nothing to verify, pass through.
  "chat.channel.create": { kind: "structural" },
  "chat.thread.create": { kind: "structural" },
  "chat.decision.set": { kind: "structural" },
  "chat.attachment.add": { kind: "structural" },
  // Authored ops: a present author field must equal the authenticated pusher.
  "chat.message.append": {
    kind: "authored",
    field: "authorUserId",
  },
  "chat.reaction.set": { kind: "authored", field: "authorId" },
  // Receiver-private state still rides the owner's ordinary workspace log.
  // It never appears in a channel share, and the authenticated pusher must be
  // the receiver named by the durable record.
  "chat.follow.set": { kind: "authored", field: "ownerUserId" },
  "chat.feed.read.set": { kind: "authored", field: "ownerUserId" },
};

// Verifies chat authorship before parseLogOp freezes the exact payload bytes.
// The relay never mutates replicated payloads because the author reads its own
// operations back and compares those bytes with its local replication log.
function assertChatAuthorship(
  rawOps: unknown[],
  actorUserId: string,
): void {
  for (const rawOp of rawOps) {
    if (!rawOp || typeof rawOp !== "object" || Array.isArray(rawOp)) continue;
    const op = rawOp as Record<string, unknown>;
    const opKind = op.opKind;
    if (typeof opKind !== "string") continue;
    // Only chat.* ops are subject to the authorship gate; everything else is an
    // opaque payload and passes through even if it carries an author-shaped field.
    if (!opKind.startsWith("chat.")) continue;
    const policy = CHAT_OP_POLICY[opKind];
    if (!policy) throw relayError("unknown_chat_op"); // fail-closed: an unrecognized chat op.
    if (policy.kind === "structural") continue;
    const payload = op.payload;
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      // An authored op with no object payload cannot be verified — reject
      // (fail-closed). parseLogOp would also reject it, but authorship first.
      throw relayError("authorship_mismatch");
    }
    const bag = payload as Record<string, unknown>;
    const claimed = bag[policy.field];
    if (claimed === undefined || claimed === null) {
      throw relayError("authorship_mismatch");
    }
    if (typeof claimed !== "string" || claimed !== actorUserId) {
      throw relayError("authorship_mismatch");
    }
  }
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

function arrayBufferForBytes(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}
