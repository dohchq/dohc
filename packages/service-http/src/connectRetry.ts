const RETRYABLE_CONNECT_CODES = new Set([
  "ECONNREFUSED",
  "ENOTFOUND",
  "EAI_AGAIN",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "UND_ERR_CONNECT_TIMEOUT",
]);

export interface ConnectRetryOptions {
  timeoutMs?: number;
  intervalMs?: number;
  retryRequestBody?: boolean;
}

function isPreConnectError(error: unknown, seen = new Set<unknown>()): boolean {
  if (!error || typeof error !== "object" || seen.has(error)) return false;
  seen.add(error);
  const record = error as { code?: unknown; cause?: unknown; errors?: unknown };
  if (typeof record.code === "string" && RETRYABLE_CONNECT_CODES.has(record.code)) return true;
  if (Array.isArray(record.errors) && record.errors.length > 0) {
    return record.errors.every((item) => isPreConnectError(item, seen));
  }
  return record.cause !== undefined && isPreConnectError(record.cause, seen);
}

function waitForRetry(delayMs: number, signal?: AbortSignal | null): Promise<void> {
  if (delayMs <= 0) return Promise.resolve();
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, delayMs);
    timer.unref();
    signal?.addEventListener("abort", done, { once: true });
  });
}

export function withConnectRetry(
  send: typeof fetch,
  options: ConnectRetryOptions = {},
): typeof fetch {
  const timeoutMs = options.timeoutMs ?? 15_000;
  const intervalMs = options.intervalMs ?? 200;
  const retryRequestBody = options.retryRequestBody ?? false;

  return async (input, init) => {
    const isRequest = input instanceof Request;
    const signal = init?.signal ?? (isRequest ? input.signal : undefined);
    const canRetry = isRequest
      ? (input.body === null || retryRequestBody) && !input.bodyUsed
      : !(init?.body instanceof ReadableStream);
    if (!canRetry) return send(input, init);

    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const attemptInput = isRequest ? input.clone() : input;
      try {
        return await send(attemptInput, init);
      } catch (error) {
        const remaining = deadline - Date.now();
        if (signal?.aborted || remaining <= 0 || !isPreConnectError(error)) throw error;
        await waitForRetry(Math.min(intervalMs, remaining), signal);
        if (signal?.aborted) throw error;
      }
    }
  };
}
