import { defineConfig } from "vitest/config";

// Playwright owns the browser acceptance specs in e2e/; vitest runs the unit
// tests that sit beside the source they cover.
export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
  },
});
