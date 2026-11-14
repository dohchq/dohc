import { z } from "zod";

// A live note's file that changed outside dohc. Neither the note nor History
// holds those bytes; only the file does, until it matches the note again or
// someone keeps them as a copy.
export const OutsideChange = z
  .object({ path: z.string().min(1), firstObservedAtMs: z.number().int() })
  .strict();
export type OutsideChange = z.infer<typeof OutsideChange>;

export const OutsideChangesInput = z.object({}).strict();
export const OutsideChangesResult = z.object({ outsideChanges: z.array(OutsideChange) }).strict();
export type OutsideChangesResult = z.infer<typeof OutsideChangesResult>;
