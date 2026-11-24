import { expect, test, type Locator, type Page } from "@playwright/test";
import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { executeCli } from "@dohc/cli";
import type { DohcDesktopBridge } from "../src/ipc/bridgeContract";
import { waitForVisibleAnimations } from "./helpers/animations";
import { launchDesktopApp, type LaunchedDesktopApp } from "./helpers/desktopApp";
import {
  cleanupDesktopWorkspace,
  createTempWorkspace,
  openWorkspaceFromFirstRun,
  showExplorerFiles,
  writeWorkspaceFiles,
  type TempWorkspace,
} from "./helpers/workspace";

const SHOT_DIR = process.env.PR3_SHOT_DIR ?? "";

async function setTheme(page: Page, theme: "light" | "dark"): Promise<void> {
  await page.evaluate(async (value) => {
    document.documentElement.setAttribute("data-theme", value);
    void getComputedStyle(document.body).backgroundColor;
    await document.fonts.ready;
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  }, theme);
  await waitForVisibleAnimations(page);
}

async function shoot(page: Page, target: Locator, name: string): Promise<void> {
  if (SHOT_DIR === "") return;
  await mkdir(SHOT_DIR, { recursive: true });
  await page.mouse.move(0, 0);
  for (const theme of ["light", "dark"] as const) {
    await setTheme(page, theme);
    await target.screenshot({ path: join(SHOT_DIR, `${name}-${theme}.png`) });
  }
  await setTheme(page, "light");
}

async function openInboxCollection(page: Page): Promise<void> {
  await showExplorerFiles(page);
  const inboxRow = page.locator('[data-testid="tree-row"][data-path="Inbox"]');
  await expect(inboxRow).toBeVisible({ timeout: 60_000 });
  await inboxRow.click();
  await expect(page.getByTestId("collection-page")).toBeVisible({ timeout: 60_000 });
}

test.describe("Workspace Inbox & drop-anything-in triage", () => {
  let app: LaunchedDesktopApp | undefined;
  let workspace: TempWorkspace | undefined;
  let dropSource: TempWorkspace | undefined;

  test.afterEach(async () => {
    if (workspace) {
      await cleanupDesktopWorkspace(app, workspace);
      app = undefined;
      workspace = undefined;
    } else if (app) {
      await app.close();
      app = undefined;
    }
    if (dropSource) {
      await rm(dropSource.baseDir, { recursive: true, force: true }).catch(() => undefined);
      dropSource = undefined;
    }
  });

  test("lazy creation, Quick Capture, secret-screened drop, Archive/Move + Undo, CLI parity, and restart persistence", async () => {
    workspace = await createTempWorkspace();
    dropSource = await createTempWorkspace();
    await writeWorkspaceFiles(workspace, [
      { path: "Projects/readme.md", contents: "# Projects\n" },
    ]);

    const receiptFile = join(dropSource.rootPath, "coffee-receipt.txt");
    const envFile = join(dropSource.rootPath, ".env");
    await writeFile(receiptFile, "Espresso $4.50\n", "utf8");
    await writeFile(envFile, "SECRET_TOKEN=never-copy-into-inbox\n", "utf8");

    app = await launchDesktopApp({ workspace });
    let page = app.page;
    await openWorkspaceFromFirstRun(page, workspace);
    await showExplorerFiles(page);

    // 1. Inbox/ must NOT exist before the first capture.
    await expect(stat(join(workspace.rootPath, "Inbox"))).rejects.toThrow();

    // 2. Open Quick Capture via Ctrl+Shift+N (or Meta+Shift+N on macOS).
    await page.keyboard.press(process.platform === "darwin" ? "Meta+Shift+N" : "Control+Shift+N");
    const dialog = page.getByTestId("quick-capture-dialog");
    await expect(dialog).toBeVisible({ timeout: 15_000 });
    await dialog.getByLabel("Title").fill("Q4 Travel Receipt");
    await dialog.getByLabel("Link").fill("https://example.com/receipts/q4");
    await dialog.getByLabel("Note").fill("Submitted for reimbursement.");
    await shoot(page, dialog, "quick-capture-dialog");
    await dialog.getByRole("button", { name: "Capture", exact: true }).click();
    await expect(dialog).toBeHidden({ timeout: 15_000 });

    // Inbox/collection.yaml and the captured note exist on disk.
    await expect(
      readFile(join(workspace.rootPath, "Inbox", "collection.yaml"), "utf8"),
    ).resolves.toContain("name: Inbox");
    const inboxEntries = await readdir(join(workspace.rootPath, "Inbox"));
    const capturedNoteName = inboxEntries.find((name) => name.includes("q4-travel-receipt"));
    expect(capturedNoteName).toBeTruthy();

    // 3. Open Inbox Collection and verify the captured record renders cleanly in both themes.
    await openInboxCollection(page);
    const collectionPage = page.getByTestId("collection-page");
    await expect(
      collectionPage.getByRole("button", { name: "Q4 Travel Receipt", exact: true }),
    ).toBeVisible({ timeout: 30_000 });
    await shoot(page, collectionPage, "inbox-collection");

    // 4. Capture dropped files (normal receipt + .env secret): .env is skipped, receipt lands in Inbox/files/.
    const workspaceId = await page.evaluate(async () => {
      const bridge = (window as unknown as { dohcDesktop: DohcDesktopBridge }).dohcDesktop;
      const registry = await bridge.getWorkspaceRegistry();
      return registry.workspaces[0]!.workspaceId;
    });
    const dropOutcome = await page.evaluate(
      async ({ wsId, paths }) => {
        const bridge = (window as unknown as { dohcDesktop: DohcDesktopBridge }).dohcDesktop;
        return bridge.inboxCaptureFiles({ workspaceId: wsId, droppedPaths: paths });
      },
      { wsId: workspaceId, paths: [receiptFile, envFile] },
    );
    expect(dropOutcome.items).toHaveLength(1);
    expect(dropOutcome.skipped).toBe(1);
    expect(dropOutcome.skippedSources).toEqual([{ name: ".env", reason: "secret-file" }]);
    await expect(
      readFile(join(workspace.rootPath, "Inbox", "files", "coffee-receipt.txt"), "utf8"),
    ).resolves.toBe("Espresso $4.50\n");
    await expect(stat(join(workspace.rootPath, "Inbox", "files", ".env"))).rejects.toThrow();

    // 5. Open the captured record in RecordPanel -> Archive -> verify persisted -> Undo -> back to New.
    await collectionPage
      .getByRole("button", { name: "Open Q4 Travel Receipt", exact: true })
      .click();
    const triageActions = page.getByTestId("inbox-triage-actions");
    await expect(triageActions).toBeVisible({ timeout: 15_000 });
    await shoot(page, collectionPage, "inbox-record-triage");

    await triageActions.getByRole("button", { name: "Archive", exact: true }).click();
    const noteAbs = join(workspace.rootPath, "Inbox", capturedNoteName!);
    await expect
      .poll(() => readFile(noteAbs, "utf8"), { timeout: 15_000 })
      .toContain("Status: Archived");

    const undoArchiveButton = page
      .getByRole("status")
      .filter({ hasText: 'Archived "Q4 Travel Receipt"' })
      .getByRole("button", { name: "Undo", exact: true });
    await expect(undoArchiveButton).toBeVisible({ timeout: 10_000 });
    await undoArchiveButton.click();
    await expect
      .poll(() => readFile(noteAbs, "utf8"), { timeout: 15_000 })
      .toContain("Status: New");

    // 6. Move to folder… -> Projects -> verify file moved -> Undo -> back in Inbox!
    await triageActions.getByRole("button", { name: "Move to folder…" }).click();
    const moveDialog = page.getByTestId("move-inbox-dialog");
    await expect(moveDialog).toBeVisible({ timeout: 15_000 });
    await moveDialog.getByRole("option", { name: "Projects", exact: true }).click();
    await shoot(page, moveDialog, "move-inbox-dialog");
    await moveDialog.getByRole("button", { name: "Move", exact: true }).click();
    await expect(moveDialog).toBeHidden({ timeout: 15_000 });

    const movedAbs = join(workspace.rootPath, "Projects", capturedNoteName!);
    await expect
      .poll(() => readFile(movedAbs, "utf8").catch(() => ""), { timeout: 15_000 })
      .toContain("Q4 Travel Receipt");

    const undoMoveButton = page
      .getByRole("status")
      .filter({ hasText: "Moved to Projects" })
      .getByRole("button", { name: "Undo", exact: true });
    await expect(undoMoveButton).toBeVisible({ timeout: 10_000 });
    await undoMoveButton.click();
    await expect
      .poll(() => readFile(noteAbs, "utf8").catch(() => ""), { timeout: 15_000 })
      .toContain("Q4 Travel Receipt");

    // 6b. Move the attachment-backed coffee-receipt item to Projects -> verify attachment moves + link rewrites -> Undo restores both and original files/ link!
    const receiptNotePath = dropOutcome.items[0]!.path;
    const receiptNoteName = receiptNotePath.split("/").at(-1)!;
    const receiptNoteInInboxAbs = join(workspace.rootPath, receiptNotePath);
    const receiptNoteInProjectsAbs = join(workspace.rootPath, "Projects", receiptNoteName);
    const receiptAttInInboxAbs = join(workspace.rootPath, "Inbox", "files", "coffee-receipt.txt");
    const receiptAttInProjectsAbs = join(workspace.rootPath, "Projects", "coffee-receipt.txt");

    await collectionPage.getByRole("button", { name: "Open coffee-receipt", exact: true }).click();
    await expect(triageActions).toBeVisible({ timeout: 15_000 });
    await triageActions.getByRole("button", { name: "Move to folder…" }).click();
    await expect(moveDialog).toBeVisible({ timeout: 15_000 });
    await moveDialog.getByRole("option", { name: "Projects", exact: true }).click();
    await moveDialog.getByRole("button", { name: "Move", exact: true }).click();
    await expect(moveDialog).toBeHidden({ timeout: 15_000 });

    await expect
      .poll(() => readFile(receiptAttInProjectsAbs, "utf8").catch(() => ""), { timeout: 15_000 })
      .toBe("Espresso $4.50\n");
    await expect
      .poll(() => readFile(receiptNoteInProjectsAbs, "utf8").catch(() => ""), { timeout: 15_000 })
      .toContain("[coffee-receipt.txt](coffee-receipt.txt)");
    await expect(readFile(receiptNoteInProjectsAbs, "utf8")).resolves.toContain(
      "Attachment: Projects/coffee-receipt.txt",
    );

    const undoReceiptMove = page
      .getByRole("status")
      .filter({ hasText: "Moved to Projects" })
      .getByRole("button", { name: "Undo", exact: true })
      .last();
    await expect(undoReceiptMove).toBeVisible({ timeout: 10_000 });
    await undoReceiptMove.click();
    await expect
      .poll(() => readFile(receiptAttInInboxAbs, "utf8").catch(() => ""), { timeout: 15_000 })
      .toBe("Espresso $4.50\n");
    await expect
      .poll(() => readFile(receiptNoteInInboxAbs, "utf8").catch(() => ""), { timeout: 15_000 })
      .toContain("[coffee-receipt.txt](files/coffee-receipt.txt)");

    // 7. CLI parity against the live desktop app socket: dohc inbox add + dohc inbox list.
    const cliClient = { stateDir: workspace.homeDir };
    const cliAdd = await executeCli({
      argv: ["inbox", "add", "--title", "From CLI", "Captured over live socket", "--json"],
      cwd: workspace.rootPath,
      client: cliClient,
    });
    expect(cliAdd.exitCode).toBe(0);
    const cliList = await executeCli({
      argv: ["inbox", "list", "--json"],
      cwd: workspace.rootPath,
      client: cliClient,
    });
    expect(cliList.exitCode).toBe(0);
    expect(JSON.parse(cliList.stdout)).toMatchObject({
      exists: true,
      items: expect.arrayContaining([
        expect.objectContaining({ title: "From CLI", source: "cli", status: "New" }),
      ]),
    });

    // 8. Restart the app and confirm Inbox items persist cleanly.
    await app.close();
    app = await launchDesktopApp({ workspace });
    page = app.page;
    await openInboxCollection(page);
    const restartedCollectionPage = page.getByTestId("collection-page");
    await expect(
      restartedCollectionPage.getByRole("button", { name: "Q4 Travel Receipt", exact: true }),
    ).toBeVisible({ timeout: 30_000 });
    await expect(
      restartedCollectionPage.getByRole("button", { name: "From CLI", exact: true }),
    ).toBeVisible({ timeout: 30_000 });
  });
});
