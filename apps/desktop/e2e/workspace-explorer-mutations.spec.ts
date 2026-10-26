import { editorTabTestId } from "../src/testPins";
import { DOCUMENT_END } from "./helpers/keys";
import { expect, test } from "@playwright/test";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { cleanupTestScratch, createTestScratch } from "../src/workspaces/testTemp";
import { launchDesktopApp } from "./helpers/desktopApp";
import {
  cleanupDesktopWorkspace,
  createTempWorkspace,
  explorerRow,
  openWorkspaceFromFirstRun,
  revealExplorerPath,
  waitForWorkspaceFile,
  writeWorkspaceFiles,
} from "./helpers/workspace";

async function pathExists(path: string): Promise<boolean> {
  return await access(path).then(
    () => true,
    () => false,
  );
}

test("Explorer creates, renames, cancels, and confirms recoverable deletion", async () => {
  const temp = await createTempWorkspace();
  let desktop: Awaited<ReturnType<typeof launchDesktopApp>> | null = null;

  try {
    desktop = await launchDesktopApp({ workspace: temp });
    const page = desktop.page;
    await openWorkspaceFromFirstRun(page, temp);

    const filesHeader = page.getByTestId("explorer-files-header");
    await page.keyboard.press("ControlOrMeta+n");
    await page.getByLabel("Page title").fill("Welcome");
    await page.getByLabel("Page title").press("Enter");
    await expect(explorerRow(page, "Welcome.md")).toBeVisible();
    await expect.poll(() => pathExists(join(temp.rootPath, "Welcome.md"))).toBe(true);
    const welcomeTab = page.getByTestId(editorTabTestId("Welcome.md"));
    await expect(welcomeTab).toBeVisible({ timeout: 15_000 });
    await expect(welcomeTab).toHaveAttribute("data-active", "true");
    await expect(page.getByTestId("markdown-editor")).toBeVisible({ timeout: 15_000 });

    await filesHeader.getByRole("button", { name: "New folder" }).click();
    await page.getByRole("textbox", { name: "New folder name" }).fill("Research");
    await page.getByRole("textbox", { name: "New folder name" }).press("Enter");
    await expect(explorerRow(page, "Research")).toBeVisible();
    await expect.poll(() => pathExists(join(temp.rootPath, "Research"))).toBe(true);

    await explorerRow(page, "Research").click();
    await filesHeader.getByRole("button", { name: "New file" }).click();
    await page.getByLabel("Page title").fill("notes");
    await page.getByLabel("Page title").press("Enter");
    await expect(explorerRow(page, "Research/notes.md")).toBeVisible();
    await expect
      .poll(() => pathExists(join(temp.rootPath, "Research", "notes.md")))
      .toBe(true);

    const created = explorerRow(page, "Research/notes.md");
    await created.click();
    await created.press("F2");
    const rename = page.getByRole("textbox", { name: "New name" });
    await rename.fill("plan.md");
    await rename.press("Enter");
    const renamed = explorerRow(page, "Research/plan.md");
    await expect(renamed).toBeVisible();
    await expect
      .poll(() => pathExists(join(temp.rootPath, "Research", "notes.md")))
      .toBe(false);
    await expect
      .poll(() => pathExists(join(temp.rootPath, "Research", "plan.md")))
      .toBe(true);

    await renamed.click();
    await renamed.press("Delete");
    const confirmation = page.getByTestId("delete-confirm");
    await expect(confirmation).toContainText(
      "It moves to the system trash, or to this workspace's .dohc/local/trash folder",
    );
    await confirmation.getByRole("button", { name: "Cancel" }).click();
    await expect(renamed).toBeVisible();

    await renamed.click();
    await renamed.press("Delete");
    await page.getByTestId("confirm-delete").click();
    await expect(renamed).toHaveCount(0);
    await expect
      .poll(() => pathExists(join(temp.rootPath, "Research", "plan.md")))
      .toBe(false);
  } finally {
    await cleanupDesktopWorkspace(desktop, temp);
  }
});

test("renaming a file without an extension keeps it without one", async () => {
  const temp = await createTempWorkspace();
  let desktop: Awaited<ReturnType<typeof launchDesktopApp>> | null = null;

  try {
    await writeWorkspaceFiles(temp, [{ path: "LICENSE", contents: "MIT\n" }]);
    desktop = await launchDesktopApp({ workspace: temp });
    const page = desktop.page;
    const workspace = await openWorkspaceFromFirstRun(page, temp);
    await waitForWorkspaceFile(page, workspace.workspaceId, "LICENSE");

    const license = explorerRow(page, "LICENSE");
    await license.click();
    await license.press("F2");
    const rename = page.getByRole("textbox", { name: "New name" });
    await expect(rename).toHaveValue("LICENSE");
    await rename.press("Enter");
    await expect(rename).toHaveCount(0);
    await expect(license).toBeVisible();

    await license.press("F2");
    await rename.fill("NOTICE");
    await rename.press("Enter");
    await expect(explorerRow(page, "NOTICE")).toBeVisible();
    await expect.poll(() => pathExists(join(temp.rootPath, "NOTICE"))).toBe(true);
    await expect.poll(() => pathExists(join(temp.rootPath, "LICENSE"))).toBe(false);
    expect(await pathExists(join(temp.rootPath, "LICENSE.md"))).toBe(false);
    expect(await pathExists(join(temp.rootPath, "NOTICE.md"))).toBe(false);
    await expect(page.getByTestId("workspace-shell-error")).toHaveCount(0);
  } finally {
    await cleanupDesktopWorkspace(desktop, temp);
  }
});

test("renaming a live Markdown file first lands the newest editor update", async () => {
  const temp = await createTempWorkspace();
  let desktop: Awaited<ReturnType<typeof launchDesktopApp>> | null = null;
  const marker = "rename-keeps-this-edit";

  try {
    await writeWorkspaceFiles(temp, [
      { path: "notes.md", contents: "# Notes\n\nBase.\n" },
    ]);
    desktop = await launchDesktopApp({ workspace: temp });
    const page = desktop.page;
    const workspace = await openWorkspaceFromFirstRun(page, temp);
    await waitForWorkspaceFile(page, workspace.workspaceId, "notes.md");

    const row = explorerRow(page, "notes.md");
    await row.click();
    const editor = page.getByTestId("markdown-editor");
    await expect(editor).toBeVisible();
    await editor.click();
    await page.keyboard.press(DOCUMENT_END);
    await page.keyboard.insertText(`\n${marker}`);
    await expect(editor).toContainText(marker);

    // Do not wait for the provider's batch timer or save indicator. Explorer's
    // mutation barrier must force this renderer-only edit to main before main
    // settles and closes the old-path live session.
    await row.press("F2");
    const rename = page.getByRole("textbox", { name: "New name" });
    await rename.fill("plan.md");
    await rename.press("Enter");

    await expect(explorerRow(page, "plan.md")).toBeVisible();
    await expect(explorerRow(page, "notes.md")).toHaveCount(0);
    await expect(page.getByTestId("editor-tabs")).toContainText("plan.md");
    await expect(page.getByTestId("workspace-shell-error")).toHaveCount(0);
    await expect(page.getByTestId("markdown-save-state")).toHaveAttribute(
      "data-state",
      "saved",
    );
    await expect
      .poll(async () =>
        await readFile(join(temp.rootPath, "plan.md"), "utf8").catch(() => ""),
      )
      .toContain(marker);
    await expect
      .poll(() => pathExists(join(temp.rootPath, "notes.md")))
      .toBe(false);
  } finally {
    await cleanupDesktopWorkspace(desktop, temp);
  }
});

// Finder and File Explorer drag a folder, or a bundle document such as .rtfd,
// as one item. A real OS drag through Chromium (Input.dispatchDragEvent
// carries the folder's path) copies it whole and leaves Finder's files behind.
test("dropping a folder from the OS imports it whole", async ({}, testInfo) => {
  const temp = await createTempWorkspace();
  let desktop: Awaited<ReturnType<typeof launchDesktopApp>> | null = null;
  try {
    const outside = await createTestScratch("dohc-drop-");
    const trip = join(outside, "Trip");
    await mkdir(join(trip, "photos"), { recursive: true });
    await writeFile(join(trip, "plan.md"), "# Plan\n");
    await writeFile(join(trip, "photos", "beach.txt"), "sand\n");
    await writeFile(join(trip, "photos", ".DS_Store"), "finder");
    await writeWorkspaceFiles(temp, [{ path: "notes.md", contents: "# Notes\n" }]);
    desktop = await launchDesktopApp({ workspace: temp });
    const { app, page } = desktop;
    const workspace = await openWorkspaceFromFirstRun(page, temp);
    await waitForWorkspaceFile(page, workspace.workspaceId, "notes.md");

    const dropFromOs = async (path: string) => {
      const box = await page.getByTestId("file-tree").boundingBox();
      if (!box) throw new Error("The file tree has no bounding box");
      const point = { x: Math.round(box.x + box.width / 2), y: Math.round(box.y + box.height - 24) };
      const cdp = await app.context().newCDPSession(page);
      const data = { items: [], files: [path], dragOperationsMask: 1 };
      for (const type of ["dragEnter", "dragOver", "drop"] as const) {
        await cdp.send("Input.dispatchDragEvent", { type, ...point, data });
      }
      await cdp.detach();
    };

    // The Explorer shows what landed, so the drop selects it instead of a toast.
    await dropFromOs(trip);
    await expect(explorerRow(page, "Trip")).toHaveAttribute("aria-selected", "true");
    await expect(explorerRow(page, "Trip")).toBeFocused();
    await expect(page.getByTestId("workspace-shell-notice")).toHaveCount(0);
    await revealExplorerPath(page, "Trip/photos/beach.txt");
    await expect(explorerRow(page, "Trip/plan.md")).toBeVisible();
    expect(await readFile(join(temp.rootPath, "Trip", "photos", "beach.txt"), "utf8")).toBe("sand\n");
    expect(await pathExists(join(temp.rootPath, "Trip", "photos", ".DS_Store"))).toBe(false);
    await page.screenshot({ path: testInfo.outputPath("folder-drop.png") });

    // A drop of empty folders lands no file, and the folder it landed is
    // selected all the same.
    await mkdir(join(outside, "Empty", "Inner"), { recursive: true });
    await dropFromOs(join(outside, "Empty"));
    await expect(explorerRow(page, "Empty")).toHaveAttribute("aria-selected", "true");
    await expect(explorerRow(page, "Empty")).toBeFocused();
    await revealExplorerPath(page, "Empty/Inner");
    await expect(page.getByTestId("workspace-shell-notice")).toHaveCount(0);
    await page.screenshot({ path: testInfo.outputPath("empty-folder-drop.png") });
  } finally {
    await cleanupDesktopWorkspace(desktop, temp);
    await cleanupTestScratch();
  }
});
