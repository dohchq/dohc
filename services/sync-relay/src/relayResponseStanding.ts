import type { SyncRelayStorage } from "./storage";

/** No authorized result or later stream chunk may outlive its storage owner. */
export function guardRelayResponses(
  storage: Pick<SyncRelayStorage, "captureStanding" | "unavailable">,
  handler: (request: Request) => Promise<Response>,
): (request: Request) => Promise<Response> {
  return async request => {
    let response: Response | undefined;
    const controller = new AbortController();
    const signal = controller.signal;
    const unavailable = storage.unavailable;
    const requestAborted = () => controller.abort(request.signal.reason);
    const storageUnavailable = () => controller.abort(unavailable.reason);
    const releaseSignals = () => {
      request.signal.removeEventListener("abort", requestAborted);
      unavailable.removeEventListener("abort", storageUnavailable);
    };
    try {
      const check = storage.captureStanding();
      request.signal.addEventListener("abort", requestAborted, { once: true });
      unavailable.addEventListener("abort", storageUnavailable, { once: true });
      if (request.signal.aborted) requestAborted();
      if (unavailable.aborted) storageUnavailable();
      response = await handler(new Request(request, { signal }));
      check();
      if (!response.body) { releaseSignals(); return response; }
      const reader = response.body.getReader();
      let stopped = false;
      const stop = () => {
        if (stopped) return;
        stopped = true;
        releaseSignals();
        signal.removeEventListener("abort", abort);
        void reader.cancel().catch(() => undefined);
      };
      let controller: ReadableStreamDefaultController<Uint8Array>;
      const abort = () => {
        if (stopped) return;
        stop();
        controller.error(new Error("Relay response is unavailable."));
      };
      const body = new ReadableStream<Uint8Array>({
        start(value) {
          controller = value;
          signal.addEventListener("abort", abort, { once: true });
          if (signal.aborted) abort();
        },
        async pull(output) {
          if (stopped) return;
          try {
            check();
            const next = await reader.read();
            if (stopped) return;
            check();
            if (next.done) {
              stopped = true;
              releaseSignals();
              signal.removeEventListener("abort", abort);
              output.close();
            } else output.enqueue(next.value);
          } catch (error) { if (!stopped) { stop(); output.error(error); } }
        },
        cancel() { stop(); },
      }, { highWaterMark: 0 });
      return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
    } catch (error) {
      releaseSignals();
      void response?.body?.cancel().catch(() => undefined);
      if (storage.unavailable.aborted) {
        return Response.json({ ok: false, error: "service unavailable" }, { status: 503, headers: { "cache-control": "no-store" } });
      }
      throw error;
    }
  };
}
