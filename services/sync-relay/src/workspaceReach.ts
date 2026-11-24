import { isWorkspaceGroup } from "@dohc/security-contract/chat-wire-ids";
import type { ChatShareAccess } from "@dohc/security-contract/share-grant";
import type { MemberReach } from "./storage/memberReach";

// What a person in a workspace reaches through the workspace share. Every
// surface asks these functions and nothing else, so access rules (piece 4 of
// docs/engineering/plans/workspace-members.md) narrow reach here once.
//
// Files: every tracked path on main, current and future. The engine path
// floor still applies, so secret and engine paths stay out.
// Chat: every ordinary Group its rule doesn't hide. Never General, a direct
// message, an agent chat, or a channel the owner's log does not name as a Group.
// File Comments follow file reach.

export interface StoredWorkspaceShareSelector {
  kind: "workspace";
}

// Only share authorization builds one, with the reach it evaluated for this
// member, so every level a member holds comes from `reach`.
export interface WorkspaceShareSelector extends StoredWorkspaceShareSelector {
  role: "admin" | "member";
  reach: MemberReach;
}

/** The file side: a scope only the relay builds, never stored or sent. */
export function workspaceFileReach(selector: WorkspaceShareSelector) {
  return {
    paths: [] as string[],
    versionId: null,
    wholeWorkspace: true as const,
    reach: selector.reach,
    levelAt: selector.reach.levelAt,
  };
}

/** Whether the workspace share reaches this channel's messages: an ordinary Group its rule doesn't hide. */
export function workspaceGroupReachable(
  selector: WorkspaceShareSelector,
  channelWireId: unknown,
  chat: { channelKind(channelWireId: string): string | null | undefined } | undefined,
): channelWireId is string {
  return (
    typeof channelWireId === "string" &&
    isWorkspaceGroup(channelWireId, chat?.channelKind(channelWireId)) &&
    selector.reach.groupLevel(channelWireId) !== null
  );
}

/** View reads a Group. Comment and Edit read and post. Call it only for a reachable Group. */
export function workspaceChatAccess(
  selector: WorkspaceShareSelector,
  channelWireId: string,
): ChatShareAccess {
  return selector.reach.groupLevel(channelWireId) === "view" ? "read-only" : "read-write";
}

/** The chat side for one Group, or null when the workspace share does not reach it. */
export function workspaceGroupReach(
  selector: WorkspaceShareSelector,
  channelWireId: unknown,
  chat: { channelKind(channelWireId: string): string | null | undefined } | undefined,
): { kind: "chat"; channelWireId: string; access: ChatShareAccess } | null {
  return workspaceGroupReachable(selector, channelWireId, chat)
    ? { kind: "chat", channelWireId, access: workspaceChatAccess(selector, channelWireId) }
    : null;
}
