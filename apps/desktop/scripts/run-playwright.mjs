#!/usr/bin/env node
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Playwright compiles playwright.config.ts and every spec through a transform
// cache that defaults to os.tmpdir()/playwright-transform-cache — one
// directory for the whole machine (playwright/lib/common/index.js). Writing a
// cache entry first rmSync's every entry for the same source path
// (clearOldCacheEntries), and the write itself is not atomic, so a concurrent
// run can read a deleted or half-written compiled config and die at startup.
// The cache directory is fixed when the CLI process loads, before the config
// compiles, so the only place to isolate it is here, before the CLI starts:
// every run gets its own cache directory — the same hermetic move the harness
// makes for the Electron user data dir.

const scriptPath = fileURLToPath(import.meta.url);

export function playwrightCliPath() {
  const requireFromHere = createRequire(import.meta.url);
  return join(dirname(requireFromHere.resolve("playwright/package.json")), "cli.js");
}

// Overrides any inherited PWTEST_CACHE_DIR on purpose: per-run isolation is
// this wrapper's contract. To pin a cache directory, run the CLI directly.
export function playwrightRunEnv(baseEnv, cacheDir) {
  return { ...baseEnv, PWTEST_CACHE_DIR: cacheDir };
}

if (process.argv[1] && resolve(process.argv[1]) === scriptPath) {
  const cacheDir = mkdtempSync(join(tmpdir(), "dohc-playwright-cache-"));
  const child = spawn(
    process.execPath,
    [playwrightCliPath(), "test", ...process.argv.slice(2)],
    { stdio: "inherit", env: playwrightRunEnv(process.env, cacheDir) },
  );
  // The wrapper PID must be enough to stop the whole run: forward
  // termination to the CLI child and stay alive until it exits, so the
  // cleanup below runs on the cancel path too. Windows has no catchable
  // SIGTERM — a hard kill can still leak the directory, which costs disk;
  // a shared directory costs the run.
  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.on(signal, () => child.kill(signal));
  }
  try {
    const [code] = await once(child, "exit");
    process.exitCode = code ?? 1;
  } finally {
    rmSync(cacheDir, { recursive: true, force: true });
  }
}
