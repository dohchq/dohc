import type { ChatPresenceCollaboration } from "../workbench/ChatsView";
import { createIpcPresenceTransport } from "./ipcPresenceTransport";

// MU-C5 — build the ephemeral presence collaboration for the ACTIVE workspace's
// Chats, or null when there is no signed-in relay session (solo/offline →
// today's exactly-dormant Chats: no transport, no channel, no publish).
//
// The transport is WORKSPACE-scoped to the active workspace, so a slow presence
// response can only ever carry THIS workspace's peers. The caller rebuilds this
// object per workspace (keyed by workspaceId) so a workspace switch tears the
// old transport down and an in-flight poll for the old workspace is aborted —
// the no-repaint invariant (AGENTS.md).

export interface ChatCollaborationInput {
  // From cloudStatus: a signed-in relay session is required for any presence.
  connected: boolean;
  relayUrl?: string;
  email?: string;
  // The ACTIVE workspace — the presence scope and the rebuild key.
  workspaceId: string;
  // Stable per-device/session id so this client's own entry is identifiable and
  // filtered out of the "others" set. Must be stable across renders (the caller
  // owns its lifetime) or usePresence would churn its channel.
  clientId: string;
}

export function buildChatCollaboration(
  input: ChatCollaborationInput,
): ChatPresenceCollaboration | null {
  if (!input.connected || !input.relayUrl) return null;
  const displayName = input.email && input.email.trim() ? input.email.trim() : "You";
  return {
    transport: createIpcPresenceTransport({ kind: "workspace", workspaceId: input.workspaceId }),
    clientId: input.clientId,
    displayName,
  };
}
