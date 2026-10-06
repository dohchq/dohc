// Phase-3/5 agent activity is an additive opaque presence payload. Keeping the
// topic and parser in this dependency-free module gives main and renderer one
// wire contract without making either side depend on the other.

export const CHAT_AGENT_PRESENCE_TOPIC = "chat:agent";

export type AgentPresenceActivity = "working" | "idle";

interface AgentPresencePeer {
  sessionToken: string;
  state: unknown;
}

export function agentPresenceClientId(workspaceId: string): string {
  return `agent:${workspaceId}`;
}

// The relay retains the marker for its reserved client. Missing or malformed
// activity state means no hint.
export function resolveAgentPresenceActivity(
  peers: readonly AgentPresencePeer[],
): AgentPresenceActivity | null {
  // The relay retained this marker only for the reserved client. Merge the owner-binding fix first.
  for (const peer of peers) {
    if (typeof peer.state !== "object" || peer.state === null) continue;
    const state = peer.state as { agent?: unknown; activity?: unknown };
    if (state.agent !== true) continue;
    return state.activity === "working" || state.activity === "idle" ? state.activity : null;
  }
  return null;
}
