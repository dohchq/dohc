import { AsyncLocalStorage } from "node:async_hooks";

// Marks work done inside an engine run (EngineWorkspaceSessions.run). A close
// waits for runs, so work inside one must not wait for a close: neither could
// finish. The mark follows awaits and timers. Work that outlives its run keeps
// it, so such work waits for no close either, as before runs were marked. Work
// a run hands to another context (a worker, a MessagePort, an emitter, a lock
// that starts its next holder) loses the mark: wrap it in `inEngineRun`, or its
// read and the close wait for each other until the open deadline.
const runScope = new AsyncLocalStorage<true>();

export function insideEngineRun(): boolean {
  return runScope.getStore() === true;
}

export function inEngineRun<T>(work: () => T): T {
  return runScope.run(true, work);
}

/**
 * A daemon event handler runs where the event arrives, outside every run. One
 * registered inside a run gets the run's mark back, so it waits for no close.
 */
export function keepEngineRunScope<A extends unknown[]>(handler: (...args: A) => void): (...args: A) => void {
  return insideEngineRun() ? (...args) => runScope.run(true, handler, ...args) : handler;
}
