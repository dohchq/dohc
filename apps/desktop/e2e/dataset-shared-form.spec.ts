import { expect, test } from "@playwright/test";
import { randomBytes, randomUUID } from "node:crypto";
import { join } from "node:path";
import { launchDesktopApp } from "./helpers/desktopApp";
import { spawnSyncRelay, type SyncRelayHandle } from "./helpers/syncRelay";
import { sharedDatasetViewerOrigin, startSharedDatasetBrowser } from "./helpers/sharedDatasetBrowser";
import { cleanupDesktopWorkspace, createTempWorkspace, openWorkspaceFromFirstRun, seedCloudCredentials, seedWorkspaceManifest, seedWorkspaceRegistry } from "./helpers/workspace";

// Identity is seeded into an isolated profile. Creation, capture, sharing, publication,
// authority transfer, browser writes, owner reads, and saved-copy reads are production paths.
test("@dataset-shared-form desktop publishes its Collection, a guest submits, and the owner reads the saved copy offline", async ({}, info) => {
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
    await desktop.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.webContents.send("desktop:menu-command", "new-collection"));
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
    await collection.getByRole("button", { name: "Create form", exact: true }).click();
    const formDialog = page.getByTestId("create-dataset-form-dialog");
    await formDialog.getByRole("button", { name: "Create form", exact: true }).click();
    await expect(formDialog).toBeHidden();
    const listed = await page.evaluate(async workspaceId => window.dohcDesktop!.dataset({ workspaceId, action: "list" }), workspaceId);
    if (listed.kind !== "list" || listed.datasets.length !== 1) throw Error("Expected one Collection.");
    const dataset = listed.datasets[0]!, table = dataset.tables[0]!;
    const link = await page.evaluate(async workspaceId => window.dohcDesktop!.createRelayShareLink({ workspaceId, paths: ["registrations-form"], access: "view" }), workspaceId);
    const prepared = await page.evaluate(async input => window.dohcDesktop!.publishOwnerApp({ ...input, action: "prepare" }), {
      workspaceId, appRoot: "registrations-form", shareId: link.shareId, grantId: link.grantId,
    });
    if (prepared.kind !== "prepared") throw Error("Expected prepared app.");
    const published = await page.evaluate(async input => window.dohcDesktop!.publishOwnerApp({ ...input, action: "approve" }), {
      workspaceId, approvalId: prepared.approvalId, candidateDigest: prepared.candidateDigest,
    });
    expect(published.kind).toBe("published");
    const guest = await shared.browser.newPage();
    guest.on("pageerror", error => shared!.failures.push(error.message));
    await guest.goto(link.url);
    await guest.getByRole("button", { name: "Open app", exact: true }).click();
    await expect(guest).toHaveURL(/^https:\/\/[a-f0-9]{48}\.example\.net\/bootstrap$/);
    const form = guest.frameLocator("iframe");
    await form.getByLabel("Name", { exact: false }).fill("Shared browser participant");
    await form.getByRole("button", { name: "Submit", exact: true }).click();
    await expect(form.getByRole("status")).toHaveText("Response received.");
    await guest.screenshot({ path: info.outputPath("shared-generated-form.png") });
    const path = `dohc://data-collection/${dataset.datasetId}/${table.tableId}`;
    await page.getByTestId(`tab-${path}`).click();
    await collection.getByRole("button", { name: "Refresh", exact: true }).click();
    const names = collection.getByRole("button", { name: /^Edit Name for record / });
    await expect(names).toHaveCount(2);
    expect(await names.allTextContents()).toEqual(expect.arrayContaining(["Before sharing", "Shared browser participant"]));
    const request = { action: "invoke" as const, workspaceId, datasetId: dataset.datasetId, revision: dataset.revision,
      revisionSha256: dataset.revisionSha256, operationId: dataset.operations.find(operation => operation.kind === "read")!.operationId,
      input: { limit: 50 }, idempotencyKey: "read-shared-copy" };
    const online = await page.evaluate(async request => window.dohcDesktop!.dataset(request), request);
    if (online.kind !== "invoked") throw Error("Expected authoritative Collection data.");
    expect(JSON.stringify(online.result)).toContain("Shared browser participant");
    await relay.stop(); relay = null;
    const offline = await page.evaluate(async request => window.dohcDesktop!.dataset(request), request);
    expect(offline).toMatchObject({ kind: "invoked", result: online.result, copy: { offline: true } });
    await desktop.close(); desktop = await launchDesktopApp({ workspace });
    await openWorkspaceFromFirstRun(desktop.page, workspace);
    const reopened = await desktop.page.evaluate(async request => window.dohcDesktop!.dataset(request), request);
    expect(reopened).toMatchObject({ kind: "invoked", result: online.result, copy: { offline: true } });
    expect(shared.failures).toEqual([]);
    expect(desktop.logs.filter(entry => entry.level === "pageerror")).toEqual([]);
    await info.attach("scope", { body: JSON.stringify({ workspaceId, datasetId: dataset.datasetId, publication: published,
      identity: "Test identity seeded into isolated profile; account onboarding is outside this proof.",
      transport: "Real relay HTTP, real share-web handler over temporary TLS, browser-local DNS and certificate trust.",
      flow: "Desktop Collection and generated form → source share → main publication and transfer → guest → owner → offline restart." }, null, 2), contentType: "application/json" });
  } finally {
    try { await shared?.close(); } finally {
      try { await relay?.stop(); } finally {
        if (relayDiagnostics) await info.attach("relay logs", { body: JSON.stringify(relayDiagnostics(), null, 2), contentType: "application/json" });
        await cleanupDesktopWorkspace(desktop, workspace);
      }
    }
  }
});
