/**
 * Admits one client's named relay calls under its own pending budget. A call answers `refuse()` as soon as
 * the browser aborts or the deadline passes, but keeps its slot and closes the relay body only after its work ends.
 */
export function createNamedRelayCalls(options: {
  maxPending: number; timeoutMs: number; unrefDeadline: boolean; refuse(): Response;
  fetchRelay(request: Request): Promise<Response>;
}) {
  let pending = 0;
  return {
    get full() {return pending >= options.maxPending;},
    run(request: Request, work: (signal: AbortSignal, relay: (input: Request) => Promise<Response>) => Promise<Response>, timeoutMs = options.timeoutMs): Promise<Response> {
      pending++;
      const controller = new AbortController(), abort = () => controller.abort();
      const cancelled = new Promise<Response>(resolve => controller.signal.addEventListener("abort", () => resolve(options.refuse()), {once: true}));
      request.signal.addEventListener("abort", abort, {once: true});
      if (request.signal.aborted) abort();
      const timer = setTimeout(abort, timeoutMs);
      if (options.unrefDeadline) timer.unref();
      let upstream: Response | undefined;
      const relay = async (input: Request) => {
        upstream = await options.fetchRelay(input);
        controller.signal.throwIfAborted();
        return upstream;
      };
      const completed = (async () => {
        try {return await work(controller.signal, relay);}
        catch {return options.refuse();}
        finally {
          await upstream?.body?.cancel().catch(() => {});
          pending--; clearTimeout(timer); request.signal.removeEventListener("abort", abort);
        }
      })();
      return Promise.race([completed, cancelled]);
    },
  };
}
