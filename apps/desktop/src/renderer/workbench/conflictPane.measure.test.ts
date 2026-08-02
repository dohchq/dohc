// Measurement harness behind the conflict-pane preview window (#536), the
// sibling of unifiedDiff.measure.test.ts.
//
// It is not part of the normal suite: it walks the whole repository and one of
// its numbers is wall-clock, so running it on every `pnpm test` would be slow
// and flaky. Run it deliberately to re-measure the window:
//
//   DOHC_MEASURE_CONFLICT=1 pnpm --filter @dohc/desktop exec vitest run conflictPane.measure
//
// WHAT IT MEASURES, and what it cannot. A conflict side goes into one `<pre>`
// with `whitespace-pre-wrap break-words`, so the browser lays out every
// character before it knows the scroll height. That layout is Chromium's and
// Node cannot time it. So the window is derived the other way round: from the
// SIZE of representative healthy documents, set above them, so a healthy
// conflict shows whole and never asks for "Show more". The second measurement
// here only proves the guard itself is cheap — that slicing the window off a
// 10 MiB side costs nothing next to painting it.

import { execFileSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, it } from "vitest";
import {
  CONFLICT_PREVIEW_MAX_CHARS,
  CONFLICT_PREVIEW_MAX_LINES,
  conflictPreview,
} from "./conflictPane";

const repoRoot = fileURLToPath(new URL("../../../../../", import.meta.url));

// The repository's own tracked text, as the stand-in for the documents a
// workspace holds. dohc has no user corpus yet; this is the closest honest
// sample of hand-written and generated text files we own.
function trackedTextFiles(): string[] {
  const listed = execFileSync(
    "git",
    ["ls-files", "--", "*.md", "*.ts", "*.tsx", "*.rs"],
    { cwd: repoRoot, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  );
  return listed
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.includes("node_modules"));
}

function percentile(values: number[], quantile: number): number {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * quantile))];
}

function describeSpread(label: string, values: number[]): string {
  return (
    `${label.padEnd(14)} p50 ${percentile(values, 0.5).toLocaleString("en-US")}` +
    `  p90 ${percentile(values, 0.9).toLocaleString("en-US")}` +
    `  p99 ${percentile(values, 0.99).toLocaleString("en-US")}` +
    `  max ${Math.max(...values).toLocaleString("en-US")}`
  );
}

const measuring = process.env.DOHC_MEASURE_CONFLICT === "1";

describe.skipIf(!measuring)("conflict preview window measurement", () => {
  it("reports the size of representative healthy documents", () => {
    const lines: number[] = [];
    const chars: number[] = [];
    const longestLine: number[] = [];
    let overCharWindow = 0;
    let overLineWindow = 0;
    // Files holding one line wider than the whole character window. This
    // corpus has none — its longest line is about 19,000 characters — so the
    // mid-line cut, and the "Show more" stall that lived in it (#536 review),
    // were structurally invisible here. The unit tests carry that shape
    // instead; a corpus of hand-written source cannot.
    let overLongestLine = 0;

    for (const path of trackedTextFiles()) {
      let text: string;
      try {
        if (!statSync(repoRoot + path).isFile()) continue;
        text = readFileSync(repoRoot + path, "utf8");
      } catch {
        continue;
      }
      const fileLines = text.split("\n");
      lines.push(fileLines.length);
      chars.push(text.length);
      const widestLine = fileLines.reduce((widest, line) => Math.max(widest, line.length), 0);
      longestLine.push(widestLine);
      if (widestLine > CONFLICT_PREVIEW_MAX_CHARS) overLongestLine += 1;
      if (text.length > CONFLICT_PREVIEW_MAX_CHARS) overCharWindow += 1;
      if (fileLines.length > CONFLICT_PREVIEW_MAX_LINES) overLineWindow += 1;
    }

    console.log(
      `\nCONFLICT_PREVIEW_MAX_CHARS = ${CONFLICT_PREVIEW_MAX_CHARS.toLocaleString("en-US")}` +
        `\nCONFLICT_PREVIEW_MAX_LINES = ${CONFLICT_PREVIEW_MAX_LINES.toLocaleString("en-US")}` +
        `\n\n${lines.length.toLocaleString("en-US")} tracked text files\n` +
        `${describeSpread("lines", lines)}\n` +
        `${describeSpread("chars", chars)}\n` +
        `${describeSpread("longest line", longestLine)}\n\n` +
        `over the character window: ${overCharWindow} ` +
        `(${((overCharWindow / lines.length) * 100).toFixed(1)}%)\n` +
        `over the line window:      ${overLineWindow} ` +
        `(${((overLineWindow / lines.length) * 100).toFixed(1)}%)\n` +
        `holding a line wider than the character window: ${overLongestLine}\n`,
    );
  }, 600_000);

  it("reports the cost of taking one preview window off a side", () => {
    const shapes: [string, string][] = [
      ["10 MiB, newline-heavy", `${"x".repeat(41)}\n`.repeat(250_000)],
      ["10 MiB, one line", "x".repeat(10 * 1024 * 1024)],
      ["10 MiB, 500-char lines", `${"x".repeat(500)}\n`.repeat(20_000)],
      ["200 KB document", `${"x".repeat(80)}\n`.repeat(2_500)],
    ];
    const rows = shapes.map(([label, text]) => {
      const started = performance.now();
      const preview = conflictPreview(text, 1);
      const elapsed = performance.now() - started;
      return (
        `${label.padEnd(24)} ${text.length.toLocaleString("en-US").padStart(12)} chars` +
        ` -> ${preview.text.length.toLocaleString("en-US").padStart(9)} painted` +
        `  ${elapsed.toFixed(2)} ms`
      );
    });
    console.log(`\n${rows.join("\n")}\n`);
  }, 600_000);
});
