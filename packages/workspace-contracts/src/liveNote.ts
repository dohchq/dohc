import { z } from "zod";

export const LiveNoteRecord = z
  .object({
    generation: z.number().int().nonnegative().safe(),
    state: z.enum(["off", "starting", "live", "stopping"]),
    reason: z.enum(["never", "stopped", "paused", "access-ended", "start-failed"]).nullable(),
    cause: z.enum(["refused", "no-lineage", "failing"]).nullable(),
    since: z.iso.datetime(),
    changedBy: z.string().min(1),
  })
  .strict();
export type LiveNoteRecord = z.infer<typeof LiveNoteRecord>;

export const LiveNoteAction = z.enum(["stop", "resume"]);
export type LiveNoteAction = z.infer<typeof LiveNoteAction>;
