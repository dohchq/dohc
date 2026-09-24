import type { NoticeReach } from "@dohc/workspace-contracts/relay";
import {
  resolveShareViewRelayAuthorId,
  resolveWorkspaceRelayAuthorId,
} from "../workspaces/chatRelayIdentity";
import type { CloudCredentials } from "../workspaces/cloudCredentialStore";
import type { RegistryEntry } from "../workspaces/registryStore";

// How the signed-in account reaches a workspace on its relay for notices: an
// owned, synced workspace by its id, and a share view by its share while the
// share lasts. Null keeps the workspace's notices on this computer, which is
// where a notice about an ended share belongs: the relay refuses a notice
// through a share its sender no longer holds.
export function noticeReachFor(
  workspace: Pick<RegistryEntry, "workspaceId" | "remote" | "shareView">,
  credentials: CloudCredentials,
): NoticeReach | null {
  const shareView = workspace.shareView;
  if (shareView) {
    if (shareView.ended) return null;
    return resolveShareViewRelayAuthorId(shareView, credentials) === undefined
      ? null
      : { shareId: shareView.shareId };
  }
  return resolveWorkspaceRelayAuthorId(workspace, credentials) === undefined
    ? null
    : { workspaceId: workspace.workspaceId };
}
