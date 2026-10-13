import { readBoundedJson } from "@dohc/service-http";
import { parseLiveUpdateIdentifier } from "@dohc/live-session-contract/live-update-admission";
import type { ResolveActor } from "@dohc/workspace-auth/session";
import { sha256Hex } from "@dohc/workspace-core/hash";
import { badRequest, errorResponse, notFound, RelayError, relayError } from "./errors";
import { hashRelayExchangeKey, verifyRelayExchangeKey } from "./linkSecurity";
import { parseLinkLogHold } from "./linkReadRoutes";
import type { NamedLiveBrowserHttpLimits } from "./namedLiveBrowserHttp";
import type { createNamedShareTransportRoutes } from "./namedShareTransportRoutes";
import { namedShareOrigin } from "./relayLogInputs";
import { parseLimit, parseString } from "./requestInputs";
import type { AuthorizedShareAction } from "./shareAuthorization";
import { chatSideOf, filterOpForShare } from "./shareFilter";
import type { createShareReadQueries } from "./shareReadQueries";
import type { SyncRelayStorage } from "./storage";
import { MAX_DISCUSSION_ACTIVITY_HOLD_MS } from "./wireLimits";

const MAX_HISTORY_ROWS = 2_000;
const MAX_MESSAGE_BODY_BYTES = 64 * 1024;
const cacheHeaders = {"cache-control": "private, no-store"};

export interface NamedChatMessage {
  relaySeq: number;
  messageId: string;
  threadId: string;
  authorUserId: string;
  authorDisplayName: string;
  authorKind: "human" | "agent" | "automation";
  authorOwnerDisplayName: string | null;
  createdAtMs: number;
  body: string;
}

function messageFromOp(op: Record<string, unknown>): NamedChatMessage | null {
  if (op.opKind !== "chat.message.append" || !op.payload || typeof op.payload !== "object") return null;
  const p = op.payload as Record<string, unknown>;
  if (typeof op.relaySeq !== "number" || typeof p.messageId !== "string" || typeof p.threadId !== "string" ||
      typeof p.authorUserId !== "string" || typeof p.authorDisplayName !== "string" || typeof p.body !== "string" ||
      typeof p.createdAtMs !== "number" || !["human", "agent", "automation"].includes(String(p.authorKind))) return null;
  return {relaySeq: op.relaySeq, messageId: p.messageId, threadId: p.threadId, authorUserId: p.authorUserId,
    authorDisplayName: p.authorDisplayName, authorKind: p.authorKind as NamedChatMessage["authorKind"],
    authorOwnerDisplayName: typeof p.authorOwnerDisplayName === "string" ? p.authorOwnerDisplayName : null,
    createdAtMs: p.createdAtMs, body: p.body};
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
  let pending = 0;
  const refuse = () => Response.json({ok: false, error: "not found"}, {status: 404, headers: cacheHeaders});
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
    if (pending >= limits.maxPendingRequests) return errorResponse(relayError("share_access_rate_limited"));
    pending++;
    const controller = new AbortController(), abort = () => controller.abort();
    const cancelled = new Promise<Response>(resolve => controller.signal.addEventListener("abort", () => resolve(refuse()), {once: true}));
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
          const allowed = new Set(["shareId", "channelWireId", "id", "threadId", "body", "authorKind", "authorDisplayName", "authorOwnerDisplayName", "authorUserId"]);
          if (Object.keys(input).some(key => !allowed.has(key))) throw relayError("share_op_rejected");
        } else {
          const allowed = channels ? ["grantId"] : ["shareId", "channelWireId", "before", "since", "hold", "limit"];
          if ([...url.searchParams.keys()].some(key => !allowed.includes(key) || url.searchParams.getAll(key).length !== 1)) throw badRequest("invalid query");
        }
        const grantId = channels ? invitationId(url.searchParams.get("grantId")) : undefined;
        const grant = grantId ? storage.getShareGrant(grantId) : undefined;
        const shareId = channels ? grant?.shareId : parseString(request.method === "POST" ? input.shareId : url.searchParams.get("shareId"), "shareId", 256);
        const share = shareId && storage.getShare(shareId);
        if (!share || !shareId) throw notFound();
        // Forward only the account session. Route coordinates and payload identity never authenticate a caller.
        const actor = await options.resolveActor(new Request(request.url, {
          headers: {cookie: request.headers.get("cookie") ?? ""}, signal: controller.signal,
        }), share.workspaceId);
        controller.signal.throwIfAborted();
        if (actor.workspaceId !== share.workspaceId) throw notFound();
        const authority = requireShareAction(shareId, actor.userId, "read");
        const chat = chatSideOf(authority.effectiveSelector);
        if (!chat || authority.share.workspaceId !== share.workspaceId) throw notFound();
        const recheck = () => {
          const fresh = requireShareAction(shareId, actor.userId, "read");
          if (fresh.share.workspaceId !== share.workspaceId || chatSideOf(fresh.effectiveSelector)?.channelWireId !== chat.channelWireId) throw notFound();
          controller.signal.throwIfAborted();
        };
        if (channels) {
          const writable = (() => {
            try {requireShareAction(shareId, actor.userId, "append"); return true;}
            catch (error) {if (error instanceof RelayError && error.code === "share_read_only") return false; throw error;}
          })();
          const labels = storage.getShareLabels(shareId);
          recheck();
          return json({shareId, userId: actor.userId, channels: [{channelWireId: chat.channelWireId, name: labels.subjectName,
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
          if (authorKind !== "human" && authorKind !== "agent" && authorKind !== "automation") throw badRequest("invalid author kind");
          const authorDisplayName = displayName(input.authorDisplayName);
          const authorOwnerDisplayName = input.authorOwnerDisplayName === undefined ? undefined :
            displayName(input.authorOwnerDisplayName);
          if (authorKind === "human" && authorOwnerDisplayName !== undefined) throw badRequest("invalid author owner");
          if (typeof input.body !== "string" || !input.body.isWellFormed()) throw badRequest("invalid body");
          const body = input.body.replace(/\r\n?/gu, "\n").trimEnd();
          if (!body || Buffer.byteLength(body) > MAX_MESSAGE_BODY_BYTES) throw badRequest("invalid body");
          const digest = sha256Hex(id), originId = `browser-chat:${digest}`;
          const storedOrigin = namedShareOrigin(shareId, actor.userId, originId);
          const messageId = `browser-message:${sha256Hex(JSON.stringify([shareId, actor.userId, id]))}`;
          const createThread = input.threadId === undefined;
          const threadId = createThread ? `browser-thread:${sha256Hex(JSON.stringify([shareId, actor.userId, id]))}` : parseString(input.threadId, "threadId", 256);
          if (!threadId.isWellFormed()) throw badRequest("invalid thread id");
          const coordinate = (originSeq: number) => storage.fetchLogCoordinate({workspaceId: share.workspaceId, originId: storedOrigin, originSeq});
          const append = async () => {
            const createdAtMs = coordinate(0)?.recordedAtMs ?? options.nowMs();
            const ops = [
              ...(createThread ? [{opKind: "chat.thread.create", payload: {threadId, title: "", channelWireId, lane: "chat", createdAtMs}}] : []),
              {opKind: "chat.message.append", payload: {messageId, threadId, body, authorKind, authorDisplayName,
                authorUserId: actor.userId, ...(authorOwnerDisplayName === undefined ? {} : {authorOwnerDisplayName}), createdAtMs}},
            ].map((op, originSeq) => ({...op, originSeq, recordedAtMs: createdAtMs}));
            boundedJson({shareId, channelWireId, message: messageFromOp({relaySeq: Number.MAX_SAFE_INTEGER,
              opKind: "chat.message.append", payload: ops[ops.length - 1]!.payload})});
            return options.transport(new Request(request.url, {method: "POST", signal: controller.signal,
              headers: {"content-type": "application/json"}, body: JSON.stringify({originId, ops})}), {route: "share-log", shareId}, actor);
          };
          let result: Response;
          try {result = await append();}
          catch (error) {
            // A concurrent retry may have won with a different server timestamp.
            if (!(error instanceof RelayError) || error.code !== "conflict" || !coordinate(0)) throw error;
            result = await append();
          }
          if (!result.ok) return result;
          await result.body?.cancel();
          const row = coordinate(createThread ? 1 : 0);
          if (!row) throw notFound();
          recheck();
          return json({shareId, channelWireId, message: messageFromOp({relaySeq: row.relaySeq, opKind: row.opKind, payload: JSON.parse(row.payloadJson)})});
        }
        const limit = Math.min(parseLimit(url.searchParams.get("limit")), 100);
        if (url.searchParams.has("since")) {
          if (url.searchParams.has("before")) throw badRequest("invalid query");
          const since = cursor(url.searchParams.get("since")), hold = parseLinkLogHold(url.searchParams.get("hold"));
          const logUrl = new URL(request.url);
          logUrl.search = new URLSearchParams({channelWireId, since: String(since), limit: String(limit), hold: String(hold)}).toString();
          const response = await options.transport(new Request(logUrl, {signal: controller.signal}), {route: "share-log", shareId}, actor);
          if (!response.ok) return response;
          const page = await response.json() as {ops: Record<string, unknown>[]; nextCursor: number; hasMore: boolean};
          recheck();
          return json({shareId, channelWireId, messages: page.ops.flatMap(op => messageFromOp(op) ?? []), nextCursor: page.nextCursor, hasMore: page.hasMore});
        }
        if (url.searchParams.has("hold")) throw badRequest("hold requires since");
        let before = url.searchParams.has("before") ? cursor(url.searchParams.get("before")) : null;
        const messages: NamedChatMessage[] = [];
        const resolver = options.reads.chatResolverFor(share.workspaceId);
        let scanned = 0, nextCursor: number | undefined, hasOlder = true;
        while (scanned < MAX_HISTORY_ROWS && messages.length < limit) {
          const rows = storage.fetchLogPageDescending({workspaceId: share.workspaceId, beforeRelaySeq: before, limit: Math.min(100, MAX_HISTORY_ROWS - scanned)});
          if (!rows.length) {hasOlder = false; break;}
          for (const row of rows) {
            nextCursor ??= row.relaySeq;
            before = row.relaySeq;
            scanned++;
            if (row.opKind === "chat.message.append" && row.settlementAdmission?.status !== "refused") {
              const decision = filterOpForShare(authority.effectiveSelector, row.opKind, row.payloadJson, resolver, "chat");
              const message = decision.allowed ? messageFromOp({relaySeq: row.relaySeq, opKind: row.opKind, payload: decision.payload}) : null;
              if (message) messages.push(message);
            }
            if (messages.length === limit) break;
          }
        }
        recheck();
        return json({shareId, channelWireId, messages, nextCursor: nextCursor ?? before ?? 0, olderCursor: hasOlder ? before : null});
      } catch (error) {return controller.signal.aborted ? refuse() : errorResponse(error);}
      finally {pending--; clearTimeout(timer); request.signal.removeEventListener("abort", abort);}
    })();
    return Promise.race([work, cancelled]);
  };
  return handle;
}
