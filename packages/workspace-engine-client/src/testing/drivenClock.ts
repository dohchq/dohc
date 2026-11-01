// Captured at import, before a test fakes the global.
const realSetImmediate = globalThis.setImmediate;

/** The part of vitest's `vi` that drives fake timers. Pass `vi` itself. */
export interface FakeTimerDriver {
  getTimerCount(): number;
  advanceTimersToNextTimerAsync(): Promise<unknown>;
}

const fileRequestPending = (): boolean =>
  process.getActiveResourcesInfo().some((name) => name.startsWith("FSReq") || name === "FileHandleCloseReq");

/**
 * Runs fake timers until `done()` holds, moving the clock only while the code
 * under test waits on a fake timer. While a real file request is in flight,
 * it gives the event loop real turns and leaves the clock alone, so a slow
 * disk cannot make faked time run past a deadline the code has not reached.
 */
export async function driveFakeClockUntil(timers: FakeTimerDriver, done: () => boolean): Promise<void> {
  for (;;) {
    do {
      await new Promise((resolve) => realSetImmediate(resolve));
    } while (!done() && fileRequestPending());
    if (done()) return;
    if (timers.getTimerCount() === 0) throw new Error("Nothing is pending: no file request and no fake timer.");
    await timers.advanceTimersToNextTimerAsync();
  }
}
