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

const configuredWorkers = Number.parseInt(process.env.PLAYWRIGHT_WORKERS ?? "", 10);
const desktopWorkers = configuredWorkers > 0 ? configuredWorkers : 1;

// Dedicated desktop E2E config: Electron instances cannot safely run in
// parallel on one display. Keep CI serial by default; set PLAYWRIGHT_WORKERS
// locally to benchmark isolated-display parallelism. The renderer profiling
// harness has its own config and is excluded here; run this default suite via
// `pnpm test:desktop:e2e`.
export default defineConfig({
  testDir: "./e2e",
  testMatch: "**/*.spec.ts",
  testIgnore: "**/profiling/**",
  workers: desktopWorkers,
  timeout: 60_000,
  expect: {
    timeout: 30_000,
  },
  retries: 0,
  reporter: [["list"]],
  use: {
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
  outputDir: "../../test-results/desktop-e2e",
});
