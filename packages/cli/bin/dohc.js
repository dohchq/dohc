#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const requireFromHere = createRequire(import.meta.url);

function cliErrorLine(error) {
  const message = error instanceof Error && error.message.trim()
    ? error.message.replace(/[\r\n]+/g, " ").trim()
    : "unexpected CLI failure";
  return `${message.startsWith("dohc:") ? message : `dohc: ${message}`}\n`;
}

let tsxLoader;
try {
  tsxLoader = requireFromHere.resolve("tsx");
} catch (error) {
  process.stderr.write(cliErrorLine(error));
  process.exit(1);
}
const cli = resolve(here, "../src/index.ts");
const child = spawn(
  process.execPath,
  ["--import", pathToFileURL(tsxLoader).href, cli, ...process.argv.slice(2)],
  { stdio: "inherit" },
);

child.once("error", (error) => {
  process.stderr.write(cliErrorLine(error));
  process.exit(1);
});

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 1);
});
