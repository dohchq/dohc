import * as Effect from "effect/Effect";

// Yield even at zero delay, without keeping an idle main process alive.
export const ownerDeliveryWait = (delayMs: number) => Effect.callback<void>(resume => {
  const timer = setTimeout(() => resume(Effect.void), delayMs);
  timer.unref();
  return Effect.sync(() => clearTimeout(timer));
});
