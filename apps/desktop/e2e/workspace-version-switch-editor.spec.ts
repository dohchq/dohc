import { expect, test, type Page } from "@playwright/test";
import { DOCUMENT_END } from "./helpers/keys";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
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

// The version-switch-while-open re-bind. switchVersion settles and closes
// every live engine Y.Doc session before materializing, and the open editor
// must re-bind too, or it keeps showing the old version's live doc.
// useEngineDoc keys on the active version
// (the shell's versionEpoch), so a switch flushes+reopens the session against
// the now-active version's Y.Doc lineage — resume-never-reseed for a replicated
// doc, reseed-from-the-freshly-materialized-file for a local-only doc. This
// spec opens a rich doc, edits it in a version, switches the active version
// while it stays open, and pins that the editor re-binds to the correct
// version's content with edits landing in the correct version (no stale doc,
// no two-lineage bleed).

const requireModule = createRequire(import.meta.url);
const { DatabaseSync } = requireModule("node:sqlite") as {
  DatabaseSync: new (
    path: string,
    options?: { readOnly?: boolean },
  ) => {
    prepare(sql: string): {
      get(...params: unknown[]): Record<string, unknown> | undefined;
    };
    close(): void;
  };
};

function withEngineDb<T>(
  rootPath: string,
  read: (db: InstanceType<typeof DatabaseSync>) => T,
): T | null {
  let db: InstanceType<typeof DatabaseSync>;
  try {
    db = new DatabaseSync(join(rootPath, ".dohc/engine/engine.db"), {
      readOnly: true,
    });
  } catch {
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
    const row = db.prepare("SELECT version_id FROM versions WHERE name = ?").get(name);
    return row ? String(row.version_id) : null;
  });
}

function engineSnapshotText(rootPath: string, versionId: string, path: string): string | null {
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

async function editorText(page: Page): Promise<string> {
  return (await page.getByTestId("markdown-editor").innerText()).trim();
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
  await page.locator(`[data-testid="version-item"][data-version-name="${name}"]`).click();
  await expectActiveVersion(page, name);
}

async function waitForEngineEditor(page: Page): Promise<void> {
  // The engine session going live removes the local-editor Edit toggle and shows
  // the WYSIWYG surface. Give it the async IPC slack the other engine specs use.
  await expect(page.getByTestId("markdown-edit-toggle")).toHaveCount(0, {
    timeout: 15_000,
  });
  await expect(page.getByTestId("markdown-editor")).toBeVisible();
}

test("switching the active version while a rich doc stays open re-binds the editor to the new version", async () => {
  const temp = await createTempWorkspace();
  let desktop: Awaited<ReturnType<typeof launchDesktopApp>> | null = null;
  const mainSentinel = "MAINLINE-only-on-main";
  const draftSentinel = "DRAFTONLY-only-on-draft";

  try {
    await writeWorkspaceFiles(temp, [{ path: "plan.md", contents: `# Plan\n\n${mainSentinel}\n` }]);

    desktop = await launchDesktopApp({ workspace: temp });
    const { page } = desktop;
    const workspace = await openWorkspaceFromFirstRun(page, temp);
    await expectActiveVersion(page, "Main");
    await waitForWorkspaceFile(page, workspace.workspaceId, "plan.md");

    await explorerRow(page, "plan.md").click();
    await waitForEngineEditor(page);
    await expect.poll(() => editorText(page), { timeout: 15_000 }).toContain(mainSentinel);

    await createVersionViaMenu(page, "Draft");
    const draftId = engineVersionIdByName(temp.rootPath, "Draft");
    expect(draftId).not.toBeNull();
    await waitForEngineEditor(page);
    await expect.poll(() => editorText(page), { timeout: 15_000 }).toContain(mainSentinel);

    const editor = page.getByTestId("markdown-editor");
    await editor.click();
    await page.keyboard.press(DOCUMENT_END);
    await page.keyboard.type(` ${draftSentinel}`);
    await expect(page.getByTestId("markdown-save-state")).toHaveAttribute("data-state", "saved", {
      timeout: 15_000,
    });
    await expect.poll(() => editorText(page), { timeout: 15_000 }).toContain(draftSentinel);

    // The re-bind: switch back to Main while the same file stays open. The
    // editor must not keep showing Draft's live doc. It re-binds to Main's
    // lineage: Main's content, without the draft edit.
    await switchVersionViaMenu(page, "Main");
    await waitForEngineEditor(page);
    await expect.poll(() => editorText(page), { timeout: 20_000 }).toContain(mainSentinel);
    await expect
      .poll(() => editorText(page).then((text) => text.includes(draftSentinel)), {
        timeout: 20_000,
      })
      .toBe(false);
    await expect
      .poll(
        async () =>
          (await readFile(join(temp.rootPath, "plan.md"), "utf8")).includes(draftSentinel),
        {
          timeout: 20_000,
        },
      )
      .toBe(false);

    await switchVersionViaMenu(page, "Draft");
    await waitForEngineEditor(page);
    await expect.poll(() => editorText(page), { timeout: 20_000 }).toContain(draftSentinel);

    // Engine authority: the draft edit landed in Draft's snapshot only; Main's
    // snapshot is untouched. This is the "edits land in the correct version"
    // half of the re-bind.
    await expect
      .poll(() => engineSnapshotText(temp.rootPath, draftId ?? "", "plan.md"), {
        timeout: 30_000,
      })
      .toContain(draftSentinel);
    const mainSnapshot = engineSnapshotText(temp.rootPath, "main", "plan.md");
    expect(mainSnapshot ?? "").toContain(mainSentinel);
    expect(mainSnapshot ?? "").not.toContain(draftSentinel);
  } finally {
    await cleanupDesktopWorkspace(desktop, temp);
  }
});
