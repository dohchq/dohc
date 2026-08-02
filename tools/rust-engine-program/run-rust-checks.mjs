#!/usr/bin/env node
// LOCAL-RUNNER: Rust engine checks (shard R02).
//
// Replaces GitHub CI for the Rust workspace per the Gate 0 decision
// (DECISIONS.md: "GitHub CI SKIPPED ... evidence is local-first"). Runs the
// Rust policy gate and prints a timestamped evidence line the integrator
// pastes into docs/superpowers/plans/rust-engine/EXECUTION_LOG.md.
//
// Requirements: Node >= 22, zero npm dependencies. Windows-first — works from
// PowerShell and Git Bash (spawns through the platform shell).
//
// Steps: native target (see below), fixture drift, cargo fmt --check, cargo
// clippy -D warnings, cargo build --workspace, cargo test --workspace, the
// collab crash tier (which only compiles under `--features fault-injection`,
// so the plain workspace run never sees it), then cargo-deny / cargo-audit IF
// installed (skip-with-warning when absent, never fail on a missing tool).
//
// A REQUIRED step that SKIPs fails the verdict: a gate that silently drops a
// row is how the fault-injection tests went unrun for a month. Optional tools
// may still skip.
//
// Usage:
//   node tools/rust-engine-program/run-rust-checks.mjs
// Exit code is non-zero if any REQUIRED step fails (optional tool skips do not
// fail the run).

import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { arch, platform, release } from "node:os";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "../..");

function run(cmd) {
  // shell:true so `cargo`/`cargo.exe` resolve identically under PowerShell,
  // Git Bash, and a Linux/WSL shell. stdio inherited so output streams live.
  const res = spawnSync(cmd, {
    cwd: repoRoot,
    shell: true,
    stdio: "inherit",
  });
  if (res.error) return { ok: false, code: null, error: res.error };
  return { ok: res.status === 0, code: res.status };
}

function toolAvailable(probe) {
  const res = spawnSync(probe, { cwd: repoRoot, shell: true, stdio: "ignore" });
  return !res.error && res.status === 0;
}

const required = [
  {
    name: "fixture drift",
    cmd: "node tools/rust-engine-program/check-fixture-drift.mjs",
    skipCode: 2,
    skipReason: "yjs/tsx unavailable; fixture drift not checked",
  },
  { name: "fmt --check", cmd: "cargo fmt --all --check" },
  {
    name: "clippy -D warnings",
    cmd: "cargo clippy --workspace --all-targets --all-features -- -D warnings",
  },
  { name: "build --workspace", cmd: "cargo build --workspace" },
  { name: "test --workspace", cmd: "cargo test --workspace" },
  {
    // The crash-recovery / exactly-once tests in dohc-engine-collab are behind
    // its `fault-injection` feature, which nothing in the workspace graph
    // enables — `cargo test --workspace` compiles them out. The workspace root
    // is virtual, so the feature must be enabled through an explicit `-p` run.
    name: "test collab crash tier",
    cmd: "cargo test -p dohc-engine-collab --features fault-injection",
  },
];

// The evidence line records a platform. This asks Rust what it actually
// compiled for, so the record is not the operator's assertion.
//
// The question is asked of rustc THROUGH cargo, so every channel that can
// retarget a build is reflected by construction: CARGO_BUILD_TARGET, any
// spelling of `[build].target` anywhere in cargo's hierarchical config, and a
// `--target` injected through RUSTFLAGS. The last one is why the cheaper
// checks do not work — it reaches rustc while cargo still writes to
// `target/debug`, so neither parsing `.cargo/config.toml` nor watching for a
// `target/<triple>/` directory can see it.
//
// Cost: this check-builds dohc-engine-protocol and its dependencies. The
// clippy step that follows reuses those artifacts, so the gate pays for them
// either way. It runs first and unconditionally: a guard behind a flag no
// call site passes is not a guard.
const NATIVE_PROBE =
  "cargo rustc -p dohc-engine-protocol --lib --profile check -- --print cfg";

// The host the evidence line claims, in rustc's vocabulary.
const RUST_ARCH = {
  x64: "x86_64",
  arm64: "aarch64",
  ia32: "x86",
  arm: "arm",
  ppc64: "powerpc64",
  s390x: "s390x",
  riscv64: "riscv64",
  loong64: "loongarch64",
};
const RUST_OS = {
  win32: "windows",
  darwin: "macos",
  linux: "linux",
  freebsd: "freebsd",
  openbsd: "openbsd",
  android: "android",
  aix: "aix",
  sunos: "solaris",
};

function cfgValues(stdout, key) {
  const values = new Set();
  for (const line of stdout.split(/\r?\n/)) {
    const m = /^([a-z_]+)="(.*)"$/.exec(line.trim());
    if (m && m[1] === key) values.add(m[2]);
  }
  return [...values];
}

function verifyNativeTarget() {
  const claimed = `${platform()}/${arch()}`;
  const want = `${RUST_ARCH[arch()]}/${RUST_OS[platform()]}`;
  if (!RUST_ARCH[arch()] || !RUST_OS[platform()]) {
    return {
      ok: false,
      reason: `no rustc arch/os name is known for the Node host ${claimed}, so the run cannot be verified native`,
    };
  }

  const res = spawnSync(NATIVE_PROBE, {
    cwd: repoRoot,
    shell: true,
    encoding: "utf8",
  });
  if (res.error || res.status !== 0) {
    return {
      ok: false,
      // The reason ends up on the one-line evidence record, so keep it on one
      // line.
      reason: `\`${NATIVE_PROBE}\` failed (exit ${res.status}${res.error ? `, ${res.error.message}` : ""}); cargo's effective target is unknown — last output: ${(res.stderr ?? "").trim().split(/\r?\n/).slice(-3).join(" / ") || "(none)"}`,
    };
  }

  const arches = cfgValues(res.stdout, "target_arch");
  const oses = cfgValues(res.stdout, "target_os");
  const envs = cfgValues(res.stdout, "target_env");
  if (arches.length !== 1 || oses.length !== 1) {
    return {
      ok: false,
      reason: `cargo compiled for ${Math.max(arches.length, oses.length)} targets (${arches.join(",")} / ${oses.join(",")}); native evidence requires exactly 1, the host's ${want}`,
    };
  }

  const got = `${arches[0]}/${oses[0]}`;
  if (got !== want) {
    return {
      ok: false,
      reason: `cargo compiled for ${got}, not the host's ${want} (Node reports ${claimed}); a cross-compiled or emulated run must not be recorded as native evidence — unset CARGO_BUILD_TARGET, remove \`[build].target\` from every \`.cargo/config[.toml]\` up to CARGO_HOME, and remove \`--target\` from RUSTFLAGS`,
    };
  }
  return {
    ok: true,
    cfg: [arches[0], oses[0], ...envs.filter(Boolean)].join("/"),
  };
}

// Optional supply-chain checks: run only when the tool is installed.
const optional = [
  { name: "cargo-deny", probe: "cargo deny --version", cmd: "cargo deny check" },
  { name: "cargo-audit", probe: "cargo audit --version", cmd: "cargo audit" },
];

const results = [];
let failed = false;

console.log(`\n== dohc Rust engine local checks ==`);
console.log(`host: ${platform()} ${arch()} (${release()})`);
console.log(`repo: ${repoRoot}\n`);

console.log(`\n--- native target ---`);
const native = verifyNativeTarget();
if (native.ok) {
  console.log(`  rust cfg ${native.cfg} — matches the host.`);
} else {
  console.error(`  native target — FAILED: ${native.reason}`);
  failed = true;
}
results.push({
  name: "native target",
  status: native.ok ? "PASS" : "FAIL",
  reason: native.ok ? undefined : native.reason,
});

// An unverified host makes every later result unattributable, so nothing else
// runs — and the expensive steps are the ones worth skipping.
for (const step of native.ok ? required : []) {
  console.log(`\n--- ${step.name} ---`);
  const r = run(step.cmd);
  if (r.code === step.skipCode) {
    // A skipped required step is a FAIL: stamping PASS with a row missing is
    // exactly the blind spot this gate exists to prevent.
    console.error(
      `  ${step.name} — SKIPPED (${step.skipReason}) — required steps may not skip; install the missing dependency (\`pnpm install --frozen-lockfile\`) and rerun.`,
    );
    failed = true;
    results.push({
      name: step.name,
      status: "SKIP",
      reason: `${step.skipReason}; required step skipped → verdict FAIL`,
    });
    continue;
  }
  if (!r.ok) failed = true;
  results.push({
    name: step.name,
    status: r.ok ? "PASS" : "FAIL",
  });
  if (r.error) console.error(`  (spawn error: ${r.error.message})`);
}

for (const step of native.ok ? optional : []) {
  console.log(`\n--- ${step.name} ---`);
  if (!toolAvailable(step.probe)) {
    console.warn(
      `  ${step.name} not installed — SKIPPED (install with \`cargo install ${step.name} --locked\`).`,
    );
    results.push({ name: step.name, status: "SKIP" });
    continue;
  }
  const r = run(step.cmd);
  if (!r.ok) failed = true;
  results.push({ name: step.name, status: r.ok ? "PASS" : "FAIL" });
}

// Summary + pasteable evidence line.
const stamp = new Date().toISOString();
const summary = results
  .map((r) => `${r.name}=${r.status}${r.reason ? `[${r.reason}]` : ""}`)
  .join(" ");

console.log(`\n== summary ==`);
for (const r of results) {
  console.log(
    `  ${r.status.padEnd(4)} ${r.name}${r.reason ? ` — ${r.reason}` : ""}`,
  );
}

const verdict = failed ? "FAIL" : "PASS";
console.log(`\nEVIDENCE (paste into EXECUTION_LOG.md):`);
console.log(
  `- ${stamp} | run-rust-checks | ${platform()}/${arch()} (rust cfg ${native.ok ? native.cfg : "UNVERIFIED"}) | ${verdict} | ${summary}`,
);

process.exit(failed ? 1 : 0);
