import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { requireCiPassVerdict } from "../tools/rust-engine-program/require-ci-pass-verdict.mjs";
import {
  HEAD_REFLOG_RECOVERY,
  classifyTreeProvenance,
  formatTreeStamp,
  formatTreeState,
  readTreeState,
} from "../tools/rust-engine-program/tree-provenance.mjs";

// The checkout a verdict is being accepted for. The checker refuses to run
// without one, so every call here supplies it; the tests that exercise the
// commit check itself call `requireCiPassVerdict` directly.
const CHECKOUT_HEAD = "1f47af310e5b8a1d3c9f0e7a2b4d6c8e1f2a3b4c";
const check = (log, resolveHead = () => CHECKOUT_HEAD) =>
  requireCiPassVerdict(log, resolveHead);

const workflow = await readFile(
  new URL("../.github/workflows/pr-checks.yml", import.meta.url),
  "utf8",
);
const triggerBlock = workflow.slice(0, workflow.indexOf("\nconcurrency:"));

const passVerdict =
  "- 2026-07-27T00:00:00.000Z | run-rust-checks | linux/x64 " +
  "(rust cfg x86_64/linux/gnu, head 1f47af31 clean, 11 reads) | PASS | " +
  "tree provenance=PASS " +
  "native target=PASS fixture drift=PASS fmt --check=PASS clippy -D warnings=PASS " +
  "build --workspace=PASS test --workspace=PASS doctests=PASS " +
  "test collab crash tier=PASS " +
  "cargo-deny=PASS cargo-audit=PASS";

test("canonical CI verdict requires every mandatory gate step to report PASS", () => {
  assert.doesNotThrow(() => check(passVerdict));
  assert.throws(
    () =>
      check(
        passVerdict.replace("fixture drift=PASS", "fixture drift=SKIP"),
      ),
    /fixture drift/,
  );
  assert.throws(
    () =>
      check(
        passVerdict.replace("cargo-deny=PASS", "cargo-deny=SKIP"),
      ),
    /cargo-deny/,
  );
  // Two runs sharing one worktree produced PASS and FAIL for the same commit,
  // and neither log could say which tree it read. A verdict without this row
  // is from a gate that never checked; a FAIL here is a run whose HEAD moved
  // mid-way, so its rows straddle two commits.
  assert.throws(
    () => check(passVerdict.replace("tree provenance=PASS ", "")),
    /tree provenance/,
  );
  assert.throws(
    () =>
      check(
        passVerdict.replace("tree provenance=PASS", "tree provenance=FAIL"),
      ),
    /tree provenance/,
  );
  // Drop this row and the platform in the verdict line is Node's unverified
  // claim again — a cross-compiled run recorded as native evidence.
  assert.throws(
    () =>
      check(passVerdict.replace("native target=PASS ", "")),
    /native target/,
  );
  // The crash tier is compiled out of the plain workspace test run, so an
  // evidence line missing this row means the exactly-once tests never ran.
  assert.throws(
    () =>
      check(
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
      check(
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
  assert.throws(() => check(forged), /native target/);

  // The genuine row still satisfies the requirement beside the forged one.
  assert.doesNotThrow(() =>
    check(
      passVerdict.replace(
        "native target=PASS",
        "not-native target=PASS native target=PASS",
      ),
    ),
  );

  // Two rows for one step leave the step's result ambiguous, so neither wins.
  assert.throws(
    () =>
      check(
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
      check(
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
    () => check(forged),
    /verdict field reads `FAIL`/,
  );
});

test("an extra ` | ` is rejected, because the verdict is read by position", () => {
  // Reading the verdict from field 4 makes the field count load-bearing: a
  // sixth field shifts every later field, and the rows this line carries would
  // otherwise satisfy all nine required steps while the verdict being read
  // came from somewhere else.
  assert.throws(
    () => check(`${passVerdict} note=SKIP [a | b]`),
    /expected exactly 5/,
  );
});

test("a summary field that is not a list of rows is refused, not scanned", () => {
  // The row reader starts at the field's first character and every character
  // must belong to a row. Its guard for "this is not a row list at all" was
  // the one branch here nothing exercised, so deleting it changed no test.
  const [when, gate, plat, verdict] = passVerdict.split(" | ");
  assert.throws(
    () => check([when, gate, plat, verdict, "see the log above"].join(" | ")),
    /is not a list of `name=STATUS` rows/,
  );
});

test("a status ends at the row's end, not at a word boundary", () => {
  // A word boundary sits before `-` and `[` too, so both of these read as a
  // PASS while carrying something else.
  for (const forgery of ["native target=PASS-ignored", "native target=PASS[x]"]) {
    assert.throws(
      () =>
        check(
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
      () => check(passVerdict.replace("cargo-audit=PASS", forgery)),
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
    () => check(impostor),
    /step field reads `not-the-gate`/,
  );
});

test("the verdict must name the commit its gate examined", () => {
  // The `tree provenance` row says a check ran. It does not say which tree it
  // read — a producer that drops or mangles the stamp keeps a green row over
  // a verdict that names no commit, which is the decorative-row defect this
  // checker exists to refuse, one level up.
  assert.throws(
    () => check(passVerdict.replace(", head 1f47af31 clean, 11 reads", "")),
    /does not name the commit the run examined/,
  );
  // What a refused run stamps. The row could still read PASS in a forged or
  // regressed line; the stamp is what names the tree, so it is checked.
  assert.throws(
    () =>
      check(
        passVerdict.replace("head 1f47af31 clean, 11 reads", "head UNATTRIBUTABLE"),
      ),
    /does not name the commit the run examined/,
  );
  // Not a commit.
  assert.throws(
    () => check(passVerdict.replace("head 1f47af31", "head zzzzzzzz")),
    /does not name the commit the run examined/,
  );
  // A sha with no tree state does not say whether the commit describes what
  // ran, which is half the claim.
  assert.throws(
    () => check(passVerdict.replace("1f47af31 clean,", "1f47af31,")),
    /does not name the commit the run examined/,
  );
  // The read count is part of the claim, not decoration: a stamp without it
  // reads as though the tree had been watched for the whole run.
  assert.throws(
    () => check(passVerdict.replace(" clean, 11 reads)", " clean)")),
    /does not name the commit the run examined/,
  );
  // One reading observes no interval at all — there is nothing before it to
  // compare against.
  assert.throws(
    () => check(passVerdict.replace("11 reads", "1 reads")),
    /at least 2/,
  );
  // The stamp closes the field, where the producer writes it. Text after it
  // rewrites the claim it makes: `head 1f47af31 clean, then reset to 700f1cfc`
  // names two trees and stands behind neither.
  assert.throws(
    () =>
      check(
        passVerdict.replace(
          "head 1f47af31 clean, 11 reads)",
          "head 1f47af31 clean, 11 reads, then reset to 700f1cfc)",
        ),
      ),
    /does not name the commit the run examined/,
  );
  // The stamp answers from the platform field, not from anywhere in the line:
  // a step's reason quoting a stamp is not the gate naming its tree.
  assert.throws(
    () =>
      check(
        passVerdict
          .replace(", head 1f47af31 clean, 11 reads", "")
          .replace(
            "cargo-audit=PASS",
            "cargo-audit=PASS head 1f47af31 clean, 11 reads)",
          ),
      ),
    /does not name the commit the run examined/,
  );
  // Uncommitted work is recorded, not refused: the gate runs over a dirty
  // tree in the normal local loop, and the stamp says so.
  assert.doesNotThrow(() => check(passVerdict.replace("clean,", "dirty(2),")));
});

test("the verdict must name THIS checkout's commit, not any commit", () => {
  // A stamp's shape is not its value. `head deadbeef clean, 11 reads` parses
  // perfectly, and a stale log carrying it would approve a gate run over
  // whatever tree that commit was — which is the substitution the whole stamp
  // exists to prevent, one level up from the last round's finding.
  assert.throws(
    () =>
      requireCiPassVerdict(
        passVerdict.replace("head 1f47af31", "head deadbeef"),
        () => CHECKOUT_HEAD,
      ),
    /verdict examined `deadbeef` but this checkout is at `1f47af31`/,
  );
  // The producer writes 8 characters and `git rev-parse` answers with 40, so
  // the stamp is a prefix of the checkout's SHA — in that direction only.
  assert.doesNotThrow(() =>
    requireCiPassVerdict(passVerdict, () => CHECKOUT_HEAD),
  );
  assert.doesNotThrow(() =>
    requireCiPassVerdict(
      passVerdict.replace("head 1f47af31", `head ${CHECKOUT_HEAD}`),
      () => CHECKOUT_HEAD,
    ),
  );
  // A prefix of the stamp is not the stamp: an eight-character claim is not
  // answered by a checkout that agrees on seven.
  assert.throws(
    () =>
      requireCiPassVerdict(passVerdict, () => `1f47af39${CHECKOUT_HEAD.slice(8)}`),
    /verdict examined `1f47af31`/,
  );
  // No checkout, no verification. Falling through to acceptance here would
  // make the check optional for exactly the callers that cannot satisfy it.
  assert.throws(
    () => requireCiPassVerdict(passVerdict, () => null),
    /could not answer `git rev-parse HEAD`/,
  );
  // And a caller that supplies no resolver at all is refused rather than
  // silently skipping the commit check.
  assert.throws(
    () => requireCiPassVerdict(passVerdict),
    /needs a resolveHead\(\)/,
  );
});

// A frozen copy of a real run's verdict line used to live here, to prove the
// parser reads what the producer emits. It went stale twice in one PR — once
// per change to the producer — and a stale copy pins the past, not the
// contract. `scripts/rust-gate-artifact.test.mjs` now runs the real producer
// and feeds its evidence line to this checker, which cannot rot.

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

test("both gate filters select on .gitignore, which the gates now read", () => {
  // The tree-provenance row reads `git status`, so an ignore rule decides
  // what the gate can see at all: ignoring a path removes it from every
  // reading, and ignoring the wiring probe would disable
  // scripts/rust-gate-artifact.test.mjs without changing a line of it. A
  // .gitignore-only PR selecting neither job is a check whose preconditions
  // sit outside what the check can see — which is the defect class this whole
  // change is about.
  const filters = workflow.slice(
    workflow.indexOf("filters: |"),
    workflow.indexOf("\n  javascript:"),
  );
  const rustFilter = filters.slice(
    filters.indexOf("\n            rust:"),
    filters.indexOf("\n            js:"),
  );
  const jsFilter = filters.slice(filters.indexOf("\n            js:"));
  assert.match(rustFilter, /^ +- '\.gitignore'$/m);
  assert.match(jsFilter, /^ +- '\.gitignore'$/m);
  // Both slices must be real filter lists, or the assertions above pass by
  // reading the same text twice.
  assert.match(rustFilter, /- 'tools\/rust-engine-program\/\*\*'/);
  assert.match(jsFilter, /- 'scripts\/\*\*'/);
  assert.doesNotMatch(rustFilter, /- 'scripts\/\*\*'/);
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

// A run's readings: the tree before the first step, then after each step. A
// state carries the HEAD reflog as well as the commit, because a HEAD that
// moves and returns inside one step is the same at both ends and only the log
// shows it.
const A = {
  head: "1f47af31ed00",
  dirty: [],
  reflog: { present: true, count: 1, top: "1f47af31ed00" },
};
const B = {
  head: "700f1cfc3e00",
  dirty: [],
  reflog: { present: true, count: 2, top: "700f1cfc3e00" },
};
/** A reflog `n` entries further on, newest entry `top`. */
const logged = (n, top = A.head) => ({
  ...A,
  reflog: { present: true, count: A.reflog.count + n, top },
});
const readingsOf = (...states) =>
  states.map((state, at) => ({
    step: at === 0 ? "start" : `step ${at}`,
    state,
  }));

test("a run whose HEAD moved cannot claim either commit", () => {
  // The failure this row exists for: two runs shared one worktree, and a
  // `git checkout` moved the tree under the checks. Both logs looked like
  // verdicts; neither described a commit.
  const moved = classifyTreeProvenance([
    { step: "start", state: A },
    { step: "clippy -D warnings", state: B },
  ]);
  assert.equal(moved.status, "FAIL");
  assert.match(moved.reason, /HEAD moved during `clippy -D warnings`/);
  // Both commits are named: a reader must be able to see what it straddled.
  assert.match(moved.reason, /1f47af31/);
  assert.match(moved.reason, /700f1cfc/);
  // The stamp is the judgement's, not the opening reading's: a run that
  // straddled two commits must not print one of them beside `clean`.
  assert.equal(moved.stamp, "UNATTRIBUTABLE");

  assert.equal(classifyTreeProvenance(readingsOf(A, A)).status, "PASS");
});

test("a tree that changed and changed back is caught by the reading between", () => {
  // Endpoint comparison certifies an interval nothing observed: another
  // process checks out B, the gate's middle steps run against it, and the
  // tree is restored before the final read. The two ends agree perfectly and
  // describe a run that did not happen.
  const restored = classifyTreeProvenance([
    { step: "start", state: A },
    { step: "native target", state: A },
    { step: "build --workspace", state: B },
    { step: "test --workspace", state: A },
  ]);
  assert.equal(restored.status, "FAIL");
  // The step is named, because that is what a reader has to re-run.
  assert.match(restored.reason, /HEAD moved during `build --workspace`/);
  assert.equal(restored.stamp, "UNATTRIBUTABLE");

  // The same for an edit that is reverted: A, dirty, A.
  const edited = classifyTreeProvenance([
    { step: "start", state: A },
    { step: "fmt --check", state: { ...A, dirty: [" M a.rs"] } },
    { step: "clippy -D warnings", state: A },
  ]);
  assert.equal(edited.status, "FAIL");
  assert.match(edited.reason, /worktree changed during `fmt --check`/);
  assert.match(edited.reason, /a\.rs/);
  assert.equal(edited.stamp, "UNATTRIBUTABLE");

  // What the readings CANNOT see is stated in the stamp rather than assumed
  // away: a change made and undone inside one step leaves both its readings
  // identical, so the count is what the gate reports — how many readings
  // agreed, not that the tree was watched.
  const unobserved = classifyTreeProvenance(readingsOf(A, A, A));
  assert.equal(unobserved.status, "PASS");
  assert.equal(unobserved.stamp, "1f47af31 clean, 3 reads");
});

test("a worktree edited under the run is never stamped clean", () => {
  // The defect this row exists for, minus the `git checkout`: an agent edits
  // the shared tree while the gate runs. HEAD never moves, so a check that
  // compares only commits reports PASS and stamps `<sha> clean` over checks
  // that read two different trees.
  const appeared = classifyTreeProvenance([
    { step: "start", state: A },
    {
      step: "test --workspace",
      state: { ...A, dirty: [" M crates/engine/src/lib.rs"] },
    },
  ]);
  assert.equal(appeared.status, "FAIL");
  assert.match(appeared.reason, /worktree changed during `test --workspace`/);
  assert.match(appeared.reason, /crates\/engine\/src\/lib\.rs/);
  assert.equal(appeared.stamp, "UNATTRIBUTABLE");

  // Reverting an edit mid-run straddles two trees just as much as making one.
  const vanished = classifyTreeProvenance(
    readingsOf({ ...A, dirty: [" M crates/engine/src/lib.rs"] }, A),
  );
  assert.equal(vanished.status, "FAIL");
  assert.equal(vanished.stamp, "UNATTRIBUTABLE");

  // A staged path is a different entry from an unstaged one: `git add` under
  // the run changes the status code, not the path.
  assert.equal(
    classifyTreeProvenance(
      readingsOf({ ...A, dirty: [" M a.rs"] }, { ...A, dirty: ["M  a.rs"] }),
    ).status,
    "FAIL",
  );

  // Dirt that was already there and stayed there is the recorded case, not
  // the corrupted one.
  assert.equal(
    classifyTreeProvenance(
      readingsOf({ ...A, dirty: [" M a.rs"] }, { ...A, dirty: [" M a.rs"] }),
    ).status,
    "PASS",
  );
});

test("a run with fewer than two readings observed no interval", () => {
  // One reading has nothing before it to disagree with, so a run that took
  // one cannot claim its tree held for anything. Refusing beats reporting a
  // clean run nothing watched.
  const lonely = classifyTreeProvenance([{ step: "start", state: A }]);
  assert.equal(lonely.status, "FAIL");
  assert.match(lonely.reason, /took 1 tree readings/);
  assert.equal(lonely.stamp, "UNATTRIBUTABLE");
  assert.equal(classifyTreeProvenance([]).status, "FAIL");
  assert.equal(classifyTreeProvenance(undefined).status, "FAIL");
});

test("a tree git cannot resolve fails rather than reading as green", () => {
  const unknown = { head: null, dirty: null, reflog: null };
  assert.equal(classifyTreeProvenance(readingsOf(unknown, A)).status, "FAIL");
  assert.equal(classifyTreeProvenance(readingsOf(A, unknown)).status, "FAIL");

  // A reading with no commit fails for having no commit. Asserting only the
  // status let the worktree-status check answer for this one, which left the
  // commit check itself unpinned.
  const headless = { ...A, head: null };
  const noHead = classifyTreeProvenance(readingsOf(headless, A));
  assert.equal(noHead.status, "FAIL");
  assert.match(noHead.reason, /could not resolve HEAD/);
  assert.equal(noHead.stamp, "UNATTRIBUTABLE");
  assert.equal(formatTreeStamp(unknown, 2), "UNATTRIBUTABLE");
  assert.equal(formatTreeState(unknown), "UNATTRIBUTABLE");

  // A worktree status git did not answer is not an empty worktree status. A
  // run that reads `clean` off silence is inventing the fact it exists to
  // report.
  const unread = { ...A, dirty: null };
  const unreadable = classifyTreeProvenance(readingsOf(unread, A));
  assert.equal(unreadable.status, "FAIL");
  assert.match(unreadable.reason, /could not read the worktree status/);
  assert.equal(formatTreeStamp(unread, 2), "UNATTRIBUTABLE");
  assert.equal(classifyTreeProvenance(readingsOf(A, unread)).status, "FAIL");
  // A middle reading git could not answer is refused too: a run cannot skip
  // the interval it failed to observe.
  assert.equal(classifyTreeProvenance(readingsOf(A, unread, A)).status, "FAIL");

  // A HEAD reflog git did not answer is the same shape: the run cannot say
  // whether HEAD moved and came back while a step ran.
  const unlogged = { ...A, reflog: null };
  const unloggable = classifyTreeProvenance(readingsOf(unlogged, A));
  assert.equal(unloggable.status, "FAIL");
  assert.match(unloggable.reason, /could not read the HEAD reflog/);
  assert.equal(classifyTreeProvenance(readingsOf(A, unlogged)).status, "FAIL");
});

test("a dirty tree is recorded, not failed", () => {
  // Running the gate over uncommitted work is the normal local loop. Failing
  // it would get the check removed; recording it tells the reader the commit
  // does not describe everything that ran.
  const dirty = { ...A, dirty: [" M a.rs", " M b.rs", "?? c.rs"] };
  const recorded = classifyTreeProvenance(readingsOf(dirty, dirty, dirty));
  assert.equal(recorded.status, "PASS");
  assert.equal(recorded.stamp, "1f47af31 dirty(3), 3 reads");
  assert.equal(formatTreeState(dirty), "1f47af31 dirty(3)");
  assert.equal(formatTreeStamp(dirty, 11), "1f47af31 dirty(3), 11 reads");
  assert.equal(formatTreeState(A), "1f47af31 clean");
});

test("the tree state lists changed paths, and survives a silent git", () => {
  const asked = [];
  const answers = {
    "git rev-parse HEAD": "1f47af31ed00\n",
    "git status --porcelain --untracked-files=all": " M a.rs\n?? b.rs\n\n",
    "git rev-list --walk-reflogs --count HEAD": "2\n",
    "git reflog show --format=%H -n 1 HEAD": "1f47af31ed00\n",
  };
  const capture = (cmd) => {
    asked.push(cmd);
    return answers[cmd];
  };
  const found = () => true;
  readTreeState(capture, found);
  // `--untracked-files=all` is load-bearing, not decoration: without it git
  // collapses an untracked directory into one entry, `?? crates/newthing/`,
  // and any churn inside that subtree during the run leaves the entry string
  // identical. It also makes the recorded count a count of paths.
  assert.deepEqual(asked, [
    "git rev-parse HEAD",
    "git status --porcelain --untracked-files=all",
    // The commit alone cannot see a checkout that came back inside one step;
    // this checkout's HEAD log can, because git wrote both moves down while
    // `rev-parse` kept answering the same. It is read as a count and a newest
    // entry, never as the whole log: a full read grows without bound and stops
    // answering at about 25,000 entries.
    "git rev-list --walk-reflogs --count HEAD",
    "git reflog show --format=%H -n 1 HEAD",
  ]);
  // The entries are kept whole, status codes and all: the comparison that
  // catches an edit mid-run needs to tell ` M a.rs` from `M  a.rs`.
  assert.deepEqual(readTreeState(capture, found), {
    head: "1f47af31ed00",
    dirty: [" M a.rs", "?? b.rs"],
    reflog: { present: true, count: 2, top: "1f47af31ed00" },
  });
  // A repo that cannot answer must not read as a clean tree at an unknown
  // commit — that is the shape of evidence with no subject.
  assert.deepEqual(readTreeState(() => null, found), {
    head: null,
    dirty: null,
    reflog: null,
  });
  // rev-parse answered, the rest did not. Half an answer is not a clean tree.
  assert.deepEqual(
    readTreeState(
      (cmd) => (cmd === "git rev-parse HEAD" ? "1f47af31\n" : null),
      found,
    ),
    { head: "1f47af31", dirty: null, reflog: null },
  );

  // The log file decides whether there is a HEAD log to read. When it is
  // missing, the counts git offers are the checked-out branch's, and no part
  // of that answer may reach the state.
  const missing = readTreeState(capture, () => false);
  assert.deepEqual(missing.reflog, { present: false, count: 0, top: null });

  // And a log whose path git could not resolve at all is unread, not absent.
  assert.equal(readTreeState(capture, () => null).reflog, null);

  // A count that is not a number is not a count.
  assert.equal(
    readTreeState(
      (cmd) =>
        cmd === "git rev-list --walk-reflogs --count HEAD"
          ? "not-a-number\n"
          : answers[cmd],
      found,
    ).reflog,
    null,
  );
});

/**
 * A throwaway repository with three commits, read the way the gate reads its
 * own: the HEAD log path resolved once, its existence checked per reading.
 */
function scratchRepo(detached) {
  const repo = mkdtempSync(join(tmpdir(), "dohc-reflog-"));
  const git = (...args) => {
    const run = spawnSync("git", args, { cwd: repo, encoding: "utf8" });
    return (run.stdout ?? "").trim();
  };
  const capture = (cmd) => {
    const run = spawnSync(cmd, { cwd: repo, shell: true, encoding: "utf8" });
    return run.error || run.status !== 0 ? null : run.stdout;
  };
  git("init", "-q", "-b", "main");
  git("config", "user.email", "gate@dohc.ai");
  git("config", "user.name", "gate");
  for (const body of ["one", "two", "three"]) {
    writeFileSync(join(repo, "a.txt"), `${body}\n`);
    git("add", "a.txt");
    git("commit", "-qm", body);
  }
  if (detached) git("checkout", "-q", "--detach", "HEAD");

  const logPath = capture("git rev-parse --git-path logs/HEAD");
  const hasHeadLog = () =>
    logPath === null ? null : existsSync(resolve(repo, logPath.trim()));
  return {
    repo,
    git,
    capture,
    headLog: resolve(repo, (logPath ?? "").trim()),
    read: () => readTreeState(capture, hasHeadLog),
  };
}

test("the HEAD log is read from this checkout, never through git's fallback", () => {
  // `HEAD` is not a reflog name git looks up literally. With `logs/HEAD` gone,
  // `git reflog show HEAD` answers from the checked-out branch's log — and a
  // checkout away and back does not touch that log. This runs the exact
  // scenario against a real repository: the fallback reads IDENTICAL across
  // the switch, which is why the reading may not trust it.
  const { repo, git, capture, headLog, read } = scratchRepo(false);
  try {
    const first = git("rev-parse", "HEAD~2");

    // A checkout with a branch log but no HEAD log of its own.
    rmSync(headLog, { force: true });
    assert.equal(existsSync(join(repo, ".git", "logs", "refs", "heads", "main")), true);

    // Where `git reflog show HEAD` gets its answer with no HEAD log: the
    // branch's log, to the byte.
    const branchLog = () => capture("git reflog show --format=%H refs/heads/main");
    assert.equal(capture("git reflog show --format=%H HEAD"), branchLog());

    const wasBranchLog = branchLog();
    const before = read();
    git("checkout", "-q", first);
    git("checkout", "-q", "main");
    const after = read();

    // And why that answer is worthless here: the branch never moved, so the
    // log the fallback reads is the same on both sides of a switch that
    // happened. HEAD reads the same too.
    assert.equal(branchLog(), wasBranchLog);
    assert.equal(before.head, after.head);

    // What the reading does instead: no HEAD log, so the run is refused rather
    // than stamped over a switch it could not see.
    assert.deepEqual(before.reflog, { present: false, count: 0, top: null });
    const refused = classifyTreeProvenance([
      { step: "start", state: before },
      { step: "test --workspace", state: after },
    ]);
    assert.equal(refused.status, "FAIL");
    assert.match(refused.reason, /keeps no HEAD reflog/);
    assert.equal(refused.stamp, "UNATTRIBUTABLE");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

for (const detached of [false, true]) {
  const state = detached ? "a detached" : "an attached";
  test(`the refusal's recovery gives ${state} HEAD a log, and that log sees a move`, () => {
    // Two things are only true if they are checked in BOTH states. A HEAD
    // rewritten with the value it already holds writes a reflog entry when
    // HEAD is symbolic and nothing at all when it is detached — so an
    // instruction and a probe built on it work on a branch and quietly do
    // nothing during a bisect or a CI checkout of a sha. The recovery is run
    // here exactly as the refusal prints it.
    const { repo, git, capture, headLog, read } = scratchRepo(detached);
    try {
      const head = git("rev-parse", "HEAD");
      const symbolic = git("symbolic-ref", "-q", "HEAD");
      git("config", "core.logAllRefUpdates", "false");
      rmSync(headLog, { force: true });

      const before = read();
      assert.deepEqual(before.reflog, { present: false, count: 0, top: null });
      const refused = classifyTreeProvenance(readingsOf(before, before));
      assert.equal(refused.status, "FAIL");
      // Every command the reader is told to run is in the refusal, in order.
      for (const command of HEAD_REFLOG_RECOVERY) {
        assert.ok(
          refused.reason.includes(command),
          `the refusal must name \`${command}\`, got: ${refused.reason}`,
        );
      }

      for (const command of HEAD_REFLOG_RECOVERY) {
        assert.notEqual(capture(command), null, `\`${command}\` must run here`);
      }

      // The log exists now, and the checkout is where it was: same commit,
      // same branch or none, same worktree.
      const seeded = read();
      assert.equal(seeded.reflog.present, true);
      assert.equal(git("rev-parse", "HEAD"), head);
      assert.equal(git("symbolic-ref", "-q", "HEAD"), symbolic);
      assert.deepEqual(seeded.dirty, []);
      assert.equal(classifyTreeProvenance(readingsOf(seeded, seeded)).status, "PASS");

      // And the seeded log does the job it was seeded for: HEAD moves away and
      // back inside a step, both readings name one commit, and the run is
      // refused anyway.
      git("update-ref", "-m", "away", "HEAD", `${head}~1`);
      git("update-ref", "-m", "back", "HEAD", head);
      const moved = read();
      assert.equal(moved.head, seeded.head);
      const caught = classifyTreeProvenance([
        { step: "start", state: seeded },
        { step: "test --workspace", state: moved },
      ]);
      assert.equal(caught.status, "FAIL");
      assert.match(caught.reason, /HEAD was updated 2 times during `test --workspace`/);
      assert.equal(caught.stamp, "UNATTRIBUTABLE");
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
}

test("a HEAD that moved and came back inside one step is refused", () => {
  // The residual the boundary readings cannot reach: another run checks out a
  // second tree and restores it before `cargo test --workspace` returns. Both
  // readings around that step name the same commit, their worktree status is
  // identical, and the step ran against something else. Git wrote both moves
  // into the HEAD reflog, so a reading that carries the log sees what the
  // commit cannot show.
  const returned = classifyTreeProvenance([
    { step: "start", state: A },
    { step: "build --workspace", state: A },
    { step: "test --workspace", state: logged(2) },
  ]);
  assert.equal(returned.status, "FAIL");
  assert.match(returned.reason, /HEAD was updated 2 times/);
  assert.match(returned.reason, /during `test --workspace`/);
  // The commit both readings agree on is named, and the stamp is the
  // judgement's — never the reading's.
  assert.match(returned.reason, /1f47af31/);
  assert.equal(returned.stamp, "UNATTRIBUTABLE");

  // One move is the same defect, and reads as one.
  const once = classifyTreeProvenance(readingsOf(A, logged(1)));
  assert.equal(once.status, "FAIL");
  assert.match(once.reason, /HEAD was updated 1 time /);

  // A log that stayed put across every step is the ordinary case, and passes.
  assert.equal(classifyTreeProvenance(readingsOf(A, A, A)).status, "PASS");
});

test("a HEAD reflog that is not the one before it cannot say what HEAD did", () => {
  // `git gc` expires reflog entries, so a later reading can be shorter than
  // the one before it. Nothing here can tell an expiry from a rewrite, so the
  // run says that rather than reading it as HEAD holding still.
  const pruned = classifyTreeProvenance(readingsOf(logged(2), A));
  assert.equal(pruned.status, "FAIL");
  assert.match(pruned.reason, /HEAD reflog was rewritten during `step 1`/);
  assert.match(pruned.reason, /3 entries then 1/);
  assert.equal(pruned.stamp, "UNATTRIBUTABLE");

  // Same count, a different newest entry: the log was replaced, not extended.
  assert.match(
    classifyTreeProvenance(readingsOf(A, logged(0, B.head))).reason,
    /was rewritten/,
  );
});

test("a checkout that keeps no HEAD reflog is refused, not passed", () => {
  // `core.logAllRefUpdates=false`, or a removed `logs/HEAD`. Git still answers
  // `git reflog show HEAD` there — from the checked-out branch's log — and
  // that log does not move when HEAD is checked out elsewhere and back, so the
  // comparison would agree with itself across the switch it exists to catch.
  const unlogged = { ...A, reflog: { present: false, count: 0, top: null } };
  const refused = classifyTreeProvenance(readingsOf(unlogged, unlogged));
  assert.equal(refused.status, "FAIL");
  assert.match(refused.reason, /keeps no HEAD reflog/);
  assert.equal(refused.stamp, "UNATTRIBUTABLE");
  // A reading with no log of its own is never printed as a clean tree either.
  // The tests above it pass on the stamp the JUDGEMENT returns; this is the
  // line the gate prints before its first step, from the reading itself.
  assert.equal(formatTreeState(unlogged), "UNATTRIBUTABLE");
  assert.equal(formatTreeStamp(unlogged, 10), "UNATTRIBUTABLE");
  assert.equal(formatTreeState({ ...A, reflog: null }), "UNATTRIBUTABLE");
});
