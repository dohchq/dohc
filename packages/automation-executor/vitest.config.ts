import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // These suites write run files and start the formula evaluator's worker
    // beside every other package in the gate. 30 s matches the desktop suites
    // they came from.
    testTimeout: 30_000,
  },
});
