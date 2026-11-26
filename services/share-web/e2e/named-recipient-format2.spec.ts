import { test, expect, type Page } from "@playwright/test";
import { yDocToMarkdown } from "@dohc/ydoc-projection";
import { openNamedRecipient } from "./namedRecipientFixture";

const DEEPEST = 32;
const note = [
  "# Trip notes",
  "",
  "- [ ] tick me",
  "",
  "Packing:",
  "",
  "- tent",
  "- stove",
  "",
  "Edit together.",
].join("\n");
const deepNote = [
  "Deep list:",
  "",
  ...Array.from({ length: DEEPEST }, (_, level) => `${"  ".repeat(level)}- level ${level + 1}`),
  `${"  ".repeat(DEEPEST - 1)}- deepest`,
].join("\n");

const pressed = (page: Page, name: string, value: boolean) =>
  expect(
    page.getByRole("toolbar", { name: "Formatting" }).getByRole("button", { name, exact: true }),
  ).toHaveAttribute("aria-pressed", String(value));

test("a note in format 2 opens once it syncs, takes every kind of edit the save takes, and keeps an unsent draft for review", async ({
  browser,
}) => {
  const host = await openNamedRecipient(browser, note, { bodySequence: true, holdSync: true });
  const { doc, page, editor } = host;
  const markdown = () => yDocToMarkdown(doc);
  try {
    await host.vectorAsked;
    await expect(page.getByRole("status")).toContainText("Opening the file…");
    await expect(editor).toHaveCount(0);
    host.releaseSync();
    await expect(editor).toHaveAttribute("contenteditable", "true");
    await expect(editor).toContainText("Edit together.");

    await editor.getByText("Edit together.").click();
    await page.keyboard.press("End");
    await page.keyboard.insertText(" Browser edit.");
    await expect.poll(markdown).toContain("Edit together. Browser edit.");
    await expect(page.getByRole("status")).toContainText("Changes saved");
    const box = editor.getByRole("checkbox");
    await box.click();
    await expect.poll(markdown).toContain("- [x] tick me");
    await expect(box).toBeChecked();
    await box.click();
    await expect.poll(markdown).toContain("- [ ] tick me");
    await expect(box).not.toBeChecked();

    const toolbar = page.getByRole("toolbar", { name: "Formatting" });
    await editor.getByText("stove", { exact: true }).click();
    await page.keyboard.press("End");
    await pressed(page, "Bullet list", true);
    await page.keyboard.press("Enter");
    await page.keyboard.insertText("lamp");
    await expect.poll(markdown).toContain("- stove\n- lamp");
    await page.keyboard.press("Tab");
    await expect.poll(markdown).toContain("- stove\n  - lamp");
    await page.keyboard.press("Shift+Tab");
    await expect.poll(markdown).toContain("- stove\n- lamp");

    await editor.getByText("Edit together. Browser edit.").click();
    await pressed(page, "Bullet list", false);
    await toolbar.getByRole("button", { name: "Quote", exact: true }).click();
    await pressed(page, "Quote", true);
    await expect.poll(markdown).toContain("> Edit together. Browser edit.");
    for (const redo of ["ControlOrMeta+Shift+z", "ControlOrMeta+y", "ControlOrMeta+Shift+Z"]) {
      await page.keyboard.press("ControlOrMeta+z");
      await expect.poll(markdown).not.toContain("> Edit together.");
      await page.keyboard.press(redo);
      await expect.poll(markdown).toContain("> Edit together. Browser edit.");
    }
    for (const key of ["ControlOrMeta+Shift+z", "ControlOrMeta+y"]) {
      await page.keyboard.press(key);
      await expect(editor).toContainText("lamp");
    }
    await expect.poll(markdown).toContain("> Edit together. Browser edit.");
    await expect.poll(markdown).toContain("- stove\n- lamp");

    await editor.getByText("tent", { exact: true }).click({ clickCount: 3 });
    await pressed(page, "Bullet list", true);
    await toolbar.getByRole("button", { name: "Bold", exact: true }).focus();
    await page.keyboard.press("Tab");
    await expect(toolbar.getByRole("button", { name: "Italic", exact: true })).toBeFocused();
    await page.keyboard.press("Shift+Tab");
    const bold = toolbar.getByRole("button", { name: "Bold", exact: true });
    await expect(bold).toBeFocused();
    expect(await bold.evaluate((node) => getComputedStyle(node).outlineStyle)).not.toBe("none");
    await page.keyboard.press("Enter");
    await expect.poll(markdown).toContain("- **tent**");
    await expect(bold).toHaveAttribute("aria-pressed", "true");

    host.control.accept = false;
    await editor.getByText("Edit together. Browser edit.").click();
    await page.keyboard.press("End");
    await page.keyboard.insertText(" Later.");
    await editor.getByText("Trip notes", { exact: true }).click();
    await page.keyboard.press("Home");
    await page.keyboard.insertText("Our ");
    await expect(page.getByRole("status")).toContainText("Saving changes…");
    host.refuseSession();
    await expect(editor).toHaveAttribute("contenteditable", "false");
    const review = page.getByLabel("Draft recovery");
    await expect(review).toBeVisible();
    expect(await review.locator("blockquote").evaluate((node) => node.textContent)).toBe(
      "Our \n Later.",
    );
    host.expectNoFailures();
  } finally {
    await host.close();
  }
});

test("a Tab that would nest a list item past the deepest a note holds writes nothing and says why", async ({
  browser,
}) => {
  const host = await openNamedRecipient(browser, deepNote, { bodySequence: true });
  const { doc, page, editor } = host;
  const markdown = () => yDocToMarkdown(doc);
  try {
    await expect(editor).toHaveAttribute("contenteditable", "true");
    await pressed(page, "Bullet list", false);
    const before = markdown();
    await editor.focus();
    await page.keyboard.press("ControlOrMeta+End");
    await pressed(page, "Bullet list", true);
    await page.keyboard.press("Tab");
    const notice = page.getByTestId("unwritten-notice");
    await expect(notice).toContainText(
      "dohc can't save this change in a live note yet, so it put the note back as it was.",
    );
    expect(markdown()).toBe(before);
    await expect(editor.getByText("deepest", { exact: true })).toHaveCount(1);
    await notice.getByRole("button", { name: "Dismiss", exact: true }).click();
    await expect(notice).toHaveCount(0);
    host.expectNoFailures();
  } finally {
    await host.close();
  }
});
