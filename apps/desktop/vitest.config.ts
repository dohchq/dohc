import { availableParallelism } from "node:os";
import { createRequire } from "node:module";
import { dirname } from "node:path";
import { defineConfig } from "vitest/config";

// At most 8 concurrent workers. Fifteen of these suites open their own temp
// `.dohc/engine/engine.db`, and past roughly eight the filesystem is the
// constraint rather than the CPU — so a bigger machine must not buy more
// contention. Evidence and the failure modes are on #392.
const WORKER_CAP = Math.min(8, Math.max(2, Math.floor(availableParallelism() / 4)));
const require = createRequire(import.meta.url);

// e2e/ runs under Playwright (playwright.config.ts), never vitest.
export default defineConfig({
  // Source-backed examples outside this package use the same React instance as their desktop tests.
  resolve: { alias: {
    react: dirname(require.resolve("react/package.json")),
    "react-dom": dirname(require.resolve("react-dom/package.json")),
  } },
  test: {
    include: ["src/**/*.test.{ts,tsx}", "plugins/**/src/**/*.test.ts"],
    css: { include: [/[?&]raw(?:&|$)/] },
    // Fills jsdom's missing hit-testing APIs. See the file for why an absent
    // document.elementFromPoint failed whole runs rather than single tests.
    // `testSetup.ts` registers the scratch-directory cleanup every suite needs.
    // Dropping `./vitest.setup.ts` fails `src/vitestSetup.test.ts` by name,
    // so the suite can no longer go red without naming a test.
    setupFiles: ["./vitest.setup.ts", "./src/testSetup.ts"],
    maxWorkers: WORKER_CAP,
    // node >= 25 ships a default-on WebStorage whose localStorage global is
    // created without a backing file in the workers ("--localstorage-file was
    // provided without a valid path") and shadows jsdom's real Storage, so
    // renderer tests using localStorage (theme.test.ts) fail. Disable node's
    // copy in the test workers; jsdom's localStorage takes over.
    execArgv: ["--no-experimental-webstorage"],
  },
});
