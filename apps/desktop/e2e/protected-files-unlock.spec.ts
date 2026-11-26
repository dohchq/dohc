import { expect, test } from "@playwright/test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { openLiveDaemonWorkspace } from "./helpers/daemonSeed";
import { spawnSyncRelay } from "./helpers/syncRelay";
import { launchDesktopApp } from "./helpers/desktopApp";
import {
  cleanupDesktopWorkspace,
  createTempWorkspace,
  seedCloudCredentials,
  showExplorerFiles,
  waitForWorkspaceFile,
  waitForWorkspaceReady,
} from "./helpers/workspace";
import {
  createWorkspaceEngineCapture,
  type WorkspaceEngineCapture,
} from "../src/workspaces/workspaceEngineCapture";
import { loadSecretDataKey } from "../src/workspaces/workspaceDataKey";
import { enrollWorkspaceKeyEnvelope } from "../src/workspaces/workspaceKeyEnvelopeEnrollment";

const PASSPHRASE = "a passphrase for the trip";
const LOCKED = "Protected files are locked on this computer";

async function writeCaptured(
  capture: WorkspaceEngineCapture,
  rootPath: string,
  path: string,
  text: string,
): Promise<void> {
  const count = async () =>
    (await capture.listMoments({ limit: 1_000 })).moments.filter((moment) => moment.path === path)
      .length;
  const before = await count();
  await writeFile(join(rootPath, path), text);
  capture.observeFileEvents([{ path, operation: "update" }]);
  await expect.poll(count, { timeout: 30_000 }).toBeGreaterThan(before);
}

test("@protected-files a computer without the key keeps syncing, then unlocks the .env from Settings", async () => {
  test.setTimeout(240_000);
  const joined = await createTempWorkspace();
  const workspaceId = "protected-files-unlock";
  const relay = await spawnSyncRelay({ dbPath: join(joined.baseDir, "relay", "relay.sqlite") });
  const ownerRoot = join(joined.baseDir, "owner");
  await mkdir(ownerRoot);
  const owner = await openLiveDaemonWorkspace({ workspaceId, rootPath: ownerRoot });
  const capture = createWorkspaceEngineCapture({
    ...owner.workspace,
    rustEngineSessions: owner.sessions,
  });
  const remote = owner.relay.bind({
    ...owner.workspace,
    relay: { baseUrl: relay.baseUrl, token: "test:e2e-user" },
  });
  let desktop: Awaited<ReturnType<typeof launchDesktopApp>> | null = null;
  try {
    await remote.claim();
    await writeCaptured(capture, ownerRoot, "notes.md", "# Trip\n\nBefore secrets.\n");
    expect((await remote.push()).pushed).toBeGreaterThan(0);
    await seedCloudCredentials(joined, {
      serverUrl: relay.baseUrl,
      relayUrl: relay.baseUrl,
      userId: "e2e-user",
    });

    desktop = await launchDesktopApp({
      workspace: joined,
      env: { DOHC_TEST_SYNC_DEBOUNCE_MS: "150", DOHC_TEST_SYNC_BACKOFF_MS: "250" },
    });
    const { page } = desktop;
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.getByTestId("first-run-join-synced").click();
    await page.getByTestId("join-sync-code").fill(`dohc-sync:${workspaceId}:${relay.baseUrl}`);
    await page.getByTestId("join-choose-folder").click();
    await page.getByTestId("join-workspace-start").click();
    await waitForWorkspaceReady(page);
    await showExplorerFiles(page);
    await waitForWorkspaceFile(page, workspaceId, "notes.md");

    await writeCaptured(capture, ownerRoot, ".env", "TOKEN=from-the-owner\n");
    await writeCaptured(capture, ownerRoot, "notes.md", "# Trip\n\nAfter secrets.\n");
    expect((await remote.push()).pushed).toBeGreaterThan(0);

    await expect
      .poll(async () => await readFile(join(joined.rootPath, "notes.md"), "utf8"), {
        timeout: 60_000,
      })
      .toBe("# Trip\n\nAfter secrets.\n");
    const toast = page.getByTestId("workspace-shell-notice").filter({ hasText: LOCKED });
    await expect(toast).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId("sync-status")).toHaveAttribute("data-state", "synced");
    await toast.screenshot({ path: test.info().outputPath("locked-notice.png") });
    await expect(readFile(join(joined.rootPath, ".env"), "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });

    await toast.getByTestId("workspace-shell-error-action").click();
    const unlock = page.getByTestId("cloud-unlock-secrets");
    await expect(unlock).toBeVisible();
    await unlock.click();
    await page.getByTestId("cloud-sync-passphrase").fill(PASSPHRASE);
    await page.getByTestId("cloud-sync-passphrase-submit").click();
    await expect(page.getByTestId("cloud-sync-error")).toContainText("No passphrase protects");
    await page
      .getByTestId("settings-row-protected-files")
      .screenshot({ path: test.info().outputPath("no-passphrase-yet.png") });

    const dataKey = await loadSecretDataKey(ownerRoot, { createIfMissing: false });
    await enrollWorkspaceKeyEnvelope({
      workspaceId,
      dataKey,
      passphrase: PASSPHRASE,
      transport: remote,
      installDataKey: async () => {},
    });

    await page.getByTestId("cloud-sync-passphrase-submit").click();
    await expect(page.getByTestId("cloud-protect-secrets")).toBeVisible({ timeout: 30_000 });
    await expect
      .poll(async () => await readFile(join(joined.rootPath, ".env"), "utf8").catch(() => null), {
        timeout: 30_000,
      })
      .toBe("TOKEN=from-the-owner\n");
    await page
      .getByTestId("settings-row-protected-files")
      .screenshot({ path: test.info().outputPath("unlocked.png") });
    await page.getByRole("button", { name: "Close settings" }).click();
    await expect(toast).toHaveCount(0);
    await page.getByTestId("notice-center-toggle").click();
    const notices = page.getByRole("dialog", { name: "Notices", exact: true });
    await expect(notices.getByText(LOCKED)).toHaveCount(0);
    expect(desktop.logs.filter((entry) => entry.level === "pageerror")).toEqual([]);
  } finally {
    await desktop?.close().catch(() => undefined);
    await capture.stop().catch(() => undefined);
    await owner.close().catch(() => undefined);
    await relay.stop();
    await cleanupDesktopWorkspace(null, joined);
  }
});
