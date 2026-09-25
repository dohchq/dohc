import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Postgres-backed tests hash passwords and migrate a real schema beside
    // every other package in the gate. 30 s matches sync-relay.
    testTimeout: 30_000,
  },
});
