// The gate's artifact, produced by the gate.
//
// `tree-provenance.mjs` is well covered, and covering it proves nothing about
// the file that writes what humans and `require-ci-pass-verdict.mjs` read.
// Five mutations of the wiring in `run-rust-checks.mjs` once survived the
// whole suite, and two of them turn the feature off silently:
//
//   - reusing the opening reading instead of reading the tree again makes
//     provenance always PASS, so every log reads `tree <sha> clean` and the
//     verifier accepts it;
//   - stamping the opening reading instead of the judgement prints
//     `tree <sha> clean` directly above `FAIL tree provenance`, which is
//     evidence disagreeing with its own summary.
//
// So these tests run the real script and read its real output. `cargo` and
// `node` are stubbed on PATH so the run costs a second rather than an hour —
// the steps' verdicts are not the subject here, the artifact is.

import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync, existsSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { arch, platform } from "node:os";
import { RUST_ARCH, RUST_OS } from "../tools/rust-engine-program/native-target.mjs";
import { requireCiPassVerdict } from "../tools/rust-engine-program/require-ci-pass-verdict.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const gate = "tools/rust-engine-program/run-rust-checks.mjs";

// What the native-target probe must see to agree with this host, so the run
// gets past its first step and exercises every later boundary.
const cfgBlock = [
  "debug_assertions",
  `target_arch="${RUST_ARCH[arch()]}"`,
  'target_endian="little"',
  'target_env="gnu"',
  `target_os="${RUST_OS[platform()]}"`,
  'target_pointer_width="64"',
].join("\n");

/**
 * A PATH whose `cargo` and `node` return at once. `writes` is a path the stub
 * creates the first time it runs — a tree change made by something other than
 * the gate, while the gate is between two readings.
 */
function stubToolchain(writes) {
  const dir = mkdtempSync(join(tmpdir(), "dohc-gate-stub-"));
  const cfgPath = join(dir, "cfg.txt");
  writeFileSync(cfgPath, `${cfgBlock}\n`);

  const touch = writes ? writes.replaceAll("\\", "/") : "";
  const sh = [
    "#!/bin/sh",
    touch ? `[ -f "${touch}" ] || echo gate-stub > "${touch}"` : "",
    `cat "${cfgPath.replaceAll("\\", "/")}"`,
    "exit 0",
    "",
  ].join("\n");
  const cmd = [
    "@echo off",
    touch ? `if not exist "${writes}" echo gate-stub > "${writes}"` : "",
    `type "${cfgPath}"`,
    "exit /b 0",
    "",
  ].join("\r\n");

  for (const name of ["cargo", "node"]) {
    writeFileSync(join(dir, name), sh);
    chmodSync(join(dir, name), 0o755);
    writeFileSync(join(dir, `${name}.cmd`), cmd);
  }
  return dir;
}

function runGate(stubDir) {
  const res = spawnSync(process.execPath, [gate], {
    cwd: repoRoot,
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${stubDir}${platform() === "win32" ? ";" : ":"}${process.env.PATH}`,
    },
  });
  const out = `${res.stdout ?? ""}${res.stderr ?? ""}`;
  return {
    code: res.status,
    summary: out.slice(out.indexOf("== summary ==")),
    evidence: (out.match(/^- .*\| run-rust-checks \|.*$/m) ?? [""])[0],
  };
}

test("the gate stamps the tree it read, at every step boundary", () => {
  const stub = stubToolchain(null);
  try {
    const run = runGate(stub);

    // The summary block opens with the tree, and the row is in it.
    assert.match(run.summary, /^== summary ==\r?\n {2}tree [0-9a-f]{8} /);
    assert.match(run.summary, /PASS tree provenance/);

    // The evidence line carries the same stamp in its platform field, which
    // is where `require-ci-pass-verdict.mjs` reads it, and the row in its
    // summary field.
    assert.match(
      run.evidence,
      / head [0-9a-f]{8} (?:clean|dirty\(\d+\)), \d+ reads\)/,
    );
    assert.match(run.evidence, /tree provenance=PASS/);

    // One reading before the first step and one after each: 1 + native target
    // + 6 required + 2 optional. Endpoints alone would read 2, which is the
    // shape that cannot see a tree that changes and changes back.
    assert.match(run.evidence, /, 10 reads\)/);

    // The stamp names the commit this checkout is on, not any commit.
    const head = spawnSync("git rev-parse HEAD", {
      cwd: repoRoot,
      shell: true,
      encoding: "utf8",
    }).stdout.trim();
    assert.match(run.evidence, new RegExp(` head ${head.slice(0, 8)} `));

    // And the canonical verifier accepts what the producer just wrote. This
    // replaces a frozen copy of a past run's verdict line, which said the
    // same thing until the producer changed and the copy did not — twice in
    // this PR alone. Asking the live producer cannot go stale, and it pins
    // what the frozen line was really pinning: that every row name the gate
    // emits is a name the verifier requires, spaces and hyphens and all.
    assert.doesNotThrow(() => requireCiPassVerdict(run.evidence, () => head));
  } finally {
    rmSync(stub, { recursive: true, force: true });
  }
});

test("a tree changed under the gate is refused, and never stamped", () => {
  // The stub writes into the worktree the first time it runs — another
  // process editing the checkout while the gate's first step runs. Nothing
  // here waits or sleeps: the change is made by the step itself, so it is
  // always between the opening reading and the next one.
  const probe = join(repoRoot, ".dohc-gate-wiring-probe.tmp");
  rmSync(probe, { force: true });
  const stub = stubToolchain(probe);
  try {
    const run = runGate(stub);
    assert.equal(existsSync(probe), true, "the stub must have changed the tree");

    // The row fails, and names the step whose interval the change fell in —
    // that is what a reader has to re-run.
    assert.match(run.summary, /FAIL tree provenance/);
    assert.match(run.summary, /changed during `native target`/);
    assert.match(run.summary, /dohc-gate-wiring-probe/);

    // And the stamp is the judgement's. `tree <sha> clean` printed above a
    // FAIL row is a log disagreeing with its own summary.
    assert.match(run.summary, /^== summary ==\r?\n {2}tree UNATTRIBUTABLE\r?\n/);
    assert.doesNotMatch(run.summary.split("\n")[1], /clean|dirty/);
    assert.match(run.evidence, / head UNATTRIBUTABLE\)/);

    // A refused run is a failed run, in the verdict field and in the exit
    // code — not a green log with one red row inside it.
    assert.match(run.evidence, /\| FAIL \|/);
    assert.notEqual(run.code, 0);
  } finally {
    rmSync(probe, { force: true });
    rmSync(stub, { recursive: true, force: true });
  }
});
