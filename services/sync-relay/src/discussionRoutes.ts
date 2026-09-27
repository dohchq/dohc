import { jsonResponse, type TokenBucketLimiter } from "@dohc/service-http";
import type {PublicEditRelease} from "@dohc/security-contract";
import { LINK_SECRET_PATTERN } from "@dohc/security-contract/wire-patterns";
import type { ResolveActor } from "@dohc/workspace-auth/session";
import {linkRefusal} from "./linkRefusal";
import {
  DiscussionActivityCapacityError,
  type DiscussionActivityHub,
} from "./discussionActivity";
import {
  badRequest,
  errorResponse,
  notFound,
  RELAY_ERRORS,
  relayError,
  RelayError,
} from "./errors";
import {
  hashLinkProfileSecret,
  isPublicLinkAccess,
  type ValidatedLinkCapability,
} from "./linkSecurity";
import { cursorCodec, parseWorkspaceId, readJsonObject } from "./requestInputs";
import type { AuthorizedShareAction } from "./shareAuthorization";
import {
  LINK_DISCUSSION_DELETING_USER_ID_BYTE_LIMIT,
  LINK_DISCUSSION_PAGE_LIMIT,
  normalizeDiscussionDisplayName,
  type SyncRelayShareDiscussionCursor,
  type SyncRelayShareDiscussionMessageRow,
  type SyncRelayShareDiscussionActivityPage,
  type SyncRelayShareDiscussionPage,
  type SyncRelayStorage,
} from "./storage";
import { MAX_DISCUSSION_ACTIVITY_HOLD_MS } from "./wireLimits";

const DEFAULT_DISCUSSION_PAGE_SIZE = 50;
export const DISCUSSION_DISPLAY_NAME_LOOKUP_DEADLINE_MS = 1_000;
const DEFAULT_DISCUSSION_ACTIVITY_HOLD_MS = 25_000;
const DISCUSSION_MODERATION_HANDLE_MAX_CHARS = 512;

type LookupUserDisplayName = (
  userId: string,
) => Promise<string | null> | string | null;

// The account's display name, or null when it has none or the lookup fails
// or runs past its deadline.
export async function accountDisplayName(
  lookupUserDisplayName:
    | LookupUserDisplayName
    | undefined,
  userId: string,
): Promise<string | null> {
  if (!lookupUserDisplayName) return null;

  let lookup: Promise<string | null>;
  try {
    lookup = Promise.resolve(lookupUserDisplayName(userId));
  } catch {
    return null;
  }

  let deadline: ReturnType<typeof setTimeout> | undefined;
  try {
    const deadlineResult = new Promise<null>((resolve) => {
      deadline = setTimeout(
        () => resolve(null),
        DISCUSSION_DISPLAY_NAME_LOOKUP_DEADLINE_MS,
      );
      deadline.unref();
    });
    const lookedUpName = await Promise.race([lookup, deadlineResult]);
    return normalizeDiscussionDisplayName(lookedUpName);
  } catch {
    return null;
  } finally {
    if (deadline) clearTimeout(deadline);
  }
}

export function createDiscussionRoutes(
  storage: Pick<
    SyncRelayStorage,
    | "getShare"
    | "workspaceIsOwnedBy"
    | "listShareDiscussionMessages"
    | "getLinkPrincipalForGrantProfile"
    | "appendLinkDiscussionMessage"
    | "getShareDiscussionRevision"
    | "listShareDiscussionActivity"
    | "appendAuthenticatedDiscussionMessage"
    | "deleteShareDiscussionMessage"
    | "setLinkPrincipalBlocked"
    | "setShareLinkWritesPaused"
  >,
  resolveActor: ResolveActor,
  nowMs: () => number,
  lookupUserDisplayName: LookupUserDisplayName | undefined,
  claimPendingShares: (userId: string) => Promise<void>,
  requireShareAction: (
    shareId: string,
    actorUserId: string,
    action: "read",
  ) => AuthorizedShareAction,
  requireShareWorkspace: (
    share: { workspaceId: string },
    workspaceId: string,
  ) => void,
  linkKey: string | Uint8Array | undefined,
  relayExchangeKeyConfigured: boolean,
  hasValidRelayExchangeKey: (request: Request) => boolean,
  requireLinkRead: (
    request: Request,
    capabilityRateLimiter: TokenBucketLimiter,
    grantRateLimiter: TokenBucketLimiter,
  ) => { capabilityToken: string; capability: ValidatedLinkCapability },
  requireFreshLinkRead: (
    capabilityToken: string,
    expected: { shareId: string; grantId: string; generation: number },
  ) => ValidatedLinkCapability,
  linkJsonResponse: (shareId: string, grantId: string, body: unknown) => Response,
  linkReadRateLimiter: TokenBucketLimiter,
  linkGrantReadRateLimiter: TokenBucketLimiter,
  discussionActivity: Pick<DiscussionActivityHub, "wait" | "wake">,
  publicEditRelease?: PublicEditRelease,
) {
  type DiscussionViewer = "public" | "named" | "owner";

  const privateRefused = (): Response => privateErrorResponse(notFound());

  const privateResponse = (response: Response): Response => {
    response.headers.set("cache-control", "private, no-store");
    return response;
  };

  const privateJsonResponse = (body: unknown, status = 200): Response =>
    privateResponse(jsonResponse(body, status));

  const privateErrorResponse = (error: unknown): Response =>
    privateResponse(errorResponse(error));

  const projectDiscussionMessage = (
    message: SyncRelayShareDiscussionMessageRow & {
      linkPrincipalBlocked?: boolean | null;
    },
    viewer: DiscussionViewer,
  ): Record<string, unknown> => {
    const base = {
      messageId: message.messageId,
      createdAtMs: message.createdAtMs,
      deleted: message.deletedAtMs !== null,
    };
    if (message.deletedAtMs !== null && viewer !== "owner") return base;
    const author =
      message.authorKind === "link"
        ? {
            kind: "link" as const,
            displayName: message.displayNameSnapshot,
            unverified: true as const,
          }
        : {
            kind: "named" as const,
            displayName: message.displayNameSnapshot,
          };
    return {
      ...base,
      ...(message.deletedAtMs === null ? { body: message.body } : {}),
      author,
      ...(viewer === "owner" &&
      message.authorKind === "link" &&
      message.linkGrantId !== null &&
      message.linkPrincipalId !== null
        ? {
            moderation: {
              linkGrantId: message.linkGrantId,
              linkPrincipalId: message.linkPrincipalId,
              blocked: message.linkPrincipalBlocked === true,
            },
          }
        : {}),
    };
  };

  const requireDiscussionAuthority = (
    shareId: string,
    actorUserId: string,
    action: "read" | "append",
    requestedWorkspaceId?: string,
  ): { viewer: "owner" | "named" } => {
    const share = storage.getShare(shareId);
    if (!share) throw notFound();
    if (
      storage.workspaceIsOwnedBy(share.workspaceId, actorUserId)
    ) {
      if (share.workspaceId !== requestedWorkspaceId) throw notFound();
      return { viewer: "owner" };
    }
    if (requestedWorkspaceId !== undefined) throw notFound();
    const authorized = requireShareAction(shareId, actorUserId, "read");
    if (
      action === "append" &&
      authorized.grant.access !== "comment" &&
      authorized.grant.access !== "edit"
    ) {
      throw relayError("share_read_only");
    }
    return { viewer: "named" };
  };

  const isCurrentDiscussionOwner = (
    shareId: string,
    actorUserId: string,
  ): boolean => {
    const share = storage.getShare(shareId);
    return (
      share !== null &&
      storage.workspaceIsOwnedBy(share.workspaceId, actorUserId)
    );
  };

  const discussionPage = (
    page: SyncRelayShareDiscussionPage,
    viewer: DiscussionViewer,
    profileName: string | null = null,
  ): Record<string, unknown> => {
    return {
      ok: true,
      activityRevision: page.activityRevision,
      ...(viewer === "owner"
        ? { linkCommentsPaused: page.linkCommentsPaused }
        : {}),
      ...(viewer === "public" ? { profileName } : {}),
      messages: page.messages.map((message) =>
        projectDiscussionMessage(message, viewer),
      ),
      nextCursor:
        page.nextCursor === null
          ? null
          : discussionCursor.encode(page.nextCursor),
    };
  };

  const discussionActivityPage = (
    page: SyncRelayShareDiscussionActivityPage,
    viewer: DiscussionViewer,
  ): Record<string, unknown> => ({
    ok: true,
    latestRevision: page.latestRevision,
    cursorRevision: page.cursorRevision,
    hasMore: page.hasMore,
    messages: page.messages.map((message) =>
      projectDiscussionMessage(message, viewer),
    ),
    ...(viewer === "owner"
      ? {
          linkCommentsPaused: page.linkCommentsPaused,
          principals: page.principals.map((principal) => ({
            principalId: principal.principalId,
            blocked: principal.blockedAtMs !== null,
          })),
        }
      : {}),
  });

  const publicDiscussionActivityPage = (
    page: SyncRelayShareDiscussionActivityPage,
    access: "view" | "comment" | "edit",
    composerState: "available" | "blocked" | "paused",
    profileName: string | null,
  ): Record<string, unknown> => ({
    ...discussionActivityPage(page, "public"),
    access,
    composerState,
    profileName,
  });

  const respondToLinkDiscussion = async (request: Request): Promise<Response> => {
    if (!linkKey) return privateRefused();
    if (request.method !== "GET" && request.method !== "POST") {
      return privateErrorResponse(relayError("method_not_allowed"));
    }
    if (
      request.method === "POST" &&
      (!relayExchangeKeyConfigured || !hasValidRelayExchangeKey(request))
    ) {
      return privateRefused();
    }
    const profileSecret = request.headers.get("x-dohc-link-profile-secret");
    if (
      (request.method === "POST" && profileSecret === null) ||
      (profileSecret !== null && !LINK_SECRET_PATTERN.test(profileSecret))
    ) {
      return privateRefused();
    }

    try {
      const { capabilityToken, capability } = requireLinkRead(
        request,
        linkReadRateLimiter,
        linkGrantReadRateLimiter,
      );

      if (request.method === "GET") {
        const url = new URL(request.url);
        const cursor = discussionCursor.decode(url.searchParams.get("cursor"));
        const limit = parseDiscussionLimit(url.searchParams.get("limit"));
        const direction = parseDiscussionDirection(
          url.searchParams.get("direction"),
        );
        const storedPage = storage.listShareDiscussionMessages({
          shareId: capability.shareId,
          ...(direction === "newest-first"
            ? { before: cursor }
            : { after: cursor }),
          direction,
          limit,
        });
        const principal = profileSecret === null
          ? null
          : storage.getLinkPrincipalForGrantProfile(
              capability.grantId,
              hashLinkProfileSecret(profileSecret, linkKey),
            );
        const page = discussionPage(
          storedPage,
          "public",
          principal?.displayName ?? null,
        );
        requireFreshLinkRead(capabilityToken, capability);
        return privateResponse(
          linkJsonResponse(capability.shareId, capability.grantId, page),
        );
      }

      const input = parseLinkDiscussionAppendBody(await readJsonObject(request));
      requireFreshLinkRead(capabilityToken, capability);
      if (capability.access === "view") return linkRefusal("link_view_access");
      const result = storage.appendLinkDiscussionMessage({
        capabilityHash: capability.session.capabilityHash,
        profileTokenHash: hashLinkProfileSecret(profileSecret!, linkKey),
        claimedName: input.claimedName,
        body: input.body,
        idempotencyKey: input.idempotencyKey,
        createdAtMs: nowMs(),
        guard: () => {
          requireFreshLinkRead(capabilityToken, capability);
        },
      });
      if (!result.ok) {
        if (result.reason === "rate-limit") {
          requireFreshLinkRead(capabilityToken, capability);
          return linkRefusal("link_read_rate_limited");
        }
        if (result.reason === "invalid-input") {
          return privateErrorResponse(badRequest("discussion message is invalid"));
        }
        if (result.reason === "paused") {
          return privateJsonResponse(
            {
              ok: false,
              error: "link discussion writes are paused",
              code: RELAY_ERRORS.link_discussion_paused.code,
              activityRevision: result.activityRevision,
            },
            RELAY_ERRORS.link_discussion_paused.status,
          );
        }
        if (result.reason === "blocked") {
          return privateJsonResponse(
            {
              ok: false,
              error: "link discussion writes are blocked",
              code: RELAY_ERRORS.link_discussion_blocked.code,
              activityRevision: result.activityRevision,
            },
            RELAY_ERRORS.link_discussion_blocked.status,
          );
        }
        if (
          result.reason === "principal-limit" ||
          result.reason === "lifetime-limit" ||
          result.reason === "share-limit"
        ) {
          return privateErrorResponse(
            relayError("discussion_limit_reached", "discussion message limit reached"),
          );
        }
        return privateRefused();
      }
      if (!result.replayed) discussionActivity.wake(capability.shareId);
      return privateResponse(
        linkJsonResponse(capability.shareId, capability.grantId, {
          ok: true,
          message: projectDiscussionMessage(result.message, "public"),
        }),
      );
    } catch (error) {
      if (
        error instanceof RelayError &&
        (error.statusCode === 401 || error.code === RELAY_ERRORS.not_found.code)
      ) {
        return privateRefused();
      }
      return privateErrorResponse(error);
    }
  };

  const respondToLinkDiscussionActivity = async (
    request: Request,
  ): Promise<Response> => {
    if (!linkKey) return privateRefused();
    if (request.method !== "GET") {
      return privateErrorResponse(relayError("method_not_allowed"));
    }
    const profileSecret = request.headers.get("x-dohc-link-profile-secret");
    if (profileSecret === null || !LINK_SECRET_PATTERN.test(profileSecret)) {
      return privateRefused();
    }

    try {
      const { capabilityToken, capability } = requireLinkRead(
        request,
        linkReadRateLimiter,
        linkGrantReadRateLimiter,
      );

      const query = parseDiscussionActivityQuery(new URL(request.url).searchParams);
      const observedRevision = storage.getShareDiscussionRevision(capability.shareId);
      if (observedRevision === null) return privateRefused();
      if (query.since > observedRevision) {
        throw badRequest("since is ahead of discussion activity");
      }
      if (query.since === observedRevision && query.hold > 0) {
        try {
          await discussionActivity.wait(
            capability.shareId,
            `link:${capability.session.capabilityHash}`,
            {
              holdMs: query.hold,
              signal: request.signal,
              shouldPark: () => {
                try {
                  requireFreshLinkRead(capabilityToken, capability);
                  return (
                    storage.getShareDiscussionRevision(capability.shareId) ===
                    query.since
                  );
                } catch {
                  return false;
                }
              },
            },
          );
        } catch (error) {
          if (error instanceof DiscussionActivityCapacityError) {
            throw relayError("link_read_rate_limited");
          }
          throw error;
        }
      }

      // Every settled wait (wake, timeout, or abort) re-establishes the
      // capability before reading durable state, then once more before bytes
      // leave the process.
      requireFreshLinkRead(capabilityToken, capability);
      const page = storage.listShareDiscussionActivity({
        shareId: capability.shareId,
        sinceRevision: query.since,
        limit: query.limit,
      });
      const principal = storage.getLinkPrincipalForGrantProfile(
        capability.grantId,
        hashLinkProfileSecret(profileSecret, linkKey),
      );
      const composerState = page.linkCommentsPaused
        ? "paused"
        : principal !== null && principal.blockedAtMs !== null
          ? "blocked"
          : "available";
      const fresh = requireFreshLinkRead(capabilityToken, capability);
      if (!isPublicLinkAccess(fresh.access, publicEditRelease)) return privateRefused();
      return privateResponse(
        linkJsonResponse(
          capability.shareId,
          capability.grantId,
          publicDiscussionActivityPage(
            page,
            fresh.access,
            composerState,
            principal?.displayName ?? null,
          ),
        ),
      );
    } catch (error) {
      if (
        error instanceof RelayError &&
        (error.statusCode === 401 || error.code === RELAY_ERRORS.not_found.code)
      ) {
        return privateRefused();
      }
      return privateErrorResponse(error);
    }
  };

  const respondToShareDiscussion = async (
    request: Request,
    shareId: string,
  ): Promise<Response> => {
    try {
      const url = new URL(request.url);
      const actor = await resolveActor(
        request,
        request.method === "GET"
          ? (url.searchParams.get("workspaceId") ?? "")
          : "",
      );
      if (
        !actor.userId ||
        Buffer.byteLength(actor.userId, "utf8") >
          LINK_DISCUSSION_DELETING_USER_ID_BYTE_LIMIT
      ) {
        throw badRequest("discussion actor id is invalid");
      }
      await claimPendingShares(actor.userId);
      if (request.method === "GET") {
        const query = parseDiscussionListQuery(url.searchParams);
        const initialAuthority = requireDiscussionAuthority(
          shareId,
          actor.userId,
          "read",
          query.workspaceId,
        );
        if (
          query.direction === "newest-first" &&
          initialAuthority.viewer !== "owner"
        ) {
          throw notFound();
        }
        const storedPage = storage.listShareDiscussionMessages({
          shareId,
          ...(query.direction === "newest-first"
            ? { before: query.cursor }
            : { after: query.cursor }),
          direction: query.direction,
          limit: query.limit,
        });
        const finalAuthority = requireDiscussionAuthority(
          shareId,
          actor.userId,
          "read",
          query.workspaceId,
        );
        if (
          query.direction === "newest-first" &&
          finalAuthority.viewer !== "owner"
        ) {
          throw notFound();
        }
        return privateJsonResponse(
          discussionPage(storedPage, finalAuthority.viewer),
        );
      }
      if (request.method !== "POST") {
        return privateErrorResponse(relayError("method_not_allowed"));
      }

      const input = parseNamedDiscussionAppendBody(await readJsonObject(request));
      const authority = requireDiscussionAuthority(
        shareId,
        actor.userId,
        "read",
        input.workspaceId,
      );
      const displayName = (await accountDisplayName(
        lookupUserDisplayName,
        actor.userId,
      )) ?? "Unnamed";
      const result = storage.appendAuthenticatedDiscussionMessage({
        shareId,
        authorUserId: actor.userId,
        displayName,
        body: input.body,
        idempotencyKey: input.idempotencyKey,
        createdAtMs: nowMs(),
        readGuard: () => {
          const current = requireDiscussionAuthority(
            shareId,
            actor.userId,
            "read",
            input.workspaceId,
          );
          return current.viewer === "owner" ? "owner" : "recipient";
        },
        appendGuard: () => {
          const current = requireDiscussionAuthority(
            shareId,
            actor.userId,
            "append",
            input.workspaceId,
          );
          return current.viewer === "owner" ? "owner" : "recipient";
        },
      });
      if (!result.ok) {
        if (result.reason === "idempotency-conflict") {
          throw relayError("conflict", "idempotency key was already used for a different message");
        }
        if (result.reason === "rate-limit") {
          throw relayError("discussion_rate_limited", "discussion message rate limit reached");
        }
        if (result.reason === "lifetime-limit") {
          throw relayError("discussion_limit_reached", "recipient discussion message limit reached");
        }
        if (result.reason === "share-limit") {
          throw relayError("discussion_limit_reached", "share discussion message limit reached");
        }
        if (result.reason === "workspace-quota") {
          throw relayError("quota_exceeded", "workspace quota exceeded");
        }
        throw badRequest("discussion message is invalid");
      }
      if (!result.replayed) discussionActivity.wake(shareId);
      return privateJsonResponse({
        ok: true,
        message: projectDiscussionMessage(result.message, authority.viewer),
      });
    } catch (error) {
      return privateErrorResponse(error);
    }
  };

  const respondToShareDiscussionActivity = async (
    request: Request,
    shareId: string,
  ): Promise<Response> => {
    if (request.method !== "GET") {
      return privateErrorResponse(relayError("method_not_allowed"));
    }
    try {
      const url = new URL(request.url);
      const actor = await resolveActor(
        request,
        url.searchParams.get("workspaceId") ?? "",
      );
      if (
        !actor.userId ||
        Buffer.byteLength(actor.userId, "utf8") >
          LINK_DISCUSSION_DELETING_USER_ID_BYTE_LIMIT
      ) {
        throw badRequest("discussion actor id is invalid");
      }
      await claimPendingShares(actor.userId);
      const query = parseDiscussionActivityQuery(url.searchParams);
      const initialAuthority = requireDiscussionAuthority(
        shareId,
        actor.userId,
        "read",
        query.workspaceId,
      );
      const observedRevision = storage.getShareDiscussionRevision(shareId);
      if (observedRevision === null) throw notFound();
      if (query.since > observedRevision) {
        throw badRequest("since is ahead of discussion activity");
      }
      if (query.since === observedRevision && query.hold > 0) {
        try {
          await discussionActivity.wait(shareId, `user:${actor.userId}`, {
            holdMs: query.hold,
            signal: request.signal,
            shouldPark: () => {
              try {
                const authority = requireDiscussionAuthority(
                  shareId,
                  actor.userId,
                  "read",
                  query.workspaceId,
                );
                return (
                  (initialAuthority.viewer !== "owner" ||
                    authority.viewer === "owner") &&
                  storage.getShareDiscussionRevision(shareId) === query.since
                );
              } catch {
                return false;
              }
            },
          });
        } catch (error) {
          if (error instanceof DiscussionActivityCapacityError) {
            throw relayError("link_read_rate_limited");
          }
          throw error;
        }
      }

      const postWakeAuthority = requireDiscussionAuthority(
        shareId,
        actor.userId,
        "read",
        query.workspaceId,
      );
      if (
        initialAuthority.viewer === "owner" &&
        postWakeAuthority.viewer !== "owner"
      ) {
        throw notFound();
      }
      const page = storage.listShareDiscussionActivity({
        shareId,
        sinceRevision: query.since,
        limit: query.limit,
      });
      const finalAuthority = requireDiscussionAuthority(
        shareId,
        actor.userId,
        "read",
        query.workspaceId,
      );
      if (
        initialAuthority.viewer === "owner" &&
        finalAuthority.viewer !== "owner"
      ) {
        throw notFound();
      }
      return privateJsonResponse(
        discussionActivityPage(page, finalAuthority.viewer),
      );
    } catch (error) {
      return privateErrorResponse(error);
    }
  };

  const respondToShareDiscussionModeration = async (
    request: Request,
    shareId: string,
  ): Promise<Response> => {
    if (request.method !== "POST") return privateRefused();
    let actorUserId: string;
    let action: DiscussionModerationAction;
    let workspaceId: string;
    let input: Record<string, unknown>;
    try {
      input = await readJsonObject(request);
      workspaceId = parseWorkspaceId(input.workspaceId);
    } catch (error) {
      return privateErrorResponse(error);
    }
    try {
      const actor = await resolveActor(request, workspaceId);
      const share = storage.getShare(shareId);
      if (
        !actor.userId ||
        Buffer.byteLength(actor.userId, "utf8") >
          LINK_DISCUSSION_DELETING_USER_ID_BYTE_LIMIT ||
        !share ||
        !isCurrentDiscussionOwner(shareId, actor.userId)
      ) {
        return privateRefused();
      }
      requireShareWorkspace(share, workspaceId);
      actorUserId = actor.userId;
      action = parseDiscussionModerationAction(input);
    } catch {
      return privateRefused();
    }
    try {
      const changedAtMs = nowMs();
      if (action.action === "delete") {
        const deleted = storage.deleteShareDiscussionMessage({
          shareId,
          workspaceId,
          messageId: action.messageId,
          deletedAtMs: changedAtMs,
          actorUserId,
        });
        if (deleted === null) return privateRefused();
        discussionActivity.wake(shareId);
        return privateJsonResponse({
          ok: true,
          message: {
            messageId: deleted.messageId,
            createdAtMs: deleted.createdAtMs,
            deleted: true,
          },
        });
      }
      if (action.action === "block" || action.action === "unblock") {
        const blocked = action.action === "block";
        if (
          !storage.setLinkPrincipalBlocked({
            shareId,
            workspaceId,
            principalId: action.principalId,
            actorUserId,
            blockedAtMs: blocked ? changedAtMs : null,
          })
        ) {
          return privateRefused();
        }
        discussionActivity.wake(shareId);
        return privateJsonResponse({ ok: true, blocked });
      }
      const linkCommentsPaused = action.action === "pause";
      if (
        !storage.setShareLinkWritesPaused({
          shareId,
          workspaceId,
          actorUserId,
          pausedAtMs: linkCommentsPaused ? changedAtMs : null,
        })
      ) {
        return privateRefused();
      }
      discussionActivity.wake(shareId);
      return privateJsonResponse({ ok: true, linkCommentsPaused });
    } catch (error) {
      return privateErrorResponse(error);
    }
  };

  return {
    respondToLinkDiscussion,
    respondToLinkDiscussionActivity,
    respondToShareDiscussion,
    respondToShareDiscussionActivity,
    respondToShareDiscussionModeration,
  };
}

const discussionCursor = cursorCodec<SyncRelayShareDiscussionCursor>(
  { createdAtMs: "ms", messageId: "messageId" },
  "cursor",
);

function parseDiscussionLimit(value: string | null): number {
  if (value === null) return DEFAULT_DISCUSSION_PAGE_SIZE;
  if (!/^[1-9][0-9]{0,2}$/u.test(value)) {
    throw badRequest("limit is invalid");
  }
  const limit = Number(value);
  if (limit > LINK_DISCUSSION_PAGE_LIMIT) {
    throw badRequest(`limit must not exceed ${LINK_DISCUSSION_PAGE_LIMIT}`);
  }
  return limit;
}

function parseDiscussionDirection(
  value: string | null,
): "oldest-first" | "newest-first" {
  if (value === null || value === "oldest-first") return "oldest-first";
  if (value === "newest-first") return "newest-first";
  throw badRequest("direction is invalid");
}

function parseOptionalDiscussionWorkspaceId(
  searchParams: URLSearchParams,
): string | undefined {
  const values = searchParams.getAll("workspaceId");
  if (values.length === 0) return undefined;
  if (values.length !== 1) {
    throw badRequest("workspaceId is invalid");
  }
  return parseWorkspaceId(values[0]);
}

function parseDiscussionListQuery(searchParams: URLSearchParams): {
  workspaceId?: string;
  cursor: SyncRelayShareDiscussionCursor | undefined;
  limit: number;
  direction: "oldest-first" | "newest-first";
} {
  const allowed = new Set(["workspaceId", "cursor", "limit", "direction"]);
  for (const key of searchParams.keys()) {
    if (!allowed.has(key) || searchParams.getAll(key).length !== 1) {
      throw badRequest("discussion query is invalid");
    }
  }
  return {
    workspaceId: parseOptionalDiscussionWorkspaceId(searchParams),
    cursor: discussionCursor.decode(searchParams.get("cursor")),
    limit: parseDiscussionLimit(searchParams.get("limit")),
    direction: parseDiscussionDirection(searchParams.get("direction")),
  };
}

function parseDiscussionActivityQuery(searchParams: URLSearchParams): {
  workspaceId?: string;
  since: number;
  hold: number;
  limit: number;
} {
  const allowed = new Set(["workspaceId", "since", "hold", "limit"]);
  for (const key of searchParams.keys()) {
    if (!allowed.has(key) || searchParams.getAll(key).length !== 1) {
      throw badRequest("discussion activity query is invalid");
    }
  }
  const parseNonnegative = (value: string | null, name: string): number => {
    if (value === null || !/^(0|[1-9][0-9]*)$/u.test(value)) {
      throw badRequest(`${name} is invalid`);
    }
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed)) throw badRequest(`${name} is invalid`);
    return parsed;
  };
  const since = parseNonnegative(searchParams.get("since"), "since");
  const holdValue = searchParams.get("hold");
  const hold =
    holdValue === null
      ? DEFAULT_DISCUSSION_ACTIVITY_HOLD_MS
      : parseNonnegative(holdValue, "hold");
  if (hold > MAX_DISCUSSION_ACTIVITY_HOLD_MS) {
    throw badRequest(
      `hold must not exceed ${MAX_DISCUSSION_ACTIVITY_HOLD_MS}`,
    );
  }
  return {
    workspaceId: parseOptionalDiscussionWorkspaceId(searchParams),
    since,
    hold,
    limit: parseDiscussionLimit(searchParams.get("limit")),
  };
}

function parseLinkDiscussionAppendBody(input: Record<string, unknown>): {
  body: string;
  idempotencyKey: string;
  claimedName?: string;
} {
  const keys = Object.keys(input);
  if (
    keys.some(
      (key) => key !== "body" && key !== "idempotencyKey" && key !== "claimedName",
    ) ||
    !Object.hasOwn(input, "body") ||
    !Object.hasOwn(input, "idempotencyKey") ||
    typeof input.body !== "string" ||
    typeof input.idempotencyKey !== "string" ||
    (Object.hasOwn(input, "claimedName") && typeof input.claimedName !== "string")
  ) {
    throw badRequest("discussion append body is invalid");
  }
  return {
    body: input.body,
    idempotencyKey: input.idempotencyKey,
    ...(typeof input.claimedName === "string"
      ? { claimedName: input.claimedName }
      : {}),
  };
}

function parseNamedDiscussionAppendBody(input: Record<string, unknown>): {
  workspaceId?: string;
  body: string;
  idempotencyKey: string;
} {
  if (
    Object.keys(input).some(
      (key) =>
        key !== "workspaceId" && key !== "body" && key !== "idempotencyKey",
    ) ||
    !Object.hasOwn(input, "body") ||
    !Object.hasOwn(input, "idempotencyKey") ||
    typeof input.body !== "string" ||
    typeof input.idempotencyKey !== "string"
  ) {
    throw badRequest("discussion append body is invalid");
  }
  return {
    ...(Object.hasOwn(input, "workspaceId")
      ? { workspaceId: parseWorkspaceId(input.workspaceId) }
      : {}),
    body: input.body,
    idempotencyKey: input.idempotencyKey,
  };
}

type DiscussionModerationAction =
  | { action: "delete"; messageId: string }
  | { action: "block" | "unblock"; principalId: string }
  | { action: "pause" | "resume" };

function parseDiscussionModerationAction(
  input: Record<string, unknown>,
): DiscussionModerationAction {
  const validHandle = (value: unknown): value is string =>
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= DISCUSSION_MODERATION_HANDLE_MAX_CHARS;
  if (input.action === "delete") {
    if (
      Object.keys(input).sort().join("\0") !==
        ["action", "messageId", "workspaceId"].join("\0") ||
      !validHandle(input.messageId)
    ) {
      throw notFound();
    }
    return { action: "delete", messageId: input.messageId };
  }
  if (input.action === "block" || input.action === "unblock") {
    if (
      Object.keys(input).sort().join("\0") !==
        ["action", "principalId", "workspaceId"].join("\0") ||
      !validHandle(input.principalId)
    ) {
      throw notFound();
    }
    return { action: input.action, principalId: input.principalId };
  }
  if (input.action === "pause" || input.action === "resume") {
    if (
      Object.keys(input).sort().join("\0") !==
      ["action", "workspaceId"].join("\0")
    ) {
      throw notFound();
    }
    return { action: input.action };
  }
  throw notFound();
}
