import { expect, test } from "@playwright/test";
import { explorerRow } from "../helpers/workspace";
import { startCdpCapture } from "./cdpCapture";
import {
  interactionDuration,
  launchFixture,
  readRendererMarks,
  writeProfileArtifact,
} from "./harness";

test("profiles the expanded 5,000-file Explorer folder", async () => {
  const context = await launchFixture("large-flat", "profile-explorer");
  try {
    const { page, desktop, manifest } = context;
    const explorerActivity = page.getByTestId("activity-explorer");
    if ((await explorerActivity.getAttribute("aria-current")) !== "page") {
      await explorerActivity.click();
    }
    const folder = explorerRow(page, "flat-5000");
    await expect(folder).toBeVisible();
    if ((await folder.getAttribute("aria-expanded")) === "true") {
      await folder.click();
      await expect(folder).toHaveAttribute("aria-expanded", "false");
    }

    const capture = await startCdpCapture(desktop.app, page);
    const startedAt = performance.now();
    const expandStartedAt = await page.evaluate(() => performance.now());
    await folder.click();
    await expect(folder).toHaveAttribute("aria-expanded", "true");
    const expandedAt = await page.evaluate(() => performance.now());
    await expect(explorerRow(page, "flat-5000/flatnote-00000.md")).toBeAttached({
      timeout: 120_000,
    });
    const firstChildAt = await page.evaluate(() => performance.now());
    const mountedRowsAfterExpand = await page
      .locator('[data-testid="tree-row"]')
      .count();
    expect(mountedRowsAfterExpand).toBeLessThanOrEqual(96);
    const initiallyMountedPaths = await page
      .locator('[data-testid="tree-row"]')
      .evaluateAll((rows) => rows.map((row) => (row as HTMLElement).dataset.path ?? ""));
    await folder.focus();
    await expect(folder).toBeFocused();
    const endNavigationStartedAt = await page.evaluate(() => performance.now());
    await page.keyboard.press("End");
    await expect
      .poll(() =>
        page.evaluate(() => {
          const active = document.activeElement as HTMLElement | null;
          return (
            active?.dataset.testid === "tree-row" &&
            active.dataset.path !== undefined &&
            active.dataset.path !== "flat-5000"
          );
        }),
      )
      .toBe(true);
    const endTargetPath = await page.evaluate(
      () => (document.activeElement as HTMLElement | null)?.dataset.path ?? null,
    );
    expect(endTargetPath).not.toBeNull();
    expect(initiallyMountedPaths).not.toContain(endTargetPath);
    const endTarget = explorerRow(page, endTargetPath!);
    await expect(endTarget).toBeFocused();
    const lastRowAt = await page.evaluate(() => performance.now());

    const tree = page.getByTestId("file-tree");
    const box = await tree.boundingBox();
    if (!box) throw new Error("Explorer file tree has no layout box.");
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);

    const durationMs = interactionDuration(10_000, 800);
    const interactionStart = Date.now();
    let iterations = 0;
    while (Date.now() - interactionStart < durationMs) {
      await page.mouse.wheel(0, iterations % 2 === 0 ? 700 : -280);
      for (let press = 0; press < 8; press += 1) {
        await page.keyboard.press(iterations % 3 === 0 ? "ArrowUp" : "ArrowDown");
      }
      iterations += 1;
      await page.waitForTimeout(16);
    }

    const captured = await capture.stop();
    const mountedRows = await page.locator('[data-testid="tree-row"]').count();
    expect(mountedRows).toBeLessThanOrEqual(96);
    const treeGeometry = await tree.evaluate((element) => ({
      clientHeight: element.clientHeight,
      scrollHeight: element.scrollHeight,
      scrollTop: element.scrollTop,
    }));
    await writeProfileArtifact("explorer-profile", {
      fixture: {
        name: "large-flat",
        seed: manifest.seed,
        files: manifest.fixtures["large-flat"].files,
        flatFolderFiles: manifest.fixtures["large-flat"].flatFolderFiles,
      },
      measurements: {
        elapsedMs: performance.now() - startedAt,
        expandToAriaMs: expandedAt - expandStartedAt,
        expandToFirstChildMs: firstChildAt - expandStartedAt,
        expandToLastRowMs: null,
        endNavigationToLastRowMs: lastRowAt - endNavigationStartedAt,
        endNavigationTargetPath: endTargetPath,
        mountedRowsAfterExpand,
        interactionDurationMs: durationMs,
        interactionIterations: iterations,
        mountedRows,
        treeGeometry,
        rendererMarks: await readRendererMarks(page),
        ...captured,
        reactCommitCount: null,
        reactCommitCountSource: "unavailable",
      },
    });
  } finally {
    await context.close();
  }
});
