import { expect, test } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ElectronApplication, Page } from "playwright";
import { launchApp, stopChildProcess, tsxChildEnv } from "./launch";

const PORT = 17894;
const SERVER_URL = `http://localhost:${PORT}`;
const SERVICE_START_TIMEOUT_MS = 300_000;
const SCREENSHOT_DIR = "test-results/screenshots/e5-workspace-management";

let server: ChildProcess;
let activeApp: ElectronApplication | null = null;

async function waitForHealth(timeoutMs = SERVICE_START_TIMEOUT_MS): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      if ((await fetch(`${SERVER_URL}/health`)).ok) return;
    } catch {
      // not up yet
    }
    if (Date.now() > deadline) {
      throw new Error(`workspace-api not healthy on :${PORT} — run pnpm dev:postgres first`);
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

test.beforeAll(async () => {
  test.setTimeout(SERVICE_START_TIMEOUT_MS);
  server = spawn(
    process.execPath,
    [join(process.cwd(), "node_modules/tsx/dist/cli.mjs"), "src/main.ts"],
    {
      cwd: join(process.cwd(), "services/workspace-api"),
      env: {
        ...process.env,
        ...tsxChildEnv(),
        DOHC_TEST_AUTH: "1",
        NODE_ENV: "test",
        WORKSPACE_API_PORT: String(PORT),
      },
      stdio: "ignore",
    },
  );
  await waitForHealth();
});

test.afterEach(async () => {
  await activeApp?.close().catch(() => undefined);
  activeApp = null;
});

test.afterAll(async () => {
  await stopChildProcess(server);
});

async function seedWorkspace(): Promise<{
  home: string;
  root: string;
  workspaceId: string;
}> {
  const workspaceId = `workspace-management-e2e-${Date.now()}`;
  const home = await mkdtemp(join(tmpdir(), "dohc-members-home-"));
  const root = join(await mkdtemp(join(tmpdir(), "dohc-members-")), "workspace");
  await mkdir(join(root, ".dohc"), { recursive: true });
  await writeFile(
    join(root, ".dohc", "manifest.json"),
    JSON.stringify({
      version: 1,
      workspaceId,
      kind: "personal",
      mode: "local-first",
    }),
  );
  await writeFile(join(root, "plan.md"), "# Team plan\n");
  return { home, root, workspaceId };
}

async function approveDeviceLogin(page: Page, email: string): Promise<void> {
  await page.getByRole("button", { name: /connect dohc cloud/i }).click();
  await page.getByTestId("cloud-connect-start").click();
  const userCode = (await page.getByTestId("cloud-user-code").textContent({
    timeout: 15_000,
  }))?.trim();
  expect(userCode).toBeTruthy();
  const approved = await fetch(`${SERVER_URL}/test/device/approve`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ userCode, email }),
  });
  expect(approved.ok).toBe(true);
  await expect(page.getByTestId("cloud-connected-email")).toContainText(email, {
    timeout: 20_000,
  });
}

async function openSyncedWorkspace(home: string, root: string, email: string) {
  const app = await launchApp({
    DOHC_TEST_HOME: home,
    DOHC_TEST_PICK_PATH: root,
    DOHC_CLOUD_URL: SERVER_URL,
  });
  activeApp = app;
  const page = await app.firstWindow();
  await page.getByRole("button", { name: /open an existing folder/i }).click();
  await expect(page.getByTestId("workspace-shell")).toBeVisible();
  await approveDeviceLogin(page, email);
  await page.getByTestId("cloud-enable-sync").click();
  await expect(page.getByTestId("cloud-workspace-synced")).toBeVisible({
    timeout: 30_000,
  });
  return { app, page };
}

async function setTheme(page: Page, scheme: "light" | "dark") {
  await page.emulateMedia({ colorScheme: scheme });
  await expect
    .poll(() => page.evaluate(() => document.documentElement.dataset.theme))
    .toBe(scheme);
}

async function shot(page: Page, name: string): Promise<void> {
  await mkdir(SCREENSHOT_DIR, { recursive: true });
  const { width, height } = page.viewportSize() ?? { width: 0, height: 0 };
  const scheme = await page.evaluate(() =>
    document.documentElement.dataset.theme === "dark" ? "dark" : "light",
  );
  await page.screenshot({
    path: `${SCREENSHOT_DIR}/${name}--${width}x${height}--${scheme}.png`,
  });
}

test("workspace management lists cloud members, creates pending invites, and revokes them", async () => {
  test.setTimeout(180_000);
  const { home, root } = await seedWorkspace();
  const unique = Date.now();
  const ownerEmail = `e5-members-owner-${unique}@dohc.test`;
  const inviteEmail = `e5-members-invite-${unique}@dohc.test`;
  const { page } = await openSyncedWorkspace(home, root, ownerEmail);

  await page.getByTestId("cloud-manage-workspace").click();
  const dialog = page.getByTestId("workspace-management-dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog.getByTestId("workspace-member-row")).toContainText(ownerEmail);

  await dialog.getByTestId("workspace-invite-email").fill(inviteEmail);
  await dialog.getByTestId("workspace-invite-submit").click();
  await expect(dialog.getByTestId("workspace-management-message")).toContainText(
    `Invitation sent to ${inviteEmail}.`,
  );
  await expect(dialog.getByTestId("workspace-invite-row")).toContainText(inviteEmail);

  for (const size of [
    { width: 1280, height: 800 },
    { width: 1536, height: 960 },
  ]) {
    await page.setViewportSize(size);
    await setTheme(page, "light");
    await shot(page, "workspace-management-dialog");
    await setTheme(page, "dark");
    await shot(page, "workspace-management-dialog");
  }

  await dialog.getByTestId("workspace-revoke-invite").click();
  await expect(dialog.getByTestId("workspace-management-message")).toContainText(
    `Revoked invite for ${inviteEmail}.`,
  );
  await expect(dialog.getByTestId("workspace-invite-row")).toHaveCount(0);
});
