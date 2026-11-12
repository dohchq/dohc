import { randomBytes, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import type { DohcDesktopBridge } from "../src/ipc/bridgeContract";
import { activityPin, settingsNavPin } from "../src/testPins";
import { launchDesktopApp, type LaunchedDesktopApp } from "./helpers/desktopApp";
import { textFileTrackedByEngine } from "./helpers/engineDb";
import { approveDesktop, createVerifiedAccount, openDesktopApproval, startSelfHostOnboardingStack, trustFixtureCa } from "./helpers/selfHostOnboarding";
import { sharedDatasetViewerOrigin, startSharedDatasetBrowser } from "./helpers/sharedDatasetBrowser";
import { createTempWorkspace, explorerRow, openWorkspaceFromFirstRun, revealExplorerPath, waitForWorkspaceFile, writeWorkspaceFiles } from "./helpers/workspace";

// On a self-hosted server, an owner shares notes by Edit link. Two notes are
// made with New page, so their files did not exist before their editors
// opened (#3790): one is closed before it is shared and one stays open. The
// third, the control, is a file the app wrote and captured before its editor
// opened. Each must go live once its tab is closed. For the notes shared with
// their tabs closed, a link holder types into each in a browser, and the
// edit must reach the owner's file. A note shared with its tab open has no
// file on the server until the tab closes (#3785), so a link holder's edit
// while it is open belongs to that issue's own test.

test.skip(!process.env.POSTGRES_URL && process.env.DOHC_REQUIRE_POSTGRES !== "1", "Run with disposable POSTGRES_URL and DOHC_REQUIRE_POSTGRES=1.");

type Api = DohcDesktopBridge;
const editor = (page: Page) => page.getByTestId("markdown-editor");

/** New page as Ctrl N makes it: the title, then Enter, then the body, with no wait between them. */
async function typeNewPage(page: Page, title: string, body: string): Promise<string> {
  await page.keyboard.press("ControlOrMeta+n");
  await expect(page.getByLabel("Page title")).toBeFocused();
  await page.keyboard.type(title);
  await page.keyboard.press("Enter");
  await page.keyboard.type(body);
  const path = `${title}.md`;
  await expect(explorerRow(page, path)).toBeVisible({ timeout: 15_000 });
  await expect(editor(page)).toContainText(body);
  return path;
}

test("@new-page-edit-link a note made with New page goes live through an Edit link on a self-hosted server, closed or open, and the link holder's edit reaches the owner", async ({ browser }, testInfo) => {
  test.setTimeout(600_000);
  const signal = AbortSignal.timeout(testInfo.timeout - 10_000);
  const temp = await createTempWorkspace();
  // Fresh for each run, and never printed.
  const exchangeKey = randomBytes(32).toString("hex");
  let stack: Awaited<ReturnType<typeof startSelfHostOnboardingStack>> | undefined;
  let trust: ReturnType<typeof trustFixtureCa> | undefined;
  let owner: LaunchedDesktopApp | undefined;
  let shared: Awaited<ReturnType<typeof startSharedDatasetBrowser>> | undefined;
  const contexts: BrowserContext[] = [];
  let bodyFailure: { error: unknown } | undefined;
  const ownerAccount = { email: `owner-${randomUUID()}@example.test`, password: `Owner-${randomUUID()}`, name: "Owner" };
  try {
    stack = await startSelfHostOnboardingStack(temp.baseDir, { live: true, signal, linkBoundary: {
      linkKey: randomBytes(32).toString("hex"), relayExchangeKey: exchangeKey, publicViewerOrigin: sharedDatasetViewerOrigin } });
    trust = trustFixtureCa(stack.ca!.ca);
    const approvalContext = await browser.newContext();
    contexts.push(approvalContext);
    await trust.route(approvalContext, stack.relayUrl);
    shared = await startSharedDatasetBrowser({ relayUrl: stack.relayInnerUrl, exchangeKey, editLinks: true });

    // --- The owner connects an account and syncs the workspace ---------------
    const existing = "existing.md";
    await writeWorkspaceFiles(temp, [{ path: existing, contents: "# Existing\n" }]);
    owner = await launchDesktopApp({ workspace: temp, env: stack.trustEnv });
    const page = owner.page;
    const { workspaceId } = await openWorkspaceFromFirstRun(page, temp);
    await page.getByTestId(activityPin("settings")).click();
    await page.getByTestId(settingsNavPin("cloud")).click();
    await page.getByTestId("settings-cloud-connect").click();
    await expect(page.getByTestId("cloud-sync-panel")).toBeVisible();
    const approvalPage = await approvalContext.newPage();
    const approval = await openDesktopApproval(owner, approvalPage, stack.relayUrl);
    await createVerifiedAccount(approvalPage, stack.account, ownerAccount, approval);
    await approveDesktop(approvalPage, ownerAccount);
    await expect(page.getByTestId("settings-row-account")).toContainText(ownerAccount.email);
    const syncSwitch = page.getByRole("switch", { name: "Sync this workspace" });
    await syncSwitch.click();
    await expect(syncSwitch).toHaveAttribute("aria-checked", "true");
    await page.keyboard.press("Escape");
    await waitForWorkspaceFile(page, workspaceId, existing);

    // The engine replaces the file with two renames, so a read can land between them and find no file.
    const ownerFile = (path: string) => readFile(join(temp.rootPath, path), "utf8").catch(error => {
      if (error?.code === "ENOENT") return "";
      throw error;
    });
    // A note that never goes live can keep a link holder out of another note beside it, so each line names the notes shared before.
    const sharedNotes: string[] = [];
    const relayLines = () => new Set(stack!.relayOutput().split("\n").filter(line => /activation pass failed|refus/iu.test(line)));

    /**
     * Makes an Edit link for `path` with the desktop's own call, runs
     * `afterLink`, and waits for the note to go live. With `linkHolder`, a
     * link holder then types a marker after `body`, and it must reach the
     * owner's file.
     */
    const shareAndEdit = async (name: string, path: string, body: string, linkHolder: boolean, afterLink?: () => Promise<void>) => {
      const before = relayLines();
      const earlier = [...sharedNotes];
      sharedNotes.push(path);
      const started = Date.now();
      const link = await page.evaluate(({ workspaceId, path }) =>
        (window as unknown as { dohcDesktop: Api }).dohcDesktop.createRelayShareLink({ workspaceId, paths: [path], access: "edit" }),
      { workspaceId, path });
      await afterLink?.();
      let status = "missing";
      const live = await expect.poll(async () => {
        const listed = await page.evaluate(workspaceId =>
          (window as unknown as { dohcDesktop: Api }).dohcDesktop.listOwnerLiveDocuments({ workspaceId }), workspaceId);
        return (status = listed.documents.find(document => document.path === path)?.status ?? "missing");
      }, { timeout: 180_000, intervals: [1000] }).toBe("ready").then(() => true, () => false);
      const lines = [...relayLines()].filter(line => !before.has(line));
      console.log(`[new-page-edit-link] ${name}: live ${live} after ${Date.now() - started} ms, last status ${status}; shared before: ${earlier.join(", ") || "none"}; relay lines:\n${lines.join("\n") || "(none)"}`);
      // Soft, so one run reports every case.
      expect.soft(live, `${name}: the note goes live; last status ${status}`).toBe(true);
      if (!linkHolder) return;

      // The share page lists a file in a folder by its own name.
      const fileButton = path.slice(path.lastIndexOf("/") + 1);
      const browserPage = await shared!.browser.newPage();
      browserPage.on("pageerror", error => shared!.failures.push(error.message));
      if (!live) {
        // Reported, not asserted: what a link holder sees when the note never goes live.
        const seen = await (async () => {
          await browserPage.goto(`${sharedDatasetViewerOrigin}/s${new URL(link.url).hash}`);
          await browserPage.getByRole("button", { name: fileButton, exact: true }).click({ timeout: 15_000 });
          await browserPage.getByRole("button", { name: "Edit file", exact: true }).click({ timeout: 15_000 });
          return await browserPage.getByText(/unavailable|try again/iu).first().innerText({ timeout: 30_000 });
        })().catch(error => `nothing matched: ${String(error).split("\n", 1)[0]}`);
        console.log(`[new-page-edit-link] ${name}: the link holder sees: ${seen}`);
        await browserPage.close();
        return;
      }
      await browserPage.goto(`${sharedDatasetViewerOrigin}/s${new URL(link.url).hash}`);
      await browserPage.getByRole("button", { name: fileButton, exact: true }).click({ timeout: 15_000 });
      await browserPage.getByRole("button", { name: "Edit file", exact: true }).click({ timeout: 15_000 });
      const linkEditor = browserPage.getByRole("textbox", { name: "Shared file editor", exact: true });
      await expect(linkEditor).toHaveAttribute("contenteditable", "true", { timeout: 120_000 });
      await expect(linkEditor).toBeEditable({ timeout: 15_000 });
      const marker = ` browser-${randomBytes(8).toString("hex")}`;
      await linkEditor.getByText(body, { exact: true }).click({ timeout: 15_000 });
      await browserPage.keyboard.press("End");
      await browserPage.keyboard.insertText(marker);
      await expect.poll(async () => (await ownerFile(path)).includes(`${body}${marker}`),
        { message: `${name}: the link holder's edit reaches the owner's file`, timeout: 120_000, intervals: [1000] }).toBe(true);
      await browserPage.close();
    };

    // --- Control: a file the app wrote and captured before its editor opened --
    const written = "notes/written.md";
    const writtenBody = "Written by the app. Then typed.";
    await page.evaluate(({ workspaceId, path }) =>
      (window as unknown as { dohcDesktop: Api }).dohcDesktop.createWorkspaceFile({ workspaceId, relativePath: path, initialText: "Written by the app.\n" }),
    { workspaceId, path: written });
    await expect.poll(() => textFileTrackedByEngine(temp.rootPath, written), { timeout: 30_000 }).toBe(true);
    const explorer = page.getByTestId(activityPin("explorer"));
    if ((await explorer.getAttribute("aria-current")) !== "page") await explorer.click();
    await revealExplorerPath(page, written);
    await explorerRow(page, written).click();
    await expect(page.getByTestId("markdown-edit-toggle")).toHaveCount(0, { timeout: 30_000 });
    await expect(editor(page)).toBeVisible();
    await editor(page).getByText("Written by the app.").click();
    await page.keyboard.press(process.platform === "darwin" ? "Meta+ArrowRight" : "End");
    await page.keyboard.type(" Then typed.");
    await expect.poll(async () => await ownerFile(written), { timeout: 30_000 }).toContain(writtenBody);
    await page.keyboard.press("ControlOrMeta+w");
    await expect(editor(page)).toHaveCount(0);
    await shareAndEdit("control, a file written and captured before it opened", written, writtenBody, true);

    // --- New page, typed, and closed before any share ------------------------
    const closedBody = "Typed, closed, then shared.";
    const closed = await typeNewPage(page, "Closed page", closedBody);
    await page.keyboard.press("ControlOrMeta+w");
    await expect(editor(page)).toHaveCount(0);
    await expect.poll(async () => await ownerFile(closed), { timeout: 30_000 }).toContain(closedBody);
    await shareAndEdit("New page, closed before it is shared", closed, closedBody, true);

    // --- New page, shared with its tab open, then closed: it goes live -------
    // Its file reaches the server only when the tab closes (#3785).
    const openBody = "Typed with the tab open.";
    const open = await typeNewPage(page, "Open page", openBody);
    await shareAndEdit("New page, shared with its tab open, then closed", open, openBody, false, async () => {
      await page.keyboard.press("ControlOrMeta+w");
      await expect(editor(page)).toHaveCount(0);
    });

    expect(shared.failures).toEqual([]);
    expect(owner.logs.filter(entry => entry.level === "pageerror")).toEqual([]);
  } catch (error) {
    bodyFailure = { error };
    throw error;
  } finally {
    if (stack) await testInfo.attach("relay output", { contentType: "text/plain", body: stack.relayOutput() }).catch(() => undefined);
    const cleanup = await Promise.allSettled([shared?.close(), ...contexts.map(context => context.close()), owner?.close()]);
    trust?.restore();
    cleanup.push(...await Promise.allSettled([stack?.close()]));
    cleanup.push(...await Promise.allSettled([temp.cleanup()]));
    const failures = cleanup.filter((result): result is PromiseRejectedResult => result.status === "rejected");
    if (failures.length && !bodyFailure) throw new AggregateError(failures.map(result => result.reason), "New page Edit link test cleanup failed.");
  }
});
