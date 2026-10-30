import { expect, test, type Page } from "@playwright/test";
import { randomBytes } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import { mintLocalhostCa } from "../../../services/share-web/src/testing/localhostCa";
import type { DohcDesktopBridge } from "../src/ipc/bridgeContract";
import { resolveEngineBinary } from "../src/testing/engineBinary";
import { assertDesktopEngineHealthy, launchDesktopApp, type LaunchedDesktopApp } from "./helpers/desktopApp";
import { readHistoryMoments } from "./helpers/history";
import { relayJson } from "./helpers/relayPeer";
import { startServerProxy, type ProxiedCollectionWriteResponse } from "./helpers/selfHostOnboarding";
import { relayAdoptedIdentity, spawnSyncRelay, type SyncRelayHandle } from "./helpers/syncRelay";
import { createTempWorkspace, openWorkspaceFromFirstRun, seedCloudCredentials,
  seedWorkspaceManifest, seedWorkspaceRegistry, showExplorerFiles, writeWorkspaceFiles } from "./helpers/workspace";

type Api = DohcDesktopBridge;
const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");
const COLLECTION = "trip/Tasks", OWNER_ID = "record-create-owner";
const OWNER_TOKEN = "test:e2e-granter", RECIPIENT_TOKEN = "test:e2e-recipient";
const OWNER_EMAIL = "e2e-granter@dohc.test", RECIPIENT_EMAIL = "e2e-recipient@dohc.test";
const SCHEMA = "name: Tasks\nfields:\n  Task:\n    type: text\n  Status:\n    type: text\n";
type Op = { originId: string; opKind: string; payload: Record<string, unknown> };
async function log(relay: SyncRelayHandle): Promise<Op[]> {
  const query = new URLSearchParams({ since: "0", limit: "1000", ...(relayAdoptedIdentity(relay.dbPath, OWNER_ID) ?? {}) });
  const result = await relayJson(relay.baseUrl, OWNER_TOKEN, `/sync/${OWNER_ID}/log?${query}`);
  expect(result.status, result.body).toBe(200);
  return (JSON.parse(result.body) as { ops: Op[] }).ops;
}
async function openCollection(page: Page) {
  await showExplorerFiles(page);
  for (const path of ["trip", COLLECTION]) {
    const row = page.locator(`[data-testid="tree-row"][data-path="${path}"]`);
    await expect(row).toBeVisible({ timeout: 120_000 });
    if (path === COLLECTION) await expect(row).toHaveAttribute("data-collection", "true", { timeout: 120_000 });
    if (path === COLLECTION || await row.getAttribute("aria-expanded") !== "true") await row.click({ timeout: 120_000 });
  }
  await expect(page.getByTestId("collection-new-record")).toBeVisible({ timeout: 120_000 });
}
async function records(page: Page) {
  return page.evaluate(async collectionPath => {
    const api = (window as unknown as { dohcDesktop: Api }).dohcDesktop;
    const workspaceId = (await api.getWorkspaceRegistry()).workspaces[0]!.workspaceId;
    return (await api.queryCollectionRecords({ workspaceId, collectionPath, limit: 100 })).records;
  }, COLLECTION);
}
const creationOps = (ops: Op[]) => ops.filter(op => op.originId.startsWith("relay:collection-file:") && op.opKind === "moment.append");
function acceptedLiveEdits(relay: SyncRelayHandle, path: string) {
  const db = new DatabaseSync(relay.dbPath, { readOnly: true });
  try {
    return db.prepare(`SELECT author_context_json AS context, author_snapshot_json AS authors FROM sync_relay_live_update_journal
      WHERE workspace_id=? AND current_path=? AND principal_kind='named' AND principal_id='e2e-recipient'
        AND accepted_event_count>0 ORDER BY journal_cursor`).all(OWNER_ID, path).map(row => ({
      context: row.context === null ? null : JSON.parse(String(row.context)),
      authors: row.authors === null ? null : JSON.parse(String(row.authors)),
    }));
  } finally { db.close(); }
}
async function ownerRecordHistory(page: Page, path: string) {
  const moments = await readHistoryMoments(page, OWNER_ID, path);
  if (moments === null) throw new Error("Owner History is unavailable.");
  return page.evaluate(async ({ workspaceId, moments }) => {
    const api = (window as unknown as { dohcDesktop: Api }).dohcDesktop;
    const details = await Promise.all(moments
      .map(moment => api.readEngineMoment({ workspaceId, momentId: moment.id })));
    return details.flatMap(result => result.moment === null ? [] : [result.moment]);
  }, { workspaceId: OWNER_ID, moments });
}
// Stop and restore removes a recipient's record only when every version that
// changed it names the relay-confirmed recipient.
async function expectOnlyRecipientChanged(page: Page, path: string) {
  await expect(async () => {
    const changes = (await ownerRecordHistory(page, path)).filter(moment => moment.beforeText !== moment.afterText);
    expect(changes.some(moment => moment.afterText?.includes("Status: Ready"))).toBe(true);
    expect(changes.filter(moment => !moment.authors?.length || !moment.authors.every(author => author.kind === "named"
      ? author.userId === "e2e-recipient"
      : author.kind === "human" && author.humanId === "e2e-recipient" && "relayConfirmed" in author && author.relayConfirmed === true))).toEqual([]);
  }).toPass({ timeout: 120_000 });
}

async function withSharedCollection(
  response: (response: ProxiedCollectionWriteResponse) => "drop" | void | Promise<"drop" | void>,
  run: (fixture: {
    owner: LaunchedDesktopApp;
    recipient(): LaunchedDesktopApp;
    restartRecipient(): Promise<LaunchedDesktopApp>;
    stopOwner(): Promise<void>;
    restartOwner(): Promise<LaunchedDesktopApp>;
    relay: SyncRelayHandle;
    ownerText(path: string): Promise<string>;
    ownerLiveState(path: string): Record<string, unknown>;
  }) => Promise<void>,
  ownerEnv: Record<string, string> = {},
) {
  const ownerTemp = await createTempWorkspace(), recipientTemp = await createTempWorkspace();
  let relay: SyncRelayHandle | undefined;
  let proxy: Awaited<ReturnType<typeof startServerProxy>> | undefined;
  let owner: LaunchedDesktopApp | undefined, recipient: LaunchedDesktopApp | undefined;
  const launches: LaunchedDesktopApp[] = [];
  let nudge = 0;
  let primaryFailure: unknown;
  try {
    const ca = await mintLocalhostCa(ownerTemp.baseDir);
    const env = { NODE_EXTRA_CA_CERTS: ca.caPath, DOHC_ENGINE_TEST_RELAY_CA_MODE: "1",
      DOHC_ENGINE_TEST_RELAY_CA_FILE: ca.caPath, DOHC_E2E_ALLOW_INSECURE_LOOPBACK_RELAY: "0",
      DOHC_TEST_SYNC_DEBOUNCE_MS: "150", DOHC_TEST_SYNC_BACKOFF_MS: "250" };
    proxy = await startServerProxy(ca, { collectionWriteResponse: response });
    relay = await spawnSyncRelay({ dbPath: join(ownerTemp.baseDir, "relay", "relay.sqlite"),
      editLinks: { engineExecutable: resolveEngineBinary(), publicOrigin: proxy.origin, trustEnv: env },
      linkBoundary: { linkKey: randomBytes(32).toString("base64url"), relayExchangeKey: randomBytes(32).toString("base64url"),
        publicViewerOrigin: proxy.origin } });
    proxy.routeRelayTo(relay.baseUrl);
    await seedWorkspaceManifest(ownerTemp, OWNER_ID);
    await writeWorkspaceFiles(ownerTemp, [{ path: `${COLLECTION}/collection.yaml`, contents: SCHEMA }]);
    await seedWorkspaceRegistry(ownerTemp, [{ workspaceId: OWNER_ID, rootPath: ownerTemp.rootPath }]);
    await seedCloudCredentials(ownerTemp, { serverUrl: proxy.origin, relayUrl: proxy.origin,
      email: OWNER_EMAIL, userId: "e2e-granter", token: OWNER_TOKEN });
    owner = await launchDesktopApp({ workspace: ownerTemp, env: { ...env, ...ownerEnv } });
    launches.push(owner);
    await openWorkspaceFromFirstRun(owner.page, ownerTemp);
    await owner.page.evaluate(async workspaceId => {
      await (window as unknown as { dohcDesktop: Api }).dohcDesktop.cloudEnableSync({ workspaceId });
    }, OWNER_ID);
    await expect.poll(async () => (await log(relay!)).some(op => op.payload.path === `${COLLECTION}/collection.yaml`),
      { timeout: 120_000, intervals: [1000] }).toBe(true);
    const { shareId } = await owner.page.evaluate(async ({ workspaceId, recipientEmail }) =>
      (window as unknown as { dohcDesktop: Api }).dohcDesktop.createRelayShare({ workspaceId, recipientEmail, paths: ["trip"], access: "edit" }),
    { workspaceId: OWNER_ID, recipientEmail: RECIPIENT_EMAIL });
    await seedCloudCredentials(recipientTemp, { serverUrl: proxy.origin, relayUrl: proxy.origin,
      email: RECIPIENT_EMAIL, userId: "e2e-recipient", token: RECIPIENT_TOKEN });
    recipient = await launchDesktopApp({ workspace: recipientTemp, env });
    launches.push(recipient);
    await recipient.page.getByTestId("first-run-open-share").click();
    await recipient.page.getByTestId("open-share-code").fill(`dohc-share:${shareId}:${proxy.origin}`);
    await recipient.page.getByTestId("open-share-choose-folder").click();
    await recipient.page.getByTestId("open-share-start").click();
    await expect(recipient.page.getByTestId("shared-view-banner")).toBeVisible({ timeout: 120_000 });
    await openCollection(recipient.page);
    await run({ get owner() { return owner!; }, recipient: () => recipient!, relay,
      stopOwner: async () => { await owner!.close(); owner = undefined; },
      restartOwner: async () => {
        owner = await launchDesktopApp({workspace: ownerTemp, env: { ...env, ...ownerEnv }});
        launches.push(owner);
        return owner;
      },
      restartRecipient: async () => {
        await recipient!.close(); recipient = undefined;
        recipient = await launchDesktopApp({ workspace: recipientTemp, env });
        launches.push(recipient);
        await openCollection(recipient.page);
        return recipient;
      },
      ownerText: async path => {
        await writeFile(join(ownerTemp.rootPath, `nudge-${++nudge}.txt`), `${nudge}\n`);
        try { return await readFile(join(ownerTemp.rootPath, path), "utf8"); } catch { return "missing"; }
      },
      ownerLiveState: path => {
        const db = new DatabaseSync(join(ownerTemp.rootPath, ".dohc/engine/engine.db"), { readOnly: true });
        try {
          return {
            documents: db.prepare("SELECT * FROM ydoc_docs WHERE path=?").all(path),
            snapshots: db.prepare("SELECT * FROM snapshots WHERE path=?").all(path),
            drafts: db.prepare("SELECT * FROM owner_ydoc_outboxes WHERE current_path=?").all(path),
            moments: db.prepare("SELECT moment_id,operation,sync_record_only,payload_after_blob_sha256 FROM moments WHERE path=? ORDER BY moment_order DESC").all(path),
          };
        } finally { db.close(); }
      },
    });
    for (const app of launches) {
      expect(app.logs.filter(entry => entry.level === "pageerror")).toEqual([]);
      assertDesktopEngineHealthy(app.logs);
    }
  } catch (error) {
    primaryFailure = error;
    throw error;
  } finally {
    await test.info().attach("relay output", { contentType: "application/json", body: JSON.stringify(relay?.diagnostics() ?? {}) });
    const cleanup = await Promise.allSettled([recipient?.close(), owner?.close()]);
    cleanup.push(...await Promise.allSettled([proxy?.close(), relay?.stop()]));
    cleanup.push(...await Promise.allSettled([recipientTemp.cleanup(), ownerTemp.cleanup()]));
    const failures = cleanup.filter((result): result is PromiseRejectedResult => result.status === "rejected");
    if (failures.length) {
      await test.info().attach("cleanup failures", { contentType: "text/plain",
        body: failures.map(result => String(result.reason)).join("\n") });
      if (primaryFailure === undefined) throw new AggregateError(failures.map(result => result.reason), "Recipient record test cleanup failed.");
    }
  }
}

test("@two-client an Edit recipient's new record opens immediately, becomes editable, and Stop and restore removes it", async () => {
  test.setTimeout(420_000);
  let release: (() => void) | undefined;
  const acknowledged = new Promise<void>(resolve => { release = resolve; });
  try {
    await withSharedCollection(async result => {
      if (result.status === 200) await acknowledged;
    }, async fixture => {
      const page = fixture.recipient().page;
      await page.getByTestId("collection-new-record").click();
      // The tab must open while the relay answer is still withheld.
      await expect(page.getByTestId(`tab-${COLLECTION}/Untitled.md`)).toBeVisible({ timeout: 30_000 });
      await expect(page.getByTestId("view-markdown")).toBeVisible({ timeout: 30_000 });
      await expect.poll(async () => (await records(page)).length, { timeout: 30_000 }).toBe(1);
      const [created] = await records(page);
      expect(created!.id).toMatch(/^rec_[a-z2-7]{26}$/);
      expect(created!.creationDelivery).toBe("pending");
      release!();
      // No tab close, collection navigation, or manual retry: readiness changes this view.
      await expect(page.getByTestId("property-add")).toBeEnabled({ timeout: 120_000 });
      for (const [field, value] of [["Task", "Book the ferry"], ["Status", "Ready"]]) {
        await page.getByTestId("property-add").click();
        await page.getByTestId("property-key").last().fill(field!);
        await page.getByLabel(`Property ${field} value`, { exact: true }).fill(value!);
      }
      await expect(page.getByTestId("markdown-save-state")).toHaveAttribute("data-state", "saved-to-host", { timeout: 120_000 });
      await expect.poll(() => acceptedLiveEdits(fixture.relay, created!.path).length, { timeout: 120_000 }).toBeGreaterThan(0);
      await expect.poll(() => fixture.ownerText(created!.path), { timeout: 120_000, intervals: [1000] }).toContain("Task: Book the ferry");
      await expect.poll(() => fixture.ownerText(created!.path), { timeout: 120_000, intervals: [1000] }).toContain("Status: Ready");
      await expect.poll(async () => creationOps(await log(fixture.relay)).length, { timeout: 120_000 }).toBe(1);
      expect(creationOps(await log(fixture.relay))[0]!.payload.authors).toMatchObject([{ kind: "named", userId: "e2e-recipient" }]);
      await expect.poll(async () => (await readHistoryMoments(fixture.owner.page, OWNER_ID, created!.path))
        ?.find(moment => moment.namedAuthor)?.namedAuthor?.label ?? null, { timeout: 120_000 }).toBe(`${RECIPIENT_EMAIL} (Edit)`);
      await openCollection(fixture.owner.page);
      await expect.poll(async () => (await records(fixture.owner.page)).map(record => record.id), { timeout: 120_000 }).toEqual([created!.id]);
      await page.emulateMedia({ reducedMotion: "reduce" });
      for (const theme of ["light", "dark"]) {
        await page.evaluate(theme => document.documentElement.setAttribute("data-theme", theme), theme);
        await page.getByTestId("property-key").last().focus();
        await page.keyboard.press("Tab");
        await expect(page.getByLabel("Property Status value", { exact: true })).toBeFocused();
        await page.screenshot({ path: test.info().outputPath(`editable-${theme}.png`) });
      }
      const restarted = await fixture.restartRecipient();
      await expect.poll(async () => (await records(restarted.page)).map(record => record.id), { timeout: 120_000 }).toEqual([created!.id]);
      const liveAuthor = { kind: "human", humanId: "e2e-recipient", humanName: "e2e-recipient" };
      const liveEdits = acceptedLiveEdits(fixture.relay, created!.path);
      expect(liveEdits.length).toBeGreaterThan(0);
      for (const edit of liveEdits) {
        expect(edit.context).toEqual({ kind: "account", accountId: "e2e-recipient" });
        expect(edit.authors).toEqual([liveAuthor]);
      }
      const changedFieldHistory = async () => (await ownerRecordHistory(fixture.owner.page, created!.path))
        .filter(moment => (moment.origin === "ydoc" || moment.origin === "local-file")
          && moment.beforeText !== moment.afterText && /^(Task|Status):/mu.test(moment.afterText ?? ""));
      let liveHistory: Awaited<ReturnType<typeof changedFieldHistory>> = [];
      await expect(async () => {
        liveHistory = await changedFieldHistory();
        expect(liveHistory.length).toBeGreaterThan(0);
      }).toPass({ timeout: 120_000 });
      await test.info().attach("recipient live attribution", { contentType: "application/json",
        body: JSON.stringify({ liveEdits, liveHistory }, null, 2) });
      // History records the relay-admitted author; the relay's live-edit list above does not.
      for (const moment of liveHistory) expect(moment.authors).toEqual([{ ...liveAuthor, relayConfirmed: true }]);
      await test.info().attach("recipient-only restore state", {contentType: "application/json",
        body: JSON.stringify({live: fixture.ownerLiveState(created!.path), disk: await fixture.ownerText(created!.path)}, null, 2)});
      const restored = await fixture.owner.page.evaluate(async workspaceId =>
        (window as unknown as { dohcDesktop: Api }).dohcDesktop.stopAndRestore({ workspaceId, target: { kind: "person", userId: "e2e-recipient" } }), OWNER_ID);
      await test.info().attach("recipient-only after restore state", {contentType: "application/json", body: JSON.stringify(fixture.ownerLiveState(created!.path), null, 2)});
      expect(restored).toMatchObject({ status: "restored", restored: [{ path: created!.path, removed: true }], review: [], unfinished: null });
      await expect.poll(async () => (await records(fixture.owner.page)).length, { timeout: 120_000 }).toBe(0);
      expect(await fixture.ownerText(created!.path)).toBe("missing");
      expect(await fixture.ownerText(`${COLLECTION}/collection.yaml`)).toBe(SCHEMA);
    });
  } finally { release!(); }
});

for (const restartBeforeRestore of [false, true]) {
test(`@two-client Stop and restore keeps the owner's text ${restartBeforeRestore ? "after the owner restarts" : "with the document open"}`, async () => {
  test.setTimeout(600_000);
  await withSharedCollection(() => undefined, async fixture => {
    const recipient = fixture.recipient().page;
    const created: { id: string; path: string }[] = [];
    for (const label of ["Owner review", "Recipient only"]) {
      await openCollection(recipient);
      await recipient.getByTestId("collection-new-record").click();
      await expect(recipient.getByTestId("property-add")).toBeEnabled({ timeout: 120_000 });
      for (const [field, value] of [["Task", label], ["Status", "Ready"]]) {
        await recipient.getByTestId("property-add").click();
        await recipient.getByTestId("property-key").last().fill(field!);
        await recipient.getByLabel(`Property ${field} value`, { exact: true }).fill(value!);
      }
      await expect(recipient.getByTestId("markdown-save-state")).toHaveAttribute("data-state", "saved-to-host", { timeout: 120_000 });
      const record = (await records(recipient)).find(record => !created.some(previous => previous.id === record.id))!;
      created.push({ id: record.id, path: record.path });
      await expect.poll(() => fixture.ownerText(record.path), { timeout: 120_000, intervals: [1000] }).toContain(`Task: ${label}`);
    }
    await openCollection(fixture.owner.page);
    await expect.poll(async () => (await records(fixture.owner.page)).length, { timeout: 120_000 }).toBe(2);
    for (const record of created) await expectOnlyRecipientChanged(fixture.owner.page, record.path);
    await fixture.owner.page.getByRole("button", { name: "Open Untitled", exact: true }).click();
    const status = fixture.owner.page.getByLabel("Property Status value", { exact: true });
    await expect(status).toBeEnabled({ timeout: 120_000 });
    await status.fill("Owner text KEEP");
    await expect(status).toHaveValue("Owner text KEEP");
    await expect.poll(() => {
      const documents = fixture.ownerLiveState(created[0]!.path).documents as {head_update_seq: number; settled_update_seq: number | null}[];
      return documents.some(doc => doc.head_update_seq !== doc.settled_update_seq);
    }, {timeout: 120_000}).toBe(true);
    await expect(async () => {
      expect((await ownerRecordHistory(fixture.owner.page, created[0]!.path))
        .some(moment => moment.afterText?.includes("Owner text KEEP"))).toBe(false);
    }).toPass({ timeout: 120_000 });
    if (restartBeforeRestore) {
      await fixture.stopOwner();
      await fixture.restartOwner();
      await openCollection(fixture.owner.page);
      await expect.poll(async () => JSON.stringify(await records(fixture.owner.page)), {timeout: 120_000}).toContain("Owner text KEEP");
      await test.info().attach("owner state after restart before restore", {contentType: "application/json", body: JSON.stringify(fixture.ownerLiveState(created[0]!.path), null, 2)});
    }
    await expectOnlyRecipientChanged(fixture.owner.page, created[1]!.path);
    await test.info().attach("owner History before restore", { contentType: "application/json",
      body: JSON.stringify(await Promise.all(created.map(record => readHistoryMoments(fixture.owner.page, OWNER_ID, record.path))), null, 2) });
    // Owner settlement is held by the existing debounce seam. History still
    // attributes the file to the recipient when this destructive action runs.
    const result = await fixture.owner.page.evaluate(async workspaceId =>
      (window as unknown as { dohcDesktop: Api }).dohcDesktop.stopAndRestore({ workspaceId,
        target: { kind: "person", userId: "e2e-recipient" } }), OWNER_ID);
    expect(result).toMatchObject({ status: "restored", restored: [{ path: created[1]!.path, removed: true }],
      review: [{ path: created[0]!.path }], unfinished: null });
    expect(result.status === "restored" && result.review[0]?.reason).toMatch(/^(changed-since|restore-refused)$/);
    if (!restartBeforeRestore) await expect(status).toHaveValue("Owner text KEEP");
    expect(await fixture.ownerText(created[0]!.path)).not.toBe("missing");
    expect(await fixture.ownerText(created[1]!.path)).toBe("missing");
    await fixture.stopOwner();
    await fixture.restartOwner();
    await openCollection(fixture.owner.page);
    await expect.poll(async () => (await records(fixture.owner.page)).map(record => record.id), { timeout: 120_000 }).toEqual([created[0]!.id]);
    await fixture.owner.page.getByRole("button", { name: "Open Untitled", exact: true }).click();
    await expect(fixture.owner.page.getByLabel("Property Status value", { exact: true })).toHaveValue("Owner text KEEP", { timeout: 120_000 });
    const undo = await fixture.owner.page.evaluate(async ({ workspaceId, ids }) =>
      (window as unknown as { dohcDesktop: Api }).dohcDesktop.undoStopAndRestore({ workspaceId, restoredMomentIds: ids }),
    { workspaceId: OWNER_ID, ids: result.status === "restored" ? result.restored.map(file => file.restoredMomentId) : [] });
    expect(undo.files).toMatchObject([{ kind: "restored" }]);
    await expect.poll(() => fixture.ownerText(created[1]!.path), { timeout: 120_000 }).toContain("Recipient only");
  }, { DOHC_TEST_YDOC_SETTLE_DEBOUNCE_MS: "600000" });
});

}

test("@two-client a recipient restarts after a lost creation acknowledgement and retries the same relay submission", async () => {
  test.setTimeout(420_000);
  let drop = true;
  const responses: { request: Record<string, unknown>; receipt: Record<string, unknown>; dropped: boolean }[] = [];
  await withSharedCollection(result => {
    if (result.status !== 200) return;
    responses.push({ request: JSON.parse(result.requestBody), receipt: JSON.parse(result.body), dropped: drop });
    return drop ? "drop" : undefined;
  }, async fixture => {
    let page = fixture.recipient().page;
    await page.getByTestId("collection-new-record").click();
    await expect(page.getByTestId(`tab-${COLLECTION}/Untitled.md`)).toBeVisible({ timeout: 30_000 });
    await expect.poll(() => responses.some(response => response.dropped && response.receipt.created === true),
      { timeout: 120_000 }).toBe(true);
    const original = responses.find(response => response.receipt.created === true)!;
    const [created] = await records(page);
    expect(created).toMatchObject({ creationDelivery: "pending" });
    expect(original.request.submitId).toEqual(expect.any(String));
    await expect.poll(async () => creationOps(await log(fixture.relay)).length, { timeout: 120_000 }).toBe(1);
    await openCollection(page);
    await expect(page.getByTestId("collection-record-drafts")).toContainText("Saved on this computer. Waiting to send");
    await expect(page.getByTestId("collection-record-drafts").getByRole("button", { name: "Discard draft", exact: true })).toHaveCount(0);
    page = (await fixture.restartRecipient()).page;
    await expect.poll(async () => (await records(page)).map(record => ({ id: record.id, delivery: record.creationDelivery })),
      { timeout: 120_000 }).toEqual([{ id: created!.id, delivery: "pending" }]);
    await expect(page.getByTestId("collection-record-drafts")).toContainText("Saved on this computer. Waiting to send");
    await expect(page.getByTestId("collection-record-drafts").getByRole("button", { name: "Discard draft", exact: true })).toHaveCount(0);
    drop = false;
    await page.getByTestId("collection-record-drafts").getByRole("button", { name: "Try again", exact: true }).click();
    await expect.poll(() => responses.some(response => !response.dropped && response.receipt.created === false),
      { timeout: 120_000 }).toBe(true);
    const replay = responses.find(response => !response.dropped && response.receipt.created === false)!;
    expect(replay.request).toEqual(original.request);
    expect(replay.receipt).toEqual({ ...original.receipt, created: false });
    await expect.poll(async () => (await records(page)).map(record => ({ id: record.id, delivery: record.creationDelivery })),
      { timeout: 120_000 }).toEqual([{ id: created!.id, delivery: "accepted" }]);
    await expect(page.getByTestId("collection-record-drafts")).toHaveCount(0);
    await expect.poll(() => fixture.ownerText(created!.path), { timeout: 120_000 }).toContain(`id: ${created!.id}`);
    await openCollection(fixture.owner.page);
    await expect.poll(async () => (await records(fixture.owner.page)).map(record => record.id), { timeout: 120_000 }).toEqual([created!.id]);
    expect(creationOps(await log(fixture.relay))).toHaveLength(1);
    await test.info().attach("lost acknowledgement and relay replay", { contentType: "application/json", body: JSON.stringify(responses, null, 2) });
  });
});


test("@two-client a waiting editor becomes editable when the owner's computer returns after admission timed out", async () => {
  test.setTimeout(420_000);
  let release!: () => void;
  let creationWritten!: () => void;
  const acknowledgement = new Promise<void>(resolve => { release = resolve; });
  const written = new Promise<void>(resolve => { creationWritten = resolve; });
  try {
    await withSharedCollection(async result => {
      if (result.status === 200) { creationWritten(); await acknowledgement; }
    }, async fixture => {
      const page = fixture.recipient().page;
      await page.getByTestId("collection-new-record").click();
      await written;
      await fixture.stopOwner();
      release();
      await expect(page.getByText("dohc could not open this file for editing.", {exact: true})).toBeVisible({timeout: 120_000});
      await expect(page.getByTestId("property-add")).toHaveCount(0);
      await expect(page.locator('[contenteditable="true"]')).toHaveCount(0);
      await expect(page.getByRole("button", { name: "Edit", exact: true })).toBeDisabled();
      await fixture.restartOwner();
      // The host signal alone reopens this same tab, without file writes or a manual retry.
      await expect(page.getByTestId("property-add")).toBeEnabled({timeout: 120_000});
      await page.getByTestId("property-add").click();
      await page.getByTestId("property-key").last().fill("Task");
      await page.getByLabel("Property Task value", {exact: true}).fill("Continue after the owner returns");
      await expect(page.getByTestId("markdown-save-state")).toHaveAttribute("data-state", "saved-to-host", {timeout: 120_000});
    });
  } finally { release(); }
});
