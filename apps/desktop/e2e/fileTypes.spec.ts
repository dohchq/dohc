import { expect, test } from "@playwright/test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { launchApp, openInTree } from "./launch";

const SHOT_DIR = "test-results/screenshots/phase-06";

// A workspace pre-seeded with one file of every type the inspector handles,
// attached via the test pick seam so we land straight in the shell.
async function seededWorkspace(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), "dohc-ft-home-"));
  const root = join(await mkdtemp(join(tmpdir(), "dohc-ft-")), "workspace");
  await mkdir(join(root, ".dohc"), { recursive: true });
  await writeFile(
    join(root, ".dohc", "manifest.json"),
    JSON.stringify({ version: 1, workspaceId: "ft-ws", kind: "personal", mode: "local-first" }),
  );
  await mkdir(join(root, "notes"), { recursive: true });
  await mkdir(join(root, "data"), { recursive: true });
  await mkdir(join(root, "uploads"), { recursive: true });
  await mkdir(join(root, "finance", ".apps", "ledger", "src"), { recursive: true });
  await writeFile(join(root, "notes", "today.md"), "# Today\n\nA markdown note.");
  await writeFile(join(root, "data", "transactions.csv"), "date,amount\n2026-06-10,42");
  await writeFile(join(root, "data", "config.json"), '{\n  "ready": true\n}');
  // A visible 32x32 solid-blue PNG (not 1x1) so the image view shows content.
  await writeFile(
    join(root, "uploads", "receipt.png"),
    Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAAOklEQVR42u3OMQEAAAgDoJnc6BpjDyRgcrU1qQABAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQGBjwUVDQABkrM5SwAAAABJRU5ErkJggg==",
      "base64",
    ),
  );
  await writeFile(join(root, "uploads", "contract.pdf"), "%PDF-1.4\n%minimal\n");
  await writeFile(join(root, "uploads", "voice.m4a"), Buffer.from([0, 0, 0, 24]));
  // A REAL SQLite database so the studio's happy path is what gets asserted —
  // a bytes-only fake would silently exercise the error state instead.
  const { createRequire } = await import("node:module");
  const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite");
  const db = new DatabaseSync(join(root, "finance", "wallet.sqlite"));
  db.exec("CREATE TABLE transactions (id TEXT PRIMARY KEY, amount INTEGER)");
  db.prepare("INSERT INTO transactions VALUES ('txn_001', 42)").run();
  db.close();
  await writeFile(
    join(root, "finance", ".apps", "ledger", "app.json"),
    '{ "name": "ledger" }',
  );
  return JSON.stringify({ home, root });
}

test("each file type opens its own native view", async () => {
  const { home, root } = JSON.parse(await seededWorkspace());
  const app = await launchApp({ DOHC_TEST_HOME: home, DOHC_TEST_PICK_PATH: root });
  const page = await app.firstWindow();

  await page.getByRole("button", { name: /open an existing folder/i }).click();
  await expect(page.getByTestId("workspace-shell")).toBeVisible();

  async function open(path: string) {
    await openInTree(page, path);
    await expect(page.getByTestId("file-inspector")).toBeVisible();
  }

  const { mkdir: mkdirP } = await import("node:fs/promises");
  await mkdirP(SHOT_DIR, { recursive: true });

  await open("notes/today.md");
  await expect(page.getByTestId("view-markdown")).toContainText("A markdown note.");
  // Rendered as a document: the "# Today" heading becomes an <h1>, hash gone.
  await expect(page.getByTestId("view-markdown").locator("h1")).toHaveText("Today");
  await page.screenshot({ path: `${SHOT_DIR}/markdown--1280x800--light.png` });

  await open("data/transactions.csv");
  await expect(page.getByTestId("view-csv").locator("th")).toHaveCount(2);
  await expect(page.getByTestId("view-csv")).toContainText("amount");
  await page.screenshot({ path: `${SHOT_DIR}/csv--1280x800--light.png` });
  // Raw toggle switches table <-> source and back.
  await page.getByTestId("csv-raw-toggle").click();
  await expect(page.getByTestId("view-csv").locator("th")).toHaveCount(0);
  await expect(page.getByTestId("view-csv")).toContainText("date,amount");
  await page.getByTestId("csv-raw-toggle").click();
  await expect(page.getByTestId("view-csv").locator("th")).toHaveCount(2);

  await open("data/config.json");
  await expect(page.getByTestId("view-json")).toContainText('"ready": true');

  await open("uploads/receipt.png");
  await expect(page.getByTestId("view-image")).toBeVisible();
  // The image actually loaded its bytes through the dohc-file protocol.
  const img = page.getByTestId("view-image").locator("img");
  await expect
    .poll(async () =>
      img.evaluate((el: HTMLImageElement) => el.naturalWidth),
    )
    .toBeGreaterThan(0);
  await page.screenshot({ path: `${SHOT_DIR}/image--1280x800--light.png` });

  await open("uploads/contract.pdf");
  await expect(page.getByTestId("view-pdf")).toContainText(/pdf/i);

  await open("uploads/voice.m4a");
  await expect(page.getByTestId("view-audio")).toBeVisible();

  await open("finance/wallet.sqlite");
  // Positive studio assertions: the real table and its data render — the
  // loading/error fallback (which also carries view-database) can't satisfy
  // these.
  await expect(page.getByTestId("db-table-tab")).toHaveText(/transactions/);
  await expect(page.getByTestId("db-cell-amount-txn_001")).toHaveText("42");

  await open("finance/.apps/ledger/app.json");
  await expect(page.getByTestId("view-app")).toContainText(/app/i);

  await app.close();
});
