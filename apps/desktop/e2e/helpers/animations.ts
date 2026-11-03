import type { Page } from "@playwright/test";

// Waits for every running animation that has an end. Chromium never finishes
// an animation inside a closed <details>, so hidden targets are skipped.
export async function waitForVisibleAnimations(page: Page): Promise<void> {
  await page.evaluate(async () => {
    await Promise.allSettled(document.getAnimations()
      .filter((animation) => animation.playState === "running"
        && Number.isFinite(Number(animation.effect?.getComputedTiming().endTime))
        && (animation.effect as KeyframeEffect | null)?.target?.checkVisibility() !== false)
      .map((animation) => animation.finished));
  });
}
