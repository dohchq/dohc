import type {
  ChatWakeView,
  PhoneChatWake,
  PhoneMentionCandidate,
} from "@dohc/workspace-contracts/chat-wakes";
import { each, isFields, okAnswer, segment, text } from "./api";
import { isRefusalReason } from "./chatWrites";
import { REQUEST_TIMEOUT_MS, ServerError, type ServerClient } from "./client";
import { isCursor, type MissingChat } from "./workspaceReads";

// Who a chat or thread can mention, and the wakes of the messages it shows, from the server's context for the phone,
// the account's wake changes, and Try again on a wake. Every answer is checked by hand against the relay's contract (packages/workspace-contracts/src/chatWakes.ts)
// before the phone keeps them, as the phone's other reads are: the contract's schemas would bring zod into the app.
// chatWakes.test.ts holds these checks to the contract's. The wake cursor is decimal text, apart from the workspace
// feed's dotted cursor.

const WAKE_ID = /^wake-[0-9a-f]{32}$/u;
const WAKE_CURSOR = /^(?:0|[1-9]\d{0,15})$/u;
const CONTROL = /[\u0000-\u001f\u007f]/u;
const WAKE_STATES: ReadonlySet<string> = new Set([
  "held",
  "waiting",
  "claimed",
  "queued",
  "unclaimed",
  "unconfirmed",
]);
const line = (value: unknown, maxChars: number): value is string =>
  typeof value === "string" &&
  value.length > 0 &&
  value.length <= maxChars &&
  value === value.trim() &&
  !CONTROL.test(value);
const id = (value: unknown): value is string => line(value, 1_024);
const order = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 1;
const isWakeCursor = (value: unknown): value is string =>
  typeof value === "string" && WAKE_CURSOR.test(value);

/** One wake as the contract's `PhoneChatWake` has it, or null. */
export function phoneChatWake(item: unknown): PhoneChatWake | null {
  if (!isFields(item)) return null;
  const { wakeId, messageId, threadId, generation, state, winnerLabel, agentName, canRetry } = item;
  if (
    Object.keys(item).length !== 8 ||
    typeof wakeId !== "string" ||
    !WAKE_ID.test(wakeId) ||
    !id(messageId) ||
    !id(threadId) ||
    !order(generation) ||
    typeof state !== "string" ||
    !WAKE_STATES.has(state) ||
    (winnerLabel !== null && !line(winnerLabel, 64)) ||
    (agentName !== null &&
      (typeof agentName !== "string" || agentName.length < 1 || agentName.length > 256)) ||
    typeof canRetry !== "boolean"
  )
    return null;
  return {
    wakeId,
    messageId,
    threadId,
    generation,
    state: state as PhoneChatWake["state"],
    winnerLabel,
    agentName,
    canRetry,
  };
}

/** Not empty, and at most `max` UTF-16 code units, as the contract's `Handle` and `Name` are. */
const sized = (value: unknown, max: number): value is string =>
  typeof value === "string" && value.length >= 1 && value.length <= max;

/** One mention candidate as the contract's `PhoneMentionCandidate` has it, or null. */
export function phoneMentionCandidate(item: unknown): PhoneMentionCandidate | null {
  if (!isFields(item)) return null;
  const { kind, handle, label } = item;
  if (!sized(handle, 200) || !sized(label, 256)) return null;
  if (kind === "person" || kind === "personalAgent")
    return Object.keys(item).length === 3 ? { kind, handle, label } : null;
  if (kind !== "agent" || Object.keys(item).length !== 4 || !Array.isArray(item.computers))
    return null;
  const computers = each(item.computers, (computer) => (line(computer, 64) ? computer : null));
  return computers && computers.length > 0 ? { kind, handle, label, computers } : null;
}

type Conversation =
  | { readonly kind: "stream"; readonly groupId: string }
  | { readonly kind: "thread"; readonly threadId: string; readonly nextBefore: number | null };

/** The parts of a `PhoneChatContext` the phone keeps, or null when the answer isn't one. */
export function phoneChatContext(result: unknown): {
  readonly conversation: Conversation;
  readonly mentions: readonly PhoneMentionCandidate[];
  readonly wakes: readonly PhoneChatWake[];
  readonly wakeCursor: string;
} | null {
  if (!isFields(result) || result.ok !== true || !isWakeCursor(result.wakeCursor)) return null;
  const { conversation } = result;
  if (!isFields(conversation)) return null;
  const mentions =
    Array.isArray(result.mentions) && result.mentions.length <= 256
      ? each(result.mentions, phoneMentionCandidate)
      : null;
  const wakes =
    Array.isArray(result.wakes) && result.wakes.length <= 6_400
      ? each(result.wakes, phoneChatWake)
      : null;
  if (!mentions || !wakes) return null;
  if (conversation.kind === "stream" && id(conversation.groupId))
    return {
      conversation: { kind: "stream", groupId: conversation.groupId },
      mentions,
      wakes,
      wakeCursor: result.wakeCursor,
    };
  if (
    conversation.kind === "thread" &&
    id(conversation.threadId) &&
    (conversation.nextBefore === null || order(conversation.nextBefore))
  )
    return {
      conversation: {
        kind: "thread",
        threadId: conversation.threadId,
        nextBefore: conversation.nextBefore,
      },
      mentions,
      wakes,
      wakeCursor: result.wakeCursor,
    };
  return null;
}

/** A `PhoneWakeChanges` answer, or null. */
export function phoneWakeChanges(
  body: unknown,
):
  | { readonly cursor: string; readonly replace: true }
  | { readonly cursor: string; readonly threads: readonly string[] }
  | null {
  if (!isFields(body) || body.ok !== true || !isWakeCursor(body.cursor)) return null;
  if (body.replace === true)
    return Object.keys(body).length === 3 ? { cursor: body.cursor, replace: true } : null;
  if (!Array.isArray(body.threads) || body.threads.length > 1_000 || Object.keys(body).length !== 3)
    return null;
  const threads = each(body.threads, (thread) => (id(thread) ? thread : null));
  return threads ? { cursor: body.cursor, threads } : null;
}

/** A conversation whose wakes the phone reads: a chat's stream, or a thread. */
export type WakeTarget =
  | { readonly kind: "stream"; readonly groupId: string }
  | { readonly kind: "thread"; readonly threadId: string };

/**
 * One page of a conversation's context: who it can mention, its wakes, the wake cursor it was read at, and a thread's
 * older boundary.
 */
export interface ChatContextPage {
  readonly kind: "context";
  readonly mentions: readonly PhoneMentionCandidate[];
  readonly wakes: readonly PhoneChatWake[];
  readonly wakeCursor: string;
  /** The message order before which a thread's older page starts, or null once its first message is covered. */
  readonly nextBefore: number | null;
}

/** The longest the server holds a wake-changes request open: the contract's `CHAT_WAKE_WAIT_MAX_MS`. */
export const WAKE_HOLD_MS = 25_000;

/** One context page: a stream's newest items, or a thread's newest messages before `before`. */
export function readChatContext(
  client: ServerClient,
  workspaceId: string,
  target: WakeTarget,
  signal: AbortSignal,
  before?: number,
): Promise<ChatContextPage | MissingChat> {
  const args =
    target.kind === "stream"
      ? { group: target.groupId }
      : { threadId: target.threadId, ...(before === undefined ? {} : { before }) };
  return client.send(
    "POST",
    `/sync/${segment(workspaceId)}/ops/chatContext`,
    (body): ChatContextPage | MissingChat | null => {
      const answer = okAnswer(body);
      if (!answer || !isCursor(answer.cursor)) return null;
      const { result } = answer;
      if (isFields(result) && result.ok === false) {
        if (result.refusal === "missing") return { kind: "missing" };
        // The server's copy couldn't do the read: the answer is fine, the read isn't.
        throw new ServerError("refused", 200);
      }
      const parsed = phoneChatContext(result);
      if (!parsed) return null;
      const { conversation, mentions, wakes, wakeCursor } = parsed;
      if (target.kind === "stream")
        return conversation.kind === "stream" && conversation.groupId === target.groupId
          ? { kind: "context", mentions, wakes, wakeCursor, nextBefore: null }
          : null;
      if (conversation.kind !== "thread" || conversation.threadId !== target.threadId) return null;
      if (wakes.some((wake) => wake.threadId !== target.threadId)) return null;
      // An older page starts before the page it follows, so paging always ends.
      const { nextBefore } = conversation;
      if (nextBefore !== null && before !== undefined && nextBefore >= before) return null;
      return { kind: "context", mentions, wakes, wakeCursor, nextBefore };
    },
    args,
    { signal },
  );
}

/** A conversation's context across its pages. */
export interface ConversationContext {
  /** Each page's candidates, newest page first, without repeats, and at most 256, as one page's are. */
  readonly mentions: readonly PhoneMentionCandidate[];
  readonly wakes: readonly PhoneChatWake[];
  readonly wakeCursor: string;
}

/**
 * Every wake of a conversation the phone shows, and who it can mention. A stream's context covers the items its read
 * shows. The phone's thread read has no message order, so a thread's pages are followed to its first message. The
 * cursor is the earliest page's, so a change during the paging is still answered by `readWakeChanges`.
 */
export async function readConversationWakes(
  client: ServerClient,
  workspaceId: string,
  target: WakeTarget,
  signal: AbortSignal,
): Promise<ConversationContext | MissingChat> {
  const mentions = new Map<string, PhoneMentionCandidate>();
  const wakes: PhoneChatWake[] = [];
  let wakeCursor: string | null = null;
  let before: number | undefined;
  for (;;) {
    const page = await readChatContext(client, workspaceId, target, signal, before);
    if (page.kind === "missing") return page;
    for (const row of page.mentions)
      if (mentions.size < 256) mentions.set(JSON.stringify(row), row);
    wakes.push(...page.wakes);
    wakeCursor =
      wakeCursor === null ? page.wakeCursor : earlierWakeCursor(wakeCursor, page.wakeCursor);
    if (page.nextBefore === null) return { mentions: [...mentions.values()], wakes, wakeCursor };
    before = page.nextBefore;
  }
}

/** `replace` when every context must be read again. Otherwise the threads whose wakes changed, which may be none. */
export type WakeChanges =
  | { readonly cursor: string; readonly replace: true }
  | { readonly cursor: string; readonly replace: false; readonly threads: readonly string[] };

/** Waits up to `holdMs` for a wake change after `since` in the workspace, and answers what changed and the next cursor. */
export function readWakeChanges(
  client: ServerClient,
  workspaceId: string,
  since: string,
  options: { readonly holdMs: number; readonly signal: AbortSignal },
): Promise<WakeChanges> {
  const query = `since=${encodeURIComponent(since)}&hold=${options.holdMs}`;
  return client.send(
    "GET",
    `/sync/${segment(workspaceId)}/ops/wakeChanges?${query}`,
    (body): WakeChanges | null => {
      const answer = phoneWakeChanges(body);
      if (!answer) return null;
      return "replace" in answer
        ? { cursor: answer.cursor, replace: true }
        : { cursor: answer.cursor, replace: false, threads: answer.threads };
    },
    undefined,
    { signal: options.signal, timeoutMs: options.holdMs + REQUEST_TIMEOUT_MS },
  );
}

/** A wake as the account's computers see it, the contract's `ChatWakeView`, or null. */
export function chatWakeView(item: unknown): ChatWakeView | null {
  if (!isFields(item)) return null;
  const {
    wakeId,
    workspaceId,
    messageId,
    threadId,
    generation,
    state,
    prerequisiteMessageId,
    winnerLabel,
  } = item;
  if (
    Object.keys(item).length !== 8 ||
    typeof wakeId !== "string" ||
    !WAKE_ID.test(wakeId) ||
    !id(workspaceId) ||
    !id(messageId) ||
    !id(threadId) ||
    !order(generation) ||
    typeof state !== "string" ||
    !WAKE_STATES.has(state) ||
    (prerequisiteMessageId !== null && !id(prerequisiteMessageId)) ||
    (winnerLabel !== null && !line(winnerLabel, 64))
  )
    return null;
  return {
    wakeId,
    workspaceId,
    messageId,
    threadId,
    generation,
    state: state as ChatWakeView["state"],
    prerequisiteMessageId,
    winnerLabel,
  };
}

/**
 * A Try again's answer. `retried` names the generation the server answered, which proves nothing ran; the phone shows
 * nothing of it and reads the conversation's context again. `refused` doesn't mean the wake didn't start. `missing`:
 * the server has no wake the account may see by that ID.
 */
export type RetryWakeAnswer =
  | { readonly kind: "retried"; readonly wake: ChatWakeView }
  | { readonly kind: "refused" }
  | { readonly kind: "missing" };

/** The `result` of a Try again's answer (services/sync-relay/src/accountChatWrites.ts `runAccountRetryWake`), or null. */
export function retryWakeResult(result: unknown): RetryWakeAnswer | null {
  if (!isFields(result)) return null;
  if (result.ok === true) {
    const wake = chatWakeView(result.wake);
    return wake && { kind: "retried", wake };
  }
  if (result.ok === false && result.refusal === "refused" && isRefusalReason(result.reason))
    return { kind: "refused" };
  if (result.ok === false && result.refusal === "missing" && text(result.reason))
    return { kind: "missing" };
  return null;
}

/** As long as a chat write waits: the relay syncs its copy, twice at most, before it answers. */
const RETRY_TIMEOUT_MS = 30_000;

/**
 * Tries a wake again, `POST /sync/<workspace>/ops/retryWake`. The same operation ID sent again answers the generation
 * the first answered. The cursor is checked, never used: a retry moves neither the feed nor the wake cursor.
 */
export function retryWake(
  client: ServerClient,
  workspaceId: string,
  operationId: string,
  wakeId: string,
  signal: AbortSignal,
): Promise<RetryWakeAnswer> {
  return client.send(
    "POST",
    `/sync/${segment(workspaceId)}/ops/retryWake`,
    (body): RetryWakeAnswer | null => {
      const answer = okAnswer(body);
      if (!answer || !isCursor(answer.cursor)) return null;
      const result = retryWakeResult(answer.result);
      if (result?.kind === "retried" && result.wake.workspaceId !== workspaceId) return null;
      return result;
    },
    { operationId, wakeId },
    { signal, timeoutMs: RETRY_TIMEOUT_MS },
  );
}

/** The lower of two wake cursors. Each is decimal text without leading zeros, so a shorter one is lower. */
export function earlierWakeCursor(a: string, b: string): string {
  if (a.length !== b.length) return a.length < b.length ? a : b;
  return a <= b ? a : b;
}
