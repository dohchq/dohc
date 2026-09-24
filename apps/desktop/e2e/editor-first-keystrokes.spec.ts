import { expect, test, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { launchDesktopApp } from "./helpers/desktopApp";
import {
  cleanupDesktopWorkspace,
  createTempWorkspace,
  explorerRow,
  openWorkspaceFromFirstRun,
  writeWorkspaceFiles,
  type TempWorkspace,
} from "./helpers/workspace";

// The first keys typed after focus reaches a document's editor must land in
// the editor, at the caret the person expects, and reach the file.

type Desktop = Awaited<ReturnType<typeof launchDesktopApp>>;

async function withDesktop(
  files: Array<{ path: string; contents: string }>,
  body: (page: Page, temp: TempWorkspace) => Promise<void>,
): Promise<void> {
  const temp = await createTempWorkspace();
  let desktop: Desktop | null = null;
  try {
    await writeWorkspaceFiles(temp, files);
    desktop = await launchDesktopApp({ workspace: temp });
    await openWorkspaceFromFirstRun(desktop.page, temp);
    await body(desktop.page, temp);
  } finally {
    await cleanupDesktopWorkspace(desktop, temp);
  }
}

async function createDocument(page: Page, name: string): Promise<void> {
  await page.keyboard.press("Control+n");
  const fileName = page.getByRole("textbox", { name: "File name" });
  await expect(fileName).toBeFocused();
  await fileName.fill(name);
  await page.keyboard.press("Enter");
  await expect(page.getByTestId(`tab-${name}`)).toHaveAttribute("data-active", "true", {
    timeout: 15_000,
  });
}

// The engine session is bound once its source toggle is in the header.
async function expectEditorBound(page: Page): Promise<void> {
  await expect(page.getByTestId("markdown-source-toggle")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId("markdown-editor")).toHaveAttribute("contenteditable", "true");
}

async function tabIntoEditor(page: Page): Promise<void> {
  const editor = page.getByTestId("markdown-editor");
  for (let presses = 0; presses < 40; presses += 1) {
    await page.keyboard.press("Tab");
    if (await editor.evaluate((node) => node === document.activeElement)) return;
  }
  throw new Error("Tab did not reach the editor within 40 presses");
}

async function expectSettledFile(
  page: Page,
  temp: TempWorkspace,
  path: string,
  contents: RegExp,
): Promise<void> {
  await expect
    .poll(() => readFile(join(temp.rootPath, path), "utf8").catch(() => ""), { timeout: 20_000 })
    .toMatch(contents);
  await expect(page.getByTestId("markdown-save-state")).toHaveAttribute("data-state", "saved");
}

test("a new document keeps the first line typed after Tab reaches its editor", async () => {
  await withDesktop([], async (page, temp) => {
    await createDocument(page, "trip.md");
    await expectEditorBound(page);

    await tabIntoEditor(page);
    await page.keyboard.type("Trip to Lisbon");
    await page.keyboard.press("Enter");
    await page.keyboard.type("Pack the charger");

    const editor = page.getByTestId("markdown-editor");
    await expect(editor.locator("p")).toHaveText(["Trip to Lisbon", "Pack the charger"]);
    await expectSettledFile(page, temp, "trip.md", /^Trip to Lisbon\r?\n\r?\nPack the charger\s*$/);
  });
});

test("keys typed right after the page title's Enter land in the body", async () => {
  await withDesktop([], async (page, temp) => {
    await createDocument(page, "lisbon.md");
    await expectEditorBound(page);

    const title = page.getByLabel("Page title");
    await title.click();
    await page.keyboard.type("Lisbon");
    await page.keyboard.press("End");
    await page.keyboard.press("Enter");
    await page.keyboard.type("Trip to Lisbon");

    await expect(title).toHaveValue("Lisbon");
    await expect(page.getByTestId("markdown-editor").locator("p")).toHaveText(["Trip to Lisbon"]);
    await expectSettledFile(
      page,
      temp,
      "lisbon.md",
      /^---\r?\ntitle: Lisbon\r?\n---\r?\n\r?\nTrip to Lisbon\s*$/,
    );
  });
});

test("keys typed right after Ctrl+N reach the new document while it opens", async () => {
  await withDesktop([], async (page, temp) => {
    await createDocument(page, "packing.md");

    // No wait for the session: the title and the body take keys at once.
    const title = page.getByLabel("Page title");
    await title.click();
    await page.keyboard.type("Packing");
    await tabIntoEditor(page);
    await page.keyboard.type("Charger");
    await page.keyboard.press("Enter");
    await page.keyboard.type("Passport");

    await expect(title).toHaveValue("Packing");
    await expect(page.getByTestId("markdown-editor").locator("p")).toHaveText([
      "Charger",
      "Passport",
    ]);
    await expectSettledFile(
      page,
      temp,
      "packing.md",
      /^---\r?\ntitle: Packing\r?\n---\r?\n\r?\nCharger\r?\n\r?\nPassport\s*$/,
    );
  });
});

test("a line typed after click, Ctrl+End and Enter lands at the end of an existing document", async () => {
  const path = "notes/existing.md";
  await withDesktop(
    [{ path, contents: "# Lisbon, October\n\nFirst paragraph.\n" }],
    async (page, temp) => {
      await explorerRow(page, "notes").click();
      const row = explorerRow(page, path);
      await row.click();
      await expectEditorBound(page);
      await expect(page.getByTestId("markdown-save-state")).toHaveAttribute("data-state", "saved");

      // Mounting the editor leaves focus in the explorer.
      const editor = page.getByTestId("markdown-editor");
      await expect(row).toBeFocused();

      await editor.click();
      await page.keyboard.press("Control+End");
      await page.keyboard.press("Enter");
      await page.keyboard.type("- Ana: appended line");

      await expect(editor.locator("h1")).toHaveText("Lisbon, October");
      await expect(editor.locator("p")).toHaveText(["First paragraph.", "Ana: appended line"]);
      await expectSettledFile(
        page,
        temp,
        path,
        /^# Lisbon, October\r?\n\r?\nFirst paragraph\.\r?\n\r?\n- Ana: appended line\s*$/,
      );
    },
  );
});

test("the page title's Enter reveals a body below the viewport", async () => {
  const path = "notes/long-properties.md";
  const properties = Array.from({ length: 60 }, (_, index) => `field${index}: value`).join("\n");
  await withDesktop(
    [{ path, contents: `---\ntitle: Packing\n${properties}\n---\n\nFirst line.\n` }],
    async (page, temp) => {
      await explorerRow(page, "notes").click();
      await explorerRow(page, path).click();
      await expectEditorBound(page);
      const firstLine = page.getByTestId("markdown-editor").locator("p").first();
      await expect(firstLine).not.toBeInViewport();

      await page.getByLabel("Page title").click();
      await page.keyboard.press("Enter");
      await expect(firstLine).toBeInViewport();

      await page.keyboard.type("Pack: ");
      await expect(firstLine).toHaveText("Pack: First line.");
      await expectSettledFile(page, temp, path, /\r?\n---\r?\n\r?\nPack: First line\.\s*$/);
    },
  );
});
