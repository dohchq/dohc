import { expect, test, type Page } from "@playwright/test";
import { sendCliRequest } from "@dohc/cli/client";
import {
  CLI_PROTOCOL_VERSION,
  type CliRequestWithoutToken,
  type CliResultByVerb,
  type CliVerb,
} from "@dohc/cli/protocol";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { launchDesktopApp } from "./helpers/desktopApp";
import { waitForCliEndpoint } from "./helpers/dohcCli";
import { ydocUpdateAuthors } from "./helpers/engineDb";
import {
  cleanupDesktopWorkspace,
  createTempWorkspace,
  explorerRow,
  openFileChatsPanel,
  openWorkspaceFromFirstRun,
  waitForWorkspaceFile,
  writeWorkspaceFiles,
  type TempWorkspace,
} from "./helpers/workspace";

// An agent reads and edits live documents through the hop its MCP tools use:
// the desktop's authenticated CLI socket. `requestCli` in
// packages/mcp/src/tools.ts sends the same request, with actor "agent" and the
// name the MCP client gave itself. The person keeps typing in the document
// while the agent's edit arrives.

type Desktop = Awaited<ReturnType<typeof launchDesktopApp>>;

async function agentCli<Verb extends CliVerb>(
  temp: TempWorkspace,
  verb: Verb,
  args: Omit<Extract<CliRequestWithoutToken, { verb: Verb }>["args"], "cwd" | "actor">,
): Promise<CliResultByVerb[Verb]> {
  const request = {
    protocolVersion: CLI_PROTOCOL_VERSION,
    verb,
    args: { cwd: temp.rootPath, actor: "agent" as const, ...args },
  } as unknown as Extract<CliRequestWithoutToken, { verb: Verb }>;
  return await sendCliRequest<Verb>(request, { stateDir: temp.homeDir });
}

// Expands the document's folder unless an earlier open already did.
async function openDocument(page: Page, path: string): Promise<void> {
  const segments = path.split("/");
  for (let index = 0; index < segments.length - 1; index += 1) {
    const folder = explorerRow(page, segments.slice(0, index + 1).join("/"));
    if ((await folder.getAttribute("aria-expanded")) !== "true") await folder.click();
  }
  await explorerRow(page, path).click();
  // The engine session is live once the local editor's Edit toggle is gone.
  await expect(page.getByTestId("markdown-edit-toggle")).toHaveCount(0, { timeout: 15_000 });
  await expect(page.getByTestId("markdown-editor")).toBeVisible();
}

async function fileText(temp: TempWorkspace, path: string): Promise<string> {
  return await readFile(join(temp.rootPath, path), "utf8").catch(() => "");
}

test("an agent's edit merges into a document the person is typing in", async ({}, testInfo) => {
  test.setTimeout(240_000);
  const temp = await createTempWorkspace();
  let desktop: Desktop | null = null;

  try {
    await writeWorkspaceFiles(temp, [
      {
        path: "notes/plan.md",
        contents: "# Plan\n\nThe person writes here.\n\nThe agent edits this line.\n",
      },
      { path: "notes/closed.md", contents: "# Closed\n\nNobody has this open.\n" },
    ]);
    desktop = await launchDesktopApp({ workspace: temp });
    const { page } = desktop;
    const workspace = await openWorkspaceFromFirstRun(page, temp);
    await waitForWorkspaceFile(page, workspace.workspaceId, "notes/plan.md");
    await waitForCliEndpoint(temp.homeDir);
    await openDocument(page, "notes/plan.md");

    // The person puts the cursor at the end of their paragraph and types.
    const editor = page.getByTestId("markdown-editor");
    await editor.getByText("The person writes here.").click();
    await page.keyboard.press("End");
    await page.keyboard.type(" Typed before.");
    await expect
      .poll(async () => {
        const read = await agentCli(temp, "documentRead", { path: "notes/plan.md" });
        return read.ok && read.markdown.includes("Typed before.");
      }, { timeout: 30_000 })
      .toBe(true);

    // The person types once more, and the renderer then stops handling
    // anything for a while: the typing waits in the editor's send batch, and
    // no update from the person reaches main while the agent edits.
    const holdMs = 10_000;
    const heldUntil = await page.evaluate((hold) => {
      const host = document.querySelector('[data-testid="markdown-editor"]') as
        | (Element & {
          editor?: {
            state: { doc: { descendants(visit: (node: { isTextblock: boolean; textContent: string; nodeSize: number }, pos: number) => void): void } };
            commands: { insertContentAt(position: number, text: string): boolean };
          };
        })
        | null;
      const tiptap = host?.editor;
      if (!tiptap) throw new Error("The editor is not ready.");
      let end = -1;
      tiptap.state.doc.descendants((node, pos) => {
        if (node.isTextblock && node.textContent.startsWith("The person writes here.")) end = pos + node.nodeSize - 1;
      });
      tiptap.commands.insertContentAt(end, " Queued.");
      const until = Date.now() + hold;
      // Scheduled after the send batch's own timer was armed and before it
      // fires, so the batch stays queued.
      setTimeout(() => {
        while (Date.now() < until) { /* hold the renderer */ }
      }, 0);
      return until;
    }, holdMs);

    // The agent edits the paragraph the person is typing in and the line
    // below it. Main has not seen the queued typing.
    const during = await agentCli(temp, "documentRead", { path: "notes/plan.md" });
    if (!during.ok) throw new Error(`documentRead failed: ${during.reason}`);
    expect(during.markdown).toContain("The person writes here. Typed before.");
    expect(during.markdown).not.toContain("Queued.");
    await expect(agentCli(temp, "documentEdit", {
      agent: "e2e-agent",
      path: "notes/plan.md",
      find: "person writes here",
      replacement: "person wrote here",
    })).resolves.toEqual({ ok: true, path: "notes/plan.md", changed: true });
    await expect(agentCli(temp, "documentEdit", {
      agent: "e2e-agent",
      path: "notes/plan.md",
      find: "The agent edits this line.",
      replacement: "The agent edited this line.\n\n## Added by the agent\n\nA new section.",
    })).resolves.toEqual({ ok: true, path: "notes/plan.md", changed: true });
    // Both edits landed while the renderer still held its batch.
    expect(Date.now()).toBeLessThan(heldUntil);

    // The renderer resumes, sends its typing, and takes the agent's edits.
    // The person keeps typing where the cursor was.
    await page.keyboard.type(" Typed after.");

    await expect(editor).toContainText(
      "The person wrote here. Typed before. Queued. Typed after.",
    );
    await expect(editor).toContainText("The agent edited this line.");
    await expect(editor.getByRole("heading", { name: "Added by the agent" })).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath("agent-edit-merged.png") });

    // Both people's text reaches the agent's next read and the file.
    const merged = [
      "The person wrote here. Typed before. Queued. Typed after.",
      "The agent edited this line.\n\n## Added by the agent\n\nA new section.",
    ];
    await expect
      .poll(async () => {
        const next = await agentCli(temp, "documentRead", { path: "notes/plan.md" });
        return next.ok && merged.every((part) => next.markdown.includes(part));
      }, { timeout: 30_000 })
      .toBe(true);
    await expect
      .poll(async () => {
        const text = await fileText(temp, "notes/plan.md");
        return merged.every((part) => text.includes(part));
      }, { timeout: 30_000 })
      .toBe(true);

    // The engine records the agent's update under the name it gave, and the
    // person's typing as a person's.
    const authors = ydocUpdateAuthors(temp.rootPath);
    expect(authors).toContainEqual({ actorOriginId: "e2e-agent", actorKind: "agent" });
    expect(authors.some((author) => author.actorKind === "human")).toBe(true);

    // With no editor open, the edit opens a session of its own, settles, and
    // lands in the file before the call returns.
    const closed = await agentCli(temp, "documentEdit", {
      path: "notes/closed.md",
      replacement: "Added with no editor open.",
    });
    expect(closed).toEqual({ ok: true, path: "notes/closed.md", changed: true });
    expect(await fileText(temp, "notes/closed.md")).toContain("Added with no editor open.");
    await openDocument(page, "notes/closed.md");
    await expect(page.getByTestId("markdown-editor")).toContainText("Added with no editor open.");
  } finally {
    await cleanupDesktopWorkspace(desktop, temp);
  }
});

test("an agent creates a document and comments on it where the person reads comments", async ({}, testInfo) => {
  test.setTimeout(240_000);
  const temp = await createTempWorkspace();
  let desktop: Desktop | null = null;

  try {
    await writeWorkspaceFiles(temp, [{ path: "notes/readme.md", contents: "# Notes\n" }]);
    desktop = await launchDesktopApp({ workspace: temp });
    const { page } = desktop;
    const workspace = await openWorkspaceFromFirstRun(page, temp);
    await waitForWorkspaceFile(page, workspace.workspaceId, "notes/readme.md");
    await waitForCliEndpoint(temp.homeDir);

    // The agent creates a document. Its text is in the file when the call
    // returns.
    const created = await agentCli(temp, "documentCreate", {
      agent: "e2e-agent",
      path: "notes/itinerary.md",
      markdown: "# Kyoto\n\n## Friday 14\n\n- Fushimi Inari at dawn",
    });
    expect(created).toEqual({ ok: true, path: "notes/itinerary.md" });
    expect(await fileText(temp, "notes/itinerary.md")).toContain("## Friday 14");
    await expect(agentCli(temp, "documentCreate", {
      path: "notes/itinerary.md",
      markdown: "Again",
    })).resolves.toMatchObject({ ok: false, reason: expect.stringContaining("already exists") });

    // The person sees the new document and opens it.
    await waitForWorkspaceFile(page, workspace.workspaceId, "notes/itinerary.md");
    await openDocument(page, "notes/itinerary.md");
    const editor = page.getByTestId("markdown-editor");
    await expect(editor.getByRole("heading", { name: "Friday 14" })).toBeVisible();
    await expect(editor).toContainText("Fushimi Inari at dawn");

    // The agent comments on it: a chat linked to the file, the same kind a
    // person starts from the file's Chats panel.
    // Finding a file's chats first waits for dohc to capture the workspace,
    // which reports a refusal while its capture is still moving. Nothing is
    // created before that refusal, so the agent retries.
    let comment: CliResultByVerb["fileChatStart"] | undefined;
    await expect.poll(async () => {
      comment = await agentCli(temp, "fileChatStart", {
        path: "notes/itinerary.md",
        title: "Friday plan",
        body: "Dawn is 5:40. Should we leave the hotel at 5?",
      });
      return comment.ok ? "started" : comment.reason;
    }, { timeout: 60_000 }).toBe("started");
    if (!comment?.ok) throw new Error("fileChatStart did not start a chat");
    const threadId = comment.threadId;
    await expect.poll(async () => {
      const listed = await agentCli(temp, "fileChats", { path: "notes/itinerary.md" });
      return listed.ok ? listed.threads.map((thread) => [thread.id, thread.title]) : listed.reason;
    }, { timeout: 60_000 }).toEqual([[threadId, "Friday plan"]]);

    await openFileChatsPanel(page);
    await page.getByTestId("linked-chat-open").click();
    await expect(page.getByTestId("linked-chat-title")).toContainText("Friday plan");
    await expect(page.getByTestId("linked-chat-message-body"))
      .toContainText("Dawn is 5:40. Should we leave the hotel at 5?");
    await expect(
      page.locator('[data-testid="linked-chat-message-author"][data-author-kind="agent"]'),
    ).toHaveCount(1);

    // The person answers in the same chat, and the agent reads the answer.
    const composer = page.getByTestId("linked-chat-composer");
    await composer.fill("Yes, 5 is fine.");
    await composer.press("Enter");
    await expect
      .poll(async () => {
        const chat = await agentCli(temp, "chat", { threadId });
        return chat.ok ? chat.messages.map((message) => [message.authorKind, message.body]) : [];
      }, { timeout: 30_000 })
      .toEqual([
        ["agent", "Dawn is 5:40. Should we leave the hotel at 5?"],
        ["human", "Yes, 5 is fine."],
      ]);
    await page.screenshot({ path: testInfo.outputPath("agent-comment.png") });
  } finally {
    await cleanupDesktopWorkspace(desktop, temp);
  }
});
