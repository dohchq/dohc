import { expect, test } from "@playwright/test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ElectronApplication, Page } from "playwright";
import { launchApp, openInTree as openTreePath } from "./launch";

const SHOT_DIR = "test-results/screenshots/e5-database-studio";
let activeApp: ElectronApplication | null = null;

test.afterEach(async () => {
  await activeApp?.close().catch(() => undefined);
  activeApp = null;
});

// A workspace with a CSV ready to import. imports/ and finance/ are just
// ordinary user folders — there is no fixed structure.
async function seededWorkspace(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), "dohc-sql-home-"));
  const root = join(await mkdtemp(join(tmpdir(), "dohc-sql-")), "workspace");
  await mkdir(join(root, ".dohc"), { recursive: true });
  await writeFile(
    join(root, ".dohc", "manifest.json"),
    JSON.stringify({
      version: 1,
      workspaceId: "sql-ws",
      kind: "personal",
      mode: "local-first",
    }),
  );
  await mkdir(join(root, "imports"), { recursive: true });
  await writeFile(
    join(root, "imports", "wallet.csv"),
    "id,amount,category\ntxn_001,42,Food\ntxn_002,10,Transport\n",
  );
  return JSON.stringify({ home, root });
}

async function setTheme(page: Page, scheme: "light" | "dark") {
  await page.emulateMedia({ colorScheme: scheme });
  await expect
    .poll(() => page.evaluate(() => document.documentElement.dataset.theme))
    .toBe(scheme);
}

async function shot(page: Page, name: string): Promise<void> {
  await mkdir(SHOT_DIR, { recursive: true });
  const { width, height } = page.viewportSize() ?? { width: 0, height: 0 };
  const scheme = await page.evaluate(() =>
    document.documentElement.dataset.theme === "dark" ? "dark" : "light",
  );
  await page.screenshot({
    path: `${SHOT_DIR}/${name}--${width}x${height}--${scheme}.png`,
  });
}

test("import a CSV to SQLite, browse it in the studio, edit a cell, and it persists", async () => {
  const { home, root } = JSON.parse(await seededWorkspace());
  const app = await launchApp({
    DOHC_TEST_HOME: home,
    DOHC_TEST_PICK_PATH: root,
  });
  activeApp = app;
  const page = await app.firstWindow();

  await page.getByRole("button", { name: /open an existing folder/i }).click();
  await expect(page.getByTestId("workspace-shell")).toBeVisible();

  async function openInTree(path: string) {
    await openTreePath(page, path);
  }

  const { mkdir: mkdirP } = await import("node:fs/promises");
  await mkdirP(SHOT_DIR, { recursive: true });

  // 1. View the CSV, then import it to a sibling SQLite database.
  await openInTree("imports/wallet.csv");
  await expect(page.getByTestId("view-csv")).toBeVisible();
  await page.getByTestId("csv-import-sqlite").click();

  // 2. The studio opens on the new database and shows the imported rows
  //    (a real query against the materialized file).
  await expect(page.getByTestId("view-database")).toBeVisible();
  await expect(page.getByTestId("db-table-list")).toContainText("wallet");
  await expect(page.getByTestId("db-table-list")).toContainText(
    "2 rows · 3 columns",
  );
  await expect(page.getByTestId("db-visible-row-count")).toHaveText(
    "2 of 2 loaded rows",
  );
  await expect(page.getByTestId("db-cell-category-txn_001")).toHaveText("Food");
  await expect(page.getByTestId("db-cell-category-txn_002")).toHaveText(
    "Transport",
  );

  await page.getByTestId("db-sort-amount").click();
  await expect(page.getByTestId("db-row").first()).toContainText("txn_002");
  await page.getByTestId("db-filter-input").fill("transport");
  await expect(page.getByTestId("db-visible-row-count")).toHaveText(
    "1 of 2 loaded rows",
  );
  await expect(page.getByTestId("db-cell-category-txn_002")).toHaveText(
    "Transport",
  );

  for (const size of [
    { width: 1280, height: 800 },
    { width: 1536, height: 960 },
  ]) {
    await page.setViewportSize(size);
    await setTheme(page, "light");
    await shot(page, "database-studio-filtered");
    await setTheme(page, "dark");
    await shot(page, "database-studio-filtered");
  }

  await page.getByTestId("db-filter-input").fill("");
  await expect(page.getByTestId("db-visible-row-count")).toHaveText(
    "2 of 2 loaded rows",
  );

  // The materialized .sqlite is a real, visible workspace file (reveal in
  // the nested tree without re-opening it — the studio is already on it).
  await openTreePath(page, "imports/wallet.sqlite", { click: false });

  // 3. Edit a category cell in place.
  await page.getByTestId("db-cell-category-txn_001").click();
  const input = page.getByTestId("db-cell-input");
  await input.fill("Groceries");
  await input.press("Enter");
  await expect(page.getByTestId("db-cell-category-txn_001")).toHaveText(
    "Groceries",
  );

  // 4. Reopen the database from disk and confirm the edit persisted (the
  //    on-disk SQLite file is canonical).
  await openInTree("imports/wallet.csv");
  await expect(page.getByTestId("view-csv")).toBeVisible();
  await openInTree("imports/wallet.sqlite");
  await expect(page.getByTestId("view-database")).toBeVisible();
  await expect(page.getByTestId("db-cell-category-txn_001")).toHaveText(
    "Groceries",
  );

  await app.close();
  activeApp = null;
});
