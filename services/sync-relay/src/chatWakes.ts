import { chatMentionTokens, normalizeHandle } from "@dohc/workspace-contracts/chat-mentions";
import type { ChatWakeCandidate } from "@dohc/workspace-contracts/chat-wakes";
import type { ChatMessage, ChatThread, ChatThreadLane } from "@dohc/workspace-contracts/engine";
import { shownName } from "@dohc/workspace-contracts/names";
import { asRecord } from "@dohc/workspace-core";
import type { JsonValue } from "@dohc/workspace-engine-client";
import type { Verdict } from "./operationPublication";
import type { SyncRelayStorage } from "./storage";
import type { ChatRunner, ChatWakeTarget, OperationWakeChange } from "./storage/chatWakes";

// The wake targets of a person's phone message. They are resolved once,
// before the write's first engine stage, from the account's declared
// computers, and frozen in the operation's command; a replay never resolves
// them again. Publication turns them into wake rows in the transaction that
// records the message published. The owner's browser post resolves them the
// same way, from the relay's log, and its append writes the rows.

/** The targets a message wakes, as its operation keeps them. `unmatched`: an agent it answers matched no computer, or several. */
export type FrozenWakes = { targets: ChatWakeTarget[]; unmatched: boolean };

const NO_WAKES: FrozenWakes = { targets: [], unmatched: false };
/** The most candidates one message's targets list, all together. A message past it isn't sent. */
export const MAX_WAKE_CANDIDATES = 64;

/** A message would wake more computers' agents than MAX_WAKE_CANDIDATES. */
export class TooManyWakeCandidates extends Error {
  constructor() {
    super(`A message wakes at most ${MAX_WAKE_CANDIDATES} agents on the account's computers.`);
    this.name = "TooManyWakeCandidates";
  }
}

/** What resolution reads of a message. */
type WakeMessage = Pick<ChatMessage, "author" | "authorUserId" | "authorAgentId">;

/** What resolution reads, through the reads' secret-file filter. A hidden thread or message is null, as a missing one. */
export interface WakeSources {
  /** The account's enabled agents on its computers in the workspace. */
  runners: readonly ChatRunner[];
  message(messageId: string): Promise<WakeMessage | null>;
  thread(threadId: string): Promise<Pick<ChatThread, "channelId" | "lane"> | null>;
  /** A visible thread's first message. */
  opening(threadId: string): Promise<WakeMessage | null>;
  /** The agent of an agent's DM, or null for any other channel. */
  dmAgent(channelId: string): Promise<string | null>;
  /** The newest message `pick` keeps in the channel's threads, replies included, within a bounded read. */
  latest(channelId: string, pick: (message: WakeMessage) => boolean): Promise<DmSource>;
}

/** A DM's newest source, when the bounded read covered every message; otherwise no source at all. */
export type DmSource = { complete: true; message: WakeMessage | null } | { complete: false };

/** What resolution reads of a write. A phone write's command is one. */
export type WakeWrite =
  | { kind: "react" }
  | { kind: "start"; body: string; lane: ChatThreadLane; channelId: string }
  | { kind: "reply"; body: string; threadId: string; parentMessageId?: string }
  | {
      kind: "answer";
      body: string;
      threadId: string;
      parentMessageId?: string;
      questionId: string;
    };

type AgentMessage = WakeMessage & { authorAgentId: string };

// Only the account's own agent's message names an agent to wake. A participant's or a personal agent's never does.
const accountAgent =
  (accountId: string) =>
  (message: WakeMessage | null | undefined): message is AgentMessage =>
    message?.author.kind === "agent" &&
    message.authorUserId === accountId &&
    typeof message.authorAgentId === "string" &&
    message.authorAgentId !== "";

// The agent messages a write answers: its DM's agent, the parent it replies under or else the post or file thread's
// opening, and the question it answers. A Group's running conversation has no opening that answers. `unread`: the
// DM's bounded read couldn't cover every message, so its agent is unknown, even if one of its messages was seen.
async function answeredMessages(
  sources: WakeSources,
  accountId: string,
  write: Exclude<WakeWrite, { kind: "react" }>,
): Promise<{ messages: AgentMessage[]; unread: boolean }> {
  const ours = accountAgent(accountId);
  const found: Array<WakeMessage | null | undefined> = [];
  let unread = false;
  const dm = async (channelId: string) => {
    const agentId = await sources.dmAgent(channelId);
    if (agentId === null) return;
    const source = await sources.latest(
      channelId,
      (message) => ours(message) && message.authorAgentId === agentId,
    );
    if (source.complete) found.push(source.message);
    else unread = true;
  };
  if (write.kind === "start") {
    if (write.lane === "chat") await dm(write.channelId);
    return { messages: found.filter(ours), unread };
  }
  const thread = await sources.thread(write.threadId);
  if (thread === null) return { messages: [], unread };
  if (thread.channelId !== undefined) await dm(thread.channelId);
  const parent =
    write.parentMessageId === undefined ? null : await sources.message(write.parentMessageId);
  if (ours(parent)) found.push(parent);
  else if (thread.lane !== "chat") found.push(await sources.opening(write.threadId));
  if (write.kind === "answer") found.push(await sources.message(write.questionId));
  return { messages: found.filter(ours), unread };
}

const candidateOf = (
  runner: ChatRunner,
  matched: ChatWakeCandidate["matched"],
): ChatWakeCandidate => ({
  installId: runner.installId,
  agentId: runner.agentId,
  label: runner.computerLabel,
  matched,
});
const pair = (candidate: ChatWakeCandidate) =>
  JSON.stringify([candidate.installId, candidate.agentId]);
// An agent across computers: its local ID alone can name another agent elsewhere, so its shown name goes with it.
const agentKey = (agentId: string, displayName: string) =>
  JSON.stringify([agentId, shownName(displayName)]);

/**
 * A write's wake targets. Each handle the body mentions that enabled agents
 * have is one target, with every computer whose agent has it as a candidate,
 * or only those whose agent remembers earlier chats when any does.
 * An agent the write answers is a target only when exactly one enabled agent
 * matches its ID and name, or exactly one of them remembers; one a mention
 * matched, or a repeat, adds nothing. A DM the bounded read couldn't cover freezes no implicit target and
 * is unmatched. A reaction, or an account with no
 * enabled agents, wakes nothing.
 * Throws TooManyWakeCandidates past MAX_WAKE_CANDIDATES, rather than wake some.
 */
export async function resolveWakeTargets(
  sources: WakeSources,
  accountId: string,
  write: WakeWrite,
): Promise<FrozenWakes> {
  const runners = sources.runners.filter((runner) => runner.enabled);
  if (write.kind === "react" || runners.length === 0) return NO_WAKES;
  const mentions: ChatWakeTarget[] = [];
  const mentionedAgents = new Set<string>();
  const mentioned = new Set<string>();
  for (const handle of new Set(
    chatMentionTokens(write.body).map((token) => normalizeHandle(token.handle)),
  )) {
    const matching = runners.filter((runner) => runner.handle !== "" && runner.handle === handle);
    for (const runner of matching) {
      mentionedAgents.add(agentKey(runner.agentId, runner.displayName));
      mentioned.add(pair(candidateOf(runner, { handle })));
    }
    const remembering = matching.filter((runner) => runner.memory);
    if (matching.length > 0)
      mentions.push({
        target: `mention:${handle}`,
        candidates: (remembering.length > 0 ? remembering : matching).map((runner) =>
          candidateOf(runner, { handle }),
        ),
      });
  }
  const implicit = new Map<string, ChatWakeTarget>();
  const answered = await answeredMessages(sources, accountId, write);
  // A DM too long for the bounded read wakes no implicit agent, even one it saw, and the message is still sent: the
  // phone offers the mention hint, as for an agent that matched no computer. Refusing would make long DMs unusable.
  let unmatched = answered.unread;
  for (const message of answered.messages) {
    const name = shownName(message.author.displayName);
    const matches = runners.filter(
      (runner) =>
        runner.agentId === message.authorAgentId && shownName(runner.displayName) === name,
    );
    const remembering = matches.filter((each) => each.memory);
    const [runner] = matches.length === 1 ? matches : remembering;
    if ((matches.length !== 1 && remembering.length !== 1) || runner === undefined) {
      if (!mentionedAgents.has(agentKey(message.authorAgentId, message.author.displayName)))
        unmatched = true;
      continue;
    }
    const candidate = candidateOf(runner, { displayName: runner.displayName });
    const target = `implicit:${runner.installId}:${runner.agentId}`;
    if (!mentioned.has(pair(candidate))) implicit.set(target, { target, candidates: [candidate] });
  }
  const targets = [...mentions, ...implicit.values()];
  if (targets.reduce((total, target) => total + target.candidates.length, 0) > MAX_WAKE_CANDIDATES)
    throw new TooManyWakeCandidates();
  return { targets, unmatched };
}

/**
 * What resolution reads for the owner's browser post in `threadId`, from the
 * relay's log. A browser reaches only Groups and file Comments, never a DM,
 * and a message counts only from that thread, as one of the owner's computers
 * wrote it.
 */
export function browserWakeSources(
  storage: Pick<
    SyncRelayStorage,
    "enabledChatRunners" | "findThreadFirstMessageId" | "ownerComputerMessage"
  >,
  post: {
    accountId: string;
    workspaceId: string;
    threadId: string;
    lane: ChatThreadLane;
    nowMs: number;
  },
): WakeSources {
  const { workspaceId, threadId } = post;
  const message = async (messageId: string) =>
    storage.ownerComputerMessage(workspaceId, threadId, messageId);
  return {
    runners: storage.enabledChatRunners(post),
    message,
    thread: async () => ({ lane: post.lane }),
    opening: async () => {
      const first = storage.findThreadFirstMessageId(workspaceId, threadId);
      return first === undefined ? null : message(first);
    },
    dmAgent: async () => null,
    latest: async () => ({ complete: true, message: null }),
  };
}

/** The wakes an operation's command froze. A command without them wakes nothing. */
export function frozenWakes(command: JsonValue): FrozenWakes {
  const wakes = asRecord(asRecord(command)?.wakes);
  const targets = wakes?.targets;
  if (!Array.isArray(targets)) return NO_WAKES;
  // This module wrote them; a target without candidates would make no row.
  const kept = (targets as unknown[]).filter((each): each is ChatWakeTarget => {
    const target = asRecord(each);
    return (
      typeof target?.target === "string" &&
      Array.isArray(target.candidates) &&
      target.candidates.length > 0
    );
  });
  return { targets: kept, unmatched: wakes?.unmatched === true };
}

/**
 * What a verdict does to its operation's wakes: once the message is
 * published, each frozen target becomes a row, held for an answer. Once an
 * answer's decision has an outcome, its rows are released: through the
 * question's decision when the answer was saved, without it when the
 * decision was lost or the write refused.
 */
export function operationWakeChange(
  command: JsonValue,
  verdict: Verdict,
): OperationWakeChange | undefined {
  const { targets } = frozenWakes(command);
  const write = asRecord(asRecord(command)?.write);
  const messageId = write?.messageId,
    questionId = write?.questionId;
  if (targets.length === 0 || typeof messageId !== "string") return undefined;
  const answer = write?.kind === "answer";
  const threadId = verdict.stage === "pending" ? verdict.threadId : verdict.result.threadId;
  return {
    ...(verdict.messagePublished && threadId !== null
      ? { publish: { messageId, threadId, held: answer, targets } }
      : {}),
    ...(answer && verdict.stage !== "pending"
      ? {
          release: {
            prerequisite:
              verdict.stage === "saved" && typeof questionId === "string" ? questionId : null,
          },
        }
      : {}),
  };
}

/** Ends expired wakes and deletes long-ended ones, a batch at a time, yielding between batches. Answers how many rows changed. */
export async function sweepChatWakesInBatches(
  storage: Pick<SyncRelayStorage, "sweepChatWakes">,
  nowMs: number,
  pause: () => Promise<void> = () => new Promise((resolve) => setImmediate(resolve)),
): Promise<number> {
  let total = 0;
  for (;;) {
    const changed = storage.sweepChatWakes(nowMs);
    total += changed;
    if (changed === 0) return total;
    await pause();
  }
}
