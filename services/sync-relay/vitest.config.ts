import { defineConfig } from "vitest/config";

// main.integration.test.ts drives the REAL relay: it spawns the service as a
// child process, waits for it to report a listening port, and then moves
// journal ops and blobs over real HTTP against real SQLite. Its own spawn
// helper allows 15s just for the port line — three times vitest's stock 5s
// per-test ceiling — so under the root `pnpm run test` (every package in
// parallel) these tests could exhaust their budget inside setup and fail the
// clock rather than an assertion. Same headroom the engine package already
// takes, for the same reason: a genuinely wrong result still fails its
// assertion.
export default defineConfig({
  test: {
    testTimeout: 30_000,
  },
});
