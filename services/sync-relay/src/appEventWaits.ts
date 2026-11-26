import { WaiterRegistry, type WaiterCaps } from "@dohc/service-http";
import { relayError } from "./errors";
import { observeRelayWrites } from "./relayWriteChanges";

const SWEEP_MS = 250;
const RECHECK_MS = 1_000;

/**
 * App polls parked by the Collections they watch. A relay write wakes the polls whose Collections' revisions moved
 * within 250 ms, and every parked poll within a second, so each checks its caller again. Each sweep reads every
 * watched Collection once. Writes are heard only while a poll waits.
 */
export function createAppEventWaits(
  storage: object,
  revision: (workspaceId: string, datasetId: string) => number,
  caps: WaiterCaps = { maxTotal: 1_024, maxPerGroup: 1_024, maxPerActor: 256 },
) {
  const waiters = new WaiterRegistry(caps);
  const groups = new Map<
    string,
    { workspaceId: string; collections: Array<{ datasetId: string; revision: number }> }
  >();
  let stopObserving: (() => void) | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let dueAtMs = 0;
  let sweptAtMs = 0;
  let recheckedAtMs = 0;
  const schedule = (atMs: number) => {
    clearTimeout(timer);
    dueAtMs = atMs;
    timer = setTimeout(sweep, Math.max(0, atMs - Date.now()));
    timer.unref();
  };
  const read = (workspaceId: string, datasetId: string) => {
    try {
      return revision(workspaceId, datasetId);
    } catch {
      return Number.NaN;
    }
  };
  const sweep = () => {
    timer = undefined;
    sweptAtMs = Date.now();
    const recheck = sweptAtMs - recheckedAtMs >= RECHECK_MS;
    if (recheck) recheckedAtMs = sweptAtMs;
    const reads = new Map<string, number>();
    for (const [key, group] of groups) {
      let moved = false;
      for (const watched of group.collections) {
        const scope = JSON.stringify([group.workspaceId, watched.datasetId]);
        const current = reads.get(scope) ?? read(group.workspaceId, watched.datasetId);
        reads.set(scope, current);
        if (current !== watched.revision) {
          watched.revision = current;
          moved = true;
        }
      }
      if (recheck || moved) waiters.wake(key, undefined);
    }
    if (!recheck && groups.size) schedule(recheckedAtMs + RECHECK_MS);
  };
  const written = () => {
    if (timer === undefined || sweptAtMs + SWEEP_MS < dueAtMs) schedule(sweptAtMs + SWEEP_MS);
  };
  const close = () => {
    stopObserving?.();
    stopObserving = undefined;
    clearTimeout(timer);
    timer = undefined;
  };
  return {
    /** Parks until a watched Collection's revision moves from `since`, the caller needs checking again, or `holdMs` ends. */
    async wait(input: {
      workspaceId: string;
      /** Whose parked polls count together: `link:<grant>` or `named:<workspace>:<person>`. */
      actor: string;
      since: ReadonlyArray<{ datasetId: string; revision: number }>;
      holdMs: number;
      signal: AbortSignal;
    }): Promise<void> {
      const { workspaceId, since } = input;
      const key = JSON.stringify([workspaceId, ...since.map((value) => value.datasetId).sort()]);
      if (waiters.atCapacity(key, input.actor)) throw relayError("link_read_rate_limited");
      if (!groups.has(key))
        groups.set(key, { workspaceId, collections: since.map((value) => ({ ...value })) });
      stopObserving ??= observeRelayWrites(storage, written);
      try {
        await waiters.park(key, input.actor, {
          holdMs: input.holdMs,
          signal: input.signal,
          settle: () => undefined,
          shouldPark: () =>
            since.every((value) => read(workspaceId, value.datasetId) === value.revision),
        });
      } finally {
        if (!waiters.waiting(key)) groups.delete(key);
        if (groups.size === 0) close();
      }
    },
    close,
  };
}

export type AppEventWaits = ReturnType<typeof createAppEventWaits>;
