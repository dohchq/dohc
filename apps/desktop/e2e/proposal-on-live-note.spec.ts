import { randomBytes, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import type { DohcDesktopBridge } from "../src/ipc/bridgeContract";
import { activityPin, settingsNavPin } from "../src/testPins";
import { launchDesktopApp, type LaunchedDesktopApp } from "./helpers/desktopApp";
import { noticedRefusals } from "./helpers/engineDb";
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
  activeWorkspace,
  createTempWorkspace,
  openWorkspaceFromFirstRun,
  waitForWorkspaceFile,
  writeWorkspaceFiles,
} from "./helpers/workspace";

test.skip(
  !process.env.POSTGRES_URL && process.env.DOHC_REQUIRE_POSTGRES !== "1",
  "Run with disposable POSTGRES_URL and DOHC_REQUIRE_POSTGRES=1.",
);

type Api = DohcDesktopBridge;
const PATH = "notes/plan.md";
const SEED = "# Trip plan\n\nThe first line.\n";
const FIRST = "The recipient's first change.";
const SECOND = "The recipient's second change.";
const LIVE_REFUSAL = `dohc could not accept these changes because ${PATH} is being edited live. Stop live editing for it in Live documents, then accept them.`;

type Method = {
  [K in keyof Api]: Api[K] extends (payload: never) => Promise<unknown> ? K : never;
}[keyof Api];

function call<K extends Method>(
  page: Page,
  method: K,
  payload: Parameters<Api[K]>[0],
): Promise<Awaited<ReturnType<Api[K]>>> {
  return page.evaluate(
    ({ method, payload }) =>
      (
        window as unknown as {
          dohcDesktop: Record<string, (payload: unknown) => Promise<unknown>>;
        }
      ).dohcDesktop[method]!(payload),
    { method: method as string, payload: payload as unknown },
  ) as Promise<Awaited<ReturnType<Api[K]>>>;
}

test("@proposal-on-live-note changes accepted on a live note wait for Stop, then reach the note, the owner's file and the link", async ({
  browser,
}, testInfo) => {
  test.setTimeout(600_000);
  const signal = AbortSignal.timeout(testInfo.timeout - 10_000);
  const ownerTemp = await createTempWorkspace();
  const recipientTemp = await createTempWorkspace();
  const exchangeKey = randomBytes(32).toString("hex");
  let stack: Awaited<ReturnType<typeof startSelfHostOnboardingStack>> | undefined;
  let trust: ReturnType<typeof trustFixtureCa> | undefined;
  let shared: Awaited<ReturnType<typeof startSharedDatasetBrowser>> | undefined;
  const contexts: BrowserContext[] = [];
  const desktops: LaunchedDesktopApp[] = [];
  let bodyFailure: { error: unknown } | undefined;
  const ownerAccount = {
    email: `owner-${randomUUID()}@example.test`,
    password: `Owner-${randomUUID()}`,
    name: "Owner",
  };
  const recipientAccount = {
    email: `recipient-${randomUUID()}@example.test`,
    password: `Recipient-${randomUUID()}`,
    name: "Recipient",
  };
  try {
    stack = await startSelfHostOnboardingStack(ownerTemp.baseDir, {
      live: true,
      signal,
      linkBoundary: {
        linkKey: randomBytes(32).toString("hex"),
        relayExchangeKey: exchangeKey,
        publicViewerOrigin: sharedDatasetViewerOrigin,
      },
    });
    const origin = stack.relayUrl;
    trust = trustFixtureCa(stack.ca!.ca);
    const approvalPage = async () => {
      const context = await browser.newContext();
      contexts.push(context);
      await trust!.route(context, origin);
      return context.newPage();
    };
    shared = await startSharedDatasetBrowser({
      relayUrl: stack.relayInnerUrl,
      exchangeKey,
      editLinks: true,
    });
    const recipientApproval = await approvalPage();
    await createVerifiedAccount(recipientApproval, stack.account, recipientAccount);

    await writeWorkspaceFiles(ownerTemp, [{ path: PATH, contents: SEED }]);
    const owner = await launchDesktopApp({ workspace: ownerTemp, env: stack.trustEnv });
    desktops.push(owner);
    const page = owner.page;
    const { workspaceId } = await openWorkspaceFromFirstRun(page, ownerTemp);
    await page.getByTestId(activityPin("settings")).click();
    await page.getByTestId(settingsNavPin("cloud")).click();
    await page.getByTestId("settings-cloud-connect").click();
    await expect(page.getByTestId("cloud-sync-panel")).toBeVisible();
    const ownerApproval = await approvalPage();
    const approval = await openDesktopApproval(owner, ownerApproval, origin);
    await createVerifiedAccount(ownerApproval, stack.account, ownerAccount, approval);
    await approveDesktop(ownerApproval, ownerAccount);
    const syncSwitch = page.getByRole("switch", { name: "Sync this workspace" });
    await syncSwitch.click();
    await expect(page.getByTestId("cloud-sync-code")).toBeVisible();
    await page.keyboard.press("Escape");
    await waitForWorkspaceFile(page, workspaceId, PATH);

    const ownerFile = () => readFile(join(ownerTemp.rootPath, PATH), "utf8").catch(() => "");
    const status = async () =>
      (await call(page, "listOwnerLiveDocuments", { workspaceId })).documents.find(
        (document) => document.path === PATH,
      )?.status ?? "missing";
    const openProposals = async () =>
      (await call(page, "listShareProposals", { workspaceId })).proposals;
    const stopLive = () =>
      expect
        .poll(
          () =>
            call(page, "stopOwnerLiveDocument", { workspaceId, path: PATH }).then(
              () => true,
              () => false,
            ),
          { message: "the Stop is taken", timeout: 60_000 },
        )
        .toBe(true);
    const resumeLive = async () => {
      await call(page, "resumeOwnerLiveDocument", { workspaceId, path: PATH });
      await expect.poll(status, { timeout: 180_000, intervals: [1000] }).toBe("ready");
    };
    const accept = (proposalId: string) =>
      call(page, "settleShareProposal", { workspaceId, proposalId, decision: "accept" }).then(
        () => "accepted",
        (error: unknown) => String(error),
      );
    const viewer = await shared.browser.newPage();
    viewer.on("pageerror", (error) => shared!.failures.push(error.message));
    const linkText = async (url: string) => {
      await viewer.goto(`${sharedDatasetViewerOrigin}/s${new URL(url).hash}`);
      await viewer.getByRole("button", { name: "plan.md", exact: true }).click({ timeout: 15_000 });
      return await viewer.locator("main.content").innerText({ timeout: 15_000 });
    };
    const liveRefusals = () =>
      noticedRefusals(ownerTemp.rootPath, workspaceId).filter((row) =>
        /live document/i.test(row.reason),
      );

    const share = await call(page, "createRelayShare", {
      workspaceId,
      recipientEmail: recipientAccount.email,
      paths: [PATH],
      access: "edit",
    });
    const view = await call(page, "createRelayShareLink", {
      workspaceId,
      paths: [PATH],
      access: "view",
    });
    const edit = await call(page, "createRelayShareLink", {
      workspaceId,
      paths: [PATH],
      access: "edit",
    });
    await expect.poll(status, { timeout: 180_000, intervals: [1000] }).toBe("ready");

    const recipient = await launchDesktopApp({ workspace: recipientTemp, env: stack.trustEnv });
    desktops.push(recipient);
    const rpage = recipient.page;
    const propose = async (text: string, after: string) => {
      const recipientWorkspaceId = (await activeWorkspace(rpage, recipientTemp.rootPath))
        .workspaceId;
      await expect
        .poll(
          async () =>
            (
              await call(rpage, "readWorkspaceText", {
                workspaceId: recipientWorkspaceId,
                relativePath: PATH,
              })
            ).text.includes(after),
          { message: "the recipient's copy has the owner's latest text", timeout: 120_000 },
        )
        .toBe(true);
      const read = await call(rpage, "readWorkspaceText", {
        workspaceId: recipientWorkspaceId,
        relativePath: PATH,
      });
      await call(rpage, "writeWorkspaceText", {
        workspaceId: recipientWorkspaceId,
        relativePath: PATH,
        text: `${read.text.trimEnd()}\n\n${text}\n`,
        expectedContentHash: read.contentHash!,
      });
      await expect
        .poll(
          () =>
            call(rpage, "submitShareChanges", { workspaceId: recipientWorkspaceId }).then(
              (result) => (result.ok ? result.submitted : result.errorMessage),
              (error: unknown) => String(error),
            ),
          { message: "the recipient sends the change", timeout: 120_000, intervals: [2_000] },
        )
        .toBe(1);
      await expect.poll(async () => (await openProposals()).length, { timeout: 60_000 }).toBe(1);
      return (await openProposals())[0]!.proposalId;
    };

    await test.step("the recipient sends a change while the note is not live", async () => {
      await stopLive();
      await expect.poll(status, { timeout: 120_000, intervals: [1000] }).toBe("retired");
      await rpage.getByTestId("first-run-open-share").click();
      await rpage.getByTestId("open-share-code").fill(share.shareCode);
      await rpage.getByTestId("open-share-choose-folder").click();
      await rpage.getByTestId("open-share-start").click();
      await openDesktopApproval(recipient, recipientApproval, origin);
      await approveDesktop(recipientApproval, recipientAccount);
      await expect(rpage.locator("#open-share-sign-in-description")).toHaveCount(0, {
        timeout: 60_000,
      });
      const open = rpage.getByTestId("open-share-start");
      await expect(open).toHaveText("Open share");
      await open.click();
      await expect(rpage.getByTestId("shared-view-banner")).toBeVisible({ timeout: 60_000 });
    });
    const first = await propose(FIRST, "The first line.");

    await test.step("Accept on the live note says to stop live editing first, and the change stays open", async () => {
      await resumeLive();
      await page.getByTestId("notice-center-toggle").click();
      const notices = page.getByRole("dialog", { name: "Notices", exact: true });
      await notices.getByRole("button", { name: "Review", exact: true }).click();
      const dialog = page.getByTestId("proposal-review-dialog");
      await expect(dialog).toBeVisible();
      await dialog.getByTestId("proposal-review-accept").click();
      await expect(dialog.getByTestId("proposal-review-error")).toHaveText(LIVE_REFUSAL, {
        timeout: 30_000,
      });
      await dialog.screenshot({ path: testInfo.outputPath("accept-refused-light.png") });
      await testInfo.attach("accept refused", {
        path: testInfo.outputPath("accept-refused-light.png"),
      });
      expect((await openProposals()).map((row) => row.proposalId)).toEqual([first]);
      await dialog.getByTestId("proposal-review-later").click();
      await expect(dialog).toHaveCount(0);
      expect(await ownerFile()).not.toContain(FIRST);
      expect(await status()).toBe("ready");
    });

    await test.step("after Stop in Live documents, with the owner up to date, Accept reaches the note, the owner's file and the link", async () => {
      const liveDocuments = page.getByTestId("live-documents-dialog");
      await page.getByTestId(activityPin("settings")).click();
      await page.getByTestId(settingsNavPin("cloud")).click();
      await page.getByRole("button", { name: "Open live documents", exact: true }).click();
      await expect(liveDocuments).toBeVisible();
      const row = liveDocuments.getByTestId(`live-document-row-${PATH}`);
      await row.getByRole("button", { name: `Stop live editing for ${PATH}`, exact: true }).click();
      await expect(
        row.getByRole("button", { name: `Resume live editing for ${PATH}`, exact: true }),
      ).toBeEnabled({ timeout: 60_000 });
      await liveDocuments.getByRole("button", { name: "Close", exact: true }).click();
      await page.keyboard.press("Escape");
      await expect(page.getByTestId("settings-dialog")).toHaveCount(0);
      await page.getByTestId("notice-center-toggle").click();
      await page
        .getByRole("dialog", { name: "Notices", exact: true })
        .getByRole("button", { name: "Review", exact: true })
        .click();
      const dialog = page.getByTestId("proposal-review-dialog");
      await dialog.getByTestId("proposal-review-accept").click();
      await expect(dialog).toHaveCount(0, { timeout: 30_000 });
      expect(await openProposals()).toEqual([]);
      await expect
        .poll(ownerFile, { message: "the owner's file has the change", timeout: 60_000 })
        .toContain(FIRST);
      await expect
        .poll(() => linkText(view.url).catch(() => ""), {
          message: "the link shows the change",
          timeout: 60_000,
          intervals: [1000],
        })
        .toContain(FIRST);
      expect(liveRefusals()).toEqual([]);
    });

    const second = await propose(SECOND, FIRST);

    await test.step("with an Edit link typing live and the owner behind it at Stop, Accept waits for the Stop, then the change is not refused", async () => {
      await resumeLive();
      const linkEditor = await shared!.browser.newPage();
      linkEditor.on("pageerror", (error) => shared!.failures.push(error.message));
      await linkEditor.goto(`${sharedDatasetViewerOrigin}/s${new URL(edit.url).hash}`);
      await linkEditor.getByRole("button", { name: PATH, exact: true }).click({ timeout: 15_000 });
      await linkEditor
        .getByRole("button", { name: "Edit file", exact: true })
        .click({ timeout: 15_000 });
      const box = linkEditor.getByRole("textbox", { name: "Shared file editor", exact: true });
      await expect(box).toBeEditable({ timeout: 120_000 });
      await box.getByText(FIRST, { exact: false }).click({ timeout: 15_000 });
      await linkEditor.keyboard.press("End");
      const words: string[] = [];
      for (let index = 0; index < 20; index += 1) {
        words.push(`link${index}`);
        await linkEditor.keyboard.type(` link${index}`, { delay: 20 });
      }
      expect(await accept(second)).toContain(LIVE_REFUSAL);
      await stopLive();
      const answers: string[] = [];
      await expect
        .poll(
          async () => {
            const answer = await accept(second);
            answers.push(answer);
            return answer;
          },
          { message: "Accept is taken once the Stop finishes", timeout: 120_000, intervals: [250] },
        )
        .toBe("accepted");
      console.log(
        `[proposal-on-live-note] Accept answers through the Stop: ${JSON.stringify(answers)}`,
      );
      expect(answers.slice(0, -1).every((answer) => answer.includes(LIVE_REFUSAL))).toBe(true);
      expect(await status()).toBe("retired");
      await expect
        .poll(ownerFile, {
          message: "the link editor's words reach the owner's file",
          timeout: 60_000,
        })
        .toContain(words.at(-1)!);
      const conflicts = async () =>
        (await call(page, "listWorkspaceVersionConflicts", { workspaceId })).conflicts.length;
      await expect
        .poll(async () => (await ownerFile()).includes(SECOND) || (await conflicts()) > 0, {
          message:
            "the accepted change is in the owner's file, or a conflict asks the owner to choose",
          timeout: 60_000,
        })
        .toBe(true);
      console.log(
        `[proposal-on-live-note] after the Stop: owner's file has the change=${(await ownerFile()).includes(SECOND)}, conflicts=${await conflicts()}`,
      );
      expect(liveRefusals()).toEqual([]);
    });

    expect(shared.failures).toEqual([]);
    for (const desktop of desktops)
      expect(desktop.logs.filter((entry) => entry.level === "pageerror")).toEqual([]);
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
      ...desktops.map((desktop) => desktop.close()),
    ]);
    trust?.restore();
    cleanup.push(...(await Promise.allSettled([stack?.close()])));
    cleanup.push(...(await Promise.allSettled([ownerTemp.cleanup(), recipientTemp.cleanup()])));
    const failures = cleanup.filter(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    if (failures.length && !bodyFailure)
      throw new AggregateError(
        failures.map((result) => result.reason),
        "Proposal on a live note test cleanup failed.",
      );
  }
});
