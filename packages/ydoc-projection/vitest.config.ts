import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Bound concurrent durable SQLite fixtures on shared development machines.
    maxWorkers: 4,
    // The gate runs these durable SQLite suites beside every other package. On a
    // loaded host four storage tests exceeded vitest's 5 s default in one run,
    // while the package took 18 minutes. 30 s matches sync-relay.
    testTimeout: 30_000,
    // expect.poll's own default is 1 s; a loaded host needs the same 10 s as desktop.
    expect: { poll: { timeout: 10_000 } },
  },
});
