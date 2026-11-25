import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
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
  waitForWorkspaceFile,
  writeWorkspaceFiles,
} from "./helpers/workspace";

test.skip(
  !process.env.POSTGRES_URL && process.env.DOHC_REQUIRE_POSTGRES !== "1",
  "Run with disposable POSTGRES_URL and DOHC_REQUIRE_POSTGRES=1.",
);

type Api = DohcDesktopBridge;
const PATH = "plain.md";
const NOTE = "# plain.md\n\nAn ordinary paragraph.\n";

test("@file-name-heading-live a note headed by its own file name goes live through an Edit link and keeps its text", async ({
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
    await writeWorkspaceFiles(temp, [{ path: PATH, contents: NOTE }]);
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
    await page.getByRole("switch", { name: "Sync this workspace" }).click();
    await expect(page.getByTestId("cloud-sync-code")).toBeVisible();
    await page.keyboard.press("Escape");
    await waitForWorkspaceFile(page, workspaceId, PATH);

    await explorerRow(page, PATH).click();
    await expect(page.getByTestId("markdown-editor")).toContainText("An ordinary paragraph.");
    await page.evaluate(
      (input) =>
        (window as unknown as { dohcDesktop: Api }).dohcDesktop.createRelayShare({
          ...input,
          access: "edit",
        }),
      { workspaceId, recipientEmail: recipientAccount.email, paths: [PATH] },
    );
    await expect
      .poll(
        async () =>
          (
            await page.evaluate(
              (workspaceId) =>
                (window as unknown as { dohcDesktop: Api }).dohcDesktop.listOwnerLiveDocuments({
                  workspaceId,
                }),
              workspaceId,
            )
          ).documents.find((document) => document.path === PATH)?.status,
        { message: "the note goes live", timeout: 180_000, intervals: [1000] },
      )
      .toBe("ready");
    expect(await readFile(join(temp.rootPath, PATH), "utf8")).toBe(NOTE);
    expect(stack.liveHostTexts(PATH).every((text) => !text.includes("http://"))).toBe(true);
    expect(owner.logs.filter((entry) => entry.level === "pageerror")).toEqual([]);
  } catch (error) {
    bodyFailure = { error };
    if (stack)
      await testInfo
        .attach("relay-output", { body: stack.relayOutput(), contentType: "text/plain" })
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
        "File name heading test cleanup failed.",
      );
  }
});
