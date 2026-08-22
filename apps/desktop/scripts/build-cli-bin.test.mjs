// The dohc-mcp launcher contract: with no Node.js on PATH it fails naming
// the missing prerequisite (the packaged app's RunAsNode fuse is disabled,
// so it cannot lend its own runtime); with Node present it runs the bundle
// beside it. Run via `node --test` beside the desktop suite.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { test } from "node:test";
import {
  NODE_MISSING_MESSAGE,
  POSIX_MCP_LAUNCHER,
  WINDOWS_MCP_LAUNCHER,
} from "./build-cli-bin.mjs";

function launcherDir() {
  const dir = mkdtempSync(join(tmpdir(), "dohc-mcp-launcher-"));
  writeFileSync(join(dir, "dohc-mcp"), POSIX_MCP_LAUNCHER, { mode: 0o755 });
  writeFileSync(join(dir, "dohc-mcp.cmd"), WINDOWS_MCP_LAUNCHER, { mode: 0o755 });
  // Stands in for the vite bundle the real build writes beside the
  // launchers; the contract under test is the launchers', not the bundle's.
  writeFileSync(
    join(dir, "dohc-mcp.mjs"),
    'console.log("SERVER-RAN " + process.argv.slice(2).join(" "));\n',
  );
  return dir;
}

const nodeDir = dirname(process.execPath);
const isWindows = process.platform === "win32";
// Absolute interpreter paths, resolved BEFORE any test strips PATH: the
// stripped PATH must only decide what the launcher script itself can find,
// never whether the test can start its shell at all.
const shPath = (() => {
  const probe = isWindows
    ? spawnSync("where", ["sh"], { encoding: "utf8" })
    : spawnSync("which", ["sh"], { encoding: "utf8" });
  if (probe.status !== 0) return null;
  const first = probe.stdout.split(/\r?\n/).find((line) => line.trim() !== "");
  return first ? first.trim() : null;
})();
const cmdPath = process.env.ComSpec ?? "cmd.exe";

test("the sh launcher names the Node.js prerequisite when PATH has no node", { skip: !shPath }, () => {
  const dir = launcherDir();
  const result = spawnSync(shPath, [join(dir, "dohc-mcp").replaceAll("\\", "/"), "--workspace", "w"], {
    env: { ...process.env, PATH: dir },
    encoding: "utf8",
  });
  assert.equal(result.status, 127);
  assert.match(result.stderr, /Node\.js/);
  assert.ok(result.stderr.includes(NODE_MISSING_MESSAGE));
});

test("the sh launcher runs the bundle beside it when node is on PATH", { skip: !shPath }, () => {
  const dir = launcherDir();
  const result = spawnSync(shPath, [join(dir, "dohc-mcp").replaceAll("\\", "/"), "--workspace", "w"], {
    env: { ...process.env, PATH: nodeDir + delimiter + dir },
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /SERVER-RAN --workspace w/);
});

test("the cmd launcher names the Node.js prerequisite when PATH has no node", { skip: !isWindows }, () => {
  const dir = launcherDir();
  const result = spawnSync(cmdPath, ["/d", "/c", join(dir, "dohc-mcp.cmd"), "--workspace", "w"], {
    env: { ...process.env, PATH: dir, Path: dir },
    encoding: "utf8",
  });
  assert.equal(result.status, 127);
  assert.match(result.stderr, /Node\.js/);
});

test("the cmd launcher runs the bundle beside it when node is on PATH", { skip: !isWindows }, () => {
  const dir = launcherDir();
  const path = nodeDir + delimiter + dir;
  const result = spawnSync(cmdPath, ["/d", "/c", join(dir, "dohc-mcp.cmd"), "--workspace", "w"], {
    env: { ...process.env, PATH: path, Path: path },
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /SERVER-RAN --workspace w/);
});

test("at least one platform launcher was actually exercised here", () => {
  assert.ok(Boolean(shPath) || isWindows, "neither sh nor cmd is available to test the launchers");
});
