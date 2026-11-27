import { z } from "zod";
import type { ConvertNotesResult } from "@dohc/workspace-contracts/note-format";

export const NOTE_CONVERSION_BUDGET = 10;
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
  /** Pulls, then pushes until nothing recorded is left. Rejects when a pass fails. */
  pushRecorded(): Promise<void>;
}

export interface NoteConversionRun {
  /** Null for a local-only workspace. */
  relay: NoteConversionRelay | null;
  convert(params: { after?: string; budget: number; relayLive: string[] }): Promise<unknown>;
  /** Throws once the run's workspace is closed or its window switched away. */
  assertCurrent(): void;
  progress?(done: number, total: number): void;
}

export function floorRefusal(found: number | undefined): string {
  return `dohc could not convert notes. The relay's DOHC_RELAY_ENGINE_API_MIN is ${found ?? "not set"}; it must be ${RELAY_ENGINE_API_FLOOR}.`;
}

/**
 * Converts a workspace's notes in batches. Each batch reads which notes are
 * live on the relay first, and converted notes are pushed between batches and
 * at the end. A note the engine leaves or cannot read is listed; only a typed
 * engine error stops the run.
 */
export function createNoteConversion(budget = NOTE_CONVERSION_BUDGET) {
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
        await relay.pushRecorded();
      }
      const result: ConvertNotesResult = {
        converted: 0,
        unchanged: 0,
        skipped: [],
        doesNotFit: [],
        failed: [],
        sent: true,
      };
      let after: string | undefined;
      for (;;) {
        run.assertCurrent();
        const relayLive = relay ? await relay.liveNotes() : [];
        run.assertCurrent();
        const pass = EnginePass.parse(
          await run.convert({ ...(after === undefined ? {} : { after }), budget, relayLive }),
        );
        if (pass.off) throw new Error(NOTE_CONVERSION_OFF);
        result.converted += pass.converted;
        result.unchanged += pass.unchanged;
        result.skipped.push(...pass.skipped.map(({ path, reason }) => ({ path, reason })));
        result.doesNotFit.push(...pass.doesNotFit.map(({ path }) => ({ path })));
        result.failed.push(...pass.failed.map(({ path, reason }) => ({ path, reason })));
        const done =
          result.converted +
          result.unchanged +
          result.skipped.length +
          result.doesNotFit.length +
          result.failed.length;
        run.progress?.(done, Math.max(done, pass.total));
        if (pass.resumeAfter === null) break;
        after = pass.resumeAfter;
        if (relay && pass.converted > 0) await relay.pushRecorded().catch(() => undefined);
      }
      if (relay)
        result.sent = await relay.pushRecorded().then(
          () => true,
          () => false,
        );
      return result;
    } finally {
      running.delete(workspaceId);
    }
  };
}
