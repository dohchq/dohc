import { jsonResponse, TokenBucketLimiter } from "@dohc/service-http";
import type { DiscussionActivityHub } from "./discussionActivity";
import { badRequest, notFound, relayError, RELAY_ERRORS } from "./errors";
import { readStreamedBytes } from "./relayBytes";
import { parseString } from "./requestInputs";
import { namedCollectionEditGrant } from "./collectionEditGrant";
import { filterCollectionWriteForShare } from "./shareFilter";
import { CollectionWriteStaleError, type SyncRelayStorage } from "./storage";

export type CollectionWriteRoute = { route: "share-collection-writes"; shareId: string };
export type OwnerCollectionWriteRoute = { route: "owner-collection-writes"; workspaceId: string; grantId: string };

// A burst of 30 direct writes per grant, then one every two seconds.
const COLLECTION_WRITE_BUCKET_CAPACITY = 30;
const COLLECTION_WRITE_REFILL_PER_SECOND = 0.5;
const COLLECTION_WRITE_MAX_GRANTS = 10_000;
const MAX_SUBMIT_ID_CHARS = 128;
// A new Collection's 502 changes with long paths fit well inside this.
export const MAX_COLLECTION_WRITE_BODY_BYTES = 1024 * 1024;
// The body streams in only after the grant and its rate token pass.
const COLLECTION_WRITE_BODY_TIMEOUT_MS = 60_000;

export function createCollectionWriteRateLimiter(): TokenBucketLimiter {
  return new TokenBucketLimiter(
    COLLECTION_WRITE_BUCKET_CAPACITY,
    COLLECTION_WRITE_REFILL_PER_SECOND,
    COLLECTION_WRITE_MAX_GRANTS,
  );
}

/**
 * `POST /sync/shares/:shareId/collection-writes`: a recipient with Edit
 * writes a Collection's own files directly. The relay mints the owner's
 * moments at once, under a named author, instead of holding a proposal.
 * Everything the decision refuses stays on proposals.
 */
export function createCollectionWriteRoutes(input: {
  storage: SyncRelayStorage;
  rateLimiter: TokenBucketLimiter;
  nowMs: () => number;
  newId: () => string;
  claimPendingShares: (userId: string) => Promise<void>;
  discussionActivity: Pick<DiscussionActivityHub, "wake">;
}) {
  const { storage } = input;

  return async function respondToCollectionWrites(
    request: Request,
    route: CollectionWriteRoute,
    actorUserId: string,
  ): Promise<Response> {
    if (request.method !== "POST") throw relayError("method_not_allowed");
    await input.claimPendingShares(actorUserId);
    const authorized = namedCollectionEditGrant(storage, route.shareId, actorUserId);
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

/**
 * `GET /sync/:workspaceId/collection-writes/:grantId`: the owner reads one
 * grant's direct writes, a revoked grant's too, to restore what the person
 * changed. The server checked that the caller owns the workspace.
 */
export function readOwnerCollectionWrites(
  request: Request,
  route: OwnerCollectionWriteRoute,
  ownerUserId: string,
  storage: SyncRelayStorage,
): Response {
  if (request.method !== "GET") throw relayError("method_not_allowed");
  const query = new URL(request.url).searchParams;
  for (const key of query.keys()) {
    if (!["afterOriginSeq", "limit"].includes(key) || query.getAll(key).length !== 1) {
      throw badRequest("Invalid collection write selection.");
    }
  }
  const after = query.get("afterOriginSeq");
  const page = storage.readOwnerCollectionWrites({
    workspaceId: route.workspaceId,
    ownerUserId,
    grantId: route.grantId,
    ...(after === null ? {} : { afterOriginSeq: Number(after) }),
    limit: Number(query.get("limit") ?? 100),
  });
  return new Response(JSON.stringify(page), {
    headers: { "content-type": "application/json", "cache-control": "private, no-store" },
  });
}

async function readBody(request: Request): Promise<Record<string, unknown>> {
  const bytes = await readStreamedBytes(request, MAX_COLLECTION_WRITE_BODY_BYTES, COLLECTION_WRITE_BODY_TIMEOUT_MS);
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
