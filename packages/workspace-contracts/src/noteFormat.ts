import { z } from "zod";

/** How long the CLI and MCP wait for a conversion run. */
export const NOTE_CONVERSION_DEADLINE_MS = 600_000;

const LeftNote = z.object({ path: z.string(), reason: z.string() }).strict();

export const ConvertNotesResult = z
  .object({
    converted: z.number().int().nonnegative(),
    unchanged: z.number().int().nonnegative(),
    skipped: z.array(LeftNote),
    doesNotFit: z.array(z.object({ path: z.string() }).strict()),
    failed: z.array(LeftNote),
    sent: z.boolean(),
  })
  .strict();
export type ConvertNotesResult = z.output<typeof ConvertNotesResult>;

const HISTORY_INCOMPLETE = "History incomplete";

/** The group each reason the conversion pass skips a note for is listed under. */
export const SKIPPED_NOTE_GROUPS: Readonly<Record<string, string>> = {
  "open-here": "Open on this computer",
  "open-elsewhere": "Open elsewhere",
  held: "Held",
  "open-conflict": "Waiting on a review",
  "unsent-edit": "Unsent edits",
  "ydoc-unsettled": "Not saved to disk yet",
  "ydoc-lineage-unclaimed": HISTORY_INCOMPLETE,
  "ydoc-incomplete-lineage": HISTORY_INCOMPLETE,
  "ydoc-deferred-updates-pending": HISTORY_INCOMPLETE,
  "ydoc-artifact-pending": HISTORY_INCOMPLETE,
};

export interface LeftNoteGroup {
  title: string;
  notes: { path: string; reason?: string }[];
}

/** The notes a run left as they were, grouped as Notices and the CLI list them. */
export function leftNoteGroups(result: ConvertNotesResult): LeftNoteGroup[] {
  const groups = new Map<string, LeftNoteGroup["notes"]>();
  const add = (title: string, note: LeftNoteGroup["notes"][number]) => {
    const notes = groups.get(title);
    if (notes) notes.push(note);
    else groups.set(title, [note]);
  };
  for (const { path, reason } of result.skipped) {
    const title = Object.hasOwn(SKIPPED_NOTE_GROUPS, reason) ? SKIPPED_NOTE_GROUPS[reason] : null;
    if (title) add(title, { path });
    else add("Could not be read", { path, reason });
  }
  for (const { path } of result.doesNotFit) add("Doesn't fit the new format", { path });
  for (const { path, reason } of result.failed) add("Could not be read", { path, reason });
  return [...groups].map(([title, notes]) => ({ title, notes }));
}

export function leftNoteCount(result: ConvertNotesResult): number {
  return result.skipped.length + result.doesNotFit.length + result.failed.length;
}
