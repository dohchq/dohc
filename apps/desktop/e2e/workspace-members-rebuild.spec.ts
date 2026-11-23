import { expect, test, type Page } from "@playwright/test";
import { access, readFile, rename } from "node:fs/promises";
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
  writeWorkspaceFiles,
} from "./helpers/workspace";

// A rule that hides a folder from members rebuilds a member's joined copy:
// the owner sets it in the relay, which writes the folder's marker to the
// owner's disk and changes the member's reach, and the member's desktop closes its copy, asks the engine to
// rebuild it from the relay, and reopens it without the hidden folder.

const OWNER = {
  token: "test:e2e-rebuild-owner",
  user: "e2e-rebuild-owner",
  email: "e2e-rebuild-owner@dohc.test",
};
const MEMBER = {
  token: "test:e2e-rebuild-sam",
  user: "e2e-rebuild-sam",
  email: "e2e-rebuild-sam@dohc.test",
};

interface JoinedEntry {
  workspaceId?: string;
  id?: string;
  rootPath: string;
  shareView?: {
    grantedSelector?: { wholeWorkspace?: boolean };
    rebuild?: { stopped?: unknown };
    reach?: { visibilitySignature?: string };
  };
}

async function joinedEntry(homeDir: string): Promise<JoinedEntry | undefined> {
  const registry = JSON.parse(await readFile(join(homeDir, "dohc-workspaces.json"), "utf8")) as {
    workspaces: JoinedEntry[];
  };
  return registry.workspaces.find((entry) => entry.shareView?.grantedSelector?.wholeWorkspace);
}

async function exists(path: string): Promise<boolean> {
  return access(path).then(
    () => true,
    () => false,
  );
}

async function memberLog(
  relay: SyncRelayHandle,
  shareId: string,
): Promise<{ body: string; visibility: string | null }> {
  const log = await relayJson(
    relay.baseUrl,
    MEMBER.token,
    `/sync/shares/${shareId}/log?since=0&limit=500`,
  );
  if (log.status !== 200) return { body: "", visibility: null };
  const page = JSON.parse(log.body) as { reach?: { visibilitySignature?: string } };
  return { body: log.body, visibility: page.reach?.visibilitySignature ?? null };
}

async function refresh(page: Page, workspaceId: string): Promise<string> {
  return page.evaluate(async (id) => {
    const desktop = (
      window as unknown as {
        dohcDesktop: {
          refreshSharedView(input: {
            workspaceId: string;
            trigger: "manual";
          }): Promise<{ ok?: boolean; status?: string }>;
        };
      }
    ).dohcDesktop;
    try {
      const outcome = await desktop.refreshSharedView({ workspaceId: id, trigger: "manual" });
      return outcome.ok === false ? "failed" : (outcome.status ?? "failed");
    } catch (error) {
      return `threw: ${String(error)}`;
    }
  }, workspaceId);
}

test("@two-client a rule that hides a folder rebuilds a member's copy without it", async () => {
  test.setTimeout(420_000);
  const ownerTemp = await createTempWorkspace();
  const memberTemp = await createTempWorkspace();
  const workspaceId = "members-rebuild";
  const syncEnv = { DOHC_TEST_SYNC_DEBOUNCE_MS: "150", DOHC_TEST_SYNC_BACKOFF_MS: "250" };
  let relay: SyncRelayHandle | null = null;
  let owner: Awaited<ReturnType<typeof launchDesktopApp>> | null = null;
  let member: Awaited<ReturnType<typeof launchDesktopApp>> | null = null;

  try {
    relay = await spawnSyncRelay({ dbPath: join(ownerTemp.baseDir, "relay", "relay.sqlite") });
    await claimRelayWorkspace({ baseUrl: relay.baseUrl, token: OWNER.token, workspaceId });
    await seedWorkspaceManifest(ownerTemp, workspaceId);
    await writeWorkspaceFiles(ownerTemp, [
      { path: "notes/plan.md", contents: "# Plan\n" },
      { path: "team/budget.md", contents: "# Budget\n" },
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

    // The owner invites Sam, who has an account, so Sam joins at once.
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
    const view = await relayJson(relay.baseUrl, OWNER.token, `/sync/${workspaceId}/members`);
    const workspaceName = (JSON.parse(view.body) as { workspaceName: string }).workspaceName;

    const shares = await relayJson(relay.baseUrl, MEMBER.token, "/sync/shares");
    const shareId = (
      JSON.parse(shares.body) as { received: { shareId: string; selector: { kind?: string } }[] }
    ).received.find((row) => row.selector.kind === "workspace")!.shareId;
    await expect
      .poll(async () => (await memberLog(relay!, shareId)).body.includes("team/budget.md"), {
        timeout: 60_000,
        intervals: [1_000],
      })
      .toBe(true);
    const before = (await memberLog(relay, shareId)).visibility;
    expect(before).toEqual(expect.any(String));

    // Sam opens the workspace from Sharing, and the copy holds both folders.
    await seedWorkspaceManifest(memberTemp, "rebuild-sam-own");
    await seedWorkspaceRegistry(memberTemp, [
      { workspaceId: "rebuild-sam-own", rootPath: memberTemp.rootPath },
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
    await mine.getByTestId(activityPin("sharing")).click();
    const received = mine.getByTestId("sharing-received-row").filter({ hasText: workspaceName });
    await expect(received.getByTestId("sharing-row-who")).toContainText("·", { timeout: 60_000 });
    await received.locator("[data-sharing-row-focus]").hover();
    await received.getByRole("button", { name: "Share actions" }).click();
    await mine.getByRole("menuitem", { name: "Open", exact: true }).click();
    await mine.getByTestId("open-shared-view").getByTestId("open-share-start").click();
    await expect(mine.getByTestId("status-workspace")).toHaveText(workspaceName, {
      timeout: 120_000,
    });
    await expect
      .poll(
        async () =>
          (await joinedEntry(memberTemp.homeDir))?.shareView?.reach?.visibilitySignature ?? null,
        { timeout: 60_000 },
      )
      .toBe(before);
    const joined = await joinedEntry(memberTemp.homeDir);
    const joinedId = (joined!.workspaceId ?? joined!.id)!;
    await expect
      .poll(() => exists(join(joined!.rootPath, "team/budget.md")), { timeout: 60_000 })
      .toBe(true);
    expect(joined!.shareView?.reach?.visibilitySignature).toBe(before);

    // The owner hides team/ from members. The relay changes Sam's reach.
    const ruled = await relayJson(
      relay.baseUrl,
      OWNER.token,
      `/sync/${workspaceId}/members/folder-rules`,
      {
        method: "POST",
        body: JSON.stringify({ folder: "team", members: null, people: [] }),
      },
    );
    expect(ruled.status, ruled.body).toBe(200);
    // The owner's desktop pulls the marker, so the rule moves with the folder.
    await expect
      .poll(() => exists(join(ownerTemp.rootPath, "team/.dohc-access")), { timeout: 60_000 })
      .toBe(true);
    await expect
      .poll(async () => (await memberLog(relay!, shareId)).visibility, {
        timeout: 60_000,
        intervals: [1_000],
      })
      .not.toBe(before);
    expect((await memberLog(relay, shareId)).body).not.toContain("team/budget.md");

    // Sam's desktop pulls and closes the copy.
    await expect
      .poll(
        async () => {
          const entry = await joinedEntry(memberTemp.homeDir);
          if (
            entry?.shareView?.rebuild !== undefined ||
            entry?.shareView?.reach?.visibilitySignature !== before
          )
            return true;
          await refresh(mine, joinedId);
          return false;
        },
        { timeout: 120_000, intervals: [2_000] },
      )
      .toBe(true);
    // The first try rebuilds the copy and reopens it, with no Try again.
    const stops: unknown[] = [];
    await expect
      .poll(
        async () => {
          const entry = await joinedEntry(memberTemp.homeDir);
          if (entry?.shareView?.rebuild?.stopped) stops.push(entry.shareView.rebuild.stopped);
          const gone = !(await exists(join(joined!.rootPath, "team/budget.md")));
          return (
            gone &&
            entry?.shareView?.rebuild === undefined &&
            entry?.shareView?.reach?.visibilitySignature !== before
          );
        },
        { timeout: 120_000, intervals: [500] },
      )
      .toBe(true);
    expect(stops).toEqual([]);
    expect(await readFile(join(joined!.rootPath, "notes/plan.md"), "utf8")).toBe("# Plan\n");
    await expect(mine.getByTestId("status-workspace")).toHaveText(workspaceName);
    expect(await refresh(mine, joinedId)).not.toMatch(/^(failed|threw)/);

    // The owner renames the folder on disk. Its marker moves with it, so the
    // rule follows to the new path and the old path holds nothing.
    await rename(join(ownerTemp.rootPath, "team"), join(ownerTemp.rootPath, "crew"));
    const ruledFolders = async () => {
      const view = await relayJson(relay!.baseUrl, OWNER.token, `/sync/${workspaceId}/members`);
      const rules = (JSON.parse(view.body) as { folderRules?: { folders: { path: string }[] }[] })
        .folderRules;
      return (rules ?? []).flatMap((rule) => rule.folders.map((folder) => folder.path)).sort();
    };
    await expect.poll(ruledFolders, { timeout: 120_000, intervals: [1_000] }).toEqual(["crew"]);
    expect(await exists(join(ownerTemp.rootPath, "team"))).toBe(false);

    // A rename while dohc is closed moves the rule too, once dohc opens again.
    expect(owner.logs.filter((entry) => entry.level === "pageerror")).toEqual([]);
    await owner.close();
    owner = null;
    await rename(join(ownerTemp.rootPath, "crew"), join(ownerTemp.rootPath, "squad"));
    owner = await launchDesktopApp({ workspace: ownerTemp, env: syncEnv });
    await openWorkspaceFromFirstRun(owner.page, ownerTemp);
    await expect.poll(ruledFolders, { timeout: 120_000, intervals: [1_000] }).toEqual(["squad"]);

    expect(member.logs.filter((entry) => entry.level === "pageerror")).toEqual([]);
    expect(owner.logs.filter((entry) => entry.level === "pageerror")).toEqual([]);
  } finally {
    await cleanupDesktopWorkspace(member, memberTemp);
    await cleanupDesktopWorkspace(owner, ownerTemp);
    await relay?.stop();
  }
});
