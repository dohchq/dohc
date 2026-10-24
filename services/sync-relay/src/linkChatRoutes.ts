import { readBoundedJson, type TokenBucketLimiter } from "@dohc/service-http";
import { LINK_SECRET_PATTERN } from "@dohc/security-contract/wire-patterns";
import type { DiscussionActivityHub } from "./discussionActivity";
import { badRequest, notFound, relayError } from "./errors";
import { linkRefusal } from "./linkRefusal";
import { hashLinkProfileSecret, type ValidatedLinkCapability } from "./linkSecurity";
import { MAX_BROWSER_CHAT_FOLLOWS_PER_WORKSPACE, messageFromOp, readSharedChannelPage, type NamedChatMessage } from "./namedRecipientChat";
import { parseString } from "./requestInputs";
import { authorizeLinkChatAction } from "./shareAuthorization";
import type { createShareReadQueries } from "./shareReadQueries";
import type { SyncRelayStorage } from "./storage";
import type { AppendLinkChatPostResult } from "./storage/linkChat";

export type LinkChatRoute = { route: "link-chat-channels" } | { route: "link-chat-messages" };

export const LINK_CHAT_MAX_RESPONSE_BYTES = 1024 * 1024;
// An 8,000-byte body, escaped, with its thread, name and retry key.
export const LINK_CHAT_MAX_POST_BYTES = 64 * 1024;
const POST_FIELDS = new Set(["channelWireId", "threadId", "body", "claimedName", "idempotencyKey"]);
// Every holder of one link shares its follows, so one link cannot take all
// of its workspace's.
export const MAX_LINK_CHAT_FOLLOWS_PER_GRANT = 32;

// What a link holder sees of a message: no account IDs.
export type LinkChatMessage = Omit<NamedChatMessage, "authorUserId">;

function linkChatMessage(message: NamedChatMessage): LinkChatMessage {
  return {
    relaySeq: message.relaySeq,
    messageId: message.messageId,
    threadId: message.threadId,
    authorDisplayName: message.authorDisplayName,
    authorKind: message.authorKind,
    authorOwnerDisplayName: message.authorOwnerDisplayName,
    createdAtMs: message.createdAtMs,
    body: message.body,
    bodyTooLarge: message.bodyTooLarge,
  };
}

function refusePost(reason: Exclude<AppendLinkChatPostResult, { ok: true }>["reason"]): Response {
  switch (reason) {
    case "read-only": return linkRefusal("link_view_access");
    case "paused": throw relayError("link_discussion_paused");
    case "blocked": throw relayError("link_discussion_blocked");
    case "rate-limit": throw relayError("link_read_rate_limited");
    case "principal-limit":
    case "lifetime-limit":
    case "share-limit": throw relayError("discussion_limit_reached", "chat message limit reached");
    case "workspace-quota": throw relayError("quota_exceeded");
    case "name-already-set": throw relayError("link_name_already_set");
    case "idempotency-conflict": throw relayError("conflict", "idempotency key was already used for a different message");
    case "invalid-input": throw badRequest("chat message is invalid");
    case "not-authorized": throw notFound();
  }
}

// A link on a Group share reads the Group's channel: the share label and
// the channel's messages with their authors' names. It never sees account
// IDs, the members, other channels, reactions, or attachments. A read-write
// link also posts there, as its link principal.
export function createLinkChatRoutes(options: {
  storage: Pick<SyncRelayStorage,
    | "appendLinkChatPost"
    | "fetchChatMessages"
    | "findChannelCreateKind"
    | "getShare"
    | "getShareGrant"
    | "getShareLabels"
    | "getLinkPrincipalForGrantProfile"
    | "workspaceIsOwnedBy"
  >;
  linkKey: string | Uint8Array | undefined;
  nowMs: () => number;
  requireLinkRead: (
    request: Request,
    capabilityRateLimiter: TokenBucketLimiter,
    grantRateLimiter: TokenBucketLimiter,
  ) => { capabilityToken: string; capability: ValidatedLinkCapability };
  requireFreshLinkRead: (
    capabilityToken: string,
    expected: { shareId: string; grantId: string; generation: number },
  ) => ValidatedLinkCapability;
  linkJsonResponse: (shareId: string, grantId: string, body: unknown) => Response;
  readLimiters: { capability: TokenBucketLimiter; grant: TokenBucketLimiter };
  followLimiters: { capability: TokenBucketLimiter; grant: TokenBucketLimiter };
  activity: Pick<DiscussionActivityHub, "wait" | "wake" | "wakeLog">;
  reads: Pick<ReturnType<typeof createShareReadQueries>, "chatResolverFor">;
  maxResponseBytes?: number;
}) {
  const { storage } = options;
  const followsByWorkspace = new Map<string, number>();
  const followsByGrant = new Map<string, number>();
  const release = (counts: Map<string, number>, key: string) => {
    const count = (counts.get(key) ?? 1) - 1;
    if (count === 0) counts.delete(key); else counts.set(key, count);
  };
  // Who posts comes from the capability and the profile secret alone. The
  // request names no workspace, share, grant or author, and an account
  // cookie is refused, so it can never change who the author is.
  const post = async (request: Request): Promise<Response> => {
    const secret = request.headers.get("x-dohc-link-profile-secret");
    if (!options.linkKey || request.headers.has("cookie") || new URL(request.url).search !== "" ||
        !secret || !LINK_SECRET_PATTERN.test(secret)) throw notFound();
    const { capabilityToken, capability } = options.requireLinkRead(request, options.readLimiters.capability, options.readLimiters.grant);
    if (request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") {
      throw badRequest("invalid request");
    }
    let value: unknown;
    try {
      value = await readBoundedJson(request, LINK_CHAT_MAX_POST_BYTES, request.signal);
    } catch (error) {
      if (request.signal.aborted) throw error;
      throw error instanceof RangeError ? relayError("payload_too_large") : badRequest("invalid request");
    }
    if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some(key => !POST_FIELDS.has(key))) {
      throw badRequest("invalid request");
    }
    const input = value as Record<string, unknown>;
    const { body, idempotencyKey, threadId, claimedName } = input;
    if (typeof body !== "string" || typeof idempotencyKey !== "string" ||
        (threadId !== undefined && typeof threadId !== "string") ||
        (claimedName !== undefined && typeof claimedName !== "string")) throw badRequest("invalid request");
    const channelWireId = parseString(input.channelWireId, "channelWireId", 256);
    const fresh = options.requireFreshLinkRead(capabilityToken, capability);
    const result = storage.appendLinkChatPost({
      capabilityHash: fresh.session.capabilityHash,
      profileTokenHash: hashLinkProfileSecret(secret, options.linkKey),
      grantId: fresh.grantId,
      generation: fresh.generation,
      channelWireId,
      threadId: threadId ?? null,
      body,
      claimedName: claimedName ?? null,
      idempotencyKey,
      createdAtMs: options.nowMs(),
    });
    if (!result.ok) return refusePost(result.reason);
    if (!result.replayed) options.activity.wakeLog(result.workspaceId);
    if (result.enrolled) options.activity.wake(result.shareId);
    const message = messageFromOp({ relaySeq: result.row.relaySeq, opKind: result.row.opKind, payload: JSON.parse(result.row.payloadJson) },
      result.row.originId);
    if (!message) throw new Error("stored link post is not a chat message");
    const response = options.linkJsonResponse(fresh.shareId, fresh.grantId, { shareId: fresh.shareId, channelWireId, message: linkChatMessage(message) });
    response.headers.set("cache-control", "private, no-store");
    return response;
  };
  return async (request: Request, route: LinkChatRoute): Promise<Response> => {
    if (route.route === "link-chat-messages" && request.method === "POST") return post(request);
    if (request.method !== "GET") throw relayError("method_not_allowed");
    const url = new URL(request.url);
    const channels = route.route === "link-chat-channels";
    const limiters = channels ? options.readLimiters : options.followLimiters;
    const { capabilityToken, capability } = options.requireLinkRead(request, limiters.capability, limiters.grant);
    const allowed = channels ? [] : ["channelWireId", "before", "since", "hold", "limit"];
    if ([...url.searchParams.keys()].some(key => !allowed.includes(key) || url.searchParams.getAll(key).length !== 1)) {
      throw badRequest("invalid query");
    }
    // Revoking or rotating the link, or the channel ceasing to be an
    // ordinary channel, fails this on the next read.
    const current = () => {
      const fresh = options.requireFreshLinkRead(capabilityToken, capability);
      const authorized = authorizeLinkChatAction({ storage, grantId: fresh.grantId, action: "read" });
      if (!authorized.ok) throw notFound();
      return authorized;
    };
    const authority = current();
    const { share } = authority;
    const { channelWireId } = authority.effectiveSelector;
    const respond = (body: unknown) => {
      const response = options.linkJsonResponse(share.shareId, capability.grantId, body);
      response.headers.set("cache-control", "private, no-store");
      return response;
    };
    if (channels) {
      // The name this browser or agent already set, so it is not asked again.
      const profile = request.headers.get("x-dohc-link-profile-secret"), { linkKey } = options;
      if (profile !== null && (!linkKey || !LINK_SECRET_PATTERN.test(profile))) throw notFound();
      const profileName = profile === null || !linkKey ? null
        : storage.getLinkPrincipalForGrantProfile(capability.grantId, hashLinkProfileSecret(profile, linkKey))?.displayName ?? null;
      const name = storage.getShareLabels(share.shareId).subjectName;
      const fresh = current();
      return respond({ shareId: share.shareId, profileName, channels: [{ channelWireId, name, access: fresh.effectiveSelector.access }] });
    }
    if (parseString(url.searchParams.get("channelWireId"), "channelWireId", 256) !== channelWireId) throw notFound();
    const following = url.searchParams.has("since");
    if (following) {
      const count = followsByWorkspace.get(share.workspaceId) ?? 0;
      const linkCount = followsByGrant.get(capability.grantId) ?? 0;
      if (count >= MAX_BROWSER_CHAT_FOLLOWS_PER_WORKSPACE || linkCount >= MAX_LINK_CHAT_FOLLOWS_PER_GRANT) {
        throw relayError("link_read_rate_limited");
      }
      followsByWorkspace.set(share.workspaceId, count + 1);
      followsByGrant.set(capability.grantId, linkCount + 1);
    }
    try {
      return respond(await readSharedChannelPage({
        storage, resolver: options.reads.chatResolverFor(share.workspaceId), selector: authority.effectiveSelector,
        workspaceId: share.workspaceId, shareId: share.shareId, channelWireId, query: url.searchParams,
        recheck: () => {
          if (current().effectiveSelector.channelWireId !== channelWireId) throw notFound();
        },
        activity: options.activity, waiter: `link:${capability.session.capabilityHash}`, signal: request.signal,
        maxResponseBytes: options.maxResponseBytes ?? LINK_CHAT_MAX_RESPONSE_BYTES, busyCode: "link_read_rate_limited",
        project: linkChatMessage,
      }));
    } finally {
      if (following) {
        release(followsByWorkspace, share.workspaceId);
        release(followsByGrant, capability.grantId);
      }
    }
  };
}
