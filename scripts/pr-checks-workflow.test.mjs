import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { requireCiPassVerdict } from "../tools/rust-engine-program/require-ci-pass-verdict.mjs";
import {
  classifyTreeProvenance,
  formatTreeStamp,
  readTreeState,
} from "../tools/rust-engine-program/tree-provenance.mjs";

const workflow = await readFile(
  new URL("../.github/workflows/pr-checks.yml", import.meta.url),
  "utf8",
);
const triggerBlock = workflow.slice(0, workflow.indexOf("\nconcurrency:"));

const passVerdict =
  "- 2026-07-27T00:00:00.000Z | run-rust-checks | linux/x64 " +
  "(rust cfg x86_64/linux/gnu, head 1f47af31 clean) | PASS | " +
  "tree provenance=PASS " +
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
  // Two runs sharing one worktree produced PASS and FAIL for the same commit,
  // and neither log could say which tree it read. A verdict without this row
  // is from a gate that never checked; a FAIL here is a run whose HEAD moved
  // mid-way, so its rows straddle two commits.
  assert.throws(
    () => requireCiPassVerdict(passVerdict.replace("tree provenance=PASS ", "")),
    /tree provenance/,
  );
  assert.throws(
    () =>
      requireCiPassVerdict(
        passVerdict.replace("tree provenance=PASS", "tree provenance=FAIL"),
      ),
    /tree provenance/,
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
    "| PASS | tree provenance=PASS",
    "| FAIL | tree provenance=PASS[the run before this one said x| PASS |y]",
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

test("the verdict must name the commit its gate examined", () => {
  // The `tree provenance` row says a check ran. It does not say which tree it
  // read — a producer that drops or mangles the stamp keeps a green row over
  // a verdict that names no commit, which is the decorative-row defect this
  // checker exists to refuse, one level up.
  assert.throws(
    () => requireCiPassVerdict(passVerdict.replace(", head 1f47af31 clean", "")),
    /does not name the commit the run examined/,
  );
  // What a refused run stamps. The row could still read PASS in a forged or
  // regressed line; the stamp is what names the tree, so it is checked.
  assert.throws(
    () =>
      requireCiPassVerdict(
        passVerdict.replace("head 1f47af31 clean", "head UNATTRIBUTABLE"),
      ),
    /does not name the commit the run examined/,
  );
  // Not a commit.
  assert.throws(
    () =>
      requireCiPassVerdict(
        passVerdict.replace("head 1f47af31 clean", "head zzzzzzzz clean"),
      ),
    /does not name the commit the run examined/,
  );
  // A sha with no tree state does not say whether the commit describes what
  // ran, which is half the claim.
  assert.throws(
    () =>
      requireCiPassVerdict(
        passVerdict.replace("head 1f47af31 clean", "head 1f47af31"),
      ),
    /does not name the commit the run examined/,
  );
  // The stamp closes the field, where the producer writes it. Text after it
  // rewrites the claim it makes: `head 1f47af31 clean, then reset to 700f1cfc`
  // names two trees and stands behind neither.
  assert.throws(
    () =>
      requireCiPassVerdict(
        passVerdict.replace(
          "head 1f47af31 clean)",
          "head 1f47af31 clean, then reset to 700f1cfc)",
        ),
      ),
    /does not name the commit the run examined/,
  );
  // The stamp answers from the platform field, not from anywhere in the line:
  // a step's reason quoting a stamp is not the gate naming its tree.
  assert.throws(
    () =>
      requireCiPassVerdict(
        passVerdict
          .replace(", head 1f47af31 clean", "")
          .replace("cargo-audit=PASS", "cargo-audit=PASS head 1f47af31 clean)"),
      ),
    /does not name the commit the run examined/,
  );
  // Uncommitted work is recorded, not refused: the gate runs over a dirty
  // tree in the normal local loop, and the stamp says so.
  assert.doesNotThrow(() =>
    requireCiPassVerdict(passVerdict.replace("clean)", "dirty(2))")),
  );
});

test("the verdict line a real gate run printed passes as written", () => {
  // Verbatim from a passing local run of
  // tools/rust-engine-program/run-rust-checks.mjs, 2026-08-04, on the commit
  // that added the provenance row. The parser has to read the names this
  // producer emits, spaces, hyphens and all — including the head stamp the
  // platform field now carries.
  const observed =
    "- 2026-08-04T02:01:20.492Z | run-rust-checks | win32/x64 " +
    "(rust cfg x86_64/windows/msvc, head 7f892132 clean) | PASS | " +
    "tree provenance=PASS native target=PASS " +
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

test("a run whose HEAD moved cannot claim either commit", () => {
  // The failure this row exists for: two runs shared one worktree, and a
  // `git checkout` moved the tree under the checks. Both logs looked like
  // verdicts; neither described a commit.
  const before = { head: "1f47af31ed00", dirty: [] };
  const after = { head: "700f1cfc3e00", dirty: [] };
  const moved = classifyTreeProvenance(before, after);
  assert.equal(moved.status, "FAIL");
  assert.match(moved.reason, /HEAD moved during the run/);
  // Both commits are named: a reader must be able to see what it straddled.
  assert.match(moved.reason, /1f47af31/);
  assert.match(moved.reason, /700f1cfc/);
  // The stamp is the judgement's, not the opening reading's: a run that
  // straddled two commits must not print one of them beside `clean`.
  assert.equal(moved.stamp, "UNATTRIBUTABLE");

  assert.equal(classifyTreeProvenance(before, before).status, "PASS");
});

test("a worktree edited under the run is never stamped clean", () => {
  // The defect this row exists for, minus the `git checkout`: an agent edits
  // the shared tree while the gate runs. HEAD never moves, so a check that
  // compares only commits reports PASS and stamps `<sha> clean` over checks
  // that read two different trees.
  const head = "1f47af31ed00";
  const appeared = classifyTreeProvenance(
    { head, dirty: [] },
    { head, dirty: [" M crates/engine/src/lib.rs"] },
  );
  assert.equal(appeared.status, "FAIL");
  assert.match(appeared.reason, /worktree changed during the run/);
  assert.match(appeared.reason, /crates\/engine\/src\/lib\.rs/);
  assert.equal(appeared.stamp, "UNATTRIBUTABLE");

  // Reverting an edit mid-run straddles two trees just as much as making one.
  const vanished = classifyTreeProvenance(
    { head, dirty: [" M crates/engine/src/lib.rs"] },
    { head, dirty: [] },
  );
  assert.equal(vanished.status, "FAIL");
  assert.equal(vanished.stamp, "UNATTRIBUTABLE");

  // A staged path is a different entry from an unstaged one: `git add` under
  // the run changes the status code, not the path.
  assert.equal(
    classifyTreeProvenance(
      { head, dirty: [" M a.rs"] },
      { head, dirty: ["M  a.rs"] },
    ).status,
    "FAIL",
  );

  // Dirt that was already there and stayed there is the recorded case, not
  // the corrupted one.
  assert.equal(
    classifyTreeProvenance(
      { head, dirty: [" M a.rs"] },
      { head, dirty: [" M a.rs"] },
    ).status,
    "PASS",
  );
});

test("a tree git cannot resolve fails rather than reading as green", () => {
  const unknown = { head: null, dirty: null };
  const known = { head: "1f47af31ed00", dirty: [] };
  assert.equal(classifyTreeProvenance(unknown, known).status, "FAIL");
  assert.equal(classifyTreeProvenance(known, unknown).status, "FAIL");
  assert.equal(formatTreeStamp(unknown), "UNATTRIBUTABLE");

  // A worktree status git did not answer is not an empty worktree status. A
  // run that reads `clean` off silence is inventing the fact it exists to
  // report.
  const unread = { head: "1f47af31ed00", dirty: null };
  const unreadable = classifyTreeProvenance(unread, known);
  assert.equal(unreadable.status, "FAIL");
  assert.match(unreadable.reason, /could not read the worktree status/);
  assert.equal(formatTreeStamp(unread), "UNATTRIBUTABLE");
  assert.equal(classifyTreeProvenance(known, unread).status, "FAIL");
});

test("a dirty tree is recorded, not failed", () => {
  // Running the gate over uncommitted work is the normal local loop. Failing
  // it would get the check removed; recording it tells the reader the commit
  // does not describe everything that ran.
  const dirty = {
    head: "1f47af31ed00",
    dirty: [" M a.rs", " M b.rs", "?? c.rs"],
  };
  const recorded = classifyTreeProvenance(dirty, dirty);
  assert.equal(recorded.status, "PASS");
  assert.equal(recorded.stamp, "1f47af31 dirty(3)");
  assert.equal(formatTreeStamp(dirty), "1f47af31 dirty(3)");
  assert.equal(
    formatTreeStamp({ head: "1f47af31ed00", dirty: [] }),
    "1f47af31 clean",
  );
});

test("the tree state lists changed paths, and survives a silent git", () => {
  const capture = (cmd) =>
    cmd === "git rev-parse HEAD"
      ? "1f47af31ed00\n"
      : " M a.rs\n?? b.rs\n\n";
  // The entries are kept whole, status codes and all: the comparison that
  // catches an edit mid-run needs to tell ` M a.rs` from `M  a.rs`.
  assert.deepEqual(readTreeState(capture), {
    head: "1f47af31ed00",
    dirty: [" M a.rs", "?? b.rs"],
  });
  // A repo that cannot answer must not read as a clean tree at an unknown
  // commit — that is the shape of evidence with no subject.
  assert.deepEqual(readTreeState(() => null), {
    head: null,
    dirty: null,
  });
  // rev-parse answered, status did not. Half an answer is not a clean tree.
  assert.deepEqual(
    readTreeState((cmd) => (cmd === "git rev-parse HEAD" ? "1f47af31\n" : null)),
    { head: "1f47af31", dirty: null },
  );
});
