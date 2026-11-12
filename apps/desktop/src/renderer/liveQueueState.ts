import type { OwnerLiveQuarantine } from "../ipc/bridgeContract";

type Recovery = OwnerLiveQuarantine["recovery"];

// Each state of a queue of edits the server refused: whether it still holds
// the note's current edits, so the note takes no more, and the label Live
// documents shows. A finished Stop has released the note. A new state fails
// to compile here until someone decides both.
const STATES = {
  paused: { holds: true, label: "Paused" },
  // A recovery copy is saved, and the server still holds the queue.
  copied: { holds: true, label: "Paused" },
  retrying: { holds: true, label: "Trying again" },
  stopping: { holds: true, label: "Stopping" },
  unreadable: { holds: true, label: "Can't read edits" },
  "stopped-kept": { holds: false, label: "Stopped" },
  // The note's own row says whether it is live now.
  "not-written": { holds: false, label: null },
  "cannot-write": { holds: false, label: null },
} as const satisfies Record<Recovery, { holds: boolean; label: string | null }>;

export type KeptEditsRow = { recovery: Recovery; saveOnly?: true; earlier?: true };

// A row kept after a restore, or in an earlier copy of the workspace, holds
// none of the note's current edits.
export function queueHoldsNote(row: KeptEditsRow): boolean {
  return !row.saveOnly && !row.earlier && STATES[row.recovery].holds;
}

// Live documents' label for a row with kept edits, or null when the row's
// live state names it. Only a row that holds the note says Paused, Trying
// again or Stopping, the states the note's editor is read-only in.
export function keptEditsLabel(row: KeptEditsRow): string | null {
  if (queueHoldsNote(row)) return STATES[row.recovery].label;
  if (row.recovery === "unreadable") return "Can't read edits";
  if (row.earlier) return "Kept on the server";
  if (row.saveOnly) return "Not written";
  return STATES[row.recovery].label;
}
