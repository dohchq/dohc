import { setImmediate } from "node:timers/promises";

/**
 * Owns a run's interruption. A signal interrupts it. With `stopOnFailure`, so
 * does its first confirmed failure: `stop` aborts `signal`, which interrupts
 * every command given it as a signal would, and later steps refuse to start.
 */
export function cancellationScope(label, { stopOnFailure = false } = {}) {
  let cancellation;
  const stopping = new AbortController();
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
  const stopped = () => stopping.signal.aborted ? stopping.signal.reason : null;
  return {
    signal: stopping.signal,
    /** The stop's cause, `{ step, error }` with a message for its rows, or null. */
    get stopped() { return stopped(); },
    /** Stop the run because `step` failed with `error` after its retries. An interruption by signal is not a failure. */
    stop(step, error) {
      if (!stopOnFailure || cancellation || stopped()) return;
      stopping.abort(Object.assign(new Error(`Stopped after ${step} failed.`), { stopped: true, step, error }));
    },
    /** Mark a row that ended because the run stopped, not by its own failure. */
    notRun(row, error) {
      const cause = stopped();
      if (!cause || error === cause.error || !(error?.stopped || error?.interrupted)) return false;
      Object.assign(row, { verdict: "NOT RUN", reason: `stopped after ${cause.step} failed` });
      return true;
    },
    /** After a stop, add a NOT RUN row for each expected step that never started, and name every unfinished step. */
    unfinished(steps, expected = []) {
      const cause = stopped();
      if (!cause) return null;
      for (const name of expected) if (!steps.some(step => step.name === name)) steps.push({ name, verdict: "NOT RUN", reason: `stopped after ${cause.step} failed` });
      return { after: cause.step, notRun: steps.filter(step => step.verdict === "NOT RUN").map(step => step.name) };
    },
    async checkpoint() { await drain(); if (cancellation) throw cancellation; },
    async dispose() {
      await drain();
      process.off("SIGINT", onInt);
      process.off("SIGTERM", onTerm);
      return cancellation;
    },
  };
}
