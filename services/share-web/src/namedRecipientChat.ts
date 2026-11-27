import {
  MAX_DISCUSSION_ACTIVITY_HOLD_MS,
  MAX_NAMED_CHAT_FOLLOW_REQUESTS,
} from "@dohc/security-contract/share-discussion";
import { readBoundedJson } from "@dohc/service-http";
import { CHAT_WAKE_ID, ChatWakeState } from "@dohc/workspace-contracts/chat-wakes";
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

const DELETED_KEYS = "deletedAtMs,messageId,relaySeq,threadId";

/** A delete a page passes: the reader replaces that message's line. */
function deletedEntry(value: unknown): boolean {
  return (
    record(value) &&
    Object.keys(value).sort().join() === DELETED_KEYS &&
    typeof value.messageId === "string" &&
    typeof value.threadId === "string" &&
    Number.isSafeInteger(value.deletedAtMs) &&
    Number.isSafeInteger(value.relaySeq) &&
    Number(value.relaySeq) > 0
  );
}

function message(value: unknown): boolean {
  if (!record(value)) return false;
  // A deleted message's line keeps who wrote it and when, and has no body.
  const { deletedAtMs, ...line } = value;
  if (Object.hasOwn(value, "deletedAtMs")) {
    if (!Number.isSafeInteger(deletedAtMs) || line.body !== null || line.bodyTooLarge !== false)
      return false;
    value = line;
  }
  if (!record(value) || Object.keys(value).sort().join() !== MESSAGE_KEYS) return false;
  return (
    ["messageId", "threadId", "authorDisplayName"].every((key) => typeof value[key] === "string") &&
    (value.lane === "posts" || value.lane === "chat") &&
    (value.parentMessageId === null ||
      (typeof value.parentMessageId === "string" && value.lane === "chat")) &&
    (value.startsPost === false || (value.startsPost === true && value.lane === "posts")) &&
    (value.authorUserId === null || typeof value.authorUserId === "string") &&
    ((value.bodyTooLarge === true && value.body === null) ||
      (value.bodyTooLarge === false && typeof value.body === "string") ||
      (deletedAtMs !== undefined && value.bodyTooLarge === false && value.body === null)) &&
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

/** The wakes of one of the owner's posts: only its own fields, in a state the phone shows. */
function wakesMatch(value: Record<string, unknown>): boolean {
  return (
    Object.keys(value).sort().join() ===
      [typeof value.path === "string" ? "path" : "channelWireId", "messageId", "shareId", "wakes"]
        .sort()
        .join() &&
    typeof (value.path ?? value.channelWireId) === "string" &&
    typeof value.messageId === "string" &&
    Array.isArray(value.wakes) &&
    value.wakes.every(
      (wake) =>
        record(wake) &&
        Object.keys(wake).sort().join() === "agentName,state,wakeId" &&
        typeof wake.wakeId === "string" &&
        CHAT_WAKE_ID.test(wake.wakeId) &&
        ChatWakeState.safeParse(wake.state).success &&
        (wake.agentName === null || typeof wake.agentName === "string"),
    )
  );
}

function resultMatches(
  value: Record<string, unknown>,
  channels: boolean,
  write: boolean,
  following: boolean,
  everyGroup: boolean,
  deleting: boolean,
): boolean {
  if (typeof value.shareId !== "string") return false;
  if (deleting) {
    const { deleted } = value;
    return (
      Object.keys(value).sort().join() === "deleted,shareId" &&
      record(deleted) &&
      Object.keys(deleted).sort().join() === "deletedAtMs,messageId,threadId" &&
      typeof deleted.messageId === "string" &&
      typeof deleted.threadId === "string" &&
      Number.isSafeInteger(deleted.deletedAtMs)
    );
  }
  const deletes = Array.isArray(value.deleted) && value.deleted.every(deletedEntry);
  if (everyGroup)
    return (
      Object.keys(value).sort().join() === "deleted,hasMore,messages,nextCursor,shareId" &&
      deletes &&
      Array.isArray(value.messages) &&
      value.messages.every(groupMessage) &&
      Number.isSafeInteger(value.nextCursor) &&
      Number(value.nextCursor) >= 0 &&
      typeof value.hasMore === "boolean"
    );
  if (channels)
    return (
      // A workspace share's listing says whether the reader may delete others' messages.
      (typeof value.moderates === "boolean"
        ? Object.keys(value).sort().join() ===
          "channels,maxBodyBytes,maxPostBytes,moderates,shareId,userId"
        : Object.keys(value).sort().join() ===
          "channels,maxBodyBytes,maxPostBytes,shareId,userId") &&
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
        ? ["deleted", "hasMore", "messages", "nextCursor", "shareId"]
        : ["deleted", "messages", "nextCursor", "olderCursor", "shareId"],
    ) &&
    deletes &&
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
      write = request.method === "POST",
      deleting = url.pathname === "/api/named-chat/messages/delete",
      waking = url.pathname === "/api/named-chat/wakes";
    const following = !write && url.pathname.endsWith("/messages") && url.searchParams.has("since");
    const pool = following ? followCalls : calls;
    if (
      ![
        "/api/named-chat/channels",
        "/api/named-chat/messages",
        "/api/named-chat/messages/delete",
        "/api/named-chat/wakes",
      ].includes(url.pathname) ||
      (request.method !== "GET" && (!write || url.pathname === "/api/named-chat/channels")) ||
      ((deleting || waking) && !write) ||
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
          let body: string | undefined, input: unknown;
          if (write) {
            try {
              input = await readBoundedJson(request, limits.maxRequestBytes, signal);
              body = JSON.stringify(input);
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
          // The owner's page names their workspace, and keys its chat `owner:<workspace>`.
          const key = write ? record(input) && input.shareId : url.searchParams.get("shareId");
          const owned =
            url.searchParams.get("workspaceId") ??
            (typeof key === "string" && key.startsWith("owner:") ? key.slice(6) : null);
          if (owned !== null && !/^[A-Za-z0-9_.:-]{1,256}$/u.test(owned)) return refuse();
          // Wake status is the owner's alone: a member's or link holder's page never reaches the relay for it.
          if (waking && owned === null) return refuse();
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
                ...(owned === null ? {} : { authorization: `DohcOwner ${owned}` }),
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
            if (waking && (!wakesMatch(result) || result.shareId !== key)) return refuse();
            if (
              !waking &&
              !resultMatches(
                result,
                url.pathname.endsWith("/channels"),
                write,
                following,
                everyGroup,
                deleting,
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
