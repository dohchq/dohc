import { expect, test } from "@playwright/test";
import { startLongTaskObserver, stopLongTaskObserver } from "./cdpCapture";
import {
  launchFixture,
  readRendererMarks,
  writeProfileArtifact,
} from "./harness";

test("profiles eight Quick Open keystrokes and Graph construction", async () => {
  const context = await launchFixture("large-flat", "profile-quickopen-graph");
  try {
    const { page, manifest } = context;
    await startLongTaskObserver(page);
    await page.keyboard.press("Control+p");
    const palette = page.getByTestId("quick-open");
    await expect(palette).toBeVisible();
    const input = palette.getByRole("textbox", { name: "File" });
    const query = "flatnote";
    const queryTimings = [];
    let typed = "";
    for (const character of query) {
      typed += character;
      await input.pressSequentially(character);
      await page.evaluate(
        () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())),
      );
      const snapshot = await readRendererMarks(page);
      queryTimings.push({
        query: typed,
        queryMs: snapshot.measures["file-tree-search-query"] ?? null,
        visibleMs: snapshot.measures["file-tree-search-visible"] ?? null,
      });
    }
    expect(typed).toHaveLength(8);
    await page.keyboard.press("Escape");

    const graphStart = await page.evaluate(() => performance.now());
    await page.getByTestId("activity-graph").click();
    const graph = page.locator('[data-testid="graph-view"][data-state="ready"]').first();
    await expect(graph).toBeVisible({ timeout: 180_000 });
    const graphReady = await page.evaluate(() => performance.now());
    const graphDocCount = await page.getByTestId("graph-doc-count").first().textContent();
    const graphLinkCount = await page.getByTestId("graph-link-count").first().textContent();
    const longTasks = await stopLongTaskObserver(page);

    await writeProfileArtifact("quickopen-graph", {
      fixture: {
        name: "large-flat",
        seed: manifest.seed,
        files: manifest.fixtures["large-flat"].files,
        markdownFiles: manifest.fixtures["large-flat"].markdownFiles,
      },
      measurements: {
        query,
        queryTimings,
        graphOpenToReadyMs: graphReady - graphStart,
        graphDocCount,
        graphLinkCount,
        rendererMarks: await readRendererMarks(page),
        longTasks,
        reactCommitCount: null,
        reactCommitCountSource: "unavailable",
      },
    });
  } finally {
    await context.close();
  }
});
