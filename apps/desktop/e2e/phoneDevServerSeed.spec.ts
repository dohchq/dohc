import { activityPin, settingsNavPin } from "../src/testPins";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test, expect } from "@playwright/test";
import { createRecord, editCell, fieldCells } from "./helpers/dataCollection";
import { launchDesktopApp, type LaunchedDesktopApp } from "./helpers/desktopApp";
import { openDesktopApproval, trustFixtureCa } from "./helpers/selfHostOnboarding";
import {
  cleanupDesktopWorkspace,
  createTempWorkspace,
  openExplorerHome,
  openWorkspaceFromFirstRun,
  type TempWorkspace,
} from "./helpers/workspace";

// The phone's server round seeds its workspace through this spec. It signs a desktop in to the server with the
// round's account, opens the round's workspace, records its ID, turns sync on, writes the page Plan in the editor,
// makes a Collection with one record, prints `READY <home> <root> <workspaceId>`, and keeps the desktop open while the
// round's CLI writes to it. It ends when the round creates the stop file. The root's last segment is the workspace's
// name, so it may hold spaces; the home and the ID don't.
//
// The workspace is the round's fixture, kept between rounds so the account gains one workspace, not one per round.
// The spec reopens it and makes only what is missing: Plan, the Collection and its record. Show on phone is turned
// on again for it, since the round turns it off at its end.
//
// DOHC_PHONE_DEV_SERVER             the server's origin, such as https://127.0.0.1:1791
// DOHC_PHONE_DEV_SERVER_FIXTURE     the round's folder for the workspace: its dohc home in home/, its root in
//                                   <workspace name>/, and its ID in workspace-id, written before sync is turned on
// DOHC_PHONE_DEV_SERVER_CA          optional: a test certificate authority's PEM file, for a server without a public one
// DOHC_PHONE_DEV_SERVER_ACCOUNT     a 0600 JSON file: {"email", "bearer"} and, optionally, "password", the bearer a
//                                   session of that account. With a password, the spec approves the desktop's sign-in
//                                   itself. Without one, a person approves it.
// DOHC_PHONE_DEV_SERVER_CODE        without a password: the file the desktop's sign-in code goes to, for the person
// DOHC_PHONE_DEV_SERVER_WORKSPACE   the workspace's name, which its folder takes
// DOHC_PHONE_DEV_SERVER_SENTENCE    the sentence the page Plan holds
// DOHC_PHONE_DEV_SERVER_COLLECTION  the Collection's name. Its primary field is the text field Name; no field is
//                                   required, so the phone can add a record with the defaults.
// DOHC_PHONE_DEV_SERVER_RECORD      the Name of the Collection's one record
// DOHC_PHONE_DEV_SERVER_READY       the file the READY line goes to
// DOHC_PHONE_DEV_SERVER_STOP        the file whose existence ends the spec
test.skip(
  !process.env.DOHC_PHONE_DEV_SERVER,
  "Runs in the phone's server round, which sets DOHC_PHONE_DEV_SERVER.",
);
// A trace records every Playwright request with its headers and body, so the account's calls use fetch and no trace
// is kept. A screenshot or video can show the server's address on Cloud settings, so none is kept either.
test.use({ trace: "off", screenshot: "off", video: "off" });

const HOLD_MS = 2 * 60 * 60 * 1000;
const APPROVAL_MS = 10 * 60 * 1000;

interface SeedAccount {
  email: string;
  password: string | undefined;
  bearer: string;
}

function setting(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`The round sets ${name}.`);
  return value;
}

async function readAccount(path: string): Promise<SeedAccount> {
  let parsed: unknown;
  // JSON.parse quotes the text around a mistake, which would put part of the password in the report.
  try {
    parsed = JSON.parse(await readFile(path, "utf8"));
  } catch {
    throw new Error("The account file is not valid JSON.");
  }
  if (typeof parsed !== "object" || parsed === null)
    throw new Error("The account file holds no JSON object.");
  const { email, password, bearer } = parsed as Record<string, unknown>;
  if (
    typeof email !== "string" ||
    typeof bearer !== "string" ||
    (password !== undefined && typeof password !== "string")
  ) {
    throw new Error("The account file needs email and bearer, and any password, as strings.");
  }
  return { email, password, bearer };
}

function folderName(name: string): string {
  if (
    name !== name.trim() ||
    name === "." ||
    name === ".." ||
    !/^[^/\\\0-\x1f]{1,100}$/u.test(name)
  )
    throw new Error("DOHC_PHONE_DEV_SERVER_WORKSPACE is not a folder name.");
  return name;
}

/** One request with the account's credentials. Its error names the step and the status, never a header or body. */
async function call(step: string, url: string, init: RequestInit): Promise<Response> {
  try {
    return await fetch(url, { ...init, redirect: "manual" });
  } catch {
    throw new Error(`${step}: the server could not be reached.`);
  }
}

function expectStatus(step: string, response: Response, status: number) {
  if (response.status !== status)
    throw new Error(`${step}: the server answered ${response.status}, not ${status}.`);
}

async function listedWorkspace(response: Response, workspaceId: string) {
  if (!response.ok) return null;
  const body: unknown = await response.json();
  const workspaces =
    typeof body === "object" && body !== null
      ? (body as { workspaces?: unknown }).workspaces
      : undefined;
  if (!Array.isArray(workspaces)) return null;
  const entry: unknown = workspaces.find(
    (item: unknown) =>
      typeof item === "object" &&
      item !== null &&
      (item as { workspaceId?: unknown }).workspaceId === workspaceId,
  );
  if (typeof entry !== "object" || entry === null) return null;
  const { canOpen, showOnPhone } = entry as { canOpen?: unknown; showOnPhone?: unknown };
  return { canOpen, showOnPhone };
}

async function listedCollections(response: Response): Promise<string[] | null> {
  if (!response.ok) return null;
  const body: unknown = await response.json();
  const result =
    typeof body === "object" && body !== null && (body as { ok?: unknown }).ok === true
      ? (body as { result?: unknown }).result
      : undefined;
  const collections =
    typeof result === "object" && result !== null
      ? (result as { collections?: unknown }).collections
      : undefined;
  if (!Array.isArray(collections)) return null;
  return collections.map((item: unknown) =>
    typeof item === "object" && item !== null ? String((item as { name?: unknown }).name) : "",
  );
}

test("@phone-dev-server seeds a synced workspace for the phone and holds it until the round stops", async () => {
  test.setTimeout(HOLD_MS + 10 * 60 * 1000);
  const origin = setting("DOHC_PHONE_DEV_SERVER");
  // The runner sends the account's password to this origin.
  if (new URL(origin).protocol !== "https:") throw new Error("The server origin must be https.");
  const caPath = process.env.DOHC_PHONE_DEV_SERVER_CA;
  const readyPath = setting("DOHC_PHONE_DEV_SERVER_READY");
  const stopPath = setting("DOHC_PHONE_DEV_SERVER_STOP");
  const workspaceName = folderName(setting("DOHC_PHONE_DEV_SERVER_WORKSPACE"));
  const sentence = setting("DOHC_PHONE_DEV_SERVER_SENTENCE");
  const collectionName = setting("DOHC_PHONE_DEV_SERVER_COLLECTION");
  const recordName = setting("DOHC_PHONE_DEV_SERVER_RECORD");
  const fixture = setting("DOHC_PHONE_DEV_SERVER_FIXTURE");
  const idPath = join(fixture, "workspace-id");
  const recordedId = existsSync(idPath) ? (await readFile(idPath, "utf8")).trim() : undefined;
  const account = await readAccount(setting("DOHC_PHONE_DEV_SERVER_ACCOUNT"));
  const codePath =
    account.password === undefined ? setting("DOHC_PHONE_DEV_SERVER_CODE") : undefined;
  // The harness allows a plaintext loopback relay by default; this server is HTTPS, so that is off. With a test
  // authority, this runner's requests trust it, and the desktop gets the same trust from its environment. The debug
  // engine accepts that authority only for an HTTPS loopback relay.
  const trust = caPath ? trustFixtureCa(await readFile(caPath, "utf8")) : undefined;
  const trustEnv = {
    DOHC_E2E_ALLOW_INSECURE_LOOPBACK_RELAY: "0",
    ...(caPath
      ? {
          NODE_EXTRA_CA_CERTS: caPath,
          DOHC_ENGINE_TEST_RELAY_CA_MODE: "1",
          DOHC_ENGINE_TEST_RELAY_CA_FILE: caPath,
        }
      : {}),
  };
  let temp: TempWorkspace | undefined;
  let desktop: LaunchedDesktopApp | undefined;
  try {
    const scratch = await createTempWorkspace();
    const homeDir = join(fixture, "home");
    const rootPath = join(fixture, workspaceName);
    await mkdir(homeDir, { recursive: true, mode: 0o700 });
    await mkdir(rootPath, { recursive: true });
    temp = { ...scratch, homeDir, rootPath };
    // Electron's mock keychain keeps the sign-in's safe-storage key out of the Mac's login keychain.
    desktop = await launchDesktopApp({
      workspace: temp,
      env: trustEnv,
      switches: process.platform === "darwin" ? ["--use-mock-keychain"] : [],
    });
    const { page } = desktop;
    const { workspaceId } = await openWorkspaceFromFirstRun(page, temp);
    if (recordedId === undefined)
      await writeFile(idPath, `${workspaceId}\n`, { flag: "wx", mode: 0o600 });
    else if (recordedId !== workspaceId)
      throw new Error("The fixture's workspace opened with an ID other than the one it recorded.");
    await page.getByTestId(activityPin("settings")).click();
    await page.getByTestId(settingsNavPin("cloud")).click();
    await page.getByTestId("settings-cloud-connect").click();
    await expect(page.getByTestId("cloud-sync-panel")).toBeVisible();

    const approvalUrl = await openDesktopApproval(desktop, null, origin);
    const userCode = new URL(approvalUrl).searchParams.get("user_code");
    expect(userCode).toBeTruthy();
    if (codePath) {
      await writeFile(codePath, `${userCode}\n`, { mode: 0o600 });
    } else {
      const json = { origin, "content-type": "application/json" };
      const signIn = await call("Sign-in", `${origin}/api/auth/sign-in/email`, {
        method: "POST",
        headers: json,
        body: JSON.stringify({ email: account.email, password: account.password }),
      });
      expectStatus("Sign-in", signIn, 200);
      const cookie = signIn.headers
        .getSetCookie()
        .map((value) => value.split(";")[0])
        .join("; ");
      expectStatus(
        "Claiming the code",
        await call("Claiming the code", approvalUrl, { headers: { cookie } }),
        200,
      );
      expectStatus(
        "Approval",
        await call("Approval", `${origin}/api/auth/device/approve`, {
          method: "POST",
          headers: { ...json, cookie },
          body: JSON.stringify({ userCode }),
        }),
        200,
      );
    }
    await expect(page.getByTestId("settings-row-account")).toContainText(account.email, {
      timeout: codePath ? APPROVAL_MS : 60_000,
    });

    const syncSwitch = page.getByRole("switch", { name: "Sync this workspace" });
    if ((await syncSwitch.getAttribute("aria-checked")) !== "true") await syncSwitch.click();
    await expect(syncSwitch).toHaveAttribute("aria-checked", "true");
    await expect(page.getByTestId("cloud-sync-code")).toBeVisible();
    await page.keyboard.press("Escape");

    const plan = await readFile(join(rootPath, "Plan.md"), "utf8").catch(() => null);
    if (plan === null) {
      await page.keyboard.press("ControlOrMeta+n");
      await expect(page.getByLabel("Page title")).toBeFocused();
      await page.keyboard.type("Plan");
      await page.keyboard.press("Enter");
      await page.keyboard.type(sentence);
      await expect
        .poll(() => readFile(join(rootPath, "Plan.md"), "utf8").catch(() => ""), {
          message: "Plan.md should hold the sentence.",
          timeout: 30_000,
        })
        .toContain(sentence);
      await expect(page.getByTestId("markdown-save-state")).toHaveAttribute("data-state", "saved");
    } else {
      await page.getByTestId("titlebar-quick-open").click();
      const quickOpen = page.getByTestId("quick-open");
      await quickOpen.getByLabel("File").fill("Plan.md");
      await quickOpen.getByRole("option", { name: "Plan.md", exact: true }).click();
      const editor = page.getByTestId("markdown-editor");
      await expect(editor).toBeVisible();
      const saveState = page.getByTestId("markdown-save-state");
      await expect(saveState).toHaveAttribute("data-state", /^(saved|saved-to-host|error)$/, {
        timeout: 60_000,
      });
      const failed = (await saveState.getAttribute("data-state")) === "error";
      if (failed || !((await editor.textContent()) ?? "").includes(sentence)) {
        await editor.click();
        await page.keyboard.press("ControlOrMeta+a");
        await page.keyboard.type(sentence);
        await expect(editor).toContainText(sentence);
        await expect
          .poll(() => readFile(join(rootPath, "Plan.md"), "utf8").catch(() => ""), {
            message: "Plan.md should hold the sentence again.",
            timeout: 30_000,
          })
          .toContain(sentence);
        await expect(saveState).toHaveAttribute("data-state", /^saved(-to-host)?$/);
      }
      await page.keyboard.press("Escape");
    }

    const collection = page.getByRole("region", { name: collectionName, exact: true });
    if (!existsSync(join(rootPath, collectionName, "dataset.json"))) {
      await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
      await page.keyboard.press("ControlOrMeta+k");
      await expect(page.getByTestId("command-palette")).toBeVisible();
      await page
        .getByTestId("command-palette")
        .getByRole("option", { name: "New collection", exact: true })
        .click();
      const create = page.getByTestId("new-collection-dialog");
      await create.getByLabel("Collection name").fill(collectionName);
      await create.getByRole("button", { name: "Add field", exact: true }).click();
      await create.getByLabel("Field name", { exact: true }).nth(1).fill("Date");
      await create.getByLabel("Field type", { exact: true }).nth(1).selectOption("date");
      await expect(create.getByLabel("Require Name", { exact: true })).not.toBeChecked();
      await expect(create.getByLabel("Require Date", { exact: true })).not.toBeChecked();
      await create.getByTestId("new-collection-create").click();
      await expect(create).toBeHidden();
    } else {
      await openExplorerHome(page);
      await page
        .getByRole("region", { name: "Collections", exact: true })
        .getByRole("button", { name: collectionName, exact: true })
        .click();
    }
    await expect(collection).toHaveAttribute("aria-busy", "false");
    const names = await fieldCells(collection, "Name");
    const seeded = names.getByText(recordName, { exact: true });
    const changed = names
      .filter({ hasText: new RegExp(`^${recordName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}.+`) })
      .first();
    if ((await seeded.count()) === 0 && (await changed.count()) > 0) {
      await editCell(collection, changed, recordName);
    }
    if ((await seeded.count()) === 0) await createRecord(collection, recordName);
    await expect(seeded).toHaveCount(1);

    const bearer = { authorization: `Bearer ${account.bearer}` };
    const listed = async () =>
      listedWorkspace(
        await call("The workspace list", `${origin}/sync/account/workspaces`, { headers: bearer }),
        workspaceId,
      );
    await expect
      .poll(async () => (await listed())?.canOpen, {
        message: "The account's workspace list should let the phone open the workspace.",
        timeout: 60_000,
        intervals: [1_000],
      })
      .toBe(true);
    if ((await listed())?.showOnPhone !== true) {
      const showOnPhone = await call(
        "Show on phone",
        `${origin}/sync/account/workspaces/${encodeURIComponent(workspaceId)}`,
        {
          method: "PATCH",
          headers: { ...bearer, "content-type": "application/json" },
          body: JSON.stringify({ showOnPhone: true }),
        },
      );
      expectStatus("Show on phone", showOnPhone, 200);
    }
    await expect
      .poll(listed, {
        message: "The account's workspace list should offer the workspace to the phone.",
        timeout: 60_000,
        intervals: [1_000],
      })
      .toEqual({ canOpen: true, showOnPhone: true });
    await expect
      .poll(
        async () =>
          listedCollections(
            await call(
              "The Collection list",
              `${origin}/sync/${encodeURIComponent(workspaceId)}/ops/collections`,
              {
                method: "POST",
                headers: { ...bearer, "content-type": "application/json" },
                body: "{}",
              },
            ),
          ),
        {
          message: `The phone's Collection list should offer ${collectionName}.`,
          timeout: 180_000,
          intervals: [2_000],
        },
      )
      .toContain(collectionName);

    const ready = `READY ${temp.homeDir} ${temp.rootPath} ${workspaceId}`;
    await writeFile(readyPath, `${ready}\n`, { mode: 0o600 });
    process.stdout.write(`${ready}\n`);

    await expect
      .poll(() => existsSync(stopPath), {
        message: "The round should create the stop file.",
        timeout: HOLD_MS,
        intervals: [5_000],
      })
      .toBe(true);
  } finally {
    await cleanupDesktopWorkspace(desktop, temp ?? { cleanup: async () => undefined });
    trust?.restore();
  }
});
