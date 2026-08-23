import type { ShareAccess } from "@dohc/security-contract/share-selector";
import { shareViewGranterEmail, shareViewIsPresent } from "./shareViewMarker";

// The LOCAL-WRITE gate for a share view (#646 PR3), as one rule in one place.
//
// Several surfaces ask it and they must agree, because they fail in opposite
// directions when they do not:
//
//   main's `assertWritableWorkspace` decides whether a write handler runs at
//   all. Read it too widely and someone else's files become writable.
//
//   `ShareViewFiles.change` decides where the write lands. Read it too
//   narrowly and the recipient edits a file whose change nothing journals, so
//   nothing can ever be sent.
//
//   `requireShareViewProposalScope` decides whether the recipient may send
//   what it wrote.
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

/**
 * Why an ordinary workspace write handler must refuse, or null when it may
 * run. `main`'s `assertWritableWorkspace` is one line over this.
 *
 * PRESENCE, at EVERY level. The handlers this guards write workspace state
 * outside the received-share file owner — assets, database edits, plugin
 * state, settings, and similar disk-backed surfaces. A raw-disk write into a
 * shared view would leave the projection describing content no moment states,
 * so nothing the recipient could ever send, and the next pull would overwrite
 * it.
 *
 * File changes admitted by an edit grant do not come through here. They route
 * to the engine through `ShareViewFiles.change`, which asks
 * `shareViewTakesLocalWrites` at the seam that would otherwise write.
 * Widening THIS rule to the same level would open every guarded handler with
 * it.
 *
 * The input is the registry marker, and it is read for presence alone. The
 * level is deliberately not consulted: a rule that cannot see the level
 * cannot be widened by one.
 */
export function workspaceWriteRefusal(shareView: unknown): string | null {
  // PRESENCE, not truthiness. A stored `shareView: null` is a share view
  // whose marker lost its value, not a workspace that never had one, and
  // `?? null` read the two as the same thing — which made someone else's
  // files writable here (#646). Only an ABSENT field is an ordinary
  // workspace; anything else stays refused, readable marker or not.
  if (!shareViewIsPresent(shareView)) return null;
  const granter = shareViewGranterEmail(shareView) ?? "the person who shared it";
  return `This is a shared view — ask ${granter} for changes.`;
}
