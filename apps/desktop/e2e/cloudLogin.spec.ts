import { expect, test } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { launchApp } from "./launch";

// Drives the REAL device-authorization flow end to end: the desktop asks the
// live workspace-api (Better Auth on Postgres — `pnpm dev:postgres` must have
// run) for a device code, the "browser approval" happens through the
// double-gated DOHC_TEST_AUTH seam, and the desktop polls its way to a
// connected session. Mocking the flow client-side is a test-quality failure —
// this spec boots the actual server.

const PORT = 17891;
const SERVER_URL = `http://localhost:${PORT}`;
let server: ChildProcess;

async function waitForHealth(timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const response = await fetch(`${SERVER_URL}/health`);
      if (response.ok) return;
    } catch {
      // not up yet
    }
    if (Date.now() > deadline) {
      throw new Error(
        `workspace-api did not become healthy on :${PORT} — is Postgres up? (pnpm dev:postgres)`,
      );
    }
    await new Promise((r) => setTimeout(r, 500));
  }
}

test.beforeAll(async () => {
  server = spawn(
    process.execPath,
    [join(process.cwd(), "node_modules/tsx/dist/cli.mjs"), "src/main.ts"],
    {
      cwd: join(process.cwd(), "services/workspace-api"),
      env: {
        ...process.env,
        DOHC_TEST_AUTH: "1",
        WORKSPACE_API_PORT: String(PORT),
      },
      stdio: "ignore",
    },
  );
  await waitForHealth();
});

test.afterAll(() => {
  // Our own child from this run — terminate by handle, never by pattern.
  server?.kill("SIGTERM");
});

async function seededWorkspace(): Promise<{ home: string; root: string }> {
  const home = await mkdtemp(join(tmpdir(), "dohc-cloud-home-"));
  const root = join(await mkdtemp(join(tmpdir(), "dohc-cloud-")), "workspace");
  await mkdir(join(root, ".dohc"), { recursive: true });
  await writeFile(
    join(root, ".dohc", "manifest.json"),
    JSON.stringify({ version: 1, workspaceId: "cloud-ws", kind: "personal", mode: "local-first" }),
  );
  return { home, root };
}

test("device-flow login connects, survives relaunch, and disconnects", async () => {
  const { home, root } = await seededWorkspace();
  const env = {
    DOHC_TEST_HOME: home,
    DOHC_TEST_PICK_PATH: root,
    DOHC_CLOUD_URL: SERVER_URL,
  };

  const app = await launchApp(env);
  const page = await app.firstWindow();
  await page.getByRole("button", { name: /open an existing folder/i }).click();
  await expect(page.getByTestId("workspace-shell")).toBeVisible();

  // 1. Open the cloud panel and start the device flow.
  await page.getByRole("button", { name: /connect dohc cloud/i }).click();
  await expect(page.getByTestId("cloud-sync-panel")).toBeVisible();
  await page.getByTestId("cloud-connect-start").click();
  const userCode = (await page.getByTestId("cloud-user-code").textContent({ timeout: 15_000 }))
    ?.trim();
  expect(userCode).toBeTruthy();

  // 2. "Browser approval" via the server's double-gated test seam.
  const approve = await fetch(`${SERVER_URL}/test/device/approve`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ userCode }),
  });
  expect(approve.ok).toBe(true);

  // 3. The desktop's poll loop lands the session; the renderer shows who.
  await expect(page.getByTestId("cloud-connected-email")).toHaveText(
    "e2e-test-user@dohc.test",
    { timeout: 20_000 },
  );
  await app.close();

  // 4. The session persists across relaunch (encrypted credential store).
  // A returning user lands directly in the shell — no first-run screen.
  const second = await launchApp(env);
  const page2 = await second.firstWindow();
  await expect(page2.getByTestId("workspace-shell")).toBeVisible();
  await page2.getByRole("button", { name: /connect dohc cloud/i }).click();
  await expect(page2.getByTestId("cloud-connected-email")).toHaveText(
    "e2e-test-user@dohc.test",
  );

  // 5. Disconnect returns to the connect affordance.
  await page2.getByTestId("cloud-disconnect").click();
  await expect(page2.getByTestId("cloud-connect-start")).toBeVisible();
  await second.close();
});
