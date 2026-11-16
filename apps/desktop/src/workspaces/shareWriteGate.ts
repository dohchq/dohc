import type { ShareAccess } from "@dohc/security-contract/share-selector";
import { isRecord } from "@dohc/workspace-core/records";
import { relayUrlsMatch } from "@dohc/workspace-contracts/relay-values";
import { shareViewGranterEmail, shareViewIsPresent } from "./shareViewMarker";
import { shareViewLevels } from "./shareViewReach";
import { recordedShareSelector } from "./shareViewRecords";

// The LOCAL-WRITE gate for a share view, as one rule in one place.
//
// sharedView.test.ts checks ShareViewFiles.change (writableSelector) admission,
// journaling, and proposals against one grant table.
// These surfaces fail in opposite directions when they disagree:
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
  // The highest level the share view has anywhere, or null when the grant
  // cannot be read or the marker lost its identity. For a path share, or a
  // joined workspace with no stored reach yet, the level the PINNED grant
  // names.
  access: ShareAccess | null;
  // The level at one path and inside one folder (`shareViewLevels`). Absent,
  // every path takes `access`.
  levelAt?: (path: string) => ShareAccess | null;
  levelIn?: (folder: string) => ShareAccess | null;
  ended: boolean;
  // The pinned grant is the whole workspace: a joined workspace.
  membership?: boolean;
  // Who is signed in, for a joined workspace that has not ended. Absent for
  // any other share view, which has no account rule.
  writer?: ShareViewWriter;
}

/**
 * Who is signed in, against the account that joined a workspace. Its level
 * belongs to that account, so "other" takes no local write and sends nothing.
 * Signed out, a local change still lands and is sent once that account is
 * back, while a relay action has no account to go as. Three values, so
 * neither door can borrow the other's answer.
 */
export type ShareViewWriter = "joined" | "other" | "signed-out";

/**
 * Whether these credentials are the account that received this share, on the
 * relay it came through. A relay-bound door asks this before it sends.
 */
export function joinedByAccount<Credentials extends { userId: string; relayUrl?: string }>(
  view: { relayUrl?: unknown; recipientUserId?: unknown } | null | undefined,
  credentials: Credentials | null | undefined,
): credentials is Credentials & { relayUrl: string } {
  return (
    !!credentials?.relayUrl &&
    typeof view?.relayUrl === "string" &&
    !!view.relayUrl &&
    relayUrlsMatch(credentials.relayUrl, view.relayUrl) &&
    view.recipientUserId === credentials.userId
  );
}

export function shareViewWriterOf(
  view: { relayUrl?: unknown; recipientUserId?: unknown },
  credentials: { userId: string; relayUrl?: string } | null,
): ShareViewWriter {
  if (credentials === null) return "signed-out";
  return joinedByAccount(view, credentials) ? "joined" : "other";
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
  if (scope.ended || scope.writer === "other") return false;
  return scope.access === "edit";
}

/** The level a share view has at one file path, by the rule every gate asks. */
export function shareViewLevelAt(scope: ShareViewWriteScope, path: string): ShareAccess | null {
  return scope.levelAt ? scope.levelAt(path) : scope.access;
}

/** The level inside one folder, "" for the root, where a new file lands. */
export function shareViewLevelIn(scope: ShareViewWriteScope, folder: string): ShareAccess | null {
  return scope.levelIn ? scope.levelIn(folder) : scope.access;
}

/** Whether a share view takes the recipient's own write at one path. */
export function shareViewTakesLocalWritesAt(scope: ShareViewWriteScope, path: string): boolean {
  if (scope.ended || scope.writer === "other") return false;
  return shareViewLevelAt(scope, path) === "edit";
}

/**
 * Which create and import actions a workspace offers, given the share view it
 * is, or null for an ordinary workspace. The Explorer menu and the command
 * rows both ask this, so neither offers an action its handler refuses.
 */
export function workspaceCreateOffers(
  shareView: ShareViewWriteScope | null,
  role?: "admin" | "member",
): {
  write: boolean;
  folder: boolean;
  collection: boolean;
} {
  // Create, rename, delete and import: everywhere in an ordinary workspace,
  // and in a share view only at the level `shareViewTakesLocalWrites` names.
  const write = shareView === null || shareViewTakesLocalWrites(shareView);
  // In a joined workspace only an admin starts a folder; the relay reads the
  // role again. `role` is the relay's last answer, or unknown.
  const startsFolders = shareView?.membership === true && role === "admin";
  return {
    write,
    // The engine has no folder object, so an empty folder is nothing a share
    // view could send. `ShareViewFiles` therefore exposes no empty-folder
    // operation. An admin's new folder starts with its first page instead.
    folder: shareView === null || (write && startsFolders),
    // A document Collection is a folder with a schema file. A share view that
    // takes writes can make one: the schema file is the Collection's first
    // file, and the folder comes with it (ADR 0013). In a joined workspace
    // that folder is new, so only an admin makes one.
    collection: write && (shareView?.membership !== true || startsFolders),
  };
}

/**
 * The share view a registry marker describes, or null for an ordinary
 * workspace. `main`'s `sharedViewOf` is one line over this.
 *
 * PRESENCE decides whether it is a share view. The level comes only from an
 * intact marker: one that lost its share id or recipient is damaged, names no
 * level, and so offers and admits no write. `credentials` are the account
 * signed in now, or null.
 */
export function shareViewWriteScopeOf(
  shareView: unknown,
  credentials: { userId: string; relayUrl?: string } | null,
): (ShareViewWriteScope & { granterEmail: string | null }) | null {
  if (!shareViewIsPresent(shareView)) return null;
  const marker = isRecord(shareView) ? shareView : {};
  const membership = recordedShareSelector(marker.grantedSelector)?.wholeWorkspace === true;
  const ended = marker.ended === true;
  const levels = shareViewLevels(marker);
  return {
    granterEmail: shareViewGranterEmail(marker),
    access: levels.highest,
    levelAt: levels.at,
    levelIn: levels.in,
    ended,
    membership,
    ...(membership && !ended ? { writer: shareViewWriterOf(marker, credentials) } : {}),
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
