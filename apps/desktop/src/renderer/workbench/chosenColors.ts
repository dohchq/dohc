import type { DesktopUserSettings } from "../../settings/userSettings";
import type { IdentityHue } from "../tokens";

// The colors the settings file chooses for you and your agent. ChatAvatar
// reads them through useSyncExternalStore, so a change repaints only the
// avatars that show them, and the shell does not render again.

let chosen: Record<"human" | "agent", IdentityHue | null> = { human: null, agent: null };
const listeners = new Set<() => void>();

export function setChosenColors(appearance: DesktopUserSettings["appearance"]): void {
  if (chosen.human === appearance.yourColor && chosen.agent === appearance.yourAgentColor) return;
  chosen = { human: appearance.yourColor, agent: appearance.yourAgentColor };
  for (const listener of listeners) listener();
}

export function subscribeChosenColors(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The hue you chose for yourself or your agent, or null for dohc's own. */
export function chosenHue(kind: "human" | "agent"): IdentityHue | null {
  return chosen[kind];
}
