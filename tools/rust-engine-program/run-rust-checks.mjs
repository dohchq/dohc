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
// Steps: fixture drift, cargo fmt --check, cargo clippy -D warnings, cargo
// build --workspace, cargo test --workspace, the collab crash tier (which only
// compiles under `--features fault-injection`, so the plain workspace run
// never sees it), then cargo-deny / cargo-audit IF installed
// (skip-with-warning when absent, never fail on a missing tool).
//
// A REQUIRED step that SKIPs fails the verdict: a gate that silently drops a
// row is how the fault-injection tests went unrun for a month. Optional tools
// may still skip.
//
// Usage:
//   node tools/rust-engine-program/run-rust-checks.mjs
//   node tools/rust-engine-program/run-rust-checks.mjs --expect-arch=x64
// EVERY run validates CARGO's effective target (host triple vs CARGO_BUILD_TARGET
// or [build].target here / in an ancestor / in CARGO_HOME) and aborts on a
// cross-compile: the evidence line certifies the Rust workspace, and no call site
// passes a flag. --expect-arch additionally asserts which arch that target is,
// and makes an unverifiable target fatal instead of a warning.
// Exit code is non-zero if any REQUIRED step fails (optional tool skips do not
// fail the run).

import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { arch, homedir, platform, release } from "node:os";
import { existsSync, readFileSync } from "node:fs";

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

// Inherited from run-native-suite.mjs when that runner was retired (R16), and
// then corrected: the evidence certifies the RUST workspace, so the pin has to
// validate what CARGO builds. os.arch() describes only the Node binary, while
// cargo honours CARGO_BUILD_TARGET and build.target independently — so an arm64
// Node could satisfy --expect-arch=arm64 while every spawned cargo command built
// x86_64 and macOS ran the tests under Rosetta, stamping darwin/arm64 onto x64
// evidence. Neither check detects emulation of Node itself; that is why the
// cargo target, not process.arch, is the thing being pinned.
function cargoHostTriple() {
  const res = spawnSync("cargo -vV", { cwd: repoRoot, shell: true, encoding: "utf8" });
  if (res.error || res.status !== 0) return null;
  return /^host:\s*(\S+)$/mu.exec(res.stdout ?? "")?.[1] ?? null;
}

function configuredCargoTarget() {
  if (process.env.CARGO_BUILD_TARGET) return process.env.CARGO_BUILD_TARGET;
  // Cargo config is HIERARCHICAL: it reads .cargo/config.toml in the cwd and in
  // every ancestor directory, closest winning, then CARGO_HOME. Checking only the
  // repo root would miss a cross target inherited from a parent (a sibling
  // checkout under C:\w, say) that cargo nonetheless applies to every command.
  const candidates = [];
  for (let dir = repoRoot; ; ) {
    // `config` BEFORE `config.toml`: when both exist cargo warns and uses the
    // extensionless one, so reading config.toml first would validate a file cargo
    // ignores.
    candidates.push(join(dir, ".cargo", "config"), join(dir, ".cargo", "config.toml"));
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  const cargoHome = process.env.CARGO_HOME || join(homedir(), ".cargo");
  candidates.push(join(cargoHome, "config"), join(cargoHome, "config.toml"));
  // Collect from EVERY level rather than returning at the first hit. Cargo MERGES
  // array-valued build.target across config levels (a repo `["aarch64"]` plus an
  // ancestor `["x86_64"]` builds both) and overrides scalars nearest-first. This
  // parser cannot implement those semantics — three review rounds of trying proved
  // that — so it collects everything and refuses unless the whole picture is
  // unambiguously the host. Over-refusing is the safe direction: a legitimate
  // nearest-scalar override now aborts too, and the operator unsets it or records
  // the evidence by hand.
  const found = [];
  for (const path of candidates) {
    if (!existsSync(path)) continue;
    let text;
    try {
      text = readFileSync(path, "utf8");
    } catch (error) {
      // Existing-but-unreadable must not read as "no target configured", and must
      // not crash the gate before its summary either.
      return { unparseable: `${path} (${error.code ?? error.message})` };
    }
    // Walk sections: only a build-scoped `target` is a default. A
    // [target.<triple>] section configures that triple, it does not select it.
    let inBuild = false;
    let inKnownSection = true; // top level: build.target / build={} are handled below
    for (const line of text.split(/\r?\n/u)) {
      const section = /^\s*\[([^\]]+)\]/u.exec(line);
      if (section) {
        // Normalise the table name: cargo accepts [build], [ build ] and the
        // QUOTED ["build"]. Comparing raw section text missed the quoted form and
        // reported "no target configured", certifying the host for a cross build.
        const name = section[1]
          .trim()
          .replace(/^["'](.*)["']$/u, "$1")
          .trim();
        inBuild = name === "build";
        // [target.<triple>] legitimately carries linker/runner/rustflags, never a
        // build default. Any OTHER table carrying a `target =` is a spelling this
        // parser does not know, and after seven of those on this PR the answer is
        // to refuse rather than guess.
        inKnownSection = inBuild || name === "target" || name.startsWith("target.");
        continue;
      }
      if (!inBuild && !inKnownSection && /^\s*target\s*=/u.test(line)) {
        return { unparseable: `${path}: target assigned in an unrecognised table — ${line.trim()}` };
      }
      // Cargo accepts all of: [build] + target=, the dotted key build.target=,
      // and the inline table build={target=...}. Missing any spelling meant
      // falling back to the host triple and certifying a cross run as native.
      const assignment = inBuild
        ? /^\s*target\s*=\s*(.*)$/u.exec(line)?.[1]
        : (/^\s*build\s*\.\s*target\s*=\s*(.*)$/u.exec(line)?.[1] ??
           (/^\s*build\s*=\s*\{/u.test(line)
             ? /target\s*=\s*([^},]*)/u.exec(line)?.[1]
             : undefined));
      if (assignment === undefined) continue;
      // Both quote styles, scalar or array.
      const triples = [...assignment.matchAll(/["']([^"']+)["']/gu)].map((m) => m[1]);
      // Anything we cannot read as at least one triple FAILS CLOSED. This parser
      // is not a TOML implementation and must never guess: `cargo config get
      // build.target` is nightly-only, so there is no authoritative fallback.
      if (triples.length === 0) return { unparseable: `${path}: ${line.trim()}` };
      for (const triple of triples) if (!found.includes(triple)) found.push(triple);
    }
  }
  if (found.length === 0) return null;
  // Any spread of configured targets — merged arrays, or an override this parser
  // cannot rank — is never a single native run.
  return found.length > 1 ? found.join(",") : found[0];
}

const TRIPLE_ARCH = { x86_64: "x64", aarch64: "arm64", i686: "ia32", armv7: "arm" };
const expectArch = process.argv
  .slice(2)
  .filter((a) => a.startsWith("--expect-arch="))
  .map((a) => a.split("=")[1])[0];

// UNCONDITIONAL. Every run of this gate prints an evidence line, so every run is
// producing evidence — and no call site passes --expect-arch: not
// macos-evidence.sh, not either workflow, not any README example. A guard that
// only ran with the flag would never run at all.
const cargoHost = cargoHostTriple();
const configured = cargoHost ? configuredCargoTarget() : null;
if (configured && typeof configured === "object") {
  console.error(
    `ABORT: cannot determine cargo's effective target from ${configured.unparseable}. ` +
      `Refusing to certify native evidence on a target this gate cannot read.`,
  );
  process.exit(2);
}
const cargoTarget = cargoHost ? (configured ?? cargoHost) : null;
const cargoArch = cargoTarget
  ? (TRIPLE_ARCH[cargoTarget.split("-")[0]] ?? cargoTarget.split("-")[0])
  : null;

if (cargoHost && cargoTarget !== cargoHost) {
  console.error(
    `ABORT: cargo builds for ${cargoTarget} on host ${cargoHost} (CARGO_BUILD_TARGET, or ` +
      `[build].target in a .cargo/config.toml here or in an ancestor). A cross-compiled run ` +
      `is not native evidence. Unset it, or record the evidence as ${cargoTarget}.`,
  );
  process.exit(2);
}

if (expectArch) {
  // Explicitly asking to certify means an unverifiable target must fail closed.
  if (!cargoHost) {
    console.error(
      `ABORT: --expect-arch=${expectArch} was requested but \`cargo -vV\` did not report a host ` +
        `triple, so the cargo target cannot be verified. Refusing to certify native evidence.`,
    );
    process.exit(2);
  }
  if (cargoArch !== expectArch) {
    console.error(
      `ABORT: --expect-arch=${expectArch} but cargo targets ${cargoTarget} (arch ${cargoArch}). ` +
        `Cross-built runs must not be recorded as native evidence.`,
    );
    process.exit(2);
  }
} else if (!cargoHost) {
  // Not fatal on its own: if cargo is genuinely broken the first cargo step below
  // fails and the verdict is FAIL anyway. Say it out loud rather than skip quietly.
  console.warn(
    `  note: \`cargo -vV\` reported no host triple, so the cargo target could not be verified.`,
  );
}

// The evidence line must name the arch the RUST tests ran as, not Node's.
const evidenceArch = cargoArch ?? arch();
console.log(`cargo: ${cargoTarget ?? "unverified"} (arch ${evidenceArch})`);

for (const step of required) {
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

for (const step of optional) {
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
  `- ${stamp} | run-rust-checks | ${platform()}/${evidenceArch} | ${verdict} | ${summary}`,
);

process.exit(failed ? 1 : 0);
