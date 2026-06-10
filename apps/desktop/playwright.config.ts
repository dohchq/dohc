import { defineConfig } from "@playwright/test";

// Dedicated desktop E2E config: Electron instances cannot safely run in
// parallel on one display, and the web app's dev server is irrelevant here.
// The root playwright.config.ts stays untouched for `pnpm test:e2e` (web).
export default defineConfig({
  testDir: "./e2e",
  workers: 1,
  timeout: 60_000,
  retries: 0,
  reporter: [["list"]],
  outputDir: "../../test-results/desktop-e2e",
});
