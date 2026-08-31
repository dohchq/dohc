import { SharedFileReadOnlyError } from "@dohc/workspace-contracts/relay";
import type { ShareAccess } from "@dohc/security-contract/share-selector";

// The generic chat WRITE gate for a received file share, as one rule in one
// place. Phase 3 has no durable per-row relay receipt, so every received share
// stays read-only even when the relay says its grant has append authority.
//
// It lives here rather than inside main's IPC closure so the tests that prove
// it drive the real thing. A hand-copied re-implementation in a test proves
// only that the copy behaves — and the copy had already drifted from main
// before this module existed.
export interface ShareChatWriteScope {
  // Keep the relay-derived facts explicit so the mutation tests prove that no
  // value grants a desktop generic-chat write in Phase 3.
  access: ShareAccess | null;
  genericChatWritable: boolean;
  ended: boolean;
}

/**
 * Refuse every generic chat write from a received file share before the
 * store. Existing chat history remains readable through the separate read
 * handlers. Edit-level document proposals use their own authority and relay
 * path.
 */
export function assertShareChatWritable(_scope: ShareChatWriteScope): void {
  throw new SharedFileReadOnlyError("Chats are read-only in this shared view.");
}
