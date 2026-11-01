import { expect, test, type Page } from "@playwright/test";
import { join } from "node:path";
import type { DohcDesktopBridge } from "../src/ipc/bridgeContract";
import { RelayFilePeer } from "../src/testing/relayFilePeer";
import { launchDesktopApp } from "./helpers/desktopApp";
import { claimRelayWorkspace, relayJson } from "./helpers/relayPeer";
import { spawnSyncRelay, type SyncRelayHandle } from "./helpers/syncRelay";
import { createTempWorkspace, openWorkspaceFromFirstRun, seedCloudCredentials, seedWorkspaceManifest, seedWorkspaceRegistry, showExplorerFiles } from "./helpers/workspace";

const OWNER = "test:e2e-granter";
const RECIPIENT = "test:e2e-recipient";
const COLLECTION = "trip/Tasks";
const SCHEMA = "name: Tasks\nfields:\n  Title:\n    type: text\n";
const RECORD_ID = "rec_aaaaaaaaaaaaaaaaaaaaaaaaaa";
const record = (title: string) => `---\nid: ${RECORD_ID}\nTitle: ${title}\n---\n`;

async function openCollection(page: Page, path: string) {
  await showExplorerFiles(page);
  const parts = path.split("/");
  for (let depth = 1; depth <= parts.length; depth++) {
    // Select by the path attribute, which is the Explorer's routing contract.
    const target = page.locator(`[data-testid="tree-row"][data-path="${parts.slice(0, depth).join("/")}"]`);
    await expect(target).toBeVisible({ timeout: 120_000 });
    if (depth === parts.length) await expect(target).toHaveAttribute("data-collection", "true", { timeout: 120_000 });
    await target.click();
  }
}

for (const surface of ["standalone", "mount"] as const) {
  for (const access of ["edit", "view"] as const) {
    test(`shared Collection tables load and follow pulls in a ${surface} with ${access}`, async () => {
      test.setTimeout(300_000);
      const temp = await createTempWorkspace();
      let relay: SyncRelayHandle | null = null;
      let desktop: Awaited<ReturnType<typeof launchDesktopApp>> | null = null;
      const ownerId = `shared-tables-${surface}-${access}`;
      const hostId = `recipient-${surface}-${access}`;
      try {
        relay = await spawnSyncRelay({ dbPath: join(temp.baseDir, "relay.sqlite") });
        await claimRelayWorkspace({ baseUrl: relay.baseUrl, token: OWNER, workspaceId: ownerId });
        const peer = new RelayFilePeer({ baseUrl: relay.baseUrl, token: OWNER, workspaceId: ownerId, originId: "owner" });
        await peer.writeTextFiles([
          { path: `${COLLECTION}/collection.yaml`, text: SCHEMA },
          { path: `${COLLECTION}/first.md`, text: record("Shared first") },
          { path: `${COLLECTION}/automations.yaml`, text: "version: 1\nautomations:\n  - id: stamp\n    name: Stamp\n    when: record-added\n    do:\n      - set:\n          Title: Ran\n" },
          { path: "private/collection.yaml", text: SCHEMA },
        ]);
        const shared = await relayJson(relay.baseUrl, OWNER, `/sync/${ownerId}/shares`, {
          method: "POST", body: JSON.stringify({ paths: ["trip"], recipientEmail: "e2e-recipient@dohc.test", access }),
        });
        expect(shared.status, shared.body).toBe(200);
        const { shareId } = JSON.parse(shared.body) as { shareId: string };
        const shareCode = `dohc-share:${shareId}:${relay.baseUrl}`;
        await seedCloudCredentials(temp, { serverUrl: relay.baseUrl, relayUrl: relay.baseUrl,
          email: "e2e-recipient@dohc.test", userId: "e2e-recipient", token: RECIPIENT });
        if (surface === "mount") {
          await seedWorkspaceManifest(temp, hostId);
          await seedWorkspaceRegistry(temp, [{ workspaceId: hostId, rootPath: temp.rootPath }]);
        }
        desktop = await launchDesktopApp({ workspace: temp });
        const page = desktop.page;
        let collectionPath = COLLECTION;
        let workspaceId: string;
        if (surface === "standalone") {
          await page.getByTestId("first-run-open-share").click();
          await page.getByTestId("open-share-code").fill(shareCode);
          await page.getByTestId("open-share-choose-folder").click();
          await page.getByTestId("open-share-start").click();
          await expect(page.getByTestId("shared-view-banner")).toBeVisible({ timeout: 120_000 });
          workspaceId = await page.evaluate(async () => (await (window as unknown as { dohcDesktop: DohcDesktopBridge }).dohcDesktop.getWorkspaceRegistry()).workspaces[0]!.workspaceId);
        } else {
          await openWorkspaceFromFirstRun(page, temp);
          const mounted = await page.evaluate(async input => (window as unknown as { dohcDesktop: DohcDesktopBridge }).dohcDesktop.mountShare(input), { workspaceId: hostId, shareCode });
          collectionPath = `shared-with-me/${mounted.mount.label}/${COLLECTION}`;
          workspaceId = hostId;
        }
        // These are real IPC reads against the recipient daemon, with no Collection stubs.
        await expect.poll(() => page.evaluate(async workspaceId => {
          const api = (window as unknown as { dohcDesktop: DohcDesktopBridge }).dohcDesktop;
          return (await api.listCollections({ workspaceId })).collections.map(collection => collection.path);
        }, workspaceId), { timeout: 120_000 }).toEqual([collectionPath]);
        const details = await page.evaluate(async input => {
          const api = (window as unknown as { dohcDesktop: DohcDesktopBridge }).dohcDesktop;
          return { details: await api.getCollection(input), records: await api.queryCollectionRecords(input) };
        }, { workspaceId, collectionPath });
        expect(details.details.schema.fields.map(field => field.name)).toEqual(["Title"]);
        expect(details.records.records[0]?.id).toBe(RECORD_ID);
        await openCollection(page, collectionPath);
        await expect(page.getByTestId("collection-page")).toBeVisible({ timeout: 120_000 });
        await expect(page.getByTestId("collection-page")).toContainText("Shared first");
        if (access === "view" || surface === "mount") {
          await expect(page.getByTestId("collection-new-record")).toHaveCount(0);
          await expect(page.getByTestId("collection-fields-button")).toHaveCount(0);
        }
        expect(await page.evaluate(async input => (window as unknown as { dohcDesktop: DohcDesktopBridge }).dohcDesktop.listCollectionFieldMarks(input), { workspaceId, collectionPath })).toEqual({ marks: [] });
        await page.emulateMedia({ reducedMotion: "reduce" });
        await page.getByTestId("collection-automations-button").focus();
        await page.getByTestId("collection-automations-button").press("Enter");
        await expect(page.getByTestId("collection-automations-panel")).toContainText("Stamp", { timeout: 120_000 });
        if (access === "view") await expect(page.getByTestId("collection-automations-panel").getByRole("switch")).toHaveCount(0);
        for (const theme of ["light", "dark"]) {
          await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
          await expect(page.getByTestId("collection-automations-panel")).toContainText("Stamp");
          await page.screenshot({ path: test.info().outputPath(`${surface}-${access}-${theme}.png`) });
        }
        await page.getByRole("button", { name: "Close automations" }).click();
        await peer.writeTextFiles([{ path: `${COLLECTION}/first.md`, text: record("Shared second") }]);
        // Land a pull; the existing page must re-query without the user refreshing its table.
        await page.evaluate(async ({ workspaceId, surface }) => {
          const api = (window as unknown as { dohcDesktop: DohcDesktopBridge }).dohcDesktop;
          if (surface === "standalone") await api.refreshSharedView({ workspaceId });
          else await api.refreshShareMounts({ workspaceId });
        }, { workspaceId, surface });
        await expect(page.getByTestId("collection-page")).toContainText("Shared second", { timeout: 120_000 });
        await expect(page.getByTestId("collection-page")).not.toContainText("Shared first");
      } finally {
        await desktop?.close();
        await relay?.stop();
        await temp.cleanup();
      }
    });
  }
}
