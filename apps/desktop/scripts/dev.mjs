#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const repoRoot = resolve(import.meta.dirname, "../../..");
const cleanForegroundSignals = new Set(["SIGINT", "SIGTERM", "SIGBREAK"]);
const windowsControlC = 0xc000013a;

export function desktopDevEnvironment(source) {
  const environment = { ...source };
  for (const name of Object.keys(environment)) {
    if (name.toUpperCase() === "ELECTRON_RUN_AS_NODE") {
      delete environment[name];
    }
  }
  return environment;
}

export function foregroundExitCode(result) {
  if (result.status !== null) {
    return result.status === windowsControlC || result.status === windowsControlC - 2 ** 32
      ? 0
      : result.status;
  }

  return result.signal !== null && cleanForegroundSignals.has(result.signal) ? 0 : 1;
}

export function workspaceEngineBuildArguments(root) {
  return [
    "build",
    "--target-dir",
    join(root, "target"),
    "-p",
    "dohc-workspace-engine",
    "--bin",
    "dohc-workspace-engine",
  ];
}

function electronViteCliPath() {
  const packageJson = require.resolve("electron-vite/package.json");
  return join(dirname(packageJson), "bin", "electron-vite.js");
}

function fail(action, error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Desktop development could not ${action}: ${message}`);
  process.exit(1);
}

function runRequired(command, args, options, action) {
  const result = spawnSync(command, args, options);
  if (result.error) fail(action, result.error);
  if (result.status !== 0) {
    console.error(
      `Desktop development could not ${action}. ${command} exited with code ${result.status ?? 1}.`,
    );
    process.exit(result.status ?? 1);
  }
}

function run() {
  runRequired(
    process.execPath,
    [join(import.meta.dirname, "ensure-electron-installed.mjs")],
    { stdio: "inherit" },
    "verify the Electron installation",
  );

  runRequired(
    "cargo",
    workspaceEngineBuildArguments(repoRoot),
    { cwd: repoRoot, stdio: "inherit" },
    "build the Rust workspace engine",
  );

  const devServer = spawnSync(
    process.execPath,
    [electronViteCliPath(), "dev", ...process.argv.slice(2)],
    {
      cwd: resolve(import.meta.dirname, ".."),
      env: desktopDevEnvironment(process.env),
      stdio: "inherit",
    },
  );
  if (devServer.error) fail("start electron-vite", devServer.error);
  process.exit(foregroundExitCode(devServer));
}

const isMain =
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  run();
}
