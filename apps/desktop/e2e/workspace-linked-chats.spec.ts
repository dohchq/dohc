import { expect, test } from "@playwright/test";
import { desktopPins } from "../src/testPins";
import { seedThroughDaemon } from "./helpers/daemonSeed";
import { runDohcCli, waitForCliEndpoint } from "./helpers/dohcCli";
import { launchDesktopApp } from "./helpers/desktopApp";
import {
  cleanupDesktopWorkspace,
  createTempWorkspace,
  explorerRow,
  openAboutPanel,
  openWorkspaceFromFirstRun,
  revealExplorerPath,
  seedWorkspaceManifest,
  trustOpenWorkspace,
  waitForFileObjectId,
  waitForWorkspaceFile,
  writeWorkspaceFiles,
} from "./helpers/workspace";

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
    await openAboutPanel(page);

    await expect(page.getByTestId("about-chats-count")).toHaveText("0");
    await expect(page.getByTestId("linked-chat-open")).toHaveCount(0);
    await page.getByTestId("linked-chat-new").click();
    const comment = page.getByTestId("linked-chat-new-composer");
    await comment.fill("Naming discussion\nShould we rename this topic?");
    await comment.press("Enter");
    await expect(page.getByTestId("linked-chat-title")).toContainText("Naming discussion");
    await expect(page.getByTestId("linked-chat-message-body")).toContainText(
      "Should we rename this topic?",
    );
    await expect(page.getByTestId("linked-chat-message-author")).toHaveText("You");

    await desktop.close();
    desktop = await launchDesktopApp({ workspace: temp });
    await openWorkspaceFromFirstRun(desktop.page, temp);
    page = desktop.page;
    await waitForWorkspaceFile(page, workspace.workspaceId, "notes/topic.md");
    await revealExplorerPath(page, "notes/topic.md");
    await explorerRow(page, "notes/topic.md").click();
    await openAboutPanel(page);
    await expect(page.getByTestId("linked-chat-open")).toContainText("Naming discussion");
    await page.getByTestId("linked-chat-open").click();
    await expect(page.getByTestId("linked-chat-message-body")).toContainText(
      "Should we rename this topic?",
    );

    await page.evaluate(
      async ({ id }) => {
        const api = (
          window as unknown as {
            dohcDesktop: {
              moveWorkspacePath(payload: {
                workspaceId: string;
                fromPath: string;
                toPath: string;
              }): Promise<unknown>;
            };
          }
        ).dohcDesktop;
        await api.moveWorkspacePath({
          workspaceId: id,
          fromPath: "notes/topic.md",
          toPath: "notes/renamed-topic.md",
        });
      },
      { id: workspace.workspaceId },
    );
    await waitForWorkspaceFile(page, workspace.workspaceId, "notes/renamed-topic.md");
    await page.waitForFunction(
      async ({ id }) => {
        const api = (
          window as unknown as {
            dohcDesktop?: {
              listFileChats(payload: { workspaceId: string; path: string }): Promise<{
                threads: Array<{ title: string }>;
              }>;
            };
          }
        ).dohcDesktop;
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

test("comment on a selected passage, see it highlighted, and open the comment from it", async () => {
  const temp = await createTempWorkspace();
  let desktop: Awaited<ReturnType<typeof launchDesktopApp>> | null = null;
  const shot = async (name: string) => {
    for (const theme of ["light", "dark"] as const) {
      await desktop!.page.evaluate(async (value) => {
        document.documentElement.setAttribute("data-theme", value);
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      }, theme);
      await desktop!.page.screenshot({ path: test.info().outputPath(`${name}-${theme}.png`) });
    }
    await desktop!.page.evaluate(() =>
      document.documentElement.setAttribute("data-theme", "light"),
    );
  };

  try {
    desktop = await launchDesktopApp({ workspace: temp });
    const workspace = await openWorkspaceFromFirstRun(desktop.page, temp);
    const page = desktop.page;
    await writeWorkspaceFiles(temp, [
      {
        path: "notes/plan.md",
        contents: "# Plan\n\nShip the launch plan on Monday.\n\nBudget is tight this quarter.\n",
      },
    ]);
    await waitForWorkspaceFile(page, workspace.workspaceId, "notes/plan.md");
    await waitForFileObjectId(page, workspace.workspaceId, "notes/plan.md");
    await revealExplorerPath(page, "notes/plan.md");
    await explorerRow(page, "notes/plan.md").click();
    const editor = page.getByTestId("markdown-editor");
    await expect(editor).toContainText("Ship the launch plan on Monday.");

    await editor
      .getByText("Ship the launch plan on Monday.")
      .dblclick({ position: { x: 70, y: 8 } });
    const toolbar = page.locator(".dohc-bubble-menu");
    await expect(toolbar).toBeVisible();
    await toolbar.getByRole("button", { name: "Comment", exact: true }).click();
    const quote = page.getByTestId("linked-chat-new-quote");
    await expect(quote).toBeVisible();
    const passage = (await quote.textContent())!;
    expect("Ship the launch plan on Monday.").toContain(passage);
    await shot("passage-composer");
    const composer = page.getByTestId("linked-chat-new-composer");
    await expect(composer).toBeFocused();
    await composer.fill("Is Monday realistic?");
    await composer.press("Enter");
    await expect(page.getByTestId("linked-chat-title")).toHaveText("Is Monday realistic?");
    await expect(page.getByTestId("linked-chat-message-body")).toContainText(passage);

    const highlight = editor.locator("[data-comment-thread]");
    await expect(highlight).toHaveText(passage);

    await trustOpenWorkspace(desktop);
    await waitForCliEndpoint(temp.homeDir);
    await runDohcCli(temp, [
      "document",
      "comment",
      "notes/plan.md",
      "--title",
      "Travel budget",
      "--text",
      "> Budget is tight\n\nCan we move money from travel?",
      "--as-agent",
      "--json",
    ]);
    await expect(highlight).toHaveCount(2);
    await expect(highlight.nth(1)).toHaveText("Budget is tight");

    await page.getByTestId("linked-chat-back").click();
    await expect(page.getByTestId("linked-chat-quote")).toHaveText([passage, "Budget is tight"]);
    await shot("passage-comments");

    await page.getByTestId(desktopPins.titlebarAboutSidebar).click();
    await expect(page.getByTestId(desktopPins.aboutRail)).toBeHidden();
    await expect(highlight).toHaveCount(2);
    await highlight.nth(1).click();
    await expect(page.getByTestId("linked-chat-title")).toHaveText("Travel budget");
    await shot("passage-opened");
  } finally {
    await cleanupDesktopWorkspace(desktop, temp);
  }
});

test('agent-authored messages render as "their stored name"', async () => {
  const temp = await createTempWorkspace();
  let desktop: Awaited<ReturnType<typeof launchDesktopApp>> | null = null;
  const workspaceId = "chats-agent-render";

  try {
    await seedWorkspaceManifest(temp, workspaceId);
    // Seed before launch, through the engine daemon: the file exists in the engine
    // (and identically on disk so startup reconciliation is a no-op), with a
    // linked chat that already carries one human and one agent message.
    await writeWorkspaceFiles(temp, [{ path: "notes/agenda.md", contents: "# Agenda\n" }]);
    await seedThroughDaemon({ workspaceId, rootPath: temp.rootPath }, async ({ chats, files }) => {
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
        authorActorKey: null,
        workspaceId,
        threadId: thread.id,
        author: { kind: "human", displayName: "Sam Rivera" },
        body: "Can you tighten the agenda?",
      });
      await chats.sendMessage({
        authorActorKey: null,
        workspaceId,
        threadId: thread.id,
        author: { kind: "agent", displayName: "Nova" },
        authorOwnerDisplayName: "Sam Rivera",
        body: "Done — trimmed it to three items.",
      });
    });

    desktop = await launchDesktopApp({ workspace: temp });
    const workspace = await openWorkspaceFromFirstRun(desktop.page, temp);
    expect(workspace.workspaceId).toBe(workspaceId);
    const page = desktop.page;

    await waitForWorkspaceFile(page, workspaceId, "notes/agenda.md");
    await revealExplorerPath(page, "notes/agenda.md");
    await explorerRow(page, "notes/agenda.md").click();
    await openAboutPanel(page);
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
