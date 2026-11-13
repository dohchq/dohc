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
  return typeof value === "string" && value.length > 0 && value.length <= maxChars && value === value.trim() && !CONTROL.test(value);
}

/** An agent ID a computer may declare: a settings ID, never a personal agent's. */
export function isChatRunnerAgentId(value: unknown): value is string {
  return typeof value === "string" && AGENT_ID.test(value) && !value.startsWith("p-");
}

const line = (maxChars: number) => z.string().refine((value) => isChatWakeLine(value, maxChars));
const Id = line(ID_MAX_CHARS);

export const ChatWakeState = z.enum(["held", "waiting", "claimed", "queued", "unclaimed", "unconfirmed"]);
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
export const WaitingChatWake = z.strictObject({ ...viewShape, state: z.literal("waiting"), candidate: ChatWakeCandidate });
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
export const ChatWakeClaimReply = z.strictObject({ ok: z.literal(true), won: z.boolean(), wake: ChatWakeView });

/** `POST /sync/wakes/:wakeId/queued`. */
export const ChatWakeQueuedReply = z.strictObject({ ok: z.literal(true), wake: ChatWakeView });
