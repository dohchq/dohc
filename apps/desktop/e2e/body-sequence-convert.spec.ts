import { expect, test, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { DohcDesktopBridge } from "../src/ipc/bridgeContract";
import { activityPin, desktopPins, settingsNavPin } from "../src/testPins";
import { launchDesktopApp, type LaunchedDesktopApp } from "./helpers/desktopApp";
import { DOCUMENT_END } from "./helpers/keys";
import { spawnSyncRelay, type SyncRelayHandle } from "./helpers/syncRelay";
import {
  cleanupDesktopWorkspace,
  createTempWorkspace,
  explorerRow,
  openWorkspaceFromFirstRun,
  seedCloudCredentials,
  seedWorkspaceManifest,
  seedWorkspaceRegistry,
  waitForWorkspaceFile,
  writeWorkspaceFiles,
} from "./helpers/workspace";

type Bridge = Pick<DohcDesktopBridge, "cloudEnableSync">;
const WORKSPACE_ID = "body-sequence-convert";
const PATH = "plan.md";
const env = {
  DOHC_ENGINE_NOTE_BODY_SEQUENCE: undefined,
  DOHC_ENGINE_NEW_NOTE_BODY_SEQUENCE: undefined,
  DOHC_TEST_SYNC_DEBOUNCE_MS: "150",
  DOHC_TEST_SYNC_BACKOFF_MS: "250",
};

async function openNote(page: Page, format: string) {
  await explorerRow(page, PATH).click();
  const editor = page.getByTestId("markdown-editor").first();
  await expect(editor).toHaveAttribute("contenteditable", "true", { timeout: 15_000 });
  await expect(editor).toHaveAttribute("data-note-format", format);
  return editor;
}

async function typeAndSync(page: Page, rootPath: string, after: string, typed: string) {
  await page.getByTestId("markdown-editor").first().getByText(after).click();
  await page.keyboard.press(DOCUMENT_END);
  await page.keyboard.type(typed);
  await expect
    .poll(
      async () => (await readFile(join(rootPath, PATH), "utf8")).replaceAll("\r\n", "\n").trimEnd(),
      { timeout: 20_000 },
    )
    .toBe(`# Plan\n\n${after}${typed}`);
  await expect(page.getByTestId("sync-status")).toHaveAttribute("data-state", "synced", {
    timeout: 60_000,
  });
}

test("an owner converts a synced note to the new format through a relay that requires version 2, with no setting turned on @body-sequence-convert", async () => {
  test.setTimeout(300_000);
  const temp = await createTempWorkspace();
  let relay: SyncRelayHandle | null = null;
  let desktop: LaunchedDesktopApp | null = null;
  try {
    await seedWorkspaceManifest(temp, WORKSPACE_ID);
    await writeWorkspaceFiles(temp, [{ path: PATH, contents: "# Plan\n\nPack bags.\n" }]);
    relay = await spawnSyncRelay({
      dbPath: join(temp.baseDir, "relay", "relay.sqlite"),
      env: { DOHC_RELAY_ENGINE_API_MIN: "2", DOHC_RELAY_BODY_SEQUENCE_NOTES: "1" },
    });
    await seedWorkspaceRegistry(temp, [{ workspaceId: WORKSPACE_ID, rootPath: temp.rootPath }]);
    await seedCloudCredentials(temp, {
      serverUrl: relay.baseUrl,
      relayUrl: relay.baseUrl,
      userId: "e2e-body-sequence-convert",
    });
    desktop = await launchDesktopApp({ workspace: temp, env });
    const { page } = desktop;
    await openWorkspaceFromFirstRun(page, temp);
    await waitForWorkspaceFile(page, WORKSPACE_ID, PATH);
    await page.evaluate(async (workspaceId) => {
      await (window as unknown as { dohcDesktop: Bridge }).dohcDesktop.cloudEnableSync({
        workspaceId,
      });
    }, WORKSPACE_ID);
    await expect(page.getByTestId("sync-status")).toHaveAttribute("data-state", "synced", {
      timeout: 60_000,
    });

    await openNote(page, "1");
    await typeAndSync(page, temp.rootPath, "Pack bags.", " Book trains.");
    await page.keyboard.press("ControlOrMeta+w");
    await expect(page.getByTestId("markdown-editor")).toHaveCount(0);

    await page.getByTestId(activityPin("settings")).click();
    await expect(page.getByTestId(desktopPins.settingsDialog)).toBeVisible();
    await page.getByTestId(settingsNavPin("advanced")).click();
    const row = page.getByTestId("settings-row-note-format");
    await row.getByRole("button", { name: "Convert notes…" }).click();
    await page.getByTestId("settings-confirm-convert-notes-action").click();
    await expect(row).toContainText("Converted 1 note", { timeout: 60_000 });
    await page.getByRole("button", { name: "Close settings" }).click();

    await expect(await openNote(page, "2")).toContainText("Pack bags. Book trains.");
    await typeAndSync(page, temp.rootPath, "Pack bags. Book trains.", " Go.");

    await desktop.close();
    desktop = await launchDesktopApp({ workspace: temp, env });
    const reopened = desktop.page;
    await openWorkspaceFromFirstRun(reopened, temp);
    await expect(await openNote(reopened, "2")).toContainText("Pack bags. Book trains. Go.");
  } finally {
    await relay?.stop();
    await cleanupDesktopWorkspace(desktop, temp);
  }
});
