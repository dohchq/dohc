import { defineConfig } from "vitest/config";

// e2e/ runs under Playwright (playwright.config.ts), never vitest.
export default defineConfig({
  test: {
    include: ["src/**/*.test.{ts,tsx}"],
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
