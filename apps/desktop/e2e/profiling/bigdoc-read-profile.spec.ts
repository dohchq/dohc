import { expect, test } from "@playwright/test";
import { explorerRow, revealExplorerPath } from "../helpers/workspace";
import { startCdpCapture } from "./cdpCapture";
import {
  launchFixture,
  oversizedReadDoc,
  readRendererMarks,
  writeProfileArtifact,
} from "./harness";

test("profiles a settled read of the 3 MiB Markdown document", async () => {
  const context = await launchFixture("big-docs", "profile-bigdoc-read");
  try {
    const { page, desktop, manifest } = context;
    const document = oversizedReadDoc(manifest);
    await revealExplorerPath(page, document.path);
    const beforeMarks = await readRendererMarks(page);
    const capture = await startCdpCapture(desktop.app, page);
    const startedAt = performance.now();

    await explorerRow(page, document.path).click();
    const source = page.getByTestId("markdown-source-view");
    const content = source.locator(".cm-content");
    await expect(source).toBeVisible({ timeout: 240_000 });
    await expect(content).toHaveAttribute("contenteditable", "false");
    await expect(page.getByTestId("truncated-notice")).toBeVisible();

    // Observe the browser's next two idle opportunities. The retained rich
    // reader used each idle callback to append more blocks, so first paint
    // looked fast while the document kept growing past 136,000 nodes.
    await page.evaluate(
      () =>
        new Promise<void>((resolve) => {
          const afterTwoFrames = () =>
            requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
          if (typeof window.requestIdleCallback !== "function") {
            afterTwoFrames();
            return;
          }
          window.requestIdleCallback(
            () => window.requestIdleCallback(() => resolve(), { timeout: 1_000 }),
            { timeout: 1_000 },
          );
        }),
    );

    const sourceDescendants = await source.locator("*").count();
    const renderedLines = await source.locator(".cm-line").count();
    const pageNodes = await page.locator("*").count();
    expect(sourceDescendants).toBeLessThan(1_000);
    expect(renderedLines).toBeLessThan(500);
    expect(pageNodes).toBeLessThan(5_000);

    const captured = await capture.stop();
    const afterMarks = await readRendererMarks(page);
    await writeProfileArtifact("bigdoc-read-profile", {
      fixture: {
        name: "big-docs",
        seed: manifest.seed,
        path: document.path,
        bytes: document.bytes,
      },
      measurements: {
        elapsedMs: performance.now() - startedAt,
        sourceDescendants,
        renderedLines,
        pageNodes,
        rendererMarks: { before: beforeMarks, after: afterMarks },
        ...captured,
        reactCommitCount: null,
        reactCommitCountSource: "unavailable",
      },
    });
  } finally {
    await context.close();
  }
});
