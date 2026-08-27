import { expect, test } from "@playwright/test";
import { explorerRow, revealExplorerPath } from "../helpers/workspace";
import { startCdpCapture } from "./cdpCapture";
import {
  launchFixture,
  middleBigDoc,
  readRendererMarks,
  writeProfileArtifact,
} from "./harness";

test("profiles opening, typing in, and viewing source for the middle big document", async () => {
  const context = await launchFixture("big-docs", "profile-bigdoc");
  try {
    const { page, desktop, manifest } = context;
    const document = middleBigDoc(manifest);
    await revealExplorerPath(page, document.path);
    const beforeMarks = await readRendererMarks(page);
    const capture = await startCdpCapture(desktop.app, page);
    const startedAt = performance.now();
    await explorerRow(page, document.path).click();
    const editToggle = page.getByTestId("markdown-edit-toggle");
    await expect(editToggle).toBeVisible({ timeout: 240_000 });
    await expect(editToggle).toHaveText("Edit");
    // The toggle is disabled while the engine session opens and stays
    // disabled for read-only documents. Both are measurements, not
    // failures: record how long enablement took, or that it never came,
    // and profile whichever surfaces the document actually offers.
    const editEnabledAfterMs = await editToggle
      .waitFor({ state: "visible", timeout: 0 })
      .then(async () => {
        const enableStartedAt = performance.now();
        try {
          await expect(editToggle).toBeEnabled({ timeout: 120_000 });
          return performance.now() - enableStartedAt;
        } catch {
          return null;
        }
      });
    const disabledReason =
      editEnabledAfterMs === null
        ? await editToggle.getAttribute("title").then(
            (title) => title ?? "read-only (no opening tooltip)",
          )
        : null;
    let typedCharacters = 0;
    let sourceToggled = false;
    if (editEnabledAfterMs !== null) {
      await editToggle.click();
      const editor = page.getByTestId("markdown-editor");
      await expect(editor).toBeVisible({ timeout: 240_000 });
      await editor.click();
      await page.keyboard.press("ControlOrMeta+End");
      const typedText = "profilex-0123456789-abcdefghij";
      expect(typedText).toHaveLength(30);
      await page.keyboard.type(typedText);
      typedCharacters = typedText.length;
      await expect(editToggle).toHaveText("Source");
      await editToggle.click();
      await expect(editToggle).toHaveText("WYSIWYG", { timeout: 120_000 });
      await expect(editor).toHaveJSProperty("tagName", "TEXTAREA");
      sourceToggled = true;
    }
    const captured = await capture.stop();
    const afterMarks = await readRendererMarks(page);

    await writeProfileArtifact("bigdoc-profile", {
      fixture: {
        name: "big-docs",
        seed: manifest.seed,
        path: document.path,
        bytes: document.bytes,
      },
      measurements: {
        elapsedMs: performance.now() - startedAt,
        editEnabledAfterMs,
        disabledReason,
        typedCharacters,
        sourceToggled,
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
