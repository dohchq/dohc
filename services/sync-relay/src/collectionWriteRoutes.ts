import { jsonResponse, TokenBucketLimiter } from "@dohc/service-http";
import type { DiscussionActivityHub } from "./discussionActivity";
import { badRequest, notFound, relayError, RELAY_ERRORS } from "./errors";
import { readBytes } from "./relayBytes";
import { parseString } from "./requestInputs";
import { authorizeShareGrantAction, type AuthorizedShareAction } from "./shareAuthorization";
import { filterCollectionWriteForShare, type ShareSelector } from "./shareFilter";
import { CollectionWriteStaleError, type SyncRelayStorage } from "./storage";

export type CollectionWriteRoute = { route: "share-collection-writes"; shareId: string };

// A burst of 30 direct writes per grant, then one every two seconds.
const COLLECTION_WRITE_BUCKET_CAPACITY = 30;
const COLLECTION_WRITE_REFILL_PER_SECOND = 0.5;
const COLLECTION_WRITE_MAX_GRANTS = 10_000;
const MAX_SUBMIT_ID_CHARS = 128;
// A new Collection's 502 changes with long paths fit well inside this.
export const MAX_COLLECTION_WRITE_BODY_BYTES = 1024 * 1024;
export const COLLECTION_WRITES_PATH = /^\/sync\/shares\/[^/]+\/collection-writes$/u;

export function createCollectionWriteRateLimiter(): TokenBucketLimiter {
  return new TokenBucketLimiter(
    COLLECTION_WRITE_BUCKET_CAPACITY,
    COLLECTION_WRITE_REFILL_PER_SECOND,
    COLLECTION_WRITE_MAX_GRANTS,
  );
}

/** Direct writes stay off unless a deployment sets DOHC_RELAY_COLLECTION_WRITES=1. */
export function readCollectionWritesConfig(value: string | undefined): boolean {
  if (value === undefined || value === "0") return false;
  if (value !== "1") throw new Error("DOHC_RELAY_COLLECTION_WRITES must be 0 or 1.");
  return true;
}

/**
 * `POST /sync/shares/:shareId/collection-writes`: a recipient with Edit
 * writes a Collection's own files directly. The relay mints the owner's
 * moments at once, under a named author, instead of holding a proposal.
 * Everything the decision refuses stays on proposals.
 */
export function createCollectionWriteRoutes(input: {
  storage: SyncRelayStorage;
  enabled: boolean;
  rateLimiter: TokenBucketLimiter;
  nowMs: () => number;
  newId: () => string;
  claimPendingShares: (userId: string) => Promise<void>;
  discussionActivity: Pick<DiscussionActivityHub, "wake">;
}) {
  const { storage } = input;

  // The caller's own named grant with Edit on files. A grant opened from a
  // public link is refused until the owner promotes it.
  const namedEditGrant = (shareId: string, userId: string): AuthorizedShareAction<ShareSelector> => {
    let denied = false;
    for (const grant of storage.listActiveShareGrantsForRecipient(shareId, userId)) {
      const result = authorizeShareGrantAction({
        storage,
        grantId: grant.grantId,
        action: "propose",
        principal: { kind: "user", userId },
      });
      if (!result.ok) {
        denied ||= result.reason === "denied";
        continue;
      }
      if (result.grant.parentGrantId !== null) {
        denied = true;
        continue;
      }
      return result as AuthorizedShareAction<ShareSelector>;
    }
    throw denied ? relayError("share_read_only") : notFound();
  };

  return async function respondToCollectionWrites(
    request: Request,
    route: CollectionWriteRoute,
    actorUserId: string,
  ): Promise<Response> {
    if (!input.enabled) throw notFound();
    if (request.method !== "POST") throw relayError("method_not_allowed");
    await input.claimPendingShares(actorUserId);
    const authorized = namedEditGrant(route.shareId, actorUserId);
    const { share, grant } = authorized;
    // Every admitted request spends a token before its body is read, so a
    // refused request costs its sender the same as a written one.
    if (!input.rateLimiter.allow(grant.grantId, input.nowMs())) {
      throw relayError("collection_write_rate_limited");
    }
    const body = await readBody(request);
    const submitId = parseString(body.submitId, "submitId", MAX_SUBMIT_ID_CHARS);
    const decision = filterCollectionWriteForShare(authorized.effectiveSelector, body.changes, {
      channelKind: (wireId) => storage.findChannelCreateKind(share.workspaceId, wireId),
    });
    if (!decision.allowed) throw relayError("share_op_rejected");
    let committed: ReturnType<typeof storage.commitCollectionWrite>;
    try {
      committed = storage.commitCollectionWrite({
        shareId: share.shareId,
        grantId: grant.grantId,
        grantGeneration: grant.generation,
        userId: actorUserId,
        submitId,
        rawChanges: body.changes,
        write: decision.write,
        nowMs: input.nowMs(),
        newId: input.newId,
      });
    } catch (error) {
      if (!(error instanceof CollectionWriteStaleError)) throw error;
      return jsonResponse({
        ok: false,
        error: error.message,
        code: RELAY_ERRORS.stale.code,
        path: error.path,
        currentBlobSha256: error.currentBlobSha256,
      }, RELAY_ERRORS.stale.status);
    }
    if (committed.created) input.discussionActivity.wake(`log:${share.workspaceId}`);
    return jsonResponse({ ok: true, ...committed.receipt, created: committed.created });
  };
}

async function readBody(request: Request): Promise<Record<string, unknown>> {
  const bytes = await readBytes(request, MAX_COLLECTION_WRITE_BODY_BYTES);
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw badRequest("request body must be valid JSON");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw badRequest("request body must be a JSON object");
  }
  return value as Record<string, unknown>;
}
