import { expect, test, type Page } from "@playwright/test";
import { writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { DEFAULT_USER_SETTINGS } from "../src/settings/userSettings";
import { USER_SETTINGS_FILE } from "../src/settings/userSettingsStore";
import { desktopRoot, launchDesktopApp } from "./helpers/desktopApp";
import {
  cleanupDesktopWorkspace,
  createTempWorkspace,
  openWorkspaceFromFirstRun,
  seedWorkspaceManifest,
  seedWorkspaceSettings,
  type TempWorkspace,
} from "./helpers/workspace";

// The CLI reaches a running app on Windows now (#333), so the socket is no
// longer why these skip. The dispatch path itself is: with the runner exiting
// 3, no failure note reaches the thread within 30s on Windows, and the report
// case never posts either. Both are about the runner, not the transport.
const WINDOWS_DISPATCH_SKIP =
  "My agent's runner dispatch does not complete on Windows.";

const REPORT = "done: checked the exports";
const fakeRunner = resolve(desktopRoot, "e2e/fixtures/fakeChatRunner.mjs");

function runnerCommand(mode: "report" | "silent-fail"): string {
  return `node "${fakeRunner.replaceAll('"', '\\"')}" ${mode}`;
}

async function seedRunnerSettings(
  temp: Pick<TempWorkspace, "homeDir">,
  mode: "report" | "silent-fail",
): Promise<string> {
  const command = runnerCommand(mode);
  const settings = {
    ...DEFAULT_USER_SETTINGS,
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
  test.skip(process.platform === "win32", WINDOWS_DISPATCH_SKIP);

  const temp = await createTempWorkspace();
  let desktop: Awaited<ReturnType<typeof launchDesktopApp>> | null = null;
  const workspaceId = "agent-dispatch-report-e2e";

  try {
    await seedWorkspaceManifest(temp, workspaceId);
    await seedWorkspaceSettings(temp, {
      experimental: { workspaceEngineAlpha: true },
    });
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

test("My agent posts a durable failure note when the runner exits silently", async () => {
  test.skip(process.platform === "win32", WINDOWS_DISPATCH_SKIP);

  const temp = await createTempWorkspace();
  let desktop: Awaited<ReturnType<typeof launchDesktopApp>> | null = null;
  const workspaceId = "agent-dispatch-failure-e2e";

  try {
    await seedWorkspaceManifest(temp, workspaceId);
    await seedWorkspaceSettings(temp, {
      experimental: { workspaceEngineAlpha: true },
    });
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
    await expect(failureNote.getByTestId("chats-comment-agent-badge")).toHaveText(
      "agent",
    );
  } finally {
    await cleanupDesktopWorkspace(desktop, temp);
  }
});
