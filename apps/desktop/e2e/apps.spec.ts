import { expect, test } from "@playwright/test";
import { randomBytes, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { launchDesktopApp } from "./helpers/desktopApp";
import { sharedDatasetViewerOrigin, startSharedDatasetBrowser } from "./helpers/sharedDatasetBrowser";
import { spawnSyncRelay, type SyncRelayHandle } from "./helpers/syncRelay";
import {
  cleanupDesktopWorkspace,
  createTempWorkspace,
  openWorkspaceFromFirstRun,
  seedCloudCredentials,
  seedWorkspaceManifest,
  seedWorkspaceRegistry,
  writeWorkspaceFiles,
} from "./helpers/workspace";

test("@apps opens a static workspace app in the sandboxed preview", async () => {
  const temp = await createTempWorkspace();
  let desktop: Awaited<ReturnType<typeof launchDesktopApp>> | null = null;
  const sentinel = "Static app preview crossed the Electron boundary.";

  try {
    await writeWorkspaceFiles(temp, [
      {
        path: "demo/index.html",
        contents: `<!doctype html><title>Launch app</title><main>${sentinel}</main>`,
      },
    ]);

    desktop = await launchDesktopApp({ workspace: temp });
    const page = desktop.page;
    await openWorkspaceFromFirstRun(page, temp);

    await page.getByTestId("activity-sites").click();
    await expect(page.getByTestId("sites-view")).toBeVisible();
    const app = page.locator('[data-testid="sites-row"][data-root="demo"]');
    await expect(app).toBeVisible({ timeout: 20_000 });
    await app.click();

    await expect(page.getByTestId("site-preview-page")).toBeVisible();
    await expect(page.getByTestId("site-preview-frame")).toBeVisible({
      timeout: 20_000,
    });
    await expect(
      page
        .frameLocator('[data-testid="site-preview-frame"]')
        .locator("main"),
    ).toHaveText(sentinel);

    const frame = page.getByTestId("site-preview-frame");
    for (const theme of ["dark", "light"] as const) {
      await page.evaluate((nextTheme) => {
        document.documentElement.dataset.theme = nextTheme;
      }, theme);
      await expect
        .poll(() =>
          frame.evaluate((element) => {
            const style = getComputedStyle(element);
            return {
              backgroundColor: style.backgroundColor,
              colorScheme: style.colorScheme,
            };
          }),
        )
        .toEqual({
          backgroundColor: "rgb(255, 255, 255)",
          colorScheme: "light",
        });
    }
  } finally {
    await cleanupDesktopWorkspace(desktop, temp);
  }
});

test("@apps creates and opens the first app inside an existing app folder", async () => {
  const temp = await createTempWorkspace();
  let desktop: Awaited<ReturnType<typeof launchDesktopApp>> | null = null;

  try {
    await writeWorkspaceFiles(temp, [
      { path: "app/notes.txt", contents: "Keep this file.\n" },
    ]);
    desktop = await launchDesktopApp({ workspace: temp });
    const page = desktop.page;
    await openWorkspaceFromFirstRun(page, temp);

    await page.getByTestId("activity-sites").click();
    await expect(page.getByTestId("sites-count")).toContainText("0 apps");
    await page.screenshot({ path: test.info().outputPath("apps-empty.png") });
    await page.getByRole("button", { name: "Create app" }).click();

    await expect(page.getByTestId("site-preview-page")).toBeVisible();
    await expect(page.getByTestId("site-preview-frame")).toBeVisible({
      timeout: 20_000,
    });
    await expect(
      page
        .frameLocator('[data-testid="site-preview-frame"]')
        .getByRole("heading", { name: "My app" }),
    ).toBeVisible();
    await expect
      .poll(() => readFile(path.join(temp.rootPath, "app", "index.html"), "utf8"))
      .toContain("<h1>My app</h1>");
  } finally {
    await cleanupDesktopWorkspace(desktop, temp);
  }
});

// A 1x1 PNG, so the published page proves it embeds a local image.
const coverPng = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");

test("@apps publishes a static app that a guest opens by link", async ({}, info) => {
  test.setTimeout(180_000);
  const workspace = await createTempWorkspace(), workspaceId = randomUUID(), userId = "static-app-owner";
  const exchangeKey = randomBytes(32).toString("base64url");
  let desktop: Awaited<ReturnType<typeof launchDesktopApp>> | null = null;
  let relay: SyncRelayHandle | null = null;
  let shared: Awaited<ReturnType<typeof startSharedDatasetBrowser>> | null = null;
  try {
    await writeWorkspaceFiles(workspace, [
      { path: "reading-list/index.html", contents: `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <title>Reading list</title>
    <link rel="stylesheet" href="./styles.css">
    <style>h1 { letter-spacing: 2px; }</style>
  </head>
  <body class="shelf">
    <main>
      <h1>Reading list</h1>
      <ul id="books"></ul>
      <img alt="Cover" src="cover.png">
      <p role="status"></p>
    </main>
    <script src="books.js"></script>
    <script>
      for (const title of books) {
        const item = document.createElement("li");
        item.textContent = title;
        document.getElementById("books").append(item);
      }
    </script>
    <script type="module" src="./count.js"></script>
  </body>
</html>
` },
      { path: "reading-list/styles.css", contents: ".shelf main { color: rgb(1, 2, 3); }\n" },
      { path: "reading-list/books.js", contents: 'const books = ["The Design of Everyday Things", "Thinking in Systems"];\n' },
      { path: "reading-list/count.js", contents: 'document.querySelector("[role=status]").textContent = `${document.querySelectorAll("li").length} books`;\n' },
      { path: "reading-list/cover.png", contents: coverPng },
    ]);
    relay = await spawnSyncRelay({ dbPath: path.join(workspace.baseDir, "relay.sqlite"), appPublications: true,
      linkBoundary: { linkKey: randomBytes(32).toString("base64url"), relayExchangeKey: exchangeKey, publicViewerOrigin: sharedDatasetViewerOrigin } });
    const claim = await fetch(`${relay.baseUrl}/sync/workspaces`, { method: "POST", headers: { authorization: `Bearer test:${userId}`, "content-type": "application/json" }, body: JSON.stringify({ workspaceId }) });
    expect(claim.ok).toBe(true);
    await seedWorkspaceManifest(workspace, workspaceId);
    await seedWorkspaceRegistry(workspace, [{ workspaceId, rootPath: workspace.rootPath, remote: { serverUrl: relay.baseUrl, ownerUserId: userId } }]);
    await seedCloudCredentials(workspace, { serverUrl: relay.baseUrl, relayUrl: relay.baseUrl, userId, token: `test:${userId}` });
    shared = await startSharedDatasetBrowser({ relayUrl: relay.baseUrl, exchangeKey });
    desktop = await launchDesktopApp({ workspace });
    const { page } = desktop;
    await openWorkspaceFromFirstRun(page, workspace);

    await page.getByTestId("activity-sites").click();
    await page.locator('[data-testid="sites-row"][data-root="reading-list"]').click();
    await expect(page.getByTestId("site-preview-page")).toBeVisible();
    await page.getByTestId("site-preview-publish").click();
    const publication = page.getByTestId("app-publication-dialog");
    await publication.getByRole("button", { name: "Share app folder", exact: true }).click();
    const share = page.getByTestId("share-dialog");
    await share.getByRole("radio", { name: "Anyone with the link", exact: true }).click();
    await share.getByRole("radiogroup", { name: "Link access" }).getByRole("radio", { name: "View", exact: true }).click();
    await share.getByRole("button", { name: "Create link", exact: true }).click();
    const linkUrl = (await share.getByTestId("share-link-url").textContent())!;
    expect(new URL(linkUrl).origin).toBe(sharedDatasetViewerOrigin);
    await share.getByRole("button", { name: "Close", exact: true }).click();

    await page.getByTestId("site-preview-publish").click();
    await publication.getByRole("combobox", { name: "Publication share link" }).selectOption({ index: 1 });
    await publication.getByRole("button", { name: "Prepare app", exact: true }).click();
    await expect(publication.getByRole("heading", { name: "Review app publication", exact: true })).toBeVisible();
    const sources = publication.getByTestId("app-publication-source-paths");
    for (const file of ["index.html", "styles.css", "books.js", "count.js", "cover.png"]) await expect(sources).toContainText(`reading-list/${file}`);
    await page.screenshot({ path: info.outputPath("static-app-review.png") });
    await publication.getByRole("button", { name: "Publish this revision", exact: true }).click();
    await expect(publication.getByRole("status").filter({ hasText: "App published on the selected link." })).toBeVisible();
    await publication.getByRole("button", { name: "Close publication", exact: true }).click();

    const guest = await shared.browser.newPage();
    guest.on("pageerror", error => shared!.failures.push(error.message));
    await guest.goto(linkUrl);
    await guest.getByRole("button", { name: "Open app", exact: true }).click();
    const app = guest.frameLocator("iframe");
    await expect(app.getByRole("heading", { name: "Reading list", exact: true })).toBeVisible();
    await expect(app.getByRole("listitem")).toHaveText(["The Design of Everyday Things", "Thinking in Systems"]);
    await expect(app.getByRole("status")).toHaveText("2 books");
    await expect(app.locator("main")).toHaveCSS("color", "rgb(1, 2, 3)");
    await expect(app.getByRole("heading", { name: "Reading list", exact: true })).toHaveCSS("letter-spacing", "2px");
    await expect.poll(() => app.getByRole("img", { name: "Cover" }).evaluate(image => (image as HTMLImageElement).naturalWidth)).toBe(1);
    await guest.screenshot({ path: info.outputPath("static-app-guest.png") });
    expect(shared.failures).toEqual([]);
  } finally {
    try { await shared?.close(); } finally {
      try { await relay?.stop(); } finally { await cleanupDesktopWorkspace(desktop, workspace); }
    }
  }
});
