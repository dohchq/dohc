import type { ActorPresentation, ChatChannelRecord } from "../../ipc/bridgeContract";
import { DEFAULT_AGENT_ID, type Agent } from "../../settings/userSettings";
import { goneAgentPresentation } from "./actorPresentation";

export type SettingsAgent = Pick<Agent, "id" | "name" | "hue">;

export interface AgentChatIdentity {
  label: string;
  presentation: ActorPresentation;
}

/**
 * How an agent's chat names and marks its agent: by the agent's current
 * Settings name and hue. A chat whose agent was removed from Settings keeps
 * the name it was stored with and a mark with no hue. The default agent's chat is
 * always stored as "My agent", so it says "Your agent", as its run notices do.
 */
export function agentChatIdentity(
  channel: Pick<ChatChannelRecord, "agentId" | "name">,
  agents: readonly SettingsAgent[],
): AgentChatIdentity {
  const agent = agents.find((candidate) => candidate.id === channel.agentId);
  if (agent) {
    return { label: agent.name, presentation: { group: "", hue: agent.hue === "olive" ? null : agent.hue, self: false } };
  }
  return {
    label: channel.agentId === DEFAULT_AGENT_ID ? "Your agent" : channel.name,
    presentation: goneAgentPresentation,
  };
}

/**
 * Home, a file mention and the graph name an agent's chat without its agent.
 * The listed chat names it, so a chat without one takes the listed chat.
 */
export function withListedAgent<T extends Pick<ChatChannelRecord, "id" | "kind" | "agentId">>(
  channel: T,
  listed: readonly ChatChannelRecord[],
): T | ChatChannelRecord {
  if (channel.kind !== "agent" || channel.agentId) return channel;
  return listed.find((entry) => entry.id === channel.id) ?? channel;
}

/** Agents' chats in the order the settings file lists their agents, then chats whose agent is gone. */
export function orderAgentChats<T extends Pick<ChatChannelRecord, "kind" | "agentId">>(
  channels: readonly T[],
  agents: readonly SettingsAgent[],
): T[] {
  const chats = channels.filter((channel) => channel.kind === "agent");
  const listed = agents.flatMap((agent) => chats.filter((channel) => channel.agentId === agent.id));
  return [...listed, ...chats.filter((channel) => !listed.includes(channel))];
}
