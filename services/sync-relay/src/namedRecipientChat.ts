import { MAX_NAMED_CHAT_FOLLOW_REQUESTS } from "@dohc/security-contract/share-discussion";
import { jsonResponse, readBoundedJson } from "@dohc/service-http";
import { parseLiveUpdateIdentifier } from "@dohc/live-session-contract/live-update-admission";
import type { ResolveActor } from "@dohc/workspace-auth/session";
import { asRecord } from "@dohc/workspace-core";
import { sha256Hex } from "@dohc/workspace-core/hash";
import {
  badRequest,
  errorResponse,
  notFound,
  RelayError,
  relayError,
  type RelayErrorCode,
} from "./errors";
import { OWNER_SCHEME } from "./linkAuthority";
import { hashRelayExchangeKey, verifyRelayExchangeKey } from "./linkSecurity";
import {
  browserChatWaitGroup,
  DiscussionActivityCapacityError,
  type DiscussionActivityHub,
} from "./discussionActivity";
import type { NamedLiveBrowserHttpLimits } from "./namedLiveBrowserHttp";
import type { createNamedShareTransportRoutes } from "./namedShareTransportRoutes";
import { accountDisplayName } from "./accountDisplayName";
import { browserWakeSources, resolveWakeTargets, TooManyWakeCandidates } from "./chatWakes";
import {
  linkChatOrigin,
  LINK_CHAT_MESSAGE_ID_PREFIX,
  namedShareOrigin,
  ownerBrowserOrigin,
  personalAgentOrigin,
  PERSONAL_AGENT_ID_PREFIX,
  PERSONAL_AGENT_ORIGIN_PREFIX,
  PERSONAL_MESSAGE_ID_PREFIX,
  MESSAGE_DELETE_OP_KIND,
  MESSAGE_TOMBSTONE_OP_KIND,
  type LogAuthorNameLookup,
} from "./relayLogInputs";
import { parseLimit, parseString, parseLinkLogHold } from "./requestInputs";
import { readAuthorized, type AuthorizedShareAction } from "./shareAuthorization";
import { visibleSharePath } from "@dohc/security-contract/share-selector";
import { MESSAGE_DELETE_ID_MAX_CHARS } from "@dohc/security-contract/workspace-members";
import {
  chatSideOf,
  filterOpForShare,
  isWorkspaceSelector,
  withheldLinkText,
  type AnyShareSelector,
  type ChatShareThreadResolver,
} from "./shareFilter";
import type { createShareReadQueries } from "./shareReadQueries";
import type { SyncRelayStorage } from "./storage";
import type { BrowserPostWakes } from "./storage/chatWakes";
import { deletedMessageKey } from "./storage/messageDeletes";
import { commentFileOf, currentFileAt, type CommentFile } from "./storage/personalAgentChat";
import { MAX_DISCUSSION_ACTIVITY_HOLD_MS } from "./wireLimits";
import { workspaceChatAccess, workspaceFileReach, workspaceGroupReachable } from "./workspaceReach";

const MAX_MESSAGE_BODY_BYTES = 64 * 1024;
// About 100 people with two tabs each, and room to spare.
export const MAX_BROWSER_CHAT_FOLLOWS_PER_WORKSPACE = 512;
const cacheHeaders = { "cache-control": "private, no-store" };

export interface NamedChatMessage {
  relaySeq: number;
  messageId: string;
  threadId: string;
  authorUserId: string | null;
  authorDisplayName: string;
  authorKind: "human" | "agent" | "automation" | "link";
  // A link post an agent wrote through its agent connection: an agent arriving by link.
  linkAgent: boolean;
  authorOwnerDisplayName: string | null;
  createdAtMs: number;
  body: string | null;
  bodyTooLarge: boolean;
  /** A deleted message's line: who wrote it and when, with no body. */
  deletedAtMs?: number;
}

/**
 * A named reader's message names its lane, and a chat reply names the message it answers.
 * `startsPost` marks a post's first message, so a reader whose page holds only a post's later replies
 * does not show one of them as the post. A chat message never starts one.
 */
export type ThreadedChatMessage = NamedChatMessage & {
  lane: "posts" | "chat";
  parentMessageId: string | null;
  startsPost: boolean;
};

/** A delete an open follow passes. The reader replaces that message's line. */
export interface DeletedChatMessage {
  messageId: string;
  threadId: string;
  deletedAtMs: number;
  relaySeq: number;
}

/** A message in a follow of every Group a workspace share reaches names its Group. */
type PagedChatMessage = ThreadedChatMessage & { channelWireId?: string };

function threaded(
  message: NamedChatMessage,
  payload: unknown,
  lane: "posts" | "chat",
  startsPost: boolean,
): ThreadedChatMessage {
  const parent = (payload as { parentMessageId?: unknown }).parentMessageId;
  return {
    ...message,
    lane,
    parentMessageId: typeof parent === "string" ? parent : null,
    startsPost: lane === "posts" && startsPost,
  };
}

const linkId = (value: unknown): value is string =>
  typeof value === "string" &&
  value.length > 0 &&
  value.length <= 200 &&
  value.trim() === value &&
  !/\p{Cc}/u.test(value);

// Only the relay writes a link post, under its principal's origin, with link
// IDs, an agent connection when an agent posted, and nothing account-shaped.
// Every desktop refuses any other row that names a link, so no reader shows one either.
function linkProvenanceHolds(p: Record<string, unknown>, originId: string): boolean {
  // A personal agent's post names the account, the agent, and the connection
  // it signed in with, from that agent's own origin, as every desktop checks.
  // It may also name the person, which the relay writes.
  if (originId.startsWith(PERSONAL_AGENT_ORIGIN_PREFIX)) {
    return (
      p.authorKind === "agent" &&
      linkId(p.authorUserId) &&
      linkId(p.agentConnectionId) &&
      typeof p.authorAgentId === "string" &&
      p.authorAgentId.startsWith(PERSONAL_AGENT_ID_PREFIX) &&
      originId === personalAgentOrigin(p.authorAgentId) &&
      String(p.messageId).startsWith(PERSONAL_MESSAGE_ID_PREFIX) &&
      (!Object.hasOwn(p, "authorOwnerDisplayName") || linkId(p.authorOwnerDisplayName)) &&
      !["linkGrantId", "linkPrincipalId", "chainDepth", "authorReported", "work", "origin"].some(
        (key) => Object.hasOwn(p, key),
      )
    );
  }
  if (p.authorKind !== "link") {
    return (
      !["linkGrantId", "linkPrincipalId", "agentConnectionId"].some((key) =>
        Object.hasOwn(p, key),
      ) && !String(p.authorAgentId ?? "").startsWith(PERSONAL_AGENT_ID_PREFIX)
    );
  }
  return (
    linkId(p.linkGrantId) &&
    linkId(p.linkPrincipalId) &&
    originId === linkChatOrigin(p.linkPrincipalId) &&
    (!Object.hasOwn(p, "agentConnectionId") || linkId(p.agentConnectionId)) &&
    String(p.messageId).startsWith(LINK_CHAT_MESSAGE_ID_PREFIX) &&
    !["authorUserId", "authorOwnerDisplayName", "chainDepth"].some((key) => Object.hasOwn(p, key))
  );
}

/**
 * Names each person by their account, as a member's desktop pull does, never by
 * the name their own computer wrote: that computer calls a person with no
 * profile name "You". An agent's or automation's message names the account it
 * ran for the same way. Each account is looked up once per page.
 */
async function namedByAccount<Message extends NamedChatMessage>(
  messages: Message[],
  lookup: LogAuthorNameLookup | undefined,
): Promise<Message[]> {
  const nameOf = accountNames(lookup);
  return Promise.all(
    messages.map(async (message) => {
      if (message.authorUserId === null) return message;
      if (message.authorKind === "human")
        return { ...message, authorDisplayName: await nameOf(message.authorUserId) };
      if (
        (message.authorKind === "agent" || message.authorKind === "automation") &&
        message.authorOwnerDisplayName !== null
      )
        return { ...message, authorOwnerDisplayName: await nameOf(message.authorUserId) };
      return message;
    }),
  );
}

/** A stored chat message as a browser reads it; `originId` is the origin the relay stored it under. */
export function messageFromOp(
  op: Record<string, unknown>,
  originId: string,
): NamedChatMessage | null {
  if (op.opKind === MESSAGE_TOMBSTONE_OP_KIND) return deletedLineFromOp(op);
  if (op.opKind !== "chat.message.append" || !op.payload || typeof op.payload !== "object")
    return null;
  const p = op.payload as Record<string, unknown>;
  if (
    typeof op.relaySeq !== "number" ||
    typeof p.messageId !== "string" ||
    typeof p.threadId !== "string" ||
    typeof p.authorDisplayName !== "string" ||
    typeof p.body !== "string" ||
    typeof p.createdAtMs !== "number" ||
    !["human", "agent", "automation", "link"].includes(String(p.authorKind)) ||
    !linkProvenanceHolds(p, originId)
  )
    return null;
  return {
    relaySeq: op.relaySeq,
    messageId: p.messageId,
    threadId: p.threadId,
    authorUserId: typeof p.authorUserId === "string" ? p.authorUserId : null,
    authorDisplayName: p.authorDisplayName,
    authorKind: p.authorKind as NamedChatMessage["authorKind"],
    linkAgent: p.authorKind === "link" && Object.hasOwn(p, "agentConnectionId"),
    authorOwnerDisplayName:
      typeof p.authorOwnerDisplayName === "string" ? p.authorOwnerDisplayName : null,
    createdAtMs: p.createdAtMs,
    body: p.body,
    bodyTooLarge: false,
  };
}

// The line a deleted message leaves. The relay wrote the tombstone from an
// append it admitted, so its author fields need no second provenance check.
function deletedLineFromOp(op: Record<string, unknown>): NamedChatMessage | null {
  const p = op.payload as Record<string, unknown> | null;
  if (
    !p ||
    typeof op.relaySeq !== "number" ||
    typeof p.messageId !== "string" ||
    typeof p.threadId !== "string" ||
    typeof p.authorDisplayName !== "string" ||
    typeof p.createdAtMs !== "number" ||
    typeof p.deletedAtMs !== "number" ||
    !["human", "agent", "automation", "link"].includes(String(p.authorKind))
  )
    return null;
  return {
    relaySeq: op.relaySeq,
    messageId: p.messageId,
    threadId: p.threadId,
    authorUserId: typeof p.authorUserId === "string" ? p.authorUserId : null,
    authorDisplayName: p.authorDisplayName,
    authorKind: p.authorKind as NamedChatMessage["authorKind"],
    linkAgent: false,
    authorOwnerDisplayName:
      typeof p.authorOwnerDisplayName === "string" ? p.authorOwnerDisplayName : null,
    createdAtMs: p.createdAtMs,
    body: null,
    bodyTooLarge: false,
    deletedAtMs: p.deletedAtMs,
  };
}

/** A message's line once it is deleted. */
export function asDeletedLine<Message extends NamedChatMessage>(
  message: Message,
  deletedAtMs: number,
): Message {
  return { ...message, body: null, bodyTooLarge: false, linkAgent: false, deletedAtMs };
}

function displayName(value: unknown): string {
  if (typeof value !== "string" || !value.isWellFormed()) throw badRequest("invalid display name");
  const name = value.trim();
  if (!name || name.length > 200) throw badRequest("invalid display name");
  return name;
}

function invitationId(value: string | null): string {
  try {
    return parseLiveUpdateIdentifier(value);
  } catch {
    throw badRequest("invalid grant id");
  }
}

function cursor(value: string | null): number {
  if (value === null || !/^(0|[1-9]\d*)$/u.test(value) || !Number.isSafeInteger(Number(value)))
    throw badRequest("invalid cursor");
  return Number(value);
}

export function createNamedRecipientChat(options: {
  storage: SyncRelayStorage;
  resolveActor: ResolveActor;
  lookupUserDisplayName?: LogAuthorNameLookup;
  claimPendingShares(userId: string, signal?: AbortSignal): Promise<void>;
  activity: Pick<DiscussionActivityHub, "wait" | "wakeLog">;
  publicOrigin: string;
  exchangeKey: string;
  limits: NamedLiveBrowserHttpLimits;
  nowMs: () => number;
  requireShareAction(
    shareId: string,
    userId: string,
    action: "read" | "append",
  ): AuthorizedShareAction;
  transport: ReturnType<typeof createNamedShareTransportRoutes>;
  reads: Pick<ReturnType<typeof createShareReadQueries>, "chatResolverFor">;
}) {
  const { storage, limits, requireShareAction } = options;
  const exchangeHash = hashRelayExchangeKey(options.exchangeKey);
  let pending = 0,
    pendingFollows = 0;
  const followsByUser = new Map<string, number>();
  const followsByWorkspace = new Map<string, number>();
  const refuse = () =>
    Response.json(
      { ok: false, error: "not found", code: "not_found" },
      { status: 404, headers: cacheHeaders },
    );
  const unavailable = () => new Response(null, { status: 503, headers: cacheHeaders });
  const cancelledResponse = (request: Request) =>
    request.signal.aborted ? refuse() : unavailable();
  const boundedJson = (body: unknown) => {
    const bytes = JSON.stringify(body);
    if (Buffer.byteLength(bytes) > limits.maxResponseBytes) throw relayError("payload_too_large");
    return bytes;
  };
  const json = (body: unknown) =>
    new Response(boundedJson(body), {
      headers: { ...cacheHeaders, "content-type": "application/json" },
    });
  const handle = async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    const channels = url.pathname === "/sync/named-chat/channels";
    const deleting = url.pathname === "/sync/named-chat/messages/delete";
    // Only the owner's page reads the wakes of the owner's own posts.
    const waking = url.pathname === "/sync/named-chat/wakes";
    if (
      (!channels && !deleting && !waking && url.pathname !== "/sync/named-chat/messages") ||
      (request.method !== "GET" && (channels || request.method !== "POST")) ||
      ((deleting || waking) && request.method !== "POST") ||
      (waking && !OWNER_SCHEME.test(request.headers.get("authorization") ?? "")) ||
      request.signal.aborted ||
      request.headers.get("origin") !== options.publicOrigin ||
      !verifyRelayExchangeKey(request.headers.get("x-dohc-relay-exchange-key"), exchangeHash)
    )
      return refuse();
    const following = !channels && request.method === "GET" && url.searchParams.has("since");
    if (
      following
        ? pendingFollows >= MAX_NAMED_CHAT_FOLLOW_REQUESTS
        : pending >= limits.maxPendingRequests
    ) {
      return errorResponse(relayError("share_access_rate_limited"));
    }
    if (following) pendingFollows++;
    else pending++;
    let followUser: string | undefined, followWorkspace: string | undefined;
    const controller = new AbortController(),
      abort = () => controller.abort();
    const cancelled = new Promise<Response>((resolve) =>
      controller.signal.addEventListener("abort", () => resolve(cancelledResponse(request)), {
        once: true,
      }),
    );
    request.signal.addEventListener("abort", abort, { once: true });
    if (request.signal.aborted) abort();
    const timer = setTimeout(
      abort,
      Math.min(
        2_147_483_647,
        limits.timeoutMs +
          (request.method === "GET" && url.searchParams.has("since")
            ? MAX_DISCUSSION_ACTIVITY_HOLD_MS
            : 0),
      ),
    );
    const work = (async () => {
      try {
        let input: Record<string, unknown> = {};
        // The owner names their workspace, never a share or grant. Their page's chat key is `owner:<workspace>`.
        const owned = OWNER_SCHEME.exec(request.headers.get("authorization") ?? "")?.[1];
        const ownerKey = owned && `owner:${owned}`;
        if (request.method === "POST") {
          if (
            url.search ||
            request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !==
              "application/json"
          )
            throw badRequest("invalid request");
          let value: unknown;
          try {
            value = await readBoundedJson(request, limits.maxRequestBytes, controller.signal);
          } catch (error) {
            if (controller.signal.aborted) throw error;
            throw error instanceof RangeError
              ? relayError("payload_too_large")
              : badRequest("invalid request");
          }
          if (!value || typeof value !== "object" || Array.isArray(value))
            throw badRequest("invalid request");
          input = value as Record<string, unknown>;
          const allowed = new Set(
            deleting
              ? ["shareId", "threadId", "messageId"]
              : waking
                ? ["shareId", "channelWireId", "path", "threadId", "messageId"]
                : [
                    "shareId",
                    "channelWireId",
                    "path",
                    "id",
                    "threadId",
                    "lane",
                    "parentMessageId",
                    "body",
                    "authorKind",
                    "authorDisplayName",
                    "authorUserId",
                  ],
          );
          if (Object.keys(input).some((key) => !allowed.has(key)))
            throw relayError("share_op_rejected");
        } else {
          const allowed = channels
            ? [owned ? "workspaceId" : "grantId"]
            : ["shareId", "channelWireId", "path", "before", "since", "hold", "limit"];
          if (
            [...url.searchParams.keys()].some(
              (key) => !allowed.includes(key) || url.searchParams.getAll(key).length !== 1,
            )
          )
            throw badRequest("invalid query");
        }
        const grantId =
          channels && !owned ? invitationId(url.searchParams.get("grantId")) : undefined;
        const grant = grantId ? storage.getShareGrant(grantId) : undefined;
        const shareId = channels
          ? owned
            ? url.searchParams.get("workspaceId") === owned && ownerKey
            : grant?.shareId
          : parseString(
              request.method === "POST" ? input.shareId : url.searchParams.get("shareId"),
              "shareId",
              256,
            );
        const share = owned
          ? shareId === ownerKey
            ? { workspaceId: owned }
            : undefined
          : shareId && storage.getShare(shareId);
        // Authenticate before answering either missing or existing coordinates.
        const actor = await options.resolveActor(
          new Request(request.url, {
            headers: { cookie: request.headers.get("cookie") ?? "" },
            signal: controller.signal,
          }),
          share ? share.workspaceId : "",
        );
        controller.signal.throwIfAborted();
        // The owner holds the workspace, not an invite.
        if (channels && !owned) await options.claimPendingShares(actor.userId, controller.signal);
        if (!share || !shareId || actor.workspaceId !== share.workspaceId) throw notFound();
        if (following) {
          const count = followsByUser.get(actor.userId) ?? 0;
          if (count >= limits.maxPendingRequests) throw relayError("share_access_rate_limited");
          followsByUser.set(actor.userId, count + 1);
          followUser = actor.userId;
          const workspaceCount = followsByWorkspace.get(share.workspaceId) ?? 0;
          if (workspaceCount >= MAX_BROWSER_CHAT_FOLLOWS_PER_WORKSPACE)
            throw relayError("share_access_rate_limited");
          followsByWorkspace.set(share.workspaceId, workspaceCount + 1);
          followWorkspace = share.workspaceId;
        }
        // A member's browser hears one refusal: a removed member reads like an unknown share, as the member's link reads do.
        const membership =
          "selectorJson" in share &&
          (JSON.parse(share.selectorJson) as { kind?: unknown }).kind === "workspace";
        // The owner reaches their workspace as an admin does, checked again on every read, wake and write.
        const action = (
          kind: "read" | "append",
        ): Pick<AuthorizedShareAction, "effectiveSelector"> & {
          share: { shareId: string; workspaceId: string };
        } => {
          if (owned) {
            if (storage.workspaceRoleOf(owned, actor.userId)?.role !== "owner") throw notFound();
            const reach = storage.memberReach(owned, actor.userId, "admin", "edit");
            return {
              share: { shareId, workspaceId: owned },
              effectiveSelector: { kind: "workspace", role: "admin", reach },
            };
          }
          try {
            return requireShareAction(shareId, actor.userId, kind);
          } catch (error) {
            throw membership && error instanceof RelayError && error.code === "share_access_removed"
              ? notFound()
              : error;
          }
        };
        const authority = action("read");
        if (authority.share.workspaceId !== share.workspaceId) throw notFound();
        // Deleting reads the account's role and reach in the workspace, not
        // the share's level: a member at View still deletes their own message.
        if (deleting) {
          const deleted = storage.deleteWorkspaceMessage({
            workspaceId: share.workspaceId,
            threadId: parseString(input.threadId, "threadId", MESSAGE_DELETE_ID_MAX_CHARS),
            messageId: parseString(input.messageId, "messageId", MESSAGE_DELETE_ID_MAX_CHARS),
            actor: { kind: "account", userId: actor.userId },
            nowMs: options.nowMs(),
          });
          if (!deleted.ok) throw notFound();
          if (!deleted.repeated) options.activity.wakeLog(share.workspaceId);
          const { messageId, threadId, deletedAtMs } = deleted.tombstone.payload;
          return json({ shareId, deleted: { messageId, threadId, deletedAtMs } });
        }
        // A workspace share reaches every ordinary Group, one follow for them all.
        // Any other share reaches one channel.
        const workspace = isWorkspaceSelector(authority.effectiveSelector);
        const resolver = workspace ? options.reads.chatResolverFor(share.workspaceId) : undefined;
        const chat = workspace ? null : chatSideOf(authority.effectiveSelector);
        if (!workspace && !chat) throw notFound();
        let file: CommentFile | null = null;
        // The Group a workspace share reads or posts in, once named. A rule that hides it ends the read.
        let group: string | null = null;
        const recheck = () => {
          const fresh = action("read");
          if (
            fresh.share.workspaceId !== share.workspaceId ||
            isWorkspaceSelector(fresh.effectiveSelector) !== workspace ||
            (chat && chatSideOf(fresh.effectiveSelector)?.channelWireId !== chat.channelWireId)
          )
            throw notFound();
          if (
            group !== null &&
            (!isWorkspaceSelector(fresh.effectiveSelector) ||
              !workspaceGroupReachable(fresh.effectiveSelector, group, resolver!))
          )
            throw notFound();
          if (
            file &&
            (!isWorkspaceSelector(fresh.effectiveSelector) ||
              !fresh.effectiveSelector.reach.objectVisible(file.objectId) ||
              visibleSharePath(workspaceFileReach(fresh.effectiveSelector), file.filePath) !==
                file.filePath)
          )
            throw notFound();
          controller.signal.throwIfAborted();
          return fresh;
        };
        if (channels) {
          const listing = {
            shareId,
            userId: actor.userId,
            maxPostBytes: limits.maxRequestBytes,
            maxBodyBytes: MAX_MESSAGE_BODY_BYTES,
          };
          if (!chat) {
            const groups = storage.listChannelCreates(share.workspaceId);
            const role = storage.workspaceRoleOf(share.workspaceId, actor.userId)?.role;
            const fresh = recheck().effectiveSelector;
            if (!isWorkspaceSelector(fresh)) throw notFound();
            const files = workspaceFileReach(fresh);
            return json({
              ...listing,
              // The page offers Delete on others' messages; the delete route decides.
              moderates: role === "owner" || role === "admin",
              channels: groups
                .filter((group) => workspaceGroupReachable(fresh, group.channelWireId, resolver!))
                .map((group) => ({
                  channelWireId: group.channelWireId,
                  name: withheldLinkText(group.name, files),
                  kind: "channel",
                  type: group.type,
                  access: workspaceChatAccess(fresh, group.channelWireId),
                })),
            });
          }
          let writable = false;
          try {
            action("append");
            writable = true;
          } catch (error) {
            if (!(error instanceof RelayError && error.code === "share_read_only")) throw error;
          }
          const labels = storage.getShareLabels(shareId, "member");
          recheck();
          return json({
            ...listing,
            channels: [
              {
                channelWireId: chat.channelWireId,
                name: labels.subjectName,
                kind: storage.findChannelCreateKind(share.workspaceId, chat.channelWireId) ?? null,
                type:
                  storage
                    .listChannelCreates(share.workspaceId)
                    .find((group) => group.channelWireId === chat.channelWireId)?.type ?? "both",
                access: writable ? "read-write" : "read-only",
              },
            ],
          });
        }
        // A workspace share reads and posts on a current file's Comments by its path. File Comments follow file reach.
        const posting = request.method === "POST";
        if (posting ? Object.hasOwn(input, "path") : url.searchParams.has("path")) {
          const path = posting ? input.path : url.searchParams.get("path"),
            selector = authority.effectiveSelector;
          file =
            typeof path === "string" && isWorkspaceSelector(selector)
              ? currentFileAt(storage, share.workspaceId, path)
              : null;
          if (
            !file ||
            !isWorkspaceSelector(selector) ||
            (posting
              ? Object.hasOwn(input, "channelWireId")
              : url.searchParams.has("channelWireId")) ||
            visibleSharePath(workspaceFileReach(selector), file.filePath) !== file.filePath
          )
            throw notFound();
        }
        // A workspace share follows every Group without naming one, and reads or posts in one Group by name.
        const everyGroup = !chat && !file && following;
        if (everyGroup && url.searchParams.has("channelWireId")) throw notFound();
        const channelWireId =
          everyGroup || file
            ? null
            : parseString(
                posting ? input.channelWireId : url.searchParams.get("channelWireId"),
                "channelWireId",
                256,
              );
        if (
          channelWireId !== null &&
          (chat
            ? channelWireId !== chat.channelWireId
            : !isWorkspaceSelector(authority.effectiveSelector) ||
              !workspaceGroupReachable(authority.effectiveSelector, channelWireId, resolver!))
        )
          throw notFound();
        if (!chat) group = channelWireId;
        const place = file ? { path: file.filePath } : { channelWireId };
        if (waking) {
          if (!owned || (channelWireId === null && !file)) throw notFound();
          const threadId = parseString(input.threadId, "threadId", 256),
            messageId = parseString(input.messageId, "messageId", 256);
          if (
            file
              ? commentFileOf(storage, share.workspaceId, threadId)?.objectId !== file.objectId
              : storage.findThreadCreateChannelWireId(share.workspaceId, threadId) !== channelWireId
          )
            throw notFound();
          const wakes = storage.phoneChatWakes({
            accountId: actor.userId,
            workspaceId: share.workspaceId,
            messages: new Map([[messageId, threadId]]),
            nowMs: options.nowMs(),
          });
          recheck();
          return json({
            shareId,
            ...place,
            messageId,
            wakes: wakes.map(({ wakeId, state, agentName }) => ({ wakeId, state, agentName })),
          });
        }
        if (posting) {
          if (channelWireId === null && !file) throw notFound();
          action("append");
          if (input.authorUserId !== undefined && input.authorUserId !== actor.userId)
            throw relayError("authorship_mismatch");
          const id = parseString(input.id, "id", 256);
          if (!id.isWellFormed()) throw badRequest("invalid id");
          const authorKind = input.authorKind;
          // The owner's browser posts as the owner, never as an agent.
          if (authorKind !== "human" && (owned || authorKind !== "agent"))
            throw badRequest("invalid author kind");
          if (authorKind === "human" && Object.hasOwn(input, "authorDisplayName"))
            throw relayError("share_op_rejected");
          const agentName =
            authorKind === "agent" ? displayName(input.authorDisplayName) : undefined;
          const accountName =
            (await accountDisplayName(options.lookupUserDisplayName, actor.userId)) ?? "Unnamed";
          controller.signal.throwIfAborted();
          const authorDisplayName = agentName ?? accountName;
          const authorOwnerDisplayName = authorKind === "agent" ? accountName : undefined;
          if (typeof input.body !== "string" || !input.body.isWellFormed())
            throw badRequest("invalid body");
          const body = input.body.replace(/\r\n?/gu, "\n").trimEnd();
          if (!body || Buffer.byteLength(body) > MAX_MESSAGE_BODY_BYTES)
            throw badRequest("invalid body");
          const originId = "browser-chat";
          const storedOrigin = owned
            ? ownerBrowserOrigin(actor.userId)
            : namedShareOrigin(shareId, actor.userId, originId);
          const messageId = `browser-message:${sha256Hex(JSON.stringify([shareId, actor.userId, id]))}`;
          // A new Group message starts a post, or joins the Group's chat, which is one conversation.
          // A reply names its thread, and a reply in the chat may name the message it answers.
          const replying = input.threadId !== undefined;
          if ((file || replying) && input.lane !== undefined) throw badRequest("invalid thread");
          if (file && input.parentMessageId !== undefined) throw badRequest("invalid parent");
          let lane: "posts" | "chat" | undefined;
          if (!replying && !file) {
            const type =
              storage
                .listChannelCreates(share.workspaceId)
                .find((group) => group.channelWireId === channelWireId)?.type ?? "both";
            const asked = input.lane ?? (type === "chat" ? "chat" : "posts");
            if ((asked !== "posts" && asked !== "chat") || (type !== "both" && type !== asked))
              throw badRequest("invalid lane");
            lane = asked;
          }
          const stored = storage.fetchChatMessage({
            workspaceId: share.workspaceId,
            originId: storedOrigin,
            messageId,
          });
          // A retry keeps the thread its first send chose, and makes it again only if that send made it.
          const storedThread = stored && asRecord(JSON.parse(stored.payloadJson))?.threadId;
          const ownThread = `browser-thread:${sha256Hex(JSON.stringify([shareId, actor.userId, id]))}`;
          const chatThread =
            lane === "chat"
              ? typeof storedThread === "string"
                ? storedThread
                : storage.findChannelChatThread(share.workspaceId, channelWireId!)
              : null;
          const createThread =
            !replying && (stored ? storedThread === ownThread : chatThread === null);
          const threadId =
            chatThread ?? (createThread ? ownThread : parseString(input.threadId, "threadId", 256));
          if (!threadId.isWellFormed()) throw badRequest("invalid thread id");
          // A reply on a file joins one of that file's threads, and a reply in a Group one of that Group's.
          if (
            file &&
            replying &&
            commentFileOf(storage, share.workspaceId, threadId)?.objectId !== file.objectId
          )
            throw notFound();
          if (
            !file &&
            replying &&
            storage.findThreadCreateChannelWireId(share.workspaceId, threadId) !== channelWireId
          )
            throw notFound();
          const threadLane = file
            ? "posts"
            : (lane ?? storage.findThreadCreateLane(share.workspaceId, threadId) ?? "posts");
          const parentMessageId =
            input.parentMessageId === undefined
              ? undefined
              : parseString(input.parentMessageId, "parentMessageId", 256);
          if (
            parentMessageId !== undefined &&
            (!replying || threadLane !== "chat" || !parentMessageId.isWellFormed())
          )
            throw badRequest("invalid parent");
          let wakes: BrowserPostWakes | undefined;
          if (owned && !stored) {
            const nowMs = options.nowMs();
            const write = replying
              ? { kind: "reply" as const, body, threadId, parentMessageId }
              : { kind: "start" as const, body, lane: threadLane, channelId: channelWireId ?? "" };
            try {
              const { targets } = await resolveWakeTargets(
                browserWakeSources(storage, {
                  accountId: actor.userId,
                  workspaceId: share.workspaceId,
                  threadId,
                  lane: threadLane,
                  nowMs,
                }),
                actor.userId,
                write,
              );
              if (targets.length > 0) wakes = { accountId: actor.userId, threadId, targets, nowMs };
            } catch (error) {
              if (!(error instanceof TooManyWakeCandidates)) throw error;
              return jsonResponse(
                {
                  ok: false,
                  error: "a message would wake too many agents",
                  code: "too_many_wakes",
                },
                400,
              );
            }
          }

          const append = async () => {
            const createdAtMs = options.nowMs();
            const ops = [
              // The share's write binds a new thread on a file to the file's object, as the desktop's own Comments are.
              ...(createThread
                ? [
                    {
                      opKind: "chat.thread.create",
                      payload: file
                        ? {
                            threadId,
                            title: "",
                            linkedPath: file.filePath,
                            linkedAtMs: createdAtMs,
                            createdAtMs,
                          }
                        : { threadId, title: "", channelWireId, lane: threadLane, createdAtMs },
                    },
                  ]
                : []),
              {
                opKind: "chat.message.append",
                payload: {
                  messageId,
                  threadId,
                  ...(parentMessageId === undefined ? {} : { parentMessageId }),
                  body,
                  authorKind,
                  authorDisplayName,
                  authorUserId: actor.userId,
                  ...(authorOwnerDisplayName === undefined ? {} : { authorOwnerDisplayName }),
                  createdAtMs,
                },
              },
            ].map((op, originSeq) => ({ ...op, originSeq, recordedAtMs: createdAtMs }));
            const payload = ops[ops.length - 1]!.payload;
            const draft = messageFromOp(
              { relaySeq: Number.MAX_SAFE_INTEGER, opKind: "chat.message.append", payload },
              storedOrigin,
            );
            boundedJson({
              shareId,
              ...place,
              message: draft && threaded(draft, payload, threadLane, createThread),
            });
            return options.transport(
              new Request(request.url, {
                method: "POST",
                signal: controller.signal,
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ originId, ops }),
              }),
              { route: "share-log", shareId },
              actor,
              messageId,
              owned
                ? { originId: storedOrigin, authorize: () => action("append"), wakes }
                : undefined,
            );
          };
          const result = await append();
          if (!result.ok) return result;
          await result.body?.cancel();
          const row = storage.fetchChatMessage({
            workspaceId: share.workspaceId,
            originId: storedOrigin,
            messageId,
          });
          if (!row) throw notFound();
          recheck();
          const payload = JSON.parse(row.payloadJson) as unknown;
          const message = messageFromOp(
            { relaySeq: row.relaySeq, opKind: row.opKind, payload },
            row.originId,
          );
          return json({
            shareId,
            ...place,
            message:
              message &&
              threaded(
                message,
                payload,
                threadLane,
                message !== null &&
                  storage.findThreadFirstMessageId(share.workspaceId, message.threadId) ===
                    message.messageId,
              ),
          });
        }
        const page = await readSharedChannelPage({
          storage,
          resolver: resolver ?? options.reads.chatResolverFor(share.workspaceId),
          workspaceId: share.workspaceId,
          shareId,
          channelWireId,
          query: url.searchParams,
          comments: file && commentsOn(storage, share.workspaceId, file),
          authorize: () => recheck().effectiveSelector,
          activity: options.activity,
          waiter: `named:${actor.userId}`,
          signal: controller.signal,
          maxResponseBytes: limits.maxResponseBytes,
          busyCode: "share_access_rate_limited",
          personOf: accountNames(options.lookupUserDisplayName),
          project: (message) => message,
        });
        return json({
          ...page,
          messages: await namedByAccount(page.messages, options.lookupUserDisplayName),
        });
      } catch (error) {
        return controller.signal.aborted ? cancelledResponse(request) : errorResponse(error);
      } finally {
        if (following) pendingFollows--;
        else pending--;
        if (followUser !== undefined) {
          const count = (followsByUser.get(followUser) ?? 1) - 1;
          if (count === 0) followsByUser.delete(followUser);
          else followsByUser.set(followUser, count);
        }
        if (followWorkspace !== undefined) {
          const count = (followsByWorkspace.get(followWorkspace) ?? 1) - 1;
          if (count === 0) followsByWorkspace.delete(followWorkspace);
          else followsByWorkspace.set(followWorkspace, count);
        }
        clearTimeout(timer);
        request.signal.removeEventListener("abort", abort);
      }
    })();
    return Promise.race([work, cancelled]);
  };
  return handle;
}

/** Each account's name, looked up once: "Unnamed" for one with none, as a post names it. */
function accountNames(lookup: LogAuthorNameLookup | undefined) {
  const names = new Map<string, Promise<string>>();
  return (userId: string) => {
    let name = names.get(userId);
    if (!name) {
      name = accountDisplayName(lookup, userId).then((found) => found ?? "Unnamed");
      names.set(userId, name);
    }
    return name;
  };
}

/** A current file's Comments: the threads whose first create binds this file and no other. */
interface FileComments {
  path: string;
  fetch(page: {
    workspaceId: string;
    cursor: number | null;
    direction: "older" | "newer";
    limit: number;
  }): ReturnType<SyncRelayStorage["fetchCommentMessages"]>;
  onFile(threadId: string): boolean;
}

function commentsOn(
  storage: SyncRelayStorage,
  workspaceId: string,
  file: CommentFile,
): FileComments {
  return {
    path: file.filePath,
    fetch: (page) =>
      storage.fetchCommentMessages({ ...page, objectId: file.objectId, path: file.filePath }),
    onFile: (threadId) => commentFileOf(storage, workspaceId, threadId)?.objectId === file.objectId,
  };
}

// One page of a shared channel for a browser reader, named or link: newest
// first with `before`, or following with `since` and an optional hold. With
// no channel, a follow of every Group a workspace share reaches, each message
// naming its Group.
// `authorize` throws once the reader's access has ended, and otherwise
// returns what they reach now. It runs inside every read, including each wake
// of a hold, and again before the page leaves.
// `project` is the reader's view of a message, and the byte budget counts it.
// With `comments` instead of a channel, a page of one file's Comments.
export async function readSharedChannelPage<Message extends { relaySeq: number }>(input: {
  storage: Pick<
    SyncRelayStorage,
    | "fetchChatMessages"
    | "fetchChannelMessages"
    | "findThreadCreateLane"
    | "findThreadFirstMessageId"
    | "readShareTx"
    | "deletedMessageTimes"
  >;
  resolver: ChatShareThreadResolver;
  workspaceId: string;
  shareId: string;
  channelWireId: string | null;
  comments?: FileComments | null;
  query: URLSearchParams;
  authorize(): AnyShareSelector;
  activity: Pick<DiscussionActivityHub, "wait">;
  waiter: string;
  signal: AbortSignal;
  maxResponseBytes: number;
  busyCode: Extract<RelayErrorCode, "share_access_rate_limited" | "link_read_rate_limited">;
  /** Names the person on a personal agent's post written while the relay found no name. */
  personOf?(userId: string): Promise<string>;
  project(message: PagedChatMessage): Message;
}) {
  const { query, authorize, project } = input;
  const following = query.has("since");
  const limit = Math.min(parseLimit(query.get("limit")), 100);
  const since = following ? cursor(query.get("since")) : null;
  if (following && query.has("before")) throw badRequest("invalid query");
  if (!following && query.has("hold")) throw badRequest("hold requires since");
  const hold = following ? parseLinkLogHold(query.get("hold")) : 0;
  let position = following ? since : query.has("before") ? cursor(query.get("before")) : null;
  let pageStart = position;
  const readPage = () =>
    readAuthorized(input.storage, authorize, (selector) => {
      pageStart = position;
      const page = {
        workspaceId: input.workspaceId,
        cursor: position,
        direction: following ? ("newer" as const) : ("older" as const),
        limit,
      };
      const { comments } = input;
      const result = comments
        ? comments.fetch(page)
        : input.channelWireId === null
          ? input.storage.fetchChannelMessages(page)
          : input.storage.fetchChatMessages({ ...page, channelWireId: input.channelWireId });
      position = result.nextCursor;
      const messages: PagedChatMessage[] = [];
      // The deletes this page passes. An open follow is past each deleted
      // message's coordinate, so it learns of the delete from these.
      const deleted: DeletedChatMessage[] = [];
      const lanes = new Map<string, "posts" | "chat">();
      const laneOf = (threadId: string): "posts" | "chat" => {
        const lane =
          lanes.get(threadId) ??
          input.storage.findThreadCreateLane(input.workspaceId, threadId) ??
          "posts";
        lanes.set(threadId, lane);
        return lane;
      };
      const firsts = new Map<string, string | undefined>();
      const startsPost = (message: NamedChatMessage, lane: "posts" | "chat") => {
        if (lane !== "posts") return false;
        if (!firsts.has(message.threadId))
          firsts.set(
            message.threadId,
            input.storage.findThreadFirstMessageId(input.workspaceId, message.threadId),
          );
        return firsts.get(message.threadId) === message.messageId;
      };
      // Where a thread's messages are read: on the file, in the named channel,
      // or in a Group this share reaches.
      const placed = (threadId: string): { channelWireId?: string } | null => {
        if (comments) return comments.onFile(threadId) ? {} : null;
        if (input.channelWireId !== null) return {};
        // A file's Comments are not a Group.
        const channelWireId = input.resolver.threadChannelWireId(threadId);
        return isWorkspaceSelector(selector) &&
          workspaceGroupReachable(selector, channelWireId, input.resolver)
          ? { channelWireId }
          : null;
      };
      for (const row of result.rows) {
        if (row.settlementAdmission?.status === "refused") continue;
        const decision = filterOpForShare(
          selector,
          row.opKind,
          row.payloadJson,
          input.resolver,
          "chat",
        );
        if (row.opKind === MESSAGE_DELETE_OP_KIND) {
          const op = decision.allowed ? (decision.payload as Record<string, unknown>) : null;
          if (
            op &&
            typeof op.messageId === "string" &&
            typeof op.threadId === "string" &&
            typeof op.deletedAtMs === "number" &&
            placed(op.threadId)
          )
            deleted.push({
              messageId: op.messageId,
              threadId: op.threadId,
              deletedAtMs: op.deletedAtMs,
              relaySeq: row.relaySeq,
            });
          continue;
        }
        const read = decision.allowed
          ? messageFromOp(
              { relaySeq: row.relaySeq, opKind: row.opKind, payload: decision.payload },
              row.originId,
            )
          : null;
        if (!read) continue;
        // A file's Comments are posts.
        const lane = comments ? "posts" : laneOf(read.threadId);
        const message = threaded(
          read,
          decision.allowed ? decision.payload : {},
          lane,
          startsPost(read, lane),
        );
        const place = placed(message.threadId);
        if (place) messages.push({ ...message, ...place });
      }
      return {
        messages,
        deleted,
        nextCursor: following ? result.nextCursor : result.latestCursor,
        ...(following
          ? { hasMore: result.hasMore }
          : { olderCursor: result.hasMore ? result.nextCursor : null }),
      };
    });
  let page = readPage();
  const caughtUp = () =>
    page.messages.length === 0 && page.nextCursor === since && "hasMore" in page && !page.hasMore;
  if (following && hold > 0 && caughtUp()) {
    const deadline = Date.now() + hold;
    while (!input.signal.aborted && Date.now() < deadline) {
      try {
        await input.activity.wait(browserChatWaitGroup(input.workspaceId), input.waiter, {
          holdMs: Math.max(1, deadline - Date.now()),
          signal: input.signal,
          shouldPark: () => {
            try {
              page = readPage();
              return caughtUp();
            } catch {
              return false;
            }
          },
        });
      } catch (error) {
        if (error instanceof DiscussionActivityCapacityError) throw relayError(input.busyCode);
        throw error;
      }
      if (caughtUp()) page = readPage();
      if (!caughtUp()) break;
    }
  }
  // A personal agent's post written while the relay found no name for its
  // person names only its account, so an agent's name alone could pass for
  // anyone's: the page names the account's person.
  // A rule can change while the names are looked up, so the page is read again
  // from the same cursor under the reader's current reach, with no wait
  // between that read and the answer. Each pass names at least one more
  // account, so a page of at most `limit` posts ends the loop.
  const { personOf } = input;
  if (personOf) {
    const names = new Map<string, string>();
    const unnamed = () => [
      ...new Set(
        page.messages.flatMap((message) =>
          message.authorKind === "agent" &&
          message.authorUserId !== null &&
          message.authorOwnerDisplayName === null &&
          !names.has(message.authorUserId)
            ? [message.authorUserId]
            : [],
        ),
      ),
    ];
    for (let accounts = unnamed(); accounts.length > 0; accounts = unnamed()) {
      await Promise.all(accounts.map(async (userId) => names.set(userId, await personOf(userId))));
      position = pageStart;
      page = readPage();
    }
    page = {
      ...page,
      messages: page.messages.map((message) =>
        message.authorKind === "agent" &&
        message.authorUserId !== null &&
        message.authorOwnerDisplayName === null
          ? { ...message, authorOwnerDisplayName: names.get(message.authorUserId)! }
          : message,
      ),
    };
  }
  authorize();
  // A delete can commit while the page waits. Read deletion again in the turn
  // that builds the answer, so no deleted body leaves.
  const deletedAt = input.storage.deletedMessageTimes(input.workspaceId, page.messages);
  page.messages = page.messages.map((message) => {
    const at = deletedAt.get(deletedMessageKey(message));
    return at === undefined || message.deletedAtMs !== undefined
      ? message
      : asDeletedLine(message, at);
  });
  const envelope = {
    shareId: input.shareId,
    ...(input.comments
      ? { path: input.comments.path }
      : input.channelWireId === null
        ? {}
        : { channelWireId: input.channelWireId }),
    ...page,
  };
  const messages: Message[] = [];
  let skippedCursor: number | undefined;
  const partial = (selected: Message[]) => ({
    ...envelope,
    messages: selected,
    ...(following
      ? {
          nextCursor:
            selected[selected.length - 1]?.relaySeq ?? skippedCursor ?? position ?? page.nextCursor,
          hasMore: true,
        }
      : {
          olderCursor:
            selected[selected.length - 1]?.relaySeq ?? skippedCursor ?? position ?? page.nextCursor,
        }),
  });
  const fits = (value: unknown) =>
    Buffer.byteLength(JSON.stringify(value)) <= input.maxResponseBytes;
  let truncated = false;
  for (const message of page.messages) {
    let omitted = project({ ...message, body: null, bodyTooLarge: true });
    if (!fits(partial([omitted]))) {
      omitted = project({
        ...message,
        body: null,
        bodyTooLarge: true,
        messageId: `omitted:${message.relaySeq}`,
        threadId: "",
        authorUserId: null,
        authorDisplayName: "",
        authorOwnerDisplayName: null,
      });
    }
    if (!fits(partial([...messages, omitted]))) {
      if (messages.length === 0) skippedCursor = message.relaySeq;
      truncated = true;
      break;
    }
    const projected = project(message);
    messages.push(fits(partial([...messages, projected])) ? projected : omitted);
  }
  const complete = { ...envelope, messages };
  return truncated || !fits(complete) ? partial(messages) : complete;
}
