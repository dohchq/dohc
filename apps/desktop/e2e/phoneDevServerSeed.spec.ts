import { activityPin, settingsNavPin } from "../src/testPins";
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { test, expect } from "@playwright/test";
import { launchDesktopApp, type LaunchedDesktopApp } from "./helpers/desktopApp";
import { openDesktopApproval, trustFixtureCa } from "./helpers/selfHostOnboarding";
import { cleanupDesktopWorkspace, createTempWorkspace, openWorkspaceFromFirstRun, type TempWorkspace } from "./helpers/workspace";

// The phone's server round seeds its workspace through this spec. It signs a desktop in to the development server
// with an account the round made, turns sync on for a new workspace, prints `READY <home> <root> <workspaceId>`, and
// keeps the desktop open while the round's CLI writes to it. It ends when the round creates the stop file.
//
// DOHC_PHONE_DEV_SERVER          the server's origin, such as https://127.0.0.1:1791
// DOHC_PHONE_DEV_SERVER_CA       optional: a test certificate authority's PEM file, for a server without a public one
// DOHC_PHONE_DEV_SERVER_ACCOUNT  a 0600 JSON file: {"email", "password", "bearer"}, the bearer a session of that account
// DOHC_PHONE_DEV_SERVER_READY    the file the READY line goes to
// DOHC_PHONE_DEV_SERVER_STOP     the file whose existence ends the spec
test.skip(!process.env.DOHC_PHONE_DEV_SERVER, "Runs in the phone's server round, which sets DOHC_PHONE_DEV_SERVER.");
// A trace records every Playwright request with its headers and body, so the account's calls use fetch and no trace
// is kept.
test.use({ trace: "off" });

const HOLD_MS = 2 * 60 * 60 * 1000;

interface SeedAccount { email: string; password: string; bearer: string }

function setting(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`The round sets ${name}.`);
  return value;
}

async function readAccount(path: string): Promise<SeedAccount> {
  let parsed: unknown;
  // JSON.parse quotes the text around a mistake, which would put part of the password in the report.
  try { parsed = JSON.parse(await readFile(path, "utf8")); } catch { throw new Error("The account file is not valid JSON."); }
  if (typeof parsed !== "object" || parsed === null) throw new Error("The account file holds no JSON object.");
  const { email, password, bearer } = parsed as Record<string, unknown>;
  if (typeof email !== "string" || typeof password !== "string" || typeof bearer !== "string") {
    throw new Error("The account file needs email, password, and bearer as strings.");
  }
  return { email, password, bearer };
}

/** One request with the account's credentials. Its error names the step and the status, never a header or body. */
async function call(step: string, url: string, init: RequestInit): Promise<Response> {
  try { return await fetch(url, { ...init, redirect: "manual" }); } catch { throw new Error(`${step}: the server could not be reached.`); }
}

function expectStatus(step: string, response: Response, status: number) {
  if (response.status !== status) throw new Error(`${step}: the server answered ${response.status}, not ${status}.`);
}

/** The workspace's entry in the account's workspace list, as the phone reads it, or null. */
async function listedWorkspace(response: Response, workspaceId: string) {
  if (!response.ok) return null;
  const body: unknown = await response.json();
  const workspaces = typeof body === "object" && body !== null ? (body as { workspaces?: unknown }).workspaces : undefined;
  if (!Array.isArray(workspaces)) return null;
  const entry: unknown = workspaces.find((item: unknown) => typeof item === "object" && item !== null && (item as { workspaceId?: unknown }).workspaceId === workspaceId);
  if (typeof entry !== "object" || entry === null) return null;
  const { canOpen, showOnPhone } = entry as { canOpen?: unknown; showOnPhone?: unknown };
  return { canOpen, showOnPhone };
}

test("@phone-dev-server seeds a synced workspace for the phone and holds it until the round stops", async () => {
  test.setTimeout(HOLD_MS + 10 * 60 * 1000);
  const origin = setting("DOHC_PHONE_DEV_SERVER");
  const caPath = process.env.DOHC_PHONE_DEV_SERVER_CA;
  const readyPath = setting("DOHC_PHONE_DEV_SERVER_READY");
  const stopPath = setting("DOHC_PHONE_DEV_SERVER_STOP");
  const account = await readAccount(setting("DOHC_PHONE_DEV_SERVER_ACCOUNT"));
  // With a test authority, this runner's requests trust it. The desktop gets the same trust from its environment, and
  // the debug engine accepts it only for an HTTPS loopback relay, so the plaintext loopback opt-in is off.
  const trust = caPath ? trustFixtureCa(await readFile(caPath, "utf8")) : undefined;
  const trustEnv = caPath ? { NODE_EXTRA_CA_CERTS: caPath, DOHC_ENGINE_TEST_RELAY_CA_MODE: "1", DOHC_ENGINE_TEST_RELAY_CA_FILE: caPath,
    DOHC_E2E_ALLOW_INSECURE_LOOPBACK_RELAY: "0" } : {};
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
    const json = { origin, "content-type": "application/json" };
    const signIn = await call("Sign-in", `${origin}/api/auth/sign-in/email`, { method: "POST", headers: json,
      body: JSON.stringify({ email: account.email, password: account.password }) });
    expectStatus("Sign-in", signIn, 200);
    const cookie = signIn.headers.getSetCookie().map((value) => value.split(";")[0]).join("; ");
    expectStatus("Claiming the code", await call("Claiming the code", approvalUrl, { headers: { cookie } }), 200);
    expectStatus("Approval", await call("Approval", `${origin}/api/auth/device/approve`, { method: "POST",
      headers: { ...json, cookie }, body: JSON.stringify({ userCode }) }), 200);
    await expect(page.getByTestId("settings-row-account")).toContainText(account.email, { timeout: 60_000 });

    const syncSwitch = page.getByRole("switch", { name: "Sync this workspace" });
    await syncSwitch.click();
    await expect(syncSwitch).toHaveAttribute("aria-checked", "true");
    await expect(page.getByTestId("cloud-sync-code")).toBeVisible();
    await page.keyboard.press("Escape");

    // The phone opens only a workspace its list marks canOpen, and lists only those that show on the phone.
    const bearer = { authorization: `Bearer ${account.bearer}` };
    await expect.poll(async () => listedWorkspace(await call("The workspace list", `${origin}/sync/account/workspaces`, { headers: bearer }), workspaceId), {
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
    trust?.restore();
  }
});
