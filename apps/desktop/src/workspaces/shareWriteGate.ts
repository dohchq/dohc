import type { ShareAccess } from "@dohc/security-contract/share-selector";
import { shareViewGranterEmail, shareViewIsPresent } from "./shareViewMarker";

// The LOCAL-WRITE gate for a share view, as one rule in one place.
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
// It lives here rather than inside main's IPC closure so tests drive the real
// rule: a hand-copied re-implementation in a test proves only that the copy
// behaves.
export interface ShareViewWriteScope {
  // The level the PINNED grant names, or null when the grant cannot be read.
  access: ShareAccess | null;
  // The granter ended this share.
  ended: boolean;
}

export const SHARE_VIEW_EMPTY_FOLDER_REFUSAL =
  "A shared view can't hold an empty folder. Make a file in the folder you want.";

/**
 * Whether a share view may take the recipient's own local writes.
 *
 * Positive recognition on `edit`, and nothing else. The registry file is
 * DATA, so a stored grant can name a level this process cannot read, and a
 * damaged grant names none at all — reading either as writable is the one
 * direction this must never fail.
 *
 * An ended share is a frozen local copy: the submit route is gone, so a write
 * admitted here would land durably and never reach the granter. That is the
 * same rule main's chat write gate applies to the same state.
 */
export function shareViewTakesLocalWrites(scope: ShareViewWriteScope): boolean {
  if (scope.ended) return false;
  return scope.access === "edit";
}

/**
 * Which create and import actions a workspace offers, given the share view it
 * is, or null for an ordinary workspace. The Explorer menu and the command
 * rows both ask this, so neither offers an action its handler refuses.
 */
export function workspaceCreateOffers(shareView: ShareViewWriteScope | null): {
  write: boolean;
  folder: boolean;
  collection: boolean;
} {
  // Create, rename, delete and import: everywhere in an ordinary workspace,
  // and in a share view only at the level `shareViewTakesLocalWrites` names.
  const write = shareView === null || shareViewTakesLocalWrites(shareView);
  return {
    write,
    // Nowhere in a share view, at any level: the engine has no folder object,
    // so an empty folder is nothing the recipient could send.
    // `ShareViewFiles` therefore exposes no empty-folder operation.
    folder: write && shareView === null,
    // A document Collection is a folder with a schema file. A share view that
    // takes writes can make one: the schema file is the Collection's first
    // file, and the folder comes with it (ADR 0013).
    collection: write,
  };
}

/**
 * Why an ordinary workspace write handler must refuse, or null when it may
 * run. `main`'s `assertWritableWorkspace` is one line over this.
 *
 * PRESENCE, at every level. The handlers this guards write workspace state
 * outside the received-share file owner — assets, database edits, settings,
 * and similar disk-backed surfaces. A raw-disk write into a
 * shared view would leave the projection describing content no moment states,
 * so nothing the recipient could ever send, and the next pull would overwrite
 * it.
 *
 * File changes admitted by an edit grant do not come through here. They route
 * to the engine through `ShareViewFiles.change`, which asks
 * `shareViewTakesLocalWrites` at the seam that would otherwise write.
 * Widening this rule to the same level would open every guarded handler with
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
  // files writable here. Only an absent field is an ordinary
  // workspace; anything else stays refused, readable marker or not.
  if (!shareViewIsPresent(shareView)) return null;
  const granter = shareViewGranterEmail(shareView) ?? "the person who shared it";
  return `This is a shared view — ask ${granter} for changes.`;
}
