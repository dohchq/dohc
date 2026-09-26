import { expect, test, type Page } from "@playwright/test";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { DohcDesktopBridge } from "../src/ipc/bridgeContract";
import { launchDesktopApp } from "./helpers/desktopApp";
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

// The direct lane (ADR 0013), two real desktops over one relay. The owner
// shares a folder holding a Collection with Edit. The recipient changes the
// Collection's schema and automations from their share view, and the relay
// writes both straight into the owner's workspace. The owner's History names
// the recipient. A write based on a version the owner has since changed is
// refused as stale, and its notice sends it as a proposal. Stop and restore
// ends the recipient's access and puts the schema back, and a write after
// that is refused.
//
// Both desktops run at once. The harness is serial per spec, so the two
// instances share one display; nothing here depends on focus.

const OWNER_TOKEN = "test:e2e-granter";
const OWNER_USER = "e2e-granter";
const OWNER_EMAIL = "e2e-granter@dohc.test";
const RECIPIENT_TOKEN = "test:e2e-recipient";
const RECIPIENT_USER = "e2e-recipient";
const RECIPIENT_EMAIL = "e2e-recipient@dohc.test";

const SCHEMA_PATH = "trip/packing/collection.yaml";
const AUTOMATIONS_PATH = "trip/packing/automations.yaml";
const SCHEMA = "name: Packing\nfields:\n  Title:\n    type: text\n";
const SCHEMA_TWO = "name: Packing\nfields:\n  Title:\n    type: text\n  Count:\n    type: number\n";
const SCHEMA_AFTER_STOP = "name: Packing\nfields:\n  Title:\n    type: text\n  Notes:\n    type: text\n";
const automation = (id: string, title: string) =>
  `  - id: ${id}\n    name: ${id}\n    when: record-added\n    do:\n      - set:\n          Title: ${title}\n`;
const automations = (...items: string[]) => `version: 1\nautomations:\n${items.join("")}`;
const AUTOMATIONS = automations(automation("stamp", "Packed"));
const AUTOMATIONS_THEIRS = automations(automation("stamp", "Packed"), automation("tidy", "Tidied"));
const AUTOMATIONS_OWNER = automations(automation("stamp", "Packed by me"), automation("tidy", "Tidied"));
const AUTOMATIONS_LATE = automations(automation("stamp", "Packed"), automation("tidy", "Tidied twice"));

type LogOp = { originId: string; opKind: string; payload: Record<string, unknown> };
type Api = DohcDesktopBridge;

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

async function ownerLog(relay: SyncRelayHandle, workspaceId: string): Promise<LogOp[]> {
  // Once the owner's engine pushes, the relay answers only reads that carry
  // the identity it adopted.
  const identity = relayAdoptedIdentity(relay.dbPath, workspaceId);
  const query = new URLSearchParams({ since: "0", limit: "1000", ...(identity ?? {}) });
  const read = await relayJson(relay.baseUrl, OWNER_TOKEN, `/sync/${workspaceId}/log?${query.toString()}`);
  expect(read.status, read.body).toBe(200);
  return (JSON.parse(read.body) as { ops: LogOp[] }).ops;
}

/** The paths the relay wrote into the owner's workspace for the recipient. */
async function directPaths(relay: SyncRelayHandle, workspaceId: string): Promise<string[]> {
  return (await ownerLog(relay, workspaceId))
    .filter((op) => op.originId.startsWith("relay:collection-file:") && op.opKind === "moment.append")
    .map((op) => String(op.payload.path));
}

/** Writes a file in the page's only workspace the way an editor save does. */
async function saveText(page: Page, path: string, text: string): Promise<string> {
  return await page.evaluate(async ({ path, text }) => {
    const api = (window as unknown as { dohcDesktop: Api }).dohcDesktop;
    const workspaceId = (await api.getWorkspaceRegistry()).workspaces[0]!.workspaceId;
    try {
      const read = await api.readWorkspaceText({ workspaceId, relativePath: path });
      if (read.truncated) return "the file read back truncated";
      await api.writeWorkspaceText({ workspaceId, relativePath: path, text, expectedContentHash: read.contentHash });
      return "written";
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  }, { path, text });
}

test("@two-client a recipient with Edit changes a Collection directly, and the owner sees it, races it, and stops it", async () => {
  test.setTimeout(420_000);
  const ownerTemp = await createTempWorkspace();
  const recipientTemp = await createTempWorkspace();
  const ownerWorkspaceId = "direct-lane-owner";
  let relay: SyncRelayHandle | null = null;
  let owner: Awaited<ReturnType<typeof launchDesktopApp>> | null = null;
  let recipient: Awaited<ReturnType<typeof launchDesktopApp>> | null = null;
  const syncEnv = { DOHC_TEST_SYNC_DEBOUNCE_MS: "150", DOHC_TEST_SYNC_BACKOFF_MS: "250" };
  let nudge = 0;
  // An idle owner pulls on its own sync cadence; a throwaway write wakes it.
  const wakeOwner = async () => {
    nudge += 1;
    await writeFile(join(ownerTemp.rootPath, `sync-nudge-${nudge}.md`), `nudge ${nudge}\n`);
  };

  try {
    relay = await spawnSyncRelay({ dbPath: join(ownerTemp.baseDir, "relay.sqlite") });

    // --- The owner's synced workspace holds a Collection -----------------
    await seedWorkspaceManifest(ownerTemp, ownerWorkspaceId);
    await writeWorkspaceFiles(ownerTemp, [
      { path: SCHEMA_PATH, contents: SCHEMA },
      { path: AUTOMATIONS_PATH, contents: AUTOMATIONS },
      { path: "private/ledger.md", contents: "The kraken ledger stays private.\n" },
    ]);
    await seedWorkspaceRegistry(ownerTemp, [{ workspaceId: ownerWorkspaceId, rootPath: ownerTemp.rootPath }]);
    await seedCloudCredentials(ownerTemp, {
      serverUrl: relay.baseUrl, relayUrl: relay.baseUrl, email: OWNER_EMAIL, userId: OWNER_USER, token: OWNER_TOKEN,
    });
    owner = await launchDesktopApp({ workspace: ownerTemp, env: syncEnv });
    await openWorkspaceFromFirstRun(owner.page, ownerTemp);
    // Turning sync on claims the workspace and enrols its existing files.
    const enabled = await owner.page.evaluate(async (workspaceId) => {
      const api = (window as unknown as { dohcDesktop: Api }).dohcDesktop;
      try {
        await api.cloudEnableSync({ workspaceId });
        return "enabled";
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      }
    }, ownerWorkspaceId);
    expect(enabled).toBe("enabled");
    await expect
      .poll(async () => (await ownerLog(relay!, ownerWorkspaceId)).some((op) => op.payload.path === AUTOMATIONS_PATH),
        { timeout: 60_000, intervals: [1_000] })
      .toBe(true);

    // --- The owner shares the trip folder with Edit ------------------------
    // Sharing from the owner's app refreshes the roster History names people from.
    const { shareId } = await owner.page.evaluate(async ({ workspaceId, recipientEmail }) => {
      const api = (window as unknown as { dohcDesktop: Api }).dohcDesktop;
      return await api.createRelayShare({ workspaceId, recipientEmail, paths: ["trip"], access: "edit" });
    }, { workspaceId: ownerWorkspaceId, recipientEmail: RECIPIENT_EMAIL });

    // --- The recipient opens the share and changes the Collection ---------
    await seedCloudCredentials(recipientTemp, {
      serverUrl: relay.baseUrl, relayUrl: relay.baseUrl, email: RECIPIENT_EMAIL, userId: RECIPIENT_USER, token: RECIPIENT_TOKEN,
    });
    recipient = await launchDesktopApp({ workspace: recipientTemp, env: syncEnv });
    const page = recipient.page;
    await page.getByTestId("first-run-open-share").click();
    await page.getByTestId("open-share-code").fill(`dohc-share:${shareId}:${relay.baseUrl}`);
    await page.getByTestId("open-share-choose-folder").click();
    await page.getByTestId("open-share-start").click();
    await expect(page.getByTestId("shared-view-banner")).toBeVisible();

    // A save pushes a Collection's own files on its own: no Send changes.
    await expect.poll(() => saveText(page, SCHEMA_PATH, SCHEMA_TWO), { timeout: 60_000, intervals: [1_000] }).toBe("written");
    await expect.poll(() => saveText(page, AUTOMATIONS_PATH, AUTOMATIONS_THEIRS), { timeout: 60_000, intervals: [1_000] }).toBe("written");
    await expect
      .poll(async () => (await directPaths(relay!, ownerWorkspaceId)).sort(), { timeout: 60_000, intervals: [1_000] })
      .toEqual([AUTOMATIONS_PATH, SCHEMA_PATH]);
    const direct = (await ownerLog(relay, ownerWorkspaceId)).filter((op) => op.originId.startsWith("relay:collection-file:"));
    expect(direct.every((op) => (op.payload.author as { kind: string; userId: string }).userId === RECIPIENT_USER)).toBe(true);
    // Nothing waited for the owner's review.
    const proposals = await relayJson(relay.baseUrl, OWNER_TOKEN, `/sync/${ownerWorkspaceId}/proposals`);
    expect((JSON.parse(proposals.body) as { proposals: unknown[] }).proposals).toEqual([]);

    // --- The owner's disk and History have it, named for the recipient ----
    await expect
      .poll(async () => {
        await wakeOwner();
        return await readFile(join(ownerTemp.rootPath, SCHEMA_PATH), "utf8");
      }, { timeout: 120_000, intervals: [2_000] })
      .toBe(SCHEMA_TWO);
    await expect
      .poll(async () => await owner!.page.evaluate(async ({ workspaceId, path }) => {
        const api = (window as unknown as { dohcDesktop: Api }).dohcDesktop;
        const page = await api.listEngineMoments({ workspaceId, limit: 100 });
        if (!("moments" in page)) return null;
        return page.moments.find((moment) => moment.path === path && moment.namedAuthor)?.namedAuthor?.label ?? null;
      }, { workspaceId: ownerWorkspaceId, path: SCHEMA_PATH }), { timeout: 60_000, intervals: [2_000] })
      .toBe(`${RECIPIENT_EMAIL} (Edit)`);

    // --- A race: the owner changes the automations first -----------------
    await writeWorkspaceFiles(ownerTemp, [{ path: AUTOMATIONS_PATH, contents: AUTOMATIONS_OWNER }]);
    await expect
      .poll(async () => (await ownerLog(relay!, ownerWorkspaceId)).some((op) =>
        !op.originId.startsWith("relay:") && op.payload.payloadAfterBlobSha256 === sha256(AUTOMATIONS_OWNER)),
        { timeout: 60_000, intervals: [1_000] })
      .toBe(true);
    // The recipient's share view has not pulled it, so their save builds on
    // the version the owner replaced.
    expect(await saveText(page, AUTOMATIONS_PATH, AUTOMATIONS_LATE)).toBe("written");
    const stale = page.getByTestId("workspace-shell-error").filter({ hasText: "changed before your change reached" });
    await expect(stale).toBeVisible({ timeout: 60_000 });
    expect(await directPaths(relay, ownerWorkspaceId)).toHaveLength(2);
    // The notice sends it as a proposal instead.
    await stale.getByTestId("workspace-shell-error-action").click();
    await expect
      .poll(async () => {
        const listed = await relayJson(relay!.baseUrl, OWNER_TOKEN, `/sync/${ownerWorkspaceId}/proposals`);
        const open = (JSON.parse(listed.body) as { proposals: Array<{ proposalId: string }> }).proposals;
        if (open.length !== 1) return open.length;
        const opened = await relayJson(relay!.baseUrl, OWNER_TOKEN, `/sync/${ownerWorkspaceId}/proposals/${open[0]!.proposalId}`);
        return (JSON.parse(opened.body) as { proposal: { ops: Array<{ afterPath: string }> } }).proposal.ops.map((op) => op.afterPath);
      }, { timeout: 60_000, intervals: [1_000] })
      .toEqual([AUTOMATIONS_PATH]);

    // --- Stop and restore ---------------------------------------------------
    const grants = await relayJson(relay.baseUrl, OWNER_TOKEN, "/sync/shares");
    const grantId = (JSON.parse(grants.body) as { granted: Array<{ shareId: string; grantId: string }> })
      .granted.find((row) => row.shareId === shareId)!.grantId;
    let outcome: Awaited<ReturnType<Api["stopAndRestorePerson"]>> | null = null;
    await expect
      .poll(async () => {
        await wakeOwner();
        outcome = await owner!.page.evaluate(async ({ workspaceId, userId }) => {
          const api = (window as unknown as { dohcDesktop: Api }).dohcDesktop;
          return await api.stopAndRestorePerson({ workspaceId, userId });
        }, { workspaceId: ownerWorkspaceId, userId: RECIPIENT_USER });
        return outcome.status;
      }, { timeout: 120_000, intervals: [2_000] })
      .toBe("restored");
    // The schema goes back; the automations the owner changed since stay,
    // listed for the owner to check.
    expect(outcome).toMatchObject({
      restored: [{ path: SCHEMA_PATH }],
      review: [{ path: AUTOMATIONS_PATH, reason: "changed-since" }],
      errorMessage: null,
    });
    expect(await readFile(join(ownerTemp.rootPath, SCHEMA_PATH), "utf8")).toBe(SCHEMA);
    expect(await readFile(join(ownerTemp.rootPath, AUTOMATIONS_PATH), "utf8")).toBe(AUTOMATIONS_OWNER);
    const ledger = await relayJson(relay.baseUrl, OWNER_TOKEN, `/sync/${ownerWorkspaceId}/collection-writes/${grantId}`);
    expect((JSON.parse(ledger.body) as { writes: unknown[] }).writes).toHaveLength(2);

    // --- A write after the stop is refused ---------------------------------
    await saveText(page, SCHEMA_PATH, SCHEMA_AFTER_STOP);
    // The save pushes on its own. The relay's answer makes the view refresh,
    // and the refresh finds the share ended.
    await expect(page.getByTestId("shared-view-banner")).toContainText("This share was ended", { timeout: 60_000 });
    const refused = await relayJson(relay.baseUrl, RECIPIENT_TOKEN, `/sync/shares/${shareId}/collection-writes`, {
      method: "POST",
      body: JSON.stringify({
        submitId: "after-stop",
        changes: [{
          basedOnPath: SCHEMA_PATH, basedOnBlobSha256: sha256(SCHEMA), operation: "write", afterPath: SCHEMA_PATH,
          afterBlobSha256: sha256(SCHEMA_AFTER_STOP), afterContentKind: "text",
          afterByteLength: Buffer.byteLength(SCHEMA_AFTER_STOP), recordedAtMs: Date.now(),
        }],
      }),
    });
    expect(refused.status).toBe(404);
    const after = await relayJson(relay.baseUrl, OWNER_TOKEN, `/sync/${ownerWorkspaceId}/collection-writes/${grantId}`);
    expect((JSON.parse(after.body) as { writes: unknown[] }).writes).toHaveLength(2);
    expect(await directPaths(relay, ownerWorkspaceId)).toHaveLength(2);
  } finally {
    try { await recipient?.close(); } catch (error) { console.error("Recipient cleanup failed:", error); }
    try { await owner?.close(); } catch (error) { console.error("Owner cleanup failed:", error); }
    try { await relay?.stop(); } catch (error) { console.error("Relay cleanup failed:", error); }
    try { await recipientTemp.cleanup(); } catch (error) { console.error("Recipient workspace cleanup failed:", error); }
    try { await ownerTemp.cleanup(); } catch (error) { console.error("Owner workspace cleanup failed:", error); }
  }
});
