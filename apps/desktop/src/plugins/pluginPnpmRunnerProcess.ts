// Electron's utilityProcess does not exit on its own once a forked script's
// visible work is done, unlike a plain Node child process — this is a
// documented Electron limitation (electron/electron#47228), not something a
// vendored CLI script can be expected to know about or opt out of. pnpm's own
// bin/pnpm.mjs never calls process.exit() on its success path (it relies on
// normal Node auto-exit once the event loop empties), so forking it directly
// left the plugin install runner waiting forever for an 'exit' event that
// never arrives, hitting only its own timeout every single time.
//
// This wrapper is what actually gets forked instead. It imports the pinned
// pnpm entry IN THIS SAME PROCESS (never spawns a further child — a packaged
// app has no system node, so there is nothing else to spawn) and then calls
// process.exit() itself once that import's top-level execution completes,
// which is what makes the utility process actually terminate and lets
// PluginHost's Electron-side transport observe a real exit.
//
// argv shape (utilityProcess.fork(modulePath, args, options) sets
// process.argv the same way Node's own child_process.fork does):
// process.argv[0] is the runtime, argv[1] is this script's own path, and
// argv[2] is the pnpm entry to import; everything after that is pnpm's own
// CLI arguments and must reach pnpm exactly as its own bin/pnpm.mjs expects
// them — via process.argv.slice(2) inside the imported module. Rewrite
// process.argv in place before importing so the argv indices line up as if
// pnpm had been launched directly.
import { pathToFileURL } from "node:url";

// Local on purpose, not pluginShared's: this file is a standalone child
// entry that plain Node can execute directly from source, where an
// extension-less relative import does not resolve under type stripping.
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function run(): Promise<void> {
  const [pnpmEntry, ...pnpmArgs] = process.argv.slice(2);
  if (!pnpmEntry) {
    console.error("pluginPnpmRunnerProcess: missing the pnpm entry path argument.");
    process.exit(1);
  }
  process.argv = [process.argv[0] ?? "node", pnpmEntry, ...pnpmArgs];
  try {
    await import(pathToFileURL(pnpmEntry).href);
  } catch (error) {
    console.error(`pluginPnpmRunnerProcess: pnpm import failed: ${errorMessage(error)}`);
    process.exitCode = process.exitCode ?? 1;
  }
  process.exit(process.exitCode ?? 0);
}

void run();
