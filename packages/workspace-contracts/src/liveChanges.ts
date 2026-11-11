import { z } from "zod";
import { ChangeAuthor } from "./changeAuthor";

export const LiveChangeAction = z.enum(["stopped", "resumed"]);
export type LiveChangeAction = z.infer<typeof LiveChangeAction>;

// The relay's status of an owner live document. "absent": a complete list did not include it.
export const LiveDocumentStatus = z.enum(["ready", "preparing", "paused", "retired", "unavailable", "absent"]);
export type LiveDocumentStatus = z.infer<typeof LiveDocumentStatus>;

const AtMs = z.number().int().nonnegative();
export const LastLiveChange = z.object({
  action: LiveChangeAction, path: z.string().min(1), atMs: AtMs, author: ChangeAuthor,
}).strict();
export type LastLiveChange = z.infer<typeof LastLiveChange>;
// `before` is the relay's status when the change began.
export const PendingLiveChange = LastLiveChange.extend({ changeId: z.string().min(1), before: LiveDocumentStatus });
export type PendingLiveChange = z.infer<typeof PendingLiveChange>;
export const LiveDocumentChanges = z.object({
  objectId: z.string().min(1), pending: PendingLiveChange.optional(), last: LastLiveChange.optional(),
}).strict();
export type LiveDocumentChanges = z.infer<typeof LiveDocumentChanges>;
// The engine's replies to begin and list.
export const BegunLiveChange = z.object({ changeId: z.string().min(1), atMs: AtMs }).strict();
export type BegunLiveChange = z.infer<typeof BegunLiveChange>;
export const LiveChangeList = z.object({ changes: z.array(LiveDocumentChanges) }).strict();

/** The relay already shows what the action would produce, so the action changes nothing. */
export function liveChangeAlreadyShown(action: LiveChangeAction, status: LiveDocumentStatus): boolean {
  return action === "stopped" ? status === "retired" : status === "ready" || status === "preparing";
}

/**
 * Settles a change an interrupted action left pending, from the relay's status
 * now: "applied", "refused", or null to wait for more evidence.
 *
 * No relay status proves which actor caused it: a Stop, ended access and
 * account deletion all retire a document, and Resume, a share's enrollment
 * and its Try again all make one ready. So only a Stop this computer still
 * owes is credited with `retired`; it waits on any other status while Stop
 * reconciliation sends it again. Every other change is refused rather than
 * left pending, since nothing later would settle it. `status` is undefined
 * when the relay's list did not include the document; with `complete`, that
 * list was whole, so the document is not there.
 */
export function liveChangeOutcome(
  pending: Pick<PendingLiveChange, "action" | "before">,
  status: LiveDocumentStatus | undefined,
  facts: { stopOwed: boolean; complete: boolean },
): "applied" | "refused" | null {
  const now = status ?? (facts.complete ? "absent" : undefined);
  if (now === undefined) return null;
  if (liveChangeAlreadyShown(pending.action, pending.before)) return "refused";
  if (pending.action === "resumed" || !facts.stopOwed || now === "absent") return "refused";
  return now === "retired" ? "applied" : null;
}
