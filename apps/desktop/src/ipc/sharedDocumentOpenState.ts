import { z } from "zod";

export const SharedDocumentOpenState = z.object({
  state: z.enum(["pending", "offline", "refused", "access-ended", "failed", "host-refused"]),
  message: z.string().min(1),
  /** Why the server's live host would not take the document, for a `host-refused` open. */
  reason: z.string().min(1).optional(),
});
export type SharedDocumentOpenState = z.infer<typeof SharedDocumentOpenState>;

export class SharedDocumentWaitingError extends Error {
  constructor(readonly waiting: SharedDocumentOpenState) {
    super(waiting.message);
  }
}
