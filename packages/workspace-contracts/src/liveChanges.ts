import { z } from "zod";
import { ChangeAuthor } from "./changeAuthor";

export const LiveChangeAction = z.enum(["stopped", "resumed"]);
export type LiveChangeAction = z.infer<typeof LiveChangeAction>;

// The relay's status of an owner live document when a change begins. "absent": the relay listed no such document.
export const LiveDocumentStatus = z.enum(["ready", "preparing", "paused", "retired", "unavailable", "absent"]);
export type LiveDocumentStatus = z.infer<typeof LiveDocumentStatus>;

const AtMs = z.number().int().nonnegative();
export const LastLiveChange = z.object({
  action: LiveChangeAction, path: z.string().min(1), atMs: AtMs, author: ChangeAuthor,
}).strict();
export type LastLiveChange = z.infer<typeof LastLiveChange>;
export const PendingLiveChange = LastLiveChange.extend({ changeId: z.string().min(1) });
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
 * Settles a change an interrupted action left pending: "refused", or null to
 * leave it to Stop reconciliation.
 *
 * Only an action's own response credits it, since the relay keeps no author:
 * a Stop, ended access and account deletion all retire a document, and a
 * Resume and a share's enrollment both make one ready. So a change is never
 * applied here. A Stop this computer still owes waits for reconciliation to
 * send it again, which must first read the document and refuse the change
 * when the relay already shows it retired, since the relay answers a Stop of
 * a retired document as it answers one that retires it. Every other change
 * is refused rather than left pending, since nothing later would settle it.
 * Skip changes this dohc is still making.
 */
export function liveChangeOutcome(pending: Pick<PendingLiveChange, "action">, facts: { stopOwed: boolean }): "refused" | null {
  return pending.action === "stopped" && facts.stopOwed ? null : "refused";
}
