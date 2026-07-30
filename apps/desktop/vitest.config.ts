import { defineConfig } from "vitest/config";

// e2e/ runs under Playwright (playwright.config.ts), never vitest.
export default defineConfig({
  test: {
    include: ["src/**/*.test.{ts,tsx}"],
    // Without this vitest stubs every *.css import to "" — including the
    // `styles.css?raw` source text tokens.test.ts parses for the
    // tokens.ts ⟷ styles.css sync guard.
    css: true,
    // vitest's 5s default was never calibrated for THIS suite. 191 files run in
    // parallel and among them are tests that write 2001 real files, spawn real
    // process trees, and await lazily-imported CodeMirror in jsdom. Those are
    // wall-clock-bound, so under contention they lost their races and produced
    // red results unrelated to the diff under test — five different tests across
    // four verification runs (#372). Every one passed in isolation.
    //
    // 15s is still a hang detector: the whole suite finishes in ~60s, so a test
    // sitting for 15s is genuinely stuck, not merely unlucky. Raising this does
    // not hide slowness — it stops a parallelism artifact from being reported as
    // a failure, which is what trains people to discount a red gate.
    testTimeout: 15_000,
    // afterEach hooks here delete temp trees and stop spawned processes; the
    // same contention applies.
    hookTimeout: 15_000,
    // node >= 25 ships a default-on WebStorage whose localStorage global is
    // created WITHOUT a backing file in the workers ("--localstorage-file was
    // provided without a valid path") and shadows jsdom's real Storage, so
    // renderer tests using localStorage (theme.test.ts) fail. Disable node's
    // copy in the test workers; jsdom's localStorage takes over.
    poolOptions: {
      forks: { execArgv: ["--no-experimental-webstorage"] },
      threads: { execArgv: ["--no-experimental-webstorage"] },
    },
  },
});
