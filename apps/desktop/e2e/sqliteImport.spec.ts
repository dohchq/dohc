import { expect, test } from "@playwright/test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { launchApp, openInTree as openTreePath } from "./launch";

const SHOT_DIR = "test-results/screenshots/phase-08";

// A workspace with a CSV ready to import. imports/ and finance/ are just
// ordinary user folders — there is no fixed structure.
async function seededWorkspace(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), "dohc-sql-home-"));
  const root = join(await mkdtemp(join(tmpdir(), "dohc-sql-")), "workspace");
  await mkdir(join(root, ".dohc"), { recursive: true });
  await writeFile(
    join(root, ".dohc", "manifest.json"),
    JSON.stringify({ version: 1, workspaceId: "sql-ws", kind: "personal", mode: "local-first" }),
  );
  await mkdir(join(root, "imports"), { recursive: true });
  await writeFile(
    join(root, "imports", "wallet.csv"),
    "id,amount,category\ntxn_001,42,Food\ntxn_002,10,Transport\n",
  );
  return JSON.stringify({ home, root });
}

test("import a CSV to SQLite, browse it in the studio, edit a cell, and it persists", async () => {
  const { home, root } = JSON.parse(await seededWorkspace());
  const app = await launchApp({ DOHC_TEST_HOME: home, DOHC_TEST_PICK_PATH: root });
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
  await expect(page.getByTestId("db-cell-category-txn_001")).toHaveText("Food");
  await expect(page.getByTestId("db-cell-category-txn_002")).toHaveText("Transport");
  await page.screenshot({ path: `${SHOT_DIR}/studio--1280x800--light.png` });

  // The materialized .sqlite is a real, visible workspace file (reveal in
  // the nested tree without re-opening it — the studio is already on it).
  await openTreePath(page, "imports/wallet.sqlite", { click: false });

  // 3. Edit a category cell in place.
  await page.getByTestId("db-cell-category-txn_001").click();
  const input = page.getByTestId("db-cell-input");
  await input.fill("Groceries");
  await input.press("Enter");
  await expect(page.getByTestId("db-cell-category-txn_001")).toHaveText("Groceries");

  // 4. Reopen the database from disk and confirm the edit persisted (the
  //    on-disk SQLite file is canonical).
  await openInTree("imports/wallet.csv");
  await expect(page.getByTestId("view-csv")).toBeVisible();
  await openInTree("imports/wallet.sqlite");
  await expect(page.getByTestId("view-database")).toBeVisible();
  await expect(page.getByTestId("db-cell-category-txn_001")).toHaveText("Groceries");

  await app.close();
});
