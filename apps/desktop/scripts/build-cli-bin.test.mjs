import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { after, test } from "node:test";
import * as launchers from "./build-cli-bin.mjs";
import { agentResourceFailures } from "./package-smoke.mjs";
import { agentRuntimeTarget, NODE_MISSING_MESSAGE } from "./mcp-launchers.mjs";

// Node reports its own path with links resolved, and a Mac's temp folder is under the /var link.
const scratch = realpathSync(mkdtempSync(join(tmpdir(), "dohc-launchers-")));
after(() => rmSync(scratch, { recursive: true, force: true }));
const windows = process.platform === "win32";
const shCandidates = windows
  ? [...(spawnSync("where", ["sh"], { encoding: "utf8" }).stdout ?? "").split(/\r?\n/), "C:/Program Files/Git/bin/sh.exe"]
  : ["/bin/sh"];
const sh = shCandidates.map(path => path.trim()).find(path => path && existsSync(path));
const hasSh = Boolean(sh);
const cmd = process.env.ComSpec;
const args = ["", "two words", "Icé 雪", "--workspace", "Ice Test"];
const stdin = Buffer.from([0, 10, 13, 255, 65]);
const probe = `import fs from 'node:fs';
console.log(JSON.stringify({execPath:process.execPath,args:process.argv.slice(2),stdin:[...fs.readFileSync(0)]}));
console.error('probe-stderr'); process.exit(37);`;
let serial = 0;
let exercisedLaunchers = 0;
// Homebrew's Node loads libnode through @rpath, which starts at the binary's own
// folder, so each copy gets a link to it there. Official Node has no such library.
const nodeLib = join(dirname(realpathSync(process.execPath)), "..", "lib");
const nodeLibraries = existsSync(nodeLib) ? readdirSync(nodeLib).filter(name => /^libnode\..*\.dylib$/.test(name)) : [];
function copyNode(to) {
  copyFileSync(process.execPath, to);
  for (const name of nodeLibraries) symlinkSync(join(nodeLib, name), join(dirname(to), name));
}
function fixture(platform = "win32", arch = "x64", label = "Ice Test") {
  const root = join(scratch, String(serial++), label);
  const cli = join(root, "resources", "cli-bin");
  const compiler = join(root, "resources", "app-compiler");
  const cwd = join(root, "workspace", label);
  const competing = join(root, "competing");
  for (const dir of [cli, compiler, cwd, competing]) mkdirSync(dir, { recursive: true });
  const node = join(compiler, platform === "win32" ? "node.exe" : "node");
  copyNode(node);
  copyNode(join(competing, windows ? "node.exe" : "node"));
  for (const name of ["node.exe", "node.cmd"]) writeFileSync(join(cwd, name), "@echo WORKSPACE-NODE-RAN\r\nexit /b 98\r\n");
  const files = launchers.cliLaunchers({ platform, arch });
  for (const name of ["dohc", "dohc-mcp"]) {
    writeFileSync(join(cli, `${name}.mjs`), probe);
    writeFileSync(join(cli, name), files[name], { mode: 0o755 });
    writeFileSync(join(cli, `${name}.cmd`), files[`${name}.cmd`]);
  }
  return { cli, cwd, node, competing };
}
for (const name of ["dohc", "dohc-mcp"]) {
  test(`macOS arm64 ${name} selects the adjacent runtime`, { skip: !hasSh }, () => {
    const f = fixture("darwin", "arm64");
    const result = run(f, name, "sh", f.competing);
    assert.equal(result.status, 37, result.stderr);
    assert.equal(resolve(JSON.parse(result.stdout).execPath), resolve(f.node));
  });
}
test("unsupported launcher targets are refused before building", () => {
  assert.throws(() => launchers.cliLaunchers({ platform: "darwin", arch: "x64" }), /Unsupported/);
  assert.throws(() => launchers.cliLaunchers({ platform: "win32", arch: "arm64" }), /Unsupported/);
});
function run(f, name, shell, path, cwd = f.cwd) {
  const launcher = join(f.cli, name).replaceAll("\\", "/");
  const result = spawnSync(shell === "cmd" ? cmd : sh,
    shell === "cmd" ? ["/d", "/s", "/c", `""${launcher}" "" "two words" "Icé 雪" --workspace "Ice Test""`] : [launcher, ...args], {
      cwd, env: { ...process.env, PATH: path, Path: path, NODE_OPTIONS: "" },
      input: stdin, encoding: "utf8", windowsVerbatimArguments: shell === "cmd", timeout: 15000,
    });
  if (!result.error) exercisedLaunchers += 1;
  return result;
}
for (const label of ["Ice Test", "Icé"]) {
  for (const shell of ["cmd", "sh"]) {
    for (const name of ["dohc", "dohc-mcp"]) {
      test(`${shell} ${name} in ${label} uses bundled Node, preserves argv/stdin/streams/status`, {
        skip: shell === "cmd" ? !windows : !hasSh,
      }, (t) => {
        const f = fixture(windows ? "win32" : "darwin", windows ? "x64" : "arm64", label);
        for (const cwd of [f.cwd, f.cli]) {
          for (const path of [f.cli, f.competing]) {
            const result = run(f, name + (shell === "cmd" ? ".cmd" : ""), shell, path, cwd);
            assert.equal(result.status, 37, result.stderr || String(result.error));
            const recorded = JSON.parse(result.stdout);
            assert.equal(resolve(recorded.execPath), resolve(f.node));
            assert.deepEqual(recorded.args, args);
            assert.deepEqual(recorded.stdin, [...stdin]);
            assert.equal(result.stderr.trim(), "probe-stderr");
            t.diagnostic(`cwd=${cwd}; PATH=${path}; process.execPath=${recorded.execPath}`);
          }
        }
        rmSync(f.node);
        const missing = run(f, name + (shell === "cmd" ? ".cmd" : ""), shell, f.competing);
        assert.equal(missing.status, 127);
        assert.equal(missing.stdout, "");
        assert.match(missing.stderr, /dohc is missing a file it needs to run agents\. Reinstall dohc, then try again\./);
      });
    }
  }
}
for (const arch of ["arm64", "x64"]) {
  for (const name of ["dohc", "dohc-mcp"]) {
    test(`Linux ${arch} ${name} retains the PATH prerequisite`, { skip: !hasSh }, () => {
      const f = fixture("linux", arch);
      const result = run(f, name, "sh", f.cli);
      assert.equal(result.status, 127);
      assert.match(result.stderr, /Node\.js/);
    });
  }
}
for (const version of ["22.12.0", "23.3.0", "22.13.0", "23.4.0", "24.0.0", "garbage", "", "v24.nope.0"]) {
  test(`Linux arm64 version floor: ${version}`, { skip: !hasSh }, () => {
    const f = fixture("linux", "arm64");
    const bin = join(f.cli, "version-probe");
    mkdirSync(bin);
    writeFileSync(join(bin, "node"), `#!/bin/sh\nif [ "$1" = --version ]; then echo '${version}'; else exec '${process.execPath.replaceAll("\\", "/")}' "$@"; fi\n`, { mode: 0o755 });
    const result = run(f, "dohc", "sh", bin);
    const accepted = ["22.13.0", "23.4.0", "24.0.0"].includes(version);
    assert.equal(result.status, accepted ? 37 : 127, result.stderr);
    if (accepted) {
      const recorded = JSON.parse(result.stdout);
      assert.equal(recorded.execPath, process.execPath);
      assert.deepEqual(recorded.args, args);
      assert.deepEqual(recorded.stdin, [...stdin]);
      assert.equal(result.stderr.trim(), "probe-stderr");
    } else {
      assert.equal(result.stdout, "");
      assert.ok(result.stderr.includes(["garbage", "", "v24.nope.0"].includes(version) ? NODE_MISSING_MESSAGE : "dohc commands need Node.js"));
    }
  });
}

test("at least one platform launcher was actually exercised here", () => {
  assert.ok(exercisedLaunchers > 0, "neither sh nor cmd exercised a launcher");
});

test("runtime targets agree across launchers and resource checks", () => {
  for (const [platform, arch, expected] of [["win32", "x64", "bundled"], ["darwin", "arm64", "bundled"], ["linux", "x64", "path"], ["linux", "arm64", "path"]]) {
    assert.equal(agentRuntimeTarget(platform, arch), expected);
    assert.doesNotThrow(() => launchers.cliLaunchers({ platform, arch }));
    assert.doesNotThrow(() => agentResourceFailures(scratch, { platform, arch }));
  }
  for (const [platform, arch] of [["win32", "arm64"], ["darwin", "x64"], ["linux", "ia32"], ["freebsd", "x64"]]) {
    for (const select of [() => agentRuntimeTarget(platform, arch), () => launchers.cliLaunchers({ platform, arch }), () => agentResourceFailures(scratch, { platform, arch })]) {
      assert.throws(select, /Unsupported agent runtime target/);
    }
  }
});
test("the build emits two modules and four target-specific wrappers", async () => {
  assert.equal(typeof launchers.buildCliBin, "function");
  const outputDir = join(scratch, "built");
  await launchers.buildCliBin({ outputDir, platform: "win32", arch: "x64" });
  for (const name of ["dohc.mjs", "dohc-mcp.mjs", "dohc", "dohc.cmd", "dohc-mcp", "dohc-mcp.cmd"]) {
    assert.ok(readFileSync(join(outputDir, name)).length > 0, name);
  }
  assert.ok(!readFileSync(join(outputDir, "dohc.mjs"), "utf8").startsWith("#!"));
  for (const name of ["dohc.cmd", "dohc-mcp.cmd"]) {
    const source = readFileSync(join(outputDir, name), "utf8");
    assert.ok(/^[\x00-\x7f]*$/.test(source));
    assert.ok(!/(?<!\r)\n/.test(source));
  }
});

test("resource closure rejects an omitted chat module or bundled runtime", () => {
  const root = join(scratch, "resource-closure");
  mkdirSync(join(root, "cli-bin"), { recursive: true });
  mkdirSync(join(root, "app-compiler"));
  for (const file of ["dohc", "dohc.cmd", "dohc-mcp", "dohc-mcp.cmd", "dohc-mcp.mjs"]) writeFileSync(join(root, "cli-bin", file), "fixture", { mode: 0o755 });
  let failures = agentResourceFailures(root, { platform: "win32", arch: "x64" });
  assert.ok(failures.some((failure) => failure.includes("dohc.mjs")));
  assert.ok(failures.some((failure) => failure.includes("node.exe")));
  writeFileSync(join(root, "cli-bin", "dohc.mjs"), "fixture");
  writeFileSync(join(root, "app-compiler", "node.exe"), "runtime");
  assert.deepEqual(agentResourceFailures(root, { platform: "win32", arch: "x64" }), []);
  assert.deepEqual(agentResourceFailures(root, { platform: "linux", arch: "arm64" }), []);
  assert.deepEqual(agentResourceFailures(root, { platform: "linux", arch: "x64" }), []);
  assert.ok(agentResourceFailures(root, { platform: "darwin", arch: "arm64" }).some((failure) => failure.includes("app-compiler/node")));
});
