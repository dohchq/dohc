import { test, expect } from "@playwright/test";
import { yDocToMarkdown } from "@dohc/ydoc-projection";
import { openNamedRecipient } from "./namedRecipientFixture";

test("named invitation signs in, edits the current Y.Doc, and preserves a stopped draft for review", async ({
  browser,
}, testInfo) => {
  const host = await openNamedRecipient(
    browser,
    "# Shared file\n\n- [ ] tick me\n\nEdit together.",
  );
  const { doc, binding, page, editor } = host;
  try {
    await expect(editor).toHaveAttribute("contenteditable", "true");
    await editor.click();
    await page.keyboard.press("Control+End");
    await page.keyboard.insertText(" Browser edit.");
    await expect.poll(() => yDocToMarkdown(doc)).toContain("Browser edit.");
    await expect(page.getByRole("status")).toContainText("Changes saved");
    const box = editor.getByRole("checkbox");
    await box.click();
    await expect.poll(() => yDocToMarkdown(doc)).toContain("- [x] tick me");
    await expect(box).toBeChecked();
    await box.click();
    await expect.poll(() => yDocToMarkdown(doc)).toContain("- [ ] tick me");
    await expect(box).not.toBeChecked();
    await expect(box).toHaveAccessibleName("tick me");
    await editor.getByText("Edit together.").click();
    await page.keyboard.press("End");
    await page.keyboard.insertText(" Redo check.");
    await expect.poll(() => yDocToMarkdown(doc)).toContain("Redo check.");
    await page.keyboard.press("ControlOrMeta+z");
    await expect(editor).not.toContainText("Redo check.");
    await page.keyboard.press("ControlOrMeta+Shift+z");
    await expect(editor).toContainText("Redo check.");
    for (const key of ["ControlOrMeta+Shift+z", "ControlOrMeta+Shift+Z", "ControlOrMeta+y"]) {
      await page.keyboard.press(key);
      expect(await editor.textContent()).toContain("Redo check.");
    }
    await expect.poll(() => yDocToMarkdown(doc)).toContain("Redo check.");
    expect(
      await editor.evaluate((node) => node.getBoundingClientRect().height),
    ).toBeGreaterThanOrEqual(360);
    expect(
      await page
        .locator(".named-recipient-layout")
        .evaluate((node) => getComputedStyle(node).gridTemplateColumns.split(" ").length),
    ).toBe(2);
    await page.screenshot({
      path: testInfo.outputPath("named-editor-desktop.png"),
      fullPage: true,
    });
    binding.currentPath = "docs/planning/" + "long-shared-file-name-".repeat(7) + "notes.md";
    await page.getByRole("button", { name: "Refresh files", exact: true }).click();
    const longFile = page.getByRole("button", { name: binding.currentPath, exact: true });
    await longFile.click();
    await expect(editor).toHaveAttribute("contenteditable", "true");
    await expect(longFile).toHaveAttribute("aria-current", "page");
    await longFile.focus();
    await page.keyboard.press("Tab");
    await page.keyboard.press("Shift+Tab");
    await expect(longFile).toBeFocused();
    expect(await longFile.evaluate((node) => getComputedStyle(node).outlineStyle)).not.toBe("none");
    await page.screenshot({
      path: testInfo.outputPath("named-editor-long-path.png"),
      fullPage: true,
    });
    await page.setViewportSize({ width: 390, height: 844 });
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    expect(
      await editor.evaluate((node) => node.getBoundingClientRect().height),
    ).toBeGreaterThanOrEqual(360);
    await page.screenshot({ path: testInfo.outputPath("named-editor-narrow.png"), fullPage: true });
    host.control.accept = false;
    await editor.click();
    await page.keyboard.press("Control+End");
    await page.keyboard.insertText(" Unsynced draft.");
    await expect(page.getByRole("status")).toContainText("Saving changes…");
    await expect(page.getByLabel("Draft recovery")).toHaveCount(0);
    host.refuseSession();
    await expect(editor).toHaveAttribute("contenteditable", "false");
    await box.click();
    await expect(box).not.toBeChecked();
    await expect(page.getByLabel("Draft recovery")).toBeVisible();
    await expect(editor).toContainText("Unsynced draft.");
    await page.getByRole("button", { name: "Open current file", exact: true }).click();
    await expect(page.getByRole("dialog", { name: "Discard this draft?" })).toBeVisible();
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    await page.screenshot({
      path: testInfo.outputPath("named-editor-discard-narrow.png"),
      fullPage: true,
    });
    await page.getByRole("button", { name: "Keep reviewing", exact: true }).click();
    await expect(editor).toContainText("Unsynced draft.");
    await page.screenshot({ path: testInfo.outputPath("named-recipient.png"), fullPage: true });
    await page.setViewportSize({ width: 1280, height: 860 });
    await page.screenshot({
      path: testInfo.outputPath("named-editor-recovery-desktop.png"),
      fullPage: true,
    });
    host.expectNoFailures();
  } finally {
    await host.close();
  }
});
