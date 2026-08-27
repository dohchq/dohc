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
  const context = await launchFixture("large-flat", "profile-explorer", { engine: false });
  try {
    const { page, desktop, manifest } = context;
    const folder = explorerRow(page, "flat-5000");
    await expect(folder).toBeVisible();

    const capture = await startCdpCapture(desktop.app, page);
    const startedAt = performance.now();
    await folder.click();
    await expect(folder).toHaveAttribute("aria-expanded", "true");
    const finalFlatIndex = manifest.fixtures["large-flat"].flatFolderFiles - 1;
    const finalFlatName = `${finalFlatIndex % 5 < 3 ? "flatnote" : "text"}-${String(
      finalFlatIndex,
    ).padStart(5, "0")}.${finalFlatIndex % 5 < 3 ? "md" : "txt"}`;
    await expect(explorerRow(page, `flat-5000/${finalFlatName}`)).toBeAttached({
      timeout: 120_000,
    });

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
