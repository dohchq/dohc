import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import type { ElectronApplication } from "playwright";
import { launchDesktopApp } from "./helpers/desktopApp";
import {
  cleanupDesktopWorkspace,
  createTempWorkspace,
  explorerRow,
  openWorkspaceFromFirstRun,
  revealExplorerPath,
  seedWorkspaceSettings,
  waitForWorkspaceFile,
  writeWorkspaceFiles,
} from "./helpers/workspace";
import {
  cleanupTestScratch,
  createTestScratch,
} from "../src/workspaces/testTemp";

// A real 2x2 PNG (green/blue pixels). Bytes must decode to a paintable image so
// the assertions below (naturalWidth > 0) exercise the whole serve→decode path,
// not just an element attribute.
const PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEklEQVR4nGP4z8DAwAAi/gMJABvyA/1NQqYrAAAAAElFTkSuQmCC";
const PNG_BYTES = Buffer.from(PNG_BASE64, "base64");

test.afterEach(async () => {
  await cleanupTestScratch();
});

async function openMarkdownDoc(
  page: import("@playwright/test").Page,
  path: string,
): Promise<void> {
  await revealExplorerPath(page, path);
  await explorerRow(page, path).click();
  // A plain (non-engine) markdown file opens straight into the WYSIWYG editor.
  await expect(page.getByTestId("markdown-editor")).toBeVisible({ timeout: 15_000 });
}

// The image NodeView paints a workspace-relative src by rewriting it to the
// privileged dohc-file:// scheme at render time. Assert the <img> actually
// decoded (naturalWidth > 0) — an attribute-only check would pass even if CSP
// or the protocol silently blocked the load.
async function expectEditorImagePainted(
  page: import("@playwright/test").Page,
): Promise<void> {
  const img = page.locator(".dohc-editor-image");
  await expect(img).toBeVisible({ timeout: 15_000 });
  await expect
    .poll(
      async () => await img.first().evaluate((el) => (el as HTMLImageElement).naturalWidth),
      { timeout: 15_000 },
    )
    .toBeGreaterThan(0);
}

test("in-editor image: workspace-root doc renders a relative image", async () => {
  const temp = await createTempWorkspace();
  let desktop: Awaited<ReturnType<typeof launchDesktopApp>> | null = null;
  try {
    await writeWorkspaceFiles(temp, [
      { path: "assets/pic.png", contents: PNG_BYTES },
      { path: "note.md", contents: "# Note\n\n![pic](assets/pic.png)\n" },
    ]);
    desktop = await launchDesktopApp({ workspace: temp });
    const { page } = desktop;
    const workspace = await openWorkspaceFromFirstRun(page, temp);
    await waitForWorkspaceFile(page, workspace.workspaceId, "note.md");
    await openMarkdownDoc(page, "note.md");
    await expectEditorImagePainted(page);
  } finally {
    await cleanupDesktopWorkspace(desktop, temp);
  }
});

test("in-editor image: subfolder doc renders a relative image under its folder", async () => {
  const temp = await createTempWorkspace();
  let desktop: Awaited<ReturnType<typeof launchDesktopApp>> | null = null;
  try {
    await writeWorkspaceFiles(temp, [
      { path: "notes/assets/pic.png", contents: PNG_BYTES },
      { path: "notes/plan.md", contents: "# Plan\n\n![pic](assets/pic.png)\n" },
    ]);
    desktop = await launchDesktopApp({ workspace: temp });
    const { page } = desktop;
    const workspace = await openWorkspaceFromFirstRun(page, temp);
    await waitForWorkspaceFile(page, workspace.workspaceId, "notes/plan.md");
    await openMarkdownDoc(page, "notes/plan.md");
    await expectEditorImagePainted(page);
  } finally {
    await cleanupDesktopWorkspace(desktop, temp);
  }
});

test("in-editor image: a subfolder doc renders an UPWARD-relative image from the workspace root", async () => {
  // The global-folder attachment mode links a nested doc to one folder at the
  // workspace root with `../`. This proves the whole path is live: the relaxed
  // sanitizer preserves `..`, the resolver normalizes it back under the root,
  // and the dohc-file protocol serves the bytes (naturalWidth > 0).
  const temp = await createTempWorkspace();
  let desktop: Awaited<ReturnType<typeof launchDesktopApp>> | null = null;
  try {
    await writeWorkspaceFiles(temp, [
      { path: "attachments/pic.png", contents: PNG_BYTES },
      {
        path: "notes/plan.md",
        contents: "# Plan\n\n![pic](../attachments/pic.png)\n",
      },
    ]);
    desktop = await launchDesktopApp({ workspace: temp });
    const { page } = desktop;
    const workspace = await openWorkspaceFromFirstRun(page, temp);
    await waitForWorkspaceFile(page, workspace.workspaceId, "notes/plan.md");
    await openMarkdownDoc(page, "notes/plan.md");
    await expectEditorImagePainted(page);
  } finally {
    await cleanupDesktopWorkspace(desktop, temp);
  }
});

test("in-editor image: a link escaping the workspace root does NOT render", async () => {
  // `../../outside.png` from notes/ climbs above the workspace root. The
  // resolver refuses to mint a dohc-file:// URL for it AND refuses to hand the
  // raw path to the browser (which would resolve it against the renderer's own
  // page, outside the workspace entirely): the <img> ends up with NO src, so
  // nothing is ever requested — even though a real, decodable file exists at the
  // escape target. Containment holds without depending on the protocol layer to
  // reject the request.
  const temp = await createTempWorkspace();
  let desktop: Awaited<ReturnType<typeof launchDesktopApp>> | null = null;
  try {
    // A real, decodable PNG planted OUTSIDE the workspace root (temp.baseDir is
    // the parent of temp.rootPath) at the exact path the escape link targets.
    await writeFile(join(temp.baseDir, "outside.png"), PNG_BYTES);
    await writeWorkspaceFiles(temp, [
      {
        path: "notes/plan.md",
        contents: "# Plan\n\n![escape](../../outside.png)\n",
      },
    ]);
    desktop = await launchDesktopApp({ workspace: temp });
    const { page } = desktop;
    const workspace = await openWorkspaceFromFirstRun(page, temp);
    await waitForWorkspaceFile(page, workspace.workspaceId, "notes/plan.md");
    await openMarkdownDoc(page, "notes/plan.md");

    const img = page.locator(".dohc-editor-image").first();
    await expect(img).toBeAttached({ timeout: 15_000 });
    // The containment guarantee, asserted positively: no src attribute at all.
    // (Not `src=""` either — browsers re-request the page's own URL for that.)
    await expect
      .poll(async () => await img.evaluate((el) => el.getAttribute("src")), {
        timeout: 10_000,
      })
      .toBe(null);
    // ...and it was never rewritten to the privileged scheme on the way there.
    await expect(img).not.toHaveAttribute("src", /^dohc-file:\/\//);

    // Now prove it never decodes. `naturalWidth` is 0 BEFORE a load is even
    // attempted, so polling for the first 0 would pass trivially: give the
    // browser a real window to attempt (and finish) a load, then assert the
    // settled state once. An <img> with no src reports complete=true with
    // naturalWidth 0 and an empty currentSrc — i.e. it never fetched anything.
    await page.waitForTimeout(2_000);
    expect(
      await img.evaluate((el) => {
        const image = el as HTMLImageElement;
        return {
          hasSrc: image.hasAttribute("src"),
          naturalWidth: image.naturalWidth,
          currentSrc: image.currentSrc,
        };
      }),
    ).toEqual({ hasSrc: false, naturalWidth: 0, currentSrc: "" });
  } finally {
    await cleanupDesktopWorkspace(desktop, temp);
  }
});

// ── dragging an image FILE into a document ─────────────────────────────────

// Writes a real PNG to a temp dir OUTSIDE the workspace — the OS location a
// user actually drags from — and returns its absolute path.
async function pngOutsideWorkspace(): Promise<string> {
  const dir = await createTestScratch("dohc-drag-");
  const path = join(dir, "Dragged Shot.png");
  await writeFile(path, PNG_BYTES);
  return path;
}

// A REAL file drag, driven through Chromium's own drag machinery via CDP
// (Input.dispatchDragEvent carries actual OS file paths). This exercises the
// full path a user's drag takes — hit-testing included — which a synthetic
// `dispatchEvent("drop")` would bypass entirely.
async function dragFileOnto(
  app: ElectronApplication,
  page: Page,
  filePath: string,
  point: { x: number; y: number },
): Promise<void> {
  const cdp = await app.context().newCDPSession(page);
  const data = { items: [], files: [filePath], dragOperationsMask: 1 };
  const { x, y } = point;
  await cdp.send("Input.dispatchDragEvent", { type: "dragEnter", x, y, data });
  await cdp.send("Input.dispatchDragEvent", { type: "dragOver", x, y, data });
  await cdp.send("Input.dispatchDragEvent", { type: "drop", x, y, data });
  await cdp.detach();
}

async function centerOf(page: Page, testId: string) {
  const box = await page.getByTestId(testId).boundingBox();
  if (!box) throw new Error(`${testId} has no bounding box`);
  return { x: Math.round(box.x + box.width / 2), y: Math.round(box.y + 40) };
}

test("dragging an image file onto the editor embeds it into the configured attachments folder", async () => {
  const temp = await createTempWorkspace();
  let desktop: Awaited<ReturnType<typeof launchDesktopApp>> | null = null;
  try {
    // global-folder: bytes land in ONE folder at the workspace root, and the
    // nested doc's src has to climb to it — so this proves the drop path runs
    // the attachment-location logic rather than hardcoding `assets/`.
    await seedWorkspaceSettings(temp, {
      files: { attachmentLocation: "global-folder", attachmentFolderName: "attachments" },
    });
    await writeWorkspaceFiles(temp, [
      { path: "notes/plan.md", contents: "# Plan\n\nDrop below.\n" },
    ]);
    const dragged = await pngOutsideWorkspace();

    desktop = await launchDesktopApp({ workspace: temp });
    const { page, app } = desktop;
    const workspace = await openWorkspaceFromFirstRun(page, temp);
    await waitForWorkspaceFile(page, workspace.workspaceId, "notes/plan.md");
    await openMarkdownDoc(page, "notes/plan.md");

    await dragFileOnto(app, page, dragged, await centerOf(page, "markdown-editor"));

    // The image renders — the whole write → dohc-file:// serve → decode path.
    await expectEditorImagePainted(page);

    // ...and the bytes landed in the CONFIGURED folder at the workspace root,
    // under the slug+hash asset name, not next to the document.
    await expect
      .poll(async () => await readdir(join(temp.rootPath, "attachments")).catch(() => []))
      .toEqual([expect.stringMatching(/^dragged-shot-[0-9a-z]+\.png$/)]);
    const [written] = await readdir(join(temp.rootPath, "attachments"));
    expect(await readFile(join(temp.rootPath, "attachments", written!))).toEqual(
      PNG_BYTES,
    );

    // The node's src is the document-relative form that climbs to the root.
    await expect(page.locator(".dohc-editor-image").first()).toHaveAttribute(
      "src",
      /^dohc-file:\/\/.*\/attachments\/dragged-shot-[0-9a-z]+\.png$/,
    );
  } finally {
    await cleanupDesktopWorkspace(desktop, temp);
  }
});

test("dragging an image onto the page top-matter (outside ProseMirror) still embeds it", async () => {
  // The regression this guards: file-drop embedding used to live ONLY in
  // ProseMirror's handleDrop, which never runs for drops outside view.dom.
  // The document pane is bigger than view.dom — the title/icon/properties
  // top-matter sits in the same scroller — so dropping an image up there was
  // silently swallowed (Chromium's default file handling, denied by Electron's
  // will-navigate guard). The pane-level drop zone makes it embed.
  const temp = await createTempWorkspace();
  let desktop: Awaited<ReturnType<typeof launchDesktopApp>> | null = null;
  try {
    await writeWorkspaceFiles(temp, [{ path: "note.md", contents: "# Note\n\nBody.\n" }]);
    const dragged = await pngOutsideWorkspace();

    desktop = await launchDesktopApp({ workspace: temp });
    const { page, app } = desktop;
    const workspace = await openWorkspaceFromFirstRun(page, temp);
    await waitForWorkspaceFile(page, workspace.workspaceId, "note.md");
    await openMarkdownDoc(page, "note.md");

    // Aim at the document TITLE — inside the pane, outside the editor content.
    const title = page.locator(".dohc-page-identity__title").first();
    await expect(title).toBeVisible();
    const box = await title.boundingBox();
    if (!box) throw new Error("no title box");
    await dragFileOnto(app, page, dragged, {
      x: Math.round(box.x + box.width / 2),
      y: Math.round(box.y + box.height / 2),
    });

    await expectEditorImagePainted(page);
    await expect
      .poll(async () => await readdir(join(temp.rootPath, "assets")).catch(() => []))
      .toEqual([expect.stringMatching(/^dragged-shot-[0-9a-z]+\.png$/)]);
  } finally {
    await cleanupDesktopWorkspace(desktop, temp);
  }
});

test("/image opens the native picker and embeds the chosen file", async () => {
  // The picker is a MAIN-process dialog (it must open AT the workspace root,
  // which a renderer <input type=file> cannot do). Native dialogs can't be
  // driven by Playwright, so main honors the DOHC_TEST_PICK_IMAGE_PATHS seam —
  // the same shape as DOHC_TEST_PICK_PATH / DOHC_TEST_SAVE_PATH. Everything
  // after the dialog (read → IPC → write → insert → render) is the real path.
  const temp = await createTempWorkspace();
  let desktop: Awaited<ReturnType<typeof launchDesktopApp>> | null = null;
  try {
    await writeWorkspaceFiles(temp, [
      { path: "notes/plan.md", contents: "# Plan\n\nPick below.\n" },
    ]);
    const picked = await pngOutsideWorkspace();

    desktop = await launchDesktopApp({
      workspace: temp,
      env: { DOHC_TEST_PICK_IMAGE_PATHS: JSON.stringify([picked]) },
    });
    const { page } = desktop;
    const workspace = await openWorkspaceFromFirstRun(page, temp);
    await waitForWorkspaceFile(page, workspace.workspaceId, "notes/plan.md");
    await openMarkdownDoc(page, "notes/plan.md");

    const editor = page.getByTestId("markdown-editor");
    await editor.click();
    await page.keyboard.press("Control+End");
    await page.keyboard.press("Enter");
    await page.keyboard.type("/image", { delay: 30 });
    await expect(page.locator(".dohc-slash-menu__item").first()).toBeVisible();
    await page.keyboard.press("Enter");

    // The picked bytes travel the SAME write+insert path paste/drop use, so the
    // default per-document setting puts them in the doc's own assets folder.
    await expectEditorImagePainted(page);
    await expect
      .poll(async () => await readdir(join(temp.rootPath, "notes/assets")).catch(() => []))
      .toEqual([expect.stringMatching(/^dragged-shot-[0-9a-z]+\.png$/)]);
  } finally {
    await cleanupDesktopWorkspace(desktop, temp);
  }
});

test("opening an image file directly in the media viewer does not crash", async () => {
  const temp = await createTempWorkspace();
  let desktop: Awaited<ReturnType<typeof launchDesktopApp>> | null = null;
  try {
    await writeWorkspaceFiles(temp, [
      { path: "assets/pic.png", contents: PNG_BYTES },
    ]);
    desktop = await launchDesktopApp({ workspace: temp });
    const { page } = desktop;
    const workspace = await openWorkspaceFromFirstRun(page, temp);
    await waitForWorkspaceFile(page, workspace.workspaceId, "assets/pic.png");
    await revealExplorerPath(page, "assets/pic.png");
    await explorerRow(page, "assets/pic.png").click();

    const view = page.getByTestId("view-image");
    await expect(view).toBeVisible({ timeout: 15_000 });
    const img = view.locator("img");
    await expect
      .poll(
        async () => await img.evaluate((el) => (el as HTMLImageElement).naturalWidth),
        { timeout: 15_000 },
      )
      .toBeGreaterThan(0);

    // The window must still be alive (a crash would tear down the renderer).
    expect(desktop.app.windows().length).toBeGreaterThan(0);
    expect(await page.evaluate(() => 1 + 1)).toBe(2);
  } finally {
    await cleanupDesktopWorkspace(desktop, temp);
  }
});
