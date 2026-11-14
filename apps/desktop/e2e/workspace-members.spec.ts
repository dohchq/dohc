import { expect, test, type Locator, type Page } from "@playwright/test";
import { randomBytes } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { activityPin, settingsNavPin } from "../src/testPins";
import { launchDesktopApp } from "./helpers/desktopApp";
import { DohcCliFailure, runDohcCli, waitForCliEndpoint } from "./helpers/dohcCli";
import { noticedRefusals } from "./helpers/engineDb";
import { claimRelayWorkspace, relayJson } from "./helpers/relayPeer";
import { spawnSyncRelay, type SyncRelayHandle } from "./helpers/syncRelay";
import {
  cleanupDesktopWorkspace,
  createTempWorkspace,
  explorerRow,
  openAboutPanel,
  openChatsView,
  openExplorerView,
  openWorkspaceFromFirstRun,
  revealExplorerPath,
  seedCloudCredentials,
  seedWorkspaceManifest,
  seedWorkspaceRegistry,
  writeWorkspaceFiles,
} from "./helpers/workspace";

// Workspace members against a real relay. The owner invites one account by
// email from Settings, turns on the invite link, and a second account joins
// with it. The owner sets the member level and makes the second account an
// admin. The invited member's own desktop lists the workspace under Shared
// with you, and the relay hides emails and the link from a member.

const OWNER = {
  token: "test:e2e-members-owner",
  user: "e2e-members-owner",
  email: "e2e-members-owner@dohc.test",
};
const MEMBER = {
  token: "test:e2e-members-sam",
  user: "e2e-members-sam",
  email: "e2e-members-sam@dohc.test",
};
const JOINER = { token: "test:e2e-members-kai", email: "e2e-members-kai@dohc.test" };
// The same account, in its own relay: the admin in the Group chat test.
const ADMIN = { token: JOINER.token, user: "e2e-members-kai", email: JOINER.email };
const VIEWER_ORIGIN = "https://viewer.example.com";
const GUEST = "e2e-members-lee@dohc.test";

interface MembersView {
  workspaceName: string;
  memberLevel: string;
  inviteLink: { enabled: boolean; url: string | null } | null;
  people: { memberId: string; role: string; state: string; email: string | null }[];
}

async function membersView(
  relay: SyncRelayHandle,
  token: string,
  workspaceId: string,
): Promise<MembersView> {
  const answer = await relayJson(
    relay.baseUrl,
    token,
    `/sync/${encodeURIComponent(workspaceId)}/members`,
  );
  expect(answer.status, answer.body).toBe(200);
  return JSON.parse(answer.body) as MembersView;
}

// The folder of the workspace this desktop joined, where its agent runs dohc.
async function joinedRoot(temp: { homeDir: string }): Promise<string> {
  const registry = JSON.parse(
    await readFile(join(temp.homeDir, "dohc-workspaces.json"), "utf8"),
  ) as {
    workspaces: {
      rootPath: string;
      shareView?: { grantedSelector?: { wholeWorkspace?: boolean } };
    }[];
  };
  const joined = registry.workspaces.find(
    (entry) => entry.shareView?.grantedSelector?.wholeWorkspace,
  );
  expect(joined, "the joined workspace is in the registry").toBeTruthy();
  return joined!.rootPath;
}

// Opens Settings on Members, or reloads Members when Settings is already open.
async function openMembers(page: Page) {
  if (!(await page.getByTestId(settingsNavPin("members")).isVisible()))
    await page.getByTestId(activityPin("settings")).click();
  await page.getByTestId(settingsNavPin("general")).click();
  await page.getByTestId(settingsNavPin("members")).click();
  const members = page.getByTestId("settings-members-page");
  await expect(members).toBeVisible({ timeout: 30_000 });
  return members;
}

test("@two-client an owner invites, opens the link, and sets roles; members see the workspace", async () => {
  test.setTimeout(300_000);
  const ownerTemp = await createTempWorkspace();
  const memberTemp = await createTempWorkspace();
  const workspaceId = "members-owner";
  let relay: SyncRelayHandle | null = null;
  let owner: Awaited<ReturnType<typeof launchDesktopApp>> | null = null;
  let member: Awaited<ReturnType<typeof launchDesktopApp>> | null = null;
  const shot = (name: string) => test.info().outputPath(`${name}.png`);

  try {
    relay = await spawnSyncRelay({
      dbPath: join(ownerTemp.baseDir, "relay", "relay.sqlite"),
      linkBoundary: {
        linkKey: randomBytes(32).toString("base64url"),
        relayExchangeKey: randomBytes(32).toString("base64url"),
        publicViewerOrigin: VIEWER_ORIGIN,
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

    owner = await launchDesktopApp({ workspace: ownerTemp });
    const { page } = owner;
    await openWorkspaceFromFirstRun(page, ownerTemp);
    await page.emulateMedia({ reducedMotion: "reduce" });

    // --- Alone: the owner is the only person ---------------------------
    let members = await openMembers(page);
    await expect(members).toHaveAttribute("data-viewer-role", "owner");
    await expect(members.getByTestId("settings-members-alone")).toBeVisible();
    await page.getByTestId("settings-members").screenshot({ path: shot("members-alone") });

    // --- Invite by email: a bad address is refused in place -------------
    await members.getByTestId("settings-members-invite-email").fill("not-an-address");
    await members.getByTestId("settings-members-invite-send").click();
    await expect(members.getByTestId("settings-members-invite-error")).toBeVisible();
    await members.getByTestId("settings-members-invite-email").fill(MEMBER.email);
    await members.getByTestId("settings-members-invite-send").click();
    await expect(members.getByTestId("settings-members-invite-email")).toHaveValue("");
    // The account exists on this server, so the invite makes them a member at once.
    const sam = members.getByTestId("settings-members-row").filter({ hasText: MEMBER.email });
    await expect(sam).toHaveAttribute("data-state", "active");
    await expect(sam.getByTestId("settings-members-role")).toHaveText("Member");

    // --- The invite link -------------------------------------------------
    await members.getByRole("switch", { name: "Invite link" }).click();
    const url = members.getByTestId("settings-members-link-url");
    await expect(url).toHaveText(new RegExp(`^${VIEWER_ORIGIN}/join#[A-Za-z0-9_-]{16,128}$`));
    const token = ((await url.textContent()) ?? "").split("#")[1]!;

    // Kai joins with the link. The relay previews the workspace first.
    const preview = await relayJson(relay.baseUrl, JOINER.token, "/sync/members/join-preview", {
      method: "POST",
      body: JSON.stringify({ token }),
    });
    expect(preview.status, preview.body).toBe(200);
    const workspaceName = (await membersView(relay, OWNER.token, workspaceId)).workspaceName;
    expect(JSON.parse(preview.body)).toMatchObject({ workspaceName, alreadyMember: false });
    const joined = await relayJson(relay.baseUrl, JOINER.token, "/sync/members/join", {
      method: "POST",
      body: JSON.stringify({ token }),
    });
    expect(joined.status, joined.body).toBe(200);
    expect(JSON.parse(joined.body)).toMatchObject({ workspaceId, workspaceName });

    // --- Level and roles --------------------------------------------------
    members = await openMembers(page);
    const rows = members.getByTestId("settings-members-row");
    await expect(rows).toHaveCount(3);
    await members
      .getByTestId("settings-members-level-control")
      .getByRole("radio", { name: "Edit" })
      .click();
    await expect(members.getByTestId("settings-members-level-busy")).toHaveCount(0);
    await expect
      .poll(async () => (await membersView(relay!, OWNER.token, workspaceId)).memberLevel)
      .toBe("edit");

    const kai = rows.filter({ hasText: JOINER.email });
    await kai.getByTestId("settings-members-row-menu").click();
    await page.getByRole("menuitem", { name: "Make admin" }).click();
    await page.getByTestId("settings-members-confirm").click();
    await expect(kai.getByTestId("settings-members-role")).toHaveText("Admin");

    for (const theme of ["Light", "Dark"] as const) {
      await page.getByTestId(settingsNavPin("appearance")).click();
      await page.getByRole("radio", { name: theme, exact: true }).click();
      await expect(page.locator("html")).toHaveAttribute("data-theme", theme.toLowerCase());
      members = await openMembers(page);
      await expect(rows).toHaveCount(3);
      await page
        .getByTestId("settings-members")
        .screenshot({ path: shot(`members-owner-${theme.toLowerCase()}`) });
    }

    // Turning the link off stops new joins.
    await members.getByRole("switch", { name: "Invite link" }).click();
    await expect(url).toHaveCount(0);
    await expect(members.getByRole("switch", { name: "Invite link" })).toBeEnabled();
    // The switch turns off at once; the relay answers a moment later.
    await expect
      .poll(async () => (await membersView(relay!, OWNER.token, workspaceId)).inviteLink?.enabled)
      .toBe(false);
    const late = await relayJson(relay.baseUrl, "test:e2e-members-late", "/sync/members/join", {
      method: "POST",
      body: JSON.stringify({ token }),
    });
    expect(late.status).toBe(404);
    await page.getByRole("button", { name: "Close settings" }).click();

    // --- What a member sees ---------------------------------------------
    const seen = await membersView(relay, MEMBER.token, workspaceId);
    expect(seen.inviteLink).toBeNull();
    expect(seen.memberLevel).toBe("edit");
    expect(seen.people.map((person) => person.email)).toEqual([null, null, null]);
    expect(seen.people.map((person) => person.role).sort()).toEqual(["admin", "member", "owner"]);

    // Sam's own desktop lists the workspace under Shared with you.
    await seedWorkspaceManifest(memberTemp, "members-sam-own");
    await seedWorkspaceRegistry(memberTemp, [
      { workspaceId: "members-sam-own", rootPath: memberTemp.rootPath },
    ]);
    await seedCloudCredentials(memberTemp, {
      serverUrl: relay.baseUrl,
      relayUrl: relay.baseUrl,
      email: MEMBER.email,
      userId: MEMBER.user,
      token: MEMBER.token,
    });
    member = await launchDesktopApp({ workspace: memberTemp });
    await openWorkspaceFromFirstRun(member.page, memberTemp);
    await member.page.getByTestId(activityPin("sharing")).click();
    const received = member.page
      .getByTestId("sharing-received-row")
      .filter({ hasText: workspaceName });
    await expect(received).toBeVisible({ timeout: 60_000 });
    await expect(received.getByTestId("sharing-row-who")).toContainText("Member ·");
    await expect(received.getByTestId("sharing-row-who")).toContainText("lets members edit");
    await member.page.getByTestId("sharing-view").screenshot({ path: shot("members-received") });
    expect(member.logs.filter((entry) => entry.level === "pageerror")).toEqual([]);

    // --- The owner ends membership, then starts again ---------------------
    await member.close();
    member = null;
    members = await openMembers(page);
    await members.getByTestId("settings-members-end-open").click();
    await page.getByTestId("settings-members-confirm").click();
    await expect(page.getByTestId("settings-members-ended")).toBeVisible();
    expect(
      (await relayJson(relay.baseUrl, MEMBER.token, `/sync/${workspaceId}/members`)).status,
    ).not.toBe(200);
    await expect(members.getByTestId("settings-members-end-open")).toHaveCount(0);
    await members
      .getByTestId("settings-members-level-control")
      .getByRole("radio", { name: "View" })
      .click();
    await expect
      .poll(async () => (await membersView(relay!, OWNER.token, workspaceId)).memberLevel)
      .toBe("view");
    await page.getByTestId("settings-members").screenshot({ path: shot("members-ended") });

    expect(owner.logs.filter((entry) => entry.level === "pageerror")).toEqual([]);
  } finally {
    await relay?.stop();
    await cleanupDesktopWorkspace(member, memberTemp);
    await cleanupDesktopWorkspace(owner, ownerTemp);
  }
});

async function showSharing(page: Page) {
  if (!(await page.getByTestId("sharing-view").isVisible()))
    await page.getByTestId(activityPin("sharing")).click();
  await expect(page.getByTestId("sharing-view")).toBeVisible();
}

async function setTheme(page: Page, theme: "Light" | "Dark") {
  await page.getByTestId(activityPin("settings")).click();
  await page.getByTestId(settingsNavPin("appearance")).click();
  await page.getByRole("radio", { name: theme, exact: true }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", theme.toLowerCase());
  await page.getByRole("button", { name: "Close settings", exact: true }).click();
}

// A member opens the whole workspace from Sharing on their own desktop. It
// arrives with its files, History, search, and a Group message posted before
// they joined. When the owner removes them, the copy stays readable under the
// ended band.
test("@two-client a member opens the workspace from Sharing and keeps a readable copy after removal", async () => {
  test.setTimeout(420_000);
  const ownerTemp = await createTempWorkspace();
  const memberTemp = await createTempWorkspace();
  const workspaceId = "members-open";
  const syncEnv = { DOHC_TEST_SYNC_DEBOUNCE_MS: "150", DOHC_TEST_SYNC_BACKOFF_MS: "250" };
  let relay: SyncRelayHandle | null = null;
  let owner: Awaited<ReturnType<typeof launchDesktopApp>> | null = null;
  let member: Awaited<ReturnType<typeof launchDesktopApp>> | null = null;
  const shot = (name: string) => test.info().outputPath(`${name}.png`);

  try {
    relay = await spawnSyncRelay({ dbPath: join(ownerTemp.baseDir, "relay", "relay.sqlite") });
    await claimRelayWorkspace({ baseUrl: relay.baseUrl, token: OWNER.token, workspaceId });
    await seedWorkspaceManifest(ownerTemp, workspaceId);
    await writeWorkspaceFiles(ownerTemp, [
      { path: "notes/plan.md", contents: "# Plan\n\nThe lighthouse memo.\n" },
    ]);
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

    // --- Before anyone joins: a Group with a message ---------------------
    await openChatsView(page);
    await page.getByTestId("chats-new-channel").click();
    await page.getByTestId("chats-new-channel-name").fill("Launch team");
    await page.getByTestId("chats-new-channel-type-both").click();
    await page.getByTestId("chats-new-channel-submit").click();
    await expect(page.getByTestId("chats-channel-title")).toHaveText("Launch team");
    await page.getByTestId("chats-new-thread-composer").fill("Kickoff: read the plan.");
    await page.getByTestId("chats-new-thread-composer").press("Enter");
    await expect(page.getByTestId("chats-message-body")).toContainText("Kickoff: read the plan.");
    await page.getByTestId("chats-thread-back").click();

    // --- The owner invites Sam, who has an account, so Sam joins at once ---
    const members = await openMembers(page);
    await members.getByTestId("settings-members-invite-email").fill(MEMBER.email);
    await members.getByTestId("settings-members-invite-send").click();
    await expect(
      members.getByTestId("settings-members-row").filter({ hasText: MEMBER.email }),
    ).toHaveAttribute("data-state", "active");
    await page.getByRole("button", { name: "Close settings", exact: true }).click();
    const workspaceName = (await membersView(relay, OWNER.token, workspaceId)).workspaceName;

    // The relay serves the owner's file through Sam's membership.
    const shares = await relayJson(relay.baseUrl, MEMBER.token, "/sync/shares");
    expect(shares.status, shares.body).toBe(200);
    const shareId = (
      JSON.parse(shares.body) as { received: { shareId: string; selector: { kind?: string } }[] }
    ).received.find((row) => row.selector.kind === "workspace")!.shareId;
    await expect
      .poll(
        async () => {
          const log = await relayJson(
            relay!.baseUrl,
            MEMBER.token,
            `/sync/shares/${shareId}/log?since=0&limit=500`,
          );
          return log.status === 200 && log.body.includes("notes/plan.md")
            ? "served"
            : `status:${log.status}`;
        },
        { timeout: 60_000, intervals: [1_000] },
      )
      .toBe("served");

    // --- Sam opens it from Sharing ----------------------------------------
    await seedWorkspaceManifest(memberTemp, "members-open-sam");
    await seedWorkspaceRegistry(memberTemp, [
      { workspaceId: "members-open-sam", rootPath: memberTemp.rootPath },
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
    await showSharing(mine);
    const received = mine.getByTestId("sharing-received-row").filter({ hasText: workspaceName });
    await expect(received.getByTestId("sharing-row-who")).toContainText("Member ·", {
      timeout: 60_000,
    });
    await expect(received.getByTestId("sharing-row-who")).toContainText("lets members comment");
    for (const theme of ["Light", "Dark"] as const) {
      await setTheme(mine, theme);
      await showSharing(mine);
      await expect(received).toBeVisible();
      await mine
        .getByTestId("sharing-view")
        .screenshot({ path: shot(`sharing-row-${theme.toLowerCase()}`) });
    }
    const dialog = mine.getByTestId("open-shared-view");
    for (const theme of ["Dark", "Light"] as const) {
      if (theme === "Light") {
        await mine.keyboard.press("Escape");
        await expect(dialog).toHaveCount(0);
        await setTheme(mine, theme);
      }
      await showSharing(mine);
      await expect(received).toBeVisible();
      await received.locator("[data-sharing-row-focus]").hover();
      await received.getByRole("button", { name: "Share actions" }).click();
      await mine.getByRole("menuitem", { name: "Open", exact: true }).click();
      await expect(dialog.getByTestId("open-share-choose-folder")).toContainText(workspaceName);
      await expect(dialog.getByTestId("open-share-start")).toHaveText("Open workspace");
      await dialog.screenshot({ path: shot(`open-dialog-${theme.toLowerCase()}`) });
    }
    await dialog.getByTestId("open-share-start").click();
    // The first pull counts the files it copies while it reads. It can finish
    // before a frame shows the count, so the picture is taken when it does.
    await expect(dialog.getByTestId("open-share-progress"))
      .toHaveText(/^Copied \d+ files? so far\.$/, { timeout: 5_000 })
      .then(() => dialog.screenshot({ path: shot("first-pull-light") }))
      .catch(() => undefined);

    // --- Inside: like an owned workspace -----------------------------------
    await expect(mine.getByTestId("status-workspace")).toHaveText(workspaceName, {
      timeout: 120_000,
    });
    await expect(mine.getByTestId("shared-view-banner")).toHaveCount(0);
    await revealExplorerPath(mine, "notes/plan.md");
    await mine.getByTestId(activityPin("history")).click();
    await expect(
      mine.locator('[data-testid="engine-moment-open"][data-moment-path="notes/plan.md"]').first(),
    ).toBeVisible({ timeout: 60_000 });
    await mine.getByTestId(activityPin("search")).click();
    await mine.getByTestId("search-input").fill("lighthouse");
    await expect(
      mine.locator('[data-testid="search-result-group"][data-path="notes/plan.md"]'),
    ).toBeVisible({ timeout: 30_000 });
    await openChatsView(mine);
    const group = mine.getByTestId("chats-channel").filter({ hasText: "Launch team" });
    await expect(group).toBeVisible({ timeout: 60_000 });
    await group.click();
    await expect(mine.getByTestId("chats-thread").first()).toContainText(
      "Kickoff: read the plan.",
      { timeout: 60_000 },
    );
    for (const theme of ["Light", "Dark"] as const) {
      await setTheme(mine, theme);
      await mine.getByTestId("workspace-switcher").click();
      await expect(mine.getByTestId("workspace-switcher-level")).toHaveText("You can comment");
      await mine.screenshot({ path: shot(`opened-menu-${theme.toLowerCase()}`) });
      await mine.keyboard.press("Escape");
    }

    // --- The owner removes Sam ---------------------------------------------
    const again = await openMembers(page);
    const row = again.getByTestId("settings-members-row").filter({ hasText: MEMBER.email });
    await row.getByTestId("settings-members-row-menu").click();
    await page.getByRole("menuitem", { name: "Remove from workspace" }).click();
    await page.getByTestId("settings-members-confirm").click();
    await expect(again.getByTestId("settings-members-removed")).toContainText(MEMBER.email);

    // The held pull hears it: the ended band, and the copy stays readable.
    const band = mine.getByTestId("shared-view-banner");
    await expect(band).toHaveText("Your membership ended. This copy stays on this computer.", {
      timeout: 60_000,
    });
    await expect(band).toHaveAttribute("data-ended", "true");
    await revealExplorerPath(mine, "notes/plan.md");
    await explorerRow(mine, "notes/plan.md").click();
    await expect(mine.getByText("The lighthouse memo.")).toBeVisible({ timeout: 30_000 });
    await openChatsView(mine);
    await expect(
      mine.getByTestId("chats-channel").filter({ hasText: "Launch team" }),
    ).toBeVisible();
    for (const theme of ["Light", "Dark"] as const) {
      await setTheme(mine, theme);
      await mine.screenshot({ path: shot(`ended-band-${theme.toLowerCase()}`) });
    }

    expect(member.logs.filter((entry) => entry.level === "pageerror")).toEqual([]);
    expect(owner.logs.filter((entry) => entry.level === "pageerror")).toEqual([]);
  } finally {
    await cleanupDesktopWorkspace(member, memberTemp);
    await cleanupDesktopWorkspace(owner, ownerTemp);
    await relay?.stop();
  }
});

// Opens the membership from Sharing on a member's own desktop and waits
// until the workspace is open.
async function openMembership(
  relay: SyncRelayHandle,
  temp: Awaited<ReturnType<typeof createTempWorkspace>>,
  account: { token: string; user: string; email: string },
  workspaceName: string,
  env: Record<string, string>,
) {
  await seedWorkspaceManifest(temp, `${account.user}-own`);
  await seedWorkspaceRegistry(temp, [
    { workspaceId: `${account.user}-own`, rootPath: temp.rootPath },
  ]);
  await seedCloudCredentials(temp, {
    serverUrl: relay.baseUrl,
    relayUrl: relay.baseUrl,
    email: account.email,
    userId: account.user,
    token: account.token,
  });
  const app = await launchDesktopApp({ workspace: temp, env });
  await openWorkspaceFromFirstRun(app.page, temp);
  await app.page.emulateMedia({ reducedMotion: "reduce" });
  await showSharing(app.page);
  const received = app.page.getByTestId("sharing-received-row").filter({ hasText: workspaceName });
  await expect(received.getByTestId("sharing-row-who")).toContainText("·", { timeout: 60_000 });
  await received.locator("[data-sharing-row-focus]").hover();
  await received.getByRole("button", { name: "Share actions" }).click();
  await app.page.getByRole("menuitem", { name: "Open", exact: true }).click();
  await app.page.getByTestId("open-shared-view").getByTestId("open-share-start").click();
  await expect(app.page.getByTestId("status-workspace")).toHaveText(workspaceName, {
    timeout: 120_000,
  });
  return app;
}

// Group chat in a joined workspace. A member posts in a Group while the owner
// reads it, and the owner's reply reaches the member as unread. The member
// comments on a file, and the member's agent posts in the Group through the
// CLI; the owner reads both. The owner
// moves members to View with the member's window open, and the composer goes
// with a toast. An admin then creates a Group that the member sees, and
// invites someone from the joined workspace's Members page.
test("@two-client a member posts in a Group, follows a level change, and sees an admin's new Group", async () => {
  test.setTimeout(600_000);
  const ownerTemp = await createTempWorkspace();
  const memberTemp = await createTempWorkspace();
  const adminTemp = await createTempWorkspace();
  const workspaceId = "members-chat";
  const syncEnv = { DOHC_TEST_SYNC_DEBOUNCE_MS: "150", DOHC_TEST_SYNC_BACKOFF_MS: "250" };
  let relay: SyncRelayHandle | null = null;
  let owner: Awaited<ReturnType<typeof launchDesktopApp>> | null = null;
  let member: Awaited<ReturnType<typeof launchDesktopApp>> | null = null;
  let admin: Awaited<ReturnType<typeof launchDesktopApp>> | null = null;
  const shot = (name: string) => test.info().outputPath(`${name}.png`);
  const themed = async (page: Page, name: string, ready: () => Promise<void>) => {
    for (const theme of ["Light", "Dark"] as const) {
      await setTheme(page, theme);
      await ready();
      await page.screenshot({ path: shot(`${name}-${theme.toLowerCase()}`) });
    }
  };

  try {
    relay = await spawnSyncRelay({ dbPath: join(ownerTemp.baseDir, "relay", "relay.sqlite") });
    await claimRelayWorkspace({ baseUrl: relay.baseUrl, token: OWNER.token, workspaceId });
    await seedWorkspaceManifest(ownerTemp, workspaceId);
    await writeWorkspaceFiles(ownerTemp, [{ path: "notes/plan.md", contents: "# Plan\n" }]);
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

    // --- The owner's Group, and two people: Sam a member, Kai an admin ----
    await openChatsView(page);
    await page.getByTestId("chats-new-channel").click();
    await page.getByTestId("chats-new-channel-name").fill("Launch team");
    await page.getByTestId("chats-new-channel-type-both").click();
    await page.getByTestId("chats-new-channel-submit").click();
    await expect(page.getByTestId("chats-channel-title")).toHaveText("Launch team");
    await page.getByTestId("chats-new-thread-composer").fill("Kickoff: read the plan.");
    await page.getByTestId("chats-new-thread-composer").press("Enter");
    await expect(page.getByTestId("chats-message-body")).toContainText("Kickoff: read the plan.");
    await page.getByTestId("chats-thread-back").click();
    for (const account of [MEMBER, ADMIN]) {
      const invited = await relayJson(
        relay.baseUrl,
        OWNER.token,
        `/sync/${workspaceId}/members/invites`,
        {
          method: "POST",
          body: JSON.stringify({ email: account.email, workspaceName: "Members chat" }),
        },
      );
      expect(invited.status, invited.body).toBe(200);
    }
    const kaiId = (await membersView(relay, OWNER.token, workspaceId)).people.find(
      (person) => person.email === ADMIN.email,
    )!.memberId;
    const promoted = await relayJson(
      relay.baseUrl,
      OWNER.token,
      `/sync/${workspaceId}/members/${kaiId}/role`,
      { method: "POST", body: JSON.stringify({ role: "admin" }) },
    );
    expect(promoted.status, promoted.body).toBe(200);
    const workspaceName = (await membersView(relay, OWNER.token, workspaceId)).workspaceName;
    const shares = await relayJson(relay.baseUrl, MEMBER.token, "/sync/shares");
    const shareId = (
      JSON.parse(shares.body) as { received: { shareId: string; selector: { kind?: string } }[] }
    ).received.find((row) => row.selector.kind === "workspace")!.shareId;
    await expect
      .poll(
        async () => {
          const log = await relayJson(
            relay!.baseUrl,
            MEMBER.token,
            `/sync/shares/${shareId}/log?since=0&limit=500`,
          );
          return log.status === 200 && log.body.includes("Kickoff")
            ? "served"
            : `status:${log.status}`;
        },
        { timeout: 60_000, intervals: [1_000] },
      )
      .toBe("served");

    // --- Sam, at Comment, posts in the Group --------------------------------
    member = await openMembership(relay, memberTemp, MEMBER, workspaceName, syncEnv);
    const mine = member.page;
    const samPanel = await openChatsView(mine);
    const samGroup = samPanel.getByTestId("chats-channel").filter({ hasText: "Launch team" });
    await expect(samGroup).toBeVisible({ timeout: 60_000 });
    await expect(samPanel.getByTestId("chats-new-channel")).toHaveCount(0);
    await samGroup.click();
    // The owner's post shows the owner's name, never "You" or an email.
    const kickoff = mine.getByTestId("chats-thread").filter({ hasText: "Kickoff: read the plan." });
    await expect(kickoff).toBeVisible({ timeout: 60_000 });
    await kickoff.click();
    const ownerAuthor = mine
      .locator('article[data-testid="chats-message"]')
      .first()
      .getByTestId("chats-message-author");
    await expect(ownerAuthor).toBeVisible();
    await expect(ownerAuthor).not.toHaveText("You");
    await expect(ownerAuthor).not.toContainText("@");
    await mine.getByTestId("chats-thread-back").click();
    const composer = mine.getByTestId("chats-new-thread-composer");
    await themed(mine, "group-comment", () => expect(composer).toBeVisible());
    await composer.fill("Sam here: the plan reads well.");
    await composer.press("Enter");
    const samPost = mine
      .locator('article[data-testid="chats-message"]')
      .filter({ hasText: "Sam here: the plan reads well." });
    await expect(samPost).toBeVisible();
    await expect(samPost.getByTestId("chats-message-author")).toHaveText("You");
    await mine.getByTestId("chats-thread-back").click();

    // Home lists the Group's posts.
    await samPanel.getByTestId("chats-feed-link").click();
    const home = mine.getByTestId("chats-personal-feed");
    await themed(mine, "home", () =>
      expect(home.getByTestId("chats-feed-item").filter({ hasText: "Sam here" })).toBeVisible({
        timeout: 30_000,
      }),
    );
    await expect(samGroup.getByTestId("chats-channel-unread")).toHaveCount(0, { timeout: 30_000 });

    // --- Sam comments on the plan ------------------------------------------
    await revealExplorerPath(mine, "notes/plan.md");
    await explorerRow(mine, "notes/plan.md").click();
    await openAboutPanel(mine);
    // Access names the membership that reaches the file.
    await expect(mine.getByTestId("about-access-row")).toContainText("Can comment", {
      timeout: 30_000,
    });
    const newComment = mine.getByTestId("linked-chat-new");
    await expect(newComment).toBeVisible({ timeout: 30_000 });
    // The keyboard reaches the comment control.
    await newComment.focus();
    await mine.keyboard.press("Enter");
    const commentBox = mine.getByTestId("linked-chat-new-composer");
    await commentBox.fill("Dates\nCan we move day 2?");
    await commentBox.press("Enter");
    await expect(mine.getByTestId("linked-chat-title")).toHaveText("Dates");
    await expect(mine.getByTestId("linked-chat-message-body")).toContainText("Can we move day 2?");
    await themed(mine, "file-comment", () =>
      expect(mine.getByTestId("linked-chat-composer")).toBeVisible(),
    );
    await mine.getByTestId("linked-chat-back").click();
    await themed(mine, "file-comments", () => expect(newComment).toBeVisible());

    // --- Sam's agent posts in the Group through the CLI ---------------------
    // The agent acts with Sam's session in the joined workspace's folder.
    await waitForCliEndpoint(memberTemp.homeDir);
    const samCli = { homeDir: memberTemp.homeDir, rootPath: await joinedRoot(memberTemp) };
    await runDohcCli(samCli, [
      "chat",
      "post",
      "launch-team",
      "--as-agent",
      "Sam's agent: the dates line up.",
    ]);
    const general = await runDohcCli(samCli, [
      "chat",
      "post",
      "general",
      "--as-agent",
      "Hello",
    ]).then(
      () => null,
      (error: unknown) => error,
    );
    expect(general).toBeInstanceOf(DohcCliFailure);
    // A joined workspace has no General, as in the member's Chats.
    expect((general as DohcCliFailure).stderr).toContain("no such group: general");
    // The agent reads the plan's History, as Sam's History panel lists it.
    expect(
      (await runDohcCli(samCli, ["--json", "history", "list", "notes/plan.md"])).stdout,
    ).toContain("notes/plan.md");
    const link = await runDohcCli(samCli, ["chat", "link", "--path", "notes/plan.md"]).then(
      () => null,
      (error: unknown) => error,
    );
    expect(link).toBeInstanceOf(DohcCliFailure);
    expect((link as DohcCliFailure).stderr).toContain(
      "Agents can't make links in a joined workspace yet.",
    );
    await openChatsView(mine);

    // --- The owner reads Sam's post and replies -----------------------------
    await openChatsView(page);
    const ownerGroup = page.getByTestId("chats-channel").filter({ hasText: "Launch team" });
    const samThread = page
      .getByTestId("chats-thread")
      .filter({ hasText: "Sam here: the plan reads well." });
    await expect(async () => {
      await ownerGroup.click();
      await expect(samThread).toBeVisible({ timeout: 5_000 });
    }).toPass({ timeout: 120_000, intervals: [2_000] });
    await samThread.click();
    await expect(
      page
        .locator('article[data-testid="chats-message"]')
        .first()
        .getByTestId("chats-message-author"),
    ).not.toHaveText("You");
    await page.getByTestId("chats-composer").fill("Welcome, Sam.");
    await page.getByTestId("chats-composer").press("Enter");
    await expect(
      page.getByTestId("chats-message-body").filter({ hasText: "Welcome, Sam." }),
    ).toBeVisible();
    await page.getByTestId("chats-thread-back").click();
    const samAgentPost = page
      .getByTestId("chats-thread")
      .filter({ hasText: "Sam's agent: the dates line up." });
    await expect(samAgentPost).toBeVisible({ timeout: 120_000 });
    // An agent that gave no name goes by whose it is, as the relay recorded it.
    await expect(samAgentPost.getByTestId("chats-post-author")).toHaveText(/^\S.*'s agent$/u);

    // The owner reads Sam's comment on the plan. About reads a file's
    // comments when it opens.
    await revealExplorerPath(page, "notes/plan.md");
    await explorerRow(page, "notes/plan.md").click();
    const ownerComment = page.getByTestId("about-panel").getByText("Dates");
    await expect(async () => {
      if (await page.getByTestId("about-rail").isVisible())
        await page.getByTestId("titlebar-about-sidebar").click();
      await openAboutPanel(page);
      await expect(ownerComment).toBeVisible({ timeout: 5_000 });
    }).toPass({ timeout: 120_000, intervals: [2_000] });
    await openChatsView(page);

    // The reply reaches Sam as unread.
    await expect(samGroup.getByTestId("chats-channel-unread")).toBeVisible({ timeout: 120_000 });
    await themed(mine, "unread", () =>
      expect(samGroup.getByTestId("chats-channel-unread")).toBeVisible(),
    );
    await samGroup.click();
    await mine.getByTestId("chats-thread").filter({ hasText: "Sam here" }).click();
    await expect(
      mine.getByTestId("chats-message-body").filter({ hasText: "Welcome, Sam." }),
    ).toBeVisible({ timeout: 30_000 });
    await mine.getByTestId("chats-thread-back").click();
    await expect(composer).toBeVisible();

    // --- The owner moves members to View while Sam's window is open ---------
    // The toast's dark picture comes from the pages test.
    await setTheme(mine, "Light");
    const members = await openMembers(page);
    await members
      .getByTestId("settings-members-level-control")
      .getByRole("radio", { name: "View" })
      .click();
    await expect
      .poll(async () => (await membersView(relay!, OWNER.token, workspaceId)).memberLevel)
      .toBe("view");
    await page.getByRole("button", { name: "Close settings", exact: true }).click();
    const note = mine.getByTestId("chats-readonly-note");
    await expect(note).toHaveText("Only people who can comment post here.", { timeout: 120_000 });
    await expect(composer).toHaveCount(0);
    // The test relay names each account by its id.
    const changed = `${OWNER.user} now lets members view only.`;
    const toast = mine
      .getByTestId("notice-toasts")
      .getByTestId("workspace-shell-notice")
      .filter({ hasText: changed });
    await expect(toast).toBeVisible({ timeout: 30_000 });
    await mine.screenshot({ path: shot("level-toast-light") });
    for (const theme of ["Light", "Dark"] as const) {
      await setTheme(mine, theme);
      await mine.getByTestId("notice-center-toggle").click();
      await expect(mine.getByTestId("notice-center").getByText(changed)).toBeVisible();
      await mine.screenshot({ path: shot(`level-notices-${theme.toLowerCase()}`) });
      await mine.keyboard.press("Escape");
      await expect(note).toBeVisible();
      await mine.screenshot({ path: shot(`group-view-${theme.toLowerCase()}`) });
    }

    expect(owner.logs.filter((entry) => entry.level === "pageerror")).toEqual([]);
    await owner.close();
    owner = null;

    // --- Kai, an admin, creates a Group that Sam then sees ------------------
    admin = await openMembership(relay, adminTemp, ADMIN, workspaceName, syncEnv);
    const kai = admin.page;
    const kaiPanel = await openChatsView(kai);
    await expect(
      kaiPanel.getByTestId("chats-channel").filter({ hasText: "Launch team" }),
    ).toBeVisible({ timeout: 60_000 });
    const newGroup = kaiPanel.getByTestId("chats-new-channel");
    await themed(kai, "admin-new-group", () => expect(newGroup).toBeVisible({ timeout: 30_000 }));
    await newGroup.click();
    await kai.getByTestId("chats-new-channel-name").fill("Field notes");
    await kai.getByTestId("chats-new-channel-submit").click();
    await expect(kai.getByTestId("chats-channel-title")).toHaveText("Field notes", {
      timeout: 60_000,
    });
    await expect(
      samPanel.getByTestId("chats-channel").filter({ hasText: "Field notes" }),
    ).toBeVisible({ timeout: 120_000 });
    await expect(samPanel.getByTestId("chats-new-channel")).toHaveCount(0);

    // --- Kai invites someone from the joined workspace ----------------------
    const kaiMembers = await openMembers(kai);
    await expect(kaiMembers).toHaveAttribute("data-viewer-role", "admin", { timeout: 30_000 });
    await kaiMembers.getByTestId("settings-members-invite-email").fill(GUEST);
    await kaiMembers.getByTestId("settings-members-invite-send").click();
    await expect(kaiMembers.getByTestId("settings-members-invite-email")).toHaveValue("", {
      timeout: 30_000,
    });
    // The test relay knows every account, so the invite makes them a member at once.
    await expect
      .poll(
        async () =>
          (await membersView(relay!, OWNER.token, workspaceId)).people.find(
            (person) => person.email === GUEST,
          )?.state,
      )
      .toBe("active");
    await expect(kaiMembers.getByTestId("settings-members-people")).toContainText(GUEST);
    await kai.getByRole("button", { name: "Close settings", exact: true }).click();
    // Members in each theme. Settings closes between them.
    const membersShots = async (
      desktop: Page,
      name: string,
      check: (members: Locator) => Promise<void>,
    ) => {
      for (const theme of ["Light", "Dark"] as const) {
        await setTheme(desktop, theme);
        await check(await openMembers(desktop));
        await desktop.screenshot({ path: shot(`${name}-${theme.toLowerCase()}`) });
        await desktop.getByRole("button", { name: "Close settings", exact: true }).click();
      }
    };
    await membersShots(kai, "members-admin", (members) =>
      expect(members.getByTestId("settings-members-people")).toContainText(GUEST),
    );

    // Sam sees names and roles, with no emails and nothing to manage.
    await membersShots(mine, "members-member", async (members) => {
      await expect(members).toHaveAttribute("data-viewer-role", "member");
      await expect(members.getByTestId("settings-members-people")).toContainText(OWNER.user);
      await expect(members.getByTestId("settings-members-invite-email")).toHaveCount(0);
      await expect(members.getByTestId("settings-members-invites")).toHaveCount(0);
      await expect(members).not.toContainText("@dohc.test");
    });

    expect(member.logs.filter((entry) => entry.level === "pageerror")).toEqual([]);
    expect(admin.logs.filter((entry) => entry.level === "pageerror")).toEqual([]);
  } finally {
    await cleanupDesktopWorkspace(admin, adminTemp);
    await cleanupDesktopWorkspace(member, memberTemp);
    await cleanupDesktopWorkspace(owner, ownerTemp);
    await relay?.stop();
  }
});

// Mention and reply Notices in a joined workspace. A member mentions the
// owner in a Group thread, and the owner's Notice opens that message. The
// owner replies in the thread, and the member's Notice opens the reply in
// the joined workspace. Each row reads once opened.
test("@two-client a member mentions the owner, the owner replies, and each Notice opens the message", async () => {
  test.setTimeout(600_000);
  const ownerTemp = await createTempWorkspace();
  const memberTemp = await createTempWorkspace();
  const workspaceId = "members-notices";
  const syncEnv = { DOHC_TEST_SYNC_DEBOUNCE_MS: "150", DOHC_TEST_SYNC_BACKOFF_MS: "250" };
  let relay: SyncRelayHandle | null = null;
  let owner: Awaited<ReturnType<typeof launchDesktopApp>> | null = null;
  let member: Awaited<ReturnType<typeof launchDesktopApp>> | null = null;
  const shot = (name: string) => test.info().outputPath(`${name}.png`);
  // The test relay names each account by its id, so a handle is the id.
  const mention = `@${OWNER.user} can you check the budget?`;
  const reply = "The budget is fine. Book the hall.";

  // Opens Notices, finds the row, takes light and dark pictures of it, and
  // opens it at the message. The panel closes with its toggle: Escape would
  // reach the open thread and take it back to the Group.
  const openNotice = async (page: Page, title: string, name: string, message: string) => {
    const center = page.getByTestId("notice-center");
    const row = center.locator('li[data-testid^="sent-notice-"]').filter({ hasText: title });
    await expect(async () => {
      if (!(await center.isVisible())) await page.getByTestId("notice-center-toggle").click();
      await expect(row).toBeVisible({ timeout: 5_000 });
    }).toPass({ timeout: 120_000, intervals: [2_000] });
    for (const theme of ["Light", "Dark"] as const) {
      await setTheme(page, theme);
      await page.getByTestId("notice-center-toggle").click();
      await expect(row).toBeVisible();
      await page.screenshot({ path: shot(`${name}-${theme.toLowerCase()}`) });
      await page.keyboard.press("Escape");
    }
    await page.getByTestId("notice-center-toggle").click();
    await row.click();
    await expect(center).toHaveCount(0);
    await expect(page.getByTestId("chats-message-body").filter({ hasText: message })).toBeVisible({
      timeout: 30_000,
    });
    // Opened, it reads: the row stays, with no unread mark.
    await page.getByTestId("notice-center-toggle").click();
    await expect(row).toBeVisible();
    await expect(row.getByTestId(/-unread$/u)).toHaveCount(0);
    await page.getByTestId("notice-center-toggle").click();
    await expect(center).toHaveCount(0);
  };

  try {
    relay = await spawnSyncRelay({ dbPath: join(ownerTemp.baseDir, "relay", "relay.sqlite") });
    await claimRelayWorkspace({ baseUrl: relay.baseUrl, token: OWNER.token, workspaceId });
    await seedWorkspaceManifest(ownerTemp, workspaceId);
    await writeWorkspaceFiles(ownerTemp, [{ path: "notes/plan.md", contents: "# Plan\n" }]);
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

    // --- The owner's Group, a first post, and Sam at Comment ----------------
    await openChatsView(page);
    await page.getByTestId("chats-new-channel").click();
    await page.getByTestId("chats-new-channel-name").fill("Events");
    await page.getByTestId("chats-new-channel-type-both").click();
    await page.getByTestId("chats-new-channel-submit").click();
    await expect(page.getByTestId("chats-channel-title")).toHaveText("Events");
    await page.getByTestId("chats-new-thread-composer").fill("Fundraiser: who checks the budget?");
    await page.getByTestId("chats-new-thread-composer").press("Enter");
    await expect(page.getByTestId("chats-message-body")).toContainText(
      "Fundraiser: who checks the budget?",
    );
    await page.getByTestId("chats-thread-back").click();
    const invited = await relayJson(
      relay.baseUrl,
      OWNER.token,
      `/sync/${workspaceId}/members/invites`,
      {
        method: "POST",
        body: JSON.stringify({ email: MEMBER.email, workspaceName: "Members notices" }),
      },
    );
    expect(invited.status, invited.body).toBe(200);
    const workspaceName = (await membersView(relay, OWNER.token, workspaceId)).workspaceName;

    // --- Sam mentions the owner in the thread -------------------------------
    member = await openMembership(relay, memberTemp, MEMBER, workspaceName, syncEnv);
    const mine = member.page;
    const samPanel = await openChatsView(mine);
    const samGroup = samPanel.getByTestId("chats-channel").filter({ hasText: "Events" });
    await expect(samGroup).toBeVisible({ timeout: 60_000 });
    await samGroup.click();
    const thread = (where: Page) =>
      where.getByTestId("chats-thread").filter({ hasText: "Fundraiser: who checks the budget?" });
    await expect(thread(mine)).toBeVisible({ timeout: 60_000 });
    await thread(mine).click();
    await mine.getByTestId("chats-composer").fill(mention);
    await mine.getByTestId("chats-composer").press("Enter");
    await expect(
      mine.getByTestId("chats-message-body").filter({ hasText: "can you check the budget?" }),
    ).toBeVisible();
    // Away from the thread, so the reply's Notice is not read on arrival.
    await mine.getByTestId("chats-thread-back").click();
    await openExplorerView(mine);

    // --- The owner's Notice opens Sam's message in the owned workspace ------
    await openExplorerView(page);
    await openNotice(
      page,
      `${MEMBER.user} mentioned you in #Events`,
      "notice-mention",
      "can you check the budget?",
    );
    // It opens the post's thread, so the reply goes under Sam's comment.
    await expect(page.getByRole("tab", { name: /^Events/u })).toHaveAttribute(
      "aria-selected",
      "true",
    );

    // --- The owner replies; Sam's Notice opens the reply in the joined view --
    await page.getByTestId("chats-composer").fill(reply);
    await page.getByTestId("chats-composer").press("Enter");
    await expect(page.getByTestId("chats-message-body").filter({ hasText: reply })).toBeVisible();
    await openNotice(mine, `${OWNER.user} replied in #Events`, "notice-reply", reply);
    await expect(mine.getByTestId("status-workspace")).toHaveText(workspaceName);
    await expect(mine.getByRole("tab", { name: /^Events/u })).toHaveAttribute(
      "aria-selected",
      "true",
    );

    expect(owner.logs.filter((entry) => entry.level === "pageerror")).toEqual([]);
    expect(member.logs.filter((entry) => entry.level === "pageerror")).toEqual([]);
  } finally {
    await cleanupDesktopWorkspace(member, memberTemp);
    await cleanupDesktopWorkspace(owner, ownerTemp);
    await relay?.stop();
  }
});

// Pages and folders in a joined workspace. At Edit a member creates a page
// that reaches the owner's own folder, and Chats there lists no agents. An
// admin creates a folder by naming it and writing its first page. At Comment
// the member's Explorer offers no new page and a document opens read-only.
test("@two-client a member creates a page that reaches the owner, and an admin creates a folder with its first page", async () => {
  test.setTimeout(600_000);
  const ownerTemp = await createTempWorkspace();
  const memberTemp = await createTempWorkspace();
  const adminTemp = await createTempWorkspace();
  const workspaceId = "members-pages";
  const syncEnv = { DOHC_TEST_SYNC_DEBOUNCE_MS: "150", DOHC_TEST_SYNC_BACKOFF_MS: "250" };
  let relay: SyncRelayHandle | null = null;
  let owner: Awaited<ReturnType<typeof launchDesktopApp>> | null = null;
  let member: Awaited<ReturnType<typeof launchDesktopApp>> | null = null;
  let admin: Awaited<ReturnType<typeof launchDesktopApp>> | null = null;
  const shot = (name: string) => test.info().outputPath(`${name}.png`);
  const themed = async (page: Page, name: string, ready: () => Promise<void>) => {
    for (const theme of ["Light", "Dark"] as const) {
      await setTheme(page, theme);
      await ready();
      await page.screenshot({ path: shot(`${name}-${theme.toLowerCase()}`) });
    }
  };
  let nudge = 0;
  // An idle owner pulls on its own sync cadence; a write wakes it. A missing
  // page answers with the updates the owner's engine refused.
  const ownerFile = async (path: string) => {
    const text = await readFile(join(ownerTemp.rootPath, path), "utf8").catch(() => "");
    if (text) return text;
    nudge += 1;
    await writeFile(
      join(ownerTemp.rootPath, "notes/plan.md"),
      `# Plan\n\nRead this first.\n${"\n".repeat(nudge % 2)}`,
    );
    return JSON.stringify(noticedRefusals(ownerTemp.rootPath, workspaceId));
  };
  const setLevel = async (level: "comment" | "edit") => {
    const set = await relayJson(relay!.baseUrl, OWNER.token, `/sync/${workspaceId}/members/level`, {
      method: "POST",
      body: JSON.stringify({ level, workspaceName: "Members pages" }),
    });
    expect(set.status, set.body).toBe(200);
  };

  try {
    relay = await spawnSyncRelay({ dbPath: join(ownerTemp.baseDir, "relay", "relay.sqlite") });
    await claimRelayWorkspace({ baseUrl: relay.baseUrl, token: OWNER.token, workspaceId });
    await seedWorkspaceManifest(ownerTemp, workspaceId);
    await writeWorkspaceFiles(ownerTemp, [
      { path: "notes/plan.md", contents: "# Plan\n\nRead this first.\n" },
    ]);
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
    await openWorkspaceFromFirstRun(owner.page, ownerTemp);
    for (const account of [MEMBER, ADMIN]) {
      const invited = await relayJson(
        relay.baseUrl,
        OWNER.token,
        `/sync/${workspaceId}/members/invites`,
        {
          method: "POST",
          body: JSON.stringify({ email: account.email, workspaceName: "Members pages" }),
        },
      );
      expect(invited.status, invited.body).toBe(200);
    }
    const kaiId = (await membersView(relay, OWNER.token, workspaceId)).people.find(
      (person) => person.email === ADMIN.email,
    )!.memberId;
    const promoted = await relayJson(
      relay.baseUrl,
      OWNER.token,
      `/sync/${workspaceId}/members/${kaiId}/role`,
      { method: "POST", body: JSON.stringify({ role: "admin" }) },
    );
    expect(promoted.status, promoted.body).toBe(200);
    await setLevel("edit");
    const workspaceName = (await membersView(relay, OWNER.token, workspaceId)).workspaceName;
    const shares = await relayJson(relay.baseUrl, MEMBER.token, "/sync/shares");
    const shareId = (
      JSON.parse(shares.body) as { received: { shareId: string; selector: { kind?: string } }[] }
    ).received.find((row) => row.selector.kind === "workspace")!.shareId;
    await expect
      .poll(
        async () => {
          const log = await relayJson(
            relay!.baseUrl,
            MEMBER.token,
            `/sync/shares/${shareId}/log?since=0&limit=500`,
          );
          return log.status === 200 && log.body.includes("notes/plan.md")
            ? "served"
            : `status:${log.status}`;
        },
        { timeout: 60_000, intervals: [1_000] },
      )
      .toBe("served");

    // --- Sam, a member at Edit -------------------------------------------
    member = await openMembership(relay, memberTemp, MEMBER, workspaceName, syncEnv);
    const mine = member.page;
    await themed(mine, "chats-no-agents", async () => {
      const panel = await openChatsView(mine);
      await expect(panel.getByTestId("chats-channels-heading")).toBeVisible({ timeout: 30_000 });
      await expect(panel.getByTestId("chats-my-agent-section")).toHaveCount(0);
    });
    await revealExplorerPath(mine, "notes/plan.md");
    const header = mine.getByTestId("explorer-files-header");
    await expect(header.getByRole("button", { name: "New page" })).toBeVisible({ timeout: 60_000 });
    await expect(header.getByRole("button", { name: "New folder" })).toHaveCount(0);
    await header.getByRole("button", { name: "New page" }).click();
    await expect(mine.getByLabel("Page title")).toBeFocused();
    await mine.keyboard.type("Ideas");
    await themed(mine, "new-page-joined", async () => {
      await openExplorerView(mine);
      await expect(mine.getByLabel("Page title")).toHaveValue("Ideas");
    });
    await mine.getByLabel("Page title").click();
    await mine.keyboard.press("ControlOrMeta+w");
    await expect(mine.getByTestId("new-page")).toHaveCount(0);
    // The page went straight to the owner, not as a proposal.
    await expect
      .poll(() => ownerFile("notes/Ideas.md"), { timeout: 120_000, intervals: [2_000] })
      .toMatch(/title: Ideas/);

    // --- Kai, an admin, names a folder and writes its first page ----------
    admin = await openMembership(relay, adminTemp, ADMIN, workspaceName, syncEnv);
    const kai = admin.page;
    await revealExplorerPath(kai, "notes/plan.md");
    const newFolder = kai
      .getByTestId("explorer-files-header")
      .getByRole("button", { name: "New folder" });
    await expect(newFolder).toBeVisible({ timeout: 60_000 });
    await explorerRow(kai, "notes").click();
    await kai.keyboard.press("ArrowLeft");
    await newFolder.click();
    const folderName = kai.getByRole("textbox", { name: "New folder name" });
    await expect(folderName).toBeFocused();
    await kai.keyboard.type("Plans");
    await kai.screenshot({ path: shot("admin-new-folder-name") });
    await folderName.press("Enter");
    await expect(kai.getByLabel("Page title")).toBeFocused();
    await kai.keyboard.type("Kickoff");
    // Until the page is written, the tree shows the folder it goes in.
    const pendingFolder = explorerRow(kai, "Plans").or(explorerRow(kai, "notes/Plans")).first();
    await themed(kai, "admin-new-folder-page", async () => {
      await openExplorerView(kai);
      await expect(kai.getByLabel("Page title")).toHaveValue("Kickoff");
      await expect(pendingFolder).toBeVisible();
    });
    await kai.getByLabel("Page title").click();
    await kai.keyboard.press("ControlOrMeta+w");
    await expect(kai.getByTestId("new-page")).toHaveCount(0);
    await expect
      .poll(
        async () => {
          for (const path of ["Plans/Kickoff.md", "notes/Plans/Kickoff.md"])
            if (/title: Kickoff/.test(await ownerFile(path))) return path;
          return "missing";
        },
        { timeout: 120_000, intervals: [1_000] },
      )
      .not.toBe("missing");
    expect(admin.logs.filter((entry) => entry.level === "pageerror")).toEqual([]);
    await admin.close();
    admin = null;

    // --- At Comment, Sam gets no New page and a read-only document --------
    // Kai's window covered Sam's, and a hidden window does not check its
    // access. Sam looks at the window again.
    await member.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.show());
    await expect.poll(() => mine.evaluate(() => document.visibilityState)).toBe("visible");
    await setLevel("comment");
    await expect(header.getByRole("button", { name: "New page" })).toHaveCount(0, {
      timeout: 120_000,
    });
    // The toast names who changed the level. Its light picture comes from the Group test.
    const changed = `${OWNER.user} now lets members comment.`;
    await expect(
      mine
        .getByTestId("notice-toasts")
        .getByTestId("workspace-shell-notice")
        .filter({ hasText: changed }),
    ).toBeVisible({ timeout: 30_000 });
    await mine.screenshot({ path: shot("level-toast-dark") });
    await explorerRow(mine, "notes/plan.md").click();
    // The page opens to read, with no Edit toggle and no editor.
    const page = mine.getByRole("main");
    await expect(page.getByText("Read this first.")).toBeVisible({ timeout: 60_000 });
    await expect(mine.getByTestId("markdown-edit-toggle")).toHaveCount(0);
    await expect(mine.getByTestId("markdown-editor")).toHaveCount(0);
    await themed(mine, "comment-read-only", async () => {
      await openExplorerView(mine);
      await expect(page.getByText("Read this first.")).toBeVisible();
      await expect(mine.getByTestId("markdown-edit-toggle")).toHaveCount(0);
    });

    // --- A page Sam wrote stays until members can edit again -------------
    // Sam writes a page while the relay is down, and the owner moves members
    // to Comment as it comes back. The page waits with no proposal to send,
    // and it goes on its own once members are back at Edit.
    await setLevel("edit");
    await expect(header.getByRole("button", { name: "New page" })).toBeVisible({
      timeout: 120_000,
    });
    const relayPort = relay.port;
    await relay.stop();
    relay = null;
    await header.getByRole("button", { name: "New page" }).click();
    await expect(mine.getByLabel("Page title")).toBeFocused();
    await mine.keyboard.type("Budget");
    await mine.keyboard.press("ControlOrMeta+w");
    await expect(mine.getByTestId("new-page")).toHaveCount(0);
    relay = await spawnSyncRelay({
      dbPath: join(ownerTemp.baseDir, "relay", "relay.sqlite"),
      port: relayPort,
    });
    await setLevel("comment");
    // The level drop is found by a push the view never sent or by one the relay refused, so the count may be unknown.
    const unsent =
      /You can no longer edit .+(Your unsent pages stay|\d+ unsent pages? stays?) on this computer\. They send when members can edit again\./;
    const notices = mine.getByTestId("notice-center");
    const unsentRow = notices.locator("li").filter({ hasText: unsent }).first();
    // The failed send offers Try again. At Comment, trying again finds the level changed.
    const failedRow = notices.locator("li").filter({ hasText: "could not send your" }).first();
    await expect(async () => {
      if (!(await notices.isVisible())) await mine.getByTestId("notice-center-toggle").click();
      if ((await unsentRow.count()) === 0) {
        const retry = failedRow.getByRole("button", { name: "Try again" });
        if (await retry.isVisible()) await retry.click();
      }
      await expect(unsentRow).toBeVisible({ timeout: 5_000 });
    }).toPass({ timeout: 120_000, intervals: [2_000] });
    await expect(unsentRow.getByRole("button", { name: "Send as proposal" })).toHaveCount(0);
    for (const theme of ["Light", "Dark"] as const) {
      await mine.keyboard.press("Escape");
      await setTheme(mine, theme);
      await mine.getByTestId("notice-center-toggle").click();
      await expect(unsentRow).toBeVisible();
      await mine.screenshot({ path: shot(`unsent-pages-${theme.toLowerCase()}`) });
    }
    await mine.keyboard.press("Escape");
    await setLevel("edit");
    await expect
      .poll(
        async () => {
          for (const path of ["notes/Budget.md", "Budget.md"])
            if (/title: Budget/.test(await ownerFile(path))) return path;
          return "missing";
        },
        { timeout: 120_000, intervals: [2_000] },
      )
      .not.toBe("missing");

    expect(member.logs.filter((entry) => entry.level === "pageerror")).toEqual([]);
    expect(owner.logs.filter((entry) => entry.level === "pageerror")).toEqual([]);
  } finally {
    await cleanupDesktopWorkspace(admin, adminTemp);
    await cleanupDesktopWorkspace(member, memberTemp);
    await cleanupDesktopWorkspace(owner, ownerTemp);
    await relay?.stop();
  }
});
