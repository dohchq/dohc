import { defineConfig } from "vitest/config";
import { DEFAULT_LIMITS } from "./src/protocol.ts";

// These suites spawn supervised SQLite workers with real execution deadlines.
// Run test files one at a time so workers from other files do not consume them.
// Windows can hold one fsync for seconds, so a test or cleanup hook gets several
// worker steps at the product deadline. A slow step then fails on that deadline.
const workerStepsMs = 4 * DEFAULT_LIMITS.deadlineMs;

export default defineConfig({
  test: { maxWorkers: 1, testTimeout: workerStepsMs, hookTimeout: workerStepsMs },
});
