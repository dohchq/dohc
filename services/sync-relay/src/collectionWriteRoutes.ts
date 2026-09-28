import { createHash } from "node:crypto";
import { jsonResponse, TokenBucketLimiter } from "@dohc/service-http";
import type { PublicEditRelease } from "@dohc/security-contract";
import { LINK_SECRET_PATTERN } from "@dohc/security-contract/wire-patterns";
import type { DiscussionActivityHub } from "./discussionActivity";
import { badRequest, errorResponse, notFound, relayError, RelayError, RELAY_ERRORS } from "./errors";
import { hashLinkProfileSecret, isPublicLinkAccess, type ValidatedLinkCapability } from "./linkSecurity";
import { readStreamedBytes } from "./relayBytes";
import { parseString } from "./requestInputs";
import { namedCollectionEditGrant } from "./collectionEditGrant";
import { collectionEditSelector, filterCollectionWriteForShare, MAX_COLLECTION_WRITE_BYTES, MAX_NEW_COLLECTION_RECORDS, pathVisibleThroughShare } from "./shareFilter";
import { CollectionWriteStaleError, type CommitCollectionWriteInput, type SyncRelayStorage } from "./storage";

export type CollectionWriteRoute = { route: "share-collection-writes"; shareId: string };
export type LinkCollectionWriteRoute = { route: "link-collection-writes" };
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
// A link sends its content in the request, as base64: the 4 MiB a write may
// carry, a third larger, and the same metadata a named write sends.
export const MAX_LINK_COLLECTION_WRITE_BODY_BYTES = 7 * 1024 * 1024;
// Link write bodies held in memory at once: one per link, four per relay.
export const LINK_COLLECTION_WRITES_IN_FLIGHT = 4;
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/u;

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
    return commit(storage, {
      shareId: share.shareId,
      grantId: grant.grantId,
      grantGeneration: grant.generation,
      writer: { kind: "named", userId: actorUserId },
      submitId,
      rawChanges: body.changes,
      write: decision.write,
      nowMs: input.nowMs(),
      newId: input.newId,
    }, share.workspaceId, input.discussionActivity);
  };
}

// The shared commit, and how the two routes answer it: a stale base names
// the current file so its writer keeps their text and tries again.
function commit(
  storage: SyncRelayStorage,
  input: CommitCollectionWriteInput,
  workspaceId: string,
  discussionActivity: Pick<DiscussionActivityHub, "wake">,
  headers: Record<string, string> = {},
): Response {
  let committed: ReturnType<typeof storage.commitCollectionWrite>;
  try {
    committed = storage.commitCollectionWrite(input);
  } catch (error) {
    if (!(error instanceof CollectionWriteStaleError)) throw error;
    return jsonResponse({
      ok: false,
      error: error.message,
      code: RELAY_ERRORS.stale.code,
      path: error.path,
      currentBlobSha256: error.currentBlobSha256,
    }, RELAY_ERRORS.stale.status, headers);
  }
  if (committed.created) discussionActivity.wake(`log:${workspaceId}`);
  return jsonResponse({ ok: true, ...committed.receipt, created: committed.created }, 200, headers);
}

/** How many link write bodies the relay holds at once: one per link, and a few in all. */
export function createLinkCollectionWriteAdmission(limit = LINK_COLLECTION_WRITES_IN_FLIGHT) {
  const reading = new Set<string>();
  return {
    /** A release for the caller to call when the body is done with, or null when the relay is full. */
    admit(grantId: string): (() => void) | null {
      if (reading.has(grantId) || reading.size >= limit) return null;
      reading.add(grantId);
      let released = false;
      return () => {
        if (released) return;
        released = true;
        reading.delete(grantId);
      };
    },
  };
}
export type LinkCollectionWriteAdmission = ReturnType<typeof createLinkCollectionWriteAdmission>;

const NO_STORE = { "cache-control": "private, no-store" };

/**
 * `POST /sync/link/collection-writes`: whoever holds an Edit share link
 * writes a Collection's own files directly (ADR 0013), a person in a
 * browser or an agent alike. Authority comes from the link capability and
 * the profile secret alone: the request names content, paths, bases, and a
 * submit id, never a workspace, share, grant, or author. The relay hashes
 * the content, and the write is authorized again inside its transaction.
 * An account cookie is refused, so it can never change who the author is.
 */
export function createLinkCollectionWriteRoute(input: {
  storage: SyncRelayStorage;
  rateLimiter: TokenBucketLimiter;
  admission: LinkCollectionWriteAdmission;
  linkKey: string | Uint8Array;
  publicEditRelease?: PublicEditRelease;
  requireLinkCapability(request: Request): { capability: ValidatedLinkCapability };
  nowMs: () => number;
  newId: () => string;
  discussionActivity: Pick<DiscussionActivityHub, "wake">;
}) {
  const { storage } = input;
  return async function respondToLinkCollectionWrites(request: Request): Promise<Response> {
    if (request.headers.has("cookie") || new URL(request.url).search !== "") throw notFound();
    const { capability } = input.requireLinkCapability(request);
    const secret = request.headers.get("x-dohc-link-profile-secret");
    if (!secret || !LINK_SECRET_PATTERN.test(secret)) throw notFound();
    // An Edit link only, on a relay that released Edit links. A View or
    // Comment link learns nothing a missing share would not tell it.
    if (capability.access !== "edit" || !isPublicLinkAccess(capability.access, input.publicEditRelease)) {
      throw notFound();
    }
    const profileTokenHash = hashLinkProfileSecret(secret, input.linkKey);
    const requireCurrentWriter = () => storage.authorizeLinkCollectionWrite({
      shareId: capability.shareId,
      grantId: capability.grantId,
      grantGeneration: capability.generation,
      capabilityHash: capability.session.capabilityHash,
      profileTokenHash,
      nowMs: input.nowMs(),
    });
    const { share } = requireCurrentWriter();
    let release: (() => void) | null = null;
    let body: Record<string, unknown> | undefined;
    const requireScope = (current: ReturnType<typeof requireCurrentWriter>) => {
      const selector = collectionEditSelector(current.effectiveSelector);
      if (!selector) throw notFound();
      if (!Array.isArray(body?.changes)) return;
      // linkChanges rejects oversized batches without inspecting their entries.
      if (body.changes.length > MAX_NEW_COLLECTION_RECORDS + 2) return;
      for (const change of body.changes) {
        for (const path of [change?.basedOnPath, change?.afterPath]) {
          if (typeof path === "string" && !pathVisibleThroughShare(selector, path)) throw notFound();
        }
      }
    };
    try {
      if (request.method !== "POST") throw relayError("method_not_allowed");
      if (request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") {
        throw badRequest("Collection writes require JSON.");
      }
      // Every holder of the link, in every browser and after any rotation,
      // spends the link's own tokens, before any body is read.
      if (!input.rateLimiter.allow(capability.grantId, input.nowMs())) {
        throw relayError("collection_write_rate_limited");
      }
      release = input.admission.admit(capability.grantId);
      if (!release) throw relayError("collection_write_rate_limited");
      body = await readBody(request, MAX_LINK_COLLECTION_WRITE_BODY_BYTES);
      const current = requireCurrentWriter();
      requireScope(current);
      // Only what a write is: who writes comes from the capability.
      if (Object.keys(body).some((key) => key !== "submitId" && key !== "changes")) {
        throw relayError("share_op_rejected");
      }
      const submitId = parseString(body.submitId, "submitId", MAX_SUBMIT_ID_CHARS);
      const { changes, content } = linkChanges(body.changes);
      const decision = filterCollectionWriteForShare(current.effectiveSelector, changes, {
        channelKind: (wireId) => storage.findChannelCreateKind(share.workspaceId, wireId),
      });
      if (!decision.allowed) throw relayError("share_op_rejected");
      return commit(storage, {
        shareId: capability.shareId,
        grantId: capability.grantId,
        grantGeneration: capability.generation,
        writer: {
          kind: "link",
          capabilityHash: capability.session.capabilityHash,
          profileTokenHash,
          content,
          now: input.nowMs,
        },
        submitId,
        rawChanges: changes,
        write: decision.write,
        nowMs: input.nowMs(),
        newId: input.newId,
      }, share.workspaceId, input.discussionActivity, NO_STORE);
    } catch (error) {
      requireScope(requireCurrentWriter());
      if (!(error instanceof RelayError) || error.code === "not_found") throw error;
      const response = errorResponse(error);
      response.headers.set("cache-control", "private, no-store");
      return response;
    } finally {
      release?.();
    }
  };
}

// Each change as a link sends it: the fields a named write sends, except
// that the content comes as base64 in place of its hash and size, which the
// relay computes. A change that names a hash or a size of its own is
// refused, so a link can never point at bytes it did not send.
const LINK_CHANGE_KEYS = new Set([
  "basedOnPath", "basedOnBlobSha256", "operation", "afterPath", "afterContentKind", "afterContentBase64", "recordedAtMs",
]);

function linkChanges(raw: unknown): { changes: Record<string, unknown>[]; content: Map<string, Uint8Array> } {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_NEW_COLLECTION_RECORDS + 2) {
    throw relayError("share_op_rejected");
  }
  const content = new Map<string, Uint8Array>();
  let total = 0;
  const changes = raw.map((entry: unknown) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw relayError("share_op_rejected");
    const record = entry as Record<string, unknown>;
    if (Object.keys(record).some((key) => !LINK_CHANGE_KEYS.has(key))) throw relayError("share_op_rejected");
    const encoded = record.afterContentBase64;
    // Refuse before decoding: text a third longer than the write may carry.
    if (typeof encoded !== "string" || encoded.length % 4 !== 0 || !BASE64.test(encoded) ||
        encoded.length > Math.ceil(MAX_COLLECTION_WRITE_BYTES / 3) * 4) {
      throw relayError("share_op_rejected");
    }
    const bytes = Buffer.from(encoded, "base64");
    if (bytes.toString("base64") !== encoded) throw relayError("share_op_rejected");
    total += bytes.byteLength;
    if (total > MAX_COLLECTION_WRITE_BYTES) throw relayError("share_op_rejected");
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    content.set(sha256, new Uint8Array(bytes));
    const { afterContentBase64: _sent, ...change } = record;
    return { ...change, afterBlobSha256: sha256, afterByteLength: bytes.byteLength };
  });
  return { changes, content };
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

async function readBody(request: Request, maxBytes = MAX_COLLECTION_WRITE_BODY_BYTES): Promise<Record<string, unknown>> {
  const bytes = await readStreamedBytes(request, maxBytes, COLLECTION_WRITE_BODY_TIMEOUT_MS);
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
