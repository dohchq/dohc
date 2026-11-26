import { activityPin, desktopPins, settingsNavPin, settingsSectionPin } from "../src/testPins";
import { expect, test, type Locator, type Page } from "@playwright/test";
import { normalizeAbsolutePath } from "@dohc/workspace-core";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { waitForVisibleAnimations } from "./helpers/animations";
import { launchDesktopApp, type LaunchedDesktopApp } from "./helpers/desktopApp";
import { spawnSyncRelay, type SyncRelayHandle } from "./helpers/syncRelay";
import {
  cleanupDesktopWorkspace,
  createTempWorkspace,
  openWorkspaceFromFirstRun,
  seedCloudCredentials,
  seedWorkspaceManifest,
  seedWorkspaceRegistry,
} from "./helpers/workspace";

const SHOT_DIR = process.env.PR1_SHOT_DIR ?? "";
const OWNER = "secrets-e2e-owner";
const SYNCED_WORKSPACE_ID = "ws-secrets-synced-e2e";

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
      expect(bytes.includes(Buffer.from(needle, "utf8")), `${file} must not contain secret`).toBe(
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

test("manages write-only synced workspace secrets through the relay and survives restart", async () => {
  test.setTimeout(180_000);
  const temp = await createTempWorkspace();
  let desktop: LaunchedDesktopApp | null = null;
  let relay: SyncRelayHandle | undefined;

  const headerSecretValue = "re_live_e2e_secret_987654";
  const replacedHeaderSecretValue = "re_live_e2e_rotated_555444";
  const urlSecretValue = "https://hooks.slack.com/services/T00/B00/SECRET999";

  try {
    relay = await spawnSyncRelay({
      dbPath: join(temp.baseDir, "relay", "relay.sqlite"),
      linkBoundary: {
        linkKey: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
        relayExchangeKey: "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789",
        publicViewerOrigin: "https://share.dohc.test",
      },
    });
    await seedWorkspaceManifest(temp, SYNCED_WORKSPACE_ID);
    await seedWorkspaceRegistry(temp, [
      {
        workspaceId: SYNCED_WORKSPACE_ID,
        rootPath: temp.rootPath,
        remote: {
          serverUrl: relay.baseUrl,
          ownerUserId: OWNER,
        },
      },
    ]);
    await seedCloudCredentials(temp, {
      serverUrl: relay.baseUrl,
      relayUrl: relay.baseUrl,
      userId: OWNER,
      token: `test:${OWNER}`,
    });

    desktop = await launchDesktopApp({ workspace: temp });
    const page = desktop.page;
    await openWorkspaceFromFirstRun(page, temp);

    await expect
      .poll(
        async () => {
          const response = await fetch(
            `${relay!.baseUrl}/sync/${encodeURIComponent(SYNCED_WORKSPACE_ID)}/secrets`,
            { headers: { authorization: `Bearer test:${OWNER}` } },
          );
          return response.status;
        },
        { timeout: 30_000 },
      )
      .toBe(200);

    await openSecretsSettings(page);
    const dialog = page.getByTestId(desktopPins.settingsDialog);
    const section = page.getByTestId(settingsSectionPin("secrets"));
    await expect(section.getByTestId("workspace-secrets-storage")).toHaveText(
      "Sealed on your sync server",
    );
    await expect(section.getByTestId("workspace-secrets-empty")).toBeVisible();
    await shoot(page, dialog, "pr1-secrets-empty");

    await section.getByTestId("workspace-secrets-add").click();
    const editor = page.getByTestId("workspace-secret-editor-dialog");
    await expect(editor).toBeVisible();
    await editor.getByTestId("workspace-secret-name-input").fill("RESEND_API_KEY");
    await editor.getByTestId("workspace-secret-hosts-input").fill("api.resend.com");
    await editor.getByTestId("workspace-secret-value-input").fill(headerSecretValue);
    await shoot(page, editor, "pr1-secrets-add-dialog");
    await editor.getByTestId("workspace-secret-save").click();
    await expect(editor).toHaveCount(0);

    await section.getByTestId("workspace-secrets-add").click();
    await expect(editor).toBeVisible();
    await editor.getByTestId("workspace-secret-name-input").fill("SLACK_ALERT_HOOK");
    await editor
      .getByTestId("workspace-secret-usage")
      .getByRole("radio", { name: "Webhook URL" })
      .click();
    await editor.getByTestId("workspace-secret-value-input").fill(urlSecretValue);
    await editor.getByTestId("workspace-secret-save").click();
    await expect(editor).toHaveCount(0);

    await expect(section.getByTestId("workspace-secret-row-RESEND_API_KEY")).toBeVisible();
    await expect(section.getByTestId("workspace-secret-row-SLACK_ALERT_HOOK")).toBeVisible();
    await expect(section.getByTestId("workspace-secrets-count")).toHaveText("2 of 50");
    await shoot(page, dialog, "pr1-secrets-list");

    await section.getByTestId("workspace-secrets-add").click();
    await expect(editor).toBeVisible();
    await editor.getByTestId("workspace-secret-name-input").fill("RESEND_API_KEY");
    await editor.getByTestId("workspace-secret-hosts-input").fill("evil.example.com");
    await editor.getByTestId("workspace-secret-value-input").fill("overwrite-attempt");
    await editor.getByTestId("workspace-secret-save").click();
    await expect(editor.getByTestId("workspace-secret-name-error")).toContainText("already exists");
    await editor.getByTestId("workspace-secret-cancel").click();
    await expect(editor).toHaveCount(0);

    const pageHtml = await page.content();
    expect(pageHtml).not.toContain(headerSecretValue);
    expect(pageHtml).not.toContain(urlSecretValue);
    await assertNotInWorkspaceFolder(temp.rootPath, [headerSecretValue, urlSecretValue]);

    const db = new DatabaseSync(relay.dbPath, { readOnly: true });
    try {
      const rows = db
        .prepare(
          "SELECT name, usage, sealed_value, key_id, generation FROM sync_relay_workspace_secrets WHERE workspace_id = ? ORDER BY name",
        )
        .all(SYNCED_WORKSPACE_ID) as Array<{
        name: string;
        usage: string;
        sealed_value: string;
        key_id: string;
        generation: number;
      }>;
      expect(rows).toHaveLength(2);
      expect(rows.map((row) => row.name)).toEqual(["RESEND_API_KEY", "SLACK_ALERT_HOOK"]);
      for (const row of rows) {
        expect(row.sealed_value).toMatch(/^v1\./u);
        expect(row.sealed_value).not.toContain(headerSecretValue);
        expect(row.sealed_value).not.toContain(urlSecretValue);
        expect(row.key_id).toBe("relay-link-v1");
        expect(row.generation).toBe(1);
      }
    } finally {
      db.close();
    }

    await desktop.close();
    desktop = await launchDesktopApp({ workspace: temp });
    const reopened = desktop.page;
    await openWorkspaceFromFirstRun(reopened, temp);
    await openSecretsSettings(reopened);

    const reopenedSection = reopened.getByTestId(settingsSectionPin("secrets"));
    await expect(reopenedSection.getByTestId("workspace-secret-row-RESEND_API_KEY")).toBeVisible();
    await expect(
      reopenedSection.getByTestId("workspace-secret-row-SLACK_ALERT_HOOK"),
    ).toBeVisible();

    await reopenedSection.getByTestId("workspace-secret-replace-RESEND_API_KEY").click();
    const replaceDialog = reopened.getByTestId("workspace-secret-editor-dialog");
    await expect(replaceDialog.getByTestId("workspace-secret-name-input")).toBeDisabled();
    await replaceDialog
      .getByTestId("workspace-secret-hosts-input")
      .fill("api.resend.com, mail.resend.com");
    await replaceDialog.getByTestId("workspace-secret-value-input").fill(replacedHeaderSecretValue);
    await replaceDialog.getByTestId("workspace-secret-save").click();
    await expect(replaceDialog).toHaveCount(0);
    await expect(reopenedSection.getByTestId("workspace-secret-row-RESEND_API_KEY")).toContainText(
      "api.resend.com, mail.resend.com",
    );

    const dbAfterReplace = new DatabaseSync(relay.dbPath, { readOnly: true });
    try {
      const updatedRow = dbAfterReplace
        .prepare(
          "SELECT generation, sealed_value FROM sync_relay_workspace_secrets WHERE workspace_id = ? AND name = ?",
        )
        .get(SYNCED_WORKSPACE_ID, "RESEND_API_KEY") as
        | { generation: number; sealed_value: string }
        | undefined;
      expect(updatedRow?.generation).toBe(2);
      expect(updatedRow?.sealed_value).not.toContain(replacedHeaderSecretValue);
    } finally {
      dbAfterReplace.close();
    }

    await reopenedSection.getByTestId("workspace-secret-delete-SLACK_ALERT_HOOK").click();
    await reopened.getByTestId("workspace-secret-confirm-delete-action").click();
    await expect(reopenedSection.getByTestId("workspace-secret-row-SLACK_ALERT_HOOK")).toHaveCount(
      0,
    );
    await expect(reopenedSection.getByTestId("workspace-secrets-count")).toHaveText("1 of 50");
  } finally {
    try {
      if (desktop) await desktop.close();
    } finally {
      await relay?.stop();
      await temp.cleanup();
    }
  }
});

test("stores local workspace secrets outside the workspace or fails closed when keychain is unavailable", async () => {
  test.setTimeout(180_000);
  const temp = await createTempWorkspace();
  let desktop: LaunchedDesktopApp | null = null;
  const localHookValue = "https://hooks.example.com/local/secret-token-42";

  try {
    desktop = await launchDesktopApp({ workspace: temp });
    const page = desktop.page;
    await openWorkspaceFromFirstRun(page, temp);
    await openSecretsSettings(page);

    const section = page.getByTestId(settingsSectionPin("secrets"));
    await expect(
      section
        .getByTestId("workspace-secrets-storage")
        .or(section.getByTestId("workspace-secrets-unavailable")),
    ).toBeVisible();

    if (await section.getByTestId("workspace-secrets-unavailable").isVisible()) {
      await expect(section.getByTestId("workspace-secrets-add")).toHaveCount(0);
      return;
    }

    await expect(section.getByTestId("workspace-secrets-storage")).toHaveText(
      "Sealed on this computer",
    );
    await section.getByTestId("workspace-secrets-add").click();
    const editor = page.getByTestId("workspace-secret-editor-dialog");
    await editor.getByTestId("workspace-secret-name-input").fill("LOCAL_HOOK");
    await editor
      .getByTestId("workspace-secret-usage")
      .getByRole("radio", { name: "Webhook URL" })
      .click();
    await editor.getByTestId("workspace-secret-value-input").fill(localHookValue);
    await editor.getByTestId("workspace-secret-save").click();
    await expect(editor).toHaveCount(0);
    await expect(section.getByTestId("workspace-secret-row-LOCAL_HOOK")).toBeVisible();

    expect(await page.content()).not.toContain(localHookValue);
    await assertNotInWorkspaceFolder(temp.rootPath, [localHookValue]);

    await desktop.close();
    desktop = await launchDesktopApp({ workspace: temp });
    const reopened = desktop.page;
    await openWorkspaceFromFirstRun(reopened, temp);
    await openSecretsSettings(reopened);

    const reopenedSection = reopened.getByTestId(settingsSectionPin("secrets"));
    await expect(reopenedSection.getByTestId("workspace-secret-row-LOCAL_HOOK")).toBeVisible();

    await desktop.close();
    const vaultDir = join(temp.homeDir, "workspace-secrets");
    const [vaultName] = await readdir(vaultDir);
    const vaultPath = join(vaultDir, vaultName!);
    const vault = JSON.parse(await readFile(vaultPath, "utf8")) as {
      sealed: { data: string };
    };
    const first = vault.sealed.data[0]!;
    vault.sealed.data = `${first === "A" ? "B" : "A"}${vault.sealed.data.slice(1)}`;
    await writeFile(vaultPath, JSON.stringify(vault));

    desktop = await launchDesktopApp({ workspace: temp });
    const damaged = desktop.page;
    await openWorkspaceFromFirstRun(damaged, temp);
    await openSecretsSettings(damaged);
    const damagedSection = damaged.getByTestId(settingsSectionPin("secrets"));
    await expect(damagedSection.getByTestId("workspace-secrets-unavailable")).toContainText(
      "damaged or were changed outside dohc",
    );
    await expect(damagedSection.getByTestId("workspace-secrets-add")).toHaveCount(0);
    await shoot(damaged, damaged.getByTestId(desktopPins.settingsDialog), "secrets-damaged-vault");
    await damagedSection.getByTestId("workspace-secrets-clear-local").click();
    const confirmClear = damaged.getByTestId("workspace-secrets-confirm-clear-local");
    await expect(confirmClear).toBeVisible();
    await shoot(damaged, confirmClear, "secrets-damaged-vault-confirm");
    await damaged.getByTestId("workspace-secrets-confirm-clear-local-action").click();
    await expect(damagedSection.getByTestId("workspace-secrets-empty")).toBeVisible();
    await expect(readdir(vaultDir)).resolves.toEqual([]);
  } finally {
    await cleanupDesktopWorkspace(desktop, temp);
  }
});

test("keeps a paused-sync workspace on server secrets instead of switching to local storage", async () => {
  test.setTimeout(120_000);
  const temp = await createTempWorkspace();
  let desktop: LaunchedDesktopApp | null = null;
  const pausedWorkspaceId = "ws-secrets-paused-e2e";

  try {
    await seedWorkspaceManifest(temp, pausedWorkspaceId);
    await writeFile(
      join(temp.homeDir, "dohc-workspaces.json"),
      `${JSON.stringify(
        {
          version: 1,
          workspaces: [
            {
              workspaceId: pausedWorkspaceId,
              rootPath: normalizeAbsolutePath(temp.rootPath),
              kind: "personal",
              mode: "local-first",
              pausedRemote: {
                serverUrl: "https://server.example.test",
                ownerUserId: OWNER,
              },
            },
          ],
        },
        null,
        2,
      )}\n`,
    );

    desktop = await launchDesktopApp({ workspace: temp });
    const page = desktop.page;
    await openWorkspaceFromFirstRun(page, temp);
    await openSecretsSettings(page);

    const section = page.getByTestId(settingsSectionPin("secrets"));
    await expect(section.getByTestId("workspace-secrets-unavailable")).toBeVisible();
    await expect(section.getByTestId("workspace-secrets-unavailable")).toContainText(
      "Sync is paused for this workspace",
    );
    await expect(section.getByTestId("workspace-secrets-add")).toHaveCount(0);
  } finally {
    await cleanupDesktopWorkspace(desktop, temp);
  }
});
