import { expect, test, type Page } from "@playwright/test";
import { join } from "node:path";
import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import type { DohcDesktopBridge } from "../src/ipc/bridgeContract";
import { launchDesktopApp } from "./helpers/desktopApp";
import { relayJson } from "./helpers/relayPeer";
import { relayAdoptedIdentity, spawnSyncRelay, type SyncRelayHandle } from "./helpers/syncRelay";
import { createTempWorkspace, openWorkspaceFromFirstRun, seedCloudCredentials, seedWorkspaceManifest, seedWorkspaceRegistry, showExplorerFiles, writeWorkspaceFiles } from "./helpers/workspace";

const OWNER = "test:e2e-granter", RECIPIENT = "test:e2e-recipient";
const COLLECTION = "trip/Tasks", RECORD = "rec_aaaaaaaaaaaaaaaaaaaaaaaaaa";
const AUTOMATIONS = `version: 1
automations:
  - id: finish
    name: Finish
    when: {button: Finish}
    do:
      - set: {Status: Done}
  - id: fail
    name: Fail
    when: {button: Fail}
    do:
      - set: {Status: '=missingFunction()'}
`;

async function buttons(page: Page, workspaceId: string) {
  return page.evaluate(async input => (window as unknown as { dohcDesktop: DohcDesktopBridge }).dohcDesktop.listAutomationButtons(input),
    { workspaceId, collectionPath: COLLECTION });
}

async function openTable(page: Page) {
  await showExplorerFiles(page);
  for (const path of ["trip", COLLECTION]) {
    const row = page.locator(`[data-testid="tree-row"][data-path="${path}"]`);
    await expect(row).toBeVisible({ timeout: 120_000 });
    await row.click();
  }
  await expect(page.getByRole("button", { name: "Open Shared first", exact: true })).toBeVisible({ timeout: 120_000 });
}

test("@two-client shared Buttons use host identity and show the named presser in History", async () => {
  test.setTimeout(420_000);
  const ownerTemp = await createTempWorkspace(), recipientTemp = await createTempWorkspace();
  const workspaceId = "shared-buttons-owner";
  let relay: SyncRelayHandle | null = null;
  let owner: Awaited<ReturnType<typeof launchDesktopApp>> | null = null;
  let recipient: Awaited<ReturnType<typeof launchDesktopApp>> | null = null;
  try {
    relay = await spawnSyncRelay({ dbPath: join(ownerTemp.baseDir, "relay.sqlite") });
    await seedWorkspaceManifest(ownerTemp, workspaceId);
    await seedWorkspaceRegistry(ownerTemp, [{ workspaceId, rootPath: ownerTemp.rootPath }]);
    await seedCloudCredentials(ownerTemp, { serverUrl: relay.baseUrl, relayUrl: relay.baseUrl,
      email: "e2e-granter@dohc.test", userId: "e2e-granter", token: OWNER });
    await writeWorkspaceFiles(ownerTemp, [
      { path: `${COLLECTION}/collection.yaml`, contents: "name: Tasks\nfields:\n  Title: {type: text}\n  Status: {type: text}\n  Finish: {type: button}\n  Fail: {type: button}\n" },
      { path: `${COLLECTION}/automations.yaml`, contents: AUTOMATIONS },
    ]);
    owner = await launchDesktopApp({ workspace: ownerTemp });
    await openWorkspaceFromFirstRun(owner.page, ownerTemp);
    // Use the desktop's record-creation path. Seeded Markdown capture has a
    // separate delivery defect: its Y.Doc base reaches the relay without a file moment.
    await owner.page.evaluate(async input => (window as unknown as { dohcDesktop: DohcDesktopBridge }).dohcDesktop.createCollectionRecord(input),
      { workspaceId, collectionPath: COLLECTION, name: "Shared first", recordId: RECORD });

    await expect.poll(() => owner!.page.evaluate(async input => (window as unknown as { dohcDesktop: DohcDesktopBridge }).dohcDesktop.queryCollectionRecords(input), { workspaceId, collectionPath: COLLECTION }), { timeout: 120_000 }).toMatchObject({ records: [expect.objectContaining({ id: RECORD })] });
    await owner.page.evaluate(async workspaceId => (window as unknown as { dohcDesktop: DohcDesktopBridge }).dohcDesktop.cloudEnableSync({ workspaceId }), workspaceId);
    await expect.poll(async () => {
      const identity = relayAdoptedIdentity(relay!.dbPath, workspaceId);
      const query = new URLSearchParams({ since: "0", limit: "1000", ...(identity ?? {}) });
      const response = await relayJson(relay!.baseUrl, OWNER, `/sync/${workspaceId}/log?${query}`);
      return response.status === 200 && [`${COLLECTION}/automations.yaml`, `${COLLECTION}/Shared first.md`].every(path => response.body.includes(path));
    }, { timeout: 120_000 }).toBe(true);
    const shared = await owner.page.evaluate(async workspaceId => (window as unknown as { dohcDesktop: DohcDesktopBridge }).dohcDesktop.createRelayShare({ workspaceId,
      paths: ["trip"], recipientEmail: "e2e-recipient@dohc.test", access: "edit" }), workspaceId);
    await seedCloudCredentials(recipientTemp, { serverUrl: relay.baseUrl, relayUrl: relay.baseUrl,
      email: "e2e-recipient@dohc.test", userId: "e2e-recipient", token: RECIPIENT });
    recipient = await launchDesktopApp({ workspace: recipientTemp });
    const page = recipient.page;
    await page.getByTestId("first-run-open-share").click();
    await page.getByTestId("open-share-code").fill(`dohc-share:${shared.shareId}:${relay.baseUrl}`);
    await page.getByTestId("open-share-choose-folder").click();
    await page.getByTestId("open-share-start").click();
    await expect(page.getByTestId("shared-view-banner")).toBeVisible({ timeout: 120_000 });
    const recipientWorkspaceId = await page.evaluate(async () => (await (window as unknown as { dohcDesktop: DohcDesktopBridge }).dohcDesktop.getWorkspaceRegistry()).workspaces[0]!.workspaceId);
    const ownerCollection = await owner.page.evaluate(async input => (window as unknown as { dohcDesktop: DohcDesktopBridge }).dohcDesktop.getCollection(input), { workspaceId, collectionPath: COLLECTION });
    const projection = await page.evaluate(async input => {
      const api = (window as unknown as { dohcDesktop: DohcDesktopBridge }).dohcDesktop;
      return { collection: await api.getCollection(input), records: await api.queryCollectionRecords(input) };
    }, { workspaceId: recipientWorkspaceId, collectionPath: COLLECTION });
    await test.info().attach("record-projection", { body: JSON.stringify(projection), contentType: "application/json" });
    const receivedText = await page.evaluate(async input => {
      try { return await (window as unknown as { dohcDesktop: DohcDesktopBridge }).dohcDesktop.readWorkspaceText(input); }
      catch (error) { return { error: String(error) }; }
    }, { workspaceId: recipientWorkspaceId, relativePath: `${COLLECTION}/Shared first.md` });
    await test.info().attach("received-record-text", { body: JSON.stringify(receivedText), contentType: "application/json" });
    const identity = relayAdoptedIdentity(relay.dbPath, workspaceId);
    const log = await relayJson(relay.baseUrl, OWNER, `/sync/${workspaceId}/log?${new URLSearchParams({ since: "0", limit: "1000", ...(identity ?? {}) })}`);
    await test.info().attach("record-sync-ops", { body: JSON.stringify((JSON.parse(log.body) as { ops: Array<{ payload: { path?: string } }> }).ops.filter(op => op.payload.path === `${COLLECTION}/Shared first.md`)), contentType: "application/json" });
    const relayDb = new DatabaseSync(relay.dbPath, { readOnly: true });
    try {
      await test.info().attach("relay-current-files", { body: JSON.stringify(relayDb.prepare("SELECT path,version_id,content_kind,state_relay_seq FROM sync_relay_current_files WHERE workspace_id=?").all(workspaceId)), contentType: "application/json" });
    } finally { relayDb.close(); }
    expect(projection.collection.objectId).not.toBe(ownerCollection.objectId);
    await expect.poll(() => page.evaluate(async input => (window as unknown as { dohcDesktop: DohcDesktopBridge }).dohcDesktop.queryCollectionRecords(input),
      { workspaceId: recipientWorkspaceId, collectionPath: COLLECTION }), { timeout: 120_000 }).toMatchObject({ records: [expect.objectContaining({ id: RECORD })] });
    expect(await page.evaluate(async input => (window as unknown as { dohcDesktop: DohcDesktopBridge }).dohcDesktop.listRecordButtons(input),
      { workspaceId: recipientWorkspaceId, path: `${COLLECTION}/Shared first.md` })).toMatchObject({ record: { id: RECORD }, collectionPath: COLLECTION });
    expect((await buttons(page, recipientWorkspaceId)).buttons.map(button => button.state.kind)).toEqual(["checking", "checking"]);
    await openTable(page);
    await expect.poll(async () => (await buttons(page, recipientWorkspaceId)).buttons.map(button => button.state.kind), { timeout: 120_000 }).toEqual(["ready", "ready"]);
    const ready = await buttons(page, recipientWorkspaceId);
    expect(ready.buttons[0]?.state).toMatchObject({ kind: "ready", automationId: `collection:${ownerCollection.objectId}#finish` });
    const finish = page.getByRole("button", { name: "Finish for Shared first", exact: true });
    await expect(finish).toBeEnabled({ timeout: 120_000 });
    await finish.focus();
    await finish.press("Enter");
    await expect.poll(() => readFile(join(ownerTemp.rootPath, `${COLLECTION}/Shared first.md`), "utf8"), { timeout: 120_000 }).toContain("Status: Done");
    const history = await owner.page.evaluate(async input => (window as unknown as { dohcDesktop: DohcDesktopBridge }).dohcDesktop.getCollectionRecordHistory(input), { workspaceId, collectionPath: COLLECTION, recordId: RECORD });
    expect(history.entries).toContainEqual(expect.objectContaining({ author: expect.objectContaining({ kind: "automation", name: "Finish", person: "e2e-recipient@dohc.test" }) }));
    await openTable(owner.page);
    await owner.page.getByRole("button", { name: "Open Shared first", exact: true }).click();
    await owner.page.getByTestId("record-history-open").click();
    await expect(owner.page.getByTestId("record-history-automation")).toContainText("for e2e-recipient@dohc.test");
    for (const theme of ["light", "dark"]) {
      await owner.page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
      await owner.page.screenshot({ path: test.info().outputPath(`shared-history-${theme}.png`) });
    }
    await owner.page.getByTestId("record-history").getByRole("button", { name: "Close", exact: true }).click();
    for (const theme of ["light", "dark"]) {
      await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
      await page.emulateMedia({ reducedMotion: "reduce" });
      await page.screenshot({ path: test.info().outputPath(`shared-buttons-${theme}.png`) });
    }

    // The recipient still has the old projection. The owner's host refuses
    // this press before claiming and sends its one failure Notice.
    await owner.page.evaluate(async input => (window as unknown as { dohcDesktop: DohcDesktopBridge }).dohcDesktop.moveWorkspacePath(input),
      { workspaceId, fromPath: `${COLLECTION}/Shared first.md`, toPath: "moved.md" });
    await expect.poll(() => owner!.page.evaluate(async input => (window as unknown as { dohcDesktop: DohcDesktopBridge }).dohcDesktop.queryCollectionRecords(input),
      { workspaceId, collectionPath: COLLECTION }), { timeout: 120_000 }).toMatchObject({ records: [] });
    await page.getByRole("button", { name: "Fail for Shared first", exact: true }).click();
    await expect(page.getByRole("button", { name: "Fail for Shared first", exact: true })).toBeEnabled({ timeout: 120_000 });
    const failedAutomation = `collection:${ownerCollection.objectId}#fail`;
    await expect.poll(async () => {
      const response = await relayJson(relay!.baseUrl, RECIPIENT, "/sync/notices?limit=100");
      expect(response.status).toBe(200);
      return (JSON.parse(response.body) as { notices: Array<{ kind: string; target: { automation?: string } }> }).notices
        .filter(notice => notice.kind === "automation-failed" && notice.target.automation === failedAutomation).length;
    }, { timeout: 120_000 }).toBe(1);
    // Drive Electron's focus event deterministically on the shared QA host.
    // The recipient's real focus handler fetches its account Notices.
    await recipient.app.evaluate(({ app, BrowserWindow }) => app.emit("browser-window-focus", {}, BrowserWindow.getAllWindows()[0]!));
    await expect.poll(async () => (await page.evaluate(async () => (window as unknown as { dohcDesktop: DohcDesktopBridge }).dohcDesktop.listNotices({}))).notices.filter(notice => notice.kind === "automation-failed" && notice.target?.automation === failedAutomation).length, { timeout: 120_000 }).toBe(1);
    expect((await page.evaluate(async () => (window as unknown as { dohcDesktop: DohcDesktopBridge }).dohcDesktop.listNotices({}))).notices.filter(notice => notice.kind === "automation-failed" && notice.target?.automation === failedAutomation)).toHaveLength(1);
    expect(await readFile(join(ownerTemp.rootPath, "moved.md"), "utf8")).toContain("Status: Done");
  } finally {
    await recipient?.close();
    await owner?.close();
    await relay?.stop();
    await recipientTemp.cleanup();
    await ownerTemp.cleanup();
  }
});
