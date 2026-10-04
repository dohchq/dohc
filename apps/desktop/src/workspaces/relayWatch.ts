import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";

// The engine's wait on the relay for a change past the cursor its last pull
// reached. One read runs at a time. A new cursor aborts the current read at
// once, and the next read starts only after that one has ended, so a read that
// ignores its signal never overlaps its successor or outlives stop().
export function startRelayWatch(input: {
  wait: (since: number, signal: AbortSignal) => Promise<boolean>;
  initialDelayMs: number;
  maxDelayMs: number;
  // The log moved past `since`. The watch waits for the next cursor.
  changed: (since: number) => void;
  // A read failed. The watch backs off and reads again, unless this stops it.
  failed: (error: unknown) => void;
}) {
  const lifetime = new AbortController();
  // The newest cursor, until the worker takes it. A stuck one backs off first.
  let next: { since: number; stuck: boolean } | undefined;
  // The cursor the worker waits past, until it reports a change.
  let watching: number | undefined;
  let read: AbortController | undefined;
  let wake: (() => void) | undefined;

  // Resumes when a new cursor arrives, or after `delayMs`.
  const untilNext = (delayMs?: number) => Effect.callback<void>((resume) => {
    if (next !== undefined) return resume(Effect.void);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const settle = () => {
      clearTimeout(timer);
      wake = undefined;
    };
    wake = () => {
      settle();
      resume(Effect.void);
    };
    if (delayMs !== undefined) timer = setTimeout(wake, delayMs);
    return Effect.sync(settle);
  });

  const finished = Effect.runPromiseExit(Effect.gen(function* () {
    let since: number | undefined;
    let backoff = false;
    let delayMs = input.initialDelayMs;
    while (!lifetime.signal.aborted) {
      if (next !== undefined) {
        ({ since, stuck: backoff } = next);
        if (!backoff) delayMs = input.initialDelayMs;
        next = undefined;
      }
      if (since === undefined) {
        yield* untilNext();
        continue;
      }
      if (backoff) {
        backoff = false;
        const ms = delayMs;
        delayMs = Math.min(input.maxDelayMs, delayMs * 2);
        yield* untilNext(ms);
        if (next !== undefined) continue;
      }
      const from = since;
      const controller = new AbortController();
      read = controller;
      // Abort only asks the read to end; the worker still waits for it.
      const result = yield* Effect.uninterruptible(Effect.exit(Effect.tryPromise({
        try: () => input.wait(from, controller.signal),
        catch: (error) => error,
      })));
      read = undefined;
      // A newer cursor replaced this read.
      if (controller.signal.aborted) continue;
      if (result._tag === "Failure") {
        backoff = true;
        input.failed(Cause.squash(result.cause));
      } else if (result.value) {
        since = undefined;
        watching = undefined;
        input.changed(from);
      }
    }
  }), { signal: lifetime.signal }).then((exit) => {
    if (exit._tag === "Failure" && !Cause.hasInterruptsOnly(exit.cause)) {
      console.error("[desktop] relay change wait stopped:", Cause.squash(exit.cause));
    }
  });

  return {
    // A cursor the watch already waits past changes nothing unless it is stuck.
    watchPast(since: number, stuck: boolean): void {
      if (lifetime.signal.aborted || (!stuck && watching === since)) return;
      watching = since;
      next = { since, stuck };
      read?.abort();
      wake?.();
    },
    // Aborts at once, and settles when the current read has ended.
    stop(): Promise<void> {
      lifetime.abort();
      read?.abort();
      return finished;
    },
  };
}
