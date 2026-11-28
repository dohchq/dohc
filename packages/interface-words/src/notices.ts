// Words both apps show for Notices, toasts and sync status. Change them here, never in a copy.
// Strings with names or counts are functions, so no app builds a sentence from pieces.

export const noticesWords = {
  heading: "Notices",
  markAllRead: "Mark all read",
  allClear: "All clear",
  noOtherNotices: "No other notices.",
  sentToYou: "Sent to you",
  unread: "Unread",
  tryAgain: "Try again",
  open: "Open",
  openNote: "Open note",
  dismissNotice: "Dismiss notice",
  copyErrorDetails: "Copy error details",
  copyNoticeDetails: "Copy notice details",
  dismissWorkspaceError: "Dismiss workspace error",
  dismissWorkspaceNotice: "Dismiss workspace notice",
  fromSender: { person: "From a person", agent: "From an agent", automation: "From an automation" },
  unreadCount: (count: number) => `Notices, ${count} unread`,
  showMore: (count: number) => `Show ${count} more`,

  // The phone's.
  markRead: "Mark read",
  markUnread: "Mark unread",
  /** Marks a Notice from the server done: it leaves the list, everywhere the account reads it. */
  done: "Done",
  /** The toast after Done, which holds its only Undo. */
  markedDone: "Marked done",
  /** A Notice whose target the phone can't open. */
  openOnComputer: "Open on your computer",
  readFailed: "dohc could not read your notices.",
  marksFailed: "dohc could not save your changes to notices.",
  /** In a mention's row when the read that would offer Reply failed. The row keeps Open, with Try again. */
  targetReadFailed: "dohc could not read this message.",
} as const;

/**
 * The phone's reports when its own storage fails for Notices, each with Try again unless it says otherwise. `unkept`:
 * a Done or Read isn't saved, so it neither shows nor sends yet, and a close loses it. `unrecorded`: the server
 * answered a change, taking or refusing it, but the phone couldn't record that, so a close may send it again. Its words
 * hold for both answers. `unsaved`: only the phone's copy of the
 * list. `unread`: the phone couldn't read the changes it kept, so none sends yet. `held`: a Sign out that hasn't
 * finished holds this phone's storage, so Done and Read do nothing; it has no Try again.
 */
export const noticeStorageWords = {
  unkept: {
    title: "dohc could not save your changes to notices on this phone.",
    body: "They show and send once saved. Keep dohc open while it tries again.",
  },
  unrecorded: {
    title: "dohc could not finish saving your notices on this phone.",
    body: "The server answered your last changes. If dohc closes before this saves, it may send them again.",
  },
  unsaved: {
    title: "dohc could not save your notices on this phone.",
    body: "The server still has them, and dohc reads them again when it opens.",
  },
  unread: {
    title: "dohc could not read the changes to notices saved on this phone.",
    body: "None of your changes send until it can. Keep dohc open while it tries again.",
  },
  held: {
    title: "dohc could not change this notice.",
    body: "Sign out hasn't finished on this phone. Sign out again in Settings.",
  },
} as const;

export const syncStatusWords = {
  serverUnreachable: "Server unreachable",
  syncFailed: "Sync failed",
  updateToSync: "Update dohc to sync",
  serverNeedsUpdate: "Server needs an update",
} as const;

// The first sentence of each body is the desktop's; the phone adds what still works on a phone.
export const syncProblemSentence = {
  serverUnreachable: "dohc could not reach the server.",
  syncFailed: "dohc could not sync this workspace.",
  updateToSync: "This server needs a newer version of dohc. Update dohc to sync again.",
  serverNeedsUpdate:
    "This server runs an older version of dohc. Ask the person who runs it to update it.",
} as const;

/** The phone's band body for a workspace that can't sync. */
export const phoneSyncBody: Record<keyof typeof syncProblemSentence, string> = {
  serverUnreachable: `${syncProblemSentence.serverUnreachable} Messages wait on this phone and send when it answers. Pages are read-only until then.`,
  syncFailed: `${syncProblemSentence.syncFailed} Messages wait on this phone and send when sync works again. Pages are read-only until then.`,
  updateToSync: `${syncProblemSentence.updateToSync} Messages wait on this phone until then.`,
  serverNeedsUpdate: `${syncProblemSentence.serverNeedsUpdate} Messages wait on this phone until then.`,
};

/** A wake's agent: its current name, or "An agent" when no computer declares it now. Never an older name. */
const wakeAgent = (name: string | null) => name ?? "An agent";

export const chatWords = {
  /** A message written while the server can't be reached, queued on this device. */
  waitingToSend: "Waiting to send",

  // The phone's composer and the messages waiting on the phone.
  send: "Send",
  /** The send button's accessible name. */
  sendMessage: "Send message",
  newPost: "New post",
  post: "Post",
  title: "Title",
  /** The composer's placeholder, and the name of its field. */
  messageTo: (name: string) => `Message ${name}`,
  /** The @name menu above the composer when nobody the chat knows matches what follows the @. */
  noMentionMatch: "No matching people or agents",
  /** A row of that menu, for VoiceOver: the name, then what they are. */
  mentionPerson: (name: string) => `${name}, person`,
  mentionAgent: (name: string) => `${name}, agent`,
  /** A message's author while only this phone has it. */
  you: "You",
  /** A message on its way: a request may have reached the server. */
  sending: "Sending",
  /** The server has answered "pending" for a long time. It may still be saved. */
  stillSending: "Still sending",
  /** Kept on the phone, withheld: nothing sends it until Send, unless `notSentMaySendOnReopen` says otherwise. */
  notSent: "This message has not been sent.",
  /** Withheld, but the phone's storage may still hold it ready to send, as after a failed commit or Discard. */
  notSentMaySendOnReopen:
    "This message has not been sent. It may send if you close dohc and open it again.",
  /** Enqueue failed and nothing was kept: the text stays in the composer. */
  notKept: "dohc could not keep this message on your phone.",
  unlockToSend: "Unlock this phone to send messages",
  /** The read of which messages a chat takes failed, so the composer can't show. */
  lanesFailed: "dohc could not read what you can send in this chat.",
  outboxUnreadable: "dohc could not read messages waiting on this phone.",
  /** kept.db is damaged. Nothing replaces it until the person deletes it, in Messages on this phone. */
  outboxDamaged: "The file that keeps messages waiting on this phone is damaged.",
  /** Above the composer, which can't delete it, so it names where the person can. */
  outboxDamagedHere:
    "The file that keeps messages waiting on this phone is damaged. Delete it in Settings, under Messages on this phone.",
  /** Above the composer after a Sign out whose delete failed; Settings has its Try again. */
  signOutDeleteFailedHere:
    "dohc could not delete the messages waiting on this phone. Try again in Settings.",
  deleteDamagedTitle: "Delete messages waiting on this phone?",
  deleteDamagedBody:
    "Messages that haven't been sent will be lost. Messages the server has stay in their chats.",
  deleteDamagedConfirm: "Delete messages",
  /** The damaged file's delete failed: it stays, still damaged, with Try again. */
  deleteDamagedFailed: "dohc could not delete the damaged file.",
  /** A record in the outbox that can't be read: nothing of its text, chat or workspace is known. */
  unreadableMessage: "dohc could not read this message.",
  copyMessage: "Copy message",
  discard: "Discard",
  discardTitle: "Discard this message?",
  /** Discard deletes the phone's copy only. The server may already have it. */
  maySend: "It may still send.",
  discardFailed: "dohc could not discard this message.",
  /** Discard made neither the withheld record nor its delete durable. */
  discardNotKept:
    "dohc could not discard this message. It may send if you close dohc and open it again.",
  /** Settings' link to every message waiting on this phone, and that screen's title. */
  messagesOnPhone: "Messages on this phone",
  noMessagesOnPhone: "No messages are waiting on this phone.",
  /** A refused write's reason, as the relay names it, in plain words. */
  refused: (reason: string): string => {
    switch (reason) {
      case "The message it replies to wasn't sent":
        return "This message wasn't sent, because the message it replies to wasn't sent.";
      case "This workspace changed on your server":
        return "This message wasn't sent, because this workspace changed on your server.";
      case "This file changed or was replaced":
        return "This comment wasn't sent, because the file changed or was replaced.";
      case "too old":
        return "This message wasn't sent, because it waited too long.";
      // The reply may still have published: only the question's answer was lost.
      case "already answered":
        return "Another answer was chosen.";
      default:
        return "dohc could not send this message.";
    }
  },
  /** The chat a message was for is gone, or this account can't reach it. */
  missing: "This message wasn't sent, because dohc could not find its chat.",

  // Replies and reactions.
  /** A message's reply control, and a thread composer's placeholder. */
  reply: "Reply",
  /** The message a reply answers, above the composer, and the field's name while it's chosen. */
  replyTo: (name: string) => `Reply to ${name}`,
  cancelReply: "Cancel reply",
  /** Enqueue refused a reply because the outbox message it answers was refused or is gone. */
  replyParentGone: "dohc could not send this reply, because the message it replies to wasn't sent.",
  addReaction: "Add reaction",
  /** A reaction's button: a tap on one that's yours removes it. */
  reaction: (emoji: string, count: number, mine: boolean) =>
    `${mine ? `Remove ${emoji} reaction` : emoji}, ${count} ${count === 1 ? "reaction" : "reactions"}`,
  /** A reaction kept on the phone, withheld: nothing sends it until Send, unless the next word says otherwise. */
  reactionNotSent: (emoji: string) => `Your ${emoji} reaction has not been sent.`,
  /** Withheld, but the commit that would have made it sendable failed and may still stand. */
  reactionNotSentMaySendOnReopen: (emoji: string) =>
    `Your ${emoji} reaction has not been sent. It may send if you close dohc and open it again.`,
  /** The server has answered "pending" for a reaction for a long time. It may still be saved. */
  reactionStillSending: (emoji: string) => `Your ${emoji} reaction is still sending.`,
  /** The server refused a reaction, or can't find its message. */
  reactionRefused: (emoji: string) => `dohc could not change your ${emoji} reaction.`,
  /** The server saved a reaction, but a read since shows otherwise, as when another device changed it. */
  reactionUnconfirmed: (emoji: string, state: "added" | "removed") =>
    state === "added"
      ? `Your ${emoji} reaction was saved, but your server no longer shows it.`
      : `Your ${emoji} reaction was removed, but your server shows it again.`,
  /** Enqueue failed and nothing was kept. */
  reactionNotKept: "dohc could not keep this reaction on your phone.",
  discardReactionTitle: "Discard this reaction?",

  // A message's question or poll (apps/desktop/src/renderer/workbench/ChatPosts.tsx DecisionStatus).
  unanswered: "Unanswered",
  answered: "Answered",
  /** Starts a reply that answers a question without choices. */
  answer: "Answer",
  /** The field's name while its reply answers a question (AgentThreadAnswerDialog.tsx's title). */
  answerTo: (name: string) => `Answer ${name}`,
  /** The phone's: this phone's answer is on its way, and the server hasn't saved it yet. */
  answering: "Answering",
  /** The phone's: the server took another answer before this phone's, and the winning one is shown. */
  alreadyAnswered: "Already answered",
  /** The phone's: a read shows this phone's reply, and the server took another answer. */
  answerLost: "Sent your reply. Another answer was chosen.",
  /**
   * The phone's: a read since Answer shows the question answered or no longer shows it. The text stays, and Cancel reply
   * keeps it as an ordinary reply.
   */
  answerClosed: "dohc can't send this answer, because the question was answered or removed.",

  // The phone's: where each agent a message wakes stands, one line per wake (packages/workspace-contracts/src/chatWakes.ts).
  // `name` is the agent's, or null; `computer` is the computer that took the wake, or null.
  wakeWaiting: (name: string | null) => `${wakeAgent(name)} is waiting for a computer`,
  wakeStarting: (name: string | null, computer: string | null) =>
    `${wakeAgent(name)} is starting on ${computer ?? "a computer"}`,
  wakeNotStarted: (name: string | null) => `${wakeAgent(name)} didn't start`,
  /** The computer took the wake but never said the agent started. */
  wakeUnconfirmed: (name: string | null, computer: string | null) =>
    `${wakeAgent(name)} isn't confirmed on ${computer ?? "a computer"}. It may have started.`,
  /** Under a wake that didn't start or wasn't confirmed, when no other computer's lease of the agent holds. */
  wakeNoOtherComputer: "No other computer can run this agent.",
  /** A read of a conversation's wakes failed: the last lines stay, with Try again. */
  wakeReadFailed: "dohc could not read this agent's state.",
  /** Tries a wake that wasn't confirmed on another computer: the line's pill, and its alert's title and action. */
  wakeTryElsewhere: "Try on another computer",
  /** That alert's body. The agent is "an agent" mid-sentence when it has no name, as the lines' "An agent". */
  wakeRunTwice: (name: string | null, computer: string | null) =>
    `If ${computer ?? "that computer"} already started ${name ?? "an agent"}, it may run twice.`,
  /** A Try again on a wake failed or was refused: the line keeps its state, with Try again. */
  wakeRetryFailed: "dohc could not retry this agent.",
  /** The browser's: the relay refused a post whose mentions and replies would start too many agents on the account's computers. */
  wakeTooMany:
    "dohc could not send this message. It would start too many agents on your computers. Mention fewer agents.",
} as const;

// A notice's time, as the desktop's Notices show it (apps/desktop/src/renderer/relativeTime.ts, which can move here).
export function relativeTime(thenMs: number, nowMs: number = Date.now()): string {
  const minutes = Math.floor(Math.max(0, nowMs - thenMs) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return new Date(thenMs).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/** The same time for a screen reader, which reads "2m" as "2 meters": "2 minutes ago", or the full date. */
export function spokenRelativeTime(thenMs: number, nowMs: number = Date.now()): string {
  const minutes = Math.floor(Math.max(0, nowMs - thenMs) / 60_000);
  if (minutes < 1) return "just now";
  const hours = Math.floor(minutes / 60);
  if (hours >= 24)
    return new Date(thenMs).toLocaleDateString(undefined, { month: "long", day: "numeric" });
  const [count, unit] = minutes < 60 ? [minutes, "minute" as const] : [hours, "hour" as const];
  return typeof Intl.RelativeTimeFormat === "function"
    ? new Intl.RelativeTimeFormat(undefined, { numeric: "always", style: "long" }).format(
        -count,
        unit,
      )
    : `${count} ${unit}${count === 1 ? "" : "s"} ago`;
}
