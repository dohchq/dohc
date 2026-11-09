// Phase 0: how long a cold start takes to show content.
// React Native records when its runtime started; its TypeScript types omit it.
interface StartupTiming { readonly startTime?: number | null }

/** Milliseconds from React Native's runtime start to now, or null when the platform doesn't record it. */
export function msSinceStartup(): number | null {
  const start = (performance as Performance & { rnStartupTiming?: StartupTiming }).rnStartupTiming?.startTime;
  return typeof start === "number" ? performance.now() - start : null;
}
