// The hue names people and agents choose from. The desktop maps each to its
// colors; the relay checks a personal agent's hue against this list.

// A person's hue choices. Olive marks an agent, so a person never has it.
export const IDENTITY_HUES = [
  "rust",
  "amber",
  "teal",
  "blue",
  "indigo",
  "plum",
  "rose",
] as const;
export type IdentityHue = (typeof IDENTITY_HUES)[number];

// An agent's hue choices, in the picker's order.
export const AGENT_HUES = ["olive", ...IDENTITY_HUES] as const;
export type AgentHue = (typeof AGENT_HUES)[number];
// A new agent takes the first free hue here. Unlike the picker's order, each
// next hue is far from the ones before it, so two or three agents side by side stay apart.
export const AGENT_HUE_ASSIGNMENT_ORDER = [
  "olive", "blue", "rose", "teal", "plum", "rust", "amber", "indigo",
] as const satisfies readonly AgentHue[];

export function isAgentHue(value: unknown): value is AgentHue {
  return typeof value === "string" && (AGENT_HUES as readonly string[]).includes(value);
}
