import { holdSystemClipboard } from "./helpers/systemClipboard";
import { desktopPins, activityPin, settingsNavPin } from "../src/testPins";
import { test, expect, type Locator, type Page } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { DEFAULT_USER_SETTINGS, type DesktopUserSettings } from "../src/settings/userSettings";
import { USER_SETTINGS_FILE } from "../src/settings/userSettingsStore";
import { desktopRoot, launchDesktopApp } from "./helpers/desktopApp";
import { installFakeAgentTools } from "./helpers/agentTools";
import {
  cleanupDesktopWorkspace,
  createTempWorkspace,
  openWorkspaceFromFirstRun,
  trustOpenWorkspace,
  seedWorkspaceManifest,
  type TempWorkspace,
} from "./helpers/workspace";

const REPORT = "done: checked the exports";
const fakeRunner = resolve(desktopRoot, "e2e/fixtures/fakeChatRunner.mjs");

test("installed tool cards save profiles, Check replies through PATH, and a group mention dispatches", async () => {
  const temp = await createTempWorkspace();
  let desktop: Awaited<ReturnType<typeof launchDesktopApp>> | null = null;
  try {
    await seedWorkspaceManifest(temp, "agent-profile-e2e");
    const env = await installFakeAgentTools(temp);
    desktop = await launchDesktopApp({ workspace: temp, env });
    await openWorkspaceFromFirstRun(desktop.page, temp);
    await trustOpenWorkspace(desktop);
    const page = desktop.page;
    // No runner is set up yet, so there is no agent channel: adding the
    // agent is the opt-in that creates it.
    await page.getByTestId(activityPin("chats")).click();
    await expect(page.getByTestId("chats-view")).toBeVisible();
    await page.getByTestId(desktopPins.sidePanel).getByTestId("chats-add-agent-open").click();
    await page.getByTestId("chats-add-agent-agent-name").fill("Nova");
    for (const name of ["Claude Code", "Codex"]) {
      await page.getByRole("button", { name, exact: true }).click();
      await page.getByTestId("chats-add-agent-check").click();
      await expect(page.getByTestId("chats-add-agent-check-result")).toHaveAttribute("data-state", "ok");
    }
    await page.getByTestId("chats-add-agent-submit").click();
    await expect(page.getByTestId("chats-add-agent")).toHaveCount(0);
    await page.getByTestId(desktopPins.sidePanel).getByTestId("chats-channel").filter({ hasText: "general" }).click();
    await page.getByTestId("chats-new-thread-composer").fill("@Nova check the exports");
    await page.getByTestId("chats-new-thread-composer").press("Enter");
    await expect(page.getByTestId("chats-message").filter({ hasText: REPORT })).toHaveCount(1);
  } finally {
    await cleanupDesktopWorkspace(desktop, temp);
  }
});

function runnerCommand(mode: "report" | "silent-fail" | "ask"): string {
  return `node "${fakeRunner.replaceAll('"', '\\"')}" ${mode}`;
}

async function seedRunnerSettings(
  temp: Pick<TempWorkspace, "homeDir">,
  mode: "report" | "silent-fail" | "ask",
): Promise<string> {
  const command = runnerCommand(mode);
  const settings: DesktopUserSettings = {
    ...DEFAULT_USER_SETTINGS,
    profile: { preferredName: "Sam" },
    agents: {
      default: { name: "Nova", hue: "olive", launch: { command }, changesFiles: true, enabled: true, timeoutMinutes: 1 },
    },
  };
  await writeFile(
    join(temp.homeDir, USER_SETTINGS_FILE),
    `${JSON.stringify(settings, null, 2)}\n`,
  );
  return command;
}

async function openMyAgent(page: Page): Promise<void> {
  // Workspace open starts the UI-independent dispatch scan, which provisions
  // the owner-only agent channel. Wait on that real main-process result before
  // mounting Chats so its one-shot overview load cannot race provisioning.
  await expect
    .poll(() =>
      page.evaluate(async () => {
        const api = (window as unknown as {
          dohcDesktop: {
            getWorkspaceRegistry(): Promise<{
              workspaces: Array<{ workspaceId: string }>;
            }>;
            listChatChannels(payload: { workspaceId: string }): Promise<{
              channels: Array<{ kind: string }>;
            }>;
          };
        }).dohcDesktop;
        const registry = await api.getWorkspaceRegistry();
        const workspace = registry.workspaces[0];
        if (!workspace) return false;
        const result = await api.listChatChannels({ workspaceId: workspace.workspaceId });
        return result.channels.some((channel) => channel.kind === "agent");
      }),
    )
    .toBe(true);

  await page.getByTestId(activityPin("chats")).click();
  await expect(page.getByTestId("chats-view")).toBeVisible();
  await page.getByTestId("chats-my-agent").click();
  await expect(page.getByTestId("chats-channel-title")).toHaveText("My agent");
}

test("picking the agent in a group's post says it runs when you send, and the offer leaves after the send", async () => {
  const temp = await createTempWorkspace();
  let desktop: Awaited<ReturnType<typeof launchDesktopApp>> | null = null;
  try {
    await seedWorkspaceManifest(temp, "agent-dispatch-offer-e2e");
    await seedRunnerSettings(temp, "report");
    desktop = await launchDesktopApp({ workspace: temp });
    await openWorkspaceFromFirstRun(desktop.page, temp);
    await trustOpenWorkspace(desktop);
    const page = desktop.page;
    await openMyAgent(page);
    await page.getByTestId(desktopPins.sidePanel).getByTestId("chats-channel").filter({ hasText: "general" }).click();

    const composer = page.getByTestId("chats-new-thread-composer");
    await composer.pressSequentially("@ag");
    await page.locator('[data-testid="chats-new-thread-mention-option"][data-candidate-id="agent:default"]').click();
    const offer = page.getByTestId("composer-agent-offer");
    await expect(offer).toHaveAttribute("data-state", "runs");
    await expect(offer.getByTestId("composer-agent-offer-words")).toHaveText("Runs when you send");

    await composer.pressSequentially("check the exports");
    await composer.press("Enter");
    await expect(page.getByTestId("chats-message").filter({ hasText: REPORT })).toHaveCount(1);
    await expect(page.getByTestId("composer-agent-offer")).toHaveCount(0);
  } finally {
    await cleanupDesktopWorkspace(desktop, temp);
  }
});

test("My agent dispatches a fresh successful run for each human message", async () => {
  const temp = await createTempWorkspace();
  let desktop: Awaited<ReturnType<typeof launchDesktopApp>> | null = null;
  const workspaceId = "agent-dispatch-report-e2e";

  try {
    await seedWorkspaceManifest(temp, workspaceId);
    const command = await seedRunnerSettings(temp, "report");
    desktop = await launchDesktopApp({ workspace: temp });
    await openWorkspaceFromFirstRun(desktop.page, temp);
    await trustOpenWorkspace(desktop);
    const page = desktop.page;
    await openMyAgent(page);

    await page.getByTestId("chats-new-thread-composer").fill("audit the projections");
    await page.getByTestId("chats-new-thread-composer").press("Enter");
    await expect(page.getByTestId("chats-thread-view")).toBeVisible();

    const agentReplies = page
      .getByTestId("chats-message")
      .filter({ hasText: REPORT });
    await expect(agentReplies).toHaveCount(1);
    await expect(
      agentReplies.first().getByTestId("chats-comment-agent-badge"),
    ).toHaveText("agent");

    const firstRunChip = agentReplies.first().getByTestId("chats-run-chip");
    await expect(firstRunChip).toBeVisible();
    await firstRunChip.click();
    await expect(page.getByTestId("chats-run-popover")).toBeVisible();
    await expect(page.getByTestId("chats-run-command")).toHaveText(command);
    await expect(page.getByTestId("chats-run-exit-code")).toHaveText("0");
    // The command and log path wrap inside the popover, Copy included.
    expect(await page.getByTestId("chats-run-popover").evaluate((popover) => popover.scrollWidth <= popover.clientWidth)).toBe(true);

    // A second committed human message is a second ledger trigger. The same
    // report text arriving again, attached to a distinct run chip, proves the
    // first trigger was durably acked rather than accidentally replayed.
    await page.getByTestId("chats-composer").fill("also audit the export totals");
    await page.getByTestId("chats-composer").press("Enter");
    await expect(agentReplies).toHaveCount(2);
    const runChips = page.getByTestId("chats-run-chip");
    await expect(runChips).toHaveCount(2);
    const runLabels = await runChips.allTextContents();
    expect(new Set(runLabels).size).toBe(2);
    await expect(
      agentReplies.nth(1).getByTestId("chats-comment-agent-badge"),
    ).toHaveText("agent");
  } finally {
    await cleanupDesktopWorkspace(desktop, temp);
  }
});

test("an agent's question with choices is a poll; picking one answers it and the answer reaches the next run", async () => {
  const temp = await createTempWorkspace();
  let desktop: Awaited<ReturnType<typeof launchDesktopApp>> | null = null;
  const workspaceId = "agent-dispatch-ask-e2e";

  try {
    await seedWorkspaceManifest(temp, workspaceId);
    await seedRunnerSettings(temp, "ask");
    desktop = await launchDesktopApp({ workspace: temp });
    await openWorkspaceFromFirstRun(desktop.page, temp);
    await trustOpenWorkspace(desktop);
    const page = desktop.page;
    await openMyAgent(page);

    await page.getByTestId("chats-new-thread-composer").fill("plan the release");
    await page.getByTestId("chats-new-thread-composer").press("Enter");
    await expect(page.getByTestId("chats-thread-view")).toBeVisible();

    // The agent asks with choices. The question is a poll: its choices are
    // on screen and there is no bare Answer button.
    const question = page.getByTestId("chats-message").filter({ hasText: "Which day do we ship?" });
    await expect(question).toHaveCount(1);
    await expect(question.getByTestId("chats-comment-agent-badge")).toHaveText("agent");
    await expect(question.getByTestId("chats-comment-decision-open")).toHaveText("Poll open");
    const options = question.getByTestId("chats-comment-poll-option");
    await expect(options).toHaveText(["Friday", "Monday"]);
    await expect(question.getByTestId("chats-comment-decision-resolve")).toHaveCount(0);

    // Picking a choice answers the poll with that choice.
    await options.nth(1).click();
    await expect(page.getByTestId("chats-resolving-mode")).toContainText("Monday");
    await page.getByTestId("chats-composer").press("Enter");
    await expect(question.getByTestId("chats-comment-decision-resolved")).toHaveText("Answered");
    await expect(options.nth(1)).toHaveAttribute("data-chosen", "true");
    await expect(page.getByTestId("chats-message").filter({ hasText: "Monday" }).first()).toBeVisible();

    // The answer is a human message, so it triggers a run. That run reads
    // the taken choice out of the thread and reports it back.
    await expect(
      page.getByTestId("chats-message").filter({ hasText: "going with Monday" }),
    ).toHaveCount(1);
  } finally {
    await cleanupDesktopWorkspace(desktop, temp);
  }
});

test("a runner that exits silently leaves the thread alone and posts a failed-run notice", async () => {
  const temp = await createTempWorkspace();
  let desktop: Awaited<ReturnType<typeof launchDesktopApp>> | null = null;
  const workspaceId = "agent-dispatch-failure-e2e";

  try {
    await seedWorkspaceManifest(temp, workspaceId);
    await seedRunnerSettings(temp, "silent-fail");
    desktop = await launchDesktopApp({ workspace: temp });
    await openWorkspaceFromFirstRun(desktop.page, temp);
    await trustOpenWorkspace(desktop);
    const page = desktop.page;
    await openMyAgent(page);

    await page.getByTestId("chats-new-thread-composer").fill("audit the projections");
    await page.getByTestId("chats-new-thread-composer").press("Enter");
    await expect(page.getByTestId("chats-thread-view")).toBeVisible();

    // The failure is a row in Notices. The thread keeps only what people and
    // the agent wrote, so once the notice is there it still holds one post.
    await page.getByTestId("notice-center-toggle").click();
    // "failed", not "failed to start": the runner started, then exited silently.
    await expect(page.getByTestId("notice-center").getByText(
      'Nova\'s run failed in "audit the projections"',
      { exact: true },
    )).toBeVisible();
    const messages = page.getByTestId("chats-message");
    await expect(messages).toHaveCount(1);
    await expect(messages).toHaveAttribute("data-author-kind", "human");
    await expect(messages).toContainText("audit the projections");
  } finally {
    await cleanupDesktopWorkspace(desktop, temp);
  }
});

// What the pointer reaches at a toast's center: the toast, a workbench
// modal (`data-dohc-modal` on its backdrop), something else, or nothing.
function hitAtCenter(toast: Locator): Promise<string> {
  return toast.evaluate((element) => {
    const bounds = element.getBoundingClientRect();
    const hit = document.elementFromPoint(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
    if (hit === null) return "none";
    if (element.contains(hit)) return "toast";
    if (hit.closest("[data-dohc-modal]")) return "modal";
    return `other:${hit.tagName.toLowerCase()}`;
  });
}

// Toasts sit above every dialog and its scrim (NoticeCenter), so a failed
// check says so inside Settings and its reason is reachable in the toast while
// Settings stays open. Copy and Dismiss leave Settings in place. The row stays
// in Notices after the toast is gone.
test("failed agent checks stay readable above Settings and remain in Notices", async () => {
  const temp = await createTempWorkspace();
  let desktop: Awaited<ReturnType<typeof launchDesktopApp>> | null = null;
  try {
    await seedWorkspaceManifest(temp, "agent-settings-failure-e2e");
    await seedRunnerSettings(temp, "silent-fail");
    desktop = await launchDesktopApp({ workspace: temp, env: await installFakeAgentTools(temp) });
    const page = desktop.page;
    await openWorkspaceFromFirstRun(page, temp);
    await trustOpenWorkspace(desktop);
    await page.getByTestId(activityPin("settings")).click();
    await page.getByTestId(settingsNavPin("agents")).click();
    await page.getByTestId("agent-check").click();
    await expect(page.getByTestId("agent-row")).toContainText("Didn't reply.");
    // The toast names the agent; Copy details carries why.
    const message = "Nova didn't reply to the check.";
    const reason = "Runner exited before reporting self-test success.";
    const toast = page.getByTestId("workspace-shell-error");
    await expect(toast).toContainText(message);
    const settings = page.getByTestId(desktopPins.settingsDialog);
    for (const theme of ["light", "dark"]) {
      await page.evaluate((value) => document.documentElement.setAttribute("data-theme", value), theme);
      await expect.poll(() => hitAtCenter(toast)).toBe("toast");
      await expect(settings).toBeVisible();
      if (process.env.UI_AUDIT_SHOT_DIR) {
        await mkdir(process.env.UI_AUDIT_SHOT_DIR, { recursive: true });
        await page.screenshot({ path: join(process.env.UI_AUDIT_SHOT_DIR, `runner-test-error-${theme}.png`) });
      }
    }
    // Keep both clears inside the copy/read span.
    await holdSystemClipboard(test.info(), async (remainingMs) => {
      await desktop!.app.evaluate(({ clipboard }) => clipboard.clear());
      try {
        await page.getByTestId("workspace-shell-error-copy").click({ timeout: remainingMs() });
        await expect.poll(() => desktop!.app.evaluate(({ clipboard }) => clipboard.readText()), { timeout: remainingMs() }).toContain(reason);
      } finally {
        await desktop!.app.evaluate(({ clipboard }) => clipboard.clear()).catch(() => undefined);
      }
    });
    await expect(settings).toBeVisible();
    await page.getByRole("button", { name: "Dismiss workspace error" }).click();
    await expect(toast).toHaveCount(0);
    await expect(settings).toBeVisible();
    await page.getByRole("button", { name: "Close settings" }).click();
    await expect(settings).toHaveCount(0);
    await page.getByTestId("notice-center-toggle").click();
    await expect(page.getByTestId("notice-center")).toContainText(message);
  } finally {
    await cleanupDesktopWorkspace(desktop, temp);
  }
});
