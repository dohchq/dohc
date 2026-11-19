import { expect, test } from "@playwright/test";
import { createRequire } from "node:module";
import { open, stat } from "node:fs/promises";
import { join } from "node:path";
import { launchDesktopApp } from "./helpers/desktopApp";
import {
  cleanupDesktopWorkspace,
  createTempWorkspace,
  explorerRow,
  openWorkspaceFromFirstRun,
  waitForWorkspaceFile,
  writeWorkspaceFiles,
} from "./helpers/workspace";

const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as {
  DatabaseSync: new (path: string) => {
    exec(sql: string): void;
    prepare(sql: string): { get(): Record<string, unknown> | undefined };
    close(): void;
  };
};

async function damageOnePage(store: string): Promise<void> {
  const db = new DatabaseSync(store);
  db.exec("CREATE TABLE unread_pages (value); INSERT INTO unread_pages VALUES (1);");
  const rootPage = Number(
    db.prepare("SELECT rootpage FROM sqlite_schema WHERE name = 'unread_pages'").get()?.rootpage,
  );
  const pageSize = Number(db.prepare("PRAGMA page_size").get()?.page_size);
  db.close();
  const file = await open(store, "r+");
  try {
    await file.write(Buffer.from([0]), 0, 1, (rootPage - 1) * pageSize);
    await file.sync();
  } finally {
    await file.close();
  }
}

test("@damaged-store a damaged data store is named and Rebuild brings the workspace back", async () => {
  test.setTimeout(240_000);
  const workspace = await createTempWorkspace();
  let desktop: Awaited<ReturnType<typeof launchDesktopApp>> | null = null;
  try {
    await writeWorkspaceFiles(workspace, [{ path: "kept.md", contents: "# Kept\n\nStill here.\n" }]);
    desktop = await launchDesktopApp({ workspace });
    const opened = await openWorkspaceFromFirstRun(desktop.page, workspace);
    await waitForWorkspaceFile(desktop.page, opened.workspaceId, "kept.md");
    await desktop.close();
    desktop = null;

    const store = join(workspace.rootPath, ".dohc", "engine", "engine.db");
    await damageOnePage(store);

    desktop = await launchDesktopApp({ workspace });
    const { page } = desktop;
    await openWorkspaceFromFirstRun(page, workspace);
    await page.getByTestId("notice-center-toggle").click();
    const notices = page.getByRole("dialog", { name: "Notices", exact: true });
    await expect(notices.getByText("This workspace's data store is damaged.")).toBeVisible({
      timeout: 60_000,
    });
    await page.screenshot({ path: test.info().outputPath("damaged-store-notice.png") });
    await notices.getByRole("button", { name: "Rebuild", exact: true }).click();

    const rebuild = page.getByTestId("engine-rebuild-dialog");
    await expect(rebuild).toContainText("This workspace's data store is damaged.");
    await rebuild.getByTestId("engine-rebuild-confirm").click();
    await expect(rebuild).toContainText("Data store moved", { timeout: 60_000 });
    await rebuild.getByRole("button", { name: "Done", exact: true }).click();
    await stat(join(workspace.rootPath, ".dohc", "engine", "pre-v2-backup", "engine.db"));

    await waitForWorkspaceFile(page, opened.workspaceId, "kept.md");
    await explorerRow(page, "kept.md").click();
    await expect(page.getByTestId("markdown-editor")).toContainText("Still here.");
    await page.getByTestId("notice-center-toggle").click();
    await expect(
      page
        .getByRole("dialog", { name: "Notices", exact: true })
        .getByText("This workspace's data store is damaged."),
    ).toHaveCount(0);
    expect(desktop.logs.filter((entry) => entry.level === "pageerror")).toEqual([]);
  } finally {
    await cleanupDesktopWorkspace(desktop, workspace);
  }
});
