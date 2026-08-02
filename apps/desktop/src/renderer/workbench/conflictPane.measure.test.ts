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
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
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
// That limit REJECTS otherwise valid combined text, so AGENTS.md wants its
// evidence in a focused benchmark rather than a comment. The rows above cannot
// supply it: they measure corpus sizes and preview slicing in Node, and this
// cost is Chromium's.
//
// IT DRIVES THE SHIPPING PATH, which is the whole point. A first version
// assigned `textarea.value` directly and reported 26-36 ms at half a megabyte.
// That number was fiction: it forced a whole-value write on every keystroke,
// and the real path does not do that. A real keystroke is
//
//   native input event -> React onChange -> applyCombinedChange -> setState
//   -> commit -> controlled value reconciled
//
// and React skips the value write when the browser's own incremental edit has
// already produced the value it wanted. So this bundles React and the REAL
// `applyCombinedChange`, types with `keyboard.insertText` so the native event
// fires, and times from that event until the DOM settles. The measured cost
// fell by about sixty times, and the bound moved because of it.
//
// The bound is raised inside the bundle for the ACCEPTED ladder, so the cost
// curve can be read past the value the product ships — otherwise the guard
// refuses the very rows a recalibration would need.
//
//   DOHC_MEASURE_CONFLICT=1 pnpm --filter @dohc/desktop exec vitest run conflictPane.measure
//
// It reports rather than asserts, like its siblings: the numbers are
// wall-clock and machine-specific.
describe.skipIf(!measuring)("combine textarea keystroke latency", () => {
  // Rolldown resolves module specifiers with forward slashes; repoRoot carries
  // native separators on Windows.
  const posixRoot = repoRoot.split(String.fromCharCode(92)).join('/');
  const bundleRequire = createRequire(`${posixRoot}apps/desktop/`);
  const resolveFrom = (specifier: string) =>
    bundleRequire.resolve(specifier, { paths: [`${posixRoot}apps/desktop`] });

  // A real React controlled textarea calling the SHIPPED decision. The only
  // benchmark-local code is the JSX shell around it.
  // Written with createElement rather than JSX: the entry is three elements,
  // and avoiding JSX avoids depending on which jsx runtime the bundler picks.
  const benchSource = `
import { createElement, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { applyCombinedChange } from ${JSON.stringify(
    `${posixRoot}apps/desktop/src/renderer/workbench/conflictPane.ts`,
  )};

function Bench() {
  const [combined, setCombined] = useState("");
  const [refusedBytes, setRefusedBytes] = useState(null);
  useEffect(() => { window.__seed = (text) => setCombined(text); }, []);
  return createElement("div", null,
    createElement("textarea", {
      id: "draft",
      rows: 6,
      value: combined,
      onChange: (event) => {
        const change = applyCombinedChange(event.target.value);
        if (!change.accepted) { setRefusedBytes(change.refusedBytes); return; }
        setRefusedBytes(null);
        setCombined(change.text);
      },
      style: { font: "11px/16px monospace", width: "320px", resize: "vertical" },
    }),
    createElement("p", { id: "refused" }, refusedBytes === null ? "" : String(refusedBytes)),
  );
}
createRoot(document.getElementById("root")).render(createElement(Bench));
`;

  async function bundle(editingBound: number | null): Promise<string> {
    const { build } = bundleRequire("vite") as typeof import("vite");
    const directory = mkdtempSync(join(tmpdir(), "dohc-combine-bench-"));
    const entry = join(directory, "entry.js");
    writeFileSync(entry, benchSource);
    try {
      const output = await build({
        logLevel: "error",
        configFile: false,
        // ANCHORED, because a bare "react" alias prefix-matches
        // "react/jsx-dev-runtime" and rolldown then looks for it underneath
        // react's index.js.
        resolve: {
          alias: [
            { find: /^react$/, replacement: resolveFrom("react") },
            { find: /^react-dom$/, replacement: resolveFrom("react-dom") },
            { find: /^react-dom\/client$/, replacement: resolveFrom("react-dom/client") },
            { find: /^react\/jsx-runtime$/, replacement: resolveFrom("react/jsx-runtime") },
            {
              find: /^react\/jsx-dev-runtime$/,
              replacement: resolveFrom("react/jsx-dev-runtime"),
            },
          ],
        },
        mode: "production",
        define: { "process.env.NODE_ENV": JSON.stringify("production") },
        plugins:
          editingBound === null
            ? []
            : [
                {
                  name: "raise-editing-bound",
                  transform(code: string, id: string) {
                    if (!id.replace(/\\/g, "/").endsWith("conflictPane.ts")) return null;
                    return code.replace(
                      /CONFLICT_COMBINED_EDIT_MAX_BYTES = [^;]+;/,
                      `CONFLICT_COMBINED_EDIT_MAX_BYTES = ${editingBound};`,
                    );
                  },
                },
              ],
        build: {
          write: false,
          minify: false,
          lib: { entry, formats: ["iife"], name: "combineBench" },
        },
      });
      const built = Array.isArray(output) ? output[0] : output;
      return (built as unknown as { output: { code: string }[] }).output[0].code;
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }

  it("reports what one keystroke costs through the real controlled path", async () => {
    const { chromium } = bundleRequire("playwright") as typeof import("playwright");
    const browser = await chromium.launch();
    try {
      const open = async (editingBound: number | null) => {
        const page = await browser.newPage();
        // A benchmark that silently renders nothing is worse than one that
        // fails: surface whatever the page throws.
        page.on("pageerror", (error) => {
          console.error("benchmark page error:", error.message);
        });
        await page.setContent(`<div id="root"></div>`);
        await page.addScriptTag({ content: await bundle(editingBound) });
        await page.waitForSelector("#draft");
        // Timed from the NATIVE input event until the DOM settles to its final
        // value: one longer when accepted, restored when refused. No React
        // internals, so the number survives a React upgrade.
        await page.evaluate(() => {
          const draft = document.getElementById("draft") as HTMLTextAreaElement;
          const scope = globalThis as unknown as Record<string, unknown>;
          draft.addEventListener(
            "input",
            () => {
              const started = performance.now();
              const settle = () => {
                if (draft.value.length === scope.__expect) {
                  scope.__result = performance.now() - started;
                  return;
                }
                requestAnimationFrame(settle);
              };
              requestAnimationFrame(settle);
            },
            true,
          );
        });
        return page;
      };

      const median = async (
        page: Awaited<ReturnType<typeof open>>,
        size: number,
        settledLength: number,
        samples = 15,
      ) => {
        const times: number[] = [];
        for (let sample = 0; sample < samples; sample += 1) {
          await page.evaluate(
            ({ length, expected }) => {
              const scope = globalThis as unknown as Record<string, unknown> & {
                __seed: (text: string) => void;
              };
              scope.__seed("x".repeat(length));
              scope.__expect = expected;
              scope.__result = null;
            },
            { length: size, expected: settledLength },
          );
          await page.waitForFunction(
            (length) =>
              (document.getElementById("draft") as HTMLTextAreaElement).value.length ===
              length,
            size,
          );
          await page.focus("#draft");
          await page.keyboard.press("End");
          await page.keyboard.insertText("z");
          await page.waitForFunction(
            () => (globalThis as unknown as Record<string, unknown>).__result !== null,
            null,
            { timeout: 60_000 },
          );
          times.push(
            (await page.evaluate(
              () => (globalThis as unknown as Record<string, unknown>).__result,
            )) as number,
          );
        }
        times.sort((left, right) => left - right);
        return times[Math.floor(times.length / 2)];
      };

      const ladder = [
        CONFLICT_HEALTHY_DOCUMENT_MAX_CHARS,
        CONFLICT_COMBINED_EDIT_MAX_BYTES,
        2 * 1024 * 1024,
        4 * 1024 * 1024,
        8 * 1024 * 1024,
      ];
      const accepted = await open(64 * 1024 * 1024);
      await median(accepted, 262_144, 262_145, 3);
      const acceptedRows: string[] = [];
      for (const size of ladder) {
        const elapsed = await median(accepted, size, size + 1);
        acceptedRows.push(
          `${size.toLocaleString("en-US").padStart(11)} chars  ` +
            `${elapsed.toFixed(2).padStart(7)} ms` +
            (size > CONFLICT_COMBINED_EDIT_MAX_BYTES ? "   past the bound" : ""),
        );
      }
      await accepted.close();

      // The one expensive keystroke is the refused one: React puts the whole
      // controlled value back, which is the write an accepted keystroke never
      // makes.
      const refused = await open(null);
      await median(refused, 262_144, 262_145, 3);
      const refusedMs = await median(
        refused,
        CONFLICT_COMBINED_EDIT_MAX_BYTES,
        CONFLICT_COMBINED_EDIT_MAX_BYTES,
      );
      await refused.close();

      console.log(
        `\nCONFLICT_COMBINED_EDIT_MAX_BYTES = ` +
          `${CONFLICT_COMBINED_EDIT_MAX_BYTES.toLocaleString("en-US")}` +
          `\nlargest healthy document = ` +
          `${CONFLICT_HEALTHY_DOCUMENT_MAX_CHARS.toLocaleString("en-US")} characters` +
          `\n\naccepted keystroke, native event to settled DOM\n` +
          `${acceptedRows.join("\n")}` +
          `\n\nrefused keystroke at the bound (React restores the whole value)\n` +
          `${CONFLICT_COMBINED_EDIT_MAX_BYTES.toLocaleString("en-US").padStart(11)} chars  ` +
          `${refusedMs.toFixed(2).padStart(7)} ms\n`,
      );
    } finally {
      await browser.close();
    }
  }, 900_000);
});
