import { expect, test } from "@playwright/test";
import { seedThroughDaemon } from "./helpers/daemonSeed";
import { launchDesktopApp } from "./helpers/desktopApp";
import {
  cleanupDesktopWorkspace,
  createTempWorkspace,
  explorerRow,
  openFileChatsPanel,
  openWorkspaceFromFirstRun,
  revealExplorerPath,
  seedWorkspaceManifest,
  waitForWorkspaceFile,
  writeWorkspaceFiles,
} from "./helpers/workspace";

// PR 0M-5 linked Chats rail E2E: create a chat about a file, send a message,
// survive a relaunch and a rename (stable engine object id), and render
// agent-authored messages as "their stored name".

async function waitForFileObjectId(
  page: import("@playwright/test").Page,
  workspaceId: string,
  path: string,
): Promise<void> {
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
    { id: workspaceId, filePath: path },
  );
}

test("create a chat about a file, send a message, survive relaunch and rename", async () => {
  const temp = await createTempWorkspace();
  let desktop: Awaited<ReturnType<typeof launchDesktopApp>> | null = null;

  try {
    desktop = await launchDesktopApp({ workspace: temp });
    const workspace = await openWorkspaceFromFirstRun(desktop.page, temp);
    let page = desktop.page;

    await writeWorkspaceFiles(temp, [
      { path: "notes/topic.md", contents: "# Topic\n\nSomething to discuss.\n" },
    ]);
    await waitForWorkspaceFile(page, workspace.workspaceId, "notes/topic.md");
    // The engine must own the file (stable object id) before a chat can link.
    await waitForFileObjectId(page, workspace.workspaceId, "notes/topic.md");

    await revealExplorerPath(page, "notes/topic.md");
    await explorerRow(page, "notes/topic.md").click();
    await openFileChatsPanel(page);

    // Calm empty state, then create.
    await expect(page.getByTestId("linked-chats-empty")).toContainText(
      "No chats about this file yet.",
    );
    await page.getByTestId("linked-chat-new").click();
    const titleInput = page.getByTestId("linked-chat-new-title");
    await expect(titleInput).toHaveValue("topic.md");
    await titleInput.fill("Naming discussion");
    await titleInput.press("Enter");

    await expect(page.getByTestId("linked-chat-title")).toContainText(
      "Naming discussion",
    );
    const composer = page.getByTestId("linked-chat-composer");
    await composer.fill("Should we rename this topic?");
    await composer.press("Enter");
    await expect(page.getByTestId("linked-chat-message-body")).toContainText(
      "Should we rename this topic?",
    );
    // Signed-out desktop: the human author displays as "You".
    await expect(page.getByTestId("linked-chat-message-author")).toHaveText("You");

    // Relaunch: the chat is durable in the engine store.
    await desktop.close();
    desktop = await launchDesktopApp({ workspace: temp });
    await openWorkspaceFromFirstRun(desktop.page, temp);
    page = desktop.page;
    await waitForWorkspaceFile(page, workspace.workspaceId, "notes/topic.md");
    await revealExplorerPath(page, "notes/topic.md");
    await explorerRow(page, "notes/topic.md").click();
    await openFileChatsPanel(page);
    await expect(page.getByTestId("linked-chat-open")).toContainText(
      "Naming discussion",
    );
    await page.getByTestId("linked-chat-open").click();
    await expect(page.getByTestId("linked-chat-message-body")).toContainText(
      "Should we rename this topic?",
    );

    // Rename through the product move IPC: the chat follows the file's
    // stable engine object id to its new path.
    await page.evaluate(
      async ({ id }) => {
        const api = (window as unknown as {
          dohcDesktop: {
            moveWorkspacePath(payload: {
              workspaceId: string;
              fromPath: string;
              toPath: string;
            }): Promise<unknown>;
          };
        }).dohcDesktop;
        await api.moveWorkspacePath({
          workspaceId: id,
          fromPath: "notes/topic.md",
          toPath: "notes/renamed-topic.md",
        });
      },
      { id: workspace.workspaceId },
    );
    await waitForWorkspaceFile(
      page,
      workspace.workspaceId,
      "notes/renamed-topic.md",
    );
    await page.waitForFunction(
      async ({ id }) => {
        const api = (window as unknown as {
          dohcDesktop?: {
            listFileChats(payload: { workspaceId: string; path: string }): Promise<{
              threads: Array<{ title: string }>;
            }>;
          };
        }).dohcDesktop;
        if (!api) return false;
        const result = await api.listFileChats({
          workspaceId: id,
          path: "notes/renamed-topic.md",
        });
        return result.threads.some((thread) => thread.title === "Naming discussion");
      },
      { id: workspace.workspaceId },
    );
  } finally {
    await cleanupDesktopWorkspace(desktop, temp);
  }
});

test("agent-authored messages render as \"their stored name\"", async () => {
  const temp = await createTempWorkspace();
  let desktop: Awaited<ReturnType<typeof launchDesktopApp>> | null = null;
  const workspaceId = "chats-agent-render";

  try {
    await seedWorkspaceManifest(temp, workspaceId);
    // Seed BEFORE launch, through the engine daemon (post-cutover the
    // retired TS in-process store is refused): the file exists in the engine
    // (and identically on disk so startup reconciliation is a no-op), with a
    // linked chat that already carries one human and one agent message.
    await writeWorkspaceFiles(temp, [
      { path: "notes/agenda.md", contents: "# Agenda\n" },
    ]);
    await seedThroughDaemon(
      { workspaceId, rootPath: temp.rootPath },
      async ({ chats, files }) => {
        await files.ensureMainVersion({ workspaceId });
        const seeded = await files.writeTextFile({
          workspaceId,
          versionId: "main",
          path: "notes/agenda.md",
          text: "# Agenda\n",
          metadata: { origin: "local-file" },
        });
        const thread = await chats.createThread({
          workspaceId,
          title: "Agenda review",
          linkedFile: { objectId: seeded.object.id, pathHint: "notes/agenda.md" },
        });
        await chats.sendMessage({
          workspaceId,
          threadId: thread.id,
          author: { kind: "human", displayName: "Sam Rivera" },
          body: "Can you tighten the agenda?",
        });
        await chats.sendMessage({
          workspaceId,
          threadId: thread.id,
          author: { kind: "agent", displayName: "Nova" },
          authorOwnerDisplayName: "Sam Rivera",
          body: "Done — trimmed it to three items.",
        });
      },
    );

    desktop = await launchDesktopApp({ workspace: temp });
    const workspace = await openWorkspaceFromFirstRun(desktop.page, temp);
    expect(workspace.workspaceId).toBe(workspaceId);
    const page = desktop.page;

    await waitForWorkspaceFile(page, workspaceId, "notes/agenda.md");
    await revealExplorerPath(page, "notes/agenda.md");
    await explorerRow(page, "notes/agenda.md").click();
    await openFileChatsPanel(page);
    await page.getByTestId("linked-chat-open").click();

    const authors = page.getByTestId("linked-chat-message-author");
    await expect(authors).toHaveCount(2);
    await expect(authors.nth(0)).toHaveText("Sam Rivera");
    await expect(authors.nth(1)).toHaveText("Nova");
    await expect(
      page.locator('[data-testid="linked-chat-message-author"][data-author-kind="agent"]'),
    ).toHaveText("Nova");
  } finally {
    await cleanupDesktopWorkspace(desktop, temp);
  }
});
