import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

// macOS $TMPDIR is a link into /private. Tests that make folders under
// os.tmpdir() must hold the path that code resolving links sees.
if (process.platform !== "win32") process.env.TMPDIR = realpathSync(tmpdir());

// These suites spawn supervised SQLite workers with real execution deadlines.
// Run test files one at a time so workers from other files do not consume them.
// Windows can hold one fsync for seconds, so a test or cleanup hook gets several
// worker steps at the product deadline. A slow step then fails on that deadline.
const workerStepsMs = 32_000;

export default defineConfig({
  resolve: {
    alias: {
      "dohc/app": resolve(import.meta.dirname, "../app-kit/src/app.tsx"),
      "dohc/ui": resolve(import.meta.dirname, "../app-kit/src/ui.tsx"),
      "dohc/charts": resolve(import.meta.dirname, "../app-kit/src/charts.tsx"),
      "dohc/icons": resolve(import.meta.dirname, "../app-kit/src/icons.ts"),
      "dohc/money": resolve(import.meta.dirname, "../app-kit/src/money.ts"),
      "dohc/csv": resolve(import.meta.dirname, "../app-kit/src/csv.ts"),
    },
  },
  test: { maxWorkers: 1, testTimeout: workerStepsMs, hookTimeout: workerStepsMs },
});
