import { readError } from "../../ipc/errorWords";
import type { ErrorDetailField } from "../shell/copyDetails";
import type { PendingTreeChange } from "./file-tree-optimistic";

// One change in a batch that live editing or History off refused.
export type RefusedChange = {
  change: PendingTreeChange;
  // Where it ran in its batch, so its line keeps that order after Try again.
  order: number;
  // The identity a refusal of this change alone files under. Its later
  // success takes it out of the group.
  identity: string;
  // The path its line names: the page live editing holds, which a replace
  // names by its destination.
  path: string;
  live: boolean;
  // The row Open Live documents shows: a page, or null for a folder.
  reveal: string | null;
  retryable: boolean;
  cause: unknown;
};

// A batch's refusals: one notice. `went` counts the changes that went.
export type RefusedChanges = {
  identity: string;
  action: "delete" | "move";
  total: number;
  went: number;
  refusals: readonly RefusedChange[];
  // Reruns the retryable refusals. The rest stay in the notice it files.
  retry: (group: RefusedChanges) => void;
};

const HISTORY_OFF = "History is off";
const LIVE_EDITING = "Live editing is on";

// The notice's words: what went, then one line per reason, in the order the
// changes ran. Details keeps each refusal's full words, which the message's
// bound can cut.
export function refusedChangesWords(group: RefusedChanges): {
  title: string;
  message: string;
  details: ErrorDetailField[];
  reveal: string | null | undefined;
  retryable: boolean;
} {
  const { action, total, went } = group;
  const refusals = [...group.refusals].sort((a, b) => a.order - b.order);
  const title = went === 0
    ? `dohc could not ${action} ${total} items`
    : `dohc ${action === "delete" ? "deleted" : "moved"} ${went} of ${total} items`;
  const byReason = new Map<string, string[]>();
  for (const { path, live } of refusals) {
    const label = live ? LIVE_EDITING : HISTORY_OFF;
    byReason.set(label, [...(byReason.get(label) ?? []), path]);
  }
  const message = [...byReason]
    .map(([label, paths]) => `${label}: ${paths.join(", ")}${label === HISTORY_OFF ? ". Restart dohc, then try again." : ""}`)
    .join("\n");
  const details = refusals.map(({ path, cause }): ErrorDetailField => {
    const { title: refusal, words } = readError(cause);
    return [path, [refusal, words].filter(Boolean).join(". "), Number.POSITIVE_INFINITY];
  });
  return {
    title,
    message,
    details,
    reveal: refusals.find((refusal) => refusal.live)?.reveal,
    retryable: refusals.some((refusal) => refusal.retryable),
  };
}

// The group once the change filed under `identity` went, or null when it
// was the last.
export function withoutRefusal(group: RefusedChanges, identity: string): RefusedChanges | null {
  const refusals = group.refusals.filter((refusal) => refusal.identity !== identity);
  if (refusals.length === group.refusals.length) return group;
  return refusals.length === 0 ? null : { ...group, refusals, went: group.went + group.refusals.length - refusals.length };
}
