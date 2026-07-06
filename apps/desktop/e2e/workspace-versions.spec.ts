import { expect, test, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import { launchDesktopApp } from "./helpers/desktopApp";
import {
  cleanupDesktopWorkspace,
  createTempWorkspace,
  openWorkspaceFromFirstRun,
  seedWorkspaceSettings,
  writeWorkspaceFiles,
} from "./helpers/workspace";

// PR 0M-4 — THE WEDGE DEMO AS A TEST. A user creates a named version, edits
// in it, switches between versions (disk content swaps), compares, and merges
// back into Main — all through the product UI, zero git vocabulary. Engine
// assertions read the persisted engine.db directly (WAL mode makes a
// read-only cross-process connection safe while the app holds the database).

const requireModule = createRequire(import.meta.url);
const { DatabaseSync } = requireModule("node:sqlite") as {
  DatabaseSync: new (
    path: string,
    options?: { readOnly?: boolean },
  ) => {
    prepare(sql: string): {
      all(...params: unknown[]): Array<Record<string, unknown>>;
      get(...params: unknown[]): Record<string, unknown> | undefined;
    };
    close(): void;
  };
};

function withEngineDb<T>(rootPath: string, read: (db: InstanceType<typeof DatabaseSync>) => T): T | null {
  let db: InstanceType<typeof DatabaseSync>;
  try {
    db = new DatabaseSync(join(rootPath, ".dohc/engine/engine.db"), {
      readOnly: true,
    });
  } catch {
    // engine.db may not exist yet while the app is still opening.
    return null;
  }
  try {
    return read(db);
  } finally {
    db.close();
  }
}

function engineVersionIdByName(rootPath: string, name: string): string | null {
  return withEngineDb(rootPath, (db) => {
    const row = db
      .prepare("SELECT version_id FROM versions WHERE name = ?")
      .get(name);
    return row ? String(row.version_id) : null;
  });
}

function engineSnapshotText(
  rootPath: string,
  versionId: string,
  path: string,
): string | null {
  return withEngineDb(rootPath, (db) => {
    const row = db
      .prepare(
        `SELECT b.text AS text
         FROM snapshots s JOIN blobs b ON b.sha256 = s.blob_sha256
         WHERE s.version_id = ? AND s.path = ?`,
      )
      .get(versionId, path);
    return row ? String(row.text) : null;
  });
}

function engineSnapshotBytes(
  rootPath: string,
  versionId: string,
  path: string,
): Buffer | null {
  return withEngineDb(rootPath, (db) => {
    const row = db
      .prepare(
        `SELECT bb.content AS content
         FROM snapshots s JOIN binary_blobs bb ON bb.sha256 = s.blob_sha256
         WHERE s.version_id = ? AND s.path = ?`,
      )
      .get(versionId, path);
    return row ? Buffer.from(row.content as Uint8Array) : null;
  });
}

async function readWorkspaceText(rootPath: string, path: string): Promise<string | null> {
  try {
    return await readFile(join(rootPath, path), "utf8");
  } catch {
    return null;
  }
}

async function readWorkspaceBytes(rootPath: string, path: string): Promise<Buffer | null> {
  try {
    return await readFile(join(rootPath, path));
  } catch {
    return null;
  }
}

async function openVersionMenu(page: Page): Promise<void> {
  const button = page.getByTestId("version-menu-button");
  await expect(button).toBeEnabled();
  await button.click();
  await expect(page.getByTestId("version-menu")).toBeVisible();
}

async function expectActiveVersion(page: Page, name: string): Promise<void> {
  await expect(page.getByTestId("version-menu-active")).toHaveText(name, {
    timeout: 20_000,
  });
  await expect(page.getByTestId("version-menu-button")).toBeEnabled();
}

async function createVersionViaMenu(page: Page, name: string): Promise<void> {
  await openVersionMenu(page);
  await page.getByTestId("version-new").click();
  await page.getByTestId("version-new-input").fill(name);
  await page.getByTestId("version-new-input").press("Enter");
  await expectActiveVersion(page, name);
}

async function switchVersionViaMenu(page: Page, name: string): Promise<void> {
  await openVersionMenu(page);
  await page
    .locator(`[data-testid="version-item"][data-version-name="${name}"]`)
    .click();
  await expectActiveVersion(page, name);
}

test("the wedge: create a version, edit in it, switch, and merge back to Main", async () => {
  const temp = await createTempWorkspace();
  let desktop: Awaited<ReturnType<typeof launchDesktopApp>> | null = null;

  try {
    await seedWorkspaceSettings(temp, {
      experimental: { workspaceEngineAlpha: true },
    });
    await writeWorkspaceFiles(temp, [{ path: "plan.md", contents: "v1 text\n" }]);

    desktop = await launchDesktopApp({ workspace: temp });
    const page = desktop.page;
    await openWorkspaceFromFirstRun(page, temp);

    // The selector shows Main by default for a flagged workspace.
    await expectActiveVersion(page, "Main");

    // 1. Create "Draft" through the UI — it becomes the working version.
    await createVersionViaMenu(page, "Draft");
    const draftId = engineVersionIdByName(temp.rootPath, "Draft");
    expect(draftId).not.toBeNull();

    // 2. Edit plan.md on disk while Draft is active — the watcher captures
    //    the edit into Draft (not Main).
    await writeWorkspaceFiles(temp, [
      { path: "plan.md", contents: "draft text\n" },
    ]);
    await expect
      .poll(
        () => engineSnapshotText(temp.rootPath, draftId ?? "", "plan.md"),
        { timeout: 30_000 },
      )
      .toBe("draft text\n");
    expect(engineSnapshotText(temp.rootPath, "main", "plan.md")).toBe("v1 text\n");

    // 3. Switch to Main — the folder shows Main's content again.
    await switchVersionViaMenu(page, "Main");
    await expect
      .poll(() => readWorkspaceText(temp.rootPath, "plan.md"), { timeout: 20_000 })
      .toBe("v1 text\n");

    // 4. Switch back to Draft — the draft edit returns.
    await switchVersionViaMenu(page, "Draft");
    await expect
      .poll(() => readWorkspaceText(temp.rootPath, "plan.md"), { timeout: 20_000 })
      .toBe("draft text\n");

    // 5. Compare with Main shows the one changed file.
    await openVersionMenu(page);
    await page.getByTestId("version-compare").click();
    await expect(page.getByTestId("version-compare-page")).toBeVisible();
    await expect(
      page.locator('[data-testid="version-compare-file"][data-compare-path="plan.md"]'),
    ).toBeVisible({ timeout: 20_000 });

    // 6. Merge Draft into Main (clean) — Main now has the draft text.
    await openVersionMenu(page);
    await page.getByTestId("version-merge").click();
    await expect(page.getByTestId("version-merge-dialog")).toBeVisible();
    await page.getByTestId("version-merge-confirm").click();
    await expect(page.getByTestId("version-merge-status")).toHaveText(
      /Merged 1 file into Main/,
      { timeout: 30_000 },
    );
    await page.getByTestId("version-merge-done").click();
    expect(engineSnapshotText(temp.rootPath, "main", "plan.md")).toBe(
      "draft text\n",
    );

    // Switching to Main shows the merged content on disk.
    await switchVersionViaMenu(page, "Main");
    await expect
      .poll(() => readWorkspaceText(temp.rootPath, "plan.md"), { timeout: 20_000 })
      .toBe("draft text\n");
  } finally {
    await cleanupDesktopWorkspace(desktop, temp);
  }
});

test("conflicting edits surface a calm conflict panel and keep-this-side resolves it", async () => {
  const temp = await createTempWorkspace();
  let desktop: Awaited<ReturnType<typeof launchDesktopApp>> | null = null;

  try {
    await seedWorkspaceSettings(temp, {
      experimental: { workspaceEngineAlpha: true },
    });
    await writeWorkspaceFiles(temp, [
      { path: "notes.md", contents: "base line\n" },
    ]);

    desktop = await launchDesktopApp({ workspace: temp });
    const page = desktop.page;
    await openWorkspaceFromFirstRun(page, temp);
    await expectActiveVersion(page, "Main");

    // Make sure the base content is captured into Main before forking so the
    // fork point (and later three-way merge base) is "base line".
    await expect
      .poll(() => engineSnapshotText(temp.rootPath, "main", "notes.md"), {
        timeout: 30_000,
      })
      .toBe("base line\n");

    // Fork "Feature" and change the file there...
    await createVersionViaMenu(page, "Feature");
    await writeWorkspaceFiles(temp, [
      { path: "notes.md", contents: "feature side\n" },
    ]);
    const featureId = engineVersionIdByName(temp.rootPath, "Feature");
    expect(featureId).not.toBeNull();
    await expect
      .poll(
        () => engineSnapshotText(temp.rootPath, featureId ?? "", "notes.md"),
        { timeout: 30_000 },
      )
      .toBe("feature side\n");

    // ...then change the SAME file differently on Main.
    await switchVersionViaMenu(page, "Main");
    await writeWorkspaceFiles(temp, [
      { path: "notes.md", contents: "main side\n" },
    ]);
    await expect
      .poll(() => engineSnapshotText(temp.rootPath, "main", "notes.md"), {
        timeout: 30_000,
      })
      .toBe("main side\n");

    // Merging Feature into Main surfaces the conflict panel — both sides
    // shown in full, no raw markers anywhere.
    await switchVersionViaMenu(page, "Feature");
    await openVersionMenu(page);
    await page.getByTestId("version-merge").click();
    await page.getByTestId("version-merge-confirm").click();
    const conflict = page.locator(
      '[data-testid="version-conflict"][data-conflict-path="notes.md"]',
    );
    await expect(conflict).toBeVisible({ timeout: 30_000 });
    await expect(conflict).toContainText("main side");
    await expect(conflict).toContainText("feature side");
    const dialogText = await page
      .getByTestId("version-merge-dialog")
      .textContent();
    expect(dialogText ?? "").not.toContain("<<<<<<<");

    // Keep Feature's copy — Main resolves to the incoming side.
    await conflict.getByTestId("version-conflict-keep-incoming").click();
    await expect(page.getByTestId("version-merge-status")).toHaveText(
      /All conflicts are resolved/,
      { timeout: 30_000 },
    );
    await page.getByTestId("version-merge-done").click();

    // Engine and disk agree: Main's tip holds the feature side, and once Main
    // is active the folder shows it too.
    expect(engineSnapshotText(temp.rootPath, "main", "notes.md")).toBe(
      "feature side\n",
    );
    await switchVersionViaMenu(page, "Main");
    await expect
      .poll(() => readWorkspaceText(temp.rootPath, "notes.md"), { timeout: 20_000 })
      .toBe("feature side\n");
  } finally {
    await cleanupDesktopWorkspace(desktop, temp);
  }
});

test("binary assets switch byte-exactly and binary conflicts resolve by side", async () => {
  const temp = await createTempWorkspace();
  let desktop: Awaited<ReturnType<typeof launchDesktopApp>> | null = null;

  try {
    await seedWorkspaceSettings(temp, {
      experimental: { workspaceEngineAlpha: true },
    });
    const mainBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]);
    const draftBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0xff, 0x02]);
    const mainConflictBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0xaa]);
    const draftConflictBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0xbb]);
    await writeWorkspaceFiles(temp, [{ path: "logo.png", contents: mainBytes }]);

    desktop = await launchDesktopApp({ workspace: temp });
    const page = desktop.page;
    await openWorkspaceFromFirstRun(page, temp);
    await expectActiveVersion(page, "Main");
    await expect
      .poll(() => readWorkspaceBytes(temp.rootPath, "logo.png"), { timeout: 30_000 })
      .toEqual(mainBytes);

    await createVersionViaMenu(page, "Binary Draft");
    await writeWorkspaceFiles(temp, [{ path: "logo.png", contents: draftBytes }]);
    const draftId = engineVersionIdByName(temp.rootPath, "Binary Draft");
    expect(draftId).not.toBeNull();

    await switchVersionViaMenu(page, "Main");
    await expect
      .poll(() => readWorkspaceBytes(temp.rootPath, "logo.png"), { timeout: 20_000 })
      .toEqual(mainBytes);
    await switchVersionViaMenu(page, "Binary Draft");
    await expect
      .poll(() => readWorkspaceBytes(temp.rootPath, "logo.png"), { timeout: 20_000 })
      .toEqual(draftBytes);

    await switchVersionViaMenu(page, "Main");
    await writeWorkspaceFiles(temp, [{ path: "logo.png", contents: mainConflictBytes }]);
    await expect
      .poll(() => readWorkspaceBytes(temp.rootPath, "logo.png"), { timeout: 20_000 })
      .toEqual(mainConflictBytes);
    await switchVersionViaMenu(page, "Binary Draft");
    await writeWorkspaceFiles(temp, [{ path: "logo.png", contents: draftConflictBytes }]);

    await openVersionMenu(page);
    await page.getByTestId("version-merge").click();
    await page.getByTestId("version-merge-confirm").click();
    const conflict = page.locator(
      '[data-testid="version-conflict"][data-conflict-path="logo.png"]',
    );
    await expect(conflict.getByTestId("version-conflict-binary")).toBeVisible({
      timeout: 30_000,
    });
    await expect(conflict.getByTestId("version-conflict-combine")).toHaveCount(0);
    await conflict.getByTestId("version-conflict-keep-incoming").click();
    await expect(page.getByTestId("version-merge-status")).toHaveText(
      /All conflicts are resolved/,
      { timeout: 30_000 },
    );
    await page.getByTestId("version-merge-done").click();
    await switchVersionViaMenu(page, "Main");
    await expect
      .poll(() => readWorkspaceBytes(temp.rootPath, "logo.png"), { timeout: 20_000 })
      .toEqual(draftConflictBytes);

    // Second round resolves the OTHER way — "keep mine" must keep Main's
    // bytes, guarding against both buttons being wired to the same side.
    const mainKeepBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0xcc, 0x01]);
    const draftKeepBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0xdd, 0x02]);
    await writeWorkspaceFiles(temp, [{ path: "logo.png", contents: mainKeepBytes }]);
    await expect
      .poll(() => readWorkspaceBytes(temp.rootPath, "logo.png"), { timeout: 20_000 })
      .toEqual(mainKeepBytes);
    await switchVersionViaMenu(page, "Binary Draft");
    await writeWorkspaceFiles(temp, [{ path: "logo.png", contents: draftKeepBytes }]);

    await openVersionMenu(page);
    await page.getByTestId("version-merge").click();
    await page.getByTestId("version-merge-confirm").click();
    const keepMineConflict = page.locator(
      '[data-testid="version-conflict"][data-conflict-path="logo.png"]',
    );
    await expect(keepMineConflict.getByTestId("version-conflict-binary")).toBeVisible({
      timeout: 30_000,
    });
    await keepMineConflict.getByTestId("version-conflict-keep-current").click();
    await expect(page.getByTestId("version-merge-status")).toHaveText(
      /All conflicts are resolved/,
      { timeout: 30_000 },
    );
    await page.getByTestId("version-merge-done").click();

    // Main's side won: its tip and folder hold mainKeepBytes, byte for byte.
    expect(engineSnapshotBytes(temp.rootPath, "main", "logo.png")).toEqual(mainKeepBytes);
    await switchVersionViaMenu(page, "Main");
    await expect
      .poll(() => readWorkspaceBytes(temp.rootPath, "logo.png"), { timeout: 20_000 })
      .toEqual(mainKeepBytes);
  } finally {
    await cleanupDesktopWorkspace(desktop, temp);
  }
});

// WS-H1 flag flip: versions are on by default; only an explicit opt-out
// hides the surface (and gates the IPC in main).
test("an explicitly opted-out workspace never shows the versions surface", async () => {
  const temp = await createTempWorkspace();
  let desktop: Awaited<ReturnType<typeof launchDesktopApp>> | null = null;

  try {
    await writeWorkspaceFiles(temp, [{ path: "plain.md", contents: "hello\n" }]);
    await seedWorkspaceSettings(temp, {
      experimental: { workspaceEngineAlpha: false },
    });
    desktop = await launchDesktopApp({ workspace: temp });
    const page = desktop.page;
    const workspace = await openWorkspaceFromFirstRun(page, temp);

    await expect(page.getByTestId("workspace-shell")).toBeVisible();
    await expect(page.getByTestId("version-menu-button")).toHaveCount(0);

    // The IPC surface is gated in main, not just hidden in the renderer.
    const rejection = await page.evaluate(async (workspaceId) => {
      const api = (window as unknown as {
        dohcDesktop: {
          listWorkspaceVersions(payload: { workspaceId: string }): Promise<unknown>;
        };
      }).dohcDesktop;
      try {
        await api.listWorkspaceVersions({ workspaceId });
        return null;
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      }
    }, workspace.workspaceId);
    expect(rejection).toContain("Versions are not enabled");

    // PR 0N-2: the try-in-version gesture is gated by the same flag.
    const tryRejection = await page.evaluate(async (workspaceId) => {
      const api = (window as unknown as {
        dohcDesktop: {
          tryInWorkspaceVersion(payload: {
            workspaceId: string;
            task: string;
          }): Promise<unknown>;
        };
      }).dohcDesktop;
      try {
        await api.tryInWorkspaceVersion({ workspaceId, task: "tidy notes" });
        return null;
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      }
    }, workspace.workspaceId);
    expect(tryRejection).toContain("Versions are not enabled");
  } finally {
    await cleanupDesktopWorkspace(desktop, temp);
  }
});
