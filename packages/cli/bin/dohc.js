#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const requireFromHere = createRequire(import.meta.url);
const tsxLoader = requireFromHere.resolve("tsx");
const cli = resolve(here, "../src/index.ts");
const child = spawn(
  process.execPath,
  ["--import", pathToFileURL(tsxLoader).href, cli, ...process.argv.slice(2)],
  { stdio: "inherit" },
);

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 1);
});
