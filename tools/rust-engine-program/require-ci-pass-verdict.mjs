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

// One step row of the evidence line: `name=STATUS`, plus `[reason]` when the
// status is not PASS. A name can hold spaces and hyphens (`clippy -D
// warnings`) but never an `=`, so a row's name is everything between the end
// of the row before it and its own `=`. Reading the line by substring instead
// let a row named `not-native target=PASS` answer for `native target`.
const STEP_ROW = /(?<name>[^=\s](?:[^=]*[^=\s])?)=(?<status>PASS|FAIL|SKIP)\b/g;

/** `name -> [status, ...]`, one entry per row the summary field carries. */
function parseStepRows(summary) {
  const rows = new Map();
  for (const { groups } of summary.matchAll(STEP_ROW)) {
    const statuses = rows.get(groups.name) ?? [];
    statuses.push(groups.status);
    rows.set(groups.name, statuses);
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

  const verdict = verdictLines[0];
  if (!verdict.includes("| PASS |")) {
    throw new Error("run-rust-checks did not report PASS");
  }

  // Field 5 onward is the step summary. A reason's free-form text can swallow
  // the row that follows it, but only a FAIL or SKIP row carries a reason and
  // such a line is already rejected above.
  const fields = verdict.split(" | ");
  if (fields.length < 5) {
    throw new Error(
      `verdict line has ${fields.length} " | "-separated fields, expected at least 5 (stamp, step, platform, verdict, summary)`,
    );
  }
  const rows = parseStepRows(fields.slice(4).join(" | "));

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
