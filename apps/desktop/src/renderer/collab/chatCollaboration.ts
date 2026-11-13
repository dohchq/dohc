import type { ChatPresenceCollaboration } from "../workbench/ChatsView";
import type { PresenceScopeInput } from "../../ipc/bridgeContract";
import { createIpcPresenceTransport } from "./ipcPresenceTransport";

interface ChatCollaborationInput {
  // From cloudStatus: a signed-in relay session is required for any presence.
  connected: boolean;
  relayUrl?: string;
  email?: string;
  // The active workspace — the caller's per-workspace rebuild key. The scope a
  // conversation actually publishes into is resolved later, per conversation,
  // through transportForScope (workspace for owner/plain, share for a joined
  // channel), so this no longer bakes the transport's scope.
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
    transportForScope: (scope: PresenceScopeInput) => createIpcPresenceTransport(scope),
    clientId: input.clientId,
    displayName,
  };
}
