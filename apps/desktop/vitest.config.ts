import { defineConfig } from "vitest/config";

// e2e/ runs under Playwright (playwright.config.ts), never vitest.
export default defineConfig({
  test: {
    include: ["src/**/*.test.{ts,tsx}"],
  },
});
