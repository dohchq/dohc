import type { LiveObjectBinding } from "@dohc/workspace-engine-client";
import type { EngineClient } from "@dohc/workspace-engine-client/daemon";
import { z } from "zod";

const cursor = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
/** One page of a retired note's saves after a cursor, up to the relay's last one. */
export const OwnerJournalPage = z
  .object({
    ok: z.literal(true),
    acceptedCursor: cursor,
    rows: z.array(
      z
        .object({
          journalCursor: cursor,
          rowsThrough: cursor.optional(),
          update: z.string().regex(/^[A-Za-z0-9+/]*={0,2}$/),
        })
        .strict(),
    ),
    nextAfter: cursor.nullable(),
  })
  .strict();
export type OwnerJournalPage = z.infer<typeof OwnerJournalPage>;
/** A page after `after`, or "not-retired" when the relay has not retired this lineage. */
export type OwnerJournalRead = (
  after: number,
  signal: AbortSignal,
) => Promise<OwnerJournalPage | "not-retired">;

/** The server has not finished retiring the note, so its saves can't all be read yet. */
export class OwnerJournalPending extends Error {
  constructor() {
    super("The server is still ending live editing for this note.");
  }
}

/**
 * Applies a retired note's saves that this computer has not applied, so a
 * release at the relay's last save writes all of them into the file. Returns
 * that last save's cursor, or null when the relay has not retired the note.
 * With `through`, the relay's last save already known from its Stop, a
 * computer that has applied it reads nothing, so it need not wait for the
 * relay to finish retiring the note.
 */
export async function catchUpFromJournal(options: {
  client: Pick<EngineClient, "ownerYDocReadState" | "ownerYDocApplyAcceptedFrame">;
  workspaceHandle: string;
  target: { binding: LiveObjectBinding; relayDatabaseNamespace: string };
  read: OwnerJournalRead;
  signal: AbortSignal;
  through?: number;
}): Promise<number | null> {
  const { client, target, signal } = options;
  const request = () => ({ id: 0, workspace: options.workspaceHandle, deadlineMs: 30_000 });
  let position: { revision: number; acceptedCursor: number; nativeHeadSequence: number } =
    await client.ownerYDocReadState(request(), target, signal);
  if (options.through !== undefined && position.acceptedCursor >= options.through)
    return position.acceptedCursor;
  let after: number | null = position.acceptedCursor,
    last: number | undefined;
  while (after !== null) {
    const page = await options.read(after, signal);
    if (page === "not-retired") return null;
    if ((last ?? page.acceptedCursor) !== page.acceptedCursor)
      throw new Error("The server's last save of this note changed.");
    last = page.acceptedCursor;
    for (const row of page.rows) {
      if (row.journalCursor <= position.acceptedCursor) continue;
      if (row.journalCursor > last) throw new Error("The server sent a save after its last one.");
      position = await client.ownerYDocApplyAcceptedFrame(
        request(),
        {
          ...target,
          expectedRevision: position.revision,
          expectedNativeHeadSequence: position.nativeHeadSequence,
          previousAcceptedCursor: position.acceptedCursor,
          journalCursor: row.journalCursor,
          updateBytes: Buffer.from(row.update, "base64"),
          ...(row.rowsThrough === undefined ? {} : { rowsThrough: row.rowsThrough }),
        },
        signal,
      );
    }
    if (page.nextAfter !== null && page.nextAfter <= after)
      throw new Error("The server's list of saves did not advance.");
    after = page.nextAfter;
  }
  return last ?? position.acceptedCursor;
}
