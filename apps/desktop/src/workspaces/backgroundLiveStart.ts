import { classifyEngineFilePathForRead } from "@dohc/security-contract/engine-path-floor";
import { liveDocumentKindForPath } from "@dohc/workspace-contracts/live-documents";
import type { RelayMaterializedPath } from "@dohc/workspace-contracts/relay";
import { WYSIWYG_MARKDOWN_THRESHOLD_BYTES } from "./workspaceTextLimits";

export interface BackgroundLiveStartIdentity {
  versionId: string;
  objectId: string;
}

export interface BackgroundLiveStart {
  note(workspaceId: string, paths: readonly string[]): void;
  retry(workspaceId: string): void;
  drop(workspaceId?: string): Promise<void>;
  pause(): Promise<void>;
  resume(): void;
  stop(): Promise<void>;
}

export interface BackgroundLiveStartOptions {
  eligible(workspaceId: string): boolean;
  noteIdentity(workspaceId: string, path: string): Promise<BackgroundLiveStartIdentity | null>;
  showsOnPhone(workspaceId: string): Promise<boolean>;
  catchUp(workspaceId: string, signal: AbortSignal): Promise<boolean>;
  relayLiveNotes(workspaceId: string, signal: AbortSignal): Promise<ReadonlySet<string> | null>;
  noteBytes(workspaceId: string, path: string): Promise<number | null>;
  isLossyNote(workspaceId: string, path: string): Promise<boolean>;
  start(workspaceId: string, path: string): Promise<void>;
  onError(message: string, error: unknown): void;
  quietMs?: number;
  maxWaitMs?: number;
  gapMs?: number;
}

const isTrackedNotePath = (path: string) =>
  liveDocumentKindForPath(path) === "richdoc" &&
  classifyEngineFilePathForRead(path, process.platform).kind === "tracked";

export function syncedNotePaths(paths: readonly RelayMaterializedPath[]): string[] {
  return paths
    .filter(
      (change) =>
        change.versionId === "main" &&
        change.operation === "write" &&
        change.contentKind === "text" &&
        isTrackedNotePath(change.path),
    )
    .map((change) => change.path);
}

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

const CANCELLED = Symbol("cancelled");
const keyOf = (workspaceId: string, path: string) => `${workspaceId}\u0000${path}`;
const identityKeyOf = (workspaceId: string, id: BackgroundLiveStartIdentity) =>
  `${workspaceId}\u0000${id.versionId}\u0000${id.objectId}`;
const sameIdentity = (
  a: BackgroundLiveStartIdentity,
  b: BackgroundLiveStartIdentity | null | typeof CANCELLED,
) => !!b && b !== CANCELLED && b.versionId === a.versionId && b.objectId === a.objectId;

export function createBackgroundLiveStart(
  options: BackgroundLiveStartOptions,
): BackgroundLiveStart {
  const quietMs = options.quietMs ?? 5_000;
  const maxWaitMs = options.maxWaitMs ?? 60_000;
  const gapMs = options.gapMs ?? 1_000;
  const queued = new Map<string, QueuedNote>();
  const deferred = new Map<string, QueuedNote>();
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

  function defer(workspaceId: string, path: string): void {
    const key = keyOf(workspaceId, path);
    if (
      !stopped &&
      !paused &&
      (deferred.has(key) || deferred.size < BACKGROUND_LIVE_START_MAX_QUEUED)
    )
      deferred.set(key, { workspaceId, path });
  }

  async function startNote({ workspaceId, path }: QueuedNote, cancel: AbortSignal): Promise<void> {
    const cancelled = new Promise<typeof CANCELLED>((resolve) =>
      cancel.addEventListener("abort", () => resolve(CANCELLED), { once: true }),
    );
    const unlessCancelled = async <T>(answer: Promise<T>): Promise<T | typeof CANCELLED> =>
      await Promise.race([answer, cancelled]);

    if (!options.eligible(workspaceId)) return;
    const identity = await unlessCancelled(options.noteIdentity(workspaceId, path));
    if (!identity || identity === CANCELLED) return;
    const identityKey = identityKeyOf(workspaceId, identity);
    if (started.has(identityKey)) return;
    const shown = await unlessCancelled(options.showsOnPhone(workspaceId));
    if (shown !== true) return;
    const bytes = await unlessCancelled(options.noteBytes(workspaceId, path));
    if (typeof bytes !== "number" || bytes > WYSIWYG_MARKDOWN_THRESHOLD_BYTES) return;
    if ((await unlessCancelled(options.isLossyNote(workspaceId, path))) !== false) return;
    if (cancel.aborted || !options.eligible(workspaceId)) return;
    const caughtUp = await unlessCancelled(options.catchUp(workspaceId, cancel));
    if (caughtUp === CANCELLED) return;
    if (caughtUp !== true) return defer(workspaceId, path);
    const liveOnRelay = await unlessCancelled(options.relayLiveNotes(workspaceId, cancel));
    if (liveOnRelay === CANCELLED) return;
    if (liveOnRelay === null) return defer(workspaceId, path);
    if (liveOnRelay.has(identity.objectId)) return;
    if (!sameIdentity(identity, await unlessCancelled(options.noteIdentity(workspaceId, path))))
      return;
    if (cancel.aborted || !options.eligible(workspaceId)) return;
    await options.start(workspaceId, path);
    if (sameIdentity(identity, await options.noteIdentity(workspaceId, path).catch(() => null)))
      remember(identityKey);
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
    for (const map of [queued, deferred])
      for (const [key, note] of map)
        if (workspaceId === undefined || note.workspaceId === workspaceId) map.delete(key);
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

  const liveStart: BackgroundLiveStart = {
    note(workspaceId, paths) {
      if (stopped || paused || !options.eligible(workspaceId)) return;
      quietUntil = Date.now() + quietMs;
      const before = queued.size;
      for (const path of paths) {
        if (queued.size >= BACKGROUND_LIVE_START_MAX_QUEUED) break;
        if (!isTrackedNotePath(path)) continue;
        const key = keyOf(workspaceId, path);
        deferred.delete(key);
        queued.set(key, { workspaceId, path });
      }
      if (queued.size === 0) return;
      if (before === 0 && deadline === 0) deadline = Date.now() + maxWaitMs;
      if (inFlight) return;
      scheduleNext();
    },
    retry(workspaceId) {
      if (stopped || paused || inFlight?.workspaceId === workspaceId || deferred.size === 0) return;
      const paths = [...deferred.entries()]
        .filter(([, entry]) => entry.workspaceId === workspaceId)
        .map(([key, entry]) => (deferred.delete(key), entry.path));
      if (paths.length > 0) liveStart.note(workspaceId, paths);
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
  return liveStart;
}
