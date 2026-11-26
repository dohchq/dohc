import { expect, test, type Page } from "@playwright/test";
import { readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { launchDesktopApp, type LaunchedDesktopApp } from "./helpers/desktopApp";
import { DOCUMENT_END } from "./helpers/keys";
import {
  cleanupDesktopWorkspace,
  createTempWorkspace,
  explorerRow,
  openWorkspaceFromFirstRun,
  waitForWorkspaceFile,
  writeWorkspaceFiles,
} from "./helpers/workspace";

const PATH = "plan.md";
const env = { DOHC_ENGINE_NOTE_BODY_SEQUENCE: "1", DOHC_ENGINE_NEW_NOTE_BODY_SEQUENCE: "1" };

async function openNote(page: Page, rootPath: string) {
  const workspace = await openWorkspaceFromFirstRun(page, { rootPath });
  await waitForWorkspaceFile(page, workspace.workspaceId, PATH);
  await explorerRow(page, PATH).click();
  const editor = page.getByTestId("markdown-editor").first();
  await expect(editor).toHaveAttribute("contenteditable", "true", { timeout: 15_000 });
  await expect(editor).toHaveAttribute("data-note-format", "2");
  return editor;
}

const onDisk = (rootPath: string) => readFile(join(rootPath, PATH), "utf8");

async function menuUndo(desktop: LaunchedDesktopApp) {
  await desktop.app.evaluate(({ BrowserWindow, Menu }) => {
    const window = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]!;
    const entry = Menu.getApplicationMenu()!
      .items.flatMap((item) => item.submenu?.items ?? [])
      .find((item) => item.role === "undo")!;
    entry.click(undefined, window, window.webContents);
  });
}

test("a format-2 note edits, undoes, saves, splits, reloads and restarts @body-sequence-note", async () => {
  test.setTimeout(240_000);
  const temp = await createTempWorkspace();
  let desktop: LaunchedDesktopApp | null = null;
  try {
    await writeWorkspaceFiles(temp, [{ path: PATH, contents: "# Plan\n\nPack bags.\n" }]);
    desktop = await launchDesktopApp({ workspace: temp, env });
    const { page } = desktop;
    const editor = await openNote(page, temp.rootPath);

    await editor.getByText("Pack bags.").click();
    await page.keyboard.press(DOCUMENT_END);
    await page.keyboard.type(" Then ");
    await page.keyboard.press("ControlOrMeta+b");
    await page.keyboard.type("leave");
    await page.keyboard.press("ControlOrMeta+b");
    await page.keyboard.type(".x");
    await page.keyboard.press("Backspace");
    await page.keyboard.press("Enter");
    await page.keyboard.type("- Milk");
    await page.keyboard.press("Enter");
    await page.keyboard.type("Eggs");
    await page.keyboard.press("Enter");
    await page.keyboard.press("Enter");
    await page.keyboard.type("[ ] Call home");
    await expect(editor.locator("strong")).toHaveText("leave");
    await expect(editor.locator("ul:not([data-type]) > li")).toHaveText(["Milk", "Eggs"]);
    await expect(editor.locator('ul[data-type="taskList"] li p')).toHaveText("Call home");
    await expect
      .poll(() => onDisk(temp.rootPath), { timeout: 20_000 })
      .toMatch(
        /^# Plan\r?\n\r?\nPack bags\. Then \*\*leave\*\*\.\r?\n\r?\n- Milk\r?\n- Eggs\r?\n\r?\n- \[ \] Call home\s*$/,
      );

    await page.keyboard.type(" now");
    await page.keyboard.press("ControlOrMeta+z");
    await expect(editor.locator('ul[data-type="taskList"] li p')).toHaveText("Call home");
    await page.keyboard.press("ControlOrMeta+Shift+z");
    await expect(editor.locator('ul[data-type="taskList"] li p')).toHaveText("Call home now");
    await menuUndo(desktop);
    await expect(editor.locator('ul[data-type="taskList"] li p')).toHaveText("Call home");
    await page.keyboard.press("ControlOrMeta+y");
    await expect(editor.locator('ul[data-type="taskList"] li p')).toHaveText("Call home now");

    await page.getByTestId("create-editor-group-right").click();
    const right = page
      .getByRole("region", { name: "Editor group 2" })
      .getByTestId("markdown-editor");
    const left = page
      .getByRole("region", { name: "Editor group 1" })
      .getByTestId("markdown-editor");
    await expect(right).toHaveAttribute("data-note-format", "2");
    await right.getByText("Eggs").click();
    await page.keyboard.press("End");
    await page.keyboard.type(" and bread");
    await expect(left.locator("ul:not([data-type]) > li")).toHaveText(["Milk", "Eggs and bread"]);
    await page.keyboard.press("ControlOrMeta+z");
    await expect(left.locator("ul:not([data-type]) > li")).toHaveText(["Milk", "Eggs"]);
    await page.keyboard.press("ControlOrMeta+Shift+z");
    await expect(left.locator("ul:not([data-type]) > li")).toHaveText(["Milk", "Eggs and bread"]);
    await expect
      .poll(() => onDisk(temp.rootPath), { timeout: 20_000 })
      .toContain("- Eggs and bread");
    await expect(page.getByTestId("markdown-save-state").first()).toHaveAttribute(
      "data-state",
      "saved",
      { timeout: 20_000 },
    );

    const outside = "# Plan\n\nWritten by an agent.\n";
    await writeFile(join(temp.rootPath, `${PATH}.tmp`), outside);
    await rename(join(temp.rootPath, `${PATH}.tmp`), join(temp.rootPath, PATH));
    await expect(left).toContainText("Written by an agent.", { timeout: 30_000 });
    await expect(right).toContainText("Written by an agent.");
    await expect(left).toHaveAttribute("data-note-format", "2");
    await left.getByText("Written by an agent.").click();
    await page.keyboard.press(DOCUMENT_END);
    await page.keyboard.type(" Checked.");
    await expect
      .poll(() => onDisk(temp.rootPath), { timeout: 20_000 })
      .toMatch(/^# Plan\r?\n\r?\nWritten by an agent\. Checked\.\s*$/);
    await expect(page.getByTestId("markdown-save-state").first()).toHaveAttribute(
      "data-state",
      "saved",
      { timeout: 20_000 },
    );

    await desktop.close();
    desktop = await launchDesktopApp({ workspace: temp, env });
    const reopened = await openNote(desktop.page, temp.rootPath);
    await expect(reopened).toContainText("Written by an agent. Checked.");
    await reopened.getByText("Written by an agent. Checked.").click();
    await desktop.page.keyboard.press(DOCUMENT_END);
    await desktop.page.keyboard.type(" Again.");
    await expect
      .poll(() => onDisk(temp.rootPath), { timeout: 20_000 })
      .toMatch(/^# Plan\r?\n\r?\nWritten by an agent\. Checked\. Again\.\s*$/);
  } finally {
    await cleanupDesktopWorkspace(desktop, temp);
  }
});
