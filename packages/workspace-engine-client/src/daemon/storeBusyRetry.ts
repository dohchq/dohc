import policy from "./storeBusyRetry.json";
import { isEngineStoreBusyRefusal } from "../live/daemonLiveAdapter";

// Maximal-write checkpoint measurements must retain at least fourfold headroom.
export const STORE_BUSY_RETRY_BUDGET_MS = policy.engineStoreBusyRetryMs;
export const storeBusyBackoffMs = (attempt: number): number =>
  Math.min(100 * 2 ** Math.min(attempt - 1, 4), 1_000);

/** Retry only the refused store mutation, within one total catch-up budget. */
export async function retryStoreBusy<T>(
  operation: () => Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  let deadline: number | undefined;
  for (let attempt = 1; ; attempt++) {
    try {
      return await operation();
    } catch (error) {
      if (!isEngineStoreBusyRefusal(error) || signal.aborted) throw error;
      deadline ??= Date.now() + STORE_BUSY_RETRY_BUDGET_MS;
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw error;
      await new Promise<void>((resolve, reject) => {
        const abort = () => {
          clearTimeout(timer);
          signal.removeEventListener("abort", abort);
          reject(error);
        };
        const timer = setTimeout(() => {
          signal.removeEventListener("abort", abort);
          resolve();
        }, Math.min(storeBusyBackoffMs(attempt), remaining));
        signal.addEventListener("abort", abort, { once: true });
        if (signal.aborted) abort();
      });
      if (signal.aborted || Date.now() >= deadline) throw error;
    }
  }
}
