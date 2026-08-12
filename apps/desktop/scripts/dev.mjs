#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

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

function buildWorkspaceEngine() {
  const result = spawnSync("cargo", workspaceEngineBuildArguments(repoRoot), {
    cwd: repoRoot,
    encoding: "utf8",
    env: workspaceEngineBuildEnvironment(process.env),
    maxBuffer: Infinity,
    stdio: ["inherit", "pipe", "inherit"],
  });
  if (result.error) fail("build the Rust workspace engine", result.error);

  const output = result.stdout ?? "";
  const exitCode = foregroundExitCode(result);
  if (result.status !== 0) {
    if (exitCode !== 0) {
      const outcome = result.signal
        ? `was terminated by ${result.signal}`
        : result.status === null
          ? "terminated without an exit code"
          : `exited with code ${result.status}`;
      console.error(
        `Desktop development could not build the Rust workspace engine. cargo ${outcome}.`,
      );
    }
    process.exit(exitCode);
  }

  try {
    validateWorkspaceEngineBuild(output, repoRoot);
  } catch (error) {
    fail("build the Rust workspace engine in the path Electron loads", error);
  }
}

function run() {
  runRequired(
    process.execPath,
    [join(import.meta.dirname, "ensure-electron-installed.mjs")],
    { stdio: "inherit" },
    "verify the Electron installation",
  );

  buildWorkspaceEngine();

  const devServer = spawnSync(
    process.execPath,
    [electronViteCliPath(), "dev", ...process.argv.slice(2)],
    electronViteSpawnOptions(process.env),
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
