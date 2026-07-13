import { expect, test } from "@playwright/test";
import { createLinkedChatStore, createVersionedTextStore } from "@dohc/workspace-engine";
import { launchDesktopApp } from "./helpers/desktopApp";
import {
  cleanupDesktopWorkspace,
  createSiblingWorkspaceDir,
  createTempWorkspace,
  explorerRow,
  openFileChatsPanel,
  openHistoryView,
  revealExplorerPath,
  seedWorkspaceManifest,
  seedWorkspaceRegistry,
  seedWorkspaceSettings,
  waitForWorkspaceReady,
  writeWorkspaceFiles,
} from "./helpers/workspace";

// PR 0M arc requirement: switching workspaces while history/chat panels are
// loading must never paint workspace A's data inside workspace B. Workspace
// A is deliberately HEAVY (1,000 engine moments + a 200-message chat, the
// perf-budget corpus) so its loads are the slow ones; B is tiny.
//
// This spec doubles as the PR 0M-5 performance evidence: it records history
// first-useful-content with 1,000 moments and the chat rail with 200
// messages.

const WORKSPACE_A_ID = "race-workspace-a";
const WORKSPACE_B_ID = "race-workspace-b";

// Locate switcher options by the actual workspace id, not by substring
// matching the rendered label (which breaks if the label format changes or
// a third workspace joins the registry).
function switcherOption(page: import("@playwright/test").Page, workspaceId: string) {
  return page
    .locator(`[data-testid="workspace-switcher-option"][data-workspace-id="${workspaceId}"]`)
    .getByRole("button");
}
const MOMENT_FILES = 250;
const EDITS_PER_FILE = 4; // 250 x 4 = 1,000 moments
const CHAT_MESSAGES = 200;

test("switching A->B while panels load never shows A's history or chats in B", async () => {
  test.setTimeout(240_000);
  const temp = await createTempWorkspace();
  const workspaceB = await createSiblingWorkspaceDir(temp, "workspace-b");
  let desktop: Awaited<ReturnType<typeof launchDesktopApp>> | null = null;

  try {
    // --- Seed workspace A: 1,000 engine moments + one 200-message chat ---
    await seedWorkspaceManifest(temp, WORKSPACE_A_ID);
    await seedWorkspaceSettings(temp, {
      experimental: { workspaceEngineAlpha: true },
    });
    const storeA = createVersionedTextStore(temp.rootPath);
    await storeA.ensureMainVersion({ workspaceId: WORKSPACE_A_ID });
    const diskWrites: Array<{ path: string; contents: string }> = [];
    let chatFileObjectId: string | null = null;
    for (let file = 0; file < MOMENT_FILES; file += 1) {
      const path = `files/doc-${String(file).padStart(3, "0")}.md`;
      let latestText = "";
      let objectId: string | null = null;
      for (let edit = 0; edit < EDITS_PER_FILE; edit += 1) {
        latestText = `# Doc ${file}\n\nrevision ${edit}\n`;
        const written = await storeA.writeTextFile({
          workspaceId: WORKSPACE_A_ID,
          versionId: "main",
          path,
          text: latestText,
          metadata: { origin: "local-file" },
        });
        objectId = written.object.id;
      }
      // Disk mirrors the engine tip so startup reconciliation is a no-op.
      diskWrites.push({ path, contents: latestText });
      if (file === 0) chatFileObjectId = objectId;
    }
    await writeWorkspaceFiles(temp, diskWrites);
    const chatStoreA = createLinkedChatStore(temp.rootPath);
    const thread = await chatStoreA.createThread({
      workspaceId: WORKSPACE_A_ID,
      title: "Doc zero deep dive",
      linkedFile: {
        objectId: chatFileObjectId ?? "",
        pathHint: "files/doc-000.md",
      },
    });
    for (let index = 0; index < CHAT_MESSAGES; index += 1) {
      await chatStoreA.sendMessage({
        workspaceId: WORKSPACE_A_ID,
        threadId: thread.id,
        author:
          index % 2 === 0
            ? { kind: "human", displayName: "Ice de Vera" }
            : { kind: "agent", displayName: "Ice de Vera" },
        body: `Message ${index} about doc zero.`,
      });
    }

    // --- Seed workspace B: one file, one moment ---
    await seedWorkspaceManifest(workspaceB, WORKSPACE_B_ID);
    await seedWorkspaceSettings(workspaceB, {
      experimental: { workspaceEngineAlpha: true },
    });
    const storeB = createVersionedTextStore(workspaceB.rootPath);
    await storeB.ensureMainVersion({ workspaceId: WORKSPACE_B_ID });
    await storeB.writeTextFile({
      workspaceId: WORKSPACE_B_ID,
      versionId: "main",
      path: "b-note.md",
      text: "workspace b only\n",
      metadata: { origin: "local-file" },
    });
    await writeWorkspaceFiles(workspaceB, [
      { path: "b-note.md", contents: "workspace b only\n" },
    ]);

    await seedWorkspaceRegistry(temp, [
      { workspaceId: WORKSPACE_A_ID, rootPath: temp.rootPath },
      { workspaceId: WORKSPACE_B_ID, rootPath: workspaceB.rootPath },
    ]);

    desktop = await launchDesktopApp({ workspace: temp });
    const page = desktop.page;
    await waitForWorkspaceReady(page);

    // --- Perf evidence: history first useful content with 1,000 moments ---
    // History lives in the left History view now (the right panel is Chats);
    // the measurement includes opening the view.
    const historyStart = Date.now();
    await openHistoryView(page);
    await expect(
      page.getByTestId("engine-moment").first(),
    ).toBeVisible();
    const historyFirstContentMs = Date.now() - historyStart;
    const ipcTiming = await page.evaluate(async ({ id }) => {
      const api = (window as unknown as {
        dohcDesktop: {
          listEngineMoments(payload: {
            workspaceId: string;
            limit: number;
          }): Promise<{ moments: unknown[]; latestMomentOrder: number }>;
        };
      }).dohcDesktop;
      const start = performance.now();
      const pageResult = await api.listEngineMoments({ workspaceId: id, limit: 200 });
      return {
        ms: performance.now() - start,
        momentCount: pageResult.moments.length,
        latestMomentOrder: pageResult.latestMomentOrder,
      };
    }, { id: WORKSPACE_A_ID });
    expect(ipcTiming.latestMomentOrder).toBeGreaterThanOrEqual(999);
    console.log(
      `[perf] history first useful content (1,000 moments): shell-ready->first row ${historyFirstContentMs}ms; ` +
        `listEngineMoments(limit 200) IPC round-trip ${ipcTiming.ms.toFixed(1)}ms`,
    );
    // Budget: first useful content under 500ms.
    expect(ipcTiming.ms).toBeLessThan(500);

    // --- Perf evidence: chats panel with 200 messages ---
    await page.getByTestId("activity-explorer").click();
    await revealExplorerPath(page, "files/doc-000.md");
    await explorerRow(page, "files/doc-000.md").click();
    const chatStart = Date.now();
    await openFileChatsPanel(page);
    await page.getByTestId("linked-chat-open").click();
    await expect(page.getByTestId("linked-chat-message")).toHaveCount(CHAT_MESSAGES);
    const chatOpenMs = Date.now() - chatStart;
    console.log(
      `[perf] chats panel open with ${CHAT_MESSAGES} messages: ${chatOpenMs}ms to all messages rendered`,
    );

    // --- The race: switch to B while A's heavy surfaces are (re)loading ---
    // Kick a fresh paint of A's big history view (the chats panel is already
    // live), then switch immediately without awaiting it.
    await openHistoryView(page);
    await page.getByTestId("workspace-switcher").click();
    await switcherOption(page, WORKSPACE_B_ID).click();
    await waitForWorkspaceReady(page);

    // B's shell renders B's history...
    await openHistoryView(page);
    await expect(
      page.locator(
        '[data-testid="engine-moment-open"][data-moment-path="b-note.md"]',
      ),
    ).toBeVisible();
    // ...and NEVER any of A's moments or chats.
    await expect(
      page.locator('[data-testid="engine-moment-open"][data-moment-path^="files/doc-"]'),
    ).toHaveCount(0);
    // An instantaneous empty check alone could pass while a stale A response
    // is still in flight; give any straggler time to land, then re-assert
    // the shell stayed clean.
    await page.waitForTimeout(750);
    await expect(
      page.locator('[data-testid="engine-moment-open"][data-moment-path^="files/doc-"]'),
    ).toHaveCount(0);
    await page.getByTestId("activity-explorer").click();
    await revealExplorerPath(page, "b-note.md");
    await explorerRow(page, "b-note.md").click();
    await openFileChatsPanel(page);
    await expect(page.getByTestId("linked-chats-empty")).toContainText(
      "No chats about this file yet.",
    );
    await expect(page.getByText("Doc zero deep dive")).toHaveCount(0);

    // Switch back: A's data is intact and B's never leaked into it.
    await page.getByTestId("workspace-switcher").click();
    await switcherOption(page, WORKSPACE_A_ID).click();
    await waitForWorkspaceReady(page);
    await openHistoryView(page);
    await expect(
      page.locator('[data-testid="engine-moment-open"][data-moment-path^="files/doc-"]').first(),
    ).toBeVisible();
    await expect(
      page.locator('[data-testid="engine-moment-open"][data-moment-path="b-note.md"]'),
    ).toHaveCount(0);
  } finally {
    await cleanupDesktopWorkspace(desktop, temp);
  }
});
