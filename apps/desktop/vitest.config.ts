import { availableParallelism } from "node:os";
import { defineConfig } from "vitest/config";

// At most 8 concurrent workers. Fifteen of these suites open their own temp
// `.dohc/engine/engine.db`, and past roughly eight the filesystem is the
// constraint rather than the CPU — so a bigger machine must not buy more
// contention. Evidence and the failure modes are on #392.
const WORKER_CAP = Math.min(8, Math.max(2, Math.floor(availableParallelism() / 4)));

// e2e/ runs under Playwright (playwright.config.ts), never vitest.
export default defineConfig({
  test: {
    include: ["src/**/*.test.{ts,tsx}"],
    // Fills jsdom's missing hit-testing APIs. See the file for why an absent
    // document.elementFromPoint failed whole runs rather than single tests.
    setupFiles: ["./vitest.setup.ts"],
    maxWorkers: WORKER_CAP,
    minWorkers: 1,
    // Without this vitest stubs every *.css import to "" — including the
    // `styles.css?raw` source text tokens.test.ts parses for the
    // tokens.ts ⟷ styles.css sync guard.
    css: true,
    // node >= 25 ships a default-on WebStorage whose localStorage global is
    // created WITHOUT a backing file in the workers ("--localstorage-file was
    // provided without a valid path") and shadows jsdom's real Storage, so
    // renderer tests using localStorage (theme.test.ts) fail. Disable node's
    // copy in the test workers; jsdom's localStorage takes over.
    poolOptions: {
      forks: { execArgv: ["--no-experimental-webstorage"] },
      threads: { execArgv: ["--no-experimental-webstorage"] },
    },
  },
});
