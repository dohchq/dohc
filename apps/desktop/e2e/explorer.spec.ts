import { expect, test } from "@playwright/test";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, readdir, writeFile } from "node:fs/promises";
import { homedir, tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import type { ElectronApplication, Page } from "playwright";
import { launchApp, openInTree } from "./launch";

// Phase E3 gate: explorer parity. Every file-management operation runs
// through the real UI seams (inline editboxes, F2, Del + confirm, drag-move,
// the context-menu invoke seam, pins, OS-drop import, export zip) — and the
// WATCHER must record each as an ordinary change set with the right paths,
// while .dohc never pollutes history (the explorer is not a privileged
// writer). Screenshots land in test-results/screenshots/e3.

const SHOT_DIR = "test-results/screenshots/e3";

async function seedWorkspace(
  workspaceId: string,
  files: Record<string, string>,
): Promise<{ home: string; root: string }> {
  const home = await mkdtemp(join(tmpdir(), "dohc-e3-home-"));
  const root = join(await mkdtemp(join(tmpdir(), "dohc-e3-")), "workspace");
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

async function shot(page: Page, name: string): Promise<void> {
  await mkdir(SHOT_DIR, { recursive: true });
  // Park the cursor over the editor body first: a cursor left above a tree
  // row bakes its hover tint into the capture (useless as a baseline).
  await page.mouse.move(640, 400);
  const scheme = await page.evaluate(() =>
    document.documentElement.dataset.theme === "dark" ? "dark" : "light",
  );
  await page.screenshot({ path: `${SHOT_DIR}/${name}--1280x800--${scheme}.png` });
}

async function setScheme(page: Page, scheme: "light" | "dark"): Promise<void> {
  await page.emulateMedia({ colorScheme: scheme });
  await expect
    .poll(() => page.evaluate(() => document.documentElement.dataset.theme))
    .toBe(scheme);
}

// Every judged surface is captured in BOTH schemes; the page is left back on
// light so the capture never changes the state the test continues from.
async function shotBothSchemes(page: Page, name: string): Promise<void> {
  await setScheme(page, "light");
  await shot(page, name);
  await setScheme(page, "dark");
  await shot(page, name);
  await setScheme(page, "light");
}

// THE context-menu invoke seam: a NATIVE menu cannot be driven by
// Playwright, so the main-process handler (test-mode only) reads
// DOHC_TEST_EXPLORER_MENU_CHOICE per invoke — set it in the MAIN process
// right before the right-click that should "choose" that item.
async function setMenuChoice(
  app: ElectronApplication,
  choice: string | null,
): Promise<void> {
  await app.evaluate((_electron, value) => {
    if (value === null) delete process.env.DOHC_TEST_EXPLORER_MENU_CHOICE;
    else process.env.DOHC_TEST_EXPLORER_MENU_CHOICE = value;
  }, choice);
}

async function setSavePath(app: ElectronApplication, path: string): Promise<void> {
  await app.evaluate((_electron, value) => {
    process.env.DOHC_TEST_SAVE_PATH = value;
  }, path);
}

const tree = (page: Page) => page.getByTestId("file-tree");
// tree-row scoped: a PINNED row carries the same data-path as its tree row.
const row = (page: Page, path: string) =>
  tree(page).locator(`[data-testid="tree-row"][data-path="${path}"]`);

// Per-op watcher gate: wait until the timeline has EXACTLY n recorded change
// sets and the newest one names the expected paths. Waiting between ops also
// keeps each op in its OWN settle window — without it, two quick ops merge
// into one batch and the per-op assertions get nothing to bite on.
async function expectChangeSet(
  page: Page,
  n: number,
  newest: RegExp | string,
): Promise<void> {
  const entries = page.getByTestId("history-timeline").locator("li");
  await expect(entries).toHaveCount(n, { timeout: 15_000 });
  await expect(entries.first()).toContainText(newest);
}

// Recovery-location assertion: deletes are NEVER hard deletes. Where the
// bytes land depends on the filesystem — shell.trashItem uses the XDG trash
// (home or per-mount .Trash-<uid>), and on mounts that REJECT trashing the
// app falls back to <root>/.dohc/trash. Find the trashed file in whichever
// recovery location took it.
async function findInTrash(root: string, leaf: string): Promise<string | null> {
  const candidates = [
    join(root, ".dohc", "trash"),
    join(homedir(), ".local", "share", "Trash", "files"),
    join("/tmp", `.Trash-${userInfo().uid}`, "files"),
  ];
  for (const dir of candidates) {
    try {
      const names = await readdir(dir);
      const hit = names.find((name) => name === leaf || name.endsWith(`-${leaf}`));
      if (hit) return join(dir, hit);
    } catch {
      // Location doesn't exist on this machine — try the next.
    }
  }
  return null;
}

test("create (inline file/folder incl. nested), rename (F2 + context menu), delete-to-trash, keyboard nav — each op is a change set", async () => {
  test.setTimeout(120_000);
  const { home, root } = await seedWorkspace("e3-ops", {
    "readme.md": "# Readme\n",
    "notes/today.md": "# Today\n",
    "notes/b.md": "# B\n",
  });
  const { app, page } = await openSeeded(home, root);
  const timeline = page.getByTestId("history-timeline");

  // --- Inline create: header action, root level ---
  await page.getByTestId("explorer-new-file").click();
  const editbox = page.getByTestId("tree-edit-input");
  await expect(editbox).toBeVisible();
  await editbox.fill("alpha.md");
  await editbox.press("Enter");
  await expect(row(page, "alpha.md")).toBeVisible();
  expect(existsSync(join(root, "alpha.md"))).toBe(true);
  // The create opened the file (a tab) and the WATCHER recorded it with the
  // right path — an ordinary change set, not a privileged write.
  await expect(page.getByTestId("tab-alpha.md")).toBeVisible();
  await expectChangeSet(page, 1, "alpha.md");

  // --- Inline create with a typed NESTED path: folders materialize ---
  await page.getByTestId("explorer-new-file").click();
  await editbox.fill("deep/nested/file.md");
  await editbox.press("Enter");
  await expect(row(page, "deep/nested/file.md")).toBeVisible(); // auto-expanded
  expect(existsSync(join(root, "deep", "nested", "file.md"))).toBe(true);
  await expectChangeSet(page, 2, "deep/nested/file.md");

  // --- Inline create FOLDER: an empty folder is a visible tree row ---
  await page.getByTestId("explorer-new-folder").click();
  await editbox.fill("docs");
  await editbox.press("Enter");
  await expect(row(page, "docs")).toBeVisible();
  await expect(row(page, "docs")).toHaveAttribute("data-kind", "folder");
  expect(existsSync(join(root, "docs"))).toBe(true);

  // --- Context menu (invoke seam): New File inside the folder ---
  await setMenuChoice(app, "new-file");
  await row(page, "docs").click({ button: "right" });
  await expect(editbox).toBeVisible();
  await editbox.fill("inside.md");
  await editbox.press("Enter");
  await expect(row(page, "docs/inside.md")).toBeVisible();
  expect(existsSync(join(root, "docs", "inside.md"))).toBe(true);
  await expectChangeSet(page, 3, "docs/inside.md");

  // --- F2 rename (file): one move IPC, tab follows, ONE change set ---
  await row(page, "readme.md").click();
  await expect(page.getByTestId("tab-readme.md")).toBeVisible();
  await page.keyboard.press("F2");
  await expect(editbox).toBeVisible();
  // The rename editbox is a judged surface: row-exact type (13px sans),
  // squared, focus signalled by a strong border — capture it open.
  await shotBothSchemes(page, "explorer-editbox");
  await editbox.fill("manual.md");
  await editbox.press("Enter");
  await expect(row(page, "manual.md")).toBeVisible();
  await expect(row(page, "readme.md")).toHaveCount(0);
  expect(existsSync(join(root, "manual.md"))).toBe(true);
  expect(existsSync(join(root, "readme.md"))).toBe(false);
  // Tab remap: no dead tab pointing at the old path.
  await expect(page.getByTestId("tab-manual.md")).toBeVisible();
  await expect(page.getByTestId("tab-readme.md")).toHaveCount(0);
  // The watcher infers delete+write in ONE settle batch ⇒ ONE change set.
  await expectChangeSet(page, 4, /2 files/i);

  // --- Context-menu rename (folder): children move with it ---
  await setMenuChoice(app, "rename");
  await row(page, "docs").click({ button: "right" });
  await expect(editbox).toBeVisible();
  // The object keeps its species mid-rename: folder icon + chevron stay in
  // place for the whole edit — never the file icon.
  const editRowItem = page.locator("li", { has: page.getByTestId("tree-edit-input") });
  await expect(
    editRowItem.locator("svg.lucide-folder-open, svg.lucide-folder"),
  ).toBeVisible();
  await expect(editRowItem.locator("svg.lucide-chevron-right")).toBeVisible();
  await expect(editRowItem.locator("svg.lucide-file-text")).toHaveCount(0);
  await editbox.fill("papers");
  await editbox.press("Enter");
  await expect(row(page, "papers")).toBeVisible();
  await openInTree(page, "papers/inside.md", { click: false });
  expect(existsSync(join(root, "papers", "inside.md"))).toBe(true);
  expect(existsSync(join(root, "docs"))).toBe(false);
  // The folder rename is one batch too (old child delete + new child write).
  await expectChangeSet(page, 5, /2 files/i);

  // --- Keyboard nav (ported WAI-ARIA tree model) ---
  await row(page, "manual.md").click();
  await page.keyboard.press("Home");
  const firstRow = tree(page).locator('[role="treeitem"]').first();
  await expect(firstRow).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(tree(page).locator('[role="treeitem"]').nth(1)).toBeFocused();
  // Collapse "notes" with ArrowLeft, re-expand with ArrowRight.
  await row(page, "notes").click(); // expands (click toggles) + focuses
  await expect(row(page, "notes")).toHaveAttribute("aria-expanded", "true");
  await page.keyboard.press("ArrowLeft");
  await expect(row(page, "notes")).toHaveAttribute("aria-expanded", "false");
  await page.keyboard.press("ArrowRight");
  await expect(row(page, "notes")).toHaveAttribute("aria-expanded", "true");
  // Enter on a focused file row opens it.
  await page.keyboard.press("ArrowDown"); // notes/b.md (first child)
  await expect(row(page, "notes/b.md")).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("tab-notes/b.md")).toBeVisible();

  // --- Delete (Del key + confirm naming the trash) — recoverable ---
  await row(page, "manual.md").click();
  await page.keyboard.press("Delete");
  const confirm = page.getByTestId("delete-confirm");
  await expect(confirm).toContainText("manual.md");
  await expect(confirm).toContainText(/trash/i);
  await page.getByTestId("confirm-delete").click();
  await expect(row(page, "manual.md")).toHaveCount(0);
  await expect.poll(() => existsSync(join(root, "manual.md"))).toBe(false);
  // Recovery location: OS trash or the workspace's .dohc/trash fallback —
  // the bytes MUST survive somewhere restorable.
  const recovered = await findInTrash(root, "manual.md");
  expect(recovered).not.toBeNull();
  expect(readFileSync(recovered!, "utf8")).toBe("# Readme\n");
  // The delete (to trash) reads as a plain delete to the watcher.
  await expectChangeSet(page, 6, "manual.md");

  // --- The explorer NEVER pollutes history with .dohc writes ---
  await expect(timeline).not.toContainText(".dohc");

  // Screenshots: the tree with an EXPANDED folder (notes: FolderOpen icon +
  // rotated chevron + children), a COLLAPSED one (papers), and an EMPTY one
  // (assets) all in frame — light + dark.
  await page.getByTestId("explorer-new-folder").click();
  await editbox.fill("assets");
  await editbox.press("Enter");
  await expect(row(page, "assets")).toBeVisible();
  await row(page, "papers").click(); // collapse (click toggles)
  await expect(row(page, "papers")).toHaveAttribute("aria-expanded", "false");
  await expect(row(page, "notes")).toHaveAttribute("aria-expanded", "true");
  await shotBothSchemes(page, "explorer-tree");

  await app.close();
});

test("drag-move into a folder (drop target + planDrop rules) and multi-select delete — change sets with the right paths", async () => {
  test.setTimeout(120_000);
  const { home, root } = await seedWorkspace("e3-dnd", {
    "a.md": "# A\n",
    "b.md": "# B\n",
    "c.md": "# C\n",
    "target/keep.md": "# Keep\n",
  });
  const { app, page } = await openSeeded(home, root);
  const timeline = page.getByTestId("history-timeline");

  // The drop-target highlight must actually RENDER: a background fill
  // (list.dropBackground style) asserted on the computed style — an
  // outline-based highlight was nulled by the base outline-none in the same
  // cascade layer and could never paint, and :hover is suppressed during
  // HTML5 drags, so this fill is the ONLY feedback the gesture has.
  await page.mouse.move(640, 400); // no stray hover on the asserted row
  const targetRow = row(page, "target");
  const rowBg = () =>
    targetRow.evaluate((el) => getComputedStyle(el).backgroundColor);
  expect(await rowBg()).toBe("rgba(0, 0, 0, 0)");
  const dataTransfer = await page.evaluateHandle(() => new DataTransfer());
  await row(page, "a.md").dispatchEvent("dragstart", { dataTransfer });
  await targetRow.dispatchEvent("dragover", { dataTransfer });
  await expect.poll(rowBg).not.toBe("rgba(0, 0, 0, 0)");
  await shotBothSchemes(page, "explorer-dragover");
  // Leaving the tree clears the highlight (no stuck drop state).
  await tree(page).dispatchEvent("dragleave");
  await expect.poll(rowBg).toBe("rgba(0, 0, 0, 0)");

  // Drag a.md onto the target folder row → move INTO it (planDrop rule).
  await row(page, "a.md").dragTo(row(page, "target"));
  await openInTree(page, "target/a.md", { click: false });
  await expect(row(page, "a.md")).toHaveCount(0);
  expect(existsSync(join(root, "target", "a.md"))).toBe(true);
  expect(existsSync(join(root, "a.md"))).toBe(false);
  // One settle batch: delete at the old path + write at the new one.
  await expectChangeSet(page, 1, /2 files/i);

  // Multi-select (ctrl+click) delete: ONE confirm for both, both trashed.
  await row(page, "b.md").click();
  await row(page, "c.md").click({ modifiers: ["Control"] });
  // Three readable states at once: b.md = strongest ACTIVE-tab fill, c.md =
  // lighter selected fill + focus ring. What the next destructive action
  // hits (the selection) must never be visually ambiguous.
  await shotBothSchemes(page, "explorer-multi-select");
  await page.keyboard.press("Delete");
  const confirm = page.getByTestId("delete-confirm");
  await expect(confirm).toContainText("2 items");
  await expect(confirm).toContainText(/trash/i);
  await shotBothSchemes(page, "explorer-delete-confirm");
  await page.getByTestId("confirm-delete").click();
  await expect(row(page, "b.md")).toHaveCount(0);
  await expect(row(page, "c.md")).toHaveCount(0);
  // Both deletes are async OS-trash round-trips — poll each to completion.
  await expect.poll(() => existsSync(join(root, "b.md"))).toBe(false);
  await expect.poll(() => existsSync(join(root, "c.md"))).toBe(false);
  expect(await findInTrash(root, "b.md")).not.toBeNull();
  expect(await findInTrash(root, "c.md")).not.toBeNull();
  // The two trashes settle into ONE recorded change set with both paths.
  await expectChangeSet(page, 2, /2 files/i);
  await expect(timeline).not.toContainText(".dohc");

  await app.close();
});

test("pin/unpin via the context-menu seam; pins AND expansion persist across relaunch (ui-state)", async () => {
  const { home, root } = await seedWorkspace("e3-pins", {
    "notes/today.md": "# Today\n",
    "readme.md": "# Readme\n",
  });
  const { app, page } = await openSeeded(home, root);

  await openInTree(page, "notes/today.md"); // expands notes + opens the file
  await setMenuChoice(app, "pin");
  await row(page, "notes/today.md").click({ button: "right" });
  const pinned = page.getByTestId("explorer-pinned");
  await expect(pinned).toBeVisible();
  await expect(pinned.locator('[data-path="notes/today.md"]')).toBeVisible();
  await shotBothSchemes(page, "explorer-pinned");

  // Let the debounced ui-state writer land before relaunching.
  const uiStatePath = join(root, ".dohc", "ui-state.json");
  await expect
    .poll(
      () => {
        try {
          return JSON.parse(readFileSync(uiStatePath, "utf8")) as object;
        } catch {
          return {};
        }
      },
      { timeout: 5000 },
    )
    .toMatchObject({ pinned: ["notes/today.md"], expandedFolders: ["notes"] });
  await app.close();

  // Relaunch: pins and the expanded notes folder both restore.
  const second = await launchApp({ DOHC_TEST_HOME: home });
  const page2 = await second.firstWindow();
  await expect(page2.getByTestId("workspace-shell")).toBeVisible();
  await expect(
    page2.getByTestId("explorer-pinned").locator('[data-path="notes/today.md"]'),
  ).toBeVisible();
  await expect(row(page2, "notes")).toHaveAttribute("aria-expanded", "true");
  await expect(row(page2, "notes/today.md")).toBeVisible();

  // Unpin from the pinned row's own context menu.
  await setMenuChoice(second, "unpin");
  await page2
    .getByTestId("explorer-pinned")
    .locator('[data-path="notes/today.md"]')
    .click({ button: "right" });
  await expect(page2.getByTestId("explorer-pinned")).toHaveCount(0);

  await second.close();
});

test("renaming the open file inside the autosave window keeps the typed draft (flush-before-move)", async () => {
  const { home, root } = await seedWorkspace("e3-draft", {
    "draft.md": "# Draft\n",
  });
  const { app, page } = await openSeeded(home, root);

  await row(page, "draft.md").click();
  await expect(page.getByTestId("tab-draft.md")).toBeVisible();
  await page.getByTestId("markdown-edit-toggle").click();
  const editor = page.getByTestId("markdown-editor");
  await expect(editor).toBeVisible();
  // Type INSIDE the 800ms autosave window, then rename immediately: the op
  // must flush the draft to the OLD path BEFORE the disk rename — otherwise
  // the keyed inspector remounts after the move and its unmount flush
  // writes to a renamed-away path (ENOENT, swallowed, keystrokes lost).
  await editor.fill("# Draft\ntyped-inside-the-autosave-window\n");
  await row(page, "draft.md").click();
  await page.keyboard.press("F2");
  const editbox = page.getByTestId("tree-edit-input");
  await expect(editbox).toBeVisible();
  await editbox.fill("renamed.md");
  await editbox.press("Enter");
  await expect(row(page, "renamed.md")).toBeVisible();
  await expect(row(page, "draft.md")).toHaveCount(0);
  await expect(page.getByTestId("tab-renamed.md")).toBeVisible();
  // The keystrokes survived INTO the renamed file — and the old path stayed
  // gone (the flush landed pre-move, never as a resurrecting write).
  await expect
    .poll(() => readFileSync(join(root, "renamed.md"), "utf8"))
    .toContain("typed-inside-the-autosave-window");
  expect(existsSync(join(root, "draft.md"))).toBe(false);

  await app.close();
});

// Pure zip reader (EOCD → central directory), so the export is verified
// against the FORMAT — the spec-side twin of `unzip -l`.
function listZip(zip: Buffer): string[] {
  const eocd = zip.length - 22;
  expect(zip.readUInt32LE(eocd)).toBe(0x06054b50);
  const count = zip.readUInt16LE(eocd + 10);
  let cursor = zip.readUInt32LE(eocd + 16);
  const names: string[] = [];
  for (let i = 0; i < count; i++) {
    expect(zip.readUInt32LE(cursor)).toBe(0x02014b50);
    const nameLength = zip.readUInt16LE(cursor + 28);
    const extraLength = zip.readUInt16LE(cursor + 30);
    const commentLength = zip.readUInt16LE(cursor + 32);
    names.push(zip.subarray(cursor + 46, cursor + 46 + nameLength).toString("utf8"));
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  return names;
}

test("export zip (folder + whole workspace) through the context-menu seam — the archive opens and excludes .dohc", async () => {
  const { home, root } = await seedWorkspace("e3-zip", {
    "notes/a.md": "# A\n",
    "notes/deep/b.md": "# B\n",
    "readme.md": "# Readme\n",
  });
  const { app, page } = await openSeeded(home, root);
  const outDir = await mkdtemp(join(tmpdir(), "dohc-e3-zip-out-"));

  // Folder export: right-click the notes folder, "Export as Zip…".
  const folderZip = join(outDir, "notes.zip");
  await setSavePath(app, folderZip);
  await setMenuChoice(app, "export-zip");
  await row(page, "notes").click({ button: "right" });
  await expect.poll(() => existsSync(folderZip), { timeout: 10_000 }).toBe(true);
  expect(listZip(readFileSync(folderZip)).sort()).toEqual([
    "notes/a.md",
    "notes/deep/b.md",
  ]);

  // Whole-workspace export: the ROOT context menu (container background).
  const wsZip = join(outDir, "workspace.zip");
  await setSavePath(app, wsZip);
  await setMenuChoice(app, "export-zip");
  const box = await tree(page).boundingBox();
  expect(box).not.toBeNull();
  // Right-click the empty area below the rows (the root menu surface).
  await tree(page).click({
    button: "right",
    position: { x: Math.round(box!.width / 2), y: Math.round(box!.height - 10) },
  });
  await expect.poll(() => existsSync(wsZip), { timeout: 10_000 }).toBe(true);
  const wsEntries = listZip(readFileSync(wsZip)).sort();
  expect(wsEntries).toEqual(["notes/a.md", "notes/deep/b.md", "readme.md"]);
  // dohc metadata NEVER exports.
  expect(wsEntries.some((name) => name.includes(".dohc"))).toBe(false);

  await app.close();
});

test("OS drag-in: the preload path resolver + the droppedPaths import seam (files only, never .dohc sources)", async () => {
  const { home, root } = await seedWorkspace("e3-drop", {
    "readme.md": "# Readme\n",
  });
  const { app, page } = await openSeeded(home, root);
  const timeline = page.getByTestId("history-timeline");

  // A real OS drop cannot be synthesized from Playwright: DataTransfer.files
  // built in JS are SYNTHETIC Files with no filesystem backing, so
  // webUtils.getPathForFile (the only path source under the sandbox) has
  // nothing to resolve — which is itself worth pinning at the bridge:
  const syntheticPaths = await page.evaluate(() =>
    window.dohcDesktop!.getDroppedFilePaths([
      new File(["x"], "fake.md", { type: "text/markdown" }),
    ]),
  );
  expect(syntheticPaths).toEqual([]);

  // So the E2E drives the SAME seam the drop handler uses one step further
  // in: preload-resolved absolute paths → importWorkspaceFiles#droppedPaths
  // → main re-validates (picker-grade) → copy lands → watcher records it.
  const outside = await mkdtemp(join(tmpdir(), "dohc-e3-dropsrc-"));
  await writeFile(join(outside, "dropped.md"), "# Dropped\n");
  const workspaceId = await page.evaluate(async () => {
    const registry = await window.dohcDesktop!.getWorkspaceRegistry();
    return registry.workspaces[0]!.workspaceId;
  });
  const imported = await page.evaluate(
    async ({ id, path }) =>
      (await window.dohcDesktop!.importWorkspaceFiles({
        workspaceId: id,
        droppedPaths: [path],
      })).imported,
    { id: workspaceId, path: join(outside, "dropped.md") },
  );
  expect(imported).toEqual(["dropped.md"]);
  await expect(row(page, "dropped.md")).toBeVisible({ timeout: 15_000 });
  expect(readFileSync(join(root, "dropped.md"), "utf8")).toBe("# Dropped\n");
  await expect(timeline).toContainText("dropped.md", { timeout: 15_000 });

  // The trust-delta guard: a dropped "file" inside any registered
  // workspace's .dohc (credentials, history) is refused by main.
  const refused = await page.evaluate(
    async ({ id, path }) =>
      (await window.dohcDesktop!.importWorkspaceFiles({
        workspaceId: id,
        droppedPaths: [path],
      })).imported,
    { id: workspaceId, path: join(root, ".dohc", "manifest.json") },
  );
  expect(refused).toEqual([]);
  await expect(row(page, "manifest.json")).toHaveCount(0);
  await expect(timeline).not.toContainText(".dohc");

  await app.close();
});
