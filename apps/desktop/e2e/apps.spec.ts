import { expect, test } from "@playwright/test";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, readFile, rename } from "node:fs/promises";
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

// A click in the preview never reaches the page, so Preview options closes
// when the preview takes focus.
test("@apps closes Preview options when a click lands in the preview", async () => {
  const temp = await createTempWorkspace();
  let desktop: Awaited<ReturnType<typeof launchDesktopApp>> | null = null;

  try {
    await writeWorkspaceFiles(temp, [
      {
        path: "demo/index.html",
        contents: "<!doctype html><title>Launch app</title><main><button>Inside the app</button></main>",
      },
    ]);
    desktop = await launchDesktopApp({ workspace: temp });
    const page = desktop.page;
    await openWorkspaceFromFirstRun(page, temp);

    await page.getByTestId("activity-sites").click();
    await page.locator('[data-testid="sites-row"][data-root="demo"]').click();
    const frame = page.frameLocator('[data-testid="site-preview-frame"]');
    await expect(frame.getByRole("button", { name: "Inside the app" })).toBeVisible({ timeout: 20_000 });

    // The titlebar stops being a drag region while the menu is open, so a
    // press on it reaches the page too.
    const titlebarRegion = () =>
      page.getByTestId("titlebar").evaluate((element) => getComputedStyle(element).getPropertyValue("-webkit-app-region"));
    expect(await titlebarRegion()).toBe("drag");
    await page.getByTestId("site-preview-options").click();
    const staticMode = page.getByTestId("site-preview-static");
    await expect(staticMode).toBeVisible();
    expect(await titlebarRegion()).toBe("no-drag");
    await frame.getByRole("button", { name: "Inside the app" }).click();
    await expect(staticMode).toBeHidden();
    expect(await titlebarRegion()).toBe("drag");
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

test("@apps finds an app declared only by app.publish.json and publishes it again after its folder moves", async ({}, info) => {
  test.setTimeout(240_000);
  const workspace = await createTempWorkspace(), workspaceId = randomUUID(), userId = "moved-app-owner";
  const exchangeKey = randomBytes(32).toString("base64url");
  let desktop: Awaited<ReturnType<typeof launchDesktopApp>> | null = null;
  let relay: SyncRelayHandle | null = null;
  let shared: Awaited<ReturnType<typeof startSharedDatasetBrowser>> | null = null;
  try {
    await writeWorkspaceFiles(workspace, [
      { path: "poll/app.publish.json", contents: JSON.stringify({ entryPath: "main.ts", inputs: ["main.ts", "style.css"], packageMap: {} }) },
      { path: "poll/main.ts", contents: 'import "./style.css";\ndocument.body.innerHTML = "<h1>Trip poll</h1>";\n' },
      { path: "poll/style.css", contents: "h1 { color: rgb(4, 5, 6); }\n" },
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

    const publishAndOpen = async (root: string) => {
      await page.locator(`[data-testid="sites-row"][data-root="${root}"]`).click();
      await expect(page.getByTestId("site-preview-page").getByRole("button", { name: "Review and open app", exact: true })).toBeVisible();
      await page.getByTestId("site-preview-publish").click();
      const publication = page.getByTestId("app-publication-dialog");
      await publication.getByRole("button", { name: "Share app folder", exact: true }).click();
      const share = page.getByTestId("share-dialog");
      await share.getByRole("radio", { name: "Anyone with the link", exact: true }).click();
      await share.getByRole("radiogroup", { name: "Link access" }).getByRole("radio", { name: "View", exact: true }).click();
      await share.getByRole("button", { name: "Create link", exact: true }).click();
      const linkUrl = (await share.getByTestId("share-link-url").textContent())!;
      await share.getByRole("button", { name: "Close", exact: true }).click();
      await page.getByTestId("site-preview-publish").click();
      await publication.getByRole("combobox", { name: "Publication share link" }).selectOption({ index: 1 });
      await publication.getByRole("button", { name: "Prepare app", exact: true }).click();
      await expect(publication.getByRole("heading", { name: "Review app publication", exact: true })).toBeVisible();
      await expect(publication.getByTestId("app-publication-source-paths")).toContainText(`${root}/main.ts`);
      await publication.getByRole("button", { name: "Publish this revision", exact: true }).click();
      await expect(publication.getByRole("status").filter({ hasText: "App published on the selected link." })).toBeVisible();
      await publication.getByRole("button", { name: "Close publication", exact: true }).click();
      const guest = await shared!.browser.newPage();
      guest.on("pageerror", error => shared!.failures.push(error.message));
      await guest.goto(linkUrl);
      await guest.getByRole("button", { name: "Open app", exact: true }).click();
      const heading = guest.frameLocator("iframe").getByRole("heading", { name: "Trip poll", exact: true });
      await expect(heading).toHaveCSS("color", "rgb(4, 5, 6)");
      await guest.screenshot({ path: info.outputPath(`${root.replaceAll("/", "-")}-guest.png`) });
      await guest.close();
    };

    await publishAndOpen("poll");
    await mkdir(path.join(workspace.rootPath, "trip"));
    await rename(path.join(workspace.rootPath, "poll"), path.join(workspace.rootPath, "trip", "poll"));
    await expect(page.locator('[data-testid="sites-row"][data-root="poll"]')).toHaveCount(0);
    await publishAndOpen("trip/poll");
    expect(shared.failures).toEqual([]);
  } finally {
    try { await shared?.close(); } finally {
      try { await relay?.stop(); } finally { await cleanupDesktopWorkspace(desktop, workspace); }
    }
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
    <link rel="stylesheet" href="./styles.css" id="sheet">
    <style>h1 { letter-spacing: 2px; }</style>
    <style media="print">main { color: rgb(255, 0, 0); }</style>
    <script type="application/json" id="config">{"heading":"Reading list"}</script>
    <script>window.steps = ["head:" + JSON.parse(document.getElementById("config").textContent).heading + ":" + !!document.querySelector("main") + ":" + !!document.getElementById("sheet")];
      queueMicrotask(() => steps.push("microtask"));</script>
  </head>
  <body class="shelf" style="background-image: url(img/cover-2x.png)">
    <main>
      <h1>Reading list</h1>
      <div id="box"><script>steps.push("box:" + document.currentScript.parentElement.id + ":" + !!document.getElementById("books"));</script></div>
      <ul id="books"></ul>
      <img alt="Cover" src="cover.png">
      <img alt="Sharp cover" srcset="cover.png 1x, img/cover-2x.png 2x">
      <img alt="" name="createElement" src="cover.png">
      <p role="status"></p>
      <p id="order"></p>
    </main>
    <script src="books.js"></script>
    <script>throw new Error("A broken script stops only itself.");</script>
    <script>
      for (const title of books) {
        const item = document.createElement("li");
        item.textContent = title;
        document.getElementById("books").append(item);
      }
      steps.push("classic");
    </script>
    <script type="module">steps.push("A"); throw new Error("A broken module stops only itself.");</script>
    <script defer src="later.js"></script>
    <script type="module" src="./count.js"></script>
  </body>
</html>
` },
      { path: "reading-list/styles.css", contents: ".shelf main { color: rgb(1, 2, 3); background: url(img/cover-2x.png) repeat; }\n" },
      { path: "reading-list/later.js", contents: 'steps.push("B:" + document.currentScript.hasAttribute("defer"));\n' },
      { path: "reading-list/img/cover-2x.png", contents: coverPng },
      { path: "reading-list/books.js", contents: 'const books = ["The Design of Everyday Things", "Thinking in Systems"];\n' },
      { path: "reading-list/count.js", contents: 'document.querySelector("[role=status]").textContent = `${document.querySelectorAll("li").length} books`;\nsteps.push("C");\ndocument.getElementById("order").textContent = steps.join(" ");\n' },
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
    for (const file of ["index.html", "styles.css", "books.js", "later.js", "count.js", "cover.png", "img/cover-2x.png"]) await expect(sources).toContainText(`reading-list/${file}`);
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
    await expect.poll(() => app.getByRole("img", { name: "Cover", exact: true }).evaluate(image => (image as HTMLImageElement).naturalWidth)).toBe(1);
    await expect(app.getByRole("img", { name: "Sharp cover" })).toHaveAttribute("srcset", /^data:image\/png;base64,\S+ 1x, data:image\/png;base64,\S+ 2x$/);
    await expect(app.locator("body")).toHaveCSS("background-image", /^url\("data:image\/png;base64,/);
    await expect(app.locator("main")).toHaveCSS("background-image", /^url\("data:image\/png;base64,/);
    // Under the published hash-only policy the page runs as in a tab: head content and its ids stay, each classic script
    // sees only what precedes it, a throw stops only its own script, and deferred and module scripts run in document order.
    await expect(app.locator("#config")).toHaveCount(1);
    // The browser parses the page itself: a microtask runs between two scripts, and each stylesheet keeps its id and place.
    await expect(app.locator("#order")).toHaveText("head:Reading list:false:true microtask box:box:false classic A B:true C");
    await expect(app.locator("#sheet")).toHaveJSProperty("tagName", "STYLE");
    await guest.screenshot({ path: info.outputPath("static-app-guest.png") });
    expect(shared.failures.filter(message => !/A broken (?:script|module) stops only itself\./.test(message))).toEqual([]);
  } finally {
    try { await shared?.close(); } finally {
      try { await relay?.stop(); } finally { await cleanupDesktopWorkspace(desktop, workspace); }
    }
  }
});
