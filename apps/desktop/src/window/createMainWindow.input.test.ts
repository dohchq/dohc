import { EventEmitter } from "node:events";
import { BrowserWindow } from "electron";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const electronApp = vi.hoisted(() => ({ isPackaged: false }));

vi.mock("electron", () => ({
  app: electronApp,
  BrowserWindow: vi.fn(),
  nativeTheme: { shouldUseDarkColors: false },
  screen: { getAllDisplays: () => [] },
}));
vi.mock("../workspaces/WorkspaceRegistry", () => ({ stateDir: () => "/state" }));

import { createMainWindow, resetChromeThemeForTests } from "./createMainWindow";

class TestWindow extends EventEmitter {
  webContents = Object.assign(new EventEmitter(), { setWindowOpenHandler: vi.fn() });
  setIgnoreMouseEvents = vi.fn();
  show = vi.fn();
  loadFile = vi.fn();
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("ELECTRON_RENDERER_URL", "");
  resetChromeThemeForTests({ read: () => null, write: () => undefined });
  vi.mocked(BrowserWindow).mockImplementation(function () {
    return new TestWindow() as unknown as BrowserWindow;
  });
});
afterEach(() => {
  vi.unstubAllEnvs();
  electronApp.isPackaged = false;
  resetChromeThemeForTests();
});

describe("main-window OS mouse input", () => {
  it.each(["workspace", "manager"] as const)("enables webview tags only for a workspace window: %s", role => {
    createMainWindow({ role });
    expect(vi.mocked(BrowserWindow).mock.calls.at(-1)?.[0]?.webPreferences?.webviewTag).toBe(role === "workspace");
  });
  it.each(["workspace", "manager"] as const)("ignores OS mouse events before showing an e2e %s window", (role) => {
    vi.stubEnv("DOHC_DESKTOP_TEST", "1");
    vi.stubEnv("DOHC_TEST_IGNORE_MOUSE", "1");
    const window = createMainWindow({ role });
    expect(window.setIgnoreMouseEvents).toHaveBeenCalledExactlyOnceWith(true);
    expect(window.show).not.toHaveBeenCalled();
    window.emit("ready-to-show");
    expect(window.show).toHaveBeenCalledOnce();
  });

  it.each([
    { name: "normal development", packaged: false, test: "", ignore: "1" },
    { name: "interactive test-mode debugging", packaged: false, test: "1", ignore: "" },
    { name: "production", packaged: true, test: "", ignore: "" },
    { name: "production with test environment variables", packaged: true, test: "1", ignore: "1" },
  ])("keeps OS mouse input in $name", ({ packaged, test, ignore }) => {
    electronApp.isPackaged = packaged;
    vi.stubEnv("DOHC_DESKTOP_TEST", test);
    vi.stubEnv("DOHC_TEST_IGNORE_MOUSE", ignore);
    const window = createMainWindow();
    expect(window.setIgnoreMouseEvents).not.toHaveBeenCalled();
    window.emit("ready-to-show");
    expect(window.show).toHaveBeenCalledOnce();
  });
});
