import {normalizeShareLabel} from "@dohc/security-contract/share-labels";

// Client for share-web's named recipient chat HTTP. The README section "Named recipient chat HTTP" is the contract.
export const CHAT_PAGE_LIMIT = 50;
export const CHAT_FOLLOW_HOLD_MS = 30_000;
const MAX_BODY_BYTES = 64 * 1024;

export type NamedChatAccess = "read-only" | "read-write";
export interface NamedChatChannel {shareId: string; userId: string; channelWireId: string; name: string | null; access: NamedChatAccess}
/** `body` is null when the relay left it out because it is too large for a browser response. */
export interface NamedChatMessage {
  relaySeq: number; messageId: string; threadId: string; authorUserId: string | null; authorDisplayName: string;
  authorKind: "human" | "agent" | "automation"; authorOwnerDisplayName: string | null; createdAtMs: number; body: string | null;
}

/** A failed chat request. Status 0 means no usable answer arrived, so a post's outcome is unknown. */
export class NamedChatError extends Error {
  constructor(readonly status: number, readonly code: string | null = null) {super(`Named chat request failed (${status})`);}
}

const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const invalid = () => new NamedChatError(0);

async function chatRequest(path: string, signal: AbortSignal, body?: unknown): Promise<Record<string, unknown>> {
  let response: Response;
  try {
    response = await fetch(path, {method: body === undefined ? "GET" : "POST", credentials: "same-origin", cache: "no-store", redirect: "error", signal,
      headers: {accept: "application/json", ...(body === undefined ? {} : {"content-type": "application/json"})},
      ...(body === undefined ? {} : {body: JSON.stringify(body)})});
  } catch {signal.throwIfAborted(); throw invalid();}
  const json = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() === "application/json";
  const value: unknown = json ? await response.json().catch(() => null) : await response.body?.cancel().catch(() => null);
  signal.throwIfAborted();
  if (response.status === 200 && record(value)) return value;
  throw new NamedChatError(response.status === 200 ? 0 : response.status, record(value) && typeof value.code === "string" ? value.code : null);
}

function cursor(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) throw invalid();
  return Number(value);
}

function message(value: unknown): NamedChatMessage {
  if (!record(value) || !["messageId", "threadId", "authorDisplayName"].every(key => typeof value[key] === "string") ||
      (value.authorUserId !== null && typeof value.authorUserId !== "string") ||
      !((value.bodyTooLarge === false && typeof value.body === "string") || (value.bodyTooLarge === true && value.body === null)) ||
      (value.authorKind !== "human" && value.authorKind !== "agent" && value.authorKind !== "automation") ||
      (value.authorOwnerDisplayName !== null && typeof value.authorOwnerDisplayName !== "string") ||
      !Number.isSafeInteger(value.createdAtMs) || !Number.isSafeInteger(value.relaySeq) || Number(value.relaySeq) <= 0) throw invalid();
  return {relaySeq: Number(value.relaySeq), messageId: String(value.messageId), threadId: String(value.threadId),
    authorUserId: value.authorUserId, authorDisplayName: String(value.authorDisplayName), authorKind: value.authorKind,
    authorOwnerDisplayName: value.authorOwnerDisplayName, createdAtMs: Number(value.createdAtMs), body: value.body};
}

function page(value: Record<string, unknown>, channel: NamedChatChannel): NamedChatMessage[] {
  if (value.shareId !== channel.shareId || value.channelWireId !== channel.channelWireId || !Array.isArray(value.messages)) throw invalid();
  return value.messages.map(message);
}

const coordinates = (channel: NamedChatChannel) => ({shareId: channel.shareId, channelWireId: channel.channelWireId});

export async function openNamedChannel(grantId: string, signal: AbortSignal): Promise<NamedChatChannel> {
  const value = await chatRequest(`/api/named-chat/channels?${new URLSearchParams({grantId})}`, signal);
  const channel: unknown = Array.isArray(value.channels) && value.channels.length === 1 ? value.channels[0] : null;
  if (typeof value.shareId !== "string" || typeof value.userId !== "string" || !record(channel) ||
      typeof channel.channelWireId !== "string" || (channel.access !== "read-only" && channel.access !== "read-write")) throw invalid();
  return {shareId: value.shareId, userId: value.userId, channelWireId: channel.channelWireId, name: normalizeShareLabel(channel.name), access: channel.access};
}

/** One history page in reading order, oldest first. `nextCursor` starts following; `olderCursor` reads further back. */
export async function readNamedChatHistory(channel: NamedChatChannel, before: number | null, signal: AbortSignal) {
  const query = new URLSearchParams({...coordinates(channel), limit: String(CHAT_PAGE_LIMIT), ...(before === null ? {} : {before: String(before)})});
  const value = await chatRequest(`/api/named-chat/messages?${query}`, signal);
  return {messages: page(value, channel).reverse(), nextCursor: cursor(value.nextCursor),
    olderCursor: value.olderCursor === null ? null : cursor(value.olderCursor)};
}

export async function followNamedChat(channel: NamedChatChannel, since: number, holdMs: number, signal: AbortSignal) {
  const query = new URLSearchParams({...coordinates(channel), since: String(since), hold: String(holdMs), limit: String(CHAT_PAGE_LIMIT)});
  const value = await chatRequest(`/api/named-chat/messages?${query}`, signal);
  if (typeof value.hasMore !== "boolean") throw invalid();
  return {messages: page(value, channel), nextCursor: cursor(value.nextCursor), hasMore: value.hasMore};
}

/** Posts a new thread in the channel. Retrying with the same `id` and fields returns the original message. */
export async function postNamedChatMessage(channel: NamedChatChannel, post: {id: string; body: string; authorDisplayName: string}, signal: AbortSignal) {
  const value = await chatRequest("/api/named-chat/messages", signal, {...coordinates(channel), ...post, authorKind: "human"});
  if (value.shareId !== channel.shareId || value.channelWireId !== channel.channelWireId) throw invalid();
  return message(value.message);
}

/** The body the relay stores, or null when it would refuse it. */
export function normalizeChatBody(text: string): string | null {
  const body = text.replace(/\r\n?/gu, "\n").trimEnd();
  return body && body.isWellFormed() && new TextEncoder().encode(body).length <= MAX_BODY_BYTES ? body : null;
}

export function chatBodyTooLong(text: string): boolean {
  return new TextEncoder().encode(text.replace(/\r\n?/gu, "\n").trimEnd()).length > MAX_BODY_BYTES;
}

export function mergeChatMessages(current: readonly NamedChatMessage[], incoming: readonly NamedChatMessage[]): NamedChatMessage[] {
  const byId = new Map(current.map(item => [item.messageId, item]));
  for (const item of incoming) byId.set(item.messageId, item);
  return [...byId.values()].sort((left, right) => left.relaySeq - right.relaySeq);
}
