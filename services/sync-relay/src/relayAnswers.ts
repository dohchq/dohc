import { setTimeout as sleep } from "node:timers/promises";

const ATTEMPT_MS = 2_000;

/**
 * Resolves once a request to the relay's public origin reaches the relay, or once `withinMs` passes,
 * whichever is first. A 5xx answer or no answer means the gateway in front of the relay doesn't serve it yet.
 */
export async function untilRelayAnswers(
  origin: string,
  options: { withinMs: number; retryMs: number; signal: AbortSignal },
): Promise<void> {
  const probe = new URL("/sync/", origin);
  const until = performance.now() + options.withinMs;
  while (!options.signal.aborted && performance.now() < until) {
    try {
      const response = await fetch(probe, {
        signal: AbortSignal.any([options.signal, AbortSignal.timeout(ATTEMPT_MS)]),
      });
      await response.body?.cancel();
      if (response.status < 500) return;
    } catch {}
    await sleep(options.retryMs, undefined, { signal: options.signal }).catch(() => undefined);
  }
}
