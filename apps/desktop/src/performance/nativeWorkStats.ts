import { z } from "zod";
import type { NativeFileWorkSnapshot } from "@dohc/workspace-engine-client/daemon";

const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const work = z.object({
  started: count, active: count, completed: count, cancelled: count, failed: count,
  boundsExceeded: count, entriesVisited: count, filesEnumerated: count,
  hashesReused: count, hashAttemptsCompleted: count, bytesReadForHashing: count,
}).passthrough();
export const NativeWorkStatsResult = z.discriminatedUnion("status", [
  z.object({ workspaceId: z.string().min(1), status: z.literal("available"),
    stats: z.object({ generation: z.string().min(1), observation: work, capture: work }).passthrough() }),
  z.object({ workspaceId: z.string().min(1), status: z.literal("unavailable"), reason: z.string().min(1) }),
]);
export type NativeWorkStatsResult = z.infer<typeof NativeWorkStatsResult>;

const cumulativeFields = [
  "started", "completed", "cancelled", "failed", "boundsExceeded", "entriesVisited",
  "filesEnumerated", "hashesReused", "hashAttemptsCompleted", "bytesReadForHashing",
] as const satisfies readonly (keyof NativeFileWorkSnapshot)[];
type NativeCumulativeCounters = { -readonly [Field in Exclude<keyof NativeFileWorkSnapshot, "active">]: number };

export function nativeWorkStatsDelta(before: NativeWorkStatsResult, after: NativeWorkStatsResult) {
  if (!NativeWorkStatsResult.safeParse(before).success || !NativeWorkStatsResult.safeParse(after).success) {
    return { status: "unavailable" as const, reason: "Invalid native work snapshot." };
  }
  if (before.status !== "available" || after.status !== "available") {
    return { status: "unavailable" as const, reason: "Native work snapshot unavailable." };
  }
  if (before.workspaceId !== after.workspaceId) {
    return { status: "unavailable" as const, reason: "Native work snapshots target different workspaces." };
  }
  if (before.stats.generation !== after.stats.generation) {
    return { status: "unavailable" as const, reason: "Native work generation changed." };
  }
  const delta = {} as Record<"observation" | "capture", NativeCumulativeCounters>;
  const active = {} as Record<"observation" | "capture", { before: number; after: number }>;
  for (const lane of ["observation", "capture"] as const) {
    delta[lane] = {} as NativeCumulativeCounters;
    for (const field of [...cumulativeFields, "active"] as const) {
      const a = before.stats[lane][field], b = after.stats[lane][field];
      if (field !== "active" && b < a) {
        return { status: "unavailable" as const, reason: `Invalid native work counter: ${lane}.${field}.` };
      }
      if (field === "active") active[lane] = { before: a, after: b };
      else delta[lane][field] = b - a;
    }
  }
  return { status: "available" as const, generation: before.stats.generation, counters: delta, active };
}
