import assert from "node:assert/strict";
import { join, resolve } from "node:path";
import test from "node:test";
import {
  desktopDevEnvironment,
  electronViteSpawnOptions,
  foregroundExitCode,
  validateWorkspaceEngineBuild,
  workspaceEngineBuildArguments,
  workspaceEngineBuildEnvironment,
} from "./dev.mjs";

test("desktop dev launches Electron outside Node mode", () => {
  const source = {
    ELECTRON_RUN_AS_NODE: "1",
    electron_run_as_node: "1",
    KEEP_ME: "yes",
  };

  const environment = desktopDevEnvironment(source);

  assert.deepEqual(environment, { KEEP_ME: "yes" });
  assert.equal(source.ELECTRON_RUN_AS_NODE, "1");
});

test("desktop dev does not report an interrupted foreground process as a launch failure", () => {
  assert.equal(foregroundExitCode({ status: 0, signal: null }), 0);
  assert.equal(foregroundExitCode({ status: null, signal: "SIGINT" }), 0);
  assert.equal(foregroundExitCode({ status: null, signal: "SIGTERM" }), 0);
  assert.equal(foregroundExitCode({ status: 0xc000013a, signal: null }), 0);
  assert.equal(foregroundExitCode({ status: -1073741510, signal: null }), 0);
  assert.equal(foregroundExitCode({ status: null, signal: "SIGKILL" }), 1);
  assert.equal(foregroundExitCode({ status: null, signal: null }), 1);
  assert.equal(foregroundExitCode({ status: 1, signal: null }), 1);
});

test("desktop dev starts electron-vite from the desktop package", () => {
  const options = electronViteSpawnOptions({ KEEP_ME: "yes" });

  assert.equal(options.cwd, resolve(import.meta.dirname, ".."));
  assert.deepEqual(options.env, { KEEP_ME: "yes" });
  assert.equal(options.stdio, "inherit");
});

test("desktop dev builds the engine where Electron loads it", () => {
  const root = join("workspace", "dohc");

  assert.deepEqual(workspaceEngineBuildArguments(root), [
    "build",
    "--target-dir",
    join(root, "target"),
    "--message-format=json-render-diagnostics",
    "-p",
    "dohc-workspace-engine",
    "--bin",
    "dohc-workspace-engine",
  ]);
});

test("desktop dev ignores inherited Cargo target settings", () => {
  const source = {
    CARGO_BUILD_TARGET: "x86_64-unknown-linux-gnu",
    cargo_target_dir: "elsewhere",
    KEEP_ME: "yes",
  };

  assert.deepEqual(workspaceEngineBuildEnvironment(source), { KEEP_ME: "yes" });
  assert.equal(source.CARGO_BUILD_TARGET, "x86_64-unknown-linux-gnu");
});

test("desktop dev verifies Cargo built the executable Electron loads", () => {
  const root = resolve("workspace", "dohc");
  const expected = join(root, "target", "debug", "dohc-workspace-engine.exe");
  const output = JSON.stringify({
    reason: "compiler-artifact",
    target: { kind: ["bin"], name: "dohc-workspace-engine" },
    executable: expected,
  });

  assert.equal(validateWorkspaceEngineBuild(output, root, "win32").executable, expected);

  const redirected = join(
    root,
    "target",
    "x86_64-pc-windows-msvc",
    "debug",
    "dohc-workspace-engine.exe",
  );
  assert.throws(
    () =>
      validateWorkspaceEngineBuild(
        JSON.stringify({
          reason: "compiler-artifact",
          target: { kind: ["bin"], name: "dohc-workspace-engine" },
          executable: redirected,
        }),
        root,
        "win32",
      ),
    /Cargo target configuration.*Remove \[build\]\.target/,
  );
});
