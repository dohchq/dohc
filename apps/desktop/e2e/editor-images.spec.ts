import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { launchDesktopApp } from "./helpers/desktopApp";
import {
  cleanupDesktopWorkspace,
  createTempWorkspace,
  explorerRow,
  openWorkspaceFromFirstRun,
  revealExplorerPath,
  waitForWorkspaceFile,
  writeWorkspaceFiles,
} from "./helpers/workspace";

// A real 2x2 PNG (green/blue pixels). Bytes must decode to a paintable image so
// the assertions below (naturalWidth > 0) exercise the whole serve→decode path,
// not just an element attribute.
const PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEklEQVR4nGP4z8DAwAAi/gMJABvyA/1NQqYrAAAAAElFTkSuQmCC";
const PNG_BYTES = Buffer.from(PNG_BASE64, "base64");

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
  // resolver refuses to mint a dohc-file:// URL for it, so the <img> keeps its
  // raw (unservable) src and never decodes — even though a real file exists at
  // the escape target. Containment holds without depending on the protocol
  // layer to reject the request.
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

    const img = page.locator(".dohc-editor-image");
    await expect(img).toBeVisible({ timeout: 15_000 });
    // The src is left as the raw path — never rewritten to the privileged
    // dohc-file:// scheme — and the image never decodes.
    await expect(img.first()).not.toHaveAttribute("src", /^dohc-file:\/\//);
    await expect
      .poll(
        async () =>
          await img
            .first()
            .evaluate((el) => (el as HTMLImageElement).naturalWidth),
        { timeout: 5_000 },
      )
      .toBe(0);
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
