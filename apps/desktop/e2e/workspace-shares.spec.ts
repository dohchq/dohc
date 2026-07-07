import { expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  claimRelayWorkspace,
  createVersionedTextStore,
  pushWorkspaceToRelay,
} from "@dohc/workspace-engine";
import { launchDesktopApp } from "./helpers/desktopApp";
import { spawnSyncRelay, type SyncRelayHandle } from "./helpers/syncRelay";
import {
  cleanupDesktopWorkspace,
  createTempWorkspace,
  explorerRow,
  openWorkspaceFromFirstRun,
  revealExplorerPath,
  seedCloudCredentials,
  seedWorkspaceManifest,
  seedWorkspaceRegistry,
  seedWorkspaceSettings,
  writeWorkspaceFiles,
} from "./helpers/workspace";

// PR 18 — external shares on the rebuilt cloud. Two REAL relay accounts
// (the test-auth seam mints identity from the bearer token, and resolves
// "<user>@dohc.test" emails to "<user>"), one real Electron app, and a
// headless engine store as the other party — the 0P-C harness pattern.
//
// Spec 1 (grant side): the app user shares a file by email from the
//   explorer context menu, gets a copyable share code, manages it under
//   Settings → Cloud, and ends it — after which the recipient's relay
//   access is a byte-identical 404.
// Spec 2 (receive side, the full loop): grant → open the share in the app
//   → browse/search the read-only view → granter edits → refresh sees it →
//   revoke → refresh surfaces "this share was ended" honestly.

const GRANTER_TOKEN = "test:e2e-granter";
const RECIPIENT_TOKEN = "test:e2e-recipient";
const RECIPIENT_EMAIL = "e2e-recipient@dohc.test";

function granterConnection(baseUrl: string) {
  return { baseUrl, token: GRANTER_TOKEN };
}

async function relayJson(
  baseUrl: string,
  token: string,
  path: string,
  init: RequestInit = {},
): Promise<{ status: number; body: string }> {
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${token}`);
  if (init.body) headers.set("content-type", "application/json");
  const response = await fetch(`${baseUrl}${path}`, { ...init, headers });
  return { status: response.status, body: await response.text() };
}

test("grant side: share a file by email from the explorer, copy the code, and end it from Settings", async () => {
  test.setTimeout(240_000);
  const temp = await createTempWorkspace();
  const workspaceId = "share-grant-e2e";
  let relay: SyncRelayHandle | null = null;
  let desktop: Awaited<ReturnType<typeof launchDesktopApp>> | null = null;

  try {
    await seedWorkspaceManifest(temp, workspaceId);
    await seedWorkspaceSettings(temp, { experimental: { workspaceEngineAlpha: true } });
    await writeWorkspaceFiles(temp, [
      { path: "docs/plan.md", contents: "# Plan\n\nShare me.\n" },
    ]);

    relay = await spawnSyncRelay({ dbPath: join(temp.baseDir, "relay.sqlite") });
    await claimRelayWorkspace({
      workspaceId,
      relay: granterConnection(relay.baseUrl),
    });
    await seedWorkspaceRegistry(temp, [
      {
        workspaceId,
        rootPath: temp.rootPath,
        remote: { serverUrl: relay.baseUrl, remoteWorkspaceId: workspaceId },
      },
    ]);
    await seedCloudCredentials(temp, {
      serverUrl: relay.baseUrl,
      relayUrl: relay.baseUrl,
      email: "e2e-granter@dohc.test",
      token: GRANTER_TOKEN,
    });

    desktop = await launchDesktopApp({
      workspace: temp,
      env: {
        DOHC_TEST_SYNC_DEBOUNCE_MS: "150",
        DOHC_TEST_SYNC_BACKOFF_MS: "250",
        // The native context menu cannot be driven by Playwright; the test
        // seam resolves the next invoke to "Share…".
        DOHC_TEST_EXPLORER_MENU_CHOICE: "share",
      },
    });
    const page = desktop.page;
    await openWorkspaceFromFirstRun(page, temp);

    // Right-click the file → (seamed) "Share…" → the share dialog.
    await revealExplorerPath(page, "docs/plan.md");
    await explorerRow(page, "docs/plan.md").click({ button: "right" });
    const dialog = page.getByTestId("share-dialog");
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText("docs/plan.md");

    await dialog.getByTestId("share-email").fill(RECIPIENT_EMAIL);
    await dialog.getByTestId("share-create").click();

    const code = dialog.getByTestId("share-code");
    await expect(code).toBeVisible();
    const shareCode = (await code.textContent()) ?? "";
    expect(shareCode.startsWith("dohc-share:")).toBe(true);
    const shareId = shareCode.split(":")[1]!;
    await dialog.getByTestId("share-done").click();

    // The recipient can fetch the shared log; a stranger cannot, and the
    // denial is byte-identical to a share that never existed.
    const recipientFetch = await relayJson(
      relay.baseUrl,
      RECIPIENT_TOKEN,
      `/sync/shares/${shareId}/log?since=0`,
    );
    expect(recipientFetch.status).toBe(200);
    const strangerFetch = await relayJson(
      relay.baseUrl,
      "test:e2e-stranger",
      `/sync/shares/${shareId}/log?since=0`,
    );
    const missingFetch = await relayJson(
      relay.baseUrl,
      "test:e2e-stranger",
      "/sync/shares/never-existed/log?since=0",
    );
    expect(strangerFetch.status).toBe(404);
    expect(strangerFetch.body).toBe(missingFetch.body);

    // Settings → Cloud → "Shared by me": the grant is listed and endable.
    await page.getByTestId("activity-settings").click();
    await page.getByTestId("settings-nav-cloud").click();
    const row = page.getByTestId("shared-by-me-row");
    await expect(row).toBeVisible();
    await expect(row).toContainText("docs/plan.md");
    await expect(row).toContainText(RECIPIENT_EMAIL);
    await row.getByTestId("shared-by-me-revoke").click();
    await expect(row).toContainText("Ended — was shared with");

    // Revocation is live: the recipient's next fetch is the byte-identical
    // generic 404.
    const revokedFetch = await relayJson(
      relay.baseUrl,
      RECIPIENT_TOKEN,
      `/sync/shares/${shareId}/log?since=0`,
    );
    expect(revokedFetch.status).toBe(404);
    expect(revokedFetch.body).toBe(missingFetch.body);
  } finally {
    if (desktop) await cleanupDesktopWorkspace(desktop, temp);
    else await temp.cleanup();
    await relay?.stop();
  }
});

test("receive side: open a share read-only, follow the granter's edits, and see the honest end", async () => {
  test.setTimeout(240_000);
  const temp = await createTempWorkspace();
  const workspaceId = "share-loop-e2e";
  const granterDir = join(temp.baseDir, "granter-machine");
  let relay: SyncRelayHandle | null = null;
  let desktop: Awaited<ReturnType<typeof launchDesktopApp>> | null = null;

  async function granterWrite(path: string, text: string): Promise<void> {
    const store = createVersionedTextStore(granterDir);
    try {
      await store.ensureMainVersion({ workspaceId });
      await store.writeTextFile({
        workspaceId,
        versionId: "main",
        path,
        text,
        metadata: { origin: "local-file" },
      });
    } finally {
      await store.close();
    }
  }

  try {
    // The granter (headless): shared and unshared content, pushed to the
    // relay under the granter account.
    relay = await spawnSyncRelay({ dbPath: join(temp.baseDir, "relay.sqlite") });
    await granterWrite("docs/shared.md", "# Shared\n\nThe comet-tail draft.\n");
    await granterWrite("docs/nested/deep.md", "Deep shared body.\n");
    await granterWrite("private/hidden.md", "The kraken ledger stays private.\n");
    await claimRelayWorkspace({ workspaceId, relay: granterConnection(relay.baseUrl) });
    await pushWorkspaceToRelay({
      rootDir: granterDir,
      workspaceId,
      relay: granterConnection(relay.baseUrl),
    });

    // The grant: docs/ (folder selector), addressed to the recipient email.
    const create = await relayJson(
      relay.baseUrl,
      GRANTER_TOKEN,
      `/sync/${workspaceId}/shares`,
      {
        method: "POST",
        body: JSON.stringify({ recipientEmail: RECIPIENT_EMAIL, paths: ["docs"] }),
      },
    );
    expect(create.status).toBe(200);
    const shareId = (JSON.parse(create.body) as { shareId: string }).shareId;
    const shareCode = `dohc-share:${shareId}:${relay.baseUrl}`;

    // The app is the recipient: fresh home, signed in as the recipient.
    await seedCloudCredentials(temp, {
      serverUrl: relay.baseUrl,
      relayUrl: relay.baseUrl,
      email: RECIPIENT_EMAIL,
      token: RECIPIENT_TOKEN,
    });
    desktop = await launchDesktopApp({ workspace: temp });
    const page = desktop.page;

    await page.getByTestId("first-run-open-share").click();
    await expect(page.getByTestId("open-shared-view")).toBeVisible();
    await page.getByTestId("open-share-code").fill(shareCode);
    await page.getByTestId("open-share-choose-folder").click();
    await expect(page.getByTestId("open-shared-view")).toContainText(temp.rootPath);
    await page.getByTestId("open-share-start").click();

    // The shared view opens: banner, shared files, and NOT the private one.
    await expect(page.getByTestId("workspace-shell")).toBeVisible();
    const banner = page.getByTestId("shared-view-banner");
    await expect(banner).toBeVisible();
    await expect(banner).toContainText("Shared view from e2e-granter@dohc.test");
    await expect(banner).toContainText("read-only");

    await revealExplorerPath(page, "docs/shared.md");
    await expect(explorerRow(page, "private")).toHaveCount(0);
    await expect(explorerRow(page, "private/hidden.md")).toHaveCount(0);

    // Browse: the file opens and shows the granter's content.
    await explorerRow(page, "docs/shared.md").click();
    await expect(page.getByText("The comet-tail draft.")).toBeVisible();

    // Search: the shared view is locally searchable.
    await page.getByTestId("activity-search").click();
    await page.getByTestId("search-input").fill("comet-tail");
    await expect(
      page.locator('[data-testid="search-result-group"][data-path="docs/shared.md"]'),
    ).toBeVisible();
    await page.getByTestId("search-input").fill("kraken");
    await expect(page.locator('[data-testid="search-result-group"]')).toHaveCount(0);

    // Writes are refused with the honest copy — at the IPC boundary, not
    // just in the UI.
    const writeAttempt = await page.evaluate(async () => {
      const api = (window as unknown as {
        dohcDesktop: {
          getWorkspaceRegistry(): Promise<{
            workspaces: Array<{ workspaceId: string }>;
          }>;
          writeWorkspaceText(payload: {
            workspaceId: string;
            relativePath: string;
            text: string;
          }): Promise<void>;
        };
      }).dohcDesktop;
      const registry = await api.getWorkspaceRegistry();
      try {
        await api.writeWorkspaceText({
          workspaceId: registry.workspaces[0]!.workspaceId,
          relativePath: "docs/shared.md",
          text: "defaced",
        });
        return "wrote";
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      }
    });
    expect(writeAttempt).toContain("This is a shared view — ask e2e-granter@dohc.test for changes.");

    // The other three mutation side-doors are refused at the IPC boundary too:
    // a managed agent run, a code-executing site preview, and a write-capable
    // MCP config. All route through the same shared-view guard.
    //
    // Snapshot the materialized shared file BEFORE the bypass so the engine
    // Y.Doc apply attempt can be proven inert — not merely non-throwing.
    const sharedFilePath = join(temp.rootPath, "docs/shared.md");
    const originalSharedContents = await readFile(sharedFilePath, "utf8");
    const bypassAttempts = await page.evaluate(async () => {
      const api = (window as unknown as {
        dohcDesktop: {
          getWorkspaceRegistry(): Promise<{ workspaces: Array<{ workspaceId: string }> }>;
          startAgentRun(payload: { workspaceId: string }): Promise<unknown>;
          startSitePreview(payload: {
            workspaceId: string;
            siteRoot: string;
            mode: "static" | "dev" | "build";
          }): Promise<unknown>;
          getMcpConfig(payload: { workspaceId: string }): Promise<{ args: string[] }>;
          openEngineYDocSession(payload: {
            workspaceId: string;
            sessionId: string;
            path: string;
          }): Promise<{ available: boolean }>;
          applyEngineYDocUpdate(payload: {
            sessionId: string;
            update: Uint8Array;
          }): Promise<void>;
        };
      }).dohcDesktop;
      const workspaceId = (await api.getWorkspaceRegistry()).workspaces[0]!.workspaceId;
      const capture = async (run: () => Promise<unknown>) => {
        try {
          await run();
          return "allowed";
        } catch (error) {
          return error instanceof Error ? error.message : String(error);
        }
      };
      const agent = await capture(() => api.startAgentRun({ workspaceId }));
      const sitePreview = await capture(() =>
        api.startSitePreview({ workspaceId, siteRoot: "docs", mode: "dev" }),
      );
      const mcp = await api.getMcpConfig({ workspaceId });
      // WS-G2-C-2 gate fix 4: a live engine Y.Doc session is WRITABLE, so opening
      // one in a read-only shared view must be refused at the IPC boundary (same
      // class as the write bypass above). applyEngineYDocUpdate on the refused
      // session must be an inert no-op — it must never throw AND never write.
      const engineYDoc = await api.openEngineYDocSession({
        workspaceId,
        sessionId: "shared-view-bypass",
        path: "docs/shared.md",
      });
      const engineYDocApply = await capture(() =>
        api.applyEngineYDocUpdate({ sessionId: "shared-view-bypass", update: new Uint8Array([1, 2, 3]) }),
      );
      return {
        agent,
        sitePreview,
        mcpArgs: mcp.args,
        engineYDocAvailable: engineYDoc.available,
        engineYDocApply,
      };
    });
    expect(bypassAttempts.agent).toContain("Agents can't run in a shared view");
    expect(bypassAttempts.sitePreview).toContain("disabled in a shared view");
    // The copyable MCP config for a shared view is the read-only profile.
    expect(bypassAttempts.mcpArgs).toContain("--read-only");
    // The engine Y.Doc editor session is refused (never opens a writable session
    // in a shared view), and applying an update to it is an inert no-op.
    expect(bypassAttempts.engineYDocAvailable).toBe(false);
    expect(bypassAttempts.engineYDocApply).toBe("allowed");
    // "allowed" only proves the apply didn't throw — a regression that dropped
    // the read-only guard on applyEngineYDocUpdate (keeping it on open) would
    // still look like a no-op via the missing-session lookup. Prove the update
    // NEVER LANDED: the materialized shared file on disk is byte-for-byte
    // unchanged after the apply attempt.
    expect(await readFile(sharedFilePath, "utf8")).toBe(originalSharedContents);

    // The granter keeps working; the recipient refreshes and sees it.
    await granterWrite("docs/shared.md", "# Shared\n\nThe comet-tail draft, round two.\n");
    await pushWorkspaceToRelay({
      rootDir: granterDir,
      workspaceId,
      relay: granterConnection(relay.baseUrl),
    });
    await page.getByTestId("shared-view-refresh").click();
    await expect(page.getByText("The comet-tail draft, round two.")).toBeVisible();

    // The granter ends the share; the next refresh says so honestly and the
    // local copy stays readable.
    const revoke = await relayJson(
      relay.baseUrl,
      GRANTER_TOKEN,
      `/sync/shares/${shareId}/revoke`,
      { method: "POST", body: JSON.stringify({}) },
    );
    expect(revoke.status).toBe(200);
    await page.getByTestId("shared-view-refresh").click();
    await expect(banner).toContainText("This share was ended");
    await expect(banner).toContainText("Your copy stays readable but won't update anymore.");
    await expect(page.getByTestId("shared-view-refresh")).toHaveCount(0);
    await expect(page.getByText("The comet-tail draft, round two.")).toBeVisible();
  } finally {
    if (desktop) await cleanupDesktopWorkspace(desktop, temp);
    else await temp.cleanup();
    await relay?.stop();
  }
});
