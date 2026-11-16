import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import type { DohcDesktopBridge } from "../src/ipc/bridgeContract";
import { activityPin, editorTabTestId, settingsNavPin } from "../src/testPins";
import {
  assertDesktopEngineHealthy,
  launchDesktopApp,
  type LaunchedDesktopApp,
} from "./helpers/desktopApp";
import { waitForCliEndpoint } from "./helpers/dohcCli";
import { ownerEnrollment } from "./helpers/engineDb";
import {
  approveDesktop,
  createVerifiedAccount,
  openDesktopApproval,
  startSelfHostOnboardingStack,
  trustFixtureCa,
} from "./helpers/selfHostOnboarding";
import {
  createTempWorkspace,
  openWorkspaceFromFirstRun,
  waitForWorkspaceFile,
  writeWorkspaceFiles,
} from "./helpers/workspace";

test.skip(
  !process.env.POSTGRES_URL && process.env.DOHC_REQUIRE_POSTGRES !== "1",
  "Run with disposable POSTGRES_URL and DOHC_REQUIRE_POSTGRES=1.",
);

const PATH = "notes/plan.md";
const ANCHOR = "The owner writes here.";
const TYPED = "Typed after the last link ended.";
const editor = (page: Page) => page.getByTestId("markdown-editor");

async function openNote(page: Page): Promise<void> {
  await page.getByTestId("titlebar-quick-open").click();
  const palette = page.getByTestId("quick-open");
  await palette.getByLabel("File").fill(PATH);
  await palette.getByRole("option", { name: PATH, exact: true }).click();
  await expect(editor(page)).toBeVisible();
}

async function closeNote(page: Page): Promise<void> {
  const tab = page.getByTestId(editorTabTestId(PATH));
  await tab.hover();
  await tab.getByRole("button", { name: /^Close / }).click();
  await expect(tab).toHaveCount(0);
}

test("@live-owner-open when a note's only share ends, the desktop lets it go, the owner's next edit saves to the file, and sharing it again hosts the note with that edit", async ({
  browser,
}, info) => {
  test.setTimeout(600_000);
  const signal = AbortSignal.timeout(info.timeout - 10_000);
  const ownerTemp = await createTempWorkspace();
  const apps: LaunchedDesktopApp[] = [];
  const contexts: BrowserContext[] = [];
  let stack: Awaited<ReturnType<typeof startSelfHostOnboardingStack>> | undefined;
  let trust: ReturnType<typeof trustFixtureCa> | undefined;
  let bodyFailure: { error: unknown } | undefined;
  const ownerAccount = {
    email: `owner-${randomUUID()}@example.test`,
    password: `Owner-${randomUUID()}`,
    name: "Owner",
  };
  const recipientAccount = {
    email: `recipient-${randomUUID()}@example.test`,
    password: `Recipient-${randomUUID()}`,
  };
  const accountPage = async () => {
    const context = await browser.newContext();
    contexts.push(context);
    await trust!.route(context, stack!.relayUrl);
    return context.newPage();
  };
  try {
    stack = await startSelfHostOnboardingStack(ownerTemp.baseDir, { live: true, signal });
    trust = trustFixtureCa(stack.ca!.ca);
    const ownerApproval = await accountPage();
    // Sharing needs a known address. This account never opens its share.
    await createVerifiedAccount(await accountPage(), stack.account, recipientAccount);
    await writeWorkspaceFiles(ownerTemp, [{ path: PATH, contents: `# Trip plan\n\n${ANCHOR}\n` }]);
    const owner = await launchDesktopApp({ workspace: ownerTemp, env: stack.trustEnv });
    apps.push(owner);
    const page = owner.page;
    const workspace =
      await test.step("the owner connects the workspace to the server", async () => {
        const opened = await openWorkspaceFromFirstRun(page, ownerTemp);
        await page.getByTestId(activityPin("settings")).click();
        await page.getByTestId(settingsNavPin("cloud")).click();
        await page.getByTestId("settings-cloud-connect").click();
        const approval = await openDesktopApproval(owner, ownerApproval, stack!.relayUrl);
        await createVerifiedAccount(ownerApproval, stack!.account, ownerAccount, approval);
        await approveDesktop(ownerApproval, ownerAccount);
        await expect(page.getByTestId("settings-row-account")).toContainText(ownerAccount.email);
        await page.getByRole("switch", { name: "Sync this workspace" }).click();
        await expect(page.getByTestId("cloud-sync-code")).toBeVisible();
        await page.keyboard.press("Escape");
        await waitForWorkspaceFile(page, opened.workspaceId, PATH);
        await waitForCliEndpoint(ownerTemp.homeDir);
        return opened;
      });
    const hosted = async () => {
      const listed = await page.evaluate(
        (workspaceId) =>
          (
            window as unknown as { dohcDesktop: DohcDesktopBridge }
          ).dohcDesktop.listOwnerLiveDocuments({ workspaceId }),
        workspace.workspaceId,
      );
      return listed.documents.some((row) => row.path === PATH && row.status === "ready");
    };
    const shareNote = () =>
      page.evaluate(
        ({ workspaceId, recipientEmail, path }) =>
          (window as unknown as { dohcDesktop: DohcDesktopBridge }).dohcDesktop.createRelayShare({
            workspaceId,
            recipientEmail,
            paths: [path],
            access: "edit",
          }),
        { workspaceId: workspace.workspaceId, recipientEmail: recipientAccount.email, path: PATH },
      );

    // The share comes first, so the owner's first open finds no owner binding
    // and asks for no hosting: only the share keeps the note hosted.
    const shared =
      await test.step("the owner shares the note for Edit, then opens it, so the server hosts it", async () => {
        const created = await shareNote();
        // The first open gives the enrolled note its owner lineage.
        await openNote(page);
        await expect(page.getByTestId("sync-status")).toHaveAttribute("data-state", "synced", {
          timeout: 60_000,
        });
        await expect
          .poll(
            async () => {
              const expected = stack!.ownerLiveBinding(workspace.workspaceId, PATH);
              const actual = expected && ownerEnrollment(ownerTemp.rootPath, expected.binding);
              return (
                (await hosted()) &&
                expected !== null &&
                actual !== null &&
                isDeepStrictEqual(actual.binding, expected.binding)
              );
            },
            { timeout: 120_000, intervals: [1_000] },
          )
          .toBe(true);
        return created;
      });
    const started =
      stack
        .liveHosting(workspace.workspaceId, PATH)
        ?.activations.filter((activation) => !activation.retired) ?? [];
    expect(started).toHaveLength(1);
    const original = started[0]!.activationId;
    const enrolled = stack.ownerLiveBinding(workspace.workspaceId, PATH)!;

    await test.step("stopping the note's only share retires its enrollment and activation without a Stop, the host lets the note go, and the list stops naming it live", async () => {
      await page.evaluate(
        (shareId) =>
          (window as unknown as { dohcDesktop: DohcDesktopBridge }).dohcDesktop.revokeRelayShare({
            shareId,
          }),
        shared.shareId,
      );
      await expect.poll(hosted, { timeout: 120_000, intervals: [1_000] }).toBe(false);
      // A retirement still running would keep the enrollment for an owner open that comes during it.
      await expect
        .poll(
          () => {
            const hosting = stack!.liveHosting(workspace.workspaceId, PATH);
            return (
              hosting && {
                retired: hosting.retired,
                drained: hosting.drained,
                ownerStop: hosting.ownerStop,
                originalRetired: hosting.activations.find(
                  (activation) => activation.activationId === original,
                )?.retired,
              }
            );
          },
          { timeout: 120_000, intervals: [1_000] },
        )
        .toEqual({ retired: true, drained: true, ownerStop: null, originalRetired: true });
    });

    await test.step("the desktop lets the note go, so the owner's next edit saves to the file", async () => {
      await expect
        .poll(() => ownerEnrollment(ownerTemp.rootPath, enrolled.binding), {
          timeout: 120_000,
          intervals: [1_000],
        })
        .toBeNull();
      await editor(page).getByText(ANCHOR).click();
      await page.keyboard.press(process.platform === "darwin" ? "Meta+ArrowRight" : "End");
      await page.keyboard.type(` ${TYPED}`);
      await expect
        .poll(() => readFile(join(ownerTemp.rootPath, PATH), "utf8"), {
          timeout: 60_000,
          intervals: [500],
        })
        .toContain(`${ANCHOR} ${TYPED}`);
      await expect(page.getByTestId("markdown-save-state")).toHaveAttribute("data-state", "saved");
      expect(stack!.liveHostTexts(PATH).some((text) => text.includes(TYPED))).toBe(false);
    });

    // A Stop left from the retirement would refuse this hosting.
    await test.step("sharing the note again hosts it in a new activation that holds the owner's edit", async () => {
      await shareNote();
      await closeNote(page);
      await openNote(page);
      await expect.poll(hosted, { timeout: 120_000, intervals: [1_000] }).toBe(true);
      await expect
        .poll(
          () =>
            stack!
              .liveHosting(workspace.workspaceId, PATH)
              ?.activations.filter((activation) => !activation.retired)
              .map((activation) => activation.activationId !== original),
          { timeout: 120_000, intervals: [1_000] },
        )
        .toEqual([true]);
      await expect
        .poll(
          () => stack!.liveHostTexts(PATH).some((text) => text.includes(`${ANCHOR} ${TYPED}`)),
          { timeout: 120_000, intervals: [1_000] },
        )
        .toBe(true);
    });
    expect(owner.logs.filter((entry) => entry.level === "pageerror")).toEqual([]);
    assertDesktopEngineHealthy(owner.logs);
  } catch (error) {
    bodyFailure = { error };
    if (stack)
      await info
        .attach("relay-output", { body: stack.relayOutput(), contentType: "text/plain" })
        .catch(() => undefined);
    throw error;
  } finally {
    const cleanup = await Promise.allSettled([
      ...apps.map((app) => app.close()),
      ...contexts.map((context) => context.close()),
    ]);
    trust?.restore();
    cleanup.push(...(await Promise.allSettled([stack?.close()])));
    cleanup.push(...(await Promise.allSettled([ownerTemp.cleanup()])));
    const failures = cleanup.filter(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    if (failures.length)
      throw new AggregateError(
        [...(bodyFailure ? [bodyFailure.error] : []), ...failures.map((result) => result.reason)],
        "Owner open cleanup failed.",
      );
  }
});
