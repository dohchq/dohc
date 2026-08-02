#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const requiredSteps = [
  // Without this row the platform in the verdict line is Node's unverified
  // claim, which is what the line was before the gate asked rustc.
  "native target",
  "fixture drift",
  "fmt --check",
  "clippy -D warnings",
  "build --workspace",
  "test --workspace",
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

export function requireCiPassVerdict(log) {
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

async function main() {
  const [logPath] = process.argv.slice(2);
  if (!logPath) {
    throw new Error("usage: require-ci-pass-verdict.mjs <gate-log>");
  }
  requireCiPassVerdict(await readFile(logPath, "utf8"));
  console.log("canonical CI verdict verified: every required step reported PASS");
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`::error::${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
