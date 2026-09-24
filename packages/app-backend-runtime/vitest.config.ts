import { defineConfig } from "vitest/config";

export default defineConfig({
  // These suites spawn supervised SQLite workers with real execution deadlines.
  // Bound test-file concurrency so host startup contention does not consume them.
  // Full gates beside other work timed out two runtime tests at vitest's 5 s
  // default. 30 s matches sync-relay.
  test: { maxWorkers: 2, testTimeout: 30_000 },
});
