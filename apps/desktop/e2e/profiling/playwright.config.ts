import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: ".",
  testMatch: "**/*.spec.ts",
  fullyParallel: false,
  workers: 1,
  timeout: 10 * 60_000,
  expect: {
    timeout: 60_000,
  },
  retries: 0,
  reporter: [["list"]],
  use: {
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
  outputDir: "../../../../test-results/desktop-profiling-playwright",
});
