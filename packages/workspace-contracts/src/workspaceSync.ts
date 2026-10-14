import { z } from "zod";

// Local pause provenance grants no workspace or relay authority.
export const WorkspaceSyncPauseAuthor = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("human"), humanId: z.string().min(1), displayName: z.string().min(1) }).strict(),
  z.object({ kind: z.literal("agent"), agentId: z.string().min(1), onBehalfOf: z.string().min(1), depth: z.number().int().nonnegative() }).strict(),
]);
export type WorkspaceSyncPauseAuthor = z.infer<typeof WorkspaceSyncPauseAuthor>;

export const WorkspaceSyncPause = z.object({
  atMs: z.number().int().nonnegative(),
  author: WorkspaceSyncPauseAuthor,
}).strict();
export type WorkspaceSyncPause = z.infer<typeof WorkspaceSyncPause>;
