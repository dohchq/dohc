import { expect, test } from "@playwright/test";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { ElectronApplication, Page } from "playwright";
import { launchApp, openInTree, runCommand } from "./launch";

const SCREENSHOT_DIR = "test-results/screenshots/e5-import-export";
let activeApp: ElectronApplication | null = null;

test.afterEach(async () => {
  await activeApp?.close().catch(() => undefined);
  activeApp = null;
});

async function seedWorkspace(): Promise<{ home: string; root: string; source: string }> {
  const home = await mkdtemp(join(tmpdir(), "dohc-import-export-home-"));
  const root = join(await mkdtemp(join(tmpdir(), "dohc-import-export-")), "workspace");
  const sourceDir = await mkdtemp(join(tmpdir(), "dohc-import-export-source-"));
  const source = join(sourceDir, "receipt.md");
  await mkdir(join(root, ".dohc"), { recursive: true });
  await writeFile(
    join(root, ".dohc", "manifest.json"),
    JSON.stringify({
      version: 1,
      workspaceId: "import-export-e2e",
      kind: "personal",
      mode: "local-first",
    }),
  );
  await mkdir(dirname(join(root, "notes", "plan.md")), { recursive: true });
  await writeFile(join(root, "notes", "plan.md"), "# Plan\n\nExport me.\n");
  await writeFile(join(root, "readme.md"), "# Readme\n");
  await writeFile(source, "# Receipt\n");
  return { home, root, source };
}

async function openSeeded(home: string, root: string) {
  const app = await launchApp({ DOHC_TEST_HOME: home, DOHC_TEST_PICK_PATH: root });
  activeApp = app;
  const page = await app.firstWindow();
  await page.getByRole("button", { name: /open an existing folder/i }).click();
  await expect(page.getByTestId("workspace-shell")).toBeVisible();
  return { app, page };
}

async function setImportPaths(app: ElectronApplication, paths: string[]): Promise<void> {
  await app.evaluate((_electron, value) => {
    process.env.DOHC_TEST_IMPORT_PATHS = JSON.stringify(value);
  }, paths);
}

async function setSavePath(app: ElectronApplication, path: string): Promise<void> {
  await app.evaluate((_electron, value) => {
    process.env.DOHC_TEST_SAVE_PATH = value;
  }, path);
}

async function setExplorerMenuChoice(
  app: ElectronApplication,
  choice: string | null,
): Promise<void> {
  await app.evaluate((_electron, value) => {
    if (value === null) delete process.env.DOHC_TEST_EXPLORER_MENU_CHOICE;
    else process.env.DOHC_TEST_EXPLORER_MENU_CHOICE = value;
  }, choice);
}

async function setTheme(page: Page, scheme: "light" | "dark") {
  await page.emulateMedia({ colorScheme: scheme });
  await expect
    .poll(() => page.evaluate(() => document.documentElement.dataset.theme))
    .toBe(scheme);
}

async function shot(page: Page, name: string): Promise<void> {
  await mkdir(SCREENSHOT_DIR, { recursive: true });
  const { width, height } = page.viewportSize() ?? { width: 0, height: 0 };
  const scheme = await page.evaluate(() =>
    document.documentElement.dataset.theme === "dark" ? "dark" : "light",
  );
  await page.screenshot({
    path: `${SCREENSHOT_DIR}/${name}--${width}x${height}--${scheme}.png`,
  });
}

function listZip(zip: Buffer): string[] {
  const eocd = zip.length - 22;
  expect(zip.readUInt32LE(eocd)).toBe(0x06054b50);
  const count = zip.readUInt16LE(eocd + 10);
  let cursor = zip.readUInt32LE(eocd + 16);
  const names: string[] = [];
  for (let i = 0; i < count; i++) {
    expect(zip.readUInt32LE(cursor)).toBe(0x02014b50);
    const nameLength = zip.readUInt16LE(cursor + 28);
    const extraLength = zip.readUInt16LE(cursor + 30);
    const commentLength = zip.readUInt16LE(cursor + 32);
    names.push(zip.subarray(cursor + 46, cursor + 46 + nameLength).toString("utf8"));
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  return names;
}

test("data fragments stay distinct from file import and zip export", async () => {
  test.setTimeout(120_000);
  const { home, root, source } = await seedWorkspace();
  const { app, page } = await openSeeded(home, root);
  const outDir = await mkdtemp(join(tmpdir(), "dohc-import-export-out-"));

  await openInTree(page, "notes/plan.md");
  await expect(page.getByTestId("view-markdown")).toBeVisible();
  await page.getByTestId("import-export-open").click();
  const dialog = page.getByTestId("import-export-dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText("Data fragments");
  await expect(dialog).toContainText("Cloud data fragment");
  await expect(dialog).toContainText("notes/plan.md");
  await expect(dialog.getByTestId("fragment-cloud-status")).toContainText(
    "Sign in to dohc Cloud",
  );
  await expect(dialog.getByTestId("fragment-text")).toBeVisible();
  await expect(dialog.getByTestId("fragment-recipient-email")).toBeVisible();
  await expect(dialog.getByTestId("shared-fragment-select")).toBeDisabled();
  await expect(dialog.getByTestId("export-fragment-action")).toBeDisabled();
  await expect(dialog.getByTestId("import-fragment-action")).toBeDisabled();
  await expect(dialog.getByTestId("import-files-action")).toHaveCount(0);
  await expect(dialog.getByTestId("export-current-action")).toHaveCount(0);
  await expect(dialog.getByTestId("export-workspace-action")).toHaveCount(0);
  await page.getByRole("button", { name: /close data fragments dialog/i }).click();
  await expect(dialog).toHaveCount(0);

  await setImportPaths(app, [source]);
  await runCommand(page, "Import files");
  await openInTree(page, "receipt.md", { click: false });
  expect(readFileSync(join(root, "receipt.md"), "utf8")).toBe("# Receipt\n");
  await expect(page.getByTestId("history-timeline")).toContainText("receipt.md", {
    timeout: 15_000,
  });

  const fileZip = join(outDir, "plan.zip");
  await setSavePath(app, fileZip);
  await setExplorerMenuChoice(app, "export-zip");
  await openInTree(page, "notes/plan.md", { click: false });
  await page
    .getByTestId("file-tree")
    .locator('[data-testid="tree-row"][data-path="notes/plan.md"]')
    .click({ button: "right" });
  await expect.poll(() => existsSync(fileZip), { timeout: 10_000 }).toBe(true);
  expect(listZip(readFileSync(fileZip))).toEqual(["plan.md"]);
  await setExplorerMenuChoice(app, null);

  const workspaceZip = join(outDir, "workspace.zip");
  await setSavePath(app, workspaceZip);
  await runCommand(page, "Export workspace as zip");
  await expect.poll(() => existsSync(workspaceZip), { timeout: 10_000 }).toBe(true);
  const entries = listZip(readFileSync(workspaceZip)).sort();
  expect(entries).toEqual(["notes/plan.md", "readme.md", "receipt.md"]);
  expect(entries.some((entry) => entry.includes(".dohc"))).toBe(false);

  for (const size of [
    { width: 1280, height: 800 },
    { width: 1536, height: 960 },
  ]) {
    await page.setViewportSize(size);
    await setTheme(page, "light");
    await shot(page, "import-export-panel");
    await setTheme(page, "dark");
    await shot(page, "import-export-panel");
  }
});
