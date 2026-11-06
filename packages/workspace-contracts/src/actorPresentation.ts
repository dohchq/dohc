import { UNNAMED_AGENT_ID, canonicalClaimedName } from "./actorIdentity";
// Frozen relay slots. Olive belongs to the agent default.
export const ACTOR_HUES = ["rust", "amber", "teal", "blue", "indigo", "plum", "rose"] as const;

/** Unsigned FNV-1a32 over code points, without normalization. */
export function actorHueSlot(value: string): number {
  let hash = 2166136261;
  for (const point of value) hash = Math.imul(hash ^ point.codePointAt(0)!, 16777619) >>> 0;
  return hash % ACTOR_HUES.length;
}

// Characters that can hide or reorder text: controls, format characters such
// as direction overrides and zero-width marks, line and paragraph separators,
// and other default-ignorable code points such as fillers.
const HIDDEN_TEXT = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Default_Ignorable_Code_Point}]/u;

/** A name an agent gave itself, as dohc shows it: none when a character in it
 * could hide or reorder text, so it can't pass for another name. */
export function shownAgentName(name: string | undefined): string | undefined {
  return name === undefined || HIDDEN_TEXT.test(name) ? undefined : name;
}

const EVERY_HIDDEN_TEXT = new RegExp(HIDDEN_TEXT.source, "gu");
/** JSON as dohc shows it, such as a change's details: each character that could
 * hide or reorder text written as its `\uXXXX` escape, so the text still parses
 * as the same JSON. Line breaks stay. */
export function escapeHiddenText(json: string): string {
  return json.replace(EVERY_HIDDEN_TEXT, (char) => char === "\n" ? char
    : char.split("").map((unit) => `\\u${unit.charCodeAt(0).toString(16).padStart(4, "0")}`).join(""));
}

/** Whether an agent id is a connected agent's: one writing outside a run dohc
 * started, which is the unnamed agent whatever name it gave. A chat post
 * names its run's agent as `authorAgentId`, History and sync pauses as
 * `agentId`. */
export function isConnectedAgentId(agentId: string | undefined): boolean {
  return canonicalClaimedName(agentId) === UNNAMED_AGENT_ID;
}
