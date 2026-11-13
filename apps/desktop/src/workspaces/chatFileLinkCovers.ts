import { shareCoversLinkPath } from "@dohc/security-contract/share-selector";
import type { ChatFileLinkScope } from "../ipc/bridgeContract";

// Whether a message under this scope may link the file at `path`. Everyone a
// Group is shared with reads its messages, so the file must be inside every
// share's folders.
export function chatFileLinkCovers(scope: ChatFileLinkScope, path: string): boolean {
  if (scope.kind !== "shared") return scope.kind === "any";
  return scope.shares.every((paths) => shareCoversLinkPath({ paths, versionId: null }, path));
}
