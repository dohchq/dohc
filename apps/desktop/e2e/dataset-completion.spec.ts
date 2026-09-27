import { expect, test, type Page, type Locator } from "@playwright/test";
import { randomBytes, randomUUID } from "node:crypto";
import { join } from "node:path";
import { readFile, writeFile } from "node:fs/promises";
import type { DatasetDefinition } from "@dohc/security-contract/dataset";
import { orderFormDefinition } from "./helpers/datasetCompletion";
import { launchDesktopApp } from "./helpers/desktopApp";
import { spawnSyncRelay, type SyncRelayHandle } from "./helpers/syncRelay";
import { sharedDatasetViewerOrigin, startSharedDatasetBrowser } from "./helpers/sharedDatasetBrowser";
import { cleanupDesktopWorkspace, createTempWorkspace, openWorkspaceFromFirstRun, seedCloudCredentials, seedWorkspaceManifest, seedWorkspaceRegistry, waitForWorkspaceFile } from "./helpers/workspace";

async function dragBoardCard(page: Page, card: Locator, column: Locator): Promise<void> {
  const source = await card.boundingBox(), target = await column.boundingBox();
  if (!source || !target) throw Error("The card and destination must be visible.");
  const x = source.x + source.width / 2, y = source.y + source.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + 8, y + 8, { steps: 4 });
  await expect(card).toHaveClass(/opacity-50/);
  await page.mouse.move(target.x + target.width / 2, target.y + target.height / 2, { steps: 20 });
  await page.mouse.up();
}

// Auth and custom source are fixture setup. Field rename, migration review, publication,
// and submissions use real desktop/browser controls against the real relay and engine.
test("@dataset-completion field rename preserves custom rules and an already published form", async ({}, info) => {
  test.setTimeout(180_000);
  const workspace = await createTempWorkspace(), workspaceId = randomUUID(), userId = "dataset-shared-owner";
  const exchangeKey = randomBytes(32).toString("base64url");
  let desktop: Awaited<ReturnType<typeof launchDesktopApp>> | null = null;
  let relay: SyncRelayHandle | null = null;
  let relayDiagnostics: SyncRelayHandle["diagnostics"] | undefined;
  let shared: Awaited<ReturnType<typeof startSharedDatasetBrowser>> | null = null;
  try {
    relay = await spawnSyncRelay({ dbPath: join(workspace.baseDir, "relay.sqlite"), appPublications: true,
      linkBoundary: { linkKey: randomBytes(32).toString("base64url"), relayExchangeKey: exchangeKey, publicViewerOrigin: sharedDatasetViewerOrigin } });
    relayDiagnostics = relay.diagnostics;
    const claim = await fetch(`${relay.baseUrl}/sync/workspaces`, { method: "POST", headers: { authorization: `Bearer test:${userId}`, "content-type": "application/json" }, body: JSON.stringify({ workspaceId }) });
    expect(claim.ok).toBe(true);
    await seedWorkspaceManifest(workspace, workspaceId);
    await seedWorkspaceRegistry(workspace, [{ workspaceId, rootPath: workspace.rootPath, remote: { serverUrl: relay.baseUrl, ownerUserId: userId } }]);
    await seedCloudCredentials(workspace, { serverUrl: relay.baseUrl, relayUrl: relay.baseUrl, userId, token: `test:${userId}` });
    shared = await startSharedDatasetBrowser({ relayUrl: relay.baseUrl, exchangeKey });
    desktop = await launchDesktopApp({ workspace, env: { DOHC_TEST_SYNC_DEBOUNCE_MS: "150", DOHC_TEST_SYNC_BACKOFF_MS: "250" } });
    const { page } = desktop;
    await openWorkspaceFromFirstRun(page, workspace);
    await page.keyboard.press("Control+k");
    await page.getByTestId("command-palette").getByRole("option", { name: "New collection", exact: true }).click();
    const create = page.getByTestId("new-collection-dialog");
    await create.getByLabel("Collection name").fill("Registrations");
    await create.getByLabel("Require Name").check();
    await create.getByTestId("new-collection-create").click();
    await expect(create).toBeHidden();
    const collection = page.getByRole("region", { name: "Registrations", exact: true });
    await collection.getByRole("button", { name: "New record", exact: true }).click();
    await collection.getByRole("form", { name: "New record" }).getByLabel("Name", { exact: true }).fill("Before sharing");
    await collection.getByRole("button", { name: "Create record", exact: true }).click();
    await expect(collection.getByRole("button", { name: /^Edit Name for record / })).toHaveText("Before sharing");
    await collection.getByLabel("Manage Collection", { exact: true }).click();
    // Add a real authored rule through the normal reviewed source-change path.
    const definition = JSON.parse(await readFile(join(workspace.rootPath, "Registrations/dataset.json"), "utf8")) as DatasetDefinition;
    const nameField = definition.tables[0]!.fields.find(field => field.name === "Name")!;
    const operationPath = join(workspace.rootPath, definition.operationsPath);
    const generatedSource = await readFile(operationPath, "utf8");
    const createBranch = "if (operation.kind === 'create') {";
    expect(generatedSource).toContain(createBranch);
    const customSource = generatedSource.replace(createBranch, `${createBranch}
    if (input.values?.[${JSON.stringify(nameField.fieldId)}] === 'Blocked participant') ctx.refuse('registration_closed', 'This registration is not allowed.');`);
    await writeFile(operationPath, customSource);
    await writeFile(join(workspace.rootPath, "Registrations/custom-rule.sql"), "SELECT 1;\n");
    await waitForWorkspaceFile(page, workspaceId, "Registrations/custom-rule.sql");
    await collection.getByRole("button", { name: "Fields and names", exact: true }).click();
    await page.getByRole("dialog", { name: "Fields and names", exact: true }).getByRole("button", { name: "Review source change", exact: true }).click();
    const ruleReview = page.getByRole("dialog", { name: "Review Collection change", exact: true });
    await ruleReview.getByLabel("Collection definition").fill("Registrations/dataset.json");
    await ruleReview.getByLabel("Migration file").fill("Registrations/custom-rule.sql");
    await ruleReview.getByRole("button", { name: "Review change", exact: true }).click();
    await ruleReview.getByText("Show new operation source", { exact: true }).click();
    await expect(ruleReview).toContainText("registration_closed");
    await ruleReview.getByRole("checkbox", { name: "I reviewed this change and its effect on existing data" }).check();
    await ruleReview.getByRole("button", { name: "Approve change", exact: true }).click();
    await expect(ruleReview).toBeHidden();
    const management = collection.getByLabel("Manage Collection", { exact: true });
    if (!await management.evaluate(element => element.closest("details")?.open)) await management.click();
    await collection.getByRole("button", { name: "Create form", exact: true }).click();
    const formDialog = page.getByTestId("create-dataset-form-dialog");
    await formDialog.getByRole("button", { name: "Create form", exact: true }).click();
    await expect(formDialog).toBeHidden();
    await page.getByRole("button", { name: "Review and open app", exact: true }).click();
    const publication = page.getByTestId("app-publication-dialog");
    await publication.getByRole("button", { name: "Prepare for this device", exact: true }).click();
    await expect(publication.getByRole("heading", { name: "Review app for this device", exact: true })).toBeVisible();
    await expect(publication.getByTestId("app-publication-source-paths")).toContainText("registrations-form/frontend.js");
    await expect(publication.getByTestId("app-publication-capability")).toContainText("Link actions:");
    await publication.getByRole("button", { name: "Approve for this device", exact: true }).click();
    await expect(publication.getByRole("button", { name: /^Open in browser / })).toBeVisible();
    await publication.getByRole("button", { name: "Share app folder", exact: true }).click();
    const share = page.getByTestId("share-dialog");
    await share.getByRole("radio", { name: "Anyone with the link", exact: true }).click();
    await share.getByRole("radiogroup", { name: "Link access" }).getByRole("radio", { name: "View", exact: true }).click();
    await share.getByRole("button", { name: "Create link", exact: true }).click();
    await expect(share.getByTestId("share-link-url")).toBeVisible();
    const linkUrl = (await share.getByTestId("share-link-url").textContent())!;
    expect(new URL(linkUrl).origin).toBe(sharedDatasetViewerOrigin);
    await share.getByRole("button", { name: "Copy", exact: true }).click();
    await expect(share.getByRole("button", { name: "Copied", exact: true })).toBeVisible();
    await share.getByRole("button", { name: "Close", exact: true }).click();
    await page.getByRole("button", { name: "Review and open app", exact: true }).click();
    const shareLink = publication.getByRole("combobox", { name: "Publication share link" });
    await expect(shareLink.locator("option")).toHaveCount(2);
    await shareLink.selectOption({ index: 1 });
    await publication.getByRole("button", { name: "Prepare app", exact: true }).click();
    await expect(publication.getByRole("heading", { name: "Review app publication", exact: true })).toBeVisible();
    await expect(publication.getByTestId("app-publication-source-paths")).toContainText("registrations-form/frontend.js");
    const approval = publication.getByTestId("app-publication-capability");
    await expect(approval).toContainText("Link actions:");
    await expect(approval).toContainText("Helper actions: None");
    await expect(approval).toContainText("Owner actions: None");
    await page.screenshot({ path: info.outputPath("owner-publication-review.png") });
    await publication.getByRole("button", { name: "Publish this revision", exact: true }).click();
    await expect(publication.getByRole("status")).toHaveText("App published on the selected link.");
    await expect(publication.getByRole("button", { name: /^Unpublish / })).toBeVisible();
    await publication.getByRole("button", { name: "Close publication", exact: true }).click();
    const listed = await page.evaluate(async workspaceId => window.dohcDesktop!.dataset({ workspaceId, action: "list" }), workspaceId);
    if (listed.kind !== "list" || listed.datasets.length !== 1) throw Error("Expected one Collection.");
    const dataset = listed.datasets[0]!, table = dataset.tables[0]!;
    const guest = await shared.browser.newPage();
    guest.setDefaultTimeout(30_000);
    guest.on("pageerror", error => shared!.failures.push(error.message));
    await guest.goto(linkUrl);
    await guest.getByRole("button", { name: "Open app", exact: true }).click();
    await expect(guest).toHaveURL(/^https:\/\/[a-f0-9]{48}\.example\.net\/bootstrap$/);
    const form = guest.frameLocator("iframe");
    await form.getByLabel("Name", { exact: false }).fill("Shared browser participant");
    await form.getByRole("button", { name: "Submit", exact: true }).click();
    await expect(form.getByRole("status")).toHaveText("Response received.");
    await guest.screenshot({ path: info.outputPath("shared-generated-form.png") });
    const path = `tab://data-collection/${dataset.datasetId}/${table.tableId}`;
    await page.getByTestId(`tab-${path}`).click();
    await collection.getByRole("button", { name: "Refresh", exact: true }).click();
    const names = collection.getByRole("button", { name: /^Edit Name for record / });
    await expect(names).toHaveCount(2);
    expect(await names.allTextContents()).toEqual(expect.arrayContaining(["Before sharing", "Shared browser participant"]));
    const beforePublications = await page.evaluate(async workspaceId => window.dohcDesktop!.publishOwnerApp({ action: "list", workspaceId, appRoot: "registrations-form" }), workspaceId);
    if (!await management.evaluate(element => element.closest("details")?.open)) await management.click();
    await collection.getByRole("button", { name: "Fields and names", exact: true }).click();
    const fields = page.getByRole("dialog", { name: "Fields and names", exact: true });
    await fields.getByLabel("Change", { exact: true }).selectOption("renameField");
    await fields.getByLabel("Field", { exact: true }).selectOption(nameField.fieldId);
    await fields.getByLabel("Name", { exact: true }).fill("Participant");
    await fields.getByRole("button", { name: "Review change", exact: true }).click();
    const renameReview = page.getByRole("dialog", { name: "Review Collection change", exact: true });
    await expect(renameReview.getByRole("region", { name: "Field changes" })).toContainText("Participant");
    await renameReview.getByRole("button", { name: "Approve change", exact: true }).click();
    await expect(renameReview).toBeHidden();
    expect(await readFile(operationPath, "utf8")).toBe(customSource);
    await expect(collection.getByRole("button", { name: /^Edit Participant for record / })).toHaveCount(2);

    // The approved app still uses the previous display label and binding. No republish.
    await form.getByRole("button", { name: "Submit another response", exact: true }).click();
    await expect(form.getByLabel("Name", { exact: false })).toBeEnabled();
    await guest.reload();
    await form.getByLabel("Name", { exact: false }).fill("After field rename");
    await form.getByRole("button", { name: "Submit", exact: true }).click();
    await expect(form.getByRole("status")).toHaveText("Response received.");
    await form.getByRole("button", { name: "Submit another response", exact: true }).click();
    await expect(form.getByLabel("Name", { exact: false })).toBeEnabled();
    await guest.reload();
    await form.getByLabel("Name", { exact: false }).fill("Blocked participant");
    await form.getByRole("button", { name: "Submit", exact: true }).click();
    await expect(form.getByRole("status")).toContainText("This registration is not allowed.");
    await collection.getByRole("button", { name: "Refresh", exact: true }).click();
    const participants = collection.getByRole("button", { name: /^Edit Participant for record / });
    await expect(participants).toHaveCount(3);
    expect(await participants.allTextContents()).toEqual(expect.arrayContaining(["Before sharing", "Shared browser participant", "After field rename"]));
    const afterPublications = await page.evaluate(async workspaceId => window.dohcDesktop!.publishOwnerApp({ action: "list", workspaceId, appRoot: "registrations-form" }), workspaceId);
    expect(afterPublications).toEqual(beforePublications);
    await page.screenshot({ path: info.outputPath("renamed-collection-custom-rule.png") });
    expect(shared.failures).toEqual([]);
    expect(desktop.logs.filter(entry => entry.level === "pageerror")).toEqual([]);
    await info.attach("scope", { body: JSON.stringify({ workspaceId, datasetId: dataset.datasetId,
      identity: "Test identity seeded into isolated profile; account onboarding is outside this proof.",
      transport: "Real relay HTTP, real share-web handler over temporary TLS, browser-local DNS and certificate trust.",
      browserDispatch: "Only Electron shell.openExternal is intercepted; the local URL returned by production launch opens in a real browser.",
      flow: "Desktop Collection and generated form → local approval and browser preview → visible source sharing and publication approval → guest → owner → offline restart." }, null, 2), contentType: "application/json" });
  } finally {
    try { await shared?.close(); } finally {
      try { await relay?.stop(); } finally {
        if (relayDiagnostics) await info.attach("relay logs", { body: JSON.stringify(relayDiagnostics(), null, 2), contentType: "application/json" });
        await cleanupDesktopWorkspace(desktop, workspace);
      }
    }
  }
});


test("@dataset-completion history reverses an authored rule against current records", async () => {
  test.setTimeout(180_000);
  const workspace = await createTempWorkspace();
  let desktop: Awaited<ReturnType<typeof launchDesktopApp>> | null = null;
  try {
    desktop = await launchDesktopApp({ workspace });
    const { page } = desktop;
    const { workspaceId } = await openWorkspaceFromFirstRun(page, workspace);
    await page.keyboard.press("Control+k");
    await page.getByTestId("command-palette").getByRole("option", { name: "New collection", exact: true }).click();
    const create = page.getByTestId("new-collection-dialog");
    await create.getByLabel("Collection name").fill("Registrations");
    await create.getByTestId("new-collection-create").click();
    await expect(create).toBeHidden();
    const collection = page.getByRole("region", { name: "Registrations", exact: true });
    const definition = JSON.parse(await readFile(join(workspace.rootPath, "Registrations/dataset.json"), "utf8")) as DatasetDefinition;
    const nameField = definition.tables[0]!.fields.find(field => field.name === "Name")!;
    const operationPath = join(workspace.rootPath, definition.operationsPath);
    const original = await readFile(operationPath, "utf8");
    const branch = "if (operation.kind === 'create') {";
    expect(original).toContain(branch);
    const custom = original.replace(branch, `${branch}\n    if (input.values?.[${JSON.stringify(nameField.fieldId)}] === 'Blocked participant') ctx.refuse('registration_closed', 'This registration is not allowed.');`);
    await writeFile(operationPath, custom);
    await writeFile(join(workspace.rootPath, "Registrations/custom-rule.sql"), "SELECT 1;\n");
    await waitForWorkspaceFile(page, workspaceId, "Registrations/custom-rule.sql");
    await collection.getByLabel("Manage Collection", { exact: true }).click();
    await collection.getByRole("button", { name: "Fields and names", exact: true }).click();
    await page.getByRole("dialog", { name: "Fields and names", exact: true }).getByRole("button", { name: "Review source change", exact: true }).click();
    const review = page.getByRole("dialog", { name: "Review Collection change", exact: true });
    await review.getByLabel("Collection definition").fill("Registrations/dataset.json");
    await review.getByLabel("Migration file").fill("Registrations/custom-rule.sql");
    await review.getByRole("button", { name: "Review change", exact: true }).click();
    await review.getByRole("checkbox", { name: "I reviewed this change and its effect on existing data" }).check();
    await review.getByRole("button", { name: "Approve change", exact: true }).click();
    await expect(review).toBeHidden();
    const described = await page.evaluate(async input => window.dohcDesktop!.dataset({ action: "describe", ...input }), { workspaceId, datasetId: definition.datasetId });
    if (described.kind !== "description") throw Error("Expected current Collection.");
    const invoke = { action: "invoke" as const, workspaceId, datasetId: definition.datasetId, revision: described.dataset.revision, revisionSha256: described.dataset.revisionSha256,
      operationId: definition.operations.find(operation => operation.kind === "create")!.operationId, input: { values: { [nameField.fieldId]: "Blocked participant" } }, idempotencyKey: "blocked-before-reversal" };
    const refused = await page.evaluate(async request => window.dohcDesktop!.dataset(request), invoke);
    expect(refused).toMatchObject({ kind: "refused", code: "registration_closed" });
    await collection.getByRole("button", { name: "New record", exact: true }).click();
    await collection.getByRole("form", { name: "New record", exact: true }).getByLabel("Name", { exact: true }).fill("Registered after rule change");
    await collection.getByRole("button", { name: "Create record", exact: true }).click();
    await expect(collection.getByRole("button", { name: /^Edit Name for record / })).toHaveText("Registered after rule change");
    const management = collection.getByLabel("Manage Collection", { exact: true });
    if (!await management.evaluate(element => element.closest("details")?.open)) await management.click();
    await collection.getByRole("button", { name: "History", exact: true }).click();
    const history = page.getByRole("dialog", { name: "Collection history", exact: true });
    const change = history.locator("details").filter({ has: page.locator("summary", { hasText: "Fields and rules" }) }).first();
    await change.locator("summary").first().click();
    await change.getByRole("button", { name: "Compare change", exact: true }).click();
    const before = history.getByRole("region", { name: "Before change", exact: true });
    const after = history.getByRole("region", { name: "After change", exact: true });
    await before.getByText("Rules", { exact: true }).click();
    await after.getByText("Rules", { exact: true }).click();
    await expect(before).not.toContainText("registration_closed");
    await expect(after).toContainText("registration_closed");
    await history.getByRole("button", { name: "Review reversal", exact: true }).click();
    await expect(review).toBeVisible();
    await review.getByRole("checkbox", { name: "I reviewed this change and its effect on existing data" }).check();
    await review.getByRole("button", { name: "Approve change", exact: true }).click();
    await expect(review).toBeHidden();
    await expect(collection.getByRole("button", { name: /^Edit Name for record / })).toHaveText("Registered after rule change");
    const current = await page.evaluate(async input => window.dohcDesktop!.dataset({ action: "describe", ...input }), { workspaceId, datasetId: definition.datasetId });
    if (current.kind !== "description") throw Error("Expected reversed Collection.");
    const accepted = await page.evaluate(async request => window.dohcDesktop!.dataset(request), { ...invoke, revision: current.dataset.revision, revisionSha256: current.dataset.revisionSha256, idempotencyKey: "accepted-after-reversal" });
    expect(accepted).toMatchObject({ kind: "invoked", replayed: false });
    await collection.getByRole("button", { name: "Refresh", exact: true }).click();
    await expect(collection.getByRole("button", { name: /^Edit Name for record / })).toHaveCount(2);
    expect(await collection.getByRole("button", { name: /^Edit Name for record / }).allTextContents()).toEqual(expect.arrayContaining(["Registered after rule change", "Blocked participant"]));
    expect(desktop.logs.filter(entry => entry.level === "pageerror")).toEqual([]);
  } finally { await cleanupDesktopWorkspace(desktop, workspace); }
});

test("@dataset-completion board and calendar page all records and save governed moves", async ({}, info) => {
  test.setTimeout(180_000);
  const workspace = await createTempWorkspace();
  let desktop: Awaited<ReturnType<typeof launchDesktopApp>> | null = null;
  try {
    desktop = await launchDesktopApp({ workspace });
    const { page } = desktop;
    const { workspaceId } = await openWorkspaceFromFirstRun(page, workspace);
    await page.keyboard.press("Control+k");
    await page.getByTestId("command-palette").getByRole("option", { name: "New collection", exact: true }).click();
    const create = page.getByTestId("new-collection-dialog");
    await create.getByLabel("Collection name").fill("Tasks");
    await create.getByRole("button", { name: "Add field", exact: true }).click();
    await create.getByLabel("Field name", { exact: true }).nth(1).fill("Status");
    await create.getByLabel("Field type", { exact: true }).nth(1).selectOption("select");
    await create.getByLabel("Options", { exact: true }).fill("Todo, Done");
    await create.getByRole("button", { name: "Add field", exact: true }).click();
    await create.getByLabel("Field name", { exact: true }).nth(2).fill("Due");
    await create.getByLabel("Field type", { exact: true }).nth(2).selectOption("date");
    await create.getByTestId("new-collection-create").click();
    await expect(create).toBeHidden();
    const listed = await page.evaluate(async workspaceId => window.dohcDesktop!.dataset({ action: "list", workspaceId }), workspaceId);
    if (listed.kind !== "list" || listed.datasets.length !== 1) throw Error("Expected Tasks Collection.");
    const dataset = listed.datasets[0]!, table = dataset.tables[0]!;
    const field = (name: string) => table.fields.find(field => field.name === name)!.fieldId;
    const pin = { workspaceId, datasetId: dataset.datasetId, revision: dataset.revision, revisionSha256: dataset.revisionSha256 };
    const createOperation = dataset.operations.find(operation => operation.kind === "create")!.operationId;
    const readOperation = dataset.operations.find(operation => operation.kind === "read")!.operationId;
    const today = new Date(), date = `${today.getFullYear()}-${String(today.getMonth()+1).padStart(2,"0")}-10`;
    // Seed > one page through approved operations. UI creation and view editing remain real.
    for (let index = 0; index < 53; index++) {
      const name = `Task ${String(index).padStart(3,"0")}`;
      const result = await page.evaluate(async request => window.dohcDesktop!.dataset(request), { ...pin, action: "invoke" as const, operationId: createOperation,
        idempotencyKey: `seed-task-${index}`, input: { values: { [field("Name")]: name, [field("Status")]: index === 52 ? "Done" : "Todo", [field("Due")]: date } } });
      if (result.kind !== "invoked" || !result.result || typeof result.result !== "object" || Array.isArray(result.result)) throw Error("Expected seeded task.");
    }
    const collection = page.getByRole("region", { name: "Tasks", exact: true });
    await collection.getByRole("button", { name: "Refresh", exact: true }).click();
    await collection.getByRole("button", { name: "Views", exact: true }).click();
    const views = page.getByRole("region", { name: "Collection views", exact: true });
    await views.getByRole("button", { name: "Create view", exact: true }).click();
    await views.getByLabel("View name").fill("By status");
    await views.getByLabel("View layout").selectOption("board");
    await views.getByLabel("Board group field").selectOption(field("Status"));
    await views.getByLabel("Sort view by").selectOption(field("Name"));
    await views.getByRole("button", { name: "Save view", exact: true }).click();
    await views.getByRole("button", { name: "Done", exact: true }).click();
    const todo = collection.getByRole("region", { name: "Todo", exact: true });
    const done = collection.getByRole("region", { name: "Done", exact: true });
    await expect(todo.getByRole("listitem", { name: "Task 000", exact: true })).toBeVisible();
    await collection.getByRole("button", { name: "Next records in Todo", exact: true }).click();
    await expect(todo.getByRole("listitem", { name: "Task 051", exact: true })).toBeVisible();
    await expect(collection.getByRole("button", { name: "Next records in Todo", exact: true })).toBeDisabled();
    await dragBoardCard(page, todo.getByRole("listitem", { name: "Task 051", exact: true }), done);
    await expect(done.getByRole("listitem", { name: "Task 051", exact: true })).toBeVisible();
    const readTask = async (name: string) => page.evaluate(async request => window.dohcDesktop!.dataset(request), { ...pin, action: "invoke" as const, operationId: readOperation,
      idempotencyKey: `verify-${randomUUID()}`, input: { limit: 1, filters: [{ fieldId: field("Name"), value: name }] } });
    await expect.poll(async () => JSON.stringify(await readTask("Task 051"))).toContain(`"${field("Status")}":"Done"`);
    for (const theme of ["light", "dark"] as const) {
      await page.getByTestId("activity-settings").click();
      await page.getByTestId("settings-nav-appearance").click();
      await page.getByRole("radiogroup", { name: "Theme" }).getByRole("radio", { name: theme === "light" ? "Light" : "Dark", exact: true }).click();
      await page.getByRole("button", { name: "Close settings", exact: true }).click();
      await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
      await page.screenshot({ path: info.outputPath(`transactional-board-${theme}.png`) });
    }
    await collection.getByRole("button", { name: "Views", exact: true }).click();
    await views.getByRole("button", { name: "Create view", exact: true }).click();
    await views.getByLabel("View name").fill("Schedule");
    await views.getByLabel("View layout").selectOption("calendar");
    await views.getByLabel("Calendar date field").selectOption(field("Due"));
    await views.getByLabel("Sort view by").selectOption(field("Name"));
    await views.getByRole("button", { name: "Save view", exact: true }).click();
    await views.getByRole("button", { name: "Done", exact: true }).click();
    await collection.getByRole("button", { name: "Next records in this calendar", exact: true }).click();
    await expect(collection.getByRole("button", { name: "Next records in this calendar", exact: true })).toBeDisabled();
    const event = collection.locator(".rbc-event").filter({ hasText: "Task 050" });
    await expect(event).toBeVisible();
    const calendarRow = event.locator("xpath=ancestor::*[contains(concat(' ', normalize-space(@class), ' '), ' rbc-month-row ')]");
    // Drop onto a different day of the same visible week; calendar applies its date field operation.
    const originalDay = new Date(today.getFullYear(), today.getMonth(), 10).getDay();
    const eventBox = await event.boundingBox();
    const dayBox = await calendarRow.locator(".rbc-day-bg").nth((originalDay + 1) % 7).boundingBox();
    if (!eventBox || !dayBox) throw Error("The calendar event and destination day must be visible.");
    // The date background sits beneath the calendar row. Move the real pointer to
    // its coordinates so the calendar's foreground drag surface receives the drop.
    await page.mouse.move(eventBox.x + eventBox.width / 2, eventBox.y + eventBox.height / 2);
    await page.mouse.down();
    await page.mouse.move(dayBox.x + dayBox.width / 2, dayBox.y + dayBox.height / 2, { steps: 20 });
    await page.mouse.up();
    await expect.poll(async () => {
      const result = await readTask("Task 050");
      if (result.kind !== "invoked") return null;
      const data = result.result as { rows: Array<{ values: Record<string, unknown> }> };
      const due = data.rows[0]?.values[field("Due")];
      return typeof due === "string" && due !== date;
    }).toBe(true);
    const history = await page.evaluate(async request => window.dohcDesktop!.dataset(request), { action: "history" as const, workspaceId, datasetId: dataset.datasetId, limit: 5 });
    if (history.kind !== "history") throw Error("Expected durable governed edits.");
    expect(history.entries.filter(entry => entry.operation === dataset.operations.find(operation => operation.kind === "edit")!.name)).toHaveLength(2);
    await page.screenshot({ path: info.outputPath("transactional-calendar-move.png") });
    expect(desktop.logs.filter(entry => entry.level === "pageerror")).toEqual([]);
  } finally { await cleanupDesktopWorkspace(desktop, workspace); }
});

test("@dataset-completion generated form saves two files and an explicitly public relation with over 24 fields", async ({ browser }, info) => {
  test.setTimeout(180_000);
  const workspace = await createTempWorkspace();
  let desktop: Awaited<ReturnType<typeof launchDesktopApp>> | null = null;
  const context = await browser.newContext();
  try {
    desktop = await launchDesktopApp({ workspace });
    let page = desktop.page;
    const { workspaceId } = await openWorkspaceFromFirstRun(page, workspace);
    const definition = orderFormDefinition();
    const approved = await page.evaluate(async input => window.dohcDesktop!.dataset(JSON.parse(input)), JSON.stringify({ action: "create", workspaceId, definition }));
    if (approved.kind !== "approved") throw Error("Expected approved fixture Collection.");
    const pin = { workspaceId, datasetId: definition.datasetId, revision: approved.revision.revision, revisionSha256: approved.revision.revisionSha256 };
    const products = definition.tables[1]!, orders = definition.tables[0]!;
    const productField = (name: string) => products.fields.find(field => field.name === name)!.fieldId;
    const orderField = (name: string) => orders.fields.find(field => field.name === name)!.fieldId;
    const choiceOperation = definition.operations.find(operation => operation.name === "products.choices")!;
    const createdProduct = await page.evaluate(async request => window.dohcDesktop!.dataset(request), { ...pin, action: "invoke" as const,
      operationId: definition.operations.find(operation => operation.name === "products.create")!.operationId, idempotencyKey: "seed-product",
      input: { values: { [productField("Code")]: "camera", [productField("Label")]: "Camera", [productField("Internal notes")]: "Never publish this private supplier note" } } });
    expect(createdProduct).toMatchObject({ kind: "invoked" });
    // Restart refreshes the actual sidebar catalog after API fixture creation.
    await desktop.close();
    desktop = await launchDesktopApp({ workspace }); page = desktop.page;
    await openWorkspaceFromFirstRun(page, workspace);
    await page.getByRole("region", { name: "Collections", exact: true }).getByRole("button", { name: "Orders", exact: true }).click();
    const collection = page.getByRole("region", { name: "Orders", exact: true });
    await collection.getByLabel("Manage Collection", { exact: true }).click();
    await collection.getByRole("button", { name: "Create form", exact: true }).click();
    const formDialog = page.getByTestId("create-dataset-form-dialog");
    await formDialog.getByLabel("Public choices for Product", { exact: true }).selectOption(`${choiceOperation.operationId}:${productField("Label")}`);
    await expect(formDialog).toContainText("Anyone with this form can call the selected action and read its complete output.");
    await formDialog.getByRole("button", { name: "Create form", exact: true }).click();
    await expect(formDialog).toBeHidden();
    await page.getByRole("button", { name: "Review and open app", exact: true }).click();
    const publication = page.getByTestId("app-publication-dialog");
    await publication.getByRole("button", { name: "Prepare for this device", exact: true }).click();
    await publication.getByTestId("app-publication-approve").click();
    await expect(publication.getByRole("button", { name: /^Open in browser / })).toBeVisible();
    const publications = await page.evaluate(async workspaceId => window.dohcDesktop!.publishOwnerApp({ action: "listLocal", workspaceId, appRoot: "orders-form" }), workspaceId);
    if (publications.kind !== "localListed" || !publications.publications[0]) throw Error("Expected local generated form.");
    const launched = await page.evaluate(async input => window.dohcDesktop!.publishOwnerApp({ action: "launchLocal", ...input }), { workspaceId, publicationId: publications.publications[0].publicationId });
    if (launched.kind !== "localLaunched") throw Error("Expected local form URL.");
    const participant = await context.newPage();
    await participant.goto(launched.url);
    const form = participant.frameLocator("iframe");
    await form.getByLabel("Name", { exact: false }).fill("Synthetic buyer");
    await form.getByLabel(/^Product/).selectOption("camera");
    await expect(form.locator("body")).not.toContainText("Never publish this private supplier note");
    await form.getByLabel("Extra 21", { exact: false }).fill("The 25th form field works");
    const receipt = Buffer.from("Synthetic payment receipt"), photo = Buffer.from("Synthetic product reference");
    await form.getByLabel("Receipt", { exact: false }).setInputFiles({ name: "receipt.txt", mimeType: "text/plain", buffer: receipt });
    await form.getByLabel("Reference photo", { exact: false }).setInputFiles({ name: "reference.txt", mimeType: "text/plain", buffer: photo });
    await form.getByRole("button", { name: "Submit", exact: true }).click();
    await expect(form.getByRole("status")).toHaveText("Response received.");
    const read = await page.evaluate(async request => window.dohcDesktop!.dataset(request), { ...pin, action: "invoke" as const,
      operationId: definition.operations.find(operation => operation.name === "orders.list")!.operationId, idempotencyKey: "verify-form-order", input: { limit: 10 } });
    if (read.kind !== "invoked") throw Error("Expected saved order.");
    const records = (read.result as { rows: Array<{ values: Record<string, string> }> }).rows;
    expect(records).toHaveLength(1);
    const values = records[0]!.values;
    expect(values).toMatchObject({ [orderField("Name")]: "Synthetic buyer", [orderField("Product")]: "camera", [orderField("Extra 21")]: "The 25th form field works" });
    expect(values[orderField("Receipt")]).not.toBe(values[orderField("Reference photo")]);
    for (const [name, bytes] of [["Receipt", receipt], ["Reference photo", photo]] as const) {
      const file = await page.evaluate(async request => window.dohcDesktop!.dataset(request), { ...pin, action: "file" as const, fileId: values[orderField(name)]! });
      expect(file).toMatchObject({ kind: "file", bytesBase64: bytes.toString("base64") });
    }
    await participant.screenshot({ path: info.outputPath("generated-relation-two-files.png") });
    expect(desktop.logs.filter(entry => entry.level === "pageerror")).toEqual([]);
  } finally { await context.close(); await cleanupDesktopWorkspace(desktop, workspace); }
});
