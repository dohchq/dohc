import { setImmediate } from "node:timers/promises";

export function cancellationScope(label) {
  let cancellation;
  const interrupt = (signal) => {
    cancellation ??= new Error(`${label} interrupted by ${signal}.`);
    process.exitCode = signal === "SIGINT" ? 130 : 143;
  };
  const onInt = () => interrupt("SIGINT");
  const onTerm = () => interrupt("SIGTERM");
  process.on("SIGINT", onInt);
  process.on("SIGTERM", onTerm);
  const drain = async () => {
    // A signal queued during synchronous work needs a poll phase. The first
    // immediate can run in the current iteration; the second crosses a poll.
    await setImmediate();
    await setImmediate();
  };
  return {
    async checkpoint() { await drain(); if (cancellation) throw cancellation; },
    async dispose() {
      await drain();
      process.off("SIGINT", onInt);
      process.off("SIGTERM", onTerm);
      return cancellation;
    },
  };
}
