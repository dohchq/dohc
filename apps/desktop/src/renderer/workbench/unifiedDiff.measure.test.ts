// Measurement harness behind the history-diff work bound (#516).
//
// It is not part of the normal suite: the numbers are wall-clock and
// machine-specific, so running them on every `pnpm test` would make the gate
// flaky. Run it deliberately to re-measure the bound:
//
//   DOHC_MEASURE_DIFF=1 pnpm --filter @dohc/desktop exec vitest run unifiedDiff.measure
//
// It prints one row per scenario: the estimated comparison work (the same
// estimator computeTextDiff uses to choose LCS vs the contiguous fallback) and
// the wall-clock cost of one full pass: diff the bodies, then build the lines
// the page draws.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, it } from "vitest";
import {
  HISTORY_DIFF_WORK_LIMIT,
  buildUnifiedDiffLines,
  computeTextDiff,
  diffWorkEstimate,
  splitDiffLines,
} from "./unifiedDiff";

const repoRoot = fileURLToPath(new URL("../../../../../", import.meta.url));

function readRepoDoc(relativePath: string): string {
  return readFileSync(repoRoot + relativePath, "utf8");
}

// Change one line in ten thousand characters, the way a small real edit lands.
function editEveryNthLine(text: string, every: number): string {
  return splitDiffLines(text)
    .map((line, index) => (index % every === 0 ? line + " (edited)" : line))
    .join("\n");
}

// A body of `lines` lines of `lineChars` characters each, where every line
// shares a long common prefix with every other line. This is the worst input
// for the LCS inner loop: each cell's string compare must walk almost the
// whole line before it can decide the lines differ.
function longSimilarLines(lines: number, lineChars: number): string {
  const filler = "x".repeat(Math.max(0, lineChars - 12));
  const out: string[] = [];
  for (let index = 0; index < lines; index += 1) {
    out.push(filler + String(index).padStart(12, "0"));
  }
  return out.join("\n") + "\n";
}

type Row = {
  scenario: string;
  bytes: number;
  lines: number;
  work: number;
  path: "lcs" | "fallback";
  renderMs: number;
};

function measure(scenario: string, before: string, after: string): Row {
  const beforeLines = splitDiffLines(before);
  const afterLines = splitDiffLines(after);
  const work = diffWorkEstimate(beforeLines, afterLines);
  // One render pass: diff the bodies, then build the lines the page draws.
  const started = performance.now();
  const diff = computeTextDiff(before, after, 800);
  buildUnifiedDiffLines(diff);
  const renderMs = performance.now() - started;
  return {
    scenario,
    bytes: before.length + after.length,
    lines: beforeLines.length + afterLines.length,
    work,
    path: diff.degraded ? "fallback" : "lcs",
    renderMs,
  };
}

function formatRows(rows: Row[]): string {
  const header = ["scenario", "bytes", "lines", "work", "path", "render ms"];
  const body = rows.map((row) => [
    row.scenario,
    row.bytes.toLocaleString("en-US"),
    row.lines.toLocaleString("en-US"),
    row.work.toLocaleString("en-US"),
    row.path,
    row.renderMs.toFixed(1),
  ]);
  const widths = header.map((_, column) =>
    Math.max(header[column].length, ...body.map((row) => row[column].length)),
  );
  const line = (cells: string[]) =>
    cells.map((cell, column) => cell.padEnd(widths[column])).join("  ");
  return [line(header), line(widths.map((width) => "-".repeat(width))), ...body.map(line)].join(
    "\n",
  );
}

const measuring = process.env.DOHC_MEASURE_DIFF === "1";

describe.skipIf(!measuring)("history diff work measurement", () => {
  it("reports the cost of one render pass across representative bodies", () => {
    const rows: Row[] = [];

    // Healthy work: real repository documents, small edits.
    for (const doc of [
      "AGENTS.md",
      "README.md",
      ".agents/skills/dohc-interface/SKILL.md",
      ".agents/skills/dohc-writing/SKILL.md",
    ]) {
      const before = readRepoDoc(doc);
      rows.push(measure(doc, before, editEveryNthLine(before, 50)));
    }

    // Healthy work: one long unwrapped paragraph per line, the shape a pasted
    // or generated body takes.
    for (const [lines, lineChars] of [
      [200, 500],
      [499, 500],
      [499, 2_000],
    ] as const) {
      const before = longSimilarLines(lines, lineChars);
      rows.push(
        measure(`${lines} x ${lineChars} chars`, before, editEveryNthLine(before, 50)),
      );
    }

    // The reported failures: line counts parked at the cell ceiling with huge
    // lines, and bodies whose line COUNT is the problem.
    for (const [lines, lineChars, label] of [
      [499, 3_990, "at the bound (largest body the limit admits)"],
      [499, 4_008, "cell ceiling, 2,000,000 chars"],
      [499, 21_014, "cell ceiling, 10 MiB"],
      [250_000, 42, "10 MiB, newline-heavy"],
      [1_000_000, 10, "1,000,000 short lines"],
    ] as const) {
      const before = longSimilarLines(lines, lineChars);
      rows.push(measure(label, before, editEveryNthLine(before, 50)));
    }

    console.log(
      `\nHISTORY_DIFF_WORK_LIMIT = ${HISTORY_DIFF_WORK_LIMIT.toLocaleString("en-US")}\n` +
        formatRows(rows) +
        "\n",
    );
  }, 600_000);

  // The ladder the limit is calibrated from. Every row stays UNDER the limit,
  // so every row runs the real line-by-line diff and can be reproduced here.
  // The last row is the largest body the limit admits: its time is the claim
  // the limit rests on, not the throughput, which falls off below the bound as
  // the fixed per-cell cost takes over.
  it("reports the cost ladder the bound is calibrated from", () => {
    const rows: Row[] = [];
    for (const lineChars of [100, 250, 500, 1_000, 2_000, 3_990]) {
      const before = longSimilarLines(499, lineChars);
      rows.push(
        measure(`499 x ${lineChars} chars`, before, editEveryNthLine(before, 50)),
      );
    }
    const rates = rows.map(
      (row) => `${row.scenario}: ${(row.work / row.renderMs / 1e6).toFixed(1)} M units/ms`,
    );
    console.log(`\n${formatRows(rows)}\n\n${rates.join("\n")}\n`);
    for (const row of rows) {
      if (row.path !== "lcs") throw new Error(`${row.scenario} did not run the LCS`);
    }
  }, 600_000);
});
