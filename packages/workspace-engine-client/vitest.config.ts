import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Clients here drive real streams and child processes beside every other
    // package in the gate. 30 s matches sync-relay.
    testTimeout: 30_000,
  },
});
