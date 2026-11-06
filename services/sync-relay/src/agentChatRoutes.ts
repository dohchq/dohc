import { jsonResponse, readBoundedJson } from "@dohc/service-http";
import { DiscussionActivityCapacityError, linkLogWaitGroup, type DiscussionActivityHub } from "./discussionActivity";
import { errorResponse, notFound, RelayError, relayError } from "./errors";
import { linkChatMessage, refusePost, LINK_CHAT_MAX_POST_BYTES, LINK_CHAT_MAX_RESPONSE_BYTES, type LinkChatMessage } from "./linkChatRoutes";
import { hashAgentCredential } from "./linkSecurity";
import { messageFromOp } from "./namedRecipientChat";
import { authorizeLinkChatAction } from "./shareAuthorization";
import { filterOpForShare } from "./shareFilter";
import type { createShareReadQueries } from "./shareReadQueries";
import type { SyncRelayStorage } from "./storage";

// share-web calls these over the relay exchange key for an agent connected
// to a Group link. The access token alone names the connection; the
// connection names its link principal, which is the post's authority. No
// field in the request can name the author.
export type AgentChatRoute = { route: "agent-chat"; action: "post" | "wait" };

// The longest single hold. share-web answers within its own request
// deadline, so it may ask for less, never more.
export const AGENT_CHAT_MAX_WAIT_MS = 25_000;
export const MAX_AGENT_CHAT_WAITS_PER_CONNECTION = 4;
// Rows per scan of the channel; a page of messages at the body cap fits the response.
const WAIT_PAGE_ROWS = 16;
const TOKEN_CHARS = 64;
const THREAD_ID_CHARS = 256;

type AgentChatStorage = Pick<SyncRelayStorage,
  | "appendAgentChatPost" | "authenticateAgentAccessToken" | "fetchChatMessages" | "findChannelCreateKind"
  | "getShare" | "getShareGrant" | "getShareLabels" | "workspaceIsOwnedBy"
>;

class Refused extends Error {}

function fields(input: Record<string, unknown>, required: readonly string[], optional: readonly string[]): void {
  const allowed = new Set([...required, ...optional]);
  if (Object.keys(input).some(key => !allowed.has(key)) || required.some(key => !(key in input))) throw new Refused();
}

function text(value: unknown, maxChars: number): string {
  if (typeof value !== "string" || value.length === 0 || value.length > maxChars) throw new Refused();
  return value;
}

function boundedInteger(value: unknown, max: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > max) throw new Refused();
  return value;
}

export interface AgentChatWaitBody {
  ok: true;
  group: { channelWireId: string; name: string | null };
  messages: LinkChatMessage[];
  cursor: number;
}

export function createAgentChatRoutes(input: {
  storage: AgentChatStorage;
  linkKey: string | Uint8Array | undefined;
  relayExchangeKeyConfigured: boolean;
  hasValidRelayExchangeKey: (request: Request) => boolean;
  nowMs: () => number;
  activity: Pick<DiscussionActivityHub, "wait" | "wakeLog">;
  reads: Pick<ReturnType<typeof createShareReadQueries>, "chatResolverFor">;
  maxResponseBytes?: number;
}) {
  const { storage, linkKey, nowMs } = input;
  const maxResponseBytes = input.maxResponseBytes ?? LINK_CHAT_MAX_RESPONSE_BYTES;
  const waitsByConnection = new Map<string, number>();

  async function readInternal(request: Request): Promise<Record<string, unknown>> {
    if (!linkKey || !input.relayExchangeKeyConfigured || !input.hasValidRelayExchangeKey(request) || request.method !== "POST") {
      throw new Refused();
    }
    let body: unknown;
    try {
      body = await readBoundedJson(request, LINK_CHAT_MAX_POST_BYTES, request.signal);
    } catch {
      throw new Refused();
    }
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new Refused();
    return body as Record<string, unknown>;
  }

  const accessHash = (body: Record<string, unknown>) => hashAgentCredential("access", text(body.accessToken, TOKEN_CHARS), linkKey!);

  // The connection is active, its link is current at the generation it
  // signed in with, and the link is on a Group whose channel it may read.
  const current = (tokenHash: string) => {
    const connection = storage.authenticateAgentAccessToken(tokenHash, nowMs());
    if (!connection) throw new Refused();
    const authorized = authorizeLinkChatAction({ storage, grantId: connection.grantId, action: "read" });
    if (!authorized.ok || authorized.grant.generation !== connection.generation ||
        authorized.share.shareId !== connection.shareId) throw new Refused();
    return { connection, authorized };
  };

  function post(body: Record<string, unknown>): Response {
    fields(body, ["accessToken", "body", "idempotencyKey"], ["threadId"]);
    if (typeof body.body !== "string" || typeof body.idempotencyKey !== "string" ||
        (body.threadId !== undefined && typeof body.threadId !== "string")) throw new Refused();
    const result = storage.appendAgentChatPost({
      accessTokenHash: accessHash(body),
      threadId: body.threadId ?? null,
      body: body.body,
      idempotencyKey: body.idempotencyKey,
      createdAtMs: nowMs(),
    });
    if (!result.ok) {
      if (result.reason === "not-authorized") throw new Refused();
      return refusePost(result.reason);
    }
    if (!result.replayed) input.activity.wakeLog(result.workspaceId);
    const message = messageFromOp({ relaySeq: result.row.relaySeq, opKind: result.row.opKind, payload: JSON.parse(result.row.payloadJson) },
      result.row.originId);
    if (!message) throw new Error("stored agent post is not a chat message");
    return jsonResponse({ ok: true, message: linkChatMessage(message) });
  }

  // Holds until a message the link may read arrives in its channel, or the
  // deadline passes. Rows the link may not read, other threads, and the
  // agent's own posts move the cursor without ending the hold. Access is
  // checked before every scan, so before parking and after each wake, and
  // again before the answer leaves.
  async function wait(body: Record<string, unknown>, signal: AbortSignal): Promise<Response> {
    fields(body, ["accessToken"], ["cursor", "threadId", "timeoutMs"]);
    const tokenHash = accessHash(body);
    const threadId = body.threadId === undefined ? null : text(body.threadId, THREAD_ID_CHARS);
    const timeoutMs = body.timeoutMs === undefined ? AGENT_CHAT_MAX_WAIT_MS : boundedInteger(body.timeoutMs, AGENT_CHAT_MAX_WAIT_MS);
    const requestedCursor = body.cursor === undefined ? null : boundedInteger(body.cursor, Number.MAX_SAFE_INTEGER);
    const deadline = nowMs() + timeoutMs;
    const first = current(tokenHash);
    const { connectionId, principalId } = first.connection;
    const { workspaceId, shareId } = first.authorized.share;
    const { channelWireId } = first.authorized.effectiveSelector;
    const resolver = input.reads.chatResolverFor(workspaceId);
    const held = waitsByConnection.get(connectionId) ?? 0;
    if (held >= MAX_AGENT_CHAT_WAITS_PER_CONNECTION) throw relayError("link_read_rate_limited");
    waitsByConnection.set(connectionId, held + 1);
    try {
      let position = requestedCursor ?? storage.fetchChatMessages({ workspaceId, channelWireId, cursor: null, direction: "older", limit: 1 }).latestCursor;
      const scan = () => {
        const { authorized } = current(tokenHash);
        if (authorized.effectiveSelector.channelWireId !== channelWireId) throw new Refused();
        const page = storage.fetchChatMessages({ workspaceId, channelWireId, cursor: position, direction: "newer", limit: WAIT_PAGE_ROWS });
        const found: LinkChatMessage[] = [];
        for (const row of page.rows) {
          if (row.settlementAdmission?.status === "refused") continue;
          const decision = filterOpForShare(authorized.effectiveSelector, row.opKind, row.payloadJson, resolver, "chat");
          if (!decision.allowed || (decision.payload as { linkPrincipalId?: unknown }).linkPrincipalId === principalId) continue;
          const message = messageFromOp({ relaySeq: row.relaySeq, opKind: row.opKind, payload: decision.payload }, row.originId);
          if (message && (threadId === null || message.threadId === threadId)) found.push(linkChatMessage(message));
        }
        position = page.nextCursor;
        return { found, more: page.hasMore };
      };
      let result = scan();
      while (result.found.length === 0 && !signal.aborted && nowMs() < deadline) {
        if (result.more) {result = scan(); continue;}
        try {
          await input.activity.wait(linkLogWaitGroup(workspaceId), `agent:${connectionId}`, {
            holdMs: Math.max(1, deadline - nowMs()), signal,
            shouldPark: () => {
              try {result = scan(); return result.found.length === 0 && !result.more;}
              catch {return false;}
            },
          });
        } catch (error) {
          if (error instanceof DiscussionActivityCapacityError) throw relayError("link_read_rate_limited");
          throw error;
        }
        if (result.found.length === 0) result = scan();
      }
      if (signal.aborted) throw new Refused();
      current(tokenHash);
      const answer: AgentChatWaitBody = {
        ok: true, group: { channelWireId, name: storage.getShareLabels(shareId).subjectName }, messages: [], cursor: position,
      };
      for (const message of result.found) {
        const next = { ...answer, messages: [...answer.messages, message], cursor: message.relaySeq };
        if (answer.messages.length > 0 && Buffer.byteLength(JSON.stringify(next)) > maxResponseBytes) {
          answer.cursor = answer.messages[answer.messages.length - 1]!.relaySeq;
          break;
        }
        answer.messages.push(message);
      }
      return jsonResponse(answer);
    } finally {
      const count = (waitsByConnection.get(connectionId) ?? 1) - 1;
      if (count === 0) waitsByConnection.delete(connectionId); else waitsByConnection.set(connectionId, count);
    }
  }

  return async function respondToAgentChat(request: Request, route: AgentChatRoute): Promise<Response> {
    try {
      const body = await readInternal(request);
      return route.action === "post" ? post(body) : await wait(body, request.signal);
    } catch (error) {
      if (error instanceof Refused) return errorResponse(notFound());
      if (error instanceof RelayError) return errorResponse(error);
      throw error;
    }
  };
}
