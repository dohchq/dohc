#!/usr/bin/env node
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { constants as osConstants, tmpdir } from "node:os";
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
// makes for the Electron user data dir. Measured cost: ~2s per invocation of
// cold compilation, paid for never losing a run to a shared cache.

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

// Resolves and validates the CLI entry, naming the constraint and the remedy
// when the package is missing. This must run inside runPlaywright's guarded
// flow: a default parameter evaluates before any try block, and spawning
// node with a nonexistent script "succeeds" and exits 1 with node's own
// message — both paths would bypass the actionable error.
export function requirePlaywrightCli(cliPath, resolveCli = playwrightCliPath) {
  let resolved = cliPath ?? null;
  if (resolved === null) {
    try {
      resolved = resolveCli();
    } catch (error) {
      throw new Error(
        "Could not resolve the playwright package. The e2e scripts need it installed; run pnpm install.",
        { cause: error },
      );
    }
  }
  if (!existsSync(resolved)) {
    throw new Error(
      `Could not launch the Playwright CLI at ${resolved}. The e2e scripts need the playwright package installed; run pnpm install.`,
    );
  }
  return resolved;
}

// Runs the CLI with a per-run transform cache and resolves to the process
// exit code. The seams exist for the tests; production passes only argv.
/**
 * @param {string[]} args
 * @param {{
 *   env?: NodeJS.ProcessEnv,
 *   cliPath?: string,
 *   platform?: NodeJS.Platform,
 *   spawnImpl?: typeof spawn,
 *   mkdtempImpl?: typeof mkdtempSync,
 *   rmImpl?: typeof rmSync,
 *   onTermination?: (forward: (signal: string) => void) => void,
 * }} [options]
 * @returns {Promise<number>}
 */
export async function runPlaywright(args, {
  env = process.env,
  cliPath = undefined,
  platform = process.platform,
  spawnImpl = spawn,
  mkdtempImpl = mkdtempSync,
  rmImpl = rmSync,
  onTermination = (forward) => {
    for (const signal of ["SIGINT", "SIGTERM"]) {
      process.on(signal, () => forward(signal));
    }
  },
} = {}) {
  const cli = requirePlaywrightCli(cliPath);
  const cacheDir = mkdtempImpl(join(tmpdir(), "dohc-playwright-cache-"));
  const child = spawnImpl(process.execPath, [cli, "test", ...args], {
    stdio: "inherit",
    env: playwrightRunEnv(env, cacheDir),
  });
  // The wrapper PID must be enough to stop the whole run, and the cleanup
  // below must run on the cancel path too. On POSIX that means forwarding
  // the signal and staying alive until the child exits. On Windows the
  // console has already delivered Ctrl+C to the child, and kill() would be
  // TerminateProcess — a hard kill on top of Playwright's own graceful
  // shutdown, truncating report and trace flushes — while the libuv job
  // object already ends the child if the wrapper dies. So Windows only
  // waits. A hard kill of the wrapper itself can still leak the directory,
  // which costs disk; a shared directory costs the run.
  onTermination((signal) => {
    if (platform !== "win32") child.kill(signal);
  });
  try {
    const [code, signal] = await once(child, "exit");
    if (code !== null) return code;
    // A signal exit keeps its conventional code: 128 + signal number.
    const signalNumber = osConstants.signals[signal];
    return signalNumber ? 128 + signalNumber : 1;
  } catch (error) {
    throw new Error(
      `Could not launch the Playwright CLI at ${cli}. The e2e scripts need the playwright package installed; run pnpm install.`,
      { cause: error },
    );
  } finally {
    rmImpl(cacheDir, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === scriptPath) {
  try {
    process.exitCode = await runPlaywright(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
