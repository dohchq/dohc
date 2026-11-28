import { z } from "zod";
import type { ConvertNotesResult } from "@dohc/workspace-contracts/note-format";

export const NOTE_CONVERSION_BATCH = 10;
export const RELAY_ENGINE_API_FLOOR = 2;
export const NOTE_CONVERSION_OFF =
  "dohc could not convert notes. This build does not convert notes yet.";
export const NOTE_CONVERSION_RUNNING = "dohc is already converting notes in this workspace.";
export const NOTE_CONVERSION_PAUSED =
  "dohc could not convert notes because sync is paused. Resume sync in Settings, then try again.";
const NOTE_CONVERSION_SYNC_STARTED = "Sync was turned on while dohc converted notes.";
export const RELAY_UNREACHABLE = "dohc could not reach the relay. Check your connection.";
const NOTE_CONVERSION_STUCK =
  "dohc could not convert notes because the engine did not move past the last note it read.";
export const NOTE_CONVERSION_NOT_OWNER =
  "dohc could not convert notes. Only the person who owns this workspace can convert its notes.";
export const NOTE_CONVERSION_SHARED_VIEW =
  "This is a shared view. Only the original workspace converts its notes.";

type ConvertingWorkspace = {
  sharedView: boolean;
  remote?: { ownerUserId: string };
  pausedRemote?: { ownerUserId: string };
};

function ownsNotes(workspace: ConvertingWorkspace, signedInUserId: string | null): boolean {
  const remote = workspace.remote ?? workspace.pausedRemote;
  return !remote || signedInUserId === null || remote.ownerUserId === signedInUserId;
}

/**
 * Whether Settings offers Convert notes: the engine main starts reads and
 * writes the new format, and this is not a shared view or another account's
 * synced workspace.
 */
export function noteConversionOffered(
  env: Readonly<Record<string, string | undefined>>,
  workspace: ConvertingWorkspace,
  signedInUserId: string | null,
): boolean {
  return (
    env.DOHC_ENGINE_NOTE_BODY_SEQUENCE === "1" &&
    env.DOHC_ENGINE_NEW_NOTE_BODY_SEQUENCE === "1" &&
    !workspace.sharedView &&
    ownsNotes(workspace, signedInUserId)
  );
}

/**
 * Whether a run converts this workspace alone or through its relay. Only the
 * owner's own synced workspace reaches the relay; a member's full copy, a
 * shared view and a paused workspace are refused.
 */
export function noteConversionReach(
  workspace: ConvertingWorkspace,
  signedInUserId: string | null,
): "local" | "relay" {
  if (workspace.sharedView) throw new Error(NOTE_CONVERSION_SHARED_VIEW);
  if (!ownsNotes(workspace, signedInUserId)) throw new Error(NOTE_CONVERSION_NOT_OWNER);
  if (workspace.pausedRemote && !workspace.remote) throw new Error(NOTE_CONVERSION_PAUSED);
  return workspace.remote ? "relay" : "local";
}

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

const LiveNotes = z.object({
  engineApiMin: z.unknown().optional(),
  notes: z.array(z.object({ objectId: z.string() })),
});

export interface NoteConversionRelay {
  liveNotes(): Promise<unknown>;
  drainRecorded(): Promise<void>;
}

export interface NoteConversionRun {
  relay: NoteConversionRelay | null;
  convert(params: { after?: string; budget: number; relayLive: string[] }): Promise<unknown>;
  assertCurrent(): void;
  progress?(done: number, total: number): void;
}

export function stopsOnceSyncStarts(assertCurrent: () => void, syncing: () => boolean): () => void {
  return () => {
    assertCurrent();
    if (syncing()) throw new Error(NOTE_CONVERSION_SYNC_STARTED);
  };
}

function floorRefusal(found: string): Error {
  return new Error(
    `dohc could not convert notes. The relay's DOHC_RELAY_ENGINE_API_MIN ${found}; it must be ${RELAY_ENGINE_API_FLOOR}.`,
  );
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

async function liveAboveFloor(relay: NoteConversionRelay): Promise<string[]> {
  let answer: unknown;
  try {
    answer = await relay.liveNotes();
  } catch (error) {
    if (error instanceof TypeError || (error instanceof Error && error.name === "TimeoutError"))
      throw new Error(RELAY_UNREACHABLE, { cause: error });
    throw error;
  }
  const live = LiveNotes.safeParse(answer);
  if (!live.success) throw new Error("dohc could not read which notes are open on the relay.");
  const { engineApiMin, notes } = live.data;
  if (engineApiMin === undefined || engineApiMin === null) throw floorRefusal("is not set");
  if (typeof engineApiMin !== "number" || !Number.isInteger(engineApiMin))
    throw floorRefusal("is not a valid number");
  if (engineApiMin < RELAY_ENGINE_API_FLOOR) throw floorRefusal(`is ${engineApiMin}`);
  return notes.map(({ objectId }) => objectId);
}

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
        await liveAboveFloor(relay);
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
          const relayLive = relay ? await liveAboveFloor(relay) : [];
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
            const done =
              result.converted +
              result.unchanged +
              result.skipped.length +
              result.doesNotFit.length +
              result.failed.length;
            run.progress?.(done, Math.max(done, pass.total));
            if (pass.resumeAfter === null) more = false;
            else if (pass.resumeAfter === after) throw new Error(NOTE_CONVERSION_STUCK);
            else after = pass.resumeAfter;
          }
          if (more && relay && result.converted > before) await relay.drainRecorded();
        }
      } catch (error) {
        throw stoppedAfter(error, result.converted);
      }
      if (relay && result.converted > 0)
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
