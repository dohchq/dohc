import type { ShareAccess } from "@dohc/security-contract/share-selector";

// The LOCAL-WRITE gate for a share view (#646 PR3), as one rule in one place.
//
// Two surfaces ask it and they must agree, because they fail in opposite
// directions when they do not:
//
//   main's `assertWritableWorkspace` decides whether a write handler runs at
//   all. Read it too widely and someone else's files become writable.
//
//   `captureForFlaggedWorkspace` decides whether the watcher records what
//   that write produced. Read it too narrowly and the recipient edits a file
//   whose change nothing journals, so nothing can ever be sent.
//
// It lives here rather than inside main's IPC closure for the reason
// `shareChatGate.ts` states: a hand-copied re-implementation in a test proves
// only that the copy behaves.
export interface ShareViewWriteScope {
  // The level the PINNED grant names, or null when the grant cannot be read.
  access: ShareAccess | null;
  // The granter ended this share.
  ended: boolean;
}

/**
 * Whether a share view may take the recipient's own local writes.
 *
 * Positive recognition on `edit`, and nothing else. The registry file is
 * DATA, so a stored grant can name a level this process cannot read, and a
 * damaged grant names none at all — reading either as writable is the one
 * direction this must never fail.
 *
 * An ENDED share is a frozen local copy: the submit route is gone, so a write
 * admitted here would land durably and never reach the granter. That is the
 * same rule `assertShareChatWritable` applies to the same state.
 */
export function shareViewTakesLocalWrites(scope: ShareViewWriteScope): boolean {
  if (scope.ended) return false;
  return scope.access === "edit";
}
