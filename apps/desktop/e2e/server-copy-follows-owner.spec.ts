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
  revealExplorerPath,
  waitForWorkspaceFile,
  writeWorkspaceFiles,
} from "./helpers/workspace";

test.skip(
  !process.env.POSTGRES_URL && process.env.DOHC_REQUIRE_POSTGRES !== "1",
  "Run with disposable POSTGRES_URL and DOHC_REQUIRE_POSTGRES=1.",
);

type Api = DohcDesktopBridge;
const editor = (page: Page) => page.getByTestId("markdown-editor");

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

test("@server-copy-follows-owner a link shows the owner's latest save of a note that is not live, through a Stop and a Resume", async ({
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
  const timings: string[] = [];
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

    const ownerFileOrEmptyMidRename = (path: string) =>
      readFile(join(temp.rootPath, path), "utf8").catch((error) => {
        if (error?.code === "ENOENT") return "";
        throw error;
      });
    const shareLink = (path: string, access: "view" | "edit") =>
      page.evaluate(
        ({ workspaceId, path, access }) =>
          (window as unknown as { dohcDesktop: Api }).dohcDesktop.createRelayShareLink({
            workspaceId,
            paths: [path],
            access,
          }),
        { workspaceId, path, access },
      );
    const status = async (path: string) =>
      (
        await page.evaluate(
          (workspaceId) =>
            (window as unknown as { dohcDesktop: Api }).dohcDesktop.listOwnerLiveDocuments({
              workspaceId,
            }),
          workspaceId,
        )
      ).documents.find((document) => document.path === path)?.status ?? "missing";
    const viewer = await shared.browser.newPage();
    viewer.on("pageerror", (error) => shared!.failures.push(error.message));
    const linkText = async (url: string, path: string) => {
      await viewer.goto(`${sharedDatasetViewerOrigin}/s${new URL(url).hash}`);
      await viewer
        .getByRole("button", { name: path.slice(path.lastIndexOf("/") + 1), exact: true })
        .click({ timeout: 15_000 });
      return await viewer.locator("main.content").innerText({ timeout: 15_000 });
    };
    const linkFollows = async (label: string, url: string, path: string, words: string) => {
      await expect
        .poll(async () => (await ownerFileOrEmptyMidRename(path)).includes(words), {
          message: `${label}: the owner's file has the words`,
          timeout: 60_000,
          intervals: [250],
        })
        .toBe(true);
      const saved = Date.now();
      await expect
        .poll(async () => (await linkText(url, path).catch(() => "")).includes(words), {
          message: `${label}: the link shows the owner's latest save`,
          timeout: 60_000,
          intervals: [250],
        })
        .toBe(true);
      const elapsed = Date.now() - saved;
      timings.push(`${label}: ${elapsed} ms`);
      return elapsed;
    };

    await test.step("a note shared by View link with its tab open shows on the link and follows each save", async () => {
      const body = "Typed with the tab open.";
      const open = await typeNewPage(page, "Open page", body);
      const view = await shareLink(open, "view");
      const typist = typeNumberedWordsUntilStopped(page, "open");
      await expect.poll(async () => typist.words.length, { timeout: 30_000 }).toBeGreaterThan(10);
      await typist.stop();
      const elapsed = await linkFollows(
        "tab open, typed through the share",
        view.url,
        open,
        `${body} ${typist.words.join(" ")}`,
      );
      expect.soft(elapsed, "the link shows the note within about 5 s").toBeLessThan(8_000);
      await page.keyboard.type(" A later save.");
      expect
        .soft(
          await linkFollows("tab open, a later save", view.url, open, " A later save."),
          "the link shows a later save within about 5 s",
        )
        .toBeLessThan(8_000);
      await page.keyboard.press("ControlOrMeta+w");
      await expect(editor(page)).toHaveCount(0);
    });

    const body = "Typed, closed, then shared.";
    const live = await typeNewPage(page, "Live page", body);
    await page.keyboard.press("ControlOrMeta+w");
    await expect(editor(page)).toHaveCount(0);
    await expect
      .poll(async () => await ownerFileOrEmptyMidRename(live), { timeout: 30_000 })
      .toContain(body);
    const edit = await shareLink(live, "edit");
    const view = await shareLink(live, "view");
    await expect.poll(() => status(live), { timeout: 180_000, intervals: [1000] }).toBe("ready");

    const linkEditor = await shared.browser.newPage();
    linkEditor.on("pageerror", (error) => shared!.failures.push(error.message));
    const openLinkEditor = async () => {
      await linkEditor.goto(`${sharedDatasetViewerOrigin}/s${new URL(edit.url).hash}`);
      await linkEditor.getByRole("button", { name: live, exact: true }).click({ timeout: 15_000 });
      await linkEditor
        .getByRole("button", { name: "Edit file", exact: true })
        .click({ timeout: 15_000 });
      const box = linkEditor.getByRole("textbox", { name: "Shared file editor", exact: true });
      await expect(box).toHaveAttribute("contenteditable", "true", { timeout: 120_000 });
      await expect(box).toBeEditable({ timeout: 15_000 });
      return box;
    };
    const liveDocuments = page.getByTestId("live-documents-dialog");
    const openLiveDocuments = async () => {
      await page.getByTestId(activityPin("settings")).click();
      await page.getByTestId(settingsNavPin("cloud")).click();
      await page.getByRole("button", { name: "Open live documents", exact: true }).click();
      await expect(liveDocuments).toBeVisible();
    };
    const closeLiveDocuments = async () => {
      await liveDocuments.getByRole("button", { name: "Close", exact: true }).click();
      await expect(liveDocuments).toHaveCount(0);
      await page.keyboard.press("Escape");
      await expect(page.getByTestId("settings-dialog")).toHaveCount(0);
    };
    const openOnDesktop = async () => {
      await revealExplorerPath(page, live);
      await explorerRow(page, live).click();
      await expect(editor(page)).toBeVisible();
      await editor(page).click();
      await page.keyboard.press("ControlOrMeta+End");
    };

    await test.step("after a Stop with a link editor typing through it, the link follows the owner's saves", async () => {
      const box = await openLinkEditor();
      await box.getByText(body, { exact: false }).click({ timeout: 15_000 });
      await linkEditor.keyboard.press("End");
      const typist = typeNumberedWordsUntilStopped(linkEditor, "link");
      await expect.poll(async () => typist.words.length, { timeout: 30_000 }).toBeGreaterThan(5);
      await openLiveDocuments();
      const row = liveDocuments.getByTestId(`live-document-row-${live}`);
      await row.getByRole("button", { name: `Stop live editing for ${live}`, exact: true }).click();
      await expect(
        row.getByRole("button", { name: `Resume live editing for ${live}`, exact: true }),
      ).toBeEnabled({ timeout: 60_000 });
      await typist.stop();
      await closeLiveDocuments();
      const reached = async () => {
        const file = await ownerFileOrEmptyMidRename(live);
        return typist.words.filter((word) => file.includes(word));
      };
      console.log(
        `[server-copy-follows-owner] after the Stop the link editor's page shows: ${await box.innerText()}`,
      );
      await expect
        .poll(async () => (await reached()).length, {
          message: "the link editor's typing before the Stop reached the owner",
          timeout: 60_000,
          intervals: [500],
        })
        .toBeGreaterThan(0);
      const words = await reached();
      console.log(
        `[server-copy-follows-owner] the link editor typed ${typist.words.length} words through the Stop; ${words.length} reached the owner's file; last typed ${typist.words.at(-1)}, last reached ${words.at(-1)}`,
      );

      await openOnDesktop();
      for (const [index, words] of [" Owner after Stop one.", " Owner after Stop two."].entries()) {
        await page.keyboard.type(words);
        await linkFollows(`after the Stop, save ${index + 1}`, view.url, live, words.trim());
      }
    });

    await test.step("Resume with the owner typing through it, and the link editor's edits reach the owner again", async () => {
      const typist = typeNumberedWordsUntilStopped(page, "owner");
      await expect.poll(async () => typist.words.length, { timeout: 30_000 }).toBeGreaterThan(5);
      await page.evaluate(
        ({ workspaceId, path }) =>
          (window as unknown as { dohcDesktop: Api }).dohcDesktop.resumeOwnerLiveDocument({
            workspaceId,
            path,
          }),
        { workspaceId, path: live },
      );
      const resumedAt = typist.words.length;
      await expect
        .poll(async () => typist.words.length, { timeout: 30_000 })
        .toBeGreaterThan(resumedAt + 5);
      await typist.stop();
      const typed = typist.words.join(" ");
      await expect
        .poll(async () => (await ownerFileOrEmptyMidRename(live)).includes(typed), {
          message: "every word the owner typed through the Resume is in the owner's file",
          timeout: 60_000,
        })
        .toBe(true);
      await page.keyboard.press("ControlOrMeta+w");
      await expect(editor(page)).toHaveCount(0);
      await expect.poll(() => status(live), { timeout: 180_000, intervals: [1000] }).toBe("ready");
      const box = await openLinkEditor();
      await expect(box).toContainText(typist.words.at(-1)!, { timeout: 60_000 });
      const marker = ` resumed-${randomBytes(6).toString("hex")}`;
      await box.getByText(typist.words.at(-1)!, { exact: false }).click({ timeout: 15_000 });
      await linkEditor.keyboard.press("End");
      await linkEditor.keyboard.insertText(marker);
      await expect
        .poll(async () => (await ownerFileOrEmptyMidRename(live)).includes(marker.trim()), {
          message: "after Resume, the link editor's edit reaches the owner's file",
          timeout: 120_000,
          intervals: [1000],
        })
        .toBe(true);
    });

    await test.step("the owner's last words before a Stop show on the link, with a link editor typing through it, and a later save follows", async () => {
      await openOnDesktop();
      const owner = typeNumberedWordsUntilStopped(page, "last");
      await expect.poll(async () => owner.words.length, { timeout: 30_000 }).toBeGreaterThan(10);
      await owner.stop();
      const linkTypist = typeNumberedWordsUntilStopped(linkEditor, "late");
      await page.keyboard.press("ControlOrMeta+w");
      await expect(editor(page)).toHaveCount(0);
      await expect
        .poll(
          () =>
            page
              .evaluate(
                ({ workspaceId, path }) =>
                  (window as unknown as { dohcDesktop: Api }).dohcDesktop.stopOwnerLiveDocument({
                    workspaceId,
                    path,
                  }),
                { workspaceId, path: live },
              )
              .then(
                () => true,
                (error: unknown) => {
                  if (String(error).includes("is open in an editor in dohc")) return false;
                  throw error;
                },
              ),
          { message: "the Stop is taken once the closed tab lets go of the note", timeout: 30_000 },
        )
        .toBe(true);
      await linkTypist.stop();
      await linkFollows(
        "the owner's last words before a Stop",
        view.url,
        live,
        owner.words.join(" "),
      );
      await openOnDesktop();
      await page.keyboard.type(" A later save after the Stop.");
      await linkFollows(
        "a later save after the Stop",
        view.url,
        live,
        "A later save after the Stop.",
      );
    });

    console.log(`[server-copy-follows-owner] timings:\n${timings.join("\n")}`);
    expect(shared.failures).toEqual([]);
    expect(owner.logs.filter((entry) => entry.level === "pageerror")).toEqual([]);
  } catch (error) {
    bodyFailure = { error };
    throw error;
  } finally {
    if (timings.length) console.log(`[server-copy-follows-owner] timings:\n${timings.join("\n")}`);
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
        "Server copy test cleanup failed.",
      );
  }
});
