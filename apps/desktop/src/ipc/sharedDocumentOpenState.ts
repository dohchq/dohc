import { z } from "zod";

export const SharedDocumentOpenState = z.object({
  state: z.enum(["pending", "offline", "refused", "access-ended", "failed", "host-refused"]),
  message: z.string().min(1),
  /** Why the open failed or the server's live host would not take the document, for a `failed` or `host-refused` open. */
  reason: z.string().min(1).optional(),
  /** The host takes the document once its owner's desktop starts its live history, so the open waits for the host, not Try again. */
  awaitsHost: z.literal(true).optional(),
});
export type SharedDocumentOpenState = z.infer<typeof SharedDocumentOpenState>;

export class SharedDocumentWaitingError extends Error {
  constructor(readonly waiting: SharedDocumentOpenState) {
    super(waiting.message);
  }
}

/** Whether a toast and a Notices row say why the open could not edit, so the page itself says only what it allows. */
export function sharedOpenNoticed(waiting: SharedDocumentOpenState | null | undefined): boolean {
  return waiting?.state === "failed" || waiting?.state === "host-refused";
}

/** The page's own line for a shared open that is not live. */
export function sharedWaitingLine(waiting: SharedDocumentOpenState | null | undefined): string | undefined {
  return sharedOpenNoticed(waiting) ? "You can read this page." : waiting?.message;
}
