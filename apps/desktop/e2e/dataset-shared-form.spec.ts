import { expect, test } from "@playwright/test";
import { randomBytes, randomUUID } from "node:crypto";
import { join } from "node:path";
import { readFile, writeFile } from "node:fs/promises";
import { launchDesktopApp } from "./helpers/desktopApp";
import { spawnSyncRelay, type SyncRelayHandle } from "./helpers/syncRelay";
import { sharedDatasetViewerOrigin, startSharedDatasetBrowser } from "./helpers/sharedDatasetBrowser";
import { cleanupDesktopWorkspace, createTempWorkspace, openWorkspaceFromFirstRun, seedCloudCredentials, seedWorkspaceManifest, seedWorkspaceRegistry } from "./helpers/workspace";

// Identity is seeded into an isolated profile. Owners create, preview, share, and publish
// through visible controls. Only the OS browser dispatcher is replaced for local preview.
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
    await desktop.app.evaluate(({ shell }) => {
      const state = globalThis as typeof globalThis & { formPreviewUrl?: string; formPreviewOpenExternal?: typeof shell.openExternal };
      state.formPreviewOpenExternal = shell.openExternal;
      shell.openExternal = async url => { state.formPreviewUrl = url; };
    });
    try {
      await publication.getByRole("button", { name: /^Open in browser / }).click();
      const openedUrl = () => desktop!.app.evaluate(() => (globalThis as typeof globalThis & { formPreviewUrl?: string }).formPreviewUrl);
      await expect.poll(openedUrl).toBeTruthy();
      const previewUrl = (await openedUrl())!;
      expect(new URL(previewUrl).protocol).toBe("http:");
      expect(new URL(previewUrl).hostname).toBe("127.0.0.1");
      const preview = await shared.browser.newPage();
      try {
        await preview.goto(previewUrl);
        await expect(preview.frameLocator("iframe").getByLabel("Name", { exact: false })).toBeEnabled();
        await expect(preview.frameLocator("iframe").getByRole("button", { name: "Submit", exact: true })).toBeEnabled();
        await preview.screenshot({ path: info.outputPath("owner-form-preview.png") });
      } finally { await preview.close(); }
    } finally {
      await desktop.app.evaluate(({ shell }) => {
        const state = globalThis as typeof globalThis & { formPreviewUrl?: string; formPreviewOpenExternal?: typeof shell.openExternal };
        shell.openExternal = state.formPreviewOpenExternal!;
        delete state.formPreviewOpenExternal;
        delete state.formPreviewUrl;
      });
    }
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
    guest.on("pageerror", error => shared!.failures.push(error.message));
    await guest.goto(linkUrl);
    await guest.getByRole("button", { name: "Open app", exact: true }).click();
    await expect(guest).toHaveURL(/^https:\/\/[a-f0-9]{48}\.example\.net\/bootstrap$/);
    const form = guest.frameLocator("iframe");
    await form.getByLabel("Name", { exact: false }).fill("Shared browser participant");
    await form.getByRole("button", { name: "Submit", exact: true }).click();
    await expect(form.getByRole("status")).toHaveText("Response received.");
    await guest.screenshot({ path: info.outputPath("shared-generated-form.png") });
    const path = `dohc://data-collection/${encodeURIComponent(dataset.datasetPath!)}/${table.tableId}`;
    await page.getByTestId(`tab-${path}`).click();
    await collection.getByRole("button", { name: "Refresh", exact: true }).click();
    const names = collection.getByRole("button", { name: /^Edit Name for record / });
    await expect(names).toHaveCount(2);
    expect(await names.allTextContents()).toEqual(expect.arrayContaining(["Before sharing", "Shared browser participant"]));
    const request = { action: "invoke" as const, workspaceId, datasetPath: dataset.datasetPath!, revision: dataset.revision,
      revisionSha256: dataset.revisionSha256, operationId: dataset.operations.find(operation => operation.kind === "read")!.operationId,
      input: { limit: 50 }, idempotencyKey: "read-shared-copy" };
    const online = await page.evaluate(async request => window.dohcDesktop!.dataset(request), request);
    if (online.kind !== "invoked") throw Error("Expected authoritative Collection data.");
    expect(JSON.stringify(online.result)).toContain("Shared browser participant");
    // Publish a dashboard against the same authoritative Collection, with an explicit read approval.
    const appRoot = "registrations-form", manifestPath = join(workspace.rootPath, appRoot, "app.publish.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as { dataset: import("@dohc/security-contract/dataset").AppDatasetBinding };
    const read = dataset.operations.find(operation => operation.kind === "read")!;
    manifest.dataset.operationIds = [read.operationId];
    delete manifest.dataset.createFields;
    await writeFile(manifestPath, JSON.stringify(manifest));
    await writeFile(join(workspace.rootPath, appRoot, "frontend.js"), `
      const output = document.createElement('pre'), refresh = document.createElement('button');
      refresh.textContent = 'Refresh records'; document.body.append(refresh, output);
      let port;
      function load() { port.postMessage({id:crypto.randomUUID(),op:'backend.invoke',operation:${JSON.stringify(read.name)},idempotencyKey:crypto.randomUUID(),input:{limit:50}}); }
      addEventListener('message', event => {
        if (port || event.source !== parent || event.data?.kind !== 'dohc-app-channel') return;
        port = event.ports[0]; port.onmessage = ({data}) => { output.textContent = data.ok ? JSON.stringify(data.value.result) : 'Access withdrawn'; };
        port.start(); refresh.onclick = load; load();
      });
    `);
    const publications = await page.evaluate(async input => window.dohcDesktop!.publishOwnerApp({ action: "list", ...input }), { workspaceId, appRoot });
    if (publications.kind !== "listed") throw Error("Expected publications.");
    for (const item of publications.publications.filter(item => item.active)) await page.evaluate(async input => window.dohcDesktop!.publishOwnerApp({ action: "withdraw", ...input }),
      { workspaceId, publicationId: item.publicationId, expectedAuthorityRevision: item.authorityRevision });
    const original = publications.publications[0]!;
    const dashboard = await page.evaluate(async input => window.dohcDesktop!.publishOwnerApp({ action: "prepare", ...input }),
      { workspaceId, appRoot, shareId: original.shareId, grantId: original.grantId });
    if (dashboard.kind !== "prepared") throw Error("Expected dashboard review.");
    const publishedDashboard = await page.evaluate(async input => window.dohcDesktop!.publishOwnerApp({ action: "approve", ...input }),
      { workspaceId, approvalId: dashboard.approvalId, candidateDigest: dashboard.candidateDigest, linkReads: [{ operationId: read.operationId, fieldIds: read.fieldIds }] });
    if (publishedDashboard.kind !== "published") throw Error("Expected dashboard publication.");
    const reader = await shared.browser.newPage();
    await reader.goto(linkUrl);
    await reader.getByRole("button", { name: "Open app", exact: true }).click();
    const dashboardFrame = reader.frameLocator("iframe");
    await expect(dashboardFrame.locator("pre")).toContainText("Shared browser participant");
    const createOperation = dataset.operations.find(operation => operation.kind === "create")!;
    const nameField = table.fields.find(field => field.name === "Name")!;
    await page.evaluate(async input => window.dohcDesktop!.dataset(input), { ...request, operationId: createOperation.operationId,
      input: { values: { [nameField.fieldId]: "Added after publication" } }, idempotencyKey: randomUUID() });
    await dashboardFrame.getByRole("button", { name: "Refresh records" }).click();
    await expect(dashboardFrame.locator("pre")).toContainText("Added after publication");
    await page.evaluate(async input => window.dohcDesktop!.publishOwnerApp({ action: "withdraw", ...input }),
      { workspaceId, publicationId: publishedDashboard.publicationId, expectedAuthorityRevision: publishedDashboard.authorityRevision });
    await dashboardFrame.getByRole("button", { name: "Refresh records" }).click();
    await expect(dashboardFrame.locator("pre")).toHaveText("Access withdrawn");
    await reader.close();
    const current = await page.evaluate(async request => window.dohcDesktop!.dataset(request), { ...request, idempotencyKey: randomUUID() });
    if (current.kind !== "invoked") throw Error("Expected current Collection data.");
    await relay.stop(); relay = null;
    const offline = await page.evaluate(async request => window.dohcDesktop!.dataset(request), request);
    expect(offline).toMatchObject({ kind: "invoked", result: current.result, copy: { offline: true } });
    await desktop.close(); desktop = await launchDesktopApp({ workspace });
    await openWorkspaceFromFirstRun(desktop.page, workspace);
    const reopened = await desktop.page.evaluate(async request => window.dohcDesktop!.dataset(request), request);
    expect(reopened).toMatchObject({ kind: "invoked", result: current.result, copy: { offline: true } });
    expect(shared.failures).toEqual([]);
    expect(desktop.logs.filter(entry => entry.level === "pageerror")).toEqual([]);
    await info.attach("scope", { body: JSON.stringify({ workspaceId, datasetPath: dataset.datasetPath!,
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
