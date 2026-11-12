import {randomUUID} from "node:crypto";
import {isDeepStrictEqual} from "node:util";
import {expect, test, type BrowserContext, type Page} from "@playwright/test";
import type {DohcDesktopBridge} from "../src/ipc/bridgeContract";
import {activityPin, editorTabTestId, settingsNavPin} from "../src/testPins";
import {assertDesktopEngineHealthy, launchDesktopApp, type LaunchedDesktopApp} from "./helpers/desktopApp";
import {waitForCliEndpoint} from "./helpers/dohcCli";
import {ownerEnrollment, ownerOutboxDeclarations} from "./helpers/engineDb";
import {approveDesktop, createVerifiedAccount, openDesktopApproval, startSelfHostOnboardingStack, trustFixtureCa} from "./helpers/selfHostOnboarding";
import {createTempWorkspace, openWorkspaceFromFirstRun, waitForWorkspaceFile, writeWorkspaceFiles} from "./helpers/workspace";

test.skip(!process.env.POSTGRES_URL && process.env.DOHC_REQUIRE_POSTGRES !== "1", "Run with disposable POSTGRES_URL and DOHC_REQUIRE_POSTGRES=1.");

const PATH = "notes/plan.md";
const ANCHOR = "The owner writes here.";
const TYPED = "Typed while the server hosts it nowhere.";
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

test("@live-owner-open an owner edit queued while the server hosts the note nowhere reaches its new live copy once the owner opens it", async ({browser}, info) => {
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
  // While set, the server answers the desktop's owner opens with 503, so an
  // edit stays queued until the owner opens the note.
  let holdOwnerOpens = false;
  const accountPage = async () => {
    const context = await browser.newContext();
    contexts.push(context);
    await trust!.route(context, stack!.relayUrl);
    return context.newPage();
  };
  try {
    stack = await startSelfHostOnboardingStack(ownerTemp.baseDir, {live: true, signal,
      refuse: (method, path) => holdOwnerOpens && method === "POST" && /^\/sync\/[^/]+\/live-host$/u.test(path)});
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
    // The owner's queued changes the server has not accepted, or why the store can't say.
    const unaccepted = () => {
      const outbox = ownerOutboxDeclarations(ownerTemp.rootPath);
      return outbox === null || "error" in outbox ? outbox : outbox.pending;
    };

    // The share comes first, so the owner's first open finds no owner binding
    // and asks for no hosting: only the share keeps the note hosted.
    const share = await test.step("the owner shares the note for Edit, then opens it, so the server hosts it", async () => {
      const created = await page.evaluate(({workspaceId, recipientEmail, path}) =>
        (window as unknown as {dohcDesktop: DohcDesktopBridge}).dohcDesktop.createRelayShare({workspaceId, recipientEmail, paths: [path], access: "edit"}),
      {workspaceId: workspace.workspaceId, recipientEmail: recipientAccount.email, path: PATH});
      // The first open gives the enrolled note its owner lineage.
      await openNote(page);
      await expect(page.getByTestId("sync-status")).toHaveAttribute("data-state", "synced", {timeout: 60_000});
      await expect.poll(async () => {
        const expected = stack!.ownerLiveBinding(workspace.workspaceId, PATH);
        const actual = expected && ownerEnrollment(ownerTemp.rootPath, expected.binding);
        return await hosted() && expected !== null && actual !== null && isDeepStrictEqual(actual.binding, expected.binding);
      }, {timeout: 120_000, intervals: [1_000]}).toBe(true);
      return created;
    });

    await test.step("stopping the note's only share retires it without a Stop, and the list stops naming it live", async () => {
      await page.evaluate(shareId =>
        (window as unknown as {dohcDesktop: DohcDesktopBridge}).dohcDesktop.revokeRelayShare({shareId}), share.shareId);
      await expect.poll(hosted, {timeout: 120_000, intervals: [1_000]}).toBe(false);
    });

    const queued = await test.step("the owner types in the open note, and the edit waits on this computer", async () => {
      holdOwnerOpens = true;
      const acceptedHead = stack!.livePublication(workspace.workspaceId, PATH).acceptedHead;
      await editor(page).getByText(ANCHOR).click();
      await page.keyboard.press(process.platform === "darwin" ? "Meta+ArrowRight" : "End");
      await page.keyboard.type(` ${TYPED}`);
      await expect(editor(page)).toContainText(TYPED);
      await expect(page.getByTestId("markdown-save-state")).toHaveAttribute("data-state", "pending-share", {timeout: 60_000});
      await expect.poll(unaccepted, {timeout: 60_000, intervals: [500]}).toBeGreaterThan(0);
      expect(stack!.livePublication(workspace.workspaceId, PATH).acceptedHead).toBe(acceptedHead);
      expect(stack!.liveHostTexts(PATH).some(text => text.includes(TYPED))).toBe(false);
      return {acceptedHead};
    });

    await test.step("the owner opens the note, and the queued edit reaches the server's new live copy", async () => {
      await closeNote(page);
      await openNote(page);
      holdOwnerOpens = false;
      await expect.poll(hosted, {timeout: 120_000, intervals: [1_000]}).toBe(true);
      await expect.poll(() => stack!.livePublication(workspace.workspaceId, PATH).acceptedHead, {timeout: 120_000, intervals: [1_000]})
        .toBeGreaterThan(queued.acceptedHead);
      await expect.poll(() => stack!.liveHostTexts(PATH).some(text => text.includes(`${ANCHOR} ${TYPED}`)),
        {timeout: 120_000, intervals: [1_000]}).toBe(true);
      // The server accepted the queued edit, so this computer holds none for it.
      await expect.poll(unaccepted, {timeout: 120_000, intervals: [1_000]}).toBe(0);
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
