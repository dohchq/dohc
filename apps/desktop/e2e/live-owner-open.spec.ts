import {randomUUID} from "node:crypto";
import {isDeepStrictEqual} from "node:util";
import {expect, test, type BrowserContext, type Page} from "@playwright/test";
import type {DohcDesktopBridge} from "../src/ipc/bridgeContract";
import {activityPin, editorTabTestId, settingsNavPin} from "../src/testPins";
import {assertDesktopEngineHealthy, launchDesktopApp, type LaunchedDesktopApp} from "./helpers/desktopApp";
import {waitForCliEndpoint} from "./helpers/dohcCli";
import {ownerEnrollment} from "./helpers/engineDb";
import {approveDesktop, createVerifiedAccount, openDesktopApproval, startSelfHostOnboardingStack, trustFixtureCa} from "./helpers/selfHostOnboarding";
import {createTempWorkspace, openWorkspaceFromFirstRun, waitForWorkspaceFile, writeWorkspaceFiles} from "./helpers/workspace";

test.skip(!process.env.POSTGRES_URL && process.env.DOHC_REQUIRE_POSTGRES !== "1", "Run with disposable POSTGRES_URL and DOHC_REQUIRE_POSTGRES=1.");

const PATH = "notes/plan.md";
const ANCHOR = "The owner writes here.";
const TYPED = "Typed once the server hosts it again.";
const editor = (page: Page) => page.getByTestId("markdown-editor");

async function openNote(page: Page): Promise<void> {
  await page.getByTestId("titlebar-quick-open").click();
  const palette = page.getByTestId("quick-open");
  await palette.getByLabel("File").fill(PATH);
  await palette.getByRole("option", {name: PATH, exact: true}).click();
  await expect(editor(page)).toBeVisible();
}

async function closeNote(page: Page): Promise<void> {
  const tab = page.getByTestId(editorTabTestId(PATH));
  await tab.hover();
  await tab.getByRole("button", {name: /^Close /}).click();
  await expect(tab).toHaveCount(0);
}

test("@live-owner-open the owner opening a document the server stopped hosting hosts it again, and their typing reaches it", async ({browser}, info) => {
  test.setTimeout(600_000);
  const signal = AbortSignal.timeout(info.timeout - 10_000);
  const ownerTemp = await createTempWorkspace();
  const apps: LaunchedDesktopApp[] = [];
  const contexts: BrowserContext[] = [];
  let stack: Awaited<ReturnType<typeof startSelfHostOnboardingStack>> | undefined;
  let trust: ReturnType<typeof trustFixtureCa> | undefined;
  let bodyFailure: {error: unknown} | undefined;
  const ownerAccount = {email: `owner-${randomUUID()}@example.test`, password: `Owner-${randomUUID()}`, name: "Owner"};
  const recipientAccount = {email: `recipient-${randomUUID()}@example.test`, password: `Recipient-${randomUUID()}`};
  const accountPage = async () => {
    const context = await browser.newContext();
    contexts.push(context);
    await trust!.route(context, stack!.relayUrl);
    return context.newPage();
  };
  try {
    stack = await startSelfHostOnboardingStack(ownerTemp.baseDir, {live: true, signal});
    trust = trustFixtureCa(stack.ca!.ca);
    const ownerApproval = await accountPage();
    // Sharing needs a known address. This account never opens its share.
    await createVerifiedAccount(await accountPage(), stack.account, recipientAccount);
    await writeWorkspaceFiles(ownerTemp, [{path: PATH, contents: `# Trip plan\n\n${ANCHOR}\n`}]);
    const owner = await launchDesktopApp({workspace: ownerTemp, env: stack.trustEnv});
    apps.push(owner);
    const page = owner.page;
    const workspace = await test.step("the owner connects the workspace to the server", async () => {
      const opened = await openWorkspaceFromFirstRun(page, ownerTemp);
      await page.getByTestId(activityPin("settings")).click();
      await page.getByTestId(settingsNavPin("cloud")).click();
      await page.getByTestId("settings-cloud-connect").click();
      const approval = await openDesktopApproval(owner, ownerApproval, stack!.relayUrl);
      await createVerifiedAccount(ownerApproval, stack!.account, ownerAccount, approval);
      await approveDesktop(ownerApproval, ownerAccount);
      await expect(page.getByTestId("settings-row-account")).toContainText(ownerAccount.email);
      await page.getByRole("switch", {name: "Sync this workspace"}).click();
      await expect(page.getByTestId("cloud-sync-code")).toBeVisible();
      await page.keyboard.press("Escape");
      await waitForWorkspaceFile(page, opened.workspaceId, PATH);
      await waitForCliEndpoint(ownerTemp.homeDir);
      return opened;
    });
    // Whether the owner's list names the note live.
    const hosted = async () => {
      const listed = await page.evaluate(workspaceId =>
        (window as unknown as {dohcDesktop: DohcDesktopBridge}).dohcDesktop.listOwnerLiveDocuments({workspaceId}), workspace.workspaceId);
      return listed.documents.some(row => row.path === PATH && row.status === "ready");
    };

    const share = await test.step("the owner opens the note and shares it for Edit, so the server hosts it", async () => {
      // Opening the note first gives enrollment its owner lineage.
      await openNote(page);
      await expect(page.getByTestId("sync-status")).toHaveAttribute("data-state", "synced", {timeout: 60_000});
      const created = await page.evaluate(({workspaceId, recipientEmail, path}) =>
        (window as unknown as {dohcDesktop: DohcDesktopBridge}).dohcDesktop.createRelayShare({workspaceId, recipientEmail, paths: [path], access: "edit"}),
      {workspaceId: workspace.workspaceId, recipientEmail: recipientAccount.email, path: PATH});
      await expect.poll(async () => {
        const expected = stack!.ownerLiveBinding(workspace.workspaceId, PATH);
        const actual = expected && ownerEnrollment(ownerTemp.rootPath, expected.binding);
        return await hosted() && expected !== null && actual !== null && isDeepStrictEqual(actual.binding, expected.binding);
      }, {timeout: 120_000, intervals: [1_000]}).toBe(true);
      return created;
    });

    await test.step("stopping the note's only share retires it without a Stop, and the list stops naming it live", async () => {
      await closeNote(page);
      await page.evaluate(shareId =>
        (window as unknown as {dohcDesktop: DohcDesktopBridge}).dohcDesktop.revokeRelayShare({shareId}), share.shareId);
      await expect.poll(hosted, {timeout: 120_000, intervals: [1_000]}).toBe(false);
    });

    await test.step("the owner opens the note, and the server hosts it again", async () => {
      await openNote(page);
      await expect.poll(hosted, {timeout: 120_000, intervals: [1_000]}).toBe(true);
    });

    await test.step("the owner's typing reaches the server's live copy", async () => {
      const before = stack!.livePublication(workspace.workspaceId, PATH).acceptedHead;
      await editor(page).getByText(ANCHOR).click();
      await page.keyboard.press(process.platform === "darwin" ? "Meta+ArrowRight" : "End");
      await page.keyboard.type(` ${TYPED}`);
      await expect(editor(page)).toContainText(TYPED);
      await expect.poll(() => stack!.livePublication(workspace.workspaceId, PATH).acceptedHead, {timeout: 120_000, intervals: [1_000]})
        .toBeGreaterThan(before);
      const head = stack!.livePublication(workspace.workspaceId, PATH).acceptedHead;
      await expect.poll(() => Math.max(0, ...stack!.livePublication(workspace.workspaceId, PATH).hosts.map(host => host.settledThrough)),
        {timeout: 120_000, intervals: [1_000]}).toBeGreaterThanOrEqual(head);
      await expect(page.getByTestId("markdown-save-state")).not.toHaveAttribute("data-state", "pending-share");
    });
    expect(owner.logs.filter(entry => entry.level === "pageerror")).toEqual([]);
    assertDesktopEngineHealthy(owner.logs);
  } catch (error) {
    bodyFailure = {error};
    if (stack) await info.attach("relay-output", {body: stack.relayOutput(), contentType: "text/plain"}).catch(() => undefined);
    throw error;
  } finally {
    const cleanup = await Promise.allSettled([...apps.map(app => app.close()), ...contexts.map(context => context.close())]);
    trust?.restore();
    cleanup.push(...await Promise.allSettled([stack?.close()]));
    cleanup.push(...await Promise.allSettled([ownerTemp.cleanup()]));
    const failures = cleanup.filter((result): result is PromiseRejectedResult => result.status === "rejected");
    if (failures.length) throw new AggregateError([...(bodyFailure ? [bodyFailure.error] : []), ...failures.map(result => result.reason)], "Owner open cleanup failed.");
  }
});
