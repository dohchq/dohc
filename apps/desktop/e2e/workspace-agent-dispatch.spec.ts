import { expect, test, type Page } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { DEFAULT_USER_SETTINGS } from "../src/settings/userSettings";
import { USER_SETTINGS_FILE } from "../src/settings/userSettingsStore";
import { desktopRoot, launchDesktopApp } from "./helpers/desktopApp";
import { installFakeAgentTools } from "./helpers/agentTools";
import {
  cleanupDesktopWorkspace,
  createTempWorkspace,
  openWorkspaceFromFirstRun,
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
    const page = desktop.page;
    await openMyAgent(page);
    await page.getByTestId("chats-channel-back").click();
    await page.locator("main").getByTestId("chats-add-agent-open").click();
    await page.getByTestId("chats-add-agent-agent-name").fill("Nova");
    await page.getByTestId("chats-add-agent-name").fill("Profile test");
    for (const name of ["Claude Code", "Codex"]) {
      await page.getByRole("button", { name, exact: true }).click();
      await page.getByTestId("chats-add-agent-check").click();
      await expect(page.getByTestId("chats-add-agent-check-result")).toHaveAttribute("data-state", "ok");
    }
    await page.getByTestId("chats-add-agent-submit").click();
    await expect(page.getByTestId("chats-add-agent")).toHaveCount(0);
    await page.locator("main").getByTestId("chats-channel").filter({ hasText: "general" }).click();
    await page.getByTestId("chats-new-thread-composer").fill("@agent check the exports");
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
  const settings = {
    ...DEFAULT_USER_SETTINGS,
    profile: { agentName: "Nova", preferredName: "Ice" },
    runner: {
      command,
      enabled: true,
      timeoutMinutes: 1,
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

  await page.getByTestId("titlebar-chats-sidebar").click();
  await expect(page.getByTestId("chats-view")).toBeVisible();
  await page.getByTestId("chats-my-agent").click();
  await expect(page.getByTestId("chats-channel-title")).toHaveText("My agent");
}

test("My agent dispatches a fresh successful run for each human message", async () => {
  const temp = await createTempWorkspace();
  let desktop: Awaited<ReturnType<typeof launchDesktopApp>> | null = null;
  const workspaceId = "agent-dispatch-report-e2e";

  try {
    await seedWorkspaceManifest(temp, workspaceId);
    const command = await seedRunnerSettings(temp, "report");
    desktop = await launchDesktopApp({ workspace: temp });
    await openWorkspaceFromFirstRun(desktop.page, temp);
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

test("My agent posts a durable failure note when the runner exits silently", async () => {
  const temp = await createTempWorkspace();
  let desktop: Awaited<ReturnType<typeof launchDesktopApp>> | null = null;
  const workspaceId = "agent-dispatch-failure-e2e";

  try {
    await seedWorkspaceManifest(temp, workspaceId);
    await seedRunnerSettings(temp, "silent-fail");
    desktop = await launchDesktopApp({ workspace: temp });
    await openWorkspaceFromFirstRun(desktop.page, temp);
    const page = desktop.page;
    await openMyAgent(page);

    await page.getByTestId("chats-new-thread-composer").fill("audit the projections");
    await page.getByTestId("chats-new-thread-composer").press("Enter");
    await expect(page.getByTestId("chats-thread-view")).toBeVisible();

    const failureNote = page
      .getByTestId("chats-message")
      .filter({
        hasText:
          "⚠ Agent run failed (exit 3). Open the run chip for details.",
      });
    await expect(failureNote).toHaveCount(1);
    await expect(failureNote.getByTestId("chats-message-body")).toHaveText(
      "⚠ Agent run failed (exit 3). Open the run chip for details.",
    );
    await expect(failureNote.getByTestId("chats-comment-agent-badge")).toHaveCount(0);
    await expect(failureNote.getByTestId("chats-message-author")).toHaveText("dohc");
    await expect(failureNote.getByTestId("chats-message-author")).toHaveAttribute("data-author-kind", "system");
  } finally {
    await cleanupDesktopWorkspace(desktop, temp);
  }
});

test("failed runner tests stay readable above Settings and remain in Notices", async () => {
  const temp = await createTempWorkspace();
  let desktop: Awaited<ReturnType<typeof launchDesktopApp>> | null = null;
  try {
    await seedWorkspaceManifest(temp, "agent-settings-failure-e2e");
    await seedRunnerSettings(temp, "silent-fail");
    desktop = await launchDesktopApp({ workspace: temp });
    const page = desktop.page;
    await openWorkspaceFromFirstRun(page, temp);
    await page.getByTestId("open-settings").click();
    await page.getByTestId("settings-nav-agents").click();
    await page.getByTestId("runner-self-test-button").click();
    await expect(page.getByTestId("runner-self-test-result")).toHaveAttribute("data-state", "error");
    await expect(page.getByTestId("runner-self-test-result")).toHaveText("Test failed.");
    const reason = "Runner exited before reporting self-test success.";
    const toast = page.getByTestId("workspace-shell-error");
    await expect(toast).toContainText(reason);
    for (const theme of ["light", "dark"]) {
      await page.evaluate((value) => document.documentElement.setAttribute("data-theme", value), theme);
      await expect.poll(() => toast.evaluate((element) => {
        const bounds = element.getBoundingClientRect();
        return element.contains(document.elementFromPoint(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2));
      })).toBe(true);
      if (process.env.UI_AUDIT_SHOT_DIR) {
        await mkdir(process.env.UI_AUDIT_SHOT_DIR, { recursive: true });
        await page.screenshot({ path: join(process.env.UI_AUDIT_SHOT_DIR, `runner-test-error-${theme}.png`) });
      }
    }
    await page.getByTestId("workspace-shell-error-copy").click();
    await expect.poll(() => desktop!.app.evaluate(({ clipboard }) => clipboard.readText())).toContain(reason);
    await expect(page.getByTestId("settings-dialog")).toBeVisible();
    await page.getByRole("button", { name: "Dismiss workspace error" }).click();
    await expect(toast).toHaveCount(0);
    await expect(page.getByTestId("settings-dialog")).toBeVisible();
    await page.getByRole("button", { name: "Close settings" }).click();
    await page.getByTestId("notice-center-toggle").click();
    await expect(page.getByTestId("notice-center")).toContainText(reason);
  } finally {
    await cleanupDesktopWorkspace(desktop, temp);
  }
});
