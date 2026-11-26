import { isFolderMarkerPath } from "@dohc/security-contract/access-rules";
import { hiddenFile } from "./accountFeed";
import { authorizeShareGrantAction } from "./shareAuthorization";
import { isWorkspaceSelector } from "./shareFilter";
import type { SyncRelayStorage } from "./storage";
import type { StorageContext } from "./storage/context";
import { workspaceMemberGrantId } from "./storage/workspaceMembers";
import { workspaceGroupReachable, type WorkspaceShareSelector } from "./workspaceReach";

/**
 * What a Member or an Admin reaches on their phone in a workspace they joined:
 * their grant on the workspace share, authorized as their browser's reads are,
 * so folder and Group rules narrow the phone exactly as they narrow the browser.
 */
export interface PhoneMember {
  grantId: string;
  selector: WorkspaceShareSelector;
}

export function phoneMember(
  storage: SyncRelayStorage,
  workspaceId: string,
  userId: string,
): PhoneMember | null {
  const grantId = workspaceMemberGrantId(storage as StorageContext, workspaceId, userId);
  if (grantId === null) return null;
  const authorized = authorizeShareGrantAction({
    storage,
    grantId,
    action: "read",
    principal: { kind: "user", userId },
  });
  return authorized.ok &&
    authorized.share.workspaceId === workspaceId &&
    isWorkspaceSelector(authorized.effectiveSelector)
    ? { grantId, selector: authorized.effectiveSelector }
    : null;
}

/** Whether a read shows this path: never a secret or ignored file, and for a Member, only what their reach shows. */
export function pathShown(member: PhoneMember | null, path: string | undefined): boolean {
  if (path === undefined) return true;
  if (hiddenFile(path)) return false;
  return (
    member === null || (!isFolderMarkerPath(path) && member.selector.reach.levelAt(path) !== null)
  );
}

/** Whether a Member reaches this channel's chat: an ordinary Group its rule doesn't hide. The owner reaches every one. */
export function channelShown(
  member: PhoneMember | null,
  channelWireId: string | null,
  kind: string | null | undefined,
): boolean {
  return (
    member === null ||
    workspaceGroupReachable(member.selector, channelWireId, { channelKind: () => kind })
  );
}
