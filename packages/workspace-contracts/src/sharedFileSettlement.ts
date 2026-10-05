import { z } from "zod";

export const SharedFileUpdateSchema = z.object({
  outboxId: z.string().nullable(),
  binding: z.object({ workspaceId: z.string(), mainVersionId: z.string(), objectId: z.string(),
    lineageClaimId: z.string(), currentPath: z.string(), selectorPaths: z.array(z.string()).readonly(),
    restoreFenceGeneration: z.number().int().nonnegative() }),
  nativeHeadSequence: z.number().int().nonnegative(),
  appendKey: z.string().min(1),
});
export const UndoWriteSchema = z.object({ recordId: z.string(), field: z.string(), draft: SharedFileUpdateSchema });
export const SharedReversalsSchema = z.array(UndoWriteSchema.extend({ state: z.enum(["pending", "not-accepted"]) }));
export type SharedFileUpdate = z.infer<typeof SharedFileUpdateSchema>;
export type UndoWrite = z.infer<typeof UndoWriteSchema>;
