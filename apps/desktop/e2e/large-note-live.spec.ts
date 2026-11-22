import { randomUUID } from "node:crypto";
import { expect, test, type BrowserContext } from "@playwright/test";
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
const BIG = "notes/big.md";
const MID = "notes/mid.md";
const SMALL = "notes/small.md";
const TOO_LARGE =
  "This note is larger than 256 KB, so it can't be edited live. Make it smaller or split it, then open it in dohc.";

const markdown = (bytes: number) => {
  const line = "A line of a long shared note that nobody created in dohc.\n";
  return `# Large note\n\n${line.repeat(Math.ceil(bytes / line.length))}`;
};

test("@large-note-live a shared note too large for live editing says so, and Resume does not start it", async ({
  browser,
}, testInfo) => {
  test.setTimeout(480_000);
  const signal = AbortSignal.timeout(testInfo.timeout - 10_000);
  const temp = await createTempWorkspace();
  let stack: Awaited<ReturnType<typeof startSelfHostOnboardingStack>> | undefined;
  let trust: ReturnType<typeof trustFixtureCa> | undefined;
  let owner: LaunchedDesktopApp | undefined;
  const contexts: BrowserContext[] = [];
  let bodyFailure: { error: unknown } | undefined;
  const account = (name: string) => ({
    email: `${name}-${randomUUID()}@example.test`,
    password: `${name}-${randomUUID()}`,
    name,
  });
  const ownerAccount = account("owner");
  const recipientAccount = account("recipient");
  try {
    stack = await startSelfHostOnboardingStack(temp.baseDir, { live: true, signal });
    trust = trustFixtureCa(stack.ca!.ca);
    const approvalPage = async () => {
      const context = await browser.newContext();
      contexts.push(context);
      await trust!.route(context, stack!.relayUrl);
      return context.newPage();
    };
    await createVerifiedAccount(await approvalPage(), stack.account, recipientAccount);
    await writeWorkspaceFiles(temp, [
      { path: BIG, contents: markdown(5 * 1024 * 1024) },
      { path: MID, contents: markdown(300 * 1024) },
      { path: SMALL, contents: "# Small note\n\nShort enough to edit live.\n" },
    ]);
    owner = await launchDesktopApp({ workspace: temp, env: stack.trustEnv });
    const page = owner.page;
    const { workspaceId } = await openWorkspaceFromFirstRun(page, temp);
    await page.getByTestId(activityPin("settings")).click();
    await page.getByTestId(settingsNavPin("cloud")).click();
    await page.getByTestId("settings-cloud-connect").click();
    await expect(page.getByTestId("cloud-sync-panel")).toBeVisible();
    const ownerApproval = await approvalPage();
    const approval = await openDesktopApproval(owner, ownerApproval, stack.relayUrl);
    await createVerifiedAccount(ownerApproval, stack.account, ownerAccount, approval);
    await approveDesktop(ownerApproval, ownerAccount);
    const syncSwitch = page.getByRole("switch", { name: "Sync this workspace" });
    await syncSwitch.click();
    await expect(page.getByTestId("cloud-sync-code")).toBeVisible();
    await page.keyboard.press("Escape");
    for (const path of [BIG, MID, SMALL]) await waitForWorkspaceFile(page, workspaceId, path);

    const documents = () =>
      page.evaluate(
        (workspaceId) =>
          (window as unknown as { dohcDesktop: Api }).dohcDesktop.listOwnerLiveDocuments({
            workspaceId,
          }),
        workspaceId,
      );
    const rowOf = async (path: string) =>
      (await documents()).documents.find((document) => document.path === path);
    await page.evaluate(
      (input) =>
        (window as unknown as { dohcDesktop: Api }).dohcDesktop.createRelayShare({
          ...input,
          access: "edit",
        }),
      { workspaceId, recipientEmail: recipientAccount.email, paths: [BIG, MID, SMALL] },
    );
    await expect
      .poll(async () => (await rowOf(SMALL))?.status, { timeout: 180_000, intervals: [1000] })
      .toBe("ready");
    await expect
      .poll(async () => [(await rowOf(BIG))?.reason, (await rowOf(MID))?.reason], {
        message: "the large notes have the server's reason",
        timeout: 120_000,
        intervals: [1000],
      })
      .not.toContain(undefined);

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
    const shot = async (name: string) => {
      const path = testInfo.outputPath(`${name}.png`);
      await liveDocuments.screenshot({ path });
      await testInfo.attach(name, { path });
    };

    await test.step("Live documents says each large note is too large, and offers no Resume", async () => {
      await openLiveDocuments();
      await expect(liveDocuments.getByTestId(`live-document-row-${SMALL}`)).toContainText("Live");
      await shot("live-documents-large-notes");
      console.log(
        `[large-note-live] rows: ${JSON.stringify((await documents()).documents.map(({ path, status, reason, canResume }) => ({ path, status, reason, canResume })))}`,
      );
      for (const path of [BIG, MID]) {
        const row = liveDocuments.getByTestId(`live-document-row-${path}`);
        await expect(row).toContainText("Too large");
        await expect(row).toContainText(TOO_LARGE);
        await expect(
          row.getByRole("button", { name: `Resume live editing for ${path}`, exact: true }),
        ).toHaveCount(0);
      }
      await closeLiveDocuments();
    });

    await test.step("opening the large note shows its start, and the row still says too large", async () => {
      await revealExplorerPath(page, BIG);
      await explorerRow(page, BIG).click();
      await expect(page.getByText("Showing the start of a large file.")).toBeVisible({
        timeout: 30_000,
      });
      await openLiveDocuments();
      await expect(liveDocuments.getByTestId(`live-document-row-${BIG}`)).toContainText(
        "Too large",
      );
      await closeLiveDocuments();
    });

    await test.step("Resume from an agent says why, and the row stays as it was", async () => {
      for (const path of [BIG, MID]) {
        const answer = await page
          .evaluate(
            (input) =>
              (window as unknown as { dohcDesktop: Api }).dohcDesktop.resumeOwnerLiveDocument(
                input,
              ),
            { workspaceId, path },
          )
          .then(
            () => "resumed",
            (error: unknown) => String(error),
          );
        expect(answer).toContain(
          `dohc could not resume live editing for ${path} because it is larger than 256 KB. Make it smaller or split it, then open it in dohc.`,
        );
        expect(await rowOf(path)).toMatchObject({
          reason: "live-document-too-large",
          canResume: false,
        });
      }
    });

    expect(owner.logs.filter((entry) => entry.level === "pageerror")).toEqual([]);
  } catch (error) {
    bodyFailure = { error };
    if (owner && stack)
      await owner.page
        .getByTestId("live-documents-dialog")
        .screenshot({ path: testInfo.outputPath("live-documents-at-failure.png") })
        .catch(() => undefined);
    throw error;
  } finally {
    const cleanup = await Promise.allSettled([
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
        "Large note test cleanup failed.",
      );
  }
});
