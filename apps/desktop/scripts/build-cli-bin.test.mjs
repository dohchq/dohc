// The dohc-mcp launcher contract: with no Node.js on PATH it fails naming
// the missing prerequisite (the packaged app's RunAsNode fuse is disabled,
// so it cannot lend its own runtime); with Node present it runs the bundle
// beside it. Run via `node --test` beside the desktop suite.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
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

// A stub `node` reporting a Node 20 version, so the launcher's version gate
// can be exercised without an actual Node 20 install. POSIX gets a plain
// shell script -- `command -v`/exec do not care that it isn't a real
// interpreter, and the version gate refuses before anything tries to run
// the bundle through it. Windows cannot use a .cmd/.bat stand-in here: the
// launcher invokes `node` bare (no `call`), and chaining into another batch
// file that way transfers control permanently instead of returning -- the
// rest of dohc-mcp.cmd would never run. A byte-patched copy of the real
// node.exe (with its embedded version string swapped for a same-length
// Node 20 one) is a genuine PE binary, so `node --version` behaves exactly
// like Node 20 while everything else about invoking it stays real.
function oldNodeDir() {
  const dir = mkdtempSync(join(tmpdir(), "dohc-mcp-old-node-"));
  const version = process.version.replace(/^v\d+/, "v20");
  if (isWindows) {
    const binary = readFileSync(process.execPath);
    const currentVersion = Buffer.from(process.version);
    const oldVersion = Buffer.from(version);
    assert.equal(oldVersion.length, currentVersion.length);
    let offset = 0;
    let replacements = 0;
    while ((offset = binary.indexOf(currentVersion, offset)) !== -1) {
      oldVersion.copy(binary, offset);
      offset += oldVersion.length;
      replacements += 1;
    }
    assert.ok(replacements > 0, "the Node executable did not contain its version string");
    writeFileSync(join(dir, "node.exe"), binary, { mode: 0o755 });
  } else {
    writeFileSync(join(dir, "node"), `#!/bin/sh\necho "${version}"\n`, { mode: 0o755 });
  }
  return { dir, version };
}

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

test("the sh launcher refuses Node.js 20 and names the found version", { skip: !shPath }, () => {
  const dir = launcherDir();
  const oldNode = oldNodeDir();
  const result = spawnSync(shPath, [join(dir, "dohc-mcp").replaceAll("\\", "/")], {
    env: { ...process.env, PATH: oldNode.dir },
    encoding: "utf8",
  });
  assert.equal(result.status, 127);
  assert.match(result.stderr, /Node\.js 22 or newer/);
  assert.ok(result.stderr.includes(oldNode.version.slice(1)));
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

test("the cmd launcher refuses Node.js 20 and names the found version", { skip: !isWindows }, () => {
  const dir = launcherDir();
  const oldNode = oldNodeDir();
  const result = spawnSync(cmdPath, ["/d", "/c", join(dir, "dohc-mcp.cmd")], {
    env: { ...process.env, PATH: oldNode.dir, Path: oldNode.dir },
    encoding: "utf8",
  });
  assert.equal(result.status, 127);
  assert.match(result.stderr, /Node\.js 22 or newer/);
  assert.ok(result.stderr.includes(oldNode.version.slice(1)));
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
