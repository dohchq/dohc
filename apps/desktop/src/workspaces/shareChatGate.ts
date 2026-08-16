import { SharedFileReadOnlyError } from "@dohc/workspace-contracts/relay";
import type { ShareAccess } from "@dohc/security-contract/share-selector";

// The chat WRITE gate for a share view (#646 PR2), as one rule in one place.
//
// It lives here rather than inside main's IPC closure so the tests that prove
// it drive the real thing. A hand-copied re-implementation in a test proves
// only that the copy behaves — and the copy had already drifted from main
// before this module existed.
export interface ShareChatWriteScope {
  // The level the PINNED grant names, or null when the grant cannot be read.
  access: ShareAccess | null;
  // The granter ended the share.
  ended: boolean;
  // The account this recipient writes chat under, when one resolves.
  authorUserId: string | undefined;
}

/**
 * Refuse a chat write this share cannot carry.
 *
 * Three separate reasons, in the order that makes each answer true:
 *
 * 1. An ENDED share is a read-only local copy — the same rule an ended
 *    chat-channel grant follows. The push bails on `ended`, so a write
 *    admitted here would land durably and never reach anyone.
 * 2. The level must POSITIVELY be `comment` or `edit`. A damaged grant names
 *    no level at all, and reading absence as "not view" would open the
 *    composer on a share nobody can prove grants writes.
 * 3. A chat op replicates only when its author carries a user id, so a share
 *    view with no resolvable relay identity would write a comment that looks
 *    sent and stays on this machine.
 */
export function assertShareChatWritable(scope: ShareChatWriteScope): void {
  if (scope.ended) throw new SharedFileReadOnlyError();
  if (scope.access !== "comment" && scope.access !== "edit") {
    throw new SharedFileReadOnlyError();
  }
  if (!scope.authorUserId) {
    throw new Error("Sign in to dohc Cloud to chat about a shared file.");
  }
}
