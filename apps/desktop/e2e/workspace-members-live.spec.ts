import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { test, expect, type BrowserContext, type Page } from "@playwright/test";
import { activityPin, editorTabTestId, settingsNavPin } from "../src/testPins";
import type { DohcDesktopBridge } from "../src/ipc/bridgeContract";
import { launchDesktopApp, type LaunchedDesktopApp } from "./helpers/desktopApp";
import { ownerEnrollment } from "./helpers/engineDb";
import { approveDesktop, createVerifiedAccount, openDesktopApproval, startSelfHostOnboardingStack, trustFixtureCa } from "./helpers/selfHostOnboarding";
import { createTempWorkspace, explorerRow, openWorkspaceFromFirstRun, revealExplorerPath, waitForWorkspaceFile, writeWorkspaceFiles } from "./helpers/workspace";

// A workspace member at Edit and the owner write in one document at the same
// time, on a self-hosted server: real accounts, and HTTPS from a test CA,
// which desktop live editing needs. The owner invites the member from
// Members and sets members to Edit. The server hosts a document only once
// someone opens it, so the member's open starts hosting. Each person then
// sees the other's typing. Text only: presence is not part of this proof.
//
// Then the owner writes a page on disk and quits dohc before opening it. The
// member's open hears at once that editing starts once the owner's dohc is
// online, and the page stays readable. The owner's dohc starts again and
// starts the page's live history by itself, with no click, and the member's
// page turns live where it is. Both write in it.
//
// Then the server's host is full, and the member opens another document. It
// stays readable, says dohc could not open it for editing, and never waits.
//
// workspace-members.spec.ts covers the rest of membership on a plain http relay.

test.skip(!process.env.POSTGRES_URL && process.env.DOHC_REQUIRE_POSTGRES !== "1", "Run with disposable POSTGRES_URL and DOHC_REQUIRE_POSTGRES=1.");

const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as {
  DatabaseSync: new (path: string) => {
    exec(sql: string): void;
    prepare(sql: string): { get(...values: unknown[]): Record<string, unknown> | undefined; run(...values: unknown[]): unknown };
    close(): void;
  };
};

const PATH = "notes/plan.md";
const LATER = "notes/later.md";
const SEED = "# Fundraiser plan\n\nThe owner writes here.\n\nThe member writes here.\n";
const LATER_SEED = "# Later\n\nIdeas for next year.\n";
const FRESH = "notes/raffle.md";
const FRESH_SEED = "# Raffle\n\nPrizes from local shops.\n";
const OWNER_PRIZE = "The bakery gives a cake.";
const MEMBER_PRIZE = "The bookshop gives vouchers.";
const OWNER_TEXT = "Book the hall for Saturday.";
const MEMBER_TEXT = "I will bring the tables.";
// The server's live document cap, which step 5 may change. The test reads the server's refusal, not this number.
const HOST_MAX_DOCUMENTS = 64;

const editor = (page: Page) => page.getByTestId("markdown-editor");

async function setTheme(page: Page, theme: "Light" | "Dark") {
  await page.getByTestId(activityPin("settings")).click();
  await page.getByTestId(settingsNavPin("appearance")).click();
  await page.getByRole("radio", { name: theme, exact: true }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", theme.toLowerCase());
  await page.getByRole("button", { name: "Close settings", exact: true }).click();
}

/** Starts connecting this desktop to the server from Settings, and opens the approval page. */
async function connectAccount(desktop: LaunchedDesktopApp, approvalPage: Page, origin: string) {
  const page = desktop.page;
  await page.getByTestId(activityPin("settings")).click();
  await page.getByTestId(settingsNavPin("cloud")).click();
  await page.getByTestId("settings-cloud-connect").click();
  await expect(page.getByTestId("cloud-sync-panel")).toBeVisible();
  return openDesktopApproval(desktop, approvalPage, origin);
}

async function clickDocument(page: Page, path: string) {
  if ((await page.getByTestId(activityPin("explorer")).getAttribute("aria-current")) !== "page") {
    await page.getByTestId(activityPin("explorer")).click();
  }
  await revealExplorerPath(page, path);
  await explorerRow(page, path).click();
}

async function openDocument(page: Page, path: string) {
  await clickDocument(page, path);
  await expect(editor(page)).toBeVisible({ timeout: 60_000 });
}

/** Opens the document and waits for its live session: the local Edit toggle is gone and the editor takes typing. */
async function openLive(page: Page, path = PATH) {
  await openDocument(page, path);
  await expect(page.getByTestId("markdown-edit-toggle")).toHaveCount(0, { timeout: 120_000 });
  await expect(editor(page)).toHaveAttribute("contenteditable", "true", { timeout: 120_000 });
}

async function typeAfter(page: Page, anchor: string, text: string) {
  await editor(page).getByText(anchor).click();
  await page.keyboard.press(process.platform === "darwin" ? "Meta+ArrowRight" : "End");
  await page.keyboard.type(text);
}

async function hostedStatus(page: Page, workspaceId: string, path: string) {
  const live = await page.evaluate(workspaceId =>
    (window as unknown as { dohcDesktop: DohcDesktopBridge }).dohcDesktop.listOwnerLiveDocuments({ workspaceId }), workspaceId);
  return live.documents.find(document => document.path === path)?.status ?? "not hosted";
}

/**
 * Fills the server's live host with paused documents the host has already
 * let go of. They count against its cap and it hosts none of them.
 */
function fillHost(relayDatabase: string, workspaceId: string): number {
  const db = new DatabaseSync(relayDatabase);
  try {
    db.exec("PRAGMA busy_timeout=10000");
    const workspace = db.prepare("SELECT owner_user_id, replication_epoch, stream_identity FROM sync_relay_workspaces WHERE workspace_id=?").get(workspaceId)!;
    const active = Number(db.prepare("SELECT count(*) AS n FROM sync_relay_service_host_enrollments WHERE retired=0").get()!.n);
    const insert = db.prepare(`INSERT INTO sync_relay_service_host_enrollments(workspace_id,object_id,path,owner_user_id,share_id,replication_epoch,stream_identity,
      owner_stop,enabled,retired,created_at_ms,updated_at_ms,host_drained_at_ms,owner_demand,demand_at_ms,accounted_bytes)
      VALUES (?,?,?,?,NULL,?,?,'pause',0,0,1,1,1,1,1,64)`);
    let added = 0;
    for (let i = active; i < HOST_MAX_DOCUMENTS; i++, added++) {
      insert.run(workspaceId, `filler-object-${i}`, `filler/${i}.md`, workspace.owner_user_id, workspace.replication_epoch, workspace.stream_identity);
    }
    return added;
  } finally { db.close(); }
}

test("@members-live a member at Edit and the owner write in one document and each sees the other's text", async ({ browser }, testInfo) => {
  test.setTimeout(600_000);
  const signal = AbortSignal.timeout(testInfo.timeout - 10_000);
  const ownerTemp = await createTempWorkspace();
  const memberTemp = await createTempWorkspace();
  let stack: Awaited<ReturnType<typeof startSelfHostOnboardingStack>> | undefined;
  let trust: ReturnType<typeof trustFixtureCa> | undefined;
  let bodyFailure: { error: unknown } | undefined;
  const contexts: BrowserContext[] = [];
  const desktops: LaunchedDesktopApp[] = [];
  const shot = (name: string) => testInfo.outputPath(`${name}.png`);
  const ownerAccount = { email: `owner-${randomUUID()}@example.test`, password: `Owner-proof-${randomUUID()}`, name: "Ana" };
  const memberAccount = { email: `member-${randomUUID()}@example.test`, password: `Member-proof-${randomUUID()}`, name: "Sam" };
  try {
    stack = await startSelfHostOnboardingStack(ownerTemp.baseDir, { live: true, signal });
    const origin = stack.relayUrl;
    trust = trustFixtureCa(stack.ca!.ca);
    const approvalPage = async () => {
      const context = await browser.newContext();
      contexts.push(context);
      await trust!.route(context, origin);
      return context.newPage();
    };
    const memberPage = await approvalPage();
    await createVerifiedAccount(memberPage, stack.account, memberAccount);

    // --- The owner syncs the workspace -------------------------------------
    await writeWorkspaceFiles(ownerTemp, [{ path: PATH, contents: SEED }, { path: LATER, contents: LATER_SEED }]);
    let owner = await launchDesktopApp({ workspace: ownerTemp, env: stack.trustEnv });
    desktops.push(owner);
    const { workspaceId } = await openWorkspaceFromFirstRun(owner.page, ownerTemp);
    await owner.page.emulateMedia({ reducedMotion: "reduce" });
    const ownerApproval = await approvalPage();
    const approval = await connectAccount(owner, ownerApproval, origin);
    await createVerifiedAccount(ownerApproval, stack.account, ownerAccount, approval);
    await approveDesktop(ownerApproval, ownerAccount);
    await expect(owner.page.getByTestId("settings-row-account")).toContainText(ownerAccount.email);
    const syncSwitch = owner.page.getByRole("switch", { name: "Sync this workspace" });
    await syncSwitch.click();
    await expect(owner.page.getByTestId("cloud-sync-code")).toBeVisible();
    await expect(syncSwitch).toHaveAttribute("aria-checked", "true");
    await waitForWorkspaceFile(owner.page, workspaceId, PATH);
    await waitForWorkspaceFile(owner.page, workspaceId, LATER);

    // --- The owner invites Sam and sets members to Edit --------------------
    await owner.page.getByTestId(settingsNavPin("members")).click();
    const members = owner.page.getByTestId("settings-members-page");
    await expect(members).toBeVisible({ timeout: 30_000 });
    await members.getByTestId("settings-members-invite-email").fill(memberAccount.email);
    await members.getByTestId("settings-members-invite-send").click();
    await expect(members.getByTestId("settings-members-invite-email")).toHaveValue("", { timeout: 30_000 });
    await expect(members.getByTestId("settings-members-row").filter({ hasText: memberAccount.email })).toBeVisible();
    const edit = members.getByTestId("settings-members-level-control").getByRole("radio", { name: "Edit" });
    await edit.click();
    await expect(members.getByTestId("settings-members-level-busy")).toHaveCount(0, { timeout: 30_000 });
    await expect(edit).toBeChecked();
    await owner.page.getByRole("button", { name: "Close settings", exact: true }).click();
    const workspaceName = (await owner.page.getByTestId("status-workspace").textContent())?.trim() ?? "";
    // The server can host a document only once its owner has opened it in dohc on a desktop, which gives it a live-editing history.
    // The owner then closes it, so it is not open on their desktop when Sam's open starts hosting it.
    await openDocument(owner.page, PATH);
    await expect(owner.page.getByTestId("sync-status")).toHaveAttribute("data-state", "synced", { timeout: 60_000 });
    const ownerTab = owner.page.getByTestId(editorTabTestId(PATH));
    await ownerTab.hover();
    await ownerTab.getByRole("button", { name: /^Close / }).click();
    await expect(ownerTab).toHaveCount(0);
    // Edit for members hosts nothing by itself. A document is hosted once someone opens it.
    expect(await hostedStatus(owner.page, workspaceId, PATH)).toBe("not hosted");

    // --- Sam opens the workspace from Sharing, then the document ------------
    await writeWorkspaceFiles(memberTemp, [{ path: "mine.md", contents: "# Mine\n" }]);
    const member = await launchDesktopApp({ workspace: memberTemp, env: stack.trustEnv });
    desktops.push(member);
    const mine = member.page;
    await openWorkspaceFromFirstRun(mine, memberTemp);
    await mine.emulateMedia({ reducedMotion: "reduce" });
    await connectAccount(member, memberPage, origin);
    await approveDesktop(memberPage, memberAccount);
    await expect(mine.getByTestId("settings-row-account")).toContainText(memberAccount.email);
    await mine.getByRole("button", { name: "Close settings", exact: true }).click();
    if (!(await mine.getByTestId("sharing-view").isVisible())) await mine.getByTestId(activityPin("sharing")).click();
    const received = mine.getByTestId("sharing-received-row").filter({ hasText: workspaceName });
    await expect(received.getByTestId("sharing-row-who")).toContainText("·", { timeout: 60_000 });
    await received.locator("[data-sharing-row-focus]").hover();
    await received.getByRole("button", { name: "Share actions" }).click();
    await mine.getByRole("menuitem", { name: "Open", exact: true }).click();
    await mine.getByTestId("open-shared-view").getByTestId("open-share-start").click();
    await expect(mine.getByTestId("status-workspace")).toHaveText(workspaceName, { timeout: 120_000 });
    await openLive(mine);
    await expect(editor(mine)).toContainText("The owner writes here.", { timeout: 60_000 });
    // Sam's open is what hosted it. The owner types once their desktop has bound the hosted document,
    // so the owner's edits go to the server's copy, not straight into the workspace's history.
    await expect.poll(async () => {
      const expected = stack!.ownerLiveBinding(workspaceId, PATH);
      const actual = expected && ownerEnrollment(ownerTemp.rootPath, expected.binding);
      return await hostedStatus(owner.page, workspaceId, PATH) === "ready" && !!actual && isDeepStrictEqual(actual.binding, expected!.binding);
    }, { timeout: 120_000, intervals: [1_000] }).toBe(true);
    await openLive(owner.page);

    // --- Each person sees the other's typing -------------------------------
    await typeAfter(owner.page, "The owner writes here.", ` ${OWNER_TEXT}`);
    await expect(editor(mine)).toContainText(OWNER_TEXT, { timeout: 60_000 });
    await typeAfter(mine, "The member writes here.", ` ${MEMBER_TEXT}`);
    await expect(editor(owner.page)).toContainText(MEMBER_TEXT, { timeout: 60_000 });
    await expect(editor(mine)).toContainText(OWNER_TEXT);

    for (const theme of ["Light", "Dark"] as const) {
      for (const [who, page] of [["owner", owner.page], ["member", mine]] as const) {
        await setTheme(page, theme);
        await expect(editor(page)).toContainText(OWNER_TEXT);
        await expect(editor(page)).toContainText(MEMBER_TEXT);
        // A window behind the other one may not paint, so it comes to the front first.
        await page.bringToFront();
        await page.screenshot({ path: shot(`coedit-${who}-${theme.toLowerCase()}`), animations: "disabled" });
      }
    }

    // --- Sam opens a page the owner never opened in dohc ---------------------
    // The owner writes it on disk, and quits once Sam's dohc lists it.
    await writeWorkspaceFiles(ownerTemp, [{ path: FRESH, contents: FRESH_SEED }]);
    await waitForWorkspaceFile(owner.page, workspaceId, FRESH);
    await revealExplorerPath(mine, PATH);
    await expect(explorerRow(mine, FRESH)).toBeVisible({ timeout: 120_000 });
    expect(owner.logs.filter((entry) => entry.level === "pageerror")).toEqual([]);
    await owner.close();
    const freshOpened = Date.now();
    await clickDocument(mine, FRESH);
    const notice = mine.getByTestId("engine-may-hold-document-notice");
    const freshToast = mine.getByTestId("workspace-shell-error").filter({ hasText: 'dohc could not open "raffle.md" for editing' });
    await expect(freshToast).toContainText("Editing starts once the owner's dohc is online. You can still read it.", { timeout: 60_000 });
    testInfo.annotations.push({ type: "without-lineage answer ms", description: String(Date.now() - freshOpened) });
    // The page names its state. The toast carries the reason.
    await expect(notice).toHaveText(/^You can read this page\.\s*Try again$/);
    const reader = mine.getByTestId("view-markdown");
    await expect(reader).toContainText("Prizes from local shops.");
    await expect(reader.locator('[contenteditable="true"]')).toHaveCount(0);
    for (const theme of ["Light", "Dark"] as const) {
      await setTheme(mine, theme);
      await expect(freshToast).toBeVisible();
      await mine.bringToFront();
      await mine.screenshot({ path: shot(`without-lineage-toast-member-${theme.toLowerCase()}`), animations: "disabled" });
    }
    await freshToast.getByRole("button", { name: "Dismiss workspace error" }).click();
    for (const theme of ["Light", "Dark"] as const) {
      await setTheme(mine, theme);
      await expect(notice).toBeVisible();
      await mine.bringToFront();
      await mine.screenshot({ path: shot(`without-lineage-waiting-member-${theme.toLowerCase()}`), animations: "disabled" });
    }

    // --- The owner's dohc starts again and starts the page by itself ---------
    const ownerAgain = await launchDesktopApp({ workspace: ownerTemp, env: stack.trustEnv });
    desktops[desktops.indexOf(owner)] = ownerAgain;
    owner = ownerAgain;
    await owner.page.emulateMedia({ reducedMotion: "reduce" });
    await expect(owner.page.getByTestId("status-workspace")).toHaveText(workspaceName, { timeout: 120_000 });
    const ownerBack = Date.now();
    // Sam's page turns live where it is, with no click from either person.
    await expect(editor(mine)).toHaveAttribute("contenteditable", "true", { timeout: 180_000 });
    testInfo.annotations.push({ type: "live after owner start ms", description: String(Date.now() - ownerBack) });
    await expect(notice).toHaveCount(0);
    await expect(editor(mine)).toContainText("Prizes from local shops.");
    await expect.poll(async () => {
      const expected = stack!.ownerLiveBinding(workspaceId, FRESH);
      const actual = expected && ownerEnrollment(ownerTemp.rootPath, expected.binding);
      return await hostedStatus(owner.page, workspaceId, FRESH) === "ready" && !!actual && isDeepStrictEqual(actual.binding, expected!.binding);
    }, { timeout: 120_000, intervals: [1_000] }).toBe(true);
    await openLive(owner.page, FRESH);
    await typeAfter(owner.page, "Prizes from local shops.", ` ${OWNER_PRIZE}`);
    await expect(editor(mine)).toContainText(OWNER_PRIZE, { timeout: 60_000 });
    await typeAfter(mine, "Prizes from local shops.", ` ${MEMBER_PRIZE}`);
    await expect(editor(owner.page)).toContainText(MEMBER_PRIZE, { timeout: 60_000 });
    for (const theme of ["Light", "Dark"] as const) {
      await setTheme(mine, theme);
      await expect(editor(mine)).toContainText(MEMBER_PRIZE);
      await mine.bringToFront();
      await mine.screenshot({ path: shot(`without-lineage-live-member-${theme.toLowerCase()}`), animations: "disabled" });
    }

    // --- The host is full: Sam's next document opens read-only at once -----
    expect(fillHost(join(ownerTemp.baseDir, "relay-data", "relay.sqlite"), workspaceId)).toBeGreaterThan(0);
    const opened = Date.now();
    await clickDocument(mine, LATER);
    await expect(notice).toHaveText(/^You can read this page\.\s*Try again$/, { timeout: 60_000 });
    testInfo.annotations.push({ type: "host-full answer ms", description: String(Date.now() - opened) });
    // A toast says the same once, and its row stays in Notices.
    const toast = mine.getByTestId("workspace-shell-error").filter({ hasText: 'dohc could not open "later.md" for editing' });
    await expect(toast).toHaveCount(1);
    await expect(toast).toContainText("The server is editing too many pages right now. You can still read it.");
    // The page shows the file read-only, not the live editor.
    await expect(reader).toContainText("Ideas for next year.");
    await expect(reader.locator('[contenteditable="true"]')).toHaveCount(0);
    expect(await hostedStatus(owner.page, workspaceId, LATER)).toBe("not hosted");
    for (const theme of ["Light", "Dark"] as const) {
      await setTheme(mine, theme);
      await expect(notice).toBeVisible();
      await mine.bringToFront();
      await mine.screenshot({ path: shot(`host-full-member-${theme.toLowerCase()}`), animations: "disabled" });
    }
    // Try again asks once more and hears the same answer, without a second toast.
    await toast.getByRole("button", { name: "Dismiss workspace error" }).click();
    await notice.getByRole("button", { name: "Try again" }).click();
    await expect(notice).toBeVisible({ timeout: 60_000 });
    await expect(reader.locator('[contenteditable="true"]')).toHaveCount(0);
    await expect(toast).toHaveCount(0);

    expect(owner.logs.filter((entry) => entry.level === "pageerror")).toEqual([]);
    expect(member.logs.filter((entry) => entry.level === "pageerror")).toEqual([]);
  } catch (error) {
    bodyFailure = { error };
    throw error;
  } finally {
    if (stack) await testInfo.attach("relay output", { contentType: "text/plain", body: stack.relayOutput() }).catch(() => undefined);
    const cleanup = await Promise.allSettled([...contexts.map(context => context.close()), ...desktops.map(desktop => desktop.close())]);
    trust?.restore();
    cleanup.push(...await Promise.allSettled([stack?.close()]));
    cleanup.push(...await Promise.allSettled([memberTemp.cleanup(), ownerTemp.cleanup()]));
    const failures = cleanup.filter((result): result is PromiseRejectedResult => result.status === "rejected");
    if (failures.length && !bodyFailure) throw new AggregateError(failures.map(result => result.reason), "Members live cleanup failed.");
  }
});
