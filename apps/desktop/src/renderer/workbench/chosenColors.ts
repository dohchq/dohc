import { firstAgent, listAgents, type DesktopUserSettings } from "../../settings/userSettings";
import type { AgentHue, IdentityHue } from "@dohc/workspace-contracts/agent-hues";

// The colors the settings file chooses for you and your agents. ChatAvatar
// and canvas presentation subscribe, so a change repaints their colours
// without rendering the shell again.

// Until the first settings read, `agents` is null: no agent reads as removed before then.
type Chosen = { human: IdentityHue | null; agent: IdentityHue | null; agents: ReadonlyMap<string, IdentityHue | null> | null };
let chosen: Chosen = { human: null, agent: null, agents: null };
const listeners = new Set<() => void>();

const chosenAgentHue = (hue: AgentHue): IdentityHue | null => hue === "olive" ? null : hue;

function sameAgents(a: ReadonlyMap<string, IdentityHue | null> | null, b: ReadonlyMap<string, IdentityHue | null>): boolean {
  return a !== null && a.size === b.size && [...a].every(([id, hue]) => b.has(id) && b.get(id) === hue);
}

// A message from your agent that names no agent, such as one through MCP, takes your first agent's hue.
export function setChosenColors(settings: Pick<DesktopUserSettings, "appearance" | "agents">): void {
  const agent = chosenAgentHue(firstAgent(settings)?.hue ?? "olive");
  const agents = new Map(listAgents(settings).map((entry) => [entry.id, chosenAgentHue(entry.hue)] as const));
  if (chosen.human === settings.appearance.yourColor && chosen.agent === agent && sameAgents(chosen.agents, agents)) return;
  chosen = { human: settings.appearance.yourColor, agent, agents };
  for (const listener of listeners) listener();
}

export function subscribeChosenColors(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The hue you chose for yourself or your agent, or null for dohc's own: your name's hue, or olive. */
export function chosenHue(kind: "human" | "agent"): IdentityHue | null {
  return chosen[kind];
}

/** The hue Settings gives this agent, null for olive, or undefined once Settings no longer has it. Olive before the first read. */
export function settingsAgentHue(agentId: string): IdentityHue | null | undefined {
  return chosen.agents === null ? null : chosen.agents.get(agentId);
}

/** Forgets the settings read, as at startup. Only tests call it. */
export function resetChosenColorsForTests(): void {
  chosen = { human: null, agent: null, agents: null };
  for (const listener of listeners) listener();
}
