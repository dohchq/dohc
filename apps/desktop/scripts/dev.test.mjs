import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";
import {
  desktopDevEnvironment,
  foregroundExitCode,
  workspaceEngineBuildArguments,
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
  assert.equal(foregroundExitCode({ status: null }), 0);
  assert.equal(foregroundExitCode({ status: 1 }), 1);
});

test("desktop dev builds the engine where Electron loads it", () => {
  const root = join("workspace", "dohc");

  assert.deepEqual(workspaceEngineBuildArguments(root), [
    "build",
    "--target-dir",
    join(root, "target"),
    "-p",
    "dohc-workspace-engine",
    "--bin",
    "dohc-workspace-engine",
  ]);
});
