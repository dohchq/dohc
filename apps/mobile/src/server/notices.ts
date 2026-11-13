import {
  isNoticeBody,
  isNoticeLine,
  isNoticeTarget,
  NOTICE_ID_MAX_CHARS,
  NOTICE_KINDS,
  NOTICE_SENDER_LABEL_MAX_CHARS,
  NOTICE_TITLE_MAX_CHARS,
  type NoticeKind,
  type NoticeMark,
  type NoticeSenderKind,
  type NoticeTarget,
} from "@dohc/workspace-contracts/relay";
import { isFields, okAnswer, text } from "./api";
import { REQUEST_TIMEOUT_MS, type ServerClient } from "./client";

// The account's Notices as the phone reads and marks them (services/sync-relay/src/noticeRoutes.ts). Every request
// carries `scope=phone`, so the relay leaves out what the phone may not show. That is a display scope, not an access
// boundary. A page is checked whole before any of it is used.

/** Rows per page. The relay allows up to 200. */
export const NOTICE_PAGE_LIMIT = 100;

/** A live Notice, holding only what the phone shows or needs to act on. */
export interface NoticeRecord {
  readonly noticeId: string;
  readonly changeSeq: number;
  /** Exactly one of these is set: the workspace, or the share the account reads it through. */
  readonly workspaceId: string | null;
  readonly recipientShareId: string | null;
  readonly kind: NoticeKind;
  readonly senderKind: NoticeSenderKind;
  readonly senderLabel: string;
  readonly title: string;
  readonly body: string;
  readonly target: NoticeTarget | null;
  readonly createdAtMs: number;
  readonly readAtMs: number | null;
  readonly dismissedAtMs: number | null;
  readonly expiresAtMs: number;
}

/**
 * One change on a page. A removed row, or one of a kind this build doesn't know, keeps only its ID and sequence: it
 * deletes the row the phone holds and is never shown.
 */
export type NoticeChange =
  | { readonly gone: false; readonly record: NoticeRecord }
  | { readonly gone: true; readonly noticeId: string; readonly changeSeq: number };

export interface NoticePage {
  readonly changes: readonly NoticeChange[];
  /** Opaque: passed back as `cursor`. */
  readonly nextCursor: string;
  readonly hasMore: boolean;
  /** The page starts the whole list over. */
  readonly replace: boolean;
}

const sequence = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const time = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);
const timeOrNull = (value: unknown): value is number | null => value === null || time(value);
const idOrNull = (value: unknown): value is string | null =>
  value === null || isNoticeLine(value, NOTICE_ID_MAX_CHARS);
const isKind = (value: unknown): value is NoticeKind =>
  typeof value === "string" && Object.hasOwn(NOTICE_KINDS, value);
const isSenderKind = (value: unknown): value is NoticeSenderKind =>
  value === "person" || value === "agent" || value === "automation";
const isLabel = (value: unknown): value is string =>
  typeof value === "string" &&
  !/[\u0000-\u001f\u007f]/u.test(value) &&
  [...value].length <= NOTICE_SENDER_LABEL_MAX_CHARS;

/** A live Notice as the relay sends it, or as the phone saved it; null for anything else. */
export function noticeRecord(item: unknown): NoticeRecord | null {
  if (
    !isFields(item) ||
    !isNoticeLine(item.noticeId, NOTICE_ID_MAX_CHARS) ||
    !sequence(item.changeSeq) ||
    !idOrNull(item.workspaceId) ||
    !idOrNull(item.recipientShareId) ||
    (item.workspaceId === null) === (item.recipientShareId === null) ||
    !isKind(item.kind) ||
    !isSenderKind(item.senderKind) ||
    !isLabel(item.senderLabel) ||
    !isNoticeLine(item.title, NOTICE_TITLE_MAX_CHARS) ||
    !isNoticeBody(item.body) ||
    (item.target !== null && !isNoticeTarget(item.target)) ||
    !time(item.createdAtMs) ||
    !timeOrNull(item.readAtMs) ||
    !timeOrNull(item.dismissedAtMs) ||
    !time(item.expiresAtMs)
  )
    return null;
  return {
    noticeId: item.noticeId,
    changeSeq: item.changeSeq,
    workspaceId: item.workspaceId,
    recipientShareId: item.recipientShareId,
    kind: item.kind,
    senderKind: item.senderKind,
    senderLabel: item.senderLabel,
    title: item.title,
    body: item.body,
    target: item.target,
    createdAtMs: item.createdAtMs,
    readAtMs: item.readAtMs,
    dismissedAtMs: item.dismissedAtMs,
    expiresAtMs: item.expiresAtMs,
  };
}

function noticeChange(item: unknown): NoticeChange | null {
  if (
    !isFields(item) ||
    typeof item.removed !== "boolean" ||
    !isNoticeLine(item.noticeId, NOTICE_ID_MAX_CHARS) ||
    !sequence(item.changeSeq)
  )
    return null;
  // A removed row keeps its ID and sequence only; its other fields never leave this function.
  if (item.removed || !isKind(item.kind))
    return { gone: true, noticeId: item.noticeId, changeSeq: item.changeSeq };
  const record = noticeRecord(item);
  return record && { gone: false, record };
}

export function noticePage(body: unknown): NoticePage | null {
  const answer = okAnswer(body);
  if (
    !answer ||
    !Array.isArray(answer.notices) ||
    !text(answer.nextCursor, 64) ||
    typeof answer.hasMore !== "boolean" ||
    typeof answer.replace !== "boolean"
  )
    return null;
  const changes: NoticeChange[] = [];
  for (const item of answer.notices) {
    const change = noticeChange(item);
    if (!change) return null;
    changes.push(change);
  }
  return {
    changes,
    nextCursor: answer.nextCursor,
    hasMore: answer.hasMore,
    replace: answer.replace,
  };
}

/**
 * Reads the page after `cursor`, or the whole list's first page without one. With `waitMs`, a caught-up read is held
 * that long for the next change, so the request waits that much longer before it counts as offline.
 */
export function readNotices(
  client: ServerClient,
  request: { readonly cursor: string | null; readonly waitMs: number },
  signal: AbortSignal,
): Promise<NoticePage> {
  const query = [
    "scope=phone",
    `limit=${NOTICE_PAGE_LIMIT}`,
    ...(request.cursor === null ? [] : [`cursor=${encodeURIComponent(request.cursor)}`]),
    ...(request.waitMs > 0 ? [`wait=${request.waitMs}`] : []),
  ].join("&");
  return client.send("GET", `/sync/notices?${query}`, noticePage, undefined, {
    signal,
    timeoutMs: request.waitMs + REQUEST_TIMEOUT_MS,
  });
}

/** Sends marks, at most NOTICE_MARKS_PER_REQUEST. The answer's first-dismissal list starts nothing on the phone. */
export function sendNoticeMarks(
  client: ServerClient,
  marks: readonly { readonly noticeId: string; readonly mark: NoticeMark }[],
  signal: AbortSignal,
): Promise<true> {
  return client.send(
    "POST",
    "/sync/notices/marks?scope=phone",
    (body) => (Array.isArray(okAnswer(body)?.dismissed) ? true : null),
    { marks: marks.map(({ noticeId, mark }) => ({ noticeId, mark })) },
    { signal },
  );
}
