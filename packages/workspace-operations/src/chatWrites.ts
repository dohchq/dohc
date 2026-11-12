import { normalizeChatMessageBody } from "@dohc/workspace-contracts/chat-message-body";
import type {
  ChatMessage,
  ChatReaction,
  ChatThread,
  ChatThreadLane,
  LinkedChatStore,
} from "@dohc/workspace-contracts/engine";
import { OperationError } from "./results";

// The chat writes every caller makes the same way: post, send, reply, answer,
// and react. A command checks what it writes and the targets it names, then
// hands the write to its host. The host binds who writes, admits them, checks
// that admission again just before each row, and runs its own effects. No
// command names its author.

export type ChatDecision = Awaited<ReturnType<LinkedChatStore["resolveChatDecision"]>>;

// The read an answer checks its question with, through what the caller may see.
export type ChatWriteReadStore = Pick<LinkedChatStore, "listThreadDecisions">;

// A message as the commands checked it.
export interface ChatMessageContent {
  body: string;
  needsDecision?: true;
  options?: string[];
}

// Ids a caller fixes so that a retried write replays instead of writing twice.
export interface ChatMessageIds {
  messageId?: string;
  idempotencyKey?: string;
}

export interface StartCommand extends ChatMessageContent, ChatMessageIds {
  channelId: string;
  lane: ChatThreadLane;
  title?: string;
  threadId?: string;
}

export interface ReplyCommand extends ChatMessageContent, ChatMessageIds {
  threadId: string;
  parentMessageId?: string;
}

export interface ResolveCommand {
  threadId: string;
  // The question or poll.
  messageId: string;
  resolvedByMessageId: string;
  chosenOption?: string;
  idempotencyKey?: string;
}

export interface ReactionCommand {
  threadId: string;
  messageId: string;
  emoji: string;
  state: "added" | "removed";
  idempotencyKey?: string;
}

// An answer's reply always stays. `lost` names the reply that answered the
// question first; `failed` says why the question stays open.
export type AnswerOutcome =
  | { state: "resolved"; message: ChatMessage; decision: ChatDecision }
  | { state: "lost"; message: ChatMessage; decision: ChatDecision; winnerMessageId: string }
  | { state: "failed"; message: ChatMessage; failure: unknown };
export type Answered = Exclude<AnswerOutcome, { state: "failed" }>;

// An answer's read of its question. The host runs it once it has admitted
// the caller and before any row, so a refused caller reads nothing.
export type TargetCheck = () => Promise<void>;

// Both stages run under the one admission the host made for the answer.
export interface AnswerStages {
  reply(): Promise<ChatMessage>;
  resolve(command: ResolveCommand): Promise<ChatDecision>;
}

export interface AnswerWithStages {
  // The caller's own reply, which the host found and checked.
  reply: ChatMessage;
  resolve(command: ResolveCommand): Promise<ChatDecision>;
}

export interface ChatWriteHost {
  workspaceId: string;
  store: ChatWriteReadStore;
  // A message the caller may see. A host whose store hides messages from some
  // callers provides it, and the commands then check that a parent or a
  // reacted message is one of them, in the named thread. Without it, the
  // engine refuses a message that isn't there.
  findMessage?(messageId: string): Promise<ChatMessage>;
  start(command: StartCommand): Promise<{ thread: ChatThread; message: ChatMessage }>;
  reply(command: ReplyCommand): Promise<ChatMessage>;
  answer(
    command: ReplyCommand,
    checkTargets: TargetCheck,
    use: (stages: AnswerStages) => Promise<AnswerOutcome>,
  ): Promise<AnswerOutcome>;
  answerWith(
    command: { threadId: string; questionId: string; replyId: string },
    use: (stages: AnswerWithStages) => Promise<Answered>,
  ): Promise<Answered>;
  react(command: ReactionCommand): Promise<ChatReaction>;
}

export interface MessageInput extends ChatMessageIds {
  body: string;
  needsDecision?: boolean;
  // A poll's choices, which imply a decision.
  options?: readonly string[];
}

export interface StartInput extends MessageInput {
  channelId: string;
  // A title names a new thread. A running conversation keeps its own.
  title?: string;
  // The thread a new post starts.
  threadId?: string;
}

export interface ReplyInput extends MessageInput {
  threadId: string;
  parentMessageId?: string;
}

export interface AnswerInput extends ReplyInput {
  resolves: { messageId: string; chosenOption?: string; idempotencyKey?: string };
  // The question as the caller already read it, so the answer reads it once.
  question?: ChatDecision;
}

export interface AnswerWithInput {
  threadId: string;
  // The question or poll.
  messageId: string;
  // The caller's reply that saved earlier.
  replyId: string;
  chosenOption?: string;
  idempotencyKey?: string;
}

export interface ReactInput {
  threadId: string;
  messageId: string;
  emoji: string;
  state: "added" | "removed";
  idempotencyKey?: string;
}

// `threadId` is the thread the engine wrote to. A running conversation takes
// the message, so it can differ from the thread the caller proposed.
export interface Started {
  threadId: string;
  thread: ChatThread;
  message: ChatMessage;
}

const MAX_POLL_OPTIONS = 12;
const MAX_POLL_OPTION_LENGTH = 200;

// The engine's rules for a message, checked before any row so a refused
// message writes nothing. The engine trims each choice as it stores it.
function checkedContent(input: MessageInput): ChatMessageContent {
  const body = normalizeChatMessageBody(input.body);
  const options = input.options ?? [];
  if (options.length > MAX_POLL_OPTIONS) throw new Error("A poll has at most twelve choices.");
  const seen = new Set<string>();
  for (const raw of options) {
    const option = raw.trim();
    if (!option || option.length > MAX_POLL_OPTION_LENGTH || /[\r\n]/u.test(option)) {
      throw new Error("Each choice is one line of at most 200 characters.");
    }
    if (seen.has(option)) throw new Error("Each choice appears once.");
    seen.add(option);
  }
  return {
    body,
    ...(input.needsDecision ? { needsDecision: true as const } : {}),
    ...(options.length > 0 ? { options: [...options] } : {}),
  };
}

function idsOf(input: ChatMessageIds): ChatMessageIds {
  return {
    ...(input.messageId ? { messageId: input.messageId } : {}),
    ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}),
  };
}

// A poll's answer names one of its choices. A bare question takes none.
function checkedChoice(options: readonly string[], chosen: string | undefined): string | undefined {
  const choice = chosen?.trim() || undefined;
  if (options.length === 0) {
    if (choice !== undefined) throw new Error("This question has no choices to pick from.");
    return undefined;
  }
  if (choice === undefined || !options.includes(choice)) throw new Error("Pick one of the poll's choices.");
  return choice;
}

async function start(host: ChatWriteHost, input: StartInput, lane: ChatThreadLane): Promise<Started> {
  const started = await host.start({
    channelId: input.channelId,
    lane,
    ...(input.title ? { title: input.title } : {}),
    ...(input.threadId ? { threadId: input.threadId } : {}),
    ...checkedContent(input),
    ...idsOf(input),
  });
  return { threadId: started.thread.id, thread: started.thread, message: started.message };
}

// Starts a post in a Group.
export async function postToGroup(host: ChatWriteHost, input: StartInput): Promise<Started> {
  return await start(host, input, "posts");
}

// Appends to a Group's chat lane or a DM, joining its running conversation
// when it has one.
export async function sendToStream(host: ChatWriteHost, input: StartInput): Promise<Started> {
  return await start(host, input, "chat");
}

function replyCommand(input: ReplyInput): ReplyCommand {
  return {
    threadId: input.threadId,
    ...(input.parentMessageId ? { parentMessageId: input.parentMessageId } : {}),
    ...checkedContent(input),
    ...idsOf(input),
  };
}

async function checkInThread(host: ChatWriteHost, messageId: string | undefined, threadId: string): Promise<void> {
  if (!messageId || !host.findMessage) return;
  if ((await host.findMessage(messageId)).threadId !== threadId) {
    throw new OperationError(`no such message in this thread: ${messageId}`);
  }
}

export async function replyInThread(host: ChatWriteHost, input: ReplyInput): Promise<ChatMessage> {
  const command = replyCommand(input);
  await checkInThread(host, input.parentMessageId, input.threadId);
  return await host.reply(command);
}

// The engine answers a resolve that another reply won with that reply's
// decision, as a success, so only the decision says who won.
export function answerOutcome(message: ChatMessage, decision: ChatDecision): AnswerOutcome {
  const winner = decision.resolvedByMessageId;
  if (winner === message.id) return { state: "resolved", message, decision };
  if (winner !== undefined) return { state: "lost", message, decision, winnerMessageId: winner };
  return { state: "failed", message, failure: new Error("The question is still open.") };
}

// A reply, then the resolve that marks its question answered. The choice is
// checked before the reply, so a refused choice writes nothing. A question
// another reply already answered is not refused: the reply stays, and the
// outcome is lost.
export async function answerDecision(host: ChatWriteHost, input: AnswerInput): Promise<AnswerOutcome> {
  const command = replyCommand(input);
  const choose = (question: ChatDecision | undefined) => {
    if (!question || question.messageId !== input.resolves.messageId || question.threadId !== input.threadId) {
      throw new OperationError(`no such question in this thread: ${input.resolves.messageId}`);
    }
    return checkedChoice(question.options ?? [], input.resolves.chosenOption);
  };
  let chosenOption = input.question ? choose(input.question) : undefined;
  await checkInThread(host, input.parentMessageId, input.threadId);
  const checkTargets = async () => {
    if (input.question) return;
    chosenOption = choose((await host.store.listThreadDecisions(host.workspaceId, input.threadId))
      .find((decision) => decision.messageId === input.resolves.messageId));
  };
  return await host.answer(command, checkTargets, async ({ reply, resolve }) => {
    const message = await reply();
    try {
      return answerOutcome(message, await resolve({
        threadId: input.threadId,
        messageId: input.resolves.messageId,
        resolvedByMessageId: message.id,
        ...(chosenOption !== undefined ? { chosenOption } : {}),
        ...(input.resolves.idempotencyKey ? { idempotencyKey: input.resolves.idempotencyKey } : {}),
      }));
    } catch (failure) {
      return { state: "failed", message, failure };
    }
  });
}

// Marks a question answered with a reply that already saved. It posts
// nothing, and the question need not be open: the winner says who answered.
export async function answerWithReply(host: ChatWriteHost, input: AnswerWithInput): Promise<Answered> {
  return await host.answerWith(
    { threadId: input.threadId, questionId: input.messageId, replyId: input.replyId },
    async ({ reply, resolve }) => {
      const outcome = answerOutcome(reply, await resolve({
        threadId: input.threadId,
        messageId: input.messageId,
        resolvedByMessageId: reply.id,
        ...(input.chosenOption !== undefined ? { chosenOption: input.chosenOption } : {}),
        ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}),
      }));
      if (outcome.state === "failed") throw outcome.failure;
      return outcome;
    },
  );
}

// Sets exactly the state asked for. A toggle is the caller's to resolve
// first, so a retry sets the same state instead of flipping it back.
export async function reactToMessage(host: ChatWriteHost, input: ReactInput): Promise<ChatReaction> {
  if (input.state !== "added" && input.state !== "removed") throw new Error("A reaction is added or removed.");
  await checkInThread(host, input.messageId, input.threadId);
  return await host.react({
    threadId: input.threadId,
    messageId: input.messageId,
    emoji: input.emoji,
    state: input.state,
    ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}),
  });
}
