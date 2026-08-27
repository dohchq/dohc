import { expect, test } from "@playwright/test";
import { explorerRow, revealExplorerPath } from "../helpers/workspace";
import { startCdpCapture } from "./cdpCapture";
import {
  interactionDuration,
  largestDrawing,
  launchFixture,
  readRendererMarks,
  writeProfileArtifact,
} from "./harness";

test("profiles pointer-frame dragging in the largest Excalidraw scene", async () => {
  const context = await launchFixture("drawings", "profile-excalidraw");
  try {
    const { page, desktop, manifest } = context;
    const drawing = largestDrawing(manifest);
    await revealExplorerPath(page, drawing.path);
    await explorerRow(page, drawing.path).click();
    await expect(page.getByTestId("view-drawing")).toBeVisible({ timeout: 180_000 });
    const canvas = page.getByTestId("excalidraw-canvas");
    await expect(canvas.locator("canvas").first()).toBeVisible({ timeout: 60_000 });
    const saveState = page.getByTestId("drawing-save-state");
    await expect(saveState).toHaveAttribute("data-state", "saved", { timeout: 60_000 });
    await saveState.evaluate((element) => {
      const target = window as Window & {
        __dohcDrawingSaveTransitions?: { states: string[]; observer: MutationObserver };
      };
      target.__dohcDrawingSaveTransitions?.observer.disconnect();
      const states = [element.getAttribute("data-state") ?? "missing"];
      const observer = new MutationObserver(() => {
        states.push(element.getAttribute("data-state") ?? "missing");
      });
      observer.observe(element, { attributes: true, attributeFilter: ["data-state"] });
      target.__dohcDrawingSaveTransitions = { states, observer };
    });
    const box = await canvas.boundingBox();
    if (!box) throw new Error("Excalidraw canvas has no layout box.");

    const capture = await startCdpCapture(desktop.app, page);
    const { session } = capture;
    const durationMs = interactionDuration(5_000, 600);
    const x = box.x + box.width / 2;
    const y = box.y + box.height / 2;
    await session.send("Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x,
      y,
      button: "none",
      buttons: 0,
    });
    await session.send("Input.dispatchMouseEvent", {
      type: "mousePressed",
      x,
      y,
      button: "left",
      buttons: 1,
      clickCount: 1,
    });
    const startedAt = Date.now();
    let pointerFrames = 0;
    while (Date.now() - startedAt < durationMs) {
      const progress = (Date.now() - startedAt) / durationMs;
      await session.send("Input.dispatchMouseEvent", {
        type: "mouseMoved",
        x: x + 120 * progress,
        y: y + Math.sin(progress * Math.PI * 4) * 36,
        button: "left",
        buttons: 1,
      });
      pointerFrames += 1;
      await page.waitForTimeout(16);
    }
    await session.send("Input.dispatchMouseEvent", {
      type: "mouseReleased",
      x: x + 120,
      y,
      button: "left",
      buttons: 0,
      clickCount: 1,
    });
    await page.waitForTimeout(100);
    await expect(saveState).toHaveAttribute("data-state", "saved", { timeout: 60_000 });
    const saveTransitions = await page.evaluate(() => {
      const target = window as Window & {
        __dohcDrawingSaveTransitions?: { states: string[]; observer: MutationObserver };
      };
      const transitions = target.__dohcDrawingSaveTransitions;
      transitions?.observer.disconnect();
      delete target.__dohcDrawingSaveTransitions;
      return transitions?.states ?? [];
    });
    expect(saveTransitions).toContain("saving");
    const captured = await capture.stop();

    await writeProfileArtifact("excalidraw-profile", {
      fixture: {
        name: "drawings",
        seed: manifest.seed,
        path: drawing.path,
        elementCount: drawing.elementCount,
      },
      measurements: {
        requestedDragDurationMs: durationMs,
        actualDragDurationMs: Date.now() - startedAt,
        pointerFrames,
        saveTransitions,
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
