import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Tool tests import and query real SQLite files; two take close to 1 s on a
    // quiet host. 30 s matches sync-relay.
    testTimeout: 30_000,
  },
});
