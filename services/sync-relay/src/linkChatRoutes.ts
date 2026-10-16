import type { TokenBucketLimiter } from "@dohc/service-http";
import type { DiscussionActivityHub } from "./discussionActivity";
import { badRequest, notFound, relayError } from "./errors";
import type { ValidatedLinkCapability } from "./linkSecurity";
import { MAX_BROWSER_CHAT_FOLLOWS_PER_WORKSPACE, readSharedChannelPage, type NamedChatMessage } from "./namedRecipientChat";
import { parseString } from "./requestInputs";
import { authorizeLinkChatAction } from "./shareAuthorization";
import type { createShareReadQueries } from "./shareReadQueries";
import type { SyncRelayStorage } from "./storage";

export type LinkChatRoute = { route: "link-chat-channels" } | { route: "link-chat-messages" };

export const LINK_CHAT_MAX_RESPONSE_BYTES = 1024 * 1024;

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

// A link on a Group share reads the Group's channel: the share label and
// the channel's messages with their authors' names. It never sees account
// IDs, the members, other channels, reactions, or attachments.
export function createLinkChatRoutes(options: {
  storage: Pick<SyncRelayStorage,
    | "fetchChatMessages"
    | "findChannelCreateKind"
    | "getShare"
    | "getShareGrant"
    | "getShareLabels"
    | "workspaceIsOwnedBy"
  >;
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
  activity: Pick<DiscussionActivityHub, "wait">;
  reads: Pick<ReturnType<typeof createShareReadQueries>, "chatResolverFor">;
  maxResponseBytes?: number;
}) {
  const { storage } = options;
  const followsByWorkspace = new Map<string, number>();
  return async (request: Request, route: LinkChatRoute): Promise<Response> => {
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
      const name = storage.getShareLabels(share.shareId).subjectName;
      const fresh = current();
      return respond({ shareId: share.shareId, channels: [{ channelWireId, name, access: fresh.effectiveSelector.access }] });
    }
    if (parseString(url.searchParams.get("channelWireId"), "channelWireId", 256) !== channelWireId) throw notFound();
    const following = url.searchParams.has("since");
    if (following) {
      const count = followsByWorkspace.get(share.workspaceId) ?? 0;
      if (count >= MAX_BROWSER_CHAT_FOLLOWS_PER_WORKSPACE) throw relayError("link_read_rate_limited");
      followsByWorkspace.set(share.workspaceId, count + 1);
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
        const count = (followsByWorkspace.get(share.workspaceId) ?? 1) - 1;
        if (count === 0) followsByWorkspace.delete(share.workspaceId); else followsByWorkspace.set(share.workspaceId, count);
      }
    }
  };
}
