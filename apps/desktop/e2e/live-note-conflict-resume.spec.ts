import { randomBytes, randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import type { DohcDesktopBridge } from "../src/ipc/bridgeContract";
import { activityPin, settingsNavPin } from "../src/testPins";
import { launchDesktopApp, type LaunchedDesktopApp } from "./helpers/desktopApp";
import { ownerEnrollment } from "./helpers/engineDb";
import { readHistoryMoments } from "./helpers/history";
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
  waitForWorkspaceReady,
  writeWorkspaceFiles,
} from "./helpers/workspace";

test.skip(
  !process.env.POSTGRES_URL && process.env.DOHC_REQUIRE_POSTGRES !== "1",
  "Run with disposable POSTGRES_URL and DOHC_REQUIRE_POSTGRES=1.",
);

type Api = DohcDesktopBridge;
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

const PATH = "notes/plan.md";
const SEED = "# Trip plan\n\nThe first line.\n";
const FIRST_TEXT = "# Trip plan\n\nChosen text from the first computer.\n";
const SECOND_TEXT = "# Trip plan\n\nOffline edit from the second computer.\n";

test("@live-note-conflict-resume a live-shared note whose version conflict is resolved resumes live editing, and an Edit link's typing reaches the owner's file", async ({
  browser,
}, testInfo) => {
  test.setTimeout(1_200_000);
  const startedAt = Date.now();
  const signal = AbortSignal.timeout(testInfo.timeout - 10_000);
  const firstTemp = await createTempWorkspace();
  const secondTemp = await createTempWorkspace();
  const exchangeKey = randomBytes(32).toString("hex");
  let stack: Awaited<ReturnType<typeof startSelfHostOnboardingStack>> | undefined;
  let trust: ReturnType<typeof trustFixtureCa> | undefined;
  let shared: Awaited<ReturnType<typeof startSharedDatasetBrowser>> | undefined;
  const contexts: BrowserContext[] = [];
  const desktops: LaunchedDesktopApp[] = [];
  let bodyFailure: { error: unknown } | undefined;
  const observed: Array<{ step: string; at: string; sinceStartMs: number; value: unknown }> = [];
  const note = async (step: string, value: unknown) => {
    observed.push({
      step,
      at: new Date().toISOString(),
      sinceStartMs: Date.now() - startedAt,
      value,
    });
    console.log(`[c-proof-2701] ${step}: ${JSON.stringify(value)}`);
    await writeFile(testInfo.outputPath("observations.json"), JSON.stringify(observed, null, 2));
  };
  const shot = async (target: Page | ReturnType<Page["getByTestId"]>, name: string) => {
    const path = testInfo.outputPath(`${name}.png`);
    await target.screenshot({ path });
    await testInfo.attach(name, { path });
  };
  const account = {
    email: `owner-${randomUUID()}@example.test`,
    password: `Owner-${randomUUID()}`,
    name: "Owner",
  };
  const env = (trustEnv: Record<string, string>) => ({
    ...trustEnv,
    DOHC_TEST_SYNC_DEBOUNCE_MS: "150",
    DOHC_TEST_SYNC_BACKOFF_MS: "250",
  });
  try {
    stack = await startSelfHostOnboardingStack(firstTemp.baseDir, {
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

    await writeWorkspaceFiles(firstTemp, [{ path: PATH, contents: SEED }]);
    const first = await launchDesktopApp({ workspace: firstTemp, env: env(stack.trustEnv) });
    desktops.push(first);
    const page = first.page;
    const { workspaceId } = await openWorkspaceFromFirstRun(page, firstTemp);
    await page.getByTestId(activityPin("settings")).click();
    await page.getByTestId(settingsNavPin("cloud")).click();
    await page.getByTestId("settings-cloud-connect").click();
    await expect(page.getByTestId("cloud-sync-panel")).toBeVisible();
    const firstApproval = await approvalPage();
    const approval = await openDesktopApproval(first, firstApproval, origin);
    await createVerifiedAccount(firstApproval, stack.account, account, approval);
    await approveDesktop(firstApproval, account);
    await expect(page.getByTestId("settings-row-account")).toContainText(account.email);
    const syncSwitch = page.getByRole("switch", { name: "Sync this workspace" });
    await syncSwitch.click();
    await expect(syncSwitch).toHaveAttribute("aria-checked", "true");
    await expect(page.getByTestId("cloud-sync-code")).toBeVisible();
    const syncCode = (await page.getByTestId("cloud-sync-code").textContent())!.trim();
    await page.keyboard.press("Escape");
    await waitForWorkspaceFile(page, workspaceId, PATH);
    await revealExplorerPath(page, PATH);
    await explorerRow(page, PATH).click();
    await expect(page.getByTestId("markdown-editor")).toBeVisible({ timeout: 30_000 });
    await page.keyboard.press("ControlOrMeta+w");
    await expect(page.getByTestId("markdown-editor")).toHaveCount(0);

    const second = await launchDesktopApp({ workspace: secondTemp, env: env(stack.trustEnv) });
    desktops.push(second);
    const secondPage = second.page;
    await secondPage.getByTestId("first-run-join-synced").click();
    const secondApproval = await approvalPage();
    await openDesktopApproval(second, secondApproval, origin);
    await approveDesktop(secondApproval, account);
    await expect(secondPage.getByTestId("join-sync-code")).toBeEnabled({ timeout: 60_000 });
    await secondPage.getByTestId("join-sync-code").fill(syncCode);
    await secondPage.getByTestId("join-choose-folder").click();
    await secondPage.getByTestId("join-workspace-start").click();
    await waitForWorkspaceReady(secondPage);
    await waitForWorkspaceFile(secondPage, workspaceId, PATH);
    await note("setup", { workspaceId, secondJoined: true });

    const fileOf = (root: string) =>
      readFile(join(root, PATH), "utf8").catch((error) => {
        if (error?.code === "ENOENT") return "";
        throw error;
      });
    const firstFile = () => fileOf(firstTemp.rootPath);
    const secondFile = () => fileOf(secondTemp.rootPath);
    const rowOn = async (on: Page) =>
      (await call(on, "listOwnerLiveDocuments", { workspaceId })).documents.find(
        (document) => document.path === PATH,
      ) ?? null;
    const status = async () => (await rowOn(page))?.status ?? "missing";
    const conflictsOn = async (on: Page) =>
      (await call(on, "listWorkspaceVersionConflicts", { workspaceId })).conflicts;
    const momentCount = async (on: Page) => {
      const moments = await readHistoryMoments(on, workspaceId, PATH);
      if (moments === null) throw new Error("History is unavailable.");
      return moments.length;
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
    const reload = () => liveDocuments.getByTestId("live-documents-reload").click();
    const documentRow = liveDocuments.getByTestId(`live-document-row-${PATH}`);
    const labelOf = documentRow.locator(":scope > span").nth(1);
    const rowSays = async (text: string, timeout = 120_000) =>
      expect(async () => {
        await reload();
        await expect(labelOf).toHaveText(text, { timeout: 3_000 });
      }).toPass({ timeout, intervals: [1000] });
    const resumeButton = documentRow.getByRole("button", {
      name: `Resume live editing for ${PATH}`,
      exact: true,
    });
    const shownRow = async () => {
      await reload();
      await expect(documentRow).toBeVisible({ timeout: 15_000 });
      return {
        label: await labelOf.textContent(),
        text: await documentRow.innerText(),
        buttons: await documentRow
          .getByRole("button")
          .evaluateAll((buttons) =>
            buttons.map((button) => button.getAttribute("aria-label") ?? button.textContent),
          ),
      };
    };
    const recordRows = async (step: string, shotName?: string) => {
      const row = await rowOn(page);
      const secondRow = await rowOn(secondPage).catch((error: unknown) => String(error));
      await openLiveDocuments();
      const ui = await shownRow();
      if (shotName) await shot(liveDocuments, shotName);
      await closeLiveDocuments();
      await note(step, { firstRow: row, secondRow, ui });
      return { row, ui };
    };

    const linkPage = async () => {
      const opened = await shared!.browser.newPage();
      opened.on("pageerror", (error) => shared!.failures.push(error.message));
      return opened;
    };
    const typeThroughLink = async (url: string, marker: string) => {
      const opened = await linkPage();
      await opened.goto(`${sharedDatasetViewerOrigin}/s${new URL(url).hash}`);
      await opened.getByRole("button", { name: "plan.md", exact: true }).click({ timeout: 15_000 });
      await opened
        .getByRole("button", { name: "Edit file", exact: true })
        .click({ timeout: 15_000 });
      const box = opened.getByRole("textbox", { name: "Shared file editor", exact: true });
      await expect(box).toHaveAttribute("contenteditable", "true", { timeout: 120_000 });
      await box.getByText("Trip plan", { exact: false }).click({ timeout: 15_000 });
      await opened.keyboard.press("End");
      await opened.keyboard.type(` ${marker}`, { delay: 20 });
      return opened;
    };

    let link: Awaited<ReturnType<Api["createRelayShareLink"]>> | undefined;
    let enrolled:
      | NonNullable<
          ReturnType<Awaited<ReturnType<typeof startSelfHostOnboardingStack>>["ownerLiveBinding"]>
        >
      | undefined;
    const outside = async (on: Page) =>
      (await call(on, "getSyncStatus", { workspaceId })).outsideChanges ?? [];
    await test.step("1. the note shared with an Edit link is live", async () => {
      await expect(async () => {
        link = await call(page, "createRelayShareLink", {
          workspaceId,
          paths: [PATH],
          access: "edit",
        });
      }).toPass({ timeout: 120_000, intervals: [1000] });
      const sharedAt = Date.now();
      await expect.poll(status, { timeout: 180_000, intervals: [1000] }).toBe("ready");
      await note("1-live-after-share", { ms: Date.now() - sharedAt });
      await expect
        .poll(() => (enrolled = stack!.ownerLiveBinding(workspaceId, PATH) ?? undefined), {
          timeout: 60_000,
        })
        .toBeTruthy();
      await recordRows("1-row-live", "step1-owner-row-live");
      const marker = `before${randomBytes(4).toString("hex")}`;
      const typedAt = Date.now();
      const opened = await typeThroughLink(link!.url, marker);
      await expect
        .poll(async () => (await firstFile()).includes(marker), {
          message: "the link editor's word reaches the owner's file while live",
          timeout: 120_000,
          intervals: [1000],
        })
        .toBe(true);
      await note("1-link-word-in-owner-file", { marker, ms: Date.now() - typedAt });
      await opened.close();
    });

    await test.step("2. a real version conflict: Stop, then both of the owner's computers edit the note offline", async () => {
      await openLiveDocuments();
      await documentRow
        .getByRole("button", { name: `Stop live editing for ${PATH}`, exact: true })
        .click();
      await rowSays("Stopped");
      await closeLiveDocuments();
      await recordRows("2-row-stopped");
      let previous: string | undefined;
      await expect
        .poll(
          async () => {
            const [one, two] = [await firstFile(), await secondFile()];
            const steady = one === previous && one === two;
            previous = one;
            return steady;
          },
          {
            message: "both computers' files settle to the same text after Stop",
            timeout: 180_000,
            intervals: [2000],
          },
        )
        .toBe(true);
      const bindings = () => ({
        first: ownerEnrollment(firstTemp.rootPath, enrolled!.binding) !== null,
        second: ownerEnrollment(secondTemp.rootPath, enrolled!.binding) !== null,
      });
      const boundAtSettle = bindings();
      await expect
        .poll(bindings, {
          message: "neither computer still binds the stopped note live",
          timeout: 120_000,
          intervals: [1000],
        })
        .toEqual({ first: false, second: false });
      await note("2-settled-before-outage", { text: await firstFile(), boundAtSettle });
      let beforeFirst = 0;
      let beforeSecond = 0;
      await expect(async () => {
        beforeFirst = await momentCount(page);
        beforeSecond = await momentCount(secondPage);
      }).toPass({ timeout: 30_000 });
      stack!.pause();
      await writeWorkspaceFiles(firstTemp, [{ path: PATH, contents: FIRST_TEXT }]);
      await writeWorkspaceFiles(secondTemp, [{ path: PATH, contents: SECOND_TEXT }]);
      await expect
        .poll(
          async () =>
            (await momentCount(page)) > beforeFirst &&
            (await momentCount(secondPage)) > beforeSecond,
          { message: "each computer records its offline edit", timeout: 60_000 },
        )
        .toBe(true)
        .catch(async (error: unknown) => {
          await note("2-offline-edit-not-recorded", {
            firstMoments: [beforeFirst, await momentCount(page)],
            secondMoments: [beforeSecond, await momentCount(secondPage)],
            firstOutside: await outside(page),
            secondOutside: await outside(secondPage),
            bindings: bindings(),
          });
          throw error;
        });
      const backAt = Date.now();
      stack!.resume();
      await expect
        .poll(
          async () => (await conflictsOn(page)).length + (await conflictsOn(secondPage)).length,
          {
            message: "a version conflict opens on one of the owner's computers",
            timeout: 180_000,
            intervals: [1000],
          },
        )
        .toBeGreaterThan(0);
      await note("2-conflict-open", {
        ms: Date.now() - backAt,
        firstConflicts: await conflictsOn(page),
        secondConflicts: await conflictsOn(secondPage),
      });
      await recordRows("2-row-while-conflict-open", "step2-owner-row-conflict-open");
    });

    await test.step("3. the owner keeps one side in the conflict review", async () => {
      const receiver = (await conflictsOn(page)).length > 0 ? page : secondPage;
      const receiverName = receiver === page ? "first" : "second";
      await receiver.getByTestId("notice-center-toggle").click();
      await receiver
        .getByTestId("notice-sync-conflict")
        .getByRole("button", { name: "Review", exact: true })
        .click({ timeout: 60_000 });
      const card = receiver.locator(
        `[data-testid="version-conflict"][data-conflict-path="${PATH}"]`,
      );
      await expect(card).toContainText("Chosen text from the first computer.");
      await expect(card).toContainText("Offline edit from the second computer.");
      await shot(receiver, "step3-conflict-review");
      const resolvedAt = Date.now();
      await card.getByTestId("version-conflict-keep-incoming").click();
      await expect(receiver.getByTestId("conflict-review-empty")).toBeVisible();
      await receiver.getByTestId("conflict-review-done").click();
      await expect
        .poll(
          async () => {
            const [one, two] = [await firstFile(), await secondFile()];
            return (
              (await conflictsOn(page)).length === 0 &&
              (await conflictsOn(secondPage)).length === 0 &&
              one === two
            );
          },
          {
            message: "no conflict is open on either computer and both files agree",
            timeout: 180_000,
            intervals: [1000],
          },
        )
        .toBe(true)
        .catch(async (error: unknown) => {
          await note("3-not-settled", {
            firstConflicts: await conflictsOn(page),
            secondConflicts: await conflictsOn(secondPage),
            firstFile: await firstFile(),
            secondFile: await secondFile(),
          });
          throw error;
        });
      await note("3-resolved", {
        receiver: receiverName,
        kept: "incoming",
        ms: Date.now() - resolvedAt,
        text: await firstFile(),
      });
      await recordRows("3-row-after-resolve", "step3-owner-row-after-resolve");
    });

    await test.step("4. Live documents offers Resume, and Resume is pressed", async () => {
      await openLiveDocuments();
      const offered = await expect(async () => {
        await reload();
        await expect(resumeButton).toBeVisible({ timeout: 3_000 });
      })
        .toPass({ timeout: 120_000, intervals: [1000] })
        .then(
          () => true,
          () => false,
        );
      const ui = await shownRow();
      await shot(liveDocuments, "step4-owner-row-before-resume");
      await note("4-row-before-resume", { resumeOffered: offered, row: await rowOn(page), ui });
      expect(offered, "Live documents offers Resume after the conflict is resolved").toBe(true);
      const resumeAt = Date.now();
      await resumeButton.click();
      await expect
        .poll(status, { timeout: 180_000, intervals: [1000] })
        .toBe("ready")
        .catch(async (error: unknown) => {
          await note("4-not-live", { row: await rowOn(page), ui: await shownRow() });
          await shot(liveDocuments, "step4-owner-row-not-live");
          throw error;
        });
      await note("4-live-after-resume", { ms: Date.now() - resumeAt });
      await rowSays("Live", 60_000);
      await shot(liveDocuments, "step4-owner-row-live-again");
      await closeLiveDocuments();
      await recordRows("4-row-live-again");
    });

    await test.step("5. an Edit link page types a marker that reaches the owner's file", async () => {
      const marker = `after${randomBytes(4).toString("hex")}`;
      const typedAt = Date.now();
      const opened = await typeThroughLink(link!.url, marker);
      await expect
        .poll(async () => (await firstFile()).includes(marker), {
          message: "after Resume, the link editor's word reaches the owner's file",
          timeout: 120_000,
          intervals: [1000],
        })
        .toBe(true)
        .catch(async (error: unknown) => {
          await note("5-not-in-file", { row: await rowOn(page), file: await firstFile() });
          await shot(opened, "step5-link-page-at-failure");
          throw error;
        });
      await shot(opened, "step5-link-page");
      const reachedFirstMs = Date.now() - typedAt;
      const reachedSecond = await expect
        .poll(async () => (await secondFile()).includes(marker), { timeout: 120_000 })
        .toBe(true)
        .then(
          () => true,
          () => false,
        );
      await note("5-link-word-in-owner-file", {
        marker,
        reachedFirstMs,
        reachedSecondComputer: reachedSecond,
        firstFile: await firstFile(),
      });
      await opened.close();
    });

    expect(shared.failures).toEqual([]);
    for (const desktop of desktops)
      expect(desktop.logs.filter((entry) => entry.level === "pageerror")).toEqual([]);
  } catch (error) {
    bodyFailure = { error };
    for (const [index, desktop] of desktops.entries())
      await desktop.page
        .screenshot({ path: testInfo.outputPath(`desktop-${index + 1}-at-failure.png`) })
        .catch(() => undefined);
    throw error;
  } finally {
    await testInfo
      .attach("observations", {
        contentType: "application/json",
        body: JSON.stringify(observed, null, 2),
      })
      .catch(() => undefined);
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
    cleanup.push(...(await Promise.allSettled([firstTemp.cleanup(), secondTemp.cleanup()])));
    const failures = cleanup.filter(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    if (failures.length && !bodyFailure)
      throw new AggregateError(
        failures.map((result) => result.reason),
        "Live note conflict resume test cleanup failed.",
      );
  }
});
