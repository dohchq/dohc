import { randomUUID } from "node:crypto";

const POSTHOG_KEY_PATTERN = /^phc_\w{10,100}$/;
const MAX_QUEUE = 500;
const REQUEST_TIMEOUT_MS = 10_000;
const MAX_RETRY_AGE_MS = 30 * 60_000;
const MAX_BACKOFF_MS = 60_000;

export interface PostHogProject {
  key: string;
  base: URL;
}

export interface ServiceAnalyticsConfig {
  url: URL;
  key: string;
}

export type AnalyticsPropertyValue = string | number | boolean;

export interface ServiceAnalyticsClient {
  track(event: string, properties?: Readonly<Record<string, AnalyticsPropertyValue>>): void;
  flush(): Promise<void>;
}

export class AnalyticsConfigError extends Error {}

export function posthogProject(key: string, host: string): PostHogProject | null {
  const trimmedKey = key.trim();
  const trimmedHost = host.trim();
  if (!POSTHOG_KEY_PATTERN.test(trimmedKey) || /[?#]/.test(trimmedHost)) return null;
  let base: URL;
  try {
    base = new URL(trimmedHost);
  } catch {
    return null;
  }
  if (base.protocol !== "https:" || base.username || base.password) return null;
  return { key: trimmedKey, base };
}

export function rateLimitMs(
  response: Pick<Response, "status" | "headers">,
  bounds: { defaultPauseMs?: number; maxPauseMs?: number } = {},
): number {
  if (response.status !== 429) return 0;
  const defaultPauseMs = bounds.defaultPauseMs ?? 60_000;
  const maxPauseMs = bounds.maxPauseMs ?? 3_600_000;
  const retryAfter = Number(response.headers.get("retry-after"));
  const seconds =
    Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : defaultPauseMs / 1000;
  return Math.min(seconds * 1000, maxPauseMs);
}

export function readAnalyticsEnvConfig(env: NodeJS.ProcessEnv): ServiceAnalyticsConfig | null {
  const key = env.DOHC_ANALYTICS_KEY?.trim() ?? "";
  const host = env.DOHC_ANALYTICS_HOST?.trim() ?? "";
  if (!key && !host) return null;
  if (!key || !host) {
    throw new AnalyticsConfigError(
      "DOHC_ANALYTICS_KEY and DOHC_ANALYTICS_HOST must both be set, or both left unset.",
    );
  }
  const project = posthogProject(key, host);
  if (!project) {
    throw new AnalyticsConfigError(
      "DOHC_ANALYTICS_KEY must be a valid phc_* key and DOHC_ANALYTICS_HOST must be an https URL without credentials, query, or fragment.",
    );
  }
  return { url: new URL(`${project.base.href.replace(/\/+$/, "")}/batch/`), key: project.key };
}

interface QueuedEvent {
  event: string;
  distinct_id: string;
  uuid: string;
  properties: Record<string, unknown>;
  timestamp: string;
  queuedAtMs: number;
}

export function createServiceAnalyticsClient(options: {
  service: string;
  config: ServiceAnalyticsConfig;
  fetch?: typeof fetch;
  now?: () => number;
  random?: () => number;
  flushMs?: number;
  batchSize?: number;
  shutdownTimeoutMs?: number;
  baseBackoffMs?: number;
}): ServiceAnalyticsClient {
  const send = options.fetch ?? fetch;
  const now = options.now ?? Date.now;
  const random = options.random ?? Math.random;
  const flushMs = options.flushMs ?? 15_000;
  const batchSize = options.batchSize ?? 50;
  const shutdownTimeoutMs = options.shutdownTimeoutMs ?? 3_000;
  const baseBackoffMs = options.baseBackoffMs ?? 1_000;
  const queue: QueuedEvent[] = [];
  let timer: ReturnType<typeof setTimeout> | null = null;
  let sending: AbortController | null = null;
  let draining: Promise<void> | null = null;
  let flushing: Promise<void> | null = null;
  let pausedUntilMs = 0;
  let failures = 0;
  let quitting = false;
  let ended = false;

  const clearTimer = () => {
    if (timer) clearTimeout(timer);
    timer = null;
  };

  const dropExpired = (atMs = now()) => {
    const cutoff = atMs - MAX_RETRY_AGE_MS;
    let keep = 0;
    for (let i = 0; i < queue.length; i += 1) {
      if (queue[i]!.queuedAtMs >= cutoff) queue[keep++] = queue[i]!;
    }
    queue.length = keep;
  };

  const schedule = (delayMs: number) => {
    if (quitting || ended || timer || queue.length === 0) return;
    timer = setTimeout(
      () => {
        timer = null;
        void drain();
      },
      Math.max(0, delayMs, pausedUntilMs - now()),
    );
    timer.unref?.();
  };

  const pauseForBackoff = () => {
    failures += 1;
    const backoff = Math.min(MAX_BACKOFF_MS, baseBackoffMs * 2 ** (failures - 1));
    pausedUntilMs = now() + Math.round(backoff * (0.75 + 0.5 * random()));
  };

  const sendBatch = async (batch: QueuedEvent[]): Promise<"ok" | "retry" | "drop"> => {
    const controller = new AbortController();
    sending = controller;
    try {
      const response = await send(options.config.url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          api_key: options.config.key,
          batch: batch.map(({ queuedAtMs: _queued, ...payload }) => payload),
        }),
        redirect: "error",
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]),
      });
      await response.body?.cancel().catch(() => {});
      if (response.ok) {
        failures = 0;
        return "ok";
      }
      if (response.status === 429) {
        pausedUntilMs = now() + rateLimitMs(response);
        return "retry";
      }
      if (response.status === 408 || response.status >= 500) {
        pauseForBackoff();
        return "retry";
      }
      return "drop";
    } catch {
      pauseForBackoff();
      return "retry";
    } finally {
      if (sending === controller) sending = null;
    }
  };

  const drain = (ignorePause = false): Promise<void> => {
    if (draining) return draining;
    const atMs = now();
    dropExpired(atMs);
    if (ended || queue.length === 0) return Promise.resolve();
    if (!ignorePause && atMs < pausedUntilMs) {
      schedule(pausedUntilMs - atMs);
      return Promise.resolve();
    }
    clearTimer();
    const run = (async () => {
      let first = true;
      while (!ended) {
        if (!first) {
          const stepMs = now();
          dropExpired(stepMs);
          if (queue.length === 0 || (!ignorePause && stepMs < pausedUntilMs)) break;
        }
        first = false;
        const batch = queue.splice(0, batchSize);
        if ((await sendBatch(batch)) === "retry") {
          if (!quitting && !ended) {
            const kept = batch.filter((item) => item.queuedAtMs >= now() - MAX_RETRY_AGE_MS);
            const room = Math.max(0, MAX_QUEUE - queue.length);
            if (room > 0 && kept.length > 0) queue.unshift(...kept.slice(kept.length - room));
            clearTimer();
            schedule(pausedUntilMs - now());
          }
          break;
        }
      }
    })();
    const settled = run.finally(() => {
      if (draining === settled) draining = null;
      if (!quitting && !ended && queue.length > 0) {
        if (queue.length >= batchSize && now() >= pausedUntilMs) void drain();
        else schedule(flushMs);
      }
    });
    draining = settled;
    return settled;
  };

  return {
    track(event, properties = {}) {
      if (ended || quitting || queue.length >= MAX_QUEUE) return;
      const atMs = now();
      queue.push({
        event,
        distinct_id: randomUUID(),
        uuid: randomUUID(),
        properties: {
          ...properties,
          $process_person_profile: false,
          $geoip_disable: true,
          $lib: `dohc-${options.service}`,
          service: options.service,
        },
        timestamp: new Date(atMs).toISOString(),
        queuedAtMs: atMs,
      });
      if (queue.length >= batchSize) void drain();
      else if (!draining) schedule(flushMs);
    },
    flush() {
      if (flushing) return flushing;
      quitting = true;
      clearTimer();
      flushing = (async () => {
        let deadline: ReturnType<typeof setTimeout> | undefined;
        const finish = async () => {
          while (draining) await draining;
          await drain(true);
        };
        await Promise.race([
          finish().catch(() => {}),
          new Promise<void>((resolve) => {
            deadline = setTimeout(resolve, shutdownTimeoutMs);
          }),
        ]);
        clearTimeout(deadline);
        ended = true;
        sending?.abort();
        queue.length = 0;
      })();
      return flushing;
    },
  };
}
