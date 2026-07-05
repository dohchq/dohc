import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/bench/storageBench.ts"],
    reporters: ["verbose"],
    testTimeout: 120_000,
  },
});
