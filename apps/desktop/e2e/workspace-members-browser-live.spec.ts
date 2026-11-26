import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { test, expect, type BrowserContext, type Page } from "@playwright/test";
import { activityPin, editorTabTestId, settingsNavPin } from "../src/testPins";
import { launchDesktopApp, type LaunchedDesktopApp } from "./helpers/desktopApp";
import {
  approveDesktop,
  createVerifiedAccount,
  openDesktopApproval,
  startSelfHostOnboardingStack,
  trustFixtureCa,
} from "./helpers/selfHostOnboarding";
import {
  createTempWorkspace,
  explorerRow,
  openWorkspaceFromFirstRun,
  revealExplorerPath,
  waitForWorkspaceFile,
  writeWorkspaceFiles,
} from "./helpers/workspace";

// A workspace member at Edit who has no dohc app types in a page in a browser,
// and the owner's dohc receives the text. Everything is real: accounts on
// Postgres, the self-hosted server's live host running the native engine, the
// self-host share-web behind the same HTTPS origin, and the owner's desktop.
// The member's open is what makes the server host the page, as in the app.
// The member gets there from the invitation email the server sends.
//
// workspace-members-live.spec.ts covers a member in the dohc app.

test.skip(
  !process.env.POSTGRES_URL && process.env.DOHC_REQUIRE_POSTGRES !== "1",
  "Run with disposable POSTGRES_URL and DOHC_REQUIRE_POSTGRES=1.",
);

const PATH = "notes/plan.md";
const SEED = "# Fundraiser plan\n\nThe owner writes here.\n\nThe member writes here.\n";
const MEMBER_TEXT = " I will bring the tables.";

const editor = (page: Page) => page.getByTestId("markdown-editor");

async function clickDocument(page: Page, path: string) {
  if ((await page.getByTestId(activityPin("explorer")).getAttribute("aria-current")) !== "page") {
    await page.getByTestId(activityPin("explorer")).click();
  }
  await revealExplorerPath(page, path);
  await explorerRow(page, path).click();
}

test("@members-browser-live a member at Edit types in a page in the browser and the owner's dohc receives the text", async ({
  browser,
}, testInfo) => {
  test.setTimeout(600_000);
  const signal = AbortSignal.timeout(testInfo.timeout - 10_000);
  const ownerTemp = await createTempWorkspace();
  let stack: Awaited<ReturnType<typeof startSelfHostOnboardingStack>> | undefined;
  let trust: ReturnType<typeof trustFixtureCa> | undefined;
  let bodyFailure: { error: unknown } | undefined;
  const contexts: BrowserContext[] = [];
  const desktops: LaunchedDesktopApp[] = [];
  const failures: string[] = [];
  const shot = (name: string) => testInfo.outputPath(`${name}.png`);
  const ownerAccount = {
    email: `owner-${randomUUID()}@example.test`,
    password: `Owner-proof-${randomUUID()}`,
    name: "Ana",
  };
  const memberAccount = {
    email: `member-${randomUUID()}@example.test`,
    password: `Member-proof-${randomUUID()}`,
    name: "Sam",
  };
  try {
    stack = await startSelfHostOnboardingStack(ownerTemp.baseDir, {
      live: true,
      shareWeb: true,
      relayMail: true,
      signal,
    });
    const origin = stack.relayUrl;
    trust = trustFixtureCa(stack.ca!.ca);
    // Sam's browser. Chromium checks the fixture CA for pages through the route, but a WebSocket
    // bypasses routes, so this context accepts the test certificate for the live socket too.
    const samContext = await browser.newContext({
      ignoreHTTPSErrors: true,
      viewport: { width: 1280, height: 800 },
      reducedMotion: "reduce",
    });
    contexts.push(samContext);
    const sam = await samContext.newPage();
    sam.on("pageerror", (error) => failures.push(String(error)));
    await createVerifiedAccount(sam, stack.account, memberAccount);

    // --- The owner syncs the workspace -------------------------------------
    await writeWorkspaceFiles(ownerTemp, [{ path: PATH, contents: SEED }]);
    const owner = await launchDesktopApp({ workspace: ownerTemp, env: stack.trustEnv });
    desktops.push(owner);
    const { workspaceId } = await openWorkspaceFromFirstRun(owner.page, ownerTemp);
    await owner.page.emulateMedia({ reducedMotion: "reduce" });
    const approvalContext = await browser.newContext();
    contexts.push(approvalContext);
    await trust.route(approvalContext, origin);
    const ownerApproval = await approvalContext.newPage();
    await owner.page.getByTestId(activityPin("settings")).click();
    await owner.page.getByTestId(settingsNavPin("cloud")).click();
    await owner.page.getByTestId("settings-cloud-connect").click();
    await expect(owner.page.getByTestId("cloud-sync-panel")).toBeVisible();
    const approval = await openDesktopApproval(owner, ownerApproval, origin);
    await createVerifiedAccount(ownerApproval, stack.account, ownerAccount, approval);
    await approveDesktop(ownerApproval, ownerAccount);
    await expect(owner.page.getByTestId("settings-row-account")).toContainText(ownerAccount.email);
    const syncSwitch = owner.page.getByRole("switch", { name: "Sync this workspace" });
    await syncSwitch.click();
    await expect(syncSwitch).toHaveAttribute("aria-checked", "true");
    await waitForWorkspaceFile(owner.page, workspaceId, PATH);

    // --- The owner invites Sam and sets members to Edit --------------------
    await owner.page.getByTestId(settingsNavPin("members")).click();
    const members = owner.page.getByTestId("settings-members-page");
    await expect(members).toBeVisible({ timeout: 30_000 });
    await members.getByTestId("settings-members-invite-email").fill(memberAccount.email);
    const mailBefore = stack.account.mail.messages.length;
    await members.getByTestId("settings-members-invite-send").click();
    await expect(members.getByTestId("settings-members-invite-email")).toHaveValue("", {
      timeout: 30_000,
    });
    await expect(members.getByTestId("settings-members-invite-sent")).toContainText(
      `Emailed the invitation to ${memberAccount.email}.`,
    );
    await expect(
      members.getByTestId("settings-members-row").filter({ hasText: memberAccount.email }),
    ).toBeVisible();
    await owner.page.screenshot({ path: shot("member-invite-emailed"), animations: "disabled" });
    await expect
      .poll(() => stack!.account.mail.messages.length, { timeout: 30_000 })
      .toBe(mailBefore + 1);
    const invitation = stack.account.mail.messages[mailBefore]!;
    expect(invitation).toMatch(new RegExp(`^To: .*${memberAccount.email}`, "mu"));
    expect(invitation).toMatch(/^Subject: .*Ana[ _]invited[ _]you[ _]to[ _]/mu);
    expect(invitation).not.toContain(memberAccount.password);
    const browserLink = /^(https:\/\/\S+\/workspaces)\r?$/mu.exec(invitation)?.[1];
    expect(browserLink).toBe(`${origin}/workspaces`);
    const edit = members
      .getByTestId("settings-members-level-control")
      .getByRole("radio", { name: "Edit" });
    await edit.click();
    await expect(members.getByTestId("settings-members-level-busy")).toHaveCount(0, {
      timeout: 30_000,
    });
    await expect(edit).toBeChecked();
    await owner.page.getByRole("button", { name: "Close settings", exact: true }).click();
    // The server hosts a page only once its owner has opened it in dohc, which gives it a live-editing history.
    // The owner then closes it, so Sam's open is what starts hosting it.
    await clickDocument(owner.page, PATH);
    await expect(editor(owner.page)).toBeVisible({ timeout: 60_000 });
    await expect(owner.page.getByTestId("sync-status")).toHaveAttribute("data-state", "synced", {
      timeout: 60_000,
    });
    const ownerTab = owner.page.getByTestId(editorTabTestId(PATH));
    await ownerTab.hover();
    await ownerTab.getByRole("button", { name: /^Close / }).click();
    await expect(ownerTab).toHaveCount(0);

    // --- Sam follows the invitation email, then types in the page ----------
    await sam.goto(browserLink!);
    const joined = sam.getByRole("region", { name: "Joined" });
    const signIn = sam.getByRole("button", { name: "Sign in", exact: true });
    await expect(signIn.or(joined)).toBeVisible({ timeout: 30_000 });
    if (await signIn.isVisible()) {
      await sam.getByLabel("Email", { exact: true }).fill(memberAccount.email);
      await sam.getByLabel("Password", { exact: true }).fill(memberAccount.password);
      await signIn.click();
    }
    await joined.getByRole("link").first().click({ timeout: 30_000 });
    const files = sam.getByRole("navigation", { name: "Workspace files" });
    await files.getByRole("treeitem", { name: "plan.md" }).click();
    const browserEditor = sam.getByRole("textbox", { name: "Shared file editor", exact: true });
    await expect(browserEditor).toHaveAttribute("contenteditable", "true", { timeout: 180_000 });
    await expect(browserEditor).toContainText("The member writes here.");
    await browserEditor.getByText("The member writes here.", { exact: true }).click();
    await sam.keyboard.press("End");
    await sam.keyboard.insertText(MEMBER_TEXT);
    await expect(browserEditor).toContainText(`The member writes here.${MEMBER_TEXT}`);

    // --- The owner's dohc receives the text ---------------------------------
    // The engine replaces the file with two renames, so a read can land between them and find no file.
    await expect
      .poll(
        async () =>
          (
            await readFile(join(ownerTemp.rootPath, PATH), "utf8").catch((error) => {
              if (error?.code === "ENOENT") return "";
              throw error;
            })
          ).includes(`The member writes here.${MEMBER_TEXT}`),
        { timeout: 120_000, intervals: [1000] },
      )
      .toBe(true);
    await clickDocument(owner.page, PATH);
    await expect(editor(owner.page)).toContainText(`The member writes here.${MEMBER_TEXT}`, {
      timeout: 60_000,
    });

    for (const [width, height, size] of [
      [1280, 800, "wide"],
      [390, 844, "phone"],
    ] as const) {
      await sam.setViewportSize({ width, height });
      for (const colorScheme of ["light", "dark"] as const) {
        await sam.emulateMedia({ colorScheme, reducedMotion: "reduce" });
        await expect(browserEditor).toContainText(MEMBER_TEXT.trim());
        await sam.screenshot({
          path: shot(`member-browser-live-${size}-${colorScheme}`),
          animations: "disabled",
        });
      }
    }
    await owner.page.bringToFront();
    await owner.page.screenshot({
      path: shot("member-browser-live-owner"),
      animations: "disabled",
    });

    expect(failures).toEqual([]);
    expect(owner.logs.filter((entry) => entry.level === "pageerror")).toEqual([]);
  } catch (error) {
    bodyFailure = { error };
    throw error;
  } finally {
    if (stack) {
      await testInfo
        .attach("relay output", { contentType: "text/plain", body: stack.relayOutput() })
        .catch(() => undefined);
      await testInfo
        .attach("share-web output", { contentType: "text/plain", body: stack.shareWebOutput() })
        .catch(() => undefined);
    }
    const cleanup = await Promise.allSettled([
      ...contexts.map((context) => context.close()),
      ...desktops.map((desktop) => desktop.close()),
    ]);
    trust?.restore();
    cleanup.push(...(await Promise.allSettled([stack?.close()])));
    cleanup.push(...(await Promise.allSettled([ownerTemp.cleanup()])));
    const cleanupFailures = cleanup.filter(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    if (cleanupFailures.length && !bodyFailure)
      throw new AggregateError(
        cleanupFailures.map((result) => result.reason),
        "Member browser live cleanup failed.",
      );
  }
});
