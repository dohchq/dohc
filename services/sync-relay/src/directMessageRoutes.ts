import { jsonResponse } from "@dohc/service-http";
import {
  DIRECT_ACTIVITY_MAX_WAIT_MS,
  DIRECT_MESSAGE_BODY_MAX_BYTES,
  DIRECT_PAGE_MAX,
  DIRECT_ROUTES,
  isDirectId,
  isDirectMessageBody,
  type DirectConversationList,
  type DirectMemberPick,
  type DirectMessagePage,
  type DirectResolution,
  type DirectSendResult,
} from "@dohc/security-contract/direct-messages";
import { accountDisplayName, type LookupUserDisplayName } from "./accountDisplayName";
import { DiscussionActivityCapacityError, type DiscussionActivityHub } from "./discussionActivity";
import { badRequest, notFound, relayError, RelayError } from "./errors";
import { parseShareId, parseWorkspaceId, readJsonObject } from "./requestInputs";
import type { SyncRelayStorage } from "./storage";

// The relay half of DIRECT_ROUTES in packages/security-contract/src/directMessages.ts.
// Every route acts as the signed-in account. Storage checks that the account
// is in the conversation, inside the transaction that reads or writes it.

export type DirectMessageRoute =
  | { route: "direct-conversations" }
  | { route: "direct-resolve" }
  | { route: "direct-send" }
  | { route: "direct-activity" }
  | { route: "direct-messages"; conversationId: string }
  | { route: "direct-read"; conversationId: string }
  | { route: "direct-block"; conversationId: string };

export const DIRECT_MESSAGE_ROUTE_PATTERNS = {
  "direct-conversations": DIRECT_ROUTES.conversations,
  "direct-resolve": DIRECT_ROUTES.resolve,
  "direct-send": DIRECT_ROUTES.send,
  "direct-activity": DIRECT_ROUTES.activity,
  "direct-messages": DIRECT_ROUTES.messages,
  "direct-read": DIRECT_ROUTES.read,
  "direct-block": DIRECT_ROUTES.block,
} as const satisfies Record<DirectMessageRoute["route"], string>;

export function isDirectMessageRoute(route: { route: string }): route is DirectMessageRoute {
  return Object.hasOwn(DIRECT_MESSAGE_ROUTE_PATTERNS, route.route);
}

const CONVERSATION_ACTIONS = { messages: "direct-messages", read: "direct-read", block: "direct-block" } as const;

/** Parses `/sync/direct/...`; null for any other path. "direct" is reserved as a workspace id. */
export function parseDirectMessageRoute(parts: readonly string[]): DirectMessageRoute | null {
  if (parts[0] !== "sync" || parts[1] !== "direct") return null;
  if (parts.length === 3) {
    if (parts[2] === "conversations") return { route: "direct-conversations" };
    if (parts[2] === "resolve") return { route: "direct-resolve" };
    if (parts[2] === "send") return { route: "direct-send" };
    if (parts[2] === "activity") return { route: "direct-activity" };
  }
  if (parts.length === 5 && parts[2] === "conversations" && isDirectId(parts[3])) {
    const route = CONVERSATION_ACTIONS[parts[4] as keyof typeof CONVERSATION_ACTIONS];
    if (route) return { route, conversationId: parts[3] };
  }
  throw notFound();
}

/** Each account's direct activity waits in its own group. */
export function directWaitGroup(userId: string): string {
  return `direct:${userId}`;
}

type DirectRouteStorage = Pick<SyncRelayStorage,
  | "resolveDirectPick" | "findDirectConversation" | "directPerson" | "sendDirectMessage" | "listDirectConversations"
  | "readDirectMessages" | "markDirectRead" | "setDirectBlock" | "directRevision">;

function parsePick(value: unknown): DirectMemberPick {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw badRequest("person is {workspaceId, memberId}");
  const pick = value as Record<string, unknown>;
  if (typeof pick.workspaceId !== "string" || typeof pick.memberId !== "string") throw badRequest("person is {workspaceId, memberId}");
  return { workspaceId: parseWorkspaceId(pick.workspaceId), memberId: pick.memberId === "owner" ? "owner" : parseShareId(pick.memberId) };
}

function parseCount(value: string | null, name: string): number | undefined {
  if (value === null) return undefined;
  if (!/^\d{1,15}$/u.test(value)) throw badRequest(`${name} must be a whole number`);
  return Number(value);
}

const noStore = { "cache-control": "private, no-store" };

export function createDirectMessageRoutes(options: {
  storage: DirectRouteStorage;
  activity: Pick<DiscussionActivityHub, "wait" | "wake">;
  nowMs: () => number;
  newId: () => string;
  lookupUserDisplayName?: LookupUserDisplayName;
}) {
  const { storage, activity } = options;
  // The relay's own names table knows most accounts. The account service fills in the rest, once per request.
  const namer = () => {
    const names = new Map<string, Promise<string | null>>();
    return <T extends { name: string | null } | { authorName: string | null }>(id: string, entry: T): Promise<T> => {
      const known = "name" in entry ? entry.name : entry.authorName;
      if (known !== null) return Promise.resolve(entry);
      let name = names.get(id);
      if (!name) names.set(id, name = accountDisplayName(options.lookupUserDisplayName, id));
      return name.then((found) => ("name" in entry ? { ...entry, name: found } : { ...entry, authorName: found }));
    };
  };
  const wake = (userIds: readonly string[]) => {
    for (const userId of userIds) activity.wake(directWaitGroup(userId));
  };

  const resolve = (userId: string, input: Record<string, unknown>) => {
    const other = storage.resolveDirectPick(userId, parsePick(input.person));
    if (!other) throw notFound();
    return other;
  };

  return async function respondToDirectMessages(request: Request, route: DirectMessageRoute, actor: { userId: string }): Promise<Response> {
    const { userId } = actor;
    const url = new URL(request.url);
    switch (route.route) {
      case "direct-conversations": {
        if (request.method !== "GET") throw relayError("method_not_allowed");
        const name = namer();
        const listed = storage.listDirectConversations(userId);
        const body: DirectConversationList = {
          revision: listed.revision,
          conversations: await Promise.all(listed.conversations.map(async (conversation) => ({
            ...conversation,
            person: await name(conversation.person.personId, conversation.person),
            last: await name(conversation.last.authorId, conversation.last),
          }))),
        };
        return jsonResponse(body, 200, noStore);
      }
      case "direct-resolve": {
        if (request.method !== "POST") throw relayError("method_not_allowed");
        const other = resolve(userId, await readJsonObject(request));
        const person = storage.directPerson(userId, other);
        const body: DirectResolution = {
          conversationId: storage.findDirectConversation(userId, other),
          person: await namer()(person.personId, person),
        };
        return jsonResponse(body, 200, noStore);
      }
      case "direct-send": {
        if (request.method !== "POST") throw relayError("method_not_allowed");
        const input = await readJsonObject(request);
        if (!isDirectId(input.messageId)) throw badRequest("messageId is invalid");
        if (!isDirectMessageBody(input.body)) throw badRequest(`body must be 1 to ${DIRECT_MESSAGE_BODY_MAX_BYTES} bytes`);
        if ((input.conversationId === undefined) === (input.person === undefined)) throw badRequest("send names a conversationId or a person");
        let target: { conversationId: string } | { personId: string };
        if (input.conversationId !== undefined) {
          if (!isDirectId(input.conversationId)) throw badRequest("conversationId is invalid");
          target = { conversationId: input.conversationId };
        } else {
          target = { personId: resolve(userId, input) };
        }
        const result = storage.sendDirectMessage({ callerUserId: userId, target, messageId: input.messageId, body: input.body, nowMs: options.nowMs(), newId: options.newId });
        if (!result.ok) {
          switch (result.reason) {
            case "not_found": throw notFound();
            case "blocked": throw relayError("direct_blocked");
            case "message_id_taken": throw relayError("direct_message_id_taken");
            case "rate_limited": throw relayError("direct_rate_limited");
            case "limit_reached": throw relayError("direct_limit_reached");
          }
        }
        wake(result.wake);
        const body: DirectSendResult = { conversationId: result.conversationId, seq: result.seq };
        return jsonResponse(body, 200, noStore);
      }
      case "direct-messages": {
        if (request.method !== "GET") throw relayError("method_not_allowed");
        const after = parseCount(url.searchParams.get("after"), "after");
        const before = parseCount(url.searchParams.get("before"), "before");
        if (after !== undefined && before !== undefined) throw badRequest("give after or before, not both");
        const limit = parseCount(url.searchParams.get("limit"), "limit") ?? DIRECT_PAGE_MAX;
        const page = storage.readDirectMessages(userId, route.conversationId, { after, before, limit });
        if (!page) throw notFound();
        const name = namer();
        const body: DirectMessagePage = {
          conversationId: route.conversationId,
          messages: await Promise.all(page.messages.map((message) => name(message.authorId, message))),
          more: page.more,
        };
        return jsonResponse(body, 200, noStore);
      }
      case "direct-read": {
        if (request.method !== "POST") throw relayError("method_not_allowed");
        const input = await readJsonObject(request);
        if (!Number.isSafeInteger(input.seq) || (input.seq as number) < 0) throw badRequest("seq must be a whole number");
        if (!storage.markDirectRead(userId, route.conversationId, input.seq as number)) throw notFound();
        wake([userId]);
        return jsonResponse({ ok: true }, 200, noStore);
      }
      case "direct-block": {
        if (request.method !== "POST") throw relayError("method_not_allowed");
        const input = await readJsonObject(request);
        if (typeof input.blocked !== "boolean") throw badRequest("block takes {blocked}");
        if (!storage.setDirectBlock({ viewerUserId: userId, conversationId: route.conversationId, blocked: input.blocked, nowMs: options.nowMs() })) {
          throw notFound();
        }
        wake([userId]);
        return jsonResponse({ ok: true }, 200, noStore);
      }
      case "direct-activity": {
        if (request.method !== "GET") throw relayError("method_not_allowed");
        const since = parseCount(url.searchParams.get("since"), "since") ?? 0;
        const waitMs = Math.min(DIRECT_ACTIVITY_MAX_WAIT_MS, parseCount(url.searchParams.get("waitMs"), "waitMs") ?? 0);
        if (waitMs > 0 && storage.directRevision(userId) <= since) {
          try {
            await activity.wait(directWaitGroup(userId), `direct:${userId}`, {
              holdMs: waitMs, signal: request.signal, shouldPark: () => storage.directRevision(userId) <= since,
            });
          } catch (error) {
            if (error instanceof DiscussionActivityCapacityError) {
              throw new RelayError("server_busy", "Your server is holding as many change requests as it can. Try again shortly.");
            }
            throw error;
          }
        }
        return jsonResponse({ revision: storage.directRevision(userId) }, 200, noStore);
      }
    }
  };
}
