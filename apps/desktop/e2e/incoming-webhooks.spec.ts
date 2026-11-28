import { activityPin, desktopPins, settingsNavPin, settingsSectionPin } from "../src/testPins";
import { expect, test, type Locator, type Page } from "@playwright/test";
import { mkdir, readdir, readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { mintLocalhostCa } from "../../../services/share-web/src/testing/localhostCa";
import { resolveEngineBinary } from "../src/testing/engineBinary";
import { waitForVisibleAnimations } from "./helpers/animations";
import { launchDesktopApp, type LaunchedDesktopApp } from "./helpers/desktopApp";
import { startServerProxy } from "./helpers/selfHostOnboarding";
import { spawnSyncRelay, type SyncRelayHandle } from "./helpers/syncRelay";
import {
  createTempWorkspace,
  openWorkspaceFromFirstRun,
  seedCloudCredentials,
  seedWorkspaceManifest,
  seedWorkspaceRegistry,
} from "./helpers/workspace";

const SHOT_DIR = process.env.PR4_SHOT_DIR ?? "";
const OWNER = "webhooks-e2e-owner";
const SYNCED_WORKSPACE_ID = "ws-webhooks-synced-e2e";

async function setTheme(page: Page, theme: "light" | "dark"): Promise<void> {
  await page.evaluate(async (value) => {
    document.documentElement.setAttribute("data-theme", value);
    void getComputedStyle(document.body).backgroundColor;
    await document.fonts.ready;
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  }, theme);
  await waitForVisibleAnimations(page);
}

async function shoot(page: Page, target: Locator, name: string): Promise<void> {
  if (SHOT_DIR === "") return;
  await mkdir(SHOT_DIR, { recursive: true });
  await page.mouse.move(0, 0);
  for (const theme of ["light", "dark"] as const) {
    await setTheme(page, theme);
    await target.screenshot({ path: join(SHOT_DIR, `${name}-${theme}.png`) });
  }
  await setTheme(page, "light");
}

async function collectFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const results: string[] = [];
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) results.push(...(await collectFiles(full)));
    else if (entry.isFile()) results.push(full);
  }
  return results;
}

async function assertNotInWorkspaceFolder(rootPath: string, needles: readonly string[]) {
  const files = await collectFiles(rootPath);
  for (const file of files) {
    const bytes = await readFile(file);
    for (const needle of needles) {
      expect(bytes.includes(Buffer.from(needle, "utf8")), `${file} must not contain token`).toBe(
        false,
      );
    }
  }
}

async function openSecretsSettings(page: Page) {
  await page.getByTestId(activityPin("settings")).click();
  await expect(page.getByTestId(desktopPins.settingsDialog)).toBeVisible();
  await page.getByTestId(settingsNavPin("secrets")).click();
  await expect(page.getByTestId(settingsSectionPin("secrets"))).toBeVisible();
}

test("creates, delivers and drains into desktop Inbox, pauses, rotates, and deletes an incoming webhook", async () => {
  test.setTimeout(240_000);
  const temp = await createTempWorkspace();
  let desktop: LaunchedDesktopApp | null = null;
  let relay: SyncRelayHandle | undefined;
  let proxy: Awaited<ReturnType<typeof startServerProxy>> | undefined;

  try {
    const ca = await mintLocalhostCa(temp.baseDir);
    const trustEnv = {
      NODE_EXTRA_CA_CERTS: ca.caPath,
      DOHC_ENGINE_TEST_RELAY_CA_MODE: "1",
      DOHC_ENGINE_TEST_RELAY_CA_FILE: ca.caPath,
      DOHC_E2E_ALLOW_INSECURE_LOOPBACK_RELAY: "0",
    };
    proxy = await startServerProxy(ca);
    relay = await spawnSyncRelay({
      dbPath: join(temp.baseDir, "relay", "relay.sqlite"),
      editLinks: {
        engineExecutable: resolveEngineBinary(),
        publicOrigin: proxy.origin,
        trustEnv,
      },
      linkBoundary: {
        linkKey: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
        relayExchangeKey: "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789",
        publicViewerOrigin: "https://share.dohc.test",
      },
    });
    proxy.routeRelayTo(relay.baseUrl);

    await seedWorkspaceManifest(temp, SYNCED_WORKSPACE_ID);
    await seedWorkspaceRegistry(temp, [
      {
        workspaceId: SYNCED_WORKSPACE_ID,
        rootPath: temp.rootPath,
        remote: {
          serverUrl: proxy.origin,
          ownerUserId: OWNER,
        },
      },
    ]);
    await seedCloudCredentials(temp, {
      serverUrl: proxy.origin,
      relayUrl: proxy.origin,
      userId: OWNER,
      token: `test:${OWNER}`,
    });

    desktop = await launchDesktopApp({ workspace: temp, env: trustEnv });
    const page = desktop.page;
    await openWorkspaceFromFirstRun(page, temp);

    await expect
      .poll(
        async () => {
          const response = await fetch(
            `${relay!.baseUrl}/sync/${encodeURIComponent(SYNCED_WORKSPACE_ID)}/webhooks`,
            { headers: { authorization: `Bearer test:${OWNER}` } },
          );
          return response.status;
        },
        { timeout: 60_000 },
      )
      .toBe(200);

    await openSecretsSettings(page);
    const dialog = page.getByTestId(desktopPins.settingsDialog);
    const section = page.getByTestId(settingsSectionPin("secrets"));
    await expect(section.getByTestId("incoming-webhooks-empty")).toBeVisible();

    await section.getByTestId("incoming-webhooks-add").click();
    const createDialog = page.getByTestId("incoming-webhook-create-dialog");
    await expect(createDialog).toBeVisible();
    await createDialog.getByTestId("incoming-webhook-name-input").fill("iPhone Shortcut");
    await expect(createDialog.getByTestId("incoming-webhook-collection-input")).toHaveValue(
      "Inbox",
    );
    await shoot(page, createDialog, "pr4-webhooks-create-dialog");
    await createDialog.getByTestId("incoming-webhook-create-submit").click();
    await expect(createDialog).toHaveCount(0);

    const revealDialog = page.getByTestId("incoming-webhook-reveal-dialog");
    await expect(revealDialog).toBeVisible();
    const firstUrl = (
      await revealDialog.getByTestId("incoming-webhook-reveal-url").innerText()
    ).trim();
    expect(firstUrl).toContain("/sync/hooks/");
    const firstToken = firstUrl.split("/sync/hooks/")[1]!;
    expect(firstToken.length).toBeGreaterThanOrEqual(32);
    await expect(revealDialog.getByTestId("incoming-webhook-reveal-curl")).toContainText(firstUrl);
    await shoot(page, revealDialog, "pr4-webhooks-reveal-dialog");

    await revealDialog.getByTestId("incoming-webhook-reveal-done").click();
    await expect(revealDialog).toHaveCount(0);

    // One-time token is removed from DOM and never stored in workspace files or plaintext SQLite.
    expect(await page.content()).not.toContain(firstToken);
    await assertNotInWorkspaceFolder(temp.rootPath, [firstToken]);

    await expect(section.getByTestId("incoming-webhooks-count")).toHaveText("1 of 20");
    await shoot(page, dialog, "pr4-webhooks-list");

    // Deliver a real external POST through the relay loopback address + idempotency replay + body mismatch conflict.
    const hookPostUrl = `${relay.baseUrl}/sync/hooks/${encodeURIComponent(firstToken)}`;
    const postPayload = JSON.stringify({ title: "Lunch receipt from iPhone", total: 18.5 });
    const delivered = await fetch(hookPostUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": "e2e-shortcut-1",
        "x-event-type": "ios.shortcut",
        authorization: "Bearer must-be-stripped",
      },
      body: postPayload,
    });
    expect(delivered.status).toBe(202);
    const deliveredBody = (await delivered.json()) as { ok: boolean; deliveryId: string };
    expect(deliveredBody.ok).toBe(true);

    const replay = await fetch(hookPostUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": "e2e-shortcut-1",
      },
      body: postPayload,
    });
    expect(replay.status).toBe(202);
    expect(await replay.json()).toEqual({
      ok: true,
      deliveryId: deliveredBody.deliveryId,
      deduplicated: true,
    });

    const conflict = await fetch(hookPostUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": "e2e-shortcut-1",
      },
      body: JSON.stringify({ title: "Different body" }),
    });
    expect(conflict.status).toBe(409);

    // Wait for the REAL automationServer to drain the delivery, clear payload_blob, and sync the record into the desktop Inbox folder!
    let settledRecordPath = "";
    await expect
      .poll(
        () => {
          const db = new DatabaseSync(relay!.dbPath, { readOnly: true });
          try {
            const row = db
              .prepare(
                "SELECT state, payload_blob, storage_bytes, record_path FROM sync_relay_webhook_deliveries WHERE delivery_id = ?",
              )
              .get(deliveredBody.deliveryId) as
              | {
                  state: string;
                  payload_blob: unknown;
                  storage_bytes: number;
                  record_path: string | null;
                }
              | undefined;
            if (row?.state === "settled" && row.record_path) {
              settledRecordPath = row.record_path;
              return `${row.state}:${row.payload_blob === null}:${row.storage_bytes}`;
            }
            return row?.state ?? "missing";
          } finally {
            db.close();
          }
        },
        { timeout: 90_000, intervals: [500] },
      )
      .toBe("settled:true:0");

    expect(settledRecordPath).toMatch(/^Inbox\/.*\.md$/u);

    // Verify the drained record syncs all the way into the real desktop workspace folder on disk!
    const desktopRecordFile = join(temp.rootPath, ...settledRecordPath.split("/"));
    await expect
      .poll(
        async () => {
          try {
            return await readFile(desktopRecordFile, "utf8");
          } catch {
            return "";
          }
        },
        { timeout: 60_000, intervals: [500] },
      )
      .toContain("Lunch receipt from iPhone");

    const diskContent = await readFile(desktopRecordFile, "utf8");
    expect(diskContent).toContain("Source: webhook");
    expect(diskContent).toContain("Kind: webhook");
    expect(diskContent).toContain("Status: New");
    expect(diskContent).toContain("x-event-type: ios.shortcut");
    expect(diskContent).not.toContain("must-be-stripped");

    // Verify SQLite stores only token_hash and allowlisted headers (no Authorization header or raw token).
    const db = new DatabaseSync(relay.dbPath, { readOnly: true });
    let webhookId = "";
    try {
      const hookRow = db
        .prepare(
          "SELECT webhook_id, token_hash FROM sync_relay_incoming_webhooks WHERE workspace_id = ?",
        )
        .get(SYNCED_WORKSPACE_ID) as { webhook_id: string; token_hash: string };
      webhookId = hookRow.webhook_id;
      expect(hookRow.token_hash).toHaveLength(64);
      expect(hookRow.token_hash).not.toContain(firstToken);

      const deliveryRow = db
        .prepare("SELECT headers_json FROM sync_relay_webhook_deliveries WHERE delivery_id = ?")
        .get(deliveredBody.deliveryId) as { headers_json: string };
      const headers = JSON.parse(deliveryRow.headers_json) as Record<string, string>;
      expect(headers["x-event-type"]).toBe("ios.shortcut");
      expect(headers).not.toHaveProperty("authorization");
    } finally {
      db.close();
    }

    // Pause -> opaque 404.
    await section.getByTestId(`incoming-webhook-toggle-${webhookId}`).click();
    await expect(section.getByTestId(`incoming-webhook-toggle-${webhookId}`)).toContainText(
      "Resume",
    );
    const pausedPost = await fetch(hookPostUrl, {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: "blocked while paused",
    });
    expect(pausedPost.status).toBe(404);
    expect(await pausedPost.json()).toEqual({ ok: false, error: "not found" });

    // Resume -> Rotate -> old URL returns 404, new URL returns 202.
    await section.getByTestId(`incoming-webhook-toggle-${webhookId}`).click();
    await expect(section.getByTestId(`incoming-webhook-toggle-${webhookId}`)).toContainText(
      "Pause",
    );

    await section.getByTestId(`incoming-webhook-rotate-${webhookId}`).click();
    await page.getByTestId("incoming-webhook-confirm-rotate-action").click();
    await expect(revealDialog).toBeVisible();
    const rotatedUrl = (
      await revealDialog.getByTestId("incoming-webhook-reveal-url").innerText()
    ).trim();
    expect(rotatedUrl).not.toBe(firstUrl);
    const rotatedToken = rotatedUrl.split("/sync/hooks/")[1]!;
    await revealDialog.getByTestId("incoming-webhook-reveal-done").click();

    const stalePost = await fetch(hookPostUrl, {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: "old token",
    });
    expect(stalePost.status).toBe(404);

    const rotatedPostUrl = `${relay.baseUrl}/sync/hooks/${encodeURIComponent(rotatedToken)}`;
    const freshPost = await fetch(rotatedPostUrl, {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: "new token",
    });
    expect(freshPost.status).toBe(202);

    // Delete -> empty state + opaque 404.
    await section.getByTestId(`incoming-webhook-delete-${webhookId}`).click();
    await page.getByTestId("incoming-webhook-confirm-delete-action").click();
    await expect(section.getByTestId("incoming-webhooks-empty")).toBeVisible();

    const deletedPost = await fetch(rotatedPostUrl, {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: "deleted token",
    });
    expect(deletedPost.status).toBe(404);

    // A website form keeps only its named fields, all the way to the record on disk.
    await section.getByTestId("incoming-webhooks-add").click();
    await expect(createDialog).toBeVisible();
    await createDialog.getByTestId("incoming-webhook-name-input").fill("Waitlist");
    await createDialog.getByRole("switch", { name: "Website form" }).click();
    await createDialog.getByTestId("incoming-webhook-form-fields-input").fill("email, source");
    await shoot(page, createDialog, "webhooks-form-create-dialog");
    await createDialog.getByTestId("incoming-webhook-create-submit").click();
    await expect(revealDialog).toBeVisible();
    const formUrl = (
      await revealDialog.getByTestId("incoming-webhook-reveal-url").innerText()
    ).trim();
    await expect(revealDialog.getByTestId("incoming-webhook-reveal-curl")).toContainText(
      `<form method="post" action="${formUrl}">`,
    );
    await shoot(page, revealDialog, "webhooks-form-reveal-dialog");
    await revealDialog.getByTestId("incoming-webhook-reveal-done").click();
    await expect(section.getByText("Website form", { exact: true })).toBeVisible();
    await shoot(page, dialog, "webhooks-form-list");

    const formPostUrl = `${relay.baseUrl}/sync/hooks/${encodeURIComponent(formUrl.split("/sync/hooks/")[1]!)}`;
    const jsonToForm = await fetch(formPostUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "ada@example.com" }),
    });
    expect(jsonToForm.status).toBe(415);
    const formPost = await fetch(formPostUrl, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "email=ada%40example.com&source=site&note=dropped-by-dohc",
    });
    expect(formPost.status).toBe(202);
    const { deliveryId: formDeliveryId } = (await formPost.json()) as { deliveryId: string };
    let formRecordPath = "";
    await expect
      .poll(
        () => {
          const formDb = new DatabaseSync(relay!.dbPath, { readOnly: true });
          try {
            const row = formDb
              .prepare(
                "SELECT state, record_path FROM sync_relay_webhook_deliveries WHERE delivery_id = ?",
              )
              .get(formDeliveryId) as { state: string; record_path: string | null } | undefined;
            if (row?.record_path) formRecordPath = row.record_path;
            return row?.state ?? "missing";
          } finally {
            formDb.close();
          }
        },
        { timeout: 90_000, intervals: [500] },
      )
      .toBe("settled");
    const formRecordFile = join(temp.rootPath, ...formRecordPath.split("/"));
    await expect
      .poll(() => readFile(formRecordFile, "utf8").catch(() => ""), {
        timeout: 60_000,
        intervals: [500],
      })
      .toContain("email=ada%40example.com&source=site");
    expect(await readFile(formRecordFile, "utf8")).not.toContain("dropped-by-dohc");
  } finally {
    try {
      await desktop?.close();
    } finally {
      await Promise.allSettled([relay?.stop(), proxy?.close()]);
      await temp.cleanup();
    }
  }
});

test("shows clear unavailable message for incoming webhooks in a local-only workspace", async () => {
  test.setTimeout(120_000);
  const temp = await createTempWorkspace();
  let desktop: LaunchedDesktopApp | null = null;
  try {
    desktop = await launchDesktopApp({ workspace: temp });
    const page = desktop.page;
    await openWorkspaceFromFirstRun(page, temp);
    await openSecretsSettings(page);
    const section = page.getByTestId(settingsSectionPin("secrets"));
    await expect(section.getByTestId("incoming-webhooks-unavailable")).toBeVisible();
    await expect(section.getByTestId("incoming-webhooks-unavailable")).toContainText(
      /synced workspace/iu,
    );
  } finally {
    try {
      await desktop?.close();
    } finally {
      await temp.cleanup();
    }
  }
});
