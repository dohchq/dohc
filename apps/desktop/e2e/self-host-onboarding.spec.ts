import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test, type BrowserContext } from "@playwright/test";
import type { DohcDesktopBridge } from "../src/ipc/bridgeContract";
import { launchDesktopApp, type LaunchedDesktopApp } from "./helpers/desktopApp";
import { approveDesktop, createVerifiedAccount, openDesktopApproval, startSelfHostOnboardingStack } from "./helpers/selfHostOnboarding";
import { cleanupDesktopWorkspace, createTempWorkspace, explorerRow, openWorkspaceFromFirstRun, waitForWorkspaceFile, waitForWorkspaceReady, writeWorkspaceFiles } from "./helpers/workspace";

test.skip(!process.env.POSTGRES_URL && process.env.DOHC_REQUIRE_POSTGRES !== "1", "Run with disposable POSTGRES_URL and DOHC_REQUIRE_POSTGRES=1.");

async function readFileIfPresent(path: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw error;
  }
}

test("@self-host-onboarding a real account connects two fresh desktops and keeps synced work after restart", async ({ browser, request }) => {
  test.setTimeout(240_000);
  const first = await createTempWorkspace();
  const second = await createTempWorkspace();
  let stack: Awaited<ReturnType<typeof startSelfHostOnboardingStack>> | undefined;
  let left: LaunchedDesktopApp | undefined;
  let right: LaunchedDesktopApp | undefined;
  let ownerBrowser: BrowserContext | undefined;
  let otherBrowser: BrowserContext | undefined;
  const account = { email: `desktop-${randomUUID()}@example.test`, password: `Desktop-proof-${randomUUID()}` };
  try {
    stack = await startSelfHostOnboardingStack(first.baseDir);
    expect((await request.get(`${stack.account.origin}/ready`)).status()).toBe(200);
    expect(await (await request.get(`${stack.account.origin}/.well-known/dohc-server`)).json()).toMatchObject({
      version: 1, authUrl: stack.account.origin, relayUrl: stack.relayUrl,
    });
    // A fake bearer must fail against this running relay, not merely be absent in our fixture code.
    expect((await request.post(`${stack.relayUrl}/sync/workspaces`, {
      headers: { authorization: "Bearer test:must-not-authenticate" },
      data: { workspaceId: "must-not-be-created" },
    })).status()).toBe(401);
    expect((await request.post(`${stack.account.origin}/test/device/approve`, {
      data: { userCode: "NO-TEST-AUTH", email: account.email },
    })).status()).toBe(404);

    await writeWorkspaceFiles(first, [{ path: "welcome.md", contents: "# Self-hosted workspace\n\nCreated before connecting.\n" }]);
    left = await launchDesktopApp({ workspace: first });
    const workspace = await openWorkspaceFromFirstRun(left.page, first);
    // Sync and sharing lives on the activity bar; the connect form is inside it.
    await left.page.getByTestId("activity-cloud").click();
    await expect(left.page.getByTestId("cloud-sync-panel")).toBeVisible();
    ownerBrowser = await browser.newContext();
    const ownerPage = await ownerBrowser.newPage();
    const approval = await openDesktopApproval(left, ownerPage, stack.account.origin);
    await createVerifiedAccount(ownerPage, stack.account, account, approval);
    await approveDesktop(ownerPage, account);
    await expect(left.page.getByTestId("cloud-connected-email")).toHaveText(account.email);
    await left.page.getByTestId("cloud-enable-sync").click();
    await expect(left.page.getByTestId("cloud-workspace-synced")).toBeVisible();
    await expect(left.page.getByTestId("cloud-sync-code")).toBeVisible();
    await left.page.getByTestId("cloud-copy-sync-code").click();
    await expect.poll(() => left!.app.evaluate(({ clipboard }) => clipboard.readText())).toBe(await left.page.getByTestId("cloud-sync-code").textContent());
    const syncCode = await left.app.evaluate(({ clipboard }) => clipboard.readText());
    expect(syncCode).toBe(await left.page.getByTestId("cloud-sync-code").textContent());
    expect(syncCode).toContain(stack.relayUrl);
    await left.page.keyboard.press("Escape");

    right = await launchDesktopApp({ workspace: second });
    await right.page.getByTestId("first-run-join-synced").click();
    otherBrowser = await browser.newContext();
    const otherPage = await otherBrowser.newPage();
    await openDesktopApproval(right, otherPage, stack.account.origin);
    await approveDesktop(otherPage, account);
    await expect(right.page.getByTestId("join-sync-code")).toBeEnabled();
    await right.page.getByTestId("join-sync-code").fill(syncCode);
    await right.page.getByTestId("join-choose-folder").click();
    await right.page.getByTestId("join-workspace-start").click();
    await waitForWorkspaceReady(right.page);
    await waitForWorkspaceFile(right.page, workspace.workspaceId, "welcome.md");
    await expect.poll(() => readFileIfPresent(join(second.rootPath, "welcome.md"))).toContain("Created before connecting.");

    await explorerRow(left.page, "welcome.md").click();
    await expect(left.page.getByTestId("markdown-editor")).toContainText("Created before connecting.");
    await left.page.getByTestId("markdown-editor").click();
    await left.page.keyboard.press("ControlOrMeta+End");
    await left.page.keyboard.type(" Edited through the connected desktop.");
    await expect(left.page.getByTestId("markdown-save-state")).toHaveAttribute("data-state", "saved");
    await expect.poll(() => readFileIfPresent(join(first.rootPath, "welcome.md"))).toContain("Edited through the connected desktop.");
    await expect.poll(() => readFileIfPresent(join(second.rootPath, "welcome.md")), { timeout: 90_000 }).toContain("Edited through the connected desktop.");
    const joinedLogs = [...right.logs];
    await right.close();
    right = undefined;
    right = await launchDesktopApp({ workspace: second });
    await openWorkspaceFromFirstRun(right.page, second);
    await waitForWorkspaceFile(right.page, workspace.workspaceId, "welcome.md");
    await explorerRow(right.page, "welcome.md").click();
    await expect(right.page.getByTestId("markdown-editor")).toContainText("Edited through the connected desktop.");
    const status = await right.page.evaluate(() => (window as unknown as { dohcDesktop: DohcDesktopBridge }).dohcDesktop.cloudStatus({}));
    expect(status).toMatchObject({ connected: true, email: account.email, serverUrl: stack.account.origin, relayUrl: stack.relayUrl });
    expect(left.logs.concat(joinedLogs, right.logs).filter(entry => entry.level === "pageerror")).toEqual([]);
    await right.close();
    right = undefined;
    await left.close();
    left = undefined;
  } finally {
    const cleanup = await Promise.allSettled([
      otherBrowser?.close(), ownerBrowser?.close(),
      cleanupDesktopWorkspace(right, second), left?.close(),
    ]);
    cleanup.push(...await Promise.allSettled([stack?.close()]));
    cleanup.push(...await Promise.allSettled([first.cleanup()]));
    const failures = cleanup.filter((result): result is PromiseRejectedResult => result.status === "rejected");
    if (failures.length) throw new AggregateError(failures.map(result => result.reason), "Self-host onboarding cleanup failed.");
  }
});
