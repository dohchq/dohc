import { classifyEngineFilePathForRead } from "@dohc/security-contract/engine-path-floor";
import { liveDocumentKindForPath } from "@dohc/workspace-contracts/live-documents";
import { WYSIWYG_MARKDOWN_THRESHOLD_BYTES } from "./workspaceTextLimits";

/** Starts live editing of notes written as files, one at a time once capture is quiet, so a phone can edit them. */
export interface BackgroundLiveStart {
  note(workspaceId: string, paths: readonly string[]): void;
  /** Forgets waiting notes and waits for the start in flight; one still checking its note is cancelled. */
  drop(workspaceId?: string): Promise<void>;
  /** Takes no notes until resume, and drops every waiting one. */
  pause(): Promise<void>;
  resume(): void;
  /** Takes no notes again, and waits for the start in flight to end. */
  stop(): Promise<void>;
}

export interface BackgroundLiveStartOptions {
  eligible(workspaceId: string): boolean;
  /** The note's object in the active version, or null when the engine doesn't track it. */
  noteIdentity(workspaceId: string, path: string): Promise<string | null>;
  showsOnPhone(workspaceId: string): Promise<boolean>;
  noteBytes(workspaceId: string, path: string): Promise<number | null>;
  isLossyNote(workspaceId: string, path: string): Promise<boolean>;
  start(workspaceId: string, path: string): Promise<void>;
  onError(message: string, error: unknown): void;
  quietMs?: number;
  maxWaitMs?: number;
  gapMs?: number;
}

/** A burst past this many notes leaves the rest to their next write or open. */
export const BACKGROUND_LIVE_START_MAX_QUEUED = 32;
export const BACKGROUND_LIVE_START_REMEMBERED = 1024;

interface QueuedNote {
  workspaceId: string;
  path: string;
}

interface InFlight {
  workspaceId: string;
  cancel: AbortController;
  ended: Promise<void>;
}

const keyOf = (workspaceId: string, path: string) => `${workspaceId}\u0000${path}`;

export function createBackgroundLiveStart(
  options: BackgroundLiveStartOptions,
): BackgroundLiveStart {
  const quietMs = options.quietMs ?? 5_000;
  const maxWaitMs = options.maxWaitMs ?? 60_000;
  const gapMs = options.gapMs ?? 1_000;
  const queued = new Map<string, QueuedNote>();
  const started = new Set<string>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let deadline = 0;
  let notBefore = 0;
  let quietUntil = 0;
  let inFlight: InFlight | undefined;
  let paused = false;
  let stopped = false;

  function schedule(delayMs: number): void {
    if (timer !== undefined) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = undefined;
      runOne();
    }, delayMs);
    timer.unref?.();
  }

  /** Waits for capture to go quiet, capped by the burst's deadline, and for the gap after the last start. */
  function scheduleNext(): void {
    const now = Date.now();
    schedule(Math.max(0, notBefore - now, Math.min(quietUntil, deadline) - now));
  }

  function remember(key: string): void {
    started.delete(key);
    started.add(key);
    if (started.size > BACKGROUND_LIVE_START_REMEMBERED)
      started.delete(started.values().next().value!);
  }

  async function startNote({ workspaceId, path }: QueuedNote, cancel: AbortSignal): Promise<void> {
    // Each check is left behind, not awaited, once the start is cancelled.
    const cancelled = new Promise<typeof cancel>((resolve) =>
      cancel.addEventListener("abort", () => resolve(cancel), { once: true }),
    );
    const check = async <T>(answer: Promise<T>): Promise<T | typeof cancel> =>
      await Promise.race([answer, cancelled]);

    if (!options.eligible(workspaceId)) return;
    // A live history belongs to an object in a version, so a new note at a reused path starts again.
    const identity = await check(options.noteIdentity(workspaceId, path));
    if (typeof identity !== "string" || started.has(keyOf(workspaceId, identity))) return;
    const shown = await check(options.showsOnPhone(workspaceId));
    if (shown !== true) return;
    const bytes = await check(options.noteBytes(workspaceId, path));
    // A note past the cap opens as a read preview, never live, so the phone keeps it read-only.
    if (typeof bytes !== "number" || bytes > WYSIWYG_MARKDOWN_THRESHOLD_BYTES) return;
    if ((await check(options.isLossyNote(workspaceId, path))) !== false) return;
    if (cancel.aborted || !options.eligible(workspaceId)) return;
    await options.start(workspaceId, path);
    // Remembered only when the path still holds the object checked above.
    const after = await options.noteIdentity(workspaceId, path).catch(() => null);
    if (after === identity) remember(keyOf(workspaceId, identity));
  }

  function runOne(): void {
    const next = queued.entries().next();
    if (stopped || paused || next.done) return;
    const [key, note] = next.value;
    queued.delete(key);
    const cancel = new AbortController();
    const ended = startNote(note, cancel.signal)
      .catch((error: unknown) => {
        options.onError(`[desktop] background live start of ${note.path} failed:`, error);
      })
      .finally(() => {
        inFlight = undefined;
        notBefore = Date.now() + gapMs;
        if (stopped || paused) return;
        if (queued.size > 0) scheduleNext();
        else deadline = 0;
      });
    inFlight = { workspaceId: note.workspaceId, cancel, ended };
  }

  async function drop(workspaceId?: string): Promise<void> {
    for (const [key, note] of queued)
      if (workspaceId === undefined || note.workspaceId === workspaceId) queued.delete(key);
    if (queued.size === 0) {
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
      deadline = 0;
    }
    const current = inFlight;
    if (!current || (workspaceId !== undefined && current.workspaceId !== workspaceId)) return;
    current.cancel.abort();
    await current.ended;
  }

  return {
    note(workspaceId, paths) {
      quietUntil = Date.now() + quietMs;
      if (stopped || paused || !options.eligible(workspaceId)) return;
      const before = queued.size;
      for (const path of paths) {
        if (queued.size >= BACKGROUND_LIVE_START_MAX_QUEUED) break;
        // A phone opens only Markdown notes the server shows, never a secret or ignored file.
        if (liveDocumentKindForPath(path) !== "richdoc") continue;
        if (classifyEngineFilePathForRead(path, process.platform).kind !== "tracked") continue;
        queued.set(keyOf(workspaceId, path), { workspaceId, path });
      }
      if (queued.size === 0) return;
      if (before === 0 && deadline === 0) deadline = Date.now() + maxWaitMs;
      // A note in flight schedules the next one when it ends.
      if (inFlight) return;
      scheduleNext();
    },
    drop,
    async pause() {
      paused = true;
      await drop();
    },
    resume() {
      paused = false;
    },
    async stop() {
      stopped = true;
      await drop();
    },
  };
}
