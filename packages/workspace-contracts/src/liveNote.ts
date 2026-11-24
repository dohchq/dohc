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

// `already` when the server says the document was already live, so this Resume changed nothing.
// `ended`: the note's file was moved, deleted or replaced, so the server's pause ended and nothing started.
export const ResumeOwnerLiveDocumentResult = z
  .object({ already: z.literal(true).optional(), ended: z.literal(true).optional() })
  .strict();
export type ResumeOwnerLiveDocumentResult = z.infer<typeof ResumeOwnerLiveDocumentResult>;
