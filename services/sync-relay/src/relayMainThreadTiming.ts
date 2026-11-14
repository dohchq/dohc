import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Measures where the relay's main thread waits, for its logs only. Nothing
 * here changes what the relay does. It records only after
 * `startRelayMainThreadTiming`, which the server calls at startup.
 */

/** Which part of the relay a write belongs to, so the summary can tell them apart. */
export type RelayWriteKind = "save" | "drain-acknowledge" | "owner-outbox" | "pass" | "other";
const writeKinds = new AsyncLocalStorage<RelayWriteKind>();
/** Names the writes `run` makes, and the writes of any work it starts, unless that work names its own. */
export function asRelayWrite<T>(kind: RelayWriteKind, run: () => T): T {
  return writeKinds.run(kind, run);
}

const SAMPLE_MS = 25;
const MINUTE_MS = 60_000;
// About three and a half minutes of samples, longer than a save may take.
const RING = 8192;
// A minute keeps at most this many values of each kind; the summary counts what it dropped.
const MAX_VALUES = 5000;

type Values = number[];
interface WriteFigures {
  count: number;
  writeMs: Values;
  commitMs: Values;
  confirmMs: Values;
  checkpoints: number;
}
/** The engine's one-request-at-a-time line, for one method. */
interface EngineFigures {
  /** Requests the engine answered; the values below keep at most a minute's cap of them. */
  count: number;
  waitMs: Values;
  serveMs: Values;
  /** Requests that left the line before they were sent: cancelled, timed out or stopped. */
  leftWaiting: number;
}
interface Minute {
  startedAt: number;
  loopLateMs: Values;
  writes: Map<RelayWriteKind, WriteFigures>;
  engine: Map<string, EngineFigures>;
  /** Each result's count and figures, so fast refusals do not move successful saves' figures. */
  saves: Map<string, { count: number; figures: Map<string, Values> }>;
  dropped: number;
}

let timing:
  | {
      times: Float64Array;
      late: Float64Array;
      next: number;
      expected: number;
      minute: Minute;
      timer: ReturnType<typeof setInterval>;
    }
  | undefined;

const newMinute = (startedAt: number): Minute => ({
  startedAt,
  loopLateMs: [],
  writes: new Map(),
  engine: new Map(),
  saves: new Map(),
  dropped: 0,
});

function keep(minute: Minute, values: Values, value: number) {
  if (values.length < MAX_VALUES) values.push(value);
  else minute.dropped++;
}

/** Starts the loop sampler and the once-a-minute summary. Calling it again does nothing. */
export function startRelayMainThreadTiming(): void {
  if (timing) return;
  const now = performance.now();
  const state = {
    times: new Float64Array(RING),
    late: new Float64Array(RING),
    next: 0,
    expected: now + SAMPLE_MS,
    minute: newMinute(now),
    timer: setInterval(() => {
      const at = performance.now();
      // How long the loop held this timer past its due time.
      const late = Math.max(0, at - state.expected);
      state.expected = at + SAMPLE_MS;
      const slot = state.next++ % RING;
      state.times[slot] = at;
      state.late[slot] = late;
      keep(state.minute, state.minute.loopLateMs, late);
      if (at - state.minute.startedAt >= MINUTE_MS) {
        const finished = state.minute;
        state.minute = newMinute(at);
        reportMinute(finished);
      }
    }, SAMPLE_MS),
  };
  state.timer.unref();
  timing = state;
}

export function stopRelayMainThreadTiming(): void {
  if (timing) clearInterval(timing.timer);
  timing = undefined;
}

export const relayMainThreadTimingOn = (): boolean => timing !== undefined;

/** The longest and the summed lateness of the loop between `from` and `to`, or null when not sampling. */
export function loopHeldBetween(
  from: number,
  to: number,
): { loopMaxMs: number; loopHeldMs: number } | null {
  if (!timing) return null;
  let loopMaxMs = 0,
    loopHeldMs = 0;
  const count = Math.min(timing.next, RING);
  for (let back = 1; back <= count; back++) {
    const slot = (timing.next - back) % RING;
    const at = timing.times[slot]!;
    if (at <= from) break;
    if (at > to) continue;
    // A sample's lateness ended at its own time, so it fell within the save when it began after `from`.
    const late = Math.min(timing.late[slot]!, at - from);
    loopMaxMs = Math.max(loopMaxMs, late);
    loopHeldMs += late;
  }
  // A sample that is due but has not run yet: the loop is still late by now, and that lateness began within the save.
  const pending = Math.min(Math.max(0, to - timing.expected), to - from);
  loopMaxMs = Math.max(loopMaxMs, pending);
  loopHeldMs += pending;
  return { loopMaxMs, loopHeldMs };
}

/** One relay write that held the main thread. `confirmMs` is null when nothing changed. */
export function recordRelayWrite(write: {
  writeMs: number;
  commitMs: number;
  confirmMs: number | null;
  checkpoint: boolean;
}): void {
  if (!timing) return;
  const minute = timing.minute;
  const kind = writeKinds.getStore() ?? "other";
  let figures = minute.writes.get(kind);
  if (!figures) {
    figures = { count: 0, writeMs: [], commitMs: [], confirmMs: [], checkpoints: 0 };
    minute.writes.set(kind, figures);
  }
  figures.count++;
  keep(minute, figures.writeMs, write.writeMs);
  keep(minute, figures.commitMs, write.commitMs);
  if (write.confirmMs !== null) keep(minute, figures.confirmMs, write.confirmMs);
  if (write.checkpoint) figures.checkpoints++;
}

/**
 * One engine request: how long it waited in the line before it was sent, and how long the engine took
 * to answer. `serveMs` is null when it left the line without being sent.
 */
export function recordEngineRequest(method: string, waitMs: number, serveMs: number | null): void {
  if (!timing) return;
  const minute = timing.minute;
  let figures = minute.engine.get(method);
  if (!figures) {
    figures = { count: 0, waitMs: [], serveMs: [], leftWaiting: 0 };
    minute.engine.set(method, figures);
  }
  if (serveMs === null) {
    figures.leftWaiting++;
    return;
  }
  figures.count++;
  keep(minute, figures.waitMs, waitMs);
  keep(minute, figures.serveMs, serveMs);
}

/** Every answered save, slow or not, so the summary's medians are not only the slow ones. */
export function recordLiveSubmit(
  result: string,
  figures: Readonly<Record<string, number | null>>,
): void {
  if (!timing) return;
  const minute = timing.minute;
  let saves = minute.saves.get(result);
  if (!saves) minute.saves.set(result, (saves = { count: 0, figures: new Map() }));
  saves.count++;
  for (const [name, value] of Object.entries(figures)) {
    if (value === null) continue;
    let values = saves.figures.get(name);
    if (!values) saves.figures.set(name, (values = []));
    keep(minute, values, value);
  }
}

function spread(values: Values) {
  const sorted = [...values].sort((a, b) => a - b);
  const at = (q: number) =>
    Math.round(sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]!);
  return { p50: at(0.5), p90: at(0.9), max: Math.round(sorted.at(-1)!) };
}

function reportMinute(minute: Minute) {
  if (minute.writes.size === 0 && minute.saves.size === 0 && minute.engine.size === 0) return;
  try {
    const loop = minute.loopLateMs;
    // One JSON string: the console prints an object only two levels deep, and these figures sit deeper.
    const summary = {
      loop: loop.length
        ? {
            samples: loop.length,
            lateMs: spread(loop),
            over50: loop.filter((late) => late > 50).length,
            over200: loop.filter((late) => late > 200).length,
          }
        : null,
      writes: Object.fromEntries(
        [...minute.writes].map(([kind, figures]) => [
          kind,
          {
            count: figures.count,
            writeMs: spread(figures.writeMs),
            commitMs: spread(figures.commitMs),
            confirmMs: figures.confirmMs.length ? spread(figures.confirmMs) : null,
            checkpoints: figures.checkpoints,
          },
        ]),
      ),
      engine: Object.fromEntries(
        [...minute.engine].map(([method, figures]) => [
          method,
          {
            count: figures.count,
            waitMs: figures.waitMs.length ? spread(figures.waitMs) : null,
            serveMs: figures.serveMs.length ? spread(figures.serveMs) : null,
            ...(figures.leftWaiting ? { leftWaiting: figures.leftWaiting } : {}),
          },
        ]),
      ),
      saves: Object.fromEntries(
        [...minute.saves].map(([result, saves]) => [
          result,
          {
            count: saves.count,
            ...Object.fromEntries(
              [...saves.figures].map(([name, values]) => [name, spread(values)]),
            ),
          },
        ]),
      ),
      ...(minute.dropped ? { dropped: minute.dropped } : {}),
    };
    console.error("Relay main thread, last minute.", JSON.stringify(summary));
  } catch {
    /* Reporting must not stop the relay. */
  }
}
