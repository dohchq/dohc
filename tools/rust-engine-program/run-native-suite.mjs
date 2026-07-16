#!/usr/bin/env node
// LOCAL-RUNNER: TS-NATIVE-CI native evidence (shard R02).
//
// The local-first replacement for the retired per-platform GitHub CI matrix
// (DECISIONS.md Gate 0 item 2). GATE0/TS-NATIVE-CI now depends on THIS script:
// it runs the reference TypeScript workspace engine's typecheck + test suite
// NATIVELY on the host, asserts the host architecture (so a cross-built or
// emulated run cannot masquerade as native evidence), and prints a timestamped
// evidence line for docs/superpowers/plans/rust-engine/EXECUTION_LOG.md.
//
// Why this matters: the differential oracle is meaningless if the reference
// engine has never been exercised on the founder's own platform. The TS engine
// has historically only been CI-tested on ubuntu.
//
// Platform coverage under the local-first policy:
//   - Windows x64  : run this script directly in PowerShell / Git Bash.
//   - Linux   x64  : run this script from inside WSL (`wsl` then
//                    `node tools/rust-engine-program/run-native-suite.mjs`)
//                    against the same checkout — that is the Linux evidence.
//   - macOS x64/arm64 : NOT covered during construction. Producing macOS
//                    native evidence is a MANDATORY pre-release obligation
//                    before any Mac distribution (DECISIONS.md Gate 0 item 2);
//                    Gate 7's "every supported platform" claim shrinks to
//                    {Windows, Linux-WSL} until that evidence exists.
//
// Requirements: Node >= 22, zero npm dependencies, pnpm on PATH.
//
// Usage:
//   node tools/rust-engine-program/run-native-suite.mjs
//   node tools/rust-engine-program/run-native-suite.mjs --expect-arch=x64
//     (fail if the host arch is not the expected one — belt-and-suspenders for
//      pinning which native platform this evidence represents)

import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { arch, platform, release } from "node:os";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "../..");

const expectArgs = process.argv
  .slice(2)
  .filter((a) => a.startsWith("--expect-arch="))
  .map((a) => a.split("=")[1]);
const expectArch = expectArgs[0];

const hostArch = arch();
const hostPlatform = platform();

console.log(`\n== TS-NATIVE-CI local native suite ==`);
console.log(`host: ${hostPlatform} ${hostArch} (${release()})`);
console.log(`repo: ${repoRoot}\n`);

if (expectArch && expectArch !== hostArch) {
  console.error(
    `ABORT: --expect-arch=${expectArch} but host arch is ${hostArch}. ` +
      `Cross-built/emulated runs must not be recorded as native evidence.`,
  );
  process.exit(2);
}

function run(cmd) {
  const res = spawnSync(cmd, {
    cwd: repoRoot,
    shell: true,
    stdio: "inherit",
  });
  if (res.error) return { ok: false, error: res.error };
  return { ok: res.status === 0, code: res.status };
}

const steps = [
  {
    name: "typecheck",
    cmd: "pnpm --filter @dohc/workspace-engine typecheck",
  },
  {
    name: "test",
    cmd: "pnpm --filter @dohc/workspace-engine test",
  },
];

const results = [];
let failed = false;

for (const step of steps) {
  console.log(`\n--- ${step.name} ---`);
  const r = run(step.cmd);
  if (!r.ok) failed = true;
  results.push({ name: step.name, status: r.ok ? "PASS" : "FAIL" });
  if (r.error) console.error(`  (spawn error: ${r.error.message})`);
}

const stamp = new Date().toISOString();
const summary = results.map((r) => `${r.name}=${r.status}`).join(" ");
const verdict = failed ? "FAIL" : "PASS";

console.log(`\n== summary ==`);
for (const r of results) console.log(`  ${r.status.padEnd(4)} ${r.name}`);

console.log(`\nEVIDENCE (paste into EXECUTION_LOG.md):`);
console.log(
  `- ${stamp} | run-native-suite | ${hostPlatform}/${hostArch} | ${verdict} | ${summary}`,
);
if (hostPlatform === "win32") {
  console.log(
    `  note: run this same script under WSL for Linux x64 evidence; macOS remains a pre-release obligation.`,
  );
}

process.exit(failed ? 1 : 0);
