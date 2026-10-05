import { expect, test } from "@playwright/test";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import type { DohcDesktopBridge } from "../src/ipc/bridgeContract";
import { launchDesktopApp } from "./helpers/desktopApp";
import { withEngineDb } from "./helpers/engineDb";
import { relayJson } from "./helpers/relayPeer";
import { relayAdoptedIdentity, spawnSyncRelay, type SyncRelayHandle } from "./helpers/syncRelay";
import {
  createTempWorkspace,
  openWorkspaceFromFirstRun,
  seedCloudCredentials,
  seedWorkspaceManifest,
  seedWorkspaceRegistry,
  writeWorkspaceFiles,
} from "./helpers/workspace";

const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");
const COLLECTION = "trip/Tasks";
const RECORD_ID = "rec_aaaaaaaaaaaaaaaaaaaaaaaaaa";
const RECORD_PATH = `${COLLECTION}/first.md`;
const RECORD_TEXT = `---\nid: ${RECORD_ID}\nTitle: Shared first\nStatus: Open\n---\n`;
const RECORD_SHA = createHash("sha256").update(RECORD_TEXT).digest("hex");
const OWNER = "test:e2e-granter";
type ApiWindow = { dohcDesktop: DohcDesktopBridge };
type LogOp = { opKind: string; payload: { path?: string; momentId?: string; isBaseState?: boolean } };

async function recordOps(relay: SyncRelayHandle, workspaceId: string): Promise<LogOp[]> {
  const identity = relayAdoptedIdentity(relay.dbPath, workspaceId);
  const query = new URLSearchParams({ since: "0", limit: "1000", ...(identity ?? {}) });
  const log = await relayJson(relay.baseUrl, OWNER, `/sync/${workspaceId}/log?${query}`);
  if (log.status !== 200) return [];
  return (JSON.parse(log.body) as { ops: LogOp[] }).ops.filter(op => op.payload.path === RECORD_PATH);
}

test("@two-client an adopted seeded record reaches an Edit recipient with its original bytes and id", async () => {
  test.setTimeout(420_000);
  const ownerTemp = await createTempWorkspace();
  const recipientTemp = await createTempWorkspace();
  const workspaceId = "seeded-record-owner";
  let relay: SyncRelayHandle | null = null;
  let owner: Awaited<ReturnType<typeof launchDesktopApp>> | null = null;
  let recipient: Awaited<ReturnType<typeof launchDesktopApp>> | null = null;
  try {
    relay = await spawnSyncRelay({ dbPath: join(ownerTemp.baseDir, "relay.sqlite") });
    await seedWorkspaceManifest(ownerTemp, workspaceId);
    await seedWorkspaceRegistry(ownerTemp, [{ workspaceId, rootPath: ownerTemp.rootPath }]);
    await seedCloudCredentials(ownerTemp, {
      serverUrl: relay.baseUrl, relayUrl: relay.baseUrl,
      email: "e2e-granter@dohc.test", userId: "e2e-granter", token: OWNER,
    });
    await writeWorkspaceFiles(ownerTemp, [
      { path: `${COLLECTION}/collection.yaml`, contents: "name: Tasks\nfields:\n  Title: {type: text}\n  Status: {type: text}\n" },
      { path: RECORD_PATH, contents: RECORD_TEXT },
    ]);
    owner = await launchDesktopApp({ workspace: ownerTemp });
    await openWorkspaceFromFirstRun(owner.page, ownerTemp);
    await expect.poll(() => owner!.page.evaluate(async input =>
      (window as unknown as ApiWindow).dohcDesktop.queryCollectionRecords(input),
    { workspaceId, collectionPath: COLLECTION }), { timeout: 120_000 })
      .toMatchObject({ records: [expect.objectContaining({ id: RECORD_ID })] });
    await expect.poll(() => Boolean(withEngineDb(ownerTemp.rootPath, db => db.prepare(
      `SELECT s.latest_moment_id AS momentId FROM snapshots s JOIN ydoc_docs d
       ON d.workspace_id=s.workspace_id AND d.version_id=s.version_id AND d.object_id=s.object_id
       WHERE s.path=? AND s.blob_sha256=? AND d.head_update_seq>0
         AND d.settled_update_seq=d.head_update_seq
         AND COALESCE(d.last_settled_sha,d.seed_source_sha256)=s.blob_sha256`,
    ).get(RECORD_PATH, RECORD_SHA))),
    { timeout: 120_000 }).toBe(true);
    const adoptedMoment = withEngineDb(ownerTemp.rootPath, db => db.prepare(
      "SELECT latest_moment_id AS momentId FROM snapshots WHERE path=?",
    ).get(RECORD_PATH));
    expect(adoptedMoment).toBeTruthy();
    expect(withEngineDb(ownerTemp.rootPath, db => db.prepare(
      "SELECT COUNT(*) AS n FROM replication_log WHERE op_kind='moment.append' AND json_extract(payload_json,'$.path')=?",
    ).get(RECORD_PATH))).toEqual({ n: 0 });

    await owner.page.evaluate(async workspaceId =>
      (window as unknown as ApiWindow).dohcDesktop.cloudEnableSync({ workspaceId }), workspaceId);
    await expect.poll(async () => (await recordOps(relay!, workspaceId))
      .filter(op => op.opKind === "moment.append").length, { timeout: 120_000 }).toBe(1);
    const ops = await recordOps(relay, workspaceId);
    expect(ops).toContainEqual(expect.objectContaining({ opKind: "ydoc.update", payload: expect.objectContaining({ isBaseState: true }) }));
    expect(ops.find(op => op.opKind === "moment.append")?.payload.momentId).toBe(adoptedMoment?.momentId);
    const relayDb = new DatabaseSync(relay.dbPath, { readOnly: true });
    try {
      expect(relayDb.prepare(
        "SELECT blob_sha256 AS sha,content_kind AS kind FROM sync_relay_current_files WHERE workspace_id=? AND version_id='main' AND path=?",
      ).get(workspaceId, RECORD_PATH)).toEqual({ sha: RECORD_SHA, kind: "text" });
    } finally { relayDb.close(); }
    const shared = await owner.page.evaluate(async workspaceId =>
      (window as unknown as ApiWindow).dohcDesktop.createRelayShare({ workspaceId,
        paths: ["trip"], recipientEmail: "e2e-recipient@dohc.test", access: "edit" }), workspaceId);
    await seedCloudCredentials(recipientTemp, {
      serverUrl: relay.baseUrl, relayUrl: relay.baseUrl,
      email: "e2e-recipient@dohc.test", userId: "e2e-recipient", token: "test:e2e-recipient",
    });
    recipient = await launchDesktopApp({ workspace: recipientTemp });
    const page = recipient.page;
    await page.getByTestId("first-run-open-share").click();
    await page.getByTestId("open-share-code").fill(`dohc-share:${shared.shareId}:${relay.baseUrl}`);
    await page.getByTestId("open-share-choose-folder").click();
    await page.getByTestId("open-share-start").click();
    await expect(page.getByTestId("shared-view-banner")).toBeVisible({ timeout: 120_000 });
    const recipientWorkspaceId = await page.evaluate(async () =>
      (await (window as unknown as ApiWindow).dohcDesktop.getWorkspaceRegistry()).workspaces[0]!.workspaceId);
    await expect.poll(() => page.evaluate(async input => {
      try { return (await (window as unknown as ApiWindow).dohcDesktop.readWorkspaceText(input)).text; }
      catch (error) { return String(error); }
    }, { workspaceId: recipientWorkspaceId, relativePath: RECORD_PATH }), { timeout: 120_000 }).toBe(RECORD_TEXT);
    await expect.poll(() => page.evaluate(async input =>
      (window as unknown as ApiWindow).dohcDesktop.queryCollectionRecords(input),
    { workspaceId: recipientWorkspaceId, collectionPath: COLLECTION }), { timeout: 120_000 })
      .toMatchObject({ records: [expect.objectContaining({ id: RECORD_ID })] });
    expect(await readFile(join(ownerTemp.rootPath, RECORD_PATH), "utf8")).toBe(RECORD_TEXT);
    expect((await recordOps(relay, workspaceId)).filter(op => op.opKind === "moment.append")).toHaveLength(1);
  } finally {
    await recipient?.close();
    await owner?.close();
    await relay?.stop();
    await recipientTemp.cleanup();
    await ownerTemp.cleanup();
  }
});
