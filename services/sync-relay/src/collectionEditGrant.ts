import { notFound, relayError } from "./errors";
import { authorizeShareGrantAction, type AuthorizedShareAction } from "./shareAuthorization";
import { collectionEditSelector, coversCollectionFolder, type ShareSelector } from "./shareFilter";
import { readCurrentShareGrant } from "./storage/currentShareGrant";
import type { SyncRelayStorage } from "./storage/types";

// Who may change a shared Collection from outside its owner's computers: a
// recipient's own named grant with Edit on files, never one opened from a
// public link until the owner promotes it. A direct write to a Collection's
// files and a relayed Button press both answer to this one rule, so the
// two cannot drift.

type GrantStorage = Pick<
  SyncRelayStorage,
  "findChannelCreateKind" | "getShare" | "getShareGrant" | "listActiveShareGrantsForRecipient" | "workspaceIsOwnedBy"
>;

/**
 * The caller's named Edit grant on a share, found before the request body is
 * read. A link grant counts as read-only, as does any grant without Edit.
 */
export function namedCollectionEditGrant(storage: GrantStorage, shareId: string, userId: string): AuthorizedShareAction<ShareSelector> {
  let denied = false;
  for (const grant of storage.listActiveShareGrantsForRecipient(shareId, userId)) {
    const result = authorizeShareGrantAction({ storage, grantId: grant.grantId, action: "propose", principal: { kind: "user", userId } });
    if (!result.ok) {
      denied ||= result.reason === "denied";
      continue;
    }
    if (result.grant.parentGrantId !== null) {
      denied = true;
      continue;
    }
    return result as AuthorizedShareAction<ShareSelector>;
  }
  throw denied ? relayError("share_read_only") : notFound();
}

/**
 * The same grant, checked again inside the transaction that acts on it: still
 * current at the generation the route pinned, still this share's, still named
 * rather than a link's, and still allowed to change files.
 */
export function currentCollectionEditGrant(
  storage: GrantStorage,
  pinned: { shareId: string; grantId: string; grantGeneration: number; userId: string },
): AuthorizedShareAction {
  const principal = { kind: "user" as const, userId: pinned.userId };
  const current = readCurrentShareGrant(storage, { grantId: pinned.grantId, principal, generation: pinned.grantGeneration });
  if (!current || current.share.shareId !== pinned.shareId || current.grant.parentGrantId !== null) throw notFound();
  const authorized = authorizeShareGrantAction({ storage, grantId: pinned.grantId, action: "propose", principal });
  if (!authorized.ok) throw authorized.reason === "denied" ? relayError("share_read_only") : notFound();
  return authorized;
}

/** Whether a grant lets its recipient change the Collection at `collectionPath`. */
export function grantEditsCollection(storage: GrantStorage, authorized: AuthorizedShareAction, collectionPath: string): boolean {
  const files = collectionEditSelector(authorized.effectiveSelector, {
    channelKind: (wireId) => storage.findChannelCreateKind(authorized.share.workspaceId, wireId),
  });
  return files !== null && coversCollectionFolder(files, collectionPath);
}
