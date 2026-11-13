import { createHash } from "node:crypto";
import { phoneMarkReadArgsSchema, phoneRetryWakeArgsSchema, phoneWriteArgsSchemas, type PhoneWriteOperation } from "@dohc/cli/protocol";
import { createActorIssuer, deriveLocalActor, serializeActorKey } from "@dohc/workspace-contracts/actor-identity";
import type { ChatMessage, ChatThread, ChatThreadLane } from "@dohc/workspace-contracts/engine";
import { asRecord } from "@dohc/workspace-core";
import { CHATS_METHOD, ChatsLiveAdapter, DaemonRefusalError, type JsonValue } from "@dohc/workspace-engine-client";
import { EngineRequestError } from "@dohc/workspace-engine-client/daemon";
import {
  answerDecision, answerWithReply, checkedContent, engineTrim, postToGroup, reactToMessage, replyInThread, sendToStream,
  type ChatMessageContent, type ChatWriteHost,
} from "@dohc/workspace-operations/chat-writes";
import { failure, OperationError } from "@dohc/workspace-operations/chats";
import { currentAccountFeedCursor } from "./accountFeed";
import { serverChats, type MissingResult } from "./accountOperations";
import type { AutomationReplica } from "./automationReplicas";
import { stableJsonStringify } from "./canonicalJson";
import { frozenWakes, resolveWakeTargets, shownName, TooManyWakeCandidates, type DmSource, type FrozenWakes, type WakeSources } from "./chatWakes";
import { badRequest, notFound, RelayError } from "./errors";
import {
  COULD_NOT_SEND, PUBLICATION_DEADLINE_MS, TOO_OLD, WORKSPACE_CHANGED, commandStages, isRefusalReason, publishOperation, receiptReader,
  type ExpectedRecord, type PublicationAnswer, type PublicationStage, type RefusalReason,
} from "./operationPublication";
import type { CopyVisitor, ServerCopies } from "./serverCopies";
import type { SyncRelayStorage } from "./storage";
import type { ChatWakeView } from "./storage/chatWakes";
import type { OperationRecord } from "./storage/operationRecords";

// The phone's chat writes on this server's copy of a workspace its account
// owns. The account and its name come from the session, never the request.
// Every target resolves through the reads' secret-file filter, so a hidden
// one answers exactly as a missing one, before any row. The operation's row,
// with its canonical command, is written before the engine's first stage, and
// every stage carries its derived key and asks the engine for a receipt. A
// stage that a crash or a lost answer left unwritten replays from that stored
// command, when the copy opens or the phone retries. The agents a message
// wakes are resolved once, before the row, and frozen in its command. The
// account operations route calls `runAccountWrite`, `runAccountMarkRead` for
// a read mark, which has no row: a repeat, or an older mark, moves nothing,
// and `runAccountRetryWake` for a wake's Try again.

/** The bounds of a phone write's operation ID, in UTF-16 code units, which storage's bound in characters admits. */
export const OPERATION_ID_MIN_LENGTH = 1;
export const OPERATION_ID_MAX_LENGTH = 128;

export function isOperationId(value: unknown): value is string {
  return typeof value === "string" && value.length >= OPERATION_ID_MIN_LENGTH && value.length <= OPERATION_ID_MAX_LENGTH;
}

type MessageArgs = { body: string; needsDecision?: boolean; options?: string[] };

/** A phone write, as its strict request schema admits it. */
export type PhoneWrite = { [Operation in PhoneWriteOperation]: {
  operation: Operation;
  args: ReturnType<(typeof phoneWriteArgsSchemas)[Operation]["parse"]>;
} }[PhoneWriteOperation];

/** Whether `name` is a phone write's operation. */
export function isPhoneWriteOperation(name: string): name is PhoneWriteOperation {
  return Object.hasOwn(phoneWriteArgsSchemas, name);
}

/**
 * The phone write `operation` names, with its arguments checked against its
 * strict schema. An unknown name rejects with not-found, and arguments
 * outside the schema with a bad request.
 */
export function parsePhoneWrite(operation: string, args: unknown): PhoneWrite {
  if (!isPhoneWriteOperation(operation)) throw notFound();
  const parsed = phoneWriteArgsSchemas[operation].safeParse(args);
  if (!parsed.success) throw badRequest(`the arguments do not fit ${operation}`);
  return { operation, args: parsed.data } as PhoneWrite;
}

/** Who writes, from the session. */
export interface PhoneWriter {
  accountId: string;
  /** The account's name now. The row keeps it, so a retry or a replay writes the same author. */
  displayName: string | null;
  /** This server's public URL, which issues the account's actor key. */
  serverUrl: string;
}

/** The author a write's row keeps, taken once when the row is made. */
export type AuthorSnapshot = { accountId: string; displayName: string; actorKey: string | null };

type StartWrite = ChatMessageContent & {
  kind: "start"; lane: ChatThreadLane; channelId: string; threadId: string; messageId: string; title?: string;
};
type ReplyWrite = ChatMessageContent & { kind: "reply"; threadId: string; parentMessageId?: string; messageId: string };
type AnswerWrite = ChatMessageContent & {
  kind: "answer"; threadId: string; parentMessageId?: string; messageId: string; questionId: string; chosenOption?: string;
};
type ReactWrite = { kind: "react"; threadId: string; messageId: string; emoji: string; state: "added" | "removed" };

/** A write's resolved targets and derived IDs. A start's thread is a proposal: a running conversation can take its message. */
export type WriteCommand = StartWrite | ReplyWrite | AnswerWrite | ReactWrite;

/** What a write's row keeps as its command: its publication, the write, its author, and the agents its message wakes. */
export type StoredWrite = { stages: PublicationStage[]; write: WriteCommand; author: AuthorSnapshot; wakes: FrozenWakes };

/** The answer a phone write gives. A missing or hidden target answers exactly as reads answer one. */
export type PhoneWriteAnswer =
  | { ok: true; state: "saved" | "pending"; threadId?: string; messageId?: string }
  | { ok: false; refusal: "refused"; reason: RefusalReason; threadId?: string; winnerMessageId?: string }
  | MissingResult;

type Role = PublicationStage["role"];

/** The IDs and stage keys a write derives from its account, workspace, and operation ID. */
export function phoneWriteIds(accountId: string, workspaceId: string, operationId: string) {
  const derive = (role: Role, purpose: "thread" | "message" | "key") =>
    createHash("sha256").update(stableJsonStringify([accountId, workspaceId, operationId, role, purpose])).digest("hex");
  return {
    threadId: `thread-${derive("post", "thread").slice(0, 32)}`,
    messageId: (role: "post" | "reply") => `message-${derive(role, "message").slice(0, 32)}`,
    key: (role: Role) => `phone-${role}-${derive(role, "key")}`,
  };
}

/** A target the account may not see, or that isn't there, worded as reads word it. */
class TargetMissing extends Error {
  readonly reason: string;
  constructor(reason: string) {
    super(reason);
    this.name = "TargetMissing";
    this.reason = reason;
  }
}

/** A write the shared rules refuse before any row, such as an empty message. */
class WriteInvalid extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WriteInvalid";
  }
}

/** The copy the write was admitted to is no longer the workspace's current one. */
class CopyReplaced extends Error {
  constructor() {
    super("This server's copy of the workspace was replaced.");
    this.name = "CopyReplaced";
  }
}

/** An engine read a write's checks needed failed. Its words stay on this server. */
class ReadFailed extends Error {
  constructor(cause: unknown) {
    super("A chat read failed.", { cause });
    this.name = "ReadFailed";
  }
}

const threadMissing = (threadId: string) => new TargetMissing(`chat thread not found: ${threadId}`);
const groupMissing = (groupId: string) => new TargetMissing(new OperationError(`no such group: ${groupId}`).message);
const messageMissing = (messageId: string) => new TargetMissing(new OperationError(`no such message in this thread: ${messageId}`).message);
const mismatched = () => new Error("The write's command doesn't match its record.");

// The engine's own answer, as the adapters raise it (a DaemonRefusalError) or as its client does.
function engineAnswer(error: unknown): { code: string; message: string } | null {
  if (error instanceof DaemonRefusalError) return { code: error.wireCode, message: error.message };
  if (error instanceof EngineRequestError && error.wireError !== undefined) return { code: error.wireError.code, message: error.wireError.message };
  return null;
}

// The engine's answer for a message it doesn't hold (chats.rs, require_message_row). Any other failure says nothing of it.
function messageNotFound(error: unknown): boolean {
  const answer = engineAnswer(error);
  return answer?.code === "INVALID_PARAMS" && answer.message === "message-not-found";
}

// The engine refused the request's content, which it checks before writing. A reused key means an earlier attempt
// wrote, and an internal failure can follow a write that committed, so neither counts.
function refusedByEngine(error: unknown): boolean {
  const answer = engineAnswer(error);
  return answer?.code === "INVALID_PARAMS" && answer.message !== "idempotency-key-reuse-mismatch";
}

const toJson = (value: unknown): JsonValue => JSON.parse(JSON.stringify(value)) as JsonValue;

// The name as the engine stores it, so the published row can be compared with it exactly.
function authorName(name: string | null): string {
  return shownName(name ?? "") || "Unnamed";
}

function authorOf(writer: PhoneWriter, workspaceId: string): AuthorSnapshot {
  const displayName = authorName(writer.displayName);
  let actorKey: string | null;
  try {
    actorKey = serializeActorKey(deriveLocalActor({
      identity: { installationId: "server", account: { issuer: createActorIssuer(writer.serverUrl), userId: writer.accountId } },
      workspaceId, author: { kind: "human" }, displayName, origin: "unknown",
    }).key);
  } catch {
    actorKey = null;
  }
  return { accountId: writer.accountId, displayName, actorKey };
}

const follow = (threadId: string, author: AuthorSnapshot): ExpectedRecord => ({
  kind: "chat.follow.set", fields: { ownerUserId: author.accountId, targetKind: "thread", targetId: threadId, state: "following" },
  // A person's first message or reaction in a thread follows it.
  optional: true,
});

// A person's own message is read for their account. The mark moves only
// forward, so a copy already past it writes none.
const readMark = (threadId: string, messageId: string, author: AuthorSnapshot): ExpectedRecord => ({
  kind: "chat.thread.read.set", fields: { accountUserId: author.accountId, threadId, lastReadMessageId: messageId },
  optional: true,
});

// What a person's message makes: the thread's structure the first time this
// copy writes in it, the message, the follow, the account's read mark, and an
// open question or poll with its choices as the engine trims them. The engine
// names a parent only once it exported the parent, so a named one must be the
// write's own.
function messageRecords(threadId: string, messageId: string, author: AuthorSnapshot, content: ChatMessageContent,
  parentMessageId?: string): ExpectedRecord[] {
  const options = (content.options ?? []).map(engineTrim);
  const question: ExpectedRecord[] = content.needsDecision === true || options.length > 0
    ? [{ kind: "chat.decision.set", fields: { threadId, messageId, state: "open", ...(options.length > 0 ? { options } : {}) },
      ...(options.length > 0 ? {} : { absent: ["options"] }) }]
    : [];
  return [
    { kind: "chat.thread.create", fields: { threadId }, optional: true },
    { kind: "chat.message.append", fields: {
      messageId, threadId, authorKind: "human", authorDisplayName: author.displayName, authorUserId: author.accountId, body: content.body,
    }, ...(parentMessageId === undefined ? { absent: ["parentMessageId"] } : { whenPresent: { parentMessageId } }) },
    follow(threadId, author),
    readMark(threadId, messageId, author),
    ...question,
  ];
}

/** The records each stage of a write must publish, as the relay must hold them. */
export function publicationStages(write: WriteCommand, author: AuthorSnapshot, key: (role: Role) => string): PublicationStage[] {
  switch (write.kind) {
    case "start":
      return [{ key: key("post"), role: "post", engineThread: write.threadId, records: messageRecords(write.threadId, write.messageId, author, write) }];
    case "reply":
      return [{ key: key("reply"), role: "reply", records: messageRecords(write.threadId, write.messageId, author, write, write.parentMessageId) }];
    case "answer":
      return [
        { key: key("reply"), role: "reply", records: messageRecords(write.threadId, write.messageId, author, write, write.parentMessageId) },
        { key: key("decision"), role: "decision", records: [{ kind: "chat.decision.set", fields: {
          threadId: write.threadId, messageId: write.questionId, state: "resolved", resolvedByMessageId: write.messageId,
          ...(write.chosenOption === undefined ? {} : { chosenOption: write.chosenOption }),
        }, ...(write.chosenOption === undefined ? { absent: ["chosenOption"] } : {}) }] },
      ];
    case "react": {
      const records: ExpectedRecord[] = [{ kind: "chat.reaction.set", fields: {
        threadId: write.threadId, messageId: write.messageId, emoji: write.emoji.trim().normalize("NFC"),
        authorId: author.accountId, authorDisplayName: author.displayName, state: write.state,
      } }];
      if (write.state === "added") records.push(follow(write.threadId, author));
      return [{ key: key("reaction"), role: "reaction", records }];
    }
  }
}

const WRITE_KINDS: ReadonlySet<string> = new Set<WriteCommand["kind"]>(["start", "reply", "answer", "react"]);

/** A row's stored write, or null for a command this module didn't write. */
export function storedWrite(command: JsonValue): StoredWrite | null {
  const stages = commandStages(command);
  const root = asRecord(command);
  const value: unknown = root?.write;
  const write = asRecord(value), author = asRecord(root?.author);
  if (stages === null || write === null || author === null) return null;
  const accountId = author.accountId, displayName = author.displayName, actorKey = author.actorKey;
  if (typeof accountId !== "string" || typeof displayName !== "string") return null;
  if (actorKey !== null && typeof actorKey !== "string") return null;
  // This module wrote it, so its kind and the IDs every kind has are enough to know its shape.
  if (!WRITE_KINDS.has(String(write.kind)) || typeof write.threadId !== "string" || typeof write.messageId !== "string") return null;
  return {
    stages, write: value as WriteCommand, author: { accountId, displayName, actorKey: typeof actorKey === "string" ? actorKey : null },
    wakes: frozenWakes(command),
  };
}

function stageKey(stored: StoredWrite, role: Role): string {
  const stage = stored.stages.find((each) => each.role === role);
  if (stage === undefined) throw new Error(`This write has no ${role} stage.`);
  return stage.key;
}

const humanAuthor = (author: AuthorSnapshot) => ({
  author: { kind: "human" as const, displayName: author.displayName }, authorUserId: author.accountId, authorActorKey: author.actorKey,
});

const contentOf = (content: ChatMessageContent) => ({
  body: content.body,
  ...(content.needsDecision ? { needsDecision: true } : {}),
  ...(content.options ? { options: content.options } : {}),
});

// Each engine stage, from the stored write alone, with its derived key and a receipt.
function writeStart(adapter: ChatsLiveAdapter, workspaceId: string, stored: StoredWrite, write: StartWrite) {
  return adapter.startChannelThread({
    workspaceId, channelId: write.channelId, lane: write.lane, threadId: write.threadId, messageId: write.messageId,
    ...(write.title ? { title: write.title } : {}), ...contentOf(write), ...humanAuthor(stored.author),
    idempotencyKey: stageKey(stored, "post"), stageReceipt: true,
  });
}

function writeReply(adapter: ChatsLiveAdapter, workspaceId: string, stored: StoredWrite, write: ReplyWrite | AnswerWrite) {
  return adapter.sendMessage({
    workspaceId, threadId: write.threadId, messageId: write.messageId,
    ...(write.parentMessageId ? { parentMessageId: write.parentMessageId } : {}), ...contentOf(write), ...humanAuthor(stored.author),
    idempotencyKey: stageKey(stored, "reply"), stageReceipt: true,
  });
}

// The resolve names the reply this answer wrote, in the thread it was admitted to.
function writeResolve(adapter: ChatsLiveAdapter, workspaceId: string, stored: StoredWrite, write: AnswerWrite,
  reply: { threadId: string; messageId: string }) {
  return adapter.resolveChatDecision({
    workspaceId, threadId: reply.threadId, messageId: write.questionId, resolvedByMessageId: reply.messageId,
    ...(write.chosenOption !== undefined ? { chosenOption: write.chosenOption } : {}),
    idempotencyKey: stageKey(stored, "decision"), stageReceipt: true,
  });
}

function writeReaction(adapter: ChatsLiveAdapter, workspaceId: string, stored: StoredWrite, write: ReactWrite) {
  const { accountId, displayName } = stored.author;
  return adapter.setReaction({
    workspaceId, threadId: write.threadId, messageId: write.messageId, emoji: write.emoji,
    author: { authorId: accountId, kind: "human", displayName }, replicationAuthorId: accountId, state: write.state,
    idempotencyKey: stageKey(stored, "reaction"), stageReceipt: true,
  });
}

/**
 * The targets the account may see in the copy, by the reads' own rules: a
 * thread is one the secret-file-filtered store lists, and a message one in
 * such a thread. A hidden one answers exactly as a missing one, after the
 * same reads, so its answer takes no longer or shorter than a missing one's.
 */
function visibleTargets(storage: SyncRelayStorage, copy: AutomationReplica) {
  const { workspaceId } = copy;
  const chats = serverChats(storage, copy, workspaceId);
  const adapter = new ChatsLiveAdapter(copy.client, copy.workspace, { workspaceId });
  const visible = async (threadId: string): Promise<ChatThread | undefined> =>
    (await chats.store.listThreads({ workspaceId })).find((each) => each.id === threadId);
  const rawMessage = (messageId: string) => adapter.getMessage({ workspaceId, messageId }).catch((error: unknown) => {
    if (messageNotFound(error)) return null;
    throw error;
  });
  return {
    async thread(threadId: string): Promise<ChatThread> {
      const found = await visible(threadId);
      if (found === undefined) throw threadMissing(threadId);
      return found;
    },
    async message(messageId: string): Promise<ChatMessage> {
      const [found, listed] = await Promise.all([rawMessage(messageId), chats.store.listThreads({ workspaceId })]);
      if (found === null || !listed.some((each) => each.id === found.threadId)) throw messageMissing(messageId);
      return found;
    },
    // A message in a thread the caller already found visible: one in any other thread, hidden or not, is missing.
    async messageIn(threadId: string, messageId: string): Promise<ChatMessage> {
      const found = await rawMessage(messageId);
      if (found === null || found.threadId !== threadId) throw messageMissing(messageId);
      return found;
    },
    // A post goes to a Group's posts; a send to a Group's chat or a DM.
    async channel(channelId: string, lane: ChatThreadLane): Promise<void> {
      const found = (await chats.store.listChannels({ workspaceId })).find((each) => each.id === channelId);
      if (found === undefined) throw groupMissing(channelId);
      const fits = lane === "posts" ? found.kind === "channel" && found.type !== "chat" : found.kind !== "channel" || found.type !== "posts";
      if (!fits) throw new WriteInvalid(lane === "posts" ? "This group takes no posts." : "This group has no chat.");
    },
    // A visible thread's first message.
    async opening(threadId: string): Promise<ChatMessage | null> {
      return (await adapter.listMessagesPage({ workspaceId, threadId, limit: 1 })).messages[0] ?? null;
    },
    // The agent of an agent's DM, or null for any other channel.
    async dmAgent(channelId: string): Promise<string | null> {
      const found = (await chats.store.listChannels({ workspaceId })).find((each) => each.id === channelId);
      return found?.kind === "agent" ? found.agentId ?? null : null;
    },
    // The newest message `pick` keeps in the channel's threads of both lanes, replies included, by `(createdAtMs, id)`,
    // when a fixed budget reads all of them. Message order is arrival order, and a synced message keeps its sender's
    // time, so no page or thread proves the newest until every message is read. Each thread is read from its end, a
    // page at a time; its message count gives where its last page starts, since its message orders count from zero.
    // A listing with more threads than it returned, or a budget that runs out, answers incomplete, with no message.
    async latest(channelId: string, pick: (message: ChatMessage) => boolean): Promise<DmSource> {
      // The raw listing skips the secret-file filter safely: that filter hides only threads on a file, and every thread
      // on a file is skipped here. A channel's threads are never on one.
      const lanes = await Promise.all((["posts", "chat"] as const)
        .map((lane) => adapter.request(CHATS_METHOD.threadsListForChannel, { channelId, lane, pageLimit: DM_THREADS_PER_LANE })));
      if (lanes.some((page) => (page.nextCursor ?? null) !== null)) return { complete: false };
      let newest: ChatMessage | null = null;
      let pages = 0, read = 0;
      for (const { thread, messageCount } of lanes.flatMap((page) => page.threads)) {
        if (thread.linkedFile !== undefined) continue;
        for (let end = messageCount; end > 0;) {
          if (pages === DM_MESSAGE_PAGES || read === DM_MESSAGES) return { complete: false };
          const start = Math.max(0, end - MESSAGE_PAGE, end - (DM_MESSAGES - read));
          const page = await adapter.listMessagesPage({
            workspaceId, threadId: thread.id, limit: end - start, ...(start === 0 ? {} : { afterMessageOrder: start - 1 }),
          });
          pages += 1;
          read += end - start;
          for (const message of page.messages) {
            if (pick(message) && (newest === null || message.createdAtMs > newest.createdAtMs ||
              (message.createdAtMs === newest.createdAtMs && message.id > newest.id))) newest = message;
          }
          end = start;
        }
      }
      return { complete: true, message: newest };
    },
    // IDs a write would create. One a hidden row already holds answers as missing, so no engine conflict reveals it.
    async unclaimed(ids: { threadId?: string; messageId: string }): Promise<void> {
      if (ids.threadId !== undefined && (await adapter.listThreads({ workspaceId })).some((each) => each.id === ids.threadId) &&
        (await visible(ids.threadId)) === undefined) throw threadMissing(ids.threadId);
      const held = await rawMessage(ids.messageId);
      if (held !== null && (await visible(held.threadId)) === undefined) throw messageMissing(ids.messageId);
    },
  };
}

type Targets = ReturnType<typeof visibleTargets>;
// The engine's largest message page.
const MESSAGE_PAGE = 500;
// What finding a DM's agent reads at most: the newest threads of each lane, message pages, and messages.
const DM_THREADS_PER_LANE = 8;
const DM_MESSAGE_PAGES = 4;
const DM_MESSAGES = 2_000;

// What wake resolution reads: the account's enabled agents, and the copy through the reads' filter, a hidden target
// reading as a missing one. A failed read fails the write before its row.
function wakeSources(storage: SyncRelayStorage, copy: AutomationReplica, targets: Targets, accountId: string): WakeSources {
  const hidden = async <T>(read: () => Promise<T>): Promise<T | null> => {
    try {
      return await read();
    } catch (error) {
      if (error instanceof TargetMissing) return null;
      throw error;
    }
  };
  return {
    runners: storage.enabledChatRunners({ accountId, workspaceId: copy.workspaceId }),
    message: (messageId) => hidden(() => targets.message(messageId)),
    thread: (threadId) => hidden(() => targets.thread(threadId)),
    opening: (threadId) => targets.opening(threadId),
    dmAgent: (channelId) => targets.dmAgent(channelId),
    latest: (channelId, pick) => targets.latest(channelId, pick),
  };
}

function advance(storage: SyncRelayStorage, record: OperationRecord, nowMs: number,
  change: { stage?: "reply-written" | "answer-written"; threadId?: string }): void {
  storage.advanceAccountOperation({
    accountId: record.accountId, operationId: record.operationId, nowMs,
    ...(change.stage ? { stage: change.stage } : {}),
    // The thread the engine wrote to, kept before the write settles.
    ...(change.threadId ? { result: { threadId: change.threadId } } : {}),
  });
}

/**
 * Runs one engine stage of a recorded write. An error doesn't say the stage
 * didn't commit: an internal failure can follow a commit. Only the engine's
 * refusal of the stage's content, with no receipt for the stage, proves the
 * stage never wrote. With no earlier stage of the write committed, nothing
 * of it can publish, so the write is refused now. An answer's decision stage
 * after its reply committed is marked instead: nothing writes it again, and
 * publication refuses the write once the reply is published. Any other
 * outcome is left to publication.
 */
async function runStage<T>(context: WriteContext, record: OperationRecord, progress: { committed: boolean }, key: string,
  run: () => Promise<T>, decision?: { threadId: string }): Promise<T> {
  try {
    const result = await run();
    progress.committed = true;
    return result;
  } catch (error) {
    const change = !progress.committed ? { stage: "refused" as const, result: { threadId: null, reason: COULD_NOT_SEND } }
      : decision !== undefined ? { result: { threadId: decision.threadId, refusedStage: key } }
      : null;
    if (change !== null && refusedByEngine(error) && await receiptAbsent(context, key)) {
      context.storage.advanceAccountOperation({ accountId: record.accountId, operationId: record.operationId, nowMs: context.nowMs(), ...change });
    }
    throw error;
  }
}

// Whether the engine holds no receipt for the stage. A read that fails proves nothing.
async function receiptAbsent(context: WriteContext, key: string): Promise<boolean> {
  try {
    const [stage] = (await receiptReader(context.copy, context.copy.workspace, context.signal)([key])).stages;
    return stage?.state === "absent";
  } catch {
    return false;
  }
}

interface WriteContext {
  storage: SyncRelayStorage;
  copy: AutomationReplica;
  /** Checks the caller's access again. It throws notFound() for any loss of it. */
  authorize(): Promise<void>;
  nowMs(): number;
  signal?: AbortSignal;
  /**
   * Whether the copy is still as current as when a replay began. Called with nothing awaited between it and the
   * stage it guards.
   */
  current?(): boolean;
}

/** A replay stopped because the copy started syncing, or fell behind the relay, while it ran. */
class CopyBehind extends Error {
  constructor() {
    super("The copy changed while its phone writes replayed.");
    this.name = "CopyBehind";
  }
}

const stillCurrent = (context: WriteContext) => {
  if (context.current !== undefined && !context.current()) throw new CopyBehind();
};

interface Session {
  readonly stored: StoredWrite;
  /** The write's row, once made. */
  record: OperationRecord | null;
  /** Whether a stage of the write committed. */
  committed: boolean;
}

/**
 * 3c's chat write host on this server's copy. Each member admits its
 * targets through the reads' filter, then makes the write's row with
 * `record`, then runs its stages from the stored write, checking the
 * caller's access again before each one.
 */
function serverWriteHost(context: WriteContext, targets: Targets, session: Session, record: () => OperationRecord): ChatWriteHost {
  const { storage, copy, nowMs } = context;
  const { workspaceId } = copy;
  const adapter = new ChatsLiveAdapter(copy.client, copy.workspace, { workspaceId });
  const { stored } = session;
  const { write } = stored;

  // Access is checked, then the row made, then the stage started, with nothing awaited between them.
  async function stage<T>(role: Role, run: () => Promise<T>): Promise<T> {
    await context.authorize();
    stillCurrent(context);
    const row = (session.record ??= record());
    return await runStage(context, row, session, stageKey(stored, role), run,
      role === "decision" ? { threadId: write.threadId } : undefined);
  }
  const progress = (change: { stage?: "reply-written" | "answer-written"; threadId?: string }) => {
    if (session.record !== null) advance(storage, session.record, nowMs(), change);
  };

  return {
    workspaceId,
    store: {
      listThreadDecisions: async (workspace, threadId) => {
        try {
          await targets.thread(threadId);
          return await adapter.listThreadDecisions(workspace, threadId);
        } catch (error) {
          throw error instanceof TargetMissing ? error : new ReadFailed(error);
        }
      },
    },
    findMessage: (messageId) => targets.message(messageId),
    async start(command) {
      if (write.kind !== "start" || command.channelId !== write.channelId || command.lane !== write.lane) throw mismatched();
      await context.authorize();
      await targets.channel(write.channelId, write.lane);
      await targets.unclaimed({ threadId: write.threadId, messageId: write.messageId });
      const started = await stage("post", () => writeStart(adapter, workspaceId, stored, write));
      progress({ threadId: started.thread.id });
      return started;
    },
    async reply(command) {
      if (write.kind !== "reply" || command.threadId !== write.threadId) throw mismatched();
      await context.authorize();
      await targets.thread(write.threadId);
      await targets.unclaimed({ messageId: write.messageId });
      const message = await stage("reply", () => writeReply(adapter, workspaceId, stored, write));
      progress({ threadId: message.threadId });
      return message;
    },
    async answer(command, checkTargets, use) {
      if (write.kind !== "answer" || command.threadId !== write.threadId) throw mismatched();
      await context.authorize();
      await targets.thread(write.threadId);
      try {
        await checkTargets();
      } catch (error) {
        // Engine reads already carry their own class; what is left is the shared rules' refusal of the choice.
        if (error instanceof TargetMissing || error instanceof OperationError || error instanceof ReadFailed || error instanceof RelayError) throw error;
        throw new WriteInvalid(error instanceof Error ? error.message : "This answer doesn't fit its question.");
      }
      await targets.unclaimed({ messageId: write.messageId });
      let written: ChatMessage | null = null;
      return await use({
        reply: async () => {
          const message = await stage("reply", () => writeReply(adapter, workspaceId, stored, write));
          written = message;
          progress({ stage: "reply-written", threadId: message.threadId });
          return message;
        },
        resolve: async (resolve) => {
          const reply: ChatMessage | null = written;
          if (reply === null || reply.id !== write.messageId || reply.threadId !== write.threadId || resolve.messageId !== write.questionId) {
            throw mismatched();
          }
          const decision = await stage("decision", () => writeResolve(adapter, workspaceId, stored, write, { threadId: write.threadId, messageId: reply.id }));
          progress({ stage: "answer-written" });
          return decision;
        },
      });
    },
    async answerWith(command, use) {
      if (write.kind !== "answer" || command.threadId !== write.threadId || command.questionId !== write.questionId) throw mismatched();
      await context.authorize();
      await targets.thread(write.threadId);
      const reply = await targets.message(command.replyId);
      // Only the reply this write made answers for it.
      if (reply.id !== write.messageId || reply.threadId !== write.threadId || reply.authorUserId !== stored.author.accountId) {
        throw messageMissing(command.replyId);
      }
      session.committed = true;
      return await use({
        reply,
        resolve: async () => {
          const decision = await stage("decision", () => writeResolve(adapter, workspaceId, stored, write, { threadId: write.threadId, messageId: reply.id }));
          progress({ stage: "answer-written" });
          return decision;
        },
      });
    },
    async react(command) {
      if (write.kind !== "react" || command.messageId !== write.messageId || command.threadId !== write.threadId || command.state !== write.state) {
        throw mismatched();
      }
      await context.authorize();
      await targets.thread(write.threadId);
      return await stage("reaction", () => writeReaction(adapter, workspaceId, stored, write));
    },
  };
}

/** The write's canonical command: its checked content, resolved targets, and derived IDs. */
async function canonicalWrite(write: PhoneWrite, ids: ReturnType<typeof phoneWriteIds>, targets: Targets): Promise<WriteCommand> {
  const content = (args: MessageArgs): ChatMessageContent => {
    try {
      return checkedContent(args);
    } catch (error) {
      throw new WriteInvalid(error instanceof Error ? error.message : "This message can't be sent.");
    }
  };
  switch (write.operation) {
    case "post":
      return { kind: "start", lane: "posts", channelId: write.args.groupId, threadId: ids.threadId, messageId: ids.messageId("post"),
        ...(write.args.title ? { title: write.args.title } : {}), ...content(write.args) };
    case "send":
      return { kind: "start", lane: "chat", channelId: write.args.streamId, threadId: ids.threadId, messageId: ids.messageId("post"),
        ...content(write.args) };
    case "reply": {
      const { threadId, parentMessageId, resolves } = write.args;
      const reply = { threadId, ...(parentMessageId ? { parentMessageId } : {}), messageId: ids.messageId("reply"), ...content(write.args) };
      if (resolves === undefined) return { kind: "reply", ...reply };
      const chosen = resolves.chosenOption === undefined ? "" : engineTrim(resolves.chosenOption);
      return { kind: "answer", ...reply, questionId: resolves.messageId, ...(chosen ? { chosenOption: chosen } : {}) };
    }
    case "react": {
      // A reaction names only its message, which must be one the account may see; its thread comes from it.
      const message = await targets.message(write.args.messageId);
      return { kind: "react", threadId: message.threadId, messageId: message.id, emoji: write.args.emoji, state: write.args.state };
    }
  }
}

// Runs the write's shared command, which checks what it writes and orders an answer's stages.
async function runCommand(host: ChatWriteHost, stored: StoredWrite): Promise<void> {
  const { write } = stored;
  const message = (content: ChatMessageContent) => ({
    body: content.body, ...(content.needsDecision ? { needsDecision: true } : {}), ...(content.options ? { options: content.options } : {}),
  });
  switch (write.kind) {
    case "start": {
      const input = { channelId: write.channelId, threadId: write.threadId, messageId: write.messageId, idempotencyKey: stageKey(stored, "post"),
        ...(write.title ? { title: write.title } : {}), ...message(write) };
      await (write.lane === "posts" ? postToGroup(host, input) : sendToStream(host, input));
      return;
    }
    case "reply":
      await replyInThread(host, { threadId: write.threadId, ...(write.parentMessageId ? { parentMessageId: write.parentMessageId } : {}),
        messageId: write.messageId, idempotencyKey: stageKey(stored, "reply"), ...message(write) });
      return;
    case "answer":
      await answerDecision(host, { threadId: write.threadId, ...(write.parentMessageId ? { parentMessageId: write.parentMessageId } : {}),
        messageId: write.messageId, idempotencyKey: stageKey(stored, "reply"), ...message(write),
        resolves: { messageId: write.questionId, idempotencyKey: stageKey(stored, "decision"),
          ...(write.chosenOption !== undefined ? { chosenOption: write.chosenOption } : {}) } });
      return;
    case "react":
      await reactToMessage(host, { threadId: write.threadId, messageId: write.messageId, emoji: write.emoji, state: write.state,
        idempotencyKey: stageKey(stored, "reaction") });
      return;
  }
}

/**
 * Replays the stages of a recorded write that its receipts say never
 * committed, from its stored command: never from the current name or
 * settings. Access is checked, and the thread found visible, before each.
 */
async function replayStages(context: WriteContext, record: OperationRecord, stored: StoredWrite): Promise<void> {
  const { storage, copy, nowMs } = context;
  const { workspaceId } = copy;
  const keys = stored.stages.map((stage) => stage.key);
  const receipts = await receiptReader(copy, copy.workspace, context.signal)(keys);
  const present = new Set(receipts.stages.filter((stage) => stage.state === "present").map((stage) => stage.stageKey));
  const progress = { committed: present.size > 0 };
  // A decision the engine refused is never asked again; publication settles its write.
  const refused = asRecord(record.result)?.refusedStage;
  const absent = (role: Role) => !present.has(stageKey(stored, role)) && stageKey(stored, role) !== refused;
  if (!stored.stages.some((stage) => absent(stage.role))) return;
  const adapter = new ChatsLiveAdapter(copy.client, copy.workspace, { workspaceId });
  const targets = visibleTargets(storage, copy);
  const { write } = stored;
  // The thread is checked, then access, then the stage started, with nothing awaited between the last two.
  const stage = async <T>(role: Role, run: () => Promise<T>): Promise<T> => {
    if (write.kind !== "start") await targets.thread(write.threadId);
    await context.authorize();
    stillCurrent(context);
    return await runStage(context, record, progress, stageKey(stored, role), run);
  };
  switch (write.kind) {
    case "start":
      if (absent("post")) {
        const started = await stage("post", () => writeStart(adapter, workspaceId, stored, write));
        advance(storage, record, nowMs(), { threadId: started.thread.id });
      }
      return;
    case "reply":
      if (absent("reply")) {
        const message = await stage("reply", () => writeReply(adapter, workspaceId, stored, write));
        advance(storage, record, nowMs(), { threadId: message.threadId });
      }
      return;
    case "answer":
      if (absent("reply")) {
        const message = await stage("reply", () => writeReply(adapter, workspaceId, stored, write));
        advance(storage, record, nowMs(), { stage: "reply-written", threadId: message.threadId });
      }
      if (absent("decision")) {
        // The saved reply answers through the shared command, which checks the question and the reply are ones
        // the account may see, and judges who won.
        const host = serverWriteHost(context, targets, { stored, record, committed: true }, () => record);
        await answerWithReply(host, {
          threadId: write.threadId, messageId: write.questionId, replyId: write.messageId, idempotencyKey: stageKey(stored, "decision"),
          ...(write.chosenOption !== undefined ? { chosenOption: write.chosenOption } : {}),
        });
      }
      return;
    case "react":
      if (absent("reaction")) await stage("reaction", () => writeReaction(adapter, workspaceId, stored, write));
      return;
  }
}

// One write at a time per account and operation ID, in this process. The row's key serializes the rest.
const operationLocks = new Map<string, Promise<void>>();
const lockKey = (accountId: string, operationId: string) => JSON.stringify([accountId, operationId]);

async function withOperationLock<T>(accountId: string, operationId: string, work: () => Promise<T>): Promise<T> {
  const key = lockKey(accountId, operationId);
  const run = (operationLocks.get(key) ?? Promise.resolve()).then(work);
  const after = run.then(() => undefined, () => undefined);
  operationLocks.set(key, after);
  try {
    return await run;
  } finally {
    if (operationLocks.get(key) === after) operationLocks.delete(key);
  }
}

const missing = (reason: string): MissingResult => ({ ok: false, reason, refusal: "missing" });
const refused = (reason: RefusalReason): PhoneWriteAnswer => ({ ok: false, refusal: "refused", reason });

// A write that failed before its row was made wrote nothing. A hidden or
// missing target answers as reads do; the shared rules' refusal is a bad
// request; anything else, an engine failure included, answers "Couldn't send".
function refusalBeforeRecord(error: unknown, signal: AbortSignal | undefined): PhoneWriteAnswer {
  if (error instanceof RelayError || signal?.aborted) throw error;
  if (error instanceof TargetMissing) return missing(error.reason);
  if (error instanceof OperationError) return missing(error.message);
  if (error instanceof WriteInvalid) throw badRequest(error.message);
  if (error instanceof CopyReplaced) return refused(WORKSPACE_CHANGED);
  if (error instanceof TooManyWakeCandidates) return refused(COULD_NOT_SEND);
  const { reason } = failure(error, COULD_NOT_SEND, "operation-only");
  return refused(isRefusalReason(reason) ? reason : COULD_NOT_SEND);
}

function phoneAnswer(published: PublicationAnswer, messageId: string | undefined): PhoneWriteAnswer {
  const result = asRecord(published.record?.result);
  const threadId = typeof result?.threadId === "string" ? { threadId: result.threadId } : {};
  if (published.state === "refused") {
    // Only a tombstone is left of a write settled long ago.
    const reason = published.record === null ? TOO_OLD
      : typeof result?.reason === "string" && isRefusalReason(result.reason) ? result.reason : COULD_NOT_SEND;
    const winner = typeof result?.winnerMessageId === "string" ? { winnerMessageId: result.winnerMessageId } : {};
    return { ok: false, refusal: "refused", reason, ...threadId, ...winner };
  }
  return { ok: true, state: published.state, ...threadId, ...(messageId === undefined ? {} : { messageId }) };
}

export interface PhoneWriteInput {
  storage: SyncRelayStorage;
  /** The account's open copy of the workspace, inside its visit. */
  copy: AutomationReplica;
  writer: PhoneWriter;
  write: PhoneWrite;
  /** Checks the caller's credential, ownership, and "Show on phone" again. It throws notFound() for any loss of access. */
  authorize(): Promise<void>;
  /** The request's own. Its abort rejects. */
  signal?: AbortSignal;
  nowMs?(): number;
  /** Tests shorten publication's wait. */
  deadlineMs?: number;
  pause?(ms: number, signal?: AbortSignal): Promise<void>;
}

/**
 * Runs one phone write on the account's open copy and answers saved,
 * pending, or refused from its row, or a missing target as reads answer it.
 * A retry with the same operation ID and arguments answers from the row and
 * replays only the stages its receipts lack; other arguments, or a row long
 * settled, are refused and write nothing. A settled write answers from its
 * row without touching the copy. Access is checked before the row, before
 * each engine stage, and before the answer. Throws the route's
 * not-found when access ends, and a bad request for a message the shared
 * rules refuse.
 */
export async function runPhoneWrite(input: PhoneWriteInput): Promise<PhoneWriteAnswer> {
  const { storage, copy, writer, write, signal } = input;
  const { workspaceId } = copy;
  const { operationId } = write.args;
  if (!isOperationId(operationId)) throw badRequest(`An operation ID has ${OPERATION_ID_MIN_LENGTH} to ${OPERATION_ID_MAX_LENGTH} characters.`);
  const nowMs = input.nowMs ?? Date.now;
  const authorize = () => input.authorize();
  const context: WriteContext = { storage, copy, authorize, nowMs, ...(signal ? { signal } : {}) };
  const binding = { workspaceId, operation: write.operation, args: toJson(write.args) };
  const answered = async (answer: PhoneWriteAnswer) => {
    await input.authorize();
    return answer;
  };
  // Access is checked before the error is read: a bad request says something of the target.
  const failedBeforeRecord = async (error: unknown) => {
    await input.authorize();
    return refusalBeforeRecord(error, signal);
  };
  const messageIdOf = (record: OperationRecord) => {
    const stored = storedWrite(record.command);
    return stored === null || stored.write.kind === "react" ? undefined : stored.write.messageId;
  };
  return await withOperationLock(writer.accountId, operationId, async () => {
    await input.authorize();
    // A known answer needs nothing of the copy: another write under this ID, one settled long ago, or a settled one.
    const found = storage.lookupAccountOperation({ accountId: writer.accountId, operationId, binding });
    if (found.kind === "mismatch") return await answered(refused(COULD_NOT_SEND));
    if (found.kind === "too-old") return await answered(refused(TOO_OLD));
    if (found.kind === "found" && (found.record.stage === "saved" || found.record.stage === "refused")) {
      return await answered(phoneAnswer({ state: found.record.stage === "saved" ? "saved" : "refused", record: found.record }, messageIdOf(found.record)));
    }
    let synced = true;
    try {
      await copy.sync(signal);
    } catch (error) {
      if (error instanceof RelayError || signal?.aborted) throw error;
      // Nothing is written yet, so the write wasn't sent; a recorded one's publication answers.
      if (found.kind === "absent") return await failedBeforeRecord(error);
      synced = false;
    }
    await input.authorize();
    let record: OperationRecord;
    if (found.kind === "found") {
      record = found.record;
      const stored = storedWrite(record.command);
      if (synced && stored !== null && record.incarnation === copy.incarnation) {
        try {
          await replayStages(context, record, stored);
        } catch (error) {
          if (error instanceof RelayError || signal?.aborted) throw error;
          if (error instanceof TargetMissing) return await answered(missing(error.reason));
          // A stage still unwritten leaves the write pending; its publication answers.
        }
      }
    } else {
      const ids = phoneWriteIds(writer.accountId, workspaceId, operationId);
      const targets = visibleTargets(storage, copy);
      let stored: StoredWrite;
      try {
        const command = await canonicalWrite(write, ids, targets);
        const author = authorOf(writer, workspaceId);
        const wakes = await resolveWakeTargets(wakeSources(storage, copy, targets, writer.accountId), writer.accountId, command);
        stored = { stages: publicationStages(command, author, ids.key), write: command, author, wakes };
      } catch (error) {
        return await failedBeforeRecord(error);
      }
      const session: Session = { stored, record: null, committed: false };
      // The row, written before the engine's first stage, under the identity the copy was made for.
      const claim = (): OperationRecord => {
        const row = storage.currentAutomationWorkspace(workspaceId);
        if (row === null || row.incarnation !== copy.incarnation) throw new CopyReplaced();
        const claimed = storage.recordAccountOperation({
          accountId: writer.accountId, operationId, binding, incarnation: row.incarnation,
          replicationEpoch: row.replicationEpoch, streamIdentity: row.streamIdentity,
          command: toJson(stored), writesMessage: stored.write.kind !== "react", nowMs: nowMs(),
        });
        if (claimed.kind === "recorded" || claimed.kind === "found") return claimed.record;
        if (claimed.kind === "not-owner") throw notFound();
        throw new Error("This operation ID names another write.");
      };
      try {
        await runCommand(serverWriteHost(context, targets, session, claim), stored);
      } catch (error) {
        if (session.record === null) return await failedBeforeRecord(error);
        if (error instanceof RelayError || signal?.aborted) throw error;
        // Once the row is made, what the relay holds answers, whatever this attempt saw.
      }
      if (session.record === null) return await answered(refused(COULD_NOT_SEND));
      record = session.record;
    }
    const current = storage.lookupAccountOperation({ accountId: writer.accountId, operationId, binding });
    if (current.kind === "found") record = current.record;
    const published = await publishOperation({
      storage, copy, record, authorize,
      ...(signal ? { signal } : {}), ...(input.deadlineMs === undefined ? {} : { deadlineMs: input.deadlineMs }),
      nowMs, ...(input.pause ? { pause: input.pause } : {}),
    });
    return await answered(phoneAnswer(published, messageIdOf(record)));
  });
}

/**
 * Runs one phone write in a visit to the account's copy of `workspaceId`,
 * and answers it with the change feed's cursor when it ran. A settled write
 * answers without a sync, so the copy may not have pulled up to that cursor,
 * and it is not a read's starting point. The caller authenticates the account, checks that it owns the
 * workspace and that the workspace shows on the phone, and parses the write.
 * `authorize` runs once the copy is open, then at each of the write's own
 * checks. The write runs its own sync, so a settled one answers without it.
 */
export async function runAccountWrite(
  server: { storage: SyncRelayStorage; copies: ServerCopies },
  input: {
    workspaceId: string;
    writer: PhoneWriter;
    write: PhoneWrite;
    visitor: Extract<CopyVisitor, { reason: "account" }>;
    authorize(): Promise<void>;
  },
): Promise<{ result: PhoneWriteAnswer; cursor: string }> {
  const { storage } = server;
  return await server.copies.withServerCopy(input.writer.accountId, input.workspaceId, input.visitor, async (copy) => {
    await input.authorize();
    const cursor = currentAccountFeedCursor(storage, input.workspaceId);
    const result = await runPhoneWrite({
      storage, copy, writer: input.writer, write: input.write, authorize: () => input.authorize(), signal: input.visitor.signal,
    });
    return { result, cursor };
  });
}

/** A phone read mark, as its strict request schema admits it. */
type PhoneMarkRead = ReturnType<(typeof phoneMarkReadArgsSchema)["parse"]>;

/** The read mark a request names. Arguments outside its schema reject with a bad request. */
export function parseMarkRead(args: unknown): PhoneMarkRead {
  const parsed = phoneMarkReadArgsSchema.safeParse(args);
  if (!parsed.success) throw badRequest("the arguments do not fit markRead");
  return parsed.data;
}

/** A read mark's answer: done, a missing or hidden target as reads answer one, or a failure without the engine's words. */
type MarkReadAnswer = { ok: true } | MissingResult | { ok: false; reason: string };

/**
 * Moves the account's read mark in a thread to a message the phone showed,
 * in a visit to its copy of `workspaceId`, after the copy syncs. The thread
 * and the message resolve through the reads' filter, so a hidden or missing
 * one, or a message in another thread, answers as reads answer a missing one,
 * before any mark. The copy's engine journals the mark with its owner's
 * context, and one sync step, bounded by the publication deadline, sends it
 * before the visit ends. A step that fails or runs out of time answers
 * "Couldn't send", which the phone retries. The caller authenticates the
 * account, checks that it owns the workspace and that the workspace shows on
 * the phone, and parses the mark. `authorize` runs once the copy is open,
 * once it has synced, after each target read, before the mark, and after the
 * step, before the answer.
 */
export async function runAccountMarkRead(
  server: { storage: SyncRelayStorage; copies: ServerCopies },
  input: {
    workspaceId: string;
    accountId: string;
    mark: PhoneMarkRead;
    visitor: Extract<CopyVisitor, { reason: "account" }>;
    authorize(): Promise<void>;
  },
): Promise<{ result: MarkReadAnswer; cursor: string }> {
  const { storage } = server;
  const { mark } = input;
  const { signal } = input.visitor;
  return await server.copies.withServerCopy(input.accountId, input.workspaceId, input.visitor, async (copy) => {
    await input.authorize();
    const cursor = currentAccountFeedCursor(storage, input.workspaceId);
    await copy.sync(signal);
    await input.authorize();
    const targets = visibleTargets(storage, copy);
    const adapter = new ChatsLiveAdapter(copy.client, copy.workspace, { workspaceId: copy.workspaceId });
    let result: MarkReadAnswer = { ok: true };
    try {
      await targets.thread(mark.threadId);
      await input.authorize();
      await targets.messageIn(mark.threadId, mark.messageId);
      await input.authorize();
      await adapter.markAccountThreadRead({
        workspaceId: copy.workspaceId, threadId: mark.threadId, messageId: mark.messageId, replicationOwnerUserId: copy.ownerUserId,
      });
    } catch (error) {
      if (error instanceof RelayError || signal.aborted) throw error;
      result = error instanceof TargetMissing ? missing(error.reason) : failure(error, `failed to mark read: ${mark.threadId}`, "operation-only");
    }
    if (result.ok) {
      // One sync step publishes the mark inside this visit, so the copy stays open for it. A step that fails or passes
      // the deadline answers "Couldn't send", and the phone sends the mark again; the copy keeps it meanwhile.
      const expired = new AbortController();
      const timer = setTimeout(() => expired.abort(new Error("The read mark's sync deadline passed.")), PUBLICATION_DEADLINE_MS);
      try {
        await copy.step(AbortSignal.any([signal, expired.signal]));
      } catch (error) {
        if (error instanceof RelayError || signal.aborted) throw error;
        result = failure(error, COULD_NOT_SEND, "operation-only");
      } finally {
        clearTimeout(timer);
      }
    }
    await input.authorize();
    return { result, cursor };
  });
}

/** The phone's Try again on a wake, as its strict request schema admits it. */
type PhoneRetryWake = ReturnType<(typeof phoneRetryWakeArgsSchema)["parse"]>;

/** The Try again a request names. Arguments outside its schema reject with a bad request. */
export function parseRetryWake(args: unknown): PhoneRetryWake {
  const parsed = phoneRetryWakeArgsSchema.safeParse(args);
  if (!parsed.success) throw badRequest("the arguments do not fit retryWake");
  return parsed.data;
}

/** A Try again's answer: the generation to show, a refusal from the closed list, or a wake the account can't see, as reads answer one. */
type RetryWakeAnswer = { ok: true; wake: ChatWakeView } | { ok: false; refusal: "refused"; reason: RefusalReason } | MissingResult;

/**
 * Tries a wake again, in a visit to the account's copy of `workspaceId`,
 * after the copy syncs. A wake whose thread the account may no longer see,
 * through the reads' secret-file filter, answers as one that isn't there,
 * and nothing changes. The relay log's head bounds what any sync of the copy
 * can pull, so the thread is judged against it: when the head is unchanged
 * from before the copy synced, through the read and the last session check,
 * the read still holds, and the retry commits with nothing awaited after
 * that check. When the head moved, the copy syncs and reads once more; a
 * second move answers "Couldn't send", with no generation and no binding.
 * The caller authenticates the account, checks that it owns the workspace
 * and that the workspace shows on the phone, and parses the request.
 */
export async function runAccountRetryWake(
  server: { storage: SyncRelayStorage; copies: ServerCopies },
  input: {
    workspaceId: string;
    accountId: string;
    retry: PhoneRetryWake;
    visitor: Extract<CopyVisitor, { reason: "account" }>;
    authorize(): Promise<void>;
    nowMs(): number;
  },
): Promise<{ result: RetryWakeAnswer; cursor: string }> {
  const { storage } = server;
  const { workspaceId, accountId } = input;
  const { operationId, wakeId } = input.retry;
  const { signal } = input.visitor;
  const missingWake: RetryWakeAnswer = { ok: false, reason: `no such wake: ${wakeId}`, refusal: "missing" };
  const notSent: RetryWakeAnswer = { ok: false, refusal: "refused", reason: COULD_NOT_SEND };
  const logHead = () => storage.accountFeedStanding(workspaceId)?.log ?? null;
  return await server.copies.withServerCopy(accountId, workspaceId, input.visitor, async (copy) => {
    await input.authorize();
    const cursor = currentAccountFeedCursor(storage, workspaceId);
    const answered = async (result: RetryWakeAnswer) => {
      await input.authorize();
      return { result, cursor };
    };
    // Whether the account may see the wake's thread now. A wake it doesn't have is left to the retry to answer.
    const visible = async () => {
      const threadId = storage.chatWakeThread({ accountId, workspaceId, wakeId });
      if (threadId === null) return true;
      try {
        await visibleTargets(storage, copy).thread(threadId);
        return true;
      } catch (error) {
        if (error instanceof TargetMissing) return false;
        throw error;
      }
    };
    for (let attempt = 1; ; attempt += 1) {
      const head = logHead();
      let shown: boolean;
      try {
        await copy.sync(signal);
        shown = await visible();
      } catch (error) {
        if (error instanceof RelayError || signal.aborted) throw error;
        return await answered(notSent);
      }
      await input.authorize();
      // Nothing is awaited from this check to the commit.
      if (logHead() === head) {
        if (!shown) return await answered(missingWake);
        const retried = storage.retryChatWake({ accountId, workspaceId, operationId, wakeId, nowMs: input.nowMs() });
        if (retried.kind === "retried") return await answered({ ok: true, wake: retried.wake });
        if (retried.kind === "missing") return await answered(missingWake);
        return await answered({ ok: false, refusal: "refused", reason: retried.kind === "too-old" ? TOO_OLD : COULD_NOT_SEND });
      }
      if (attempt === 2) return await answered(notSent);
    }
  });
}

/**
 * Whether a recorded write may still publish from its copy: its account
 * still owns the workspace, under the identity and incarnation it was
 * recorded on, the workspace shows on its phone, and nothing fenced or
 * deleted either.
 */
export function mayPublish(storage: SyncRelayStorage, record: OperationRecord): boolean {
  return storage.currentAutomationWorkspace(record.workspaceId)?.incarnation === record.incarnation &&
    storage.publishingCopies().some((copy) => copy.workspaceId === record.workspaceId && copy.ownerUserId === record.accountId);
}

/**
 * When a copy has caught up, replays each unfinished write's stages that
 * never committed, from its stored command, while its account may still
 * publish it. Answers whether every write is done with: replayed, skipped
 * because its account lost access or its thread is hidden, already
 * committed by its receipts, or refused. One a request is working on isn't.
 * A failure that may pass, such as an unreadable receipt, is reported and
 * leaves the replay owed.
 */
export async function replayUnfinishedWrites(input: {
  storage: SyncRelayStorage;
  copy: AutomationReplica;
  records: readonly OperationRecord[];
  nowMs(): number;
  onError(error: unknown): void;
  /** Whether the copy is still as current as when the replay began. A copy that isn't stops the replay, owed. */
  current?(): boolean;
}): Promise<boolean> {
  const { storage, copy } = input;
  const unfinished = (record: OperationRecord) => storage.listUnfinishedAccountOperations({ workspaceId: copy.workspaceId, incarnation: copy.incarnation })
    .find((each) => each.accountId === record.accountId && each.operationId === record.operationId);
  let done = true;
  for (const listed of input.records) {
    if (listed.incarnation !== copy.incarnation || storedWrite(listed.command) === null) continue;
    // A request is working on the write. The copy doesn't wait for it, but the request's stages can fail and leave
    // it to publication, so the replay stays owed and a later pass looks again.
    if (operationLocks.has(lockKey(listed.accountId, listed.operationId))) {
      done = false;
      continue;
    }
    try {
      await withOperationLock(listed.accountId, listed.operationId, async () => {
        // A request may have finished it while this waited.
        const record = unfinished(listed);
        const stored = record === undefined ? null : storedWrite(record.command);
        if (record === undefined || stored === null) return;
        const authorize = async () => {
          if (!mayPublish(storage, record)) throw notFound();
        };
        await replayStages({ storage, copy, authorize, nowMs: input.nowMs, signal: copy.signal,
          ...(input.current ? { current: input.current } : {}) }, record, stored);
      });
    } catch (error) {
      // The copy moved on: the next pass replays against what it pulls.
      if (error instanceof CopyBehind) return false;
      if (error instanceof RelayError || error instanceof TargetMissing || copy.signal.aborted) continue;
      input.onError(error);
      // A stage the engine refused left the write refused, which is done with; anything else stays owed.
      if (unfinished(listed) !== undefined) done = false;
    }
  }
  return done;
}
