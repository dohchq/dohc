import { expect, test, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { REF_SELECTED } from "../src/renderer/ui/refChip";
import { launchDesktopApp } from "./helpers/desktopApp";
import { holdSystemClipboard } from "./helpers/systemClipboard";
import {
  cleanupDesktopWorkspace,
  createTempWorkspace,
  explorerRow,
  openWorkspaceFromFirstRun,
  waitForWorkspaceFile,
  writeWorkspaceFiles,
  type TempWorkspace,
} from "./helpers/workspace";

// A wikilink read from the file is an atom the editor draws as the reference
// chip. The keyboard steps onto it and past it, Backspace removes it whole,
// text typed beside it stays beside it, and a copied paragraph pastes it back
// as the same link. This needs the real caret and clipboard.

const LINK = "[[notes/roads|Roads]]";

async function withPlan(run: (page: Page, temp: TempWorkspace) => Promise<void>): Promise<void> {
  test.setTimeout(120_000);
  const temp = await createTempWorkspace();
  let desktop: Awaited<ReturnType<typeof launchDesktopApp>> | null = null;
  try {
    await writeWorkspaceFiles(temp, [
      { path: "plan.md", contents: `# Plan\n\nBefore ${LINK} after.\n` },
      { path: "notes/roads.md", contents: "# Roads\n" },
    ]);
    desktop = await launchDesktopApp({ workspace: temp });
    const workspace = await openWorkspaceFromFirstRun(desktop.page, temp);
    await waitForWorkspaceFile(desktop.page, workspace.workspaceId, "notes/roads.md");
    await explorerRow(desktop.page, "plan.md").click();
    await expect(desktop.page.getByTestId("markdown-editor")).toBeVisible({ timeout: 20_000 });
    await run(desktop.page, temp);
    expect(desktop.logs.filter((entry) => entry.level === "pageerror")).toEqual([]);
  } finally {
    await cleanupDesktopWorkspace(desktop, temp);
  }
}

const occurrences = async (temp: TempWorkspace, text: string) =>
  (await readFile(join(temp.rootPath, "plan.md"), "utf8")).split(text).length - 1;

test("a wikilink pill takes the arrows, typing beside it and Backspace as one atom", async () => {
  await withPlan(async (page, temp) => {
    const editor = page.getByTestId("markdown-editor");
    const line = editor.locator("p").first();
    const pill = line.locator('.dohc-wikilink-pill[data-dohc-wikilink="notes/roads"]');
    await expect(pill).toHaveText("Roads");

    // The arrows step onto the pill, selecting it whole, then past it.
    await line.click();
    await page.keyboard.press("End");
    for (const _ of " after.") await page.keyboard.press("ArrowLeft");
    await expect(pill).not.toContainClass(REF_SELECTED);
    await page.keyboard.press("ArrowLeft");
    await expect(pill).toContainClass(REF_SELECTED);
    await page.keyboard.press("ArrowLeft");
    await expect(pill).not.toContainClass(REF_SELECTED);
    await page.keyboard.type("X");
    await expect(line).toHaveText("Before XRoads after.");
    await page.keyboard.press("ArrowRight");
    await expect(pill).toContainClass(REF_SELECTED);
    await page.keyboard.press("ArrowRight");
    await expect(pill).not.toContainClass(REF_SELECTED);
    await page.keyboard.type("Y");
    await expect(line).toHaveText("Before XRoadsY after.");
    await expect(pill).toHaveCount(1);
    await expect.poll(() => occurrences(temp, `Before X${LINK}Y after.`)).toBe(1);

    // Backspace takes the typed letter, then the whole pill. Undo brings the
    // pill back; edits made close together undo as one step, so how many of
    // the typed letters and deletions it takes back depends on timing.
    await page.keyboard.press("Backspace");
    await expect(line).toHaveText("Before XRoads after.");
    await page.keyboard.press("Backspace");
    await expect(pill).toHaveCount(0);
    await expect(line).toHaveText("Before X after.");
    await expect.poll(() => occurrences(temp, LINK)).toBe(0);
    await page.keyboard.press("ControlOrMeta+z");
    await expect(pill).toHaveCount(1);
    await expect(pill).toHaveAttribute("data-dohc-wikilink-label", "Roads");
    await expect(line).toHaveText(/^Before X?RoadsY? after\.$/);
    await expect.poll(() => occurrences(temp, LINK)).toBe(1);
  });
});

// The `wikilink` node writes its link to data-dohc-wikilink and
// data-dohc-wikilink-label but parses neither back (dohc-markdown-extensions.ts),
// so a paste makes a pill with an empty target and the file gets `[[]]`.
test.fixme("a copied paragraph pastes its wikilink pill back as the same link", async () => {
  await withPlan(async (page, temp) => {
    const editor = page.getByTestId("markdown-editor");
    const line = editor.locator("p").first();
    await holdSystemClipboard(test.info(), async (remainingMs) => {
      await line.click({ timeout: remainingMs() });
      await page.keyboard.press("Home");
      await page.keyboard.press("Shift+End");
      await page.keyboard.press("ControlOrMeta+c");
      await page.keyboard.press("End");
      await page.keyboard.press("Enter");
      await page.keyboard.press("ControlOrMeta+v");
      await expect(editor.locator('.dohc-wikilink-pill[data-dohc-wikilink="notes/roads"]')).toHaveCount(2, { timeout: remainingMs() });
    });
    const pasted = editor.locator("p").nth(1);
    await expect(pasted).toHaveText("Before Roads after.");
    await expect(pasted.locator(".dohc-wikilink-pill")).toHaveAttribute("data-dohc-wikilink-label", "Roads");
    await expect.poll(() => occurrences(temp, `Before ${LINK} after.`)).toBe(2);
  });
});
