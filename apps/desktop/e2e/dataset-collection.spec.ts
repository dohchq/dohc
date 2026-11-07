import { activityPin, settingsNavPin, editorTabTestId } from "../src/testPins";
import { expect, test, type Locator } from "@playwright/test";
import { sendCliRequest } from "@dohc/cli/client";
import { CLI_PROTOCOL_VERSION } from "@dohc/cli/protocol";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { DatasetDefinition } from "@dohc/security-contract/dataset";
import { describeDatasetRevision } from "@dohc/security-contract/dataset-artifacts";
import { generateDatasetSchemaChange } from "../src/workspaces/datasetSchemaChanges";
import { waitForVisibleAnimations } from "./helpers/animations";
import { assertDesktopEngineHealthy, launchDesktopApp } from "./helpers/desktopApp";
import { runDohcCli, waitForCliEndpoint } from "./helpers/dohcCli";
import { cleanupDesktopWorkspace, createTempWorkspace, explorerRow, openChatsView, openExplorerHome, openWorkspaceFromFirstRun, showExplorerFiles } from "./helpers/workspace";

async function openManagement(collection: Locator): Promise<void> {
  const trigger = collection.getByLabel("Manage Collection", { exact: true });
  if (!await trigger.evaluate(element => element.closest("details")?.open)) await trigger.click();
}

test("@dataset-collection owner creates a Collection and form, submits, edits, and undoes from history after restart", async ({ browser }) => {
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
    await expect(collection.getByRole("button", { name: "New record", exact: true }).first()).toBeVisible();
    await openManagement(collection);
    await collection.getByRole("button", { name: "Create form", exact: true }).click();
    const formDialog = page.getByTestId("create-dataset-form-dialog");
    await formDialog.getByRole("button", { name: "Create form", exact: true }).click();
    await expect(formDialog).toBeHidden();
    await page.getByRole("button", { name: "Review and open app", exact: true }).click();
    const publication = page.getByTestId("app-publication-dialog");
    await expect(publication.getByTestId("app-publication-approve")).toBeEnabled();
    await publication.getByTestId("app-publication-approve").click();
    await expect(publication).toBeHidden();
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
    const listed = await page.evaluate(async workspaceId => window.dohcDesktop!.dataset({ workspaceId, action: "list" }), workspaceId);
    if (listed.kind !== "list" || listed.datasets.length !== 1) throw Error("Expected one Collection.");
    const dataset = listed.datasets[0]!;
    const table = dataset.tables[0]!;
    const path = `tab://data-collection/${encodeURIComponent(dataset.datasetPath!)}/${table.tableId}`;
    await page.getByTestId(editorTabTestId(path)).click();
    await collection.getByRole("button", { name: "Refresh", exact: true }).click();
    await expect(collection.getByRole("button", { name: /^Edit Name for record / })).toHaveText("Synthetic participant");
    await collection.getByRole("button", { name: /^Edit Name for record / }).click();
    await collection.getByRole("form", { name: "Edit Name" }).getByLabel("Name").fill("Reviewed participant");
    await collection.getByRole("button", { name: "Save", exact: true }).click();
    await expect(collection.getByRole("button", { name: /^Edit Name for record / })).toHaveText("Reviewed participant");
    await collection.getByRole("button", { name: "Undo last edit" }).click();
    await expect(collection.getByRole("button", { name: /^Edit Name for record / })).toHaveText("Synthetic participant");
    const operationId = dataset.operations.find(operation => operation.kind === "read")!.operationId;
    const request = { action: "invoke" as const, workspaceId, datasetPath: dataset.datasetPath!, revision: dataset.revision, revisionSha256: dataset.revisionSha256,
      operationId, input: { limit: 50 }, idempotencyKey: "agent-read" };
    const read = await sendCliRequest({ protocolVersion: CLI_PROTOCOL_VERSION, verb: "dataset", args: { cwd: workspace.rootPath, actor: "agent", request } }, { stateDir: workspace.homeDir });
    expect(JSON.stringify(read)).toContain("Synthetic participant");
    await page.screenshot({ path: test.info().outputPath("collection-light.png") });
    await collection.getByRole("button", { name: /^Edit Name for record / }).click();
    await collection.getByRole("form", { name: "Edit Name" }).getByLabel("Name").fill("Reviewed before restart");
    await collection.getByRole("button", { name: "Save", exact: true }).click();
    await expect(collection.getByRole("button", { name: /^Edit Name for record / })).toHaveText("Reviewed before restart");
    const edited = await page.evaluate(async request => window.dohcDesktop!.dataset(request), request);
    expect(JSON.stringify(edited)).toContain("Reviewed before restart");
    assertDesktopEngineHealthy(desktop.logs);
    await desktop.close();
    desktop = await launchDesktopApp({ workspace });
    await openWorkspaceFromFirstRun(desktop.page, workspace);
    const restored = await desktop.page.evaluate(async request => window.dohcDesktop!.dataset(request), request);
    expect(restored).toEqual(edited);
    await desktop.page.getByTestId(editorTabTestId(path)).click();
    const reopened = desktop.page.getByRole("region", { name: "Registrations", exact: true });
    await expect(reopened.getByRole("button", { name: /^Edit Name for record / })).toHaveText("Reviewed before restart");
    await expect(reopened.getByRole("button", { name: "Undo last edit" })).toHaveCount(0);
    await openManagement(reopened);
    await reopened.getByRole("button", { name: "History", exact: true }).click();
    const history = desktop.page.getByRole("dialog", { name: "Collection history", exact: true });
    const latest = history.locator("details").first();
    await latest.locator(":scope > summary").click();
    await expect(latest.getByText('"Synthetic participant"', { exact: true })).toBeVisible();
    await desktop.page.screenshot({ path: test.info().outputPath("collection-durable-undo.png") });
    await latest.getByRole("button", { name: "Undo edit", exact: true }).click();
    await expect(reopened.getByRole("button", { name: /^Edit Name for record / })).toHaveText("Synthetic participant");
    await history.getByRole("button", { name: "Close", exact: true }).click();
    await expect(history).toBeHidden();
    await expect(reopened.getByRole("button", { name: /^Edit Name for record / })).toHaveText("Synthetic participant");
    const reversed = await sendCliRequest({ protocolVersion: CLI_PROTOCOL_VERSION, verb: "dataset", args: { cwd: workspace.rootPath, actor: "agent", request } }, { stateDir: workspace.homeDir });
    expect(JSON.stringify(reversed)).toContain("Synthetic participant");
    expect(JSON.stringify(reversed)).not.toContain("Reviewed before restart");
    expect(desktop.logs.filter(entry => entry.level === "pageerror")).toEqual([]);
    assertDesktopEngineHealthy(desktop.logs);
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
    await collection.getByRole("button", { name: "New record", exact: true }).first().click();
    await collection.getByRole("row", { name: "New record" }).getByLabel("Name", { exact: true }).fill("Camera");
    await collection.getByRole("button", { name: "Create record", exact: true }).click();
    await expect(collection.getByRole("button", { name: /^Edit Name for record / })).toHaveText("Camera");
    await collection.getByRole("button", { name: /^Open record / }).click();
    const details = page.getByRole("dialog", { name: "Record details" });
    await expect(details).toContainText("Camera");
    await page.screenshot({ path: test.info().outputPath("record-details-light.png") });
    await page.keyboard.press("Escape");
    await expect(details).toBeHidden();
    await collection.getByRole("button", { name: "Views", exact: true }).click();
    const views = page.getByRole("region", { name: "Collection views" });
    await views.getByRole("button", { name: "Create view", exact: true }).click();
    await views.getByLabel("View name").fill("Cameras");
    await views.getByLabel("View search").fill("Camera");
    await views.getByRole("button", { name: "Save view", exact: true }).click();
    await expect(views.getByRole("button", { name: "Edit view Cameras" })).toBeVisible();
    await views.getByRole("button", { name: "Done", exact: true }).click();
    await expect(collection.getByLabel("Saved Collection view")).toHaveValue(/.+/);
    await expect(collection.getByRole("button", { name: /^Edit Name for record / })).toHaveText("Camera");
    await openManagement(collection);
    await collection.getByRole("button", { name: "Fields and names" }).click();
    const fields = page.getByRole("dialog", { name: "Fields and names" });
    await fields.getByLabel("Name", { exact: true }).fill("Location");
    await fields.getByRole("button", { name: "Review change", exact: true }).click();
    const review = page.getByRole("dialog", { name: "Review Collection change" });
    await expect(review.getByRole("region", { name: "Field changes" })).toContainText("Location");
    await page.screenshot({ path: test.info().outputPath("collection-change-review.png") });
    await review.getByRole("checkbox", { name: "I reviewed this change and its effect on existing data" }).check();
    await review.getByRole("button", { name: "Approve change" }).click();
    await expect(review).toBeHidden();
    await expect(collection.getByRole("button", { name: /^Edit Location for record / })).toBeVisible();
    await expect(collection.getByRole("button", { name: /^Edit Name for record / })).toHaveText("Camera");
    await collection.getByLabel("Manage Collection", { exact: true }).focus();
    await page.keyboard.press("Escape");
    await page.emulateMedia({ reducedMotion: "reduce" });
    for (const theme of ["light", "dark"] as const) {
      await page.getByTestId(activityPin("settings")).click();
      await page.getByTestId(settingsNavPin("appearance")).click();
      await page.getByRole("radiogroup", { name: "Theme" }).getByRole("radio", { name: theme === "light" ? "Light" : "Dark" }).click();
      await page.getByRole("button", { name: "Close settings", exact: true }).click();
      await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
      await waitForVisibleAnimations(page);
      await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
      await page.screenshot({ path: test.info().outputPath(`collection-management-${theme}.png`) });
    }
    await openManagement(collection);
    await collection.getByRole("button", { name: "Fields and names" }).focus();
    await page.keyboard.press("Enter");
    await expect(fields.getByLabel("Name", { exact: true })).toBeFocused();
    await fields.getByRole("button", { name: "Cancel", exact: true }).click();
    await openManagement(collection);
    await collection.getByRole("button", { name: "Archive", exact: true }).click();
    const archive = page.getByRole("dialog", { name: "Archive Equipment?" });
    await archive.getByRole("button", { name: "Archive", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Equipment is archived" })).toBeVisible();
    await page.getByRole("button", { name: "Restore Collection", exact: true }).click();
    await expect(collection.getByRole("button", { name: /^Edit Name for record / })).toHaveText("Camera");
    const listed = await page.evaluate(async workspaceId => window.dohcDesktop!.dataset({ workspaceId, action: "list" }), workspaceId);
    if (listed.kind !== "list" || !listed.datasets[0]) throw Error("Expected the restored Collection.");
    const savePath = join(workspace.baseDir, "equipment.dohc-recovery");
    const result = await sendCliRequest({ protocolVersion: CLI_PROTOCOL_VERSION, verb: "dataset", args: { cwd: workspace.rootPath, actor: "agent",
      request: { action: "export", workspaceId, datasetPath: listed.datasets[0].datasetPath!, savePath } } }, { stateDir: workspace.homeDir });
    expect(result).toMatchObject({ kind: "exported", savedPath: savePath });
    expect((await readFile(savePath)).byteLength).toBeGreaterThan(4096);
    await openManagement(collection);
    await collection.getByRole("button", { name: "Archive", exact: true }).click();
    await page.getByRole("dialog", { name: "Archive Equipment?" }).getByRole("button", { name: "Archive", exact: true }).click();
    await page.getByRole("button", { name: "Delete permanently…", exact: true }).click();
    const deletion = page.getByRole("dialog", { name: "Delete Equipment permanently?" });
    await expect(deletion).toContainText("This cannot be undone on this host, even with a recovery file.");
    await expect(deletion.getByText(/Recovery requires another clean host/)).toBeHidden();
    await deletion.getByRole("button", { name: "Details", exact: true }).click();
    await expect(deletion.getByText(/Recovery requires another clean host/)).toContainText("Recovery requires another clean host with this workspace's identity.");
    await expect(deletion.getByRole("button", { name: "Hide details", exact: true })).toHaveAttribute("aria-expanded", "true");
    await expect(deletion).toContainText(`The ${dirname(listed.datasets[0].datasetPath!)} folder and its files stay. Find them in Files.`);
    await deletion.getByRole("checkbox", { name: "I understand that dohc cannot undo this deletion." }).check();
    await deletion.getByRole("button", { name: "Delete permanently", exact: true }).click();
    await expect(deletion).toBeHidden();
    const remaining = await page.evaluate(async workspaceId => window.dohcDesktop!.dataset({ workspaceId, action: "list", includeArchived: true }), workspaceId);
    expect(remaining).toMatchObject({ kind: "list", datasets: [] });
    expect((await readFile(savePath)).byteLength).toBeGreaterThan(4096);
    assertDesktopEngineHealthy(desktop.logs);
    expect(desktop.logs.filter(entry => entry.level === "pageerror")).toEqual([]);
  } finally { await cleanupDesktopWorkspace(desktop, workspace); }
});

test("@dataset-collection a deleted Collection leaves every list, and its files coming back from the trash bring back every record", async () => {
  test.setTimeout(180_000);
  const workspace = await createTempWorkspace();
  let desktop: Awaited<ReturnType<typeof launchDesktopApp>> | null = null;
  try {
    desktop = await launchDesktopApp({ workspace });
    const { page } = desktop;
    const { workspaceId } = await openWorkspaceFromFirstRun(page, workspace);
    await desktop.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.webContents.send("desktop:menu-command", "new-collection"));
    const create = page.getByTestId("new-collection-dialog");
    await create.getByLabel("Collection name").fill("Registration");
    await create.getByTestId("new-collection-create").click();
    await expect(create).toBeHidden();
    const collection = page.getByRole("region", { name: "Registration", exact: true });
    for (const name of ["Ada", "Grace"]) {
      await collection.getByRole("button", { name: "New record", exact: true }).first().click();
      await collection.getByRole("row", { name: "New record" }).getByLabel("Name", { exact: true }).fill(name);
      await collection.getByRole("button", { name: "Create record", exact: true }).click();
      await expect(collection.getByRole("button", { name: /^Edit Name for record / }).filter({ hasText: name })).toBeVisible();
    }
    const listed = async () => {
      const result = await page.evaluate(async workspaceId => window.dohcDesktop!.dataset({ workspaceId, action: "list" }), workspaceId);
      if (result.kind !== "list") throw Error("Expected the Collections list.");
      return result.datasets;
    };
    const cliListed = async () => JSON.stringify(await sendCliRequest({ protocolVersion: CLI_PROTOCOL_VERSION, verb: "dataset",
      args: { cwd: workspace.rootPath, actor: "agent", request: { action: "list", workspaceId } } }, { stateDir: workspace.homeDir }));
    const [dataset] = await listed();
    if (!dataset?.datasetPath) throw Error("Expected the new Collection to have its dataset.json.");
    const folder = dirname(dataset.datasetPath);
    expect(folder).not.toBe(".");
    expect(await cliListed()).toContain(dataset.datasetId);
    const home = page.getByTestId("explorer-home").getByRole("region", { name: "Collections" });
    await openExplorerHome(page);
    await expect(home.getByText("Registration", { exact: true })).toBeVisible();

    // What the trash keeps: every file in the Collection's folder.
    const saved = new Map<string, Buffer>();
    for (const entry of await readdir(join(workspace.rootPath, folder), { recursive: true, withFileTypes: true })) {
      if (entry.isFile()) saved.set(join(entry.parentPath, entry.name), await readFile(join(entry.parentPath, entry.name)));
    }
    await showExplorerFiles(page);
    await explorerRow(page, folder).click();
    await explorerRow(page, folder).press("Delete");
    await expect(explorerRow(page, folder)).toHaveCount(0);
    await openExplorerHome(page);
    await expect(home.getByText("Registration", { exact: true })).toHaveCount(0);
    await expect.poll(async () => (await listed()).length).toBe(0);
    const cliAfterDelete = await cliListed();
    expect(cliAfterDelete).toContain('"kind":"list"');
    expect(cliAfterDelete).not.toContain(dataset.datasetId);

    // Putting the files back is what restoring them from the trash does.
    for (const [path, bytes] of saved) {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, bytes);
    }
    await expect.poll(async () => (await listed()).map(entry => entry.datasetPath)).toEqual([dataset.datasetPath]);
    await expect(home.getByText("Registration", { exact: true })).toBeVisible();
    expect(await cliListed()).toContain(dataset.datasetId);
    const operationId = dataset.operations.find(operation => operation.kind === "read")?.operationId;
    if (!operationId) throw Error("Expected the Collection to have a read action.");
    const read = await page.evaluate(async request => window.dohcDesktop!.dataset(request), { action: "invoke" as const, workspaceId, datasetPath: dataset.datasetPath,
      revision: dataset.revision, revisionSha256: dataset.revisionSha256, operationId, input: { limit: 50 }, idempotencyKey: "read-after-restore" });
    expect(JSON.stringify(read)).toContain("Ada");
    expect(JSON.stringify(read)).toContain("Grace");
    assertDesktopEngineHealthy(desktop.logs);
    expect(desktop.logs.filter(entry => entry.level === "pageerror")).toEqual([]);
  } finally { await cleanupDesktopWorkspace(desktop, workspace); }
});

test("@dataset-collection Apply on a chat's change card gives the Collection the field its files add, and its table beside the chat shows it", async () => {
  test.setTimeout(180_000);
  const workspace = await createTempWorkspace();
  let desktop: Awaited<ReturnType<typeof launchDesktopApp>> | null = null;
  try {
    desktop = await launchDesktopApp({ workspace });
    const { page } = desktop;
    const { workspaceId } = await openWorkspaceFromFirstRun(page, workspace);
    await waitForCliEndpoint(workspace.homeDir);
    await desktop.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.webContents.send("desktop:menu-command", "new-collection"));
    const create = page.getByTestId("new-collection-dialog");
    await create.getByLabel("Collection name").fill("Volunteers");
    await create.getByTestId("new-collection-create").click();
    await expect(create).toBeHidden();
    // Volunteers stays in view in one editor group while the chat opens in the other.
    const table = page.getByRole("region", { name: "Volunteers", exact: true });
    await expect(table.getByRole("columnheader").filter({ hasText: "Name" })).toBeVisible({ timeout: 30_000 });
    await page.getByTestId("create-editor-group-right").click();
    await expect(page.getByRole("region", { name: "Editor group 2", exact: true })).toBeVisible();
    const volunteers = async () => {
      const listed = await page.evaluate(async id => window.dohcDesktop!.dataset({ workspaceId: id, action: "list" }), workspaceId);
      const found = listed.kind === "list" ? listed.datasets.find(entry => entry.name === "Volunteers" && entry.datasetPath) : undefined;
      if (!found?.datasetPath) throw Error("Expected the Volunteers Collection.");
      return { ...found, datasetPath: found.datasetPath, fields: found.tables[0]!.fields.map(field => field.name) };
    };
    const before = await volunteers();
    const at = (path: string) => join(workspace.rootPath, path);
    const fileFields = async () => (JSON.parse(await readFile(at(before.datasetPath), "utf8")) as DatasetDefinition).tables[0]!.fields.map(field => field.name);

    // An agent adds a Due date field to the Collection's files, then asks in a chat to apply it.
    const definition = JSON.parse(await readFile(at(before.datasetPath), "utf8")) as DatasetDefinition;
    const schemaSql = await readFile(at(definition.schemaPath), "utf8");
    const operationSource = await readFile(at(definition.operationsPath), "utf8");
    const generated = generateDatasetSchemaChange({
      revision: describeDatasetRevision({ definition, revision: before.revision, schemaSql, operationSource }),
      schemaSql, operationSource,
      change: { kind: "addField", tableId: before.tables[0]!.tableId, field: { name: "Due date", type: "date", required: false, unique: false } },
    });
    for (const [path, source] of Object.entries(generated.files)) {
      const target = at(path === generated.descriptorPath ? before.datasetPath : path);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, source);
    }
    const asked = await runDohcCli(workspace, ["dataset", "askToApply",
      JSON.stringify({ workspaceId, datasetPath: before.datasetPath, migrationPath: generated.migrationPath }), "--as-agent", "--json"]);
    expect(asked.stderr).toBe("");
    const changeFile = asked.stdout.match(/[\w./-]*changes\/[0-9a-f-]{36}\.json/u)?.[0];
    if (!changeFile) throw Error(`askToApply wrote no change file: ${asked.stdout}`);
    await page.evaluate(async id => { await window.dohcDesktop!.createChatChannel({ workspaceId: id, name: "Sign-ups", type: "chat" }); }, workspaceId);
    const posted = await runDohcCli(workspace, ["chat", "post", "Sign-ups", "--attach", changeFile, "--needs-decision", "--as-agent",
      "I can add a Due date field to Volunteers. Apply it?"]);
    expect(posted.stderr).toBe("");
    const threadId = posted.stdout.match(/^posted (\S+) /mu)?.[1];
    if (!threadId) throw Error(`chat post named no thread: ${posted.stdout}`);

    // Until Apply, only the files have the field.
    expect(await fileFields()).toContain("Due date");
    expect((await volunteers()).fields).not.toContain("Due date");

    await (await openChatsView(page)).getByTestId("chats-channel").filter({ hasText: "Sign-ups" }).click();
    const card = page.getByTestId("chats-channel-view").getByTestId("chats-lane-change-card");
    await expect(card).toHaveAttribute("data-state", "waiting", { timeout: 30_000 });
    await expect(table).toHaveCount(1);
    await expect(table.getByRole("columnheader").filter({ hasText: "Name" })).toBeVisible();
    await expect(table.getByRole("columnheader").filter({ hasText: "Due date" })).toHaveCount(0);
    await card.getByTestId("chats-lane-change-apply").click();
    await expect(card).toHaveAttribute("data-state", "applied", { timeout: 30_000 });
    // The table beside the chat reads the Collection again, with no Refresh.
    await expect(table.getByRole("columnheader").filter({ hasText: "Due date" })).toBeVisible({ timeout: 30_000 });

    const after = await volunteers();
    expect(after.revision).toBeGreaterThan(before.revision);
    expect(after.fields).toContain("Due date");
    expect(after.fields).toEqual(await fileFields());
    expect((await runDohcCli(workspace, ["chat", "show", threadId, "--peek"])).stdout).toContain("Applied the change to Volunteers.");
    expect(desktop.logs.filter(entry => entry.level === "pageerror")).toEqual([]);
    assertDesktopEngineHealthy(desktop.logs);
  } finally { await cleanupDesktopWorkspace(desktop, workspace); }
});
