import { defineConfig } from "@playwright/test";
import { existsSync } from "node:fs";
import { platform } from "node:os";

// In WSL, Node can inherit Windows TEMP/TMP and put fixtures under /mnt/c.
// DrvFs does not reliably surface inotify events to chokidar, which makes
// watcher-history specs miss real file changes. Keep Windows-native runs on
// their normal temp dir, but prefer the Linux tmpfs when no explicit TMPDIR
// was supplied.
if (platform() !== "win32" && !process.env.TMPDIR && existsSync("/tmp")) {
  process.env.TMPDIR = "/tmp";
}

// Dedicated desktop E2E config: Electron instances cannot safely run in
// parallel on one display, and the web app's dev server is irrelevant here.
// The root playwright.config.ts stays untouched for `pnpm test:e2e` (web).
export default defineConfig({
  testDir: "./e2e",
  testMatch: "**/*.spec.ts",
  workers: 1,
  timeout: 60_000,
  expect: {
    timeout: 10_000,
  },
  retries: 0,
  reporter: [["list"]],
  use: {
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
  outputDir: "../../test-results/desktop-e2e",
});
