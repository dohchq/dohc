import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Watcher tests wait on real filesystem events, which a loaded gate host
    // delays. 30 s matches sync-relay.
    testTimeout: 30_000,
  },
});
