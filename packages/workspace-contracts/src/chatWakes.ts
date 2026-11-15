import { z } from "zod";

// The wire between an owner's computers and the relay for waking a chat agent
// on the computer that runs it. The relay serves these shapes, and a computer
// checks every answer against them before it acts on one.

/** The longest a wake read waits, in ms. */
export const CHAT_WAKE_WAIT_MAX_MS = 25_000;
/** The agents one computer declares per workspace. */
export const CHAT_RUNNER_AGENTS = 64;
export const CHAT_RUNNER_INSTALL_ID_MAX_CHARS = 256;
export const CHAT_RUNNER_COMPUTER_LABEL_MAX_CHARS = 64;
export const CHAT_RUNNER_DISPLAY_NAME_MAX_CHARS = 200;
/** The most waiting wakes one read answers. */
export const CHAT_WAKE_PAGE_MAX = 100;
export const CHAT_WAKE_ID = /^wake-[0-9a-f]{32}$/u;
// A desktop agent's settings ID. A personal agent's starts with `p-` and is never a runner.
const AGENT_ID = /^(?=.{1,64}$)[a-z](?:-?[a-z0-9])*$/u;
const SEQUENCE = /^(?:0|[1-9]\d{0,15})$/u;
const CONTROL = /[\u0000-\u001f\u007f]/u;
const ID_MAX_CHARS = 1_024;

/** Trimmed, nonempty, at most `maxChars` UTF-16 code units, and free of control characters, as the relay takes a line. */
export function isChatWakeLine(value: unknown, maxChars: number): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= maxChars &&
    value === value.trim() &&
    !CONTROL.test(value)
  );
}

/** An agent ID a computer may declare: a settings ID, never a personal agent's. */
export function isChatRunnerAgentId(value: unknown): value is string {
  return typeof value === "string" && AGENT_ID.test(value) && !value.startsWith("p-");
}

const line = (maxChars: number) => z.string().refine((value) => isChatWakeLine(value, maxChars));
const Id = line(ID_MAX_CHARS);

export const ChatWakeState = z.enum([
  "held",
  "waiting",
  "claimed",
  "queued",
  "unclaimed",
  "unconfirmed",
]);
export type ChatWakeState = z.infer<typeof ChatWakeState>;

/** What of the message a candidate matched: a mentioned handle, or the shown name of the agent it answers. */
const ChatWakeMatch = z.union([
  z.strictObject({ handle: Id }),
  z.strictObject({ displayName: line(CHAT_RUNNER_DISPLAY_NAME_MAX_CHARS) }),
]);

/** A computer that may claim a wake, and what of the message it matched. */
export const ChatWakeCandidate = z.strictObject({
  installId: line(CHAT_RUNNER_INSTALL_ID_MAX_CHARS),
  agentId: z.string().refine(isChatRunnerAgentId),
  label: line(CHAT_RUNNER_COMPUTER_LABEL_MAX_CHARS),
  matched: ChatWakeMatch,
});
export type ChatWakeCandidate = z.infer<typeof ChatWakeCandidate>;

const viewShape = {
  wakeId: z.string().regex(CHAT_WAKE_ID),
  workspaceId: Id,
  messageId: Id,
  threadId: Id,
  generation: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  state: ChatWakeState,
  /** The question whose decision a computer syncs through first, for an answer. */
  prerequisiteMessageId: Id.nullable(),
  /** The winning computer's label once one claimed it. */
  winnerLabel: line(CHAT_RUNNER_COMPUTER_LABEL_MAX_CHARS).nullable(),
};

/** A wake as its account's computers see it. */
export const ChatWakeView = z.strictObject(viewShape);
export type ChatWakeView = z.infer<typeof ChatWakeView>;

/** A waiting wake for one computer, with only that computer's candidate. */
export const WaitingChatWake = z.strictObject({
  ...viewShape,
  state: z.literal("waiting"),
  candidate: ChatWakeCandidate,
});
export type WaitingChatWake = z.infer<typeof WaitingChatWake>;

/**
 * `PUT /sync/workspaces/:workspaceId/runners`. The relay derives each handle from the display name. A declaration
 * names its computer as a wake target for a lease of 3 days (the relay's CHAT_RUNNER_LEASE_MS), which every PUT
 * starts again, the same list included; a signed-in desktop sends it again about daily.
 */
export interface ChatRunnerDeclaration {
  installId: string;
  computerLabel: string;
  runners: Array<{ agentId: string; displayName: string; enabled: boolean }>;
}

export const ChatRunnersReply = z.strictObject({
  ok: z.literal(true),
  workspaceId: Id,
  installId: line(CHAT_RUNNER_INSTALL_ID_MAX_CHARS),
  runners: z.number().int().min(0).max(CHAT_RUNNER_AGENTS),
});

/** `GET /sync/wakes`. The cursor is decimal text; `since` takes it back. */
export const ChatWakePage = z.strictObject({
  ok: z.literal(true),
  cursor: z.string().regex(SEQUENCE).transform(Number).refine(Number.isSafeInteger),
  wakes: z.array(WaitingChatWake).max(CHAT_WAKE_PAGE_MAX),
});

/** `POST /sync/wakes/:wakeId/claim`. `won` is this computer's proof, never a matching label. */
export const ChatWakeClaimReply = z.strictObject({
  ok: z.literal(true),
  won: z.boolean(),
  wake: ChatWakeView,
});

/** `POST /sync/wakes/:wakeId/queued`. */
export const ChatWakeQueuedReply = z.strictObject({ ok: z.literal(true), wake: ChatWakeView });

// The phone's view of a conversation it shows, through the owner's server:
// what it can write there, who it can mention, and its messages' wakes. The
// relay serves these shapes inside its `{ ok, result, cursor }` answer, and
// the phone checks every answer against them.

/** The most mention candidates one context read answers. */
export const PHONE_MENTION_CANDIDATES_MAX = 256;
/** The messages one context read covers at most: a stream's newest items, or a page of a thread's messages. */
export const PHONE_CONTEXT_MESSAGES_MAX = 100;
/** The wakes one context read answers at most. One message's targets name at most 64 computers' agents together. */
export const PHONE_CONTEXT_WAKES_MAX = PHONE_CONTEXT_MESSAGES_MAX * 64;
/** The thread IDs one wake-changes answer lists at most. */
const PHONE_WAKE_CHANGES_MAX = 1_000;
const NAME_MAX_CHARS = 256;
// A handle as handleForName makes one: at most 200 bytes once normalized.
const Handle = z.string().min(1).max(200);
const Name = z.string().min(1).max(NAME_MAX_CHARS);
const Cursor = z.string().regex(SEQUENCE);

/**
 * Someone the phone can mention. A person comes only from the messages a context covers, and a stream's reactions to
 * them. An agent
 * runs on the account's computers, named by their labels; a personal agent reaches the workspace but no computer runs
 * it, so mentioning it wakes nothing there.
 */
export const PhoneMentionCandidate = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("person"), handle: Handle, label: Name }),
  z.strictObject({
    kind: z.literal("agent"),
    handle: Handle,
    label: Name,
    computers: z.array(line(CHAT_RUNNER_COMPUTER_LABEL_MAX_CHARS)).min(1),
  }),
  z.strictObject({ kind: z.literal("personalAgent"), handle: Handle, label: Name }),
]);
export type PhoneMentionCandidate = z.infer<typeof PhoneMentionCandidate>;

/**
 * The latest generation of one wake target of a message the phone shows. `canRetry` says a Try again would find a
 * computer now: the generation didn't start or wasn't confirmed, and another computer's lease of the agent holds. The
 * retry route still decides.
 */
export const PhoneChatWake = z.strictObject({
  wakeId: z.string().regex(CHAT_WAKE_ID),
  messageId: Id,
  threadId: Id,
  generation: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  state: ChatWakeState,
  winnerLabel: line(CHAT_RUNNER_COMPUTER_LABEL_MAX_CHARS).nullable(),
  /**
   * The current name of the wake's agent, as its computer last declared it, at this context read: the winner's, or
   * before a claim the first candidate's. A rename doesn't move the wake cursor, so it can lag until the next context
   * read. Null when no computer of the account declares that agent now, which can't tell a removed agent from a
   * withdrawn one; the phone shows "An agent". Never an earlier name, never unique to one agent, and never an input to
   * a retry or to who may do anything.
   */
  agentName: Name.nullable(),
  canRetry: z.boolean(),
});
export type PhoneChatWake = z.infer<typeof PhoneChatWake>;

const PhoneGroupKind = z.enum(["group", "dm", "agent"]);

/**
 * `POST /sync/:workspaceId/ops/chatContext` with `{ group }` or `{ threadId, before? }`, each an engine ID. A stream
 * says which of its lanes take a post or a message, and covers its newest items as the phone's stream read does. A
 * thread takes replies, names its group's kind, or null on a file, and covers its newest messages before the message
 * order `before`, or its newest ones; `nextBefore` covers the older ones, and is null once the first is covered.
 * `wakes` are of covered messages only. Whether a message's answered agent matched no computer is not part of this
 * read; it comes with an indexed lookup later. `wakeCursor` is the account's wake position when this was read, which
 * `wakeChanges` takes as `since`.
 */
export const PhoneChatContext = z.strictObject({
  ok: z.literal(true),
  conversation: z.discriminatedUnion("kind", [
    z.strictObject({
      kind: z.literal("stream"),
      groupId: Id,
      groupKind: PhoneGroupKind,
      canPost: z.boolean(),
      canSend: z.boolean(),
    }),
    z.strictObject({
      kind: z.literal("thread"),
      threadId: Id,
      groupKind: PhoneGroupKind.nullable(),
      nextBefore: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER).nullable(),
    }),
  ]),
  mentions: z.array(PhoneMentionCandidate).max(PHONE_MENTION_CANDIDATES_MAX),
  wakes: z.array(PhoneChatWake).max(PHONE_CONTEXT_WAKES_MAX),
  wakeCursor: Cursor,
});
export type PhoneChatContext = z.infer<typeof PhoneChatContext>;

/**
 * `GET /sync/:workspaceId/ops/wakeChanges?since=&hold=`: the workspace's threads whose wakes changed after `since`,
 * after waiting up to `hold` ms when none has. An empty list moves the cursor only. `replace` asks the phone to read
 * every context again: for a `since` past the head, or a change in a thread whose place the relay can't judge, which it
 * never names.
 */
export const PhoneWakeChanges = z.union([
  z.strictObject({ ok: z.literal(true), cursor: Cursor, replace: z.literal(true) }),
  z.strictObject({
    ok: z.literal(true),
    cursor: Cursor,
    threads: z.array(Id).max(PHONE_WAKE_CHANGES_MAX),
  }),
]);
export type PhoneWakeChanges = z.infer<typeof PhoneWakeChanges>;
