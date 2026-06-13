import { expect, test } from "@playwright/test";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ElectronApplication, Page } from "playwright";
import { launchApp, openInTree } from "./launch";

// Phase E2 gate: the VS Code-style workbench — activity-bar view switching
// (incl. designed empty states), side-panel toggle/resize with ui-state
// persistence across relaunch (and the watcher recording NOTHING for it),
// the full editor-tab lifecycle (incl. drag reorder + overflow menu), the
// default-visible history rail, and the status bar's conflict-count/
// update-toast surfaces.

const SCREENSHOT_DIR = "test-results/screenshots/e2";

async function seedWorkspace(
  workspaceId: string,
  files: Record<string, string>,
): Promise<{ home: string; root: string }> {
  const home = await mkdtemp(join(tmpdir(), "dohc-e2-home-"));
  const root = join(await mkdtemp(join(tmpdir(), "dohc-e2-")), "workspace");
  await mkdir(join(root, ".dohc"), { recursive: true });
  await writeFile(
    join(root, ".dohc", "manifest.json"),
    JSON.stringify({ version: 1, workspaceId, kind: "personal", mode: "local-first" }),
  );
  for (const [path, body] of Object.entries(files)) {
    await mkdir(join(root, path, ".."), { recursive: true });
    await writeFile(join(root, path), body);
  }
  return { home, root };
}

async function openSeeded(home: string, root: string) {
  const app = await launchApp({ DOHC_TEST_HOME: home, DOHC_TEST_PICK_PATH: root });
  const page = await app.firstWindow();
  await page.getByRole("button", { name: /open an existing folder/i }).click();
  await expect(page.getByTestId("workspace-shell")).toBeVisible();
  return { app, page };
}

async function relaunch(home: string) {
  const app = await launchApp({ DOHC_TEST_HOME: home });
  const page = await app.firstWindow();
  await expect(page.getByTestId("workspace-shell")).toBeVisible();
  return { app, page };
}

async function shot(page: Page, name: string): Promise<void> {
  await mkdir(SCREENSHOT_DIR, { recursive: true });
  const { width, height } = page.viewportSize() ?? { width: 0, height: 0 };
  const scheme = await page.evaluate(() =>
    document.documentElement.dataset.theme === "dark" ? "dark" : "light",
  );
  await page.screenshot({
    path: `${SCREENSHOT_DIR}/${name}--${width}x${height}--${scheme}.png`,
  });
}

async function sidebarWidth(page: Page): Promise<number> {
  return page
    .getByTestId("side-panel")
    .evaluate((el) => el.getBoundingClientRect().width);
}

// Drives a main→renderer update event exactly the way electronUpdater's
// onState wiring does (webContents.send on the update channel) — the preload
// boundary validation is part of what this exercises.
async function sendUpdateState(app: ElectronApplication, state: unknown) {
  await app.evaluate(({ BrowserWindow }, payload) => {
    BrowserWindow.getAllWindows()[0]?.webContents.send(
      "desktop:update-state",
      payload,
    );
  }, state);
}

test("activity bar: view switching with designed empty states, panel collapse on re-click", async () => {
  const { home, root } = await seedWorkspace("e2-views", {
    "notes/a.md": "# A\n",
  });
  const { app, page } = await openSeeded(home, root);

  // Explorer is the default view: active rail item + the file tree.
  await expect(page.getByTestId("activity-explorer")).toHaveAttribute(
    "aria-current",
    "page",
  );
  await expect(page.getByTestId("file-tree")).toBeVisible();

  // Search graduated to its real view in E5.0 (search.spec.ts drives it).
  await page.getByTestId("activity-search").click();
  await expect(page.getByTestId("activity-search")).toHaveAttribute(
    "aria-current",
    "page",
  );
  await expect(page.getByTestId("search-view")).toBeVisible();
  await expect(page.getByTestId("file-tree")).toHaveCount(0);

  // Graph graduated to its real local Markdown link map in E5.
  await page.getByTestId("activity-graph").click();
  await expect(page.getByTestId("activity-graph")).toHaveAttribute(
    "aria-current",
    "page",
  );
  await expect(page.getByTestId("graph-view")).toHaveAttribute("data-state", "ready");
  await expect(page.getByTestId("graph-doc-count")).toHaveText("1 doc");
  await expect(page.getByTestId("file-tree")).toHaveCount(0);

  // Each not-yet-built view renders its designed empty state in the panel.
  for (const view of ["apps", "agent"] as const) {
    await page.getByTestId(`activity-${view}`).click();
    await expect(page.getByTestId(`activity-${view}`)).toHaveAttribute(
      "aria-current",
      "page",
    );
    await expect(page.getByTestId("view-empty-state")).toContainText(
      new RegExp(view, "i"),
    );
    await expect(page.getByTestId("file-tree")).toHaveCount(0);
  }

  // History view shows the timeline content in the panel (the RIGHT rail
  // keeps the pinned history-timeline testid and stays visible).
  await page.getByTestId("activity-history").click();
  await expect(page.getByTestId("side-panel")).toContainText(/no changes yet/i);
  await expect(page.getByTestId("history-timeline")).toBeVisible();

  // Re-clicking the active item collapses the panel; once more reopens it.
  await page.getByTestId("activity-history").click();
  await expect(page.getByTestId("side-panel")).toHaveCount(0);
  await page.getByTestId("activity-history").click();
  await expect(page.getByTestId("side-panel")).toBeVisible();

  // Back to explorer, and the rail's bottom cluster opens the overlays.
  await page.getByTestId("activity-explorer").click();
  await expect(page.getByTestId("file-tree")).toBeVisible();
  await page.getByTestId("activity-cloud").click();
  await expect(page.getByTestId("cloud-sync-panel")).toBeVisible();
  await page.mouse.click(10, 300);
  await expect(page.getByTestId("cloud-sync-panel")).toHaveCount(0);
  await page.getByTestId("activity-settings").click();
  await expect(page.getByTestId("settings-panel")).toBeVisible();
  await page.keyboard.press("Escape");

  await app.close();
});

test("sidebar: Ctrl+B toggle, drag resize, ui-state persistence across relaunch — and the watcher records NOTHING for it", async () => {
  const { home, root } = await seedWorkspace("e2-persist", {
    "notes/a.md": "# A\n",
    "notes/b.md": "# B\n",
  });
  const { app, page } = await openSeeded(home, root);

  // Ctrl+B hides (unmounts) and restores the panel.
  await page.keyboard.press("ControlOrMeta+b");
  await expect(page.getByTestId("file-tree")).toHaveCount(0);
  await page.keyboard.press("ControlOrMeta+b");
  await expect(page.getByTestId("file-tree")).toBeVisible();
  expect(Math.round(await sidebarWidth(page))).toBe(240);

  // Drag the resize handle 120px right → clamped width sticks.
  const handle = page.getByTestId("sidebar-resize");
  const box = await handle.boundingBox();
  expect(box).not.toBeNull();
  const startX = box!.x + box!.width / 2;
  const startY = box!.y + box!.height / 2;
  await page.mouse.move(startX, startY);
  await page.mouse.down();
  await page.mouse.move(startX + 120, startY, { steps: 8 });
  await page.mouse.up();
  // ±1px: boundingBox is fractional, mouse coordinates are integers.
  const draggedWidth = Math.round(await sidebarWidth(page));
  expect(Math.abs(draggedWidth - 360)).toBeLessThanOrEqual(1);

  // Open both files (tabs) so the relaunch has something to restore.
  await openInTree(page, "notes/a.md");
  await openInTree(page, "notes/b.md");
  await expect(page.getByTestId("tab-notes/a.md")).toBeVisible();
  await expect(page.getByTestId("tab-notes/b.md")).toHaveAttribute("data-active", "true");

  // The debounced writer lands .dohc/ui-state.json with the dragged width.
  const uiStatePath = join(root, ".dohc", "ui-state.json");
  await expect.poll(() => existsSync(uiStatePath), { timeout: 5000 }).toBe(true);
  await expect
    .poll(
      () => JSON.parse(readFileSync(uiStatePath, "utf8")) as { sidebarWidth?: number },
      { timeout: 5000 },
    )
    .toMatchObject({
      version: 1,
      sidebarWidth: draggedWidth,
      tabs: ["notes/a.md", "notes/b.md"],
      activeTab: "notes/b.md",
    });

  // The watcher must record NOTHING for ui-state writes. Make a real change,
  // wait for ITS record (a full settle cycle after the ui-state writes), then
  // assert history never saw .dohc/ui-state.
  await writeFile(join(root, "notes/c.md"), "# C\n");
  await expect(page.getByTestId("history-timeline")).toContainText(/c\.md/i, {
    timeout: 15_000,
  });
  await expect(page.getByTestId("history-timeline")).not.toContainText(".dohc");
  const historyDir = join(root, ".dohc", "history");
  const records = (await readdir(historyDir))
    .filter((name) => name.endsWith(".json") && name !== "index.json")
    .map((name) => JSON.parse(readFileSync(join(historyDir, name), "utf8")));
  for (const record of records) {
    for (const file of record.files as Array<{ path: string }>) {
      expect(file.path).not.toContain(".dohc");
      expect(file.path).not.toContain("ui-state");
    }
  }

  await app.close();

  // Relaunch: width, tabs, active tab, and the history rail all restore.
  const second = await relaunch(home);
  await expect(second.page.getByTestId("tab-notes/a.md")).toBeVisible();
  await expect(second.page.getByTestId("tab-notes/b.md")).toHaveAttribute(
    "data-active",
    "true",
  );
  await expect(second.page.getByTestId("view-markdown")).toContainText("B");
  await expect.poll(async () => Math.round(await sidebarWidth(second.page))).toBe(
    draggedWidth,
  );
  await expect(second.page.getByTestId("history-timeline")).toBeVisible();
  await second.app.close();
});

test("editor tabs: open/switch, drag reorder, overflow menu, dirty dot, Ctrl+W, middle-click, neighbor activation", async () => {
  const { home, root } = await seedWorkspace("e2-tabs", {
    "a.md": "# Alpha\n",
    "b.md": "# Beta\n",
    "c.md": "# Gamma\n",
  });
  const { app, page } = await openSeeded(home, root);
  const tree = page.getByTestId("file-tree");

  // Open three files → three tabs, last one active.
  for (const name of ["a.md", "b.md", "c.md"]) {
    await tree.getByText(name, { exact: true }).click();
  }
  const tabs = page.getByTestId("editor-tabs").getByRole("tab");
  await expect(tabs).toHaveCount(3);
  await expect(page.getByTestId("tab-c.md")).toHaveAttribute("data-active", "true");
  await expect(page.getByTestId("view-markdown")).toContainText("Gamma");

  // Reorder by drag: pull a.md (leftmost) right past b.md's midpoint — the
  // live reorder lands [b, a, c], and releasing activates the dragged tab.
  const aBox = await page.getByTestId("tab-a.md").boundingBox();
  const bBox = await page.getByTestId("tab-b.md").boundingBox();
  expect(aBox).not.toBeNull();
  expect(bBox).not.toBeNull();
  const dragY = aBox!.y + aBox!.height / 2;
  await page.mouse.move(aBox!.x + aBox!.width / 2, dragY);
  await page.mouse.down();
  await page.mouse.move(bBox!.x + bBox!.width - 2, dragY, { steps: 10 });
  await page.mouse.up();
  await expect(tabs.nth(0)).toHaveAttribute("data-testid", "tab-b.md");
  await expect(tabs.nth(1)).toHaveAttribute("data-testid", "tab-a.md");
  await expect(tabs.nth(2)).toHaveAttribute("data-testid", "tab-c.md");
  await expect(page.getByTestId("tab-a.md")).toHaveAttribute("data-active", "true");

  // Overflow menu: lists every open tab; picking one activates it.
  await page.getByTestId("tabs-overflow").click();
  const menu = page.getByTestId("tabs-overflow-menu");
  await expect(menu.getByRole("menuitem")).toHaveCount(3);
  await menu.getByRole("menuitem", { name: "c.md" }).click();
  await expect(menu).toHaveCount(0);
  await expect(page.getByTestId("tab-c.md")).toHaveAttribute("data-active", "true");
  await expect(page.getByTestId("view-markdown")).toContainText("Gamma");

  // Tab click switches (through the same openFile path as the tree).
  await page.getByTestId("tab-a.md").click();
  await expect(page.getByTestId("tab-a.md")).toHaveAttribute("data-active", "true");
  await expect(page.getByTestId("view-markdown")).toContainText("Alpha");

  // Dirty dot: typing flips the save state; the dot clears once saved.
  await page.getByTestId("markdown-edit-toggle").click();
  await page.getByTestId("markdown-editor").click();
  await page.keyboard.type("More words.");
  await expect(page.getByTestId("tab-dirty")).toBeVisible();
  await expect(page.getByTestId("markdown-save-state")).toHaveAttribute(
    "data-state",
    "saved",
    { timeout: 10_000 },
  );
  await expect(page.getByTestId("tab-dirty")).toHaveCount(0);
  await page.getByTestId("markdown-edit-toggle").click();

  // Ctrl+W closes the ACTIVE tab (a.md, middle of [b, a, c]): the neighbor
  // that slid into its slot (c.md) takes over — and the window stays open.
  await page.keyboard.press("ControlOrMeta+w");
  await expect(page.getByTestId("tab-a.md")).toHaveCount(0);
  await expect(page.getByTestId("tab-c.md")).toHaveAttribute("data-active", "true");
  await expect(page.getByTestId("view-markdown")).toContainText("Gamma");

  // Middle-click closes the inactive b.md without touching the active tab.
  await page.getByTestId("tab-b.md").click({ button: "middle" });
  await expect(page.getByTestId("tab-b.md")).toHaveCount(0);
  await expect(page.getByTestId("tab-c.md")).toHaveAttribute("data-active", "true");

  // The close button clears the last tab → the editor empty state returns.
  await page.getByRole("button", { name: /close c\.md/i }).click();
  await expect(page.getByTestId("editor-tabs")).toHaveCount(0);
  await expect(page.getByText(/select a file, or create one/i)).toBeVisible();

  await app.close();
});

test("dirty tab: a draft typed within the autosave window SURVIVES Ctrl+W (unmount flush)", async () => {
  const { home, root } = await seedWorkspace("e2-dirty-close", {
    "a.md": "# Alpha\n",
    "b.md": "# Beta\n",
  });
  const { app, page } = await openSeeded(home, root);
  const tree = page.getByTestId("file-tree");

  // Two tabs so closing a.md activates a neighbor (the close path that used
  // to drop the draft), with a.md active.
  await tree.getByText("b.md", { exact: true }).click();
  await tree.getByText("a.md", { exact: true }).click();
  await expect(page.getByTestId("tab-a.md")).toHaveAttribute("data-active", "true");

  // Type and close INSIDE the 800ms autosave window: the pending draft has
  // not been written when Ctrl+W unmounts the editor. Silent loss is never
  // acceptable — the unmount flush must land it.
  await page.getByTestId("markdown-edit-toggle").click();
  await page.getByTestId("markdown-editor").click();
  await page.keyboard.type("Draft typed right before close.");
  await page.keyboard.press("ControlOrMeta+w");
  await expect(page.getByTestId("tab-a.md")).toHaveCount(0);
  await expect(page.getByTestId("tab-b.md")).toHaveAttribute("data-active", "true");

  // The draft landed on disk.
  await expect
    .poll(() => readFileSync(join(root, "a.md"), "utf8"), { timeout: 5000 })
    .toContain("Draft typed right before close.");

  // And reopening shows the saved draft as the document.
  await tree.getByText("a.md", { exact: true }).click();
  await expect(page.getByTestId("view-markdown")).toContainText(
    "Draft typed right before close.",
  );

  await app.close();
});

test("history rail: visible by default with zero clicks, toggleable via the palette", async () => {
  const { home, root } = await seedWorkspace("e2-rail", { "a.md": "# A\n" });
  const { app, page } = await openSeeded(home, root);

  await expect(page.getByTestId("history-timeline")).toBeVisible();

  await page.keyboard.press("ControlOrMeta+k");
  await page.keyboard.type("toggle history");
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("history-timeline")).toHaveCount(0);

  await page.keyboard.press("ControlOrMeta+k");
  await page.keyboard.type("toggle history");
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("history-timeline")).toBeVisible();

  await app.close();
});

test("status bar: clean status carries no conflict count; update toast appears on ready, rejects junk, dismisses", async () => {
  const { home, root } = await seedWorkspace("e2-status", {
    "notes/today.md": "# Today\n",
  });
  const { app, page } = await openSeeded(home, root);

  // Clean workspace: pinned testid + data-state, and NO "(n)" count suffix.
  const syncStatus = page.getByTestId("sync-status");
  await expect(syncStatus).toBeVisible();
  await expect(syncStatus).not.toContainText("(");

  // Junk update events must die at the preload boundary (closed tuple,
  // bounded primitive message) — no toast for any of these.
  await sendUpdateState(app, { status: "pwn", message: "evil" });
  await sendUpdateState(app, { status: "ready" });
  await sendUpdateState(app, { status: "ready", message: "x".repeat(600) });
  await sendUpdateState(app, "ready");
  await expect(page.getByTestId("update-toast")).toHaveCount(0);

  // Non-ready machine states stay silent (download progress is not a toast).
  await sendUpdateState(app, {
    status: "downloading",
    message: "Downloading update 1.2.3 — 40%",
  });
  await expect(page.getByTestId("update-toast")).toHaveCount(0);

  // The ready state surfaces the machine's own message and dismisses.
  await sendUpdateState(app, {
    status: "ready",
    message: "Update 1.2.3 is ready — restart dohc to apply it.",
  });
  const toast = page.getByTestId("update-toast");
  await expect(toast).toContainText("Update 1.2.3 is ready");
  await page.getByRole("button", { name: /dismiss update/i }).click();
  await expect(toast).toHaveCount(0);

  // Screenshots (1/2): the full workbench (tabs open, rail visible) at both
  // gate sizes, light and dark. The E2-specific states (dirty/inactive tabs,
  // empty views, hidden sidebar) get their own captures below.
  await openInTree(page, "notes/today.md");
  await expect(page.getByTestId("view-markdown")).toBeVisible();
  await page.emulateMedia({ colorScheme: "light" });
  await expect
    .poll(() => page.evaluate(() => document.documentElement.dataset.theme))
    .toBe("light");
  for (const size of [
    { width: 1280, height: 800 },
    { width: 1536, height: 960 },
  ]) {
    await page.setViewportSize(size);
    await shot(page, "workbench");
  }
  await page.emulateMedia({ colorScheme: "dark" });
  await expect
    .poll(() => page.evaluate(() => document.documentElement.dataset.theme))
    .toBe("dark");
  for (const size of [
    { width: 1280, height: 800 },
    { width: 1536, height: 960 },
  ]) {
    await page.setViewportSize(size);
    await shot(page, "workbench");
  }

  await app.close();
});

test("screenshots (2/2): dirty + inactive tabs, agent empty view, hidden sidebar — light and dark", async () => {
  const { home, root } = await seedWorkspace("e2-shots", {
    "notes/ideas.md": "# Ideas\n",
    "notes/today.md": "# Today\n\nA second open file makes the tab contrast judgeable.\n",
  });
  const { app, page } = await openSeeded(home, root);
  await page.setViewportSize({ width: 1280, height: 800 });
  await openInTree(page, "notes/ideas.md");
  await openInTree(page, "notes/today.md");
  await expect(page.getByTestId("tab-notes/today.md")).toHaveAttribute(
    "data-active",
    "true",
  );

  for (const scheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    await expect
      .poll(() => page.evaluate(() => document.documentElement.dataset.theme))
      .toBe(scheme);

    // Two tabs, the active one dirty: shoot inside the 800ms autosave window
    // (the dirty dot + active/inactive tab contrast in one frame).
    await page.getByTestId("markdown-edit-toggle").click();
    await page.getByTestId("markdown-editor").click();
    await page.keyboard.type(" More.");
    await expect(page.getByTestId("tab-dirty")).toBeVisible();
    await shot(page, "workbench-dirty-tab");
    await expect(page.getByTestId("markdown-save-state")).toHaveAttribute(
      "data-state",
      "saved",
      { timeout: 10_000 },
    );
    await page.getByTestId("markdown-edit-toggle").click();
    await expect(page.getByTestId("view-markdown")).toBeVisible();

    // The Agent placeholder view (sidebar on a non-explorer view).
    await page.getByTestId("activity-agent").click();
    await expect(page.getByTestId("view-empty-state")).toBeVisible();
    await shot(page, "workbench-agent-view");

    // Hidden sidebar.
    await page.keyboard.press("ControlOrMeta+b");
    await expect(page.getByTestId("side-panel")).toHaveCount(0);
    await shot(page, "workbench-sidebar-hidden");

    // Restore explorer + panel for the next scheme.
    await page.getByTestId("activity-explorer").click();
    await expect(page.getByTestId("file-tree")).toBeVisible();
  }

  await app.close();
});
