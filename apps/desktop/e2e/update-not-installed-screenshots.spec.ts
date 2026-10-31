import { expect, test, type Page } from "@playwright/test";
import { createHash } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import { createRequire } from "node:module";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { activityPin } from "../src/testPins";
import { waitForVisibleAnimations } from "./helpers/animations";
import { desktopRoot, launchDesktopApp } from "./helpers/desktopApp";
import { cleanupDesktopWorkspace, createTempWorkspace, openWorkspaceFromFirstRun } from "./helpers/workspace";

// Screenshot harness (@ui-audit) for an update a person chose that dohc
// opened without. Light and dark, on Windows. Not a regression test; it runs
// only when a shot directory is set. The app under test reports Electron's
// version, so the record names that version as the one the update was
// chosen on, and the feed offers a later one. An unpackaged build starts a
// download only with a dev-app-update.yml naming updaterCacheDirName in its
// app path, so the test writes one there and removes it afterwards.
const SHOT_DIR = process.env.UI_AUDIT_SHOT_DIR ?? "";
test.skip(SHOT_DIR === "", "set UI_AUDIT_SHOT_DIR to capture the update notice screenshots");

const CHOSEN = "0.1.1-nightly.20261030.158.1";
const TITLE = `dohc didn't install update ${CHOSEN}`;
const ELECTRON = (createRequire(join(desktopRoot, "package.json"))("electron/package.json") as { version: string }).version;

// A feed that offers an update and holds its download open, so the title
// bar keeps showing the download.
async function startFeed(): Promise<{ url: string; close: () => void }> {
  const installer = Buffer.alloc(1024 * 1024, 1);
  const sha512 = createHash("sha512").update(installer).digest("base64");
  const yml = `version: 999.0.0\nfiles:\n  - url: dohc-update.exe\n    sha512: ${sha512}\n    size: ${installer.length}\npath: dohc-update.exe\nsha512: ${sha512}\nreleaseDate: '2026-10-30T00:00:00.000Z'\n`;
  const held: ServerResponse[] = [];
  const server = createServer((request, response) => {
    // electron-updater adds a cache-busting query to the feed request.
    const { pathname } = new URL(request.url ?? "/", "http://127.0.0.1");
    if (pathname.endsWith(".yml")) {
      response.end(yml);
    } else if (pathname === "/dohc-update.exe") {
      response.writeHead(200, { "content-length": installer.length });
      response.write(installer.subarray(0, 4096));
      held.push(response);
    } else {
      response.statusCode = 404;
      response.end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/`,
    close: () => {
      for (const response of held) response.destroy();
      server.close();
    },
  };
}

async function setTheme(page: Page, theme: "light" | "dark"): Promise<void> {
  await page.evaluate(async (value) => {
    document.documentElement.setAttribute("data-theme", value);
    void getComputedStyle(document.body).backgroundColor;
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  }, theme);
  await waitForVisibleAnimations(page);
}

async function shoot(page: Page, name: string): Promise<void> {
  for (const theme of ["light", "dark"] as const) {
    await setTheme(page, theme);
    await page.screenshot({ path: join(SHOT_DIR, `${name}-${theme}.png`) });
  }
  await setTheme(page, "light");
}

test("@ui-audit an update a person chose that dohc opened without", async () => {
  test.setTimeout(240_000);
  await mkdir(SHOT_DIR, { recursive: true });
  const workspace = await createTempWorkspace();
  const feed = await startFeed();
  const env = { DOHC_DESKTOP_MOCK_UPDATES: "1", DOHC_UPDATE_URL: feed.url };
  let desktop: Awaited<ReturnType<typeof launchDesktopApp>> | null = null;
  let devUpdateConfig: string | null = null;
  try {
    // A person pressed Update on this version, and dohc opens on it again.
    await writeFile(join(workspace.homeDir, "chosen-update.json"), JSON.stringify({ version: CHOSEN, from: ELECTRON }));
    desktop = await launchDesktopApp({ workspace, env });
    const { page } = desktop;
    const currentVersion = await desktop.app.evaluate(({ app }) => app.getVersion());
    expect(currentVersion).toBe(ELECTRON);
    devUpdateConfig = join(await desktop.app.evaluate(({ app }) => app.getAppPath()), "dev-app-update.yml");
    await writeFile(devUpdateConfig, `provider: generic\nurl: ${feed.url}\nupdaterCacheDirName: dohc-ui-audit-updater\n`);
    await openWorkspaceFromFirstRun(page, workspace);
    await expect(page.getByTestId("workspace-shell")).toHaveAttribute("data-ready", "true");
    await page.emulateMedia({ reducedMotion: "reduce" });
    const toast = page.getByTestId("workspace-shell-error").filter({ hasText: TITLE });
    await expect(toast).toBeVisible({ timeout: 60_000 });
    await expect(toast).toContainText(`dohc is still on version ${currentVersion}.`);
    await shoot(page, "01-toast");

    const retry = toast.getByRole("button", { name: "Try again" });
    await retry.focus();
    await page.keyboard.press("Shift+Tab");
    await page.keyboard.press("Tab");
    await expect(retry).toBeFocused();
    await shoot(page, "02-toast-try-again-focused");

    await page.getByTestId(activityPin("settings")).click();
    const line = page.getByTestId("desktop-updates-status");
    await expect(line).toHaveText(`${TITLE} and is still on version ${currentVersion}.`);
    await line.scrollIntoViewIfNeeded();
    await shoot(page, "03-settings-update-line");
    await page.getByRole("button", { name: "Close settings" }).click();

    await page.getByTestId("notice-center-toggle").click();
    const notices = page.getByRole("dialog", { name: "Notices", exact: true });
    await expect(notices.getByText(TITLE)).toBeVisible();
    await shoot(page, "04-notices-row");

    // Try again starts the download: the toast and the row go at once, and
    // the title bar shows the download. Running a row's action closes Notices.
    await notices.getByRole("button", { name: "Try again" }).click();
    await expect(notices).toBeHidden();
    await expect(toast).toHaveCount(0);
    await expect(page.getByTestId("titlebar-update")).toHaveAttribute("data-update-status", "downloading");
    await shoot(page, "05-title-bar-after-try-again");
    await page.getByTestId("notice-center-toggle").click();
    await expect(notices).toBeVisible();
    await expect(notices.getByText(TITLE)).toHaveCount(0);
    await shoot(page, "06-notices-after-try-again");
    expect(desktop.logs.filter((entry) => entry.level === "pageerror")).toEqual([]);
  } finally {
    if (devUpdateConfig) await rm(devUpdateConfig, { force: true });
    feed.close();
    await cleanupDesktopWorkspace(desktop, workspace);
  }
});
