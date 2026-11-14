import type { OutboxState } from "../server/outbox";
import type { OutboxRecord } from "./conversationWrites";
import type { LocalMark, LocalState } from "./types";

// The outbox's records as the phone shows them: in the conversation they were written to, until a read shows the
// message, and in Messages on this phone, for every record of the signed-in account. Only the account's own records
// show, by its server and account, and in a conversation only its workspace's and its stream's.

/** Whose records show. */
export interface OutboxScope {
  readonly origin: string;
  readonly accountId: string;
}

/** A post or message only this phone has, in the stream it was written to. */
export interface LocalRow {
  /** The message the write makes, as the server will name it. */
  readonly messageId: string;
  readonly lane: "posts" | "chat";
  readonly title?: string;
  readonly mark: LocalMark;
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
});

/**
 * The account's posts and messages to one stream that its reads don't show yet, oldest first. `shown` holds the IDs of
 * the messages the stream's read shows: a record whose message is among them is the server's row now, even before the
 * outbox hands it off, so the message never shows twice.
 */
export function streamRows(
  state: OutboxState,
  scope: OutboxScope & { readonly workspaceId: string },
  streamId: string,
  shown: ReadonlySet<string>,
): LocalRow[] {
  return state.records.flatMap((record): LocalRow[] => {
    if (!owned(record, scope) || record.workspaceId !== scope.workspaceId) return [];
    const { write } = record;
    const lane =
      write.operation === "send" && write.args.streamId === streamId
        ? "chat"
        : write.operation === "post" && write.args.groupId === streamId
          ? "posts"
          : null;
    const messageId = messageOf(record);
    if (lane === null || messageId === null || shown.has(messageId)) return [];
    return [
      {
        messageId,
        lane,
        ...(write.operation === "post" && write.args.title ? { title: write.args.title } : {}),
        mark: localMark(record),
      },
    ];
  });
}

/** A record in Messages on this phone, with the stream it was written to when it names one. */
export interface RecoveryRow {
  readonly workspaceId: string;
  readonly streamId: string | null;
  readonly mark: LocalMark;
}

/**
 * Every record of the account that isn't saved, in any workspace, and the handles of records that can't be read, whose
 * account, workspace and text can't be known. A saved record waits only for a read to show it, so it isn't listed.
 */
export function recoveryRows(
  state: OutboxState,
  scope: OutboxScope,
): { readonly rows: readonly RecoveryRow[]; readonly unreadable: readonly string[] } {
  const rows = state.records.flatMap((record): RecoveryRow[] => {
    if (!owned(record, scope) || record.stage === "saved") return [];
    const { write } = record;
    const streamId =
      write.operation === "send"
        ? write.args.streamId
        : write.operation === "post"
          ? write.args.groupId
          : null;
    return [{ workspaceId: record.workspaceId, streamId, mark: localMark(record) }];
  });
  return { rows, unreadable: state.unreadable };
}
