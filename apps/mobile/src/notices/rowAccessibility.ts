import {
  chatWords,
  noticesWords,
  relativeTime,
  spokenRelativeTime,
} from "@dohc/interface-words/notices";
import { wakeWords } from "../conversation/chatWakeState";
import { decisionWord } from "../conversation/decisionAnswers";
import { needsPerson } from "./noticeAnswers";
import type { PhoneNotice } from "./phoneNotice";

/** A notice's arrival time from how long ago it came, in the desktop's words: "2m ago". */
export const shortAgo = (minutes: number, nowMs = Date.now()) =>
  relativeTime(nowMs - minutes * 60_000, nowMs);
/** The same in full for VoiceOver: "2 minutes ago". */
export const spokenAgo = (minutes: number, nowMs = Date.now()) =>
  spokenRelativeTime(nowMs - minutes * 60_000, nowMs);

/** How long ago the notice arrived, in whole minutes. */
export const ageMinutes = (notice: PhoneNotice, nowMs = Date.now()) =>
  notice.atMs === undefined
    ? notice.minutesAgo
    : Math.max(0, Math.floor((nowMs - notice.atMs) / 60_000));

/** What Copy puts on the clipboard, as the desktop copies a notice's details. */
export const noticeDetails = (notice: PhoneNotice) =>
  [notice.title, notice.body].filter(Boolean).join("\n");

export interface RowHandlers {
  /** Open, Open note, Reply, or Answer. */
  open?(): void;
  retry?(): void;
  /** Try again on a failed read of a mention's message. */
  retryTarget?(): void;
  /** Marks a Notice from the server read, or unread. */
  setRead?(read: boolean): void;
  copy(): void;
  dismiss(): void;
}

/** Whether the row offers Mark read or Mark unread: a Notice from the server can take them. */
export const marksRead = (notice: PhoneNotice) =>
  notice.relayId !== undefined && notice.dismissible;

/** Whether swiping the row right marks it unread: only a read Notice from the server. */
export const swipesUnread = (notice: PhoneNotice) => marksRead(notice) && notice.read;

/** The row's × and swipe left: Done for a Notice from the server, Dismiss for a failure held on this phone. */
export const dismissLabel = (notice: PhoneNotice) =>
  notice.relayId === undefined ? noticesWords.dismissNotice : noticesWords.done;

/** What the row says of its answer's wakes, in order: each line and its note, then a failed read. */
const answerWakes = (notice: PhoneNotice) => {
  const wakes = notice.answer?.wakes;
  return wakes ? wakeWords(wakes.wakes, wakes.failed) : [];
};

/** Try again on a failed read of the answer's wakes, while the row shows their last lines. */
const wakeRetry = (notice: PhoneNotice) => {
  const wakes = notice.answer?.wakes;
  return wakes?.failed && answerWakes(notice).length > 0 ? wakes.retry : undefined;
};

/** The press handler behind each action a row offers: its pill or icon, and its rotor action, share it. */
export function noticeRowHandlers(
  notice: PhoneNotice,
  handlers: RowHandlers,
): Partial<Record<string, () => void>> {
  const { setRead } = handlers;
  return {
    worded: notice.retry ? handlers.retry : notice.open ? handlers.open : undefined,
    retryTarget: notice.retryTarget ? handlers.retryTarget : undefined,
    retryWakes: wakeRetry(notice),
    read: marksRead(notice) && setRead ? () => setRead(!notice.read) : undefined,
    copy: handlers.copy,
    dismiss: notice.dismissible ? handlers.dismiss : undefined,
  };
}

/** What the row's corner says: when it arrived, its workspace when not the open one, and where it opens. */
export function noticeMeta(notice: PhoneNotice, time: string): string {
  return [time, notice.folder, notice.elsewhere ? noticesWords.openOnComputer : undefined]
    .filter(Boolean)
    .join(" · ");
}

/** The row's worded action, on its pill and first in the rotor: Try again, Open, Open note, Reply or Answer. */
export function wordedLabel(notice: PhoneNotice): string | null {
  if (notice.retry) return noticesWords.tryAgain;
  switch (notice.open) {
    case "openNote":
      return noticesWords.openNote;
    case "reply":
      return chatWords.reply;
    case "answer":
      return chatWords.answer;
    case "open":
      return noticesWords.open;
    default:
      return null;
  }
}

/**
 * Whether the row is a group whose controls VoiceOver reaches one by one, not one element: while its answer is open,
 * or while this phone keeps an answer to its question that isn't saved, with Discard, and Send or Copy. It then has no
 * Done and no swipe.
 */
export const isExpanded = (notice: PhoneNotice) =>
  notice.answer !== undefined &&
  (notice.answer.editing !== null || notice.answer.marks.some(needsPerson));

/** The question's status a row shows, as its card says it, or null when the row shows none. */
export const answerStatus = (notice: PhoneNotice) =>
  notice.answer ? decisionWord(notice.answer.decision) : null;

/**
 * What VoiceOver hears for a row, and its actions in rotor order: the worded action, Try again when the read that
 * would offer Reply failed, Try again when the read of its answer's wakes failed, Mark read or Mark unread, Copy, then
 * Done, or Dismiss for a failure held on this phone.
 */
export function noticeRowAccessibility(notice: PhoneNotice): {
  label: string;
  actions: { name: string; label: string }[];
} {
  const worded = wordedLabel(notice);
  const actions = [
    ...(worded ? [{ name: "worded", label: worded }] : []),
    ...(notice.retryTarget ? [{ name: "retryTarget", label: noticesWords.tryAgain }] : []),
    ...(wakeRetry(notice) ? [{ name: "retryWakes", label: noticesWords.tryAgain }] : []),
    ...(marksRead(notice)
      ? [{ name: "read", label: notice.read ? noticesWords.markUnread : noticesWords.markRead }]
      : []),
    {
      name: "copy",
      label: notice.failed ? noticesWords.copyErrorDetails : noticesWords.copyNoticeDetails,
    },
    ...(notice.dismissible ? [{ name: "dismiss", label: dismissLabel(notice) }] : []),
  ];
  const time = spokenAgo(ageMinutes(notice));
  const label = [
    notice.read ? null : noticesWords.unread,
    notice.senderKind ? noticesWords.fromSender[notice.senderKind] : null,
    notice.title,
    notice.body,
    answerStatus(notice),
    ...answerWakes(notice),
    notice.retryTarget ? noticesWords.targetReadFailed : null,
    noticeMeta(notice, time),
  ]
    .filter(Boolean)
    .join(", ");
  return { label, actions };
}
