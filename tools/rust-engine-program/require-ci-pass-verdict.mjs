#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const requiredSteps = [
  "fixture drift",
  "fmt --check",
  "clippy -D warnings",
  "build --workspace",
  "test --workspace",
  "cargo-deny",
  // cargo-audit was deliberately absent from this list because CI did not
  // install the tool, so the gate probed for it and reported SKIP -- which
  // meant every PR showed "cargo-audit=SKIP" beside a row of PASSes and no
  // advisory scan ever ran. The workflow now installs a pinned cargo-audit,
  // so a SKIP here is a regression in the install, not an honest absence,
  // and must fail the gate rather than read as green.
  "cargo-audit",
];

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

  for (const step of requiredSteps) {
    if (!verdict.includes(`${step}=PASS`)) {
      throw new Error(`required CI gate step did not report PASS: ${step}`);
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
