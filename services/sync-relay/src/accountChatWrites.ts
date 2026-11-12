import { createHash } from "node:crypto";
import { createActorIssuer, deriveLocalActor, serializeActorKey } from "@dohc/workspace-contracts/actor-identity";
import type { ChatMessage, ChatThread, ChatThreadLane } from "@dohc/workspace-contracts/engine";
import { cutText } from "@dohc/workspace-contracts/names";
import { asRecord } from "@dohc/workspace-core";
import { ChatsLiveAdapter, type JsonValue } from "@dohc/workspace-engine-client";
import { EngineRequestError } from "@dohc/workspace-engine-client/daemon";
import {
  answerDecision, answerWithReply, checkedContent, engineTrim, postToGroup, reactToMessage, replyInThread, sendToStream,
  type ChatMessageContent, type ChatWriteHost,
} from "@dohc/workspace-operations/chat-writes";
import { failure, OperationError } from "@dohc/workspace-operations/chats";
import { serverChats, type MissingResult } from "./accountOperations";
import type { AutomationReplica } from "./automationReplicas";
import { stableJsonStringify } from "./canonicalJson";
import { badRequest, notFound, RelayError } from "./errors";
import {
  COULD_NOT_SEND, TOO_OLD, WORKSPACE_CHANGED, commandStages, isRefusalReason, publishOperation, receiptReader,
  type ExpectedRecord, type PublicationAnswer, type PublicationStage, type RefusalReason,
} from "./operationPublication";
import type { SyncRelayStorage } from "./storage";
import type { OperationRecord } from "./storage/operationRecords";

// The phone's chat writes on this server's copy of a workspace its account
// owns. The account and its name come from the session, never the request.
// Every target resolves through the reads' secret-file filter, so a hidden
// one answers exactly as a missing one, before any row. The operation's row,
// with its canonical command, is written before the engine's first stage, and
// every stage carries its derived key and asks the engine for a receipt. A
// stage that a crash or a lost answer left unwritten replays from that stored
// command, when the copy opens or the phone retries. No route calls this yet.

/** The bounds of a phone write's operation ID, in UTF-16 code units, which storage's bound in characters admits. */
export const OPERATION_ID_MIN_LENGTH = 1;
export const OPERATION_ID_MAX_LENGTH = 128;

export function isOperationId(value: unknown): value is string {
  return typeof value === "string" && value.length >= OPERATION_ID_MIN_LENGTH && value.length <= OPERATION_ID_MAX_LENGTH;
}

type MessageArgs = { body: string; needsDecision?: boolean; options?: string[] };

/** A phone write, as its strict request schema admits it. */
export type PhoneWrite =
  | { operation: "post"; args: MessageArgs & { operationId: string; groupId: string; title?: string } }
  | { operation: "send"; args: MessageArgs & { operationId: string; streamId: string } }
  | { operation: "reply"; args: MessageArgs & {
    operationId: string; threadId: string; parentMessageId?: string; resolves?: { messageId: string; chosenOption?: string };
  } }
  | { operation: "react"; args: { operationId: string; messageId: string; emoji: string; state: "added" | "removed" } };

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

/** What a write's row keeps as its command: its publication, the write, and its author. */
export type StoredWrite = { stages: PublicationStage[]; write: WriteCommand; author: AuthorSnapshot };

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

// The engine answered, and will answer again, that the request didn't happen.
function answeredNo(error: unknown): boolean {
  return error instanceof EngineRequestError && error.wireError?.retry === "no";
}

// A stage the engine refused, so it didn't commit. A reused key means an earlier attempt did.
function refusedByEngine(error: unknown): boolean {
  return answeredNo(error) && (error as EngineRequestError).wireError?.message !== "idempotency-key-reuse-mismatch";
}

const toJson = (value: unknown): JsonValue => JSON.parse(JSON.stringify(value)) as JsonValue;

function authorOf(writer: PhoneWriter, workspaceId: string): AuthorSnapshot {
  const displayName = cutText(writer.displayName?.trim() || "Unnamed", 40);
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

// What a person's message makes: the thread's structure the first time this
// copy writes in it, the message, the follow, and an open question or poll.
function messageRecords(threadId: string, messageId: string, author: AuthorSnapshot, content: ChatMessageContent): ExpectedRecord[] {
  const asks = content.needsDecision === true || (content.options?.length ?? 0) > 0;
  const question: ExpectedRecord[] = asks ? [{ kind: "chat.decision.set", fields: { threadId, messageId, state: "open" } }] : [];
  return [
    { kind: "chat.thread.create", fields: { threadId }, optional: true },
    { kind: "chat.message.append", fields: { messageId, threadId, authorKind: "human", authorUserId: author.accountId, body: content.body } },
    follow(threadId, author),
    ...question,
  ];
}

/** The records each stage of a write must publish, as the relay must hold them. */
export function publicationStages(write: WriteCommand, author: AuthorSnapshot, key: (role: Role) => string): PublicationStage[] {
  switch (write.kind) {
    case "start":
      return [{ key: key("post"), role: "post", engineThread: write.threadId, records: messageRecords(write.threadId, write.messageId, author, write) }];
    case "reply":
      return [{ key: key("reply"), role: "reply", records: messageRecords(write.threadId, write.messageId, author, write) }];
    case "answer":
      return [
        { key: key("reply"), role: "reply", records: messageRecords(write.threadId, write.messageId, author, write) },
        { key: key("decision"), role: "decision", records: [{ kind: "chat.decision.set", fields: {
          threadId: write.threadId, messageId: write.questionId, state: "resolved", resolvedByMessageId: write.messageId,
        } }] },
      ];
    case "react": {
      const records: ExpectedRecord[] = [{ kind: "chat.reaction.set", fields: {
        threadId: write.threadId, messageId: write.messageId, emoji: write.emoji.trim().normalize("NFC"),
        authorId: author.accountId, state: write.state,
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
  return { stages, write: value as WriteCommand, author: { accountId, displayName, actorKey: typeof actorKey === "string" ? actorKey : null } };
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
 * such a thread. A hidden one answers exactly as a missing one.
 */
function visibleTargets(storage: SyncRelayStorage, copy: AutomationReplica) {
  const { workspaceId } = copy;
  const chats = serverChats(storage, copy, workspaceId);
  const adapter = new ChatsLiveAdapter(copy.client, copy.workspace, { workspaceId });
  const visible = async (threadId: string): Promise<ChatThread | undefined> =>
    (await chats.store.listThreads({ workspaceId })).find((each) => each.id === threadId);
  const rawMessage = (messageId: string) => adapter.getMessage({ workspaceId, messageId }).catch((error: unknown) => {
    if (answeredNo(error)) return null;
    throw error;
  });
  return {
    async thread(threadId: string): Promise<ChatThread> {
      const found = await visible(threadId);
      if (found === undefined) throw threadMissing(threadId);
      return found;
    },
    async message(messageId: string): Promise<ChatMessage> {
      const found = await rawMessage(messageId);
      if (found === null || (await visible(found.threadId)) === undefined) throw messageMissing(messageId);
      return found;
    },
    // A post goes to a Group's posts; a send to a Group's chat or a DM.
    async channel(channelId: string, lane: ChatThreadLane): Promise<void> {
      const found = (await chats.store.listChannels({ workspaceId })).find((each) => each.id === channelId);
      if (found === undefined) throw groupMissing(channelId);
      const fits = lane === "posts" ? found.kind === "channel" && found.type !== "chat" : found.kind !== "channel" || found.type !== "posts";
      if (!fits) throw new WriteInvalid(lane === "posts" ? "This group takes no posts." : "This group has no chat.");
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
 * Runs one engine stage of a recorded write. A stage the engine refused
 * didn't commit; when no stage of the write committed either, nothing of it
 * can ever publish, so the write is refused now instead of waiting.
 */
async function runStage<T>(storage: SyncRelayStorage, record: OperationRecord, progress: { committed: boolean }, nowMs: () => number,
  run: () => Promise<T>): Promise<T> {
  try {
    const result = await run();
    progress.committed = true;
    return result;
  } catch (error) {
    if (!progress.committed && refusedByEngine(error)) {
      storage.advanceAccountOperation({
        accountId: record.accountId, operationId: record.operationId, stage: "refused",
        result: { threadId: null, reason: COULD_NOT_SEND }, nowMs: nowMs(),
      });
    }
    throw error;
  }
}

interface WriteContext {
  storage: SyncRelayStorage;
  copy: AutomationReplica;
  /** Checks the caller's access again. It throws notFound() for any loss of it. */
  authorize(): Promise<void>;
  nowMs(): number;
  signal?: AbortSignal;
}

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

  async function stage<T>(run: () => Promise<T>): Promise<T> {
    const row = (session.record ??= record());
    await context.authorize();
    return await runStage(storage, row, session, nowMs, run);
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
      const started = await stage(() => writeStart(adapter, workspaceId, stored, write));
      progress({ threadId: started.thread.id });
      return started;
    },
    async reply(command) {
      if (write.kind !== "reply" || command.threadId !== write.threadId) throw mismatched();
      await context.authorize();
      await targets.thread(write.threadId);
      await targets.unclaimed({ messageId: write.messageId });
      const message = await stage(() => writeReply(adapter, workspaceId, stored, write));
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
          const message = await stage(() => writeReply(adapter, workspaceId, stored, write));
          written = message;
          progress({ stage: "reply-written", threadId: message.threadId });
          return message;
        },
        resolve: async (resolve) => {
          const reply: ChatMessage | null = written;
          if (reply === null || reply.id !== write.messageId || reply.threadId !== write.threadId || resolve.messageId !== write.questionId) {
            throw mismatched();
          }
          const decision = await stage(() => writeResolve(adapter, workspaceId, stored, write, { threadId: write.threadId, messageId: reply.id }));
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
          const decision = await stage(() => writeResolve(adapter, workspaceId, stored, write, { threadId: write.threadId, messageId: reply.id }));
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
      return await stage(() => writeReaction(adapter, workspaceId, stored, write));
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
  if (keys.every((key) => present.has(key))) return;
  const adapter = new ChatsLiveAdapter(copy.client, copy.workspace, { workspaceId });
  const targets = visibleTargets(storage, copy);
  const progress = { committed: present.size > 0 };
  const { write } = stored;
  const absent = (role: Role) => !present.has(stageKey(stored, role));
  const stage = async <T>(run: () => Promise<T>): Promise<T> => {
    await context.authorize();
    if (write.kind !== "start") await targets.thread(write.threadId);
    return await runStage(storage, record, progress, nowMs, run);
  };
  switch (write.kind) {
    case "start":
      if (absent("post")) {
        const started = await stage(() => writeStart(adapter, workspaceId, stored, write));
        advance(storage, record, nowMs(), { threadId: started.thread.id });
      }
      return;
    case "reply":
      if (absent("reply")) {
        const message = await stage(() => writeReply(adapter, workspaceId, stored, write));
        advance(storage, record, nowMs(), { threadId: message.threadId });
      }
      return;
    case "answer":
      if (absent("reply")) {
        const message = await stage(() => writeReply(adapter, workspaceId, stored, write));
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
      if (absent("reaction")) await stage(() => writeReaction(adapter, workspaceId, stored, write));
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
 * settled, are refused and write nothing. Access is checked before the row,
 * before each engine stage, and before the answer. Throws the route's
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
  return await withOperationLock(writer.accountId, operationId, async () => {
    await input.authorize();
    await copy.sync(signal);
    await input.authorize();
    const found = storage.lookupAccountOperation({ accountId: writer.accountId, operationId, binding });
    if (found.kind === "mismatch") return await answered(refused(COULD_NOT_SEND));
    if (found.kind === "too-old") return await answered(refused(TOO_OLD));
    let record: OperationRecord;
    if (found.kind === "found") {
      record = found.record;
      const stored = storedWrite(record.command);
      const unfinished = record.stage !== "saved" && record.stage !== "refused";
      if (stored !== null && unfinished && record.incarnation === copy.incarnation) {
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
        stored = { stages: publicationStages(command, author, ids.key), write: command, author };
      } catch (error) {
        return await answered(refusalBeforeRecord(error, signal));
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
        if (session.record === null) return await answered(refusalBeforeRecord(error, signal));
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
    const stored = storedWrite(record.command);
    return await answered(phoneAnswer(published, stored === null || stored.write.kind === "react" ? undefined : stored.write.messageId));
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
 * When a copy opens, at startup too, replays each unfinished write's stages
 * that never committed, from its stored command, while its account may still
 * publish it. A write that can't replay now stays as it is, and is reported
 * unless it lost its access or its target.
 */
export async function replayUnfinishedWrites(input: {
  storage: SyncRelayStorage;
  copy: AutomationReplica;
  records: readonly OperationRecord[];
  nowMs(): number;
  onError(error: unknown): void;
}): Promise<void> {
  const { storage, copy } = input;
  for (const listed of input.records) {
    // A request working on the write now finishes it itself; the copy's open doesn't wait for it.
    if (listed.incarnation !== copy.incarnation || storedWrite(listed.command) === null ||
      operationLocks.has(lockKey(listed.accountId, listed.operationId))) continue;
    try {
      await withOperationLock(listed.accountId, listed.operationId, async () => {
        // A request may have finished it while this waited.
        const record = storage.listUnfinishedAccountOperations({ workspaceId: copy.workspaceId, incarnation: copy.incarnation })
          .find((each) => each.accountId === listed.accountId && each.operationId === listed.operationId);
        const stored = record === undefined ? null : storedWrite(record.command);
        if (record === undefined || stored === null) return;
        const authorize = async () => {
          if (!mayPublish(storage, record)) throw notFound();
        };
        await replayStages({ storage, copy, authorize, nowMs: input.nowMs, signal: copy.signal }, record, stored);
      });
    } catch (error) {
      if (error instanceof RelayError || error instanceof TargetMissing || copy.signal.aborted) continue;
      input.onError(error);
    }
  }
}
