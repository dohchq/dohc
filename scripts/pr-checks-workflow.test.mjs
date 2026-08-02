import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { requireCiPassVerdict } from "../tools/rust-engine-program/require-ci-pass-verdict.mjs";

const workflow = await readFile(
  new URL("../.github/workflows/pr-checks.yml", import.meta.url),
  "utf8",
);
const triggerBlock = workflow.slice(0, workflow.indexOf("\nconcurrency:"));

const passVerdict =
  "- 2026-07-27T00:00:00.000Z | run-rust-checks | linux/x64 " +
  "(rust cfg x86_64/linux/gnu) | PASS | " +
  "native target=PASS fixture drift=PASS fmt --check=PASS clippy -D warnings=PASS " +
  "build --workspace=PASS test --workspace=PASS test collab crash tier=PASS " +
  "cargo-deny=PASS cargo-audit=PASS";

test("canonical CI verdict requires every mandatory gate step to report PASS", () => {
  assert.doesNotThrow(() => requireCiPassVerdict(passVerdict));
  assert.throws(
    () =>
      requireCiPassVerdict(
        passVerdict.replace("fixture drift=PASS", "fixture drift=SKIP"),
      ),
    /fixture drift/,
  );
  assert.throws(
    () =>
      requireCiPassVerdict(
        passVerdict.replace("cargo-deny=PASS", "cargo-deny=SKIP"),
      ),
    /cargo-deny/,
  );
  // Drop this row and the platform in the verdict line is Node's unverified
  // claim again — a cross-compiled run recorded as native evidence.
  assert.throws(
    () =>
      requireCiPassVerdict(passVerdict.replace("native target=PASS ", "")),
    /native target/,
  );
  // The crash tier is compiled out of the plain workspace test run, so an
  // evidence line missing this row means the exactly-once tests never ran.
  assert.throws(
    () =>
      requireCiPassVerdict(
        passVerdict.replace(" test collab crash tier=PASS", ""),
      ),
    /test collab crash tier/,
  );
  // The advisory scan is the one that had been silently skipping: CI never
  // installed cargo-audit, so the gate probed, reported SKIP, and the verdict
  // check did not mind. Both halves are now required -- the tool is installed
  // and a SKIP fails.
  assert.throws(
    () =>
      requireCiPassVerdict(
        passVerdict.replace("cargo-audit=PASS", "cargo-audit=SKIP"),
      ),
    /cargo-audit/,
  );
});

test("PR workflow validates the canonical verdict and installed cargo-deny version", () => {
  assert.match(
    workflow,
    /node tools\/rust-engine-program\/run-rust-checks\.mjs 2>&1 \| tee pr-engine-gate\.log/,
  );
  assert.match(
    workflow,
    /node tools\/rust-engine-program\/require-ci-pass-verdict\.mjs pr-engine-gate\.log/,
  );
  assert.match(
    workflow,
    /RESOLVED_CARGO_DENY_VERSION[\s\S]*"cargo-deny \$CARGO_DENY_VERSION"/,
  );
  assert.match(
    workflow,
    /RESOLVED_CARGO_AUDIT_VERSION[\s\S]*"\$CARGO_AUDIT_VERSION"/,
  );
});

test("PR workflow is deliberately disabled: dispatch-only, decision documented", () => {
  // Ice's 2026-07-28 pre-launch decision: the gate is dispatch-only for now.
  // This test pins that state so a half re-enable (say, pull_request without
  // push) can't drift in unnoticed, and so the disable itself reads as a
  // decision rather than an accident. When re-enabling, restore the previous
  // version of this test (it asserted: bare `pull_request:` with no branches
  // filter, `merge_group:`, and `push:` restricted to main).
  assert.match(triggerBlock, /^  workflow_dispatch:\s*$/m);
  assert.doesNotMatch(triggerBlock, /^  pull_request:/m);
  assert.doesNotMatch(triggerBlock, /^  push:/m);
  assert.doesNotMatch(triggerBlock, /^  merge_group:/m);
  // The disable must stay explained in the workflow itself.
  assert.match(workflow, /DISABLED ON PURPOSE \(2026-07-28\)/);
});
