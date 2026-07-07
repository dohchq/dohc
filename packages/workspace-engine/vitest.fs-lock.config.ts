import { defineConfig } from "vitest/config";

// Isolated pass for the on-disk history store's fs-lock/timing-sensitive
// suites (changeSetStore.test.ts and versionedFileWorkspace.test.ts). They run
// ALONE (second step of the `test` script, after the parallel default pass) in
// a fresh, uncontended worker so their data-integrity assertions are reliable:
// the 25-write concurrency test proves the history lock drops no entries, the
// stale-lock reclaim tests key off heartbeat age, and the history-restore tests
// touch the same anchored store — all of which unrelated fs-heavy files racing
// on parallel workers can destabilise (CPU starvation makes a live lock look
// stale, or a restore/25-cycle sequence exceeds the stock 5s ceiling). This
// replaces the over-broad whole-package `fileParallelism: false`.
export default defineConfig({
  test: {
    include: ["src/changeSetStore.test.ts", "src/versionedFileWorkspace.test.ts"],
    fileParallelism: false,
    // The 25 serialized fs-lock acquire/release cycles are legitimately slow;
    // the stock 5s per-test ceiling is too tight on loaded CI/WSL hosts.
    testTimeout: 30_000,
  },
});
