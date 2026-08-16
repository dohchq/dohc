// Electron's utilityProcess never exits on its own when a forked script's
// work is done (electron/electron#47228): a parent-port pipe stays ref'd, so
// Node's auto-exit and its `beforeExit` event never fire. Measured under
// Electron 43.3.0: a child whose work finished at 1.5 s was still running at
// 8 s. This wrapper is what the install runner forks, and it decides when
// pnpm is finished.
//
// It cannot decide that by importing pnpm. The pinned pnpm starts its CLI in
// a floating async IIFE — `(async () => { await runPnpm() })()` in
// dist/pnpm.mjs — so `await import()` settles when that bundle's synchronous
// top level ends, not when the install ends. Exiting there killed pnpm
// mid-install and still reported exit 0: measured, a one-package install
// "succeeded" in 623 ms and wrote no node_modules at all.
//
// A worker thread has its own event loop, which Node ends exactly where
// `node pnpm.mjs` would have exited. Its `exit` event carries pnpm's real
// code, and its stdout and stderr go to this process's own pipes.
import { pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";

// Local on purpose, not pluginShared's: this file is a standalone child
// entry that plain Node can execute directly from source, where an
// extension-less relative import does not resolve under type stripping.
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const [pnpmEntry, ...pnpmArgs] = process.argv.slice(2);
if (!pnpmEntry) {
  console.error("pluginPnpmRunnerProcess: missing the pnpm entry path argument.");
  process.exit(1);
}

// `argv` lands in the worker as process.argv.slice(2) — exactly where pnpm's
// own bin reads its CLI arguments.
const worker = new Worker(pathToFileURL(pnpmEntry), { argv: pnpmArgs });
worker.once("error", (error: unknown) => {
  console.error(`pluginPnpmRunnerProcess: pnpm failed: ${errorMessage(error)}`);
  process.exit(1);
});
worker.once("exit", (code: number) => {
  process.exit(code);
});
