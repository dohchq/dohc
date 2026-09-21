import { expect, test } from "@playwright/test";
import { sendCliRequest } from "@dohc/cli/client";
import { CLI_PROTOCOL_VERSION } from "@dohc/cli/protocol";
import type { OwnerAppBackendRequest } from "@dohc/cli/app-backend";
import type { OwnerAppPublicationRequest } from "@dohc/cli/app-publication";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { launchDesktopApp } from "./helpers/desktopApp";
import { cleanupDesktopWorkspace, createTempWorkspace, openWorkspaceFromFirstRun, waitForWorkspaceFile } from "./helpers/workspace";

const schema = `name: Pickleball registration
fields:
  Name:
    type: text
  Guests:
    type: number
  Session:
    type: select
    options:
      - Morning
      - Afternoon
  Available:
    type: date
  Updates:
    type: checkbox
  Website:
    type: url
  Payment status:
    type: select
    options:
      - Pending
      - Paid
views:
  - name: Table
    kind: table
`;

test("@app-form-generator creates a source-backed form, receives one response, and edits the same data after restart", async ({ browser }, testInfo) => {
  test.setTimeout(180_000);
  const workspace = await createTempWorkspace();
  let desktop: Awaited<ReturnType<typeof launchDesktopApp>> | null = null;
  const context = await browser.newContext({ colorScheme: "light", viewport: { width: 1200, height: 1000 }, reducedMotion: "reduce" });
  const publish = (request: OwnerAppPublicationRequest) => sendCliRequest<"appPublication">({ protocolVersion: CLI_PROTOCOL_VERSION,
    verb: "appPublication", args: { cwd: workspace.rootPath, actor: "human", request } }, { stateDir: workspace.homeDir, timeoutMs: 60_000 });
  const backend = (request: OwnerAppBackendRequest) => sendCliRequest<"appBackend">({ protocolVersion: CLI_PROTOCOL_VERSION,
    verb: "appBackend", args: { cwd: workspace.rootPath, actor: "agent", request } }, { stateDir: workspace.homeDir });
  try {
    await mkdir(join(workspace.rootPath, "registrations"));
    await writeFile(join(workspace.rootPath, "registrations/collection.yaml"), schema);
    const existing = "---\nid: rec_aaaaaaaaaaaaaaaaaaaaaaaaaa\nName: Existing collection record\nPayment status: Paid\n---\nPrivate organizer notes.\n";
    await writeFile(join(workspace.rootPath, "registrations/existing.md"), existing);
    desktop = await launchDesktopApp({ workspace });
    const { workspaceId } = await openWorkspaceFromFirstRun(desktop.page, workspace);
    await waitForWorkspaceFile(desktop.page, workspaceId, "registrations/collection.yaml");
    await expect(desktop.page.locator('[data-testid="tree-row"][data-path="registrations"]')).toHaveAttribute("data-collection", "true");

    const generated = await sendCliRequest<"appForm">({ protocolVersion: CLI_PROTOCOL_VERSION, verb: "appForm", args: {
      cwd: workspace.rootPath, actor: "human", request: { workspaceId, collectionPath: "registrations", appRoot: "registration-form",
        publicFields: ["Name", "Guests", "Session", "Available", "Updates", "Website"] },
    } }, { stateDir: workspace.homeDir });
    expect(generated.recordsCopied).toBe(0);
    expect(generated.files).toContain("registration-form/frontend.js");
    const frontend = await readFile(join(workspace.rootPath, "registration-form/frontend.js"), "utf8");
    expect(frontend).not.toContain("Payment status");
    expect(frontend).not.toContain("Existing collection record");
    await waitForWorkspaceFile(desktop.page, workspaceId, "registration-form/app.publish.json");
    const prepared = await publish({ action: "prepareLocal", workspaceId, appRoot: "registration-form" });
    if (prepared.kind !== "prepared") throw new Error("Expected a generated form approval candidate.");
    const approved = await publish({ action: "approve", workspaceId, approvalId: prepared.approvalId, candidateDigest: prepared.candidateDigest });
    if (approved.kind !== "published") throw new Error("Expected an approved generated form.");
    const selection = { workspaceId, publicationId: approved.publicationId };
    const list = { ...selection, action: "invoke" as const, operation: "listResponses", input: {}, idempotencyKey: "form-list" };
    expect(await backend(list)).toMatchObject({ result: { rows: [], total: 0 } });

    const launched = await publish({ ...selection, action: "launchLocal" });
    if (launched.kind !== "localLaunched") throw new Error("Expected a local form URL.");
    const page = await context.newPage();
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.goto(launched.url);
    const app = page.frameLocator("iframe");
    await expect(app.getByRole("heading", { name: "Pickleball registration" })).toBeVisible();
    await expect(app.getByLabel("Payment status", { exact: true })).toHaveCount(0);
    await expect(app.getByLabel("Name", { exact: true })).toHaveCSS("min-height", "44px");
    await app.getByLabel("Name", { exact: true }).focus();
    await page.keyboard.type("Browser player");
    await page.keyboard.press("Tab");
    await expect(app.getByLabel("Guests", { exact: true })).toBeFocused();
    await app.getByLabel("Guests", { exact: true }).fill("2");
    await app.getByLabel("Session", { exact: true }).selectOption("Morning");
    await app.getByLabel("Available", { exact: true }).fill("2026-10-01");
    await app.getByLabel("Updates", { exact: true }).check();
    await app.getByLabel("Website", { exact: true }).fill("https://example.com/?guest=1");
    await page.screenshot({ path: testInfo.outputPath("form-light.png"), fullPage: true });
    await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
    await page.screenshot({ path: testInfo.outputPath("form-dark.png"), fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: testInfo.outputPath("form-mobile-dark.png"), fullPage: true });
    const overflows = await app.locator("body").evaluate(body => body.scrollWidth > body.clientWidth);
    expect(overflows).toBe(false);
    await app.getByLabel("Name", { exact: true }).fill("N".repeat(2000));
    await app.getByLabel("Website", { exact: true }).fill("https://example.com/" + "x".repeat(1800));
    await app.getByRole("button", { name: "Submit", exact: true }).click();
    await expect(app.getByRole("status")).toContainText("Response not saved.");
    await expect(app.getByLabel("Name", { exact: true })).toBeEnabled();
    await page.screenshot({ path: testInfo.outputPath("form-refused.png"), fullPage: true });
    await app.getByLabel("Name", { exact: true }).fill("Browser player");
    await app.getByLabel("Website", { exact: true }).fill("https://example.com/?guest=1");
    await app.getByRole("button", { name: "Submit", exact: true }).click();
    await expect(app.getByRole("status")).toHaveText("Response received.");
    await expect(app.getByRole("button", { name: "Submit another response" })).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath("form-received.png"), fullPage: true });

    const rows = await backend({ ...list, idempotencyKey: "form-list-after-submit" });
    expect(rows).toMatchObject({ result: { total: 1, rows: [{ Name: "Browser player", Guests: 2, Session: "Morning",
      Available: "2026-10-01", Updates: true, Website: "https://example.com/?guest=1", "Payment status": null, version: 1 }] } });
    if (!("result" in rows)) throw new Error("Expected listed form responses.");
    const row = (rows.result as { rows: { id: string; version: number }[] }).rows[0]!;
    const edit = { ...selection, action: "invoke" as const, operation: "editResponse", idempotencyKey: "form-owner-edit",
      input: { rowId: row.id, expectedVersion: row.version, field: "Payment status", value: "Paid" } };
    expect(await backend(edit)).toMatchObject({ result: { "Payment status": "Paid", version: 2 } });

    await desktop.page.getByTestId("activity-sites").click();
    const appRow = desktop.page.locator('[data-testid="sites-row"][data-root="registration-form"]');
    await expect(appRow).toBeVisible();
    await appRow.click();
    await desktop.page.getByRole("button", { name: "Publish app", exact: true }).click();
    const data = desktop.page.getByRole("region", { name: "App data", exact: true });
    await expect(data).toBeVisible();
    await data.getByRole("button", { name: "Load table", exact: true }).click();
    await expect(data.getByRole("cell", { name: "Browser player", exact: true })).toBeVisible();
    await expect(data.getByRole("cell", { name: "Paid", exact: true })).toBeVisible();
    await data.getByRole("button", { name: `Edit row ${row.id}`, exact: true }).click();
    await data.getByLabel("Edit field", { exact: true }).selectOption("Guests");
    await expect(data.getByLabel("Edit value", { exact: true })).toHaveValue("2");
    await data.getByLabel("Edit value", { exact: true }).fill("3");
    await data.getByRole("button", { name: "Save", exact: true }).click();
    await expect(data.getByRole("status")).toHaveText(`Saved Guests for row ${row.id}.`);
    await expect(data.getByRole("form", { name: "Edit row", exact: true })).toHaveCount(0);
    await expect(data.getByRole("heading", { name: "App data", exact: true })).toBeFocused();
    expect(await backend({ ...list, idempotencyKey: "form-list-after-panel-edit" })).toMatchObject({ result: {
      total: 1, rows: [{ id: row.id, Guests: 3, "Payment status": "Paid", version: 3 }],
    } });
    await data.screenshot({ path: testInfo.outputPath("form-app-data.png") });
    await desktop.page.getByRole("button", { name: "Close publication", exact: true }).click();
    expect(await readFile(join(workspace.rootPath, "registrations/existing.md"), "utf8")).toBe(existing);
    expect(errors).toEqual([]);
    await page.close();

    await desktop.close();
    desktop = await launchDesktopApp({ workspace });
    await openWorkspaceFromFirstRun(desktop.page, workspace);
    expect(await backend({ ...list, idempotencyKey: "form-list-after-restart" })).toMatchObject({ result: {
      total: 1, rows: [{ id: row.id, Name: "Browser player", Guests: 3, "Payment status": "Paid", version: 3 }],
    } });
    expect(await backend(edit)).toMatchObject({ replayed: true, result: { "Payment status": "Paid", version: 2 } });
    expect(desktop.logs.filter(entry => entry.level === "pageerror")).toEqual([]);
  } finally {
    await context.close();
    await cleanupDesktopWorkspace(desktop, workspace);
  }
});
