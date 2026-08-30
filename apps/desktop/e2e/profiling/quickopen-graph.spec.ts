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

    const graphButton = page.getByTestId("activity-graph");
    if ((await graphButton.getAttribute("aria-current")) === "page") {
      await page.getByTestId("activity-explorer").click();
      await expect(graphButton).not.toHaveAttribute("aria-current", "page");
    }
    const graphStart = await page.evaluate(() => performance.now());
    await graphButton.click();
    const sidePanel = page.getByTestId("side-panel");
    const graph = sidePanel.locator('[data-testid="graph-view"][data-state="ready"]');
    await expect(graph).toBeVisible({ timeout: 180_000 });
    await expect(sidePanel.getByTestId("graph-node").first()).toBeVisible();
    await page.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        ),
    );
    const graphReady = await page.evaluate(() => performance.now());
    const graphDocCount = await sidePanel.getByTestId("graph-doc-count").textContent();
    const graphLinkCount = await sidePanel.getByTestId("graph-link-count").textContent();
    const renderedGraphNodeCount = await sidePanel.getByTestId("graph-node").count();
    const renderedGraphRowCount = await sidePanel.getByTestId("graph-file-row").count();
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
        renderedGraphNodeCount,
        renderedGraphRowCount,
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
