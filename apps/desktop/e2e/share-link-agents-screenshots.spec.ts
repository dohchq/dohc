import { expect, test, type Locator, type Page } from "@playwright/test";
import { randomBytes } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { waitForVisibleAnimations } from "./helpers/animations";
import { launchDesktopApp } from "./helpers/desktopApp";
import { signInLinkAgent, startAgentCallback, stopAgentCallback, type AgentCallback } from "./helpers/linkAgent";
import { claimRelayWorkspace } from "./helpers/relayPeer";
import { sharedDatasetViewerOrigin, startSharedDatasetBrowser } from "./helpers/sharedDatasetBrowser";
import { holdSystemClipboard } from "./helpers/systemClipboard";
import { relayAdoptedIdentity, spawnSyncRelay, type RelayWorkspaceIdentity, type SyncRelayHandle } from "./helpers/syncRelay";
import {
  cleanupDesktopWorkspace,
  createTempWorkspace,
  explorerRow,
  openWorkspaceFromFirstRun,
  revealExplorerPath,
  seedCloudCredentials,
  seedWorkspaceManifest,
  seedWorkspaceRegistry,
  writeWorkspaceFiles,
} from "./helpers/workspace";

// Copy for an agent and a link's Agents list, light and dark: the new link
// with its two copies, the list with two agents, and the link once both are
// disconnected. Disconnect's "Disconnecting…" lasts one relay round trip, so
// it is covered by the component test, not a frame.
const SHOT_DIR = process.env.UI_AUDIT_SHOT_DIR ?? "";
test.skip(SHOT_DIR === "", "set UI_AUDIT_SHOT_DIR to capture share link agent screenshots");
// The link and its address belong to this test's own relay, which the test
// stops and deletes, so a frame that shows one leaves nothing usable.
test.use({ screenshot: "off", trace: "off" });

const OWNER = "e2e-link-owner";
const TOKEN = `test:${OWNER}`;
const WORKSPACE_ID = "share-link-agents-screens";
const PATH = "docs/plan.md";

async function setTheme(page: Page, theme: "light" | "dark"): Promise<void> {
  await page.evaluate(async (value) => {
    document.documentElement.setAttribute("data-theme", value);
    void getComputedStyle(document.body).backgroundColor;
    await document.fonts.ready;
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  }, theme);
  await waitForVisibleAnimations(page);
}

// The dialog stays above the toasts and inside the window, so the backdrop
// never scrolls; a long dialog scrolls its own body.
async function expectFitsWindow(page: Page, dialog: Locator): Promise<void> {
  const box = await dialog.boundingBox();
  const fit = await page.evaluate(() => {
    const scrim = document.querySelector<HTMLElement>("[data-dohc-modal]")!;
    const room = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--dohc-toast-room")) || 0;
    return { limit: window.innerHeight - room, scrimScrolls: scrim.scrollHeight > scrim.clientHeight };
  });
  expect(box).not.toBeNull();
  expect(box!.y).toBeGreaterThanOrEqual(0);
  expect(box!.y + box!.height).toBeLessThanOrEqual(fit.limit);
  expect(fit.scrimScrolls).toBe(false);
}

async function shoot(page: Page, dialog: Locator, name: string): Promise<void> {
  await page.mouse.move(0, 0);
  await expectFitsWindow(page, dialog);
  for (const theme of ["light", "dark"] as const) {
    await setTheme(page, theme);
    await dialog.screenshot({ path: join(SHOT_DIR, `${name}-${theme}.png`) });
  }
  await setTheme(page, "light");
}

async function openLinkPane(page: Page): Promise<Locator> {
  await revealExplorerPath(page, PATH);
  await explorerRow(page, PATH).click({ button: "right" });
  await page.getByTestId("explorer-menu-item-share").click();
  const dialog = page.getByTestId("share-dialog");
  await expect(dialog).toBeVisible();
  await dialog.getByRole("radio", { name: "Anyone with the link" }).click();
  return dialog;
}

test("@ui-audit Copy for an agent and a link's Agents list", async () => {
  test.setTimeout(300_000);
  await mkdir(SHOT_DIR, { recursive: true });
  const temp = await createTempWorkspace();
  const relayExchangeKey = randomBytes(32).toString("base64url");
  let relay: SyncRelayHandle | null = null;
  let shared: Awaited<ReturnType<typeof startSharedDatasetBrowser>> | null = null;
  let desktop: Awaited<ReturnType<typeof launchDesktopApp>> | null = null;
  let callback: AgentCallback | null = null;
  try {
    callback = await startAgentCallback();
    await seedWorkspaceManifest(temp, WORKSPACE_ID);
    await writeWorkspaceFiles(temp, [{ path: PATH, contents: "# Trip plan\n\nPack light.\n" }]);
    relay = await spawnSyncRelay({
      dbPath: join(temp.baseDir, "relay", "relay.sqlite"),
      linkBoundary: { linkKey: randomBytes(32).toString("base64url"), relayExchangeKey, publicViewerOrigin: sharedDatasetViewerOrigin },
    });
    await claimRelayWorkspace({ baseUrl: relay.baseUrl, token: TOKEN, workspaceId: WORKSPACE_ID });
    await seedWorkspaceRegistry(temp, [{ workspaceId: WORKSPACE_ID, rootPath: temp.rootPath, remote: { serverUrl: relay.baseUrl, ownerUserId: OWNER } }]);
    await seedCloudCredentials(temp, { serverUrl: relay.baseUrl, relayUrl: relay.baseUrl, email: `${OWNER}@dohc.test`, userId: OWNER, token: TOKEN });
    shared = await startSharedDatasetBrowser({ relayUrl: relay.baseUrl, exchangeKey: relayExchangeKey });
    desktop = await launchDesktopApp({
      workspace: temp,
      env: { DOHC_TEST_SYNC_DEBOUNCE_MS: "150", DOHC_TEST_SYNC_BACKOFF_MS: "250" },
    });
    const { page } = desktop;
    await openWorkspaceFromFirstRun(page, temp);

    // A link shares what the relay holds, so the file reaches it first.
    let identity: RelayWorkspaceIdentity | null = null;
    await expect.poll(async () => {
      identity ??= relayAdoptedIdentity(relay!.dbPath, WORKSPACE_ID);
      if (identity === null) return false;
      const query = new URLSearchParams({ since: "0", limit: "500", replicationEpoch: identity.replicationEpoch, streamIdentity: identity.streamIdentity });
      const response = await fetch(`${relay!.baseUrl}/sync/${encodeURIComponent(WORKSPACE_ID)}/log?${query.toString()}`, { headers: { authorization: `Bearer ${TOKEN}` } });
      if (response.status === 409) identity = null;
      if (!response.ok) return false;
      const body = (await response.json()) as { ops: Array<{ payload?: { path?: string } }> };
      return body.ops.some((op) => op.payload?.path === PATH);
    }, { timeout: 90_000, intervals: [1_000] }).toBe(true);

    // The new link: its URL with Copy, and Copy for an agent beside it.
    let dialog = await openLinkPane(page);
    await dialog.getByRole("button", { name: "Create link", exact: true }).click();
    const linkUrl = new URL((await dialog.getByTestId("share-link-url").textContent()) ?? "");
    expect(linkUrl.origin).toBe(sharedDatasetViewerOrigin);
    const secret = linkUrl.hash.slice(1);
    const address = `${linkUrl.origin}/mcp/s/${secret}`;
    const agentCopy = dialog.getByTestId("share-link-agent-copy");
    await expect(agentCopy).toHaveText("Copy for an agent");
    await expect(dialog).not.toContainText(address);
    await shoot(page, dialog, "share-link-a-copy-for-agent");
    await holdSystemClipboard(test.info(), async (remainingMs) => {
      await agentCopy.click({ timeout: remainingMs() });
      await expect(agentCopy).toHaveText("Copied", { timeout: remainingMs() });
      expect(await desktop!.app.evaluate(({ clipboard }) => clipboard.readText())).toBe(address);
    });

    // Two agents sign in with the copied address, and each makes a call.
    const named = await signInLinkAgent({ handle: shared.handle, browser: shared.browser, callback, address, clientName: "Claude Code" });
    const unnamed = await signInLinkAgent({ handle: shared.handle, browser: shared.browser, callback, address });
    for (const agent of [named, unnamed]) {
      expect((await agent.rpc("tools/call", { name: "dohc_share_status", arguments: {} })).status).toBe(200);
    }

    await dialog.getByRole("button", { name: "Close", exact: true }).click();
    dialog = await openLinkPane(page);
    const agents = dialog.getByRole("region", { name: "Agents" });
    await expect(agents.getByRole("listitem")).toHaveCount(2);
    await expect(agents).toContainText("Claude Code");
    await expect(agents).toContainText("Name reported by the agent");
    await expect(agents).toContainText("The agent reported no name");
    // Two agents make the pane taller than the window: the body scrolls to
    // them while the title and the backdrop stay put.
    await expect(dialog).toHaveAttribute("data-scrolls", "");
    await agents.scrollIntoViewIfNeeded();
    const body = dialog.getByTestId("share-dialog-body");
    expect(await body.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
    expect(await page.locator("[data-dohc-modal]").evaluate((element) => element.scrollTop)).toBe(0);
    await expect(dialog.getByRole("heading", { name: "Share" })).toBeInViewport();
    // Toasts take room at the bottom, and the dialog gives it up.
    await page.evaluate(() => document.documentElement.style.setProperty("--dohc-toast-room", "160px"));
    await expectFitsWindow(page, dialog);
    await page.evaluate(() => document.documentElement.style.removeProperty("--dohc-toast-room"));
    await shoot(page, dialog, "share-link-b-agents-two");

    // Disconnect ends the agent's connection: its next call is refused.
    await agents.getByRole("button", { name: "Disconnect Claude Code" }).click();
    await expect(agents.getByRole("listitem")).toHaveCount(1);
    expect((await named.rpc("tools/list")).status).toBe(401);
    expect((await unnamed.rpc("tools/list")).status).toBe(200);
    await agents.getByRole("button", { name: "Disconnect Agent" }).click();
    await expect(dialog.getByRole("region", { name: "Agents" })).toHaveCount(0);
    await shoot(page, dialog, "share-link-c-no-agents");

    // The address carries the link's secret, so no log holds it.
    expect(desktop.logs.filter((entry) => entry.text.includes(secret))).toEqual([]);
    expect(shared.failures).toEqual([]);
  } finally {
    try { await shared?.close(); } finally {
      try { await stopAgentCallback(callback); } finally {
        try { await relay?.stop(); } finally { await cleanupDesktopWorkspace(desktop, temp); }
      }
    }
  }
});
