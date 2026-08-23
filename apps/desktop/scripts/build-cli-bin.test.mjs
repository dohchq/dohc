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
  posixMcpLauncher,
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

test("the POSIX launcher template names the requested module without changing the packaged default", () => {
  assert.equal(POSIX_MCP_LAUNCHER, posixMcpLauncher("dohc-mcp.mjs"));
  assert.ok(
    posixMcpLauncher("dohc-mcp-0123456789abcdef.mjs").endsWith(
      'exec node "${0%/*}/dohc-mcp-0123456789abcdef.mjs" "$@"\n',
    ),
  );
});

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

// A stub `node` reporting a fabricated version, so the launcher's version
// gate can be exercised without actually installing that Node release.
// POSIX gets a shell script that delegates every call except `--version`
// to this host's real Node interpreter, so accepted versions still run the
// bundle end to end. Windows cannot use a
// .cmd/.bat stand-in here: the launcher invokes `node` bare (no `call`),
// and chaining into another batch file that way transfers control
// permanently instead of returning -- the rest of dohc-mcp.cmd would never
// run. A byte-patched copy of the real node.exe (with its embedded version
// string swapped for a same-length fabricated one) is a genuine PE binary,
// so `node --version` reports the fabricated version while everything else
// about invoking it -- including actually running the bundle, for the
// "accepted" case -- stays real.
//
// `majorMinor` (e.g. "22.12") must have the same digit width per segment as
// this process's own major/minor for the same-length swap to hold; the
// length assertion in fabricatedNodeDir is the actual guard either way.
function fabricatedVersion(majorMinor) {
  return process.version.replace(/^v\d+\.\d+/, `v${majorMinor}`);
}

// No length-independent patch was found that keeps the genuine-interpreter
// property (padding the fabricated string with anything, or growing/
// shrinking it, changes the compiled binary's byte layout in ways this
// simple find-and-copy cannot account for -- unlike a plain text file,
// there is no safe general place to absorb a length change without
// knowing the PE's internal structure). A host whose major/minor digit
// widths differ from what a given test fabricates (e.g. this process
// somehow reporting a single-digit major) cannot use the byte-patch here;
// skip that one test with a clear, visible reason rather than either
// failing the whole suite on an environment this approach cannot cover, or
// silently doing nothing.
function windowsFabricatedVersionSkipReason(majorMinor) {
  if (!isWindows) return undefined;
  const fabricated = fabricatedVersion(majorMinor);
  if (fabricated.length === process.version.length) return undefined;
  return (
    `this host's Node version (${process.version}) has a different byte ` +
    `length than the fabricated ${fabricated} -- the Windows launcher ` +
    "test's byte-patch needs an exact-length match to stay a genuine PE binary"
  );
}

function skipUnlessWindowsFabricated(majorMinor) {
  if (!isWindows) return true;
  return windowsFabricatedVersionSkipReason(majorMinor) ?? false;
}

// fabricatedNodeDir branches on the TEST HOST's own platform, not which
// launcher (sh or cmd) is under test -- on a Windows host, even the
// sh-launcher tests (run through git-bash's sh.exe) get the byte-patched
// node.exe, because that is the only `node` a Windows PATH lookup finds.
// So an sh-launcher test fabricating a version needs the exact same
// length-mismatch skip a cmd-launcher one does; only a genuinely POSIX
// test host is exempt (its plain shell-script stub has no length
// constraint at all).
function skipUnlessShFabricated(majorMinor) {
  if (!shPath) return true;
  return windowsFabricatedVersionSkipReason(majorMinor) ?? false;
}

function fabricatedNodeDir(version) {
  const dir = mkdtempSync(join(tmpdir(), "dohc-mcp-fabricated-node-"));
  if (isWindows) {
    const binary = readFileSync(process.execPath);
    const realVersion = Buffer.from(process.version);
    const targetVersion = Buffer.from(version);
    assert.equal(targetVersion.length, realVersion.length);
    let offset = 0;
    let replacements = 0;
    while ((offset = binary.indexOf(realVersion, offset)) !== -1) {
      targetVersion.copy(binary, offset);
      offset += targetVersion.length;
      replacements += 1;
    }
    assert.ok(replacements > 0, "the Node executable did not contain its version string");
    writeFileSync(join(dir, "node.exe"), binary, { mode: 0o755 });
  } else {
    writeFileSync(
      join(dir, "node"),
      `#!/bin/sh\nif [ "$1" = "--version" ]; then\n  echo "${version}"\nelse\n  exec "$DOHC_LAUNCHER_REAL_NODE" "$@"\nfi\n`,
      { mode: 0o755 },
    );
  }
  return { dir, version };
}

function runSh(majorMinor) {
  const dir = launcherDir();
  const fabricated = fabricatedNodeDir(fabricatedVersion(majorMinor));
  const result = spawnSync(
    shPath,
    [join(dir, "dohc-mcp").replaceAll("\\", "/"), "--workspace", "w"],
    {
      env: {
        ...process.env,
        DOHC_LAUNCHER_REAL_NODE: process.execPath,
        PATH: fabricated.dir,
      },
      encoding: "utf8",
    },
  );
  return { fabricated, result };
}

function runCmd(majorMinor) {
  const dir = launcherDir();
  const fabricated = fabricatedNodeDir(fabricatedVersion(majorMinor));
  const path = fabricated.dir + delimiter + dir;
  const result = spawnSync(
    cmdPath,
    ["/d", "/c", join(dir, "dohc-mcp.cmd"), "--workspace", "w"],
    {
      env: { ...process.env, PATH: path, Path: path },
      encoding: "utf8",
    },
  );
  return { fabricated, result };
}

const rejectedVersions = [
  { version: "22.12", floor: "22.13" },
  { version: "23.3", floor: "23.4" },
];

const acceptedVersions = ["22.13", "23.4"];

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

// node:sqlite needed --experimental-sqlite until it stabilized at 22.13
// and 23.4. The floor is per-major, not one flattened threshold.
for (const { version, floor } of rejectedVersions) {
  test(
    `the sh launcher refuses Node.js ${version} and names the found version`,
    { skip: skipUnlessShFabricated(version) },
    () => {
      const { fabricated, result } = runSh(version);
      assert.equal(result.status, 127);
      assert.match(result.stderr, new RegExp(`Node\\.js ${floor.replace(".", "\\.")} or newer`));
      assert.ok(result.stderr.includes(fabricated.version.slice(1)));
    },
  );
}

for (const version of acceptedVersions) {
  test(
    `the sh launcher runs the bundle beside it on Node.js ${version} exactly`,
    { skip: skipUnlessShFabricated(version) },
    () => {
      const { result } = runSh(version);
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /SERVER-RAN --workspace w/);
    },
  );
}

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

for (const { version, floor } of rejectedVersions) {
  test(
    `the cmd launcher refuses Node.js ${version} and names the found version`,
    { skip: skipUnlessWindowsFabricated(version) },
    () => {
      const { fabricated, result } = runCmd(version);
      assert.equal(result.status, 127);
      assert.match(result.stderr, new RegExp(`Node\\.js ${floor.replace(".", "\\.")} or newer`));
      assert.ok(result.stderr.includes(fabricated.version.slice(1)));
    },
  );
}

// A major of 24+ is never floor-checked. The byte-patched node.exe remains
// a genuine interpreter, so every accepted case runs the bundle as well as
// passing the version gate.
for (const version of [...acceptedVersions, "24.0"]) {
  test(
    `the cmd launcher runs the bundle beside it on Node.js ${version} exactly`,
    { skip: skipUnlessWindowsFabricated(version) },
    () => {
      const { result } = runCmd(version);
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /SERVER-RAN --workspace w/);
    },
  );
}

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
