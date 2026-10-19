/**
 * Bounds one client's relay calls. Browser cancellation refuses; deadlines and connection failures use `unavailable()`.
 * The slot and relay body stay owned until the work ends.
 */
export function createNamedRelayCalls(options: {
  maxPending: number; timeoutMs: number; unrefDeadline: boolean; refuse(): Response;
  unavailable?(): Response;
  fetchRelay(request: Request): Promise<Response>;
}) {
  let pending = 0;
  return {
    get full() {return pending >= options.maxPending;},
    run(request: Request, work: (signal: AbortSignal, relay: (input: Request) => Promise<Response>) => Promise<Response>, timeoutMs = options.timeoutMs): Promise<Response> {
      pending++;
      const controller = new AbortController(), abort = () => controller.abort();
      const unavailable = options.unavailable ?? options.refuse;
      const cancelledResponse = () => request.signal.aborted ? options.refuse() : unavailable();
      const cancelled = new Promise<Response>(resolve => controller.signal.addEventListener("abort", () => resolve(cancelledResponse()), {once: true}));
      request.signal.addEventListener("abort", abort, {once: true});
      if (request.signal.aborted) abort();
      const timer = setTimeout(abort, timeoutMs);
      if (options.unrefDeadline) timer.unref();
      let upstream: Response | undefined, relayFailed = false;
      const relay = async (input: Request) => {
        try {upstream = await options.fetchRelay(input);}
        catch (error) {relayFailed = true; throw error;}
        controller.signal.throwIfAborted();
        return upstream;
      };
      const completed = (async () => {
        try {return await work(controller.signal, relay);}
        catch {return controller.signal.aborted ? cancelledResponse() : relayFailed ? unavailable() : options.refuse();}
        finally {
          await upstream?.body?.cancel().catch(() => {});
          pending--; clearTimeout(timer); request.signal.removeEventListener("abort", abort);
        }
      })();
      return Promise.race([completed, cancelled]);
    },
  };
}
