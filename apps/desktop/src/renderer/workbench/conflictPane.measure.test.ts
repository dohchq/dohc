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
import { createRequire } from "node:module";
import { readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { transformWithEsbuild } from "vite";
import { describe, it } from "vitest";
import {
  CONFLICT_COMBINED_EDIT_MAX_BYTES,
  CONFLICT_HEALTHY_DOCUMENT_MAX_CHARS,
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

// The benchmark behind CONFLICT_COMBINED_EDIT_MAX_BYTES (#566).
//
// That limit REJECTS otherwise valid combined text, so AGENTS.md requires its
// evidence to live in a focused benchmark rather than a comment. The rows
// above cannot supply it: they measure corpus sizes and preview slicing in
// Node, and this cost is Chromium's.
//
// WHAT ONE KEYSTROKE COSTS. "Combine by hand" is a CONTROLLED textarea, so
// every keystroke runs `onCombinedChange` — `exceedsUtf8Bytes` over the whole
// draft — and then React assigns the whole new value back to the element. This
// drives BOTH halves in the browser, at the pane's own font and width, with
// the SHIPPED `exceedsUtf8Bytes` handed to the page as source rather than
// reimplemented, so the number cannot drift from the function it describes.
//
// Re-run it when Chromium or React move:
//
//   DOHC_MEASURE_CONFLICT=1 pnpm --filter @dohc/desktop exec vitest run conflictPane.measure
//
// It reports rather than asserts, like its siblings: the numbers are
// wall-clock and machine-specific, and a threshold here would be a gate that
// fails on a slow laptop rather than on a regression.
describe.skipIf(!measuring)("combine textarea keystroke latency", () => {
  it("reports what one keystroke costs across draft sizes", async () => {
    // Resolved from the desktop package, which has playwright as a devDep.
    const require = createRequire(`${repoRoot}apps/desktop/`);
    const { chromium } = require("playwright") as typeof import("playwright");

    const browser = await chromium.launch();
    try {
      const page = await browser.newPage();
      // The pane's own textarea: `font-mono text-[11px] leading-4`, six rows,
      // inside the 720px dialog's padded column.
      await page.setContent(
        `<textarea id="draft" rows="6" style="font:11px/16px monospace;width:320px"></textarea>`,
      );
      // The REAL module, not a copy of one function. conflictPane.ts imports
      // nothing, so transpiling it is enough to run it in the page — and the
      // guard keeps the module-private helper it actually calls, which
      // stringifying the exported function alone would have left behind.
      const moduleSource = readFileSync(
        `${repoRoot}apps/desktop/src/renderer/workbench/conflictPane.ts`,
        "utf8",
      );
      const transpiled = await transformWithEsbuild(moduleSource, "conflictPane.ts", {
        loader: "ts",
        format: "cjs",
      });
      await page.evaluate((source) => {
        const shipped = { exports: {} as Record<string, unknown> };
        new Function("module", "exports", source)(shipped, shipped.exports);
        (globalThis as unknown as Record<string, unknown>).exceedsUtf8Bytes =
          shipped.exports.exceedsUtf8Bytes;
      }, transpiled.code);

      const rows: string[] = [];
      for (const size of [
        100_000, 250_000, CONFLICT_HEALTHY_DOCUMENT_MAX_CHARS, CONFLICT_COMBINED_EDIT_MAX_BYTES,
        1_048_576, 4 * 1024 * 1024, 8 * 1024 * 1024,
      ]) {
        const timings = await page.evaluate(
          ({ length, limit }) => {
            const draft = document.getElementById("draft") as HTMLTextAreaElement;
            const guard = (globalThis as unknown as {
              exceedsUtf8Bytes: (text: string, limitBytes: number) => boolean;
            }).exceedsUtf8Bytes;
            const body = "x".repeat(length);
            const guardMs: number[] = [];
            let refusals = 0;
            const assignMs: number[] = [];
            for (let stroke = 0; stroke < 21; stroke += 1) {
              const next = body.slice(0, length - 1) + String.fromCharCode(97 + (stroke % 26));
              const beforeGuard = performance.now();
              const refused = guard(next, limit);
              guardMs.push(performance.now() - beforeGuard);
              refusals += refused ? 1 : 0;
              // Measured even when the guard refuses. What a draft past the
              // bound WOULD cost is the evidence for not raising the bound,
              // and it is the only place that number can come from.
              const beforeAssign = performance.now();
              draft.value = next;
              // Force layout, or the assignment is deferred out of the sample.
              void draft.scrollHeight;
              assignMs.push(performance.now() - beforeAssign);
            }
            const median = (samples: number[]) =>
              samples.length === 0
                ? Number.NaN
                : [...samples].sort((a, b) => a - b)[Math.floor(samples.length / 2)];
            return { guard: median(guardMs), assign: median(assignMs), refusals };
          },
          { length: size, limit: CONFLICT_COMBINED_EDIT_MAX_BYTES },
        );
        const total = timings.guard + timings.assign;
        rows.push(
          `${size.toLocaleString("en-US").padStart(11)} chars` +
            `  guard ${timings.guard.toFixed(2).padStart(6)} ms` +
            `  assign ${timings.assign.toFixed(2).padStart(7)} ms` +
            `  keystroke ${total.toFixed(2).padStart(7)} ms` +
            (timings.refusals > 0
              ? "   past the bound: refused, cost shown is what raising it would buy"
              : ""),
        );
      }

      console.log(
        `\nCONFLICT_COMBINED_EDIT_MAX_BYTES = ` +
          `${CONFLICT_COMBINED_EDIT_MAX_BYTES.toLocaleString("en-US")}` +
          `\nlargest healthy document = ` +
          `${CONFLICT_HEALTHY_DOCUMENT_MAX_CHARS.toLocaleString("en-US")} characters\n\n` +
          `${rows.join("\n")}\n`,
      );
    } finally {
      await browser.close();
    }
  }, 600_000);
});
