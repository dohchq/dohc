import { expect, test, type ElectronApplication, type Page } from "@playwright/test";
import { CHANNELS } from "../src/ipc/channels";
import { launchDesktopApp } from "./helpers/desktopApp";
import { cleanupDesktopWorkspace, createTempWorkspace, openWorkspaceFromFirstRun, waitForWorkspaceReady } from "./helpers/workspace";

type InvokeHandler = (event: { sender: { id: number } }, ...args: unknown[]) => unknown;
type MainTestState = { releaseRegistryReads?: () => void; focusedWindows?: number[] };

async function contentsId(app: ElectronApplication, page: Page): Promise<number> {
  const window = await app.browserWindow(page);
  try {
    return await window.evaluate((window) => window.webContents.id);
  } finally {
    await window.dispose();
  }
}

// Holds every workspace list read one window sends until the test releases
// them. Forget and Open folder then both land before that window reads the
// list, as they do when the folder opens again within the activity debounce.
async function holdRegistryReads(app: ElectronApplication, contents: number): Promise<void> {
  await app.evaluate(({ ipcMain }, input) => {
    const handlers = (ipcMain as unknown as { _invokeHandlers: Map<string, InvokeHandler> })._invokeHandlers;
    const original = handlers.get(input.channel);
    if (!original) throw new Error(`main has no handler for ${input.channel}`);
    let release!: () => void;
    const released = new Promise<void>((resolve) => { release = resolve; });
    (globalThis as unknown as MainTestState).releaseRegistryReads = () => {
      handlers.set(input.channel, original);
      release();
    };
    handlers.set(input.channel, async (event, ...args) => {
      if (event.sender.id === input.contents) await released;
      return await original(event, ...args);
    });
  }, { channel: CHANNELS.getWorkspaceRegistry, contents });
}

test("a window Forget left showing its workspace stops and follows the window that shows it now", async () => {
  test.setTimeout(180_000);
  const temp = await createTempWorkspace();
  let desktop: Awaited<ReturnType<typeof launchDesktopApp>> | null = null;
  try {
    desktop = await launchDesktopApp({ workspace: temp });
    const { app, page: old } = desktop;
    const { workspaceId } = await openWorkspaceFromFirstRun(old, temp);
    const oldContents = await contentsId(app, old);
    await holdRegistryReads(app, oldContents);

    await old.getByTestId("workspace-switcher").click();
    const managerOpened = app.waitForEvent("window");
    await old.getByTestId("workspace-switcher-manage").click();
    const manager = await managerOpened;
    // Forget, then Open folder on the same folder, which keeps its id.
    expect(await manager.evaluate(async (input) => {
      const bridge = window.dohcDesktop!;
      await bridge.forgetWorkspace({ workspaceId: input.workspaceId });
      return (await bridge.attachWorkspaceFolder({ rootPath: input.rootPath })).workspaceId;
    }, { workspaceId, rootPath: temp.rootPath })).toBe(workspaceId);
    const reopenedOpened = app.waitForEvent("window");
    await old.evaluate((id) => window.dohcDesktop!.openWorkspaceWindow({ workspaceId: id }), workspaceId);
    const reopened = await reopenedOpened;
    await waitForWorkspaceReady(reopened);
    await app.evaluate(() => (globalThis as unknown as MainTestState).releaseRegistryReads!());

    const state = old.getByTestId("workspace-old-window");
    const heading = state.getByRole("heading");
    await expect(heading).toHaveText("This workspace is open in another window.", { timeout: 30_000 });
    await expect(state.getByRole("button")).toHaveCount(1);
    const go = state.getByRole("button", { name: "Go to that window", exact: true });
    await expect(go).toBeFocused();

    // The workbench takes no focus, from the keyboard or a focus call, and
    // Chromium leaves it out of the accessibility tree.
    const workbench = old.getByTestId("workspace-workbench");
    await expect(workbench).toHaveAttribute("inert", "");
    for (let step = 0; step < 8; step += 1) {
      await old.keyboard.press("Tab");
      expect(await workbench.evaluate((element) => element.contains(document.activeElement))).toBe(false);
    }
    expect(await workbench.evaluate((element) => {
      const control = element.querySelector<HTMLElement>("button");
      control?.focus();
      return control !== null && document.activeElement !== control;
    })).toBe(true);
    const cdp = await old.context().newCDPSession(old);
    try {
      await cdp.send("Accessibility.enable");
      const { root } = await cdp.send("DOM.getDocument", { depth: 0 });
      const { nodeId } = await cdp.send("DOM.querySelector", { nodeId: root.nodeId, selector: '[data-testid="workspace-workbench"] button' });
      const { nodes } = await cdp.send("Accessibility.getPartialAXTree", { nodeId, fetchRelatives: false });
      expect(nodes[0]?.ignored).toBe(true);
    } finally {
      await cdp.detach();
    }

    // Go to that window brings the other window to the front, opens none, and
    // leaves this one as it is.
    const reopenedContents = await contentsId(app, reopened);
    await app.evaluate(({ BrowserWindow }) => {
      const main = globalThis as unknown as MainTestState;
      main.focusedWindows = [];
      const focus = BrowserWindow.prototype.focus;
      BrowserWindow.prototype.focus = function (this: InstanceType<typeof BrowserWindow>) {
        main.focusedWindows!.push(this.webContents.id);
        return focus.call(this);
      };
    });
    const windowCount = () => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().filter((window) => !window.isDestroyed()).length);
    const windowsBefore = await windowCount();
    await go.click();
    await expect.poll(() => app.evaluate(() => (globalThis as unknown as MainTestState).focusedWindows)).toContain(reopenedContents);
    expect(await app.evaluate(() => (globalThis as unknown as MainTestState).focusedWindows)).not.toContain(oldContents);
    expect(await windowCount()).toBe(windowsBefore);
    await expect(heading).toHaveText("This workspace is open in another window.");

    // The other window closes.
    const reopenedClosed = reopened.waitForEvent("close");
    await app.evaluate(({ BrowserWindow, webContents }, id) => {
      const contents = webContents.fromId(id);
      const window = contents && BrowserWindow.fromWebContents(contents);
      if (!window) throw new Error("The reopened window is gone.");
      window.close();
    }, reopenedContents);
    await reopenedClosed;
    await expect(heading).toHaveText("This window can't edit this workspace anymore.", { timeout: 30_000 });
    await expect(state.getByRole("button")).toHaveCount(1);
    await expect(state.getByRole("button", { name: "Close this window", exact: true })).toBeFocused();
    await expect(workbench).toHaveAttribute("inert", "");

    // The workspace opens in another window again.
    const againOpened = app.waitForEvent("window");
    await old.evaluate((id) => window.dohcDesktop!.openWorkspaceWindow({ workspaceId: id }), workspaceId);
    await waitForWorkspaceReady(await againOpened);
    await expect(heading).toHaveText("This workspace is open in another window.", { timeout: 30_000 });
    await expect(go).toBeFocused();
  } finally {
    await cleanupDesktopWorkspace(desktop, temp);
  }
});
