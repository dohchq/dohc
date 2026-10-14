import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { admissionPreflight, installedDependenciesMatch } from "./admission.mjs";

test("cold or changed installation cannot typecheck before queueing", t => {
  const root = mkdtempSync(join(tmpdir(), "dohc-admission-install-"));
  t.after(() => rmSync(root, {recursive: true, force: true}));
  const put = (path, data) => { mkdirSync(dirname(join(root, path)), {recursive: true}); writeFileSync(join(root, path), data); };
  assert.equal(installedDependenciesMatch(root), false);
  put("package.json", JSON.stringify({engines: {pnpm: "11.20.0"}}));
  put("pnpm-lock.yaml", "installed lock");
  put("node_modules/.pnpm/lock.yaml", "installed lock");
  put("node_modules/.modules.yaml", "packageManager: pnpm@11.20.0\n");
  put("apps/desktop/node_modules/pnpm/package.json", JSON.stringify({version: "11.20.0", main: "package.json"}));
  put("apps/desktop/node_modules/typescript/package.json", "{}");
  assert.equal(installedDependenciesMatch(root), true);
  put("pnpm-lock.yaml", "new lock");
  assert.equal(installedDependenciesMatch(root), false);
  put("pnpm-lock.yaml", "installed lock");
  put("node_modules/.modules.yaml", "packageManager: pnpm@11.19.0\n");
  assert.equal(installedDependenciesMatch(root), false);
});

test("cheap preflight rejects tool and host failures before queueing without toolchain installation", () => {
  const calls = [];
  const pins = {CARGO_DENY_VERSION: "1", CARGO_AUDIT_VERSION: "2", CARGO_NEXTEST_VERSION: "3"};
  const command = (tool, args, options) => {
    calls.push([tool, args]);
    assert.equal(options.env.RUSTUP_AUTO_INSTALL, "0");
    assert.equal(options.timeout, 10_000);
    if (tool === "pwsh.exe") return "7.5.0";
    return `cargo-${args[0]} ${pins[`CARGO_${args[0].toUpperCase()}_VERSION`] ?? "fixture"}`;
  };
  for (const nodeVersion of ["24.14.0", "24.15.0"]) {
    assert.throws(() => admissionPreflight({nodeVersion, command}), /Node 24.16/);
  }
  assert.equal(calls.length, 0);
  admissionPreflight({nodeVersion: "24.16.0", platform: "linux", command});
  assert.equal(calls.length, 0);
  admissionPreflight({rust: true, native: true, pins, platform: "win32", command});
  assert.deepEqual(calls.map(([tool]) => tool), ["pwsh.exe", "rustc", "cargo", "cargo", "cargo", "cargo"]);
  assert.throws(() => admissionPreflight({rust: true, pins, platform: "linux", command: () => "cargo-deny 0"}), /before queueing/);
  assert.throws(() => admissionPreflight({platform: "win32", command: () => "5.1"}), /PowerShell 7/);
});
