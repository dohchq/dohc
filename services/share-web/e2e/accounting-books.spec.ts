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
    page.on("console", (message) => {
      if (message.type() === "error") failures.push(message.text());
    });
    await page.goto(await launcher.launch(books.publicationId, lifetime.signal));
    const app = page.frameLocator("iframe");
    const nav = (name: string) =>
      app
        .getByRole("navigation", { name: "Books" })
        .getByRole("button", { name: new RegExp(`^${name}`) })
        .click();
    const year = new Date().getFullYear();
    const today = new Date();
    const day = `${year}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;

    await expect(app.getByText(`Open fiscal year ${year}`)).toBeVisible();
    await app.getByRole("button", { name: `Open ${year}`, exact: true }).click();
    await expect(app.getByRole("heading", { name: "Needs attention" })).toBeVisible();

    await page.keyboard.press("n");
    const dialog = app.getByRole("dialog", { name: "New journal entry" });
    await expect(dialog.getByLabel("Memo", { exact: true })).toBeFocused();
    await page.keyboard.type("Owner investment");
    await dialog.getByRole("combobox", { name: "Account on line 1" }).fill("1000");
    await page.keyboard.press("Enter");
    await dialog.getByLabel("Debit on line 1").fill("5,000");
    await dialog.getByRole("combobox", { name: "Account on line 2" }).fill("3000");
    await page.keyboard.press("Enter");
    await dialog.getByLabel("Credit on line 2").fill("4999.99");
    await expect(dialog.getByText("Debits exceed credits by")).toBeVisible();
    await expect(dialog.getByRole("button", { name: /Post entry/ })).toBeDisabled();
    await page.keyboard.press("Control+Enter");
    await expect(dialog).toBeVisible();
    await dialog.getByRole("button", { name: /^Balance/ }).click();
    await expect(dialog.getByRole("combobox", { name: "Account on line 3" })).toBeFocused();
    await expect(dialog.getByLabel("Credit on line 3")).toHaveValue("0.01");
    await expect(dialog.getByLabel("Credit on line 2")).toHaveValue("4999.99");
    await dialog.getByRole("button", { name: "Remove line 3" }).click();
    await dialog.getByLabel("Credit on line 2").fill("");
    await dialog.getByLabel("Credit on line 2").press("=");
    await expect(dialog.getByLabel("Credit on line 2")).toHaveValue("5000.00");
    await expect(dialog.getByText("Balanced", { exact: true })).toBeVisible();
    await dialog.getByLabel("Credit on line 2").press("Enter");
    await expect(dialog.getByRole("combobox", { name: "Account on line 3" })).toBeFocused();
    for (const _ of [1, 2, 3, 4]) await page.keyboard.press("Tab");
    await expect(dialog.getByRole("button", { name: "Remove line 3" })).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(dialog.getByRole("combobox", { name: "Account on line 3" })).toHaveCount(0);
    await expect(dialog.getByRole("combobox", { name: "Account on line 2" })).toBeFocused();
    await dialog.getByLabel("Receipt (PDF or image, optional)").setInputFiles({
      name: "deposit.pdf",
      mimeType: "application/pdf",
      buffer: Buffer.from("%PDF-1.7 synthetic deposit slip\n%%EOF"),
    });
    await page.keyboard.press("Control+Enter");
    await expect(dialog).toHaveCount(0);

    await nav("Register");
    const investment = app.getByRole("row", { name: /Owner investment/ });
    await expect(investment.getByLabel("Has a receipt")).toBeVisible();
    await investment.click();
    const inspector = app.getByRole("complementary", { name: /^Entry \d+$/ });
    await expect(inspector.getByText("Balanced")).toBeVisible();
    await expect(inspector.getByRole("link", { name: /Download/ })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(inspector).toHaveCount(0);
    await page.keyboard.press("g");
    await page.keyboard.press("p");
    await expect(app.getByRole("button", { name: `Open ${year - 1}`, exact: true })).toBeVisible();
    await expect(app.getByRole("button", { name: `Open ${year + 1}`, exact: true })).toBeVisible();

    await nav("Bank");
    const csv = Buffer.from(
      [
        "Date,Description,Amount",
        `${day},"Coffee, beans",-12.50`,
        `${day},Client payment,"1,250.00"`,
        `${day},Bank fee,(5.00)`,
        `${day},Coffee  beans,-12.50`,
      ].join("\r\n"),
    );
    const importStatement = async (name: string, buffer: Buffer, rows: number) => {
      await app.getByRole("button", { name: "Import statement" }).first().click();
      const sheet = app.getByRole("dialog", { name: "Import a bank statement" });
      await sheet.getByLabel("CSV file").setInputFiles({ name, mimeType: "text/csv", buffer });
      await expect(sheet.getByText(`${rows} rows ready`)).toBeVisible();
      await sheet.getByRole("button", { name: `Import ${rows} rows` }).click();
      await expect(sheet).toHaveCount(0);
    };
    await importStatement("statement.csv", csv, 4);
    await expect(app.getByText("Imported 4 new rows")).toBeVisible();
    await importStatement("statement.csv", csv, 4);
    await expect(app.getByText("4 imported before")).toBeVisible();
    const overlap = Buffer.from(
      [
        "Date,Description,Amount",
        `${day},Bank fee,(5.00)`,
        `${day},Rent,-900`,
        `${day},OWNER DEPOSIT,"5,000.00"`,
      ].join("\n"),
    );
    await importStatement("overlap.csv", overlap, 3);
    await expect(app.getByText("1 looks like a row imported before")).toBeVisible();
    const queue = app.getByRole("listbox", { name: "Bank rows" });
    const undo = (message: string | RegExp) =>
      app
        .locator(".b-toast", { has: app.getByText(message) })
        .getByRole("button", { name: "Undo" })
        .click();
    await app.getByRole("tab", { name: /^Suggested/ }).click();
    const deposit = queue.getByRole("option").filter({ hasText: "OWNER DEPOSIT" });
    await expect(queue.getByRole("option")).toHaveCount(1);
    await deposit.click();
    await expect(app.getByText("Already in the books as entry 1")).toBeVisible();
    await page.keyboard.press("Enter");
    await expect(app.getByText("Matched to entry 1")).toBeVisible();
    await expect(deposit).toHaveCount(0);
    await undo("Matched to entry 1");
    await expect(app.getByText("Back in review")).toBeVisible();
    await expect(deposit).toHaveCount(1);
    await deposit.click();
    await page.keyboard.press("Enter");
    await expect(deposit).toHaveCount(0);
    await app.getByRole("tab", { name: /^Review/ }).click();
    await queue.getByRole("option").filter({ hasText: "Coffee, beans" }).click();
    await app.getByRole("button", { name: /^Find entry/ }).click();
    const finder = app.getByRole("dialog", { name: "Find the entry for this row" });
    await expect(finder.getByText("No entry to match")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(finder).toHaveCount(0);
    await queue.focus();
    await page.keyboard.press("f");
    await expect(finder.getByText("No entry to match")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(finder).toHaveCount(0);
    const rent = queue.getByRole("option").filter({ hasText: "Rent" });
    await rent.click();
    await app.getByRole("combobox", { name: "Other account" }).fill("6000");
    await page.keyboard.press("Enter");
    await page.keyboard.press("Enter");
    await expect(rent).toHaveCount(0);
    await expect(app.getByText(/^Posted as entry \d+$/)).toBeVisible();
    await undo(/^Posted as entry \d+$/);
    await expect(app.getByText("Reversed, the row is back in review")).toBeVisible();
    await expect(rent).toHaveCount(1);
    for (const [description, account] of [
      ["Coffee, beans", "6500"],
      ["Coffee beans", "6500"],
      ["Client payment", "4000"],
      ["Bank fee", "6300"],
      ["Rent", "6000"],
    ] as const) {
      await queue.getByRole("option").filter({ hasText: description }).click();
      await app.getByRole("combobox", { name: "Other account" }).fill(account);
      await page.keyboard.press("Enter");
      await page.keyboard.press("Enter");
    }
    await expect(app.getByText("All caught up")).toBeVisible();
    await app.getByRole("tab", { name: /^Duplicates/ }).click();
    const again = queue.getByRole("option").filter({ hasText: "Bank fee" });
    await again.click();
    await page.keyboard.press("Enter");
    await expect(app.getByText("Confirmed as a duplicate", { exact: true })).toBeVisible();
    await expect(again).toContainText("Confirmed");
    await undo("Confirmed as a duplicate");
    await expect(app.getByText("Back to check")).toBeVisible();
    await expect(again).not.toContainText("Confirmed");
    await app.getByRole("button", { name: /^Confirm duplicate/ }).click();
    await expect(app.getByRole("button", { name: "Unconfirm" })).toBeVisible();
    await app.getByRole("tab", { name: /^Review/ }).click();
    await app.getByRole("button", { name: "Reconcile" }).click();
    const reconcile = app.getByRole("dialog", { name: "Reconcile a bank account" });
    await reconcile.getByLabel("Statement date").fill(day);
    await reconcile.getByLabel("Ending balance on the statement").fill("1");
    await expect(reconcile.getByText(/^Off by/)).toBeVisible();
    await expect(reconcile.getByRole("button", { name: /^Reconcile/ })).toBeDisabled();
    await reconcile.getByLabel("Ending balance on the statement").fill("5,320.00");
    await expect(reconcile.getByText("The books match the statement")).toBeVisible();
    await page.keyboard.press("Enter");
    await expect(reconcile).toHaveCount(0);
    await expect(app.getByText(/Checking account reconciled through/)).toBeVisible();

    await nav("Invoices");
    await page.keyboard.press("c");
    const editor = app.getByRole("dialog", { name: "New invoice" });
    await editor.getByLabel("Client name").fill("Synthetic Client Co");
    await expect(editor.getByRole("button", { name: "Save draft" })).toBeDisabled();
    await editor.getByLabel("From").fill("Synthetic Studio");
    await editor.getByLabel("Tax %").fill("8.25");
    await editor.getByLabel("Description on line 1").fill("Design work");
    await editor.getByLabel("Quantity on line 1").fill("10");
    await editor.getByLabel("Price on line 1").fill("150");
    await expect(editor.getByLabel("Preview")).toContainText("$1,623.75");
    await editor.getByRole("button", { name: "Save draft" }).click();
    await expect(editor).toHaveCount(0);
    const pane = app.getByRole("complementary", { name: /^Invoice / });
    await pane.getByRole("button", { name: "Issue" }).click();
    await expect(pane.getByRole("heading", { name: "INV-0001" })).toBeVisible();
    const [invoiceDownload] = await Promise.all([
      page.waitForEvent("download"),
      pane.getByRole("button", { name: "Printable" }).click(),
    ]);
    expect(invoiceDownload.suggestedFilename()).toBe("invoice-INV-0001.html");
    const invoiceHtml = await readFile((await invoiceDownload.path())!, "utf8");
    expect(invoiceHtml).toContain("INV-0001");
    expect(invoiceHtml).toContain("Synthetic Client Co");
    expect(invoiceHtml).toContain("Synthetic Studio");
    expect(invoiceHtml).toContain("$1,623.75");
    expect(invoiceHtml).toContain("@media print");
    await pane.getByRole("button", { name: "Record payment" }).click();
    await pane.getByLabel("Payment amount").fill("1,000");
    await pane.getByRole("button", { name: "Post $1,000.00" }).click();
    await expect(app.getByText("Recorded $1,000.00, $623.75 still due")).toBeVisible();
    await expect(app.getByRole("row", { name: /INV-0001/ })).toContainText("Part paid");
    await pane.getByRole("button", { name: "Record payment" }).click();
    await pane.getByRole("button", { name: "Post $623.75" }).click();
    await expect(app.getByText("INV-0001 is paid in full")).toBeVisible();
    await expect(app.getByRole("row", { name: /INV-0001/ })).toContainText("Paid");
    await expect(pane.getByRole("button", { name: /^Payment · entry/ })).toHaveCount(2);

    await expect(app.getByText(/^Could not/)).toHaveCount(0);
    await nav("Reports");
    await expect(app.getByText("In balance")).toBeVisible();
    await app.getByLabel("As of").fill(`${year - 1}-12-31`);
    await expect(app.getByText("In balance")).toBeVisible();
    await app.getByLabel("As of").fill(`${year}-12-31`);
    await expect(app.getByText("In balance")).toBeVisible();
    await page.screenshot({ path: info.outputPath("accounting-books-trial-balance.png") });
    await nav("Overview");
    await expect(app.getByRole("heading", { name: "Recent entries" })).toBeVisible();
    const shortcuts = app.getByRole("dialog", { name: "Keyboard shortcuts" });
    await page.keyboard.press("?");
    await expect(shortcuts).toBeVisible();
    await page.keyboard.press("?");
    await expect(shortcuts).toHaveCount(0);
    await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
    await page.screenshot({ path: info.outputPath("accounting-books-overview-dark.png") });
    await page.setViewportSize({ width: 390, height: 844 });
    const fits = () => app.locator("body").evaluate((body) => body.scrollWidth <= innerWidth + 1);
    expect(await fits()).toBe(true);
    await page.screenshot({ path: info.outputPath("accounting-books-overview-mobile.png") });
    await app.getByRole("button", { name: "More" }).click();
    await app.getByRole("menuitem", { name: /^Accounts/ }).click();
    await expect(app.locator(".b-coa")).toBeVisible();
    expect(await fits()).toBe(true);

    const trial = await ownerRead("trialBalance", { asOf: `${year}-12-31`, currency: "USD" });
    expect(trial).toMatchObject({ balanced: true });
    const cash = trial.rows.find((row: any) => row.id === "1000");
    expect(cash.debitBalanceCents).toBe(500_000 - 1_250 + 125_000 - 500 - 1_250 - 90_000 + 162_375);
    const entry = (await ownerRead("listEntries", {})).entries.find(
      (row: any) => row.memo === "Owner investment",
    );
    expect(entry.hasReceipt).toBe(true);
    const bankCounts = (await ownerRead("listBankRows", { status: "duplicate" })).counts;
    expect(bankCounts).toMatchObject({ posted: 6, confirmed: 1 });
    expect(bankCounts).not.toHaveProperty("duplicate");
    expect(failures).toEqual([]);
  } finally {
    await context.close();
    lifetime.abort();
    await launcher.close();
    await host.close();
    await rm(directory, { recursive: true, force: true, maxRetries: 8, retryDelay: 25 });
  }
});
