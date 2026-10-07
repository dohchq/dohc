import { z } from "zod";

export const SharedDocumentOpenState = z.object({
  state: z.enum(["pending", "offline", "refused", "access-ended", "failed"]),
  message: z.string().min(1),
});
export type SharedDocumentOpenState = z.infer<typeof SharedDocumentOpenState>;

export class SharedDocumentWaitingError extends Error {
  constructor(readonly waiting: SharedDocumentOpenState) { super(waiting.message); }
}
