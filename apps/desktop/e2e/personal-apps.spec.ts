import { expect, test } from "@playwright/test";
import { randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import { activityPin, settingsNavPin } from "../src/testPins";
import { launchDesktopApp } from "./helpers/desktopApp";
import { claimRelayWorkspace } from "./helpers/relayPeer";
import { spawnSyncRelay, type SyncRelayHandle } from "./helpers/syncRelay";
import {
  cleanupDesktopWorkspace,
  createTempWorkspace,
  openWorkspaceFromFirstRun,
  seedCloudCredentials,
  seedWorkspaceManifest,
  seedWorkspaceRegistry,
} from "./helpers/workspace";

// A member of a joined workspace builds a Personal app on this computer
// against a Collection the owner granted them, approves it, and opens it in
// the browser. The app runs the granted action as the member. Once the owner
// lets members share apps, the member shares it with the workspace, reviews
// and copies it, and the owner withdraws it.

const OWNER = {
  token: "test:e2e-personal-owner",
  user: "e2e-personal-owner",
  email: "e2e-personal-owner@dohc.test",
};
const MEMBER = {
  token: "test:e2e-personal-ana",
  user: "e2e-personal-ana",
  email: "e2e-personal-ana@dohc.test",
};

const appSource = (operation: string) => `
window.addEventListener("message", (event) => {
  if (event.source !== window.parent || event.data?.kind !== "dohc-app-channel" || event.ports.length !== 1) return;
  const port = event.ports[0];
  port.onmessage = ({ data }) => {
    const out = document.createElement("p");
    out.id = "trips";
    out.textContent = data.ok ? data.value.result.rows.map((row) => Object.values(row.values ?? row).join(" ")).join(", ") : "refused " + data.status;
    document.body.append(out);
  };
  port.postMessage({ id: crypto.randomUUID(), op: "backend.invoke", operation: ${JSON.stringify(operation)}, idempotencyKey: "read-1", input: { limit: 50 } });
});
`;

test("@two-client a member builds, approves, opens, and shares a Personal app on a Collection they can read", async ({
  browser,
}) => {
  test.setTimeout(420_000);
  const ownerTemp = await createTempWorkspace();
  const memberTemp = await createTempWorkspace();
  const workspaceId = "personal-apps";
  const syncEnv = { DOHC_TEST_SYNC_DEBOUNCE_MS: "150", DOHC_TEST_SYNC_BACKOFF_MS: "250" };
  let relay: SyncRelayHandle | null = null;
  let owner: Awaited<ReturnType<typeof launchDesktopApp>> | null = null;
  let member: Awaited<ReturnType<typeof launchDesktopApp>> | null = null;
  const context = await browser.newContext();
  const shot = (name: string) => test.info().outputPath(`${name}.png`);
  try {
    relay = await spawnSyncRelay({
      dbPath: join(ownerTemp.baseDir, "relay", "relay.sqlite"),
      appPublications: true,
      linkBoundary: {
        linkKey: randomBytes(32).toString("base64url"),
        relayExchangeKey: randomBytes(32).toString("base64url"),
        publicViewerOrigin: "https://viewer.example.com",
      },
    });
    await claimRelayWorkspace({ baseUrl: relay.baseUrl, token: OWNER.token, workspaceId });
    await seedWorkspaceManifest(ownerTemp, workspaceId);
    await seedWorkspaceRegistry(ownerTemp, [
      {
        workspaceId,
        rootPath: ownerTemp.rootPath,
        remote: { serverUrl: relay.baseUrl, ownerUserId: OWNER.user },
      },
    ]);
    await seedCloudCredentials(ownerTemp, {
      serverUrl: relay.baseUrl,
      relayUrl: relay.baseUrl,
      email: OWNER.email,
      userId: OWNER.user,
      token: OWNER.token,
    });
    owner = await launchDesktopApp({ workspace: ownerTemp, env: syncEnv });
    const { page } = owner;
    await openWorkspaceFromFirstRun(page, ownerTemp);
    await page.emulateMedia({ reducedMotion: "reduce" });

    // --- The owner makes a Trips Collection with one record ----------------
    await page.keyboard.press("ControlOrMeta+k");
    await page
      .getByTestId("command-palette")
      .getByRole("option", { name: "New Collection", exact: true })
      .click();
    const create = page.getByTestId("new-collection-dialog");
    await create.getByLabel("Collection name").fill("Trips");
    await create.getByTestId("new-collection-create").click();
    await expect(create).toBeHidden();
    const dataset = (input: Record<string, unknown>) =>
      page.evaluate(
        async (request) => window.dohcDesktop!.dataset(request as never) as Promise<unknown>,
        { workspaceId, ...input },
      );
    const tripsPath = async () =>
      (
        (await dataset({ action: "list" })) as {
          datasets: Array<{ datasetPath: string; name: string }>;
        }
      ).datasets.find((entry) => entry.name === "Trips")?.datasetPath;
    await expect.poll(tripsPath).toBeTruthy();
    const datasetPath = (await tripsPath())!;
    const { dataset: trips } = (await dataset({ action: "describe", datasetPath })) as {
      dataset: {
        revision: number;
        revisionSha256: string;
        tables: Array<{ fields: Array<{ fieldId: string; name: string }> }>;
        operations: Array<{ operationId: string; kind: string; name: string }>;
      };
    };
    const nameField = trips.tables[0]!.fields.find((field) => field.name === "Name")!.fieldId;
    const read = trips.operations.find((operation) => operation.kind === "read")!;
    const pinned = { datasetPath, revision: trips.revision, revisionSha256: trips.revisionSha256 };
    await dataset({
      action: "invoke",
      ...pinned,
      operationId: trips.operations.find((operation) => operation.kind === "create")!.operationId,
      input: { values: { [nameField]: "Kyoto" } },
      idempotencyKey: "seed-kyoto",
    });

    // --- The owner adds Ana, who opens the workspace -----------------------
    await page.getByTestId(activityPin("settings")).click();
    await page.getByTestId(settingsNavPin("general")).click();
    await page.getByTestId(settingsNavPin("members")).click();
    const members = page.getByTestId("settings-members-page");
    await members.getByTestId("settings-members-invite-email").fill(MEMBER.email);
    await members.getByTestId("settings-members-invite-send").click();
    await expect(
      members.getByTestId("settings-members-row").filter({ hasText: MEMBER.email }),
    ).toHaveAttribute("data-state", "active");
    await page.getByRole("button", { name: "Close settings", exact: true }).click();
    const { DatabaseSync } = createRequire(import.meta.url)(
      "node:sqlite",
    ) as typeof import("node:sqlite");
    const db = new DatabaseSync(relay.dbPath, { readOnly: true });
    const grant = db
      .prepare(
        "SELECT grant_id FROM sync_relay_share_grants WHERE principal_user_id = ? AND status = 'active'",
      )
      .get(MEMBER.user) as { grant_id: string };
    db.close();
    await dataset({
      action: "setGrant",
      datasetPath,
      grantId: grant.grant_id,
      grant: {
        revision: trips.revision,
        revisionSha256: trips.revisionSha256,
        operationIds: [read.operationId],
        discover: true,
      },
    });

    await seedWorkspaceManifest(memberTemp, "ana-own");
    await seedWorkspaceRegistry(memberTemp, [
      { workspaceId: "ana-own", rootPath: memberTemp.rootPath },
    ]);
    await seedCloudCredentials(memberTemp, {
      serverUrl: relay.baseUrl,
      relayUrl: relay.baseUrl,
      email: MEMBER.email,
      userId: MEMBER.user,
      token: MEMBER.token,
    });
    member = await launchDesktopApp({ workspace: memberTemp, env: syncEnv });
    const mine = member.page;
    await openWorkspaceFromFirstRun(mine, memberTemp);
    await mine.emulateMedia({ reducedMotion: "reduce" });
    if (!(await mine.getByTestId("sharing-view").isVisible()))
      await mine.getByTestId(activityPin("sharing")).click();
    await mine.getByTestId("sharing-lane-received").click();
    const received = mine.getByTestId("sharing-received-row").first();
    await expect(received.getByTestId("sharing-row-who")).toContainText("Member ·", {
      timeout: 60_000,
    });
    await received.locator("[data-sharing-row-focus]").hover();
    await received.getByRole("button", { name: "Share actions" }).click();
    await mine.getByRole("menuitem", { name: "Open", exact: true }).click();
    await mine.getByTestId("open-shared-view").getByTestId("open-share-start").click();
    const joinedId = () =>
      mine.evaluate(async () => {
        const registry = await window.dohcDesktop!.getWorkspaceRegistry();
        return registry.workspaces.find((entry) => entry.shareView)?.workspaceId ?? null;
      });
    await expect.poll(joinedId, { timeout: 60_000 }).toBeTruthy();
    const joined = (await joinedId())!;
    await expect
      .poll(
        () =>
          mine.evaluate(
            ({ id, path }) =>
              window
                .dohcDesktop!.listWorkspaceFiles({ workspaceId: id })
                .then((listed) => listed.files.some((file) => file.path === path))
                .catch(() => false),
            { id: joined, path: datasetPath },
          ),
        { timeout: 120_000 },
      )
      .toBe(true);

    // --- Ana opens Personal apps -------------------------------------------
    const opened: string[] = [];
    await member.app.evaluate(({ shell }) => {
      const probe = globalThis as { __opened?: string[] };
      probe.__opened = [];
      shell.openPath = async (path) => {
        probe.__opened!.push(`folder:${path}`);
        return "";
      };
      shell.openExternal = async (url) => {
        probe.__opened!.push(`url:${url}`);
      };
    });
    const readOpened = async () => {
      opened.splice(
        0,
        opened.length,
        ...(await member!.app.evaluate(() => (globalThis as { __opened?: string[] }).__opened!)),
      );
      return opened;
    };
    await mine.keyboard.press("ControlOrMeta+k");
    await mine
      .getByTestId("command-palette")
      .getByRole("option", { name: "Personal apps…", exact: true })
      .click();
    const dialog = mine.getByTestId("personal-apps");
    const path = dialog.getByTestId("personal-apps-path");
    await expect(path).not.toHaveText("…");
    const folder = (await path.textContent())!;
    expect(folder.startsWith(memberTemp.rootPath)).toBe(false);
    await member.app.evaluate(({ clipboard }) => clipboard.writeText(""));
    await dialog.getByRole("button", { name: "Copy path" }).click();
    await expect
      .poll(() => member!.app.evaluate(({ clipboard }) => clipboard.readText()))
      .toBe(folder);
    await dialog.getByRole("button", { name: "Open folder" }).click();
    await expect.poll(readOpened).toContain(`folder:${folder}`);
    await dialog.screenshot({ path: shot("empty-light") });

    // --- Ana adds a Trips app in the folder, reviews, approves, and opens it --
    await mkdir(join(folder, "trip-board"), { recursive: true });
    await writeFile(
      join(folder, "trip-board", "app.publish.json"),
      JSON.stringify({
        version: 1,
        entryPath: "main.ts",
        inputs: ["main.ts"],
        packageMap: {},
        dataset: { kind: "dataset", datasetPath, operationIds: [read.operationId] },
      }),
    );
    await writeFile(join(folder, "trip-board", "main.ts"), appSource(read.name));
    await mine.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    await mine.keyboard.press("ControlOrMeta+k");
    await mine
      .getByTestId("command-palette")
      .getByRole("option", { name: "Personal apps…", exact: true })
      .click();
    await dialog.getByRole("button", { name: "Review" }).click();
    await expect(dialog.getByRole("heading", { name: "Approve trip-board" })).toBeVisible({
      timeout: 60_000,
    });
    await expect(dialog.getByTestId("app-access")).toContainText("Trips");
    for (const theme of ["Light", "Dark"] as const) {
      await mine.evaluate(
        (value) => document.documentElement.setAttribute("data-theme", value),
        theme.toLowerCase(),
      );
      await dialog.screenshot({ path: shot(`review-${theme.toLowerCase()}`) });
    }
    await dialog.getByRole("button", { name: "Approve", exact: true }).click();
    await dialog.getByRole("button", { name: "Open", exact: true }).click();
    await expect
      .poll(async () => (await readOpened()).find((entry) => entry.startsWith("url:")))
      .toBeTruthy();
    for (const theme of ["Dark", "Light"] as const) {
      await mine.evaluate(
        (value) => document.documentElement.setAttribute("data-theme", value),
        theme.toLowerCase(),
      );
      await dialog.screenshot({ path: shot(`approved-${theme.toLowerCase()}`) });
    }
    const url = opened.find((entry) => entry.startsWith("url:"))!.slice(4);
    const browserPage = await context.newPage();
    await browserPage.goto(url);
    await expect(browserPage.frameLocator("iframe").locator("#trips")).toContainText("Kyoto", {
      timeout: 60_000,
    });
    await browserPage.screenshot({ path: shot("app-in-browser") });

    // --- Ana can share it only once the owner lets members share apps -------
    const share = dialog.getByRole("button", { name: "Share", exact: true });
    await share.click();
    await expect(dialog.getByRole("alert")).toContainText(
      "Members can't share apps in this workspace",
    );
    const openWorkspaceApps = async (target: typeof page) => {
      await target.keyboard.press("ControlOrMeta+k");
      await target
        .getByTestId("command-palette")
        .getByRole("option", { name: "Workspace apps…", exact: true })
        .click();
      return target.getByTestId("workspace-apps");
    };
    await page.getByTestId(activityPin("settings")).click();
    await page.getByTestId(settingsNavPin("general")).click();
    await page.getByTestId(settingsNavPin("members")).click();
    const allow = page
      .getByTestId("settings-members-app-sharing")
      .getByRole("switch", { name: "Members can share apps" });
    await expect(allow).toHaveAttribute("aria-checked", "false");
    await allow.click();
    await expect(allow).toHaveAttribute("aria-checked", "true");
    await page.getByRole("button", { name: "Close settings", exact: true }).click();
    await share.click();
    await expect(dialog.getByText("Shared trip-board with the workspace's members.")).toBeVisible({
      timeout: 60_000,
    });

    // --- Ana reviews the shared app and copies its source -------------------
    await mine.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    const apps = await openWorkspaceApps(mine);
    const row = apps.getByTestId("workspace-app-row").filter({ hasText: "trip-board" });
    await expect(row).toContainText("Shared by", { timeout: 60_000 });
    await row.getByRole("button", { name: "Review" }).click();
    await expect(apps.getByRole("heading", { name: "Review trip-board" })).toBeVisible();
    await expect(apps).toContainText("Trips");
    await expect(apps.getByTestId("workspace-app-source")).toContainText("trip-board/main.ts");
    for (const theme of ["Light", "Dark"] as const) {
      await mine.evaluate(
        (value) => document.documentElement.setAttribute("data-theme", value),
        theme.toLowerCase(),
      );
      await apps.screenshot({ path: shot(`member-review-${theme.toLowerCase()}`) });
    }
    await apps.getByTestId("workspace-app-copy-name").fill("trip-copy");
    await apps.getByRole("button", { name: "Copy", exact: true }).click();
    await expect(apps.getByText("Copied to trip-copy in your Personal apps.")).toBeVisible();
    expect(await readFile(join(folder, "trip-copy", "main.ts"), "utf8")).toBe(appSource(read.name));
    await apps.getByRole("button", { name: "Continue in browser" }).click();
    await expect
      .poll(async () =>
        (await readOpened()).some((entry) => entry.includes(`/s/apps/${workspaceId}/`)),
      )
      .toBe(true);

    // --- Only a person allows a Member app: the desktop's sign-in is refused --
    const listed = await mine.evaluate(async (id) => {
      const apps = [];
      let cursor: string | null = null;
      do {
        const page = await window.dohcDesktop!.memberAppsList({
          workspaceId: id,
          ...(cursor ? { cursor } : {}),
        });
        apps.push(...page.apps);
        cursor = page.nextCursor;
      } while (cursor);
      return apps;
    }, joined);
    const shared = listed.find((app) => app.kind === "member")!;
    expect(shared.name).toBe("trip-board");
    const consent = await fetch(
      `${relay.baseUrl}/sync/${workspaceId}/app-publications/${shared.publicationId}/backend/consent`,
      {
        method: "POST",
        headers: { authorization: `Bearer ${MEMBER.token}`, "content-type": "application/json" },
        body: JSON.stringify({ scopeDigest: "0".repeat(64) }),
      },
    );
    expect(consent.status).toBe(403);

    // --- The owner withdraws Ana's app --------------------------------------
    const ownerApps = await openWorkspaceApps(page);
    const ownerRow = ownerApps.getByTestId("workspace-app-row").filter({ hasText: "trip-board" });
    await expect(ownerRow).toBeVisible();
    for (const theme of ["Light", "Dark"] as const) {
      await page.evaluate(
        (value) => document.documentElement.setAttribute("data-theme", value),
        theme.toLowerCase(),
      );
      await ownerApps.screenshot({ path: shot(`owner-apps-${theme.toLowerCase()}`) });
    }
    await ownerRow.getByRole("button", { name: "Withdraw" }).click();
    await ownerApps.getByRole("alertdialog").getByRole("button", { name: "Withdraw" }).click();
    await expect(ownerRow).toHaveCount(0);

    expect(member.logs.filter((entry) => entry.level === "pageerror")).toEqual([]);
    expect(
      member.logs.filter(
        (entry) => entry.level === "error" && !entry.text.startsWith("Loading the font 'data:"),
      ),
    ).toEqual([]);
    expect(owner.logs.filter((entry) => entry.level === "pageerror")).toEqual([]);
  } finally {
    await context.close();
    await relay?.stop();
    await cleanupDesktopWorkspace(member, memberTemp);
    await cleanupDesktopWorkspace(owner, ownerTemp);
  }
});
