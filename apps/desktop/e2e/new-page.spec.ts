import { holdSystemClipboard } from "./helpers/systemClipboard";
import { editorTabTestId } from "../src/testPins";
import { expect, test, type Page } from "@playwright/test";
import { readdir, readFile } from "node:fs/promises";
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

// A new page opens at once with the cursor in its title, and its file is
// written only when the person leaves the title. Keys typed before its
// editor is ready land in the body in the order they were typed.

type Desktop = Awaited<ReturnType<typeof launchDesktopApp>>;

async function withDesktop(
  files: Array<{ path: string; contents: string }>,
  body: (page: Page, temp: TempWorkspace, desktop: Desktop) => Promise<void>,
): Promise<void> {
  const temp = await createTempWorkspace();
  let desktop: Desktop | null = null;
  try {
    await writeWorkspaceFiles(temp, files);
    desktop = await launchDesktopApp({ workspace: temp });
    await openWorkspaceFromFirstRun(desktop.page, temp);
    await body(desktop.page, temp, desktop);
  } finally {
    await cleanupDesktopWorkspace(desktop, temp);
  }
}

async function openNewPage(page: Page): Promise<void> {
  await page.keyboard.press("ControlOrMeta+n");
  await expect(page.getByLabel("Page title")).toBeFocused();
}

function fileText(temp: TempWorkspace, path: string): Promise<string> {
  return readFile(join(temp.rootPath, path), "utf8").catch(() => "");
}

async function expectSettledFile(page: Page, temp: TempWorkspace, path: string, contents: RegExp): Promise<void> {
  await expect.poll(() => fileText(temp, path), { timeout: 20_000 }).toMatch(contents);
  await expect(page.getByTestId("markdown-save-state")).toHaveAttribute("data-state", "saved");
}

async function markdownFiles(temp: TempWorkspace): Promise<string[]> {
  return (await readdir(temp.rootPath)).filter((name) => name.endsWith(".md")).sort();
}

test("text, Enter, Backspace and a paste typed right after the title's Enter land in the body in order", async () => {
  await withDesktop([], async (page, temp, desktop) => {
    await holdSystemClipboard(test.info(), async (remainingMs) => {
      await desktop.app.evaluate(({ clipboard }) => clipboard.writeText("and pastéis"));
      await openNewPage(page);
      await page.keyboard.type("Lisbon");
      await expect(explorerRow(page, "Lisbon.md")).toHaveCount(0, { timeout: remainingMs() });
      // No wait between the title's Enter and the body's keys.
      await page.keyboard.press("Enter");
      await page.keyboard.type("Day one");
      await page.keyboard.press("Enter");
      await page.keyboard.type("Tram 28 x");
      await page.keyboard.press("Backspace");
      await page.keyboard.press("ControlOrMeta+V");
      await page.keyboard.type(".");
      await expect(page.getByTestId("markdown-editor").locator("p")).toHaveText(
        ["Day one", "Tram 28 and pastéis."],
        { timeout: remainingMs() },
      );
    });

    await expect(page.getByTestId("new-page")).toHaveCount(0);
    await expect(page.getByTestId("markdown-editor")).toBeFocused();
    await expect(page.getByLabel("Page title")).toHaveValue("Lisbon");
    await expect(explorerRow(page, "Lisbon.md")).toBeVisible();
    await expect(page.getByTestId(editorTabTestId("Lisbon.md"))).toHaveAttribute("data-active", "true");
    await expectSettledFile(page, temp, "Lisbon.md", /^---\r?\ntitle: Lisbon\r?\n---\r?\n\r?\nDay one\r?\n\r?\nTram 28 and pastéis\.\s*$/);
  });
});

test("Tab and a click into the body leave the title, and keys follow at once", async () => {
  await withDesktop([], async (page, temp) => {
    await openNewPage(page);
    await page.keyboard.type("Packing");
    await page.keyboard.press("Tab");
    await page.keyboard.type("Charger");
    await page.keyboard.press("Enter");
    await page.keyboard.type("Passport");
    await expect(page.getByTestId("markdown-editor").locator("p")).toHaveText(["Charger", "Passport"]);
    await expectSettledFile(page, temp, "Packing.md", /^---\r?\ntitle: Packing\r?\n---\r?\n\r?\nCharger\r?\n\r?\nPassport\s*$/);
    await page.keyboard.press("ControlOrMeta+w");
    await expect(page.getByTestId("markdown-editor")).toHaveCount(0);

    await openNewPage(page);
    await page.keyboard.type("Errands");
    await page.getByTestId("new-page").getByLabel("Page body").click();
    await page.keyboard.type("Post office");
    await expect(page.getByTestId("markdown-editor").locator("p")).toHaveText(["Post office"]);
    await expectSettledFile(page, temp, "Errands.md", /^---\r?\ntitle: Errands\r?\n---\r?\n\r?\nPost office\s*$/);
  });
});

test("an empty title makes Untitled, then Untitled 2 when that name is taken", async () => {
  await withDesktop([{ path: "Untitled.md", contents: "Already here.\n" }], async (page, temp) => {
    await expect(explorerRow(page, "Untitled.md")).toBeVisible();
    await openNewPage(page);
    await page.keyboard.press("Enter");
    await page.keyboard.type("A second page");
    await expect(explorerRow(page, "Untitled 2.md")).toBeVisible();
    await expect(page.getByTestId(editorTabTestId("Untitled 2.md"))).toHaveAttribute("data-active", "true");
    await expect(page.getByTestId("new-page")).toHaveCount(0);
    await expect(page.getByLabel("Page title")).toHaveAttribute("placeholder", "Untitled 2");
    await expectSettledFile(page, temp, "Untitled 2.md", /^A second page\s*$/);
    expect(await fileText(temp, "Untitled.md")).toBe("Already here.\n");
  });
});

test("closing a new page writes a typed title and leaves nothing for an untouched one", async () => {
  await withDesktop([], async (page, temp) => {
    await openNewPage(page);
    await page.keyboard.press("ControlOrMeta+w");
    await expect(page.getByTestId("new-page")).toHaveCount(0);

    await openNewPage(page);
    await page.keyboard.type("Groceries");
    await page.keyboard.press("ControlOrMeta+w");
    await expect(page.getByTestId("new-page")).toHaveCount(0);
    await expect(explorerRow(page, "Groceries.md")).toBeVisible();
    await expect.poll(() => fileText(temp, "Groceries.md")).toMatch(/^---\r?\ntitle: Groceries\r?\n---\r?\n/);
    expect(await markdownFiles(temp)).toEqual(["Groceries.md"]);
  });
});

test("New file in a folder makes the page there, in the tree only once its file exists", async () => {
  await withDesktop([{ path: "Trip/plan.md", contents: "# Plan\n" }], async (page, temp) => {
    await explorerRow(page, "Trip").click();
    await expect(explorerRow(page, "Trip/plan.md")).toBeVisible();
    await page.getByTestId("explorer-files-header").getByRole("button", { name: "New file" }).click();
    await expect(page.getByLabel("Page title")).toBeFocused();
    await expect(page.getByTestId("tree-edit-input")).toHaveCount(0);

    await page.keyboard.type("Budget");
    await expect(explorerRow(page, "Trip/Budget.md")).toHaveCount(0);
    expect(await fileText(temp, "Trip/Budget.md")).toBe("");
    await page.keyboard.press("Enter");
    await page.keyboard.type("Flights first");
    await expect(explorerRow(page, "Trip/Budget.md")).toBeVisible();
    await expectSettledFile(page, temp, "Trip/Budget.md", /^---\r?\ntitle: Budget\r?\n---\r?\n\r?\nFlights first\s*$/);
  });
});
