import { isFolderMarkerPath } from "@dohc/security-contract/access-rules";
import { hiddenFile } from "./accountFeed";
import { authorizeShareGrantAction } from "./shareAuthorization";
import { isWorkspaceSelector, withheldLinkText } from "./shareFilter";
import type { SyncRelayStorage } from "./storage";
import type { StorageContext } from "./storage/context";
import { workspaceMemberGrantId } from "./storage/workspaceMembers";
import {
  workspaceChatAccess,
  workspaceFileReach,
  workspaceGroupReachable,
  type WorkspaceShareSelector,
} from "./workspaceReach";

/**
 * What a Member or an Admin reaches on their phone in a workspace they joined:
 * their grant on the workspace share, authorized as their browser's reads are,
 * so folder and Group rules narrow the phone exactly as they narrow the browser.
 */
export interface PhoneMember {
  grantId: string;
  shareId: string;
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
    ? { grantId, shareId: authorized.share.shareId, selector: authorized.effectiveSelector }
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

/** The owner's own read places in a chat answer, as a reader with none sees them. */
const OWNER_READ_STATE: Readonly<Record<string, unknown>> = {
  unread: false,
  unreadCount: 0,
  readPosition: null,
};

/**
 * A chat answer as a Member reads it: every file link their reach doesn't cover reads "(a file not shared here)", as
 * in their browser, and no unread count or read place of the owner's shows.
 */
export function memberChatAnswer<Answer>(
  member: PhoneMember,
  answer: Answer,
  channels?: readonly { channelWireId: string; type: "posts" | "chat" | "both" }[],
): Answer {
  const files = workspaceFileReach(member.selector);
  const channelTypes = channels
    ? new Map(channels.map((channel) => [channel.channelWireId, channel.type]))
    : null;
  const served = (value: unknown, key?: string): unknown => {
    if (key !== undefined && Object.hasOwn(OWNER_READ_STATE, key)) return OWNER_READ_STATE[key];
    if (typeof value === "string") return withheldLinkText(value, files);
    if (Array.isArray(value)) return value.map((item) => served(item));
    if (value !== null && typeof value === "object") {
      const record = value as Record<string, unknown>;
      const entries = Object.entries(record).map(([name, item]) => [name, served(item, name)]);
      if (record.kind === "group" && typeof record.channelWireId === "string") {
        entries.push([
          "access",
          member.selector.reach.groupLevel(record.channelWireId) === null
            ? "read-only"
            : workspaceChatAccess(member.selector, record.channelWireId),
        ]);
        const type = channelTypes?.get(record.channelWireId);
        if (type !== undefined) entries.push(["type", type]);
      }
      return Object.fromEntries(entries);
    }
    return value;
  };
  return served(answer) as Answer;
}
