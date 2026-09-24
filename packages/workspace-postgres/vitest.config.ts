import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Tests apply the full schema to a real Postgres beside every other package
    // in the gate. 30 s matches sync-relay.
    testTimeout: 30_000,
  },
});
