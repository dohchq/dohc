import { MAX_NAMED_CHAT_FOLLOW_REQUESTS } from "@dohc/security-contract/share-discussion";
import { readBoundedJson } from "@dohc/service-http";
import { parseLiveUpdateIdentifier } from "@dohc/live-session-contract/live-update-admission";
import type { ResolveActor } from "@dohc/workspace-auth/session";
import { sha256Hex } from "@dohc/workspace-core/hash";
import {
  badRequest,
  errorResponse,
  notFound,
  RelayError,
  relayError,
  type RelayErrorCode,
} from "./errors";
import { hashRelayExchangeKey, verifyRelayExchangeKey } from "./linkSecurity";
import {
  browserChatWaitGroup,
  DiscussionActivityCapacityError,
  type DiscussionActivityHub,
} from "./discussionActivity";
import type { NamedLiveBrowserHttpLimits } from "./namedLiveBrowserHttp";
import type { createNamedShareTransportRoutes } from "./namedShareTransportRoutes";
import { accountDisplayName } from "./accountDisplayName";
import {
  linkChatOrigin,
  LINK_CHAT_MESSAGE_ID_PREFIX,
  namedShareOrigin,
  personalAgentOrigin,
  PERSONAL_AGENT_ID_PREFIX,
  PERSONAL_AGENT_ORIGIN_PREFIX,
  PERSONAL_MESSAGE_ID_PREFIX,
  type LogAuthorNameLookup,
} from "./relayLogInputs";
import { parseLimit, parseString, parseLinkLogHold } from "./requestInputs";
import type { AuthorizedShareAction } from "./shareAuthorization";
import { visibleSharePath } from "@dohc/security-contract/share-selector";
import {
  chatSideOf,
  filterOpForShare,
  isWorkspaceSelector,
  type AnyShareSelector,
  type ChatShareThreadResolver,
} from "./shareFilter";
import type { createShareReadQueries } from "./shareReadQueries";
import type { SyncRelayStorage } from "./storage";
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
  if (originId.startsWith(PERSONAL_AGENT_ORIGIN_PREFIX)) {
    return (
      p.authorKind === "agent" &&
      linkId(p.authorUserId) &&
      linkId(p.agentConnectionId) &&
      typeof p.authorAgentId === "string" &&
      p.authorAgentId.startsWith(PERSONAL_AGENT_ID_PREFIX) &&
      originId === personalAgentOrigin(p.authorAgentId) &&
      String(p.messageId).startsWith(PERSONAL_MESSAGE_ID_PREFIX) &&
      ![
        "linkGrantId",
        "linkPrincipalId",
        "authorOwnerDisplayName",
        "chainDepth",
        "authorReported",
        "work",
        "origin",
      ].some((key) => Object.hasOwn(p, key))
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

/** A stored chat message as a browser reads it; `originId` is the origin the relay stored it under. */
export function messageFromOp(
  op: Record<string, unknown>,
  originId: string,
): NamedChatMessage | null {
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
  activity: Pick<DiscussionActivityHub, "wait">;
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
    Response.json({ ok: false, error: "not found" }, { status: 404, headers: cacheHeaders });
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
    if (
      (!channels && url.pathname !== "/sync/named-chat/messages") ||
      (request.method !== "GET" && (channels || request.method !== "POST")) ||
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
          const allowed = new Set([
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
          ]);
          if (Object.keys(input).some((key) => !allowed.has(key)))
            throw relayError("share_op_rejected");
        } else {
          const allowed = channels
            ? ["grantId"]
            : ["shareId", "channelWireId", "path", "before", "since", "hold", "limit"];
          if (
            [...url.searchParams.keys()].some(
              (key) => !allowed.includes(key) || url.searchParams.getAll(key).length !== 1,
            )
          )
            throw badRequest("invalid query");
        }
        const grantId = channels ? invitationId(url.searchParams.get("grantId")) : undefined;
        const grant = grantId ? storage.getShareGrant(grantId) : undefined;
        const shareId = channels
          ? grant?.shareId
          : parseString(
              request.method === "POST" ? input.shareId : url.searchParams.get("shareId"),
              "shareId",
              256,
            );
        const share = shareId && storage.getShare(shareId);
        // Authenticate before answering either missing or existing coordinates.
        const actor = await options.resolveActor(
          new Request(request.url, {
            headers: { cookie: request.headers.get("cookie") ?? "" },
            signal: controller.signal,
          }),
          share ? share.workspaceId : "",
        );
        controller.signal.throwIfAborted();
        if (channels) await options.claimPendingShares(actor.userId, controller.signal);
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
          (JSON.parse(share.selectorJson) as { kind?: unknown }).kind === "workspace";
        const action = (kind: "read" | "append") => {
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
        // A workspace share reaches every ordinary Group, one follow for them all.
        // Any other share reaches one channel.
        const workspace = isWorkspaceSelector(authority.effectiveSelector);
        const resolver = workspace ? options.reads.chatResolverFor(share.workspaceId) : undefined;
        const chat = workspace ? null : chatSideOf(authority.effectiveSelector);
        if (!workspace && !chat) throw notFound();
        let file: CommentFile | null = null;
        const recheck = () => {
          const fresh = action("read");
          if (
            fresh.share.workspaceId !== share.workspaceId ||
            isWorkspaceSelector(fresh.effectiveSelector) !== workspace ||
            (chat && chatSideOf(fresh.effectiveSelector)?.channelWireId !== chat.channelWireId)
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
            const groups = storage
              .listChannelCreates(share.workspaceId)
              .filter((group) => workspaceGroupReachable(group.channelWireId, resolver!));
            const fresh = recheck().effectiveSelector;
            if (!isWorkspaceSelector(fresh)) throw notFound();
            return json({
              ...listing,
              channels: groups.map((group) => ({
                channelWireId: group.channelWireId,
                name: group.name,
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
            : !workspaceGroupReachable(channelWireId, resolver!))
        )
          throw notFound();
        const place = file ? { path: file.filePath } : { channelWireId };
        if (posting) {
          if (channelWireId === null && !file) throw notFound();
          action("append");
          if (input.authorUserId !== undefined && input.authorUserId !== actor.userId)
            throw relayError("authorship_mismatch");
          const id = parseString(input.id, "id", 256);
          if (!id.isWellFormed()) throw badRequest("invalid id");
          const authorKind = input.authorKind;
          if (authorKind !== "human" && authorKind !== "agent")
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
          const storedOrigin = namedShareOrigin(shareId, actor.userId, originId);
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
          const chatThread =
            lane === "chat"
              ? storage.findChannelChatThread(share.workspaceId, channelWireId!)
              : null;
          const createThread = !replying && chatThread === null;
          const threadId =
            chatThread ??
            (createThread
              ? `browser-thread:${sha256Hex(JSON.stringify([shareId, actor.userId, id]))}`
              : parseString(input.threadId, "threadId", 256));
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

          const append = async () => {
            const createdAtMs = options.nowMs();
            const ops = [
              // The share's write binds a new thread on a file to the file's object, as the desktop's own Comments are.
              ...(createThread
                ? [
                    {
                      opKind: "chat.thread.create",
                      payload: file
                        ? { threadId, title: "", linkedPath: file.filePath, createdAtMs }
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
          const stored = JSON.parse(row.payloadJson) as unknown;
          const message = messageFromOp(
            { relaySeq: row.relaySeq, opKind: row.opKind, payload: stored },
            row.originId,
          );
          return json({
            shareId,
            ...place,
            message:
              message &&
              threaded(
                message,
                stored,
                threadLane,
                message !== null &&
                  storage.findThreadFirstMessageId(share.workspaceId, message.threadId) ===
                    message.messageId,
              ),
          });
        }
        return json(
          await readSharedChannelPage({
            storage,
            read: workspace ? storage.readShareTx.bind(storage) : undefined,
            resolver: resolver ?? options.reads.chatResolverFor(share.workspaceId),
            selector: authority.effectiveSelector,
            workspaceId: share.workspaceId,
            shareId,
            channelWireId,
            query: url.searchParams,
            comments: file && commentsOn(storage, share.workspaceId, file),
            recheck,
            activity: options.activity,
            waiter: `named:${actor.userId}`,
            signal: controller.signal,
            maxResponseBytes: limits.maxResponseBytes,
            busyCode: "share_access_rate_limited",
            project: (message) => message,
          }),
        );
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
// `recheck` throws once the reader's access has ended; it runs before every
// read, including each wake of a hold, and before the page leaves.
// `project` is the reader's view of a message, and the byte budget counts it.
// With `comments` instead of a channel, a page of one file's Comments.
export async function readSharedChannelPage<Message extends { relaySeq: number }>(input: {
  storage: Pick<
    SyncRelayStorage,
    | "fetchChatMessages"
    | "fetchChannelMessages"
    | "findThreadCreateLane"
    | "findThreadFirstMessageId"
  >;
  read?: <T>(run: () => T) => T;
  resolver: ChatShareThreadResolver;
  selector: AnyShareSelector;
  workspaceId: string;
  shareId: string;
  channelWireId: string | null;
  comments?: FileComments | null;
  query: URLSearchParams;
  recheck(): void;
  activity: Pick<DiscussionActivityHub, "wait">;
  waiter: string;
  signal: AbortSignal;
  maxResponseBytes: number;
  busyCode: Extract<RelayErrorCode, "share_access_rate_limited" | "link_read_rate_limited">;
  project(message: PagedChatMessage): Message;
}) {
  const { query, recheck, project } = input;
  const following = query.has("since");
  const limit = Math.min(parseLimit(query.get("limit")), 100);
  const since = following ? cursor(query.get("since")) : null;
  if (following && query.has("before")) throw badRequest("invalid query");
  if (!following && query.has("hold")) throw badRequest("hold requires since");
  const hold = following ? parseLinkLogHold(query.get("hold")) : 0;
  let position = following ? since : query.has("before") ? cursor(query.get("before")) : null;
  const inRead = input.read ?? (<T>(run: () => T): T => run());
  const readPage = () =>
    inRead(() => {
      recheck();
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
      for (const row of result.rows) {
        if (row.settlementAdmission?.status === "refused") continue;
        const decision = filterOpForShare(
          input.selector,
          row.opKind,
          row.payloadJson,
          input.resolver,
          "chat",
        );
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
        if (comments) {
          if (comments.onFile(message.threadId)) messages.push(message);
          continue;
        }
        if (input.channelWireId !== null) {
          messages.push(message);
          continue;
        }
        // A file's Comments are not a Group.
        const channelWireId = input.resolver.threadChannelWireId(message.threadId);
        if (workspaceGroupReachable(channelWireId, input.resolver))
          messages.push({ ...message, channelWireId });
      }
      return {
        messages,
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
  recheck();
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
