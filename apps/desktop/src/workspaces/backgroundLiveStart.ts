import { classifyEngineFilePathForRead } from "@dohc/security-contract/engine-path-floor";
import { liveDocumentKindForPath } from "@dohc/workspace-contracts/live-documents";
import { WYSIWYG_MARKDOWN_THRESHOLD_BYTES } from "./workspaceTextLimits";

/**
 * Starts live editing in the background for notes written as files, such as
 * one an agent just wrote, so a phone can edit them without a computer
 * opening each one first. One note at a time, once capture has been quiet.
 */
export interface BackgroundLiveStart {
  /** Capture recorded these paths in the workspace. */
  note(workspaceId: string, paths: readonly string[]): void;
  /**
   * Forgets the notes waiting in one workspace, or in all of them, and waits
   * for the start in flight there to end. A start still checking its note is
   * cancelled; one already opening the note finishes.
   */
  drop(workspaceId?: string): Promise<void>;
  /** Takes no notes until resume, and drops every waiting one. */
  pause(): Promise<void>;
  resume(): void;
  /** Takes no notes again, and waits for the start in flight to end. */
  stop(): Promise<void>;
}

export interface BackgroundLiveStartOptions {
  /** Whether the workspace's notes may start live editing: it is open and syncs with its owner's server. */
  eligible(workspaceId: string): boolean;
  /** Whether the owner's server confirms the workspace shows on the phone. */
  showsOnPhone(workspaceId: string): Promise<boolean>;
  /** The note file's size in bytes, or null when it is gone. */
  noteBytes(workspaceId: string, path: string): Promise<number | null>;
  /** Whether the note is a lossy note (CONTEXT.md), which never starts here. */
  isLossyNote(workspaceId: string, path: string): Promise<boolean>;
  start(workspaceId: string, path: string): Promise<void>;
  onError(message: string, error: unknown): void;
  /** How long capture stays quiet before the first note starts. */
  quietMs?: number;
  /** The longest a queued note waits for quiet. */
  maxWaitMs?: number;
  /** The pause between two notes. */
  gapMs?: number;
}

/** A burst past this many notes leaves the rest to their next write or open. */
export const BACKGROUND_LIVE_START_MAX_QUEUED = 32;
/** Notes this run already started, so another write to one costs nothing. */
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

  function remember(key: string): void {
    started.delete(key);
    started.add(key);
    if (started.size > BACKGROUND_LIVE_START_REMEMBERED)
      started.delete(started.values().next().value!);
  }

  async function startNote(
    key: string,
    { workspaceId, path }: QueuedNote,
    cancel: AbortSignal,
  ): Promise<void> {
    // Each check is left behind, not awaited, once the start is cancelled.
    const cancelled = new Promise<typeof cancel>((resolve) =>
      cancel.addEventListener("abort", () => resolve(cancel), { once: true }),
    );
    const check = async <T>(answer: Promise<T>): Promise<T | typeof cancel> =>
      await Promise.race([answer, cancelled]);

    if (!options.eligible(workspaceId)) return;
    const shown = await check(options.showsOnPhone(workspaceId));
    if (shown !== true) return;
    const bytes = await check(options.noteBytes(workspaceId, path));
    // A note past the cap opens as a read preview, never live, so the phone keeps it read-only.
    if (typeof bytes !== "number" || bytes > WYSIWYG_MARKDOWN_THRESHOLD_BYTES) return;
    if ((await check(options.isLossyNote(workspaceId, path))) !== false) return;
    if (cancel.aborted || !options.eligible(workspaceId)) return;
    await options.start(workspaceId, path);
    remember(key);
  }

  function runOne(): void {
    const next = queued.entries().next();
    if (stopped || paused || next.done) return;
    const [key, note] = next.value;
    queued.delete(key);
    const cancel = new AbortController();
    const ended = startNote(key, note, cancel.signal)
      .catch((error: unknown) => {
        options.onError(`[desktop] background live start of ${note.path} failed:`, error);
      })
      .finally(() => {
        inFlight = undefined;
        if (stopped || paused) return;
        if (queued.size > 0) schedule(gapMs);
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
      if (stopped || paused || !options.eligible(workspaceId)) return;
      const before = queued.size;
      for (const path of paths) {
        if (queued.size >= BACKGROUND_LIVE_START_MAX_QUEUED) break;
        // A phone opens only Markdown notes the server shows, never a secret or ignored file.
        if (liveDocumentKindForPath(path) !== "richdoc") continue;
        if (classifyEngineFilePathForRead(path, process.platform).kind !== "tracked") continue;
        const key = keyOf(workspaceId, path);
        if (started.has(key)) continue;
        queued.set(key, { workspaceId, path });
      }
      if (queued.size === 0) return;
      if (before === 0 && deadline === 0) deadline = Date.now() + maxWaitMs;
      // A note in flight schedules the next one when it ends.
      if (inFlight) return;
      schedule(Math.max(0, Math.min(quietMs, deadline - Date.now())));
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
