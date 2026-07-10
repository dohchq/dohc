// Phase-3/5 agent activity is an additive opaque presence payload. Keeping the
// topic and parser in this dependency-free module gives main and renderer one
// wire contract without making either side depend on the other.

export const CHAT_AGENT_PRESENCE_TOPIC = "chat:agent";

export type AgentPresenceActivity = "working" | "idle";

export interface AgentPresencePeer {
  clientId: string;
  state: unknown;
}

export function agentPresenceClientId(workspaceId: string): string {
  return `agent:${workspaceId}`;
}

// The relay state is untrusted/opaque at this boundary. Only the reserved
// client for THIS workspace and the exact published payload shape can become
// visible UI; missing or malformed state means no hint.
export function resolveAgentPresenceActivity(
  peers: readonly AgentPresencePeer[],
  workspaceId: string,
): AgentPresenceActivity | null {
  const expectedClientId = agentPresenceClientId(workspaceId);
  for (const peer of peers) {
    if (peer.clientId !== expectedClientId) continue;
    if (typeof peer.state !== "object" || peer.state === null) return null;
    const state = peer.state as { agent?: unknown; activity?: unknown };
    if (state.agent !== true) return null;
    return state.activity === "working" || state.activity === "idle"
      ? state.activity
      : null;
  }
  return null;
}
