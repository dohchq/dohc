import { jsonResponse, readBoundedJson } from "@dohc/service-http";
import { chatMentionTokens, handleForName, normalizeHandle } from "@dohc/workspace-contracts/chat-mentions";
import { DiscussionActivityCapacityError, linkLogWaitGroup, type DiscussionActivityHub } from "./discussionActivity";
import { errorResponse, notFound, RelayError, relayError } from "./errors";
import { agentAccessCheck } from "./linkAuthority";
import { linkChatMessage, refusePost, LINK_CHAT_MAX_POST_BYTES, type LinkChatMessage } from "./linkChatRoutes";
import { messageFromOp } from "./namedRecipientChat";
import { authorizeLinkChatAction } from "./shareAuthorization";
import { filterOpForShare } from "./shareFilter";
import type { createShareReadQueries } from "./shareReadQueries";
import type { SyncRelayStorage } from "./storage";
import { agentName, type AgentAccessCheck } from "./storage/agentConnections";

// share-web calls these over the relay exchange key for an agent connected
// to a Group link. The access token names the connection, and the MCP
// address must be the one it signed in at, as on the other link routes. The
// connection names its link principal, which is the post's authority. No
// field in the request can name the author.
export type AgentChatRoute = { route: "agent-chat"; action: "post" | "wait" };

// The longest single hold. share-web answers within its own request
// deadline, so it may ask for less, never more.
export const AGENT_CHAT_MAX_WAIT_MS = 25_000;
// Held waits per connection, per link and per workspace. With the browser
// follows' own caps, they keep a workspace's link readers inside the wait group's cap.
export const MAX_AGENT_CHAT_WAITS_PER_CONNECTION = 4;
export const MAX_AGENT_CHAT_WAITS_PER_LINK = 16;
export const MAX_AGENT_CHAT_WAITS_PER_WORKSPACE = 64;
// Rows per scan of the channel; a page of messages at the body cap fits the response.
const WAIT_PAGE_ROWS = 16;
// Half of share-web's result limit, so its projection of an answer, which
// repeats the Group with each message, still fits it.
export const AGENT_CHAT_WAIT_MAX_RESPONSE_BYTES = 512 * 1024;
const THREAD_ID_CHARS = 256;

type AgentChatStorage = Pick<SyncRelayStorage,
  | "appendAgentChatPost" | "authenticateAgentAuthority" | "fetchChatMessages"
  | "findChannelCreateKind" | "getShare" | "getShareGrant" | "getShareLabels" | "linkPrincipalThreadIds" | "workspaceIsOwnedBy"
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

// People mention an agent that joined with a link by the name its posts
// show. The name is fixed when it signs in, so the mention is too.
export function agentMention(reportedName: string | null): string {
  return `@${handleForName(agentName(reportedName)) || "Agent"}`;
}

function mentions(body: string | null, mention: string): boolean {
  const handle = normalizeHandle(mention.slice(1));
  return body !== null && chatMentionTokens(body).some(token => normalizeHandle(token.handle) === handle);
}

export interface AgentChatWaitBody {
  ok: true;
  group: { channelWireId: string; name: string | null };
  mention: string;
  messages: LinkChatMessage[];
  cursor: number;
}

function take(counts: Map<string, number>, key: string): void {
  counts.set(key, (counts.get(key) ?? 0) + 1);
}

function release(counts: Map<string, number>, key: string): void {
  const count = (counts.get(key) ?? 1) - 1;
  if (count === 0) counts.delete(key); else counts.set(key, count);
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
  const maxResponseBytes = input.maxResponseBytes ?? AGENT_CHAT_WAIT_MAX_RESPONSE_BYTES;
  const waitsByConnection = new Map<string, number>();
  const waitsByLink = new Map<string, number>();
  const waitsByWorkspace = new Map<string, number>();

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

  const credential = (body: Record<string, unknown>): AgentAccessCheck => {
    const check = agentAccessCheck(body.accessToken, body.resource, linkKey!);
    if (!check) throw new Refused();
    return check;
  };

  // The connection is active, the request names its MCP address, its link is
  // current at the generation it signed in with, and the link is on a Group
  // whose channel it may read.
  const current = (check: AgentAccessCheck) => {
    const connection = storage.authenticateAgentAuthority(check, nowMs());
    if (!connection) throw new Refused();
    const authorized = authorizeLinkChatAction({ storage, grantId: connection.grantId, action: "read" });
    if (!authorized.ok || authorized.grant.generation !== connection.generation ||
        authorized.share.shareId !== connection.shareId) throw new Refused();
    return { connection, authorized };
  };

  function post(body: Record<string, unknown>): Response {
    fields(body, ["accessToken", "resource", "body", "idempotencyKey"], ["threadId"]);
    if (typeof body.body !== "string" || typeof body.idempotencyKey !== "string" ||
        (body.threadId !== undefined && typeof body.threadId !== "string")) throw new Refused();
    const result = storage.appendAgentChatPost({
      agent: credential(body),
      now: nowMs,
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

  // Holds until a message for this agent arrives in its link's channel, or
  // the deadline passes. A message is for the agent when it mentions the
  // agent or replies in a thread the agent posted in; a thread filter only
  // narrows that. Other rows, and the agent's own posts, move the cursor
  // without ending the hold. A scan reads one page of the log: one that
  // finds nothing but has more answers at once with the cursor it reached.
  // Access is checked before every scan, so before parking and after each
  // wake, and again before the answer leaves.
  async function wait(body: Record<string, unknown>, signal: AbortSignal): Promise<Response> {
    fields(body, ["accessToken", "resource"], ["cursor", "threadId", "timeoutMs"]);
    const check = credential(body);
    const threadId = body.threadId === undefined ? null : text(body.threadId, THREAD_ID_CHARS);
    const timeoutMs = body.timeoutMs === undefined ? AGENT_CHAT_MAX_WAIT_MS : boundedInteger(body.timeoutMs, AGENT_CHAT_MAX_WAIT_MS);
    const requestedCursor = body.cursor === undefined ? null : boundedInteger(body.cursor, Number.MAX_SAFE_INTEGER);
    const deadline = nowMs() + timeoutMs;
    const first = current(check);
    const { connectionId, principalId, grantId } = first.connection;
    const { workspaceId, shareId } = first.authorized.share;
    const { channelWireId } = first.authorized.effectiveSelector;
    const mention = agentMention(first.connection.reportedName);
    const resolver = input.reads.chatResolverFor(workspaceId);
    if ((waitsByConnection.get(connectionId) ?? 0) >= MAX_AGENT_CHAT_WAITS_PER_CONNECTION ||
        (waitsByLink.get(grantId) ?? 0) >= MAX_AGENT_CHAT_WAITS_PER_LINK ||
        (waitsByWorkspace.get(workspaceId) ?? 0) >= MAX_AGENT_CHAT_WAITS_PER_WORKSPACE) throw relayError("link_read_rate_limited");
    take(waitsByConnection, connectionId);
    take(waitsByLink, grantId);
    take(waitsByWorkspace, workspaceId);
    try {
      // Without a cursor, from where the log stood when the agent signed in.
      // Progress lives only in the cursor each answer returns.
      let position = requestedCursor ?? first.connection.startSeq;
      const scan = () => {
        const { authorized } = current(check);
        if (authorized.effectiveSelector.channelWireId !== channelWireId) throw new Refused();
        const page = storage.fetchChatMessages({ workspaceId, channelWireId, cursor: position, direction: "newer", limit: WAIT_PAGE_ROWS });
        const found: LinkChatMessage[] = [];
        const ownThreads = page.rows.length === 0 ? new Set<string>() : storage.linkPrincipalThreadIds(workspaceId, principalId);
        for (const row of page.rows) {
          if (row.settlementAdmission?.status === "refused") continue;
          const decision = filterOpForShare(authorized.effectiveSelector, row.opKind, row.payloadJson, resolver, "chat");
          if (!decision.allowed || (decision.payload as { linkPrincipalId?: unknown }).linkPrincipalId === principalId) continue;
          const message = messageFromOp({ relaySeq: row.relaySeq, opKind: row.opKind, payload: decision.payload }, row.originId);
          if (!message || !(ownThreads.has(message.threadId) || mentions(message.body, mention))) continue;
          if (threadId === null || message.threadId === threadId) found.push(linkChatMessage(message));
        }
        position = page.nextCursor;
        return { found, more: page.hasMore };
      };
      const caughtUp = (scanned: { found: LinkChatMessage[]; more: boolean }) => scanned.found.length === 0 && !scanned.more;
      let result = scan();
      while (caughtUp(result) && !signal.aborted && nowMs() < deadline) {
        let parkScanFailed = false;
        try {
          await input.activity.wait(linkLogWaitGroup(workspaceId), `agent:${connectionId}`, {
            holdMs: Math.max(1, deadline - nowMs()), signal,
            shouldPark: () => {
              try {result = scan(); return caughtUp(result);}
              catch {parkScanFailed = true; return false;}
            },
          });
        } catch (error) {
          if (error instanceof DiscussionActivityCapacityError) throw relayError("link_read_rate_limited");
          throw error;
        }
        if (parkScanFailed || caughtUp(result)) result = scan();
      }
      if (signal.aborted) throw new Refused();
      current(check);
      const answer: AgentChatWaitBody = {
        ok: true, group: { channelWireId, name: storage.getShareLabels(shareId).subjectName }, mention, messages: [], cursor: position,
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
      release(waitsByConnection, connectionId);
      release(waitsByLink, grantId);
      release(waitsByWorkspace, workspaceId);
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
