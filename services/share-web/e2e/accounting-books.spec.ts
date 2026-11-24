import { test, expect } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { createLocalDatasetHost } from "../../../apps/desktop/src/workspaces/localDatasetHost";
import { openedLocalState } from "../../../apps/desktop/src/testing/preparedLocalState";
import { unguardedCollections } from "../../../apps/desktop/src/testing/collectionsHolder";
import { createLocalAppLaunchHost } from "../../../apps/desktop/src/workspaces/localAppLaunch";
import { compileClosedApp } from "../../../apps/desktop/src/workspaces/closedAppCompiler";
import { prepareLocalAppPublication } from "../../../apps/desktop/src/workspaces/ownerAppPublication";
import { sourceCaptureAdapter } from "../../../apps/desktop/src/testing/sourceCaptureAdapter";

test("the owner keeps books: entries with receipts, bank import, invoices, and balanced reports", async ({
  browser,
}, info) => {
  test.setTimeout(120_000);
  const directory = await mkdtemp(join(tmpdir(), "dohc-accounting-books-"));
  await openedLocalState({ workspaceId: "books-workspace", rootPath: directory });
  const host = await createLocalDatasetHost({
    holder: unguardedCollections,
    localPersonId: () => "person-local",
    workspaceId: "books-workspace",
    workspaceRoot: directory,
  });
  const lifetime = new AbortController(),
    launcher = await createLocalAppLaunchHost({ backend: host.apps, lifetime: lifetime.signal });
  const root = fileURLToPath(new URL("../../../examples/accounting", import.meta.url));
  const sources = new Map<string, Uint8Array>();
  for (const entry of await readdir(root, { recursive: true, withFileTypes: true }))
    if (entry.isFile())
      sources.set(
        `accounting/${relative(root, join(entry.parentPath, entry.name)).replaceAll("\\", "/")}`,
        await readFile(join(entry.parentPath, entry.name)),
      );
  const adapter = sourceCaptureAdapter(sources, { workspaceId: "books-workspace" });
  const context = await browser.newContext({ viewport: { width: 1280, height: 1000 } });
  const failures: string[] = [];
  try {
    const prepared = await host.prepare({ descriptorPath: "accounting/dataset.json", adapter });
    const revision = await host.approve({
      preparationId: prepared.preparationId,
      revisionSha256: prepared.revision.revisionSha256,
    });
    const ownerRead = async (name: string, input: Record<string, string> = {}) =>
      (
        await host.query({
          datasetId: revision.datasetId,
          revision: revision.revision,
          revisionSha256: revision.revisionSha256,
          operationId: revision.definition.operations.find((operation) => operation.name === name)!
            .operationId,
          input,
          idempotencyKey: randomUUID(),
        })
      ).result as any;
    const source = await prepareLocalAppPublication(
      { workspaceId: "books-workspace", appRoot: "accounting" },
      {
        adapter,
        deferredWrites: [],
        compile: compileClosedApp,
        signal: lifetime.signal,
        assertCurrent() {},
        async resolveDatasetRevision() {
          return revision;
        },
      },
    );
    expect(
      source.candidate.inputs.some(
        (file) => file.path.endsWith("operations.js") || file.path.endsWith("schema.sql"),
      ),
    ).toBe(false);
    const books = await host.apps.activate(source, lifetime.signal);
    const page = await context.newPage();
    page.setDefaultTimeout(20_000);
    page.on("pageerror", (error) => failures.push(String(error)));
    await page.goto(await launcher.launch(books.publicationId, lifetime.signal));
    const app = page.frameLocator("iframe");
    const nextSitting = async (tab: string) => {
      await page.goto(await launcher.launch(books.publicationId, lifetime.signal));
      await app.getByRole("tab", { name: tab }).click();
    };
    const year = new Date().getFullYear();
    const today = new Date();
    const day = `${year}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;

    await expect(app.getByText("Open your first fiscal year")).toBeVisible();
    await app.getByRole("button", { name: `Open ${year}` }).click();
    await expect(app.getByText("Net income this year")).toBeVisible();

    await app.getByRole("tab", { name: "Journal" }).click();
    await app.getByRole("button", { name: "New entry" }).click();
    const dialog = app.getByRole("dialog");
    await dialog.getByLabel("Memo").fill("Owner investment");
    await dialog.getByRole("combobox", { name: "Choose an account" }).nth(0).selectOption("1000");
    await dialog.getByLabel("Debit on line 1").fill("5,000");
    await dialog.getByRole("combobox", { name: "Choose an account" }).nth(1).selectOption("3000");
    await dialog.getByLabel("Credit on line 2").fill("4999.99");
    await expect(dialog.getByText("Not balanced")).toBeVisible();
    await expect(dialog.getByRole("button", { name: "Post entry" })).toBeDisabled();
    await dialog.getByLabel("Credit on line 2").fill("5000");
    await expect(dialog.getByText("Balanced", { exact: true })).toBeVisible();
    await dialog.getByLabel("Receipt (PDF or image, optional)").setInputFiles({
      name: "deposit.pdf",
      mimeType: "application/pdf",
      buffer: Buffer.from("%PDF-1.7 synthetic deposit slip\n%%EOF"),
    });
    await dialog.getByRole("button", { name: "Post entry" }).click();
    await expect(dialog).toHaveCount(0);
    await expect(app.getByRole("row", { name: /Owner investment/ })).toContainText("Receipt");
    await app.getByRole("row", { name: /Owner investment/ }).click();
    await expect(
      app.getByRole("dialog").getByRole("button", { name: "Show receipt" }),
    ).toBeVisible();
    await app.getByRole("dialog").getByRole("button", { name: "Show receipt" }).click();
    await expect(
      app.getByRole("dialog").getByRole("link", { name: /Download deposit.pdf/ }),
    ).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(app.getByRole("dialog")).toHaveCount(0);

    await nextSitting("Bank");
    const csv = Buffer.from(
      [
        "Date,Description,Amount",
        `${day},"Coffee, beans",-12.50`,
        `${day},Client payment,"1,250.00"`,
        `${day},Bank fee,(5.00)`,
        `${day},Coffee  beans,-12.50`,
      ].join("\r\n"),
    );
    await app
      .getByLabel("CSV file")
      .setInputFiles({ name: "statement.csv", mimeType: "text/csv", buffer: csv });
    await expect(app.getByText("statement.csv: 4 rows ready.")).toBeVisible();
    await app.getByRole("button", { name: "Import 4 rows" }).click();
    await expect(app.getByText("4 new rows, 0 already in the books.")).toBeVisible();
    await app
      .getByLabel("CSV file")
      .setInputFiles({ name: "statement.csv", mimeType: "text/csv", buffer: csv });
    await app.getByRole("button", { name: "Import 4 rows" }).click();
    await expect(
      app.getByText("0 new rows, 0 already in the books, 4 imported before from this file."),
    ).toBeVisible();
    const overlap = Buffer.from(
      ["Date,Description,Amount", `${day},Bank fee,(5.00)`, `${day},Rent,-900`].join("\n"),
    );
    await app
      .getByLabel("CSV file")
      .setInputFiles({ name: "overlap.csv", mimeType: "text/csv", buffer: overlap });
    await app.getByRole("button", { name: "Import 2 rows" }).click();
    await expect(app.getByText("1 new row, 1 already in the books.")).toBeVisible();
    for (const [description, account] of [
      ["Coffee, beans", "6500"],
      ["Coffee beans", "6500"],
      ["Client payment", "4000"],
      ["Bank fee", "6300"],
      ["Rent", "6000"],
    ] as const)
      await app
        .getByRole("row", { name: new RegExp(description) })
        .getByRole("combobox")
        .selectOption(account);
    await app.getByRole("button", { name: "Post 5 selected" }).click();
    await expect(app.getByText("Nothing to review")).toBeVisible();

    await nextSitting("Invoices");
    await app.getByRole("button", { name: "New invoice" }).click();
    const editor = app.getByRole("dialog");
    await editor.getByLabel("Client name").fill("Synthetic Client Co");
    await editor.getByLabel("Sales tax %").fill("8.25");
    await editor.getByLabel("Description on line 1").fill("Design work");
    await editor.getByLabel("Quantity on line 1").fill("10");
    await editor.getByLabel("Unit price on line 1").fill("150");
    await editor.getByRole("button", { name: "Save draft" }).click();
    await expect(app.getByRole("heading", { name: "Invoice (draft)" })).toBeVisible();
    await app.getByRole("button", { name: "Issue and post" }).click();
    await expect(app.getByRole("heading", { name: "Invoice INV-0001" })).toBeVisible();
    await expect(app.getByRole("row", { name: /Total due/ })).toContainText("$1,623.75");
    const [invoiceDownload] = await Promise.all([
      page.waitForEvent("download"),
      app.getByRole("button", { name: "Download printable HTML" }).click(),
    ]);
    expect(invoiceDownload.suggestedFilename()).toBe("invoice-INV-0001.html");
    const invoiceHtml = await readFile((await invoiceDownload.path())!, "utf8");
    expect(invoiceHtml).toContain("Invoice INV-0001");
    expect(invoiceHtml).toContain("Synthetic Client Co");
    expect(invoiceHtml).toContain("$1,623.75");
    expect(invoiceHtml).toContain("@media print");
    await page.emulateMedia({ media: "print" });
    await page.screenshot({ path: info.outputPath("accounting-invoice-print.png") });
    await page.emulateMedia({ media: "screen" });
    await app.getByRole("button", { name: "Record payment" }).click();
    await app.getByRole("button", { name: "Post payment of $1,623.75" }).click();
    await expect(app.locator(".books-invoice").getByText("paid", { exact: true })).toBeVisible();

    await nextSitting("Reports");
    await expect(app.getByText("In balance")).toBeVisible();
    await app.getByLabel("As of").fill(`${year - 1}-12-31`);
    await expect(app.getByText("In balance")).toBeVisible();
    await app.getByLabel("As of").fill(`${year}-12-31`);
    await expect(app.getByText("In balance")).toBeVisible();
    await page.screenshot({ path: info.outputPath("accounting-books-trial-balance.png") });
    await app.getByRole("tab", { name: "Overview" }).click();
    await expect(app.getByText("Bank rows to review")).toBeVisible();
    await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
    await page.screenshot({ path: info.outputPath("accounting-books-overview-dark.png") });
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await app.locator("body").evaluate((body) => body.scrollWidth <= innerWidth + 1)).toBe(
      true,
    );
    await page.screenshot({ path: info.outputPath("accounting-books-overview-mobile.png") });

    const trial = await ownerRead("trialBalance", { asOf: `${year}-12-31`, currency: "USD" });
    expect(trial).toMatchObject({ balanced: true });
    const cash = trial.rows.find((row: any) => row.id === "1000");
    expect(cash.debitBalanceCents).toBe(500_000 - 1_250 + 125_000 - 500 - 1_250 - 90_000 + 162_375);
    const entry = (await ownerRead("listEntries", {})).entries.find(
      (row: any) => row.memo === "Owner investment",
    );
    expect(entry.hasReceipt).toBe(true);
    expect((await ownerRead("listBankRows", { status: "duplicate" })).counts).toMatchObject({
      posted: 5,
      duplicate: 1,
    });
    expect(failures).toEqual([]);
  } finally {
    await context.close();
    lifetime.abort();
    await launcher.close();
    await host.close();
    await rm(directory, { recursive: true, force: true, maxRetries: 8, retryDelay: 25 });
  }
});
