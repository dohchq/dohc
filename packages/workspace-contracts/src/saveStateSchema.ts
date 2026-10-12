import { z } from "zod";

const problem = { reason: z.string(), issueId: z.string().nullable() };

export const SaveStateSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("unknown") }),
  z.object({ kind: z.literal("saving") }),
  z.object({ kind: z.literal("saved-here") }),
  z.object({ kind: z.literal("saved-to-host") }),
  z.object({ kind: z.literal("pending-share") }),
  z.object({ kind: z.literal("file-locked"), ...problem }),
  z.object({ kind: z.literal("changed-on-disk"), ...problem }),
  z.object({ kind: z.literal("error"), ...problem }),
]);
