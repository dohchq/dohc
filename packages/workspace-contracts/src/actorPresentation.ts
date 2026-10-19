// Frozen relay slots. Olive belongs to the agent default.
export const ACTOR_HUES = ["rust", "amber", "teal", "blue", "indigo", "plum", "rose"] as const;

/** Unsigned FNV-1a32 over code points, without normalization. */
export function actorHueSlot(value: string): number {
  let hash = 2166136261;
  for (const point of value) hash = Math.imul(hash ^ point.codePointAt(0)!, 16777619) >>> 0;
  return hash % ACTOR_HUES.length;
}
