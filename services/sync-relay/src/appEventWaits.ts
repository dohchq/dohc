import { WaiterRegistry, type WaiterCaps } from "@dohc/service-http";
import { relayError } from "./errors";
import { observeRelayWrites } from "./relayWriteChanges";

const SWEEP_MS = 250;
const RECHECK_MS = 1_000;

/**
 * Link app polls parked by Collection. A relay write wakes the Collections whose revision moved within 250 ms,
 * and every parked poll within a second, so each checks its link again. Writes are heard only while a poll waits.
 */
export function createAppEventWaits(
  storage: object,
  revision: (workspaceId: string, datasetId: string) => number,
  caps: WaiterCaps = { maxTotal: 1_024, maxPerGroup: 1_024, maxPerActor: 256 },
) {
  const waiters = new WaiterRegistry(caps);
  const groups = new Map<
    string,
    { workspaceId: string; datasetId: string; revision: number; parked: number }
  >();
  let stopObserving: (() => void) | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let sweptAtMs = 0;
  let recheckedAtMs = 0;
  const schedule = (atMs: number) => {
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
    for (const [key, group] of groups) {
      const current = read(group.workspaceId, group.datasetId);
      if (recheck || current !== group.revision) {
        group.revision = current;
        waiters.wake(key, undefined);
      }
    }
    if (!recheck && groups.size) schedule(recheckedAtMs + RECHECK_MS);
  };
  const written = () => {
    if (timer === undefined) schedule(sweptAtMs + SWEEP_MS);
  };
  const close = () => {
    stopObserving?.();
    stopObserving = undefined;
    clearTimeout(timer);
    timer = undefined;
  };
  return {
    /** Parks until the Collection may have moved past `since`, the link may have changed, or `holdMs` passes. */
    async wait(input: {
      workspaceId: string;
      datasetId: string;
      grantId: string;
      since: number;
      holdMs: number;
      signal: AbortSignal;
    }): Promise<void> {
      const key = JSON.stringify([input.workspaceId, input.datasetId]);
      if (waiters.atCapacity(key, input.grantId)) throw relayError("link_read_rate_limited");
      const group = groups.get(key) ?? {
        workspaceId: input.workspaceId,
        datasetId: input.datasetId,
        revision: read(input.workspaceId, input.datasetId),
        parked: 0,
      };
      groups.set(key, group);
      group.parked += 1;
      stopObserving ??= observeRelayWrites(storage, written);
      try {
        await waiters.park(key, input.grantId, {
          holdMs: input.holdMs,
          signal: input.signal,
          settle: () => undefined,
          shouldPark: () => revision(input.workspaceId, input.datasetId) === input.since,
        });
      } finally {
        group.parked -= 1;
        if (group.parked === 0) groups.delete(key);
        if (groups.size === 0) close();
      }
    },
    close,
  };
}

export type AppEventWaits = ReturnType<typeof createAppEventWaits>;
