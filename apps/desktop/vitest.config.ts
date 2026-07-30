import { cpus } from "node:os";
import { defineConfig } from "vitest/config";

// Cap the worker pool. vitest defaults to roughly one fork per core, and on a
// 32-core box that is ~31 forks — many of which spawn an engine daemon and hold
// a SQLite handle on their own temp `.dohc/engine/engine.db`. That oversubscribes
// a machine that is rarely running this suite alone, and the failures it produces
// are indistinguishable from real ones.
//
// Measured on this repo, same commit, three full-suite runs at the default:
// three DISJOINT failure sets, every failure green in isolation. One run named
// its cause outright — `Test timed out in 5000ms` followed by `EBUSY: resource
// busy or locked, unlink '...\.dohc\engine\engine.db'` across four files at once.
//
// With the cap at 8: EBUSY occurrences went from that cluster to ZERO, and two
// consecutive runs gave 1 failure then 0. See #392.
//
// A quarter of the cores, floor 2, ceiling 8. The ceiling matters more than the
// fraction: past roughly eight concurrent engine daemons the filesystem, not the
// CPU, is the constraint, so a bigger machine should not buy more contention.
const WORKER_CAP = Math.min(8, Math.max(2, Math.floor(cpus().length / 4)));

// e2e/ runs under Playwright (playwright.config.ts), never vitest.
export default defineConfig({
  test: {
    include: ["src/**/*.test.{ts,tsx}"],
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
