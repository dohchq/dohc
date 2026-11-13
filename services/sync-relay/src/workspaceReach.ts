import { GENERAL_CHANNEL_WIRE_ID } from "@dohc/security-contract/chat-wire-ids";
import type { ShareAccess } from "@dohc/security-contract/share-selector";
import type { ChatShareAccess } from "@dohc/security-contract/share-grant";

// What a person in a workspace reaches through the workspace share. Every
// surface asks these functions and nothing else, so access rules (piece 3 of
// docs/engineering/plans/workspace-members.md) narrow reach here once.
//
// Files: every tracked path on main, current and future. The engine path
// floor still applies, so secret and engine paths stay out.
// Chat: every ordinary Group. Never General, a direct message, an agent chat,
// or a channel the owner's log does not name as a Group.
// File Comments follow file reach.

export interface StoredWorkspaceShareSelector {
  kind: "workspace";
}

export interface WorkspaceShareSelector extends StoredWorkspaceShareSelector {
  access: ShareAccess;
}

/** The file side: a scope only the relay builds, never stored or sent. */
export function workspaceFileReach(selector: WorkspaceShareSelector) {
  return { paths: [] as string[], versionId: null, access: selector.access, wholeWorkspace: true as const };
}

/** Whether the workspace share reaches this channel's messages. */
export function workspaceGroupReachable(
  channelWireId: unknown,
  chat: { channelKind(channelWireId: string): string | null | undefined } | undefined,
): channelWireId is string {
  return typeof channelWireId === "string" && channelWireId.length > 0 &&
    channelWireId !== GENERAL_CHANNEL_WIRE_ID && chat?.channelKind(channelWireId) === "channel";
}

/** View reads a Group. Comment and Edit read and post. */
export function workspaceChatAccess(selector: WorkspaceShareSelector): ChatShareAccess {
  return selector.access === "view" ? "read-only" : "read-write";
}

/** The chat side for one Group, or null when the workspace share does not reach it. */
export function workspaceGroupReach(
  selector: WorkspaceShareSelector,
  channelWireId: unknown,
  chat: { channelKind(channelWireId: string): string | null | undefined } | undefined,
): { kind: "chat"; channelWireId: string; access: ChatShareAccess } | null {
  return workspaceGroupReachable(channelWireId, chat)
    ? { kind: "chat", channelWireId, access: workspaceChatAccess(selector) }
    : null;
}
