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
  serverNeedsUpdate: "This server runs an older version of dohc. Ask the person who runs it to update it.",
} as const;

/** The phone's band body for a workspace that can't sync. */
export const phoneSyncBody: Record<keyof typeof syncProblemSentence, string> = {
  serverUnreachable: `${syncProblemSentence.serverUnreachable} Messages wait on this phone and send when it answers. Pages are read-only until then.`,
  syncFailed: `${syncProblemSentence.syncFailed} Messages wait on this phone and send when sync works again. Pages are read-only until then.`,
  updateToSync: `${syncProblemSentence.updateToSync} Messages wait on this phone until then.`,
  serverNeedsUpdate: `${syncProblemSentence.serverNeedsUpdate} Messages wait on this phone until then.`,
};

export const chatWords = {
  /** A message written while the server can't be reached, queued on this device. */
  waitingToSend: "Waiting to send",
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
  if (hours >= 24) return new Date(thenMs).toLocaleDateString(undefined, { month: "long", day: "numeric" });
  const [count, unit] = minutes < 60 ? [minutes, "minute" as const] : [hours, "hour" as const];
  return typeof Intl.RelativeTimeFormat === "function"
    ? new Intl.RelativeTimeFormat(undefined, { numeric: "always", style: "long" }).format(-count, unit)
    : `${count} ${unit}${count === 1 ? "" : "s"} ago`;
}
