import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { defineConfig } from "vitest/config";
import { DEFAULT_LIMITS } from "./src/protocol.ts";

// macOS $TMPDIR is a link into /private. Tests that make folders under
// os.tmpdir() must hold the path that code resolving links sees.
if (process.platform !== "win32") process.env.TMPDIR = realpathSync(tmpdir());

// These suites spawn supervised SQLite workers with real execution deadlines.
// Run test files one at a time so workers from other files do not consume them.
// Windows can hold one fsync for seconds, so a test or cleanup hook gets several
// worker steps at the product deadline. A slow step then fails on that deadline.
const workerStepsMs = 4 * DEFAULT_LIMITS.deadlineMs;

export default defineConfig({
  test: { maxWorkers: 1, testTimeout: workerStepsMs, hookTimeout: workerStepsMs },
});
