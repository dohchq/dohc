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
import {
  mkdtempSync,
  writeFileSync,
  readFileSync,
  rmSync,
  existsSync,
  chmodSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
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
 * A PATH whose `cargo` and `node` return at once.
 *
 * `writes` is a path the stub creates the first time it runs — a tree change
 * made by something other than the gate, while the gate is between two
 * readings. `movesHead` moves HEAD one commit back and returns it, which
 * leaves what a `git checkout` away and back leaves and nothing else: two HEAD
 * reflog entries, with the commit, the worktree, and the index as they were.
 *
 * Both run through a helper script driven by `process.execPath` and an
 * absolute path, because `node` on PATH is one of the stubs.
 */
function stubToolchain({ writes, movesHead } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "dohc-gate-stub-"));
  const cfgPath = join(dir, "cfg.txt");
  writeFileSync(cfgPath, `${cfgBlock}\n`);

  const probePath = join(dir, "move-head.mjs");
  if (movesHead) writeFileSync(probePath, headProbe);
  const probe = movesHead
    ? `"${process.execPath}" "${probePath}" "${join(dir, "moved.marker")}" "${repoRoot}"`
    : "";

  // Every stub invocation dumps its environment: the caps are a claim about
  // what the CHILD saw, and asserting only the strings the gate prints about
  // itself is how a replaced-not-merged child env shipped a vacuous
  // scratch-leak row once.
  const envDump = join(dir, "envdump.txt");
  const touch = writes ? writes.replaceAll("\\", "/") : "";
  const sh = [
    "#!/bin/sh",
    `env > "${envDump.replaceAll("\\", "/")}"`,
    touch ? `[ -f "${touch}" ] || echo gate-stub > "${touch}"` : "",
    probe.replaceAll("\\", "/"),
    `cat "${cfgPath.replaceAll("\\", "/")}"`,
    "exit 0",
    "",
  ].join("\n");
  const cmd = [
    "@echo off",
    `set > "${envDump}"`,
    touch ? `if not exist "${writes}" echo gate-stub > "${writes}"` : "",
    probe,
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

// Runs once per stub, from inside a gate step: HEAD moves back one commit and
// returns. That writes two HEAD reflog entries and changes nothing else, so
// the readings on both sides of the step agree about the commit and the
// worktree, exactly as they would around a checkout that was undone.
//
// It moves rather than rewriting HEAD with the value it already holds, because
// that is a no-op on a DETACHED HEAD — `update-ref` writes an entry there only
// when the value changes. A gate run in a detached checkout (a bisect, a CI
// checkout of a sha) would have left this probe doing nothing and the test
// asserting against a run that never had a defect.
//
// The two entries stay in this checkout's reflog afterwards, so `pnpm test`
// adds two to whatever the developer's log already holds. Nothing else about
// the checkout is touched: HEAD ends on the commit it started on, and the
// restore runs even when the away step fails.
const headProbe = `import { spawnSync } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
const [marker, repoRoot] = process.argv.slice(2);
if (existsSync(marker)) process.exit(0);
writeFileSync(marker, "moved\\n");
const git = (...args) =>
  spawnSync("git", args, { cwd: repoRoot, encoding: "utf8" });
const head = git("rev-parse", "HEAD").stdout.trim();
const message = "rust-gate-artifact test probe";
try {
  git("update-ref", "-m", message, "HEAD", head + "~1");
} finally {
  git("update-ref", "-m", message, "HEAD", head);
}
`;

/**
 * Where the stub writes, to make the tree change this test is about. It has to
 * be inside the repo, because git has to see it — so it is named for the run
 * that makes it. A fixed name is shared state between two `pnpm test`
 * processes in one checkout: either can delete the other's probe before the
 * gate reads it, which fails the regression test that proves the gate works.
 */
const probePath = () =>
  join(repoRoot, `.dohc-gate-wiring-probe-${process.pid}-${randomUUID().slice(0, 8)}.tmp`);

/**
 * Take ownership of a path, or refuse it. This test deletes its probe when it
 * finishes, so it must never adopt a file it did not create: an untracked file
 * at that path is a developer's work, and deleting it to make room is the
 * unowned write this whole test exists to catch the gate missing.
 */
function claim(path) {
  if (existsSync(path)) {
    throw new Error(
      `refusing to use ${path} as the wiring probe: it already exists, and this test removes only what it created`,
    );
  }
  return path;
}

/** A PATH whose `<name>` prints `stdout` and exits `code`. */
function stubCommand(name, stdout, code) {
  const dir = mkdtempSync(join(tmpdir(), "dohc-cmd-stub-"));
  writeFileSync(
    join(dir, name),
    `#!/bin/sh\nprintf '%s\\n' "${stdout}"\nexit ${code}\n`,
  );
  chmodSync(join(dir, name), 0o755);
  writeFileSync(
    join(dir, `${name}.cmd`),
    `@echo off\r\necho ${stdout}\r\nexit /b ${code}\r\n`,
  );
  return dir;
}

const withPath = (dir) => ({
  ...process.env,
  PATH: dir ? `${dir}${platform() === "win32" ? ";" : ":"}${process.env.PATH}` : process.env.PATH,
});

function runGate(stubDir) {
  // The gate takes a build slot before its first step (build-slot.mjs). A
  // private root keeps a suite run from holding a real lane's slot, and a
  // zero disk floor keeps the suite runnable on a low-disk machine.
  const slotRoot = mkdtempSync(join(tmpdir(), "dohc-gate-slots-"));
  try {
    const res = spawnSync(process.execPath, [gate], {
      cwd: repoRoot,
      encoding: "utf8",
      env: {
        ...withPath(stubDir),
        DOHC_BUILD_SLOT_ROOT: slotRoot,
        DOHC_GATE_DISK_FLOOR_GB: "0",
      },
    });
    const out = `${res.stdout ?? ""}${res.stderr ?? ""}`;
    return {
      code: res.status,
      summary: out.slice(out.indexOf("== summary ==")),
      evidence: (out.match(/^- .*\| run-rust-checks \|.*$/m) ?? [""])[0],
    };
  } finally {
    rmSync(slotRoot, { recursive: true, force: true });
  }
}

test("the gate stamps the tree it read, at every step boundary", () => {
  const stub = stubToolchain();
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

test("the caps and the scratch root reach every cargo child", () => {
  const stub = stubToolchain();
  try {
    const run = runGate(stub);

    // What the child actually received, not what the gate printed about
    // itself. DOHC_TEST_SCRATCH_ROOT is the one the scratch-leak row depends
    // on: without it the tests write elsewhere and the row inspects an empty
    // tree.
    const child = readFileSync(join(stub, "envdump.txt"), "utf8");
    assert.match(child, /CARGO_INCREMENTAL=0/);
    assert.match(child, /CARGO_BUILD_JOBS=\d+/);
    assert.match(child, /RUST_TEST_THREADS=\d+/);
    assert.match(child, /DOHC_TEST_SCRATCH_ROOT=./);

    // And the evidence line records caps, ahead of the head stamp.
    assert.match(run.evidence, /, jobs \d+, test-threads \d+, head /);
  } finally {
    rmSync(stub, { recursive: true, force: true });
  }
});

test("the gate refuses to start under the disk floor, naming it", () => {
  const stub = stubToolchain();
  const slotRoot = mkdtempSync(join(tmpdir(), "dohc-gate-slots-"));
  try {
    const res = spawnSync(process.execPath, [gate], {
      cwd: repoRoot,
      encoding: "utf8",
      env: {
        ...withPath(stub),
        DOHC_BUILD_SLOT_ROOT: slotRoot,
        // No volume has this much free space; the refusal must name the
        // floor, per "Show agents the limits they hit".
        DOHC_GATE_DISK_FLOOR_GB: "9999999",
      },
    });
    assert.notEqual(res.status, 0);
    assert.match(res.stderr, /below the 9999999 GB floor/);
    assert.match(res.stderr, /DOHC_GATE_DISK_FLOOR_GB/);
  } finally {
    rmSync(stub, { recursive: true, force: true });
    rmSync(slotRoot, { recursive: true, force: true });
  }
});

test("the verifier asks git which commit this checkout is, and refuses when it cannot", () => {
  // `resolveCheckoutHead` is what makes the stamp-value check a check: it
  // answers "which commit is this checkout". Both importers of this module
  // pass an injected fake, and the only caller of the real function is a
  // dispatch-only workflow — so nothing ran it, and making it return null
  // unconditionally left the suite green while the CLI refused every valid
  // verdict for the current HEAD. A check that can be silently disabled is
  // the failure this PR exists to make impossible, so this runs the real CLI
  // and stubs `git` on PATH rather than injecting a resolver.
  const stub = stubToolchain();
  const log = join(mkdtempSync(join(tmpdir(), "dohc-verdict-")), "gate.log");
  try {
    // A real evidence line, from the real producer, stamped with this
    // checkout's commit.
    writeFileSync(log, `${runGate(stub).evidence}\n`);

    const verify = (pathDir) =>
      spawnSync(
        process.execPath,
        ["tools/rust-engine-program/require-ci-pass-verdict.mjs", log],
        { cwd: repoRoot, encoding: "utf8", env: withPath(pathDir) },
      );

    // The real function, against the real repo: it resolves, and the stamp
    // matches. Returning null unconditionally is fail-CLOSED — it refuses
    // every valid verdict, so this catches it.
    const real = verify(null);
    assert.equal(real.status, 0, real.stderr);
    assert.match(real.stdout, /on this checkout's commit/);

    // What the resolver actually answered, read back in production form:
    // stamp a different commit and the refusal prints the commit this
    // checkout is on. It must be `git rev-parse HEAD`, all forty characters.
    const head = spawnSync("git rev-parse HEAD", {
      cwd: repoRoot,
      shell: true,
      encoding: "utf8",
    }).stdout.trim();
    const elsewhere = join(dirname(log), "elsewhere.log");
    writeFileSync(
      elsewhere,
      readFileSync(log, "utf8").replace(
        ` head ${head.slice(0, 8)} `,
        " head deadbeef ",
      ),
    );
    const wrong = spawnSync(
      process.execPath,
      ["tools/rust-engine-program/require-ci-pass-verdict.mjs", elsewhere],
      { cwd: repoRoot, encoding: "utf8", env: withPath(null) },
    );
    assert.notEqual(wrong.status, 0);
    assert.match(
      wrong.stderr,
      new RegExp(`this checkout is at \`${head.slice(0, 8)}\` \\(${head}\\)`),
    );

    // A git that answers with something that is not a commit is not an
    // answer. Dropping that guard is fail-OPEN: the junk flows into
    // `head.startsWith(sha)` and the verdict is refused for looking like the
    // wrong commit, which tells a reader to re-run the gate instead of to fix
    // their git.
    const junk = stubCommand("git", "not-a-sha", 0);
    // A git that cannot answer at all — what a cwd outside any repository
    // looks like from here, since the resolver only ever sees the failure.
    const broken = stubCommand("git", "fatal: not a git repository", 1);
    // And a git that failed while printing something that reads like an
    // answer. A commit-shaped string from a command that failed is not this
    // checkout's commit, and only the exit status says so.
    const stale = stubCommand("git", "0".repeat(40), 1);
    try {
      for (const dir of [junk, broken, stale]) {
        const refused = verify(dir);
        assert.notEqual(refused.status, 0);
        assert.match(refused.stderr, /could not answer `git rev-parse HEAD`/);
      }
    } finally {
      for (const dir of [junk, broken, stale]) {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  } finally {
    rmSync(stub, { recursive: true, force: true });
    rmSync(dirname(log), { recursive: true, force: true });
  }
});

test("the wiring probe belongs to the run that made it", () => {
  // The test below writes into the repo root and deletes what it wrote. Both
  // halves are shared state: a fixed name lets two `pnpm test` processes in
  // one checkout delete each other's probe, and an unconditional delete
  // destroys whatever untracked file happens to sit at that path. A test
  // proving the gate catches foreign writes must not be making one.
  assert.notEqual(probePath(), probePath());

  const taken = join(tmpdir(), `dohc-probe-claim-${randomUUID()}`);
  writeFileSync(taken, "a developer's untracked work\n");
  try {
    assert.throws(() => claim(taken), /refusing to use/);
  } finally {
    rmSync(taken, { force: true });
  }
});

test("a tree changed under the gate is refused, and never stamped", () => {
  // The stub writes into the worktree the first time it runs — another
  // process editing the checkout while the gate's first step runs. Nothing
  // here waits or sleeps: the change is made by the step itself, so it is
  // always between the opening reading and the next one.
  const probe = claim(probePath());
  const stub = stubToolchain({ writes: probe });
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

test("a HEAD moved and returned inside one step is refused", () => {
  // The case a boundary reading cannot reach on its own: HEAD moves and comes
  // back while the step runs, and reads the same commit on both sides of it.
  // `git status` is identical too, so the only witness is the HEAD reflog the
  // gate now reads. This holds on a detached HEAD as well as an attached one,
  // which is why the probe moves HEAD instead of rewriting it in place.
  const stub = stubToolchain({ movesHead: true });
  try {
    const run = runGate(stub);

    assert.match(run.summary, /FAIL tree provenance/);
    // Git can expose one or both ref updates in HEAD's worktree reflog. The
    // contract is that any recorded update makes the run unattributable, not
    // that every Git host records the same count.
    assert.match(
      run.summary,
      /HEAD was updated [1-9]\d* time(?:s)? during `native target`/,
    );

    // The stamp is the judgement's, and the verdict is the run's.
    assert.match(run.summary, /^== summary ==\r?\n {2}tree UNATTRIBUTABLE\r?\n/);
    assert.match(run.evidence, / head UNATTRIBUTABLE\)/);
    assert.match(run.evidence, /\| FAIL \|/);
    assert.notEqual(run.code, 0);
  } finally {
    rmSync(stub, { recursive: true, force: true });
  }
});
