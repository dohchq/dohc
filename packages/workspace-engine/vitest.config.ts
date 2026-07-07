import { configDefaults, defineConfig } from "vitest/config";

// Default engine pass: every test file EXCEPT the on-disk history store's
// fs-lock/timing-sensitive suites (changeSetStore.test.ts and
// versionedFileWorkspace.test.ts). Both drive the same anchored history store,
// whose lock serializes concurrent writes and reclaims stale locks by
// heartbeat age — timing that unrelated fs-heavy files racing on parallel
// workers can genuinely destabilise (a CPU-starved live lock can look stale,
// or a history restore times out under contention). They run alone in a serial
// pass (vitest.fs-lock.config.ts, wired into the `test` script). Everything
// else runs fully parallel here, so the bulk of the suite is fast — replacing
// the whole-package `fileParallelism: false` that had dragged it to minutes.
export default defineConfig({
  test: {
    exclude: [
      ...configDefaults.exclude,
      "**/changeSetStore.test.ts",
      "**/versionedFileWorkspace.test.ts",
    ],
    // Running files in parallel raises the wall-clock of any single heavy
    // integration/fs test under CPU contention (e.g. the phase-0 proof arc),
    // and the stock 5s per-test ceiling is too tight for that on loaded CI/WSL
    // hosts. This is headroom, not a correctness lever — a genuinely wrong
    // result still fails its assertion, not the clock.
    testTimeout: 20_000,
  },
});
