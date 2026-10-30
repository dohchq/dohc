import { expect, test, type ElectronApplication, type Locator, type Page } from "@playwright/test";
import { mkdir, readdir } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { activityPin, editorTabTestId } from "../src/testPins";
import { siteTabPath } from "../src/renderer/workbench/workbenchState";
import { launchDesktopApp } from "./helpers/desktopApp";
import { cleanupDesktopWorkspace, createTempWorkspace, openWorkspaceFromFirstRun, writeWorkspaceFiles } from "./helpers/workspace";
import type { AppViewEvent } from "../src/ipc/bridgeContract";

type MainProbe = typeof globalThis & { __appViewProbe?: {
  urls: string[];
  openExternal: typeof import("electron").shell.openExternal;
  attaches: Array<{ src: string; refused: boolean; partition: string }>;
  guestsCreated: number;
} };
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
async function shown(locator: Locator) { await expect.poll(() => locator.isVisible()).toBe(true); }
async function hidden(locator: Locator) { await expect.poll(() => locator.isVisible()).toBe(false); }

async function overlayAboveApp(page: Page, overlay: Locator) {
  await expect.poll(() => overlay.evaluate(element => {
    const app = document.querySelector('[data-testid="app-view-webview"]');
    if (!app) return false;
    const a = app.getBoundingClientRect(), b = element.getBoundingClientRect();
    const x = (b.left + b.right) / 2, y = (b.top + b.bottom) / 2;
    if (x <= a.left || x >= a.right || y <= a.top || y >= a.bottom) return false;
    const top = document.elementFromPoint(x, y);
    return top === element || !!top && element.contains(top);
  })).toBe(true);
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
    const explorer = page.getByTestId(activityPin("explorer"));
    if (await explorer.getAttribute("aria-pressed") === "false") await explorer.click();
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
    await review.getByRole("button", { name: "Prepare for this device", exact: true }).click();
    await shown(review.getByTestId("app-publication-approve"));
    await review.getByTestId("app-publication-approve").click();
    await shown(review.getByRole("button", { name: /^Open in browser / }));
    await review.getByRole("button", { name: "Close publication" }).click();
    await hidden(review);
    const appTab = page.getByTestId(editorTabTestId(siteTabPath(appRoot)));
    await appTab.getByRole("button", { name: /^Close / }).click();
    await row.click();
    await ready(page);
    await expect.poll(async () => (await guestIds(electronApp)).length).toBe(1);
    const guestId = (await guestIds(electronApp))[0]!;
    await expect.poll(() => inFrame(electronApp, guestId, "document.querySelector('h1')?.textContent")).toBe("App isolation fixture");
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
    }
    // Without a press, the app can't send anyone out of dohc. #mailto used up the last one.
    await clickApp(electronApp, guestId, "#plain");
    await inFrame(electronApp, guestId, "window.open('https://example.com/unprompted'); true");
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
    expect(await readdir(downloads)).toEqual([]);

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
      await review.getByRole("button", { name: "Close publication" }).click();
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
    // Reload reloads the same guest, so the app starts over.
    await page.getByTestId("app-view-reload").click();
    await expect.poll(() => inFrame(electronApp, guestId, "document.getElementById('count')?.textContent").catch(() => null)).toBe("0");
    await ready(page);
    expect(await guestIds(electronApp)).toEqual([guestId]);
    await clickApp(electronApp, guestId, "#counter");
    await expect.poll(() => inFrame(electronApp, guestId, "document.getElementById('count').textContent")).toBe("1");
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
