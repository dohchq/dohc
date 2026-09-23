#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { withBuildBudget } from "../../../scripts/verification/build.mjs";
import { run as runProcess } from "../../../scripts/verification/process.mjs";
import { cancellationScope } from "../../../scripts/verification/cancellation.mjs";

const require = createRequire(import.meta.url);
const repoRoot = resolve(import.meta.dirname, "../../..");
const cleanForegroundSignals = new Set(["SIGINT", "SIGTERM"]);
const windowsControlC = 0xc000013a;

export function desktopDevEnvironment(source) {
  const environment = { ...source };
  for (const name of Object.keys(environment)) {
    if (name.toUpperCase() === "ELECTRON_RUN_AS_NODE") {
      delete environment[name];
    }
  }
  // The dev session is a bench: turn on the in-app dev panel unless the
  // caller chose otherwise. Main gates it again on an unpackaged build.
  environment.DOHC_DEV_TOOLS ??= "1";
  return environment;
}

export function workspaceEngineBuildEnvironment(source) {
  const environment = { ...source };
  for (const name of Object.keys(environment)) {
    const upperName = name.toUpperCase();
    if (upperName === "CARGO_BUILD_TARGET" || upperName === "CARGO_TARGET_DIR") {
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
    "--message-format=json-render-diagnostics",
    "-p",
    "dohc-workspace-engine",
    "--bin",
    "dohc-workspace-engine",
  ];
}

function engineBinaryName(platform) {
  return `dohc-workspace-engine${platform === "win32" ? ".exe" : ""}`;
}

export function validateWorkspaceEngineBuild(
  output,
  root,
  platform = process.platform,
) {
  const executable = workspaceEngineExecutable(output);
  // Keep this in sync with defaultEngineBinaryPath's unpackaged branch.
  const expected = resolve(root, "target", "debug", engineBinaryName(platform));
  if (!executable) {
    throw new Error(
      `cargo succeeded but did not report the Rust workspace engine executable. Expected ${expected}.`,
    );
  }

  const observed = resolve(executable);
  const comparableObserved = platform === "win32" ? observed.toLowerCase() : observed;
  const comparableExpected = platform === "win32" ? expected.toLowerCase() : expected;
  if (comparableObserved !== comparableExpected) {
    throw new Error(
      `Cargo target configuration built the Rust workspace engine at ${observed}, but Electron loads ${expected}. Remove [build].target from Cargo configuration; the desktop launcher builds for the host target and loads target/debug.`,
    );
  }

  return observed;
}

function workspaceEngineExecutable(output) {
  let executable;
  for (const line of output.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      continue;
    }
    if (
      message.reason === "compiler-artifact" &&
      message.target?.name === "dohc-workspace-engine" &&
      message.target.kind?.includes("bin") &&
      typeof message.executable === "string"
    ) {
      executable = message.executable;
    }
  }
  return executable;
}

export function electronViteSpawnOptions(source) {
  return {
    cwd: resolve(import.meta.dirname, ".."),
    env: desktopDevEnvironment(source),
    stdio: "inherit",
  };
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

async function buildWorkspaceEngine(environment, runCargo) {
  const result = await runCargo("cargo", workspaceEngineBuildArguments(repoRoot), {
    cwd: repoRoot,
    env: workspaceEngineBuildEnvironment(environment),
    quietStdout: true,
  });
  validateWorkspaceEngineBuild(result.stdout, repoRoot);
}

export async function buildThenStartDesktop({
  runCargo = runProcess,
  startDev = () => spawnSync(
    process.execPath,
    [electronViteCliPath(), "dev", ...process.argv.slice(2)],
    electronViteSpawnOptions(process.env),
  ),
} = {}) {
  const cancellation = cancellationScope("Desktop build");
  let interrupted;
  try { await withBuildBudget((environment) => buildWorkspaceEngine(environment, runCargo)); }
  finally { interrupted = await cancellation.dispose(); }
  if (interrupted) throw interrupted;
  return startDev();
}

async function run() {
  runRequired(
    process.execPath,
    [join(import.meta.dirname, "ensure-electron-installed.mjs")],
    { stdio: "inherit" },
    "verify the Electron installation",
  );

  // Plugin installs need the staged pnpm/esbuild under resources/plugin-tools
  // just as much in a dev session as in a packaged build — this was
  // previously wired only into the package script, so every real plugin
  // install failed on a fresh checkout run any other way.
  runRequired(
    process.execPath,
    [join(import.meta.dirname, "stage-plugin-tools.mjs")],
    { stdio: "inherit" },
    "stage the plugin install/build tools",
  );
  runRequired(process.execPath, [join(import.meta.dirname, "stage-app-compiler.mjs")],
    { stdio: "inherit" }, "stage the app compiler");
  runRequired(process.execPath, [join(import.meta.dirname, "stage-app-backend-runtime.mjs")],
    { stdio: "inherit" }, "stage the app backend runtime");

  const devServer = await buildThenStartDesktop();
  if (devServer.error) fail("start electron-vite", devServer.error);
  process.exit(foregroundExitCode(devServer));
}

const isMain =
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  run().catch((error) => fail("start the development session", error));
}
