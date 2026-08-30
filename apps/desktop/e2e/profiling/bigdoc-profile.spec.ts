import { expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { explorerRow, revealExplorerPath } from "../helpers/workspace";
import { startCdpCapture } from "./cdpCapture";
import {
  launchFixture,
  editableBigDoc,
  readRendererMarks,
  writeProfileArtifact,
} from "./harness";

test("profiles opening, typing in, and viewing source for the 250 KiB document", async () => {
  const context = await launchFixture("big-docs", "profile-bigdoc");
  try {
    const { page, desktop, manifest } = context;
    const document = editableBigDoc(manifest);
    await revealExplorerPath(page, document.path);
    const beforeMarks = await readRendererMarks(page);
    const capture = await startCdpCapture(desktop.app, page);
    const startedAt = performance.now();
    await explorerRow(page, document.path).click();
    const editToggle = page.getByTestId("markdown-edit-toggle");
    await expect(editToggle).toBeVisible({ timeout: 240_000 });
    await expect(editToggle).toHaveText("Edit");
    const enableStartedAt = performance.now();
    await expect(editToggle).toBeEnabled({ timeout: 120_000 });
    const editEnabledAfterMs = performance.now() - enableStartedAt;
    await editToggle.click();
    const editor = page.getByTestId("markdown-editor");
    await expect(editor).toBeVisible({ timeout: 120_000 });
    await expect(editor.locator(".cm-content")).toHaveAttribute(
      "contenteditable",
      "true",
    );
    await editor.click();
    await page.keyboard.press("ControlOrMeta+End");
    const typedText = "profilex-0123456789-abcdefghij";
    expect(typedText).toHaveLength(30);
    const typingStartedAt = performance.now();
    await page.keyboard.type(typedText);
    const typingDurationMs = performance.now() - typingStartedAt;
    await expect(editToggle).toHaveText("WYSIWYG", { timeout: 10_000 });
    await expect(page.getByTestId("markdown-save-state")).toHaveAttribute(
      "data-state",
      "saved",
      { timeout: 30_000 },
    );
    await expect
      .poll(
        async () =>
          await readFile(join(context.fixtureRoot, document.path), "utf8").catch(
            () => "",
          ),
        { timeout: 30_000 },
      )
      .toContain(typedText);
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
        typingDurationMs,
        typedCharacters: typedText.length,
        sourceToggled: true,
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
