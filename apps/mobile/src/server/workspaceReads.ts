import { LIVE_MARKDOWN_MAX_BYTES } from "@dohc/live-session-contract/limits";
import { fileKindForPath } from "@dohc/workspace-contracts/kinds";
import { each, isFields, okAnswer, segment, text, type Fields } from "./api";
import { REQUEST_TIMEOUT_MS, ServerError, type ServerClient } from "./client";

// The reads a signed-in phone makes of one workspace, through the server's copy of it
// (services/sync-relay/src/accountOperationRoutes.ts), and the workspace's change feed. Every read answers
// `{ ok, result, cursor }`: the cursor says how far the copy had synced, and the feed starts from it. Each answer is
// checked for the fields the phone shows; one that lacks any of them fails as a whole. A result that names a refusal
// the phone knows, `missing` or `too-large`, is a value; any other unsuccessful result is a failed read, which the
// screen offers to try again.

/** A read's value, and the feed's cursor for what the server's copy had synced when it answered. */
export interface Read<T> {
  readonly value: T;
  readonly cursor: string;
}

/** A cursor as the server writes one: the log floor, the log and the live-edit journal. */
const CURSOR = /^(0|[1-9]\d{0,15})\.(0|[1-9]\d{0,15})\.(0|[1-9]\d{0,15})$/;
const isCursor = (value: unknown): value is string => typeof value === "string" && CURSOR.test(value);
const count = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const string = (value: unknown, max = 1_048_576): value is string => typeof value === "string" && value.length <= max;

function operation<T>(client: ServerClient, workspaceId: string, name: string, args: object, read: (result: unknown) => T | null,
  signal: AbortSignal): Promise<Read<T>> {
  return client.send("POST", `/sync/${segment(workspaceId)}/ops/${name}`, body => {
    const answer = okAnswer(body);
    if (!answer || !isCursor(answer.cursor)) return null;
    const value = read(answer.result);
    // The server's copy couldn't do the read, as when its engine failed: the answer is fine, the read isn't.
    if (value === null && isFields(answer.result) && answer.result.ok === false) throw new ServerError("refused", 200);
    return value === null ? null : { value, cursor: answer.cursor };
  }, args, { signal });
}

// --- files --------------------------------------------------------------------------------------------------------

export interface WorkspaceFile {
  readonly path: string;
  readonly objectId: string;
  /** A Markdown page, by the desktop's rule, which the phone opens to read. */
  readonly page: boolean;
}

/** Every file in the workspace, in lexical order, as the desktop lists them. */
export function readFiles(client: ServerClient, workspaceId: string, signal: AbortSignal): Promise<Read<readonly WorkspaceFile[]>> {
  return operation(client, workspaceId, "listFiles", {}, result => {
    const answer = okAnswer(result);
    return each(answer?.files, file => isFields(file) && text(file.path) && text(file.objectId, 256)
      ? { path: file.path, objectId: file.objectId, page: fileKindForPath(file.path).displayKind === "markdown" }
      : null);
  }, signal);
}

// --- chats --------------------------------------------------------------------------------------------------------

export type ChatGroupKind = "group" | "dm" | "agent";
const isGroupKind = (value: unknown): value is ChatGroupKind => value === "group" || value === "dm" || value === "agent";

export interface ChatGroup {
  readonly id: string;
  readonly name: string;
  readonly kind: ChatGroupKind;
  /** The threads in it, so a change to one can find the chat it's in. */
  readonly threadIds: readonly string[];
}

/** The workspace's groups, direct messages and agent chats. A phone's read never creates General. */
export function readChats(client: ServerClient, workspaceId: string, signal: AbortSignal): Promise<Read<readonly ChatGroup[]>> {
  return operation(client, workspaceId, "groupsFull", {}, result => each(okAnswer(result)?.groups, group => {
    if (!isFields(group) || !text(group.id, 256) || !text(group.name, 500) || !isGroupKind(group.kind)) return null;
    const threadIds = each(group.threads, thread => isFields(thread) && text(thread.id, 256) ? thread.id : null);
    return threadIds && { id: group.id, name: group.name, kind: group.kind, threadIds };
  }), signal);
}

export interface ChatMessage {
  readonly id: string;
  readonly threadId: string;
  readonly authorKind: "human" | "agent" | "automation" | "link";
  readonly authorName: string;
  readonly body: string;
  readonly createdAtMs: number;
}

const isAuthorKind = (value: unknown): value is ChatMessage["authorKind"] =>
  value === "human" || value === "agent" || value === "automation" || value === "link";

function readMessage(item: unknown): ChatMessage | null {
  if (!isFields(item) || !text(item.id, 256) || !text(item.threadId, 256) || !isAuthorKind(item.authorKind) ||
    !text(item.authorDisplayName, 256) || !string(item.body) || !count(item.createdAtMs)) return null;
  return { id: item.id, threadId: item.threadId, authorKind: item.authorKind, authorName: item.authorDisplayName, body: item.body, createdAtMs: item.createdAtMs };
}

export interface StreamItem {
  readonly message: ChatMessage;
  /** The replies under a post, which open its thread. */
  readonly replyCount: number;
  readonly lastReplyAtMs: number | null;
}

/** A chat or thread the server no longer has, or this account can't reach, as the server's `missing` refusal says. */
export interface MissingChat {
  readonly kind: "missing";
}

const missingChat = (result: unknown): MissingChat | null =>
  isFields(result) && result.ok === false && result.refusal === "missing" ? { kind: "missing" } : null;

export interface GroupStream {
  readonly kind: "stream";
  readonly name: string;
  readonly groupKind: ChatGroupKind;
  /** Oldest first. */
  readonly items: readonly StreamItem[];
}

/** The most a stream read asks for: the server's own cap. */
export const STREAM_PAGE = 100;

/** A chat's latest posts and messages, oldest first. */
export function readStream(client: ServerClient, workspaceId: string, groupId: string, signal: AbortSignal): Promise<Read<GroupStream | MissingChat>> {
  return operation<GroupStream | MissingChat>(client, workspaceId, "chat", { group: groupId, limit: STREAM_PAGE }, result => {
    const missing = missingChat(result);
    if (missing) return missing;
    const stream = okAnswer(result)?.stream;
    if (!isFields(stream) || !isFields(stream.group) || !text(stream.group.name, 500) || !isGroupKind(stream.group.kind)) return null;
    const items = each(stream.items, item => {
      const message = isFields(item) ? readMessage(item.message) : null;
      if (!isFields(item) || message === null) return null;
      const post: Fields | null = isFields(item.post) ? item.post : null;
      const replyCount = post && count(post.replyCount) ? post.replyCount : 0;
      return { message, replyCount, lastReplyAtMs: post && count(post.lastReplyAtMs) ? post.lastReplyAtMs : null };
    });
    return items && { kind: "stream", name: stream.group.name, groupKind: stream.group.kind, items };
  }, signal);
}

export interface ChatThread {
  readonly kind: "thread";
  readonly id: string;
  readonly title: string;
  /** Oldest first. */
  readonly messages: readonly ChatMessage[];
}

export function readThread(client: ServerClient, workspaceId: string, threadId: string, signal: AbortSignal): Promise<Read<ChatThread | MissingChat>> {
  return operation<ChatThread | MissingChat>(client, workspaceId, "chat", { threadId }, result => {
    const missing = missingChat(result);
    if (missing) return missing;
    const answer = okAnswer(result);
    const thread = answer?.thread;
    if (!isFields(thread) || !text(thread.id, 256) || !string(thread.title, 4096)) return null;
    const messages = each(answer?.messages, readMessage);
    return messages && { kind: "thread", id: thread.id, title: thread.title, messages };
  }, signal);
}

// --- pages --------------------------------------------------------------------------------------------------------

/**
 * A page as the server's copy holds it: its Markdown, or why there is none, by the refusal the server names. `missing`
 * is a page not at its path, and the server answers a secret file's page the same way. Its `last` is the text this
 * workspace's store read before the page went, which it keeps showing. `too-large` is a file over the desktop's
 * editor limit, which the server refuses before reading it.
 */
export type PageRead =
  | { readonly kind: "page"; readonly markdown: string }
  | { readonly kind: "missing"; readonly last?: string }
  | { readonly kind: "too-large" };

export function readPage(client: ServerClient, workspaceId: string, path: string, signal: AbortSignal): Promise<Read<PageRead>> {
  return operation<PageRead>(client, workspaceId, "documentRead", { path }, result => {
    if (!isFields(result)) return null;
    // A page is at most the editor's limit in UTF-8 bytes, so in UTF-16 units too.
    if (result.ok === true) return string(result.markdown, LIVE_MARKDOWN_MAX_BYTES) ? { kind: "page", markdown: result.markdown } : null;
    if (result.refusal === "too-large") return { kind: "too-large" };
    return result.refusal === "missing" ? { kind: "missing" } : null;
  }, signal);
}

// --- the change feed ----------------------------------------------------------------------------------------------

/** What changed by kind, with the objects or threads the server knows changed. An empty list means some, unnamed. */
export interface FeedChanges {
  readonly files?: readonly string[];
  readonly pages?: readonly string[];
  readonly chats?: readonly string[];
}

/** `replace` when the server can't continue from the cursor: everything read before must be read again. */
export type FeedAnswer =
  | { readonly cursor: string; readonly replace: true }
  | { readonly cursor: string; readonly replace: false; readonly changed: FeedChanges };

/** The longest the server holds a feed request open: its own cap is 30 s. */
export const FEED_HOLD_MS = 25_000;

const ids = (value: unknown): readonly string[] | null | undefined =>
  value === undefined ? undefined : each(value, id => text(id, 256) ? id : null);

/** Waits up to `holdMs` for a change after `since`, and answers what changed and the next cursor. */
export function readChanges(client: ServerClient, workspaceId: string, since: string, options: {
  readonly holdMs: number;
  readonly signal: AbortSignal;
}): Promise<FeedAnswer> {
  const query = `since=${encodeURIComponent(since)}&hold=${options.holdMs}`;
  return client.send("GET", `/sync/${segment(workspaceId)}/ops/changes?${query}`, body => {
    const answer = okAnswer(body);
    if (!answer || !isCursor(answer.cursor)) return null;
    if (answer.replace === true) return { cursor: answer.cursor, replace: true };
    const changed = answer.changed;
    if (!isFields(changed)) return null;
    const files = ids(changed.files), pages = ids(changed.pages), chats = ids(changed.chats);
    if (files === null || pages === null || chats === null) return null;
    return { cursor: answer.cursor, replace: false, changed: { ...(files ? { files } : {}), ...(pages ? { pages } : {}), ...(chats ? { chats } : {}) } };
  }, undefined, { signal: options.signal, timeoutMs: options.holdMs + REQUEST_TIMEOUT_MS });
}

// --- cursors ------------------------------------------------------------------------------------------------------

const parts = (cursor: string) => cursor.split(".").map(Number) as [number, number, number];

/**
 * The cursor that misses neither's changes. Two cursors past one restore take each position's lower value; across a
 * restore, the one from before it, which the server answers with `replace`.
 */
export function earlierCursor(a: string, b: string): string {
  return pick(a, b, Math.min);
}

/** The cursor past both. */
export function laterCursor(a: string, b: string): string {
  return pick(a, b, Math.max);
}

function pick(a: string, b: string, choose: (x: number, y: number) => number): string {
  const [floorA, logA, journalA] = parts(a);
  const [floorB, logB, journalB] = parts(b);
  if (floorA !== floorB) return choose(floorA, floorB) === floorA ? a : b;
  return `${floorA}.${choose(logA, logB)}.${choose(journalA, journalB)}`;
}
