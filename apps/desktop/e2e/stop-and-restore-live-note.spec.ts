import { randomBytes, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import type { DohcDesktopBridge } from "../src/ipc/bridgeContract";
import { activityPin, settingsNavPin } from "../src/testPins";
import { launchDesktopApp, type LaunchedDesktopApp } from "./helpers/desktopApp";
import {
  approveDesktop,
  createVerifiedAccount,
  openDesktopApproval,
  startSelfHostOnboardingStack,
  trustFixtureCa,
} from "./helpers/selfHostOnboarding";
import {
  sharedDatasetViewerOrigin,
  startSharedDatasetBrowser,
} from "./helpers/sharedDatasetBrowser";
import {
  createTempWorkspace,
  explorerRow,
  openWorkspaceFromFirstRun,
  waitForWorkspaceFile,
  writeWorkspaceFiles,
} from "./helpers/workspace";

test.skip(
  !process.env.POSTGRES_URL && process.env.DOHC_REQUIRE_POSTGRES !== "1",
  "Run with disposable POSTGRES_URL and DOHC_REQUIRE_POSTGRES=1.",
);

type Api = DohcDesktopBridge;
const editor = (page: Page) => page.getByTestId("markdown-editor");

function typeNumberedWordsUntilStopped(page: Page, prefix: string) {
  const words: string[] = [];
  let typing = true;
  const done = (async () => {
    for (let index = 0; typing; index += 1) {
      const word = ` ${prefix}${index}`;
      try {
        await page.keyboard.type(word, { delay: 40 });
      } catch {
        return;
      }
      words.push(word.trim());
    }
  })();
  return {
    words,
    async stop() {
      typing = false;
      await done;
    },
  };
}

test("@stop-and-restore-live Stop and restore ends one Edit link of a live note while two link editors type, and the note goes live again", async ({
  browser,
}, testInfo) => {
  test.setTimeout(600_000);
  const signal = AbortSignal.timeout(testInfo.timeout - 10_000);
  const temp = await createTempWorkspace();
  const exchangeKey = randomBytes(32).toString("hex");
  let stack: Awaited<ReturnType<typeof startSelfHostOnboardingStack>> | undefined;
  let trust: ReturnType<typeof trustFixtureCa> | undefined;
  let owner: LaunchedDesktopApp | undefined;
  let shared: Awaited<ReturnType<typeof startSharedDatasetBrowser>> | undefined;
  const contexts: BrowserContext[] = [];
  let bodyFailure: { error: unknown } | undefined;
  const ownerAccount = {
    email: `owner-${randomUUID()}@example.test`,
    password: `Owner-${randomUUID()}`,
    name: "Owner",
  };
  try {
    stack = await startSelfHostOnboardingStack(temp.baseDir, {
      live: true,
      signal,
      linkBoundary: {
        linkKey: randomBytes(32).toString("hex"),
        relayExchangeKey: exchangeKey,
        publicViewerOrigin: sharedDatasetViewerOrigin,
      },
    });
    trust = trustFixtureCa(stack.ca!.ca);
    const approvalContext = await browser.newContext();
    contexts.push(approvalContext);
    await trust.route(approvalContext, stack.relayUrl);
    shared = await startSharedDatasetBrowser({
      relayUrl: stack.relayInnerUrl,
      exchangeKey,
      editLinks: true,
    });

    const existing = "existing.md";
    await writeWorkspaceFiles(temp, [{ path: existing, contents: "Existing\n" }]);
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
    const body = "Typed by the owner.";
    await page.keyboard.press("ControlOrMeta+n");
    await expect(page.getByLabel("Page title")).toBeFocused();
    await page.keyboard.type("Live page");
    await page.keyboard.press("Enter");
    await page.keyboard.type(body);
    const live = "Live page.md";
    await expect(explorerRow(page, live)).toBeVisible({ timeout: 15_000 });
    await expect(editor(page)).toContainText(body);
    await page.keyboard.press("ControlOrMeta+w");
    await expect(editor(page)).toHaveCount(0);

    const ownerFile = () =>
      readFile(join(temp.rootPath, live), "utf8").catch((error) => {
        if (error?.code === "ENOENT") return "";
        throw error;
      });
    await expect.poll(ownerFile, { timeout: 30_000 }).toContain(body);
    const status = async () =>
      (
        await page.evaluate(
          (workspaceId) =>
            (window as unknown as { dohcDesktop: Api }).dohcDesktop.listOwnerLiveDocuments({
              workspaceId,
            }),
          workspaceId,
        )
      ).documents.find((document) => document.path === live)?.status ?? "missing";
    const shareLink = (access: "edit") =>
      page.evaluate(
        ({ workspaceId, path, access }) =>
          (window as unknown as { dohcDesktop: Api }).dohcDesktop.createRelayShareLink({
            workspaceId,
            paths: [path],
            access,
          }),
        { workspaceId, path: live, access },
      );
    let created: Awaited<ReturnType<typeof shareLink>> | undefined;
    await expect(async () => {
      created = await shareLink("edit");
    }).toPass({ timeout: 120_000, intervals: [1000] });
    if (!created) throw new Error("The first Edit link was not created.");
    const first = created;
    const second = await shareLink("edit");
    await expect.poll(status, { timeout: 180_000, intervals: [1000] }).toBe("ready");

    const openLinkEditor = async (url: string) => {
      const linkPage = await shared!.browser.newPage();
      linkPage.on("pageerror", (error) => shared!.failures.push(error.message));
      await linkPage.goto(`${sharedDatasetViewerOrigin}/s${new URL(url).hash}`);
      await linkPage.getByRole("button", { name: live, exact: true }).click({ timeout: 15_000 });
      await linkPage
        .getByRole("button", { name: "Edit file", exact: true })
        .click({ timeout: 15_000 });
      const box = linkPage.getByRole("textbox", { name: "Shared file editor", exact: true });
      await expect(box).toHaveAttribute("contenteditable", "true", { timeout: 120_000 });
      await expect(box).toBeEditable({ timeout: 15_000 });
      await box.getByText(body, { exact: false }).click({ timeout: 15_000 });
      await linkPage.keyboard.press("End");
      return { linkPage, box };
    };
    const ended = await openLinkEditor(first.url);
    const kept = await openLinkEditor(second.url);
    const endedTypist = typeNumberedWordsUntilStopped(ended.linkPage, "ended");
    const keptTypist = typeNumberedWordsUntilStopped(kept.linkPage, "kept");
    await expect
      .poll(
        async () => {
          const file = await ownerFile();
          return (
            endedTypist.words.some((word) => file.includes(word)) &&
            keptTypist.words.some((word) => file.includes(word))
          );
        },
        {
          message: "both link editors' typing reaches the owner's file while the note is live",
          timeout: 120_000,
          intervals: [500],
        },
      )
      .toBe(true);

    let outcome: Awaited<ReturnType<Api["stopAndRestore"]>> | undefined;
    await expect
      .poll(
        async () => {
          outcome = await page.evaluate(
            ({ workspaceId, grantId }) =>
              (window as unknown as { dohcDesktop: Api }).dohcDesktop.stopAndRestore({
                workspaceId,
                target: { kind: "link", grantId },
              }),
            { workspaceId, grantId: first.grantId },
          );
          return outcome.status;
        },
        {
          message: "Stop and restore finishes while both link editors type",
          timeout: 180_000,
          intervals: [2_000],
        },
      )
      .toBe("restored");
    await endedTypist.stop();
    await keptTypist.stop();
    console.log(`[stop-and-restore-live] outcome: ${JSON.stringify(outcome)}`);
    expect(outcome).toMatchObject({ status: "restored", unfinished: null });

    const links = await page.evaluate(
      (workspaceId) =>
        (window as unknown as { dohcDesktop: Api }).dohcDesktop.listRelayShareLinks({
          workspaceId,
        }),
      workspaceId,
    );
    const linkStatus = (grantId: string) =>
      links.links.find((link) => link.grantId === grantId)?.status;
    expect(linkStatus(first.grantId), "the restored link has ended").toBe("revoked");
    expect(linkStatus(second.grantId), "the other link stays").toBe("active");
    expect(await ownerFile(), "the owner's own words stay").toContain(body);

    const paused = await status();
    console.log(`[stop-and-restore-live] the note after Stop and restore: ${paused}`);
    if (paused !== "ready") {
      await page.evaluate(
        ({ workspaceId, path }) =>
          (window as unknown as { dohcDesktop: Api }).dohcDesktop.resumeOwnerLiveDocument({
            workspaceId,
            path,
          }),
        { workspaceId, path: live },
      );
    }
    await expect
      .poll(status, {
        message: "the note goes live again after Stop and restore",
        timeout: 180_000,
        intervals: [1000],
      })
      .toBe("ready");
    const again = await openLinkEditor(second.url);
    const marker = ` after-${randomBytes(6).toString("hex")}`;
    await again.linkPage.keyboard.insertText(marker);
    await expect
      .poll(async () => (await ownerFile()).includes(marker.trim()), {
        message: "the other link's editor reaches the owner again",
        timeout: 120_000,
        intervals: [1000],
      })
      .toBe(true);
    expect(shared.failures).toEqual([]);
    expect(owner.logs.filter((entry) => entry.level === "pageerror")).toEqual([]);
  } catch (error) {
    bodyFailure = { error };
    throw error;
  } finally {
    if (stack)
      await testInfo
        .attach("relay output", { contentType: "text/plain", body: stack.relayOutput() })
        .catch(() => undefined);
    const cleanup = await Promise.allSettled([
      shared?.close(),
      ...contexts.map((context) => context.close()),
      owner?.close(),
    ]);
    trust?.restore();
    cleanup.push(...(await Promise.allSettled([stack?.close()])));
    cleanup.push(...(await Promise.allSettled([temp.cleanup()])));
    const failures = cleanup.filter(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    if (failures.length && !bodyFailure)
      throw new AggregateError(
        failures.map((result) => result.reason),
        "Stop and restore live note test cleanup failed.",
      );
  }
});
