import { defineConfig } from "@playwright/test";

// The editing-together tests: headless browsers on a share link against a self-hosted server on
// this machine. They start no desktop app, so they run apart from the desktop suite, with
// `pnpm test:together`. Every case starts a server of its own.
export default defineConfig({
  testDir: "./e2e/together",
  testMatch: "**/*.spec.ts",
  workers: 3,
  timeout: 180_000,
  expect: {
    timeout: 30_000,
  },
  retries: 0,
  // The JSON report holds what each case's pages showed and what the services said.
  reporter: [["list"], ["json", { outputFile: "../../test-results/together-report.json" }]],
  use: {
    // No click in these tests should wait long for its target. Without a limit one would wait until the test ends.
    actionTimeout: 30_000,
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
  outputDir: "../../test-results/together",
});
