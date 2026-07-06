import { expect, test } from "@playwright/test";
import { createRequire } from "node:module";
import { join } from "node:path";
import { createLinkedChatStore, createVersionedTextStore } from "@dohc/workspace-engine";
import { launchDesktopApp } from "./helpers/desktopApp";
import {
  cleanupDesktopWorkspace,
  createTempWorkspace,
  openWorkspaceFromFirstRun,
  seedWorkspaceManifest,
  seedWorkspaceSettings,
  waitForWorkspaceFile,
  writeWorkspaceFiles,
} from "./helpers/workspace";

// WS-D — INDEXED ENGINE SEARCH MOUNTED IN THE DESKTOP (plan PR 11/17 scope):
// a flagged workspace's search panel routes through the engine's FTS index
// and returns FILES and CHAT MESSAGES in one result list; a chat hit renders
// a distinguishable row and opens the Chats rail on its thread. The `.env`
// family (including `.env.local`) is never findable AND never present in the
// raw FTS tables. Unflagged workspaces keep the streamed ripgrep path.

const SECRET_VALUE = "E2E_INDEX_SECRET_z9y8x7w6";

const requireModule = createRequire(import.meta.url);
const { DatabaseSync } = requireModule("node:sqlite") as {
  DatabaseSync: new (
    path: string,
    options?: { readOnly?: boolean },
  ) => {
    prepare(sql: string): {
      all(...params: unknown[]): Array<Record<string, unknown>>;
    };
    close(): void;
  };
};

function dumpSearchIndexTables(rootPath: string): string {
  const db = new DatabaseSync(join(rootPath, ".dohc/engine/engine.db"), {
    readOnly: true,
  });
  try {
    const files = db
      .prepare("SELECT path, text FROM engine_search_files_fts")
      .all();
    const chats = db
      .prepare("SELECT thread_id, text FROM engine_search_chat_messages_fts")
      .all();
    return JSON.stringify({ chats, files });
  } finally {
    db.close();
  }
}

test("flagged: search finds file content and a chat message; .env.local content never surfaces", async () => {
  const temp = await createTempWorkspace();
  let desktop: Awaited<ReturnType<typeof launchDesktopApp>> | null = null;
  const workspaceId = "engine-search-e2e";

  try {
    await seedWorkspaceManifest(temp, workspaceId);
    await seedWorkspaceSettings(temp, {
      experimental: { workspaceEngineAlpha: true },
    });
    // Disk state: one ordinary tracked file plus a `.env.local` (the family
    // member that originally fell through the secret classifier).
    await writeWorkspaceFiles(temp, [
      { path: "notes/roadmap.md", contents: "# Roadmap\n\nThe galaxy-brain milestone lands next.\n" },
      { path: ".env.local", contents: `API_TOKEN=${SECRET_VALUE}\n` },
    ]);
    // Seed the engine BEFORE launch (the linked-chats E2E idiom): the file
    // identical to disk so startup reconciliation is a no-op, plus a linked
    // chat thread carrying the message the search must find.
    const engineStore = createVersionedTextStore(temp.rootPath);
    await engineStore.ensureMainVersion({ workspaceId });
    const seeded = await engineStore.writeTextFile({
      workspaceId,
      versionId: "main",
      path: "notes/roadmap.md",
      text: "# Roadmap\n\nThe galaxy-brain milestone lands next.\n",
      metadata: { origin: "local-file" },
    });
    const chatStore = createLinkedChatStore(temp.rootPath);
    const thread = await chatStore.createThread({
      workspaceId,
      title: "Roadmap sync",
      linkedFile: { objectId: seeded.object.id, pathHint: "notes/roadmap.md" },
    });
    await chatStore.sendMessage({
      workspaceId,
      threadId: thread.id,
      author: { kind: "human", displayName: "Ice" },
      body: "Let's settle the quasar sync cadence this week.",
    });
    await chatStore.close();
    await engineStore.close();

    desktop = await launchDesktopApp({ workspace: temp });
    const page = desktop.page;
    const workspace = await openWorkspaceFromFirstRun(page, temp);
    expect(workspace.workspaceId).toBe(workspaceId);
    await waitForWorkspaceFile(page, workspaceId, "notes/roadmap.md");

    await page.getByTestId("activity-search").click();
    await expect(page.getByTestId("search-view")).toBeVisible();

    // 1. File content resolves through the engine index.
    await page.getByTestId("search-input").fill("galaxy-brain");
    await expect(
      page.locator('[data-testid="search-result-group"][data-path="notes/roadmap.md"]'),
    ).toBeVisible({ timeout: 20_000 });

    // 2. A chat message is a distinguishable result row (Chat badge + thread
    //    title instead of a file basename).
    await page.getByTestId("search-input").fill("quasar");
    const chatGroup = page
      .locator('[data-testid="search-result-group"]')
      .filter({ hasText: "Roadmap sync" });
    await expect(chatGroup).toBeVisible({ timeout: 20_000 });
    await expect(chatGroup.getByText("Chat", { exact: true })).toBeVisible();

    // 3. Clicking the chat result opens the Chats rail on that thread.
    await chatGroup.getByTestId("search-result-row").first().click();
    await expect(page.getByTestId("linked-chat-thread")).toBeVisible({
      timeout: 20_000,
    });
    await expect(page.getByTestId("linked-chat-title")).toContainText("Roadmap sync");
    await expect(page.getByTestId("linked-chat-message-body")).toContainText(
      "quasar sync cadence",
    );

    // 4. The `.env.local` content is never findable... (the search panel is
    // still open — opening the rail does not close it)
    await page.getByTestId("search-input").fill(SECRET_VALUE);
    await expect(page.getByTestId("search-empty-state")).toBeVisible({
      timeout: 20_000,
    });

    // 5. ...and ADVERSARIALLY, a raw dump of the FTS index tables in the
    //    persisted engine.db carries no secret plaintext and no .env path,
    //    while it DOES carry the tracked corpus (the dump inspects a
    //    populated index, not a missing table).
    const dump = dumpSearchIndexTables(temp.rootPath);
    expect(dump).toContain("notes/roadmap.md");
    expect(dump).toContain("quasar sync cadence");
    expect(dump).not.toContain(SECRET_VALUE);
    expect(dump).not.toContain(".env");
  } finally {
    await cleanupDesktopWorkspace(desktop, temp);
  }
});

test("unflagged: search stays on the streamed ripgrep path and still excludes .env content", async () => {
  const temp = await createTempWorkspace();
  let desktop: Awaited<ReturnType<typeof launchDesktopApp>> | null = null;

  try {
    // No engine flag: the workspace never attaches an engine capture, so the
    // searchWorkspace handler takes the ripgrep branch unchanged.
    await writeWorkspaceFiles(temp, [
      { path: "docs/guide.md", contents: "plainly-findable-needle in prose\n" },
      { path: ".env", contents: `API_TOKEN=${SECRET_VALUE}\n` },
    ]);

    desktop = await launchDesktopApp({ workspace: temp });
    const page = desktop.page;
    const workspace = await openWorkspaceFromFirstRun(page, temp);
    await waitForWorkspaceFile(page, workspace.workspaceId, "docs/guide.md");

    await page.getByTestId("activity-search").click();
    await expect(page.getByTestId("search-view")).toBeVisible();

    await page.getByTestId("search-input").fill("plainly-findable-needle");
    await expect(
      page.locator('[data-testid="search-result-group"][data-path="docs/guide.md"]'),
    ).toBeVisible({ timeout: 20_000 });

    await page.getByTestId("search-input").fill(SECRET_VALUE);
    await expect(page.getByTestId("search-empty-state")).toBeVisible({
      timeout: 20_000,
    });
  } finally {
    await cleanupDesktopWorkspace(desktop, temp);
  }
});
