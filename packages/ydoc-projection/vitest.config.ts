import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Bound concurrent durable SQLite fixtures on shared development machines.
    maxWorkers: 4,
  },
});
