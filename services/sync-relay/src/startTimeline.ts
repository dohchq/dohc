/**
 * How long each part of the relay's start took, for one line it writes when it listens. The relay writes
 * nothing else before then, so without this line a slow start does not say where its time went.
 */
export function createStartTimeline(sinceProcessStartMs = () => process.uptime() * 1000) {
  const steps: Array<[string, number]> = [];
  let through = 0;
  return {
    /** Ends a step. It began when the step before it ended, and the first began with the process. */
    done(step: string): void {
      const now = sinceProcessStartMs();
      steps.push([step, now - through]);
      through = now;
    },
    line(): string {
      const parts = steps.map(([step, ms]) => `${step} ${String(Math.round(ms))}`);
      return `started in ${String(Math.round(through))} ms: ${parts.join(", ")}`;
    },
  };
}
