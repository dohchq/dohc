import { expect, test } from "@playwright/test";
import { sendCliRequest } from "@dohc/cli/client";
import { CLI_PROTOCOL_VERSION } from "@dohc/cli/protocol";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { launchDesktopApp } from "./helpers/desktopApp";
import { cleanupDesktopWorkspace, createTempWorkspace, openWorkspaceFromFirstRun } from "./helpers/workspace";

test("@dataset-collection owner creates a Collection and form, submits, edits, and reopens the same records", async ({ browser }) => {
  test.setTimeout(180_000);
  const workspace = await createTempWorkspace();
  let desktop: Awaited<ReturnType<typeof launchDesktopApp>> | null = null;
  const context = await browser.newContext();
  try {
    desktop = await launchDesktopApp({ workspace });
    const { page } = desktop;
    const { workspaceId } = await openWorkspaceFromFirstRun(page, workspace);
    await desktop.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.webContents.send("desktop:menu-command", "new-collection"));
    const dialog = page.getByTestId("new-collection-dialog");
    await dialog.getByLabel("Collection name").fill("Registrations");
    await dialog.getByLabel("Require Name").check();
    await dialog.getByTestId("new-collection-create").click();
    await expect(dialog).toBeHidden();
    const collection = page.getByRole("region", { name: "Registrations", exact: true });
    await expect(collection.getByRole("button", { name: "New record", exact: true })).toBeVisible();
    await collection.getByRole("button", { name: "Create form", exact: true }).click();
    const formDialog = page.getByTestId("create-dataset-form-dialog");
    await formDialog.getByRole("button", { name: "Create form", exact: true }).click();
    await expect(formDialog).toBeHidden();
    await page.getByTestId("site-preview-publish").click();
    const publication = page.getByTestId("app-publication-dialog");
    await publication.getByRole("button", { name: "Prepare for this device", exact: true }).click();
    await publication.getByTestId("app-publication-approve").click();
    await expect(publication.getByRole("button", { name: /^Open in browser / })).toBeVisible();
    const local = await page.evaluate(async workspaceId => window.dohcDesktop!.publishOwnerApp({ workspaceId, appRoot: "registrations-form", action: "listLocal" }), workspaceId);
    if (local.kind !== "localListed" || !local.publications[0]) throw Error("Expected approved form.");
    const launched = await page.evaluate(async input => window.dohcDesktop!.publishOwnerApp({ ...input, action: "launchLocal" }), { workspaceId, publicationId: local.publications[0].publicationId });
    if (launched.kind !== "localLaunched") throw Error("Expected local app URL.");
    const participant = await context.newPage();
    await participant.goto(launched.url);
    const form = participant.frameLocator("iframe");
    await form.getByLabel("Name", { exact: false }).fill("Synthetic participant");
    await form.getByRole("button", { name: "Submit", exact: true }).click();
    await expect(form.getByRole("status")).toHaveText("Response received.");
    await publication.getByRole("button", { name: "Close publication" }).click();
    const listed = await page.evaluate(async workspaceId => window.dohcDesktop!.dataset({ workspaceId, action: "list" }), workspaceId);
    if (listed.kind !== "list" || listed.datasets.length !== 1) throw Error("Expected one Collection.");
    const dataset = listed.datasets[0]!;
    const table = dataset.tables[0]!;
    const path = `dohc://data-collection/${dataset.datasetId}/${table.tableId}`;
    await page.getByTestId(`tab-${path}`).click();
    await collection.getByRole("button", { name: "Refresh", exact: true }).click();
    await expect(collection.getByRole("button", { name: /^Edit Name for record / })).toHaveText("Synthetic participant");
    await collection.getByRole("button", { name: /^Edit Name for record / }).click();
    await collection.getByRole("form", { name: "Edit Name" }).getByLabel("Name").fill("Reviewed participant");
    await collection.getByRole("button", { name: "Save", exact: true }).click();
    await expect(collection.getByRole("button", { name: /^Edit Name for record / })).toHaveText("Reviewed participant");
    await collection.getByRole("button", { name: "Undo last edit" }).click();
    await expect(collection.getByRole("button", { name: /^Edit Name for record / })).toHaveText("Synthetic participant");
    const operationId = dataset.operations.find(operation => operation.kind === "read")!.operationId;
    const request = { action: "invoke" as const, workspaceId, datasetId: dataset.datasetId, revision: dataset.revision, revisionSha256: dataset.revisionSha256,
      operationId, input: { limit: 50 }, idempotencyKey: "agent-read" };
    const read = await sendCliRequest({ protocolVersion: CLI_PROTOCOL_VERSION, verb: "dataset", args: { cwd: workspace.rootPath, actor: "agent", request } }, { stateDir: workspace.homeDir });
    expect(JSON.stringify(read)).toContain("Synthetic participant");
    await page.screenshot({ path: test.info().outputPath("collection-light.png") });
    await desktop.close();
    desktop = await launchDesktopApp({ workspace });
    await openWorkspaceFromFirstRun(desktop.page, workspace);
    const restored = await desktop.page.evaluate(async request => window.dohcDesktop!.dataset(request), request);
    expect(restored).toEqual(read);
    expect(desktop.logs.filter(entry => entry.level === "pageerror")).toEqual([]);
  } finally {
    await context.close();
    await cleanupDesktopWorkspace(desktop, workspace);
  }
});

test("@dataset-collection owner changes fields, archives, restores, and exports through the desktop", async () => {
  test.setTimeout(180_000);
  const workspace = await createTempWorkspace();
  let desktop: Awaited<ReturnType<typeof launchDesktopApp>> | null = null;
  try {
    desktop = await launchDesktopApp({ workspace });
    const { page } = desktop;
    const { workspaceId } = await openWorkspaceFromFirstRun(page, workspace);
    await desktop.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.webContents.send("desktop:menu-command", "new-collection"));
    const create = page.getByTestId("new-collection-dialog");
    await create.getByLabel("Collection name").fill("Equipment");
    await create.getByTestId("new-collection-create").click();
    await expect(create).toBeHidden();
    const collection = page.getByRole("region", { name: "Equipment", exact: true });
    await collection.getByRole("button", { name: "New record", exact: true }).click();
    await collection.getByRole("form", { name: "New record" }).getByLabel("Name", { exact: true }).fill("Camera");
    await collection.getByRole("button", { name: "Create record", exact: true }).click();
    await expect(collection.getByRole("button", { name: /^Edit Name for record / })).toHaveText("Camera");
    await collection.getByRole("button", { name: "Fields and names" }).click();
    const fields = page.getByRole("dialog", { name: "Fields and names" });
    await fields.getByLabel("Name", { exact: true }).fill("Location");
    await fields.getByRole("button", { name: "Review change", exact: true }).click();
    const review = page.getByRole("dialog", { name: "Review Collection change" });
    await expect(review.getByRole("region", { name: "Field changes" })).toContainText("Location");
    await review.getByRole("checkbox", { name: "I reviewed this change and its effect on existing data" }).check();
    await review.getByRole("button", { name: "Approve change" }).click();
    await expect(review).toBeHidden();
    await expect(collection.getByRole("button", { name: /^Edit Location for record / })).toBeVisible();
    await expect(collection.getByRole("button", { name: /^Edit Name for record / })).toHaveText("Camera");
    for (const theme of ["light", "dark"]) {
      await page.evaluate(value => document.documentElement.setAttribute("data-theme", value), theme);
      await page.screenshot({ path: test.info().outputPath(`collection-management-${theme}.png`) });
    }
    await collection.getByRole("button", { name: "Fields and names" }).focus();
    await page.keyboard.press("Enter");
    await expect(fields.getByLabel("Name", { exact: true })).toBeFocused();
    await fields.getByRole("button", { name: "Cancel", exact: true }).click();
    await collection.getByRole("button", { name: "Archive", exact: true }).click();
    const archive = page.getByRole("dialog", { name: "Archive Equipment?" });
    await archive.getByRole("button", { name: "Archive Collection" }).click();
    await expect(page.getByRole("heading", { name: "Equipment is archived" })).toBeVisible();
    await page.getByRole("button", { name: "Restore Collection", exact: true }).click();
    await expect(collection.getByRole("button", { name: /^Edit Name for record / })).toHaveText("Camera");
    const listed = await page.evaluate(async workspaceId => window.dohcDesktop!.dataset({ workspaceId, action: "list" }), workspaceId);
    if (listed.kind !== "list" || !listed.datasets[0]) throw Error("Expected the restored Collection.");
    const savePath = join(workspace.rootPath, "equipment.dohc-recovery");
    const result = await sendCliRequest({ protocolVersion: CLI_PROTOCOL_VERSION, verb: "dataset", args: { cwd: workspace.rootPath, actor: "agent",
      request: { action: "export", workspaceId, datasetId: listed.datasets[0].datasetId, savePath } } }, { stateDir: workspace.homeDir });
    expect(result).toMatchObject({ kind: "exported", savedPath: savePath });
    expect((await readFile(savePath)).byteLength).toBeGreaterThan(4096);
    expect(desktop.logs.filter(entry => entry.level === "pageerror")).toEqual([]);
  } finally { await cleanupDesktopWorkspace(desktop, workspace); }
});
