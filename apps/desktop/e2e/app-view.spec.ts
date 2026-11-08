import { expect, test, type ElectronApplication, type Locator, type Page } from "@playwright/test";
import { mkdir, readdir } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { editorTabTestId } from "../src/testPins";
import { siteTabPath } from "../src/renderer/workbench/workbenchState";
import { launchDesktopApp } from "./helpers/desktopApp";
import { cleanupDesktopWorkspace, createTempWorkspace, explorerRow, openExplorerHome, openWorkspaceFromFirstRun, showExplorerFiles, writeWorkspaceFiles } from "./helpers/workspace";
import type { AppViewEvent } from "../src/ipc/bridgeContract";

type MainProbe = typeof globalThis & { __appViewProbe?: {
  urls: string[];
  openExternal: typeof import("electron").shell.openExternal;
  attaches: Array<{ src: string; refused: boolean; partition: string }>;
  guestsCreated: number;
} };
type FrameProbe = typeof globalThis & { __appViewFrames?: Array<{ url: string; error: string | null }> };
type RendererProbe = Window & { __appViewEvents?: AppViewEvent[]; __stopAppViewEvents?: () => void };
const appRoot = "registrations-form";
const frontend = `
const main = document.createElement('main');
main.innerHTML = '<h1>App isolation fixture</h1><a id="blank" target="_blank" href="https://example.com/blank">New window</a> <a id="plain" href="https://example.com/plain">Plain link</a> <a id="javascript" href="javascript:void(0)">Script link</a> <a id="file" href="file:///dohc-app-view-sentinel.txt">File link</a> <a id="mailto" href="mailto:app-view@example.com">Mail link</a> <button id="popup">Window open</button> <a id="download" download="app-view-sentinel.txt" href="data:text/plain,blocked">Download</a> <button id="permission">Permission</button> <output id="permission-result"></output> <button id="counter">Count</button> <output id="count">0</output> <input id="focus" aria-label="App input">';
document.body.append(main);
document.getElementById('popup').addEventListener('click', () => window.open('https://example.com/popup'));
document.getElementById('permission').addEventListener('click', async () => { document.getElementById('permission-result').textContent = await Notification.requestPermission(); });
document.getElementById('counter').addEventListener('click', () => { const out = document.getElementById('count'); out.textContent = String(Number(out.textContent) + 1); });
`;

async function guestIds(app: ElectronApplication) {
  return app.evaluate(({ webContents }) => webContents.getAllWebContents()
    .filter(contents => contents.getType() === "webview" && /^http:\/\/127\.0\.0\.1:\d+\/bootstrap(?:#|$)/.test(contents.getURL()))
    .map(contents => contents.id));
}
async function inFrame(app: ElectronApplication, id: number, script: string, child = true): Promise<unknown> {
  return app.evaluate(async ({ webContents }, input) => {
    const contents = webContents.fromId(input.id);
    if (!contents) throw Error("App guest disappeared.");
    const frame = input.child ? contents.mainFrame.framesInSubtree.find(frame => frame.url === "about:srcdoc") : contents.mainFrame;
    if (!frame) throw Error("App frame has not loaded.");
    return frame.executeJavaScript(input.script, true);
  }, { id, script, child });
}
async function clickApp(app: ElectronApplication, id: number, selector: string) {
  await inFrame(app, id, `document.querySelector(${JSON.stringify(selector)}).click(); true`);
}
async function ready(page: Page) {
  const view = page.getByTestId("app-view-webview");
  await shown(view);
  await expect(view).not.toHaveClass(/opacity-0/);
  await expect(page.getByTestId("app-view-loading")).toHaveCount(0);
}
// A real click, routed from dohc's window into the app. Only a press lets a link leave dohc.
async function pressApp(page: Page, app: ElectronApplication, id: number, selector: string) {
  const view = (await page.getByTestId("app-view-webview").boundingBox())!;
  const [frameX, frameY] = await inFrame(app, id,
    "(() => { const r = document.querySelector('iframe').getBoundingClientRect(); return [r.left, r.top]; })()", false) as [number, number];
  const [x, y] = await inFrame(app, id, `(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; })()`) as [number, number];
  await page.mouse.click(view.x + frameX + x, view.y + frameY + y);
}
// A <webview> that dohc didn't issue, added by the window's own page with its own preload and partition.
async function injectGuest(page: Page, src: string, preload: string) {
  await page.evaluate(({ src, preload }) => {
    const view = document.createElement("webview");
    view.setAttribute("partition", "persist:injected");
    view.setAttribute("preload", preload);
    view.setAttribute("src", src);
    view.dataset.injected = "true";
    document.body.append(view);
  }, { src, preload });
}
// A person's drag of a tab into another group, as workspace-editor-groups.spec.ts makes it.
async function dragTabTo(page: Page, tab: Locator, group: Locator) {
  const from = (await tab.boundingBox())!;
  const to = (await group.boundingBox())!;
  await page.mouse.move(from.x + Math.min(16, from.width / 2), from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(to.x + to.width / 2, to.y + 80, { steps: 8 });
  await page.mouse.up();
}
async function shown(locator: Locator) { await expect.poll(() => locator.isVisible()).toBe(true); }
async function hidden(locator: Locator) { await expect.poll(() => locator.isVisible()).toBe(false); }

async function overlayAboveApp(page: Page, overlay: Locator) {
  await expect.poll(() => overlay.evaluate(element => {
    const app = document.querySelector('[data-testid="app-view-webview"]');
    if (!app) return false;
    // The overlay must cover part of the app, and be on top at the middle of that part.
    const a = app.getBoundingClientRect(), b = element.getBoundingClientRect();
    const left = Math.max(a.left, b.left), right = Math.min(a.right, b.right);
    const top = Math.max(a.top, b.top), bottom = Math.min(a.bottom, b.bottom);
    if (left >= right || top >= bottom) return false;
    const hit = document.elementFromPoint((left + right) / 2, (top + bottom) / 2);
    return hit === element || !!hit && element.contains(hit);
  })).toBe(true);
}

// A Collection with a form app whose page is the fixture above.
async function createFormApp(electronApp: ElectronApplication, page: Page, workspace: Parameters<typeof writeWorkspaceFiles>[0]) {
  await electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.webContents.send("desktop:menu-command", "new-collection"));
  const collectionDialog = page.getByTestId("new-collection-dialog");
  await shown(collectionDialog);
  await collectionDialog.getByLabel("Collection name").fill("Registrations");
  await collectionDialog.getByLabel("Require Name").check();
  await collectionDialog.getByTestId("new-collection-create").click();
  await hidden(collectionDialog);
  const collection = page.getByRole("region", { name: "Registrations", exact: true });
  await shown(collection);
  const management = collection.getByLabel("Manage Collection", { exact: true });
  if (!await management.evaluate(element => element.closest("details")?.open)) await management.click();
  await collection.getByRole("button", { name: "Create form", exact: true }).click();
  const formDialog = page.getByTestId("create-dataset-form-dialog");
  await shown(formDialog);
  await formDialog.getByRole("button", { name: "Create form", exact: true }).click();
  await hidden(formDialog);
  await writeWorkspaceFiles(workspace, [{ path: `${appRoot}/frontend.js`, contents: frontend }]);
}

test("@app-view approved app guests preserve isolation, links, permissions, overlays, and workbench keys", async ({}, testInfo) => {
  test.setTimeout(180_000);
  const workspace = await createTempWorkspace();
  let desktop: Awaited<ReturnType<typeof launchDesktopApp>> | null = null;
  try {
    desktop = await launchDesktopApp({ workspace });
    const { page, app: electronApp } = desktop;
    await page.emulateMedia({ reducedMotion: "reduce" });
    const { workspaceId } = await openWorkspaceFromFirstRun(page, workspace);
    await page.evaluate(async workspaceId => {
      await window.dohcDesktop!.setWorkspaceSettings({ workspaceId, patch: { privacy: { confirmExternalLinks: false } } });
      const probe = window as RendererProbe;
      probe.__appViewEvents = [];
      probe.__stopAppViewEvents = window.dohcDesktop!.onAppViewEvent(event => probe.__appViewEvents!.push(event));
    }, workspaceId);
    const downloads = join(workspace.baseDir, "blocked-downloads");
    await mkdir(downloads);
    await electronApp.evaluate(({ app, shell, BrowserWindow }, downloads) => {
      const probe = globalThis as MainProbe;
      probe.__appViewProbe = { urls: [], openExternal: shell.openExternal, attaches: [], guestsCreated: 0 };
      shell.openExternal = async url => { probe.__appViewProbe!.urls.push(url); };
      app.setPath("downloads", downloads);
      // Added after dohc's own handlers, so these record what dohc decided.
      BrowserWindow.getAllWindows()[0]!.webContents.on("will-attach-webview", (event, _preferences, params) => {
        probe.__appViewProbe!.attaches.push({ src: params.src, refused: event.defaultPrevented, partition: params.partition });
      });
      app.on("web-contents-created", (_event, contents) => { if (contents.getType() === "webview") probe.__appViewProbe!.guestsCreated++; });
    }, downloads);
    const attaches = () => electronApp.evaluate(() => (globalThis as MainProbe).__appViewProbe!.attaches);
    const guestsCreated = () => electronApp.evaluate(() => (globalThis as MainProbe).__appViewProbe!.guestsCreated);
    const preload = pathToFileURL(join(workspace.baseDir, "injected-preload.js")).href;
    const removeInjected = () => page.evaluate(() => document.querySelectorAll("[data-injected]").forEach(view => view.remove()));

    await createFormApp(electronApp, page, workspace);
    // Only Explorer Home lists apps.
    await openExplorerHome(page);
    const row = page.locator(`[data-testid="sites-row"][data-root="${appRoot}"]`);
    await shown(row);
    await row.click();
    await shown(page.getByTestId("app-view-unapproved"));
    expect(await guestIds(electronApp)).toEqual([]);
    expect(await electronApp.evaluate(({ webContents }) => webContents.getAllWebContents().filter(contents =>
      /^http:\/\/127\.0\.0\.1:\d+\/bootstrap/.test(contents.getURL())).length)).toBe(0);
    // An unapproved app has no address dohc issued, so a guest the page adds itself is refused before Electron creates it.
    const unissued = `http://127.0.0.1:1/bootstrap#${"a".repeat(43)}`;
    await injectGuest(page, unissued, preload);
    await expect.poll(attaches).toContainEqual({ src: unissued, refused: true, partition: "persist:injected" });
    await removeInjected();
    expect(await guestsCreated()).toBe(0);

    await page.getByTestId("app-view-review").click();
    const review = page.getByTestId("app-publication-dialog");
    await shown(review);
    await expect(review.getByTestId("app-publication-approve")).toBeEnabled();
    await review.getByTestId("app-publication-approve").click();
    await hidden(review);
    const appTab = page.getByTestId(editorTabTestId(siteTabPath(appRoot)));
    await appTab.getByRole("button", { name: /^Close / }).click();
    await row.click();
    await ready(page);
    await expect.poll(async () => (await guestIds(electronApp)).length).toBe(1);
    const guestId = (await guestIds(electronApp))[0]!;
    // A throw ends a poll at once, and the app's frame can attach after the guest does.
    await expect.poll(() => inFrame(electronApp, guestId, "document.querySelector('h1')?.textContent").catch(() => null)).toBe("App isolation fixture");
    // The app fills the tab from its top edge, and the page around it doesn't scroll.
    expect(await inFrame(electronApp, guestId,
      "[document.querySelector('iframe').getBoundingClientRect().top, document.documentElement.scrollHeight <= innerHeight]", false)).toEqual([0, true]);
    // The approved app's address admits one guest, in the app's own partition. A second guest at the same address is
    // refused. Only the injected element asks for its own partition, so that refusal isn't dohc's webview attaching
    // again. The page drops the address's fragment once it loads, so the address comes from main's record.
    const admitted = (await attaches()).filter(attach => !attach.refused);
    const { src: issued, partition } = admitted.at(-1)!;
    expect(partition).toMatch(/^dohc-app:[a-f0-9]+$/);
    await expect.poll(() => electronApp.evaluate(({ webContents }, id) => webContents.fromId(id)!.getURL(), guestId)).toBe(issued.split("#")[0]);
    await injectGuest(page, issued, preload);
    await expect.poll(attaches).toContainEqual({ src: issued, refused: true, partition: "persist:injected" });
    await removeInjected();
    // Electron created a guest only for each attach dohc admitted.
    expect(await guestsCreated()).toBe(admitted.length);
    expect(await guestIds(electronApp)).toEqual([guestId]);
    // Electron doesn't report a guest's preload or partition, so the session shows the partition and the globals below
    // show there's no preload.
    const isolation = await electronApp.evaluate(({ webContents, BrowserWindow, session }, { id, partition }) => {
      const guest = webContents.fromId(id)!;
      const owner = BrowserWindow.getAllWindows().find(window => window.webContents === guest.hostWebContents)!.webContents;
      const prefs = (guest as typeof guest & { getLastWebPreferences(): import("electron").WebPreferences }).getLastWebPreferences();
      return { sandbox: prefs.sandbox, contextIsolation: prefs.contextIsolation, nodeIntegration: prefs.nodeIntegration,
        nodeIntegrationInSubFrames: prefs.nodeIntegrationInSubFrames, webviewTag: prefs.webviewTag,
        issuedSession: guest.session === session.fromPartition(partition), distinctSession: guest.session !== owner.session };
    }, { id: guestId, partition });
    expect(isolation).toEqual({ sandbox: true, contextIsolation: true, nodeIntegration: false,
      nodeIntegrationInSubFrames: false, webviewTag: false, issuedSession: true, distinctSession: true });
    for (const child of [false, true]) expect(await inFrame(electronApp, guestId,
      "['dohcDesktop','require','process','ipcRenderer','electron'].map(key => typeof window[key])", child))
      .toEqual(["undefined", "undefined", "undefined", "undefined", "undefined"]);

    const recorded = () => electronApp.evaluate(() => (globalThis as MainProbe).__appViewProbe!.urls);
    const expected: string[] = [];
    for (const [selector, url] of [["#blank", "https://example.com/blank"], ["#plain", "https://example.com/plain"],
      ["#popup", "https://example.com/popup"], ["#mailto", "mailto:app-view@example.com"]]) {
      await pressApp(page, electronApp, guestId, selector!);
      expected.push(url!);
      await expect.poll(recorded).toEqual(expected);
      await expect.poll(() => electronApp.evaluate(({ webContents }, id) => webContents.fromId(id)!.getURL(), guestId)).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/bootstrap$/);
      // The link left through main, and the app's frame still shows the app.
      expect(await inFrame(electronApp, guestId, "document.querySelector('h1')?.textContent")).toBe("App isolation fixture");
    }
    // Without a press, the app can't send anyone out of dohc. #mailto used up the last one.
    await clickApp(electronApp, guestId, "#plain");
    await inFrame(electronApp, guestId, "window.open('https://example.com/unprompted'); true");
    expect(await recorded()).toEqual(expected);
    // An iframe the app adds at an outside address loads nothing and opens nothing. Main records each child frame
    // that commits: an outside page that loaded would show up without an error.
    await electronApp.evaluate(({ webContents }, id) => {
      const guest = webContents.fromId(id)!;
      const frames: Array<{ url: string; error: string | null }> = [];
      guest.on("did-frame-navigate", (_event, url, _code, _status, isMainFrame) => { if (!isMainFrame) frames.push({ url, error: null }); });
      guest.on("did-fail-load", (_event, _code, error, url, isMainFrame) => { if (!isMainFrame) frames.push({ url, error }); });
      (globalThis as FrameProbe).__appViewFrames = frames;
    }, guestId);
    expect(String(await inFrame(electronApp, guestId, `new Promise(resolve => {
      addEventListener('securitypolicyviolation', event => resolve(event.effectiveDirective + ' ' + event.blockedURI), { once: true });
      const frame = document.createElement('iframe'); frame.src = 'https://example.com/framed'; document.body.append(frame);
    })`))).toMatch(/^frame-src https:\/\/example\.com/);
    await expect.poll(() => electronApp.evaluate(() => (globalThis as FrameProbe).__appViewFrames!
      .filter(frame => frame.url.startsWith("https://example.com")))).toEqual([{ url: "https://example.com/framed", error: "ERR_BLOCKED_BY_CSP" }]);
    expect(await recorded()).toEqual(expected);
    for (const selector of ["#javascript", "#file"]) {
      await pressApp(page, electronApp, guestId, selector);
      // A main-process round trip follows the click before checking that nothing opened.
      expect(await recorded()).toEqual(expected);
    }
    expect(await page.evaluate(() => (window as RendererProbe).__appViewEvents!.filter(event => event.kind === "external-link")
      .map(event => event.url))).toEqual(expected);
    await clickApp(electronApp, guestId, "#permission");
    await expect.poll(() => inFrame(electronApp, guestId, "document.getElementById('permission-result').textContent")).toBe("denied");
    await clickApp(electronApp, guestId, "#download");
    await expect.poll(() => page.evaluate(() => (window as RendererProbe).__appViewEvents!.some(event =>
      event.kind === "download-blocked" && event.filename === "app-view-sentinel.txt"))).toBe(true);
    // On Windows, Chromium creates a temporary file before the cancel and deletes it after. The last check below
    // still requires the folder to stay empty.
    await expect.poll(() => readdir(downloads)).toEqual([]);

    for (const theme of ["light", "dark"] as const) {
      await page.evaluate(async ({ theme, workspaceId }) => {
        document.documentElement.dataset.theme = theme;
        await window.dohcDesktop!.appView({ action: "colorScheme", workspaceId, colorScheme: theme });
      }, { theme, workspaceId });
      await expect.poll(() => inFrame(electronApp, guestId, "matchMedia('(prefers-color-scheme: dark)').matches")).toBe(theme === "dark");
      await page.getByTestId("tabs-overflow").last().click();
      const menu = page.getByTestId("tabs-overflow-menu");
      await shown(menu);
      await overlayAboveApp(page, menu);
      await page.screenshot({ path: testInfo.outputPath(`app-menu-${theme}.png`) });
      await menu.locator('[role="menuitem"][aria-current="true"]').click();
      await hidden(menu);
      await ready(page);
      await clickApp(electronApp, guestId, "#counter");
      await expect.poll(() => inFrame(electronApp, guestId, "document.getElementById('count').textContent")).toBe(theme === "light" ? "1" : "3");
      await page.getByTestId("app-view-review").click();
      await shown(review);
      await overlayAboveApp(page, review);
      await page.screenshot({ path: testInfo.outputPath(`app-review-${theme}.png`) });
      await review.getByRole("button", { name: "Close", exact: true }).click();
      await hidden(review);
      await ready(page);
      await clickApp(electronApp, guestId, "#counter");
      await expect.poll(() => inFrame(electronApp, guestId, "document.getElementById('count').textContent")).toBe(theme === "light" ? "2" : "4");
    }
    await inFrame(electronApp, guestId, "document.getElementById('focus').focus(); true");
    await electronApp.evaluate(({ webContents }, id) => {
      const guest = webContents.fromId(id)!;
      guest.focus();
      guest.sendInputEvent({ type: "keyDown", keyCode: "P", modifiers: [process.platform === "darwin" ? "meta" : "control"] });
      guest.sendInputEvent({ type: "keyUp", keyCode: "P", modifiers: [process.platform === "darwin" ? "meta" : "control"] });
    }, guestId);
    await shown(page.getByTestId("quick-open"));
    await page.getByTestId("quick-open").getByRole("textbox").press("Escape");
    await hidden(page.getByTestId("quick-open"));
    // Reload reloads the same guest, so the app starts over in a new frame, which main gives dohc's dark. Until then, a
    // read through main can reach the old frame and wait for its renderer to exit. Playwright's frame fails at once.
    const guestUrl = await electronApp.evaluate(({ webContents }, id) => webContents.fromId(id)!.getURL(), guestId);
    const guest = electronApp.windows().find(window => window.url() === guestUrl)!;
    const appFrame = async (script: string) => guest.mainFrame().childFrames()[0]!.evaluate(script);
    await page.getByTestId("app-view-reload").click();
    await expect.poll(() => appFrame("document.getElementById('count')?.textContent").catch(() => null)).toBe("0");
    await ready(page);
    expect(await guestIds(electronApp)).toEqual([guestId]);
    // Playwright's own session on the new frame sets light, the scheme it emulates, before any read through it runs.
    // Users have no such session, so this sends dohc's scheme again. Only main's session on the new frame can carry it.
    await expect.poll(async () => {
      await page.evaluate(workspaceId => window.dohcDesktop!.appView({ action: "colorScheme", workspaceId, colorScheme: "dark" }), workspaceId);
      return appFrame("matchMedia('(prefers-color-scheme: dark)').matches");
    }).toBe(true);
    await clickApp(electronApp, guestId, "#counter");
    await expect.poll(() => inFrame(electronApp, guestId, "document.getElementById('count').textContent")).toBe("1");
    expect(await inFrame(electronApp, guestId, "matchMedia('(prefers-color-scheme: dark)').matches")).toBe(true);
    expect(await readdir(downloads)).toEqual([]);
  } finally {
    if (desktop) {
      await desktop.page.evaluate(() => (window as RendererProbe).__stopAppViewEvents?.()).catch(() => {});
      await desktop.app.evaluate(({ shell }) => {
        const probe = (globalThis as MainProbe).__appViewProbe;
        if (probe) shell.openExternal = probe.openExternal;
        delete (globalThis as MainProbe).__appViewProbe;
      }).catch(() => {});
    }
    await cleanupDesktopWorkspace(desktop, workspace);
  }
});

test("@app-view an app keeps its page when its tab moves to another editor group, and takes focus from its tab", async () => {
  test.setTimeout(180_000);
  const workspace = await createTempWorkspace();
  let desktop: Awaited<ReturnType<typeof launchDesktopApp>> | null = null;
  try {
    await writeWorkspaceFiles(workspace, [{ path: "notes.md", contents: "# Notes\n" }]);
    desktop = await launchDesktopApp({ workspace });
    const { page, app: electronApp } = desktop;
    await page.emulateMedia({ reducedMotion: "reduce" });
    await openWorkspaceFromFirstRun(page, workspace);
    await createFormApp(electronApp, page, workspace);
    await openExplorerHome(page);
    const row = page.locator(`[data-testid="sites-row"][data-root="${appRoot}"]`);
    await shown(row);
    await row.click();
    await page.getByTestId("app-view-review").click();
    const review = page.getByTestId("app-publication-dialog");
    await shown(review);
    await expect(review.getByTestId("app-publication-approve")).toBeEnabled();
    await review.getByTestId("app-publication-approve").click();
    await hidden(review);
    await ready(page);
    await expect.poll(async () => (await guestIds(electronApp)).length).toBe(1);
    const guestId = (await guestIds(electronApp))[0]!;
    await expect.poll(() => inFrame(electronApp, guestId, "document.querySelector('h1')?.textContent")).toBe("App isolation fixture");

    // What the person typed, a count, and a value only this load of the page holds. A reload resets all three, and
    // keeps the guest's ID.
    const typed = "lisbon";
    await pressApp(page, electronApp, guestId, "#focus");
    await expect.poll(() => inFrame(electronApp, guestId, "document.activeElement?.id")).toBe("focus");
    // Keys go through the window, as a keyboard's do. The app runs in a child frame with its own process, and the
    // guest's sendInputEvent reaches only the guest's top frame.
    await page.keyboard.type(typed);
    await expect.poll(() => inFrame(electronApp, guestId, "document.getElementById('focus').value")).toBe(typed);
    await clickApp(electronApp, guestId, "#counter");
    await clickApp(electronApp, guestId, "#counter");
    await expect.poll(() => inFrame(electronApp, guestId, "document.getElementById('count').textContent")).toBe("2");
    const load = await inFrame(electronApp, guestId, "window.pageLoad = String(Math.random())");

    // A note beside the app gives the layout a second group. An app tab can't be split into one.
    await showExplorerFiles(page);
    await explorerRow(page, "notes.md").click();
    await expect(page.getByTestId("view-markdown")).toBeVisible();
    await page.getByTestId("create-editor-group-right").click();
    const leftGroup = page.getByRole("region", { name: "Editor group 1" });
    const rightGroup = page.getByRole("region", { name: "Editor group 2" });
    await expect(rightGroup.getByTestId(editorTabTestId("notes.md"))).toBeVisible();
    const appTab = editorTabTestId(siteTabPath(appRoot));
    // A press near the tab's start, which the tab-row actions never cover.
    await leftGroup.getByTestId(appTab).click({ position: { x: 16, y: 16 } });
    await ready(page);

    // Tab follows the screen with the app beside the note. Keys pressed in the app reach only the app.
    const appControls = "[...document.querySelectorAll('a[href], button:not([disabled]), input:not([disabled])')]";
    const divider = page.getByRole("separator", { name: "Resize editor groups" });
    // Shift+Tab out of the app's first control reaches its page's toolbar.
    await pressApp(page, electronApp, guestId, "#focus");
    await inFrame(electronApp, guestId, `${appControls}[0].focus(); true`);
    await page.keyboard.press("Shift+Tab");
    await expect.poll(() => page.evaluate(() => {
      const focused = document.activeElement;
      return !!focused?.closest("[data-app-group-id]") && focused.localName !== "webview" && !focused.matches("[data-app-stop]");
    })).toBe(true);
    // Shift+Tab from the divider after the app's group goes in at the app's last control, not where it last was.
    await divider.focus();
    await page.keyboard.press("Shift+Tab");
    await expect.poll(() => inFrame(electronApp, guestId, `document.activeElement === ${appControls}.at(-1)`)).toBe(true);
    // Tab out of the app's last control reaches the divider.
    await page.keyboard.press("Tab");
    await expect(divider).toBeFocused();

    // With the note's group active, Tab from the sidebar reaches each control of the app's group in order. Focus on
    // one makes that group active, and the app leaves focus there.
    const webview = page.getByTestId("app-view-webview");
    const noteGroupActive = async () => {
      await rightGroup.getByTestId(editorTabTestId("notes.md")).click({ position: { x: 16, y: 16 } });
      await expect(rightGroup).toHaveAttribute("data-active");
    };
    const sidebarEnd = page.getByTestId("sidebar-resize");
    const allTabs = leftGroup.getByRole("button", { name: "All tabs in editor group 1", exact: true });
    await noteGroupActive();
    await sidebarEnd.focus();
    for (const control of [
      leftGroup.getByTestId(appTab),
      allTabs,
      page.getByTestId("app-view-reload"),
      page.getByTestId("site-preview-show-source"),
      page.getByTestId("site-preview-share"),
      page.getByTestId("app-view-review"),
      page.getByTestId("app-view-open-browser"),
    ]) {
      await page.keyboard.press("Tab");
      await expect(control).toBeFocused();
    }
    await expect(leftGroup).toHaveAttribute("data-active");
    // Enter on the app's tab puts focus in the app, and so does a click on it.
    await noteGroupActive();
    await sidebarEnd.focus();
    await page.keyboard.press("Tab");
    await expect(leftGroup.getByTestId(appTab)).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(webview).toBeFocused();
    await noteGroupActive();
    await leftGroup.getByTestId(appTab).click({ position: { x: 16, y: 16 } });
    await expect(webview).toBeFocused();
    // A click on All tabs in the app's group opens its menu, and the menu keeps focus.
    await noteGroupActive();
    await allTabs.click();
    const allTabsMenu = page.getByTestId("tabs-overflow-menu");
    await expect(allTabsMenu).toBeVisible();
    await expect.poll(() => allTabsMenu.evaluate(menu => menu.contains(document.activeElement))).toBe(true);
    await page.keyboard.press("Escape");
    await expect(allTabsMenu).toBeHidden();

    await dragTabTo(page, leftGroup.getByTestId(appTab), rightGroup);

    await expect(rightGroup.getByTestId(appTab)).toBeVisible();
    await expect(leftGroup.getByTestId(appTab)).toHaveCount(0);
    await ready(page);
    // The page now lies over the group it moved to.
    await expect.poll(async () => {
      const [view, group] = [await page.getByTestId("app-view-webview").boundingBox(), await rightGroup.boundingBox()];
      return !!view && !!group && view.x >= group.x - 1 && view.x + view.width <= group.x + group.width + 1;
    }).toBe(true);
    // The drop releases a press on the app's tab, so focus is in the app.
    await expect(webview).toBeFocused();
    expect(await guestIds(electronApp)).toEqual([guestId]);
    expect(await inFrame(electronApp, guestId, "window.pageLoad")).toBe(load);
    expect(await inFrame(electronApp, guestId, "document.getElementById('focus').value")).toBe(typed);
    expect(await inFrame(electronApp, guestId, "document.getElementById('count').textContent")).toBe("2");

    // Closing the note's group, which held focus, puts focus in the app.
    await leftGroup.getByTestId(editorTabTestId("notes.md")).click({ position: { x: 16, y: 16 } });
    await expect(leftGroup).toHaveAttribute("data-active");
    await allTabs.click();
    await allTabsMenu.getByRole("menuitem", { name: "Close group", exact: true }).click();
    await expect(page.getByRole("region", { name: /^Editor group \d+$/ })).toHaveCount(1);
    await expect(webview).toBeFocused();
  } finally {
    await cleanupDesktopWorkspace(desktop, workspace);
  }
});
