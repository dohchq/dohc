import { phoneChatContextArgsSchema } from "@dohc/cli/protocol";
import { handleForName, normalizeHandle } from "@dohc/workspace-contracts/chat-mentions";
import {
  PHONE_CONTEXT_MESSAGES_MAX,
  PHONE_MENTION_CANDIDATES_MAX,
  type PhoneChatContext,
  type PhoneMentionCandidate,
  type PhoneWakeChanges,
} from "@dohc/workspace-contracts/chat-wakes";
import type { ChatMessage, ChatReaction } from "@dohc/workspace-contracts/engine";
import { ChatsLiveAdapter } from "@dohc/workspace-engine-client";
import { cliGroupKind, failure, type ChatsHost } from "@dohc/workspace-operations/chats";
import { currentAccountFeedCursor, hiddenFile } from "./accountFeed";
import { serverChats, type MissingResult } from "./accountOperations";
import type { ChatWakeWaits } from "./chatWakeRoutes";
import { badRequest, RelayError } from "./errors";
import type { CopyVisitor, ServerCopies } from "./serverCopies";
import type { SyncRelayStorage } from "./storage";

// What the phone needs beside a conversation it shows, read through the
// owner's server copy: which lanes take a message, who it can mention, and the
// latest wake of each target of the messages it covers. Whether a message's
// answered agent matched no computer isn't read here; that waits for an
// indexed lookup. The conversation is
// read through the same secret-file filter as the phone's own reads, so a
// hidden thread answers exactly as a missing one. A suggestion authorizes
// nothing: a write resolves its wake targets again when it is recorded.

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

type ThreadPages = Pick<ChatsLiveAdapter, "getThread" | "listMessagesPage">;

// The most engine reads one context's messages take. The engine ends a page at its byte budget as well as at the
// limit, and says where to go on. A page it ends early still holds a message, since it refuses a message past the
// budget rather than answer none, so PHONE_CONTEXT_MESSAGES_MAX reads always cover a page; small messages take one.
const MESSAGE_READS_MAX = PHONE_CONTEXT_MESSAGES_MAX;

// A thread's messages of orders `start` up to `end`, following the engine's pages. Messages it doesn't cover within
// MESSAGE_READS_MAX reads fail the read, which then names no messages and no cursor, so none is skipped.
async function readMessages(
  pages: ThreadPages,
  input: { workspaceId: string; threadId: string; start: number; end: number },
): Promise<ChatMessage[]> {
  const wanted = input.end - input.start;
  const messages: ChatMessage[] = [];
  let after = input.start - 1;
  for (let reads = 0; reads < MESSAGE_READS_MAX && messages.length < wanted; reads += 1) {
    const page = await pages.listMessagesPage({
      workspaceId: input.workspaceId,
      threadId: input.threadId,
      limit: wanted - messages.length,
      ...(after < 0 ? {} : { afterMessageOrder: after }),
    });
    messages.push(...page.messages);
    const next = page.nextAfterMessageOrder;
    if (next === null || next <= after) break;
    after = next;
  }
  if (messages.length !== wanted) throw new Error("the engine's pages didn't cover the messages");
  return messages;
}

// The conversation as the phone's reads show it, its covered messages at most PHONE_CONTEXT_MESSAGES_MAX. A group is
// named by its exact engine ID, and covers the newest items the phone's stream read shows. A thread the filtered store
// doesn't list, which takes in one on a secret file, is missing. A listed thread covers one page of messages, read
// from `pages` past the filter: only their IDs, authors and times are used, never their attachments. Its message
// count gives where the page starts, since message orders count from zero. A thread's reactions list only whole, so
// none are read, and its people come from its covered messages alone.
async function readConversation(
  host: ChatsHost,
  pages: ThreadPages,
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
      limit: PHONE_CONTEXT_MESSAGES_MAX,
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
  const { messageCount } = await pages.getThread({ workspaceId, threadId: thread.id });
  const end = Math.min(target.before ?? messageCount, messageCount);
  const start = Math.max(0, end - PHONE_CONTEXT_MESSAGES_MAX);
  const messages = await readMessages(pages, { workspaceId, threadId: thread.id, start, end });
  const channel =
    thread.channelId === undefined
      ? undefined
      : channels.find((each) => each.id === thread.channelId);
  return {
    conversation: {
      kind: "thread",
      threadId: thread.id,
      groupKind: channel === undefined ? null : cliGroupKind(channel.kind),
      nextBefore: start === 0 ? null : start,
    },
    messages,
    reactions: [],
  };
}

// Agents on the account's computers, one per handle, with the computers a mention of it wakes: those whose agent
// remembers, when any does, else every one that runs it; then the account's active personal agents whose reach takes
// in the workspace, which no computer wakes; then people who wrote or reacted in the conversation, newest first. A name
// without a handle can't be mentioned.
function mentionCandidates(
  storage: SyncRelayStorage,
  input: { accountId: string; workspaceId: string; nowMs: number },
  shown: Conversation,
): PhoneMentionCandidate[] {
  const agents = new Map<string, Extract<PhoneMentionCandidate, { kind: "agent" }>>();
  const runners = storage.enabledChatRunners(input);
  const remembering = new Set(
    runners
      .filter((runner) => runner.memory)
      .map((runner) => normalizeHandle(handleForName(runner.displayName))),
  );
  for (const runner of runners) {
    const handle = handleForName(runner.displayName);
    if (handle === "") continue;
    const key = normalizeHandle(handle);
    if (remembering.has(key) && !runner.memory) continue;
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
 * the copy is open, once it has synced, and once the conversation is read.
 * The relay log's head bounds what any sync of the copy can pull, so the
 * read is judged against it: when the head is unchanged from before the copy
 * synced through that last check, the read still holds, and nothing is
 * awaited from the check to the answer, whose wakes and mention candidates
 * are read from storage in the same turn. When the head moved, the copy syncs
 * and reads once more; a second move answers a failed read.
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
  const logHead = () => storage.accountFeedStanding(workspaceId)?.log ?? null;
  return await server.copies.withServerCopy(accountId, workspaceId, input.visitor, async (copy) => {
    await input.authorize();
    const cursor = currentAccountFeedCursor(storage, workspaceId);
    const failed = async (error: unknown) => {
      await input.authorize();
      return { result: failure(error, "failed to read chat context", "operation-only"), cursor };
    };
    for (let attempt = 1; ; attempt += 1) {
      const head = logHead();
      await copy.sync(signal);
      await input.authorize();
      let read: Conversation | MissingResult;
      try {
        // A fresh host for each read, since a host keeps the places it judged.
        read = await readConversation(
          serverChats(storage, copy, workspaceId),
          new ChatsLiveAdapter(copy.client, copy.workspace, { workspaceId }),
          input.target,
        );
      } catch (error) {
        if (error instanceof RelayError || signal.aborted) throw error;
        return await failed(error);
      }
      await input.authorize();
      if (logHead() !== head) {
        if (attempt === 2) return await failed(null);
        continue;
      }
      // Nothing is awaited from the check above to the answer.
      if (!("conversation" in read)) return { result: read, cursor };
      const nowMs = input.nowMs();
      // The cursor first: a change after it, even in this same turn, moves the head past it.
      const wakeCursor = String(storage.chatWakeHead(accountId));
      const shown = new Map(read.messages.map((message) => [message.id, message.threadId]));
      return {
        result: {
          ok: true,
          conversation: read.conversation,
          mentions: mentionCandidates(storage, { accountId, workspaceId, nowMs }, read),
          wakes: storage.phoneChatWakes({ accountId, workspaceId, messages: shown, nowMs }),
          wakeCursor,
        },
        cursor,
      };
    }
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

// How a thread stands by the relay's log alone. Hidden as the feed judges it: its create names a hidden path, or the
// log last put its file at one. Shown only when the log holds its create, and, for a thread on a file, last put that
// file at a path that isn't hidden. Anything else, such as a thread whose create the log doesn't hold, is unknown.
function threadStanding(
  storage: Pick<SyncRelayStorage, "accountFeedThreadPaths">,
  workspaceId: string,
  threadId: string,
): "shown" | "hidden" | "unknown" {
  const paths = storage.accountFeedThreadPaths(workspaceId, threadId);
  if (paths.named.some(hiddenFile) || hiddenFile(paths.lastKnownPath ?? undefined)) return "hidden";
  return paths.created && (paths.linkedObjectId === null || paths.lastKnownPath !== null)
    ? "shown"
    : "unknown";
}

/**
 * Answers the threads of the workspace whose wakes changed after `since`,
 * waiting up to `holdMs` for a change when none has. Its cursor is the
 * account's wake head, apart from the workspace feed's. A change in a thread
 * the log puts on a hidden file never answers, and neither does one in
 * another workspace; each only moves the cursor while the read keeps
 * waiting. A change in a thread the log can't place answers `replace`,
 * which names no thread. A gap longer than one page answers each page,
 * changed or not. A `since` past the head answers `replace`. `authorize`
 * runs after every wait and before every answer; the threads are judged
 * after that last check, with nothing awaited before the answer. The phone
 * reads the context of a thread named here again, which checks everything
 * afresh.
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
  const standing = (threadId: string) => threadStanding(storage, workspaceId, threadId);
  const answered = async (threadIds: readonly string[]): Promise<WakeChangesAnswer> => {
    const cursor = String(since);
    await input.authorize();
    const standings = threadIds.map(standing);
    if (standings.includes("unknown")) return { cursor, replace: true };
    return { cursor, threads: threadIds.filter((_, index) => standings[index] === "shown") };
  };
  for (;;) {
    const head = storage.chatWakeHead(accountId);
    if (since > head) {
      await input.authorize();
      return { cursor: String(head), replace: true };
    }
    if (since < head) {
      const page = storage.chatWakeChanges({ accountId, workspaceId, since, through: head });
      since = page.next;
      if (since < head || page.threadIds.some((threadId) => standing(threadId) !== "hidden"))
        return await answered(page.threadIds);
    }
    const holdMs = deadlineAtMs - Date.now();
    if (holdMs <= 0 || input.signal.aborted) return await answered([]);
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
