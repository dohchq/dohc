import { expect, test } from "@playwright/test";
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { mintLocalhostCa } from "../../../services/share-web/src/testing/localhostCa";
import type { DohcDesktopBridge } from "../src/ipc/bridgeContract";
import { resolveEngineBinary } from "../src/testing/engineBinary";
import { launchDesktopApp } from "./helpers/desktopApp";
import { relayJson } from "./helpers/relayPeer";
import { startServerProxy } from "./helpers/selfHostOnboarding";
import { sharedDatasetViewerOrigin, startSharedDatasetBrowser } from "./helpers/sharedDatasetBrowser";
import { relayAdoptedIdentity, spawnSyncRelay, type SyncRelayHandle } from "./helpers/syncRelay";
import {
  createTempWorkspace,
  explorerRow,
  openWorkspaceFromFirstRun,
  seedCloudCredentials,
  seedWorkspaceManifest,
  seedWorkspaceRegistry,
  waitForWorkspaceFile,
  writeWorkspaceFiles,
} from "./helpers/workspace";

// A link holder opens an Edit share link in a browser and types into a live
// document. The owner's Markdown file on disk gets the exact bytes the
// engine's Markdown projection settles, with a real owner desktop, relay,
// live host, share-web, and browser.

type Api = DohcDesktopBridge;
const WORKSPACE_ID = "share-link-edit-owner";
const OWNER = "e2e-share-link-edit-owner";
const TOKEN = `test:${OWNER}`;
const PATH = "plain.md";
const PARAGRAPH = "An ordinary paragraph.";
const CONTENTS = `# Plain\n\n${PARAGRAPH}\n`;

test("@link-lane a link holder's edit through an Edit share link reaches the owner's file with the exact bytes", async () => {
  test.setTimeout(480_000);
  const temp = await createTempWorkspace();
  const exchangeKey = randomBytes(32).toString("base64url");
  let relay: SyncRelayHandle | undefined;
  let proxy: Awaited<ReturnType<typeof startServerProxy>> | undefined;
  let owner: Awaited<ReturnType<typeof launchDesktopApp>> | undefined;
  let shared: Awaited<ReturnType<typeof startSharedDatasetBrowser>> | undefined;
  let primaryFailure: unknown;
  try {
    // Edit links are released on a relay deployed the self-hosted way.
    const ca = await mintLocalhostCa(temp.baseDir);
    const env = { NODE_EXTRA_CA_CERTS: ca.caPath, DOHC_ENGINE_TEST_RELAY_CA_MODE: "1",
      DOHC_ENGINE_TEST_RELAY_CA_FILE: ca.caPath, DOHC_E2E_ALLOW_INSECURE_LOOPBACK_RELAY: "0",
      DOHC_TEST_SYNC_DEBOUNCE_MS: "150", DOHC_TEST_SYNC_BACKOFF_MS: "250" };
    proxy = await startServerProxy(ca);
    relay = await spawnSyncRelay({ dbPath: join(temp.baseDir, "relay", "relay.sqlite"),
      editLinks: { engineExecutable: resolveEngineBinary(), publicOrigin: proxy.origin, trustEnv: env },
      linkBoundary: { linkKey: randomBytes(32).toString("base64url"), relayExchangeKey: exchangeKey,
        publicViewerOrigin: sharedDatasetViewerOrigin } });
    proxy.routeRelayTo(relay.baseUrl);

    // --- The owner syncs the workspace and opens the note -------------------
    await seedWorkspaceManifest(temp, WORKSPACE_ID);
    await writeWorkspaceFiles(temp, [{ path: PATH, contents: CONTENTS }]);
    await seedWorkspaceRegistry(temp, [{ workspaceId: WORKSPACE_ID, rootPath: temp.rootPath }]);
    await seedCloudCredentials(temp, { serverUrl: proxy.origin, relayUrl: proxy.origin,
      userId: OWNER, email: `${OWNER}@dohc.test`, token: TOKEN });
    owner = await launchDesktopApp({ workspace: temp, env });
    const page = owner.page;
    await openWorkspaceFromFirstRun(page, temp);
    await waitForWorkspaceFile(page, WORKSPACE_ID, PATH);
    await page.evaluate(async workspaceId => {
      await (window as unknown as { dohcDesktop: Api }).dohcDesktop.cloudEnableSync({ workspaceId });
    }, WORKSPACE_ID);
    await expect.poll(async () => {
      const identity = relayAdoptedIdentity(relay!.dbPath, WORKSPACE_ID);
      if (!identity) return false;
      const query = new URLSearchParams({ since: "0", limit: "1000", ...identity });
      const result = await relayJson(relay!.baseUrl, TOKEN, `/sync/${WORKSPACE_ID}/log?${query}`);
      expect(result.status, result.body).toBe(200);
      const ops = (JSON.parse(result.body) as { ops: Array<{ payload: { path?: string } }> }).ops;
      return ops.some(op => op.payload.path === PATH);
    }, { timeout: 120_000, intervals: [1000] }).toBe(true);
    await explorerRow(page, PATH).click({ timeout: 15_000 });
    await expect(page.getByTestId("markdown-editor")).toHaveAttribute("contenteditable", "true", { timeout: 30_000 });

    // --- The owner makes an Edit link, and the live host serves the note ----
    const created = await relayJson(relay.baseUrl, TOKEN, `/sync/${WORKSPACE_ID}/shares/links`, {
      method: "POST", body: JSON.stringify({ paths: [PATH], access: "edit" }),
    });
    expect(created.status, created.body).toBe(200);
    const link = JSON.parse(created.body) as { url: string };
    await expect.poll(async () => {
      const listed = await page.evaluate(workspaceId =>
        (window as unknown as { dohcDesktop: Api }).dohcDesktop.listOwnerLiveDocuments({ workspaceId }), WORKSPACE_ID);
      return listed.documents.some(document => document.path === PATH && document.status === "ready");
    }, { timeout: 180_000, intervals: [1000] }).toBe(true);

    // --- A link holder types into the note in a browser ---------------------
    shared = await startSharedDatasetBrowser({ relayUrl: relay.baseUrl, exchangeKey, editLinks: true });
    const browserPage = await shared.browser.newPage();
    browserPage.on("pageerror", error => shared!.failures.push(error.message));
    await browserPage.goto(`${sharedDatasetViewerOrigin}/s${new URL(link.url).hash}`);
    await browserPage.getByRole("button", { name: PATH, exact: true }).click({ timeout: 15_000 });
    await browserPage.getByRole("button", { name: "Edit file", exact: true }).click({ timeout: 15_000 });
    const editor = browserPage.getByRole("textbox", { name: "Shared file editor", exact: true });
    await expect(editor).toHaveAttribute("contenteditable", "true", { timeout: 120_000 });
    await expect(editor).toBeEditable({ timeout: 15_000 });
    const marker = ` browser-${randomBytes(8).toString("hex")}`;
    await editor.getByText(PARAGRAPH, { exact: true }).click({ timeout: 15_000 });
    await browserPage.keyboard.press("End");
    await browserPage.keyboard.insertText(marker);

    // --- The owner's file gets the projection's bytes -----------------------
    // The Markdown projection trims trailing whitespace at the end of the
    // document, so the settled file has no final newline.
    const expected = Buffer.from(CONTENTS.replace(PARAGRAPH, `${PARAGRAPH}${marker}`).trimEnd(), "utf8");
    await expect.poll(async () => (await readFile(join(temp.rootPath, PATH), "utf8")).includes(marker),
      { timeout: 120_000, intervals: [1000] }).toBe(true);
    expect(await readFile(join(temp.rootPath, PATH))).toEqual(expected);

    expect(shared.failures).toEqual([]);
    expect(owner.logs.filter(entry => entry.level === "pageerror")).toEqual([]);
  } catch (error) {
    primaryFailure = error;
    throw error;
  } finally {
    const cleanup = await Promise.allSettled([shared?.close(), owner?.close()]);
    cleanup.push(...await Promise.allSettled([relay?.stop(), proxy?.close()]));
    cleanup.push(...await Promise.allSettled([temp.cleanup()]));
    const failures = cleanup.filter((result): result is PromiseRejectedResult => result.status === "rejected");
    if (failures.length) {
      await test.info().attach("cleanup failures", { contentType: "text/plain",
        body: failures.map(result => String(result.reason)).join("\n") });
      if (primaryFailure === undefined) throw new AggregateError(failures.map(result => result.reason), "Share link edit test cleanup failed.");
    }
  }
});
