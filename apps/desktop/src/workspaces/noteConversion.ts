import { z } from "zod";
import type { ConvertNotesResult } from "@dohc/workspace-contracts/note-format";
import type { CloudCredentials } from "./cloudCredentialStore";
import { localPersonOwnsWorkspace } from "./localPersonOwns";
import type { RegistryEntry } from "./registryStore";
import { shareViewIsPresent } from "./shareViewMarker";

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
export const NOTE_CONVERSION_SIGNED_OUT =
  "dohc could not convert notes. Sign in to the account that synced this workspace, then try again.";
export const NOTE_CONVERSION_SHARED_VIEW =
  "This is a shared view. Only the original workspace converts its notes.";
const NOTE_CONVERSION_SYNCED_BEFORE =
  "dohc could not convert notes because this folder synced before. Turn sync back on in Settings, then try again.";

type ConvertingWorkspace = Pick<RegistryEntry, "remote" | "pausedRemote" | "shareView">;

type Env = Readonly<Record<string, string | undefined>>;

export function engineNoteBodySequence(env: Env): string {
  return env.DOHC_ENGINE_NOTE_BODY_SEQUENCE ?? "1";
}

export function noteConversionOffered(
  env: Env,
  workspace: ConvertingWorkspace,
  credentials: CloudCredentials | null,
): boolean {
  return engineNoteBodySequence(env) === "1" && localPersonOwnsWorkspace(workspace, credentials);
}

export function noteConversionReach(
  workspace: ConvertingWorkspace,
  credentials: CloudCredentials | null,
): "local" | "relay" {
  if (shareViewIsPresent(workspace.shareView)) throw new Error(NOTE_CONVERSION_SHARED_VIEW);
  if (credentials === null && (workspace.remote ?? workspace.pausedRemote))
    throw new Error(NOTE_CONVERSION_SIGNED_OUT);
  if (!localPersonOwnsWorkspace(workspace, credentials)) throw new Error(NOTE_CONVERSION_NOT_OWNER);
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
type EnginePass = z.output<typeof EnginePass>;

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
  convert(params: {
    after?: string;
    objectId?: string;
    budget: number;
    relayLive?: string[];
  }): Promise<unknown>;
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

const emptyResult = (): ConvertNotesResult => ({
  converted: 0,
  unchanged: 0,
  skipped: [],
  doesNotFit: [],
  failed: [],
  sent: true,
});

const sent = (relay: NoteConversionRelay) =>
  relay.drainRecorded().then(
    () => true,
    () => false,
  );

function addPass(result: ConvertNotesResult, pass: EnginePass): void {
  if (pass.off) throw new Error(NOTE_CONVERSION_OFF);
  result.converted += pass.converted;
  result.unchanged += pass.unchanged;
  result.skipped.push(...pass.skipped.map(({ path, reason }) => ({ path, reason })));
  result.doesNotFit.push(...pass.doesNotFit.map(({ path }) => ({ path })));
  result.failed.push(...pass.failed.map(({ path, reason }) => ({ path, reason })));
}

type Retried = ConvertNotesResult | null;

export function createNoteConversion(batch = NOTE_CONVERSION_BATCH) {
  const running = new Set<string>();
  const turns = new Map<string, Promise<unknown>>();
  const openHere = new Map<string, Map<string, string>>();
  const inTurn = <T>(workspaceId: string, work: () => Promise<T>): Promise<T> => {
    const turn = (turns.get(workspaceId) ?? Promise.resolve()).catch(() => undefined).then(work);
    turns.set(workspaceId, turn);
    return turn;
  };

  const closed = (
    workspaceId: string,
    path: string,
    withRun: (use: (run: NoteConversionRun) => Promise<Retried>) => Promise<Retried>,
  ): Promise<Retried> =>
    inTurn(workspaceId, async () => {
      const objectId = openHere.get(workspaceId)?.get(path);
      if (objectId === undefined) return null;
      return withRun(async (run) => {
        run.assertCurrent();
        const { relay } = run;
        if (relay) await relay.drainRecorded();
        const relayLive = relay ? { relayLive: await liveAboveFloor(relay) } : {};
        run.assertCurrent();
        const pass = EnginePass.parse(await run.convert({ objectId, budget: 1, ...relayLive }));
        if (pass.skipped.some(({ reason }) => reason === "open-here")) return null;
        const result = emptyResult();
        addPass(result, pass);
        openHere.get(workspaceId)?.delete(path);
        if (relay && result.converted > 0) result.sent = await sent(relay);
        return result;
      }).catch((error: unknown) => ({
        ...emptyResult(),
        failed: [{ path, reason: error instanceof Error ? error.message : String(error) }],
      }));
    });

  async function convertNotes(
    workspaceId: string,
    run: NoteConversionRun,
  ): Promise<ConvertNotesResult> {
    if (running.has(workspaceId)) throw new Error(NOTE_CONVERSION_RUNNING);
    running.add(workspaceId);
    try {
      return await inTurn(workspaceId, () => convertAll(workspaceId, run));
    } finally {
      running.delete(workspaceId);
    }
  }

  async function convertAll(
    workspaceId: string,
    run: NoteConversionRun,
  ): Promise<ConvertNotesResult> {
    const here = new Map<string, string>();
    const { relay } = run;
    run.assertCurrent();
    if (relay) {
      await liveAboveFloor(relay);
      await relay.drainRecorded();
    }
    const result = emptyResult();
    const report = (done: number, total: number) => {
      try {
        run.progress?.(done, total);
      } catch {}
    };
    try {
      let after: string | undefined;
      let more = true;
      while (more) {
        run.assertCurrent();
        const relayLive = relay ? { relayLive: await liveAboveFloor(relay) } : {};
        const before = result.converted;
        for (let note = 0; note < batch && more; note += 1) {
          run.assertCurrent();
          const pass = EnginePass.parse(
            await run.convert({
              ...(after === undefined ? {} : { after }),
              budget: 1,
              ...relayLive,
            }),
          );
          addPass(result, pass);
          for (const { objectId, path, reason } of pass.skipped)
            if (reason === "open-here") here.set(path, objectId);
          const done =
            result.converted +
            result.unchanged +
            result.skipped.length +
            result.doesNotFit.length +
            result.failed.length;
          report(done, Math.max(done, pass.total));
          if (pass.resumeAfter === null) more = false;
          else if (pass.resumeAfter === after) throw new Error(NOTE_CONVERSION_STUCK);
          else after = pass.resumeAfter;
        }
        if (more && relay && result.converted > before) await relay.drainRecorded();
      }
    } catch (error) {
      if (error instanceof Error && error.message === "note-format-two-relay-unchecked")
        throw new Error(NOTE_CONVERSION_SYNCED_BEFORE, { cause: error });
      if (result.converted === 0) throw error;
      openHere.set(workspaceId, here);
      return {
        ...result,
        sent: false,
        stopped: error instanceof Error ? error.message : String(error),
      };
    }
    openHere.set(workspaceId, here);
    if (relay && result.converted > 0) result.sent = await sent(relay);
    return result;
  }

  return Object.assign(convertNotes, { closed });
}
