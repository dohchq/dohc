import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { join } from "node:path";
import { test, expect, type Page } from "@playwright/test";
import { buildConnectServerUrl } from "@dohc/workspace-contracts/deep-links";
import { electronLaunchArgs } from "../src/testing/electronLaunchArgs";
import { desktopRoot, launchDesktopApp } from "./helpers/desktopApp";
import {
  cleanupDesktopWorkspace,
  createTempWorkspace,
  openWorkspaceFromFirstRun,
} from "./helpers/workspace";

const SERVER = "https://drive.dohc.computer";
const electronExecutable = createRequire(import.meta.url)("electron") as string;

// The OS hands a dohc:// link to a new dohc process, which finds dohc already
// running and passes the link on. This does the same with the running
// desktop's profile.
async function openLinkInSecondInstance(userDataDir: string, link: string): Promise<void> {
  const env: NodeJS.ProcessEnv = { ...process.env, DOHC_DESKTOP_TEST: "1" };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(
    electronExecutable,
    [
      ...electronLaunchArgs({ mainEntry: join(desktopRoot, "dist/main/main.js"), userDataDir }),
      link,
    ],
    { cwd: desktopRoot, env, stdio: "ignore" },
  );
  const code = await new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", resolve);
  });
  expect(code, "the second dohc should hand the link over and quit").toBe(0);
}

async function expectAddressFilledIn(page: Page): Promise<void> {
  const panel = page.getByTestId("cloud-sync-panel");
  await expect(panel).toBeVisible();
  await expect(panel.getByTestId("cloud-server-url")).toHaveValue(SERVER);
  await expect(panel.getByTestId("cloud-drive")).toHaveCount(0);
  // Any website can open a dohc:// link, so sign-in waits for Connect server.
  await expect(panel.getByTestId("cloud-connect-start")).toBeEnabled();
  await expect(panel.getByTestId("cloud-login-pending")).toHaveCount(0);
}

test("a dohc://connect link fills in the server on first run and in an open workspace", async () => {
  test.setTimeout(120_000);
  const temp = await createTempWorkspace();
  let desktop: Awaited<ReturnType<typeof launchDesktopApp>> | undefined;
  try {
    desktop = await launchDesktopApp({ workspace: temp });
    const userDataDir = join(temp.baseDir, "electron-user-data");
    const link = buildConnectServerUrl(SERVER);
    await expect(desktop.page.getByTestId("first-run-open-share")).toBeVisible();

    await openLinkInSecondInstance(userDataDir, link);
    await expectAddressFilledIn(desktop.page);
    await desktop.page.screenshot({ path: test.info().outputPath("first-run.png") });
    await desktop.page.keyboard.press("Escape");
    await expect(desktop.page.getByTestId("cloud-sync-panel")).toHaveCount(0);

    await openWorkspaceFromFirstRun(desktop.page, temp);
    await openLinkInSecondInstance(userDataDir, link);
    await expectAddressFilledIn(desktop.page);
    await desktop.page.screenshot({ path: test.info().outputPath("workspace.png") });
    expect(desktop.logs.filter((entry) => entry.level === "pageerror")).toEqual([]);
  } finally {
    await cleanupDesktopWorkspace(desktop, temp);
  }
});
