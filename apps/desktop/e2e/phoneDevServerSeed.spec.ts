import { activityPin, settingsNavPin } from "../src/testPins";
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { test, expect, type APIResponse } from "@playwright/test";
import { launchDesktopApp, type LaunchedDesktopApp } from "./helpers/desktopApp";
import { openDesktopApproval, trustFixtureCa } from "./helpers/selfHostOnboarding";
import { cleanupDesktopWorkspace, createTempWorkspace, openWorkspaceFromFirstRun, type TempWorkspace } from "./helpers/workspace";

// The phone's server round seeds its workspace through this spec. It signs a desktop in to the development server
// with an account the round made, turns sync on for a new workspace, prints `READY <home> <root> <workspaceId>`, and
// keeps the desktop open while the round's CLI writes to it. It ends when the round creates the stop file.
//
// DOHC_PHONE_DEV_SERVER          the server's origin, such as https://127.0.0.1:1791
// DOHC_PHONE_DEV_SERVER_CA       the test certificate authority's PEM file
// DOHC_PHONE_DEV_SERVER_ACCOUNT  a 0600 JSON file: {"email", "password", "bearer"}, the bearer a session of that account
// DOHC_PHONE_DEV_SERVER_READY    the file the READY line goes to
// DOHC_PHONE_DEV_SERVER_STOP     the file whose existence ends the spec
test.skip(!process.env.DOHC_PHONE_DEV_SERVER, "Runs in the phone's server round, which sets DOHC_PHONE_DEV_SERVER.");

const HOLD_MS = 2 * 60 * 60 * 1000;

interface SeedAccount { email: string; password: string; bearer: string }

function setting(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`The round sets ${name}.`);
  return value;
}

async function readAccount(path: string): Promise<SeedAccount> {
  const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
  if (typeof parsed !== "object" || parsed === null) throw new Error("The account file holds no JSON object.");
  const { email, password, bearer } = parsed as Record<string, unknown>;
  if (typeof email !== "string" || typeof password !== "string" || typeof bearer !== "string") {
    throw new Error("The account file needs email, password, and bearer as strings.");
  }
  return { email, password, bearer };
}

/** The workspace's entry in the account's workspace list, as the phone reads it, or null. */
async function listedWorkspace(response: APIResponse, workspaceId: string) {
  if (!response.ok()) return null;
  const body: unknown = await response.json();
  const workspaces = typeof body === "object" && body !== null ? (body as { workspaces?: unknown }).workspaces : undefined;
  if (!Array.isArray(workspaces)) return null;
  const entry: unknown = workspaces.find((item: unknown) => typeof item === "object" && item !== null && (item as { workspaceId?: unknown }).workspaceId === workspaceId);
  if (typeof entry !== "object" || entry === null) return null;
  const { canOpen, showOnPhone } = entry as { canOpen?: unknown; showOnPhone?: unknown };
  return { canOpen, showOnPhone };
}

test("@phone-dev-server seeds a synced workspace for the phone and holds it until the round stops", async ({ playwright, request }) => {
  test.setTimeout(HOLD_MS + 10 * 60 * 1000);
  const origin = setting("DOHC_PHONE_DEV_SERVER");
  const caPath = setting("DOHC_PHONE_DEV_SERVER_CA");
  const readyPath = setting("DOHC_PHONE_DEV_SERVER_READY");
  const stopPath = setting("DOHC_PHONE_DEV_SERVER_STOP");
  const account = await readAccount(setting("DOHC_PHONE_DEV_SERVER_ACCOUNT"));
  // This runner's requests trust the test authority. The desktop gets the same trust from its environment, and the
  // debug engine accepts it only for an HTTPS loopback relay, so the plaintext loopback opt-in is off.
  const trust = trustFixtureCa(await readFile(caPath, "utf8"));
  const trustEnv = { NODE_EXTRA_CA_CERTS: caPath, DOHC_ENGINE_TEST_RELAY_CA_MODE: "1", DOHC_ENGINE_TEST_RELAY_CA_FILE: caPath,
    DOHC_E2E_ALLOW_INSECURE_LOOPBACK_RELAY: "0" };
  const bearer = await playwright.request.newContext({ extraHTTPHeaders: { authorization: `Bearer ${account.bearer}` } });
  let temp: TempWorkspace | undefined;
  let desktop: LaunchedDesktopApp | undefined;
  try {
    temp = await createTempWorkspace();
    desktop = await launchDesktopApp({ workspace: temp, env: trustEnv });
    const { page } = desktop;
    const { workspaceId } = await openWorkspaceFromFirstRun(page, temp);
    await page.getByTestId(activityPin("settings")).click();
    await page.getByTestId(settingsNavPin("cloud")).click();
    await page.getByTestId("settings-cloud-connect").click();
    await expect(page.getByTestId("cloud-sync-panel")).toBeVisible();

    // The account approves the desktop's code as its approval page does: sign in, claim the code, then approve it.
    const approvalUrl = await openDesktopApproval(desktop, null, origin);
    const userCode = new URL(approvalUrl).searchParams.get("user_code");
    expect(userCode).toBeTruthy();
    const headers = { origin };
    expect((await request.post(`${origin}/api/auth/sign-in/email`, { headers, data: { email: account.email, password: account.password } })).status()).toBe(200);
    expect((await request.get(approvalUrl, { maxRedirects: 0 })).status()).toBe(200);
    expect((await request.post(`${origin}/api/auth/device/approve`, { headers, data: { userCode } })).status()).toBe(200);
    await expect(page.getByTestId("settings-row-account")).toContainText(account.email, { timeout: 60_000 });

    const syncSwitch = page.getByRole("switch", { name: "Sync this workspace" });
    await syncSwitch.click();
    await expect(syncSwitch).toHaveAttribute("aria-checked", "true");
    await expect(page.getByTestId("cloud-sync-code")).toBeVisible();
    await page.keyboard.press("Escape");

    // The phone opens only a workspace its list marks canOpen, and lists only those that show on the phone.
    await expect.poll(async () => listedWorkspace(await bearer.get(`${origin}/sync/account/workspaces`), workspaceId), {
      message: "The account's workspace list should offer the workspace to the phone.", timeout: 60_000, intervals: [1_000],
    }).toEqual({ canOpen: true, showOnPhone: true });

    const ready = `READY ${temp.homeDir} ${temp.rootPath} ${workspaceId}`;
    await writeFile(readyPath, `${ready}\n`, { mode: 0o600 });
    process.stdout.write(`${ready}\n`);

    await expect.poll(() => existsSync(stopPath), {
      message: "The round should create the stop file.", timeout: HOLD_MS, intervals: [5_000],
    }).toBe(true);
  } finally {
    await cleanupDesktopWorkspace(desktop, temp ?? { cleanup: async () => undefined });
    await bearer.dispose();
    trust.restore();
  }
});
