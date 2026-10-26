import { firstAgent, type DesktopUserSettings } from "../../settings/userSettings";
import type { IdentityHue } from "../tokens";

// The colors the settings file chooses for you and your agent. ChatAvatar
// and canvas presentation subscribe, so a change repaints their colours
// without rendering the shell again.

let chosen: Record<"human" | "agent", IdentityHue | null> = { human: null, agent: null };
const listeners = new Set<() => void>();

// Until messages name their agent, your agent's messages take your first agent's hue.
export function setChosenColors(settings: Pick<DesktopUserSettings, "appearance" | "agents">): void {
  const agentHue = firstAgent(settings)?.hue ?? "olive";
  const agent = agentHue === "olive" ? null : agentHue;
  if (chosen.human === settings.appearance.yourColor && chosen.agent === agent) return;
  chosen = { human: settings.appearance.yourColor, agent };
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
