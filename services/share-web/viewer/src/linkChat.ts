import {normalizeShareLabel} from "@dohc/security-contract/share-labels";
import {fetchShareWeb} from "./apiVersion";
import {CHAT_EMPTY_PAGE_LIMIT, CHAT_PAGE_LIMIT, chatMessage, NamedChatError, type NamedChatAccess, type NamedChatMessage} from "./namedChat";

// Client for a share link's Group channel, through share-web's /api/view/chat routes.
// The relay names the link as the author of every post; the request names only the post.
export const LINK_CHAT_BODY_BYTES = 8_000;

/** `profileName` is the name this browser already set on the link, or null. */
export interface LinkChannel {shareId: string; channelWireId: string; name: string | null; access: NamedChatAccess; profileName: string | null}

const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const invalid = () => new NamedChatError(0);

async function linkChatRequest(session: string, path: string, signal: AbortSignal, body?: unknown): Promise<Record<string, unknown>> {
  let response: Response;
  try {
    response = await fetchShareWeb(path, {method: body === undefined ? "GET" : "POST", credentials: "same-origin", cache: "no-store", redirect: "error", signal,
      headers: {accept: "application/json", "x-dohc-link-session": session, ...(body === undefined ? {} : {"content-type": "application/json"})},
      ...(body === undefined ? {} : {body: JSON.stringify(body)})});
  } catch {signal.throwIfAborted(); throw invalid();}
  const json = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() === "application/json";
  const value: unknown = json ? await response.json().catch(() => null) : await response.body?.cancel().catch(() => null);
  signal.throwIfAborted();
  if (response.status === 200 && record(value)) return value;
  const refusal = record(value) && typeof value.code === "string" ? value : null;
  throw new NamedChatError(response.status === 200 ? 0 : response.status, refusal ? String(refusal.code) : null,
    refusal && typeof refusal.error === "string" ? refusal.error : null);
}

// A link holder never sees an account ID.
const linkMessage = (value: unknown): NamedChatMessage => chatMessage(record(value) ? {authorUserId: null, ...value} : value);

function page(value: Record<string, unknown>, channel: LinkChannel): NamedChatMessage[] {
  if (value.shareId !== channel.shareId || value.channelWireId !== channel.channelWireId || !Array.isArray(value.messages)) throw invalid();
  return value.messages.map(linkMessage);
}

function cursor(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) throw invalid();
  return Number(value);
}

/** The Group channel the share's answer named for this link; any failure throws. */
export async function openLinkChannel(session: string, channelWireId: string, signal: AbortSignal): Promise<LinkChannel> {
  const value = await linkChatRequest(session, "/api/view/chat/channels", signal);
  const channel: unknown = Array.isArray(value.channels) && value.channels.length === 1 ? value.channels[0] : null;
  if (typeof value.shareId !== "string" || !record(channel) || channel.channelWireId !== channelWireId ||
      (channel.access !== "read-only" && channel.access !== "read-write") ||
      (value.profileName !== null && typeof value.profileName !== "string")) throw invalid();
  return {shareId: value.shareId, channelWireId, name: normalizeShareLabel(channel.name), access: channel.access,
    profileName: value.profileName};
}

export function linkChatBody(text: string): string | null {
  const body = text.replace(/\r\n?/gu, "\n").trimEnd();
  return body && body.isWellFormed() && new TextEncoder().encode(body).length <= LINK_CHAT_BODY_BYTES ? body : null;
}

export function linkChatClient(session: string, channel: LinkChannel, claimedName: () => string | null) {
  const messages = (query: Record<string, string>, signal: AbortSignal) =>
    linkChatRequest(session, `/api/view/chat/messages?${new URLSearchParams({channelWireId: channel.channelWireId, limit: String(CHAT_PAGE_LIMIT), ...query})}`, signal);
  const historyPage = async (before: number | null, signal: AbortSignal) => {
    const value = await messages(before === null ? {} : {before: String(before)}, signal);
    return {messages: page(value, channel).reverse(), nextCursor: cursor(value.nextCursor), olderCursor: value.olderCursor === null ? null : cursor(value.olderCursor)};
  };
  return {
    access: channel.access,
    // Oldest first, skipping a bounded run of pages that hold none of the channel's messages.
    async readHistory(before: number | null, signal: AbortSignal) {
      const first = await historyPage(before, signal);
      let {messages: found, olderCursor} = first;
      for (let read = 1; !found.length && olderCursor !== null && read < CHAT_EMPTY_PAGE_LIMIT; read += 1)
        ({messages: found, olderCursor} = await historyPage(olderCursor, signal));
      return {messages: found, nextCursor: first.nextCursor, olderCursor};
    },
    async follow(since: number, holdMs: number, signal: AbortSignal) {
      const value = await messages({since: String(since), hold: String(holdMs)}, signal);
      if (typeof value.hasMore !== "boolean") throw invalid();
      return {messages: page(value, channel), nextCursor: cursor(value.nextCursor), hasMore: value.hasMore};
    },
    async post(post: {id: string; body: string}, signal: AbortSignal) {
      const name = claimedName();
      const value = await linkChatRequest(session, "/api/view/chat/messages", signal,
        {channelWireId: channel.channelWireId, body: post.body, idempotencyKey: post.id, ...(name === null ? {} : {claimedName: name})});
      if (value.shareId !== channel.shareId || value.channelWireId !== channel.channelWireId) throw invalid();
      return linkMessage(value.message);
    },
    normalize: linkChatBody,
    tooLong: (text: string) => new TextEncoder().encode(text.replace(/\r\n?/gu, "\n").trimEnd()).length > LINK_CHAT_BODY_BYTES,
  };
}
