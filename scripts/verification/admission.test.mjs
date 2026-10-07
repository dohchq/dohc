import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { admissionPreflight, installedDependenciesMatch, verificationAdmission } from "./admission.mjs";

const desktopFiles = ["src/renderer/tokens.test.ts", "src/renderer/workbench/ChatLane.test.tsx", "src/renderer/workbench/ProductDemo.test.tsx"];
const packages = [
  {name: "@dohc/site", manifest: {scripts: {test: "vitest run", typecheck: "tsc --noEmit"}}},
  {name: "@dohc/desktop", manifest: {scripts: {test: "pnpm test:unit && pnpm test:scripts", "test:unit": "vitest run", typecheck: "tsc --noEmit && tsc --noEmit -p tsconfig.trip-poll.json"}}},
];
const plan = () => ({gates: {js: true, rust: false}, javascript: {full: false, packages: packages.map(pkg => pkg.name),
  testFiles: {"@dohc/desktop": desktopFiles}, repository: "source", desktopScripts: false,
  needs: {engine: false, desktop: false, postgres: false}, proofs: {accounts: false, selfHostNative: false, desktop: false, statesPage: false}}});

test("warm site and exact desktop compatibility suites use bounded light admission", () => {
  assert.equal(verificationAdmission(plan(), packages, true).lightweight, true);
});

test("native, service, unknown, cold, custom, and broad plans retain full admission", () => {
  for (const change of [
    p => p.gates.rust = true,
    p => p.javascript.full = true,
    p => p.javascript.needs.engine = true,
    p => p.javascript.needs.postgres = true,
    p => p.javascript.proofs.accounts = true,
    p => p.javascript.proofs.smoke = true,
    p => p.javascript.proofs = {},
    p => delete p.javascript.needs.engine,
    p => p.javascript.repository = "full",
    p => p.javascript.desktopScripts = true,
    p => p.javascript.packages.push("@dohc/third"),
    p => p.javascript.packages = ["@dohc/unknown"],
    p => p.javascript.testFiles["@dohc/desktop"] = ["src/workspaces/twoDaemonSync.e2e.test.ts"],
    p => delete p.javascript.testFiles["@dohc/desktop"],
  ]) {
    const candidate = plan(); change(candidate);
    assert.equal(verificationAdmission(candidate, packages, true).lightweight, false, JSON.stringify(candidate));
  }
  assert.equal(verificationAdmission(plan(), packages, false).lightweight, false);
  for (const [name, script] of [["test", "vitest run && node spawn.mjs"], ["pretest", "node spawn.mjs"], ["typecheck", "node custom.mjs"], ["posttypecheck", "node spawn.mjs"]]) {
    const candidate = structuredClone(packages);
    candidate[0].manifest.scripts[name] = script;
    assert.equal(verificationAdmission(plan(), candidate, true).lightweight, false, name);
  }
});

test("cold or changed installation cannot use the light lane", t => {
  const root = mkdtempSync(join(tmpdir(), "dohc-admission-install-"));
  t.after(() => rmSync(root, {recursive: true, force: true}));
  const put = (path, data) => { mkdirSync(dirname(join(root, path)), {recursive: true}); writeFileSync(join(root, path), data); };
  assert.equal(installedDependenciesMatch(root), false);
  put("package.json", JSON.stringify({engines: {pnpm: "11.20.0"}}));
  put("pnpm-lock.yaml", "installed lock");
  put("node_modules/.pnpm/lock.yaml", "installed lock");
  put("node_modules/.modules.yaml", "packageManager: pnpm@11.20.0\n");
  put("apps/desktop/node_modules/pnpm/package.json", JSON.stringify({version: "11.20.0", main: "package.json"}));
  for (const name of ["typescript", "vitest", "js-yaml"]) put(`apps/desktop/node_modules/${name}/package.json`, "{}");
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
  assert.throws(() => admissionPreflight({nodeVersion: "24.13.0", command}), /Node 24.14/);
  assert.equal(calls.length, 0);
  admissionPreflight({rust: true, native: true, pins, platform: "win32", command});
  assert.deepEqual(calls.map(([tool]) => tool), ["pwsh.exe", "rustc", "cargo", "cargo", "cargo", "cargo"]);
  assert.throws(() => admissionPreflight({rust: true, pins, platform: "linux", command: () => "cargo-deny 0"}), /before queueing/);
  assert.throws(() => admissionPreflight({platform: "win32", command: () => "5.1"}), /PowerShell 7/);
});
