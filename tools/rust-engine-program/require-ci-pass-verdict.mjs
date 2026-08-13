#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const requiredSteps = [
  // Without this row the log cannot say which tree produced it, and a run
  // whose HEAD moved mid-way reports FAIL here rather than a green verdict
  // over two commits. Requiring the row is what makes the provenance
  // load-bearing: a log from a gate that never checked would otherwise read
  // exactly as green as one that did.
  "tree provenance",
  // Without this row the platform in the verdict line is Node's unverified
  // claim, which is what the line was before the gate asked rustc.
  "native target",
  "fixture drift",
  "fmt --check",
  "clippy -D warnings",
  "build --workspace",
  "test --workspace",
  // The workspace test run is nextest, which runs no doctests by design.
  // Without this row a runner swap silently drops every doctest the
  // workspace has, and the verdict still reads green.
  "doctests",
  // The collab crash tier only compiles under `--features fault-injection`,
  // so a verdict line without this row proves the exactly-once tests never
  // ran — exactly the omission that let them go unexecuted for a month.
  "test collab crash tier",
  "cargo-deny",
  // cargo-audit was deliberately absent from this list because CI did not
  // install the tool, so the gate probed for it and reported SKIP -- which
  // meant every PR showed "cargo-audit=SKIP" beside a row of PASSes and no
  // advisory scan ever ran. The workflow now installs a pinned cargo-audit,
  // so a SKIP here is a regression in the install, not an honest absence,
  // and must fail the gate rather than read as green.
  "cargo-audit",
];

// The summary field is a list of rows joined by one space and nothing else. A
// row is `name=STATUS`. A name holds spaces and hyphens (`clippy -D warnings`)
// but never an `=`.
//
// The gate writes a free-form `[reason]` beside a step, but only beside one
// that failed the run — so only a FAIL verdict carries reasons, and this
// checker reads a summary only after the verdict field reads PASS. The
// summaries it parses hold no reason text, which is why it refuses to read
// any: reason text is the one place a forged row can hide.
//
// The list is read in order, from its first character, and every character
// must belong to a row. Scanning the field for anything shaped like a row is
// what let text that is not a row answer for a required step: `not-native
// target=PASS` for `native target`, `native target=PASS-ignored` for a whole
// status, and a `cargo-audit=PASS` written inside another row's reason for a
// step that never ran.
const ROW_HEAD = /(?<name>[^=]+)=(?<status>PASS|FAIL|SKIP)/y;

// The gate stamps the commit it examined at the end of the platform field:
// `win32/x64 (rust cfg x86_64/windows/msvc, head 38050894 clean, 11 reads)`.
// It is anchored to the field's end, where the producer writes it, so text
// that merely looks like a stamp elsewhere in the field cannot answer for it.
//
// The read count is part of the stamp because it is part of the claim: the
// gate reads the tree at every step boundary and reports how many readings
// agreed. It does not watch the tree between them, and a stamp that omitted
// the count would read as if it had.
const HEAD_STAMP =
  / head (?<sha>[0-9a-f]{8,40}) (?:clean|dirty\(\d+\)), (?<reads>\d+) reads\)$/;

/** `name -> [status, ...]`, one entry per row, or a throw if this is no list. */
function parseStepRows(summary) {
  const rows = new Map();
  const from = (at) => `\`${summary.slice(at, at + 40)}\``;
  let at = 0;

  while (at < summary.length) {
    ROW_HEAD.lastIndex = at;
    const head = ROW_HEAD.exec(summary);
    if (!head) {
      throw new Error(
        `step summary is not a list of \`name=STATUS\` rows: nothing at offset ${at} starts one, ${from(at)}`,
      );
    }
    const { name, status } = head.groups;
    at = ROW_HEAD.lastIndex;

    // A reason is free-form text, so no rule can say where it ends without the
    // writer's help: `other=SKIP[x] cargo-audit=PASS z=SKIP[y]]` closes at
    // whichever `]` the reader picks, and one of those readings mints a
    // `cargo-audit=PASS` row out of the reason's own text.
    if (summary[at] === "[") {
      throw new Error(
        `step row \`${name}=${status}\` carries a \`[reason]\`, which only a failed run writes; a PASS verdict's summary is \`name=STATUS\` rows and nothing else`,
      );
    }

    // The row ends here or it is not that row: `native target=PASS-ignored`
    // is not `native target=PASS`.
    if (at < summary.length && summary[at] !== " ") {
      throw new Error(
        `step row \`${name}=${status}\` must end at a space or the end of the summary, found ${from(at)}`,
      );
    }
    at += 1;

    const statuses = rows.get(name) ?? [];
    statuses.push(status);
    rows.set(name, statuses);
  }
  return rows;
}

/**
 * `resolveHead` returns the 40-character SHA of the checkout this verdict is
 * being accepted for, or null when there is no checkout to ask. It is
 * injected rather than read here so the rule stays testable without a
 * repository — and it is REQUIRED, because a verifier that falls through to
 * acceptance when it cannot resolve the head is the shape of check this file
 * exists to refuse.
 */
export function requireCiPassVerdict(log, resolveHead) {
  if (typeof resolveHead !== "function") {
    throw new Error(
      "requireCiPassVerdict needs a resolveHead() to check the stamped commit against; a verdict cannot be verified without the commit it is being accepted for",
    );
  }
  const verdictLines = log
    .split(/\r?\n/)
    .filter((line) => line.includes("| run-rust-checks |"));

  if (verdictLines.length !== 1) {
    throw new Error(
      `expected exactly one run-rust-checks verdict line, found ${verdictLines.length}`,
    );
  }

  // `- <stamp> | run-rust-checks | <platform> | <verdict> | <step summary>`.
  // A line this checker can accept has exactly these five fields: only a
  // step's free-form reason can carry a second ` | `, and only a FAIL or SKIP
  // row carries a reason at all.
  const fields = verdictLines[0].split(" | ");
  if (fields.length !== 5) {
    throw new Error(
      `verdict line has ${fields.length} " | "-separated fields, expected exactly 5 (stamp, step, platform, verdict, summary)`,
    );
  }
  // The line was found by its gate name, which must be that name's own field:
  // `- stamp | not-the-gate | run-rust-checks | PASS | ...` carries the name
  // where the platform goes and answers every check that follows.
  if (fields[1] !== "run-rust-checks") {
    throw new Error(
      `verdict line's step field reads \`${fields[1]}\`, expected \`run-rust-checks\``,
    );
  }
  // The verdict is that field, not text found anywhere in the line: a reason
  // can quote `| PASS |` while the run failed.
  if (fields[3] !== "PASS") {
    throw new Error(
      `run-rust-checks did not report PASS, its verdict field reads \`${fields[3]}\``,
    );
  }

  // The platform field ends with the commit the run examined. Requiring the
  // `tree provenance` row alone does not require the commit: a producer that
  // dropped or mangled the stamp still reports the row, and the verdict names
  // no tree at all — the same decorative-row defect one level up.
  //
  // `dirty(N)` is accepted for the reason the gate records rather than fails
  // it: the local loop runs over uncommitted work, and the stamp says so. What
  // is refused is a stamp that names no commit, such as the `UNATTRIBUTABLE`
  // a refused run writes.
  const stamp = HEAD_STAMP.exec(fields[2]);
  if (!stamp) {
    throw new Error(
      `verdict line's platform field does not name the commit the run examined: expected it to end with \`head <sha> clean, <n> reads\` or \`head <sha> dirty(N), <n> reads\`, found \`${fields[2]}\``,
    );
  }
  // Two readings is the fewest that observes an interval at all; one reading
  // proves nothing about the run that followed it.
  const reads = Number(stamp.groups.reads);
  if (reads < 2) {
    throw new Error(
      `verdict line claims ${reads} tree reading(s), and a run needs at least 2 for any interval to have been observed`,
    );
  }

  // A stamp's SHAPE is not its VALUE. `head deadbeef clean, 11 reads` parses
  // perfectly while naming a commit this checkout has never been at, so a
  // stale or hand-edited log would approve evidence for the wrong head —
  // precisely the substitution the stamp exists to prevent.
  //
  // The gate writes a short SHA and `git rev-parse` answers with 40, so the
  // stamp is compared as a PREFIX of the checkout's head, in that direction
  // only: the checkout's SHA is the full one.
  const head = resolveHead();
  if (!head) {
    throw new Error(
      `verdict names \`${stamp.groups.sha}\` but this checkout could not answer \`git rev-parse HEAD\`; a verdict is a claim about a commit and cannot be accepted where that commit cannot be identified`,
    );
  }
  if (!head.startsWith(stamp.groups.sha)) {
    throw new Error(
      `verdict examined \`${stamp.groups.sha}\` but this checkout is at \`${head.slice(0, stamp.groups.sha.length)}\` (${head}); a gate verdict is evidence about the tree it read, not about this one`,
    );
  }

  const rows = parseStepRows(fields[4]);

  for (const step of requiredSteps) {
    const statuses = rows.get(step) ?? [];
    if (statuses.length !== 1) {
      throw new Error(
        `verdict line carries ${statuses.length} rows for required CI gate step \`${step}\`, expected exactly 1`,
      );
    }
    if (statuses[0] !== "PASS") {
      throw new Error(
        `required CI gate step did not report PASS: ${step}=${statuses[0]}`,
      );
    }
  }
}

// The checkout this verdict is being accepted for. A git that cannot answer
// returns null, which refuses the verdict rather than skipping the check.
function resolveCheckoutHead() {
  const res = spawnSync("git rev-parse HEAD", {
    cwd: resolve(dirname(fileURLToPath(import.meta.url)), "../.."),
    shell: true,
    encoding: "utf8",
  });
  if (res.error || res.status !== 0) return null;
  const head = res.stdout.trim();
  return /^[0-9a-f]{40}$/.test(head) ? head : null;
}

async function main() {
  const [logPath] = process.argv.slice(2);
  if (!logPath) {
    throw new Error("usage: require-ci-pass-verdict.mjs <gate-log>");
  }
  requireCiPassVerdict(await readFile(logPath, "utf8"), resolveCheckoutHead);
  console.log(
    "canonical CI verdict verified: every required step reported PASS, on this checkout's commit",
  );
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`::error::${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
