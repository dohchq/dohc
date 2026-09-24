import { expect, test } from "@playwright/test";
import { launchDesktopApp } from "./helpers/desktopApp";
import {
  cleanupDesktopWorkspace,
  createTempWorkspace,
  explorerRow,
  openFileChatsPanel,
  openHistoryView,
  openWorkspaceFromFirstRun,
  revealExplorerPath,
  seedWorkspaceManifest,
  waitForWorkspaceFile,
  writeWorkspaceFiles,
} from "./helpers/workspace";
// The REAL MCP tool implementation, invoked from the test runner's process
// while the app is running (the deployment shape: desktop + MCP stdio child).
// MCP never opens the daemon-owned engine.db itself: every chat verb goes to
// the running desktop over the CLI transport, which is the sole writer.
import { replyToChat } from "../../../packages/mcp/src/tools";

// PR 0N-1 agent loop E2E: a dohc-tracked agent run's file edits appear in
// History as "the agent name" (signed out => "Agent"), edits after
// the run ends go back to actor-neutral, and an MCP chat reply lands in the
// file rail attributed to the agent.

async function startAgentRun(
  page: import("@playwright/test").Page,
  workspaceId: string,
): Promise<string> {
  return page.evaluate(async ({ id }) => {
    const api = (window as unknown as {
      dohcDesktop: {
        startAgentRun(payload: { workspaceId: string }): Promise<{ id: string }>;
      };
    }).dohcDesktop;
    const run = await api.startAgentRun({ workspaceId: id });
    return run.id;
  }, { id: workspaceId });
}

async function endAgentRun(
  page: import("@playwright/test").Page,
  workspaceId: string,
  runId: string,
): Promise<void> {
  await page.evaluate(async ({ id, run }) => {
    const api = (window as unknown as {
      dohcDesktop: {
        endAgentRun(payload: { workspaceId: string; runId: string }): Promise<void>;
      };
    }).dohcDesktop;
    await api.endAgentRun({ workspaceId: id, runId: run });
  }, { id: workspaceId, run: runId });
}

test("a dohc-tracked run's edits show as \"Agent\" in History; later edits are neutral", async () => {
  const temp = await createTempWorkspace();
  let desktop: Awaited<ReturnType<typeof launchDesktopApp>> | null = null;

  try {
    desktop = await launchDesktopApp({ workspace: temp });
    const workspace = await openWorkspaceFromFirstRun(desktop.page, temp);
    const page = desktop.page;

    // Start a dohc-tracked agent run through the same integration the agent
    // panel uses (AgentIntegration -> workspaceActivity.setAgentRun).
    const runId = await startAgentRun(page, workspace.workspaceId);

    await writeWorkspaceFiles(temp, [
      { path: "notes/plan.md", contents: "agent draft\n" },
    ]);
    await waitForWorkspaceFile(page, workspace.workspaceId, "notes/plan.md");

    // History lives in the left History view (the right panel is Chats now).
    await openHistoryView(page);
    const agentRow = page.locator(
      '[data-testid="engine-moment-open"][data-moment-path="notes/plan.md"]',
    );
    await expect(agentRow.first()).toBeVisible();
    // Signed out, run active: History attributes the edit to "Agent".
    await expect(
      agentRow.first().getByTestId("engine-moment-source"),
    ).toHaveText("Agent");

    // The diff page carries the same attribution.
    await agentRow.first().click();
    await expect(page.getByTestId("engine-moment-diff-page")).toBeVisible();
    await expect(page.getByTestId("engine-diff-source")).toHaveText("Agent");

    // End the run: later edits are the local user's, actor-neutral.
    await endAgentRun(page, workspace.workspaceId, runId);
    await writeWorkspaceFiles(temp, [
      { path: "notes/mine.md", contents: "my own edit\n" },
    ]);
    await waitForWorkspaceFile(page, workspace.workspaceId, "notes/mine.md");
    const localRow = page.locator(
      '[data-testid="engine-moment-open"][data-moment-path="notes/mine.md"]',
    );
    await expect(localRow.first()).toBeVisible();
    await expect(
      localRow.first().getByTestId("engine-moment-source"),
    ).toHaveText("Local file edit");
  } finally {
    await cleanupDesktopWorkspace(desktop, temp);
  }
});

test("an MCP chat reply reaches the file rail as \"Agent\"", async () => {
  const temp = await createTempWorkspace();
  let desktop: Awaited<ReturnType<typeof launchDesktopApp>> | null = null;
  const workspaceId = "mcp-chat-reply";

  try {
    // A known workspace id so the MCP process (which reads the manifest for
    // identity) and the app agree on the workspace.
    await seedWorkspaceManifest(temp, workspaceId);
    desktop = await launchDesktopApp({ workspace: temp });
    const workspace = await openWorkspaceFromFirstRun(desktop.page, temp);
    expect(workspace.workspaceId).toBe(workspaceId);
    const page = desktop.page;

    await writeWorkspaceFiles(temp, [
      { path: "notes/topic.md", contents: "# Topic\n" },
    ]);
    await waitForWorkspaceFile(page, workspaceId, "notes/topic.md");
    // The engine must own the file (stable object id) before a chat can link.
    await page.waitForFunction(
      async ({ id, filePath }) => {
        const api = (window as unknown as {
          dohcDesktop?: {
            listFileChats(payload: { workspaceId: string; path: string }): Promise<{
              fileObjectId: string | null;
            }>;
          };
        }).dohcDesktop;
        if (!api) return false;
        const result = await api.listFileChats({ workspaceId: id, path: filePath });
        return result.fileObjectId !== null;
      },
      { id: workspaceId, filePath: "notes/topic.md" },
    );

    // Create the chat and ask a question as the human user.
    await revealExplorerPath(page, "notes/topic.md");
    await explorerRow(page, "notes/topic.md").click();
    await openFileChatsPanel(page);
    await page.getByTestId("linked-chat-new").click();
    const titleInput = page.getByTestId("linked-chat-new-title");
    await titleInput.fill("Agent question");
    await titleInput.press("Enter");
    await expect(page.getByTestId("linked-chat-title")).toContainText("Agent question");
    const composer = page.getByTestId("linked-chat-composer");
    await composer.fill("Can you summarize this file?");
    await composer.press("Enter");
    await expect(page.getByTestId("linked-chat-message-body")).toContainText(
      "Can you summarize this file?",
    );

    // Resolve the thread id the same way an agent would (stable object id ->
    // linked threads).
    const threadId = await page.evaluate(async ({ id }) => {
      const api = (window as unknown as {
        dohcDesktop: {
          listFileChats(payload: { workspaceId: string; path: string }): Promise<{
            threads: Array<{ id: string }>;
          }>;
        };
      }).dohcDesktop;
      const result = await api.listFileChats({ workspaceId: id, path: "notes/topic.md" });
      return result.threads[0]?.id ?? null;
    }, { id: workspaceId });
    expect(threadId).not.toBeNull();

    // Reply through the REAL MCP tool from this (second) process while the
    // app holds its own engine.db connections — the two-way rail plus the
    // cross-process write posture in one step.
    const reply = await replyToChat(
      { root: temp.rootPath, home: temp.homeDir },
      { threadId: threadId!, body: "Done — here is the summary you asked for." },
    );
    const agentAuthor = page.locator(
      '[data-testid="linked-chat-message-author"][data-author-kind="agent"]',
    );

    expect(reply).toMatchObject({
      ok: true,
      threadId,
      messageId: expect.stringMatching(/^message-/u),
    });

    // Re-open the thread (back -> open) to fetch the fresh message list and
    // assert the agent reply renders as "Agent".
    await page.getByTestId("linked-chat-back").click();
    await page.getByTestId("linked-chat-open").click();
    await expect(page.getByTestId("linked-chat-message-body").nth(1)).toContainText(
      "Done — here is the summary you asked for.",
    );
    await expect(agentAuthor).toHaveText("Agent");
    await page.getByTestId("linked-chat-agent-badge").focus();
    await expect(page.getByRole("tooltip")).toContainText("Owned by You");
  } finally {
    await cleanupDesktopWorkspace(desktop, temp);
  }
});
