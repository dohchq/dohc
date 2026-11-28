import { z } from "zod";
import type { ConvertNotesResult } from "@dohc/workspace-contracts/note-format";

export const NOTE_CONVERSION_BATCH = 10;
export const RELAY_ENGINE_API_FLOOR = 2;
export const NOTE_CONVERSION_OFF =
  "dohc could not convert notes. This build does not convert notes yet.";
export const NOTE_CONVERSION_RUNNING = "dohc is already converting notes in this workspace.";

const Note = z.object({ objectId: z.string(), path: z.string() });
const EnginePass = z.object({
  off: z.boolean(),
  converted: z.number().int().nonnegative(),
  unchanged: z.number().int().nonnegative(),
  skipped: z.array(Note.extend({ reason: z.string() })),
  doesNotFit: z.array(Note),
  failed: z.array(Note.extend({ reason: z.string() })),
  resumeAfter: z.string().nullable(),
  total: z.number().int().nonnegative(),
});

export interface NoteConversionRelay {
  /** The relay's `/ready` floor, or undefined when it names none. */
  engineApiMin(): Promise<number | undefined>;
  /** Object ids of the owner's notes the relay holds live. */
  liveNotes(): Promise<string[]>;
  /** Resolves only once a push reports nothing recorded is left. */
  drainRecorded(): Promise<void>;
}

export interface NoteConversionRun {
  /** Null for a local-only workspace. */
  relay: NoteConversionRelay | null;
  convert(params: { after?: string; budget: number; relayLive: string[] }): Promise<unknown>;
  /** Throws once the run's workspace is closed or its window switched away. */
  assertCurrent(): void;
}

export function floorRefusal(found: number | undefined): string {
  return `dohc could not convert notes. The relay's DOHC_RELAY_ENGINE_API_MIN is ${found ?? "not set"}; it must be ${RELAY_ENGINE_API_FLOOR}.`;
}

function stoppedAfter(error: unknown, converted: number): unknown {
  if (converted === 0) return error;
  const words = error instanceof Error ? error.message : String(error);
  const notes = converted === 1 ? "1 note" : `${converted.toLocaleString("en-US")} notes`;
  return new Error(
    `${words} dohc converted ${notes} before it stopped. Run Convert notes again to finish.`,
    { cause: error },
  );
}

/**
 * Converts a workspace's notes one at a time, in batches. Each batch reads
 * which notes are live on the relay first, and converted notes are drained
 * between batches and at the end. A note the engine leaves or cannot read is
 * listed; any other failure stops the run and says how many notes it
 * converted.
 */
export function createNoteConversion(batch = NOTE_CONVERSION_BATCH) {
  const running = new Set<string>();
  return async function convertNotes(
    workspaceId: string,
    run: NoteConversionRun,
  ): Promise<ConvertNotesResult> {
    if (running.has(workspaceId)) throw new Error(NOTE_CONVERSION_RUNNING);
    running.add(workspaceId);
    try {
      const { relay } = run;
      run.assertCurrent();
      if (relay) {
        const floor = await relay.engineApiMin();
        if (floor === undefined || floor < RELAY_ENGINE_API_FLOOR)
          throw new Error(floorRefusal(floor));
        await relay.drainRecorded();
      }
      const result: ConvertNotesResult = {
        converted: 0,
        unchanged: 0,
        skipped: [],
        doesNotFit: [],
        failed: [],
        sent: true,
      };
      try {
        let after: string | undefined;
        let more = true;
        while (more) {
          run.assertCurrent();
          const relayLive = relay ? await relay.liveNotes() : [];
          const before = result.converted;
          for (let note = 0; note < batch && more; note += 1) {
            run.assertCurrent();
            const pass = EnginePass.parse(
              await run.convert({
                ...(after === undefined ? {} : { after }),
                budget: 1,
                relayLive,
              }),
            );
            if (pass.off) throw new Error(NOTE_CONVERSION_OFF);
            result.converted += pass.converted;
            result.unchanged += pass.unchanged;
            result.skipped.push(...pass.skipped.map(({ path, reason }) => ({ path, reason })));
            result.doesNotFit.push(...pass.doesNotFit.map(({ path }) => ({ path })));
            result.failed.push(...pass.failed.map(({ path, reason }) => ({ path, reason })));
            if (pass.resumeAfter === null) more = false;
            else after = pass.resumeAfter;
          }
          if (more && relay && result.converted > before)
            await relay.drainRecorded().catch(() => undefined);
        }
      } catch (error) {
        throw stoppedAfter(error, result.converted);
      }
      if (relay)
        result.sent = await relay.drainRecorded().then(
          () => true,
          () => false,
        );
      return result;
    } finally {
      running.delete(workspaceId);
    }
  };
}
