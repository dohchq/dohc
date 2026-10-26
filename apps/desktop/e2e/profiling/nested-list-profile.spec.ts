import { expect, test, type Page } from "@playwright/test";
import { cpus, freemem, totalmem } from "node:os";
import { launchDesktopApp } from "../helpers/desktopApp";
import { startCdpCapture } from "./cdpCapture";
import {
  cleanupDesktopWorkspace, createTempWorkspace, explorerRow,
  openWorkspaceFromFirstRun, waitForWorkspaceFile, writeWorkspaceFiles,
} from "../helpers/workspace";

type InputTiming = { totalMs: number; inputMs: number; paintMs: number };
// Same keydown -> input -> two animation frames method as the Collection
// profiler. Transport time is outside each sample.
async function inputSample(page: Page) {
  await page.evaluate(() => {
    const editor = document.querySelector<HTMLElement>('[data-testid="markdown-editor"]');
    if (!editor) throw new Error("The editor is unavailable.");
    (window as Window & { nestedInputSample?: Promise<InputTiming> }).nestedInputSample = new Promise((resolve, reject) => {
      let started = 0;
      const before = editor.textContent;
      const timeout = setTimeout(() => {
        editor.removeEventListener("keydown", begin, true);
        editor.removeEventListener("input", changed);
        reject(new Error("The editor did not receive input."));
      }, 10_000);
      function begin() { started = performance.now(); }
      function changed() {
        const inputAt = performance.now();
        requestAnimationFrame(() => requestAnimationFrame(() => {
          clearTimeout(timeout);
          if (!started || editor!.textContent === before) reject(new Error("The editor did not paint the changed text."));
          else {
            const paintedAt = performance.now();
            resolve({ totalMs: paintedAt - started, inputMs: inputAt - started, paintMs: paintedAt - inputAt });
          }
        }));
      }
      editor.addEventListener("keydown", begin, { once: true, capture: true });
      editor.addEventListener("input", changed, { once: true });
    });
  });
  await page.keyboard.press("x");
  return page.evaluate(() => (window as Window & { nestedInputSample?: Promise<InputTiming> }).nestedInputSample!);
}

test("@nested-list-performance compares typing in 2000 flat and nested items", async ({}, testInfo) => {
  test.setTimeout(20 * 60_000);
  const workspace = await createTempWorkspace();
  let desktop: Awaited<ReturnType<typeof launchDesktopApp>> | null = null;
  try {
    const count = 2000;
    const text = (nested: boolean) => Array.from({ length: count }, (_, i) =>
      `${"  ".repeat(nested ? i % 3 : 0)}- Item ${String(i).padStart(4, "0")}.`,
    ).join("\n") + "\n";
    // Keep both seeds inside the engine's 48 KiB in-band limit.
    expect(Buffer.byteLength(text(true))).toBeLessThan(48 * 1024);
    await writeWorkspaceFiles(workspace, ["flat", "nested"].map(kind => ({
      path: `${kind}.md`, contents: text(kind === "nested"),
    })));
    desktop = await launchDesktopApp({ workspace });
    const page = desktop.page;
    const opened = await openWorkspaceFromFirstRun(page, workspace);
    await page.emulateMedia({ reducedMotion: "reduce" });
    const measurements: Record<string, InputTiming[][]> = { flat: [], nested: [] };
    // Alternate order to expose host drift instead of favoring one document.
    for (const kind of ["flat", "nested", "nested", "flat", "flat", "nested"] as const) {
      await waitForWorkspaceFile(page, opened.workspaceId, `${kind}.md`);
      await explorerRow(page, `${kind}.md`).click();
      const editor = page.getByTestId("markdown-editor");
      await expect(editor.locator("li")).toHaveCount(count);
      await expect(editor.locator("li li li")).toHaveCount(kind === "nested" ? 666 : 0);
      await expect(editor.locator("li li li li")).toHaveCount(0);
      await editor.locator("li > p").nth(1997).click();
      await page.keyboard.press("End");
      for (let i = 0; i < 5; i++) await inputSample(page);
      const capture = process.env.DOHC_NESTED_LIST_TRACE === "1" ? await startCdpCapture(desktop.app, page) : null;
      const samples: InputTiming[] = [];
      for (let i = 0; i < 30; i++) samples.push(await inputSample(page));
      if (capture) await testInfo.attach(`${kind}-${measurements[kind]!.length + 1}-cpu.json`, {
        body: JSON.stringify(await capture.stop()), contentType: "application/json",
      });
      measurements[kind]!.push(samples);
      await expect(page.getByTestId("markdown-save-state")).toHaveAttribute("data-state", "saved");
    }
    const stats = (samples: number[]) => {
      const sorted = [...samples].sort((a, b) => a - b);
      return { count: sorted.length, median: sorted[Math.ceil(sorted.length * .5) - 1],
        p95: sorted[Math.ceil(sorted.length * .95) - 1], samplesMs: samples };
    };
    expect(desktop.logs.filter(entry => entry.level === "pageerror"
      || entry.text.includes("ydoc-seed-too-large"))).toEqual([]);
    const result = {
      items: count, levels: 3, warmupsPerRound: 5, samplesPerRound: 30,
      method: "keydown to changed input plus two animation frames",
      host: { platform: process.platform, cpu: cpus()[0]?.model, logicalProcessors: cpus().length,
        totalMemoryBytes: totalmem(), freeMemoryBytes: freemem(), node: process.version },
      profiling: process.env.DOHC_NESTED_LIST_TRACE === "1",
      measurements,
      ...Object.fromEntries(["flat", "nested"].map(kind => {
        const samples = measurements[kind]!.flat();
        return [kind, { ...stats(samples.map(sample => sample.totalMs)),
          input: stats(samples.map(sample => sample.inputMs)), paint: stats(samples.map(sample => sample.paintMs)) }];
      })),
    };
    console.log(JSON.stringify(result));
    await testInfo.attach("nested-list-typing.json", { body: JSON.stringify(result, null, 2), contentType: "application/json" });
  } finally { await cleanupDesktopWorkspace(desktop, workspace); }
});
