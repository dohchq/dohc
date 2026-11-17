import {
  MAX_DISCUSSION_ACTIVITY_HOLD_MS,
  MAX_NAMED_CHAT_FOLLOW_REQUESTS,
} from "@dohc/security-contract/share-discussion";
import { readBoundedJson } from "@dohc/service-http";
import { namedAccountCookie } from "./namedAccountCookie";
import {
  parseNamedLiveBrowserClientLimits,
  type NamedLiveBrowserClientLimits,
} from "./namedLiveBrowserClient";
import { createNamedRelayCalls } from "./namedRelayCalls";

const cacheHeaders = { "cache-control": "private, no-store" };

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

const MESSAGE_KEYS =
  "authorDisplayName,authorKind,authorOwnerDisplayName,authorUserId,body,bodyTooLarge,createdAtMs,lane,linkAgent,messageId,parentMessageId,relaySeq,startsPost,threadId";

/** A message in a follow of every Group a workspace share reaches also names its Group. */
function groupMessage(value: unknown): boolean {
  if (!record(value) || typeof value.channelWireId !== "string") return false;
  const { channelWireId: _group, ...rest } = value;
  return message(rest);
}

function message(value: unknown): boolean {
  if (!record(value) || Object.keys(value).sort().join() !== MESSAGE_KEYS) return false;
  return (
    ["messageId", "threadId", "authorDisplayName"].every((key) => typeof value[key] === "string") &&
    (value.lane === "posts" || value.lane === "chat") &&
    (value.parentMessageId === null ||
      (typeof value.parentMessageId === "string" && value.lane === "chat")) &&
    (value.startsPost === false || (value.startsPost === true && value.lane === "posts")) &&
    (value.authorUserId === null || typeof value.authorUserId === "string") &&
    ((value.bodyTooLarge === true && value.body === null) ||
      (value.bodyTooLarge === false && typeof value.body === "string")) &&
    ["human", "agent", "automation", "link"].includes(String(value.authorKind)) &&
    (value.authorOwnerDisplayName === null || typeof value.authorOwnerDisplayName === "string") &&
    // A link holder has no account.
    (value.authorKind !== "link" ||
      (value.authorUserId === null && value.authorOwnerDisplayName === null)) &&
    // Only a link post can come from an agent connection.
    (value.linkAgent === false || (value.linkAgent === true && value.authorKind === "link")) &&
    Number.isSafeInteger(value.createdAtMs) &&
    Number.isSafeInteger(value.relaySeq) &&
    Number(value.relaySeq) > 0
  );
}

function resultMatches(
  value: Record<string, unknown>,
  channels: boolean,
  write: boolean,
  following: boolean,
  everyGroup: boolean,
): boolean {
  if (typeof value.shareId !== "string") return false;
  if (everyGroup)
    return (
      Object.keys(value).sort().join() === "hasMore,messages,nextCursor,shareId" &&
      Array.isArray(value.messages) &&
      value.messages.every(groupMessage) &&
      Number.isSafeInteger(value.nextCursor) &&
      Number(value.nextCursor) >= 0 &&
      typeof value.hasMore === "boolean"
    );
  if (channels)
    return (
      Object.keys(value).sort().join() === "channels,maxBodyBytes,maxPostBytes,shareId,userId" &&
      typeof value.userId === "string" &&
      Number.isSafeInteger(value.maxPostBytes) &&
      Number(value.maxPostBytes) > 0 &&
      Number.isSafeInteger(value.maxBodyBytes) &&
      Number(value.maxBodyBytes) > 0 &&
      Array.isArray(value.channels) &&
      value.channels.every(
        (channel) =>
          record(channel) &&
          Object.keys(channel).sort().join() === "access,channelWireId,kind,name,type" &&
          typeof channel.channelWireId === "string" &&
          (channel.type === "posts" || channel.type === "chat" || channel.type === "both") &&
          (channel.name === null || typeof channel.name === "string") &&
          (channel.kind === null || channel.kind === "channel" || channel.kind === "dm") &&
          (channel.access === "read-only" || channel.access === "read-write"),
      )
    );
  // A file's Comments answer with the file's path where a channel answers with its wire ID.
  const place =
    typeof value.channelWireId === "string"
      ? "channelWireId"
      : typeof value.path === "string"
        ? "path"
        : null;
  if (!place) return false;
  const keys = (names: string[]) =>
    Object.keys(value).sort().join() === [place, ...names].sort().join();
  if (write) return keys(["message", "shareId"]) && message(value.message);
  return (
    keys(
      following
        ? ["hasMore", "messages", "nextCursor", "shareId"]
        : ["messages", "nextCursor", "olderCursor", "shareId"],
    ) &&
    Array.isArray(value.messages) &&
    value.messages.every(message) &&
    Number.isSafeInteger(value.nextCursor) &&
    Number(value.nextCursor) >= 0 &&
    (following
      ? typeof value.hasMore === "boolean"
      : value.olderCursor === null ||
        (Number.isSafeInteger(value.olderCursor) && Number(value.olderCursor) >= 0))
  );
}

export function createNamedRecipientChatClient(options: {
  relayUrl: string;
  publicOrigin: string;
  exchangeKey: string;
  limits: NamedLiveBrowserClientLimits;
  fetchRelay(request: Request): Promise<Response>;
}) {
  const limits = parseNamedLiveBrowserClientLimits(options.limits),
    origin = new URL(options.publicOrigin);
  if (
    origin.protocol !== "https:" ||
    origin.origin !== options.publicOrigin ||
    options.exchangeKey.length < 32
  ) {
    throw new TypeError("Invalid named chat configuration.");
  }
  const refuse = () =>
    Response.json({ ok: false, error: "not found" }, { status: 404, headers: cacheHeaders });
  const unavailable = () => new Response(null, { status: 503, headers: cacheHeaders });
  const calls = createNamedRelayCalls({
    maxPending: limits.maxPendingRequests,
    timeoutMs: limits.timeoutMs,
    unrefDeadline: false,
    refuse,
    unavailable,
    fetchRelay: options.fetchRelay,
  });
  const followCalls = createNamedRelayCalls({
    maxPending: MAX_NAMED_CHAT_FOLLOW_REQUESTS,
    timeoutMs: limits.timeoutMs,
    unrefDeadline: false,
    refuse,
    unavailable,
    fetchRelay: options.fetchRelay,
  });
  const followsByCookie = new Map<string, number>();
  const rateLimited = () =>
    Response.json(
      { ok: false, error: "too many chat requests", code: "share_access_rate_limited" },
      { status: 429, headers: cacheHeaders },
    );
  return async (request: Request): Promise<Response> => {
    const url = new URL(request.url),
      write = request.method === "POST";
    const following = !write && url.pathname.endsWith("/messages") && url.searchParams.has("since");
    const pool = following ? followCalls : calls;
    if (
      !["/api/named-chat/channels", "/api/named-chat/messages"].includes(url.pathname) ||
      (request.method !== "GET" && (!write || url.pathname !== "/api/named-chat/messages")) ||
      request.signal.aborted ||
      request.headers.get("host") !== origin.host ||
      request.headers.get("sec-fetch-site") === "cross-site" ||
      (write &&
        (url.search ||
          request.headers.get("origin") !== options.publicOrigin ||
          request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !==
            "application/json")) ||
      (!write &&
        request.headers.has("origin") &&
        request.headers.get("origin") !== options.publicOrigin)
    )
      return refuse();
    const cookie = namedAccountCookie(request.headers.get("cookie"), options.publicOrigin);
    if (!cookie)
      return Response.json(
        { ok: false, error: "signed out", code: "signed_out" },
        { status: 401, headers: cacheHeaders },
      );
    if (
      pool.full ||
      (following && (followsByCookie.get(cookie) ?? 0) >= limits.maxPendingRequests)
    ) {
      return rateLimited();
    }
    if (following) followsByCookie.set(cookie, (followsByCookie.get(cookie) ?? 0) + 1);
    return pool.run(
      request,
      async (signal, relay) => {
        try {
          let body: string | undefined;
          if (write) {
            try {
              body = JSON.stringify(await readBoundedJson(request, limits.maxRequestBytes, signal));
            } catch (error) {
              if (error instanceof RangeError && !signal.aborted)
                return Response.json(
                  { ok: false, error: "Post is too large.", code: "payload_too_large" },
                  { status: 413, headers: cacheHeaders },
                );
              throw error;
            }
            if (Buffer.byteLength(body) > limits.maxRequestBytes)
              return Response.json(
                { ok: false, error: "Post is too large.", code: "payload_too_large" },
                { status: 413, headers: cacheHeaders },
              );
          }
          const relayUrl = new URL(url.pathname.replace("/api/", "/sync/"), options.relayUrl);
          relayUrl.search = url.search;
          const response = await relay(
            new Request(relayUrl, {
              method: request.method,
              redirect: "manual",
              signal,
              ...(body === undefined ? {} : { body }),
              headers: {
                cookie,
                origin: options.publicOrigin,
                "x-dohc-relay-exchange-key": options.exchangeKey,
                ...(write ? { "content-type": "application/json" } : {}),
              },
            }),
          );
          if (response.redirected || response.headers.has("location")) return refuse();
          if (response.status >= 500) return unavailable();
          if (
            response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !==
              "application/json" ||
            ![200, 400, 401, 403, 404, 409, 413, 429].includes(response.status)
          )
            return refuse();
          const result = await readBoundedJson(response, limits.maxResponseBytes, signal);
          if (!record(result)) return refuse();
          if (response.status === 200) {
            // A workspace share's follow names no Group and no file, and gets every Group it reaches.
            const onFile = url.searchParams.has("path");
            const everyGroup = following && !url.searchParams.has("channelWireId") && !onFile;
            if (
              !resultMatches(
                result,
                url.pathname.endsWith("/channels"),
                write,
                following,
                everyGroup,
              )
            )
              return refuse();
            if (
              !write &&
              !url.pathname.endsWith("/channels") &&
              (result.shareId !== url.searchParams.get("shareId") ||
                (!everyGroup &&
                  (onFile
                    ? result.path !== url.searchParams.get("path")
                    : result.channelWireId !== url.searchParams.get("channelWireId"))))
            )
              return refuse();
          } else if (
            result.ok !== false ||
            typeof result.error !== "string" ||
            (result.code !== undefined && typeof result.code !== "string")
          )
            return refuse();
          if (response.status === 200 && url.pathname.endsWith("/channels"))
            result.maxPostBytes = Math.min(Number(result.maxPostBytes), limits.maxRequestBytes);
          return Response.json(result, { status: response.status, headers: cacheHeaders });
        } finally {
          if (following) {
            const count = (followsByCookie.get(cookie) ?? 1) - 1;
            if (count === 0) followsByCookie.delete(cookie);
            else followsByCookie.set(cookie, count);
          }
        }
      },
      Math.min(
        2_147_483_647,
        limits.timeoutMs +
          (!write && url.searchParams.has("since") ? MAX_DISCUSSION_ACTIVITY_HOLD_MS : 0),
      ),
    );
  };
}
