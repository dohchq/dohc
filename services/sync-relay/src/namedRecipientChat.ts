import { MAX_NAMED_CHAT_FOLLOW_REQUESTS } from "@dohc/security-contract/share-discussion";
import { readBoundedJson } from "@dohc/service-http";
import { parseLiveUpdateIdentifier } from "@dohc/live-session-contract/live-update-admission";
import type { ResolveActor } from "@dohc/workspace-auth/session";
import { sha256Hex } from "@dohc/workspace-core/hash";
import { badRequest, errorResponse, notFound, RelayError, relayError, type RelayErrorCode } from "./errors";
import { hashRelayExchangeKey, verifyRelayExchangeKey } from "./linkSecurity";
import { DiscussionActivityCapacityError, linkLogWaitGroup, type DiscussionActivityHub } from "./discussionActivity";
import type { NamedLiveBrowserHttpLimits } from "./namedLiveBrowserHttp";
import type { createNamedShareTransportRoutes } from "./namedShareTransportRoutes";
import { accountDisplayName } from "./accountDisplayName";
import { linkChatOrigin, LINK_CHAT_MESSAGE_ID_PREFIX, namedShareOrigin, type LogAuthorNameLookup } from "./relayLogInputs";
import { parseLimit, parseString, parseLinkLogHold } from "./requestInputs";
import type { AuthorizedShareAction } from "./shareAuthorization";
import { chatSideOf, filterOpForShare, type AnyShareSelector, type ChatShareThreadResolver } from "./shareFilter";
import type { createShareReadQueries } from "./shareReadQueries";
import type { SyncRelayStorage } from "./storage";
import { MAX_DISCUSSION_ACTIVITY_HOLD_MS } from "./wireLimits";

const MAX_MESSAGE_BODY_BYTES = 64 * 1024;
export const MAX_BROWSER_CHAT_FOLLOWS_PER_WORKSPACE = 128;
const cacheHeaders = {"cache-control": "private, no-store"};

export interface NamedChatMessage {
  relaySeq: number;
  messageId: string;
  threadId: string;
  authorUserId: string | null;
  authorDisplayName: string;
  authorKind: "human" | "agent" | "automation" | "link";
  authorOwnerDisplayName: string | null;
  createdAtMs: number;
  body: string | null;
  bodyTooLarge: boolean;
}

const linkId = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 200 &&
  value.trim() === value && !/\p{Cc}/u.test(value);

// Only the relay writes a link post, under its principal's origin, with link
// IDs and nothing account-shaped. Every desktop refuses any other row that
// names a link, so no reader shows one either.
function linkProvenanceHolds(p: Record<string, unknown>, originId: string): boolean {
  if (p.authorKind !== "link") return !Object.hasOwn(p, "linkGrantId") && !Object.hasOwn(p, "linkPrincipalId");
  return linkId(p.linkGrantId) && linkId(p.linkPrincipalId) && originId === linkChatOrigin(p.linkPrincipalId) &&
    String(p.messageId).startsWith(LINK_CHAT_MESSAGE_ID_PREFIX) &&
    !["authorUserId", "authorOwnerDisplayName", "chainDepth"].some(key => Object.hasOwn(p, key));
}

/** A stored chat message as a browser reads it; `originId` is the origin the relay stored it under. */
export function messageFromOp(op: Record<string, unknown>, originId: string): NamedChatMessage | null {
  if (op.opKind !== "chat.message.append" || !op.payload || typeof op.payload !== "object") return null;
  const p = op.payload as Record<string, unknown>;
  if (typeof op.relaySeq !== "number" || typeof p.messageId !== "string" || typeof p.threadId !== "string" ||
      typeof p.authorDisplayName !== "string" || typeof p.body !== "string" ||
      typeof p.createdAtMs !== "number" || !["human", "agent", "automation", "link"].includes(String(p.authorKind)) ||
      !linkProvenanceHolds(p, originId)) return null;
  return {relaySeq: op.relaySeq, messageId: p.messageId, threadId: p.threadId, authorUserId: typeof p.authorUserId === "string" ? p.authorUserId : null,
    authorDisplayName: p.authorDisplayName, authorKind: p.authorKind as NamedChatMessage["authorKind"],
    authorOwnerDisplayName: typeof p.authorOwnerDisplayName === "string" ? p.authorOwnerDisplayName : null,
    createdAtMs: p.createdAtMs, body: p.body, bodyTooLarge: false};
}

function displayName(value: unknown): string {
  if (typeof value !== "string" || !value.isWellFormed()) throw badRequest("invalid display name");
  const name = value.trim();
  if (!name || name.length > 200) throw badRequest("invalid display name");
  return name;
}

function invitationId(value: string | null): string {
  try {return parseLiveUpdateIdentifier(value);}
  catch {throw badRequest("invalid grant id");}
}

function cursor(value: string | null): number {
  if (value === null || !/^(0|[1-9]\d*)$/u.test(value) || !Number.isSafeInteger(Number(value))) throw badRequest("invalid cursor");
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
  requireShareAction(shareId: string, userId: string, action: "read" | "append"): AuthorizedShareAction;
  transport: ReturnType<typeof createNamedShareTransportRoutes>;
  reads: Pick<ReturnType<typeof createShareReadQueries>, "chatResolverFor">;
}) {
  const {storage, limits, requireShareAction} = options;
  const exchangeHash = hashRelayExchangeKey(options.exchangeKey);
  let pending = 0, pendingFollows = 0;
  const followsByUser = new Map<string, number>();
  const followsByWorkspace = new Map<string, number>();
  const refuse = () => Response.json({ok: false, error: "not found"}, {status: 404, headers: cacheHeaders});
  const unavailable = () => new Response(null, {status: 503, headers: cacheHeaders});
  const cancelledResponse = (request: Request) => request.signal.aborted ? refuse() : unavailable();
  const boundedJson = (body: unknown) => {
    const bytes = JSON.stringify(body);
    if (Buffer.byteLength(bytes) > limits.maxResponseBytes) throw relayError("payload_too_large");
    return bytes;
  };
  const json = (body: unknown) => new Response(boundedJson(body), {headers: {...cacheHeaders, "content-type": "application/json"}});
  const handle = async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    const channels = url.pathname === "/sync/named-chat/channels";
    if ((!channels && url.pathname !== "/sync/named-chat/messages") ||
        (request.method !== "GET" && (channels || request.method !== "POST")) ||
        request.signal.aborted || request.headers.get("origin") !== options.publicOrigin ||
        !verifyRelayExchangeKey(request.headers.get("x-dohc-relay-exchange-key"), exchangeHash)) return refuse();
    const following = !channels && request.method === "GET" && url.searchParams.has("since");
    if (following ? pendingFollows >= MAX_NAMED_CHAT_FOLLOW_REQUESTS : pending >= limits.maxPendingRequests) {
      return errorResponse(relayError("share_access_rate_limited"));
    }
    if (following) pendingFollows++; else pending++;
    let followUser: string | undefined, followWorkspace: string | undefined;
    const controller = new AbortController(), abort = () => controller.abort();
    const cancelled = new Promise<Response>(resolve => controller.signal.addEventListener("abort", () => resolve(cancelledResponse(request)), {once: true}));
    request.signal.addEventListener("abort", abort, {once: true});
    if (request.signal.aborted) abort();
    const timer = setTimeout(abort, Math.min(2_147_483_647, limits.timeoutMs + (request.method === "GET" && url.searchParams.has("since") ? MAX_DISCUSSION_ACTIVITY_HOLD_MS : 0)));
    const work = (async () => {
      try {
        let input: Record<string, unknown> = {};
        if (request.method === "POST") {
          if (url.search || request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") throw badRequest("invalid request");
          let value: unknown;
          try {value = await readBoundedJson(request, limits.maxRequestBytes, controller.signal);}
          catch (error) {
            if (controller.signal.aborted) throw error;
            throw error instanceof RangeError ? relayError("payload_too_large") : badRequest("invalid request");
          }
          if (!value || typeof value !== "object" || Array.isArray(value)) throw badRequest("invalid request");
          input = value as Record<string, unknown>;
          const allowed = new Set(["shareId", "channelWireId", "id", "threadId", "body", "authorKind", "authorDisplayName", "authorUserId"]);
          if (Object.keys(input).some(key => !allowed.has(key))) throw relayError("share_op_rejected");
        } else {
          const allowed = channels ? ["grantId"] : ["shareId", "channelWireId", "before", "since", "hold", "limit"];
          if ([...url.searchParams.keys()].some(key => !allowed.includes(key) || url.searchParams.getAll(key).length !== 1)) throw badRequest("invalid query");
        }
        const grantId = channels ? invitationId(url.searchParams.get("grantId")) : undefined;
        const grant = grantId ? storage.getShareGrant(grantId) : undefined;
        const shareId = channels ? grant?.shareId : parseString(request.method === "POST" ? input.shareId : url.searchParams.get("shareId"), "shareId", 256);
        const share = shareId && storage.getShare(shareId);
        // Authenticate before answering either missing or existing coordinates.
        const actor = await options.resolveActor(new Request(request.url, {
          headers: {cookie: request.headers.get("cookie") ?? ""}, signal: controller.signal,
        }), share ? share.workspaceId : "");
        controller.signal.throwIfAborted();
        if (channels) await options.claimPendingShares(actor.userId, controller.signal);
        if (!share || !shareId || actor.workspaceId !== share.workspaceId) throw notFound();
        if (following) {
          const count = followsByUser.get(actor.userId) ?? 0;
          if (count >= limits.maxPendingRequests) throw relayError("share_access_rate_limited");
          followsByUser.set(actor.userId, count + 1);
          followUser = actor.userId;
          const workspaceCount = followsByWorkspace.get(share.workspaceId) ?? 0;
          if (workspaceCount >= MAX_BROWSER_CHAT_FOLLOWS_PER_WORKSPACE) throw relayError("share_access_rate_limited");
          followsByWorkspace.set(share.workspaceId, workspaceCount + 1);
          followWorkspace = share.workspaceId;
        }
        const authority = requireShareAction(shareId, actor.userId, "read");
        const chat = chatSideOf(authority.effectiveSelector);
        if (!chat || authority.share.workspaceId !== share.workspaceId) throw notFound();
        const recheck = () => {
          const fresh = requireShareAction(shareId, actor.userId, "read");
          if (fresh.share.workspaceId !== share.workspaceId || chatSideOf(fresh.effectiveSelector)?.channelWireId !== chat.channelWireId) throw notFound();
          controller.signal.throwIfAborted();
        };
        if (channels) {
          let writable = false;
          try {requireShareAction(shareId, actor.userId, "append"); writable = true;}
          catch (error) {if (!(error instanceof RelayError && error.code === "share_read_only")) throw error;}
          const labels = storage.getShareLabels(shareId);
          recheck();
          return json({shareId, userId: actor.userId, maxPostBytes: limits.maxRequestBytes, maxBodyBytes: MAX_MESSAGE_BODY_BYTES, channels: [{channelWireId: chat.channelWireId, name: labels.subjectName,
            kind: storage.findChannelCreateKind(share.workspaceId, chat.channelWireId) ?? null, access: writable ? "read-write" : "read-only"}]});
        }
        const channelWireId = parseString(request.method === "POST" ? input.channelWireId : url.searchParams.get("channelWireId"), "channelWireId", 256);
        if (channelWireId !== chat.channelWireId) throw notFound();
        if (request.method === "POST") {
          requireShareAction(shareId, actor.userId, "append");
          if (input.authorUserId !== undefined && input.authorUserId !== actor.userId) throw relayError("authorship_mismatch");
          const id = parseString(input.id, "id", 256);
          if (!id.isWellFormed()) throw badRequest("invalid id");
          const authorKind = input.authorKind;
          if (authorKind !== "human" && authorKind !== "agent") throw badRequest("invalid author kind");
          if (authorKind === "human" && Object.hasOwn(input, "authorDisplayName")) throw relayError("share_op_rejected");
          const agentName = authorKind === "agent" ? displayName(input.authorDisplayName) : undefined;
          const accountName = await accountDisplayName(options.lookupUserDisplayName, actor.userId) ?? "Unnamed";
          controller.signal.throwIfAborted();
          const authorDisplayName = agentName ?? accountName;
          const authorOwnerDisplayName = authorKind === "agent" ? accountName : undefined;
          if (typeof input.body !== "string" || !input.body.isWellFormed()) throw badRequest("invalid body");
          const body = input.body.replace(/\r\n?/gu, "\n").trimEnd();
          if (!body || Buffer.byteLength(body) > MAX_MESSAGE_BODY_BYTES) throw badRequest("invalid body");
          const originId = "browser-chat";
          const storedOrigin = namedShareOrigin(shareId, actor.userId, originId);
          const messageId = `browser-message:${sha256Hex(JSON.stringify([shareId, actor.userId, id]))}`;
          const createThread = input.threadId === undefined;
          const threadId = createThread ? `browser-thread:${sha256Hex(JSON.stringify([shareId, actor.userId, id]))}` : parseString(input.threadId, "threadId", 256);
          if (!threadId.isWellFormed()) throw badRequest("invalid thread id");

          const append = async () => {
            const createdAtMs = options.nowMs();
            const ops = [
              ...(createThread ? [{opKind: "chat.thread.create", payload: {threadId, title: "", channelWireId, lane: "chat", createdAtMs}}] : []),
              {opKind: "chat.message.append", payload: {messageId, threadId, body, authorKind, authorDisplayName,
                authorUserId: actor.userId, ...(authorOwnerDisplayName === undefined ? {} : {authorOwnerDisplayName}), createdAtMs}},
            ].map((op, originSeq) => ({...op, originSeq, recordedAtMs: createdAtMs}));
            boundedJson({shareId, channelWireId, message: messageFromOp({relaySeq: Number.MAX_SAFE_INTEGER,
              opKind: "chat.message.append", payload: ops[ops.length - 1]!.payload}, storedOrigin)});
            return options.transport(new Request(request.url, {method: "POST", signal: controller.signal,
              headers: {"content-type": "application/json"}, body: JSON.stringify({originId, ops})}), {route: "share-log", shareId}, actor, messageId);
          };
          const result = await append();
          if (!result.ok) return result;
          await result.body?.cancel();
          const row = storage.fetchChatMessage({workspaceId: share.workspaceId, originId: storedOrigin, messageId});
          if (!row) throw notFound();
          recheck();
          return json({shareId, channelWireId, message: messageFromOp({relaySeq: row.relaySeq, opKind: row.opKind, payload: JSON.parse(row.payloadJson)}, row.originId)});
        }
        return json(await readSharedChannelPage({storage, resolver: options.reads.chatResolverFor(share.workspaceId),
          selector: authority.effectiveSelector, workspaceId: share.workspaceId, shareId, channelWireId, query: url.searchParams,
          recheck, activity: options.activity, waiter: `named:${actor.userId}`, signal: controller.signal,
          maxResponseBytes: limits.maxResponseBytes, busyCode: "share_access_rate_limited", project: message => message}));
      } catch (error) {return controller.signal.aborted ? cancelledResponse(request) : errorResponse(error);}
      finally {
        if (following) pendingFollows--; else pending--;
        if (followUser !== undefined) {
          const count = (followsByUser.get(followUser) ?? 1) - 1;
          if (count === 0) followsByUser.delete(followUser); else followsByUser.set(followUser, count);
        }
        if (followWorkspace !== undefined) {
          const count = (followsByWorkspace.get(followWorkspace) ?? 1) - 1;
          if (count === 0) followsByWorkspace.delete(followWorkspace); else followsByWorkspace.set(followWorkspace, count);
        }
        clearTimeout(timer); request.signal.removeEventListener("abort", abort);
      }
    })();
    return Promise.race([work, cancelled]);
  };
  return handle;
}

// One page of a shared channel for a browser reader, named or link: newest
// first with `before`, or following with `since` and an optional hold.
// `recheck` throws once the reader's access has ended; it runs before every
// read, including each wake of a hold, and before the page leaves.
// `project` is the reader's view of a message, and the byte budget counts it.
export async function readSharedChannelPage<Message extends {relaySeq: number}>(input: {
  storage: Pick<SyncRelayStorage, "fetchChatMessages">;
  resolver: ChatShareThreadResolver;
  selector: AnyShareSelector;
  workspaceId: string;
  shareId: string;
  channelWireId: string;
  query: URLSearchParams;
  recheck(): void;
  activity: Pick<DiscussionActivityHub, "wait">;
  waiter: string;
  signal: AbortSignal;
  maxResponseBytes: number;
  busyCode: Extract<RelayErrorCode, "share_access_rate_limited" | "link_read_rate_limited">;
  project(message: NamedChatMessage): Message;
}) {
  const {query, recheck, project} = input;
  const following = query.has("since");
  const limit = Math.min(parseLimit(query.get("limit")), 100);
  const since = following ? cursor(query.get("since")) : null;
  if (following && query.has("before")) throw badRequest("invalid query");
  if (!following && query.has("hold")) throw badRequest("hold requires since");
  const hold = following ? parseLinkLogHold(query.get("hold")) : 0;
  let position = following ? since : query.has("before") ? cursor(query.get("before")) : null;
  const readPage = () => {
    recheck();
    const result = input.storage.fetchChatMessages({workspaceId: input.workspaceId, channelWireId: input.channelWireId,
      cursor: position, direction: following ? "newer" : "older", limit});
    position = result.nextCursor;
    const messages: NamedChatMessage[] = [];
    for (const row of result.rows) {
      if (row.settlementAdmission?.status === "refused") continue;
      const decision = filterOpForShare(input.selector, row.opKind, row.payloadJson, input.resolver, "chat");
      const message = decision.allowed ? messageFromOp({relaySeq: row.relaySeq, opKind: row.opKind, payload: decision.payload}, row.originId) : null;
      if (message) messages.push(message);
    }
    return {messages, nextCursor: following ? result.nextCursor : result.latestCursor,
      ...(following ? {hasMore: result.hasMore} : {olderCursor: result.hasMore ? result.nextCursor : null})};
  };
  let page = readPage();
  const caughtUp = () => page.messages.length === 0 && page.nextCursor === since && "hasMore" in page && !page.hasMore;
  if (following && hold > 0 && caughtUp()) {
    const deadline = Date.now() + hold;
    while (!input.signal.aborted && Date.now() < deadline) {
      try {
        await input.activity.wait(linkLogWaitGroup(input.workspaceId), input.waiter, {
          holdMs: Math.max(1, deadline - Date.now()), signal: input.signal,
          shouldPark: () => {
            try {page = readPage(); return caughtUp();}
            catch {return false;}
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
  const envelope = {shareId: input.shareId, channelWireId: input.channelWireId, ...page};
  const messages: Message[] = [];
  let skippedCursor: number | undefined;
  const partial = (selected: Message[]) => ({...envelope, messages: selected,
    ...(following ? {nextCursor: (selected[selected.length - 1]?.relaySeq ?? skippedCursor ?? position ?? page.nextCursor), hasMore: true} :
      {olderCursor: (selected[selected.length - 1]?.relaySeq ?? skippedCursor ?? position ?? page.nextCursor)})});
  const fits = (value: unknown) => Buffer.byteLength(JSON.stringify(value)) <= input.maxResponseBytes;
  let truncated = false;
  for (const message of page.messages) {
    let omitted = project({...message, body: null, bodyTooLarge: true});
    if (!fits(partial([omitted]))) {
      omitted = project({...message, body: null, bodyTooLarge: true, messageId: `omitted:${message.relaySeq}`, threadId: "",
        authorUserId: null, authorDisplayName: "", authorOwnerDisplayName: null});
    }
    if (!fits(partial([...messages, omitted]))) {
      if (messages.length === 0) skippedCursor = message.relaySeq;
      truncated = true; break;
    }
    const projected = project(message);
    messages.push(fits(partial([...messages, projected])) ? projected : omitted);
  }
  const complete = {...envelope, messages};
  return truncated || !fits(complete) ? partial(messages) : complete;
}
