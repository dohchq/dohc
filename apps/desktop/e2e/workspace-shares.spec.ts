import { expect, test } from "@playwright/test";
import { createHash, randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { DohcDesktopBridge } from "../src/ipc/bridgeContract";
import { RelayFilePeer } from "../src/testing/relayFilePeer";
import { withEngineDb } from "./helpers/engineDb";
import { claimRelayWorkspace, relayJson } from "./helpers/relayPeer";
import { launchDesktopApp } from "./helpers/desktopApp";
import {
  relayAdoptedIdentity,
  spawnSyncRelay,
  type RelayWorkspaceIdentity,
  type SyncRelayHandle,
} from "./helpers/syncRelay";
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

// External shares on the rebuilt cloud. Two real relay accounts
// (the test-auth seam mints identity from the bearer token, and resolves
// "<user>@dohc.test" emails to "<user>"), one real Electron app, and a
// test-only relay protocol peer as the other party.
//
// Spec 1 (grant side): the app user shares a file by email from the
//   explorer context menu, gets a copyable share code, manages it under
//   Settings → Sync and sharing, and ends it — after which the recipient's relay
//   access is a byte-identical 404.
// Spec 2 (receive side, the full loop): grant → open the share in the app
//   → browse/search the read-only view → granter edits → refresh sees it →
//   revoke → refresh surfaces "this share was ended" honestly.

const GRANTER_TOKEN = "test:e2e-granter";
const UNUSED_CONTENT_HASH = "0".repeat(64);
const RECIPIENT_TOKEN = "test:e2e-recipient";
const RECIPIENT_EMAIL = "e2e-recipient@dohc.test";

type RawRelayResponse = { status: number; body: string };

function receivedShareGenericChatRows(rootPath: string): {
  storedRows: number;
  replicationRows: number;
} | null {
  return withEngineDb(rootPath, (db) => {
    const storedRows = [
      "chat_threads",
      "chat_messages",
      "chat_attachments",
      "chat_decisions",
      "chat_reactions",
    ].reduce((total, table) => {
      const row = db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as
        | { n: number }
        | undefined;
      return total + Number(row?.n ?? 0);
    }, 0);
    const replication = db
      .prepare("SELECT COUNT(*) AS n FROM replication_log WHERE op_kind LIKE 'chat.%'")
      .get() as { n: number } | undefined;
    return {
      storedRows,
      replicationRows: Number(replication?.n ?? 0),
    };
  });
}

async function publicRelayRequest(
  baseUrl: string,
  path: string,
  init: RequestInit,
): Promise<RawRelayResponse> {
  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    signal: AbortSignal.timeout(15_000),
  });
  return { status: response.status, body: await response.text() };
}

async function exchangeViewLink(
  baseUrl: string,
  relayExchangeKey: string,
  secret: string,
): Promise<RawRelayResponse> {
  return publicRelayRequest(baseUrl, "/sync/link-exchange", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-dohc-relay-exchange-key": relayExchangeKey,
    },
    body: JSON.stringify({ secret }),
  });
}

async function readViewLink(
  baseUrl: string,
  capability: string,
  path: string,
): Promise<RawRelayResponse> {
  return publicRelayRequest(baseUrl, path, {
    method: "GET",
    headers: { authorization: `LinkCapability ${capability}` },
  });
}

async function mintLinkHandoff(
  baseUrl: string,
  relayExchangeKey: string,
  capability: string,
): Promise<RawRelayResponse> {
  return publicRelayRequest(baseUrl, "/sync/link-handoff", {
    method: "POST",
    headers: {
      authorization: `LinkCapability ${capability}`,
      "x-dohc-relay-exchange-key": relayExchangeKey,
    },
  });
}

// The granter's only open proposal, listed then opened — the shape the
// granter's own review takes. The listing is a summary; its count is
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

    // Settings → Sync and sharing → "Shared by me": the grant is listed and endable.
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

const confidentialTest = test.extend({});
confidentialTest.use({ screenshot: "off", trace: "off" });

confidentialTest.describe("View link lifecycle", () => {
  // A failed lifecycle run must not retain its one-time URL in Playwright
  // diagnostics. The assertions below report only status, copy, and UI state.
  confidentialTest("creates, resets, and ends a link while dependent named access follows the warnings", async () => {
    confidentialTest.setTimeout(300_000);
    const temp = await createTempWorkspace();
    const workspaceId = "share-view-link-lifecycle-e2e";
    const selectedText = "# Shared\n\nThe lantern route.\n";
    const privateText = "The private harbor ledger stays private.\n";
    const linkKey = randomBytes(32).toString("base64url");
    const relayExchangeKey = randomBytes(32).toString("base64url");
    const publicViewerOrigin = "http://127.0.0.1:4173";
    const neverValidCredential = "A".repeat(43);
    let relay: SyncRelayHandle | null = null;
    let desktop: Awaited<ReturnType<typeof launchDesktopApp>> | null = null;

    try {
      await seedWorkspaceManifest(temp, workspaceId);
      await writeWorkspaceFiles(temp, [
        { path: "docs/shared.md", contents: selectedText },
        { path: "private/hidden.md", contents: privateText },
      ]);

      relay = await spawnSyncRelay({
        dbPath: join(temp.baseDir, "relay.sqlite"),
        linkBoundary: { linkKey, relayExchangeKey, publicViewerOrigin },
      });
      await claimRelayWorkspace({ baseUrl: relay.baseUrl, token: GRANTER_TOKEN, workspaceId });
      await seedWorkspaceRegistry(temp, [
        {
          workspaceId,
          rootPath: temp.rootPath,
          remote: {
            serverUrl: relay.baseUrl,
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
          DOHC_TEST_EXPLORER_MENU_CHOICE: "share",
        },
      });
      const page = desktop.page;
      await openWorkspaceFromFirstRun(page, temp);

      // The walkthrough starts only after both selected and private local
      // files reached the owned relay workspace.
      let identity: RelayWorkspaceIdentity | null = null;
      await expect
        .poll(
          async () => {
            identity ??= relayAdoptedIdentity(relay!.dbPath, workspaceId);
            if (identity === null) return false;
            const query = new URLSearchParams({
              since: "0",
              limit: "500",
              replicationEpoch: identity.replicationEpoch,
              streamIdentity: identity.streamIdentity,
            });
            const response = await fetch(
              `${relay!.baseUrl}/sync/${encodeURIComponent(workspaceId)}/log?${query.toString()}`,
              { headers: { authorization: `Bearer ${GRANTER_TOKEN}` } },
            );
            if (response.status === 409) {
              identity = null;
              return false;
            }
            if (!response.ok) return false;
            const body = (await response.json()) as {
              ops: Array<{ payload?: { path?: string; payloadAfterPath?: string } }>;
            };
            const paths = body.ops.flatMap((op) => [
              op.payload?.path,
              op.payload?.payloadAfterPath,
            ]);
            return paths.includes("docs/shared.md") && paths.includes("private/hidden.md");
          },
          { timeout: 90_000, intervals: [1_000] },
        )
        .toBe(true);

      await revealExplorerPath(page, "docs/shared.md");
      await explorerRow(page, "docs/shared.md").click({ button: "right" });
      let dialog = page.getByTestId("share-dialog");
      await expect(dialog).toBeVisible();
      await expect(dialog).toContainText("docs/shared.md");

      const linkScope = dialog.getByRole("radio", { name: "Anyone with the link" });
      await linkScope.click();
      await expect(linkScope).toHaveAttribute("aria-checked", "true");
      const linkAccess = dialog.getByRole("radiogroup", { name: "Link access" });
      await expect(
        linkAccess.getByRole("radio", { name: "Comment", exact: true }),
      ).toBeVisible();
      await expect(
        linkAccess.getByRole("radio", { name: "View", exact: true }),
      ).toBeVisible();
      await expect(dialog).toContainText(
        "If files are added to this selection later, the link includes them.",
      );
      await expect(dialog).toContainText(
        "The sync relay serves the link, so it can read this content.",
      );
      await expect(dialog).toContainText(
        "Ending it stops future access, but can't take back copies people already made.",
      );

      await dialog.getByRole("button", { name: "Create link", exact: true }).click();
      const oneTimeUrl = await dialog.getByTestId("share-link-url").textContent();
      if (oneTimeUrl === null) throw new Error("The Share dialog did not expose the link.");
      const oldUrl = new URL(oneTimeUrl);
      expect(oldUrl.origin === publicViewerOrigin).toBe(true);
      const oldSecret = oldUrl.hash.slice(1);
      expect(/^[A-Za-z0-9_-]{43}$/u.test(oldSecret)).toBe(true);
      const copyButton = dialog.getByRole("button", { name: "Copy", exact: true });
      await copyButton.click();
      await expect(dialog.getByRole("button", { name: "Copied", exact: true })).toBeVisible();

      const firstExchange = await exchangeViewLink(
        relay.baseUrl,
        relayExchangeKey,
        oldSecret,
      );
      expect(firstExchange.status).toBe(200);
      const exchanged = JSON.parse(firstExchange.body) as {
        shareId?: unknown;
        grantId?: unknown;
        access?: unknown;
        capabilityToken?: unknown;
      };
      if (
        typeof exchanged.shareId !== "string" ||
        typeof exchanged.grantId !== "string" ||
        typeof exchanged.capabilityToken !== "string"
      ) {
        throw new Error("The relay returned an incomplete View link exchange.");
      }
      expect(exchanged.access).toBe("view");
      const shareId = exchanged.shareId;
      const linkGrantId = exchanged.grantId;
      const oldCapability = exchanged.capabilityToken;

      const shippedRoute = await readViewLink(
        relay.baseUrl,
        oldCapability,
        "/sync/link/share",
      );
      expect(shippedRoute.status).toBe(200);
      const shippedShare = JSON.parse(shippedRoute.body) as {
        access?: unknown;
        effectiveSelector?: { paths?: unknown };
      };
      expect(shippedShare.access).toBe("view");
      expect(shippedShare.effectiveSelector?.paths).toEqual(["shared.md"]);

      const linkLogResponse = await readViewLink(
        relay.baseUrl,
        oldCapability,
        "/sync/link/log?since=0&limit=500",
      );
      expect(linkLogResponse.status).toBe(200);
      const linkLog = JSON.parse(linkLogResponse.body) as {
        ops?: Array<{ opKind?: unknown; payload?: Record<string, unknown> }>;
      };
      const selectedOp = linkLog.ops?.find(
        (op) =>
          op.opKind === "moment.append" &&
          (op.payload?.payloadAfterPath === "shared.md" || op.payload?.path === "shared.md"),
      );
      if (selectedOp === undefined) {
        throw new Error("The shipped link log did not include the selected file.");
      }
      const selectedDigest = selectedOp.payload?.payloadAfterBlobSha256;
      if (typeof selectedDigest !== "string") {
        throw new Error("The selected file operation did not name its content.");
      }
      expect(JSON.stringify(linkLog).includes("hidden.md")).toBe(false);
      const selectedBlob = await readViewLink(
        relay.baseUrl,
        oldCapability,
        `/sync/link/blobs/${selectedDigest}`,
      );
      expect(selectedBlob.status).toBe(200);
      expect(selectedBlob.body).toBe(selectedText);
      const privateDigest = createHash("sha256").update(privateText).digest("hex");
      const privateBlob = await readViewLink(
        relay.baseUrl,
        oldCapability,
        `/sync/link/blobs/${privateDigest}`,
      );
      expect(privateBlob.status).toBe(404);

      const handoffResponse = await mintLinkHandoff(
        relay.baseUrl,
        relayExchangeKey,
        oldCapability,
      );
      expect(handoffResponse.status).toBe(200);
      const handoff = JSON.parse(handoffResponse.body) as { code?: unknown };
      if (typeof handoff.code !== "string") {
        throw new Error("The relay did not mint a handoff code.");
      }
      const redeemed = await relayJson(relay.baseUrl, RECIPIENT_TOKEN, "/sync/link-redeem", {
        method: "POST",
        body: JSON.stringify({ code: handoff.code }),
      });
      expect(redeemed.status).toBe(200);
      const namedGrant = JSON.parse(redeemed.body) as {
        shareId?: unknown;
        grantId?: unknown;
        access?: unknown;
      };
      expect(namedGrant.shareId === shareId).toBe(true);
      expect(typeof namedGrant.grantId === "string").toBe(true);
      expect(namedGrant.access).toBe("view");
      const namedBeforeReset = await relayJson(
        relay.baseUrl,
        RECIPIENT_TOKEN,
        `/sync/shares/${shareId}/log?since=0&limit=500`,
      );
      expect(namedBeforeReset.status).toBe(200);
      expect(namedBeforeReset.body.includes("docs/shared.md")).toBe(true);
      expect(namedBeforeReset.body.includes("private/hidden.md")).toBe(false);

      await dialog.getByRole("button", { name: "Close" }).click();
      await expect(dialog).not.toBeVisible();
      await explorerRow(page, "docs/shared.md").click({ button: "right" });
      dialog = page.getByTestId("share-dialog");
      await expect(dialog).toBeVisible();
      await dialog.getByRole("radio", { name: "Anyone with the link" }).click();
      const linkRows = dialog.locator('article[data-testid^="share-link-row-"]');
      await expect(linkRows).toHaveCount(1);
      const linkRow = linkRows.first();
      const linkRowTestId = await linkRow.getAttribute("data-testid");
      expect(linkRowTestId === `share-link-row-${linkGrantId}`).toBe(true);
      await expect(linkRow).toContainText("Used as recently as");
      await expect(
        linkAccess.getByRole("radio", { name: "Comment", exact: true }),
      ).toBeVisible();
      await expect(
        linkAccess.getByRole("radio", { name: "View", exact: true }),
      ).toBeVisible();
      const reachableRetuneTargets = await dialog
        .getByRole("button", { name: /^(?:View|Comment|Edit)$/u })
        .allTextContents();
      expect(reachableRetuneTargets).toEqual([]);

      await linkRow.getByRole("button", { name: "Reset link" }).click();
      let confirmation = dialog.getByTestId("share-link-confirmation");
      await expect(confirmation).toContainText(RECIPIENT_EMAIL);
      await expect(confirmation).toContainText("keep access");
      await confirmation.getByRole("button", { name: "Cancel" }).click();
      await expect(confirmation).not.toBeVisible();
      const afterResetCancel = await exchangeViewLink(
        relay.baseUrl,
        relayExchangeKey,
        oldSecret,
      );
      expect(afterResetCancel.status).toBe(200);
      const afterResetCancelBody = JSON.parse(afterResetCancel.body) as {
        capabilityToken?: unknown;
      };
      if (typeof afterResetCancelBody.capabilityToken !== "string") {
        throw new Error("The canceled reset left no usable link exchange.");
      }
      expect(
        (
          await readViewLink(
            relay.baseUrl,
            afterResetCancelBody.capabilityToken,
            "/sync/link/share",
          )
        ).status,
      ).toBe(200);

      await linkRow.getByRole("button", { name: "Reset link" }).click();
      confirmation = dialog.getByTestId("share-link-confirmation");
      await confirmation.getByRole("button", { name: "Reset link" }).click();
      const resetUrlText = await dialog.getByTestId("share-link-url").textContent();
      if (resetUrlText === null) throw new Error("Reset did not expose the replacement link.");
      const resetUrl = new URL(resetUrlText);
      const currentSecret = resetUrl.hash.slice(1);
      expect(resetUrl.origin === publicViewerOrigin).toBe(true);
      expect(/^[A-Za-z0-9_-]{43}$/u.test(currentSecret)).toBe(true);
      expect(currentSecret === oldSecret).toBe(false);

      const neverValidExchange = await exchangeViewLink(
        relay.baseUrl,
        relayExchangeKey,
        neverValidCredential,
      );
      expect(neverValidExchange.status).toBe(404);
      const oldSecretAfterReset = await exchangeViewLink(
        relay.baseUrl,
        relayExchangeKey,
        oldSecret,
      );
      expect(oldSecretAfterReset).toEqual(neverValidExchange);
      const neverValidRead = await readViewLink(
        relay.baseUrl,
        neverValidCredential,
        "/sync/link/share",
      );
      expect(neverValidRead.status).toBe(401);
      const oldCapabilityAfterReset = await readViewLink(
        relay.baseUrl,
        oldCapability,
        "/sync/link/share",
      );
      expect(oldCapabilityAfterReset).toEqual(neverValidRead);

      const currentExchange = await exchangeViewLink(
        relay.baseUrl,
        relayExchangeKey,
        currentSecret,
      );
      expect(currentExchange.status).toBe(200);
      const currentExchangeBody = JSON.parse(currentExchange.body) as {
        capabilityToken?: unknown;
      };
      if (typeof currentExchangeBody.capabilityToken !== "string") {
        throw new Error("The replacement link exchange was incomplete.");
      }
      const currentCapability = currentExchangeBody.capabilityToken;
      const namedAfterReset = await relayJson(
        relay.baseUrl,
        RECIPIENT_TOKEN,
        `/sync/shares/${shareId}/log?since=0&limit=500`,
      );
      expect(namedAfterReset.status).toBe(200);

      await linkRow.getByRole("button", { name: "End link" }).click();
      confirmation = dialog.getByTestId("share-link-confirmation");
      await expect(confirmation).toContainText(RECIPIENT_EMAIL);
      await expect(confirmation).toContainText("lose access");
      await expect(confirmation).toContainText("Copies they already made stay with them.");
      await confirmation.getByRole("button", { name: "Cancel" }).click();
      await expect(confirmation).not.toBeVisible();
      expect(
        (await readViewLink(relay.baseUrl, currentCapability, "/sync/link/share"))
          .status,
      ).toBe(200);
      expect(
        (
          await relayJson(
            relay.baseUrl,
            RECIPIENT_TOKEN,
            `/sync/shares/${shareId}/log?since=0&limit=500`,
          )
        ).status,
      ).toBe(200);

      await linkRow.getByRole("button", { name: "End link" }).click();
      confirmation = dialog.getByTestId("share-link-confirmation");
      await confirmation.getByRole("button", { name: "End link" }).click();
      await expect(confirmation).not.toBeVisible();
      await expect(linkRow).toContainText("Ended");

      const currentSecretAfterEnd = await exchangeViewLink(
        relay.baseUrl,
        relayExchangeKey,
        currentSecret,
      );
      expect(currentSecretAfterEnd).toEqual(neverValidExchange);
      const currentCapabilityAfterEnd = await readViewLink(
        relay.baseUrl,
        currentCapability,
        "/sync/link/share",
      );
      expect(currentCapabilityAfterEnd).toEqual(neverValidRead);
      const namedAfterEnd = await relayJson(
        relay.baseUrl,
        RECIPIENT_TOKEN,
        `/sync/shares/${shareId}/log?since=0&limit=500`,
      );
      const missingNamedShare = await relayJson(
        relay.baseUrl,
        RECIPIENT_TOKEN,
        "/sync/shares/never-valid/log?since=0&limit=500",
      );
      expect(missingNamedShare.status).toBe(404);
      expect(namedAfterEnd).toEqual(missingNamedShare);
    } finally {
      await relay?.stop();
      if (desktop) await cleanupDesktopWorkspace(desktop, temp);
      else await temp.cleanup();
    }
  });
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

    // The shared view opens: banner, shared files, and not the private one.
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
    // seam rather than by the workspace-wide gate, so a VIEW share
    // is refused there by the shared-file rule. Every other write handler
    // below still meets the workspace gate and its wording.
    expect(writeAttempt).toContain("SharedFileReadOnlyError");
    expect(writeAttempt).toContain("This shared view is read-only for you.");

    // The other three mutation side-doors are refused at the IPC boundary too:
    // a managed agent run, a code-executing site preview, and a write-capable
    // MCP config. All route through the same shared-view guard.
    //
    // Snapshot the materialized shared file before the bypass so the engine
    // Y.Doc apply attempt can be proven inert — not merely non-throwing.
    const sharedFilePath = join(temp.rootPath, "docs/shared.md");
    const originalSharedContents = await readFile(sharedFilePath, "utf8");
    const bypassAttempts = await page.evaluate(async () => {
      const api = (window as unknown as {
        dohcDesktop: {
          getWorkspaceRegistry(): Promise<{ workspaces: Array<{ workspaceId: string }> }>;
          startAgentRun(payload: { workspaceId: string }): Promise<unknown>;
          startSitePreview: DohcDesktopBridge["startSitePreview"];
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
        api.startSitePreview({ workspaceId, siteRoot: "docs", mode: "dev", holderId: "e2e", restart: false }),
      );
      const mcp = await api.getMcpConfig({ workspaceId });
      // WS-G2-C-2 gate fix 4: a live engine Y.Doc session is writable, so opening
      // one in a read-only shared view must be refused at the IPC boundary (same
      // class as the write bypass above). applyEngineYDocUpdate on the refused
      // session must be an inert no-op — it must never throw and never write.
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
          // Typing this from the contract surfaced a second drift the
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
    // never landed: the materialized shared file on disk is byte-for-byte
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
      { method: "POST" },
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

test("mount side: add a share into a workspace and open it beside local files", async () => {
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
      { path: "reviews/draft.md", text: "# Draft\n\nOpen for comments.\n" },
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
    const commentCreate = await relayJson(
      relay.baseUrl,
      GRANTER_TOKEN,
      `/sync/${granterWorkspaceId}/shares`,
      {
        method: "POST",
        body: JSON.stringify({ recipientEmail: RECIPIENT_EMAIL, paths: ["reviews"], access: "comment" }),
      },
    );
    expect(commentCreate.status).toBe(200);
    const commentShareId = (JSON.parse(commentCreate.body) as { shareId: string }).shareId;

    // The recipient's ordinary workspace (the mount host) with its own files.
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

    // Open waits for the relay to state the grant. View and Comment codes
    // then keep Add to this workspace.
    for (const code of [`dohc-share:${commentShareId}:${relay.baseUrl}`, shareCode]) {
      await page.getByTestId("open-share-code").fill(code);
      await expect(page.getByTestId("open-share-start")).toHaveText("Add share");
      await expect(page.getByTestId("open-share-start")).toBeEnabled();
      await expect(page.getByTestId("open-share-mode-mount")).toHaveAttribute(
        "aria-checked",
        "true",
      );
    }
    await page.getByTestId("open-share-start").click();

    // The mount lands: a toast, tree rows under shared-with-me/e2e-granter,
    // the private file never crosses, and the host file is untouched.
    await expect(page.getByTestId("workspace-shell-notice")).toContainText(
      "Added e2e-granter to shared-with-me. Its files are read-only and stay up to date.",
    );
    await revealExplorerPath(page, "shared-with-me/e2e-granter/docs/brief.md");
    await expect(explorerRow(page, "shared-with-me/e2e-granter/private")).toHaveCount(0);
    await revealExplorerPath(page, "notes/mine.md");

    // The mounted file opens read-only with the granter's content.
    await explorerRow(page, "shared-with-me/e2e-granter/docs/brief.md").click();
    await expect(page.getByText("The lighthouse memo.")).toBeVisible();
  } finally {
    await relay?.stop();
    if (desktop) await cleanupDesktopWorkspace(desktop, temp);
    else await temp.cleanup();
  }
});

test("mount side: an Edit code opens separately by default, and added to a workspace it says how to edit", async () => {
  test.setTimeout(300_000);
  const temp = await createTempWorkspace();
  const hostWorkspaceId = "share-mount-edit-host-e2e";
  const granterWorkspaceId = "share-mount-edit-granter-e2e";
  let relay: SyncRelayHandle | null = null;
  let desktop: Awaited<ReturnType<typeof launchDesktopApp>> | null = null;

  try {
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
    ]);
    const create = await relayJson(
      relay.baseUrl,
      GRANTER_TOKEN,
      `/sync/${granterWorkspaceId}/shares`,
      {
        method: "POST",
        body: JSON.stringify({ recipientEmail: RECIPIENT_EMAIL, paths: ["docs"], access: "edit" }),
      },
    );
    expect(create.status).toBe(200);
    const shareId = (JSON.parse(create.body) as { shareId: string }).shareId;
    const shareCode = `dohc-share:${shareId}:${relay.baseUrl}`;

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

    // Once the relay states the grant, an Edit code defaults to Open
    // separately. This person chooses Add to this workspace anyway.
    await page.getByTestId("workspace-switcher").click();
    await page.getByTestId("workspace-switcher-open-share").click();
    await page.getByTestId("open-share-code").fill(shareCode);
    await expect(page.getByTestId("open-share-mode-separate")).toHaveAttribute(
      "aria-checked",
      "true",
    );
    await page.getByTestId("open-share-mode-mount").click();
    await expect(page.getByTestId("open-share-start")).toHaveText("Add share");
    await page.getByTestId("open-share-start").click();
    // The message arrives as a toast, not a bar across the workbench, and
    // says where Edit works.
    await expect(page.getByTestId("workspace-shell-notice")).toContainText(
      "Added e2e-granter to shared-with-me. Its files are read-only in this workspace. To use your Edit access, choose Open a share, then Open separately.",
    );
    await expect(page.getByTestId("shell-notice")).toHaveCount(0);
    await revealExplorerPath(page, "shared-with-me/e2e-granter/docs/brief.md");

    // Read-only is true: the file does not open for editing, and main refuses
    // both a write and a send from the host workspace.
    await explorerRow(page, "shared-with-me/e2e-granter/docs/brief.md").click();
    await expect(page.getByText("The lighthouse memo.")).toBeVisible();
    await expect(page.getByTestId("markdown-edit-toggle")).toBeDisabled();
    const refused = await page.evaluate(async () => {
      const api = (window as unknown as {
        dohcDesktop: Pick<
          DohcDesktopBridge,
          "getWorkspaceRegistry" | "readWorkspaceText" | "writeWorkspaceText" | "submitShareChanges"
        >;
      }).dohcDesktop;
      const workspaceId = (await api.getWorkspaceRegistry()).workspaces[0]!.workspaceId;
      const relativePath = "shared-with-me/e2e-granter/docs/brief.md";
      const message = (error: unknown) => (error instanceof Error ? error.message : String(error));
      let write = "written";
      try {
        const read = await api.readWorkspaceText({ workspaceId, relativePath });
        if (read.truncated) throw new Error("the mounted file read back truncated");
        await api.writeWorkspaceText({
          workspaceId,
          relativePath,
          text: "# Brief\n\nEdited in the mount.\n",
          expectedContentHash: read.contentHash,
        });
      } catch (error) {
        write = message(error);
      }
      let submit = "submitted";
      try {
        await api.submitShareChanges({ workspaceId });
      } catch (error) {
        submit = message(error);
      }
      return { write, submit };
    });
    expect(refused.write).toContain("reserved");
    expect(refused.submit).toContain("This workspace is not a shared view.");

    // Pasted again with the defaults, the code opens the live-editing view
    // with Send changes.
    await page.getByTestId("workspace-switcher").click();
    await page.getByTestId("workspace-switcher-open-share").click();
    await page.getByTestId("open-share-code").fill(shareCode);
    await expect(page.getByTestId("open-share-mode-separate")).toHaveAttribute(
      "aria-checked",
      "true",
    );
    await expect(page.getByTestId("open-share-start")).toHaveText("Open share");
    await expect(page.getByTestId("open-share-start")).toBeEnabled();
    await page.getByTestId("open-share-start").click();
    await expect(page.getByTestId("shared-view-banner")).toContainText(
      "Markdown edits save to the live host.",
    );
    await expect(page.getByTestId("share-changes-send")).toBeVisible();
  } finally {
    await relay?.stop();
    if (desktop) await cleanupDesktopWorkspace(desktop, temp);
    else await temp.cleanup();
  }
});

test("Comment handoff opens files without creating a second generic chat", async () => {
  test.setTimeout(240_000);
  const temp = await createTempWorkspace();
  const workspaceId = "share-comment-handoff-e2e";
  const linkKey = randomBytes(32).toString("base64url");
  const relayExchangeKey = randomBytes(32).toString("base64url");
  let relay: SyncRelayHandle | null = null;
  let desktop: Awaited<ReturnType<typeof launchDesktopApp>> | null = null;

  try {
    relay = await spawnSyncRelay({
      dbPath: join(temp.baseDir, "relay.sqlite"),
      linkBoundary: {
        linkKey,
        relayExchangeKey,
        publicViewerOrigin: "http://127.0.0.1:4173",
      },
    });
    await claimRelayWorkspace({ baseUrl: relay.baseUrl, token: GRANTER_TOKEN, workspaceId });
    const granter = new RelayFilePeer({
      baseUrl: relay.baseUrl,
      token: GRANTER_TOKEN,
      workspaceId,
    });
    await granter.writeTextFiles([
      { path: "docs/shared.md", text: "# Shared\n\nThe handoff draft.\n" },
    ]);

    const linkResponse = await relayJson(
      relay.baseUrl,
      GRANTER_TOKEN,
      `/sync/${workspaceId}/shares/links`,
      {
        method: "POST",
        body: JSON.stringify({ paths: ["docs"], access: "comment" }),
      },
    );
    expect(linkResponse.status).toBe(200);
    const link = JSON.parse(linkResponse.body) as {
      shareId?: unknown;
      url?: unknown;
    };
    if (typeof link.shareId !== "string" || typeof link.url !== "string") {
      throw new Error("The relay returned an incomplete Comment link.");
    }
    const secret = new URL(link.url).hash.slice(1);
    const exchanged = await exchangeViewLink(
      relay.baseUrl,
      relayExchangeKey,
      secret,
    );
    expect(exchanged.status).toBe(200);
    const capability = (JSON.parse(exchanged.body) as {
      capabilityToken?: unknown;
    }).capabilityToken;
    if (typeof capability !== "string") {
      throw new Error("The relay did not exchange the Comment link.");
    }
    const minted = await mintLinkHandoff(
      relay.baseUrl,
      relayExchangeKey,
      capability,
    );
    expect(minted.status).toBe(200);
    const code = (JSON.parse(minted.body) as { code?: unknown }).code;
    if (typeof code !== "string") {
      throw new Error("The relay did not mint a Comment handoff.");
    }
    const redeemed = await relayJson(
      relay.baseUrl,
      RECIPIENT_TOKEN,
      "/sync/link-redeem",
      { method: "POST", body: JSON.stringify({ code }) },
    );
    expect(redeemed.status).toBe(200);
    expect(JSON.parse(redeemed.body)).toMatchObject({
      shareId: link.shareId,
      access: "comment",
    });

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
    await page.getByTestId("open-share-code").fill(
      `dohc-share:${link.shareId}:${relay.baseUrl}`,
    );
    await page.getByTestId("open-share-choose-folder").click();
    await page.getByTestId("open-share-start").click();
    await expect(page.getByTestId("workspace-shell")).toBeVisible();

    await expect(page.getByTestId("shared-view-banner")).toContainText(
      "Files are read-only here. Continue commenting in the browser where you opened the link.",
    );
    await revealExplorerPath(page, "docs/shared.md");
    await explorerRow(page, "docs/shared.md").click();
    if ((await page.getByTestId("chats-panel").count()) === 0) {
      await page.getByTestId("titlebar-chats-sidebar").click();
    }
    await expect(page.getByTestId("linked-chat-readonly-note")).toBeVisible();
    await expect(page.getByTestId("linked-chat-composer")).toHaveCount(0);

    const generic = await page.evaluate(async () => {
      const api = (window as unknown as {
        dohcDesktop: Pick<
          DohcDesktopBridge,
          "getWorkspaceRegistry" | "createFileChat" | "listFileChats"
        >;
      }).dohcDesktop;
      const workspace = (await api.getWorkspaceRegistry()).workspaces[0]!;
      const workspaceId = workspace.workspaceId;
      let refusal = "answered";
      try {
        await api.createFileChat({
          workspaceId,
          path: "docs/shared.md",
          title: "Must not commit",
        });
      } catch (error) {
        refusal = error instanceof Error ? error.message : String(error);
      }
      const threads = await api.listFileChats({ workspaceId, path: "docs/shared.md" });
      if ("status" in threads) throw new Error(threads.code);
      return {
        refusal,
        threadCount: threads.threads.length,
        rootPath: workspace.rootPath,
      };
    });
    expect(generic.refusal).toContain("read-only");
    expect(generic.threadCount).toBe(0);
    await expect
      .poll(() => receivedShareGenericChatRows(generic.rootPath))
      .toEqual({ storedRows: 0, replicationRows: 0 });

    const granterLog = await relayJson(
      relay.baseUrl,
      GRANTER_TOKEN,
      `/sync/${workspaceId}/log?since=0&limit=500`,
    );
    expect(granterLog.status).toBe(200);
    const pushedGenericRows = (
      JSON.parse(granterLog.body) as {
        ops: Array<{ opKind?: unknown }>;
      }
    ).ops.filter((op) =>
      typeof op.opKind === "string" && op.opKind.startsWith("chat."),
    );
    expect(pushedGenericRows).toEqual([]);
  } finally {
    await relay?.stop();
    if (desktop) await cleanupDesktopWorkspace(desktop, temp);
    else await temp.cleanup();
  }
});

test("direct named Comment keeps desktop generic chat read-only", async () => {
  // A direct named Comment share carries independent relay append authority.
  // Phase 3 keeps generic desktop chat read-only because the local store has
  // no durable per-row relay receipt. The IPC attempt must leave no local row
  // and no chat operation in the granter's relay log.
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

    // The banner preserves the distinction from dependent Comment without
    // promising a desktop write.
    const banner = page.getByTestId("shared-view-banner");
    await expect(banner).toBeVisible();
    await expect(banner).toContainText(
      "Files and Chats are read-only here. Ask e2e-granter@dohc.test where to continue the conversation.",
    );

    await revealExplorerPath(page, "docs/shared.md");
    await explorerRow(page, "docs/shared.md").click();
    if ((await page.getByTestId("chats-panel").count()) === 0) {
      await page.getByTestId("titlebar-chats-sidebar").click();
    }
    await expect(page.getByTestId("linked-chat-readonly-note")).toBeVisible();
    await expect(page.getByTestId("linked-chat-composer")).toHaveCount(0);

    // Call the authorization surface directly. Renderer affordances are not
    // part of this refusal proof.
    const chat = await page.evaluate(async () => {
      const api = (window as unknown as {
        dohcDesktop: Pick<
          DohcDesktopBridge,
          | "getWorkspaceRegistry"
          | "createFileChat"
          | "listFileChats"
          | "listChatChannels"
        >;
      }).dohcDesktop;
      const workspace = (await api.getWorkspaceRegistry()).workspaces[0]!;
      const workspaceId = workspace.workspaceId;
      let refusal = "answered";
      try {
        await api.createFileChat({
          workspaceId,
          path: "docs/shared.md",
          title: "Must not commit",
        });
      } catch (error) {
        refusal = error instanceof Error ? error.message : String(error);
      }
      const threads = await api.listFileChats({ workspaceId, path: "docs/shared.md" });
      if ("status" in threads) throw new Error(threads.code);
      // The workspace-wide listing is not routed to a share view: a share
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
        refusal,
        threadCount: threads.threads.length,
        rootPath: workspace.rootPath,
        channels,
      };
    });
    expect(chat.refusal).toContain("read-only");
    expect(chat.threadCount).toBe(0);
    expect(chat.channels).not.toBe("answered");
    await expect
      .poll(() => receivedShareGenericChatRows(chat.rootPath))
      .toEqual({ storedRows: 0, replicationRows: 0 });

    const granterLog = await relayJson(
      relay.baseUrl,
      GRANTER_TOKEN,
      `/sync/${workspaceId}/log?since=0&limit=500`,
    );
    expect(granterLog.status).toBe(200);
    const pushedGenericRows = (
      JSON.parse(granterLog.body) as { ops: Array<{ opKind?: unknown }> }
    ).ops.filter(
      (op) => typeof op.opKind === "string" && op.opKind.startsWith("chat."),
    );
    expect(pushedGenericRows).toEqual([]);
  } finally {
    await relay?.stop();
    if (desktop) await cleanupDesktopWorkspace(desktop, temp);
    else await temp.cleanup();
  }
});

test("edit side: a recipient edits a shared file, sends the changes, and the granter accepts them", async () => {
  // The whole proposal loop, through the real app and a real
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
    // Who sent them, resolved by the relay from the server-derived user id on
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
  // The other four writes a share view admits, through the real app,
  // the real engine and a real relay. The text edit's loop is proved above;
  // what this proves is that each of these operations becomes a change the
  // submit lane can see, and that the accept door derives the right intent
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
        // The one operation that stays refused at every level, because the
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
      "routing create-folder promises a change no moment can state",
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

    // One proposal holding FOUR net changes — one per object, which is what
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

    // A rename: the granter's own object, moved to the path the recipient
    // meant — the intent rule, not the path the recipient read.
    const renamed = byPath.get("docs/renamed.md");
    expect(renamed, "the recipient's rename must reach the granter").toBeTruthy();
    expect(
      renamed!.operation,
      "a rename that lands as a write leaves the granter holding both paths",
    ).toBe("rename");
    expect(renamed!.objectId).toBe(renameSource!.objectId);
    expect(renamed!.beforeLatestMomentId).toBe(renameSource!.latestMomentId);
    expect(renamed!.payloadBeforePath).toBe("docs/rename-me.md");

    // A delete: at the path the granter has it now.
    const deleted = byPath.get("docs/delete-me.md");
    expect(deleted, "the recipient's delete must reach the granter").toBeTruthy();
    expect(
      deleted!.operation,
      "a delete that lands as a write resurrects the file",
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
