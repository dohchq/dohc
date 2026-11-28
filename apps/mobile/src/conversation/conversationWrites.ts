import type { ClearRequest, FieldChange } from "../../modules/chat-composer";
import type { ChatWrite } from "../server/chatWrites";
import { OutboxError, type DiscardTarget, type Outbox, type OutboxState } from "../server/outbox";
import { isWritableJoinedGroup, type GroupChatAccess } from "../server/phoneWrites";
import type { OutboxScope } from "./outboxMessages";

// What a conversation's write controls do, apart from how they look. The outbox is the only thing that keeps or sends a
// write: this checks the gate, makes the write the route takes, keeps one attempt of each kind from running twice, and
// says what the screen should do with its text once the outbox answers. A screen whose account or workspace changed
// asks the outbox nothing, and does nothing with an answer that comes after the change.

/** What a conversation's controls need of the outbox. The sample build gives one that keeps its records in memory. */
export type WriteOutbox = Pick<
  Outbox,
  "state" | "subscribe" | "enqueue" | "retryEnqueue" | "discard" | "wake"
>;

export type OutboxRecord = OutboxState["records"][number];

/** Which writes a stream takes: a New post action, and the chat composer. */
export interface Lanes {
  readonly post: boolean;
  readonly send: boolean;
}

export const JOINED_GROUP_LANES: Lanes = { post: true, send: false };

export function groupForStream<
  Group extends { readonly id: string; readonly channelWireId?: string },
>(groups: readonly Group[] | null | undefined, id: string): Group | null {
  return groups?.find((group) => group.id === id || group.channelWireId === id) ?? null;
}

export function writableJoinedThread(
  groups:
    | readonly (GroupChatAccess & { readonly threadIds: readonly string[] })[]
    | null
    | undefined,
  threadId: string,
): boolean {
  return isWritableJoinedGroup(groups?.find((each) => each.threadIds.includes(threadId)));
}

/** The lanes the server says a stream takes. A DM or an agent's chat never offers New post. */
export function lanesOf(context: {
  readonly groupKind: "group" | "dm" | "agent";
  readonly canPost: boolean;
  readonly canSend: boolean;
}): Lanes {
  return { post: context.groupKind === "group" && context.canPost, send: context.canSend };
}

/**
 * Why the composer can't send now, or null when it can. `off`: phone writes are off in this build. `deleting`: a Sign
 * out's delete failed, so nothing is added. `loading`, `locked`, `failed` and `damaged` are the outbox reading its
 * records.
 */
export type Blocked = "off" | "deleting" | "loading" | "locked" | "failed" | "damaged" | null;

export function blockedBy(state: OutboxState, enabled: boolean): Blocked {
  if (!enabled) return "off";
  if (state.deletion !== "none") return "deleting";
  return state.status === "ready" ? null : state.status;
}

/** Where a new message goes: the chat's conversation, or a new post in a Group. Both name the engine channel. */
export type Destination =
  | { readonly kind: "send"; readonly streamId: string }
  | { readonly kind: "post"; readonly groupId: string };

/** The write for a message, or null when the body has only spaces. A blank title is left out. */
export function chatWrite(destination: Destination, body: string, title = ""): ChatWrite | null {
  if (body.trim() === "") return null;
  if (destination.kind === "send")
    return { operation: "send", args: { streamId: destination.streamId, body } };
  const trimmed = title.trim();
  return {
    operation: "post",
    args: { groupId: destination.groupId, body, ...(trimmed === "" ? {} : { title: trimmed }) },
  };
}

/**
 * The message a reply answers. `thread`: a message the server has, in its thread; without a parent the reply goes at
 * the top of the thread. `outbox`: a post or send still in this phone's outbox, whose thread isn't known yet.
 */
export type ReplyTarget =
  | { readonly kind: "thread"; readonly threadId: string; readonly parentMessageId: string | null }
  | { readonly kind: "outbox"; readonly operationId: string; readonly messageId: string };

/** A reply's write and, for one to an outbox post or send, the record it waits for. */
export interface Reply {
  readonly write: ChatWrite;
  readonly dependsOn?: string;
}

/**
 * The reply to `target`, or null when the body has only spaces. One to an outbox post or send names no thread: the
 * outbox gives it the thread that write's result names.
 */
export function replyWrite(target: ReplyTarget, body: string): Reply | null {
  if (body.trim() === "") return null;
  if (target.kind === "outbox")
    return {
      write: {
        operation: "reply",
        args: { threadId: null, body, parentMessageId: target.messageId },
      },
      dependsOn: target.operationId,
    };
  return {
    write: {
      operation: "reply",
      args: {
        threadId: target.threadId,
        body,
        ...(target.parentMessageId === null ? {} : { parentMessageId: target.parentMessageId }),
      },
    },
  };
}

/**
 * The message a thread opens chosen to reply to or answer: the route's `reply` or `answer`, only when the route's
 * `workspace` is the one open. A route that names no workspace, or another, chooses nothing, so the phone never builds
 * a write meant for another.
 */
export function routeReply(
  reply: string | undefined,
  workspace: string | undefined,
  openWorkspaceId: string | null,
): string | null {
  return reply !== undefined && workspace !== undefined && workspace === openWorkspaceId
    ? reply
    : null;
}

/**
 * Where a thread's composer replies, given the message chosen to reply to and the messages a read shows: under that
 * message, at the thread's top when none is chosen, or null when a message is chosen and the read doesn't show it. Null
 * keeps Send off, so a reply to a message that's gone never goes to the thread's top.
 */
export function threadReplyTarget(
  threadId: string,
  chosen: string | null,
  shown: readonly { readonly id: string }[],
): Extract<ReplyTarget, { kind: "thread" }> | null {
  if (chosen === null) return { kind: "thread", threadId, parentMessageId: null };
  return shown.some((message) => message.id === chosen)
    ? { kind: "thread", threadId, parentMessageId: chosen }
    : null;
}

/**
 * What the composer holds: the body, a post's title, and whether New post is chosen. Each has a revision that every
 * edit raises, so an edit away and back still counts as an edit. The body's is the native field's.
 */
export interface Draft {
  readonly text: string;
  readonly textRevision: number;
  readonly title: string;
  readonly titleRevision: number;
  readonly chosen: "send" | "post";
  readonly chosenRevision: number;
}

export const EMPTY_DRAFT: Draft = {
  text: "",
  textRevision: 0,
  title: "",
  titleRevision: 0,
  chosen: "send",
  chosenRevision: 0,
};

/**
 * The draft once the outbox keeps `sent`: the title clears if nobody edited it since. The native field clears the body
 * itself, only if nobody edited it since, and New post closes once it has (`closePost`).
 */
export function clearSent(current: Draft, sent: Draft): Draft {
  return current.titleRevision === sent.titleRevision ? { ...current, title: "" } : current;
}

/**
 * The draft once the native field cleared the body of `sent`. New post closes only when its title and choice weren't
 * edited meanwhile either, so a post being written during the enqueue stays a post.
 */
export function closePost(current: Draft, sent: Draft): Draft {
  return current.titleRevision === sent.titleRevision &&
    current.chosenRevision === sent.chosenRevision
    ? { ...current, chosen: "send" }
    : current;
}

/**
 * Where the native field is with `request`, for the body at `textRevision`, given the token it last `refused`. `waiting`:
 * it owes an answer, so a body sent again can't replace the request whose clear closes New post. `refused`: it kept the
 * body the outbox kept, unchanged, as with text still being composed, so Send stays off for that body until an edit.
 * `settled`: it cleared, or the body changed since. Token 0 asks nothing.
 */
export function clearStatus(
  request: ClearRequest,
  textRevision: number,
  refused: number,
): "waiting" | "refused" | "settled" {
  if (request.token === 0 || textRevision > request.revision) return "settled";
  return refused === request.token ? "refused" : "waiting";
}

/**
 * Whether `change` is the field's clear for `request`: it cleared the body the outbox kept. An edit, a refusal, or a
 * clear for an earlier request isn't.
 */
export const clearedBy = (change: FieldChange, request: ClearRequest) =>
  change.cleared !== 0 && change.cleared === request.token;

/**
 * The draft once the field reports `change`. Only its clear for `request` closes New post, by `closePost`, and only
 * when `sent` is a post or message: a reply's clear, null here, leaves New post as it was.
 */
export function fieldChanged(
  current: Draft,
  change: FieldChange,
  request: ClearRequest,
  sent: Draft | null,
): Draft {
  const typed = { ...current, text: change.text, textRevision: change.revision };
  return sent !== null && clearedBy(change, request) ? closePost(typed, sent) : typed;
}

/** One showing of a workspace store and chat. Showing the same ones again is another activation. */
export interface WriteActivation {
  readonly store: object;
  readonly target: string;
}

/**
 * The activation a screen shows, which its write controllers check before each step. A controller made for another
 * activation, an ended one even when its store and chat return, or one kept past the screen's close, asks nothing.
 */
export function createWriteScope() {
  let shown: WriteActivation | null = null;
  return {
    /** Shows `activation` until the function returned, or the next `show`. */
    show(activation: WriteActivation): () => void {
      shown = activation;
      return () => {
        if (shown === activation) shown = null;
      };
    },
    shows: (activation: WriteActivation) => shown === activation,
  };
}

/**
 * What became of a submit. `kept`: the outbox keeps it, so the composer clears the text it sent. `withheld`: the outbox
 * may keep it, withheld under `operationId`, and its row offers Send, so the composer clears that text too and never
 * sends it again as another message. `not-kept`: nothing was kept, so the text stays, and Try again submits it.
 * `blocked`: nothing was asked, or the outbox wasn't open. `stale`: the account or workspace changed meanwhile.
 * `parent-gone`: a reply's outbox post or send was refused or is gone, so it can't wait for it; the text stays.
 */
export type SubmitOutcome =
  | { readonly kind: "kept" }
  | { readonly kind: "withheld"; readonly operationId: string }
  | { readonly kind: "not-kept" }
  | { readonly kind: "parent-gone" }
  | { readonly kind: "blocked" }
  | { readonly kind: "stale" };

/** Why the composer's last submit kept nothing. `parent-gone` holds the reply it was for, as the composer named it. */
export type SubmitFailure =
  | { readonly kind: "not-kept" }
  | { readonly kind: "parent-gone"; readonly replyTo: object | null };

/**
 * Whether Send stays off because `replyTo`, the reply the composer names now, is the one whose post or send can't take
 * it. Its text never goes anywhere else until the person cancels Reply or chooses another message.
 */
export const replyParentGone = (failure: SubmitFailure | null, replyTo: object | null) =>
  replyTo !== null && failure?.kind === "parent-gone" && failure.replyTo === replyTo;

/**
 * A reaction to `messageId` the outbox hasn't settled: waiting, withheld, sending or still sending. While one is, the
 * message takes no other, so a stalled reaction is never sent again as another, and taps never pile up.
 */
export const reactionWaits = (record: OutboxRecord, messageId: string) =>
  record.write.operation === "react" &&
  record.write.args.messageId === messageId &&
  (record.stage === "queued" || record.stage === "sending" || record.stage === "stalled");

/** What became of a reaction, as a submit, without text to keep. */
export type ReactOutcome = {
  readonly kind: "kept" | "withheld" | "not-kept" | "blocked" | "stale";
};

/** The message a reaction is on: one the server has, in its thread. */
export interface ReactionTarget {
  readonly messageId: string;
  readonly threadId: string;
}

/** `not-kept`: the record stays withheld, and Send stays to try again. */
export type RetryOutcome = { readonly kind: "kept" | "not-kept" | "blocked" | "stale" };

/** `may-send`: neither the withheld record nor its delete is durable, so a relaunch may send it. */
export type DiscardOutcome = {
  readonly kind: "discarded" | "failed" | "may-send" | "blocked" | "stale";
};

export interface ConversationWrites {
  /** Keeps a write. A reply to an outbox post or send names that record in `dependsOn`. */
  submit(workspaceId: string, write: ChatWrite, dependsOn?: string): Promise<SubmitOutcome>;
  /**
   * Adds or removes the account's reaction in `scope`'s workspace, as the state it should end in, never a toggle. One at
   * a time per message: a second while the first is being kept, or while the account's last isn't settled, does nothing.
   */
  react(
    scope: OutboxScope & { readonly workspaceId: string },
    target: ReactionTarget,
    emoji: string,
    state: "added" | "removed",
  ): Promise<ReactOutcome>;
  /** Sends a withheld record as its own operation, with the body it keeps. */
  retry(operationId: string): Promise<RetryOutcome>;
  /** Deletes a record, or a record that can't be read, from this phone. */
  discard(target: DiscardTarget): Promise<DiscardOutcome>;
}

/**
 * `enabled` is the build's gate: off, nothing reaches the outbox. `isCurrent` says whether the screen's account and
 * workspace are still the ones it asked for.
 */
export function createConversationWrites(options: {
  readonly outbox: WriteOutbox | null;
  readonly enabled: boolean;
  readonly isCurrent: () => boolean;
}): ConversationWrites {
  const { outbox, enabled, isCurrent } = options;
  // One submit at a time, and one Send or Discard at a time per record, so a second tap does nothing.
  const running = new Set<string>();
  // Checked when the action runs, so Discard's confirmation answered after a workspace change asks nothing.
  async function once<T>(
    key: string,
    run: (outbox: WriteOutbox) => Promise<T>,
  ): Promise<T | { readonly kind: "blocked" } | { readonly kind: "stale" }> {
    if (!enabled || !outbox || running.has(key) || blockedBy(outbox.state(), enabled) !== null)
      return { kind: "blocked" };
    if (!isCurrent()) return { kind: "stale" };
    running.add(key);
    try {
      return await run(outbox);
    } finally {
      running.delete(key);
    }
  }

  return {
    submit: (workspaceId, write, dependsOn) =>
      once<SubmitOutcome>("submit", async (box) => {
        try {
          await box.enqueue({
            workspaceId,
            write,
            ...(dependsOn === undefined ? {} : { dependsOn }),
          });
          return isCurrent() ? { kind: "kept" } : { kind: "stale" };
        } catch (error) {
          if (!isCurrent()) return { kind: "stale" };
          if (error instanceof OutboxError && error.kind === "indeterminate" && error.operationId)
            return { kind: "withheld", operationId: error.operationId };
          if (error instanceof OutboxError && error.kind === "closed") return { kind: "blocked" };
          // The outbox checks a waiting reply's post or send as it keeps it: refused or gone, it refuses the reply.
          if (error instanceof OutboxError && error.kind === "invalid" && dependsOn !== undefined)
            return { kind: "parent-gone" };
          return { kind: "not-kept" };
        }
      }),

    react: (scope, target, emoji, state) =>
      once<ReactOutcome>(`react:${target.messageId}`, async (box) => {
        // Only the account's own reactions in this workspace hold it: another account's may name the same message ID.
        const waits = box
          .state()
          .records.some(
            (record) =>
              record.origin === scope.origin &&
              record.accountId === scope.accountId &&
              record.workspaceId === scope.workspaceId &&
              reactionWaits(record, target.messageId),
          );
        if (waits) return { kind: "blocked" };
        try {
          await box.enqueue({
            workspaceId: scope.workspaceId,
            write: { operation: "react", args: { messageId: target.messageId, emoji, state } },
            thread: target.threadId,
          });
          return { kind: isCurrent() ? "kept" : "stale" };
        } catch (error) {
          if (!isCurrent()) return { kind: "stale" };
          if (error instanceof OutboxError && error.kind === "indeterminate" && error.operationId)
            return { kind: "withheld" };
          if (error instanceof OutboxError && error.kind === "closed") return { kind: "blocked" };
          return { kind: "not-kept" };
        }
      }),

    retry: (operationId) =>
      once<RetryOutcome>(`record:${operationId}`, async (box) => {
        try {
          await box.retryEnqueue(operationId);
          return { kind: isCurrent() ? "kept" : "stale" };
        } catch (error) {
          if (!isCurrent()) return { kind: "stale" };
          if (error instanceof OutboxError && (error.kind === "closed" || error.kind === "invalid"))
            return { kind: "blocked" };
          return { kind: "not-kept" };
        }
      }),

    discard: (target) =>
      once<DiscardOutcome>(
        target.kind === "record" ? `record:${target.operationId}` : `unreadable:${target.handle}`,
        async (box) => {
          try {
            await box.discard(target);
            return { kind: isCurrent() ? "discarded" : "stale" };
          } catch (error) {
            if (!isCurrent()) return { kind: "stale" };
            if (error instanceof OutboxError && error.kind === "withheld-in-memory")
              return { kind: "may-send" };
            if (error instanceof OutboxError && error.kind === "closed") return { kind: "blocked" };
            return { kind: "failed" };
          }
        },
      ),
  };
}
