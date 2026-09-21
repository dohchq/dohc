import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    exclude: [...configDefaults.exclude, "e2e/**"],
    // Bound concurrent browser fixtures and child-service startups on shared hosts.
    maxWorkers: 4,
  },
});
