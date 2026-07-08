import type { ChatPresenceCollaboration } from "../workbench/ChatsView";
import { createIpcPresenceTransport } from "./ipcPresenceTransport";
import type { PresenceScope } from "./presenceChannel";

// MU-C5 — build the ephemeral presence collaboration for the ACTIVE workspace's
// Chats, or null when there is no signed-in relay session (solo/offline →
// today's exactly-dormant Chats: no transport, no channel, no publish).
//
// Rather than one baked transport, this hands ChatsView a per-SCOPE factory: an
// owner of a shared channel (and any plain local channel) resolves a WORKSPACE
// scope, while a participant viewing a channel shared TO them resolves a SHARE
// scope — the relay maps that share scope back to the granter's workspace so
// owner and participants converge in ONE presence scope. Each transport is
// still workspace/share-scoped in main, so a slow presence response can only
// ever carry THAT scope's peers; the caller memoizes per scope and rebuilds the
// collaboration per workspace, so a switch tears the old transport down and
// aborts its in-flight poll — the no-repaint invariant (AGENTS.md).

export interface ChatCollaborationInput {
  // From cloudStatus: a signed-in relay session is required for any presence.
  connected: boolean;
  relayUrl?: string;
  email?: string;
  // The ACTIVE workspace — the caller's per-workspace rebuild key. The scope a
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
    transportForScope: (scope: PresenceScope) => createIpcPresenceTransport(scope),
    clientId: input.clientId,
    displayName,
  };
}
