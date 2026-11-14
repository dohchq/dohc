import { emojiKey, type OutboxState } from "../server/outbox";
import type { ChatReaction } from "../server/workspaceReads";
import { reactionWaits, type OutboxRecord } from "./conversationWrites";
import { localMark, localState, type OutboxScope } from "./outboxMessages";
import type { Message, Reaction, ReactionMark } from "./types";

// A message's reactions as the phone shows them: the server's, with this phone's own reactions over them in the order
// they were made. Each reaction the phone keeps says the state it should end in, so the latest one for an emoji wins,
// and a repeated tap is never a toggle on the wire. A refused one, or one whose message is gone, changes nothing, so
// the server's state shows again, and it stays listed with what can be done.

/** The server's reactions to a message, one per emoji in the order first given, with the account's own marked. */
export function confirmedReactions(
  reactions: readonly ChatReaction[],
  accountId: string,
): Reaction[] {
  const byEmoji = new Map<string, { count: number; mine: boolean }>();
  for (const reaction of reactions) {
    const emoji = emojiKey(reaction.emoji);
    const entry = byEmoji.get(emoji) ?? { count: 0, mine: false };
    byEmoji.set(emoji, {
      count: entry.count + 1,
      mine: entry.mine || (reaction.authorKind === "human" && reaction.authorId === accountId),
    });
  }
  return [...byEmoji].map(([emoji, { count, mine }]) => ({
    emoji,
    count,
    ...(mine ? { mine } : {}),
  }));
}

/** The account's reactions in one workspace that the outbox keeps, by message, each oldest first. */
export function reactionRecords(
  state: OutboxState,
  scope: OutboxScope & { readonly workspaceId: string },
): ReadonlyMap<string, readonly OutboxRecord[]> {
  const byMessage = new Map<string, OutboxRecord[]>();
  for (const record of state.records) {
    if (
      record.origin !== scope.origin ||
      record.accountId !== scope.accountId ||
      record.workspaceId !== scope.workspaceId ||
      record.write.operation !== "react"
    )
      continue;
    const { messageId } = record.write.args;
    byMessage.set(messageId, [...(byMessage.get(messageId) ?? []), record]);
  }
  return byMessage;
}

export interface MessageReactions {
  readonly reactions: readonly Reaction[];
  /** Reactions that need the person: withheld, refused, or missing. */
  readonly marks: readonly ReactionMark[];
  /** A reaction isn't settled, so the message takes no other yet. */
  readonly busy: boolean;
}

/**
 * The server's reactions with `records`, this phone's reactions to the same message, over them. A reaction the server
 * saved still counts until a read shows it, when the outbox hands it off, so the count never jumps back meanwhile.
 * Other people's reactions always count: only the account's own one changes.
 */
export function withLocalReactions(
  confirmed: readonly Reaction[],
  records: readonly OutboxRecord[],
  messageId: string,
): MessageReactions {
  const latest = new Map<string, { readonly mine: boolean; readonly pending: boolean }>();
  const marks: ReactionMark[] = [];
  for (const record of records) {
    if (record.write.operation !== "react" || record.write.args.messageId !== messageId) continue;
    const emoji = emojiKey(record.write.args.emoji);
    const state = localState(record);
    if (state.kind === "refused" || state.kind === "missing" || state.kind === "withheld")
      marks.push({ emoji, mark: localMark(record) });
    if (state.kind === "refused" || state.kind === "missing") continue;
    latest.set(emoji, {
      mine: record.write.args.state === "added",
      pending: state.kind !== "saved",
    });
  }
  const reactions: Reaction[] = [];
  const seen = new Set<string>();
  const shown = (emoji: string, others: number, local: { mine: boolean; pending: boolean }) => {
    const count = others + (local.mine ? 1 : 0);
    if (count > 0)
      reactions.push({
        emoji,
        count,
        ...(local.mine ? { mine: true } : {}),
        ...(local.pending ? { pending: true } : {}),
      });
  };
  for (const reaction of confirmed) {
    const emoji = emojiKey(reaction.emoji);
    seen.add(emoji);
    const local = latest.get(emoji);
    if (local) shown(emoji, reaction.count - (reaction.mine ? 1 : 0), local);
    else reactions.push(reaction);
  }
  for (const [emoji, local] of latest) if (!seen.has(emoji)) shown(emoji, 0, local);
  return {
    reactions,
    marks,
    busy: records.some((record) => reactionWaits(record, messageId)),
  };
}

/** `message` with `confirmed`, the server's reactions to it, and this phone's `records` over them. */
export function withReactions(
  message: Message,
  confirmed: readonly Reaction[],
  records: readonly OutboxRecord[] = [],
): Message {
  const shown = withLocalReactions(confirmed, records, message.id);
  return {
    ...message,
    reactions: shown.reactions,
    ...(shown.marks.length > 0 ? { reactionMarks: shown.marks } : {}),
    ...(shown.busy ? { reactionsBusy: true } : {}),
  };
}

/** The state a tap on `emoji` asks for: removed when the account's reaction shows, else added. */
export function nextReaction(
  reactions: readonly Reaction[] | undefined,
  emoji: string,
): "added" | "removed" {
  const key = emojiKey(emoji);
  return reactions?.some((reaction) => emojiKey(reaction.emoji) === key && reaction.mine)
    ? "removed"
    : "added";
}
