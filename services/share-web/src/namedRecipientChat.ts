import { readBoundedJson } from "@dohc/service-http";
import { namedAccountCookie } from "./namedAccountCookie";
import { parseNamedLiveBrowserClientLimits, type NamedLiveBrowserClientLimits } from "./namedLiveBrowserClient";
import { createNamedRelayCalls } from "./namedRelayCalls";

const MAX_HOLD_MS = 30_000;
const cacheHeaders = {"cache-control": "private, no-store"};

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function message(value: unknown): boolean {
  if (!record(value) || Object.keys(value).sort().join() !== "authorDisplayName,authorKind,authorOwnerDisplayName,authorUserId,body,createdAtMs,messageId,relaySeq,threadId") return false;
  return ["messageId", "threadId", "authorUserId", "authorDisplayName", "body"].every(key => typeof value[key] === "string") &&
    ["human", "agent", "automation"].includes(String(value.authorKind)) &&
    (value.authorOwnerDisplayName === null || typeof value.authorOwnerDisplayName === "string") &&
    Number.isSafeInteger(value.createdAtMs) && Number.isSafeInteger(value.relaySeq) && Number(value.relaySeq) > 0;
}

function resultMatches(value: Record<string, unknown>, channels: boolean, write: boolean, following: boolean): boolean {
  if (typeof value.shareId !== "string") return false;
  if (channels) return Object.keys(value).sort().join() === "channels,shareId,userId" && typeof value.userId === "string" &&
    Array.isArray(value.channels) && value.channels.every(channel => record(channel) &&
      Object.keys(channel).sort().join() === "access,channelWireId,kind,name" && typeof channel.channelWireId === "string" &&
      (channel.name === null || typeof channel.name === "string") &&
      (channel.kind === null || channel.kind === "channel" || channel.kind === "dm") &&
      (channel.access === "read-only" || channel.access === "read-write"));
  if (typeof value.channelWireId !== "string") return false;
  if (write) return Object.keys(value).sort().join() === "channelWireId,message,shareId" && message(value.message);
  return Object.keys(value).sort().join() === (following ? "channelWireId,hasMore,messages,nextCursor,shareId" : "channelWireId,messages,nextCursor,olderCursor,shareId") &&
    Array.isArray(value.messages) && value.messages.every(message) && Number.isSafeInteger(value.nextCursor) && Number(value.nextCursor) >= 0 &&
    (following ? typeof value.hasMore === "boolean" : value.olderCursor === null || (Number.isSafeInteger(value.olderCursor) && Number(value.olderCursor) >= 0));
}

export function createNamedRecipientChatClient(options: {
  relayUrl: string; publicOrigin: string; exchangeKey: string; limits: NamedLiveBrowserClientLimits;
  fetchRelay(request: Request): Promise<Response>;
}) {
  const limits = parseNamedLiveBrowserClientLimits(options.limits), origin = new URL(options.publicOrigin);
  if (origin.protocol !== "https:" || origin.origin !== options.publicOrigin || options.exchangeKey.length < 32) {
    throw new TypeError("Invalid named chat configuration.");
  }
  const refuse = () => Response.json({ok: false, error: "not found"}, {status: 404, headers: cacheHeaders});
  const calls = createNamedRelayCalls({maxPending: limits.maxPendingRequests, timeoutMs: limits.timeoutMs,
    unrefDeadline: false, refuse, fetchRelay: options.fetchRelay});
  return async (request: Request): Promise<Response> => {
    const url = new URL(request.url), write = request.method === "POST";
    if (!["/api/named-chat/channels", "/api/named-chat/messages"].includes(url.pathname) ||
        (request.method !== "GET" && (!write || url.pathname !== "/api/named-chat/messages")) ||
        request.signal.aborted || request.headers.get("host") !== origin.host ||
        request.headers.get("sec-fetch-site") === "cross-site" || calls.full ||
        (write && (url.search || request.headers.get("origin") !== options.publicOrigin ||
          request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json")) ||
        (!write && request.headers.has("origin") && request.headers.get("origin") !== options.publicOrigin)) return refuse();
    const cookie = namedAccountCookie(request.headers.get("cookie"), options.publicOrigin);
    if (!cookie) return refuse();
    return calls.run(request, async (signal, relay) => {
      const body = write ? JSON.stringify(await readBoundedJson(request, limits.maxRequestBytes, signal)) : undefined;
      const relayUrl = new URL(url.pathname.replace("/api/", "/sync/"), options.relayUrl);
      relayUrl.search = url.search;
      const response = await relay(new Request(relayUrl, {
        method: request.method, redirect: "manual", signal, ...(body === undefined ? {} : {body}),
        headers: {cookie, origin: options.publicOrigin, "x-dohc-relay-exchange-key": options.exchangeKey,
          ...(write ? {"content-type": "application/json"} : {})},
      }));
      if (response.redirected || response.headers.has("location") ||
          response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json" ||
          ![200, 400, 401, 403, 404, 409, 413, 429, 503].includes(response.status)) return refuse();
      const result = await readBoundedJson(response, limits.maxResponseBytes, signal);
      if (!record(result)) return refuse();
      if (response.status === 200) {
        if (!resultMatches(result, url.pathname.endsWith("/channels"), write, url.searchParams.has("since"))) return refuse();
        if (!write && !url.pathname.endsWith("/channels") && (result.shareId !== url.searchParams.get("shareId") ||
            result.channelWireId !== url.searchParams.get("channelWireId"))) return refuse();
      } else if (result.ok !== false || typeof result.error !== "string" || (result.code !== undefined && typeof result.code !== "string")) return refuse();
      return Response.json(result, {status: response.status, headers: cacheHeaders});
    }, Math.min(2_147_483_647, limits.timeoutMs + (!write && url.searchParams.has("since") ? MAX_HOLD_MS : 0)));
  };
}
