import { expect, test, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { DatasetDefinition } from "@dohc/security-contract/dataset";
import { describeDatasetRevision } from "@dohc/security-contract/dataset-artifacts";
import { generateDatasetSources } from "../src/workspaces/datasetGenerator";
import { launchDesktopApp } from "./helpers/desktopApp";
import { spawnSyncRelay, type SyncRelayHandle } from "./helpers/syncRelay";
import { cleanupDesktopWorkspace, createTempWorkspace, openWorkspaceFromFirstRun, seedCloudCredentials, seedWorkspaceManifest, seedWorkspaceRegistry } from "./helpers/workspace";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const definition: DatasetDefinition = {
  formatVersion: 1, datasetId: id(1), name: "Registrations", schemaPath: "registrations/schema.sql", operationsPath: "registrations/operations.js",
  tables: [{ tableId: id(2), name: "Registrations", sqlName: "registrations", primaryKey: "record_id", fields: [
    { fieldId: id(3), name: "ID", sqlColumn: "record_id", type: "text", required: true, unique: true },
    { fieldId: id(4), name: "Name", sqlColumn: "name", type: "text", required: true, unique: false },
  ] }],
  operations: [
    { operationId: id(5), name: "read", label: "Read", tableId: id(2), kind: "read", access: "owner", readOnly: true, fieldIds: [id(3), id(4)] },
    { operationId: id(6), name: "create", label: "Create", tableId: id(2), kind: "create", access: "owner", readOnly: false, fieldIds: [id(4)] },
    { operationId: id(7), name: "edit", label: "Edit", tableId: id(2), kind: "edit", access: "owner", readOnly: false, fieldIds: [id(4)] },
  ],
};

async function shoot(page: Page, name: string): Promise<void> {
  for (const theme of ["light", "dark"] as const) {
    await page.evaluate(async (value) => {
      document.documentElement.setAttribute("data-theme", value);
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    }, theme);
    await page.getByRole("region", { name: "Collections", exact: true }).screenshot({ path: test.info().outputPath(`${name}-section-${theme}.png`) });
    await page.screenshot({ path: test.info().outputPath(`${name}-${theme}.png`) });
  }
  await page.evaluate(() => document.documentElement.setAttribute("data-theme", "light"));
}

// Another computer keeps this workspace's Collections, as one that iCloud
// Drive carries does. This computer, signed in and not syncing the
// workspace, lists and uses the Collection moved to the server, and leaves
// the rest to the computer that keeps them.
test("@collections-server-list a computer that doesn't keep the Collections uses the ones on its server", async () => {
  test.setTimeout(180_000);
  const workspace = await createTempWorkspace(), workspaceId = randomUUID(), userId = "collections-server-owner";
  let desktop: Awaited<ReturnType<typeof launchDesktopApp>> | null = null;
  let relay: SyncRelayHandle | null = null;
  try {
    relay = await spawnSyncRelay({ dbPath: join(workspace.baseDir, "relay.sqlite") });
    const owner = { authorization: `Bearer test:${userId}`, "content-type": "application/json" };
    expect((await fetch(`${relay.baseUrl}/sync/workspaces`, { method: "POST", headers: owner, body: JSON.stringify({ workspaceId }) })).ok).toBe(true);
    const generated = generateDatasetSources(definition);
    const schemaSql = generated.files[definition.schemaPath]!, operationSource = generated.files[definition.operationsPath]!;
    const revision = describeDatasetRevision({ definition: generated.definition, revision: 1, schemaSql, operationSource });
    const activated = await fetch(`${relay.baseUrl}/sync/${workspaceId}/datasets/${definition.datasetId}/activate`, { method: "POST", headers: owner,
      body: JSON.stringify({ revision, schemaSql, operationSource, capacityBytes: 1024 * 1024 }) });
    expect(activated.status, await activated.clone().text()).toBe(200);

    await seedWorkspaceManifest(workspace, workspaceId);
    for (const [path, contents] of Object.entries(generated.files)) {
      await mkdir(dirname(join(workspace.rootPath, path)), { recursive: true });
      await writeFile(join(workspace.rootPath, path), contents);
    }
    await writeFile(join(workspace.rootPath, ".dohc", "collections.json"), `${JSON.stringify({ version: 1, workspaceId,
      installId: "install-studio-mac", label: "Studio Mac", storeId: "5b2c6c1e-2f4a-4c1b-9d7e-0a1b2c3d4e5f" })}\n`);
    // No server binding: the workspace reached this computer as a folder.
    await seedWorkspaceRegistry(workspace, [{ workspaceId, rootPath: workspace.rootPath }]);
    await seedCloudCredentials(workspace, { serverUrl: relay.baseUrl, relayUrl: relay.baseUrl, userId, token: `test:${userId}` });
    desktop = await launchDesktopApp({ workspace });
    const { page } = desktop;
    await openWorkspaceFromFirstRun(page, workspace);

    const section = page.getByRole("region", { name: "Collections", exact: true });
    await expect(section.getByRole("button", { name: "Registrations", exact: true })).toBeVisible();
    await expect(section.getByTestId("collections-elsewhere"))
      .toHaveText("Other Collections are on Studio Mac. Open this workspace there to use them, or to move them to a server.Keep the Collections on this computer");
    await expect(section.getByTestId("collections-refusal")).toHaveCount(0);
    await expect(section.getByRole("button", { name: "Restore from recovery file" })).toHaveCount(0);
    const listed = await page.evaluate(workspaceId => window.dohcDesktop!.dataset({ workspaceId, action: "list" }), workspaceId);
    expect(listed).toMatchObject({ kind: "list", datasets: [{ datasetId: definition.datasetId, datasetPath: "registrations/dataset.json" }],
      nextCursor: null, elsewhere: { server: new URL(relay.baseUrl).origin, computer: { label: "Studio Mac", sameName: false } } });
    await shoot(page, "collections-server-list");

    // The Collection opens and takes a record through the server.
    await section.getByRole("button", { name: "Registrations", exact: true }).click();
    const collection = page.getByRole("region", { name: "Registrations", exact: true });
    await collection.getByRole("button", { name: "New record", exact: true }).click();
    await collection.getByRole("form", { name: "New record" }).getByLabel("Name", { exact: true }).fill("From the other computer");
    await collection.getByRole("button", { name: "Create record", exact: true }).click();
    await expect(collection.getByRole("button", { name: /^Edit Name for record / })).toHaveText("From the other computer");
    const read = await fetch(`${relay.baseUrl}/sync/${workspaceId}/datasets/${definition.datasetId}/invoke`, { method: "POST", headers: owner,
      body: JSON.stringify({ revision: 1, revisionSha256: revision.revisionSha256, operationId: id(5), input: { limit: 50 }, idempotencyKey: "read-from-test" }) });
    expect(JSON.stringify(await read.json())).toContain("From the other computer");

    // Export, Access and the workspace's History reach the server Collection, as they do on the computer that keeps the Collections.
    const archivePath = join(workspace.baseDir, "registrations.dohc-recovery");
    await desktop.app.evaluate(({ dialog }, filePath) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath }); }, archivePath);
    await collection.getByLabel("Manage Collection", { exact: true }).click();
    await collection.getByRole("button", { name: "Export recovery", exact: true }).click();
    const exportDialog = page.getByRole("dialog", { name: "Export Registrations?", exact: true });
    await exportDialog.getByRole("button", { name: "Save recovery file", exact: true }).click();
    await expect(exportDialog).toBeHidden();
    expect((await readFile(archivePath)).byteLength).toBeGreaterThan(4096);
    const access = await page.evaluate(({ workspaceId, datasetId }) =>
      window.dohcDesktop!.getObjectAccess({ workspaceId, ref: { kind: "collection", datasetId } }), { workspaceId, datasetId: definition.datasetId });
    expect(access).toMatchObject({ visibility: "visible", unknownReason: null, freshness: "fresh", coverage: { kind: "collection", complete: true } });
    const history = await page.evaluate(workspaceId => window.dohcDesktop!.listHistory({ workspaceId }), workspaceId);
    expect(history).toMatchObject({ status: "ready", completeness: "complete", unavailableSources: [] });
    expect("entries" in history && history.entries.some(entry => entry.kind === "collection" && entry.datasetId === definition.datasetId)).toBe(true);
    const rail = page.getByRole("navigation", { name: "Activity bar", exact: true });
    await rail.getByRole("button", { name: "History", exact: true }).click();
    // The panel reads History again with the workspace's next change, as it does for any Collection on a server.
    await writeFile(join(workspace.rootPath, "notes.md"), "After the record\n");
    await expect(page.getByTestId("history-collection-change").filter({ hasText: "Registrations" })).toContainText("Create");
    await page.screenshot({ path: test.info().outputPath("collections-server-history.png") });
    await rail.getByRole("button", { name: "Explorer", exact: true }).click();

    // Approving a Collection stays with the computer that keeps them, and nothing above opened a store here.
    const refused = await page.evaluate(async workspaceId => {
      try { await window.dohcDesktop!.dataset({ action: "prepare", workspaceId, descriptorPath: "registrations/dataset.json" }); return null; }
      catch (error) { return String(error); }
    }, workspaceId);
    expect(refused).toContain("These Collections are on Studio Mac.");
    for (const store of [".dohc/local/datasets/state.sqlite", ".dohc/datasets/state.sqlite"]) expect(existsSync(join(workspace.rootPath, store))).toBe(false);

    // The server doesn't answer: the section still says where the Collections are, and the failure is reported.
    await relay.stop(); relay = null;
    await desktop.close(); desktop = null;
    desktop = await launchDesktopApp({ workspace });
    await openWorkspaceFromFirstRun(desktop.page, workspace);
    const offline = desktop.page.getByRole("region", { name: "Collections", exact: true });
    await expect(offline.getByTestId("collections-elsewhere"))
      .toHaveText("These Collections are on Studio Mac. Open this workspace there to use them, or to move them to a server.Keep the Collections on this computer");
    await expect(offline.getByTestId("collections-refusal")).toHaveCount(0);
    await expect(offline.getByRole("button", { name: "Registrations", exact: true })).toHaveCount(0);
    await expect(desktop.page.getByTestId("notice-toasts")).toContainText("Could not read Collections.");
    await shoot(desktop.page, "collections-server-offline");

    // Signed out, this computer has no server to ask, and says where the Collections are as before.
    await desktop.close(); desktop = null;
    await rm(join(workspace.homeDir, "dohc-cloud.json"));
    desktop = await launchDesktopApp({ workspace });
    await openWorkspaceFromFirstRun(desktop.page, workspace);
    const signedOut = desktop.page.getByRole("region", { name: "Collections", exact: true });
    await expect(signedOut.getByTestId("collections-refusal"))
      .toContainText("These Collections are on Studio Mac. Open this workspace there to use them, or to move them to a server.");
    await expect(signedOut.getByTestId("collections-elsewhere")).toHaveCount(0);
    await expect(signedOut.getByRole("button", { name: "Registrations", exact: true })).toHaveCount(0);
    await shoot(desktop.page, "collections-signed-out");
  } finally {
    try { await relay?.stop(); } finally { await cleanupDesktopWorkspace(desktop, workspace); }
  }
});
