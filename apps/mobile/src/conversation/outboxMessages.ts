import { emojiKey, type OutboxState } from "../server/outbox";
import type { OutboxRecord } from "./conversationWrites";
import type { LocalMark, LocalState, ReactionMark } from "./types";

// The outbox's records as the phone shows them: in the conversation they were written to, until a read shows the
// message, and in Messages on this phone, for every record of the signed-in account. Only the account's own records
// show, by its server and account, and in a conversation only its workspace's and its stream's.

/** Whose records show. */
export interface OutboxScope {
  readonly origin: string;
  readonly accountId: string;
}

/**
 * A post, message or reply only this phone has, where it was written. `reply`: in a thread, or in a stream under the
 * outbox post or send it waits for.
 */
export interface LocalRow {
  /** The message the write makes, as the server will name it. */
  readonly messageId: string;
  readonly lane: "posts" | "chat" | "reply";
  readonly title?: string;
  readonly mark: LocalMark;
  /** A post or send a reply can wait for: neither refused nor missing. */
  readonly replyable: boolean;
  /** The thread a saved write's result names, where a reply to it goes, or null while none is known. */
  readonly threadId: string | null;
}

const owned = (record: OutboxRecord, scope: OutboxScope) =>
  record.origin === scope.origin && record.accountId === scope.accountId;

/** The message a record makes: the one the server named when it saved it, or the one derived from its operation. */
const messageOf = (record: OutboxRecord) =>
  record.result?.kind === "saved" && record.result.messageId !== null
    ? record.result.messageId
    : record.messageId;

/** Where a record stands, as its row shows it. A settled stage wins over withheld: Discard withholds before it deletes. */
export function localState(record: OutboxRecord): LocalState {
  if (record.result?.kind === "missing") return { kind: "missing" };
  if (record.result?.kind === "refused") return { kind: "refused", reason: record.result.reason };
  if (record.stage === "saved") return { kind: "saved" };
  if (record.withheld) return { kind: "withheld" };
  if (record.stage === "stalled") return { kind: "stalled" };
  if (record.stage === "sending") return { kind: "sending" };
  return { kind: "waiting" };
}

const bodyOf = (record: OutboxRecord) =>
  record.write.operation === "react" ? record.write.args.emoji : record.write.args.body;

export const localMark = (record: OutboxRecord): LocalMark => ({
  operationId: record.operationId,
  state: localState(record),
  attempted: record.attempted,
  body: bodyOf(record),
  ...(record.withheld && record.maySendOnReopen ? { maySendOnReopen: true } : {}),
});

/**
 * What a message only this phone has offers under it. A withheld one has Send and Discard; without `sendable`, as for
 * an answer whose Notice's workspace no longer shows on the phone, only Discard. One still sending for a long time,
 * refused, or whose chat is gone has Copy and Discard; none is sent again as another message. With `discardsPending`,
 * as in a Notice's row, one waiting or sending has Discard too, so an answer for a workspace the phone can no longer
 * open can always be taken back.
 */
export function localOffers(
  mark: LocalMark,
  options: { readonly sendable: boolean; readonly discardsPending: boolean },
): { readonly send: boolean; readonly copy: boolean; readonly discard: boolean } {
  const { state } = mark;
  const copy = state.kind === "stalled" || state.kind === "refused" || state.kind === "missing";
  const pending = options.discardsPending && (state.kind === "waiting" || state.kind === "sending");
  return {
    send: state.kind === "withheld" && options.sendable,
    copy,
    discard: state.kind === "withheld" || copy || pending,
  };
}

/** A settled message won't send. One a request may have reached, unsettled, may still send after Discard. */
export const maySend = (mark: LocalMark) =>
  mark.attempted &&
  (mark.state.kind === "sending" ||
    mark.state.kind === "stalled" ||
    mark.state.kind === "withheld");

/** The row of a record whose message a read doesn't show yet, or null. */
function row(
  record: OutboxRecord,
  lane: LocalRow["lane"],
  shown: ReadonlySet<string>,
): LocalRow | null {
  const messageId = messageOf(record);
  if (messageId === null || shown.has(messageId)) return null;
  const { write } = record;
  const mark = localMark(record);
  return {
    messageId,
    lane,
    ...(write.operation === "post" && write.args.title ? { title: write.args.title } : {}),
    mark,
    replyable:
      (write.operation === "post" || write.operation === "send") &&
      mark.state.kind !== "refused" &&
      mark.state.kind !== "missing",
    threadId: record.result?.kind === "saved" ? record.result.threadId : null,
  };
}

const here = (record: OutboxRecord, scope: OutboxScope & { readonly workspaceId: string }) =>
  owned(record, scope) && record.workspaceId === scope.workspaceId;

/**
 * The account's posts and messages to one stream that its reads don't show yet, oldest first, each followed by the
 * replies that wait for it to name its thread. `shown` holds the IDs of the messages the stream's read shows: a record
 * whose message is among them is the server's row now, even before the outbox hands it off, so the message never
 * shows twice. A reply moves to its thread once the outbox gives it one.
 *
 * An answer to one of the stream's `questions` shows too, saved or not, until a read shows its reply and the outbox
 * hands it off. A stream's read holds no replies, so its saved receipt alone never takes the row away.
 */
export function streamRows(
  state: OutboxState,
  scope: OutboxScope & { readonly workspaceId: string },
  streamId: string,
  shown: ReadonlySet<string>,
  questions: ReadonlySet<string> = new Set(),
): LocalRow[] {
  const parents = new Set<string>();
  return state.records.flatMap((record): LocalRow[] => {
    if (!here(record, scope)) return [];
    const { write } = record;
    if (
      (write.operation === "send" && write.args.streamId === streamId) ||
      (write.operation === "post" && write.args.groupId === streamId)
    ) {
      parents.add(record.operationId);
      const local = row(record, write.operation === "send" ? "chat" : "posts", shown);
      return local ? [local] : [];
    }
    // Records are in sequence order, so a reply comes after the post or send it waits for.
    if (
      write.operation === "reply" &&
      write.args.threadId === null &&
      record.dependsOn !== null &&
      parents.has(record.dependsOn)
    ) {
      const local = row(record, "reply", shown);
      return local ? [local] : [];
    }
    if (
      write.operation === "reply" &&
      write.args.resolves !== undefined &&
      questions.has(write.args.resolves.messageId)
    ) {
      const local = row(record, "reply", shown);
      return local ? [local] : [];
    }
    return [];
  });
}

/** The account's replies in one thread that its read doesn't show yet, oldest first. */
export function threadRows(
  state: OutboxState,
  scope: OutboxScope & { readonly workspaceId: string },
  threadId: string,
  shown: ReadonlySet<string>,
): LocalRow[] {
  return state.records.flatMap((record): LocalRow[] => {
    if (
      !here(record, scope) ||
      record.write.operation !== "reply" ||
      record.write.args.threadId !== threadId
    )
      return [];
    const local = row(record, "reply", shown);
    return local ? [local] : [];
  });
}

export function fileCommentRows(
  state: OutboxState,
  scope: OutboxScope & { readonly workspaceId: string },
  path: string,
  expectedObjectId: string | null,
  shownThreadIds: ReadonlySet<string>,
): LocalRow[] {
  return state.records.flatMap((record): LocalRow[] => {
    if (!here(record, scope) || record.write.operation !== "comment") return [];
    if (
      expectedObjectId !== null
        ? record.write.args.expectedObjectId !== expectedObjectId
        : record.write.args.path !== path
    )
      return [];
    const savedThread = record.result?.kind === "saved" ? record.result.threadId : null;
    if (savedThread !== null && shownThreadIds.has(savedThread)) return [];
    const local = row(record, "posts", new Set());
    return local ? [local] : [];
  });
}

/**
 * A record in Messages on this phone, with the stream it was written to when it names one, or for a reply or a
 * reaction, the thread it waits in once that's known.
 */
export interface RecoveryRow {
  readonly workspaceId: string;
  readonly streamId: string | null;
  readonly threadId: string | null;
  readonly filePath?: string | null;
  readonly mark: LocalMark;
  /** A saved reaction that a read since shows otherwise, shown with what it asks for and Discard. */
  readonly reaction?: ReactionMark;
}

/**
 * Every record of the account that isn't saved, and every saved reaction a read since shows otherwise, in any
 * workspace, with the handles of records that can't be read, whose account, workspace and text can't be known. Any
 * other saved record waits only for a read to show it, so it isn't listed.
 */
export function recoveryRows(
  state: OutboxState,
  scope: OutboxScope,
): { readonly rows: readonly RecoveryRow[]; readonly unreadable: readonly string[] } {
  const rows = state.records.flatMap((record): RecoveryRow[] => {
    if (!owned(record, scope)) return [];
    const { write } = record;
    const doubted =
      write.operation === "react" &&
      record.stage === "saved" &&
      state.unconfirmed.includes(record.operationId);
    if (record.stage === "saved" && !doubted) return [];
    const streamId =
      write.operation === "send"
        ? write.args.streamId
        : write.operation === "post"
          ? write.args.groupId
          : null;
    const threadId =
      streamId === null && record.target?.kind === "thread" ? record.target.id : null;
    const filePath = write.operation === "comment" ? write.args.path : null;
    const mark = localMark(record);
    return [
      {
        workspaceId: record.workspaceId,
        streamId,
        threadId,
        ...(filePath ? { filePath } : {}),
        mark,
        ...(doubted && write.operation === "react"
          ? { reaction: { emoji: emojiKey(write.args.emoji), state: write.args.state, mark } }
          : {}),
      },
    ];
  });
  return { rows, unreadable: state.unreadable };
}
