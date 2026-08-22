import { expect, test } from "@playwright/test";
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { DohcDesktopBridge } from "../src/ipc/bridgeContract";
import { RelayFilePeer } from "../src/testing/relayFilePeer";
import { claimRelayWorkspace, relayJson } from "./helpers/relayPeer";
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
// test-only relay protocol peer as the other party.
//
// Spec 1 (grant side): the app user shares a file by email from the
//   explorer context menu, gets a copyable share code, manages it under
//   Settings → Cloud, and ends it — after which the recipient's relay
//   access is a byte-identical 404.
// Spec 2 (receive side, the full loop): grant → open the share in the app
//   → browse/search the read-only view → granter edits → refresh sees it →
//   revoke → refresh surfaces "this share was ended" honestly.

const GRANTER_TOKEN = "test:e2e-granter";
const UNUSED_CONTENT_HASH = "0".repeat(64);
const RECIPIENT_TOKEN = "test:e2e-recipient";
const RECIPIENT_EMAIL = "e2e-recipient@dohc.test";

// The granter's only open proposal, listed then opened — the shape the
// granter's own review takes. The listing is a summary (#808); its count is
// the whole answer it owes a timer, enforced at
// services/sync-relay/src/shareProposals.test.ts:1700-1723. Opening reads
// that one proposal's file rows.
async function openOnlyProposal(
  baseUrl: string,
  workspaceId: string,
): Promise<{
  summary: { proposalId: string; proposedByEmail: string | null; ops: number };
  proposal: Record<string, unknown>;
}> {
  const listed = await relayJson(baseUrl, GRANTER_TOKEN, `/sync/${workspaceId}/proposals`);
  expect(listed.status).toBe(200);
  const proposals = (
    JSON.parse(listed.body) as {
      proposals: Array<{ proposalId: string; proposedByEmail: string | null; ops: number }>;
    }
  ).proposals;
  expect(proposals.length, "one open proposal").toBe(1);
  const summary = proposals[0]!;

  const opened = await relayJson(
    baseUrl,
    GRANTER_TOKEN,
    `/sync/${workspaceId}/proposals/${summary.proposalId}`,
  );
  expect(opened.status, opened.body).toBe(200);
  const proposal = (JSON.parse(opened.body) as { proposal: Record<string, unknown> }).proposal;

  return { summary, proposal };
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
    await claimRelayWorkspace({ baseUrl: relay.baseUrl, token: GRANTER_TOKEN, workspaceId });
    await seedWorkspaceRegistry(temp, [
      {
        workspaceId,
        rootPath: temp.rootPath,
        remote: {
          serverUrl: relay.baseUrl,
          remoteWorkspaceId: workspaceId,
          ownerUserId: "e2e-granter",
        },
      },
    ]);
    await seedCloudCredentials(temp, {
      serverUrl: relay.baseUrl,
      relayUrl: relay.baseUrl,
      email: "e2e-granter@dohc.test",
      userId: "e2e-granter",
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
    // Ending asks before it ends: the first click opens the confirm.
    await row.getByTestId("shared-by-me-revoke-start").click();
    await expect(row.getByTestId("shared-by-me-revoke-confirm")).toBeVisible();
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
    // Stop the relay child before removing the temp tree it holds open, or
    // Windows leaks the dir with EBUSY (POSIX tolerates the reverse order).
    await relay?.stop();
    if (desktop) await cleanupDesktopWorkspace(desktop, temp);
    else await temp.cleanup();
  }
});

test("receive side: open a share read-only, follow the granter's edits, and see the honest end", async () => {
  test.setTimeout(240_000);
  const temp = await createTempWorkspace();
  const workspaceId = "share-loop-e2e";
  let relay: SyncRelayHandle | null = null;
  let desktop: Awaited<ReturnType<typeof launchDesktopApp>> | null = null;

  try {
    // A test-only remote peer seeds shared and unshared content through the
    // relay protocol under the granter account.
    relay = await spawnSyncRelay({ dbPath: join(temp.baseDir, "relay.sqlite") });
    await claimRelayWorkspace({ baseUrl: relay.baseUrl, token: GRANTER_TOKEN, workspaceId });
    const granter = new RelayFilePeer({
      baseUrl: relay.baseUrl,
      token: GRANTER_TOKEN,
      workspaceId,
    });
    await granter.writeTextFiles([
      { path: "docs/shared.md", text: "# Shared\n\nThe comet-tail draft.\n" },
      { path: "docs/nested/deep.md", text: "Deep shared body.\n" },
      { path: "private/hidden.md", text: "The kraken ledger stays private.\n" },
    ]);

    // The grant: docs/ (folder selector), addressed to the recipient email.
    const create = await relayJson(
      relay.baseUrl,
      GRANTER_TOKEN,
      `/sync/${workspaceId}/shares`,
      {
        method: "POST",
        body: JSON.stringify({ recipientEmail: RECIPIENT_EMAIL, paths: ["docs"], access: "view" }),
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
      userId: "e2e-recipient",
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
    const writeAttempt = await page.evaluate(async (unusedContentHash) => {
      const api = (window as unknown as {
        dohcDesktop: Pick<
          DohcDesktopBridge,
          "getWorkspaceRegistry" | "writeWorkspaceText"
        >;
      }).dohcDesktop;
      const registry = await api.getWorkspaceRegistry();
      try {
        await api.writeWorkspaceText({
          workspaceId: registry.workspaces[0]!.workspaceId,
          relativePath: "docs/shared.md",
          text: "defaced",
          expectedContentHash: unusedContentHash,
        });
        return "wrote";
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      }
    }, UNUSED_CONTENT_HASH);
    // A share view's text save is the one write decided at its own routed
    // seam rather than by the workspace-wide gate (#646 PR3), so a VIEW share
    // is refused there by the shared-file rule. Every other write handler
    // below still meets the workspace gate and its wording.
    expect(writeAttempt).toContain("SharedFileReadOnlyError");
    expect(writeAttempt).toContain("This shared file is read-only for you.");

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
          // Taken from the CONTRACT, not re-typed here. The hand-written
          // shape drifted once already, so the call was rejected at the
          // schema and never reached the refusal this asserts.
          applyEngineYDocUpdate: DohcDesktopBridge["applyEngineYDocUpdate"];
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
        api.applyEngineYDocUpdate({
          sessionId: "shared-view-bypass",
          update: new Uint8Array([1, 2, 3]),
          lineageGeneration: 1,
          // Typing this from the contract surfaced a SECOND drift the
          // hand-written shape hid: `seq` is required too, so the call would
          // have been rejected at the schema again.
          seq: 1,
        }),
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
    // The copyable MCP config for a shared view carries the share's level, so
    // the launched server registers only the write tools that level grants.
    // This share was created at "view", which grants none.
    expect(bypassAttempts.mcpArgs.join(" ")).toContain("--share-access view");
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
    await granter.writeText("docs/shared.md", "# Shared\n\nThe comet-tail draft, round two.\n");
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
    // Stop the relay child before removing the temp tree it holds open, or
    // Windows leaks the dir with EBUSY (POSIX tolerates the reverse order).
    await relay?.stop();
    if (desktop) await cleanupDesktopWorkspace(desktop, temp);
    else await temp.cleanup();
  }
});

test("mount side: add a share into a workspace as shared-with-me/, follow edits, survive revoke, unmount", async () => {
  test.setTimeout(240_000);
  const temp = await createTempWorkspace();
  const hostWorkspaceId = "share-mount-host-e2e";
  const granterWorkspaceId = "share-mount-granter-e2e";
  let relay: SyncRelayHandle | null = null;
  let desktop: Awaited<ReturnType<typeof launchDesktopApp>> | null = null;

  try {
    // A test-only remote peer seeds shared and unshared content on the relay.
    relay = await spawnSyncRelay({ dbPath: join(temp.baseDir, "relay.sqlite") });
    await claimRelayWorkspace({
      baseUrl: relay.baseUrl,
      token: GRANTER_TOKEN,
      workspaceId: granterWorkspaceId,
    });
    const granter = new RelayFilePeer({
      baseUrl: relay.baseUrl,
      token: GRANTER_TOKEN,
      workspaceId: granterWorkspaceId,
    });
    await granter.writeTextFiles([
      { path: "docs/brief.md", text: "# Brief\n\nThe lighthouse memo.\n" },
      { path: "private/hidden.md", text: "The kraken ledger stays private.\n" },
    ]);
    const create = await relayJson(
      relay.baseUrl,
      GRANTER_TOKEN,
      `/sync/${granterWorkspaceId}/shares`,
      {
        method: "POST",
        body: JSON.stringify({ recipientEmail: RECIPIENT_EMAIL, paths: ["docs"], access: "view" }),
      },
    );
    expect(create.status).toBe(200);
    const shareId = (JSON.parse(create.body) as { shareId: string }).shareId;
    const shareCode = `dohc-share:${shareId}:${relay.baseUrl}`;

    // The recipient's ORDINARY workspace (the mount host) with its own files.
    await seedWorkspaceManifest(temp, hostWorkspaceId);
    await writeWorkspaceFiles(temp, [
      { path: "notes/mine.md", contents: "# Mine\n\nHost workspace file.\n" },
    ]);
    await seedWorkspaceRegistry(temp, [
      { workspaceId: hostWorkspaceId, rootPath: temp.rootPath },
    ]);
    await seedCloudCredentials(temp, {
      serverUrl: relay.baseUrl,
      relayUrl: relay.baseUrl,
      email: RECIPIENT_EMAIL,
      userId: "e2e-recipient",
      token: RECIPIENT_TOKEN,
    });

    desktop = await launchDesktopApp({ workspace: temp });
    const page = desktop.page;
    await openWorkspaceFromFirstRun(page, temp);

    // Titlebar → "Open a share…" → the dialog defaults to MOUNTING into
    // this workspace (no folder picker in mount mode).
    await page.getByTestId("workspace-switcher").click();
    await page.getByTestId("workspace-switcher-open-share").click();
    await expect(page.getByTestId("open-shared-view")).toBeVisible();
    await expect(page.getByTestId("open-share-mode-mount")).toHaveAttribute(
      "aria-checked",
      "true",
    );
    await expect(page.getByTestId("open-share-choose-folder")).toHaveCount(0);
    await page.getByTestId("open-share-code").fill(shareCode);
    await page.getByTestId("open-share-start").click();

    // The mount lands: notice, tree rows under shared-with-me/e2e-granter,
    // the private file never crosses, and the host file is untouched.
    await expect(page.getByTestId("shell-notice")).toContainText(
      "Added e2e-granter to shared-with-me",
    );
    await revealExplorerPath(page, "shared-with-me/e2e-granter/docs/brief.md");
    await expect(explorerRow(page, "shared-with-me/e2e-granter/private")).toHaveCount(0);
    await revealExplorerPath(page, "notes/mine.md");

    // The mounted file opens read-only with the granter's content.
    await explorerRow(page, "shared-with-me/e2e-granter/docs/brief.md").click();
    await expect(page.getByText("The lighthouse memo.")).toBeVisible();

    // Writes are refused at the IPC boundary (reserved projection), and
    // re-sharing mounted content is refused with the honest copy.
    const boundaryChecks = await page.evaluate(async (unusedContentHash) => {
      const api = (window as unknown as {
        dohcDesktop: Pick<
          DohcDesktopBridge,
          "getWorkspaceRegistry" | "writeWorkspaceText" | "createRelayShare"
        >;
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
      return {
        write: await capture(() =>
          api.writeWorkspaceText({
            workspaceId,
            relativePath: "shared-with-me/e2e-granter/docs/brief.md",
            text: "defaced",
            expectedContentHash: unusedContentHash,
          }),
        ),
        reshare: await capture(() =>
          api.createRelayShare({
            workspaceId,
            recipientEmail: "third-party@dohc.test",
            access: "view",
            paths: ["shared-with-me/e2e-granter/docs"],
          }),
        ),
      };
    }, UNUSED_CONTENT_HASH);
    expect(boundaryChecks.write).toContain("reserved");
    expect(boundaryChecks.reshare).toContain(
      "copy it into your own files to share it onward",
    );

    // The granter keeps working; a refresh pass pulls the update into the
    // mounted folder.
    await granter.writeText("docs/brief.md", "# Brief\n\nThe lighthouse memo, round two.\n");
    const refreshOutcome = await page.evaluate(async () => {
      const api = (window as unknown as {
        dohcDesktop: {
          getWorkspaceRegistry(): Promise<{ workspaces: Array<{ workspaceId: string }> }>;
          refreshShareMounts(payload: { workspaceId: string }): Promise<{
            results: Array<{ label: string; status: string; changedPaths: number }>;
          }>;
        };
      }).dohcDesktop;
      const workspaceId = (await api.getWorkspaceRegistry()).workspaces[0]!.workspaceId;
      return api.refreshShareMounts({ workspaceId });
    });
    expect(refreshOutcome.results).toEqual([
      { shareId, label: "e2e-granter", status: "updated", changedPaths: 1 },
    ]);
    expect(
      await readFile(
        join(temp.rootPath, "shared-with-me/e2e-granter/docs/brief.md"),
        "utf8",
      ),
    ).toContain("round two");

    // Revoke: the next refresh reports ended and the files stay readable.
    const revoke = await relayJson(
      relay.baseUrl,
      GRANTER_TOKEN,
      `/sync/shares/${shareId}/revoke`,
      { method: "POST", body: JSON.stringify({}) },
    );
    expect(revoke.status).toBe(200);
    const endedOutcome = await page.evaluate(async () => {
      const api = (window as unknown as {
        dohcDesktop: {
          getWorkspaceRegistry(): Promise<{ workspaces: Array<{ workspaceId: string }> }>;
          refreshShareMounts(payload: { workspaceId: string }): Promise<{
            results: Array<{ status: string }>;
          }>;
        };
      }).dohcDesktop;
      const workspaceId = (await api.getWorkspaceRegistry()).workspaces[0]!.workspaceId;
      return api.refreshShareMounts({ workspaceId });
    });
    expect(endedOutcome.results[0]!.status).toBe("ended");
    expect(
      await readFile(
        join(temp.rootPath, "shared-with-me/e2e-granter/docs/brief.md"),
        "utf8",
      ),
    ).toContain("round two");

    // Unmount removes exactly the projection; the host's own files survive.
    await page.evaluate(async (id) => {
      const api = (window as unknown as {
        dohcDesktop: {
          getWorkspaceRegistry(): Promise<{ workspaces: Array<{ workspaceId: string }> }>;
          unmountShare(payload: { workspaceId: string; shareId: string }): Promise<unknown>;
        };
      }).dohcDesktop;
      const workspaceId = (await api.getWorkspaceRegistry()).workspaces[0]!.workspaceId;
      await api.unmountShare({ workspaceId, shareId: id });
    }, shareId);
    expect(
      existsSync(join(temp.rootPath, "shared-with-me/e2e-granter")),
    ).toBe(false);
    expect(await readFile(join(temp.rootPath, "notes/mine.md"), "utf8")).toContain(
      "Host workspace file",
    );
  } finally {
    await relay?.stop();
    if (desktop) await cleanupDesktopWorkspace(desktop, temp);
    else await temp.cleanup();
  }
});

test("comment side: a recipient chats about a shared file and the message reaches the granter's log", async () => {
  // #646 PR2 — the whole loop for a COMMENT share, through the real app: the
  // relay serves the granter's files, the recipient opens the share, writes a
  // thread and a message on a shared file through the IPC boundary, and the
  // message lands in the GRANTER's own log under this share's origin.
  //
  // The last step is what makes this an end-to-end test rather than a local
  // one: the recipient's chat is only chat once it reaches the person who
  // shared the file. It is read back over HTTP as the granter, because a
  // second Electron app would collide with this one on the user-data dir.
  test.setTimeout(240_000);
  const temp = await createTempWorkspace();
  const workspaceId = "share-comment-e2e";
  let relay: SyncRelayHandle | null = null;
  let desktop: Awaited<ReturnType<typeof launchDesktopApp>> | null = null;

  try {
    relay = await spawnSyncRelay({ dbPath: join(temp.baseDir, "relay.sqlite") });
    await claimRelayWorkspace({ baseUrl: relay.baseUrl, token: GRANTER_TOKEN, workspaceId });
    const granter = new RelayFilePeer({
      baseUrl: relay.baseUrl,
      token: GRANTER_TOKEN,
      workspaceId,
    });
    await granter.writeTextFiles([
      { path: "docs/shared.md", text: "# Shared\n\nThe comet-tail draft.\n" },
      { path: "private/hidden.md", text: "The kraken ledger stays private.\n" },
    ]);

    const create = await relayJson(
      relay.baseUrl,
      GRANTER_TOKEN,
      `/sync/${workspaceId}/shares`,
      {
        method: "POST",
        body: JSON.stringify({
          recipientEmail: RECIPIENT_EMAIL,
          paths: ["docs"],
          access: "comment",
        }),
      },
    );
    expect(create.status).toBe(200);
    const shareId = (JSON.parse(create.body) as { shareId: string }).shareId;

    await seedCloudCredentials(temp, {
      serverUrl: relay.baseUrl,
      relayUrl: relay.baseUrl,
      email: RECIPIENT_EMAIL,
      userId: "e2e-recipient",
      token: RECIPIENT_TOKEN,
    });
    desktop = await launchDesktopApp({ workspace: temp });
    const page = desktop.page;

    await page.getByTestId("first-run-open-share").click();
    await expect(page.getByTestId("open-shared-view")).toBeVisible();
    await page.getByTestId("open-share-code").fill(`dohc-share:${shareId}:${relay.baseUrl}`);
    await page.getByTestId("open-share-choose-folder").click();
    await expect(page.getByTestId("open-shared-view")).toContainText(temp.rootPath);
    await page.getByTestId("open-share-start").click();
    await expect(page.getByTestId("workspace-shell")).toBeVisible();

    // The banner states the right the share actually grants.
    const banner = page.getByTestId("shared-view-banner");
    await expect(banner).toBeVisible();
    await expect(banner).toContainText("You can chat about these files, not edit them.");

    // The chat, written through the IPC boundary main owns. The renderer's
    // affordances are honesty; this is the authorization surface.
    const chat = await page.evaluate(async () => {
      const api = (window as unknown as {
        dohcDesktop: Pick<
          DohcDesktopBridge,
          | "getWorkspaceRegistry"
          | "createFileChat"
          | "sendChatMessage"
          | "listFileChats"
          | "listChatMessages"
          | "listChatChannels"
        >;
      }).dohcDesktop;
      const workspaceId = (await api.getWorkspaceRegistry()).workspaces[0]!.workspaceId;
      const created = await api.createFileChat({
        workspaceId,
        path: "docs/shared.md",
        title: "About the comet tail",
      });
      await api.sendChatMessage({
        workspaceId,
        threadId: created.thread.id,
        body: "Which comet is this?",
      });
      const threads = await api.listFileChats({ workspaceId, path: "docs/shared.md" });
      const messages = await api.listChatMessages({
        workspaceId,
        threadId: created.thread.id,
      });
      // The workspace-wide listing is NOT routed to a share view: a share
      // view gets per-file chat only, and #627 is the reason the whole
      // surface is refused rather than filtered.
      let channels: string;
      try {
        await api.listChatChannels({ workspaceId });
        channels = "answered";
      } catch (error) {
        channels = error instanceof Error ? error.message : String(error);
      }
      return {
        threadId: created.thread.id,
        threadTitles: threads.threads.map((thread) => thread.title),
        bodies: messages.messages.map((message) => message.body),
        channels,
      };
    });
    expect(chat.threadTitles).toContain("About the comet tail");
    expect(chat.bodies).toContain("Which comet is this?");
    expect(chat.channels).not.toBe("answered");

    // The proof: the message is in the GRANTER's own log, under this share's
    // namespaced origin, carrying the recipient's server-derived identity and
    // the file named by PATH (the recipient's object ids mean nothing here).
    await expect
      .poll(
        async () => {
          const page = await relayJson(
            relay!.baseUrl,
            GRANTER_TOKEN,
            `/sync/${workspaceId}/log?since=0&limit=500`,
          );
          if (page.status !== 200) return `status ${page.status}`;
          const all = (
            JSON.parse(page.body) as {
              ops: Array<{ originId: string; opKind: string; payload: Record<string, unknown> }>;
            }
          ).ops;
          // The GRANTER's own object id for the shared file, read from the
          // granter's own log. This is what the recipient's binding has to
          // resolve to, and it is knowable here rather than assumed.
          const granterObjectId = all
            .filter(
              (op) =>
                op.opKind === "moment.append" &&
                !op.originId.startsWith(`share:${shareId}:`) &&
                (op.payload.payloadAfterPath === "docs/shared.md" ||
                  op.payload.path === "docs/shared.md"),
            )
            .map((op) => op.payload.objectId)
            .at(-1);
          const ops = all.filter((op) => op.originId.startsWith(`share:${shareId}:`));
          const create = ops.find((op) => op.opKind === "chat.thread.create");
          const message = ops.find((op) => op.opKind === "chat.message.append");
          if (!create || !message) return `kinds: ${ops.map((op) => op.opKind).join(",")}`;
          if (typeof granterObjectId !== "string") return "no granter object for docs/shared.md";
          return {
            // The relay's accept door CONVERTS the binding before it stores
            // it, so the stored op names the granter's own object and no
            // path — the SAME object the granter's own moments name.
            carriesPath: create.payload.linkedPath !== undefined,
            boundToGranterObject: create.payload.linkedObjectId === granterObjectId,
            body: message.payload.body,
            authorUserId: message.payload.authorUserId,
          };
        },
        { timeout: 60_000, intervals: [1_000] },
      )
      .toEqual({
        // A recipient names its file by PATH on the wire, because its own
        // object ids mean nothing in the granter's workspace. The relay then
        // resolves that path to the granter's object and persists THAT —
        // which is what makes the thread follow the file through a rename
        // inside the share. `services/sync-relay/src/fileChatShares.test.ts`
        // pins the conversion; this is the same fact end to end, against the
        // granter's real object id rather than against the shape of one.
        carriesPath: false,
        boundToGranterObject: true,
        body: "Which comet is this?",
        authorUserId: "e2e-recipient",
      });
  } finally {
    await relay?.stop();
    if (desktop) await cleanupDesktopWorkspace(desktop, temp);
    else await temp.cleanup();
  }
});

test("edit side: a recipient edits a shared file, sends the changes, and the granter accepts them", async () => {
  // #646 PR3a — the whole proposal loop, through the real app and a real
  // relay. This is the only place in the repo where a real engine and a real
  // relay meet, so it is the only place that can prove the loop rather than
  // one half of it: the recipient's engine journals the edit, the relay holds
  // it as a change, the granter accepts, and the change lands in the
  // GRANTER's log carrying a base the granter's own log can name.
  test.setTimeout(300_000);
  const temp = await createTempWorkspace();
  const workspaceId = "share-edit-e2e";
  let relay: SyncRelayHandle | null = null;
  let desktop: Awaited<ReturnType<typeof launchDesktopApp>> | null = null;
  const EDITED = "# Shared\n\nThe comet-tail draft, corrected.\n";

  try {
    relay = await spawnSyncRelay({ dbPath: join(temp.baseDir, "relay.sqlite") });
    await claimRelayWorkspace({ baseUrl: relay.baseUrl, token: GRANTER_TOKEN, workspaceId });
    const granter = new RelayFilePeer({
      baseUrl: relay.baseUrl,
      token: GRANTER_TOKEN,
      workspaceId,
    });
    const [shared] = await granter.writeTextFiles([
      { path: "docs/shared.md", text: "# Shared\n\nThe comet-tail draft.\n" },
      { path: "private/hidden.md", text: "The kraken ledger stays private.\n" },
    ]);

    const create = await relayJson(relay.baseUrl, GRANTER_TOKEN, `/sync/${workspaceId}/shares`, {
      method: "POST",
      body: JSON.stringify({
        recipientEmail: RECIPIENT_EMAIL,
        paths: ["docs"],
        access: "edit",
      }),
    });
    expect(create.status).toBe(200);
    const shareId = (JSON.parse(create.body) as { shareId: string }).shareId;

    await seedCloudCredentials(temp, {
      serverUrl: relay.baseUrl,
      relayUrl: relay.baseUrl,
      email: RECIPIENT_EMAIL,
      userId: "e2e-recipient",
      token: RECIPIENT_TOKEN,
    });
    desktop = await launchDesktopApp({ workspace: temp });
    const page = desktop.page;

    await page.getByTestId("first-run-open-share").click();
    await expect(page.getByTestId("open-shared-view")).toBeVisible();
    await page.getByTestId("open-share-code").fill(`dohc-share:${shareId}:${relay.baseUrl}`);
    await page.getByTestId("open-share-choose-folder").click();
    await expect(page.getByTestId("open-shared-view")).toContainText(temp.rootPath);
    await page.getByTestId("open-share-start").click();
    await expect(page.getByTestId("workspace-shell")).toBeVisible();

    // The banner states the right the share actually grants.
    const banner = page.getByTestId("shared-view-banner");
    await expect(banner).toBeVisible();
    await expect(banner).toContainText("send your changes");

    // The edit, written through the IPC boundary main owns. At view and
    // comment this same call is refused; the receive-side spec pins that.
    const wrote = await page.evaluate(async (text) => {
      const api = (
        window as unknown as {
          dohcDesktop: Pick<
            DohcDesktopBridge,
            "getWorkspaceRegistry" | "readWorkspaceText" | "writeWorkspaceText"
          >;
        }
      ).dohcDesktop;
      const workspaceId = (await api.getWorkspaceRegistry()).workspaces[0]!.workspaceId;
      try {
        // The write is optimistic: it names the hash of the bytes it read, so
        // the recipient's edit is the same shape any editor save takes.
        const read = await api.readWorkspaceText({
          workspaceId,
          relativePath: "docs/shared.md",
        });
        if (read.truncated) return "the shared file read back truncated";
        await api.writeWorkspaceText({
          workspaceId,
          relativePath: "docs/shared.md",
          text,
          expectedContentHash: read.contentHash,
        });
        return "written";
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      }
    }, EDITED);
    expect(wrote, "an edit-level recipient may write to its own share view").toBe("written");

    // Sending waits for the capture to settle the write into a moment. A
    // submit that finds nothing pending makes no proposal, so polling it is
    // safe and never mints an empty one.
    await expect
      .poll(
        async () =>
          await page.evaluate(async () => {
            const api = (
              window as unknown as {
                dohcDesktop: Pick<
                  DohcDesktopBridge,
                  "getWorkspaceRegistry" | "submitShareChanges"
                >;
              }
            ).dohcDesktop;
            const workspaceId = (await api.getWorkspaceRegistry()).workspaces[0]!.workspaceId;
            try {
              const result = await api.submitShareChanges({ workspaceId });
              if (!result.ok) throw new Error(result.errorMessage);
              return result.submitted;
            } catch (error) {
              return error instanceof Error ? error.message : String(error);
            }
          }),
        { timeout: 120_000, intervals: [2_000] },
      )
      .toBe(1);

    // The granter's side, read over HTTP as the granter.
    const { summary, proposal } = await openOnlyProposal(relay.baseUrl, workspaceId);
    // WHO sent them, resolved by the relay from the server-derived user id on
    // the proposal row — never rebuilt by the client from its share list.
    expect(summary.proposedByEmail).toBe("e2e-recipient@dohc.test");
    expect(summary.ops).toBe(1);
    const proposalId = summary.proposalId;
    // One change, on the shared file, not drifted.
    const ops = proposal.ops as Array<{ afterPath: string; drifted: boolean }>;
    expect(ops.length).toBe(1);
    expect(ops[0]!.afterPath).toBe("docs/shared.md");
    expect(ops[0]!.drifted).toBe(false);

    // Nothing is in the granter's log until the granter says so.
    const beforeAccept = await relayJson(
      relay.baseUrl,
      GRANTER_TOKEN,
      `/sync/${workspaceId}/log?since=0&limit=500`,
    );
    const sharedOpsBefore = (
      JSON.parse(beforeAccept.body) as { ops: Array<{ originId: string }> }
    ).ops.filter((op) => op.originId.startsWith(`share:${shareId}:`));
    expect(sharedOpsBefore.length, "an open change must not be in the granter's log").toBe(0);

    const accepted = await relayJson(
      relay.baseUrl,
      GRANTER_TOKEN,
      `/sync/${workspaceId}/proposals/${proposalId}/accept`,
      { method: "POST" },
    );
    expect(accepted.status, accepted.body).toBe(200);

    // The proof. The change is in the GRANTER's log, under this share's
    // namespaced origin, naming the GRANTER's own object and the GRANTER's
    // own moment as its base — which is what lets the granter's engine
    // fast-forward instead of opening a conflict for a lineage it never saw.
    const afterAccept = await relayJson(
      relay.baseUrl,
      GRANTER_TOKEN,
      `/sync/${workspaceId}/log?since=0&limit=500`,
    );
    const landed = (
      JSON.parse(afterAccept.body) as {
        ops: Array<{ originId: string; opKind: string; payload: Record<string, unknown> }>;
      }
    ).ops.filter(
      (op) => op.originId.startsWith(`share:${shareId}:`) && op.opKind === "moment.append",
    );
    expect(landed.length).toBe(1);
    expect(landed[0]!.payload.objectId).toBe(shared!.objectId);
    expect(landed[0]!.payload.beforeLatestMomentId).toBe(shared!.latestMomentId);
    expect(landed[0]!.payload.beforeBlobSha256).toBe(shared!.blobSha256);
    expect(landed[0]!.payload.payloadAfterPath).toBe("docs/shared.md");
    expect(landed[0]!.payload.operation).toBe("write");

    // And the content really crossed: the granter can read the recipient's
    // bytes out of its own workspace.
    const digest = String(landed[0]!.payload.payloadAfterBlobSha256);
    const blob = await relayJson(
      relay.baseUrl,
      GRANTER_TOKEN,
      `/sync/${workspaceId}/blobs/${digest}`,
    );
    expect(blob.status).toBe(200);
    expect(blob.body).toBe(EDITED);
  } finally {
    await relay?.stop();
    if (desktop) await cleanupDesktopWorkspace(desktop, temp);
    else await temp.cleanup();
  }
});

test("edit side: a recipient creates, renames, deletes and imports, and the granter accepts all four", async () => {
  // #802 — the other four writes a share view admits, through the real app,
  // the real engine and a real relay. The text edit's loop is proved above;
  // what this proves is that each of these operations becomes a change the
  // submit lane can see, and that the accept door derives the RIGHT intent
  // for each: a create, a rename, a delete, and an import that lands as a
  // create.
  test.setTimeout(300_000);
  const temp = await createTempWorkspace();
  const workspaceId = "share-file-ops-e2e";
  let relay: SyncRelayHandle | null = null;
  let desktop: Awaited<ReturnType<typeof launchDesktopApp>> | null = null;
  const IMPORTED = "The imported ledger.\n";

  try {
    relay = await spawnSyncRelay({ dbPath: join(temp.baseDir, "relay.sqlite") });
    await claimRelayWorkspace({ baseUrl: relay.baseUrl, token: GRANTER_TOKEN, workspaceId });
    const granter = new RelayFilePeer({
      baseUrl: relay.baseUrl,
      token: GRANTER_TOKEN,
      workspaceId,
    });
    const [renameSource, deleteSource] = await granter.writeTextFiles([
      { path: "docs/rename-me.md", text: "# Rename me\n" },
      { path: "docs/delete-me.md", text: "# Delete me\n" },
      { path: "private/hidden.md", text: "The kraken ledger stays private.\n" },
    ]);

    const create = await relayJson(relay.baseUrl, GRANTER_TOKEN, `/sync/${workspaceId}/shares`, {
      method: "POST",
      body: JSON.stringify({
        recipientEmail: RECIPIENT_EMAIL,
        paths: ["docs"],
        access: "edit",
      }),
    });
    expect(create.status).toBe(200);
    const shareId = (JSON.parse(create.body) as { shareId: string }).shareId;

    // The import's source lives OUTSIDE the share view, where a user's own
    // files are. The picker is replaced by its test seam; the bytes are real.
    const importSource = join(temp.baseDir, "ledger.md");
    await writeFile(importSource, IMPORTED, "utf8");

    await seedCloudCredentials(temp, {
      serverUrl: relay.baseUrl,
      relayUrl: relay.baseUrl,
      email: RECIPIENT_EMAIL,
      userId: "e2e-recipient",
      token: RECIPIENT_TOKEN,
    });
    desktop = await launchDesktopApp({ workspace: temp });
    const page = desktop.page;

    await page.getByTestId("first-run-open-share").click();
    await expect(page.getByTestId("open-shared-view")).toBeVisible();
    await page.getByTestId("open-share-code").fill(`dohc-share:${shareId}:${relay.baseUrl}`);
    await page.getByTestId("open-share-choose-folder").click();
    await expect(page.getByTestId("open-shared-view")).toContainText(temp.rootPath);
    await page.getByTestId("open-share-start").click();
    await expect(page.getByTestId("workspace-shell")).toBeVisible();
    await expect(page.getByTestId("shared-view-banner")).toContainText("send your changes");

    // The four operations, each through the IPC boundary main owns.
    await desktop.app.evaluate((_electron, paths: string[]) => {
      process.env.DOHC_TEST_IMPORT_PATHS = JSON.stringify(paths);
    }, [importSource]);

    const outcome = await page.evaluate(async () => {
      const api = (
        window as unknown as {
          dohcDesktop: Pick<
            DohcDesktopBridge,
            | "getWorkspaceRegistry"
            | "createWorkspaceFile"
            | "moveWorkspacePath"
            | "deleteWorkspacePath"
            | "importWorkspaceFiles"
            | "createWorkspaceFolder"
          >;
        }
      ).dohcDesktop;
      const workspaceId = (await api.getWorkspaceRegistry()).workspaces[0]!.workspaceId;
      const attempt = async (label: string, run: () => Promise<unknown>) => {
        try {
          await run();
          return `${label}: ok`;
        } catch (error) {
          return `${label}: ${error instanceof Error ? error.message : String(error)}`;
        }
      };
      return [
        await attempt("create", () =>
          api.createWorkspaceFile({
            workspaceId,
            relativePath: "docs/created.md",
            initialText: "# Created by the recipient\n",
          }),
        ),
        await attempt("rename", () =>
          api.moveWorkspacePath({
            workspaceId,
            fromPath: "docs/rename-me.md",
            toPath: "docs/renamed.md",
          }),
        ),
        await attempt("delete", () =>
          api.deleteWorkspacePath({ workspaceId, relativePath: "docs/delete-me.md" }),
        ),
        await attempt("import", () =>
          api.importWorkspaceFiles({ workspaceId, targetDir: "docs" }),
        ),
        // The one operation that stays refused at EVERY level, because the
        // engine has no folder object for it to write.
        await attempt("folder", () =>
          api.createWorkspaceFolder({ workspaceId, relativePath: "docs/plans" }),
        ),
      ];
    });
    expect(outcome.slice(0, 4)).toEqual([
      "create: ok",
      "rename: ok",
      "delete: ok",
      "import: ok",
    ]);
    expect(
      outcome[4],
      "MUTATION: routing create-folder promises a change no moment can state",
    ).toContain("shared view");

    // Each landed in the projection, because the projection follows the
    // moment that made it.
    expect(existsSync(join(temp.rootPath, "docs", "created.md"))).toBe(true);
    expect(existsSync(join(temp.rootPath, "docs", "renamed.md"))).toBe(true);
    expect(existsSync(join(temp.rootPath, "docs", "rename-me.md"))).toBe(false);
    expect(existsSync(join(temp.rootPath, "docs", "delete-me.md"))).toBe(false);
    expect(await readFile(join(temp.rootPath, "docs", "ledger.md"), "utf8")).toBe(IMPORTED);

    await expect
      .poll(
        async () =>
          await page.evaluate(async () => {
            const api = (
              window as unknown as {
                dohcDesktop: Pick<
                  DohcDesktopBridge,
                  "getWorkspaceRegistry" | "submitShareChanges"
                >;
              }
            ).dohcDesktop;
            const workspaceId = (await api.getWorkspaceRegistry()).workspaces[0]!.workspaceId;
            try {
              const result = await api.submitShareChanges({ workspaceId });
              if (!result.ok) throw new Error(result.errorMessage);
              return result.submitted;
            } catch (error) {
              return error instanceof Error ? error.message : String(error);
            }
          }),
        { timeout: 120_000, intervals: [2_000] },
      )
      // FOUR changes in one submit: `submitted` counts the files this press
      // sent, and one press sends everything pending.
      .toBe(4);

    // ONE proposal holding FOUR net changes — one per object, which is what
    // the submit consolidates to.
    const { summary, proposal } = await openOnlyProposal(relay.baseUrl, workspaceId);
    expect(summary.ops).toBe(4);
    const proposalId = summary.proposalId;
    const ops = (proposal.ops as Array<{ afterPath: string | null }>).sort((left, right) =>
      String(left.afterPath).localeCompare(String(right.afterPath)),
    );
    expect(ops.length).toBe(4);
    // The review shows WHERE each change lands, per the intent rule.
    expect(ops.map((op) => op.afterPath)).toEqual([
      "docs/created.md",
      "docs/delete-me.md",
      "docs/ledger.md",
      "docs/renamed.md",
    ]);

    const accepted = await relayJson(
      relay.baseUrl,
      GRANTER_TOKEN,
      `/sync/${workspaceId}/proposals/${proposalId}/accept`,
      { method: "POST" },
    );
    expect(accepted.status, accepted.body).toBe(200);

    // The proof: four moments in the GRANTER's log, each carrying the intent
    // the accept door derived from the granter's own current path.
    const afterAccept = await relayJson(
      relay.baseUrl,
      GRANTER_TOKEN,
      `/sync/${workspaceId}/log?since=0&limit=500`,
    );
    const landed = (
      JSON.parse(afterAccept.body) as {
        ops: Array<{ originId: string; opKind: string; payload: Record<string, unknown> }>;
      }
    ).ops.filter(
      (op) => op.originId.startsWith(`share:${shareId}:`) && op.opKind === "moment.append",
    );
    expect(landed.length).toBe(4);
    const byPath = new Map(
      landed.map((op) => [
        String(op.payload.payloadAfterPath ?? op.payload.payloadBeforePath),
        op.payload,
      ]),
    );

    // A create: no base in the granter's log, because the granter never had it.
    const created = byPath.get("docs/created.md");
    expect(created, "the recipient's new file must reach the granter").toBeTruthy();
    expect(created!.operation).toBe("write");
    expect(created!.beforeLatestMomentId ?? null).toBe(null);

    // A rename: the granter's OWN object, moved to the path the recipient
    // meant — the intent rule, not the path the recipient read.
    const renamed = byPath.get("docs/renamed.md");
    expect(renamed, "the recipient's rename must reach the granter").toBeTruthy();
    expect(
      renamed!.operation,
      "MUTATION: a rename that lands as a write leaves the granter holding both paths",
    ).toBe("rename");
    expect(renamed!.objectId).toBe(renameSource!.objectId);
    expect(renamed!.beforeLatestMomentId).toBe(renameSource!.latestMomentId);
    expect(renamed!.payloadBeforePath).toBe("docs/rename-me.md");

    // A delete: at the path the granter has it now.
    const deleted = byPath.get("docs/delete-me.md");
    expect(deleted, "the recipient's delete must reach the granter").toBeTruthy();
    expect(
      deleted!.operation,
      "MUTATION: a delete that lands as a write resurrects the file",
    ).toBe("delete");
    expect(deleted!.objectId).toBe(deleteSource!.objectId);
    expect(deleted!.beforeLatestMomentId).toBe(deleteSource!.latestMomentId);

    // An import: a create carrying the bytes, which the granter can read out
    // of its own workspace.
    const imported = byPath.get("docs/ledger.md");
    expect(imported, "the recipient's import must reach the granter").toBeTruthy();
    expect(imported!.operation).toBe("write");
    const blob = await relayJson(
      relay.baseUrl,
      GRANTER_TOKEN,
      `/sync/${workspaceId}/blobs/${String(imported!.payloadAfterBlobSha256)}`,
    );
    expect(blob.status).toBe(200);
    expect(blob.body).toBe(IMPORTED);
  } finally {
    await relay?.stop();
    if (desktop) await cleanupDesktopWorkspace(desktop, temp);
    else await temp.cleanup();
  }
});
