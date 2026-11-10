import { noticesWords, relativeTime, spokenRelativeTime } from "@dohc/interface-words/notices";
import type { PhoneNotice } from "./sample";

/** A notice's arrival time from how long ago it came, in the desktop's words: "2m ago". */
export const shortAgo = (minutes: number, nowMs = Date.now()) => relativeTime(nowMs - minutes * 60_000, nowMs);
/** The same in full for VoiceOver: "2 minutes ago". */
export const spokenAgo = (minutes: number, nowMs = Date.now()) => spokenRelativeTime(nowMs - minutes * 60_000, nowMs);

/** How long ago the notice arrived, in whole minutes. */
export const ageMinutes = (notice: PhoneNotice, nowMs = Date.now()) =>
  notice.atMs === undefined ? notice.minutesAgo : Math.max(0, Math.floor((nowMs - notice.atMs) / 60_000));

/** What Copy puts on the clipboard, as the desktop copies a notice's details. */
export const noticeDetails = (notice: PhoneNotice) => [notice.title, notice.body].filter(Boolean).join("\n");

export interface RowHandlers { open?(): void; retry?(): void; copy(): void; dismiss(): void }

/** The press handler behind each action a row offers: its pill and rotor action share it. */
export function noticeRowHandlers(notice: PhoneNotice, handlers: RowHandlers): Partial<Record<string, () => void>> {
  return {
    worded: notice.retry ? handlers.retry : notice.open ? handlers.open : undefined,
    copy: handlers.copy,
    dismiss: notice.dismissible ? handlers.dismiss : undefined,
  };
}

/** What VoiceOver hears for a row, and its actions in rotor order: the worded action, Copy, then Dismiss. */
export function noticeRowAccessibility(notice: PhoneNotice): { label: string; actions: { name: string; label: string }[] } {
  const worded = notice.retry ? noticesWords.tryAgain : notice.open === "openNote" ? noticesWords.openNote : notice.open ? noticesWords.open : null;
  const actions = [
    ...(worded ? [{ name: "worded", label: worded }] : []),
    { name: "copy", label: notice.failed ? noticesWords.copyErrorDetails : noticesWords.copyNoticeDetails },
    ...(notice.dismissible ? [{ name: "dismiss", label: noticesWords.dismissNotice }] : []),
  ];
  const time = spokenAgo(ageMinutes(notice));
  const label = [notice.read ? null : noticesWords.unread, notice.senderKind ? noticesWords.fromSender[notice.senderKind] : null,
    notice.title, notice.body, notice.folder ? `${time} · ${notice.folder}` : time].filter(Boolean).join(", ");
  return { label, actions };
}
