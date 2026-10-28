import { expect, test, type Locator, type Page } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import { launchDesktopApp } from "./helpers/desktopApp";
import {
  cleanupDesktopWorkspace,
  createTempWorkspace,
  explorerRow,
  openWorkspaceFromFirstRun,
  writeWorkspaceFiles,
} from "./helpers/workspace";

// Screenshot harness (@ui-audit) for the versions menu and what it opens: the
// menu on Main, on a version, and on a version made from another version; its
// name field with its hint, Creating…, and a refused name; a failed create and
// a failed merge as notices with Try again; each merge stage; the save-first
// confirm; and keyboard focus on the disabled Merge row. Light and dark. Not a
// regression test; it runs only when a shot directory is set, the way
// ui-audit-screenshots.spec.ts does.
const SHOT_DIR = process.env.UI_AUDIT_SHOT_DIR ?? "";
test.skip(SHOT_DIR === "", "set UI_AUDIT_SHOT_DIR to capture versions menu screenshots");

type Desktop = Awaited<ReturnType<typeof launchDesktopApp>>;

const requireModule = createRequire(import.meta.url);
const { DatabaseSync } = requireModule("node:sqlite") as {
  DatabaseSync: new (path: string, options?: { readOnly?: boolean }) => {
    prepare(sql: string): { get(...params: unknown[]): Record<string, unknown> | undefined };
    close(): void;
  };
};

// What the engine holds for a file in a version, as workspace-versions.spec.ts
// reads it, so a merge starts only after both sides were captured.
function engineText(rootPath: string, versionName: string, path: string): string | null {
  let db: InstanceType<typeof DatabaseSync>;
  try {
    db = new DatabaseSync(join(rootPath, ".dohc/engine/engine.db"), { readOnly: true });
  } catch {
    return null;
  }
  try {
    const row = db
      .prepare(
        `SELECT b.text AS text FROM snapshots s
         JOIN versions v ON v.version_id = s.version_id
         JOIN blobs b ON b.sha256 = s.blob_sha256
         WHERE v.name = ? AND s.path = ?`,
      )
      .get(versionName, path);
    return row ? String(row.text) : null;
  } finally {
    db.close();
  }
}

type InvokeHandler = (...args: unknown[]) => unknown;
type ShotGate = { release(): void };

// Holds or fails main's handler for the next call on one channel, the way
// shared-continuity.spec.ts holds editor updates. Electron looks the handler
// up in ipcMain._invokeHandlers on each invoke, so the swap catches that call
// and puts the original back for every call after it. A failure is the
// engine going away, which the renderer words after what failed.
async function interceptNext(desktop: Desktop, channel: string, mode: "hold" | "fail"): Promise<void> {
  await desktop.app.evaluate(({ ipcMain }, input) => {
    const handlers = (ipcMain as unknown as { _invokeHandlers: Map<string, InvokeHandler> })._invokeHandlers;
    const original = handlers.get(input.channel);
    if (!original) throw new Error(`main has no handler for ${input.channel}`);
    let open!: () => void;
    const gate = new Promise<void>((resolve) => { open = resolve; });
    handlers.set(input.channel, async (...args: unknown[]) => {
      handlers.set(input.channel, original);
      if (input.mode === "fail") throw Object.assign(new Error("Rust engine daemon exited."), { name: "EngineDaemonUnavailableError" });
      await gate;
      return await original(...args);
    });
    (globalThis as { __dohcShotGate?: ShotGate }).__dohcShotGate = { release: open };
  }, { channel, mode });
}

async function releaseHeld(desktop: Desktop): Promise<void> {
  await desktop.app.evaluate(() => (globalThis as { __dohcShotGate?: ShotGate }).__dohcShotGate?.release());
}

async function setTheme(page: Page, theme: "light" | "dark"): Promise<void> {
  await page.evaluate(async (value) => {
    document.documentElement.setAttribute("data-theme", value);
    void getComputedStyle(document.body).backgroundColor;
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    await Promise.allSettled(document.getAnimations()
      .filter((animation) => animation.playState === "running" && Number.isFinite(Number(animation.effect?.getComputedTiming().endTime)))
      .map((animation) => animation.finished));
  }, theme);
}

// The given parts, with room around them for the shadow.
async function shootParts(page: Page, name: string, parts: Locator[]): Promise<void> {
  const boxes = await Promise.all(parts.map((part) => part.boundingBox()));
  const present = boxes.filter((box): box is NonNullable<typeof box> => box !== null);
  const pad = 24;
  const left = Math.max(0, Math.min(...present.map((box) => box.x)) - pad);
  const top = Math.max(0, Math.min(...present.map((box) => box.y)) - pad);
  const right = Math.max(...present.map((box) => box.x + box.width)) + pad;
  const bottom = Math.max(...present.map((box) => box.y + box.height)) + pad;
  for (const theme of ["light", "dark"] as const) {
    await setTheme(page, theme);
    await page.screenshot({ path: join(SHOT_DIR, `${name}-${theme}.png`), clip: { x: left, y: top, width: right - left, height: bottom - top } });
  }
  await setTheme(page, "light");
}

async function shootMenu(page: Page, name: string): Promise<void> {
  await shootParts(page, name, [page.getByTestId("version-menu-button"), page.getByTestId("version-menu")]);
}

async function shootWindow(page: Page, name: string): Promise<void> {
  for (const theme of ["light", "dark"] as const) {
    await setTheme(page, theme);
    await page.screenshot({ path: join(SHOT_DIR, `${name}-${theme}.png`) });
  }
  await setTheme(page, "light");
}

async function openMenu(page: Page): Promise<void> {
  const button = page.getByTestId("version-menu-button");
  await expect(button).toBeEnabled({ timeout: 20_000 });
  await button.click();
  await expect(page.getByTestId("version-menu")).toBeVisible();
  // Rest the pointer away from the rows, so no row shows hover.
  await page.mouse.move(4, 400);
}

async function expectActive(page: Page, name: string): Promise<void> {
  await expect(page.getByTestId("version-menu-active")).toHaveText(name, { timeout: 20_000 });
  await expect(page.getByTestId("version-menu-button")).toBeEnabled();
}

async function createVersion(page: Page, name: string): Promise<void> {
  await openMenu(page);
  await page.getByTestId("version-new").click();
  await page.getByTestId("version-new-input").fill(name);
  await page.getByTestId("version-new-input").press("Enter");
  await expectActive(page, name);
}

async function switchTo(page: Page, name: string): Promise<void> {
  await openMenu(page);
  await page.locator(`[data-testid="version-item"][data-version-name="${name}"]`).click();
  await expectActive(page, name);
}

async function writeCaptured(page: Page, rootPath: string, version: string, path: string, contents: string): Promise<void> {
  await writeWorkspaceFiles({ rootPath }, [{ path, contents }]);
  await expect.poll(() => engineText(rootPath, version, path), { timeout: 30_000 }).toBe(contents);
  await expect(page.getByTestId("version-menu-button")).toBeEnabled();
}

function notice(page: Page, text: string): Locator {
  return page.getByTestId("workspace-shell-notice").filter({ hasText: text });
}

test("@ui-audit the versions menu and what it opens", async () => {
  test.setTimeout(600_000);
  await mkdir(SHOT_DIR, { recursive: true });
  const temp = await createTempWorkspace();
  let desktop: Desktop | null = null;
  try {
    await writeWorkspaceFiles(temp, [
      { path: "plan.md", contents: "# Plan\n\nFirst draft.\n" },
      { path: "notes.md", contents: "# Notes\n" },
    ]);
    desktop = await launchDesktopApp({ workspace: temp });
    const page = desktop.page;
    await openWorkspaceFromFirstRun(page, temp);
    await page.emulateMedia({ reducedMotion: "reduce" });
    await expectActive(page, "Main");

    // On Main: the menu, the field's hint, a taken name, and Creating….
    await shootWindow(page, "window-main");
    await openMenu(page);
    await shootMenu(page, "menu-main");
    await page.getByTestId("version-new").click();
    await page.getByTestId("version-new-input").fill("Draft");
    await shootMenu(page, "menu-main-new-field");
    await page.getByTestId("version-new-input").fill("Main");
    await page.getByTestId("version-new-input").press("Enter");
    await expect(page.getByTestId("version-menu-error")).toBeVisible({ timeout: 20_000 });
    await shootMenu(page, "menu-name-taken");
    await page.getByTestId("version-new-input").fill("Draft");
    await interceptNext(desktop, "desktop:create-workspace-version", "hold");
    await page.getByTestId("version-new-input").press("Enter");
    await expect(page.getByTestId("version-menu")).toContainText("Creating…");
    await shootMenu(page, "menu-creating");
    await releaseHeld(desktop);
    await expectActive(page, "Draft");

    // On Draft: the trigger without a dot, the menu opened with the mouse,
    // and the field's hint.
    await shootParts(page, "trigger-draft", [page.getByTestId("version-menu-button")]);
    await openMenu(page);
    await shootMenu(page, "menu-draft");
    await page.getByTestId("version-new").click();
    await page.getByTestId("version-new-input").fill("Ideas");
    await shootMenu(page, "menu-draft-new-field");

    // A create that fails for another reason: a notice with Try again, and
    // its row in Notices. The field keeps the name.
    await interceptNext(desktop, "desktop:create-workspace-version", "fail");
    await page.getByTestId("version-new-input").press("Enter");
    const createFailed = notice(page, "Ideas");
    await expect(createFailed).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId("version-new-input")).toHaveValue("Ideas");
    await shootWindow(page, "create-failure-toast");
    await page.keyboard.press("Escape");
    await page.keyboard.press("Escape");
    await page.getByTestId("notice-center-toggle").click();
    await expect(page.locator("[data-notice-row]").filter({ hasText: "Ideas" })).toBeVisible();
    await shootWindow(page, "create-failure-notices");
    await page.getByTestId("notice-center-toggle").click();

    // Both sides change notes.md, so the merge has a conflict to decide.
    await writeCaptured(page, temp.rootPath, "Draft", "notes.md", "# Notes\n\nDraft's notes.\n");
    await switchTo(page, "Main");
    await writeCaptured(page, temp.rootPath, "Main", "notes.md", "# Notes\n\nMain's notes.\n");
    await switchTo(page, "Draft");

    // The merge: confirm, a failure as a notice, Try again reopening the
    // dialog already merging, the conflicts, and the end.
    await openMenu(page);
    await page.getByTestId("version-merge").click();
    await expect(page.getByTestId("version-merge-dialog")).toBeVisible();
    await shootWindow(page, "merge-confirm");
    await interceptNext(desktop, "desktop:merge-workspace-version", "fail");
    await page.getByTestId("version-merge-confirm").click();
    const mergeFailed = notice(page, "merge");
    await expect(mergeFailed).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId("version-merge-dialog")).toHaveCount(0);
    await shootWindow(page, "merge-failure-toast");
    await interceptNext(desktop, "desktop:merge-workspace-version", "hold");
    await mergeFailed.getByRole("button", { name: "Try again" }).click();
    await expect(page.getByTestId("version-merge-status")).toContainText("Merging Draft into Main…");
    await shootWindow(page, "merge-retry-running");
    await releaseHeld(desktop);
    await expect(page.locator('[data-testid="version-conflict"][data-conflict-path="notes.md"]')).toBeVisible({ timeout: 30_000 });
    await shootWindow(page, "merge-conflicts");
    await page.getByTestId("version-conflict-keep-incoming").click();
    await expect(page.getByTestId("version-merge-status")).toHaveText(/All conflicts are resolved/, { timeout: 30_000 });
    await shootWindow(page, "merge-resolved");
    await page.getByTestId("version-merge-done").click();

    // A clean merge.
    await writeCaptured(page, temp.rootPath, "Draft", "plan.md", "# Plan\n\nSecond draft.\n");
    await openMenu(page);
    await page.getByTestId("version-merge").click();
    await page.getByTestId("version-merge-confirm").click();
    await expect(page.getByTestId("version-merge-status")).toHaveText(/Merged 1 file into Main/, { timeout: 30_000 });
    await shootWindow(page, "merge-success");
    await page.getByTestId("version-merge-done").click();

    // A version made from Draft cannot merge into Main, and says why.
    await createVersion(page, "Draft two");
    await openMenu(page);
    await shootMenu(page, "menu-nested");
    await page.keyboard.press("Escape");
    // Opened from the keyboard, then down to the disabled Merge row.
    await page.getByTestId("version-menu-button").focus();
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("version-menu")).toBeVisible();
    const merge = page.getByTestId("version-merge");
    for (let step = 0; step < 12 && !(await merge.evaluate((row) => row === document.activeElement)); step++) {
      await page.keyboard.press("ArrowDown");
    }
    await expect(merge).toBeFocused();
    await shootMenu(page, "menu-nested-merge-focus");
    await page.keyboard.press("Escape");
    await shootWindow(page, "window-nested");

    // Switching with an edit main has not taken yet asks to save it first.
    await explorerRow(page, "plan.md").click();
    const editor = page.getByTestId("markdown-editor");
    await expect(editor).toBeVisible({ timeout: 20_000 });
    await interceptNext(desktop, "desktop:engine-ydoc-apply-update", "hold");
    await editor.click();
    await page.keyboard.press("End");
    await page.keyboard.type(" More.");
    await openMenu(page);
    await page.locator('[data-testid="version-item"][data-version-name="Main"]').click();
    await expect(page.getByTestId("version-switch-save-confirm")).toBeVisible({ timeout: 20_000 });
    await shootWindow(page, "save-first");
    await page.getByTestId("version-switch-save-cancel").click();
    await releaseHeld(desktop);
  } finally {
    await cleanupDesktopWorkspace(desktop, temp);
  }
});
