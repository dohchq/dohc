import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Table, board, and picker renders take up to half a second on a quiet
    // host. vitest.setup.ts gives Testing Library waits 10 s, inside a 30 s
    // test bound, as apps/desktop does.
    setupFiles: ["./vitest.setup.ts"],
    testTimeout: 30_000,
  },
});
