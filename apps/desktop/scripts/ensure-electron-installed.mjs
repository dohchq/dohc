#!/usr/bin/env node
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import process from "node:process";

const require = createRequire(import.meta.url);

function fail(message, error) {
  console.error(message);
  if (error instanceof Error && error.message) {
    console.error(`\n${error.message}`);
  }
  console.error(
    [
      "",
      "Try one of these repair commands, then rerun pnpm dev:desktop:",
      "  pnpm --filter @dohc/desktop rebuild electron",
      "  pnpm --filter @dohc/desktop exec install-electron --no",
      "  pnpm install",
    ].join("\n"),
  );
  process.exit(1);
}

const override = process.env.ELECTRON_EXEC_PATH?.trim();
if (override) {
  if (!existsSync(override)) {
    fail(`ELECTRON_EXEC_PATH points at a missing executable: ${override}`);
  }
  process.exit(0);
}

let electronPath;
try {
  // The electron package entrypoint repairs missing dist/path.txt by invoking
  // its own installer. electron-vite reads path.txt directly, so do this first.
  electronPath = require("electron");
} catch (error) {
  fail("Electron is installed in node_modules, but its platform binary is missing.", error);
}

if (typeof electronPath !== "string" || electronPath.length === 0) {
  fail("Electron resolved to an invalid executable path.");
}

if (!existsSync(electronPath)) {
  fail(`Electron resolved to a missing executable: ${electronPath}`);
}
