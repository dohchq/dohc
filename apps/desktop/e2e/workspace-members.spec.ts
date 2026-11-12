import { expect, test, type Page } from "@playwright/test";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { activityPin, settingsNavPin } from "../src/testPins";
import { launchDesktopApp } from "./helpers/desktopApp";
import { claimRelayWorkspace, relayJson } from "./helpers/relayPeer";
import { spawnSyncRelay, type SyncRelayHandle } from "./helpers/syncRelay";
import {
  cleanupDesktopWorkspace,
  createTempWorkspace,
  openWorkspaceFromFirstRun,
  seedCloudCredentials,
  seedWorkspaceManifest,
  seedWorkspaceRegistry,
} from "./helpers/workspace";

// Workspace members against a real relay. The owner invites one account by
// email from Settings, turns on the invite link, and a second account joins
// with it. The owner sets the member level and makes the second account an
// admin. The invited member's own desktop lists the workspace under Shared
// with you, and the relay hides emails and the link from a member.

const OWNER = { token: "test:e2e-members-owner", user: "e2e-members-owner", email: "e2e-members-owner@dohc.test" };
const MEMBER = { token: "test:e2e-members-sam", user: "e2e-members-sam", email: "e2e-members-sam@dohc.test" };
const JOINER = { token: "test:e2e-members-kai", email: "e2e-members-kai@dohc.test" };
const VIEWER_ORIGIN = "https://viewer.example.com";

interface MembersView {
  workspaceName: string;
  memberLevel: string;
  inviteLink: { enabled: boolean; url: string | null } | null;
  people: { memberId: string; role: string; state: string; email: string | null }[];
}

async function membersView(relay: SyncRelayHandle, token: string, workspaceId: string): Promise<MembersView> {
  const answer = await relayJson(relay.baseUrl, token, `/sync/${encodeURIComponent(workspaceId)}/members`);
  expect(answer.status, answer.body).toBe(200);
  return JSON.parse(answer.body) as MembersView;
}

// Opens Settings on Members, or reloads Members when Settings is already open.
async function openMembers(page: Page) {
  if (!(await page.getByTestId(settingsNavPin("members")).isVisible())) await page.getByTestId(activityPin("settings")).click();
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
      linkBoundary: { linkKey: randomBytes(32).toString("base64url"), relayExchangeKey: randomBytes(32).toString("base64url"), publicViewerOrigin: VIEWER_ORIGIN },
    });
    await claimRelayWorkspace({ baseUrl: relay.baseUrl, token: OWNER.token, workspaceId });
    await seedWorkspaceManifest(ownerTemp, workspaceId);
    await seedWorkspaceRegistry(ownerTemp, [
      { workspaceId, rootPath: ownerTemp.rootPath, remote: { serverUrl: relay.baseUrl, ownerUserId: OWNER.user } },
    ]);
    await seedCloudCredentials(ownerTemp, { serverUrl: relay.baseUrl, relayUrl: relay.baseUrl, email: OWNER.email, userId: OWNER.user, token: OWNER.token });

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
    const preview = await relayJson(relay.baseUrl, JOINER.token, "/sync/members/join-preview", { method: "POST", body: JSON.stringify({ token }) });
    expect(preview.status, preview.body).toBe(200);
    const workspaceName = (await membersView(relay, OWNER.token, workspaceId)).workspaceName;
    expect(JSON.parse(preview.body)).toMatchObject({ workspaceName, alreadyMember: false });
    const joined = await relayJson(relay.baseUrl, JOINER.token, "/sync/members/join", { method: "POST", body: JSON.stringify({ token }) });
    expect(joined.status, joined.body).toBe(200);
    expect(JSON.parse(joined.body)).toMatchObject({ workspaceId, workspaceName });

    // --- Level and roles --------------------------------------------------
    members = await openMembers(page);
    const rows = members.getByTestId("settings-members-row");
    await expect(rows).toHaveCount(3);
    await members.getByTestId("settings-members-level-control").getByRole("radio", { name: "Edit" }).click();
    await expect(members.getByTestId("settings-members-level-busy")).toHaveCount(0);
    await expect.poll(async () => (await membersView(relay!, OWNER.token, workspaceId)).memberLevel).toBe("edit");

    const kai = rows.filter({ hasText: JOINER.email });
    await kai.getByTestId("settings-members-row-menu").click();
    await page.getByRole("menuitem", { name: "Make admin" }).click();
    await expect(kai.getByTestId("settings-members-role")).toHaveText("Admin");

    for (const theme of ["Light", "Dark"] as const) {
      await page.getByTestId(settingsNavPin("appearance")).click();
      await page.getByRole("radio", { name: theme, exact: true }).click();
      await expect(page.locator("html")).toHaveAttribute("data-theme", theme.toLowerCase());
      members = await openMembers(page);
      await expect(rows).toHaveCount(3);
      await page.getByTestId("settings-members").screenshot({ path: shot(`members-owner-${theme.toLowerCase()}`) });
    }

    // Turning the link off stops new joins.
    await members.getByRole("switch", { name: "Invite link" }).click();
    await expect(url).toHaveCount(0);
    const late = await relayJson(relay.baseUrl, "test:e2e-members-late", "/sync/members/join", { method: "POST", body: JSON.stringify({ token }) });
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
    await seedWorkspaceRegistry(memberTemp, [{ workspaceId: "members-sam-own", rootPath: memberTemp.rootPath }]);
    await seedCloudCredentials(memberTemp, { serverUrl: relay.baseUrl, relayUrl: relay.baseUrl, email: MEMBER.email, userId: MEMBER.user, token: MEMBER.token });
    member = await launchDesktopApp({ workspace: memberTemp });
    await openWorkspaceFromFirstRun(member.page, memberTemp);
    await member.page.getByTestId(activityPin("sharing")).click();
    const received = member.page.getByTestId("sharing-received-row").filter({ hasText: workspaceName });
    await expect(received).toBeVisible({ timeout: 60_000 });
    await expect(received.getByTestId("sharing-row-who")).toContainText("Member ·");
    await expect(received.getByTestId("sharing-row-who")).toContainText("lets members edit");
    await member.page.getByTestId("sharing-view").screenshot({ path: shot("members-received") });

    expect(owner.logs.filter((entry) => entry.level === "pageerror")).toEqual([]);
    expect(member.logs.filter((entry) => entry.level === "pageerror")).toEqual([]);
  } finally {
    await cleanupDesktopWorkspace(member, memberTemp);
    await cleanupDesktopWorkspace(owner, ownerTemp);
    await relay?.stop();
  }
});
