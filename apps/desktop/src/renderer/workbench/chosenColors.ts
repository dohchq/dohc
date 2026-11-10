import { firstAgent, listAgents, type DesktopUserSettings } from "../../settings/userSettings";
import type { AgentHue, IdentityHue } from "@dohc/workspace-contracts/agent-hues";

// The colors the settings file chooses for you and your agents. ChatAvatar
// and canvas presentation subscribe, so a change repaints their colours
// without rendering the shell again.

// Until the first settings read, `agents` is null: no agent reads as removed before then.
type Chosen = { human: IdentityHue | null; agent: IdentityHue | null; agents: ReadonlyMap<string, IdentityHue | null> | null };
let chosen: Chosen = { human: null, agent: null, agents: null };
// Your personal agents, by id, as main caches them. Null until a roster is
// read, so no personal agent reads as removed before then.
type Personal = ReadonlyMap<string, { name: string; hue: IdentityHue | null }>;
let personal: Personal | null = null;
// Rises with each roster change, for the lists that show personal agents' names.
let personalVersion = 0;
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

/**
 * The hue Settings gives this agent, null for olive, or undefined once Settings no longer has it. Olive before the first read.
 * A personal agent's hue comes from your account's roster instead.
 */
export function settingsAgentHue(agentId: string): IdentityHue | null | undefined {
  if (isPersonalAgentId(agentId)) return personal === null ? null : personal.get(agentId)?.hue;
  return chosen.agents === null ? null : chosen.agents.get(agentId);
}

export function isPersonalAgentId(agentId: string): boolean {
  return agentId.startsWith("p-");
}

/** Your personal agents' names and hues, or null when no roster has been read. */
export function setPersonalAgents(agents: readonly { agentId: string; name: string; hue: AgentHue }[] | null): void {
  const next: Personal | null = agents === null ? null
    : new Map(agents.map((agent) => [agent.agentId, { name: agent.name, hue: chosenAgentHue(agent.hue) }] as const));
  const same = next === null ? personal === null
    : personal !== null && personal.size === next.size && [...next].every(([id, entry]) => {
      const held = personal?.get(id);
      return held !== undefined && held.name === entry.name && held.hue === entry.hue;
    });
  if (same) return;
  personal = next;
  personalVersion += 1;
  for (const listener of listeners) listener();
}

/** A personal agent's current name, or null when the roster doesn't hold it. */
export function personalAgentName(agentId: string): string | null {
  return personal?.get(agentId)?.name ?? null;
}

export function personalAgentsVersion(): number {
  return personalVersion;
}

/** Forgets the settings read, as at startup. Only tests call it. */
export function resetChosenColorsForTests(): void {
  chosen = { human: null, agent: null, agents: null };
  personal = null;
  personalVersion += 1;
  for (const listener of listeners) listener();
}
