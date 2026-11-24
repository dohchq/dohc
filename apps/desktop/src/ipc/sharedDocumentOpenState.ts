import { z } from "zod";
import { joinedByAnother } from "./joinedAccountWords";

export const SharedDocumentOpenState = z.object({
  state: z.enum([
    "pending",
    "offline",
    "refused",
    "access-ended",
    "failed",
    "host-refused",
    "other-account",
  ]),
  message: z.string().min(1),
  /** Why the open failed or the server's live host would not take the document, for a `failed` or `host-refused` open. */
  reason: z.string().min(1).optional(),
  /** The host takes the document once its owner's desktop starts its live history, so the open waits for the host, not Try again. */
  awaitsHost: z.literal(true).optional(),
});
export type SharedDocumentOpenState = z.infer<typeof SharedDocumentOpenState>;

/** A joined page opened while an account other than the one that joined is signed in. The workspace's notice offers Switch account. */
export function otherAccountOpen(email: string | null | undefined): SharedDocumentOpenState {
  return {
    state: "other-account",
    message: `${joinedByAnother(email)} You can still read this page.`,
  };
}

export class SharedDocumentWaitingError extends Error {
  constructor(readonly waiting: SharedDocumentOpenState) {
    super(waiting.message);
  }
}

/** Whether a toast and a Notices row say why the open could not edit, so the page itself says only what it allows. */
export function sharedOpenNoticed(waiting: SharedDocumentOpenState | null | undefined): boolean {
  return waiting?.state === "failed" || waiting?.state === "host-refused";
}

/**
 * The page's own line for a shared open that is not live, in share-web's
 * words: why it is read-only. A page waiting for its owner's dohc says only
 * what it waits for, beside its ring.
 */
export function sharedWaitingLine(
  waiting: SharedDocumentOpenState | null | undefined,
): string | undefined {
  if (!waiting || !sharedOpenNoticed(waiting)) return waiting?.message;
  if (waiting.awaitsHost && waiting.reason) return waiting.reason;
  return `${waiting.reason ?? waiting.message} You can still read it.`;
}
