import { phoneChatContextArgsSchema } from "@dohc/cli/protocol";
import { handleForName, normalizeHandle } from "@dohc/workspace-contracts/chat-mentions";
import {
  PHONE_MENTION_CANDIDATES_MAX,
  type PhoneChatContext,
  type PhoneMentionCandidate,
  type PhoneWakeChanges,
} from "@dohc/workspace-contracts/chat-wakes";
import type { ChatMessage, ChatReaction } from "@dohc/workspace-contracts/engine";
import { cliGroupKind, failure, type ChatsHost } from "@dohc/workspace-operations/chats";
import { currentAccountFeedCursor, threadShownByLog } from "./accountFeed";
import { serverChats, type MissingResult } from "./accountOperations";
import type { ChatWakeWaits } from "./chatWakeRoutes";
import { badRequest, RelayError } from "./errors";
import type { CopyVisitor, ServerCopies } from "./serverCopies";
import type { SyncRelayStorage } from "./storage";

// What the phone needs beside a conversation it shows, read through the
// owner's server copy: which lanes take a message, who it can mention, and the
// latest wake of each target of its shown messages. The conversation is read
// through the same secret-file filter as the phone's own reads, so a hidden
// thread answers exactly as a missing one. A suggestion authorizes nothing: a
// write resolves its wake targets again when it is recorded.

/** The stream items a context covers: the phone's own stream read asks for this many. */
const STREAM_ITEMS = 100;
/** The people one context names at most, newest in the conversation first. */
const PEOPLE_MAX = 100;
const SEQUENCE = /^(?:0|[1-9]\d{0,15})$/u;

export type ChatContextTarget = ReturnType<(typeof phoneChatContextArgsSchema)["parse"]>;

/** The conversation a context read names. Arguments outside its schema reject with a bad request. */
export function parseChatContext(args: unknown): ChatContextTarget {
  const parsed = phoneChatContextArgsSchema.safeParse(args);
  if (!parsed.success) throw badRequest("the arguments do not fit chatContext");
  return parsed.data;
}

/** A context, a conversation the account can't see or that isn't there, or a failed read without the engine's words. */
type ChatContextAnswer = PhoneChatContext | MissingResult | { ok: false; reason: string };

type Conversation = {
  conversation: PhoneChatContext["conversation"];
  messages: ChatMessage[];
  reactions: ChatReaction[];
};

// The conversation as the phone's reads show it. A group is named by its exact engine ID; a thread the filtered store
// doesn't list, which takes in one on a secret file, is missing.
async function readConversation(
  host: ChatsHost,
  target: ChatContextTarget,
): Promise<Conversation | MissingResult> {
  const { store, workspaceId } = host;
  const channels = await store.listChannels({ workspaceId });
  if ("group" in target) {
    const channel = channels.find((each) => each.id === target.group);
    if (channel === undefined)
      return { ok: false, reason: `no such group: ${target.group}`, refusal: "missing" };
    const page = await store.listGroupStream({
      workspaceId,
      channelId: channel.id,
      limit: STREAM_ITEMS,
    });
    return {
      // The lanes the write route admits (accountChatWrites.ts, visibleTargets).
      conversation: {
        kind: "stream",
        groupId: channel.id,
        groupKind: cliGroupKind(channel.kind),
        canPost: channel.kind === "channel" && channel.type !== "chat",
        canSend: channel.kind !== "channel" || channel.type !== "posts",
      },
      messages: page.items.map((item) => item.message),
      reactions: page.items.flatMap((item) => item.reactions),
    };
  }
  const thread = (await store.listThreads({ workspaceId })).find(
    (each) => each.id === target.threadId,
  );
  if (thread === undefined)
    return { ok: false, reason: `chat thread not found: ${target.threadId}`, refusal: "missing" };
  const [messages, reactions] = await Promise.all([
    store.listMessages({ workspaceId, threadId: thread.id }),
    store.listReactions({ workspaceId, threadId: thread.id }),
  ]);
  const channel =
    thread.channelId === undefined
      ? undefined
      : channels.find((each) => each.id === thread.channelId);
  return {
    conversation: {
      kind: "thread",
      threadId: thread.id,
      groupKind: channel === undefined ? null : cliGroupKind(channel.kind),
    },
    messages,
    reactions,
  };
}

// Agents on the account's computers, one per handle, since a mention of it wakes every computer that runs it; then the
// account's active personal agents whose reach takes in the workspace, which no computer wakes; then people who wrote
// or reacted in the conversation, newest first. A name without a handle can't be mentioned.
function mentionCandidates(
  storage: SyncRelayStorage,
  input: { accountId: string; workspaceId: string; nowMs: number },
  shown: Conversation,
): PhoneMentionCandidate[] {
  const agents = new Map<string, Extract<PhoneMentionCandidate, { kind: "agent" }>>();
  for (const runner of storage.enabledChatRunners(input)) {
    const handle = handleForName(runner.displayName);
    if (handle === "") continue;
    const key = normalizeHandle(handle);
    const agent = agents.get(key);
    if (agent === undefined)
      agents.set(key, {
        kind: "agent",
        handle,
        label: runner.displayName,
        computers: [runner.computerLabel],
      });
    else if (!agent.computers.includes(runner.computerLabel))
      agent.computers.push(runner.computerLabel);
  }
  const personal = new Map<string, PhoneMentionCandidate>();
  for (const agent of storage.listPersonalAgents(input.accountId).agents) {
    const handle = handleForName(agent.name);
    if (
      agent.status !== "active" ||
      handle === "" ||
      !agent.reach.some((reach) => reach.workspaceId === input.workspaceId)
    )
      continue;
    const key = normalizeHandle(handle);
    if (!personal.has(key)) personal.set(key, { kind: "personalAgent", handle, label: agent.name });
  }
  const people = new Map<string, PhoneMentionCandidate>();
  const authors = [
    ...shown.messages.map((message) => ({ ...message.author, atMs: message.createdAtMs })),
    ...shown.reactions.map((reaction) => ({ ...reaction.author, atMs: reaction.atMs })),
  ].sort((a, b) => b.atMs - a.atMs);
  for (const author of authors) {
    if (author.kind !== "human" || people.size === PEOPLE_MAX) continue;
    const handle = handleForName(author.displayName);
    const key = JSON.stringify([normalizeHandle(handle), author.displayName]);
    if (handle !== "" && !people.has(key))
      people.set(key, { kind: "person", handle, label: author.displayName });
  }
  return [...agents.values(), ...personal.values(), ...people.values()].slice(
    0,
    PHONE_MENTION_CANDIDATES_MAX,
  );
}

/**
 * The context of a stream or thread the phone shows, in a visit to the
 * account's copy of `workspaceId`, after the copy syncs. The caller
 * authenticates the account, checks that it owns the workspace and that the
 * workspace shows on the phone, and parses the target. `authorize` runs once
 * the copy is open, once it has synced, and once the conversation is read;
 * nothing is awaited from that last check to the answer, whose wakes and
 * mention candidates are read from storage in the same turn.
 */
export async function runAccountChatContext(
  server: { storage: SyncRelayStorage; copies: ServerCopies },
  input: {
    workspaceId: string;
    accountId: string;
    target: ChatContextTarget;
    visitor: Extract<CopyVisitor, { reason: "account" }>;
    authorize(): Promise<void>;
    nowMs(): number;
  },
): Promise<{ result: ChatContextAnswer; cursor: string }> {
  const { storage } = server;
  const { workspaceId, accountId } = input;
  const { signal } = input.visitor;
  return await server.copies.withServerCopy(accountId, workspaceId, input.visitor, async (copy) => {
    await input.authorize();
    const cursor = currentAccountFeedCursor(storage, workspaceId);
    await copy.sync(signal);
    await input.authorize();
    let read: Conversation | MissingResult;
    try {
      read = await readConversation(serverChats(storage, copy, workspaceId), input.target);
    } catch (error) {
      if (error instanceof RelayError || signal.aborted) throw error;
      await input.authorize();
      return { result: failure(error, "failed to read chat context", "operation-only"), cursor };
    }
    await input.authorize();
    if (!("conversation" in read)) return { result: read, cursor };
    const nowMs = input.nowMs();
    // The cursor first: a change after it, even in this same turn, moves the head past it.
    const wakeCursor = String(storage.chatWakeHead(accountId));
    const shown = new Map(read.messages.map((message) => [message.id, message.threadId]));
    const unmatched = storage.unmatchedWakeMessages({
      accountId,
      workspaceId,
      messageIds: [...shown.keys()],
    });
    return {
      result: {
        ok: true,
        conversation: read.conversation,
        mentions: mentionCandidates(storage, { accountId, workspaceId, nowMs }, read),
        wakes: storage.phoneChatWakes({ accountId, workspaceId, messages: shown, nowMs }),
        unmatched: [...shown]
          .filter(([messageId]) => unmatched.has(messageId))
          .map(([messageId, threadId]) => ({ messageId, threadId })),
        wakeCursor,
      },
      cursor,
    };
  });
}

function parseSince(value: string | null): number {
  const since = Number(value);
  if (value === null || !SEQUENCE.test(value) || !Number.isSafeInteger(since))
    throw badRequest("since must be a cursor this server answered");
  return since;
}

/** The wire answer less its `ok`, which the route adds. */
type WakeChangesAnswer =
  | Omit<Extract<PhoneWakeChanges, { replace: true }>, "ok">
  | Omit<Extract<PhoneWakeChanges, { threads: string[] }>, "ok">;

type WakeChangesStorage = Pick<
  SyncRelayStorage,
  "chatWakeHead" | "chatWakeChanges" | "accountFeedThreadPaths"
>;

/**
 * Answers the threads of the workspace whose wakes changed after `since`,
 * waiting up to `holdMs` for a change when none has. Its cursor is the
 * account's wake head, apart from the workspace feed's. A change in a thread
 * the log puts on a hidden file never answers, and neither does one in
 * another workspace; each only moves the cursor while the read keeps
 * waiting. A gap longer than one page answers each page, changed or not. A
 * `since` past the head answers `replace`. `authorize` runs after every
 * wait; the caller runs it once more before it answers. The phone reads the
 * context of a thread named here again, which checks everything afresh.
 */
export async function readWakeChanges(
  storage: WakeChangesStorage,
  waits: Pick<ChatWakeWaits, "wait">,
  input: {
    workspaceId: string;
    accountId: string;
    sessionId: string;
    since: string | null;
    holdMs: number;
    signal: AbortSignal;
    authorize(): Promise<void>;
  },
): Promise<WakeChangesAnswer> {
  const { workspaceId, accountId } = input;
  let since = parseSince(input.since);
  const deadlineAtMs = Date.now() + input.holdMs;
  for (;;) {
    const head = storage.chatWakeHead(accountId);
    if (since > head) return { cursor: String(head), replace: true };
    if (since < head) {
      const page = storage.chatWakeChanges({ accountId, workspaceId, since, through: head });
      since = page.next;
      const threads = page.threadIds.filter((threadId) =>
        threadShownByLog(storage, workspaceId, threadId),
      );
      if (threads.length > 0 || since < head) return { cursor: String(since), threads };
    }
    const holdMs = deadlineAtMs - Date.now();
    if (holdMs <= 0 || input.signal.aborted) return { cursor: String(since), threads: [] };
    const caughtUp = since;
    await waits.wait({
      accountId,
      holder: { sessionId: input.sessionId },
      caller: input.sessionId,
      holdMs,
      signal: input.signal,
      shouldPark: () => storage.chatWakeHead(accountId) === caughtUp,
    });
    await input.authorize();
  }
}
