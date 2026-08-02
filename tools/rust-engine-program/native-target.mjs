#!/usr/bin/env node
// Does the Rust toolchain compile for the machine the evidence line claims?
//
// The evidence line run-rust-checks.mjs prints records a platform. This asks
// Rust what it actually compiled for, so the record is not the operator's
// assertion.
//
// The question is asked of rustc THROUGH cargo, so every channel that can
// retarget a build is reflected by construction: CARGO_BUILD_TARGET, any
// spelling of `[build].target` anywhere in cargo's hierarchical config, and a
// `--target` injected through RUSTFLAGS. The last one is why the cheaper
// checks do not work — it reaches rustc while cargo still writes to
// `target/debug`, so neither parsing `.cargo/config.toml` nor watching for a
// `target/<triple>/` directory can see it.

import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { arch, platform } from "node:os";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

export const NATIVE_PROBE =
  "cargo rustc -p dohc-engine-protocol --lib --profile check -- --print cfg";

// The host the evidence line claims, in rustc's vocabulary.
export const RUST_ARCH = {
  x64: "x86_64",
  arm64: "aarch64",
  ia32: "x86",
  arm: "arm",
  ppc64: "powerpc64",
  s390x: "s390x",
  riscv64: "riscv64",
  loong64: "loongarch64",
};
export const RUST_OS = {
  win32: "windows",
  darwin: "macos",
  linux: "linux",
  freebsd: "freebsd",
  openbsd: "openbsd",
  android: "android",
  aix: "aix",
  sunos: "solaris",
};

// Every occurrence, in order, NOT the distinct set. `--print cfg` emits one
// `target_arch` line per target cargo built for, so two triples that share an
// arch and an os — `["x86_64-unknown-linux-gnu", "x86_64-unknown-linux-musl"]`
// — collapse to one value each under a set and read as a single native target.
// The count is the signal; the values are for the message.
export function cfgValues(stdout, key) {
  const values = [];
  for (const line of stdout.split(/\r?\n/)) {
    const m = /^([a-z_]+)="(.*)"$/.exec(line.trim());
    if (m && m[1] === key) values.push(m[2]);
  }
  return values;
}

function runCargoProbe() {
  return spawnSync(NATIVE_PROBE, {
    cwd: repoRoot,
    shell: true,
    encoding: "utf8",
  });
}

/**
 * `{ ok: true, cfg }` when cargo compiled for this host, otherwise
 * `{ ok: false, reason, output }` — `reason` is one line for the evidence
 * record, `output` is cargo's full stderr for the log.
 */
export function verifyNativeTarget({
  runProbe = runCargoProbe,
  nodeArch = arch(),
  nodePlatform = platform(),
} = {}) {
  const claimed = `${nodePlatform}/${nodeArch}`;
  const want = `${RUST_ARCH[nodeArch]}/${RUST_OS[nodePlatform]}`;
  if (!RUST_ARCH[nodeArch] || !RUST_OS[nodePlatform]) {
    return {
      ok: false,
      reason: `no rustc arch/os name is known for the Node host ${claimed}, so the run cannot be verified native`,
    };
  }

  const res = runProbe();
  if (res.error || res.status !== 0) {
    // cargo puts the primary error and its source location ABOVE the tail, so
    // the caller logs everything. The reason ends up on the one-line evidence
    // record, so that stays short and points at the log.
    return {
      ok: false,
      reason: `\`${NATIVE_PROBE}\` failed (exit ${res.status}${res.error ? `, ${res.error.message}` : ""}); cargo's effective target is unknown — its full output is above this summary`,
      output: (res.stderr ?? "").trim(),
    };
  }

  const arches = cfgValues(res.stdout, "target_arch");
  const oses = cfgValues(res.stdout, "target_os");
  const envs = cfgValues(res.stdout, "target_env");
  if (arches.length !== 1 || oses.length !== 1) {
    return {
      ok: false,
      reason: `cargo compiled for ${Math.max(arches.length, oses.length)} targets (${arches.join(",")} / ${oses.join(",")}); native evidence requires exactly 1, the host's ${want} — remove the extra targets from \`[build].target\` and CARGO_BUILD_TARGET`,
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
