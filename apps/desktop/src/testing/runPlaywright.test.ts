import { statSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { playwrightCliPath, playwrightRunEnv } from "../../scripts/run-playwright.mjs";

// The wrapper that gives every Playwright run its own transform cache
// directory, so concurrent runs cannot delete or tear each other's compiled
// config in the machine-wide os.tmpdir()/playwright-transform-cache.

describe("playwrightCliPath", () => {
  it("resolves to an existing Playwright CLI entry", () => {
    const cli = playwrightCliPath();
    expect(cli.endsWith("cli.js")).toBe(true);
    expect(statSync(cli).isFile()).toBe(true);
  });
});

describe("playwrightRunEnv", () => {
  it("points PWTEST_CACHE_DIR at the per-run directory", () => {
    const env = playwrightRunEnv({ PATH: "/bin" }, "/runs/cache-1");
    expect(env.PWTEST_CACHE_DIR).toBe("/runs/cache-1");
  });

  it("keeps the rest of the environment", () => {
    const env = playwrightRunEnv({ PATH: "/bin", HOME: "/home/u" }, "/runs/cache-1");
    expect(env.PATH).toBe("/bin");
    expect(env.HOME).toBe("/home/u");
  });

  it("overrides an inherited PWTEST_CACHE_DIR — isolation is unconditional", () => {
    const env = playwrightRunEnv(
      { PWTEST_CACHE_DIR: "/machine/shared-cache" },
      "/runs/cache-2",
    );
    expect(env.PWTEST_CACHE_DIR).toBe("/runs/cache-2");
  });
});
