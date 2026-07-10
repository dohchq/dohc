#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const requireFromHere = createRequire(import.meta.url);

// Launcher-local failure lines. The library's error formatting lives in
// src/errors.ts (cliErrorLine); the launcher runs under plain node before the
// tsx loader exists, so it cannot import that module — it writes its two
// fixed launcher-specific messages directly instead of duplicating the
// formatter.
function launcherFailure(step, error) {
  const detail = error instanceof Error && error.message.trim()
    ? ` (${error.message.replace(/[\r\n]+/g, " ").trim()})`
    : "";
  return `dohc: ${step}${detail}\n`;
}

// Failure paths set process.exitCode instead of calling process.exit(): a
// hard exit can truncate stderr when it is piped or redirected, and with no
// child spawned there are no open handles, so the process ends on its own
// with the failure code once the diagnostic has flushed.
let tsxLoader;
try {
  tsxLoader = requireFromHere.resolve("tsx");
} catch (error) {
  process.stderr.write(launcherFailure("failed to locate the tsx loader", error));
  process.exitCode = 1;
}

if (tsxLoader) {
  const cli = resolve(here, "../src/index.ts");
  const child = spawn(
    process.execPath,
    ["--import", pathToFileURL(tsxLoader).href, cli, ...process.argv.slice(2)],
    { stdio: "inherit" },
  );

  child.once("error", (error) => {
    process.stderr.write(launcherFailure("failed to start", error));
    process.exitCode = 1;
  });

  child.on("exit", (code, signal) => {
    if (signal) {
      process.kill(process.pid, signal);
      return;
    }
    // Propagating the child's code via process.exit here is safe: the
    // child's stdio was inherited, so there is no buffered launcher output
    // left to truncate.
    process.exit(code ?? 1);
  });
}
