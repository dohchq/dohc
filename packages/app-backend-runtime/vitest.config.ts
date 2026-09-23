import { defineConfig } from "vitest/config";

export default defineConfig({
  // These suites spawn supervised SQLite workers with real execution deadlines.
  // Bound test-file concurrency so host startup contention does not consume them.
  test: { maxWorkers: 2 },
});
