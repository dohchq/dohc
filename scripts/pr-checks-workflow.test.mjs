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

test("a required step is matched by its whole name, not as a substring", () => {
  // Reading the line by substring let any row whose name merely contained a
  // required name answer for it, so a run that never verified its target
  // passed the check by carrying a row about something else.
  const forged = passVerdict.replace(
    "native target=PASS",
    "not-native target=PASS",
  );
  assert.throws(() => requireCiPassVerdict(forged), /native target/);

  // The genuine row still satisfies the requirement beside the forged one.
  assert.doesNotThrow(() =>
    requireCiPassVerdict(
      passVerdict.replace(
        "native target=PASS",
        "not-native target=PASS native target=PASS",
      ),
    ),
  );

  // Two rows for one step leave the step's result ambiguous, so neither wins.
  assert.throws(
    () =>
      requireCiPassVerdict(
        passVerdict.replace(
          "native target=PASS",
          "native target=SKIP native target=PASS",
        ),
      ),
    /2 rows for required CI gate step `native target`/,
  );
});

test("a status is matched whole, so `PASSED` is not a PASS", () => {
  // The substring hole on the status axis: without a word boundary after the
  // status, `native target=PASSED` reads as `native target=PASS` followed by
  // a row named `ED fixture drift`.
  assert.throws(
    () =>
      requireCiPassVerdict(
        passVerdict.replace("native target=PASS", "native target=PASSED"),
      ),
    /native target/,
  );
});

test("the verdict is read from its own field, not found anywhere in the line", () => {
  // A failed run can quote `| PASS |` inside a step's reason, and the quote
  // does not split the line into more fields when it carries no outer spaces.
  const forged = passVerdict.replace(
    "| PASS | native target=PASS",
    "| FAIL | native target=PASS[the run before this one said x| PASS |y]",
  );
  assert.throws(
    () => requireCiPassVerdict(forged),
    /verdict field reads `FAIL`/,
  );
});

test("an extra ` | ` is rejected, because the verdict is read by position", () => {
  // Reading the verdict from field 4 makes the field count load-bearing: a
  // sixth field shifts every later field, and the rows this line carries would
  // otherwise satisfy all nine required steps while the verdict being read
  // came from somewhere else.
  assert.throws(
    () => requireCiPassVerdict(`${passVerdict} note=SKIP [a | b]`),
    /expected exactly 5/,
  );
});

test("a status ends at the row's end, not at a word boundary", () => {
  // A word boundary sits before `-` and `[` too, so both of these read as a
  // PASS while carrying something else.
  for (const forgery of ["native target=PASS-ignored", "native target=PASS[x]"]) {
    assert.throws(
      () =>
        requireCiPassVerdict(
          passVerdict.replace("native target=PASS", forgery),
        ),
      /native target/,
      forgery,
    );
  }
});

test("a PASS summary may not carry a `[reason]`, so no row can hide in one", () => {
  // Each forgery deletes the last required row and writes its name inside
  // another row's reason. Only a failed run writes a reason, so a PASS line
  // carrying one is already not a line this gate produced -- and reading the
  // reason at all is what makes the forgery work, because free-form text has
  // no end a reader can find. The second vector proves it: whichever `]` the
  // reader treats as the close, the other reading mints rows from the text.
  for (const forgery of [
    "other=SKIP[x=cargo-audit=PASS]",
    "other=SKIP[x] cargo-audit=PASS z=SKIP[y]]",
  ]) {
    assert.throws(
      () => requireCiPassVerdict(passVerdict.replace("cargo-audit=PASS", forgery)),
      /step row `other=SKIP` carries a `\[reason\]`/,
      forgery,
    );
  }
});

test("the gate name is required in its own field, not anywhere in the line", () => {
  // The line is found by its gate name. Put that name where the platform goes
  // and the line passes the search, holds five fields, and reports PASS in the
  // verdict field with every required row present.
  const impostor =
    "- 2026-07-27T00:00:00.000Z | not-the-gate | run-rust-checks | PASS | " +
    "native target=PASS fixture drift=PASS fmt --check=PASS clippy -D warnings=PASS " +
    "build --workspace=PASS test --workspace=PASS test collab crash tier=PASS " +
    "cargo-deny=PASS cargo-audit=PASS";
  assert.throws(
    () => requireCiPassVerdict(impostor),
    /step field reads `not-the-gate`/,
  );
});

test("the verdict line a real gate run printed passes as written", () => {
  // Verbatim from C:/w/iss-nativeev-gate3.log, 2026-08-02 — a passing local
  // run of tools/rust-engine-program/run-rust-checks.mjs. The parser has to
  // read the names this producer emits, spaces, hyphens and all.
  const observed =
    "- 2026-08-02T05:19:19.166Z | run-rust-checks | win32/x64 " +
    "(rust cfg x86_64/windows/msvc) | PASS | native target=PASS " +
    "fixture drift=PASS fmt --check=PASS clippy -D warnings=PASS " +
    "build --workspace=PASS test --workspace=PASS test collab crash tier=PASS " +
    "cargo-deny=PASS cargo-audit=PASS";
  assert.doesNotThrow(() => requireCiPassVerdict(observed));
  assert.throws(
    () =>
      requireCiPassVerdict(
        observed.replace("cargo-deny=PASS", "not-cargo-deny=PASS"),
      ),
    /cargo-deny/,
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
