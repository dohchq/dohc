// Phase 0: how long a cold start takes to show content.
// React Native records when its runtime started; its TypeScript types omit it.
interface StartupTiming {
  readonly startTime?: number | null;
}

/** Milliseconds from React Native's runtime start to now, or null when the platform doesn't record it. */
export function msSinceStartup(): number | null {
  const start = (performance as Performance & { rnStartupTiming?: StartupTiming }).rnStartupTiming
    ?.startTime;
  return typeof start === "number" ? performance.now() - start : null;
}

export type LaunchStep = "keychain" | "databases" | "chosen" | "chats";

/** The first time each step of a launch finished, in ms from React Native's runtime start. */
export function createLaunchTimings(since: () => number | null = msSinceStartup) {
  const marks = new Map<LaunchStep, number>();
  return {
    mark(step: LaunchStep) {
      const ms = since();
      if (ms !== null && !marks.has(step)) marks.set(step, Math.round(ms));
    },
    marks: (): ReadonlyMap<LaunchStep, number> => marks,
  };
}

export const launchTimings =
  process.env.EXPO_PUBLIC_DOHC_TIMINGS === "1" ? createLaunchTimings() : null;
