import { defineConfig } from "vitest/config";

// 30s is the floor for the 8 test files here that do NOT spawn a relay child.
//
// The 3 that do — main/dm/presence.integration — raise their own budgets per file,
// because their spawn helper now allows 45s for the port line: it launches
// `node --import tsx/esm src/main.ts`, which COMPILES on startup and measured 12-15s
// under load. That startup deadline, not any assertion, is what failed these tests
// in #372. Keeping the package floor tight means a hang in the other 8 files still
// surfaces in 30s rather than 90.
export default defineConfig({
  test: {
    testTimeout: 30_000,
  },
});
